# BioClaw Desktop — Architecture

> Honest snapshot of the v0.1.0 scaffold (today, 2026-06-26). Where a section describes intent rather than committed code, it says so. If you spot a section that overclaims, treat that as a bug in this document — please file a PR.

This document is split into:

1. [Decision log](#1-decision-log) — what was chosen, what was rejected, why.
2. [Layer diagram](#2-layer-diagram) — the actual modules in the v0.1 tree.
3. [Process model](#3-process-model) — threads, IPC, future sidecar.
4. [Security model](#4-security-model) — CSP, capabilities, updater, OS keychain.
5. [Roadmap details](#5-roadmap-details) — Phase 2 and Phase 3 in concrete terms.
6. [References](#6-references) — external projects and specs we read.

---

## 1. Decision log

Every entry: **date · decision · alternatives considered · rationale**. Dates are when the call was made, not when this doc was edited.

### 1.1 Tauri 2 over Electron (2026-06-26)

- **Decision**: ship on Tauri 2.4.
- **Alternatives**: Electron 31, Wails v2 (Go), native per-OS shells (SwiftUI / WinUI / Qt).
- **Rationale**: binary size is the dominant axis for a biomed-researcher audience that often installs on lab desktops with disk-quota constraints — a Tauri 2 universal `.dmg` lands around 15-25 MB versus 130+ MB for an equivalent Electron build. Tauri's WebView model also lets us reuse the system browser engine the user already trusts. Cost: WebKit (macOS) and webkit2gtk (Linux) ship slower than Chromium for some flexbox/Grid edges; we accept that tradeoff. Wails is single-platform mature only on macOS today. Native shells triple the maintenance per OS.

### 1.2 React 19 over Solid / Svelte (2026-06-26)

- **Decision**: React 19 with the new use API and the JSX automatic runtime.
- **Alternatives**: Solid (`solid-js`), SvelteKit, Preact, vanilla.
- **Rationale**: the BioClaw SaaS frontend is React, so the desktop team can move between repos without paying a context-switch tax, and component patterns (TitleBar, drawer, etc.) port over directly. React 19 also has the broadest ecosystem support for the Tauri plugin TypeScript types we depend on. Solid would have been a stronger raw-performance pick but the shell is mostly inert (an iframe + a drawer) — the perf delta is invisible here.

### 1.3 Zustand over Redux / Jotai / Context (2026-06-26)

- **Decision**: Zustand 5, a single `useAppStore`.
- **Alternatives**: Redux Toolkit, Jotai, plain `useContext` + `useReducer`.
- **Rationale**: the shell state is tiny (mode, two URLs, drawer visibility, sidecar flag). Redux is too much ceremony; Jotai's atom-per-value pattern doesn't pay off until you have lots of independently subscribed values. Zustand gives us selector-level subscriptions with no provider and no boilerplate, and it's already a hard-won team idiom. See `src/lib/store.ts`.

### 1.4 Thin-client first (2026-06-26)

- **Decision**: Phase 1 ships only a WebView pointed at `chat.bioclaw.tech`. No custom chat UI, no local LLM, no offline.
- **Alternatives**: build the chat UI natively from day one; ship Phase 2 (local sidecar) and Phase 1 together.
- **Rationale**: time-to-real-install matters more than feature parity in v0.1. A thin client gives users a Dock icon, native notifications, and an auto-updater they can adopt today, while the BioClaw SaaS team keeps owning the chat UI as a single source of truth. It also reduces our security surface to the lowest possible bar for the first signed release — see [section 4](#4-security-model).

### 1.5 MIT license (2026-06-26)

- **Decision**: MIT for the desktop repo.
- **Alternatives**: Apache-2.0, MPL-2.0, AGPL-3.0, GPLv3.
- **Rationale**: maximum compatibility with both the upstream BioClaw SaaS (which is closed-source today) and the inspirations cited (Tauri, opencode, Jan, Goose are all MIT-equivalent). MPL would have given a copyleft floor at the file level but adds a per-file header burden no contributor will remember. AGPL would close the door on commercial reuse — not what we want for a research-tooling client. MIT, period.

### 1.6 Tailwind 3 over Tailwind 4 / vanilla CSS / CSS-in-JS (2026-06-26)

- **Decision**: Tailwind 3.4 with `tailwind-merge` and `clsx`.
- **Alternatives**: Tailwind 4 (Oxide engine), CSS Modules, vanilla extract, Stitches.
- **Rationale**: v3 has shipped, has stable plugin ecosystem, has well-known patterns. v4 was still moving fast at scaffold time. Re-evaluate at v0.3.

### 1.7 Custom title bar (`decorations: false`, Overlay style) (2026-06-26)

- **Decision**: render our own title bar in React; hide native chrome.
- **Alternatives**: keep the native title bar, give up the brand surface.
- **Rationale**: on macOS the Overlay style + hidden title is the conventional way to claim the full top inset for a custom toolbar, matching Slack, Notion, Linear. On Windows we'll do the same via Mica + custom non-client area in Phase 2. The tradeoff is a non-trivial amount of drag-region wiring — accept it. See `TitleBar.tsx`.

### 1.8 Minisign-signed updater (2026-06-26)

- **Decision**: enable `tauri-plugin-updater` with the dialog flow and a minisign public key.
- **Alternatives**: Sparkle (mac-only), squirrel (win-only), no auto-update.
- **Rationale**: the Tauri 2 updater verifies signatures with minisign on every update bundle, ships built-in on all three OSes, and integrates with `tauri-plugin-process` for restart. The public key in `tauri.conf.json` is currently a placeholder string — **must** be replaced with the real base64 minisign pubkey before the first release tag. The corresponding private key lives in CI secrets only.

### 1.9 Disable updater plugin in debug builds (2026-06-26)

- **Decision**: `#[cfg(not(debug_assertions))]` around the updater plugin registration in `src-tauri/src/lib.rs`.
- **Alternatives**: leave it on, route to a dev endpoint.
- **Rationale**: debug-loop developers don't want an updater dialog on every reload, and the dev endpoint would just be noise. Production builds always get the real plugin.

### 1.10 No telemetry by default (2026-06-26)

- **Decision**: no telemetry, no error reporting, no analytics in v0.1.
- **Alternatives**: Sentry, posthog, or a custom error pipeline behind an opt-in flag.
- **Rationale**: a biomedical research user's session log can contain identifiable data (patient ID strings, gene names tied to ongoing studies, IRB-controlled PDFs). The bar for shipping telemetry must include explicit user consent and a redaction pipeline, neither of which is built. Until both ship, the shell sends nothing home except the version string in the updater request (which is necessary for the update endpoint to know what to serve).

---

## 2. Layer diagram

```
+----------------------------------------------------------------------+
|                        BioClaw Desktop process                       |
|                                                                      |
|   +------------------------------------------------------------+     |
|   |              Tauri 2 main (Rust, src-tauri/src/)           |     |
|   |                                                            |     |
|   |   lib.rs           -> boot, plugin wiring, invoke handler  |     |
|   |   commands.rs      -> #[tauri::command] surface (4 cmds)   |     |
|   |   tray.rs          -> system tray icon + menu              |     |
|   |   capabilities/    -> per-window permission allowlist      |     |
|   |                                                            |     |
|   |   plugins: log dialog fs http notification os process      |     |
|   |            shell store window-state  (+updater in release) |     |
|   +------------------------------------------------------------+     |
|                                  |                                   |
|                                  |  tauri::invoke / events           |
|                                  v                                   |
|   +------------------------------------------------------------+     |
|   |     React 19 shell (Vite, src/)                            |     |
|   |                                                            |     |
|   |   App.tsx              -> top-level layout                 |     |
|   |   components/                                              |     |
|   |     TitleBar.tsx       -> drag region, window controls     |     |
|   |     SettingsDrawer.tsx -> right-side overlay panel         |     |
|   |     ConnectionGuard.tsx-> shows fallback while remote down |     |
|   |   lib/                                                     |     |
|   |     store.ts           -> Zustand: mode, urls, ui flags    |     |
|   |     init.ts            -> on-boot async init               |     |
|   +------------------------------------------------------------+     |
|                                  |                                   |
|                                  | <iframe src=remoteUrl>            |
|                                  v                                   |
|              +-----------------------------------+                   |
|              | https://chat.bioclaw.tech         |                   |
|              | (remote chat UI; CSP-whitelisted) |                   |
|              +-----------------------------------+                   |
+----------------------------------------------------------------------+
```

Notes:

- **`commands.rs` exists but is referenced in `lib.rs`, not authored yet at this commit** — the four invoke handlers (`app_version`, `reveal_in_finder`, `open_external_url`, `quit_app`) are stubs; flesh them out behind the capability allowlist. The path forward is documented in `CONTRIBUTING.md` § "How to add a new Tauri command".
- **`capabilities/default.json` should exist**; if it's missing, Tauri 2 will refuse to invoke any command. Adding a default capabilities file is the first task on the Phase 1 polish list.
- The iframe boundary is not a security boundary — the remote origin has full DOM access inside its own subtree. The CSP and capabilities together are what actually contain it.

---

## 3. Process model

Today (Phase 1) there is exactly one OS process:

```
bioclaw-desktop (single process)
+-- main thread        : Tauri runtime + tray + WebView host
+-- tokio runtime      : async tasks for plugins (HTTP, FS, log)
+-- WebView thread     : system webkit drives the page; its own JS event loop
```

The React shell talks to the Rust side via `tauri::invoke`, which serializes JSON over the WebView↔native bridge. Events go the other way via `app.emit_to(window_label, event, payload)`. There is no WebSocket or local HTTP server in the process today.

**Phase 2 adds a sidecar.** The plan:

```
bioclaw-desktop (parent)
+-- main + tokio + WebView   (as above)
+-- sidecar: bioclaw-agentd  (child, spawned via tauri-plugin-shell)
    +-- listens on 127.0.0.1:<ephemeral port>
    +-- exposes /v1/chat compatible with the SaaS API
    +-- WebView switches src to http://127.0.0.1:<port> when mode = 'local'
```

The sidecar will be a separately-built Rust binary distributed inside the Tauri bundle (`externalBin`). It must be CSP-allowed; today `connect-src` is locked to `chat.bioclaw.tech` only, so adding the sidecar will require a CSP edit at the Phase 2 commit.

**Phase 3 adds MCP servers.** Each MCP server is a separate process (stdio or local TCP) managed via the same `tauri-plugin-shell` lifecycle, but with stricter scoping: the user must explicitly enable each server, the server's manifest declares its tool surface, and tool calls go through a per-call consent UI before the sidecar dispatches them.

---

## 4. Security model

Layered defense, top to bottom:

### 4.1 Content Security Policy

From `src-tauri/tauri.conf.json`:

```
default-src 'self' tauri: ipc:;
connect-src 'self' tauri: ipc: https://chat.bioclaw.tech wss://chat.bioclaw.tech;
img-src    'self' data: blob: https:;
style-src  'self' 'unsafe-inline';
script-src 'self' 'unsafe-eval';
frame-src  https://chat.bioclaw.tech https://*.bioclaw.tech;
```

`'unsafe-eval'` is required by Vite's dev server and by some React 19 internals; we tolerate it for now and revisit when React drops the runtime eval. `'unsafe-inline'` for styles is necessary for Tailwind's `@apply`-generated runtime styles. Both are scoped to `'self'` only, so no remote script can inject into our own origin.

### 4.2 Capabilities allowlist

Tauri 2 requires every command and every plugin permission to be granted per window in `src-tauri/capabilities/<name>.json`. Today (scaffold state) the file should be `capabilities/default.json` targeting the `main` window with the minimum set: `core:default`, `shell:allow-open` (URL-only), `notification:default`, `store:default`. Adding a permission is a security-reviewable change — see `CONTRIBUTING.md`.

### 4.3 Signed updater

`tauri-plugin-updater` verifies each downloaded bundle against the minisign public key in `tauri.conf.json` before invoking the OS installer. The pubkey there today is a `PLACEHOLDER_REPLACE_BEFORE_RELEASE_WITH_REAL_BASE64_MINISIGN_PUBKEY` literal — **the first release blocker is replacing it with the real key**. The private key is held only in the release-CI secret store; no maintainer has a copy on their workstation.

### 4.4 OS keychain (Phase 2)

When the local sidecar lands it will need user-supplied API keys (OpenAI, Anthropic, OpenRouter, etc.). Those keys will live in:

- macOS: Keychain Services via `security-framework`.
- Windows: Credential Manager via `windows-rs::Security::Credentials::*`.
- Linux: Secret Service over D-Bus via `secret-service-rs`, falling back to a `tauri-plugin-stronghold` encrypted file when no daemon is available (common in lab Linux setups).

The wrapper crate is not in `Cargo.toml` yet. It belongs to Phase 2.

### 4.5 Threat model summary

The detailed threat model is in [`docs/SECURITY.md`](./SECURITY.md). Pointers:

- Prompt-injection content rendered from `chat.bioclaw.tech` is contained by the iframe-origin boundary plus the capability allowlist — no Tauri command is callable from inside the remote origin.
- Supply-chain risk on npm + Cargo is mitigated by `package-lock.json`, `Cargo.lock`, and CI dependency-review (to be added on the first PR after scaffold).
- Update tampering is mitigated by minisign + HTTPS.
- Clipboard exfiltration is mitigated by *not* granting `clipboard` plugin permissions to the remote origin's frame — the inner iframe declares `allow="clipboard-read; clipboard-write"` but that is a Permissions Policy delegation, gated by the outer CSP and the WebView's own permission prompts.

---

## 5. Roadmap details

### Phase 1 — Thin client (v0.1.x, current)

Done in this scaffold:
- Window, tray, plugins, CSP, updater wiring, iframe to remote.
- Build commands for mac / win / linux.

Polish list before tagging v0.1.0 GA:
- Add `capabilities/default.json` (likely missing in this scaffold).
- Implement the four stub commands in `commands.rs`.
- Replace the minisign pubkey placeholder.
- Add icons in `src-tauri/icons/` (the bundle config references five paths).
- Wire CI: lint, typecheck, test, `tauri build` smoke on all three OSes.
- Add `LICENSE` (MIT) and `SECURITY.md` at the repo root.

### Phase 2 — Local sidecar (v0.2.x)

- Build `bioclaw-agentd` as a separate Rust binary (likely a workspace member under `src-tauri/sidecar/`).
- Bundle via `externalBin`.
- Implement the `mode = 'local'` path in `src/App.tsx` — swap the iframe URL, show a sidecar-status pill in the title bar, surface a restart-sidecar command.
- Implement OS-keychain credential storage (see § 4.4).
- Extend CSP to allow `connect-src http://127.0.0.1:*` and `frame-src http://127.0.0.1:*`.

### Phase 3 — MCP-native tools (v0.3.x)

- Adopt `mcp-rs` (or equivalent) as the in-process MCP client crate.
- Build a registry UI under the settings drawer: list available servers, enable / disable each, view tool manifests, see per-tool call history.
- Add a per-tool-call consent prompt with "always allow for this session" / "always allow this server" / "deny once" semantics.
- Document recommended MCP servers (filesystem, fetch, git, sqlite) and ship preset configs for them.

---

## 6. References

- [Tauri 2 docs](https://v2.tauri.app/) — runtime architecture, plugin contracts, capabilities model.
- [Tauri Updater plugin](https://v2.tauri.app/plugin/updater/) — minisign verification flow.
- [Tauri Window-state plugin](https://v2.tauri.app/plugin/window-state/) — persistence guarantees.
- [Model Context Protocol](https://modelcontextprotocol.io/) — Phase 3 wire protocol.
- [opencode (sst/opencode)](https://github.com/sst/opencode) — TUI-first agent CLI, a reference for the sidecar agent shape.
- [Goose (block/goose)](https://github.com/block/goose) — MCP-native agent desktop UX, a reference for Phase 3.
- [Jan (menloresearch/jan)](https://github.com/menloresearch/jan) — MIT-licensed local-LLM desktop, a reference for the local-mode UX.
- BioClaw SaaS repo — the upstream chat UI and agent core that this client wraps. Internal; ask in the BioClaw dev Slack for access.
- React 19 release notes, Zustand 5 docs, Vite 6 docs — for version-specific upgrade notes when we bump.

This document will be expanded as the codebase grows. Treat it as living architecture, not signed-off design.
