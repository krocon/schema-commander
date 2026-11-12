//! sc-mcp – the MCP side of Schema Commander (prompt 048): a stdio MCP server (`schema-commander-mcp`) that
//! forwards tool calls over a local bridge to the running app, and the bridge server the app runs. Taken over
//! from log-commander `lc-mcp` (its design 022, same author, MIT) and cut to Schema Commander.
//!
//! - [`bridge`]    messages between sidecar and app, the endpoint file, token check
//! - [`tools`]     the tools with their JSON schemas, and what the assistant is told (`INSTRUCTIONS`)
//! - [`server`]    JSON-RPC 2.0 / MCP over lines
//! - [`client`]    the bridge client of the sidecar (TCP to 127.0.0.1)
//! - [`host`]      the bridge server of the app (token, line limit, connections, rate limit)
//! - [`probe`]     connection test: start the sidecar, MCP handshake, one call to the app
//!
//! Only the standard library and serde: nothing here knows a database.

pub mod bridge;
pub mod client;
pub mod host;
pub mod probe;
pub mod server;
pub mod tools;

/// Waiting in tests, the same file as in the app.
#[cfg(test)]
#[path = "../../src/test_support.rs"]
mod test_support;
