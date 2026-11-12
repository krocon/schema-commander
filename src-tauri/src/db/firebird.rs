//! Firebird over its wire protocol (prompt 035i), with `firebird-wire` – pure Rust, no client library.
//!
//! Firebird runs nothing outside of a transaction, and the client holds it. So the driver does: without
//! one of the user's, every statement gets a transaction of its own that is committed when it worked and
//! rolled back when it did not. `SET TRANSACTION`, `COMMIT` and `ROLLBACK` are the driver's to carry out
//! (they are no statements a server prepares): they open and end the transaction the session then keeps.
//!
//! A value is bound as what its place in the statement is (the server says so when it prepares): a text
//! that is to be a number, a date or a `NUMERIC(10,2)` is read here, exactly, or refused.
//!
//! A statement is stopped from a second connection, by deleting it from `MON$STATEMENTS`; the session
//! goes on.

use super::secrets::Secret;
use super::value::{Cell, ColKind, Column, Outcome, RowSink, text};
use super::{Bind, Limits, Profile, Session, Stop, TlsMode, TxState, clean};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use chrono::{Duration as Days, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use firebird_wire::{
    ColumnMeta, ConnectConfig, Connection, Error, Statement, Transaction, TransactionBuilder,
    Value, WireCrypt,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Longest statement accepted (bytes).
pub const MAX_SQL_LEN: usize = 10 * 1024 * 1024;
/// A BLOB is read whole up to this size; a bigger one is named, not read.
const MAX_BLOB: usize = 64 * 1024 * 1024;

// The types of the wire, without the bit that says „may be NULL“.
const SQL_VARYING: i32 = 448;
const SQL_TEXT: i32 = 452;
const SQL_DOUBLE: i32 = 480;
const SQL_FLOAT: i32 = 482;
const SQL_LONG: i32 = 496;
const SQL_SHORT: i32 = 500;
const SQL_TIMESTAMP: i32 = 510;
const SQL_BLOB: i32 = 520;
const SQL_ARRAY: i32 = 540;
const SQL_TIME: i32 = 560;
const SQL_DATE: i32 = 570;
const SQL_INT64: i32 = 580;
const SQL_INT128: i32 = 32752;
const SQL_TIMESTAMP_TZ: i32 = 32754;
const SQL_TIME_TZ: i32 = 32756;
const SQL_DEC16: i32 = 32760;
const SQL_DEC34: i32 = 32762;
const SQL_BOOLEAN: i32 = 32764;

pub struct Fire {
    conn: Connection,
    /// The transaction of the user (`SET TRANSACTION` … `COMMIT`); `None` = every statement has its own.
    tx: Option<Transaction>,
    /// Every transaction of this session is read only on the server.
    read_only: bool,
    /// To open a second connection with, when a statement is to be stopped.
    config: ConnectConfig,
    /// What the server calls this connection.
    attachment: i64,
    version: String,
    on: String,
    tunnel: Option<Arc<crate::ssh::Tunnel>>,
    broken: bool,
}

/// What the server said, with the place if it names one (`… line 2, column 7 …`).
fn failed(e: &Error, on: &str, sql: &str) -> AppError {
    match e {
        Error::Database(d) => {
            let gds = d.gds_code();
            let message = clean(&d.to_string());
            // without the number the crate puts behind it
            let said = message
                .rsplit_once(" (gds ")
                .map_or(message.as_str(), |(before, _)| before)
                .to_owned();
            let lower = said.to_lowercase();
            let code = match gds {
                // isc_login, isc_login_error
                Some(335_544_472 | 335_545_106) => ErrorCode::AuthFailed,
                // isc_io_error, isc_unavailable: no such database (file) on the server
                Some(335_544_344 | 335_544_375) => ErrorCode::NotFound,
                // isc_no_priv, isc_read_only_trans, isc_read_only_database
                Some(335_544_352 | 335_544_361 | 335_544_765) => ErrorCode::PermissionDenied,
                // isc_cancelled
                Some(335_544_794) => ErrorCode::Cancelled,
                _ if lower.contains("no permission") => ErrorCode::PermissionDenied,
                _ if lower.contains("operation was cancelled") => ErrorCode::Cancelled,
                _ => ErrorCode::InvalidQuery,
            };
            if code == ErrorCode::AuthFailed {
                return AppError::new(code, "login failed");
            }
            let after = |mark: &str| -> Option<u32> {
                let rest = lower.split(mark).nth(1)?;
                let digits: String = rest
                    .trim_start()
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect();
                digits.parse().ok()
            };
            let line = after("line ");
            // line and column of the server → characters from the start of the statement
            let position = match (line, after("column ")) {
                (Some(line), Some(column)) if line >= 1 && column >= 1 => {
                    let before: usize = sql
                        .split('\n')
                        .take(line as usize - 1)
                        .map(|l| l.chars().count() + 1)
                        .sum();
                    u32::try_from(before).ok().map(|b| b + column)
                }
                _ => None,
            };
            AppError::new(code, said).with(ErrorDetails {
                sqlstate: match (d.sql_state.as_deref(), gds, d.gds_symbol()) {
                    (Some(state), _, _) => Some(state.to_owned()),
                    (None, Some(n), Some(name)) => Some(format!("{n} {name}")),
                    (None, Some(n), None) => Some(n.to_string()),
                    (None, None, _) => None,
                },
                position,
                line,
                ..Default::default()
            })
        }
        Error::Auth(_) => AppError::new(ErrorCode::AuthFailed, "login failed"),
        Error::Timeout => AppError::new(ErrorCode::Timeout, format!("{on}: no answer in time")),
        Error::Conversion(m) | Error::Unsupported(m) => {
            AppError::new(ErrorCode::InvalidQuery, clean(m))
        }
        // a value that does not fit its place is the statement's matter, not the wire's
        Error::Protocol(m) if m.contains("does not fit parameter") => {
            AppError::new(ErrorCode::InvalidQuery, clean(m))
        }
        other => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: {}", clean(&other.to_string())),
        ),
    }
}

/// Whether the connection is still what it was after this error.
fn breaks(e: &Error) -> bool {
    matches!(e, Error::Io(_) | Error::Closed | Error::Timeout)
        || matches!(e, Error::Protocol(m) if !m.contains("does not fit parameter"))
}

fn config(profile: &Profile, secret: Option<&Secret>) -> AppResult<ConnectConfig> {
    let database = profile.database.trim();
    if database.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "Firebird needs the database: its path on the server, or an alias",
        ));
    }
    // Firebird has no TLS and no certificates: it encrypts its wire itself, with a key from the login
    let crypt = match profile.tls {
        TlsMode::Off | TlsMode::Prefer => WireCrypt::Enabled,
        TlsMode::Require => WireCrypt::Required,
        TlsMode::VerifyCa | TlsMode::Verify => {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                "Firebird has no certificates to check: choose „required“ (its own encryption) or none",
            ));
        }
    };
    Ok(ConnectConfig::new()
        .host(profile.host.trim())
        .port(profile.port_or_default())
        .database(database)
        .user(profile.user.trim())
        .password(secret.map(Secret::expose).unwrap_or_default())
        .charset("UTF8")
        .wire_crypt(crypt)
        .connect_timeout(super::CONNECT_TIMEOUT))
}

pub fn connect(profile: &Profile, secret: Option<&Secret>, stop: Stop) -> AppResult<Fire> {
    let config = config(profile, secret)?;
    let on = profile.where_label();
    let conn = Connection::connect(&config).map_err(|e| failed(&e, &on, ""))?;
    let mut fire = Fire {
        conn,
        tx: None,
        read_only: false,
        config,
        attachment: 0,
        version: String::new(),
        on,
        tunnel: None,
        broken: false,
    };
    let rows = fire.ask(
        "SELECT rdb$get_context('SYSTEM', 'ENGINE_VERSION'), CAST(current_connection AS VARCHAR(20)) \
         FROM rdb$database",
        &[],
        Some(super::CONNECT_TIMEOUT),
        stop,
    )?;
    if let Some(row) = rows.into_iter().next() {
        let mut cells = row.into_iter();
        fire.version = cells.next().flatten().unwrap_or_default();
        fire.attachment = cells
            .next()
            .flatten()
            .and_then(|t| t.trim().parse().ok())
            .unwrap_or(0);
    }
    Ok(fire)
}

// --- the catalog ---------------------------------------------------------------------------------------

/// The declared type of a field `f` of `rdb$fields`, as one would write it.
pub(super) const TYPE: &str = "TRIM(CASE f.rdb$field_type \
  WHEN 7 THEN CASE WHEN COALESCE(f.rdb$field_sub_type, 0) IN (1, 2) OR f.rdb$field_scale < 0 \
    THEN TRIM(IIF(f.rdb$field_sub_type = 2, 'DECIMAL', 'NUMERIC')) || '(' || COALESCE(f.rdb$field_precision, 4) || ', ' || (-f.rdb$field_scale) || ')' ELSE 'SMALLINT' END \
  WHEN 8 THEN CASE WHEN COALESCE(f.rdb$field_sub_type, 0) IN (1, 2) OR f.rdb$field_scale < 0 \
    THEN TRIM(IIF(f.rdb$field_sub_type = 2, 'DECIMAL', 'NUMERIC')) || '(' || COALESCE(f.rdb$field_precision, 9) || ', ' || (-f.rdb$field_scale) || ')' ELSE 'INTEGER' END \
  WHEN 16 THEN CASE WHEN COALESCE(f.rdb$field_sub_type, 0) IN (1, 2) OR f.rdb$field_scale < 0 \
    THEN TRIM(IIF(f.rdb$field_sub_type = 2, 'DECIMAL', 'NUMERIC')) || '(' || COALESCE(f.rdb$field_precision, 18) || ', ' || (-f.rdb$field_scale) || ')' ELSE 'BIGINT' END \
  WHEN 26 THEN CASE WHEN COALESCE(f.rdb$field_sub_type, 0) IN (1, 2) OR f.rdb$field_scale < 0 \
    THEN TRIM(IIF(f.rdb$field_sub_type = 2, 'DECIMAL', 'NUMERIC')) || '(' || COALESCE(f.rdb$field_precision, 38) || ', ' || (-f.rdb$field_scale) || ')' ELSE 'INT128' END \
  WHEN 10 THEN 'FLOAT' WHEN 27 THEN 'DOUBLE PRECISION' WHEN 12 THEN 'DATE' WHEN 13 THEN 'TIME' \
  WHEN 35 THEN 'TIMESTAMP' WHEN 28 THEN 'TIME WITH TIME ZONE' WHEN 29 THEN 'TIMESTAMP WITH TIME ZONE' \
  WHEN 23 THEN 'BOOLEAN' WHEN 24 THEN 'DECFLOAT(16)' WHEN 25 THEN 'DECFLOAT(34)' \
  WHEN 14 THEN TRIM(IIF(f.rdb$character_set_id = 1, 'BINARY', 'CHAR')) || '(' || COALESCE(f.rdb$character_length, f.rdb$field_length) || ')' \
  WHEN 37 THEN TRIM(IIF(f.rdb$character_set_id = 1, 'VARBINARY', 'VARCHAR')) || '(' || COALESCE(f.rdb$character_length, f.rdb$field_length) || ')' \
  WHEN 261 THEN TRIM(IIF(f.rdb$field_sub_type = 1, 'BLOB SUB_TYPE TEXT', 'BLOB')) \
  ELSE 'TYPE ' || f.rdb$field_type END)";

/// A database of Firebird has one namespace: the app asks with an empty schema, and every question
/// takes it as its first value – bound, and true.
pub(super) const NO_SCHEMA: &str = "CAST(? AS VARCHAR(63)) = ''";

/// Tables and views that are the user's (`r` of `rdb$relations`).
pub(super) const OWN: &str = "COALESCE(r.rdb$system_flag, 0) = 0";

/// Whether column `rf` is part of a key of the given sort of its table.
pub(super) fn in_key(sort: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM rdb$relation_constraints rc \
           JOIN rdb$index_segments sg ON sg.rdb$index_name = rc.rdb$index_name \
           WHERE rc.rdb$relation_name = rf.rdb$relation_name AND rc.rdb$constraint_type = '{sort}' \
             AND sg.rdb$field_name = rf.rdb$field_name)"
    )
}

/// Rows `name, '', table, column, '', referenced table, referenced column` of the foreign keys, one per
/// pair of columns; the caller adds what limits them.
pub(super) const FOREIGN_KEYS: &str = "SELECT rc.rdb$constraint_name, '', rc.rdb$relation_name, cs.rdb$field_name, \
       '', pk.rdb$relation_name, ps.rdb$field_name \
     FROM rdb$relation_constraints rc \
     JOIN rdb$ref_constraints ref ON ref.rdb$constraint_name = rc.rdb$constraint_name \
     JOIN rdb$relation_constraints pk ON pk.rdb$constraint_name = ref.rdb$const_name_uq \
     JOIN rdb$index_segments cs ON cs.rdb$index_name = rc.rdb$index_name \
     JOIN rdb$index_segments ps ON ps.rdb$index_name = pk.rdb$index_name \
       AND ps.rdb$field_position = cs.rdb$field_position \
     WHERE rc.rdb$constraint_type = 'FOREIGN KEY'";

// --- types and values ---------------------------------------------------------------------------------

fn base(meta: &ColumnMeta) -> i32 {
    meta.sql_type & !1
}

/// A whole number with a scale is a `NUMERIC`: its digits with the point where it belongs.
fn scaled(mantissa: i128, scale: i32) -> String {
    if scale >= 0 {
        return format!("{mantissa}{}", "0".repeat(scale as usize));
    }
    let places = scale.unsigned_abs() as usize;
    let digits = mantissa.unsigned_abs().to_string();
    let digits = format!("{digits:0>width$}", width = places + 1);
    let (whole, fraction) = digits.split_at(digits.len() - places);
    format!("{}{whole}.{fraction}", if mantissa < 0 { "-" } else { "" })
}

/// A number as text → the whole number a `NUMERIC` of this scale stores; `None` when it is none, or
/// has more places than the column keeps.
fn unscaled(text: &str, scale: i32) -> Option<i128> {
    let t = text.trim();
    let (negative, digits) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    if (whole.is_empty() && fraction.is_empty())
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let places = usize::try_from(-scale).ok()?;
    // zeros at the end are no places
    let fraction = fraction.trim_end_matches('0');
    if fraction.len() > places {
        return None;
    }
    let all = format!("{whole}{fraction:0<places$}");
    let n: i128 = all.parse().ok()?;
    Some(if negative { -n } else { n })
}

fn epoch() -> NaiveDate {
    NaiveDate::from_ymd_opt(1858, 11, 17).expect("the day Firebird counts from")
}

fn date_of(days: i32) -> Option<NaiveDate> {
    epoch().checked_add_signed(Days::days(i64::from(days)))
}

/// Time of day in units of 1/10000 s.
fn time_of(units: u32) -> Option<NaiveTime> {
    NaiveTime::from_num_seconds_from_midnight_opt(units / 10_000, (units % 10_000) * 100_000)
}

fn days_of(date: NaiveDate) -> i32 {
    i32::try_from((date - epoch()).num_days()).unwrap_or(0)
}

fn units_of(time: NaiveTime) -> u32 {
    use chrono::Timelike;
    time.num_seconds_from_midnight() * 10_000 + time.nanosecond() / 100_000
}

fn kind_of(meta: &ColumnMeta) -> ColKind {
    match base(meta) {
        SQL_SHORT | SQL_LONG | SQL_INT64 | SQL_INT128 if meta.scale < 0 => ColKind::Decimal,
        SQL_SHORT | SQL_LONG | SQL_INT64 => ColKind::Int,
        SQL_INT128 | SQL_DEC16 | SQL_DEC34 => ColKind::Decimal,
        SQL_FLOAT | SQL_DOUBLE => ColKind::Float,
        // sub type 1: OCTETS – bytes, not text
        SQL_TEXT | SQL_VARYING if meta.sub_type == 1 => ColKind::Bytes,
        SQL_TEXT | SQL_VARYING => ColKind::Text,
        SQL_BLOB if meta.sub_type == 1 => ColKind::Text,
        SQL_BLOB => ColKind::Bytes,
        SQL_DATE => ColKind::Date,
        SQL_TIME => ColKind::Time,
        SQL_TIMESTAMP => ColKind::Timestamp,
        SQL_TIMESTAMP_TZ => ColKind::TimestampTz,
        SQL_BOOLEAN => ColKind::Bool,
        _ => ColKind::Other,
    }
}

/// The type as one would declare it.
fn type_name(meta: &ColumnMeta) -> String {
    let numeric = |digits: u32| format!("NUMERIC({digits}, {})", -meta.scale);
    match base(meta) {
        SQL_SHORT if meta.scale < 0 => numeric(4),
        SQL_LONG if meta.scale < 0 => numeric(9),
        SQL_INT64 if meta.scale < 0 => numeric(18),
        SQL_INT128 if meta.scale < 0 => numeric(38),
        SQL_SHORT => "SMALLINT".into(),
        SQL_LONG => "INTEGER".into(),
        SQL_INT64 => "BIGINT".into(),
        SQL_INT128 => "INT128".into(),
        SQL_FLOAT => "FLOAT".into(),
        SQL_DOUBLE => "DOUBLE PRECISION".into(),
        SQL_DEC16 => "DECFLOAT(16)".into(),
        SQL_DEC34 => "DECFLOAT(34)".into(),
        // the length is in bytes; UTF8 takes four for a character
        SQL_TEXT | SQL_VARYING => {
            let (word, octets) = if base(meta) == SQL_TEXT {
                ("CHAR", "BINARY")
            } else {
                ("VARCHAR", "VARBINARY")
            };
            if meta.sub_type == 1 {
                format!("{octets}({})", meta.length)
            } else {
                format!("{word}({})", (meta.length / 4).max(1))
            }
        }
        SQL_BLOB if meta.sub_type == 1 => "BLOB SUB_TYPE TEXT".into(),
        SQL_BLOB => "BLOB".into(),
        SQL_ARRAY => "ARRAY".into(),
        SQL_DATE => "DATE".into(),
        SQL_TIME => "TIME".into(),
        SQL_TIMESTAMP => "TIMESTAMP".into(),
        SQL_TIME_TZ => "TIME WITH TIME ZONE".into(),
        SQL_TIMESTAMP_TZ => "TIMESTAMP WITH TIME ZONE".into(),
        SQL_BOOLEAN => "BOOLEAN".into(),
        other => format!("TYPE {other}"),
    }
}

fn column(meta: &ColumnMeta) -> Column {
    Column {
        name: if meta.alias.is_empty() {
            meta.field.clone()
        } else {
            meta.alias.clone()
        },
        kind: kind_of(meta),
        type_name: type_name(meta),
    }
}

/// A value of a row; a BLOB is still its id here.
fn cell(v: Value, meta: &ColumnMeta) -> Cell {
    let unreadable = || Cell::Unreadable(type_name(meta));
    match v {
        Value::Null => Cell::Null,
        Value::Bool(b) => Cell::Bool(b),
        Value::Short(n) if meta.scale < 0 => Cell::Decimal(scaled(i128::from(n), meta.scale)),
        Value::Int(n) if meta.scale < 0 => Cell::Decimal(scaled(i128::from(n), meta.scale)),
        Value::BigInt(n) if meta.scale < 0 => Cell::Decimal(scaled(i128::from(n), meta.scale)),
        Value::Short(n) => Cell::I64(i64::from(n)),
        Value::Int(n) => Cell::I64(i64::from(n)),
        Value::BigInt(n) => Cell::I64(n),
        Value::Int128(n) => Cell::Decimal(scaled(n, meta.scale.min(0))),
        Value::Float(f) => Cell::F64(f64::from(f)),
        Value::Double(f) => Cell::F64(f),
        Value::Text(s) => Cell::Text(text(&s)),
        Value::Bytes(b) => Cell::bytes(&b),
        Value::Date(days) => date_of(days).map_or_else(unreadable, Cell::Date),
        Value::Time(units) => time_of(units).map_or_else(unreadable, Cell::Time),
        Value::Timestamp(days, units) => match (date_of(days), time_of(units)) {
            (Some(date), Some(time)) => Cell::Ts(date.and_time(time)),
            _ => unreadable(),
        },
        Value::TimestampTz(t) => {
            let instant = date_of(t.utc_date)
                .zip(time_of(t.utc_time))
                .map(|(date, time)| date.and_time(time));
            let zone = FixedOffset::east_opt(i32::from(t.offset) * 60);
            match (instant, zone) {
                (Some(utc), Some(zone)) => Cell::TsTz(zone.from_utc_datetime(&utc)),
                _ => unreadable(),
            }
        }
        // a time with a zone has no day to anchor it: as one would write it
        Value::TimeTz(t) => {
            let local = (i64::from(t.utc_time) + i64::from(t.offset) * 600_000)
                .rem_euclid(24 * 3600 * 10_000);
            match time_of(u32::try_from(local).unwrap_or(0)) {
                Some(time) => Cell::Text(format!("{time} {}", t.zone_label())),
                None => unreadable(),
            }
        }
        Value::DecFloat(d) => match d.to_parts() {
            Some((negative, coefficient, exponent)) => {
                let n = i128::try_from(coefficient).unwrap_or(i128::MAX);
                Cell::Decimal(scaled(if negative { -n } else { n }, exponent))
            }
            None if d.is_nan() => Cell::Text("NaN".into()),
            None if d.is_negative() => Cell::Text("-Infinity".into()),
            None => Cell::Text("Infinity".into()),
        },
        Value::Blob(_) | Value::Array(_) => unreadable(),
    }
}

fn not_a(what: &str, text: &str) -> AppError {
    AppError::new(
        ErrorCode::InvalidQuery,
        format!(
            "„{}“ is not a {what}",
            text.chars().take(40).collect::<String>()
        ),
    )
}

fn datetime(text: &str) -> Option<NaiveDateTime> {
    let t = text.trim().replace('T', " ");
    NaiveDateTime::parse_from_str(&t, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(&t, "%Y-%m-%d %H:%M"))
        .ok()
        .or_else(|| {
            NaiveDate::parse_from_str(&t, "%Y-%m-%d")
                .ok()
                .map(|d| d.and_time(NaiveTime::MIN))
        })
}

/// A value as what its place in the statement is. The text is read here – exactly, or not at all.
fn bound(raw: &str, meta: &ColumnMeta) -> AppResult<Value> {
    let t = raw.trim();
    let whole = |what: &str| -> AppResult<i128> {
        if meta.scale < 0 {
            unscaled(t, meta.scale).ok_or_else(|| {
                not_a(
                    &format!("number with at most {} decimal places", -meta.scale),
                    t,
                )
            })
        } else {
            t.parse::<i128>().map_err(|_| not_a(what, t))
        }
    };
    let fits = |what: &str| not_a(what, t);
    Ok(match base(meta) {
        SQL_SHORT => Value::Short(
            i16::try_from(whole("whole number")?).map_err(|_| fits("number this column holds"))?,
        ),
        SQL_LONG => Value::Int(
            i32::try_from(whole("whole number")?).map_err(|_| fits("number this column holds"))?,
        ),
        SQL_INT64 => Value::BigInt(
            i64::try_from(whole("whole number")?).map_err(|_| fits("number this column holds"))?,
        ),
        SQL_INT128 => Value::Int128(whole("whole number")?),
        SQL_FLOAT => Value::Float(Bind::float(t)? as f32),
        SQL_DOUBLE => Value::Double(Bind::float(t)?),
        SQL_BOOLEAN => match t.to_ascii_lowercase().as_str() {
            "true" | "t" | "1" | "yes" => Value::Bool(true),
            "false" | "f" | "0" | "no" => Value::Bool(false),
            _ => return Err(not_a("truth value", t)),
        },
        SQL_DATE => Value::Date(days_of(datetime(t).ok_or_else(|| not_a("date", t))?.date())),
        SQL_TIME => Value::Time(units_of(
            NaiveTime::parse_from_str(t, "%H:%M:%S%.f")
                .or_else(|_| NaiveTime::parse_from_str(t, "%H:%M"))
                .map_err(|_| not_a("time", t))?,
        )),
        SQL_TIMESTAMP => {
            let at = datetime(t).ok_or_else(|| not_a("date with a time", t))?;
            Value::Timestamp(days_of(at.date()), units_of(at.time()))
        }
        // a binary text column takes bytes; the app sends them as hex through a function of the server
        SQL_TEXT | SQL_VARYING if meta.sub_type == 1 => Value::Bytes(raw.as_bytes().to_vec()),
        // text as it is – also for a BLOB, a DECFLOAT and a time with a zone: the server reads those
        _ => Value::Text(raw.to_owned()),
    })
}

/// What a statement of the user does to the transaction of the session.
#[derive(Debug, PartialEq, Eq)]
enum Control {
    Begin { read_only: bool },
    Commit,
    Rollback,
    None,
}

/// `SET TRANSACTION …`, `COMMIT [WORK]`, `ROLLBACK [WORK]` – and nothing that only starts like them
/// (`ROLLBACK TO SAVEPOINT x` is a statement of the server).
fn control(sql: &str) -> Control {
    let words: Vec<String> = sql
        .trim()
        .trim_end_matches(';')
        .split_whitespace()
        .map(str::to_ascii_uppercase)
        .collect();
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["SET", "TRANSACTION", rest @ ..] => Control::Begin {
            read_only: rest.windows(2).any(|w| w == ["READ", "ONLY"]),
        },
        ["COMMIT"] | ["COMMIT", "WORK"] => Control::Commit,
        ["ROLLBACK"] | ["ROLLBACK", "WORK"] => Control::Rollback,
        _ => Control::None,
    }
}

/// What one statement gave.
struct Answer {
    columns: Vec<Column>,
    rows: u64,
    truncated: bool,
    changed: Option<u64>,
}

impl Fire {
    fn builder(&self, read_only: bool) -> TransactionBuilder {
        let b = TransactionBuilder::new();
        if read_only || self.read_only {
            b.read_only()
        } else {
            b
        }
    }

    fn begin(&mut self, read_only: bool) -> AppResult<Transaction> {
        let builder = self.builder(read_only);
        self.conn
            .begin_with(&builder)
            .map_err(|e| self.fail(&e, ""))
    }

    fn fail(&mut self, e: &Error, sql: &str) -> AppError {
        if breaks(e) {
            self.broken = true;
        }
        failed(e, &self.on, sql)
    }

    /// Prepares, binds and runs one statement in `tx`; its rows go into the sink.
    fn statement(
        &mut self,
        tx: &Transaction,
        sql: &str,
        values: &[&str],
        sink: &mut dyn RowSink,
        plain: bool,
    ) -> AppResult<Answer> {
        let mut st = self.conn.prepare(tx, sql).map_err(|e| self.fail(&e, sql))?;
        let result = self.run(&mut st, tx, sql, values, sink, plain);
        let _ = st.drop_statement(&mut self.conn);
        result
    }

    fn run(
        &mut self,
        st: &mut Statement,
        tx: &Transaction,
        sql: &str,
        values: &[&str],
        sink: &mut dyn RowSink,
        plain: bool,
    ) -> AppResult<Answer> {
        let places = st.params().to_vec();
        if places.len() != values.len() {
            return Err(AppError::new(
                ErrorCode::InvalidQuery,
                format!(
                    "the statement has {} placeholders, {} values were given",
                    places.len(),
                    values.len()
                ),
            ));
        }
        let mut params = Vec::with_capacity(values.len());
        for (raw, meta) in values.iter().zip(&places) {
            params.push(if base(meta) == SQL_BLOB {
                // a BLOB is written first, in the same transaction; its place takes the id
                let id = self
                    .conn
                    .write_blob(tx, raw.as_bytes())
                    .map_err(|e| self.fail(&e, sql))?;
                Value::Blob(id)
            } else {
                bound(raw, meta)?
            });
        }
        st.execute(&mut self.conn, tx, &params)
            .map_err(|e| self.fail(&e, sql))?;
        let metas = st.columns().to_vec();
        let columns: Vec<Column> = metas.iter().map(column).collect();
        let mut answer = Answer {
            columns,
            rows: 0,
            truncated: false,
            changed: None,
        };
        if metas.is_empty() {
            answer.changed = st
                .rows_affected(&mut self.conn)
                .ok()
                .map(|r| r.total_modified());
            return Ok(answer);
        }
        sink.start(&answer.columns);
        loop {
            let row = match st.fetch(&mut self.conn) {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(e) => return Err(self.fail(&e, sql)),
            };
            let mut cells = Vec::with_capacity(metas.len());
            for (value, meta) in row.into_values().into_iter().zip(&metas) {
                let c = match value {
                    // the content of a BLOB is fetched by its id, in the same transaction
                    Value::Blob(id) => self.blob(tx, id, meta),
                    other => cell(other, meta),
                };
                cells.push(if plain {
                    c.plain().map_or(Cell::Null, Cell::Text)
                } else {
                    c
                });
            }
            answer.rows += 1;
            if !sink.row(cells) {
                answer.truncated = true;
                break;
            }
        }
        Ok(answer)
    }

    fn blob(&mut self, tx: &Transaction, id: u64, meta: &ColumnMeta) -> Cell {
        let mut blob = match self.conn.open_blob(tx, id) {
            Ok(blob) => blob,
            Err(e) => {
                self.broken |= breaks(&e);
                return Cell::Unreadable("BLOB".into());
            }
        };
        let mut bytes = Vec::new();
        let mut whole = true;
        while !blob.is_eof() {
            match blob.read_segment(&mut self.conn) {
                Ok(part) => bytes.extend_from_slice(&part),
                Err(e) => {
                    self.broken |= breaks(&e);
                    whole = false;
                    break;
                }
            }
            if bytes.len() > MAX_BLOB {
                whole = false;
                break;
            }
        }
        let _ = blob.close(&mut self.conn);
        if !whole {
            return Cell::Unreadable("BLOB (too big, or it could not be read)".into());
        }
        if meta.sub_type == 1 {
            Cell::Text(super::value::text_bytes(&bytes))
        } else {
            Cell::bytes(&bytes)
        }
    }

    /// Runs a statement in the transaction of the user, or in one of its own.
    fn within(
        &mut self,
        sql: &str,
        values: &[&str],
        sink: &mut dyn RowSink,
        plain: bool,
    ) -> AppResult<Answer> {
        if let Some(tx) = self.tx.take() {
            let result = self.statement(&tx, sql, values, sink, plain);
            if self.broken {
                // the connection went, and the transaction with it
                drop(tx);
            } else {
                self.tx = Some(tx);
            }
            return result;
        }
        let tx = self.begin(false)?;
        let result = self.statement(&tx, sql, values, sink, plain);
        if self.broken {
            drop(tx);
            return result;
        }
        match result {
            Ok(answer) => {
                tx.commit(&mut self.conn).map_err(|e| self.fail(&e, sql))?;
                Ok(answer)
            }
            Err(e) => {
                let _ = tx.rollback(&mut self.conn);
                Err(e)
            }
        }
    }

    /// As [`Fire::within`], while a watcher looks at the stop sign and the clock: stopped, the
    /// statement is ended from a second connection and answers with the server's „cancelled“.
    fn watched(
        &mut self,
        sql: &str,
        values: &[&str],
        timeout: Option<Duration>,
        sink: &mut dyn RowSink,
        plain: bool,
        stop: Stop,
    ) -> AppResult<Answer> {
        let started = Instant::now();
        let done = AtomicBool::new(false);
        let stopped = AtomicBool::new(false);
        let late = AtomicBool::new(false);
        let (config, attachment, tunnel) =
            (self.config.clone(), self.attachment, self.tunnel.clone());
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(Ordering::Relaxed) {
                    let over = timeout.is_some_and(|t| started.elapsed() >= t);
                    if !(over || stop()) {
                        std::thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                    if over {
                        late.store(true, Ordering::Relaxed);
                    }
                    stopped.store(true, Ordering::Relaxed);
                    cancel(&config, attachment, tunnel.as_deref());
                    // and again, should the statement only have started by now
                    for _ in 0..25 {
                        if done.load(Ordering::Relaxed) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(40));
                    }
                }
            });
            struct Done<'a>(&'a AtomicBool);
            impl Drop for Done<'_> {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::Relaxed);
                }
            }
            let _done = Done(&done);
            self.within(sql, values, sink, plain)
        });
        match result {
            Err(_) if late.load(Ordering::Relaxed) => Err(AppError::new(
                ErrorCode::Timeout,
                "the statement took too long",
            )),
            Err(_) if stopped.load(Ordering::Relaxed) => Err(super::cancelled()),
            other => other,
        }
    }
}

/// Ends what a connection runs, from a second one: the server stops a statement that is deleted from
/// its monitoring table. The number is the server's own for our connection.
fn cancel(config: &ConnectConfig, attachment: i64, tunnel: Option<&crate::ssh::Tunnel>) {
    if attachment <= 0 {
        return;
    }
    if let Some(tunnel) = tunnel {
        tunnel.permit();
    }
    let Ok(mut conn) = Connection::connect(config) else {
        return;
    };
    let _ = conn.exec_immediate(
        None,
        &format!("DELETE FROM mon$statements WHERE mon$attachment_id = {attachment}"),
    );
    let _ = conn.close();
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
                    // names of the catalog are CHAR(63): without the blanks behind them
                    Cell::Text(t) => Some(t.trim_end().to_owned()),
                    _ => None,
                })
                .collect(),
        );
        true
    }
}

impl Session for Fire {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        if self.broken {
            return Err(super::closed());
        }
        let mut sink = TextSink(Vec::new());
        self.watched(sql, params, timeout, &mut sink, true, stop)?;
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
        if self.broken {
            return Err(super::closed());
        }
        let sql = sql.trim().trim_end_matches(';').trim_end();
        if sql.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
        }
        if sql.len() > MAX_SQL_LEN {
            return Err(AppError::new(ErrorCode::InvalidQuery, "statement too long"));
        }
        let started = Instant::now();
        let nothing = |started: Instant| Outcome {
            columns: Vec::new(),
            rows: 0,
            truncated: false,
            rows_affected: None,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        };
        // the transaction is the client's to hold: these three the driver carries out itself
        match control(sql) {
            Control::Begin { read_only } => {
                if self.tx.is_some() {
                    return Err(AppError::new(
                        ErrorCode::InvalidQuery,
                        "a transaction is open already: commit or roll back first",
                    ));
                }
                self.tx = Some(self.begin(read_only)?);
                return Ok(nothing(started));
            }
            Control::Commit | Control::Rollback if self.tx.is_none() => {
                // nothing is open: every statement so far was kept as it ran
                return Ok(nothing(started));
            }
            Control::Commit => {
                if let Some(tx) = self.tx.take() {
                    tx.commit(&mut self.conn).map_err(|e| self.fail(&e, sql))?;
                }
                return Ok(nothing(started));
            }
            Control::Rollback => {
                if let Some(tx) = self.tx.take() {
                    tx.rollback(&mut self.conn)
                        .map_err(|e| self.fail(&e, sql))?;
                }
                return Ok(nothing(started));
            }
            Control::None => {}
        }
        // the text of a value; what it becomes its place in the statement says
        let texts: Vec<String> = params
            .iter()
            .map(|p| match p {
                Bind::Text(v)
                | Bind::Int(v)
                | Bind::Decimal(v)
                | Bind::Date(v)
                | Bind::Datetime(v) => v.clone(),
                Bind::Bool(b) => b.to_string(),
            })
            .collect();
        let values: Vec<&str> = texts.iter().map(String::as_str).collect();
        let answer = self.watched(sql, &values, limits.timeout, sink, false, stop)?;
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

    fn make_read_only(&mut self) -> bool {
        // every transaction of the session is opened read only from now on: the server refuses writes
        self.read_only = true;
        true
    }

    fn transaction_state(&mut self, _stop: Stop) -> TxState {
        // the transaction is a handle the server gave this client: it is open as long as it is held
        if self.tx.is_some() {
            TxState::Active
        } else {
            TxState::Idle
        }
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        Ok(format!("Firebird {}", self.version))
    }

    fn is_open(&self) -> bool {
        !self.broken && self.conn.is_healthy()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(sql_type: i32, scale: i32, sub_type: i32, length: i32) -> ColumnMeta {
        ColumnMeta {
            index: 0,
            sql_type,
            sub_type,
            scale,
            length,
            nullable: true,
            field: "F".into(),
            relation: String::new(),
            alias: "A".into(),
            owner: String::new(),
        }
    }

    #[test]
    fn numbers_with_a_scale_keep_every_digit_both_ways() {
        assert_eq!(scaled(1250, -2), "12.50");
        assert_eq!(scaled(-5, -2), "-0.05");
        assert_eq!(scaled(0, -3), "0.000");
        assert_eq!(scaled(7, 0), "7");
        assert_eq!(scaled(15, -1), "1.5");
        assert_eq!(scaled(15, 2), "1500");
        assert_eq!(
            scaled(12_345_678_901_234_567_890_123_456_789_012, -2),
            "123456789012345678901234567890.12"
        );
        assert_eq!(unscaled("12.5", -2), Some(1250));
        assert_eq!(unscaled(" -0.05 ", -2), Some(-5));
        assert_eq!(unscaled("7", -2), Some(700));
        assert_eq!(unscaled("+.5", -1), Some(5));
        assert_eq!(unscaled("1.500", -2), Some(150));
        // more places than the column keeps: refused, not rounded
        assert_eq!(unscaled("1.234", -2), None);
        for no in ["", ".", "1e5", "1,5", "abc", "1.2.3", "0x10", "1; DROP"] {
            assert_eq!(unscaled(no, -2), None, "{no}");
        }
    }

    #[test]
    fn a_value_becomes_what_its_place_is_or_is_refused() {
        let b = |raw: &str, m: &ColumnMeta| bound(raw, m);
        assert_eq!(b(" 42 ", &meta(SQL_LONG, 0, 0, 4)).unwrap(), Value::Int(42));
        assert_eq!(
            b("12.50", &meta(SQL_INT64 | 1, -2, 0, 8)).unwrap(),
            Value::BigInt(1250)
        );
        assert_eq!(b("7", &meta(SQL_SHORT, 0, 0, 2)).unwrap(), Value::Short(7));
        assert!(b("70000", &meta(SQL_SHORT, 0, 0, 2)).is_err());
        assert!(b("1; DROP TABLE t", &meta(SQL_LONG, 0, 0, 4)).is_err());
        assert!(b("1.234", &meta(SQL_LONG, -2, 0, 4)).is_err());
        assert_eq!(
            b("true", &meta(SQL_BOOLEAN, 0, 0, 1)).unwrap(),
            Value::Bool(true)
        );
        assert!(b("maybe", &meta(SQL_BOOLEAN, 0, 0, 1)).is_err());
        // the day Firebird counts from, and one later
        assert_eq!(
            b("1858-11-18", &meta(SQL_DATE, 0, 0, 4)).unwrap(),
            Value::Date(1)
        );
        assert_eq!(
            b("2024-02-29T13:05:09.25", &meta(SQL_TIMESTAMP, 0, 0, 8)).unwrap(),
            Value::Timestamp(60369, 471_092_500)
        );
        assert!(b("yesterday", &meta(SQL_DATE, 0, 0, 4)).is_err());
        assert_eq!(
            b("13:05:09", &meta(SQL_TIME, 0, 0, 4)).unwrap(),
            Value::Time(471_090_000)
        );
        // a text stays the text it is, whatever it looks like
        let evil = "'; DROP TABLE t; --";
        assert_eq!(
            b(evil, &meta(SQL_VARYING, 0, 4, 200)).unwrap(),
            Value::Text(evil.into())
        );
        assert_eq!(
            b(" x ", &meta(SQL_TEXT, 0, 4, 12)).unwrap(),
            Value::Text(" x ".into())
        );
    }

    #[test]
    fn values_of_a_row_become_cells() {
        assert_eq!(
            cell(Value::BigInt(1250), &meta(SQL_INT64, -2, 1, 8)),
            Cell::Decimal("12.50".into())
        );
        assert_eq!(
            cell(Value::Int(42), &meta(SQL_LONG, 0, 0, 4)),
            Cell::I64(42)
        );
        assert_eq!(
            cell(Value::Int128(-150), &meta(SQL_INT128, -2, 0, 16)),
            Cell::Decimal("-1.50".into())
        );
        assert!(matches!(
            cell(Value::Date(60369), &meta(SQL_DATE, 0, 0, 4)),
            Cell::Date(d) if d.to_string() == "2024-02-29"
        ));
        assert!(matches!(
            cell(Value::Timestamp(60369, 471_092_500), &meta(SQL_TIMESTAMP, 0, 0, 8)),
            Cell::Ts(t) if t.to_string() == "2024-02-29 13:05:09.250"
        ));
        assert_eq!(cell(Value::Null, &meta(SQL_TEXT, 0, 0, 4)), Cell::Null);
        assert_eq!(
            cell(Value::Bytes(vec![0, 255]), &meta(SQL_VARYING, 0, 1, 2)),
            Cell::bytes(&[0, 255])
        );
        let m = meta(SQL_INT64 | 1, -2, 1, 8);
        assert_eq!(kind_of(&m), ColKind::Decimal);
        assert_eq!(type_name(&m), "NUMERIC(18, 2)");
        assert_eq!(type_name(&meta(SQL_VARYING, 0, 4, 200)), "VARCHAR(50)");
        assert_eq!(type_name(&meta(SQL_VARYING, 0, 1, 16)), "VARBINARY(16)");
        assert_eq!(kind_of(&meta(SQL_BLOB, 0, 1, 8)), ColKind::Text);
        assert_eq!(kind_of(&meta(SQL_BLOB, 0, 0, 8)), ColKind::Bytes);
        assert_eq!(
            kind_of(&meta(SQL_TIMESTAMP_TZ, 0, 0, 12)),
            ColKind::TimestampTz
        );
    }

    #[test]
    fn the_transaction_is_steered_by_three_statements_and_no_other() {
        assert_eq!(
            control("set transaction"),
            Control::Begin { read_only: false }
        );
        assert_eq!(
            control("SET TRANSACTION READ ONLY ISOLATION LEVEL SNAPSHOT;"),
            Control::Begin { read_only: true }
        );
        assert_eq!(control(" commit work ; "), Control::Commit);
        assert_eq!(control("ROLLBACK"), Control::Rollback);
        // statements of the server
        assert_eq!(control("ROLLBACK TO SAVEPOINT a"), Control::None);
        assert_eq!(control("COMMIT RETAIN"), Control::None);
        assert_eq!(control("SAVEPOINT a"), Control::None);
        assert_eq!(control("SET TERM ^"), Control::None);
        assert_eq!(control("SELECT 'COMMIT' FROM rdb$database"), Control::None);
    }
}
