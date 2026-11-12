use super::*;
use crate::db::meta::{ColumnInfo, PartInfo};
use std::collections::HashSet;

fn column(name: &str, how: Gen) -> ColumnSpec {
    ColumnSpec {
        name: name.to_owned(),
        type_name: String::new(),
        value_kind: ValueKind::Text,
        how,
        null_share: 0.0,
        unique: false,
        max_len: None,
    }
}

fn unique(name: &str, how: Gen) -> ColumnSpec {
    ColumnSpec {
        unique: true,
        ..column(name, how)
    }
}

fn spec(columns: Vec<ColumnSpec>, rows: u64) -> Spec {
    Spec {
        schema: String::new(),
        table: "t".to_owned(),
        columns,
        rows,
        seed: 42,
        locale: "en".to_owned(),
    }
}

fn rows_of(spec: Spec) -> Vec<Vec<Option<String>>> {
    rows_with(spec, &HashMap::new())
}

fn rows_with(spec: Spec, keys: &HashMap<String, Vec<String>>) -> Vec<Vec<Option<String>>> {
    let mut g = Generator::new(spec, keys).unwrap();
    let mut out = Vec::new();
    while let Some(row) = g.next_row() {
        out.push(row);
    }
    out
}

fn values(how: Gen, rows: u64) -> Vec<String> {
    rows_of(spec(vec![column("c", how)], rows))
        .into_iter()
        .map(|r| r[0].clone().unwrap())
        .collect()
}

fn refused(spec: Spec) -> String {
    match Generator::new(spec, &HashMap::new()) {
        Err(e) => e.message,
        Ok(_) => panic!("accepted"),
    }
}

fn person_columns() -> Vec<ColumnSpec> {
    vec![
        column("id", Gen::Sequence { start: 1, step: 1 }),
        column("first_name", Gen::FirstName),
        column("last_name", Gen::LastName),
        column("email", Gen::Email),
        column("city", Gen::City),
        column(
            "price",
            Gen::Decimal {
                min: 0.0,
                max: 500.0,
                scale: 2,
            },
        ),
    ]
}

/// The acceptance criterion: the same seed gives the same data, another seed other data.
#[test]
fn the_same_seed_gives_the_same_rows() {
    let a = rows_of(spec(person_columns(), 200));
    let b = rows_of(spec(person_columns(), 200));
    assert_eq!(a, b);
    let other = rows_of(Spec {
        seed: 43,
        ..spec(person_columns(), 200)
    });
    assert_ne!(a, other);
    // a row is what it is whatever came before: more rows only add rows
    let longer = rows_of(spec(person_columns(), 300));
    assert_eq!(a[..], longer[..200]);
}

#[test]
fn names_and_mail_addresses_fit_together() {
    for locale in ["en", "de"] {
        let rows = rows_of(Spec {
            locale: locale.to_owned(),
            ..spec(person_columns(), 300)
        });
        for row in &rows {
            let first = mail_part(row[1].as_deref().unwrap());
            let last = mail_part(row[2].as_deref().unwrap());
            let mail = row[3].as_deref().unwrap();
            assert!(mail.starts_with(&format!("{first}.{last}")), "{row:?}");
            assert!(mail.is_ascii() && mail.contains("@example."), "{mail}");
        }
        // not everybody has the same name
        let names: HashSet<_> = rows.iter().map(|r| r[1].clone()).collect();
        assert!(names.len() > 20, "{locale}: {}", names.len());
    }
    assert_eq!(mail_part("Jürgen Weiß-Müller"), "juergenweissmueller");
}

#[test]
fn numbers_stay_in_their_range() {
    for v in values(
        Gen::Int {
            min: -5,
            max: 5,
            normal: false,
        },
        2_000,
    ) {
        assert!((-5..=5).contains(&v.parse::<i64>().unwrap()), "{v}");
    }
    let seen: HashSet<String> = values(
        Gen::Int {
            min: -5,
            max: 5,
            normal: false,
        },
        2_000,
    )
    .into_iter()
    .collect();
    assert_eq!(seen.len(), 11, "every value of a small range turns up");
    // around the middle: the middle third holds more than a third
    let normal = values(
        Gen::Int {
            min: 0,
            max: 299,
            normal: true,
        },
        6_000,
    );
    let middle = normal
        .iter()
        .filter(|v| (100..200).contains(&v.parse::<i64>().unwrap()))
        .count();
    assert!(middle > 3_000, "{middle}");
    for v in values(
        Gen::Decimal {
            min: -1.5,
            max: 2.25,
            scale: 2,
        },
        2_000,
    ) {
        let n: f64 = v.parse().unwrap();
        assert!((-1.5..=2.25).contains(&n), "{v}");
        assert_eq!(v.split('.').nth(1).map(str::len), Some(2), "{v}");
    }
    assert!(
        values(
            Gen::Decimal {
                min: 0.0,
                max: 9.0,
                scale: 0
            },
            50
        )
        .iter()
        .all(|v| !v.contains('.'))
    );
    assert_eq!(
        values(
            Gen::Sequence {
                start: 10,
                step: -3
            },
            4
        ),
        ["10", "7", "4", "1"]
    );
    let big = values(
        Gen::Int {
            min: i64::MIN,
            max: i64::MAX,
            normal: false,
        },
        100,
    );
    assert!(big.iter().all(|v| v.parse::<i64>().is_ok()));
}

#[test]
fn dates_stay_in_their_range_and_later_is_never_earlier() {
    for v in values(
        Gen::Date {
            from: "2024-02-27".into(),
            to: "2024-03-02".into(),
        },
        500,
    ) {
        assert!(("2024-02-27"..="2024-03-02").contains(&v.as_str()), "{v}");
    }
    let rows = rows_of(spec(
        vec![
            column(
                "created_at",
                Gen::DateTime {
                    from: "2024-01-01".into(),
                    to: "2024-12-31".into(),
                    not_before: None,
                },
            ),
            column(
                "updated_at",
                Gen::DateTime {
                    from: "2024-01-01".into(),
                    to: "2024-12-31".into(),
                    not_before: Some("created_at".into()),
                },
            ),
        ],
        3_000,
    ));
    let mut later = 0;
    for row in &rows {
        let (created, updated) = (row[0].as_deref().unwrap(), row[1].as_deref().unwrap());
        assert!(created <= updated, "{created} > {updated}");
        assert!(
            ("2024-01-01 00:00:00"..="2024-12-31 23:59:59").contains(&updated),
            "{updated}"
        );
        later += usize::from(created < updated);
    }
    assert!(
        later > 2_500,
        "most rows were changed after they were made: {later}"
    );
    // what a column waits for must be there, and wait for nothing itself
    let waits = |other: &str| Gen::DateTime {
        from: "2024-01-01".into(),
        to: "2024-12-31".into(),
        not_before: Some(other.into()),
    };
    assert!(refused(spec(vec![column("a", waits("nope"))], 1)).contains("nope"));
    assert!(
        refused(spec(
            vec![column("a", waits("b")), column("b", waits("a"))],
            1
        ))
        .contains("date-time")
    );
    assert!(refused(spec(vec![column("a", waits("a"))], 1)).contains("date-time"));
    assert!(
        refused(spec(
            vec![column(
                "d",
                Gen::Date {
                    from: "31.01.2024".into(),
                    to: "2024-02-01".into()
                }
            )],
            1
        ))
        .contains("no date")
    );
}

/// The acceptance criterion in small and in large: a unique column never repeats – without remembering
/// what it gave.
#[test]
fn a_unique_column_never_repeats() {
    // a range exactly as large as the rows: every value once
    let all: HashSet<String> = rows_of(spec(
        vec![unique(
            "n",
            Gen::Int {
                min: 100,
                max: 10_099,
                normal: false,
            },
        )],
        10_000,
    ))
    .into_iter()
    .map(|r| r[0].clone().unwrap())
    .collect();
    assert_eq!(all.len(), 10_000);
    // a million rows of a unique number, a unique mail address and a unique date-time
    let mut g = Generator::new(
        spec(
            vec![
                unique(
                    "n",
                    Gen::Int {
                        min: 1,
                        max: 5_000_000,
                        normal: false,
                    },
                ),
                unique("email", Gen::Email),
                unique(
                    "at",
                    Gen::DateTime {
                        from: "2020-01-01".into(),
                        to: "2026-12-31".into(),
                        not_before: None,
                    },
                ),
            ],
            1_000_000,
        ),
        &HashMap::new(),
    )
    .unwrap();
    let mut numbers = vec![false; 5_000_001];
    let mut mails = HashSet::with_capacity(1_000_000);
    let mut stamps = HashSet::with_capacity(1_000_000);
    let mut count = 0u64;
    while let Some(row) = g.next_row() {
        let n: usize = row[0].as_deref().unwrap().parse().unwrap();
        assert!(!numbers[n], "{n} twice");
        numbers[n] = true;
        assert!(mails.insert(row[1].clone()), "{:?} twice", row[1]);
        assert!(stamps.insert(row[2].clone()), "{:?} twice", row[2]);
        count += 1;
    }
    assert_eq!(count, 1_000_000);
}

#[test]
fn a_unique_column_without_values_enough_is_refused_before_a_row_is_made() {
    let few = spec(
        vec![unique(
            "n",
            Gen::Int {
                min: 1,
                max: 9,
                normal: false,
            },
        )],
        10,
    );
    assert!(refused(few).contains("9 different values"));
    assert!(
        refused(spec(vec![unique("b", Gen::Bool { true_share: 0.5 })], 3)).contains("not enough")
    );
    assert!(
        refused(spec(vec![unique("f", Gen::Fixed { value: "x".into() })], 2))
            .contains("not enough")
    );
    let choice = Gen::Choice {
        values: vec![
            Weighted {
                value: "a".into(),
                weight: 1.0,
            },
            Weighted {
                value: "b".into(),
                weight: 1.0,
            },
        ],
    };
    assert!(refused(spec(vec![unique("c", choice.clone())], 3)).contains("not enough"));
    // exactly enough: each once
    let both: HashSet<_> = rows_of(spec(vec![unique("c", choice)], 2))
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    assert_eq!(both.len(), 2);
    // a unique text carries the number of its row, within the length of the column
    let rows = rows_of(spec(
        vec![ColumnSpec {
            max_len: Some(8),
            ..unique("code", Gen::Lorem { words: 3 })
        }],
        2_000,
    ));
    let codes: HashSet<_> = rows.iter().map(|r| r[0].clone().unwrap()).collect();
    assert_eq!(codes.len(), 2_000);
    assert!(codes.iter().all(|c| c.chars().count() <= 8));
}

#[test]
fn a_share_of_null_changes_no_other_value() {
    let plain = rows_of(spec(person_columns(), 4_000));
    let mut with = person_columns();
    with[4].null_share = 0.25;
    let holes = rows_of(spec(with, 4_000));
    let nulls = holes.iter().filter(|r| r[4].is_none()).count();
    assert!((800..1_200).contains(&nulls), "{nulls}");
    for (a, b) in plain.iter().zip(&holes) {
        assert_eq!(a[..4], b[..4]);
        assert!(b[4].is_none() || a[4] == b[4]);
    }
    // a unique column has no holes: a database may take NULL only once
    let mut never = vec![unique("n", Gen::Sequence { start: 1, step: 1 })];
    never[0].null_share = 0.9;
    assert!(rows_of(spec(never, 100)).iter().all(|r| r[0].is_some()));
    let mut bad = person_columns();
    bad[0].null_share = 1.5;
    assert!(refused(spec(bad, 1)).contains("between 0 and 1"));
}

#[test]
fn patterns_give_what_they_describe() {
    for pattern in [
        r"[A-Z]{3}-\d{5}",
        r"https://www\.[a-z]{5,10}\.example\.com",
        r"(red|green|blue)( light| dark)?",
        r"\w+@x\.y",
        r"[0-9a-f]{16}",
        r"a{2,}b*c?",
        r"[a\-z]{4}",
        r"\(\d{3}\) \d{3}",
    ] {
        let check = regex::Regex::new(&format!("^(?:{pattern})$")).unwrap();
        for v in values(
            Gen::Pattern {
                pattern: pattern.to_owned(),
            },
            300,
        ) {
            assert!(check.is_match(&v), "{pattern}: {v}");
        }
    }
    for bad in [
        "[a-z", "(ab", "ab)", "a{3", "a{x}", "a{5,2}", "[z-a]", "*a", "a\\", "a{999}", "[]",
    ] {
        let e = refused(spec(
            vec![column(
                "p",
                Gen::Pattern {
                    pattern: bad.to_owned(),
                },
            )],
            1,
        ));
        assert!(e.contains("pattern"), "{bad}: {e}");
    }
    // a pattern cannot grow without end
    let deep = "(".repeat(20) + "a" + &")".repeat(20);
    assert!(refused(spec(vec![column("p", Gen::Pattern { pattern: deep })], 1)).contains("deep"));
    let long = values(
        Gen::Pattern {
            pattern: "(a{200}){200}".into(),
        },
        1,
    );
    assert!(long[0].chars().count() <= 4_000);
}

#[test]
fn a_choice_follows_its_weights() {
    let how = Gen::Choice {
        values: vec![
            Weighted {
                value: "often".into(),
                weight: 9.0,
            },
            Weighted {
                value: "seldom".into(),
                weight: 1.0,
            },
            Weighted {
                value: "never".into(),
                weight: 0.0,
            },
        ],
    };
    let all = values(how, 10_000);
    let often = all.iter().filter(|v| *v == "often").count();
    assert!((8_700..9_300).contains(&often), "{often}");
    assert!(!all.iter().any(|v| v == "never"));
    let nothing = Gen::Choice {
        values: vec![Weighted {
            value: "x".into(),
            weight: 0.0,
        }],
    };
    assert!(refused(spec(vec![column("c", nothing)], 1)).contains("weights"));
    assert!(refused(spec(vec![column("c", Gen::Choice { values: vec![] })], 1)).contains("choice"));
}

fn keys(name: &str, n: usize) -> HashMap<String, Vec<String>> {
    HashMap::from([(
        name.to_owned(),
        (1..=n).map(|i| (i * 10).to_string()).collect(),
    )])
}

#[test]
fn a_foreign_key_takes_only_values_that_are_there() {
    let fk = || column("customer_id", Gen::ForeignKey { per_parent: None });
    let rows = rows_with(spec(vec![fk()], 5_000), &keys("customer_id", 50));
    let used: HashSet<String> = rows.iter().map(|r| r[0].clone().unwrap()).collect();
    assert_eq!(used.len(), 50, "every parent turns up");
    assert!(used.iter().all(|v| v.parse::<usize>().unwrap() % 10 == 0));
    // no rows to point to: said before anything is made
    assert!(refused(spec(vec![fk()], 10)).contains("fill it first"));
    // unique (one to one): each parent once, and not more rows than parents
    let one = || unique("customer_id", Gen::ForeignKey { per_parent: None });
    let rows = rows_with(spec(vec![one()], 50), &keys("customer_id", 50));
    let used: HashSet<_> = rows.iter().map(|r| r[0].clone()).collect();
    assert_eq!(used.len(), 50);
    assert!(Generator::new(spec(vec![one()], 51), &keys("customer_id", 50)).is_err());
}

/// "0 to 20 orders per customer": every parent gets its share, one after the other, and the number of
/// rows follows from it.
#[test]
fn rows_per_parent_decide_how_many_rows_there_are() {
    let s = spec(
        vec![
            column("id", Gen::Sequence { start: 1, step: 1 }),
            column(
                "customer_id",
                Gen::ForeignKey {
                    per_parent: Some((0, 20)),
                },
            ),
        ],
        7,
    );
    let k = keys("customer_id", 400);
    let g = Generator::new(s.clone(), &k).unwrap();
    let total = g.total();
    let rows = rows_with(s.clone(), &k);
    assert_eq!(rows.len() as u64, total);
    assert!((3_000..5_000).contains(&total), "{total}");
    let mut per: HashMap<String, u32> = HashMap::new();
    let mut last = 0usize;
    for row in &rows {
        let parent = row[1].clone().unwrap();
        let n: usize = parent.parse().unwrap();
        assert!(n >= last, "the parents come in their order");
        last = n;
        *per.entry(parent).or_default() += 1;
    }
    assert!(per.values().all(|n| (1..=20).contains(n)));
    assert!(per.len() < 400, "some parents have no row");
    assert!(per.values().any(|n| *n == 20));
    // the same again
    assert_eq!(rows, rows_with(s, &k));
    // exactly three each
    let three = spec(
        vec![column(
            "p",
            Gen::ForeignKey {
                per_parent: Some((3, 3)),
            },
        )],
        0,
    );
    assert_eq!(rows_with(three, &keys("p", 5)).len(), 15);
    let backwards = spec(
        vec![column(
            "p",
            Gen::ForeignKey {
                per_parent: Some((5, 2)),
            },
        )],
        0,
    );
    assert!(Generator::new(backwards, &keys("p", 5)).is_err());
}

#[test]
fn texts_fit_their_column() {
    let rows = rows_of(spec(
        vec![
            ColumnSpec {
                max_len: Some(5),
                ..column("a", Gen::FullName)
            },
            ColumnSpec {
                max_len: Some(10),
                ..column("b", Gen::Text { min: 3, max: 200 })
            },
            column("c", Gen::Text { min: 8, max: 12 }),
        ],
        500,
    ));
    for row in rows {
        assert!(row[0].as_deref().unwrap().chars().count() <= 5);
        assert!(row[1].as_deref().unwrap().chars().count() <= 10);
        assert!(row[2].as_deref().unwrap().chars().count() <= 12);
    }
    assert_eq!(fitted("Müller".into(), Some(3), None), "Mül");
    assert_eq!(fitted("abcdef".into(), Some(5), Some(42)), "ab-42");
    assert_eq!(fitted("abc".into(), None, Some(7)), "abc-7");
}

#[test]
fn the_other_generators_look_like_what_they_are() {
    let uuid =
        regex::Regex::new("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
            .unwrap();
    let ids = values(Gen::Uuid, 2_000);
    assert!(ids.iter().all(|v| uuid.is_match(v)));
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 2_000);
    let time = regex::Regex::new(r"^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$").unwrap();
    assert!(values(Gen::Time, 500).iter().all(|v| time.is_match(v)));
    let bools = values(Gen::Bool { true_share: 0.8 }, 5_000);
    let yes = bools.iter().filter(|v| *v == "true").count();
    assert!((3_800..4_200).contains(&yes), "{yes}");
    assert_eq!(values(Gen::Lorem { words: 5 }, 1)[0].split(' ').count(), 5);
    assert!(values(Gen::Zip, 200).iter().all(|v| v.len() == 5));
    assert!(
        values(Gen::Phone, 50)
            .iter()
            .all(|v| v.starts_with("+1 202 555 01"))
    );
    for v in values(
        Gen::Json {
            template: r#"{"id": {{int:1:9}}, "ok": {{bool}}, "who": {{firstName}}, "at": {{date}}, "x": "{{nope}}"}"#
                .into(),
        },
        200,
    ) {
        let json: serde_json::Value = serde_json::from_str(&v).unwrap_or_else(|e| panic!("{v}: {e}"));
        assert!((1..=9).contains(&json["id"].as_i64().unwrap()));
        assert!(json["ok"].is_boolean() && json["who"].is_string());
        assert_eq!(json["x"], "{{nope}}");
    }
}

#[test]
fn a_column_the_database_fills_is_left_out() {
    let mut g = Generator::new(
        spec(
            vec![
                column("id", Gen::Skip),
                column("name", Gen::FirstName),
                column("n", Gen::Fixed { value: "7".into() }),
            ],
            3,
        ),
        &HashMap::new(),
    )
    .unwrap();
    assert_eq!(g.written(), [1, 2]);
    assert_eq!(Records::width(&g), 2);
    let first = g.next_record().unwrap().unwrap().unwrap();
    assert_eq!(first.line, 1);
    assert_eq!(first.cells.len(), 2);
    assert_eq!(first.cells[1].as_deref(), Some("7"));
    assert!(g.next_record().unwrap().is_some());
    assert!(g.next_record().unwrap().is_some());
    assert!(g.next_record().unwrap().is_none());
    assert!(refused(spec(vec![], 1)).contains("no columns"));
    assert!(refused(spec(person_columns(), MAX_ROWS + 1)).contains("more than"));
}

fn info(
    name: &str,
    type_name: &str,
    key: &str,
    default: Option<&str>,
    nullable: bool,
) -> ColumnInfo {
    ColumnInfo {
        name: name.to_owned(),
        quoted: name.to_owned(),
        type_name: type_name.to_owned(),
        nullable,
        default: default.map(str::to_owned),
        key: key.to_owned(),
    }
}

#[test]
fn proposes_generators_from_types_keys_and_names() {
    let table = TableInfo {
        columns: vec![
            info(
                "id",
                "integer",
                "pk",
                Some("nextval('t_id_seq'::regclass)"),
                false,
            ),
            info("customer_id", "integer", "fk", None, false),
            info("email", "varchar(120)", "", None, false),
            info("first_name", "varchar(40)", "", None, false),
            info("Nachname", "varchar(40)", "", None, false),
            info("price", "numeric(10,3)", "", None, false),
            info("is_active", "boolean", "", None, false),
            info("created_at", "timestamp without time zone", "", None, false),
            info("updated_at", "timestamptz", "", None, true),
            info("birth_date", "date", "", None, true),
            info("status", "enum('new','paid','it''s')", "", None, false),
            info("token", "uuid", "", None, false),
            info("payload", "jsonb", "", None, true),
            info("sku", "char(9)", "", None, false),
            info("notes", "text", "", None, true),
            info("photo", "bytea", "", None, true),
            info("age", "smallint", "", None, true),
            info("whatever", "varchar(8)", "", None, true),
        ],
        indexes: vec![PartInfo {
            name: "t_email_key".into(),
            detail: "UNIQUE (email)".into(),
        }],
        keys: vec![],
        triggers: vec![],
    };
    let foreign = [ForeignKey {
        name: "fk".into(),
        schema: "public".into(),
        table: "t".into(),
        columns: vec!["customer_id".into()],
        ref_schema: "public".into(),
        ref_table: "customer".into(),
        ref_columns: vec!["id".into()],
    }];
    let all = suggest(&table, &foreign);
    let of = |name: &str| all.iter().find(|c| c.name == name).unwrap();
    assert_eq!(of("id").how, Gen::Skip);
    assert_eq!(of("customer_id").how, Gen::ForeignKey { per_parent: None });
    assert_eq!(of("customer_id").value_kind, ValueKind::Number);
    assert_eq!(of("email").how, Gen::Email);
    assert!(of("email").unique, "the only column of a unique index");
    assert_eq!(of("email").max_len, Some(120));
    assert_eq!(of("first_name").how, Gen::FirstName);
    assert_eq!(of("Nachname").how, Gen::LastName);
    assert_eq!(
        of("price").how,
        Gen::Decimal {
            min: 0.0,
            max: 500.0,
            scale: 3
        }
    );
    assert_eq!(of("price").max_len, None);
    assert_eq!(of("is_active").value_kind, ValueKind::Bool);
    assert!(matches!(
        &of("created_at").how,
        Gen::DateTime {
            not_before: None,
            ..
        }
    ));
    assert!(matches!(
        &of("updated_at").how,
        Gen::DateTime { not_before: Some(c), .. } if c == "created_at"
    ));
    assert!(matches!(&of("birth_date").how, Gen::Date { from, .. } if from == "1950-01-01"));
    assert!(matches!(
        &of("status").how,
        Gen::Choice { values } if values.iter().map(|v| v.value.as_str()).collect::<Vec<_>>() == ["new", "paid", "it's"]
    ));
    assert_eq!(of("token").how, Gen::Uuid);
    assert!(matches!(of("payload").how, Gen::Json { .. }));
    assert!(matches!(of("sku").how, Gen::Pattern { .. }));
    assert_eq!(of("notes").how, Gen::Lorem { words: 12 });
    assert_eq!(of("photo").how, Gen::Skip);
    assert_eq!(
        of("age").how,
        Gen::Int {
            min: 18,
            max: 90,
            normal: true
        }
    );
    assert_eq!(of("whatever").how, Gen::Text { min: 5, max: 8 });
    // what was proposed can be made as it is
    let mut columns = all.clone();
    columns.retain(|c| c.name != "sku");
    let made = rows_with(spec(columns, 50), &keys("customer_id", 5));
    assert_eq!(made.len(), 50);
    // a key that is not filled by the database counts up; it is unique
    let plain = suggest(
        &TableInfo {
            columns: vec![
                info("id", "int", "pk", None, false),
                info("name", "varchar(20)", "", None, false),
            ],
            ..TableInfo::default()
        },
        &[],
    );
    assert_eq!(plain[0].how, Gen::Sequence { start: 1, step: 1 });
    assert!(plain[0].unique);
    assert_eq!(plain[1].how, Gen::FullName);
}

#[test]
fn a_spec_comes_from_the_window_as_json() {
    let spec: Spec = serde_json::from_value(serde_json::json!({
        "schema": "public", "table": "t", "rows": 10, "seed": 7, "locale": "de",
        "columns": [
            {"name": "id", "gen": {"kind": "sequence", "start": 1, "step": 1}, "unique": true},
            {"name": "n", "typeName": "int4", "valueKind": "number", "gen": {"kind": "int", "min": 1, "max": 9}},
            {"name": "at", "gen": {"kind": "dateTime", "from": "2024-01-01", "to": "2024-12-31", "notBefore": null}},
            {"name": "c", "gen": {"kind": "choice", "values": [{"value": "a"}, {"value": "b", "weight": 2}]}, "nullShare": 0.5},
            {"name": "f", "gen": {"kind": "foreignKey", "perParent": [0, 3]}},
            {"name": "s", "gen": {"kind": "skip"}},
            {"name": "b", "gen": {"kind": "bool", "trueShare": 0.3}, "maxLen": 5}
        ]
    }))
    .unwrap();
    assert_eq!(spec.columns[1].value_kind, ValueKind::Number);
    assert_eq!(
        spec.columns[4].how,
        Gen::ForeignKey {
            per_parent: Some((0, 3))
        }
    );
    // and back: the proposal goes to the window in the same words
    let back = serde_json::to_value(&spec.columns[2]).unwrap();
    assert_eq!(back["gen"]["kind"], "dateTime");
    assert_eq!(back["nullShare"], 0.0);
    assert!(
        serde_json::from_value::<Gen>(serde_json::json!({"kind": "sql", "text": "x"})).is_err()
    );
}

/// Review 049: a pattern whose groups write nothing must not turn for ever.
#[test]
fn a_pattern_that_writes_nothing_ends() {
    let empty = "((((((((){200}){200}){200}){200}){200}){200}){200}){200}";
    let started = std::time::Instant::now();
    let v = values(
        Gen::Pattern {
            pattern: empty.into(),
        },
        50,
    );
    assert!(v.iter().all(String::is_empty));
    let slow = "(((a{0}){200}){200}){200}x";
    assert_eq!(
        values(
            Gen::Pattern {
                pattern: slow.into()
            },
            20
        )
        .len(),
        20
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

/// Review 049: "unique" holds, or the spec is refused – it is never quietly not so.
#[test]
fn unique_is_kept_or_refused() {
    // no room for the number of the row
    let tight = |max_len, rows| {
        spec(
            vec![ColumnSpec {
                max_len: Some(max_len),
                ..unique("c", Gen::City)
            }],
            rows,
        )
    };
    assert!(refused(tight(3, 1_000)).contains("no room"));
    let codes: HashSet<_> = rows_of(tight(4, 1_000))
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    assert_eq!(codes.len(), 1_000);
    // a unique number is not cut to the length of its column: a cut could make two alike
    let rows = rows_of(spec(
        vec![ColumnSpec {
            max_len: Some(1),
            ..unique("n", Gen::Sequence { start: 1, step: 1 })
        }],
        100,
    ));
    assert_eq!(
        rows.iter()
            .map(|r| r[0].clone())
            .collect::<HashSet<_>>()
            .len(),
        100
    );
    // two rows of a unique yes/no: one of each
    let both = rows_of(spec(vec![unique("b", Gen::Bool { true_share: 1.0 })], 2));
    assert_ne!(both[0], both[1]);
    // a time of day: each second once, and still a time
    let times = rows_of(spec(vec![unique("t", Gen::Time)], 5_000));
    assert_eq!(
        times
            .iter()
            .map(|r| r[0].clone())
            .collect::<HashSet<_>>()
            .len(),
        5_000
    );
    assert!(times.iter().all(|r| r[0].as_deref().unwrap().len() == 8));
    assert!(refused(spec(vec![unique("t", Gen::Time)], 86_401)).contains("not enough"));
    // what cannot be made unique is refused
    assert!(
        refused(spec(
            vec![unique(
                "j",
                Gen::Json {
                    template: "{}".into()
                }
            )],
            2
        ))
        .contains("JSON")
    );
    let twice = Gen::Choice {
        values: vec![
            Weighted {
                value: "a".into(),
                weight: 1.0,
            },
            Weighted {
                value: "a".into(),
                weight: 1.0,
            },
        ],
    };
    assert!(refused(spec(vec![unique("c", twice)], 2)).contains("twice"));
    let waits = spec(
        vec![
            column(
                "a",
                Gen::DateTime {
                    from: "2024-01-01".into(),
                    to: "2024-12-31".into(),
                    not_before: None,
                },
            ),
            unique(
                "b",
                Gen::DateTime {
                    from: "2024-01-01".into(),
                    to: "2024-12-31".into(),
                    not_before: Some("a".into()),
                },
            ),
        ],
        10,
    );
    assert!(refused(waits).contains("cannot wait"));
    // the widest range there is, unique, and a template over every number
    let wide = rows_of(spec(
        vec![unique(
            "n",
            Gen::Int {
                min: i64::MIN,
                max: i64::MAX,
                normal: false,
            },
        )],
        1_000,
    ));
    assert_eq!(
        wide.iter()
            .map(|r| r[0].clone())
            .collect::<HashSet<_>>()
            .len(),
        1_000
    );
    let all = values(
        Gen::Json {
            template: format!("{{{{int:{}:{}}}}}", i64::MIN, i64::MAX),
        },
        200,
    );
    assert!(all.iter().collect::<HashSet<_>>().len() > 190);
}
