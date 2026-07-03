/**
 * Thin async-generator wrapper around the local sidecar's `/chat` SSE
 * endpoint. The sidecar (a Rust subprocess started by Tauri) proxies the
 * actual LLM call to OpenRouter / Anthropic; the React side never touches
 * provider APIs directly.
 *
 * Wire shape (matches the sidecar agent's spec):
 *   POST http://127.0.0.1:{port}/chat
 *     body: { messages, apiKey, model, baseUrl? }
 *     resp: text/event-stream — `data: <AgentEvent JSON>\n\n` lines
 *           plus a final `data: [DONE]\n\n` (we tolerate its absence).
 *
 * The yielded events match `AgentEvent` in `src/lib/agent/types.ts` exactly,
 * so the chat UI can reuse the same discriminator it would use for an
 * in-process SessionRunner.
 */
import { fetch } from '@tauri-apps/plugin-http'; // native fetch: bypasses webview CSP for local sidecar
import type { AgentEvent } from './agent/types';

/** Message shape accepted by the sidecar — flat role/content pairs only. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface StreamChatParams {
  readonly port: number;
  /**
   * For provider=bioclaw-proxy this is the session TOKEN (the value of
   * the bioclaw_session cookie), not an OpenRouter API key. Either way
   * we forward it verbatim as the `apiKey` body field; the sidecar
   * picks the right auth scheme based on `provider`.
   */
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly provider?: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly signal?: AbortSignal;
}

const SIDECAR_HOST = '127.0.0.1';
const SERVER_5XX_RETRY_DELAY_MS = 500;

/**
 * Stream chat completions from the local sidecar. One retry on 5xx after
 * 500ms; 4xx and aborts propagate immediately.
 */
export async function* streamChat(params: StreamChatParams): AsyncIterable<AgentEvent> {
  const url = `http://${SIDECAR_HOST}:${params.port}/chat`;
  const body = JSON.stringify({
    messages: params.messages,
    apiKey: params.apiKey,
    model: params.model,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.provider ? { provider: params.provider } : {}),
  });

  let res: Response;
  let attempt = 0;
  for (;;) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (err) {
      if (params.signal?.aborted) throw err;
      // Connection drop / DNS / refused. No retry — the sidecar is local and
      // either up or not. Caller surfaces this via the sidecar status hook.
      throw new Error(`Cannot reach sidecar at ${url}: ${errMsg(err)}`);
    }

    if (res.ok) break;

    // 4xx: read body, give up.
    if (res.status >= 400 && res.status < 500) {
      const text = await safeReadText(res);
      throw new Error(`Sidecar rejected request (${res.status}): ${text}`);
    }

    // 5xx: one retry after a short delay.
    if (attempt === 0) {
      attempt++;
      await sleep(SERVER_5XX_RETRY_DELAY_MS, params.signal);
      continue;
    }
    const text = await safeReadText(res);
    throw new Error(`Sidecar server error (${res.status}) after retry: ${text}`);
  }

  if (!res.body) {
    throw new Error('Sidecar returned an empty body — expected SSE stream');
  }

  yield* parseSseStream(res.body);
}

/** Parse `data: <json>\n\n` lines. `[DONE]` terminates; other lines are ignored. */
async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush any tail event (server may forget the trailing blank line).
        const tail = drainTail(buf);
        if (tail) {
          const ev = parseDataLine(tail);
          if (ev && ev !== DONE) yield ev;
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseDataLine(chunk);
        if (ev === DONE) return;
        if (ev) yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const DONE = Symbol('sse-done');

function parseDataLine(chunk: string): AgentEvent | typeof DONE | null {
  // An SSE event can carry multiple `data:` lines; concatenate per spec.
  let data = '';
  for (const line of chunk.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('data:')) data += trimmed.slice(5).trim();
  }
  if (!data) return null;
  if (data === '[DONE]') return DONE;
  try {
    return JSON.parse(data) as AgentEvent;
  } catch {
    // A malformed data line shouldn't kill the whole stream — skip it.
    return null;
  }
}

function drainTail(buf: string): string | null {
  const trimmed = buf.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
