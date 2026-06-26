/**
 * Zustand store. Single source of truth for app-wide state. We deliberately
 * keep this small — chat-session state lives in `lib/chat-state.ts`; this
 * store only tracks shell concerns (mode, target URL, settings drawer
 * visibility, last-known sidecar PID, selected model).
 *
 * Note: API keys are NOT held here. They live in the OS keychain via
 * `lib/credentials.ts` and never round-trip through React state.
 */
import { create } from 'zustand';

export type AppMode = 'remote' | 'local';

interface AppState {
  mode: AppMode;
  remoteUrl: string;
  localUrl: string;
  isSettingsOpen: boolean;
  sidecarRunning: boolean;
  selectedModel: string;
  setMode: (mode: AppMode) => void;
  setRemoteUrl: (url: string) => void;
  setLocalUrl: (url: string) => void;
  toggleSettings: () => void;
  setSidecarRunning: (running: boolean) => void;
  setSelectedModel: (id: string) => void;
}

const DEFAULT_REMOTE = 'https://chat.bioclaw.tech';
const DEFAULT_LOCAL = 'http://127.0.0.1:3000';
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export const useAppStore = create<AppState>((set) => ({
  mode: 'remote',
  remoteUrl: DEFAULT_REMOTE,
  localUrl: DEFAULT_LOCAL,
  isSettingsOpen: false,
  sidecarRunning: false,
  selectedModel: DEFAULT_MODEL,
  setMode: (mode) => set({ mode }),
  setRemoteUrl: (remoteUrl) => set({ remoteUrl }),
  setLocalUrl: (localUrl) => set({ localUrl }),
  toggleSettings: () => set((s) => ({ isSettingsOpen: !s.isSettingsOpen })),
  setSidecarRunning: (sidecarRunning) => set({ sidecarRunning }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
}));
