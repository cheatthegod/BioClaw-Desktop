// BioClaw sidecar — local HTTP server spawned by Tauri.
//
// Process model:
//   * Tauri's Rust side spawns this binary via tauri-plugin-shell.
//   * We bind Hono on 127.0.0.1 with port=0 (kernel picks free port).
//   * We print `PORT=NNNN\n` on stdout, then `READY\n` once the listener is
//     attached. The Rust side reads stdout line-by-line until it sees `READY`,
//     captures the port, then health-checks `GET /health`.
//   * Lifetime: process exits cleanly on `POST /shutdown`, or when its parent
//     dies (we install a SIGTERM/SIGINT handler).
//
// Phase-2 minimum scope: chat + SSE streaming. NO tools, NO MCP, NO skills.
// The SessionRunner exists in the bundle (via providers-bridge) but for
// phase-2 chat we call the provider directly — SessionRunner's run() takes a
// single user message string and assumes a fresh session, which doesn't
// match the "stateless POST /chat with full history" UX. The runner stays
// available for phase-3 when we add tools.

import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { serve } from '@hono/node-server';
import process from 'node:process';

import {
  getProvider,
  type AgentMessage,
  type ModelSpec,
  type ProviderEvent,
  type ProviderId,
} from './providers-bridge.js';

const SIDECAR_VERSION = '0.1.0';

interface ChatRequestBody {
  readonly messages: ReadonlyArray<{
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
  }>;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /** Optional override; defaults to `openrouter`. */
  readonly provider?: ProviderId;
  /** Optional temperature/topP/maxTokens. */
  readonly params?: {
    readonly temperature?: number;
    readonly topP?: number;
    readonly maxOutputTokens?: number;
  };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildModelSpec(body: ChatRequestBody): ModelSpec {
  const providerId: ProviderId = body.provider ?? 'openrouter';
  // OpenRouter + OpenAI-compatible both use bearer auth. Anthropic uses
  // x-api-key. Ollama uses no auth. We default to bearer because phase-2
  // ships with OpenRouter; callers can override `provider` to switch.
  const authKind = providerId === 'anthropic' ? 'anthropic' : providerId === 'ollama' ? 'none' : 'bearer';
  return {
    provider: providerId,
    id: body.model,
    ...(body.baseUrl ? { endpoint: body.baseUrl } : {}),
    auth: { kind: authKind, apiKey: body.apiKey },
    ...(body.params ? { params: body.params } : {}),
  };
}

function validateChatBody(value: unknown): ChatRequestBody | string {
  if (typeof value !== 'object' || value === null) return 'body must be an object';
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['messages'])) return 'messages must be an array';
  if (v['messages'].length === 0) return 'messages must not be empty';
  for (const m of v['messages']) {
    if (typeof m !== 'object' || m === null) return 'each message must be an object';
    const mm = m as Record<string, unknown>;
    if (mm['role'] !== 'system' && mm['role'] !== 'user' && mm['role'] !== 'assistant') {
      return `invalid role: ${String(mm['role'])}`;
    }
    if (typeof mm['content'] !== 'string') return 'message.content must be a string';
  }
  if (typeof v['apiKey'] !== 'string' || v['apiKey'].length === 0) return 'apiKey is required';
  if (typeof v['model'] !== 'string' || v['model'].length === 0) return 'model is required';
  if (v['baseUrl'] !== undefined && typeof v['baseUrl'] !== 'string') return 'baseUrl must be a string';
  if (v['provider'] !== undefined && typeof v['provider'] !== 'string') return 'provider must be a string';
  return value as ChatRequestBody;
}

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, version: SIDECAR_VERSION }));

app.post('/chat', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return jsonError(400, 'invalid JSON body');
  }
  const parsed = validateChatBody(raw);
  if (typeof parsed === 'string') return jsonError(400, parsed);
  const body = parsed;

  const modelSpec = buildModelSpec(body);
  // Split system prompt out of the messages array — providers want it as a
  // dedicated top-level field, not interleaved (matches OpenAI + Anthropic
  // conventions and the SessionRunner contract).
  const systemMessages = body.messages.filter((m) => m.role === 'system');
  const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');
  const turnMessages: AgentMessage[] = body.messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'user') return { role: 'user', content: m.content };
      return { role: 'assistant', content: m.content };
    });

  let provider;
  try {
    provider = getProvider(modelSpec.provider);
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : String(err));
  }

  // SSE response. We forward provider events through a thin envelope so the
  // client doesn't need to know the provider's wire dialect. Event shapes:
  //   event: text-delta   data: {"text":"..."}
  //   event: usage        data: {"inputTokens":N,"outputTokens":M}
  //   event: finish       data: {"reason":"stop"|"error","error"?:"..."}
  const abortCtrl = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => abortCtrl.abort(), { once: true });

  return stream(
    c,
    async (sse) => {
      // Manually format SSE; hono/streaming doesn't pin an event format.
      sse.onAbort(() => abortCtrl.abort());
      try {
        const events = provider.streamMessages({
          model: modelSpec,
          system: systemPrompt,
          messages: turnMessages,
          tools: [],
          signal: abortCtrl.signal,
        });
        for await (const ev of events) {
          await writeSseEvent(sse, ev);
          if (ev.type === 'finish') break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await writeSseEvent(sse, { type: 'finish', reason: 'error', error: msg });
      }
    },
    async (err, sse) => {
      // hono error hook — best-effort surface the failure as a finish event.
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await writeSseEvent(sse, { type: 'finish', reason: 'error', error: msg });
      } catch {
        // stream already closed; swallow.
      }
    },
  );
});

app.post('/shutdown', (c) => {
  // Schedule exit after the response flushes so curl/clients see 200.
  setTimeout(() => process.exit(0), 50);
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
  const msg = err instanceof Error ? err.message : String(err);
  return c.json({ error: msg }, 500);
});

interface SseWritable {
  write(chunk: string): Promise<unknown>;
}

async function writeSseEvent(sse: SseWritable, ev: ProviderEvent): Promise<void> {
  // SSE wire format: `event: <name>\ndata: <json>\n\n`. We keep `event` for
  // typing and put the rest of the payload in `data`.
  const { type, ...rest } = ev;
  const line = `event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`;
  await sse.write(line);
}

// ---- bootstrap ------------------------------------------------------------

// @hono/node-server's `serve()` calls `server.listen(port=0, hostname, cb)`
// internally; the callback receives the bound `AddressInfo` so we can print
// the chosen port the moment the listener is live. This is the contract the
// Rust supervisor depends on — PORT=NNNN on the first stdout line, READY on
// the second.

const httpServer = serve(
  { fetch: app.fetch, port: 0, hostname: '127.0.0.1' },
  (info) => {
    if (!info || typeof info === 'string') {
      process.stderr.write('sidecar: failed to read bound port\n');
      process.exit(2);
      return;
    }
    // CRITICAL: this exact prefix is parsed by src-tauri/src/sidecar.rs.
    // Do NOT change the format without updating the supervisor.
    process.stdout.write(`PORT=${info.port}\n`);
    process.stdout.write('READY\n');
  },
);

httpServer.on('error', (err: Error) => {
  process.stderr.write(`sidecar: server error: ${err.message}\n`);
  process.exit(3);
});

const shutdown = (sig: string) => {
  process.stderr.write(`sidecar: received ${sig}, shutting down\n`);
  httpServer.close(() => process.exit(0));
  // Hard exit if close hangs.
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

// If the parent dies and we become orphaned, exit. Node doesn't expose this
// directly on Linux; the heuristic is: if stdin closes unexpectedly, the
// parent went away. Tauri keeps stdin open while the sidecar should run.
process.stdin.on('end', () => shutdown('STDIN_CLOSED'));
process.stdin.on('close', () => shutdown('STDIN_CLOSED'));
process.stdin.resume();
