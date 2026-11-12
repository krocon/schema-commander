//! Prompt 048, the whole way without a window: an MCP client's lines → the sidecar's server → the bridge
//! on 127.0.0.1 → the engine of the app → the demo database, and back.

use sc_mcp::bridge::{self, BridgeError};
use sc_mcp::client::BridgeClient;
use sc_mcp::host::{Handler, Host};
use sc_mcp::server;
use schema_commander_lib::db::Limits;
use schema_commander_lib::db::manager::ConnectionManager;
use schema_commander_lib::db::profiles;
use schema_commander_lib::db::secrets::MemoryStore;
use schema_commander_lib::mcp::{Calls, Config, Engine, Level, LogEntry, Window};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::{Arc, Mutex, OnceLock};

/// A user who says yes to every proposal – and notes what was proposed.
#[derive(Default)]
struct Yes {
    calls: OnceLock<Arc<Calls>>,
    proposed: Mutex<Vec<Value>>,
}

impl Window for Yes {
    fn ask(&self, id: u64, _tool: &str, args: &Value) -> bool {
        self.proposed.lock().unwrap().push(args.clone());
        let calls = self.calls.get().unwrap().clone();
        std::thread::spawn(move || calls.complete(id, Ok(json!({"accepted": true, "ran": true}))));
        true
    }
    fn log(&self, _entry: &LogEntry) {}
}

struct App {
    manager: ConnectionManager,
    engine: Engine<Yes>,
}

impl Handler for App {
    fn call(&self, tool: &str, args: &Value) -> Result<Value, BridgeError> {
        self.engine.call(&self.manager, tool, args)
    }
}

fn app(dir: &std::path::Path) -> Arc<App> {
    let manager = ConnectionManager::new(
        dir.join(profiles::FILE_NAME),
        Arc::new(MemoryStore::default()),
    );
    manager.open("demo", None).unwrap();
    manager
        .ask("demo", |s, _, stop| {
            s.query("DROP TABLE IF EXISTS mcp_e2e", Limits::rows(1), stop)?;
            s.query(
                "CREATE TABLE mcp_e2e (id INTEGER, name TEXT)",
                Limits::rows(1),
                stop,
            )?;
            s.query(
                "INSERT INTO mcp_e2e VALUES (1, 'ann')",
                Limits::rows(1),
                stop,
            )?;
            Ok(())
        })
        .unwrap();
    let engine = Engine::new(Yes::default());
    engine.window.calls.set(engine.calls.clone()).ok();
    engine.start();
    engine.configure(Config {
        access: HashMap::from([("demo".to_owned(), Level::Write)]),
        ..Config::default()
    });
    Arc::new(App { manager, engine })
}

/// What an MCP client gets for its lines.
fn session(endpoint: &std::path::Path, lines: &[Value]) -> Vec<Value> {
    let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
    let mut out = Vec::new();
    let mut client = BridgeClient::new(Some(endpoint.to_path_buf()));
    server::serve(&mut input.as_bytes(), &mut out, &mut client).unwrap();
    String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn call(id: u64, name: &str, arguments: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
}

#[test]
fn an_assistant_reads_the_schema_runs_a_select_and_proposes_an_update() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = dir.path().join(bridge::ENDPOINT_FILE);
    let app = app(dir.path());
    let host = Host::start(app.clone(), &endpoint).unwrap();
    let update = "UPDATE mcp_e2e SET name = 'x'";
    let a = session(
        &endpoint,
        &[
            json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
            call(1, "list_connections", json!({})),
            call(
                2,
                "get_schema",
                json!({"connection": "demo", "schema": "main"}),
            ),
            call(
                3,
                "run_query",
                json!({"connection": "demo", "sql": "SELECT id, name FROM mcp_e2e"}),
            ),
            call(4, "run_query", json!({"connection": "demo", "sql": update})),
            call(
                5,
                "propose_query",
                json!({"connection": "demo", "sql": update, "reason": "test"}),
            ),
        ],
    );
    assert_eq!(a[0]["result"]["serverInfo"]["name"], "schema-commander");
    assert_eq!(
        a[1]["result"]["structuredContent"]["connections"][0]["access"],
        "write"
    );
    assert!(
        a[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("mcp_e2e")
    );
    assert_eq!(
        a[3]["result"]["structuredContent"]["rows"],
        json!([[1, "ann"]])
    );
    // the UPDATE does not run: it is refused as a query …
    assert_eq!(a[4]["result"]["isError"], true);
    assert!(
        a[4]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("statement_writes")
    );
    // … and as a proposal it goes to the user; the engine itself changed nothing
    assert_eq!(a[5]["result"]["structuredContent"]["accepted"], true);
    assert_eq!(app.engine.window.proposed.lock().unwrap()[0]["sql"], update);
    let name = app
        .manager
        .ask("demo", |s, _, stop| {
            s.query("SELECT name FROM mcp_e2e", Limits::rows(1), stop)
        })
        .unwrap();
    assert_eq!(serde_json::to_value(&name.rows[0][0]).unwrap(), "ann");
    drop(host);
}

/// The first acceptance criterion: without AI control no port listens and nothing answers.
#[test]
fn off_means_no_port_and_no_file() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = dir.path().join(bridge::ENDPOINT_FILE);
    // never turned on: the sidecar finds nothing and says so
    let a = session(&endpoint, &[call(1, "list_connections", json!({}))]);
    assert!(
        a[0]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("not_running")
    );
    let host = Host::start(app(dir.path()), &endpoint).unwrap();
    let port = host.port;
    assert!(endpoint.is_file());
    // only on the loopback address, and only with the token of the file
    let wrong = dir.path().join("wrong.json");
    bridge::write_endpoint(
        &wrong,
        &bridge::Endpoint {
            port,
            token: bridge::new_token(),
            pid: 0,
        },
    )
    .unwrap();
    let a = session(&wrong, &[call(1, "list_connections", json!({}))]);
    assert_eq!(a[0]["result"]["isError"], true);
    // turned off: the file is gone and the port refuses
    drop(host);
    assert!(!endpoint.exists());
    let mut refused = false;
    for _ in 0..200 {
        if TcpStream::connect(("127.0.0.1", port)).is_err() {
            refused = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(refused, "the port still listens");
}
