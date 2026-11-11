//! Writing changed cells back (prompt 031): one `UPDATE` per changed row, built here from what the
//! window collected – names quoted, **every value bound**. A row is found by its key; with a lock, the
//! values the cells had when they were read stand in the `WHERE` too, so a row somebody else changed in
//! the meantime is not found (and the caller, who demands exactly one row, stops). Pure: the statements
//! are run by `ConnectionManager::apply_updates`.

use super::DbKind;
use super::filter::{Builder, Built, MAX_PARAMS, ValueKind, invalid, name};
use crate::error::AppResult;
use serde::Deserialize;

/// Rows written at once at most.
pub const MAX_UPDATE_ROWS: usize = 1000;
/// Cells set in one row, and old values checked for it, at most.
pub const MAX_ROW_CELLS: usize = 400;
/// Columns of a key at most.
pub const MAX_KEY_COLUMNS: usize = 16;
/// Bytes of one value at most.
pub const MAX_VALUE_BYTES: usize = 16 * 1024 * 1024;

/// A column and a value of it. `value: None` is NULL.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValue {
    pub column: String,
    #[serde(default)]
    pub kind: ValueKind,
    /// The type of the column as the database names it: PostgreSQL casts the value to it.
    #[serde(default)]
    pub type_name: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// What a cell becomes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCell {
    pub column: String,
    #[serde(default)]
    pub kind: ValueKind,
    #[serde(default)]
    pub type_name: String,
    /// The new value; `None` with `default: false` is NULL.
    #[serde(default)]
    pub value: Option<String>,
    /// The default of the column (`DEFAULT`); `value` is not looked at then.
    #[serde(default)]
    pub default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowUpdate {
    /// The key of the row: never NULL.
    pub key: Vec<CellValue>,
    pub set: Vec<SetCell>,
    /// The lock: values cells of the row had when it was read (may be NULL). Empty = no lock.
    #[serde(default)]
    pub expect: Vec<CellValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePlan {
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub rows: Vec<RowUpdate>,
}

fn check_len(value: &Option<String>) -> AppResult<()> {
    match value {
        Some(v) if v.len() > MAX_VALUE_BYTES => Err(invalid("a value is too long")),
        _ => Ok(()),
    }
}

/// One `UPDATE` per row of the plan, in its order.
pub fn build(kind: DbKind, plan: &UpdatePlan) -> AppResult<Vec<Built>> {
    if plan.rows.is_empty() {
        return Err(invalid("nothing to write"));
    }
    if plan.rows.len() > MAX_UPDATE_ROWS {
        return Err(invalid("too many rows to write at once"));
    }
    let table = match plan.schema.as_deref().filter(|s| !s.is_empty()) {
        Some(schema) => format!("{}.{}", name(schema, kind)?, name(&plan.table, kind)?),
        None => name(&plan.table, kind)?,
    };
    let mut out = Vec::with_capacity(plan.rows.len());
    for row in &plan.rows {
        if row.key.is_empty() || row.key.len() > MAX_KEY_COLUMNS {
            return Err(invalid("a row needs a key of one to sixteen columns"));
        }
        if row.set.is_empty() || row.set.len() > MAX_ROW_CELLS || row.expect.len() > MAX_ROW_CELLS {
            return Err(invalid("a row needs one to 400 changed cells"));
        }
        // a column set twice would be an error of the database at best, and a lost value at worst
        for (i, cell) in row.set.iter().enumerate() {
            if row.set[..i].iter().any(|c| c.column == cell.column) {
                return Err(invalid("a cell is changed twice"));
            }
        }
        let mut b = Builder::new(kind);
        b.text(&format!("UPDATE {table}\nSET "));
        for (i, cell) in row.set.iter().enumerate() {
            if i > 0 {
                b.text(", ");
            }
            let column = name(&cell.column, kind)?;
            match (&cell.value, cell.default) {
                (_, true) => b.text(&format!("{column} = DEFAULT")),
                (None, false) => b.text(&format!("{column} = NULL")),
                (Some(value), false) => {
                    check_len(&cell.value)?;
                    b.text(&format!("{column} = "));
                    b.value(value, cell.kind, &cell.type_name);
                }
            }
        }
        b.text("\nWHERE ");
        for (i, cell) in row.key.iter().enumerate() {
            if i > 0 {
                b.text(" AND ");
            }
            // a key that is NULL finds no row with `=`, and `IS NULL` could find several
            let Some(value) = &cell.value else {
                return Err(invalid("the key of a row is NULL"));
            };
            check_len(&cell.value)?;
            b.text(&format!("{} = ", name(&cell.column, kind)?));
            b.value(value, cell.kind, &cell.type_name);
        }
        for cell in &row.expect {
            let column = name(&cell.column, kind)?;
            match &cell.value {
                None => b.text(&format!("\n  AND {column} IS NULL")),
                Some(value) => {
                    check_len(&cell.value)?;
                    b.text(&format!("\n  AND {column} = "));
                    b.value(value, cell.kind, &cell.type_name);
                }
            }
        }
        if b.params.len() > MAX_PARAMS {
            return Err(invalid("too many values in one statement"));
        }
        out.push(Built {
            sql: b.sql,
            params: b.params,
            display: b.display,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Bind;

    const ALL: [DbKind; 4] = [
        DbKind::Postgres,
        DbKind::Mysql,
        DbKind::Sqlserver,
        DbKind::Sqlite,
    ];

    fn cell(column: &str, value: Option<&str>, kind: ValueKind, type_name: &str) -> CellValue {
        CellValue {
            column: column.into(),
            kind,
            type_name: type_name.into(),
            value: value.map(str::to_owned),
        }
    }

    fn set(column: &str, value: Option<&str>, kind: ValueKind, type_name: &str) -> SetCell {
        SetCell {
            column: column.into(),
            kind,
            type_name: type_name.into(),
            value: value.map(str::to_owned),
            default: false,
        }
    }

    fn plan(rows: Vec<RowUpdate>) -> UpdatePlan {
        UpdatePlan {
            schema: Some("shop".into()),
            table: "orders".into(),
            rows,
        }
    }

    fn row() -> RowUpdate {
        RowUpdate {
            key: vec![cell("id", Some("7"), ValueKind::Number, "int4")],
            set: vec![
                set("note", Some("it's"), ValueKind::Text, "text"),
                set("qty", Some("3"), ValueKind::Number, "int4"),
                set("seen", None, ValueKind::Text, "timestamptz"),
                SetCell {
                    default: true,
                    ..set("state", Some("ignored"), ValueKind::Text, "text")
                },
            ],
            expect: vec![
                cell("note", Some("old"), ValueKind::Text, "text"),
                cell("seen", None, ValueKind::Text, "timestamptz"),
            ],
        }
    }

    #[test]
    fn one_update_per_row_with_every_value_bound() {
        let pg = build(DbKind::Postgres, &plan(vec![row(), row()])).unwrap();
        assert_eq!(pg.len(), 2);
        assert_eq!(
            pg[0].sql,
            "UPDATE shop.orders\nSET note = CAST($1 AS text), qty = CAST($2 AS int4), seen = NULL, state = DEFAULT\nWHERE id = CAST($3 AS int4)\n  AND note = CAST($4 AS text)\n  AND seen IS NULL"
        );
        assert_eq!(
            pg[0].params,
            ["it's", "3", "7", "old"]
                .map(|v| Bind::Text(v.into()))
                .to_vec()
        );
        assert_eq!(
            pg[0].display,
            "UPDATE shop.orders\nSET note = CAST('it''s' AS text), qty = CAST('3' AS int4), seen = NULL, state = DEFAULT\nWHERE id = CAST('7' AS int4)\n  AND note = CAST('old' AS text)\n  AND seen IS NULL"
        );
        let ms = build(DbKind::Sqlserver, &plan(vec![row()])).unwrap();
        assert_eq!(
            ms[0].sql,
            "UPDATE shop.orders\nSET note = @P1, qty = @P2, seen = NULL, state = DEFAULT\nWHERE id = @P3\n  AND note = @P4\n  AND seen IS NULL"
        );
        assert_eq!(ms[0].params[1], Bind::Int("3".into()));
        let my = build(DbKind::Mysql, &plan(vec![row()])).unwrap();
        assert!(
            my[0]
                .sql
                .starts_with("UPDATE shop.orders\nSET note = ?, qty = ?, seen = NULL")
        );
    }

    #[test]
    fn a_composite_key_and_no_lock() {
        let p = plan(vec![RowUpdate {
            key: vec![
                cell("warehouse", Some("1"), ValueKind::Number, "int4"),
                cell("item code", Some("A"), ValueKind::Text, ""),
            ],
            set: vec![set("qty", Some("0"), ValueKind::Number, "int4")],
            expect: vec![],
        }]);
        assert_eq!(
            build(DbKind::Sqlite, &p).unwrap()[0].sql,
            "UPDATE shop.orders\nSET qty = ?1\nWHERE warehouse = ?2 AND \"item code\" = ?3"
        );
    }

    /// The acceptance criterion: no value becomes text of a statement – quotes, backslashes, Unicode,
    /// things that look like SQL; as a new value, as a key and as a value of the lock.
    #[test]
    fn no_value_ever_stands_in_a_statement() {
        let evil = [
            "'; DROP TABLE orders; --",
            "\\'; DELETE FROM t; --",
            "x' WHERE 1=1 --",
            "ä😀'\"`[];--/*",
            "$1, admin = TRUE",
            "?1",
            "@P1",
            "\0",
        ];
        for kind in ALL {
            for value in evil {
                for value_kind in [ValueKind::Text, ValueKind::Number, ValueKind::Bool] {
                    let p = plan(vec![RowUpdate {
                        key: vec![cell("id", Some(value), value_kind, "int4")],
                        set: vec![set("note", Some(value), value_kind, "text")],
                        expect: vec![cell("note", Some(value), value_kind, "text")],
                    }]);
                    let built = &build(kind, &p).unwrap()[0];
                    for word in ["DROP", "DELETE", "1=1", "admin", "--", "😀"] {
                        assert!(!built.sql.contains(word), "{kind:?} {value}: {}", built.sql);
                    }
                    assert_eq!(built.params.len(), 3, "{kind:?} {value}");
                    assert_eq!(built.sql.matches("WHERE").count(), 1);
                }
            }
        }
    }

    #[test]
    fn names_are_quoted_and_what_is_no_plan_is_refused() {
        let mut p = plan(vec![row()]);
        p.table = "ord\"ers; DROP".into();
        p.rows[0].set[0].column = "no te".into();
        let sql = &build(DbKind::Postgres, &p).unwrap()[0].sql;
        assert!(sql.starts_with("UPDATE shop.\"ord\"\"ers; DROP\"\nSET \"no te\" = "));
        let refused = |change: &dyn Fn(&mut UpdatePlan)| {
            let mut p = plan(vec![row()]);
            change(&mut p);
            build(DbKind::Postgres, &p).is_err()
        };
        assert!(refused(&|p| p.rows.clear()));
        assert!(refused(&|p| p.rows[0].key.clear()));
        assert!(refused(&|p| p.rows[0].set.clear()));
        // a key that is NULL identifies no row
        assert!(refused(&|p| p.rows[0].key[0].value = None));
        assert!(refused(&|p| p.rows[0].set[1].column = "note".into()));
        assert!(refused(&|p| p.table = String::new()));
        assert!(refused(&|p| p.rows[0].set[0].column = "a\0b".into()));
        assert!(refused(&|p| p.rows = vec![row(); MAX_UPDATE_ROWS + 1]));
        assert!(refused(
            &|p| p.rows[0].set[0].value = Some("x".repeat(MAX_VALUE_BYTES + 1))
        ));
        // a type that is none is not written: the value is still bound
        let mut odd = plan(vec![row()]);
        odd.rows[0].set[0].type_name = "text); DROP TABLE t; --".into();
        let built = &build(DbKind::Postgres, &odd).unwrap()[0];
        assert!(built.sql.contains("SET note = $1,") && !built.sql.contains("DROP"));
    }

    #[test]
    fn reads_what_the_window_sends() {
        let p: UpdatePlan = serde_json::from_value(serde_json::json!({
            "schema": "shop",
            "table": "orders",
            "rows": [{
                "key": [{ "column": "id", "kind": "number", "typeName": "int4", "value": "7" }],
                "set": [
                    { "column": "note", "kind": "text", "typeName": "text", "value": "x" },
                    { "column": "seen", "value": null },
                    { "column": "state", "default": true }
                ],
                "expect": [{ "column": "note", "value": null }]
            }]
        }))
        .unwrap();
        assert!(p.rows[0].set[2].default);
        assert_eq!(
            build(DbKind::Mysql, &p).unwrap()[0].sql,
            "UPDATE shop.orders\nSET note = ?, seen = NULL, state = DEFAULT\nWHERE id = ?\n  AND note IS NULL"
        );
    }
}
