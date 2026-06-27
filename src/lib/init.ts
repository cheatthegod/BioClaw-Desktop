/**
 * One-shot app initialization. Reads persisted preferences from
 * `tauri-plugin-store` (typed key/value, encrypted with the OS keychain on
 * mac/win, plain JSON file on linux), reconciles them into the Zustand
 * store, and warms up any background services. Called once from <App>.
 *
 * Note: API keys are NOT loaded here. They live in the OS keychain via
 * `lib/credentials.ts` and are pulled at send-time.
 *
 * History: this used to load + persist `mode` / `remoteUrl` / `localUrl`.
 * Those went away when the remote-iframe path was dropped (see
 * lib/store.ts). Stray entries in the user's persisted store are
 * ignored; we don't bother purging because they're cheap and harmless.
 */
import { Store } from '@tauri-apps/plugin-store';
import { useAppStore, DEFAULT_MODEL } from './store';
import { loadPermissions } from './permission-state';
import { useAuthStore } from './auth-state';
import { loadStoredSession } from './auth';

const STORE_FILE = 'bioclaw-prefs.json';

interface PersistedPrefs {
  selectedModel?: string;
}

export async function initializeApp(): Promise<void> {
  // tauri-plugin-store v2 API: `Store.load` lazily creates the file.
  const store = await Store.load(STORE_FILE, { autoSave: true, defaults: {} });
  const selectedModel = (await store.get<string>('selectedModel')) ?? DEFAULT_MODEL;

  useAppStore.setState({ selectedModel });

  // Load the persisted script-execution permission list. Best-effort —
  // a failure here just means the user re-grants permissions in this
  // session, not a hard error.
  await loadPermissions();

  // Hydrate the auth store from the OS keychain if a session token was
  // saved on a previous run. Skipping this just means the user sees the
  // LoginGate on every launch — recoverable but not the desired UX.
  try {
    const session = await loadStoredSession();
    if (session) {
      useAuthStore.getState().hydrate(session.email, session.token);
    }
  } catch (err) {
    console.warn('failed to hydrate auth from keychain', err);
  }
}

export async function persistPrefs(patch: PersistedPrefs): Promise<void> {
  const store = await Store.load(STORE_FILE, { autoSave: true, defaults: {} });
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) await store.set(key, value);
  }
  await store.save();
}
