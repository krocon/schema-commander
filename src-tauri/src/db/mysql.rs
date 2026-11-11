//! MySQL and MariaDB over `sqlx-mysql` (prompt 003, after log-commander's prompt 019). Statements go over
//! the text protocol (`raw_sql`), so everything a user can type runs (`USE`, `SET`, several statements).

use super::value::{Cell, ColKind, Column, Outcome, RowSink, text, text_bytes};
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
use sqlx_mysql::{
    MySql, MySqlConnectOptions, MySqlConnection, MySqlRow, MySqlSslMode, MySqlTypeInfo,
    MySqlValueRef,
};
use std::time::Instant;

pub struct My {
    conn: Option<MySqlConnection>,
    /// To ask the server to cancel a statement: a second connection and the id of this one.
    options: MySqlConnectOptions,
    connection_id: Option<u64>,
    profile: Profile,
}

pub fn connect(
    profile: &Profile,
    secret: Option<&super::secrets::Secret>,
    stop: Stop,
) -> AppResult<My> {
    super::install_crypto();
    let mut options = MySqlConnectOptions::new()
        .host(profile.host.trim())
        .port(profile.port_or_default())
        .username(profile.user.trim())
        .charset("utf8mb4")
        .ssl_mode(match profile.tls {
            TlsMode::Verify => MySqlSslMode::VerifyIdentity,
            TlsMode::Off => MySqlSslMode::Disabled,
        });
    if !profile.database.trim().is_empty() {
        options = options.database(profile.database.trim());
    }
    if let Some(secret) = secret {
        options = options.password(secret.expose());
    }
    let conn = block(Some(super::CONNECT_TIMEOUT), stop, async {
        MySqlConnection::connect_with(&options)
            .await
            .map_err(|e| sqlx_error(profile, &e))
    })?;
    let mut my = My {
        conn: Some(conn),
        options,
        connection_id: None,
        profile: profile.clone(),
    };
    // without the id the statement can still be stopped: the connection is dropped then
    my.connection_id = my
        .query("SELECT CONNECTION_ID()", Limits::rows(1), stop)
        .ok()
        .and_then(|r| match r.rows.first().and_then(|row| row.first()) {
            Some(Cell::U64(id)) => Some(*id),
            Some(Cell::I64(id)) => u64::try_from(*id).ok(),
            _ => None,
        });
    Ok(my)
}

fn kind(type_name: &str) -> ColKind {
    match type_name {
        "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" | "TINYINT UNSIGNED"
        | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED" | "BIGINT UNSIGNED"
        | "YEAR" => ColKind::Int,
        "FLOAT" | "DOUBLE" => ColKind::Float,
        "DECIMAL" => ColKind::Decimal,
        "BOOLEAN" => ColKind::Bool,
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            ColKind::Text
        }
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BIT"
        | "GEOMETRY" => ColKind::Bytes,
        "DATETIME" => ColKind::Timestamp,
        "TIMESTAMP" => ColKind::TimestampTz,
        "DATE" => ColKind::Date,
        "TIME" => ColKind::Time,
        "JSON" => ColKind::Json,
        _ => ColKind::Other,
    }
}

fn column(name: &str, info: &MySqlTypeInfo) -> Column {
    let type_name = info.name().to_string();
    Column {
        name: name.to_string(),
        kind: kind(&type_name),
        type_name,
    }
}

fn decode<'r, T: sqlx_core::decode::Decode<'r, MySql>>(v: MySqlValueRef<'r>) -> Option<T> {
    T::decode(v).ok()
}

fn cell(row: &MySqlRow, i: usize, kind: ColKind, type_name: &str) -> Cell {
    let Ok(v) = row.try_get_raw(i) else {
        return Cell::Null;
    };
    if v.is_null() {
        return Cell::Null;
    }
    let decoded = match kind {
        ColKind::Int if type_name.ends_with("UNSIGNED") => decode::<u64>(v).map(Cell::U64),
        ColKind::Int if type_name == "YEAR" => decode::<u16>(v).map(|n| Cell::I64(n.into())),
        ColKind::Int => decode::<i64>(v).map(Cell::I64),
        ColKind::Float if type_name == "FLOAT" => decode::<f32>(v).map(|n| Cell::F64(n.into())),
        ColKind::Float => decode::<f64>(v).map(Cell::F64),
        ColKind::Decimal => decode::<&str>(v).map(|s| Cell::Decimal(s.to_string())),
        ColKind::Bool => decode::<bool>(v).map(Cell::Bool),
        ColKind::Text => decode::<&str>(v).map(|s| Cell::Text(text(s))),
        ColKind::Bytes => decode::<&[u8]>(v).map(|b| blob_or_text(b, type_name)),
        ColKind::Timestamp => decode::<chrono::NaiveDateTime>(v).map(Cell::Ts),
        // TIMESTAMP comes in the session's zone; shown as the server gives it, without a zone
        ColKind::TimestampTz => decode::<chrono::NaiveDateTime>(v).map(Cell::Ts),
        ColKind::Date => decode::<chrono::NaiveDate>(v).map(Cell::Date),
        ColKind::Time => decode::<chrono::NaiveTime>(v).map(Cell::Time),
        ColKind::Json => decode::<&[u8]>(v).map(|b| Cell::Json(text_bytes(b))),
        ColKind::Uuid | ColKind::Other => decode::<&str>(v).map(|s| Cell::Text(text(s))),
    };
    decoded.unwrap_or_else(|| Cell::Unreadable(type_name.to_string()))
}

/// The driver names every text column with a binary collation (`utf8mb4_bin`, and MariaDB's `JSON`, which is
/// such a `LONGTEXT`) a BLOB – it cannot tell them apart. So a value of the BLOB family that is readable
/// text is shown as text; real binary data that happens to be printable text reads as text too.
fn blob_or_text(b: &[u8], type_name: &str) -> Cell {
    if !type_name.ends_with("BLOB") {
        return Cell::bytes(b);
    }
    match std::str::from_utf8(b) {
        Ok(s)
            if !s
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) =>
        {
            Cell::Text(text(s))
        }
        _ => Cell::bytes(b),
    }
}

impl My {
    /// Asks the server to cancel what this connection runs, over a second connection (`KILL QUERY` ends the
    /// statement, not the session).
    async fn cancel(options: MySqlConnectOptions, connection_id: Option<u64>) {
        let Some(id) = connection_id else { return };
        if let Ok(mut side) = MySqlConnection::connect_with(&options).await {
            let _ = side
                .execute(AssertSqlSafe(format!("KILL QUERY {id}")))
                .await;
            let _ = side.close().await;
        }
    }

    /// After a statement was cut short: asks until the connection answers a statement of ours again. The
    /// first answers may still be the end of the old one.
    async fn settle(conn: &mut MySqlConnection) -> AppResult<()> {
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
        conn: &mut MySqlConnection,
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

impl My {
    async fn ask(
        conn: &mut MySqlConnection,
        sql: &str,
        params: &[&str],
        profile: &Profile,
    ) -> AppResult<super::TextRows> {
        let fail = |e: sqlx_core::error::Error| sqlx_error(profile, &e);
        let mut query = sqlx_core::query::query::<MySql>(AssertSqlSafe(sql.to_string()));
        for p in params {
            query = query.bind((*p).to_string());
        }
        let rows = query.fetch_all(&mut *conn).await.map_err(fail)?;
        rows.iter()
            .map(|row| {
                (0..row.len())
                    .map(|i| {
                        // the catalog reports text as VARCHAR, as BLOB or with a binary collation,
                        // depending on server and version: the bytes are text in every case
                        row.try_get_unchecked::<Option<Vec<u8>>, _>(i)
                            .map(|v| v.map(|b| String::from_utf8_lossy(&b).into_owned()))
                            .map_err(fail)
                    })
                    .collect()
            })
            .collect()
    }
}

impl Session for My {
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
        let cancel = Self::cancel(self.options.clone(), self.connection_id);
        let run = Self::run(conn, sql, sink, &profile);
        let (r, ended) = block_cancelling(limits.timeout, stop, run, cancel);
        if r.as_ref().is_ok_and(|o| o.truncated) {
            // Rows were left unread: end the statement on the server, so the connection is free at once.
            // Its „cancelled“ answer is still on the wire: it is read here, not by the next statement.
            let cancel = Self::cancel(self.options.clone(), self.connection_id);
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
            self.conn = None;
        }
        r
    }

    fn server_version(&mut self, stop: Stop) -> AppResult<String> {
        let r = self.query("SELECT VERSION()", Limits::rows(1), stop)?;
        Ok(match r.rows.first().and_then(|row| row.first()) {
            Some(Cell::Text(v)) if v.contains("MariaDB") => format!("MariaDB {v}"),
            Some(Cell::Text(v)) => format!("MySQL {v}"),
            _ => "MySQL".to_string(),
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
    fn a_blob_that_is_text_reads_as_text() {
        assert_eq!(
            blob_or_text("{\"a\": 1}".as_bytes(), "BLOB"),
            Cell::Text("{\"a\": 1}".into())
        );
        assert_eq!(
            blob_or_text("Zeile 1\nZeile 2 ä".as_bytes(), "LONGBLOB"),
            Cell::Text("Zeile 1\nZeile 2 ä".into())
        );
        assert_eq!(
            blob_or_text(&[0, 255, 16], "BLOB"),
            Cell::Bytes(3, vec![0, 255, 16])
        );
        assert_eq!(
            blob_or_text(b"abc\0", "BLOB"),
            Cell::Bytes(4, b"abc\0".to_vec())
        );
        // BINARY and VARBINARY are binary by declaration
        assert_eq!(
            blob_or_text(b"abc", "VARBINARY"),
            Cell::Bytes(3, b"abc".to_vec())
        );
    }

    #[test]
    fn maps_type_names_to_kinds() {
        assert_eq!(kind("BIGINT UNSIGNED"), ColKind::Int);
        assert_eq!(kind("DECIMAL"), ColKind::Decimal);
        assert_eq!(kind("LONGBLOB"), ColKind::Bytes);
        assert_eq!(kind("TIMESTAMP"), ColKind::TimestampTz);
        assert_eq!(kind("VECTOR"), ColKind::Other);
    }
}
