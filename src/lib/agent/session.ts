// Adapted from sst/opencode (Apache-2.0). See docs/VENDORED.md for the diff.
//
// Original source: packages/opencode/src/session/llm.ts +
//                  packages/opencode/src/session/processor.ts +
//                  packages/opencode/src/session/retry.ts
//
// What we kept (the *valuable* shape of opencode's SessionRunner):
//   * Durable event log: every tool call is appended to storage BEFORE
//     execution, so a crash mid-tool leaves a replayable trail.
//   * Parallel tool dispatch: when the LLM emits N tool calls in one step,
//     run them with Promise.all and feed the settled batch back in one go.
//   * Step limit + retry: 5xx / rate-limit / network errors retry with
//     exponential backoff. Hard step cap stops runaway loops.
//   * Clean cancel mid-tool: the runner exposes one AbortController; tools
//     are handed `signal` so they can bail. We never throw on cancel — we
//     resolve with `stopReason: 'cancelled'`.
//
// What we dropped: Effect, fibers, the permission system, the snapshot/revert
// infra, todo lists, agents-spawning-agents, OpenTelemetry. Phase 2 may
// reintroduce permissions; the others are out of scope for BioClaw Desktop.

import type {
  AgentEvent,
  AgentMessage,
  AgentResult,
  ModelSpec,
  ToolDefinition,
  ToolHandlerResult,
} from './types';
import type { SessionStorage, SessionRecord } from './storage';
import { getProvider, type Provider, type ProviderEvent } from '../providers';

const DEFAULT_STEP_LIMIT = 24;
const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;

export interface SessionRunnerOptions {
  readonly model: ModelSpec;
  readonly systemPrompt: string;
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly onEvent: (ev: AgentEvent) => void;
  readonly storage: SessionStorage;
  /** Override the default 24-step cap. */
  readonly stepLimit?: number;
  /** Override the default 3-retry cap on transient errors. */
  readonly retryLimit?: number;
  /** Inject a provider instance for tests; otherwise resolved by model.provider. */
  readonly provider?: Provider;
  /**
   * Optional session id. If omitted, `run()` generates one. Pass an explicit
   * id when you want the URL or tab title to lead the runner.
   */
  readonly sessionId?: string;
}

export class SessionRunner {
  private readonly opts: SessionRunnerOptions;
  private readonly toolIndex: Map<string, ToolDefinition>;
  private readonly abortCtrl = new AbortController();
  private cancelled = false;

  constructor(opts: SessionRunnerOptions) {
    this.opts = opts;
    this.toolIndex = new Map(opts.tools.map((t) => [t.name, t]));
  }

  /** Start a fresh session with the given user message. */
  async run(userMessage: string): Promise<AgentResult> {
    const sessionId = this.opts.sessionId ?? newSessionId();
    const now = Date.now();
    const initialRecord: SessionRecord = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [
        { role: 'system', content: this.opts.systemPrompt },
        { role: 'user', content: userMessage },
      ],
      events: [],
      status: 'running',
      metadata: { provider: this.opts.model.provider, model: this.opts.model.id },
    };
    await this.opts.storage.create(initialRecord);
    return this.loop(sessionId, initialRecord.messages.slice());
  }

  /**
   * Resume an existing session. Loads its message history from storage and
   * runs another step. The caller is responsible for having appended any
   * new user message before calling resume.
   */
  async resume(sessionId: string): Promise<AgentResult> {
    const record = await this.opts.storage.load(sessionId);
    if (!record) throw new Error(`Session ${sessionId} not found`);
    await this.opts.storage.setStatus(sessionId, 'running');
    return this.loop(sessionId, record.messages.slice());
  }

  /** Trigger cancellation mid-run. Resolves the in-flight `run()`/`resume()`. */
  cancel(): void {
    this.cancelled = true;
    this.abortCtrl.abort();
  }

  // ---- internals -----------------------------------------------------------

  private async loop(sessionId: string, history: AgentMessage[]): Promise<AgentResult> {
    const stepLimit = this.opts.stepLimit ?? DEFAULT_STEP_LIMIT;
    const provider = this.opts.provider ?? getProvider(this.opts.model.provider);
    let finalText = '';
    let totalIn = 0;
    let totalOut = 0;

    for (let step = 0; step < stepLimit; step++) {
      if (this.cancelled)
        return this.finalize(sessionId, finalText, step, totalIn, totalOut, 'cancelled');

      const stepResult = await this.runOneStep(sessionId, provider, history);
      if (stepResult.kind === 'cancelled') {
        return this.finalize(sessionId, finalText, step, totalIn, totalOut, 'cancelled');
      }
      if (stepResult.kind === 'error') {
        await this.emit(sessionId, { type: 'error', error: stepResult.error });
        return this.finalize(sessionId, finalText, step, totalIn, totalOut, 'error');
      }

      finalText = stepResult.assistantText || finalText;
      totalIn += stepResult.inputTokens;
      totalOut += stepResult.outputTokens;

      history.push({
        role: 'assistant',
        content: stepResult.assistantText,
        ...(stepResult.toolCalls.length > 0
          ? {
              toolCalls: stepResult.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              })),
            }
          : {}),
      });
      const lastMessage = history[history.length - 1];
      if (!lastMessage) {
        throw new Error(
          'SessionRunner invariant: history must contain at least one message after step',
        );
      }
      await this.opts.storage.appendMessage(sessionId, lastMessage);

      await this.emit(sessionId, { type: 'step-complete', step });

      // No tool calls => we're done.
      if (stepResult.toolCalls.length === 0) {
        return this.finalize(sessionId, finalText, step + 1, totalIn, totalOut, 'stop');
      }

      // Dispatch all tool calls in parallel (opencode's invariant). Each tool
      // gets its own event row written to storage BEFORE we execute, so a
      // crash mid-tool leaves a replayable trail.
      const toolResults = await Promise.all(
        stepResult.toolCalls.map((tc) => this.executeTool(sessionId, tc)),
      );
      for (const tr of toolResults) {
        const msg: AgentMessage = {
          role: 'tool',
          toolCallId: tr.toolCallId,
          name: tr.name,
          content: tr.result.output,
          isError: tr.isError,
        };
        history.push(msg);
        await this.opts.storage.appendMessage(sessionId, msg);
      }

      if (this.cancelled) {
        return this.finalize(sessionId, finalText, step + 1, totalIn, totalOut, 'cancelled');
      }
    }

    await this.emit(sessionId, { type: 'done', reason: 'tool-loop-limit' });
    await this.opts.storage.setStatus(sessionId, 'done');
    return {
      sessionId,
      finalText,
      steps: stepLimit,
      tokensIn: totalIn,
      tokensOut: totalOut,
      stopReason: 'tool-loop-limit',
    };
  }

  private async runOneStep(
    sessionId: string,
    provider: Provider,
    history: ReadonlyArray<AgentMessage>,
  ): Promise<OneStepResult> {
    const retryLimit = this.opts.retryLimit ?? DEFAULT_RETRY_LIMIT;
    let attempt = 0;
    for (;;) {
      try {
        return await this.streamOnce(sessionId, provider, history);
      } catch (err) {
        if (this.cancelled) return { kind: 'cancelled' };
        if (!isTransientError(err) || attempt >= retryLimit) {
          return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
        }
        await sleep(DEFAULT_BASE_BACKOFF_MS * Math.pow(2, attempt), this.abortCtrl.signal);
        attempt++;
      }
    }
  }

  private async streamOnce(
    sessionId: string,
    provider: Provider,
    history: ReadonlyArray<AgentMessage>,
  ): Promise<OneStepResult> {
    let assistantText = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = provider.streamMessages({
      model: this.opts.model,
      system: this.opts.systemPrompt,
      messages: history,
      tools: this.opts.tools,
      signal: this.abortCtrl.signal,
    });

    for await (const ev of stream) {
      if (this.cancelled) return { kind: 'cancelled' };
      await this.handleProviderEvent(
        sessionId,
        ev,
        (text) => {
          assistantText += text;
        },
        (tc) => {
          toolCalls.push(tc);
        },
        (usage) => {
          inputTokens = usage.inputTokens;
          outputTokens = usage.outputTokens;
        },
      );
      if (ev.type === 'finish') {
        if (ev.reason === 'error') {
          throw new Error(ev.error ?? 'Provider stream finished with error');
        }
        break;
      }
    }

    return { kind: 'ok', assistantText, toolCalls, inputTokens, outputTokens };
  }

  private async handleProviderEvent(
    sessionId: string,
    ev: ProviderEvent,
    onText: (t: string) => void,
    onToolCall: (tc: { id: string; name: string; arguments: Record<string, unknown> }) => void,
    onUsage: (u: { inputTokens: number; outputTokens: number }) => void,
  ): Promise<void> {
    switch (ev.type) {
      case 'text-delta':
        onText(ev.text);
        await this.emit(sessionId, { type: 'text-delta', text: ev.text });
        return;
      case 'tool-call':
        onToolCall({ id: ev.id, name: ev.name, arguments: { ...ev.arguments } });
        return;
      case 'usage':
        onUsage({ inputTokens: ev.inputTokens, outputTokens: ev.outputTokens });
        await this.emit(sessionId, {
          type: 'usage',
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
        });
        return;
      case 'finish':
        return;
    }
  }

  private async executeTool(
    sessionId: string,
    tc: { id: string; name: string; arguments: Record<string, unknown> },
  ): Promise<{ toolCallId: string; name: string; result: ToolHandlerResult; isError: boolean }> {
    // Durable replay: write the start event BEFORE executing. If we crash now
    // the next boot can show the user "tool X was in flight" instead of just
    // showing nothing.
    await this.emit(sessionId, {
      type: 'tool-call-start',
      toolCallId: tc.id,
      name: tc.name,
      args: tc.arguments,
    });
    const def = this.toolIndex.get(tc.name);
    if (!def) {
      const result: ToolHandlerResult = { output: `Unknown tool: ${tc.name}` };
      await this.emit(sessionId, {
        type: 'tool-call-result',
        toolCallId: tc.id,
        name: tc.name,
        result,
        isError: true,
      });
      return { toolCallId: tc.id, name: tc.name, result, isError: true };
    }
    try {
      const result = await def.handler(tc.arguments, {
        sessionId,
        toolCallId: tc.id,
        signal: this.abortCtrl.signal,
      });
      await this.emit(sessionId, {
        type: 'tool-call-result',
        toolCallId: tc.id,
        name: tc.name,
        result,
        isError: false,
      });
      return { toolCallId: tc.id, name: tc.name, result, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: ToolHandlerResult = { output: `Tool ${tc.name} threw: ${message}` };
      await this.emit(sessionId, {
        type: 'tool-call-result',
        toolCallId: tc.id,
        name: tc.name,
        result,
        isError: true,
      });
      return { toolCallId: tc.id, name: tc.name, result, isError: true };
    }
  }

  private async emit(sessionId: string, ev: AgentEvent): Promise<void> {
    // Storage first, listener second — durable-replay invariant. Listener
    // errors are swallowed so a bad UI handler can't poison the session.
    await this.opts.storage.appendEvent(sessionId, ev);
    try {
      this.opts.onEvent(ev);
    } catch {
      // ignore
    }
  }

  private async finalize(
    sessionId: string,
    finalText: string,
    steps: number,
    tokensIn: number,
    tokensOut: number,
    stopReason: AgentResult['stopReason'],
  ): Promise<AgentResult> {
    await this.emit(sessionId, {
      type: 'done',
      reason: stopReason === 'error' ? 'stop' : stopReason,
    });
    await this.opts.storage.setStatus(
      sessionId,
      stopReason === 'cancelled' ? 'cancelled' : stopReason === 'error' ? 'error' : 'done',
    );
    return { sessionId, finalText, steps, tokensIn, tokensOut, stopReason };
  }
}

// ---- helpers --------------------------------------------------------------

type OneStepResult =
  | {
      kind: 'ok';
      assistantText: string;
      toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
      inputTokens: number;
      outputTokens: number;
    }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: string };

function newSessionId(): string {
  // Lightweight ULID-ish id; no deps. Tauri runs in WebView where crypto exists.
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `ses_${Date.now().toString(36)}_${random}`;
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (msg.includes('aborted') || msg.includes('abort')) return false; // user cancel — don't retry
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up'))
    return true;
  if (msg.includes('rate limit') || msg.includes('429')) return true;
  if (/\b5\d\d\b/.test(msg)) return true;
  if (msg.includes('fetch failed')) return true;
  return false;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
