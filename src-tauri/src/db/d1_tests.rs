//! D1 against a server of the test's own that answers as Cloudflare's documentation says (prompt 035h):
//! the API itself needs an account. What is checked is what the driver sends and how it reads answers.

use super::*;
use crate::db::value::{MAX_ROWS, QueryResult, VecSink};
use crate::db::{DbKind, TlsMode, guard};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;

/// What a request looked like.
#[derive(Debug, Clone, Default)]
struct Seen {
    path: String,
    authorization: String,
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
            request.path = line.split(' ').nth(1).unwrap_or_default().to_owned();
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                    break;
                }
                let (name, value) = line.split_once(':').unwrap_or((&line, ""));
                match name.to_ascii_lowercase().as_str() {
                    "content-length" => length = value.trim().parse().unwrap_or(0),
                    "authorization" => request.authorization = value.trim().to_owned(),
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
    p.kind = DbKind::D1;
    p.host = "127.0.0.1".into();
    p.port = port;
    p.user = "0123456789abcdef0123456789abcdef".into();
    p.database = "11111111-2222-3333-4444-555555555555".into();
    p.tls = TlsMode::Off;
    p.protection = guard::Protection::Free;
    p
}

/// An answer as the documentation shows it: one result per statement.
fn ok(results: &[Value]) -> (u16, String) {
    (
        200,
        json!({"success": true, "errors": [], "messages": [], "result": results}).to_string(),
    )
}

fn result(columns: &[&str], rows: Value, changes: u64) -> Value {
    json!({"success": true, "meta": {"changes": changes, "duration": 0.2, "last_row_id": 0,
        "rows_read": 1, "rows_written": 0, "changed_db": changes > 0},
        "results": {"columns": columns, "rows": rows}})
}

fn version() -> Value {
    result(&["1"], json!([[1]]), 0)
}

fn sql_of(seen: &Seen) -> &str {
    seen.body
        .get("sql")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn open(port: u16) -> D1 {
    connect(&profile(port), Some(&Secret::new("tok-123")), &|| false).unwrap()
}

fn run(s: &mut D1, sql: &str, params: &[Bind]) -> AppResult<QueryResult> {
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
fn sends_what_the_api_asks_for_and_reads_its_answer() {
    let (port, seen) = server(|request| {
        let sql = sql_of(request);
        if sql == "SELECT 1" {
            ok(&[version()])
        } else if sql.starts_with("INSERT") {
            ok(&[result(&[], json!([]), 2)])
        } else {
            ok(&[result(
                &["i", "f", "t", "nul", "bin", "big"],
                json!([
                    [null, 2, "Grüße 🚀", null, [0, 255, 16], 9007199254740992u64],
                    [42, 1.5, "", null, [], 1]
                ]),
                0,
            )])
        }
    });
    let mut s = open(port);
    assert_eq!(s.server_version(&|| false).unwrap(), "Cloudflare D1");
    assert_eq!(s.transaction_state(&|| false), TxState::Idle);
    let r = run(
        &mut s,
        "SELECT * FROM t WHERE id = ?1 AND name = ?2 AND ok = ?3 AND price < ?4",
        &[
            Bind::Int(" 7 ".into()),
            Bind::Text("'; DROP TABLE t; --".into()),
            Bind::Bool(true),
            Bind::Decimal("12.50".into()),
        ],
    )
    .unwrap();
    // the request: the address with both ids, the token as a bearer, values apart from the text
    let last = seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!(
        last.path,
        "/client/v4/accounts/0123456789abcdef0123456789abcdef/d1/database/11111111-2222-3333-4444-555555555555/raw"
    );
    assert_eq!(last.authorization, "Bearer tok-123");
    assert_eq!(
        last.body,
        json!({"sql": "SELECT * FROM t WHERE id = ?1 AND name = ?2 AND ok = ?3 AND price < ?4",
            "params": ["7", "'; DROP TABLE t; --", "1", "12.50"]})
    );
    // the answer: a column is what its first value is
    let kinds: Vec<ColKind> = r.columns.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            ColKind::Int,
            // `2` and `1.5`: a column of fractions, whatever comes first
            ColKind::Float,
            ColKind::Text,
            ColKind::Other,
            ColKind::Bytes,
            ColKind::Int
        ]
    );
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0][2], Cell::Text("Grüße 🚀".into()));
    assert_eq!(r.rows[0][4], Cell::bytes(&[0, 255, 16]));
    assert_eq!(r.rows[1][0], Cell::I64(42));
    assert_eq!(r.rows[1][4], Cell::bytes(&[]));
    assert_eq!(r.rows_affected, None);
    let changed = run(&mut s, "INSERT INTO t VALUES (1), (2)", &[]).unwrap();
    assert!(changed.columns.is_empty());
    assert_eq!(changed.rows_affected, Some(2));
    // the app's own questions bind text and read text
    let asked = s
        .ask("SELECT x WHERE a = ?1", &["it's"], None, &|| false)
        .unwrap();
    assert_eq!(asked[1][0].as_deref(), Some("42"));
    assert_eq!(
        seen.lock().unwrap().last().unwrap().body["params"],
        json!(["it's"])
    );
    assert!(run(&mut s, "SELECT ?1", &[Bind::Int("1; DROP".into())]).is_err());
    // Cloudflare takes a hundred values: said in words before anything is sent
    let many: Vec<Bind> = (0..101).map(|i| Bind::Int(i.to_string())).collect();
    let before = seen.lock().unwrap().len();
    let e = run(&mut s, "SELECT 1", &many).unwrap_err();
    assert!(e.message.contains("100"), "{}", e.message);
    assert_eq!(seen.lock().unwrap().len(), before);
}

#[test]
fn a_text_of_several_statements_answers_with_its_last_one() {
    let (port, _) = server(|request| {
        if sql_of(request) == "SELECT 1" {
            ok(&[version()])
        } else {
            ok(&[result(&[], json!([]), 1), result(&["n"], json!([[3]]), 0)])
        }
    });
    let mut s = open(port);
    let r = run(
        &mut s,
        "INSERT INTO t VALUES (1); SELECT count(*) AS n FROM t",
        &[],
    )
    .unwrap();
    assert_eq!(r.columns[0].name, "n");
    assert_eq!(r.rows, vec![vec![Cell::I64(3)]]);
}

#[test]
fn says_what_cloudflare_said_and_never_the_token() {
    let (port, _) = server(|request| {
        let sql = sql_of(request);
        let error = |status: u16, code: u32, message: &str| {
            (
                status,
                json!({"success": false, "errors": [{"code": code, "message": message}],
                    "messages": [], "result": []})
                .to_string(),
            )
        };
        if request.authorization != "Bearer tok-123" {
            error(401, 10000, "Authentication error")
        } else if sql == "SELECT 1" {
            ok(&[version()])
        } else if sql.contains("FRM") {
            error(
                400,
                7500,
                "near \"FRM\": syntax error at offset 13: SQLITE_ERROR",
            )
        } else if sql.contains("_cf_KV") {
            error(400, 7500, "access to _cf_KV.key is prohibited: SQLITE_AUTH")
        } else if sql.contains("busy") {
            error(
                429,
                971,
                "Please wait and consider throttling your request speed",
            )
        } else if sql.contains("html") {
            (502, "<html>Bad Gateway</html>".to_owned())
        } else {
            // success: false inside a 200
            (
                200,
                json!({"success": false, "errors": [{"code": 7500, "message": "no such table: nope: SQLITE_ERROR"}]})
                    .to_string(),
            )
        }
    });
    let wrong = connect(&profile(port), Some(&Secret::new("hunter2")), &|| false)
        .err()
        .unwrap();
    assert_eq!(wrong.code, ErrorCode::AuthFailed);
    assert!(!wrong.message.contains("hunter2"));
    let mut s = open(port);
    let syntax = run(&mut s, "SELECT 'ü'\n FRM t", &[]).unwrap_err();
    assert_eq!(syntax.code, ErrorCode::InvalidQuery);
    let d = syntax.details.unwrap();
    assert_eq!(d.sqlstate.as_deref(), Some("7500"));
    // the offset counts bytes, the place characters: `ü` is two bytes
    assert_eq!(d.position, Some(13));
    assert_eq!(
        run(&mut s, "SELECT * FROM _cf_KV", &[]).unwrap_err().code,
        ErrorCode::PermissionDenied
    );
    let busy = run(&mut s, "SELECT 'busy'", &[]).unwrap_err();
    assert_eq!(busy.code, ErrorCode::ConnectionFailed);
    assert!(busy.message.contains("429"));
    let html = run(&mut s, "SELECT 'html'", &[]).unwrap_err();
    assert_eq!(html.code, ErrorCode::ConnectionFailed);
    assert!(html.message.contains("502"));
    let inside = run(&mut s, "SELECT * FROM nope", &[]).unwrap_err();
    assert_eq!(inside.code, ErrorCode::InvalidQuery);
    assert!(inside.message.contains("no such table"));
}

#[test]
fn refuses_a_profile_that_would_leak_or_mislead() {
    let stop = &|| false;
    let token = Secret::new("tok-123");
    // no token, no request
    assert_eq!(
        connect(&profile(1), None, stop).err().unwrap().code,
        ErrorCode::AuthFailed
    );
    // an id is part of the address: nothing but letters, digits and dashes
    for (user, database) in [
        ("", "11111111-2222-3333-4444-555555555555"),
        ("../../zones", "11111111-2222-3333-4444-555555555555"),
        ("0123456789abcdef0123456789abcdef", "x/../../y"),
        ("0123456789abcdef0123456789abcdef", "a?b=c"),
        ("0123456789abcdef0123456789abcdef", ""),
    ] {
        let mut p = profile(1);
        p.user = user.into();
        p.database = database.into();
        let e = connect(&p, Some(&token), stop).err().unwrap();
        assert_eq!(e.code, ErrorCode::InvalidProfile, "{user} {database}");
    }
    // the token goes to Cloudflare over TLS that checks who answers – or not at all
    for (host, tls) in [
        (API_HOST, TlsMode::Off),
        (API_HOST, TlsMode::Require),
        (API_HOST, TlsMode::Prefer),
        ("api.cloudflare.com.evil.example", TlsMode::Verify),
        ("d1.example.com", TlsMode::Verify),
    ] {
        let mut far = profile(443);
        far.host = host.into();
        far.tls = tls;
        let e = connect(&far, Some(&token), stop).err().unwrap();
        assert_eq!(e.code, ErrorCode::InvalidProfile, "{host} {tls:?}");
        assert!(!e.message.contains("tok-123"));
    }
    // and never through a tunnel
    let mut tunnelled = profile(443);
    tunnelled.host = API_HOST.into();
    tunnelled.tls = TlsMode::Verify;
    tunnelled.ssh = Some(crate::ssh::SshTarget {
        host: "jump.example.com".into(),
        port: 0,
        user: "me".into(),
        auth: Default::default(),
        key_file: String::new(),
    });
    assert!(crate::db::profiles::check(&tunnelled).is_err());
}

#[test]
fn a_request_that_is_stopped_is_left_behind() {
    let (port, _) = server(|request| {
        if sql_of(request) == "SELECT 1" {
            ok(&[version()])
        } else {
            std::thread::sleep(Duration::from_secs(3));
            ok(&[result(&["x"], json!([[1]]), 0)])
        }
    });
    let mut s = open(port);
    let started = Instant::now();
    let mut sink = VecSink::new(1);
    let late = s.execute_bound(
        "SELECT slow",
        &[],
        Limits {
            max_rows: 1,
            timeout: Some(Duration::from_millis(300)),
        },
        &mut sink,
        &|| false,
    );
    assert_eq!(late.unwrap_err().code, ErrorCode::Timeout);
    let stopped = s.execute_bound("SELECT slow", &[], Limits::rows(1), &mut sink, &|| true);
    assert_eq!(stopped.unwrap_err().code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(s.is_open());
}
