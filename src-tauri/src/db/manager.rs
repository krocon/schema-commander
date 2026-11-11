//! The open connections (prompt 003): one session per profile, opened on request, each behind its own lock.
//! A statement that runs can be stopped from another thread ([`ConnectionManager::cancel`]).

use super::profiles::{self, LoadedProfiles};
use super::secrets::{self, Secret, SecretKind, SecretStore};
use super::value::{MAX_ROWS, QueryResult};
use super::{Profile, Session, connect, sqlite};
use crate::error::{AppError, AppResult, ErrorCode};
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
}

pub struct ConnectionManager {
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

impl ConnectionManager {
    /// `file`: `connections.json`; `store`: where passwords are kept.
    pub fn new(file: PathBuf, store: Arc<dyn SecretStore>) -> Self {
        Self {
            file,
            store,
            profiles: Mutex::new(None),
            notice: Mutex::new(None),
            open: Mutex::new(HashMap::new()),
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
        let secret = self.secret_for(profile, password)?;
        let mut session = connect(profile, secret.as_ref(), &|| false)?;
        session.server_version(&|| false)
    }

    /// Opens the connection of a profile (an open one is replaced). After a login that worked the password
    /// goes into the keychain if the profile says so.
    pub fn open(&self, id: &str, password: Option<Secret>) -> AppResult<ConnectionInfo> {
        let profile = self.find(id)?;
        let given = password.is_some();
        let secret = self.secret_for(&profile, password)?;
        let mut session = connect(&profile, secret.as_ref(), &|| false)?;
        let server_version = session.server_version(&|| false)?;
        if given
            && profile.save_password
            && let Some(secret) = secret.as_ref().filter(|s| !s.is_empty())
        {
            // a keychain that fails must not undo a login that worked
            let _ = self.store.set(&Self::account(&profile), secret);
        }
        self.open.lock().insert(
            id.to_string(),
            Arc::new(Open {
                session: Mutex::new(session),
                stop: AtomicBool::new(false),
            }),
        );
        Ok(ConnectionInfo {
            id: id.to_string(),
            server_version,
        })
    }

    pub fn close(&self, id: &str) {
        if let Some(open) = self.open.lock().remove(id) {
            // a statement that still runs ends, then the session is dropped with its last owner
            open.stop.store(true, Ordering::Relaxed);
        }
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.open.lock().contains_key(id)
    }

    fn opened(&self, id: &str) -> AppResult<Arc<Open>> {
        self.open.lock().get(id).cloned().ok_or_else(|| {
            AppError::new(ErrorCode::NotConnected, format!("„{id}“ is not connected"))
        })
    }

    /// Runs one statement on an open connection. One at a time per connection: a second call waits.
    pub fn run(&self, id: &str, sql: &str) -> AppResult<QueryResult> {
        let open = self.opened(id)?;
        let mut session = open.session.lock();
        open.stop.store(false, Ordering::Relaxed);
        let result = session.execute(sql, MAX_ROWS, &|| open.stop.load(Ordering::Relaxed));
        let lost = !session.is_open();
        drop(session);
        if lost {
            // cancelled or broken: the session is gone, the next statement needs a new connection
            let mut all = self.open.lock();
            if all.get(id).is_some_and(|o| Arc::ptr_eq(o, &open)) {
                all.remove(id);
            }
        }
        result
    }

    /// Stops the statement that runs on a connection (nothing happens when none does).
    pub fn cancel(&self, id: &str) {
        if let Some(open) = self.open.lock().get(id) {
            open.stop.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        }
    }

    #[test]
    fn lists_the_demo_first_and_runs_on_it() {
        let dir = tempdir().unwrap();
        let (m, _) = manager(dir.path());
        assert_eq!(m.list().profiles[0].id, "demo");
        assert_eq!(
            m.run("demo", "SELECT 1").unwrap_err().code,
            ErrorCode::NotConnected
        );
        let info = m.open("demo", None).unwrap();
        assert!(info.server_version.starts_with("SQLite"));
        assert_eq!(
            m.run("demo", "SELECT count(*) FROM orders")
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
        let handle = std::thread::spawn(move || runner.run("demo", endless));
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
        assert_eq!(m.run("demo", "SELECT 1").unwrap().rows.len(), 1);
    }
}
