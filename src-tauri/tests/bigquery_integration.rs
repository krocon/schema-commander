//! BigQuery against the emulator (prompt 035j). Ignored by default: needs the container of
//! `scripts/db-test-servers.sh up` (`bigquery-emulator` on 127.0.0.1:29050, project and dataset `shop`,
//! no login). Run with `pnpm rust:test:db`. The emulator knows less than BigQuery: no pages, no number of
//! changed rows, no `ddl` – those are checked against a server of the test's own (`bigquery_tests.rs`).

use schema_commander_lib::db::filter::{self, Condition, Op, Order, TableQuery, ValueKind};
use schema_commander_lib::db::meta::{self, ObjectKind};
use schema_commander_lib::db::value::{ColKind, MAX_ROWS, QueryResult, VecSink};
use schema_commander_lib::db::{
    Bind, DbKind, Limits, Profile, Session, TlsMode, TxState, capabilities, connect, guard,
};
use schema_commander_lib::error::{AppError, ErrorCode};
use serde_json::{Value, json};

const K: DbKind = DbKind::Bigquery;

fn profile() -> Profile {
    Profile {
        id: "t".into(),
        name: "Test".into(),
        kind: K,
        host: "127.0.0.1".into(),
        port: 29050,
        database: "shop".into(),
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
fn bigquery_types_values_errors_and_the_catalog() {
    let mut s = open();
    let stop = &|| false;
    assert_eq!(s.server_version(stop).unwrap(), "BigQuery");
    assert_eq!(s.transaction_state(stop), TxState::Idle);
    let caps = capabilities(K, s.flavor());
    assert_eq!(caps.product, "BigQuery");
    assert!(!caps.edit && caps.schemas && caps.cancel && !caps.foreign_keys);

    let r = run(
        &mut s,
        "SELECT 42 AS i, 9223372036854775807 AS big, 1.5 AS f, NUMERIC '12.50' AS d, 'Grüße 🚀 小林' AS t, \
         CAST(NULL AS STRING) AS nul, '' AS empty, DATE '2024-02-29' AS dt, true AS b, \
         [1, 2, 3] AS arr, STRUCT(1 AS a, 'x' AS b) AS st",
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
            ColKind::Bool,
            ColKind::Json,
            ColKind::Json,
        ]
    );
    let row = &rows(&r)[0];
    assert_eq!(row[0], json!(42));
    assert_eq!(row[1], json!("9223372036854775807"));
    assert_eq!(row[2], json!(1.5));
    assert_eq!(row[4], json!("Grüße 🚀 小林"));
    assert_eq!(row[5], Value::Null);
    assert_eq!(row[6], json!(""));
    assert_eq!(row[7], json!("2024-02-29"));
    assert_eq!(row[8], json!(true));
    assert_eq!(row[9], json!("[1,2,3]"));
    assert_eq!(row[10], json!("{\"a\":1,\"b\":\"x\"}"));

    // a table of the test's own (the emulator answers a CREATE with an error of its own and makes it)
    let _ = try_run(&mut s, "DROP TABLE shop.sc_q_order");
    let _ = try_run(
        &mut s,
        "CREATE TABLE shop.sc_q_order (id INT64, name STRING, placed_at DATE, total NUMERIC, `select` STRING)",
    );
    run(
        &mut s,
        "INSERT INTO shop.sc_q_order (id, name, placed_at, total, `select`) VALUES \
         (1, 'Ada Lindqvist', DATE '2026-01-10', NUMERIC '250', ''), \
         (2, 'Bruno 100% Ferrari_x', DATE '2026-02-11', NUMERIC '40.5', 'x'), \
         (3, 'it\\'s', DATE '2026-03-12', NULL, NULL)",
    );
    // values travel apart from the statement, with their types
    let evil = "'; DROP TABLE shop.sc_q_order; --";
    let found = bound(
        &mut s,
        "SELECT name FROM shop.sc_q_order WHERE id = ? AND name <> ? AND placed_at >= ?",
        &[
            Bind::Int("2".into()),
            Bind::Text(evil.into()),
            Bind::Date("2026-02-01".into()),
        ],
    );
    assert_eq!(rows(&found), json!([["Bruno 100% Ferrari_x"]]));
    assert_eq!(
        rows(&run(&mut s, "SELECT COUNT(*) FROM shop.sc_q_order")),
        json!([[3]])
    );

    // errors: a statement the server cannot read, with its place
    let syntax = try_run(&mut s, "SELECT 1\n  FRM shop.sc_q_order").unwrap_err();
    assert_eq!(syntax.code, ErrorCode::InvalidQuery, "{}", syntax.message);
    assert_eq!(syntax.details.unwrap().line, Some(2), "{}", syntax.message);
    let unknown = try_run(&mut s, "SELECT * FROM shop.sc_q_nope").unwrap_err();
    assert!(unknown.message.contains("sc_q_nope"), "{}", unknown.message);
    assert_eq!(rows(&run(&mut s, "SELECT 2")), json!([[2]]));

    // the catalog: datasets, tables, columns
    let schemas = meta::schemas(s.as_mut(), K, stop).unwrap();
    assert!(schemas.iter().any(|x| x.name == "shop"));
    let objects = meta::objects(s.as_mut(), K, "shop", stop).unwrap();
    assert!(
        objects
            .iter()
            .any(|o| o.name == "sc_q_order" && o.kind == ObjectKind::Table)
    );
    let t = meta::table(s.as_mut(), K, "shop", "sc_q_order", stop).unwrap();
    let columns: Vec<String> = t
        .columns
        .iter()
        .map(|c| format!("{} {}", c.quoted, c.type_name))
        .collect();
    assert_eq!(
        columns,
        [
            "id INT64",
            "name STRING",
            "placed_at DATE",
            "total NUMERIC",
            "`select` STRING"
        ]
    );
    let found = meta::search(s.as_mut(), K, "Q_ORD", stop).unwrap();
    assert!(
        found
            .iter()
            .any(|f| f.name == "sc_q_order" && f.schema == "shop")
    );

    // the table view: values cast to the type of their column, a position instead of LIKE
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
            table: "sc_q_order".into(),
            conditions: vec![
                condition(
                    "placed_at",
                    Op::Ge,
                    &["2026-02-01"],
                    ValueKind::Text,
                    "DATE",
                ),
                condition("id", Op::Lt, &["3"], ValueKind::Number, "INT64"),
            ],
            order: vec![Order {
                column: "select".into(),
                desc: true,
                nulls: None,
            }],
            limit: Some(10),
            ..TableQuery::default()
        },
    )
    .unwrap();
    assert_eq!(
        q.sql,
        "SELECT *\nFROM shop.sc_q_order\nWHERE placed_at >= CAST(? AS DATE)\n  AND id < CAST(? AS INT64)\nORDER BY `select` DESC\nLIMIT 10"
    );
    assert_eq!(rows(&bound(&mut s, &q.sql, &q.params))[0][0], json!(2));
    for (op, text, want) in [
        (Op::Contains, "100%", 1),
        (Op::Contains, "100% f", 0),
        (Op::ContainsNoCase, "100% f", 1),
        (Op::Contains, "it's", 1),
    ] {
        let like = filter::build(
            K,
            &TableQuery {
                schema: Some("shop".into()),
                table: "sc_q_order".into(),
                conditions: vec![condition("name", op, &[text], ValueKind::Text, "STRING")],
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
    // what the app does not offer for BigQuery says so
    let plan: schema_commander_lib::db::edit::UpdatePlan = serde_json::from_value(json!({
        "table": "sc_q_order", "inserts": [{"set": []}],
    }))
    .unwrap();
    assert_eq!(
        schema_commander_lib::db::edit::steps(K, &plan)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    let _ = try_run(&mut s, "DROP TABLE shop.sc_q_order");
}
