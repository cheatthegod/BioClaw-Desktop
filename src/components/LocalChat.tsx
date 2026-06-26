/**
 * Phase-2 local chat view. Replaces the chat.bioclaw.tech iframe when the
 * user toggles to `mode === 'local'`. Single conversation, no history,
 * streams responses from the Tauri-managed sidecar.
 *
 * Layout (top→bottom):
 *   - Header bar: model picker + new-chat button + sidecar status pip
 *   - Optional api-key banner if no key is configured
 *   - Scrollable message list (auto-scroll with a "user scrolled up" lock)
 *   - Sticky composer at the bottom: textarea + send/stop button
 *
 * Why one file rather than four sub-components? Phase-2 chat is intentionally
 * a single-purpose screen — splitting it would just add ceremony without
 * any reuse. Once we add a sidebar/thread list (phase 3) the message list
 * and composer become their own files.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  AlertTriangle,
  ArrowUp,
  CornerDownLeft,
  Plus,
  Square,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useAppStore } from '../lib/store';
import {
  useChatStore,
  type AssistantMessage,
  type ChatMessageView,
  type ChatToolCall,
} from '../lib/chat-state';
import { useSidecar } from '../hooks/useSidecar';
import { credentials } from '../lib/credentials';
import { ModelPicker } from './ModelPicker';
import { ApiKeyMissingBanner } from './ApiKeyMissingBanner';
import { cn } from '../lib/utils';

const EXAMPLE_PROMPTS: ReadonlyArray<string> = [
  'Summarize the latest progress in CRISPR-Cas13 diagnostics.',
  'Explain how AlphaFold 3 differs from AlphaFold 2 for an ML audience.',
  'Draft an outline for a review paper on mRNA vaccine adjuvants.',
];

// Configure marked once. We bail to plain text on failure rather than throwing.
marked.setOptions({ gfm: true, breaks: true });

export function LocalChat() {
  const mode = useAppStore((s) => s.mode);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen);

  const sidecar = useSidecar(mode === 'local');

  // The API key lives in the OS keychain — we hold a presence flag in React
  // state but never the value itself. At send-time we pull it fresh from the
  // keychain and hand it straight to the sidecar.
  const [hasApiKey, setHasApiKey] = useState(false);
  const refreshKeyPresence = useCallback(async () => {
    try {
      const list = await credentials.list();
      setHasApiKey(list.includes('openrouter_api_key'));
    } catch {
      setHasApiKey(false);
    }
  }, []);
  useEffect(() => {
    void refreshKeyPresence();
  }, [refreshKeyPresence]);
  // Re-check after the settings drawer closes (user may have added/removed a key).
  const prevSettingsOpen = useRef(isSettingsOpen);
  useEffect(() => {
    if (prevSettingsOpen.current && !isSettingsOpen) void refreshKeyPresence();
    prevSettingsOpen.current = isSettingsOpen;
  }, [isSettingsOpen, refreshKeyPresence]);

  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const status = useChatStore((s) => s.status);
  const send = useChatStore((s) => s.send);
  const cancel = useChatStore((s) => s.cancel);
  const clear = useChatStore((s) => s.clear);

  const ready = sidecar.status === 'ready' && sidecar.port !== null;
  const isStreaming = status === 'streaming';
  const canSend = ready && hasApiKey && !isStreaming;

  const onSubmit = async (text: string) => {
    if (!canSend || !sidecar.port) return;
    let apiKey: string | null;
    try {
      apiKey = await credentials.get('openrouter_api_key');
    } catch {
      apiKey = null;
    }
    if (!apiKey) {
      setHasApiKey(false);
      return;
    }
    void send(text, {
      port: sidecar.port,
      apiKey,
      model: selectedModel,
    });
  };

  return (
    <div className="flex h-full w-full flex-col bg-zinc-50">
      <ChatHeader sidecar={sidecar} onNewChat={clear} />
      {!hasApiKey ? <ApiKeyMissingBanner /> : null}
      {sidecar.status === 'error' ? (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-[12px] text-red-800">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>Sidecar error: {sidecar.errorText ?? 'unknown'}</span>
        </div>
      ) : null}
      <MessageList messages={messages} streaming={streaming} />
      <Composer
        canSend={canSend}
        isStreaming={isStreaming}
        onSubmit={onSubmit}
        onCancel={cancel}
        ready={ready}
        hasApiKey={hasApiKey}
        sidecarStatus={sidecar.status}
        onExample={onSubmit}
        showExamples={messages.length === 0 && !streaming}
      />
    </div>
  );
}

function ChatHeader({
  sidecar,
  onNewChat,
}: {
  sidecar: ReturnType<typeof useSidecar>;
  onNewChat: () => void;
}) {
  const pipColor =
    sidecar.status === 'ready'
      ? 'bg-emerald-500'
      : sidecar.status === 'starting'
        ? 'bg-amber-500 animate-pulse'
        : sidecar.status === 'error'
          ? 'bg-red-500'
          : 'bg-zinc-400';
  const pipLabel =
    sidecar.status === 'ready'
      ? `Local sidecar :${sidecar.port}`
      : sidecar.status === 'starting'
        ? 'Starting sidecar…'
        : sidecar.status === 'error'
          ? 'Sidecar error'
          : 'Sidecar offline';

  return (
    <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2">
      <div className="flex items-center gap-3">
        <ModelPicker />
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <span className={cn('h-1.5 w-1.5 rounded-full', pipColor)} />
          {pipLabel}
        </div>
      </div>
      <button
        type="button"
        onClick={onNewChat}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[12px] text-zinc-600 hover:border-zinc-300 hover:text-zinc-800"
        title="Start a new chat"
      >
        <Plus className="h-3 w-3" />
        New chat
      </button>
    </div>
  );
}

function MessageList({
  messages,
  streaming,
}: {
  messages: ChatMessageView[];
  streaming: AssistantMessage | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Locks auto-scroll when the user scrolls up. Resets when they return to
  // the bottom.
  const [stickToBottom, setStickToBottom] = useState(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming?.content, stickToBottom]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    setStickToBottom(distanceFromBottom < 64);
  };

  const isEmpty = messages.length === 0 && !streaming;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        {isEmpty ? <EmptyState /> : null}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {streaming ? (
          <MessageBubble message={streaming} isStreaming />
        ) : null}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900 text-white">
        <Sparkles className="h-5 w-5" />
      </div>
      <h2 className="mt-4 text-base font-semibold text-zinc-800">
        Start chatting with BioClaw locally
      </h2>
      <p className="mt-1 max-w-md text-[12px] text-zinc-500">
        Your messages are sent to the local agent sidecar — your API key never
        leaves this machine.
      </p>
    </div>
  );
}

function MessageBubble({
  message,
  isStreaming,
}: {
  message: ChatMessageView;
  isStreaming?: boolean;
}) {
  if (message.role === 'system') {
    return (
      <div className="self-center rounded-full bg-zinc-200 px-3 py-1 text-[11px] text-zinc-600">
        {message.content}
      </div>
    );
  }
  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-900 px-3.5 py-2 text-[13px] leading-relaxed text-white">
        {message.content}
      </div>
    );
  }
  return <AssistantBubble message={message} isStreaming={isStreaming} />;
}

function AssistantBubble({
  message,
  isStreaming,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
}) {
  return (
    <div className="self-start w-full max-w-[95%]">
      {(message.toolCalls ?? []).map((tc) => (
        <ToolCallCard key={tc.id} toolCall={tc} />
      ))}
      {message.content || !isStreaming ? (
        <div
          className={cn(
            'rounded-2xl rounded-bl-sm border border-zinc-200 bg-white px-4 py-3 text-[13px] leading-relaxed text-zinc-800',
            message.isError && 'border-red-200 bg-red-50 text-red-800',
          )}
        >
          <MarkdownContent text={message.content} />
          {isStreaming ? <StreamingCursor /> : null}
          {message.isCancelled ? (
            <div className="mt-2 text-[11px] italic text-zinc-500">Stopped by user.</div>
          ) : null}
        </div>
      ) : (
        <div className="rounded-2xl rounded-bl-sm border border-zinc-200 bg-white px-4 py-3">
          <ThinkingDots />
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ toolCall }: { toolCall: ChatToolCall }) {
  const [open, setOpen] = useState(false);
  const argsJson = useMemo(() => safeStringify(toolCall.args), [toolCall.args]);
  return (
    <details
      className="mb-2 rounded-lg border border-zinc-200 bg-zinc-50 text-[12px]"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-zinc-600">
        <Wrench className="h-3 w-3 text-zinc-500" />
        <span className="font-mono">{toolCall.name}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-zinc-400">
          {toolCall.result !== undefined ? (toolCall.isError ? 'error' : 'done') : 'running'}
        </span>
      </summary>
      {open ? (
        <div className="space-y-2 border-t border-zinc-200 px-3 py-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">args</div>
            <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] text-zinc-700">
              {argsJson}
            </pre>
          </div>
          {toolCall.result !== undefined ? (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">result</div>
              <pre
                className={cn(
                  'mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px]',
                  toolCall.isError ? 'text-red-700' : 'text-zinc-700',
                )}
              >
                {toolCall.result}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function MarkdownContent({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // We render copy buttons by attaching after the fact rather than inside
  // marked — pre/code blocks need a sibling button, easiest to do in markup
  // post-pass via querySelectorAll on the container.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const blocks = el.querySelectorAll('pre');
    const cleanups: Array<() => void> = [];
    blocks.forEach((pre) => {
      if (pre.querySelector('[data-copy-btn]')) return;
      pre.classList.add('relative', 'group');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-copy-btn', '1');
      btn.className =
        'absolute right-2 top-2 rounded border border-zinc-300 bg-white/90 px-1.5 py-0.5 text-[10px] text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-white';
      btn.textContent = 'Copy';
      const onClick = () => {
        const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
        void navigator.clipboard.writeText(code).then(() => {
          btn.textContent = 'Copied';
          setTimeout(() => {
            btn.textContent = 'Copy';
          }, 1200);
        });
      };
      btn.addEventListener('click', onClick);
      pre.appendChild(btn);
      cleanups.push(() => btn.removeEventListener('click', onClick));
    });
    return () => cleanups.forEach((fn) => fn());
  }, [html]);

  return (
    <div
      ref={containerRef}
      className="prose-chat"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function StreamingCursor() {
  return (
    <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-[1px] animate-pulse bg-zinc-700" />
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 text-zinc-400">
      <Dot delay={0} />
      <Dot delay={120} />
      <Dot delay={240} />
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}

function Composer({
  canSend,
  isStreaming,
  ready,
  hasApiKey,
  sidecarStatus,
  onSubmit,
  onCancel,
  onExample,
  showExamples,
}: {
  canSend: boolean;
  isStreaming: boolean;
  ready: boolean;
  hasApiKey: boolean;
  sidecarStatus: ReturnType<typeof useSidecar>['status'];
  onSubmit: (text: string) => void | Promise<void>;
  onCancel: () => void;
  onExample: (text: string) => void | Promise<void>;
  showExamples: boolean;
}) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize textarea up to ~8 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    if (!canSend) return;
    const value = text.trim();
    if (!value) return;
    setText('');
    void onSubmit(value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = !hasApiKey
    ? 'Add an API key in settings to start chatting…'
    : sidecarStatus !== 'ready'
      ? 'Waiting for local sidecar…'
      : 'Message BioClaw…';

  return (
    <div className="border-t border-zinc-200 bg-white">
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        {showExamples ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={!canSend}
                onClick={() => void onExample(p)}
                className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-[11px] text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
        ) : null}
        <div
          className={cn(
            'flex items-end gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 shadow-sm transition focus-within:border-zinc-400',
            !ready && 'bg-zinc-50',
          )}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            rows={1}
            disabled={!ready || !hasApiKey}
            className="max-h-[200px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-zinc-800 placeholder:text-zinc-400 focus:outline-none disabled:cursor-not-allowed"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900 text-white hover:bg-zinc-700"
              title="Stop generating"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend || !text.trim()}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full transition',
                canSend && text.trim()
                  ? 'bg-zinc-900 text-white hover:bg-zinc-700'
                  : 'cursor-not-allowed bg-zinc-200 text-zinc-400',
              )}
              title="Send (Enter)"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-400">
          <span className="inline-flex items-center gap-1">
            <CornerDownLeft className="h-2.5 w-2.5" />
            Enter to send · Shift+Enter for newline
          </span>
          <span>BioClaw can make mistakes. Verify important info.</span>
        </div>
      </div>
    </div>
  );
}

// ---- markdown helpers -----------------------------------------------------

function renderMarkdown(src: string): string {
  if (!src) return '';
  try {
    const raw = marked.parse(src, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'iframe', 'form'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
    });
  } catch {
    // Streaming markdown can be momentarily invalid (open code fence etc.).
    // Just render as text rather than crashing.
    return escapeHtml(src);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

