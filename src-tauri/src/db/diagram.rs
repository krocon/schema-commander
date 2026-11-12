//! What an ER diagram is drawn from (prompt 037): the tables of a schema with their columns, the foreign
//! keys between them, and the sets of columns that are unique (to tell „one“ from „many“). Read from the
//! catalog with bound parameters, a few questions per schema – not one per table.

use super::relations::{ForeignKey, fold};
use super::{DbKind, Session, Stop, TextRows};
use crate::error::AppResult;
use serde::Serialize;
use std::time::Duration;

/// Tables of one diagram at most; a schema with more is cut (`DiagramData::cut`).
pub const MAX_TABLES: usize = 2_000;
const TIMEOUT: Duration = Duration::from_secs(30);

/// Mirrored by `DiagramColumn` in `src/app/core/schema/schema.models.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramColumn {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
    /// Part of the primary key.
    pub pk: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramTable {
    pub schema: String,
    pub name: String,
    pub columns: Vec<DiagramColumn>,
}

/// Columns of a table that are unique together (a unique index or constraint, the primary key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueSet {
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiagramData {
    pub tables: Vec<DiagramTable>,
    /// The keys of the tables of the schema, and those of other schemas that point into it.
    pub keys: Vec<ForeignKey>,
    pub unique: Vec<UniqueSet>,
    /// The schema has more tables than a diagram takes.
    pub cut: bool,
}

fn at(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

/// Rows `table, column, type, nullable, pk` (in the order of the tables' columns) as tables.
fn tables_of(rows: &TextRows, schema: &str) -> (Vec<DiagramTable>, bool) {
    let mut out: Vec<DiagramTable> = Vec::new();
    let mut cut = false;
    for row in rows {
        let table = at(row, 0);
        if out.last().is_none_or(|t| t.name != table) {
            if out.len() == MAX_TABLES {
                cut = true;
                break;
            }
            out.push(DiagramTable {
                schema: schema.to_owned(),
                name: table,
                columns: Vec::new(),
            });
        }
        out.last_mut()
            .expect("just pushed")
            .columns
            .push(DiagramColumn {
                name: at(row, 1),
                type_name: at(row, 2),
                nullable: at(row, 3) == "true",
                pk: at(row, 4) == "true",
            });
    }
    (out, cut)
}

/// Rows `table, index, column` (rows of one index follow each other) as sets.
fn unique_of(rows: &TextRows) -> Vec<UniqueSet> {
    let mut out: Vec<UniqueSet> = Vec::new();
    let mut last: Option<(String, String)> = None;
    for row in rows {
        let key = (at(row, 0), at(row, 1));
        if last.as_ref() != Some(&key) {
            out.push(UniqueSet {
                table: key.0.clone(),
                columns: Vec::new(),
            });
            last = Some(key);
        }
        out.last_mut()
            .expect("just pushed")
            .columns
            .push(at(row, 2));
    }
    out
}

/// The tables of a schema, their keys and what is unique in them.
pub fn diagram(
    s: &mut dyn Session,
    kind: DbKind,
    schema: &str,
    stop: Stop,
) -> AppResult<DiagramData> {
    let one = &[schema][..];
    let two = &[schema, schema][..];
    let none: &[&str] = &[];
    let (columns, keys, unique): (TextRows, TextRows, AppResult<TextRows>) = match kind {
        DbKind::Postgres => (
            s.ask(
                "SELECT c.relname::text, a.attname::text, \
                   pg_catalog.format_type(a.atttypid, a.atttypmod), (NOT a.attnotnull)::text, \
                   COALESCE((SELECT 'true' FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid \
                     AND i.indisprimary AND a.attnum = ANY (i.indkey) LIMIT 1), 'false') \
                 FROM pg_catalog.pg_attribute a \
                 JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped \
                   AND c.relkind IN ('r', 'p') AND c.relispartition IS NOT TRUE \
                 ORDER BY c.relname, a.attnum",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT k.conname, cn.nspname, c.relname, a.attname, pn.nspname, p.relname, pa.attname \
                 FROM pg_catalog.pg_constraint k \
                 JOIN pg_catalog.pg_class c ON c.oid = k.conrelid \
                 JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace \
                 JOIN pg_catalog.pg_class p ON p.oid = k.confrelid \
                 JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace \
                 CROSS JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY AS u(child, parent, n) \
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.child \
                 JOIN pg_catalog.pg_attribute pa ON pa.attrelid = k.confrelid AND pa.attnum = u.parent \
                 WHERE k.contype = 'f' AND (cn.nspname = $1 OR pn.nspname = $1) \
                 ORDER BY cn.nspname, c.relname, k.conname, u.n",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT c.relname::text, i.indexrelid::text, a.attname::text \
                 FROM pg_catalog.pg_index i \
                 JOIN pg_catalog.pg_class c ON c.oid = i.indrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey) \
                 WHERE n.nspname = $1 AND i.indisunique AND i.indpred IS NULL \
                 ORDER BY 1, 2",
                one,
                Some(TIMEOUT),
                stop,
            ),
        ),
        DbKind::Mysql => (
            s.ask(
                "SELECT c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, \
                   IF(c.IS_NULLABLE = 'YES', 'true', 'false'), IF(c.COLUMN_KEY = 'PRI', 'true', 'false') \
                 FROM information_schema.COLUMNS c \
                 JOIN information_schema.TABLES t \
                   ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
                 WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE' \
                 ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, \
                   k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME \
                 FROM information_schema.KEY_COLUMN_USAGE k \
                 WHERE k.REFERENCED_TABLE_NAME IS NOT NULL \
                   AND (k.TABLE_SCHEMA = ? OR k.REFERENCED_TABLE_SCHEMA = ?) \
                 ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
                two,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0 ORDER BY 1, 2, SEQ_IN_INDEX",
                one,
                Some(TIMEOUT),
                stop,
            ),
        ),
        DbKind::Sqlserver => (
            s.ask(
                // the type with its size: the name alone would be another type (`varchar` is `varchar(1)`)
                "SELECT o.name, c.name, \
                   CASE WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') THEN t.name + '(' \
                       + CASE WHEN c.max_length = -1 THEN 'max' \
                           ELSE CAST(c.max_length AS varchar(10)) END + ')' \
                     WHEN t.name IN ('nvarchar', 'nchar') THEN t.name + '(' \
                       + CASE WHEN c.max_length = -1 THEN 'max' \
                           ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')' \
                     WHEN t.name IN ('decimal', 'numeric') THEN t.name + '(' \
                       + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')' \
                     WHEN t.name IN ('datetime2', 'time', 'datetimeoffset') THEN t.name + '(' \
                       + CAST(c.scale AS varchar(10)) + ')' \
                     ELSE t.name END, \
                   CASE WHEN c.is_nullable = 1 THEN 'true' ELSE 'false' END, \
                   CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic \
                     ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
                     WHERE i.object_id = o.object_id AND i.is_primary_key = 1 \
                       AND ic.column_id = c.column_id) THEN 'true' ELSE 'false' END \
                 FROM sys.columns c \
                 JOIN sys.objects o ON o.object_id = c.object_id \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 JOIN sys.types t ON t.user_type_id = c.user_type_id \
                 WHERE s.name = @P1 AND o.type = 'U' ORDER BY o.name, c.column_id",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT f.name, cs.name, ct.name, cc.name, ps.name, pt.name, pc.name \
                 FROM sys.foreign_keys f \
                 JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id \
                 JOIN sys.tables ct ON ct.object_id = f.parent_object_id \
                 JOIN sys.schemas cs ON cs.schema_id = ct.schema_id \
                 JOIN sys.tables pt ON pt.object_id = f.referenced_object_id \
                 JOIN sys.schemas ps ON ps.schema_id = pt.schema_id \
                 JOIN sys.columns cc ON cc.object_id = fc.parent_object_id \
                   AND cc.column_id = fc.parent_column_id \
                 JOIN sys.columns pc ON pc.object_id = fc.referenced_object_id \
                   AND pc.column_id = fc.referenced_column_id \
                 WHERE cs.name = @P1 OR ps.name = @P1 \
                 ORDER BY cs.name, ct.name, f.name, fc.constraint_column_id",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT o.name, i.name, c.name FROM sys.indexes i \
                 JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
                 JOIN sys.objects o ON o.object_id = i.object_id \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 WHERE s.name = @P1 AND o.type = 'U' AND i.is_unique = 1 AND ic.is_included_column = 0 \
                   AND i.has_filter = 0 \
                 ORDER BY 1, 2, ic.key_ordinal",
                one,
                Some(TIMEOUT),
                stop,
            ),
        ),
        // tables and their columns; keys are not read yet (prompt 035l)
        DbKind::Db2 => (
            s.ask(
                &format!(
                    "SELECT c.tabname, c.colname, {}, \
                       CASE c.nulls WHEN 'Y' THEN 'true' ELSE 'false' END, \
                       CASE WHEN c.keyseq IS NULL THEN 'false' ELSE 'true' END \
                     FROM syscat.columns c \
                     JOIN syscat.tables t ON t.tabschema = c.tabschema AND t.tabname = c.tabname \
                     WHERE c.tabschema = ? AND t.type = 'T' ORDER BY c.tabname, c.colno",
                    super::meta::DB2_TYPE
                        .replace("typename", "c.typename")
                        .replace("length", "c.length")
                        .replace("scale", "c.scale")
                ),
                one,
                Some(TIMEOUT),
                stop,
            )?,
            Vec::new(),
            Ok(Vec::new()),
        ),
        DbKind::Snowflake => (
            s.ask(
                &format!(
                    "SELECT c.table_name, c.column_name, {}, \
                       CASE c.is_nullable WHEN 'YES' THEN 'true' ELSE 'false' END, 'false' \
                     FROM INFORMATION_SCHEMA.COLUMNS c \
                     JOIN INFORMATION_SCHEMA.TABLES t \
                       ON t.table_schema = c.table_schema AND t.table_name = c.table_name \
                     WHERE c.table_schema = ? AND t.table_type = 'BASE TABLE' \
                     ORDER BY c.table_name, c.ordinal_position",
                    super::meta::SNOWFLAKE_TYPE.replace("data_type", "c.data_type")
                        .replace("numeric_", "c.numeric_")
                        .replace("character_maximum_length", "c.character_maximum_length")
                ),
                one,
                Some(TIMEOUT),
                stop,
            )?,
            Vec::new(),
            Ok(Vec::new()),
        ),
        // tables without keys: the ones BigQuery knows are a promise nobody checks
        DbKind::Bigquery => (
            s.ask(
                &format!(
                    "SELECT c.table_name, c.column_name, c.data_type, \
                       CASE c.is_nullable WHEN 'YES' THEN 'true' ELSE 'false' END, 'false' \
                     FROM {0}.INFORMATION_SCHEMA.COLUMNS c \
                     JOIN {0}.INFORMATION_SCHEMA.TABLES t ON t.table_name = c.table_name \
                     WHERE t.table_type = 'BASE TABLE' ORDER BY c.table_name, c.ordinal_position",
                    super::meta::quote_always(schema, kind)
                ),
                none,
                Some(TIMEOUT),
                stop,
            )?,
            Vec::new(),
            Ok(Vec::new()),
        ),
        DbKind::Firebird => {
            use super::firebird::{FOREIGN_KEYS, NO_SCHEMA, OWN, TYPE, in_key};
            (
                s.ask(
                    &format!(
                        "SELECT rf.rdb$relation_name, rf.rdb$field_name, {TYPE}, \
                           IIF(COALESCE(rf.rdb$null_flag, f.rdb$null_flag, 0) = 1, 'false', 'true'), \
                           IIF({}, 'true', 'false') \
                         FROM rdb$relation_fields rf \
                         JOIN rdb$fields f ON f.rdb$field_name = rf.rdb$field_source \
                         JOIN rdb$relations r ON r.rdb$relation_name = rf.rdb$relation_name \
                         WHERE {NO_SCHEMA} AND {OWN} AND r.rdb$view_blr IS NULL \
                         ORDER BY rf.rdb$relation_name, rf.rdb$field_position",
                        in_key("PRIMARY KEY")
                    ),
                    one,
                    Some(TIMEOUT),
                    stop,
                )?,
                s.ask(
                    &format!(
                        "{FOREIGN_KEYS} AND {NO_SCHEMA} \
                         ORDER BY rc.rdb$relation_name, rc.rdb$constraint_name, cs.rdb$field_position"
                    ),
                    one,
                    Some(TIMEOUT),
                    stop,
                )?,
                s.ask(
                    &format!(
                        "SELECT rc.rdb$relation_name, rc.rdb$constraint_name, sg.rdb$field_name \
                         FROM rdb$relation_constraints rc \
                         JOIN rdb$index_segments sg ON sg.rdb$index_name = rc.rdb$index_name \
                         JOIN rdb$relations r ON r.rdb$relation_name = rc.rdb$relation_name \
                         WHERE rc.rdb$constraint_type IN ('PRIMARY KEY', 'UNIQUE') AND {NO_SCHEMA} \
                           AND {OWN} \
                         ORDER BY 1, 2, sg.rdb$field_position"
                    ),
                    one,
                    Some(TIMEOUT),
                    stop,
                ),
            )
        }
        // tables without keys: the catalog names none
        DbKind::Trino => (
            s.ask(
                "SELECT c.table_name, c.column_name, c.data_type, \
                   CASE c.is_nullable WHEN 'YES' THEN 'true' ELSE 'false' END, 'false' \
                 FROM information_schema.columns c \
                 JOIN information_schema.tables t \
                   ON t.table_schema = c.table_schema AND t.table_name = c.table_name \
                 WHERE c.table_schema = ? AND t.table_type = 'BASE TABLE' \
                 ORDER BY c.table_name, c.ordinal_position",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            Vec::new(),
            Ok(Vec::new()),
        ),
        // tables and what they are sorted by; there are no keys to draw
        DbKind::Clickhouse => (
            s.ask(
                "SELECT c.table, c.name, c.type, if(c.type LIKE 'Nullable(%', 'true', 'false'), \
                   if(c.is_in_primary_key, 'true', 'false') \
                 FROM system.columns c \
                 WHERE c.database = {p1:String} AND c.table NOT LIKE '.inner%' \
                   AND (c.database, c.table) IN (SELECT database, name FROM system.tables \
                     WHERE engine NOT LIKE '%View' AND NOT is_temporary) \
                 ORDER BY c.table, c.position",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            Vec::new(),
            Ok(Vec::new()),
        ),
        DbKind::Duckdb => (
            s.ask(
                "SELECT c.table_name, c.column_name, c.data_type, \
                   CASE WHEN c.is_nullable THEN 'true' ELSE 'false' END, \
                   CASE WHEN EXISTS (SELECT 1 FROM duckdb_constraints() k \
                     WHERE k.database_name = c.database_name AND k.schema_name = c.schema_name \
                       AND k.table_name = c.table_name AND k.constraint_type = 'PRIMARY KEY' \
                       AND list_contains(k.constraint_column_names, c.column_name)) \
                     THEN 'true' ELSE 'false' END \
                 FROM duckdb_columns() c JOIN duckdb_tables() t \
                   ON t.database_name = c.database_name AND t.schema_name = c.schema_name \
                     AND t.table_name = c.table_name \
                 WHERE c.database_name = current_database() AND c.schema_name = $1 AND NOT t.internal \
                 ORDER BY c.table_name, c.column_index",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT k.constraint_name, k.schema_name, k.table_name, \
                   unnest(k.constraint_column_names), k.schema_name, k.referenced_table, \
                   unnest(k.referenced_column_names) \
                 FROM duckdb_constraints() k \
                 WHERE k.database_name = current_database() AND k.constraint_type = 'FOREIGN KEY' \
                   AND k.schema_name = $1 \
                 ORDER BY k.table_name, k.constraint_name",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT k.table_name, k.constraint_name, unnest(k.constraint_column_names) \
                 FROM duckdb_constraints() k \
                 WHERE k.database_name = current_database() AND k.schema_name = $1 \
                   AND k.constraint_type IN ('PRIMARY KEY', 'UNIQUE') \
                 ORDER BY 1, 2",
                one,
                Some(TIMEOUT),
                stop,
            ),
        ),
        DbKind::Oracle => (
            s.ask(
                "SELECT c.table_name, c.column_name, c.data_type, \
                   CASE c.nullable WHEN 'Y' THEN 'true' ELSE 'false' END, \
                   CASE WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc \
                     ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name \
                     WHERE k.owner = c.owner AND k.table_name = c.table_name \
                       AND k.constraint_type = 'P' AND kc.column_name = c.column_name) \
                     THEN 'true' ELSE 'false' END \
                 FROM all_tab_cols c \
                 JOIN all_tables t ON t.owner = c.owner AND t.table_name = c.table_name \
                 WHERE c.owner = :1 AND c.hidden_column = 'NO' AND c.table_name NOT LIKE 'BIN$%' \
                 ORDER BY c.table_name, c.column_id",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT c.constraint_name, c.owner, c.table_name, cc.column_name, \
                   r.owner, r.table_name, rc.column_name \
                 FROM all_constraints c \
                 JOIN all_constraints r ON r.owner = c.r_owner \
                   AND r.constraint_name = c.r_constraint_name \
                 JOIN all_cons_columns cc ON cc.owner = c.owner \
                   AND cc.constraint_name = c.constraint_name \
                 JOIN all_cons_columns rc ON rc.owner = r.owner \
                   AND rc.constraint_name = r.constraint_name AND rc.position = cc.position \
                 WHERE c.constraint_type = 'R' AND c.owner = :1 \
                 ORDER BY c.table_name, c.constraint_name, cc.position",
                one,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT i.table_name, i.index_name, ic.column_name \
                 FROM all_indexes i JOIN all_ind_columns ic \
                   ON ic.index_owner = i.owner AND ic.index_name = i.index_name \
                 WHERE i.table_owner = :1 AND i.uniqueness = 'UNIQUE' \
                 ORDER BY 1, 2, ic.column_position",
                one,
                Some(TIMEOUT),
                stop,
            ),
        ),
        // the file that is open: SQLite has one namespace
        DbKind::Sqlite | DbKind::Libsql | DbKind::D1 => (
            s.ask(
                "SELECT m.name, p.name, p.type, CASE WHEN p.\"notnull\" = 0 THEN 'true' ELSE 'false' END, \
                   CASE WHEN p.pk > 0 THEN 'true' ELSE 'false' END \
                 FROM sqlite_master m, pragma_table_info(m.name) p \
                 WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite!_%' ESCAPE '!' \
                 ORDER BY m.name, p.cid",
                none,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT 'fk' || f.id, '', m.name, f.\"from\", '', f.\"table\", COALESCE(f.\"to\", '') \
                 FROM sqlite_master m, pragma_foreign_key_list(m.name) f \
                 WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq",
                none,
                Some(TIMEOUT),
                stop,
            )?,
            s.ask(
                "SELECT m.name, l.name, x.name \
                 FROM sqlite_master m, pragma_index_list(m.name) l, pragma_index_info(l.name) x \
                 WHERE m.type = 'table' AND l.\"unique\" = 1 AND l.partial = 0 \
                 ORDER BY 1, 2, x.seqno",
                none,
                Some(TIMEOUT),
                stop,
            ),
        ),
    };
    let (tables, cut) = tables_of(&columns, schema);
    let mut keys = keys;
    if kind.is_sqlite() {
        // the namespace is the schema asked for; a key without target columns points to the primary
        // key of its target, column by column; names of tables are compared without their case
        let mut nth: std::collections::HashMap<(String, String), usize> =
            std::collections::HashMap::new();
        for row in &mut keys {
            row[1] = Some(schema.to_owned());
            row[4] = Some(schema.to_owned());
            let target = at(row, 5);
            let table = tables.iter().find(|t| t.name.eq_ignore_ascii_case(&target));
            if let Some(table) = table {
                row[5] = Some(table.name.clone());
            }
            let n = nth.entry((at(row, 0), at(row, 2))).or_insert(0);
            let place = *n;
            *n += 1;
            if at(row, 6).is_empty()
                && let Some(column) =
                    table.and_then(|t| t.columns.iter().filter(|c| c.pk).nth(place))
            {
                row[6] = Some(column.name.clone());
            }
        }
    }
    let mut unique = unique.map(|rows| unique_of(&rows)).unwrap_or_default();
    // the primary key is unique, whether an index says so or not (SQLite's rowid)
    for table in &tables {
        let pk: Vec<String> = table
            .columns
            .iter()
            .filter(|c| c.pk)
            .map(|c| c.name.clone())
            .collect();
        if !pk.is_empty()
            && !unique
                .iter()
                .any(|u| u.table == table.name && u.columns == pk)
        {
            unique.push(UniqueSet {
                table: table.name.clone(),
                columns: pk,
            });
        }
    }
    Ok(DiagramData {
        tables,
        keys: fold(&keys),
        unique,
        cut,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;

    #[test]
    fn reads_tables_keys_and_unique_sets_of_a_schema() {
        let mut s = sqlite::open(&sqlite::demo_profile()).unwrap();
        s.execute_batch_for_tests(
            "CREATE TABLE d_author (id INTEGER PRIMARY KEY, name TEXT NOT NULL, boss INTEGER REFERENCES d_author);
             CREATE TABLE d_book (isbn TEXT, edition INTEGER, author_id INTEGER NOT NULL REFERENCES D_AUTHOR (id),
               title TEXT, PRIMARY KEY (isbn, edition));
             CREATE TABLE d_copy (id INTEGER PRIMARY KEY, isbn TEXT, edition INTEGER, shelf TEXT UNIQUE,
               FOREIGN KEY (isbn, edition) REFERENCES d_book (isbn, edition));
             CREATE TABLE d_profile (author_id INTEGER PRIMARY KEY REFERENCES d_author (id), bio TEXT);",
        );
        let d = diagram(&mut s, DbKind::Sqlite, "main", &|| false).unwrap();
        let mine: Vec<&DiagramTable> = d
            .tables
            .iter()
            .filter(|t| t.name.starts_with("d_"))
            .collect();
        assert_eq!(
            mine.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["d_author", "d_book", "d_copy", "d_profile"]
        );
        assert!(mine.iter().all(|t| t.schema == "main"));
        let book = mine[1];
        assert_eq!(
            book.columns
                .iter()
                .map(|c| format!("{} {} {} {}", c.name, c.type_name, c.nullable, c.pk))
                .collect::<Vec<_>>(),
            [
                "isbn TEXT true true",
                "edition INTEGER true true",
                "author_id INTEGER false false",
                "title TEXT true false"
            ]
        );
        let keys: Vec<String> = d
            .keys
            .iter()
            .filter(|k| k.table.starts_with("d_"))
            .map(|k| {
                format!(
                    "{}({}) → {}({})",
                    k.table,
                    k.columns.join(","),
                    k.ref_table,
                    k.ref_columns.join(",")
                )
            })
            .collect();
        assert_eq!(
            keys,
            [
                // a key to the table itself, without target columns: the primary key
                "d_author(boss) → d_author(id)",
                // the target was written in another case
                "d_book(author_id) → d_author(id)",
                // two columns
                "d_copy(isbn,edition) → d_book(isbn,edition)",
                "d_profile(author_id) → d_author(id)"
            ]
        );
        assert!(
            d.keys
                .iter()
                .all(|k| k.schema == "main" && k.ref_schema == "main")
        );
        let unique = |table: &str| -> Vec<String> {
            let mut sets: Vec<String> = d
                .unique
                .iter()
                .filter(|u| u.table == table)
                .map(|u| u.columns.join(","))
                .collect();
            sets.sort();
            sets
        };
        assert_eq!(unique("d_author"), ["id"]);
        assert_eq!(unique("d_book"), ["isbn,edition"]);
        assert_eq!(unique("d_copy"), ["id", "shelf"]);
        assert_eq!(unique("d_profile"), ["author_id"]);
        assert!(!d.cut);
    }

    #[test]
    fn folds_rows_and_cuts_a_schema_that_is_too_large() {
        let row = |cells: &[&str]| -> Vec<Option<String>> {
            cells.iter().map(|c| Some((*c).to_owned())).collect()
        };
        let rows: TextRows = (0..MAX_TABLES + 5)
            .map(|i| row(&[&format!("t{i:05}"), "id", "int", "false", "true"]))
            .collect();
        let (tables, cut) = tables_of(&rows, "s");
        assert_eq!(tables.len(), MAX_TABLES);
        assert!(cut);
        let sets = unique_of(&vec![
            row(&["a", "ix1", "x"]),
            row(&["a", "ix1", "y"]),
            row(&["a", "ix2", "z"]),
            row(&["b", "ix1", "x"]),
        ]);
        assert_eq!(
            sets.iter()
                .map(|u| format!("{}:{}", u.table, u.columns.join(",")))
                .collect::<Vec<_>>(),
            ["a:x,y", "a:z", "b:x"]
        );
    }
}
