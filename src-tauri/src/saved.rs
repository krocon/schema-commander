//! Saved queries (prompt 024): plain `.sql` files in one folder and its subfolders, so they can be shared
//! with Git and edited outside. What the app knows about a query beyond its text stands in a header of
//! comment lines at the top of the file:
//!
//! ```sql
//! -- name: Revenue per month
//! -- description: Paid orders only
//! -- tags: finance, monthly
//! -- connection: 3f2a…        (optional: the profile it belongs to)
//! -- dialect: postgres        (optional)
//!
//! SELECT …
//! ```
//!
//! The header is the first run of `-- key: value` lines with a known key; anything else ends it and is text.
//! A file without a header is a query named like the file. Nothing here is a database: every call reads the
//! folder as it is. Pure (no Tauri), tested below.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::textfile;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// Files listed at most; more are left out and the listing says so.
pub const MAX_ENTRIES: usize = 5000;
/// Folders inside each other at most.
pub const MAX_DEPTH: usize = 8;
/// A file is searched and read as a saved query up to this size.
pub const MAX_QUERY_BYTES: u64 = 4 * 1024 * 1024;
/// The header is looked for in the first bytes of a file.
const HEADER_BYTES: usize = 8 * 1024;
const EXTENSION: &str = "sql";

/// What the header of a file says.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// The id of the connection profile the query belongs to.
    #[serde(default)]
    pub connection: Option<String>,
    /// `postgres`, `mysql`, `sqlserver` or `sqlite`.
    #[serde(default)]
    pub dialect: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// The path below the folder, with `/`: `reports/revenue.sql`. Names the query in every call.
    pub id: String,
    /// The file on disk – to open it as a tab.
    pub path: String,
    /// The folder below the root, `""` = the root itself.
    pub folder: String,
    #[serde(flatten)]
    pub meta: Meta,
    /// Milliseconds since 1970.
    pub modified: u64,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub root: String,
    pub entries: Vec<Entry>,
    /// Every folder below the root, also empty ones.
    pub folders: Vec<String>,
    /// Changes when a file is added, removed, renamed or written: see [`stamp`].
    pub stamp: String,
    /// More files than are listed.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub entry: Entry,
    /// The text without the header.
    pub text: String,
}

/// The folder of the saved queries: the app's own, or one the user chose.
pub struct SavedDir {
    default: PathBuf,
    custom: parking_lot::Mutex<Option<PathBuf>>,
}

impl SavedDir {
    pub fn new(app_data: &Path) -> Self {
        Self {
            default: app_data.join("queries"),
            custom: parking_lot::Mutex::new(None),
        }
    }

    pub fn root(&self) -> PathBuf {
        self.custom
            .lock()
            .clone()
            .unwrap_or_else(|| self.default.clone())
    }

    /// Uses another folder (`None` = the app's own). It must exist and be a folder.
    pub fn set(&self, path: Option<&str>) -> AppResult<()> {
        let custom = match path.map(str::trim).filter(|p| !p.is_empty()) {
            None => None,
            Some(p) => {
                let path = PathBuf::from(p);
                if !path.is_absolute() || !path.is_dir() {
                    return Err(AppError::new(ErrorCode::NotFound, "this is not a folder"));
                }
                Some(path)
            }
        };
        *self.custom.lock() = custom;
        Ok(())
    }
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, message)
}

fn io(e: &std::io::Error) -> AppError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        _ => ErrorCode::Io,
    };
    AppError::new(code, e.to_string())
}

/// The parts of a path below the root: no way up, no drive, no empty or hidden name.
fn parts(rel: &str) -> AppResult<Vec<&str>> {
    if rel.is_empty() {
        return Ok(Vec::new());
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let bad = |p: &&str| {
        p.is_empty()
            || p.starts_with('.')
            || p.len() > 255
            || p.chars()
                .any(|c| c.is_control() || "\\:*?\"<>|".contains(c))
    };
    if parts.len() > MAX_DEPTH + 1 || parts.iter().any(bad) {
        return Err(invalid("this is not a path of a saved query"));
    }
    Ok(parts)
}

fn folder_path(root: &Path, folder: &str) -> AppResult<PathBuf> {
    let parts = parts(folder)?;
    if parts.len() > MAX_DEPTH {
        return Err(invalid("too many folders inside each other"));
    }
    Ok(parts
        .iter()
        .fold(root.to_path_buf(), |p, part| p.join(part)))
}

/// The file an id names. The id is checked, and the file must lie inside the root (no link leads out).
fn file_path(root: &Path, id: &str) -> AppResult<PathBuf> {
    let parts = parts(id)?;
    let is_sql = Path::new(id)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION));
    if parts.is_empty() || !is_sql {
        return Err(invalid("this is not a saved query"));
    }
    let path = parts
        .iter()
        .fold(root.to_path_buf(), |p, part| p.join(part));
    if let (Ok(real_root), Some(Ok(real_parent))) =
        (root.canonicalize(), path.parent().map(Path::canonicalize))
        && !real_parent.starts_with(&real_root)
    {
        return Err(invalid("the file is outside the folder"));
    }
    Ok(path)
}

/// A value of the header: one line, no control characters, not endless.
fn one_line(value: &str, max: usize) -> String {
    let flat: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    flat.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn clean(meta: &Meta) -> Meta {
    let id_like = |v: &Option<String>| {
        v.as_deref()
            .map(str::trim)
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            })
            .map(str::to_owned)
    };
    Meta {
        name: one_line(&meta.name, 120),
        description: one_line(&meta.description, 500),
        tags: meta
            .tags
            .iter()
            .map(|t| one_line(&t.replace(',', " "), 40))
            .filter(|t| !t.is_empty())
            .take(20)
            .collect(),
        connection: id_like(&meta.connection),
        dialect: id_like(&meta.dialect),
    }
}

/// Reads the header of a text: what it says, and where the text of the query starts (a byte offset).
pub fn parse(text: &str) -> (Meta, usize) {
    let mut meta = Meta::default();
    let mut at = 0;
    let mut seen = false;
    for line in text.split_inclusive('\n') {
        let content = line.trim_end_matches(['\n', '\r']);
        let Some((key, value)) = content
            .strip_prefix("--")
            .and_then(|rest| rest.split_once(':'))
        else {
            break;
        };
        let value = value.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "name" => meta.name = value.to_owned(),
            "description" => meta.description = value.to_owned(),
            "tags" => {
                meta.tags = value
                    .split(',')
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned)
                    .collect();
            }
            "connection" => meta.connection = Some(value.to_owned()),
            "dialect" => meta.dialect = Some(value.to_owned()),
            // any other comment is the user's: the text starts here
            _ => break,
        }
        seen = true;
        at += line.len();
    }
    if seen {
        // the one empty line that separates the header from the text
        let rest = &text[at..];
        if let Some(stripped) = rest.strip_prefix("\r\n") {
            at = text.len() - stripped.len();
        } else if let Some(stripped) = rest.strip_prefix('\n') {
            at = text.len() - stripped.len();
        }
    }
    (clean(&meta), at)
}

/// The text of a file: header, an empty line, the query.
pub fn compose(meta: &Meta, body: &str) -> String {
    let meta = clean(meta);
    let eol = if body.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(body.len() + 200);
    let mut line = |key: &str, value: &str| {
        if !value.is_empty() {
            out.push_str("-- ");
            out.push_str(key);
            out.push_str(": ");
            out.push_str(value);
            out.push_str(eol);
        }
    };
    line("name", &meta.name);
    line("description", &meta.description);
    line("tags", &meta.tags.join(", "));
    line("connection", meta.connection.as_deref().unwrap_or(""));
    line("dialect", meta.dialect.as_deref().unwrap_or(""));
    if !out.is_empty() {
        out.push_str(eol);
    }
    out.push_str(body);
    out
}

/// A file name for a query: what the name allows on every system, never empty, never hidden.
pub fn file_stem(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed: String = mapped
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .chars()
        .take(80)
        .collect();
    let trimmed = trimmed.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        "query".to_owned()
    } else {
        trimmed.to_owned()
    }
}

struct Found {
    id: String,
    path: PathBuf,
    modified: u64,
    size: u64,
}

/// Walks the folder: the `.sql` files (sorted by id), the folders, and whether files were left out.
fn walk(root: &Path) -> (Vec<Found>, Vec<String>, bool) {
    let mut files = Vec::new();
    let mut folders = Vec::new();
    let mut truncated = false;
    let mut todo = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, rel, depth)) = todo.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for item in read.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = item.metadata() else { continue };
            let id = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if meta.is_dir() {
                if depth < MAX_DEPTH && parts(&id).is_ok() {
                    folders.push(id.clone());
                    todo.push((item.path(), id, depth + 1));
                }
            } else if meta.is_file()
                && Path::new(&name)
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION))
                && parts(&id).is_ok()
            {
                if files.len() >= MAX_ENTRIES {
                    truncated = true;
                    continue;
                }
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
                files.push(Found {
                    id,
                    path: item.path(),
                    modified,
                    size: meta.len(),
                });
            }
        }
    }
    files.sort_by(|a, b| a.id.cmp(&b.id));
    folders.sort();
    (files, folders, truncated)
}

fn stamp_of(files: &[Found], folders: &[String]) -> String {
    // FNV-1a over what a change touches: names, times, sizes
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for f in files {
        feed(f.id.as_bytes());
        feed(&f.modified.to_le_bytes());
        feed(&f.size.to_le_bytes());
        feed(&[0]);
    }
    for f in folders {
        feed(f.as_bytes());
        feed(&[1]);
    }
    format!("{hash:016x}")
}

/// A fingerprint of the folder that costs no reading of files: the window asks for it now and then and
/// lists again when it differs (changes made outside are seen this way, on every file system).
pub fn stamp(root: &Path) -> String {
    let (files, folders, _) = walk(root);
    stamp_of(&files, &folders)
}

fn head(path: &Path) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; HEADER_BYTES];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    buf.truncate(read);
    textfile::decode(&buf).text
}

fn entry(found: &Found, text: &str) -> Entry {
    let (mut meta, _) = parse(text);
    if meta.name.is_empty() {
        meta.name = Path::new(&found.id)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
    }
    Entry {
        id: found.id.clone(),
        path: found.path.to_string_lossy().into_owned(),
        folder: found
            .id
            .rsplit_once('/')
            .map_or(String::new(), |(folder, _)| folder.to_owned()),
        meta,
        modified: found.modified,
        size: found.size,
    }
}

/// Everything in the folder. A folder that does not exist yet is an empty one.
pub fn list(root: &Path) -> Listing {
    let (files, folders, truncated) = walk(root);
    let stamp = stamp_of(&files, &folders);
    let entries = files.iter().map(|f| entry(f, &head(&f.path))).collect();
    Listing {
        root: root.to_string_lossy().into_owned(),
        entries,
        folders,
        stamp,
        truncated,
    }
}

fn found(root: &Path, id: &str) -> AppResult<Found> {
    let path = file_path(root, id)?;
    let meta = std::fs::metadata(&path).map_err(|e| io(&e))?;
    if !meta.is_file() {
        return Err(AppError::new(ErrorCode::NotFound, "no such query"));
    }
    if meta.len() > MAX_QUERY_BYTES {
        return Err(AppError::new(ErrorCode::TooLarge, "the file is too large"));
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    Ok(Found {
        id: id.to_owned(),
        path,
        modified,
        size: meta.len(),
    })
}

pub fn read(root: &Path, id: &str) -> AppResult<Saved> {
    let found = found(root, id)?;
    let file = textfile::read(&found.path)?;
    let (_, at) = parse(&file.text);
    Ok(Saved {
        entry: entry(&found, &file.text),
        text: file.text[at..].to_owned(),
    })
}

/// A free file name in a folder for a query name: `Name.sql`, `Name 2.sql` …
fn free_path(dir: &Path, name: &str, keep: Option<&Path>) -> PathBuf {
    let stem = file_stem(name);
    let mut n = 1;
    loop {
        let file = if n == 1 {
            format!("{stem}.{EXTENSION}")
        } else {
            format!("{stem} {n}.{EXTENSION}")
        };
        let path = dir.join(file);
        if !path.exists() || keep == Some(path.as_path()) {
            return path;
        }
        n += 1;
    }
}

fn id_of(root: &Path, path: &Path) -> AppResult<String> {
    let rel = path
        .strip_prefix(root)
        .map_err(|_| invalid("outside the folder"))?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(p) => Some(p.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    Ok(parts.join("/"))
}

/// Writes a query: a new file in `folder` (`id` = `None`), or the file of `id` – which keeps its place and
/// its encoding. Answers with the id.
pub fn save(
    root: &Path,
    id: Option<&str>,
    folder: &str,
    meta: &Meta,
    body: &str,
) -> AppResult<String> {
    let meta = clean(meta);
    if meta.name.is_empty() {
        return Err(invalid("a saved query needs a name"));
    }
    if body.len() as u64 > MAX_QUERY_BYTES {
        return Err(AppError::new(ErrorCode::TooLarge, "the query is too large"));
    }
    let (path, encoding) = match id {
        Some(id) => {
            let path = file_path(root, id)?;
            let encoding =
                textfile::read(&path).map_or_else(|_| textfile::UTF8.to_owned(), |f| f.encoding);
            (path, encoding)
        }
        None => {
            let dir = folder_path(root, folder)?;
            std::fs::create_dir_all(&dir).map_err(|e| io(&e))?;
            (free_path(&dir, &meta.name, None), textfile::UTF8.to_owned())
        }
    };
    let text = compose(&meta, body);
    // a text the old encoding cannot hold is written as UTF-8 rather than not at all
    if textfile::write(&path, &text, &encoding).is_err() {
        textfile::write(&path, &text, textfile::UTF8)?;
    }
    id_of(root, &path)
}

/// Renames a query and/or moves it into another folder. The file is named after the query.
pub fn rename(root: &Path, id: &str, folder: &str, name: &str) -> AppResult<String> {
    let from = file_path(root, id)?;
    let saved = read(root, id)?;
    let meta = clean(&Meta {
        name: name.to_owned(),
        ..saved.entry.meta
    });
    if meta.name.is_empty() {
        return Err(invalid("a saved query needs a name"));
    }
    let dir = folder_path(root, folder)?;
    std::fs::create_dir_all(&dir).map_err(|e| io(&e))?;
    let to = free_path(&dir, &meta.name, Some(&from));
    // first the content under its new name in the old file, then the move: never two copies
    let encoding = textfile::read(&from)?.encoding;
    let text = compose(&meta, &saved.text);
    if textfile::write(&from, &text, &encoding).is_err() {
        textfile::write(&from, &text, textfile::UTF8)?;
    }
    if to != from {
        std::fs::rename(&from, &to).map_err(|e| io(&e))?;
    }
    id_of(root, &to)
}

pub fn create_folder(root: &Path, folder: &str) -> AppResult<()> {
    let dir = folder_path(root, folder)?;
    if dir == root {
        return Err(invalid("a folder needs a name"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| io(&e))
}

/// The file an id names, checked – for the trash of the system (the command layer moves it there).
pub fn path_for_delete(root: &Path, id: &str) -> AppResult<PathBuf> {
    Ok(found(root, id)?.path)
}

/// The ids of the queries in which every word of `query` occurs: in the name, the description, the tags,
/// the folder or the text. Case does not matter.
pub fn search(root: &Path, query: &str) -> Vec<String> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let (files, _, _) = walk(root);
    files
        .iter()
        .filter(|f| f.size <= MAX_QUERY_BYTES)
        .filter(|f| {
            let Ok(file) = textfile::read(&f.path) else {
                return false;
            };
            let hay = format!("{}\n{}", f.id, file.text).to_lowercase();
            words.iter().all(|w| hay.contains(w))
        })
        .map(|f| f.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn meta(name: &str) -> Meta {
        Meta {
            name: name.into(),
            ..Meta::default()
        }
    }

    #[test]
    fn reads_and_writes_the_header() {
        let m = Meta {
            name: "Umsatz je Monat 😀".into(),
            description: "nur bezahlte".into(),
            tags: vec!["finanzen".into(), "monat".into()],
            connection: Some("3f2a-1".into()),
            dialect: Some("postgres".into()),
        };
        let text = compose(&m, "SELECT 1;\n");
        assert_eq!(
            text,
            "-- name: Umsatz je Monat 😀\n-- description: nur bezahlte\n-- tags: finanzen, monat\n-- connection: 3f2a-1\n-- dialect: postgres\n\nSELECT 1;\n"
        );
        let (read, at) = parse(&text);
        assert_eq!(read, m);
        assert_eq!(&text[at..], "SELECT 1;\n");
        // line ends follow the text
        let crlf = compose(&meta("a"), "SELECT 1;\r\nSELECT 2;\r\n");
        assert!(crlf.starts_with("-- name: a\r\n\r\nSELECT 1;\r\n"));
        assert_eq!(&crlf[parse(&crlf).1..], "SELECT 1;\r\nSELECT 2;\r\n");
    }

    #[test]
    fn a_header_edited_by_hand_is_read_forgivingly() {
        // other case, blanks, an unknown comment ends the header and stays text
        let text = "--Name:  Kunden   \n--  TAGS: a,, b ,\n-- todo: später\nSELECT 1";
        let (m, at) = parse(text);
        assert_eq!(m.name, "Kunden");
        assert_eq!(m.tags, vec!["a", "b"]);
        assert_eq!(&text[at..], "-- todo: später\nSELECT 1");
        // no header at all: everything is text
        assert_eq!(parse("SELECT 1 -- name: x").1, 0);
        assert_eq!(parse("-- just a comment\nSELECT 1").1, 0);
        assert_eq!(parse("").1, 0);
        // values that are no ids are dropped, long ones cut
        let (m, _) = parse(&format!(
            "-- connection: ../../etc\n-- name: {}\n",
            "x".repeat(500)
        ));
        assert_eq!(m.connection, None);
        assert_eq!(m.name.chars().count(), 120);
        // only the one separating line belongs to the header
        let text = "-- name: a\n\n\nSELECT 1";
        assert_eq!(&text[parse(text).1..], "\nSELECT 1");
    }

    #[test]
    fn a_name_becomes_a_file_name_every_system_takes() {
        assert_eq!(file_stem("Umsatz: 2026/Q1?"), "Umsatz- 2026-Q1-");
        assert_eq!(file_stem("  .versteckt. "), "versteckt");
        assert_eq!(file_stem("..."), "query");
        assert_eq!(file_stem("Größe 😀"), "Größe 😀");
        assert_eq!(file_stem(&"x".repeat(300)).chars().count(), 80);
    }

    #[test]
    fn saves_lists_reads_and_finds_queries() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        assert!(list(root).entries.is_empty());
        let a = save(
            root,
            None,
            "",
            &meta("Kunden in Köln"),
            "SELECT * FROM kunden WHERE ort = 'Köln';",
        )
        .unwrap();
        let b = save(
            root,
            None,
            "berichte/monat",
            &Meta {
                tags: vec!["finanzen".into()],
                ..meta("Umsatz 😀")
            },
            "SELECT sum(total) FROM orders;",
        )
        .unwrap();
        assert_eq!(a, "Kunden in Köln.sql");
        assert_eq!(b, "berichte/monat/Umsatz 😀.sql");
        // the same name again gets a number
        assert_eq!(
            save(root, None, "", &meta("Kunden in Köln"), "x").unwrap(),
            "Kunden in Köln 2.sql"
        );
        let listing = list(root);
        assert_eq!(listing.folders, vec!["berichte", "berichte/monat"]);
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "Kunden in Köln 2.sql",
                "Kunden in Köln.sql",
                "berichte/monat/Umsatz 😀.sql"
            ]
        );
        assert_eq!(listing.entries[2].folder, "berichte/monat");
        assert_eq!(listing.entries[2].meta.tags, vec!["finanzen"]);
        let read = read(root, &b).unwrap();
        assert_eq!(read.text, "SELECT sum(total) FROM orders;");
        assert_eq!(read.entry.meta.name, "Umsatz 😀");
        // every word must occur: name, tag, folder or text
        assert_eq!(search(root, "köln KUNDEN ort"), vec!["Kunden in Köln.sql"]);
        assert_eq!(search(root, "finanzen orders"), vec![b.clone()]);
        assert_eq!(search(root, "monat"), vec![b.clone()]);
        assert!(search(root, "gibt es nicht").is_empty());
        assert!(search(root, "  ").is_empty());
        // writing again keeps the file
        assert_eq!(
            save(root, Some(&b), "", &meta("Umsatz 😀"), "SELECT 2;").unwrap(),
            b
        );
        assert_eq!(super::read(root, &b).unwrap().text, "SELECT 2;");
    }

    #[test]
    fn sees_what_happens_outside() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let empty = stamp(root);
        std::fs::write(root.join("von-hand.sql"), "SELECT 1").unwrap();
        std::fs::write(root.join("notiz.txt"), "kein SQL").unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/x.sql"), "x").unwrap();
        let one = stamp(root);
        assert_ne!(empty, one);
        let listing = list(root);
        assert_eq!(listing.stamp, one);
        // a file without a header is named like the file; other files and hidden folders are not listed
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].meta.name, "von-hand");
        std::fs::write(
            root.join("von-hand.sql"),
            "-- name: Jetzt mit Namen\n\nSELECT 22",
        )
        .unwrap();
        assert_ne!(stamp(root), one);
        assert_eq!(list(root).entries[0].meta.name, "Jetzt mit Namen");
        std::fs::remove_file(root.join("von-hand.sql")).unwrap();
        assert_eq!(stamp(root), stamp_of(&[], &[]));
        // a file in another encoding is read
        std::fs::write(
            root.join("alt.sql"),
            b"-- name: Gr\xf6\xdfe\n\nSELECT '\xe4'",
        )
        .unwrap();
        let old = read(root, "alt.sql").unwrap();
        assert_eq!(old.entry.meta.name, "Größe");
        assert_eq!(old.text, "SELECT 'ä'");
    }

    #[test]
    fn renames_and_moves_a_query() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let id = save(root, None, "", &meta("Alt"), "SELECT 1;").unwrap();
        let moved = rename(root, &id, "archiv", "Neu").unwrap();
        assert_eq!(moved, "archiv/Neu.sql");
        assert!(!root.join("Alt.sql").exists());
        let read = read(root, &moved).unwrap();
        assert_eq!(
            (read.entry.meta.name.as_str(), read.text.as_str()),
            ("Neu", "SELECT 1;")
        );
        // the same name in the same folder: nothing moves, no number is added
        assert_eq!(rename(root, &moved, "archiv", "Neu").unwrap(), moved);
        // a taken name gets a number
        save(root, None, "archiv", &meta("Besetzt"), "x").unwrap();
        assert_eq!(
            rename(root, &moved, "archiv", "Besetzt").unwrap(),
            "archiv/Besetzt 2.sql"
        );
        create_folder(root, "leer/tief").unwrap();
        assert!(list(root).folders.contains(&"leer/tief".to_owned()));
    }

    #[test]
    fn refuses_paths_that_lead_out_of_the_folder() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("queries");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("geheim.sql"), "x").unwrap();
        for id in [
            "../geheim.sql",
            "/etc/passwd.sql",
            "a/../../geheim.sql",
            "a\\b.sql",
            ".hidden.sql",
            "a//b.sql",
            "kein-sql.txt",
            "",
            "C:x.sql",
        ] {
            assert!(read(&root, id).is_err(), "{id}");
            assert!(save(&root, Some(id), "", &meta("x"), "x").is_err(), "{id}");
            assert!(path_for_delete(&root, id).is_err(), "{id}");
        }
        for folder in ["..", "a/../..", "/tmp", ".git"] {
            assert!(
                save(&root, None, folder, &meta("x"), "x").is_err(),
                "{folder}"
            );
            assert!(create_folder(&root, folder).is_err(), "{folder}");
        }
        assert!(save(&root, None, "", &meta("  "), "x").is_err());
        #[cfg(unix)]
        {
            // a link inside the folder that points outside is no way out
            std::os::unix::fs::symlink(dir.path(), root.join("raus")).unwrap();
            assert!(read(&root, "raus/geheim.sql").is_err());
        }
    }

    #[test]
    fn the_folder_can_be_another_one() {
        let dir = tempdir().unwrap();
        let saved = SavedDir::new(dir.path());
        assert_eq!(saved.root(), dir.path().join("queries"));
        let other = dir.path().join("team");
        assert!(saved.set(Some(&other.to_string_lossy())).is_err());
        std::fs::create_dir(&other).unwrap();
        saved.set(Some(&other.to_string_lossy())).unwrap();
        assert_eq!(saved.root(), other);
        assert!(saved.set(Some("relativ/pfad")).is_err());
        saved.set(None).unwrap();
        assert_eq!(saved.root(), dir.path().join("queries"));
    }
}
