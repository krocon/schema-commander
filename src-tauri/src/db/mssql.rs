//! SQL Server over `tiberius` (prompt 003, after log-commander's prompt 019). A statement runs as a batch
//! (`simple_query`); the first result set with columns is the result.

use super::value::{Budget, Cell, ColKind, Column, QueryResult, text};
use super::{Profile, Session, Stop, TlsMode, block, clean, closed, keeps_connection};
use crate::error::{AppError, AppResult, ErrorCode};
use futures_util::StreamExt;
use std::time::Instant;
use tiberius::{AuthMethod, Client, ColumnData, ColumnType, Config, EncryptionLevel, FromSql};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type Conn = Client<Compat<TcpStream>>;

/// The column the row count travels in (see [`Ms::run`]).
const ROWCOUNT: &str = "__sc_rowcount";

pub struct Ms {
    conn: Option<Conn>,
    profile: Profile,
}

/// Errors of tiberius with a code the frontend can act on; never holds the password.
pub fn ms_error(profile: &Profile, e: &tiberius::error::Error) -> AppError {
    use tiberius::error::Error as E;
    let on = profile.where_label();
    match e {
        E::Server(t) if matches!(t.code(), 18456 | 18452 | 18486 | 18487 | 18488) => AppError::new(
            ErrorCode::AuthFailed,
            format!("login failed ({})", t.code()),
        ),
        E::Server(t) if t.code() == 4060 => AppError::new(ErrorCode::NotFound, clean(t.message())),
        E::Server(t) if matches!(t.code(), 229 | 230 | 262 | 297 | 300 | 916) => {
            AppError::new(ErrorCode::PermissionDenied, clean(t.message()))
        }
        E::Server(t) => AppError::new(
            ErrorCode::InvalidQuery,
            format!("{} ({})", clean(t.message()), t.code()),
        ),
        E::Tls(m) => AppError::new(ErrorCode::TlsFailed, format!("{on}: {}", clean(m))),
        E::Io { message, .. } => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: {}", clean(message)),
        ),
        other => AppError::new(
            ErrorCode::ConnectionFailed,
            format!("{on}: {}", clean(&other.to_string())),
        ),
    }
}

pub fn connect(
    profile: &Profile,
    secret: Option<&super::secrets::Secret>,
    stop: Stop,
) -> AppResult<Ms> {
    super::install_crypto();
    let mut c = Config::new();
    c.host(profile.host.trim());
    c.port(profile.port_or_default());
    if !profile.database.trim().is_empty() {
        c.database(profile.database.trim());
    }
    c.application_name("Schema Commander");
    c.authentication(AuthMethod::sql_server(
        profile.user.trim(),
        secret
            .map(super::secrets::Secret::expose)
            .unwrap_or_default(),
    ));
    match profile.tls {
        TlsMode::Verify => c.encryption(EncryptionLevel::Required),
        // Only the login is encrypted then (the server may still insist on more); its certificate is
        // not checked – this mode is for servers on this machine.
        TlsMode::Off => {
            c.encryption(EncryptionLevel::Off);
            c.trust_cert();
        }
    }
    let conn = block(Some(super::CONNECT_TIMEOUT), stop, async {
        let tcp = TcpStream::connect(c.get_addr()).await.map_err(|e| {
            AppError::new(
                ErrorCode::ConnectionFailed,
                format!("{}: {e}", profile.where_label()),
            )
        })?;
        tcp.set_nodelay(true).ok();
        Client::connect(c, tcp.compat_write())
            .await
            .map_err(|e| ms_error(profile, &e))
    })?;
    Ok(Ms {
        conn: Some(conn),
        profile: profile.clone(),
    })
}

fn kind(t: ColumnType) -> ColKind {
    use ColumnType as T;
    match t {
        T::Int1 | T::Int2 | T::Int4 | T::Int8 | T::Intn => ColKind::Int,
        T::Float4 | T::Float8 | T::Floatn => ColKind::Float,
        T::Money | T::Money4 | T::Decimaln | T::Numericn => ColKind::Decimal,
        T::Bit | T::Bitn => ColKind::Bool,
        T::BigVarChar | T::BigChar | T::NVarchar | T::NChar | T::Text | T::NText | T::Xml => {
            ColKind::Text
        }
        T::BigVarBin | T::BigBinary | T::Image => ColKind::Bytes,
        T::Datetime | T::Datetime4 | T::Datetimen | T::Datetime2 => ColKind::Timestamp,
        T::DatetimeOffsetn => ColKind::TimestampTz,
        T::Daten => ColKind::Date,
        T::Timen => ColKind::Time,
        T::Guid => ColKind::Uuid,
        _ => ColKind::Other,
    }
}

fn columns(cols: &[tiberius::Column]) -> Vec<Column> {
    cols.iter()
        .map(|c| Column {
            name: c.name().to_string(),
            type_name: format!("{:?}", c.column_type()),
            kind: kind(c.column_type()),
        })
        .collect()
}

fn cell(data: &ColumnData<'static>, type_name: &str) -> Cell {
    let other = || Cell::Unreadable(type_name.to_string());
    match data {
        ColumnData::U8(v) => v.map_or(Cell::Null, |n| Cell::I64(n.into())),
        ColumnData::I16(v) => v.map_or(Cell::Null, |n| Cell::I64(n.into())),
        ColumnData::I32(v) => v.map_or(Cell::Null, |n| Cell::I64(n.into())),
        ColumnData::I64(v) => v.map_or(Cell::Null, Cell::I64),
        ColumnData::F32(v) => v.map_or(Cell::Null, |n| Cell::F64(n.into())),
        ColumnData::F64(v) => v.map_or(Cell::Null, Cell::F64),
        ColumnData::Bit(v) => v.map_or(Cell::Null, Cell::Bool),
        ColumnData::String(v) => v.as_ref().map_or(Cell::Null, |s| Cell::Text(text(s))),
        ColumnData::Guid(v) => v.map_or(Cell::Null, |g| Cell::Uuid(g.to_string())),
        ColumnData::Binary(v) => v.as_ref().map_or(Cell::Null, |b| Cell::bytes(b)),
        ColumnData::Numeric(v) => v.map_or(Cell::Null, |n| Cell::Decimal(n.to_string())),
        ColumnData::Xml(v) => v
            .as_ref()
            .map_or(Cell::Null, |x| Cell::Text(text(&x.to_string()))),
        ColumnData::DateTimeOffset(None)
        | ColumnData::DateTime(None)
        | ColumnData::SmallDateTime(None)
        | ColumnData::DateTime2(None)
        | ColumnData::Date(None)
        | ColumnData::Time(None) => Cell::Null,
        ColumnData::DateTimeOffset(_) => {
            match chrono::DateTime::<chrono::FixedOffset>::from_sql(data) {
                Ok(Some(t)) => Cell::TsTz(t),
                _ => other(),
            }
        }
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            match chrono::NaiveDateTime::from_sql(data) {
                Ok(Some(t)) => Cell::Ts(t),
                _ => other(),
            }
        }
        ColumnData::Date(_) => match chrono::NaiveDate::from_sql(data) {
            Ok(Some(d)) => Cell::Date(d),
            _ => other(),
        },
        ColumnData::Time(_) => match chrono::NaiveTime::from_sql(data) {
            Ok(Some(t)) => Cell::Time(t),
            _ => other(),
        },
    }
}

/// The batch with a last statement that reports `@@ROWCOUNT`: tiberius does not pass on the row counts of
/// the protocol. `@@ROWCOUNT` right after the user's statement is its count.
fn with_rowcount(sql: &str) -> String {
    format!("{sql}\n;SELECT @@ROWCOUNT AS [{ROWCOUNT}]")
}

/// Statements that must be alone in their batch (`CREATE VIEW`, `CREATE PROCEDURE` …) are refused with the
/// added `SELECT`: error 111, or a syntax error (102, 156) at the added statement. All three are found when
/// the batch is compiled – nothing of it ran, so it is safe to send it again without the addition.
fn must_be_alone(e: &tiberius::error::Error) -> bool {
    matches!(e, tiberius::error::Error::Server(t) if matches!(t.code(), 102 | 111 | 156))
}

impl Ms {
    async fn batch(
        conn: &mut Conn,
        sql: String,
        max_rows: usize,
    ) -> Result<(Vec<Column>, Vec<Vec<Cell>>, bool, Option<u64>), tiberius::error::Error> {
        let mut stream = conn.simple_query(sql).await?;
        let mut cols: Vec<Column> = Vec::new();
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        let mut current: Vec<Column> = Vec::new();
        let mut affected: Option<u64> = None;
        let mut truncated = false;
        let mut budget = Budget::default();
        // 0 = before the first result set with columns, 1 = in it, 2 = behind it
        let mut state = 0u8;
        while let Some(item) = stream.next().await {
            match item? {
                tiberius::QueryItem::Metadata(meta) => {
                    current = columns(meta.columns());
                    let count_only = current.len() == 1 && current[0].name == ROWCOUNT;
                    if state == 1 {
                        state = 2;
                    }
                    if state == 0 && !count_only && !current.is_empty() {
                        cols = current.clone();
                        state = 1;
                    }
                }
                tiberius::QueryItem::Row(row) => {
                    if current.len() == 1 && current[0].name == ROWCOUNT {
                        if let Some((_, ColumnData::I32(Some(n)))) = row.cells().next() {
                            affected = Some(u64::try_from(*n).unwrap_or(0));
                        }
                        continue;
                    }
                    // everything is read to its end: the connection must see the end of the batch
                    if state != 1 || truncated {
                        continue;
                    }
                    let cells: Vec<Cell> = row
                        .cells()
                        .zip(cols.iter())
                        .map(|((_, data), c)| cell(data, &c.type_name))
                        .collect();
                    let room = budget.add(&cells);
                    rows.push(cells);
                    truncated = rows.len() >= max_rows || !room;
                }
            }
        }
        Ok((cols, rows, truncated, affected))
    }

    async fn run(
        conn: &mut Conn,
        sql: &str,
        max_rows: usize,
        profile: &Profile,
    ) -> AppResult<QueryResult> {
        let started = Instant::now();
        let first = Self::batch(conn, with_rowcount(sql), max_rows).await;
        let (columns, rows, truncated, affected) = match first {
            Err(e) if must_be_alone(&e) => Self::batch(conn, sql.to_string(), max_rows)
                .await
                .map_err(|e| ms_error(profile, &e))?,
            other => other.map_err(|e| ms_error(profile, &e))?,
        };
        let has_result = !columns.is_empty();
        Ok(QueryResult {
            columns,
            rows,
            truncated,
            rows_affected: if has_result { None } else { affected },
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }
}

impl Session for Ms {
    fn execute(&mut self, sql: &str, max_rows: usize, stop: Stop) -> AppResult<QueryResult> {
        let profile = self.profile.clone();
        let conn = self.conn.as_mut().ok_or_else(closed)?;
        let r = block(None, stop, Self::run(conn, sql, max_rows, &profile));
        if r.as_ref().is_err_and(|e| !keeps_connection(e.code)) {
            self.conn = None;
        }
        r
    }

    fn server_version(&mut self, stop: Stop) -> AppResult<String> {
        let r = self.execute("SELECT @@VERSION", 1, stop)?;
        Ok(match r.rows.first().and_then(|row| row.first()) {
            // the first line names product and version
            Some(Cell::Text(v)) => v.lines().next().unwrap_or("SQL Server").trim().to_string(),
            _ => "SQL Server".to_string(),
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
    fn adds_the_row_count_behind_the_statement() {
        let sql = with_rowcount("UPDATE t SET a = 1 -- note");
        // a trailing line comment must not swallow the added statement
        assert!(sql.contains("-- note\n;SELECT @@ROWCOUNT"));
    }

    #[test]
    fn reads_cells() {
        assert_eq!(cell(&ColumnData::I32(Some(7)), "Int4"), Cell::I64(7));
        assert_eq!(cell(&ColumnData::I32(None), "Int4"), Cell::Null);
        assert_eq!(cell(&ColumnData::Bit(Some(true)), "Bit"), Cell::Bool(true));
        assert_eq!(
            cell(&ColumnData::String(Some("ä".into())), "NVarchar"),
            Cell::Text("ä".into())
        );
        assert_eq!(
            cell(&ColumnData::Binary(Some(vec![1, 2].into())), "BigVarBin"),
            Cell::Bytes(2, vec![1, 2])
        );
        assert_eq!(cell(&ColumnData::Date(None), "Daten"), Cell::Null);
    }
}
