//! Trino against a real server (prompt 035f). Ignored by default: needs the container of
//! `scripts/db-test-servers.sh up` (HTTP on 127.0.0.1:28080, no login; catalogs `memory` and `tpch`).
//! Run with `pnpm rust:test:db`.

use schema_commander_lib::db::filter::{self, Condition, Op, Order, TableQuery, ValueKind};
use schema_commander_lib::db::find::{Columns, FindEvent, FindSpec, Mode, find};
use schema_commander_lib::db::meta::{self, ObjectKind};
use schema_commander_lib::db::names::{self, Context};
use schema_commander_lib::db::secrets::Secret;
use schema_commander_lib::db::value::{ColKind, MAX_ROWS, QueryResult, VecSink};
use schema_commander_lib::db::{
    Bind, DbKind, Limits, Profile, Session, TlsMode, TxState, capabilities, connect, guard,
};
use schema_commander_lib::error::{AppError, ErrorCode};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const K: DbKind = DbKind::Trino;

fn profile() -> Profile {
    Profile {
        id: "t".into(),
        name: "Test".into(),
        kind: K,
        host: "127.0.0.1".into(),
        port: 28080,
        database: "memory".into(),
        user: "shop".into(),
        tls: TlsMode::Off,
        folder: String::new(),
        color: 1,
        save_password: false,
        protection: guard::Protection::Free,
        label: String::new(),
        ca_file: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        ssh: None,
    }
}

fn open() -> Box<dyn Session> {
    connect(&profile(), None, &|| false).unwrap()
}

fn try_run(s: &mut Box<dyn Session>, sql: &str) -> Result<QueryResult, AppError> {
    s.query(sql, Limits::rows(MAX_ROWS), &|| false)
}

fn run(s: &mut Box<dyn Session>, sql: &str) -> QueryResult {
    try_run(s, sql).unwrap_or_else(|e| panic!("{sql}: {e}"))
}

fn rows(r: &QueryResult) -> Value {
    serde_json::to_value(&r.rows).unwrap()
}

fn try_bound(
    s: &mut Box<dyn Session>,
    sql: &str,
    params: &[Bind],
) -> Result<QueryResult, AppError> {
    let mut sink = VecSink::new(MAX_ROWS);
    let outcome = s.execute_bound(sql, params, Limits::rows(MAX_ROWS), &mut sink, &|| false)?;
    Ok(QueryResult {
        columns: outcome.columns,
        rows: sink.rows,
        truncated: outcome.truncated,
        rows_affected: outcome.rows_affected,
        elapsed_ms: outcome.elapsed_ms,
    })
}

fn bound(s: &mut Box<dyn Session>, sql: &str, params: &[Bind]) -> QueryResult {
    try_bound(s, sql, params).unwrap_or_else(|e| panic!("{sql}: {e}"))
}

/// Every test has tables of its own (`{p}` in their names): the tests may run side by side.
fn shop(p: &str) -> String {
    format!(
        "
CREATE SCHEMA IF NOT EXISTS memory.shop;
DROP VIEW IF EXISTS memory.shop.{p}_big;
DROP TABLE IF EXISTS memory.shop.{p}_order;
DROP TABLE IF EXISTS memory.shop.{p}_customer;
CREATE TABLE memory.shop.{p}_customer (id integer NOT NULL, name varchar, country varchar(2), note varchar);
CREATE TABLE memory.shop.{p}_order (id bigint, customer_id integer, placed_at date, total decimal(10, 2),
  \"select\" varchar);
CREATE VIEW memory.shop.{p}_big AS SELECT id, total FROM memory.shop.{p}_order WHERE total > 100;
INSERT INTO memory.shop.{p}_customer (id, name, country) VALUES (1, 'Ada Lindqvist', 'SE'), (2, 'Bruno 100% Ferrari_x', 'IT');
INSERT INTO memory.shop.{p}_order (id, customer_id, placed_at, total, \"select\") VALUES
  (1, 1, DATE '2026-01-10', 250, ''), (2, 1, DATE '2026-02-11', 40.5, 'x'), (3, 2, DATE '2026-03-12', NULL, NULL);
"
    )
}

fn unshop(p: &str) -> String {
    format!(
        "DROP VIEW IF EXISTS memory.shop.{p}_big; DROP TABLE IF EXISTS memory.shop.{p}_order; \
         DROP TABLE IF EXISTS memory.shop.{p}_customer"
    )
}

#[test]
#[ignore]
fn trino_types_unicode_and_null() {
    let mut s = open();
    assert!(s.server_version(&|| false).unwrap().starts_with("Trino 4"));
    assert_eq!(s.transaction_state(&|| false), TxState::Idle);
    let caps = capabilities(K, s.flavor());
    assert_eq!(caps.product, "Trino");
    let r = run(
        &mut s,
        "SELECT 42 AS i, 9223372036854775807 AS big, DOUBLE '1.5' AS f, CAST(12.5 AS decimal(10, 2)) AS d, \
         'Grüße 🚀 小林' AS t, CAST(NULL AS varchar) AS nul, '' AS empty, DATE '2024-02-29' AS dt, \
         TIMESTAMP '2024-02-29 13:05:09.250' AS ts, TIMESTAMP '2024-02-29 13:05:09.250 +01:00' AS tz, \
         ARRAY[1, 2, 3] AS arr, MAP(ARRAY['k'], ARRAY[1]) AS m, ROW(1, 'x') AS tp, \
         UUID 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AS u, true AS b, X'00ff10' AS bin, nan() AS not_a_number, \
         TIME '13:05:09' AS tm, JSON '{\"a\":[1,2]}' AS j, CAST('ab' AS char(4)) AS c, \
         CAST(12345678901234567890123456789.123456789 AS decimal(38, 9)) AS wide, \
         INTERVAL '2' DAY AS iv, REAL '0.5' AS rl, TINYINT '-5' AS tiny",
    );
    let kinds: Vec<ColKind> = r.columns.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        vec![
            ColKind::Int,
            ColKind::Int,
            ColKind::Float,
            ColKind::Decimal,
            ColKind::Text,
            ColKind::Text,
            ColKind::Text,
            ColKind::Date,
            ColKind::Timestamp,
            ColKind::TimestampTz,
            ColKind::Json,
            ColKind::Json,
            ColKind::Json,
            ColKind::Uuid,
            ColKind::Bool,
            ColKind::Bytes,
            ColKind::Float,
            ColKind::Time,
            ColKind::Json,
            ColKind::Text,
            ColKind::Decimal,
            ColKind::Other,
            ColKind::Float,
            ColKind::Int,
        ]
    );
    let row = &rows(&r)[0];
    assert_eq!(row[0], json!(42));
    // beyond what a JSON number holds exactly: as text
    assert_eq!(row[1], json!("9223372036854775807"));
    assert_eq!(row[2], json!(1.5));
    assert_eq!(row[3], json!("12.50"));
    assert_eq!(row[4], json!("Grüße 🚀 小林"));
    assert_eq!(row[5], Value::Null);
    assert_eq!(row[6], json!(""));
    assert_eq!(row[7], json!("2024-02-29"));
    assert!(row[8].as_str().unwrap().starts_with("2024-02-29"), "{row}");
    assert!(row[9].as_str().unwrap().contains("+01:00"), "{row}");
    assert_eq!(row[10], json!("[1,2,3]"));
    assert_eq!(row[11], json!("{\"k\":1}"));
    assert_eq!(row[12], json!("[1,\"x\"]"));
    assert_eq!(row[13], json!("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"));
    assert_eq!(row[14], json!(true));
    assert_eq!(row[19], json!("ab  "));
    assert_eq!(row[20], json!("12345678901234567890123456789.123456789"));
    assert_eq!(row[23], json!(-5));
    assert_eq!(r.columns[3].type_name, "decimal(10, 2)");
}

#[test]
#[ignore]
fn trino_changes_scripts_limits_and_errors() {
    let mut s = open();
    let p = "sc_a";
    // several statements in one text: one request each, the last one answers
    let last = run(
        &mut s,
        &format!(
            "{} SELECT count(*) FROM memory.shop.{p}_order; -- done",
            shop(p)
        ),
    );
    assert_eq!(rows(&last), json!([[3]]));
    let inserted = run(
        &mut s,
        &format!(
            "INSERT INTO memory.shop.{p}_customer (id, name) VALUES (3, 'it''s; fine'), (4, 'd')"
        ),
    );
    assert_eq!(inserted.rows_affected, Some(2));
    assert!(inserted.columns.is_empty() && inserted.rows.is_empty());
    assert_eq!(
        rows(&run(
            &mut s,
            &format!("SELECT name, country FROM memory.shop.{p}_customer WHERE id = 3")
        )),
        json!([["it's; fine", null]])
    );
    let empty = run(
        &mut s,
        &format!("SELECT * FROM memory.shop.{p}_customer WHERE false"),
    );
    assert_eq!(empty.columns.len(), 4);
    assert!(empty.rows.is_empty());
    assert_eq!(
        run(
            &mut s,
            &format!("CREATE TABLE IF NOT EXISTS memory.shop.{p}_customer (id integer)")
        )
        .rows_affected,
        None
    );
    // many rows come in pages; a limit ends the statement on the server
    let many = run(&mut s, "SELECT orderkey FROM tpch.tiny.orders");
    assert_eq!(many.rows.len(), 15_000);
    let cut = s
        .query(
            "SELECT orderkey FROM tpch.sf1.lineitem",
            Limits::rows(5),
            &|| false,
        )
        .unwrap();
    assert!(cut.truncated && cut.rows.len() == 5);
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
    // what the server says the session is stays with it: schema, properties, prepared statements
    run(&mut s, "USE memory.shop");
    assert_eq!(
        rows(&run(&mut s, &format!("SELECT count(*) FROM {p}_order"))),
        json!([[3]])
    );
    run(&mut s, "SET SESSION query_max_run_time = '17m'");
    let shown = run(&mut s, "SHOW SESSION LIKE 'query_max_run_time'");
    assert_eq!(rows(&shown)[0][1], json!("17m"));
    run(&mut s, "RESET SESSION query_max_run_time");
    let shown = run(&mut s, "SHOW SESSION LIKE 'query_max_run_time'");
    assert_ne!(rows(&shown)[0][1], json!("17m"));
    run(
        &mut s,
        &format!("PREPARE mine FROM SELECT name FROM {p}_customer WHERE id = ?"),
    );
    assert_eq!(
        rows(&run(&mut s, "EXECUTE mine USING 1")),
        json!([["Ada Lindqvist"]])
    );
    run(&mut s, "DEALLOCATE PREPARE mine");
    assert!(try_run(&mut s, "EXECUTE mine USING 1").is_err());

    let syntax = try_run(&mut s, "SELECT * FRM t").unwrap_err();
    assert_eq!(syntax.code, ErrorCode::InvalidQuery);
    let d = syntax.details.unwrap();
    assert_eq!(d.sqlstate.as_deref(), Some("1 SYNTAX_ERROR"));
    assert_eq!(
        (d.line, d.position),
        (Some(1), Some(10)),
        "{}",
        syntax.message
    );
    // in a text of several statements the place counts from the start of the whole text
    let second = try_run(&mut s, "SELECT 1;\nSELECT 'ü'\n  FROM nope").unwrap_err();
    let d = second.details.unwrap();
    assert_eq!(d.line, Some(3), "{}", second.message);
    assert_eq!(d.position, Some(10 + 11 + 8), "{}", second.message);
    // an error after the result has begun is an error, not a row
    let late = try_run(
        &mut s,
        "SELECT CASE WHEN orderkey = 59975 THEN fail('boom') ELSE orderkey END FROM tpch.tiny.orders",
    );
    assert!(late.unwrap_err().message.contains("boom"));
    assert_eq!(rows(&run(&mut s, "SELECT 2")), json!([[2]]));
    run(&mut s, &unshop(p));
}

#[test]
#[ignore]
fn a_transaction_is_what_the_server_says() {
    let mut s = open();
    let stop = &|| false;
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    run(&mut s, "START TRANSACTION");
    assert_eq!(s.transaction_state(stop), TxState::Active);
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
    run(&mut s, "COMMIT");
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    run(&mut s, "START TRANSACTION");
    run(&mut s, "ROLLBACK");
    assert_eq!(s.transaction_state(stop), TxState::Idle);
}

#[test]
#[ignore]
fn trino_refuses_an_unknown_catalog_and_a_password_in_the_clear() {
    let mut p = profile();
    p.database = "no_such_catalog".into();
    let e = connect(&p, None, &|| false).err().unwrap();
    assert_eq!(e.code, ErrorCode::NotFound, "{}", e.message);
    let mut p = profile();
    p.database = String::new();
    let e = connect(&p, None, &|| false).err().unwrap();
    assert_eq!(e.code, ErrorCode::InvalidProfile);
    // a password never crosses the wire without TLS
    let e = connect(&profile(), Some(&Secret::new("hunter2")), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::InvalidProfile);
    assert!(!e.message.contains("hunter2"));
    let mut closed = profile();
    closed.port = 28081;
    let e = connect(&closed, None, &|| false).err().unwrap();
    assert_eq!(e.code, ErrorCode::ConnectionFailed);
    // TLS against a server that speaks none
    let mut tls = profile();
    tls.tls = TlsMode::Verify;
    assert!(connect(&tls, Some(&Secret::new("x")), &|| false).is_err());
}

#[test]
#[ignore]
fn a_statement_stops_or_runs_out_of_time_and_the_session_goes_on() {
    const SLOW: &str = "SELECT count(*) FROM tpch.sf100.lineitem a, tpch.sf100.lineitem b \
                        WHERE a.comment < b.comment";
    let mut s = open();
    let stop = AtomicBool::new(false);
    let started = Instant::now();
    let r = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(600));
            stop.store(true, Ordering::Relaxed);
        });
        s.query(SLOW, Limits::rows(1), &|| stop.load(Ordering::Relaxed))
    });
    assert_eq!(r.unwrap_err().code, ErrorCode::Cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "{:?}",
        started.elapsed()
    );
    assert!(s.is_open());
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
    let started = Instant::now();
    let late = s.query(
        SLOW,
        Limits {
            max_rows: 1,
            timeout: Some(Duration::from_secs(1)),
        },
        &|| false,
    );
    assert_eq!(late.unwrap_err().code, ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(8));
    assert_eq!(rows(&run(&mut s, "SELECT 2")), json!([[2]]));
    // nothing of ours is left running on the server
    std::thread::sleep(Duration::from_millis(1500));
    let left = run(
        &mut s,
        "SELECT count(*) FROM system.runtime.queries \
         WHERE state = 'RUNNING' AND query LIKE '%tpch.sf100.lineitem a,%' AND query NOT LIKE '%runtime%'",
    );
    assert_eq!(rows(&left), json!([[0]]));
}

#[test]
#[ignore]
fn trino_binds_values_and_a_read_only_session_cannot_write() {
    let mut s = open();
    let p = "sc_b";
    run(&mut s, &shop(p));
    let evil = "'; DROP TABLE memory.shop.sc_b_customer; --";
    let inserted = bound(
        &mut s,
        &format!("INSERT INTO memory.shop.{p}_customer (id, name, note) VALUES (?, ?, ?)"),
        &[
            Bind::Int("7".into()),
            Bind::Text(evil.into()),
            Bind::Text("C:\\temp\ta\nb 🚀 \\'".into()),
        ],
    );
    assert_eq!(inserted.rows_affected, Some(1));
    let back = bound(
        &mut s,
        &format!("SELECT name, note FROM memory.shop.{p}_customer WHERE id = ? AND name = ?"),
        &[Bind::Int("7".into()), Bind::Text(evil.into())],
    );
    assert_eq!(rows(&back), json!([[evil, "C:\\temp\ta\nb 🚀 \\'"]]));
    let typed = bound(
        &mut s,
        &format!(
            "SELECT id FROM memory.shop.{p}_order WHERE placed_at >= ? AND total < ? AND ? ORDER BY id"
        ),
        &[
            Bind::Date("2026-02-01".into()),
            Bind::Decimal("100.5".into()),
            Bind::Bool(true),
        ],
    );
    assert_eq!(rows(&typed), json!([[2]]));
    let when = bound(
        &mut s,
        "SELECT ? < TIMESTAMP '2027-01-01 00:00:00'",
        &[Bind::Datetime("2026-11-12 08:30:00".into())],
    );
    assert_eq!(rows(&when), json!([[true]]));
    // a value that is not what it says never reaches the server
    let bad = try_bound(
        &mut s,
        "SELECT ?",
        &[Bind::Decimal("1); DROP TABLE x; --".into())],
    );
    assert_eq!(bad.unwrap_err().code, ErrorCode::InvalidQuery);
    // the app's own questions bind text
    let asked = s
        .ask(
            "SELECT ?, length(?)",
            &["it's", "a\\b"],
            Some(Duration::from_secs(10)),
            &|| false,
        )
        .unwrap();
    assert_eq!(
        asked,
        vec![vec![Some("it's".to_owned()), Some("3".to_owned())]]
    );

    // read only: the statement the guard names, then nothing writes – whatever the session is told
    let mut reader = open();
    run(&mut reader, guard::read_only_statement(K).unwrap());
    assert_eq!(reader.transaction_state(&|| false), TxState::Idle);
    assert_eq!(
        rows(&run(
            &mut reader,
            &format!("SELECT count(*) FROM memory.shop.{p}_customer")
        )),
        json!([[3]])
    );
    let insert = format!("INSERT INTO memory.shop.{p}_customer (id) VALUES (99)");
    for attempt in [
        insert.clone(),
        format!("ROLLBACK; {insert}"),
        format!("COMMIT; {insert}"),
        format!("COMMIT; START TRANSACTION READ WRITE; {insert}"),
        format!("CREATE TABLE memory.shop.{p}_new (a integer)"),
        format!("DROP TABLE memory.shop.{p}_customer"),
    ] {
        let e = try_run(&mut reader, &attempt).unwrap_err();
        assert!(
            matches!(
                e.code,
                ErrorCode::PermissionDenied | ErrorCode::InvalidQuery
            ),
            "{attempt}: {e}"
        );
    }
    // and it still reads, also after the errors
    assert_eq!(
        rows(&run(
            &mut reader,
            &format!("SELECT count(*) FROM memory.shop.{p}_customer")
        )),
        json!([[3]])
    );
    let asked = reader
        .ask("SELECT ?", &["x"], Some(Duration::from_secs(10)), &|| false)
        .unwrap();
    assert_eq!(asked, vec![vec![Some("x".to_owned())]]);
    run(&mut s, &unshop(p));
}

#[test]
#[ignore]
fn trino_metadata_names_details_and_search() {
    use schema_commander_lib::db::details::details;
    let mut s = open();
    let p = "sc_m";
    run(&mut s, &shop(p));
    let stop = &|| false;
    let schemas = meta::schemas(s.as_mut(), K, stop).unwrap();
    let mine = schemas.iter().find(|x| x.name == "shop").unwrap();
    assert!(!mine.system);
    assert!(
        schemas
            .iter()
            .find(|x| x.name == "information_schema")
            .unwrap()
            .system
    );
    let objects = meta::objects(s.as_mut(), K, "shop", stop).unwrap();
    let mut named: Vec<String> = objects
        .iter()
        .filter(|o| o.name.starts_with("sc_m_"))
        .map(|o| format!("{:?} {}", o.kind, o.name))
        .collect();
    named.sort();
    assert_eq!(
        named,
        ["Table sc_m_customer", "Table sc_m_order", "View sc_m_big"]
    );
    let t = meta::table(s.as_mut(), K, "shop", "sc_m_order", stop).unwrap();
    let columns: Vec<String> = t
        .columns
        .iter()
        .map(|c| format!("{} {} {}", c.quoted, c.type_name, c.nullable))
        .collect();
    assert_eq!(
        columns,
        [
            "id bigint true",
            "customer_id integer true",
            "placed_at date true",
            "total decimal(10,2) true",
            "\"select\" varchar true"
        ]
    );
    let customer = meta::table(s.as_mut(), K, "shop", "sc_m_customer", stop).unwrap();
    assert!(!customer.columns[0].nullable);
    let found = meta::search(s.as_mut(), K, "M_ORD", stop).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(
        (found[0].schema.as_str(), found[0].name.as_str()),
        ("shop", "sc_m_order")
    );
    // wildcards of LIKE are plain characters in a search for a name
    assert!(
        meta::search(s.as_mut(), K, "m%ord", stop)
            .unwrap()
            .is_empty()
    );
    assert!(meta::search(s.as_mut(), K, "[", stop).unwrap().is_empty());

    let mut index = names::read_objects(s.as_mut(), K, stop).unwrap();
    let hits =
        |index: &names::NameIndex, q: &str| names::search(index, q, &Context::default(), K).hits;
    assert_eq!(hits(&index, "sc_m_ord")[0].name, "sc_m_order");
    names::read_columns(s.as_mut(), K, &mut index, stop).unwrap();
    assert_eq!(hits(&index, "c:sc_m_order.cust")[0].name, "customer_id");

    let d = details(
        s.as_mut(),
        K,
        "shop",
        "sc_m_order",
        ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    let columns = d.sections.iter().find(|x| x.id == "columns").unwrap();
    assert_eq!(columns.rows.len(), 5);
    let ddl = d.ddl.unwrap();
    assert!(
        ddl.starts_with("CREATE TABLE memory.shop.sc_m_order ("),
        "{ddl}"
    );
    assert!(ddl.contains("\"select\" varchar"), "{ddl}");
    // the statement the server wrote is one it takes
    run(&mut s, "DROP TABLE memory.shop.sc_m_order");
    run(&mut s, ddl.trim_end().trim_end_matches(';'));
    let view = details(
        s.as_mut(),
        K,
        "shop",
        "sc_m_big",
        ObjectKind::View,
        "",
        stop,
    )
    .unwrap();
    assert!(
        view.ddl
            .unwrap()
            .contains("CREATE VIEW memory.shop.sc_m_big")
    );
    // a name that needs quotes, with a quote in it
    run(
        &mut s,
        "CREATE TABLE memory.shop.\"sc_m \"\"odd\"\" name\" (\"a b\" integer)",
    );
    let odd = details(
        s.as_mut(),
        K,
        "shop",
        "sc_m \"odd\" name",
        ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    assert!(odd.ddl.unwrap().contains("\"a b\" integer"));
    run(&mut s, "DROP TABLE memory.shop.\"sc_m \"\"odd\"\" name\"");
    run(
        &mut s,
        "INSERT INTO memory.shop.sc_m_order (id, customer_id, placed_at, total) VALUES \
         (1, 1, DATE '2026-01-10', 250)",
    );

    let spec = |text: &str, mode: Mode, case_sensitive: bool| FindSpec {
        text: text.into(),
        mode,
        case_sensitive,
        schemas: vec!["shop".into()],
        tables: Vec::new(),
        columns: Columns::Text,
        data: true,
        sources: true,
        names: false,
        max_hits: 20,
        table_timeout_ms: 20_000,
        skip_rows_over: 0,
    };
    let found = |s: &mut Box<dyn Session>, spec: &FindSpec| -> Vec<String> {
        let events = std::sync::Mutex::new(Vec::new());
        find(
            s.as_mut(),
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
            .filter(|l| l.contains("sc_m_"))
            .collect();
        lines.sort();
        lines.dedup();
        lines
    };
    assert_eq!(
        found(&mut s, &spec("100% ferrari_x", Mode::Contains, false)),
        ["row sc_m_customer.name: Bruno 100% Ferrari_x"]
    );
    assert!(found(&mut s, &spec("100% ferrari_x", Mode::Contains, true)).is_empty());
    assert_eq!(found(&mut s, &spec("^ada l", Mode::Regex, false)).len(), 1);
    assert!(found(&mut s, &spec("^ada l", Mode::Regex, true)).is_empty());
    assert_eq!(
        found(&mut s, &spec("ada lindqvist", Mode::Exact, false)).len(),
        1
    );
    let sources = found(&mut s, &spec("total > 100", Mode::Contains, false));
    assert!(sources.iter().any(|l| l == "view sc_m_big"), "{sources:?}");
    run(&mut s, &unshop(p));
}

#[test]
#[ignore]
fn a_table_is_filtered_and_sorted_but_not_edited() {
    use schema_commander_lib::db::edit::{self, RowInsert, UpdatePlan};
    let mut s = open();
    let p = "sc_f";
    run(&mut s, &shop(p));
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
            schema: Some("shop".into()),
            table: "sc_f_order".into(),
            conditions: vec![
                condition(
                    "placed_at",
                    Op::Ge,
                    &["2026-02-01"],
                    ValueKind::Text,
                    "date",
                ),
                condition("customer_id", Op::Eq, &["1"], ValueKind::Number, "integer"),
                condition(
                    "total",
                    Op::Lt,
                    &["100.5"],
                    ValueKind::Number,
                    "decimal(10,2)",
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
        rows(&bound(&mut s, &q.sql, &q.params))[0][0],
        json!(2),
        "{}",
        q.sql
    );
    // all rows, NULLs where they are asked to be
    let sorted = filter::build(
        K,
        &TableQuery {
            schema: Some("shop".into()),
            table: "sc_f_order".into(),
            order: vec![Order {
                column: "total".into(),
                desc: false,
                nulls: Some(filter::Nulls::First),
            }],
            ..TableQuery::default()
        },
    )
    .unwrap();
    let ids: Vec<Value> = rows(&bound(&mut s, &sorted.sql, &sorted.params))
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r[0].clone())
        .collect();
    assert_eq!(ids, [json!(3), json!(2), json!(1)]);
    // „contains“ without LIKE: its wildcards are plain characters
    for (op, text, want) in [
        (Op::Contains, "100%", 1),
        (Op::Contains, "100% f", 0),
        (Op::ContainsNoCase, "100% f", 1),
        (Op::Contains, "_x", 1),
        (Op::Contains, "%", 1),
        (Op::Contains, "[", 0),
    ] {
        let like = filter::build(
            K,
            &TableQuery {
                schema: Some("shop".into()),
                table: "sc_f_customer".into(),
                conditions: vec![condition("name", op, &[text], ValueKind::Text, "varchar")],
                ..TableQuery::default()
            },
        )
        .unwrap();
        assert_eq!(
            bound(&mut s, &like.sql, &like.params).rows.len(),
            want,
            "{text}"
        );
    }
    let count = filter::build(
        K,
        &TableQuery {
            schema: Some("shop".into()),
            table: "sc_f_order".into(),
            count: true,
            ..TableQuery::default()
        },
    )
    .unwrap();
    assert_eq!(
        rows(&bound(&mut s, &count.sql, &count.params)),
        json!([[3]])
    );
    // the free condition takes no placeholder
    let free = |text: &str| {
        filter::build(
            K,
            &TableQuery {
                schema: Some("shop".into()),
                table: "sc_f_order".into(),
                where_sql: Some(text.into()),
                ..TableQuery::default()
            },
        )
    };
    assert!(free("total > 100").is_ok());
    assert!(free("total > ?").is_err());
    // a backslash is a character there: this string ends at its quote, with a comment behind it
    assert!(free("name = 'a\\' OR 1=1) --'").is_err());

    // what the app does not offer for Trino says so
    let plan = UpdatePlan {
        table: "sc_f_order".into(),
        inserts: vec![RowInsert { set: Vec::new() }],
        ..UpdatePlan::default()
    };
    assert_eq!(
        edit::steps(K, &plan).unwrap_err().code,
        ErrorCode::Unsupported
    );
    assert_eq!(
        edit::build(K, &plan).unwrap_err().code,
        ErrorCode::Unsupported
    );
    let stop = &|| false;
    assert_eq!(
        schema_commander_lib::db::plan::explain(s.as_mut(), K, "SELECT 1", false, None, stop)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert_eq!(
        schema_commander_lib::db::monitor::activity(s.as_mut(), K, stop)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert_eq!(
        schema_commander_lib::db::access::principals(s.as_mut(), K, stop)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert!(schema_commander_lib::db::compare::snapshot(s.as_mut(), K, "shop", stop).is_err());
    assert!(
        schema_commander_lib::db::relations::relations(s.as_mut(), K, "shop", "sc_f_order", stop)
            .unwrap()
            .outgoing
            .is_empty()
    );
    let diagram = schema_commander_lib::db::diagram::diagram(s.as_mut(), K, "shop", stop).unwrap();
    assert!(diagram.tables.iter().any(|t| t.name == "sc_f_order"));
    run(&mut s, &unshop(p));
}

/// Presto speaks the same protocol with headers of its own. Only with `SC_DBTEST_PRESTO=1` (the
/// container `sc-dbtest-presto` on 127.0.0.1:28082; an image of about 3 GB).
#[test]
#[ignore]
fn presto_answers_like_trino() {
    if std::env::var("SC_DBTEST_PRESTO").as_deref() != Ok("1") {
        return;
    }
    let mut p = profile();
    p.port = 28082;
    p.database = "tpch".into();
    let mut s = connect(&p, None, &|| false).unwrap();
    let stop = &|| false;
    let version = s.server_version(stop).unwrap();
    assert!(version.starts_with("Presto 0."), "{version}");
    assert_eq!(capabilities(K, s.flavor()).product, "Presto");
    let r = run(
        &mut s,
        "SELECT 42 AS i, CAST(12.5 AS decimal(10, 2)) AS d, 'Grüße 🚀' AS t, CAST(NULL AS varchar) AS nul, \
         DATE '2024-02-29' AS dt, TIMESTAMP '2024-02-29 13:05:09.250' AS ts, ARRAY[1, 2] AS arr, true AS b, \
         X'00ff' AS bin",
    );
    let row = &rows(&r)[0];
    assert_eq!(row[0], json!(42));
    assert_eq!(row[1], json!("12.50"));
    assert_eq!(row[2], json!("Grüße 🚀"));
    assert_eq!(row[3], Value::Null);
    assert_eq!(row[4], json!("2024-02-29"));
    // Presto writes an array as JSON text of its own layout
    let array: Value = serde_json::from_str(row[6].as_str().unwrap()).unwrap();
    assert_eq!(array, json!([1, 2]));
    assert_eq!(row[7], json!(true));
    assert_eq!(r.columns[8].kind, ColKind::Bytes);
    // pages, a limit, values, an error with its place
    assert_eq!(
        run(&mut s, "SELECT orderkey FROM tpch.tiny.orders")
            .rows
            .len(),
        15_000
    );
    let cut = s
        .query(
            "SELECT orderkey FROM tpch.sf1.lineitem",
            Limits::rows(5),
            stop,
        )
        .unwrap();
    assert!(cut.truncated && cut.rows.len() == 5);
    let found = bound(
        &mut s,
        "SELECT name FROM tpch.tiny.nation WHERE nationkey = ? AND name <> ?",
        &[Bind::Int("7".into()), Bind::Text("it's".into())],
    );
    assert_eq!(rows(&found), json!([["GERMANY"]]));
    let e = try_run(&mut s, "SELECT * FRM t").unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidQuery);
    assert_eq!(e.details.unwrap().line, Some(1));
    // the session: schema and transaction as the server says
    run(&mut s, "USE tpch.tiny");
    assert_eq!(
        rows(&run(&mut s, "SELECT count(*) FROM region")),
        json!([[5]])
    );
    run(&mut s, "START TRANSACTION");
    assert_eq!(s.transaction_state(stop), TxState::Active);
    run(&mut s, "ROLLBACK");
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    // the tree
    let schemas = meta::schemas(s.as_mut(), K, stop).unwrap();
    assert!(schemas.iter().any(|x| x.name == "tiny"));
    let objects = meta::objects(s.as_mut(), K, "tiny", stop).unwrap();
    assert!(objects.iter().any(|o| o.name == "orders"));
    let t = meta::table(s.as_mut(), K, "tiny", "orders", stop).unwrap();
    assert_eq!(t.columns[0].name, "orderkey");
    // read only on the server
    let mut reader = connect(&p, None, &|| false).unwrap();
    run(&mut reader, guard::read_only_statement(K).unwrap());
    assert_eq!(rows(&run(&mut reader, "SELECT 1")), json!([[1]]));
    assert!(try_run(&mut reader, "CREATE TABLE memory.default.sc_p (a integer)").is_err());
    assert_eq!(rows(&run(&mut reader, "SELECT 2")), json!([[2]]));
}
