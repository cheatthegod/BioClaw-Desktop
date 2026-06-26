/**
 * One-shot app initialization. Reads persisted preferences from
 * `tauri-plugin-store` (typed key/value, encrypted with the OS keychain on
 * mac/win, plain JSON file on linux), reconciles them into the Zustand
 * store, and warms up any background services. Called once from <App>.
 *
 * Note: API keys are NOT loaded here. They live in the OS keychain via
 * `lib/credentials.ts` and are pulled at send-time.
 */
import { Store } from '@tauri-apps/plugin-store';
import { useAppStore, type AppMode, DEFAULT_MODEL } from './store';
import { loadPermissions } from './permission-state';

const STORE_FILE = 'bioclaw-prefs.json';

interface PersistedPrefs {
  mode?: AppMode;
  remoteUrl?: string;
  localUrl?: string;
  selectedModel?: string;
}

export async function initializeApp(): Promise<void> {
  // tauri-plugin-store v2 API: `Store.load` lazily creates the file.
  const store = await Store.load(STORE_FILE, { autoSave: true, defaults: {} });
  const mode = (await store.get<AppMode>('mode')) ?? 'remote';
  const remoteUrl = (await store.get<string>('remoteUrl')) ?? 'https://chat.bioclaw.tech';
  const localUrl = (await store.get<string>('localUrl')) ?? 'http://127.0.0.1:3000';
  const selectedModel = (await store.get<string>('selectedModel')) ?? DEFAULT_MODEL;

  useAppStore.setState({ mode, remoteUrl, localUrl, selectedModel });

  // Load the persisted script-execution permission list. Best-effort —
  // a failure here just means the user re-grants permissions in this
  // session, not a hard error.
  await loadPermissions();
}

export async function persistPrefs(patch: PersistedPrefs): Promise<void> {
  const store = await Store.load(STORE_FILE, { autoSave: true, defaults: {} });
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) await store.set(key, value);
  }
  await store.save();
}
