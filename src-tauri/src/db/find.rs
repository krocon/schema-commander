//! Search on the server (prompt 036): where does a text stand – in the **data** of the tables, and in the
//! **source** of views, routines, triggers, checks, defaults and comments. Only reading, one table after
//! the other, each with a limit of hits and of time. The text that is searched is **always bound**;
//! names are quoted by `filter::name`; what the catalog gives is searched here, not sent back as SQL.

use super::filter::name;
use super::meta::{self, ObjectKind};
use super::value::{Cell, VecSink};
use super::{Bind, DbKind, Flavor, Limits, Session, Stop, TextRows};
use crate::error::{AppError, AppResult, ErrorCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Characters of a value that are read to find the place of a hit.
pub const VALUE_CHARS: usize = 4_000;
/// Characters of a hit that are shown.
pub const PREVIEW_CHARS: usize = 160;
/// Columns of one table searched at most (a statement names each of them twice).
pub const MAX_COLUMNS: usize = 400;
/// Hits of the sources at most.
pub const MAX_SOURCE_HITS: usize = 2_000;
/// The longest text to search for.
pub const MAX_TEXT_CHARS: usize = 1_000;
/// The character that makes `%`, `_` and itself plain characters in a pattern. Not the backslash: MySQL
/// and a PostgreSQL set that way read one inside a string in their own way.
const ESCAPE: char = '!';

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// The text occurs anywhere.
    #[default]
    Contains,
    /// The value is the text.
    Exact,
    /// The text is a regular expression of the database (PostgreSQL, MySQL, MariaDB).
    Regex,
}

/// Which columns are searched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Columns {
    #[default]
    Text,
    /// Texts and numbers.
    Numbers,
    /// Everything that can be read as text (not binary data).
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindSpec {
    pub text: String,
    #[serde(default)]
    pub mode: Mode,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub columns: Columns,
    /// The schemas to search; none = all that are not the system's.
    #[serde(default)]
    pub schemas: Vec<String>,
    /// Only these tables (`schema`, `table`); none = all of the schemas.
    #[serde(default)]
    pub tables: Vec<(String, String)>,
    /// Search the rows of tables.
    #[serde(default)]
    pub data: bool,
    /// Search definitions and comments.
    #[serde(default)]
    pub sources: bool,
    /// Search the names of objects too.
    #[serde(default)]
    pub names: bool,
    /// Hits read per table.
    #[serde(default)]
    pub max_hits: u32,
    /// Time per table in milliseconds; 0 = none.
    #[serde(default)]
    pub table_timeout_ms: u64,
    /// Tables the server estimates larger than this are left out; 0 = none is.
    #[serde(default)]
    pub skip_rows_over: u64,
}

/// What a search tells while it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FindEvent {
    /// The tables to search are known.
    Start { tables: usize },
    /// A table is being searched.
    Table {
        done: usize,
        schema: String,
        table: String,
    },
    /// Rows of a table hold the text.
    Rows {
        schema: String,
        table: String,
        hits: Vec<RowHit>,
        /// There are more rows than were read.
        more: bool,
    },
    /// A table was not searched, or a kind of source could not be read.
    Skipped {
        schema: String,
        name: String,
        reason: Skip,
        message: String,
    },
    /// A definition holds the text.
    Source { hit: SourceHit },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Skip {
    /// The server estimates more rows than the search wants to read.
    Large,
    /// Nothing in it is of a kind that is searched.
    NoColumns,
    /// It took longer than a table may.
    Timeout,
    /// The server said no (no right to read, …).
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowHit {
    /// The column the text was found in; empty when only the database saw where.
    pub column: String,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceHit {
    /// `view`, `routine`, `trigger`, `check`, `default`, `comment`, `table`, `name`.
    pub kind: String,
    pub schema: String,
    /// The object; for parts of a table `table.part`.
    pub name: String,
    /// The line of the definition (from 1).
    pub line: usize,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FindReport {
    pub tables: usize,
    pub searched: usize,
    pub skipped: usize,
    /// Rows found (as far as they were read).
    pub rows: usize,
    pub sources: usize,
    pub cancelled: bool,
    /// The search ended early: the connection was lost (a server that can stop a statement only by
    /// dropping it).
    pub lost: bool,
    /// After a lost connection: the table to go on with on a new one.
    pub resume: Option<usize>,
    /// More definitions hold the text than are told.
    pub more_sources: bool,
}

impl FindReport {
    /// This report with what a search that went on from `resume` found.
    pub fn and(mut self, next: FindReport) -> FindReport {
        self.searched += next.searched;
        self.skipped += next.skipped;
        self.rows += next.rows;
        self.cancelled = next.cancelled;
        self.lost = next.lost;
        self.resume = next.resume;
        self
    }
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::InvalidQuery, message)
}

/// What a column is, by the name of its type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnClass {
    Text,
    Number,
    Binary,
    Other,
}

pub fn class_of(type_name: &str) -> ColumnClass {
    let t = type_name.trim().to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| t.contains(w));
    if has(&[
        "bytea",
        "blob",
        "binary",
        "image",
        "geometry",
        "geography",
        "raster",
    ]) {
        ColumnClass::Binary
    } else if has(&[
        "char",
        "text",
        "clob",
        "string",
        "json",
        "xml",
        "uuid",
        "enum",
        "set(",
        "citext",
        "name",
        "uniqueidentifier",
        "inet",
        "cidr",
    ]) {
        ColumnClass::Text
    } else if {
        // by its first word: `interval` and `point` hold `int` too
        let word: String = t.chars().take_while(char::is_ascii_alphanumeric).collect();
        matches!(
            word.as_str(),
            "int"
                | "integer"
                | "tinyint"
                | "smallint"
                | "mediumint"
                | "bigint"
                | "int2"
                | "int4"
                | "int8"
                | "serial"
                | "smallserial"
                | "bigserial"
                | "numeric"
                | "decimal"
                | "dec"
                | "number"
                | "float"
                | "float4"
                | "float8"
                | "double"
                | "real"
                | "money"
                | "smallmoney"
        )
    } {
        ColumnClass::Number
    } else if t.is_empty() {
        // SQLite: a column without a type holds anything
        ColumnClass::Text
    } else {
        ColumnClass::Other
    }
}

fn wanted(class: ColumnClass, columns: Columns) -> bool {
    match (class, columns) {
        (ColumnClass::Binary, _) => false,
        (ColumnClass::Text, _) => true,
        (ColumnClass::Number, Columns::Numbers | Columns::All) => true,
        (ColumnClass::Other, Columns::All) => true,
        _ => false,
    }
}

/// The text as a `LIKE` pattern that finds it anywhere: `%`, `_` (and for SQL Server `[`) in it are
/// characters, not wildcards.
pub fn like_pattern(text: &str, kind: DbKind) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('%');
    for c in text.chars() {
        if c == ESCAPE || c == '%' || c == '_' || (kind == DbKind::Sqlserver && c == '[') {
            out.push(ESCAPE);
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// A statement with its values, in the order of the placeholders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub sql: String,
    pub params: Vec<String>,
}

fn as_text(column: &str, kind: DbKind) -> String {
    match kind {
        DbKind::Postgres => format!("CAST({column} AS text)"),
        DbKind::Mysql => format!("CAST({column} AS CHAR)"),
        DbKind::Sqlserver => format!("CAST({column} AS nvarchar(max))"),
        DbKind::Sqlite => format!("CAST({column} AS TEXT)"),
        DbKind::Oracle => format!("TO_CHAR({column})"),
        DbKind::Duckdb | DbKind::Trino => format!("CAST({column} AS VARCHAR)"),
        DbKind::Clickhouse => format!("toString({column})"),
    }
}

/// The statement that reads the rows of a table that hold the text: the searched columns as text (their
/// start), for the rows where one of them matches. `None`: no column of the table is searched.
pub fn data_question(
    kind: DbKind,
    schema: &str,
    table: &str,
    columns: &[(String, String)],
    spec: &FindSpec,
) -> AppResult<Option<(Question, Vec<String>)>> {
    if spec.mode == Mode::Regex && matches!(kind, DbKind::Sqlserver | DbKind::Sqlite) {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "this database has no regular expressions",
        ));
    }
    let searched: Vec<&str> = columns
        .iter()
        .filter(|(_, type_name)| wanted(class_of(type_name), spec.columns))
        .map(|(column, _)| column.as_str())
        .take(MAX_COLUMNS)
        .collect();
    if searched.is_empty() {
        return Ok(None);
    }
    let mut params: Vec<String> = Vec::new();
    let mut place = |value: String| -> String {
        params.push(value);
        let n = params.len();
        match kind {
            DbKind::Postgres | DbKind::Duckdb => format!("${n}"),
            DbKind::Mysql | DbKind::Trino => "?".to_owned(),
            DbKind::Sqlserver => format!("@P{n}"),
            DbKind::Sqlite => format!("?{n}"),
            DbKind::Oracle => format!(":{n}"),
            DbKind::Clickhouse => format!("{{p{n}:String}}"),
        }
    };
    let sensitive = spec.case_sensitive;
    let pattern = like_pattern(&spec.text, kind);
    let mut selected = Vec::with_capacity(searched.len());
    let mut conditions = Vec::with_capacity(searched.len());
    for column in &searched {
        let quoted = name(column, kind)?;
        let text = as_text(&quoted, kind);
        selected.push(match kind {
            DbKind::Sqlite | DbKind::Trino => format!("substr({text}, 1, {VALUE_CHARS})"),
            DbKind::Oracle => format!("SUBSTR({text}, 1, {VALUE_CHARS})"),
            DbKind::Clickhouse => format!("substringUTF8({text}, 1, {VALUE_CHARS})"),
            DbKind::Postgres | DbKind::Mysql | DbKind::Sqlserver | DbKind::Duckdb => {
                format!("LEFT({text}, {VALUE_CHARS})")
            }
        });
        conditions.push(match (kind, spec.mode) {
            (DbKind::Postgres, Mode::Contains) => {
                let op = if sensitive { "LIKE" } else { "ILIKE" };
                format!("{text} {op} {} ESCAPE '{ESCAPE}'", place(pattern.clone()))
            }
            (DbKind::Postgres, Mode::Exact) if sensitive => {
                format!("{text} = {}", place(spec.text.clone()))
            }
            (DbKind::Postgres, Mode::Exact) => {
                format!("lower({text}) = lower({})", place(spec.text.clone()))
            }
            (DbKind::Postgres, Mode::Regex) => {
                let op = if sensitive { "~" } else { "~*" };
                format!("{text} {op} {}", place(spec.text.clone()))
            }
            (DbKind::Mysql, mode) => {
                let collation = if sensitive {
                    "utf8mb4_bin"
                } else {
                    "utf8mb4_general_ci"
                };
                let left = format!("{text} COLLATE {collation}");
                match mode {
                    Mode::Contains => {
                        format!("{left} LIKE {} ESCAPE '{ESCAPE}'", place(pattern.clone()))
                    }
                    Mode::Exact => format!("{left} = {}", place(spec.text.clone())),
                    Mode::Regex => format!("{left} REGEXP {}", place(spec.text.clone())),
                }
            }
            (DbKind::Sqlserver, mode) => {
                let collation = if sensitive {
                    "Latin1_General_100_CS_AS"
                } else {
                    "Latin1_General_100_CI_AS"
                };
                let left = format!("{text} COLLATE {collation}");
                match mode {
                    Mode::Contains => {
                        format!("{left} LIKE {} ESCAPE '{ESCAPE}'", place(pattern.clone()))
                    }
                    _ => format!("{left} = {}", place(spec.text.clone())),
                }
            }
            // SQLite's LIKE ignores the case of ASCII letters, always: with case, `instr`
            (DbKind::Sqlite, Mode::Contains) if sensitive => {
                format!("instr({text}, {}) > 0", place(spec.text.clone()))
            }
            (DbKind::Sqlite, Mode::Contains) => {
                format!("{text} LIKE {} ESCAPE '{ESCAPE}'", place(pattern.clone()))
            }
            (DbKind::Sqlite, _) if sensitive => format!("{text} = {}", place(spec.text.clone())),
            (DbKind::Sqlite, _) => {
                format!("{text} = {} COLLATE NOCASE", place(spec.text.clone()))
            }
            // no LIKE either: a position says the same without a pattern
            (DbKind::Trino, Mode::Contains) if sensitive => {
                format!("strpos({text}, {}) > 0", place(spec.text.clone()))
            }
            (DbKind::Trino, Mode::Contains) => format!(
                "strpos(lower({text}), lower({})) > 0",
                place(spec.text.clone())
            ),
            (DbKind::Trino, Mode::Exact) if sensitive => {
                format!("{text} = {}", place(spec.text.clone()))
            }
            (DbKind::Trino, Mode::Exact) => {
                format!("lower({text}) = lower({})", place(spec.text.clone()))
            }
            (DbKind::Trino, Mode::Regex) => format!(
                "regexp_like({text}, {})",
                place(if sensitive {
                    spec.text.clone()
                } else {
                    format!("(?i){}", spec.text)
                })
            ),
            // no LIKE: its escapes are another story there, and a position says the same
            (DbKind::Clickhouse, Mode::Contains) if sensitive => {
                format!("position({text}, {}) > 0", place(spec.text.clone()))
            }
            (DbKind::Clickhouse, Mode::Contains) => format!(
                "positionCaseInsensitiveUTF8({text}, {}) > 0",
                place(spec.text.clone())
            ),
            (DbKind::Clickhouse, Mode::Exact) if sensitive => {
                format!("{text} = {}", place(spec.text.clone()))
            }
            (DbKind::Clickhouse, Mode::Exact) => {
                format!(
                    "lowerUTF8({text}) = lowerUTF8({})",
                    place(spec.text.clone())
                )
            }
            (DbKind::Clickhouse, Mode::Regex) => format!(
                "match({text}, {})",
                place(if sensitive {
                    spec.text.clone()
                } else {
                    format!("(?i){}", spec.text)
                })
            ),
            (DbKind::Duckdb, Mode::Contains) => {
                let op = if sensitive { "LIKE" } else { "ILIKE" };
                format!("{text} {op} {} ESCAPE '{ESCAPE}'", place(pattern.clone()))
            }
            (DbKind::Duckdb, Mode::Exact) if sensitive => {
                format!("{text} = {}", place(spec.text.clone()))
            }
            (DbKind::Duckdb, Mode::Exact) => {
                format!("lower({text}) = lower({})", place(spec.text.clone()))
            }
            (DbKind::Duckdb, Mode::Regex) => format!(
                "regexp_matches({text}, {}, '{}')",
                place(spec.text.clone()),
                if sensitive { "c" } else { "i" }
            ),
            // Oracle compares as the session sorts: with the case as it is, unless told otherwise
            (DbKind::Oracle, Mode::Contains) if sensitive => {
                format!("{text} LIKE {} ESCAPE '{ESCAPE}'", place(pattern.clone()))
            }
            (DbKind::Oracle, Mode::Contains) => format!(
                "UPPER({text}) LIKE UPPER({}) ESCAPE '{ESCAPE}'",
                place(pattern.clone())
            ),
            (DbKind::Oracle, Mode::Exact) if sensitive => {
                format!("{text} = {}", place(spec.text.clone()))
            }
            (DbKind::Oracle, Mode::Exact) => {
                format!("UPPER({text}) = UPPER({})", place(spec.text.clone()))
            }
            (DbKind::Oracle, Mode::Regex) => format!(
                "REGEXP_LIKE({text}, {}, '{}')",
                place(spec.text.clone()),
                if sensitive { "c" } else { "i" }
            ),
        });
    }
    let from = if schema.is_empty() {
        name(table, kind)?
    } else {
        format!("{}.{}", name(schema, kind)?, name(table, kind)?)
    };
    // one more than wanted: to know that there are more
    let limit = spec.max_hits.clamp(1, 1_000) + 1;
    let (top, tail) = match kind {
        DbKind::Sqlserver => (format!("TOP ({limit}) "), String::new()),
        DbKind::Oracle => (String::new(), format!(" FETCH FIRST {limit} ROWS ONLY")),
        _ => (String::new(), format!(" LIMIT {limit}")),
    };
    let sql = format!(
        "SELECT {top}{} FROM {from} WHERE {}{tail}",
        selected.join(", "),
        conditions.join(" OR ")
    );
    Ok(Some((
        Question { sql, params },
        searched.iter().map(|c| (*c).to_owned()).collect(),
    )))
}

/// Finds the text in what came back from the server – for the place of a hit, and in the sources.
pub struct Matcher {
    /// A regular expression only the server understands: no place is found here.
    blind: bool,
    regex: Option<regex::Regex>,
    text: String,
    exact: bool,
    sensitive: bool,
}

impl Matcher {
    pub fn new(spec: &FindSpec) -> AppResult<Matcher> {
        // the databases have their own dialects of regular expressions (back references, look-ahead):
        // what is none of ours is left to them – the rows are found, the place in them is not
        let regex = match spec.mode {
            Mode::Regex => regex::RegexBuilder::new(&spec.text)
                .case_insensitive(!spec.case_sensitive)
                .size_limit(1 << 20)
                .build()
                .ok(),
            _ => None,
        };
        Ok(Matcher {
            blind: spec.mode == Mode::Regex && regex.is_none(),
            regex,
            text: if spec.case_sensitive {
                spec.text.clone()
            } else {
                spec.text.to_lowercase()
            },
            exact: spec.mode == Mode::Exact,
            sensitive: spec.case_sensitive,
        })
    }

    /// Where the text stands in a value (bytes), or `None`.
    pub fn find(&self, value: &str) -> Option<(usize, usize)> {
        if self.blind {
            return None;
        }
        if let Some(regex) = &self.regex {
            return regex.find(value).map(|m| (m.start(), m.end()));
        }
        if self.sensitive {
            return self.place(value, value);
        }
        // lower case may be longer or shorter than the text: only when it is not, the place is the same
        let lower = value.to_lowercase();
        if lower.len() == value.len() {
            self.place(&lower, value)
        } else {
            self.place(&lower, &lower).map(|_| (0, 0))
        }
    }

    fn place(&self, hay: &str, original: &str) -> Option<(usize, usize)> {
        if self.exact {
            return (hay == self.text).then_some((0, original.len()));
        }
        let at = hay.find(&self.text)?;
        let end = at + self.text.len();
        (original.is_char_boundary(at) && original.is_char_boundary(end)).then_some((at, end))
    }
}

/// A piece of a value around a hit, on one line.
pub fn preview(value: &str, at: usize, end: usize) -> String {
    let before = PREVIEW_CHARS / 3;
    let start = value[..at]
        .char_indices()
        .rev()
        .nth(before.saturating_sub(1))
        .map_or(0, |(i, _)| i);
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    let _ = end;
    let mut rest = value[start..].chars();
    out.extend(
        rest.by_ref()
            .take(PREVIEW_CHARS)
            .map(|c| if c.is_control() { ' ' } else { c }),
    );
    if rest.next().is_some() {
        out.push('…');
    }
    out
}

/// The hit of a row: the first searched column that holds the text.
fn row_hit(row: &[Option<String>], columns: &[String], matcher: &Matcher) -> RowHit {
    for (value, column) in row.iter().zip(columns) {
        if let Some(value) = value
            && let Some((at, end)) = matcher.find(value)
        {
            return RowHit {
                column: column.clone(),
                preview: preview(value, at.min(value.len()), end.min(value.len())),
            };
        }
    }
    // the database found it where we do not (its own rules for letters, or behind what was read)
    RowHit {
        column: String::new(),
        preview: row
            .iter()
            .flatten()
            .next()
            .map(|v| preview(v, 0, 0))
            .unwrap_or_default(),
    }
}

/// The columns of the tables of a schema: table, column, type – in the order of the tables' columns.
fn columns_of(
    s: &mut dyn Session,
    kind: DbKind,
    schema: &str,
    stop: Stop,
) -> AppResult<Vec<(String, String, String)>> {
    let limit = Some(Duration::from_secs(30));
    let rows: TextRows = match kind {
        DbKind::Postgres => s.ask(
            "SELECT c.relname::text, a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod) \
             FROM pg_catalog.pg_attribute a \
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped \
               AND c.relkind IN ('r', 'p', 'm', 'f') \
             ORDER BY c.relname, a.attnum",
            &[schema],
            limit,
            stop,
        )?,
        DbKind::Mysql => s.ask(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
            &[schema],
            limit,
            stop,
        )?,
        DbKind::Sqlserver => s.ask(
            "SELECT o.name, c.name, t.name FROM sys.columns c \
             JOIN sys.objects o ON o.object_id = c.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             JOIN sys.types t ON t.user_type_id = c.user_type_id \
             WHERE s.name = @P1 AND o.type = 'U' ORDER BY o.name, c.column_id",
            &[schema],
            limit,
            stop,
        )?,
        DbKind::Sqlite => s.ask(
            "SELECT m.name, p.name, p.type FROM sqlite_master m, pragma_table_info(m.name) p \
             WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY m.name, p.cid",
            &[],
            limit,
            stop,
        )?,
        DbKind::Trino => s.ask(
            "SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c \
             JOIN information_schema.tables t \
               ON t.table_schema = c.table_schema AND t.table_name = c.table_name \
             WHERE c.table_schema = ? AND t.table_type = 'BASE TABLE' \
             ORDER BY c.table_name, c.ordinal_position",
            &[schema],
            limit,
            stop,
        )?,
        DbKind::Clickhouse => s.ask(
            "SELECT c.table, c.name, c.type FROM system.columns c \
             WHERE c.database = {p1:String} AND c.table NOT LIKE '.inner%' \
               AND (c.database, c.table) IN (SELECT database, name FROM system.tables \
                 WHERE engine NOT LIKE '%View' AND NOT is_temporary) \
             ORDER BY c.table, c.position",
            &[schema],
            limit,
            stop,
        )?,
        DbKind::Duckdb => s.ask(
            "SELECT c.table_name, c.column_name, c.data_type FROM duckdb_columns() c \
             JOIN duckdb_tables() t ON t.database_name = c.database_name \
               AND t.schema_name = c.schema_name AND t.table_name = c.table_name \
             WHERE c.database_name = current_database() AND c.schema_name = $1 AND NOT t.internal \
             ORDER BY c.table_name, c.column_index",
            &[schema],
            limit,
            stop,
        )?,
        DbKind::Oracle => s.ask(
            "SELECT c.table_name, c.column_name, c.data_type FROM all_tab_cols c \
             JOIN all_tables t ON t.owner = c.owner AND t.table_name = c.table_name \
             WHERE c.owner = :1 AND c.hidden_column = 'NO' AND c.table_name NOT LIKE 'BIN$%' \
             ORDER BY c.table_name, c.column_id",
            &[schema],
            limit,
            stop,
        )?,
    };
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let mut cells = row.into_iter();
            Some((
                cells.next()??,
                cells.next()??,
                cells.next()?.unwrap_or_default(),
            ))
        })
        .collect())
}

/// The questions that read definitions of a schema: each answers with kind, name, text.
pub(super) fn source_questions(kind: DbKind, flavor: Flavor) -> Vec<&'static str> {
    match kind {
        DbKind::Postgres => {
            let mut all = vec![
                "SELECT CASE c.relkind WHEN 'm' THEN 'matview' ELSE 'view' END, c.relname::text, \
                   pg_catalog.pg_get_viewdef(c.oid, true) \
                 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')",
                "SELECT 'routine', p.proname::text, pg_catalog.pg_get_functiondef(p.oid) \
                 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')",
                "SELECT 'check', c.relname::text || '.' || k.conname::text, \
                   pg_catalog.pg_get_constraintdef(k.oid) \
                 FROM pg_catalog.pg_constraint k \
                 JOIN pg_catalog.pg_class c ON c.oid = k.conrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND k.contype = 'c'",
                "SELECT 'default', c.relname::text || '.' || a.attname::text, \
                   pg_catalog.pg_get_expr(d.adbin, d.adrelid) \
                 FROM pg_catalog.pg_attrdef d \
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum \
                 JOIN pg_catalog.pg_class c ON c.oid = d.adrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')",
                "SELECT 'comment', c.relname::text, pg_catalog.obj_description(c.oid, 'pg_class') \
                 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
                   AND pg_catalog.obj_description(c.oid, 'pg_class') IS NOT NULL",
            ];
            if flavor != Flavor::Cockroach {
                all.push(
                    "SELECT 'trigger', c.relname::text || '.' || t.tgname::text, \
                       pg_catalog.pg_get_triggerdef(t.oid) \
                     FROM pg_catalog.pg_trigger t \
                     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = $1 AND NOT t.tgisinternal",
                );
            }
            all
        }
        DbKind::Mysql => vec![
            "SELECT 'view', TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS \
             WHERE TABLE_SCHEMA = ?",
            "SELECT 'routine', ROUTINE_NAME, ROUTINE_DEFINITION FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = ?",
            "SELECT 'trigger', CONCAT(EVENT_OBJECT_TABLE, '.', TRIGGER_NAME), ACTION_STATEMENT \
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?",
            // with its table (the catalog of checks itself does not name it in MySQL)
            "SELECT 'check', CONCAT(tc.TABLE_NAME, '.', cc.CONSTRAINT_NAME), cc.CHECK_CLAUSE \
             FROM information_schema.CHECK_CONSTRAINTS cc \
             JOIN information_schema.TABLE_CONSTRAINTS tc \
               ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA \
              AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_TYPE = 'CHECK' \
             WHERE cc.CONSTRAINT_SCHEMA = ?",
            "SELECT 'default', CONCAT(TABLE_NAME, '.', COLUMN_NAME), COLUMN_DEFAULT \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_DEFAULT IS NOT NULL",
            "SELECT 'comment', TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_COMMENT <> ''",
        ],
        DbKind::Sqlserver => vec![
            "SELECT CASE RTRIM(o.type) WHEN 'V' THEN 'view' WHEN 'TR' THEN 'trigger' ELSE 'routine' END, \
               o.name, m.definition \
             FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @P1",
            "SELECT 'check', t.name + '.' + c.name, c.definition FROM sys.check_constraints c \
             JOIN sys.objects t ON t.object_id = c.parent_object_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = @P1",
            "SELECT 'default', t.name + '.' + col.name, d.definition FROM sys.default_constraints d \
             JOIN sys.objects t ON t.object_id = d.parent_object_id \
             JOIN sys.columns col ON col.object_id = d.parent_object_id \
               AND col.column_id = d.parent_column_id \
             JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = @P1",
        ],
        // a table's statement holds its checks and defaults
        DbKind::Sqlite => vec![
            "SELECT type, name, sql FROM sqlite_master \
             WHERE sql IS NOT NULL AND type IN ('view', 'trigger', 'table') AND ?1 = ?1",
        ],
        DbKind::Trino => vec![
            "SELECT 'view', table_name, view_definition FROM information_schema.views \
             WHERE table_schema = ?",
        ],
        DbKind::Clickhouse => vec![
            "SELECT if(engine LIKE '%View', 'view', 'table'), name, create_table_query \
             FROM system.tables \
             WHERE database = {p1:String} AND NOT is_temporary AND name NOT LIKE '.inner%'",
        ],
        // a table's statement holds its checks and defaults
        DbKind::Duckdb => vec![
            "SELECT 'view', view_name, sql FROM duckdb_views() \
             WHERE database_name = current_database() AND schema_name = $1 AND NOT internal",
            "SELECT 'table', table_name, sql FROM duckdb_tables() \
             WHERE database_name = current_database() AND schema_name = $1 AND NOT internal",
        ],
        // the text of a view and the body of a trigger are LONGs: read whole, searched here. The
        // source of routines comes line by line and is put together again
        DbKind::Oracle => vec![
            "SELECT 'view', v.view_name, v.text FROM all_views v WHERE v.owner = :1",
            "SELECT 'trigger', t.table_name || '.' || t.trigger_name, t.trigger_body \
             FROM all_triggers t WHERE t.owner = :1",
            "SELECT 'routine', s.name, \
               XMLCAST(XMLAGG(XMLELEMENT(e, s.text) ORDER BY s.line) AS CLOB) \
             FROM all_source s \
             WHERE s.owner = :1 AND s.type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY') \
             GROUP BY s.name, s.type",
            "SELECT 'check', c.table_name || '.' || c.constraint_name, c.search_condition \
             FROM all_constraints c WHERE c.owner = :1 AND c.constraint_type = 'C' \
               AND c.generated = 'USER NAME'",
        ],
    }
}

/// The lines of a definition that hold the text.
fn source_hits(
    kind: &str,
    schema: &str,
    object: &str,
    text: &str,
    matcher: &Matcher,
    out: &mut Vec<SourceHit>,
    budget: usize,
) {
    for (n, line) in text.lines().enumerate() {
        if out.len() > budget {
            return;
        }
        if let Some((at, end)) = matcher.find(line) {
            out.push(SourceHit {
                kind: kind.to_owned(),
                schema: schema.to_owned(),
                name: object.to_owned(),
                line: n + 1,
                preview: preview(line, at.min(line.len()), end.min(line.len())),
            });
        }
    }
}

/// A table to search: schema, name, the rows the server estimates, its columns with their types.
type Target = (String, String, Option<u64>, Vec<(String, String)>);

fn checked(spec: &FindSpec) -> AppResult<()> {
    let chars = spec.text.chars().count();
    if chars == 0 || chars > MAX_TEXT_CHARS {
        return Err(invalid("the text to search for is empty or too long"));
    }
    if spec.text.contains('\0') {
        return Err(invalid(
            "the text to search for holds a character no database takes",
        ));
    }
    Ok(())
}

/// Searches the server. `tell` hears what is found as it is found; what was told stays told when the
/// search is stopped (`stop`) or the connection is lost.
///
/// `resume`: go on with the rows of the tables from this one on (after a connection was lost: see
/// [`FindReport::resume`]) – names and definitions were searched already.
pub fn find(
    s: &mut dyn Session,
    kind: DbKind,
    spec: &FindSpec,
    resume: Option<usize>,
    tell: &dyn Fn(FindEvent),
    stop: Stop,
) -> AppResult<FindReport> {
    checked(spec)?;
    // said before anything is searched, not at the first table
    if spec.data && spec.mode == Mode::Regex && matches!(kind, DbKind::Sqlserver | DbKind::Sqlite) {
        return Err(AppError::new(
            ErrorCode::Unsupported,
            "this database has no regular expressions",
        ));
    }
    let matcher = Matcher::new(spec)?;
    // for the sources: a value "is" never a whole definition
    let within = Matcher::new(&FindSpec {
        mode: if spec.mode == Mode::Regex {
            Mode::Regex
        } else {
            Mode::Contains
        },
        ..spec.clone()
    })?;
    let mut report = FindReport::default();
    let schemas: Vec<String> = if spec.schemas.is_empty() {
        meta::schemas(s, kind, stop)?
            .into_iter()
            .filter(|x| !x.system)
            .map(|x| x.name)
            .collect()
    } else {
        spec.schemas.clone()
    };
    let ended = |e: &AppError, s: &dyn Session, report: &mut FindReport| -> bool {
        if e.code == ErrorCode::Cancelled {
            report.cancelled = true;
            return true;
        }
        if !s.is_open() {
            report.lost = true;
            return true;
        }
        false
    };

    if spec.names && resume.is_none() {
        match meta::search(s, kind, &spec.text, stop) {
            Ok(found) => {
                for f in found.into_iter().filter(|f| schemas.contains(&f.schema)) {
                    report.sources += 1;
                    tell(FindEvent::Source {
                        hit: SourceHit {
                            kind: "name".to_owned(),
                            schema: f.schema,
                            preview: f.name.clone(),
                            name: f.name,
                            line: 0,
                        },
                    });
                }
            }
            Err(e) if ended(&e, s, &mut report) => return Ok(report),
            Err(_) => {}
        }
    }

    if spec.sources && resume.is_none() {
        let questions = source_questions(kind, s.flavor());
        'schemas: for schema in &schemas {
            for sql in &questions {
                if stop() {
                    report.cancelled = true;
                    return Ok(report);
                }
                let rows = match s.ask(sql, &[schema], Some(Duration::from_secs(60)), stop) {
                    Ok(rows) => rows,
                    Err(e) if ended(&e, s, &mut report) => return Ok(report),
                    // a catalog that does not have this (an older server), or may not be read: the
                    // other kinds go on, and it is said that this one was not searched
                    Err(e) => {
                        tell(FindEvent::Skipped {
                            schema: schema.clone(),
                            name: String::new(),
                            reason: Skip::Refused,
                            message: e.message,
                        });
                        continue;
                    }
                };
                let mut hits = Vec::new();
                let budget = MAX_SOURCE_HITS.saturating_sub(report.sources);
                for row in rows {
                    let [Some(what), Some(object), Some(text)] = row.as_slice() else {
                        continue;
                    };
                    source_hits(what, schema, object, text, &within, &mut hits, budget);
                }
                for hit in hits {
                    if report.sources >= MAX_SOURCE_HITS {
                        report.more_sources = true;
                        break 'schemas;
                    }
                    report.sources += 1;
                    tell(FindEvent::Source { hit });
                }
            }
        }
    }

    if !spec.data {
        return Ok(report);
    }
    // the tables first, so the progress knows how many there are
    let mut tables: Vec<Target> = Vec::new();
    for schema in &schemas {
        if stop() {
            report.cancelled = true;
            return Ok(report);
        }
        let objects = match meta::objects(s, kind, schema, stop) {
            Ok(objects) => objects,
            Err(e) if ended(&e, s, &mut report) => return Ok(report),
            Err(e) => {
                report.skipped += 1;
                tell(FindEvent::Skipped {
                    schema: schema.clone(),
                    name: String::new(),
                    reason: Skip::Refused,
                    message: e.message,
                });
                continue;
            }
        };
        let columns = match columns_of(s, kind, schema, stop) {
            Ok(columns) => columns,
            Err(e) if ended(&e, s, &mut report) => return Ok(report),
            Err(e) => {
                report.skipped += 1;
                tell(FindEvent::Skipped {
                    schema: schema.clone(),
                    name: String::new(),
                    reason: Skip::Refused,
                    message: e.message,
                });
                continue;
            }
        };
        for object in objects
            .into_iter()
            .filter(|o| matches!(o.kind, ObjectKind::Table | ObjectKind::Matview))
        {
            if !spec.tables.is_empty()
                && !spec
                    .tables
                    .iter()
                    .any(|(sc, t)| sc == schema && *t == object.name)
            {
                continue;
            }
            let own: Vec<(String, String)> = columns
                .iter()
                .filter(|(table, _, _)| *table == object.name)
                .map(|(_, column, type_name)| (column.clone(), type_name.clone()))
                .collect();
            tables.push((
                schema.clone(),
                object.name,
                object.rows.and_then(|n| u64::try_from(n).ok()),
                own,
            ));
        }
    }
    report.tables = tables.len();
    if resume.is_none() {
        tell(FindEvent::Start {
            tables: tables.len(),
        });
    }
    let from = resume.unwrap_or(0);
    let timeout = (spec.table_timeout_ms > 0).then(|| Duration::from_millis(spec.table_timeout_ms));
    for (done, (schema, table, rows, columns)) in tables.into_iter().enumerate().skip(from) {
        if stop() {
            report.cancelled = true;
            break;
        }
        tell(FindEvent::Table {
            done,
            schema: schema.clone(),
            table: table.clone(),
        });
        let skip = |report: &mut FindReport, reason: Skip, message: String| {
            report.skipped += 1;
            tell(FindEvent::Skipped {
                schema: schema.clone(),
                name: table.clone(),
                reason,
                message,
            });
        };
        if spec.skip_rows_over > 0 && rows.is_some_and(|n| n > spec.skip_rows_over) {
            skip(
                &mut report,
                Skip::Large,
                rows.unwrap_or_default().to_string(),
            );
            continue;
        }
        let (question, searched) = match data_question(kind, &schema, &table, &columns, spec) {
            Ok(Some(found)) => found,
            Ok(None) => {
                skip(&mut report, Skip::NoColumns, String::new());
                continue;
            }
            // a name the app does not write: this table is left out, the others are searched
            Err(e) => {
                skip(&mut report, Skip::Refused, e.message);
                continue;
            }
        };
        let wanted = spec.max_hits.clamp(1, 1_000) as usize;
        // as a statement of the driver – not as a question of the app –, so that a table that takes
        // too long is stopped **on the server** and the session goes on where the driver can do that
        let binds: Vec<Bind> = question.params.iter().cloned().map(Bind::Text).collect();
        let mut sink = VecSink::new(wanted + 1);
        let limits = Limits {
            max_rows: wanted + 1,
            timeout,
        };
        match s.execute_bound(&question.sql, &binds, limits, &mut sink, stop) {
            Ok(_) => {
                report.searched += 1;
                let mut found: TextRows = sink
                    .rows
                    .into_iter()
                    .map(|row| {
                        row.into_iter()
                            .map(|cell| match cell {
                                Cell::Text(t) => Some(t),
                                _ => None,
                            })
                            .collect()
                    })
                    .collect();
                let more = found.len() > wanted;
                found.truncate(wanted);
                if !found.is_empty() {
                    report.rows += found.len();
                    tell(FindEvent::Rows {
                        schema: schema.clone(),
                        table: table.clone(),
                        hits: found
                            .iter()
                            .map(|row| row_hit(row, &searched, &matcher))
                            .collect(),
                        more,
                    });
                }
            }
            Err(e) => {
                if e.code == ErrorCode::Cancelled {
                    report.cancelled = true;
                    break;
                }
                skip(
                    &mut report,
                    if e.code == ErrorCode::Timeout {
                        Skip::Timeout
                    } else {
                        Skip::Refused
                    },
                    e.message,
                );
                if !s.is_open() {
                    // the driver could stop the statement only by dropping the connection: the
                    // search goes on behind this table on a new one
                    report.lost = true;
                    report.resume = Some(done + 1);
                    break;
                }
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;
    use std::sync::Mutex;

    const ALL: [DbKind; 4] = [
        DbKind::Postgres,
        DbKind::Mysql,
        DbKind::Sqlserver,
        DbKind::Sqlite,
    ];

    fn spec(text: &str) -> FindSpec {
        FindSpec {
            text: text.into(),
            mode: Mode::Contains,
            case_sensitive: false,
            columns: Columns::Text,
            schemas: Vec::new(),
            tables: Vec::new(),
            data: true,
            sources: false,
            names: false,
            max_hits: 20,
            table_timeout_ms: 0,
            skip_rows_over: 0,
        }
    }

    fn cols(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(c, t)| ((*c).to_owned(), (*t).to_owned()))
            .collect()
    }

    #[test]
    fn sorts_columns_by_what_they_hold() {
        for t in [
            "text",
            "character varying(20)",
            "nvarchar",
            "json",
            "uuid",
            "enum('a','b')",
            "",
        ] {
            assert_eq!(class_of(t), ColumnClass::Text, "{t}");
        }
        for t in [
            "integer",
            "bigint",
            "numeric(12,2)",
            "double precision",
            "money",
        ] {
            assert_eq!(class_of(t), ColumnClass::Number, "{t}");
        }
        for t in ["bytea", "longblob", "varbinary", "image", "geometry"] {
            assert_eq!(class_of(t), ColumnClass::Binary, "{t}");
        }
        for t in ["date", "timestamp with time zone", "boolean", "interval"] {
            assert_eq!(class_of(t), ColumnClass::Other, "{t}");
        }
    }

    #[test]
    fn the_text_is_bound_and_its_wildcards_are_characters() {
        assert_eq!(like_pattern("50%_off!", DbKind::Postgres), "%50!%!_off!!%");
        assert_eq!(like_pattern("a[b]", DbKind::Sqlserver), "%a![b]%");
        assert_eq!(like_pattern("a[b]", DbKind::Mysql), "%a[b]%");
        let columns = cols(&[
            ("id", "integer"),
            ("name", "text"),
            ("note\"; DROP TABLE t; --", "varchar(20)"),
            ("photo", "bytea"),
            ("made", "date"),
        ]);
        let evil = "x' OR '1'='1'; DROP TABLE people; --";
        for kind in ALL {
            let (q, searched) = data_question(kind, "shop", "people", &columns, &spec(evil))
                .unwrap()
                .unwrap();
            // texts only: two columns, each bound once – and the text is nowhere in the statement
            assert_eq!(searched.len(), 2, "{kind:?}");
            assert_eq!(q.params.len(), 2, "{kind:?}");
            assert!(q.params.iter().all(|p| p.contains("DROP TABLE people")));
            assert!(!q.sql.contains("DROP TABLE people"), "{kind:?}: {}", q.sql);
            assert!(!q.sql.contains("1'='1"), "{kind:?}");
            assert_eq!(q.sql.matches("SELECT").count(), 1, "{kind:?}");
            // one more than the hits that are wanted
            assert!(q.sql.contains("21"), "{kind:?}: {}", q.sql);
        }
        let pg = |s: &FindSpec| {
            data_question(DbKind::Postgres, "shop", "people", &columns, s)
                .unwrap()
                .unwrap()
        };
        assert_eq!(
            pg(&spec("a_b")).0.sql,
            "SELECT LEFT(CAST(name AS text), 4000), LEFT(CAST(\"note\"\"; DROP TABLE t; --\" AS text), 4000) \
             FROM shop.people WHERE CAST(name AS text) ILIKE $1 ESCAPE '!' \
             OR CAST(\"note\"\"; DROP TABLE t; --\" AS text) ILIKE $2 ESCAPE '!' LIMIT 21"
        );
        assert_eq!(pg(&spec("a_b")).0.params, ["%a!_b%", "%a!_b%"]);
        // numbers too, everything but binary data
        let numbers = FindSpec {
            columns: Columns::Numbers,
            ..spec("4")
        };
        assert_eq!(pg(&numbers).1, ["id", "name", "note\"; DROP TABLE t; --"]);
        let all = FindSpec {
            columns: Columns::All,
            ..spec("4")
        };
        assert_eq!(pg(&all).1.len(), 4);
        // exact and regex are not patterns: the text as it is
        let exact = FindSpec {
            mode: Mode::Exact,
            case_sensitive: true,
            ..spec("50%")
        };
        assert_eq!(pg(&exact).0.params[0], "50%");
        assert!(pg(&exact).0.sql.contains("CAST(name AS text) = $1"));
        let regex = FindSpec {
            mode: Mode::Regex,
            ..spec("^a.*z$")
        };
        assert!(pg(&regex).0.sql.contains("CAST(name AS text) ~* $1"));
        for kind in [DbKind::Sqlserver, DbKind::Sqlite] {
            let refused = data_question(kind, "s", "t", &columns, &regex).unwrap_err();
            assert_eq!(refused.code, ErrorCode::Unsupported);
        }
        // a table with nothing to search
        assert_eq!(
            data_question(
                DbKind::Postgres,
                "s",
                "t",
                &cols(&[("id", "integer"), ("photo", "bytea")]),
                &spec("x")
            )
            .unwrap(),
            None
        );
        // SQL Server limits with TOP
        let ms = data_question(DbKind::Sqlserver, "dbo", "people", &columns, &spec("x"))
            .unwrap()
            .unwrap();
        assert!(
            ms.0.sql
                .starts_with("SELECT TOP (21) LEFT(CAST(name AS nvarchar(max)), 4000)")
        );
        assert!(
            ms.0.sql
                .contains("COLLATE Latin1_General_100_CI_AS LIKE @P1 ESCAPE '!'")
        );
        assert!(checked(&spec("")).is_err());
        assert!(checked(&spec(&"x".repeat(MAX_TEXT_CHARS + 1))).is_err());
        assert!(checked(&spec("a\0b")).is_err());
    }

    #[test]
    fn finds_the_place_of_a_hit_and_cuts_a_preview() {
        let m = Matcher::new(&spec("müller")).unwrap();
        assert_eq!(m.find("Herr MÜLLER & Söhne"), Some((5, 12)));
        assert_eq!(m.find("nobody"), None);
        let exact = Matcher::new(&FindSpec {
            mode: Mode::Exact,
            case_sensitive: true,
            ..spec("Ada")
        })
        .unwrap();
        assert_eq!(exact.find("Ada"), Some((0, 3)));
        assert_eq!(exact.find("ada"), None);
        assert_eq!(exact.find("Ada Lovelace"), None);
        let regex = Matcher::new(&FindSpec {
            mode: Mode::Regex,
            ..spec("o+l")
        })
        .unwrap();
        assert_eq!(regex.find("a COOL thing"), Some((3, 6)));
        // what is no expression of ours is the server's to judge: here it finds no place
        assert_eq!(
            Matcher::new(&FindSpec {
                mode: Mode::Regex,
                ..spec("(")
            })
            .unwrap()
            .find("("),
            None
        );
        // a preview is one line around the hit
        let long = format!("{}needle\nnext line{}", "a".repeat(500), "b".repeat(500));
        let p = preview(&long, 500, 506);
        assert!(p.starts_with('…') && p.ends_with('…'), "{p}");
        assert!(p.contains("needle next line"));
        assert!(p.chars().count() <= PREVIEW_CHARS + 2);
        assert_eq!(preview("short", 0, 5), "short");
    }

    fn demo() -> sqlite::Lite {
        let mut s = sqlite::open(&sqlite::demo_profile()).unwrap();
        s.execute_batch_for_tests(
            "CREATE TABLE f_people (id INTEGER PRIMARY KEY, name TEXT, mail TEXT, photo BLOB);
             INSERT INTO f_people VALUES (1, 'Max Mustermann', 'max.mustermann@example.com', x'00');
             INSERT INTO f_people VALUES (2, 'Erika', 'erika@example.com', NULL);
             INSERT INTO f_people VALUES (3, '100% sure_thing', NULL, NULL);
             CREATE TABLE f_orders (id INTEGER PRIMARY KEY, note TEXT, old_price NUMERIC DEFAULT 0);
             INSERT INTO f_orders VALUES (42, 'for MAX.mustermann@example.com', 12.5);
             CREATE TABLE f_empty (id INTEGER PRIMARY KEY, photo BLOB);
             CREATE VIEW f_prices AS SELECT id,
               old_price * 2 AS doubled FROM f_orders;
             CREATE TRIGGER f_touch AFTER UPDATE ON f_orders BEGIN
               UPDATE f_orders SET old_price = old.old_price WHERE id = new.id;
             END;",
        );
        s
    }

    fn run(s: &mut sqlite::Lite, spec: &FindSpec) -> (FindReport, Vec<FindEvent>) {
        let events = Mutex::new(Vec::new());
        let report = find(
            s,
            DbKind::Sqlite,
            spec,
            None,
            &|e| events.lock().unwrap().push(e),
            &|| false,
        )
        .unwrap();
        (report, events.into_inner().unwrap())
    }

    fn rows_of(events: &[FindEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                FindEvent::Rows { table, hits, .. } => Some(
                    hits.iter()
                        .map(|h| format!("{table}.{}: {}", h.column, h.preview))
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .flatten()
            .filter(|line| line.starts_with("f_"))
            .collect()
    }

    #[test]
    fn finds_a_text_in_the_rows_of_all_tables() {
        let mut s = demo();
        let (report, events) = run(&mut s, &spec("max.mustermann@example.com"));
        assert_eq!(
            rows_of(&events),
            [
                "f_orders.note: for MAX.mustermann@example.com",
                "f_people.mail: max.mustermann@example.com"
            ]
        );
        assert!(report.searched >= 2 && !report.cancelled && !report.lost);
        // a table with nothing but binary data is named as left out
        assert!(events.iter().any(|e| matches!(
            e,
            FindEvent::Skipped { name, reason: Skip::NoColumns, .. } if name == "f_empty"
        )));
        // with case
        let sensitive = FindSpec {
            case_sensitive: true,
            ..spec("max.mustermann@example.com")
        };
        assert_eq!(
            rows_of(&run(&mut s, &sensitive).1),
            ["f_people.mail: max.mustermann@example.com"]
        );
        // % and _ are characters
        assert_eq!(
            rows_of(&run(&mut s, &spec("100%")).1),
            ["f_people.name: 100% sure_thing"]
        );
        assert_eq!(rows_of(&run(&mut s, &spec("sure_")).1).len(), 1);
        assert_eq!(rows_of(&run(&mut s, &spec("%")).1).len(), 1);
        assert_eq!(rows_of(&run(&mut s, &spec("_")).1).len(), 1);
        // numbers only when asked for; exact
        assert!(rows_of(&run(&mut s, &spec("12.5")).1).is_empty());
        let numbers = FindSpec {
            columns: Columns::Numbers,
            mode: Mode::Exact,
            ..spec("12.5")
        };
        assert_eq!(
            rows_of(&run(&mut s, &numbers).1),
            ["f_orders.old_price: 12.5"]
        );
        // only one table
        let one = FindSpec {
            tables: vec![("main".into(), "f_people".into())],
            ..spec("example.com")
        };
        let (report, events) = run(&mut s, &one);
        assert_eq!(report.tables, 1);
        assert_eq!(rows_of(&events).len(), 2);
        // a limit of hits: the rest is said to be there
        let few = FindSpec { max_hits: 1, ..one };
        assert!(run(&mut s, &few).1.iter().any(|e| matches!(
            e,
            FindEvent::Rows { hits, more: true, .. } if hits.len() == 1
        )));
    }

    #[test]
    fn finds_a_text_in_definitions_and_names() {
        let mut s = demo();
        let sources = FindSpec {
            data: false,
            sources: true,
            names: true,
            ..spec("old_price")
        };
        let (report, events) = run(&mut s, &sources);
        let found: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                FindEvent::Source { hit } => {
                    Some(format!("{} {} :{}", hit.kind, hit.name, hit.line))
                }
                _ => None,
            })
            .collect();
        assert!(found.contains(&"view f_prices :2".to_owned()), "{found:?}");
        assert!(
            found.contains(&"trigger f_touch :2".to_owned()),
            "{found:?}"
        );
        assert!(found.contains(&"table f_orders :1".to_owned()), "{found:?}");
        assert_eq!(report.sources, found.len());
        assert_eq!(report.tables, 0);
        let names = FindSpec {
            data: false,
            names: true,
            ..spec("f_pric")
        };
        let (_, events) = run(&mut s, &names);
        assert!(events.iter().any(|e| matches!(
            e,
            FindEvent::Source { hit } if hit.kind == "name" && hit.name == "f_prices"
        )));
    }

    #[test]
    fn stops_when_asked_and_keeps_what_was_found() {
        let mut s = demo();
        let mut sql = String::new();
        for i in 0..300 {
            sql.push_str(&format!(
                "CREATE TABLE g_{i:03} (t TEXT); INSERT INTO g_{i:03} VALUES ('needle {i}');"
            ));
        }
        s.execute_batch_for_tests(&sql);
        let seen = Mutex::new(Vec::new());
        let stop = || {
            seen.lock()
                .unwrap()
                .iter()
                .filter(|e| matches!(e, FindEvent::Rows { .. }))
                .count()
                >= 5
        };
        let report = find(
            &mut s,
            DbKind::Sqlite,
            &spec("needle"),
            None,
            &|e| seen.lock().unwrap().push(e),
            &stop,
        )
        .unwrap();
        assert!(report.cancelled);
        assert!(report.tables >= 300);
        assert!(report.rows >= 5 && report.rows < 300, "{report:?}");
        // large tables are left out when asked – by what the server estimates (SQLite gives no number)
        let events = seen.into_inner().unwrap();
        assert!(
            matches!(events.iter().find(|e| matches!(e, FindEvent::Start { .. })), Some(FindEvent::Start { tables }) if *tables >= 300)
        );
    }
    /// Review 036: one name the app does not write (longer than any server allows but SQLite) leaves
    /// out that table – not the search.
    #[test]
    fn a_table_that_cannot_be_asked_is_left_out_and_the_search_goes_on() {
        let mut s = demo();
        let long = "n".repeat(300);
        s.execute_batch_for_tests(&format!(
            "CREATE TABLE f_odd (\"{long}\" TEXT); INSERT INTO f_odd VALUES ('needle');
             CREATE TABLE f_zz (t TEXT); INSERT INTO f_zz VALUES ('needle');"
        ));
        let (report, events) = run(&mut s, &spec("needle"));
        assert!(events.iter().any(|e| matches!(
            e,
            FindEvent::Skipped { name, reason: Skip::Refused, .. } if name == "f_odd"
        )));
        assert_eq!(rows_of(&events), ["f_zz.t: needle"]);
        assert!(report.skipped >= 1 && !report.lost);
    }

    /// Review 036: what a database cannot do is said before anything is searched; a regular expression
    /// only the server understands still finds its rows.
    #[test]
    fn regular_expressions_are_refused_early_or_left_to_the_server() {
        let mut s = demo();
        let regex = FindSpec {
            mode: Mode::Regex,
            sources: true,
            ..spec("old_.*")
        };
        let events = Mutex::new(Vec::new());
        let refused = find(
            &mut s,
            DbKind::Sqlite,
            &regex,
            None,
            &|e| events.lock().unwrap().push(e),
            &|| false,
        )
        .unwrap_err();
        assert_eq!(refused.code, ErrorCode::Unsupported);
        assert!(events.lock().unwrap().is_empty());
        // only in definitions: that is searched here, in every database
        let sources = FindSpec {
            data: false,
            ..regex
        };
        assert!(run(&mut s, &sources).0.sources > 0);
        // a back reference is no expression of ours: no place is found, nothing fails
        let theirs = Matcher::new(&FindSpec {
            mode: Mode::Regex,
            ..spec("(a)\\1")
        })
        .unwrap();
        assert_eq!(theirs.find("aa"), None);
    }

    /// Review 036: a search that lost its connection goes on behind the table it was at.
    #[test]
    fn goes_on_behind_a_table() {
        let mut s = demo();
        s.execute_batch_for_tests(
            "CREATE TABLE h_a (t TEXT); INSERT INTO h_a VALUES ('needle a');
             CREATE TABLE h_b (t TEXT); INSERT INTO h_b VALUES ('needle b');
             CREATE TABLE h_c (t TEXT); INSERT INTO h_c VALUES ('needle c');",
        );
        let only = FindSpec {
            sources: true,
            tables: vec![
                ("main".into(), "h_a".into()),
                ("main".into(), "h_b".into()),
                ("main".into(), "h_c".into()),
            ],
            ..spec("needle")
        };
        let events = Mutex::new(Vec::new());
        let report = find(
            &mut s,
            DbKind::Sqlite,
            &only,
            Some(2),
            &|e| events.lock().unwrap().push(e),
            &|| false,
        )
        .unwrap();
        let events = events.into_inner().unwrap();
        // no second start, no definitions again – only what is left
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, FindEvent::Start { .. } | FindEvent::Source { .. }))
        );
        let rows: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                FindEvent::Rows { table, .. } => Some(table.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(rows, ["h_c"]);
        assert_eq!(
            (report.tables, report.searched, report.resume),
            (3, 1, None)
        );
    }
}
