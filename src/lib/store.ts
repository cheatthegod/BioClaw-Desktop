/**
 * Zustand store. Single source of truth for app-wide state. We deliberately
 * keep this small — chat-session state lives in `lib/chat-state.ts`; this
 * store only tracks shell concerns (settings drawer visibility, last-known
 * sidecar PID, selected model).
 *
 * Note: API keys / session tokens are NOT held here. They live in the OS
 * keychain via `lib/credentials.ts` and never round-trip through React state.
 *
 * History: this used to carry a `mode: 'remote' | 'local'` switch. The
 * 'remote' branch rendered an iframe pointing at chat.bioclaw.tech, but
 * the SaaS sets `X-Frame-Options: DENY` (standard browser security) so
 * the iframe always failed with "已阻止此内容". We dropped the mode
 * switch entirely in preview13 — the desktop is now an independent React
 * UI that talks to the SaaS via fetch (cookie-auth on /api/desktop/*).
 * If users want the network web SPA's other surfaces (lab / papers /
 * files) they keep using https://chat.bioclaw.tech in a browser.
 */
import { create } from 'zustand';

interface AppState {
  isSettingsOpen: boolean;
  /** GPU tools panel (RNAGenesis / FoldMark / Boltz / … via the SaaS). */
  isGpuOpen: boolean;
  /** SaaS hub panel (account / quota / KB / skills / … via the SaaS). */
  isHubOpen: boolean;
  sidecarRunning: boolean;
  selectedModel: string;
  toggleSettings: () => void;
  toggleGpu: () => void;
  toggleHub: () => void;
  setSidecarRunning: (running: boolean) => void;
  setSelectedModel: (id: string) => void;
}

// The desktop app ships a single fixed model (no picker) — always DeepSeek
// V4 Pro, served via the bioclaw-proxy provider.
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-pro';

export const useAppStore = create<AppState>((set) => ({
  isSettingsOpen: false,
  isGpuOpen: false,
  isHubOpen: false,
  sidecarRunning: false,
  selectedModel: DEFAULT_MODEL,
  toggleSettings: () => set((s) => ({ isSettingsOpen: !s.isSettingsOpen })),
  toggleGpu: () => set((s) => ({ isGpuOpen: !s.isGpuOpen })),
  toggleHub: () => set((s) => ({ isHubOpen: !s.isHubOpen })),
  setSidecarRunning: (sidecarRunning) => set({ sidecarRunning }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
}));
