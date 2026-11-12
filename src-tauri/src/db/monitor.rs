//! What happens on the server right now (prompt 046): sessions and what they run, who waits for whom, a
//! few figures – and ending a statement or a session.
//!
//! Every database is asked through its own catalog, with statements that are written here and read only.
//! A part the user has no right to see is left out and named (`missing`), the rest is shown. Statements
//! of other users are their data: nothing here is logged or noted anywhere.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

use super::{DbKind, Limits, Session, Stop, TextRows};
use crate::error::{AppError, AppResult, ErrorCode};

const TIMEOUT: Duration = Duration::from_secs(10);
/// Sessions shown at most.
pub const MAX_SESSIONS: usize = 2_000;
/// Characters of a statement that travel to the window.
const STATEMENT_CHARS: usize = 20_000;
/// The name the drivers of this app give themselves (`application_name`).
pub const APP_NAME: &str = "Schema Commander";

/// A session on the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    /// The id the server knows it by (a process id, a thread id, a SPID).
    pub id: String,
    pub user: String,
    pub database: String,
    pub application: String,
    pub client: String,
    /// What it does, in the words of the server (`active`, `idle in transaction`, `Sleep`, `running`).
    pub state: String,
    /// How long its statement runs; `None`: it runs none.
    pub query_ms: Option<u64>,
    /// How long its transaction is open; `None`: none is, or the server does not say.
    pub tx_ms: Option<u64>,
    /// What it waits for (`Lock: transactionid`).
    pub wait: String,
    /// The statement it runs or ran last – as far as the server shows it to this user.
    pub statement: String,
    /// The sessions it waits for.
    pub blocked_by: Vec<String>,
    /// A session of this app (the monitor itself, or a connection of it).
    pub own: bool,
    /// The session the monitor asks with: it cannot be ended from here.
    pub this: bool,
}

/// A few figures of the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Figures {
    pub version: String,
    /// Connections now, and how many the server takes.
    pub connections: Option<u64>,
    pub max_connections: Option<u64>,
    /// Transactions since the server started: the window makes a rate of two readings.
    pub transactions: Option<u64>,
    /// Bytes of the database of the connection.
    pub database_bytes: Option<u64>,
    pub uptime_s: Option<u64>,
}

/// One reading of the monitor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub sessions: Vec<SessionRow>,
    pub figures: Figures,
    /// More sessions than are shown.
    pub cut: bool,
    /// Parts that could not be read, with what the server said (a right that is missing).
    pub missing: Vec<Missing>,
    /// Whether a statement can be cancelled without ending its session.
    pub can_cancel: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Missing {
    /// `sessions`, `locks`, `transactions`, `figures`.
    pub part: &'static str,
    pub reason: String,
}

fn unsupported() -> AppError {
    AppError::new(
        ErrorCode::Unsupported,
        "this database has no sessions to watch",
    )
}

fn at(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

fn number(row: &[Option<String>], i: usize) -> Option<u64> {
    let text = row.get(i)?.as_deref()?;
    // seconds with a fraction, or a negative clock skew: whole and not below zero
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .map(|n| n.max(0.0) as u64)
}

fn statement(row: &[Option<String>], i: usize) -> String {
    at(row, i).chars().take(STATEMENT_CHARS).collect()
}

/// Asks, and notes a refusal instead of failing: the monitor shows what can be seen.
fn part(
    s: &mut dyn Session,
    sql: &str,
    name: &'static str,
    missing: &mut Vec<Missing>,
    stop: Stop,
) -> Option<TextRows> {
    match s.ask(sql, &[], Some(TIMEOUT), stop) {
        Ok(rows) => Some(rows),
        Err(e) => {
            missing.push(Missing {
                part: name,
                reason: e.message,
            });
            None
        }
    }
}

const PG_SESSIONS: &str = "SELECT pid::text, coalesce(usename, ''), coalesce(datname, ''), \
     coalesce(application_name, ''), coalesce(host(client_addr), ''), coalesce(state, ''), \
     CASE WHEN state = 'active' THEN extract(epoch FROM clock_timestamp() - query_start) * 1000 END::text, \
     (extract(epoch FROM clock_timestamp() - xact_start) * 1000)::text, \
     coalesce(wait_event_type || ': ' || wait_event, ''), coalesce(query, ''), \
     array_to_string(pg_blocking_pids(pid), ','), (pid = pg_backend_pid())::text \
     FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY pid";

const PG_FIGURES: &str = "SELECT version(), (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend')::text, \
     current_setting('max_connections'), \
     (SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database)::text, \
     pg_database_size(current_database())::text, \
     extract(epoch FROM clock_timestamp() - pg_postmaster_start_time())::text";

const MY_SESSIONS: &str = "SELECT CAST(ID AS CHAR), IFNULL(USER, ''), IFNULL(DB, ''), '', IFNULL(HOST, ''), \
     CONCAT(COMMAND, IF(IFNULL(STATE, '') = '', '', CONCAT(': ', STATE))), \
     CASE WHEN COMMAND IN ('Sleep', 'Daemon', 'Binlog Dump') OR INFO IS NULL THEN NULL ELSE CAST(TIME * 1000 AS CHAR) END, \
     IFNULL(INFO, ''), CAST(ID = CONNECTION_ID() AS CHAR) \
     FROM information_schema.PROCESSLIST ORDER BY ID";

const MY_TRANSACTIONS: &str = "SELECT CAST(trx_mysql_thread_id AS CHAR), \
     CAST(TIMESTAMPDIFF(SECOND, trx_started, NOW()) * 1000 AS CHAR) FROM information_schema.INNODB_TRX";

const MY_LOCKS: &str = "SELECT CAST(r.PROCESSLIST_ID AS CHAR), CAST(b.PROCESSLIST_ID AS CHAR) \
     FROM performance_schema.data_lock_waits w \
     JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID \
     JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID";

const MARIA_LOCKS: &str = "SELECT CAST(r.trx_mysql_thread_id AS CHAR), CAST(b.trx_mysql_thread_id AS CHAR) \
     FROM information_schema.INNODB_LOCK_WAITS w \
     JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id \
     JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id";

const MY_FIGURES: &str = "SELECT VERSION(), \
     (SELECT CAST(COUNT(*) AS CHAR) FROM information_schema.PROCESSLIST), \
     CAST(@@max_connections AS CHAR), \
     (SELECT CAST(SUM(data_length + index_length) AS CHAR) FROM information_schema.TABLES WHERE table_schema = DATABASE())";

/// Counters of the server by name (MySQL keeps them in `performance_schema`, MariaDB in
/// `information_schema`).
const MY_STATUS: &str = "SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status \
     WHERE VARIABLE_NAME IN ('Uptime', 'Com_commit', 'Com_rollback')";
const MARIA_STATUS: &str = "SELECT VARIABLE_NAME, VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS \
     WHERE VARIABLE_NAME IN ('Uptime', 'Com_commit', 'Com_rollback')";

const MS_SESSIONS: &str = "SELECT CAST(s.session_id AS varchar(20)), s.login_name, ISNULL(DB_NAME(s.database_id), ''), \
     ISNULL(s.program_name, ''), ISNULL(s.host_name, ''), ISNULL(r.status, s.status), \
     CASE WHEN r.session_id IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(ms, r.start_time, SYSDATETIME()) AS varchar(30)) END, \
     CASE WHEN s.open_transaction_count > 0 THEN CAST(DATEDIFF_BIG(ms, ISNULL(t.began, s.last_request_start_time), SYSDATETIME()) AS varchar(30)) END, \
     ISNULL(r.wait_type, ''), ISNULL(q.text, ''), \
     CASE WHEN ISNULL(r.blocking_session_id, 0) > 0 THEN CAST(r.blocking_session_id AS varchar(20)) ELSE '' END, \
     CASE WHEN s.session_id = @@SPID THEN 'true' ELSE 'false' END \
     FROM sys.dm_exec_sessions s \
     LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id \
     LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL \
     OUTER APPLY sys.dm_exec_sql_text(ISNULL(r.sql_handle, c.most_recent_sql_handle)) q \
     OUTER APPLY (SELECT MIN(a.transaction_begin_time) AS began FROM sys.dm_tran_session_transactions st \
       JOIN sys.dm_tran_active_transactions a ON a.transaction_id = st.transaction_id \
       WHERE st.session_id = s.session_id) t \
     WHERE s.is_user_process = 1 ORDER BY s.session_id";

const MS_FIGURES: &str = "SELECT @@VERSION, \
     (SELECT CAST(COUNT(*) AS varchar(20)) FROM sys.dm_exec_sessions WHERE is_user_process = 1), \
     CAST(@@MAX_CONNECTIONS AS varchar(20)), \
     (SELECT CAST(MAX(cntr_value) AS varchar(30)) FROM sys.dm_os_performance_counters \
       WHERE counter_name = 'Transactions/sec' AND instance_name = '_Total'), \
     (SELECT CAST(SUM(CAST(size AS bigint)) * 8192 AS varchar(30)) FROM sys.database_files), \
     (SELECT CAST(DATEDIFF(second, sqlserver_start_time, SYSDATETIME()) AS varchar(20)) FROM sys.dm_os_sys_info)";

/// What happens on the server of a session. SQLite has no server: `unsupported`.
pub fn activity(s: &mut dyn Session, kind: DbKind, stop: Stop) -> AppResult<Activity> {
    let mut out = Activity::default();
    let mut missing = Vec::new();
    let first_line = |text: String| text.lines().next().unwrap_or_default().trim().to_owned();
    match kind {
        DbKind::Sqlite | DbKind::Libsql | DbKind::D1 | DbKind::Duckdb => return Err(unsupported()),
        DbKind::Oracle
        | DbKind::Clickhouse
        | DbKind::Trino
        | DbKind::Firebird
        | DbKind::Bigquery
        | DbKind::Snowflake
        | DbKind::Db2 => {
            return Err(super::not_yet(kind, "the server monitor"));
        }
        DbKind::Postgres => {
            out.can_cancel = true;
            if let Some(rows) = part(s, PG_SESSIONS, "sessions", &mut missing, stop) {
                for r in rows {
                    out.sessions.push(SessionRow {
                        id: at(&r, 0),
                        user: at(&r, 1),
                        database: at(&r, 2),
                        application: at(&r, 3),
                        client: at(&r, 4),
                        state: at(&r, 5),
                        query_ms: number(&r, 6),
                        tx_ms: number(&r, 7),
                        wait: at(&r, 8),
                        statement: statement(&r, 9),
                        blocked_by: at(&r, 10)
                            .split(',')
                            .filter(|p| !p.is_empty())
                            .map(str::to_owned)
                            .collect(),
                        this: at(&r, 11) == "true",
                        own: false,
                    });
                }
            }
            if let Some(rows) = part(s, PG_FIGURES, "figures", &mut missing, stop)
                && let Some(r) = rows.first()
            {
                out.figures = Figures {
                    version: first_line(at(r, 0)),
                    connections: number(r, 1),
                    max_connections: number(r, 2),
                    transactions: number(r, 3),
                    database_bytes: number(r, 4),
                    uptime_s: number(r, 5),
                };
            }
        }
        DbKind::Mysql => {
            out.can_cancel = true;
            let version = s
                .ask("SELECT VERSION()", &[], Some(TIMEOUT), stop)
                .ok()
                .and_then(|r| r.first().map(|r| at(r, 0)))
                .unwrap_or_default();
            let maria = version.to_lowercase().contains("mariadb");
            if let Some(rows) = part(s, MY_SESSIONS, "sessions", &mut missing, stop) {
                for r in rows {
                    out.sessions.push(SessionRow {
                        id: at(&r, 0),
                        user: at(&r, 1),
                        database: at(&r, 2),
                        client: at(&r, 4),
                        state: at(&r, 5),
                        query_ms: number(&r, 6),
                        statement: statement(&r, 7),
                        this: at(&r, 8) == "1",
                        ..SessionRow::default()
                    });
                }
            }
            if let Some(rows) = part(s, MY_TRANSACTIONS, "transactions", &mut missing, stop) {
                let open: HashMap<String, Option<u64>> =
                    rows.iter().map(|r| (at(r, 0), number(r, 1))).collect();
                for session in &mut out.sessions {
                    if let Some(ms) = open.get(&session.id) {
                        session.tx_ms = *ms;
                    }
                }
            }
            let locks = if maria { MARIA_LOCKS } else { MY_LOCKS };
            if let Some(rows) = part(s, locks, "locks", &mut missing, stop) {
                for r in rows {
                    let (waiting, blocking) = (at(&r, 0), at(&r, 1));
                    if let Some(session) = out.sessions.iter_mut().find(|x| x.id == waiting)
                        && !blocking.is_empty()
                        && !session.blocked_by.contains(&blocking)
                    {
                        session.blocked_by.push(blocking);
                        if session.wait.is_empty() {
                            session.wait = "Lock".to_owned();
                        }
                    }
                }
            }
            if let Some(rows) = part(s, MY_FIGURES, "figures", &mut missing, stop)
                && let Some(r) = rows.first()
            {
                out.figures = Figures {
                    version: first_line(at(r, 0)),
                    connections: number(r, 1),
                    max_connections: number(r, 2),
                    database_bytes: number(r, 3),
                    ..Figures::default()
                };
            }
            let status = if maria { MARIA_STATUS } else { MY_STATUS };
            if let Some(rows) = part(s, status, "figures", &mut missing, stop) {
                let value = |name: &str| {
                    rows.iter()
                        .find(|r| at(r, 0).eq_ignore_ascii_case(name))
                        .and_then(|r| number(r, 1))
                };
                out.figures.uptime_s = value("Uptime");
                out.figures.transactions = match (value("Com_commit"), value("Com_rollback")) {
                    (Some(a), Some(b)) => Some(a + b),
                    _ => None,
                };
            }
        }
        DbKind::Sqlserver => {
            // a statement cannot be ended without its session here
            out.can_cancel = false;
            if let Some(rows) = part(s, MS_SESSIONS, "sessions", &mut missing, stop) {
                for r in rows {
                    out.sessions.push(SessionRow {
                        id: at(&r, 0),
                        user: at(&r, 1),
                        database: at(&r, 2),
                        application: at(&r, 3),
                        client: at(&r, 4),
                        state: at(&r, 5),
                        query_ms: number(&r, 6),
                        tx_ms: number(&r, 7),
                        wait: at(&r, 8),
                        statement: statement(&r, 9),
                        blocked_by: Some(at(&r, 10))
                            .filter(|b| !b.is_empty())
                            .into_iter()
                            .collect(),
                        this: at(&r, 11) == "true",
                        own: false,
                    });
                }
            }
            if let Some(rows) = part(s, MS_FIGURES, "figures", &mut missing, stop)
                && let Some(r) = rows.first()
            {
                out.figures = Figures {
                    version: first_line(at(r, 0)),
                    connections: number(r, 1),
                    max_connections: number(r, 2).filter(|n| *n > 0),
                    transactions: number(r, 3),
                    database_bytes: number(r, 4),
                    uptime_s: number(r, 5),
                };
            }
        }
    }
    for session in &mut out.sessions {
        session.own = session.this || session.application == APP_NAME;
    }
    if out.sessions.len() > MAX_SESSIONS {
        out.sessions.truncate(MAX_SESSIONS);
        out.cut = true;
    }
    out.missing = missing;
    Ok(out)
}

/// The statement that cancels the statement of a session (`terminate: false`) or ends the session. The
/// id is a number of the server, checked here – it stands in the statement as what it is.
pub fn kill_statement(kind: DbKind, id: &str, terminate: bool) -> AppResult<String> {
    let n: u64 = id
        .trim()
        .parse()
        .map_err(|_| AppError::new(ErrorCode::Unsupported, "the id of a session is a number"))?;
    Ok(match (kind, terminate) {
        (DbKind::Postgres, false) => format!("SELECT pg_cancel_backend({n})"),
        (DbKind::Postgres, true) => format!("SELECT pg_terminate_backend({n})"),
        (DbKind::Mysql, false) => format!("KILL QUERY {n}"),
        (DbKind::Mysql, true) => format!("KILL {n}"),
        (DbKind::Sqlserver, true) => format!("KILL {n}"),
        (DbKind::Sqlserver, false) => {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "SQL Server ends a statement only together with its session",
            ));
        }
        (DbKind::Sqlite | DbKind::Libsql | DbKind::D1 | DbKind::Duckdb, _) => {
            return Err(unsupported());
        }
        (
            DbKind::Oracle
            | DbKind::Clickhouse
            | DbKind::Trino
            | DbKind::Firebird
            | DbKind::Bigquery
            | DbKind::Snowflake
            | DbKind::Db2,
            _,
        ) => {
            return Err(super::not_yet(kind, "the server monitor"));
        }
    })
}

/// Cancels the statement of a session or ends the session. `Ok(false)`: the server says there was
/// nothing to end (PostgreSQL: the session is gone).
pub fn kill(
    s: &mut dyn Session,
    kind: DbKind,
    id: &str,
    terminate: bool,
    stop: Stop,
) -> AppResult<bool> {
    let sql = kill_statement(kind, id, terminate)?;
    let result = s.query(
        &sql,
        Limits {
            max_rows: 1,
            timeout: Some(TIMEOUT),
        },
        stop,
    )?;
    // PostgreSQL answers with whether the signal was sent
    Ok(match (kind, result.rows.first().and_then(|r| r.first())) {
        (DbKind::Postgres, Some(super::value::Cell::Bool(sent))) => *sent,
        _ => true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;

    #[test]
    fn writes_the_statement_that_ends_a_session_only_for_a_number() {
        assert_eq!(
            kill_statement(DbKind::Postgres, "4711", false).unwrap(),
            "SELECT pg_cancel_backend(4711)"
        );
        assert_eq!(
            kill_statement(DbKind::Postgres, " 4711 ", true).unwrap(),
            "SELECT pg_terminate_backend(4711)"
        );
        assert_eq!(
            kill_statement(DbKind::Mysql, "12", false).unwrap(),
            "KILL QUERY 12"
        );
        assert_eq!(
            kill_statement(DbKind::Mysql, "12", true).unwrap(),
            "KILL 12"
        );
        assert_eq!(
            kill_statement(DbKind::Sqlserver, "55", true).unwrap(),
            "KILL 55"
        );
        // SQL Server has no way to end only the statement
        assert!(kill_statement(DbKind::Sqlserver, "55", false).is_err());
        for evil in [
            "",
            "1; DROP TABLE users",
            "1 OR 1=1",
            "-1",
            "1.5",
            "0x10",
            "١٢",
        ] {
            for kind in [DbKind::Postgres, DbKind::Mysql, DbKind::Sqlserver] {
                assert!(kill_statement(kind, evil, true).is_err(), "{evil}");
            }
        }
        assert!(kill_statement(DbKind::Sqlite, "1", true).is_err());
    }

    #[test]
    fn sqlite_has_no_server_to_watch() {
        let mut s = sqlite::open(&sqlite::demo_profile()).unwrap();
        let failed = activity(&mut s, DbKind::Sqlite, &|| false);
        assert_eq!(failed.unwrap_err().code, ErrorCode::Unsupported);
    }

    #[test]
    fn reads_numbers_the_way_servers_write_them() {
        let row = |text: &str| vec![Some(text.to_owned())];
        assert_eq!(number(&row("1234.567"), 0), Some(1234));
        assert_eq!(number(&row("-5"), 0), Some(0));
        assert_eq!(number(&row(" 42 "), 0), Some(42));
        assert_eq!(number(&row("abc"), 0), None);
        assert_eq!(number(&[None], 0), None);
        assert_eq!(number(&[], 3), None);
    }
}
