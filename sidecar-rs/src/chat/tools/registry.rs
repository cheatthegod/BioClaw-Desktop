//! Tool registry — assembles ToolSchemas exposed to the model and
//! dispatches inbound tool calls to the right handler.
//!
//! Lifecycle:
//!   * `build_definitions()` is called once per /chat request to
//!     produce the `tools` array sent to the provider. The schemas
//!     are stable — no per-request variation — so this is just a
//!     wrapper around the per-tool `schema()` functions.
//!   * `dispatch()` is called inside the chat loop when the model
//!     emits a tool-call. It picks the handler by name and runs it.

use crate::chat::provider::ToolSchema;

use super::{invoke_skill, run_skill_script, ToolHandlerContext, ToolHandlerResult};

pub fn build_definitions() -> Vec<ToolSchema> {
    vec![
        ToolSchema {
            name: invoke_skill::NAME.into(),
            description: invoke_skill::DESCRIPTION.into(),
            schema: invoke_skill::schema(),
        },
        ToolSchema {
            name: run_skill_script::NAME.into(),
            description: run_skill_script::DESCRIPTION.into(),
            schema: run_skill_script::schema(),
        },
    ]
}

pub async fn dispatch(
    ctx: &ToolHandlerContext,
    tool_name: &str,
    args: &serde_json::Value,
) -> ToolHandlerResult {
    match tool_name {
        invoke_skill::NAME => invoke_skill::handle(ctx, args).await,
        run_skill_script::NAME => run_skill_script::handle(ctx, args).await,
        other => ToolHandlerResult::err(format!(
            "unknown tool `{other}` — the chat loop registered tools `invoke_skill` and `run_skill_script` only."
        )),
    }
}
