// Adapted from sst/opencode (Apache-2.0). See docs/VENDORED.md for the diff.
//
// Original sources:
//   - packages/opencode/src/session/message-v2.ts (event shape)
//   - packages/opencode/src/session/llm.ts        (stream input shape)
//   - packages/opencode/src/tool/                 (tool definition shape)
//   - packages/opencode/src/provider/provider.ts  (model spec shape)
//
// Effect's `Schema.Struct` boilerplate has been replaced with plain TS
// interfaces / discriminated unions. The semantic shape is preserved.

import type { JsonSchemaObject } from '../mcp/types';

/**
 * A pointer to a specific LLM. `endpoint` is optional — providers that have a
 * canonical URL (Anthropic, Ollama on `localhost:11434`) leave it empty and
 * the provider implementation fills in the default.
 *
 * `authKind` lets us be explicit about the credential format. OpenAI-style
 * `Bearer <key>`, Anthropic-style `x-api-key`, and "no auth" (Ollama) all
 * exist in the wild; we model that here rather than baking it into each
 * provider.
 */
export interface ModelSpec {
  readonly provider: ProviderId;
  /** The model id sent in the request body (e.g. `claude-opus-4.5`). */
  readonly id: string;
  readonly endpoint?: string;
  readonly auth?: {
    readonly kind: 'bearer' | 'anthropic' | 'none' | 'cookie';
    /** For bearer/anthropic: the API key. For cookie: the session token. */
    readonly apiKey?: string;
    /**
     * For cookie auth: the cookie name to set. Defaults to
     * `bioclaw_session` if omitted. Ignored for other kinds.
     */
    readonly cookieName?: string;
    /** Extra headers (OpenRouter's `HTTP-Referer` etc.). */
    readonly headers?: Readonly<Record<string, string>>;
  };
  /** Tuning knobs. Mirrors opencode's `prepared.params`. */
  readonly params?: {
    readonly temperature?: number;
    readonly topP?: number;
    readonly maxOutputTokens?: number;
  };
}

export type ProviderId = 'openai' | 'openrouter' | 'anthropic' | 'ollama' | 'openai-compatible' | 'bioclaw-proxy';

/**
 * A tool the agent can call. Two flavours:
 *  - `local`: a TypeScript handler we run in-process.
 *  - `mcp`:   delegated to an MCP server (the handler closes over the McpClient).
 *
 * The discriminator is implicit in `kind`; `handler` always takes parsed JSON
 * args and returns either a string or a structured result. Opencode's tool
 * registry has the same return shape via `result.output | result.metadata`.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: JsonSchemaObject;
  readonly kind: 'local' | 'mcp';
  readonly handler: (
    args: Readonly<Record<string, unknown>>,
    ctx: ToolHandlerContext,
  ) => Promise<ToolHandlerResult>;
}

export interface ToolHandlerContext {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
}

export type ToolHandlerResult = {
  readonly output: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Events emitted during a single `SessionRunner.run()`. The runner's caller
 * subscribes via `onEvent`; persisted sessions can later be replayed by
 * pushing the stored events through the same handler.
 *
 * Discriminator: `type`. Opencode emits a richer set (snapshots, todo updates,
 * permission asks); we only need the streaming primitives in phase 2.
 */
export type AgentEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'tool-call-start'; readonly toolCallId: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> }
  | { readonly type: 'tool-call-result'; readonly toolCallId: string; readonly name: string; readonly result: ToolHandlerResult; readonly isError: boolean; readonly output?: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'step-complete'; readonly step: number }
  | { readonly type: 'done'; readonly reason: 'stop' | 'tool-loop-limit' | 'cancelled' }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'tool-use' | 'length' | 'error' | 'tool-loop-limit' | 'cancelled'; readonly error?: string }
  | { readonly type: 'permission-needed'; readonly requestId: string; readonly skillId: string; readonly script: string; readonly interpreter: string; readonly args: readonly string[] }
  | { readonly type: 'error'; readonly error: string };

/** Final value returned from `run()` / `resume()`. */
export interface AgentResult {
  readonly sessionId: string;
  readonly finalText: string;
  readonly steps: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly stopReason: 'stop' | 'tool-loop-limit' | 'cancelled' | 'error';
}

/**
 * Chat-style message persisted between steps. Tool results live as their own
 * message so providers that wire tool results through dedicated message roles
 * (Anthropic) can map them cleanly.
 */
export type AgentMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly arguments: Readonly<Record<string, unknown>>;
      }>;
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
      readonly isError: boolean;
    };
