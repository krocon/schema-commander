//! Google BigQuery over its REST API (prompt 035j), with `ureq`.
//!
//! A statement is a job: `POST …/projects/{project}/queries` starts it and answers with the first page
//! of rows, or says that it still runs; the driver then asks again (`GET …/queries/{job}`), page by page.
//! Between two requests it looks at the stop sign and the clock, and ends a job with `…/jobs/{job}/cancel`.
//! There is no connection and no session: every statement stands for itself.
//!
//! The login is a key file of a service account (the profile names its path as the client key): the
//! driver signs a short-lived assertion with it and trades that for a token at Google – nowhere else.
//! Values are bound as query parameters with their types.

use super::http::{encode, transport};
use super::secrets::Secret;
use super::value::{Cell, ColKind, Column, Outcome, RowSink, text};
use super::{Bind, Limits, Profile, Session, Stop, TxState, clean};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64_URL};
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use ureq::Agent;

/// Longest statement accepted (bytes); BigQuery itself takes a million characters.
pub const MAX_SQL_LEN: usize = 1_000_000;
/// The host of the API when the profile names none.
pub const API_HOST: &str = "bigquery.googleapis.com";
/// Where a service account trades its assertion for a token: this address and no other.
const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/bigquery";
/// How long the server may hold one request while a job runs.
const WAIT_MS: u64 = 2_000;
/// Rows asked for in one page.
const PAGE_ROWS: u64 = 10_000;
/// One request at most.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// A page at most (bytes); BigQuery itself stops at 10 MB a page.
const MAX_PAGE: u64 = 64 * 1024 * 1024;

/// The key of a service account, as its JSON file holds it.
struct Key {
    email: String,
    /// PKCS#8, DER.
    private: Vec<u8>,
}

struct Token {
    bearer: Secret,
    /// By the clock on the wall: a computer that slept has not stopped the time at Google.
    until: SystemTime,
}

pub struct BigQuery {
    agent: Agent,
    /// `https://bigquery.googleapis.com/bigquery/v2/projects/{project}`.
    base: String,
    /// `None`: a server on this machine that asks for no login (the emulator).
    key: Option<Key>,
    token: Option<Token>,
    /// Where the jobs run (`EU`, `US`, `europe-west3`); empty = where BigQuery puts them.
    location: String,
    on: String,
    tunnel: Option<Arc<crate::ssh::Tunnel>>,
}

fn local(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// A project id: letters, digits, dashes – and for old ones a domain before a colon. It becomes part of
/// an address.
fn project(value: &str) -> AppResult<String> {
    let v = value.trim();
    let ok = !v.is_empty()
        && !v.starts_with('.')
        && !v.contains("..")
        && v.len() <= 100
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '_'));
    if !ok {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "BigQuery needs the id of the project as the database",
        ));
    }
    Ok(encode(v))
}

/// Reads the key file of a service account. Its content never goes into a message.
fn read_key(path: &str) -> AppResult<Key> {
    let bad = |what: &str| AppError::new(ErrorCode::InvalidProfile, format!("{path}: {what}"));
    // a file, and a small one: not whatever a path of a profile may lead to
    let meta = std::fs::metadata(path).map_err(|e| bad(&e.to_string()))?;
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return Err(bad("not a key file (a file of at most 64 KB)"));
    }
    let bytes = std::fs::read(path).map_err(|e| bad(&e.to_string()))?;
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|_| bad("not the JSON key file of a service account"))?;
    let field = |name: &str| v.get(name).and_then(Value::as_str).unwrap_or_default();
    if field("type") != "service_account" {
        return Err(bad("not the key of a service account"));
    }
    // the assertion is good for an account: it is sent to Google's own address and no other
    if !field("token_uri").is_empty() && field("token_uri") != TOKEN_URI {
        return Err(bad("its token address is not Google's"));
    }
    let email = field("client_email").to_owned();
    let pem = field("private_key");
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .concat();
    let private = BASE64
        .decode(body.trim())
        .map_err(|_| bad("its private key cannot be read"))?;
    if email.is_empty() || private.is_empty() {
        return Err(bad("the e-mail or the private key is missing"));
    }
    Ok(Key { email, private })
}

/// The assertion a service account signs: who it is, what it wants, until when.
fn assertion(key: &Key, now: u64) -> AppResult<String> {
    let part = |v: &Value| BASE64_URL.encode(v.to_string());
    let head = part(&json!({"alg": "RS256", "typ": "JWT"}));
    let claims = part(&json!({
        "iss": key.email, "scope": SCOPE, "aud": TOKEN_URI, "iat": now, "exp": now + 3600,
    }));
    let signed = format!("{head}.{claims}");
    let bad = || {
        AppError::new(
            ErrorCode::AuthFailed,
            "the key of the service account cannot sign",
        )
    };
    let pair = ring::signature::RsaKeyPair::from_pkcs8(&key.private).map_err(|_| bad())?;
    let mut signature = vec![0u8; pair.public().modulus_len()];
    pair.sign(
        &ring::signature::RSA_PKCS1_SHA256,
        &ring::rand::SystemRandom::new(),
        signed.as_bytes(),
        &mut signature,
    )
    .map_err(|_| bad())?;
    Ok(format!("{signed}.{}", BASE64_URL.encode(signature)))
}

/// What BigQuery said: `{"error": {"code": 400, "message": "Syntax error: … at [1:8]", "errors":
/// [{"reason": "invalidQuery", "location": "query"}]}}`.
fn failed(on: &str, status: u16, error: &Value, sql: &str) -> AppError {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reason = error
        .pointer("/errors/0/reason")
        .or_else(|| error.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if message.is_empty() {
        return AppError::new(ErrorCode::ConnectionFailed, format!("{on}: HTTP {status}"));
    }
    let code = match (status, reason) {
        (401, _) | (_, "authError") => ErrorCode::AuthFailed,
        (403, _) | (_, "accessDenied") => ErrorCode::PermissionDenied,
        (_, "stopped") => ErrorCode::Cancelled,
        (_, "timeout") => ErrorCode::Timeout,
        (404, _) | (_, "notFound") if !message.contains(" at [") && !message.contains("[at ") => {
            ErrorCode::NotFound
        }
        (429 | 500..=599, _) => {
            return AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{on}: HTTP {status} {}", clean(message)),
            );
        }
        _ => ErrorCode::InvalidQuery,
    };
    if code == ErrorCode::AuthFailed {
        return AppError::new(code, "login failed");
    }
    // `… at [2:7]` (BigQuery), `… [at 2:7]` (the emulator): line and column, both from 1
    let place = message
        .rsplit_once(" at [")
        .or_else(|| message.rsplit_once("[at "))
        .and_then(|(_, rest)| {
            let (line, rest) = rest.split_once(':')?;
            let column: String = rest.chars().take_while(char::is_ascii_digit).collect();
            Some((
                line.trim().parse::<u32>().ok()?,
                column.parse::<u32>().ok()?,
            ))
        });
    let position = place.and_then(|(line, column)| {
        if line == 0 || column == 0 {
            return None;
        }
        let before: usize = sql
            .split('\n')
            .take(line as usize - 1)
            .map(|l| l.chars().count() + 1)
            .sum();
        u32::try_from(before).ok().map(|b| b + column)
    });
    AppError::new(code, clean(message)).with(ErrorDetails {
        sqlstate: (!reason.is_empty()).then(|| reason.to_owned()),
        position,
        line: place.map(|(line, _)| line),
        ..Default::default()
    })
}

pub fn connect(profile: &Profile, _secret: Option<&Secret>, stop: Stop) -> AppResult<BigQuery> {
    let host = profile.host.trim();
    let key_file = profile.client_key.trim();
    let key = if local(host) {
        // a server on this machine (the emulator, a test) is talked to without a login: a key would
        // get a real token from Google, and that token is never sent anywhere but to Google
        // (review 035j 1)
        if !key_file.is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                "a key file is given, but the host is this machine: the login of Google is sent to Google only",
            ));
        }
        None
    } else {
        // a key opens a project: it is used for Google, over TLS that checks who answers – against
        // the certificates this system trusts, not one a profile names
        if !host.eq_ignore_ascii_case(API_HOST) {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                format!("BigQuery is reached at {API_HOST}: the login is sent nowhere else"),
            ));
        }
        if !profile.tls.checks_server() || !profile.ca_file.trim().is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                "the login is sent only over TLS that checks the certificate of Google (no CA file of your own)",
            ));
        }
        if key_file.is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                "BigQuery needs the key file of a service account (JSON): name it as the client key",
            ));
        }
        Some(read_key(key_file)?)
    };
    // the client certificate fields carry the key file here: no TLS client certificate is meant
    let mut plain = profile.clone();
    plain.client_cert.clear();
    plain.client_key.clear();
    let mut bq = BigQuery {
        agent: super::http::agent(&plain)?,
        base: format!(
            "{}/bigquery/v2/projects/{}",
            super::http::base(profile),
            project(&profile.database)?
        ),
        key,
        token: None,
        location: profile.user.trim().to_owned(),
        on: format!("{host} ({})", profile.database.trim()),
        tunnel: None,
    };
    // the first question says whether project and login are right
    bq.ask("SELECT 1", &[], Some(super::CONNECT_TIMEOUT), stop)?;
    Ok(bq)
}

// --- types and values ---------------------------------------------------------------------------------

/// The kind of a field of the schema; a list or a record is shown as JSON.
fn kind_of(field: &Value) -> ColKind {
    let mode = field
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mode == "REPEATED" {
        return ColKind::Json;
    }
    match field
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "INTEGER" | "INT64" => ColKind::Int,
        "FLOAT" | "FLOAT64" => ColKind::Float,
        "NUMERIC" | "BIGNUMERIC" => ColKind::Decimal,
        "BOOLEAN" | "BOOL" => ColKind::Bool,
        "STRING" => ColKind::Text,
        "BYTES" => ColKind::Bytes,
        "DATE" => ColKind::Date,
        "TIME" => ColKind::Time,
        "DATETIME" => ColKind::Timestamp,
        "TIMESTAMP" => ColKind::TimestampTz,
        "JSON" | "RECORD" | "STRUCT" => ColKind::Json,
        _ => ColKind::Other,
    }
}

fn type_name(field: &Value) -> String {
    let name = field
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = match name {
        "INTEGER" => "INT64",
        "FLOAT" => "FLOAT64",
        "BOOLEAN" => "BOOL",
        "RECORD" => "STRUCT",
        other => other,
    };
    if field.get("mode").and_then(Value::as_str) == Some("REPEATED") {
        format!("ARRAY<{name}>")
    } else {
        name.to_owned()
    }
}

/// A list or a record of an answer (`{"v": [{"v": "1"}]}`, `{"f": [{"v": …}]}`) as plain JSON, with the
/// names of the fields.
fn nested(v: &Value, field: &Value, as_item: bool) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    let repeated = field.get("mode").and_then(Value::as_str) == Some("REPEATED");
    if repeated && !as_item {
        return Value::Array(
            v.as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| nested(item.get("v").unwrap_or(&Value::Null), field, true))
                        .collect()
                })
                .unwrap_or_default(),
        );
    }
    let kind = field
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(kind, "RECORD" | "STRUCT") {
        let fields = field
            .get("fields")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let cells = v
            .get("f")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut out = Map::new();
        for (f, c) in fields.iter().zip(cells.iter()) {
            out.insert(
                f.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                nested(c.get("v").unwrap_or(&Value::Null), f, false),
            );
        }
        return Value::Object(out);
    }
    // a leaf: numbers that JSON holds exactly as numbers, everything else as the text it came as
    match (kind, v.as_str()) {
        ("INTEGER" | "INT64", Some(s)) => s
            .parse::<i64>()
            .ok()
            .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
            .map_or_else(|| Value::String(s.to_owned()), Value::from),
        ("BOOLEAN" | "BOOL", Some(s)) => Value::Bool(s == "true"),
        _ => v.clone(),
    }
}

/// A value of a row: BigQuery writes everything as text.
fn cell(v: &Value, field: &Value) -> Cell {
    if v.is_null() {
        return Cell::Null;
    }
    let kind = kind_of(field);
    let Some(s) = v.as_str() else {
        return Cell::Json(nested(v, field, false).to_string());
    };
    let s = s.to_owned();
    match kind {
        ColKind::Int => s.parse().map_or(Cell::Decimal(s), Cell::I64),
        // NaN and the infinities come as words
        ColKind::Float => s.parse().map_or(Cell::Text(s), Cell::F64),
        ColKind::Decimal => Cell::Decimal(s),
        ColKind::Bool => match s.as_str() {
            "true" => Cell::Bool(true),
            "false" => Cell::Bool(false),
            _ => Cell::Text(s),
        },
        ColKind::Bytes => match BASE64.decode(s.as_bytes()) {
            Ok(bytes) => Cell::bytes(&bytes),
            Err(_) => Cell::Unreadable("BYTES".into()),
        },
        ColKind::Date => {
            NaiveDate::parse_from_str(&s, "%Y-%m-%d").map_or(Cell::Text(s), Cell::Date)
        }
        ColKind::Time => {
            NaiveTime::parse_from_str(&s, "%H:%M:%S%.f").map_or(Cell::Text(s), Cell::Time)
        }
        ColKind::Timestamp => NaiveDateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f")
            .map_or(Cell::Text(s), Cell::Ts),
        // microseconds since 1970 (asked for as a whole number), or seconds with a fraction
        ColKind::TimestampTz => instant(&s).map_or(Cell::Text(s), Cell::TsTz),
        ColKind::Json => Cell::Json(s),
        _ => Cell::Text(text(&s)),
    }
}

fn instant(s: &str) -> Option<DateTime<FixedOffset>> {
    let micros: i64 = match s.split_once('.') {
        None if !s.contains(['e', 'E']) => s.parse().ok()?,
        _ => {
            let seconds: f64 = s.parse().ok()?;
            (seconds * 1e6).round() as i64
        }
    };
    DateTime::from_timestamp_micros(micros).map(|t| t.fixed_offset())
}

/// A value as a parameter of the query: its type and its text.
fn parameter(bind: &Bind) -> AppResult<Value> {
    let (kind, value) = match bind {
        Bind::Text(v) => ("STRING", v.clone()),
        Bind::Int(v) => ("INT64", Bind::int(v)?.to_string()),
        Bind::Decimal(v) => {
            let t = v.trim();
            let digits = t.strip_prefix(['-', '+']).unwrap_or(t);
            let plain = digits.chars().any(|c| c.is_ascii_digit())
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
            // more digits than a NUMERIC holds (29 before, 9 behind the point): the wide one
            let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
            let wide = whole.trim_start_matches('0').len() > 29 || fraction.len() > 9;
            (if wide { "BIGNUMERIC" } else { "NUMERIC" }, t.to_owned())
        }
        Bind::Bool(v) => ("BOOL", v.to_string()),
        Bind::Date(v) => ("DATE", v.trim().to_owned()),
        // with a zone it is an instant, without one a date and time of no place in particular
        Bind::Datetime(v) => {
            let t = v.trim();
            let tail = t.get(10..).unwrap_or_default();
            if t.ends_with(['Z', 'z']) || tail.contains(['+', '-']) || tail.contains("UTC") {
                ("TIMESTAMP", t.to_owned())
            } else {
                ("DATETIME", t.replace('T', " "))
            }
        }
    };
    Ok(json!({"parameterType": {"type": kind}, "parameterValue": {"value": value}}))
}

/// The app's question for the datasets of the project. It is no statement: a query for them sees one
/// region only (`INFORMATION_SCHEMA.SCHEMATA` without one means the US), so the driver answers it with
/// the list the API keeps of all places (review 035j 7).
pub const DATASETS: &str = "-- datasets of the project";

/// What one statement gave.
struct Answer {
    columns: Vec<Column>,
    rows: u64,
    truncated: bool,
    changed: Option<u64>,
}

impl BigQuery {
    fn permit(&self) {
        if let Some(tunnel) = &self.tunnel {
            tunnel.permit();
        }
    }

    /// The token for a request; a new one when the old one is about to end.
    fn bearer(&mut self) -> AppResult<Option<String>> {
        let Some(key) = &self.key else {
            return Ok(None);
        };
        if let Some(token) = &self.token
            && token.until > SystemTime::now()
        {
            return Ok(Some(token.bearer.expose().to_owned()));
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let body = format!(
            "grant_type={}&assertion={}",
            encode("urn:ietf:params:oauth:grant-type:jwt-bearer"),
            encode(&assertion(key, now)?)
        );
        // Google's own address, with the roots of the system: never the host of the profile
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .https_only(true)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .new_agent();
        let mut response = agent
            .post(TOKEN_URI)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .send(body.as_str())
            .map_err(|e| transport("oauth2.googleapis.com", &e))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(64 * 1024)
            .read_to_string()
            .unwrap_or_default();
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let Some(token) = v.get("access_token").and_then(Value::as_str) else {
            // what Google says about a refused key names no secret (`invalid_grant: …`)
            let why = v
                .get("error_description")
                .or_else(|| v.get("error"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Err(AppError::new(
                ErrorCode::AuthFailed,
                format!("login failed (HTTP {status}) {}", clean(why))
                    .trim()
                    .to_owned(),
            ));
        };
        let seconds = v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
        self.token = Some(Token {
            bearer: Secret::new(token),
            until: SystemTime::now() + Duration::from_secs(seconds.saturating_sub(120)),
        });
        Ok(Some(token.to_owned()))
    }

    /// One request of the API; the answer as JSON, an error of the API as an error. A refused token
    /// is asked for anew, once.
    fn call(
        &mut self,
        post: bool,
        path: &str,
        body: Option<&Value>,
        sql: &str,
    ) -> AppResult<Value> {
        let had_token = self.token.is_some();
        match self.call_once(post, path, body, sql) {
            Err(e) if e.code == ErrorCode::AuthFailed && self.key.is_some() && had_token => {
                self.token = None;
                self.call_once(post, path, body, sql)
            }
            other => other,
        }
    }

    fn call_once(
        &mut self,
        post: bool,
        path: &str,
        body: Option<&Value>,
        sql: &str,
    ) -> AppResult<Value> {
        let bearer = self.bearer()?;
        self.permit();
        let url = format!("{}{path}", self.base);
        let sent = if post {
            let mut request = self
                .agent
                .post(&url)
                .header("Content-Type", "application/json");
            if let Some(bearer) = &bearer {
                request = request.header("Authorization", format!("Bearer {bearer}"));
            }
            request
                .config()
                .timeout_global(Some(REQUEST_TIMEOUT))
                .build()
                .send(
                    body.map_or_else(|| "{}".to_owned(), Value::to_string)
                        .as_str(),
                )
        } else {
            let mut request = self.agent.get(&url);
            if let Some(bearer) = &bearer {
                request = request.header("Authorization", format!("Bearer {bearer}"));
            }
            request
                .config()
                .timeout_global(Some(REQUEST_TIMEOUT))
                .build()
                .call()
        };
        let mut response = sent.map_err(|e| transport(&self.on, &e))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_PAGE)
            .lossy_utf8(true)
            .read_to_string()
            .map_err(|e| transport(&self.on, &e))?;
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if let Some(error) = v.get("error") {
            if status == 401 {
                // the token may have been taken back: the next request asks for a new one
                self.token = None;
            }
            return Err(failed(&self.on, status, error, sql));
        }
        if !(200..300).contains(&status) || v.is_null() {
            let said: String = text.chars().take(200).collect();
            return Err(AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{}: HTTP {status} {}", self.on, clean(&said)),
            ));
        }
        Ok(v)
    }

    /// Ends a job where it runs (review 035j 5: not where the profile says jobs run).
    fn cancel(&mut self, job: &str, place: &str) {
        let place = if place.is_empty() {
            String::new()
        } else {
            format!("?location={}", encode(place))
        };
        let path = format!("/jobs/{}/cancel{place}", encode(job));
        let _ = self.call(true, &path, None, "");
    }

    /// The datasets of the project, wherever they lie: one row each, its name.
    fn datasets(&mut self, stop: Stop) -> AppResult<super::TextRows> {
        let mut rows = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let path = match &token {
                Some(t) => format!("/datasets?maxResults=1000&pageToken={}", encode(t)),
                None => "/datasets?maxResults=1000".to_owned(),
            };
            let page = self.call(false, &path, None, "")?;
            for d in page
                .get("datasets")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                if let Some(name) = d
                    .pointer("/datasetReference/datasetId")
                    .and_then(Value::as_str)
                {
                    rows.push(vec![Some(name.to_owned())]);
                }
            }
            token = page
                .get("nextPageToken")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if token.is_none() || rows.len() >= 10_000 {
                break;
            }
            if stop() {
                return Err(super::cancelled());
            }
        }
        rows.sort();
        Ok(rows)
    }

    /// Runs one statement: starts the job, waits for it, reads its pages.
    fn one(
        &mut self,
        sql: &str,
        params: Vec<Value>,
        timeout: Option<Duration>,
        sink: &mut dyn RowSink,
        plain: bool,
        stop: Stop,
    ) -> AppResult<Answer> {
        let started = Instant::now();
        let mut body = json!({
            "query": sql,
            "useLegacySql": false,
            "timeoutMs": WAIT_MS,
            "maxResults": PAGE_ROWS,
            // an instant as a whole number of microseconds: no digit is lost in a fraction
            "formatOptions": {"useInt64Timestamp": true},
        });
        if !params.is_empty() {
            body["parameterMode"] = json!("POSITIONAL");
            body["queryParameters"] = Value::Array(params);
        }
        if !self.location.is_empty() {
            body["location"] = json!(self.location);
        }
        let page = self.call(true, "/queries", Some(&body), sql)?;
        let job = page
            .pointer("/jobReference/jobId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        // where this job runs: it is asked about again there (not remembered for the next one)
        let place = page
            .pointer("/jobReference/location")
            .and_then(Value::as_str)
            .map_or_else(|| self.location.clone(), str::to_owned);
        self.rest(page, &job, &place, sql, timeout, started, sink, plain, stop)
    }

    #[allow(clippy::too_many_arguments)]
    fn rest(
        &mut self,
        mut page: Value,
        job: &str,
        place: &str,
        sql: &str,
        timeout: Option<Duration>,
        started: Instant,
        sink: &mut dyn RowSink,
        plain: bool,
        stop: Stop,
    ) -> AppResult<Answer> {
        let again = |token: Option<&str>| -> String {
            let mut parts = vec![
                format!("timeoutMs={WAIT_MS}"),
                format!("maxResults={PAGE_ROWS}"),
                "formatOptions.useInt64Timestamp=true".to_owned(),
            ];
            if let Some(token) = token {
                parts.push(format!("pageToken={}", encode(token)));
            }
            if !place.is_empty() {
                parts.push(format!("location={}", encode(place)));
            }
            format!("/queries/{}?{}", encode(job), parts.join("&"))
        };
        let mut answer = Answer {
            columns: Vec::new(),
            rows: 0,
            truncated: false,
            changed: None,
        };
        let mut fields: Vec<Value> = Vec::new();
        let mut begun = false;
        loop {
            let complete = page
                .get("jobComplete")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            // `errors` in an answer that is one may be warnings of a job that worked (review 035j 6):
            // a job that failed answers with an error of its own, which `call` reads
            if !complete {
                if job.is_empty() {
                    return Err(AppError::new(
                        ErrorCode::ConnectionFailed,
                        format!("{}: the answer of the server could not be read", self.on),
                    ));
                }
                if stop() {
                    self.cancel(job, place);
                    return Err(super::cancelled());
                }
                if timeout.is_some_and(|t| started.elapsed() >= t) {
                    self.cancel(job, place);
                    return Err(AppError::new(
                        ErrorCode::Timeout,
                        "the statement took too long",
                    ));
                }
                page = self.call(false, &again(None), None, sql)?;
                continue;
            }
            if !begun {
                begun = true;
                fields = page
                    .pointer("/schema/fields")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                answer.columns = fields
                    .iter()
                    .map(|f| Column {
                        name: f
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        kind: kind_of(f),
                        type_name: type_name(f),
                    })
                    .collect();
                answer.changed = page.get("numDmlAffectedRows").and_then(|n| {
                    n.as_str()
                        .and_then(|s| s.parse().ok())
                        .or_else(|| n.as_u64())
                });
                if !answer.columns.is_empty() {
                    sink.start(&answer.columns);
                }
            }
            if let Some(rows) = page.get("rows").and_then(Value::as_array) {
                for row in rows {
                    let values = row.get("f").and_then(Value::as_array);
                    let cells: Vec<Cell> = fields
                        .iter()
                        .enumerate()
                        .map(|(i, field)| {
                            let v = values
                                .and_then(|v| v.get(i))
                                .and_then(|c| c.get("v"))
                                .unwrap_or(&Value::Null);
                            let c = cell(v, field);
                            if plain {
                                c.plain().map_or(Cell::Null, Cell::Text)
                            } else {
                                c
                            }
                        })
                        .collect();
                    answer.rows += 1;
                    if !sink.row(cells) {
                        // no more rows are wanted; the job itself is done, nothing is left running
                        answer.truncated = true;
                        return Ok(answer);
                    }
                }
            }
            let Some(token) = page
                .get("pageToken")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                return Ok(answer);
            };
            if stop() {
                return Err(super::cancelled());
            }
            if timeout.is_some_and(|t| started.elapsed() >= t) {
                return Err(AppError::new(
                    ErrorCode::Timeout,
                    "the statement took too long",
                ));
            }
            page = self.call(false, &again(Some(&token)), None, sql)?;
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

impl Session for BigQuery {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        if sql == DATASETS {
            return self.datasets(stop);
        }
        let params = params
            .iter()
            .map(|p| json!({"parameterType": {"type": "STRING"}, "parameterValue": {"value": p}}))
            .collect();
        let mut sink = TextSink(Vec::new());
        self.one(sql, params, timeout, &mut sink, true, stop)?;
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
        let params = params
            .iter()
            .map(parameter)
            .collect::<AppResult<Vec<_>>>()?;
        let answer = self.one(sql, params, limits.timeout, sink, false, stop)?;
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
        // every statement is a job of its own: there is nothing a transaction could be open on
        TxState::Idle
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        Ok("BigQuery".to_owned())
    }

    fn is_open(&self) -> bool {
        true
    }
}

#[cfg(test)]
#[path = "bigquery_tests.rs"]
mod tests;
