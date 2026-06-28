//! `/chat` request handling.
//!
//! Mirrors the Node sidecar's chat pipeline (`sidecar/src/main.ts::app.post('/chat')`):
//! - `types` — wire shape for `ChatRequestBody`, `AgentMessage`, and the
//!   `AgentEvent` envelope that gets serialized into SSE.
//! - `provider` — the `Provider` trait + the BioClaw-proxy implementation
//!   that forwards to `chat.bioclaw.tech/api/desktop/chat/completions`.
//!   The SaaS endpoint exposes the same OpenAI-compatible wire format
//!   OpenRouter does, so the client logic is a single SSE relay.
//! - `runner` — bounded tool-call loop. L.4 only needs the no-tools
//!   degenerate case (forward to provider, relay text-delta + finish).
//!   The full tool dispatch lands in L.6 with `invoke_skill` /
//!   `run_skill_script`.

pub mod provider;
pub mod runner;
pub mod tools;
pub mod types;
