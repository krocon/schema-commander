//! The open query tabs over a restart (prompt 004): `session.json` (which tabs, in which order, with which
//! connection) and one text file per tab in `tabs/`, both in the app's data folder. Texts are written often
//! and atomically, so a crash loses at most the last moments of typing. Pure (no Tauri), tested below.

use crate::error::{AppError, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "session.json";
pub const TABS_DIR: &str = "tabs";
pub const VERSION: u32 = 1;
pub const MAX_TABS: usize = 200;
/// A tab's text at most (bytes).
pub const MAX_TEXT_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 4 * 1024 * 1024;

/// What is remembered of a tab – never its text (a file of its own) and never a result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabMeta {
    /// `[a-z0-9-]`, also the name of the text file.
    pub id: String,
    pub title: String,
    /// The user named the tab: the title no longer follows its text.
    #[serde(default)]
    pub custom_title: bool,
    /// The profile statements run on; `None` = an editor without a connection.
    #[serde(default)]
    pub connection: Option<String>,
    /// The `.sql` file the tab was opened from or saved to.
    #[serde(default)]
    pub file_path: Option<String>,
    /// The encoding of that file (see [`crate::textfile`]).
    #[serde(default)]
    pub encoding: Option<String>,
    /// The tab group it is in when the view is split: 0 or 1 (prompt 016).
    #[serde(default)]
    pub group: u8,
    /// Where the caret was: line and column, both from 1; 0 = unknown.
    #[serde(default)]
    pub caret_line: u32,
    #[serde(default)]
    pub caret_ch: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub tabs: Vec<TabMeta>,
    /// The id of the tab in front.
    #[serde(default)]
    pub active: Option<String>,
    /// The tab shown in the other group of a split view.
    #[serde(default)]
    pub other: Option<String>,
    /// How a split view lies: `row` (side by side) or `column`.
    #[serde(default)]
    pub split: String,
}

/// What `load` found; `notice` says when the file was broken.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSession {
    pub session: SessionFile,
    pub notice: Option<String>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidSession, message)
}

fn io_error(e: &std::io::Error) -> AppError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        _ => ErrorCode::Io,
    };
    AppError::new(code, e.to_string())
}

/// A tab id: also a file name, so nothing but `[a-z0-9-]`.
pub fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn meta_ok(t: &TabMeta) -> bool {
    let plain = |s: &str, max: usize| s.chars().count() <= max && !s.chars().any(char::is_control);
    id_ok(&t.id)
        && plain(&t.title, 200)
        && t.connection.as_deref().is_none_or(|c| plain(c, 64))
        && t.file_path.as_deref().is_none_or(|p| plain(p, 4096))
        && t.encoding.as_deref().is_none_or(|e| plain(e, 32))
        && t.group <= 1
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
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

/// The session folder: `session.json` and `tabs/` live in it.
pub struct SessionDir {
    dir: PathBuf,
}

impl SessionDir {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn text_path(&self, id: &str) -> AppResult<PathBuf> {
        if !id_ok(id) {
            return Err(invalid("not a tab id"));
        }
        Ok(self.dir.join(TABS_DIR).join(format!("{id}.sql")))
    }

    /// The stored session, forgiving: no file = empty; a broken file is set aside; entries that break a
    /// rule are dropped. Never fails.
    pub fn load(&self) -> LoadedSession {
        let path = self.file();
        let empty = |notice: Option<String>| LoadedSession {
            session: SessionFile {
                version: VERSION,
                ..SessionFile::default()
            },
            notice,
        };
        let mut bytes = Vec::new();
        match fs::File::open(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return empty(None),
            Err(e) => return empty(Some(format!("the session could not be read: {e}"))),
            Ok(file) => {
                if let Err(e) = file.take(MAX_SESSION_BYTES + 1).read_to_end(&mut bytes) {
                    return empty(Some(format!("the session could not be read: {e}")));
                }
            }
        }
        let parsed = serde_json::from_slice::<SessionFile>(&bytes)
            .ok()
            .filter(|s| s.version == VERSION && bytes.len() as u64 <= MAX_SESSION_BYTES);
        let Some(mut session) = parsed else {
            let mut aside = path.as_os_str().to_owned();
            aside.push(".broken");
            let _ = fs::rename(&path, PathBuf::from(aside));
            return empty(Some(
                "the file of the session was broken and has been set aside".to_string(),
            ));
        };
        let mut seen = std::collections::BTreeSet::new();
        session
            .tabs
            .retain(|t| meta_ok(t) && seen.insert(t.id.clone()));
        session.tabs.truncate(MAX_TABS);
        if !session
            .active
            .as_ref()
            .is_some_and(|a| session.tabs.iter().any(|t| &t.id == a))
        {
            session.active = session.tabs.first().map(|t| t.id.clone());
        }
        // the split layout, forgiving: a group that is not there, a tab that is gone, an unknown word
        if !matches!(session.split.as_str(), "row" | "column") {
            session.split = "row".to_string();
        }
        if !session
            .other
            .as_ref()
            .is_some_and(|o| session.tabs.iter().any(|t| &t.id == o))
        {
            session.other = None;
        }
        LoadedSession {
            session,
            notice: None,
        }
    }

    pub fn save(&self, session: &SessionFile) -> AppResult<()> {
        if session.tabs.len() > MAX_TABS {
            return Err(invalid("too many tabs"));
        }
        let mut seen = std::collections::BTreeSet::new();
        for t in &session.tabs {
            if !meta_ok(t) || !seen.insert(t.id.as_str()) {
                return Err(invalid("a tab is not valid"));
            }
        }
        let file = SessionFile {
            version: VERSION,
            ..session.clone()
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| invalid(e.to_string()))?;
        write_atomic(&self.file(), &bytes).map_err(|e| io_error(&e))
    }

    /// The text of a tab; a tab without a file yet is empty.
    pub fn load_text(&self, id: &str) -> AppResult<String> {
        let path = self.text_path(id)?;
        match fs::read(&path) {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(io_error(&e)),
        }
    }

    pub fn save_text(&self, id: &str, text: &str) -> AppResult<()> {
        if text.len() as u64 > MAX_TEXT_BYTES {
            return Err(AppError::new(ErrorCode::TooLarge, "the text is too large"));
        }
        write_atomic(&self.text_path(id)?, text.as_bytes()).map_err(|e| io_error(&e))
    }

    pub fn delete_text(&self, id: &str) -> AppResult<()> {
        match fs::remove_file(self.text_path(id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error(&e)),
        }
    }

    /// Removes text files no tab of `keep` owns (closed tabs, leftovers of a crash, temporary files) and
    /// returns how many went.
    pub fn sweep(&self, keep: &[&str]) -> usize {
        let Ok(entries) = fs::read_dir(self.dir.join(TABS_DIR)) else {
            return 0;
        };
        let mut gone = 0;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let owned = name
                .strip_suffix(".sql")
                .is_some_and(|id| keep.contains(&id));
            if !owned
                && entry.file_type().is_ok_and(|t| t.is_file())
                && fs::remove_file(entry.path()).is_ok()
            {
                gone += 1;
            }
        }
        gone
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn tab(id: &str) -> TabMeta {
        TabMeta {
            id: id.into(),
            title: "Kunden – Übersicht".into(),
            custom_title: true,
            connection: Some("shop".into()),
            file_path: Some("/tmp/Meine Abfragen/ä.sql".into()),
            encoding: Some("utf-8".into()),
            group: 0,
            caret_line: 0,
            caret_ch: 0,
        }
    }

    #[test]
    fn keeps_groups_carets_and_the_split_and_repairs_what_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        let s = SessionDir::new(dir.path().to_path_buf());
        let mut a = tab("a");
        a.caret_line = 12;
        a.caret_ch = 4;
        let mut b = tab("b");
        b.group = 1;
        s.save(&SessionFile {
            version: VERSION,
            tabs: vec![a, b],
            active: Some("a".into()),
            other: Some("b".into()),
            split: "column".into(),
        })
        .unwrap();
        let loaded = s.load().session;
        assert_eq!(
            (loaded.tabs[0].caret_line, loaded.tabs[0].caret_ch),
            (12, 4)
        );
        assert_eq!(loaded.tabs[1].group, 1);
        assert_eq!(
            (loaded.other.as_deref(), loaded.split.as_str()),
            (Some("b"), "column")
        );
        // a file from before prompt 016, and one that names what is not there
        std::fs::write(
            dir.path().join(FILE_NAME),
            r#"{"version":1,"tabs":[{"id":"a","title":"A"},{"id":"x","title":"X","group":7}],
               "active":"a","other":"gone","split":"diagonal"}"#,
        )
        .unwrap();
        let loaded = s.load().session;
        assert_eq!(
            loaded.tabs.len(),
            1,
            "a group that does not exist drops the tab"
        );
        assert_eq!(loaded.tabs[0].group, 0);
        assert_eq!((loaded.other, loaded.split.as_str()), (None, "row"));
    }

    #[test]
    fn stores_and_restores_tabs_in_order() {
        let dir = tempdir().unwrap();
        let s = SessionDir::new(dir.path().join("deep").join("data"));
        let session = SessionFile {
            version: VERSION,
            tabs: vec![tab("b"), tab("a")],
            active: Some("a".into()),
            other: None,
            split: "row".to_string(),
        };
        s.save(&session).unwrap();
        let loaded = s.load();
        assert_eq!(loaded.session, session);
        assert_eq!(loaded.notice, None);
    }

    #[test]
    fn an_empty_start_and_a_broken_file() {
        let dir = tempdir().unwrap();
        let s = SessionDir::new(dir.path().to_path_buf());
        assert!(s.load().session.tabs.is_empty());
        fs::write(dir.path().join(FILE_NAME), b"{ nope").unwrap();
        let loaded = s.load();
        assert!(loaded.notice.is_some());
        assert!(loaded.session.tabs.is_empty());
        assert!(dir.path().join("session.json.broken").exists());
    }

    #[test]
    fn drops_invalid_tabs_and_repairs_the_active_one() {
        let dir = tempdir().unwrap();
        let s = SessionDir::new(dir.path().to_path_buf());
        let mut hostile = tab("x");
        hostile.id = "../../etc/passwd".into();
        let file = SessionFile {
            version: VERSION,
            tabs: vec![tab("a"), hostile.clone(), tab("a"), tab("b")],
            active: Some("gone".into()),
            other: None,
            split: "row".to_string(),
        };
        fs::write(
            dir.path().join(FILE_NAME),
            serde_json::to_vec(&file).unwrap(),
        )
        .unwrap();
        let loaded = s.load().session;
        assert_eq!(
            loaded
                .tabs
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(loaded.active.as_deref(), Some("a"));
        assert_eq!(
            s.save(&SessionFile {
                version: VERSION,
                tabs: vec![hostile],
                active: None,
                other: None,
                split: "row".to_string(),
            })
            .unwrap_err()
            .code,
            ErrorCode::InvalidSession
        );
    }

    #[test]
    fn texts_live_in_files_of_their_own() {
        let dir = tempdir().unwrap();
        let s = SessionDir::new(dir.path().to_path_buf());
        assert_eq!(s.load_text("a").unwrap(), "");
        let text = "SELECT 'Grüße 🚀';\r\n-- 小林\n";
        s.save_text("a", text).unwrap();
        assert_eq!(s.load_text("a").unwrap(), text);
        s.save_text("a", "kürzer").unwrap();
        assert_eq!(s.load_text("a").unwrap(), "kürzer");
        // only the text file is there, no temporary one
        let names: Vec<_> = fs::read_dir(dir.path().join(TABS_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["a.sql"]);
        s.delete_text("a").unwrap();
        s.delete_text("a").unwrap();
        assert_eq!(s.load_text("a").unwrap(), "");
    }

    #[test]
    fn a_tab_id_never_leaves_the_folder() {
        let dir = tempdir().unwrap();
        let s = SessionDir::new(dir.path().join("data"));
        for bad in ["", "../x", "a/b", "A", "a b", "a.sql", "é"] {
            assert_eq!(
                s.save_text(bad, "x").unwrap_err().code,
                ErrorCode::InvalidSession,
                "{bad}"
            );
            assert!(s.load_text(bad).is_err(), "{bad}");
            assert!(s.delete_text(bad).is_err(), "{bad}");
        }
        assert!(!dir.path().join("x").exists());
    }

    #[test]
    fn sweeps_what_no_tab_owns() {
        let dir = tempdir().unwrap();
        let s = SessionDir::new(dir.path().to_path_buf());
        for id in ["a", "b", "c"] {
            s.save_text(id, id).unwrap();
        }
        fs::write(dir.path().join(TABS_DIR).join("b.sql.tmp-123"), b"half").unwrap();
        assert_eq!(s.sweep(&["a", "c"]), 2);
        assert_eq!(s.load_text("a").unwrap(), "a");
        assert_eq!(s.load_text("b").unwrap(), "");
        assert_eq!(s.sweep(&["a", "c"]), 0);
    }
}
