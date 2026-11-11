//! Writing changed cells back (prompt 031): one `UPDATE` per changed row, built here from what the
//! window collected – names quoted, **every value bound**. A row is found by its key; with a lock, the
//! values the cells had when they were read stand in the `WHERE` too, so a row somebody else changed in
//! the meantime is not found (and the caller, who demands exactly one row, stops). Pure: the statements
//! are run by `ConnectionManager::apply_updates`.

use super::DbKind;
use super::filter::{Builder, Built, MAX_PARAMS, ValueKind, invalid, name};
use crate::error::AppResult;
use serde::Deserialize;

/// Rows written at once at most (deleted, changed and new ones together).
pub const MAX_UPDATE_ROWS: usize = 20_000;
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

/// A row to delete: found by its key, and – with the lock – only if it still holds what was read.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDelete {
    pub key: Vec<CellValue>,
    #[serde(default)]
    pub expect: Vec<CellValue>,
}

/// A new row: the cells the user gave a value. Every other column gets what the database gives it
/// (its default, its identity, NULL).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowInsert {
    #[serde(default)]
    pub set: Vec<SetCell>,
}

/// What is written to one table (prompts 031, 032). Order: rows deleted, rows changed, rows inserted –
/// so a key that is freed can be taken in the same go.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePlan {
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    /// Rows changed.
    #[serde(default)]
    pub rows: Vec<RowUpdate>,
    #[serde(default)]
    pub deletes: Vec<RowDelete>,
    #[serde(default)]
    pub inserts: Vec<RowInsert>,
    /// A column whose value new rows report back (the key the database assigns); empty = none.
    #[serde(default)]
    pub returning: Option<String>,
}

/// What a statement of a plan does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    Delete,
    Update,
    Insert,
}

/// One statement of a plan with what it must do.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub kind: StepKind,
    #[serde(flatten)]
    pub built: Built,
    /// The rows of the plan (of its kind) this statement covers: the first, and how many. It must
    /// change exactly that many rows.
    pub first: usize,
    pub rows: usize,
    /// The statement gives back the value of the `returning` column of every row it inserted.
    pub returns: bool,
}

/// Rows of one `INSERT` at most.
pub const MAX_BATCH_ROWS: usize = 200;

fn check_len(value: &Option<String>) -> AppResult<()> {
    match value {
        Some(v) if v.len() > MAX_VALUE_BYTES => Err(invalid("a value is too long")),
        _ => Ok(()),
    }
}

fn table_of(kind: DbKind, plan: &UpdatePlan) -> AppResult<String> {
    Ok(match plan.schema.as_deref().filter(|s| !s.is_empty()) {
        Some(schema) => format!("{}.{}", name(schema, kind)?, name(&plan.table, kind)?),
        None => name(&plan.table, kind)?,
    })
}

fn done(b: Builder) -> AppResult<Built> {
    if b.params.len() > MAX_PARAMS {
        return Err(invalid("too many values in one statement"));
    }
    Ok(Built {
        sql: b.sql,
        params: b.params,
        display: b.display,
    })
}

/// `WHERE key = … [AND old = … | IS NULL]`: the row, and – with the lock – only as it was read.
fn where_row(
    b: &mut Builder,
    kind: DbKind,
    key: &[CellValue],
    expect: &[CellValue],
) -> AppResult<()> {
    if key.is_empty() || key.len() > MAX_KEY_COLUMNS {
        return Err(invalid("a row needs a key of one to sixteen columns"));
    }
    if expect.len() > MAX_ROW_CELLS {
        return Err(invalid("too many cells of a row"));
    }
    b.text("\nWHERE ");
    for (i, cell) in key.iter().enumerate() {
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
    for cell in expect {
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
    Ok(())
}

/// No column twice: an error of the database at best, a lost value at worst.
fn no_column_twice(set: &[SetCell]) -> AppResult<()> {
    for (i, cell) in set.iter().enumerate() {
        if set[..i].iter().any(|c| c.column == cell.column) {
            return Err(invalid("a cell is set twice"));
        }
    }
    Ok(())
}

fn update(kind: DbKind, table: &str, row: &RowUpdate) -> AppResult<Built> {
    if row.set.is_empty() || row.set.len() > MAX_ROW_CELLS {
        return Err(invalid("a row needs one to 400 changed cells"));
    }
    no_column_twice(&row.set)?;
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
    where_row(&mut b, kind, &row.key, &row.expect)?;
    done(b)
}

fn delete(kind: DbKind, table: &str, row: &RowDelete) -> AppResult<Built> {
    let mut b = Builder::new(kind);
    b.text(&format!("DELETE FROM {table}"));
    where_row(&mut b, kind, &row.key, &row.expect)?;
    done(b)
}

/// The cells of a new row that are sent: a cell left at its default is not named at all (SQLite knows
/// no `DEFAULT` in a list of values, and what is not named gets its default everywhere).
fn sent(row: &RowInsert) -> Vec<&SetCell> {
    row.set.iter().filter(|c| !c.default).collect()
}

/// One `INSERT` for rows that name the same columns. `returning`: give back that column of every row
/// (where the database can: PostgreSQL, SQLite).
fn insert(
    kind: DbKind,
    table: &str,
    rows: &[RowInsert],
    returning: Option<&str>,
) -> AppResult<(Built, bool)> {
    let first = sent(&rows[0]);
    let mut b = Builder::new(kind);
    if first.is_empty() {
        // nothing given: the row the database makes of its own
        b.text(&match kind {
            DbKind::Mysql => format!("INSERT INTO {table} () VALUES ()"),
            _ => format!("INSERT INTO {table} DEFAULT VALUES"),
        });
    } else {
        let names = first
            .iter()
            .map(|c| name(&c.column, kind))
            .collect::<AppResult<Vec<_>>>()?;
        b.text(&format!(
            "INSERT INTO {table} ({})\nVALUES ",
            names.join(", ")
        ));
        for (r, row) in rows.iter().enumerate() {
            if r > 0 {
                b.text(",\n  ");
            }
            b.text("(");
            for (i, cell) in sent(row).iter().enumerate() {
                if i > 0 {
                    b.text(", ");
                }
                match &cell.value {
                    None => b.text("NULL"),
                    Some(value) => {
                        check_len(&cell.value)?;
                        b.value(value, cell.kind, &cell.type_name);
                    }
                }
            }
            b.text(")");
        }
    }
    let returns = match (returning, kind) {
        (Some(column), DbKind::Postgres | DbKind::Sqlite) => {
            b.text(&format!("\nRETURNING {}", name(column, kind)?));
            true
        }
        _ => false,
    };
    Ok((done(b)?, returns))
}

/// Whether two new rows name the same columns in the same order (then they fit into one `INSERT`).
fn same_columns(a: &RowInsert, b: &RowInsert) -> bool {
    let (a, b) = (sent(a), sent(b));
    a.len() == b.len() && a.iter().zip(&b).all(|(x, y)| x.column == y.column)
}

fn check_insert(row: &RowInsert) -> AppResult<()> {
    if row.set.len() > MAX_ROW_CELLS {
        return Err(invalid("too many cells of a row"));
    }
    no_column_twice(&row.set)
}

/// The statements of a plan in the order they run: rows deleted, rows changed, rows inserted. New rows
/// that name the same columns share an `INSERT` (up to [`MAX_BATCH_ROWS`] rows and as many values as a
/// statement takes).
pub fn steps(kind: DbKind, plan: &UpdatePlan) -> AppResult<Vec<Step>> {
    let total = plan.rows.len() + plan.deletes.len() + plan.inserts.len();
    if total == 0 {
        return Err(invalid("nothing to write"));
    }
    if total > MAX_UPDATE_ROWS {
        return Err(invalid("too many rows to write at once"));
    }
    let table = table_of(kind, plan)?;
    let mut out = Vec::with_capacity(total);
    for (i, row) in plan.deletes.iter().enumerate() {
        out.push(Step {
            kind: StepKind::Delete,
            built: delete(kind, &table, row)?,
            first: i,
            rows: 1,
            returns: false,
        });
    }
    for (i, row) in plan.rows.iter().enumerate() {
        out.push(Step {
            kind: StepKind::Update,
            built: update(kind, &table, row)?,
            first: i,
            rows: 1,
            returns: false,
        });
    }
    let returning = plan.returning.as_deref().filter(|c| !c.is_empty());
    let mut at = 0;
    while at < plan.inserts.len() {
        check_insert(&plan.inserts[at])?;
        let width = sent(&plan.inserts[at]).len();
        let mut end = at + 1;
        // rows without any value cannot share a statement (`DEFAULT VALUES` makes one row)
        while width > 0
            && end < plan.inserts.len()
            && end - at < MAX_BATCH_ROWS
            && (end - at + 1) * width <= MAX_PARAMS
            && same_columns(&plan.inserts[at], &plan.inserts[end])
        {
            check_insert(&plan.inserts[end])?;
            end += 1;
        }
        let (built, returns) = insert(kind, &table, &plan.inserts[at..end], returning)?;
        out.push(Step {
            kind: StepKind::Insert,
            built,
            first: at,
            rows: end - at,
            returns,
        });
        at = end;
    }
    Ok(out)
}

/// The new rows `first..first + rows` of a plan, one `INSERT` each: to find the one a shared `INSERT`
/// failed for.
pub fn single_inserts(
    kind: DbKind,
    plan: &UpdatePlan,
    first: usize,
    rows: usize,
) -> AppResult<Vec<Built>> {
    let table = table_of(kind, plan)?;
    plan.inserts
        .iter()
        .skip(first)
        .take(rows)
        .map(|row| insert(kind, &table, std::slice::from_ref(row), None).map(|(b, _)| b))
        .collect()
}

/// One `UPDATE` per changed row of the plan, in its order (the plan's deletes and inserts are not
/// looked at: see [`steps`]).
pub fn build(kind: DbKind, plan: &UpdatePlan) -> AppResult<Vec<Built>> {
    if plan.rows.is_empty() {
        return Err(invalid("nothing to write"));
    }
    if plan.rows.len() > MAX_UPDATE_ROWS {
        return Err(invalid("too many rows to write at once"));
    }
    let table = table_of(kind, plan)?;
    plan.rows
        .iter()
        .map(|row| update(kind, &table, row))
        .collect()
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
            deletes: vec![],
            inserts: vec![],
            returning: None,
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
        assert!(refused(
            &|p| p.rows[0].set = vec![p.rows[0].set[0].clone(); MAX_ROW_CELLS + 1]
        ));
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

    fn new_row(cells: &[(&str, Option<&str>)]) -> RowInsert {
        RowInsert {
            set: cells
                .iter()
                .map(|(column, value)| set(column, *value, ValueKind::Text, ""))
                .collect(),
        }
    }

    /// Prompt 032: rows deleted first, then changed, then inserted – so a key that is freed can be taken.
    #[test]
    fn a_plan_runs_deletes_then_updates_then_inserts() {
        let mut p = plan(vec![row()]);
        p.deletes = vec![RowDelete {
            key: vec![cell("id", Some("9"), ValueKind::Number, "int4")],
            expect: vec![cell("note", None, ValueKind::Text, "text")],
        }];
        p.inserts = vec![new_row(&[("name", Some("it's")), ("note", None)])];
        let steps = steps(DbKind::Postgres, &p).unwrap();
        assert_eq!(
            steps.iter().map(|s| s.kind).collect::<Vec<_>>(),
            [StepKind::Delete, StepKind::Update, StepKind::Insert]
        );
        assert_eq!(
            steps[0].built.sql,
            "DELETE FROM shop.orders\nWHERE id = CAST($1 AS int4)\n  AND note IS NULL"
        );
        assert_eq!(
            steps[2].built.sql,
            "INSERT INTO shop.orders (name, note)\nVALUES ($1, NULL)"
        );
        assert_eq!(steps[2].built.params, vec![Bind::Text("it's".into())]);
        assert_eq!(
            steps[2].built.display,
            "INSERT INTO shop.orders (name, note)\nVALUES ('it''s', NULL)"
        );
        assert!(steps.iter().all(|s| s.rows == 1 && !s.returns));
        // a delete needs a key like an update does
        p.deletes[0].key[0].value = None;
        assert!(super::steps(DbKind::Postgres, &p).is_err());
        assert!(super::steps(DbKind::Postgres, &plan(vec![])).is_err());
    }

    #[test]
    fn new_rows_share_an_insert_when_they_name_the_same_columns() {
        let mut p = plan(vec![]);
        p.inserts = vec![
            new_row(&[("a", Some("1")), ("b", Some("x"))]),
            new_row(&[("a", Some("2")), ("b", None)]),
            // a cell left at its default is not named: this row names only `a`
            RowInsert {
                set: vec![
                    set("a", Some("3"), ValueKind::Text, ""),
                    SetCell {
                        default: true,
                        ..set("b", None, ValueKind::Text, "")
                    },
                ],
            },
            new_row(&[("a", Some("4"))]),
            // nothing given at all: the row the database makes of its own, one statement each
            new_row(&[]),
            new_row(&[]),
        ];
        let my = steps(DbKind::Mysql, &p).unwrap();
        assert_eq!(
            my.iter().map(|s| (s.first, s.rows)).collect::<Vec<_>>(),
            [(0, 2), (2, 2), (4, 1), (5, 1)]
        );
        assert_eq!(
            my[0].built.sql,
            "INSERT INTO shop.orders (a, b)\nVALUES (?, ?),\n  (?, NULL)"
        );
        assert_eq!(my[0].built.params.len(), 3);
        assert_eq!(
            my[1].built.sql,
            "INSERT INTO shop.orders (a)\nVALUES (?),\n  (?)"
        );
        assert_eq!(my[2].built.sql, "INSERT INTO shop.orders () VALUES ()");
        assert_eq!(
            steps(DbKind::Sqlite, &p).unwrap()[2].built.sql,
            "INSERT INTO shop.orders DEFAULT VALUES"
        );
        // the single statements of a shared one, to find the row it failed for
        let singles = single_inserts(DbKind::Mysql, &p, 0, 2).unwrap();
        assert_eq!(singles.len(), 2);
        assert_eq!(
            singles[1].sql,
            "INSERT INTO shop.orders (a, b)\nVALUES (?, NULL)"
        );
        // many rows: no statement beyond its limits
        p.inserts = (0..1000)
            .map(|i| {
                new_row(&[
                    ("a", Some(&i.to_string())),
                    ("b", Some("x")),
                    ("c", Some("y")),
                ])
            })
            .collect();
        let many = steps(DbKind::Sqlserver, &p).unwrap();
        assert_eq!(many.len(), 5);
        assert!(
            many.iter()
                .all(|s| s.rows == MAX_BATCH_ROWS && s.built.params.len() <= MAX_PARAMS)
        );
        assert_eq!(many.iter().map(|s| s.rows).sum::<usize>(), 1000);
        assert_eq!(many[3].first, 600);
    }

    #[test]
    fn new_rows_report_the_key_the_database_gave_them_where_it_can() {
        let mut p = plan(vec![]);
        p.inserts = vec![
            new_row(&[("name", Some("x"))]),
            new_row(&[("name", Some("y"))]),
        ];
        p.returning = Some("order id".into());
        let pg = &steps(DbKind::Postgres, &p).unwrap()[0];
        assert!(pg.returns);
        assert_eq!(
            pg.built.sql,
            "INSERT INTO shop.orders (name)\nVALUES ($1),\n  ($2)\nRETURNING \"order id\""
        );
        assert!(steps(DbKind::Sqlite, &p).unwrap()[0].returns);
        // MySQL and SQL Server have no such clause that always works: asked afterwards, row by row
        for kind in [DbKind::Mysql, DbKind::Sqlserver] {
            let step = &steps(kind, &p).unwrap()[0];
            assert!(
                !step.returns && !step.built.sql.contains("RETURNING"),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn no_value_of_a_new_or_deleted_row_stands_in_a_statement() {
        for kind in ALL {
            for evil in [
                "'); DROP TABLE orders; --",
                "x', 'y'); DELETE FROM t; --",
                "\\'",
                "?1",
                "$1",
            ] {
                let mut p = plan(vec![]);
                p.inserts = vec![new_row(&[("a", Some(evil))]), new_row(&[("a", Some(evil))])];
                p.deletes = vec![RowDelete {
                    key: vec![cell("id", Some(evil), ValueKind::Text, "")],
                    expect: vec![cell("a", Some(evil), ValueKind::Text, "")],
                }];
                for step in steps(kind, &p).unwrap() {
                    for word in ["DROP", "DELETE FROM t", "--"] {
                        assert!(
                            !step.built.sql.contains(word),
                            "{kind:?}: {}",
                            step.built.sql
                        );
                    }
                }
            }
        }
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
