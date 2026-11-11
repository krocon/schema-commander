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
