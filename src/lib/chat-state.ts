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
import { create } from 'zustand';
import { streamChat, type ChatMessage } from './chat-stream';

export type ChatStatus = 'idle' | 'streaming' | 'error';

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
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

interface ChatState {
  messages: ChatMessageView[];
  streaming: AssistantMessage | null;
  status: ChatStatus;
  errorText: string | null;
  send: (text: string, params: SendParams) => Promise<void>;
  cancel: () => void;
  clear: () => void;
}

let abortController: AbortController | null = null;

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streaming: null,
  status: 'idle',
  errorText: null,

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
              const toolCalls = [...(s.streaming.toolCalls ?? []), {
                id: ev.toolCallId,
                name: ev.name,
                args: ev.args,
              }];
              return { streaming: { ...s.streaming, toolCalls } };
            });
            break;
          case 'tool-call-result':
            set((s) => {
              if (!s.streaming) return {};
              const toolCalls = (s.streaming.toolCalls ?? []).map((tc) =>
                tc.id === ev.toolCallId
                  ? { ...tc, result: ev.result.output, isError: ev.isError }
                  : tc,
              );
              return { streaming: { ...s.streaming, toolCalls } };
            });
            break;
          case 'error':
            set((s) =>
              s.streaming
                ? { streaming: { ...s.streaming, isError: true, content: s.streaming.content || `Error: ${ev.error}` } }
                : {},
            );
            break;
          case 'done':
            // Loop exits naturally; commit happens below.
            break;
          case 'usage':
          case 'step-complete':
            // Phase 2: ignore. Hook these up to a usage meter later.
            break;
        }
      }

      // Commit the in-flight turn.
      set((s) => ({
        messages: s.streaming ? [...s.messages, s.streaming] : s.messages,
        streaming: null,
        status: s.streaming?.isError ? 'error' : 'idle',
        errorText: s.streaming?.isError ? s.streaming.content : null,
      }));
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
    set({ messages: [], streaming: null, status: 'idle', errorText: null });
  },
}));

function newId(): string {
  const r = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `msg_${Date.now().toString(36)}_${r}`;
}
