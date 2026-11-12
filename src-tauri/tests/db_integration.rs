//! The drivers against real servers (prompt 003). Ignored by default: they need the containers of
//! `scripts/db-test-servers.sh up`. Run with `pnpm rust:test:db`.

use schema_commander_lib::db::secrets::Secret;
use schema_commander_lib::db::value::{ColKind, MAX_ROWS, QueryResult};
use schema_commander_lib::db::{DbKind, Limits, Profile, Session, TlsMode, connect};
use schema_commander_lib::error::ErrorCode;
use schema_commander_lib::results::{Progress, ResultStore, StoreLimits, StoreSink};
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
        protection: schema_commander_lib::db::guard::Protection::Free,
        label: String::new(),
        ca_file: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        ssh: None,
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
    s.query(sql, Limits::rows(MAX_ROWS), &|| false)
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
        .query("SELECT * FROM sc_t ORDER BY id", Limits::rows(100), &|| {
            false
        })
        .unwrap();
    assert_eq!(cut.rows.len(), 100);
    assert!(cut.truncated);
    // the rest was read to its end: the connection is usable
    assert_eq!(
        rows(&run(&mut s, "SELECT count(*) FROM sc_t")),
        json!([[500]])
    );
    let e = s.query("SELEC 1", Limits::rows(10), &|| false).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidQuery);
    assert!(e.message.contains("syntax error"), "{}", e.message);
    assert!(s.is_open());
    let e = s
        .query("SELECT * FROM gibt_es_nicht", Limits::rows(10), &|| false)
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

/// A statement that keeps MySQL busy for minutes.
const MYSQL_LONG: &str = "SELECT COUNT(*) FROM information_schema.columns a, \
                          information_schema.columns b, information_schema.columns c";

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
        .query(sql, Limits::rows(10), &|| stop.load(Ordering::Relaxed))
        .unwrap_err();
    let asked = stopper.join().unwrap();
    (e.code, asked.elapsed(), s.is_open())
}

#[test]
#[ignore]
fn a_long_statement_stops_within_a_second_on_every_server() {
    for (p, sql, keeps) in [
        (pg(), "SELECT pg_sleep(60)", true),
        // not SLEEP(): MySQL ends a killed SLEEP() without an error, as if it were done
        (my(), MYSQL_LONG, true),
        (maria(), MYSQL_LONG, true),
        // tiberius cannot send the attention signal: the connection is dropped
        (ms(), "WAITFOR DELAY '00:01:00'", false),
    ] {
        let (code, took, open) = stop_after_start(&p, sql);
        assert_eq!(code, ErrorCode::Cancelled, "{:?}", p.kind);
        assert!(took < Duration::from_secs(1), "{:?}: {took:?}", p.kind);
        assert_eq!(open, keeps, "{:?}", p.kind);
    }
}

#[test]
#[ignore]
fn a_cancelled_session_goes_on_with_its_state() {
    // the statement is cancelled on the server: session variables and temporary tables survive
    let mut s = open(&pg());
    run(&mut s, "CREATE TEMP TABLE sc_keep (n int)");
    run(&mut s, "INSERT INTO sc_keep VALUES (7)");
    let e = s
        .query("SELECT pg_sleep(60)", Limits::rows(1), &|| true)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Cancelled);
    assert!(s.is_open());
    assert_eq!(rows(&run(&mut s, "SELECT n FROM sc_keep")), json!([[7]]));

    for p in [my(), maria()] {
        let mut s = open(&p);
        run(&mut s, "SET @sc_keep = 7");
        // MySQL ends a killed SLEEP() without an error (it returns 1); a real query is interrupted
        let r = s.query(
            "SELECT COUNT(*) FROM information_schema.columns a, information_schema.columns b, \
             information_schema.columns c",
            Limits::rows(1),
            &|| true,
        );
        assert_eq!(r.unwrap_err().code, ErrorCode::Cancelled, "{:?}", p.port);
        assert!(s.is_open());
        assert_eq!(rows(&run(&mut s, "SELECT @sc_keep")), json!([[7]]));
    }
}

#[test]
#[ignore]
fn a_time_limit_ends_a_statement_and_keeps_the_session() {
    let limits = Limits {
        max_rows: 1,
        timeout: Some(Duration::from_millis(300)),
    };
    let mut s = open(&pg());
    let started = Instant::now();
    let e = s
        .query("SELECT pg_sleep(60)", limits, &|| false)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(s.is_open());
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
    let mut s = open(&ms());
    let e = s
        .query("WAITFOR DELAY '00:01:00'", limits, &|| false)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Timeout);
    assert!(!s.is_open());
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
    let e = s.query("SELEC 1", Limits::rows(10), &|| false).unwrap_err();
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
    let e = s.query("SELEC 1", Limits::rows(10), &|| false).unwrap_err();
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
        .query(
            "SELECT g, md5(g::text) FROM generate_series(1, 2000000) g",
            Limits::rows(MAX_ROWS),
            &|| false,
        )
        .unwrap();
    assert_eq!(r.rows.len(), MAX_ROWS);
    assert!(r.truncated);
    assert!(started.elapsed() < Duration::from_secs(60));
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
}

/// Runs `sql` into a store and says when the first rows could be read.
fn into_store(
    s: &mut Box<dyn Session>,
    store: &ResultStore,
    sql: &str,
) -> (
    schema_commander_lib::db::value::Outcome,
    Option<u64>,
    Option<Duration>,
    bool,
) {
    let started = Instant::now();
    let first = parking_lot::Mutex::new(None);
    let report = |p: Progress| {
        if matches!(p, Progress::Rows(n) if n > 0) {
            first.lock().get_or_insert(started.elapsed());
        }
    };
    let mut sink = StoreSink::new(store, &report);
    let outcome = s
        .execute(sql, Limits::rows(0), &mut sink, &|| false)
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    sink.finish();
    assert!(sink.error.is_none());
    let id = sink.result_id();
    let full = sink.full;
    let first = *first.lock();
    (outcome, id, first, full)
}

fn window(store: &ResultStore, id: u64, from: u64, count: u64) -> Value {
    serde_json::from_str(&store.window(id, from, count).unwrap()).unwrap()
}

#[test]
#[ignore]
fn millions_of_rows_stream_into_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = ResultStore::new(dir.path());
    let mut s = open(&pg());
    let started = Instant::now();
    let (outcome, id, first, full) = into_store(
        &mut s,
        &store,
        "SELECT g, md5(g::text), g * 1.5, now(), NULL::text, g % 2 = 0 FROM generate_series(1, 3000000) g",
    );
    let total = started.elapsed();
    let id = id.unwrap();
    assert!(!full && !outcome.truncated);
    assert_eq!(outcome.rows, 3_000_000);
    assert_eq!(store.rows(id).unwrap(), 3_000_000);
    assert!(store.on_disk(id).unwrap());
    // the first rows are readable long before the last ones arrived
    let first = first.unwrap();
    eprintln!("3 million rows: first rows after {first:?}, all after {total:?}");
    assert!(first < Duration::from_secs(1), "{first:?}");
    assert!(first < total / 4, "{first:?} of {total:?}");
    // any window, also the very end
    assert_eq!(window(&store, id, 0, 1)[0][0], json!(1));
    assert_eq!(window(&store, id, 1_499_999, 1)[0][0], json!(1_500_000));
    let last = window(&store, id, 2_999_990, 100);
    assert_eq!(last.as_array().unwrap().len(), 10);
    assert_eq!(last[9][0], json!(3_000_000));
    assert_eq!(last[9][2], json!("4500000.0"));
    assert_eq!(last[9][4], json!(null));
    store.free(id);
    assert!(
        std::fs::read_dir(
            dir.path()
                .join("results")
                .join(std::process::id().to_string())
        )
        .unwrap()
        .next()
        .is_none()
    );
}

#[test]
#[ignore]
fn a_result_cut_at_a_limit_frees_the_connection_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let limits = StoreLimits {
        max_rows: 1000,
        ..StoreLimits::default()
    };
    for (p, sql, keeps) in [
        (pg(), "SELECT g FROM generate_series(1, 50000000) g", true),
        (
            my(),
            // small derived tables: the join sends its first rows at once, whatever the catalog holds
            "SELECT a.n FROM (SELECT ordinal_position n FROM information_schema.columns LIMIT 400) a, \
             (SELECT 1 FROM information_schema.columns LIMIT 400) b, \
             (SELECT 1 FROM information_schema.columns LIMIT 400) c",
            true,
        ),
        // SQL Server cannot be told to stop: the connection goes instead of reading 50 million rows
        (
            ms(),
            "SELECT a.object_id FROM sys.all_columns a, sys.all_columns b, sys.all_columns c",
            false,
        ),
    ] {
        let store = ResultStore::with_limits(dir.path(), limits);
        let mut s = open(&p);
        let started = Instant::now();
        let (outcome, id, _, full) = into_store(&mut s, &store, sql);
        assert!(full && outcome.truncated, "{:?}", p.kind);
        assert_eq!(store.rows(id.unwrap()).unwrap(), 1000, "{:?}", p.kind);
        assert_eq!(s.is_open(), keeps, "{:?}", p.kind);
        if keeps {
            assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]), "{:?}", p.kind);
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}: {:?}",
            p.kind,
            started.elapsed()
        );
    }
}

// --- metadata (prompt 008) -------------------------------------------------------------------------

use schema_commander_lib::db::meta::{self, ObjectKind, TableInfo};

fn names(list: &[meta::ObjectInfo], kind: ObjectKind) -> Vec<&str> {
    list.iter()
        .filter(|o| o.kind == kind)
        .map(|o| o.name.as_str())
        .collect()
}

fn column_line(t: &TableInfo) -> Vec<String> {
    t.columns
        .iter()
        .map(|c| {
            format!(
                "{} {} {} {}",
                c.name,
                c.type_name,
                if c.nullable { "null" } else { "not null" },
                c.key
            )
        })
        .collect()
}

/// What every server is asked: the schema `sc_meta` with two tables, a view, an index, keys, a trigger
/// where it is cheap, and names that need quotes.
fn check_meta(s: &mut Box<dyn Session>, kind: DbKind, schema: &str) {
    let stop = &|| false;
    let schemas = meta::schemas(s.as_mut(), kind, stop).unwrap();
    let mine = schemas.iter().find(|x| x.name == schema).expect("schema");
    assert!(!mine.system);
    assert!(
        schemas.iter().any(|x| x.system),
        "system schemas are marked"
    );

    let objects = meta::objects(s.as_mut(), kind, schema, stop).unwrap();
    assert_eq!(
        names(&objects, ObjectKind::Table),
        vec!["author", "book", "Odd Name"]
    );
    assert_eq!(names(&objects, ObjectKind::View), vec!["book_titles"]);
    assert!(names(&objects, ObjectKind::Routine).contains(&"sc_twice"));
    let odd = objects.iter().find(|o| o.name == "Odd Name").unwrap();
    assert_eq!(odd.quoted, meta::quote_always("Odd Name", kind));

    let book = meta::table(s.as_mut(), kind, schema, "book", stop).unwrap();
    let lines = column_line(&book);
    assert_eq!(lines.len(), 4, "{lines:?}");
    assert!(
        lines[0].starts_with("id ") && lines[0].ends_with("not null pk"),
        "{lines:?}"
    );
    assert!(
        lines[1].starts_with("author_id ") && lines[1].ends_with("not null fk"),
        "{lines:?}"
    );
    assert!(
        lines[2].starts_with("title ") && lines[2].ends_with(" null "),
        "{lines:?}"
    );
    assert!(
        book.columns[3]
            .default
            .as_deref()
            .is_some_and(|d| d.contains('0')),
        "{:?}",
        book.columns[3]
    );
    assert!(
        book.indexes
            .iter()
            .any(|i| i.name == "book_by_title" && i.detail.contains("title")),
        "{:?}",
        book.indexes
    );
    assert!(
        book.keys
            .iter()
            .any(|k| k.detail.to_uppercase().contains("PRIMARY KEY")),
        "{:?}",
        book.keys
    );
    assert!(
        book.keys.iter().any(|k| {
            let d = k.detail.to_uppercase();
            d.contains("FOREIGN KEY") && d.contains("AUTHOR")
        }),
        "{:?}",
        book.keys
    );
    assert_eq!(book.triggers.len(), 1, "{:?}", book.triggers);
    assert_eq!(book.triggers[0].name, "book_touch");

    let odd = meta::table(s.as_mut(), kind, schema, "Odd Name", stop).unwrap();
    assert_eq!(odd.columns[0].name, "select");
    assert_eq!(odd.columns[0].quoted, meta::quote_always("select", kind));
    assert_eq!(odd.columns[1].name, "Größe 1");

    // a name is a value: nothing is found, nothing breaks
    let none = meta::table(s.as_mut(), kind, schema, "book'; DROP TABLE book; --", stop).unwrap();
    assert_eq!(none, TableInfo::default());
    assert!(
        meta::objects(s.as_mut(), kind, "no such schema", stop)
            .unwrap()
            .is_empty()
    );

    let hits = meta::search(s.as_mut(), kind, "OOK", stop).unwrap();
    let found: Vec<(&str, &str)> = hits
        .iter()
        .filter(|h| h.schema == schema && h.kind != ObjectKind::Matview)
        .map(|h| (h.name.as_str(), h.schema.as_str()))
        .collect();
    assert_eq!(found, vec![("book", schema), ("book_titles", schema)]);
    assert!(
        meta::search(s.as_mut(), kind, "b_ok", stop)
            .unwrap()
            .is_empty(),
        "_ is text"
    );

    // the session is as usable as before
    assert_eq!(rows(&run(s, "SELECT 1")), json!([[1]]));
}

#[test]
#[ignore]
fn postgres_metadata() {
    let mut s = open(&pg());
    for sql in [
        "DROP SCHEMA IF EXISTS sc_meta CASCADE",
        "CREATE SCHEMA sc_meta",
        "CREATE TABLE sc_meta.author (id int PRIMARY KEY, name text NOT NULL)",
        "CREATE TABLE sc_meta.book (id int PRIMARY KEY, author_id int NOT NULL REFERENCES sc_meta.author (id), \
         title varchar(200), copies int NOT NULL DEFAULT 0)",
        "CREATE INDEX book_by_title ON sc_meta.book (title)",
        "CREATE TABLE sc_meta.\"Odd Name\" (\"select\" text, \"Größe 1\" numeric(10,2))",
        "CREATE VIEW sc_meta.book_titles AS SELECT title FROM sc_meta.book",
        "CREATE FUNCTION sc_meta.sc_twice(n int) RETURNS int LANGUAGE sql AS 'SELECT n * 2'",
        "CREATE FUNCTION sc_meta.touch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
        "CREATE TRIGGER book_touch BEFORE UPDATE ON sc_meta.book FOR EACH ROW EXECUTE FUNCTION sc_meta.touch()",
        "CREATE SEQUENCE sc_meta.ticket",
        "CREATE TYPE sc_meta.mood AS ENUM ('ok', 'bad')",
        "CREATE MATERIALIZED VIEW sc_meta.book_count AS SELECT count(*) AS n FROM sc_meta.book",
    ] {
        run(&mut s, sql);
    }
    check_meta(&mut s, DbKind::Postgres, "sc_meta");
    let stop = &|| false;
    let objects = meta::objects(s.as_mut(), DbKind::Postgres, "sc_meta", stop).unwrap();
    assert_eq!(names(&objects, ObjectKind::Sequence), vec!["ticket"]);
    assert_eq!(names(&objects, ObjectKind::Type), vec!["mood"]);
    assert_eq!(names(&objects, ObjectKind::Matview), vec!["book_count"]);
    let twice = objects.iter().find(|o| o.name == "sc_twice").unwrap();
    assert_eq!(twice.detail, "n integer");
    let book = meta::table(s.as_mut(), DbKind::Postgres, "sc_meta", "book", stop).unwrap();
    assert_eq!(book.columns[2].type_name, "character varying(200)");
    let schemas = meta::schemas(s.as_mut(), DbKind::Postgres, stop).unwrap();
    assert!(schemas.iter().any(|x| x.name == "public" && x.current));
    run(&mut s, "DROP SCHEMA sc_meta CASCADE");
}

fn mysql_meta(p: &Profile) {
    let mut s = open(p);
    for sql in [
        "DROP DATABASE IF EXISTS sc_meta",
        "CREATE DATABASE sc_meta",
        "CREATE TABLE sc_meta.author (id int PRIMARY KEY, name varchar(100) NOT NULL)",
        "CREATE TABLE sc_meta.book (id int PRIMARY KEY, author_id int NOT NULL, title varchar(200), \
         copies int NOT NULL DEFAULT 0, CONSTRAINT book_author FOREIGN KEY (author_id) \
         REFERENCES sc_meta.author (id))",
        "CREATE INDEX book_by_title ON sc_meta.book (title)",
        "CREATE TABLE sc_meta.`Odd Name` (`select` text, `Größe 1` decimal(10,2))",
        "CREATE VIEW sc_meta.book_titles AS SELECT title FROM sc_meta.book",
        "CREATE FUNCTION sc_meta.sc_twice(n int) RETURNS int DETERMINISTIC RETURN n * 2",
        "CREATE TRIGGER sc_meta.book_touch BEFORE UPDATE ON sc_meta.book FOR EACH ROW SET NEW.copies = NEW.copies",
    ] {
        run(&mut s, sql);
    }
    check_meta(&mut s, DbKind::Mysql, "sc_meta");
    let stop = &|| false;
    let book = meta::table(s.as_mut(), DbKind::Mysql, "sc_meta", "book", stop).unwrap();
    assert_eq!(book.columns[2].type_name, "varchar(200)");
    let schemas = meta::schemas(s.as_mut(), DbKind::Mysql, stop).unwrap();
    assert!(schemas.iter().any(|x| x.name == "shop" && x.current));
    run(&mut s, "DROP DATABASE sc_meta");
}

#[test]
#[ignore]
fn mysql_metadata() {
    mysql_meta(&my());
}

#[test]
#[ignore]
fn mariadb_metadata() {
    mysql_meta(&maria());
}

#[test]
#[ignore]
fn sqlserver_metadata() {
    let mut s = open(&ms());
    for sql in [
        "IF OBJECT_ID('sc_meta.book_titles') IS NOT NULL DROP VIEW sc_meta.book_titles",
        "IF OBJECT_ID('sc_meta.sc_twice') IS NOT NULL DROP FUNCTION sc_meta.sc_twice",
        "IF OBJECT_ID('sc_meta.book') IS NOT NULL DROP TABLE sc_meta.book",
        "IF OBJECT_ID('sc_meta.author') IS NOT NULL DROP TABLE sc_meta.author",
        "IF OBJECT_ID('sc_meta.[Odd Name]') IS NOT NULL DROP TABLE sc_meta.[Odd Name]",
        "IF SCHEMA_ID('sc_meta') IS NULL EXEC('CREATE SCHEMA sc_meta')",
        "CREATE TABLE sc_meta.author (id int PRIMARY KEY, name nvarchar(100) NOT NULL)",
        "CREATE TABLE sc_meta.book (id int PRIMARY KEY, author_id int NOT NULL REFERENCES sc_meta.author (id), \
         title nvarchar(200), copies int NOT NULL DEFAULT 0)",
        "CREATE INDEX book_by_title ON sc_meta.book (title)",
        "CREATE TABLE sc_meta.[Odd Name] ([select] nvarchar(max), [Größe 1] decimal(10,2))",
        "CREATE VIEW sc_meta.book_titles AS SELECT title FROM sc_meta.book",
        "CREATE FUNCTION sc_meta.sc_twice(@n int) RETURNS int AS BEGIN RETURN @n * 2 END",
        "CREATE TRIGGER sc_meta.book_touch ON sc_meta.book AFTER UPDATE AS BEGIN SET NOCOUNT ON END",
    ] {
        run(&mut s, sql);
    }
    check_meta(&mut s, DbKind::Sqlserver, "sc_meta");
    let stop = &|| false;
    let book = meta::table(s.as_mut(), DbKind::Sqlserver, "sc_meta", "book", stop).unwrap();
    assert_eq!(book.columns[2].type_name, "nvarchar(200)");
    let odd = meta::table(s.as_mut(), DbKind::Sqlserver, "sc_meta", "Odd Name", stop).unwrap();
    assert_eq!(odd.columns[0].type_name, "nvarchar(max)");
    assert_eq!(odd.columns[1].type_name, "decimal(10, 2)");
}

// --- transactions (prompt 013) ---------------------------------------------------------------------

use schema_commander_lib::db::TxState;

fn try_run(s: &mut Box<dyn Session>, sql: &str) -> bool {
    s.query(sql, Limits::rows(MAX_ROWS), &|| false).is_ok()
}

/// What every server is asked: the state the server reports after each step.
fn check_tx(p: &Profile, begin: &str, failed_after_error: TxState) {
    let stop = &|| false;
    let mut s = open(p);
    assert_eq!(
        s.transaction_state(stop),
        TxState::Idle,
        "{:?} fresh",
        p.kind
    );
    run(&mut s, "SELECT 1");
    assert_eq!(
        s.transaction_state(stop),
        TxState::Idle,
        "{:?} after a statement",
        p.kind
    );
    run(&mut s, begin);
    assert_eq!(
        s.transaction_state(stop),
        TxState::Active,
        "{:?} after begin",
        p.kind
    );
    run(&mut s, "SELECT 1");
    assert_eq!(
        s.transaction_state(stop),
        TxState::Active,
        "{:?} inside",
        p.kind
    );
    assert!(!try_run(&mut s, "SELECT * FROM sc_no_such_table_013"));
    assert_eq!(
        s.transaction_state(stop),
        failed_after_error,
        "{:?} after an error",
        p.kind
    );
    run(&mut s, "ROLLBACK");
    assert_eq!(
        s.transaction_state(stop),
        TxState::Idle,
        "{:?} after rollback",
        p.kind
    );
    // asking does not disturb the session
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
    run(&mut s, begin);
    run(&mut s, "COMMIT");
    assert_eq!(
        s.transaction_state(stop),
        TxState::Idle,
        "{:?} after commit",
        p.kind
    );
}

#[test]
#[ignore]
fn postgres_reports_its_transaction_state() {
    // an error poisons the transaction: only a rollback gets out
    check_tx(&pg(), "BEGIN", TxState::Failed);
    let stop = &|| false;
    let mut s = open(&pg());
    run(&mut s, "BEGIN");
    run(&mut s, "SAVEPOINT a");
    assert!(!try_run(&mut s, "SELECT * FROM sc_no_such_table_013"));
    assert_eq!(s.transaction_state(stop), TxState::Failed);
    run(&mut s, "ROLLBACK TO SAVEPOINT a");
    assert_eq!(s.transaction_state(stop), TxState::Active);
    run(&mut s, "ROLLBACK");
}

fn mysql_tx(p: &Profile) {
    check_tx(p, "START TRANSACTION", TxState::Active);
    let stop = &|| false;
    let mut s = open(p);
    run(&mut s, "DROP TABLE IF EXISTS sc_tx_013");
    run(&mut s, "START TRANSACTION");
    assert_eq!(s.transaction_state(stop), TxState::Active);
    // DDL commits without being asked
    run(&mut s, "CREATE TABLE sc_tx_013 (a int)");
    assert_eq!(
        s.transaction_state(stop),
        TxState::Idle,
        "{:?} after DDL",
        p.kind
    );
    run(&mut s, "SET autocommit = 0");
    run(&mut s, "INSERT INTO sc_tx_013 VALUES (1)");
    assert_eq!(s.transaction_state(stop), TxState::Active, "autocommit off");
    run(&mut s, "ROLLBACK");
    run(&mut s, "SET autocommit = 1");
    run(&mut s, "DROP TABLE sc_tx_013");
}

#[test]
#[ignore]
fn mysql_reports_its_transaction_state() {
    mysql_tx(&my());
}

#[test]
#[ignore]
fn mariadb_reports_its_transaction_state() {
    mysql_tx(&maria());
}

#[test]
#[ignore]
fn sqlserver_reports_its_transaction_state() {
    check_tx(&ms(), "BEGIN TRANSACTION", TxState::Active);
}

// --- read only on the server (prompt 012) ------------------------------------------------------------

#[test]
#[ignore]
fn a_read_only_session_refuses_writes_on_the_server() {
    use schema_commander_lib::db::guard::read_only_statement;
    for p in [pg(), my(), maria()] {
        let mut s = open(&p);
        run(&mut s, "DROP TABLE IF EXISTS sc_ro_012");
        run(&mut s, "CREATE TABLE sc_ro_012 (a int)");
        run(&mut s, read_only_statement(p.kind).unwrap());
        assert!(
            !try_run(&mut s, "INSERT INTO sc_ro_012 VALUES (1)"),
            "{:?} insert",
            p.kind
        );
        assert!(
            !try_run(&mut s, "CREATE TABLE sc_ro_012b (a int)"),
            "{:?} ddl",
            p.kind
        );
        assert!(
            !try_run(&mut s, "DELETE FROM sc_ro_012"),
            "{:?} delete",
            p.kind
        );
        // reading goes on
        assert_eq!(
            rows(&run(&mut s, "SELECT count(*) FROM sc_ro_012")),
            json!([[0]])
        );
        let mut other = open(&p);
        run(&mut other, "DROP TABLE sc_ro_012");
    }
}

// --- TLS modes (prompt 014) --------------------------------------------------------------------------

#[test]
#[ignore]
fn tls_modes_against_servers_without_tls() {
    // the test servers offer no TLS: "prefer" falls back, everything stricter refuses to connect
    let mut prefer = pg();
    prefer.tls = TlsMode::Prefer;
    let mut s = connect(&prefer, Some(&Secret::new(PW)), &|| false).unwrap();
    assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]));
    for mode in [TlsMode::Require, TlsMode::VerifyCa, TlsMode::Verify] {
        let mut p = pg();
        p.tls = mode;
        let e = connect(&p, Some(&Secret::new(PW)), &|| false)
            .err()
            .expect("no TLS, no connection");
        assert!(
            matches!(e.code, ErrorCode::TlsFailed | ErrorCode::ConnectionFailed),
            "{mode:?}: {e}"
        );
        assert!(!e.message.contains(PW));
    }
}

// --- object details and DDL (prompt 019) -----------------------------------------------------------

use schema_commander_lib::db::details::{ObjectDetails, Section, details};

fn detail(
    s: &mut Box<dyn Session>,
    kind: DbKind,
    schema: &str,
    name: &str,
    object: ObjectKind,
) -> ObjectDetails {
    details(s.as_mut(), kind, schema, name, object, "", &|| false)
        .unwrap_or_else(|e| panic!("{schema}.{name}: {e}"))
}

/// What must be the same after the DDL built the object again: every list but the sizes and dates.
fn structure(d: &ObjectDetails) -> Vec<Section> {
    d.sections
        .iter()
        .filter(|s| s.id != "stats")
        .cloned()
        .map(|mut s| {
            // when an object was made is no part of its structure
            if s.id == "properties" {
                s.rows
                    .retain(|row| !matches!(row[0].as_deref(), Some("created") | Some("modified")));
            }
            if let Some(i) = s.columns.iter().position(|c| c == "size") {
                s.columns.remove(i);
                for row in &mut s.rows {
                    row.remove(i);
                }
            }
            s
        })
        .collect()
}

fn section<'a>(d: &'a ObjectDetails, id: &str) -> &'a Section {
    d.sections.iter().find(|s| s.id == id).unwrap_or_else(|| {
        panic!(
            "no section {id} in {:?}",
            d.sections.iter().map(|s| &s.id).collect::<Vec<_>>()
        )
    })
}

fn cells(s: &Section, column: &str) -> Vec<String> {
    let i = s.columns.iter().position(|c| c == column).unwrap();
    s.rows
        .iter()
        .map(|r| r[i].clone().unwrap_or_default())
        .collect()
}

/// Runs DDL statement by statement (`;` at a line end); `whole` = one statement with a body.
fn run_ddl(s: &mut Box<dyn Session>, ddl: &str, whole: bool) {
    if whole {
        run(s, ddl.trim().trim_end_matches(';'));
        return;
    }
    for statement in ddl.split(";\n").map(str::trim).filter(|t| !t.is_empty()) {
        run(s, statement);
    }
}

#[test]
#[ignore = "needs the database containers"]
fn postgres_details_and_ddl_round_trip() {
    let mut s = open(&pg());
    for sql in [
        "DROP SCHEMA IF EXISTS sc_det CASCADE",
        "CREATE SCHEMA sc_det",
        "CREATE TYPE sc_det.mood AS ENUM ('sad', 'ok', 'it''s fine')",
        "CREATE DOMAIN sc_det.price AS numeric(10,2) DEFAULT 0 NOT NULL CONSTRAINT price_positive CHECK (VALUE >= 0)",
        "CREATE SEQUENCE sc_det.ticket INCREMENT BY 5 START WITH 100 CACHE 10",
        "CREATE FUNCTION sc_det.touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.title := NEW.title; RETURN NEW; END$$",
        "CREATE FUNCTION sc_det.twice(n integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT n * 2'",
        "CREATE TABLE sc_det.author (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, \
           mood sc_det.mood DEFAULT 'ok', CONSTRAINT author_name_unique UNIQUE (name))",
        "CREATE TABLE sc_det.\"Book Shelf\" (id serial PRIMARY KEY, author_id integer NOT NULL \
           REFERENCES sc_det.author (id) ON DELETE CASCADE ON UPDATE RESTRICT, \
           title varchar(200) COLLATE \"C\" DEFAULT 'untitled', cost sc_det.price, \
           \"Größe\" numeric(6,2), shout text GENERATED ALWAYS AS (upper(title)) STORED, \
           CONSTRAINT shelf_cost CHECK (cost < 1000))",
        "CREATE INDEX shelf_by_title ON sc_det.\"Book Shelf\" (lower(title)) WHERE title IS NOT NULL",
        "CREATE TRIGGER shelf_touch BEFORE UPDATE ON sc_det.\"Book Shelf\" FOR EACH ROW EXECUTE FUNCTION sc_det.touch()",
        "COMMENT ON TABLE sc_det.\"Book Shelf\" IS 'what''s on the shelf'",
        "COMMENT ON COLUMN sc_det.\"Book Shelf\".title IS 'the title'",
        "CREATE TABLE sc_det.log (at date NOT NULL, text text) PARTITION BY RANGE (at)",
        "CREATE TABLE sc_det.log_2026 PARTITION OF sc_det.log FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
        "CREATE VIEW sc_det.titles AS SELECT b.title, a.name FROM sc_det.\"Book Shelf\" b JOIN sc_det.author a ON a.id = b.author_id",
        "CREATE MATERIALIZED VIEW sc_det.names AS SELECT name FROM sc_det.author",
        "CREATE UNIQUE INDEX names_name ON sc_det.names (name)",
    ] {
        run(&mut s, sql);
    }
    let k = DbKind::Postgres;
    // what the lists say
    let shelf = detail(&mut s, k, "sc_det", "Book Shelf", ObjectKind::Table);
    assert!(shelf.notes.is_empty(), "{:?}", shelf.notes);
    let columns = section(&shelf, "columns");
    assert_eq!(
        cells(columns, "name"),
        ["id", "author_id", "title", "cost", "Größe", "shout"]
    );
    assert_eq!(cells(columns, "key")[..2], ["pk", "fk"]);
    assert_eq!(cells(columns, "comment")[2], "the title");
    assert!(cells(columns, "extra")[5].starts_with("generated: upper"));
    assert_eq!(
        cells(section(&shelf, "indexes"), "name"),
        ["Book Shelf_pkey", "shelf_by_title"]
    );
    let refs = section(&shelf, "references");
    assert_eq!(cells(refs, "refName"), ["author"]);
    assert_eq!(cells(refs, "onDelete"), ["cascade"]);
    assert_eq!(cells(refs, "onUpdate"), ["restrict"]);
    assert_eq!(cells(section(&shelf, "triggers"), "name"), ["shelf_touch"]);
    assert_eq!(cells(section(&shelf, "usedBy"), "refName"), ["titles"]);
    assert!(cells(section(&shelf, "stats"), "property").contains(&"totalSize".to_string()));
    let author = detail(&mut s, k, "sc_det", "author", ObjectKind::Table);
    assert_eq!(
        cells(section(&author, "referencedBy"), "refName"),
        ["Book Shelf"]
    );
    assert_eq!(
        cells(section(&author, "columns"), "extra")[0],
        "identity always"
    );
    let log = detail(&mut s, k, "sc_det", "log", ObjectKind::Table);
    assert_eq!(cells(section(&log, "partitions"), "refName"), ["log_2026"]);
    let view = detail(&mut s, k, "sc_det", "titles", ObjectKind::View);
    assert_eq!(
        cells(section(&view, "uses"), "refName"),
        ["Book Shelf", "author"]
    );
    let function = detail(&mut s, k, "sc_det", "twice", ObjectKind::Routine);
    let props = section(&function, "properties");
    assert!(cells(props, "value").contains(&"immutable".to_string()));
    assert!(
        function
            .ddl
            .as_deref()
            .unwrap()
            .contains("CREATE OR REPLACE FUNCTION sc_det.twice")
    );
    let mood = detail(&mut s, k, "sc_det", "mood", ObjectKind::Type);
    assert_eq!(
        cells(section(&mood, "values"), "value"),
        ["sad", "ok", "it's fine"]
    );

    // the DDL builds the same structure in an empty schema
    let objects: [(&str, ObjectKind, bool); 11] = [
        ("mood", ObjectKind::Type, false),
        ("price", ObjectKind::Type, false),
        ("ticket", ObjectKind::Sequence, false),
        ("touch", ObjectKind::Routine, true),
        ("twice", ObjectKind::Routine, true),
        ("author", ObjectKind::Table, false),
        ("Book Shelf", ObjectKind::Table, false),
        ("log", ObjectKind::Table, false),
        ("log_2026", ObjectKind::Table, false),
        ("titles", ObjectKind::View, false),
        ("names", ObjectKind::Matview, false),
    ];
    let before: Vec<ObjectDetails> = objects
        .iter()
        .map(|(name, object, _)| detail(&mut s, k, "sc_det", name, *object))
        .collect();
    for (d, (name, ..)) in before.iter().zip(&objects) {
        assert!(d.ddl.is_some(), "no DDL for {name}");
    }
    run(&mut s, "DROP SCHEMA sc_det CASCADE");
    run(&mut s, "CREATE SCHEMA sc_det");
    for (d, (name, _, whole)) in before.iter().zip(&objects) {
        let ddl = d.ddl.as_deref().unwrap();
        // the foreign key and the view need the other tables: both come after them here
        let _ = name;
        run_ddl(&mut s, ddl, *whole);
    }
    for (old, (name, object, _)) in before.iter().zip(&objects) {
        let new = detail(&mut s, k, "sc_det", name, *object);
        assert_eq!(structure(old), structure(&new), "{name}");
        assert_eq!(old.ddl, new.ddl, "{name}");
    }
    run(&mut s, "DROP SCHEMA sc_det CASCADE");
}

fn mysql_details_round_trip(p: &Profile, maria: bool) {
    let mut s = open(p);
    let k = DbKind::Mysql;
    for sql in [
        "DROP VIEW IF EXISTS d_titles",
        "DROP TABLE IF EXISTS d_book",
        "DROP TABLE IF EXISTS d_author",
        "DROP FUNCTION IF EXISTS d_twice",
        "DROP PROCEDURE IF EXISTS d_count",
        "CREATE TABLE d_author (id int NOT NULL AUTO_INCREMENT, name varchar(100) NOT NULL COMMENT 'who', \
           PRIMARY KEY (id), UNIQUE KEY d_author_name (name)) ENGINE=InnoDB COMMENT='the authors'",
        "CREATE TABLE d_book (id int NOT NULL, author_id int NOT NULL, title varchar(200) DEFAULT 'untitled', \
           `Größe` decimal(6,2), shout varchar(200) GENERATED ALWAYS AS (upper(title)) VIRTUAL, \
           PRIMARY KEY (id), KEY d_book_by_title (title), \
           CONSTRAINT d_book_author FOREIGN KEY (author_id) REFERENCES d_author (id) ON DELETE CASCADE) ENGINE=InnoDB",
        "CREATE TRIGGER d_book_touch BEFORE UPDATE ON d_book FOR EACH ROW SET NEW.title = NEW.title",
        "CREATE VIEW d_titles AS SELECT b.title, a.name FROM d_book b JOIN d_author a ON a.id = b.author_id",
        "CREATE FUNCTION d_twice(n int) RETURNS int DETERMINISTIC RETURN n * 2",
        "CREATE PROCEDURE d_count(OUT n int) BEGIN SELECT COUNT(*) INTO n FROM d_book; END",
    ] {
        run(&mut s, sql);
    }
    let book = detail(&mut s, k, "shop", "d_book", ObjectKind::Table);
    let columns = section(&book, "columns");
    assert_eq!(
        cells(columns, "name"),
        ["id", "author_id", "title", "Größe", "shout"]
    );
    assert_eq!(cells(columns, "key")[..2], ["pk", "fk"]);
    assert!(
        cells(columns, "extra")[4]
            .to_lowercase()
            .contains("generated")
    );
    let refs = section(&book, "references");
    assert_eq!(cells(refs, "refName"), ["d_author"]);
    assert_eq!(cells(refs, "onDelete"), ["cascade"]);
    assert_eq!(cells(section(&book, "triggers"), "name"), ["d_book_touch"]);
    assert!(cells(section(&book, "indexes"), "name").contains(&"d_book_by_title".to_string()));
    let author = detail(&mut s, k, "shop", "d_author", ObjectKind::Table);
    assert_eq!(
        cells(section(&author, "referencedBy"), "refName"),
        ["d_book"]
    );
    assert_eq!(cells(section(&author, "columns"), "comment")[1], "who");
    assert!(cells(section(&author, "stats"), "value").contains(&"the authors".to_string()));
    let view = detail(&mut s, k, "shop", "d_titles", ObjectKind::View);
    if maria {
        // MariaDB does not say what a view reads: noted, not fatal
        assert!(view.notes.contains(&"uses".to_string()), "{:?}", view.notes);
    } else {
        assert_eq!(
            cells(section(&view, "uses"), "refName"),
            ["d_author", "d_book"]
        );
        assert_eq!(cells(section(&book, "usedBy"), "refName"), ["d_titles"]);
    }
    let procedure = detail(&mut s, k, "shop", "d_count", ObjectKind::Routine);
    assert_eq!(cells(section(&procedure, "parameters"), "mode"), ["out"]);

    let objects: [(&str, ObjectKind, bool); 5] = [
        ("d_author", ObjectKind::Table, false),
        ("d_book", ObjectKind::Table, false),
        ("d_titles", ObjectKind::View, true),
        ("d_twice", ObjectKind::Routine, true),
        ("d_count", ObjectKind::Routine, true),
    ];
    let before: Vec<ObjectDetails> = objects
        .iter()
        .map(|(name, object, _)| detail(&mut s, k, "shop", name, *object))
        .collect();
    for sql in [
        "DROP VIEW d_titles",
        "DROP TABLE d_book",
        "DROP TABLE d_author",
        "DROP FUNCTION d_twice",
        "DROP PROCEDURE d_count",
    ] {
        run(&mut s, sql);
    }
    for (d, (name, _, whole)) in before.iter().zip(&objects) {
        let ddl = d
            .ddl
            .as_deref()
            .unwrap_or_else(|| panic!("no DDL for {name}"));
        run_ddl(&mut s, ddl, *whole);
    }
    for (old, (name, object, _)) in before.iter().zip(&objects) {
        let new = detail(&mut s, k, "shop", name, *object);
        assert_eq!(structure(old), structure(&new), "{name}");
        assert_eq!(old.ddl, new.ddl, "{name}");
    }
    for sql in [
        "DROP VIEW d_titles",
        "DROP TABLE d_book",
        "DROP TABLE d_author",
        "DROP FUNCTION d_twice",
        "DROP PROCEDURE d_count",
    ] {
        run(&mut s, sql);
    }
}

#[test]
#[ignore = "needs the database containers"]
fn mysql_details_and_ddl_round_trip() {
    mysql_details_round_trip(&my(), false);
}

#[test]
#[ignore = "needs the database containers"]
fn mariadb_details_and_ddl_round_trip() {
    mysql_details_round_trip(&maria(), true);
}

/// SQL Server: batches end at `GO`; a batch that is a module (view, routine, trigger) is one statement.
fn run_tsql(s: &mut Box<dyn Session>, ddl: &str) {
    let mut batch = String::new();
    let mut batches = Vec::new();
    for line in ddl.lines() {
        if line.trim() == "GO" {
            batches.push(std::mem::take(&mut batch));
        } else {
            batch.push_str(line);
            batch.push('\n');
        }
    }
    batches.push(batch);
    for batch in batches.iter().map(|b| b.trim()).filter(|b| !b.is_empty()) {
        let module = [
            "CREATE VIEW",
            "CREATE PROC",
            "CREATE FUNCTION",
            "CREATE TRIGGER",
        ]
        .iter()
        .any(|w| batch.to_uppercase().starts_with(w));
        run_ddl(s, batch, module);
    }
}

#[test]
#[ignore = "needs the database containers"]
fn sqlserver_details_and_ddl_round_trip() {
    let mut s = open(&ms());
    let k = DbKind::Sqlserver;
    let drop = [
        "IF OBJECT_ID('sc_det.titles') IS NOT NULL DROP VIEW sc_det.titles",
        "IF OBJECT_ID('sc_det.twice') IS NOT NULL DROP FUNCTION sc_det.twice",
        "IF OBJECT_ID('sc_det.[Book Shelf]') IS NOT NULL DROP TABLE sc_det.[Book Shelf]",
        "IF OBJECT_ID('sc_det.author') IS NOT NULL DROP TABLE sc_det.author",
        "IF OBJECT_ID('sc_det.ticket') IS NOT NULL DROP SEQUENCE sc_det.ticket",
    ];
    for sql in drop {
        run(&mut s, sql);
    }
    for sql in [
        "IF SCHEMA_ID('sc_det') IS NULL EXEC('CREATE SCHEMA sc_det')",
        "CREATE SEQUENCE sc_det.ticket AS int START WITH 100 INCREMENT BY 5 MINVALUE 1 MAXVALUE 100000 NO CYCLE",
        "CREATE TABLE sc_det.author (id int IDENTITY(10, 2) NOT NULL, name nvarchar(100) NOT NULL, \
           CONSTRAINT author_pk PRIMARY KEY CLUSTERED (id), CONSTRAINT author_name UNIQUE NONCLUSTERED (name))",
        "CREATE TABLE sc_det.[Book Shelf] (id int NOT NULL, author_id int NOT NULL, \
           title nvarchar(200) NULL CONSTRAINT shelf_title DEFAULT ('untitled'), cost decimal(10, 2) NULL, \
           [Größe] decimal(6, 2) NULL, shout AS (upper([title])) PERSISTED, at datetime2(3) NULL, \
           CONSTRAINT shelf_pk PRIMARY KEY CLUSTERED (id), CONSTRAINT shelf_cost CHECK ([cost] < 1000), \
           CONSTRAINT shelf_author FOREIGN KEY (author_id) REFERENCES sc_det.author (id) ON DELETE CASCADE)",
        "CREATE NONCLUSTERED INDEX shelf_by_title ON sc_det.[Book Shelf] (title DESC) INCLUDE (cost) WHERE title IS NOT NULL",
        "CREATE TRIGGER sc_det.shelf_touch ON sc_det.[Book Shelf] AFTER UPDATE AS BEGIN SET NOCOUNT ON; END",
        "CREATE VIEW sc_det.titles AS SELECT b.title, a.name FROM sc_det.[Book Shelf] b JOIN sc_det.author a ON a.id = b.author_id",
        "CREATE FUNCTION sc_det.twice(@n int) RETURNS int AS BEGIN RETURN @n * 2; END",
    ] {
        run(&mut s, sql);
    }
    let shelf = detail(&mut s, k, "sc_det", "Book Shelf", ObjectKind::Table);
    assert!(shelf.notes.is_empty(), "{:?}", shelf.notes);
    let columns = section(&shelf, "columns");
    assert_eq!(
        cells(columns, "name"),
        ["id", "author_id", "title", "cost", "Größe", "shout", "at"]
    );
    assert_eq!(cells(columns, "key")[..2], ["pk", "fk"]);
    assert!(cells(columns, "extra")[5].starts_with("computed:"));
    assert_eq!(cells(columns, "type")[6], "datetime2(3)");
    let refs = section(&shelf, "references");
    assert_eq!(cells(refs, "refName"), ["author"]);
    assert_eq!(cells(refs, "onDelete"), ["cascade"]);
    assert_eq!(cells(section(&shelf, "triggers"), "name"), ["shelf_touch"]);
    assert!(cells(section(&shelf, "usedBy"), "refName").contains(&"titles".to_string()));
    let author = detail(&mut s, k, "sc_det", "author", ObjectKind::Table);
    assert_eq!(
        cells(section(&author, "referencedBy"), "refName"),
        ["Book Shelf"]
    );
    assert_eq!(cells(section(&author, "columns"), "extra")[0], "identity");
    let view = detail(&mut s, k, "sc_det", "titles", ObjectKind::View);
    assert_eq!(
        cells(section(&view, "uses"), "refName"),
        ["author", "Book Shelf"]
    );
    let function = detail(&mut s, k, "sc_det", "twice", ObjectKind::Routine);
    assert_eq!(cells(section(&function, "parameters"), "name"), ["@n"]);

    let objects: [(&str, ObjectKind); 5] = [
        ("ticket", ObjectKind::Sequence),
        ("author", ObjectKind::Table),
        ("Book Shelf", ObjectKind::Table),
        ("titles", ObjectKind::View),
        ("twice", ObjectKind::Routine),
    ];
    let before: Vec<ObjectDetails> = objects
        .iter()
        .map(|(name, object)| detail(&mut s, k, "sc_det", name, *object))
        .collect();
    for sql in drop {
        run(&mut s, sql);
    }
    for (d, (name, _)) in before.iter().zip(&objects) {
        run_tsql(
            &mut s,
            d.ddl
                .as_deref()
                .unwrap_or_else(|| panic!("no DDL for {name}")),
        );
    }
    for (old, (name, object)) in before.iter().zip(&objects) {
        let new = detail(&mut s, k, "sc_det", name, *object);
        assert_eq!(structure(old), structure(&new), "{name}");
        assert_eq!(old.ddl, new.ddl, "{name}");
    }
    for sql in drop {
        run(&mut s, sql);
    }
}

// --- the name index (prompt 020) -------------------------------------------------------------------

use schema_commander_lib::db::names::{self, Context, NameKind};

/// Reads the index of a server and finds a table, a routine and – once asked for – a column.
fn names_of(p: &Profile, kind: DbKind, schema: &str, create: &[&str], drop: &[&str]) {
    let mut s = open(p);
    for sql in drop.iter().chain(create) {
        run(&mut s, sql);
    }
    let mut index = names::read_objects(s.as_mut(), kind, &|| false).unwrap();
    assert!(!index.columns);
    let find = |index: &names::NameIndex, query: &str| {
        names::search(index, query, &Context::default(), kind).hits
    };
    let tables = find(&index, "sc_nm_ord_it");
    assert_eq!(tables[0].name, "sc_nm_order_items", "{tables:?}");
    assert_eq!(tables[0].kind, NameKind::Table);
    assert_eq!(tables[0].schema, schema);
    assert!(tables[0].quoted.ends_with("sc_nm_order_items"));
    let routines = find(&index, "f:sc_nm_twice");
    assert_eq!(routines[0].kind, NameKind::Routine, "{routines:?}");
    let views = find(&index, "v:sc_nm_open");
    assert_eq!(views[0].name, "sc_nm_open_items", "{views:?}");
    // the system's own objects are not in the index
    for system in ["pg_class", "sysobjects", "TABLES", "sqlite_schema"] {
        assert!(
            find(&index, system).iter().all(|h| h.name != system),
            "{system}"
        );
    }
    assert!(find(&index, "c:sc_nm_order_items.ord").is_empty());
    names::read_columns(s.as_mut(), kind, &mut index, &|| false).unwrap();
    let columns = find(&index, "c:sc_nm_order_items.ord");
    assert_eq!(columns[0].name, "order_id", "{columns:?}");
    assert_eq!(columns[0].parent.as_deref(), Some("sc_nm_order_items"));
    assert!(!columns[0].detail.is_empty());
    for sql in drop {
        run(&mut s, sql);
    }
}

#[test]
#[ignore = "needs the database containers"]
fn names_of_every_server() {
    names_of(
        &pg(),
        DbKind::Postgres,
        "public",
        &[
            "CREATE TABLE public.sc_nm_order_items (id int PRIMARY KEY, order_id int)",
            "CREATE VIEW public.sc_nm_open_items AS SELECT id FROM public.sc_nm_order_items",
            "CREATE FUNCTION public.sc_nm_twice(n int) RETURNS int LANGUAGE sql AS 'SELECT n * 2'",
        ],
        &[
            "DROP VIEW IF EXISTS public.sc_nm_open_items",
            "DROP TABLE IF EXISTS public.sc_nm_order_items",
            "DROP FUNCTION IF EXISTS public.sc_nm_twice(int)",
        ],
    );
    for p in [my(), maria()] {
        names_of(
            &p,
            DbKind::Mysql,
            "shop",
            &[
                "CREATE TABLE sc_nm_order_items (id int PRIMARY KEY, order_id int)",
                "CREATE VIEW sc_nm_open_items AS SELECT id FROM sc_nm_order_items",
                "CREATE FUNCTION sc_nm_twice(n int) RETURNS int DETERMINISTIC RETURN n * 2",
            ],
            &[
                "DROP VIEW IF EXISTS sc_nm_open_items",
                "DROP TABLE IF EXISTS sc_nm_order_items",
                "DROP FUNCTION IF EXISTS sc_nm_twice",
            ],
        );
    }
    names_of(
        &ms(),
        DbKind::Sqlserver,
        "dbo",
        &[
            "CREATE TABLE dbo.sc_nm_order_items (id int PRIMARY KEY, order_id int)",
            "CREATE VIEW dbo.sc_nm_open_items AS SELECT id FROM dbo.sc_nm_order_items",
            "CREATE FUNCTION dbo.sc_nm_twice(@n int) RETURNS int AS BEGIN RETURN @n * 2; END",
        ],
        &[
            "IF OBJECT_ID('dbo.sc_nm_open_items') IS NOT NULL DROP VIEW dbo.sc_nm_open_items",
            "IF OBJECT_ID('dbo.sc_nm_order_items') IS NOT NULL DROP TABLE dbo.sc_nm_order_items",
            "IF OBJECT_ID('dbo.sc_nm_twice') IS NOT NULL DROP FUNCTION dbo.sc_nm_twice",
        ],
    );
}

// --- what a database says about a failed statement (prompt 022) -----------------------------------

fn failure(s: &mut Box<dyn Session>, sql: &str) -> schema_commander_lib::error::AppError {
    s.query(sql, Limits::rows(MAX_ROWS), &|| false)
        .expect_err(sql)
}

#[test]
#[ignore = "needs the database containers"]
fn every_server_says_where_and_why_a_statement_failed() {
    // PostgreSQL: the character, the SQLSTATE, DETAIL and HINT, the constraint
    let mut s = open(&pg());
    let e = failure(&mut s, "SELECT 'ä😀',\n  nmae FROM (SELECT 1 AS name) t");
    let d = e.details.expect("details");
    assert_eq!(d.sqlstate.as_deref(), Some("42703"));
    // 12 characters, a line break and two blanks stand before `nmae`; the emoji is one character
    assert_eq!(d.position, Some(16));
    assert!(d.hint.is_some(), "{d:?}");
    for sql in [
        "DROP TABLE IF EXISTS sc_err_child",
        "DROP TABLE IF EXISTS sc_err_parent",
        "CREATE TABLE sc_err_parent (id int PRIMARY KEY)",
        "CREATE TABLE sc_err_child (parent_id int CONSTRAINT sc_err_fk REFERENCES sc_err_parent (id))",
    ] {
        run(&mut s, sql);
    }
    let e = failure(&mut s, "INSERT INTO sc_err_child VALUES (7)");
    let d = e.details.expect("details");
    assert_eq!(d.sqlstate.as_deref(), Some("23503"));
    assert!(
        d.detail.as_deref().is_some_and(|t| t.contains("(7)")),
        "{d:?}"
    );
    assert_eq!(d.constraint.as_deref(), Some("sc_err_fk"));
    assert_eq!(d.table.as_deref(), Some("sc_err_child"));
    assert_eq!(d.position, None);
    run(&mut s, "DROP TABLE sc_err_child");
    run(&mut s, "DROP TABLE sc_err_parent");

    // MySQL and MariaDB: the text it stumbled over and its line
    for p in [my(), maria()] {
        let mut s = open(&p);
        let e = failure(&mut s, "SELECT 1\nFROM dual\nWHERE 1 = = 2");
        let d = e.details.expect("details");
        assert_eq!(d.line, Some(3), "{d:?}");
        assert!(
            d.near.as_deref().is_some_and(|n| n.starts_with("= 2")),
            "{d:?}"
        );
        assert!(
            d.sqlstate.as_deref().is_some_and(|c| c.starts_with("1064")),
            "{d:?}"
        );
        // an error without a place still has its number
        let e = failure(&mut s, "SELECT * FROM sc_no_such_table");
        let d = e.details.expect("details");
        assert!(
            d.sqlstate.as_deref().is_some_and(|c| c.starts_with("1146")),
            "{d:?}"
        );
        assert_eq!(d.line, None);
    }

    // SQL Server: the number, the line of the batch and the name in quotes
    let mut s = open(&ms());
    let e = failure(&mut s, "SELECT 1\n\nFORM sys.objects");
    let d = e.details.expect("details");
    assert_eq!(d.line, Some(3), "{d:?}");
    assert!(d.near.is_some(), "{d:?}");
    assert_eq!(d.sqlstate.as_deref(), Some("102"));
    let e = failure(&mut s, "SELECT nmae FROM sys.objects");
    let d = e.details.expect("details");
    assert_eq!(d.near.as_deref(), Some("nmae"));
    assert_eq!(d.sqlstate.as_deref(), Some("207"));
}

use schema_commander_lib::db::Bind;
use schema_commander_lib::db::value::VecSink;

fn bound(s: &mut Box<dyn Session>, sql: &str, params: &[Bind]) -> QueryResult {
    let mut sink = VecSink::new(1000);
    let outcome = s
        .execute_bound(sql, params, Limits::rows(1000), &mut sink, &|| false)
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    QueryResult {
        columns: outcome.columns,
        rows: sink.rows,
        truncated: outcome.truncated,
        rows_affected: outcome.rows_affected,
        elapsed_ms: outcome.elapsed_ms,
    }
}

/// Prompt 025: values are bound, in the form the window writes the placeholders for each server
/// (`param-logic.ts`): text, whole numbers, exact decimals, booleans, dates, lists – and a text that looks
/// like SQL stays a text.
#[test]
#[ignore = "needs the database containers"]
fn every_server_binds_values() {
    let evil = "'; DROP TABLE sc_bind; --";
    let text = |v: &str| Bind::Text(v.into());
    let int = |v: &str| Bind::Int(v.into());
    // (profile, placeholder of value n, casts for decimal / date / datetime, boolean type)
    type Form = fn(usize) -> String;
    let cases: Vec<(Profile, Form, [&str; 3], &str, &str)> = vec![
        (
            pg(),
            |n| format!("${n}"),
            ["numeric", "date", "timestamp"],
            "boolean",
            "varchar(40)",
        ),
        (
            my(),
            |_| "?".into(),
            ["DECIMAL(65,30)", "DATE", "DATETIME(6)"],
            "boolean",
            "char(40)",
        ),
        (
            maria(),
            |_| "?".into(),
            ["DECIMAL(65,30)", "DATE", "DATETIME(6)"],
            "boolean",
            "char(40)",
        ),
        (
            ms(),
            |n| format!("@P{n}"),
            ["", "date", "datetime2"],
            "bit",
            "varchar(40)",
        ),
    ];
    for (p, ph, casts, boolean, chars) in cases {
        let kind = p.kind;
        let mut s = open(&p);
        let cast = |n: usize, ty: &str| {
            if ty.is_empty() {
                ph(n)
            } else {
                format!("CAST({} AS {ty})", ph(n))
            }
        };
        run(&mut s, "DROP TABLE IF EXISTS sc_bind");
        run(
            &mut s,
            &format!(
                "CREATE TABLE sc_bind (id int, name varchar(100), price decimal(20,6), ok {boolean}, day date)"
            ),
        );
        let insert = format!(
            "INSERT INTO sc_bind (id, name, price, ok, day) VALUES ({}, {}, {}, {}, {})",
            ph(1),
            ph(2),
            cast(3, casts[0]),
            ph(4),
            cast(5, casts[1]),
        );
        let done = bound(
            &mut s,
            &insert,
            &[
                int("7"),
                text(evil),
                Bind::Decimal("1234567890.123456".into()),
                Bind::Bool(true),
                Bind::Date("2026-11-11".into()),
            ],
        );
        assert_eq!(done.rows_affected, Some(1), "{kind:?}");
        bound(
            &mut s,
            &insert,
            &[
                int("8"),
                text("ä😀"),
                Bind::Decimal("-0.5".into()),
                Bind::Bool(false),
                Bind::Date("2020-02-29".into()),
            ],
        );
        // the text that looks like SQL did nothing and is found as text; the decimal kept every digit
        let found = bound(
            &mut s,
            &format!(
                "SELECT id, CAST(price AS {chars}), CAST(day AS {chars}) FROM sc_bind WHERE name = {} AND ok = {}",
                ph(1),
                ph(2)
            ),
            &[text(evil), Bind::Bool(true)],
        );
        assert_eq!(
            rows(&found),
            serde_json::json!([[7, "1234567890.123456", "2026-11-11"]]),
            "{kind:?}"
        );
        // a list: one placeholder per value; a date and a time compared as what they are
        let list = bound(
            &mut s,
            &format!(
                "SELECT id FROM sc_bind WHERE id IN ({}, {}, {}) AND day >= {} AND day < {} ORDER BY id",
                ph(1),
                ph(2),
                ph(3),
                cast(4, casts[1]),
                cast(5, casts[2]),
            ),
            &[
                int("7"),
                int("8"),
                int("99"),
                Bind::Date("2026-01-01".into()),
                Bind::Datetime("2027-01-01 00:00:00".into()),
            ],
        );
        assert_eq!(rows(&list), serde_json::json!([[7]]), "{kind:?}");
        // a whole number compared with a decimal column, and the session is fine afterwards
        let cmp = bound(
            &mut s,
            &format!("SELECT count(*) FROM sc_bind WHERE price > {}", ph(1)),
            &[int("0")],
        );
        assert_eq!(rows(&cmp), serde_json::json!([[1]]), "{kind:?}");
        assert_eq!(
            rows(&run(&mut s, "SELECT count(*) FROM sc_bind")),
            serde_json::json!([[2]])
        );
        run(&mut s, "DROP TABLE sc_bind");
    }
}

// --- foreign keys (prompt 030) ---------------------------------------------------------------------

use schema_commander_lib::db::filter::{self, KeyColumn, KeySet, TableQuery, ValueKind};
use schema_commander_lib::db::relations::{ForeignKey, relations};

fn key_line(k: &ForeignKey) -> String {
    format!(
        "{}.{}({}) -> {}.{}({})",
        k.schema,
        k.table,
        k.columns.join(","),
        k.ref_schema,
        k.ref_table,
        k.ref_columns.join(",")
    )
}

fn key_lines(keys: &[ForeignKey]) -> Vec<String> {
    let mut lines: Vec<String> = keys.iter().map(key_line).collect();
    lines.sort();
    lines
}

/// The same tables on every server: a key over two columns, a key into another schema, a table that
/// points to itself. Then the rows are followed with the statements the app builds – values bound.
#[test]
#[ignore]
fn every_server_knows_its_foreign_keys_and_follows_them() {
    let cases: Vec<(Profile, Vec<&str>, [&str; 2])> = vec![
        (
            pg(),
            vec![
                "DROP SCHEMA IF EXISTS sc_fk_a CASCADE",
                "DROP SCHEMA IF EXISTS sc_fk_b CASCADE",
                "CREATE SCHEMA sc_fk_a",
                "CREATE SCHEMA sc_fk_b",
            ],
            ["int", "varchar(10)"],
        ),
        (
            my(),
            vec![
                "DROP DATABASE IF EXISTS sc_fk_a",
                "DROP DATABASE IF EXISTS sc_fk_b",
                "CREATE DATABASE sc_fk_a",
                "CREATE DATABASE sc_fk_b",
            ],
            ["int", "varchar(10)"],
        ),
        (
            maria(),
            vec![
                "DROP DATABASE IF EXISTS sc_fk_a",
                "DROP DATABASE IF EXISTS sc_fk_b",
                "CREATE DATABASE sc_fk_a",
                "CREATE DATABASE sc_fk_b",
            ],
            ["int", "varchar(10)"],
        ),
        (
            ms(),
            vec![
                "IF OBJECT_ID('sc_fk_a.line') IS NOT NULL DROP TABLE sc_fk_a.line",
                "IF OBJECT_ID('sc_fk_a.person') IS NOT NULL DROP TABLE sc_fk_a.person",
                "IF OBJECT_ID('sc_fk_a.stock') IS NOT NULL DROP TABLE sc_fk_a.stock",
                "IF OBJECT_ID('sc_fk_b.country') IS NOT NULL DROP TABLE sc_fk_b.country",
                "IF SCHEMA_ID('sc_fk_a') IS NULL EXEC('CREATE SCHEMA sc_fk_a')",
                "IF SCHEMA_ID('sc_fk_b') IS NULL EXEC('CREATE SCHEMA sc_fk_b')",
            ],
            ["int", "varchar(10)"],
        ),
    ];
    for (p, setup, [int, text]) in cases {
        let kind = p.kind;
        let mut s = open(&p);
        for sql in setup {
            run(&mut s, sql);
        }
        for sql in [
            format!("CREATE TABLE sc_fk_b.country (code {text} NOT NULL PRIMARY KEY, name {text})"),
            format!(
                "CREATE TABLE sc_fk_a.stock (warehouse {int} NOT NULL, item {text} NOT NULL, qty {int}, \
                 PRIMARY KEY (warehouse, item))"
            ),
            format!(
                "CREATE TABLE sc_fk_a.person (id {int} NOT NULL PRIMARY KEY, boss_id {int}, country {text}, \
                 CONSTRAINT person_boss FOREIGN KEY (boss_id) REFERENCES sc_fk_a.person (id), \
                 CONSTRAINT person_country FOREIGN KEY (country) REFERENCES sc_fk_b.country (code))"
            ),
            // the columns of the key in another order than those of the table
            format!(
                "CREATE TABLE sc_fk_a.line (id {int} NOT NULL PRIMARY KEY, item {text}, warehouse {int}, \
                 CONSTRAINT line_stock FOREIGN KEY (warehouse, item) \
                 REFERENCES sc_fk_a.stock (warehouse, item))"
            ),
            "INSERT INTO sc_fk_b.country VALUES ('DE', 'x'), ('FR', 'y')".to_string(),
            "INSERT INTO sc_fk_a.stock VALUES (1, 'A', 5), (1, 'B', 0), (2, 'A', 9)".to_string(),
            "INSERT INTO sc_fk_a.person VALUES (1, NULL, 'DE'), (2, 1, 'DE'), (3, 1, NULL), (4, 2, 'FR')"
                .to_string(),
            "INSERT INTO sc_fk_a.line VALUES (10, 'A', 1), (11, 'A', 2), (12, 'B', 1), (13, NULL, 1)"
                .to_string(),
        ] {
            run(&mut s, &sql);
        }
        let stop = &|| false;
        let person = relations(s.as_mut(), kind, "sc_fk_a", "person", stop).unwrap();
        assert_eq!(
            key_lines(&person.outgoing),
            [
                "sc_fk_a.person(boss_id) -> sc_fk_a.person(id)",
                "sc_fk_a.person(country) -> sc_fk_b.country(code)"
            ],
            "{kind:?}"
        );
        // the table points to itself: the key is also one that points to it
        assert_eq!(
            key_lines(&person.incoming),
            ["sc_fk_a.person(boss_id) -> sc_fk_a.person(id)"],
            "{kind:?}"
        );
        let country = relations(s.as_mut(), kind, "sc_fk_b", "country", stop).unwrap();
        assert!(country.outgoing.is_empty(), "{kind:?}");
        assert_eq!(
            key_lines(&country.incoming),
            ["sc_fk_a.person(country) -> sc_fk_b.country(code)"],
            "{kind:?}"
        );
        // a key over two columns keeps the order of the key
        let line = relations(s.as_mut(), kind, "sc_fk_a", "line", stop).unwrap();
        assert_eq!(
            key_lines(&line.outgoing),
            ["sc_fk_a.line(warehouse,item) -> sc_fk_a.stock(warehouse,item)"],
            "{kind:?}"
        );
        let none = relations(s.as_mut(), kind, "sc_fk_a", "no_such_table", stop).unwrap();
        assert!(
            none.outgoing.is_empty() && none.incoming.is_empty(),
            "{kind:?}"
        );

        // following: the statements the app builds, with every value bound
        let column = |name: &str, number: bool| KeyColumn {
            column: name.into(),
            kind: if number {
                ValueKind::Number
            } else {
                ValueKind::Text
            },
            type_name: if number {
                "int4".into()
            } else {
                "varchar".into()
            },
        };
        let follow =
            |s: &mut Box<dyn Session>, table: &str, schema: &str, keys: KeySet, count: bool| {
                let q = TableQuery {
                    schema: Some(schema.into()),
                    table: table.into(),
                    keys: Some(keys),
                    count,
                    ..TableQuery::default()
                };
                let built = filter::build(kind, &q).unwrap();
                bound(s, &built.sql, &built.params)
            };
        // forward over the composite key: the lines (1,A) and (2,A) → two rows of stock
        let stock = follow(
            &mut s,
            "stock",
            "sc_fk_a",
            KeySet {
                columns: vec![column("warehouse", true), column("item", false)],
                rows: vec![vec!["1".into(), "A".into()], vec!["2".into(), "A".into()]],
            },
            false,
        );
        assert_eq!(stock.rows.len(), 2, "{kind:?}");
        // backward to itself: who has person 1 as boss – and counted
        let team = follow(
            &mut s,
            "person",
            "sc_fk_a",
            KeySet {
                columns: vec![column("boss_id", true)],
                rows: vec![vec!["1".into()]],
            },
            true,
        );
        assert_eq!(rows(&team), json!([[2]]), "{kind:?}");
        // into the other schema, with a value that looks like SQL: bound, it finds nothing and harms nothing
        let evil = follow(
            &mut s,
            "country",
            "sc_fk_b",
            KeySet {
                columns: vec![column("code", false)],
                rows: vec![
                    vec!["DE".into()],
                    vec!["'; DROP TABLE sc_fk_b.country; --".into()],
                ],
            },
            false,
        );
        assert_eq!(evil.rows.len(), 1, "{kind:?}");
        assert_eq!(
            rows(&run(&mut s, "SELECT COUNT(*) FROM sc_fk_b.country")),
            json!([[2]])
        );
    }
}

// --- writing changed cells (prompt 031) -------------------------------------------------------------

use schema_commander_lib::db::edit::{self, CellValue, RowUpdate, SetCell, UpdatePlan};

/// The statements the app builds for changed cells, on every server: what counts as „one row changed“,
/// values that look like SQL, NULL and DEFAULT, the lock on old values, and a trigger.
#[test]
#[ignore]
fn every_server_writes_changed_cells_one_row_at_a_time() {
    // (profile, schema, type of the money column as the result names it, a trigger that counts updates)
    let cases: Vec<(Profile, &str, &str, Vec<&str>)> = vec![
        (
            pg(),
            "public",
            "numeric(10,2)",
            vec![
                "CREATE OR REPLACE FUNCTION sc_edit_touch() RETURNS trigger LANGUAGE plpgsql AS \
                 'BEGIN NEW.touched := OLD.touched + 1; RETURN NEW; END'",
                "CREATE TRIGGER sc_edit_t BEFORE UPDATE ON sc_edit FOR EACH ROW EXECUTE FUNCTION sc_edit_touch()",
            ],
        ),
        (
            my(),
            "shop",
            "decimal(10,2)",
            vec![
                "CREATE TRIGGER sc_edit_t BEFORE UPDATE ON sc_edit FOR EACH ROW SET NEW.touched = OLD.touched + 1",
            ],
        ),
        (
            maria(),
            "shop",
            "decimal(10,2)",
            vec![
                "CREATE TRIGGER sc_edit_t BEFORE UPDATE ON sc_edit FOR EACH ROW SET NEW.touched = OLD.touched + 1",
            ],
        ),
        (
            ms(),
            "dbo",
            "decimal(10,2)",
            // a trigger that changes rows itself and does not hide its counts
            vec![
                "CREATE TRIGGER sc_edit_t ON sc_edit AFTER UPDATE AS \
                 UPDATE sc_edit SET touched = sc_edit.touched + 1 FROM sc_edit JOIN inserted i ON i.id = sc_edit.id \
                 WHERE NOT UPDATE(touched)",
            ],
        ),
    ];
    for (p, schema, money, trigger) in cases {
        let kind = p.kind;
        let mut s = open(&p);
        run(&mut s, "DROP TABLE IF EXISTS sc_edit");
        run(
            &mut s,
            // SQL Server keeps Unicode only in its n-types
            &format!(
                "CREATE TABLE sc_edit (id int NOT NULL PRIMARY KEY, name {}(100), qty int, \
                 price decimal(10,2), note varchar(200) DEFAULT 'none', touched int NOT NULL DEFAULT 0)",
                if kind == DbKind::Sqlserver {
                    "nvarchar"
                } else {
                    "varchar"
                }
            ),
        );
        run(
            &mut s,
            "INSERT INTO sc_edit (id, name, qty, price, note) VALUES (1, 'a', 1, 1.50, NULL), (2, 'b', 2, 2.50, 'x')",
        );
        for sql in trigger {
            run(&mut s, sql);
        }
        let cell = |column: &str, value: Option<&str>, number: bool, type_name: &str| CellValue {
            column: column.into(),
            kind: if number {
                ValueKind::Number
            } else {
                ValueKind::Text
            },
            type_name: type_name.into(),
            value: value.map(str::to_owned),
        };
        let set = |column: &str, value: Option<&str>, number: bool, type_name: &str| SetCell {
            column: column.into(),
            kind: if number {
                ValueKind::Number
            } else {
                ValueKind::Text
            },
            type_name: type_name.into(),
            value: value.map(str::to_owned),
            default: false,
        };
        let write = |s: &mut Box<dyn Session>, row: RowUpdate| {
            let plan = UpdatePlan {
                schema: Some(schema.into()),
                table: "sc_edit".into(),
                rows: vec![row],
                ..UpdatePlan::default()
            };
            let built = edit::build(kind, &plan).unwrap();
            bound(s, &built[0].sql, &built[0].params).rows_affected
        };
        let evil = "it's \\ \"ä😀\"; DROP TABLE sc_edit; --";
        // several cells of a row, with the old values as a lock (one of them NULL)
        let changed = write(
            &mut s,
            RowUpdate {
                key: vec![cell("id", Some("1"), true, "int4")],
                set: vec![
                    set("name", Some(evil), false, "varchar"),
                    set("qty", Some("7"), true, "int4"),
                    set("price", Some("1234.56"), true, money),
                ],
                expect: vec![
                    cell("name", Some("a"), false, "varchar"),
                    cell("qty", Some("1"), true, "int4"),
                    cell("note", None, false, "varchar"),
                ],
            },
        );
        assert_eq!(changed, Some(1), "{kind:?}");
        // the same again: the row is not what the lock expects any more – no row, nothing written
        let stale = write(
            &mut s,
            RowUpdate {
                key: vec![cell("id", Some("1"), true, "int4")],
                set: vec![set("qty", Some("99"), true, "int4")],
                expect: vec![cell("qty", Some("1"), true, "int4")],
            },
        );
        assert_eq!(stale, Some(0), "{kind:?}");
        // NULL and DEFAULT; a row that does not exist changes nothing
        let null = write(
            &mut s,
            RowUpdate {
                key: vec![cell("id", Some("2"), true, "int4")],
                set: vec![
                    set("name", None, false, "varchar"),
                    SetCell {
                        default: true,
                        ..set("note", None, false, "varchar")
                    },
                ],
                expect: vec![],
            },
        );
        assert_eq!(null, Some(1), "{kind:?}");
        let gone = write(
            &mut s,
            RowUpdate {
                key: vec![cell("id", Some("3"), true, "int4")],
                set: vec![set("qty", Some("1"), true, "int4")],
                expect: vec![],
            },
        );
        assert_eq!(gone, Some(0), "{kind:?}");
        // a cell set to the value it has is still one row found (the user typed the same value again)
        let same = write(
            &mut s,
            RowUpdate {
                key: vec![cell("id", Some("2"), true, "int4")],
                set: vec![set("qty", Some("2"), true, "int4")],
                expect: vec![],
            },
        );
        assert_eq!(same, Some(1), "{kind:?}");
        let chars = if kind == DbKind::Sqlserver || kind == DbKind::Postgres {
            "varchar(40)"
        } else {
            "char(40)"
        };
        let after = run(
            &mut s,
            &format!(
                "SELECT id, name, qty, CAST(price AS {chars}), note, touched FROM sc_edit ORDER BY id"
            ),
        );
        // what looked like SQL is the name; the trigger ran once per written row
        assert_eq!(
            rows(&after),
            json!([
                [1, evil, 7, "1234.56", null, 1],
                [2, null, 2, "2.50", "none", 2]
            ]),
            "{kind:?}"
        );
        run(&mut s, "DROP TABLE sc_edit");
    }
}

/// Review 031: a value must arrive as it was typed. PostgreSQL's `character(n)` and `bit(n)` (the driver
/// names them `CHAR` and `BIT`, and a cast to those keeps one character), and SQL Server's `datetime`
/// under a login whose language reads day and month the other way round. The type names are the ones
/// the drivers report for a result – what the window sends back.
#[test]
#[ignore]
fn values_keep_their_length_and_their_day_when_they_are_written() {
    let write =
        |s: &mut Box<dyn Session>, kind: DbKind, schema: &str, table: &str, row: RowUpdate| {
            let plan = UpdatePlan {
                schema: Some(schema.into()),
                table: table.into(),
                rows: vec![row],
                ..UpdatePlan::default()
            };
            let built = edit::build(kind, &plan).unwrap();
            bound(s, &built[0].sql, &built[0].params).rows_affected
        };
    let cell = |column: &str, value: &str, type_name: &str| CellValue {
        column: column.into(),
        kind: ValueKind::Text,
        type_name: type_name.into(),
        value: Some(value.into()),
    };
    let set = |column: &str, value: &str, type_name: &str| SetCell {
        column: column.into(),
        kind: ValueKind::Text,
        type_name: type_name.into(),
        value: Some(value.into()),
        default: false,
    };

    // PostgreSQL: a key and a value of character(n), a value of bit(n)
    let mut s = open(&pg());
    run(&mut s, "DROP TABLE IF EXISTS sc_char");
    run(
        &mut s,
        "CREATE TABLE sc_char (code character(10) PRIMARY KEY, land character(3), flags bit(4))",
    );
    run(
        &mut s,
        "INSERT INTO sc_char VALUES ('AB', 'DE', B'0000'), ('A', 'FR', B'0000')",
    );
    let shown = run(
        &mut s,
        "SELECT code, land, flags FROM sc_char ORDER BY code",
    );
    let types: Vec<String> = shown.columns.iter().map(|c| c.type_name.clone()).collect();
    let changed = write(
        &mut s,
        DbKind::Postgres,
        "public",
        "sc_char",
        RowUpdate {
            // the key as the result shows it (padded or not, as the driver gives it)
            key: vec![cell("code", "AB", &types[0])],
            set: vec![
                set("land", "USA", &types[1]),
                set("flags", "1010", &types[2]),
            ],
            expect: vec![cell("land", "DE", &types[1])],
        },
    );
    assert_eq!(changed, Some(1), "types {types:?}");
    let after = run(
        &mut s,
        "SELECT rtrim(code), rtrim(land), flags::text FROM sc_char ORDER BY code",
    );
    // the row with the key 'AB' got all three characters; the row 'A' is untouched
    assert_eq!(
        rows(&after),
        json!([["A", "FR", "0000"], ["AB", "USA", "1010"]]),
        "types {types:?}"
    );
    run(&mut s, "DROP TABLE sc_char");

    // SQL Server: a datetime under a language that reads 03-04 as the 3rd of April
    let mut s = open(&ms());
    run(&mut s, "DROP TABLE IF EXISTS sc_when");
    run(
        &mut s,
        "CREATE TABLE sc_when (id int NOT NULL PRIMARY KEY, at datetime, small smalldatetime, note varchar(40))",
    );
    run(
        &mut s,
        "INSERT INTO sc_when VALUES (1, '2024-01-20T08:00:00', '2024-01-20T08:00:00', 'x')",
    );
    run(&mut s, "SET LANGUAGE Deutsch");
    let shown = run(&mut s, "SELECT id, at, small, note FROM sc_when");
    let types: Vec<String> = shown.columns.iter().map(|c| c.type_name.clone()).collect();
    let old = rows(&shown)[0][1].as_str().unwrap().to_owned();
    let changed = write(
        &mut s,
        DbKind::Sqlserver,
        "dbo",
        "sc_when",
        RowUpdate {
            key: vec![CellValue {
                kind: ValueKind::Number,
                ..cell("id", "1", &types[0])
            }],
            set: vec![
                set("at", "2024-03-04 10:00:00.000", &types[1]),
                set("small", "2024-03-04 10:00:00", &types[2]),
                // a text that looks like a date stays the text it is
                set("note", "2024-03-04 10:00:00", &types[3]),
            ],
            // the lock: the old value as the result showed it (the 20th could not be a month)
            expect: vec![cell("at", &old, &types[1])],
        },
    );
    assert_eq!(changed, Some(1), "types {types:?}, old {old}");
    let after = run(
        &mut s,
        "SELECT CONVERT(varchar(30), at, 126), CONVERT(varchar(30), small, 126), note FROM sc_when",
    );
    assert_eq!(
        rows(&after),
        json!([[
            "2024-03-04T10:00:00",
            "2024-03-04T10:00:00",
            "2024-03-04 10:00:00"
        ]]),
        "types {types:?}"
    );
    run(&mut s, "DROP TABLE sc_when");
}

// --- inserting and deleting rows (prompt 032) --------------------------------------------------------

use schema_commander_lib::db::edit::{RowDelete, RowInsert};

/// New rows and rows to delete on every server: a shared INSERT reports all its rows, a row of nothing
/// but defaults can be made, the database's key comes back where it can, and a row that others point to
/// is not deleted.
#[test]
#[ignore]
fn every_server_inserts_and_deletes_rows() {
    // (profile, schema, the column that numbers itself)
    let cases: Vec<(Profile, &str, &str)> = vec![
        (
            pg(),
            "public",
            "id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
        ),
        (my(), "shop", "id int AUTO_INCREMENT PRIMARY KEY"),
        (maria(), "shop", "id int AUTO_INCREMENT PRIMARY KEY"),
        (ms(), "dbo", "id int IDENTITY PRIMARY KEY"),
    ];
    for (p, schema, id_column) in cases {
        let kind = p.kind;
        let mut s = open(&p);
        run(&mut s, "DROP TABLE IF EXISTS sc_child");
        run(&mut s, "DROP TABLE IF EXISTS sc_rows");
        run(
            &mut s,
            &format!(
                "CREATE TABLE sc_rows ({id_column}, name varchar(40) DEFAULT 'none', qty int DEFAULT 7)"
            ),
        );
        run(
            &mut s,
            // as a constraint of the table: MySQL reads a REFERENCES at the column and ignores it
            "CREATE TABLE sc_child (id int PRIMARY KEY, row_id int NOT NULL, \
             CONSTRAINT sc_child_row FOREIGN KEY (row_id) REFERENCES sc_rows (id))",
        );
        let set = |column: &str, value: Option<&str>, number: bool| SetCell {
            column: column.into(),
            kind: if number {
                ValueKind::Number
            } else {
                ValueKind::Text
            },
            type_name: if number {
                "int4".into()
            } else {
                "varchar".into()
            },
            value: value.map(str::to_owned),
            default: false,
        };
        let plan = UpdatePlan {
            schema: Some(schema.into()),
            table: "sc_rows".into(),
            inserts: vec![
                RowInsert {
                    set: vec![
                        set("name", Some("it's"), false),
                        set("qty", Some("1"), true),
                    ],
                },
                RowInsert {
                    set: vec![set("name", None, false), set("qty", Some("2"), true)],
                },
                // only a name: qty gets its default
                RowInsert {
                    set: vec![set("name", Some("ä😀"), false)],
                },
                // nothing at all: the row the database makes of its own
                RowInsert { set: vec![] },
            ],
            returning: Some("id".into()),
            ..UpdatePlan::default()
        };
        let steps = edit::steps(kind, &plan).unwrap();
        assert_eq!(
            steps.iter().map(|x| x.rows).collect::<Vec<_>>(),
            [2, 1, 1],
            "{kind:?}"
        );
        let mut returned: Vec<Value> = Vec::new();
        for step in &steps {
            let done = bound(&mut s, &step.built.sql, &step.built.params);
            if step.returns {
                // the rows that come back say how many were made, and with which key
                assert_eq!(done.rows.len(), step.rows, "{kind:?}");
                returned.extend(rows(&done).as_array().unwrap().iter().map(|r| r[0].clone()));
            } else {
                assert_eq!(
                    done.rows_affected,
                    Some(step.rows as u64),
                    "{kind:?}: {}",
                    step.built.sql
                );
            }
        }
        if kind == DbKind::Postgres {
            assert_eq!(returned, [json!(1), json!(2), json!(3), json!(4)]);
        }
        // Unicode needs an n-type on SQL Server: look at what every server keeps
        let after = run(&mut s, "SELECT id, qty FROM sc_rows ORDER BY id");
        assert_eq!(
            rows(&after),
            json!([[1, 1], [2, 2], [3, 7], [4, 7]]),
            "{kind:?}"
        );
        let first = run(
            &mut s,
            "SELECT name FROM sc_rows WHERE id IN (1, 2, 4) ORDER BY id",
        );
        assert_eq!(
            rows(&first),
            json!([["it's"], [null], ["none"]]),
            "{kind:?}"
        );

        // deleting: exactly the row; a row that is gone changes none; a row others point to stays
        run(&mut s, "INSERT INTO sc_child VALUES (1, 2)");
        let delete = |s: &mut Box<dyn Session>, id: &str, qty: Option<&str>| {
            let plan = UpdatePlan {
                schema: Some(schema.into()),
                table: "sc_rows".into(),
                deletes: vec![RowDelete {
                    key: vec![CellValue {
                        column: "id".into(),
                        kind: ValueKind::Number,
                        type_name: "int4".into(),
                        value: Some(id.into()),
                    }],
                    expect: qty
                        .map(|q| CellValue {
                            column: "qty".into(),
                            kind: ValueKind::Number,
                            type_name: "int4".into(),
                            value: Some(q.into()),
                        })
                        .into_iter()
                        .collect(),
                }],
                ..UpdatePlan::default()
            };
            let step = &edit::steps(kind, &plan).unwrap()[0];
            let mut sink = VecSink::new(1);
            s.execute_bound(
                &step.built.sql,
                &step.built.params,
                Limits::rows(1),
                &mut sink,
                &|| false,
            )
            .map(|o| o.rows_affected)
        };
        assert_eq!(delete(&mut s, "1", Some("1")).unwrap(), Some(1), "{kind:?}");
        assert_eq!(delete(&mut s, "1", None).unwrap(), Some(0), "{kind:?}");
        // the lock: qty is 7, not 8
        assert_eq!(delete(&mut s, "3", Some("8")).unwrap(), Some(0), "{kind:?}");
        let held = delete(&mut s, "2", None).unwrap_err();
        assert_eq!(held.code, ErrorCode::InvalidQuery, "{kind:?}");
        assert_eq!(
            rows(&run(&mut s, "SELECT COUNT(*) FROM sc_rows")),
            json!([[3]]),
            "{kind:?}"
        );
        run(&mut s, "DROP TABLE sc_child");
        run(&mut s, "DROP TABLE sc_rows");
    }
}

/// Review 032: after a statement for several new rows failed, its rows are tried one by one from a
/// savepoint inside the same transaction. The statements the app uses for that must work where it uses
/// them: PostgreSQL (whose transaction is aborted by the failure until it goes back) and SQL Server.
#[test]
#[ignore]
fn a_failed_insert_can_be_tried_again_from_a_savepoint() {
    let cases = [
        (
            pg(),
            "BEGIN",
            "SAVEPOINT sc_rows",
            "ROLLBACK TO SAVEPOINT sc_rows",
        ),
        (
            ms(),
            "BEGIN TRANSACTION",
            "SAVE TRANSACTION sc_rows",
            "ROLLBACK TRANSACTION sc_rows",
        ),
    ];
    for (p, begin, mark, back) in cases {
        let kind = p.kind;
        let mut s = open(&p);
        run(&mut s, "DROP TABLE IF EXISTS sc_save");
        run(
            &mut s,
            "CREATE TABLE sc_save (id int NOT NULL PRIMARY KEY, name varchar(20) NOT NULL)",
        );
        run(&mut s, begin);
        run(&mut s, "INSERT INTO sc_save VALUES (1, 'before')");
        run(&mut s, mark);
        let failed = s.query(
            "INSERT INTO sc_save VALUES (2, 'ok'), (3, NULL)",
            Limits::rows(1),
            &|| false,
        );
        assert!(failed.is_err(), "{kind:?}");
        run(&mut s, back);
        // the transaction goes on from the savepoint: what the plan did before is still there
        run(&mut s, "INSERT INTO sc_save VALUES (2, 'ok')");
        assert!(
            s.query(
                "INSERT INTO sc_save VALUES (3, NULL)",
                Limits::rows(1),
                &|| false
            )
            .is_err(),
            "{kind:?}"
        );
        // and in the end nothing of it stays
        if s.is_open() {
            let _ = s.query("ROLLBACK", Limits::rows(1), &|| false);
        }
        assert_eq!(
            rows(&run(&mut s, "SELECT COUNT(*) FROM sc_save")),
            json!([[0]]),
            "{kind:?}"
        );
        run(&mut s, "DROP TABLE sc_save");
    }
}

// ── Import of a file into a table (prompt 033) ───────────────────────────────

use schema_commander_lib::data_import::{Source, SourceOptions};
use schema_commander_lib::db::load::{
    DateOrder, LoadPlan, Loaded, Mapping, OnError, TargetColumn, load,
};
use schema_commander_lib::export::{FileFormat, FileSink, Spec};

/// The mapping of the test tables, with the types as the catalog of the server names them.
fn load_plan(s: &mut Box<dyn Session>, kind: DbKind, table: &str, local: bool) -> LoadPlan {
    let schema = match kind {
        DbKind::Postgres => "public",
        DbKind::Mysql => "shop",
        DbKind::Sqlserver => "dbo",
        DbKind::Sqlite => "main",
    };
    let info = meta::table(s.as_mut(), kind, schema, table, &|| false).unwrap();
    let mappings = info
        .columns
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let value_kind = match c.name.as_str() {
                "id" | "amount" => ValueKind::Number,
                // also MySQL's `tinyint(1)`: its driver calls that a boolean, an export writes `true`
                "ok" => ValueKind::Bool,
                _ => ValueKind::Text,
            };
            Mapping {
                source: Some(i),
                fixed: None,
                target: TargetColumn {
                    name: c.name.clone(),
                    kind: value_kind,
                    type_name: c.type_name.clone(),
                },
                trim: false,
                // the file of the test is written the German way; an export is not
                decimal_comma: local && value_kind == ValueKind::Number,
                date_order: (local && c.name == "day").then_some(DateOrder::Dmy),
            }
        })
        .collect();
    LoadPlan {
        schema: Some(schema.into()),
        table: table.into(),
        mappings,
        null_texts: vec!["NULL".into()],
        empty_is_null: true,
        clear_first: false,
        on_error: OnError::Abort,
        whole_transaction: true,
        exact: false,
    }
}

fn load_file(
    s: &mut Box<dyn Session>,
    kind: DbKind,
    path: &std::path::Path,
    plan: &LoadPlan,
    errors: Option<&std::path::Path>,
    stop: &(dyn Fn() -> bool + Sync),
) -> Loaded {
    load_file_seen(s, kind, path, plan, errors, &|_| {}, stop)
}

fn load_file_seen(
    s: &mut Box<dyn Session>,
    kind: DbKind,
    path: &std::path::Path,
    plan: &LoadPlan,
    errors: Option<&std::path::Path>,
    progress: &dyn Fn(u64),
    stop: &(dyn Fn() -> bool + Sync),
) -> Loaded {
    let mut source = Source::open(path, &SourceOptions::default()).unwrap();
    load(
        s.as_mut(),
        kind,
        &mut source,
        plan,
        errors,
        None,
        progress,
        stop,
    )
    .unwrap()
}

/// Loads a file with good and bad rows into a table of every server – leaving bad rows out, and all or
/// nothing –, then writes the table to a file with the export (prompt 011) and loads that into a second
/// table: both hold the same.
#[test]
#[ignore]
fn a_file_is_loaded_into_a_table_and_comes_back_the_same() {
    const GOOD: u64 = 3_000;
    for (p, product) in [
        (pg(), "postgres"),
        (my(), "mysql"),
        (maria(), "mariadb"),
        (ms(), "sqlserver"),
    ] {
        let kind = p.kind;
        let mut s = open(&p);
        let (text, long, boolean) = match kind {
            DbKind::Sqlserver => ("nvarchar(20)", "nvarchar(max)", "bit"),
            DbKind::Mysql => ("varchar(20)", "text", "tinyint(1)"),
            _ => ("varchar(20)", "text", "boolean"),
        };
        for table in ["sc_load", "sc_load2"] {
            run(&mut s, &format!("DROP TABLE IF EXISTS {table}"));
            run(
                &mut s,
                &format!(
                    "CREATE TABLE {table} (id int NOT NULL PRIMARY KEY, name {text} NOT NULL, \
                     amount decimal(12,2), day date, ok {boolean}, note {long})"
                ),
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("in.csv");
        let mut csv = String::from("id;name;amount;day;ok;note\n");
        for i in 1..=GOOD {
            csv.push_str(&format!(
                "{i};name {i};{},{:02};{:02}.{:02}.2026;{};\"note; with \"\"quotes\"\"\nand a second line {i}\"\n",
                i * 3,
                i % 100,
                i % 28 + 1,
                i % 12 + 1,
                i % 2,
            ));
        }
        // rows that try, and rows without values
        csv.push_str("900001;O'Hara;1.234,50;05.03.2026;1;\"'); DROP TABLE sc_load; --\"\n");
        csv.push_str("900002;\"Zoë ä€ ß\";;;;NULL\n");
        // rows the table refuses: no name, a name too long, a key twice, no such day, no number
        // (two lines each for the 3000 rows before them: these are the lines 6004 … 6008)
        csv.push_str("900003;;1,00;05.03.2026;1;no name\n");
        csv.push_str("900004;this name is longer than twenty characters;1,00;05.03.2026;1;x\n");
        csv.push_str("1;again;1,00;05.03.2026;1;x\n");
        csv.push_str("900006;day;1,00;31.02.2026;1;x\n");
        csv.push_str("900007;amount;abc;05.03.2026;1;x\n");
        csv.push_str("900008;last;7,25;01.01.2026;0;the last one\n");
        std::fs::write(&file, &csv).unwrap();
        let good = GOOD + 3;

        // all or nothing: a bad row, and the table is as it was
        let whole = load_plan(&mut s, kind, "sc_load", true);
        let failed = load_file(&mut s, kind, &file, &whole, None, &|| false);
        assert!(failed.failed && failed.rolled_back, "{product}: {failed:?}");
        assert_eq!(failed.written, 0, "{product}");
        assert_eq!(
            rows(&run(&mut s, "SELECT COUNT(*) FROM sc_load")),
            json!([[0]]),
            "{product}"
        );

        // leaving out what the table refuses: the rest is there, the bad rows are in the error file
        let errors = dir.path().join("errors.tsv");
        let skipping = LoadPlan {
            on_error: OnError::Skip,
            ..whole.clone()
        };
        let done = load_file(&mut s, kind, &file, &skipping, Some(&errors), &|| false);
        assert_eq!(
            (done.read, done.written, done.skipped),
            (good + 5, good, 5),
            "{product}: {:?}",
            done.errors
        );
        assert!(done.error_file && !done.failed, "{product}");
        let noted = std::fs::read_to_string(&errors).unwrap();
        // (a value that cannot be converted is noted when it is read, a row the table refuses when its
        // block was written: the file is not in the order of the lines)
        let mut lines: Vec<u64> = noted
            .lines()
            .skip(1)
            .map(|l| l.split('\t').next().unwrap().parse().unwrap())
            .collect();
        lines.sort_unstable();
        assert_eq!(lines, [6004, 6005, 6006, 6007, 6008], "{product}: {noted}");
        assert!(noted.contains("900004;this name is longer"), "{product}");
        assert_eq!(
            rows(&run(&mut s, "SELECT COUNT(*) FROM sc_load")),
            json!([[good]]),
            "{product}"
        );
        // the values arrived as they are – and nothing of them ran
        let special = run(
            &mut s,
            "SELECT name, CAST(amount AS char(20)), note FROM sc_load WHERE id IN (900001, 900002) ORDER BY id",
        );
        let special = rows(&special);
        assert_eq!(special[0][0], "O'Hara", "{product}");
        assert_eq!(
            special[0][1].as_str().unwrap().trim(),
            "1234.50",
            "{product}"
        );
        assert_eq!(special[0][2], "'); DROP TABLE sc_load; --", "{product}");
        assert_eq!(special[1][0], "Zoë ä€ ß", "{product}");
        assert!(
            special[1][1].is_null() && special[1][2].is_null(),
            "{product}"
        );
        let multi = run(&mut s, "SELECT note FROM sc_load WHERE id = 7");
        assert_eq!(
            rows(&multi)[0][0],
            "note; with \"quotes\"\nand a second line 7",
            "{product}"
        );

        // the round trip: export the table, load the export into a second one
        let out = dir.path().join("out.csv");
        let spec = Spec {
            format: FileFormat::Csv,
            options: Default::default(),
            bom: false,
            gzip: false,
            columns: Vec::new(),
        };
        let quiet = |_: u64| {};
        let mut sink = FileSink::new(&out, spec, &quiet);
        s.execute(
            "SELECT id, name, amount, day, ok, note FROM sc_load ORDER BY id",
            Limits::rows(MAX_ROWS),
            &mut sink,
            &|| false,
        )
        .unwrap();
        sink.finish().unwrap();
        let back = LoadPlan {
            null_texts: Vec::new(),
            ..load_plan(&mut s, kind, "sc_load2", false)
        };
        let again = load_file(&mut s, kind, &out, &back, None, &|| false);
        assert_eq!(
            (again.read, again.written, again.failed),
            (good, good, false),
            "{product}: {:?}",
            again.errors
        );
        let all = "SELECT id, name, amount, day, ok, note FROM";
        assert_eq!(
            rows(&run(&mut s, &format!("{all} sc_load ORDER BY id"))),
            rows(&run(&mut s, &format!("{all} sc_load2 ORDER BY id"))),
            "{product}"
        );

        // emptying first and stopping on the way, block by block: what was written so far stays, and
        // the report says how much
        // (stopped once the first blocks are through: the progress says so)
        let far = AtomicBool::new(false);
        let seen = |n: u64| {
            if n >= 600 {
                far.store(true, Ordering::Relaxed);
            }
        };
        let blocks = LoadPlan {
            clear_first: true,
            whole_transaction: false,
            ..back.clone()
        };
        let stopped = load_file_seen(&mut s, kind, &out, &blocks, None, &seen, &|| {
            far.load(Ordering::Relaxed)
        });
        assert!(stopped.cancelled && !stopped.rolled_back, "{product}");
        assert!(
            stopped.written >= 600 && stopped.written < good,
            "{product}: {stopped:?}"
        );
        let mut s = if s.is_open() { s } else { open(&p) };
        assert_eq!(
            rows(&run(&mut s, "SELECT COUNT(*) FROM sc_load2")),
            json!([[stopped.written]]),
            "{product}"
        );
        // … and in one transaction nothing of it: the rows that were there are there again
        let before = stopped.written;
        far.store(false, Ordering::Relaxed);
        let whole_stop = LoadPlan {
            clear_first: true,
            ..back
        };
        let undone = load_file_seen(&mut s, kind, &out, &whole_stop, None, &seen, &|| {
            far.load(Ordering::Relaxed)
        });
        assert!(undone.cancelled && undone.rolled_back, "{product}");
        let mut s = if s.is_open() { s } else { open(&p) };
        assert_eq!(
            rows(&run(&mut s, "SELECT COUNT(*) FROM sc_load2")),
            json!([[before]]),
            "{product}"
        );
        run(&mut s, "DROP TABLE sc_load");
        run(&mut s, "DROP TABLE sc_load2");
    }
}

/// A large file goes through block by block: the rows that arrive are the rows of the file (count and
/// sums), read as a stream and written 200 at a time.
#[test]
#[ignore]
fn a_large_file_is_loaded_block_by_block() {
    use std::io::Write;
    const ROWS: u64 = 500_000;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("big.csv");
    {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&file).unwrap());
        writeln!(out, "id,name,amount,day,ok,note").unwrap();
        for i in 1..=ROWS {
            writeln!(
                out,
                "{i},name {i},{}.{:02},2026-{:02}-{:02},{},note {i}",
                i % 1000,
                i % 100,
                i % 12 + 1,
                i % 28 + 1,
                i % 2
            )
            .unwrap();
        }
    }
    let p = pg();
    let mut s = open(&p);
    run(&mut s, "DROP TABLE IF EXISTS sc_load");
    run(
        &mut s,
        "CREATE TABLE sc_load (id int NOT NULL PRIMARY KEY, name varchar(20) NOT NULL, \
         amount decimal(12,2), day date, ok boolean, note text)",
    );
    let plan = LoadPlan {
        whole_transaction: false,
        ..load_plan(&mut s, p.kind, "sc_load", false)
    };
    let started = Instant::now();
    let done = load_file(&mut s, p.kind, &file, &plan, None, &|| false);
    eprintln!("{ROWS} rows in {:?}", started.elapsed());
    assert_eq!((done.read, done.written, done.skipped), (ROWS, ROWS, 0));
    assert_eq!(
        rows(&run(
            &mut s,
            "SELECT COUNT(*), CAST(SUM(id) AS text), CAST(SUM(amount) AS text) FROM sc_load"
        )),
        json!([[ROWS, (ROWS * (ROWS + 1) / 2).to_string(), "249997500.00"]])
    );
    run(&mut s, "DROP TABLE sc_load");
}

/// Review 033: a table without transactions (MyISAM, Aria) is not loaded "all or nothing", and a row
/// that fails does not leave the rows before it in the table twice.
#[test]
#[ignore]
fn a_table_without_transactions_is_loaded_row_by_row() {
    for (p, product) in [(my(), "mysql"), (maria(), "mariadb")] {
        let kind = p.kind;
        let mut s = open(&p);
        run(&mut s, "DROP TABLE IF EXISTS sc_load");
        // no key: nothing but the import itself keeps a row from being there twice
        run(
            &mut s,
            "CREATE TABLE sc_load (id int NOT NULL, name varchar(5) NOT NULL) ENGINE=MyISAM",
        );
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("in.csv");
        std::fs::write(&file, "id,name\n1,a\n2,b\n3,much too long\n4,d\n").unwrap();
        let info = meta::table(s.as_mut(), kind, "shop", "sc_load", &|| false).unwrap();
        let plan = LoadPlan {
            schema: Some("shop".into()),
            table: "sc_load".into(),
            mappings: info
                .columns
                .iter()
                .enumerate()
                .map(|(i, c)| Mapping {
                    source: Some(i),
                    fixed: None,
                    target: TargetColumn {
                        name: c.name.clone(),
                        kind: if i == 0 {
                            ValueKind::Number
                        } else {
                            ValueKind::Text
                        },
                        type_name: c.type_name.clone(),
                    },
                    trim: false,
                    decimal_comma: false,
                    date_order: None,
                })
                .collect(),
            null_texts: Vec::new(),
            empty_is_null: true,
            clear_first: false,
            on_error: OnError::Abort,
            whole_transaction: true,
            exact: false,
        };
        let mut source = Source::open(&file, &SourceOptions::default()).unwrap();
        let refused = load(
            s.as_mut(),
            kind,
            &mut source,
            &plan,
            None,
            None,
            &|_| {},
            &|| false,
        );
        assert!(
            refused.is_err(),
            "{product}: all or nothing cannot be promised"
        );
        let skipping = LoadPlan {
            on_error: OnError::Skip,
            ..plan
        };
        let done = load_file(&mut s, kind, &file, &skipping, None, &|| false);
        assert_eq!(
            (done.written, done.skipped),
            (3, 1),
            "{product}: {:?}",
            done.errors
        );
        assert_eq!(
            rows(&run(&mut s, "SELECT id FROM sc_load ORDER BY id")),
            json!([[1], [2], [4]]),
            "{product}"
        );
        run(&mut s, "DROP TABLE sc_load");
    }
}

/// Review 033: SQL Server reads a day for a `datetime` the same, whatever the language of the login.
#[test]
#[ignore]
fn sqlserver_reads_a_day_the_same_in_every_language() {
    let p = ms();
    let mut s = open(&p);
    run(&mut s, "DROP TABLE IF EXISTS sc_load");
    run(
        &mut s,
        "CREATE TABLE sc_load (id int NOT NULL PRIMARY KEY, at datetime, short smalldatetime)",
    );
    run(&mut s, "SET LANGUAGE German");
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("in.csv");
    std::fs::write(
        &file,
        "id,at,short\n1,2026-03-05,2026-03-05 10:30\n2,2026-12-31 23:59:58,2026-03-05\n",
    )
    .unwrap();
    let info = meta::table(s.as_mut(), p.kind, "dbo", "sc_load", &|| false).unwrap();
    let plan = LoadPlan {
        schema: Some("dbo".into()),
        table: "sc_load".into(),
        mappings: info
            .columns
            .iter()
            .enumerate()
            .map(|(i, c)| Mapping {
                source: Some(i),
                fixed: None,
                target: TargetColumn {
                    name: c.name.clone(),
                    kind: if i == 0 {
                        ValueKind::Number
                    } else {
                        ValueKind::Text
                    },
                    type_name: c.type_name.clone(),
                },
                trim: false,
                decimal_comma: false,
                date_order: None,
            })
            .collect(),
        null_texts: Vec::new(),
        empty_is_null: true,
        clear_first: false,
        on_error: OnError::Abort,
        whole_transaction: true,
        exact: false,
    };
    let done = load_file(&mut s, p.kind, &file, &plan, None, &|| false);
    assert_eq!((done.written, done.failed), (2, false), "{:?}", done.errors);
    assert_eq!(
        rows(&run(
            &mut s,
            "SELECT MONTH(at), DAY(at), MONTH(short), DAY(short), DATEPART(minute, short) FROM sc_load ORDER BY id"
        )),
        json!([[3, 5, 3, 5, 30], [12, 31, 3, 5, 0]])
    );
    run(&mut s, "DROP TABLE sc_load");
}

// ── Servers that speak PostgreSQL's protocol (prompt 035a) ───────────────────

fn crdb() -> Profile {
    profile(DbKind::Postgres, 25434, "root", "defaultdb")
}
fn tsdb() -> Profile {
    profile(DbKind::Postgres, 25433, "postgres", "postgres")
}

/// What the app does with PostgreSQL works on CockroachDB and on TimescaleDB too: values, the state of
/// the transaction, a statement that is stopped, the catalog, details, keys – and writing a file into a
/// table, which needs transactions and savepoints.
#[test]
#[ignore]
fn servers_with_the_protocol_of_postgres_work_like_it() {
    use schema_commander_lib::db::{Flavor, capabilities};
    for (p, product, flavor) in [
        (crdb(), "CockroachDB", Flavor::Cockroach),
        (tsdb(), "TimescaleDB", Flavor::Timescale),
        (pg(), "PostgreSQL", Flavor::Plain),
    ] {
        let kind = p.kind;
        let mut s = open(&p);
        let stop = &|| false;
        assert_eq!(s.flavor(), flavor, "{product}");
        assert_eq!(capabilities(kind, s.flavor()).product, product);
        for sql in [
            "DROP VIEW IF EXISTS sc_book_titles",
            "DROP TABLE IF EXISTS sc_book",
            "DROP TABLE IF EXISTS sc_author",
            "CREATE TABLE sc_author (id int PRIMARY KEY, name varchar(40) NOT NULL)",
            "CREATE TABLE sc_book (id int PRIMARY KEY, author_id int NOT NULL REFERENCES sc_author (id), \
             title text, price numeric(8,2) DEFAULT 0)",
            "CREATE INDEX sc_book_title ON sc_book (title)",
            "CREATE VIEW sc_book_titles AS SELECT id, title FROM sc_book",
            "INSERT INTO sc_author VALUES (1, 'Zoë ä€ 😀')",
        ] {
            run(&mut s, sql);
        }
        // values
        let r = run(
            &mut s,
            "SELECT name, 1.50::numeric, true, '{\"a\": 1}'::jsonb, NULL::int FROM sc_author",
        );
        assert_eq!(
            rows(&r),
            json!([["Zoë ä€ 😀", "1.50", true, "{\"a\": 1}", null]]),
            "{product}"
        );
        // the state of the transaction, as the server says it
        assert_eq!(s.transaction_state(stop), TxState::Idle, "{product}");
        run(&mut s, "BEGIN");
        assert_eq!(s.transaction_state(stop), TxState::Active, "{product}");
        assert!(!try_run(&mut s, "SELECT 1/0"));
        assert_eq!(s.transaction_state(stop), TxState::Failed, "{product}");
        run(&mut s, "ROLLBACK");
        assert_eq!(s.transaction_state(stop), TxState::Idle, "{product}");
        // a statement that takes too long ends on the server; the session goes on
        let started = Instant::now();
        let slow = s.query(
            "SELECT pg_sleep(20)",
            Limits {
                max_rows: 1,
                timeout: Some(Duration::from_millis(500)),
            },
            stop,
        );
        assert_eq!(slow.unwrap_err().code, ErrorCode::Timeout, "{product}");
        assert!(started.elapsed() < Duration::from_secs(3), "{product}");
        assert!(s.is_open(), "{product}: the session is gone");
        assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]), "{product}");
        // the catalog
        let schemas = meta::schemas(s.as_mut(), kind, stop).unwrap();
        let own: Vec<&str> = schemas
            .iter()
            .filter(|x| !x.system)
            .map(|x| x.name.as_str())
            .collect();
        // (other tests leave schemas of their own on the plain server)
        assert!(own.contains(&"public"), "{product}: {schemas:?}");
        assert!(
            own.iter().all(|n| *n == "public" || n.starts_with("sc_")),
            "{product}: a schema of the server itself is not marked: {own:?}"
        );
        let objects = meta::objects(s.as_mut(), kind, "public", stop).unwrap();
        let mine = |k: ObjectKind| -> Vec<&str> {
            names(&objects, k)
                .into_iter()
                .filter(|n| n.starts_with("sc_"))
                .collect()
        };
        assert_eq!(
            mine(ObjectKind::Table),
            ["sc_author", "sc_book"],
            "{product}"
        );
        assert_eq!(mine(ObjectKind::View), ["sc_book_titles"], "{product}");
        let book = meta::table(s.as_mut(), kind, "public", "sc_book", stop).unwrap();
        let lines = column_line(&book);
        assert_eq!(lines.len(), 4, "{product}: {lines:?}");
        assert!(lines[0].ends_with("not null pk"), "{product}: {lines:?}");
        assert!(lines[1].ends_with("not null fk"), "{product}: {lines:?}");
        assert!(
            book.indexes.iter().any(|i| i.name == "sc_book_title"),
            "{product}: {:?}",
            book.indexes
        );
        // details and DDL
        let d = details(
            s.as_mut(),
            kind,
            "public",
            "sc_book",
            ObjectKind::Table,
            "",
            stop,
        )
        .unwrap();
        let ids: Vec<&str> = d.sections.iter().map(|x| x.id.as_str()).collect();
        for id in ["columns", "indexes", "constraints", "references"] {
            assert!(ids.contains(&id), "{product}: {ids:?} – {:?}", d.notes);
        }
        assert!(
            d.ddl.as_deref().is_some_and(|t| t.contains("sc_book")),
            "{product}: {:?}",
            d.notes
        );
        // nothing was asked that this server does not know
        assert_eq!(d.notes, Vec::<String>::new(), "{product}");
        // keys
        let keys = relations(s.as_mut(), kind, "public", "sc_book", stop).unwrap();
        assert_eq!(keys.outgoing.len(), 1, "{product}");
        assert_eq!(keys.outgoing[0].ref_table, "sc_author", "{product}");
        // a file into the table: all or nothing, and row by row with savepoints
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("in.csv");
        std::fs::write(
            &file,
            "id,author_id,title,price\n1,1,one,1.50\n2,9,no such author,2\n3,1,three,3\n",
        )
        .unwrap();
        let info = meta::table(s.as_mut(), kind, "public", "sc_book", stop).unwrap();
        let plan = LoadPlan {
            schema: Some("public".into()),
            table: "sc_book".into(),
            mappings: info
                .columns
                .iter()
                .enumerate()
                .map(|(i, c)| Mapping {
                    source: Some(i),
                    fixed: None,
                    target: TargetColumn {
                        name: c.name.clone(),
                        kind: if c.name == "title" {
                            ValueKind::Text
                        } else {
                            ValueKind::Number
                        },
                        type_name: c.type_name.clone(),
                    },
                    trim: false,
                    decimal_comma: false,
                    date_order: None,
                })
                .collect(),
            null_texts: Vec::new(),
            empty_is_null: true,
            clear_first: false,
            on_error: OnError::Abort,
            whole_transaction: true,
            exact: false,
        };
        let whole = load_file(&mut s, kind, &file, &plan, None, stop);
        assert!(whole.failed && whole.rolled_back, "{product}: {whole:?}");
        assert_eq!(
            rows(&run(&mut s, "SELECT COUNT(*) FROM sc_book")),
            json!([[0]]),
            "{product}"
        );
        let skipping = LoadPlan {
            on_error: OnError::Skip,
            ..plan
        };
        let done = load_file(&mut s, kind, &file, &skipping, None, stop);
        assert_eq!(
            (done.written, done.skipped),
            (2, 1),
            "{product}: {:?}",
            done.errors
        );
        assert_eq!(
            rows(&run(
                &mut s,
                "SELECT id, CAST(price AS text) FROM sc_book ORDER BY id"
            )),
            json!([[1, "1.50"], [3, "3.00"]]),
            "{product}"
        );
        assert_eq!(s.transaction_state(stop), TxState::Idle, "{product}");
        run(&mut s, "DROP VIEW sc_book_titles");
        run(&mut s, "DROP TABLE sc_book");
        run(&mut s, "DROP TABLE sc_author");
    }
}

/// A hypertable of TimescaleDB is one table in the tree: its chunks live in schemas that are marked as
/// the system's.
#[test]
#[ignore]
fn timescale_shows_a_hypertable_as_one_table() {
    let p = tsdb();
    let mut s = open(&p);
    let stop = &|| false;
    run(&mut s, "DROP TABLE IF EXISTS sc_metric");
    run(
        &mut s,
        "CREATE TABLE sc_metric (at timestamptz NOT NULL, device int, value double precision)",
    );
    run(&mut s, "SELECT create_hypertable('sc_metric', 'at')");
    run(
        &mut s,
        "INSERT INTO sc_metric SELECT now() - (n || ' days')::interval, n % 3, n FROM generate_series(1, 60) n",
    );
    let objects = meta::objects(s.as_mut(), p.kind, "public", stop).unwrap();
    let tables: Vec<&str> = names(&objects, ObjectKind::Table)
        .into_iter()
        .filter(|n| n.contains("metric") || n.contains("hyper") || n.contains("chunk"))
        .collect();
    assert_eq!(tables, ["sc_metric"]);
    let schemas = meta::schemas(s.as_mut(), p.kind, stop).unwrap();
    assert!(
        schemas
            .iter()
            .filter(|x| x.name.contains("timescaledb"))
            .all(|x| x.system),
        "{schemas:?}"
    );
    assert_eq!(
        rows(&run(&mut s, "SELECT COUNT(*) FROM sc_metric")),
        json!([[60]])
    );
    run(&mut s, "DROP TABLE sc_metric");
}

// ── Search on the server (prompt 036) ────────────────────────────────────────

use schema_commander_lib::db::find::{Columns, FindEvent, FindSpec, Mode, Skip, find};

fn find_spec(text: &str, schema: &str) -> FindSpec {
    FindSpec {
        text: text.into(),
        mode: Mode::Contains,
        case_sensitive: false,
        columns: Columns::Text,
        schemas: vec![schema.into()],
        tables: Vec::new(),
        data: true,
        sources: true,
        names: false,
        max_hits: 20,
        table_timeout_ms: 5_000,
        skip_rows_over: 0,
    }
}

fn found(s: &mut Box<dyn Session>, kind: DbKind, spec: &FindSpec) -> Vec<String> {
    let events = std::sync::Mutex::new(Vec::new());
    find(
        s.as_mut(),
        kind,
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
            FindEvent::Skipped { name, reason, .. } => vec![format!("skipped {name} {reason:?}")],
            _ => Vec::new(),
        })
        .collect();
    lines.sort();
    lines.dedup();
    lines
}

/// A text is found in the rows and in the definitions of every server: with the wildcards of `LIKE` as
/// plain characters, with and without case, in numbers when asked, by a regular expression where the
/// database has them.
#[test]
#[ignore]
fn a_text_is_found_on_every_server() {
    for (p, product, schema) in [
        (pg(), "postgres", "sc_find"),
        (crdb(), "cockroach", "sc_find"),
        (my(), "mysql", "shop"),
        (maria(), "mariadb", "shop"),
        (ms(), "sqlserver", "dbo"),
    ] {
        let kind = p.kind;
        let mut s = open(&p);
        if kind == DbKind::Postgres {
            run(&mut s, "DROP SCHEMA IF EXISTS sc_find CASCADE");
            run(&mut s, "CREATE SCHEMA sc_find");
        }
        let t = |name: &str| format!("{schema}.{name}");
        run(&mut s, &format!("DROP VIEW IF EXISTS {}", t("sc_f_prices")));
        run(
            &mut s,
            &format!("DROP TABLE IF EXISTS {}", t("sc_f_orders")),
        );
        run(
            &mut s,
            &format!("DROP TABLE IF EXISTS {}", t("sc_f_people")),
        );
        let text = if kind == DbKind::Sqlserver {
            "nvarchar(200)"
        } else {
            "varchar(200)"
        };
        run(
            &mut s,
            &format!(
                "CREATE TABLE {} (id int NOT NULL PRIMARY KEY, name {text}, mail {text})",
                t("sc_f_people")
            ),
        );
        run(
            &mut s,
            &format!(
                "CREATE TABLE {} (id int NOT NULL PRIMARY KEY, note {text}, old_price decimal(8,2) DEFAULT 0)",
                t("sc_f_orders")
            ),
        );
        run(
            &mut s,
            &format!(
                "INSERT INTO {} VALUES (1, 'Max Mustermann', 'max.mustermann@example.com'), \
                 (2, 'Zoë', 'zoe@example.com'), (3, '100% sure_thing [x]', NULL)",
                t("sc_f_people")
            ),
        );
        run(
            &mut s,
            &format!(
                "INSERT INTO {} VALUES (42, 'for MAX.mustermann@example.com', 12.50)",
                t("sc_f_orders")
            ),
        );
        run(
            &mut s,
            &format!(
                "CREATE VIEW {} AS SELECT id, old_price * 2 AS doubled FROM {}",
                t("sc_f_prices"),
                t("sc_f_orders")
            ),
        );
        let mine = |lines: Vec<String>| -> Vec<String> {
            lines.into_iter().filter(|l| l.contains("sc_f_")).collect()
        };
        // in the rows, whatever the case
        let rows = mine(found(
            &mut s,
            kind,
            &find_spec("max.mustermann@example.com", schema),
        ));
        assert_eq!(
            rows,
            [
                "row sc_f_orders.note: for MAX.mustermann@example.com",
                "row sc_f_people.mail: max.mustermann@example.com"
            ],
            "{product}"
        );
        let sensitive = FindSpec {
            case_sensitive: true,
            ..find_spec("max.mustermann@example.com", schema)
        };
        assert_eq!(
            mine(found(&mut s, kind, &sensitive)),
            ["row sc_f_people.mail: max.mustermann@example.com"],
            "{product}"
        );
        // the wildcards of LIKE are characters
        for (text, hits) in [
            ("100%", 1),
            ("sure_", 1),
            ("%", 1),
            ("[x]", 1),
            ("_thing [", 1),
            ("!", 0),
        ] {
            let rows = mine(found(&mut s, kind, &find_spec(text, schema)));
            assert_eq!(rows.len(), hits, "{product}: {text} → {rows:?}");
        }
        // a text that tries
        let evil = "x' OR '1'='1";
        assert!(
            mine(found(&mut s, kind, &find_spec(evil, schema))).is_empty(),
            "{product}"
        );
        // numbers when asked; unicode
        let numbers = FindSpec {
            columns: Columns::Numbers,
            ..find_spec("12.5", schema)
        };
        assert!(
            mine(found(&mut s, kind, &numbers))
                .iter()
                .any(|l| l.starts_with("row sc_f_orders.old_price: 12.5")),
            "{product}"
        );
        assert_eq!(
            mine(found(&mut s, kind, &find_spec("zoë", schema))),
            ["row sc_f_people.name: Zoë"],
            "{product}"
        );
        // a regular expression, where the database has one
        let regex = FindSpec {
            mode: Mode::Regex,
            sources: false,
            ..find_spec("^max.*mann$", schema)
        };
        if kind == DbKind::Sqlserver {
            assert_eq!(
                find(s.as_mut(), kind, &regex, None, &|_| {}, &|| false)
                    .unwrap_err()
                    .code,
                ErrorCode::Unsupported
            );
        } else {
            assert_eq!(
                mine(found(&mut s, kind, &regex)),
                ["row sc_f_people.name: Max Mustermann"],
                "{product}"
            );
        }
        // in definitions: the view that reads the column, the default of the column
        let sources = FindSpec {
            data: false,
            ..find_spec("old_price", schema)
        };
        let hits = mine(found(&mut s, kind, &sources));
        assert!(
            hits.iter().any(|l| l == "view sc_f_prices"),
            "{product}: {hits:?}"
        );
        run(&mut s, &format!("DROP VIEW {}", t("sc_f_prices")));
        run(&mut s, &format!("DROP TABLE {}", t("sc_f_orders")));
        run(&mut s, &format!("DROP TABLE {}", t("sc_f_people")));
    }
}

/// A table the user may not read is left out and named; the others are searched.
#[test]
#[ignore]
fn a_table_without_the_right_to_read_is_left_out() {
    let mut admin = open(&pg());
    for sql in [
        "DROP SCHEMA IF EXISTS sc_find2 CASCADE",
        "DROP ROLE IF EXISTS sc_reader",
        "CREATE ROLE sc_reader LOGIN PASSWORD 'Sc-test-003!'",
        "CREATE SCHEMA sc_find2",
        "CREATE TABLE sc_find2.open_t (t text)",
        "CREATE TABLE sc_find2.secret_t (t text)",
        "INSERT INTO sc_find2.open_t VALUES ('needle in the open')",
        "INSERT INTO sc_find2.secret_t VALUES ('needle in the dark')",
        "GRANT USAGE ON SCHEMA sc_find2 TO sc_reader",
        "GRANT SELECT ON sc_find2.open_t TO sc_reader",
    ] {
        run(&mut admin, sql);
    }
    let mut reader = open(&profile(DbKind::Postgres, 25432, "sc_reader", "postgres"));
    let spec = FindSpec {
        sources: false,
        ..find_spec("needle", "sc_find2")
    };
    assert_eq!(
        found(&mut reader, DbKind::Postgres, &spec),
        [
            "row open_t.t: needle in the open",
            "skipped secret_t Refused"
        ]
    );
    assert!(matches!(Skip::Refused, Skip::Refused));
    drop(reader);
    run(&mut admin, "DROP SCHEMA sc_find2 CASCADE");
    run(&mut admin, "DROP ROLE sc_reader");
}

/// Review 036: a table that does not answer in time (here: locked by another session) is left out –
/// stopped on the server –, and the tables behind it are searched: on the same session where the driver
/// can stop a statement, on a new one where it cannot (SQL Server).
#[test]
#[ignore]
fn a_table_that_takes_too_long_is_left_out_and_the_search_goes_on() {
    for (p, product, schema, lock) in [
        (
            pg(),
            "postgres",
            "public",
            "LOCK TABLE public.sc_t_b IN ACCESS EXCLUSIVE MODE",
        ),
        (my(), "mysql", "shop", "LOCK TABLES shop.sc_t_b WRITE"),
        (
            ms(),
            "sqlserver",
            "dbo",
            "SELECT COUNT(*) FROM dbo.sc_t_b WITH (TABLOCKX, HOLDLOCK)",
        ),
    ] {
        let kind = p.kind;
        let mut s = open(&p);
        let mut other = open(&p);
        for t in ["sc_t_a", "sc_t_b", "sc_t_c"] {
            run(&mut s, &format!("DROP TABLE IF EXISTS {schema}.{t}"));
            run(
                &mut s,
                &format!("CREATE TABLE {schema}.{t} (t varchar(40))"),
            );
            run(
                &mut s,
                &format!("INSERT INTO {schema}.{t} VALUES ('needle in {t}')"),
            );
        }
        if kind == DbKind::Sqlserver {
            run(&mut other, "BEGIN TRANSACTION");
        } else if kind == DbKind::Postgres {
            run(&mut other, "BEGIN");
        }
        run(&mut other, lock);
        let spec = FindSpec {
            sources: false,
            table_timeout_ms: 700,
            tables: ["sc_t_a", "sc_t_b", "sc_t_c"]
                .iter()
                .map(|t| (schema.to_owned(), (*t).to_owned()))
                .collect(),
            ..find_spec("needle", schema)
        };
        let events = std::sync::Mutex::new(Vec::new());
        let tell = |e: FindEvent| events.lock().unwrap().push(e);
        let started = Instant::now();
        let mut report = find(s.as_mut(), kind, &spec, None, &tell, &|| false).unwrap();
        if report.lost {
            // the driver dropped the connection to stop the statement: go on with a new one
            assert_eq!(kind, DbKind::Sqlserver, "{product}");
            assert_eq!(report.resume, Some(2), "{product}");
            let mut again = open(&p);
            let next = find(again.as_mut(), kind, &spec, report.resume, &tell, &|| false).unwrap();
            report = report.and(next);
        } else {
            assert!(s.is_open(), "{product}");
        }
        assert!(started.elapsed() < Duration::from_secs(8), "{product}");
        assert_eq!(
            (
                report.tables,
                report.searched,
                report.skipped,
                report.rows,
                report.lost
            ),
            (3, 2, 1, 2, false),
            "{product}: {report:?}"
        );
        let events = events.into_inner().unwrap();
        let found: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                FindEvent::Rows { table, .. } => Some(table.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(found, ["sc_t_a", "sc_t_c"], "{product}");
        assert!(
            events.iter().any(|e| matches!(
                e,
                FindEvent::Skipped { name, reason: Skip::Timeout, .. } if name == "sc_t_b"
            )),
            "{product}: {events:?}"
        );
        if kind == DbKind::Mysql {
            run(&mut other, "UNLOCK TABLES");
        } else {
            run(&mut other, "ROLLBACK");
        }
        let mut s = open(&p);
        for t in ["sc_t_a", "sc_t_b", "sc_t_c"] {
            run(&mut s, &format!("DROP TABLE {schema}.{t}"));
        }
    }
}

// ── What an ER diagram is drawn from (prompt 037) ────────────────────────────

/// Every server gives the tables of a schema with their columns, the keys between them – one of two
/// columns, one of a table to itself – and what is unique.
#[test]
#[ignore]
fn every_server_gives_what_a_diagram_is_drawn_from() {
    use schema_commander_lib::db::diagram::diagram;
    for (p, product, schema) in [
        (pg(), "postgres", "sc_er"),
        (crdb(), "cockroach", "sc_er"),
        (my(), "mysql", "shop"),
        (maria(), "mariadb", "shop"),
        (ms(), "sqlserver", "dbo"),
    ] {
        let kind = p.kind;
        let mut s = open(&p);
        if kind == DbKind::Postgres {
            run(&mut s, "DROP SCHEMA IF EXISTS sc_er CASCADE");
            run(&mut s, "CREATE SCHEMA sc_er");
        }
        let t = |name: &str| format!("{schema}.{name}");
        for name in ["sc_e_profile", "sc_e_copy", "sc_e_book", "sc_e_author"] {
            run(&mut s, &format!("DROP TABLE IF EXISTS {}", t(name)));
        }
        run(
            &mut s,
            &format!(
                "CREATE TABLE {a} (id int NOT NULL PRIMARY KEY, name varchar(40) NOT NULL, boss int NULL, \
                 CONSTRAINT sc_e_boss FOREIGN KEY (boss) REFERENCES {a} (id))",
                a = t("sc_e_author")
            ),
        );
        run(
            &mut s,
            &format!(
                "CREATE TABLE {} (isbn varchar(20) NOT NULL, edition int NOT NULL, author_id int NOT NULL, \
                 PRIMARY KEY (isbn, edition), \
                 CONSTRAINT sc_e_written FOREIGN KEY (author_id) REFERENCES {} (id))",
                t("sc_e_book"),
                t("sc_e_author")
            ),
        );
        run(
            &mut s,
            &format!(
                "CREATE TABLE {} (id int NOT NULL PRIMARY KEY, isbn varchar(20) NULL, edition int NULL, \
                 CONSTRAINT sc_e_of FOREIGN KEY (isbn, edition) REFERENCES {} (isbn, edition))",
                t("sc_e_copy"),
                t("sc_e_book")
            ),
        );
        run(
            &mut s,
            &format!(
                "CREATE TABLE {} (author_id int NOT NULL PRIMARY KEY, bio varchar(200) NULL, \
                 CONSTRAINT sc_e_is FOREIGN KEY (author_id) REFERENCES {} (id))",
                t("sc_e_profile"),
                t("sc_e_author")
            ),
        );
        let d = diagram(s.as_mut(), kind, schema, &|| false).unwrap();
        let mine: Vec<_> = d
            .tables
            .iter()
            .filter(|x| x.name.starts_with("sc_e_"))
            .collect();
        assert_eq!(
            mine.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
            ["sc_e_author", "sc_e_book", "sc_e_copy", "sc_e_profile"],
            "{product}"
        );
        let book = mine[1];
        assert_eq!(
            book.columns
                .iter()
                .map(|c| format!("{} {} {}", c.name, c.nullable, c.pk))
                .collect::<Vec<_>>(),
            [
                "isbn false true",
                "edition false true",
                "author_id false false"
            ],
            "{product}"
        );
        assert!(mine[2].columns[1].nullable, "{product}");
        let mut keys: Vec<String> = d
            .keys
            .iter()
            .filter(|k| k.table.starts_with("sc_e_"))
            .map(|k| {
                format!(
                    "{}({}) → {}({})",
                    k.table,
                    k.columns.join(","),
                    k.ref_table,
                    k.ref_columns.join(",")
                )
            })
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "sc_e_author(boss) → sc_e_author(id)",
                "sc_e_book(author_id) → sc_e_author(id)",
                "sc_e_copy(isbn,edition) → sc_e_book(isbn,edition)",
                "sc_e_profile(author_id) → sc_e_author(id)"
            ],
            "{product}"
        );
        let unique = |table: &str, columns: &[&str]| {
            d.unique.iter().any(|u| {
                u.table == table
                    && u.columns.len() == columns.len()
                    && columns.iter().all(|c| u.columns.iter().any(|x| x == c))
            })
        };
        assert!(
            unique("sc_e_book", &["isbn", "edition"]),
            "{product}: {:?}",
            d.unique
        );
        assert!(unique("sc_e_profile", &["author_id"]), "{product}");
        assert!(!unique("sc_e_book", &["author_id"]), "{product}");
        for name in ["sc_e_profile", "sc_e_copy", "sc_e_book", "sc_e_author"] {
            run(&mut s, &format!("DROP TABLE {}", t(name)));
        }
    }
}

// ── Comparing schemas (prompt 038) ───────────────────────────────────────────

/// The round trip on every server: two schemas that started the same, one of them changed; the script
/// that is proposed, applied to the other (with its dangerous steps switched on), leaves no difference.
/// Without them switched on nothing that holds data is gone.
#[test]
#[ignore]
fn a_migration_script_applied_leaves_no_difference() {
    use schema_commander_lib::db::compare::{
        DANGER, State, compare, script, snapshot, with_danger,
    };
    for (p, product) in [
        (pg(), "postgres"),
        (my(), "mysql"),
        (maria(), "mariadb"),
        (ms(), "sqlserver"),
    ] {
        let kind = p.kind;
        let mut s = open(&p);
        let (a, b) = ("sc_cmp_a", "sc_cmp_b");
        for schema in [a, b] {
            match kind {
                DbKind::Postgres => {
                    run(&mut s, &format!("DROP SCHEMA IF EXISTS {schema} CASCADE"));
                    run(&mut s, &format!("CREATE SCHEMA {schema}"));
                }
                DbKind::Mysql => {
                    run(&mut s, &format!("DROP DATABASE IF EXISTS {schema}"));
                    run(&mut s, &format!("CREATE DATABASE {schema}"));
                }
                _ => {
                    for t in ["v_names", "v_stale"] {
                        run(&mut s, &format!("DROP VIEW IF EXISTS {schema}.{t}"));
                    }
                    for t in ["book", "legacy", "author"] {
                        run(&mut s, &format!("DROP TABLE IF EXISTS {schema}.{t}"));
                    }
                    run(&mut s, &format!("DROP SCHEMA IF EXISTS {schema}"));
                    run(&mut s, &format!("CREATE SCHEMA {schema}"));
                }
            }
            // what both start with
            run(
                &mut s,
                &format!(
                    "CREATE TABLE {schema}.author (id int NOT NULL PRIMARY KEY, name varchar(40) NOT NULL, \
                     note varchar(20) NULL, age int NULL)"
                ),
            );
            run(
                &mut s,
                &format!(
                    "CREATE TABLE {schema}.legacy (id int NOT NULL PRIMARY KEY, gone varchar(10) NULL)"
                ),
            );
            run(
                &mut s,
                &format!("CREATE INDEX author_note ON {schema}.author (note)"),
            );
            run(
                &mut s,
                &format!("CREATE VIEW {schema}.v_stale AS SELECT id FROM {schema}.legacy"),
            );
        }
        // the source moves on
        for sql in [
            format!("DROP VIEW {a}.v_stale"),
            format!("DROP TABLE {a}.legacy"),
            format!(
                "CREATE TABLE {a}.book (id int NOT NULL PRIMARY KEY, author_id int NOT NULL, \
                 title varchar(200) NOT NULL, price decimal(8,2) NULL, \
                 CONSTRAINT book_author FOREIGN KEY (author_id) REFERENCES {a}.author (id), \
                 CONSTRAINT book_price CHECK (price >= 0))"
            ),
            format!("CREATE UNIQUE INDEX book_title ON {a}.book (title, author_id)"),
            format!("DROP INDEX author_note ON {a}.author").replace(
                &format!("DROP INDEX author_note ON {a}.author"),
                &if kind == DbKind::Postgres {
                    format!("DROP INDEX {a}.author_note")
                } else {
                    format!("DROP INDEX author_note ON {a}.author")
                },
            ),
            format!("CREATE INDEX author_name ON {a}.author (name)"),
            // a new column with a default, a wider type, a column that goes
            match kind {
                DbKind::Sqlserver => {
                    format!("ALTER TABLE {a}.author ADD born int NOT NULL DEFAULT 1900")
                }
                _ => format!("ALTER TABLE {a}.author ADD COLUMN born int NOT NULL DEFAULT 1900"),
            },
            match kind {
                DbKind::Postgres => {
                    format!("ALTER TABLE {a}.author ALTER COLUMN note TYPE varchar(80)")
                }
                DbKind::Mysql => {
                    format!("ALTER TABLE {a}.author MODIFY COLUMN note varchar(80) NULL")
                }
                _ => format!("ALTER TABLE {a}.author ALTER COLUMN note varchar(80) NULL"),
            },
            format!("ALTER TABLE {a}.author DROP COLUMN age"),
            format!("CREATE VIEW {a}.v_names AS SELECT id, name FROM {a}.author"),
        ] {
            run(&mut s, &sql);
        }
        let read = |s: &mut Box<dyn Session>, schema: &str| {
            snapshot(s.as_mut(), kind, schema, &|| false).unwrap()
        };
        let differing = |s: &mut Box<dyn Session>| -> Vec<String> {
            let (left, right) = (read(s, a), read(s, b));
            compare(&left, &right, &[])
                .unwrap()
                .into_iter()
                .filter(|i| i.state != State::Same)
                .map(|i| format!("{} {:?}", i.id, i.state))
                .collect()
        };
        assert!(
            differing(&mut s).len() >= 8,
            "{product}: {:?}",
            differing(&mut s)
        );
        let apply = |s: &mut Box<dyn Session>, sql: &str| {
            // batches at GO (SQL Server), statements at the end of a line
            for batch in sql.split("\nGO\n") {
                let code: String = batch
                    .lines()
                    .filter(|l| !l.trim_start().starts_with("--") && l.trim() != "GO")
                    .collect::<Vec<_>>()
                    .join("\n");
                let statements: Vec<&str> = if batch
                    .trim_start()
                    .to_uppercase()
                    .starts_with("CREATE OR ALTER")
                {
                    vec![code.as_str()]
                } else {
                    code.split(";\n").collect()
                };
                for statement in statements {
                    let statement = statement.trim().trim_end_matches(';');
                    if !statement.is_empty() {
                        s.query(statement, Limits::rows(1), &|| false)
                            .unwrap_or_else(|e| panic!("{product}: {statement}\n→ {e}\n\n{sql}"));
                    }
                }
            }
        };
        // as proposed: what may lose data did not run
        let proposed = script(&read(&mut s, a), &read(&mut s, b), None, &[]).unwrap();
        assert!(proposed.contains(DANGER), "{product}");
        apply(&mut s, &proposed);
        let left = differing(&mut s);
        // (MySQL can only state a column anew to widen it: that is marked too)
        let mut expected = vec!["table:author Different", "column:author.age OnlyRight"];
        if kind == DbKind::Mysql {
            expected.push("column:author.note Different");
        }
        expected.extend(["table:legacy OnlyRight", "view:v_stale OnlyRight"]);
        assert_eq!(left, expected, "{product}:\n{proposed}");
        // with the danger switched on: nothing is left
        let rest = with_danger(&script(&read(&mut s, a), &read(&mut s, b), None, &[]).unwrap());
        apply(&mut s, &rest);
        assert_eq!(
            differing(&mut s),
            Vec::<String>::new(),
            "{product}:\n{rest}"
        );
        // and the target takes rows as the source does
        run(
            &mut s,
            &format!("INSERT INTO {b}.author (id, name) VALUES (1, 'a')"),
        );
        run(
            &mut s,
            &format!("INSERT INTO {b}.book (id, author_id, title, price) VALUES (1, 1, 't', 2.5)"),
        );
        assert!(
            !try_run(
                &mut s,
                &format!(
                    "INSERT INTO {b}.book (id, author_id, title, price) VALUES (2, 9, 'x', 1)"
                )
            ),
            "{product}: the key of the target does not hold"
        );
        assert_eq!(
            rows(&run(&mut s, &format!("SELECT born FROM {b}.author"))),
            json!([[1900]]),
            "{product}"
        );
        // sizes came along: two digits behind the point, and a title of 200 characters fits
        let made = read(&mut s, b);
        let book = made.tables.iter().find(|t| t.name == "book").unwrap();
        let types: Vec<String> = book
            .columns
            .iter()
            .map(|c| c.type_name.to_lowercase().replace(' ', ""))
            .collect();
        assert!(types[2].ends_with("(200)"), "{product}: {types:?}");
        assert!(types[3].ends_with("(8,2)"), "{product}: {types:?}");
        assert_eq!(
            rows(&run(
                &mut s,
                &format!("SELECT CAST(price AS char(10)) FROM {b}.book")
            ))[0][0]
                .as_str()
                .map(str::trim),
            Some("2.50"),
            "{product}"
        );
        run(
            &mut s,
            &format!(
                "UPDATE {b}.book SET title = '{}' WHERE id = 1",
                "t".repeat(200)
            ),
        );
    }
}

// ── Execution plans (prompt 039) ─────────────────────────────────────────────

/// Every server shows a tree for a join – estimated, and with the times of a run where it has them;
/// and a statement that writes, explained with a run, has changed nothing afterwards.
#[test]
#[ignore]
fn every_server_explains_a_join_and_a_run_changes_nothing() {
    use schema_commander_lib::db::plan::{PlanNode, explain};
    fn all(nodes: &[PlanNode]) -> Vec<&PlanNode> {
        let mut out = Vec::new();
        for n in nodes {
            out.push(n);
            out.extend(all(&n.children));
        }
        out
    }
    for (p, product, schema) in [
        (pg(), "postgres", "public"),
        (crdb(), "cockroach", "public"),
        (my(), "mysql", "shop"),
        (maria(), "mariadb", "shop"),
        (ms(), "sqlserver", "dbo"),
    ] {
        let kind = p.kind;
        let mut s = open(&p);
        let stop = &|| false;
        let t = |name: &str| format!("{schema}.{name}");
        run(&mut s, &format!("DROP TABLE IF EXISTS {}", t("sc_x_book")));
        run(
            &mut s,
            &format!("DROP TABLE IF EXISTS {}", t("sc_x_author")),
        );
        run(
            &mut s,
            &format!(
                "CREATE TABLE {} (id int NOT NULL PRIMARY KEY, name varchar(40) NOT NULL)",
                t("sc_x_author")
            ),
        );
        run(
            &mut s,
            &format!(
                "CREATE TABLE {} (id int NOT NULL PRIMARY KEY, author_id int NOT NULL, price decimal(8,2))",
                t("sc_x_book")
            ),
        );
        run(
            &mut s,
            &format!("INSERT INTO {} VALUES (1, 'a'), (2, 'b')", t("sc_x_author")),
        );
        run(
            &mut s,
            &format!(
                "INSERT INTO {} VALUES (1, 1, 9.5), (2, 1, 3), (3, 2, 7)",
                t("sc_x_book")
            ),
        );
        let join = format!(
            "SELECT a.name, COUNT(*) AS n FROM {} b JOIN {} a ON a.id = b.author_id \
             WHERE b.price > 5 GROUP BY a.name ORDER BY n DESC",
            t("sc_x_book"),
            t("sc_x_author")
        );
        let plan = explain(s.as_mut(), kind, &join, false, None, stop)
            .unwrap_or_else(|e| panic!("{product}: {e}"));
        assert!(plan.known && !plan.analyzed, "{product}: {}", plan.raw);
        let nodes = all(&plan.nodes);
        assert!(
            nodes.len() >= 3,
            "{product}: {} nodes\n{}",
            nodes.len(),
            plan.raw
        );
        assert!(
            nodes
                .iter()
                .any(|n| n.object.contains("sc_x_book") || n.object == "b"),
            "{product}: {:?}",
            nodes.iter().map(|n| (&n.op, &n.object)).collect::<Vec<_>>()
        );
        // with a run: rows that came, and times that add up
        let ran = explain(s.as_mut(), kind, &join, true, None, stop)
            .unwrap_or_else(|e| panic!("{product}: {e}"));
        assert!(ran.known && ran.analyzed, "{product}: {}", ran.raw);
        let nodes = all(&ran.nodes);
        assert!(
            nodes.iter().any(|n| n.act_rows.is_some()),
            "{product}: no rows of the run\n{}",
            ran.raw
        );
        if kind == DbKind::Postgres && product == "postgres" {
            let own: f64 = nodes.iter().filter_map(|n| n.self_ms).sum();
            let root = ran.nodes[0].time_ms.unwrap();
            assert!((own - root).abs() < 0.01, "{product}: {own} / {root}");
        }
        // a statement that writes, explained with a run: rolled back
        let update = format!(
            "UPDATE {} SET price = price + 100 WHERE author_id = 1",
            t("sc_x_book")
        );
        let written = explain(s.as_mut(), kind, &update, true, None, stop)
            .unwrap_or_else(|e| panic!("{product}: {e}"));
        assert!(written.analyzed, "{product}");
        assert_eq!(
            rows(&run(
                &mut s,
                &format!("SELECT COUNT(*) FROM {} WHERE price > 100", t("sc_x_book"))
            )),
            json!([[0]]),
            "{product}: the update stayed"
        );
        assert_eq!(s.transaction_state(stop), TxState::Idle, "{product}");
        // two statements are refused before anything is sent
        let two = format!("{join}; DELETE FROM {}", t("sc_x_book"));
        assert!(
            explain(s.as_mut(), kind, &two, true, None, stop).is_err(),
            "{product}"
        );
        assert_eq!(
            rows(&run(
                &mut s,
                &format!("SELECT COUNT(*) FROM {}", t("sc_x_book"))
            )),
            json!([[3]]),
            "{product}"
        );
        // and the session shows results again, not plans
        assert_eq!(rows(&run(&mut s, "SELECT 1")), json!([[1]]), "{product}");
        run(&mut s, &format!("DROP TABLE {}", t("sc_x_book")));
        run(&mut s, &format!("DROP TABLE {}", t("sc_x_author")));
    }
}

// ── Editing the structure of a table (prompt 043) ───────────────────────────────────

/// The round trip on every server: a table is created from what the editor holds, read again, edited
/// (columns renamed, added, widened, dropped; an index; the table renamed), written, read again – and is
/// what was edited, with its rows. A failure rolls back where DDL is transactional.
#[test]
#[ignore]
fn a_structure_edited_and_written_reads_as_edited() {
    use schema_commander_lib::db::compare::{Column, Index, Key, Named, Table, norm_type};
    use schema_commander_lib::db::structure::{ColumnRename, Request, load, plan, run as run_ddl};
    for (p, product) in [
        (pg(), "postgres"),
        (my(), "mysql"),
        (maria(), "mariadb"),
        (ms(), "sqlserver"),
    ] {
        let kind = p.kind;
        let mut s = open(&p);
        let schema = "sc_edit";
        match kind {
            DbKind::Postgres => {
                run(&mut s, &format!("DROP SCHEMA IF EXISTS {schema} CASCADE"));
                run(&mut s, &format!("CREATE SCHEMA {schema}"));
            }
            DbKind::Mysql => {
                run(&mut s, &format!("DROP DATABASE IF EXISTS {schema}"));
                run(&mut s, &format!("CREATE DATABASE {schema}"));
            }
            _ => {
                for t in ["orders_copy", "orders", "bestellungen", "customers"] {
                    run(&mut s, &format!("DROP TABLE IF EXISTS {schema}.{t}"));
                }
                run(&mut s, &format!("DROP SCHEMA IF EXISTS {schema}"));
                run(&mut s, &format!("CREATE SCHEMA {schema}"));
            }
        }
        run(
            &mut s,
            &format!("CREATE TABLE {schema}.customers (id int NOT NULL PRIMARY KEY)"),
        );
        run(
            &mut s,
            &format!("INSERT INTO {schema}.customers (id) VALUES (7)"),
        );
        let col = |name: &str, type_name: &str, nullable: bool, default: Option<&str>| Column {
            name: name.into(),
            type_name: type_name.into(),
            nullable,
            default: default.map(str::to_owned),
        };
        let new = Table {
            name: "orders".into(),
            columns: vec![
                col("id", "int", false, None),
                col("customer_id", "int", false, None),
                col("note", "varchar(40)", true, Some("'it''s'")),
                col("amount", "decimal(8,2)", true, None),
            ],
            pk: vec!["id".into()],
            indexes: vec![Index {
                name: "orders_note".into(),
                unique: false,
                columns: vec!["note".into()],
                definition: None,
            }],
            keys: vec![Key {
                name: "orders_customer".into(),
                columns: vec!["customer_id".into()],
                ref_schema: String::new(),
                ref_table: "customers".into(),
                ref_columns: vec!["id".into()],
            }],
            checks: vec![Named {
                name: "orders_amount".into(),
                text: "amount >= 0".into(),
            }],
            comment: None,
            definition: None,
        };
        let apply = |s: &mut Box<dyn Session>, request: &Request| {
            let plan = plan(kind, request).unwrap_or_else(|e| panic!("{product}: {e}"));
            let statements = plan.statements();
            let ran = run_ddl(
                s.as_mut(),
                kind,
                &statements,
                plan.transactional,
                None,
                &|| false,
            )
            .unwrap();
            assert_eq!(
                ran.failed, None,
                "{product}: {:?}\n{statements:#?}",
                ran.error
            );
            assert_eq!(ran.done, statements.len(), "{product}");
        };
        // what was read is what was edited – by structure: a database writes types, defaults and
        // checks in its own words (`varchar` → `character varying`, `amount >= 0` → `((amount >= (0)…`)
        let shape = |t: &Table| -> Vec<String> {
            let mut out = vec![format!("table {}", t.name)];
            for c in &t.columns {
                out.push(format!(
                    "column {} {} {}{}",
                    c.name,
                    norm_type(&c.type_name),
                    if c.nullable { "null" } else { "not null" },
                    // MariaDB says `NULL` where the others say nothing
                    match c.default.as_deref() {
                        Some(d) if !d.eq_ignore_ascii_case("null") => " default",
                        _ => "",
                    },
                ));
            }
            out.push(format!("pk {:?}", t.pk));
            let mut rest: Vec<String> = t
                .indexes
                .iter()
                // MySQL makes an index for a foreign key by itself, named like the key
                .filter(|i| !t.keys.iter().any(|k| k.name == i.name))
                .map(|i| format!("index {} {} {:?}", i.name, i.unique, i.columns))
                .chain(t.keys.iter().map(|k| {
                    format!(
                        "key {} {:?} -> {} {:?}",
                        k.name, k.columns, k.ref_table, k.ref_columns
                    )
                }))
                .chain(t.checks.iter().map(|c| format!("check {}", c.name)))
                .collect();
            rest.sort();
            out.extend(rest);
            out
        };
        let same = |edited: &Table, read: &Table| -> Vec<String> {
            let (a, b) = (shape(edited), shape(read));
            if a == b {
                Vec::new()
            } else {
                vec![format!("edited {a:#?}\nread {b:#?}")]
            }
        };
        let read = |s: &mut Box<dyn Session>, table: &str| {
            load(s.as_mut(), kind, schema, table, &|| false)
                .unwrap_or_else(|e| panic!("{product}: {table}: {e}"))
        };

        // 1. a new table
        apply(
            &mut s,
            &Request::Change {
                schema: schema.into(),
                before: None,
                after: new.clone(),
                renames: vec![],
            },
        );
        let loaded = read(&mut s, "orders");
        assert_eq!(same(&new, &loaded), Vec::<String>::new(), "{product}: new");
        run(
            &mut s,
            &format!("INSERT INTO {schema}.orders (id, customer_id, amount) VALUES (1, 7, 2.5)"),
        );
        // the default arrived with its quote
        let r = run(&mut s, &format!("SELECT note FROM {schema}.orders"));
        assert_eq!(rows(&r), json!([["it's"]]), "{product}");

        // 2a. a column gets another name: its index follows and stays the same index
        let mut renamed = loaded.clone();
        let note = renamed
            .columns
            .iter()
            .position(|c| c.name == "note")
            .unwrap();
        renamed.columns[note].name = "remark".into();
        for index in &mut renamed.indexes {
            for column in &mut index.columns {
                if column == "note" {
                    *column = "remark".into();
                }
            }
        }
        let request = Request::Change {
            schema: schema.into(),
            before: Some(loaded.clone()),
            after: renamed.clone(),
            renames: vec![ColumnRename {
                from: "note".into(),
                to: "remark".into(),
            }],
        };
        let statements = plan(kind, &request).unwrap().statements();
        assert_eq!(
            statements.len(),
            1,
            "{product}: only the rename: {statements:#?}"
        );
        apply(&mut s, &request);
        let loaded = read(&mut s, "orders");
        assert_eq!(
            same(&renamed, &loaded),
            Vec::<String>::new(),
            "{product}: renamed"
        );

        // 2b. edited: the table renamed, columns added (a name with a blank, a default with a
        // quote), one widened, one dropped
        let mut edited = loaded.clone();
        edited.name = "bestellungen".into();
        let note = edited
            .columns
            .iter()
            .position(|c| c.name == "remark")
            .unwrap();
        edited.columns[note].type_name = "varchar(80)".into();
        edited.columns.push(col("placed on", "date", true, None));
        edited
            .columns
            .push(col("state", "varchar(10)", false, Some("'o''pen'")));
        edited.columns.retain(|c| c.name != "amount");
        edited.checks.clear();
        // the index of the note goes, another one comes; the one MySQL made for the foreign key stays
        // (it refuses to drop that while the key is there)
        let keys: Vec<String> = edited.keys.iter().map(|k| k.name.clone()).collect();
        edited.indexes.retain(|i| keys.contains(&i.name));
        edited.indexes.push(Index {
            name: "bestellungen_state".into(),
            unique: false,
            columns: vec!["state".into(), "customer_id".into()],
            definition: None,
        });
        apply(
            &mut s,
            &Request::Change {
                schema: schema.into(),
                before: Some(loaded),
                after: edited.clone(),
                renames: vec![],
            },
        );
        let again = read(&mut s, "bestellungen");
        assert_eq!(
            same(&edited, &again),
            Vec::<String>::new(),
            "{product}: edited"
        );
        // the row is there, its value under the new name, the new column with its default
        let r = run(
            &mut s,
            &format!("SELECT id, remark, state FROM {schema}.bestellungen"),
        );
        assert_eq!(rows(&r), json!([[1, "it's", "o'pen"]]), "{product}");

        // 3. a failure: nothing stays where DDL is transactional
        let add = match kind {
            DbKind::Sqlserver => format!("ALTER TABLE {schema}.bestellungen ADD half int NULL;"),
            _ => format!("ALTER TABLE {schema}.bestellungen ADD COLUMN half int NULL;"),
        };
        let statements = vec![add, format!("ALTER TABLE {schema}.missing DROP COLUMN x;")];
        let transactional = kind != DbKind::Mysql;
        let ran = run_ddl(s.as_mut(), kind, &statements, transactional, None, &|| {
            false
        })
        .unwrap();
        assert_eq!(ran.failed, Some(1), "{product}");
        assert!(ran.error.is_some());
        assert_eq!(ran.rolled_back, transactional, "{product}");
        let has_half = read(&mut s, "bestellungen")
            .columns
            .iter()
            .any(|c| c.name == "half");
        assert_eq!(has_half, !transactional, "{product}: what a failure leaves");
        // the session is usable afterwards
        run(&mut s, "SELECT 1");

        // 4. a copy with its rows, emptied, dropped
        let table = read(&mut s, "bestellungen");
        apply(
            &mut s,
            &Request::Duplicate {
                schema: schema.into(),
                table,
                name: "orders_copy".into(),
                data: true,
            },
        );
        let count = |s: &mut Box<dyn Session>, t: &str| {
            rows(&run(s, &format!("SELECT count(*) FROM {schema}.{t}")))
        };
        assert_eq!(count(&mut s, "orders_copy"), json!([[1]]), "{product}");
        assert!(
            !read(&mut s, "orders_copy").keys.is_empty(),
            "{product}: the copy has its foreign key"
        );
        apply(
            &mut s,
            &Request::Truncate {
                schema: schema.into(),
                table: "orders_copy".into(),
            },
        );
        assert_eq!(count(&mut s, "orders_copy"), json!([[0]]), "{product}");
        assert_eq!(count(&mut s, "bestellungen"), json!([[1]]), "{product}");
        apply(
            &mut s,
            &Request::Drop {
                schema: schema.into(),
                table: "orders_copy".into(),
            },
        );
        assert!(load(s.as_mut(), kind, schema, "orders_copy", &|| false).is_err());
    }
}

// ── Backup and restore (prompt 044) ─────────────────────────────────────────────────

/// The round trip with the tools of PostgreSQL: back up → restore into an empty database → the schema
/// comparison finds no difference and the rows are there. As an archive (`pg_restore`) and as compressed
/// text (`psql`). Stopping leaves no file. Needs `pg_dump`, `pg_restore` and `psql` on this machine.
#[test]
#[ignore]
fn a_backup_restored_into_an_empty_database_is_the_same() {
    use schema_commander_lib::backup::{
        Content, DumpFormat, DumpSpec, Endpoint, FileKind, RestoreSpec, Tool, dump, file_kind,
        find, restore, run as run_tool,
    };
    use schema_commander_lib::db::compare::{State, compare, snapshot};
    let p = pg();
    let mut s = open(&p);
    for db in ["sc_bak_src", "sc_bak_a", "sc_bak_b"] {
        run(&mut s, &format!("DROP DATABASE IF EXISTS {db}"));
        run(&mut s, &format!("CREATE DATABASE {db}"));
    }
    let on = |db: &str| {
        let mut profile = pg();
        profile.database = db.into();
        profile
    };
    let mut src = open(&on("sc_bak_src"));
    for sql in [
        "CREATE TABLE author (id int PRIMARY KEY, name varchar(40) NOT NULL DEFAULT 'it''s')",
        "CREATE TABLE book (id int PRIMARY KEY, author_id int NOT NULL REFERENCES author (id), \
         title text NOT NULL, price numeric(8,2) CHECK (price >= 0))",
        "CREATE INDEX book_title ON book (title)",
        "CREATE VIEW titles AS SELECT title FROM book",
        "INSERT INTO author VALUES (1, 'Ada'), (2, 'Größe ''quoted''')",
        "INSERT INTO book SELECT g, 1 + g % 2, 'Titel ' || g, g * 1.5 FROM generate_series(1, 5000) g",
    ] {
        run(&mut src, sql);
    }
    let endpoint = |db: &str| Endpoint {
        kind: DbKind::Postgres,
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone(),
        database: db.into(),
        password: Some(Secret::new(PW)),
        tls: p.tls,
        ca_file: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        maria_client: false,
    };
    let tool = |tool: Tool| {
        find(
            tool,
            None,
            std::env::var_os("PATH").as_deref(),
            None,
            &|p| p.is_file(),
        )
        .unwrap_or_else(|_| panic!("{tool:?} is not on this machine"))
    };
    let dir = tempfile::tempdir().unwrap();
    let said = std::sync::Mutex::new(Vec::<String>::new());
    let hear = |line: String| said.lock().unwrap().push(line);
    let same = |db: &str| {
        let mut a = open(&on("sc_bak_src"));
        let mut b = open(&on(db));
        let left = snapshot(a.as_mut(), DbKind::Postgres, "public", &|| false).unwrap();
        let right = snapshot(b.as_mut(), DbKind::Postgres, "public", &|| false).unwrap();
        assert_eq!(left.tables.len(), 2);
        let differing: Vec<String> = compare(&left, &right, &[])
            .unwrap()
            .into_iter()
            .filter(|i| i.state != State::Same)
            .map(|i| format!("{} {:?}", i.id, i.state))
            .collect();
        assert_eq!(differing, Vec::<String>::new(), "{db}");
        let sample = "SELECT count(*), sum(price), max(title) FROM book";
        assert_eq!(
            rows(&run(&mut a, sample)),
            rows(&run(&mut b, sample)),
            "{db}"
        );
        assert_eq!(
            rows(&run(&mut b, "SELECT name FROM author ORDER BY id")),
            json!([["Ada"], ["Größe 'quoted'"]])
        );
    };

    // 1. as an archive, restored with pg_restore
    let archive = dir.path().join("shop.dump");
    let spec = DumpSpec {
        format: DumpFormat::Custom,
        no_owner: true,
        ..DumpSpec::default()
    };
    let i = dump(&endpoint("sc_bak_src"), &spec, &archive).unwrap();
    assert!(!i.args.iter().any(|a| a.contains(PW)));
    run_tool(&tool(Tool::PgDump), &i, dir.path(), &hear, &|| false).unwrap();
    assert_eq!(file_kind(&archive).unwrap(), FileKind::PgCustom);
    let back = RestoreSpec {
        single_transaction: true,
        stop_on_error: true,
        no_owner: true,
        ..RestoreSpec::default()
    };
    let i = restore(&endpoint("sc_bak_a"), &back, FileKind::PgCustom, &archive).unwrap();
    let done = run_tool(&tool(Tool::PgRestore), &i, dir.path(), &hear, &|| false).unwrap();
    assert!(!done.warnings);
    same("sc_bak_a");

    // 2. as compressed text, restored with psql
    let text = dir.path().join("shop.sql.gz");
    let spec = DumpSpec {
        gzip: true,
        no_owner: true,
        inserts: true,
        content: Content::All,
        ..DumpSpec::default()
    };
    let i = dump(&endpoint("sc_bak_src"), &spec, &text).unwrap();
    let wrote = run_tool(&tool(Tool::PgDump), &i, dir.path(), &hear, &|| false).unwrap();
    assert!(wrote.bytes > 100_000);
    assert_eq!(file_kind(&text).unwrap(), FileKind::SqlGzip);
    assert!(std::fs::metadata(&text).unwrap().len() < wrote.bytes / 3);
    let i = restore(&endpoint("sc_bak_b"), &back, FileKind::SqlGzip, &text).unwrap();
    run_tool(&tool(Tool::Psql), &i, dir.path(), &hear, &|| false).unwrap();
    same("sc_bak_b");

    // 3. a restore into a database that has the tables already fails, and says what the tool said
    let failed = run_tool(&tool(Tool::Psql), &i, dir.path(), &hear, &|| false).unwrap_err();
    assert!(
        failed.message.contains("already exists"),
        "{}",
        failed.message
    );

    // 4. a wrong password: the tool says so, nothing is written, and the password is in no line
    let mut wrong = endpoint("sc_bak_src");
    wrong.password = Some(Secret::new("not-the-password-123"));
    let nothing = dir.path().join("nothing.sql");
    let i = dump(&wrong, &DumpSpec::default(), &nothing).unwrap();
    let failed = run_tool(&tool(Tool::PgDump), &i, dir.path(), &hear, &|| false).unwrap_err();
    assert!(
        failed.message.to_lowercase().contains("password"),
        "{}",
        failed.message
    );
    assert!(!nothing.exists());

    // 5. stopped: no process, no half file
    let half = dir.path().join("half.sql");
    let i = dump(&endpoint("sc_bak_src"), &DumpSpec::default(), &half).unwrap();
    let stopped = run_tool(&tool(Tool::PgDump), &i, dir.path(), &hear, &|| true).unwrap_err();
    assert_eq!(stopped.code, ErrorCode::Cancelled);
    assert!(!half.exists());

    let all = said.lock().unwrap().join("\n");
    assert!(!all.contains(PW), "the password was said");
    assert!(!all.contains("not-the-password-123"));
    // nothing of ours is left in the folder but the two backups
    let mut left: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, ["shop.dump", "shop.sql.gz"]);
    drop(src);
    for db in ["sc_bak_src", "sc_bak_a", "sc_bak_b"] {
        run(
            &mut s,
            &format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"),
        );
    }
}

// ── Copying tables between databases (prompt 045) ──────────────────────────────────

/// A table with every kind of value goes from PostgreSQL to MySQL and back, to SQL Server and to
/// SQLite: created there with mapped types, in the order of its keys, every value bound. Where the
/// mapping loses nothing, what comes back is what went. Many rows stream; stopping ends both sides.
#[test]
#[ignore]
fn tables_copied_between_databases_arrive_as_they_were() {
    use schema_commander_lib::db::compare::snapshot;
    use schema_commander_lib::db::load::OnError;
    use schema_commander_lib::db::transfer::{Event, Mode, Request, plan, run as transfer};
    let mut a = open(&pg());
    run(&mut a, "DROP SCHEMA IF EXISTS sc_xfer CASCADE");
    run(&mut a, "DROP SCHEMA IF EXISTS sc_xfer_back CASCADE");
    run(&mut a, "CREATE SCHEMA sc_xfer");
    run(&mut a, "CREATE SCHEMA sc_xfer_back");
    for sql in [
        "CREATE TABLE sc_xfer.kinds (id int PRIMARY KEY, t text, v varchar(20), n numeric(12,2),          big bigint, f double precision, b boolean, d date, ts timestamp, tz timestamptz, j jsonb,          u uuid, raw bytea)",
        "CREATE TABLE sc_xfer.child (id int PRIMARY KEY, kind_id int NOT NULL REFERENCES sc_xfer.kinds (id),          note text)",
        "CREATE INDEX child_kind ON sc_xfer.child (kind_id)",
        "INSERT INTO sc_xfer.kinds VALUES          (1, 'Größe 🚀 ''quoted'' \\ back', 'kurz', 1234567890.12, 9007199254740993, 0.1, true,           '2026-11-12', '2026-11-12 13:30:05.25', '2026-11-12 13:30:05.25+02',           '{\"a\": [1, 2], \"ü\": null}', '6f1c1e9e-7d0a-4b6e-9a55-0c1d2e3f4a5b', '\\x00ff10'),          (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),          (3, '', '', 0, 0, 0, false, '1999-12-31', '1999-12-31 23:59:59', '1999-12-31 23:59:59+00',           '[]', '00000000-0000-0000-0000-000000000000', '\\x'),          (4, E'Zeile\\nzwei\\ttab; DROP TABLE x; --', 'x', -0.01, -9223372036854775808, -1.5e300,           true, '0001-01-01', '2000-02-29 00:00:00', '2000-02-29 00:00:00-11', '\"text\"',           'ffffffff-ffff-ffff-ffff-ffffffffffff', '\\xdeadbeef')",
        "INSERT INTO sc_xfer.child VALUES (1, 1, 'a'), (2, 4, NULL)",
    ] {
        run(&mut a, sql);
    }
    let request = |source: &str, target: &str| Request {
        source_schema: source.into(),
        tables: vec!["child".into(), "kinds".into()],
        target_schema: target.into(),
        mode: Mode::Append,
        with_keys: true,
        whole_transaction: true,
        on_error: OnError::Abort,
    };
    let copy = |from: &mut Box<dyn Session>,
                from_kind: DbKind,
                to: &mut Box<dyn Session>,
                to_kind: DbKind,
                request: &Request| {
        let source = snapshot(from.as_mut(), from_kind, &request.source_schema, &|| false).unwrap();
        let target = snapshot(to.as_mut(), to_kind, &request.target_schema, &|| false).unwrap();
        let made = plan(from_kind, to_kind, &source, &target, request).unwrap();
        // the tables in the order of their keys, whatever order was asked for
        assert_eq!(
            made.tables
                .iter()
                .map(|t| t.table.as_str())
                .collect::<Vec<_>>(),
            ["kinds", "child"]
        );
        let report = transfer(
            from.as_mut(),
            to.as_mut(),
            to_kind,
            &made,
            &|_| None,
            None,
            &|_| {},
            &|| false,
        );
        for t in &report.tables {
            assert!(
                !t.loaded.failed && t.error.is_none(),
                "{from_kind:?} → {to_kind:?}: {t:#?}\n{:#?}",
                made.statements
            );
        }
        assert_eq!(
            report.after_errors,
            Vec::<String>::new(),
            "{from_kind:?} → {to_kind:?}"
        );
        assert_eq!(report.tables[0].loaded.written, 4);
        assert_eq!(report.tables[1].loaded.written, 2);
        made
    };

    // PostgreSQL → MySQL
    let mut my = open(&my());
    run(&mut my, "DROP DATABASE IF EXISTS sc_xfer_my");
    run(&mut my, "CREATE DATABASE sc_xfer_my");
    let made = copy(
        &mut a,
        DbKind::Postgres,
        &mut my,
        DbKind::Mysql,
        &request("sc_xfer", "sc_xfer_my"),
    );
    // what is lost is said before: the zone of the instant
    let lossy: Vec<&str> = made.tables[0]
        .columns
        .iter()
        .filter(|c| c.loss.is_some())
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(lossy, ["tz"]);
    let r = run(
        &mut my,
        "SELECT id, t, v, CAST(n AS char), CAST(big AS char), b, CAST(d AS char), HEX(raw), raw IS NULL,          CAST(tz AS char) FROM sc_xfer_my.kinds ORDER BY id",
    );
    assert_eq!(
        rows(&r),
        json!([
            [
                1,
                "Größe 🚀 'quoted' \\ back",
                "kurz",
                "1234567890.12",
                "9007199254740993",
                true,
                "2026-11-12",
                "00FF10",
                0,
                "2026-11-12 11:30:05.250000"
            ],
            [2, null, null, null, null, null, null, null, 1, null],
            [
                3,
                "",
                "",
                "0.00",
                "0",
                false,
                "1999-12-31",
                "",
                0,
                "1999-12-31 23:59:59.000000"
            ],
            [
                4,
                "Zeile\nzwei\ttab; DROP TABLE x; --",
                "x",
                "-0.01",
                "-9223372036854775808",
                true,
                "0001-01-01",
                "DEADBEEF",
                0,
                "2000-02-29 11:00:00.000000"
            ]
        ])
    );
    // the key and the index were made after the rows
    let child = snapshot(my.as_mut(), DbKind::Mysql, "sc_xfer_my", &|| false)
        .unwrap()
        .tables
        .into_iter()
        .find(|t| t.name == "child")
        .unwrap();
    assert_eq!(child.keys.len(), 1);
    assert!(child.indexes.iter().any(|i| i.name == "child_kind"));

    // … and back: MySQL → PostgreSQL. Where nothing was lost, the values are the same.
    let mut b = open(&pg());
    copy(
        &mut my,
        DbKind::Mysql,
        &mut b,
        DbKind::Postgres,
        &request("sc_xfer_my", "sc_xfer_back"),
    );
    let same = "SELECT id, t, v, n::text, big::text, f::text, b::text, d::text, ts::text, j::text,                 trim(u::text), encode(raw, 'hex') FROM {}.kinds ORDER BY id";
    assert_eq!(
        rows(&run(&mut a, &same.replace("{}", "sc_xfer"))),
        rows(&run(&mut b, &same.replace("{}", "sc_xfer_back")))
    );
    // the instant came back as UTC without its zone
    assert_eq!(
        rows(&run(
            &mut a,
            "SELECT (tz AT TIME ZONE 'UTC')::text FROM sc_xfer.kinds ORDER BY id"
        )),
        rows(&run(
            &mut b,
            "SELECT tz::text FROM sc_xfer_back.kinds ORDER BY id"
        ))
    );
    assert_eq!(
        rows(&run(
            &mut b,
            "SELECT id, kind_id, note FROM sc_xfer_back.child ORDER BY id"
        )),
        json!([[1, 1, "a"], [2, 4, null]])
    );

    // PostgreSQL → SQL Server (an instant of PostgreSQL has no zone of its own: it arrives as UTC)
    let mut ms = open(&ms());
    for t in ["child", "kinds"] {
        run(&mut ms, &format!("DROP TABLE IF EXISTS sc_xfer.{t}"));
    }
    run(&mut ms, "DROP SCHEMA IF EXISTS sc_xfer");
    run(&mut ms, "CREATE SCHEMA sc_xfer");
    copy(
        &mut a,
        DbKind::Postgres,
        &mut ms,
        DbKind::Sqlserver,
        &request("sc_xfer", "sc_xfer"),
    );
    let r = run(
        &mut ms,
        "SELECT id, t, CONVERT(varchar(40), n), CONVERT(varchar(40), big), b, CONVERT(varchar(10), d, 23),          CONVERT(varchar(max), raw, 2), CONVERT(varchar(40), tz, 127), LOWER(CONVERT(varchar(36), u))          FROM sc_xfer.kinds ORDER BY id",
    );
    assert_eq!(
        rows(&r),
        json!([
            [
                1,
                "Größe 🚀 'quoted' \\ back",
                "1234567890.12",
                "9007199254740993",
                true,
                "2026-11-12",
                "00FF10",
                "2026-11-12T11:30:05.2500000Z",
                "6f1c1e9e-7d0a-4b6e-9a55-0c1d2e3f4a5b"
            ],
            [2, null, null, null, null, null, null, null, null],
            [
                3,
                "",
                "0.00",
                "0",
                false,
                "1999-12-31",
                "",
                "1999-12-31T23:59:59Z",
                "00000000-0000-0000-0000-000000000000"
            ],
            [
                4,
                "Zeile\nzwei\ttab; DROP TABLE x; --",
                "-0.01",
                "-9223372036854775808",
                true,
                "0001-01-01",
                "DEADBEEF",
                "2000-02-29T11:00:00Z",
                "ffffffff-ffff-ffff-ffff-ffffffffffff"
            ]
        ])
    );

    // PostgreSQL → SQLite (a database in memory)
    let mut lite: Box<dyn Session> = Box::new(
        schema_commander_lib::db::sqlite::open(&schema_commander_lib::db::sqlite::demo_profile())
            .unwrap(),
    );
    copy(
        &mut a,
        DbKind::Postgres,
        &mut lite,
        DbKind::Sqlite,
        &request("sc_xfer", "main"),
    );
    let r = run(
        &mut lite,
        "SELECT id, t, b, d, hex(raw), typeof(raw), tz FROM kinds ORDER BY id",
    );
    assert_eq!(
        rows(&r),
        json!([
            [
                1,
                "Größe 🚀 'quoted' \\ back",
                1,
                "2026-11-12",
                "00FF10",
                "blob",
                "2026-11-12 11:30:05.250"
            ],
            // (`hex(NULL)` is an empty text in SQLite; `typeof` says what the value is)
            [2, null, null, null, "", "null", null],
            [3, "", 0, "1999-12-31", "", "blob", "1999-12-31 23:59:59"],
            [
                4,
                "Zeile\nzwei\ttab; DROP TABLE x; --",
                1,
                "0001-01-01",
                "DEADBEEF",
                "blob",
                "2000-02-29 11:00:00"
            ]
        ])
    );

    // many rows: they stream block by block; stopped in the middle, both sides end and what was
    // written stays (blocks, not one transaction)
    run(
        &mut a,
        "CREATE TABLE sc_xfer.many (id int PRIMARY KEY, name text, n numeric(12,2))",
    );
    run(
        &mut a,
        "INSERT INTO sc_xfer.many SELECT g, 'row ' || g, g * 1.25 FROM generate_series(1, 300000) g",
    );
    run(
        &mut my,
        "CREATE TABLE sc_xfer_my.many (id int PRIMARY KEY, name longtext, n decimal(12,2))",
    );
    let many = Request {
        tables: vec!["many".into()],
        whole_transaction: false,
        ..request("sc_xfer", "sc_xfer_my")
    };
    let source = snapshot(a.as_mut(), DbKind::Postgres, "sc_xfer", &|| false).unwrap();
    let target = snapshot(my.as_mut(), DbKind::Mysql, "sc_xfer_my", &|| false).unwrap();
    let made = plan(DbKind::Postgres, DbKind::Mysql, &source, &target, &many).unwrap();
    let begun = std::time::Instant::now();
    let report = transfer(
        a.as_mut(),
        my.as_mut(),
        DbKind::Mysql,
        &made,
        &|_| None,
        None,
        &|_| {},
        &|| false,
    );
    assert_eq!(report.tables[0].loaded.written, 300_000, "{report:#?}");
    eprintln!("300 000 rows PostgreSQL → MySQL in {:?}", begun.elapsed());
    assert_eq!(
        rows(&run(
            &mut my,
            "SELECT count(*), CAST(sum(n) AS char), max(id) FROM sc_xfer_my.many"
        )),
        json!([[300000, "56250187500.00", 300000]])
    );
    run(&mut my, "TRUNCATE TABLE sc_xfer_my.many");
    let seen = std::sync::atomic::AtomicU64::new(0);
    let report = transfer(
        a.as_mut(),
        my.as_mut(),
        DbKind::Mysql,
        &made,
        &|_| None,
        None,
        &|e| {
            if let Event::Rows { read, .. } = e {
                seen.store(read, std::sync::atomic::Ordering::Relaxed);
            }
        },
        &|| seen.load(std::sync::atomic::Ordering::Relaxed) >= 20_000,
    );
    assert!(report.cancelled);
    let written = report.tables[0].loaded.written;
    assert!((20_000..300_000).contains(&written), "{written}");
    assert_eq!(
        rows(&run(&mut my, "SELECT count(*) FROM sc_xfer_my.many")),
        json!([[written]])
    );
    // both sessions go on
    run(&mut a, "SELECT 1");
    run(&mut my, "SELECT 1");
    run(&mut my, "DROP DATABASE sc_xfer_my");
    for t in ["child", "kinds"] {
        run(&mut ms, &format!("DROP TABLE IF EXISTS sc_xfer.{t}"));
    }
    run(&mut a, "DROP SCHEMA sc_xfer CASCADE");
    run(&mut a, "DROP SCHEMA sc_xfer_back CASCADE");
}
