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
