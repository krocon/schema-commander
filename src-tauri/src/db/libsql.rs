//! libSQL – a `sqld` server or a Turso database – over „Hrana over HTTP“ (prompt 035g), with `ureq`. The
//! dialect is SQLite's; what differs is the way there.
//!
//! A statement is one request to `/v3/cursor`: its rows come back as lines and go into the sink as they
//! arrive. Values are **bound** by the protocol. What makes a session is a *stream* of the server, named
//! by a `baton` that changes with every answer. The server drops a stream that was idle for some ten
//! seconds – and with it an open transaction. So while a transaction is open, a heartbeat asks the
//! stream how it is every few seconds; without one, a lost stream is simply opened anew.
//!
//! The protocol cannot stop a statement. A statement that is stopped is left behind: its request goes
//! on on a thread of its own until the server answers, the session takes a new stream.

use super::http::transport;
use super::secrets::Secret;
use super::value::{Cell, Column, Outcome, RowSink, text};
use super::{Bind, Limits, Profile, Session, Stop, TxState, clean};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, STANDARD_NO_PAD as BASE64_NO_PAD};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use ureq::Agent;

/// Longest statement accepted (bytes).
pub const MAX_SQL_LEN: usize = 16 * 1024 * 1024;
/// How often an open transaction is kept alive (the server drops a stream after about ten seconds).
const BEAT: Duration = Duration::from_secs(3);
/// A small request (heartbeat, state, close) at most.
const SMALL: Duration = Duration::from_secs(15);

/// What all requests of a session need, also the heartbeat's.
struct Wire {
    agent: Agent,
    /// `http://host:port`.
    base: String,
    /// `Basic …` or `Bearer …`; empty for a server without a login.
    login: Secret,
    on: String,
    tunnel: Mutex<Option<Arc<crate::ssh::Tunnel>>>,
    stream: Mutex<Stream>,
}

/// The stream of the server this session lives in.
#[derive(Default)]
struct Stream {
    /// The name of the stream for the next request; `None` = none is open (or one is in use).
    baton: Option<String>,
    /// A transaction is open, as the server said last.
    in_tx: bool,
    /// A request is on its way with the baton: the heartbeat keeps out.
    busy: bool,
    /// The stream was lost while a transaction was open: said once, with the next statement.
    lost_tx: bool,
    /// The session is gone: the heartbeat ends, whoever still holds the wire.
    closed: bool,
    used: Option<Instant>,
}

pub struct Libsql {
    wire: Arc<Wire>,
    version: String,
}

fn failed(code: &str, message: &str, sql: &str) -> AppError {
    let kind = match code {
        "SQLITE_AUTH" | "SQLITE_READONLY" | "SQLITE_PERM" => ErrorCode::PermissionDenied,
        "SQLITE_INTERRUPT" => ErrorCode::Cancelled,
        _ => ErrorCode::InvalidQuery,
    };
    let said = message
        .strip_prefix("SQLite error: ")
        .or_else(|| message.strip_prefix("SQL string could not be parsed: "))
        .or_else(|| message.strip_prefix("SQL input error: "))
        .unwrap_or(message);
    // the parser of the server names line and column: `syntax error around L1:6: …`
    let place = message.split_once(" around L").and_then(|(_, rest)| {
        let (line, rest) = rest.split_once(':')?;
        let column: String = rest.chars().take_while(char::is_ascii_digit).collect();
        Some((line.parse::<u32>().ok()?, column.parse::<u32>().ok()?))
    });
    // the server counts the column in bytes, the editor in characters
    let position = place
        .and_then(|(line, column)| {
            if line == 0 || column == 0 {
                return None;
            }
            let mut lines = sql.split('\n');
            let before: usize = lines
                .by_ref()
                .take(line as usize - 1)
                .map(|l| l.chars().count() + 1)
                .sum();
            let here = lines.next()?;
            let within = here.get(..(column as usize - 1).min(here.len()))?;
            u32::try_from(before + within.chars().count() + 1).ok()
        })
        .or_else(|| {
            // `… (at offset 7)`: bytes from the start of the statement, from 0
            let rest = message.split("(at offset ").nth(1)?;
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            let before = sql.get(..digits.parse::<usize>().ok()?.min(sql.len()))?;
            u32::try_from(before.chars().count() + 1).ok()
        });
    AppError::new(kind, clean(said)).with(ErrorDetails {
        sqlstate: (!code.is_empty()).then(|| code.to_owned()),
        position,
        line: place.map(|(line, _)| line),
        ..Default::default()
    })
}

/// An answer that is no answer of the protocol: a refused login, a lost stream, another server.
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

/// The server does not know the baton any more: the stream expired or the server was restarted.
fn stream_gone(status: u16, body: &str) -> bool {
    status == 400 && (body.contains("STREAM_EXPIRED") || body.contains("invalid baton"))
}

/// The cursor answers a statement it cannot read with a status of its own:
/// ``{"error": "Internal Error: `SQL string could not be parsed: …`"}``.
fn unreadable(body: &str) -> Option<String> {
    let said = serde_json::from_str::<Value>(body).ok()?;
    let said = said.get("error")?.as_str()?;
    let at = said.find("SQL string ")?;
    Some(said[at..].trim_end_matches('`').to_owned())
}

fn lost_transaction() -> AppError {
    AppError::new(
        ErrorCode::ConnectionFailed,
        "the server closed the session, and with it the open transaction: its changes are rolled back",
    )
}

/// An error that cost the stream while a transaction was open: said with what it cost. A stop is no
/// error for the user – the lost transaction is one.
fn with_lost_transaction(cause: AppError) -> AppError {
    let code = match cause.code {
        ErrorCode::Cancelled => ErrorCode::ConnectionFailed,
        other => other,
    };
    let mut e = AppError::new(
        code,
        format!(
            "{} – the session on the server ended with it, and with it the open transaction: its changes are rolled back",
            cause.message
        ),
    );
    e.details = cause.details;
    e
}

/// How the profile logs in: a token alone (Turso, `sqld` with a JWT key) as `Bearer`, a user with a
/// password as `Basic`.
fn login(profile: &Profile, secret: Option<&Secret>) -> Secret {
    let password = secret.map(Secret::expose).unwrap_or_default();
    let user = profile.user.trim();
    if password.is_empty() && user.is_empty() {
        Secret::new("")
    } else if user.is_empty() {
        Secret::new(format!("Bearer {}", password.trim()))
    } else {
        Secret::new(format!(
            "Basic {}",
            BASE64.encode(format!("{user}:{password}").as_bytes())
        ))
    }
}

pub fn connect(profile: &Profile, secret: Option<&Secret>, stop: Stop) -> AppResult<Libsql> {
    let login = login(profile, secret);
    if !login.is_empty() && profile.tls == super::TlsMode::Off && !local(profile.host.trim()) {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "a token or password is sent only over TLS (or to this machine): switch TLS on",
        ));
    }
    let wire = Arc::new(Wire {
        agent: super::http::agent(profile)?,
        base: super::http::base(profile),
        login,
        on: profile.where_label(),
        tunnel: Mutex::new(None),
        stream: Mutex::new(Stream::default()),
    });
    let mut session = Libsql {
        wire,
        version: String::new(),
    };
    // the first question says whether host and login are right
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
    beat(Arc::downgrade(&session.wire));
    Ok(session)
}

pub fn local(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// Keeps an open transaction alive for as long as the session lives.
fn beat(wire: Weak<Wire>) {
    let spawned = std::thread::Builder::new()
        .name("sc-libsql-beat".into())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let Some(wire) = wire.upgrade() else {
                    return;
                };
                let baton = {
                    let mut stream = wire.stream.lock();
                    if stream.closed {
                        return;
                    }
                    let due = stream.used.is_none_or(|at| at.elapsed() >= BEAT);
                    if stream.busy || !stream.in_tx || !due {
                        continue;
                    }
                    let Some(baton) = stream.baton.take() else {
                        continue;
                    };
                    stream.busy = true;
                    baton
                };
                let state = wire.autocommit(Some(baton));
                let mut stream = wire.stream.lock();
                stream.busy = false;
                stream.used = Some(Instant::now());
                match state {
                    Ok((Some(baton), autocommit)) => {
                        stream.baton = Some(baton);
                        stream.in_tx = !autocommit;
                    }
                    // no stream to go on with, or no answer: the transaction is gone
                    Ok((None, _)) | Err(_) => {
                        stream.baton = None;
                        stream.in_tx = false;
                        stream.lost_tx = true;
                    }
                }
            }
        });
    // without the thread a transaction lives ten seconds: the server says so when it is gone
    drop(spawned);
}

// --- values -------------------------------------------------------------------------------------------

/// A value of the protocol: `{"type": "integer", "value": "42"}` – an integer travels as text, so no
/// digit is lost.
fn cell(v: &Value) -> Cell {
    let kind = v.get("type").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "null" => Cell::Null,
        "integer" => match v.get("value") {
            Some(Value::String(s)) => s
                .parse()
                .map_or_else(|_| Cell::Decimal(s.clone()), Cell::I64),
            Some(Value::Number(n)) => n.as_i64().map_or(Cell::Decimal(n.to_string()), Cell::I64),
            _ => Cell::Unreadable("integer".into()),
        },
        // JSON has no infinity: the server writes null for one, and which it was is lost
        "float" => match v.get("value").and_then(Value::as_f64) {
            Some(f) => Cell::F64(f),
            None => Cell::Unreadable("float (not finite)".into()),
        },
        "text" => Cell::Text(text(
            v.get("value").and_then(Value::as_str).unwrap_or_default(),
        )),
        "blob" => {
            let encoded = v.get("base64").and_then(Value::as_str).unwrap_or_default();
            match BASE64_NO_PAD
                .decode(encoded.trim_end_matches('='))
                .or_else(|_| BASE64.decode(encoded))
            {
                Ok(bytes) => Cell::bytes(&bytes),
                Err(_) => Cell::Unreadable("blob".into()),
            }
        }
        other => Cell::Unreadable(other.chars().take(20).collect()),
    }
}

/// A value as the protocol binds it. SQLite has no decimals and no dates: numbers as it stores them,
/// the rest as text – as the driver for a file does.
fn arg(bind: &Bind) -> AppResult<Value> {
    Ok(match bind {
        Bind::Text(v) | Bind::Date(v) | Bind::Datetime(v) => json!({"type": "text", "value": v}),
        Bind::Int(v) => json!({"type": "integer", "value": Bind::int(v)?.to_string()}),
        Bind::Decimal(v) => json!({"type": "float", "value": Bind::float(v)?}),
        Bind::Bool(v) => json!({"type": "integer", "value": if *v { "1" } else { "0" }}),
    })
}

/// What a request on its own thread reports.
enum Event {
    /// The stream goes on under this name.
    Baton(Option<String>),
    Columns(Vec<Column>),
    Row(Vec<Cell>),
    Changed(u64),
    /// The server does not know the stream any more.
    Gone,
    Failed(AppError),
    Done,
}

impl Wire {
    fn permit(&self) {
        if let Some(tunnel) = self.tunnel.lock().as_ref() {
            tunnel.permit();
        }
    }

    fn post(
        &self,
        path: &str,
        timeout: Option<Duration>,
        body: &Value,
    ) -> AppResult<(u16, ureq::Body)> {
        self.permit();
        let mut request = self
            .agent
            .post(format!("{}{path}", self.base))
            .header("Content-Type", "application/json");
        if !self.login.is_empty() {
            request = request.header("Authorization", self.login.expose());
        }
        let sent = match timeout {
            Some(t) => request
                .config()
                .timeout_global(Some(t))
                .build()
                .send(body.to_string().as_str()),
            None => request.send(body.to_string().as_str()),
        };
        let response = sent.map_err(|e| transport(&self.on, &e))?;
        let status = response.status().as_u16();
        Ok((status, response.into_body()))
    }

    /// A small request of the pipeline; the answer as JSON, or what the server said instead.
    fn pipeline(&self, baton: Option<String>, requests: Value) -> Result<Value, (bool, AppError)> {
        let body = json!({"baton": baton, "requests": requests});
        let (status, mut answer) = self
            .post("/v3/pipeline", Some(SMALL), &body)
            .map_err(|e| (false, e))?;
        let text = answer
            .with_config()
            .limit(4 * 1024 * 1024)
            .lossy_utf8(true)
            .read_to_string()
            .map_err(|e| (false, transport(&self.on, &e)))?;
        if status != 200 {
            return Err((stream_gone(status, &text), refused(&self.on, status, &text)));
        }
        serde_json::from_str(&text).map_err(|_| {
            (
                false,
                AppError::new(
                    ErrorCode::ConnectionFailed,
                    format!("{}: the answer of the server could not be read", self.on),
                ),
            )
        })
    }

    /// Asks the stream whether it is outside of a transaction; answers with its next name.
    fn autocommit(&self, baton: Option<String>) -> Result<(Option<String>, bool), AppError> {
        let v = self
            .pipeline(baton, json!([{"type": "get_autocommit"}]))
            .map_err(|(_, e)| e)?;
        let Some(autocommit) = v
            .pointer("/results/0/response/is_autocommit")
            .and_then(Value::as_bool)
        else {
            return Err(AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{}: the answer of the server could not be read", self.on),
            ));
        };
        Ok((
            v.get("baton").and_then(Value::as_str).map(str::to_owned),
            autocommit,
        ))
    }

    /// One statement on the cursor of the server; what happens is reported as it arrives. Runs on a
    /// thread of its own: `left` says that nobody listens any more.
    fn cursor(
        &self,
        baton: Option<String>,
        sql: &str,
        args: &[Value],
        events: &SyncSender<Event>,
        left: &AtomicBool,
    ) {
        let say = |event: Event| events.send(event).is_ok() && !left.load(Ordering::Relaxed);
        let body = json!({
            "baton": baton,
            "batch": {"steps": [{"stmt": {"sql": sql, "args": args, "want_rows": true}}]},
        });
        let (status, answer) = match self.post("/v3/cursor", None, &body) {
            Ok(answer) => answer,
            Err(e) => {
                say(Event::Failed(e));
                return;
            }
        };
        let mut lines = BufReader::with_capacity(256 * 1024, answer.into_reader());
        if status != 200 {
            let mut body = String::new();
            let _ = std::io::Read::read_to_string(
                &mut std::io::Read::take(&mut lines, 64 * 1024),
                &mut body,
            );
            say(if stream_gone(status, &body) {
                Event::Gone
            } else if let Some(said) = unreadable(&body) {
                // the stream is gone with it; outside of a transaction nothing is lost
                Event::Failed(failed("SQL_PARSE_ERROR", &said, sql))
            } else {
                Event::Failed(refused(&self.on, status, &body))
            });
            return;
        }
        let mut line = String::new();
        let mut first = true;
        let mut columns = 0;
        loop {
            line.clear();
            match lines.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => {
                    say(Event::Failed(AppError::new(
                        ErrorCode::ConnectionFailed,
                        format!("{}: {e}", self.on),
                    )));
                    return;
                }
            }
            if line.trim().is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                say(Event::Failed(AppError::new(
                    ErrorCode::ConnectionFailed,
                    format!("{}: the answer of the server could not be read", self.on),
                )));
                return;
            };
            if first {
                // the head of the answer: the stream under its next name
                first = false;
                if !say(Event::Baton(
                    v.get("baton").and_then(Value::as_str).map(str::to_owned),
                )) {
                    return;
                }
                continue;
            }
            let ok = match v.get("type").and_then(Value::as_str).unwrap_or_default() {
                "step_begin" => {
                    let cols: Vec<Column> = v
                        .get("cols")
                        .and_then(Value::as_array)
                        .map(|cols| {
                            cols.iter()
                                .map(|c| {
                                    let decl = c.get("decltype").and_then(Value::as_str);
                                    Column {
                                        name: c
                                            .get("name")
                                            .and_then(Value::as_str)
                                            .unwrap_or_default()
                                            .to_owned(),
                                        kind: super::sqlite::kind(decl),
                                        type_name: decl.unwrap_or_default().to_owned(),
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    columns = cols.len();
                    say(Event::Columns(cols))
                }
                "row" => {
                    let cells: Vec<Cell> = v
                        .get("row")
                        .and_then(Value::as_array)
                        .map(|row| row.iter().map(cell).collect())
                        .unwrap_or_default();
                    if cells.len() != columns {
                        say(Event::Failed(AppError::new(
                            ErrorCode::ConnectionFailed,
                            format!("{}: the answer of the server could not be read", self.on),
                        )));
                        return;
                    }
                    say(Event::Row(cells))
                }
                "step_end" => say(Event::Changed(
                    v.get("affected_row_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                )),
                "step_error" | "error" => {
                    let error = v.get("error");
                    let field = |key: &str| {
                        error
                            .and_then(|e| e.get(key))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                    };
                    say(Event::Failed(failed(field("code"), field("message"), sql)));
                    return;
                }
                _ => true,
            };
            if !ok {
                return;
            }
        }
        say(Event::Done);
    }
}

/// What one statement gave.
struct Answer {
    columns: Vec<Column>,
    rows: u64,
    truncated: bool,
    changed: u64,
}

impl Libsql {
    /// Takes the stream for a request; a transaction the server dropped meanwhile is said here, once.
    fn take(&self, report: bool) -> AppResult<Option<String>> {
        let deadline = Instant::now() + SMALL;
        loop {
            let mut stream = self.wire.stream.lock();
            if stream.lost_tx && !report {
                // only a statement says it (and may then go on): the state is simply „none“
                return Err(lost_transaction());
            }
            if stream.lost_tx {
                stream.lost_tx = false;
                return Err(lost_transaction());
            }
            if !stream.busy {
                stream.busy = true;
                return Ok(stream.baton.take());
            }
            drop(stream);
            if Instant::now() >= deadline {
                return Err(super::closed());
            }
            // the heartbeat is on its way: a moment
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn give(&self, baton: Option<String>, in_tx: Option<bool>) {
        let mut stream = self.wire.stream.lock();
        stream.busy = false;
        stream.used = Some(Instant::now());
        if let Some(in_tx) = in_tx {
            stream.in_tx = in_tx && baton.is_some();
        }
        if baton.is_none() {
            stream.in_tx = false;
        }
        stream.baton = baton;
    }

    /// Runs one statement on a thread of its own and hands its rows to the sink. Stopped or out of
    /// time, the request is left behind and the session takes a new stream.
    fn one(
        &mut self,
        sql: &str,
        args: &[Value],
        timeout: Option<Duration>,
        sink: &mut dyn RowSink,
        stop: Stop,
    ) -> AppResult<Answer> {
        let started = Instant::now();
        let mut baton = self.take(true)?;
        let had_tx = self.wire.stream.lock().in_tx;
        if had_tx && baton.is_some() {
            // a statement the server cannot read costs the cursor its stream – and with it the open
            // transaction. So inside one the statement is shown to the server first: an error
            // there is an answer like any other, and the transaction lives on
            match self
                .wire
                .pipeline(baton.take(), json!([{"type": "describe", "sql": sql}]))
            {
                Ok(v) => {
                    baton = v.get("baton").and_then(Value::as_str).map(str::to_owned);
                    if let Some(error) = v.pointer("/results/0/error") {
                        let field =
                            |key: &str| error.get(key).and_then(Value::as_str).unwrap_or_default();
                        let e = failed(field("code"), field("message"), sql);
                        self.give(baton, None);
                        return Err(e);
                    }
                }
                Err((true, _)) => {
                    self.give(None, None);
                    return Err(lost_transaction());
                }
                Err((false, e)) => {
                    self.give(None, None);
                    return Err(with_lost_transaction(e));
                }
            }
        }
        // a stream that expired while nothing was open is simply opened anew – once
        for attempt in 0..2 {
            let (events, incoming) = sync_channel::<Event>(1024);
            let left = Arc::new(AtomicBool::new(false));
            {
                let wire = Arc::clone(&self.wire);
                let left = Arc::clone(&left);
                let (sql, args) = (sql.to_owned(), args.to_vec());
                let baton = baton.clone();
                let spawned = std::thread::Builder::new()
                    .name("sc-libsql".into())
                    .spawn(move || wire.cursor(baton, &sql, &args, &events, &left));
                if spawned.is_err() {
                    self.give(None, None);
                    return Err(super::closed());
                }
            }
            let mut answer = Answer {
                columns: Vec::new(),
                rows: 0,
                truncated: false,
                changed: 0,
            };
            let mut next: Option<String> = None;
            let mut gone = false;
            let leave = |this: &Self, e: AppError| {
                // nobody listens any more: whatever the stream held is given up with it
                left.store(true, Ordering::Relaxed);
                this.give(None, None);
                Err(if had_tx { with_lost_transaction(e) } else { e })
            };
            let outcome: AppResult<()> = loop {
                match incoming.recv_timeout(Duration::from_millis(50)) {
                    Ok(Event::Baton(b)) => next = b,
                    Ok(Event::Columns(columns)) => {
                        if !columns.is_empty() {
                            sink.start(&columns);
                        }
                        answer.columns = columns;
                    }
                    Ok(Event::Row(cells)) => {
                        if !answer.truncated {
                            answer.rows += 1;
                            if !sink.row(cells) {
                                answer.truncated = true;
                                if !had_tx {
                                    // no more rows are wanted and nothing hangs on the stream:
                                    // the request is left behind, the next statement opens a new one
                                    left.store(true, Ordering::Relaxed);
                                    self.give(None, None);
                                    return Ok(answer);
                                }
                                // inside a transaction the stream must live: the rest of the
                                // answer is read and dropped – until it ends or the work is stopped
                            }
                        }
                    }
                    Ok(Event::Changed(n)) => answer.changed = n,
                    Ok(Event::Gone) => {
                        gone = true;
                        break Ok(());
                    }
                    Ok(Event::Failed(e)) => break Err(e),
                    Ok(Event::Done) => break Ok(()),
                    Err(RecvTimeoutError::Disconnected) => {
                        break Err(AppError::new(
                            ErrorCode::ConnectionFailed,
                            format!("{}: the answer of the server ended early", self.wire.on),
                        ));
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                }
                if stop() {
                    return leave(self, super::cancelled());
                }
                if timeout.is_some_and(|t| started.elapsed() >= t) {
                    return leave(
                        self,
                        AppError::new(
                            ErrorCode::Timeout,
                            "the statement took too long (the server cannot be told to stop it: it may still finish there)",
                        ),
                    );
                }
            };
            if gone {
                if had_tx {
                    self.give(None, None);
                    return Err(lost_transaction());
                }
                if attempt == 0 && baton.is_some() {
                    baton = None;
                    continue;
                }
                self.give(None, None);
                return Err(super::closed());
            }
            return match outcome {
                Ok(()) => {
                    self.give(next, None);
                    Ok(answer)
                }
                // what the server said about the statement: the stream goes on – if it still has one
                // (a statement the cursor cannot read costs it)
                Err(e) if super::keeps_connection(e.code) => {
                    let lost = had_tx && next.is_none();
                    self.give(next, None);
                    Err(if lost { with_lost_transaction(e) } else { e })
                }
                Err(e) => {
                    self.give(None, None);
                    Err(if had_tx { with_lost_transaction(e) } else { e })
                }
            };
        }
        self.give(None, None);
        Err(super::closed())
    }

    /// Asks the server whether a transaction is open and remembers it for the heartbeat.
    fn refresh(&mut self) -> TxState {
        // a transaction the server dropped is none; saying so is left to the next statement
        let Ok(baton) = self.take(false) else {
            return TxState::Idle;
        };
        if baton.is_none() {
            // no stream, no transaction
            self.give(None, Some(false));
            return TxState::Idle;
        }
        match self.wire.autocommit(baton) {
            Ok((baton, autocommit)) => {
                self.give(baton, Some(!autocommit));
                if autocommit {
                    TxState::Idle
                } else {
                    TxState::Active
                }
            }
            Err(_) => {
                let had_tx = self.wire.stream.lock().in_tx;
                self.give(None, Some(false));
                if had_tx {
                    self.wire.stream.lock().lost_tx = true;
                }
                TxState::Idle
            }
        }
    }
}

/// A sink for the app's own questions: every row as text.
struct TextSink(super::TextRows);

impl RowSink for TextSink {
    fn start(&mut self, _columns: &[Column]) {}
    fn row(&mut self, cells: Vec<Cell>) -> bool {
        self.0.push(cells.iter().map(Cell::plain).collect());
        true
    }
}

impl Session for Libsql {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        let args: Vec<Value> = params
            .iter()
            .map(|p| json!({"type": "text", "value": p}))
            .collect();
        let mut sink = TextSink(Vec::new());
        self.one(sql, &args, timeout, &mut sink, stop)?;
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
        if sql.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
        }
        if sql.len() > MAX_SQL_LEN {
            return Err(AppError::new(ErrorCode::InvalidQuery, "statement too long"));
        }
        let started = Instant::now();
        let args = params.iter().map(arg).collect::<AppResult<Vec<_>>>()?;
        let result = self.one(sql, &args, limits.timeout, sink, stop);
        // whatever the statement did to the transaction: the server says, and the heartbeat hears it
        self.refresh();
        let answer = result?;
        Ok(Outcome {
            rows_affected: answer.columns.is_empty().then_some(answer.changed),
            columns: answer.columns,
            rows: answer.rows,
            truncated: answer.truncated,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    fn via_tunnel(&mut self, tunnel: Arc<crate::ssh::Tunnel>) {
        *self.wire.tunnel.lock() = Some(tunnel);
    }

    fn transaction_state(&mut self, _stop: Stop) -> TxState {
        self.refresh()
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        Ok(format!("libSQL (SQLite {})", self.version))
    }

    fn is_open(&self) -> bool {
        true
    }
}

impl Drop for Libsql {
    fn drop(&mut self) {
        // the stream is given back; an open transaction ends with it
        let baton = {
            let mut stream = self.wire.stream.lock();
            stream.closed = true;
            stream.in_tx = false;
            if stream.busy {
                return;
            }
            stream.baton.take()
        };
        if baton.is_some() {
            // not on this thread: whoever closes a connection must not wait for the network
            let wire = Arc::clone(&self.wire);
            let _ = std::thread::Builder::new()
                .name("sc-libsql-close".into())
                .spawn(move || {
                    let _ = wire.pipeline(baton, json!([{"type": "close"}]));
                });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_the_server_said_about_an_error() {
        let sql = "select 1;\nselec 2";
        let e = failed(
            "SQL_PARSE_ERROR",
            "SQL string could not be parsed: syntax error around L2:6: `selec`",
            sql,
        );
        assert_eq!(e.code, ErrorCode::InvalidQuery);
        assert!(e.message.starts_with("syntax error around"));
        let d = e.details.unwrap();
        assert_eq!(d.sqlstate.as_deref(), Some("SQL_PARSE_ERROR"));
        assert_eq!((d.line, d.position), (Some(2), Some(10 + 6)));
        let table = failed("SQLITE_UNKNOWN", "SQLite error: no such table: nope", "x");
        assert_eq!(table.message, "no such table: nope");
        assert_eq!(table.details.unwrap().position, None);
        assert_eq!(
            failed("SQLITE_AUTH", "SQLite error: not authorized", "").code,
            ErrorCode::PermissionDenied
        );
        assert_eq!(refused("h", 401, "token: hunter2").message, "login failed");
        assert!(stream_gone(
            400,
            r#"{"message":"The stream has expired due to inactivity","code":"STREAM_EXPIRED"}"#
        ));
        assert!(stream_gone(400, "Received an invalid baton"));
        assert!(!stream_gone(400, "something else"));
        assert!(!stream_gone(500, "STREAM_EXPIRED"));
        let said = unreadable(
            r#"{"error":"Internal Error: `SQL string could not be parsed: syntax error around L2:8: `t``"}"#,
        )
        .unwrap();
        let e = failed("SQL_PARSE_ERROR", &said, "SELECT 1\n  FRM t x y");
        assert_eq!(e.code, ErrorCode::InvalidQuery);
        assert_eq!(e.details.unwrap().position, Some(9 + 8));
        assert_eq!(unreadable("<html>500</html>"), None);
        // review 035g 2: also a text of several statements is a statement error
        let many = unreadable(
            r#"{"error":"Internal Error: `SQL string contains more than one statement`"}"#,
        )
        .unwrap();
        assert_eq!(failed("", &many, "").code, ErrorCode::InvalidQuery);
        // review 035g 10: the column counts bytes; inside a transaction the place is an offset
        let e = failed(
            "SQL_PARSE_ERROR",
            "SQL string could not be parsed: syntax error around L1:22: `x`",
            "select 'üüü' frm x y",
        );
        assert_eq!(e.details.unwrap().position, Some(19));
        let e = failed(
            "SQL_INPUT_ERROR",
            "SQL input error: near \"frm\": syntax error (at offset 16)",
            "select 'üüü' frm x y",
        );
        assert!(e.message.starts_with("near"));
        assert_eq!(e.details.unwrap().position, Some(14));
        // review 035g 2, 4: what cost the transaction is said with what it cost
        let lost = with_lost_transaction(crate::db::cancelled());
        assert_eq!(lost.code, ErrorCode::ConnectionFailed);
        assert!(lost.message.contains("rolled back"));
        let lost = with_lost_transaction(failed("X", "unsupported statement: VACUUM", ""));
        assert_eq!(lost.code, ErrorCode::InvalidQuery);
        assert!(lost.message.starts_with("unsupported statement: VACUUM –"));
    }

    #[test]
    fn values_cross_without_losing_a_digit() {
        assert_eq!(
            cell(&json!({"type": "integer", "value": "9223372036854775807"})),
            Cell::I64(i64::MAX)
        );
        assert_eq!(
            cell(&json!({"type": "float", "value": 2.5})),
            Cell::F64(2.5)
        );
        assert_eq!(
            cell(&json!({"type": "text", "value": "ü🚀"})),
            Cell::Text("ü🚀".into())
        );
        assert_eq!(cell(&json!({"type": "null"})), Cell::Null);
        // the server writes base64 without its padding
        assert_eq!(
            cell(&json!({"type": "blob", "base64": "AP8"})),
            Cell::bytes(&[0, 255])
        );
        assert_eq!(
            cell(&json!({"type": "blob", "base64": "AP8="})),
            Cell::bytes(&[0, 255])
        );
        assert!(matches!(
            cell(&json!({"type": "blob", "base64": "!!"})),
            Cell::Unreadable(_)
        ));
        assert_eq!(
            arg(&Bind::Int(" -42 ".into())).unwrap(),
            json!({"type": "integer", "value": "-42"})
        );
        assert_eq!(
            arg(&Bind::Text("'; DROP TABLE t; --".into())).unwrap(),
            json!({"type": "text", "value": "'; DROP TABLE t; --"})
        );
        assert_eq!(
            arg(&Bind::Bool(true)).unwrap(),
            json!({"type": "integer", "value": "1"})
        );
        assert_eq!(
            arg(&Bind::Decimal("12.5".into())).unwrap(),
            json!({"type": "float", "value": 12.5})
        );
        assert!(arg(&Bind::Int("x".into())).is_err());
    }

    #[test]
    fn a_login_is_a_token_or_a_user_with_a_password() {
        let mut p = crate::db::sqlite::demo_profile();
        p.user = String::new();
        assert!(login(&p, None).is_empty());
        assert_eq!(
            login(&p, Some(&Secret::new(" abc.def "))).expose(),
            "Bearer abc.def"
        );
        p.user = "shop".into();
        assert_eq!(
            login(&p, Some(&Secret::new("pw"))).expose(),
            format!("Basic {}", BASE64.encode("shop:pw"))
        );
        assert!(local("127.0.0.1") && local("localhost") && !local("db.example.com"));
    }
}
