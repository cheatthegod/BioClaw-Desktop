//! Provider abstraction + registry.
//!
//! Phase-2 of the Node sidecar only needed `bioclaw-proxy` and
//! `openrouter`. L.4 ships `bioclaw-proxy` since that's the only one
//! the SaaS-authenticated desktop UI ever hits. `openrouter` /
//! `openai-compatible` come along in L.9 when we add the optional
//! "bring your own API key" mode back.

pub mod bioclaw_proxy;
pub mod openai_compat;

use anyhow::{bail, Result};

use super::types::{ModelSpec, ProviderEvent};

pub type ProviderStream = futures::stream::BoxStream<'static, Result<ProviderEvent>>;

/// Streaming completion request. The runner builds one per loop turn.
#[derive(Debug, Clone)]
pub struct ProviderStreamRequest {
    pub model: ModelSpec,
    /// System prompt — providers want it as a dedicated field, not
    /// interleaved in `messages`.
    pub system: String,
    /// Conversation history including in-progress tool-call rounds.
    pub messages: Vec<super::types::AgentMessage>,
    /// Tool definitions surfaced to the model. Empty in L.4; populated
    /// in L.6 once invoke_skill + run_skill_script land.
    pub tools: Vec<ToolSchema>,
}

/// Wire-format tool definition. Mirrors OpenAI's `tools[].function`
/// shape so we can hand it straight to the OpenAI-compatible endpoint.
#[derive(Debug, Clone)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub schema: serde_json::Value,
}

#[allow(async_fn_in_trait)] // We control the call sites; no extra Send bound needed.
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    async fn stream_messages(&self, req: ProviderStreamRequest) -> Result<ProviderStream>;
}

/// Resolve a provider by id. Currently only `bioclaw-proxy` is wired;
/// adding openrouter / openai-compatible later is a one-line match arm.
pub async fn stream_with_provider(
    provider_id: &str,
    req: ProviderStreamRequest,
) -> Result<ProviderStream> {
    match provider_id {
        "bioclaw-proxy" => bioclaw_proxy::BioClawProxy.stream_messages(req).await,
        "openai-compatible" => openai_compat::OpenAiCompat.stream_messages(req).await,
        other => bail!("unknown provider: {other}"),
    }
}
