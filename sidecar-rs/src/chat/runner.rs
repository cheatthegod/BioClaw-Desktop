//! Bounded chat loop. L.4 implements the no-tools degenerate case:
//! one turn, forward to the provider, relay text-deltas and finish.
//! L.6 layers tool dispatch on top by extending the loop with a
//! "if finish.reason == tool-use, execute tools, append messages,
//! re-enter loop" branch.

use anyhow::Result;
use futures::StreamExt;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::provider::{stream_with_provider, ProviderStreamRequest, ToolSchema};
use super::types::{AgentEvent, AgentMessage, FinishReason, ModelSpec, ProviderEvent};

/// Hard cap on tool-call rounds. Bounds a misbehaving model; same
/// value the Node sidecar uses (`CHAT_STEP_LIMIT = 8`).
pub const CHAT_STEP_LIMIT: u32 = 8;

pub struct ChatLoopInput {
    pub provider_id: String,
    pub model: ModelSpec,
    pub system_prompt: String,
    pub tools: Vec<ToolSchema>,
    pub turn_messages: Vec<AgentMessage>,
    pub abort: tokio_util::sync::CancellationToken,
}

/// Drive the chat loop. Emits `AgentEvent`s to the provided sender —
/// the route handler forwards them as SSE.
pub async fn run_chat_loop(input: ChatLoopInput, events: mpsc::Sender<AgentEvent>) -> Result<()> {
    // The loop is shaped to grow into a multi-step tool-driven
    // pipeline in L.6 — for now it terminates after the first turn
    // because there are no tools to execute and append. Marked
    // `#[allow(clippy::never_loop)]` because the loop body short-
    // circuits via `return Ok(())` for now; L.6 will replace the
    // last block with a `continue` when tools are present.
    let messages = input.turn_messages;
    let mut step: u32 = 0;
    #[allow(clippy::never_loop)]
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
        debug!(step, provider = %input.provider_id, "issuing provider request");
        let mut stream = stream_with_provider(&input.provider_id, req).await?;

        let mut finish_reason = FinishReason::Stop;

        loop {
            tokio::select! {
                _ = input.abort.cancelled() => {
                    let _ = events.send(AgentEvent::Finish { reason: FinishReason::Cancelled, error: None }).await;
                    return Ok(());
                }
                item = stream.next() => {
                    let Some(item) = item else { break; };
                    match item? {
                        ProviderEvent::TextDelta(text) => {
                            if events.send(AgentEvent::TextDelta { text }).await.is_err() {
                                return Ok(());
                            }
                        }
                        ProviderEvent::ToolCallStart { id, name, arguments } => {
                            let _ = events.send(AgentEvent::ToolCallStart {
                                tool_call_id: id,
                                name,
                                args: arguments,
                            }).await;
                        }
                        ProviderEvent::ToolCallArgumentsDelta { .. } => {
                            // L.4 doesn't surface mid-tool-call delta events
                            // to the frontend — it only renders the final
                            // call once it's complete. L.6 will reassemble
                            // them when dispatching the tool.
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
        let _ = events
            .send(AgentEvent::Finish {
                reason: finish_reason,
                error: None,
            })
            .await;
        return Ok(());
    }
}
