/**
 * Phase-2 chat-session state. One session at a time, no history persistence
 * across reloads (that lives in `lib/agent/storage.ts` and is wired in
 * phase 3). We keep this as a Zustand store rather than a per-component hook
 * so the cancel button in the composer and the message list in the body of
 * <LocalChat> can both reach it without prop drilling.
 *
 * State shape:
 *   - `messages`: the committed transcript (user + completed assistant turns)
 *   - `streaming`: the in-flight assistant turn (null when not streaming).
 *     Held outside `messages` so we can blow away its partial text on cancel
 *     without splicing arrays.
 *   - `status`: rough state machine — 'idle' / 'streaming' / 'error'
 *
 * Cancellation semantics: `cancel()` aborts the local fetch *and* commits
 * whatever partial assistant text we've already streamed into `messages` —
 * the user sees their half-finished answer rather than it vanishing. This
 * mirrors how ChatGPT, Claude.ai and most chat UIs behave on stop.
 */
import { fetch } from '@tauri-apps/plugin-http'; // native fetch: bypasses webview CSP for local sidecar
import { create } from 'zustand';
import { streamChat, type ChatMessage } from './chat-stream';
import { usePermissionStore } from './permission-state';

export type ChatStatus = 'idle' | 'streaming' | 'error';

export interface PendingPermission {
  readonly requestId: string;
  readonly skillId: string;
  readonly script: string;
  readonly interpreter: string;
  readonly args: readonly string[];
  readonly port: number;
}

export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result?: string;
  readonly isError?: boolean;
}

export interface UserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly content: string;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: 'assistant';
  content: string;
  toolCalls?: ChatToolCall[];
  isCancelled?: boolean;
  isError?: boolean;
}

export interface SystemMessage {
  readonly id: string;
  readonly role: 'system';
  readonly content: string;
}

export type ChatMessageView = UserMessage | AssistantMessage | SystemMessage;

interface SendParams {
  readonly port: number;
  /** Session token (bioclaw-proxy) or API key (legacy BYO key). */
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  /** Defaults to 'bioclaw-proxy' if omitted. */
  readonly provider?: string;
}

interface ChatState {
  messages: ChatMessageView[];
  streaming: AssistantMessage | null;
  status: ChatStatus;
  errorText: string | null;
  pendingPermission: PendingPermission | null;
  /**
   * SaaS thread id (chat_jid) this desktop conversation mirrors to. null until
   * the first turn is synced, then reused so every turn lands in the same
   * server-side thread — that's what makes the conversation visible and
   * continuable on chat.bioclaw.tech. Set when loading an existing thread.
   */
  chatJid: string | null;
  send: (text: string, params: SendParams) => Promise<void>;
  cancel: () => void;
  clear: () => void;
  /** Hydrate the transcript from a SaaS thread so the user can continue it. */
  loadThread: (port: number, chatJid: string) => Promise<void>;
  resolvePermission: (decision: 'allow' | 'allow_once' | 'deny') => Promise<void>;
}

let abortController: AbortController | null = null;

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streaming: null,
  status: 'idle',
  errorText: null,
  pendingPermission: null,
  chatJid: null,

  send: async (text, params) => {
    const trimmed = text.trim();
    if (!trimmed || get().status === 'streaming') return;

    abortController = new AbortController();

    const userMsg: UserMessage = {
      id: newId(),
      role: 'user',
      content: trimmed,
    };
    const assistant: AssistantMessage = {
      id: newId(),
      role: 'assistant',
      content: '',
    };

    set((s) => ({
      messages: [...s.messages, userMsg],
      streaming: assistant,
      status: 'streaming',
      errorText: null,
    }));

    // Build the wire-format messages from the committed transcript plus the
    // new user turn. Skip system messages — none are injected in phase 2,
    // and any future system prompt should be configured server-side anyway.
    const wireMessages: ChatMessage[] = get()
      .messages.filter((m): m is UserMessage | AssistantMessage => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const stream = streamChat({
        port: params.port,
        apiKey: params.apiKey,
        model: params.model,
        ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
        ...(params.provider ? { provider: params.provider } : {}),
        messages: wireMessages,
        signal: abortController.signal,
      });

      for await (const ev of stream) {
        switch (ev.type) {
          case 'text-delta':
            set((s) =>
              s.streaming
                ? { streaming: { ...s.streaming, content: s.streaming.content + ev.text } }
                : {},
            );
            break;
          case 'tool-call-start':
            set((s) => {
              if (!s.streaming) return {};
              const toolCalls = [
                ...(s.streaming.toolCalls ?? []),
                {
                  id: ev.toolCallId,
                  name: ev.name,
                  args: ev.args,
                },
              ];
              return { streaming: { ...s.streaming, toolCalls } };
            });
            break;
          case 'tool-call-result':
            set((s) => {
              if (!s.streaming) return {};
              // Sidecar emits `output: string` flat (not nested under `result`).
              // The AgentEvent type uses a richer ToolHandlerResult shape; we
              // accept either by reading both spellings.
              const result =
                'output' in ev
                  ? (ev as unknown as { output: string }).output
                  : (ev as { result: { output: string } }).result.output;
              const toolCalls = (s.streaming.toolCalls ?? []).map((tc) =>
                tc.id === ev.toolCallId ? { ...tc, result, isError: ev.isError } : tc,
              );
              return { streaming: { ...s.streaming, toolCalls } };
            });
            break;
          case 'permission-needed': {
            const e = ev as unknown as {
              requestId: string;
              skillId: string;
              script: string;
              interpreter: string;
              args: readonly string[];
            };
            // If we have a persisted always-allow for this skill+script,
            // resolve immediately without bothering the user.
            const alreadyAllowed = usePermissionStore
              .getState()
              .isAlwaysAllowed(e.skillId, e.script);
            if (alreadyAllowed) {
              void postPermissionDecision(params.port, e.requestId, 'allow').catch(() => {});
              break;
            }
            set({
              pendingPermission: {
                requestId: e.requestId,
                skillId: e.skillId,
                script: e.script,
                interpreter: e.interpreter,
                args: [...e.args],
                port: params.port,
              },
            });
            break;
          }
          case 'error':
            set((s) =>
              s.streaming
                ? {
                    streaming: {
                      ...s.streaming,
                      isError: true,
                      content: s.streaming.content || `Error: ${ev.error}`,
                    },
                  }
                : {},
            );
            break;
          case 'done':
            // Loop exits naturally; commit happens below.
            break;
          case 'finish':
            // Sidecar event mirror of the provider's finish event. Streaming
            // commit happens below regardless of how we exit.
            if ('reason' in ev && ev.reason === 'error' && 'error' in ev) {
              set((s) =>
                s.streaming
                  ? {
                      streaming: {
                        ...s.streaming,
                        isError: true,
                        content: s.streaming.content || `Error: ${ev.error}`,
                      },
                    }
                  : {},
              );
            }
            break;
          case 'usage':
          case 'step-complete':
            // Phase 2: ignore. Hook these up to a usage meter later.
            break;
        }
      }

      // Commit the in-flight turn.
      const finished = get().streaming;
      set((s) => ({
        messages: s.streaming ? [...s.messages, s.streaming] : s.messages,
        streaming: null,
        status: s.streaming?.isError ? 'error' : 'idle',
        errorText: s.streaming?.isError ? s.streaming.content : null,
      }));

      // Best-effort cloud sync: mirror this completed turn into the shared SaaS
      // thread store so the conversation is visible/continuable on the web.
      // Only for clean turns; never blocks or breaks the local chat.
      if (finished && !finished.isError && finished.content) {
        const newJid = await persistTurn(
          params.port,
          get().chatJid,
          trimmed,
          finished.content,
        );
        if (newJid && newJid !== get().chatJid) set({ chatJid: newJid });
      }
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (isAbort) {
        // Keep the partial text so the user can see what was generated.
        set((s) => ({
          messages: s.streaming
            ? [...s.messages, { ...s.streaming, isCancelled: true }]
            : s.messages,
          streaming: null,
          status: 'idle',
          errorText: null,
        }));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        set((s) => ({
          messages: s.streaming
            ? [
                ...s.messages,
                { ...s.streaming, isError: true, content: s.streaming.content || message },
              ]
            : s.messages,
          streaming: null,
          status: 'error',
          errorText: message,
        }));
      }
    } finally {
      abortController = null;
    }
  },

  cancel: () => {
    abortController?.abort();
  },

  clear: () => {
    abortController?.abort();
    abortController = null;
    set({
      messages: [],
      streaming: null,
      status: 'idle',
      errorText: null,
      pendingPermission: null,
      // A fresh chat mints a brand-new SaaS thread on its first synced turn.
      chatJid: null,
    });
  },

  loadThread: async (port, chatJid) => {
    abortController?.abort();
    abortController = null;
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/saas/messages?chatJid=${encodeURIComponent(chatJid)}`,
      );
      if (!res.ok) throw new Error(`load thread failed: ${res.status}`);
      const data = (await res.json()) as {
        messages?: Array<{ content?: string; is_from_me?: boolean | number }>;
      };
      const messages: ChatMessageView[] = (data.messages ?? [])
        .filter((m) => typeof m.content === 'string' && m.content.length > 0)
        .map((m) =>
          m.is_from_me
            ? ({ id: newId(), role: 'assistant', content: m.content as string } as AssistantMessage)
            : ({ id: newId(), role: 'user', content: m.content as string } as UserMessage),
        );
      set({
        messages,
        streaming: null,
        status: 'idle',
        errorText: null,
        pendingPermission: null,
        chatJid,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ status: 'error', errorText: `Failed to load conversation: ${message}` });
    }
  },

  resolvePermission: async (decision) => {
    const pp = get().pendingPermission;
    if (!pp) return;
    if (decision === 'allow') {
      usePermissionStore.getState().setAlwaysAllowed(pp.skillId, pp.script, pp.port);
    }
    try {
      await postPermissionDecision(pp.port, pp.requestId, decision);
    } catch {
      /* swallow — sidecar may have already aborted */
    }
    set({ pendingPermission: null });
  },
}));

/**
 * Mirror one completed turn into the shared SaaS thread store via the sidecar
 * /saas proxy → POST /api/desktop/messages (persist-only; does NOT re-run the
 * agent server-side). Returns the thread's chat_jid (minted on the first turn),
 * or the passed-in one on any failure. Best-effort: never throws — a sync
 * failure must never surface in or break the local chat.
 */
async function persistTurn(
  port: number,
  chatJid: string | null,
  userText: string,
  assistantText: string,
): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/saas/desktop/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(chatJid ? { chatJid } : { title: userText.slice(0, 80) }),
        userText,
        assistantText,
      }),
    });
    if (!res.ok) return chatJid;
    const data = (await res.json()) as { chatJid?: string };
    return data.chatJid ?? chatJid;
  } catch {
    return chatJid;
  }
}

async function postPermissionDecision(
  port: number,
  requestId: string,
  decision: 'allow' | 'allow_once' | 'deny',
): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/permissions/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, decision }),
  });
}

function newId(): string {
  const r = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `msg_${Date.now().toString(36)}_${r}`;
}
