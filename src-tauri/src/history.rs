//! The history of statements (prompt 010): what ran when, where, how long and how it ended – in a SQLite
//! file of its own in the data folder of the app. The **only** place where statement texts are kept for
//! good; never a result, never a parameter value. Pure of Tauri.

use crate::error::{AppError, AppResult, ErrorCode};
use parking_lot::Mutex;
use rusqlite::{Connection, params, params_from_iter};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "history.sqlite";
/// Characters of a statement that are kept; a longer one is cut (its hash still tells it apart).
pub const MAX_SQL_CHARS: usize = 100_000;
/// Characters of a statement in a list.
pub const PREVIEW_CHARS: usize = 300;
/// Entries a list returns at most.
pub const MAX_LIST: u32 = 1_000;

/// A statement that ran, as the frontend reports it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEntry {
    /// Milliseconds since the epoch.
    pub at: i64,
    pub connection_id: String,
    /// The name of the connection when it ran (the profile may be renamed or gone later).
    pub connection_name: String,
    #[serde(default)]
    pub database: String,
    pub sql: String,
    pub elapsed_ms: i64,
    /// Rows read or changed; `None` when the statement did not say.
    pub rows: Option<i64>,
    /// `ok`, `failed` or `cancelled`.
    pub outcome: String,
    pub message: Option<String>,
    #[serde(default)]
    pub tab: String,
    /// `user`, or `app` for statements the app wrote itself (open a table …).
    #[serde(default = "user")]
    pub origin: String,
}

fn user() -> String {
    "user".to_string()
}

/// How much is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keep {
    pub max_entries: u32,
    /// 0 = any age.
    pub max_days: u32,
}

impl Default for Keep {
    fn default() -> Self {
        Self {
            max_entries: 100_000,
            max_days: 365,
        }
    }
}

/// An entry in a list: everything but the whole text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub at: i64,
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    /// The start of the statement.
    pub preview: String,
    /// Characters of the statement as it ran (more than are kept when it was cut).
    pub length: i64,
    pub elapsed_ms: i64,
    pub rows: Option<i64>,
    pub outcome: String,
    pub message: Option<String>,
    pub tab: String,
    pub origin: String,
    /// How often it ran in a row.
    pub count: i64,
}

/// What to list. Everything is optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    /// Words that must all be in the statement (any case).
    pub text: String,
    pub connection_id: Option<String>,
    pub failed_only: bool,
    /// Leave out what the app wrote itself.
    pub user_only: bool,
    /// Milliseconds since the epoch, both included.
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: Option<u32>,
    pub offset: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub entries: Vec<Entry>,
    /// Entries that match in all.
    pub total: i64,
}

/// What to delete.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "id")]
pub enum Scope {
    All,
    Connection(String),
    Entry(i64),
}

pub struct History {
    file: PathBuf,
    conn: Mutex<Option<Connection>>,
    /// Said once after a broken file was set aside.
    notice: Mutex<Option<String>>,
    added: Mutex<u32>,
}

fn db(e: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("history: {e}"))
}

/// FNV-1a, 64 bit: the same text has the same hash in every version of the app.
pub fn hash(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn cut(text: &str, chars: usize) -> &str {
    match text.char_indices().nth(chars) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

const SCHEMA: &str = "
PRAGMA secure_delete = ON;
CREATE TABLE IF NOT EXISTS entry (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  connection_name TEXT NOT NULL,
  database TEXT NOT NULL,
  sql TEXT NOT NULL,
  hash TEXT NOT NULL,
  length INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  rows INTEGER,
  outcome TEXT NOT NULL,
  message TEXT,
  tab TEXT NOT NULL,
  origin TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS entry_at ON entry (at);
CREATE INDEX IF NOT EXISTS entry_connection ON entry (connection_id, at);
";

const COLUMNS: &str = "id, at, connection_id, connection_name, database, substr(sql, 1, 300), length, \
    elapsed_ms, rows, outcome, message, tab, origin, count";

fn entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get(0)?,
        at: row.get(1)?,
        connection_id: row.get(2)?,
        connection_name: row.get(3)?,
        database: row.get(4)?,
        preview: row.get(5)?,
        length: row.get(6)?,
        elapsed_ms: row.get(7)?,
        rows: row.get(8)?,
        outcome: row.get(9)?,
        message: row.get(10)?,
        tab: row.get(11)?,
        origin: row.get(12)?,
        count: row.get(13)?,
    })
}

impl History {
    /// `dir`: the data folder of the app. Nothing is opened before the first use.
    pub fn new(dir: PathBuf) -> Self {
        Self {
            file: dir.join(FILE_NAME),
            conn: Mutex::new(None),
            notice: Mutex::new(None),
            added: Mutex::new(0),
        }
    }

    fn open(file: &Path) -> rusqlite::Result<Connection> {
        let conn = Connection::open(file)?;
        conn.execute_batch(SCHEMA)?;
        // a file that is no history of ours fails here
        conn.query_row("SELECT count(*) FROM entry", [], |r| r.get::<_, i64>(0))?;
        Ok(conn)
    }

    /// Runs `f` on the database; a broken file is set aside and a new one started.
    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> AppResult<T> {
        let mut guard = self.conn.lock();
        if guard.is_none() {
            if let Some(dir) = self.file.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| AppError::new(ErrorCode::Io, format!("history: {e}")))?;
            }
            let conn = match Self::open(&self.file) {
                Ok(conn) => conn,
                Err(_) => {
                    let aside = self.file.with_extension(format!(
                        "broken-{}",
                        chrono::Utc::now().format("%Y%m%d-%H%M%S")
                    ));
                    let _ = std::fs::rename(&self.file, &aside);
                    *self.notice.lock() = Some(format!(
                        "Der Verlauf war nicht lesbar und wurde beiseitegelegt ({}).",
                        aside.file_name().unwrap_or_default().to_string_lossy()
                    ));
                    Self::open(&self.file).map_err(db)?
                }
            };
            *guard = Some(conn);
        }
        let conn = guard
            .as_mut()
            .ok_or_else(|| AppError::new(ErrorCode::Io, "history"))?;
        f(conn).map_err(db)
    }

    /// What happened to a broken file, said once.
    pub fn take_notice(&self) -> Option<String> {
        self.notice.lock().take()
    }

    /// Notes a statement. The same statement on the same connection with the same outcome right after
    /// itself counts up instead of being a new entry. Returns the id of the entry.
    pub fn add(&self, new: &NewEntry, keep: Keep) -> AppResult<i64> {
        let text = new.sql.trim();
        if text.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
        }
        let length = text.chars().count() as i64;
        let stored = cut(text, MAX_SQL_CHARS);
        let digest = hash(text);
        let message = new.message.as_deref().map(|m| cut(m, 2_000).to_string());
        let id = self.with(|conn| {
            let last: Option<(i64, String, String)> = conn
                .query_row(
                    "SELECT id, hash, outcome FROM entry WHERE connection_id = ?1 \
                     ORDER BY id DESC LIMIT 1",
                    [&new.connection_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok();
            if let Some((id, h, outcome)) = last
                && h == digest
                && outcome == new.outcome
            {
                conn.execute(
                    "UPDATE entry SET count = count + 1, at = ?2, elapsed_ms = ?3, rows = ?4, \
                     message = ?5, tab = ?6, connection_name = ?7, database = ?8 WHERE id = ?1",
                    params![
                        id,
                        new.at,
                        new.elapsed_ms,
                        new.rows,
                        message,
                        new.tab,
                        new.connection_name,
                        new.database
                    ],
                )?;
                return Ok(id);
            }
            conn.execute(
                "INSERT INTO entry (at, connection_id, connection_name, database, sql, hash, length, \
                 elapsed_ms, rows, outcome, message, tab, origin) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    new.at,
                    new.connection_id,
                    new.connection_name,
                    new.database,
                    stored,
                    digest,
                    length,
                    new.elapsed_ms,
                    new.rows,
                    new.outcome,
                    message,
                    new.tab,
                    new.origin
                ],
            )?;
            Ok(conn.last_insert_rowid())
        })?;
        // looking for what is too old or too much costs a scan: not with every statement
        let due = {
            let mut added = self.added.lock();
            *added += 1;
            *added % 200 == 1
        };
        if due {
            self.prune(keep, new.at)?;
        }
        Ok(id)
    }

    /// Removes what is older than `keep.max_days` (counted from `now`, ms) and the oldest beyond
    /// `keep.max_entries`. Returns how many went.
    pub fn prune(&self, keep: Keep, now: i64) -> AppResult<usize> {
        self.with(|conn| {
            let mut gone = 0;
            if keep.max_days > 0 {
                let oldest = now - i64::from(keep.max_days) * 86_400_000;
                gone += conn.execute("DELETE FROM entry WHERE at < ?1", [oldest])?;
            }
            gone += conn.execute(
                "DELETE FROM entry WHERE id IN \
                 (SELECT id FROM entry ORDER BY id DESC LIMIT -1 OFFSET ?1)",
                [keep.max_entries.max(1)],
            )?;
            Ok(gone)
        })
    }

    /// The entries that match, the latest first.
    pub fn list(&self, filter: &Filter) -> AppResult<Page> {
        let mut wheres: Vec<String> = Vec::new();
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        for word in filter.text.split_whitespace().take(8) {
            let mut pattern = String::from("%");
            for c in word.chars() {
                if matches!(c, '%' | '_' | '\\') {
                    pattern.push('\\');
                }
                pattern.push(c);
            }
            pattern.push('%');
            values.push(pattern.into());
            wheres.push(format!("sql LIKE ?{} ESCAPE '\\'", values.len()));
        }
        if let Some(id) = &filter.connection_id {
            values.push(id.clone().into());
            wheres.push(format!("connection_id = ?{}", values.len()));
        }
        if filter.failed_only {
            wheres.push("outcome = 'failed'".to_string());
        }
        if filter.user_only {
            wheres.push("origin = 'user'".to_string());
        }
        if let Some(from) = filter.from {
            values.push(from.into());
            wheres.push(format!("at >= ?{}", values.len()));
        }
        if let Some(to) = filter.to {
            values.push(to.into());
            wheres.push(format!("at <= ?{}", values.len()));
        }
        let condition = if wheres.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", wheres.join(" AND "))
        };
        let limit = filter.limit.unwrap_or(200).clamp(1, MAX_LIST);
        self.with(|conn| {
            let total: i64 = conn.query_row(
                &format!("SELECT count(*) FROM entry{condition}"),
                params_from_iter(values.iter()),
                |r| r.get(0),
            )?;
            let mut stmt = conn.prepare(&format!(
                "SELECT {COLUMNS} FROM entry{condition} ORDER BY at DESC, id DESC LIMIT {limit} OFFSET {}",
                filter.offset
            ))?;
            let entries = stmt
                .query_map(params_from_iter(values.iter()), entry)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Page { entries, total })
        })
    }

    /// The whole text of an entry (as far as it is kept).
    pub fn text(&self, id: i64) -> AppResult<String> {
        self.with(|conn| conn.query_row("SELECT sql FROM entry WHERE id = ?1", [id], |r| r.get(0)))
            .map_err(|_| AppError::new(ErrorCode::NotFound, "this entry is gone"))
    }

    /// Deletes entries for good: the pages they were on are overwritten (`secure_delete`), and after more
    /// than one entry the file is rebuilt (`VACUUM`). Returns how many went.
    pub fn delete(&self, scope: &Scope) -> AppResult<usize> {
        self.with(|conn| {
            let gone = match scope {
                Scope::All => conn.execute("DELETE FROM entry", [])?,
                Scope::Connection(id) => {
                    conn.execute("DELETE FROM entry WHERE connection_id = ?1", [id])?
                }
                Scope::Entry(id) => conn.execute("DELETE FROM entry WHERE id = ?1", [id])?,
            };
            if !matches!(scope, Scope::Entry(_)) {
                conn.execute_batch("VACUUM")?;
            }
            Ok(gone)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn new(at: i64, connection: &str, sql: &str, outcome: &str) -> NewEntry {
        NewEntry {
            at,
            connection_id: connection.into(),
            connection_name: format!("Name of {connection}"),
            database: "shop".into(),
            sql: sql.into(),
            elapsed_ms: 12,
            rows: Some(3),
            outcome: outcome.into(),
            message: (outcome == "failed").then(|| "relation \"x\" does not exist".to_string()),
            tab: "t1".into(),
            origin: "user".into(),
        }
    }

    fn all(h: &History) -> Vec<Entry> {
        h.list(&Filter::default()).unwrap().entries
    }

    #[test]
    fn writes_and_reads_the_latest_first() {
        let dir = tempdir().unwrap();
        let h = History::new(dir.path().to_path_buf());
        assert!(all(&h).is_empty());
        h.add(&new(1000, "pg", "SELECT 1", "ok"), Keep::default())
            .unwrap();
        let id = h
            .add(
                &new(2000, "pg", "  SELECT * FROM x  ", "failed"),
                Keep::default(),
            )
            .unwrap();
        let list = all(&h);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].preview, "SELECT * FROM x");
        assert_eq!(list[0].outcome, "failed");
        assert_eq!(
            list[0].message.as_deref(),
            Some("relation \"x\" does not exist")
        );
        assert_eq!(list[0].connection_name, "Name of pg");
        assert_eq!(
            (list[0].count, list[0].rows, list[0].elapsed_ms),
            (1, Some(3), 12)
        );
        assert_eq!(h.text(id).unwrap(), "SELECT * FROM x");
        assert!(h.add(&new(1, "pg", "   ", "ok"), Keep::default()).is_err());
        // it is all still there after the file was closed
        drop(h);
        let again = History::new(dir.path().to_path_buf());
        assert_eq!(all(&again).len(), 2);
    }

    #[test]
    fn the_same_statement_in_a_row_counts_up() {
        let dir = tempdir().unwrap();
        let h = History::new(dir.path().to_path_buf());
        let keep = Keep::default();
        let a = h.add(&new(1, "pg", "SELECT 1", "ok"), keep).unwrap();
        let b = h.add(&new(2, "pg", "SELECT 1", "ok"), keep).unwrap();
        assert_eq!(a, b);
        // another connection, another outcome, another text: entries of their own
        h.add(&new(3, "my", "SELECT 1", "ok"), keep).unwrap();
        h.add(&new(4, "pg", "SELECT 1", "failed"), keep).unwrap();
        h.add(&new(5, "pg", "SELECT 2", "ok"), keep).unwrap();
        h.add(&new(6, "pg", "SELECT 1", "ok"), keep).unwrap();
        let list = all(&h);
        assert_eq!(list.len(), 5);
        let first = list.iter().find(|e| e.id == a).unwrap();
        assert_eq!((first.count, first.at), (2, 2));
    }

    #[test]
    fn a_very_long_statement_is_cut_but_told_apart() {
        let dir = tempdir().unwrap();
        let h = History::new(dir.path().to_path_buf());
        let long_a = format!("SELECT '{}a'", "ä".repeat(MAX_SQL_CHARS));
        let long_b = format!("SELECT '{}b'", "ä".repeat(MAX_SQL_CHARS));
        let a = h
            .add(&new(1, "pg", &long_a, "ok"), Keep::default())
            .unwrap();
        let b = h
            .add(&new(2, "pg", &long_b, "ok"), Keep::default())
            .unwrap();
        assert_ne!(a, b);
        assert_eq!(h.text(a).unwrap().chars().count(), MAX_SQL_CHARS);
        let list = all(&h);
        assert_eq!(list[0].length as usize, MAX_SQL_CHARS + 10);
        assert_eq!(list[0].preview.chars().count(), PREVIEW_CHARS);
    }

    #[test]
    fn finds_by_words_connection_outcome_and_time() {
        let dir = tempdir().unwrap();
        let h = History::new(dir.path().to_path_buf());
        let keep = Keep::default();
        h.add(
            &new(100, "pg", "SELECT * FROM customer WHERE id = 1", "ok"),
            keep,
        )
        .unwrap();
        h.add(
            &new(200, "pg", "UPDATE Customer SET name = 'x_y'", "failed"),
            keep,
        )
        .unwrap();
        h.add(&new(300, "my", "SELECT 100% FROM orders", "ok"), keep)
            .unwrap();
        let mut app = new(400, "my", "SELECT * FROM orders LIMIT 200", "ok");
        app.origin = "app".into();
        h.add(&app, keep).unwrap();
        let find =
            |f: Filter| -> Vec<i64> { h.list(&f).unwrap().entries.iter().map(|e| e.at).collect() };
        let text = |t: &str| Filter {
            text: t.into(),
            ..Filter::default()
        };
        assert_eq!(find(text("customer")), vec![200, 100]);
        assert_eq!(find(text("customer select")), vec![100]);
        // wildcards are text
        assert_eq!(find(text("100%")), vec![300]);
        assert_eq!(find(text("x_y")), vec![200]);
        assert_eq!(find(text("x%y")), Vec::<i64>::new());
        assert_eq!(
            find(Filter {
                connection_id: Some("my".into()),
                ..Filter::default()
            }),
            vec![400, 300]
        );
        assert_eq!(
            find(Filter {
                failed_only: true,
                ..Filter::default()
            }),
            vec![200]
        );
        assert_eq!(
            find(Filter {
                user_only: true,
                ..Filter::default()
            }),
            vec![300, 200, 100]
        );
        assert_eq!(
            find(Filter {
                from: Some(200),
                to: Some(300),
                ..Filter::default()
            }),
            vec![300, 200]
        );
        let page = h
            .list(&Filter {
                limit: Some(2),
                offset: 1,
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(page.total, 4);
        assert_eq!(
            page.entries.iter().map(|e| e.at).collect::<Vec<_>>(),
            vec![300, 200]
        );
    }

    #[test]
    fn keeps_only_so_many_and_so_old() {
        let dir = tempdir().unwrap();
        let h = History::new(dir.path().to_path_buf());
        let day = 86_400_000;
        let generous = Keep {
            max_entries: 1000,
            max_days: 0,
        };
        for i in 0..10 {
            h.add(&new(i * day, "pg", &format!("SELECT {i}"), "ok"), generous)
                .unwrap();
        }
        assert_eq!(
            h.prune(
                Keep {
                    max_entries: 1000,
                    max_days: 3
                },
                10 * day
            )
            .unwrap(),
            7
        );
        assert_eq!(all(&h).len(), 3);
        assert_eq!(
            h.prune(
                Keep {
                    max_entries: 2,
                    max_days: 0
                },
                10 * day
            )
            .unwrap(),
            1
        );
        let left: Vec<String> = all(&h).into_iter().map(|e| e.preview).collect();
        assert_eq!(left, vec!["SELECT 9", "SELECT 8"]);
    }

    #[test]
    fn deleting_takes_the_text_out_of_the_file() {
        let dir = tempdir().unwrap();
        let h = History::new(dir.path().to_path_buf());
        let keep = Keep::default();
        let secret = "SELECT 'geheimnis-4711-im-verlauf'";
        let one = h.add(&new(1, "pg", secret, "ok"), keep).unwrap();
        for i in 0..200 {
            h.add(
                &new(i + 2, "my", &format!("SELECT 'andere-{i}'"), "ok"),
                keep,
            )
            .unwrap();
        }
        let file = dir.path().join(FILE_NAME);
        let holds = |needle: &str| {
            let bytes = std::fs::read(&file).unwrap();
            bytes.windows(needle.len()).any(|w| w == needle.as_bytes())
        };
        assert!(holds("geheimnis-4711"));
        assert_eq!(h.delete(&Scope::Entry(one)).unwrap(), 1);
        assert!(!holds("geheimnis-4711"), "one entry: overwritten in place");
        assert!(h.text(one).is_err());
        assert!(holds("andere-17"));
        assert_eq!(h.delete(&Scope::Connection("my".into())).unwrap(), 200);
        assert!(!holds("andere-17"));
        h.add(&new(9, "pg", "SELECT 'noch-eins'", "ok"), keep)
            .unwrap();
        assert_eq!(h.delete(&Scope::All).unwrap(), 1);
        assert!(!holds("noch-eins"));
        assert!(all(&h).is_empty());
    }

    #[test]
    fn a_broken_file_is_set_aside_and_a_new_one_started() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join(FILE_NAME),
            b"this is no database, not at all",
        )
        .unwrap();
        let h = History::new(dir.path().to_path_buf());
        assert!(all(&h).is_empty());
        assert!(h.take_notice().unwrap().contains("beiseitegelegt"));
        assert!(h.take_notice().is_none());
        h.add(&new(1, "pg", "SELECT 1", "ok"), Keep::default())
            .unwrap();
        let aside = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("broken-"))
            .count();
        assert_eq!(aside, 1);
    }

    #[test]
    fn a_hundred_thousand_entries_open_and_search_fast() {
        let dir = tempdir().unwrap();
        let h = History::new(dir.path().to_path_buf());
        h.with(|conn| {
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO entry (at, connection_id, connection_name, database, sql, hash, \
                     length, elapsed_ms, rows, outcome, message, tab, origin) \
                     VALUES (?1, 'pg', 'Shop', 'shop', ?2, 'h', 80, 5, 1, 'ok', NULL, 't', 'user')",
                )?;
                for i in 0..100_000i64 {
                    stmt.execute(params![
                        i,
                        format!("SELECT a, b, c FROM table_{i} WHERE customer_id = {i} ORDER BY a")
                    ])?;
                }
            }
            tx.commit()
        })
        .unwrap();
        let started = std::time::Instant::now();
        let first = h.list(&Filter::default()).unwrap();
        assert_eq!((first.total, first.entries.len()), (100_000, 200));
        let found = h
            .list(&Filter {
                text: "table_99999 customer".into(),
                ..Filter::default()
            })
            .unwrap();
        assert_eq!(found.total, 1);
        assert!(
            started.elapsed().as_millis() < 1500,
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn the_hash_is_the_same_everywhere() {
        assert_eq!(hash(""), "cbf29ce484222325");
        assert_eq!(hash("a"), "af63dc4c8601ec8c");
        assert_ne!(hash("SELECT 1"), hash("SELECT 2"));
    }
}
