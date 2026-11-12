//! Comparing two schemas (prompt 038): a **snapshot** of what a schema is made of, the **difference**
//! between two of them, and a **migration script** that makes one like the other – a proposal to read
//! and change, never run by the app. Steps that may lose data stand in the script as comments.
//!
//! Snapshot, difference and script are pure; only [`snapshot`] asks a database (its catalog, with bound
//! parameters). The script holds names quoted by `filter::name` and definitions as the catalog of the
//! **source** gave them (types, defaults, the text of views): it is SQL of the user's own databases –
//! or of a snapshot file the user chose –, shown in an editor.

use super::diagram;
use super::filter::name;
use super::find::source_questions;
use super::{DbKind, Session, Stop, TextRows};
use crate::error::{AppError, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(60);
/// Objects of a kind a snapshot holds at most (a file may say anything).
pub const MAX_OBJECTS: usize = 20_000;
/// What starts a line of the script that may lose data: it is a comment until the user removes this.
pub const DANGER: &str = "-- DANGER: ";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub type_name: String,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub name: String,
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub columns: Vec<String>,
    /// The whole statement, where the database gives it (PostgreSQL): expressions, order, method.
    #[serde(default)]
    pub definition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub name: String,
    pub columns: Vec<String>,
    /// `""`: the schema of the snapshot itself.
    #[serde(default)]
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub name: String,
    #[serde(default)]
    pub columns: Vec<Column>,
    #[serde(default)]
    pub pk: Vec<String>,
    #[serde(default)]
    pub indexes: Vec<Index>,
    #[serde(default)]
    pub keys: Vec<Key>,
    #[serde(default)]
    pub checks: Vec<Named>,
    #[serde(default)]
    pub comment: Option<String>,
    /// The statement that made the table, where the database keeps it (SQLite): what creates it anew
    /// with its keys and checks, which cannot be added afterwards there.
    #[serde(default)]
    pub definition: Option<String>,
}

/// What a schema is made of, as far as it is compared: not rights, partitions, storage parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub kind: DbKind,
    pub schema: String,
    #[serde(default)]
    pub tables: Vec<Table>,
    #[serde(default)]
    pub views: Vec<Named>,
    #[serde(default)]
    pub routines: Vec<Named>,
    /// Named `table.trigger` where the database tells the table.
    #[serde(default)]
    pub triggers: Vec<Named>,
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::InvalidQuery, message)
}

/// Whether a text is the name of a type and nothing more: no statement ends in it, no comment starts.
fn type_like(text: &str) -> bool {
    if text.len() > 200 || text.contains("--") || text.contains("/*") {
        return false;
    }
    // between single quotes (the values of an `enum`) anything on one line; a quote is doubled there
    let mut quoted = false;
    for c in text.chars() {
        if c == '\'' {
            quoted = !quoted;
        } else if quoted {
            if c.is_control() || c == '\\' {
                return false;
            }
        } else if !(c.is_alphanumeric()
            || matches!(c, ' ' | '_' | '(' | ')' | ',' | '[' | ']' | '.' | '"'))
        {
            return false;
        }
    }
    !quoted
}

/// A snapshot that came from outside (a file): within the limits, or refused.
pub fn checked(s: &Snapshot) -> AppResult<()> {
    const TEXT: usize = 4 * 1024 * 1024;
    const SHORT: usize = 16 * 1024;
    let texts = |list: &[Named]| {
        list.iter()
            .all(|n| n.text.len() <= TEXT && n.name.len() <= 600)
    };
    let names = |list: &[String]| list.len() <= 64 && list.iter().all(|n| n.len() <= 300);
    let fine = s.schema.len() <= 300
        && s.tables.len() <= MAX_OBJECTS
        && s.views.len() <= MAX_OBJECTS
        && s.routines.len() <= MAX_OBJECTS
        && s.triggers.len() <= MAX_OBJECTS
        && s.tables.iter().all(|t| {
            t.name.len() <= 300
                && t.columns.len() <= 5_000
                && t.indexes.len() <= 5_000
                && t.keys.len() <= 5_000
                && t.checks.len() <= 5_000
                && names(&t.pk)
                && t.definition.as_ref().is_none_or(|d| d.len() <= TEXT)
                && t.columns.iter().all(|c| {
                    c.name.len() <= 300
                        && type_like(&c.type_name)
                        && c.default.as_ref().is_none_or(|d| d.len() <= SHORT)
                })
                && t.indexes.iter().all(|i| {
                    i.name.len() <= 300
                        && names(&i.columns)
                        && i.definition.as_ref().is_none_or(|d| d.len() <= SHORT)
                })
                && t.keys.iter().all(|k| {
                    k.name.len() <= 300
                        && k.ref_schema.len() <= 300
                        && k.ref_table.len() <= 300
                        && names(&k.columns)
                        && names(&k.ref_columns)
                })
                && t.checks
                    .iter()
                    .all(|c| c.name.len() <= 300 && c.text.len() <= SHORT)
        })
        && texts(&s.views)
        && texts(&s.routines)
        && texts(&s.triggers);
    if fine {
        Ok(())
    } else {
        Err(invalid(
            "the snapshot holds more, or something else, than a schema does",
        ))
    }
}

// --- reading ----------------------------------------------------------------------------------------

fn at(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

/// Rows `table, index, unique, column or definition` of the indexes that are no primary key.
fn index_rows(s: &mut dyn Session, kind: DbKind, schema: &str, stop: Stop) -> AppResult<TextRows> {
    match kind {
        DbKind::Postgres => s.ask(
            "SELECT c.relname::text, ic.relname::text, i.indisunique::text, \
               pg_catalog.pg_get_indexdef(i.indexrelid) \
             FROM pg_catalog.pg_index i \
             JOIN pg_catalog.pg_class c ON c.oid = i.indrelid \
             JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND NOT i.indisprimary ORDER BY 1, 2",
            &[schema],
            Some(TIMEOUT),
            stop,
        ),
        DbKind::Mysql => s.ask(
            "SELECT TABLE_NAME, INDEX_NAME, IF(NON_UNIQUE = 0, 'true', 'false'), COLUMN_NAME \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ? AND INDEX_NAME <> 'PRIMARY' ORDER BY 1, 2, SEQ_IN_INDEX",
            &[schema],
            Some(TIMEOUT),
            stop,
        ),
        DbKind::Sqlserver => s.ask(
            "SELECT o.name, i.name, CASE WHEN i.is_unique = 1 THEN 'true' ELSE 'false' END, c.name \
             FROM sys.indexes i \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
             JOIN sys.objects o ON o.object_id = i.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.type = 'U' AND i.is_primary_key = 0 AND i.type > 0 \
               AND ic.is_included_column = 0 \
             ORDER BY 1, 2, ic.key_ordinal",
            &[schema],
            Some(TIMEOUT),
            stop,
        ),
        // only indexes that were created as such: those of constraints belong to the table
        DbKind::Sqlite | DbKind::Libsql | DbKind::D1 => s.ask(
            "SELECT m.name, l.name, CASE WHEN l.\"unique\" = 1 THEN 'true' ELSE 'false' END, x.name \
             FROM sqlite_master m, pragma_index_list(m.name) l, pragma_index_info(l.name) x \
             WHERE m.type = 'table' AND l.origin = 'c' ORDER BY 1, 2, x.seqno",
            &[],
            Some(TIMEOUT),
            stop,
        ),
        DbKind::Oracle | DbKind::Duckdb | DbKind::Clickhouse | DbKind::Trino | DbKind::Firebird => Err(super::not_yet(kind, "schema compare and structure editing")),
    }
}

/// Rows `table.column, default` where the questions for definitions do not give them as they are
/// written in SQL.
fn default_rows(
    s: &mut dyn Session,
    kind: DbKind,
    schema: &str,
    stop: Stop,
) -> AppResult<Option<TextRows>> {
    Ok(match kind {
        DbKind::Sqlite | DbKind::Libsql | DbKind::D1 => Some(s.ask(
            "SELECT m.name || '.' || p.name, p.dflt_value \
             FROM sqlite_master m, pragma_table_info(m.name) p \
             WHERE m.type = 'table' AND p.dflt_value IS NOT NULL",
            &[],
            Some(TIMEOUT),
            stop,
        )?),
        // MySQL gives the default of a text without its quotes (MariaDB with them)
        DbKind::Mysql => {
            let maria = s
                .server_version(stop)
                .is_ok_and(|v| v.starts_with("MariaDB"));
            if maria {
                None
            } else {
                Some(s.ask(
                    "SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME), \
                       CASE WHEN EXTRA LIKE '%DEFAULT_GENERATED%' \
                         OR DATA_TYPE IN ('tinyint', 'smallint', 'mediumint', 'int', 'bigint', \
                           'decimal', 'float', 'double', 'bit') \
                       THEN COLUMN_DEFAULT ELSE QUOTE(COLUMN_DEFAULT) END \
                     FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = ? AND COLUMN_DEFAULT IS NOT NULL",
                    &[schema],
                    Some(TIMEOUT),
                    stop,
                )?)
            }
        }
        _ => None,
    })
}

/// Reads what a schema is made of.
pub fn snapshot(
    s: &mut dyn Session,
    kind: DbKind,
    schema: &str,
    stop: Stop,
) -> AppResult<Snapshot> {
    if matches!(
        kind,
        DbKind::Oracle | DbKind::Duckdb | DbKind::Clickhouse | DbKind::Trino | DbKind::Firebird
    ) {
        return Err(super::not_yet(kind, "schema compare and structure editing"));
    }
    let data = diagram::diagram(s, kind, schema, stop)?;
    let mut tables: BTreeMap<String, Table> = data
        .tables
        .iter()
        .map(|t| {
            (
                t.name.clone(),
                Table {
                    name: t.name.clone(),
                    columns: t
                        .columns
                        .iter()
                        .map(|c| Column {
                            name: c.name.clone(),
                            type_name: c.type_name.clone(),
                            nullable: c.nullable,
                            default: None,
                        })
                        .collect(),
                    pk: t
                        .columns
                        .iter()
                        .filter(|c| c.pk)
                        .map(|c| c.name.clone())
                        .collect(),
                    ..Table::default()
                },
            )
        })
        .collect();
    for key in &data.keys {
        if key.schema != schema {
            continue;
        }
        if let Some(table) = tables.get_mut(&key.table) {
            table.keys.push(Key {
                name: key.name.clone(),
                columns: key.columns.clone(),
                ref_schema: if key.ref_schema == schema {
                    String::new()
                } else {
                    key.ref_schema.clone()
                },
                ref_table: key.ref_table.clone(),
                ref_columns: key.ref_columns.clone(),
            });
        }
    }
    // an index the database could not tell is no reason to have no snapshot (CockroachDB, old servers)
    for row in index_rows(s, kind, schema, stop).unwrap_or_default() {
        let Some(table) = tables.get_mut(&at(&row, 0)) else {
            continue;
        };
        let (index, unique, what) = (at(&row, 1), at(&row, 2) == "true", at(&row, 3));
        // an index on an expression: MySQL and SQLite name no column for it – it cannot be written
        if what.is_empty() {
            table.indexes.retain(|i| i.name != index);
            continue;
        }
        if kind == DbKind::Postgres {
            table.indexes.push(Index {
                name: index,
                unique,
                columns: Vec::new(),
                definition: Some(what),
            });
        } else if let Some(last) = table.indexes.last_mut().filter(|i| i.name == index) {
            last.columns.push(what);
        } else {
            table.indexes.push(Index {
                name: index,
                unique,
                columns: vec![what],
                definition: None,
            });
        }
    }
    let mut out = Snapshot {
        kind,
        schema: schema.to_owned(),
        tables: Vec::new(),
        views: Vec::new(),
        routines: Vec::new(),
        triggers: Vec::new(),
    };
    let set_default = |tables: &mut BTreeMap<String, Table>, place: &str, text: String| {
        if let Some((table, column)) = place.rsplit_once('.')
            && let Some(c) = tables
                .get_mut(table)
                .and_then(|t| t.columns.iter_mut().find(|c| c.name == column))
        {
            c.default = Some(text);
        }
    };
    let own_defaults = default_rows(s, kind, schema, stop)?;
    for sql in source_questions(kind, s.flavor()) {
        // what this server's catalog does not have is not compared
        let Ok(rows) = s.ask(sql, &[schema], Some(TIMEOUT), stop) else {
            continue;
        };
        for row in rows {
            let (what, object) = (at(&row, 0), at(&row, 1));
            let Some(text) = row.get(2).cloned().flatten() else {
                continue;
            };
            match what.as_str() {
                // (a materialized view is none that `CREATE OR REPLACE VIEW` makes: not compared)
                "view" => out.views.push(Named { name: object, text }),
                "routine" => out.routines.push(Named { name: object, text }),
                "trigger" => out.triggers.push(Named { name: object, text }),
                "check" => {
                    // `table.constraint`; MySQL names a check without its table
                    if let Some((table, check)) = object.rsplit_once('.')
                        && let Some(t) = tables.get_mut(table)
                    {
                        t.checks.push(Named {
                            name: check.to_owned(),
                            text,
                        });
                    }
                }
                "default" if own_defaults.is_none() => set_default(&mut tables, &object, text),
                "comment" => {
                    if let Some(t) = tables.get_mut(&object) {
                        t.comment = Some(text);
                    }
                }
                "table" => {
                    if let Some(t) = tables.get_mut(&object) {
                        t.definition = Some(text);
                    }
                }
                _ => {}
            }
        }
    }
    for row in own_defaults.unwrap_or_default() {
        if let Some(text) = row.get(1).cloned().flatten() {
            set_default(&mut tables, &at(&row, 0), text);
        }
    }
    // routines of one name (overloads): told apart by their place among them
    out.routines
        .sort_by(|a, b| (&a.name, &a.text).cmp(&(&b.name, &b.text)));
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for r in &mut out.routines {
        let n = seen.entry(r.name.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            r.name = format!("{} #{n}", r.name);
        }
    }
    out.views.sort_by(|a, b| a.name.cmp(&b.name));
    out.triggers.sort_by(|a, b| a.name.cmp(&b.name));
    out.tables = tables.into_values().collect();
    Ok(out)
}

// --- comparing --------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Table,
    Column,
    PrimaryKey,
    Index,
    Key,
    Check,
    View,
    Routine,
    Trigger,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Same,
    OnlyLeft,
    OnlyRight,
    Different,
}

/// One thing of the two schemas and how it differs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Names the item for a script: `column:orders.total`.
    pub id: String,
    pub kind: ItemKind,
    /// The table a part belongs to.
    pub table: Option<String>,
    pub name: String,
    pub state: State,
    /// How it is defined on each side, to read and to compare line by line.
    pub left: Option<String>,
    pub right: Option<String>,
}

/// A pair the user says is one thing under two names: without it, the app sees one thing gone and
/// another new.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    /// The table of a column that was renamed; `None`: the table itself was.
    #[serde(default)]
    pub table: Option<String>,
    /// The name on the side that is changed (the target).
    pub from: String,
    /// The name it gets (as the source has it).
    pub to: String,
}

fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A text without the name of its own schema in front of names: two schemas with different names hold
/// the same view.
fn unqualified(text: &str, schema: &str) -> String {
    replaced_schema(text, schema, "")
}

/// A text with the schema in front of names replaced (`to` with its dot and quotes, or nothing). Only
/// where a name starts: `s.orders`, not `boss.id`.
fn replaced_schema(text: &str, schema: &str, to: &str) -> String {
    if schema.is_empty() {
        return text.to_owned();
    }
    let prefixes = [
        format!("\"{schema}\"."),
        format!("`{schema}`."),
        format!("[{schema}]."),
        format!("{schema}."),
    ];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut before: Option<char> = None;
    'text: while !rest.is_empty() {
        let boundary = before.is_none_or(|c| {
            !(c.is_alphanumeric() || matches!(c, '_' | '.' | '"' | '`' | ']' | '$'))
        });
        if boundary {
            for prefix in &prefixes {
                if rest.starts_with(prefix.as_str()) {
                    out.push_str(to);
                    rest = &rest[prefix.len()..];
                    before = Some('.');
                    continue 'text;
                }
            }
        }
        let c = rest.chars().next().expect("not empty");
        out.push(c);
        before = Some(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// The name of a type in one spelling: `int4`, `INT` and `integer` are one type.
pub fn norm_type(type_name: &str) -> String {
    let t = squeeze(&type_name.to_ascii_lowercase());
    // `int(10) unsigned`: name, size, and what stands behind it
    let (head, size, tail) = match (t.find('('), t.rfind(')')) {
        (Some(open), Some(close)) if open < close => (
            t[..open].trim_end(),
            &t[open..=close],
            t[close + 1..].trim(),
        ),
        _ => (t.as_str(), "", ""),
    };
    // a word behind the name without a size belongs to it too (`int unsigned`, `double precision`)
    let (base, extra) = match head.strip_suffix(" unsigned") {
        Some(b) => (b, "unsigned"),
        None => (head, ""),
    };
    let (base, keep_size) = match base {
        "int4" | "int" | "integer" => ("integer", false),
        "int8" | "bigint" => ("bigint", false),
        "int2" | "smallint" => ("smallint", false),
        "mediumint" => ("mediumint", false),
        "bool" | "boolean" => ("boolean", true),
        "character varying" | "varchar" => ("varchar", true),
        "character" | "char" | "bpchar" => ("char", true),
        "decimal" | "numeric" | "dec" => ("numeric", true),
        "timestamp without time zone" | "timestamp" => ("timestamp", true),
        "timestamp with time zone" | "timestamptz" => ("timestamptz", true),
        "time without time zone" | "time" => ("time", true),
        "double precision" | "float8" | "double" => ("double", true),
        "float4" | "real" => ("real", true),
        other => (other, true),
    };
    // MySQL writes a width behind whole numbers that means nothing (`int(11)`)
    let size: String = size.chars().filter(|c| !c.is_whitespace()).collect();
    let mut out = format!("{base}{}", if keep_size { size } else { String::new() });
    for word in [extra, tail] {
        if !word.is_empty() {
            out.push(' ');
            out.push_str(word);
        }
    }
    out
}

fn norm_default(default: Option<&str>, schema: &str) -> Option<String> {
    let mut d = squeeze(&unqualified(default?, schema));
    // SQL Server wraps a default in brackets, twice for numbers
    while d.starts_with('(') && d.ends_with(')') && balanced(&d[1..d.len() - 1]) {
        d = d[1..d.len() - 1].trim().to_owned();
    }
    // PostgreSQL says what type a literal is: `'x'::character varying`
    if let Some(at) = d.rfind("::")
        // … behind a literal; behind an expression the cast is part of what the default is
        && (d[..at].ends_with('\'') || d[..at].chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '-')))
        && d[at + 2..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '(' | ')' | ',' | '"'))
        && !d[at + 2..].is_empty()
    {
        d.truncate(at);
    }
    (!d.eq_ignore_ascii_case("null")).then_some(d)
}

/// Whether every bracket of a text closes what it opened (so the brackets around it are a pair).
fn balanced(text: &str) -> bool {
    let mut depth = 0i32;
    for c in text.chars() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

fn norm_text(text: &str, schema: &str) -> String {
    squeeze(unqualified(text, schema).trim().trim_end_matches(';'))
}

fn column_line(c: &Column) -> String {
    format!(
        "{} {}{}{}",
        c.name,
        c.type_name,
        if c.nullable { "" } else { " NOT NULL" },
        c.default
            .as_deref()
            .map(|d| format!(" DEFAULT {d}"))
            .unwrap_or_default()
    )
}

fn column_same(a: &Column, b: &Column, left: &str, right: &str) -> bool {
    norm_type(&a.type_name) == norm_type(&b.type_name)
        && a.nullable == b.nullable
        && norm_default(a.default.as_deref(), left) == norm_default(b.default.as_deref(), right)
}

fn index_text(i: &Index, table: &str) -> String {
    i.definition.clone().unwrap_or_else(|| {
        format!(
            "CREATE {}INDEX {} ON {table} ({})",
            if i.unique { "UNIQUE " } else { "" },
            i.name,
            i.columns.join(", ")
        )
    })
}

/// What an index does, without its name (which the database, or a tool, often made up).
fn index_sign(i: &Index, table: &str, schema: &str) -> String {
    let text = norm_text(&index_text(i, table), schema).to_ascii_lowercase();
    match (text.find("index "), text.find(" on ")) {
        (Some(from), Some(to)) if from + 6 <= to => {
            format!("{}{}", &text[..from + 6], &text[to + 1..])
        }
        _ => text,
    }
}

fn key_text(k: &Key) -> String {
    format!(
        "FOREIGN KEY ({}) REFERENCES {}{} ({})",
        k.columns.join(", "),
        if k.ref_schema.is_empty() {
            String::new()
        } else {
            format!("{}.", k.ref_schema)
        },
        k.ref_table,
        k.ref_columns.join(", ")
    )
}

/// What a table is, as lines: to read both sides and to compare them.
pub fn table_text(t: &Table) -> String {
    let mut lines = vec![format!("TABLE {}", t.name)];
    lines.extend(t.columns.iter().map(|c| format!("  {}", column_line(c))));
    if !t.pk.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", t.pk.join(", ")));
    }
    let mut keys: Vec<String> = t
        .keys
        .iter()
        .map(|k| format!("  {}", key_text(k)))
        .collect();
    keys.sort();
    lines.extend(keys);
    let mut checks: Vec<String> = t
        .checks
        .iter()
        .map(|c| format!("  CHECK {}", squeeze(&c.text)))
        .collect();
    checks.sort();
    lines.extend(checks);
    let mut indexes: Vec<String> = t
        .indexes
        .iter()
        .map(|i| format!("  {}", squeeze(&index_text(i, &t.name))))
        .collect();
    indexes.sort();
    lines.extend(indexes);
    lines.join("\n")
}

/// The target with the renames the user told applied: what is compared and scripted against.
fn renamed(target: &Snapshot, renames: &[Rename]) -> Snapshot {
    let mut out = target.clone();
    let ordered = renames
        .iter()
        .filter(|r| r.table.is_none())
        .chain(renames.iter().filter(|r| r.table.is_some()));
    for r in ordered {
        match &r.table {
            None => {
                for t in &mut out.tables {
                    if t.name == r.from {
                        t.name = r.to.clone();
                    }
                    for k in &mut t.keys {
                        if k.ref_schema.is_empty() && k.ref_table == r.from {
                            k.ref_table = r.to.clone();
                        }
                    }
                }
            }
            Some(table) => {
                // the table under the name it has after its own rename
                let now = renames
                    .iter()
                    .find(|x| x.table.is_none() && x.from == *table)
                    .map_or(table.as_str(), |x| x.to.as_str())
                    .to_owned();
                for t in &mut out.tables {
                    let swap = |c: &mut String| {
                        if *c == r.from {
                            *c = r.to.clone();
                        }
                    };
                    if t.name == now {
                        t.columns.iter_mut().for_each(|c| swap(&mut c.name));
                        t.pk.iter_mut().for_each(swap);
                        t.indexes
                            .iter_mut()
                            .for_each(|i| i.columns.iter_mut().for_each(swap));
                        t.keys
                            .iter_mut()
                            .for_each(|k| k.columns.iter_mut().for_each(swap));
                    }
                    for k in &mut t.keys {
                        if k.ref_schema.is_empty() && k.ref_table == now {
                            k.ref_columns.iter_mut().for_each(swap);
                        }
                    }
                }
            }
        }
    }
    out.tables.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn state_of(left: bool, right: bool, same: bool) -> State {
    match (left, right) {
        (true, false) => State::OnlyLeft,
        (false, true) => State::OnlyRight,
        _ if same => State::Same,
        _ => State::Different,
    }
}

/// Pairs things of two lists by a key: `(key, left, right)`, in the order of the keys.
fn paired<'a, T>(
    left: &'a [T],
    right: &'a [T],
    key: impl Fn(&T) -> String,
) -> Vec<(String, Option<&'a T>, Option<&'a T>)> {
    let mut all: BTreeMap<String, (Option<&T>, Option<&T>)> = BTreeMap::new();
    for item in left {
        all.entry(key(item)).or_default().0 = Some(item);
    }
    for item in right {
        all.entry(key(item)).or_default().1 = Some(item);
    }
    all.into_iter().map(|(k, (l, r))| (k, l, r)).collect()
}

/// The difference of two schemas of the same kind of database. `renames` are applied to the right
/// side first.
pub fn compare(left: &Snapshot, right: &Snapshot, renames: &[Rename]) -> AppResult<Vec<Item>> {
    if left.kind != right.kind {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "schemas of two kinds of database are not compared",
        ));
    }
    checked(left)?;
    checked(right)?;
    let right = &renamed(right, renames);
    let (ls, rs) = (left.schema.as_str(), right.schema.as_str());
    let mut out = Vec::new();
    for (table, l, r) in paired(&left.tables, &right.tables, |t| t.name.clone()) {
        let mut parts: Vec<Item> = Vec::new();
        if let (Some(l), Some(r)) = (l, r) {
            let part =
                |kind, id: &str, name: String, lt: Option<String>, rt: Option<String>, same| Item {
                    id: format!("{id}:{table}.{name}"),
                    kind,
                    table: Some(table.clone()),
                    state: state_of(lt.is_some(), rt.is_some(), same),
                    name,
                    left: lt,
                    right: rt,
                };
            for (name, lc, rc) in paired(&l.columns, &r.columns, |c| c.name.clone()) {
                let same = matches!((lc, rc), (Some(a), Some(b)) if column_same(a, b, ls, rs));
                parts.push(part(
                    ItemKind::Column,
                    "column",
                    name,
                    lc.map(column_line),
                    rc.map(column_line),
                    same,
                ));
            }
            if l.pk != r.pk {
                let text = |pk: &[String]| {
                    (!pk.is_empty()).then(|| format!("PRIMARY KEY ({})", pk.join(", ")))
                };
                parts.push(Item {
                    id: format!("pk:{table}"),
                    kind: ItemKind::PrimaryKey,
                    table: Some(table.clone()),
                    name: "PRIMARY KEY".to_owned(),
                    state: state_of(!l.pk.is_empty(), !r.pk.is_empty(), false),
                    left: text(&l.pk),
                    right: text(&r.pk),
                });
            }
            // an index is what it does, a key where it points, a check what it says – not its name,
            // which the database often made up
            let li: Vec<(String, &Index)> = l
                .indexes
                .iter()
                .map(|i| (index_sign(i, &table, ls), i))
                .collect();
            let ri: Vec<(String, &Index)> = r
                .indexes
                .iter()
                .map(|i| (index_sign(i, &table, rs), i))
                .collect();
            for (sign, a, b) in paired(&li, &ri, |x| x.0.clone()) {
                let shown = a.or(b).map_or(sign, |x| x.1.name.clone());
                parts.push(part(
                    ItemKind::Index,
                    "index",
                    shown,
                    a.map(|x| squeeze(&index_text(x.1, &table))),
                    b.map(|x| squeeze(&index_text(x.1, &table))),
                    true,
                ));
            }
            for (sign, a, b) in paired(&l.keys, &r.keys, key_text) {
                let shown = a.or(b).map_or(sign.clone(), |k| k.name.clone());
                parts.push(part(
                    ItemKind::Key,
                    "key",
                    shown,
                    a.map(key_text),
                    b.map(key_text),
                    true,
                ));
            }
            let lc: Vec<(String, &Named)> = l
                .checks
                .iter()
                .map(|c| (norm_text(&c.text, ls), c))
                .collect();
            let rc: Vec<(String, &Named)> = r
                .checks
                .iter()
                .map(|c| (norm_text(&c.text, rs), c))
                .collect();
            for (sign, a, b) in paired(&lc, &rc, |x| x.0.clone()) {
                let shown = a.or(b).map_or(sign, |x| x.1.name.clone());
                parts.push(part(
                    ItemKind::Check,
                    "check",
                    shown,
                    a.map(|x| squeeze(&x.1.text)),
                    b.map(|x| squeeze(&x.1.text)),
                    true,
                ));
            }
        }
        let same = parts.iter().all(|p| p.state == State::Same);
        out.push(Item {
            id: format!("table:{table}"),
            kind: ItemKind::Table,
            table: None,
            name: table.clone(),
            state: state_of(l.is_some(), r.is_some(), same),
            left: l.map(table_text),
            right: r.map(table_text),
        });
        out.extend(parts.into_iter().filter(|p| p.state != State::Same));
    }
    let named = |kind, id: &str, l: &[Named], r: &[Named], out: &mut Vec<Item>| {
        for (name, a, b) in paired(l, r, |n| n.name.clone()) {
            let same = matches!((a, b), (Some(a), Some(b)) if norm_text(&a.text, ls) == norm_text(&b.text, rs));
            out.push(Item {
                id: format!("{id}:{name}"),
                kind,
                table: None,
                name,
                state: state_of(a.is_some(), b.is_some(), same),
                left: a.map(|n| n.text.clone()),
                right: b.map(|n| n.text.clone()),
            });
        }
    };
    named(ItemKind::View, "view", &left.views, &right.views, &mut out);
    named(
        ItemKind::Routine,
        "routine",
        &left.routines,
        &right.routines,
        &mut out,
    );
    named(
        ItemKind::Trigger,
        "trigger",
        &left.triggers,
        &right.triggers,
        &mut out,
    );
    Ok(out)
}

// --- the script -------------------------------------------------------------------------------------

/// Whether changing a column from one type to another may lose what is in it: anything but a known
/// widening.
pub fn narrows(from: &str, to: &str) -> bool {
    let (from, to) = (norm_type(from), norm_type(to));
    if from == to {
        return false;
    }
    let split = |t: &str| -> (String, Vec<u32>) {
        match t.find('(') {
            Some(at) => (
                t[..at].to_owned(),
                t[at + 1..]
                    .trim_end_matches(')')
                    .split(',')
                    .filter_map(|n| n.trim().parse().ok())
                    .collect(),
            ),
            None => (t.to_owned(), Vec::new()),
        }
    };
    let (fb, fs) = split(&from);
    let (tb, ts) = split(&to);
    // MySQL: with and without a sign are two ranges
    if from.ends_with(" unsigned") != to.ends_with(" unsigned") {
        return true;
    }
    let (fb, tb) = (
        fb.trim_end_matches(" unsigned").to_owned(),
        tb.trim_end_matches(" unsigned").to_owned(),
    );
    let whole = ["smallint", "mediumint", "integer", "bigint"];
    if let (Some(a), Some(b)) = (
        whole.iter().position(|w| *w == fb),
        whole.iter().position(|w| *w == tb),
    ) {
        return b < a;
    }
    let text = |b: &str| matches!(b, "varchar" | "char" | "nvarchar" | "nchar");
    if text(&fb) && matches!(tb.as_str(), "text" | "longtext" | "mediumtext" | "clob") {
        return false;
    }
    if fb == tb && (text(&fb) || fb == "numeric") {
        // no size on the new side means no limit (PostgreSQL); every number must not shrink
        // a size that could not be read (`varchar(40)[]`) is none we know
        if to.matches('(').count() != usize::from(!ts.is_empty()) || to.ends_with(']') {
            return true;
        }
        return match (fs.as_slice(), ts.as_slice()) {
            ([], []) => false,
            // no size on the new side: no limit in PostgreSQL, but `decimal(18,0)` and one character
            // elsewhere – and here nobody knows which database it is. Said, rather than not.
            (_, []) => true,
            ([], _) => true,
            // a number: the digits before the point must not get fewer either
            ([fp, fsc], [tp, tsc]) if fb == "numeric" => {
                tp < fp || tsc < fsc || tp.saturating_sub(*tsc) < fp.saturating_sub(*fsc)
            }
            (f, t) => f.len() != t.len() || f.iter().zip(t).any(|(a, b)| b < a),
        };
    }
    true
}

struct Writer<'a> {
    kind: DbKind,
    source: &'a Snapshot,
    target_schema: &'a str,
}

impl Writer<'_> {
    fn q(&self, raw: &str) -> AppResult<String> {
        // a name with a line break (of any kind) would end the comment a step may stand in
        if raw
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{85}'))
        {
            return Err(invalid(
                "a name holds a control character: no script is written for it",
            ));
        }
        name(raw, self.kind)
    }

    fn table(&self, table: &str) -> AppResult<String> {
        if self.kind.is_sqlite() || self.target_schema.is_empty() {
            self.q(table)
        } else {
            Ok(format!(
                "{}.{}",
                self.q(self.target_schema)?,
                self.q(table)?
            ))
        }
    }

    fn list(&self, columns: &[String]) -> AppResult<String> {
        Ok(columns
            .iter()
            .map(|c| self.q(c))
            .collect::<AppResult<Vec<_>>>()?
            .join(", "))
    }

    /// A text of the source as it reads in the target: names that carried the source's schema carry
    /// the target's.
    fn moved(&self, text: &str) -> String {
        let from = &self.source.schema;
        if from.is_empty() || from == self.target_schema || self.kind.is_sqlite() {
            return text.to_owned();
        }
        let to = match name(self.target_schema, self.kind) {
            Ok(quoted) => format!("{quoted}."),
            Err(_) => return text.to_owned(),
        };
        // also inside the text of a default: `nextval('dev.seq'::regclass)`
        replaced_schema(text, from, &to)
            .replace(&format!("'{from}."), &format!("'{}.", self.target_schema))
    }

    fn column(&self, c: &Column) -> AppResult<String> {
        Ok(format!(
            "{} {}{}{}",
            self.q(&c.name)?,
            c.type_name,
            c.default
                .as_deref()
                .map(|d| format!(" DEFAULT {}", self.moved(d)))
                .unwrap_or_default(),
            if c.nullable { "" } else { " NOT NULL" },
        ))
    }

    fn create_table(&self, t: &Table) -> AppResult<String> {
        if let Some(definition) = &t.definition {
            return Ok(format!("{};", definition.trim().trim_end_matches(';')));
        }
        let mut lines = t
            .columns
            .iter()
            .map(|c| Ok(format!("  {}", self.column(c)?)))
            .collect::<AppResult<Vec<_>>>()?;
        if !t.pk.is_empty() {
            lines.push(format!("  PRIMARY KEY ({})", self.list(&t.pk)?));
        }
        for c in &t.checks {
            // with its name: a check the database names itself is another one when read again
            lines.push(if c.name.is_empty() {
                format!("  {}", self.check_clause(c))
            } else {
                format!("  CONSTRAINT {} {}", self.q(&c.name)?, self.check_clause(c))
            });
        }
        if self.kind.is_sqlite() {
            // SQLite cannot add a key afterwards
            for k in &t.keys {
                lines.push(format!("  {}", self.key_clause(k)?));
            }
        }
        Ok(format!(
            "CREATE TABLE {} (\n{}\n);",
            self.table(&t.name)?,
            lines.join(",\n")
        ))
    }

    /// `CHECK (…)` as a clause: PostgreSQL gives the word with the definition, the others only what
    /// is checked.
    fn check_clause(&self, c: &Named) -> String {
        let text = self.moved(c.text.trim());
        if text.to_ascii_uppercase().starts_with("CHECK") {
            text
        } else if text.starts_with('(') {
            format!("CHECK {text}")
        } else {
            format!("CHECK ({text})")
        }
    }

    fn create_index(&self, table: &str, i: &Index) -> AppResult<String> {
        // an index on an expression the database named no column for
        if i.definition.is_none()
            && (i.columns.is_empty() || i.columns.iter().any(String::is_empty))
        {
            return Ok(note(&format!(
                "{table}: the index {} is on an expression – create it by hand",
                i.name
            )));
        }
        if let Some(definition) = &i.definition {
            return Ok(format!(
                "{};",
                self.moved(definition.trim().trim_end_matches(';'))
            ));
        }
        Ok(format!(
            "CREATE {}INDEX {} ON {} ({});",
            if i.unique { "UNIQUE " } else { "" },
            self.q(&i.name)?,
            self.table(table)?,
            self.list(&i.columns)?
        ))
    }

    fn drop_index(&self, table: &str, i: &Index) -> AppResult<String> {
        Ok(match self.kind {
            DbKind::Postgres => format!(
                "DROP INDEX {}.{};",
                self.q(self.target_schema)?,
                self.q(&i.name)?
            ),
            DbKind::Sqlite | DbKind::Libsql | DbKind::D1 => {
                format!("DROP INDEX {};", self.q(&i.name)?)
            }
            _ => format!("DROP INDEX {} ON {};", self.q(&i.name)?, self.table(table)?),
        })
    }

    /// The first argument of `sp_rename`: every part in brackets (a name may hold a dot), the whole as
    /// the text of a string.
    fn rename_path(&self, parts: &[&str]) -> AppResult<String> {
        let mut quoted = Vec::new();
        for part in parts {
            // checked like every name, then always in brackets
            self.q(part)?;
            quoted.push(super::meta::quote_always(part, self.kind));
        }
        Ok(quoted.join(".").replace('\'', "''"))
    }

    /// A foreign key as a clause of `CREATE TABLE`.
    fn key_clause(&self, k: &Key) -> AppResult<String> {
        let target = if k.ref_schema.is_empty() {
            self.table(&k.ref_table)?
        } else {
            format!("{}.{}", self.q(&k.ref_schema)?, self.q(&k.ref_table)?)
        };
        Ok(format!(
            "FOREIGN KEY ({}) REFERENCES {} ({})",
            self.list(&k.columns)?,
            target,
            self.list(&k.ref_columns)?
        ))
    }

    fn add_key(&self, table: &str, k: &Key) -> AppResult<String> {
        let target = if k.ref_schema.is_empty() {
            self.table(&k.ref_table)?
        } else {
            format!("{}.{}", self.q(&k.ref_schema)?, self.q(&k.ref_table)?)
        };
        Ok(format!(
            "ALTER TABLE {} ADD {}FOREIGN KEY ({}) REFERENCES {} ({});",
            self.table(table)?,
            if k.name.is_empty() || k.name.starts_with("fk") && self.kind.is_sqlite() {
                String::new()
            } else {
                format!("CONSTRAINT {} ", self.q(&k.name)?)
            },
            self.list(&k.columns)?,
            target,
            self.list(&k.ref_columns)?
        ))
    }

    fn drop_constraint(&self, table: &str, constraint: &str, foreign: bool) -> AppResult<String> {
        let word = match (self.kind, foreign) {
            (DbKind::Mysql, true) => "FOREIGN KEY",
            // a check: `DROP CONSTRAINT` is what both MariaDB and MySQL (from 8.0.19) understand –
            // MariaDB has no `DROP CHECK`
            _ => "CONSTRAINT",
        };
        Ok(format!(
            "ALTER TABLE {} DROP {word} {};",
            self.table(table)?,
            self.q(constraint)?
        ))
    }
}

/// A comment for the script: on one line, nothing in it ends the comment.
fn note(text: &str) -> String {
    format!("-- {}", text.replace(['\n', '\r'], " "))
}

/// Every line of a statement as a comment that says „danger“.
fn danger(sql: &str, why: &str) -> String {
    let mut out = format!("-- {}:\n", why.replace(['\n', '\r'], " "));
    for line in sql.split(['\n', '\r', '\u{2028}', '\u{2029}', '\u{85}']) {
        if line.is_empty() {
            continue;
        }
        out.push_str(DANGER);
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_owned()
}

/// The script that makes `target` like `source`, for the differences in `picks` (`None`: all). Steps
/// that may lose data are comments (they start with [`DANGER`]); what cannot be written for this
/// database is said in a comment. The app never runs it.
pub fn script(
    source: &Snapshot,
    target: &Snapshot,
    picks: Option<&[String]>,
    renames: &[Rename],
) -> AppResult<String> {
    let steps = grouped(source, target, picks, renames)?;
    let kind = source.kind;
    Ok(written(source, target, kind, &steps))
}

const RENAME: usize = 0;
const UNLINK: usize = 1;
const CREATE: usize = 2;
const COLUMNS: usize = 3;
const INDEXES: usize = 4;
const CHECKS: usize = 5;
const LINK: usize = 6;
const CODE: usize = 7;
const DROP_CODE: usize = 8;
const DROP: usize = 9;
// indexes go after the keys that may need them
const UNINDEX: usize = 10;
/// The groups of steps in the order they are written and run.
const ORDER: [(usize, &str); 11] = [
    (RENAME, "renames"),
    (UNLINK, "keys and checks that go or change"),
    (UNINDEX, "indexes that go or change"),
    (CREATE, "new tables"),
    (COLUMNS, "columns"),
    (INDEXES, "indexes"),
    (CHECKS, "primary keys and checks"),
    (LINK, "foreign keys"),
    (CODE, "views, routines, triggers"),
    (
        DROP_CODE,
        "views, routines and triggers that are only in the target",
    ),
    (DROP, "columns and tables that are only in the target"),
];

/// One step of a migration, apart from the script (prompt 043: the structure editor shows and runs them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptStep {
    /// The statement; empty for a remark that is no statement.
    pub sql: String,
    /// Why the step may lose data; `None`: it does not.
    pub danger: Option<String>,
    /// What the script says instead of a statement (the database cannot do it this way).
    pub note: Option<String>,
}

/// The steps of [`script`] one by one, in the order they run, the dangerous ones told apart.
pub fn script_steps(
    source: &Snapshot,
    target: &Snapshot,
    renames: &[Rename],
) -> AppResult<Vec<ScriptStep>> {
    let steps = grouped(source, target, None, renames)?;
    Ok(ORDER
        .iter()
        .flat_map(|(group, _)| steps[*group].iter().flat_map(|entry| step_of(entry)))
        .collect())
}

/// An entry of the script as steps: a statement, a statement that is commented out as dangerous (with
/// its reason in the line before), or a remark.
fn step_of(entry: &str) -> Vec<ScriptStep> {
    let mut out = Vec::new();
    let mut remark: Vec<&str> = Vec::new();
    let mut dangerous: Vec<&str> = Vec::new();
    let mut plain: Vec<&str> = Vec::new();
    for line in entry.lines() {
        if let Some(sql) = line.strip_prefix(DANGER) {
            dangerous.push(sql);
        } else if plain.is_empty() && dangerous.is_empty() && line.starts_with("-- ") {
            remark.push(&line[3..]);
        } else {
            plain.push(line);
        }
    }
    let said = remark.join(" ");
    if !dangerous.is_empty() {
        out.push(ScriptStep {
            sql: dangerous.join("\n"),
            danger: Some(said.trim_end_matches(':').to_owned()),
            note: None,
        });
    } else if plain.iter().all(|l| l.trim().is_empty()) {
        if !said.is_empty() {
            out.push(ScriptStep {
                sql: String::new(),
                danger: None,
                note: Some(said),
            });
        }
        return out;
    }
    let sql = plain.join("\n");
    if !sql.trim().is_empty() {
        out.push(ScriptStep {
            sql: sql.trim().to_owned(),
            danger: None,
            note: (dangerous.is_empty() && !said.is_empty()).then_some(said),
        });
    }
    out
}

/// The steps of a migration by group (see [`ORDER`]).
fn grouped(
    source: &Snapshot,
    target: &Snapshot,
    picks: Option<&[String]>,
    renames: &[Rename],
) -> AppResult<[Vec<String>; 11]> {
    let items = compare(source, target, renames)?;
    let kind = source.kind;
    let w = Writer {
        kind,
        source,
        target_schema: &target.schema,
    };
    let now = renamed(target, renames);
    let picked = |id: &str| picks.is_none_or(|p| p.iter().any(|x| x == id));
    let table_of = |snap: &'_ Snapshot, t: &str| snap.tables.iter().find(|x| x.name == t).cloned();
    let mut steps: [Vec<String>; 11] = Default::default();

    // every name of a rename goes into a statement: checked like every other name
    for r in renames {
        w.q(&r.from)?;
        w.q(&r.to)?;
        if let Some(table) = &r.table {
            w.q(table)?;
        }
    }
    // columns first – while their table still has the name the user told them with
    let ordered = renames
        .iter()
        .filter(|r| r.table.is_some())
        .chain(renames.iter().filter(|r| r.table.is_none()));
    for r in ordered {
        let sql = match (&r.table, kind) {
            (None, DbKind::Sqlserver) => format!(
                "EXEC sp_rename '{}', '{}';",
                w.rename_path(&[&target.schema, &r.from])?,
                r.to.replace('\'', "''")
            ),
            (None, DbKind::Mysql) => {
                format!("RENAME TABLE {} TO {};", w.table(&r.from)?, w.table(&r.to)?)
            }
            (None, _) => format!(
                "ALTER TABLE {} RENAME TO {};",
                w.table(&r.from)?,
                w.q(&r.to)?
            ),
            (Some(table), DbKind::Sqlserver) => format!(
                "EXEC sp_rename '{}', '{}', 'COLUMN';",
                w.rename_path(&[&target.schema, table, &r.from])?,
                r.to.replace('\'', "''")
            ),
            (Some(table), _) => format!(
                "ALTER TABLE {} RENAME COLUMN {} TO {};",
                w.table(table)?,
                w.q(&r.from)?,
                w.q(&r.to)?
            ),
        };
        steps[RENAME].push(sql);
    }

    for item in items
        .iter()
        .filter(|i| i.state != State::Same && picked(&i.id))
    {
        let in_source = item.state != State::OnlyRight;
        let in_target = item.state != State::OnlyLeft;
        match item.kind {
            ItemKind::Table => {
                if item.state == State::OnlyLeft {
                    let Some(t) = table_of(source, &item.name) else {
                        continue;
                    };
                    steps[CREATE].push(w.create_table(&t)?);
                    for i in &t.indexes {
                        steps[INDEXES].push(w.create_index(&t.name, i)?);
                    }
                    // (a table created from its own statement has its keys in it)
                    for k in t
                        .keys
                        .iter()
                        .filter(|_| t.definition.is_none() && !kind.is_sqlite())
                    {
                        steps[LINK].push(w.add_key(&t.name, k)?);
                    }
                } else if item.state == State::OnlyRight {
                    // keys of other tables that point to it are differences of their own (they are
                    // dropped above, when chosen): said here, not dropped twice
                    let pointing: Vec<&str> = now
                        .tables
                        .iter()
                        .filter(|other| other.name != item.name)
                        .filter(|other| {
                            other
                                .keys
                                .iter()
                                .any(|k| k.ref_schema.is_empty() && k.ref_table == item.name)
                        })
                        .map(|other| other.name.as_str())
                        .collect();
                    if !pointing.is_empty() {
                        steps[DROP].push(note(&format!(
                            "{}: keys of {} point to it and must be dropped first",
                            item.name,
                            pointing.join(", ")
                        )));
                    }
                    steps[DROP].push(danger(
                        &format!("DROP TABLE {};", w.table(&item.name)?),
                        "drops the table and every row in it",
                    ));
                }
            }
            ItemKind::Column => {
                let Some(table) = item.table.as_deref() else {
                    continue;
                };
                let column = |snap: &Snapshot| -> Option<Column> {
                    snap.tables
                        .iter()
                        .find(|t| t.name == table)?
                        .columns
                        .iter()
                        .find(|c| c.name == item.name)
                        .cloned()
                };
                match (
                    column(source).filter(|_| in_source),
                    column(&now).filter(|_| in_target),
                ) {
                    (Some(new), None) => {
                        let sql = format!(
                            "ALTER TABLE {} ADD {}{};",
                            w.table(table)?,
                            if kind == DbKind::Sqlserver {
                                ""
                            } else {
                                "COLUMN "
                            },
                            w.column(&new)?
                        );
                        steps[COLUMNS].push(if !new.nullable && new.default.is_none() {
                            danger(&sql, "fails if the table has rows: a column without NULL and without a default")
                        } else {
                            sql
                        });
                    }
                    (None, Some(_)) => steps[DROP].push(danger(
                        &format!(
                            "ALTER TABLE {} DROP COLUMN {};",
                            w.table(table)?,
                            w.q(&item.name)?
                        ),
                        "drops the column and what is in it",
                    )),
                    (Some(new), Some(old)) => {
                        let retyped = norm_type(&new.type_name) != norm_type(&old.type_name);
                        let narrowing = retyped && narrows(&old.type_name, &new.type_name);
                        let stricter = old.nullable && !new.nullable;
                        let why = match (narrowing, stricter) {
                            (true, _) => "the new type may not hold what is in the column",
                            (_, true) => "fails if a row has no value in the column",
                            _ => "",
                        };
                        let t = w.table(table)?;
                        let c = w.q(&item.name)?;
                        let mut sqls: Vec<String> = Vec::new();
                        // MySQL states a column anew: what the snapshot does not know of it is gone
                        let mut restated = false;
                        match kind {
                            DbKind::Postgres => {
                                if retyped {
                                    sqls.push(format!(
                                        "ALTER TABLE {t} ALTER COLUMN {c} TYPE {};",
                                        new.type_name
                                    ));
                                }
                                if old.nullable != new.nullable {
                                    sqls.push(format!(
                                        "ALTER TABLE {t} ALTER COLUMN {c} {} NOT NULL;",
                                        if new.nullable { "DROP" } else { "SET" }
                                    ));
                                }
                                if norm_default(old.default.as_deref(), &target.schema)
                                    != norm_default(new.default.as_deref(), &source.schema)
                                {
                                    sqls.push(match &new.default {
                                        Some(d) => format!(
                                            "ALTER TABLE {t} ALTER COLUMN {c} SET DEFAULT {};",
                                            w.moved(d)
                                        ),
                                        None => {
                                            format!("ALTER TABLE {t} ALTER COLUMN {c} DROP DEFAULT;")
                                        }
                                    });
                                }
                            }
                            DbKind::Mysql if !retyped && old.nullable == new.nullable => {
                                sqls.push(match &new.default {
                                    Some(d) => format!(
                                        "ALTER TABLE {t} ALTER COLUMN {c} SET DEFAULT {};",
                                        w.moved(d)
                                    ),
                                    None => format!("ALTER TABLE {t} ALTER COLUMN {c} DROP DEFAULT;"),
                                });
                            }
                            DbKind::Mysql => {
                                restated = true;
                                sqls.push(format!(
                                    "ALTER TABLE {t} MODIFY COLUMN {};",
                                    w.column(&new)?
                                ));
                            }
                            DbKind::Sqlserver => {
                                if retyped || old.nullable != new.nullable {
                                    sqls.push(format!(
                                        "ALTER TABLE {t} ALTER COLUMN {c} {}{};",
                                        new.type_name,
                                        if new.nullable { " NULL" } else { " NOT NULL" }
                                    ));
                                }
                                if norm_default(old.default.as_deref(), &target.schema)
                                    != norm_default(new.default.as_deref(), &source.schema)
                                {
                                    if old.default.is_some() {
                                        sqls.push(note(&format!(
                                            "{}.{}: drop its default constraint first (its name is the server's)",
                                            table, item.name
                                        )));
                                    }
                                    if let Some(d) = &new.default {
                                        sqls.push(format!(
                                            "ALTER TABLE {t} ADD DEFAULT {} FOR {c};",
                                            w.moved(d)
                                        ));
                                    }
                                }
                            }
                            DbKind::Oracle | DbKind::Duckdb | DbKind::Clickhouse | DbKind::Trino | DbKind::Firebird => {
                                return Err(super::not_yet(kind, "schema compare and structure editing"));
                            }
                            DbKind::Sqlite | DbKind::Libsql | DbKind::D1 => sqls.push(note(&format!(
                                "{}.{}: SQLite cannot change a column – the table must be rebuilt ({} → {})",
                                table,
                                item.name,
                                column_line(&old),
                                column_line(&new)
                            ))),
                        }
                        let sql = sqls.join("\n");
                        let why = if why.is_empty() && restated {
                            "states the column anew: its auto_increment, comment and collation are not kept"
                        } else {
                            why
                        };
                        if !sql.is_empty() {
                            steps[COLUMNS].push(if why.is_empty() || kind.is_sqlite() {
                                sql
                            } else {
                                danger(&sql, why)
                            });
                        }
                    }
                    (None, None) => {}
                }
            }
            ItemKind::PrimaryKey => {
                let Some(table) = item.table.as_deref() else {
                    continue;
                };
                let pk = table_of(source, table).map(|t| t.pk).unwrap_or_default();
                if item.state == State::OnlyLeft && !kind.is_sqlite() {
                    steps[CHECKS].push(format!(
                        "ALTER TABLE {} ADD PRIMARY KEY ({});",
                        w.table(table)?,
                        w.list(&pk)?
                    ));
                } else {
                    steps[CHECKS].push(note(&format!(
                        "{table}: the primary key differs ({} → {}) – change it by hand",
                        item.right.as_deref().unwrap_or("none"),
                        item.left.as_deref().unwrap_or("none")
                    )));
                }
            }
            ItemKind::Index => {
                let Some(table) = item.table.as_deref() else {
                    continue;
                };
                let find = |snap: &Snapshot, text: &Option<String>| -> Option<Index> {
                    let text = text.as_deref()?;
                    snap.tables
                        .iter()
                        .find(|t| t.name == table)?
                        .indexes
                        .iter()
                        .find(|i| squeeze(&index_text(i, table)) == text)
                        .cloned()
                };
                if in_target && let Some(old) = find(&now, &item.right) {
                    steps[UNINDEX].push(w.drop_index(table, &old)?);
                }
                if in_source && let Some(new) = find(source, &item.left) {
                    steps[INDEXES].push(w.create_index(table, &new)?);
                }
            }
            ItemKind::Key => {
                let Some(table) = item.table.as_deref() else {
                    continue;
                };
                let find = |snap: &Snapshot, text: &Option<String>| -> Option<Key> {
                    let text = text.as_deref()?;
                    snap.tables
                        .iter()
                        .find(|t| t.name == table)?
                        .keys
                        .iter()
                        .find(|k| key_text(k) == text)
                        .cloned()
                };
                if in_target && let Some(old) = find(&now, &item.right) {
                    steps[UNLINK].push(if kind.is_sqlite() {
                        note(&format!(
                            "{table}: SQLite cannot drop a key – the table must be rebuilt"
                        ))
                    } else {
                        w.drop_constraint(table, &old.name, true)?
                    });
                }
                if in_source && let Some(new) = find(source, &item.left) {
                    steps[LINK].push(if kind.is_sqlite() {
                        note(&format!(
                            "{table}: SQLite cannot add a key to a table that exists ({})",
                            key_text(&new)
                        ))
                    } else {
                        w.add_key(table, &new)?
                    });
                }
            }
            ItemKind::Check => {
                let Some(table) = item.table.as_deref() else {
                    continue;
                };
                if kind.is_sqlite() {
                    steps[CHECKS].push(note(&format!(
                        "{table}: SQLite cannot change the checks of a table that exists"
                    )));
                    continue;
                }
                if in_target {
                    steps[UNLINK].push(w.drop_constraint(table, &item.name, false)?);
                }
                if in_source
                    && let Some(t) = table_of(source, table)
                    && let Some(c) = t
                        .checks
                        .iter()
                        .find(|c| Some(squeeze(&c.text)) == item.left)
                {
                    steps[CHECKS].push(format!(
                        "ALTER TABLE {} ADD CONSTRAINT {} {};",
                        w.table(table)?,
                        w.q(&c.name)?,
                        w.check_clause(c)
                    ));
                }
            }
            ItemKind::View | ItemKind::Routine | ItemKind::Trigger => {
                let what = match item.kind {
                    ItemKind::View => "VIEW",
                    ItemKind::Routine => "routine",
                    _ => "TRIGGER",
                };
                if !in_source {
                    // only in the target: gone with its definition
                    let sql = match (item.kind, kind) {
                        (ItemKind::View, _) => format!("DROP VIEW {};", w.table(&item.name)?),
                        (ItemKind::Trigger, DbKind::Postgres) => match item.name.split_once('.') {
                            Some((table, trigger)) => {
                                format!("DROP TRIGGER {} ON {};", w.q(trigger)?, w.table(table)?)
                            }
                            None => format!("DROP TRIGGER {};", w.q(&item.name)?),
                        },
                        (ItemKind::Trigger, _) => format!(
                            "DROP TRIGGER {};",
                            w.table(item.name.rsplit('.').next().unwrap_or(&item.name))?
                        ),
                        _ => String::new(),
                    };
                    steps[DROP_CODE].push(if sql.is_empty() {
                        note(&format!(
                            "{what} {} is only in the target: drop it by hand (its arguments name it)",
                            item.name
                        ))
                    } else {
                        danger(&sql, "drops it with its definition")
                    });
                    continue;
                }
                let text = w.moved(item.left.as_deref().unwrap_or_default().trim());
                let text = text.trim_end_matches(';');
                let sql = match (item.kind, kind) {
                    (ItemKind::View, DbKind::Postgres | DbKind::Mysql) => Some(format!(
                        "CREATE OR REPLACE VIEW {} AS\n{text};",
                        w.table(&item.name)?
                    )),
                    (
                        ItemKind::View | ItemKind::Trigger,
                        DbKind::Sqlite | DbKind::Libsql | DbKind::D1,
                    ) => Some(format!(
                        "DROP {what} IF EXISTS {};\n{text};",
                        w.q(&item.name)?
                    )),
                    // the definition is the whole statement
                    (ItemKind::Routine, DbKind::Postgres) => Some(format!("{text};")),
                    (ItemKind::Trigger, DbKind::Postgres) => {
                        let drop = match (in_target, item.name.split_once('.')) {
                            (true, Some((table, trigger))) => {
                                format!("DROP TRIGGER {} ON {};\n", w.q(trigger)?, w.table(table)?)
                            }
                            _ => String::new(),
                        };
                        Some(format!("{drop}{text};"))
                    }
                    (_, DbKind::Sqlserver) => {
                        // `CREATE VIEW …` as the server keeps it; alone in its batch
                        let upper = text.to_ascii_uppercase();
                        let altered = match upper.find("CREATE ") {
                            Some(at) if !upper[at..].starts_with("CREATE OR ALTER") => {
                                format!("{}CREATE OR ALTER {}", &text[..at], &text[at + 7..])
                            }
                            _ => text.to_owned(),
                        };
                        Some(format!("GO\n{altered}\nGO"))
                    }
                    _ => None,
                };
                steps[CODE].push(sql.unwrap_or_else(|| {
                    note(&format!(
                        "{what} {} differs: this database does not give a statement that creates it",
                        item.name
                    ))
                }));
            }
        }
    }

    Ok(steps)
}

/// The script as text: what it is, then its steps by group.
fn written(
    source: &Snapshot,
    target: &Snapshot,
    kind: DbKind,
    steps: &[Vec<String>; 11],
) -> String {
    let mut out = vec![
        note(&format!(
            "Makes {} like {} ({}). A proposal: read it, change it, run it yourself.",
            if target.schema.is_empty() {
                "the target"
            } else {
                &target.schema
            },
            if source.schema.is_empty() {
                "the source"
            } else {
                &source.schema
            },
            match kind {
                DbKind::Postgres => "PostgreSQL",
                DbKind::Mysql => "MySQL / MariaDB",
                DbKind::Sqlserver => "SQL Server",
                DbKind::Sqlite | DbKind::Libsql | DbKind::D1 => "SQLite",
                DbKind::Oracle => "Oracle",
                DbKind::Duckdb => "DuckDB",
                DbKind::Clickhouse => "ClickHouse",
                DbKind::Trino => "Trino",
                DbKind::Firebird => "Firebird",
            }
        )),
        note(
            "Lines that start with „-- DANGER: “ may lose data; they run only when you remove that mark.",
        ),
        note(
            "Types, defaults and the texts of views, routines and triggers are written as the source \
             (a database, or a snapshot file) gave them. Not compared: rights, sequences, identity and \
             auto_increment, comments, collations, rules of keys (ON DELETE), materialized views.",
        ),
        String::new(),
    ];
    let mut any = false;
    for (group, title) in ORDER {
        if steps[group].is_empty() {
            continue;
        }
        any = true;
        out.push(note(title));
        out.extend(steps[group].iter().cloned());
        out.push(String::new());
    }
    if !any {
        out.push(note("Nothing to do: no difference was chosen."));
    }
    format!("{}\n", out.join("\n").trim_end())
}

/// The script with its dangerous steps switched on – for tests, and for nobody else.
pub fn with_danger(script: &str) -> String {
    script
        .lines()
        .map(|l| l.strip_prefix(DANGER).unwrap_or(l))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;
    use crate::db::{Limits, Session};

    fn col(name: &str, type_name: &str, nullable: bool, default: Option<&str>) -> Column {
        Column {
            name: name.into(),
            type_name: type_name.into(),
            nullable,
            default: default.map(str::to_owned),
        }
    }

    fn snap(kind: DbKind, schema: &str, tables: Vec<Table>) -> Snapshot {
        Snapshot {
            kind,
            schema: schema.into(),
            tables,
            views: Vec::new(),
            routines: Vec::new(),
            triggers: Vec::new(),
        }
    }

    fn orders() -> Table {
        Table {
            name: "orders".into(),
            columns: vec![
                col("id", "integer", false, None),
                col("customer_id", "integer", false, None),
                col("total", "numeric(12,2)", true, Some("0")),
                col("note", "character varying(40)", true, None),
            ],
            pk: vec!["id".into()],
            indexes: vec![Index {
                name: "orders_note".into(),
                unique: false,
                columns: vec!["note".into()],
                definition: None,
            }],
            keys: vec![Key {
                name: "orders_customer_id_fkey".into(),
                columns: vec!["customer_id".into()],
                ref_schema: String::new(),
                ref_table: "customer".into(),
                ref_columns: vec!["id".into()],
            }],
            checks: vec![Named {
                name: "orders_total_check".into(),
                text: "CHECK ((total >= (0)::numeric))".into(),
            }],
            comment: None,
            definition: None,
        }
    }

    fn customer() -> Table {
        Table {
            name: "customer".into(),
            columns: vec![
                col("id", "integer", false, None),
                col("name", "text", false, None),
            ],
            pk: vec!["id".into()],
            ..Table::default()
        }
    }

    fn states(items: &[Item]) -> Vec<String> {
        items
            .iter()
            .filter(|i| i.state != State::Same)
            .map(|i| format!("{} {:?}", i.id, i.state))
            .collect()
    }

    #[test]
    fn two_spellings_of_the_same_thing_are_no_difference() {
        for (a, b) in [
            ("int4", "INTEGER"),
            ("int(11)", "integer"),
            ("character varying(20)", "varchar(20)"),
            ("timestamp without time zone", "timestamp"),
            ("numeric(12, 2)", "decimal(12,2)"),
            ("bool", "boolean"),
            ("double precision", "float8"),
        ] {
            assert_eq!(norm_type(a), norm_type(b), "{a} / {b}");
        }
        assert_ne!(norm_type("varchar(20)"), norm_type("varchar(40)"));
        assert_ne!(norm_type("tinyint(1)"), norm_type("tinyint(4)"));
        // defaults: brackets of SQL Server, the cast of PostgreSQL, the schema in front of a name
        assert_eq!(norm_default(Some("((0))"), ""), Some("0".into()));
        assert_eq!(
            norm_default(Some("'x'::character varying"), ""),
            Some("'x'".into())
        );
        assert_eq!(
            norm_default(Some("nextval('a.seq'::regclass)"), "a"),
            norm_default(Some("nextval('seq'::regclass)"), "b")
        );
        assert_eq!(norm_default(Some("NULL"), ""), None);
        assert_eq!(
            norm_default(Some("(a) + (b)"), ""),
            Some("(a) + (b)".into())
        );
        // the same schema under two names, a key the database named, white space in a view
        let left = Snapshot {
            views: vec![Named {
                name: "big".into(),
                text: " SELECT id\n   FROM dev.orders\n  WHERE total > 100;".into(),
            }],
            ..snap(DbKind::Postgres, "dev", vec![customer(), orders()])
        };
        let mut other = orders();
        other.keys[0].name = "fk_rails_1234".into();
        other.indexes[0].name = "idx_other_name".into();
        other.checks[0].name = "chk_1".into();
        other.columns[0].type_name = "int4".into();
        other.columns[3].type_name = "varchar(40)".into();
        let right = Snapshot {
            views: vec![Named {
                name: "big".into(),
                text: "SELECT id FROM prod.orders WHERE total > 100".into(),
            }],
            ..snap(DbKind::Postgres, "prod", vec![customer(), other])
        };
        assert_eq!(
            states(&compare(&left, &right, &[]).unwrap()),
            Vec::<String>::new()
        );
        // two kinds of database are not compared
        let lite = snap(DbKind::Sqlite, "main", vec![]);
        assert_eq!(
            compare(&left, &lite, &[]).unwrap_err().code,
            ErrorCode::Unsupported
        );
    }

    #[test]
    fn says_what_is_only_on_one_side_and_what_differs() {
        let left = snap(DbKind::Postgres, "a", vec![customer(), orders()]);
        let mut changed = orders();
        changed.columns[2].type_name = "numeric(10,2)".into();
        changed.columns[3].nullable = false;
        changed.columns.push(col("legacy", "text", true, None));
        changed.columns.remove(1);
        changed.keys.clear();
        changed.indexes[0].columns = vec!["note".into(), "total".into()];
        let right = Snapshot {
            views: vec![Named {
                name: "old_view".into(),
                text: "SELECT 1".into(),
            }],
            ..snap(
                DbKind::Postgres,
                "a",
                vec![
                    changed,
                    Table {
                        name: "audit".into(),
                        columns: vec![col("id", "integer", false, None)],
                        ..Table::default()
                    },
                ],
            )
        };
        let items = compare(&left, &right, &[]).unwrap();
        assert_eq!(
            states(&items),
            [
                "table:audit OnlyRight",
                "table:customer OnlyLeft",
                "table:orders Different",
                "column:orders.customer_id OnlyLeft",
                "column:orders.legacy OnlyRight",
                "column:orders.note Different",
                "column:orders.total Different",
                "index:orders.orders_note OnlyLeft",
                "index:orders.orders_note OnlyRight",
                "key:orders.orders_customer_id_fkey OnlyLeft",
                "view:old_view OnlyRight"
            ]
        );
        let total = items
            .iter()
            .find(|i| i.id == "column:orders.total")
            .unwrap();
        assert_eq!(total.left.as_deref(), Some("total numeric(12,2) DEFAULT 0"));
        assert_eq!(
            total.right.as_deref(),
            Some("total numeric(10,2) DEFAULT 0")
        );
        assert!(
            items[2]
                .left
                .as_deref()
                .unwrap()
                .starts_with("TABLE orders\n  id integer NOT NULL")
        );
    }

    #[test]
    fn knows_which_change_of_a_type_may_lose_data() {
        for (from, to) in [
            ("integer", "bigint"),
            ("smallint", "int4"),
            ("varchar(20)", "varchar(40)"),
            ("varchar(20)", "text"),
            ("numeric(10,2)", "numeric(12,2)"),
            ("int", "integer"),
        ] {
            assert!(!narrows(from, to), "{from} → {to}");
        }
        for (from, to) in [
            // review 043, H2: no size is no limit only in PostgreSQL – `decimal` is `decimal(18,0)`
            // and `varchar` one character elsewhere; which database it is, nobody knows here
            ("character varying(20)", "character varying"),
            ("decimal(12,4)", "decimal"),
            ("char(10)", "char"),
            ("bigint", "integer"),
            ("varchar(40)", "varchar(20)"),
            ("text", "varchar(20)"),
            ("numeric(12,2)", "numeric(12,0)"),
            ("character varying", "varchar(10)"),
            ("text", "integer"),
            ("timestamp", "date"),
        ] {
            assert!(narrows(from, to), "{from} → {to}");
        }
    }

    #[test]
    fn writes_a_script_in_an_order_that_holds_and_comments_what_may_lose_data() {
        // the source has a new table, a new column, a wider and a narrower type, a new key; the
        // target has a column and a table the source does not
        let mut new_orders = orders();
        new_orders
            .columns
            .push(col("state", "text", false, Some("'new'")));
        new_orders.columns.push(col("must", "integer", false, None));
        new_orders.columns[2].type_name = "numeric(8,2)".into();
        new_orders.columns[3].type_name = "character varying(80)".into();
        new_orders.columns[3].nullable = false;
        let source = Snapshot {
            views: vec![Named {
                name: "big".into(),
                text: "SELECT id FROM dev.orders WHERE total > 100".into(),
            }],
            ..snap(DbKind::Postgres, "dev", vec![customer(), new_orders])
        };
        let mut old_orders = orders();
        old_orders.keys.clear();
        old_orders.columns.push(col("legacy", "text", true, None));
        let target = snap(
            DbKind::Postgres,
            "prod",
            vec![
                old_orders,
                Table {
                    name: "audit".into(),
                    columns: vec![col("id", "integer", false, None)],
                    ..Table::default()
                },
            ],
        );
        let sql = script(&source, &target, None, &[]).unwrap();
        let line = |needle: &str| {
            sql.lines()
                .position(|l| l.contains(needle))
                .unwrap_or_else(|| panic!("no line with {needle} in\n{sql}"))
        };
        // the table a key points to exists before the key; the view after the tables
        assert!(
            line("CREATE TABLE prod.customer") < line("ADD CONSTRAINT orders_customer_id_fkey")
        );
        assert!(line("ADD COLUMN state") < line("CREATE OR REPLACE VIEW prod.big"));
        assert!(
            sql.contains("ALTER TABLE prod.orders ADD COLUMN state text DEFAULT 'new' NOT NULL;")
        );
        // names of the source's schema became the target's
        assert!(sql.contains("FROM prod.orders WHERE total > 100;"));
        assert!(!sql.contains("dev."));
        // every step that may lose data is a comment
        for dangerous in [
            "DROP TABLE prod.audit;",
            "ALTER TABLE prod.orders DROP COLUMN legacy;",
            "ALTER TABLE prod.orders ALTER COLUMN total TYPE numeric(8,2);",
            "ALTER TABLE prod.orders ALTER COLUMN note SET NOT NULL;",
            "ALTER TABLE prod.orders ADD COLUMN must integer NOT NULL;",
        ] {
            assert!(
                sql.lines().any(|l| l == format!("{DANGER}{dangerous}")),
                "{dangerous} is not a comment in\n{sql}"
            );
        }
        // … also when it stands in one step with a harmless change
        assert!(sql.lines().any(|l| l
            == format!(
                "{DANGER}ALTER TABLE prod.orders ALTER COLUMN note TYPE character varying(80);"
            )));
        assert!(
            sql.lines()
                .filter(|l| !l.starts_with("--"))
                .all(|l| !l.contains("DROP TABLE") && !l.contains("DROP COLUMN")),
            "{sql}"
        );
        // only what was picked
        let one = script(&source, &target, Some(&["column:orders.state".into()]), &[]).unwrap();
        assert_eq!(
            one.lines()
                .filter(|l| !l.starts_with("--") && !l.is_empty())
                .count(),
            1
        );
        assert!(
            script(&source, &source, None, &[])
                .unwrap()
                .contains("Nothing to do")
        );
        // with the danger switched on the statements are whole again
        assert!(
            with_danger(&sql)
                .lines()
                .any(|l| l == "DROP TABLE prod.audit;")
        );
    }

    #[test]
    fn a_rename_the_user_tells_is_no_drop_and_create() {
        let source = snap(DbKind::Postgres, "s", vec![customer()]);
        let mut old = customer();
        old.name = "client".into();
        old.columns[1].name = "label".into();
        let target = snap(DbKind::Postgres, "s", vec![old]);
        assert_eq!(
            states(&compare(&source, &target, &[]).unwrap()),
            ["table:client OnlyRight", "table:customer OnlyLeft"]
        );
        let renames = [
            Rename {
                table: None,
                from: "client".into(),
                to: "customer".into(),
            },
            Rename {
                table: Some("client".into()),
                from: "label".into(),
                to: "name".into(),
            },
        ];
        assert_eq!(
            states(&compare(&source, &target, &renames).unwrap()),
            Vec::<String>::new()
        );
        let sql = script(&source, &target, None, &renames).unwrap();
        assert!(sql.contains("ALTER TABLE s.client RENAME TO customer;"));
        assert!(sql.contains("ALTER TABLE s.client RENAME COLUMN label TO name;"));
        assert!(!sql.contains("DROP"));
    }

    #[test]
    fn nothing_in_a_snapshot_breaks_out_of_a_name_or_a_comment() {
        let evil = "x\"; DROP TABLE users; --";
        let source = snap(
            DbKind::Postgres,
            "s",
            vec![Table {
                name: evil.into(),
                columns: vec![col(evil, "text", true, None)],
                pk: vec![evil.into()],
                ..Table::default()
            }],
        );
        let target = Snapshot {
            views: vec![Named {
                name: "v".into(),
                text: "SELECT 1".into(),
            }],
            routines: vec![Named {
                name: "f\nDROP TABLE users;".into(),
                text: "x".into(),
            }],
            ..snap(DbKind::Postgres, "s", vec![])
        };
        let sql = script(&source, &target, None, &[]).unwrap();
        // the name is one quoted name wherever it stands
        assert!(sql.contains("CREATE TABLE s.\"x\"\"; DROP TABLE users; --\" ("));
        // a line break in a name ends no comment: no line of the script starts a statement of its own
        for l in sql.lines() {
            assert!(!l.trim_start().starts_with("DROP TABLE users"), "{sql}");
        }
        // a snapshot from a file is within the limits or refused
        let huge = snap(
            DbKind::Postgres,
            "s",
            vec![Table::default(); MAX_OBJECTS + 1],
        );
        assert!(compare(&huge, &target, &[]).is_err());
    }

    /// Applies a script statement by statement (SQLite needs no splitter for what the script holds).
    fn apply(s: &mut sqlite::Lite, sql: &str) {
        let runnable: String = sql
            .lines()
            .filter(|l| !l.trim_start().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");
        s.execute_batch_for_tests(&runnable);
    }

    #[test]
    fn a_script_applied_leaves_no_difference_in_sqlite() {
        let mut a = sqlite::open(&sqlite::demo_profile()).unwrap();
        let mut b = sqlite::open(&sqlite::demo_profile()).unwrap();
        let common = "CREATE TABLE c_author (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE c_old (id INTEGER PRIMARY KEY, gone TEXT);";
        a.execute_batch_for_tests(common);
        b.execute_batch_for_tests(common);
        // the source: a new table with a key, a new column with a default, an index, a view, a
        // trigger; the table and the column that are only in the target go
        a.execute_batch_for_tests(
            "DROP TABLE c_old;
             CREATE TABLE c_book (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES c_author (id),
               title TEXT DEFAULT 'untitled', price NUMERIC CHECK (price >= 0));
             ALTER TABLE c_author ADD COLUMN born TEXT DEFAULT '1900';
             CREATE INDEX c_author_name ON c_author (name);
             CREATE UNIQUE INDEX c_book_title ON c_book (title, author_id);
             CREATE VIEW c_titles AS SELECT title FROM c_book;
             CREATE TRIGGER c_touch AFTER UPDATE ON c_book BEGIN UPDATE c_book SET price = 0 WHERE id = new.id; END;",
        );
        b.execute_batch_for_tests("CREATE VIEW c_stale AS SELECT 1 AS one;");
        let only = |snap: Snapshot| Snapshot {
            tables: snap
                .tables
                .into_iter()
                .filter(|t| t.name.starts_with("c_"))
                .collect(),
            views: snap
                .views
                .into_iter()
                .filter(|v| v.name.starts_with("c_"))
                .collect(),
            triggers: snap
                .triggers
                .into_iter()
                .filter(|t| t.name.starts_with("c_"))
                .collect(),
            routines: Vec::new(),
            ..snap
        };
        let read =
            |s: &mut sqlite::Lite| only(snapshot(s, DbKind::Sqlite, "main", &|| false).unwrap());
        let source = read(&mut a);
        let target = read(&mut b);
        assert!(!states(&compare(&source, &target, &[]).unwrap()).is_empty());
        let sql = script(&source, &target, None, &[]).unwrap();
        // nothing that loses data runs unless it is switched on
        apply(&mut b, &sql);
        let left = states(&compare(&source, &read(&mut b), &[]).unwrap());
        assert_eq!(
            left,
            ["table:c_old OnlyRight", "view:c_stale OnlyRight"],
            "{sql}"
        );
        let after = read(&mut b);
        let rest = with_danger(&script(&source, &after, None, &[]).unwrap());
        apply(&mut b, &rest);
        assert_eq!(
            states(&compare(&source, &read(&mut b), &[]).unwrap()),
            Vec::<String>::new()
        );
        // the tables the script made hold rows like the source's
        b.execute_batch_for_tests(
            "INSERT INTO c_author (id, name) VALUES (1, 'a'); INSERT INTO c_book (id, author_id) VALUES (1, 1);",
        );
        let r = b
            .query(
                "SELECT title, born FROM c_book JOIN c_author ON c_author.id = author_id",
                Limits::rows(5),
                &|| false,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(&r.rows).unwrap(),
            serde_json::json!([["untitled", "1900"]])
        );
    }
    /// Review 038, H2: a line break of any kind in a name ends no comment.
    #[test]
    fn no_control_character_in_a_name_reaches_the_script() {
        for evil in [
            "v\rDROP TABLE users; --",
            "v\nDROP TABLE users; --",
            "v\u{2028}x",
            "v\tx",
        ] {
            let target = Snapshot {
                views: vec![Named {
                    name: evil.into(),
                    text: "SELECT 1".into(),
                }],
                ..snap(DbKind::Postgres, "s", vec![])
            };
            let source = snap(DbKind::Postgres, "s", vec![]);
            assert!(script(&source, &target, None, &[]).is_err(), "{evil:?}");
        }
        // and what stands behind the mark is a comment line by line, whatever ends a line
        let commented = danger("DROP TABLE a;\rDROP TABLE b;\nDROP TABLE c;", "why");
        assert_eq!(
            commented.lines().filter(|l| l.starts_with(DANGER)).count(),
            3
        );
        assert!(!commented.contains('\r'));
    }

    /// Review 038, H3: a table and one of its columns renamed – in either order of telling.
    #[test]
    fn renames_of_a_table_and_its_column_hold_in_either_order() {
        let source = snap(DbKind::Postgres, "s", vec![customer()]);
        let mut old = customer();
        old.name = "client".into();
        old.columns[1].name = "label".into();
        let target = snap(DbKind::Postgres, "s", vec![old]);
        let table = Rename {
            table: None,
            from: "client".into(),
            to: "customer".into(),
        };
        let column = Rename {
            table: Some("client".into()),
            from: "label".into(),
            to: "name".into(),
        };
        for renames in [
            vec![table.clone(), column.clone()],
            vec![column.clone(), table.clone()],
        ] {
            assert_eq!(
                states(&compare(&source, &target, &renames).unwrap()),
                Vec::<String>::new()
            );
            let sql = script(&source, &target, None, &renames).unwrap();
            let at = |needle: &str| {
                sql.find(needle)
                    .unwrap_or_else(|| panic!("{needle} in\n{sql}"))
            };
            // the column while the table still has its old name
            assert!(
                at("ALTER TABLE s.client RENAME COLUMN label TO name;")
                    < at("ALTER TABLE s.client RENAME TO customer;"),
                "{sql}"
            );
            assert!(
                !sql.contains("ADD COLUMN") && !sql.contains("DROP"),
                "{sql}"
            );
        }
    }

    /// Review 038, M1/M2/M6: what must not be called the same, or safe.
    #[test]
    fn differences_that_matter_are_seen() {
        // fewer digits before the point
        assert!(narrows("numeric(10,2)", "numeric(10,4)"));
        assert!(narrows("numeric(10,2)", "numeric(12,6)"));
        assert!(!narrows("numeric(10,2)", "numeric(12,4)"));
        // a size that is none we know
        assert!(narrows("varchar(20)", "varchar(40)[]"));
        // MySQL: unsigned is another type
        assert_ne!(norm_type("int(10) unsigned"), norm_type("int(11)"));
        assert_eq!(norm_type("int(10) unsigned"), norm_type("INT UNSIGNED"));
        assert!(narrows("int unsigned", "int"));
        // the name of the schema is taken away in front of names only
        assert_eq!(
            unqualified("SELECT orders.id FROM s.orders", "s"),
            "SELECT orders.id FROM orders"
        );
        assert_eq!(
            unqualified("SELECT \"s\".t.a, s.t.b", "s"),
            "SELECT t.a, t.b"
        );
        assert_eq!(
            unqualified("SELECT boss.id FROM ss.t boss", "s"),
            "SELECT boss.id FROM ss.t boss"
        );
        // a cast behind an expression says what the default is
        assert_ne!(
            norm_default(Some("(now())::date"), ""),
            norm_default(Some("(now())::time"), "")
        );
        assert_eq!(norm_default(Some("'x'::text"), ""), Some("'x'".into()));
    }

    /// Review 038, M3/M4: MySQL restates a whole column – that is said as a danger; what is dropped
    /// goes in an order that holds; a snapshot from a file is checked.
    #[test]
    fn steps_that_may_cost_something_are_marked_and_ordered() {
        let mut new = orders();
        new.columns[2].default = Some("1".into());
        new.columns[3].type_name = "varchar(80)".into();
        new.keys.clear();
        new.indexes.clear();
        let source = snap(DbKind::Mysql, "a", vec![customer(), new]);
        let target = snap(DbKind::Mysql, "a", vec![customer(), orders()]);
        let sql = script(&source, &target, None, &[]).unwrap();
        // only the default: said without restating the column
        assert!(
            sql.contains("ALTER TABLE `a`.`orders` ALTER COLUMN `total` SET DEFAULT 1;")
                || sql.contains("ALTER TABLE a.orders ALTER COLUMN total SET DEFAULT 1;"),
            "{sql}"
        );
        // the type: MODIFY restates the column, and that is marked
        assert!(
            sql.lines()
                .any(|l| l.starts_with(DANGER) && l.contains("MODIFY COLUMN")),
            "{sql}"
        );
        // the key goes before the index it may need
        let at = |needle: &str| {
            sql.find(needle)
                .unwrap_or_else(|| panic!("{needle} in\n{sql}"))
        };
        assert!(at("DROP FOREIGN KEY") < at("DROP INDEX"), "{sql}");
        // a type name from a file that is more than a type name is refused
        let mut evil = snap(DbKind::Postgres, "s", vec![customer()]);
        evil.tables[0].columns[0].type_name = "integer); DROP TABLE users; --".into();
        assert!(checked(&evil).is_err());
        let mut long = snap(DbKind::Postgres, "s", vec![customer()]);
        long.tables[0].columns[0].default = Some("x".repeat(100_000));
        assert!(checked(&long).is_err());
        // an index on an expression the database names no column for is left out, not an error
        let mut odd = orders();
        odd.indexes[0].columns = vec![String::new()];
        let with_odd = snap(DbKind::Mysql, "a", vec![customer(), odd]);
        assert!(
            script(
                &with_odd,
                &snap(DbKind::Mysql, "a", vec![customer()]),
                None,
                &[]
            )
            .is_ok()
        );
    }
}
