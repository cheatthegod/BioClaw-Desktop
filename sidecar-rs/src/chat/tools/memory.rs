//! `memory_write` / `memory_read` / `memory_search` chat tools (goal M0.4).
//!
//! Backed by the SQLite `MemoryStore` in AppState. Let the model persist
//! durable notes ("the user prefers X", "project Y uses Z") and recall them in
//! later sessions.

use serde_json::json;

use super::{ToolHandlerContext, ToolHandlerResult};

pub const WRITE_NAME: &str = "memory_write";
pub const READ_NAME: &str = "memory_read";
pub const SEARCH_NAME: &str = "memory_search";

pub const WRITE_DESCRIPTION: &str = "Persist a durable memory under a short key so you can recall it in future sessions (e.g. the user's preferences, project facts). Overwrites any existing memory with the same key.";
pub const READ_DESCRIPTION: &str =
    "Recall a previously stored memory by its exact key. Returns the content or a not-found note.";
pub const SEARCH_DESCRIPTION: &str =
    "Search stored memories by substring over keys and content; returns the most recent matches.";

pub fn write_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "key": { "type": "string", "description": "Short stable identifier for this memory (e.g. \"user-preferred-organism\")." },
            "content": { "type": "string", "description": "The information to remember." }
        },
        "required": ["key", "content"],
        "additionalProperties": false
    })
}

pub fn read_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": { "key": { "type": "string", "description": "The exact key to recall." } },
        "required": ["key"],
        "additionalProperties": false
    })
}

pub fn search_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "Substring to search for across memory keys and content." },
            "limit": { "type": "number", "description": "Max results (default 10)." }
        },
        "required": ["query"],
        "additionalProperties": false
    })
}

pub async fn handle_write(ctx: &ToolHandlerContext, args: &serde_json::Value) -> ToolHandlerResult {
    let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if content.is_empty() {
        return ToolHandlerResult::err("memory_write: `content` must not be empty.");
    }
    match ctx.state.memory.write(key, content) {
        Ok(inserted) => ToolHandlerResult::ok(format!(
            "{} memory `{}`.",
            if inserted { "Stored new" } else { "Updated" },
            key.trim()
        )),
        Err(e) => ToolHandlerResult::err(format!("memory_write: {e:#}")),
    }
}

pub async fn handle_read(ctx: &ToolHandlerContext, args: &serde_json::Value) -> ToolHandlerResult {
    let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
    match ctx.state.memory.read(key) {
        Ok(Some(content)) => ToolHandlerResult::ok(content),
        Ok(None) => ToolHandlerResult::ok(format!("No memory stored under key `{}`.", key.trim())),
        Err(e) => ToolHandlerResult::err(format!("memory_read: {e:#}")),
    }
}

pub async fn handle_search(
    ctx: &ToolHandlerContext,
    args: &serde_json::Value,
) -> ToolHandlerResult {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 100) as usize)
        .unwrap_or(10);
    if query.trim().is_empty() {
        return ToolHandlerResult::err("memory_search: `query` must not be empty.");
    }
    match ctx.state.memory.search(query, limit) {
        Ok(rows) if rows.is_empty() => {
            ToolHandlerResult::ok(format!("No memories match `{}`.", query.trim()))
        }
        Ok(rows) => {
            let body = rows
                .iter()
                .map(|r| format!("- `{}`: {}", r.key, r.content))
                .collect::<Vec<_>>()
                .join("\n");
            ToolHandlerResult::ok(format!("{} match(es):\n{body}", rows.len()))
        }
        Err(e) => ToolHandlerResult::err(format!("memory_search: {e:#}")),
    }
}
