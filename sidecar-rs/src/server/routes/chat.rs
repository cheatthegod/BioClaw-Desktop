//! `POST /chat` — SSE chat handler.
//!
//! Wire format:
//!   Request:  `application/json` ChatRequestBody (see chat::types)
//!   Response: `text/event-stream` with `AgentEvent`s named after
//!             each variant's `type` field (text-delta, finish, etc.)
//!
//! L.4 ships the no-tools degenerate case — the system prompt and
//! turn history are forwarded to the provider and text deltas + a
//! single finish event are relayed back. Tool dispatch lands in L.6.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::sse::{Event, Sse},
    Json,
};
use futures::stream::Stream;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::chat::{
    runner::{run_chat_loop, ChatLoopInput},
    tools::{registry, system_prompt},
    types::{
        AgentEvent, AgentMessage, Auth, ChatRequestBody, FinishReason, InboundRole, ModelSpec,
    },
};
use crate::server::AppState;

pub async fn post_chat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatRequestBody>,
) -> Result<
    Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>,
    (StatusCode, Json<serde_json::Value>),
> {
    if body.messages.is_empty() {
        return Err(bad_request("messages must not be empty"));
    }
    if body.api_key.is_empty() {
        return Err(bad_request("apiKey is required"));
    }
    if body.model.is_empty() {
        return Err(bad_request("model is required"));
    }

    // Pull system prompts out of the messages array — providers want
    // them as a dedicated field, not interleaved (matches OpenAI +
    // Anthropic conventions).
    let mut system_parts: Vec<String> = Vec::new();
    let mut turn_messages: Vec<AgentMessage> = Vec::new();
    for m in &body.messages {
        match m.role {
            InboundRole::System => system_parts.push(m.content.clone()),
            InboundRole::User => turn_messages.push(AgentMessage::User {
                content: m.content.clone(),
            }),
            InboundRole::Assistant => turn_messages.push(AgentMessage::Assistant {
                content: m.content.clone(),
                tool_calls: Vec::new(),
            }),
        }
    }

    let provider_id = body
        .provider
        .clone()
        .unwrap_or_else(|| "bioclaw-proxy".to_string());

    // Map ChatRequestBody → ModelSpec. Auth kind depends on provider:
    //   bioclaw-proxy / openai-compatible w/ cookieName → Cookie
    //   anything else                                  → Bearer
    let auth = if provider_id == "bioclaw-proxy" {
        Auth::Cookie {
            cookie_name: "bioclaw_session".into(),
            token: body.api_key.clone(),
        }
    } else {
        Auth::Bearer {
            api_key: body.api_key.clone(),
        }
    };
    let model_spec = ModelSpec {
        provider: provider_id.clone(),
        id: body.model.clone(),
        endpoint: body.base_url.clone(),
        auth,
        params: body.params.clone().unwrap_or_default(),
    };

    // Tools + skill-ranked system-prompt addendum. Skipped when the
    // caller opts out via `skillsEnabled: false` or when the catalog
    // is empty.
    let skills_enabled = body.skills_enabled.unwrap_or(true);
    let (tools, system_addendum) = if skills_enabled && !state.skills.is_empty() {
        let last_user = turn_messages
            .iter()
            .rev()
            .find_map(|m| match m {
                AgentMessage::User { content } => Some(content.as_str()),
                _ => None,
            })
            .unwrap_or("");
        (
            registry::build_definitions(),
            system_prompt::compose(&state.skills, last_user),
        )
    } else {
        (Vec::new(), String::new())
    };
    let mut system_prompt_parts: Vec<String> = system_parts;
    if !system_addendum.is_empty() {
        system_prompt_parts.push(system_addendum);
    }

    let abort = CancellationToken::new();
    let abort_for_task = abort.clone();
    let (tx, rx) = mpsc::channel::<AgentEvent>(64);
    let tx_for_watcher = tx.clone();

    let input = ChatLoopInput {
        state: state.clone(),
        provider_id,
        model: model_spec,
        system_prompt: system_prompt_parts.join("\n\n"),
        tools,
        turn_messages,
        abort: abort_for_task,
    };

    tokio::spawn(async move {
        if let Err(e) = run_chat_loop(input, tx.clone()).await {
            warn!("chat loop errored: {e:#}");
            let _ = tx
                .send(AgentEvent::Finish {
                    reason: FinishReason::Error,
                    error: Some(format!("{e:#}")),
                })
                .await;
        }
    });

    // Client disconnect → drop the receiver → tx.closed() resolves
    // → cancel the abort token so the provider request is dropped.
    let abort_watcher = abort.clone();
    tokio::spawn(async move {
        tx_for_watcher.closed().await;
        abort_watcher.cancel();
    });

    Ok(Sse::new(channel_to_sse(rx)))
}

fn bad_request(msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg })))
}

fn channel_to_sse(
    rx: mpsc::Receiver<AgentEvent>,
) -> impl Stream<Item = Result<Event, std::convert::Infallible>> {
    futures::stream::unfold(rx, |mut rx| async move {
        let ev = rx.recv().await?;
        // The `type` discriminator is on the JSON object itself; we
        // ALSO emit it as the SSE event name so the EventSource client
        // can switch on .type without having to JSON.parse first
        // (matches the Node sidecar's wire shape).
        let value = serde_json::to_value(&ev).unwrap_or_else(|_| json!({}));
        let name = value
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("event")
            .to_string();
        let event = Event::default().event(&name).data(value.to_string());
        Some((Ok(event), rx))
    })
}
