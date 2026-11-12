//! Snowflake against a server of the test's own that answers as Snowflake's documentation says (prompt
//! 035k): the SQL API itself needs an account. What is checked is what the driver sends and how it reads
//! answers.

use super::*;
use crate::db::value::{MAX_ROWS, QueryResult, VecSink};
use crate::db::{DbKind, TlsMode};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;

#[derive(Debug, Clone, Default)]
struct Seen {
    method: String,
    path: String,
    authorization: String,
    token_type: String,
    body: Value,
}

/// A server on a port of this machine: answers every request with what `answer` makes of it.
fn server(
    answer: impl Fn(&Seen) -> (u16, String) + Send + 'static,
) -> (u16, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = Seen::default();
            let mut length = 0usize;
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
            let mut head = line.split(' ');
            request.method = head.next().unwrap_or_default().to_owned();
            request.path = head.next().unwrap_or_default().to_owned();
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                    break;
                }
                let (name, value) = line.split_once(':').unwrap_or((&line, ""));
                match name.to_ascii_lowercase().as_str() {
                    "content-length" => length = value.trim().parse().unwrap_or(0),
                    "authorization" => request.authorization = value.trim().to_owned(),
                    "x-snowflake-authorization-token-type" => {
                        request.token_type = value.trim().to_owned();
                    }
                    _ => {}
                }
            }
            let mut body = vec![0u8; length];
            let _ = reader.read_exact(&mut body);
            request.body = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let (status, text) = answer(&request);
            log.lock().unwrap().push(request);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            );
        }
    });
    (port, seen)
}

fn profile(port: u16) -> Profile {
    let mut p = crate::db::sqlite::demo_profile();
    p.kind = DbKind::Snowflake;
    p.host = "127.0.0.1".into();
    p.port = port;
    p.user = "ada".into();
    p.database = "SHOP".into();
    p.tls = TlsMode::Off;
    p
}

fn result(row_type: Value, data: Value, partitions: usize) -> String {
    json!({"code": "090001", "sqlState": "00000", "message": "Statement executed successfully.",
        "statementHandle": "01b2-aa", "statementStatusUrl": "/api/v2/statements/01b2-aa",
        "resultSetMetaData": {"numRows": 0, "format": "jsonv2", "rowType": row_type,
            "partitionInfo": (0..partitions).map(|_| json!({"rowCount": 1})).collect::<Vec<_>>()},
        "data": data})
    .to_string()
}

fn one() -> String {
    result(
        json!([{"name": "1", "type": "fixed", "scale": 0, "precision": 1, "nullable": false}]),
        json!([["1"]]),
        1,
    )
}

fn statement(seen: &Seen) -> &str {
    seen.body
        .get("statement")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn run(s: &mut Snowflake, sql: &str, params: &[Bind]) -> AppResult<QueryResult> {
    let mut sink = VecSink::new(MAX_ROWS);
    let outcome = s.execute_bound(sql, params, Limits::rows(MAX_ROWS), &mut sink, &|| false)?;
    Ok(QueryResult {
        columns: outcome.columns,
        rows: sink.rows,
        truncated: outcome.truncated,
        rows_affected: outcome.rows_affected,
        elapsed_ms: outcome.elapsed_ms,
    })
}

#[test]
fn submits_waits_reads_partitions_and_binds_values() {
    let (port, seen) = server(|request| {
        if request.method == "POST" && statement(request) == "SELECT 1" {
            return (200, one());
        }
        if request.method == "POST" && statement(request).starts_with("INSERT") {
            let mut v: Value = serde_json::from_str(&result(
                json!([{"name": "number of rows inserted", "type": "fixed", "scale": 0}]),
                json!([["2"]]),
                1,
            ))
            .unwrap();
            v["stats"] = json!({"numRowsInserted": 2, "numRowsUpdated": 0, "numRowsDeleted": 0,
                "numDuplicateRowsUpdated": 0});
            return (200, v.to_string());
        }
        if request.method == "POST" {
            // submitted, still running
            return (
                202,
                json!({"code": "333334", "message": "Asynchronous execution in progress.",
                    "statementHandle": "01b2-aa", "statementStatusUrl": "/api/v2/statements/01b2-aa"})
                .to_string(),
            );
        }
        if request.path.ends_with("?partition=1") {
            return (
                200,
                json!({"data": [["2", null, null, null, null, null, null, null]]}).to_string(),
            );
        }
        (
            200,
            result(
                json!([
                    {"name": "ID", "type": "fixed", "scale": 0, "precision": 38},
                    {"name": "PRICE", "type": "fixed", "scale": 2, "precision": 10},
                    {"name": "NAME", "type": "text", "length": 50},
                    {"name": "DAY", "type": "date"},
                    {"name": "AT", "type": "timestamp_ntz", "scale": 9},
                    {"name": "SEEN", "type": "timestamp_tz", "scale": 9},
                    {"name": "RAW", "type": "binary"},
                    {"name": "DOC", "type": "variant"},
                ]),
                json!([[
                    "99999999999999999999",
                    "12.50",
                    "Grüße 🚀",
                    "2024-02-29",
                    "2024-02-29 13:05:09.250000000",
                    "2024-02-29 13:05:09.250000000 +0100",
                    "00FF10",
                    "{\"a\":1}"
                ]]),
                2,
            ),
        )
    });
    let mut s = connect(&profile(port), None, &|| false).unwrap();
    let r = run(
        &mut s,
        "SELECT * FROM T WHERE ID = ? AND NAME = ? AND OK = ? AND PRICE < ? AND DAY >= ?;",
        &[
            Bind::Int("7".into()),
            Bind::Text("'; DROP TABLE T; --".into()),
            Bind::Bool(true),
            Bind::Decimal("12.50".into()),
            Bind::Date("2026-11-12".into()),
        ],
    )
    .unwrap();
    let all = seen.lock().unwrap().clone();
    let posted = &all[1];
    assert_eq!(posted.path, "/api/v2/statements?async=true");
    assert_eq!(
        posted.body["statement"],
        json!("SELECT * FROM T WHERE ID = ? AND NAME = ? AND OK = ? AND PRICE < ? AND DAY >= ?")
    );
    assert_eq!(posted.body["database"], json!("SHOP"));
    assert_eq!(
        posted.body["bindings"],
        json!({
            "1": {"type": "FIXED", "value": "7"},
            "2": {"type": "TEXT", "value": "'; DROP TABLE T; --"},
            "3": {"type": "BOOLEAN", "value": "true"},
            "4": {"type": "FIXED", "value": "12.50"},
            "5": {"type": "TEXT", "value": "2026-11-12"},
        })
    );
    // dates and times are asked for as text one can read
    assert_eq!(
        posted.body["parameters"]["TIMESTAMP_TZ_OUTPUT_FORMAT"],
        json!("YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM")
    );
    assert_eq!(
        posted.body["parameters"]["MULTI_STATEMENT_COUNT"],
        json!("1")
    );
    // asked for the state, then for the second partition
    assert_eq!(
        format!("{} {}", all[2].method, all[2].path),
        "GET /api/v2/statements/01b2-aa"
    );
    assert_eq!(all[3].path, "/api/v2/statements/01b2-aa?partition=1");
    let kinds: Vec<ColKind> = r.columns.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            ColKind::Int,
            ColKind::Decimal,
            ColKind::Text,
            ColKind::Date,
            ColKind::Timestamp,
            ColKind::TimestampTz,
            ColKind::Bytes,
            ColKind::Json
        ]
    );
    assert_eq!(r.rows.len(), 2);
    // a NUMBER(38, 0) beyond an i64 stays exact
    assert_eq!(r.rows[0][0], Cell::Decimal("99999999999999999999".into()));
    assert_eq!(r.rows[0][1], Cell::Decimal("12.50".into()));
    assert_eq!(r.rows[0][2], Cell::Text("Grüße 🚀".into()));
    assert!(matches!(r.rows[0][3], Cell::Date(_)));
    assert!(matches!(r.rows[0][4], Cell::Ts(_)));
    assert!(matches!(&r.rows[0][5], Cell::TsTz(t) if t.offset().local_minus_utc() == 3600));
    assert_eq!(r.rows[0][6], Cell::bytes(&[0, 255, 16]));
    assert_eq!(r.rows[1][0], Cell::I64(2));
    assert_eq!(r.rows[1][2], Cell::Null);
    assert_eq!(r.columns[1].type_name, "NUMBER(10, 2)");
    assert_eq!(r.columns[2].type_name, "VARCHAR(50)");
    // a statement that changes rows answers with their number, not with a result
    let changed = run(&mut s, "INSERT INTO T VALUES (1), (2)", &[]).unwrap();
    assert!(changed.columns.is_empty());
    assert_eq!(changed.rows_affected, Some(2));
    assert!(run(&mut s, "SELECT ?", &[Bind::Decimal("1; DROP".into())]).is_err());
}

#[test]
fn a_running_statement_is_cancelled_when_the_work_stops() {
    let (port, seen) = server(|request| {
        if request.method == "POST" && statement(request) == "SELECT 1" {
            (200, one())
        } else if request.path.ends_with("/cancel") {
            (200, json!({"message": "Statement canceled."}).to_string())
        } else {
            (
                202,
                json!({"statementHandle": "01b2-bb", "message": "in progress"}).to_string(),
            )
        }
    });
    let mut s = connect(&profile(port), None, &|| false).unwrap();
    let mut sink = VecSink::new(1);
    let late = s.execute_bound(
        "SELECT slow",
        &[],
        Limits {
            max_rows: 1,
            timeout: Some(Duration::from_millis(0)),
        },
        &mut sink,
        &|| false,
    );
    assert_eq!(late.unwrap_err().code, ErrorCode::Timeout);
    let stopped = s.execute_bound("SELECT slow", &[], Limits::rows(1), &mut sink, &|| true);
    assert_eq!(stopped.unwrap_err().code, ErrorCode::Cancelled);
    let cancels = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.method == "POST" && r.path == "/api/v2/statements/01b2-bb/cancel")
        .count();
    assert_eq!(cancels, 2);
}

#[test]
fn says_what_snowflake_said_and_never_the_login() {
    let sql = "SELECT 'ü'\n  FRM T";
    let syntax = failed(
        "h",
        422,
        &json!({"code": "001003", "sqlState": "42000", "statementHandle": "x",
            "message": "SQL compilation error:\nsyntax error line 2 at position 2 unexpected 'FRM'."}),
        sql,
    );
    assert_eq!(syntax.code, ErrorCode::InvalidQuery);
    let d = syntax.details.unwrap();
    assert_eq!(d.sqlstate.as_deref(), Some("42000 / 001003"));
    assert_eq!((d.line, d.position), (Some(2), Some(11 + 2 + 1)));
    let code = |status: u16, code: &str, message: &str| {
        failed("h", status, &json!({"code": code, "message": message}), "").code
    };
    assert_eq!(
        code(422, "000604", "SQL execution canceled"),
        ErrorCode::Cancelled
    );
    assert_eq!(
        code(
            422,
            "003001",
            "Insufficient privileges to operate on table 'T'"
        ),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        code(503, "", "Service unavailable"),
        ErrorCode::ConnectionFailed
    );
    let login = failed(
        "h",
        401,
        &json!({"code": "390144", "message": "JWT token is invalid: eyJ…"}),
        "",
    );
    assert_eq!(login.message, "login failed");
    assert_eq!(
        code(200, "390303", "Invalid OAuth access token."),
        ErrorCode::AuthFailed
    );
}

#[test]
fn a_login_goes_to_snowflake_and_nowhere_else() {
    let stop = &|| false;
    let token = Secret::new("pat-123");
    for (host, tls) in [
        (
            "xy12345.snowflakecomputing.com.evil.example",
            TlsMode::Verify,
        ),
        ("db.example.com", TlsMode::Verify),
        ("xy12345.snowflakecomputing.com", TlsMode::Off),
        ("xy12345.snowflakecomputing.com", TlsMode::Require),
    ] {
        let mut p = profile(443);
        p.host = host.into();
        p.tls = tls;
        let e = connect(&p, Some(&token), stop).err().unwrap();
        assert_eq!(e.code, ErrorCode::InvalidProfile, "{host} {tls:?}");
        assert!(!e.message.contains("pat-123"));
    }
    // no login at all for a server that is not this machine
    let mut far = profile(443);
    far.host = "xy12345.snowflakecomputing.com".into();
    far.tls = TlsMode::Verify;
    assert_eq!(
        connect(&far, None, stop).err().unwrap().code,
        ErrorCode::AuthFailed
    );
    // the account as an assertion names it
    assert_eq!(
        account_of("xy12345.eu-central-1.snowflakecomputing.com"),
        "XY12345"
    );
    assert_eq!(
        account_of("myorg-my_account.snowflakecomputing.com"),
        "MYORG-MY_ACCOUNT"
    );
    assert_eq!(
        account_of("acct-ab12.global.snowflakecomputing.com"),
        "ACCT"
    );
    // a key file that is none
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("rsa_key.p8");
    std::fs::write(
        &key,
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n",
    )
    .unwrap();
    let e = read_key(&key.to_string_lossy()).unwrap_err();
    assert!(e.message.contains("passphrase"));
    std::fs::write(&key, "not a key").unwrap();
    assert!(read_key(&key.to_string_lossy()).is_err());
}

/// A token is sent as one; a key pair signs an assertion with the fingerprint of its public key –
/// checked against `openssl`, where it is at hand.
#[test]
fn logs_in_with_a_token_or_a_key_pair() {
    let (port, seen) = server(|_| (200, one()));
    connect(&profile(port), Some(&Secret::new("pat-123")), &|| false).unwrap();
    let first = seen.lock().unwrap()[0].clone();
    assert_eq!(first.authorization, "Bearer pat-123");
    assert_eq!(first.token_type, "PROGRAMMATIC_ACCESS_TOKEN");

    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("rsa_key.p8");
    let made = std::process::Command::new("openssl")
        .args([
            "genpkey",
            "-algorithm",
            "RSA",
            "-pkeyopt",
            "rsa_keygen_bits:2048",
            "-out",
        ])
        .arg(&key)
        .output();
    if !made.is_ok_and(|o| o.status.success()) {
        return;
    }
    let mut p = profile(port);
    p.client_key = key.to_string_lossy().into_owned();
    connect(&p, None, &|| false).unwrap();
    let with_key = seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!(with_key.token_type, "KEYPAIR_JWT");
    let jwt = with_key.authorization.strip_prefix("Bearer ").unwrap();
    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3);
    let claims: Value = serde_json::from_slice(&BASE64_URL.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(claims["sub"], json!("127.ADA"));
    // the fingerprint is the one openssl makes of the public key
    let der = std::process::Command::new("openssl")
        .args(["pkey", "-in"])
        .arg(&key)
        .args(["-pubout", "-outform", "DER"])
        .output()
        .unwrap()
        .stdout;
    let fingerprint = BASE64.encode(ring::digest::digest(&ring::digest::SHA256, &der));
    assert_eq!(
        claims["iss"],
        json!(format!("127.ADA.SHA256:{fingerprint}"))
    );
}
