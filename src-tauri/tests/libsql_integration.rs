//! libSQL against a real server (prompt 035g). Ignored by default: needs the container of
//! `scripts/db-test-servers.sh up` (`sqld` over HTTP on 127.0.0.1:28090, no login). Run with
//! `pnpm rust:test:db`.

use schema_commander_lib::db::edit::{self, UpdatePlan};
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

const K: DbKind = DbKind::Libsql;

fn profile() -> Profile {
    Profile {
        id: "t".into(),
        name: "Test".into(),
        kind: K,
        host: "127.0.0.1".into(),
        port: 28090,
        database: String::new(),
        user: String::new(),
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

fn script(s: &mut Box<dyn Session>, statements: &[&str]) {
    for sql in statements {
        run(s, sql);
    }
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

/// Tables of a test's own (`p` in their names): the tests may run side by side.
fn shop(s: &mut Box<dyn Session>, p: &str) {
    unshop(s, p);
    script(
        s,
        &[
            &format!(
                "CREATE TABLE {p}_customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT DEFAULT 'DE', note TEXT)"
            ),
            &format!(
                "CREATE TABLE {p}_order (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES {p}_customer (id), placed_at DATE, total DECIMAL(10,2), \"select\" TEXT)"
            ),
            &format!("CREATE INDEX {p}_order_customer ON {p}_order (customer_id)"),
            &format!("CREATE VIEW {p}_big AS SELECT id, total FROM {p}_order WHERE total > 100"),
            &format!(
                "CREATE TRIGGER {p}_touch AFTER UPDATE ON {p}_customer BEGIN UPDATE {p}_customer SET note = 'touched' WHERE id = NEW.id AND NEW.name = 'trigger'; END"
            ),
            &format!(
                "INSERT INTO {p}_customer (id, name, country) VALUES (1, 'Ada Lindqvist', 'SE'), (2, 'Bruno 100% Ferrari_x', 'IT')"
            ),
            &format!(
                "INSERT INTO {p}_order (id, customer_id, placed_at, total, \"select\") VALUES (1, 1, '2026-01-10', 250, ''), (2, 1, '2026-02-11', 40.5, 'x'), (3, 2, '2026-03-12', NULL, NULL)"
            ),
        ],
    );
}

fn unshop(s: &mut Box<dyn Session>, p: &str) {
    script(
        s,
        &[
            &format!("DROP VIEW IF EXISTS {p}_big"),
            &format!("DROP TABLE IF EXISTS {p}_order"),
            &format!("DROP TABLE IF EXISTS {p}_customer"),
        ],
    );
}

#[test]
#[ignore]
fn libsql_types_unicode_null_and_bound_values() {
    let mut s = open();
    let stop = &|| false;
    assert!(
        s.server_version(stop)
            .unwrap()
            .starts_with("libSQL (SQLite 3.")
    );
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    let caps = capabilities(K, s.flavor());
    assert_eq!(caps.product, "libSQL");
    assert!(caps.edit && caps.plan && !caps.schemas && !caps.cancel);
    let r = run(
        &mut s,
        "SELECT 42 AS i, 9223372036854775807 AS big, 1.5 AS f, 'Grüße 🚀 小林' AS t, NULL AS nul, '' AS empty, \
         x'00ff10' AS bin, -5 AS small",
    );
    assert_eq!(
        rows(&r)[0],
        json!([42, "9223372036854775807", 1.5, "Grüße 🚀 小林", null, "", {"bytes": 3, "hex": "00ff10"}, -5])
    );
    script(
        &mut s,
        &[
            "DROP TABLE IF EXISTS sc_l_types",
            "CREATE TABLE sc_l_types (id INTEGER PRIMARY KEY, name VARCHAR(20), price DECIMAL(10,2), ok BOOLEAN, day DATE, raw BLOB, doc JSON)",
        ],
    );
    let evil = "'; DROP TABLE sc_l_types; --";
    let inserted = bound(
        &mut s,
        "INSERT INTO sc_l_types (id, name, price, ok, day) VALUES (?1, ?2, ?3, ?4, ?5)",
        &[
            Bind::Int("7".into()),
            Bind::Text(evil.into()),
            Bind::Decimal("12.5".into()),
            Bind::Bool(true),
            Bind::Date("2026-11-11".into()),
        ],
    );
    assert_eq!(inserted.rows_affected, Some(1));
    assert!(inserted.columns.is_empty());
    let back = bound(
        &mut s,
        "SELECT * FROM sc_l_types WHERE name = ?1",
        &[Bind::Text(evil.into())],
    );
    let kinds: Vec<ColKind> = back.columns.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            ColKind::Int,
            ColKind::Text,
            ColKind::Decimal,
            ColKind::Bool,
            ColKind::Date,
            ColKind::Bytes,
            ColKind::Json
        ]
    );
    assert_eq!(
        rows(&back),
        json!([[7, evil, 12.5, 1, "2026-11-11", null, null]])
    );
    let empty = run(&mut s, "SELECT * FROM sc_l_types WHERE 0");
    assert_eq!(empty.columns.len(), 7);
    assert!(empty.rows.is_empty());
    // many rows arrive as a stream; a limit cuts them and the session goes on
    let many = run(
        &mut s,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000) SELECT i, 'row ' || i FROM n",
    );
    assert_eq!(many.rows.len(), 50_000);
    let cut = s
        .query(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000) SELECT i FROM n",
            Limits::rows(5),
            stop,
        )
        .unwrap();
    assert!(cut.truncated && cut.rows.len() == 5);
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
    // errors: where the server says so, and what it said
    let syntax = try_run(&mut s, "SELECT 1\n  FRM t x y").unwrap_err();
    assert_eq!(syntax.code, ErrorCode::InvalidQuery, "{}", syntax.message);
    assert_eq!(syntax.details.unwrap().line, Some(2));
    let unknown = try_run(&mut s, "SELECT * FROM sc_l_nope").unwrap_err();
    assert_eq!(unknown.code, ErrorCode::InvalidQuery);
    assert!(
        unknown.message.contains("no such table"),
        "{}",
        unknown.message
    );
    let twice = try_run(&mut s, "INSERT INTO sc_l_types (id) VALUES (7)").unwrap_err();
    assert!(
        twice.message.to_lowercase().contains("unique"),
        "{}",
        twice.message
    );
    assert!(try_run(&mut s, "SELECT 1; SELECT 2").is_err());
    assert_eq!(rows(&run(&mut s, "SELECT 2")), json!([[2]]));
    run(&mut s, "DROP TABLE sc_l_types");
}

#[test]
#[ignore]
fn a_transaction_outlives_the_idle_time_of_the_server() {
    let mut s = open();
    let mut other = open();
    let stop = &|| false;
    script(
        &mut s,
        &[
            "DROP TABLE IF EXISTS sc_l_tx",
            "CREATE TABLE sc_l_tx (id INTEGER PRIMARY KEY, n TEXT)",
        ],
    );
    run(&mut s, "BEGIN");
    assert_eq!(s.transaction_state(stop), TxState::Active);
    run(&mut s, "INSERT INTO sc_l_tx (n) VALUES ('held')");
    // the server drops a stream after ten idle seconds: the heartbeat keeps this one
    std::thread::sleep(Duration::from_secs(14));
    assert_eq!(s.transaction_state(stop), TxState::Active);
    assert_eq!(
        rows(&run(&mut other, "SELECT count(*) FROM sc_l_tx")),
        json!([[0]])
    );
    run(&mut s, "ROLLBACK");
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    assert_eq!(
        rows(&run(&mut s, "SELECT count(*) FROM sc_l_tx")),
        json!([[0]])
    );
    run(&mut s, "BEGIN");
    run(&mut s, "INSERT INTO sc_l_tx (n) VALUES ('kept')");
    run(&mut s, "COMMIT");
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    // without a transaction a stream may expire: the next statement opens a new one, unnoticed
    std::thread::sleep(Duration::from_secs(12));
    assert_eq!(
        rows(&run(&mut s, "SELECT n FROM sc_l_tx")),
        json!([["kept"]])
    );
    // an error inside a transaction leaves it open
    run(&mut s, "BEGIN");
    assert!(try_run(&mut s, "SELECT * FROM sc_l_nope").is_err());
    assert_eq!(s.transaction_state(stop), TxState::Active);
    // also one the server cannot even read
    let typo = try_run(&mut s, "SELEC 1").unwrap_err();
    assert_eq!(typo.code, ErrorCode::InvalidQuery, "{}", typo.message);
    assert_eq!(s.transaction_state(stop), TxState::Active);
    run(&mut s, "ROLLBACK");
    // a session that goes takes its transaction along
    let mut gone = open();
    run(&mut gone, "BEGIN");
    run(&mut gone, "INSERT INTO sc_l_tx (n) VALUES ('lost')");
    drop(gone);
    run(&mut s, "INSERT INTO sc_l_tx (n) VALUES ('after')");
    assert_eq!(
        rows(&run(&mut s, "SELECT count(*) FROM sc_l_tx")),
        json!([[2]])
    );
    run(&mut s, "DROP TABLE sc_l_tx");
}

#[test]
#[ignore]
fn a_statement_that_is_stopped_is_left_behind_and_the_session_goes_on() {
    const SLOW: &str = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000000000) \
                        SELECT count(*) FROM n";
    let mut s = open();
    let stop = AtomicBool::new(false);
    let started = Instant::now();
    let r = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(400));
            stop.store(true, Ordering::Relaxed);
        });
        s.query(SLOW, Limits::rows(1), &|| stop.load(Ordering::Relaxed))
    });
    assert_eq!(r.unwrap_err().code, ErrorCode::Cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(3),
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
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(rows(&run(&mut s, "SELECT 2")), json!([[2]]));
}

#[test]
#[ignore]
fn libsql_refuses_what_is_not_there() {
    let mut closed = profile();
    closed.port = 28091;
    let e = connect(&closed, None, &|| false).err().unwrap();
    assert_eq!(e.code, ErrorCode::ConnectionFailed);
    // a token never crosses the wire in the clear to another machine
    let mut far = profile();
    far.host = "db.example.com".into();
    let e = connect(&far, Some(&Secret::new("hunter2")), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::InvalidProfile);
    assert!(!e.message.contains("hunter2"));
    let mut tls = profile();
    tls.tls = TlsMode::Verify;
    assert!(connect(&tls, None, &|| false).is_err());
    // what the server does not take, it says
    let mut s = open();
    assert!(try_run(&mut s, "ATTACH DATABASE 'x.db' AS x").is_err());
    assert!(try_run(&mut s, "SELECT load_extension('x')").is_err());
    assert_eq!(guard::read_only_statement(K), None);
    assert_eq!(rows(&run(&mut s, "SELECT 3")), json!([[3]]));
}

#[test]
#[ignore]
fn libsql_metadata_names_details_and_search() {
    use schema_commander_lib::db::details::details;
    let mut s = open();
    let p = "sc_lm";
    shop(&mut s, p);
    let stop = &|| false;
    let schemas = meta::schemas(s.as_mut(), K, stop).unwrap();
    assert!(schemas.iter().any(|x| x.name == "main" && x.current));
    let objects = meta::objects(s.as_mut(), K, "main", stop).unwrap();
    let mut named: Vec<String> = objects
        .iter()
        .filter(|o| o.name.starts_with("sc_lm_"))
        .map(|o| format!("{:?} {}", o.kind, o.name))
        .collect();
    named.sort();
    assert_eq!(
        named,
        [
            "Table sc_lm_customer",
            "Table sc_lm_order",
            "View sc_lm_big"
        ]
    );
    let t = meta::table(s.as_mut(), K, "main", "sc_lm_order", stop).unwrap();
    let columns: Vec<String> = t
        .columns
        .iter()
        .map(|c| format!("{} {} {} {}", c.quoted, c.type_name, c.nullable, c.key))
        .collect();
    assert_eq!(
        columns,
        [
            "id INTEGER true pk",
            "customer_id INTEGER false fk",
            "placed_at DATE true ",
            "total DECIMAL(10,2) true ",
            "\"select\" TEXT true "
        ]
    );
    assert!(t.indexes.iter().any(|i| i.name == "sc_lm_order_customer"));
    let customer = meta::table(s.as_mut(), K, "main", "sc_lm_customer", stop).unwrap();
    assert!(customer.triggers.iter().any(|t| t.name == "sc_lm_touch"));
    let found = meta::search(s.as_mut(), K, "LM_ORD", stop).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "sc_lm_order");

    let mut index = names::read_objects(s.as_mut(), K, stop).unwrap();
    let hits =
        |index: &names::NameIndex, q: &str| names::search(index, q, &Context::default(), K).hits;
    assert_eq!(hits(&index, "sc_lm_ord")[0].name, "sc_lm_order");
    names::read_columns(s.as_mut(), K, &mut index, stop).unwrap();
    assert_eq!(hits(&index, "c:sc_lm_order.cust")[0].name, "customer_id");

    let d = details(
        s.as_mut(),
        K,
        "main",
        "sc_lm_order",
        ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    assert!(d.notes.is_empty(), "{:?}", d.notes);
    assert_eq!(
        d.sections
            .iter()
            .find(|x| x.id == "columns")
            .unwrap()
            .rows
            .len(),
        5
    );
    let ddl = d.ddl.unwrap();
    assert!(ddl.contains("CREATE TABLE sc_lm_order"), "{ddl}");
    assert!(ddl.contains("CREATE INDEX sc_lm_order_customer"), "{ddl}");
    let view = details(
        s.as_mut(),
        K,
        "main",
        "sc_lm_big",
        ObjectKind::View,
        "",
        stop,
    )
    .unwrap();
    assert!(view.ddl.unwrap().contains("CREATE VIEW sc_lm_big"));

    let relations =
        schema_commander_lib::db::relations::relations(s.as_mut(), K, "main", "sc_lm_order", stop)
            .unwrap();
    assert_eq!(relations.outgoing.len(), 1);
    assert_eq!(relations.outgoing[0].ref_table, "sc_lm_customer");
    let incoming = schema_commander_lib::db::relations::relations(
        s.as_mut(),
        K,
        "main",
        "sc_lm_customer",
        stop,
    )
    .unwrap();
    assert_eq!(incoming.incoming.len(), 1);
    let diagram = schema_commander_lib::db::diagram::diagram(s.as_mut(), K, "main", stop).unwrap();
    assert!(diagram.tables.iter().any(|t| t.name == "sc_lm_order"));
    let snapshot =
        schema_commander_lib::db::compare::snapshot(s.as_mut(), K, "main", stop).unwrap();
    assert!(snapshot.tables.iter().any(|t| t.name == "sc_lm_order"));
    let plan = schema_commander_lib::db::plan::explain(
        s.as_mut(),
        K,
        "SELECT * FROM sc_lm_order WHERE customer_id = 1",
        false,
        None,
        stop,
    )
    .unwrap();
    assert!(!plan.nodes.is_empty());

    let spec = |text: &str, mode: Mode, case_sensitive: bool| FindSpec {
        text: text.into(),
        mode,
        case_sensitive,
        schemas: vec!["main".into()],
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
            .filter(|l| l.contains("sc_lm_"))
            .collect();
        lines.sort();
        lines.dedup();
        lines
    };
    assert_eq!(
        found(&mut s, &spec("100% ferrari_x", Mode::Contains, false)),
        ["row sc_lm_customer.name: Bruno 100% Ferrari_x"]
    );
    assert!(found(&mut s, &spec("100% ferrari_x", Mode::Contains, true)).is_empty());
    let sources = found(&mut s, &spec("total > 100", Mode::Contains, false));
    assert!(sources.iter().any(|l| l == "view sc_lm_big"), "{sources:?}");
    unshop(&mut s, p);
}

#[test]
#[ignore]
fn a_table_is_filtered_sorted_and_edited() {
    let mut s = open();
    let p = "sc_lf";
    shop(&mut s, p);
    let stop = &|| false;
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
            table: "sc_lf_order".into(),
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
        rows(&bound(&mut s, &q.sql, &q.params))[0][0],
        json!(2),
        "{}",
        q.sql
    );
    for (op, text, want) in [
        (Op::Contains, "100%", 1),
        (Op::ContainsNoCase, "100% f", 1),
        (Op::Contains, "_x", 1),
        (Op::Contains, "[", 0),
    ] {
        let like = filter::build(
            K,
            &TableQuery {
                table: "sc_lf_customer".into(),
                conditions: vec![condition("name", op, &[text], ValueKind::Text, "TEXT")],
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

    // a plan of the grid: delete, change (with the lock on what was read), insert – in a transaction
    let plan: UpdatePlan = serde_json::from_value(json!({
        "table": "sc_lf_customer",
        "rows": [{
            "key": [{"column": "id", "kind": "number", "value": "1"}],
            "set": [{"column": "name", "value": "Ada 🚀 O'Neil"}, {"column": "note", "value": null}],
            "expect": [{"column": "name", "value": "Ada Lindqvist"}],
        }],
        "inserts": [{"set": [{"column": "name", "value": "Cleo"}, {"column": "country", "default": true}]}],
        "returning": "id",
    }))
    .unwrap();
    let steps = edit::steps(K, &plan).unwrap();
    run(&mut s, "BEGIN");
    for step in &steps {
        let done = bound(&mut s, &step.built.sql, &step.built.params);
        if step.returns {
            assert_eq!(done.rows.len(), step.rows, "{}", step.built.sql);
        } else {
            assert_eq!(
                done.rows_affected,
                Some(step.rows as u64),
                "{}",
                step.built.sql
            );
        }
    }
    assert_eq!(s.transaction_state(stop), TxState::Active);
    run(&mut s, "COMMIT");
    assert_eq!(
        rows(&run(
            &mut s,
            "SELECT name, country, note FROM sc_lf_customer WHERE id IN (1, 3) ORDER BY id"
        )),
        json!([["Ada 🚀 O'Neil", "SE", null], ["Cleo", "DE", null]])
    );
    // the lock: what was read is no longer there, so nothing is changed
    let stale = edit::build(K, &plan).unwrap();
    assert_eq!(
        bound(&mut s, &stale[0].sql, &stale[0].params).rows_affected,
        Some(0)
    );
    // a foreign key holds on the server
    let orphan = try_run(&mut s, "DELETE FROM sc_lf_customer WHERE id = 1");
    assert!(orphan.is_err(), "{orphan:?}");
    unshop(&mut s, p);
}

/// What the review of 035g found (the numbers are its findings).
#[test]
#[ignore]
fn review_a_lost_transaction_is_said_and_a_cut_result_does_not_hang() {
    const ENDLESS: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x, hex(randomblob(100)) FROM c";
    let stop = &|| false;
    let mut s = open();
    // 1: a result without an end, cut at a limit, comes back at once and the session goes on
    let started = Instant::now();
    let cut = s.query(ENDLESS, Limits::rows(5), stop).unwrap();
    assert!(cut.truncated && cut.rows.len() == 5);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
    // 2: several statements in one text are a statement error
    let many = try_run(&mut s, "SELECT 1; SELECT 2").unwrap_err();
    assert_eq!(many.code, ErrorCode::InvalidQuery, "{}", many.message);

    script(
        &mut s,
        &[
            "DROP TABLE IF EXISTS sc_l_rv",
            "CREATE TABLE sc_l_rv (id INTEGER PRIMARY KEY, n TEXT)",
        ],
    );
    // 1: inside a transaction a cut result leaves it open
    run(&mut s, "BEGIN");
    run(&mut s, "INSERT INTO sc_l_rv (n) VALUES ('a'), ('b'), ('c')");
    let cut = s
        .query("SELECT * FROM sc_l_rv", Limits::rows(1), stop)
        .unwrap();
    assert!(cut.truncated);
    assert_eq!(s.transaction_state(stop), TxState::Active);
    // 2: a statement the server reads for `describe` but not at the cursor costs the transaction –
    // and says so
    let lost = try_run(&mut s, "VACUUM").unwrap_err();
    assert!(lost.message.contains("rolled back"), "{}", lost.message);
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    assert_eq!(
        rows(&run(&mut s, "SELECT count(*) FROM sc_l_rv")),
        json!([[0]])
    );
    // 4: a statement stopped inside a transaction: an error that says what it cost, not a quiet stop
    run(&mut s, "BEGIN");
    run(&mut s, "INSERT INTO sc_l_rv (n) VALUES ('held')");
    let stopped = s
        .query(ENDLESS, Limits::rows(MAX_ROWS), &|| true)
        .unwrap_err();
    assert_eq!(
        stopped.code,
        ErrorCode::ConnectionFailed,
        "{}",
        stopped.message
    );
    assert!(stopped.message.contains("rolled back"));
    // 3: asking for the state does not swallow anything, and the next statement runs
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    // the stream that was left behind holds its lock until the server drops it
    let mut other = open();
    let mut count = None;
    for _ in 0..40 {
        if let Ok(r) = try_run(&mut other, "SELECT count(*) FROM sc_l_rv") {
            count = Some(rows(&r));
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    assert_eq!(count, Some(json!([[0]])));
    // 10: the place of an error counts characters
    let e = try_run(&mut s, "select 'üüü' frm x y").unwrap_err();
    assert_eq!(e.details.unwrap().position, Some(19), "{}", e.message);
    let mut dropped = false;
    for _ in 0..60 {
        if try_run(&mut s, "DROP TABLE sc_l_rv").is_ok() {
            dropped = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    assert!(dropped);
}
