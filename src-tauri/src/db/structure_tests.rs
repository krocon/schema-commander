use super::*;
use crate::db::compare::{Column, Index, Key, Named};
use crate::db::sqlite;

fn col(name: &str, type_name: &str, nullable: bool, default: Option<&str>) -> Column {
    Column {
        name: name.into(),
        type_name: type_name.into(),
        nullable,
        default: default.map(str::to_owned),
    }
}

fn orders() -> Table {
    Table {
        name: "orders".into(),
        columns: vec![
            col("id", "integer", false, None),
            col("customer_id", "integer", false, None),
            col("note", "varchar(40)", true, Some("'none'")),
        ],
        pk: vec!["id".into()],
        indexes: vec![Index {
            name: "orders_customer".into(),
            unique: false,
            columns: vec!["customer_id".into()],
            definition: None,
        }],
        keys: vec![Key {
            name: "orders_customer_fk".into(),
            columns: vec!["customer_id".into()],
            ref_schema: String::new(),
            ref_table: "customers".into(),
            ref_columns: vec!["id".into()],
        }],
        checks: vec![Named {
            name: "orders_note_len".into(),
            text: "length(note) > 0".into(),
        }],
        comment: None,
        definition: None,
    }
}

fn change(before: Option<Table>, after: Table, renames: &[(&str, &str)]) -> Request {
    Request::Change {
        schema: "shop".into(),
        before,
        after,
        renames: renames
            .iter()
            .map(|(from, to)| ColumnRename {
                from: (*from).into(),
                to: (*to).into(),
            })
            .collect(),
    }
}

fn sqls(plan: &Plan) -> Vec<String> {
    plan.statements()
}

#[test]
fn a_new_table_is_created_with_its_keys_indexes_and_checks() {
    let plan = plan(DbKind::Postgres, &change(None, orders(), &[])).unwrap();
    let all = sqls(&plan).join("\n");
    assert!(all.starts_with("CREATE TABLE shop.orders ("), "{all}");
    assert!(all.contains("note varchar(40) DEFAULT 'none'"), "{all}");
    assert!(
        all.contains("CREATE INDEX orders_customer ON shop.orders (customer_id);"),
        "{all}"
    );
    assert!(
        all.contains("FOREIGN KEY (customer_id) REFERENCES shop.customers (id)"),
        "{all}"
    );
    assert!(all.contains("CHECK (length(note) > 0)"), "{all}");
    assert!(plan.steps.iter().all(|s| s.danger.is_none()));
    assert!(plan.transactional);
    assert!(
        !super::plan(DbKind::Mysql, &change(None, orders(), &[]))
            .unwrap()
            .transactional
    );
}

#[test]
fn changes_become_alter_statements_and_what_loses_data_is_told_apart() {
    let before = orders();
    let mut after = orders();
    after.columns[2] = col("remark", "varchar(10)", false, Some("'it''s'"));
    after.columns.push(col("placed", "date", true, None));
    after.columns.remove(1);
    after.indexes.clear();
    after.keys.clear();
    after.checks[0].text = "length(remark) > 0".into();
    let plan = plan(
        DbKind::Postgres,
        &change(Some(before), after, &[("note", "remark")]),
    )
    .unwrap();
    let by = |needle: &str| {
        plan.steps
            .iter()
            .find(|s| s.sql.contains(needle))
            .unwrap_or_else(|| panic!("no step with {needle}: {:#?}", plan.steps))
    };
    assert!(by("RENAME COLUMN note TO remark").danger.is_none());
    assert!(by("ADD COLUMN placed date").danger.is_none());
    // dropping a column, narrowing a type and NOT NULL on rows that are there may lose data or fail
    assert!(by("DROP COLUMN customer_id").danger.is_some());
    assert!(by("TYPE varchar(10)").danger.is_some());
    // the default of that column was written in the same breath: it carries the same warning
    assert!(
        by("SET DEFAULT 'it''s'")
            .sql
            .ends_with("SET DEFAULT 'it''s';")
    );
    assert!(by("DROP INDEX").sql.contains("orders_customer"));
    // the rename comes first, the dropped column last
    let at = |needle: &str| {
        plan.steps
            .iter()
            .position(|s| s.sql.contains(needle))
            .unwrap()
    };
    assert!(at("RENAME COLUMN") < at("ADD COLUMN placed"));
    assert!(at("ADD COLUMN placed") < at("DROP COLUMN customer_id"));
    assert!(at("DROP CONSTRAINT orders_customer_fk") < at("DROP COLUMN customer_id"));
}

#[test]
fn a_table_is_renamed_with_its_columns() {
    let before = orders();
    let mut after = orders();
    after.name = "bestellungen".into();
    after.columns[2].name = "notiz".into();
    after.checks[0].text = "length(notiz) > 0".into();
    for (kind, table, column) in [
        (
            DbKind::Postgres,
            "ALTER TABLE shop.orders RENAME TO bestellungen;",
            "RENAME COLUMN note TO notiz",
        ),
        (
            DbKind::Mysql,
            "RENAME TABLE shop.orders TO shop.bestellungen;",
            "RENAME COLUMN note TO notiz",
        ),
        (
            DbKind::Sqlserver,
            "EXEC sp_rename '[shop].[orders]', 'bestellungen';",
            "EXEC sp_rename '[shop].[orders].[note]', 'notiz', 'COLUMN';",
        ),
    ] {
        let plan = plan(
            kind,
            &change(Some(before.clone()), after.clone(), &[("note", "notiz")]),
        )
        .unwrap();
        let all = sqls(&plan).join("\n");
        assert!(all.contains(table), "{kind:?}: {all}");
        assert!(all.contains(column), "{kind:?}: {all}");
        // the column is renamed while the table still has its old name
        assert!(
            all.find(column).unwrap() < all.find(table).unwrap(),
            "{all}"
        );
    }
}

#[test]
fn nothing_changed_is_nothing_to_do() {
    let plan = plan(DbKind::Postgres, &change(Some(orders()), orders(), &[])).unwrap();
    assert!(sqls(&plan).is_empty(), "{:#?}", plan.steps);
}

#[test]
fn names_are_quoted_and_hostile_ones_refused() {
    let mut table = orders();
    table.name = "My \"Orders\"".into();
    table.columns[0].name = "select".into();
    table.pk = vec!["select".into()];
    table.keys.clear();
    table.checks.clear();
    let plan = plan(DbKind::Postgres, &change(None, table.clone(), &[])).unwrap();
    let all = sqls(&plan).join("\n");
    assert!(
        all.contains("CREATE TABLE shop.\"My \"\"Orders\"\"\""),
        "{all}"
    );
    assert!(all.contains("\"select\" integer"), "{all}");
    let drop = super::plan(
        DbKind::Sqlserver,
        &Request::Drop {
            schema: "dbo".into(),
            table: "a]; DROP TABLE users; --".into(),
        },
    )
    .unwrap();
    assert_eq!(sqls(&drop), ["DROP TABLE dbo.[a]]; DROP TABLE users; --];"]);
    // a line break in a name would end a comment of the script
    table.name = "a\nDROP TABLE users".into();
    assert!(super::plan(DbKind::Postgres, &change(None, table, &[])).is_err());
}

#[test]
fn a_table_that_makes_no_sense_is_refused() {
    type Break = Box<dyn Fn(&mut Table)>;
    let broken: Vec<Break> = vec![
        Box::new(|t| t.name = " ".into()),
        Box::new(|t| t.columns.clear()),
        Box::new(|t| t.columns[0].name = String::new()),
        Box::new(|t| t.columns[0].type_name = String::new()),
        Box::new(|t| t.columns[1].name = "ID".into()),
        Box::new(|t| t.pk = vec!["gone".into()]),
        Box::new(|t| t.indexes[0].columns = vec!["gone".into()]),
        Box::new(|t| t.indexes[0].columns.clear()),
        Box::new(|t| t.keys[0].ref_columns.clear()),
        Box::new(|t| t.keys[0].ref_table = String::new()),
        Box::new(|t| t.keys[0].columns = vec!["gone".into()]),
        Box::new(|t| t.columns[0].default = Some("1;\nDROP TABLE users".into())),
        Box::new(|t| t.columns[0].type_name = "integer\rx".into()),
        Box::new(|t| t.checks[0].text = "a > 0;\nDROP TABLE users".into()),
    ];
    for (i, breaks) in broken.iter().enumerate() {
        let mut table = orders();
        breaks(&mut table);
        let failed = plan(DbKind::Postgres, &change(None, table, &[]));
        assert_eq!(failed.unwrap_err().code, ErrorCode::Unsupported, "case {i}");
    }
}

#[test]
fn drop_and_truncate_are_dangerous() {
    for kind in [
        DbKind::Postgres,
        DbKind::Mysql,
        DbKind::Sqlserver,
        DbKind::Sqlite,
    ] {
        let drop = plan(
            kind,
            &Request::Drop {
                schema: "s".into(),
                table: "t".into(),
            },
        )
        .unwrap();
        assert!(drop.steps[0].danger.is_some());
        assert!(drop.steps[0].sql.starts_with("DROP TABLE "));
        let truncate = plan(
            kind,
            &Request::Truncate {
                schema: "s".into(),
                table: "t".into(),
            },
        )
        .unwrap();
        assert!(truncate.steps[0].danger.is_some());
        let want = if kind == DbKind::Sqlite {
            "DELETE FROM t;"
        } else {
            "TRUNCATE TABLE s.t;"
        };
        assert_eq!(truncate.steps[0].sql, want);
    }
}

#[test]
fn a_copy_gets_names_of_its_own_and_the_rows_before_its_keys() {
    let plan = plan(
        DbKind::Postgres,
        &Request::Duplicate {
            schema: "shop".into(),
            table: orders(),
            name: "orders_copy".into(),
            data: true,
        },
    )
    .unwrap();
    let all = sqls(&plan);
    assert!(
        all[0].starts_with("CREATE TABLE shop.orders_copy ("),
        "{all:#?}"
    );
    assert_eq!(
        all[1],
        "INSERT INTO shop.orders_copy (id, customer_id, note) SELECT id, customer_id, note FROM shop.orders;"
    );
    let rest = all[2..].join("\n");
    assert!(
        rest.contains("CREATE INDEX orders_copy_orders_customer ON shop.orders_copy"),
        "{rest}"
    );
    assert!(
        rest.contains("CONSTRAINT orders_copy_orders_customer_fk"),
        "{rest}"
    );
    assert!(!all.join("\n").contains("ON shop.orders "), "{all:#?}");
    for bad in ["", " ", "orders"] {
        let failed = super::plan(
            DbKind::Postgres,
            &Request::Duplicate {
                schema: "shop".into(),
                table: orders(),
                name: bad.into(),
                data: false,
            },
        );
        assert!(failed.is_err(), "{bad:?}");
    }
}

fn lite() -> sqlite::Lite {
    sqlite::open(&sqlite::demo_profile()).unwrap()
}

fn read(s: &mut sqlite::Lite, table: &str) -> Table {
    load(s, DbKind::Sqlite, "main", table, &|| false).unwrap()
}

fn apply(s: &mut sqlite::Lite, request: &Request) -> Ran {
    let plan = plan(DbKind::Sqlite, request).unwrap();
    run(
        s,
        DbKind::Sqlite,
        &plan.statements(),
        plan.transactional,
        None,
        &|| false,
    )
    .unwrap()
}

/// The acceptance of prompt 043 for SQLite: change the structure, run the DDL, read again – it is what
/// was edited.
#[test]
fn a_round_trip_in_sqlite() {
    let mut s = lite();
    let new = Table {
        name: "e_books".into(),
        columns: vec![
            col("id", "INTEGER", false, None),
            col("title", "TEXT", false, Some("'it''s untitled'")),
            col("pages", "INTEGER", true, None),
        ],
        pk: vec!["id".into()],
        ..Table::default()
    };
    let request = Request::Change {
        schema: "main".into(),
        before: None,
        after: new.clone(),
        renames: vec![],
    };
    let ran = apply(&mut s, &request);
    assert_eq!(
        (ran.failed, ran.rolled_back),
        (None, false),
        "{:?}",
        ran.error
    );
    let loaded = read(&mut s, "e_books");
    assert_eq!(loaded.columns, new.columns);
    assert_eq!(loaded.pk, new.pk);
    // the default arrives with its quote
    s.execute_batch_for_tests("INSERT INTO e_books (id) VALUES (1);");
    let r = s
        .query("SELECT title FROM e_books", Limits::rows(5), &|| false)
        .unwrap();
    assert_eq!(
        serde_json::to_value(&r.rows).unwrap(),
        serde_json::json!([["it's untitled"]])
    );

    // edit: a column more, one renamed, an index, and the table renamed
    let mut edited = loaded.clone();
    edited.name = "e_library".into();
    edited.columns[2].name = "page_count".into();
    edited.columns.push(col("isbn", "TEXT", true, None));
    edited.indexes.push(Index {
        name: "e_library_isbn".into(),
        unique: true,
        columns: vec!["isbn".into()],
        definition: None,
    });
    let request = Request::Change {
        schema: "main".into(),
        before: Some(loaded),
        after: edited.clone(),
        renames: vec![ColumnRename {
            from: "pages".into(),
            to: "page_count".into(),
        }],
    };
    let ran = apply(&mut s, &request);
    assert_eq!(ran.failed, None, "{:?}", ran.error);
    let again = read(&mut s, "e_library");
    assert_eq!(again.columns, edited.columns);
    assert_eq!(
        again
            .indexes
            .iter()
            .map(|i| (i.name.clone(), i.unique, i.columns.clone()))
            .collect::<Vec<_>>(),
        vec![("e_library_isbn".to_owned(), true, vec!["isbn".to_owned()])]
    );
    // the row is still there
    let r = s
        .query("SELECT count(*) FROM e_library", Limits::rows(5), &|| false)
        .unwrap();
    assert_eq!(
        serde_json::to_value(&r.rows).unwrap(),
        serde_json::json!([[1]])
    );
}

#[test]
fn a_failure_rolls_everything_back() {
    let mut s = lite();
    s.execute_batch_for_tests("CREATE TABLE e_keep (id INTEGER PRIMARY KEY, name TEXT);");
    let statements = vec![
        "ALTER TABLE e_keep ADD COLUMN extra TEXT;".to_owned(),
        "ALTER TABLE e_missing ADD COLUMN x TEXT;".to_owned(),
        "ALTER TABLE e_keep ADD COLUMN never TEXT;".to_owned(),
    ];
    let ran = run(&mut s, DbKind::Sqlite, &statements, true, None, &|| false).unwrap();
    assert_eq!(ran.failed, Some(1));
    assert!(ran.rolled_back);
    assert_eq!(ran.done, 0);
    assert!(ran.error.is_some());
    // nothing of the first statement stays
    assert_eq!(read(&mut s, "e_keep").columns.len(), 2);
    // and the session is free for the next run
    let ran = run(
        &mut s,
        DbKind::Sqlite,
        &statements[..1],
        true,
        None,
        &|| false,
    )
    .unwrap();
    assert_eq!((ran.done, ran.failed), (1, None));
    assert_eq!(read(&mut s, "e_keep").columns.len(), 3);
}

#[test]
fn drop_truncate_and_duplicate_run_in_sqlite() {
    let mut s = lite();
    s.execute_batch_for_tests(
        "CREATE TABLE e_src (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
         CREATE INDEX e_src_name ON e_src (name);
         INSERT INTO e_src VALUES (1, 'a'), (2, 'b');",
    );
    let table = read(&mut s, "e_src");
    let ran = apply(
        &mut s,
        &Request::Duplicate {
            schema: "main".into(),
            table,
            name: "e_copy".into(),
            data: true,
        },
    );
    assert_eq!(ran.failed, None, "{:?}", ran.error);
    let count = |s: &mut sqlite::Lite, t: &str| {
        let r = s
            .query(
                &format!("SELECT count(*) FROM {t}"),
                Limits::rows(5),
                &|| false,
            )
            .unwrap();
        serde_json::to_value(&r.rows).unwrap()
    };
    assert_eq!(count(&mut s, "e_copy"), serde_json::json!([[2]]));
    assert_eq!(read(&mut s, "e_copy").indexes[0].name, "e_copy_e_src_name");
    apply(
        &mut s,
        &Request::Truncate {
            schema: "main".into(),
            table: "e_copy".into(),
        },
    );
    assert_eq!(count(&mut s, "e_copy"), serde_json::json!([[0]]));
    assert_eq!(count(&mut s, "e_src"), serde_json::json!([[2]]));
    apply(
        &mut s,
        &Request::Drop {
            schema: "main".into(),
            table: "e_copy".into(),
        },
    );
    assert!(load(&mut s, DbKind::Sqlite, "main", "e_copy", &|| false).is_err());
}

#[test]
fn every_step_is_one_statement() {
    let before = orders();
    let mut after = orders();
    after.columns[2] = col("note", "varchar(10)", false, Some("'a;b'"));
    for kind in [DbKind::Postgres, DbKind::Mysql, DbKind::Sqlserver] {
        let plan = plan(kind, &change(Some(before.clone()), after.clone(), &[])).unwrap();
        for step in &plan.steps {
            assert_eq!(
                step.sql.matches(";\n").count(),
                0,
                "{kind:?}: {:?}",
                step.sql
            );
        }
        // the reason of a danger goes with every statement it was said for
        assert!(plan.steps.iter().any(|s| s.danger.is_some()), "{kind:?}");
    }
    let pg = plan(DbKind::Postgres, &change(Some(before), after, &[])).unwrap();
    assert_eq!(pg.steps.len(), 3, "{:#?}", pg.steps);
}

#[test]
fn reads_the_columns_of_an_index_from_its_statement() {
    for (definition, want) in [
        ("CREATE INDEX i ON s.t USING btree (a)", vec!["a"]),
        (
            "CREATE UNIQUE INDEX i ON s.t USING btree (a, \"b c\", d_1)",
            vec!["a", "b c", "d_1"],
        ),
        (
            "CREATE INDEX i ON t (\"say \"\"hi\"\"\", \"a,b\")",
            vec!["say \"hi\"", "a,b"],
        ),
        ("CREATE INDEX i ON t (\"x)y\");", vec!["x)y"]),
        // more than a list of columns: left to its statement
        ("CREATE INDEX i ON s.t USING btree (lower(name))", vec![]),
        ("CREATE INDEX i ON s.t USING btree (a DESC)", vec![]),
        (
            "CREATE INDEX i ON s.t USING btree (a) WHERE (b > 0)",
            vec![],
        ),
        ("CREATE INDEX i ON s.t USING btree (a) INCLUDE (b)", vec![]),
        (
            "CREATE INDEX i ON s.t USING gin (doc jsonb_path_ops)",
            vec![],
        ),
        ("CREATE INDEX broken ON t (a", vec![]),
        ("", vec![]),
    ] {
        assert_eq!(index_columns(definition), want, "{definition}");
    }
}

// ── Review 043 ────────────────────────────────────────────────────────────────────

fn tree() -> Table {
    Table {
        name: "emp".into(),
        columns: vec![
            col("id", "integer", false, None),
            col("boss", "integer", true, None),
        ],
        pk: vec!["id".into()],
        keys: vec![Key {
            name: "emp_boss".into(),
            columns: vec!["boss".into()],
            ref_schema: String::new(),
            ref_table: "emp".into(),
            ref_columns: vec!["id".into()],
        }],
        ..Table::default()
    }
}

/// H1: a key of a table to itself is the same key when the table or the column it points to is renamed.
#[test]
fn a_key_to_the_table_itself_follows_its_renames() {
    let before = tree();
    let mut after = tree();
    after.name = "staff".into();
    after.columns[0].name = "nr".into();
    after.pk = vec!["nr".into()];
    // the window sends the key as it was read
    for kind in [DbKind::Postgres, DbKind::Mysql, DbKind::Sqlserver] {
        let plan = plan(
            kind,
            &change(Some(before.clone()), after.clone(), &[("id", "nr")]),
        )
        .unwrap();
        let all = sqls(&plan);
        assert_eq!(all.len(), 2, "{kind:?}: only the two renames: {all:#?}");
        assert!(
            !all.join("\n").contains("FOREIGN KEY"),
            "{kind:?}: {all:#?}"
        );
    }
}

/// H2: a type without its size is not „wider“: `decimal` is `decimal(18,0)` on SQL Server.
#[test]
fn dropping_the_size_of_a_type_is_dangerous() {
    for (from, to) in [
        ("decimal(12,4)", "decimal"),
        ("varchar(40)", "varchar"),
        ("char(10)", "char"),
    ] {
        let mut before = orders();
        before.columns[2] = col("note", from, true, None);
        let mut after = before.clone();
        after.columns[2].type_name = to.into();
        let plan = plan(DbKind::Sqlserver, &change(Some(before), after, &[])).unwrap();
        assert!(
            plan.steps.iter().any(|s| s.danger.is_some()),
            "{from} → {to}: {:#?}",
            plan.steps
        );
    }
}

/// M3, M7: a plan that says „do this by hand“ for a part of the edit does not run the rest.
#[test]
fn a_plan_with_a_part_that_is_not_written_is_incomplete() {
    let before = orders();
    let mut after = orders();
    after.pk = vec!["id".into(), "customer_id".into()];
    let plan = plan(DbKind::Postgres, &change(Some(before), after, &[])).unwrap();
    assert!(plan.incomplete, "{:#?}", plan.steps);
    let whole = super::plan(DbKind::Postgres, &change(None, orders(), &[])).unwrap();
    assert!(!whole.incomplete);
}

/// M4: MySQL and SQL Server refuse to rename a column a check uses.
#[test]
fn a_renamed_column_that_a_check_uses_is_said_before_it_fails() {
    let before = orders();
    let mut after = orders();
    after.columns[2].name = "remark".into();
    after.checks[0].text = "length(remark) > 0".into();
    for (kind, complete) in [
        (DbKind::Mysql, false),
        (DbKind::Sqlserver, false),
        (DbKind::Postgres, true),
    ] {
        let plan = plan(
            kind,
            &change(Some(before.clone()), after.clone(), &[("note", "remark")]),
        )
        .unwrap();
        assert_eq!(!plan.incomplete, complete, "{kind:?}: {:#?}", plan.steps);
    }
}

/// M5: SQLite cannot add a foreign key afterwards: a new table has its keys in its statement.
#[test]
fn a_new_table_with_a_key_is_created_in_sqlite() {
    let mut s = lite();
    s.execute_batch_for_tests("CREATE TABLE e_parent (id INTEGER PRIMARY KEY);");
    let child = Table {
        name: "e_child".into(),
        columns: vec![
            col("id", "INTEGER", false, None),
            col("parent", "INTEGER", true, None),
        ],
        pk: vec!["id".into()],
        keys: vec![Key {
            name: String::new(),
            columns: vec!["parent".into()],
            ref_schema: String::new(),
            ref_table: "e_parent".into(),
            ref_columns: vec!["id".into()],
        }],
        ..Table::default()
    };
    let request = Request::Change {
        schema: "main".into(),
        before: None,
        after: child,
        renames: vec![],
    };
    let made = plan(DbKind::Sqlite, &request).unwrap();
    let all = made.statements().join("\n");
    assert!(
        all.contains("FOREIGN KEY (parent) REFERENCES e_parent (id)"),
        "{all}"
    );
    assert!(!all.contains("ALTER TABLE"), "{all}");
    let ran = apply(&mut s, &request);
    assert_eq!(ran.failed, None, "{:?}", ran.error);
    assert_eq!(read(&mut s, "e_child").keys.len(), 1);
}

/// M6: the names in `sp_rename` are quoted part by part.
#[test]
fn sp_rename_quotes_its_names() {
    let mut before = orders();
    before.name = "order.items".into();
    before.columns[2].name = "x.y".into();
    before.checks.clear();
    let mut after = before.clone();
    after.name = "items".into();
    after.columns[2].name = "it's".into();
    let plan = plan(
        DbKind::Sqlserver,
        &change(Some(before), after, &[("x.y", "it's")]),
    )
    .unwrap();
    let all = sqls(&plan);
    assert_eq!(
        all,
        [
            "EXEC sp_rename '[shop].[order.items].[x.y]', 'it''s', 'COLUMN';",
            "EXEC sp_rename '[shop].[order.items]', 'items';",
        ]
    );
}

/// M8: renames that step on each other are refused – they would collapse.
#[test]
fn renames_that_cross_are_refused() {
    let before = orders();
    for renames in [
        vec![("id", "note"), ("note", "id")],
        vec![("id", "customer_id"), ("customer_id", "other")],
        // a column is deleted and another one takes its name
        vec![("id", "note")],
    ] {
        let mut after = orders();
        for (from, to) in &renames {
            for c in &mut after.columns {
                if c.name == *from {
                    c.name = format!("\u{1}{to}");
                }
            }
        }
        for c in &mut after.columns {
            c.name = c.name.trim_start_matches('\u{1}').to_owned();
        }
        if renames.len() == 1 {
            after.columns.remove(2);
            after.checks.clear();
        }
        after.pk = vec![after.columns[0].name.clone()];
        after.indexes.clear();
        after.keys.clear();
        let failed = plan(
            DbKind::Postgres,
            &change(Some(before.clone()), after, &renames),
        );
        assert_eq!(
            failed.map(|p| p.statements()).unwrap_err().code,
            ErrorCode::Unsupported,
            "{renames:?}"
        );
    }
}

/// M9: the statement of a table or an index is the database's, never the window's.
#[test]
fn a_definition_from_the_window_is_not_written() {
    let mut new = orders();
    new.definition = Some("DROP TABLE users".into());
    new.indexes[0].definition = Some("DROP TABLE users".into());
    let plan = plan(DbKind::Sqlite, &change(None, new, &[])).unwrap();
    let all = sqls(&plan).join("\n");
    assert!(!all.contains("DROP TABLE"), "{all}");
    assert!(all.contains("CREATE TABLE orders"), "{all}");
    // an index as it was read keeps its statement
    let mut before = orders();
    before.indexes[0].definition =
        Some("CREATE INDEX orders_customer ON shop.orders USING btree (customer_id)".into());
    let mut after = before.clone();
    after.columns.push(col("extra", "integer", true, None));
    let same = super::plan(DbKind::Postgres, &change(Some(before), after, &[])).unwrap();
    assert_eq!(sqls(&same).len(), 1, "{:#?}", same.steps);
}

/// M10: a type may say more than letters between its quotes.
#[test]
fn an_enum_with_any_text_is_a_type() {
    let mut table = orders();
    table.columns[2] = col("state", "enum('in-progress','done/ok','a:b')", false, None);
    table.checks.clear();
    let plan = plan(DbKind::Mysql, &change(None, table, &[])).unwrap();
    assert!(sqls(&plan)[0].contains("enum('in-progress','done/ok','a:b')"));
    // but nothing that ends the statement
    let mut bad = orders();
    bad.columns[2] = col("state", "int); DROP TABLE users; --", false, None);
    assert!(super::plan(DbKind::Mysql, &change(None, bad, &[])).is_err());
}

/// M11: an index, key or check that only got another name is not silently left as it was.
#[test]
fn a_part_that_only_got_another_name_is_said() {
    let before = orders();
    let mut after = orders();
    after.indexes[0].name = "ix_new_name".into();
    let plan = plan(DbKind::Mysql, &change(Some(before), after, &[])).unwrap();
    assert!(
        plan.incomplete || !sqls(&plan).is_empty(),
        "an edit must not vanish: {:#?}",
        plan.steps
    );
}
