//! The walking skeleton's database: SQLite in memory with a few tables, so a statement typed in the
//! editor travels to Rust and its rows come back into the result grid. Pure (no Tauri), tested here.
//! The real connections (PostgreSQL, MySQL, SQL Server, SQLite files …) replace this module.

use crate::error::{AppError, AppResult, ErrorCode};
use rusqlite::Connection;
use rusqlite::types::ValueRef;
use serde::Serialize;
use std::time::Instant;

/// Longest statement accepted (bytes).
pub const MAX_SQL_LEN: usize = 1_000_000;
/// Rows a result holds at most; more are cut off and `truncated` says so.
pub const MAX_ROWS: usize = 100_000;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// The declared type of a table column (`INTEGER`, `TEXT` …); `None` for expressions.
    pub decl_type: Option<String>,
}

/// The rows of a statement. Cells are JSON values: `null`, numbers, strings; a blob becomes
/// `{ "blob": <bytes> }` (its length only).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// More rows than [`MAX_ROWS`] existed.
    pub truncated: bool,
    /// Rows changed by an `INSERT`/`UPDATE`/`DELETE`; `None` for a statement with a result.
    pub rows_affected: Option<usize>,
    pub elapsed_ms: u64,
}

pub struct DemoDb {
    conn: Connection,
}

fn invalid(e: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InvalidQuery, e.to_string())
}

impl DemoDb {
    pub fn new() -> AppResult<Self> {
        let conn = Connection::open_in_memory().map_err(invalid)?;
        conn.execute_batch(SEED).map_err(invalid)?;
        Ok(Self { conn })
    }

    /// Runs one statement and collects at most `max_rows` rows.
    pub fn run(&self, sql: &str, max_rows: usize) -> AppResult<QueryResult> {
        let sql = sql.trim();
        if sql.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidQuery, "empty statement"));
        }
        if sql.len() > MAX_SQL_LEN {
            return Err(AppError::new(ErrorCode::InvalidQuery, "statement too long"));
        }
        let started = Instant::now();
        let mut stmt = self.conn.prepare(sql).map_err(invalid)?;
        let count = stmt.column_count();
        let columns: Vec<Column> = stmt
            .columns()
            .map(|c| Column {
                name: c.name().to_string(),
                decl_type: c.decl_type().map(str::to_string),
            })
            .collect();
        if count == 0 {
            let changed = stmt.execute([]).map_err(invalid)?;
            return Ok(QueryResult {
                columns,
                rows: Vec::new(),
                truncated: false,
                rows_affected: Some(changed),
                elapsed_ms: elapsed(started),
            });
        }
        let mut rows = Vec::new();
        let mut truncated = false;
        let mut cursor = stmt.query([]).map_err(invalid)?;
        while let Some(row) = cursor.next().map_err(invalid)? {
            if rows.len() >= max_rows {
                truncated = true;
                break;
            }
            let mut cells = Vec::with_capacity(count);
            for i in 0..count {
                cells.push(cell(row.get_ref(i).map_err(invalid)?));
            }
            rows.push(cells);
        }
        Ok(QueryResult {
            columns,
            rows,
            truncated,
            rows_affected: None,
            elapsed_ms: elapsed(started),
        })
    }
}

fn elapsed(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn cell(value: ValueRef<'_>) -> serde_json::Value {
    use serde_json::Value;
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        // NaN and infinities have no JSON number
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(f.to_string())),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => serde_json::json!({ "blob": b.len() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selects_rows_with_types_and_unicode() {
        let db = DemoDb::new().unwrap();
        let r = db
            .run("SELECT id, name, city FROM customer ORDER BY id", MAX_ROWS)
            .unwrap();
        assert_eq!(r.columns.len(), 3);
        assert_eq!(r.columns[0].decl_type.as_deref(), Some("INTEGER"));
        assert_eq!(r.rows.len(), 7);
        assert_eq!(
            r.rows[3],
            vec![json!(4), json!("Søren Ærøskøbing"), json!(null)]
        );
        assert_eq!(r.rows[6][1], json!("小林 さくら"));
        assert_eq!(r.rows_affected, None);
        assert!(!r.truncated);
    }

    #[test]
    fn expressions_have_no_declared_type() {
        let db = DemoDb::new().unwrap();
        let r = db
            .run("SELECT 1 + 1 AS two, 1.5, x'00ff'", MAX_ROWS)
            .unwrap();
        assert_eq!(r.columns[0].name, "two");
        assert_eq!(r.columns[0].decl_type, None);
        assert_eq!(r.rows[0], vec![json!(2), json!(1.5), json!({ "blob": 2 })]);
    }

    #[test]
    fn cuts_off_at_the_row_limit() {
        let db = DemoDb::new().unwrap();
        let r = db.run("SELECT * FROM orders", 100).unwrap();
        assert_eq!(r.rows.len(), 100);
        assert!(r.truncated);
        let all = db.run("SELECT * FROM orders", MAX_ROWS).unwrap();
        assert_eq!(all.rows.len(), 2000);
        assert!(!all.truncated);
    }

    #[test]
    fn reports_changed_rows() {
        let db = DemoDb::new().unwrap();
        let r = db
            .run(
                "UPDATE product SET stock = stock + 1 WHERE stock = 0",
                MAX_ROWS,
            )
            .unwrap();
        assert_eq!(r.rows_affected, Some(1));
        assert!(r.columns.is_empty());
    }

    #[test]
    fn refuses_empty_and_broken_statements() {
        let db = DemoDb::new().unwrap();
        assert_eq!(
            db.run("  \n", MAX_ROWS).unwrap_err().code,
            ErrorCode::InvalidQuery
        );
        let e = db.run("SELEC 1", MAX_ROWS).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidQuery);
        assert!(e.message.contains("syntax error"), "{}", e.message);
    }
}
