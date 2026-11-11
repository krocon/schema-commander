//! The open connections (prompt 003): one session per profile, opened on request, each behind its own lock.
//! A statement that runs can be stopped from another thread ([`ConnectionManager::cancel`]).

use super::guard::{self, Class, Need, Protection};
use super::import;
use super::profiles::{self, LoadedProfiles};
use super::secrets::{self, Secret, SecretKind, SecretStore};
use super::value::{MAX_ROWS, Outcome, QueryResult, RowSink, VecSink};
use super::{DbKind, Limits, Profile, Session, TxState, connect, sqlite};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::ssh::trust::KnownHosts;
use crate::ssh::{SshAuth, SshCredentials, SshTarget, Tunnel};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// What the frontend learns about an opened connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub server_version: String,
}

struct Open {
    session: Mutex<Box<dyn Session>>,
    /// Set to stop the statement that runs; cleared before the next one.
    stop: AtomicBool,
    /// What the server said last about its transaction.
    tx: Mutex<TxState>,
}

impl Open {
    fn new(session: Box<dyn Session>) -> Arc<Self> {
        Arc::new(Open {
            session: Mutex::new(session),
            stop: AtomicBool::new(false),
            tx: Mutex::new(TxState::Idle),
        })
    }
}

/// A connection found in another tool's file, as the preview shows it (prompt 015).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    /// Its place in the source: what a pick names.
    pub index: usize,
    pub profile: Profile,
    /// A password stands there in clear text and can be taken along.
    pub has_password: bool,
    /// What is missing before it can be stored.
    pub problem: Option<String>,
    /// A stored profile has this name already (the import adds a number).
    pub name_taken: bool,
}

/// One connection the user ticked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPick {
    pub index: usize,
    /// Take the clear-text password along, into the keychain.
    #[serde(default)]
    pub with_password: bool,
}

/// What a statement is and what it needs on its connection (prompt 012).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub class: Class,
    pub need: Need,
}

/// A confirmation lives this long.
const CONFIRMATION_TTL: std::time::Duration = std::time::Duration::from_secs(600);

struct Confirmation {
    connection: String,
    sql: String,
    until: std::time::Instant,
}

pub struct ConnectionManager {
    /// Confirmations given for statements, by their token. Each admits one run of exactly that statement
    /// on exactly that connection.
    confirmations: Mutex<HashMap<String, Confirmation>>,
    /// The passwords of the open connections, for the sessions of their tabs (prompt 013): in memory
    /// only, wiped when the connection closes.
    kept: Mutex<HashMap<String, Option<Secret>>>,
    /// The SSH tunnels of the open connections (prompt 014), and what unlocked them – to build a tunnel
    /// again when it broke. In memory only.
    tunnels: Mutex<HashMap<String, Arc<Tunnel>>>,
    kept_ssh: Mutex<HashMap<String, Option<Secret>>>,
    file: PathBuf,
    store: Arc<dyn SecretStore>,
    profiles: Mutex<Option<Vec<Profile>>>,
    notice: Mutex<Option<String>>,
    open: Mutex<HashMap<String, Arc<Open>>>,
}

fn unknown(id: &str) -> AppError {
    AppError::new(
        ErrorCode::UnknownConnection,
        format!("no connection „{id}“"),
    )
}

fn keychain(e: secrets::StoreError) -> AppError {
    AppError::new(ErrorCode::KeychainUnavailable, e.0)
}

/// How writing changed rows ended (prompt 031). Nothing is half written: `done` is the number of
/// statements that are committed – all of them, or none.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub done: usize,
    /// The statement that stopped everything (counted from 0).
    pub failed: Option<usize>,
    /// It changed no row or several: the row is not what it was when it was read.
    pub conflict: bool,
    /// What the database said, when a statement or the commit failed.
    pub error: Option<AppError>,
    /// A transaction of the user's own is open on the session: nothing was tried.
    pub blocked: bool,
    /// The connection was lost while committing: whether the rows are written is not known.
    pub unknown: bool,
    pub tx: TxState,
}

impl ConnectionManager {
    /// `file`: `connections.json`; `store`: where passwords are kept.
    pub fn new(file: PathBuf, store: Arc<dyn SecretStore>) -> Self {
        Self {
            file,
            store,
            profiles: Mutex::new(None),
            notice: Mutex::new(None),
            open: Mutex::new(HashMap::new()),
            confirmations: Mutex::new(HashMap::new()),
            kept: Mutex::new(HashMap::new()),
            tunnels: Mutex::new(HashMap::new()),
            kept_ssh: Mutex::new(HashMap::new()),
        }
    }

    fn stored(&self) -> Vec<Profile> {
        let mut guard = self.profiles.lock();
        if guard.is_none() {
            let LoadedProfiles { profiles, notice } = profiles::load(&self.file);
            *self.notice.lock() = notice;
            *guard = Some(profiles);
        }
        guard.clone().unwrap_or_default()
    }

    /// The demo database first, then the stored profiles.
    pub fn list(&self) -> LoadedProfiles {
        let mut all = vec![sqlite::demo_profile()];
        all.extend(self.stored());
        LoadedProfiles {
            profiles: all,
            notice: self.notice.lock().clone(),
        }
    }

    /// The kind of database a profile connects to.
    pub fn kind_of(&self, id: &str) -> AppResult<DbKind> {
        Ok(self.find(id)?.kind)
    }

    fn find(&self, id: &str) -> AppResult<Profile> {
        if id == "demo" {
            return Ok(sqlite::demo_profile());
        }
        self.stored()
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| unknown(id))
    }

    fn account(profile: &Profile) -> String {
        secrets::account(SecretKind::Password, &profile.secret_subject())
    }

    /// Stores a profile (new without an id, or changed) and returns it with its id. A password given here is
    /// put into the keychain when the profile says so – and removed from it when it says not to.
    pub fn save(&self, mut profile: Profile, password: Option<Secret>) -> AppResult<Profile> {
        profiles::check(&profile)?;
        let mut all = self.stored();
        if profile.id == "demo" {
            return Err(AppError::new(
                ErrorCode::InvalidProfile,
                "the demo connection cannot be changed",
            ));
        }
        if profile.id.is_empty() {
            let taken: Vec<&str> = all
                .iter()
                .map(|p| p.id.as_str())
                .chain(std::iter::once("demo"))
                .collect();
            profile.id = profiles::new_id(&profile.name, &taken);
            all.push(profile.clone());
        } else {
            let slot = all
                .iter_mut()
                .find(|p| p.id == profile.id)
                .ok_or_else(|| unknown(&profile.id))?;
            let old = Self::account(slot);
            // another user or place: the old password belongs to nothing any more
            if old != Self::account(&profile) && self.store.available() {
                let _ = self.store.delete(&old);
            }
            *slot = profile.clone();
        }
        if profile.uses_password() {
            if !profile.save_password {
                if self.store.available() {
                    let _ = self.store.delete(&Self::account(&profile));
                }
            } else if let Some(password) = password.filter(|p| !p.is_empty()) {
                self.store
                    .set(&Self::account(&profile), &password)
                    .map_err(keychain)?;
            }
        }
        profiles::save(&self.file, &all)?;
        *self.profiles.lock() = Some(all);
        // what is open keeps running with the old settings until it is opened again
        Ok(profile)
    }

    /// Removes a profile, closes its connection and forgets its password.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut all = self.stored();
        let at = all
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| unknown(id))?;
        let gone = all.remove(at);
        profiles::save(&self.file, &all)?;
        *self.profiles.lock() = Some(all);
        self.close(id);
        if gone.uses_password() && self.store.available() {
            let _ = self.store.delete(&Self::account(&gone));
        }
        // what unlocked its tunnel goes too, unless another profile uses the same jump host
        if let Some(target) = &gone.ssh
            && self.store.available()
        {
            let account = Self::ssh_account(target);
            let shared = self.stored().iter().any(|p| {
                p.ssh
                    .as_ref()
                    .is_some_and(|t| Self::ssh_account(t) == account)
            });
            if !shared {
                let _ = self.store.delete(&account);
            }
        }
        Ok(())
    }

    /// The password to connect with: the one given, else the one in the keychain. `secret_required` when a
    /// profile wants one and none is known.
    fn secret_for(&self, profile: &Profile, given: Option<Secret>) -> AppResult<Option<Secret>> {
        if !profile.uses_password() {
            return Ok(None);
        }
        if let Some(given) = given {
            return Ok(Some(given));
        }
        if profile.save_password
            && self.store.available()
            && let Some(found) = self.store.get(&Self::account(profile)).map_err(keychain)?
        {
            return Ok(Some(found));
        }
        Err(AppError::new(
            ErrorCode::SecretRequired,
            format!("a password is needed for {}", profile.user.trim()),
        ))
    }

    /// Tries a profile (stored or not) without keeping the connection.
    pub fn test(&self, profile: &Profile, password: Option<Secret>) -> AppResult<String> {
        self.test_with(profile, password, SshCredentials::default())
    }

    /// As [`ConnectionManager::test`], with what the user gave for the SSH tunnel. The error says which
    /// stage failed: the SSH server, its host key, the SSH login, the database behind it, TLS, the login.
    pub fn test_with(
        &self,
        profile: &Profile,
        password: Option<Secret>,
        ssh: SshCredentials,
    ) -> AppResult<String> {
        profiles::check(profile)?;
        // a test stores nothing: the profile may never be saved
        let (tunnel, _) = self.open_tunnel(profile, ssh, false)?;
        let secret = self.secret_for(profile, password)?;
        let mut session = Self::connect_through(profile, tunnel.as_ref(), secret.as_ref())?;
        session.server_version(&|| false)
    }

    /// Where the host keys of SSH servers are looked up: the user's `known_hosts` (read only) and the
    /// app's own next to the profiles.
    fn known_hosts(&self) -> KnownHosts {
        KnownHosts {
            user: crate::ssh::ssh_config::home_dir().map(|h| h.join(".ssh").join("known_hosts")),
            app: self.file.with_file_name("known_hosts"),
        }
    }

    fn ssh_account(target: &SshTarget) -> String {
        match target.auth {
            SshAuth::Key => secrets::scoped_account(
                "ssh",
                SecretKind::Passphrase,
                &target
                    .key_files()
                    .first()
                    .map(|f| f.display().to_string())
                    .unwrap_or_default(),
            ),
            _ => secrets::scoped_account("ssh", SecretKind::Password, &target.label()),
        }
    }

    /// Opens the tunnel of a profile, if it has one. A secret that was not given is looked up in the
    /// keychain; one that was given and worked is returned to be kept.
    fn open_tunnel(
        &self,
        profile: &Profile,
        mut creds: SshCredentials,
        remember: bool,
    ) -> AppResult<(Option<Arc<Tunnel>>, Option<Secret>)> {
        let Some(target) = &profile.ssh else {
            return Ok((None, None));
        };
        let given = creds.secret.is_some();
        if !given
            && target.auth != SshAuth::Agent
            && profile.save_password
            && self.store.available()
        {
            creds.secret = self.store.get(&Self::ssh_account(target)).ok().flatten();
        }
        let tunnel = crate::ssh::open(
            target,
            &profile.host,
            profile.port_or_default(),
            &self.known_hosts(),
            &creds,
        )?;
        if given
            && remember
            && profile.save_password
            && let Some(secret) = creds.secret.as_ref().filter(|s| !s.is_empty())
        {
            let _ = self.store.set(&Self::ssh_account(target), secret);
        }
        Ok((Some(Arc::new(tunnel)), creds.secret))
    }

    /// Connects to the database of a profile – through its tunnel when it has one: the driver then talks
    /// to the local end, which takes exactly this one connection.
    fn connect_through(
        profile: &Profile,
        tunnel: Option<&Arc<Tunnel>>,
        secret: Option<&Secret>,
    ) -> AppResult<Box<dyn Session>> {
        match tunnel {
            Some(tunnel) => {
                let mut local = profile.clone();
                local.host = "127.0.0.1".to_string();
                local.port = tunnel.port();
                local.ssh = None;
                tunnel.permit();
                let mut session = Self::connect_guarded(&local, secret)?;
                // the session keeps the tunnel: its port is not free for anybody else while it lives
                session.via_tunnel(Arc::clone(tunnel));
                Ok(session)
            }
            None => Self::connect_guarded(profile, secret),
        }
    }

    /// The tunnel of an open connection; one that broke is built again with what unlocked it.
    fn tunnel_of(&self, id: &str, profile: &Profile) -> AppResult<Option<Arc<Tunnel>>> {
        if profile.ssh.is_none() {
            return Ok(None);
        }
        if let Some(tunnel) = self.tunnels.lock().get(id).filter(|t| t.is_open()).cloned() {
            return Ok(Some(tunnel));
        }
        let secret = self.kept_ssh.lock().get(id).cloned().flatten();
        let (tunnel, _) = self.open_tunnel(
            profile,
            SshCredentials {
                secret,
                trust_fingerprint: None,
            },
            false,
        )?;
        if let Some(tunnel) = &tunnel {
            self.tunnels
                .lock()
                .insert(id.to_string(), Arc::clone(tunnel));
        }
        Ok(tunnel)
    }

    /// Opens the connection of a profile (an open one is replaced). After a login that worked the password
    /// goes into the keychain if the profile says so.
    pub fn open(&self, id: &str, password: Option<Secret>) -> AppResult<ConnectionInfo> {
        self.open_with(id, password, SshCredentials::default())
    }

    /// As [`ConnectionManager::open`], with what the user gave for the SSH tunnel (its password or
    /// passphrase, the fingerprint of a host key they confirmed).
    pub fn open_with(
        &self,
        id: &str,
        password: Option<Secret>,
        ssh: SshCredentials,
    ) -> AppResult<ConnectionInfo> {
        let profile = self.find(id)?;
        let given = password.is_some();
        // the tunnel first: nobody is asked for a database password for a jump host that is not trusted
        let (tunnel, ssh_secret) = self.open_tunnel(&profile, ssh, true)?;
        let secret = self.secret_for(&profile, password)?;
        let mut session = Self::connect_through(&profile, tunnel.as_ref(), secret.as_ref())?;
        let server_version = session.server_version(&|| false)?;
        if given
            && profile.save_password
            && let Some(secret) = secret.as_ref().filter(|s| !s.is_empty())
        {
            // a keychain that fails must not undo a login that worked
            let _ = self.store.set(&Self::account(&profile), secret);
        }
        // sessions of tabs from an earlier login go with it
        self.close(id);
        self.kept.lock().insert(id.to_string(), secret);
        if let Some(tunnel) = tunnel {
            self.tunnels.lock().insert(id.to_string(), tunnel);
            self.kept_ssh.lock().insert(id.to_string(), ssh_secret);
        }
        self.open.lock().insert(id.to_string(), Open::new(session));
        Ok(ConnectionInfo {
            id: id.to_string(),
            server_version,
        })
    }

    /// Opens a session and makes it read only on the server when the profile says so.
    fn connect_guarded(profile: &Profile, secret: Option<&Secret>) -> AppResult<Box<dyn Session>> {
        let mut session = connect(profile, secret, &|| false)?;
        if profile.protection == Protection::Readonly
            && let Some(sql) = guard::read_only_statement(profile.kind)
        {
            // the server refuses writes too, whatever reaches it; a connection that cannot be made read
            // only is not opened as one
            session.query(sql, Limits::rows(1), &|| false)?;
        }
        Ok(session)
    }

    /// Closes a connection with the sessions of all its tabs; open transactions are rolled back by the
    /// server.
    pub fn close(&self, id: &str) {
        let prefix = format!("{id}#");
        let mut all = self.open.lock();
        let keys: Vec<String> = all
            .keys()
            .filter(|k| *k == id || k.starts_with(&prefix))
            .cloned()
            .collect();
        for key in keys {
            if let Some(open) = all.remove(&key) {
                // a statement that still runs ends, then the session is dropped with its last owner
                open.stop.store(true, Ordering::Relaxed);
            }
        }
        drop(all);
        self.kept.lock().remove(id);
        self.kept_ssh.lock().remove(id);
        // the tunnel goes with its last session
        self.tunnels.lock().remove(id);
    }

    /// The key of the session a tab runs on. Each tab has a session of its own, so its transaction is
    /// its own; the connection itself keeps one for the app's questions (tree, export). The demo database
    /// lives in memory: it has one session for everyone.
    fn key(profile: &Profile, id: &str, tab: Option<&str>) -> AppResult<String> {
        match tab {
            Some(tab) if profile.database != sqlite::DEMO => {
                let plain = !tab.is_empty()
                    && tab.len() <= 64
                    && tab
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
                if !plain {
                    return Err(AppError::new(
                        ErrorCode::InvalidQuery,
                        "not the id of a tab",
                    ));
                }
                Ok(format!("{id}#{tab}"))
            }
            _ => Ok(id.to_string()),
        }
    }

    /// The session of a tab, opened when it is first needed – with the password the connection was
    /// opened with. The connection itself must be open.
    fn session_of(&self, id: &str, tab: Option<&str>) -> AppResult<(String, Arc<Open>, Profile)> {
        let profile = self.find(id)?;
        let key = Self::key(&profile, id, tab)?;
        if let Some(open) = self.open.lock().get(&key).cloned() {
            return Ok((key, open, profile));
        }
        if key == id || !self.open.lock().contains_key(id) {
            return Err(AppError::new(
                ErrorCode::NotConnected,
                format!("„{id}“ is not connected"),
            ));
        }
        let secret = self.kept.lock().get(id).cloned().flatten();
        let tunnel = self.tunnel_of(id, &profile)?;
        let session = Self::connect_through(&profile, tunnel.as_ref(), secret.as_ref())?;
        let open = Open::new(session);
        self.open.lock().insert(key.clone(), open.clone());
        Ok((key, open, profile))
    }

    /// Closes the session of a tab (its transaction is rolled back by the server).
    pub fn close_session(&self, id: &str, tab: &str) {
        let Ok(profile) = self.find(id) else {
            return;
        };
        let Ok(key) = Self::key(&profile, id, Some(tab)) else {
            return;
        };
        if key != id
            && let Some(open) = self.open.lock().remove(&key)
        {
            open.stop.store(true, Ordering::Relaxed);
        }
    }

    /// What the server said last about the transaction of a tab; `Idle` without a session.
    pub fn tx_state(&self, id: &str, tab: Option<&str>) -> TxState {
        let Ok(profile) = self.find(id) else {
            return TxState::Idle;
        };
        let Ok(key) = Self::key(&profile, id, tab) else {
            return TxState::Idle;
        };
        self.open
            .lock()
            .get(&key)
            .map_or(TxState::Idle, |open| *open.tx.lock())
    }

    /// Runs one statement on the session of a tab; its rows go into `sink` as they arrive. In manual
    /// mode a transaction is opened first when none is open – unless the statement is itself transaction
    /// control. Returns how the statement ended and what the server says about the transaction afterwards.
    pub fn run_in(
        &self,
        id: &str,
        tab: Option<&str>,
        sql: &str,
        timeout: Option<std::time::Duration>,
        sink: &mut dyn RowSink,
        manual: bool,
    ) -> (AppResult<Outcome>, TxState) {
        self.run_bound(id, tab, sql, &[], timeout, sink, manual)
    }

    /// As [`ConnectionManager::run_in`], with values bound to the placeholders of the statement
    /// (prompt 025).
    #[allow(clippy::too_many_arguments)]
    pub fn run_bound(
        &self,
        id: &str,
        tab: Option<&str>,
        sql: &str,
        params: &[super::Bind],
        timeout: Option<std::time::Duration>,
        sink: &mut dyn RowSink,
        manual: bool,
    ) -> (AppResult<Outcome>, TxState) {
        if params.len() > super::MAX_BINDS {
            let e = AppError::new(ErrorCode::InvalidQuery, "too many values to bind");
            return (Err(e), TxState::Idle);
        }
        let (key, open, profile) = match self.session_of(id, tab) {
            Ok(found) => found,
            Err(e) => return (Err(e), TxState::Idle),
        };
        let mut session = open.session.lock();
        open.stop.store(false, Ordering::Relaxed);
        let stop = || open.stop.load(Ordering::Relaxed);
        let limits = Limits {
            max_rows: MAX_ROWS,
            timeout,
        };
        if manual
            && *open.tx.lock() == TxState::Idle
            && !guard::is_transaction_control(sql, profile.kind)
            && let Err(e) =
                session.query(super::begin_statement(profile.kind), Limits::rows(1), &stop)
        {
            return (Err(e), *open.tx.lock());
        }
        let result = session.execute_bound(sql, params, limits, sink, &stop);
        let lost = !session.is_open();
        let tx = if lost {
            TxState::Idle
        } else {
            session.transaction_state(&|| false)
        };
        *open.tx.lock() = tx;
        let lost = lost || !session.is_open();
        drop(session);
        if lost {
            // cancelled or broken: the session is gone, the next statement needs a new connection
            let mut all = self.open.lock();
            if all.get(&key).is_some_and(|o| Arc::ptr_eq(o, &open)) {
                all.remove(&key);
            }
        }
        (result, tx)
    }

    /// Writes changed rows (prompt 031): all statements in one transaction on the session of a tab, each
    /// of them must change **exactly one row** – else everything is rolled back. Every statement passes
    /// the guard of the connection first (`tokens[i]` confirms statement `i`), before anything runs.
    /// A transaction that is open on the session already is the user's: nothing is written then.
    pub fn apply_updates(
        &self,
        id: &str,
        tab: Option<&str>,
        statements: &[super::filter::Built],
        tokens: &[Option<String>],
        timeout: Option<std::time::Duration>,
    ) -> AppResult<Applied> {
        for (i, statement) in statements.iter().enumerate() {
            let token = tokens.get(i).and_then(|t| t.as_deref());
            self.admit(id, &statement.sql, token, false)?;
        }
        let (key, open, profile) = self.session_of(id, tab)?;
        let mut session = open.session.lock();
        open.stop.store(false, Ordering::Relaxed);
        let stop = || open.stop.load(Ordering::Relaxed);
        let limits = Limits {
            max_rows: 1,
            timeout,
        };
        let mut applied = Applied {
            done: 0,
            failed: None,
            conflict: false,
            error: None,
            blocked: false,
            unknown: false,
            tx: TxState::Idle,
        };
        // the server says whether a transaction is open – not what was noted after the last statement
        // (a BEGIN inside one would nest on SQL Server, and commit the user's work elsewhere)
        let before = session.transaction_state(&|| false);
        *open.tx.lock() = before;
        if before != TxState::Idle {
            applied.blocked = true;
            applied.tx = before;
            return Ok(applied);
        }
        let mut problem = session
            .query(super::begin_statement(profile.kind), Limits::rows(1), &stop)
            .err();
        if problem.is_none() {
            for (i, statement) in statements.iter().enumerate() {
                let mut sink = VecSink::new(1);
                match session.execute_bound(
                    &statement.sql,
                    &statement.params,
                    limits,
                    &mut sink,
                    &stop,
                ) {
                    Ok(outcome) if outcome.rows_affected == Some(1) => applied.done += 1,
                    Ok(_) => {
                        // no row, or more than one: the row is not what it was when it was read
                        applied.failed = Some(i);
                        applied.conflict = true;
                        break;
                    }
                    Err(e) => {
                        applied.failed = Some(i);
                        problem = Some(e);
                        break;
                    }
                }
            }
        }
        let end = if applied.failed.is_none() && problem.is_none() {
            "COMMIT"
        } else {
            "ROLLBACK"
        };
        if session.is_open()
            && let Err(e) = session.query(end, Limits::rows(1), &|| false)
            && end == "COMMIT"
        {
            // the connection gone in the middle of the commit: nobody knows whether it happened
            applied.unknown = !session.is_open();
            // a commit that fails (a deferred constraint) wrote nothing: say why, and make sure of it
            problem = Some(e);
            if session.is_open() {
                let _ = session.query("ROLLBACK", Limits::rows(1), &|| false);
            }
        }
        let lost = !session.is_open();
        applied.tx = if lost {
            TxState::Idle
        } else {
            session.transaction_state(&|| false)
        };
        // committed means: no transaction is left. One that is (a session that opens them itself, a
        // BEGIN that nested) would take the rows with it when it ends – so it ends now, and nothing is
        // called written
        if end == "COMMIT" && problem.is_none() && !lost && applied.tx != TxState::Idle {
            let _ = session.query("ROLLBACK", Limits::rows(1), &|| false);
            applied.tx = session.transaction_state(&|| false);
            problem = Some(AppError::new(
                ErrorCode::Unsupported,
                "the transaction did not end with the commit; it was rolled back",
            ));
        }
        if end == "ROLLBACK" || problem.is_some() {
            applied.done = 0;
        }
        applied.error = problem;
        *open.tx.lock() = applied.tx;
        drop(session);
        if lost {
            let mut all = self.open.lock();
            if all.get(&key).is_some_and(|o| Arc::ptr_eq(o, &open)) {
                all.remove(&key);
            }
        }
        Ok(applied)
    }

    /// Ends the transaction of a tab; returns what the server says afterwards.
    pub fn end_transaction(&self, id: &str, tab: Option<&str>, commit: bool) -> AppResult<TxState> {
        let mut sink = VecSink::new(1);
        let sql = if commit { "COMMIT" } else { "ROLLBACK" };
        let (result, tx) = self.run_in(id, tab, sql, None, &mut sink, false);
        result.map(|_| tx)
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.open.lock().contains_key(id)
    }

    fn opened(&self, id: &str) -> AppResult<Arc<Open>> {
        self.open.lock().get(id).cloned().ok_or_else(|| {
            AppError::new(ErrorCode::NotConnected, format!("„{id}“ is not connected"))
        })
    }

    /// One statement at a time per connection: a second call waits.
    /// Runs one statement on an open connection and keeps its rows in memory (at most [`MAX_ROWS`]): for
    /// tests and small questions. The window uses [`ConnectionManager::run_into`].
    pub fn run(
        &self,
        id: &str,
        sql: &str,
        timeout: Option<std::time::Duration>,
    ) -> AppResult<QueryResult> {
        let mut sink = VecSink::new(MAX_ROWS);
        let outcome = self.run_into(id, sql, timeout, &mut sink)?;
        Ok(QueryResult {
            columns: outcome.columns,
            rows: sink.rows,
            truncated: outcome.truncated,
            rows_affected: outcome.rows_affected,
            elapsed_ms: outcome.elapsed_ms,
        })
    }

    /// Runs one statement on an open connection; its rows go into `sink` as they arrive.
    pub fn run_into(
        &self,
        id: &str,
        sql: &str,
        timeout: Option<std::time::Duration>,
        sink: &mut dyn RowSink,
    ) -> AppResult<Outcome> {
        self.run_in(id, None, sql, timeout, sink, false).0
    }

    /// A name no stored profile has: the name itself, or with ` (2)`, ` (3)` … behind it.
    fn free_name(&self, name: &str, taken: &mut Vec<String>) -> String {
        let mut candidate = name.to_string();
        let mut n = 2;
        while taken.iter().any(|t| t.eq_ignore_ascii_case(&candidate)) {
            candidate = format!("{name} ({n})");
            n += 1;
        }
        taken.push(candidate.clone());
        candidate
    }

    /// The connections of a source, for the preview: what would be stored, whether a clear-text password
    /// stands there (the password itself stays here), what is missing, whether the name is taken.
    pub fn import_preview(
        &self,
        source: import::Source,
        path: Option<&std::path::Path>,
    ) -> AppResult<Vec<ImportItem>> {
        let names: Vec<String> = self.stored().into_iter().map(|p| p.name).collect();
        Ok(import::read(source, path)?
            .into_iter()
            .enumerate()
            .map(|(index, c)| ImportItem {
                index,
                name_taken: names
                    .iter()
                    .any(|n| n.eq_ignore_ascii_case(&c.profile.name)),
                has_password: c.password.is_some(),
                problem: c.problem,
                profile: c.profile,
            })
            .collect())
    }

    /// Stores the picked connections of a source. A password is stored (in the keychain) only for a
    /// pick that asks for it. A name that is taken gets a number. Returns what was stored.
    pub fn import_selected(
        &self,
        source: import::Source,
        path: Option<&std::path::Path>,
        picks: &[ImportPick],
    ) -> AppResult<Vec<Profile>> {
        let mut found: Vec<Option<import::Candidate>> =
            import::read(source, path)?.into_iter().map(Some).collect();
        let mut names: Vec<String> = self.stored().into_iter().map(|p| p.name).collect();
        let mut stored = Vec::new();
        for pick in picks.iter().take(import::MAX_CANDIDATES) {
            let Some(candidate) = found.get_mut(pick.index).and_then(Option::take) else {
                continue;
            };
            if candidate.problem.is_some() {
                continue;
            }
            let mut profile = candidate.profile;
            profile.id.clear();
            profile.name = self.free_name(&profile.name, &mut names);
            let password = candidate.password.filter(|_| pick.with_password);
            profile.save_password = password.is_some() || profile.save_password;
            stored.push(self.save(profile, password)?);
        }
        Ok(stored)
    }

    /// The stored profiles as a file for another machine: no ids, never a secret.
    pub fn export_profiles(&self) -> AppResult<String> {
        import::export_own(&self.stored())
    }

    /// What a statement is and what it needs on a connection.
    pub fn verdict(&self, id: &str, sql: &str, allow_dangerous: bool) -> AppResult<Verdict> {
        let profile = self.find(id)?;
        let class = guard::classify(sql, profile.kind);
        Ok(Verdict {
            class,
            need: guard::need(profile.protection, class, allow_dangerous),
        })
    }

    fn token() -> String {
        use std::hash::{BuildHasher, Hasher};
        // unguessable enough: the keys of the hasher are random per call
        let part = || {
            std::collections::hash_map::RandomState::new()
                .build_hasher()
                .finish()
        };
        format!("{:016x}{:016x}", part(), part())
    }

    /// The user said yes to these statements: a token for each that needed it (`None` for the others).
    /// Dangerous statements on a protected connection need its name, typed. Nothing that is refused gets a
    /// token.
    pub fn confirm(
        &self,
        id: &str,
        sqls: &[String],
        typed_name: Option<&str>,
        allow_dangerous: bool,
    ) -> AppResult<Vec<Option<String>>> {
        let profile = self.find(id)?;
        let verdicts: Vec<Verdict> = sqls
            .iter()
            .map(|sql| self.verdict(id, sql, allow_dangerous))
            .collect::<AppResult<_>>()?;
        if let Some(v) = verdicts.iter().find(|v| v.need == Need::Refused) {
            return Err(guard::refusal(Need::Refused, v.class));
        }
        if verdicts.iter().any(|v| v.need == Need::TypeName)
            && typed_name.map(str::trim) != Some(profile.name.trim())
        {
            return Err(AppError::new(
                ErrorCode::ConfirmationRequired,
                "the name of the connection was not typed as it is",
            ));
        }
        let now = std::time::Instant::now();
        let mut all = self.confirmations.lock();
        all.retain(|_, c| c.until > now);
        Ok(sqls
            .iter()
            .zip(&verdicts)
            .map(|(sql, v)| {
                (v.need != Need::Nothing).then(|| {
                    let token = Self::token();
                    all.insert(
                        token.clone(),
                        Confirmation {
                            connection: id.to_string(),
                            sql: sql.clone(),
                            until: now + CONFIRMATION_TTL,
                        },
                    );
                    token
                })
            })
            .collect())
    }

    /// Whether a statement may run now: it needs nothing, or `token` confirms exactly this statement on
    /// this connection. A token is spent by the run it admits.
    pub fn admit(
        &self,
        id: &str,
        sql: &str,
        token: Option<&str>,
        allow_dangerous: bool,
    ) -> AppResult<()> {
        let verdict = self.verdict(id, sql, allow_dangerous)?;
        match verdict.need {
            Need::Nothing => Ok(()),
            Need::Refused => Err(guard::refusal(Need::Refused, verdict.class)),
            need => {
                let mut all = self.confirmations.lock();
                let now = std::time::Instant::now();
                all.retain(|_, c| c.until > now);
                let fits = token
                    .and_then(|t| all.get(t))
                    .is_some_and(|c| c.connection == id && c.sql == sql);
                if !fits {
                    return Err(guard::refusal(need, verdict.class));
                }
                if let Some(t) = token {
                    all.remove(t);
                }
                Ok(())
            }
        }
    }

    /// Asks an open connection something of the app's own (metadata, prompt 008). It waits for the
    /// statement that runs on the session; `cancel` stops it like a statement.
    pub fn ask<T>(
        &self,
        id: &str,
        f: impl FnOnce(&mut dyn Session, DbKind, super::Stop) -> AppResult<T>,
    ) -> AppResult<T> {
        let kind = self.find(id)?.kind;
        let open = self.opened(id)?;
        let mut session = open.session.lock();
        open.stop.store(false, Ordering::Relaxed);
        let result = f(session.as_mut(), kind, &|| {
            open.stop.load(Ordering::Relaxed)
        });
        let lost = !session.is_open();
        drop(session);
        if lost {
            let mut all = self.open.lock();
            if all.get(id).is_some_and(|o| Arc::ptr_eq(o, &open)) {
                all.remove(id);
            }
        }
        result
    }

    /// Stops the statement that runs on a connection (nothing happens when none does).
    pub fn cancel(&self, id: &str) {
        self.cancel_in(id, None);
    }

    /// Stops the statement that runs on the session of a tab.
    pub fn cancel_in(&self, id: &str, tab: Option<&str>) {
        let Ok(profile) = self.find(id) else {
            return;
        };
        let Ok(key) = Self::key(&profile, id, tab) else {
            return;
        };
        if let Some(open) = self.open.lock().get(&key) {
            open.stop.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::meta;

    fn protected(m: &ConnectionManager, dir: &std::path::Path, protection: Protection) -> String {
        let file = dir.join(format!("{protection:?}.db"));
        rusqlite::Connection::open(&file)
            .unwrap()
            .execute_batch("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2);")
            .unwrap();
        let mut p = crate::db::tests::profile(DbKind::Sqlite);
        p.id = String::new();
        p.name = format!("Kasse {protection:?}");
        p.database = file.to_string_lossy().into_owned();
        p.protection = protection;
        p.label = "PROD".into();
        let saved = m.save(p, None).unwrap();
        m.open(&saved.id, None).unwrap();
        saved.id
    }

    fn count(m: &ConnectionManager, id: &str, tab: &str) -> serde_json::Value {
        let mut sink = VecSink::new(10);
        let (r, _) = m.run_in(
            id,
            Some(tab),
            "SELECT a FROM t ORDER BY a",
            None,
            &mut sink,
            false,
        );
        r.unwrap();
        serde_json::to_value(&sink.rows).unwrap()
    }

    fn run_tab(m: &ConnectionManager, id: &str, tab: &str, sql: &str, manual: bool) -> TxState {
        let mut sink = VecSink::new(10);
        let (r, tx) = m.run_in(id, Some(tab), sql, None, &mut sink, manual);
        r.unwrap_or_else(|e| panic!("{sql}: {e}"));
        tx
    }

    /// The `UPDATE`s that set `a` of the rows `(from, to, expected)`: found by `a`, locked on `a`.
    fn updates(rows: &[(i64, i64, i64)]) -> Vec<crate::db::filter::Built> {
        use crate::db::edit::{CellValue, RowUpdate, SetCell, UpdatePlan, build};
        use crate::db::filter::ValueKind;
        let cell = |v: i64| CellValue {
            column: "a".into(),
            kind: ValueKind::Number,
            type_name: String::new(),
            value: Some(v.to_string()),
        };
        let plan = UpdatePlan {
            schema: None,
            table: "t".into(),
            rows: rows
                .iter()
                .map(|(from, to, expected)| RowUpdate {
                    key: vec![cell(*from)],
                    set: vec![SetCell {
                        column: "a".into(),
                        kind: ValueKind::Number,
                        type_name: String::new(),
                        value: Some(to.to_string()),
                        default: false,
                    }],
                    expect: vec![cell(*expected)],
                })
                .collect(),
        };
        build(DbKind::Sqlite, &plan).unwrap()
    }

    /// Prompt 031: changed rows are written all or not at all, each statement changing exactly one row.
    #[test]
    fn changed_rows_are_written_together_or_not_at_all() {
        use serde_json::json;
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let id = protected(&m, dir.path(), Protection::Free);
        let done = m
            .apply_updates(
                &id,
                Some("a"),
                &updates(&[(1, 10, 1), (2, 20, 2)]),
                &[],
                None,
            )
            .unwrap();
        assert_eq!((done.done, done.failed, done.conflict), (2, None, false));
        assert!(done.error.is_none());
        assert_eq!(done.tx, TxState::Idle);
        // committed: another tab sees it
        assert_eq!(count(&m, &id, "b"), json!([[10], [20]]));

        // the second row is not what it was (somebody changed it): nothing is written, not the first either
        run_tab(&m, &id, "b", "UPDATE t SET a = 21 WHERE a = 20", false);
        let stale = m
            .apply_updates(
                &id,
                Some("a"),
                &updates(&[(10, 11, 10), (20, 22, 20)]),
                &[],
                None,
            )
            .unwrap();
        assert_eq!(
            (stale.done, stale.failed, stale.conflict),
            (0, Some(1), true)
        );
        assert_eq!(stale.tx, TxState::Idle);
        assert_eq!(count(&m, &id, "b"), json!([[10], [21]]));

        // a statement that would change two rows is no change of one row
        run_tab(&m, &id, "b", "INSERT INTO t VALUES (10)", false);
        let two = m
            .apply_updates(&id, Some("a"), &updates(&[(10, 12, 10)]), &[], None)
            .unwrap();
        assert_eq!((two.done, two.failed, two.conflict), (0, Some(0), true));
        assert_eq!(count(&m, &id, "b"), json!([[10], [10], [21]]));

        // an error of the database: rolled back, and said
        run_tab(
            &m,
            &id,
            "b",
            "CREATE UNIQUE INDEX t_a ON t (a) WHERE a > 100",
            false,
        );
        run_tab(&m, &id, "b", "INSERT INTO t VALUES (200)", false);
        let broken = m
            .apply_updates(
                &id,
                Some("a"),
                &updates(&[(21, 30, 21), (30, 200, 30)]),
                &[],
                None,
            )
            .unwrap();
        assert_eq!(
            (broken.done, broken.failed, broken.conflict),
            (0, Some(1), false)
        );
        assert!(broken.error.is_some());
        assert_eq!(count(&m, &id, "b"), json!([[10], [10], [21], [200]]));
    }

    #[test]
    fn writing_changes_respects_an_open_transaction_and_the_guard() {
        use serde_json::json;
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let id = protected(&m, dir.path(), Protection::Free);
        // the tab has a transaction of its own open: that is the user's, nothing is written into it
        run_tab(&m, &id, "a", "UPDATE t SET a = 5 WHERE a = 1", true);
        let refused = m
            .apply_updates(&id, Some("a"), &updates(&[(2, 20, 2)]), &[], None)
            .unwrap();
        assert!(refused.blocked);
        assert_eq!((refused.done, refused.tx), (0, TxState::Active));
        assert_eq!(m.tx_state(&id, Some("a")), TxState::Active);
        // … also when it was opened in a way the app did not notice (review 031): the server is asked
        m.end_transaction(&id, Some("a"), false).unwrap();
        run_tab(&m, &id, "a", "SAVEPOINT quiet", false);
        *m.session_of(&id, Some("a")).unwrap().1.tx.lock() = TxState::Idle;
        let hidden = m
            .apply_updates(&id, Some("a"), &updates(&[(2, 20, 2)]), &[], None)
            .unwrap();
        assert!(
            hidden.blocked,
            "a savepoint outside a transaction opens one in SQLite"
        );
        m.end_transaction(&id, Some("a"), false).unwrap();

        // a connection that only reads writes nothing
        let read_only = protected(&m, dir.path(), Protection::Readonly);
        let no = m.apply_updates(&read_only, Some("a"), &updates(&[(1, 10, 1)]), &[], None);
        assert_eq!(no.unwrap_err().code, ErrorCode::PermissionDenied);

        // a connection that asks wants every statement confirmed – before anything runs
        let ask = protected(&m, dir.path(), Protection::Ask);
        let statements = updates(&[(1, 10, 1), (2, 20, 2)]);
        let unasked = m.apply_updates(&ask, Some("a"), &statements, &[], None);
        assert_eq!(unasked.unwrap_err().code, ErrorCode::ConfirmationRequired);
        let sqls: Vec<String> = statements.iter().map(|s| s.sql.clone()).collect();
        let tokens = m.confirm(&ask, &sqls, None, false).unwrap();
        // one confirmation missing: nothing is written, not the confirmed one either
        let half = m.apply_updates(&ask, Some("a"), &statements, &tokens[..1], None);
        assert_eq!(half.unwrap_err().code, ErrorCode::ConfirmationRequired);
        assert_eq!(count(&m, &ask, "b"), json!([[1], [2]]));
        let tokens = m.confirm(&ask, &sqls, None, false).unwrap();
        let done = m
            .apply_updates(&ask, Some("a"), &statements, &tokens, None)
            .unwrap();
        assert_eq!(done.done, 2);
        assert_eq!(count(&m, &ask, "b"), json!([[10], [20]]));
    }

    #[test]
    fn a_change_in_manual_mode_is_the_tabs_own_until_it_commits() {
        use serde_json::json;
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let id = protected(&m, dir.path(), Protection::Free);
        assert_eq!(m.tx_state(&id, Some("a")), TxState::Idle);
        // manual: the first statement opens a transaction
        assert_eq!(
            run_tab(&m, &id, "a", "UPDATE t SET a = 10 WHERE a = 1", true),
            TxState::Active
        );
        assert_eq!(m.tx_state(&id, Some("a")), TxState::Active);
        assert_eq!(count(&m, &id, "a"), json!([[2], [10]]));
        // another tab does not see it
        assert_eq!(count(&m, &id, "b"), json!([[1], [2]]));
        assert_eq!(m.tx_state(&id, Some("b")), TxState::Idle);
        // rolled back: never
        assert_eq!(
            m.end_transaction(&id, Some("a"), false).unwrap(),
            TxState::Idle
        );
        assert_eq!(count(&m, &id, "b"), json!([[1], [2]]));
        // again, and committed: there
        run_tab(&m, &id, "a", "UPDATE t SET a = 10 WHERE a = 1", true);
        assert_eq!(
            m.end_transaction(&id, Some("a"), true).unwrap(),
            TxState::Idle
        );
        assert_eq!(count(&m, &id, "b"), json!([[2], [10]]));
    }

    #[test]
    fn the_state_follows_what_the_user_types() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let id = protected(&m, dir.path(), Protection::Free);
        // auto-commit: nothing stays open
        assert_eq!(
            run_tab(&m, &id, "a", "UPDATE t SET a = 5 WHERE a = 1", false),
            TxState::Idle
        );
        assert_eq!(run_tab(&m, &id, "a", "BEGIN", false), TxState::Active);
        assert_eq!(
            run_tab(&m, &id, "a", "SAVEPOINT s1", false),
            TxState::Active
        );
        assert_eq!(
            run_tab(&m, &id, "a", "ROLLBACK TO SAVEPOINT s1", false),
            TxState::Active
        );
        assert_eq!(run_tab(&m, &id, "a", "COMMIT", false), TxState::Idle);
        // manual mode sends a typed BEGIN as it is, not a second one before it
        assert_eq!(run_tab(&m, &id, "a", "BEGIN", true), TxState::Active);
        assert_eq!(run_tab(&m, &id, "a", "SELECT 1", true), TxState::Active);
        assert_eq!(run_tab(&m, &id, "a", "ROLLBACK", true), TxState::Idle);
        // a statement that fails in manual mode leaves the transaction it opened
        let mut sink = VecSink::new(1);
        let (r, tx) = m.run_in(&id, Some("a"), "SELECT * FROM nope", None, &mut sink, true);
        assert!(r.is_err());
        assert_eq!(tx, TxState::Active);
        assert_eq!(m.tx_state(&id, Some("a")), TxState::Active);
    }

    #[test]
    fn closing_a_session_or_the_connection_drops_what_was_open() {
        use serde_json::json;
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let id = protected(&m, dir.path(), Protection::Free);
        run_tab(&m, &id, "a", "DELETE FROM t WHERE a = 1", true);
        m.close_session(&id, "a");
        assert_eq!(m.tx_state(&id, Some("a")), TxState::Idle);
        assert_eq!(count(&m, &id, "b"), json!([[1], [2]]));
        // the connection itself is not a tab's to close
        m.close_session(&id, "");
        assert!(m.is_open(&id));
        run_tab(&m, &id, "b", "DELETE FROM t WHERE a = 1", true);
        m.close(&id);
        let mut sink = VecSink::new(1);
        let (r, _) = m.run_in(&id, Some("b"), "SELECT 1", None, &mut sink, false);
        assert_eq!(r.unwrap_err().code, ErrorCode::NotConnected);
        m.open(&id, None).unwrap();
        assert_eq!(count(&m, &id, "c"), json!([[1], [2]]));
        // a tab id is an id, nothing else
        let (r, _) = m.run_in(&id, Some("../x"), "SELECT 1", None, &mut sink, false);
        assert!(r.is_err());
    }

    #[test]
    fn the_demo_database_has_one_session_for_all_tabs() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        m.open("demo", None).unwrap();
        assert_eq!(
            run_tab(&m, "demo", "a", "CREATE TABLE zz (a)", false),
            TxState::Idle
        );
        // another tab sees the table: it is the same database in memory
        run_tab(&m, "demo", "b", "INSERT INTO zz VALUES (1)", false);
    }

    /// PostgreSQL and MySQL behind the SSH test server: needs the containers (`pnpm rust:test:db`).
    #[test]
    #[ignore]
    fn databases_behind_an_ssh_tunnel() {
        use crate::ssh::testserver;
        let dir = tempdir().unwrap();
        let (m, store) = manager(dir.path());
        let server = testserver::start(9, None).unwrap();
        for (kind, port, user, database) in [
            (DbKind::Postgres, 25432, "postgres", "postgres"),
            (DbKind::Mysql, 23306, "root", "shop"),
        ] {
            let mut p = crate::db::tests::profile(kind);
            p.id = String::new();
            p.name = format!("Hinter SSH {kind:?}");
            p.host = "127.0.0.1".into();
            p.port = port;
            p.user = user.into();
            p.database = database.into();
            p.save_password = true;
            p.ssh = Some(SshTarget {
                host: "127.0.0.1".into(),
                port: server.port,
                user: testserver::USER.into(),
                auth: SshAuth::Password,
                key_file: String::new(),
            });
            let saved = m.save(p, None).unwrap();
            let db = Some(Secret::new("Sc-test-003!"));
            let creds = |secret: Option<&str>, trust: Option<String>| SshCredentials {
                secret: secret.map(Secret::new),
                trust_fingerprint: trust,
            };
            // stage by stage: the host key, the SSH password, then the database
            let first = m.open_with(&saved.id, db.clone(), creds(None, None));
            let trust = match first {
                Err(e) if e.code == ErrorCode::HostKeyUnknown => {
                    let trust = Some(e.message.rsplit(' ').next().unwrap().to_string());
                    let e = m
                        .open_with(&saved.id, db.clone(), creds(None, trust.clone()))
                        .unwrap_err();
                    assert_eq!(e.code, ErrorCode::SshSecretRequired, "{e}");
                    let e = m
                        .open_with(&saved.id, db.clone(), creds(Some("wrong"), trust.clone()))
                        .unwrap_err();
                    assert_eq!(e.code, ErrorCode::SshSecretRequired);
                    trust
                }
                // the second profile: the host key is on record and the SSH password in the keychain
                Ok(_) => {
                    m.close(&saved.id);
                    None
                }
                Err(e) => panic!("{e}"),
            };
            let e = m
                .open_with(
                    &saved.id,
                    Some(Secret::new("not the db password")),
                    creds(Some(testserver::PASSWORD), trust.clone()),
                )
                .unwrap_err();
            assert_eq!(e.code, ErrorCode::AuthFailed, "{e}");
            let before = server.counters.tunnels.load(Ordering::SeqCst);
            let info = m
                .open_with(
                    &saved.id,
                    db.clone(),
                    creds(Some(testserver::PASSWORD), trust),
                )
                .unwrap();
            assert!(!info.server_version.is_empty());
            // the statement really went through the tunnel
            assert!(server.counters.tunnels.load(Ordering::SeqCst) > before);
            let r = m.run(&saved.id, "SELECT 40 + 2", None).unwrap();
            assert_eq!(
                serde_json::to_value(&r.rows).unwrap(),
                serde_json::json!([[42]])
            );
            // a statement is stopped on the server through the tunnel too (review 014 M2): the side
            // connection that asks for it is announced like the session itself
            if kind == DbKind::Postgres {
                let started = std::time::Instant::now();
                std::thread::scope(|scope| {
                    scope.spawn(|| {
                        std::thread::sleep(std::time::Duration::from_millis(400));
                        m.cancel(&saved.id);
                    });
                    let e = m.run(&saved.id, "SELECT pg_sleep(30)", None).unwrap_err();
                    assert_eq!(e.code, ErrorCode::Cancelled, "{e}");
                });
                assert!(
                    started.elapsed() < std::time::Duration::from_secs(6),
                    "{:?}",
                    started.elapsed()
                );
                // the session survived: it was cancelled on the server, not dropped
                assert!(m.run(&saved.id, "SELECT 1", None).is_ok());
            }
            // a tab gets its own session through the same tunnel, without being asked again
            let mut sink = VecSink::new(5);
            let (r, _) = m.run_in(&saved.id, Some("tab-1"), "SELECT 1", None, &mut sink, false);
            r.unwrap();
            // both passwords are in the keychain now – and nowhere in the profiles file
            m.close(&saved.id);
            m.open(&saved.id, None).unwrap();
            let file = std::fs::read_to_string(dir.path().join(profiles::FILE_NAME)).unwrap();
            assert!(!file.contains(testserver::PASSWORD) && !file.contains("Sc-test-003!"));
            assert!(store.len() >= 2);
            m.close(&saved.id);
        }
    }

    #[test]
    fn imports_what_is_ticked_with_passwords_only_where_asked() {
        let dir = tempdir().unwrap();
        let (m, store) = manager(dir.path());
        let pgpass = dir.path().join(".pgpass");
        std::fs::write(
            &pgpass,
            "db.example:5432:shop:app:s3cret-one\ndb.example:5432:shop:app:s3cret-two\n*:*:*:x:y\nother.example:5433:crm:crm:s3cret-three\n",
        )
        .unwrap();
        let preview = m
            .import_preview(import::Source::Pgpass, Some(&pgpass))
            .unwrap();
        assert_eq!(preview.len(), 4);
        assert!(preview[0].has_password && preview[0].problem.is_none() && !preview[0].name_taken);
        // the wildcard line has no host
        assert!(preview[2].problem.is_some());
        // nothing of a password is in what goes to the window
        assert!(!serde_json::to_string(&preview).unwrap().contains("s3cret"));

        let picks = [
            ImportPick {
                index: 0,
                with_password: true,
            },
            ImportPick {
                index: 1,
                with_password: false,
            },
            ImportPick {
                index: 2,
                with_password: true,
            },
            ImportPick {
                index: 99,
                with_password: true,
            },
        ];
        let stored = m
            .import_selected(import::Source::Pgpass, Some(&pgpass), &picks)
            .unwrap();
        // the one with a problem and the one that is not there are left out
        let names: Vec<&str> = stored.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["shop@db.example", "shop@db.example (2)"]);
        assert!(stored.iter().all(|p| !p.id.is_empty()));
        // one password went to the keychain, none into the file
        assert_eq!(store.len(), 1);
        let file = std::fs::read_to_string(dir.path().join(profiles::FILE_NAME)).unwrap();
        assert!(!file.contains("s3cret"));
        // the next preview knows the names
        let again = m
            .import_preview(import::Source::Pgpass, Some(&pgpass))
            .unwrap();
        assert!(again[0].name_taken && !again[3].name_taken);

        // our own export has the profiles and no secret, and comes back in
        let export = m.export_profiles().unwrap();
        assert!(!export.contains("s3cret") && export.contains("shop@db.example (2)"));
        let own = dir.path().join("export.json");
        std::fs::write(&own, export).unwrap();
        let back = m
            .import_selected(
                import::Source::Own,
                Some(&own),
                &[ImportPick {
                    index: 0,
                    with_password: true,
                }],
            )
            .unwrap();
        assert_eq!(back[0].name, "shop@db.example (3)");
    }

    #[test]
    fn a_free_connection_asks_only_for_what_destroys() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let id = protected(&m, dir.path(), Protection::Free);
        m.admit(&id, "UPDATE t SET a = 5 WHERE a = 1", None, false)
            .unwrap();
        let e = m.admit(&id, "DELETE FROM t", None, false).unwrap_err();
        assert_eq!(e.code, ErrorCode::ConfirmationRequired);
        // the user's setting lets it pass
        m.admit(&id, "DELETE FROM t", None, true).unwrap();
        let tokens = m
            .confirm(
                &id,
                &["DELETE FROM t".into(), "SELECT 1".into()],
                None,
                false,
            )
            .unwrap();
        assert!(tokens[0].is_some() && tokens[1].is_none());
        m.admit(&id, "DELETE FROM t", tokens[0].as_deref(), false)
            .unwrap();
    }

    #[test]
    fn a_confirmation_admits_one_run_of_exactly_that_statement_there() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let id = protected(&m, dir.path(), Protection::Ask);
        let other = protected(&m, dir.path(), Protection::Free);
        let sql = "UPDATE t SET a = 5 WHERE a = 1".to_string();
        assert_eq!(
            m.verdict(&id, &sql, true).unwrap(),
            Verdict {
                class: Class::Write,
                need: Need::Confirm
            }
        );
        // without a token, with a made-up one, with one for another statement or connection: no
        let denied = |token: Option<&str>, sql: &str| {
            m.admit(&id, sql, token, true).unwrap_err().code == ErrorCode::ConfirmationRequired
        };
        assert!(denied(None, &sql));
        assert!(denied(Some("0000000000000000"), &sql));
        let token = m
            .confirm(&id, std::slice::from_ref(&sql), None, false)
            .unwrap()[0]
            .clone()
            .unwrap();
        assert!(denied(Some(&token), "UPDATE t SET a = 6 WHERE a = 1"));
        let elsewhere = m
            .confirm(&other, &["DELETE FROM t".into()], None, false)
            .unwrap()[0]
            .clone()
            .unwrap();
        assert!(denied(Some(&elsewhere), "DELETE FROM t"));
        // the right one admits once
        m.admit(&id, &sql, Some(&token), false).unwrap();
        assert!(denied(Some(&token), &sql));
        // reading never needs one
        m.admit(&id, "SELECT * FROM t", None, false).unwrap();
    }

    #[test]
    fn what_destroys_on_a_protected_connection_needs_its_name_typed() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let id = protected(&m, dir.path(), Protection::Ask);
        let sqls = vec!["SELECT 1".to_string(), "DROP TABLE t".to_string()];
        for wrong in [None, Some(""), Some("kasse ask"), Some("Kasse")] {
            let e = m.confirm(&id, &sqls, wrong, true).unwrap_err();
            assert_eq!(e.code, ErrorCode::ConfirmationRequired, "{wrong:?}");
        }
        let tokens = m.confirm(&id, &sqls, Some(" Kasse Ask "), true).unwrap();
        assert!(tokens[0].is_none());
        m.admit(&id, "DROP TABLE t", tokens[1].as_deref(), true)
            .unwrap();
    }

    #[test]
    fn a_read_only_connection_refuses_every_write_here_and_on_the_server() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let id = protected(&m, dir.path(), Protection::Readonly);
        for sql in [
            "INSERT INTO t VALUES (3)",
            "WITH d AS (SELECT 1) DELETE FROM t WHERE a = 1",
            "SELECT 1; DROP TABLE t",
            "PRAGMA query_only = OFF",
            "CREATE TABLE u (a)",
        ] {
            assert_eq!(
                m.admit(&id, sql, None, true).unwrap_err().code,
                ErrorCode::PermissionDenied,
                "{sql}"
            );
            // no confirmation can be had for it
            assert_eq!(
                m.confirm(&id, &[sql.to_string()], Some("Kasse Readonly"), true)
                    .unwrap_err()
                    .code,
                ErrorCode::PermissionDenied
            );
            // and whoever gets past the check meets the server – but for the one statement that turns
            // the server's own guard off: that one only the check stops
            if !sql.starts_with("PRAGMA") {
                assert!(m.run(&id, sql, None).is_err(), "{sql}");
            }
        }
        m.admit(&id, "SELECT * FROM t", None, false).unwrap();
        let rows = m.run(&id, "SELECT count(*) FROM t", None).unwrap();
        assert_eq!(
            serde_json::to_value(&rows.rows).unwrap(),
            serde_json::json!([[2]])
        );
    }

    #[test]
    fn asks_the_demo_database_what_is_in_it() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        // not connected yet
        assert_eq!(
            m.ask("demo", meta::schemas).unwrap_err().code,
            ErrorCode::NotConnected
        );
        m.open("demo", None).unwrap();
        let schemas = m.ask("demo", meta::schemas).unwrap();
        assert_eq!(schemas[0].name, "main");
        let objects = m
            .ask("demo", |s, kind, stop| meta::objects(s, kind, "main", stop))
            .unwrap();
        assert_eq!(objects.len(), 3);
        assert_eq!(
            m.ask("nope", meta::schemas).unwrap_err().code,
            ErrorCode::UnknownConnection
        );
    }

    use crate::db::secrets::MemoryStore;
    use crate::db::{DbKind, TlsMode};
    use tempfile::tempdir;

    fn manager(dir: &std::path::Path) -> (ConnectionManager, Arc<MemoryStore>) {
        let store = Arc::new(MemoryStore::default());
        let m = ConnectionManager::new(dir.join(profiles::FILE_NAME), store.clone());
        (m, store)
    }

    fn pg(name: &str) -> Profile {
        Profile {
            id: String::new(),
            name: name.into(),
            kind: DbKind::Postgres,
            host: "127.0.0.1".into(),
            // nothing listens here
            port: 1,
            database: "x".into(),
            user: "alice".into(),
            tls: TlsMode::Off,
            folder: String::new(),
            color: 2,
            save_password: true,
            protection: crate::db::guard::Protection::Free,
            label: String::new(),
            ca_file: String::new(),
            client_cert: String::new(),
            client_key: String::new(),
            ssh: None,
        }
    }

    #[test]
    fn lists_the_demo_first_and_runs_on_it() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        assert_eq!(m.list().profiles[0].id, "demo");
        assert_eq!(
            m.run("demo", "SELECT 1", None).unwrap_err().code,
            ErrorCode::NotConnected
        );
        let info = m.open("demo", None).unwrap();
        assert!(info.server_version.starts_with("SQLite"));
        assert_eq!(
            m.run("demo", "SELECT count(*) FROM orders", None)
                .unwrap()
                .rows
                .len(),
            1
        );
        m.close("demo");
        assert!(!m.is_open("demo"));
        assert_eq!(
            m.open("nope", None).unwrap_err().code,
            ErrorCode::UnknownConnection
        );
    }

    #[test]
    fn stores_profiles_with_ids_and_keeps_passwords_out_of_the_file() {
        let dir = tempdir().unwrap();
        let (m, store) = manager(dir.path());
        let a = m
            .save(pg("Lokal"), Some(Secret::new("geheim-Qx7")))
            .unwrap();
        let b = m.save(pg("Lokal"), None).unwrap();
        assert_eq!(a.id, "lokal");
        assert_eq!(b.id, "lokal-2");
        assert_eq!(store.len(), 1);
        let text = std::fs::read_to_string(dir.path().join(profiles::FILE_NAME)).unwrap();
        assert!(!text.contains("geheim-Qx7"));
        // a second manager reads what the first stored
        let (again, _) = manager(dir.path());
        assert_eq!(again.list().profiles.len(), 3);
        // the demo connection is not a stored profile
        let mut demo = sqlite::demo_profile();
        demo.name = "Meins".into();
        assert_eq!(
            m.save(demo, None).unwrap_err().code,
            ErrorCode::InvalidProfile
        );
    }

    #[test]
    fn forgets_the_password_when_asked_to_or_when_the_profile_goes() {
        let dir = tempdir().unwrap();
        let (m, store) = manager(dir.path());
        let mut a = m.save(pg("Lokal"), Some(Secret::new("pw"))).unwrap();
        assert_eq!(store.len(), 1);
        a.save_password = false;
        m.save(a.clone(), None).unwrap();
        assert_eq!(store.len(), 0);
        a.save_password = true;
        m.save(a.clone(), Some(Secret::new("pw"))).unwrap();
        // another user: the old entry belongs to nothing any more
        a.user = "bob".into();
        m.save(a.clone(), None).unwrap();
        assert_eq!(store.len(), 0);
        m.save(a.clone(), Some(Secret::new("pw2"))).unwrap();
        m.delete(&a.id).unwrap();
        assert_eq!(store.len(), 0);
        assert_eq!(
            m.delete(&a.id).unwrap_err().code,
            ErrorCode::UnknownConnection
        );
    }

    #[test]
    fn asks_for_a_password_it_does_not_know() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let a = m.save(pg("Lokal"), None).unwrap();
        assert_eq!(
            m.open(&a.id, None).unwrap_err().code,
            ErrorCode::SecretRequired
        );
        assert_eq!(
            m.test(&a, None).unwrap_err().code,
            ErrorCode::SecretRequired
        );
        // with one it gets as far as the network: nothing listens on port 1
        let e = m.open(&a.id, Some(Secret::new("pw"))).unwrap_err();
        assert_eq!(e.code, ErrorCode::ConnectionFailed);
        assert!(!e.message.contains("pw"), "{}", e.message);
    }

    #[test]
    fn stops_a_running_statement_from_another_thread() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        let m = Arc::new(m);
        m.open("demo", None).unwrap();
        let runner = m.clone();
        let endless = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) \
                       SELECT count(*) FROM n";
        let handle = std::thread::spawn(move || runner.run("demo", endless, None));
        // the statement runs until it is stopped; the stop flag is cleared when it starts
        let started = std::time::Instant::now();
        loop {
            m.cancel("demo");
            if handle.is_finished() {
                break;
            }
            assert!(
                started.elapsed().as_secs() < 60,
                "the statement did not stop"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(
            handle.join().unwrap().unwrap_err().code,
            ErrorCode::Cancelled
        );
        // SQLite survives a stop: the connection is still open
        assert_eq!(m.run("demo", "SELECT 1", None).unwrap().rows.len(), 1);
    }
}
