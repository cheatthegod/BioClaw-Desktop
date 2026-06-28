//! OpenAI-compatible streaming client.
//!
//! Speaks the standard `/v1/chat/completions` SSE protocol (the same
//! one OpenRouter, Together, Anyscale, vLLM, and the BioClaw SaaS
//! desktop endpoint all expose). The bioclaw-proxy provider is a
//! thin wrapper that calls into this with cookie auth instead of
//! bearer auth.
//!
//! Wire format (response):
//!   data: {"id":"...","choices":[{"delta":{"content":"..."}}],"usage":{...}}\n\n
//!   data: [DONE]\n\n

use anyhow::{anyhow, Context, Result};
use futures::stream::TryStreamExt;
use futures::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, COOKIE};
use serde::{Deserialize, Serialize};

use super::{Provider, ProviderStream, ProviderStreamRequest};
use crate::chat::types::{AgentMessage, Auth, FinishReason, ProviderEvent};

/// Unit struct — we build a fresh reqwest client per request. A shared
/// client would be a tiny perf win but `/chat` is bursty and not hot.
pub struct OpenAiCompat;

impl Provider for OpenAiCompat {
    fn id(&self) -> &'static str {
        "openai-compatible"
    }

    async fn stream_messages(&self, req: ProviderStreamRequest) -> Result<ProviderStream> {
        let endpoint = req
            .model
            .endpoint
            .as_deref()
            .ok_or_else(|| anyhow!("openai-compatible requires an endpoint"))?;
        let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));

        let body = build_request_body(&req)?;
        let client = reqwest::Client::builder()
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .build()
            .context("build reqwest client")?;
        let mut builder = client
            .post(&url)
            .header(ACCEPT, "text/event-stream")
            .header("content-type", "application/json");
        builder = match &req.model.auth {
            Auth::Bearer { api_key } => builder.header(AUTHORIZATION, format!("Bearer {api_key}")),
            Auth::Cookie { cookie_name, token } => {
                builder.header(COOKIE, format!("{cookie_name}={token}"))
            }
            Auth::None => builder,
        };
        let resp = builder
            .json(&body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!(
                "upstream {status}: {}",
                truncate_for_log(&text, 512)
            ));
        }

        let byte_stream = resp.bytes_stream().map_err(anyhow::Error::from);
        let lines = sse_line_stream(byte_stream);
        let events = lines.filter_map(|line_or_err| async move {
            match line_or_err {
                Ok(line) => parse_sse_chunk(&line).transpose(),
                Err(e) => Some(Err(e)),
            }
        });
        Ok(events.boxed())
    }
}

// ── request body shaping ────────────────────────────────────────────

#[derive(Serialize)]
struct ChatCompletionRequest<'a> {
    model: &'a str,
    messages: Vec<RequestMessage<'a>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<RequestTool<'a>>,
}

#[derive(Serialize)]
struct RequestMessage<'a> {
    role: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<RequestToolCall<'a>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "tool_call_id")]
    tool_call_id: Option<&'a str>,
}

#[derive(Serialize)]
struct RequestToolCall<'a> {
    id: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    function: RequestToolCallFn<'a>,
}

#[derive(Serialize)]
struct RequestToolCallFn<'a> {
    name: &'a str,
    arguments: String,
}

#[derive(Serialize)]
struct RequestTool<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    function: RequestToolFn<'a>,
}

#[derive(Serialize)]
struct RequestToolFn<'a> {
    name: &'a str,
    description: &'a str,
    parameters: &'a serde_json::Value,
}

fn build_request_body(req: &ProviderStreamRequest) -> Result<serde_json::Value> {
    let mut messages: Vec<RequestMessage<'_>> = Vec::with_capacity(req.messages.len() + 1);
    if !req.system.is_empty() {
        messages.push(RequestMessage {
            role: "system",
            content: Some(req.system.clone()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        });
    }
    for m in &req.messages {
        match m {
            AgentMessage::User { content } => messages.push(RequestMessage {
                role: "user",
                content: Some(content.clone()),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }),
            AgentMessage::Assistant {
                content,
                tool_calls,
            } => messages.push(RequestMessage {
                role: "assistant",
                content: if content.is_empty() {
                    None
                } else {
                    Some(content.clone())
                },
                tool_calls: tool_calls
                    .iter()
                    .map(|tc| RequestToolCall {
                        id: &tc.id,
                        kind: "function",
                        function: RequestToolCallFn {
                            name: &tc.name,
                            arguments: tc.arguments.to_string(),
                        },
                    })
                    .collect(),
                tool_call_id: None,
            }),
            AgentMessage::Tool {
                tool_call_id,
                content,
                ..
            } => messages.push(RequestMessage {
                role: "tool",
                content: Some(content.clone()),
                tool_calls: Vec::new(),
                tool_call_id: Some(tool_call_id),
            }),
        }
    }

    let tools: Vec<RequestTool<'_>> = req
        .tools
        .iter()
        .map(|t| RequestTool {
            kind: "function",
            function: RequestToolFn {
                name: &t.name,
                description: &t.description,
                parameters: &t.schema,
            },
        })
        .collect();

    let body = ChatCompletionRequest {
        model: &req.model.id,
        messages,
        stream: true,
        temperature: req.model.params.temperature,
        top_p: req.model.params.top_p,
        max_tokens: req.model.params.max_output_tokens,
        tools,
    };
    Ok(serde_json::to_value(&body)?)
}

// ── SSE response parsing ────────────────────────────────────────────

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    usage: Option<StreamUsage>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<StreamToolCall>,
}

#[derive(Deserialize)]
struct StreamToolCall {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: StreamToolCallFn,
}

#[derive(Deserialize, Default)]
struct StreamToolCallFn {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct StreamUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
}

fn parse_sse_chunk(line: &str) -> Result<Option<ProviderEvent>> {
    let payload = match line.strip_prefix("data:") {
        Some(p) => p.trim_start(),
        None => return Ok(None),
    };
    if payload == "[DONE]" {
        return Ok(None);
    }
    let chunk: StreamChunk = match serde_json::from_str(payload) {
        Ok(c) => c,
        Err(_) => return Ok(None), // ignore comments / keepalives
    };
    if let Some(u) = chunk.usage {
        return Ok(Some(ProviderEvent::Usage {
            input_tokens: u.prompt_tokens,
            output_tokens: u.completion_tokens,
        }));
    }
    let Some(choice) = chunk.choices.into_iter().next() else {
        return Ok(None);
    };
    if let Some(reason) = choice.finish_reason {
        return Ok(Some(ProviderEvent::Finish {
            reason: map_finish_reason(&reason),
        }));
    }
    if let Some(text) = choice.delta.content {
        if !text.is_empty() {
            return Ok(Some(ProviderEvent::TextDelta(text)));
        }
    }
    if let Some(tc) = choice.delta.tool_calls.into_iter().next() {
        // OpenAI streams tool calls incrementally: first chunk carries
        // `id` + `function.name`, subsequent chunks just `function.arguments`.
        // L.4 doesn't drive tools yet, but we parse the events so L.6
        // gets working surface to consume.
        if let (Some(id), Some(name)) = (tc.id.clone(), tc.function.name) {
            let arguments = serde_json::from_str(tc.function.arguments.as_deref().unwrap_or("{}"))
                .unwrap_or(serde_json::Value::Object(Default::default()));
            return Ok(Some(ProviderEvent::ToolCallStart {
                id,
                name,
                arguments,
            }));
        } else if let Some(delta) = tc.function.arguments {
            let id = tc.id.unwrap_or_default();
            return Ok(Some(ProviderEvent::ToolCallArgumentsDelta { id, delta }));
        }
    }
    Ok(None)
}

fn map_finish_reason(reason: &str) -> FinishReason {
    match reason {
        "stop" => FinishReason::Stop,
        "length" => FinishReason::Length,
        "tool_calls" | "tool_use" => FinishReason::ToolUse,
        _ => FinishReason::Stop,
    }
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

// ── byte-stream → SSE line splitter ─────────────────────────────────

/// Convert a bytes stream into a stream of SSE `data:` lines. The
/// chunked transfer doesn't respect line boundaries, so we accumulate
/// until we see `\n` and emit the buffered line. Empty lines (the
/// `\n\n` event terminator) are dropped — each `data: ...` line is its
/// own self-contained JSON payload in OpenAI's stream protocol.
fn sse_line_stream(
    bytes: impl futures::Stream<Item = Result<bytes::Bytes>> + Send + 'static,
) -> impl futures::Stream<Item = Result<String>> + Send + 'static {
    use futures::StreamExt;
    let state = (bytes.boxed(), Vec::<u8>::new());
    futures::stream::unfold(state, |(mut stream, mut buf)| async move {
        loop {
            while let Some(idx) = buf.iter().position(|b| *b == b'\n') {
                let line = buf.drain(..=idx).collect::<Vec<u8>>();
                let line = String::from_utf8_lossy(&line[..line.len() - 1])
                    .trim_end_matches('\r')
                    .to_string();
                if line.is_empty() {
                    continue;
                }
                return Some((Ok(line), (stream, buf)));
            }
            match stream.next().await {
                Some(Ok(chunk)) => buf.extend_from_slice(&chunk),
                Some(Err(e)) => return Some((Err(e), (stream, buf))),
                None => return None,
            }
        }
    })
}
