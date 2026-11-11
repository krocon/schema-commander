//! SQLite over `rusqlite` (bundled, built without extension loading – `.cargo/config.toml`): database files,
//! and the demo database in memory the app ships with.

use super::value::{Cell, ColKind, Column, Outcome, RowSink, text, text_bytes};
use super::{DbKind, Limits, Profile, Session, Stop};
use crate::error::{AppError, AppResult, ErrorCode};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// Longest statement accepted (bytes).
pub const MAX_SQL_LEN: usize = 16 * 1024 * 1024;
/// `database` of the profile that means the demo database in memory.
pub const DEMO: &str = ":demo:";

const SEED: &str = "
CREATE TABLE customer (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  country TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE product (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  product_id INTEGER NOT NULL REFERENCES product(id),
  quantity INTEGER NOT NULL,
  ordered_at TEXT NOT NULL,
  note TEXT
);
INSERT INTO customer (name, city, country, created_at) VALUES
  ('Ada Lovelace', 'London', 'GB', '2024-01-12'),
  ('Grace Hopper', 'New York', 'US', '2024-02-03'),
  ('Konrad Zuse', 'Berlin', 'DE', '2024-02-27'),
  ('Søren Ærøskøbing', NULL, 'DK', '2024-03-15'),
  ('Margaret Hamilton', 'Boston', 'US', '2024-04-01'),
  ('Linus Torvalds', 'Helsinki', 'FI', '2024-05-20'),
  ('小林 さくら', '東京', 'JP', '2024-06-11');
INSERT INTO product (name, price, stock) VALUES
  ('Keyboard', 89.9, 120), ('Mouse', 39.5, 300), ('Monitor 27\"', 329.0, 45),
  ('USB-C Dock', 149.0, 80), ('Webcam', 74.25, 0);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
INSERT INTO orders (customer_id, product_id, quantity, ordered_at, note)
SELECT 1 + (i * 7) % 7, 1 + (i * 13) % 5, 1 + i % 4,
       date('2024-01-01', '+' || (i % 365) || ' days'),
       CASE WHEN i % 9 = 0 THEN NULL ELSE 'order #' || i END
FROM n;
";

/// The profile of the demo database: always there, cannot be changed or removed.
pub fn demo_profile() -> Profile {
    Profile {
        id: "demo".to_string(),
        name: "Demo (SQLite im Speicher)".to_string(),
        kind: DbKind::Sqlite,
        host: String::new(),
        port: 0,
        database: DEMO.to_string(),
        user: String::new(),
        tls: super::TlsMode::Off,
        folder: String::new(),
        color: 3,
        save_password: false,
        protection: crate::db::guard::Protection::Free,
        label: String::new(),
        ca_file: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        ssh: None,
    }
}

pub struct Lite {
    conn: Connection,
}

fn invalid(e: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InvalidQuery, e.to_string())
}

/// Opens the file of the profile – it must exist, a typo must not create an empty database – or the demo
/// database.
pub fn open(profile: &Profile) -> AppResult<Lite> {
    let path = profile.database.trim();
    if path == DEMO {
        let conn = Connection::open_in_memory().map_err(invalid)?;
        conn.execute_batch(SEED).map_err(invalid)?;
        return Ok(Lite { conn });
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags).map_err(|e| {
        let missing = !std::path::Path::new(path).exists();
        let code = if missing {
            ErrorCode::NotFound
        } else {
            ErrorCode::ConnectionFailed
        };
        AppError::new(code, format!("{path}: {e}"))
    })?;
    // a file that is no database is found out at the first read
    conn.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
        .map_err(|e| AppError::new(ErrorCode::ConnectionFailed, format!("{path}: {e}")))?;
    Ok(Lite { conn })
}

/// The kind of a declared type by SQLite's affinity rules, as far as they say something.
fn kind(decl: Option<&str>) -> ColKind {
    let Some(decl) = decl else {
        return ColKind::Other;
    };
    let d = decl.to_uppercase();
    if d.contains("INT") {
        ColKind::Int
    } else if d.contains("CHAR") || d.contains("CLOB") || d.contains("TEXT") {
        ColKind::Text
    } else if d.contains("BLOB") {
        ColKind::Bytes
    } else if d.contains("REAL") || d.contains("FLOA") || d.contains("DOUB") {
        ColKind::Float
    } else if d.contains("BOOL") {
        ColKind::Bool
    } else if d.contains("DATETIME") || d.contains("TIMESTAMP") {
        ColKind::Timestamp
    } else if d.contains("DATE") {
        ColKind::Date
    } else if d.contains("TIME") {
        ColKind::Time
    } else if d.contains("JSON") {
        ColKind::Json
    } else if d.contains("NUM") || d.contains("DEC") {
        ColKind::Decimal
    } else {
        ColKind::Other
    }
}

/// SQLite types values, not columns: the cell is what is stored, whatever the column declares.
fn cell(value: ValueRef<'_>) -> Cell {
    match value {
        ValueRef::Null => Cell::Null,
        ValueRef::Integer(i) => Cell::I64(i),
        ValueRef::Real(f) => Cell::F64(f),
        ValueRef::Text(t) => match std::str::from_utf8(t) {
            Ok(s) => Cell::Text(text(s)),
            Err(_) => Cell::Text(text_bytes(t)),
        },
        ValueRef::Blob(b) => Cell::bytes(b),
    }
}

impl Session for Lite {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        _timeout: Option<std::time::Duration>,
        _stop: Stop,
    ) -> AppResult<super::TextRows> {
        // the catalog of a file is read in no time: no watcher
        let mut stmt = self.conn.prepare(sql).map_err(invalid)?;
        let count = stmt.column_count();
        let mut cursor = stmt
            .query(rusqlite::params_from_iter(params.iter()))
            .map_err(invalid)?;
        let mut rows = Vec::new();
        while let Some(row) = cursor.next().map_err(invalid)? {
            let mut cells = Vec::with_capacity(count);
            for i in 0..count {
                cells.push(cell(row.get_ref(i).map_err(invalid)?).plain());
            }
            rows.push(cells);
        }
        Ok(rows)
    }

    fn execute(
        &mut self,
        sql: &str,
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
        let elapsed = || u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        // a watcher interrupts the statement when the work is stopped; it ends with the statement
        let interrupt = self.conn.get_interrupt_handle();
        let done = AtomicBool::new(false);
        let stopped = AtomicBool::new(false);
        let timed_out = AtomicBool::new(false);
        let conn = &self.conn;
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !done.load(Ordering::Relaxed) {
                    let late = limits.timeout.is_some_and(|t| started.elapsed() >= t);
                    if late {
                        timed_out.store(true, Ordering::Relaxed);
                    }
                    if late || stop() {
                        stopped.store(true, Ordering::Relaxed);
                        // again and again: an interrupt before the statement has started is lost
                        interrupt.interrupt();
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    } else {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                }
            });
            let result = Self::run(conn, sql, sink, &elapsed);
            done.store(true, Ordering::Relaxed);
            result
        });
        if timed_out.load(Ordering::Relaxed) && result.is_err() {
            return Err(AppError::new(
                ErrorCode::Timeout,
                "the statement took too long",
            ));
        }
        if stopped.load(Ordering::Relaxed) && result.is_err() {
            return Err(super::cancelled());
        }
        result
    }

    fn transaction_state(&mut self, _stop: Stop) -> super::TxState {
        if self.conn.is_autocommit() {
            super::TxState::Idle
        } else {
            super::TxState::Active
        }
    }

    fn server_version(&mut self, _stop: Stop) -> AppResult<String> {
        Ok(format!("SQLite {}", rusqlite::version()))
    }

    fn is_open(&self) -> bool {
        true
    }
}

impl Lite {
    /// Runs statements on the database of a test.
    #[cfg(test)]
    pub fn execute_batch_for_tests(&mut self, sql: &str) {
        self.conn.execute_batch(sql).unwrap();
    }

    fn run(
        conn: &Connection,
        sql: &str,
        sink: &mut dyn RowSink,
        elapsed: &dyn Fn() -> u64,
    ) -> AppResult<Outcome> {
        let mut stmt = conn.prepare(sql).map_err(invalid)?;
        let count = stmt.column_count();
        let columns: Vec<Column> = stmt
            .columns()
            .map(|c| Column {
                name: c.name().to_string(),
                kind: kind(c.decl_type()),
                type_name: c.decl_type().unwrap_or_default().to_string(),
            })
            .collect();
        if count == 0 {
            let changed = stmt.execute([]).map_err(invalid)?;
            return Ok(Outcome {
                columns,
                rows: 0,
                truncated: false,
                rows_affected: Some(changed as u64),
                elapsed_ms: elapsed(),
            });
        }
        sink.start(&columns);
        let mut rows: u64 = 0;
        let mut truncated = false;
        let mut cursor = stmt.query([]).map_err(invalid)?;
        while let Some(row) = cursor.next().map_err(invalid)? {
            let mut cells = Vec::with_capacity(count);
            for i in 0..count {
                cells.push(cell(row.get_ref(i).map_err(invalid)?));
            }
            rows += 1;
            if !sink.row(cells) {
                truncated = true;
                break;
            }
        }
        drop(cursor);
        Ok(Outcome {
            columns,
            rows,
            truncated,
            rows_affected: None,
            elapsed_ms: elapsed(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::value::{MAX_ROWS, QueryResult};
    use serde_json::json;

    fn demo() -> Lite {
        open(&demo_profile()).unwrap()
    }

    fn run(db: &mut Lite, sql: &str) -> AppResult<QueryResult> {
        db.query(sql, Limits::rows(MAX_ROWS), &|| false)
    }

    fn json_rows(r: &QueryResult) -> serde_json::Value {
        serde_json::to_value(&r.rows).unwrap()
    }

    #[test]
    fn selects_rows_with_kinds_and_unicode() {
        let mut db = demo();
        let r = run(&mut db, "SELECT id, name, city FROM customer ORDER BY id").unwrap();
        assert_eq!(r.columns.len(), 3);
        assert_eq!(r.columns[0].kind, ColKind::Int);
        assert_eq!(r.columns[0].type_name, "INTEGER");
        assert_eq!(r.columns[1].kind, ColKind::Text);
        assert_eq!(r.rows.len(), 7);
        assert_eq!(json_rows(&r)[3], json!([4, "Søren Ærøskøbing", null]));
        assert_eq!(json_rows(&r)[6][1], json!("小林 さくら"));
        assert_eq!(r.rows_affected, None);
        assert!(!r.truncated);
    }

    #[test]
    fn expressions_have_no_declared_type_and_blobs_show_their_head() {
        let mut db = demo();
        let r = run(&mut db, "SELECT 1 + 1 AS two, 1.5, x'00ff', ''").unwrap();
        assert_eq!(r.columns[0].name, "two");
        assert_eq!(r.columns[0].kind, ColKind::Other);
        assert_eq!(
            json_rows(&r)[0],
            json!([2, 1.5, { "bytes": 2, "hex": "00ff" }, ""])
        );
    }

    #[test]
    fn cuts_off_at_the_row_limit() {
        let mut db = demo();
        let r = db
            .query("SELECT * FROM orders", Limits::rows(100), &|| false)
            .unwrap();
        assert_eq!(r.rows.len(), 100);
        assert!(r.truncated);
        let all = run(&mut db, "SELECT * FROM orders").unwrap();
        assert_eq!(all.rows.len(), 2000);
        assert!(!all.truncated);
    }

    #[test]
    fn reports_changed_rows_and_keeps_big_integers() {
        let mut db = demo();
        let r = run(
            &mut db,
            "UPDATE product SET stock = stock + 1 WHERE stock = 0",
        )
        .unwrap();
        assert_eq!(r.rows_affected, Some(1));
        assert!(r.columns.is_empty());
        let big = run(&mut db, "SELECT 9223372036854775807").unwrap();
        assert_eq!(json_rows(&big)[0][0], json!("9223372036854775807"));
    }

    #[test]
    fn refuses_empty_and_broken_statements() {
        let mut db = demo();
        assert_eq!(
            run(&mut db, "  \n").unwrap_err().code,
            ErrorCode::InvalidQuery
        );
        let e = run(&mut db, "SELEC 1").unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidQuery);
        assert!(e.message.contains("syntax error"), "{}", e.message);
    }

    #[test]
    fn a_running_statement_can_be_stopped_and_the_session_goes_on() {
        let mut db = demo();
        let endless = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) \
                       SELECT count(*) FROM n";
        let e = db.query(endless, Limits::rows(10), &|| true).unwrap_err();
        assert_eq!(e.code, ErrorCode::Cancelled);
        assert_eq!(run(&mut db, "SELECT 1").unwrap().rows.len(), 1);
        let limits = Limits {
            max_rows: 10,
            timeout: Some(std::time::Duration::from_millis(80)),
        };
        let e = db.query(endless, limits, &|| false).unwrap_err();
        assert_eq!(e.code, ErrorCode::Timeout);
        assert_eq!(run(&mut db, "SELECT 1").unwrap().rows.len(), 1);
    }

    #[test]
    fn opens_a_file_and_refuses_what_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Meine Daten ä.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')")
            .unwrap();
        let mut p = demo_profile();
        p.database = path.to_string_lossy().into_owned();
        let mut db = open(&p).unwrap();
        assert_eq!(
            json_rows(&run(&mut db, "SELECT a FROM t").unwrap()),
            json!([["x"]])
        );
        assert!(
            db.server_version(&|| false)
                .unwrap()
                .starts_with("SQLite 3")
        );

        p.database = dir
            .path()
            .join("gibt-es-nicht.db")
            .to_string_lossy()
            .into_owned();
        assert_eq!(open(&p).err().unwrap().code, ErrorCode::NotFound);
        assert!(!dir.path().join("gibt-es-nicht.db").exists());

        let text = dir.path().join("notiz.txt");
        std::fs::write(
            &text,
            "das ist keine Datenbank, nur ein längerer Text zum Prüfen",
        )
        .unwrap();
        p.database = text.to_string_lossy().into_owned();
        assert_eq!(open(&p).err().unwrap().code, ErrorCode::ConnectionFailed);
    }

    #[test]
    fn cannot_load_extensions() {
        let mut db = demo();
        let e = run(&mut db, "SELECT load_extension('/tmp/x')").unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidQuery);
    }
}
