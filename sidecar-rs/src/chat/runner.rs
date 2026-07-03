//! Bounded chat loop with tool dispatch.
//!
//! Per turn:
//!   1. Build a provider request with the current message history +
//!      tool definitions.
//!   2. Stream the response, accumulating per-tool-call argument
//!      deltas into a buffer keyed by tool-call id. Text deltas are
//!      forwarded to the SSE writer as they arrive. Usage events
//!      pass through unchanged.
//!   3. When the stream closes:
//!      - If the model emitted no tool calls (FinishReason::Stop /
//!        Length / Error), emit StepComplete + Finish and return.
//!      - If it emitted tool calls (FinishReason::ToolUse), dispatch
//!        each through the tools registry, append the assistant's
//!        tool-call message + each tool result to the history, and
//!        re-enter the loop for the next turn.
//!   4. After CHAT_STEP_LIMIT turns, force-finish with
//!      `tool-loop-limit` so a misbehaving model can't burn tokens.

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::Result;
use futures::StreamExt;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::provider::{stream_with_provider, ProviderStreamRequest, ToolSchema};
use super::tools::{registry, ToolHandlerContext};
use super::types::{
    AgentEvent, AgentMessage, FinishReason, ModelSpec, ProviderEvent, ToolCallRequest,
};
use crate::server::AppState;

pub const CHAT_STEP_LIMIT: u32 = 8;

pub struct ChatLoopInput {
    pub state: Arc<AppState>,
    pub provider_id: String,
    pub model: ModelSpec,
    pub system_prompt: String,
    pub tools: Vec<ToolSchema>,
    pub turn_messages: Vec<AgentMessage>,
    pub abort: tokio_util::sync::CancellationToken,
}

pub async fn run_chat_loop(input: ChatLoopInput, events: mpsc::Sender<AgentEvent>) -> Result<()> {
    let mut messages = input.turn_messages;
    let mut step: u32 = 0;
    loop {
        step += 1;
        if step > CHAT_STEP_LIMIT {
            warn!(step, "chat loop hit step limit");
            let _ = events
                .send(AgentEvent::Finish {
                    reason: FinishReason::ToolLoopLimit,
                    error: None,
                })
                .await;
            return Ok(());
        }

        let req = ProviderStreamRequest {
            model: input.model.clone(),
            system: input.system_prompt.clone(),
            messages: messages.clone(),
            tools: input.tools.clone(),
        };
        debug!(step, provider = %input.provider_id, msgs = messages.len(), "issuing provider request");
        let mut stream = stream_with_provider(&input.provider_id, req).await?;

        let mut finish_reason = FinishReason::Stop;
        let mut assistant_text = String::new();
        // Accumulate tool calls. OpenAI streams them incrementally:
        //   ToolCallStart    → id + name + first args slice
        //   ArgumentsDelta   → subsequent args slices
        // We buffer raw strings and parse JSON when the stream ends.
        let mut tool_buf: BTreeMap<String, ToolCallBuf> = BTreeMap::new();
        let mut tool_order: Vec<String> = Vec::new();

        'stream: loop {
            tokio::select! {
                _ = input.abort.cancelled() => {
                    let _ = events.send(AgentEvent::Finish { reason: FinishReason::Cancelled, error: None }).await;
                    return Ok(());
                }
                item = stream.next() => {
                    let Some(item) = item else { break 'stream; };
                    match item? {
                        ProviderEvent::TextDelta(text) => {
                            assistant_text.push_str(&text);
                            if events.send(AgentEvent::TextDelta { text }).await.is_err() {
                                return Ok(());
                            }
                        }
                        ProviderEvent::ToolCallStart { id, name, arguments } => {
                            // OpenAI may emit `arguments` as either the
                            // initial fragment string or a full object on
                            // a single-shot call. We re-serialize to keep
                            // the buffer consistent.
                            let initial = serde_json::to_string(&arguments).unwrap_or_default();
                            tool_buf.insert(
                                id.clone(),
                                ToolCallBuf { name, arguments: initial },
                            );
                            tool_order.push(id);
                        }
                        ProviderEvent::ToolCallArgumentsDelta { id, delta } => {
                            // OpenAI/DeepSeek only send the tool-call `id` on
                            // the opening chunk; subsequent argument-fragment
                            // chunks omit it, so `id` arrives empty here. If it
                            // doesn't match a buffered call, fall back to the
                            // most recently opened one. Without this the
                            // fragments are dropped and tools dispatch with
                            // empty `{}` args (e.g. invoke_skill: missing
                            // required argument `skill_id`).
                            let key = if tool_buf.contains_key(&id) {
                                Some(id)
                            } else {
                                tool_order.last().cloned()
                            };
                            if let Some(buf) = key.and_then(|k| tool_buf.get_mut(&k)) {
                                // First-stream chunks come in as
                                // `{"foo":"ba` style fragments. The
                                // matching ToolCallStart already seeded
                                // an empty `{}` for us; replace on the
                                // first delta arriving for an entry that
                                // looks like the empty placeholder.
                                if buf.arguments == "{}" || buf.arguments == "null" {
                                    buf.arguments.clear();
                                }
                                buf.arguments.push_str(&delta);
                            }
                        }
                        ProviderEvent::Usage { input_tokens, output_tokens } => {
                            let _ = events.send(AgentEvent::Usage { input_tokens, output_tokens }).await;
                        }
                        ProviderEvent::Finish { reason } => {
                            finish_reason = reason;
                        }
                    }
                }
            }
        }

        let _ = events.send(AgentEvent::StepComplete { step }).await;

        // No tool calls → we're done.
        if tool_order.is_empty() {
            let _ = events
                .send(AgentEvent::Finish {
                    reason: finish_reason,
                    error: None,
                })
                .await;
            return Ok(());
        }

        // ── tool-call branch ────────────────────────────────────────
        // Parse buffered tool-call arguments and emit ToolCallStart
        // events with the finalized payloads. (Providers may not
        // emit ToolCallArgumentsDelta at all if they ship the full
        // JSON in the first chunk — the buffer still holds the right
        // serialized payload.)
        let mut tool_call_requests: Vec<ToolCallRequest> = Vec::with_capacity(tool_order.len());
        for id in &tool_order {
            let Some(buf) = tool_buf.get(id) else {
                continue;
            };
            let args_value: serde_json::Value = serde_json::from_str(&buf.arguments)
                .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()));
            let _ = events
                .send(AgentEvent::ToolCallStart {
                    tool_call_id: id.clone(),
                    name: buf.name.clone(),
                    args: args_value.clone(),
                })
                .await;
            tool_call_requests.push(ToolCallRequest {
                id: id.clone(),
                name: buf.name.clone(),
                arguments: args_value,
            });
        }

        // Persist the assistant message that triggered the tool calls
        // so the next provider turn sees the same transcript.
        messages.push(AgentMessage::Assistant {
            content: assistant_text.clone(),
            tool_calls: tool_call_requests.clone(),
        });

        // Dispatch each tool sequentially. Sequential simplifies
        // permission gating (one modal at a time) and matches the
        // Node sidecar's behaviour. The chat loop can re-enter for
        // the next turn after all tools resolve.
        for tc in &tool_call_requests {
            let ctx = ToolHandlerContext {
                state: input.state.clone(),
                events: events.clone(),
                abort: input.abort.clone(),
                tool_call_id: tc.id.clone(),
            };
            let result = registry::dispatch(&ctx, &tc.name, &tc.arguments).await;
            let _ = events
                .send(AgentEvent::ToolCallResult {
                    tool_call_id: tc.id.clone(),
                    name: tc.name.clone(),
                    output: result.output.clone(),
                    is_error: result.is_error,
                })
                .await;
            messages.push(AgentMessage::Tool {
                tool_call_id: tc.id.clone(),
                name: tc.name.clone(),
                content: result.output,
                is_error: result.is_error,
            });
        }
        // Continue to the next loop iteration: the model gets to see
        // the tool results and (usually) emits the final answer.
    }
}

#[derive(Debug)]
struct ToolCallBuf {
    name: String,
    arguments: String,
}
