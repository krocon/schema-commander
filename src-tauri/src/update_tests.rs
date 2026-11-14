//! The update check without GitHub: versions, the answer as GitHub's documentation shows it, and a server
//! of the test's own for what goes over the wire.

use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

fn v(text: &str) -> Version {
    Version::parse(text).unwrap_or_else(|| panic!("{text} is a version"))
}

#[test]
fn parses_versions_and_nothing_else() {
    assert_eq!(v("1.2.3").to_string(), "1.2.3");
    assert_eq!(v("v0.2.0").to_string(), "0.2.0");
    assert_eq!(v(" 10.20.30 ").to_string(), "10.20.30");
    assert_eq!(v("1.2.3-rc.1").to_string(), "1.2.3-rc.1");
    assert_eq!(v("1.2.3+build.5").to_string(), "1.2.3");
    for bad in [
        "",
        "1",
        "1.2",
        "1.2.3.4",
        "1.2.x",
        "1..3",
        "-1.2.3",
        "1.2.3-",
        "V1.2.3",
        "1.2.3 ; rm -rf",
        "1.2.3/../../x",
        "1.2.3-a b",
        "1.2.3-ä",
        "1.2.3?x=1",
        "9999999999.0.0",
        "١.٢.٣",
    ] {
        assert_eq!(Version::parse(bad), None, "{bad:?}");
    }
}

#[test]
fn orders_versions_by_number_not_by_text() {
    assert!(v("0.10.0") > v("0.9.9"));
    assert!(v("1.0.0") > v("0.99.99"));
    assert!(v("0.2.1") > v("0.2.0"));
    assert_eq!(v("v0.2.0"), v("0.2.0"));
    // a pre-release is older than its release, and ordered part by part
    assert!(v("1.0.0") > v("1.0.0-rc.1"));
    assert!(v("1.0.0-rc.10") > v("1.0.0-rc.2"));
    assert!(v("1.0.0-rc.1") > v("1.0.0-beta.9"));
    assert!(v("1.0.0-alpha.1") > v("1.0.0-alpha"));
    assert!(v("1.0.0-alpha") > v("1.0.0-1"));
}

fn release(tag: &str, extra: &str) -> String {
    format!(
        r#"{{"tag_name":"{tag}","name":"Schema Commander","draft":false,"prerelease":false,
            "published_at":"2026-11-14T09:30:00Z","html_url":"https://evil.example/x",
            "body":"What is new\r\n\r\n- one\r\n- two"{extra}}}"#
    )
}

#[test]
fn tells_a_newer_release() {
    let info = read_release(&release("v0.3.0", ""), "0.2.0").unwrap();
    assert_eq!(
        info,
        UpdateInfo {
            current: "0.2.0".into(),
            latest: "0.3.0".into(),
            newer: true,
            published: "2026-11-14".into(),
            notes: "What is new\n\n- one\n- two".into(),
            notes_cut: false,
        }
    );
}

#[test]
fn the_same_or_an_older_release_is_not_newer() {
    assert!(!read_release(&release("v0.2.0", ""), "0.2.0").unwrap().newer);
    assert!(!read_release(&release("v0.1.9", ""), "0.2.0").unwrap().newer);
    // a build ahead of the releases (development)
    assert!(
        !read_release(&release("v0.2.0", ""), "0.3.0-dev")
            .unwrap()
            .newer
    );
}

#[test]
fn never_offers_a_draft_or_a_pre_release() {
    let draft = release("v9.0.0", "").replace(r#""draft":false"#, r#""draft":true"#);
    assert!(!read_release(&draft, "0.2.0").unwrap().newer);
    let pre = release("v9.0.0", "").replace(r#""prerelease":false"#, r#""prerelease":true"#);
    assert!(!read_release(&pre, "0.2.0").unwrap().newer);
    assert!(
        !read_release(&release("v9.0.0-rc.1", ""), "0.2.0")
            .unwrap()
            .newer
    );
}

#[test]
fn refuses_an_answer_that_is_not_a_release() {
    for bad in [
        "",
        "<html>",
        "[]",
        "{}",
        r#"{"tag_name":7}"#,
        r#"{"tag_name":"latest"}"#,
        r#"{"tag_name":"v1.2.3/../../../evil"}"#,
    ] {
        let e = read_release(bad, "0.2.0").unwrap_err();
        assert_eq!(e.code, ErrorCode::ConnectionFailed, "{bad:?}");
    }
    assert_eq!(
        read_release(&release("v1.0.0", ""), "not a version")
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
}

#[test]
fn notes_are_plain_bounded_text() {
    let long = "ä".repeat(MAX_NOTES + 5);
    let json = serde_json::json!({"tag_name": "v1.0.0", "body": long}).to_string();
    let info = read_release(&json, "0.2.0").unwrap();
    assert_eq!(info.notes.chars().count(), MAX_NOTES);
    assert!(info.notes_cut);
    // control characters go, line breaks and tabs stay; markup stays text
    let json = serde_json::json!({
        "tag_name": "v1.0.0",
        "body": "a\u{0}\u{1b}[31mb\r\n\tc <script>x</script>",
        "published_at": "yesterday"
    })
    .to_string();
    let info = read_release(&json, "0.2.0").unwrap();
    assert_eq!(info.notes, "a[31mb\n\tc <script>x</script>");
    assert_eq!(info.published, "");
    // no notes at all
    let info = read_release(r#"{"tag_name":"v1.0.0","body":null}"#, "0.2.0").unwrap();
    assert_eq!(info.notes, "");
}

#[test]
fn the_page_is_built_here_from_a_version() {
    assert_eq!(
        page_for("0.3.0").unwrap(),
        "https://github.com/krocon/schema-commander/releases/tag/v0.3.0"
    );
    assert_eq!(page_for("v0.3.0").unwrap(), page_for("0.3.0").unwrap());
    assert_eq!(page_for("").unwrap(), RELEASES_PAGE);
    for bad in [
        "https://evil.example",
        "0.3.0/../..",
        "0.3.0 --help",
        "0.3.0&calc",
        "-R",
    ] {
        assert_eq!(
            page_for(bad).unwrap_err().code,
            ErrorCode::Unsupported,
            "{bad:?}"
        );
    }
}

#[test]
fn serialises_camel_case() {
    let json =
        serde_json::to_value(read_release(&release("v0.3.0", ""), "0.2.0").unwrap()).unwrap();
    assert_eq!(json["notesCut"], false);
    assert_eq!(json["newer"], true);
    assert_eq!(json["latest"], "0.3.0");
}

/// A server on a port of this machine that answers every request the same way; it keeps the head of
/// each request.
fn server(status: u16, head: &'static str, text: String) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 && !line.trim().is_empty() {
                request.push_str(&line);
                line.clear();
            }
            log.lock().unwrap().push(request);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\n{head}Content-Length: {}\r\nConnection: close\r\n\r\n",
                text.len()
            );
            let _ = stream.write_all(text.as_bytes());
        }
    });
    (format!("http://127.0.0.1:{port}/latest"), seen)
}

#[test]
fn asks_once_and_sends_nothing_of_the_user() {
    let (url, seen) = server(200, "", release("v0.3.0", ""));
    let info = check_at(&url, false, "0.2.0").unwrap();
    assert!(info.newer);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let request = seen[0].to_lowercase();
    assert!(request.starts_with("get /latest http/1.1"), "{request}");
    assert!(
        request.contains("user-agent: schema-commander\r\n"),
        "{request}"
    );
    // neither the version of this build nor a cookie or a token
    assert!(!request.contains("0.2.0"), "{request}");
    assert!(!request.contains("cookie"), "{request}");
    assert!(!request.contains("authorization"), "{request}");
}

#[test]
fn says_what_a_refusal_means() {
    let (url, _) = server(404, "", r#"{"message":"Not Found"}"#.into());
    assert_eq!(
        check_at(&url, false, "0.2.0").unwrap_err().code,
        ErrorCode::NotFound
    );
    let (url, _) = server(403, "", r#"{"message":"API rate limit exceeded"}"#.into());
    let e = check_at(&url, false, "0.2.0").unwrap_err();
    assert_eq!(e.code, ErrorCode::ConnectionFailed);
    assert!(e.message.contains("try again later"), "{}", e.message);
    let (url, _) = server(500, "", "{\"message\":\"down\\u0007 for\\nnow\"}".into());
    let e = check_at(&url, false, "0.2.0").unwrap_err();
    assert_eq!(e.message, "github.com: status 500 down for now");
}

#[test]
fn follows_no_redirect() {
    let (elsewhere, other) = server(200, "", release("v9.9.9", ""));
    let head: &'static str = Box::leak(format!("Location: {elsewhere}\r\n").into_boxed_str());
    let (url, _) = server(302, head, String::new());
    assert!(check_at(&url, false, "0.2.0").is_err());
    assert!(other.lock().unwrap().is_empty());
}

#[test]
fn reads_no_answer_without_an_end() {
    let (url, _) = server(200, "", "x".repeat(MAX_ANSWER as usize + 10));
    assert!(check_at(&url, false, "0.2.0").is_err());
}

#[test]
fn the_real_address_is_https_only() {
    assert!(LATEST_URL.starts_with("https://api.github.com/"));
    // plain http is refused before anything is sent
    let (url, seen) = server(200, "", release("v0.3.0", ""));
    assert!(check_at(&url, true, "0.2.0").is_err());
    assert!(seen.lock().unwrap().is_empty());
}
