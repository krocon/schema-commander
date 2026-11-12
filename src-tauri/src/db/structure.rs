//! Editing the structure of a table (prompt 043): the window sends the table as it was read and as it
//! was edited, never SQL. The statements are written here – by the migration of the schema comparison
//! (`compare::script_steps`), so both write the same DDL – in an order that holds, with every step that
//! may lose data told apart. [`run`] executes them through the guard, in a transaction where the
//! database has DDL in transactions.
//!
//! Pure but for [`load`] and [`run`].

use super::compare::{self, Rename, ScriptStep, Snapshot, Table};
use super::filter::name;
use super::{DbKind, Limits, Session, Stop};
use crate::error::{AppError, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};

/// A column that has another name now.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRename {
    pub from: String,
    pub to: String,
}

/// What the window asks for.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    /// A table as it was read (`None`: it is new) and as it shall be.
    #[serde(rename_all = "camelCase")]
    Change {
        schema: String,
        before: Option<Table>,
        after: Table,
        #[serde(default)]
        renames: Vec<ColumnRename>,
    },
    #[serde(rename_all = "camelCase")]
    Drop { schema: String, table: String },
    /// Removes every row.
    #[serde(rename_all = "camelCase")]
    Truncate { schema: String, table: String },
    /// A new table with the structure of `table`, and its rows if `data`.
    #[serde(rename_all = "camelCase")]
    Duplicate {
        schema: String,
        table: Table,
        name: String,
        #[serde(default)]
        data: bool,
    },
}

/// The statements of a request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub steps: Vec<ScriptStep>,
    /// All statements run in one transaction: a failure leaves nothing behind. `false` (MySQL, MariaDB):
    /// every statement of DDL commits by itself – after a failure the ones before it stay.
    pub transactional: bool,
    /// A part of what was asked for is not written (a remark stands in its place): running the rest
    /// would leave the table half edited. Such a plan is shown and can be opened as a script, not run.
    pub incomplete: bool,
}

impl Plan {
    /// The statements that run, in their order.
    pub fn statements(&self) -> Vec<String> {
        self.steps
            .iter()
            .filter(|s| !s.sql.is_empty())
            .map(|s| s.sql.clone())
            .collect()
    }
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, message)
}

fn qualified(kind: DbKind, schema: &str, table: &str) -> AppResult<String> {
    if kind == DbKind::Sqlite || schema.is_empty() {
        name(table, kind)
    } else {
        Ok(format!("{}.{}", name(schema, kind)?, name(table, kind)?))
    }
}

fn step(sql: String) -> ScriptStep {
    ScriptStep {
        sql,
        danger: None,
        note: None,
    }
}

fn dangerous(sql: String, why: &str) -> ScriptStep {
    ScriptStep {
        sql,
        danger: Some(why.to_owned()),
        note: None,
    }
}

fn snapshot_of(kind: DbKind, schema: &str, tables: Vec<Table>) -> Snapshot {
    Snapshot {
        kind,
        schema: schema.to_owned(),
        tables,
        views: Vec::new(),
        routines: Vec::new(),
        triggers: Vec::new(),
    }
}

/// A step of the migration can hold several statements, each ending its line with `;` (the changes of
/// one column): here every step is one statement, so each runs – and is admitted – by itself. That a
/// `;` at the end of a line ends a statement holds because [`checked`] lets no line break into a table.
fn single(steps: Vec<ScriptStep>) -> Vec<ScriptStep> {
    let mut out = Vec::new();
    for step in steps {
        let mut statement = String::new();
        let mut parts = Vec::new();
        for line in step.sql.lines() {
            if !statement.is_empty() {
                statement.push('\n');
            }
            statement.push_str(line);
            if line.trim_end().ends_with(';') {
                parts.push(std::mem::take(&mut statement));
            }
        }
        if !statement.trim().is_empty() {
            parts.push(statement);
        }
        if parts.len() <= 1 {
            out.push(step);
            continue;
        }
        for sql in parts {
            out.push(ScriptStep {
                sql,
                danger: step.danger.clone(),
                note: step.note.clone(),
            });
        }
    }
    out
}

/// One line: what is written into a statement as it is (a type, a default, a check) must not break it.
fn one_line(text: &str) -> bool {
    !text
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{85}'))
}

/// A table must have a name and columns with names, each once, and keys of columns it has.
fn checked(table: &Table) -> AppResult<()> {
    if table.name.trim().is_empty() {
        return Err(invalid("the table has no name"));
    }
    if table.columns.is_empty() {
        return Err(invalid("a table needs at least one column"));
    }
    let mut seen = std::collections::HashSet::new();
    for c in &table.columns {
        if c.name.trim().is_empty() {
            return Err(invalid("a column has no name"));
        }
        if c.type_name.trim().is_empty() {
            return Err(invalid("a column has no type"));
        }
        if !seen.insert(c.name.to_lowercase()) {
            return Err(invalid("two columns have the same name"));
        }
        if !one_line(&c.type_name) || !c.default.as_deref().is_none_or(one_line) {
            return Err(invalid("a type or a default holds a line break"));
        }
    }
    if !table.checks.iter().all(|c| one_line(&c.text))
        || !table
            .indexes
            .iter()
            .all(|i| i.definition.as_deref().is_none_or(one_line))
    {
        return Err(invalid("a check or an index holds a line break"));
    }
    let has = |column: &String| table.columns.iter().any(|c| &c.name == column);
    if !table.pk.iter().all(has) {
        return Err(invalid(
            "the primary key names a column the table does not have",
        ));
    }
    for index in &table.indexes {
        if index.definition.is_none()
            && (index.columns.is_empty() || !index.columns.iter().all(has))
        {
            return Err(invalid("an index names a column the table does not have"));
        }
    }
    for key in &table.keys {
        if key.columns.is_empty()
            || key.columns.len() != key.ref_columns.len()
            || !key.columns.iter().all(has)
            || key.ref_table.trim().is_empty()
        {
            return Err(invalid(
                "a foreign key needs columns of the table and as many columns of the table it points to",
            ));
        }
    }
    Ok(())
}

/// Makes the edited table safe to compare with the one that was read:
/// - renames must not cross (a name that is taken by a column of the table as it was read): applied one
///   after the other they would collapse;
/// - a statement (`definition`) is the database's, never the window's: the table's is kept only when the
///   table is otherwise as it was read, an index's only when the table as read has that very index;
/// - a key of the table to itself follows the new name of the table and of its columns.
fn settle(
    kind: DbKind,
    before: Option<&Table>,
    after: &mut Table,
    renames: &[ColumnRename],
) -> AppResult<()> {
    let _ = kind;
    let Some(before) = before else {
        after.definition = None;
        for index in &mut after.indexes {
            index.definition = None;
        }
        return Ok(());
    };
    for r in renames.iter().filter(|r| r.from != r.to) {
        if !before.columns.iter().any(|c| c.name == r.from) {
            return Err(invalid(
                "a column that is renamed is not a column of the table",
            ));
        }
        if before
            .columns
            .iter()
            .any(|c| c.name.eq_ignore_ascii_case(&r.to) && c.name != r.from)
        {
            return Err(invalid(
                "a column cannot take the name another column has: rename in two steps",
            ));
        }
    }
    if after.definition != before.definition {
        after.definition = None;
    }
    for index in &mut after.indexes {
        if index.definition.is_some()
            && !before
                .indexes
                .iter()
                .any(|b| b.name == index.name && b.definition == index.definition)
        {
            index.definition = None;
        }
    }
    let now = |column: &String| {
        renames
            .iter()
            .find(|r| r.from == *column)
            .map_or_else(|| column.clone(), |r| r.to.clone())
    };
    for key in &mut after.keys {
        if key.ref_schema.is_empty() && key.ref_table == before.name {
            key.ref_table = after.name.clone();
            key.ref_columns = key.ref_columns.iter().map(now).collect();
        }
    }
    Ok(())
}

/// Parts of an edit the migration does not write, said as remarks (which make the plan incomplete):
/// - an index, a key or a check that only got another name (the comparison sees the same thing);
/// - MySQL and SQL Server refuse to rename a column that a check uses.
fn unwritten(
    kind: DbKind,
    before: &Table,
    after: &Table,
    renames: &[ColumnRename],
    steps: &[ScriptStep],
) -> Vec<ScriptStep> {
    let remark = |text: String| ScriptStep {
        sql: String::new(),
        danger: None,
        note: Some(text),
    };
    let mut out = Vec::new();
    let written = |name: &str| steps.iter().any(|s| s.sql.contains(name));
    let gone = |old: &[&str], new: &[&str]| -> Vec<(String, String)> {
        // names that are only in the table as read, and names that are only in the edited one
        let left: Vec<&&str> = old.iter().filter(|n| !new.contains(n)).collect();
        let right: Vec<&&str> = new.iter().filter(|n| !old.contains(n)).collect();
        left.iter()
            .zip(right.iter())
            .map(|(a, b)| ((**a).to_string(), (**b).to_string()))
            .collect()
    };
    fn names(v: Vec<&String>) -> Vec<&str> {
        v.into_iter().map(String::as_str).collect()
    }
    for (what, old, new) in [
        (
            "index",
            names(before.indexes.iter().map(|i| &i.name).collect()),
            names(after.indexes.iter().map(|i| &i.name).collect()),
        ),
        (
            "foreign key",
            names(before.keys.iter().map(|k| &k.name).collect()),
            names(after.keys.iter().map(|k| &k.name).collect()),
        ),
        (
            "check",
            names(before.checks.iter().map(|c| &c.name).collect()),
            names(after.checks.iter().map(|c| &c.name).collect()),
        ),
    ] {
        for (from, to) in gone(&old, &new) {
            if !to.is_empty() && !written(&to) {
                out.push(remark(format!(
                    "the {what} {from} only got another name ({to}): that is not written – drop it and add it anew"
                )));
            }
        }
    }
    if matches!(kind, DbKind::Mysql | DbKind::Sqlserver) {
        for r in renames.iter().filter(|r| r.from != r.to) {
            let word = |text: &str| {
                text.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .any(|w| w.eq_ignore_ascii_case(&r.from))
            };
            for check in before.checks.iter().filter(|c| word(&c.text)) {
                out.push(remark(format!(
                    "the check {} uses the column {}: this database refuses to rename it – drop the check first, then rename, then add it again",
                    check.name, r.from
                )));
            }
        }
    }
    out
}

/// The statements for a request. Nothing is asked or run.
pub fn plan(kind: DbKind, request: &Request) -> AppResult<Plan> {
    let steps = match request {
        Request::Change {
            schema,
            before,
            after,
            renames,
        } => {
            checked(after)?;
            let mut after = after.clone();
            let after = &mut after;
            settle(kind, before.as_ref(), after, renames)?;
            let mut all: Vec<Rename> = Vec::new();
            if let Some(before) = before {
                for r in renames {
                    if r.from != r.to {
                        all.push(Rename {
                            table: Some(before.name.clone()),
                            from: r.from.clone(),
                            to: r.to.clone(),
                        });
                    }
                }
                if before.name != after.name {
                    all.push(Rename {
                        table: None,
                        from: before.name.clone(),
                        to: after.name.clone(),
                    });
                }
            }
            let source = snapshot_of(kind, schema, vec![after.clone()]);
            let target = snapshot_of(kind, schema, before.iter().cloned().collect());
            let mut steps = compare::script_steps(&source, &target, &all)?;
            if let Some(before) = before {
                steps.extend(unwritten(kind, before, after, renames, &steps));
            }
            steps
        }
        Request::Drop { schema, table } => vec![dangerous(
            format!("DROP TABLE {};", qualified(kind, schema, table)?),
            "drops the table with all of its rows",
        )],
        Request::Truncate { schema, table } => {
            let t = qualified(kind, schema, table)?;
            vec![dangerous(
                match kind {
                    // SQLite has no TRUNCATE
                    DbKind::Sqlite => format!("DELETE FROM {t};"),
                    _ => format!("TRUNCATE TABLE {t};"),
                },
                "removes every row of the table",
            )]
        }
        Request::Duplicate {
            schema,
            table,
            name: new_name,
            data,
        } => {
            if new_name.trim().is_empty() || new_name == &table.name {
                return Err(invalid("the copy needs a name of its own"));
            }
            // names of indexes and constraints are taken (per schema in most databases): the copy gets
            // its own, and no statement that names the original
            let own = |n: &str| {
                if n.is_empty() {
                    String::new()
                } else {
                    format!("{new_name}_{n}")
                }
            };
            let copy = Table {
                name: new_name.clone(),
                indexes: table
                    .indexes
                    .iter()
                    .map(|i| compare::Index {
                        name: own(&i.name),
                        definition: None,
                        ..i.clone()
                    })
                    .filter(|i| !i.columns.is_empty())
                    .collect(),
                keys: table
                    .keys
                    .iter()
                    .map(|k| compare::Key {
                        name: own(&k.name),
                        ..k.clone()
                    })
                    .collect(),
                checks: table
                    .checks
                    .iter()
                    .map(|c| compare::Named {
                        name: own(&c.name),
                        text: c.text.clone(),
                    })
                    .collect(),
                definition: None,
                ..table.clone()
            };
            checked(&copy)?;
            let source = snapshot_of(kind, schema, vec![copy]);
            let target = snapshot_of(kind, schema, Vec::new());
            let mut steps = compare::script_steps(&source, &target, &[])?;
            if *data {
                let columns = table
                    .columns
                    .iter()
                    .map(|c| name(&c.name, kind))
                    .collect::<AppResult<Vec<_>>>()?
                    .join(", ");
                // before the keys and indexes of the copy: right behind its CREATE TABLE
                let at = steps
                    .iter()
                    .position(|s| s.sql.to_uppercase().starts_with("CREATE TABLE"))
                    .map_or(steps.len(), |i| i + 1);
                steps.insert(
                    at,
                    step(format!(
                        "INSERT INTO {} ({columns}) SELECT {columns} FROM {};",
                        qualified(kind, schema, new_name)?,
                        qualified(kind, schema, &table.name)?
                    )),
                );
            }
            steps
        }
    };
    let steps = single(steps);
    Ok(Plan {
        // a remark instead of a statement: a part of the edit that nobody wrote
        incomplete: steps.iter().any(|s| s.sql.is_empty() && s.note.is_some()),
        steps,
        transactional: kind != DbKind::Mysql,
    })
}

/// The columns of an index that is given as its statement (PostgreSQL: `CREATE INDEX i ON s.t USING
/// btree (a, "b c")`) – when it is a plain list of columns. Empty for anything more: an expression, an
/// order, a condition (`WHERE`), included columns. Such an index is shown by its statement and not edited.
pub fn index_columns(definition: &str) -> Vec<String> {
    let Some(open) = definition.find('(') else {
        return Vec::new();
    };
    let mut depth = 0usize;
    let mut quoted = false;
    let mut close = None;
    for (i, c) in definition[open..].char_indices() {
        match c {
            '"' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + i);
                    break;
                }
            }
            _ => {}
        }
    }
    let Some(close) = close else {
        return Vec::new();
    };
    // anything behind the list is more than a list of columns
    if !definition[close + 1..]
        .trim()
        .trim_end_matches(';')
        .is_empty()
    {
        return Vec::new();
    }
    let mut columns = Vec::new();
    let mut item = String::new();
    let mut quoted = false;
    let inner = &definition[open + 1..close];
    let mut parts = Vec::new();
    for c in inner.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                item.push(c);
            }
            ',' if !quoted => parts.push(std::mem::take(&mut item)),
            _ => item.push(c),
        }
    }
    parts.push(item);
    for part in parts {
        let part = part.trim();
        let column = if part.len() >= 2 && part.starts_with('"') && part.ends_with('"') {
            let inner = &part[1..part.len() - 1];
            // a quote inside a name is doubled; a single one would end it
            if inner.replace("\"\"", "").contains('"') {
                return Vec::new();
            }
            inner.replace("\"\"", "\"")
        } else if !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        {
            part.to_owned()
        } else {
            return Vec::new();
        };
        columns.push(column);
    }
    columns
}

/// Reads a table as the editor shows it: its columns, keys, indexes and checks.
pub fn load(
    s: &mut dyn Session,
    kind: DbKind,
    schema: &str,
    table: &str,
    stop: Stop,
) -> AppResult<Table> {
    let mut found = compare::snapshot(s, kind, schema, stop)?
        .tables
        .into_iter()
        .find(|t| t.name == table)
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "no such table"))?;
    for index in &mut found.indexes {
        if index.columns.is_empty()
            && let Some(definition) = &index.definition
        {
            index.columns = index_columns(definition);
        }
    }
    Ok(found)
}

/// How running a plan went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ran {
    /// Statements that ran well.
    pub done: usize,
    /// The statement that failed (an index into the statements that run), and what the database said.
    pub failed: Option<usize>,
    pub error: Option<AppError>,
    /// The statements ran in a transaction.
    pub transactional: bool,
    /// After a failure: everything was rolled back. `false` with `failed`: what ran before stays.
    pub rolled_back: bool,
}

/// Runs the statements one after the other – in a transaction where `transactional`. A failure ends the
/// run; in a transaction everything is rolled back.
pub fn run(
    s: &mut dyn Session,
    kind: DbKind,
    statements: &[String],
    transactional: bool,
    timeout: Option<std::time::Duration>,
    stop: Stop,
) -> AppResult<Ran> {
    let limits = Limits {
        max_rows: 1,
        timeout,
    };
    let quiet = Limits::rows(1);
    let mut ran = Ran {
        done: 0,
        failed: None,
        error: None,
        transactional,
        rolled_back: false,
    };
    if transactional {
        s.query(super::begin_statement(kind), quiet, stop)?;
    }
    for (i, sql) in statements.iter().enumerate() {
        if stop() {
            ran.failed = Some(i);
            ran.error = Some(super::cancelled());
            break;
        }
        // a `;` at the end is the script's, not the statement's
        match s.query(sql.trim().trim_end_matches(';'), limits, stop) {
            Ok(_) => ran.done += 1,
            Err(e) => {
                ran.failed = Some(i);
                ran.error = Some(e);
                break;
            }
        }
    }
    if transactional {
        if ran.failed.is_some() {
            // a failure may have ended the transaction already (SQL Server): then there is none to end
            let _ = s.query("ROLLBACK", quiet, &|| false);
            ran.rolled_back = true;
            ran.done = 0;
        } else if let Err(e) = s.query("COMMIT", quiet, &|| false) {
            let _ = s.query("ROLLBACK", quiet, &|| false);
            ran.failed = Some(statements.len().saturating_sub(1));
            ran.error = Some(e);
            ran.rolled_back = true;
            ran.done = 0;
        }
    }
    Ok(ran)
}

#[cfg(test)]
#[path = "structure_tests.rs"]
mod tests;
