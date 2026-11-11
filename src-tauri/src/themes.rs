//! Own colour schemes (design 001 E3): one file `themes.json` in the app's config folder, with bounds and
//! checks here in the backend. Pure (no Tauri), tested below. After files-and-folders-tauri `themes.rs`.
//!
//! The frontend checks every token against its catalog on top of this (`sanitizeTokens`); here only the
//! shape, the sizes and harmless values are enforced, so nothing absurd is ever written or read.

use crate::error::{AppError, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "themes.json";
pub const VERSION: u32 = 1;
pub const MAX_THEMES: usize = 50;
pub const MAX_TOKENS: usize = 300;
pub const MAX_NAME_LEN: usize = 100;
pub const MAX_ID_LEN: usize = 64;
pub const MAX_TOKEN_NAME_LEN: usize = 80;
pub const MAX_VALUE_LEN: usize = 200;
/// The whole file, and a file to import.
pub const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Own schemes carry this prefix: they can never shadow a built-in one.
pub const ID_PREFIX: &str = "user-";

const BAD_FUNCS: [&str; 7] = [
    "url(",
    "expression(",
    "image(",
    "image-set(",
    "element(",
    "attr(",
    "env(",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTheme {
    pub id: String,
    pub name: String,
    pub dark: bool,
    /// Only what differs from the base of its brightness (`--bg-app` → `#14171c`).
    pub tokens: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemesFile {
    pub version: u32,
    pub themes: Vec<UserTheme>,
}

/// What `load` found. `notice` says in words when the file was broken or entries were dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedThemes {
    pub themes: Vec<UserTheme>,
    pub notice: Option<String>,
}

/// `user-` followed by `[a-z0-9-]`, at most [`MAX_ID_LEN`] bytes in all.
pub fn id_ok(id: &str) -> bool {
    id.len() <= MAX_ID_LEN
        && id.strip_prefix(ID_PREFIX).is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// A name the user sees: not empty, bounded, no control characters.
pub fn name_ok(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && name.chars().count() <= MAX_NAME_LEN
        && !name.chars().any(char::is_control)
}

/// `--` followed by `[a-z0-9-]`.
pub fn token_name_ok(name: &str) -> bool {
    name.len() <= MAX_TOKEN_NAME_LEN
        && name.strip_prefix("--").is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// A harmless CSS value: short, no `; { } < > \ @`, no control characters, nothing that loads resources.
pub fn value_ok(value: &str) -> bool {
    let v = value.trim();
    if v.is_empty() || v.chars().count() > MAX_VALUE_LEN {
        return false;
    }
    if v.chars()
        .any(|c| c.is_control() || matches!(c, ';' | '{' | '}' | '<' | '>' | '\\' | '@'))
    {
        return false;
    }
    let lower = v.to_lowercase();
    !BAD_FUNCS.iter().any(|f| lower.contains(f))
}

/// Why a scheme cannot be kept, `None` = fine.
pub fn theme_problem(theme: &UserTheme) -> Option<&'static str> {
    if !id_ok(&theme.id) {
        return Some("invalid id");
    }
    if !name_ok(&theme.name) {
        return Some("invalid name");
    }
    if theme.tokens.len() > MAX_TOKENS {
        return Some("too many tokens");
    }
    if theme
        .tokens
        .iter()
        .any(|(k, v)| !token_name_ok(k) || !value_ok(v))
    {
        return Some("invalid token");
    }
    None
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidTheme, message)
}

/// Refuses a file that breaks a bound, has another version or two schemes with one id.
pub fn validate(file: &ThemesFile) -> AppResult<()> {
    if file.version != VERSION {
        return Err(invalid("unknown version"));
    }
    if file.themes.len() > MAX_THEMES {
        return Err(invalid("too many colour schemes"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for theme in &file.themes {
        if let Some(problem) = theme_problem(theme) {
            return Err(invalid(format!("{}: {problem}", theme.id)));
        }
        if !seen.insert(theme.id.as_str()) {
            return Err(invalid(format!("{}: duplicate id", theme.id)));
        }
    }
    Ok(())
}

fn io_error(e: &io::Error) -> AppError {
    let code = match e.kind() {
        io::ErrorKind::NotFound => ErrorCode::NotFound,
        _ => ErrorCode::Io,
    };
    AppError::new(code, e.to_string())
}

/// Reads at most [`MAX_FILE_BYTES`]; a longer file is `too_large`.
fn read_bounded(path: &Path) -> AppResult<Vec<u8>> {
    let file = fs::File::open(path).map_err(|e| io_error(&e))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(&e))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::new(ErrorCode::TooLarge, "file is too large"));
    }
    Ok(bytes)
}

/// Writes next to the target and renames: the target is never left half written.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
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

/// A broken file is moved aside (`themes.json.broken`), so the next save does not destroy what a person
/// might still repair by hand.
fn set_aside(path: &Path) {
    let mut aside = path.as_os_str().to_owned();
    aside.push(".broken");
    let _ = fs::rename(path, PathBuf::from(aside));
}

/// The stored schemes, forgiving: no file = none; a broken file is set aside; entries that break a rule
/// are dropped. Never fails – the app starts with the built-in schemes in the worst case.
pub fn load(path: &Path) -> LoadedThemes {
    let none = |notice: Option<String>| LoadedThemes {
        themes: Vec::new(),
        notice,
    };
    let bytes = match read_bounded(path) {
        Ok(bytes) => bytes,
        Err(e) if e.code == ErrorCode::NotFound => return none(None),
        Err(e) => {
            if e.code == ErrorCode::TooLarge {
                set_aside(path);
            }
            return none(Some(format!(
                "colour schemes could not be read: {}",
                e.message
            )));
        }
    };
    let file: ThemesFile = match serde_json::from_slice(&bytes) {
        Ok(file) => file,
        Err(_) => {
            set_aside(path);
            return none(Some(
                "the file of the colour schemes was broken and has been set aside".to_string(),
            ));
        }
    };
    if file.version != VERSION {
        set_aside(path);
        return none(Some(
            "the file of the colour schemes has an unknown version and has been set aside"
                .to_string(),
        ));
    }
    let mut themes: Vec<UserTheme> = Vec::new();
    let mut dropped = 0usize;
    for theme in file.themes {
        let keep = themes.len() < MAX_THEMES
            && theme_problem(&theme).is_none()
            && !themes.iter().any(|t| t.id == theme.id);
        if keep {
            themes.push(theme);
        } else {
            dropped += 1;
        }
    }
    let notice = (dropped > 0).then(|| format!("{dropped} invalid colour scheme(s) were ignored"));
    LoadedThemes { themes, notice }
}

pub fn save(path: &Path, file: &ThemesFile) -> AppResult<()> {
    validate(file)?;
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| invalid(e.to_string()))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::new(ErrorCode::TooLarge, "too much to store"));
    }
    write_atomic(path, &bytes).map_err(|e| io_error(&e))
}

/// A file to import, as JSON: the frontend decides what of it is a scheme and reports what it dropped.
/// Only an object is passed on.
pub fn import(path: &Path) -> AppResult<serde_json::Value> {
    let bytes = read_bounded(path)?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| invalid("not a colour scheme file"))?;
    if !value.is_object() {
        return Err(invalid("not a colour scheme file"));
    }
    Ok(value)
}

/// Writes one scheme as a file of its own (`{ id, name, dark, tokens }`).
pub fn export(path: &Path, theme: &UserTheme) -> AppResult<()> {
    if let Some(problem) = theme_problem(theme) {
        return Err(invalid(problem));
    }
    let mut bytes = serde_json::to_vec_pretty(theme).map_err(|e| invalid(e.to_string()))?;
    bytes.push(b'\n');
    write_atomic(path, &bytes).map_err(|e| io_error(&e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn theme(id: &str) -> UserTheme {
        UserTheme {
            id: id.to_string(),
            name: "Mein Schema – grün".to_string(),
            dark: true,
            tokens: BTreeMap::from([
                ("--bg-app".to_string(), "#001100".to_string()),
                ("--font-mono".to_string(), "Menlo, monospace".to_string()),
            ]),
        }
    }

    fn file(themes: Vec<UserTheme>) -> ThemesFile {
        ThemesFile {
            version: VERSION,
            themes,
        }
    }

    #[test]
    fn ids_need_the_prefix_and_plain_characters() {
        assert!(id_ok("user-mein-schema-2"));
        for bad in [
            "dark",
            "user-",
            "user-Ä",
            "user-a b",
            "USER-a",
            "user-a/../b",
        ] {
            assert!(!id_ok(bad), "{bad}");
        }
        assert!(!id_ok(&format!("user-{}", "a".repeat(MAX_ID_LEN))));
    }

    #[test]
    fn values_that_could_do_harm_are_refused() {
        for ok in [
            "#14171c",
            "rgb(1 2 3 / 50%)",
            "var(--bg-app)",
            "Menlo, 'DejaVu Sans Mono'",
        ] {
            assert!(value_ok(ok), "{ok}");
        }
        let long = "a".repeat(MAX_VALUE_LEN + 1);
        for bad in [
            "",
            "  ",
            "red; background: url(x)",
            "URL(http://x)",
            "#fff}",
            "<script>",
            "a\\b",
            "@import x",
            "red\nblue",
            "image-set(x)",
            "env(x)",
            long.as_str(),
        ] {
            assert!(!value_ok(bad), "{bad:?}");
        }
        assert!(token_name_ok("--bg-app"));
        for bad in ["bg-app", "--", "--Bg", "--a b", "--a;b"] {
            assert!(!token_name_ok(bad), "{bad}");
        }
    }

    #[test]
    fn saves_and_loads_what_was_stored() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("sub").join(FILE_NAME);
        let stored = file(vec![theme("user-a"), theme("user-b")]);
        save(&path, &stored).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.themes, stored.themes);
        assert_eq!(loaded.notice, None);
        // nothing but the file itself is left behind
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(FILE_NAME)]);
    }

    #[test]
    fn a_missing_file_is_no_scheme_and_no_notice() {
        let dir = tempdir().unwrap();
        assert_eq!(
            load(&dir.path().join(FILE_NAME)),
            LoadedThemes {
                themes: vec![],
                notice: None
            }
        );
    }

    #[test]
    fn a_broken_file_is_set_aside() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, b"{ not json").unwrap();
        let loaded = load(&path);
        assert!(loaded.themes.is_empty());
        assert!(loaded.notice.is_some());
        assert!(!path.exists());
        assert!(dir.path().join("themes.json.broken").exists());

        fs::write(&path, br#"{"version": 99, "themes": []}"#).unwrap();
        assert!(load(&path).notice.unwrap().contains("version"));
        assert!(!path.exists());
    }

    #[test]
    fn invalid_entries_are_dropped_on_load() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut hostile = theme("user-x");
        hostile
            .tokens
            .insert("--text".to_string(), "red; x: url(y)".to_string());
        let stored = file(vec![
            theme("user-a"),
            hostile,
            theme("dark"),
            theme("user-a"),
        ]);
        fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.themes, vec![theme("user-a")]);
        assert!(loaded.notice.unwrap().starts_with('3'));
        // the file stays: it is readable, only entries were ignored
        assert!(path.exists());
    }

    #[test]
    fn save_refuses_what_breaks_a_bound() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let many = file(
            (0..=MAX_THEMES)
                .map(|i| theme(&format!("user-{i}")))
                .collect(),
        );
        assert_eq!(
            save(&path, &many).unwrap_err().code,
            ErrorCode::InvalidTheme
        );
        let twice = file(vec![theme("user-a"), theme("user-a")]);
        assert_eq!(
            save(&path, &twice).unwrap_err().code,
            ErrorCode::InvalidTheme
        );
        let mut big = theme("user-a");
        for i in 0..=MAX_TOKENS {
            big.tokens.insert(format!("--t{i}"), "#000000".to_string());
        }
        assert_eq!(
            save(&path, &file(vec![big])).unwrap_err().code,
            ErrorCode::InvalidTheme
        );
        let mut named = theme("user-a");
        named.name = " \t".to_string();
        assert!(save(&path, &file(vec![named])).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn export_and_import_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("Mein Schema – grün.theme.json");
        export(&path, &theme("user-a")).unwrap();
        let value = import(&path).unwrap();
        assert_eq!(value["name"], "Mein Schema – grün");
        assert_eq!(value["tokens"]["--bg-app"], "#001100");
        let back: UserTheme = serde_json::from_value(value).unwrap();
        assert_eq!(back, theme("user-a"));
    }

    #[test]
    fn import_refuses_big_missing_and_foreign_files() {
        let dir = tempdir().unwrap();
        let big = dir.path().join("big.json");
        fs::write(&big, vec![b' '; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert_eq!(import(&big).unwrap_err().code, ErrorCode::TooLarge);
        assert_eq!(
            import(&dir.path().join("gone.json")).unwrap_err().code,
            ErrorCode::NotFound
        );
        let text = dir.path().join("text.json");
        fs::write(&text, b"hello").unwrap();
        assert_eq!(import(&text).unwrap_err().code, ErrorCode::InvalidTheme);
        fs::write(&text, b"[1, 2]").unwrap();
        assert_eq!(import(&text).unwrap_err().code, ErrorCode::InvalidTheme);
    }
}
