//! Minimal MCP (Model Context Protocol) client over stdio (goal M0.2).
//!
//! Spawns an MCP server as a child process and speaks newline-delimited
//! JSON-RPC 2.0 on its stdin/stdout: `initialize` → `tools/list` →
//! `tools/call`. Discovered tools are converted to `ToolSchema` so the chat
//! loop's registry can surface them alongside the built-in tools.
//!
//! Scope: the line-framed stdio transport (the common case — `npx
//! some-mcp-server`, Python servers, etc.). The handshake + tool listing +
//! tool call are covered by an integration test against a mock server.

pub mod adapter;

use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

/// A tool advertised by an MCP server.
#[derive(Debug, Clone)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// A connected MCP server: the child process + framed stdio + a request-id
/// counter. One in-flight request at a time (sufficient for tool calls; the
/// chat loop dispatches tools sequentially anyway).
#[derive(Debug)]
pub struct McpClient {
    child: Child,
    stdin: Mutex<ChildStdin>,
    stdout: Mutex<BufReader<ChildStdout>>,
    next_id: std::sync::atomic::AtomicI64,
    pub server_name: String,
}

impl McpClient {
    /// Spawn `command args...` and perform the MCP `initialize` handshake.
    pub async fn connect(command: &str, args: &[String], server_name: &str) -> Result<Self> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("spawn MCP server `{command}`"))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let client = Self {
            child,
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(BufReader::new(stdout)),
            next_id: std::sync::atomic::AtomicI64::new(1),
            server_name: server_name.to_string(),
        };
        client.initialize().await?;
        Ok(client)
    }

    fn alloc_id(&self) -> i64 {
        self.next_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.alloc_id();
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        {
            let mut w = self.stdin.lock().await;
            let line = format!("{}\n", serde_json::to_string(&req)?);
            w.write_all(line.as_bytes())
                .await
                .context("write JSON-RPC request")?;
            w.flush().await.ok();
        }
        // Read until we see the response with our id (skip notifications).
        let mut reader = self.stdout.lock().await;
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader
                .read_line(&mut line)
                .await
                .context("read JSON-RPC line")?;
            if n == 0 {
                return Err(anyhow!("MCP server closed the connection"));
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue, // ignore non-JSON log noise
            };
            if msg.get("id").and_then(|v| v.as_i64()) != Some(id) {
                continue; // a notification or another response
            }
            if let Some(err) = msg.get("error") {
                return Err(anyhow!("MCP error: {err}"));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let req = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut w = self.stdin.lock().await;
        let line = format!("{}\n", serde_json::to_string(&req)?);
        w.write_all(line.as_bytes())
            .await
            .context("write notification")?;
        w.flush().await.ok();
        Ok(())
    }

    async fn initialize(&self) -> Result<()> {
        let params = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "clientInfo": { "name": "bioclaw-desktop", "version": env!("CARGO_PKG_VERSION") }
        });
        let _ = self.request("initialize", params).await?;
        // Per spec, the client sends an `initialized` notification afterwards.
        self.notify("notifications/initialized", json!({}))
            .await
            .ok();
        Ok(())
    }

    /// List the tools the server advertises.
    pub async fn list_tools(&self) -> Result<Vec<McpTool>> {
        let result = self.request("tools/list", json!({})).await?;
        let arr = result
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(arr
            .into_iter()
            .filter_map(|t| {
                let name = t.get("name")?.as_str()?.to_string();
                let description = t
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let input_schema = t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object" }));
                Some(McpTool {
                    name,
                    description,
                    input_schema,
                })
            })
            .collect())
    }

    /// Call a tool; returns the concatenated text content of the result.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<String> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await?;
        // MCP returns `content: [{type:"text", text:"..."}, ...]`.
        let text = result
            .get("content")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_else(|| result.to_string());
        Ok(text)
    }

    /// Best-effort shutdown.
    pub async fn shutdown(mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mock MCP server: a Python one-liner speaking line-framed JSON-RPC.
    /// Responds to initialize, tools/list (one echo tool), tools/call.
    fn mock_server_script() -> String {
        r#"
import sys, json
def send(o): sys.stdout.write(json.dumps(o)+"\n"); sys.stdout.flush()
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    msg=json.loads(line)
    mid=msg.get("id"); method=msg.get("method")
    if method=="initialize":
        send({"jsonrpc":"2.0","id":mid,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"mock","version":"0"}}})
    elif method=="notifications/initialized":
        pass
    elif method=="tools/list":
        send({"jsonrpc":"2.0","id":mid,"result":{"tools":[{"name":"echo","description":"echoes text","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}})
    elif method=="tools/call":
        args=msg.get("params",{}).get("arguments",{})
        send({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":"echo: "+str(args.get("text",""))}]}})
    elif mid is not None:
        send({"jsonrpc":"2.0","id":mid,"error":{"code":-32601,"message":"method not found"}})
"#
        .to_string()
    }

    #[tokio::test]
    async fn handshake_list_and_call_against_mock() {
        // Skip gracefully if python3 isn't available in the test env.
        if Command::new("python3")
            .arg("--version")
            .output()
            .await
            .is_err()
        {
            eprintln!("python3 not available; skipping MCP integration test");
            return;
        }
        let client = McpClient::connect("python3", &["-c".into(), mock_server_script()], "mock")
            .await
            .expect("connect+initialize");
        let tools = client.list_tools().await.expect("list_tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        let out = client
            .call_tool("echo", serde_json::json!({ "text": "hi" }))
            .await
            .expect("call_tool");
        assert_eq!(out, "echo: hi");
        client.shutdown().await;
    }
}
