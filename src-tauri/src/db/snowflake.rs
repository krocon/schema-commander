//! Snowflake over its SQL API (prompt 035k), with `ureq`.
//!
//! A statement is posted to `/api/v2/statements` and runs on its own (`async=true`); the driver asks for
//! its state until it is done, looks at the stop sign and the clock between two questions, and ends it
//! with `…/cancel`. A large result comes in partitions that are fetched one after the other. There is
//! no session: every statement stands for itself, with the defaults of the user (warehouse, role).
//!
//! The login is a token (a programmatic access token as the password of the profile) or a key pair (the
//! private key file as the client key of the profile): the driver signs a short-lived assertion with it.
//! Values are bound by the API (`bindings`).
//!
//! **Written from Snowflake's documentation, not run against Snowflake** (it needs an account): the
//! tests talk to a server of their own that answers as the documentation says.

use super::http::transport;
use super::secrets::Secret;
use super::value::{Cell, ColKind, Column, Outcome, RowSink, text};
use super::{Bind, Limits, Profile, Session, Stop, TxState, clean};
use crate::error::{AppError, AppResult, ErrorCode, ErrorDetails};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64_URL};
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime};
use serde_json::{Value, json};
use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use ureq::Agent;

/// Longest statement accepted (bytes).
pub const MAX_SQL_LEN: usize = 1_000_000;
/// One request at most.
/// How often a question that failed on the way is asked again (never the statement itself).
const RETRIES: u64 = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// A partition of a result at most (bytes, unpacked).
const MAX_PART: u64 = 256 * 1024 * 1024;
/// How the API is to write dates and times: as text one can read, with every digit.
const FORMATS: [(&str, &str); 7] = [
    ("DATE_OUTPUT_FORMAT", "YYYY-MM-DD"),
    ("TIME_OUTPUT_FORMAT", "HH24:MI:SS.FF9"),
    ("TIMESTAMP_NTZ_OUTPUT_FORMAT", "YYYY-MM-DD HH24:MI:SS.FF9"),
    (
        "TIMESTAMP_LTZ_OUTPUT_FORMAT",
        "YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM",
    ),
    (
        "TIMESTAMP_TZ_OUTPUT_FORMAT",
        "YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM",
    ),
    ("BINARY_OUTPUT_FORMAT", "HEX"),
    ("MULTI_STATEMENT_COUNT", "1"),
];

/// How the profile logs in.
enum Login {
    /// A programmatic access token.
    Token(Secret),
    /// A key pair: the assertion is signed anew when it is about to end.
    KeyPair {
        /// PKCS#8, DER.
        private: Vec<u8>,
        /// `ACCOUNT.USER`.
        subject: String,
        /// With the time it is good until, by the clock on the wall.
        signed: Option<(Secret, SystemTime)>,
    },
    /// A server on this machine that asks for none (a test).
    None,
}

pub struct Snowflake {
    agent: Agent,
    /// `https://account.snowflakecomputing.com`.
    base: String,
    login: Login,
    database: String,
    on: String,
    tunnel: Option<Arc<crate::ssh::Tunnel>>,
}

fn local(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// The account as an assertion names it: the first part of the host, without a region, in upper case,
/// periods as dashes (`xy12345.eu-central-1.snowflakecomputing.com` → `XY12345`).
fn account_of(host: &str) -> String {
    let lower = host.trim().to_ascii_lowercase();
    let name = lower
        .strip_suffix(".snowflakecomputing.com")
        .unwrap_or(&lower);
    let name = if name.contains(".global") {
        // a replicated account: `name-suffix.global` – without what follows the dash
        name.split('-').next().unwrap_or(name)
    } else {
        name.split('.').next().unwrap_or(name)
    };
    name.replace('.', "-").to_ascii_uppercase()
}

/// The private key of a key pair: PKCS#8 in a PEM file, without a passphrase.
fn read_key(path: &str) -> AppResult<Vec<u8>> {
    let bad = |what: &str| AppError::new(ErrorCode::InvalidProfile, format!("{path}: {what}"));
    // a file, and a small one: not whatever a path of a profile may lead to
    let meta = std::fs::metadata(path).map_err(|e| bad(&e.to_string()))?;
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return Err(bad("not a key file (a file of at most 64 KB)"));
    }
    let bytes = std::fs::read(path).map_err(|e| bad(&e.to_string()))?;
    let pem = String::from_utf8_lossy(&bytes);
    if pem.contains("ENCRYPTED") {
        return Err(bad(
            "the key is protected by a passphrase: this app reads only a key without one",
        ));
    }
    if !pem.contains("-----BEGIN PRIVATE KEY-----") {
        return Err(bad(
            "not a private key in PKCS#8 (-----BEGIN PRIVATE KEY-----)",
        ));
    }
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .concat();
    BASE64
        .decode(body.trim())
        .map_err(|_| bad("the private key cannot be read"))
}

/// The public key as `SubjectPublicKeyInfo`: what `ring` hands out is the bare `RSAPublicKey`, the
/// fingerprint Snowflake knows is taken over the wrapped form.
fn spki(rsa_public_key: &[u8]) -> Vec<u8> {
    fn der(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let n = content.len();
        if n < 0x80 {
            out.push(n as u8);
        } else {
            let bytes: Vec<u8> = n
                .to_be_bytes()
                .into_iter()
                .skip_while(|b| *b == 0)
                .collect();
            out.push(0x80 | bytes.len() as u8);
            out.extend(bytes);
        }
        out.extend_from_slice(content);
        out
    }
    // AlgorithmIdentifier { rsaEncryption, NULL }
    const RSA: [u8; 15] = [
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ];
    let mut bits = vec![0u8];
    bits.extend_from_slice(rsa_public_key);
    let mut inner = RSA.to_vec();
    inner.extend(der(0x03, &bits));
    der(0x30, &inner)
}

/// The assertion of a key pair: who it is (with the fingerprint of the public key), from when, until when.
fn assertion(private: &[u8], subject: &str, now: u64) -> AppResult<String> {
    let bad = || AppError::new(ErrorCode::AuthFailed, "the private key cannot sign");
    let pair = ring::signature::RsaKeyPair::from_pkcs8(private).map_err(|_| bad())?;
    let fingerprint = BASE64.encode(ring::digest::digest(
        &ring::digest::SHA256,
        &spki(pair.public().as_ref()),
    ));
    let part = |v: &Value| BASE64_URL.encode(v.to_string());
    let head = part(&json!({"alg": "RS256", "typ": "JWT"}));
    let claims = part(&json!({
        "iss": format!("{subject}.SHA256:{fingerprint}"), "sub": subject,
        "iat": now, "exp": now + 3540,
    }));
    let signed = format!("{head}.{claims}");
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

/// What Snowflake said: `{"code": "001003", "sqlState": "42000", "message": "SQL compilation error:\n
/// syntax error line 1 at position 7 unexpected 'FRM'.", "statementHandle": "…"}`.
fn failed(on: &str, status: u16, body: &Value, sql: &str) -> AppError {
    let field = |name: &str| body.get(name).and_then(Value::as_str).unwrap_or_default();
    let message = field("message");
    let code = field("code");
    if matches!(status, 401 | 403) || matches!(code, "390144" | "390303" | "390100" | "390101") {
        // why, as far as the number says it – never in the words of the server, which may quote what
        // was sent
        return AppError::new(
            ErrorCode::AuthFailed,
            match (code, status) {
                ("390144", _) => "login failed: the signed assertion was not accepted – check the clock \
                                  of this machine, the account in the host name and that the public key \
                                  is the user's (390144)"
                    .to_owned(),
                ("", 403) => "login failed: access refused (HTTP 403) – is the SQL API open to this \
                              user and this network?"
                    .to_owned(),
                ("", _) => "login failed".to_owned(),
                (code, _) if code.chars().all(|c| c.is_ascii_digit()) => {
                    format!("login failed ({code})")
                }
                _ => "login failed".to_owned(),
            },
        );
    }
    if message.is_empty() {
        return AppError::new(ErrorCode::ConnectionFailed, format!("{on}: HTTP {status}"));
    }
    if status == 429 || status >= 500 {
        return AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: HTTP {status} {}", clean(message)),
        );
    }
    let lower = message.to_lowercase();
    let kind = if code == "000604" || lower.contains("sql execution canceled") {
        ErrorCode::Cancelled
    } else if code == "000630"
        || lower.contains("statement reached its statement or warehouse timeout")
    {
        ErrorCode::Timeout
    } else if code == "003001" || lower.contains("insufficient privileges") {
        ErrorCode::PermissionDenied
    } else {
        ErrorCode::InvalidQuery
    };
    // `… line 2 at position 7 …`: the line from 1, the position in it from 0
    let after = |mark: &str| -> Option<u32> {
        let rest = lower.split(mark).nth(1)?;
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    };
    let line = after(" line ");
    let position = match (line, after(" at position ")) {
        (Some(line), Some(column)) if line >= 1 => {
            let before: usize = sql
                .split('\n')
                .take(line as usize - 1)
                .map(|l| l.chars().count() + 1)
                .sum();
            u32::try_from(before).ok().map(|b| b + column + 1)
        }
        _ => None,
    };
    let state = field("sqlState");
    AppError::new(kind, clean(message)).with(ErrorDetails {
        // there is no session a `USE WAREHOUSE` could last in: the warehouse is the user's default
        hint: lower.contains("no active warehouse").then(|| {
            "the user needs a default warehouse: ALTER USER … SET DEFAULT_WAREHOUSE = …".to_owned()
        }),
        sqlstate: match (state.is_empty(), code.is_empty()) {
            (false, false) => Some(format!("{state} / {code}")),
            (false, true) => Some(state.to_owned()),
            (true, false) => Some(code.to_owned()),
            (true, true) => None,
        },
        position,
        line,
        ..Default::default()
    })
}

pub fn connect(profile: &Profile, secret: Option<&Secret>, stop: Stop) -> AppResult<Snowflake> {
    let host = profile.host.trim();
    let token = secret.map(Secret::expose).unwrap_or_default().trim();
    let key_file = profile.client_key.trim();
    if !local(host) {
        // a login opens an account: it goes to Snowflake, over TLS that checks who answers
        let lower = host.to_ascii_lowercase();
        if !lower.ends_with(".snowflakecomputing.com")
            && !lower.ends_with(".snowflakecomputing.cn")
            && !lower.ends_with(".privatelink.snowflakecomputing.com")
        {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                "Snowflake is reached at <account>.snowflakecomputing.com: the login is sent nowhere else",
            ));
        }
        if !profile.tls.checks_server() || !profile.ca_file.trim().is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                "the login is sent only over TLS that checks the certificate of Snowflake (no CA file of your own)",
            ));
        }
    }
    if profile.database.trim().is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "Snowflake needs the database: its schemas are what the tree shows",
        ));
    }
    let login = if !key_file.is_empty() {
        Login::KeyPair {
            private: read_key(key_file)?,
            subject: format!(
                "{}.{}",
                account_of(host),
                profile.user.trim().to_uppercase()
            ),
            signed: None,
        }
    } else if !token.is_empty() {
        // a token opens the account wherever it is sent: only the tests talk to this machine
        if local(host) && !cfg!(test) {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                "Snowflake is reached at <account>.snowflakecomputing.com: the login is sent nowhere else",
            ));
        }
        Login::Token(Secret::new(token))
    } else if local(host) {
        Login::None
    } else {
        return Err(AppError::new(
            ErrorCode::AuthFailed,
            "Snowflake needs a programmatic access token (as the password) or the file of a private key (as the client key)",
        ));
    };
    // the client key field carries the key of the login here: no TLS client certificate is meant
    let mut plain = profile.clone();
    plain.client_cert.clear();
    plain.client_key.clear();
    let mut snow = Snowflake {
        agent: super::http::agent(&plain)?,
        base: super::http::base(profile),
        login,
        database: profile.database.trim().to_owned(),
        on: host.to_owned(),
        tunnel: None,
    };
    // the first question says whether account and login are right
    snow.ask("SELECT 1", &[], Some(super::CONNECT_TIMEOUT), stop)?;
    Ok(snow)
}

// --- types and values ---------------------------------------------------------------------------------

fn kind_of(field: &Value) -> ColKind {
    let scale = field.get("scale").and_then(Value::as_i64).unwrap_or(0);
    match field
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "fixed" if scale > 0 => ColKind::Decimal,
        "fixed" => ColKind::Int,
        "real" => ColKind::Float,
        "decfloat" => ColKind::Decimal,
        "text" => ColKind::Text,
        "boolean" => ColKind::Bool,
        "binary" => ColKind::Bytes,
        "date" => ColKind::Date,
        "time" => ColKind::Time,
        "timestamp_ntz" => ColKind::Timestamp,
        "timestamp_ltz" | "timestamp_tz" => ColKind::TimestampTz,
        "variant" | "object" | "array" => ColKind::Json,
        _ => ColKind::Other,
    }
}

fn type_name(field: &Value) -> String {
    let n = |name: &str| field.get(name).and_then(Value::as_i64).unwrap_or(0);
    let kind = field
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_uppercase();
    match kind.as_str() {
        "FIXED" => format!("NUMBER({}, {})", n("precision"), n("scale")),
        "REAL" => "FLOAT".to_owned(),
        "TEXT" if n("length") > 0 && n("length") < 16_777_216 => {
            format!("VARCHAR({})", n("length"))
        }
        "TEXT" => "VARCHAR".to_owned(),
        _ => kind,
    }
}

/// A value of a row: the API writes everything as text, in the formats the driver asked for.
fn cell(v: &Value, kind: ColKind) -> Cell {
    let s = match v {
        Value::Null => return Cell::Null,
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    match kind {
        // a NUMBER(38, 0) beyond what an i64 holds stays exact text
        ColKind::Int => s.parse().map_or(Cell::Decimal(s), Cell::I64),
        ColKind::Decimal => Cell::Decimal(s),
        ColKind::Float => s.parse().map_or(Cell::Text(s), Cell::F64),
        ColKind::Bool => match s.to_ascii_lowercase().as_str() {
            "true" | "1" => Cell::Bool(true),
            "false" | "0" => Cell::Bool(false),
            _ => Cell::Text(s),
        },
        ColKind::Bytes => {
            let bytes: Option<Vec<u8>> = (s.len() % 2 == 0)
                .then(|| {
                    (0..s.len())
                        .step_by(2)
                        .map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
                        .collect()
                })
                .flatten();
            bytes.map_or_else(|| Cell::Unreadable("BINARY".into()), |b| Cell::bytes(&b))
        }
        ColKind::Date => {
            NaiveDate::parse_from_str(&s, "%Y-%m-%d").map_or(Cell::Text(s), Cell::Date)
        }
        ColKind::Time => {
            NaiveTime::parse_from_str(&s, "%H:%M:%S%.f").map_or(Cell::Text(s), Cell::Time)
        }
        ColKind::Timestamp => NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S%.f")
            .map_or(Cell::Text(s), Cell::Ts),
        ColKind::TimestampTz => DateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S%.f %z")
            .map_or(Cell::Text(s), Cell::TsTz),
        ColKind::Json => Cell::Json(s),
        _ => Cell::Text(text(&s)),
    }
}

/// A value as the API binds it. A date travels as text, as the documentation asks: the server reads it
/// as what it is compared with.
fn binding(bind: &Bind) -> AppResult<Value> {
    let (kind, value) = match bind {
        Bind::Text(v) | Bind::Date(v) | Bind::Datetime(v) => ("TEXT", v.clone()),
        Bind::Int(v) => ("FIXED", Bind::int(v)?.to_string()),
        Bind::Decimal(v) => {
            let t = v.trim();
            let digits = t.strip_prefix(['-', '+']).unwrap_or(t);
            let plain = digits.chars().any(|c| c.is_ascii_digit())
                && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
                && digits.matches('.').count() <= 1;
            if !plain && t.contains(['e', 'E']) && t.parse::<f64>().is_ok_and(f64::is_finite) {
                return Ok(json!({"type": "REAL", "value": t}));
            }
            if !plain {
                return Err(AppError::new(
                    ErrorCode::InvalidQuery,
                    format!(
                        "„{}“ is not a number",
                        t.chars().take(40).collect::<String>()
                    ),
                ));
            }
            ("FIXED", t.to_owned())
        }
        Bind::Bool(v) => ("BOOLEAN", v.to_string()),
    };
    Ok(json!({"type": kind, "value": value}))
}

/// A statement that means the session – which the SQL API does not keep between two requests: a
/// transaction, `USE`, `ALTER SESSION`, a session variable. `BEGIN … END` (a block) is none of them.
fn needs_a_session(sql: &str) -> Option<&'static str> {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--").or_else(|| rest.strip_prefix("//")) {
            rest = after.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            break;
        }
    }
    let words: Vec<String> = rest
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
        .filter(|w| !w.is_empty())
        .take(2)
        .map(str::to_ascii_uppercase)
        .collect();
    let second = words.get(1).map_or("", String::as_str);
    // what follows the first word directly: `BEGIN;` and `BEGIN` alone open a transaction
    let alone = rest
        .trim_end()
        .trim_end_matches(';')
        .trim_end()
        .chars()
        .all(|c| c.is_ascii_alphabetic());
    match words.first().map_or("", String::as_str) {
        "BEGIN" if alone || matches!(second, "TRANSACTION" | "WORK" | "NAME") => {
            Some("a transaction")
        }
        "START" if second == "TRANSACTION" => Some("a transaction"),
        "COMMIT" | "ROLLBACK" => Some("a transaction"),
        "USE" => Some("USE"),
        "ALTER" if second == "SESSION" => Some("ALTER SESSION"),
        "SET" | "UNSET" => Some("a session variable"),
        _ => None,
    }
}

/// What one statement gave.
struct Answer {
    columns: Vec<Column>,
    rows: u64,
    truncated: bool,
    changed: Option<u64>,
}

impl Snowflake {
    fn permit(&self) {
        if let Some(tunnel) = &self.tunnel {
            tunnel.permit();
        }
    }

    /// `Authorization` and what kind of token it is.
    fn bearer(&mut self) -> AppResult<Option<(String, &'static str)>> {
        match &mut self.login {
            Login::None => Ok(None),
            Login::Token(token) => Ok(Some((
                token.expose().to_owned(),
                "PROGRAMMATIC_ACCESS_TOKEN",
            ))),
            Login::KeyPair {
                private,
                subject,
                signed,
            } => {
                if let Some((token, until)) = signed
                    && *until > SystemTime::now()
                {
                    return Ok(Some((token.expose().to_owned(), "KEYPAIR_JWT")));
                }
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                let token = assertion(private, subject, now)?;
                *signed = Some((
                    Secret::new(token.clone()),
                    SystemTime::now() + Duration::from_secs(3000),
                ));
                Ok(Some((token, "KEYPAIR_JWT")))
            }
        }
    }

    /// One request; the status and the body as JSON (a partition comes packed).
    fn call(&mut self, method: &str, path: &str, body: Option<&Value>) -> AppResult<(u16, Value)> {
        let bearer = self.bearer()?;
        self.permit();
        let url = format!("{}{path}", self.base);
        let head = |mut request: ureq::http::request::Builder| {
            request = request
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header("User-Agent", "schema-commander/1.0");
            if let Some((token, kind)) = &bearer {
                request = request
                    .header("Authorization", format!("Bearer {token}"))
                    .header("X-Snowflake-Authorization-Token-Type", *kind);
            }
            request
        };
        let request = head(ureq::http::Request::builder().method(method).uri(&url));
        let text = body.map_or_else(String::new, Value::to_string);
        let request = request
            .body(text)
            .map_err(|_| AppError::new(ErrorCode::InvalidProfile, "the address is no address"))?;
        let sent = self.agent.run(
            self.agent
                .configure_request(request)
                .timeout_global(Some(REQUEST_TIMEOUT))
                .build(),
        );
        let mut response = sent.map_err(|e| transport(&self.on, &e))?;
        let status = response.status().as_u16();
        let packed = response
            .headers()
            .get("Content-Encoding")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.eq_ignore_ascii_case("gzip"));
        let mut bytes = Vec::new();
        response
            .body_mut()
            .with_config()
            .limit(MAX_PART)
            .reader()
            .read_to_end(&mut bytes)
            .map_err(|e| AppError::new(ErrorCode::ConnectionFailed, format!("{}: {e}", self.on)))?;
        if packed {
            let mut unpacked = Vec::new();
            flate2::read::GzDecoder::new(bytes.as_slice())
                .take(MAX_PART)
                .read_to_end(&mut unpacked)
                .map_err(|e| {
                    AppError::new(ErrorCode::ConnectionFailed, format!("{}: {e}", self.on))
                })?;
            bytes = unpacked;
        }
        let read = serde_json::from_slice::<Value>(&bytes);
        if read.is_err() && (200..300).contains(&status) {
            // an answer that is cut or no JSON is no answer: rows are never left out silently
            return Err(AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{}: the answer cannot be read (HTTP {status})", self.on),
            ));
        }
        let v = read.unwrap_or(Value::Null);
        if v.is_null() && !(200..300).contains(&status) {
            let said: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
            return Err(match status {
                401 | 403 => AppError::new(ErrorCode::AuthFailed, "login failed"),
                _ => AppError::new(
                    ErrorCode::ConnectionFailed,
                    format!("{}: HTTP {status} {}", self.on, clean(&said)),
                ),
            });
        }
        Ok((status, v))
    }

    /// Runs one statement: submits it, waits for it, reads its partitions.
    fn one(
        &mut self,
        sql: &str,
        bindings: Vec<Value>,
        timeout: Option<Duration>,
        sink: &mut dyn RowSink,
        plain: bool,
        stop: Stop,
    ) -> AppResult<Answer> {
        let started = Instant::now();
        let mut body = json!({
            "statement": sql,
            "parameters": FORMATS.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect::<serde_json::Map<_, _>>(),
        });
        if !self.database.is_empty() {
            body["database"] = json!(self.database);
        }
        if let Some(t) = timeout {
            // the server ends it too, should this client be gone by then
            body["timeout"] = json!(t.as_secs().saturating_add(10));
        }
        if !bindings.is_empty() {
            body["bindings"] = Value::Object(
                bindings
                    .into_iter()
                    .enumerate()
                    .map(|(i, b)| ((i + 1).to_string(), b))
                    .collect(),
            );
        }
        let (mut status, mut page) =
            self.call("POST", "/api/v2/statements?async=true", Some(&body))?;
        let handle = page
            .get("statementHandle")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        // only letters, digits and dashes become part of an address
        let handle_ok = !handle.is_empty()
            && handle
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-');
        let mut wait = Duration::from_millis(100);
        let mut failures = 0;
        loop {
            match status {
                200 => break,
                // still running
                202 | 429 if handle_ok => {
                    if stop() {
                        let _ =
                            self.call("POST", &format!("/api/v2/statements/{handle}/cancel"), None);
                        return Err(super::cancelled());
                    }
                    if timeout.is_some_and(|t| started.elapsed() >= t) {
                        let _ =
                            self.call("POST", &format!("/api/v2/statements/{handle}/cancel"), None);
                        return Err(AppError::new(
                            ErrorCode::Timeout,
                            "the statement took too long",
                        ));
                    }
                    std::thread::sleep(wait);
                    wait = (wait * 2).min(Duration::from_secs(1));
                    // asking again is safe; the statement itself is never sent twice
                    match self.call("GET", &format!("/api/v2/statements/{handle}"), None) {
                        Ok((s, p)) if s < 500 => {
                            failures = 0;
                            (status, page) = (s, p);
                        }
                        Ok(_) | Err(_) if failures < RETRIES => failures += 1,
                        hit => {
                            // nobody waits for it any more: it shall not run on unseen
                            let _ = self.call(
                                "POST",
                                &format!("/api/v2/statements/{handle}/cancel"),
                                None,
                            );
                            return Err(match hit {
                                Ok((s, p)) => failed(&self.on, s, &p, sql),
                                Err(e) => e,
                            });
                        }
                    }
                }
                _ => return Err(failed(&self.on, status, &page, sql)),
            }
        }
        let fields = page
            .pointer("/resultSetMetaData/rowType")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let partitions = page
            .pointer("/resultSetMetaData/partitionInfo")
            .and_then(Value::as_array)
            .map_or(1, Vec::len);
        // a statement that changes rows answers with their numbers: not a result
        let stats = page.get("stats").filter(|s| s.is_object());
        let changed = stats.map(|s| {
            [
                "numRowsInserted",
                "numRowsUpdated",
                "numRowsDeleted",
                "numDuplicateRowsUpdated",
            ]
            .iter()
            .filter_map(|k| s.get(*k).and_then(Value::as_u64))
            .sum::<u64>()
        });
        let mut answer = Answer {
            columns: if changed.is_some() {
                Vec::new()
            } else {
                fields
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
                    .collect()
            },
            rows: 0,
            truncated: false,
            changed,
        };
        if answer.columns.is_empty() {
            return Ok(answer);
        }
        if partitions > 1 && !handle_ok {
            return Err(AppError::new(
                ErrorCode::ConnectionFailed,
                format!(
                    "{}: a result in parts without a handle to ask for them",
                    self.on
                ),
            ));
        }
        let expected = |page: &Value, part: usize| -> Option<u64> {
            page.pointer("/resultSetMetaData/partitionInfo")
                .and_then(Value::as_array)
                .and_then(|p| p.get(part))
                .and_then(|p| p.get("rowCount"))
                .and_then(Value::as_u64)
        };
        let counts: Vec<Option<u64>> = (0..partitions).map(|p| expected(&page, p)).collect();
        sink.start(&answer.columns);
        let kinds: Vec<ColKind> = answer.columns.iter().map(|c| c.kind).collect();
        let mut part = 0;
        loop {
            let rows = page.get("data").and_then(Value::as_array);
            let came = rows.map_or(0, |r| r.len() as u64);
            // a part without rows, or with other rows than announced, is a result with a hole
            if (rows.is_none() && part > 0)
                || counts
                    .get(part)
                    .copied()
                    .flatten()
                    .is_some_and(|n| n != came)
            {
                return Err(AppError::new(
                    ErrorCode::ConnectionFailed,
                    format!("{}: part {part} of the result is incomplete", self.on),
                ));
            }
            if let Some(rows) = rows {
                for row in rows {
                    let values = row.as_array();
                    let cells: Vec<Cell> = kinds
                        .iter()
                        .enumerate()
                        .map(|(i, kind)| {
                            let c =
                                cell(values.and_then(|v| v.get(i)).unwrap_or(&Value::Null), *kind);
                            if plain {
                                c.plain().map_or(Cell::Null, Cell::Text)
                            } else {
                                c
                            }
                        })
                        .collect();
                    answer.rows += 1;
                    if !sink.row(cells) {
                        // the statement itself is done: nothing is left running
                        answer.truncated = true;
                        return Ok(answer);
                    }
                }
            }
            part += 1;
            if part >= partitions || !handle_ok {
                return Ok(answer);
            }
            if stop() {
                return Err(super::cancelled());
            }
            if timeout.is_some_and(|t| started.elapsed() >= t) {
                return Err(AppError::new(
                    ErrorCode::Timeout,
                    "the statement took too long",
                ));
            }
            let mut failures = 0;
            page = loop {
                let got = self.call(
                    "GET",
                    &format!("/api/v2/statements/{handle}?partition={part}"),
                    None,
                );
                match got {
                    Ok((200, next)) => break next,
                    // too many requests, or a server that stumbled: the part is asked for again
                    Ok((s, _)) if (s == 429 || s >= 500) && failures < RETRIES => {}
                    Err(e) if e.code == ErrorCode::ConnectionFailed && failures < RETRIES => {}
                    Ok((s, next)) => return Err(failed(&self.on, s, &next, sql)),
                    Err(e) => return Err(e),
                }
                failures += 1;
                std::thread::sleep(Duration::from_millis(300 * failures));
            };
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

impl Session for Snowflake {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        let bindings = params
            .iter()
            .map(|p| json!({"type": "TEXT", "value": p}))
            .collect();
        let mut sink = TextSink(Vec::new());
        self.one(sql, bindings, timeout, &mut sink, true, stop)?;
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
        if let Some(what) = needs_a_session(sql) {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                format!(
                    "{what}: every statement is a request of its own here, so this would not last to the \
                     next one – name objects in full (database.schema.table); each statement is kept as it ran"
                ),
            ));
        }
        let started = Instant::now();
        let bindings = params.iter().map(binding).collect::<AppResult<Vec<_>>>()?;
        let answer = self.one(sql, bindings, limits.timeout, sink, false, stop)?;
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
        // every statement is a request of its own: there is nothing a transaction could be open on
        TxState::Idle
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        Ok("Snowflake".to_owned())
    }

    fn is_open(&self) -> bool {
        true
    }
}

#[cfg(test)]
#[path = "snowflake_tests.rs"]
mod tests;
