//! DuckDB needs no server: these tests run with every `cargo test`, on a database in memory.

use super::*;
use crate::db::value::{MAX_ROWS, QueryResult, VecSink};
use crate::db::{DbKind, details, diagram, edit, filter, find, meta, names, relations};
use serde_json::json;

const K: DbKind = DbKind::Duckdb;

fn profile(id: &str, database: &str) -> Profile {
    let mut p = crate::db::sqlite::demo_profile();
    p.id = id.into();
    p.kind = K;
    p.database = database.into();
    p
}

fn memory(id: &str) -> Duck {
    open(&profile(id, MEMORY)).unwrap()
}

fn run(db: &mut Duck, sql: &str) -> QueryResult {
    db.query(sql, Limits::rows(MAX_ROWS), &|| false)
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

fn bound(db: &mut Duck, sql: &str, params: &[Bind]) -> QueryResult {
    let mut sink = VecSink::new(MAX_ROWS);
    let outcome = db
        .execute_bound(sql, params, Limits::rows(MAX_ROWS), &mut sink, &|| false)
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    QueryResult {
        columns: outcome.columns,
        rows: sink.rows,
        truncated: outcome.truncated,
        rows_affected: outcome.rows_affected,
        elapsed_ms: outcome.elapsed_ms,
    }
}

fn rows(r: &QueryResult) -> serde_json::Value {
    serde_json::to_value(&r.rows).unwrap()
}

const SHOP: &str = "
CREATE TABLE customer (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, country VARCHAR DEFAULT 'DE');
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer (id),
  placed_at DATE NOT NULL, total DECIMAL(10,2) CHECK (total >= 0), \"select\" VARCHAR);
CREATE INDEX orders_placed ON orders (placed_at);
CREATE VIEW open_orders AS SELECT o.id, c.name FROM orders o JOIN customer c ON c.id = o.customer_id
  WHERE o.total > 100;
CREATE SEQUENCE order_no START 5;
INSERT INTO customer VALUES (1, 'Ada Lindqvist', 'SE'), (2, 'Bruno 100% Ferrari_x', 'IT');
INSERT INTO orders VALUES (1, 1, DATE '2026-01-10', 250, NULL), (2, 1, DATE '2026-02-11', 40.5, 'x'),
  (3, 2, DATE '2026-03-12', NULL, NULL);
";

fn shop(id: &str) -> Duck {
    let mut db = memory(id);
    run(&mut db, SHOP);
    db
}

#[test]
fn types_unicode_and_null() {
    let mut db = memory("types");
    assert!(db.server_version(&|| false).unwrap().starts_with("DuckDB "));
    let r = run(
        &mut db,
        "SELECT 42 AS i, 9223372036854775807 AS big, 170141183460469231731687303715884105727 AS huge, \
         1.5::DOUBLE AS f, 12.50::DECIMAL(10,2) AS price, true AS ok, 'Grüße 🚀 小林' AS t, \
         NULL::VARCHAR AS nul, '' AS empty, '\\x00\\xFF\\x10'::BLOB AS bin, \
         TIMESTAMP '2024-02-29 13:05:09.25' AS ts, TIMESTAMPTZ '2024-02-29 13:05:09+02' AS tstz, \
         DATE '2024-02-29' AS d, TIME '13:05:09' AS tm, '{\"a\": [1, 2]}'::JSON AS j, \
         'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::UUID AS u, [1, 2, 3] AS arr, \
         {'a': 1, 'b': 'x'} AS st, INTERVAL '1 day 2 hours' AS iv, 'y'::ENUM('x', 'y') AS e, \
         MAP {'k': 1} AS m",
    );
    let kinds: Vec<ColKind> = r.columns.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        vec![
            ColKind::Int,
            ColKind::Int,
            ColKind::Decimal,
            ColKind::Float,
            ColKind::Decimal,
            ColKind::Bool,
            ColKind::Text,
            ColKind::Text,
            ColKind::Text,
            ColKind::Bytes,
            ColKind::Timestamp,
            ColKind::TimestampTz,
            ColKind::Date,
            ColKind::Time,
            ColKind::Text,
            ColKind::Text,
            ColKind::Other,
            ColKind::Other,
            ColKind::Other,
            ColKind::Other,
            ColKind::Other,
        ]
    );
    assert_eq!(
        rows(&r)[0],
        json!([
            42,
            "9223372036854775807",
            "170141183460469231731687303715884105727",
            1.5,
            "12.50",
            true,
            "Grüße 🚀 小林",
            null,
            "",
            { "bytes": 3, "hex": "00ff10" },
            "2024-02-29 13:05:09.250",
            "2024-02-29 11:05:09+00:00",
            "2024-02-29",
            "13:05:09",
            "{\"a\": [1, 2]}",
            "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
            "[1, 2, 3]",
            "{'a': 1, 'b': x}",
            "1 day 02:00:00",
            "y",
            "{k=1}"
        ])
    );
    assert_eq!(r.columns[4].type_name, "DECIMAL(10,2)");
    // a time in nanoseconds is a type the driver cannot hand over: said in the cell or as an error,
    // and the session goes on (review 035c 2)
    let odd = db.query(
        "SELECT TIME_NS '12:00:00' AS t, 1 AS one",
        Limits::rows(5),
        &|| false,
    );
    if let Ok(r) = &odd {
        assert_eq!(rows(r)[0][1], json!(1));
    }
    assert_eq!(rows(&run(&mut db, "SELECT 7")), json!([[7]]));
    // a query with a column called Count is a query (review 035c 6)
    assert_eq!(
        rows(&run(
            &mut db,
            "FROM (SELECT 5 AS \"Count\") SELECT \"Count\""
        )),
        json!([[5]])
    );
    // a column that is nothing but NULL has a type of its own, which the driver cannot hand over
    assert_eq!(
        rows(&run(&mut db, "SELECT NULL AS n, 1 AS one")),
        json!([[null, 1]])
    );
    assert_eq!(r.columns[11].type_name, "TIMESTAMP WITH TIME ZONE");
}

#[test]
fn changes_scripts_limits_and_errors_with_their_place() {
    let mut db = memory("changes");
    assert_eq!(
        run(
            &mut db,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name VARCHAR)"
        )
        .rows_affected,
        None
    );
    assert_eq!(
        run(&mut db, "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')").rows_affected,
        Some(3)
    );
    assert_eq!(
        run(&mut db, "UPDATE t SET name = 'x' WHERE id > 100").rows_affected,
        Some(0)
    );
    assert_eq!(
        run(&mut db, "DELETE FROM t WHERE id = 3;").rows_affected,
        Some(1)
    );
    // several statements as typed: the last one answers; a `;` in a string is none
    let last = run(
        &mut db,
        "INSERT INTO t VALUES (4, 'a;b'); -- note\nSELECT count(*) FROM t;",
    );
    assert_eq!(rows(&last), json!([[3]]));
    assert_eq!(
        split("select ';'; select $$a;b$$ ; /* ; */ select 2 -- ;").len(),
        3
    );
    assert!(split(" ; -- nothing\n").is_empty());
    let empty = run(&mut db, "SELECT * FROM t WHERE false");
    assert_eq!(empty.columns.len(), 2);
    let cut = db
        .query("SELECT * FROM range(1000)", Limits::rows(5), &|| false)
        .unwrap();
    assert!(cut.truncated && cut.rows.len() == 5);
    assert_eq!(rows(&run(&mut db, "SELECT 1")), json!([[1]]));

    let unknown = db
        .query("SELECT nme FROM t", Limits::rows(1), &|| false)
        .unwrap_err();
    assert_eq!(unknown.code, ErrorCode::InvalidQuery);
    let d = unknown.details.unwrap();
    assert_eq!(d.sqlstate.as_deref(), Some("Binder"));
    assert_eq!((d.line, d.position), (Some(1), Some(8)));
    assert!(unknown.message.contains("nme"), "{}", unknown.message);
    let syntax = db
        .query("SELECT *\n  FRM t", Limits::rows(1), &|| false)
        .unwrap_err();
    let d = syntax.details.unwrap();
    assert_eq!(d.sqlstate.as_deref(), Some("Parser"));
    assert_eq!(d.line, Some(2));
    let twice = db
        .query(
            "INSERT INTO t VALUES (1, 'again')",
            Limits::rows(1),
            &|| false,
        )
        .unwrap_err();
    assert_eq!(twice.code, ErrorCode::InvalidQuery);
    assert!(
        twice.message.to_lowercase().contains("constraint"),
        "{}",
        twice.message
    );
}

#[test]
fn a_statement_stops_and_the_session_goes_on() {
    let mut db = memory("stop");
    let stop = AtomicBool::new(false);
    let started = Instant::now();
    let r = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(200));
            stop.store(true, Ordering::Relaxed);
        });
        db.query(
            "SELECT count(*) FROM range(100000000000) a, range(1000) b WHERE a.range % 7 = b.range",
            Limits::rows(1),
            &|| stop.load(Ordering::Relaxed),
        )
    });
    assert_eq!(r.unwrap_err().code, ErrorCode::Cancelled);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(rows(&run(&mut db, "SELECT 1")), json!([[1]]));
    let late = db.query(
        "SELECT count(*) FROM range(100000000000) a, range(1000) b WHERE a.range % 7 = b.range",
        Limits {
            max_rows: 1,
            timeout: Some(std::time::Duration::from_millis(200)),
        },
        &|| false,
    );
    assert_eq!(late.unwrap_err().code, ErrorCode::Timeout);
    assert_eq!(rows(&run(&mut db, "SELECT 2")), json!([[2]]));
}

#[test]
fn the_sessions_of_a_profile_share_a_database_and_know_their_transactions() {
    let mut a = memory("shared");
    let mut b = memory("shared");
    let mut other = memory("another");
    run(&mut a, "CREATE TABLE t (id INTEGER)");
    run(&mut a, "INSERT INTO t VALUES (1)");
    assert_eq!(rows(&run(&mut b, "SELECT count(*) FROM t")), json!([[1]]));
    // a database in memory of another profile is another one
    assert!(
        other
            .query("SELECT * FROM t", Limits::rows(1), &|| false)
            .is_err()
    );
    assert_eq!(a.transaction_state(&|| false), TxState::Idle);
    run(&mut a, crate::db::begin_statement(K));
    assert_eq!(a.transaction_state(&|| false), TxState::Active);
    run(&mut a, "INSERT INTO t VALUES (2)");
    assert_eq!(rows(&run(&mut b, "SELECT count(*) FROM t")), json!([[1]]));
    assert_eq!(b.transaction_state(&|| false), TxState::Idle);
    run(&mut a, "COMMIT");
    assert_eq!(a.transaction_state(&|| false), TxState::Idle);
    assert_eq!(rows(&run(&mut b, "SELECT count(*) FROM t")), json!([[2]]));
    run(&mut a, "BEGIN; DELETE FROM t");
    assert_eq!(a.transaction_state(&|| false), TxState::Active);
    // an error inside a transaction: what is said about it afterwards is true
    assert!(
        a.query("SELECT * FROM nope", Limits::rows(1), &|| false)
            .is_err()
    );
    let state = a.transaction_state(&|| false);
    let begin_again = a.query("BEGIN", Limits::rows(1), &|| false);
    assert_eq!(state == TxState::Active, begin_again.is_err());
    let _ = a.query("ROLLBACK", Limits::rows(1), &|| false);
    assert_eq!(a.transaction_state(&|| false), TxState::Idle);
    assert_eq!(rows(&run(&mut b, "SELECT count(*) FROM t")), json!([[2]]));
    // the database lives as long as one of its sessions
    drop(a);
    assert_eq!(rows(&run(&mut b, "SELECT count(*) FROM t")), json!([[2]]));
    drop(b);
    let mut fresh = memory("shared");
    assert!(
        fresh
            .query("SELECT * FROM t", Limits::rows(1), &|| false)
            .is_err()
    );
}

#[test]
fn a_file_must_exist_and_is_read_with_parquet_and_csv_beside_it() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("nope.duckdb");
    let e = open(&profile("f", missing.to_str().unwrap()))
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(!missing.exists());
    let garbage = dir.path().join("garbage.duckdb");
    std::fs::write(&garbage, b"this is no database").unwrap();
    let e = open(&profile("g", garbage.to_str().unwrap()))
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::ConnectionFailed);

    // a real file: made by a database in memory, then opened by two sessions
    let file = dir.path().join("shop.duckdb");
    let parquet = dir.path().join("orders.parquet");
    let csv = dir.path().join("people.csv");
    std::fs::write(&csv, "id,name\n1,Ada\n2,Bruno\n").unwrap();
    {
        let mut maker = shop("maker");
        run(&mut maker, &format!("ATTACH '{}' AS out", file.display()));
        run(
            &mut maker,
            "CREATE TABLE out.customer AS SELECT * FROM customer",
        );
        run(
            &mut maker,
            &format!("COPY orders TO '{}' (FORMAT parquet)", parquet.display()),
        );
        run(&mut maker, "DETACH out");
    }
    let p = profile("file", file.to_str().unwrap());
    let mut a = open(&p).unwrap();
    let mut b = open(&p).unwrap();
    assert_eq!(
        rows(&run(&mut a, "SELECT count(*) FROM customer")),
        json!([[2]])
    );
    run(&mut b, "INSERT INTO customer VALUES (3, 'Chidi', 'NG')");
    assert_eq!(
        rows(&run(&mut a, "SELECT count(*) FROM customer")),
        json!([[3]])
    );
    // files beside it are tables to a query; nothing is fetched for that
    let from_parquet = run(
        &mut a,
        &format!("SELECT count(*), sum(total) FROM '{}'", parquet.display()),
    );
    assert_eq!(rows(&from_parquet), json!([[3, "290.50"]]));
    let from_csv = run(
        &mut a,
        &format!("SELECT name FROM read_csv('{}') ORDER BY id", csv.display()),
    );
    assert_eq!(rows(&from_csv), json!([["Ada"], ["Bruno"]]));
    let settings = run(
        &mut a,
        "SELECT current_setting('autoinstall_known_extensions'), current_setting('autoload_known_extensions')",
    );
    assert_eq!(rows(&settings), json!([[false, false]]));
}

#[test]
fn binds_values() {
    let mut db = memory("binds");
    run(
        &mut db,
        "CREATE TABLE p (id INTEGER, name VARCHAR, price DECIMAL(12,4), ok BOOLEAN, day DATE, moment TIMESTAMP)",
    );
    let evil = "'; DROP TABLE p; --";
    let inserted = bound(
        &mut db,
        "INSERT INTO p VALUES ($1, $2, $3, $4, $5, $6)",
        &[
            Bind::Int("7".into()),
            Bind::Text(evil.into()),
            Bind::Decimal("12345678.1234".into()),
            Bind::Bool(true),
            Bind::Date("2026-11-11".into()),
            Bind::Datetime("2026-11-11 12:30:00.5".into()),
        ],
    );
    assert_eq!(inserted.rows_affected, Some(1));
    let found = bound(
        &mut db,
        "SELECT id, price, ok, day, moment FROM p WHERE name = $1 AND day = $2 AND price > $3",
        &[
            Bind::Text(evil.into()),
            Bind::Date("2026-11-11".into()),
            Bind::Decimal("1.5".into()),
        ],
    );
    assert_eq!(
        rows(&found),
        json!([[
            7,
            "12345678.1234",
            true,
            "2026-11-11",
            "2026-11-11 12:30:00.500"
        ]])
    );
    let wrong = db.execute_bound(
        "SELECT $1",
        &[],
        Limits::rows(1),
        &mut VecSink::new(1),
        &|| false,
    );
    assert!(wrong.is_err());
    let asked = db
        .ask(
            "SELECT name, CAST(id AS VARCHAR) FROM p WHERE name = $1",
            &[evil],
            None,
            &|| false,
        )
        .unwrap();
    assert_eq!(
        asked,
        vec![vec![Some(evil.to_owned()), Some("7".to_owned())]]
    );
}

#[test]
fn metadata_names_relations_diagram_and_details() {
    let mut db = shop("meta");
    let stop = &|| false;
    let schemas = meta::schemas(&mut db, K, stop).unwrap();
    let main = schemas.iter().find(|s| s.name == "main").unwrap();
    assert!(main.current && !main.system);
    let objects = meta::objects(&mut db, K, "main", stop).unwrap();
    let named: Vec<String> = objects
        .iter()
        .map(|o| format!("{:?} {}", o.kind, o.name))
        .collect();
    assert_eq!(
        named,
        [
            "Table customer",
            "Table orders",
            "View open_orders",
            "Sequence order_no"
        ]
    );
    let t = meta::table(&mut db, K, "main", "orders", stop).unwrap();
    let columns: Vec<String> = t
        .columns
        .iter()
        .map(|c| format!("{} {} {} {}", c.quoted, c.type_name, c.nullable, c.key))
        .collect();
    assert_eq!(
        columns,
        [
            "id INTEGER false pk",
            "customer_id INTEGER false fk",
            "placed_at DATE false ",
            "total DECIMAL(10,2) true ",
            "\"select\" VARCHAR true "
        ]
    );
    let keys: Vec<&str> = t.keys.iter().map(|k| k.detail.as_str()).collect();
    assert!(
        keys.iter().any(|k| k.starts_with("PRIMARY KEY")),
        "{keys:?}"
    );
    assert!(
        keys.iter()
            .any(|k| k.starts_with("FOREIGN KEY (customer_id) REFERENCES customer")),
        "{keys:?}"
    );
    assert!(keys.iter().any(|k| k.starts_with("CHECK")), "{keys:?}");
    assert!(keys.iter().all(|k| *k != "NOT NULL"), "{keys:?}");
    assert_eq!(t.indexes.len(), 1);
    assert_eq!(t.indexes[0].name, "orders_placed");
    let customer = meta::table(&mut db, K, "main", "customer", stop).unwrap();
    assert_eq!(customer.columns[2].default.as_deref(), Some("'DE'"));
    let found = meta::search(&mut db, K, "ORD", stop).unwrap();
    let hits: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(hits, ["open_orders", "orders"]);

    let mut index = names::read_objects(&mut db, K, stop).unwrap();
    let search = |index: &names::NameIndex, q: &str| {
        names::search(index, q, &names::Context::default(), K).hits
    };
    assert_eq!(search(&index, "cust")[0].name, "customer");
    assert!(search(&index, "duckdb_tables").is_empty());
    names::read_columns(&mut db, K, &mut index, stop).unwrap();
    assert_eq!(search(&index, "c:orders.cust")[0].name, "customer_id");

    let r = relations::relations(&mut db, K, "main", "customer", stop).unwrap();
    assert!(r.outgoing.is_empty());
    assert_eq!(r.incoming.len(), 1);
    assert_eq!(
        (
            r.incoming[0].table.as_str(),
            r.incoming[0].columns.clone(),
            r.incoming[0].ref_columns.clone()
        ),
        (
            "orders",
            vec!["customer_id".to_owned()],
            vec!["id".to_owned()]
        )
    );
    assert_eq!(
        relations::relations(&mut db, K, "main", "orders", stop)
            .unwrap()
            .outgoing
            .len(),
        1
    );

    let d = diagram::diagram(&mut db, K, "main", stop).unwrap();
    let tables: Vec<&str> = d.tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(tables, ["customer", "orders"]);
    assert_eq!(d.keys.len(), 1);
    assert!(d.tables[1].columns.iter().any(|c| c.name == "id" && c.pk));

    let details = details::details(
        &mut db,
        K,
        "main",
        "orders",
        meta::ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    let section = |id: &str| {
        details
            .sections
            .iter()
            .find(|s| s.id == id)
            .unwrap_or_else(|| panic!("{id}: {:?}", details.notes))
    };
    assert_eq!(section("columns").rows.len(), 5);
    assert_eq!(
        section("references").rows[0][3].as_deref(),
        Some("customer")
    );
    assert_eq!(section("indexes").rows.len(), 1);
    assert!(
        section("constraints")
            .rows
            .iter()
            .any(|r| r[1].as_deref() == Some("CHECK"))
    );
    let ddl = details.ddl.unwrap();
    assert!(ddl.starts_with("CREATE TABLE orders("), "{ddl}");
    assert!(ddl.contains("CREATE INDEX orders_placed"), "{ddl}");
    let by = details::details(
        &mut db,
        K,
        "main",
        "customer",
        meta::ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    assert!(by.sections.iter().any(|s| s.id == "referencedBy"));
    let view = details::details(
        &mut db,
        K,
        "main",
        "open_orders",
        meta::ObjectKind::View,
        "",
        stop,
    )
    .unwrap();
    assert!(view.ddl.unwrap().starts_with("CREATE VIEW open_orders"));
    let missing = details::details(
        &mut db,
        K,
        "main",
        "nope",
        meta::ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    assert!(missing.ddl.is_none());
    // the statements build the table again in an empty database
    let mut empty = memory("meta-again");
    run(&mut empty, "CREATE TABLE customer (id INTEGER PRIMARY KEY)");
    run(&mut empty, &ddl);
    assert_eq!(
        meta::table(&mut empty, K, "main", "orders", stop)
            .unwrap()
            .columns
            .len(),
        5
    );
}

#[test]
fn a_table_is_filtered_sorted_and_edited() {
    use edit::{CellValue, RowDelete, RowInsert, RowUpdate, SetCell, UpdatePlan};
    use filter::{Condition, Op, Order, TableQuery, ValueKind};
    let mut db = shop("edit");
    let condition =
        |column: &str, op: Op, values: &[&str], kind: ValueKind, type_name: &str| Condition {
            column: column.into(),
            op,
            values: values.iter().map(|v| (*v).to_owned()).collect(),
            kind,
            type_name: type_name.into(),
        };
    let q = filter::build(
        K,
        &TableQuery {
            schema: Some("main".into()),
            table: "orders".into(),
            conditions: vec![
                condition(
                    "placed_at",
                    Op::Ge,
                    &["2026-02-01"],
                    ValueKind::Text,
                    "DATE",
                ),
                condition("customer_id", Op::Eq, &["1"], ValueKind::Number, "INTEGER"),
                condition(
                    "total",
                    Op::Lt,
                    &["100.5"],
                    ValueKind::Number,
                    "DECIMAL(10,2)",
                ),
            ],
            order: vec![Order {
                column: "select".into(),
                desc: true,
                nulls: Some(filter::Nulls::Last),
            }],
            limit: Some(10),
            ..TableQuery::default()
        },
    )
    .unwrap();
    assert_eq!(
        q.sql,
        "SELECT *\nFROM main.orders\nWHERE placed_at >= $1\n  AND customer_id = $2\n  AND total < $3\nORDER BY \"select\" DESC NULLS LAST\nLIMIT 10"
    );
    assert_eq!(rows(&bound(&mut db, &q.sql, &q.params))[0][0], json!(2));
    let like = filter::build(
        K,
        &TableQuery {
            table: "customer".into(),
            conditions: vec![condition(
                "name",
                Op::Contains,
                &["100%"],
                ValueKind::Text,
                "VARCHAR",
            )],
            ..TableQuery::default()
        },
    )
    .unwrap();
    assert_eq!(bound(&mut db, &like.sql, &like.params).rows.len(), 1);

    let number = |column: &str, value: &str| CellValue {
        column: column.into(),
        kind: ValueKind::Number,
        type_name: "INTEGER".into(),
        value: Some(value.into()),
    };
    let set = |column: &str, value: Option<&str>, kind: ValueKind, type_name: &str| SetCell {
        column: column.into(),
        kind,
        type_name: type_name.into(),
        value: value.map(str::to_owned),
        default: false,
    };
    let new_row = |id: &str, day: &str| RowInsert {
        set: vec![
            set("id", Some(id), ValueKind::Number, "INTEGER"),
            set("customer_id", Some("2"), ValueKind::Number, "INTEGER"),
            set("placed_at", Some(day), ValueKind::Text, "DATE"),
            set("total", None, ValueKind::Number, "DECIMAL(10,2)"),
        ],
    };
    let plan = UpdatePlan {
        schema: Some("main".into()),
        table: "orders".into(),
        rows: vec![RowUpdate {
            key: vec![number("id", "1")],
            set: vec![set(
                "total",
                Some("260.75"),
                ValueKind::Number,
                "DECIMAL(10,2)",
            )],
            expect: vec![CellValue {
                column: "total".into(),
                kind: ValueKind::Number,
                type_name: "DECIMAL(10,2)".into(),
                value: Some("250.00".into()),
            }],
        }],
        deletes: vec![RowDelete {
            key: vec![number("id", "3")],
            expect: Vec::new(),
        }],
        inserts: vec![new_row("10", "2026-04-01"), new_row("11", "2026-04-02")],
        ..UpdatePlan::default()
    };
    let steps = edit::steps(K, &plan).unwrap();
    run(&mut db, crate::db::begin_statement(K));
    for step in &steps {
        let done = bound(&mut db, &step.built.sql, &step.built.params);
        assert_eq!(
            done.rows_affected,
            Some(step.rows as u64),
            "{}",
            step.built.sql
        );
    }
    run(&mut db, "COMMIT");
    assert_eq!(
        rows(&run(&mut db, "SELECT id, total FROM orders ORDER BY id")),
        json!([[1, "260.75"], [2, "40.50"], [10, null], [11, null]])
    );
    // the lock: the total is no longer 250
    let stale = edit::steps(
        K,
        &UpdatePlan {
            deletes: Vec::new(),
            inserts: Vec::new(),
            ..plan
        },
    )
    .unwrap();
    assert_eq!(
        bound(&mut db, &stale[0].built.sql, &stale[0].built.params).rows_affected,
        Some(0)
    );
}

#[test]
fn a_text_is_found_in_rows_and_definitions() {
    use find::{Columns, FindEvent, FindSpec, Mode};
    let mut db = shop("find");
    let spec = |text: &str, mode: Mode, case_sensitive: bool| FindSpec {
        text: text.into(),
        mode,
        case_sensitive,
        columns: Columns::Text,
        schemas: vec!["main".into()],
        tables: Vec::new(),
        data: true,
        sources: true,
        names: false,
        max_hits: 20,
        table_timeout_ms: 5_000,
        skip_rows_over: 0,
    };
    let found = |db: &mut Duck, spec: &FindSpec| -> Vec<String> {
        let events = std::sync::Mutex::new(Vec::new());
        find::find(
            db,
            K,
            spec,
            None,
            &|e| events.lock().unwrap().push(e),
            &|| false,
        )
        .unwrap();
        let mut lines: Vec<String> = events
            .into_inner()
            .unwrap()
            .into_iter()
            .flat_map(|e| match e {
                FindEvent::Rows { table, hits, .. } => hits
                    .into_iter()
                    .map(|h| format!("row {table}.{}: {}", h.column, h.preview))
                    .collect::<Vec<_>>(),
                FindEvent::Source { hit } => vec![format!("{} {}", hit.kind, hit.name)],
                _ => Vec::new(),
            })
            .collect();
        lines.sort();
        lines.dedup();
        lines
    };
    assert_eq!(
        found(&mut db, &spec("100% ferrari_x", Mode::Contains, false)),
        ["row customer.name: Bruno 100% Ferrari_x"]
    );
    assert!(found(&mut db, &spec("100% ferrari_x", Mode::Contains, true)).is_empty());
    assert_eq!(found(&mut db, &spec("^Ada L", Mode::Regex, true)).len(), 1);
    assert_eq!(
        found(&mut db, &spec("ada lindqvist", Mode::Exact, false)).len(),
        1
    );
    let sources = found(&mut db, &spec("total", Mode::Contains, false));
    assert!(
        sources.iter().any(|l| l == "view open_orders"),
        "{sources:?}"
    );
    assert!(sources.iter().any(|l| l == "table orders"), "{sources:?}");
}

#[test]
fn what_is_not_there_for_duckdb_says_so() {
    let mut db = shop("not-yet");
    let stop = &|| false;
    assert_eq!(
        crate::db::plan::explain(&mut db, K, "SELECT 1", false, None, stop)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert_eq!(
        crate::db::monitor::activity(&mut db, K, stop)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert_eq!(
        crate::db::access::principals(&mut db, K, stop)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert!(crate::db::compare::snapshot(&mut db, K, "main", stop).is_err());
    let caps = crate::db::capabilities(K, crate::db::Flavor::Plain);
    assert_eq!(caps.product, "DuckDB");
    assert!(caps.cancel && caps.foreign_keys && caps.schemas);
    assert!(!caps.plan && !caps.monitor && !caps.access && !caps.structure && !caps.triggers);
    assert!(K.is_file() && !profile("x", MEMORY).uses_password());
}

#[test]
fn reads_what_the_database_said_about_an_error() {
    let caret = duckdb::Error::DuckDBFailure(
        duckdb::ffi::Error::new(1),
        Some("Parser Error: syntax error at or near \"t\"\n\nLINE 1: select * frm t\n                     ^".into()),
    );
    let e = failed(&caret);
    assert_eq!(e.message, "Parser Error: syntax error at or near \"t\"");
    let d = e.details.unwrap();
    assert_eq!(
        (d.sqlstate.as_deref(), d.line, d.position),
        (Some("Parser"), Some(1), Some(14))
    );
    assert_eq!(
        interval(14, 3, 3_723_500_000_000),
        "1 year 2 months 3 days 01:02:03.5"
    );
    assert_eq!(interval(0, 0, 0), "00:00:00");
    assert!(tx_after("-- x\nBEGIN; insert into t values (1)", false));
    assert!(!tx_after("begin; commit", false));
    assert!(tx_after("select 1", true));
    assert!(!tx_after("/* c */ ROLLBACK", true));
}
