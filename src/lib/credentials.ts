/**
 * Typed wrapper around the four `*_credential*` Tauri commands.
 *
 * Secrets never live in the renderer's state or in `localStorage` — every
 * call here round-trips to the Rust side, which reads/writes the OS
 * keychain (macOS Keychain Services / Windows Credential Manager / Linux
 * Secret Service). See `src-tauri/src/credentials.rs` and `docs/CREDENTIALS.md`.
 *
 * Accepted account names are an open set, but the UI sticks to:
 *   - `openrouter_api_key`
 *   - `anthropic_api_key`
 *   - `openai_api_key`
 *   - `bioclaw_session_token`
 */
import { invoke } from '@tauri-apps/api/core';

/** Canonical account names — keep in sync with `BIOCLAW_SERVICE` accounts in Rust. */
export type CredentialAccount =
  | 'openrouter_api_key'
  | 'anthropic_api_key'
  | 'openai_api_key'
  | 'bioclaw_session_token';

/**
 * Persist `value` under `account` in the OS keychain. Overwrites any
 * existing entry. Rejects on backend / IO failure with a string message.
 *
 * The value is NOT echoed back, logged, or returned. Treat the input string
 * as sensitive at the call site (clear it from form state after save).
 */
async function save(account: CredentialAccount | string, value: string): Promise<void> {
  await invoke<void>('save_credential', { account, value });
}

/**
 * Read a credential. Returns `null` when no entry exists for `account`
 * (mirrors the Rust `Option<String>`). Throws on backend errors so the
 * caller can show a "keychain unavailable" diagnostic.
 *
 * Note: on Linux this triggers a Secret Service / dbus round-trip and may
 * prompt the user to unlock their default keyring on first access of a
 * session.
 */
async function get(account: CredentialAccount | string): Promise<string | null> {
  const v = await invoke<string | null>('get_credential', { account });
  return v ?? null;
}

/**
 * Remove a credential. Treats "already missing" as success (idempotent), so
 * a UI delete button doesn't need to special-case it.
 */
async function del(account: CredentialAccount | string): Promise<void> {
  await invoke<void>('delete_credential', { account });
}

/**
 * Enumerate the names of stored credentials. Returns ONLY account names,
 * never the secret values.
 *
 * Backend caveat: enumeration is sourced from a small JSON index under
 * `$APPCONFIG/credential-keys.json` because the Linux Secret Service
 * backend doesn't expose reliable per-service enumeration. The index can
 * drift if the user manually wipes their keyring; the index self-heals on
 * the next `save` / `delete`.
 */
async function list(): Promise<string[]> {
  return await invoke<string[]>('list_credential_keys');
}

export const credentials = { save, get, delete: del, list };
