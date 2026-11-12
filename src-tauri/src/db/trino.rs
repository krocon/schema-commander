//! Trino and Presto over their HTTP protocol (prompt 035f), with `ureq`. A statement is posted to
//! `/v1/statement`; its answer comes in pages, each naming the next one (`nextUri`), until none is left.
//! Between two pages the driver looks at the stop sign and the clock, and ends a statement by deleting
//! its next page – the session goes on.
//!
//! There is no connection to hold. What makes a session – catalog, schema, properties, prepared
//! statements, the transaction – the server hands back in headers, and the driver sends it along with
//! every request.
//!
//! The protocol has no bound values: like the JDBC driver, a statement with values is prepared (in a
//! header) and executed with **literals the driver writes itself** ([`literal`]), never with text of
//! the caller.

use super::http::{encode, transport};
use super::secrets::Secret;
use super::value::{Cell, ColKind, Column, Outcome, RowSink};
use super::{Bind, Limits, Profile, Session, Stop, TlsMode, TxState, clean};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use ureq::Agent;

/// Longest statement accepted (bytes).
pub const MAX_SQL_LEN: usize = 16 * 1024 * 1024;
/// A statement with values travels in a header: longer ones the server would refuse with the whole
/// request.
const MAX_PREPARED_LEN: usize = 48 * 1024;
/// A page of an answer at most (bytes).
const MAX_PAGE: u64 = 256 * 1024 * 1024;
/// One request at most: the server answers within a second or two, also while a statement runs.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// The name the driver prepares a statement with values under.
const PREPARED: &str = "sc_bound";
/// The statement that opens the transaction of a session that only reads.
pub const READ_ONLY: &str = "START TRANSACTION READ ONLY";
/// Both families of headers are sent and read: a Trino server knows `X-Trino-…`, Presto `X-Presto-…`.
const PREFIXES: [&str; 2] = ["X-Trino-", "X-Presto-"];

pub struct Trino {
    /// The SSH tunnel this session runs through, if any: held so its listener outlives the session.
    tunnel: Option<Arc<crate::ssh::Tunnel>>,
    agent: Agent,
    /// `http://host:port`.
    base: String,
    user: String,
    password: Secret,
    catalog: String,
    schema: String,
    /// `SET SESSION` properties, as the server handed them back.
    properties: BTreeMap<String, String>,
    /// Statements the user prepared (`PREPARE name FROM …`): name → text, encoded as the server sent it.
    prepared: BTreeMap<String, String>,
    /// The open transaction, as the server named it.
    transaction: Option<String>,
    /// The session only reads: every statement runs in a transaction that is read only on the server,
    /// opened again whenever one ended.
    read_only: bool,
    on: String,
    version: String,
}

/// What Trino said about a statement: `{"message": "line 1:15: Table … does not exist", "errorCode":
/// 46, "errorName": "TABLE_NOT_FOUND", "errorLocation": {"lineNumber": 1, "columnNumber": 15}}`.
fn failed(error: &Value, sql: &str) -> AppError {
    let name = error
        .get("errorName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the statement failed");
    let code = match name {
        "CATALOG_NOT_FOUND" | "SCHEMA_NOT_FOUND" | "MISSING_CATALOG_NAME" => ErrorCode::NotFound,
        "PERMISSION_DENIED" | "READ_ONLY_VIOLATION" => ErrorCode::PermissionDenied,
        "USER_CANCELED" | "ADMINISTRATIVELY_KILLED" | "ADMINISTRATIVELY_PREEMPTED" => {
            ErrorCode::Cancelled
        }
        "EXCEEDED_TIME_LIMIT" | "ABANDONED_QUERY" => ErrorCode::Timeout,
        _ => ErrorCode::InvalidQuery,
    };
    let number = error.get("errorCode").and_then(Value::as_u64);
    let place = error.get("errorLocation");
    let at = |key: &str| {
        place
            .and_then(|p| p.get(key))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };
    let line = at("lineNumber");
    // line and column of the server → characters from the start of the statement
    let position = match (line, at("columnNumber")) {
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
    AppError::new(code, clean(message)).with(ErrorDetails {
        sqlstate: match (number, name.is_empty()) {
            (Some(n), false) => Some(format!("{n} {name}")),
            (Some(n), true) => Some(n.to_string()),
            (None, _) => None,
        },
        position,
        line,
        ..Default::default()
    })
}

/// An answer that is no page of a statement: a refused login, a proxy, another server.
fn refused(on: &str, status: u16, body: &str) -> AppError {
    match status {
        401 | 403 => AppError::new(ErrorCode::AuthFailed, "login failed"),
        _ => {
            let said: String = body.chars().take(200).collect();
            AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{on}: HTTP {status} {}", clean(&said)),
            )
        }
    }
}

pub fn connect(profile: &Profile, secret: Option<&Secret>, stop: Stop) -> AppResult<Trino> {
    let password = secret.map(Secret::expose).unwrap_or_default();
    if !password.is_empty() && profile.tls == TlsMode::Off {
        // the server would refuse it, and it would have crossed the wire in the clear by then
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "Trino takes a password only over TLS: switch TLS on, or leave the password empty",
        ));
    }
    let catalog = profile.database.trim();
    if catalog.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "Trino needs a catalog: name it as the database of the connection",
        ));
    }
    let mut trino = Trino {
        tunnel: None,
        agent: super::http::agent(profile)?,
        base: super::http::base(profile),
        user: profile.user.trim().to_owned(),
        password: Secret::new(password),
        catalog: catalog.to_owned(),
        schema: String::new(),
        properties: BTreeMap::new(),
        prepared: BTreeMap::new(),
        transaction: None,
        read_only: false,
        on: profile.where_label(),
        version: String::new(),
    };
    // who answers (Presto knows no `version()`); then a question that says whether the login is right,
    // and one whether the catalog is there
    trino.version = trino.info();
    trino.ask("SELECT 1", &[], Some(super::CONNECT_TIMEOUT), stop)?;
    let known = trino.ask(
        "SELECT 1 FROM system.metadata.catalogs WHERE catalog_name = ?",
        &[catalog],
        Some(super::CONNECT_TIMEOUT),
        stop,
    )?;
    if known.is_empty() {
        return Err(AppError::new(
            ErrorCode::NotFound,
            format!("catalog „{}“ does not exist", clean(catalog)),
        ));
    }
    Ok(trino)
}

// --- types and values ---------------------------------------------------------------------------------

fn kind_of(type_name: &str) -> ColKind {
    let t = type_name.trim().to_ascii_lowercase();
    let zoned = t.ends_with("with time zone");
    let base = t.split(['(', ' ']).next().unwrap_or_default();
    match base {
        "tinyint" | "smallint" | "integer" | "bigint" => ColKind::Int,
        "real" | "double" => ColKind::Float,
        "decimal" => ColKind::Decimal,
        "boolean" => ColKind::Bool,
        "varchar" | "char" => ColKind::Text,
        "varbinary" => ColKind::Bytes,
        "date" => ColKind::Date,
        "timestamp" if zoned => ColKind::TimestampTz,
        "timestamp" => ColKind::Timestamp,
        // a time with a zone has no day to anchor it: shown as the server writes it
        "time" if !zoned => ColKind::Time,
        "json" | "array" | "map" | "row" => ColKind::Json,
        "uuid" => ColKind::Uuid,
        _ => ColKind::Other,
    }
}

fn cell(v: Value, kind: ColKind) -> Cell {
    let s = match v {
        Value::Null => return Cell::Null,
        Value::Bool(b) => return Cell::Bool(b),
        Value::Number(n) => {
            return match kind {
                ColKind::Float => n.as_f64().map_or(Cell::Text(n.to_string()), Cell::F64),
                _ => n.as_i64().map_or(Cell::Decimal(n.to_string()), Cell::I64),
            };
        }
        // arrays, maps and rows come as JSON and stay JSON
        other @ (Value::Array(_) | Value::Object(_)) => return Cell::Json(other.to_string()),
        Value::String(s) => s,
    };
    match kind {
        ColKind::Decimal => Cell::Decimal(s),
        // NaN and the infinities come as words
        ColKind::Float => s.parse().map_or(Cell::Text(s), Cell::F64),
        ColKind::Int => s.parse().map_or(Cell::Decimal(s), Cell::I64),
        ColKind::Bytes => match BASE64.decode(s.as_bytes()) {
            Ok(bytes) => Cell::Bytes(bytes.len(), bytes),
            Err(_) => Cell::Unreadable("varbinary".into()),
        },
        ColKind::Date => {
            NaiveDate::parse_from_str(&s, "%Y-%m-%d").map_or(Cell::Text(s), Cell::Date)
        }
        ColKind::Time => {
            NaiveTime::parse_from_str(&s, "%H:%M:%S%.f").map_or(Cell::Text(s), Cell::Time)
        }
        ColKind::Timestamp => NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S%.f")
            .map_or(Cell::Text(s), Cell::Ts),
        // `… UTC`, `… +01:00` are instants; a zone by name (`Europe/Berlin`) is shown as it is written
        ColKind::TimestampTz => {
            let with_offset = match s.strip_suffix(" UTC") {
                Some(rest) => format!("{rest} +00:00"),
                None => s.clone(),
            };
            DateTime::parse_from_str(&with_offset, "%Y-%m-%d %H:%M:%S%.f %:z")
                .map_or(Cell::Text(s), Cell::TsTz)
        }
        ColKind::Uuid => Cell::Uuid(s),
        ColKind::Json => Cell::Json(s),
        _ => Cell::Text(s),
    }
}

/// A text as a literal: Trino knows no escape in a string but the doubled quote.
fn text_literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
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

/// A value as the literal the driver writes into `EXECUTE … USING`: every form is checked or quoted
/// here, nothing of the value is read as SQL.
fn literal(bind: &Bind) -> AppResult<String> {
    Ok(match bind {
        Bind::Text(v) => text_literal(v),
        Bind::Int(v) => Bind::int(v)?.to_string(),
        Bind::Decimal(v) => {
            let t = v.trim();
            let digits = t.strip_prefix(['-', '+']).unwrap_or(t);
            let plain = !digits.is_empty()
                && digits.chars().any(|c| c.is_ascii_digit())
                && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
                && digits.matches('.').count() <= 1;
            if !plain {
                return Err(not_a("number", t));
            }
            format!("DECIMAL '{t}'")
        }
        Bind::Bool(v) => if *v { "TRUE" } else { "FALSE" }.to_owned(),
        Bind::Date(v) => {
            let t = v.trim();
            NaiveDate::parse_from_str(t, "%Y-%m-%d").map_err(|_| not_a("date", t))?;
            format!("DATE '{t}'")
        }
        Bind::Datetime(v) => {
            let t = v.trim().replace('T', " ");
            NaiveDateTime::parse_from_str(&t, "%Y-%m-%d %H:%M:%S%.f")
                .or_else(|_| NaiveDateTime::parse_from_str(&t, "%Y-%m-%d %H:%M"))
                .map_err(|_| not_a("date with a time", &t))?;
            format!("TIMESTAMP '{t}'")
        }
    })
}

/// The statements of a text with where each begins (bytes): the server takes one per request. Strings
/// and quoted names know only the doubled quote.
fn split(sql: &str) -> Vec<(usize, &str)> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i) = (0, 0);
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
            b';' => {
                out.push((start, &sql[start..i]));
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    let start = start.min(sql.len());
    out.push((start, &sql[start..]));
    out.into_iter()
        .filter(|(_, s)| {
            let mut rest = *s;
            loop {
                rest = rest.trim_start();
                if let Some(after) = rest.strip_prefix("--") {
                    rest = after.split_once('\n').map_or("", |(_, r)| r);
                } else if let Some(after) = rest.strip_prefix("/*") {
                    rest = after.split_once("*/").map_or("", |(_, r)| r);
                } else {
                    return !rest.is_empty();
                }
            }
        })
        .collect()
}

/// The path of a page: the server names it with a host of its own (as it sees itself), the driver asks
/// only the server of the profile – through a tunnel or a mapped port that is another address, and a
/// login must never follow an answer to another host.
fn page_path(uri: &str) -> Option<&str> {
    let at = uri.find("/v1/")?;
    let path = &uri[at..];
    (!path.contains(['\r', '\n', ' '])).then_some(path)
}

/// What one statement gave.
struct Answer {
    columns: Vec<Column>,
    rows: u64,
    truncated: bool,
    updated: Option<u64>,
}

impl Trino {
    fn head<B>(&self, mut request: ureq::RequestBuilder<B>) -> ureq::RequestBuilder<B> {
        let properties = self
            .properties
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(",");
        let prepared = self
            .prepared
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(",");
        for prefix in PREFIXES {
            let name = |what: &str| format!("{prefix}{what}");
            request = request
                .header(name("User"), &self.user)
                .header(name("Source"), "schema-commander")
                .header(name("Catalog"), &self.catalog)
                // `NONE` says that this client knows transactions
                .header(
                    name("Transaction-Id"),
                    self.transaction.as_deref().unwrap_or("NONE"),
                );
            if !self.schema.is_empty() {
                request = request.header(name("Schema"), &self.schema);
            }
            if !properties.is_empty() {
                request = request.header(name("Session"), &properties);
            }
            if !prepared.is_empty() {
                request = request.header(name("Prepared-Statement"), &prepared);
            }
        }
        if !self.password.expose().is_empty() {
            let login = format!("{}:{}", self.user, self.password.expose());
            request = request.header(
                "Authorization",
                format!("Basic {}", BASE64.encode(login.as_bytes())),
            );
        }
        request
    }

    /// Takes over what the server says the session now is.
    fn follow(&mut self, headers: &ureq::http::HeaderMap) {
        for prefix in PREFIXES {
            let all = |what: &str| -> Vec<String> {
                headers
                    .get_all(format!("{prefix}{what}"))
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .map(str::to_owned)
                    .collect()
            };
            if let Some(catalog) = all("Set-Catalog").pop() {
                self.catalog = catalog;
            }
            if let Some(schema) = all("Set-Schema").pop() {
                self.schema = schema;
            }
            for pair in all("Set-Session") {
                if let Some((key, value)) = pair.split_once('=') {
                    self.properties.insert(key.to_owned(), value.to_owned());
                }
            }
            for key in all("Clear-Session") {
                self.properties.remove(&key);
            }
            for pair in all("Added-Prepare") {
                if let Some((key, value)) = pair.split_once('=') {
                    self.prepared.insert(key.to_owned(), value.to_owned());
                }
            }
            for key in all("Deallocated-Prepare") {
                self.prepared.remove(&key);
            }
            if let Some(id) = all("Started-Transaction-Id").pop() {
                self.transaction = Some(id);
            }
            if !all("Clear-Transaction-Id").is_empty() {
                self.transaction = None;
            }
        }
    }

    /// The version the server names at `/v1/info` (open to everybody there); empty when it says none.
    fn info(&self) -> String {
        self.permit();
        let sent = self
            .agent
            .get(format!("{}/v1/info", self.base))
            .config()
            .timeout_global(Some(Duration::from_secs(10)))
            .build()
            .call();
        let Ok(mut response) = sent else {
            return String::new();
        };
        let text = response
            .body_mut()
            .with_config()
            .limit(64 * 1024)
            .read_to_string()
            .unwrap_or_default();
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                let version = v.get("nodeVersion")?.get("version")?.as_str()?;
                Some(clean(&version.chars().take(60).collect::<String>()))
            })
            .unwrap_or_default()
    }

    fn permit(&self) {
        if let Some(tunnel) = &self.tunnel {
            tunnel.permit();
        }
    }

    /// Ends a statement on the server: its next page is deleted.
    fn cancel(&self, path: &str) {
        self.permit();
        let _ = self
            .head(self.agent.delete(format!("{}{path}", self.base)))
            .config()
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .call();
    }

    /// One answer of the server as JSON; a busy server (503) is asked again, as the protocol wants it.
    fn page(&mut self, path: Option<&str>, body: &str, extra: Option<&str>) -> AppResult<Value> {
        let mut tries = 0;
        loop {
            self.permit();
            let sent = match path {
                None => {
                    let mut request =
                        self.head(self.agent.post(format!("{}/v1/statement", self.base)));
                    if let Some(prepared) = extra {
                        for prefix in PREFIXES {
                            request =
                                request.header(format!("{prefix}Prepared-Statement"), prepared);
                        }
                    }
                    request
                        .config()
                        .timeout_global(Some(REQUEST_TIMEOUT))
                        .build()
                        .send(body)
                }
                Some(path) => self
                    .head(self.agent.get(format!("{}{path}", self.base)))
                    .config()
                    .timeout_global(Some(REQUEST_TIMEOUT))
                    .build()
                    .call(),
            };
            let mut response = sent.map_err(|e| transport(&self.on, &e))?;
            let status = response.status().as_u16();
            if matches!(status, 502..=504) && tries < 20 {
                tries += 1;
                std::thread::sleep(Duration::from_millis(100 * tries));
                continue;
            }
            let text = response
                .body_mut()
                .with_config()
                .limit(MAX_PAGE)
                .lossy_utf8(true)
                .read_to_string()
                .map_err(|e| transport(&self.on, &e))?;
            if status != 200 {
                return Err(refused(&self.on, status, &text));
            }
            let headers = response.headers().clone();
            self.follow(&headers);
            return serde_json::from_str(&text).map_err(|_| {
                AppError::new(
                    ErrorCode::ConnectionFailed,
                    format!("{}: the answer of the server could not be read", self.on),
                )
            });
        }
    }

    /// Runs one statement: page by page into the sink, looking at the stop sign and the clock between
    /// two pages.
    fn one(
        &mut self,
        sql: &str,
        values: &[String],
        timeout: Option<Duration>,
        sink: &mut dyn RowSink,
        plain: bool,
        stop: Stop,
    ) -> AppResult<Answer> {
        let started = Instant::now();
        let (body, extra) = if values.is_empty() {
            (sql.to_owned(), None)
        } else {
            if sql.len() > MAX_PREPARED_LEN {
                return Err(AppError::new(
                    ErrorCode::InvalidQuery,
                    "a statement with values is too long for Trino (48 KB at most)",
                ));
            }
            (
                format!("EXECUTE {PREPARED} USING {}", values.join(", ")),
                Some(format!("{PREPARED}={}", encode(sql))),
            )
        };
        let mut answer = Answer {
            columns: Vec::new(),
            rows: 0,
            truncated: false,
            updated: None,
        };
        let mut page = self.page(None, &body, extra.as_deref())?;
        loop {
            if let Some(error) = page.get("error") {
                return Err(failed(error, sql));
            }
            if answer.columns.is_empty()
                && let Some(columns) = page.get("columns").and_then(Value::as_array)
                && !columns.is_empty()
            {
                answer.columns = columns
                    .iter()
                    .map(|c| {
                        let type_name = c.get("type").and_then(Value::as_str).unwrap_or_default();
                        Column {
                            name: c
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned(),
                            kind: kind_of(type_name),
                            type_name: type_name.to_owned(),
                        }
                    })
                    .collect();
            }
            if let Some(count) = page.get("updateCount").and_then(Value::as_u64) {
                answer.updated = Some(count);
            }
            let next = page
                .get("nextUri")
                .and_then(Value::as_str)
                .map(|uri| {
                    page_path(uri).map(str::to_owned).ok_or_else(|| {
                        AppError::new(
                            ErrorCode::ConnectionFailed,
                            format!("{}: the answer of the server could not be read", self.on),
                        )
                    })
                })
                .transpose()?;
            // a statement that changes rows answers with their number as a row: not a result
            let changes = page.get("updateType").is_some();
            if let Some(Value::Array(rows)) = page.get_mut("data").map(Value::take)
                && !changes
            {
                if answer.rows == 0 && !rows.is_empty() {
                    sink.start(&answer.columns);
                }
                for row in rows {
                    let Value::Array(values) = row else { continue };
                    let cells = values
                        .into_iter()
                        .zip(&answer.columns)
                        .map(|(v, column)| {
                            let c = cell(v, column.kind);
                            if plain {
                                c.plain().map_or(Cell::Null, Cell::Text)
                            } else {
                                c
                            }
                        })
                        .collect();
                    answer.rows += 1;
                    if !sink.row(cells) {
                        answer.truncated = true;
                        break;
                    }
                }
            }
            let Some(next) = next else {
                break;
            };
            if answer.truncated {
                // no more rows are wanted: the server must not go on producing them
                self.cancel(&next);
                break;
            }
            if stop() {
                self.cancel(&next);
                return Err(super::cancelled());
            }
            if timeout.is_some_and(|t| started.elapsed() >= t) {
                self.cancel(&next);
                return Err(AppError::new(
                    ErrorCode::Timeout,
                    "the statement took too long",
                ));
            }
            page = self.page(Some(&next), "", None)?;
        }
        if changes_nothing(&answer) && !answer.columns.is_empty() && answer.rows == 0 {
            // a result without rows still has its columns
            sink.start(&answer.columns);
        }
        Ok(answer)
    }

    /// As [`Trino::one`], inside the read-only transaction of a session that only reads: opened when
    /// none is, and ended after an error (the server takes nothing more in a failed one).
    fn guarded(
        &mut self,
        sql: &str,
        values: &[String],
        timeout: Option<Duration>,
        sink: &mut dyn RowSink,
        plain: bool,
        stop: Stop,
    ) -> AppResult<Answer> {
        if !self.read_only {
            return self.one(sql, values, timeout, sink, plain, stop);
        }
        if self.transaction.is_none() {
            let mut nothing = super::value::VecSink::new(0);
            self.one(READ_ONLY, &[], timeout, &mut nothing, false, stop)?;
            if self.transaction.is_none() {
                return Err(AppError::new(
                    ErrorCode::PermissionDenied,
                    "the server opened no read-only transaction: nothing runs on this session",
                ));
            }
        }
        let result = self.one(sql, values, timeout, sink, plain, stop);
        if result.is_err() {
            let mut nothing = super::value::VecSink::new(0);
            let _ = self.one(
                "ROLLBACK",
                &[],
                Some(Duration::from_secs(10)),
                &mut nothing,
                false,
                &|| false,
            );
            // whatever the server made of it: the next statement opens a new one
            self.transaction = None;
        }
        result
    }
}

fn changes_nothing(answer: &Answer) -> bool {
    answer.updated.is_none()
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

impl Session for Trino {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        let values: Vec<String> = params.iter().map(|p| text_literal(p)).collect();
        let mut sink = TextSink(Vec::new());
        self.guarded(sql, &values, timeout, &mut sink, true, stop)?;
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
        if sql.len() > MAX_SQL_LEN {
            return Err(AppError::new(ErrorCode::InvalidQuery, "statement too long"));
        }
        let started = Instant::now();
        let values = params.iter().map(literal).collect::<AppResult<Vec<_>>>()?;
        // the session is made read only by the statement the guard names: from then on the driver
        // sees to it that there always is such a transaction
        if values.is_empty() && sql.trim().eq_ignore_ascii_case(READ_ONLY) {
            self.read_only = true;
            return Ok(Outcome {
                columns: Vec::new(),
                rows: 0,
                truncated: false,
                rows_affected: None,
                elapsed_ms: 0,
            });
        }
        // one statement per request: a text of several runs one after the other, the last one answers
        let mut statements = if values.is_empty() {
            split(sql)
        } else {
            vec![(0, sql)]
        };
        let Some((last_at, last)) = statements.pop() else {
            return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
        };
        let left = |started: Instant| limits.timeout.map(|t| t.saturating_sub(started.elapsed()));
        // a place the server names counts from the start of its statement: moved to where that
        // statement begins in the whole text
        let moved = |mut e: AppError, at: usize| {
            let before = u32::try_from(sql[..at].chars().count()).unwrap_or(0);
            let lines = u32::try_from(sql[..at].matches('\n').count()).unwrap_or(0);
            if let Some(d) = e.details.as_mut() {
                d.position = d.position.map(|p| p + before);
                d.line = d.line.map(|l| l + lines);
            }
            e
        };
        for (at, one) in statements {
            let mut nothing = super::value::VecSink::new(0);
            self.guarded(one, &[], left(started), &mut nothing, false, stop)
                .map_err(|e| moved(e, at))?;
        }
        let answer = self
            .guarded(last, &values, left(started), sink, false, stop)
            .map_err(|e| moved(e, last_at))?;
        Ok(Outcome {
            rows_affected: answer.updated,
            columns: if answer.updated.is_some() {
                Vec::new()
            } else {
                answer.columns
            },
            rows: answer.rows,
            truncated: answer.truncated,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    fn via_tunnel(&mut self, tunnel: Arc<crate::ssh::Tunnel>) {
        self.tunnel = Some(tunnel);
    }

    fn transaction_state(&mut self, _stop: Stop) -> TxState {
        // the server names the transaction it opened and says when it ended; the one a read-only
        // session lives in is not the user's
        if self.transaction.is_some() && !self.read_only {
            TxState::Active
        } else {
            TxState::Idle
        }
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        Ok(format!("{} {}", product(&self.version), self.version))
    }

    fn flavor(&self) -> super::Flavor {
        if product(&self.version) == "Presto" {
            super::Flavor::Presto
        } else {
            super::Flavor::Plain
        }
    }

    fn is_open(&self) -> bool {
        true
    }
}

/// Trino counts its versions in whole numbers (`476`), Presto writes `0.292`.
fn product(version: &str) -> &'static str {
    if version.trim().starts_with("0.") {
        "Presto"
    } else {
        "Trino"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_what_the_server_said_about_an_error() {
        let sql = "select 1;\nselect *\n  from nöpe";
        let e = failed(
            &json!({"message": "line 3:8: Table 'memory.shop.nöpe' does not exist", "errorCode": 46,
                "errorName": "TABLE_NOT_FOUND", "errorType": "USER_ERROR",
                "errorLocation": {"lineNumber": 3, "columnNumber": 8}}),
            sql,
        );
        assert_eq!(e.code, ErrorCode::InvalidQuery);
        assert!(e.message.contains("does not exist"));
        let d = e.details.unwrap();
        assert_eq!(d.sqlstate.as_deref(), Some("46 TABLE_NOT_FOUND"));
        assert_eq!(d.line, Some(3));
        // characters from 1: two lines of 10 and 9 characters with their breaks, then column 8
        assert_eq!(d.position, Some(10 + 9 + 8));
        assert_eq!(sql.chars().nth(26), Some('n'));
        let code = |name: &str| failed(&json!({"message": "m", "errorName": name}), "").code;
        assert_eq!(code("SYNTAX_ERROR"), ErrorCode::InvalidQuery);
        assert_eq!(code("CATALOG_NOT_FOUND"), ErrorCode::NotFound);
        assert_eq!(code("PERMISSION_DENIED"), ErrorCode::PermissionDenied);
        assert_eq!(code("READ_ONLY_VIOLATION"), ErrorCode::PermissionDenied);
        assert_eq!(code("USER_CANCELED"), ErrorCode::Cancelled);
        assert_eq!(code("EXCEEDED_TIME_LIMIT"), ErrorCode::Timeout);
        // no login is echoed, another server is named as such
        assert_eq!(
            refused("h", 401, "Basic realm: hunter2").message,
            "login failed"
        );
        let other = refused("h:80", 500, "<html>Oops</html>");
        assert_eq!(other.code, ErrorCode::ConnectionFailed);
        assert!(other.message.contains("500"));
    }

    #[test]
    fn knows_the_types() {
        assert_eq!(kind_of("integer"), ColKind::Int);
        assert_eq!(kind_of("decimal(10, 2)"), ColKind::Decimal);
        assert_eq!(kind_of("varchar(20)"), ColKind::Text);
        assert_eq!(kind_of("char(4)"), ColKind::Text);
        assert_eq!(kind_of("timestamp(6)"), ColKind::Timestamp);
        assert_eq!(kind_of("timestamp(3) with time zone"), ColKind::TimestampTz);
        assert_eq!(kind_of("timestamp with time zone"), ColKind::TimestampTz);
        assert_eq!(kind_of("time(3)"), ColKind::Time);
        assert_eq!(kind_of("time with time zone"), ColKind::Other);
        assert_eq!(kind_of("array(integer)"), ColKind::Json);
        assert_eq!(kind_of("row(a integer, b varchar)"), ColKind::Json);
        assert_eq!(kind_of("map(varchar(1), integer)"), ColKind::Json);
        assert_eq!(kind_of("INTERVAL DAY TO SECOND"), ColKind::Other);
        assert_eq!(kind_of("varbinary"), ColKind::Bytes);
        assert_eq!(kind_of("ipaddress"), ColKind::Other);
    }

    #[test]
    fn values_become_cells_without_losing_a_digit() {
        assert_eq!(
            cell(json!(9223372036854775807i64), ColKind::Int),
            Cell::I64(i64::MAX)
        );
        assert_eq!(
            cell(json!("12.50"), ColKind::Decimal),
            Cell::Decimal("12.50".into())
        );
        assert_eq!(cell(json!(1.5), ColKind::Float), Cell::F64(1.5));
        assert!(matches!(cell(json!("NaN"), ColKind::Float), Cell::F64(f) if f.is_nan()));
        assert!(
            matches!(cell(json!("-Infinity"), ColKind::Float), Cell::F64(f) if f.is_infinite() && f < 0.0)
        );
        assert_eq!(cell(Value::Null, ColKind::Text), Cell::Null);
        assert_eq!(
            cell(json!("AP8="), ColKind::Bytes),
            Cell::Bytes(2, vec![0, 255])
        );
        assert_eq!(
            cell(json!([1, "x"]), ColKind::Json),
            Cell::Json("[1,\"x\"]".into())
        );
        assert_eq!(
            cell(json!({"k": 1}), ColKind::Json),
            Cell::Json("{\"k\":1}".into())
        );
        assert_eq!(
            cell(json!("{\"a\":1}"), ColKind::Json),
            Cell::Json("{\"a\":1}".into())
        );
        assert!(matches!(
            cell(json!("2024-02-29"), ColKind::Date),
            Cell::Date(_)
        ));
        assert!(matches!(
            cell(json!("13:05:09.000"), ColKind::Time),
            Cell::Time(_)
        ));
        assert!(matches!(
            cell(json!("2024-02-29 13:05:09.250"), ColKind::Timestamp),
            Cell::Ts(_)
        ));
        assert!(matches!(
            cell(json!("2024-02-29 13:05:09.250 UTC"), ColKind::TimestampTz),
            Cell::TsTz(_)
        ));
        assert!(matches!(
            cell(
                json!("2024-02-29 13:05:09.250 +01:00"),
                ColKind::TimestampTz
            ),
            Cell::TsTz(_)
        ));
        // a zone by name is no offset: as it is written
        assert_eq!(
            cell(
                json!("2024-02-29 13:05:09.250 Europe/Berlin"),
                ColKind::TimestampTz
            ),
            Cell::Text("2024-02-29 13:05:09.250 Europe/Berlin".into())
        );
        assert_eq!(
            cell(json!("ab  "), ColKind::Text),
            Cell::Text("ab  ".into())
        );
    }

    #[test]
    fn writes_values_as_literals_nothing_can_leave() {
        let l = |b: Bind| literal(&b).unwrap();
        assert_eq!(l(Bind::Text("it's; -- \\ x".into())), "'it''s; -- \\ x'");
        assert_eq!(
            l(Bind::Text("'); DROP TABLE t; --".into())),
            "'''); DROP TABLE t; --'"
        );
        assert_eq!(l(Bind::Int(" -42 ".into())), "-42");
        assert_eq!(l(Bind::Decimal("-12.50".into())), "DECIMAL '-12.50'");
        assert_eq!(l(Bind::Bool(true)), "TRUE");
        assert_eq!(l(Bind::Date("2026-11-12".into())), "DATE '2026-11-12'");
        assert_eq!(
            l(Bind::Datetime("2026-11-12T08:30:00".into())),
            "TIMESTAMP '2026-11-12 08:30:00'"
        );
        for bad in [
            Bind::Int("1; drop".into()),
            Bind::Decimal("1e5".into()),
            Bind::Decimal("1' OR '1'='1".into()),
            Bind::Decimal(".".into()),
            Bind::Date("2026-11-12' OR '1'='1".into()),
            Bind::Datetime("now()".into()),
        ] {
            assert!(literal(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn splits_a_text_and_keeps_to_the_server_of_the_profile() {
        let parts: Vec<&str> =
            split("select 'a;b'';c'; select \"x;y\"; -- note;\n /* ; */ select 2")
                .into_iter()
                .map(|(_, s)| s.trim())
                .collect();
        assert_eq!(
            parts,
            [
                "select 'a;b'';c'",
                "select \"x;y\"",
                "-- note;\n /* ; */ select 2"
            ]
        );
        assert!(split(" ; -- nothing").is_empty());
        assert_eq!(split("a; b")[1], (2, " b"));
        assert_eq!(
            page_path("http://other.example:8080/v1/statement/executing/q1/y1/2"),
            Some("/v1/statement/executing/q1/y1/2")
        );
        assert_eq!(page_path("http://evil.example/steal"), None);
        assert_eq!(page_path("http://h/v1/x\r\nHost: evil"), None);
        assert_eq!(product("476"), "Trino");
        assert_eq!(product("0.292"), "Presto");
    }
}
