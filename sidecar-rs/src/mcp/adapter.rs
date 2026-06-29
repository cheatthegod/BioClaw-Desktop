//! Convert MCP tools into the chat loop's `ToolSchema` so they can be
//! surfaced alongside the built-in tools.
//!
//! MCP tool names are namespaced as `mcp__<server>__<tool>` so they never
//! collide with built-ins (invoke_skill, run_skill_script, memory_*) and the
//! dispatcher can route an `mcp__`-prefixed call back to the right server.

use crate::chat::provider::ToolSchema;

use super::McpTool;

pub const PREFIX: &str = "mcp__";

/// Build the namespaced tool name for an MCP tool.
pub fn qualified_name(server: &str, tool: &str) -> String {
    format!("{PREFIX}{server}__{tool}")
}

/// Parse a qualified name back into `(server, tool)`.
pub fn parse_qualified(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix(PREFIX)?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some((server, tool))
}

/// Convert one MCP tool (from `server`) into a `ToolSchema`.
pub fn to_tool_schema(server: &str, t: &McpTool) -> ToolSchema {
    ToolSchema {
        name: qualified_name(server, &t.name),
        description: t.description.clone(),
        schema: t.input_schema.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_roundtrip() {
        let q = qualified_name("fs", "read_file");
        assert_eq!(q, "mcp__fs__read_file");
        assert_eq!(parse_qualified(&q), Some(("fs", "read_file")));
        assert_eq!(parse_qualified("invoke_skill"), None);
        assert_eq!(parse_qualified("mcp__only"), None);
    }

    #[test]
    fn to_schema_namespaces() {
        let t = McpTool {
            name: "echo".into(),
            description: "echoes".into(),
            input_schema: serde_json::json!({ "type": "object" }),
        };
        let s = to_tool_schema("mock", &t);
        assert_eq!(s.name, "mcp__mock__echo");
        assert_eq!(s.description, "echoes");
    }
}
