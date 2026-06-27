/**
 * Zustand store for the bundled-Python env. Polls the sidecar's
 * /env/state on a regular cadence so the SetupWizard's chrome stays
 * in sync after the user starts an install, even if the wizard is
 * closed mid-run. Decoupled from `useSidecar` because the env is its
 * own lifecycle — the sidecar boots before the env exists, and we
 * don't want to retry-storm the sidecar's status poll just because
 * a `uv sync` is in flight.
 */
import { create } from 'zustand';

export type EnvStatus = 'unknown' | 'needs-setup' | 'ready' | 'broken';

export interface EnvState {
  status: EnvStatus;
  projectDir: string;
  pythonPath: string | null;
  projectInitialized: boolean;
  bundledSourceDir: string | null;
}

interface EnvStore {
  state: EnvState | null;
  /** Set when /env/setup is streaming. The SetupWizard renders progress. */
  installing: boolean;
  /** Most recent setup-phase label ("Resolving + installing …"). */
  installPhase: string | null;
  /** Bounded queue of stdout/stderr lines for the progress view. */
  installLog: Array<{ stream: 'stdout' | 'stderr'; line: string }>;
  installError: string | null;

  refresh: (port: number) => Promise<void>;
  setInstalling: (b: boolean) => void;
  pushLog: (entry: { stream: 'stdout' | 'stderr'; line: string }) => void;
  setPhase: (label: string) => void;
  setError: (msg: string | null) => void;
  reset: () => void;
}

/** Cap the log buffer so a fast `uv sync` can't blow React. */
const LOG_CAP = 60;

export const useEnvStore = create<EnvStore>((set) => ({
  state: null,
  installing: false,
  installPhase: null,
  installLog: [],
  installError: null,

  refresh: async (port) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/env/state`);
      if (!res.ok) return;
      const state = (await res.json()) as EnvState;
      set({ state });
    } catch {
      /* sidecar down or offline — leave state stale */
    }
  },
  setInstalling: (b) => set({ installing: b }),
  pushLog: (entry) =>
    set((s) => {
      const next = s.installLog.length >= LOG_CAP
        ? [...s.installLog.slice(s.installLog.length - LOG_CAP + 1), entry]
        : [...s.installLog, entry];
      return { installLog: next };
    }),
  setPhase: (label) => set({ installPhase: label }),
  setError: (msg) => set({ installError: msg }),
  reset: () => set({ installing: false, installPhase: null, installLog: [], installError: null }),
}));

/**
 * Drive POST /env/setup and stream the SSE events into the store.
 * Returns a Promise that resolves on 'done' or rejects on 'error'.
 * The wizard wraps it in a try/catch that re-runs `refresh` to pick
 * up the new 'ready' state.
 */
export async function startSetup(
  port: number,
  body: { extras?: string[]; indexUrl?: string },
  signal: AbortSignal,
): Promise<void> {
  const store = useEnvStore.getState();
  store.reset();
  store.setInstalling(true);

  const res = await fetch(`http://127.0.0.1:${port}/env/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    useEnvStore.getState().setError(`Sidecar returned ${res.status}`);
    useEnvStore.getState().setInstalling(false);
    throw new Error(`setup http ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let doneSignal = false;
  let errMsg: string | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseEventBlock(chunk);
        if (!ev) continue;
        if (ev.type === 'phase' && typeof ev.label === 'string') {
          useEnvStore.getState().setPhase(ev.label);
        } else if (ev.type === 'log' && (ev.stream === 'stdout' || ev.stream === 'stderr')) {
          const line = typeof ev.line === 'string' ? ev.line : '';
          useEnvStore.getState().pushLog({ stream: ev.stream, line });
        } else if (ev.type === 'done') {
          doneSignal = true;
        } else if (ev.type === 'error') {
          errMsg = typeof ev.message === 'string' ? ev.message : 'Unknown error';
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
    useEnvStore.getState().setInstalling(false);
    if (errMsg) useEnvStore.getState().setError(errMsg);
  }
  if (errMsg) throw new Error(errMsg);
  if (!doneSignal) throw new Error('setup ended without a done event');
}

interface ParsedEvent {
  type?: string;
  [key: string]: unknown;
}

function parseEventBlock(chunk: string): ParsedEvent | null {
  let dataLine = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data: ')) dataLine += line.slice(6).trim();
  }
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine) as ParsedEvent;
  } catch {
    return null;
  }
}
