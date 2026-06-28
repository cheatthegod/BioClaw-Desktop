//! Wire types for `/chat`. JSON shapes preserved 1:1 with the Node
//! sidecar so the frontend chat-state hook reads them unchanged.

use serde::{Deserialize, Serialize};

/// Request body the frontend sends.
#[derive(Debug, Deserialize)]
pub struct ChatRequestBody {
    pub messages: Vec<InboundMessage>,
    /// Session cookie (`bioclaw-proxy`) or API key (`openrouter` etc.).
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub model: String,
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub params: Option<ModelParams>,
    /// When false, skip the skills meta-tool injection. L.4 always
    /// runs with no tools — this field is parsed but ignored until
    /// L.6 wires up the skill-runner tool.
    #[serde(rename = "skillsEnabled", default)]
    pub skills_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct InboundMessage {
    pub role: InboundRole,
    pub content: String,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InboundRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelParams {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub max_output_tokens: Option<u32>,
}

/// Resolved spec a provider implementation uses to actually issue the
/// upstream request. Filled in by `build_model_spec`.
#[derive(Debug, Clone)]
pub struct ModelSpec {
    pub provider: String,
    pub id: String,
    pub endpoint: Option<String>,
    pub auth: Auth,
    pub params: ModelParams,
}

#[derive(Debug, Clone)]
pub enum Auth {
    Bearer { api_key: String },
    Cookie { cookie_name: String, token: String },
    None,
}

/// Internal message shape used by the loop. Tool messages exist as a
/// distinct role even though L.4 doesn't emit them yet — keeps the
/// vocabulary aligned with the Node sidecar so L.6 doesn't have to
/// reshape history.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum AgentMessage {
    User {
        content: String,
    },
    Assistant {
        content: String,
        #[serde(skip_serializing_if = "Vec::is_empty", default)]
        tool_calls: Vec<ToolCallRequest>,
    },
    Tool {
        tool_call_id: String,
        name: String,
        content: String,
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Events the runner streams to the SSE writer. JSON shape mirrors
/// the Node sidecar's `AgentEvent` so the frontend chat-state hook's
/// switch statement matches the same `event:` names.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AgentEvent {
    TextDelta {
        text: String,
    },
    ToolCallStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        name: String,
        args: serde_json::Value,
    },
    ToolCallResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        name: String,
        output: String,
        #[serde(rename = "isError")]
        is_error: bool,
    },
    Usage {
        #[serde(rename = "inputTokens")]
        input_tokens: u64,
        #[serde(rename = "outputTokens")]
        output_tokens: u64,
    },
    StepComplete {
        step: u32,
    },
    Finish {
        reason: FinishReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Error {
        error: String,
    },
    PermissionNeeded {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "skillId")]
        skill_id: String,
        script: String,
        interpreter: String,
        args: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinishReason {
    Stop,
    ToolUse,
    Length,
    Error,
    ToolLoopLimit,
    Cancelled,
}

/// Provider-layer events, sitting between the wire SSE chunks and
/// the runner's AgentEvents. The runner translates these into
/// `AgentEvent`s, optionally folding consecutive text-deltas before
/// emitting (we don't bother — the OpenAI stream is already chunked
/// fine for direct relay).
#[derive(Debug, Clone)]
pub enum ProviderEvent {
    TextDelta(String),
    ToolCallStart {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    ToolCallArgumentsDelta {
        id: String,
        delta: String,
    },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    Finish {
        reason: FinishReason,
    },
}
