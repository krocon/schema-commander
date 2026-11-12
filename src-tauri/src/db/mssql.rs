//! SQL Server over `tiberius` (prompt 003, after log-commander's prompt 019). A statement runs as a batch
//! (`simple_query`); the first result set with columns is the result.

use super::value::{Cell, ColKind, Column, Outcome, RowSink, text};
use super::{
    Bind, Limits, Profile, Session, Stop, TlsMode, block, clean, closed, keeps_connection,
};
use crate::error::{AppError, AppResult, ErrorCode};
use futures_util::StreamExt;
use std::time::Instant;
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, FromSql};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type Conn = Client<Compat<TcpStream>>;

/// The column the row count travels in (see [`Ms::run`]).
const ROWCOUNT: &str = "__sc_rowcount";

pub struct Ms {
    conn: Option<Conn>,
    profile: Profile,
}

/// Errors of tiberius with a code the frontend can act on; never holds the password.
pub fn ms_error(profile: &Profile, e: &tiberius::error::Error) -> AppError {
    use tiberius::error::Error as E;
    let on = profile.where_label();
    match e {
        E::Server(t) if matches!(t.code(), 18456 | 18452 | 18486 | 18487 | 18488) => AppError::new(
            ErrorCode::AuthFailed,
            format!("login failed ({})", t.code()),
        ),
        E::Server(t) if t.code() == 4060 => AppError::new(ErrorCode::NotFound, clean(t.message())),
        E::Server(t) if matches!(t.code(), 229 | 230 | 262 | 297 | 300 | 916) => {
            AppError::new(ErrorCode::PermissionDenied, clean(t.message()))
        }
        E::Server(t) => AppError::new(
            ErrorCode::InvalidQuery,
            format!("{} ({})", clean(t.message()), t.code()),
        )
        // the line of the batch and the name the message quotes (prompt 022)
        .with(crate::error::ErrorDetails {
            sqlstate: Some(t.code().to_string()),
            line: (t.line() > 0).then(|| t.line()),
            near: crate::error::quoted_part(t.message()),
            context: Some(t.procedure().to_string()).filter(|p| !p.is_empty()),
            ..Default::default()
        }),
        E::Tls(m) => AppError::new(ErrorCode::TlsFailed, format!("{on}: {}", clean(m))),
        E::Io { message, .. } => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: {}", clean(message)),
        ),
        other => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: {}", clean(&other.to_string())),
        ),
    }
}

pub fn connect(
    profile: &Profile,
    secret: Option<&super::secrets::Secret>,
    stop: Stop,
) -> AppResult<Ms> {
    super::install_crypto();
    let mut c = Config::new();
    c.host(profile.host.trim());
    c.port(profile.port_or_default());
    if !profile.database.trim().is_empty() {
        c.database(profile.database.trim());
    }
    c.application_name("Schema Commander");
    c.authentication(AuthMethod::sql_server(
        profile.user.trim(),
        secret
            .map(super::secrets::Secret::expose)
            .unwrap_or_default(),
    ));
    match profile.tls {
        // the driver always checks the host name with the certificate: there is no "CA only" here
        TlsMode::Verify | TlsMode::VerifyCa => {
            c.encryption(EncryptionLevel::Required);
            if !profile.ca_file.trim().is_empty() {
                c.trust_cert_ca(profile.ca_file.trim());
            }
        }
        TlsMode::Require => {
            c.encryption(EncryptionLevel::Required);
            c.trust_cert();
        }
        TlsMode::Prefer => {
            c.encryption(EncryptionLevel::On);
            c.trust_cert();
        }
        // Only the login is encrypted then (the server may still insist on more); its certificate is
        // not checked – this mode is for servers on this machine.
        TlsMode::Off => {
            c.encryption(EncryptionLevel::Off);
            c.trust_cert();
        }
    }
    let conn = block(Some(super::CONNECT_TIMEOUT), stop, async {
        let tcp = TcpStream::connect(c.get_addr()).await.map_err(|e| {
            AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{}: {e}", profile.where_label()),
            )
        })?;
        tcp.set_nodelay(true).ok();
        Client::connect(c, tcp.compat_write())
            .await
            .map_err(|e| ms_error(profile, &e))
    })?;
    Ok(Ms {
        conn: Some(conn),
        profile: profile.clone(),
    })
}

fn kind(t: ColumnType) -> ColKind {
    use ColumnType as T;
    match t {
        T::Int1 | T::Int2 | T::Int4 | T::Int8 | T::Intn => ColKind::Int,
        T::Float4 | T::Float8 | T::Floatn => ColKind::Float,
        T::Money | T::Money4 | T::Decimaln | T::Numericn => ColKind::Decimal,
        T::Bit | T::Bitn => ColKind::Bool,
        T::BigVarChar | T::BigChar | T::NVarchar | T::NChar | T::Text | T::NText | T::Xml => {
            ColKind::Text
        }
        T::BigVarBin | T::BigBinary | T::Image => ColKind::Bytes,
        T::Datetime | T::Datetime4 | T::Datetimen | T::Datetime2 => ColKind::Timestamp,
        T::DatetimeOffsetn => ColKind::TimestampTz,
        T::Daten => ColKind::Date,
        T::Timen => ColKind::Time,
        T::Guid => ColKind::Uuid,
        _ => ColKind::Other,
    }
}

fn columns(cols: &[tiberius::Column]) -> Vec<Column> {
    cols.iter()
        .map(|c| Column {
            name: c.name().to_string(),
            type_name: format!("{:?}", c.column_type()),
            kind: kind(c.column_type()),
        })
        .collect()
}

fn cell(data: &ColumnData<'static>, type_name: &str) -> Cell {
    let other = || Cell::Unreadable(type_name.to_string());
    match data {
        ColumnData::U8(v) => v.map_or(Cell::Null, |n| Cell::I64(n.into())),
        ColumnData::I16(v) => v.map_or(Cell::Null, |n| Cell::I64(n.into())),
        ColumnData::I32(v) => v.map_or(Cell::Null, |n| Cell::I64(n.into())),
        ColumnData::I64(v) => v.map_or(Cell::Null, Cell::I64),
        ColumnData::F32(v) => v.map_or(Cell::Null, |n| Cell::F64(n.into())),
        ColumnData::F64(v) => v.map_or(Cell::Null, Cell::F64),
        ColumnData::Bit(v) => v.map_or(Cell::Null, Cell::Bool),
        ColumnData::String(v) => v.as_ref().map_or(Cell::Null, |s| Cell::Text(text(s))),
        ColumnData::Guid(v) => v.map_or(Cell::Null, |g| Cell::Uuid(g.to_string())),
        ColumnData::Binary(v) => v.as_ref().map_or(Cell::Null, |b| Cell::bytes(b)),
        ColumnData::Numeric(v) => v.map_or(Cell::Null, |n| Cell::Decimal(n.to_string())),
        ColumnData::Xml(v) => v
            .as_ref()
            .map_or(Cell::Null, |x| Cell::Text(text(&x.to_string()))),
        ColumnData::DateTimeOffset(None)
        | ColumnData::DateTime(None)
        | ColumnData::SmallDateTime(None)
        | ColumnData::DateTime2(None)
        | ColumnData::Date(None)
        | ColumnData::Time(None) => Cell::Null,
        ColumnData::DateTimeOffset(_) => {
            match chrono::DateTime::<chrono::FixedOffset>::from_sql(data) {
                Ok(Some(t)) => Cell::TsTz(t),
                _ => other(),
            }
        }
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            match chrono::NaiveDateTime::from_sql(data) {
                Ok(Some(t)) => Cell::Ts(t),
                _ => other(),
            }
        }
        ColumnData::Date(_) => match chrono::NaiveDate::from_sql(data) {
            Ok(Some(d)) => Cell::Date(d),
            _ => other(),
        },
        ColumnData::Time(_) => match chrono::NaiveTime::from_sql(data) {
            Ok(Some(t)) => Cell::Time(t),
            _ => other(),
        },
    }
}

/// The batch with a last statement that reports `@@ROWCOUNT`: tiberius does not pass on the row counts of
/// the protocol. `@@ROWCOUNT` right after the user's statement is its count.
///
/// A statement that defines something (`CREATE …`, `ALTER …`) gets nothing added: the body of a trigger
/// or a procedure runs to the end of its batch, so the addition would become part of it – stored with
/// it and run with every call. Such a statement has no row count worth showing anyway.
fn with_rowcount(sql: &str) -> String {
    if defines(sql) {
        return sql.to_string();
    }
    format!("{sql}\n;SELECT @@ROWCOUNT AS [{ROWCOUNT}]")
}

/// Whether the first word of a batch, behind blanks and comments, is `CREATE` or `ALTER`.
fn defines(sql: &str) -> bool {
    let mut rest = sql;
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, r)| r);
        } else if let Some(after) = rest.strip_prefix("/*") {
            // comments of T-SQL nest
            let mut depth = 1usize;
            let mut i = 0;
            let bytes = after.as_bytes();
            while i < bytes.len() && depth > 0 {
                if bytes[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if bytes[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            rest = after.get(i..).unwrap_or("");
        } else {
            break;
        }
    }
    let word: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    word.eq_ignore_ascii_case("CREATE") || word.eq_ignore_ascii_case("ALTER")
}

/// A decimal as text → an exact `numeric` (digits and scale); `None` when it is none or too long.
fn numeric(text: &str) -> Option<tiberius::numeric::Numeric> {
    let t = text.trim();
    let (sign, digits) = match t.strip_prefix('-') {
        Some(rest) => (-1i128, rest),
        None => (1i128, t.strip_prefix('+').unwrap_or(t)),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let all = format!("{whole}{fraction}");
    if all.is_empty() || all.len() > 37 || !all.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let value = all.parse::<i128>().ok()?;
    let scale = u8::try_from(fraction.len()).ok()?;
    Some(tiberius::numeric::Numeric::new_with_scale(
        sign * value,
        scale,
    ))
}

/// Statements that must be alone in their batch (`CREATE VIEW`, `CREATE PROCEDURE` …) are refused with the
/// added `SELECT`: error 111, or a syntax error (102, 156) at the added statement. All three are found when
/// the batch is compiled – nothing of it ran, so it is safe to send it again without the addition.
fn must_be_alone(e: &tiberius::error::Error) -> bool {
    // (1067: `SET SHOWPLAN_XML` wants to be alone too – prompt 039)
    matches!(e, tiberius::error::Error::Server(t) if matches!(t.code(), 102 | 111 | 156 | 1067))
}

impl Ms {
    async fn batch(
        conn: &mut Conn,
        sql: String,
        params: &[Bind],
        sink: &mut dyn RowSink,
    ) -> Result<(Vec<Column>, u64, bool, Option<u64>), tiberius::error::Error> {
        let mut stream = if params.is_empty() {
            conn.simple_query(sql).await?
        } else {
            // sp_executesql: the values travel as parameters @P1 …, never in the text
            let mut query = tiberius::Query::new(sql);
            for p in params {
                match p {
                    Bind::Text(v) | Bind::Date(v) | Bind::Datetime(v) => query.bind(v.clone()),
                    Bind::Int(v) => match v.trim().parse::<i64>() {
                        Ok(n) => query.bind(n),
                        Err(_) => query.bind(v.clone()),
                    },
                    Bind::Decimal(v) => match numeric(v) {
                        Some(n) => query.bind(n),
                        None => query.bind(v.clone()),
                    },
                    Bind::Bool(v) => query.bind(*v),
                }
            }
            query.query(conn).await?
        };
        let mut cols: Vec<Column> = Vec::new();
        let mut rows: u64 = 0;
        let mut current: Vec<Column> = Vec::new();
        let mut affected: Option<u64> = None;
        let mut truncated = false;
        // 0 = before the first result set with columns, 1 = in it, 2 = behind it
        let mut state = 0u8;
        while let Some(item) = stream.next().await {
            match item? {
                tiberius::QueryItem::Metadata(meta) => {
                    current = columns(meta.columns());
                    let count_only = current.len() == 1 && current[0].name == ROWCOUNT;
                    if state == 1 {
                        state = 2;
                    }
                    if state == 0 && !count_only && !current.is_empty() {
                        cols = current.clone();
                        sink.start(&cols);
                        state = 1;
                    }
                }
                tiberius::QueryItem::Row(row) => {
                    if current.len() == 1 && current[0].name == ROWCOUNT {
                        if let Some((_, ColumnData::I32(Some(n)))) = row.cells().next() {
                            affected = Some(u64::try_from(*n).unwrap_or(0));
                        }
                        continue;
                    }
                    // the plan of a statement that ran (`SET STATISTICS XML ON`, prompt 039) comes as a
                    // result set of its own behind the statement's: handed on as a row of one cell
                    if state == 2 && current.len() == 1 && current[0].name.contains("Showplan") {
                        if let Some((_, data)) = row.cells().next()
                            && !sink.row(vec![cell(data, &current[0].type_name)])
                        {
                            truncated = true;
                            break;
                        }
                        continue;
                    }
                    // other result sets are read and dropped: the connection must see the end of the batch
                    if state != 1 {
                        continue;
                    }
                    let cells: Vec<Cell> = row
                        .cells()
                        .zip(cols.iter())
                        .map(|((_, data), c)| cell(data, &c.type_name))
                        .collect();
                    rows += 1;
                    if !sink.row(cells) {
                        // no more rows are wanted; `execute` drops the connection instead of reading on
                        truncated = true;
                        break;
                    }
                }
            }
        }
        Ok((cols, rows, truncated, affected))
    }

    async fn run(
        conn: &mut Conn,
        sql: &str,
        params: &[Bind],
        sink: &mut dyn RowSink,
        profile: &Profile,
    ) -> AppResult<Outcome> {
        let started = Instant::now();
        let first = Self::batch(conn, with_rowcount(sql), params, sink).await;
        let (columns, rows, truncated, affected) = match first {
            Err(e) if must_be_alone(&e) => Self::batch(conn, sql.to_string(), params, sink)
                .await
                .map_err(|e| ms_error(profile, &e))?,
            other => other.map_err(|e| ms_error(profile, &e))?,
        };
        let has_result = !columns.is_empty();
        Ok(Outcome {
            columns,
            rows,
            truncated,
            rows_affected: if has_result { None } else { affected },
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }
}

impl Ms {
    async fn ask(
        conn: &mut Conn,
        sql: &str,
        params: &[&str],
        profile: &Profile,
    ) -> AppResult<super::TextRows> {
        let mut query = tiberius::Query::new(sql.to_string());
        for p in params {
            query.bind((*p).to_string());
        }
        let fail = |e: tiberius::error::Error| ms_error(profile, &e);
        let rows = query
            .query(conn)
            .await
            .map_err(fail)?
            .into_first_result()
            .await
            .map_err(fail)?;
        Ok(rows
            .iter()
            .map(|row| {
                row.cells()
                    .map(|(_, data)| cell(data, "").plain())
                    .collect()
            })
            .collect())
    }
}

impl Session for Ms {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<std::time::Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        let profile = self.profile.clone();
        let conn = self.conn.as_mut().ok_or_else(closed)?;
        let r = block(timeout, stop, Self::ask(conn, sql, params, &profile));
        if r.as_ref().is_err_and(|e| !super::keeps_after_ask(e.code)) {
            self.conn = None;
        }
        r
    }

    fn execute_bound(
        &mut self,
        sql: &str,
        params: &[Bind],
        limits: Limits,
        sink: &mut dyn RowSink,
        stop: Stop,
    ) -> AppResult<Outcome> {
        let profile = self.profile.clone();
        let conn = self.conn.as_mut().ok_or_else(closed)?;
        // tiberius cannot send the attention signal: a stopped statement costs the connection
        let r = block(
            limits.timeout,
            stop,
            Self::run(conn, sql, params, sink, &profile),
        );
        let lost = r.as_ref().is_err_and(|e| {
            !keeps_connection(e.code) || matches!(e.code, ErrorCode::Cancelled | ErrorCode::Timeout)
        });
        // rows left unread would have to be read to their end first: the connection goes instead
        if lost || r.as_ref().is_ok_and(|o| o.truncated) {
            self.conn = None;
        }
        r
    }

    fn transaction_state(&mut self, stop: Stop) -> super::TxState {
        use super::TxState;
        match self.ask(
            "SELECT CAST(@@TRANCOUNT AS varchar(10)), CAST(XACT_STATE() AS varchar(10))",
            &[],
            Some(std::time::Duration::from_secs(5)),
            stop,
        ) {
            Ok(rows) => {
                let cell = |i: usize| {
                    rows.first()
                        .and_then(|r| r.get(i))
                        .cloned()
                        .flatten()
                        .and_then(|t| t.trim().parse::<i32>().ok())
                };
                match (cell(0), cell(1)) {
                    (_, Some(-1)) => TxState::Failed,
                    (Some(n), _) if n > 0 => TxState::Active,
                    (Some(_), _) => TxState::Idle,
                    _ => TxState::Unknown,
                }
            }
            Err(_) => TxState::Unknown,
        }
    }

    fn server_version(&mut self, stop: Stop) -> AppResult<String> {
        let r = self.query("SELECT @@VERSION", Limits::rows(1), stop)?;
        Ok(match r.rows.first().and_then(|row| row.first()) {
            // the first line names product and version
            Some(Cell::Text(v)) => v.lines().next().unwrap_or("SQL Server").trim().to_string(),
            _ => "SQL Server".to_string(),
        })
    }

    fn is_open(&self) -> bool {
        self.conn.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_the_row_count_behind_the_statement() {
        let sql = with_rowcount("UPDATE t SET a = 1 -- note");
        // a trailing line comment must not swallow the added statement
        assert!(sql.contains("-- note\n;SELECT @@ROWCOUNT"));
    }

    #[test]
    fn adds_nothing_to_a_statement_that_defines_something() {
        // the body of a trigger or a procedure runs to the end of the batch: an added statement would
        // become part of it and run with every call
        for sql in [
            "CREATE TRIGGER t ON x AFTER UPDATE AS BEGIN SET NOCOUNT ON; END",
            "  create procedure p as select 1",
            "-- a note\n/* and /* a nested */ one */\nALTER PROCEDURE p AS SELECT 2",
            "CREATE OR ALTER VIEW v AS SELECT 1 AS a",
            "CREATE TABLE t (a int)",
        ] {
            assert_eq!(with_rowcount(sql), sql, "{sql}");
        }
        // words that only start like them are statements like any other
        assert!(with_rowcount("CREATED_AT_FIX: UPDATE t SET a = 1").contains("@@ROWCOUNT"));
        assert!(with_rowcount("-- CREATE\nDELETE FROM t").contains("@@ROWCOUNT"));
    }

    #[test]
    fn reads_cells() {
        assert_eq!(cell(&ColumnData::I32(Some(7)), "Int4"), Cell::I64(7));
        assert_eq!(cell(&ColumnData::I32(None), "Int4"), Cell::Null);
        assert_eq!(cell(&ColumnData::Bit(Some(true)), "Bit"), Cell::Bool(true));
        assert_eq!(
            cell(&ColumnData::String(Some("ä".into())), "NVarchar"),
            Cell::Text("ä".into())
        );
        assert_eq!(
            cell(&ColumnData::Binary(Some(vec![1, 2].into())), "BigVarBin"),
            Cell::Bytes(2, vec![1, 2])
        );
        assert_eq!(cell(&ColumnData::Date(None), "Daten"), Cell::Null);
    }
}
