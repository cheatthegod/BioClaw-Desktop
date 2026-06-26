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
// Phase-3 scope (this revision): skills become tools.
//   * The skills/ tree shipped as a Tauri bundle resource is loaded once at
//     startup via `BIOCLAW_SKILLS_DIR` (set by the Rust supervisor).
//   * `GET /skills` returns the catalog as JSON for the Skills Center UI.
//   * `POST /chat` injects a single `invoke_skill` meta-tool into every
//     provider call and runs a bounded tool-call loop: forward → if the
//     model emitted tool calls, execute them, append tool results, forward
//     again, until either the model returns no tool calls or we hit the
//     step cap.
//
// Phase-3 explicitly does NOT shell-execute skills — the runner just
// returns the SKILL.md body. The permission UI for real exec lands in
// phase 4.

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
  type ToolDefinition,
} from './providers-bridge.js';
import {
  buildSkillToolDefinition,
  composeSkillsSystemPrompt,
  listSkills,
} from './skills/registry.js';
import { loadSkills } from './skills/loader.js';

const SIDECAR_VERSION = '0.2.0';

/** Hard cap on tool-call rounds per `/chat` request. Mirrors the in-app
 * `SessionRunner`'s 24 steps, but our phase-3 loop is single-tool so we
 * rarely need more than 2-3. The cap exists to bound a misbehaving model. */
const CHAT_STEP_LIMIT = 8;

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
  /** When false, do NOT inject the skills tool (e.g. for plain LLM chat). */
  readonly skillsEnabled?: boolean;
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
  // shipped with OpenRouter; callers can override `provider` to switch.
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
  if (v['skillsEnabled'] !== undefined && typeof v['skillsEnabled'] !== 'boolean')
    return 'skillsEnabled must be a boolean';
  return value as ChatRequestBody;
}

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, version: SIDECAR_VERSION, skills: loadSkills().length }),
);

// Skills catalog for the desktop UI. Returns metadata only — the body lives
// inside the sidecar and is only ever sent to the LLM through the
// `invoke_skill` tool path, not over this endpoint.
app.get('/skills', (c) => {
  const skills = listSkills();
  return c.json({ skills, count: skills.length });
});

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
  const userSystemPrompt = systemMessages.map((m) => m.content).join('\n\n');

  // Build the live turn history. Tool-call/tool-result rounds are appended
  // here as the loop progresses, so the provider sees a full transcript on
  // each iteration.
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

  // Phase-3: register the meta-tool. We keep the registration conditional
  // so a caller can opt out (e.g. for a literal "plain LLM" pipeline that
  // wants no tool definitions in the request).
  const skillsEnabled = body.skillsEnabled !== false;
  const tools: ToolDefinition[] = [];
  if (skillsEnabled && listSkills().length > 0) {
    tools.push(buildSkillToolDefinition());
  }

  // Find the most recent user message — we use that text to rank skills
  // for the system-prompt addendum. We pick the LAST user turn (not first)
  // so multi-turn chats reflect the user's current intent.
  const lastUserText = (() => {
    for (let i = turnMessages.length - 1; i >= 0; i--) {
      const m = turnMessages[i];
      if (m && m.role === 'user') return m.content;
    }
    return '';
  })();
  const skillsPromptAddendum =
    skillsEnabled && tools.length > 0 ? composeSkillsSystemPrompt(lastUserText) : '';
  const systemPrompt = [userSystemPrompt, skillsPromptAddendum]
    .filter((s) => s.length > 0)
    .join('\n\n');

  // SSE response. We forward provider events through a thin envelope so the
  // client doesn't need to know the provider's wire dialect. Event shapes:
  //   event: text-delta         data: {"text":"..."}
  //   event: tool-call-start    data: {"toolCallId":"...","name":"...","args":{...}}
  //   event: tool-call-result   data: {"toolCallId":"...","name":"...","output":"...","isError":bool}
  //   event: usage              data: {"inputTokens":N,"outputTokens":M}
  //   event: step-complete      data: {"step":N}
  //   event: finish             data: {"reason":"stop"|"tool-loop-limit"|"error","error"?:"..."}
  const abortCtrl = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => abortCtrl.abort(), { once: true });

  return stream(
    c,
    async (sse) => {
      sse.onAbort(() => abortCtrl.abort());
      try {
        await runChatLoop({
          provider,
          modelSpec,
          systemPrompt,
          tools,
          turnMessages,
          signal: abortCtrl.signal,
          writeEvent: (ev) => writeSseEvent(sse, ev),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await writeSseEvent(sse, { type: 'finish', reason: 'error', error: msg });
      }
    },
    async (err, sse) => {
      // Hono error hook — best-effort surface the failure as a finish event.
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await writeSseEvent(sse, { type: 'finish', reason: 'error', error: msg });
      } catch {
        // Stream already closed; swallow.
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

/**
 * Event envelope sent over SSE. Superset of `ProviderEvent` — we add the
 * tool-call lifecycle events (`tool-call-start`, `tool-call-result`,
 * `step-complete`) that the in-app `SessionRunner` already emits, so the
 * desktop UI's transcript matches what the cloud transcript looks like.
 */
type SseEvent =
  | ProviderEvent
  | {
      readonly type: 'tool-call-start';
      readonly toolCallId: string;
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: 'tool-call-result';
      readonly toolCallId: string;
      readonly name: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | { readonly type: 'step-complete'; readonly step: number };

async function writeSseEvent(sse: SseWritable, ev: SseEvent): Promise<void> {
  const { type, ...rest } = ev;
  const line = `event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`;
  await sse.write(line);
}

/**
 * Run the bounded tool-call loop. We stream provider events straight through
 * to the SSE writer while accumulating tool calls; once a step finishes
 * with N>0 tool calls, we run them locally, append the results to the
 * transcript, and start another step.
 *
 * We capture provider-side `text-delta` events as they happen and forward
 * them immediately, so the user sees streaming tokens even mid-tool-loop.
 */
interface RunChatLoopArgs {
  readonly provider: ReturnType<typeof getProvider>;
  readonly modelSpec: ModelSpec;
  readonly systemPrompt: string;
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly turnMessages: AgentMessage[];
  readonly signal: AbortSignal;
  readonly writeEvent: (ev: SseEvent) => Promise<void>;
}

async function runChatLoop(args: RunChatLoopArgs): Promise<void> {
  const { provider, modelSpec, systemPrompt, tools, turnMessages, signal, writeEvent } = args;
  const toolIndex = new Map(tools.map((t) => [t.name, t]));

  for (let step = 0; step < CHAT_STEP_LIMIT; step++) {
    if (signal.aborted) {
      await writeEvent({ type: 'finish', reason: 'error', error: 'aborted' });
      return;
    }
    let assistantText = '';
    const pendingToolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];
    let providerFinish: ProviderEvent | null = null;

    const events = provider.streamMessages({
      model: modelSpec,
      system: systemPrompt,
      messages: turnMessages,
      tools,
      signal,
    });

    for await (const ev of events) {
      if (ev.type === 'text-delta') {
        assistantText += ev.text;
        await writeEvent(ev);
        continue;
      }
      if (ev.type === 'tool-call') {
        pendingToolCalls.push({ id: ev.id, name: ev.name, arguments: { ...ev.arguments } });
        continue;
      }
      if (ev.type === 'usage') {
        await writeEvent(ev);
        continue;
      }
      if (ev.type === 'finish') {
        providerFinish = ev;
        break;
      }
    }

    // Append the assistant turn (with any tool calls) to the running
    // transcript so the next iteration sees what the model already produced.
    turnMessages.push({
      role: 'assistant',
      content: assistantText,
      ...(pendingToolCalls.length > 0
        ? {
            toolCalls: pendingToolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
          }
        : {}),
    });
    await writeEvent({ type: 'step-complete', step });

    // No tool calls? We're done — forward the finish event and return.
    if (pendingToolCalls.length === 0) {
      if (providerFinish) await writeEvent(providerFinish);
      else await writeEvent({ type: 'finish', reason: 'stop' });
      return;
    }

    // Execute each tool call in order. The phase-3 `invoke_skill` handler
    // is pure-CPU (read a file), so serial is fine; opencode-style parallel
    // dispatch will matter when we add real shell-exec tools in phase 4.
    for (const tc of pendingToolCalls) {
      await writeEvent({
        type: 'tool-call-start',
        toolCallId: tc.id,
        name: tc.name,
        args: tc.arguments,
      });
      const def = toolIndex.get(tc.name);
      let output: string;
      let isError = false;
      if (!def) {
        output = `Unknown tool: ${tc.name}`;
        isError = true;
      } else {
        try {
          const result = await def.handler(tc.arguments, {
            sessionId: 'sidecar-chat',
            toolCallId: tc.id,
            signal,
          });
          output = result.output;
        } catch (err) {
          output = `Tool ${tc.name} threw: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
      }
      await writeEvent({
        type: 'tool-call-result',
        toolCallId: tc.id,
        name: tc.name,
        output,
        isError,
      });
      turnMessages.push({
        role: 'tool',
        toolCallId: tc.id,
        name: tc.name,
        content: output,
        isError,
      });
    }
    // Loop continues — the next provider call will see the assistant
    // turn + the tool results we just appended.
  }
  // Step cap hit. Surface a deterministic error so the UI doesn't hang.
  await writeEvent({
    type: 'finish',
    reason: 'error',
    error: `tool-call loop exceeded ${CHAT_STEP_LIMIT} steps`,
  });
}

// ---- bootstrap ------------------------------------------------------------

// @hono/node-server's `serve()` calls `server.listen(port=0, hostname, cb)`
// internally; the callback receives the bound `AddressInfo` so we can print
// the chosen port the moment the listener is live. This is the contract the
// Rust supervisor depends on — PORT=NNNN on the first stdout line, READY on
// the second.

// Eagerly load the skills catalog at boot so the first `/health` and
// `/chat` request don't pay the FS-walk cost. Best-effort: if BIOCLAW_SKILLS_DIR
// is unset we log and carry on.
(() => {
  const count = loadSkills().length;
  process.stderr.write(`sidecar: skills loaded (count=${count})\n`);
})();

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
