//! What is in a database (prompt 008): schemas, their objects, and the parts of a table – read from the
//! system catalog of each database with bound parameters ([`Session::ask`]), never by pasting a name into
//! SQL. And the one place that knows how a name is quoted in each dialect ([`quote`]).

use super::{DbKind, Session, Stop, TextRows};
use crate::error::AppResult;
use serde::Serialize;
use std::time::Duration;

/// A question to the catalog at most.
pub const META_TIMEOUT: Duration = Duration::from_secs(20);
/// Hits of a name search at most.
pub const MAX_FOUND: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    /// The name as it is written in SQL.
    pub quoted: String,
    /// A schema of the database itself (`pg_catalog`, `information_schema`, `sys` …).
    pub system: bool,
    /// Where unqualified names are looked up first.
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjectKind {
    Table,
    View,
    Matview,
    Routine,
    Sequence,
    Type,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfo {
    pub kind: ObjectKind,
    pub name: String,
    pub quoted: String,
    /// Arguments of a routine, the engine of a table, the sort of a type …
    pub detail: String,
    /// Rows as the statistics of the server estimate them; never counted.
    pub rows: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub quoted: String,
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    /// `pk`, `fk` or empty.
    pub key: String,
}

/// An index, a key or a trigger of a table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartInfo {
    pub name: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<PartInfo>,
    pub keys: Vec<PartInfo>,
    pub triggers: Vec<PartInfo>,
}

/// A hit of the name search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub schema: String,
    pub kind: ObjectKind,
    pub name: String,
    pub quoted: String,
}

// --- quoting ---------------------------------------------------------------------------------------

/// Words that are quoted as names in every dialect. Quoting too often is harmless, too rarely is not: the
/// list is the union of what the four databases reserve, as far as it is common in names.
const RESERVED: &[&str] = &[
    "add",
    "all",
    "alter",
    "analyze",
    "and",
    "any",
    "array",
    "as",
    "asc",
    "authorization",
    "begin",
    "between",
    "binary",
    "both",
    "by",
    "call",
    "case",
    "cast",
    "change",
    "character",
    "check",
    "collate",
    "column",
    "commit",
    "condition",
    "constraint",
    "convert",
    "create",
    "cross",
    "current",
    "current_date",
    "current_time",
    "current_timestamp",
    "current_user",
    "cursor",
    "database",
    "databases",
    "declare",
    "default",
    "delete",
    "desc",
    "distinct",
    "do",
    "double",
    "drop",
    "each",
    "else",
    "end",
    "escape",
    "except",
    "exec",
    "execute",
    "exists",
    "explain",
    "false",
    "fetch",
    "for",
    "foreign",
    "from",
    "full",
    "function",
    "grant",
    "group",
    "having",
    "identity",
    "if",
    "ignore",
    "in",
    "index",
    "inner",
    "insert",
    "intersect",
    "interval",
    "into",
    "is",
    "join",
    "key",
    "keys",
    "kill",
    "leading",
    "left",
    "like",
    "limit",
    "lock",
    "match",
    "merge",
    "natural",
    "no",
    "not",
    "null",
    "of",
    "offset",
    "on",
    "only",
    "open",
    "option",
    "or",
    "order",
    "outer",
    "over",
    "partition",
    "percent",
    "plan",
    "primary",
    "procedure",
    "public",
    "range",
    "rank",
    "read",
    "references",
    "rename",
    "replace",
    "return",
    "returning",
    "revoke",
    "right",
    "rollback",
    "row",
    "rows",
    "schema",
    "select",
    "session_user",
    "set",
    "show",
    "some",
    "table",
    "then",
    "to",
    "top",
    "trailing",
    "transaction",
    "trigger",
    "true",
    "union",
    "unique",
    "update",
    "usage",
    "use",
    "user",
    "using",
    "values",
    "view",
    "when",
    "where",
    "window",
    "with",
    "write",
];

/// Words Oracle reserves beyond the common ones (its documentation, „Oracle SQL Reserved Words“):
/// a column called `COMMENT` or `LEVEL` needs its quotes.
const ORACLE_RESERVED: &[&str] = &[
    "ACCESS",
    "ADD",
    "AUDIT",
    "CHAR",
    "CLUSTER",
    "COLUMN_VALUE",
    "COMMENT",
    "COMPRESS",
    "CONNECT",
    "CURRENT",
    "DATE",
    "DECIMAL",
    "EXCLUSIVE",
    "FILE",
    "FLOAT",
    "IDENTIFIED",
    "IMMEDIATE",
    "INCREMENT",
    "INITIAL",
    "INTEGER",
    "INTERSECT",
    "LEVEL",
    "LOCK",
    "LONG",
    "MAXEXTENTS",
    "MINUS",
    "MLSLABEL",
    "MODE",
    "MODIFY",
    "NESTED_TABLE_ID",
    "NOAUDIT",
    "NOCOMPRESS",
    "NOWAIT",
    "NUMBER",
    "OFFLINE",
    "ONLINE",
    "OPTION",
    "PCTFREE",
    "PRIOR",
    "PUBLIC",
    "RAW",
    "RENAME",
    "RESOURCE",
    "ROW",
    "ROWID",
    "ROWNUM",
    "ROWS",
    "SESSION",
    "SHARE",
    "SIZE",
    "SMALLINT",
    "START",
    "SUCCESSFUL",
    "SYNONYM",
    "SYSDATE",
    "TRIGGER",
    "UID",
    "VALIDATE",
    "VARCHAR",
    "VARCHAR2",
    "WHENEVER",
];

fn oracle_reserved(name: &str) -> bool {
    ORACLE_RESERVED.contains(&name.to_ascii_uppercase().as_str())
}

fn reserved(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    RESERVED.binary_search(&lower.as_str()).is_ok()
}

fn plain(name: &str, kind: DbKind) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let first_ok = match kind {
        // PostgreSQL folds unquoted names to lower case: an upper case letter needs quotes
        DbKind::Postgres => first.is_ascii_lowercase() || first == '_',
        // Oracle folds unquoted names to upper case: a lower case letter needs quotes
        DbKind::Oracle => first.is_ascii_uppercase(),
        _ => first.is_ascii_alphabetic() || first == '_',
    };
    let rest_ok = name.chars().all(|c| match kind {
        DbKind::Postgres => c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_',
        DbKind::Oracle => c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_',
        _ => c.is_ascii_alphanumeric() || c == '_',
    });
    first_ok && rest_ok && !reserved(name) && !(kind == DbKind::Oracle && oracle_reserved(name))
}

/// A name as it is written in SQL: as it is where that is safe, quoted otherwise (spaces, upper case in
/// PostgreSQL, umlauts, reserved words, quotes in the name).
pub fn quote(name: &str, kind: DbKind) -> String {
    if plain(name, kind) {
        return name.to_string();
    }
    quote_always(name, kind)
}

/// A name in quotes, whatever it is.
pub fn quote_always(name: &str, kind: DbKind) -> String {
    match kind {
        DbKind::Mysql => format!("`{}`", name.replace('`', "``")),
        DbKind::Sqlserver => format!("[{}]", name.replace(']', "]]")),
        DbKind::Postgres | DbKind::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
        // Oracle has no way to write a quote inside a quoted name (and allows none in a name): one that
        // came from somewhere else is dropped, so the name cannot end its quotes
        DbKind::Oracle => format!("\"{}\"", name.replace(['"', '\0'], "")),
    }
}

/// `text` as a pattern for `LIKE … ESCAPE '\'` that finds it anywhere in a name.
pub fn like_pattern(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('%');
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\' | '[') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

// --- reading ---------------------------------------------------------------------------------------

fn at(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

fn opt(row: &[Option<String>], i: usize) -> Option<String> {
    row.get(i).cloned().flatten()
}

fn truthy(row: &[Option<String>], i: usize) -> bool {
    matches!(
        at(row, i).to_ascii_lowercase().as_str(),
        "true" | "t" | "1" | "yes"
    )
}

fn ask(s: &mut dyn Session, sql: &str, params: &[&str], stop: Stop) -> AppResult<TextRows> {
    s.ask(sql, params, Some(META_TIMEOUT), stop)
}

fn object_kind(word: &str) -> Option<ObjectKind> {
    Some(match word.trim().to_ascii_lowercase().as_str() {
        "table" | "u" | "base table" | "system versioned" | "virtual" | "shadow" => {
            ObjectKind::Table
        }
        "view" | "v" | "system view" => ObjectKind::View,
        "matview" => ObjectKind::Matview,
        "routine" | "p" | "fn" | "if" | "tf" => ObjectKind::Routine,
        "sequence" | "so" => ObjectKind::Sequence,
        "type" => ObjectKind::Type,
        _ => return None,
    })
}

/// The schemas of the connection: of the database it is connected to (PostgreSQL, SQL Server), the
/// databases of the server (MySQL, MariaDB), the attached files (SQLite).
pub fn schemas(s: &mut dyn Session, kind: DbKind, stop: Stop) -> AppResult<Vec<SchemaInfo>> {
    let sql = match kind {
        DbKind::Postgres => {
            "SELECT n.nspname::text, \
             (n.nspname = 'information_schema' OR n.nspname LIKE 'pg\\_%' \
               OR n.nspname = 'crdb_internal' OR n.nspname LIKE '\\_timescaledb\\_%' \
               OR n.nspname IN ('timescaledb_information', 'timescaledb_experimental'))::text, \
             (n.nspname = current_schema())::text \
             FROM pg_catalog.pg_namespace n \
             WHERE n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast%' \
             ORDER BY 1"
        }
        DbKind::Mysql => {
            "SELECT SCHEMA_NAME, \
             CASE WHEN SCHEMA_NAME IN ('information_schema', 'mysql', 'performance_schema', 'sys') \
               THEN 'true' ELSE 'false' END, \
             CASE WHEN SCHEMA_NAME = DATABASE() THEN 'true' ELSE 'false' END \
             FROM information_schema.SCHEMATA ORDER BY 1"
        }
        DbKind::Sqlserver => {
            "SELECT s.name, \
             CASE WHEN s.name IN ('sys', 'INFORMATION_SCHEMA', 'guest') OR s.name LIKE 'db[_]%' \
               THEN 'true' ELSE 'false' END, \
             CASE WHEN s.name = SCHEMA_NAME() THEN 'true' ELSE 'false' END \
             FROM sys.schemas s ORDER BY 1"
        }
        DbKind::Sqlite => {
            "SELECT name, 'false', CASE WHEN name = 'main' THEN 'true' ELSE 'false' END \
             FROM pragma_database_list ORDER BY seq"
        }
        // a schema is a user; those Oracle ships are marked as its own
        DbKind::Oracle => {
            "SELECT u.username, CASE WHEN u.oracle_maintained = 'Y' THEN 'true' ELSE 'false' END, \
             CASE WHEN u.username = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 'true' ELSE 'false' END \
             FROM all_users u ORDER BY 1"
        }
    };
    Ok(ask(s, sql, &[], stop)?
        .iter()
        .map(|row| {
            let name = at(row, 0);
            SchemaInfo {
                quoted: quote(&name, kind),
                name,
                system: truthy(row, 1),
                current: truthy(row, 2),
            }
        })
        .collect())
}

fn object_rows(rows: &TextRows, kind: DbKind, out: &mut Vec<ObjectInfo>) {
    for row in rows {
        let Some(k) = object_kind(&at(row, 0)) else {
            continue;
        };
        let name = at(row, 1);
        out.push(ObjectInfo {
            kind: k,
            quoted: quote(&name, kind),
            name,
            detail: at(row, 2),
            rows: opt(row, 3)
                .and_then(|n| n.parse::<i64>().ok())
                .filter(|n| *n >= 0),
        });
    }
}

/// Everything in a schema, tables first, each sort by name.
pub fn objects(
    s: &mut dyn Session,
    kind: DbKind,
    schema: &str,
    stop: Stop,
) -> AppResult<Vec<ObjectInfo>> {
    let questions: &[&str] = match kind {
        DbKind::Postgres => &[
            "SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' \
               WHEN 'S' THEN 'sequence' ELSE 'table' END, \
             c.relname::text, \
             CASE c.relkind WHEN 'p' THEN 'partitioned' WHEN 'f' THEN 'foreign' ELSE '' END, \
             CASE WHEN c.relkind IN ('r', 'p', 'm') AND c.reltuples >= 0 \
               THEN c.reltuples::bigint::text END \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S') \
               AND c.relispartition IS NOT TRUE",
            "SELECT 'routine', p.proname::text, \
             pg_catalog.pg_get_function_identity_arguments(p.oid)::text, NULL::text \
             FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1",
            "SELECT 'type', t.typname::text, \
             CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain' WHEN 'r' THEN 'range' \
               ELSE 'composite' END, NULL::text \
             FROM pg_catalog.pg_type t \
             JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
             WHERE n.nspname = $1 AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND EXISTS \
               (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))",
        ],
        DbKind::Mysql => &[
            "SELECT CASE WHEN TABLE_TYPE = 'SEQUENCE' THEN 'sequence' \
               WHEN TABLE_TYPE LIKE '%VIEW' THEN 'view' ELSE 'table' END, \
             TABLE_NAME, COALESCE(ENGINE, ''), CAST(TABLE_ROWS AS CHAR) \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
            "SELECT 'routine', ROUTINE_NAME, LOWER(ROUTINE_TYPE), NULL \
             FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
        ],
        DbKind::Sqlserver => &[
            "SELECT RTRIM(o.type), o.name, \
             CASE RTRIM(o.type) WHEN 'P' THEN 'procedure' WHEN 'FN' THEN 'function' \
               WHEN 'IF' THEN 'function' WHEN 'TF' THEN 'function' ELSE '' END, \
             CASE WHEN o.type = 'U' THEN CAST((SELECT SUM(p.rows) FROM sys.partitions p \
               WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS varchar(30)) END \
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'SO')",
            "SELECT 'type', t.name, '', NULL \
             FROM sys.types t JOIN sys.schemas s ON s.schema_id = t.schema_id \
             WHERE s.name = @P1 AND t.is_user_defined = 1",
        ],
        DbKind::Sqlite => &["SELECT type, name, '', NULL FROM pragma_table_list \
             WHERE schema = ?1 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"],
        // a materialized view is also listed as a table of its name; dropped tables wait as BIN$…
        DbKind::Oracle => &[
            "SELECT CASE o.object_type WHEN 'TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' \
               WHEN 'MATERIALIZED VIEW' THEN 'matview' WHEN 'SEQUENCE' THEN 'sequence' \
               WHEN 'TYPE' THEN 'type' ELSE 'routine' END, o.object_name, \
             CASE WHEN o.object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE') \
               THEN LOWER(o.object_type) ELSE '' END, \
             CASE WHEN o.object_type = 'TABLE' THEN (SELECT TO_CHAR(t.num_rows) FROM all_tables t \
               WHERE t.owner = o.owner AND t.table_name = o.object_name) END \
             FROM all_objects o \
             WHERE o.owner = :1 AND o.object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SEQUENCE', \
               'TYPE', 'PROCEDURE', 'FUNCTION', 'PACKAGE') \
               AND o.object_name NOT LIKE 'BIN$%' AND o.generated = 'N' \
               AND NOT (o.object_type = 'TABLE' AND EXISTS (SELECT 1 FROM all_mviews m \
                 WHERE m.owner = o.owner AND m.mview_name = o.object_name))",
        ],
    };
    let mut out = Vec::new();
    for sql in questions {
        object_rows(&ask(s, sql, &[schema], stop)?, kind, &mut out);
    }
    out.sort_by(|a, b| {
        (a.kind as u8, a.name.to_lowercase(), &a.detail).cmp(&(
            b.kind as u8,
            b.name.to_lowercase(),
            &b.detail,
        ))
    });
    Ok(out)
}

fn parts(rows: &TextRows) -> Vec<PartInfo> {
    rows.iter()
        .map(|row| PartInfo {
            name: at(row, 0),
            detail: at(row, 1),
        })
        .collect()
}

fn pg_table(s: &mut dyn Session, schema: &str, table: &str, stop: Stop) -> AppResult<TableInfo> {
    const WHICH: &str = "FROM pg_catalog.pg_class c \
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
        WHERE n.nspname = $1 AND c.relname = $2";
    let p = &[schema, table];
    let columns = ask(
        s,
        "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), \
         (NOT a.attnotnull)::text, pg_catalog.pg_get_expr(d.adbin, d.adrelid), \
         CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid \
             AND k.contype = 'p' AND a.attnum = ANY (k.conkey)) THEN 'pk' \
           WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid \
             AND k.contype = 'f' AND a.attnum = ANY (k.conkey)) THEN 'fk' ELSE '' END \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
        p,
        stop,
    )?;
    let indexes = ask(
        s,
        &format!(
            "SELECT i.relname::text, \
             CASE WHEN x.indisprimary THEN 'primary ' WHEN x.indisunique THEN 'unique ' ELSE '' END \
               || regexp_replace(pg_catalog.pg_get_indexdef(x.indexrelid), '^.* USING ', '') \
             FROM pg_catalog.pg_index x \
             JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid \
             WHERE x.indrelid = (SELECT c.oid {WHICH}) ORDER BY 1"
        ),
        p,
        stop,
    )?;
    let keys = ask(
        s,
        &format!(
            "SELECT k.conname::text, pg_catalog.pg_get_constraintdef(k.oid) \
             FROM pg_catalog.pg_constraint k \
             WHERE k.conrelid = (SELECT c.oid {WHICH}) AND k.contype IN ('p', 'f', 'u', 'c') \
             ORDER BY CASE k.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, 1"
        ),
        p,
        stop,
    )?;
    // CockroachDB has no `pg_get_triggerdef`: its triggers are not listed (capability `triggers`)
    let triggers = if s.flavor() == super::Flavor::Cockroach {
        Default::default()
    } else {
        ask(
            s,
            &format!(
                "SELECT t.tgname::text, regexp_replace(pg_catalog.pg_get_triggerdef(t.oid), \
                   '^CREATE (CONSTRAINT )?TRIGGER \\S+ ', '') \
                 FROM pg_catalog.pg_trigger t \
                 WHERE t.tgrelid = (SELECT c.oid {WHICH}) AND NOT t.tgisinternal ORDER BY 1"
            ),
            p,
            stop,
        )?
    };
    Ok(TableInfo {
        columns: column_rows(&columns, DbKind::Postgres),
        indexes: parts(&indexes),
        keys: parts(&keys),
        triggers: parts(&triggers),
    })
}

/// Rows of name, type, nullable, default, key.
fn column_rows(rows: &TextRows, kind: DbKind) -> Vec<ColumnInfo> {
    rows.iter()
        .map(|row| {
            let name = at(row, 0);
            ColumnInfo {
                quoted: quote(&name, kind),
                name,
                type_name: at(row, 1),
                nullable: truthy(row, 2),
                default: opt(row, 3),
                key: at(row, 4),
            }
        })
        .collect()
}

fn mysql_table(s: &mut dyn Session, schema: &str, table: &str, stop: Stop) -> AppResult<TableInfo> {
    let p = &[schema, table];
    let columns = ask(
        s,
        "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, \
         CASE WHEN c.COLUMN_KEY = 'PRI' THEN 'pk' \
           WHEN EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k \
             WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
               AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL) THEN 'fk' \
           ELSE '' END \
         FROM information_schema.COLUMNS c \
         WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION",
        p,
        stop,
    )?;
    let indexes = ask(
        s,
        "SELECT INDEX_NAME, CONCAT(CASE WHEN INDEX_NAME = 'PRIMARY' THEN 'primary ' \
             WHEN MIN(NON_UNIQUE) = 0 THEN 'unique ' ELSE '' END, LOWER(MIN(INDEX_TYPE)), ' (', \
           COALESCE(GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), ''), ')') \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME ORDER BY 1",
        p,
        stop,
    )?;
    let keys = ask(
        s,
        "SELECT tc.CONSTRAINT_NAME, CONCAT(tc.CONSTRAINT_TYPE, \
           COALESCE(CONCAT(' (', GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION \
             SEPARATOR ', '), ')'), ''), \
           COALESCE(CONCAT(' REFERENCES ', MIN(k.REFERENCED_TABLE_NAME), ' (', \
             GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', '), \
             ')'), '')) \
         FROM information_schema.TABLE_CONSTRAINTS tc \
         LEFT JOIN information_schema.KEY_COLUMN_USAGE k \
           ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
           AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME \
         WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? \
         GROUP BY tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE \
         ORDER BY CASE tc.CONSTRAINT_TYPE WHEN 'PRIMARY KEY' THEN 0 WHEN 'UNIQUE' THEN 1 \
           WHEN 'FOREIGN KEY' THEN 2 ELSE 3 END, 1",
        p,
        stop,
    )?;
    let triggers = ask(
        s,
        "SELECT TRIGGER_NAME, CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION) \
         FROM information_schema.TRIGGERS \
         WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY 1",
        p,
        stop,
    )?;
    Ok(TableInfo {
        columns: column_rows(&columns, DbKind::Mysql),
        indexes: parts(&indexes),
        keys: parts(&keys),
        triggers: parts(&triggers),
    })
}

fn mssql_table(s: &mut dyn Session, schema: &str, table: &str, stop: Stop) -> AppResult<TableInfo> {
    const WHICH: &str = "(SELECT o.object_id FROM sys.objects o \
        JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @P1 AND o.name = @P2)";
    let p = &[schema, table];
    let columns = ask(
        s,
        &format!(
            "SELECT c.name, t.name + CASE \
               WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') THEN '(' + \
                 CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')' \
               WHEN t.name IN ('nvarchar', 'nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' \
                 ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')' \
               WHEN t.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS varchar(10)) + ', ' \
                 + CAST(c.scale AS varchar(10)) + ')' \
               ELSE '' END, \
             CASE WHEN c.is_nullable = 1 THEN 'true' ELSE 'false' END, dc.definition, \
             CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i \
                 ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
                 WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id \
                   AND ic.column_id = c.column_id) THEN 'pk' \
               WHEN EXISTS (SELECT 1 FROM sys.foreign_key_columns f \
                 WHERE f.parent_object_id = c.object_id AND f.parent_column_id = c.column_id) THEN 'fk' \
               ELSE '' END \
             FROM sys.columns c \
             JOIN sys.types t ON t.user_type_id = c.user_type_id \
             LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
             WHERE c.object_id = {WHICH} ORDER BY c.column_id"
        ),
        p,
        stop,
    )?;
    let indexes = ask(
        s,
        &format!(
            "SELECT i.name, CASE WHEN i.is_primary_key = 1 THEN 'primary ' \
                 WHEN i.is_unique = 1 THEN 'unique ' ELSE '' END \
               + LOWER(i.type_desc COLLATE DATABASE_DEFAULT) + ' (' + COALESCE((SELECT STRING_AGG( \
                   CAST(c.name AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) \
                 FROM sys.index_columns ic JOIN sys.columns c \
                   ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                 WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id \
                   AND ic.is_included_column = 0), '') + ')' \
             FROM sys.indexes i WHERE i.object_id = {WHICH} AND i.name IS NOT NULL ORDER BY 1"
        ),
        p,
        stop,
    )?;
    let mut keys = ask(
        s,
        &format!(
            "SELECT kc.name, CASE WHEN kc.type = 'PK' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END + ' (' \
               + COALESCE((SELECT STRING_AGG(CAST(c.name AS nvarchar(max)), ', ') \
                   WITHIN GROUP (ORDER BY ic.key_ordinal) \
                 FROM sys.index_columns ic JOIN sys.columns c \
                   ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                 WHERE ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id), '') \
               + ')' \
             FROM sys.key_constraints kc WHERE kc.parent_object_id = {WHICH} \
             ORDER BY kc.type, kc.name"
        ),
        p,
        stop,
    )?;
    keys.extend(ask(
        s,
        &format!(
            "SELECT f.name, 'FOREIGN KEY (' + COALESCE((SELECT STRING_AGG( \
                   CAST(c.name AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY fc.constraint_column_id) \
                 FROM sys.foreign_key_columns fc JOIN sys.columns c \
                   ON c.object_id = fc.parent_object_id AND c.column_id = fc.parent_column_id \
                 WHERE fc.constraint_object_id = f.object_id), '') \
               + ') REFERENCES ' + rs.name + '.' + ro.name + ' (' + COALESCE((SELECT STRING_AGG( \
                   CAST(c.name AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY fc.constraint_column_id) \
                 FROM sys.foreign_key_columns fc JOIN sys.columns c \
                   ON c.object_id = fc.referenced_object_id AND c.column_id = fc.referenced_column_id \
                 WHERE fc.constraint_object_id = f.object_id), '') + ')' \
             FROM sys.foreign_keys f \
             JOIN sys.objects ro ON ro.object_id = f.referenced_object_id \
             JOIN sys.schemas rs ON rs.schema_id = ro.schema_id \
             WHERE f.parent_object_id = {WHICH} ORDER BY f.name"
        ),
        p,
        stop,
    )?);
    keys.extend(ask(
        s,
        &format!(
            "SELECT cc.name, 'CHECK ' + cc.definition FROM sys.check_constraints cc \
             WHERE cc.parent_object_id = {WHICH} ORDER BY cc.name"
        ),
        p,
        stop,
    )?);
    let triggers = ask(
        s,
        &format!(
            "SELECT t.name, CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END \
             FROM sys.triggers t WHERE t.parent_id = {WHICH} ORDER BY t.name"
        ),
        p,
        stop,
    )?;
    Ok(TableInfo {
        columns: column_rows(&columns, DbKind::Sqlserver),
        indexes: parts(&indexes),
        keys: parts(&keys),
        triggers: parts(&triggers),
    })
}

/// Oracle: the `ALL_` views show what the user may see. `LISTAGG` joins the columns of a key.
fn oracle_table(
    s: &mut dyn Session,
    schema: &str,
    table: &str,
    stop: Stop,
) -> AppResult<TableInfo> {
    let p = &[schema, table];
    const COLUMNS_OF: &str = "(SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) \
        FROM all_cons_columns cc WHERE cc.owner = c.owner AND cc.constraint_name = c.constraint_name)";
    let columns = ask(
        s,
        "SELECT c.column_name, \
           c.data_type || CASE \
             WHEN c.data_type IN ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR') \
               THEN '(' || c.char_length || CASE c.char_used WHEN 'C' THEN ' CHAR' ELSE '' END || ')' \
             WHEN c.data_type = 'RAW' THEN '(' || c.data_length || ')' \
             WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL \
               THEN '(' || c.data_precision || CASE WHEN c.data_scale > 0 THEN ', ' || c.data_scale \
                 ELSE '' END || ')' \
             ELSE '' END, \
           CASE c.nullable WHEN 'Y' THEN 'true' ELSE 'false' END, c.data_default, \
           CASE WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc \
               ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name \
               WHERE k.owner = c.owner AND k.table_name = c.table_name AND k.constraint_type = 'P' \
                 AND kc.column_name = c.column_name) THEN 'pk' \
             WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc \
               ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name \
               WHERE k.owner = c.owner AND k.table_name = c.table_name AND k.constraint_type = 'R' \
                 AND kc.column_name = c.column_name) THEN 'fk' \
             ELSE '' END \
         FROM all_tab_cols c \
         WHERE c.owner = :1 AND c.table_name = :2 AND c.hidden_column = 'NO' \
         ORDER BY c.column_id",
        p,
        stop,
    )?;
    let indexes = ask(
        s,
        "SELECT i.index_name, CASE i.uniqueness WHEN 'UNIQUE' THEN 'unique ' ELSE '' END \
           || LOWER(i.index_type) || ' (' || (SELECT LISTAGG(ic.column_name, ', ') \
               WITHIN GROUP (ORDER BY ic.column_position) FROM all_ind_columns ic \
             WHERE ic.index_owner = i.owner AND ic.index_name = i.index_name) || ')' \
         FROM all_indexes i WHERE i.table_owner = :1 AND i.table_name = :2 ORDER BY 1",
        p,
        stop,
    )?;
    let mut keys = ask(
        s,
        &format!(
            "SELECT c.constraint_name, CASE c.constraint_type WHEN 'P' THEN 'PRIMARY KEY' \
               ELSE 'UNIQUE' END || ' (' || {COLUMNS_OF} || ')' \
             FROM all_constraints c \
             WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type IN ('P', 'U') \
             ORDER BY c.constraint_type, c.constraint_name"
        ),
        p,
        stop,
    )?;
    keys.extend(ask(
        s,
        &format!(
            "SELECT c.constraint_name, 'FOREIGN KEY (' || {COLUMNS_OF} || ') REFERENCES ' \
               || r.owner || '.' || r.table_name || ' (' || (SELECT LISTAGG(rc.column_name, ', ') \
                   WITHIN GROUP (ORDER BY rc.position) FROM all_cons_columns rc \
                 WHERE rc.owner = r.owner AND rc.constraint_name = r.constraint_name) || ')' \
             FROM all_constraints c \
             JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name \
             WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'R' \
             ORDER BY c.constraint_name"
        ),
        p,
        stop,
    )?);
    // the condition is a LONG: it can be read, not searched. „"X" IS NOT NULL“ is how NOT NULL is kept
    let checks = ask(
        s,
        "SELECT c.constraint_name, c.search_condition FROM all_constraints c \
         WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'C' \
         ORDER BY c.constraint_name",
        p,
        stop,
    )?;
    keys.extend(
        checks
            .into_iter()
            .filter(|row| {
                !at(row, 1).trim().ends_with("IS NOT NULL") || at(row, 1).contains(" AND ")
            })
            .map(|row| {
                vec![
                    Some(at(&row, 0)),
                    Some(format!("CHECK ({})", at(&row, 1).trim())),
                ]
            }),
    );
    let triggers = ask(
        s,
        "SELECT t.trigger_name, t.trigger_type || ' ' || t.triggering_event FROM all_triggers t \
         WHERE t.table_owner = :1 AND t.table_name = :2 ORDER BY 1",
        p,
        stop,
    )?;
    let mut columns = column_rows(&columns, DbKind::Oracle);
    for column in &mut columns {
        // a default is kept with the blank it was typed with
        column.default = column
            .default
            .take()
            .map(|d| d.trim().to_owned())
            .filter(|d| !d.is_empty());
    }
    Ok(TableInfo {
        columns,
        indexes: parts(&indexes),
        keys: parts(&keys),
        triggers: parts(&triggers),
    })
}

fn sqlite_table(
    s: &mut dyn Session,
    schema: &str,
    table: &str,
    stop: Stop,
) -> AppResult<TableInfo> {
    let p = &[table, schema];
    let fks = ask(
        s,
        "SELECT group_concat(\"from\", ', '), \"table\", group_concat(COALESCE(\"to\", ''), ', ') \
         FROM (SELECT * FROM pragma_foreign_key_list WHERE arg = ?1 AND schema = ?2 ORDER BY id, seq) \
         GROUP BY id ORDER BY id",
        p,
        stop,
    )?;
    let fk_columns: Vec<String> = fks
        .iter()
        .flat_map(|row| {
            at(row, 0)
                .split(", ")
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect();
    let raw = ask(
        s,
        "SELECT name, type, CASE WHEN \"notnull\" = 0 THEN 'true' ELSE 'false' END, dflt_value, \
         CASE WHEN pk > 0 THEN 'pk' ELSE '' END \
         FROM pragma_table_info WHERE arg = ?1 AND schema = ?2 ORDER BY cid",
        p,
        stop,
    )?;
    let mut columns = column_rows(&raw, DbKind::Sqlite);
    for c in &mut columns {
        if c.key.is_empty() && fk_columns.contains(&c.name) {
            c.key = "fk".into();
        }
    }
    let pk: Vec<&str> = columns
        .iter()
        .filter(|c| c.key == "pk")
        .map(|c| c.name.as_str())
        .collect();
    let mut keys = Vec::new();
    if !pk.is_empty() {
        keys.push(PartInfo {
            name: "primary key".into(),
            detail: format!("PRIMARY KEY ({})", pk.join(", ")),
        });
    }
    for row in &fks {
        keys.push(PartInfo {
            name: format!("→ {}", at(row, 1)),
            detail: format!(
                "FOREIGN KEY ({}) REFERENCES {} ({})",
                at(row, 0),
                at(row, 1),
                at(row, 2)
            ),
        });
    }
    let indexes = ask(
        s,
        "SELECT il.name, CASE WHEN il.origin = 'pk' THEN 'primary ' \
             WHEN il.\"unique\" = 1 THEN 'unique ' ELSE '' END || '(' || COALESCE( \
           (SELECT group_concat(COALESCE(ii.name, '<expr>'), ', ') FROM pragma_index_info ii \
             WHERE ii.arg = il.name AND ii.schema = ?2), '') || ')' \
         FROM pragma_index_list il WHERE il.arg = ?1 AND il.schema = ?2 ORDER BY 1",
        p,
        stop,
    )?;
    // The triggers of a table are only in the `sqlite_schema` of its file, and a schema cannot be bound:
    // its name comes from `pragma_database_list` and goes in quoted – the one name in SQL in this module.
    let triggers = ask(
        s,
        &format!(
            "SELECT name, '' FROM {}.sqlite_schema WHERE type = 'trigger' AND tbl_name = ?1 ORDER BY 1",
            quote_always(schema, DbKind::Sqlite)
        ),
        &[table],
        stop,
    )?;
    Ok(TableInfo {
        columns,
        indexes: parts(&indexes),
        keys,
        triggers: parts(&triggers),
    })
}

/// The columns, indexes, keys and triggers of a table or view, read together.
pub fn table(
    s: &mut dyn Session,
    kind: DbKind,
    schema: &str,
    table: &str,
    stop: Stop,
) -> AppResult<TableInfo> {
    match kind {
        DbKind::Postgres => pg_table(s, schema, table, stop),
        DbKind::Mysql => mysql_table(s, schema, table, stop),
        DbKind::Sqlserver => mssql_table(s, schema, table, stop),
        DbKind::Sqlite => sqlite_table(s, schema, table, stop),
        DbKind::Oracle => oracle_table(s, schema, table, stop),
    }
}

/// Tables and views whose name holds `text`, in all schemas but the system's: for the filter of the tree,
/// which only knows what was opened. At most [`MAX_FOUND`].
pub fn search(s: &mut dyn Session, kind: DbKind, text: &str, stop: Stop) -> AppResult<Vec<Found>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = like_pattern(text);
    let sql = match kind {
        DbKind::Postgres => {
            "SELECT n.nspname::text, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' \
               ELSE 'table' END, c.relname::text \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND c.relname ILIKE $1 ESCAPE '\\' \
               AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' \
             ORDER BY 3, 1 LIMIT 200"
        }
        DbKind::Mysql => {
            "SELECT TABLE_SCHEMA, CASE WHEN TABLE_TYPE LIKE '%VIEW' THEN 'view' ELSE 'table' END, \
               TABLE_NAME \
             FROM information_schema.TABLES \
             WHERE LOWER(TABLE_NAME) LIKE LOWER(?) ESCAPE '\\\\' AND TABLE_SCHEMA NOT IN \
               ('information_schema', 'mysql', 'performance_schema', 'sys') \
             ORDER BY 3, 1 LIMIT 200"
        }
        DbKind::Sqlserver => {
            "SELECT TOP 200 s.name, RTRIM(o.type), o.name \
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type IN ('U', 'V') AND o.name LIKE @P1 ESCAPE '\\' AND o.is_ms_shipped = 0 \
             ORDER BY 3, 1"
        }
        DbKind::Sqlite => {
            "SELECT schema, type, name FROM pragma_table_list \
             WHERE name LIKE ?1 ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY 3, 1 LIMIT 200"
        }
        DbKind::Oracle => {
            "SELECT o.owner, CASE o.object_type WHEN 'VIEW' THEN 'view' \
               WHEN 'MATERIALIZED VIEW' THEN 'matview' ELSE 'table' END, o.object_name \
             FROM all_objects o \
             WHERE o.object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW') \
               AND UPPER(o.object_name) LIKE UPPER(:1) ESCAPE '\\' AND o.oracle_maintained = 'N' \
               AND o.object_name NOT LIKE 'BIN$%' AND o.generated = 'N' \
               AND NOT (o.object_type = 'TABLE' AND EXISTS (SELECT 1 FROM all_mviews m \
                 WHERE m.owner = o.owner AND m.mview_name = o.object_name)) \
             ORDER BY 3, 1 FETCH FIRST 200 ROWS ONLY"
        }
    };
    Ok(ask(s, sql, &[&pattern], stop)?
        .iter()
        .take(MAX_FOUND)
        .filter_map(|row| {
            let name = at(row, 2);
            Some(Found {
                schema: at(row, 0),
                kind: object_kind(&at(row, 1))?,
                quoted: quote(&name, kind),
                name,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;

    /// Oracle (035b): unquoted names are upper case there, and it reserves words of its own.
    #[test]
    fn oracle_names_are_plain_only_in_upper_case_and_when_not_reserved() {
        let q = |name: &str| quote(name, DbKind::Oracle);
        assert_eq!(q("ORDERS"), "ORDERS");
        assert_eq!(q("ORDER_ITEMS2"), "ORDER_ITEMS2");
        assert_eq!(q("orders"), "\"orders\"");
        assert_eq!(q("Order Items"), "\"Order Items\"");
        for word in [
            "COMMENT", "LEVEL", "DATE", "NUMBER", "SIZE", "ROWID", "SELECT", "TABLE",
        ] {
            assert_eq!(q(word), format!("\"{word}\""));
        }
        // a quote cannot be written inside a quoted name there: it is dropped, the name stays closed
        assert_eq!(q("a\"; DROP TABLE t; --"), "\"a; DROP TABLE t; --\"");
        // the others keep their rule
        assert_eq!(quote("COMMENT", DbKind::Postgres), "\"COMMENT\"");
        assert_eq!(quote("level", DbKind::Postgres), "level");
    }

    #[test]
    fn the_reserved_words_are_sorted_for_the_search() {
        let mut sorted = RESERVED.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted, RESERVED);
    }

    /// The catalog of names per dialect: name, PostgreSQL, MySQL, SQL Server, SQLite.
    const NAMES: &[(&str, &str, &str, &str, &str)] = &[
        ("customer", "customer", "customer", "customer", "customer"),
        (
            "order_item2",
            "order_item2",
            "order_item2",
            "order_item2",
            "order_item2",
        ),
        ("_tmp", "_tmp", "_tmp", "_tmp", "_tmp"),
        (
            "Customer",
            "\"Customer\"",
            "Customer",
            "Customer",
            "Customer",
        ),
        (
            "my table",
            "\"my table\"",
            "`my table`",
            "[my table]",
            "\"my table\"",
        ),
        ("größe", "\"größe\"", "`größe`", "[größe]", "\"größe\""),
        ("order", "\"order\"", "`order`", "[order]", "\"order\""),
        ("USER", "\"USER\"", "`USER`", "[USER]", "\"USER\""),
        ("select", "\"select\"", "`select`", "[select]", "\"select\""),
        ("2fast", "\"2fast\"", "`2fast`", "[2fast]", "\"2fast\""),
        ("a\"b", "\"a\"\"b\"", "`a\"b`", "[a\"b]", "\"a\"\"b\""),
        ("a`b", "\"a`b\"", "`a``b`", "[a`b]", "\"a`b\""),
        ("a]b", "\"a]b\"", "`a]b`", "[a]]b]", "\"a]b\""),
        ("a.b", "\"a.b\"", "`a.b`", "[a.b]", "\"a.b\""),
        ("x;drop", "\"x;drop\"", "`x;drop`", "[x;drop]", "\"x;drop\""),
        ("", "\"\"", "``", "[]", "\"\""),
        ("小林", "\"小林\"", "`小林`", "[小林]", "\"小林\""),
    ];

    #[test]
    fn quotes_names_per_dialect() {
        for (name, pg, my, ms, lite) in NAMES {
            assert_eq!(quote(name, DbKind::Postgres), *pg, "{name} (PostgreSQL)");
            assert_eq!(quote(name, DbKind::Mysql), *my, "{name} (MySQL)");
            assert_eq!(quote(name, DbKind::Sqlserver), *ms, "{name} (SQL Server)");
            assert_eq!(quote(name, DbKind::Sqlite), *lite, "{name} (SQLite)");
        }
    }

    #[test]
    fn a_search_text_is_a_pattern_without_wildcards_of_its_own() {
        assert_eq!(like_pattern("cust"), "%cust%");
        assert_eq!(like_pattern("50%_[a]\\"), "%50\\%\\_\\[a]\\\\%");
    }

    fn demo() -> sqlite::Lite {
        sqlite::open(&sqlite::demo_profile()).unwrap()
    }

    #[test]
    fn reads_the_demo_database() {
        let mut db = demo();
        let stop = &|| false;
        db.execute_batch_for_tests(
            "CREATE INDEX orders_by_customer ON orders (customer_id, ordered_at);
             CREATE UNIQUE INDEX product_name ON product (name);
             CREATE VIEW big_orders AS SELECT * FROM orders WHERE quantity > 3;
             CREATE TABLE \"my table\" (\"select\" TEXT, \"größe\" REAL DEFAULT 1.5);
             CREATE TRIGGER orders_check BEFORE INSERT ON orders BEGIN SELECT 1; END;",
        );
        let all = schemas(&mut db, DbKind::Sqlite, stop).unwrap();
        assert_eq!(all[0].name, "main");
        assert!(all[0].current && !all[0].system);

        let found = objects(&mut db, DbKind::Sqlite, "main", stop).unwrap();
        let names: Vec<(ObjectKind, &str)> =
            found.iter().map(|o| (o.kind, o.name.as_str())).collect();
        assert_eq!(
            names,
            vec![
                (ObjectKind::Table, "customer"),
                (ObjectKind::Table, "my table"),
                (ObjectKind::Table, "orders"),
                (ObjectKind::Table, "product"),
                (ObjectKind::View, "big_orders"),
            ]
        );
        assert_eq!(found[1].quoted, "\"my table\"");

        let orders = table(&mut db, DbKind::Sqlite, "main", "orders", stop).unwrap();
        let cols: Vec<(&str, &str, bool, &str)> = orders
            .columns
            .iter()
            .map(|c| {
                (
                    c.name.as_str(),
                    c.type_name.as_str(),
                    c.nullable,
                    c.key.as_str(),
                )
            })
            .collect();
        assert_eq!(
            cols,
            vec![
                ("id", "INTEGER", true, "pk"),
                ("customer_id", "INTEGER", false, "fk"),
                ("product_id", "INTEGER", false, "fk"),
                ("quantity", "INTEGER", false, ""),
                ("ordered_at", "TEXT", false, ""),
                ("note", "TEXT", true, ""),
            ]
        );
        assert_eq!(
            orders.indexes,
            vec![PartInfo {
                name: "orders_by_customer".into(),
                detail: "(customer_id, ordered_at)".into()
            }]
        );
        assert_eq!(orders.keys.len(), 3);
        assert_eq!(orders.keys[0].detail, "PRIMARY KEY (id)");
        assert!(
            orders
                .keys
                .iter()
                .any(|k| k.detail == "FOREIGN KEY (customer_id) REFERENCES customer (id)")
        );
        assert_eq!(orders.triggers[0].name, "orders_check");

        let odd = table(&mut db, DbKind::Sqlite, "main", "my table", stop).unwrap();
        assert_eq!(odd.columns[0].quoted, "\"select\"");
        assert_eq!(odd.columns[1].quoted, "\"größe\"");
        assert_eq!(odd.columns[1].default.as_deref(), Some("1.5"));

        let product = table(&mut db, DbKind::Sqlite, "main", "product", stop).unwrap();
        assert_eq!(product.indexes[0].detail, "unique (name)");
    }

    #[test]
    fn a_table_that_is_not_there_has_no_parts_and_a_name_cannot_inject() {
        let mut db = demo();
        let stop = &|| false;
        let none = table(
            &mut db,
            DbKind::Sqlite,
            "main",
            "x'; DROP TABLE orders; --",
            stop,
        )
        .unwrap();
        assert_eq!(none, TableInfo::default());
        assert!(
            table(
                &mut db,
                DbKind::Sqlite,
                "main\"; DROP TABLE orders; --",
                "orders",
                stop
            )
            .is_err()
        );
        assert_eq!(
            objects(&mut db, DbKind::Sqlite, "main", stop)
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn finds_names_anywhere_and_takes_wildcards_as_text() {
        let mut db = demo();
        let stop = &|| false;
        let hits = search(&mut db, DbKind::Sqlite, "ORD", stop).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            (hits[0].schema.as_str(), hits[0].name.as_str()),
            ("main", "orders")
        );
        assert!(
            search(&mut db, DbKind::Sqlite, "%", stop)
                .unwrap()
                .is_empty()
        );
        assert!(
            search(&mut db, DbKind::Sqlite, "  ", stop)
                .unwrap()
                .is_empty()
        );
    }
}
