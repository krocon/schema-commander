//! Copying tables from one connection to another (prompt 045) – also across kinds of databases.
//!
//! - [`map_type`]: what a type of one dialect is in another, and what gets lost on the way.
//! - [`plan`]: for every table what happens in the target – created or used as it is, which columns go
//!   where, the statements – in an order in which a table comes after the tables it points to.
//! - [`copy_table`]: the rows as a stream. The source is read in a thread of its own and hands its rows
//!   through a queue of fixed length to the loader of the import (prompt 033), which writes them with
//!   bound values: when the target is slower, the source waits. Memory stays the same however many rows.
//!
//! Pure but for [`copy_table`] and [`run`].

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

use serde::{Deserialize, Serialize};

use super::compare::{self, Snapshot, Table};
use super::filter::ValueKind;
use super::load::{self, LoadPlan, Loaded, Mapping, OnError, Records, TargetColumn};
use super::value::{Cell, Column, RowSink};
use super::{DbKind, Limits, Session, Stop};
use crate::data_import::{NextRecord, Record};
use crate::error::{AppError, AppResult, ErrorCode};

/// Records that wait between the source and the target at most.
const QUEUE: usize = 2_000;
/// Characters of a row in the error file.
const RAW_CHARS: usize = 400;

/// What a type is, whatever a database calls it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    SmallInt,
    Int,
    BigInt,
    /// Precision and scale; `None`: as many digits as it takes.
    Numeric(Option<(u32, u32)>),
    Real,
    Double,
    Bool,
    Char(Option<u32>),
    Varchar(Option<u32>),
    Text,
    Date,
    Time,
    /// Date and time without a zone.
    Timestamp,
    /// An instant.
    TimestampTz,
    Json,
    Uuid,
    Bytes,
    /// Anything else (an array, an enum, a geometry …): copied as its text.
    Other,
}

/// The numbers in the brackets of a type: `numeric(12,2)` → `[12, 2]`.
fn sizes(type_name: &str) -> Vec<u32> {
    match (type_name.find('('), type_name.rfind(')')) {
        (Some(open), Some(close)) if open < close => type_name[open + 1..close]
            .split(',')
            .filter_map(|n| n.trim().parse().ok())
            .collect(),
        _ => Vec::new(),
    }
}

/// What a type of a database is.
pub fn class_of(kind: DbKind, type_name: &str) -> Class {
    let t = type_name.trim().to_ascii_lowercase();
    let size = sizes(&t);
    let first = size.first().copied();
    let unsigned = t.contains("unsigned");
    let base = t
        .split('(')
        .next()
        .unwrap_or_default()
        .replace(" unsigned", "")
        .trim()
        .to_owned();
    if t.ends_with("[]") {
        return Class::Other;
    }
    if kind == DbKind::Sqlite {
        // SQLite has affinities, not types: what the name holds decides
        return match base.as_str() {
            "boolean" | "bool" => Class::Bool,
            "date" => Class::Date,
            "datetime" | "timestamp" => Class::Timestamp,
            "json" => Class::Json,
            b if b.contains("int") => Class::BigInt,
            b if b.contains("char") || b.contains("clob") || b.contains("text") => Class::Text,
            b if b.contains("blob") => Class::Bytes,
            b if b.contains("real") || b.contains("floa") || b.contains("doub") => Class::Double,
            b if b.contains("num") || b.contains("dec") => Class::Numeric(None),
            // no type, or a name that says nothing (`STRING`, `UUID`): the column holds anything
            _ => Class::Other,
        };
    }
    if kind == DbKind::Duckdb {
        return match base.as_str() {
            "tinyint" | "smallint" | "utinyint" => Class::SmallInt,
            "integer" | "int" | "usmallint" => Class::Int,
            "bigint" | "uinteger" => Class::BigInt,
            "ubigint" => Class::Numeric(Some((20, 0))),
            "hugeint" | "uhugeint" => Class::Numeric(Some((38, 0))),
            "decimal" | "numeric" => match size.as_slice() {
                [p, s] => Class::Numeric(Some((*p, *s))),
                [p] => Class::Numeric(Some((*p, 0))),
                _ => Class::Numeric(Some((18, 3))),
            },
            "float" | "real" => Class::Real,
            "double" => Class::Double,
            "boolean" => Class::Bool,
            "varchar" | "text" | "string" | "char" | "bpchar" => Class::Text,
            "date" => Class::Date,
            "time" => Class::Time,
            "timestamp" | "datetime" | "timestamp_s" | "timestamp_ms" | "timestamp_ns" => {
                Class::Timestamp
            }
            "timestamp with time zone" | "timestamptz" => Class::TimestampTz,
            "json" => Class::Json,
            "uuid" => Class::Uuid,
            "blob" | "bytea" | "binary" | "varbinary" => Class::Bytes,
            // a list, a struct, a map, an enum: copied as its text
            _ => Class::Other,
        };
    }
    if kind == DbKind::Oracle {
        return match base.as_str() {
            "number" | "numeric" | "decimal" => match size.as_slice() {
                [p, s] => Class::Numeric(Some((*p, *s))),
                [p] if *p <= 4 => Class::SmallInt,
                [p] if *p <= 9 => Class::Int,
                [p] if *p <= 18 => Class::BigInt,
                [p] => Class::Numeric(Some((*p, 0))),
                _ => Class::Numeric(None),
            },
            "integer" | "int" | "smallint" => Class::Numeric(Some((38, 0))),
            "float" | "binary_double" => Class::Double,
            "binary_float" => Class::Real,
            "boolean" => Class::Bool,
            "char" | "nchar" => Class::Char(first),
            "varchar2" | "nvarchar2" | "varchar" => Class::Varchar(first),
            "clob" | "nclob" | "long" => Class::Text,
            // an Oracle DATE has a time of day
            "date" => Class::Timestamp,
            "json" => Class::Json,
            "raw" | "blob" | "long raw" => Class::Bytes,
            b if b.starts_with("timestamp") && t.contains("time zone") => Class::TimestampTz,
            b if b.starts_with("timestamp") => Class::Timestamp,
            _ => Class::Other,
        };
    }
    match base.as_str() {
        "tinyint" if kind == DbKind::Mysql && first == Some(1) => Class::Bool,
        "bit" if kind == DbKind::Sqlserver || first == Some(1) => Class::Bool,
        "bool" | "boolean" => Class::Bool,
        "smallint" | "int2" | "smallserial" if unsigned => Class::Int,
        "smallint" | "int2" | "tinyint" | "smallserial" | "year" => Class::SmallInt,
        "int" | "integer" | "int4" | "mediumint" | "serial" => {
            if unsigned {
                Class::BigInt
            } else {
                Class::Int
            }
        }
        "bigint" | "int8" | "bigserial" => {
            if unsigned {
                Class::Numeric(Some((20, 0)))
            } else {
                Class::BigInt
            }
        }
        "numeric" | "decimal" | "dec" | "number" => Class::Numeric(match size.as_slice() {
            [p, s] => Some((*p, *s)),
            [p] => Some((*p, 0)),
            // without a size: any number in PostgreSQL, `(10,0)` in MySQL, `(18,0)` in SQL Server
            _ => match kind {
                DbKind::Mysql => Some((10, 0)),
                DbKind::Sqlserver => Some((18, 0)),
                _ => None,
            },
        }),
        "money" => Class::Numeric(Some((19, 4))),
        "smallmoney" => Class::Numeric(Some((10, 4))),
        "real" | "float4" => Class::Real,
        "float" if kind == DbKind::Mysql => Class::Real,
        "float" | "float8" | "double" | "double precision" => Class::Double,
        "char" | "character" | "bpchar" | "nchar" => Class::Char(first),
        "varchar" | "character varying" | "nvarchar" => {
            if t.contains("max") {
                Class::Text
            } else {
                Class::Varchar(first)
            }
        }
        "text" | "tinytext" | "mediumtext" | "longtext" | "ntext" | "citext" | "xml" | "name" => {
            Class::Text
        }
        "date" => Class::Date,
        "time" | "time without time zone" => Class::Time,
        "timestamp"
        | "timestamp without time zone"
        | "datetime"
        | "datetime2"
        | "smalldatetime" => Class::Timestamp,
        "timestamptz" | "timestamp with time zone" | "datetimeoffset" => Class::TimestampTz,
        "json" | "jsonb" => Class::Json,
        "uuid" | "uniqueidentifier" => Class::Uuid,
        "bytea" | "blob" | "tinyblob" | "mediumblob" | "longblob" | "binary" | "varbinary"
        | "image" => Class::Bytes,
        _ => Class::Other,
    }
}

/// A type of the target for a class, and what is lost when a value of the class goes into it.
pub fn type_for(to: DbKind, class: Class) -> (String, Option<&'static str>) {
    let sized = |name: &str, n: Option<u32>, max: u32, long: &str| match n {
        Some(n) if n > 0 && n <= max => format!("{name}({n})"),
        Some(_) => long.to_owned(),
        None => name.to_owned(),
    };
    let own = |s: &str| (s.to_owned(), None);
    match to {
        DbKind::Postgres => match class {
            Class::SmallInt => own("smallint"),
            Class::Int => own("integer"),
            Class::BigInt => own("bigint"),
            Class::Numeric(Some((p, s))) => (format!("numeric({p},{s})"), None),
            Class::Numeric(None) => own("numeric"),
            Class::Real => own("real"),
            Class::Double => own("double precision"),
            Class::Bool => own("boolean"),
            Class::Char(n) => (sized("char", n, 10_485_760, "text"), None),
            Class::Varchar(n) => (sized("varchar", n, 10_485_760, "text"), None),
            Class::Text => own("text"),
            Class::Date => own("date"),
            Class::Time => own("time"),
            Class::Timestamp => own("timestamp"),
            Class::TimestampTz => own("timestamptz"),
            Class::Json => own("jsonb"),
            Class::Uuid => own("uuid"),
            Class::Bytes => own("bytea"),
            Class::Other => (
                "text".to_owned(),
                Some("a type this app does not know: copied as text"),
            ),
        },
        DbKind::Mysql => match class {
            Class::SmallInt => own("smallint"),
            Class::Int => own("int"),
            Class::BigInt => own("bigint"),
            Class::Numeric(Some((p, s))) if p <= 65 && s <= 30 => {
                (format!("decimal({p},{s})"), None)
            }
            Class::Numeric(_) => (
                "decimal(65,30)".to_owned(),
                Some("numbers are limited to 65 digits, 30 of them behind the point"),
            ),
            Class::Real => own("float"),
            Class::Double => own("double"),
            Class::Bool => own("tinyint(1)"),
            Class::Char(n) => (sized("char", n, 255, "longtext"), None),
            // without a length, or longer than a row of MySQL takes
            // a row of MySQL holds 65 535 bytes, four to a character: long texts stay out of it
            Class::Varchar(Some(n)) if n > 0 && n <= 255 => (format!("varchar({n})"), None),
            Class::Varchar(_) | Class::Text => own("longtext"),
            Class::Date => own("date"),
            Class::Time => own("time(6)"),
            Class::Timestamp => own("datetime(6)"),
            Class::TimestampTz => (
                "datetime(6)".to_owned(),
                Some("the time zone is lost: the instant is stored as UTC"),
            ),
            Class::Json => own("json"),
            Class::Uuid => ("char(36)".to_owned(), None),
            Class::Bytes => own("longblob"),
            Class::Other => (
                "longtext".to_owned(),
                Some("a type this app does not know: copied as text"),
            ),
        },
        DbKind::Sqlserver => match class {
            Class::SmallInt => own("smallint"),
            Class::Int => own("int"),
            Class::BigInt => own("bigint"),
            Class::Numeric(Some((p, s))) if p <= 38 => (format!("decimal({p},{s})"), None),
            Class::Numeric(_) => (
                "decimal(38,10)".to_owned(),
                Some("numbers are limited to 38 digits, 10 of them behind the point"),
            ),
            Class::Real => own("real"),
            Class::Double => own("float"),
            Class::Bool => own("bit"),
            Class::Char(n) => (sized("nchar", n, 4000, "nvarchar(max)"), None),
            Class::Varchar(Some(n)) if n > 0 && n <= 4000 => (format!("nvarchar({n})"), None),
            Class::Varchar(_) | Class::Text => own("nvarchar(max)"),
            Class::Date => own("date"),
            Class::Time => own("time"),
            Class::Timestamp => own("datetime2"),
            Class::TimestampTz => own("datetimeoffset"),
            Class::Json => (
                "nvarchar(max)".to_owned(),
                Some("stored as text: the database no longer checks that it is JSON"),
            ),
            Class::Uuid => own("uniqueidentifier"),
            Class::Bytes => own("varbinary(max)"),
            Class::Other => (
                "nvarchar(max)".to_owned(),
                Some("a type this app does not know: copied as text"),
            ),
        },
        // only for the sake of a complete answer: `plan` refuses ClickHouse before it comes to this
        DbKind::Clickhouse => own("String"),
        DbKind::Trino => own("varchar"),
        DbKind::Duckdb => match class {
            Class::SmallInt => own("SMALLINT"),
            Class::Int => own("INTEGER"),
            Class::BigInt => own("BIGINT"),
            Class::Numeric(Some((p, s))) if p <= 38 => (format!("DECIMAL({p},{s})"), None),
            Class::Numeric(_) => (
                "DOUBLE".to_owned(),
                Some("more digits than DuckDB keeps exactly (38): stored as floating point"),
            ),
            Class::Real => own("FLOAT"),
            Class::Double => own("DOUBLE"),
            Class::Bool => own("BOOLEAN"),
            Class::Char(_) | Class::Varchar(_) | Class::Text => own("VARCHAR"),
            Class::Date => own("DATE"),
            Class::Time => own("TIME"),
            Class::Timestamp => own("TIMESTAMP"),
            Class::TimestampTz => own("TIMESTAMP WITH TIME ZONE"),
            Class::Json => own("JSON"),
            Class::Uuid => own("UUID"),
            Class::Bytes => own("BLOB"),
            Class::Other => (
                "VARCHAR".to_owned(),
                Some("a type this app does not know: copied as text"),
            ),
        },
        DbKind::Oracle => match class {
            Class::SmallInt => own("number(5)"),
            Class::Int => own("number(10)"),
            Class::BigInt => own("number(19)"),
            Class::Numeric(Some((p, s))) if p <= 38 => (format!("number({p},{s})"), None),
            Class::Numeric(_) => own("number"),
            Class::Real => own("binary_float"),
            Class::Double => own("binary_double"),
            // BOOLEAN came with 23ai: a number is there everywhere
            Class::Bool => (
                "number(1)".to_owned(),
                Some("stored as 1 and 0: Oracle before 23ai has no boolean"),
            ),
            Class::Char(Some(n)) if n > 0 && n <= 2000 => (format!("char({n} char)"), None),
            Class::Varchar(Some(n)) if n > 0 && n <= 4000 => (format!("varchar2({n} char)"), None),
            Class::Char(_) | Class::Varchar(_) | Class::Text => own("clob"),
            Class::Uuid => own("varchar2(36)"),
            // an Oracle DATE has a time of day: a date fits
            Class::Date => own("date"),
            Class::Time => (
                "varchar2(18)".to_owned(),
                Some("Oracle has no time of day alone: copied as text"),
            ),
            Class::Timestamp => own("timestamp"),
            Class::TimestampTz => own("timestamp with time zone"),
            Class::Json => (
                "clob".to_owned(),
                Some("stored as text: nothing checks that it is JSON"),
            ),
            Class::Bytes => own("blob"),
            Class::Other => (
                "clob".to_owned(),
                Some("a type this app does not know: copied as text"),
            ),
        },
        DbKind::Sqlite => match class {
            Class::SmallInt | Class::Int | Class::BigInt => own("INTEGER"),
            Class::Numeric(_) => (
                "NUMERIC".to_owned(),
                Some("SQLite keeps numbers with a fraction as floating point: digits can get lost"),
            ),
            Class::Real | Class::Double => own("REAL"),
            Class::Bool => own("BOOLEAN"),
            Class::Char(_) | Class::Varchar(_) | Class::Text | Class::Uuid => own("TEXT"),
            Class::Date => own("DATE"),
            Class::Time => own("TEXT"),
            Class::Timestamp => own("DATETIME"),
            Class::TimestampTz => (
                "DATETIME".to_owned(),
                Some("the time zone is lost: the instant is stored as UTC"),
            ),
            Class::Json => (
                "TEXT".to_owned(),
                Some("stored as text: nothing checks that it is JSON"),
            ),
            Class::Bytes => own("BLOB"),
            Class::Other => (
                "TEXT".to_owned(),
                Some("a type this app does not know: copied as text"),
            ),
        },
    }
}

/// How a value of a class travels: what the statement binds it as.
fn value_kind(class: Class) -> ValueKind {
    match class {
        Class::SmallInt | Class::Int | Class::BigInt | Class::Numeric(_) => ValueKind::Number,
        // a float travels as text (`-1.5e300` is no decimal number): every row binds the same type –
        // SQL Server makes one type of a column of `VALUES`, and a text among numbers fails there
        Class::Real | Class::Double => ValueKind::Text,
        Class::Bool => ValueKind::Bool,
        Class::Bytes => ValueKind::Bytes,
        _ => ValueKind::Text,
    }
}

/// A type of one dialect in another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mapped {
    pub type_name: String,
    /// What gets lost; `None`: nothing.
    pub loss: Option<String>,
}

/// What a column of type `type_name` in a database of kind `from` is in one of kind `to`.
pub fn map_type(from: DbKind, to: DbKind, type_name: &str) -> Mapped {
    let class = class_of(from, type_name);
    let (mapped, loss) = type_for(to, class);
    Mapped {
        type_name: mapped,
        loss: loss.map(str::to_owned),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// The rows are added to what the table holds.
    #[default]
    Append,
    /// A table that is there is emptied first.
    Clear,
}

/// What the window asks for.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub source_schema: String,
    pub tables: Vec<String>,
    pub target_schema: String,
    #[serde(default)]
    pub mode: Mode,
    /// Create the indexes and foreign keys of the source for tables that are created, after the rows.
    #[serde(default)]
    pub with_keys: bool,
    /// All rows of a table or none.
    #[serde(default)]
    pub whole_transaction: bool,
    #[serde(default)]
    pub on_error: OnError,
}

/// A column of a table on its way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPlan {
    pub name: String,
    pub source_type: String,
    /// The column of the target and its type; `None`: the target table has no such column – left out.
    pub target: Option<String>,
    pub target_type: Option<String>,
    pub loss: Option<String>,
}

/// What happens with one table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePlan {
    pub table: String,
    /// The table is in the target already.
    pub exists: bool,
    pub columns: Vec<ColumnPlan>,
    /// Remarks: what of the table is not copied.
    pub notes: Vec<String>,
    /// Statements before the rows (the table is created).
    pub before: Vec<String>,
    /// Statements after the rows of all tables (indexes, foreign keys).
    pub after: Vec<String>,
    /// How the source is read.
    #[serde(skip)]
    pub select: String,
    #[serde(skip)]
    pub load: LoadPlan,
    /// For each column that is read: is it an instant whose zone the target keeps?
    #[serde(skip)]
    pub keeps_zone: Vec<bool>,
}

/// The whole transfer: the tables in the order they are copied.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub tables: Vec<TablePlan>,
    /// Every statement that runs in the target, in its order: what the guard is asked about.
    pub statements: Vec<String>,
    /// Tables that point to each other in a circle: copied in the order given (their keys may fail).
    pub cycle: Vec<String>,
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::Unsupported, message)
}

fn qualified(kind: DbKind, schema: &str, table: &str) -> String {
    let q = |n: &str| super::meta::quote_always(n, kind);
    if kind == DbKind::Sqlite || schema.is_empty() {
        q(table)
    } else {
        format!("{}.{}", q(schema), q(table))
    }
}

/// The tables so that each comes after the tables its keys point to; what is left in a circle comes
/// last, in the order given.
fn ordered<'a>(tables: &[&'a Table]) -> (Vec<&'a Table>, Vec<String>) {
    let names: HashSet<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    let mut done: HashSet<&str> = HashSet::new();
    let mut out: Vec<&Table> = Vec::new();
    let mut left: Vec<&Table> = tables.to_vec();
    loop {
        let before = left.len();
        left.retain(|t| {
            let ready = t.keys.iter().all(|k| {
                k.ref_table == t.name
                    || !k.ref_schema.is_empty()
                    || !names.contains(k.ref_table.as_str())
                    || done.contains(k.ref_table.as_str())
            });
            if ready {
                done.insert(t.name.as_str());
                out.push(t);
            }
            !ready
        });
        if left.is_empty() || left.len() == before {
            break;
        }
    }
    let cycle = left.iter().map(|t| t.name.clone()).collect();
    out.extend(left);
    (out, cycle)
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

/// What happens in the target for the tables asked for. Nothing is asked or run.
pub fn plan(
    from: DbKind,
    to: DbKind,
    source: &Snapshot,
    target: &Snapshot,
    request: &Request,
) -> AppResult<Plan> {
    for kind in [from, to] {
        if !kind.edits_rows() {
            // a table there needs an engine and a sorting key no other database knows of
            return Err(super::not_yet(kind, "copying tables"));
        }
    }
    if request.tables.is_empty() {
        return Err(invalid("choose at least one table"));
    }
    let mut chosen: Vec<&Table> = Vec::new();
    for name in &request.tables {
        let table = source
            .tables
            .iter()
            .find(|t| &t.name == name)
            .ok_or_else(|| invalid("a table that is asked for is not in the source"))?;
        if !chosen.iter().any(|t| t.name == table.name) {
            chosen.push(table);
        }
    }
    let (order, cycle) = ordered(&chosen);
    let created: HashSet<&str> = order
        .iter()
        .filter(|t| {
            !target
                .tables
                .iter()
                .any(|x| x.name.eq_ignore_ascii_case(&t.name))
        })
        .map(|t| t.name.as_str())
        .collect();
    let mut tables = Vec::new();
    for table in order {
        let existing = target
            .tables
            .iter()
            .find(|t| t.name.eq_ignore_ascii_case(&table.name));
        let mut columns = Vec::new();
        let mut mappings = Vec::new();
        let mut read = Vec::new();
        let mut keeps_zone = Vec::new();
        let mut made: Vec<compare::Column> = Vec::new();
        for c in &table.columns {
            let class = class_of(from, &c.type_name);
            let (target_name, target_type, loss) = match existing {
                Some(t) => match t
                    .columns
                    .iter()
                    .find(|x| x.name.eq_ignore_ascii_case(&c.name))
                {
                    Some(x) => {
                        // the target says what the column is; a loss is what its class cannot hold
                        let there = class_of(to, &x.type_name);
                        let loss = match (class, there) {
                            (Class::TimestampTz, Class::Timestamp | Class::Text) => {
                                Some("the time zone is lost: the instant is stored as UTC")
                            }
                            _ => None,
                        };
                        (Some(x.name.clone()), Some(x.type_name.clone()), loss)
                    }
                    None => (None, None, None),
                },
                None => {
                    let (mapped, loss) = type_for(to, class);
                    // a key cannot be a text without a limit in MySQL and SQL Server
                    let (mapped, loss) = match (to, mapped.as_str(), table.pk.contains(&c.name)) {
                        (DbKind::Mysql, "longtext", true) => (
                            "varchar(255)".to_owned(),
                            Some(
                                "a key cannot be an unlimited text here: limited to 255 characters",
                            ),
                        ),
                        (DbKind::Sqlserver, "nvarchar(max)", true) => (
                            "nvarchar(450)".to_owned(),
                            Some(
                                "a key cannot be an unlimited text here: limited to 450 characters",
                            ),
                        ),
                        _ => (mapped, loss),
                    };
                    made.push(compare::Column {
                        name: c.name.clone(),
                        type_name: mapped.clone(),
                        nullable: c.nullable,
                        default: None,
                    });
                    (Some(c.name.clone()), Some(mapped), loss)
                }
            };
            if let (Some(name), Some(type_name)) = (&target_name, &target_type) {
                let there = class_of(to, type_name);
                mappings.push(Mapping {
                    source: Some(read.len()),
                    fixed: None,
                    target: TargetColumn {
                        name: name.clone(),
                        // a class the target does not know by this name (a new column): as it travels
                        kind: value_kind(if existing.is_some() { there } else { class }),
                        type_name: type_name.clone(),
                    },
                    trim: false,
                    decimal_comma: false,
                    date_order: None,
                });
                read.push(c.name.clone());
                keeps_zone.push(match to {
                    DbKind::Postgres | DbKind::Sqlserver => {
                        matches!(
                            if existing.is_some() { there } else { class },
                            Class::TimestampTz
                        )
                    }
                    _ => false,
                });
            }
            columns.push(ColumnPlan {
                name: c.name.clone(),
                source_type: c.type_name.clone(),
                target: target_name,
                target_type,
                loss: loss.map(str::to_owned),
            });
        }
        if mappings.is_empty() {
            return Err(invalid("a table has no column in common with its target"));
        }
        let mut notes = Vec::new();
        let (mut before, mut after) = (Vec::new(), Vec::new());
        if existing.is_none() {
            let bare = Table {
                name: table.name.clone(),
                columns: made.clone(),
                pk: table.pk.clone(),
                ..Table::default()
            };
            let nothing = snapshot_of(to, &request.target_schema, Vec::new());
            let with = snapshot_of(to, &request.target_schema, vec![bare.clone()]);
            before = compare::script_steps(&with, &nothing, &[])?
                .into_iter()
                .filter(|s| !s.sql.is_empty())
                .map(|s| s.sql)
                .collect();
            if table.columns.iter().any(|c| c.default.is_some()) {
                notes.push(
                    "defaults are not copied: they are written in the dialect of the source"
                        .to_owned(),
                );
            }
            if !table.checks.is_empty() {
                notes.push(
                    "checks are not copied: they are written in the dialect of the source"
                        .to_owned(),
                );
            }
            if request.with_keys && to != DbKind::Sqlite {
                // PostgreSQL tells an index by its statement: its columns are read from it
                let columns_of = |i: &compare::Index| match (&i.definition, i.columns.is_empty()) {
                    (Some(definition), true) => super::structure::index_columns(definition),
                    _ => i.columns.clone(),
                };
                let full = Table {
                    indexes: table
                        .indexes
                        .iter()
                        .map(|i| compare::Index {
                            definition: None,
                            columns: columns_of(i),
                            ..i.clone()
                        })
                        .filter(|i| !i.columns.is_empty())
                        .collect(),
                    // only keys to tables that will be there: copied along, or the table itself
                    keys: table
                        .keys
                        .iter()
                        .filter(|k| {
                            k.ref_schema.is_empty()
                                && (created.contains(k.ref_table.as_str())
                                    || target
                                        .tables
                                        .iter()
                                        .any(|t| t.name.eq_ignore_ascii_case(&k.ref_table)))
                        })
                        .cloned()
                        .collect(),
                    ..bare.clone()
                };
                if table.indexes.iter().any(|i| columns_of(i).is_empty()) {
                    notes.push("an index on an expression is not copied".to_owned());
                }
                let whole = snapshot_of(to, &request.target_schema, vec![full]);
                after = compare::script_steps(&whole, &with, &[])?
                    .into_iter()
                    .filter(|s| !s.sql.is_empty())
                    .map(|s| s.sql)
                    .collect();
            } else if request.with_keys {
                notes.push(
                    "SQLite cannot add keys to a table afterwards: indexes and keys are not copied"
                        .to_owned(),
                );
            }
        }
        let q = |n: &str| super::meta::quote_always(n, from);
        let select = format!(
            "SELECT {} FROM {}",
            read.iter().map(|c| q(c)).collect::<Vec<_>>().join(", "),
            qualified(from, &request.source_schema, &table.name)
        );
        let load = LoadPlan {
            schema: (to != DbKind::Sqlite && !request.target_schema.is_empty())
                .then(|| request.target_schema.clone()),
            table: existing.map_or_else(|| table.name.clone(), |t| t.name.clone()),
            mappings,
            null_texts: Vec::new(),
            empty_is_null: false,
            clear_first: request.mode == Mode::Clear && existing.is_some(),
            on_error: request.on_error,
            whole_transaction: request.whole_transaction,
            exact: true,
        };
        tables.push(TablePlan {
            table: table.name.clone(),
            exists: existing.is_some(),
            columns,
            notes,
            before,
            after,
            select,
            load,
            keeps_zone,
        });
    }
    let mut statements = Vec::new();
    for t in &tables {
        statements.extend(t.before.iter().cloned());
        if t.load.clear_first {
            statements.push(load::clear_statement(to, &t.load)?);
        }
        statements.push(load::shape(to, &t.load)?.sql);
    }
    for t in &tables {
        statements.extend(t.after.iter().cloned());
    }
    Ok(Plan {
        tables,
        statements,
        cycle,
    })
}

/// A cell of the source as the text the loader binds. `keeps_zone`: the target column keeps the zone of
/// an instant; else the instant goes as UTC. `Err`: the value cannot be copied.
pub fn text_of(cell: &Cell, kind: ValueKind, keeps_zone: bool) -> Result<Option<String>, String> {
    if kind == ValueKind::Bytes && !matches!(cell, Cell::Bytes(..) | Cell::Null) {
        // into a binary column goes what the value is as text, byte for byte – never „decoded“ because
        // its text happens to read as hex
        return Ok(text_of(cell, ValueKind::Text, keeps_zone)?
            .map(|text| text.bytes().map(|b| format!("{b:02x}")).collect()));
    }
    Ok(Some(match cell {
        Cell::Null => return Ok(None),
        Cell::Bool(b) => match kind {
            ValueKind::Number => if *b { "1" } else { "0" }.to_owned(),
            _ => b.to_string(),
        },
        Cell::I64(n) if kind == ValueKind::Bool => (*n != 0).to_string(),
        Cell::U64(n) if kind == ValueKind::Bool => (*n != 0).to_string(),
        Cell::I64(n) => n.to_string(),
        Cell::U64(n) => n.to_string(),
        // the shortest text that reads back as the same number; large and tiny ones with an exponent
        // (Rust writes 300 digits otherwise)
        Cell::F64(f) if f.is_finite() && *f != 0.0 && !(1e-5..1e16).contains(&f.abs()) => {
            format!("{f:e}")
        }
        Cell::F64(f) => f.to_string(),
        Cell::Decimal(s) | Cell::Text(s) | Cell::Json(s) | Cell::Uuid(s) => s.clone(),
        Cell::Bytes(_, all) => all.iter().map(|b| format!("{b:02x}")).collect(),
        Cell::Ts(t) => t.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
        Cell::TsTz(t) if keeps_zone => t.format("%Y-%m-%d %H:%M:%S%.f%:z").to_string(),
        Cell::TsTz(t) => t.naive_utc().format("%Y-%m-%d %H:%M:%S%.f").to_string(),
        Cell::Date(d) => d.format("%Y-%m-%d").to_string(),
        Cell::Time(t) => t.format("%H:%M:%S%.f").to_string(),
        Cell::Unreadable(type_name) => {
            return Err(format!("a value of type {type_name} could not be read"));
        }
    }))
}

/// What travels from the source to the loader.
enum Message {
    Row(NextRecord),
    /// The source was read to its end. A reader that goes away without this word did not get there.
    Done,
    /// The source failed: the load must not end as if the table had been read whole.
    Failed(AppError),
}

/// Takes the rows the source reads and hands them on; waits when the queue is full.
struct Sender<'a> {
    queue: SyncSender<Message>,
    kinds: &'a [ValueKind],
    keeps_zone: &'a [bool],
    row: u64,
}

impl RowSink for Sender<'_> {
    fn start(&mut self, _columns: &[Column]) {}

    fn row(&mut self, cells: Vec<Cell>) -> bool {
        self.row += 1;
        let mut out = Vec::with_capacity(cells.len());
        let mut broken = None;
        for (i, cell) in cells.iter().enumerate() {
            let kind = self.kinds.get(i).copied().unwrap_or(ValueKind::Text);
            match text_of(cell, kind, self.keeps_zone.get(i).copied().unwrap_or(false)) {
                Ok(text) => out.push(text),
                Err(reason) => {
                    broken = Some(reason);
                    break;
                }
            }
        }
        // for the error file: the row as far as it says something, never more than a line
        let raw = || -> String {
            out.iter()
                .map(|c| c.as_deref().unwrap_or("NULL"))
                .collect::<Vec<_>>()
                .join(" | ")
                .chars()
                .filter(|c| !c.is_control())
                .take(RAW_CHARS)
                .collect()
        };
        let record = match broken {
            Some(reason) => Err((self.row, reason, raw())),
            None => Ok(Record {
                line: self.row,
                raw: raw(),
                cells: out,
            }),
        };
        // the loader is gone (it failed or was stopped): no more rows are wanted
        self.queue.send(Message::Row(record)).is_ok()
    }
}

/// The rows of the source as the loader reads them.
struct Queue {
    queue: Receiver<Message>,
    width: usize,
}

impl Records for Queue {
    fn width(&self) -> usize {
        self.width
    }

    fn next_record(&mut self) -> AppResult<Option<NextRecord>> {
        match self.queue.recv() {
            Ok(Message::Row(record)) => Ok(Some(record)),
            Ok(Message::Done) => Ok(None),
            Ok(Message::Failed(e)) => Err(e),
            // the reader is gone without a word (it panicked): what came is not the whole table
            Err(_) => Err(AppError::new(
                ErrorCode::Io,
                "reading the source ended unexpectedly",
            )),
        }
    }
}

/// Copies the rows of one table: read from `source` in a thread of its own, written to `target` by the
/// loader of the import – in blocks, each its own transaction, or all in one (`plan.load`). `progress`
/// hears the rows read so far.
#[allow(clippy::too_many_arguments)]
pub fn copy_table(
    source: &mut dyn Session,
    target: &mut dyn Session,
    to: DbKind,
    plan: &TablePlan,
    error_file: Option<&std::path::Path>,
    timeout: Option<std::time::Duration>,
    progress: &(dyn Fn(u64) + Sync),
    stop: Stop,
) -> AppResult<Loaded> {
    let kinds: Vec<ValueKind> = plan.load.mappings.iter().map(|m| m.target.kind).collect();
    let width = kinds.len();
    let (kinds, zones, select) = (&kinds[..], &plan.keeps_zone[..], plan.select.as_str());
    let (tx, rx) = sync_channel::<Message>(QUEUE);
    std::thread::scope(|scope| {
        // the source owns its end of the queue: when it is done, the loader reads the end
        let reader = scope.spawn(move || {
            let mut sink = Sender {
                queue: tx.clone(),
                kinds,
                keeps_zone: zones,
                row: 0,
            };
            let read = source.execute(
                select,
                Limits {
                    max_rows: usize::MAX,
                    timeout: None,
                },
                &mut sink,
                stop,
            );
            // told to the loader – which, after a failure, takes back what its transaction holds
            let _ = tx.send(match read {
                Ok(_) => Message::Done,
                Err(e) => Message::Failed(e),
            });
        });
        let mut queue = Queue { queue: rx, width };
        let loaded = load::load(
            target, to, &mut queue, &plan.load, error_file, timeout, progress, stop,
        );
        // the loader is done: a source that still reads finds its queue closed and ends
        drop(queue);
        let _ = reader.join();
        loaded
    })
}

/// What a transfer reports while it runs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    Table {
        table: String,
        index: usize,
        of: usize,
    },
    #[serde(rename_all = "camelCase")]
    Rows { table: String, read: u64 },
}

/// How one table went.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableReport {
    pub table: String,
    /// The table was not begun: one before it failed.
    pub skipped: bool,
    pub loaded: Loaded,
    /// This run created the table: it is there, whatever became of its rows.
    pub created: bool,
    pub elapsed_ms: u64,
    /// A statement before the rows failed (the table could not be created).
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub tables: Vec<TableReport>,
    /// Statements after the rows (indexes, keys) that failed, with what the database said.
    pub after_errors: Vec<String>,
    pub cancelled: bool,
}

/// Runs a plan: table after table – created where it is new, its rows copied –, then the indexes and
/// keys. A table that fails ends the transfer unless rows that fail are skipped; what was copied before
/// stays (each table is its own transaction, or its blocks are).
#[allow(clippy::too_many_arguments)]
pub fn run(
    source: &mut dyn Session,
    target: &mut dyn Session,
    to: DbKind,
    plan: &Plan,
    error_file: &dyn Fn(&str) -> Option<std::path::PathBuf>,
    timeout: Option<std::time::Duration>,
    tell: &(dyn Fn(Event) + Sync),
    stop: Stop,
) -> Report {
    let mut report = Report {
        tables: Vec::new(),
        after_errors: Vec::new(),
        cancelled: false,
    };
    let mut ended = false;
    let quiet = Limits::rows(1);
    let never: Stop = &|| false;
    for (index, table) in plan.tables.iter().enumerate() {
        if ended || stop() {
            report.cancelled |= !ended;
            ended = true;
            report.tables.push(TableReport {
                table: table.table.clone(),
                skipped: true,
                loaded: Loaded::default(),
                created: false,
                elapsed_ms: 0,
                error: None,
            });
            continue;
        }
        tell(Event::Table {
            table: table.table.clone(),
            index,
            of: plan.tables.len(),
        });
        let begun = std::time::Instant::now();
        let mut error = None;
        let mut created = false;
        for sql in &table.before {
            if let Err(e) = target.query(sql.trim().trim_end_matches(';'), quiet, stop) {
                error = Some(e.message);
                break;
            }
            created = true;
        }
        let loaded = if error.is_some() {
            Loaded {
                failed: true,
                ..Loaded::default()
            }
        } else {
            let path = error_file(&table.table);
            let name = table.table.clone();
            match copy_table(
                source,
                target,
                to,
                table,
                path.as_deref(),
                timeout,
                &|read| {
                    tell(Event::Rows {
                        table: name.clone(),
                        read,
                    })
                },
                stop,
            ) {
                Ok(loaded) => loaded,
                Err(e) => {
                    error = Some(e.message);
                    Loaded {
                        failed: true,
                        ..Loaded::default()
                    }
                }
            }
        };
        report.cancelled |= loaded.cancelled;
        ended = loaded.failed || loaded.cancelled;
        report.tables.push(TableReport {
            table: table.table.clone(),
            skipped: false,
            loaded,
            created,
            elapsed_ms: begun.elapsed().as_millis() as u64,
            error,
        });
    }
    // the indexes and keys of every table that is whole – also when a later one failed or the run was
    // stopped: a table that is complete must not stay without them (the next run finds it „there“)
    {
        let whole: HashSet<String> = report
            .tables
            .iter()
            .filter(|t| !t.skipped && !t.loaded.failed && !t.loaded.cancelled && t.error.is_none())
            .map(|t| t.table.clone())
            .collect();
        for table in plan.tables.iter().filter(|t| whole.contains(&t.table)) {
            for sql in &table.after {
                // not stopped half way: a statement of a few
                if let Err(e) = target.query(sql.trim().trim_end_matches(';'), quiet, never) {
                    report.after_errors.push(format!("{sql} – {}", e.message));
                }
            }
        }
    }
    report
}

/// The keys of a plan by table, for tests and the window: which tables are created.
pub fn created(plan: &Plan) -> HashMap<String, bool> {
    plan.tables
        .iter()
        .map(|t| (t.table.clone(), !t.exists))
        .collect()
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
