//! Database connections (prompt 003): profiles, the drivers behind one trait, and what they need in common
//! (runtime, time limits, errors in words). Pure of Tauri; `commands.rs` is the thin layer above.
//!
//! Drivers after log-commander (its prompt 019): `sqlx-postgres`, `sqlx-mysql`, `tiberius`, `rusqlite` – pure
//! Rust, TLS over rustls with the roots of the OS.

pub mod guard;
pub mod manager;
pub mod meta;
pub mod mssql;
pub mod mysql;
pub mod pg;
pub mod profiles;
pub mod secrets;
pub mod sqlite;
pub mod value;

use crate::error::{AppError, AppResult, ErrorCode};
use secrets::Secret;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;
use value::{Outcome, QueryResult, RowSink, VecSink};

/// Connecting at most.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Postgres,
    /// MySQL and MariaDB.
    Mysql,
    Sqlserver,
    Sqlite,
}

impl DbKind {
    pub fn default_port(self) -> u16 {
        match self {
            DbKind::Postgres => 5432,
            DbKind::Mysql => 3306,
            DbKind::Sqlserver => 1433,
            DbKind::Sqlite => 0,
        }
    }
}

/// How the connection is protected. More modes (own CA, client certificate, no verification as a visible
/// choice) come with prompt 014.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TlsMode {
    /// No TLS. Meant for servers on this machine.
    #[default]
    Off,
    /// TLS, certificate and host name checked against the roots of the OS.
    Verify,
}

/// A stored connection – never a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// `[a-z0-9-]`; empty for a profile that is not stored yet.
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    #[serde(default)]
    pub host: String,
    /// 0 = the default port of the database.
    #[serde(default)]
    pub port: u16,
    /// The database; for SQLite the path of the file.
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub tls: TlsMode,
    /// A folder in the list, `""` = top level.
    #[serde(default)]
    pub folder: String,
    /// 1–8: the colour tag (`--conn-N`).
    #[serde(default = "default_color")]
    pub color: u8,
    /// Keep the password in the keychain of the OS after a login that worked.
    #[serde(default)]
    pub save_password: bool,
    /// What may run here without asking (prompt 012).
    #[serde(default)]
    pub protection: guard::Protection,
    /// A short mark shown with the connection (`PROD`); empty = none.
    #[serde(default)]
    pub label: String,
}

fn default_color() -> u8 {
    1
}

impl Profile {
    pub fn port_or_default(&self) -> u16 {
        if self.port == 0 {
            self.kind.default_port()
        } else {
            self.port
        }
    }

    /// `host:port/database` (or the file) for messages; never holds a secret.
    pub fn where_label(&self) -> String {
        if self.kind == DbKind::Sqlite {
            return self.database.trim().to_string();
        }
        let db = self.database.trim();
        let tail = if db.is_empty() {
            String::new()
        } else {
            format!("/{db}")
        };
        format!("{}:{}{tail}", self.host.trim(), self.port_or_default())
    }

    /// What the password belongs to in the keychain: user, place and kind – not the name, so renaming a
    /// profile keeps its password.
    pub fn secret_subject(&self) -> String {
        format!(
            "{:?}:{}@{}:{}",
            self.kind,
            self.user.trim(),
            self.host.trim().to_lowercase(),
            self.port_or_default()
        )
    }

    /// SQLite needs no password, the others may.
    pub fn uses_password(&self) -> bool {
        self.kind != DbKind::Sqlite
    }
}

/// How far a statement may go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Rows kept at most by [`Session::query`]; `execute` leaves that to its sink.
    pub max_rows: usize,
    /// Time at most; `None` = as long as it takes.
    pub timeout: Option<Duration>,
}

impl Limits {
    pub fn rows(max_rows: usize) -> Self {
        Self {
            max_rows,
            timeout: None,
        }
    }
}

/// How long a statement gets to end after the server was asked to cancel it; then the connection is dropped.
pub const CANCEL_GRACE: Duration = Duration::from_secs(3);

/// `true` when the work is stopped (cancelled, tab closed): requests end with [`cancelled`].
pub type Stop<'a> = &'a (dyn Fn() -> bool + Sync);

/// Whether a session is inside a transaction (prompt 013) – as the server says, not as we guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TxState {
    /// No transaction is open.
    Idle,
    /// A transaction is open.
    Active,
    /// A transaction is open and has failed: only a rollback gets out of it (PostgreSQL, SQL Server).
    Failed,
    /// The server could not be asked.
    Unknown,
}

/// The statement that opens a transaction in a dialect.
pub fn begin_statement(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Postgres | DbKind::Sqlite => "BEGIN",
        DbKind::Mysql => "START TRANSACTION",
        DbKind::Sqlserver => "BEGIN TRANSACTION",
    }
}

/// The rows of [`Session::ask`]: text or NULL.
pub type TextRows = Vec<Vec<Option<String>>>;

/// An open connection.
pub trait Session: Send {
    /// Runs one statement within its [`Limits`]; its rows go into `sink` as they arrive. A statement that is stopped or runs out of time is
    /// cancelled on the server where the driver can (PostgreSQL, MySQL, SQLite): the session stays usable.
    /// Where it cannot, or after a broken connection, the session is closed: [`Session::is_open`].
    fn execute(
        &mut self,
        sql: &str,
        limits: Limits,
        sink: &mut dyn RowSink,
        stop: Stop,
    ) -> AppResult<Outcome>;

    /// Runs one statement and keeps at most `limits.max_rows` rows in memory: for the app's own small
    /// questions (version, ids, metadata) and for tests.
    fn query(&mut self, sql: &str, limits: Limits, stop: Stop) -> AppResult<QueryResult> {
        let mut sink = VecSink::new(limits.max_rows);
        let outcome = self.execute(sql, limits, &mut sink, stop)?;
        Ok(QueryResult {
            columns: outcome.columns,
            rows: sink.rows,
            truncated: outcome.truncated,
            rows_affected: outcome.rows_affected,
            elapsed_ms: outcome.elapsed_ms,
        })
    }
    /// A question of the app itself (metadata, prompt 008) with **bound** text parameters, never a
    /// statement of the user: every value comes back as text or NULL. The placeholders are the dialect's
    /// (`$1`, `?`, `@P1`, `?1`). Stopped or out of time, the session may be closed: [`Session::is_open`].
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<Duration>,
        stop: Stop,
    ) -> AppResult<TextRows>;
    /// Asks the server whether a transaction is open on this session.
    fn transaction_state(&mut self, stop: Stop) -> TxState;
    /// Product and version as the server names itself.
    fn server_version(&mut self, stop: Stop) -> AppResult<String>;
    fn is_open(&self) -> bool;
}

/// Opens a connection. `secret` is the password, if one is known.
pub fn connect(
    profile: &Profile,
    secret: Option<&Secret>,
    stop: Stop,
) -> AppResult<Box<dyn Session>> {
    profiles::check(profile)?;
    Ok(match profile.kind {
        DbKind::Postgres => Box::new(pg::connect(profile, secret, stop)?),
        DbKind::Mysql => Box::new(mysql::connect(profile, secret, stop)?),
        DbKind::Sqlserver => Box::new(mssql::connect(profile, secret, stop)?),
        DbKind::Sqlite => Box::new(sqlite::open(profile)?),
    })
}

/// The runtime all network drivers run on (never Tauri's).
pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("sc-db")
            .enable_all()
            .build()
            .expect("tokio runtime for database connections")
    })
}

pub fn cancelled() -> AppError {
    AppError::new(ErrorCode::Cancelled, "cancelled")
}

pub fn closed() -> AppError {
    AppError::new(ErrorCode::ConnectionFailed, "the connection is closed")
}

/// Runs `f` until it ends, the time (if any) is up or the work is stopped.
pub fn block<T>(
    timeout: Option<Duration>,
    stop: Stop,
    f: impl Future<Output = AppResult<T>>,
) -> AppResult<T> {
    runtime().block_on(async move {
        let stopped = async {
            loop {
                if stop() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        let timed = async {
            match timeout {
                Some(t) => tokio::time::timeout(t, f).await.unwrap_or_else(|_| {
                    Err(AppError::new(
                        ErrorCode::Timeout,
                        format!("no answer within {} s", t.as_secs()),
                    ))
                }),
                None => f.await,
            }
        };
        tokio::select! {
            r = timed => r,
            _ = stopped => Err(cancelled()),
        }
    })
}

/// Why [`block_cancelling`] ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The work ended by itself (with a result or an error of its own), also after a cancel request.
    Done,
    /// The work did not end within [`CANCEL_GRACE`] after the cancel request: it was dropped, and whatever it
    /// held (a connection) is in an unknown state.
    Abandoned,
}

/// Runs `f` until it ends. When the work is stopped or its time is up, `cancel` asks the server to end it and
/// `f` gets [`CANCEL_GRACE`] to return (usually with the server's „cancelled“ error); only then it is dropped.
pub fn block_cancelling<T>(
    timeout: Option<Duration>,
    stop: Stop,
    f: impl Future<Output = AppResult<T>>,
    cancel: impl Future<Output = ()>,
) -> (AppResult<T>, Ended) {
    runtime().block_on(async move {
        tokio::pin!(f);
        let started = std::time::Instant::now();
        let reason = loop {
            tokio::select! {
                r = &mut f => return (r, Ended::Done),
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    if stop() {
                        break cancelled();
                    }
                    if timeout.is_some_and(|t| started.elapsed() >= t) {
                        break AppError::new(
                            ErrorCode::Timeout,
                            format!("no answer within {} s", timeout.unwrap_or_default().as_secs()),
                        );
                    }
                }
            }
        };
        let give_up = async {
            // the request itself must not hang either
            let _ = tokio::time::timeout(Duration::from_secs(5), cancel).await;
            tokio::time::sleep(CANCEL_GRACE).await;
        };
        tokio::select! {
            r = &mut f => {
                // the statement ended: with the server's own „cancelled“, or it was just done in time
                let r = match r {
                    Ok(v) => Ok(v),
                    Err(e) if e.code == ErrorCode::Cancelled => Err(reason),
                    Err(e) => Err(e),
                };
                (r, Ended::Done)
            }
            _ = give_up => (Err(reason), Ended::Abandoned),
        }
    })
}

/// Makes sure rustls has its process-wide provider (ring) before any TLS connection: tiberius asks for the
/// installed one and would otherwise take aws-lc-rs.
pub fn install_crypto() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// One line, bounded, without control characters: what a server said.
pub fn clean(message: &str) -> String {
    let one: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let one = one.split_whitespace().collect::<Vec<_>>().join(" ");
    match one.char_indices().nth(2000) {
        None => one,
        Some((at, _)) => format!("{}…", &one[..at]),
    }
}

fn is_tls(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("certificate") || t.contains("tls") || t.contains("ssl") || t.contains("handshake")
}

/// Whether an error leaves the connection usable: what the server answered to the statement, including
/// „cancelled“ – when the statement really ended ([`Ended::Done`]).
/// After [`Session::ask`]: stopped or out of time the answer is still on the wire, the connection goes.
pub fn keeps_after_ask(code: ErrorCode) -> bool {
    keeps_connection(code) && !matches!(code, ErrorCode::Cancelled | ErrorCode::Timeout)
}

pub fn keeps_connection(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::InvalidQuery
            | ErrorCode::PermissionDenied
            | ErrorCode::NotFound
            | ErrorCode::Cancelled
            | ErrorCode::Timeout
    )
}

/// Errors of sqlx (PostgreSQL, MySQL) with a code the frontend can act on; they never hold the password.
pub fn sqlx_error(profile: &Profile, e: &sqlx_core::error::Error) -> AppError {
    use sqlx_core::error::Error as E;
    let on = profile.where_label();
    match e {
        E::Database(d) => {
            let code = d.code().map(|c| c.to_string()).unwrap_or_default();
            let message = clean(d.message());
            let lower = message.to_lowercase();
            let has = |w: &str| lower.contains(w);
            // 28xxx: invalid authorization (PostgreSQL); 1045/1698: access denied for user (MySQL)
            if code.starts_with("28") || has("access denied for user") {
                AppError::new(ErrorCode::AuthFailed, message)
            } else if code == "3D000" || has("unknown database") {
                AppError::new(ErrorCode::NotFound, message)
            } else if code == "42501" || has("command denied") || has("permission denied") {
                AppError::new(ErrorCode::PermissionDenied, message)
            // 57014: query_canceled (PostgreSQL); 70100 / 1317: query execution was interrupted (MySQL)
            } else if code == "57014" || code == "70100" || has("query execution was interrupted") {
                AppError::new(ErrorCode::Cancelled, message)
            } else if code.is_empty() {
                AppError::new(ErrorCode::InvalidQuery, message)
            } else {
                AppError::new(ErrorCode::InvalidQuery, format!("{message} ({code})"))
            }
        }
        E::Tls(t) => AppError::new(
            ErrorCode::TlsFailed,
            format!("{on}: {}", clean(&t.to_string())),
        ),
        E::Io(io) if is_tls(&io.to_string()) => AppError::new(
            ErrorCode::TlsFailed,
            format!("{on}: {}", clean(&io.to_string())),
        ),
        E::Io(io) => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: {}", clean(&io.to_string())),
        ),
        E::Configuration(c) => AppError::new(ErrorCode::InvalidProfile, clean(&c.to_string())),
        other => {
            let text = clean(&other.to_string());
            let code = if is_tls(&text) {
                ErrorCode::TlsFailed
            } else {
                ErrorCode::ConnectionFailed
            };
            AppError::new(code, format!("{on}: {text}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn profile(kind: DbKind) -> Profile {
        Profile {
            id: "p1".into(),
            name: "Test".into(),
            kind,
            host: " DB.Example.com ".into(),
            port: 0,
            database: "shop".into(),
            user: "alice".into(),
            tls: TlsMode::Off,
            folder: String::new(),
            color: 1,
            save_password: false,
            protection: crate::db::guard::Protection::Free,
            label: String::new(),
        }
    }

    #[test]
    fn labels_and_default_ports() {
        let p = profile(DbKind::Postgres);
        assert_eq!(p.port_or_default(), 5432);
        assert_eq!(p.where_label(), "DB.Example.com:5432/shop");
        assert_eq!(profile(DbKind::Mysql).port_or_default(), 3306);
        assert_eq!(profile(DbKind::Sqlserver).port_or_default(), 1433);
        let mut lite = profile(DbKind::Sqlite);
        lite.database = "/tmp/a b.db".into();
        assert_eq!(lite.where_label(), "/tmp/a b.db");
        assert!(!lite.uses_password());
    }

    #[test]
    fn the_secret_belongs_to_user_and_place_not_to_the_name() {
        let a = profile(DbKind::Postgres);
        let mut renamed = a.clone();
        renamed.name = "Anders".into();
        renamed.host = "db.example.com".into();
        assert_eq!(a.secret_subject(), renamed.secret_subject());
        let mut other = a.clone();
        other.user = "bob".into();
        assert_ne!(a.secret_subject(), other.secret_subject());
        let mut port = a.clone();
        port.port = 5433;
        assert_ne!(a.secret_subject(), port.secret_subject());
    }

    #[test]
    fn server_messages_become_one_bounded_line() {
        assert_eq!(clean("a\n  b\tc\u{7}"), "a b c");
        assert_eq!(clean(&"x".repeat(5000)).chars().count(), 2001);
    }

    #[test]
    fn stops_and_times_out() {
        let never = std::future::pending::<AppResult<()>>();
        let e = block(Some(Duration::from_millis(30)), &|| false, never).unwrap_err();
        assert_eq!(e.code, ErrorCode::Timeout);
        let never = std::future::pending::<AppResult<()>>();
        let e = block(None, &|| true, never).unwrap_err();
        assert_eq!(e.code, ErrorCode::Cancelled);
        assert_eq!(block(None, &|| false, async { Ok(7) }).unwrap(), 7);
    }

    #[test]
    fn asks_to_cancel_and_waits_for_the_work_to_end() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        // the work ends once it was asked to: the session would be kept
        let asked = Arc::new(AtomicBool::new(false));
        let flag = asked.clone();
        let work = async move {
            while !flag.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err::<(), _>(AppError::new(
                ErrorCode::Cancelled,
                "server says: cancelled",
            ))
        };
        let set = asked.clone();
        let (r, ended) = block_cancelling(None, &|| true, work, async move {
            set.store(true, Ordering::Relaxed);
        });
        assert_eq!(r.unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(ended, Ended::Done);

        // a timeout is reported as such, also when the server answers with „cancelled“
        let asked = Arc::new(AtomicBool::new(false));
        let flag = asked.clone();
        let work = async move {
            while !flag.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err::<(), _>(AppError::new(ErrorCode::Cancelled, "cancelled"))
        };
        let set = asked.clone();
        let (r, ended) = block_cancelling(
            Some(Duration::from_millis(60)),
            &|| false,
            work,
            async move { set.store(true, Ordering::Relaxed) },
        );
        assert_eq!(r.unwrap_err().code, ErrorCode::Timeout);
        assert_eq!(ended, Ended::Done);

        // work that ends by itself is not touched
        let (r, ended) = block_cancelling(None, &|| false, async { Ok(7) }, async {});
        assert_eq!(r.unwrap(), 7);
        assert_eq!(ended, Ended::Done);
    }

    #[test]
    fn a_profile_survives_json_with_defaults() {
        let p: Profile =
            serde_json::from_str(r#"{"name":"Lokal","kind":"postgres","host":"localhost"}"#)
                .unwrap();
        assert_eq!(p.color, 1);
        assert_eq!(p.tls, TlsMode::Off);
        assert_eq!(p.id, "");
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["savePassword"], false);
        assert_eq!(json["kind"], "postgres");
        assert!(json.get("password").is_none());
    }
}
