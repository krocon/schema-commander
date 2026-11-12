//! Everything worth knowing about one object (prompt 019): lists (columns, indexes, constraints, triggers,
//! partitions, privileges, statistics, relations, dependencies) and its DDL. Read from the system catalog
//! with bound parameters, like `meta.rs`.
//!
//! A list is a [`Section`]: an id, column keys and rows of text – the window names and draws them. A list
//! the server refuses (missing rights, an older version) is left out and noted, the rest still comes.
//! The DDL is the server's own where it has one (`SHOW CREATE`, `sqlite_schema.sql`, `pg_get_*def`,
//! `sys.sql_modules`); for tables of PostgreSQL and SQL Server it is put together from the catalog
//! (design 019 E3 says what that covers).

use super::meta::{ObjectKind, quote_always};
use super::{DbKind, Session, Stop, TextRows};
use crate::error::{AppError, AppResult, ErrorCode};
use serde::Serialize;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);
/// Rows of one list at most (a table with 1 500 columns and 300 indexes fits many times).
pub const MAX_ROWS: usize = 20_000;

/// One list of an object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    /// `columns`, `indexes`, `constraints`, `triggers`, `partitions`, `privileges`, `stats`,
    /// `references`, `referencedBy`, `uses`, `usedBy`, `properties`, `values`.
    pub id: String,
    /// The keys of the columns; `refSchema` and `refName` name an object a row leads to.
    pub columns: Vec<String>,
    pub rows: TextRows,
    /// More rows than [`MAX_ROWS`]: the rest is left out.
    pub cut: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetails {
    pub sections: Vec<Section>,
    /// The statement(s) that create the object; `None` when the database gives none.
    pub ddl: Option<String>,
    /// The ids of lists the server refused, and why the DDL is missing: said once, never fatal.
    pub notes: Vec<String>,
}

struct Reader<'a> {
    s: &'a mut dyn Session,
    stop: Stop<'a>,
    sections: Vec<Section>,
    notes: Vec<String>,
}

impl Reader<'_> {
    fn ask(&mut self, sql: &str, params: &[&str]) -> AppResult<TextRows> {
        self.s.ask(sql, params, Some(TIMEOUT), self.stop)
    }

    /// Adds a list; an empty one is left out, a refused one is noted (a cancel still ends everything).
    fn section(&mut self, id: &str, columns: &[&str], sql: &str, params: &[&str]) -> AppResult<()> {
        match self.ask(sql, params) {
            Ok(rows) => {
                self.push(id, columns, rows);
                Ok(())
            }
            Err(e) if matches!(e.code, ErrorCode::Cancelled | ErrorCode::NotConnected) => Err(e),
            Err(_) => {
                self.notes.push(id.to_string());
                Ok(())
            }
        }
    }

    fn push(&mut self, id: &str, columns: &[&str], mut rows: TextRows) {
        if rows.is_empty() {
            return;
        }
        let cut = rows.len() > MAX_ROWS;
        rows.truncate(MAX_ROWS);
        self.sections.push(Section {
            id: id.into(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            rows,
            cut,
        });
    }

    /// One text of the catalog; `None` when there is no row, it is NULL or the server refuses.
    fn text(&mut self, sql: &str, params: &[&str]) -> AppResult<Option<String>> {
        match self.ask(sql, params) {
            Ok(rows) => Ok(rows
                .into_iter()
                .next()
                .and_then(|r| r.into_iter().next().flatten())),
            Err(e) if matches!(e.code, ErrorCode::Cancelled | ErrorCode::NotConnected) => Err(e),
            Err(_) => Ok(None),
        }
    }

    fn rows(&mut self, sql: &str, params: &[&str]) -> AppResult<TextRows> {
        match self.ask(sql, params) {
            Ok(rows) => Ok(rows),
            Err(e) if matches!(e.code, ErrorCode::Cancelled | ErrorCode::NotConnected) => Err(e),
            Err(_) => Ok(Vec::new()),
        }
    }
}

fn at(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

fn opt(row: &[Option<String>], i: usize) -> Option<String> {
    row.get(i).cloned().flatten().filter(|t| !t.is_empty())
}

/// A text as a literal of SQL (for `COMMENT ON … IS '…'`).
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The details of an object. `detail` tells overloaded routines apart (the arguments the tree shows).
pub fn details(
    s: &mut dyn Session,
    kind: DbKind,
    schema: &str,
    name: &str,
    object: ObjectKind,
    detail: &str,
    stop: Stop,
) -> AppResult<ObjectDetails> {
    if schema.chars().count() > 255 || name.chars().count() > 255 || detail.chars().count() > 4000 {
        return Err(AppError::new(ErrorCode::Unsupported, "name too long"));
    }
    let mut r = Reader {
        s,
        stop,
        sections: Vec::new(),
        notes: Vec::new(),
    };
    let ddl = match kind {
        DbKind::Postgres => pg::read(&mut r, schema, name, object, detail)?,
        DbKind::Mysql => mysql::read(&mut r, schema, name, object)?,
        DbKind::Sqlserver => mssql::read(&mut r, schema, name, object)?,
        DbKind::Sqlite => sqlite::read(&mut r, schema, name, object)?,
    };
    if ddl.is_none() {
        r.notes.push("ddl".into());
    }
    Ok(ObjectDetails {
        sections: r.sections,
        ddl,
        notes: r.notes,
    })
}

mod pg {
    use super::*;

    /// The relation named by `$1`.`$2`.
    const REL: &str = "(SELECT c.oid FROM pg_catalog.pg_class c \
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
        WHERE n.nspname = $1 AND c.relname = $2)";
    /// Its name as it is written in SQL.
    const QNAME: &str = "SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) \
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
        WHERE n.nspname = $1 AND c.relname = $2";

    pub fn read(
        r: &mut Reader,
        schema: &str,
        name: &str,
        object: ObjectKind,
        detail: &str,
    ) -> AppResult<Option<String>> {
        let p = &[schema, name];
        match object {
            ObjectKind::Table | ObjectKind::View | ObjectKind::Matview => {
                relation_sections(r, p, object)?;
                match object {
                    ObjectKind::Table => table_ddl(r, p),
                    _ => view_ddl(r, p, object == ObjectKind::Matview),
                }
            }
            ObjectKind::Routine => routine(r, schema, name, detail),
            ObjectKind::Sequence => sequence(r, p),
            ObjectKind::Type => type_(r, p),
        }
    }

    fn relation_sections(r: &mut Reader, p: &[&str], object: ObjectKind) -> AppResult<()> {
        r.section(
            "columns",
            &["name", "type", "nullable", "default", "key", "extra", "comment"],
            &format!(
                "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), \
                 CASE WHEN a.attnotnull THEN 'no' ELSE 'yes' END, \
                 CASE WHEN a.attgenerated = '' THEN pg_catalog.pg_get_expr(d.adbin, d.adrelid) END, \
                 CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = a.attrelid \
                     AND k.contype = 'p' AND a.attnum = ANY (k.conkey)) THEN 'pk' \
                   WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = a.attrelid \
                     AND k.contype = 'f' AND a.attnum = ANY (k.conkey)) THEN 'fk' ELSE '' END, \
                 CASE WHEN a.attidentity = 'a' THEN 'identity always' \
                   WHEN a.attidentity = 'd' THEN 'identity by default' \
                   WHEN a.attgenerated <> '' THEN 'generated: ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid) \
                   ELSE '' END, \
                 pg_catalog.col_description(a.attrelid, a.attnum) \
                 FROM pg_catalog.pg_attribute a \
                 LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE a.attrelid = {REL} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
            ),
            p,
        )?;
        // CockroachDB (prompt 035) has no sizes of relations, no `pg_get_triggerdef`, no vacuum
        let cockroach = r.s.flavor() == crate::db::Flavor::Cockroach;
        if object != ObjectKind::View {
            let size = if cockroach {
                "NULL::text"
            } else {
                "pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size(i.indexrelid))"
            };
            r.section(
                "indexes",
                &["name", "definition", "unique", "primary", "method", "size"],
                &format!(
                    "SELECT ic.relname::text, pg_catalog.pg_get_indexdef(i.indexrelid), \
                     CASE WHEN i.indisunique THEN 'yes' ELSE 'no' END, \
                     CASE WHEN i.indisprimary THEN 'yes' ELSE 'no' END, am.amname::text, \
                     {size} \
                     FROM pg_catalog.pg_index i \
                     JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
                     JOIN pg_catalog.pg_am am ON am.oid = ic.relam \
                     WHERE i.indrelid = {REL} ORDER BY 1"
                ),
                p,
            )?;
        }
        if object == ObjectKind::Table {
            r.section(
                "constraints",
                &["name", "type", "definition"],
                &format!(
                    "SELECT k.conname::text, CASE k.contype WHEN 'p' THEN 'primary key' \
                       WHEN 'u' THEN 'unique' WHEN 'f' THEN 'foreign key' WHEN 'c' THEN 'check' \
                       WHEN 'x' THEN 'exclusion' ELSE k.contype::text END, \
                     pg_catalog.pg_get_constraintdef(k.oid) \
                     FROM pg_catalog.pg_constraint k WHERE k.conrelid = {REL} \
                       AND k.contype <> 'n' \
                     ORDER BY CASE k.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, 1"
                ),
                p,
            )?;
            r.section(
                "references",
                &["name", "columns", "refSchema", "refName", "refColumns", "onUpdate", "onDelete"],
                &format!(
                    "SELECT k.conname::text, \
                     (SELECT pg_catalog.string_agg(a.attname::text, ', ' ORDER BY u.ord) \
                        FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY u(num, ord) \
                        JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.num), \
                     fn.nspname::text, fc.relname::text, \
                     (SELECT pg_catalog.string_agg(a.attname::text, ', ' ORDER BY u.ord) \
                        FROM pg_catalog.unnest(k.confkey) WITH ORDINALITY u(num, ord) \
                        JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.num), \
                     {rule_u}, {rule_d} \
                     FROM pg_catalog.pg_constraint k \
                     JOIN pg_catalog.pg_class fc ON fc.oid = k.confrelid \
                     JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace \
                     WHERE k.contype = 'f' AND k.conrelid = {REL} ORDER BY 1",
                    rule_u = rule("k.confupdtype"),
                    rule_d = rule("k.confdeltype"),
                ),
                p,
            )?;
            r.section(
                "referencedBy",
                &["name", "refSchema", "refName", "columns", "onUpdate", "onDelete"],
                &format!(
                    "SELECT k.conname::text, tn.nspname::text, tc.relname::text, \
                     (SELECT pg_catalog.string_agg(a.attname::text, ', ' ORDER BY u.ord) \
                        FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY u(num, ord) \
                        JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.num), \
                     {rule_u}, {rule_d} \
                     FROM pg_catalog.pg_constraint k \
                     JOIN pg_catalog.pg_class tc ON tc.oid = k.conrelid \
                     JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace \
                     WHERE k.contype = 'f' AND k.confrelid = {REL} ORDER BY 2, 3, 1",
                    rule_u = rule("k.confupdtype"),
                    rule_d = rule("k.confdeltype"),
                ),
                p,
            )?;
            r.section(
                "partitions",
                &["refSchema", "refName", "bound"],
                &format!(
                    "SELECT n.nspname::text, c.relname::text, \
                     pg_catalog.pg_get_expr(c.relpartbound, c.oid) \
                     FROM pg_catalog.pg_inherits i \
                     JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     WHERE i.inhparent = {REL} ORDER BY 1, 2"
                ),
                p,
            )?;
        }
        if object != ObjectKind::Matview && !cockroach {
            r.section(
                "triggers",
                &["name", "definition", "enabled"],
                &format!(
                    "SELECT t.tgname::text, pg_catalog.pg_get_triggerdef(t.oid), \
                     CASE WHEN t.tgenabled = 'D' THEN 'no' ELSE 'yes' END \
                     FROM pg_catalog.pg_trigger t WHERE t.tgrelid = {REL} AND NOT t.tgisinternal \
                     ORDER BY 1"
                ),
                p,
            )?;
        }
        // views that read this relation, and (for a view) what it reads
        r.section(
            "usedBy",
            &["refSchema", "refName"],
            &format!(
                "SELECT DISTINCT vn.nspname::text, v.relname::text \
                 FROM pg_catalog.pg_depend d \
                 JOIN pg_catalog.pg_rewrite w ON w.oid = d.objid \
                 JOIN pg_catalog.pg_class v ON v.oid = w.ev_class \
                 JOIN pg_catalog.pg_namespace vn ON vn.oid = v.relnamespace \
                 WHERE d.classid = 'pg_catalog.pg_rewrite'::regclass \
                   AND d.refclassid = 'pg_catalog.pg_class'::regclass \
                   AND d.refobjid = {REL} AND v.oid <> d.refobjid ORDER BY 1, 2"
            ),
            p,
        )?;
        if object != ObjectKind::Table {
            r.section(
                "uses",
                &["refSchema", "refName"],
                &format!(
                    "SELECT DISTINCT tn.nspname::text, t.relname::text \
                     FROM pg_catalog.pg_rewrite w \
                     JOIN pg_catalog.pg_depend d ON d.objid = w.oid \
                       AND d.classid = 'pg_catalog.pg_rewrite'::regclass \
                       AND d.refclassid = 'pg_catalog.pg_class'::regclass \
                     JOIN pg_catalog.pg_class t ON t.oid = d.refobjid \
                     JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace \
                     WHERE w.ev_class = {REL} AND t.oid <> w.ev_class ORDER BY 1, 2"
                ),
                p,
            )?;
        }
        r.section(
            "privileges",
            &["grantee", "privilege", "grantable", "grantor"],
            "SELECT grantee::text, privilege_type::text, lower(is_grantable::text), grantor::text \
             FROM information_schema.table_privileges \
             WHERE table_schema = $1 AND table_name = $2 ORDER BY 1, 2",
            p,
        )?;
        if cockroach {
            return r.section(
                "stats",
                &["property", "value"],
                &format!(
                    "SELECT x.k, x.v FROM pg_catalog.pg_class c, \
                     LATERAL (VALUES \
                       ('owner', pg_catalog.pg_get_userbyid(c.relowner)::text), \
                       ('rows', CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint::text END), \
                       ('comment', pg_catalog.obj_description(c.oid, 'pg_class')) \
                     ) AS x(k, v) WHERE c.oid = {REL} AND x.v IS NOT NULL"
                ),
                p,
            );
        }
        r.section(
            "stats",
            &["property", "value"],
            &format!(
                "SELECT x.k, x.v FROM pg_catalog.pg_class c \
                 LEFT JOIN pg_catalog.pg_stat_all_tables st ON st.relid = c.oid, \
                 LATERAL (VALUES \
                   ('owner', pg_catalog.pg_get_userbyid(c.relowner)::text), \
                   ('rows', CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint::text END), \
                   ('dataSize', pg_catalog.pg_size_pretty(pg_catalog.pg_table_size(c.oid))), \
                   ('indexSize', pg_catalog.pg_size_pretty(pg_catalog.pg_indexes_size(c.oid))), \
                   ('totalSize', pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid))), \
                   ('lastVacuum', GREATEST(st.last_vacuum, st.last_autovacuum)::text), \
                   ('lastAnalyze', GREATEST(st.last_analyze, st.last_autoanalyze)::text), \
                   ('comment', pg_catalog.obj_description(c.oid, 'pg_class')) \
                 ) AS x(k, v) WHERE c.oid = {REL} AND x.v IS NOT NULL"
            ),
            p,
        )
    }

    fn rule(column: &str) -> String {
        format!(
            "CASE {column} WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade' \
             WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' ELSE {column}::text END"
        )
    }

    /// `CREATE TABLE` from the catalog: columns (type, collation, default, NOT NULL, identity, generated),
    /// partitioning, constraints, the sequences of serial columns, indexes, triggers, comments.
    fn table_ddl(r: &mut Reader, p: &[&str]) -> AppResult<Option<String>> {
        let Some(qname) = r.text(QNAME, p)? else {
            return Ok(None);
        };
        let mut out = String::new();
        // sequences a serial column owns: they must be there before the table
        let sequences = r.rows(
            &format!(
                "SELECT pg_catalog.quote_ident(sn.nspname) || '.' || pg_catalog.quote_ident(s.relname), \
                 pg_catalog.quote_ident(a.attname) \
                 FROM pg_catalog.pg_depend d \
                 JOIN pg_catalog.pg_class s ON s.oid = d.objid AND s.relkind = 'S' \
                 JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace \
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
                 WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.deptype = 'a' \
                   AND d.refobjid = {REL} ORDER BY 1"
            ),
            p,
        )?;
        for s in &sequences {
            out.push_str(&format!("CREATE SEQUENCE IF NOT EXISTS {};\n", at(s, 0)));
        }
        if !sequences.is_empty() {
            out.push('\n');
        }
        let parent = r.rows(
            &format!(
                "SELECT pg_catalog.quote_ident(pn.nspname) || '.' || pg_catalog.quote_ident(pc.relname), \
                 pg_catalog.pg_get_expr(c.relpartbound, c.oid) \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid \
                 JOIN pg_catalog.pg_class pc ON pc.oid = i.inhparent \
                 JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace \
                 WHERE c.oid = {REL} AND c.relispartition"
            ),
            p,
        )?;
        let key = r.text(&format!("SELECT pg_catalog.pg_get_partkeydef({REL})"), p)?;
        let unlogged = r
            .text(
                &format!(
                    "SELECT c.relpersistence::text FROM pg_catalog.pg_class c WHERE c.oid = {REL}"
                ),
                p,
            )?
            .is_some_and(|x| x == "u");
        let create = if unlogged {
            "CREATE UNLOGGED TABLE"
        } else {
            "CREATE TABLE"
        };
        if let Some(parent) = parent.first() {
            // a partition has the columns of its parent
            out.push_str(&format!(
                "{create} {qname} PARTITION OF {} {}",
                at(parent, 0),
                at(parent, 1)
            ));
        } else {
            let columns = r.rows(
                &format!(
                    "SELECT pg_catalog.quote_ident(a.attname), \
                     pg_catalog.format_type(a.atttypid, a.atttypmod), \
                     CASE WHEN a.attcollation <> t.typcollation AND a.attcollation <> 0 THEN \
                       (SELECT pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) \
                        FROM pg_catalog.pg_collation co \
                        JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace \
                        WHERE co.oid = a.attcollation) END, \
                     pg_catalog.pg_get_expr(d.adbin, d.adrelid), a.attnotnull::text, \
                     a.attidentity::text, a.attgenerated::text \
                     FROM pg_catalog.pg_attribute a \
                     JOIN pg_catalog.pg_type t ON t.oid = a.atttypid \
                     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                     WHERE a.attrelid = {REL} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
                ),
                p,
            )?;
            let mut lines: Vec<String> = columns
                .iter()
                .map(|c| {
                    let mut line = format!("    {} {}", at(c, 0), at(c, 1));
                    if let Some(collation) = opt(c, 2) {
                        line.push_str(&format!(" COLLATE {collation}"));
                    }
                    let expr = opt(c, 3);
                    match (at(c, 5).as_str(), at(c, 6).as_str()) {
                        ("a", _) => line.push_str(" GENERATED ALWAYS AS IDENTITY"),
                        ("d", _) => line.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
                        (_, "s") => {
                            if let Some(e) = &expr {
                                line.push_str(&format!(" GENERATED ALWAYS AS ({e}) STORED"));
                            }
                        }
                        _ => {
                            if let Some(e) = &expr {
                                line.push_str(&format!(" DEFAULT {e}"));
                            }
                        }
                    }
                    if matches!(at(c, 4).as_str(), "true" | "t") {
                        line.push_str(" NOT NULL");
                    }
                    line
                })
                .collect();
            // foreign keys come afterwards, so the order of the tables does not matter
            let inline = r.rows(
                &format!(
                    "SELECT pg_catalog.quote_ident(k.conname), pg_catalog.pg_get_constraintdef(k.oid) \
                     FROM pg_catalog.pg_constraint k WHERE k.conrelid = {REL} AND k.contype IN ('p', 'u', 'c', 'x') \
                       AND k.conislocal \
                     ORDER BY CASE k.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 ELSE 2 END, 1"
                ),
                p,
            )?;
            for k in &inline {
                lines.push(format!("    CONSTRAINT {} {}", at(k, 0), at(k, 1)));
            }
            out.push_str(&format!("{create} {qname} (\n{}\n)", lines.join(",\n")));
        }
        if let Some(key) = key.filter(|k| !k.is_empty()) {
            out.push_str(&format!(" PARTITION BY {key}"));
        }
        out.push_str(";\n");
        for s in &sequences {
            out.push_str(&format!(
                "ALTER SEQUENCE {} OWNED BY {qname}.{};\n",
                at(s, 0),
                at(s, 1)
            ));
        }
        let foreign = r.rows(
            &format!(
                "SELECT pg_catalog.quote_ident(k.conname), pg_catalog.pg_get_constraintdef(k.oid) \
                 FROM pg_catalog.pg_constraint k WHERE k.conrelid = {REL} AND k.contype = 'f' \
                   AND k.conislocal ORDER BY 1"
            ),
            p,
        )?;
        for k in &foreign {
            out.push_str(&format!(
                "\nALTER TABLE {qname} ADD CONSTRAINT {} {};\n",
                at(k, 0),
                at(k, 1)
            ));
        }
        // indexes that no constraint made
        let indexes = r.rows(
            &format!(
                "SELECT pg_catalog.pg_get_indexdef(i.indexrelid) FROM pg_catalog.pg_index i \
                 JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
                 WHERE i.indrelid = {REL} AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k \
                   WHERE k.conindid = i.indexrelid) \
                   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h WHERE h.inhrelid = i.indexrelid) \
                 ORDER BY ic.relname"
            ),
            p,
        )?;
        if !indexes.is_empty() {
            out.push('\n');
        }
        for i in &indexes {
            out.push_str(&format!("{};\n", at(i, 0)));
        }
        let triggers = r.rows(
            &format!(
                "SELECT pg_catalog.pg_get_triggerdef(t.oid) FROM pg_catalog.pg_trigger t \
                 WHERE t.tgrelid = {REL} AND NOT t.tgisinternal AND t.tgparentid = 0 ORDER BY t.tgname"
            ),
            p,
        )?;
        if !triggers.is_empty() {
            out.push('\n');
        }
        for t in &triggers {
            out.push_str(&format!("{};\n", at(t, 0)));
        }
        out.push_str(&comments(r, p, &qname, "TABLE")?);
        Ok(Some(out))
    }

    fn comments(r: &mut Reader, p: &[&str], qname: &str, word: &str) -> AppResult<String> {
        let mut out = String::new();
        if let Some(text) = r.text(
            &format!("SELECT pg_catalog.obj_description({REL}, 'pg_class')"),
            p,
        )? {
            out.push_str(&format!(
                "\nCOMMENT ON {word} {qname} IS {};\n",
                literal(&text)
            ));
        }
        let columns = r.rows(
            &format!(
                "SELECT pg_catalog.quote_ident(a.attname), pg_catalog.col_description(a.attrelid, a.attnum) \
                 FROM pg_catalog.pg_attribute a WHERE a.attrelid = {REL} AND a.attnum > 0 \
                   AND NOT a.attisdropped \
                   AND pg_catalog.col_description(a.attrelid, a.attnum) IS NOT NULL ORDER BY a.attnum"
            ),
            p,
        )?;
        for c in &columns {
            out.push_str(&format!(
                "COMMENT ON COLUMN {qname}.{} IS {};\n",
                at(c, 0),
                literal(&at(c, 1))
            ));
        }
        Ok(out)
    }

    fn view_ddl(r: &mut Reader, p: &[&str], materialized: bool) -> AppResult<Option<String>> {
        let Some(qname) = r.text(QNAME, p)? else {
            return Ok(None);
        };
        let Some(body) = r.text(&format!("SELECT pg_catalog.pg_get_viewdef({REL}, true)"), p)?
        else {
            return Ok(None);
        };
        let body = body.trim().trim_end_matches(';');
        let mut out = if materialized {
            format!("CREATE MATERIALIZED VIEW {qname} AS\n{body};\n")
        } else {
            format!("CREATE OR REPLACE VIEW {qname} AS\n{body};\n")
        };
        if materialized {
            let indexes = r.rows(
                &format!(
                    "SELECT pg_catalog.pg_get_indexdef(i.indexrelid) FROM pg_catalog.pg_index i \
                     JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid \
                     WHERE i.indrelid = {REL} ORDER BY ic.relname"
                ),
                p,
            )?;
            for i in &indexes {
                out.push_str(&format!("{};\n", at(i, 0)));
            }
        }
        let word = if materialized {
            "MATERIALIZED VIEW"
        } else {
            "VIEW"
        };
        out.push_str(&comments(r, p, &qname, word)?);
        Ok(Some(out))
    }

    fn routine(
        r: &mut Reader,
        schema: &str,
        name: &str,
        detail: &str,
    ) -> AppResult<Option<String>> {
        // overloads are told apart by their arguments; without them the first one is taken
        const WHICH: &str = "(SELECT p.oid FROM pg_catalog.pg_proc p \
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
            WHERE n.nspname = $1 AND p.proname = $2 \
              AND ($3 = '' OR pg_catalog.pg_get_function_identity_arguments(p.oid) = $3) \
            ORDER BY p.oid LIMIT 1)";
        let p = &[schema, name, detail];
        r.section(
            "properties",
            &["property", "value"],
            &format!(
                "SELECT x.k, x.v FROM pg_catalog.pg_proc p \
                 JOIN pg_catalog.pg_language l ON l.oid = p.prolang, \
                 LATERAL (VALUES \
                   ('kind', CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' \
                      WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window function' END), \
                   ('arguments', pg_catalog.pg_get_function_arguments(p.oid)), \
                   ('returns', CASE WHEN p.prokind <> 'p' THEN pg_catalog.pg_get_function_result(p.oid) END), \
                   ('language', l.lanname::text), \
                   ('volatility', CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' \
                      ELSE 'volatile' END), \
                   ('security', CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END), \
                   ('owner', pg_catalog.pg_get_userbyid(p.proowner)::text), \
                   ('comment', pg_catalog.obj_description(p.oid, 'pg_proc')) \
                 ) AS x(k, v) WHERE p.oid = {WHICH} AND x.v IS NOT NULL"
            ),
            p,
        )?;
        // aggregates have no definition of this kind: the server refuses and the DDL is noted as missing
        let ddl = r.text(&format!("SELECT pg_catalog.pg_get_functiondef({WHICH})"), p)?;
        Ok(ddl.map(|d| format!("{};\n", d.trim_end().trim_end_matches(';'))))
    }

    fn sequence(r: &mut Reader, p: &[&str]) -> AppResult<Option<String>> {
        let rows = r.rows(
            "SELECT data_type::text, start_value::text, min_value::text, max_value::text, \
             increment_by::text, cycle::text, cache_size::text, last_value::text, sequenceowner::text \
             FROM pg_catalog.pg_sequences WHERE schemaname = $1 AND sequencename = $2",
            p,
        )?;
        let Some(s) = rows.first() else {
            return Ok(None);
        };
        let keys = [
            "type",
            "start",
            "min",
            "max",
            "increment",
            "cycle",
            "cache",
            "lastValue",
            "owner",
        ];
        let properties: TextRows = keys
            .iter()
            .enumerate()
            .filter_map(|(i, k)| opt(s, i).map(|v| vec![Some(k.to_string()), Some(v)]))
            .collect();
        r.push("properties", &["property", "value"], properties);
        let Some(qname) = r.text(QNAME, p)? else {
            return Ok(None);
        };
        let cycle = if matches!(at(s, 5).as_str(), "true" | "t") {
            " CYCLE"
        } else {
            ""
        };
        Ok(Some(format!(
            "CREATE SEQUENCE {qname} AS {} INCREMENT BY {} MINVALUE {} MAXVALUE {} START WITH {} CACHE {}{cycle};\n",
            at(s, 0),
            at(s, 4),
            at(s, 2),
            at(s, 3),
            at(s, 1),
            at(s, 6),
        )))
    }

    fn type_(r: &mut Reader, p: &[&str]) -> AppResult<Option<String>> {
        const TYPE: &str = "(SELECT t.oid FROM pg_catalog.pg_type t \
            JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
            WHERE n.nspname = $1 AND t.typname = $2)";
        let head = r.rows(
            &format!(
                "SELECT t.typtype::text, pg_catalog.quote_ident(n.nspname) || '.' || \
                 pg_catalog.quote_ident(t.typname), pg_catalog.pg_get_userbyid(t.typowner)::text, \
                 pg_catalog.format_type(t.typbasetype, t.typtypmod), t.typnotnull::text, t.typdefault, \
                 pg_catalog.obj_description(t.oid, 'pg_type') \
                 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
                 WHERE t.oid = {TYPE}"
            ),
            p,
        )?;
        let Some(t) = head.first() else {
            return Ok(None);
        };
        let sort = match at(t, 0).as_str() {
            "e" => "enum",
            "c" => "composite",
            "d" => "domain",
            "r" => "range",
            _ => "other",
        };
        let mut properties: TextRows = vec![
            vec![Some("kind".into()), Some(sort.into())],
            vec![Some("owner".into()), Some(at(t, 2))],
        ];
        if let Some(comment) = opt(t, 6) {
            properties.push(vec![Some("comment".into()), Some(comment)]);
        }
        let qname = at(t, 1);
        let ddl = match sort {
            "enum" => {
                let labels = r.rows(
                    &format!(
                        "SELECT e.enumlabel::text FROM pg_catalog.pg_enum e WHERE e.enumtypid = {TYPE} \
                         ORDER BY e.enumsortorder"
                    ),
                    p,
                )?;
                let list: Vec<String> = labels.iter().map(|l| literal(&at(l, 0))).collect();
                r.push("values", &["value"], labels);
                Some(format!(
                    "CREATE TYPE {qname} AS ENUM ({});\n",
                    list.join(", ")
                ))
            }
            "composite" => {
                let attributes = r.rows(
                    &format!(
                        "SELECT pg_catalog.quote_ident(a.attname), \
                         pg_catalog.format_type(a.atttypid, a.atttypmod) \
                         FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.typrelid = a.attrelid \
                         WHERE t.oid = {TYPE} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
                    ),
                    p,
                )?;
                let list: Vec<String> = attributes
                    .iter()
                    .map(|a| format!("    {} {}", at(a, 0), at(a, 1)))
                    .collect();
                r.push("columns", &["name", "type"], attributes);
                Some(format!(
                    "CREATE TYPE {qname} AS (\n{}\n);\n",
                    list.join(",\n")
                ))
            }
            "domain" => {
                properties.push(vec![Some("type".into()), Some(at(t, 3))]);
                let checks = r.rows(
                    &format!(
                        "SELECT pg_catalog.quote_ident(k.conname), pg_catalog.pg_get_constraintdef(k.oid) \
                         FROM pg_catalog.pg_constraint k WHERE k.contypid = {TYPE} AND k.contype = 'c' ORDER BY 1"
                    ),
                    p,
                )?;
                let mut out = format!("CREATE DOMAIN {qname} AS {}", at(t, 3));
                if let Some(default) = opt(t, 5) {
                    out.push_str(&format!(" DEFAULT {default}"));
                }
                if matches!(at(t, 4).as_str(), "true" | "t") {
                    out.push_str(" NOT NULL");
                }
                for k in &checks {
                    out.push_str(&format!("\n    CONSTRAINT {} {}", at(k, 0), at(k, 1)));
                }
                out.push_str(";\n");
                Some(out)
            }
            _ => None,
        };
        r.push("properties", &["property", "value"], properties);
        Ok(ddl)
    }
}

mod mysql {
    use super::*;

    pub fn read(
        r: &mut Reader,
        schema: &str,
        name: &str,
        object: ObjectKind,
    ) -> AppResult<Option<String>> {
        let p = &[schema, name];
        let q = format!(
            "{}.{}",
            quote_always(schema, DbKind::Mysql),
            quote_always(name, DbKind::Mysql)
        );
        match object {
            ObjectKind::Table | ObjectKind::View | ObjectKind::Matview => {
                relation_sections(r, p, object)?;
                if object == ObjectKind::Table {
                    table_ddl(r, p, &q)
                } else {
                    Ok(show(r, &format!("SHOW CREATE VIEW {q}"), 1)?.map(|d| format!("{d};\n")))
                }
            }
            ObjectKind::Routine => routine(r, p, &q),
            // MySQL has neither; MariaDB's sequences are listed as tables
            ObjectKind::Sequence | ObjectKind::Type => Ok(None),
        }
    }

    /// The text `SHOW CREATE …` gives in column `index`. The name is quoted by `quote_always`: a name
    /// cannot be bound here.
    fn show(r: &mut Reader, sql: &str, index: usize) -> AppResult<Option<String>> {
        Ok(r.rows(sql, &[])?
            .into_iter()
            .next()
            .and_then(|row| row.into_iter().nth(index).flatten())
            .filter(|t| !t.trim().is_empty()))
    }

    fn relation_sections(r: &mut Reader, p: &[&str], object: ObjectKind) -> AppResult<()> {
        r.section(
            "columns",
            &["name", "type", "nullable", "default", "key", "extra", "comment"],
            "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, LOWER(c.IS_NULLABLE), c.COLUMN_DEFAULT, \
             CASE WHEN c.COLUMN_KEY = 'PRI' THEN 'pk' \
               WHEN EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k \
                 WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME \
                   AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL) THEN 'fk' \
               ELSE '' END, c.EXTRA, c.COLUMN_COMMENT \
             FROM information_schema.COLUMNS c \
             WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION",
            p,
        )?;
        if object == ObjectKind::Table {
            r.section(
                "indexes",
                &["name", "columns", "unique", "primary", "method", "comment"],
                "SELECT INDEX_NAME, GROUP_CONCAT(COALESCE(COLUMN_NAME, '(expression)') \
                   ORDER BY SEQ_IN_INDEX SEPARATOR ', '), \
                 CASE WHEN MIN(NON_UNIQUE) = 0 THEN 'yes' ELSE 'no' END, \
                 CASE WHEN INDEX_NAME = 'PRIMARY' THEN 'yes' ELSE 'no' END, LOWER(MIN(INDEX_TYPE)), \
                 MIN(INDEX_COMMENT) \
                 FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME ORDER BY 1",
                p,
            )?;
            r.section(
                "constraints",
                &["name", "type", "definition"],
                "SELECT tc.CONSTRAINT_NAME, LOWER(tc.CONSTRAINT_TYPE), CONCAT( \
                   COALESCE(CONCAT('(', GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION \
                     SEPARATOR ', '), ')'), ''), \
                   COALESCE(CONCAT(' REFERENCES ', MIN(k.REFERENCED_TABLE_SCHEMA), '.', \
                     MIN(k.REFERENCED_TABLE_NAME), ' (', \
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
            )?;
            r.section(
                "references",
                &["name", "columns", "refSchema", "refName", "refColumns", "onUpdate", "onDelete"],
                "SELECT k.CONSTRAINT_NAME, \
                 GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', '), \
                 MIN(k.REFERENCED_TABLE_SCHEMA), MIN(k.REFERENCED_TABLE_NAME), \
                 GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', '), \
                 LOWER(MIN(rc.UPDATE_RULE)), LOWER(MIN(rc.DELETE_RULE)) \
                 FROM information_schema.KEY_COLUMN_USAGE k \
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
                   ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
                   AND rc.TABLE_NAME = k.TABLE_NAME \
                 WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL \
                 GROUP BY k.CONSTRAINT_NAME ORDER BY 1",
                p,
            )?;
            r.section(
                "referencedBy",
                &["name", "refSchema", "refName", "columns", "onUpdate", "onDelete"],
                "SELECT k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, \
                 GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', '), \
                 LOWER(MIN(rc.UPDATE_RULE)), LOWER(MIN(rc.DELETE_RULE)) \
                 FROM information_schema.KEY_COLUMN_USAGE k \
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
                   ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
                   AND rc.TABLE_NAME = k.TABLE_NAME \
                 WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ? \
                 GROUP BY k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME ORDER BY 2, 3, 1",
                p,
            )?;
            r.section(
                "triggers",
                &["name", "definition", "enabled"],
                "SELECT TRIGGER_NAME, CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION), 'yes' \
                 FROM information_schema.TRIGGERS \
                 WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY 1",
                p,
            )?;
            r.section(
                "partitions",
                &["name", "method", "expression", "bound", "rows"],
                "SELECT PARTITION_NAME, LOWER(PARTITION_METHOD), PARTITION_EXPRESSION, \
                 PARTITION_DESCRIPTION, CAST(TABLE_ROWS AS CHAR) \
                 FROM information_schema.PARTITIONS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL \
                 ORDER BY PARTITION_ORDINAL_POSITION",
                p,
            )?;
        }
        // MySQL 8 lists what a view reads; MariaDB has no such table: the list is noted as missing there
        r.section(
            "usedBy",
            &["refSchema", "refName"],
            "SELECT DISTINCT VIEW_SCHEMA, VIEW_NAME FROM information_schema.VIEW_TABLE_USAGE \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY 1, 2",
            p,
        )?;
        if object != ObjectKind::Table {
            r.section(
                "uses",
                &["refSchema", "refName"],
                "SELECT DISTINCT TABLE_SCHEMA, TABLE_NAME FROM information_schema.VIEW_TABLE_USAGE \
                 WHERE VIEW_SCHEMA = ? AND VIEW_NAME = ? ORDER BY 1, 2",
                p,
            )?;
        }
        r.section(
            "privileges",
            &["grantee", "privilege", "grantable"],
            "SELECT GRANTEE, PRIVILEGE_TYPE, LOWER(IS_GRANTABLE) \
             FROM information_schema.TABLE_PRIVILEGES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY 1, 2",
            p,
        )?;
        r.section(
            "stats",
            &["property", "value"],
            "SELECT x.k, x.v FROM (\
               SELECT 'engine' AS k, ENGINE AS v, 1 AS o FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
               UNION ALL SELECT 'rows', CAST(TABLE_ROWS AS CHAR), 2 FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
               UNION ALL SELECT 'dataSize', CONCAT(CEILING(DATA_LENGTH / 1024), ' kB'), 3 \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
               UNION ALL SELECT 'indexSize', CONCAT(CEILING(INDEX_LENGTH / 1024), ' kB'), 4 \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
               UNION ALL SELECT 'collation', TABLE_COLLATION, 5 FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
               UNION ALL SELECT 'created', CAST(CREATE_TIME AS CHAR), 6 FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
               UNION ALL SELECT 'comment', NULLIF(TABLE_COMMENT, ''), 7 FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ) x WHERE x.v IS NOT NULL ORDER BY x.o",
            &[
                p[0], p[1], p[0], p[1], p[0], p[1], p[0], p[1], p[0], p[1], p[0], p[1], p[0], p[1],
            ],
        )
    }

    fn table_ddl(r: &mut Reader, p: &[&str], q: &str) -> AppResult<Option<String>> {
        let Some(create) = show(r, &format!("SHOW CREATE TABLE {q}"), 1)? else {
            return Ok(None);
        };
        let mut out = format!("{create};\n");
        let triggers = r.rows(
            "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS \
             WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY 1",
            p,
        )?;
        for t in &triggers {
            let name = format!(
                "{}.{}",
                quote_always(p[0], DbKind::Mysql),
                quote_always(&at(t, 0), DbKind::Mysql)
            );
            if let Some(text) = show(r, &format!("SHOW CREATE TRIGGER {name}"), 2)? {
                out.push_str(&format!("\n{text};\n"));
            }
        }
        Ok(Some(out))
    }

    fn routine(r: &mut Reader, p: &[&str], q: &str) -> AppResult<Option<String>> {
        let kinds = r.rows(
            "SELECT ROUTINE_TYPE, DTD_IDENTIFIER, ROUTINE_BODY, IS_DETERMINISTIC, SQL_DATA_ACCESS, \
             SECURITY_TYPE, DEFINER, NULLIF(ROUTINE_COMMENT, '') \
             FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? \
             ORDER BY ROUTINE_TYPE LIMIT 1",
            p,
        )?;
        let Some(k) = kinds.first() else {
            return Ok(None);
        };
        let word = if at(k, 0).eq_ignore_ascii_case("PROCEDURE") {
            "PROCEDURE"
        } else {
            "FUNCTION"
        };
        let keys = [
            "kind",
            "returns",
            "language",
            "deterministic",
            "dataAccess",
            "security",
            "owner",
            "comment",
        ];
        let properties: TextRows = keys
            .iter()
            .enumerate()
            .filter_map(|(i, key)| {
                opt(k, i).map(|v| vec![Some(key.to_string()), Some(v.to_lowercase())])
            })
            .collect();
        r.push("properties", &["property", "value"], properties);
        r.section(
            "parameters",
            &["name", "type", "mode"],
            "SELECT PARAMETER_NAME, DTD_IDENTIFIER, LOWER(PARAMETER_MODE) \
             FROM information_schema.PARAMETERS \
             WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ORDINAL_POSITION > 0 \
             ORDER BY ORDINAL_POSITION",
            p,
        )?;
        Ok(show(r, &format!("SHOW CREATE {word} {q}"), 2)?.map(|d| format!("{d};\n")))
    }
}

mod mssql {
    use super::*;

    /// The object named by `@P1`.`@P2`.
    const OBJ: &str = "(SELECT o.object_id FROM sys.objects o \
        JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @P1 AND o.name = @P2)";
    /// The type of a column as it is written.
    const TYPE: &str = "t.name + CASE \
        WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') THEN '(' + \
          CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')' \
        WHEN t.name IN ('nvarchar', 'nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' \
          ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')' \
        WHEN t.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS varchar(10)) + ', ' \
          + CAST(c.scale AS varchar(10)) + ')' \
        WHEN t.name IN ('datetime2', 'time', 'datetimeoffset') THEN '(' + CAST(c.scale AS varchar(10)) + ')' \
        ELSE '' END";

    fn columns_of(table: &str, position: &str, on: &str) -> String {
        format!(
            "COALESCE((SELECT STRING_AGG(CAST(QUOTENAME(c.name) AS nvarchar(max)), ', ') \
               WITHIN GROUP (ORDER BY {position}) FROM {table} JOIN sys.columns c ON {on}), '')"
        )
    }

    pub fn read(
        r: &mut Reader,
        schema: &str,
        name: &str,
        object: ObjectKind,
    ) -> AppResult<Option<String>> {
        let p = &[schema, name];
        match object {
            ObjectKind::Table | ObjectKind::View | ObjectKind::Matview => {
                relation_sections(r, p, object)?;
                if object == ObjectKind::Table {
                    table_ddl(r, p)
                } else {
                    module(r, p)
                }
            }
            ObjectKind::Routine => {
                r.section(
                    "properties",
                    &["property", "value"],
                    &format!(
                        "SELECT x.k, x.v FROM sys.objects o CROSS APPLY (VALUES \
                           ('kind', LOWER(o.type_desc COLLATE DATABASE_DEFAULT)), \
                           ('created', CONVERT(nvarchar(30), o.create_date, 120)), \
                           ('modified', CONVERT(nvarchar(30), o.modify_date, 120))) AS x(k, v) \
                         WHERE o.object_id = {OBJ}"
                    ),
                    p,
                )?;
                r.section(
                    "parameters",
                    &["name", "type", "mode"],
                    &format!(
                        "SELECT c.name, {TYPE}, CASE WHEN c.is_output = 1 THEN 'out' ELSE 'in' END \
                         FROM sys.parameters c JOIN sys.types t ON t.user_type_id = c.user_type_id \
                         WHERE c.object_id = {OBJ} AND c.parameter_id > 0 ORDER BY c.parameter_id"
                    ),
                    p,
                )?;
                module(r, p)
            }
            ObjectKind::Sequence => sequence(r, p),
            ObjectKind::Type => Ok(None),
        }
    }

    /// The text of a view, a routine or a trigger as it was written.
    fn module(r: &mut Reader, p: &[&str]) -> AppResult<Option<String>> {
        let text = r.text(
            &format!("SELECT m.definition FROM sys.sql_modules m WHERE m.object_id = {OBJ}"),
            p,
        )?;
        Ok(text.map(|t| format!("{}\nGO\n", t.trim_end())))
    }

    fn relation_sections(r: &mut Reader, p: &[&str], object: ObjectKind) -> AppResult<()> {
        r.section(
            "columns",
            &["name", "type", "nullable", "default", "key", "extra", "comment"],
            &format!(
                "SELECT c.name, {TYPE}, CASE WHEN c.is_nullable = 1 THEN 'yes' ELSE 'no' END, \
                 dc.definition, \
                 CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i \
                     ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
                     WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id \
                       AND ic.column_id = c.column_id) THEN 'pk' \
                   WHEN EXISTS (SELECT 1 FROM sys.foreign_key_columns f \
                     WHERE f.parent_object_id = c.object_id AND f.parent_column_id = c.column_id) THEN 'fk' \
                   ELSE '' END, \
                 CASE WHEN c.is_identity = 1 THEN 'identity' \
                   WHEN c.is_computed = 1 THEN 'computed: ' + cc.definition ELSE '' END, \
                 CAST(ep.value AS nvarchar(4000)) \
                 FROM sys.columns c \
                 JOIN sys.types t ON t.user_type_id = c.user_type_id \
                 LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
                 LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id \
                   AND cc.column_id = c.column_id \
                 LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id \
                   AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' \
                 WHERE c.object_id = {OBJ} ORDER BY c.column_id"
            ),
            p,
        )?;
        r.section(
            "indexes",
            &["name", "columns", "unique", "primary", "method"],
            &format!(
                "SELECT i.name, {cols}, CASE WHEN i.is_unique = 1 THEN 'yes' ELSE 'no' END, \
                 CASE WHEN i.is_primary_key = 1 THEN 'yes' ELSE 'no' END, \
                 LOWER(i.type_desc COLLATE DATABASE_DEFAULT) \
                 FROM sys.indexes i WHERE i.object_id = {OBJ} AND i.name IS NOT NULL ORDER BY 1",
                cols = columns_of(
                    "sys.index_columns ic",
                    "ic.key_ordinal",
                    "c.object_id = ic.object_id AND c.column_id = ic.column_id \
                     WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id \
                       AND ic.is_included_column = 0"
                ),
            ),
            p,
        )?;
        if object == ObjectKind::Table {
            r.section(
                "constraints",
                &["name", "type", "definition"],
                &format!(
                    "SELECT x.name, x.kind, x.definition FROM (\
                       SELECT kc.name, CASE WHEN kc.type = 'PK' THEN 'primary key' ELSE 'unique' END AS kind, \
                         '(' + {key_cols} + ')' AS definition, CASE WHEN kc.type = 'PK' THEN 0 ELSE 1 END AS o \
                       FROM sys.key_constraints kc WHERE kc.parent_object_id = {OBJ} \
                       UNION ALL SELECT f.name, 'foreign key', '(' + {fk_cols} + ') REFERENCES ' \
                         + QUOTENAME(rs.name) + '.' + QUOTENAME(ro.name) + ' (' + {ref_cols} + ')', 2 \
                       FROM sys.foreign_keys f \
                       JOIN sys.objects ro ON ro.object_id = f.referenced_object_id \
                       JOIN sys.schemas rs ON rs.schema_id = ro.schema_id \
                       WHERE f.parent_object_id = {OBJ} \
                       UNION ALL SELECT k.name, 'check', k.definition, 3 FROM sys.check_constraints k \
                       WHERE k.parent_object_id = {OBJ} \
                       UNION ALL SELECT d.name, 'default', d.definition, 4 FROM sys.default_constraints d \
                       WHERE d.parent_object_id = {OBJ}) x ORDER BY x.o, x.name",
                    key_cols = columns_of(
                        "sys.index_columns ic",
                        "ic.key_ordinal",
                        "c.object_id = ic.object_id AND c.column_id = ic.column_id \
                         WHERE ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id"
                    ),
                    fk_cols = FK_COLS,
                    ref_cols = REF_COLS,
                ),
                p,
            )?;
            r.section(
                "references",
                &["name", "columns", "refSchema", "refName", "refColumns", "onUpdate", "onDelete"],
                &format!(
                    "SELECT f.name, {FK_COLS}, rs.name, ro.name, {REF_COLS}, \
                     LOWER(REPLACE(f.update_referential_action_desc COLLATE DATABASE_DEFAULT, '_', ' ')), \
                     LOWER(REPLACE(f.delete_referential_action_desc COLLATE DATABASE_DEFAULT, '_', ' ')) \
                     FROM sys.foreign_keys f \
                     JOIN sys.objects ro ON ro.object_id = f.referenced_object_id \
                     JOIN sys.schemas rs ON rs.schema_id = ro.schema_id \
                     WHERE f.parent_object_id = {OBJ} ORDER BY 1"
                ),
                p,
            )?;
            r.section(
                "referencedBy",
                &["name", "refSchema", "refName", "columns", "onUpdate", "onDelete"],
                &format!(
                    "SELECT f.name, ps.name, po.name, {FK_COLS}, \
                     LOWER(REPLACE(f.update_referential_action_desc COLLATE DATABASE_DEFAULT, '_', ' ')), \
                     LOWER(REPLACE(f.delete_referential_action_desc COLLATE DATABASE_DEFAULT, '_', ' ')) \
                     FROM sys.foreign_keys f \
                     JOIN sys.objects po ON po.object_id = f.parent_object_id \
                     JOIN sys.schemas ps ON ps.schema_id = po.schema_id \
                     WHERE f.referenced_object_id = {OBJ} ORDER BY 2, 3, 1"
                ),
                p,
            )?;
        }
        r.section(
            "triggers",
            &["name", "definition", "enabled"],
            &format!(
                "SELECT t.name, CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END, \
                 CASE WHEN t.is_disabled = 1 THEN 'no' ELSE 'yes' END \
                 FROM sys.triggers t WHERE t.parent_id = {OBJ} ORDER BY t.name"
            ),
            p,
        )?;
        r.section(
            "usedBy",
            &["refSchema", "refName"],
            &format!(
                "SELECT DISTINCT s.name, o.name FROM sys.sql_expression_dependencies d \
                 JOIN sys.objects o ON o.object_id = d.referencing_id \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 WHERE d.referenced_id = {OBJ} ORDER BY 1, 2"
            ),
            p,
        )?;
        if object != ObjectKind::Table {
            r.section(
                "uses",
                &["refSchema", "refName"],
                &format!(
                    "SELECT DISTINCT COALESCE(d.referenced_schema_name, s.name), d.referenced_entity_name \
                     FROM sys.sql_expression_dependencies d \
                     LEFT JOIN sys.objects o ON o.object_id = d.referenced_id \
                     LEFT JOIN sys.schemas s ON s.schema_id = o.schema_id \
                     WHERE d.referencing_id = {OBJ} AND d.referenced_entity_name IS NOT NULL ORDER BY 1, 2"
                ),
                p,
            )?;
        }
        r.section(
            "privileges",
            &["grantee", "privilege", "grantable"],
            &format!(
                "SELECT USER_NAME(dp.grantee_principal_id), dp.permission_name COLLATE DATABASE_DEFAULT, \
                 CASE WHEN dp.state = 'W' THEN 'yes' WHEN dp.state = 'D' THEN 'denied' ELSE 'no' END \
                 FROM sys.database_permissions dp WHERE dp.class = 1 AND dp.major_id = {OBJ} \
                 ORDER BY 1, 2"
            ),
            p,
        )?;
        r.section(
            "stats",
            &["property", "value"],
            &format!(
                "SELECT x.k, x.v FROM sys.objects o CROSS APPLY (VALUES \
                   ('rows', (SELECT CAST(SUM(pt.rows) AS nvarchar(30)) FROM sys.partitions pt \
                      WHERE pt.object_id = o.object_id AND pt.index_id IN (0, 1))), \
                   ('created', CONVERT(nvarchar(30), o.create_date, 120)), \
                   ('modified', CONVERT(nvarchar(30), o.modify_date, 120)), \
                   ('comment', (SELECT CAST(ep.value AS nvarchar(4000)) FROM sys.extended_properties ep \
                      WHERE ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 \
                        AND ep.name = 'MS_Description'))) AS x(k, v) \
                 WHERE o.object_id = {OBJ} AND x.v IS NOT NULL"
            ),
            p,
        )
    }

    const FK_COLS: &str = "COALESCE((SELECT STRING_AGG(CAST(QUOTENAME(c.name) AS nvarchar(max)), ', ') \
        WITHIN GROUP (ORDER BY fc.constraint_column_id) FROM sys.foreign_key_columns fc \
        JOIN sys.columns c ON c.object_id = fc.parent_object_id AND c.column_id = fc.parent_column_id \
        WHERE fc.constraint_object_id = f.object_id), '')";
    const REF_COLS: &str = "COALESCE((SELECT STRING_AGG(CAST(QUOTENAME(c.name) AS nvarchar(max)), ', ') \
        WITHIN GROUP (ORDER BY fc.constraint_column_id) FROM sys.foreign_key_columns fc \
        JOIN sys.columns c ON c.object_id = fc.referenced_object_id \
          AND c.column_id = fc.referenced_column_id \
        WHERE fc.constraint_object_id = f.object_id), '')";

    /// `CREATE TABLE` from the catalog: columns (type, identity, computed, NULL, named defaults), primary
    /// and unique keys, checks; then foreign keys and the other indexes.
    fn table_ddl(r: &mut Reader, p: &[&str]) -> AppResult<Option<String>> {
        let Some(qname) = r.text(
            "SELECT QUOTENAME(s.name) + '.' + QUOTENAME(o.name) FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.name = @P2 AND o.type = 'U'",
            p,
        )?
        else {
            return Ok(None);
        };
        let columns = r.rows(
            &format!(
                "SELECT QUOTENAME(c.name), {TYPE}, CASE WHEN c.is_nullable = 1 THEN '1' ELSE '0' END, \
                 QUOTENAME(dc.name), dc.definition, \
                 CASE WHEN c.is_identity = 1 THEN CAST(ic.seed_value AS nvarchar(40)) + ', ' \
                   + CAST(ic.increment_value AS nvarchar(40)) END, \
                 cc.definition, CASE WHEN cc.is_persisted = 1 THEN '1' ELSE '0' END \
                 FROM sys.columns c \
                 JOIN sys.types t ON t.user_type_id = c.user_type_id \
                 LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
                 LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id \
                   AND ic.column_id = c.column_id \
                 LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id \
                   AND cc.column_id = c.column_id \
                 WHERE c.object_id = {OBJ} ORDER BY c.column_id"
            ),
            p,
        )?;
        if columns.is_empty() {
            return Ok(None);
        }
        let mut lines: Vec<String> = columns
            .iter()
            .map(|c| {
                if let Some(computed) = opt(c, 6) {
                    let persisted = if at(c, 7) == "1" { " PERSISTED" } else { "" };
                    return format!("    {} AS {computed}{persisted}", at(c, 0));
                }
                let mut line = format!("    {} {}", at(c, 0), at(c, 1));
                if let Some(identity) = opt(c, 5) {
                    line.push_str(&format!(" IDENTITY({identity})"));
                }
                line.push_str(if at(c, 2) == "1" {
                    " NULL"
                } else {
                    " NOT NULL"
                });
                if let (Some(name), Some(definition)) = (opt(c, 3), opt(c, 4)) {
                    line.push_str(&format!(" CONSTRAINT {name} DEFAULT {definition}"));
                }
                line
            })
            .collect();
        let keys = r.rows(
            &format!(
                "SELECT QUOTENAME(kc.name), CASE WHEN kc.type = 'PK' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END, \
                 i.type_desc COLLATE DATABASE_DEFAULT, {cols} \
                 FROM sys.key_constraints kc \
                 JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id \
                 WHERE kc.parent_object_id = {OBJ} ORDER BY kc.type, kc.name",
                cols = index_columns("kc.parent_object_id", "kc.unique_index_id", false),
            ),
            p,
        )?;
        for k in &keys {
            lines.push(format!(
                "    CONSTRAINT {} {} {} ({})",
                at(k, 0),
                at(k, 1),
                at(k, 2),
                at(k, 3)
            ));
        }
        let checks = r.rows(
            &format!(
                "SELECT QUOTENAME(k.name), k.definition FROM sys.check_constraints k \
                 WHERE k.parent_object_id = {OBJ} ORDER BY k.name"
            ),
            p,
        )?;
        for k in &checks {
            lines.push(format!("    CONSTRAINT {} CHECK {}", at(k, 0), at(k, 1)));
        }
        let mut out = format!("CREATE TABLE {qname} (\n{}\n);\n", lines.join(",\n"));
        let foreign = r.rows(
            &format!(
                "SELECT QUOTENAME(f.name), {FK_COLS}, QUOTENAME(rs.name) + '.' + QUOTENAME(ro.name), \
                 {REF_COLS}, REPLACE(f.update_referential_action_desc COLLATE DATABASE_DEFAULT, '_', ' '), \
                 REPLACE(f.delete_referential_action_desc COLLATE DATABASE_DEFAULT, '_', ' ') \
                 FROM sys.foreign_keys f \
                 JOIN sys.objects ro ON ro.object_id = f.referenced_object_id \
                 JOIN sys.schemas rs ON rs.schema_id = ro.schema_id \
                 WHERE f.parent_object_id = {OBJ} ORDER BY f.name"
            ),
            p,
        )?;
        for f in &foreign {
            out.push_str(&format!(
                "\nALTER TABLE {qname} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) \
                 ON UPDATE {} ON DELETE {};\n",
                at(f, 0),
                at(f, 1),
                at(f, 2),
                at(f, 3),
                at(f, 4),
                at(f, 5)
            ));
        }
        let indexes = r.rows(
            &format!(
                "SELECT QUOTENAME(i.name), CASE WHEN i.is_unique = 1 THEN 'UNIQUE ' ELSE '' END, \
                 i.type_desc COLLATE DATABASE_DEFAULT, {keys}, {included}, i.filter_definition \
                 FROM sys.indexes i WHERE i.object_id = {OBJ} AND i.name IS NOT NULL \
                   AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.type IN (1, 2) \
                 ORDER BY i.name",
                keys = index_columns("i.object_id", "i.index_id", false),
                included = index_columns("i.object_id", "i.index_id", true),
            ),
            p,
        )?;
        if !indexes.is_empty() {
            out.push('\n');
        }
        for i in &indexes {
            let mut line = format!(
                "CREATE {}{} INDEX {} ON {qname} ({})",
                at(i, 1),
                at(i, 2),
                at(i, 0),
                at(i, 3)
            );
            if let Some(included) = opt(i, 4) {
                line.push_str(&format!(" INCLUDE ({included})"));
            }
            if let Some(filter) = opt(i, 5) {
                line.push_str(&format!(" WHERE {filter}"));
            }
            out.push_str(&format!("{line};\n"));
        }
        // triggers are batches of their own
        let triggers = r.rows(
            &format!(
                "SELECT m.definition FROM sys.triggers t JOIN sys.sql_modules m ON m.object_id = t.object_id \
                 WHERE t.parent_id = {OBJ} ORDER BY t.name"
            ),
            p,
        )?;
        for t in &triggers {
            out.push_str(&format!("GO\n{}\nGO\n", at(t, 0).trim_end()));
        }
        Ok(Some(out))
    }

    /// The key columns of an index with their direction, or its included columns.
    fn index_columns(object: &str, index: &str, included: bool) -> String {
        let direction = if included {
            "''"
        } else {
            "CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END"
        };
        let order = if included {
            "ic.index_column_id"
        } else {
            "ic.key_ordinal"
        };
        format!(
            "COALESCE((SELECT STRING_AGG(CAST(QUOTENAME(c.name) AS nvarchar(max)) + {direction}, ', ') \
               WITHIN GROUP (ORDER BY {order}) FROM sys.index_columns ic \
               JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
               WHERE ic.object_id = {object} AND ic.index_id = {index} \
                 AND ic.is_included_column = {}), '')",
            if included { 1 } else { 0 }
        )
    }

    fn sequence(r: &mut Reader, p: &[&str]) -> AppResult<Option<String>> {
        let rows = r.rows(
            "SELECT QUOTENAME(s.name) + '.' + QUOTENAME(q.name), t.name, \
             CAST(q.start_value AS nvarchar(40)), CAST(q.increment AS nvarchar(40)), \
             CAST(q.minimum_value AS nvarchar(40)), CAST(q.maximum_value AS nvarchar(40)), \
             CASE WHEN q.is_cycling = 1 THEN 'true' ELSE 'false' END, \
             CAST(q.current_value AS nvarchar(40)) \
             FROM sys.sequences q JOIN sys.schemas s ON s.schema_id = q.schema_id \
             JOIN sys.types t ON t.user_type_id = q.user_type_id \
             WHERE s.name = @P1 AND q.name = @P2",
            p,
        )?;
        let Some(s) = rows.first() else {
            return Ok(None);
        };
        let keys = [
            "",
            "type",
            "start",
            "increment",
            "min",
            "max",
            "cycle",
            "lastValue",
        ];
        let properties: TextRows = keys
            .iter()
            .enumerate()
            .skip(1)
            .filter_map(|(i, k)| opt(s, i).map(|v| vec![Some(k.to_string()), Some(v)]))
            .collect();
        r.push("properties", &["property", "value"], properties);
        let cycle = if at(s, 6) == "true" {
            " CYCLE"
        } else {
            " NO CYCLE"
        };
        Ok(Some(format!(
            "CREATE SEQUENCE {} AS {} START WITH {} INCREMENT BY {} MINVALUE {} MAXVALUE {}{cycle};\n",
            at(s, 0),
            at(s, 1),
            at(s, 2),
            at(s, 3),
            at(s, 4),
            at(s, 5)
        )))
    }
}

mod sqlite {
    use super::*;

    pub fn read(
        r: &mut Reader,
        schema: &str,
        name: &str,
        object: ObjectKind,
    ) -> AppResult<Option<String>> {
        // a schema cannot be bound: its name goes in quoted (as in `meta.rs`)
        let file = quote_always(schema, DbKind::Sqlite);
        let p = &[name, schema];
        r.section(
            "columns",
            &["name", "type", "nullable", "default", "key", "extra"],
            "SELECT name, type, CASE WHEN \"notnull\" = 0 THEN 'yes' ELSE 'no' END, dflt_value, \
             CASE WHEN pk > 0 THEN 'pk' ELSE '' END, \
             CASE hidden WHEN 2 THEN 'generated virtual' WHEN 3 THEN 'generated stored' ELSE '' END \
             FROM pragma_table_xinfo WHERE arg = ?1 AND schema = ?2 AND hidden <> 1 ORDER BY cid",
            p,
        )?;
        if object == ObjectKind::Table {
            r.section(
                "indexes",
                &["name", "columns", "unique", "primary"],
                "SELECT il.name, COALESCE((SELECT group_concat(COALESCE(ii.name, '(expression)'), ', ') \
                   FROM pragma_index_info ii WHERE ii.arg = il.name AND ii.schema = ?2), ''), \
                 CASE WHEN il.\"unique\" = 1 THEN 'yes' ELSE 'no' END, \
                 CASE WHEN il.origin = 'pk' THEN 'yes' ELSE 'no' END \
                 FROM pragma_index_list il WHERE il.arg = ?1 AND il.schema = ?2 ORDER BY 1",
                p,
            )?;
            r.section(
                "references",
                &["columns", "refSchema", "refName", "refColumns", "onUpdate", "onDelete"],
                "SELECT group_concat(\"from\", ', '), ?2, \"table\", \
                 group_concat(COALESCE(\"to\", ''), ', '), lower(min(on_update)), lower(min(on_delete)) \
                 FROM (SELECT * FROM pragma_foreign_key_list WHERE arg = ?1 AND schema = ?2 \
                   ORDER BY id, seq) GROUP BY id ORDER BY id",
                p,
            )?;
            r.section(
                "referencedBy",
                &["refSchema", "refName", "columns"],
                &format!(
                    "SELECT ?2, m.name, group_concat(f.\"from\", ', ') \
                     FROM {file}.sqlite_schema m, pragma_foreign_key_list(m.name, ?2) f \
                     WHERE m.type = 'table' AND lower(f.\"table\") = lower(?1) \
                     GROUP BY m.name, f.id ORDER BY 2"
                ),
                p,
            )?;
        }
        r.section(
            "triggers",
            &["name", "definition"],
            &format!(
                "SELECT name, sql FROM {file}.sqlite_schema WHERE type = 'trigger' AND tbl_name = ?1 \
                 ORDER BY 1"
            ),
            &[name],
        )?;
        // the statements as they were written: the table or view first, then its indexes and triggers
        let parts = r.rows(
            &format!(
                "SELECT sql FROM {file}.sqlite_schema \
                 WHERE (name = ?1 OR tbl_name = ?1) AND sql IS NOT NULL \
                 ORDER BY CASE WHEN name = ?1 AND type IN ('table', 'view') THEN 0 \
                   WHEN type = 'index' THEN 1 ELSE 2 END, name"
            ),
            &[name],
        )?;
        if parts.is_empty() {
            return Ok(None);
        }
        let statements: Vec<String> = parts
            .iter()
            .map(|row| format!("{};\n", at(row, 0).trim_end().trim_end_matches(';')))
            .collect();
        Ok(Some(statements.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;

    fn details_of(s: &mut sqlite::Lite, name: &str, kind: ObjectKind) -> ObjectDetails {
        details(s, DbKind::Sqlite, "main", name, kind, "", &|| false).unwrap()
    }

    fn section<'a>(d: &'a ObjectDetails, id: &str) -> &'a Section {
        d.sections
            .iter()
            .find(|s| s.id == id)
            .unwrap_or_else(|| panic!("no section {id}"))
    }

    fn cell(s: &Section, row: usize, column: &str) -> String {
        let i = s.columns.iter().position(|c| c == column).unwrap();
        at(&s.rows[row], i)
    }

    fn setup() -> sqlite::Lite {
        let mut s = sqlite::open(&sqlite::demo_profile()).unwrap();
        s.execute_batch_for_tests(
            "CREATE TABLE d_author (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE d_book (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL
               REFERENCES d_author (id) ON DELETE CASCADE, title TEXT DEFAULT 'x',
               shout TEXT GENERATED ALWAYS AS (upper(title)) VIRTUAL);
             CREATE UNIQUE INDEX d_book_by_title ON d_book (title);
             CREATE VIEW d_titles AS SELECT title FROM d_book;
             CREATE TRIGGER d_book_touch AFTER UPDATE ON d_book BEGIN SELECT 1; END;",
        );
        s
    }

    #[test]
    fn lists_what_a_table_is_made_of() {
        let mut s = setup();
        let d = details_of(&mut s, "d_book", ObjectKind::Table);
        let columns = section(&d, "columns");
        assert_eq!(columns.rows.len(), 4);
        assert_eq!(cell(columns, 0, "key"), "pk");
        assert_eq!(cell(columns, 1, "nullable"), "no");
        assert_eq!(cell(columns, 2, "default"), "'x'");
        assert_eq!(cell(columns, 3, "extra"), "generated virtual");
        let indexes = section(&d, "indexes");
        assert_eq!(cell(indexes, 0, "name"), "d_book_by_title");
        assert_eq!(cell(indexes, 0, "unique"), "yes");
        let references = section(&d, "references");
        assert_eq!(cell(references, 0, "refName"), "d_author");
        assert_eq!(cell(references, 0, "onDelete"), "cascade");
        assert_eq!(cell(section(&d, "triggers"), 0, "name"), "d_book_touch");
        // lists a database does not have are simply not there
        assert!(d.sections.iter().all(|s| s.id != "privileges"));
        assert!(d.notes.is_empty(), "{:?}", d.notes);
    }

    #[test]
    fn knows_who_refers_to_a_table() {
        let mut s = setup();
        let d = details_of(&mut s, "d_author", ObjectKind::Table);
        let by = section(&d, "referencedBy");
        assert_eq!(cell(by, 0, "refName"), "d_book");
        assert_eq!(cell(by, 0, "columns"), "author_id");
    }

    #[test]
    fn the_ddl_builds_the_same_structure_in_an_empty_database() {
        let mut s = setup();
        let mut ddl = String::new();
        for (name, kind) in [
            ("d_author", ObjectKind::Table),
            ("d_book", ObjectKind::Table),
            ("d_titles", ObjectKind::View),
        ] {
            ddl.push_str(&details_of(&mut s, name, kind).ddl.unwrap());
        }
        assert!(ddl.contains("CREATE UNIQUE INDEX d_book_by_title"));
        assert!(ddl.contains("CREATE TRIGGER d_book_touch"));
        let before: Vec<_> = ["d_author", "d_book", "d_titles"]
            .iter()
            .map(|n| details_of(&mut s, n, ObjectKind::Table))
            .collect();
        s.execute_batch_for_tests("DROP VIEW d_titles; DROP TABLE d_book; DROP TABLE d_author;");
        assert!(
            details_of(&mut s, "d_book", ObjectKind::Table)
                .ddl
                .is_none()
        );
        s.execute_batch_for_tests(&ddl);
        let after: Vec<_> = ["d_author", "d_book", "d_titles"]
            .iter()
            .map(|n| details_of(&mut s, n, ObjectKind::Table))
            .collect();
        assert_eq!(before, after);
    }

    #[test]
    fn an_object_that_is_not_there_has_no_ddl_and_says_so() {
        let mut s = setup();
        let d = details_of(&mut s, "nothing", ObjectKind::Table);
        assert!(d.sections.is_empty());
        assert_eq!(d.ddl, None);
        assert_eq!(d.notes, vec!["ddl".to_string()]);
        // a hostile name is data, never SQL
        let d = details_of(&mut s, "x'; DROP TABLE d_book; --", ObjectKind::Table);
        assert!(d.ddl.is_none());
        let still = details_of(&mut s, "d_book", ObjectKind::Table);
        assert_eq!(section(&still, "columns").rows.len(), 4);
    }

    #[test]
    fn refuses_names_that_are_too_long() {
        let mut s = setup();
        let long = "x".repeat(300);
        assert!(
            details(
                &mut s,
                DbKind::Sqlite,
                "main",
                &long,
                ObjectKind::Table,
                "",
                &|| false
            )
            .is_err()
        );
    }
}
