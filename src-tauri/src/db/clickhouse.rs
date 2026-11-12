//! ClickHouse over its HTTP interface (prompt 035d), with `ureq` – a small blocking client that is in the
//! tree already. A statement is one request; its rows come back as lines of JSON and go into the sink as
//! they arrive. There is no connection to hold: a session is the id the server keeps settings and
//! temporary tables under.
//!
//! ClickHouse has no transactions: [`Session::transaction_state`] is always idle, and what needs one
//! (editing rows, importing with a rollback) is not offered for it.

use super::secrets::Secret;
use super::value::{Cell, ColKind, Column, Outcome, RowSink, text};
use super::{Bind, Limits, Profile, Session, Stop, TlsMode, TxState, clean};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use chrono::{NaiveDate, NaiveDateTime};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use ureq::Agent;
use ureq::tls::{Certificate, ClientCert, PrivateKey, RootCerts, TlsConfig};

/// Longest statement accepted (bytes).
pub const MAX_SQL_LEN: usize = 16 * 1024 * 1024;
/// The format every result is asked in: names, types, then a line per row – every value as text, so
/// no digit is lost and no setting is needed (a read-only session may change none).
const FORMAT: &str = "TabSeparatedWithNamesAndTypes";

pub struct Click {
    /// The SSH tunnel this session runs through, if any: held so its listener outlives the session.
    tunnel: Option<Arc<crate::ssh::Tunnel>>,
    agent: Agent,
    /// `http://host:port/`.
    base: String,
    user: String,
    password: Secret,
    database: String,
    /// The server keeps `SET …` and temporary tables under it.
    session: String,
    on: String,
    version: String,
}

/// An id nobody else has: for a session and for every statement (to stop it by).
fn fresh_id(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!(
        "{prefix}-{:x}-{nanos:x}-{:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// What ClickHouse said: `Code: 62. DB::Exception: Syntax error: failed at position 14 (t) (line 1, col
/// 14): … (SYNTAX_ERROR) (version …)`.
fn failed(on: &str, status: u16, body: &str) -> AppError {
    let body = body.trim();
    // inside a result the message is one JSON string in an array
    let message = serde_json::from_str::<Vec<String>>(body)
        .ok()
        .and_then(|mut v| v.pop())
        .unwrap_or_else(|| body.to_owned());
    let number = message
        .strip_prefix("Code: ")
        .and_then(|rest| rest.split('.').next())
        .and_then(|n| n.trim().parse::<u32>().ok());
    let code = match (number, status) {
        (Some(516 | 192 | 193 | 194), _) | (None, 401 | 403) => ErrorCode::AuthFailed,
        (Some(81 | 60), _) if !message.contains("in scope") => ErrorCode::NotFound,
        (Some(497 | 164), _) => ErrorCode::PermissionDenied,
        (Some(394), _) => ErrorCode::Cancelled,
        (Some(159 | 160), _) => ErrorCode::Timeout,
        (Some(_), _) => ErrorCode::InvalidQuery,
        (None, _) => ErrorCode::ConnectionFailed,
    };
    if code == ErrorCode::AuthFailed {
        return AppError::new(code, "login failed");
    }
    if code == ErrorCode::ConnectionFailed {
        let said: String = message.chars().take(200).collect();
        return AppError::new(code, format!("{on}: HTTP {status} {}", clean(&said)));
    }
    // without the head and the version it ends with
    let said = message
        .split_once("DB::Exception: ")
        .map_or(message.as_str(), |(_, rest)| rest);
    let said = said
        .rsplit_once(" (version ")
        .map_or(said, |(before, _)| before);
    let after = |mark: &str| -> Option<u32> {
        let rest = message.split(mark).nth(1)?;
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    };
    let name = said
        .rsplit_once(" (")
        .map(|(_, name)| name.trim_end_matches(')').to_owned())
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_uppercase() || c == '_'));
    AppError::new(code, clean(said)).with(ErrorDetails {
        sqlstate: number.map(|n| match &name {
            Some(name) => format!("{n} {name}"),
            None => n.to_string(),
        }),
        position: after("failed at position "),
        line: after("(line "),
        ..Default::default()
    })
}

fn transport(on: &str, e: &ureq::Error) -> AppError {
    let said = clean(&e.to_string());
    let lower = said.to_lowercase();
    let code = if lower.contains("certificate") || lower.contains("tls") {
        ErrorCode::TlsFailed
    } else if matches!(e, ureq::Error::Timeout(_)) {
        ErrorCode::Timeout
    } else {
        ErrorCode::ConnectionFailed
    };
    AppError::new(code, format!("{on}: {said}"))
}

fn tls(profile: &Profile) -> AppResult<TlsConfig> {
    let read = |path: &str| {
        std::fs::read(path).map_err(|e| AppError::new(ErrorCode::TlsFailed, format!("{path}: {e}")))
    };
    let bad = |what: &str, e: ureq::Error| {
        AppError::new(
            ErrorCode::TlsFailed,
            format!("{what}: {}", clean(&e.to_string())),
        )
    };
    let mut config = TlsConfig::builder();
    // HTTPS has no „check the certificate but not the name“: both are checked or nothing is
    if profile.tls.unchecked() {
        config = config.disable_verification(true);
    }
    let ca = profile.ca_file.trim();
    if !ca.is_empty() {
        let pem = read(ca)?;
        let certs = ureq::tls::parse_pem(&pem)
            .filter_map(|item| match item {
                Ok(ureq::tls::PemItem::Certificate(c)) => Some(Ok(c)),
                Ok(_) => None,
                Err(e) => Some(Err(bad(ca, e))),
            })
            .collect::<AppResult<Vec<Certificate<'static>>>>()?;
        if certs.is_empty() {
            return Err(AppError::new(
                ErrorCode::TlsFailed,
                format!("{ca}: no certificate in this file"),
            ));
        }
        config = config.root_certs(RootCerts::new_with_certs(&certs));
    }
    let cert = profile.client_cert.trim();
    if !cert.is_empty() {
        let chain = Certificate::from_pem(&read(cert)?).map_err(|e| bad(cert, e))?;
        let key_file = profile.client_key.trim();
        let key = PrivateKey::from_pem(&read(key_file)?).map_err(|e| bad(key_file, e))?;
        config = config.client_cert(Some(ClientCert::new_with_certs(&[chain], key)));
    }
    Ok(config.build())
}

pub fn connect(profile: &Profile, secret: Option<&Secret>, stop: Stop) -> AppResult<Click> {
    super::install_crypto();
    let on = profile.where_label();
    let secure = profile.tls != TlsMode::Off;
    let mut config = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(super::CONNECT_TIMEOUT))
        .user_agent("schema-commander")
        .max_redirects(0);
    if secure {
        config = config.https_only(true).tls_config(tls(profile)?);
    }
    let mut click = Click {
        tunnel: None,
        agent: config.build().new_agent(),
        base: format!(
            "{}://{}:{}/",
            if secure { "https" } else { "http" },
            {
                let host = profile.host.trim();
                if host.contains(':') && !host.starts_with('[') {
                    format!("[{host}]")
                } else {
                    host.to_owned()
                }
            },
            profile.port_or_default()
        ),
        user: profile.user.trim().to_owned(),
        password: Secret::new(secret.map(Secret::expose).unwrap_or_default()),
        database: profile.database.trim().to_owned(),
        session: fresh_id("sc"),
        on,
        version: String::new(),
    };
    // the first question says whether host, login and database are right
    let rows = click.ask("SELECT version()", &[], Some(super::CONNECT_TIMEOUT), stop)?;
    click.version = rows
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next().flatten())
        .unwrap_or_default();
    Ok(click)
}

// --- types and values ---------------------------------------------------------------------------------

/// The type without what wraps it: `Nullable(LowCardinality(String))` → `String`.
fn inner(type_name: &str) -> &str {
    let mut t = type_name.trim();
    loop {
        let stripped = ["Nullable(", "LowCardinality("]
            .iter()
            .find_map(|w| t.strip_prefix(w).and_then(|rest| rest.strip_suffix(')')));
        match stripped {
            Some(rest) => t = rest.trim(),
            None => return t,
        }
    }
}

fn kind_of(type_name: &str) -> ColKind {
    let t = inner(type_name);
    let base = t.split('(').next().unwrap_or_default();
    match base {
        // a UInt64 beyond what an i64 holds stays exact text in its cell
        "Int8" | "Int16" | "Int32" | "Int64" | "UInt8" | "UInt16" | "UInt32" | "UInt64" => {
            ColKind::Int
        }
        "Int128" | "Int256" | "UInt128" | "UInt256" | "Decimal" | "Decimal32" | "Decimal64"
        | "Decimal128" | "Decimal256" => ColKind::Decimal,
        "Float32" | "Float64" | "BFloat16" => ColKind::Float,
        "Bool" => ColKind::Bool,
        "String" | "FixedString" | "Enum8" | "Enum16" | "Enum" | "IPv4" | "IPv6" => ColKind::Text,
        "Date" | "Date32" => ColKind::Date,
        // shown in the zone of the column or the server: a time as it is written there
        "DateTime" | "DateTime64" => ColKind::Timestamp,
        "UUID" => ColKind::Uuid,
        "JSON" | "Object" => ColKind::Json,
        _ => ColKind::Other,
    }
}

/// A field of a line as it was written: `\\N` is NULL, the backslash escapes tabs and line breaks.
fn field(raw: &str) -> Option<String> {
    if raw == "\\N" {
        return None;
    }
    if !raw.contains('\\') {
        return Some(raw.to_owned());
    }
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('0') => out.push('\0'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    Some(out)
}

fn cell(v: Option<String>, kind: ColKind) -> Cell {
    let Some(s) = v else {
        return Cell::Null;
    };
    match kind {
        // a UInt64 beyond what an i64 holds stays exact text
        ColKind::Int => s.parse().map_or(Cell::Decimal(s), Cell::I64),
        ColKind::Decimal => Cell::Decimal(s),
        ColKind::Float => s.parse().map_or(Cell::Text(s), Cell::F64),
        ColKind::Bool => match s.as_str() {
            "true" => Cell::Bool(true),
            "false" => Cell::Bool(false),
            _ => Cell::Text(s),
        },
        ColKind::Date => {
            NaiveDate::parse_from_str(&s, "%Y-%m-%d").map_or(Cell::Text(s), Cell::Date)
        }
        ColKind::Timestamp => NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S%.f")
            .map_or(Cell::Text(s), Cell::Ts),
        ColKind::Uuid => Cell::Uuid(s),
        ColKind::Json => Cell::Json(s),
        // arrays, tuples, maps: as the server writes them
        _ => Cell::Text(text(&s)),
    }
}

/// A text as the server reads a `param_…`: in its escaped form, where a backslash starts an escape
/// and a tab or a line break ends the value (review 035d 1).
fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\0' => out.push_str("\\0"),
            c => out.push(c),
        }
    }
    out
}

/// A value as the text of a `param_…` of the request; the placeholder says what it is.
fn param(bind: &Bind) -> AppResult<String> {
    Ok(match bind {
        Bind::Text(v) | Bind::Date(v) | Bind::Datetime(v) => escaped(v),
        Bind::Int(v) => Bind::int(v)?.to_string(),
        Bind::Decimal(v) => {
            let t = v.trim();
            let digits = t.strip_prefix(['-', '+']).unwrap_or(t);
            let plain = !digits.is_empty()
                && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
                && digits.matches('.').count() <= 1;
            if !plain {
                return Err(AppError::new(
                    ErrorCode::InvalidQuery,
                    format!(
                        "„{}“ is not a number",
                        t.chars().take(40).collect::<String>()
                    ),
                ));
            }
            t.to_owned()
        }
        Bind::Bool(v) => if *v { "true" } else { "false" }.to_owned(),
    })
}

/// The statements of a text: ClickHouse takes one per request. Strings know the backslash.
fn split(sql: &str) -> Vec<&str> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i) = (0, 0);
    while i < b.len() {
        match b[i] {
            quote @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < b.len() && b[i] != quote {
                    if b[i] == b'\\' {
                        i += 1;
                    }
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
        .filter(|s| {
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

/// What one request gave.
struct Answer {
    columns: Vec<Column>,
    rows: u64,
    truncated: bool,
    written: Option<u64>,
}

impl Click {
    fn request(
        &self,
        sql: &str,
        query_id: Option<&str>,
    ) -> ureq::RequestBuilder<ureq::typestate::WithBody> {
        let mut request = self
            .agent
            .post(&self.base)
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", self.password.expose())
            .query("default_format", FORMAT);
        if !self.database.is_empty() {
            request = request.query("database", &self.database);
        }
        if let Some(id) = query_id {
            request = request.query("query_id", id);
        }
        let _ = sql;
        request
    }

    /// Asks the server to end the statement with this id – without the session, which is busy with it.
    fn kill(&self, query_id: &str) {
        if let Some(tunnel) = &self.tunnel {
            tunnel.permit();
        }
        // the id is ours: letters, digits and dashes
        let sql = format!("KILL QUERY WHERE query_id = '{query_id}' ASYNC");
        let _ = self
            .request(&sql, None)
            .config()
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .send(sql.as_str());
    }

    #[allow(clippy::too_many_arguments)]
    fn one(
        &self,
        sql: &str,
        params: &[String],
        timeout: Option<Duration>,
        with_session: bool,
        query_id: &str,
        sink: &mut dyn RowSink,
        plain: bool,
    ) -> AppResult<Answer> {
        if let Some(tunnel) = &self.tunnel {
            tunnel.permit();
        }
        let mut request = self.request(sql, Some(query_id));
        if with_session {
            request = request
                .query("session_id", &self.session)
                .query("session_timeout", "3600");
        }
        // no `max_execution_time`: a setting, and a read-only session may change none – the watcher ends
        // a statement that takes too long
        for (i, value) in params.iter().enumerate() {
            request = request.query(format!("param_p{}", i + 1), value);
        }
        // with a time limit the request itself gives up some seconds after it, should the server not
        // answer the stop any more; without one a statement may run as long as it takes
        let mut response = match timeout {
            Some(t) => request
                .config()
                .timeout_global(Some(t + Duration::from_secs(15)))
                .build()
                .send(sql),
            None => request.send(sql),
        }
        .map_err(|e| transport(&self.on, &e))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let body = response
                .body_mut()
                .with_config()
                .limit(64 * 1024)
                .lossy_utf8(true)
                .read_to_string()
                .unwrap_or_default();
            return Err(failed(&self.on, status, &body));
        }
        let written = response
            .headers()
            .get("X-ClickHouse-Summary")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v.get("written_rows")?.as_str()?.parse::<u64>().ok());
        let mut lines = BufReader::with_capacity(256 * 1024, response.body_mut().as_reader());
        let mut line = String::new();
        let mut bytes: Vec<u8> = Vec::new();
        let mut next = |line: &mut String| -> AppResult<bool> {
            // a String of ClickHouse holds any bytes: what is no UTF-8 is shown as such, the query goes on
            bytes.clear();
            let read = lines.read_until(b'\n', &mut bytes).map_err(|e| {
                AppError::new(ErrorCode::ConnectionFailed, format!("{}: {e}", self.on))
            })?;
            line.clear();
            line.push_str(&String::from_utf8_lossy(&bytes));
            Ok(read > 0)
        };
        let cut = |line: &str| -> Vec<String> {
            line.trim_end_matches(['\n', '\r'])
                .split('\t')
                .map(str::to_owned)
                .collect()
        };
        if !next(&mut line)? || line.trim().is_empty() {
            return Ok(Answer {
                columns: Vec::new(),
                rows: 0,
                truncated: false,
                written,
            });
        }
        // an error before anything else is the whole answer
        if line.starts_with("Code: ") && line.contains("DB::Exception") {
            return Err(failed(&self.on, 200, &line));
        }
        let names = cut(&line);
        if !next(&mut line)? {
            return Err(failed(
                &self.on,
                200,
                "the answer of the server ended early",
            ));
        }
        let types = cut(&line);
        let columns: Vec<Column> = names
            .iter()
            .zip(&types)
            .map(|(name, t)| Column {
                name: field(name).unwrap_or_default(),
                kind: kind_of(t),
                type_name: field(t).unwrap_or_default(),
            })
            .collect();
        sink.start(&columns);
        let mut rows = 0u64;
        let mut truncated = false;
        while next(&mut line)? {
            let fields = cut(&line);
            // an error after the result has begun is a line of the server's own: no row of the result
            let message = line.starts_with("Code: ") && line.contains("DB::Exception");
            if message && (fields.len() != columns.len() || columns.len() == 1) {
                return Err(failed(&self.on, 200, &line));
            }
            if fields.len() != columns.len() {
                if line.trim().is_empty() {
                    continue;
                }
                return Err(AppError::new(
                    ErrorCode::InvalidQuery,
                    "the answer of the server could not be read",
                ));
            }
            let cells = fields
                .iter()
                .zip(&columns)
                .map(|(raw, column)| {
                    let c = cell(field(raw), column.kind);
                    if plain {
                        c.plain().map_or(Cell::Null, Cell::Text)
                    } else {
                        c
                    }
                })
                .collect();
            rows += 1;
            if !sink.row(cells) {
                truncated = true;
                // no more rows are wanted: the server must not go on producing them (and keep the
                // session busy with it)
                self.kill(query_id);
                break;
            }
        }
        Ok(Answer {
            columns,
            rows,
            truncated,
            written,
        })
    }

    /// Runs a statement while a watcher looks at the stop sign and the clock; stopped, the server is
    /// asked to end it and the answer is its „cancelled“.
    #[allow(clippy::too_many_arguments)]
    fn watched(
        &self,
        sql: &str,
        params: &[String],
        timeout: Option<Duration>,
        with_session: bool,
        sink: &mut dyn RowSink,
        plain: bool,
        stop: Stop,
    ) -> AppResult<Answer> {
        let started = Instant::now();
        let query_id = fresh_id("q");
        let done = AtomicBool::new(false);
        let stopped = AtomicBool::new(false);
        let late = AtomicBool::new(false);
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(Ordering::Relaxed) {
                    let over = timeout.is_some_and(|t| started.elapsed() >= t);
                    if over || stop() {
                        if over {
                            late.store(true, Ordering::Relaxed);
                        }
                        stopped.store(true, Ordering::Relaxed);
                        self.kill(&query_id);
                        // and again, should the statement only have started by now
                        for _ in 0..20 {
                            if done.load(Ordering::Relaxed) {
                                return;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    } else {
                        std::thread::sleep(Duration::from_millis(20));
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
            self.one(sql, params, timeout, with_session, &query_id, sink, plain)
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

impl Session for Click {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        let params: Vec<String> = params.iter().map(|p| escaped(p)).collect();
        let mut sink = TextSink(Vec::new());
        // in the session: what was set for it (read only) holds for the app's own questions too
        self.watched(sql, &params, timeout, true, &mut sink, true, stop)?;
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
        let sql = sql.trim();
        if sql.len() > MAX_SQL_LEN {
            return Err(AppError::new(ErrorCode::InvalidQuery, "statement too long"));
        }
        let started = Instant::now();
        let values = params.iter().map(param).collect::<AppResult<Vec<_>>>()?;
        // one statement per request: a text of several runs one after the other, the last one answers
        let mut statements = if values.is_empty() {
            split(sql)
        } else {
            vec![sql]
        };
        let Some(last) = statements.pop() else {
            return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
        };
        let left = |started: Instant| limits.timeout.map(|t| t.saturating_sub(started.elapsed()));
        for one in statements {
            let mut nothing = super::value::VecSink::new(0);
            self.watched(one, &[], left(started), true, &mut nothing, false, stop)?;
        }
        let answer = self.watched(last, &values, left(started), true, sink, false, stop)?;
        let reads =
            super::guard::classify(last, super::DbKind::Clickhouse) == super::guard::Class::Read;
        let inserts = last
            .trim_start()
            .get(..6)
            .is_some_and(|w| w.eq_ignore_ascii_case("insert"));
        Ok(Outcome {
            // the server counts what an INSERT wrote; other statements have no such number
            rows_affected: (answer.columns.is_empty() && !reads && inserts)
                .then_some(answer.written)
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
        // there are none
        TxState::Idle
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        Ok(format!("ClickHouse {}", self.version))
    }

    fn is_open(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_the_server_said_about_an_error() {
        let syntax = failed(
            "h:8123",
            400,
            "Code: 62. DB::Exception: Syntax error: failed at position 14 (t) (line 1, col 14): t. Expected alias cannot be here. (SYNTAX_ERROR) (version 25.8.33.6 (official build))",
        );
        assert_eq!(syntax.code, ErrorCode::InvalidQuery);
        assert!(
            syntax
                .message
                .starts_with("Syntax error: failed at position 14")
        );
        assert!(!syntax.message.contains("version"));
        let d = syntax.details.unwrap();
        assert_eq!(d.sqlstate.as_deref(), Some("62 SYNTAX_ERROR"));
        assert_eq!((d.position, d.line), (Some(14), Some(1)));
        // inside a result the message is a JSON string
        let inside = failed(
            "h",
            200,
            r#"["Code: 159. DB::Exception: Timeout exceeded: elapsed 1003 ms. (TIMEOUT_EXCEEDED) (version 1)"]"#,
        );
        assert_eq!(inside.code, ErrorCode::Timeout);
        assert_eq!(
            failed(
                "h",
                403,
                "Code: 516. DB::Exception: shop: Authentication failed: password is incorrect"
            )
            .code,
            ErrorCode::AuthFailed
        );
        assert!(
            !failed(
                "h",
                403,
                "Code: 516. DB::Exception: x: password is incorrect: hunter2"
            )
            .message
            .contains("hunter2")
        );
        assert_eq!(
            failed(
                "h",
                404,
                "Code: 81. DB::Exception: Database nope does not exist. (UNKNOWN_DATABASE)"
            )
            .code,
            ErrorCode::NotFound
        );
        assert_eq!(
            failed(
                "h",
                500,
                "Code: 164. DB::Exception: Cannot execute query in readonly mode. (READONLY)"
            )
            .code,
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            failed(
                "h",
                500,
                "Code: 394. DB::Exception: Query was cancelled. (QUERY_WAS_CANCELLED)"
            )
            .code,
            ErrorCode::Cancelled
        );
        // not ClickHouse at all
        let other = failed("h:80", 502, "<html>Bad Gateway</html>");
        assert_eq!(other.code, ErrorCode::ConnectionFailed);
        assert!(other.message.contains("502"));
    }

    #[test]
    fn knows_types_through_their_wrappers() {
        assert_eq!(inner("Nullable(LowCardinality(String))"), "String");
        assert_eq!(kind_of("Nullable(UInt32)"), ColKind::Int);
        assert_eq!(kind_of("UInt64"), ColKind::Int);
        assert_eq!(kind_of("Int128"), ColKind::Decimal);
        assert_eq!(kind_of("Decimal(10, 2)"), ColKind::Decimal);
        assert_eq!(kind_of("DateTime64(3, 'UTC')"), ColKind::Timestamp);
        assert_eq!(kind_of("Array(UInt8)"), ColKind::Other);
        assert_eq!(kind_of("LowCardinality(Nullable(String))"), ColKind::Text);
        assert_eq!(kind_of("Enum8('a' = 1)"), ColKind::Text);
    }

    #[test]
    fn values_become_cells_without_losing_a_digit() {
        let of = |raw: &str, kind: ColKind| cell(field(raw), kind);
        assert_eq!(
            of("18446744073709551615", ColKind::Int),
            Cell::Decimal("18446744073709551615".into())
        );
        assert_eq!(of("9223372036854775807", ColKind::Int), Cell::I64(i64::MAX));
        assert_eq!(of("12.50", ColKind::Decimal), Cell::Decimal("12.50".into()));
        assert_eq!(of("1.5", ColKind::Float), Cell::F64(1.5));
        assert!(matches!(of("nan", ColKind::Float), Cell::F64(f) if f.is_nan()));
        assert_eq!(of("\\N", ColKind::Text), Cell::Null);
        // the text „\N“ itself comes with its backslash doubled
        assert_eq!(of("\\\\N", ColKind::Text), Cell::Text("\\N".into()));
        assert_eq!(
            of("a\\tb\\nc\\\\d", ColKind::Text),
            Cell::Text("a\tb\nc\\d".into())
        );
        assert_eq!(of("[1,'x']", ColKind::Other), Cell::Text("[1,'x']".into()));
        assert_eq!(of("true", ColKind::Bool), Cell::Bool(true));
        assert!(matches!(of("2024-02-29", ColKind::Date), Cell::Date(_)));
        assert!(matches!(
            of("2024-02-29 13:05:09.250", ColKind::Timestamp),
            Cell::Ts(_)
        ));
        assert_eq!(
            of("0000-00-00", ColKind::Date),
            Cell::Text("0000-00-00".into())
        );
        assert_eq!(of("", ColKind::Text), Cell::Text(String::new()));
    }

    #[test]
    fn splits_a_text_and_spells_values() {
        assert_eq!(
            split("select 'a;b\\';c'; select `x;y`; -- note;\n /* ; */ select 2"),
            [
                "select 'a;b\\';c'",
                "select `x;y`",
                "-- note;\n /* ; */ select 2"
            ]
        );
        assert!(split(" ; -- nothing").is_empty());
        assert_eq!(param(&Bind::Decimal(" -12.50 ".into())).unwrap(), "-12.50");
        assert!(param(&Bind::Decimal("1e5; drop".into())).is_err());
        assert!(param(&Bind::Int("x".into())).is_err());
        // the server reads a value in its escaped form
        assert_eq!(
            param(&Bind::Text("C:\\temp\ta\nb".into())).unwrap(),
            "C:\\\\temp\\ta\\nb"
        );
        assert_eq!(escaped("\\N"), "\\\\N");
        assert_eq!(param(&Bind::Bool(true)).unwrap(), "true");
        assert_ne!(fresh_id("q"), fresh_id("q"));
        assert!(
            fresh_id("q")
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        );
    }
}
