//! IBM Db2 for Linux, UNIX and Windows (prompt 035l) over `justybase-db2`: DRDA spoken in pure Rust, no
//! client of IBM's. **Written from the driver's source and Db2's documentation and never run against a
//! server** – the official image needs a privileged container, which nobody allowed here.
//!
//! What holds:
//! - Every statement is a unit of work of its own: the driver commits behind it (`auto_commit`). There is
//!   no transaction a tab could hold open, so nothing here edits rows (`DbKind::edits_rows`).
//! - A value travels bound. The driver would cut `1.5` down to fit an INTEGER; [`fits`] refuses that
//!   before anything is sent.
//! - A statement is stopped from a second connection (`SQLINTR`). A result that is left before its end
//!   costs the connection: DRDA lets the driver only read on, and it cannot close a cursor early.

use super::secrets::Secret;
use super::value::{Cell, ColKind, Column, Outcome, RowSink, text};
use super::{Bind, Ended, Limits, Profile, Session, Stop, TlsMode, TxState, clean};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use justybase_db2::network::ddm::ColumnDescription;
use justybase_db2::{
    Config, Db2CommandOptions, Db2Error, Db2ErrorKind, Db2LobEncoding, Db2RowReader, Db2Session,
    Db2Value,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_SQL_LEN: usize = 2 * 1024 * 1024;
/// A large object is read up to here; beyond, the cell says so.
const MAX_LOB: u64 = 64 * 1024 * 1024;
/// How long the rest of a result nobody wants is read before the connection is given up instead.
const DRAIN: Duration = Duration::from_secs(3);

// the types of DRDA, without the bit that says „may be NULL“
const DATE: u16 = 384;
const TIME: u16 = 388;
const TIMESTAMP: u16 = 392;
const BLOB: u16 = 404;
const CLOB: u16 = 408;
const DBCLOB: u16 = 412;
const VARCHAR: u16 = 448;
const CHAR: u16 = 452;
const LONG_VARCHAR: u16 = 456;
const VARGRAPHIC: u16 = 464;
const GRAPHIC: u16 = 468;
const LONG_VARGRAPHIC: u16 = 472;
const FLOAT: u16 = 480;
const DECIMAL: u16 = 484;
const ZONED: u16 = 488;
const BIGINT: u16 = 492;
const INTEGER: u16 = 496;
const SMALLINT: u16 = 500;
const NUMERIC: u16 = 504;
const ROWID: u16 = 904;
const VARBINARY: u16 = 908;
const BINARY: u16 = 912;
const BLOB_LOCATOR: u16 = 960;
const CLOB_LOCATOR: u16 = 964;
const DBCLOB_LOCATOR: u16 = 968;
const XML: u16 = 988;
const DECFLOAT: u16 = 996;
const BOOLEAN: u16 = 2436;

pub struct Db2 {
    session: Db2Session,
    version: String,
    on: String,
    tunnel: Option<Arc<crate::ssh::Tunnel>>,
    /// The connection was left in the middle of an exchange: nothing more is asked of it.
    broken: bool,
}

/// What Db2 said, in our words. A message of the server names objects and tokens, never a value.
fn failed(e: &Db2Error, on: &str) -> AppError {
    let said = clean(&e.message);
    let lower = said.to_lowercase();
    let code = match e.kind {
        Db2ErrorKind::AuthenticationFailed => ErrorCode::AuthFailed,
        Db2ErrorKind::AuthorizationFailed => ErrorCode::PermissionDenied,
        Db2ErrorKind::DatabaseNotFound => ErrorCode::NotFound,
        Db2ErrorKind::InvalidConfiguration => ErrorCode::InvalidProfile,
        Db2ErrorKind::Unsupported => ErrorCode::Unsupported,
        Db2ErrorKind::Transport | Db2ErrorKind::ConnectionClosed => ErrorCode::ConnectionFailed,
        _ if lower.contains("tls handshake") || lower.contains("certificate") => {
            ErrorCode::TlsFailed
        }
        _ => match e.sql_code {
            // SQL0952N: the statement was interrupted
            Some(-952) => ErrorCode::Cancelled,
            // SQL30082N: the login was refused; SQL1403N the same, said by older servers
            Some(-30082 | -1403) => ErrorCode::AuthFailed,
            // SQL0551N, SQL0552N: no privilege; SQL1060N: no CONNECT
            Some(-551 | -552 | -1060) => ErrorCode::PermissionDenied,
            // SQL1013N, SQL30061N: no such database
            Some(-1013 | -30061) => ErrorCode::NotFound,
            Some(_) => ErrorCode::InvalidQuery,
            None => ErrorCode::ConnectionFailed,
        },
    };
    match code {
        ErrorCode::AuthFailed => AppError::new(code, "login failed"),
        ErrorCode::ConnectionFailed => {
            AppError::new(code, format!("no connection to {on}: {said}"))
        }
        ErrorCode::Cancelled => super::cancelled(),
        _ => AppError::new(code, said).with(ErrorDetails {
            sqlstate: e.sql_state.clone(),
            ..ErrorDetails::default()
        }),
    }
}

/// After these the byte stream is not where the next request expects it.
fn breaks(e: &Db2Error) -> bool {
    matches!(
        e.kind,
        Db2ErrorKind::Transport
            | Db2ErrorKind::ConnectionClosed
            | Db2ErrorKind::Protocol
            | Db2ErrorKind::ServerResponse
            | Db2ErrorKind::ResourceLimit
    )
}

fn config(profile: &Profile, secret: Option<&Secret>) -> AppResult<Config> {
    let database = profile.database.trim();
    if database.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "Db2 needs the database: its name or alias on the server",
        ));
    }
    if profile.user.trim().is_empty() {
        return Err(AppError::new(ErrorCode::InvalidProfile, "Db2 needs a user"));
    }
    // the driver checks a certificate and its name, always: there is no encryption without the check
    let tls = match profile.tls {
        TlsMode::Off => false,
        TlsMode::Verify => true,
        TlsMode::Prefer | TlsMode::Require | TlsMode::VerifyCa => {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                "Db2: TLS is either checked in full („verify“) or off – choose one of the two",
            ));
        }
    };
    let cert = profile.client_cert.trim();
    let key = profile.client_key.trim();
    if cert.is_empty() != key.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "a client certificate needs its key, and the key its certificate",
        ));
    }
    if !tls && (!cert.is_empty() || !profile.ca_file.trim().is_empty()) {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "certificates are used with TLS only: switch it on („verify“)",
        ));
    }
    Ok(Config {
        host: profile.host.trim().to_owned(),
        port: profile.port_or_default(),
        database: database.to_owned(),
        user: profile.user.trim().to_owned(),
        password: secret.map(Secret::expose).unwrap_or_default().to_owned(),
        use_ssl: tls,
        ssl_root_ca_path: profile.ca_file.trim().to_owned(),
        ssl_client_cert_path: cert.to_owned(),
        ssl_client_key_path: key.to_owned(),
        timeout_ms: i64::try_from(super::CONNECT_TIMEOUT.as_millis()).unwrap_or(20_000),
        client_appl_name: "Schema Commander".to_owned(),
        ..Config::default()
    })
}

pub fn connect(profile: &Profile, secret: Option<&Secret>, stop: Stop) -> AppResult<Db2> {
    super::install_crypto();
    let config = config(profile, secret)?;
    let on = profile.where_label();
    let session = super::block(Some(super::CONNECT_TIMEOUT), stop, async {
        Db2Session::connect(config)
            .await
            .map_err(|e| failed(&e, &on))
    })?;
    let mut db = Db2 {
        session,
        version: String::new(),
        on,
        tunnel: None,
        broken: false,
    };
    let rows = db.ask(
        "SELECT service_level FROM sysibmadm.env_inst_info",
        &[],
        Some(super::CONNECT_TIMEOUT),
        stop,
    );
    // the view is not everybody's to read: without it the product has a name and no number
    if let Ok(rows) = rows {
        db.version = rows
            .into_iter()
            .next()
            .and_then(|r| r.into_iter().next().flatten())
            .unwrap_or_default();
    } else if db.broken {
        return Err(super::closed());
    }
    Ok(db)
}

fn base(sql_type: u16) -> u16 {
    sql_type & !1
}

fn kind_of(c: &ColumnDescription) -> ColKind {
    match base(c.sql_type) {
        SMALLINT | INTEGER | BIGINT => ColKind::Int,
        FLOAT => ColKind::Float,
        DECIMAL | NUMERIC | ZONED | DECFLOAT => ColKind::Decimal,
        BOOLEAN => ColKind::Bool,
        DATE => ColKind::Date,
        TIME => ColKind::Time,
        TIMESTAMP => ColKind::Timestamp,
        BLOB | BLOB_LOCATOR | VARBINARY | BINARY | ROWID => ColKind::Bytes,
        CLOB | DBCLOB | CLOB_LOCATOR | DBCLOB_LOCATOR | VARCHAR | CHAR | LONG_VARCHAR
        | VARGRAPHIC | GRAPHIC | LONG_VARGRAPHIC | XML => ColKind::Text,
        _ => ColKind::Other,
    }
}

/// The type as one would write it, from what the server describes of a column.
fn type_name(c: &ColumnDescription) -> String {
    match base(c.sql_type) {
        SMALLINT => "SMALLINT".into(),
        INTEGER => "INTEGER".into(),
        BIGINT => "BIGINT".into(),
        FLOAT if c.length == 4 => "REAL".into(),
        FLOAT => "DOUBLE".into(),
        DECIMAL | NUMERIC | ZONED => format!("DECIMAL({}, {})", c.precision, c.scale),
        DECFLOAT if c.length == 8 => "DECFLOAT(16)".into(),
        DECFLOAT => "DECFLOAT(34)".into(),
        BOOLEAN => "BOOLEAN".into(),
        DATE => "DATE".into(),
        TIME => "TIME".into(),
        TIMESTAMP if c.scale == 6 || c.scale == 0 && c.length != 19 => "TIMESTAMP".into(),
        TIMESTAMP => format!("TIMESTAMP({})", c.scale),
        BLOB | BLOB_LOCATOR => "BLOB".into(),
        CLOB | CLOB_LOCATOR => "CLOB".into(),
        DBCLOB | DBCLOB_LOCATOR => "DBCLOB".into(),
        VARCHAR => format!("VARCHAR({})", c.length),
        CHAR => format!("CHAR({})", c.length),
        LONG_VARCHAR => "LONG VARCHAR".into(),
        VARGRAPHIC => format!("VARGRAPHIC({})", c.length),
        GRAPHIC => format!("GRAPHIC({})", c.length),
        LONG_VARGRAPHIC => "LONG VARGRAPHIC".into(),
        VARBINARY => format!("VARBINARY({})", c.length),
        BINARY => format!("BINARY({})", c.length),
        ROWID => "ROWID".into(),
        XML => "XML".into(),
        _ => String::new(),
    }
}

fn column(c: &ColumnDescription) -> Column {
    Column {
        name: c.name.clone(),
        kind: kind_of(c),
        type_name: type_name(c),
    }
}

/// Date and time as Db2 writes them: ISO, or its own form with dots and a dash before the hour.
fn date_time(kind: ColKind, s: &str) -> Option<Cell> {
    let s = s.trim();
    match kind {
        ColKind::Date => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .ok()
            .map(Cell::Date),
        ColKind::Time => ["%H:%M:%S%.f", "%H.%M.%S%.f"]
            .iter()
            .find_map(|f| NaiveTime::parse_from_str(s, f).ok())
            .map(Cell::Time),
        ColKind::Timestamp => [
            "%Y-%m-%d %H:%M:%S%.f",
            "%Y-%m-%d-%H.%M.%S%.f",
            "%Y-%m-%dT%H:%M:%S%.f",
        ]
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(s, f).ok())
        .map(Cell::Ts),
        _ => None,
    }
}

/// A value of a row as a cell. What the driver read decides, the type of the column only how a text is
/// meant: nothing is rounded, a number beyond an `i64` stays its text.
fn cell(v: Db2Value, kind: ColKind) -> Cell {
    match v {
        Db2Value::Null => Cell::Null,
        Db2Value::Boolean(b) => Cell::Bool(b),
        Db2Value::Integer(i) => Cell::I64(i),
        Db2Value::Float(f) => Cell::F64(f),
        Db2Value::Decimal(s) => Cell::Decimal(s),
        Db2Value::Bytes(b) => Cell::bytes(&b),
        Db2Value::Text(s) => match kind {
            ColKind::Date | ColKind::Time | ColKind::Timestamp => {
                date_time(kind, &s).unwrap_or_else(|| Cell::Text(text(&s)))
            }
            ColKind::Decimal => Cell::Decimal(s),
            ColKind::Int => s.trim().parse().map_or(Cell::Decimal(s), Cell::I64),
            _ => Cell::Text(text(&s)),
        },
        // a locator is read while its row is the current one: see `Db2::lob`
        _ => Cell::Unreadable("LOB".into()),
    }
}

fn not_a(what: &str, value: &str) -> AppError {
    let shown: String = value.chars().take(40).collect();
    AppError::new(
        ErrorCode::InvalidQuery,
        format!("„{}“ is not {what}", clean(&shown)),
    )
}

fn whole_number(s: &str) -> bool {
    let digits = s.strip_prefix(['-', '+']).unwrap_or(s);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// The digits of a plain decimal number behind its point; `None`: it is none.
fn fraction_digits(s: &str) -> Option<usize> {
    let digits = s.strip_prefix(['-', '+']).unwrap_or(s);
    let (int, frac) = digits.split_once('.').unwrap_or((digits, ""));
    let ok = (!int.is_empty() || !frac.is_empty())
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.bytes().all(|b| b.is_ascii_digit());
    ok.then(|| frac.trim_end_matches('0').len())
}

/// Whether a value is what its place in the statement takes **as it is**. The driver converts a text to
/// the type of the place and drops what does not fit (`1.5` → `1`); here that is an error instead.
fn fits(value: &Db2Value, place: &ColumnDescription) -> AppResult<()> {
    let s = match value {
        Db2Value::Text(s) | Db2Value::Decimal(s) => s.trim(),
        _ => return Ok(()),
    };
    match base(place.sql_type) {
        SMALLINT | INTEGER | BIGINT if !whole_number(s) => Err(not_a("a whole number", s)),
        DECIMAL | NUMERIC | ZONED => match fraction_digits(s) {
            None => Err(not_a("a number", s)),
            Some(digits) if digits > usize::from(place.scale) => Err(AppError::new(
                ErrorCode::InvalidQuery,
                format!(
                    "„{}“ has more digits behind the point than its place keeps ({})",
                    clean(s),
                    place.scale
                ),
            )),
            Some(_) => Ok(()),
        },
        BOOLEAN
            if !matches!(
                s.to_ascii_lowercase().as_str(),
                "true" | "false" | "0" | "1"
            ) =>
        {
            Err(not_a("true or false", s))
        }
        _ => Ok(()),
    }
}

fn bound(bind: &Bind) -> Db2Value {
    match bind {
        Bind::Text(v) | Bind::Date(v) | Bind::Datetime(v) => Db2Value::Text(v.clone()),
        // beyond an i64 the digits travel as they are
        Bind::Int(v) => v.trim().parse().map_or_else(
            |_| Db2Value::Decimal(v.trim().to_owned()),
            Db2Value::Integer,
        ),
        Bind::Decimal(v) => Db2Value::Decimal(v.trim().to_owned()),
        Bind::Bool(b) => Db2Value::Boolean(*b),
    }
}

/// The first word of a statement, in upper case, behind comments and opening brackets.
fn first_word(sql: &str) -> String {
    let mut rest = sql.trim_start_matches('\u{feff}').trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix('(') {
            rest = after.trim_start();
        } else {
            break;
        }
    }
    rest.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// What a statement gives, as far as its first word says it.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Shape {
    /// A cursor: `SELECT`, `WITH`, `VALUES`.
    Rows,
    /// A procedure: its first result set, read as a whole.
    Call,
    Change,
}

fn shape(sql: &str) -> Shape {
    match first_word(sql).as_str() {
        "SELECT" | "WITH" | "VALUES" => Shape::Rows,
        "CALL" => Shape::Call,
        _ => Shape::Change,
    }
}

struct Answer {
    columns: Vec<Column>,
    rows: u64,
    truncated: bool,
    changed: Option<u64>,
    /// The result was left before its end and could not be read to it: the connection is gone.
    left: bool,
}

/// Reads one large object of the current row.
async fn lob(
    rows: &mut Db2RowReader<'_>,
    value: &justybase_db2::Db2LobValue,
) -> Result<Cell, Db2Error> {
    if value.byte_length > MAX_LOB {
        return Ok(Cell::Unreadable(format!(
            "large object of {} bytes",
            value.byte_length
        )));
    }
    let mut reader = rows.open_lob(value).await?;
    let mut bytes = Vec::with_capacity(usize::try_from(value.byte_length).unwrap_or(0));
    while let Some(chunk) = reader.next_chunk().await? {
        bytes.extend_from_slice(&chunk);
    }
    Ok(match value.encoding {
        Db2LobEncoding::Utf8 => Cell::Text(super::value::text_bytes(&bytes)),
        Db2LobEncoding::Utf16Be => {
            let units: Vec<u16> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| u16::from_be_bytes(*p))
                .collect();
            Cell::Text(text(&String::from_utf16_lossy(&units)))
        }
        _ => Cell::bytes(&bytes),
    })
}

fn as_asked(c: Cell, plain: bool) -> Cell {
    if plain {
        c.plain().map_or(Cell::Null, Cell::Text)
    } else {
        c
    }
}

impl Db2 {
    /// One statement, to its end. `plain`: every value as text (the app's own questions).
    async fn one(
        session: &mut Db2Session,
        sql: &str,
        values: &[Db2Value],
        sink: &mut dyn RowSink,
        plain: bool,
    ) -> Result<AppResult<Answer>, Db2Error> {
        // our own clock and the stop of the user end a statement, not a deadline of the driver
        let options = Db2CommandOptions::unlimited();
        if !values.is_empty() {
            let statement = session.prepare_with_options(sql, options).await?;
            if statement.parameter_columns.len() != values.len() {
                return Ok(Err(AppError::new(
                    ErrorCode::InvalidQuery,
                    format!(
                        "the statement has {} placeholders, {} values were given",
                        statement.parameter_columns.len(),
                        values.len()
                    ),
                )));
            }
            for (value, place) in values.iter().zip(&statement.parameter_columns) {
                if let Err(e) = fits(value, place) {
                    return Ok(Err(e));
                }
            }
        }
        let mut answer = Answer {
            columns: Vec::new(),
            rows: 0,
            truncated: false,
            changed: None,
            left: false,
        };
        match shape(sql) {
            Shape::Change => {
                let n = if values.is_empty() {
                    session.execute_with_options(sql, options).await?
                } else {
                    session
                        .execute_with_params_and_options(sql, values, options)
                        .await?
                };
                answer.changed = u64::try_from(n).ok();
            }
            Shape::Call => {
                let result = if values.is_empty() {
                    session.query_with_options(sql, options).await?
                } else {
                    session
                        .query_with_params_and_options(sql, values, options)
                        .await?
                };
                // the first result set a procedure opened, or what the call itself gave
                let (columns, rows) = match result.result_sets.into_iter().next() {
                    Some(set) => (set.columns, set.rows),
                    None => (result.columns, result.rows),
                };
                answer.columns = columns.iter().map(column).collect();
                if !answer.columns.is_empty() {
                    sink.start(&answer.columns);
                    for row in rows {
                        let cells = row
                            .into_iter()
                            .zip(&answer.columns)
                            .map(|(v, c)| as_asked(cell(v, c.kind), plain))
                            .collect();
                        answer.rows += 1;
                        if !sink.row(cells) {
                            answer.truncated = true;
                            break;
                        }
                    }
                }
            }
            Shape::Rows => {
                let mut rows = if values.is_empty() {
                    session.query_stream_with_options(sql, options).await?
                } else {
                    session
                        .query_stream_with_params_and_options(sql, values, options)
                        .await?
                };
                answer.columns = rows.columns().iter().map(column).collect();
                sink.start(&answer.columns);
                while let Some(row) = rows.next().await? {
                    let mut cells = Vec::with_capacity(row.len());
                    for (i, v) in row.into_iter().enumerate() {
                        let kind = answer.columns.get(i).map_or(ColKind::Other, |c| c.kind);
                        let c = match v {
                            Db2Value::Lob(l) => lob(&mut rows, &l).await?,
                            v => cell(v, kind),
                        };
                        cells.push(as_asked(c, plain));
                    }
                    answer.rows += 1;
                    if !sink.row(cells) {
                        answer.truncated = true;
                        break;
                    }
                }
                if answer.truncated {
                    // DRDA lets the driver only read on: a short rest is read, a long one costs the
                    // connection (the driver closes it when the reader is dropped unfinished)
                    answer.left = tokio::time::timeout(DRAIN, rows.close()).await.is_err();
                } else {
                    rows.close().await?;
                }
            }
        }
        Ok(Ok(answer))
    }

    fn run(
        &mut self,
        sql: &str,
        values: &[Db2Value],
        timeout: Option<Duration>,
        sink: &mut dyn RowSink,
        plain: bool,
        stop: Stop,
    ) -> AppResult<Answer> {
        if self.broken || self.session.is_closed() {
            return Err(super::closed());
        }
        // asked for before the statement borrows the session; without a token the server cannot be told
        let handle = self.session.interrupt_handle().ok();
        let tunnel = self.tunnel.clone();
        let on = self.on.clone();
        let session = &mut self.session;
        let mut hit = None;
        let (result, ended) = super::block_cancelling(
            timeout,
            stop,
            async {
                match Self::one(session, sql, values, sink, plain).await {
                    Ok(answer) => answer,
                    Err(e) => {
                        let error = failed(&e, &on);
                        hit = Some(breaks(&e));
                        Err(error)
                    }
                }
            },
            async {
                if let Some(handle) = &handle {
                    // the interrupt is a connection of its own: through a tunnel it is announced
                    if let Some(tunnel) = &tunnel {
                        tunnel.permit();
                    }
                    let _ = handle.interrupt().await;
                }
            },
        );
        if ended == Ended::Abandoned || hit == Some(true) || self.session.is_closed() {
            self.broken = true;
        }
        match result {
            Ok(answer) => {
                if answer.left {
                    self.broken = true;
                }
                Ok(answer)
            }
            Err(e) => Err(e),
        }
    }
}

/// A sink for the app's own questions: every row as text.
struct TextSink(super::TextRows);

impl RowSink for TextSink {
    fn start(&mut self, _columns: &[Column]) {}
    fn row(&mut self, cells: Vec<Cell>) -> bool {
        self.0.push(
            cells
                .into_iter()
                .map(|c| match c {
                    Cell::Text(t) => Some(t),
                    _ => None,
                })
                .collect(),
        );
        true
    }
}

impl Session for Db2 {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        let values: Vec<Db2Value> = params
            .iter()
            .map(|p| Db2Value::Text((*p).to_owned()))
            .collect();
        let mut sink = TextSink(Vec::new());
        self.run(sql, &values, timeout, &mut sink, true, stop)?;
        Ok(sink.0)
    }

    fn execute_bound(
        &mut self,
        sql: &str,
        params: &[Bind],
        limits: Limits,
        sink: &mut dyn RowSink,
        stop: Stop,
    ) -> AppResult<Outcome> {
        let sql = sql.trim().trim_end_matches(';').trim_end();
        if sql.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
        }
        if sql.len() > MAX_SQL_LEN {
            return Err(AppError::new(ErrorCode::InvalidQuery, "statement too long"));
        }
        let started = Instant::now();
        let values: Vec<Db2Value> = params.iter().map(bound).collect();
        let answer = self.run(sql, &values, limits.timeout, sink, false, stop)?;
        Ok(Outcome {
            rows_affected: answer
                .columns
                .is_empty()
                .then_some(answer.changed)
                .flatten(),
            columns: answer.columns,
            rows: answer.rows,
            truncated: answer.truncated,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    fn via_tunnel(&mut self, tunnel: Arc<crate::ssh::Tunnel>) {
        self.tunnel = Some(tunnel);
    }

    fn transaction_state(&mut self, _stop: Stop) -> TxState {
        // the driver commits behind every statement: nothing stays open between two of them
        TxState::Idle
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        Ok(if self.version.is_empty() {
            "Db2".to_owned()
        } else {
            format!("Db2 {}", self.version)
        })
    }

    fn is_open(&self) -> bool {
        !self.broken && !self.session.is_closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(sql_type: u16, length: u64, precision: u16, scale: u16) -> ColumnDescription {
        ColumnDescription {
            name: "C".into(),
            sql_type,
            length,
            precision,
            scale,
            nullable: sql_type & 1 == 1,
        }
    }

    #[test]
    fn a_value_is_bound_as_it_is_or_refused() {
        let int = place(INTEGER + 1, 4, 0, 0);
        assert!(fits(&Db2Value::Text("42".into()), &int).is_ok());
        assert!(fits(&Db2Value::Text(" -7 ".into()), &int).is_ok());
        // the driver would make 1 of it
        assert!(fits(&Db2Value::Text("1.5".into()), &int).is_err());
        assert!(fits(&Db2Value::Decimal("1e3".into()), &int).is_err());
        assert!(fits(&Db2Value::Text("".into()), &int).is_err());
        assert!(fits(&Db2Value::Integer(1), &int).is_ok());

        let dec = place(DECIMAL, 0, 9, 2);
        assert!(fits(&Db2Value::Decimal("12.50".into()), &dec).is_ok());
        assert!(fits(&Db2Value::Decimal("12.500".into()), &dec).is_ok());
        assert!(fits(&Db2Value::Decimal("12.505".into()), &dec).is_err());
        assert!(fits(&Db2Value::Text("abc".into()), &dec).is_err());
        assert!(fits(&Db2Value::Text(".".into()), &dec).is_err());

        let flag = place(BOOLEAN, 1, 0, 0);
        assert!(fits(&Db2Value::Text("TRUE".into()), &flag).is_ok());
        // the driver reads any number but 0 as true
        assert!(fits(&Db2Value::Text("2".into()), &flag).is_err());

        // a text is the server's to read where the place is a text or a date
        assert!(fits(&Db2Value::Text("1.5".into()), &place(VARCHAR, 20, 0, 0)).is_ok());
        assert!(fits(&Db2Value::Text("2026-02-30".into()), &place(DATE, 10, 0, 0)).is_ok());
    }

    #[test]
    fn numbers_keep_their_digits_on_the_way_in() {
        assert_eq!(bound(&Bind::Int("42".into())), Db2Value::Integer(42));
        assert_eq!(
            bound(&Bind::Int("123456789012345678901234567890".into())),
            Db2Value::Decimal("123456789012345678901234567890".into())
        );
        assert_eq!(
            bound(&Bind::Decimal("0.10".into())),
            Db2Value::Decimal("0.10".into())
        );
        assert_eq!(
            bound(&Bind::Date("2026-11-12".into())),
            Db2Value::Text("2026-11-12".into())
        );
    }

    #[test]
    fn values_of_a_row_become_cells() {
        assert_eq!(cell(Db2Value::Null, ColKind::Int), Cell::Null);
        assert_eq!(cell(Db2Value::Integer(-3), ColKind::Int), Cell::I64(-3));
        assert_eq!(
            cell(Db2Value::Decimal("1.10".into()), ColKind::Decimal),
            Cell::Decimal("1.10".into())
        );
        assert_eq!(
            cell(Db2Value::Text("2026-11-12".into()), ColKind::Date),
            Cell::Date(NaiveDate::from_ymd_opt(2026, 11, 12).unwrap())
        );
        // both ways Db2 writes an instant
        let at = NaiveDate::from_ymd_opt(2026, 11, 12)
            .unwrap()
            .and_hms_micro_opt(13, 14, 15, 123_456)
            .unwrap();
        for written in ["2026-11-12-13.14.15.123456", "2026-11-12 13:14:15.123456"] {
            assert_eq!(
                cell(Db2Value::Text(written.into()), ColKind::Timestamp),
                Cell::Ts(at)
            );
        }
        assert_eq!(
            cell(Db2Value::Text("13.14.15".into()), ColKind::Time),
            Cell::Time(NaiveTime::from_hms_opt(13, 14, 15).unwrap())
        );
        // what is no date stays what the server sent
        assert_eq!(
            cell(Db2Value::Text("0001-01-01?".into()), ColKind::Date),
            Cell::Text("0001-01-01?".into())
        );
        assert_eq!(
            cell(Db2Value::Bytes(vec![0, 255]), ColKind::Text),
            Cell::Bytes(2, vec![0, 255])
        );
    }

    #[test]
    fn the_first_word_says_what_a_statement_gives() {
        assert_eq!(shape("select 1 from sysibm.sysdummy1"), Shape::Rows);
        assert_eq!(
            shape("  -- why\n /* and */ WITH t AS (…) SELECT 1"),
            Shape::Rows
        );
        assert_eq!(shape("(values 1)"), Shape::Rows);
        assert_eq!(shape("call sysproc.admin_cmd('runstats …')"), Shape::Call);
        assert_eq!(shape("update t set a = 1"), Shape::Change);
        assert_eq!(shape("selection"), Shape::Change);
        assert_eq!(shape(""), Shape::Change);
    }

    #[test]
    fn types_are_named_as_one_writes_them() {
        assert_eq!(type_name(&place(DECIMAL + 1, 0, 9, 2)), "DECIMAL(9, 2)");
        assert_eq!(type_name(&place(VARCHAR, 50, 0, 0)), "VARCHAR(50)");
        assert_eq!(type_name(&place(FLOAT, 4, 0, 0)), "REAL");
        assert_eq!(type_name(&place(TIMESTAMP, 26, 0, 6)), "TIMESTAMP");
        assert_eq!(type_name(&place(TIMESTAMP, 32, 0, 12)), "TIMESTAMP(12)");
        assert_eq!(kind_of(&place(DECFLOAT + 1, 16, 0, 0)), ColKind::Decimal);
        assert_eq!(kind_of(&place(XML + 1, 0, 0, 0)), ColKind::Text);
        assert_eq!(kind_of(&place(2000, 0, 0, 0)), ColKind::Other);
    }

    #[test]
    fn a_profile_that_cannot_work_is_refused_in_words() {
        let mut p = crate::db::sqlite::demo_profile();
        p.kind = crate::db::DbKind::Db2;
        p.host = "db.example".into();
        p.port = 0;
        p.database = "SAMPLE".into();
        p.user = "db2inst1".into();
        let secret = Secret::new("pw".to_owned());
        p.tls = TlsMode::Off;
        let c = config(&p, Some(&secret)).unwrap();
        assert_eq!((c.port, c.use_ssl), (50000, false));
        // the password is in no text of the configuration
        assert!(!format!("{c:?}").contains("pw\""));

        p.tls = TlsMode::Require;
        assert!(config(&p, None).unwrap_err().message.contains("verify"));
        p.tls = TlsMode::Verify;
        assert!(config(&p, None).unwrap().use_ssl);
        p.client_cert = "/tmp/c.pem".into();
        assert_eq!(
            config(&p, None).unwrap_err().code,
            ErrorCode::InvalidProfile
        );
        p.client_cert.clear();
        p.database.clear();
        assert_eq!(
            config(&p, None).unwrap_err().code,
            ErrorCode::InvalidProfile
        );
    }

    #[test]
    fn what_db2_says_becomes_our_error() {
        let mut e = Db2Error::new(Db2ErrorKind::SqlServer, "DB2 SQLCODE=-204 SQLSTATE=42704 T");
        e.sql_code = Some(-204);
        e.sql_state = Some("42704".into());
        let ours = failed(&e, "h:50000/S");
        assert_eq!(ours.code, ErrorCode::InvalidQuery);
        assert_eq!(
            ours.details.and_then(|d| d.sqlstate).as_deref(),
            Some("42704")
        );
        e.sql_code = Some(-952);
        assert_eq!(failed(&e, "h").code, ErrorCode::Cancelled);
        e.sql_code = Some(-551);
        assert_eq!(failed(&e, "h").code, ErrorCode::PermissionDenied);
        let login = Db2Error::new(Db2ErrorKind::AuthenticationFailed, "user X password Y");
        assert_eq!(failed(&login, "h").message, "login failed");
        assert!(breaks(&Db2Error::new(Db2ErrorKind::Transport, "reset")));
        assert!(!breaks(&e));
    }
}
