//! Cloudflare D1 over the REST API of Cloudflare (prompt 035h), with `ureq`. The dialect is SQLite's.
//!
//! A statement is one request to `…/d1/database/{id}/raw`; its whole answer comes back as one JSON
//! document. There is no session: every request stands for itself, nothing can hold a transaction open
//! (a text of several statements runs as one batch on the server), and nothing can stop a statement – a
//! request that is stopped is left behind on a thread of its own.
//!
//! **Written from Cloudflare's documentation, not run against Cloudflare** (it needs an account): the
//! tests talk to a server of their own that answers as the documentation says.

use super::http::transport;
use super::secrets::Secret;
use super::value::{Cell, ColKind, Column, Outcome, RowSink, text};
use super::{Bind, Limits, Profile, Session, Stop, TxState, clean};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::mpsc::{RecvTimeoutError, sync_channel};
use std::time::{Duration, Instant};
use ureq::Agent;

/// Longest statement accepted (bytes); D1 itself takes 100 KB.
pub const MAX_SQL_LEN: usize = 100 * 1024;
/// An answer at most (bytes).
const MAX_ANSWER: u64 = 256 * 1024 * 1024;
/// The host of the API when the profile names none.
pub const API_HOST: &str = "api.cloudflare.com";

struct Wire {
    agent: Agent,
    /// `https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/raw`.
    url: String,
    token: Secret,
    on: String,
    tunnel: parking_lot::Mutex<Option<Arc<crate::ssh::Tunnel>>>,
}

pub struct D1 {
    wire: Arc<Wire>,
    version: String,
}

/// An id of Cloudflare (account: 32 hex digits, database: a UUID) – it becomes part of the address,
/// so it is letters, digits and dashes or nothing.
fn id(what: &str, value: &str) -> AppResult<String> {
    let v = value.trim();
    if v.is_empty() || v.len() > 64 || !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            format!("D1 needs the {what}: letters, digits and dashes"),
        ));
    }
    Ok(v.to_owned())
}

/// What Cloudflare said: `{"success": false, "errors": [{"code": 7500, "message": "near \"selec\":
/// syntax error at offset 0: SQLITE_ERROR"}]}`.
fn failed(on: &str, status: u16, body: &str, sql: &str) -> AppError {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let first = parsed
        .as_ref()
        .and_then(|v| v.get("errors")?.as_array()?.first().cloned());
    let number = first.as_ref().and_then(|e| e.get("code")?.as_u64());
    let message = first
        .as_ref()
        .and_then(|e| e.get("message")?.as_str().map(str::to_owned));
    // a refused login never says with what
    if matches!(status, 401 | 403) || number == Some(10000) {
        return AppError::new(ErrorCode::AuthFailed, "login failed");
    }
    let Some(message) = message else {
        let said: String = body.chars().take(200).collect();
        return AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: HTTP {status} {}", clean(&said)),
        );
    };
    if status == 404 {
        return AppError::new(ErrorCode::NotFound, clean(&message));
    }
    if status == 429 || status >= 500 {
        return AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: HTTP {status} {}", clean(&message)),
        );
    }
    let code = if message.contains("SQLITE_AUTH") || message.contains("not authorized") {
        ErrorCode::PermissionDenied
    } else {
        ErrorCode::InvalidQuery
    };
    // `… at offset 7: SQLITE_ERROR` counts bytes from 0
    let position = message.split(" at offset ").nth(1).and_then(|rest| {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let offset = digits.parse::<usize>().ok()?;
        let before = sql.get(..offset.min(sql.len()))?;
        u32::try_from(before.chars().count() + 1).ok()
    });
    AppError::new(code, clean(&message)).with(ErrorDetails {
        sqlstate: number.map(|n| n.to_string()),
        position,
        ..Default::default()
    })
}

pub fn connect(profile: &Profile, secret: Option<&Secret>, stop: Stop) -> AppResult<D1> {
    let token = secret.map(Secret::expose).unwrap_or_default().trim();
    if token.is_empty() {
        return Err(AppError::new(
            ErrorCode::AuthFailed,
            "D1 needs an API token of Cloudflare: give it as the password",
        ));
    }
    if profile.tls == super::TlsMode::Off && !local(profile.host.trim()) {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "the token is sent only over TLS: switch TLS on",
        ));
    }
    let account = id("account id (as the user)", &profile.user)?;
    let database = id("id of the database", &profile.database)?;
    let wire = Arc::new(Wire {
        agent: super::http::agent(profile)?,
        url: format!(
            "{}/client/v4/accounts/{account}/d1/database/{database}/raw",
            super::http::base(profile)
        ),
        token: Secret::new(token),
        on: format!("{} (D1 {database})", profile.host.trim()),
        tunnel: parking_lot::Mutex::new(None),
    });
    let mut session = D1 {
        wire,
        version: String::new(),
    };
    // the first question says whether token, account and database are right
    let rows = session.ask(
        "SELECT sqlite_version()",
        &[],
        Some(super::CONNECT_TIMEOUT),
        stop,
    )?;
    session.version = rows
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next().flatten())
        .unwrap_or_default();
    Ok(session)
}

fn local(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

// --- values -------------------------------------------------------------------------------------------

/// A value of an answer. JSON has no integers beyond 2^53 and no bytes: a big integer comes rounded
/// (the API's doing), a BLOB as a list of its bytes.
fn cell(v: Value) -> Cell {
    match v {
        Value::Null => Cell::Null,
        Value::Bool(b) => Cell::I64(i64::from(b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Cell::I64(i),
            None => n.as_f64().map_or(Cell::Decimal(n.to_string()), Cell::F64),
        },
        Value::String(s) => Cell::Text(text(&s)),
        Value::Array(items) => {
            let bytes: Option<Vec<u8>> = items
                .iter()
                .map(|b| b.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect();
            match bytes {
                Some(bytes) => Cell::bytes(&bytes),
                None => Cell::Json(Value::Array(items).to_string()),
            }
        }
        other @ Value::Object(_) => Cell::Json(other.to_string()),
    }
}

/// There are no declared types in an answer: a column is what its first value is.
fn kind_of(c: &Cell) -> Option<ColKind> {
    Some(match c {
        Cell::Null => return None,
        Cell::I64(_) => ColKind::Int,
        Cell::F64(_) => ColKind::Float,
        Cell::Text(_) => ColKind::Text,
        Cell::Bytes(..) => ColKind::Bytes,
        Cell::Json(_) => ColKind::Json,
        _ => ColKind::Other,
    })
}

/// A value as the API binds it – a text, as its documentation asks: SQLite reads it as what the column
/// is it is compared with.
fn param(bind: &Bind) -> AppResult<Value> {
    Ok(Value::String(match bind {
        Bind::Text(v) | Bind::Date(v) | Bind::Datetime(v) => v.clone(),
        Bind::Int(v) => Bind::int(v)?.to_string(),
        Bind::Decimal(v) => {
            Bind::float(v)?;
            v.trim().to_owned()
        }
        Bind::Bool(v) => if *v { "1" } else { "0" }.to_owned(),
    }))
}

/// What one request gave: the answer to the last statement of its text.
struct Answer {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    changes: u64,
}

impl Wire {
    /// One request; the answer to the last statement of the text.
    fn request(&self, sql: &str, params: &[Value]) -> AppResult<Answer> {
        if let Some(tunnel) = self.tunnel.lock().as_ref() {
            tunnel.permit();
        }
        let body = json!({"sql": sql, "params": params});
        let mut response = self
            .agent
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", self.token.expose()))
            .send(body.to_string().as_str())
            .map_err(|e| transport(&self.on, &e))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_ANSWER)
            .lossy_utf8(true)
            .read_to_string()
            .map_err(|e| transport(&self.on, &e))?;
        let unreadable = || {
            AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{}: the answer of the server could not be read", self.on),
            )
        };
        if !(200..300).contains(&status) {
            return Err(failed(&self.on, status, &text, sql));
        }
        let mut v: Value = serde_json::from_str(&text).map_err(|_| unreadable())?;
        if v.get("success").and_then(Value::as_bool) == Some(false) {
            return Err(failed(&self.on, 400, &text, sql));
        }
        let Some(Value::Array(mut results)) = v.get_mut("result").map(Value::take) else {
            return Err(unreadable());
        };
        let Some(mut last) = results.pop() else {
            return Ok(Answer {
                columns: Vec::new(),
                rows: Vec::new(),
                changes: 0,
            });
        };
        let changes = last
            .pointer("/meta/changes")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let columns = last
            .pointer("/results/columns")
            .and_then(Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .map(|n| n.as_str().unwrap_or_default().to_owned())
                    .collect()
            })
            .unwrap_or_default();
        let rows = match last.pointer_mut("/results/rows").map(Value::take) {
            Some(Value::Array(rows)) => rows
                .into_iter()
                .filter_map(|row| match row {
                    Value::Array(cells) => Some(cells),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        Ok(Answer {
            columns,
            rows,
            changes,
        })
    }
}

impl D1 {
    /// Runs a request on a thread of its own and waits for it, looking at the stop sign and the clock:
    /// nothing can end a statement on the server, so a request that is stopped is left behind.
    fn one(
        &self,
        sql: &str,
        params: Vec<Value>,
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<Answer> {
        let started = Instant::now();
        let (done, incoming) = sync_channel::<AppResult<Answer>>(1);
        let wire = Arc::clone(&self.wire);
        let text = sql.to_owned();
        let spawned = std::thread::Builder::new()
            .name("sc-d1".into())
            .spawn(move || {
                let _ = done.send(wire.request(&text, &params));
            });
        if spawned.is_err() {
            return Err(super::closed());
        }
        loop {
            match incoming.recv_timeout(Duration::from_millis(50)) {
                Ok(answer) => return answer,
                Err(RecvTimeoutError::Disconnected) => return Err(super::closed()),
                Err(RecvTimeoutError::Timeout) => {}
            }
            if stop() {
                return Err(super::cancelled());
            }
            if timeout.is_some_and(|t| started.elapsed() >= t) {
                return Err(AppError::new(
                    ErrorCode::Timeout,
                    "the statement took too long (the server cannot be told to stop it: it may still finish there)",
                ));
            }
        }
    }
}

impl Session for D1 {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        let params = params
            .iter()
            .map(|p| Value::String((*p).to_owned()))
            .collect();
        let answer = self.one(sql, params, timeout, stop)?;
        Ok(answer
            .rows
            .into_iter()
            .map(|row| row.into_iter().map(|v| cell(v).plain()).collect())
            .collect())
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
            return Err(AppError::new(
                ErrorCode::InvalidQuery,
                "statement too long (D1 takes 100 KB)",
            ));
        }
        let started = Instant::now();
        let params = params.iter().map(param).collect::<AppResult<Vec<_>>>()?;
        let answer = self.one(sql, params, limits.timeout, stop)?;
        let rows: Vec<Vec<Cell>> = answer
            .rows
            .into_iter()
            .map(|row| row.into_iter().map(cell).collect())
            .collect();
        let columns: Vec<Column> = answer
            .columns
            .into_iter()
            .enumerate()
            .map(|(i, name)| Column {
                name,
                kind: rows
                    .iter()
                    .find_map(|row| row.get(i).and_then(kind_of))
                    .unwrap_or(ColKind::Other),
                type_name: String::new(),
            })
            .collect();
        let mut sent = 0u64;
        let mut truncated = false;
        if !columns.is_empty() {
            sink.start(&columns);
            for row in rows {
                if row.len() != columns.len() {
                    continue;
                }
                sent += 1;
                if !sink.row(row) {
                    truncated = true;
                    break;
                }
            }
        }
        Ok(Outcome {
            rows_affected: columns.is_empty().then_some(answer.changes),
            columns,
            rows: sent,
            truncated,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    fn via_tunnel(&mut self, tunnel: Arc<crate::ssh::Tunnel>) {
        *self.wire.tunnel.lock() = Some(tunnel);
    }

    fn transaction_state(&mut self, _stop: Stop) -> TxState {
        // no request outlives itself: there is nothing a transaction could be open on
        TxState::Idle
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        Ok(format!("Cloudflare D1 (SQLite {})", self.version))
    }

    fn is_open(&self) -> bool {
        true
    }
}

#[cfg(test)]
#[path = "d1_tests.rs"]
mod tests;
