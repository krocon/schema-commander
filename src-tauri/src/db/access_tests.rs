use super::*;

fn cx() -> Context {
    Context {
        flavor: Flavor::Plain,
        mine: vec!["me".to_owned(), "team".to_owned()],
        backslash_escapes: true,
        powerful: vec!["boss".to_owned()],
    }
}

fn grant(who: &str, level: &str, schema: &str, object: &str, privilege: &str, add: bool) -> Change {
    Change::Grant {
        who: Who::new(who, ""),
        level: level.to_owned(),
        schema: schema.to_owned(),
        object: object.to_owned(),
        column: String::new(),
        privilege: privilege.to_owned(),
        grantable: false,
        add,
    }
}

fn sqls(kind: DbKind, changes: &[Change]) -> Vec<String> {
    plan(kind, changes, &cx())
        .unwrap()
        .into_iter()
        .map(|s| s.sql)
        .collect()
}

#[test]
fn writes_grants_and_revokes_of_every_database() {
    let table = [
        grant("ann", "table", "shop", "orders", "SELECT", true),
        grant("ann", "table", "shop", "orders", "INSERT", false),
    ];
    assert_eq!(
        sqls(DbKind::Postgres, &table),
        [
            r#"GRANT SELECT ON TABLE "shop"."orders" TO "ann""#,
            r#"REVOKE INSERT ON TABLE "shop"."orders" FROM "ann""#,
        ]
    );
    assert_eq!(
        sqls(DbKind::Sqlserver, &table),
        [
            "GRANT SELECT ON OBJECT::[shop].[orders] TO [ann]",
            "REVOKE INSERT ON OBJECT::[shop].[orders] FROM [ann]",
        ]
    );
    let my = [
        Change::Grant {
            who: Who::new("ann", "%"),
            level: "table".into(),
            schema: "shop".into(),
            object: "orders".into(),
            column: String::new(),
            privilege: "ALL".into(),
            grantable: true,
            add: true,
        },
        Change::Grant {
            who: Who::new("ann", "%"),
            level: "schema".into(),
            schema: String::new(),
            object: "shop".into(),
            column: String::new(),
            privilege: "SELECT".into(),
            grantable: false,
            add: true,
        },
        Change::Grant {
            who: Who::new("ann", "%"),
            level: "server".into(),
            schema: String::new(),
            object: String::new(),
            column: String::new(),
            privilege: "PROCESS".into(),
            grantable: false,
            add: false,
        },
    ];
    assert_eq!(
        sqls(DbKind::Mysql, &my),
        [
            "GRANT ALL PRIVILEGES ON `shop`.`orders` TO 'ann'@'%' WITH GRANT OPTION",
            "GRANT SELECT ON `shop`.* TO 'ann'@'%'",
            "REVOKE PROCESS ON *.* FROM 'ann'@'%'",
        ]
    );
}

#[test]
fn writes_columns_where_each_database_wants_them() {
    let column = |kind| {
        sqls(
            kind,
            &[Change::Grant {
                who: Who::new("ann", if kind == DbKind::Mysql { "%" } else { "" }),
                level: "column".into(),
                schema: "shop".into(),
                object: "orders".into(),
                column: "total".into(),
                privilege: "UPDATE".into(),
                grantable: false,
                add: true,
            }],
        )
        .remove(0)
    };
    assert_eq!(
        column(DbKind::Postgres),
        r#"GRANT UPDATE ("total") ON TABLE "shop"."orders" TO "ann""#
    );
    assert_eq!(
        column(DbKind::Mysql),
        "GRANT UPDATE (`total`) ON `shop`.`orders` TO 'ann'@'%'"
    );
    assert_eq!(
        column(DbKind::Sqlserver),
        "GRANT UPDATE ON OBJECT::[shop].[orders] ([total]) TO [ann]"
    );
}

#[test]
fn database_and_schema_levels() {
    assert_eq!(
        sqls(
            DbKind::Postgres,
            &[
                grant("ann", "database", "", "shop", "CONNECT", true),
                grant("ann", "schema", "", "public", "USAGE", true),
                grant("ann", "sequence", "public", "orders_id_seq", "USAGE", true),
            ]
        ),
        [
            r#"GRANT CONNECT ON DATABASE "shop" TO "ann""#,
            r#"GRANT USAGE ON SCHEMA "public" TO "ann""#,
            r#"GRANT USAGE ON SEQUENCE "public"."orders_id_seq" TO "ann""#,
        ]
    );
    assert_eq!(
        sqls(
            DbKind::Sqlserver,
            &[
                grant("ann", "database", "", "", "CONNECT", true),
                grant("ann", "schema", "", "dbo", "SELECT", false),
            ]
        ),
        [
            "GRANT CONNECT TO [ann]",
            "REVOKE SELECT ON SCHEMA::[dbo] FROM [ann]",
        ]
    );
}

/// Names that try to leave their quotes stay names.
#[test]
fn evil_names_stay_names() {
    let evil = r#"x"; DROP ROLE admin; --"#;
    assert_eq!(
        sqls(
            DbKind::Postgres,
            &[grant(evil, "table", "s\"x", "t", "SELECT", true)]
        ),
        [r#"GRANT SELECT ON TABLE "s""x"."t" TO "x""; DROP ROLE admin; --""#]
    );
    assert_eq!(
        sqls(
            DbKind::Sqlserver,
            &[grant(
                "a]; DROP USER b; --",
                "table",
                "dbo",
                "t]",
                "SELECT",
                true
            )]
        ),
        ["GRANT SELECT ON OBJECT::[dbo].[t]]] TO [a]]; DROP USER b; --]"]
    );
    let my = Change::Member {
        role: Who::new("r'; DROP USER root; --", "%"),
        member: Who::new("back\\", "h'ost"),
        add: true,
    };
    assert_eq!(
        sqls(DbKind::Mysql, std::slice::from_ref(&my)),
        [r"GRANT 'r''; DROP USER root; --'@'%' TO 'back\\'@'h''ost'"]
    );
    // with NO_BACKSLASH_ESCAPES a backslash is a character: doubling it would change the name
    let strict = Context {
        backslash_escapes: false,
        ..cx()
    };
    assert_eq!(
        plan(DbKind::Mysql, &[my], &strict).unwrap()[0].sql,
        r"GRANT 'r''; DROP USER root; --'@'%' TO 'back\'@'h''ost'"
    );
}

#[test]
fn refuses_what_is_no_name_and_no_privilege() {
    for change in [
        grant("", "table", "s", "t", "SELECT", true),
        grant("a\nb", "table", "s", "t", "SELECT", true),
        grant("ann", "table", "s", "t", "SELECT; DROP TABLE t", true),
        grant("ann", "table", "s", "t", "select", true),
        grant("ann", "routine", "s", "f()", "EXECUTE", true),
        grant("ann", "table", "", "t", "SELECT", true),
        grant("ann", "nowhere", "s", "t", "SELECT", true),
        Change::Attribute {
            who: Who::new("ann", ""),
            attribute: "superuser; DROP ROLE x".into(),
            on: true,
        },
        Change::Create {
            who: Who::new("r", ""),
            login: false,
            password: true,
        },
    ] {
        assert!(
            plan(DbKind::Postgres, std::slice::from_ref(&change), &cx()).is_err(),
            "{change:?}"
        );
    }
    assert!(
        plan(
            DbKind::Mysql,
            &[Change::Attribute {
                who: Who::new("ann", "%"),
                attribute: "superuser".into(),
                on: true
            }],
            &cx()
        )
        .is_err()
    );
    assert!(
        plan(
            DbKind::Sqlite,
            &[grant("a", "table", "s", "t", "SELECT", true)],
            &cx()
        )
        .is_err()
    );
}

#[test]
fn creates_drops_and_memberships() {
    let who = Who::new("ann", "");
    let create = |login, password| Change::Create {
        who: who.clone(),
        login,
        password,
    };
    assert_eq!(
        sqls(
            DbKind::Postgres,
            &[create(true, true), create(false, false)]
        ),
        [
            r#"CREATE ROLE "ann" LOGIN PASSWORD '***'"#,
            r#"CREATE ROLE "ann""#
        ]
    );
    assert_eq!(
        sqls(
            DbKind::Sqlserver,
            &[
                create(true, true),
                create(true, false),
                create(false, false)
            ]
        ),
        [
            "CREATE LOGIN [ann] WITH PASSWORD = '***'",
            "CREATE USER [ann] FOR LOGIN [ann]",
            "CREATE USER [ann] FOR LOGIN [ann]",
            "CREATE ROLE [ann]",
        ]
    );
    let host = Who::new("ann", "10.%");
    assert_eq!(
        sqls(
            DbKind::Mysql,
            &[
                Change::Create {
                    who: host.clone(),
                    login: true,
                    password: true
                },
                Change::Create {
                    who: Who::new("readers", ""),
                    login: false,
                    password: false
                },
                Change::Password { who: host.clone() },
                Change::Drop {
                    who: host.clone(),
                    role: false
                },
            ]
        ),
        [
            "CREATE USER 'ann'@'10.%' IDENTIFIED BY '***'",
            "CREATE ROLE 'readers'",
            "ALTER USER 'ann'@'10.%' IDENTIFIED BY '***'",
            "DROP USER 'ann'@'10.%'",
        ]
    );
    let member = |add| Change::Member {
        role: Who::new("team", ""),
        member: who.clone(),
        add,
    };
    assert_eq!(
        sqls(DbKind::Postgres, &[member(true), member(false)]),
        [r#"GRANT "team" TO "ann""#, r#"REVOKE "team" FROM "ann""#]
    );
    assert_eq!(
        sqls(DbKind::Sqlserver, &[member(true), member(false)]),
        [
            "ALTER ROLE [team] ADD MEMBER [ann]",
            "ALTER ROLE [team] DROP MEMBER [ann]"
        ]
    );
    assert_eq!(
        sqls(
            DbKind::Postgres,
            &[
                Change::Attribute {
                    who: who.clone(),
                    attribute: "createdb".into(),
                    on: true
                },
                Change::Attribute {
                    who: who.clone(),
                    attribute: "login".into(),
                    on: false
                }
            ]
        ),
        [
            r#"ALTER ROLE "ann" CREATEDB"#,
            r#"ALTER ROLE "ann" NOLOGIN"#
        ]
    );
}

#[test]
fn says_what_is_dangerous() {
    let dangers = |change: Change| -> Vec<String> {
        plan(DbKind::Postgres, &[change], &cx())
            .unwrap()
            .remove(0)
            .dangers
    };
    let me = Who::new("me", "");
    let other = Who::new("ann", "");
    assert!(dangers(grant("ann", "table", "s", "t", "SELECT", true)).is_empty());
    assert_eq!(
        dangers(grant("ann", "table", "s", "t", "ALL", true)),
        ["all"]
    );
    assert_eq!(
        dangers(Change::Grant {
            who: other.clone(),
            level: "table".into(),
            schema: "s".into(),
            object: "t".into(),
            column: String::new(),
            privilege: "SELECT".into(),
            grantable: true,
            add: true
        }),
        ["grantOption"]
    );
    assert_eq!(
        dangers(Change::Attribute {
            who: other.clone(),
            attribute: "superuser".into(),
            on: true
        }),
        ["superuser"]
    );
    // taking from the user of the connection, or from a role it is in, may lock it out
    assert_eq!(
        dangers(grant("me", "table", "s", "t", "SELECT", false)),
        ["lockout"]
    );
    assert_eq!(
        dangers(grant("team", "schema", "", "s", "USAGE", false)),
        ["lockout"]
    );
    assert!(dangers(grant("ann", "table", "s", "t", "SELECT", false)).is_empty());
    assert_eq!(
        dangers(Change::Member {
            role: Who::new("team", ""),
            member: me.clone(),
            add: false
        }),
        ["lockout"]
    );
    assert_eq!(
        dangers(Change::Attribute {
            who: me.clone(),
            attribute: "login".into(),
            on: false
        }),
        ["lockout"]
    );
    assert_eq!(
        dangers(Change::Drop {
            who: me,
            role: false
        }),
        ["drop", "lockout"]
    );
    assert_eq!(
        dangers(Change::Drop {
            who: other,
            role: true
        }),
        ["drop"]
    );
}

fn salt() -> AppResult<[u8; 16]> {
    Ok(*b"0123456789abcdef")
}

/// The acceptance criterion: a password is in no statement that is shown – and in the one that runs
/// only in the form the database needs.
#[test]
fn a_password_is_never_in_what_is_shown() {
    let password = "s3cret'; DROP ROLE x; --";
    let changes = [
        Change::Create {
            who: Who::new("ann", "%"),
            login: true,
            password: true,
        },
        grant("ann", "table", "s", "t", "SELECT", true),
        Change::Password {
            who: Who::new("ann", "%"),
        },
    ];
    let passwords = [
        Some(Secret::new(password)),
        None,
        Some(Secret::new(password)),
    ];
    for kind in [DbKind::Postgres, DbKind::Mysql, DbKind::Sqlserver] {
        let steps = plan(kind, &changes, &cx()).unwrap();
        let shown = serde_json::to_string(&steps).unwrap();
        assert!(!shown.contains("s3cret"), "{kind:?}: {shown}");
        assert!(shown.contains("***"));
        assert!(steps.iter().any(|s| s.secret));
        let real = statements(kind, &changes, &passwords, &cx(), &salt).unwrap();
        // what runs has as many statements as what is shown, in the same order
        assert_eq!(real.len(), steps.len());
        for (run, step) in real.iter().zip(&steps) {
            assert_eq!(run != &step.sql, step.secret, "{kind:?}: {}", step.sql);
        }
        match kind {
            // PostgreSQL never gets the password at all
            DbKind::Postgres => {
                assert!(real.iter().all(|s| !s.contains("s3cret")));
                assert!(real[0].contains("PASSWORD 'SCRAM-SHA-256$4096:"));
            }
            DbKind::Mysql => {
                assert!(real[0].ends_with("IDENTIFIED BY 's3cret''; DROP ROLE x; --'"))
            }
            _ => assert!(real[0].ends_with("PASSWORD = N's3cret''; DROP ROLE x; --'")),
        }
    }
    // a password that is missing, empty or no text is refused before anything runs
    for bad in [None, Some(Secret::new("")), Some(Secret::new("a\0b"))] {
        let passwords = [bad, None, Some(Secret::new("x"))];
        assert!(statements(DbKind::Mysql, &changes, &passwords, &cx(), &salt).is_err());
    }
}

#[test]
fn mysql_passwords_follow_the_sql_mode() {
    let change = [Change::Password {
        who: Who::new("ann", "%"),
    }];
    let pw = [Some(Secret::new(r"a\b'c"))];
    let with = statements(DbKind::Mysql, &change, &pw, &cx(), &salt).unwrap();
    assert!(with[0].ends_with(r"IDENTIFIED BY 'a\\b''c'"));
    let strict = Context {
        backslash_escapes: false,
        ..cx()
    };
    let without = statements(DbKind::Mysql, &change, &pw, &strict, &salt).unwrap();
    assert!(without[0].ends_with(r"IDENTIFIED BY 'a\b''c'"));
}

#[test]
fn postgres_sends_a_password_that_is_not_ascii_as_text_and_cockroach_always() {
    let change = [Change::Password {
        who: Who::new("ann", ""),
    }];
    let pw = [Some(Secret::new("pässwort'"))];
    let real = statements(DbKind::Postgres, &change, &pw, &cx(), &salt).unwrap();
    assert_eq!(real[0], r#"ALTER ROLE "ann" PASSWORD 'pässwort'''"#);
    let roach = Context {
        flavor: Flavor::Cockroach,
        ..cx()
    };
    let pw = [Some(Secret::new("plain"))];
    let real = statements(DbKind::Postgres, &change, &pw, &roach, &salt).unwrap();
    assert_eq!(real[0], r#"ALTER ROLE "ann" PASSWORD 'plain'"#);
    assert!(hides_password(DbKind::Postgres, Flavor::Plain));
    assert!(!hides_password(DbKind::Postgres, Flavor::Cockroach));
    assert!(!hides_password(DbKind::Mysql, Flavor::Plain));
}

/// PBKDF2-HMAC-SHA256 against the known vector (password, salt, 4096 rounds).
#[test]
fn pbkdf2_matches_the_known_vector() {
    let hex: String = pbkdf2(b"password", b"salt", 4096)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        hex,
        "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
    );
    let v = scram_verifier("pencil", b"0123456789abcdef", 4096);
    assert!(v.starts_with("SCRAM-SHA-256$4096:MDEyMzQ1Njc4OWFiY2RlZg==$"));
    assert_eq!(v.split([':', '$']).count(), 5);
    // another salt, another verifier
    assert_ne!(v, scram_verifier("pencil", b"fedcba9876543210", 4096));
    assert_ne!(random_salt().unwrap(), random_salt().unwrap());
}

#[test]
fn an_error_never_brings_the_password_back() {
    let passwords = [Some(Secret::new("pa'ss"))];
    let statements = ["ALTER USER 'a'@'%' IDENTIFIED BY 'pa''ss'".to_owned()];
    // the server quotes the statement in its escaped form: no search for the password finds that
    let mut e = AppError::new(
        ErrorCode::InvalidQuery,
        "You have an error near 'IDENTIFIED BY 'pa''ss'' at line 1",
    );
    e.details = Some(Box::new(crate::error::ErrorDetails {
        near: Some("IDENTIFIED BY 'pa''ss'".into()),
        sqlstate: Some("42000".into()),
        ..Default::default()
    }));
    let clean = scrubbed(e, true, &statements, &passwords);
    let all = serde_json::to_string(&clean).unwrap();
    assert!(!all.contains("pa'"), "{all}");
    assert!(!all.contains("IDENTIFIED"), "{all}");
    assert!(clean.message.contains("42000"));
    assert_eq!(clean.details.unwrap().sqlstate.as_deref(), Some("42000"));
    // another statement of the run failed, and its error happens to hold the password: cleaned, too
    let e = AppError::new(ErrorCode::InvalidQuery, "role \"pa'ss\" does not exist");
    assert!(
        !scrubbed(e, false, &statements, &passwords)
            .message
            .contains("pa'ss")
    );
    // an error that says nothing of it stays as it is
    let plain = AppError::new(
        ErrorCode::PermissionDenied,
        "permission denied to create role",
    );
    assert_eq!(
        scrubbed(plain, false, &statements, &passwords).message,
        "permission denied to create role"
    );
}

/// Review 047 M4/L5: what reaches further than it looks is marked, too.
#[test]
fn marks_escalation_and_more_ways_to_lock_oneself_out() {
    let dangers = |kind: DbKind, change: Change| -> Vec<String> {
        plan(kind, &[change], &cx()).unwrap().remove(0).dangers
    };
    let attribute = |name: &str| Change::Attribute {
        who: Who::new("ann", ""),
        attribute: name.into(),
        on: true,
    };
    assert_eq!(
        dangers(DbKind::Postgres, attribute("createrole")),
        ["escalation"]
    );
    assert_eq!(
        dangers(DbKind::Postgres, attribute("replication")),
        ["escalation"]
    );
    assert!(dangers(DbKind::Postgres, attribute("createdb")).is_empty());
    let join = |role: &str| Change::Member {
        role: Who::new(role, ""),
        member: Who::new("ann", ""),
        add: true,
    };
    // a role that may do everything, by what the server said or by its name
    assert_eq!(dangers(DbKind::Postgres, join("Boss")), ["superuser"]);
    assert_eq!(
        dangers(DbKind::Postgres, join("pg_execute_server_program")),
        ["superuser"]
    );
    assert_eq!(
        dangers(DbKind::Sqlserver, join("db_securityadmin")),
        ["superuser"]
    );
    assert!(dangers(DbKind::Postgres, join("readers")).is_empty());
    let my = |level: &str, schema: &str, object: &str, privilege: &str| Change::Grant {
        who: Who::new("ann", "%"),
        level: level.into(),
        schema: schema.into(),
        object: object.into(),
        column: String::new(),
        privilege: privilege.into(),
        grantable: false,
        add: true,
    };
    assert_eq!(
        dangers(DbKind::Mysql, my("server", "", "", "CREATE USER")),
        ["escalation"]
    );
    assert_eq!(
        dangers(DbKind::Mysql, my("table", "mysql", "user", "UPDATE")),
        ["escalation"]
    );
    assert_eq!(
        dangers(DbKind::Mysql, my("schema", "", "MySQL", "INSERT")),
        ["escalation"]
    );
    assert!(dangers(DbKind::Mysql, my("table", "shop", "t", "UPDATE")).is_empty());
    assert_eq!(
        dangers(
            DbKind::Sqlserver,
            grant("ann", "database", "", "", "ALTER", true)
        ),
        ["escalation"]
    );
    // the own password, the own name in another case, and what everybody holds
    assert_eq!(
        dangers(
            DbKind::Postgres,
            Change::Password {
                who: Who::new("me", "")
            }
        ),
        ["lockout"]
    );
    assert!(
        dangers(
            DbKind::Postgres,
            Change::Password {
                who: Who::new("ann", "")
            }
        )
        .is_empty()
    );
    assert_eq!(
        dangers(
            DbKind::Sqlserver,
            grant("ME", "table", "s", "t", "SELECT", false)
        ),
        ["lockout"]
    );
    assert_eq!(
        dangers(
            DbKind::Postgres,
            grant("public", "schema", "", "s", "USAGE", false)
        ),
        ["lockout"]
    );
}

#[test]
fn rights_as_a_script_and_as_changes_for_another() {
    let g = |level: &str, object: &str, privilege: &str, via: &str| Grant {
        level: level.into(),
        schema: if level == "table" {
            "shop".into()
        } else {
            String::new()
        },
        object: object.into(),
        column: String::new(),
        privilege: privilege.into(),
        grantable: false,
        via: via.into(),
    };
    let grants = [
        g("table", "orders", "SELECT", ""),
        g("table", "orders", "INSERT", "team"),
        g("table", "orders", "OWNER", ""),
        g("schema", "shop", "USAGE", ""),
        g("routine", "f()", "EXECUTE", ""),
    ];
    let text = script(DbKind::Postgres, &Who::new("ben", ""), &grants, &cx()).unwrap();
    assert_eq!(
        text,
        "GRANT SELECT ON TABLE \"shop\".\"orders\" TO \"ben\";\nGRANT USAGE ON SCHEMA \"shop\" TO \"ben\";\n"
    );
    assert_eq!(
        as_changes(DbKind::Postgres, &Who::new("ben", ""), &grants).len(),
        2
    );
}

#[test]
fn changes_come_from_the_window_as_json() {
    let changes: Vec<Change> = serde_json::from_str(
        r#"[{"op":"create","who":{"name":"ann","host":"%"},"login":true,"password":true},
            {"op":"grant","who":{"name":"ann"},"level":"table","schema":"s","object":"t","privilege":"SELECT","add":true},
            {"op":"member","role":{"name":"team"},"member":{"name":"ann"},"add":false},
            {"op":"attribute","who":{"name":"ann"},"attribute":"createdb","on":true},
            {"op":"password","who":{"name":"ann"}},
            {"op":"drop","who":{"name":"ann"},"role":false}]"#,
    )
    .unwrap();
    assert_eq!(changes.len(), 6);
    assert!(serde_json::from_str::<Vec<Change>>(r#"[{"op":"sql","text":"DROP"}]"#).is_err());
    let p = Principal {
        who: Who::new("ann", "%"),
        label: "ann@%".into(),
        member_of: vec!["team".into()],
        ..Default::default()
    };
    let json = serde_json::to_value(&p).unwrap();
    assert_eq!(json["memberOf"][0], "team");
    assert_eq!(json["who"]["host"], "%");
    assert_eq!(Who::new("r", "").label(), "r");
}

/// The window offers the privileges of this list: it is the same list (`privileges.json`).
#[test]
fn the_window_offers_the_same_privileges() {
    let catalog: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/app/features/access/privileges.json"
    ))
    .unwrap();
    let levels = [
        "server", "database", "schema", "table", "column", "sequence", "routine",
    ];
    for (name, kind) in [
        ("postgres", DbKind::Postgres),
        ("mysql", DbKind::Mysql),
        ("sqlserver", DbKind::Sqlserver),
    ] {
        for level in levels {
            let listed: Vec<&str> = catalog[name][level]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            assert_eq!(listed, privileges(kind, level), "{name} {level}");
        }
    }
}
