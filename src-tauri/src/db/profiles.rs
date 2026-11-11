//! The stored connections (prompt 003): `connections.json` in the app's config folder. Never a secret:
//! [`Profile`] has no field for one, passwords live in the keychain of the OS ([`super::secrets`]).

use super::{DbKind, Profile};
use crate::error::{AppError, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "connections.json";
pub const VERSION: u32 = 1;
pub const MAX_PROFILES: usize = 500;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_NAME_LEN: usize = 100;
pub const MAX_FIELD_LEN: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfilesFile {
    version: u32,
    profiles: Vec<Profile>,
}

/// What `load` found; `notice` says when the file was broken or entries were dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProfiles {
    pub profiles: Vec<Profile>,
    pub notice: Option<String>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidProfile, message)
}

fn plain(text: &str, max: usize) -> bool {
    text.chars().count() <= max && !text.chars().any(char::is_control)
}

pub fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A host name or address: no spaces, no path, no user part – it only ever names a machine.
fn host_ok(host: &str) -> bool {
    let h = host.trim();
    !h.is_empty()
        && h.len() <= 253
        && h.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']' | '%')
        })
}

/// Refuses a profile a driver must not get. The id is not looked at (a new profile has none).
pub fn check(p: &Profile) -> AppResult<()> {
    if p.name.trim().is_empty() || !plain(&p.name, MAX_NAME_LEN) {
        return Err(invalid("the name is missing or not allowed"));
    }
    if !(1..=8).contains(&p.color) {
        return Err(invalid("the colour must be 1 to 8"));
    }
    for (what, text) in [
        ("database", &p.database),
        ("user", &p.user),
        ("folder", &p.folder),
    ] {
        if !plain(text, MAX_FIELD_LEN) {
            return Err(invalid(format!("{what}: too long or control characters")));
        }
    }
    if p.kind == DbKind::Sqlite {
        if p.database.trim().is_empty() {
            return Err(invalid("the path of the database file is missing"));
        }
        return Ok(());
    }
    if !host_ok(&p.host) {
        return Err(invalid("the host is missing or not a host name"));
    }
    if p.user.trim().is_empty() {
        return Err(invalid("the user is missing"));
    }
    Ok(())
}

/// `user-given name` → an id not taken yet (`lokal`, `lokal-2` …).
pub fn new_id(name: &str, taken: &[&str]) -> String {
    let mut slug = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug: String = slug.chars().take(48).collect();
    let base = if slug.is_empty() {
        "verbindung".to_string()
    } else {
        slug
    };
    if !taken.contains(&base.as_str()) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|c| !taken.contains(&c.as_str()))
        .unwrap_or(base)
}

fn io_error(e: &std::io::Error) -> AppError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        _ => ErrorCode::Io,
    };
    AppError::new(code, e.to_string())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn set_aside(path: &Path) {
    let mut aside = path.as_os_str().to_owned();
    aside.push(".broken");
    let _ = fs::rename(path, PathBuf::from(aside));
}

/// The stored profiles, forgiving: no file = none; a broken file is set aside; entries that break a rule
/// are dropped. Never fails.
pub fn load(path: &Path) -> LoadedProfiles {
    let none = |notice: Option<String>| LoadedProfiles {
        profiles: Vec::new(),
        notice,
    };
    let mut bytes = Vec::new();
    match fs::File::open(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return none(None),
        Err(e) => return none(Some(format!("connections could not be read: {e}"))),
        Ok(file) => {
            if let Err(e) = file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes) {
                return none(Some(format!("connections could not be read: {e}")));
            }
        }
    }
    let parsed = if bytes.len() as u64 > MAX_FILE_BYTES {
        None
    } else {
        serde_json::from_slice::<ProfilesFile>(&bytes)
            .ok()
            .filter(|f| f.version == VERSION)
    };
    let Some(file) = parsed else {
        set_aside(path);
        return none(Some(
            "the file of the connections was broken and has been set aside".to_string(),
        ));
    };
    let mut profiles: Vec<Profile> = Vec::new();
    let mut dropped = 0usize;
    for p in file.profiles {
        let keep = profiles.len() < MAX_PROFILES
            && id_ok(&p.id)
            && check(&p).is_ok()
            && !profiles.iter().any(|o| o.id == p.id);
        if keep {
            profiles.push(p);
        } else {
            dropped += 1;
        }
    }
    let notice = (dropped > 0).then(|| format!("{dropped} invalid connection(s) were ignored"));
    LoadedProfiles { profiles, notice }
}

pub fn save(path: &Path, profiles: &[Profile]) -> AppResult<()> {
    if profiles.len() > MAX_PROFILES {
        return Err(invalid("too many connections"));
    }
    for (i, p) in profiles.iter().enumerate() {
        if !id_ok(&p.id) {
            return Err(invalid("a connection has no valid id"));
        }
        check(p)?;
        if profiles[..i].iter().any(|o| o.id == p.id) {
            return Err(invalid("two connections share an id"));
        }
    }
    let file = ProfilesFile {
        version: VERSION,
        profiles: profiles.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(|e| invalid(e.to_string()))?;
    write_atomic(path, &bytes).map_err(|e| io_error(&e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::TlsMode;
    use tempfile::tempdir;

    fn profile(id: &str) -> Profile {
        Profile {
            id: id.into(),
            name: "Lokal – Prüfung".into(),
            kind: DbKind::Postgres,
            host: "localhost".into(),
            port: 5433,
            database: "shop".into(),
            user: "alice".into(),
            tls: TlsMode::Off,
            folder: "Entwicklung".into(),
            color: 3,
            save_password: true,
        }
    }

    #[test]
    fn checks_what_a_driver_must_not_get() {
        assert!(check(&profile("a")).is_ok());
        let bad = |f: &dyn Fn(&mut Profile)| {
            let mut p = profile("a");
            f(&mut p);
            check(&p).unwrap_err().code
        };
        assert_eq!(bad(&|p| p.name = "  ".into()), ErrorCode::InvalidProfile);
        assert_eq!(bad(&|p| p.name = "a\nb".into()), ErrorCode::InvalidProfile);
        assert_eq!(bad(&|p| p.host = String::new()), ErrorCode::InvalidProfile);
        assert_eq!(
            bad(&|p| p.host = "db host".into()),
            ErrorCode::InvalidProfile
        );
        assert_eq!(
            bad(&|p| p.host = "user@host/path".into()),
            ErrorCode::InvalidProfile
        );
        assert_eq!(bad(&|p| p.user = String::new()), ErrorCode::InvalidProfile);
        assert_eq!(bad(&|p| p.color = 9), ErrorCode::InvalidProfile);
        assert_eq!(
            bad(&|p| p.database = "x".repeat(2000)),
            ErrorCode::InvalidProfile
        );
        // IPv6 and names with dashes are hosts
        let mut v6 = profile("a");
        v6.host = "[::1]".into();
        assert!(check(&v6).is_ok());
        // SQLite needs a file, no host or user
        let mut lite = profile("a");
        lite.kind = DbKind::Sqlite;
        lite.host = String::new();
        lite.user = String::new();
        lite.database = "/tmp/Meine Daten/ä.db".into();
        assert!(check(&lite).is_ok());
        lite.database = " ".into();
        assert!(check(&lite).is_err());
    }

    #[test]
    fn makes_ids_from_names() {
        assert_eq!(new_id("Lokal – Prüfung 1", &[]), "lokal-pr-fung-1");
        assert_eq!(new_id("Lokal", &["lokal", "lokal-2"]), "lokal-3");
        assert_eq!(new_id("日本", &[]), "verbindung");
        assert!(id_ok(&new_id(&"x".repeat(300), &[])));
        assert!(!id_ok("") && !id_ok("A") && !id_ok("a b") && !id_ok("../x"));
    }

    #[test]
    fn saves_and_loads_without_any_secret() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sub").join(FILE_NAME);
        let stored = vec![profile("a"), profile("b")];
        save(&path, &stored).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.profiles, stored);
        assert_eq!(loaded.notice, None);
        let text = fs::read_to_string(&path).unwrap().to_lowercase();
        assert!(!text.contains("password\":") || text.contains("savepassword"));
        assert!(!text.contains("secret"));
    }

    #[test]
    fn a_missing_file_is_empty_and_a_broken_one_is_set_aside() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        assert_eq!(load(&path).profiles, vec![]);
        assert_eq!(load(&path).notice, None);
        fs::write(&path, b"{ nope").unwrap();
        assert!(load(&path).notice.is_some());
        assert!(!path.exists());
        assert!(dir.path().join("connections.json.broken").exists());
    }

    #[test]
    fn drops_invalid_entries_and_refuses_to_save_them() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut hostile = profile("x");
        hostile.host = "evil host; rm -rf".into();
        let file = ProfilesFile {
            version: VERSION,
            profiles: vec![profile("a"), hostile.clone(), profile("a"), profile("B")],
        };
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.profiles, vec![profile("a")]);
        assert!(loaded.notice.unwrap().starts_with('3'));
        assert!(save(&path, &[hostile]).is_err());
        assert!(save(&path, &[profile("a"), profile("a")]).is_err());
        assert!(save(&path, &[profile("")]).is_err());
    }
}
