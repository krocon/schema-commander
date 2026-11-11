//! PostgreSQL over `sqlx-postgres` (prompt 003, after log-commander's prompt 019).
//!
//! Statements go over the simple query protocol (`raw_sql`): everything a user can type runs, including
//! what the extended protocol refuses. A statement that returns no row does not say its columns there; for
//! those a `prepare` (describe only, nothing runs) fetches the header.

use super::value::{Cell, ColKind, Column, Outcome, RowSink, pg_numeric, text, text_bytes};
use super::{
    Ended, Limits, Profile, Session, Stop, TlsMode, block, block_cancelling, closed,
    keeps_connection, sqlx_error,
};
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
    /// To ask the server to cancel a statement: a second connection and the id of this one's backend.
    options: PgConnectOptions,
    backend: Option<i32>,
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
            TlsMode::Off => PgSslMode::Disable,
            TlsMode::Prefer => PgSslMode::Prefer,
            TlsMode::Require => PgSslMode::Require,
            TlsMode::VerifyCa => PgSslMode::VerifyCa,
            TlsMode::Verify => PgSslMode::VerifyFull,
        });
    if !profile.ca_file.trim().is_empty() {
        options = options.ssl_root_cert(profile.ca_file.trim());
    }
    if !profile.client_cert.trim().is_empty() {
        options = options
            .ssl_client_cert(profile.client_cert.trim())
            .ssl_client_key(profile.client_key.trim());
    }
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
    let mut pg = Pg {
        conn: Some(conn),
        options,
        backend: None,
        profile: profile.clone(),
    };
    // without the id the statement can still be stopped: the connection is dropped then
    pg.backend = pg
        .query("SELECT pg_backend_pid()", Limits::rows(1), stop)
        .ok()
        .and_then(|r| match r.rows.first().and_then(|row| row.first()) {
            Some(Cell::I64(pid)) => i32::try_from(*pid).ok(),
            _ => None,
        });
    Ok(pg)
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
    /// Asks the server to cancel what this connection runs, over a second connection.
    async fn cancel(options: PgConnectOptions, backend: Option<i32>) {
        let Some(pid) = backend else { return };
        if let Ok(mut side) = PgConnection::connect_with(&options).await {
            let _ = side
                .execute(AssertSqlSafe(format!("SELECT pg_cancel_backend({pid})")))
                .await;
            let _ = side.close().await;
        }
    }

    /// After a statement was cut short: asks until the connection answers a statement of ours again. The
    /// first answers may still be the end of the old one.
    async fn settle(conn: &mut PgConnection) -> AppResult<()> {
        let mut last = None;
        for _ in 0..5 {
            match conn.execute("SELECT 1").await {
                Ok(_) => return Ok(()),
                Err(e) => last = Some(e),
            }
        }
        Err(crate::error::AppError::new(
            crate::error::ErrorCode::ConnectionFailed,
            last.map(|e| e.to_string()).unwrap_or_default(),
        ))
    }

    async fn run(
        conn: &mut PgConnection,
        sql: &str,
        sink: &mut dyn RowSink,
        profile: &Profile,
    ) -> AppResult<Outcome> {
        let fail = |e: sqlx_core::error::Error| sqlx_error(profile, &e);
        let started = Instant::now();
        let mut columns: Vec<Column> = Vec::new();
        let mut rows: u64 = 0;
        let mut affected: u64 = 0;
        let mut truncated = false;
        {
            let mut stream =
                sqlx_core::raw_sql::raw_sql(AssertSqlSafe(sql.to_string())).fetch_many(&mut *conn);
            while let Some(item) = stream.next().await {
                match item.map_err(fail)? {
                    Either::Left(done) => affected += done.rows_affected(),
                    Either::Right(row) => {
                        if columns.is_empty() {
                            columns = row
                                .columns()
                                .iter()
                                .map(|c| column(c.name(), c.type_info()))
                                .collect();
                            sink.start(&columns);
                        }
                        let cells: Vec<Cell> = columns
                            .iter()
                            .enumerate()
                            .map(|(i, c)| cell(&row, i, c.kind, &c.type_name))
                            .collect();
                        rows += 1;
                        if !sink.row(cells) {
                            // no more rows are wanted: the rest stays unread, `execute` cancels the
                            // statement on the server
                            truncated = true;
                            break;
                        }
                    }
                }
            }
        }
        if rows == 0 {
            // The header of a result without rows: describe only, nothing runs. A statement that cannot be
            // prepared (several statements, utility commands) simply has none.
            let describe = SqlSafeStr::into_sql_str(AssertSqlSafe(sql.to_string()));
            if let Ok(statement) = conn.prepare(describe).await {
                columns = statement
                    .columns()
                    .iter()
                    .map(|c| column(c.name(), c.type_info()))
                    .collect();
                if !columns.is_empty() {
                    sink.start(&columns);
                }
            }
        }
        let has_result = !columns.is_empty();
        Ok(Outcome {
            columns,
            rows,
            truncated,
            rows_affected: (!has_result).then_some(affected),
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }
}

impl Pg {
    async fn ask(
        conn: &mut PgConnection,
        sql: &str,
        params: &[&str],
        profile: &Profile,
    ) -> AppResult<super::TextRows> {
        let fail = |e: sqlx_core::error::Error| sqlx_error(profile, &e);
        let mut query = sqlx_core::query::query::<Postgres>(AssertSqlSafe(sql.to_string()));
        for p in params {
            query = query.bind((*p).to_string());
        }
        let rows = query.fetch_all(&mut *conn).await.map_err(fail)?;
        rows.iter()
            .map(|row| {
                (0..row.len())
                    .map(|i| row.try_get::<Option<String>, _>(i).map_err(fail))
                    .collect()
            })
            .collect()
    }
}

impl Session for Pg {
    fn ask(
        &mut self,
        sql: &str,
        params: &[&str],
        timeout: Option<std::time::Duration>,
        stop: Stop,
    ) -> AppResult<super::TextRows> {
        let profile = self.profile.clone();
        let conn = self.conn.as_mut().ok_or_else(closed)?;
        let r = block(timeout, stop, Self::ask(conn, sql, params, &profile));
        if r.as_ref().is_err_and(|e| !super::keeps_after_ask(e.code)) {
            self.conn = None;
        }
        r
    }

    fn execute(
        &mut self,
        sql: &str,
        limits: Limits,
        sink: &mut dyn RowSink,
        stop: Stop,
    ) -> AppResult<Outcome> {
        let profile = self.profile.clone();
        let conn = self.conn.as_mut().ok_or_else(closed)?;
        let cancel = Self::cancel(self.options.clone(), self.backend);
        let run = Self::run(conn, sql, sink, &profile);
        let (r, ended) = block_cancelling(limits.timeout, stop, run, cancel);
        if r.as_ref().is_ok_and(|o| o.truncated) {
            // Rows were left unread: end the statement on the server, so the connection is free at once.
            // Its „cancelled“ answer is still on the wire: it is read here, not by the next statement.
            let cancel = Self::cancel(self.options.clone(), self.backend);
            let settled = match self.conn.as_mut() {
                Some(conn) => block(Some(super::CANCEL_GRACE * 2), &|| false, async {
                    cancel.await;
                    Self::settle(conn).await
                }),
                None => Ok(()),
            };
            if settled.is_err() {
                self.conn = None;
            }
        }
        if ended == Ended::Abandoned || r.as_ref().is_err_and(|e| !keeps_connection(e.code)) {
            // broken, or still running after the cancel request: the connection is in an unknown state
            self.conn = None;
        }
        r
    }

    fn transaction_state(&mut self, stop: Stop) -> super::TxState {
        use super::TxState;
        // Inside a transaction block `now()` is the start of the transaction, outside it the start of
        // this very statement. Over the simple protocol: with parse and bind as messages of their own
        // the two differ always. A failed block refuses every statement (25P02).
        let limits = Limits {
            max_rows: 1,
            timeout: Some(std::time::Duration::from_secs(5)),
        };
        match self.query(
            "SELECT (now() <> statement_timestamp())::text",
            limits,
            stop,
        ) {
            Ok(r) => match r.rows.first().and_then(|row| row.first()) {
                Some(Cell::Text(t)) if t == "true" => TxState::Active,
                Some(Cell::Text(t)) if t == "false" => TxState::Idle,
                _ => TxState::Unknown,
            },
            Err(e) if e.message.contains("25P02") || e.message.contains("aborted") => {
                TxState::Failed
            }
            Err(_) => TxState::Unknown,
        }
    }

    fn server_version(&mut self, stop: Stop) -> AppResult<String> {
        let r = self.query("SELECT version()", Limits::rows(1), stop)?;
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
