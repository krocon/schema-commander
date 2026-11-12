//! DuckDB over `duckdb` (prompt 035c): embedded like SQLite – a file, or a database in memory to query
//! files (Parquet, CSV, JSON) with. The library is built in; nothing is downloaded: extensions are
//! neither installed nor loaded on their own.
//!
//! A DuckDB file can be opened once per process: all sessions of a profile (the app's own and one per
//! tab) are connections of one shared database, kept in [`SHARED`] while one of them lives. So the tabs
//! of a connection see the same tables – also of a database in memory.

use super::value::{Cell, ColKind, Column, Outcome, RowSink, text, text_bytes};
use super::{Bind, Limits, Profile, Session, Stop, TxState};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveTime, TimeZone};
use duckdb::arrow::datatypes::{DataType, IntervalUnit, TimeUnit as arrow_unit};
use duckdb::types::{TimeUnit, Value};
use duckdb::{Config, Connection};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Instant;

/// Longest statement accepted (bytes).
pub const MAX_SQL_LEN: usize = 16 * 1024 * 1024;
/// `database` of the profile that means a database in memory.
pub const MEMORY: &str = ":memory:";

/// The database of a profile, opened once: its sessions are clones of this connection.
struct Shared {
    key: String,
    /// `None` only while it is being closed.
    conn: Mutex<Option<Connection>>,
}

impl Drop for Shared {
    fn drop(&mut self) {
        // closed while the list is held: nobody opens the same file a second time in between
        // (review 035c 5)
        let all = registry().lock();
        if let Ok(mut conn) = self.conn.lock() {
            conn.take();
        }
        if let Ok(mut all) = all {
            // only when no other database took the place in the meantime
            if all.get(&self.key).is_some_and(|w| w.strong_count() == 0) {
                all.remove(&self.key);
            }
        }
    }
}

fn registry() -> &'static Mutex<HashMap<String, Weak<Shared>>> {
    static SHARED: OnceLock<Mutex<HashMap<String, Weak<Shared>>>> = OnceLock::new();
    SHARED.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct Duck {
    conn: Connection,
    /// A transaction was opened and not ended. DuckDB does not say (its `is_autocommit` stays true
    /// inside one): the session reads it off the statements that ran – it sees every one of them.
    in_tx: bool,
    /// Keeps the database open as long as this session lives.
    _shared: Arc<Shared>,
}

/// What DuckDB said, as an error of ours. Its messages start with the kind of the error
/// (`Parser Error: …`, `Catalog Error: …`) and may name a line (`LINE 1: …` with a `^` below).
fn failed(e: &duckdb::Error) -> AppError {
    let whole = e.to_string();
    let message = whole.lines().next().unwrap_or_default().trim().to_owned();
    let lower = message.to_ascii_lowercase();
    let code = if lower.starts_with("interrupt") {
        ErrorCode::Cancelled
    } else if lower.starts_with("permission error") {
        ErrorCode::PermissionDenied
    } else {
        ErrorCode::InvalidQuery
    };
    let kind = message
        .split_once(" Error:")
        .map(|(kind, _)| kind.trim().to_owned())
        .filter(|k| k.len() <= 30 && k.chars().all(|c| c.is_ascii_alphabetic() || c == ' '));
    // "LINE n: <text>" and below it a caret under the place
    let mut line = None;
    let mut position = None;
    let lines: Vec<&str> = whole.lines().collect();
    for (i, l) in lines.iter().enumerate() {
        if let Some(rest) = l.trim_start().strip_prefix("LINE ")
            && let Some((n, _)) = rest.split_once(':')
        {
            line = n.trim().parse::<u32>().ok();
            if let Some(caret) = lines.get(i + 1).and_then(|c| c.find('^')) {
                let prefix = l.find(": ").map_or(0, |at| at + 2);
                position = caret.checked_sub(prefix).map(|c| c as u32 + 1);
            }
        }
    }
    let hint = lines
        .iter()
        .find_map(|l| l.trim().strip_prefix("Did you mean"))
        .map(|rest| format!("Did you mean{rest}"));
    AppError::new(code, super::clean(&message)).with(ErrorDetails {
        sqlstate: kind,
        hint,
        line,
        // the column inside that line; only for a statement of one line it is the place in the text
        position: position.filter(|_| line == Some(1)),
        ..Default::default()
    })
}

/// The settings every database is opened with: nothing is fetched from the net behind the user's back.
fn config() -> AppResult<Config> {
    Config::default()
        .enable_autoload_extension(false)
        .and_then(|c| c.with("autoinstall_known_extensions", "false"))
        .and_then(|c| c.custom_user_agent("schema-commander"))
        .map_err(|e| failed(&e))
}

/// Opens the database of the profile – the file must exist, a typo must not create an empty one – or one
/// in memory. A second session of the same profile joins the database that is open.
pub fn open(profile: &Profile) -> AppResult<Duck> {
    let path = profile.database.trim();
    let memory = path == MEMORY;
    let key = if memory {
        // one per profile: its tabs share it, another profile has its own
        format!("{MEMORY}{}", profile.id)
    } else {
        std::fs::canonicalize(path)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| {
                let code = if e.kind() == std::io::ErrorKind::NotFound {
                    ErrorCode::NotFound
                } else {
                    ErrorCode::ConnectionFailed
                };
                AppError::new(code, format!("{path}: {e}"))
            })?
    };
    let mut all = registry()
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Io, "the list of open databases is broken"))?;
    let shared = match all.get(&key).and_then(Weak::upgrade) {
        Some(shared) => shared,
        None => {
            let opened = if memory {
                Connection::open_in_memory_with_flags(config()?)
            } else {
                Connection::open_with_flags(&key, config()?)
            };
            let conn = opened.map_err(|e| {
                let mut error = failed(&e);
                // another program holds the file, or it is no database of DuckDB
                error.code = ErrorCode::ConnectionFailed;
                error.message = format!("{path}: {}", error.message);
                error
            })?;
            let shared = Arc::new(Shared {
                key: key.clone(),
                conn: Mutex::new(Some(conn)),
            });
            all.insert(key, Arc::downgrade(&shared));
            shared
        }
    };
    drop(all);
    let conn = shared
        .conn
        .lock()
        .map_err(|_| AppError::new(ErrorCode::Io, "the database is broken"))?
        .as_ref()
        .ok_or_else(super::closed)?
        .try_clone()
        .map_err(|e| failed(&e))?;
    Ok(Duck {
        conn,
        in_tx: false,
        _shared: shared,
    })
}

fn kind_of(t: &DataType) -> ColKind {
    match t {
        DataType::Boolean => ColKind::Bool,
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32 => ColKind::Int,
        // may not fit an i64: exact text
        DataType::UInt64 | DataType::Decimal128(..) | DataType::Decimal256(..) => ColKind::Decimal,
        DataType::Float16 | DataType::Float32 | DataType::Float64 => ColKind::Float,
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => ColKind::Text,
        DataType::Binary | DataType::LargeBinary | DataType::FixedSizeBinary(_) => ColKind::Bytes,
        DataType::Timestamp(_, Some(_)) => ColKind::TimestampTz,
        DataType::Timestamp(_, None) => ColKind::Timestamp,
        DataType::Date32 | DataType::Date64 => ColKind::Date,
        DataType::Time32(_) | DataType::Time64(_) => ColKind::Time,
        _ => ColKind::Other,
    }
}

/// Whether the driver can hand a value of this type over. For any other (a column that is nothing but
/// `NULL` among them) it ends in `unreachable!`: such a cell is never asked for.
fn readable(t: &DataType) -> bool {
    matches!(
        t,
        DataType::Boolean
            | DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Float16
            | DataType::Float32
            | DataType::Float64
            | DataType::Decimal128(..)
            | DataType::Timestamp(..)
            | DataType::Utf8
            | DataType::LargeUtf8
            | DataType::Binary
            | DataType::LargeBinary
            | DataType::Date32
            | DataType::Time64(arrow_unit::Microsecond)
            | DataType::Interval(IntervalUnit::MonthDayNano)
            | DataType::List(_)
            | DataType::LargeList(_)
            | DataType::Dictionary(..)
            | DataType::Struct(_)
            | DataType::Map(..)
            | DataType::FixedSizeList(..)
            | DataType::Union(..)
    )
}

/// The type as DuckDB would write it, as far as Arrow still says so.
fn type_name(t: &DataType) -> String {
    match t {
        DataType::Boolean => "BOOLEAN".into(),
        DataType::Int8 => "TINYINT".into(),
        DataType::Int16 => "SMALLINT".into(),
        DataType::Int32 => "INTEGER".into(),
        DataType::Int64 => "BIGINT".into(),
        DataType::UInt8 => "UTINYINT".into(),
        DataType::UInt16 => "USMALLINT".into(),
        DataType::UInt32 => "UINTEGER".into(),
        DataType::UInt64 => "UBIGINT".into(),
        DataType::Float32 => "FLOAT".into(),
        DataType::Float64 => "DOUBLE".into(),
        DataType::Decimal128(p, s) | DataType::Decimal256(p, s) => format!("DECIMAL({p},{s})"),
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => "VARCHAR".into(),
        DataType::Binary | DataType::LargeBinary | DataType::FixedSizeBinary(_) => "BLOB".into(),
        DataType::Timestamp(_, Some(_)) => "TIMESTAMP WITH TIME ZONE".into(),
        DataType::Timestamp(_, None) => "TIMESTAMP".into(),
        DataType::Date32 | DataType::Date64 => "DATE".into(),
        DataType::Time32(_) | DataType::Time64(_) => "TIME".into(),
        DataType::Interval(_) => "INTERVAL".into(),
        DataType::List(_) | DataType::LargeList(_) | DataType::FixedSizeList(..) => "LIST".into(),
        DataType::Struct(_) => "STRUCT".into(),
        DataType::Map(..) => "MAP".into(),
        DataType::Dictionary(..) => "ENUM".into(),
        DataType::Union(..) => "UNION".into(),
        other => format!("{other:?}").chars().take(40).collect(),
    }
}

fn micros(unit: TimeUnit, value: i64) -> i64 {
    match unit {
        TimeUnit::Second => value.saturating_mul(1_000_000),
        TimeUnit::Millisecond => value.saturating_mul(1_000),
        TimeUnit::Microsecond => value,
        TimeUnit::Nanosecond => value / 1_000,
    }
}

fn interval(months: i32, days: i32, nanos: i64) -> String {
    let mut parts = Vec::new();
    let (years, months) = (months / 12, months % 12);
    for (n, word) in [(years, "year"), (months, "month"), (days, "day")] {
        if n != 0 {
            parts.push(format!("{n} {word}{}", if n.abs() == 1 { "" } else { "s" }));
        }
    }
    if nanos != 0 || parts.is_empty() {
        let sign = if nanos < 0 { "-" } else { "" };
        let total = nanos.unsigned_abs() / 1_000;
        let (seconds, fraction) = (total / 1_000_000, total % 1_000_000);
        let mut clock = format!(
            "{sign}{:02}:{:02}:{:02}",
            seconds / 3600,
            seconds / 60 % 60,
            seconds % 60
        );
        if fraction != 0 {
            clock.push_str(format!(".{fraction:06}").trim_end_matches('0'));
        }
        parts.push(clock);
    }
    parts.join(" ")
}

/// A value inside a list, a struct or a map, written the way DuckDB shows it.
fn nested(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("NULL"),
        Value::Text(s) | Value::Enum(s) => out.push_str(s),
        Value::List(items) | Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                nested(item, out);
            }
            out.push(']');
        }
        Value::Struct(fields) => {
            out.push('{');
            for (i, (name, value)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&format!("'{name}': "));
                nested(value, out);
            }
            out.push('}');
        }
        Value::Map(entries) => {
            out.push('{');
            for (i, (key, value)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                nested(key, out);
                out.push('=');
                nested(value, out);
            }
            out.push('}');
        }
        Value::Union(inner) => nested(inner, out),
        other => match cell(other.clone(), ColKind::Other) {
            Cell::Null => out.push_str("NULL"),
            c => out.push_str(&c.plain().unwrap_or_else(|| "?".into())),
        },
    }
}

/// A value as a cell. `kind` is what the column says: it tells an instant from a time without a zone.
fn cell(v: Value, kind: ColKind) -> Cell {
    let utc = FixedOffset::east_opt(0);
    match v {
        Value::Null => Cell::Null,
        Value::Boolean(b) => Cell::Bool(b),
        Value::TinyInt(n) => Cell::I64(n.into()),
        Value::SmallInt(n) => Cell::I64(n.into()),
        Value::Int(n) => Cell::I64(n.into()),
        Value::BigInt(n) => Cell::I64(n),
        Value::UTinyInt(n) => Cell::I64(n.into()),
        Value::USmallInt(n) => Cell::I64(n.into()),
        Value::UInt(n) => Cell::I64(n.into()),
        Value::UBigInt(n) => Cell::Decimal(n.to_string()),
        Value::HugeInt(n) => Cell::Decimal(n.to_string()),
        Value::UHugeInt(n) => Cell::Decimal(n.to_string()),
        Value::Float(f) => Cell::F64(f.into()),
        Value::Double(f) => Cell::F64(f),
        Value::Decimal(d) => Cell::Decimal(d.to_string()),
        Value::Text(s) => Cell::Text(text(&s)),
        Value::Enum(s) => Cell::Text(text(&s)),
        Value::Blob(b) | Value::Geometry(b) => Cell::bytes(&b),
        Value::Timestamp(unit, value) => match DateTime::from_timestamp_micros(micros(unit, value))
        {
            Some(at) if kind == ColKind::TimestampTz => match utc {
                Some(utc) => Cell::TsTz(utc.from_utc_datetime(&at.naive_utc())),
                None => Cell::Ts(at.naive_utc()),
            },
            Some(at) => Cell::Ts(at.naive_utc()),
            None => Cell::Unreadable("TIMESTAMP".into()),
        },
        Value::Date32(days) => NaiveDate::from_ymd_opt(1970, 1, 1)
            .and_then(|epoch| epoch.checked_add_signed(chrono::Duration::days(days.into())))
            .map_or_else(|| Cell::Unreadable("DATE".into()), Cell::Date),
        Value::Time64(unit, value) => {
            let us = micros(unit, value);
            let seconds = u32::try_from(us.div_euclid(1_000_000)).unwrap_or(u32::MAX);
            let nanos = u32::try_from(us.rem_euclid(1_000_000) * 1_000).unwrap_or(0);
            NaiveTime::from_num_seconds_from_midnight_opt(seconds, nanos)
                .map_or_else(|| Cell::Unreadable("TIME".into()), Cell::Time)
        }
        Value::Interval {
            months,
            days,
            nanos,
        } => Cell::Text(interval(months, days, nanos)),
        other => {
            let mut out = String::new();
            nested(&other, &mut out);
            Cell::Text(text(&out))
        }
    }
}

/// The values of a statement as DuckDB binds them. Numbers with a fraction and dates travel as text:
/// the statement casts them (`CAST($1 AS …)`), or the database reads them as what the place expects.
fn binds(params: &[Bind]) -> AppResult<Vec<Value>> {
    params
        .iter()
        .map(|p| {
            Ok(match p {
                Bind::Text(v) | Bind::Decimal(v) | Bind::Date(v) | Bind::Datetime(v) => {
                    Value::Text(v.clone())
                }
                Bind::Int(v) => Value::BigInt(Bind::int(v)?),
                Bind::Bool(v) => Value::Boolean(*v),
            })
        })
        .collect()
}

impl Duck {
    fn run(
        conn: &Connection,
        sql: &str,
        params: &[Bind],
        sink: &mut dyn RowSink,
        elapsed: &dyn Fn() -> u64,
        stop: Stop,
    ) -> AppResult<Outcome> {
        let values = binds(params)?;
        // without values the text runs as typed: several statements, the last one answers
        let last = if values.is_empty() {
            let mut statements = split(sql);
            let Some(last) = statements.pop() else {
                return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
            };
            for one in statements {
                conn.execute_batch(one).map_err(|e| failed(&e))?;
            }
            last
        } else {
            sql
        };
        let mut stmt = conn.prepare(last).map_err(|e| failed(&e))?;
        if stmt.parameter_count() != values.len() {
            return Err(AppError::new(
                ErrorCode::InvalidQuery,
                format!(
                    "the statement has {} placeholders, {} values were given",
                    stmt.parameter_count(),
                    values.len()
                ),
            ));
        }
        let reads =
            super::guard::classify(last, super::DbKind::Duckdb) == super::guard::Class::Read;
        let mut cursor = stmt
            .query(duckdb::params_from_iter(values.iter()))
            .map_err(|e| failed(&e))?;
        let types: Vec<DataType> = {
            let s = cursor.as_ref().ok_or_else(|| {
                AppError::new(ErrorCode::InvalidQuery, "the statement gave no result")
            })?;
            (0..s.column_count()).map(|i| s.column_type(i)).collect()
        };
        let kinds: Vec<ColKind> = types.iter().map(kind_of).collect();
        let columns: Vec<Column> = {
            let s = cursor.as_ref().ok_or_else(|| {
                AppError::new(ErrorCode::InvalidQuery, "the statement gave no result")
            })?;
            (0..types.len())
                .map(|i| Column {
                    name: s
                        .column_name(i)
                        .map_or_else(|_| String::new(), Clone::clone),
                    kind: kinds[i],
                    type_name: type_name(&types[i]),
                })
                .collect()
        };
        // a statement that changes rows answers with one row: how many
        // … only a statement that starts as one: a query with a column of that name is a query
        let first: String = last
            .trim_start()
            .chars()
            .take_while(char::is_ascii_alphabetic)
            .collect::<String>()
            .to_ascii_uppercase();
        let changes = matches!(
            first.as_str(),
            "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "COPY"
        );
        let counts = changes && columns.len() == 1 && columns[0].name == "Count";
        if counts || (!reads && columns.is_empty()) {
            let mut changed = None;
            while let Some(row) = cursor.next().map_err(|e| failed(&e))? {
                if counts && let Ok(Value::BigInt(n)) = row.get::<_, Value>(0) {
                    changed = u64::try_from(n).ok();
                }
            }
            return Ok(Outcome {
                columns: Vec::new(),
                rows: 0,
                truncated: false,
                rows_affected: changed,
                elapsed_ms: elapsed(),
            });
        }
        sink.start(&columns);
        let mut rows: u64 = 0;
        let mut truncated = false;
        while let Some(row) = cursor.next().map_err(|e| failed(&e))? {
            // the result is there already: handing it over still ends when the work is stopped
            if rows.is_multiple_of(1024) && stop() {
                return Err(super::cancelled());
            }
            let mut cells = Vec::with_capacity(kinds.len());
            for (i, kind) in kinds.iter().enumerate() {
                if !readable(&types[i]) {
                    // the driver would not return from such a column
                    cells.push(if types[i] == DataType::Null {
                        Cell::Null
                    } else {
                        Cell::Unreadable(columns[i].type_name.clone())
                    });
                    continue;
                }
                cells.push(match row.get::<_, Value>(i) {
                    Ok(v) => cell(v, *kind),
                    Err(_) => match row.get_ref(i) {
                        Ok(duckdb::types::ValueRef::Text(t)) => Cell::Text(text_bytes(t)),
                        _ => Cell::Unreadable(columns[i].type_name.clone()),
                    },
                });
            }
            rows += 1;
            if !sink.row(cells) {
                truncated = true;
                break;
            }
        }
        Ok(Outcome {
            columns,
            rows,
            truncated,
            rows_affected: None,
            elapsed_ms: elapsed(),
        })
    }
}

/// The statements of a text, cut at `;` outside of strings, quoted names and comments. DuckDB's
/// dollar quotes (`$$ … $$`) are kept whole.
fn split(sql: &str) -> Vec<&str> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            quote @ (b'\'' | b'"') => {
                i += 1;
                while i < b.len() && b[i] != quote {
                    i += 1;
                }
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i += 1;
            }
            b'$' if b.get(i + 1) == Some(&b'$') => {
                i += 2;
                while i < b.len() && !(b[i] == b'$' && b.get(i + 1) == Some(&b'$')) {
                    i += 1;
                }
                i += 1;
            }
            b';' => {
                out.push(&sql[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(&sql[start.min(sql.len())..]);
    out.into_iter()
        .map(str::trim)
        .filter(|s| !only_comments(s))
        .collect()
}

/// Whether a transaction is open after the statements of `sql` ran, when it was (`was`) before.
fn tx_after(sql: &str, was: bool) -> bool {
    let mut open = was;
    for statement in split(sql) {
        let mut rest = statement;
        while !only_comments(rest) && (rest.starts_with("--") || rest.starts_with("/*")) {
            rest = if let Some(after) = rest.strip_prefix("--") {
                after.split_once('\n').map_or("", |(_, r)| r).trim_start()
            } else {
                rest[2..]
                    .split_once("*/")
                    .map_or("", |(_, r)| r)
                    .trim_start()
            };
        }
        let first: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphabetic())
            .collect::<String>()
            .to_ascii_uppercase();
        match first.as_str() {
            "BEGIN" | "START" => open = true,
            "COMMIT" | "END" | "ROLLBACK" | "ABORT" => open = false,
            _ => {}
        }
    }
    open
}

fn only_comments(sql: &str) -> bool {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            return rest.is_empty();
        }
    }
}

impl Session for Duck {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        _timeout: Option<std::time::Duration>,
        _stop: Stop,
    ) -> AppResult<super::TextRows> {
        // the catalog of an embedded database is read in no time: no watcher
        let mut stmt = self.conn.prepare(sql).map_err(|e| failed(&e))?;
        let mut cursor = stmt
            .query(duckdb::params_from_iter(params.iter()))
            .map_err(|e| failed(&e))?;
        let types: Vec<DataType> = cursor
            .as_ref()
            .map(|s| (0..s.column_count()).map(|i| s.column_type(i)).collect())
            .unwrap_or_default();
        let count = types.len();
        let mut rows = Vec::new();
        while let Some(row) = cursor.next().map_err(|e| failed(&e))? {
            let mut cells = Vec::with_capacity(count);
            for (i, t) in types.iter().enumerate() {
                if !readable(t) {
                    cells.push(None);
                    continue;
                }
                let value = row.get::<_, Value>(i).map_err(|e| failed(&e))?;
                cells.push(cell(value, ColKind::Other).plain());
            }
            rows.push(cells);
        }
        Ok(rows)
    }

    fn execute_bound(
        &mut self,
        sql: &str,
        params: &[Bind],
        limits: Limits,
        sink: &mut dyn RowSink,
        stop: Stop,
    ) -> AppResult<Outcome> {
        let sql = sql.trim();
        if sql.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
        }
        if sql.len() > MAX_SQL_LEN {
            return Err(AppError::new(ErrorCode::InvalidQuery, "statement too long"));
        }
        let started = Instant::now();
        let elapsed = || u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        // a watcher interrupts the statement when the work is stopped; it ends with the statement
        let interrupt = self.conn.interrupt_handle();
        let done = AtomicBool::new(false);
        let stopped = AtomicBool::new(false);
        let timed_out = AtomicBool::new(false);
        let conn = &self.conn;
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(Ordering::Relaxed) {
                    let late = limits.timeout.is_some_and(|t| started.elapsed() >= t);
                    if late {
                        timed_out.store(true, Ordering::Relaxed);
                    }
                    if late || stop() {
                        stopped.store(true, Ordering::Relaxed);
                        // again and again: an interrupt before the statement has started is lost
                        interrupt.interrupt();
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    } else {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                }
            });
            // the watcher ends with the statement, whatever its end – also a panic of the driver,
            // which is caught here and told as an error (review 035c 2)
            struct Done<'a>(&'a AtomicBool);
            impl Drop for Done<'_> {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::Relaxed);
                }
            }
            let _done = Done(&done);
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                Self::run(conn, sql, params, sink, &elapsed, stop)
            }))
            .unwrap_or_else(|_| {
                Err(AppError::new(
                    ErrorCode::InvalidQuery,
                    "the result holds a value the driver of DuckDB cannot read",
                ))
            })
        });
        if result.is_ok() {
            self.in_tx = tx_after(sql, self.in_tx);
        } else if self.in_tx || tx_after(sql, false) {
            // an error inside a transaction may have ended it or not: ask in the only way there is –
            // a transaction cannot be opened inside one
            self.in_tx = self.conn.execute_batch("BEGIN").is_err();
            if !self.in_tx {
                let _ = self.conn.execute_batch("ROLLBACK");
            }
        }
        if timed_out.load(Ordering::Relaxed) && result.is_err() {
            return Err(AppError::new(
                ErrorCode::Timeout,
                "the statement took too long",
            ));
        }
        if stopped.load(Ordering::Relaxed) && result.is_err() {
            return Err(super::cancelled());
        }
        result
    }

    fn transaction_state(&mut self, _stop: Stop) -> TxState {
        if self.in_tx {
            TxState::Active
        } else {
            TxState::Idle
        }
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        let version = self.conn.version().map_err(|e| failed(&e))?;
        Ok(format!("DuckDB {}", version.trim_start_matches('v')))
    }

    fn is_open(&self) -> bool {
        true
    }
}

#[cfg(test)]
#[path = "duckdb_tests.rs"]
mod tests;
