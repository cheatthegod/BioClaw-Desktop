//! Tool framework — handler trait + skill-backed tool definitions.
//!
//! Two tools ship in L.6 (mirroring the Node sidecar's Phase-3 +
//! Phase-4 tool surface):
//!
//! * `invoke_skill(skill_id)` — load the skill's SKILL.md body and
//!   return it as the tool result. No subprocess; purely read.
//!   Lives in `invoke_skill::handle`.
//! * `run_skill_script(skill_id, script, args?, timeout_ms?)` —
//!   spawn the script with a minimal env, gated by the permission
//!   resolver. Returns stdout/stderr/exit_code/timing.
//!   Lives in `run_skill_script::handle`.
//!
//! Both handlers share the same `ToolHandlerContext` so they can
//! emit `permission-needed` events through the per-request SSE
//! writer + abort on client disconnect.

pub mod invoke_skill;
pub mod registry;
pub mod run_skill_script;
pub mod system_prompt;

use std::sync::Arc;

use crate::chat::types::AgentEvent;
use crate::permissions::PermissionStore;
use crate::server::AppState;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Per-request context handed to every tool handler. Owns:
///   * the AppState reference (for skills, permissions),
///   * the SSE sender (for emitting permission-needed events),
///   * the abort token (cancel mid-subprocess on client disconnect),
///   * the tool-call id the model emitted (for correlation in
///     `tool-call-result` events).
#[derive(Clone)]
pub struct ToolHandlerContext {
    pub state: Arc<AppState>,
    pub events: mpsc::Sender<AgentEvent>,
    pub abort: CancellationToken,
    pub tool_call_id: String,
}

impl ToolHandlerContext {
    pub fn permissions(&self) -> &Arc<PermissionStore> {
        &self.state.permissions
    }
}

/// What a tool handler returns. `output` becomes the assistant-visible
/// `tool` message content; `is_error` flips the `tool-call-result`
/// SSE event's `isError` flag so the frontend can render it red.
#[derive(Debug, Clone)]
pub struct ToolHandlerResult {
    pub output: String,
    pub is_error: bool,
}

impl ToolHandlerResult {
    pub fn ok(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            is_error: false,
        }
    }
    pub fn err(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            is_error: true,
        }
    }
}
