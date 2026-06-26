# Credential Storage

BioClaw Desktop stores third-party API keys (OpenRouter, Anthropic, OpenAI)
and the BioClaw session token in the host operating system's native secret
store. Plaintext on disk is never used for these values.

## What we store

| Account name              | Origin                                | Lifetime          |
|---------------------------|---------------------------------------|-------------------|
| `openrouter_api_key`      | User pastes it into Settings → API Keys | Until user deletes |
| `anthropic_api_key`       | User pastes it into Settings → API Keys | Until user deletes |
| `openai_api_key`          | User pastes it into Settings → API Keys | Until user deletes |
| `bioclaw_session_token`   | Issued by `chat.bioclaw.tech` on sign-in | Until sign-out or revoke |

All values live under a single service identifier, `tech.bioclaw.desktop`
(matches the Tauri bundle ID), so they are easy to spot and revoke
manually if needed.

## Where it lives (per OS)

| OS       | Backend                | Where to inspect                                                       |
|----------|------------------------|------------------------------------------------------------------------|
| macOS    | Keychain Services      | `Keychain Access.app` → search for `tech.bioclaw.desktop`              |
| Windows  | Credential Manager     | `Control Panel → User Accounts → Credential Manager → Windows Credentials` |
| Linux    | Secret Service (dbus)  | `secret-tool search service tech.bioclaw.desktop` (gnome-keyring / kwallet) |

The Rust `keyring` crate (v3) picks the right backend at compile time based
on the target OS. The same `Entry::new(service, account)` API works
everywhere — see `src-tauri/src/credentials.rs`.

## Threat model

What an attacker **with local disk access (but without an unlocked user
session)** can recover:

- On macOS: nothing useful. The Keychain file (`login.keychain-db`) is
  encrypted with a key derived from the user's login password. Secrets stay
  sealed until the user logs in.
- On Windows: nothing useful for ordinary users. Credential Manager
  entries are DPAPI-encrypted with a key tied to the Windows user
  profile. An attacker would need the user's password or a live session.
- On Linux: depends on the user's setup. gnome-keyring's default
  collection is encrypted with the login password and unlocked at login
  via PAM. kwallet behaves similarly. If the user disabled keyring
  encryption (some headless setups do this for convenience), the secrets
  sit in `~/.local/share/keyrings/Default_keyring.keyring` and a disk
  attacker can read them. We surface a one-time warning on first save if
  the keyring is unlocked but unencrypted.

What an attacker **with an unlocked user session** can recover: all of it.
This is by design — a process running as the user is, security-wise,
the user. We do not try to defend against in-session malware; that's the
OS sandbox's job.

What we do **not** protect against:

- Memory inspection of the BioClaw process while a key is in use.
- Shoulder-surfing during the brief window the user has the "show value"
  eye toggle enabled in the Settings panel.
- A compromised renderer that successfully invokes the credential
  commands — the capability file in `src-tauri/capabilities/default.json`
  restricts these to the `main` window, but a remote-code-execution bug
  inside that window's webview can still call them. We rely on the strict
  CSP and the small allow-list of remote origins to keep that surface
  small.

## Why not `tauri-plugin-store`?

`tauri-plugin-store` is a typed JSON KV that we already use for
non-sensitive preferences (`mode`, `remoteUrl`, …). It is not encrypted at
rest by default — it's a JSON file under `$APPCONFIG`. That is fine for a
user's preferred URL, terrible for an API key.

The OS keychain, by contrast, is hardware-backed where available:

- macOS uses the Secure Enclave for unlocking the keychain on Apple
  Silicon.
- Windows uses DPAPI, which on TPM-equipped machines binds the encryption
  key to the TPM.
- Linux Secret Service uses a key derived from the login password; not
  hardware-backed, but at least encrypted with a credential the disk
  attacker doesn't have.

## Linux enumeration caveat

The `keyring` crate does not expose a portable
"enumerate all entries for service X" API. The Secret Service spec has a
`SearchItems` method, but in practice it's flaky across kwallet vs.
gnome-keyring, collection lock state, and snap-confined keyrings.

To render the "stored ✓" badges in the Settings UI, we maintain a tiny
JSON index at `$APPCONFIG/tech.bioclaw.desktop/credential-keys.json`
containing only the names of accounts we have written. **No secret
material is in this file** — just strings like `"openrouter_api_key"`.

If the user manually wipes their keyring, the index will be out of sync
until the next save / delete, at which point it self-heals. `get_credential`
will correctly return `None` for the orphaned key in the meantime.

## Wiping everything

The "Sign Out / Reset" button in Settings calls
`credentials.delete(...)` for every account name returned by
`credentials.list()`, then truncates the index file. To wipe manually:

```bash
# macOS
security delete-generic-password -s tech.bioclaw.desktop

# Linux (gnome-keyring or kwallet via Secret Service)
secret-tool clear service tech.bioclaw.desktop

# Windows (PowerShell)
cmdkey /list | Select-String tech.bioclaw.desktop
# then `cmdkey /delete:<target>` for each match
```

Also remove the index file:

```bash
rm "$APPCONFIG/tech.bioclaw.desktop/credential-keys.json"
```

(`$APPCONFIG` is `~/Library/Application Support` on macOS, `%APPDATA%` on
Windows, `~/.config` on Linux.)

## Implementation pointers

- Rust module: `src-tauri/src/credentials.rs`
- Tauri commands: `save_credential`, `get_credential`, `delete_credential`,
  `list_credential_keys` (registered in `src-tauri/src/lib.rs`)
- TS wrapper: `src/lib/credentials.ts` — exports `credentials.save / get /
  delete / list`
- UI: `src/components/ApiKeysPanel.tsx`, mounted from
  `src/components/SettingsDrawer.tsx`
- Capability gate: `src-tauri/capabilities/default.json` (window-scoped to
  `main`)
