//! `schema-commander-mcp` – MCP server (stdio) for the running Schema Commander (prompt 048).
//!
//! Claude Code: `claude mcp add schema-commander -- /path/to/schema-commander-mcp`
//! The app must run with AI control (MCP) on. Logs nothing: no statement, no row.

use sc_mcp::bridge;
use sc_mcp::client::BridgeClient;
use sc_mcp::server;
use std::io::{stdin, stdout, BufReader};

fn main() {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("schema-commander-mcp {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let mut tools = BridgeClient::new(bridge::endpoint_path());
    let mut input = BufReader::new(stdin().lock());
    let mut output = stdout().lock();
    if let Err(e) = server::serve(&mut input, &mut output, &mut tools) {
        eprintln!("schema-commander-mcp: {e}");
        std::process::exit(1);
    }
}
