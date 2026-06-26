// Adapted from sst/opencode (Apache-2.0). See docs/VENDORED.md for the diff.
//
// Original sources:
//   - packages/opencode/src/provider/provider.ts
//   - packages/opencode/src/session/llm/native-request.ts
//   - packages/opencode/src/session/llm/native-runtime.ts
//
// Opencode wraps Vercel `ai` + per-provider SDKs through an Effect Layer; the
// `native-runtime` path bypasses `ai` and speaks the wire protocol directly.
// We port the *native* path only — it's smaller, has no Effect/Bun deps, and
// is the future-proof one. Three providers in 2026 cover ~all of our traffic:
// OpenAI-compatible (works for OpenAI, OpenRouter, Together, Groq, ...),
// Anthropic Messages, and Ollama.

import type { AgentMessage, ModelSpec, ProviderId, ToolDefinition } from '../agent/types';

/**
 * Normalized stream event coming back from any provider. The session runner
 * consumes this, regardless of which wire format the provider speaks.
 */
export type ProviderEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly id: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'tool-use' | 'length' | 'error'; readonly error?: string };

export interface ProviderStreamRequest {
  readonly model: ModelSpec;
  readonly system: string;
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly signal: AbortSignal;
}

export interface Provider {
  readonly id: ProviderId;
  streamMessages(req: ProviderStreamRequest): AsyncIterable<ProviderEvent>;
}

/**
 * OpenAI-compatible provider. Works for OpenAI itself plus any service that
 * implements `/v1/chat/completions` with SSE streaming (OpenRouter, Together,
 * Groq, Mistral's OpenAI shim, vLLM, etc.). For OpenRouter-specific headers
 * use the `openrouter.ts` wrapper which delegates here.
 */
class OpenAICompatibleProvider implements Provider {
  readonly id: ProviderId;
  constructor(
    private readonly defaultBaseUrl: string = 'https://api.openai.com/v1',
    id: ProviderId = 'openai-compatible',
  ) {
    this.id = id;
  }

  async *streamMessages(req: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    const url = (req.model.endpoint ?? this.defaultBaseUrl).replace(/\/+$/, '') + '/chat/completions';
    const headers = openAiHeaders(req.model);
    const body = openAiBody(req);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      yield {
        type: 'finish',
        reason: 'error',
        error: `HTTP ${res.status} ${res.statusText}: ${await safeReadText(res)}`,
      };
      return;
    }
    yield* parseOpenAiSse(res.body);
  }
}

class AnthropicProvider implements Provider {
  readonly id: ProviderId = 'anthropic';
  private readonly defaultBaseUrl = 'https://api.anthropic.com/v1';

  async *streamMessages(req: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    const url = (req.model.endpoint ?? this.defaultBaseUrl).replace(/\/+$/, '') + '/messages';
    const apiKey = req.model.auth?.apiKey ?? '';
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
      ...(req.model.auth?.headers ?? {}),
    };
    const body = anthropicBody(req);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      yield {
        type: 'finish',
        reason: 'error',
        error: `HTTP ${res.status} ${res.statusText}: ${await safeReadText(res)}`,
      };
      return;
    }
    yield* parseAnthropicSse(res.body);
  }
}

class OllamaProvider implements Provider {
  readonly id: ProviderId = 'ollama';
  private readonly defaultBaseUrl = 'http://127.0.0.1:11434';

  async *streamMessages(req: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    // Ollama exposes an OpenAI-compatible endpoint at /v1; reuse the OpenAI
    // streaming parser to keep the diff small.
    const baseUrl = req.model.endpoint ?? this.defaultBaseUrl;
    const url = baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
    const body = openAiBody(req);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      yield {
        type: 'finish',
        reason: 'error',
        error: `HTTP ${res.status} ${res.statusText}: ${await safeReadText(res)}`,
      };
      return;
    }
    yield* parseOpenAiSse(res.body);
  }
}

const REGISTRY = new Map<ProviderId, Provider>([
  ['openai', new OpenAICompatibleProvider('https://api.openai.com/v1', 'openai')],
  ['openai-compatible', new OpenAICompatibleProvider()],
  ['anthropic', new AnthropicProvider()],
  ['ollama', new OllamaProvider()],
]);

export function getProvider(id: ProviderId): Provider {
  const p = REGISTRY.get(id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

export function registerProvider(provider: Provider): void {
  REGISTRY.set(provider.id, provider);
}

// --- helpers (shared OpenAI/Anthropic wire format) -------------------------

function openAiHeaders(model: ModelSpec): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const auth = model.auth;
  if (auth?.kind === 'bearer' && auth.apiKey) {
    headers['authorization'] = `Bearer ${auth.apiKey}`;
  }
  if (auth?.headers) for (const [k, v] of Object.entries(auth.headers)) headers[k] = v;
  return headers;
}

function openAiBody(req: ProviderStreamRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'system') messages.push({ role: 'system', content: m.content });
    else if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg['tool_calls'] = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      messages.push(msg);
    } else {
      // tool result
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  const body: Record<string, unknown> = {
    model: req.model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.model.params?.temperature !== undefined) body['temperature'] = req.model.params.temperature;
  if (req.model.params?.topP !== undefined) body['top_p'] = req.model.params.topP;
  if (req.model.params?.maxOutputTokens !== undefined) body['max_tokens'] = req.model.params.maxOutputTokens;
  if (req.tools.length > 0) {
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
  }
  return body;
}

function anthropicBody(req: ProviderStreamRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  // Anthropic wants tool results as user-role messages with a tool_result block.
  let buffer: Array<Record<string, unknown>> = [];
  let bufferRole: 'user' | 'assistant' | null = null;
  const flush = () => {
    if (bufferRole && buffer.length > 0) messages.push({ role: bufferRole, content: buffer });
    buffer = [];
    bufferRole = null;
  };
  for (const m of req.messages) {
    if (m.role === 'system') continue; // system goes in the top-level field
    if (m.role === 'user') {
      if (bufferRole !== 'user') flush();
      bufferRole = 'user';
      buffer.push({ type: 'text', text: m.content });
    } else if (m.role === 'assistant') {
      if (bufferRole !== 'assistant') flush();
      bufferRole = 'assistant';
      if (m.content) buffer.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        buffer.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
    } else {
      if (bufferRole !== 'user') flush();
      bufferRole = 'user';
      buffer.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        is_error: m.isError,
      });
    }
  }
  flush();

  const systemText = req.system || req.messages.find((m) => m.role === 'system')?.content;
  const body: Record<string, unknown> = {
    model: req.model.id,
    messages,
    stream: true,
    max_tokens: req.model.params?.maxOutputTokens ?? 4096,
  };
  if (systemText) body['system'] = systemText;
  if (req.model.params?.temperature !== undefined) body['temperature'] = req.model.params.temperature;
  if (req.model.params?.topP !== undefined) body['top_p'] = req.model.params.topP;
  if (req.tools.length > 0) {
    body['tools'] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }));
  }
  return body;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

/**
 * Parse an OpenAI-style SSE stream into ProviderEvents. The format is:
 *   data: {"choices":[{"delta":{"content":"hi"}}]}\n\n
 *   data: [DONE]\n\n
 *
 * Tool calls arrive as `delta.tool_calls[i]` fragments that we accumulate by
 * index until we see `finish_reason`.
 */
async function* parseOpenAiSse(stream: ReadableStream<Uint8Array>): AsyncIterable<ProviderEvent> {
  const toolCalls = new Map<number, { id: string; name: string; argsBuf: string }>();
  let finishReason: ProviderEvent['type'] extends 'finish' ? ProviderEvent : never = {
    type: 'finish',
    reason: 'stop',
  } as never;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of iterSseData(stream)) {
    if (data === '[DONE]') break;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const usage = parsed['usage'] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === 'number') inputTokens = usage.prompt_tokens;
      if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens;
    }
    const choices = parsed['choices'] as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) continue;
    const first = choices[0];
    if (!first) continue;
    const delta = first['delta'] as Record<string, unknown> | undefined;
    if (delta) {
      if (typeof delta['content'] === 'string' && delta['content'].length > 0) {
        yield { type: 'text-delta', text: delta['content'] as string };
      }
      const tcs = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
      if (tcs) {
        for (const tc of tcs) {
          const idx = typeof tc['index'] === 'number' ? (tc['index'] as number) : 0;
          let entry = toolCalls.get(idx);
          if (!entry) {
            entry = { id: '', name: '', argsBuf: '' };
            toolCalls.set(idx, entry);
          }
          if (typeof tc['id'] === 'string') entry.id = tc['id'] as string;
          const fn = tc['function'] as { name?: string; arguments?: string } | undefined;
          if (fn) {
            if (typeof fn.name === 'string') entry.name = fn.name;
            if (typeof fn.arguments === 'string') entry.argsBuf += fn.arguments;
          }
        }
      }
    }
    if (typeof first['finish_reason'] === 'string') {
      const reason = first['finish_reason'] as string;
      finishReason = {
        type: 'finish',
        reason: reason === 'tool_calls' ? 'tool-use' : reason === 'length' ? 'length' : 'stop',
      } as never;
    }
  }

  for (const entry of toolCalls.values()) {
    let args: Record<string, unknown> = {};
    try {
      args = entry.argsBuf ? (JSON.parse(entry.argsBuf) as Record<string, unknown>) : {};
    } catch {
      args = { _raw: entry.argsBuf };
    }
    yield { type: 'tool-call', id: entry.id || entry.name, name: entry.name, arguments: args };
  }
  if (inputTokens || outputTokens) yield { type: 'usage', inputTokens, outputTokens };
  yield finishReason as ProviderEvent;
}

/**
 * Parse Anthropic's streaming format (named SSE events: `message_start`,
 * `content_block_delta`, etc.). We accumulate tool_use blocks across
 * `input_json_delta` chunks the same way opencode does.
 */
async function* parseAnthropicSse(stream: ReadableStream<Uint8Array>): AsyncIterable<ProviderEvent> {
  type ToolBuf = { id: string; name: string; argsBuf: string };
  const toolBlocks = new Map<number, ToolBuf>();
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: 'stop' | 'tool-use' | 'length' | 'error' = 'stop';

  for await (const { event, data } of iterAnthropicSse(stream)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === 'message_start') {
      const msg = parsed['message'] as { usage?: { input_tokens?: number } } | undefined;
      if (msg?.usage?.input_tokens) inputTokens = msg.usage.input_tokens;
    } else if (event === 'content_block_start') {
      const idx = parsed['index'] as number | undefined;
      const block = parsed['content_block'] as Record<string, unknown> | undefined;
      if (typeof idx === 'number' && block && block['type'] === 'tool_use') {
        toolBlocks.set(idx, {
          id: typeof block['id'] === 'string' ? (block['id'] as string) : '',
          name: typeof block['name'] === 'string' ? (block['name'] as string) : '',
          argsBuf: '',
        });
      }
    } else if (event === 'content_block_delta') {
      const idx = parsed['index'] as number | undefined;
      const delta = parsed['delta'] as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        yield { type: 'text-delta', text: delta['text'] as string };
      } else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string' && typeof idx === 'number') {
        const buf = toolBlocks.get(idx);
        if (buf) buf.argsBuf += delta['partial_json'] as string;
      }
    } else if (event === 'message_delta') {
      const delta = parsed['delta'] as { stop_reason?: string } | undefined;
      const usage = parsed['usage'] as { output_tokens?: number } | undefined;
      if (usage?.output_tokens) outputTokens = usage.output_tokens;
      if (delta?.stop_reason === 'tool_use') finishReason = 'tool-use';
      else if (delta?.stop_reason === 'max_tokens') finishReason = 'length';
      else if (delta?.stop_reason) finishReason = 'stop';
    } else if (event === 'message_stop') {
      break;
    } else if (event === 'error') {
      finishReason = 'error';
    }
  }
  for (const buf of toolBlocks.values()) {
    let args: Record<string, unknown> = {};
    try {
      args = buf.argsBuf ? (JSON.parse(buf.argsBuf) as Record<string, unknown>) : {};
    } catch {
      args = { _raw: buf.argsBuf };
    }
    yield { type: 'tool-call', id: buf.id || buf.name, name: buf.name, arguments: args };
  }
  if (inputTokens || outputTokens) yield { type: 'usage', inputTokens, outputTokens };
  yield { type: 'finish', reason: finishReason };
}

/** Stream a ReadableStream as utf-8 lines, yielding the `data:` field. */
async function* iterSseData(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Same as iterSseData but emits the `event:` name too — needed for Anthropic. */
async function* iterAnthropicSse(stream: ReadableStream<Uint8Array>): AsyncIterable<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim();
          else if (trimmed.startsWith('data:')) data += trimmed.slice(5).trim();
        }
        if (data) yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
