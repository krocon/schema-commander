use super::*;
use crate::db::compare::{Column as Col, Index, Key, Named};
use crate::db::sqlite;

const ALL: [DbKind; 4] = [
    DbKind::Postgres,
    DbKind::Mysql,
    DbKind::Sqlserver,
    DbKind::Sqlite,
];

#[test]
fn knows_what_a_type_is() {
    use Class::*;
    for (kind, name, want) in [
        (DbKind::Postgres, "integer", Int),
        (DbKind::Postgres, "int8", BigInt),
        (DbKind::Postgres, "numeric(12,2)", Numeric(Some((12, 2)))),
        (DbKind::Postgres, "numeric", Numeric(None)),
        (DbKind::Postgres, "character varying(40)", Varchar(Some(40))),
        (DbKind::Postgres, "character varying", Varchar(None)),
        (DbKind::Postgres, "timestamp with time zone", TimestampTz),
        (DbKind::Postgres, "timestamp without time zone", Timestamp),
        (DbKind::Postgres, "jsonb", Json),
        (DbKind::Postgres, "uuid", Uuid),
        (DbKind::Postgres, "bytea", Bytes),
        (DbKind::Postgres, "double precision", Double),
        (DbKind::Postgres, "integer[]", Other),
        (DbKind::Postgres, "inet", Other),
        (DbKind::Postgres, "bit(8)", Other),
        (DbKind::Mysql, "tinyint(1)", Bool),
        (DbKind::Mysql, "tinyint(4)", SmallInt),
        (DbKind::Mysql, "int(11)", Int),
        (DbKind::Mysql, "int(10) unsigned", BigInt),
        (DbKind::Mysql, "bigint(20) unsigned", Numeric(Some((20, 0)))),
        (DbKind::Mysql, "decimal(10,2)", Numeric(Some((10, 2)))),
        (DbKind::Mysql, "decimal", Numeric(Some((10, 0)))),
        (DbKind::Mysql, "float", Real),
        (DbKind::Mysql, "datetime(6)", Timestamp),
        (DbKind::Mysql, "longtext", Text),
        (DbKind::Mysql, "varbinary(16)", Bytes),
        (DbKind::Mysql, "enum('a','b')", Other),
        (DbKind::Sqlserver, "bit", Bool),
        (DbKind::Sqlserver, "nvarchar(max)", Text),
        (DbKind::Sqlserver, "nvarchar(50)", Varchar(Some(50))),
        (DbKind::Sqlserver, "datetimeoffset", TimestampTz),
        (DbKind::Sqlserver, "datetime2", Timestamp),
        (DbKind::Sqlserver, "uniqueidentifier", Uuid),
        (DbKind::Sqlserver, "money", Numeric(Some((19, 4)))),
        (DbKind::Sqlserver, "float", Double),
        (DbKind::Sqlserver, "decimal", Numeric(Some((18, 0)))),
        (DbKind::Sqlite, "INTEGER", BigInt),
        (DbKind::Sqlite, "VARCHAR(20)", Text),
        (DbKind::Sqlite, "BLOB", Bytes),
        // without a type a column holds anything (review 045, H1)
        (DbKind::Sqlite, "", Other),
        (DbKind::Sqlite, "DOUBLE", Double),
        (DbKind::Sqlite, "DECIMAL(10,2)", Numeric(None)),
        (DbKind::Sqlite, "BOOLEAN", Bool),
        (DbKind::Sqlite, "DATETIME", Timestamp),
    ] {
        assert_eq!(class_of(kind, name), want, "{kind:?} {name}");
    }
}

/// The catalog of the prompt, for every pair of dialects: what a type becomes and what is lost.
#[test]
fn maps_types_between_dialects_and_names_what_is_lost() {
    for (from, name, to, want, lossy) in [
        (DbKind::Postgres, "jsonb", DbKind::Mysql, "json", false),
        (
            DbKind::Postgres,
            "jsonb",
            DbKind::Sqlserver,
            "nvarchar(max)",
            true,
        ),
        (DbKind::Postgres, "jsonb", DbKind::Sqlite, "TEXT", true),
        (DbKind::Postgres, "uuid", DbKind::Mysql, "char(36)", false),
        (
            DbKind::Postgres,
            "uuid",
            DbKind::Sqlserver,
            "uniqueidentifier",
            false,
        ),
        (
            DbKind::Postgres,
            "timestamptz",
            DbKind::Mysql,
            "datetime(6)",
            true,
        ),
        (
            DbKind::Postgres,
            "timestamptz",
            DbKind::Sqlserver,
            "datetimeoffset",
            false,
        ),
        (
            DbKind::Postgres,
            "timestamptz",
            DbKind::Sqlite,
            "DATETIME",
            true,
        ),
        (DbKind::Postgres, "bytea", DbKind::Mysql, "longblob", false),
        (DbKind::Postgres, "bytea", DbKind::Sqlite, "BLOB", false),
        (
            DbKind::Postgres,
            "numeric(12,2)",
            DbKind::Mysql,
            "decimal(12,2)",
            false,
        ),
        (
            DbKind::Postgres,
            "numeric",
            DbKind::Mysql,
            "decimal(65,30)",
            true,
        ),
        (
            DbKind::Postgres,
            "numeric(50,4)",
            DbKind::Sqlserver,
            "decimal(38,10)",
            true,
        ),
        (
            DbKind::Postgres,
            "numeric(12,2)",
            DbKind::Sqlite,
            "NUMERIC",
            true,
        ),
        (DbKind::Postgres, "text", DbKind::Mysql, "longtext", false),
        (
            DbKind::Postgres,
            "varchar(40)",
            DbKind::Sqlserver,
            "nvarchar(40)",
            false,
        ),
        (
            DbKind::Postgres,
            "varchar(9000)",
            DbKind::Sqlserver,
            "nvarchar(max)",
            false,
        ),
        (
            DbKind::Postgres,
            "boolean",
            DbKind::Mysql,
            "tinyint(1)",
            false,
        ),
        (DbKind::Postgres, "boolean", DbKind::Sqlserver, "bit", false),
        (
            DbKind::Postgres,
            "integer[]",
            DbKind::Mysql,
            "longtext",
            true,
        ),
        (
            DbKind::Mysql,
            "tinyint(1)",
            DbKind::Postgres,
            "boolean",
            false,
        ),
        (
            DbKind::Mysql,
            "datetime",
            DbKind::Postgres,
            "timestamp",
            false,
        ),
        (
            DbKind::Mysql,
            "int unsigned",
            DbKind::Postgres,
            "bigint",
            false,
        ),
        (
            DbKind::Mysql,
            "bigint unsigned",
            DbKind::Postgres,
            "numeric(20,0)",
            false,
        ),
        (DbKind::Mysql, "longblob", DbKind::Postgres, "bytea", false),
        (DbKind::Mysql, "json", DbKind::Postgres, "jsonb", false),
        (
            DbKind::Mysql,
            "enum('a','b')",
            DbKind::Postgres,
            "text",
            true,
        ),
        (DbKind::Mysql, "double", DbKind::Sqlserver, "float", false),
        (
            DbKind::Sqlserver,
            "nvarchar(max)",
            DbKind::Postgres,
            "text",
            false,
        ),
        (
            DbKind::Sqlserver,
            "datetime2",
            DbKind::Mysql,
            "datetime(6)",
            false,
        ),
        (
            DbKind::Sqlserver,
            "datetimeoffset",
            DbKind::Postgres,
            "timestamptz",
            false,
        ),
        (
            DbKind::Sqlserver,
            "uniqueidentifier",
            DbKind::Postgres,
            "uuid",
            false,
        ),
        (DbKind::Sqlserver, "bit", DbKind::Postgres, "boolean", false),
        (
            DbKind::Sqlserver,
            "varbinary(max)",
            DbKind::Mysql,
            "longblob",
            false,
        ),
        (DbKind::Sqlite, "INTEGER", DbKind::Postgres, "bigint", false),
        (DbKind::Sqlite, "TEXT", DbKind::Mysql, "longtext", false),
        (
            DbKind::Sqlite,
            "REAL",
            DbKind::Postgres,
            "double precision",
            false,
        ),
        (
            DbKind::Sqlite,
            "BLOB",
            DbKind::Sqlserver,
            "varbinary(max)",
            false,
        ),
    ] {
        let mapped = map_type(from, to, name);
        assert_eq!(mapped.type_name, want, "{from:?} {name} → {to:?}");
        assert_eq!(
            mapped.loss.is_some(),
            lossy,
            "{from:?} {name} → {to:?}: {:?}",
            mapped.loss
        );
    }
    // a type goes into its own dialect as what it is
    for kind in ALL {
        for class in [
            Class::Int,
            Class::BigInt,
            Class::Double,
            Class::Bool,
            Class::Date,
            Class::Timestamp,
            Class::Bytes,
            Class::Text,
        ] {
            let (name, _) = type_for(kind, class);
            let back = class_of(kind, &name);
            let same = back == class
                // SQLite has one kind of whole number
                || (kind == DbKind::Sqlite && class == Class::Int && back == Class::BigInt);
            assert!(same, "{kind:?} {class:?} → {name} → {back:?}");
        }
    }
}

fn col(name: &str, type_name: &str, nullable: bool) -> Col {
    Col {
        name: name.into(),
        type_name: type_name.into(),
        nullable,
        default: None,
    }
}

fn shop() -> Snapshot {
    let author = Table {
        name: "author".into(),
        columns: vec![
            col("id", "integer", false),
            Col {
                default: Some("'x'::text".into()),
                ..col("name", "text", false)
            },
            col("born", "timestamptz", true),
        ],
        pk: vec!["id".into()],
        ..Table::default()
    };
    let book = Table {
        name: "book".into(),
        columns: vec![
            col("id", "integer", false),
            col("author_id", "integer", false),
            col("meta", "jsonb", true),
            col("cover", "bytea", true),
        ],
        pk: vec!["id".into()],
        indexes: vec![
            Index {
                name: "book_author".into(),
                unique: false,
                columns: vec!["author_id".into()],
                definition: Some(
                    "CREATE INDEX book_author ON shop.book USING btree (author_id)".into(),
                ),
            },
            Index {
                name: "book_expr".into(),
                unique: false,
                columns: vec![],
                definition: Some("CREATE INDEX book_expr ON shop.book ((meta->>'x'))".into()),
            },
        ],
        keys: vec![Key {
            name: "book_author_fk".into(),
            columns: vec!["author_id".into()],
            ref_schema: String::new(),
            ref_table: "author".into(),
            ref_columns: vec!["id".into()],
        }],
        checks: vec![Named {
            name: "c".into(),
            text: "id > 0".into(),
        }],
        ..Table::default()
    };
    Snapshot {
        kind: DbKind::Postgres,
        schema: "shop".into(),
        tables: vec![author, book],
        views: Vec::new(),
        routines: Vec::new(),
        triggers: Vec::new(),
    }
}

fn empty(kind: DbKind, schema: &str) -> Snapshot {
    Snapshot {
        kind,
        schema: schema.into(),
        tables: Vec::new(),
        views: Vec::new(),
        routines: Vec::new(),
        triggers: Vec::new(),
    }
}

fn request(tables: &[&str]) -> Request {
    Request {
        source_schema: "shop".into(),
        tables: tables.iter().map(|t| (*t).to_owned()).collect(),
        target_schema: "copy".into(),
        mode: Mode::Append,
        with_keys: true,
        whole_transaction: false,
        on_error: OnError::Abort,
    }
}

#[test]
fn plans_new_tables_in_the_order_of_their_keys_with_the_losses() {
    // asked for in the wrong order
    let made = plan(
        DbKind::Postgres,
        DbKind::Mysql,
        &shop(),
        &empty(DbKind::Mysql, "copy"),
        &request(&["book", "author"]),
    )
    .unwrap();
    assert_eq!(
        made.tables
            .iter()
            .map(|t| t.table.as_str())
            .collect::<Vec<_>>(),
        ["author", "book"]
    );
    assert!(made.cycle.is_empty());
    let author = &made.tables[0];
    assert!(!author.exists);
    assert!(
        author.before[0].starts_with("CREATE TABLE copy.author ("),
        "{:?}",
        author.before
    );
    assert!(author.before[0].contains("born datetime(6)"));
    assert_eq!(
        author.columns[2].loss.as_deref(),
        Some("the time zone is lost: the instant is stored as UTC")
    );
    assert_eq!(
        author.notes,
        ["defaults are not copied: they are written in the dialect of the source"]
    );
    assert_eq!(
        author.select,
        "SELECT \"id\", \"name\", \"born\" FROM \"shop\".\"author\""
    );
    let book = &made.tables[1];
    assert!(book.before[0].contains("meta json"), "{:?}", book.before);
    assert!(book.before[0].contains("cover longblob"));
    // the index and the key come after the rows; the index on an expression and the check are said
    let after = book.after.join("\n");
    assert!(
        after.contains("CREATE INDEX book_author ON copy.book (author_id);"),
        "{after}"
    );
    assert!(
        after.contains("FOREIGN KEY (author_id) REFERENCES copy.author (id)"),
        "{after}"
    );
    assert!(book.notes.iter().any(|n| n.contains("checks")));
    assert!(book.notes.iter().any(|n| n.contains("expression")));
    // what the guard is asked about: create, insert, create, insert, then indexes and keys
    let kinds: Vec<&str> = made
        .statements
        .iter()
        .map(|s| s.split_whitespace().next().unwrap_or_default())
        .collect();
    assert_eq!(kinds[..4], ["CREATE", "INSERT", "CREATE", "INSERT"]);
    assert!(
        kinds[4..].iter().all(|k| *k == "CREATE" || *k == "ALTER"),
        "{kinds:?}"
    );
    // bytes travel as hex, turned into bytes by the statement
    assert!(
        made.statements[3].contains("UNHEX(?)"),
        "{}",
        made.statements[3]
    );
    assert_eq!(created(&made).get("book"), Some(&true));
}

#[test]
fn uses_a_table_that_is_there_and_leaves_out_what_it_has_no_column_for() {
    let mut target = empty(DbKind::Sqlite, "main");
    target.tables.push(Table {
        name: "Author".into(),
        columns: vec![col("ID", "INTEGER", false), col("born", "TEXT", true)],
        pk: vec!["ID".into()],
        ..Table::default()
    });
    let mut req = request(&["author"]);
    req.mode = Mode::Clear;
    req.target_schema = "main".into();
    let made = plan(DbKind::Postgres, DbKind::Sqlite, &shop(), &target, &req).unwrap();
    let t = &made.tables[0];
    assert!(t.exists);
    assert!(t.before.is_empty() && t.after.is_empty());
    // by name, whatever the case; `name` has no column in the target
    assert_eq!(
        t.columns
            .iter()
            .map(|c| c.target.as_deref())
            .collect::<Vec<_>>(),
        [Some("ID"), None, Some("born")]
    );
    assert_eq!(t.select, "SELECT \"id\", \"born\" FROM \"shop\".\"author\"");
    assert_eq!(t.load.table, "Author");
    assert!(t.load.clear_first);
    assert_eq!(made.statements[0], "DELETE FROM Author");
    assert!(made.statements[1].starts_with("INSERT INTO"));
    assert!(t.columns[2].loss.is_some());
}

#[test]
fn refuses_what_cannot_be_copied() {
    let source = shop();
    let target = empty(DbKind::Mysql, "copy");
    assert!(
        plan(
            DbKind::Postgres,
            DbKind::Mysql,
            &source,
            &target,
            &request(&[])
        )
        .is_err()
    );
    assert!(
        plan(
            DbKind::Postgres,
            DbKind::Mysql,
            &source,
            &target,
            &request(&["gone"])
        )
        .is_err()
    );
    // a table that shares no column with its target
    let mut other = empty(DbKind::Mysql, "copy");
    other.tables.push(Table {
        name: "author".into(),
        columns: vec![col("something", "int", true)],
        ..Table::default()
    });
    assert!(
        plan(
            DbKind::Postgres,
            DbKind::Mysql,
            &source,
            &other,
            &request(&["author"])
        )
        .is_err()
    );
    // a name that is no name
    let mut evil = shop();
    evil.tables[0].name = "a\nb".into();
    assert!(
        plan(
            DbKind::Postgres,
            DbKind::Mysql,
            &evil,
            &target,
            &request(&["a\nb"])
        )
        .is_err()
    );
}

#[test]
fn tables_in_a_circle_are_said() {
    let mut source = shop();
    source.tables[0].keys.push(Key {
        name: "author_best".into(),
        columns: vec!["id".into()],
        ref_schema: String::new(),
        ref_table: "book".into(),
        ref_columns: vec!["id".into()],
    });
    let made = plan(
        DbKind::Postgres,
        DbKind::Mysql,
        &source,
        &empty(DbKind::Mysql, "copy"),
        &request(&["author", "book"]),
    )
    .unwrap();
    assert_eq!(made.cycle, ["author", "book"]);
    assert_eq!(made.tables.len(), 2);
}

#[test]
fn a_cell_travels_as_text_that_loses_nothing() {
    use chrono::{FixedOffset, NaiveDate, TimeZone};
    let ts = NaiveDate::from_ymd_opt(2026, 11, 12)
        .unwrap()
        .and_hms_micro_opt(13, 30, 5, 250_000)
        .unwrap();
    let tz = FixedOffset::east_opt(2 * 3600)
        .unwrap()
        .from_local_datetime(&ts)
        .unwrap();
    for (cell, kind, zone, want) in [
        (Cell::Null, ValueKind::Text, false, None),
        (Cell::Text(String::new()), ValueKind::Text, false, Some("")),
        (
            Cell::Text("Größe 🚀 'x'".into()),
            ValueKind::Text,
            false,
            Some("Größe 🚀 'x'"),
        ),
        (Cell::I64(-42), ValueKind::Number, false, Some("-42")),
        (
            Cell::U64(u64::MAX),
            ValueKind::Number,
            false,
            Some("18446744073709551615"),
        ),
        (
            Cell::Decimal("123456789012345678901234567890.123456789".into()),
            ValueKind::Number,
            false,
            Some("123456789012345678901234567890.123456789"),
        ),
        (Cell::F64(0.1), ValueKind::Text, false, Some("0.1")),
        (
            Cell::F64(-1.5e300),
            ValueKind::Text,
            false,
            Some("-1.5e300"),
        ),
        (Cell::F64(2.5e-9), ValueKind::Text, false, Some("2.5e-9")),
        (Cell::F64(0.0), ValueKind::Text, false, Some("0")),
        (
            Cell::F64(123456.75),
            ValueKind::Text,
            false,
            Some("123456.75"),
        ),
        (Cell::Bool(true), ValueKind::Bool, false, Some("true")),
        (Cell::Bool(true), ValueKind::Number, false, Some("1")),
        (Cell::I64(0), ValueKind::Bool, false, Some("false")),
        (
            Cell::bytes(&[0, 255, 16]),
            ValueKind::Bytes,
            false,
            Some("00ff10"),
        ),
        (Cell::bytes(&[]), ValueKind::Bytes, false, Some("")),
        (
            Cell::Ts(ts),
            ValueKind::Text,
            false,
            Some("2026-11-12 13:30:05.250"),
        ),
        (
            Cell::TsTz(tz),
            ValueKind::Text,
            true,
            Some("2026-11-12 13:30:05.250+02:00"),
        ),
        // without a zone in the target: the instant, as UTC
        (
            Cell::TsTz(tz),
            ValueKind::Text,
            false,
            Some("2026-11-12 11:30:05.250"),
        ),
        (
            Cell::Date(ts.date()),
            ValueKind::Text,
            false,
            Some("2026-11-12"),
        ),
        (
            Cell::Json("{\"a\": 1}".into()),
            ValueKind::Text,
            false,
            Some("{\"a\": 1}"),
        ),
    ] {
        assert_eq!(
            text_of(&cell, kind, zone).unwrap().as_deref(),
            want,
            "{cell:?}"
        );
    }
    assert!(text_of(&Cell::Unreadable("geometry".into()), ValueKind::Text, false).is_err());
}

fn lite() -> sqlite::Lite {
    sqlite::open(&sqlite::demo_profile()).unwrap()
}

fn lite_snapshot(s: &mut sqlite::Lite, prefix: &str) -> Snapshot {
    let snap = compare::snapshot(s, DbKind::Sqlite, "main", &|| false).unwrap();
    Snapshot {
        tables: snap
            .tables
            .into_iter()
            .filter(|t| t.name.starts_with(prefix))
            .collect(),
        views: Vec::new(),
        triggers: Vec::new(),
        routines: Vec::new(),
        ..snap
    }
}

fn lite_request(tables: &[&str]) -> Request {
    Request {
        source_schema: "main".into(),
        target_schema: "main".into(),
        ..request(tables)
    }
}

fn all(s: &mut sqlite::Lite, sql: &str) -> serde_json::Value {
    let r = s.query(sql, Limits::rows(100_000), &|| false).unwrap();
    serde_json::to_value(&r.rows).unwrap()
}

#[test]
fn copies_tables_between_two_databases_with_every_kind_of_value() {
    let mut a = lite();
    let mut b = lite();
    a.execute_batch_for_tests(
        "CREATE TABLE t_parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
         CREATE TABLE t_child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES t_parent (id),
           note TEXT, amount NUMERIC, ok BOOLEAN, raw BLOB, at DATETIME);
         CREATE INDEX t_child_note ON t_child (note);
         INSERT INTO t_parent VALUES (1, 'Größe 🚀'), (2, 'it''s; DROP TABLE t_parent; --');
         INSERT INTO t_child VALUES
           (1, 1, '', 1.5, 1, x'00ff10', '2026-11-12 13:30:05'),
           (2, 2, NULL, NULL, 0, x'', NULL),
           (3, 1, 'Zeile\nzwei\ttab', -0.25, NULL, NULL, '1999-12-31 23:59:59');",
    );
    let source = lite_snapshot(&mut a, "t_");
    let target = lite_snapshot(&mut b, "t_");
    let made = plan(
        DbKind::Sqlite,
        DbKind::Sqlite,
        &source,
        &target,
        &lite_request(&["t_child", "t_parent"]),
    )
    .unwrap();
    let events = std::sync::Mutex::new(Vec::new());
    let report = run(
        &mut a,
        &mut b,
        DbKind::Sqlite,
        &made,
        &|_| None,
        None,
        &|e| events.lock().unwrap().push(format!("{e:?}")),
        &|| false,
    );
    assert!(!report.cancelled);
    assert_eq!(
        report
            .tables
            .iter()
            .map(|t| (
                t.table.as_str(),
                t.loaded.read,
                t.loaded.written,
                t.loaded.failed
            ))
            .collect::<Vec<_>>(),
        [("t_parent", 2, 2, false), ("t_child", 3, 3, false)],
        "{report:#?}"
    );
    for sql in [
        "SELECT id, name FROM t_parent ORDER BY id",
        "SELECT id, parent, note, amount, ok, hex(raw), raw IS NULL, at FROM t_child ORDER BY id",
    ] {
        assert_eq!(all(&mut a, sql), all(&mut b, sql), "{sql}");
    }
    // an empty text is empty, an empty blob is empty – neither is NULL
    assert_eq!(
        all(
            &mut b,
            "SELECT note IS NULL, raw IS NULL, typeof(raw) FROM t_child WHERE id IN (1, 2) ORDER BY id"
        ),
        serde_json::json!([[0, 0, "blob"], [1, 0, "blob"]])
    );
    assert!(events.lock().unwrap().iter().any(|e| e.contains("t_child")));

    // again, appending: the keys collide – nothing of the table is written, the report says why
    let target = lite_snapshot(&mut b, "t_");
    let again = plan(
        DbKind::Sqlite,
        DbKind::Sqlite,
        &source,
        &target,
        &lite_request(&["t_parent"]),
    )
    .unwrap();
    assert!(again.tables[0].exists);
    let report = run(
        &mut a,
        &mut b,
        DbKind::Sqlite,
        &again,
        &|_| None,
        None,
        &|_| {},
        &|| false,
    );
    assert!(report.tables[0].loaded.failed);
    assert_eq!(
        all(&mut b, "SELECT count(*) FROM t_parent"),
        serde_json::json!([[2]])
    );
    // emptied first: the same rows again
    let mut clear = lite_request(&["t_child"]);
    clear.mode = Mode::Clear;
    let cleared = plan(DbKind::Sqlite, DbKind::Sqlite, &source, &target, &clear).unwrap();
    let report = run(
        &mut a,
        &mut b,
        DbKind::Sqlite,
        &cleared,
        &|_| None,
        None,
        &|_| {},
        &|| false,
    );
    assert_eq!(report.tables[0].loaded.written, 3, "{report:#?}");
    assert_eq!(
        all(&mut b, "SELECT count(*) FROM t_child"),
        serde_json::json!([[3]])
    );
}

#[test]
fn a_source_that_fails_leaves_nothing_half_in_one_transaction() {
    let mut a = lite();
    let mut b = lite();
    a.execute_batch_for_tests(
        "CREATE TABLE f_rows (id INTEGER PRIMARY KEY, n INTEGER);
         WITH RECURSIVE g(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM g WHERE i < 5000)
         INSERT INTO f_rows SELECT i, i FROM g;",
    );
    b.execute_batch_for_tests("CREATE TABLE f_rows (id INTEGER PRIMARY KEY, n INTEGER);");
    let source = lite_snapshot(&mut a, "f_");
    let target = lite_snapshot(&mut b, "f_");
    let mut req = lite_request(&["f_rows"]);
    req.whole_transaction = true;
    let mut made = plan(DbKind::Sqlite, DbKind::Sqlite, &source, &target, &req).unwrap();
    // the source fails in the middle: a row of it cannot be computed
    made.tables[0].select =
        "SELECT id, CASE WHEN id = 3000 THEN abs(-9223372036854775807 - 1) ELSE n END FROM f_rows"
            .into();
    let report = run(
        &mut a,
        &mut b,
        DbKind::Sqlite,
        &made,
        &|_| None,
        None,
        &|_| {},
        &|| false,
    );
    let t = &report.tables[0];
    assert!(t.loaded.failed, "{report:#?}");
    assert!(t.loaded.rolled_back);
    assert_eq!(
        all(&mut b, "SELECT count(*) FROM f_rows"),
        serde_json::json!([[0]])
    );
    // and both sessions are free for the next statement
    assert_eq!(
        all(&mut a, "SELECT count(*) FROM f_rows"),
        serde_json::json!([[5000]])
    );
}

#[test]
fn many_rows_stream_and_stopping_ends_both_sides() {
    let mut a = lite();
    let mut b = lite();
    a.execute_batch_for_tests(
        "CREATE TABLE m_rows (id INTEGER PRIMARY KEY, name TEXT, n REAL);
         WITH RECURSIVE g(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM g WHERE i < 60000)
         INSERT INTO m_rows SELECT i, 'row ' || i, i * 0.5 FROM g;",
    );
    let source = lite_snapshot(&mut a, "m_");
    let made = plan(
        DbKind::Sqlite,
        DbKind::Sqlite,
        &source,
        &empty(DbKind::Sqlite, "main"),
        &lite_request(&["m_rows"]),
    )
    .unwrap();
    let last = std::sync::atomic::AtomicU64::new(0);
    let report = run(
        &mut a,
        &mut b,
        DbKind::Sqlite,
        &made,
        &|_| None,
        None,
        &|e| {
            if let Event::Rows { read, .. } = e {
                last.store(read, std::sync::atomic::Ordering::Relaxed);
            }
        },
        &|| false,
    );
    assert_eq!(
        report.tables[0].loaded.written, 60_000,
        "{:#?}",
        report.tables[0]
    );
    assert_eq!(last.load(std::sync::atomic::Ordering::Relaxed), 60_000);
    assert_eq!(
        all(&mut b, "SELECT count(*), sum(n), max(name) FROM m_rows"),
        all(&mut a, "SELECT count(*), sum(n), max(name) FROM m_rows")
    );
    // stopped after some rows: both sides end, what was written in blocks stays, the report says so
    let mut c = lite();
    let seen = std::sync::atomic::AtomicU64::new(0);
    let report = run(
        &mut a,
        &mut c,
        DbKind::Sqlite,
        &made,
        &|_| None,
        None,
        &|e| {
            if let Event::Rows { read, .. } = e {
                seen.store(read, std::sync::atomic::Ordering::Relaxed);
            }
        },
        &|| seen.load(std::sync::atomic::Ordering::Relaxed) >= 10_000,
    );
    assert!(report.cancelled);
    let written = report.tables[0].loaded.written;
    assert!((10_000..60_000).contains(&written), "{written}");
    assert_eq!(
        all(&mut c, "SELECT count(*) FROM m_rows"),
        serde_json::json!([[written]])
    );
    // the source is usable again
    assert_eq!(all(&mut a, "SELECT 1"), serde_json::json!([[1]]));
}

// ── Review 045 ────────────────────────────────────────────────────────────────────

/// H1: only binary data is turned into bytes – a number or a text that happens to read as hex is not.
#[test]
fn a_value_that_only_looks_like_hex_is_not_decoded() {
    // what is no binary cell goes into a binary column as the bytes of its text
    assert_eq!(
        text_of(&Cell::I64(42), ValueKind::Bytes, false)
            .unwrap()
            .as_deref(),
        Some("3432")
    );
    assert_eq!(
        text_of(&Cell::Text("cafe".into()), ValueKind::Bytes, false)
            .unwrap()
            .as_deref(),
        Some("63616665")
    );
    assert_eq!(
        text_of(&Cell::bytes(&[0xca, 0xfe]), ValueKind::Bytes, false)
            .unwrap()
            .as_deref(),
        Some("cafe")
    );
    // a column of SQLite without a type holds anything: it is no binary column
    assert_eq!(class_of(DbKind::Sqlite, ""), Class::Other);
    let mut a = lite();
    let mut b = lite();
    a.execute_batch_for_tests(
        "CREATE TABLE h_kv (k INTEGER PRIMARY KEY, v);
         INSERT INTO h_kv VALUES (1, 42), (2, '2024'), (3, 'cafe'), (4, 'hello'), (5, NULL);",
    );
    let source = lite_snapshot(&mut a, "h_");
    let made = plan(
        DbKind::Sqlite,
        DbKind::Sqlite,
        &source,
        &empty(DbKind::Sqlite, "main"),
        &lite_request(&["h_kv"]),
    )
    .unwrap();
    let report = run(
        &mut a,
        &mut b,
        DbKind::Sqlite,
        &made,
        &|_| None,
        None,
        &|_| {},
        &|| false,
    );
    assert_eq!(report.tables[0].loaded.written, 5, "{report:#?}");
    assert_eq!(
        all(
            &mut b,
            "SELECT k, CAST(v AS TEXT), typeof(v) = 'blob' FROM h_kv ORDER BY k"
        ),
        serde_json::json!([
            [1, "42", 0],
            [2, "2024", 0],
            [3, "cafe", 0],
            [4, "hello", 0],
            [5, null, 0]
        ])
    );
}

/// H2: a reader that goes away without saying „done“ did not read the table to its end.
#[test]
fn a_source_that_vanishes_is_no_end_of_the_table() {
    let (tx, rx) = sync_channel::<Message>(4);
    let record = Record {
        line: 1,
        cells: vec![Some("1".into())],
        raw: String::new(),
    };
    tx.send(Message::Row(Ok(record))).unwrap();
    drop(tx);
    let mut queue = Queue {
        queue: rx,
        width: 1,
    };
    assert!(queue.next_record().unwrap().is_some());
    assert!(queue.next_record().is_err(), "the end was never said");
    // with the word, it is the end
    let (tx, rx) = sync_channel::<Message>(4);
    tx.send(Message::Done).unwrap();
    drop(tx);
    let mut queue = Queue {
        queue: rx,
        width: 1,
    };
    assert!(queue.next_record().unwrap().is_none());
}

/// M1, M2: what completed gets its indexes and keys also when a later table fails; a table that was
/// created and then failed is said to be there.
#[test]
fn completed_tables_get_their_indexes_when_a_later_one_fails() {
    let mut a = lite();
    let mut b = lite();
    a.execute_batch_for_tests(
        "CREATE TABLE i_one (id INTEGER PRIMARY KEY, name TEXT);
         CREATE TABLE i_two (id INTEGER PRIMARY KEY, n INTEGER);
         INSERT INTO i_one VALUES (1, 'a');
         INSERT INTO i_two VALUES (1, 1), (2, 2);",
    );
    let source = lite_snapshot(&mut a, "i_");
    let mut made = plan(
        DbKind::Sqlite,
        DbKind::Sqlite,
        &source,
        &empty(DbKind::Sqlite, "main"),
        &lite_request(&["i_one", "i_two"]),
    )
    .unwrap();
    // (SQLite gets no keys afterwards: an index stands in for what `after` holds elsewhere)
    made.tables[0].after = vec!["CREATE INDEX i_one_name ON i_one (name);".into()];
    made.tables[1].after = vec!["CREATE INDEX i_two_n ON i_two (n);".into()];
    made.tables[1].select =
        "SELECT id, CASE WHEN id = 2 THEN abs(-9223372036854775807 - 1) ELSE n END FROM i_two"
            .into();
    let report = run(
        &mut a,
        &mut b,
        DbKind::Sqlite,
        &made,
        &|_| None,
        None,
        &|_| {},
        &|| false,
    );
    assert!(!report.tables[0].loaded.failed);
    assert!(report.tables[1].loaded.failed);
    // the table that failed was created by this run, and is there (empty)
    assert!(report.tables[1].created);
    assert_eq!(
        all(
            &mut b,
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'i_%' ORDER BY name"
        ),
        serde_json::json!([["i_one_name"]])
    );
}

/// M5, M6, M7, M8: types that would fail in the target, or refuse values.
#[test]
fn types_that_would_fail_in_the_target_are_mapped_to_ones_that_work() {
    // a key cannot be a text without a limit in MySQL and SQL Server
    let mut source = shop();
    source.tables[0].columns[0] = col("id", "text", false);
    for (to, want) in [
        (DbKind::Mysql, "varchar(255)"),
        (DbKind::Sqlserver, "nvarchar(450)"),
    ] {
        let made = plan(
            DbKind::Postgres,
            to,
            &source,
            &empty(to, "copy"),
            &request(&["author"]),
        )
        .unwrap();
        let id = &made.tables[0].columns[0];
        assert_eq!(id.target_type.as_deref(), Some(want), "{to:?}");
        assert!(id.loss.is_some(), "{to:?}");
        assert!(
            made.tables[0].before[0].contains(&format!("id {want}")),
            "{:?}",
            made.tables[0].before
        );
    }
    // a row of MySQL takes 65 535 bytes: long texts are not part of it
    assert_eq!(
        map_type(DbKind::Postgres, DbKind::Mysql, "varchar(10000)").type_name,
        "longtext"
    );
    assert_eq!(
        map_type(DbKind::Postgres, DbKind::Mysql, "varchar(255)").type_name,
        "varchar(255)"
    );
    // SQLite: a name that says nothing is no number
    for name in ["STRING", "UUID", "TIME", "GUID"] {
        assert_eq!(class_of(DbKind::Sqlite, name), Class::Other, "{name}");
    }
    assert_eq!(class_of(DbKind::Sqlite, "NUMERIC"), Class::Numeric(None));
    // an unsigned small number does not fit a signed one
    assert_eq!(class_of(DbKind::Mysql, "smallint(5) unsigned"), Class::Int);
    assert_eq!(
        class_of(DbKind::Mysql, "tinyint(3) unsigned"),
        Class::SmallInt
    );
}
