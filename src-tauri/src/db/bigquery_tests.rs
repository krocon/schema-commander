//! BigQuery against a server of the test's own that answers as Google's documentation says (prompt
//! 035j): what the emulator does not do – pages, a job that is still running, the login. The dialect is
//! checked against the emulator in `tests/bigquery_integration.rs`.

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
    body: Value,
}

/// A server on a port of this machine: answers every request with what `answer` makes of it.
fn server(
    answer: impl Fn(&Seen, usize) -> (u16, String) + Send + 'static,
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
                    _ => {}
                }
            }
            let mut body = vec![0u8; length];
            let _ = reader.read_exact(&mut body);
            request.body = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let n = log.lock().unwrap().len();
            let (status, text) = answer(&request, n);
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
    p.kind = DbKind::Bigquery;
    p.host = "127.0.0.1".into();
    p.port = port;
    p.user = "EU".into();
    p.database = "my-project".into();
    p.tls = TlsMode::Off;
    p
}

fn done(fields: Value, rows: Value) -> String {
    json!({"jobReference": {"jobId": "job_1", "projectId": "my-project", "location": "EU"},
        "schema": {"fields": fields}, "rows": rows, "jobComplete": true})
    .to_string()
}

fn one() -> String {
    done(
        json!([{"name": "f0_", "type": "INTEGER"}]),
        json!([{"f": [{"v": "1"}]}]),
    )
}

fn run(s: &mut BigQuery, sql: &str, params: &[Bind]) -> AppResult<QueryResult> {
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
fn waits_for_a_job_reads_its_pages_and_binds_values_with_their_types() {
    let (port, seen) = server(|request, _| {
        let query = request
            .body
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if request.method == "POST" && query == "SELECT 1" {
            return (200, one());
        }
        if request.method == "POST" {
            // not done within the wait: only the job is named
            return (
                200,
                json!({"jobReference": {"jobId": "job_1", "projectId": "my-project", "location": "EU"},
                    "jobComplete": false})
                .to_string(),
            );
        }
        let fields = json!([
            {"name": "id", "type": "INTEGER"},
            {"name": "tags", "type": "STRING", "mode": "REPEATED"},
            {"name": "who", "type": "RECORD", "fields": [
                {"name": "name", "type": "STRING"}, {"name": "n", "type": "INTEGER"}]},
            {"name": "at", "type": "TIMESTAMP"},
        ]);
        if request.path.contains("pageToken=p2") {
            (
                200,
                json!({"jobComplete": true, "schema": {"fields": fields},
                    "rows": [{"f": [{"v": "2"}, {"v": []}, {"v": null}, {"v": null}]}]})
                .to_string(),
            )
        } else {
            (
                200,
                json!({"jobComplete": true, "schema": {"fields": fields}, "pageToken": "p2",
                    "rows": [{"f": [{"v": "1"}, {"v": [{"v": "a"}, {"v": "b"}]},
                        {"v": {"f": [{"v": "Ada"}, {"v": "7"}]}}, {"v": "1709211909250000"}]}]})
                .to_string(),
            )
        }
    });
    let mut s = connect(&profile(port), None, &|| false).unwrap();
    let r = run(
        &mut s,
        "SELECT * FROM d.t WHERE id = ? AND name = ? AND price < ? AND ok = ? AND day = ?",
        &[
            Bind::Int("7".into()),
            Bind::Text("'; DROP TABLE t; --".into()),
            Bind::Decimal("12.50".into()),
            Bind::Bool(true),
            Bind::Date("2026-11-12".into()),
        ],
    )
    .unwrap();
    let all = seen.lock().unwrap().clone();
    // the statement and its values, apart and typed; the place of the jobs
    let posted = &all[1];
    assert_eq!(posted.path, "/bigquery/v2/projects/my-project/queries");
    assert_eq!(posted.body["useLegacySql"], json!(false));
    assert_eq!(posted.body["location"], json!("EU"));
    assert_eq!(posted.body["parameterMode"], json!("POSITIONAL"));
    let types: Vec<&str> = posted.body["queryParameters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["parameterType"]["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["INT64", "STRING", "NUMERIC", "BOOL", "DATE"]);
    assert_eq!(
        posted.body["queryParameters"][1]["parameterValue"]["value"],
        json!("'; DROP TABLE t; --")
    );
    // asked again for the job, where it runs, then for its second page
    assert!(
        all[2]
            .path
            .starts_with("/bigquery/v2/projects/my-project/queries/job_1?")
    );
    assert!(all[2].path.contains("location=EU"));
    assert!(all[3].path.contains("pageToken=p2"));
    // lists and records as JSON with the names of their fields, an instant as one
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0][1], Cell::Json("[\"a\",\"b\"]".into()));
    assert_eq!(
        r.rows[0][2],
        Cell::Json("{\"n\":7,\"name\":\"Ada\"}".into())
    );
    assert!(
        matches!(&r.rows[0][3], Cell::TsTz(t) if t.to_rfc3339().starts_with("2024-02-29T13:05:09.25"))
    );
    assert_eq!(r.rows[1][1], Cell::Json("[]".into()));
    assert_eq!(r.rows[1][2], Cell::Null);
    assert_eq!(r.columns[1].type_name, "ARRAY<STRING>");
    assert!(run(&mut s, "SELECT ?", &[Bind::Decimal("1; DROP".into())]).is_err());
}

#[test]
fn a_running_job_is_cancelled_when_the_work_stops() {
    let (port, seen) = server(|request, _| {
        let query = request
            .body
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if request.method == "POST" && query == "SELECT 1" {
            (200, one())
        } else if request.path.contains("/cancel") {
            (200, "{}".to_owned())
        } else {
            (
                200,
                json!({"jobReference": {"jobId": "job_9", "location": "EU"}, "jobComplete": false})
                    .to_string(),
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
    let cancels: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.path.contains("/cancel"))
        .map(|r| format!("{} {}", r.method, r.path))
        .collect();
    assert_eq!(
        cancels,
        [
            "POST /bigquery/v2/projects/my-project/jobs/job_9/cancel?location=EU",
            "POST /bigquery/v2/projects/my-project/jobs/job_9/cancel?location=EU"
        ]
    );
}

#[test]
fn says_what_bigquery_said_with_its_place() {
    let sql = "SELECT 'ü'\n  FRM t";
    let syntax = failed(
        "h",
        400,
        &json!({"code": 400, "message": "Syntax error: Expected end of input but got identifier \"FRM\" at [2:3]",
            "errors": [{"reason": "invalidQuery", "location": "query"}]}),
        sql,
    );
    assert_eq!(syntax.code, ErrorCode::InvalidQuery);
    let d = syntax.details.unwrap();
    assert_eq!(d.sqlstate.as_deref(), Some("invalidQuery"));
    assert_eq!((d.line, d.position), (Some(2), Some(11 + 3)));
    let code = |status: u16, reason: &str, message: &str| {
        failed(
            "h",
            status,
            &json!({"message": message, "errors": [{"reason": reason}]}),
            "",
        )
        .code
    };
    assert_eq!(
        code(403, "accessDenied", "Access Denied: Table p:d.t"),
        ErrorCode::PermissionDenied
    );
    assert_eq!(
        code(404, "notFound", "Not found: Project nope"),
        ErrorCode::NotFound
    );
    // a table that is not there is a matter of the statement, with its place
    assert_eq!(
        code(
            404,
            "notFound",
            "Not found: Table p:d.nope was not found at [1:15]"
        ),
        ErrorCode::InvalidQuery
    );
    assert_eq!(
        code(400, "stopped", "Job was cancelled"),
        ErrorCode::Cancelled
    );
    assert_eq!(
        code(503, "backendError", "try again"),
        ErrorCode::ConnectionFailed
    );
    let login = failed(
        "h",
        401,
        &json!({"message": "Invalid Credentials: ya29.secret"}),
        "",
    );
    assert_eq!(login.message, "login failed");
}

#[test]
fn a_login_goes_to_google_and_nowhere_else() {
    let stop = &|| false;
    // without a key only this machine is talked to
    let mut far = profile(443);
    far.host = API_HOST.into();
    far.tls = TlsMode::Verify;
    assert_eq!(
        connect(&far, None, stop).err().unwrap().code,
        ErrorCode::InvalidProfile
    );
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("key.json");
    let write = |v: Value| std::fs::write(&key, v.to_string()).unwrap();
    far.client_key = key.to_string_lossy().into_owned();
    // a key is never sent to another host, nor over TLS that checks nobody
    write(json!({"type": "service_account", "client_email": "a@b.iam", "private_key": "x"}));
    for (host, tls) in [
        ("bigquery.googleapis.com.evil.example", TlsMode::Verify),
        (API_HOST, TlsMode::Off),
        (API_HOST, TlsMode::Require),
    ] {
        let mut p = far.clone();
        p.host = host.into();
        p.tls = tls;
        assert_eq!(
            connect(&p, None, stop).err().unwrap().code,
            ErrorCode::InvalidProfile,
            "{host}"
        );
    }
    // a key file that is none, or that would send the assertion somewhere else
    for bad in [
        json!({"type": "authorized_user", "client_email": "a@b", "private_key": "x"}),
        json!({"type": "service_account", "client_email": "a@b.iam", "private_key": "AAAA",
            "token_uri": "https://evil.example/token"}),
        json!({"type": "service_account", "client_email": "", "private_key": "AAAA"}),
    ] {
        write(bad);
        let e = connect(&far, None, stop).err().unwrap();
        assert_eq!(e.code, ErrorCode::InvalidProfile, "{}", e.message);
        assert!(!e.message.contains("AAAA"));
    }
    // a project id becomes part of an address
    assert!(project("my-project").is_ok());
    assert!(project("../../x").is_err());
    assert!(project("a b").is_err());
    assert!(project("").is_err());
}

/// The assertion is signed as RS256 – checked with a key of the test's own, where `openssl` is at hand.
#[test]
fn signs_an_assertion_one_can_read() {
    let Ok(out) = std::process::Command::new("openssl")
        .args([
            "genpkey",
            "-algorithm",
            "RSA",
            "-pkeyopt",
            "rsa_keygen_bits:2048",
        ])
        .output()
    else {
        return;
    };
    let pem = String::from_utf8_lossy(&out.stdout).into_owned();
    if !pem.contains("BEGIN PRIVATE KEY") {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("key.json");
    std::fs::write(
        &file,
        json!({"type": "service_account", "client_email": "sc@my-project.iam.gserviceaccount.com",
            "private_key": pem, "token_uri": TOKEN_URI})
        .to_string(),
    )
    .unwrap();
    let key = read_key(&file.to_string_lossy()).unwrap();
    let jwt = assertion(&key, 1_700_000_000).unwrap();
    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3);
    let claims: Value = serde_json::from_slice(&BASE64_URL.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(
        claims["iss"],
        json!("sc@my-project.iam.gserviceaccount.com")
    );
    assert_eq!(claims["aud"], json!(TOKEN_URI));
    assert_eq!(claims["scope"], json!(SCOPE));
    assert_eq!(claims["exp"], json!(1_700_003_600u64));
    assert_eq!(BASE64_URL.decode(parts[2]).unwrap().len(), 256);
}

#[test]
fn values_become_cells() {
    let f = |kind: &str| json!({"name": "c", "type": kind});
    assert_eq!(
        cell(&json!("9223372036854775807"), &f("INTEGER")),
        Cell::I64(i64::MAX)
    );
    assert_eq!(
        cell(&json!("12.50"), &f("NUMERIC")),
        Cell::Decimal("12.50".into())
    );
    assert_eq!(cell(&json!("1.5"), &f("FLOAT")), Cell::F64(1.5));
    assert!(matches!(cell(&json!("NaN"), &f("FLOAT")), Cell::F64(x) if x.is_nan()));
    assert_eq!(cell(&json!("true"), &f("BOOLEAN")), Cell::Bool(true));
    assert_eq!(cell(&json!("AP8="), &f("BYTES")), Cell::bytes(&[0, 255]));
    assert!(matches!(
        cell(&json!("2024-02-29"), &f("DATE")),
        Cell::Date(_)
    ));
    assert!(matches!(
        cell(&json!("2024-02-29T13:05:09.250000"), &f("DATETIME")),
        Cell::Ts(_)
    ));
    // seconds with a fraction, as the emulator writes an instant
    assert!(matches!(
        cell(&json!("1709211909.250000"), &f("TIMESTAMP")),
        Cell::TsTz(t) if t.timestamp_millis() == 1_709_211_909_250
    ));
    assert_eq!(cell(&Value::Null, &f("STRING")), Cell::Null);
    assert_eq!(
        kind_of(&json!({"type": "INTEGER", "mode": "REPEATED"})),
        ColKind::Json
    );
}
