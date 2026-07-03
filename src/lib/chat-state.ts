/**
 * Chat-session state. One session at a time; the transcript is now owned by the
 * BioClaw-SaaS server-side agent (Phase A) rather than the local sidecar agent,
 * so the desktop chat behaves identically to chat.bioclaw.tech. Everything is
 * reached through the sidecar's authenticated proxy — `/saas/<path>` forwards to
 * `https://chat.bioclaw.tech/api/<path>` with the session cookie attached.
 *
 * We keep this as a Zustand store rather than a per-component hook so the cancel
 * button in the composer and the message list in the body of <LocalChat> can
 * both reach it without prop drilling.
 *
 * State shape:
 *   - `messages`: the committed transcript, mirrored from the server (the
 *     authoritative source — we refetch and reconcile on every notify ping).
 *   - `streaming`: the in-flight assistant turn (null when not streaming). Live
 *     agent activity (thinking text + tool steps) streams into this bubble from
 *     the trace feed; it's replaced by the server's persisted answer once the
 *     turn lands.
 *   - `status`: rough state machine — 'idle' / 'streaming' / 'error'.
 *
 * The server-side agent is driven over two long-lived SSE streams (opened via
 * the /saas proxy): `/saas/events?chatJid` (a "new messages, refetch now"
 * notifier) and `/saas/trace/stream` (per-row live agent activity). See the
 * stream managers below.
 */
import { fetch } from '@tauri-apps/plugin-http'; // native fetch: bypasses webview CSP for local sidecar
import { create } from 'zustand';
import { saasGet, saasPost, saasStream, SaasError } from './api/saas';
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
}

interface ChatState {
  messages: ChatMessageView[];
  streaming: AssistantMessage | null;
  status: ChatStatus;
  errorText: string | null;
  pendingPermission: PendingPermission | null;
  /**
   * SaaS thread id (chat_jid) this desktop conversation runs in. null until the
   * first turn mints one, then reused so every turn lands in the same
   * server-side thread — that's what makes the conversation visible and
   * continuable on chat.bioclaw.tech. Set when loading an existing thread.
   */
  chatJid: string | null;
  /**
   * The thread's server-side workspace folder. It's the documented filter key
   * for the global trace stream, so we hold onto it to route live activity rows
   * to the right bubble.
   */
  workspaceFolder: string | null;
  send: (text: string, params: SendParams) => Promise<void>;
  cancel: () => void;
  clear: () => void;
  /** Hydrate the transcript from a SaaS thread so the user can continue it. */
  loadThread: (port: number, chatJid: string) => Promise<void>;
  resolvePermission: (decision: 'allow' | 'allow_once' | 'deny') => Promise<void>;
}

/** Surfaced in the assistant bubble when the server returns 429 daily_cap_reached. */
const DAILY_CAP_MESSAGE = '已达今日用量上限';

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streaming: null,
  status: 'idle',
  errorText: null,
  pendingPermission: null,
  chatJid: null,
  workspaceFolder: null,

  send: async (text, params) => {
    const trimmed = text.trim();
    if (!trimmed || get().status === 'streaming') return;
    const { port } = params;

    // 1. Ensure we have a server-side thread to run this turn in. The first
    //    turn mints one (titled from the message); later turns reuse it so the
    //    conversation stays continuable on the web.
    let chatJid = get().chatJid;
    let workspaceFolder = get().workspaceFolder;
    if (!chatJid) {
      try {
        const res = await saasPost<CreateThreadResponse>(port, '/threads', {
          title: trimmed.slice(0, 80),
        });
        chatJid = res.thread.chatJid;
        workspaceFolder = res.thread.workspaceFolder ?? null;
        set({ chatJid, workspaceFolder });
      } catch (err) {
        set({ status: 'error', errorText: describeError(err) });
        return;
      }
    }

    // 2. Optimistically show the user's message plus an empty assistant bubble
    //    that live trace progress streams into.
    const userMsg: UserMessage = { id: newId(), role: 'user', content: trimmed };
    const assistant: AssistantMessage = { id: newId(), role: 'assistant', content: '' };
    set((s) => ({
      messages: [...s.messages, userMsg],
      streaming: assistant,
      status: 'streaming',
      errorText: null,
    }));

    // 3. Make sure the notifier + activity streams are live for this thread and
    //    claim the turn so the trace handler routes rows into this bubble.
    activeTurn = { port, chatJid, workspaceFolder };
    ensureEventStream(port, chatJid);
    ensureTraceStream(port);

    // 4. Kick the turn. The agent runs server-side; this returns immediately and
    //    progress arrives over the streams above. The turn ends on `run_end`
    //    (trace) or when the persisted assistant message shows up (events).
    try {
      await saasPost(port, '/messages', { chatJid, text: trimmed });
    } catch (err) {
      activeTurn = null;
      const capped = err instanceof SaasError && err.status === 429;
      const message = capped ? DAILY_CAP_MESSAGE : describeError(err);
      set((s) => ({
        messages: s.streaming
          ? [...s.messages, { ...s.streaming, isError: true, content: message }]
          : s.messages,
        streaming: null,
        status: 'error',
        errorText: message,
      }));
    }
  },

  cancel: () => {
    const turn = activeTurn;
    activeTurn = null;
    if (turn) {
      // Best-effort server stop; the UI ends the turn immediately regardless.
      void saasPost(turn.port, '/messages/stop', { chatJid: turn.chatJid }).catch(() => {});
    }
    // Keep the partial text so the user can see what was generated, mirroring
    // how ChatGPT / Claude.ai behave on stop.
    set((s) =>
      s.streaming
        ? {
            messages: [...s.messages, { ...s.streaming, isCancelled: true }],
            streaming: null,
            status: 'idle',
            errorText: null,
          }
        : { status: 'idle', errorText: null },
    );
  },

  clear: () => {
    activeTurn = null;
    closeEventStream();
    closeTraceStream();
    set({
      messages: [],
      streaming: null,
      status: 'idle',
      errorText: null,
      pendingPermission: null,
      // A fresh chat mints a brand-new SaaS thread on its first turn.
      chatJid: null,
      workspaceFolder: null,
    });
  },

  loadThread: async (port, chatJid) => {
    // Switching threads ends any in-flight turn and repoints the notifier stream.
    activeTurn = null;
    closeEventStream();
    try {
      const data = await saasGet<MessagesResponse>(port, messagesPath(chatJid));
      const messages = mapMessages(data.messages ?? []);
      // Best-effort: recover this thread's workspaceFolder (the trace-filter
      // key) from the thread list so a continued turn's activity routes right.
      const workspaceFolder = await lookupWorkspaceFolder(port, chatJid);
      set({
        messages,
        streaming: null,
        status: 'idle',
        errorText: null,
        pendingPermission: null,
        chatJid,
        workspaceFolder,
      });
      // Subscribe to this thread's notifier so external updates refetch.
      ensureEventStream(port, chatJid);
    } catch (err) {
      set({ status: 'error', errorText: `Failed to load conversation: ${describeError(err)}` });
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

// ── server-side agent streams (Phase A) ─────────────────────────────────────
// The desktop chat runs entirely through the SaaS server-side agent, reached via
// the sidecar's authenticated /saas proxy. Two long-lived SSE streams drive the
// UI: `/saas/events?chatJid` notifies "there are new messages, refetch now", and
// `/saas/trace/stream` carries per-row live agent activity. Both are plain module
// singletons (not React state) so the store owns their lifecycle across turns.

interface ActiveTurn {
  readonly port: number;
  readonly chatJid: string;
  readonly workspaceFolder: string | null;
}

/**
 * The turn currently running server-side, or null when idle. Doubles as a claim
 * token: exactly one finalizer (run_end, a fresh assistant message, cancel, or
 * an error) gets to commit the in-flight bubble — whichever runs first nulls it.
 */
let activeTurn: ActiveTurn | null = null;

let eventsCtrl: AbortController | null = null;
let eventsJid: string | null = null;
let traceCtrl: AbortController | null = null;

/** Open (or keep) the notify stream for `chatJid`. Idempotent per chatJid. */
function ensureEventStream(port: number, chatJid: string): void {
  if (eventsJid === chatJid && eventsCtrl) return;
  closeEventStream();
  const ctrl = new AbortController();
  eventsCtrl = ctrl;
  eventsJid = chatJid;
  void (async () => {
    try {
      const res = await saasStream(port, `/events?chatJid=${encodeURIComponent(chatJid)}`, {
        signal: ctrl.signal,
      });
      for await (const ev of iterateSaasSse(res, ctrl.signal)) {
        if (ctrl.signal.aborted) return;
        // The only signal we act on is "there are new messages" — refetch.
        // hello / heartbeat / unknown types are ignored.
        if (ev.type === 'messages') void refetchAndReconcile(port, chatJid);
      }
    } catch {
      /* aborted, or the stream dropped — the next send()/loadThread reopens it */
    } finally {
      if (eventsCtrl === ctrl) {
        eventsCtrl = null;
        eventsJid = null;
      }
    }
  })();
}

function closeEventStream(): void {
  eventsCtrl?.abort();
  eventsCtrl = null;
  eventsJid = null;
}

/** Open (or keep) the global live-activity stream. Idempotent. */
function ensureTraceStream(port: number): void {
  if (traceCtrl) return;
  const ctrl = new AbortController();
  traceCtrl = ctrl;
  void (async () => {
    try {
      const res = await saasStream(port, '/trace/stream', { signal: ctrl.signal });
      for await (const row of iterateSaasSse(res, ctrl.signal)) {
        if (ctrl.signal.aborted) return;
        handleTraceRow(row);
      }
    } catch {
      /* aborted, or the stream dropped — the next send() reopens it */
    } finally {
      if (traceCtrl === ctrl) traceCtrl = null;
    }
  })();
}

function closeTraceStream(): void {
  traceCtrl?.abort();
  traceCtrl = null;
}

/**
 * Route one live-activity row into the in-flight bubble. Rows are global, so we
 * keep only the active thread's — filtered by `group_folder === workspaceFolder`
 * (the documented key), falling back to the row's `chat_jid` when we don't have
 * a workspaceFolder.
 */
function handleTraceRow(row: Record<string, unknown>): void {
  const turn = activeTurn;
  if (!turn) return;
  const groupFolder = typeof row.group_folder === 'string' ? row.group_folder : null;
  const rowJid = typeof row.chat_jid === 'string' ? row.chat_jid : null;
  const mine =
    turn.workspaceFolder != null ? groupFolder === turn.workspaceFolder : rowJid === turn.chatJid;
  if (!mine) return;

  const type = typeof row.type === 'string' ? row.type : '';
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'agent_thinking':
      if (typeof payload.text === 'string') appendAssistantText(payload.text);
      break;
    case 'agent_tool_use':
      if (typeof payload.toolName === 'string') addToolCall(payload.toolName, payload.toolInput);
      break;
    case 'agent_tool_result':
      if (typeof payload.toolName === 'string') {
        resolveToolCall(payload.toolName, payload.success !== false);
      }
      break;
    case 'run_end':
      void onRunEnd(turn, typeof payload.status === 'string' ? payload.status : 'ok');
      break;
    case 'run_error':
      onRunError(turn, typeof payload.message === 'string' ? payload.message : 'Agent run failed');
      break;
    // run_start and unknown types: nothing to render.
  }
}

/** Append a thinking delta to the in-flight assistant bubble. */
function appendAssistantText(text: string): void {
  useChatStore.setState((s) =>
    s.streaming ? { streaming: { ...s.streaming, content: s.streaming.content + text } } : {},
  );
}

/** Add a tool step to the in-flight bubble (reusing the AssistantMessage shape). */
function addToolCall(name: string, input: unknown): void {
  useChatStore.setState((s) => {
    if (!s.streaming) return {};
    const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const toolCalls = [...(s.streaming.toolCalls ?? []), { id: newId(), name, args }];
    return { streaming: { ...s.streaming, toolCalls } };
  });
}

/**
 * Mark the earliest still-running tool step with this name as finished. Trace
 * rows carry no tool-call id, so we correlate by name in call order.
 */
function resolveToolCall(name: string, success: boolean): void {
  useChatStore.setState((s) => {
    if (!s.streaming?.toolCalls) return {};
    let matched = false;
    const toolCalls = s.streaming.toolCalls.map((tc) => {
      if (!matched && tc.name === name && tc.result === undefined) {
        matched = true;
        return { ...tc, result: success ? 'Completed' : 'Failed', isError: !success };
      }
      return tc;
    });
    return matched ? { streaming: { ...s.streaming, toolCalls } } : {};
  });
}

/**
 * Refetch the authoritative transcript and reconcile it into `messages`. A fresh
 * assistant message at the tail while we're streaming is the turn-end signal (the
 * "or when a new is_from_me:true message appears" condition) — and the finalizer
 * when the trace stream is unavailable.
 */
async function refetchAndReconcile(port: number, chatJid: string): Promise<void> {
  if (useChatStore.getState().chatJid !== chatJid) return;
  let data: MessagesResponse;
  try {
    data = await saasGet<MessagesResponse>(port, messagesPath(chatJid));
  } catch {
    return; // transient; another ping or run_end will retry
  }
  const s = useChatStore.getState();
  if (s.chatJid !== chatJid) return;
  const mapped = mapMessages(data.messages ?? []);
  const tail = mapped[mapped.length - 1];
  const landed =
    s.streaming != null && tail?.role === 'assistant' && activeTurn?.chatJid === chatJid;
  if (landed) activeTurn = null;
  useChatStore.setState(
    landed
      ? { messages: mapped, streaming: null, status: 'idle', errorText: null }
      : { messages: mapped },
  );
}

/** Terminal `run_end` for the active turn: reconcile, then commit if needed. */
async function onRunEnd(turn: ActiveTurn, status: string): Promise<void> {
  if (activeTurn?.chatJid !== turn.chatJid) return;
  if (status === 'error') {
    onRunError(turn, 'Agent run failed');
    return;
  }
  // Pull the authoritative transcript, which normally finalizes us via the
  // fresh-assistant-message path in refetchAndReconcile.
  await refetchAndReconcile(turn.port, turn.chatJid);
  // If the assistant message wasn't persisted yet, commit whatever we streamed
  // so the turn still ends cleanly.
  if (activeTurn?.chatJid !== turn.chatJid) return;
  activeTurn = null;
  useChatStore.setState((s) =>
    s.streaming
      ? { messages: [...s.messages, s.streaming], streaming: null, status: 'idle', errorText: null }
      : { status: 'idle', errorText: null },
  );
}

/** Terminal error for the active turn (`run_error`): surface it in the bubble. */
function onRunError(turn: ActiveTurn, message: string): void {
  if (activeTurn?.chatJid !== turn.chatJid) return;
  activeTurn = null;
  useChatStore.setState((s) =>
    s.streaming
      ? {
          messages: [
            ...s.messages,
            { ...s.streaming, isError: true, content: s.streaming.content || message },
          ],
          streaming: null,
          status: 'error',
          errorText: message,
        }
      : { status: 'error', errorText: message },
  );
}

// ── SaaS wire shapes + helpers ──────────────────────────────────────────────

interface RawMessage {
  id?: string | number;
  content?: string;
  is_from_me?: boolean | number;
  sender_name?: string | null;
  timestamp?: string;
}
interface MessagesResponse {
  messages?: RawMessage[];
}
interface ThreadSummary {
  chatJid: string;
  title?: string;
  workspaceFolder?: string;
  addedAt?: string;
}
interface ThreadsResponse {
  threads?: ThreadSummary[];
}
interface CreateThreadResponse {
  ok?: boolean;
  thread: { chatJid: string; workspaceFolder?: string };
}

/** History for a thread, scoped to the chat surface. `is_from_me:true`=assistant. */
function messagesPath(chatJid: string): string {
  return `/messages?chatJid=${encodeURIComponent(chatJid)}&scope=chat`;
}

/** Map the SaaS message rows into our view model. Empty rows are dropped. */
function mapMessages(raw: RawMessage[]): ChatMessageView[] {
  return raw
    .filter((m) => typeof m.content === 'string' && m.content.length > 0)
    .map((m) =>
      m.is_from_me
        ? ({ id: newId(), role: 'assistant', content: m.content as string } as AssistantMessage)
        : ({ id: newId(), role: 'user', content: m.content as string } as UserMessage),
    );
}

/** Best-effort lookup of a thread's workspaceFolder from the thread list. */
async function lookupWorkspaceFolder(port: number, chatJid: string): Promise<string | null> {
  try {
    const data = await saasGet<ThreadsResponse>(port, '/threads');
    const t = (data.threads ?? []).find((th) => th.chatJid === chatJid);
    return t?.workspaceFolder ?? null;
  } catch {
    return null;
  }
}

function describeError(err: unknown): string {
  if (err instanceof SaasError) return err.detail ? `${err.message}: ${err.detail}` : err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read a SaaS SSE stream, yielding the parsed JSON object from each `data:` line.
 * Modeled on `parseSseStream` in chat-stream.ts: we own the reader and `cancel()`
 * it on teardown (not `releaseLock`) so @tauri-apps/plugin-http tears the native
 * stream down cleanly — a bare releaseLock leaves a dangling read that surfaces
 * as 'resource id N is invalid' rejections. Comment/heartbeat and non-JSON lines
 * are skipped.
 */
async function* iterateSaasSse(
  res: Response,
  signal: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const obj = parseSseData(frame);
        if (obj) yield obj;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  }
}

/** Concatenate a frame's `data:` lines and JSON-parse them; null on anything else. */
function parseSseData(frame: string): Record<string, unknown> | null {
  let data = '';
  for (const line of frame.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('data:')) data += trimmed.slice(5).trim();
  }
  if (!data) return null;
  try {
    const v = JSON.parse(data);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
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
