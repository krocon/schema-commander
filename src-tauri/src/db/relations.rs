//! The foreign keys of a table, as data (prompt 030): which of its columns point to which columns of
//! another table, and which tables point to it. Read from the system catalog through `Session::ask`, with
//! bound parameters; composite keys keep the order of their columns, references may cross schemas, and a
//! table may point to itself. What the user does with them (follow a row to its relatives) is built in
//! `filter.rs` – here are only names.

use super::meta::quote_always;
use super::{DbKind, Session, Stop, TextRows};
use crate::error::AppResult;
use serde::Serialize;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);

/// One foreign key: the columns of the table that has it, and the columns they point to, pair by pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relations {
    /// Keys of the table: it points to others (or to itself).
    pub outgoing: Vec<ForeignKey>,
    /// Keys of other tables (or of itself) that point to it.
    pub incoming: Vec<ForeignKey>,
}

fn at(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

/// Folds rows `name, schema, table, column, ref schema, ref table, ref column` – one per pair of columns,
/// in the order of the key – into keys. Rows of one key follow each other.
pub fn fold(rows: &TextRows) -> Vec<ForeignKey> {
    let mut out: Vec<ForeignKey> = Vec::new();
    for row in rows {
        let (name, schema, table) = (at(row, 0), at(row, 1), at(row, 2));
        let same = out
            .last()
            .is_some_and(|k| k.name == name && k.schema == schema && k.table == table);
        if !same {
            out.push(ForeignKey {
                name,
                schema,
                table,
                columns: Vec::new(),
                ref_schema: at(row, 4),
                ref_table: at(row, 5),
                ref_columns: Vec::new(),
            });
        }
        let key = out.last_mut().expect("just pushed");
        key.columns.push(at(row, 3));
        key.ref_columns.push(at(row, 6));
    }
    // a key without a name for every column pair is none one can follow
    out.retain(|k| {
        k.columns.iter().all(|c| !c.is_empty()) && k.ref_columns.iter().all(|c| !c.is_empty())
    });
    out
}

/// Sorts the keys read for a table into those it has and those that point to it (a key of the table to
/// itself is both).
fn split(keys: Vec<ForeignKey>, schema: &str, table: &str, fold_case: bool) -> Relations {
    let same = |a: &str, b: &str| {
        if fold_case {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let mut out = Relations::default();
    for key in keys {
        let has = same(&key.schema, schema) && same(&key.table, table);
        let target = same(&key.ref_schema, schema) && same(&key.ref_table, table);
        if has && target {
            out.incoming.push(key.clone());
        }
        if has {
            out.outgoing.push(key);
        } else if target {
            out.incoming.push(key);
        }
    }
    out
}

const PG: &str = "SELECT k.conname, cn.nspname, c.relname, a.attname, pn.nspname, p.relname, pa.attname \
     FROM pg_catalog.pg_constraint k \
     JOIN pg_catalog.pg_class c ON c.oid = k.conrelid \
     JOIN pg_catalog.pg_namespace cn ON cn.oid = c.relnamespace \
     JOIN pg_catalog.pg_class p ON p.oid = k.confrelid \
     JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace \
     CROSS JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY AS u(child, parent, n) \
     JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.child \
     JOIN pg_catalog.pg_attribute pa ON pa.attrelid = k.confrelid AND pa.attnum = u.parent \
     WHERE k.contype = 'f' \
       AND ((cn.nspname = $1 AND c.relname = $2) OR (pn.nspname = $1 AND p.relname = $2)) \
     ORDER BY cn.nspname, c.relname, k.conname, u.n";

const MYSQL: &str = "SELECT k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, \
       k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME \
     FROM information_schema.KEY_COLUMN_USAGE k \
     WHERE k.REFERENCED_TABLE_NAME IS NOT NULL \
       AND ((k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?) \
         OR (k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?)) \
     ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION";

/// A key points to a table of its own schema; its columns are lists, opened side by side.
const DUCKDB: &str = "SELECT k.constraint_name, k.schema_name, k.table_name, \
       unnest(k.constraint_column_names), k.schema_name, k.referenced_table, \
       unnest(k.referenced_column_names) \
     FROM duckdb_constraints() k \
     WHERE k.database_name = current_database() AND k.constraint_type = 'FOREIGN KEY' \
       AND k.schema_name = $1 AND (k.table_name = $2 OR k.referenced_table = $2) \
     ORDER BY k.schema_name, k.table_name, k.constraint_name";

const ORACLE: &str = "SELECT c.constraint_name, c.owner, c.table_name, cc.column_name, \
       r.owner, r.table_name, rc.column_name \
     FROM all_constraints c \
     JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name \
     JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name \
     JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name \
       AND rc.position = cc.position \
     WHERE c.constraint_type = 'R' \
       AND ((c.owner = :1 AND c.table_name = :2) OR (r.owner = :3 AND r.table_name = :4)) \
     ORDER BY c.owner, c.table_name, c.constraint_name, cc.position";

const MSSQL: &str = "SELECT f.name, cs.name, ct.name, cc.name, ps.name, pt.name, pc.name \
     FROM sys.foreign_keys f \
     JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id \
     JOIN sys.tables ct ON ct.object_id = f.parent_object_id \
     JOIN sys.schemas cs ON cs.schema_id = ct.schema_id \
     JOIN sys.tables pt ON pt.object_id = f.referenced_object_id \
     JOIN sys.schemas ps ON ps.schema_id = pt.schema_id \
     JOIN sys.columns cc ON cc.object_id = fc.parent_object_id AND cc.column_id = fc.parent_column_id \
     JOIN sys.columns pc ON pc.object_id = fc.referenced_object_id \
       AND pc.column_id = fc.referenced_column_id \
     WHERE (cs.name = @P1 AND ct.name = @P2) OR (ps.name = @P1 AND pt.name = @P2) \
     ORDER BY cs.name, ct.name, f.name, fc.constraint_column_id";

/// SQLite names no key and may leave out the target columns (they are the primary key then).
fn sqlite(
    s: &mut dyn Session,
    schema: &str,
    table: &str,
    stop: Stop,
) -> AppResult<Vec<ForeignKey>> {
    let file = quote_always(schema, DbKind::Sqlite);
    let p = &[table, schema];
    let mut rows = s.ask(
        "SELECT 'fk' || id, ?2, ?1, \"from\", ?2, \"table\", COALESCE(\"to\", '') \
         FROM pragma_foreign_key_list WHERE arg = ?1 AND schema = ?2 ORDER BY id, seq",
        p,
        Some(TIMEOUT),
        stop,
    )?;
    rows.extend(s.ask(
        &format!(
            "SELECT 'fk' || f.id, ?2, m.name, f.\"from\", ?2, f.\"table\", COALESCE(f.\"to\", '') \
             FROM {file}.sqlite_schema m, pragma_foreign_key_list(m.name, ?2) f \
             WHERE m.type = 'table' AND lower(f.\"table\") = lower(?1) AND lower(m.name) <> lower(?1) \
             ORDER BY m.name, f.id, f.seq"
        ),
        p,
        Some(TIMEOUT),
        stop,
    )?);
    // a key without target columns points to the primary key of its target, column by column
    let mut keys_of: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let mut place: std::collections::HashMap<(String, String, String), usize> =
        std::collections::HashMap::new();
    for row in &mut rows {
        let n = place
            .entry((at(row, 0), at(row, 1), at(row, 2)))
            .or_insert(0);
        let nth = *n;
        *n += 1;
        if !at(row, 6).is_empty() {
            continue;
        }
        let target = at(row, 5);
        if !keys_of.contains_key(&target) {
            let pk = s.ask(
                "SELECT name FROM pragma_table_info WHERE arg = ?1 AND schema = ?2 AND pk > 0 \
                 ORDER BY pk",
                &[&target, schema],
                Some(TIMEOUT),
                stop,
            )?;
            keys_of.insert(target.clone(), pk.iter().map(|r| at(r, 0)).collect());
        }
        if let Some(name) = keys_of[&target].get(nth) {
            row[6] = Some(name.clone());
        }
    }
    Ok(fold(&rows))
}

/// The foreign keys a table has and those that point to it.
pub fn relations(
    s: &mut dyn Session,
    kind: DbKind,
    schema: &str,
    table: &str,
    stop: Stop,
) -> AppResult<Relations> {
    let keys = match kind {
        DbKind::Postgres => fold(&s.ask(PG, &[schema, table], Some(TIMEOUT), stop)?),
        DbKind::Mysql => {
            fold(&s.ask(MYSQL, &[schema, table, schema, table], Some(TIMEOUT), stop)?)
        }
        DbKind::Sqlserver => fold(&s.ask(MSSQL, &[schema, table], Some(TIMEOUT), stop)?),
        DbKind::Sqlite | DbKind::Libsql | DbKind::D1 => sqlite(s, schema, table, stop)?,
        DbKind::Duckdb => fold(&s.ask(DUCKDB, &[schema, table], Some(TIMEOUT), stop)?),
        // ClickHouse has no foreign keys
        DbKind::Clickhouse => Vec::new(),
        // the catalog of Trino names no keys
        DbKind::Trino => Vec::new(),
        DbKind::Oracle => {
            fold(&s.ask(ORACLE, &[schema, table, schema, table], Some(TIMEOUT), stop)?)
        }
    };
    // SQLite compares names of tables without case, and so do MySQL on some systems and SQL Server by
    // collation: the catalog was asked with the name as given, so what came back belongs to the table
    Ok(split(keys, schema, table, kind != DbKind::Postgres))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;

    fn row(cells: [&str; 7]) -> Vec<Option<String>> {
        cells.iter().map(|c| Some((*c).to_string())).collect()
    }

    #[test]
    fn folds_column_pairs_into_keys_in_their_order() {
        let keys = fold(&vec![
            row([
                "fk_line", "shop", "lines", "order_id", "shop", "orders", "id",
            ]),
            row([
                "fk_stock",
                "shop",
                "lines",
                "warehouse",
                "store",
                "stock",
                "warehouse",
            ]),
            row([
                "fk_stock", "shop", "lines", "item", "store", "stock", "item",
            ]),
            // the same name in another table is another key
            row([
                "fk_line", "shop", "returns", "order_id", "shop", "orders", "id",
            ]),
            row(["broken", "shop", "x", "a", "shop", "y", ""]),
        ]);
        assert_eq!(keys.len(), 3);
        assert_eq!(keys[1].columns, ["warehouse", "item"]);
        assert_eq!(keys[1].ref_columns, ["warehouse", "item"]);
        assert_eq!(
            (keys[1].ref_schema.as_str(), keys[1].ref_table.as_str()),
            ("store", "stock")
        );
        assert_eq!(keys[2].table, "returns");
    }

    #[test]
    fn sorts_keys_into_those_of_the_table_and_those_that_point_to_it() {
        let keys = fold(&vec![
            row(["boss", "hr", "people", "boss_id", "hr", "people", "id"]),
            row(["team", "hr", "people", "team_id", "hr", "teams", "id"]),
            row(["lead", "hr", "teams", "lead_id", "hr", "people", "id"]),
        ]);
        let r = split(keys, "hr", "people", false);
        let names = |keys: &[ForeignKey]| keys.iter().map(|k| k.name.clone()).collect::<Vec<_>>();
        // a table that points to itself: the key is one it has, and one that points to it
        assert_eq!(names(&r.outgoing), ["boss", "team"]);
        assert_eq!(names(&r.incoming), ["boss", "lead"]);
    }

    #[test]
    fn reads_the_keys_of_sqlite_composite_implicit_and_to_itself() {
        let mut s = sqlite::open(&sqlite::demo_profile()).unwrap();
        s.execute_batch_for_tests(
            "CREATE TABLE fk_country (code TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE fk_stock (warehouse INTEGER, item INTEGER, qty INTEGER,
               PRIMARY KEY (warehouse, item));
             CREATE TABLE fk_person (id INTEGER PRIMARY KEY, boss_id INTEGER REFERENCES fk_person,
               country TEXT REFERENCES fk_country (code));
             CREATE TABLE fk_line (id INTEGER PRIMARY KEY, w INTEGER, i INTEGER,
               buyer INTEGER REFERENCES fk_person (id),
               FOREIGN KEY (w, i) REFERENCES fk_stock);",
        );
        let stop = || false;
        let person = relations(&mut s, DbKind::Sqlite, "main", "fk_person", &stop).unwrap();
        let line = |k: &ForeignKey| {
            format!(
                "{}({}) -> {}({})",
                k.table,
                k.columns.join(","),
                k.ref_table,
                k.ref_columns.join(",")
            )
        };
        let mut outgoing: Vec<String> = person.outgoing.iter().map(line).collect();
        outgoing.sort();
        // the key to itself names no target column: it is the primary key
        assert_eq!(
            outgoing,
            [
                "fk_person(boss_id) -> fk_person(id)",
                "fk_person(country) -> fk_country(code)"
            ]
        );
        let mut incoming: Vec<String> = person.incoming.iter().map(line).collect();
        incoming.sort();
        assert_eq!(
            incoming,
            [
                "fk_line(buyer) -> fk_person(id)",
                "fk_person(boss_id) -> fk_person(id)"
            ]
        );
        // a composite key without target columns: the primary key in its order
        let stock = relations(&mut s, DbKind::Sqlite, "main", "fk_stock", &stop).unwrap();
        assert!(stock.outgoing.is_empty());
        assert_eq!(
            stock.incoming.iter().map(line).collect::<Vec<_>>(),
            ["fk_line(w,i) -> fk_stock(warehouse,item)"]
        );
        let none = relations(&mut s, DbKind::Sqlite, "main", "no_such_table", &stop).unwrap();
        assert_eq!(none, Relations::default());
    }
}
