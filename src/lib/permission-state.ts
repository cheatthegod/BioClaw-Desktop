/**
 * Script-execution permission store. Tracks which (skillId, script) pairs
 * the user has chosen to "Allow always". Persists to tauri-plugin-store
 * so the decision survives desktop restarts.
 *
 * Wire shape persisted under key `scriptPermissions`:
 *   [{skillId, script}]
 *
 * Sidecar-side mirror: on Allow-Always we POST to /permissions/preload so
 * the sidecar's in-memory cache matches the persisted store immediately.
 * On app startup, `loadPermissions()` is called once and replays the full
 * list to the sidecar.
 */
import { create } from 'zustand';
import { Store } from '@tauri-apps/plugin-store';

const STORE_FILE = 'bioclaw-prefs.json';
const STORE_KEY = 'scriptPermissions';

export interface ScriptPermission {
  readonly skillId: string;
  readonly script: string;
}

interface PermissionState {
  permissions: ScriptPermission[];
  /** True if (skillId, script) is in the always-allow list. */
  isAlwaysAllowed: (skillId: string, script: string) => boolean;
  /** Set always-allow and persist; if `port` is supplied, also mirror to the sidecar. */
  setAlwaysAllowed: (skillId: string, script: string, port?: number) => void;
  /** Remove the always-allow entry. */
  revoke: (skillId: string, script: string) => void;
  /** Replace the in-memory list and re-persist. */
  replace: (list: readonly ScriptPermission[]) => void;
}

export const usePermissionStore = create<PermissionState>((set, get) => ({
  permissions: [],

  isAlwaysAllowed: (skillId, script) =>
    get().permissions.some((p) => p.skillId === skillId && p.script === script),

  setAlwaysAllowed: (skillId, script, port) => {
    const current = get().permissions;
    if (current.some((p) => p.skillId === skillId && p.script === script)) return;
    const next = [...current, { skillId, script }];
    set({ permissions: next });
    void persist(next).catch(() => {});
    if (port !== undefined) {
      void mirrorToSidecar(port, next).catch(() => {});
    }
  },

  revoke: (skillId, script) => {
    const next = get().permissions.filter((p) => !(p.skillId === skillId && p.script === script));
    set({ permissions: next });
    void persist(next).catch(() => {});
  },

  replace: (list) => {
    const next = [...list];
    set({ permissions: next });
    void persist(next).catch(() => {});
  },
}));

/**
 * Load persisted permissions from tauri-plugin-store and seed the Zustand
 * state. Call once on app boot. Best-effort: no throw on missing store.
 */
export async function loadPermissions(): Promise<void> {
  try {
    const store = await Store.load(STORE_FILE, { autoSave: true, defaults: {} });
    const raw = await store.get<unknown>(STORE_KEY);
    const list = sanitizeList(raw);
    usePermissionStore.setState({ permissions: list });
  } catch {
    // Store unavailable (e.g. inside the dev preview where tauri isn't
    // initialised yet). Silently keep an empty list.
  }
}

/** Push the current permission list to a freshly-spawned sidecar. */
export async function preloadPermissionsToSidecar(port: number): Promise<void> {
  const list = usePermissionStore.getState().permissions;
  if (list.length === 0) return;
  await mirrorToSidecar(port, list);
}

async function persist(list: readonly ScriptPermission[]): Promise<void> {
  const store = await Store.load(STORE_FILE, { autoSave: true, defaults: {} });
  await store.set(STORE_KEY, list);
  await store.save();
}

async function mirrorToSidecar(port: number, list: readonly ScriptPermission[]): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/permissions/preload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ permissions: list }),
  });
}

function sanitizeList(raw: unknown): ScriptPermission[] {
  if (!Array.isArray(raw)) return [];
  const out: ScriptPermission[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj['skillId'] !== 'string' || typeof obj['script'] !== 'string') continue;
    out.push({ skillId: obj['skillId'], script: obj['script'] });
  }
  return out;
}
