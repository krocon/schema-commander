//! The drivers against real servers (prompt 003). Ignored by default: they need the containers of
//! `scripts/db-test-servers.sh up`. Run with `pnpm rust:test:db`.

use schema_commander_lib::db::secrets::Secret;
use schema_commander_lib::db::value::{ColKind, MAX_ROWS, QueryResult};
use schema_commander_lib::db::{DbKind, Profile, Session, TlsMode, connect};
use schema_commander_lib::error::ErrorCode;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const PW: &str = "Sc-test-003!";

fn profile(kind: DbKind, port: u16, user: &str, database: &str) -> Profile {
    Profile {
        id: "t".into(),
        name: "Test".into(),
        kind,
        host: "127.0.0.1".into(),
        port,
        database: database.into(),
        user: user.into(),
        tls: TlsMode::Off,
        folder: String::new(),
        color: 1,
        save_password: false,
    }
}

fn pg() -> Profile {
    profile(DbKind::Postgres, 25432, "postgres", "postgres")
}
fn my() -> Profile {
    profile(DbKind::Mysql, 23306, "root", "shop")
}
fn maria() -> Profile {
    profile(DbKind::Mysql, 23307, "root", "shop")
}
fn ms() -> Profile {
    profile(DbKind::Sqlserver, 21433, "sa", "")
}

fn open(p: &Profile) -> Box<dyn Session> {
    connect(p, Some(&Secret::new(PW)), &|| false).unwrap()
}

fn run(s: &mut Box<dyn Session>, sql: &str) -> QueryResult {
    s.execute(sql, MAX_ROWS, &|| false)
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

fn rows(r: &QueryResult) -> Value {
    serde_json::to_value(&r.rows).unwrap()
}

fn kinds(r: &QueryResult) -> Vec<ColKind> {
    r.columns.iter().map(|c| c.kind).collect()
}

#[test]
#[ignore]
fn postgres_types_unicode_and_null() {
    let mut s = open(&pg());
    assert!(
        s.server_version(&|| false)
            .unwrap()
            .starts_with("PostgreSQL 17")
    );
    let r = run(
        &mut s,
        "SELECT 42::int4 AS i, 9223372036854775807::int8 AS big, 1.5::float8 AS f, \
         12345678901234567890.123456789::numeric AS n, true AS b, 'Grüße 🚀 小林'::text AS t, \
         NULL::text AS nul, ''::text AS empty, '\\x00ff10'::bytea AS bin, \
         timestamp '2024-02-29 13:05:09.25' AS ts, \
         timestamptz '2024-02-29 13:05:09+02' AS tstz, date '2024-02-29' AS d, time '13:05:09' AS tm, \
         '{\"a\": [1, 2]}'::jsonb AS j, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS u, \
         ARRAY[1, 2, 3] AS arr, interval '1 day 2 hours' AS iv",
    );
    assert_eq!(
        kinds(&r),
        vec![
            ColKind::Int,
            ColKind::Int,
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
            ColKind::Json,
            ColKind::Uuid,
            ColKind::Other,
            ColKind::Other,
        ]
    );
    assert_eq!(
        rows(&r)[0],
        json!([
            42,
            "9223372036854775807",
            1.5,
            "12345678901234567890.123456789",
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
            "{1,2,3}",
            "1 day 02:00:00"
        ])
    );
    assert_eq!(r.rows_affected, None);
}

#[test]
#[ignore]
fn postgres_changes_empty_results_limits_and_errors() {
    let mut s = open(&pg());
    run(&mut s, "DROP TABLE IF EXISTS sc_t");
    let created = run(&mut s, "CREATE TABLE sc_t (id int PRIMARY KEY, name text)");
    assert!(created.columns.is_empty());
    let inserted = run(
        &mut s,
        "INSERT INTO sc_t SELECT g, 'n' || g FROM generate_series(1, 500) g",
    );
    assert_eq!(inserted.rows_affected, Some(500));
    // a result without rows still has its header
    let none = run(&mut s, "SELECT id, name FROM sc_t WHERE id < 0");
    assert_eq!(none.columns.len(), 2);
    assert_eq!(none.columns[1].name, "name");
    assert_eq!(none.rows_affected, None);
    assert!(none.rows.is_empty());
    let cut = s
        .execute("SELECT * FROM sc_t ORDER BY id", 100, &|| false)
        .unwrap();
    assert_eq!(cut.rows.len(), 100);
    assert!(cut.truncated);
    // the rest was read to its end: the connection is usable
    assert_eq!(
        rows(&run(&mut s, "SELECT count(*) FROM sc_t")),
        json!([[500]])
    );
    let e = s.execute("SELEC 1", 10, &|| false).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidQuery);
    assert!(e.message.contains("syntax error"), "{}", e.message);
    assert!(s.is_open());
    let e = s
        .execute("SELECT * FROM gibt_es_nicht", 10, &|| false)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidQuery);
    // what the extended protocol refuses runs too: several statements, the last result counts
    let multi = run(
        &mut s,
        "BEGIN; UPDATE sc_t SET name = 'x' WHERE id = 1; ROLLBACK",
    );
    assert!(multi.columns.is_empty());
    run(&mut s, "DROP TABLE sc_t");
}

#[test]
#[ignore]
fn postgres_refuses_a_wrong_password_and_an_unknown_database() {
    let e = connect(&pg(), Some(&Secret::new("falsch-Zq9")), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::AuthFailed);
    assert!(!e.message.contains("falsch-Zq9"));
    let mut p = pg();
    p.database = "gibt_es_nicht".into();
    let e = connect(&p, Some(&Secret::new(PW)), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::NotFound);
    let mut p = pg();
    p.port = 1;
    let e = connect(&p, Some(&Secret::new(PW)), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::ConnectionFailed);
}

/// Stops `sql` after a moment and says how long the stop took.
fn stop_after_start(p: &Profile, sql: &str) -> (ErrorCode, Duration, bool) {
    let mut s = open(p);
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        flag.store(true, Ordering::Relaxed);
        Instant::now()
    });
    let e = s
        .execute(sql, 10, &|| stop.load(Ordering::Relaxed))
        .unwrap_err();
    let asked = stopper.join().unwrap();
    (e.code, asked.elapsed(), s.is_open())
}

#[test]
#[ignore]
fn a_long_statement_stops_within_a_second_on_every_server() {
    for (p, sql) in [
        (pg(), "SELECT pg_sleep(60)"),
        (my(), "SELECT SLEEP(60)"),
        (maria(), "SELECT SLEEP(60)"),
        (ms(), "WAITFOR DELAY '00:01:00'"),
    ] {
        let (code, took, open) = stop_after_start(&p, sql);
        assert_eq!(code, ErrorCode::Cancelled, "{:?}", p.kind);
        assert!(took < Duration::from_secs(1), "{:?}: {took:?}", p.kind);
        // the connection was dropped: its state is unknown
        assert!(!open, "{:?}", p.kind);
    }
}

fn mysql_family(p: &Profile, product: &str) {
    let mut s = open(p);
    assert!(s.server_version(&|| false).unwrap().starts_with(product));
    let r = run(
        &mut s,
        "SELECT CAST(42 AS SIGNED) AS i, 18446744073709551615 AS big, 1.5E0 AS f, \
         CAST('12345678901234567890.123456789' AS DECIMAL(40, 9)) AS n, \
         'Grüße 🚀 小林' AS t, NULL AS nul, '' AS leer, X'00FF10' AS bin, \
         TIMESTAMP('2024-02-29 13:05:09') AS ts, DATE('2024-02-29') AS d, TIME('13:05:09') AS tm",
    );
    assert_eq!(
        rows(&r)[0],
        json!([
            42,
            "18446744073709551615",
            1.5,
            "12345678901234567890.123456789",
            "Grüße 🚀 小林",
            null,
            "",
            { "bytes": 3, "hex": "00ff10" },
            "2024-02-29 13:05:09",
            "2024-02-29",
            "13:05:09"
        ])
    );
    run(&mut s, "DROP TABLE IF EXISTS sc_t");
    run(
        &mut s,
        "CREATE TABLE sc_t (id INT PRIMARY KEY, name VARCHAR(40), doc JSON)",
    );
    let inserted = run(
        &mut s,
        "INSERT INTO sc_t VALUES (1, 'ä', '{\"a\": 1}'), (2, NULL, NULL), (3, 'c', '[]')",
    );
    assert_eq!(inserted.rows_affected, Some(3));
    let all = run(&mut s, "SELECT id, name, doc FROM sc_t ORDER BY id");
    // MariaDB's JSON is a LONGTEXT with a binary collation, which the driver names a BLOB; its text is
    // read all the same
    let json_kind = if product.starts_with("MariaDB") {
        ColKind::Bytes
    } else {
        ColKind::Json
    };
    assert_eq!(kinds(&all), vec![ColKind::Int, ColKind::Text, json_kind]);
    assert_eq!(rows(&all)[0], json!([1, "ä", "{\"a\": 1}"]));
    assert_eq!(rows(&all)[1], json!([2, null, null]));
    let none = run(&mut s, "SELECT id, name FROM sc_t WHERE id < 0");
    assert_eq!(none.columns.len(), 2);
    assert!(none.rows.is_empty());
    let changed = run(&mut s, "UPDATE sc_t SET name = 'x' WHERE id > 1");
    assert_eq!(changed.rows_affected, Some(2));
    // statements the prepared protocol does not know
    run(&mut s, "USE shop");
    let e = s.execute("SELEC 1", 10, &|| false).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidQuery);
    assert!(s.is_open());
    run(&mut s, "DROP TABLE sc_t");
    let e = connect(p, Some(&Secret::new("falsch-Zq9")), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::AuthFailed);
    assert!(!e.message.contains("falsch-Zq9"));
}

#[test]
#[ignore]
fn mysql_types_changes_and_errors() {
    mysql_family(&my(), "MySQL 8.4");
}

#[test]
#[ignore]
fn mariadb_types_changes_and_errors() {
    mysql_family(&maria(), "MariaDB 11.4");
}

#[test]
#[ignore]
fn sqlserver_types_changes_and_errors() {
    let p = ms();
    let mut s = open(&p);
    assert!(
        s.server_version(&|| false)
            .unwrap()
            .starts_with("Microsoft SQL Server 2022")
    );
    let r = run(
        &mut s,
        "SELECT CAST(42 AS int) AS i, CAST(9223372036854775807 AS bigint) AS big, CAST(1.5 AS float) AS f, \
         CAST('12345678901234567890.123456789' AS decimal(38, 9)) AS n, CAST(1 AS bit) AS b, \
         N'Grüße 🚀 小林' AS t, CAST(NULL AS nvarchar(10)) AS nul, N'' AS empty, 0x00FF10 AS bin, \
         CAST('2024-02-29 13:05:09.25' AS datetime2(3)) AS ts, CAST('2024-02-29' AS date) AS d, \
         CAST('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AS uniqueidentifier) AS u",
    );
    assert_eq!(
        rows(&r)[0],
        json!([
            42,
            "9223372036854775807",
            1.5,
            "12345678901234567890.123456789",
            true,
            "Grüße 🚀 小林",
            null,
            "",
            { "bytes": 3, "hex": "00ff10" },
            "2024-02-29 13:05:09.250",
            "2024-02-29",
            "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
        ])
    );
    assert_eq!(r.rows_affected, None);
    run(
        &mut s,
        "IF OBJECT_ID('tempdb..#sc_t') IS NOT NULL DROP TABLE #sc_t",
    );
    run(
        &mut s,
        "CREATE TABLE #sc_t (id int PRIMARY KEY, name nvarchar(40))",
    );
    let inserted = run(
        &mut s,
        "INSERT INTO #sc_t VALUES (1, N'ä'), (2, NULL), (3, N'c')",
    );
    assert_eq!(inserted.rows_affected, Some(3));
    let none = run(&mut s, "SELECT id, name FROM #sc_t WHERE id < 0");
    assert_eq!(none.columns.len(), 2);
    assert!(none.rows.is_empty());
    assert_eq!(none.rows_affected, None);
    let changed = run(&mut s, "UPDATE #sc_t SET name = N'x' WHERE id > 1 -- note");
    assert_eq!(changed.rows_affected, Some(2));
    // a statement that must be alone in its batch
    run(&mut s, "CREATE OR ALTER VIEW sc_v AS SELECT 1 AS one");
    assert_eq!(rows(&run(&mut s, "SELECT one FROM sc_v")), json!([[1]]));
    run(&mut s, "DROP VIEW sc_v");
    let e = s.execute("SELEC 1", 10, &|| false).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidQuery);
    assert!(s.is_open());
    let e = connect(&p, Some(&Secret::new("falsch-Zq9")), &|| false)
        .err()
        .unwrap();
    assert_eq!(e.code, ErrorCode::AuthFailed);
}

#[test]
#[ignore]
fn a_big_result_is_cut_at_the_limit_and_stays_usable() {
    let mut s = open(&pg());
    let started = Instant::now();
    let r = s
        .execute(
            "SELECT g, md5(g::text) FROM generate_series(1, 2000000) g",
            MAX_ROWS,
            &|| false,
        )
        .unwrap();
    assert_eq!(r.rows.len(), MAX_ROWS);
    assert!(r.truncated);
    assert!(started.elapsed() < Duration::from_secs(60));
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
}
