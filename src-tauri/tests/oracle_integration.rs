//! Oracle against a real server (prompt 035b). Ignored by default: needs the container of
//! `scripts/db-test-servers.sh up` (Oracle Database Free, service FREEPDB1, user SHOP). Run with
//! `pnpm rust:test:db`.

use schema_commander_lib::db::edit::{
    self, CellValue, RowDelete, RowInsert, RowUpdate, SetCell, UpdatePlan,
};
use schema_commander_lib::db::filter::{self, Condition, Op, Order, TableQuery, ValueKind};
use schema_commander_lib::db::find::{Columns, FindEvent, FindSpec, Mode, find};
use schema_commander_lib::db::meta::{self, ObjectKind};
use schema_commander_lib::db::names::{self, Context, NameKind};
use schema_commander_lib::db::relations::relations;
use schema_commander_lib::db::secrets::Secret;
use schema_commander_lib::db::value::{ColKind, MAX_ROWS, QueryResult, VecSink};
use schema_commander_lib::db::{
    Bind, DbKind, Flavor, Limits, Profile, Session, TlsMode, TxState, capabilities, connect,
};
use schema_commander_lib::error::{AppError, ErrorCode};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const PW: &str = "Sc-test-003!";
const K: DbKind = DbKind::Oracle;

fn profile(user: &str) -> Profile {
    Profile {
        id: "t".into(),
        name: "Test".into(),
        kind: K,
        host: "127.0.0.1".into(),
        port: 21521,
        database: "FREEPDB1".into(),
        user: user.into(),
        tls: TlsMode::Off,
        folder: String::new(),
        color: 1,
        save_password: false,
        protection: schema_commander_lib::db::guard::Protection::Free,
        label: String::new(),
        ca_file: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        ssh: None,
    }
}

fn open() -> Box<dyn Session> {
    connect(&profile("shop"), Some(&Secret::new(PW)), &|| false).unwrap()
}

fn try_run(s: &mut Box<dyn Session>, sql: &str) -> Result<QueryResult, AppError> {
    s.query(sql, Limits::rows(MAX_ROWS), &|| false)
}

fn run(s: &mut Box<dyn Session>, sql: &str) -> QueryResult {
    try_run(s, sql).unwrap_or_else(|e| panic!("{sql}: {e}"))
}

/// Drops what a test left behind; a table that is not there is no error.
fn drop_all(s: &mut Box<dyn Session>, statements: &[&str]) {
    for sql in statements {
        let _ = try_run(s, sql);
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

#[test]
#[ignore]
fn oracle_types_unicode_and_null() {
    let mut s = open();
    let version = s.server_version(&|| false).unwrap();
    assert!(version.contains("Oracle"), "{version}");
    assert_eq!(s.flavor(), Flavor::Plain);
    assert_eq!(capabilities(K, Flavor::Plain).product, "Oracle");
    let r = run(
        &mut s,
        "SELECT CAST(42 AS NUMBER(9)) AS i, CAST(9223372036854775807 AS NUMBER(19)) AS big, \
         CAST(1.5 AS BINARY_DOUBLE) AS f, 12345678901234567890.123456789 AS n, \
         CAST(12.50 AS NUMBER(10,2)) AS price, 'Grüße 🚀 小林' AS t, CAST(NULL AS VARCHAR2(10)) AS nul, \
         HEXTORAW('00FF10') AS bin, TIMESTAMP '2024-02-29 13:05:09.25' AS ts, \
         TIMESTAMP '2024-02-29 13:05:09 +02:00' AS tstz, DATE '2024-02-29' AS d, \
         INTERVAL '1 02:03:04.5' DAY TO SECOND AS iv, INTERVAL '2-3' YEAR TO MONTH AS ym, \
         TO_CLOB('a long text') AS c, TO_BLOB(HEXTORAW('CAFE')) AS b, \
         JSON('{\"a\":[1,2.5,\"x\",null,true]}') AS j, TRUE AS ok \
         FROM dual;",
    );
    let kinds: Vec<ColKind> = r.columns.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        vec![
            ColKind::Int,
            ColKind::Decimal,
            ColKind::Float,
            ColKind::Decimal,
            ColKind::Decimal,
            ColKind::Text,
            ColKind::Text,
            ColKind::Bytes,
            ColKind::Timestamp,
            ColKind::TimestampTz,
            ColKind::Timestamp,
            ColKind::Other,
            ColKind::Other,
            ColKind::Text,
            ColKind::Bytes,
            ColKind::Json,
            ColKind::Bool,
        ]
    );
    assert_eq!(
        rows(&r)[0],
        json!([
            42,
            "9223372036854775807",
            1.5,
            "12345678901234567890.123456789",
            "12.5",
            "Grüße 🚀 小林",
            null,
            { "bytes": 3, "hex": "00ff10" },
            "2024-02-29 13:05:09.250",
            "2024-02-29 11:05:09+00:00",
            "2024-02-29 00:00:00",
            "+1 02:03:04.5",
            "+2-3",
            "a long text",
            { "bytes": 2, "hex": "cafe" },
            "{\"a\":[1,2.5,\"x\",null,true]}",
            true
        ])
    );
    // an empty text is NULL in Oracle: that is the database, not the driver
    assert_eq!(rows(&run(&mut s, "SELECT '' FROM dual")), json!([[null]]));
}

#[test]
#[ignore]
fn oracle_changes_limits_and_errors_with_their_place() {
    let mut s = open();
    drop_all(&mut s, &["DROP TABLE sc_o_t PURGE"]);
    assert_eq!(
        run(
            &mut s,
            "CREATE TABLE sc_o_t (id NUMBER(9) PRIMARY KEY, name VARCHAR2(40))"
        )
        .rows_affected,
        None
    );
    assert_eq!(
        run(&mut s, "INSERT INTO sc_o_t VALUES (1, 'a')").rows_affected,
        Some(1)
    );
    assert_eq!(
        run(
            &mut s,
            "INSERT INTO sc_o_t SELECT LEVEL + 1, 'n' || LEVEL FROM dual CONNECT BY LEVEL <= 9"
        )
        .rows_affected,
        Some(9)
    );
    assert_eq!(
        run(&mut s, "UPDATE sc_o_t SET name = 'x' WHERE id > 100").rows_affected,
        Some(0)
    );
    let empty = run(&mut s, "SELECT * FROM sc_o_t WHERE 1 = 0");
    assert_eq!(empty.columns.len(), 2);
    assert!(empty.rows.is_empty());
    // a PL/SQL block keeps its semicolon; the `/` that ends it in a script is no part of it
    run(
        &mut s,
        "BEGIN\n  UPDATE sc_o_t SET name = 'block' WHERE id = 1;\nEND;\n/",
    );
    assert_eq!(
        rows(&run(&mut s, "SELECT name FROM sc_o_t WHERE id = 1")),
        json!([["block"]])
    );
    // a result is cut at the limit and the session goes on
    let cut = s
        .query(
            "SELECT id FROM sc_o_t ORDER BY id",
            Limits::rows(3),
            &|| false,
        )
        .unwrap();
    assert!(cut.truncated);
    assert_eq!(cut.rows.len(), 3);
    assert_eq!(
        rows(&run(&mut s, "SELECT COUNT(*) FROM sc_o_t")),
        json!([["10"]])
    );

    let unknown = try_run(&mut s, "SELECT id, nme FROM sc_o_t").unwrap_err();
    assert_eq!(unknown.code, ErrorCode::InvalidQuery);
    let d = unknown.details.unwrap();
    assert_eq!(d.sqlstate.as_deref(), Some("ORA-00904"));
    assert_eq!(d.position, Some(12), "{}", unknown.message);
    assert_eq!(d.near.as_deref(), Some("NME"));
    let syntax = try_run(&mut s, "SELECT * FRM sc_o_t").unwrap_err();
    assert_eq!(syntax.details.unwrap().position, Some(10));
    let block = try_run(&mut s, "BEGIN\n  x := 1;\nEND;").unwrap_err();
    let d = block.details.unwrap();
    assert_eq!(d.line, Some(2));
    assert!(block.message.contains("PLS-00201"), "{}", block.message);
    let twice = try_run(&mut s, "INSERT INTO sc_o_t VALUES (1, 'again')").unwrap_err();
    assert_eq!(twice.code, ErrorCode::InvalidQuery);
    assert!(twice.message.contains("ORA-00001"), "{}", twice.message);
    assert_eq!(twice.details.unwrap().position, None);
    // the session survived all of that
    assert!(s.is_open());
    run(&mut s, "DROP TABLE sc_o_t PURGE");
}

#[test]
#[ignore]
fn oracle_refuses_a_wrong_password_and_an_unknown_service() {
    let wrong = connect(&profile("shop"), Some(&Secret::new("nope")), &|| false);
    let e = wrong.err().unwrap();
    assert_eq!(e.code, ErrorCode::AuthFailed);
    assert!(!e.message.contains("nope"));
    let mut p = profile("shop");
    p.database = "NO_SUCH_SERVICE".into();
    let e = connect(&p, Some(&Secret::new(PW)), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::NotFound, "{}", e.message);
    p.database = String::new();
    assert!(connect(&p, Some(&Secret::new(PW)), &|| false).is_err());
    let mut tls = profile("shop");
    tls.tls = TlsMode::Require;
    let e = connect(&tls, Some(&Secret::new(PW)), &|| false)
        .err()
        .unwrap();
    // refused as a profile, before anything is sent
    assert_eq!(e.code, ErrorCode::InvalidProfile);
}

#[test]
#[ignore]
fn a_stopped_or_late_statement_ends_soon_and_costs_the_session() {
    // stopped by the user
    let mut s = open();
    let stop = AtomicBool::new(false);
    let started = Instant::now();
    let r = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(400));
            stop.store(true, Ordering::Relaxed);
        });
        s.query(
            "BEGIN DBMS_SESSION.SLEEP(20); END;",
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
    // the driver cannot interrupt its call: the connection went with the statement
    assert!(!s.is_open());
    assert!(try_run(&mut s, "SELECT 1 FROM dual").is_err());
    assert!(!capabilities(K, Flavor::Plain).cancel);

    // out of time
    let mut s = open();
    let started = Instant::now();
    let late = s.query(
        "BEGIN DBMS_SESSION.SLEEP(20); END;",
        Limits {
            max_rows: 1,
            timeout: Some(Duration::from_millis(500)),
        },
        &|| false,
    );
    assert_eq!(late.unwrap_err().code, ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(8));
    assert!(!s.is_open());
}

#[test]
#[ignore]
fn what_ran_is_kept_unless_a_transaction_was_opened() {
    let mut a = open();
    let mut b = open();
    drop_all(&mut a, &["DROP TABLE sc_o_tx PURGE"]);
    run(&mut a, "CREATE TABLE sc_o_tx (id NUMBER(9))");
    let count = |s: &mut Box<dyn Session>| rows(&run(s, "SELECT COUNT(*) FROM sc_o_tx"));
    assert_eq!(a.transaction_state(&|| false), TxState::Idle);
    // without a transaction: the other session sees the row at once
    run(&mut a, "INSERT INTO sc_o_tx VALUES (1)");
    assert_eq!(a.transaction_state(&|| false), TxState::Idle);
    assert_eq!(count(&mut b), json!([["1"]]));
    // with one: only after the commit
    run(&mut a, schema_commander_lib::db::begin_statement(K));
    assert_eq!(a.transaction_state(&|| false), TxState::Active);
    run(&mut a, "INSERT INTO sc_o_tx VALUES (2)");
    run(&mut a, "SAVEPOINT sc_rows");
    run(&mut a, "INSERT INTO sc_o_tx VALUES (3)");
    run(&mut a, "ROLLBACK TO SAVEPOINT sc_rows");
    assert_eq!(a.transaction_state(&|| false), TxState::Active);
    assert_eq!(count(&mut b), json!([["1"]]));
    run(&mut a, "COMMIT");
    assert_eq!(a.transaction_state(&|| false), TxState::Idle);
    assert_eq!(count(&mut b), json!([["2"]]));
    // and a rollback takes it back
    run(&mut a, schema_commander_lib::db::begin_statement(K));
    run(&mut a, "DELETE FROM sc_o_tx");
    run(&mut a, "ROLLBACK");
    assert_eq!(count(&mut b), json!([["2"]]));
    // after the transaction, statements are kept again
    run(&mut a, "DELETE FROM sc_o_tx WHERE id = 2");
    assert_eq!(count(&mut b), json!([["1"]]));
    run(&mut a, "DROP TABLE sc_o_tx PURGE");
}

#[test]
#[ignore]
fn oracle_binds_values() {
    let mut s = open();
    drop_all(&mut s, &["DROP TABLE sc_o_bind PURGE"]);
    run(
        &mut s,
        "CREATE TABLE sc_o_bind (id NUMBER(9), name VARCHAR2(60), price NUMBER(12,4), ok NUMBER(1), \
         day DATE, at TIMESTAMP)",
    );
    let evil = "'; DROP TABLE sc_o_bind; --";
    let inserted = bound(
        &mut s,
        "INSERT INTO sc_o_bind VALUES (:1, :2, :3, :4, :5, :6)",
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
        &mut s,
        "SELECT id, price, ok, day, at FROM sc_o_bind WHERE name = :1 AND day = :2",
        &[Bind::Text(evil.into()), Bind::Date("2026-11-11".into())],
    );
    assert_eq!(
        rows(&found),
        json!([[
            7,
            "12345678.1234",
            1,
            "2026-11-11 00:00:00",
            "2026-11-11 12:30:00.500"
        ]])
    );
    // the app's own questions bind text
    let asked = s
        .ask(
            "SELECT name, TO_CHAR(id) FROM sc_o_bind WHERE name = :1",
            &[evil],
            None,
            &|| false,
        )
        .unwrap();
    assert_eq!(
        asked,
        vec![vec![Some(evil.to_owned()), Some("7".to_owned())]]
    );
    run(&mut s, "DROP TABLE sc_o_bind PURGE");
}

const SHOP: &[&str] = &[
    "CREATE TABLE sc_o_customer (id NUMBER(9) PRIMARY KEY, name VARCHAR2(40 CHAR) NOT NULL, \
       country CHAR(2) DEFAULT 'DE', note CLOB)",
    "CREATE TABLE sc_o_order (id NUMBER(9) GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, \
       customer_id NUMBER(9) NOT NULL, placed_at DATE NOT NULL, total NUMBER(10,2), \
       CONSTRAINT sc_o_order_customer FOREIGN KEY (customer_id) REFERENCES sc_o_customer (id), \
       CONSTRAINT sc_o_order_total CHECK (total >= 0))",
    "CREATE INDEX sc_o_order_placed ON sc_o_order (placed_at)",
    "CREATE VIEW sc_o_open AS SELECT o.id, c.name FROM sc_o_order o \
       JOIN sc_o_customer c ON c.id = o.customer_id WHERE o.total > 100",
    "CREATE SEQUENCE sc_o_seq START WITH 5",
    "CREATE OR REPLACE FUNCTION sc_o_twice (n IN NUMBER) RETURN NUMBER AS BEGIN RETURN n * 2; END;",
    "INSERT INTO sc_o_customer (id, name, country) VALUES (1, 'Ada Lindqvist', 'SE')",
    "INSERT INTO sc_o_customer (id, name, country) VALUES (2, 'Bruno 100% Ferrari_x', 'IT')",
    "INSERT INTO sc_o_order (customer_id, placed_at, total) VALUES (1, DATE '2026-01-10', 250)",
    "INSERT INTO sc_o_order (customer_id, placed_at, total) VALUES (1, DATE '2026-02-11', 40.5)",
    "INSERT INTO sc_o_order (customer_id, placed_at, total) VALUES (2, DATE '2026-03-12', NULL)",
];
const SHOP_NAMES: &[&str] = &[
    "SC_O_CUSTOMER",
    "SC_O_ORDER",
    "SC_O_OPEN",
    "SC_O_SEQ",
    "SC_O_TWICE",
];
const UNSHOP: &[&str] = &[
    "DROP VIEW sc_o_open",
    "DROP TABLE sc_o_order PURGE",
    "DROP TABLE sc_o_customer PURGE",
    "DROP SEQUENCE sc_o_seq",
    "DROP FUNCTION sc_o_twice",
];

fn shop(s: &mut Box<dyn Session>) {
    drop_all(s, UNSHOP);
    for sql in SHOP {
        run(s, sql);
    }
}

#[test]
#[ignore]
fn oracle_metadata_names_relations_and_diagram() {
    let mut s = open();
    shop(&mut s);
    let stop = &|| false;
    let schemas = meta::schemas(s.as_mut(), K, stop).unwrap();
    let mine = schemas.iter().find(|x| x.name == "SHOP").unwrap();
    assert!(mine.current && !mine.system);
    assert_eq!(mine.quoted, "SHOP");
    assert!(schemas.iter().find(|x| x.name == "SYS").unwrap().system);

    let objects = meta::objects(s.as_mut(), K, "SHOP", stop).unwrap();
    let of = |kind: ObjectKind| -> Vec<&str> {
        objects
            .iter()
            .filter(|o| o.kind == kind && SHOP_NAMES.contains(&o.name.as_str()))
            .map(|o| o.name.as_str())
            .collect()
    };
    assert_eq!(of(ObjectKind::Table), ["SC_O_CUSTOMER", "SC_O_ORDER"]);
    assert_eq!(of(ObjectKind::View), ["SC_O_OPEN"]);
    assert_eq!(of(ObjectKind::Sequence), ["SC_O_SEQ"]);
    assert_eq!(of(ObjectKind::Routine), ["SC_O_TWICE"]);

    let t = meta::table(s.as_mut(), K, "SHOP", "SC_O_ORDER", stop).unwrap();
    let columns: Vec<String> = t
        .columns
        .iter()
        .map(|c| format!("{} {} {} {}", c.name, c.type_name, c.nullable, c.key))
        .collect();
    assert_eq!(
        columns,
        [
            "ID NUMBER(9) false pk",
            "CUSTOMER_ID NUMBER(9) false fk",
            "PLACED_AT DATE false ",
            "TOTAL NUMBER(10, 2) true "
        ]
    );
    let keys: Vec<&str> = t.keys.iter().map(|k| k.detail.as_str()).collect();
    assert!(keys.contains(&"PRIMARY KEY (ID)"), "{keys:?}");
    assert!(
        keys.contains(&"FOREIGN KEY (CUSTOMER_ID) REFERENCES SHOP.SC_O_CUSTOMER (ID)"),
        "{keys:?}"
    );
    assert!(keys.contains(&"CHECK (total >= 0)"), "{keys:?}");
    // NOT NULL is no check of its own here
    assert!(keys.iter().all(|k| !k.contains("IS NOT NULL")), "{keys:?}");
    assert!(
        t.indexes
            .iter()
            .any(|i| i.name == "SC_O_ORDER_PLACED" && i.detail == "normal (PLACED_AT)"),
        "{:?}",
        t.indexes
    );
    let customer = meta::table(s.as_mut(), K, "SHOP", "SC_O_CUSTOMER", stop).unwrap();
    assert_eq!(customer.columns[1].type_name, "VARCHAR2(40 CHAR)");
    assert_eq!(customer.columns[2].default.as_deref(), Some("'DE'"));

    let found = meta::search(s.as_mut(), K, "sc_o_ord", stop).unwrap();
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(
        (found[0].schema.as_str(), found[0].name.as_str()),
        ("SHOP", "SC_O_ORDER")
    );

    // the name index
    let mut index = names::read_objects(s.as_mut(), K, stop).unwrap();
    let hits =
        |index: &names::NameIndex, q: &str| names::search(index, q, &Context::default(), K).hits;
    let tables = hits(&index, "sc_o_ord");
    assert_eq!(tables[0].name, "SC_O_ORDER", "{tables:?}");
    assert_eq!(tables[0].kind, NameKind::Table);
    assert_eq!(tables[0].schema, "SHOP");
    assert!(
        hits(&index, "f:sc_o_twice")
            .iter()
            .any(|h| h.kind == NameKind::Routine)
    );
    assert!(hits(&index, "DUAL").iter().all(|h| h.name != "DUAL"));
    names::read_columns(s.as_mut(), K, &mut index, stop).unwrap();
    let columns = hits(&index, "c:sc_o_order.cust");
    assert_eq!(columns[0].name, "CUSTOMER_ID", "{columns:?}");

    // foreign keys, both ways
    let r = relations(s.as_mut(), K, "SHOP", "SC_O_CUSTOMER", stop).unwrap();
    assert!(r.outgoing.is_empty());
    assert_eq!(r.incoming.len(), 1);
    let key = &r.incoming[0];
    assert_eq!(
        (
            key.table.as_str(),
            key.columns.as_slice(),
            key.ref_columns.as_slice()
        ),
        (
            "SC_O_ORDER",
            &["CUSTOMER_ID".to_owned()][..],
            &["ID".to_owned()][..]
        )
    );
    let r = relations(s.as_mut(), K, "SHOP", "SC_O_ORDER", stop).unwrap();
    assert_eq!(r.outgoing.len(), 1);

    let d = schema_commander_lib::db::diagram::diagram(s.as_mut(), K, "SHOP", stop).unwrap();
    let names: Vec<&str> = d
        .tables
        .iter()
        .filter(|t| SHOP_NAMES.contains(&t.name.as_str()))
        .map(|t| t.name.as_str())
        .collect();
    assert_eq!(names, ["SC_O_CUSTOMER", "SC_O_ORDER"]);
    assert!(d.keys.iter().any(|k| k.name == "SC_O_ORDER_CUSTOMER"));
    drop_all(&mut s, UNSHOP);
}

#[test]
#[ignore]
fn oracle_details_and_ddl_round_trip() {
    use schema_commander_lib::db::details::details;
    let mut s = open();
    shop(&mut s);
    let stop = &|| false;
    let d = details(
        s.as_mut(),
        K,
        "SHOP",
        "SC_O_ORDER",
        ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    let section = |id: &str| {
        d.sections
            .iter()
            .find(|x| x.id == id)
            .unwrap_or_else(|| panic!("{id}: {:?}", d.notes))
    };
    assert_eq!(section("columns").rows.len(), 4);
    assert_eq!(section("columns").rows[0][5].as_deref(), Some("identity"));
    assert_eq!(
        section("references").rows[0][3].as_deref(),
        Some("SC_O_CUSTOMER")
    );
    let constraints = &section("constraints").rows;
    assert!(
        constraints
            .iter()
            .any(|r| r[1].as_deref() == Some("CHECK") && r[2].as_deref() == Some("total >= 0")),
        "{constraints:?}"
    );
    assert!(
        constraints
            .iter()
            .all(|r| !r[2].clone().unwrap_or_default().contains("IS NOT NULL"))
    );
    let ddl = d.ddl.clone().expect("the DDL of a table");
    assert!(
        ddl.contains("CREATE TABLE \"SHOP\".\"SC_O_ORDER\""),
        "{ddl}"
    );
    assert!(
        !ddl.contains("TABLESPACE") && !ddl.contains("PCTFREE"),
        "{ddl}"
    );
    assert!(ddl.contains("SC_O_ORDER_PLACED"), "{ddl}");
    let referenced = details(
        s.as_mut(),
        K,
        "SHOP",
        "SC_O_CUSTOMER",
        ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    let by = referenced
        .sections
        .iter()
        .find(|x| x.id == "referencedBy")
        .unwrap();
    assert_eq!(by.rows[0][2].as_deref(), Some("SC_O_ORDER"));

    let view = details(
        s.as_mut(),
        K,
        "SHOP",
        "SC_O_OPEN",
        ObjectKind::View,
        "",
        stop,
    )
    .unwrap();
    assert!(view.ddl.unwrap().contains("VIEW \"SHOP\".\"SC_O_OPEN\""));
    let routine = details(
        s.as_mut(),
        K,
        "SHOP",
        "SC_O_TWICE",
        ObjectKind::Routine,
        "",
        stop,
    )
    .unwrap();
    let text = routine.ddl.unwrap();
    assert!(
        text.contains("FUNCTION \"SHOP\".\"SC_O_TWICE\"") && text.ends_with("\n/\n"),
        "{text}"
    );
    assert!(routine.sections.iter().any(|x| x.id == "parameters"));
    let missing = details(
        s.as_mut(),
        K,
        "SHOP",
        "SC_O_NOPE",
        ObjectKind::Table,
        "",
        stop,
    )
    .unwrap();
    assert!(missing.ddl.is_none());

    // the statements of the table build it again
    run(&mut s, "DROP VIEW sc_o_open");
    run(&mut s, "DROP TABLE sc_o_order PURGE");
    for statement in ddl.split(";\n").map(str::trim).filter(|x| !x.is_empty()) {
        run(&mut s, statement);
    }
    let again = meta::table(s.as_mut(), K, "SHOP", "SC_O_ORDER", stop).unwrap();
    assert_eq!(again.columns.len(), 4);
    assert!(again.indexes.iter().any(|i| i.name == "SC_O_ORDER_PLACED"));
    assert!(
        again
            .keys
            .iter()
            .any(|k| k.detail.starts_with("FOREIGN KEY (CUSTOMER_ID)"))
    );
    drop_all(&mut s, UNSHOP);
}

fn condition(column: &str, op: Op, values: &[&str], kind: ValueKind, type_name: &str) -> Condition {
    Condition {
        column: column.into(),
        op,
        values: values.iter().map(|v| (*v).to_owned()).collect(),
        kind,
        type_name: type_name.into(),
    }
}

#[test]
#[ignore]
fn a_table_is_filtered_sorted_and_edited() {
    let mut s = open();
    shop(&mut s);
    let query = |conditions: Vec<Condition>, limit: Option<u64>| TableQuery {
        schema: Some("SHOP".into()),
        table: "SC_O_ORDER".into(),
        conditions,
        order: vec![Order {
            column: "TOTAL".into(),
            desc: true,
            nulls: Some(filter::Nulls::Last),
        }],
        limit,
        ..TableQuery::default()
    };
    let all = filter::build(K, &query(Vec::new(), Some(2))).unwrap();
    assert_eq!(
        all.sql,
        "SELECT *\nFROM SHOP.SC_O_ORDER\nORDER BY TOTAL DESC NULLS LAST\nFETCH FIRST 2 ROWS ONLY"
    );
    let r = bound(&mut s, &all.sql, &all.params);
    assert_eq!(r.rows.len(), 2);
    assert_eq!(rows(&r)[0][3], json!("250"));
    // a date is bound as a date, whatever the format of the session
    let by_day = filter::build(
        K,
        &query(
            vec![
                condition(
                    "PLACED_AT",
                    Op::Ge,
                    &["2026-02-01"],
                    ValueKind::Text,
                    "DATE",
                ),
                condition(
                    "CUSTOMER_ID",
                    Op::Eq,
                    &["1"],
                    ValueKind::Number,
                    "NUMBER(9)",
                ),
            ],
            None,
        ),
    )
    .unwrap();
    assert!(by_day.sql.contains("PLACED_AT >= :1"), "{}", by_day.sql);
    assert!(
        by_day.display.contains("TIMESTAMP '2026-02-01 00:00:00'"),
        "{}",
        by_day.display
    );
    assert_eq!(
        by_day.params[0],
        Bind::Datetime("2026-02-01 00:00:00".into())
    );
    assert_eq!(bound(&mut s, &by_day.sql, &by_day.params).rows.len(), 1);
    // LIKE with its wildcards as plain characters
    let like = filter::build(
        K,
        &TableQuery {
            schema: Some("SHOP".into()),
            table: "SC_O_CUSTOMER".into(),
            conditions: vec![condition(
                "NAME",
                Op::Contains,
                &["100%"],
                ValueKind::Text,
                "VARCHAR2",
            )],
            ..TableQuery::default()
        },
    )
    .unwrap();
    assert_eq!(bound(&mut s, &like.sql, &like.params).rows.len(), 1);
    let count = filter::build(
        K,
        &TableQuery {
            schema: Some("SHOP".into()),
            table: "SC_O_ORDER".into(),
            count: true,
            ..TableQuery::default()
        },
    )
    .unwrap();
    assert_eq!(
        rows(&bound(&mut s, &count.sql, &count.params)),
        json!([["3"]])
    );

    // changes: one cell with its lock, several new rows in one statement, a row deleted
    let number = |column: &str, value: &str| CellValue {
        column: column.into(),
        kind: ValueKind::Number,
        type_name: "NUMBER".into(),
        value: Some(value.into()),
    };
    let set = |column: &str, value: Option<&str>, kind: ValueKind, type_name: &str| SetCell {
        column: column.into(),
        kind,
        type_name: type_name.into(),
        value: value.map(str::to_owned),
        default: false,
    };
    let new_row = |customer: &str, day: &str, total: Option<&str>| RowInsert {
        set: vec![
            set(
                "CUSTOMER_ID",
                Some(customer),
                ValueKind::Number,
                "NUMBER(9)",
            ),
            set("PLACED_AT", Some(day), ValueKind::Text, "DATE"),
            set("TOTAL", total, ValueKind::Number, "NUMBER(10,2)"),
        ],
    };
    let plan = UpdatePlan {
        schema: Some("SHOP".into()),
        table: "SC_O_ORDER".into(),
        rows: vec![RowUpdate {
            key: vec![number("ID", "1")],
            set: vec![set(
                "TOTAL",
                Some("260.75"),
                ValueKind::Number,
                "NUMBER(10,2)",
            )],
            expect: vec![number("TOTAL", "250")],
        }],
        deletes: vec![RowDelete {
            key: vec![number("ID", "3")],
            expect: Vec::new(),
        }],
        inserts: vec![
            new_row("2", "2026-04-01", Some("9.99")),
            new_row("2", "2026-04-02 08:30:00", None),
        ],
        ..UpdatePlan::default()
    };
    let steps = edit::steps(K, &plan).unwrap();
    // one row per INSERT: every version takes that, and an identity column numbers each row
    let inserts: Vec<_> = steps
        .iter()
        .filter(|x| x.built.sql.starts_with("INSERT"))
        .collect();
    assert_eq!(inserts.len(), 2);
    assert_eq!(
        inserts[0].built.sql,
        "INSERT INTO SHOP.SC_O_ORDER (CUSTOMER_ID, PLACED_AT, TOTAL)\nVALUES (:1, :2, :3)"
    );
    run(&mut s, schema_commander_lib::db::begin_statement(K));
    for step in &steps {
        let done = bound(&mut s, &step.built.sql, &step.built.params);
        assert_eq!(
            done.rows_affected,
            Some(step.rows as u64),
            "{}",
            step.built.sql
        );
    }
    run(&mut s, "COMMIT");
    assert_eq!(
        rows(&run(
            &mut s,
            "SELECT customer_id, TO_CHAR(placed_at, 'YYYY-MM-DD HH24:MI'), total FROM sc_o_order ORDER BY placed_at"
        )),
        json!([
            [1, "2026-01-10 00:00", "260.75"],
            [1, "2026-02-11 00:00", "40.5"],
            [2, "2026-04-01 00:00", "9.99"],
            [2, "2026-04-02 08:30", null]
        ])
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
        bound(&mut s, &stale[0].built.sql, &stale[0].built.params).rows_affected,
        Some(0)
    );
    // a row of defaults only cannot be written in Oracle: said, not tried
    let empty = UpdatePlan {
        schema: Some("SHOP".into()),
        table: "SC_O_ORDER".into(),
        inserts: vec![RowInsert { set: Vec::new() }],
        ..UpdatePlan::default()
    };
    assert_eq!(
        edit::steps(K, &empty).unwrap_err().code,
        ErrorCode::Unsupported
    );
    drop_all(&mut s, UNSHOP);
}

#[test]
#[ignore]
fn a_text_is_found_in_rows_and_definitions() {
    let mut s = open();
    shop(&mut s);
    let spec = |text: &str, mode: Mode, case_sensitive: bool| FindSpec {
        text: text.into(),
        mode,
        case_sensitive,
        columns: Columns::Text,
        schemas: vec!["SHOP".into()],
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
                FindEvent::Skipped { name, reason, .. } => {
                    vec![format!("skipped {name} {reason:?}")]
                }
                _ => Vec::new(),
            })
            .filter(|l| l.to_uppercase().contains("SC_O_") && !l.starts_with("skipped"))
            .collect();
        lines.sort();
        lines.dedup();
        lines
    };
    // the wildcards of LIKE are plain characters
    let hits = found(&mut s, &spec("100% ferrari_x", Mode::Contains, false));
    assert_eq!(
        hits,
        ["row SC_O_CUSTOMER.NAME: Bruno 100% Ferrari_x"],
        "{hits:?}"
    );
    assert!(found(&mut s, &spec("100% ferrari_x", Mode::Contains, true)).is_empty());
    assert_eq!(found(&mut s, &spec("^Ada L", Mode::Regex, true)).len(), 1);
    assert_eq!(
        found(&mut s, &spec("ada lindqvist", Mode::Exact, false)).len(),
        1
    );
    // in definitions: the view, the function, the check
    let sources = found(&mut s, &spec("total", Mode::Contains, false));
    assert!(sources.iter().any(|l| l == "view SC_O_OPEN"), "{sources:?}");
    assert!(
        sources.iter().any(|l| l.starts_with("check SC_O_ORDER.")),
        "{sources:?}"
    );
    let routine = found(&mut s, &spec("n * 2", Mode::Contains, false));
    assert!(
        routine.iter().any(|l| l == "routine SC_O_TWICE"),
        "{routine:?}"
    );
    drop_all(&mut s, UNSHOP);
}

#[test]
#[ignore]
fn what_is_not_there_for_oracle_yet_says_so() {
    let mut s = open();
    let stop = &|| false;
    let e = schema_commander_lib::db::plan::explain(
        s.as_mut(),
        K,
        "SELECT 1 FROM dual",
        false,
        None,
        stop,
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert!(e.message.contains("Oracle"), "{}", e.message);
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
    assert!(schema_commander_lib::db::compare::snapshot(s.as_mut(), K, "SHOP", stop).is_err());
    // and the session is fine
    assert_eq!(rows(&run(&mut s, "SELECT 1 FROM dual")), json!([["1"]]));
}

/// Review 035b: a statement the user stopped is not kept behind their back when the server could not
/// be asked to end it, a column with a reserved name is quoted, and an instant is found by its value.
#[test]
#[ignore]
fn review_findings_hold() {
    let mut s = open();
    drop_all(&mut s, &["DROP TABLE sc_o_rev PURGE"]);
    run(
        &mut s,
        "CREATE TABLE sc_o_rev (id NUMBER(9) PRIMARY KEY, \"COMMENT\" VARCHAR2(20), \"LEVEL\" NUMBER(3), \
         at TIMESTAMP WITH TIME ZONE)",
    );
    run(
        &mut s,
        "INSERT INTO sc_o_rev VALUES (1, 'a', 5, TIMESTAMP '2026-11-12 12:11:12 +02:00')",
    );
    run(
        &mut s,
        "INSERT INTO sc_o_rev VALUES (2, 'b', 7, TIMESTAMP '2026-11-12 10:11:13 +00:00')",
    );
    // the value as the grid shows it (UTC) finds the row that was stored with another zone
    let shown = rows(&run(&mut s, "SELECT at FROM sc_o_rev WHERE id = 1"))[0][0]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(shown, "2026-11-12 10:11:12+00:00");
    let q = filter::build(
        K,
        &TableQuery {
            schema: Some("SHOP".into()),
            table: "SC_O_REV".into(),
            conditions: vec![
                condition(
                    "AT",
                    Op::Eq,
                    &[&shown],
                    ValueKind::Text,
                    "TIMESTAMP(6) WITH TIME ZONE",
                ),
                condition("LEVEL", Op::Ge, &["5"], ValueKind::Number, "NUMBER(3)"),
            ],
            order: vec![Order {
                column: "COMMENT".into(),
                desc: false,
                nulls: None,
            }],
            ..TableQuery::default()
        },
    )
    .unwrap();
    assert!(
        q.sql.contains("\"LEVEL\" >= :2") && q.sql.contains("ORDER BY \"COMMENT\""),
        "{}",
        q.sql
    );
    assert_eq!(rows(&bound(&mut s, &q.sql, &q.params))[0][0], json!(1));

    // stopped while it ran: SHOP may not end sessions, so the block finishes on the server – and
    // is rolled back there, not committed
    let stop = AtomicBool::new(false);
    let r = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(400));
            stop.store(true, Ordering::Relaxed);
        });
        s.query(
            "BEGIN UPDATE sc_o_rev SET \"LEVEL\" = 99; DBMS_SESSION.SLEEP(5); END;",
            Limits::rows(1),
            &|| stop.load(Ordering::Relaxed),
        )
    });
    assert_eq!(r.unwrap_err().code, ErrorCode::Cancelled);
    std::thread::sleep(Duration::from_secs(7));
    let mut other = open();
    assert_eq!(
        rows(&run(
            &mut other,
            "SELECT \"LEVEL\" FROM sc_o_rev ORDER BY id"
        )),
        json!([[5], [7]])
    );

    // a reading call as the AI control makes it: in a transaction that is rolled back, call after call
    assert_eq!(
        schema_commander_lib::db::guard::read_only_statement(K),
        None
    );
    for _ in 0..2 {
        run(&mut other, schema_commander_lib::db::begin_statement(K));
        assert_eq!(
            rows(&run(&mut other, "SELECT COUNT(*) FROM sc_o_rev")),
            json!([["2"]])
        );
        run(&mut other, "ROLLBACK");
    }
    // DDL ends a transaction that was opened: what follows is kept again
    run(&mut other, schema_commander_lib::db::begin_statement(K));
    run(&mut other, "CREATE INDEX sc_o_rev_at ON sc_o_rev (at)");
    run(&mut other, "DELETE FROM sc_o_rev WHERE id = 2");
    assert_eq!(other.transaction_state(&|| false), TxState::Idle);
    run(&mut other, "DROP TABLE sc_o_rev PURGE");
}
