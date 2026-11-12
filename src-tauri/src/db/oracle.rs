//! Oracle Database over `oracledb` (prompt 035b): the thin driver maintained by Oracle – pure Rust, no
//! Instant Client. The driver is synchronous and (as a beta) cannot interrupt a call, so the connection
//! lives on a thread of its own: a statement that is stopped or runs out of time is left behind there
//! and the session is closed – as with SQL Server, a stopped statement costs the connection. A second
//! connection then asks the server to end that session (`ALTER SYSTEM KILL SESSION`), which works when
//! the user may do that and is harmless when not.
//!
//! Oracle has no auto-commit on the server: the worker commits after every statement that is not a
//! query, unless a transaction was opened with `SET TRANSACTION …` (what [`super::begin_statement`]
//! sends) – then it waits for `COMMIT` or `ROLLBACK`, like the other databases after `BEGIN`.

use super::value::{Cell, ColKind, Column, Outcome, RowSink, text};
use super::{Bind, CANCEL_GRACE, Limits, Profile, Session, Stop, TlsMode, TxState, clean, closed};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use chrono::{FixedOffset, NaiveDate, TimeZone};
use oracledb::{
    Config, Connection, ErrorKind, JsonValue, Metadata, OracleIntervalDS, OracleIntervalYM,
    OracleNumber, OracleTimestamp, Row, ToDbValue,
};
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, channel, sync_channel};
use std::time::{Duration, Instant};

/// Longest statement accepted (bytes).
pub const MAX_SQL_LEN: usize = 16 * 1024 * 1024;
/// Rows that wait between the worker and the sink at most.
const QUEUE: usize = 512;

/// What the session asks its worker to do.
enum Job {
    Run {
        sql: String,
        params: Vec<Bind>,
        /// Every value as text (the app's own questions).
        plain: bool,
        events: SyncSender<Event>,
        /// Set by the session when no more rows are wanted.
        enough: Arc<AtomicBool>,
    },
}

/// What the worker tells about a statement.
enum Event {
    Start(Vec<Column>),
    Row(Vec<Cell>),
    Done(AppResult<Ended>),
}

struct Ended {
    columns: Vec<Column>,
    rows: u64,
    truncated: bool,
    rows_affected: Option<u64>,
}

pub struct Ora {
    /// The SSH tunnel this session runs through, if any: held so its listener outlives the session.
    tunnel: Option<Arc<crate::ssh::Tunnel>>,
    /// The way to the thread that holds the connection; `None` = closed.
    jobs: Option<Sender<Job>>,
    /// To ask the server to end this session: a second connection, and who we are there.
    config: Config,
    /// The folder with the certificates of the profile, if it has some: the second connection reads it too.
    _wallet: Option<Wallet>,
    sid: usize,
    serial: usize,
    version: String,
}

/// ORA-06550 names line and column of a PL/SQL block: `ORA-06550: line 2, column 3:`.
fn plsql_place(message: &str) -> Option<(u32, u32)> {
    let rest = message.split("line ").nth(1)?;
    let (line, rest) = rest.split_once(", column ")?;
    let column: String = rest.chars().take_while(char::is_ascii_digit).collect();
    Some((line.trim().parse().ok()?, column.parse().ok()?))
}

/// The name a message quotes: `ORA-00904: "NME": invalid identifier` → `NME`; of a qualified one
/// (`"SHOP"."T"`) its last part.
fn named(message: &str) -> Option<String> {
    let line = message.lines().next()?;
    let start = line.find('"')?;
    let mut last = None;
    let mut rest = &line[start..];
    while let Some(body) = rest.strip_prefix('"') {
        let end = body.find('"')?;
        last = Some(body[..end].to_owned());
        rest = &body[end + 1..];
        match rest.strip_prefix('.') {
            Some(more) => rest = more,
            None => break,
        }
    }
    last.filter(|n| !n.is_empty())
}

/// The first line of a message, without the `ORA-01234: ` it starts with.
fn first_line(message: &str) -> String {
    let line = message.lines().next().unwrap_or_default();
    let line = match line.split_once(": ") {
        Some((code, rest)) if code.starts_with("ORA-") => rest,
        _ => line,
    };
    clean(line)
}

/// Errors of the driver with a code the frontend can act on; never holds the password.
pub fn ora_error(on: &str, sql: Option<&str>, e: &oracledb::Error) -> AppError {
    match e.kind() {
        ErrorKind::DbError(db) => {
            let code = db.code();
            let message = db.message();
            let label = format!("ORA-{code:05}");
            let kind = match code {
                1017 | 1005 | 28000 | 28001 | 28002 | 28003 | 28009 | 1045 => ErrorCode::AuthFailed,
                12514 | 12505 | 12154 | 12541 => ErrorCode::NotFound,
                1031 | 41900 | 1950 | 1536 => ErrorCode::PermissionDenied,
                1013 => ErrorCode::Cancelled,
                // the session is gone: killed, or the instance went down
                28 | 31 | 1012 | 3113 | 3114 | 3135 | 1089 | 1090 | 1092 | 12537 => {
                    ErrorCode::ConnectionFailed
                }
                _ => ErrorCode::InvalidQuery,
            };
            if kind == ErrorCode::AuthFailed {
                return AppError::new(kind, format!("login failed ({label})"));
            }
            if kind == ErrorCode::ConnectionFailed {
                return AppError::new(kind, format!("{on}: {} ({label})", first_line(message)));
            }
            // further lines of the message: the cause, or what PL/SQL has to say
            let mut lines = message.lines().skip(1).map(clean).filter(|l| !l.is_empty());
            let detail = lines.by_ref().take(6).collect::<Vec<_>>().join(" · ");
            let plsql = (code == 6550).then(|| plsql_place(message)).flatten();
            // the offset counts bytes from 0; 0 is also what an error without a place carries
            let position = match (sql, plsql) {
                (Some(sql), None) if db.offset() > 0 || (900..1000).contains(&code) => {
                    crate::error::char_position(sql, db.offset())
                }
                _ => None,
            };
            let summary = if code == 6550 && !detail.is_empty() {
                // the first line only says where; the next one says what
                detail.split(" · ").next().unwrap_or_default().to_owned()
            } else {
                first_line(message)
            };
            AppError::new(kind, format!("{summary} ({label})")).with(ErrorDetails {
                sqlstate: Some(label),
                detail: Some(detail).filter(|d| !d.is_empty()),
                position,
                line: plsql.map(|(line, _)| line),
                near: named(message),
                ..Default::default()
            })
        }
        ErrorKind::CallTimeoutExceeded => {
            AppError::new(ErrorCode::Timeout, "the statement took too long")
        }
        ErrorKind::DeadConnection | ErrorKind::NotConnected => closed(),
        other => {
            let text = clean(&e.to_string());
            let lower = text.to_lowercase();
            let code = if lower.contains("certificate") || lower.contains("tls") {
                ErrorCode::TlsFailed
            } else if matches!(
                other,
                ErrorKind::ListenerRefusedConnection(..)
                    | ErrorKind::InvalidServiceName(..)
                    | ErrorKind::InvalidSid(..)
            ) {
                ErrorCode::NotFound
            } else if sql.is_some() {
                ErrorCode::InvalidQuery
            } else {
                ErrorCode::ConnectionFailed
            };
            AppError::new(code, format!("{on}: {text}"))
        }
    }
}

/// The wallet folder the driver wants, made of the PEM files of the profile: `ewallet.pem` with the CA
/// and, if given, the client certificate and its key. The folder is ours and goes with the session.
fn wallet(profile: &Profile) -> AppResult<Option<Wallet>> {
    let ca = profile.ca_file.trim();
    let cert = profile.client_cert.trim();
    if ca.is_empty() && cert.is_empty() {
        return Ok(None);
    }
    let read = |path: &str| {
        std::fs::read_to_string(path)
            .map_err(|e| AppError::new(ErrorCode::TlsFailed, format!("{path}: {e}")))
    };
    let mut pem = String::new();
    for path in [ca, cert, profile.client_key.trim()] {
        if !path.is_empty() {
            pem.push_str(read(path)?.trim_end());
            pem.push('\n');
        }
    }
    let io = |e: std::io::Error| AppError::new(ErrorCode::Io, e.to_string());
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let dir = std::env::temp_dir().join(format!(
        "sc-wallet-{}-{nanos}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    // a new folder of ours, for us alone: one that is there already is not taken
    // only Unix sets a mode on it
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).map_err(io)?;
    let wallet = Wallet(dir);
    let file = wallet.0.join("ewallet.pem");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&file)
            .map_err(io)?;
        f.write_all(pem.as_bytes()).map_err(io)?;
    }
    #[cfg(not(unix))]
    std::fs::write(&file, pem).map_err(io)?;
    Ok(Some(wallet))
}

/// The folder of [`wallet`]: removed when it is dropped (it holds a copy of the client key).
struct Wallet(std::path::PathBuf);

impl Drop for Wallet {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The driver's configuration for a profile. `database` is the service name.
fn config(profile: &Profile, secret: Option<&super::secrets::Secret>) -> AppResult<Config> {
    let service = profile.database.trim();
    if service.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidQuery,
            "Oracle needs the service name (for example FREEPDB1) as the database",
        ));
    }
    let place = format!(
        "{}:{}/{}",
        profile.host.trim(),
        profile.port_or_default(),
        service
    );
    let connect = match profile.tls {
        TlsMode::Off => place,
        // the driver always checks the certificate: there is no TLS without a check here
        TlsMode::Prefer | TlsMode::Require => {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "Oracle: TLS without checking the certificate is not available – choose a mode that \
                 checks it, or no TLS",
            ));
        }
        TlsMode::VerifyCa => format!("tcps://{place}?ssl_server_dn_match=false"),
        TlsMode::Verify => format!("tcps://{place}?ssl_server_dn_match=true"),
    };
    let on = profile.where_label();
    Config::default()
        .set_credentials(
            profile.user.trim(),
            secret
                .map(super::secrets::Secret::expose)
                .unwrap_or_default(),
        )
        .set_program("schema-commander")
        .map_err(|e| ora_error(&on, None, &e))?
        .set_transport_connect_timeout(Some(super::CONNECT_TIMEOUT))
        .set_connect_string(&connect)
        .map_err(|e| ora_error(&on, None, &e))
}

pub fn connect(
    profile: &Profile,
    secret: Option<&super::secrets::Secret>,
    stop: Stop,
) -> AppResult<Ora> {
    super::install_crypto();
    let on = profile.where_label();
    let mut config = config(profile, secret)?;
    let wallet = wallet(profile)?;
    if let Some(dir) = &wallet {
        config = config.set_wallet_location(dir.0.to_string_lossy().into_owned());
    }
    // connecting blocks: it runs on its thread, and who waits can stop waiting
    let (tx, rx) = channel();
    let for_thread = config.clone();
    let place = on.clone();
    std::thread::Builder::new()
        .name("sc-oracle-connect".into())
        .spawn(move || {
            let made = oracledb::connect(for_thread)
                .map_err(|e| ora_error(&place, None, &e))
                .and_then(|conn| {
                    let ids = (|| Ok((conn.session_id()?, conn.serial_num()?, conn.version()?)))()
                        .map_err(|e: oracledb::Error| ora_error(&place, None, &e))?;
                    Ok((conn, ids))
                });
            let _ = tx.send(made);
        })
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
    let started = Instant::now();
    let (conn, (sid, serial, version)) = loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(made) => break made?,
            Err(RecvTimeoutError::Timeout) if stop() => return Err(super::cancelled()),
            Err(RecvTimeoutError::Timeout)
                if started.elapsed() > super::CONNECT_TIMEOUT + Duration::from_secs(5) =>
            {
                return Err(AppError::new(
                    ErrorCode::Timeout,
                    format!("{on}: no answer"),
                ));
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err(closed()),
        }
    };
    let (jobs, inbox) = channel::<Job>();
    std::thread::Builder::new()
        .name("sc-oracle".into())
        .spawn(move || worker(conn, &inbox, &on))
        .map_err(|e| AppError::new(ErrorCode::Io, e.to_string()))?;
    Ok(Ora {
        tunnel: None,
        jobs: Some(jobs),
        config,
        _wallet: wallet,
        sid,
        serial,
        version: format!("{version:?}")
            .trim_start_matches("OracleVersion(")
            .trim_end_matches(')')
            .replace(", ", "."),
    })
}

// --- the worker: the only place that touches the connection -------------------------------------------

/// The first words of a statement, upper case, without comments in front.
fn head(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            break;
        }
    }
    rest.split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase()
}

/// Whether the text is PL/SQL, whose last `;` belongs to it. Everything else must lose it: the server
/// takes one statement, without the separator of a script.
fn is_plsql(head: &str) -> bool {
    let mut words = head.split(' ');
    match words.next().unwrap_or_default() {
        "BEGIN" | "DECLARE" => true,
        "CREATE" => {
            let rest: Vec<&str> = words.collect();
            let rest: Vec<&str> = match rest.as_slice() {
                ["OR", "REPLACE", tail @ ..] => tail.to_vec(),
                other => other.to_vec(),
            };
            let rest: Vec<&str> = rest
                .into_iter()
                .filter(|w| !matches!(*w, "EDITIONABLE" | "NONEDITIONABLE"))
                .collect();
            matches!(
                rest.first().copied(),
                Some("FUNCTION" | "PROCEDURE" | "PACKAGE" | "TRIGGER" | "TYPE" | "LIBRARY")
            )
        }
        _ => false,
    }
}

/// The statement as the server takes it: without the `;` of a script, and without the `/` line that
/// ends a PL/SQL block there.
fn for_server(sql: &str) -> &str {
    let mut sql = sql.trim();
    if let Some(body) = sql.strip_suffix('/')
        && body.ends_with('\n')
    {
        sql = body.trim_end();
    }
    if is_plsql(&head(sql)) {
        return sql;
    }
    let sql = sql.trim_end_matches(|c: char| c == ';' || c.is_whitespace());
    // a `;` with only comments behind it (a selection that took the note along) ends the statement too
    match last_separator(sql) {
        Some(at) => sql[..at].trim_end_matches(|c: char| c == ';' || c.is_whitespace()),
        None => sql,
    }
}

/// Where the last `;` outside of strings and comments stands, if nothing but comments follows it.
fn last_separator(sql: &str) -> Option<usize> {
    let b = sql.as_bytes();
    let mut found = None;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\'' | b'"' => {
                let quote = b[i];
                i += 1;
                while i < b.len() && b[i] != quote {
                    i += 1;
                }
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i += 1;
            }
            b';' => found = Some(i),
            c if !c.is_ascii_whitespace() => found = None,
            _ => {}
        }
        i += 1;
    }
    found
}

fn kind_of(m: &Metadata) -> (ColKind, String) {
    let name = m.data_type();
    let upper = name.to_uppercase();
    let kind = if upper.starts_with("NUMBER") {
        // a whole number an i64 holds for sure, else exact text
        if m.scale() == 0 && (1..=18).contains(&m.precision()) {
            ColKind::Int
        } else {
            ColKind::Decimal
        }
    } else if upper.starts_with("BINARY_") {
        ColKind::Float
    } else if upper.contains("WITH TIME ZONE") || upper.contains("WITH LOCAL TIME ZONE") {
        ColKind::TimestampTz
    } else if upper.starts_with("DATE") || upper.starts_with("TIMESTAMP") {
        // an Oracle DATE has a time of day
        ColKind::Timestamp
    } else if upper == "BOOLEAN" {
        ColKind::Bool
    } else if upper == "JSON" {
        ColKind::Json
    } else if upper.contains("RAW") || upper == "BLOB" {
        ColKind::Bytes
    } else if upper.contains("CHAR") || upper == "CLOB" || upper == "NCLOB" || upper == "LONG" {
        ColKind::Text
    } else {
        ColKind::Other
    };
    (kind, name)
}

fn columns(meta: &[Metadata]) -> Vec<Column> {
    meta.iter()
        .map(|m| {
            let (kind, type_name) = kind_of(m);
            Column {
                name: m.name().to_string(),
                kind,
                type_name,
            }
        })
        .collect()
}

fn instant(t: &OracleTimestamp) -> Option<chrono::NaiveDateTime> {
    NaiveDate::from_ymd_opt(
        i32::from(t.year()),
        u32::from(t.month()),
        u32::from(t.day()),
    )?
    .and_hms_nano_opt(
        u32::from(t.hour()),
        u32::from(t.minute()),
        u32::from(t.second()),
        t.nanoseconds(),
    )
}

/// JSON as text. Oracle's numbers stay as they are written: no digit goes through a float.
fn json_text(v: &JsonValue, out: &mut String) {
    let quoted = |s: &str| serde_json::Value::String(s.to_owned()).to_string();
    match v {
        JsonValue::Null => out.push_str("null"),
        JsonValue::Boolean(b) => out.push_str(if *b { "true" } else { "false" }),
        JsonValue::Number(n) => out.push_str(&n.to_string()),
        JsonValue::BinaryDouble(f) => out.push_str(&f.to_string()),
        JsonValue::BinaryFloat(f) => out.push_str(&f.to_string()),
        JsonValue::String(s) => out.push_str(&quoted(s)),
        JsonValue::Timestamp(t) => out.push_str(&quoted(&t.to_string())),
        JsonValue::JsonArray(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_text(item, out);
            }
            out.push(']');
        }
        JsonValue::JsonObject(map) => {
            // a map has no order: by name, so the same value always reads the same
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&quoted(key));
                out.push(':');
                json_text(&map[key], out);
            }
            out.push('}');
        }
        other => out.push_str(&quoted(&format!("{other:?}"))),
    }
}

fn interval_ds(v: &OracleIntervalDS) -> String {
    let fraction = format!("{:09}", v.nanoseconds().unsigned_abs());
    let fraction = fraction.trim_end_matches('0');
    let negative =
        v.days() < 0 || v.hours() < 0 || v.minutes() < 0 || v.seconds() < 0 || v.nanoseconds() < 0;
    format!(
        "{}{} {:02}:{:02}:{:02}{}{}",
        if negative { "-" } else { "+" },
        v.days().unsigned_abs(),
        v.hours().unsigned_abs(),
        v.minutes().unsigned_abs(),
        v.seconds().unsigned_abs(),
        if fraction.is_empty() { "" } else { "." },
        fraction
    )
}

/// One value of a row. What cannot be read says so in the cell, the row goes on.
fn cell(row: &Row, i: usize, column: &Column) -> Cell {
    fn or_unreadable<T>(
        r: Result<Option<T>, oracledb::Error>,
        type_name: &str,
        f: impl FnOnce(T) -> Cell,
    ) -> Cell {
        match r {
            Ok(None) => Cell::Null,
            Ok(Some(v)) => f(v),
            Err(_) => Cell::Unreadable(type_name.to_owned()),
        }
    }
    let t = column.type_name.as_str();
    let upper = t.to_uppercase();
    match column.kind {
        ColKind::Int => or_unreadable(row.get::<Option<OracleNumber>>(i), t, |n| {
            let text = n.to_string();
            text.parse::<i64>().map_or(Cell::Decimal(text), Cell::I64)
        }),
        ColKind::Decimal => or_unreadable(row.get::<Option<OracleNumber>>(i), t, |n| {
            Cell::Decimal(n.to_string())
        }),
        ColKind::Float => or_unreadable(row.get::<Option<f64>>(i), t, Cell::F64),
        ColKind::Bool => or_unreadable(row.get::<Option<bool>>(i), t, Cell::Bool),
        ColKind::Timestamp => or_unreadable(row.get::<Option<OracleTimestamp>>(i), t, |v| {
            instant(&v).map_or_else(|| Cell::Text(v.to_string()), Cell::Ts)
        }),
        // the driver hands an instant over in UTC: the zone it was stored with is not in the value
        ColKind::TimestampTz => {
            or_unreadable(row.get::<Option<OracleTimestamp>>(i), t, |v| {
                match (instant(&v), FixedOffset::east_opt(0)) {
                    (Some(at), Some(utc)) => Cell::TsTz(utc.from_utc_datetime(&at)),
                    _ => Cell::Text(v.to_string()),
                }
            })
        }
        ColKind::Json => or_unreadable(row.get::<Option<JsonValue>>(i), t, |v| {
            let mut out = String::new();
            json_text(&v, &mut out);
            Cell::Json(out)
        }),
        ColKind::Bytes => or_unreadable(row.get::<Option<Vec<u8>>>(i), t, |b| Cell::bytes(&b)),
        ColKind::Text => or_unreadable(row.get::<Option<String>>(i), t, |s| Cell::Text(text(&s))),
        _ if upper.starts_with("INTERVAL DAY") => {
            or_unreadable(row.get::<Option<OracleIntervalDS>>(i), t, |v| {
                Cell::Text(interval_ds(&v))
            })
        }
        _ if upper.starts_with("INTERVAL YEAR") => {
            or_unreadable(row.get::<Option<OracleIntervalYM>>(i), t, |v| {
                let negative = v.years() < 0 || v.months() < 0;
                Cell::Text(format!(
                    "{}{}-{}",
                    if negative { "-" } else { "+" },
                    v.years().unsigned_abs(),
                    v.months().unsigned_abs()
                ))
            })
        }
        // ROWID and whatever has a text form
        _ => or_unreadable(row.get::<Option<String>>(i), t, |s| Cell::Text(text(&s))),
    }
}

fn bad_value(what: &str, value: &str) -> AppError {
    AppError::new(
        ErrorCode::InvalidQuery,
        format!(
            "„{}“ is not {what}",
            value.chars().take(40).collect::<String>()
        ),
    )
}

/// `2026-11-12` or `2026-11-12 10:11:12[.5]` (also with a `T`).
fn timestamp(value: &str) -> AppResult<OracleTimestamp> {
    let v = value.trim().replace('T', " ");
    let bad = || bad_value("a date", value);
    if let Ok(day) = NaiveDate::parse_from_str(&v, "%Y-%m-%d") {
        return Ok(OracleTimestamp::from(
            day.and_hms_opt(0, 0, 0).ok_or_else(bad)?,
        ));
    }
    chrono::NaiveDateTime::parse_from_str(&v, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(&v, "%Y-%m-%d %H:%M"))
        .map(OracleTimestamp::from)
        .map_err(|_| bad())
}

/// A date or a date with time as the driver binds it, in one spelling (`2026-11-12 10:11:12[.5]`);
/// `None` when the text is none.
pub fn datetime_text(value: &str) -> Option<String> {
    timestamp(value)
        .ok()
        .map(|t| t.to_string().replace('T', " "))
        .map(|t| match t.split_once('.') {
            Some((whole, fraction)) => {
                let fraction = fraction.trim_end_matches('0');
                if fraction.is_empty() {
                    whole.to_owned()
                } else {
                    format!("{whole}.{fraction}")
                }
            }
            None => t,
        })
}

/// An instant as `TO_TIMESTAMP_TZ` reads it with the format `YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM`:
/// `2026-11-12 10:11:12.500000000 +02:00`. A text without a zone is taken as UTC; `None` when it is
/// no point in time.
pub fn instant_text(value: &str) -> Option<String> {
    let v = value.trim().replace('T', " ");
    let v = match v.strip_suffix('Z') {
        Some(utc) => format!("{utc}+00:00"),
        None => v,
    };
    let zoned = [
        "%Y-%m-%d %H:%M:%S%.f%:z",
        "%Y-%m-%d %H:%M:%S%.f %:z",
        "%Y-%m-%d %H:%M%:z",
    ]
    .iter()
    .find_map(|f| chrono::DateTime::parse_from_str(&v, f).ok());
    let at = match zoned {
        Some(at) => at,
        None => {
            let naive = timestamp(&v).ok().and_then(|t| instant(&t))?;
            FixedOffset::east_opt(0)?.from_utc_datetime(&naive)
        }
    };
    Some(at.format("%Y-%m-%d %H:%M:%S%.9f %:z").to_string())
}

/// The values of a statement as the driver binds them.
fn binds(params: &[Bind]) -> AppResult<Vec<Box<dyn ToDbValue>>> {
    params
        .iter()
        .map(|p| {
            Ok(match p {
                Bind::Text(v) => Box::new(v.clone()) as Box<dyn ToDbValue>,
                Bind::Int(v) => Box::new(Bind::int(v)?),
                Bind::Decimal(v) => Box::new(
                    OracleNumber::from_str(v.trim()).map_err(|_| bad_value("a number", v))?,
                ),
                // 1 and 0: a BOOLEAN column takes them (23ai), and so does the NUMBER(1) used before
                Bind::Bool(v) => Box::new(i64::from(*v)),
                Bind::Date(v) | Bind::Datetime(v) => Box::new(timestamp(v)?),
            })
        })
        .collect()
}

struct Worker<'a> {
    conn: Connection,
    on: &'a str,
    /// A transaction was opened on purpose: nothing is committed until it is ended.
    manual: bool,
}

impl Worker<'_> {
    fn run(
        &mut self,
        sql: &str,
        params: &[Bind],
        plain: bool,
        events: &SyncSender<Event>,
        enough: &AtomicBool,
    ) -> AppResult<Ended> {
        let sql = for_server(sql);
        if sql.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
        }
        if sql.len() > MAX_SQL_LEN {
            return Err(AppError::new(ErrorCode::InvalidQuery, "statement too long"));
        }
        let on = self.on;
        let fail = |e: oracledb::Error| ora_error(on, Some(sql), &e);
        let head = head(sql);
        let first = head.split(' ').next().unwrap_or_default();
        let values = binds(params)?;
        let refs: Vec<&dyn ToDbValue> = values.iter().map(AsRef::as_ref).collect();
        let mut statement = self
            .conn
            .statement(sql)
            .map_err(fail)?
            .fetch_array_size(200)
            .build()
            .map_err(fail)?;
        if !statement.is_query() {
            let done = statement.execute(&refs).map_err(fail)?;
            if enough.load(Ordering::Relaxed) {
                // the session gave up on this statement (stopped, out of time) and told its user so:
                // what it changed must not be kept behind their back (review 035b 1)
                let _ = self.conn.rollback();
                return Err(super::cancelled());
            }
            let second = head.split(' ').nth(1).unwrap_or_default();
            if head.starts_with("SET TRANSACTION") {
                self.manual = true;
            } else if first == "COMMIT" || (first == "ROLLBACK" && second != "TO") {
                self.manual = false;
            } else if statement.is_ddl() {
                // the server commits with every DDL statement: the transaction that was opened is over
                self.manual = false;
            } else if !self.manual {
                // no auto-commit on the server: what ran is kept, as in the other databases
                self.conn.commit().map_err(fail)?;
            }
            // only statements that change rows have a number worth telling
            let counts = statement.is_dml() || matches!(first, "MERGE");
            return Ok(Ended {
                columns: Vec::new(),
                rows: 0,
                truncated: false,
                rows_affected: counts.then(|| done.rows_affected()),
            });
        }
        let cursor = statement.query(&refs).map_err(fail)?;
        let columns = columns(cursor.columns());
        if events.send(Event::Start(columns.clone())).is_err() {
            return Err(super::cancelled());
        }
        let mut rows = 0u64;
        let mut truncated = false;
        for row in cursor {
            let row = row.map_err(fail)?;
            if enough.load(Ordering::Relaxed) {
                truncated = true;
                break;
            }
            let cells = columns
                .iter()
                .enumerate()
                .map(|(i, column)| {
                    let cell = cell(&row, i, column);
                    if plain {
                        cell.plain().map_or(Cell::Null, Cell::Text)
                    } else {
                        cell
                    }
                })
                .collect();
            rows += 1;
            if events.send(Event::Row(cells)).is_err() {
                // nobody listens any more: the statement was left behind
                return Err(super::cancelled());
            }
        }
        Ok(Ended {
            columns,
            rows,
            truncated,
            rows_affected: None,
        })
    }
}

fn worker(conn: Connection, inbox: &Receiver<Job>, on: &str) {
    let mut worker = Worker {
        conn,
        on,
        manual: false,
    };
    while let Ok(Job::Run {
        sql,
        params,
        plain,
        events,
        enough,
    }) = inbox.recv()
    {
        let ended = worker.run(&sql, &params, plain, &events, &enough);
        let lost = ended
            .as_ref()
            .is_err_and(|e| e.code == ErrorCode::ConnectionFailed);
        // a session that was left behind does not hear this, and its connection goes with the thread
        if events.send(Event::Done(ended)).is_err() || lost {
            break;
        }
    }
    // an open transaction is rolled back by the server when the connection closes
}

// --- the session ------------------------------------------------------------------------------------

impl Ora {
    /// Asks the server to end this session, over a second connection: the statement that was left
    /// behind stops there. Needs the right to do so; without it the statement runs to its end.
    fn kill(&self) {
        let config = self.config.clone();
        let (sid, serial) = (self.sid, self.serial);
        if let Some(tunnel) = &self.tunnel {
            tunnel.permit();
        }
        let _ = std::thread::Builder::new()
            .name("sc-oracle-kill".into())
            .spawn(move || {
                if let Ok(side) = oracledb::connect(config) {
                    // both are numbers the server gave us
                    let _ = side.execute(
                        &format!("ALTER SYSTEM KILL SESSION '{sid},{serial}' IMMEDIATE"),
                        &[],
                    );
                }
            });
    }

    fn run(
        &mut self,
        sql: &str,
        params: &[Bind],
        plain: bool,
        limits: Limits,
        sink: &mut dyn RowSink,
        stop: Stop,
    ) -> AppResult<Outcome> {
        let started = Instant::now();
        let jobs = self.jobs.as_ref().ok_or_else(closed)?;
        let (events, inbox) = sync_channel(QUEUE);
        let enough = Arc::new(AtomicBool::new(false));
        let job = Job::Run {
            sql: sql.to_owned(),
            params: params.to_vec(),
            plain,
            events,
            enough: Arc::clone(&enough),
        };
        if jobs.send(job).is_err() {
            self.jobs = None;
            return Err(closed());
        }
        let ended = loop {
            match inbox.recv_timeout(Duration::from_millis(50)) {
                Ok(Event::Start(columns)) => sink.start(&columns),
                Ok(Event::Row(cells)) => {
                    if !enough.load(Ordering::Relaxed) && !sink.row(cells) {
                        enough.store(true, Ordering::Relaxed);
                    }
                }
                Ok(Event::Done(ended)) => break ended,
                Err(RecvTimeoutError::Disconnected) => {
                    self.jobs = None;
                    return Err(closed());
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            let late = limits.timeout.is_some_and(|t| started.elapsed() >= t);
            if late || stop() {
                // the driver cannot interrupt its call: the statement is left behind with its
                // connection, and the server is asked to end that session
                enough.store(true, Ordering::Relaxed);
                self.kill();
                let until = Instant::now() + CANCEL_GRACE;
                while Instant::now() < until {
                    if let Ok(Event::Done(_)) | Err(RecvTimeoutError::Disconnected) =
                        inbox.recv_timeout(Duration::from_millis(50))
                    {
                        break;
                    }
                }
                self.jobs = None;
                return Err(if late {
                    AppError::new(ErrorCode::Timeout, "the statement took too long")
                } else {
                    super::cancelled()
                });
            }
        };
        match ended {
            Ok(ended) => Ok(Outcome {
                columns: ended.columns,
                rows: ended.rows,
                truncated: ended.truncated || enough.load(Ordering::Relaxed),
                rows_affected: ended.rows_affected,
                elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            }),
            Err(e) => {
                if e.code == ErrorCode::ConnectionFailed {
                    self.jobs = None;
                }
                Err(e)
            }
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

impl Session for Ora {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        let params: Vec<Bind> = params.iter().map(|p| Bind::Text((*p).to_owned())).collect();
        let mut sink = TextSink(Vec::new());
        let limits = Limits {
            max_rows: usize::MAX,
            timeout,
        };
        self.run(sql, &params, true, limits, &mut sink, stop)?;
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
        self.run(sql, params, false, limits, sink, stop)
    }

    fn via_tunnel(&mut self, tunnel: Arc<crate::ssh::Tunnel>) {
        self.tunnel = Some(tunnel);
    }

    fn transaction_state(&mut self, stop: Stop) -> TxState {
        match self.ask(
            "SELECT dbms_transaction.local_transaction_id FROM dual",
            &[],
            Some(Duration::from_secs(5)),
            stop,
        ) {
            Ok(rows) => match rows.first().and_then(|r| r.first()) {
                Some(Some(_)) => TxState::Active,
                Some(None) => TxState::Idle,
                None => TxState::Unknown,
            },
            Err(_) => TxState::Unknown,
        }
    }

    fn server_version(&mut self, stop: Stop) -> AppResult<String> {
        let banner = self
            .ask(
                "SELECT banner FROM v$version WHERE ROWNUM = 1",
                &[],
                Some(Duration::from_secs(5)),
                stop,
            )
            .ok()
            .and_then(|rows| rows.into_iter().next()?.into_iter().next()?);
        Ok(match banner {
            Some(banner) => format!("{} ({})", banner.trim(), self.version),
            None => format!("Oracle Database {}", self.version),
        })
    }

    fn is_open(&self) -> bool {
        self.jobs.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_statement_loses_the_separator_of_a_script_but_plsql_keeps_its_semicolon() {
        assert_eq!(for_server("select 1 from dual;"), "select 1 from dual");
        assert_eq!(
            for_server("  select 1 from dual ; ;\n"),
            "select 1 from dual"
        );
        assert_eq!(for_server("begin null; end;"), "begin null; end;");
        assert_eq!(for_server("begin null; end;\n/"), "begin null; end;");
        assert_eq!(
            for_server("DECLARE x int; BEGIN x := 1; END;\n/\n"),
            "DECLARE x int; BEGIN x := 1; END;"
        );
        assert_eq!(
            for_server("-- a comment\ncreate or replace procedure p as begin null; end;"),
            "-- a comment\ncreate or replace procedure p as begin null; end;"
        );
        assert_eq!(
            for_server("create or replace editionable package body p as end;"),
            "create or replace editionable package body p as end;"
        );
        assert_eq!(
            for_server("select 1 from dual; -- a note\n/* and more */"),
            "select 1 from dual"
        );
        assert_eq!(
            for_server("select ';' from dual -- no; end"),
            "select ';' from dual -- no; end"
        );
        // a division is no end of a block
        assert_eq!(
            for_server("select 4 / 2 from dual"),
            "select 4 / 2 from dual"
        );
        assert_eq!(
            for_server("create table t (id number);"),
            "create table t (id number)"
        );
        assert_eq!(
            for_server("create view v as select 1 x from dual;"),
            "create view v as select 1 x from dual"
        );
    }

    #[test]
    fn reads_the_first_words_behind_comments() {
        assert_eq!(
            head("  /* x */ -- y\n  set   transaction read write"),
            "SET TRANSACTION READ WRITE"
        );
        assert_eq!(head("commit"), "COMMIT");
        assert_eq!(head(""), "");
        assert_eq!(head("/* never closed"), "");
    }

    #[test]
    fn reads_the_name_a_message_quotes() {
        assert_eq!(
            named("ORA-00904: \"NME\": invalid identifier").as_deref(),
            Some("NME")
        );
        assert_eq!(
            named("ORA-00942: table or view \"SHOP\".\"NOSUCH\" does not exist").as_deref(),
            Some("NOSUCH")
        );
        assert_eq!(named("ORA-01476: divisor is equal to zero"), None);
        assert_eq!(named("ORA-00904: \"never closed"), None);
    }

    #[test]
    fn reads_where_a_plsql_block_failed() {
        let m = "ORA-06550: line 2, column 3:\nPLS-00201: identifier 'X' must be declared";
        assert_eq!(plsql_place(m), Some((2, 3)));
        assert_eq!(plsql_place("ORA-00942: table or view does not exist"), None);
        assert_eq!(first_line(m), "line 2, column 3:");
        assert_eq!(first_line("no code here"), "no code here");
    }

    #[test]
    fn reads_dates_for_binding() {
        assert_eq!(
            timestamp("2026-11-12").unwrap().to_string(),
            "2026-11-12T00:00:00.000000000"
        );
        assert_eq!(
            timestamp("2026-11-12 10:11:12.5").unwrap().to_string(),
            "2026-11-12T10:11:12.500000000"
        );
        assert_eq!(
            timestamp("2026-11-12T10:11").unwrap().to_string(),
            "2026-11-12T10:11:00.000000000"
        );
        assert!(timestamp("tomorrow").is_err());
        assert!(timestamp("2026-13-40").is_err());
    }

    #[test]
    fn an_instant_is_spelled_for_the_format_of_ours() {
        assert_eq!(
            instant_text("2026-11-12 10:11:12+00:00").as_deref(),
            Some("2026-11-12 10:11:12.000000000 +00:00")
        );
        assert_eq!(
            instant_text("2026-11-12T10:11:12.5+02:00").as_deref(),
            Some("2026-11-12 10:11:12.500000000 +02:00")
        );
        assert_eq!(
            instant_text("2026-11-12 10:11:12Z").as_deref(),
            Some("2026-11-12 10:11:12.000000000 +00:00")
        );
        // without a zone: UTC, as the grid shows it
        assert_eq!(
            instant_text("2026-11-12").as_deref(),
            Some("2026-11-12 00:00:00.000000000 +00:00")
        );
        assert_eq!(instant_text("soon"), None);
    }

    #[test]
    fn values_are_bound_as_what_they_are() {
        assert_eq!(
            binds(&[
                Bind::Int("7".into()),
                Bind::Decimal("12.50".into()),
                Bind::Bool(true)
            ])
            .unwrap()
            .len(),
            3
        );
        assert!(binds(&[Bind::Int("7.5".into())]).is_err());
        assert!(binds(&[Bind::Decimal("1; drop".into())]).is_err());
        assert!(binds(&[Bind::Date("x".into())]).is_err());
    }

    #[test]
    fn json_is_written_without_touching_a_digit() {
        let mut out = String::new();
        json_text(
            &JsonValue::JsonArray(vec![
                JsonValue::Number(
                    OracleNumber::from_str("12345678901234567890.123456789").unwrap(),
                ),
                JsonValue::String("a \"b\"\n".into()),
                JsonValue::Null,
                JsonValue::Boolean(true),
            ]),
            &mut out,
        );
        assert_eq!(
            out,
            "[12345678901234567890.123456789,\"a \\\"b\\\"\\n\",null,true]"
        );
    }

    #[test]
    fn a_profile_without_a_service_or_with_unchecked_tls_is_refused() {
        let mut p = super::super::sqlite::demo_profile();
        p.kind = super::super::DbKind::Oracle;
        p.host = "db.example".into();
        p.database = String::new();
        assert_eq!(
            config(&p, None).err().map(|e| e.code),
            Some(ErrorCode::InvalidQuery)
        );
        p.database = "FREEPDB1".into();
        assert!(config(&p, None).is_ok());
        p.tls = TlsMode::Require;
        assert_eq!(
            config(&p, None).err().map(|e| e.code),
            Some(ErrorCode::Unsupported)
        );
        p.tls = TlsMode::Verify;
        assert!(config(&p, None).is_ok());
    }
}
