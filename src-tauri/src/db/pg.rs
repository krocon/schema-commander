//! PostgreSQL over `sqlx-postgres` (prompt 003, after log-commander's prompt 019).
//!
//! Statements go over the simple query protocol (`raw_sql`): everything a user can type runs, including
//! what the extended protocol refuses. A statement that returns no row does not say its columns there; for
//! those a `prepare` (describe only, nothing runs) fetches the header.

use super::value::{Budget, Cell, ColKind, Column, QueryResult, pg_numeric, text, text_bytes};
use super::{Profile, Session, Stop, TlsMode, block, closed, keeps_connection, sqlx_error};
use crate::error::AppResult;
use futures_util::StreamExt;
use sqlx_core::Either;
use sqlx_core::column::Column as _;
use sqlx_core::connection::Connection;
use sqlx_core::executor::Executor;
use sqlx_core::row::Row as _;
use sqlx_core::sql_str::{AssertSqlSafe, SqlSafeStr};
use sqlx_core::statement::Statement;
use sqlx_core::type_info::TypeInfo;
use sqlx_core::value::ValueRef;
use sqlx_postgres::{
    PgConnectOptions, PgConnection, PgRow, PgSslMode, PgTypeInfo, PgValueFormat, PgValueRef,
    Postgres,
};
use std::time::Instant;

pub struct Pg {
    conn: Option<PgConnection>,
    /// For the error texts (never holds the password).
    profile: Profile,
}

pub fn connect(
    profile: &Profile,
    secret: Option<&super::secrets::Secret>,
    stop: Stop,
) -> AppResult<Pg> {
    super::install_crypto();
    let mut options = PgConnectOptions::new_without_pgpass()
        .host(profile.host.trim())
        .port(profile.port_or_default())
        .username(profile.user.trim())
        .application_name("Schema Commander")
        .ssl_mode(match profile.tls {
            TlsMode::Verify => PgSslMode::VerifyFull,
            TlsMode::Off => PgSslMode::Disable,
        });
    if !profile.database.trim().is_empty() {
        options = options.database(profile.database.trim());
    }
    if let Some(secret) = secret {
        options = options.password(secret.expose());
    }
    let conn = block(Some(super::CONNECT_TIMEOUT), stop, async {
        PgConnection::connect_with(&options)
            .await
            .map_err(|e| sqlx_error(profile, &e))
    })?;
    Ok(Pg {
        conn: Some(conn),
        profile: profile.clone(),
    })
}

fn kind(type_name: &str) -> ColKind {
    match type_name {
        "INT2" | "INT4" | "INT8" | "OID" => ColKind::Int,
        "FLOAT4" | "FLOAT8" => ColKind::Float,
        "NUMERIC" => ColKind::Decimal,
        "BOOL" => ColKind::Bool,
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "\"CHAR\"" | "CHAR" | "CITEXT" | "citext"
        | "XML" => ColKind::Text,
        "BYTEA" => ColKind::Bytes,
        "TIMESTAMP" => ColKind::Timestamp,
        "TIMESTAMPTZ" => ColKind::TimestampTz,
        "DATE" => ColKind::Date,
        "TIME" => ColKind::Time,
        "JSON" | "JSONB" => ColKind::Json,
        "UUID" => ColKind::Uuid,
        _ => ColKind::Other,
    }
}

fn column(name: &str, info: &PgTypeInfo) -> Column {
    let type_name = info.name().to_string();
    Column {
        name: name.to_string(),
        kind: kind(&type_name),
        type_name,
    }
}

fn decode<'r, T: sqlx_core::decode::Decode<'r, Postgres>>(v: PgValueRef<'r>) -> Option<T> {
    T::decode(v).ok()
}

/// `\x0102…` (the text form of bytea) as bytes.
fn hex_bytes(text: &str) -> Option<Vec<u8>> {
    let hex = text.strip_prefix("\\x")?;
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

fn cell(row: &PgRow, i: usize, kind: ColKind, type_name: &str) -> Cell {
    let Ok(v) = row.try_get_raw(i) else {
        return Cell::Null;
    };
    if v.is_null() {
        return Cell::Null;
    }
    let other = || Cell::Unreadable(type_name.to_string());
    let binary = v.format() == PgValueFormat::Binary;
    let decoded = match kind {
        ColKind::Int => match type_name {
            "INT2" => decode::<i16>(v).map(|n| Cell::I64(n.into())),
            "INT4" => decode::<i32>(v).map(|n| Cell::I64(n.into())),
            "OID" => decode::<sqlx_postgres::types::Oid>(v).map(|n| Cell::I64(n.0.into())),
            _ => decode::<i64>(v).map(Cell::I64),
        },
        ColKind::Float => match type_name {
            "FLOAT4" => decode::<f32>(v).map(|n| Cell::F64(n.into())),
            _ => decode::<f64>(v).map(Cell::F64),
        },
        ColKind::Decimal if binary => v.as_bytes().ok().and_then(pg_numeric).map(Cell::Decimal),
        ColKind::Decimal => v.as_str().ok().map(|s| Cell::Decimal(s.to_string())),
        ColKind::Bool => decode::<bool>(v).map(Cell::Bool),
        ColKind::Text => v.as_bytes().ok().map(|b| Cell::Text(text_bytes(b))),
        ColKind::Bytes if binary => v.as_bytes().ok().map(Cell::bytes),
        ColKind::Bytes => v.as_str().ok().and_then(hex_bytes).map(|b| Cell::bytes(&b)),
        ColKind::Timestamp => decode::<chrono::NaiveDateTime>(v).map(Cell::Ts),
        ColKind::TimestampTz => {
            decode::<chrono::DateTime<chrono::Utc>>(v).map(|t| Cell::TsTz(t.fixed_offset()))
        }
        ColKind::Date => decode::<chrono::NaiveDate>(v).map(Cell::Date),
        ColKind::Time => decode::<chrono::NaiveTime>(v).map(Cell::Time),
        ColKind::Json => v.as_bytes().ok().map(|b| {
            // JSONB in binary: a version byte (1) before the text.
            let b = if type_name == "JSONB" && binary {
                b.get(1..).unwrap_or_default()
            } else {
                b
            };
            Cell::Json(text_bytes(b))
        }),
        ColKind::Uuid if binary => v.as_bytes().ok().and_then(|b| {
            let b: [u8; 16] = b.try_into().ok()?;
            let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
            Some(Cell::Uuid(format!(
                "{}-{}-{}-{}-{}",
                &h[..8],
                &h[8..12],
                &h[12..16],
                &h[16..20],
                &h[20..]
            )))
        }),
        ColKind::Uuid => v.as_str().ok().map(|s| Cell::Uuid(s.to_string())),
        // Enums, domains, arrays, intervals … arrive as text in the simple protocol.
        ColKind::Other => match v.as_bytes().ok().map(std::str::from_utf8) {
            Some(Ok(s)) if !binary => Some(Cell::Text(text(s))),
            Some(Ok(s)) if !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t') => {
                Some(Cell::Text(text(s)))
            }
            _ => None,
        },
    };
    decoded.unwrap_or_else(other)
}

impl Pg {
    async fn run(
        conn: &mut PgConnection,
        sql: &str,
        max_rows: usize,
        profile: &Profile,
    ) -> AppResult<QueryResult> {
        let fail = |e: sqlx_core::error::Error| sqlx_error(profile, &e);
        let started = Instant::now();
        let mut columns: Vec<Column> = Vec::new();
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        let mut affected: u64 = 0;
        let mut truncated = false;
        let mut budget = Budget::default();
        {
            let mut stream =
                sqlx_core::raw_sql::raw_sql(AssertSqlSafe(sql.to_string())).fetch_many(&mut *conn);
            while let Some(item) = stream.next().await {
                match item.map_err(fail)? {
                    Either::Left(done) => affected += done.rows_affected(),
                    Either::Right(row) => {
                        // the rest is read and dropped: the connection must see the end of the result
                        if truncated {
                            continue;
                        }
                        if columns.is_empty() {
                            columns = row
                                .columns()
                                .iter()
                                .map(|c| column(c.name(), c.type_info()))
                                .collect();
                        }
                        let cells: Vec<Cell> = columns
                            .iter()
                            .enumerate()
                            .map(|(i, c)| cell(&row, i, c.kind, &c.type_name))
                            .collect();
                        let room = budget.add(&cells);
                        rows.push(cells);
                        truncated = rows.len() >= max_rows || !room;
                    }
                }
            }
        }
        if rows.is_empty() {
            // The header of a result without rows: describe only, nothing runs. A statement that cannot be
            // prepared (several statements, utility commands) simply has none.
            let describe = SqlSafeStr::into_sql_str(AssertSqlSafe(sql.to_string()));
            if let Ok(statement) = conn.prepare(describe).await {
                columns = statement
                    .columns()
                    .iter()
                    .map(|c| column(c.name(), c.type_info()))
                    .collect();
            }
        }
        let has_result = !columns.is_empty();
        Ok(QueryResult {
            columns,
            rows,
            // one row too many was read to know; the cut is at the limit
            truncated,
            rows_affected: (!has_result).then_some(affected),
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }
}

impl Session for Pg {
    fn execute(&mut self, sql: &str, max_rows: usize, stop: Stop) -> AppResult<QueryResult> {
        let profile = self.profile.clone();
        let conn = self.conn.as_mut().ok_or_else(closed)?;
        let r = block(None, stop, Self::run(conn, sql, max_rows, &profile));
        if r.as_ref().is_err_and(|e| !keeps_connection(e.code)) {
            // cancelled or broken in the middle: the connection is in an unknown state
            self.conn = None;
        }
        r
    }

    fn server_version(&mut self, stop: Stop) -> AppResult<String> {
        let r = self.execute("SELECT version()", 1, stop)?;
        Ok(match r.rows.first().and_then(|row| row.first()) {
            Some(Cell::Text(v)) => v.clone(),
            _ => "PostgreSQL".to_string(),
        })
    }

    fn is_open(&self) -> bool {
        self.conn.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_text_form_of_bytea() {
        assert_eq!(hex_bytes("\\x00ff10"), Some(vec![0, 255, 16]));
        assert_eq!(hex_bytes("\\x"), Some(vec![]));
        assert_eq!(hex_bytes("00ff"), None);
        assert_eq!(hex_bytes("\\x0"), None);
        assert_eq!(hex_bytes("\\xzz"), None);
    }

    #[test]
    fn maps_type_names_to_kinds() {
        assert_eq!(kind("INT8"), ColKind::Int);
        assert_eq!(kind("NUMERIC"), ColKind::Decimal);
        assert_eq!(kind("TIMESTAMPTZ"), ColKind::TimestampTz);
        assert_eq!(kind("JSONB"), ColKind::Json);
        assert_eq!(kind("INTERVAL"), ColKind::Other);
    }
}
