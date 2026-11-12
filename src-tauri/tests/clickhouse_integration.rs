//! ClickHouse against a real server (prompt 035d). Ignored by default: needs the container of
//! `scripts/db-test-servers.sh up` (HTTP on 127.0.0.1:28123, user and database `shop`). Run with
//! `pnpm rust:test:db`.

use schema_commander_lib::db::filter::{self, Condition, Op, Order, TableQuery, ValueKind};
use schema_commander_lib::db::find::{Columns, FindEvent, FindSpec, Mode, find};
use schema_commander_lib::db::meta::{self, ObjectKind};
use schema_commander_lib::db::names::{self, Context};
use schema_commander_lib::db::secrets::Secret;
use schema_commander_lib::db::value::{ColKind, MAX_ROWS, QueryResult, VecSink};
use schema_commander_lib::db::{
    Bind, DbKind, Limits, Profile, Session, TlsMode, TxState, connect, guard,
};
use schema_commander_lib::error::{AppError, ErrorCode};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const PW: &str = "Sc-test-003!";
const K: DbKind = DbKind::Clickhouse;

fn profile() -> Profile {
    Profile {
        id: "t".into(),
        name: "Test".into(),
        kind: K,
        host: "127.0.0.1".into(),
        port: 28123,
        database: "shop".into(),
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
    connect(&profile(), Some(&Secret::new(PW)), &|| false).unwrap()
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

fn bound(s: &mut Box<dyn Session>, sql: &str, params: &[Bind]) -> QueryResult {
    let mut sink = VecSink::new(MAX_ROWS);
    let outcome = s
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

const SHOP: &str = "
DROP VIEW IF EXISTS sc_c_big;
DROP TABLE IF EXISTS sc_c_order;
DROP TABLE IF EXISTS sc_c_customer;
CREATE TABLE sc_c_customer (id UInt32, name String, country LowCardinality(String) DEFAULT 'DE',
  note Nullable(String)) ENGINE = MergeTree ORDER BY id;
CREATE TABLE sc_c_order (id UInt64, customer_id UInt32, placed_at Date, total Nullable(Decimal(10, 2)),
  `select` String DEFAULT '') ENGINE = MergeTree ORDER BY (customer_id, id) PARTITION BY toYYYYMM(placed_at);
CREATE VIEW sc_c_big AS SELECT id, total FROM sc_c_order WHERE total > 100;
INSERT INTO sc_c_customer (id, name, country) VALUES (1, 'Ada Lindqvist', 'SE'), (2, 'Bruno 100% Ferrari_x', 'IT');
INSERT INTO sc_c_order (id, customer_id, placed_at, total) VALUES (1, 1, '2026-01-10', 250),
  (2, 1, '2026-02-11', 40.5), (3, 2, '2026-03-12', NULL);
";
const UNSHOP: &str = "DROP VIEW IF EXISTS sc_c_big; DROP TABLE IF EXISTS sc_c_order; DROP TABLE IF EXISTS sc_c_customer";

#[test]
#[ignore]
fn clickhouse_types_unicode_and_null() {
    let mut s = open();
    assert!(
        s.server_version(&|| false)
            .unwrap()
            .starts_with("ClickHouse 2")
    );
    assert_eq!(s.transaction_state(&|| false), TxState::Idle);
    let r = run(
        &mut s,
        "SELECT toInt32(42) AS i, toUInt64(18446744073709551615) AS big, toInt64(-5) AS small, \
         1.5 AS f, toDecimal64(12.5, 2) AS d, 'Grüße 🚀 小林' AS t, CAST(NULL AS Nullable(String)) AS nul, \
         '' AS empty, toDate('2024-02-29') AS dt, toDateTime64('2024-02-29 13:05:09.25', 3, 'UTC') AS ts, \
         [1, 2, 3] AS arr, map('k', 1) AS m, tuple(1, 'x') AS tp, \
         toUUID('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11') AS u, true AS b, \
         toLowCardinality('lc') AS lc, CAST('y' AS Enum8('x' = 1, 'y' = 2)) AS e, nan AS not_a_number",
    );
    let kinds: Vec<ColKind> = r.columns.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        vec![
            ColKind::Int,
            ColKind::Int,
            ColKind::Int,
            ColKind::Float,
            ColKind::Decimal,
            ColKind::Text,
            ColKind::Text,
            ColKind::Text,
            ColKind::Date,
            ColKind::Timestamp,
            ColKind::Other,
            ColKind::Other,
            ColKind::Other,
            ColKind::Uuid,
            ColKind::Bool,
            ColKind::Text,
            ColKind::Text,
            ColKind::Float,
        ]
    );
    assert_eq!(
        rows(&r)[0],
        json!([
            42,
            "18446744073709551615",
            -5,
            1.5,
            "12.5",
            "Grüße 🚀 小林",
            null,
            "",
            "2024-02-29",
            "2024-02-29 13:05:09.250",
            "[1,2,3]",
            "{'k':1}",
            "(1,'x')",
            "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
            true,
            "lc",
            "y",
            "NaN"
        ])
    );
    assert_eq!(r.columns[4].type_name, "Decimal(18, 2)");
}

#[test]
#[ignore]
fn clickhouse_changes_scripts_limits_and_errors() {
    let mut s = open();
    // several statements in one text: one request each, the last one answers
    let last = run(
        &mut s,
        &format!("{SHOP} SELECT count() FROM sc_c_order; -- done"),
    );
    assert_eq!(rows(&last), json!([[3]]));
    let inserted = run(
        &mut s,
        "INSERT INTO sc_c_customer (id, name) VALUES (3, 'it\\'s; fine'), (4, 'd')",
    );
    assert_eq!(inserted.rows_affected, Some(2));
    assert_eq!(
        rows(&run(
            &mut s,
            "SELECT name, country FROM sc_c_customer WHERE id = 3"
        )),
        json!([["it's; fine", "DE"]])
    );
    let empty = run(&mut s, "SELECT * FROM sc_c_customer WHERE 0");
    assert_eq!(empty.columns.len(), 4);
    assert!(empty.rows.is_empty());
    assert_eq!(
        run(
            &mut s,
            "CREATE TABLE IF NOT EXISTS sc_c_customer (id UInt8) ENGINE = Memory"
        )
        .rows_affected,
        None
    );
    let cut = s
        .query(
            "SELECT number FROM numbers(100000)",
            Limits::rows(5),
            &|| false,
        )
        .unwrap();
    assert!(cut.truncated && cut.rows.len() == 5);
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
    // a setting of the session stays with it
    run(&mut s, "SET max_threads = 3");
    assert_eq!(
        rows(&run(&mut s, "SELECT toString(getSetting('max_threads'))")),
        json!([["3"]])
    );

    let syntax = try_run(&mut s, "SELECT * FRM sc_c_order").unwrap_err();
    assert_eq!(syntax.code, ErrorCode::InvalidQuery);
    let d = syntax.details.unwrap();
    assert_eq!(d.sqlstate.as_deref(), Some("62 SYNTAX_ERROR"));
    assert_eq!(d.position, Some(14), "{}", syntax.message);
    let unknown = try_run(&mut s, "SELECT nme FROM sc_c_customer").unwrap_err();
    assert!(unknown.message.contains("nme"), "{}", unknown.message);
    assert!(!unknown.message.contains("version"));
    // an error after the result has begun is an error, not a row
    let late = try_run(
        &mut s,
        "SELECT throwIf(number = 70000, 'boom') FROM numbers(100000) SETTINGS max_block_size = 1000",
    );
    assert!(late.is_err(), "{late:?}");
    assert!(try_run(&mut s, "BEGIN TRANSACTION").is_err());
    run(&mut s, UNSHOP);
}

#[test]
#[ignore]
fn clickhouse_refuses_a_wrong_password_and_an_unknown_database() {
    let e = connect(&profile(), Some(&Secret::new("nope")), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::AuthFailed);
    assert!(!e.message.contains("nope"));
    let mut p = profile();
    p.database = "no_such_db".into();
    let e = connect(&p, Some(&Secret::new(PW)), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::NotFound, "{}", e.message);
    let mut closed = profile();
    closed.port = 28124;
    let e = connect(&closed, Some(&Secret::new(PW)), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::ConnectionFailed);
    // TLS against a server that speaks none
    let mut tls = profile();
    tls.tls = TlsMode::Verify;
    assert!(connect(&tls, Some(&Secret::new(PW)), &|| false).is_err());
}

#[test]
#[ignore]
fn a_statement_stops_or_runs_out_of_time_and_the_session_goes_on() {
    let mut s = open();
    let stop = AtomicBool::new(false);
    let started = Instant::now();
    let r = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(400));
            stop.store(true, Ordering::Relaxed);
        });
        s.query(
            "SELECT count() FROM numbers(100000000000) WHERE sipHash64(number) % 7 = 3",
            Limits::rows(1),
            &|| stop.load(Ordering::Relaxed),
        )
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
        "SELECT count() FROM numbers(100000000000) WHERE sipHash64(number) % 7 = 3",
        Limits {
            max_rows: 1,
            timeout: Some(Duration::from_secs(1)),
        },
        &|| false,
    );
    assert_eq!(late.unwrap_err().code, ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(8));
    assert_eq!(rows(&run(&mut s, "SELECT 2")), json!([[2]]));
}

#[test]
#[ignore]
fn clickhouse_binds_values_and_a_read_only_session_cannot_write() {
    let mut s = open();
    run(&mut s, SHOP);
    let evil = "'; DROP TABLE sc_c_customer; --";
    let inserted = bound(
        &mut s,
        "INSERT INTO sc_c_customer (id, name, note) VALUES ({p1:Int64}, {p2:String}, {p3:String})",
        &[
            Bind::Int("7".into()),
            Bind::Text(evil.into()),
            Bind::Text("a \\ b".into()),
        ],
    );
    assert_eq!(inserted.rows_affected, Some(1));
    let found = bound(
        &mut s,
        "SELECT id, note FROM sc_c_customer WHERE name = {p1:String}",
        &[Bind::Text(evil.into())],
    );
    assert_eq!(rows(&found), json!([[7, "a \\ b"]]));
    // review 035d 1: the server reads a parameter in its escaped form – a backslash, a tab and a line
    // break arrive as they were given
    let odd = "C:\\temp\ta\nb \\N";
    let back = bound(
        &mut s,
        "SELECT {p1:String} AS v, length({p1:String})",
        &[Bind::Text(odd.into())],
    );
    assert_eq!(rows(&back), json!([[odd, odd.len()]]));
    // review 035d 3: bytes that are no text do not end the query
    let binary = run(&mut s, "SELECT unhex('FF00FF') AS b, 1 AS one");
    assert_eq!(rows(&binary)[0][1], json!(1));
    // review 035d 2: a name with a backslash and a backtick stays one name
    let name = "sc_c x\\`; DROP TABLE sc_c_customer; --";
    let quoted = meta::quote(name, K);
    run(
        &mut s,
        &format!("CREATE TABLE {quoted} (id UInt8) ENGINE = Memory"),
    );
    assert_eq!(
        rows(&bound(
            &mut s,
            "SELECT count() FROM system.tables WHERE database = 'shop' AND name = {p1:String}",
            &[Bind::Text(name.into())]
        )),
        json!([[1]])
    );
    run(&mut s, &format!("DROP TABLE {quoted}"));
    assert_eq!(
        rows(&run(&mut s, "SELECT count() FROM sc_c_customer")),
        json!([[3]])
    );
    let typed = bound(
        &mut s,
        "SELECT id FROM sc_c_order WHERE placed_at >= {p1:String} AND total > {p2:String} AND customer_id = {p3:Int64} AND {p4:Bool}",
        &[
            Bind::Date("2026-01-01".into()),
            Bind::Decimal("100.5".into()),
            Bind::Int("1".into()),
            Bind::Bool(true),
        ],
    );
    assert_eq!(rows(&typed), json!([[1]]));
    let asked = s
        .ask(
            "SELECT name, toString(id) FROM sc_c_customer WHERE name = {p1:String}",
            &[evil],
            None,
            &|| false,
        )
        .unwrap();
    assert_eq!(
        asked,
        vec![vec![Some(evil.to_owned()), Some("7".to_owned())]]
    );

    // read only: set once for the session of the server, and nothing takes it back
    let mut reader = open();
    run(&mut reader, guard::read_only_statement(K).unwrap());
    assert_eq!(
        rows(&run(&mut reader, "SELECT count() FROM sc_c_customer")),
        json!([[3]])
    );
    let refused = try_run(
        &mut reader,
        "INSERT INTO sc_c_customer (id, name) VALUES (9, 'x')",
    )
    .unwrap_err();
    assert_eq!(
        refused.code,
        ErrorCode::PermissionDenied,
        "{}",
        refused.message
    );
    assert!(try_run(&mut reader, "SET readonly = 0").is_err());
    assert!(try_run(&mut reader, "DROP TABLE sc_c_customer").is_err());
    // the app's own questions run in that session too
    assert!(reader.ask("SELECT 1", &[], None, &|| false).is_ok());
    run(&mut s, UNSHOP);
}

#[test]
#[ignore]
fn clickhouse_metadata_names_details_and_search() {
    use schema_commander_lib::db::details::details;
    let mut s = open();
    run(&mut s, SHOP);
    let stop = &|| false;
    let schemas = meta::schemas(s.as_mut(), K, stop).unwrap();
    let mine = schemas.iter().find(|x| x.name == "shop").unwrap();
    assert!(mine.current && !mine.system);
    assert!(schemas.iter().find(|x| x.name == "system").unwrap().system);
    let objects = meta::objects(s.as_mut(), K, "shop", stop).unwrap();
    let named: Vec<String> = objects
        .iter()
        .filter(|o| o.name.starts_with("sc_c_"))
        .map(|o| format!("{:?} {} {}", o.kind, o.name, o.detail))
        .collect();
    assert_eq!(
        named,
        [
            "Table sc_c_customer MergeTree",
            "Table sc_c_order MergeTree",
            "View sc_c_big View"
        ]
    );
    assert_eq!(
        objects
            .iter()
            .find(|o| o.name == "sc_c_order")
            .unwrap()
            .rows,
        Some(3)
    );
    let t = meta::table(s.as_mut(), K, "shop", "sc_c_order", stop).unwrap();
    let columns: Vec<String> = t
        .columns
        .iter()
        .map(|c| format!("{} {} {} {}", c.quoted, c.type_name, c.nullable, c.key))
        .collect();
    assert_eq!(
        columns,
        [
            "id UInt64 false pk",
            "customer_id UInt32 false pk",
            "placed_at Date false ",
            "total Nullable(Decimal(10, 2)) true ",
            "`select` String false "
        ]
    );
    assert_eq!(t.columns[4].default.as_deref(), Some("''"));
    let keys: Vec<String> = t
        .keys
        .iter()
        .map(|k| format!("{} {}", k.name, k.detail))
        .collect();
    assert!(
        keys.iter().any(|k| k == "ORDER BY customer_id, id"),
        "{keys:?}"
    );
    assert!(
        keys.iter().any(|k| k.starts_with("PARTITION BY toYYYYMM")),
        "{keys:?}"
    );
    let found = meta::search(s.as_mut(), K, "C_ORD", stop).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(
        (found[0].schema.as_str(), found[0].name.as_str()),
        ("shop", "sc_c_order")
    );

    let mut index = names::read_objects(s.as_mut(), K, stop).unwrap();
    let hits =
        |index: &names::NameIndex, q: &str| names::search(index, q, &Context::default(), K).hits;
    assert_eq!(hits(&index, "sc_c_ord")[0].name, "sc_c_order");
    assert!(hits(&index, "query_log").is_empty());
    names::read_columns(s.as_mut(), K, &mut index, stop).unwrap();
    assert_eq!(hits(&index, "c:sc_c_order.cust")[0].name, "customer_id");

    // no foreign keys, a diagram of tables without lines
    let r =
        schema_commander_lib::db::relations::relations(s.as_mut(), K, "shop", "sc_c_order", stop)
            .unwrap();
    assert!(r.outgoing.is_empty() && r.incoming.is_empty());
    let d = schema_commander_lib::db::diagram::diagram(s.as_mut(), K, "shop", stop).unwrap();
    assert!(d.tables.iter().any(|t| t.name == "sc_c_order") && d.keys.is_empty());
    assert!(d.tables.iter().all(|t| t.name != "sc_c_big"));

    let about = details(
        s.as_mut(),
        K,
        "shop",
        "sc_c_order",
        ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    let section = |id: &str| {
        about
            .sections
            .iter()
            .find(|x| x.id == id)
            .unwrap_or_else(|| panic!("{id}: {:?}", about.notes))
    };
    assert_eq!(section("columns").rows.len(), 5);
    assert!(
        section("stats")
            .rows
            .iter()
            .any(|r| r[0].as_deref() == Some("sorted by"))
    );
    let ddl = about.ddl.unwrap();
    assert!(ddl.starts_with("CREATE TABLE shop.sc_c_order"), "{ddl}");
    assert!(
        ddl.contains("ENGINE = MergeTree") && ddl.ends_with(";\n"),
        "{ddl}"
    );
    let view = details(
        s.as_mut(),
        K,
        "shop",
        "sc_c_big",
        ObjectKind::View,
        "",
        stop,
    )
    .unwrap();
    assert!(view.ddl.unwrap().starts_with("CREATE VIEW shop.sc_c_big"));
    assert!(
        details(
            s.as_mut(),
            K,
            "shop",
            "sc_c_nope",
            ObjectKind::Table,
            "",
            stop
        )
        .unwrap()
        .ddl
        .is_none()
    );
    // the statement builds the table again
    run(&mut s, "DROP VIEW sc_c_big");
    run(&mut s, "DROP TABLE sc_c_order");
    run(&mut s, &ddl);
    assert_eq!(
        meta::table(s.as_mut(), K, "shop", "sc_c_order", stop)
            .unwrap()
            .columns
            .len(),
        5
    );

    // search on the server
    run(
        &mut s,
        "INSERT INTO sc_c_order (id, customer_id, placed_at, total) VALUES (1, 1, '2026-01-10', 250)",
    );
    let spec = |text: &str, mode: Mode, case_sensitive: bool| FindSpec {
        text: text.into(),
        mode,
        case_sensitive,
        columns: Columns::Text,
        schemas: vec!["shop".into()],
        tables: Vec::new(),
        data: true,
        sources: true,
        names: false,
        max_hits: 20,
        table_timeout_ms: 5_000,
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
            .filter(|l| l.contains("sc_c_"))
            .collect();
        lines.sort();
        lines.dedup();
        lines
    };
    assert_eq!(
        found(&mut s, &spec("100% ferrari_x", Mode::Contains, false)),
        ["row sc_c_customer.name: Bruno 100% Ferrari_x"]
    );
    assert!(found(&mut s, &spec("100% ferrari_x", Mode::Contains, true)).is_empty());
    assert_eq!(found(&mut s, &spec("^ada l", Mode::Regex, false)).len(), 1);
    assert!(found(&mut s, &spec("^ada l", Mode::Regex, true)).is_empty());
    assert_eq!(
        found(&mut s, &spec("ada lindqvist", Mode::Exact, false)).len(),
        1
    );
    let sources = found(&mut s, &spec("toYYYYMM", Mode::Contains, false));
    assert!(
        sources.iter().any(|l| l == "table sc_c_order"),
        "{sources:?}"
    );
    run(&mut s, UNSHOP);
}

#[test]
#[ignore]
fn a_table_is_filtered_and_sorted_but_not_edited() {
    use schema_commander_lib::db::edit::{self, RowInsert, UpdatePlan};
    let mut s = open();
    run(&mut s, SHOP);
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
            table: "sc_c_order".into(),
            conditions: vec![
                condition(
                    "placed_at",
                    Op::Ge,
                    &["2026-02-01"],
                    ValueKind::Text,
                    "Date",
                ),
                condition("customer_id", Op::Eq, &["1"], ValueKind::Number, "UInt32"),
                condition(
                    "total",
                    Op::Lt,
                    &["100.5"],
                    ValueKind::Number,
                    "Nullable(Decimal(10, 2))",
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
        "SELECT *\nFROM shop.sc_c_order\nWHERE placed_at >= {p1:String}\n  AND customer_id = {p2:Int64}\n  AND total < {p3:String}\nORDER BY `select` DESC NULLS LAST\nLIMIT 10"
    );
    assert_eq!(rows(&bound(&mut s, &q.sql, &q.params))[0][0], json!(2));
    // „contains“ without LIKE: its wildcards are plain characters
    for (op, text, want) in [
        (Op::Contains, "100%", 1),
        (Op::Contains, "100% f", 0),
        (Op::ContainsNoCase, "100% f", 1),
        (Op::Contains, "_x", 1),
        (Op::Contains, "%", 1),
    ] {
        let like = filter::build(
            K,
            &TableQuery {
                table: "sc_c_customer".into(),
                conditions: vec![condition("name", op, &[text], ValueKind::Text, "String")],
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
            table: "sc_c_order".into(),
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
                table: "sc_c_order".into(),
                where_sql: Some(text.into()),
                ..TableQuery::default()
            },
        )
    };
    assert!(free("total > 100").is_ok());
    assert!(free("total > {p1:String}").is_err());
    // a backslash escapes there: this is one string …
    assert!(free("name = 'a\\' OR 1=1) --'").is_ok());
    // … and this one ends early, with a comment behind it
    assert!(free("name = 'a\\\\' OR 1=1) --'").is_err());

    // what the app does not offer for ClickHouse says so
    let plan = UpdatePlan {
        table: "sc_c_order".into(),
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
    run(&mut s, UNSHOP);
}
