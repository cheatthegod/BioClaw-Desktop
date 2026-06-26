# BioClaw Desktop

> A native desktop wrapper for [chat.bioclaw.tech](https://chat.bioclaw.tech) — the BioClaw biomedical research agent — built on Tauri 2, React 19, and Vite.

[![CI](https://img.shields.io/badge/CI-pending-lightgrey.svg)](#) [![Release](https://img.shields.io/badge/release-0.1.0--alpha-blue.svg)](#) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

BioClaw Desktop is the official, open-source desktop client for the BioClaw biomedical research agent. Phase 1 is a thin client: it opens a Tauri-managed native window, owns the title bar, system tray, settings drawer, and native interop (file dialogs, notifications, auto-update), and loads `chat.bioclaw.tech` inside a sandboxed WebView. Phases 2 and 3 will introduce a local agent runner and MCP-native tool integration respectively — see the [roadmap](#roadmap) for details.

The repository at this commit (version `0.1.0`) is the freshly scaffolded codebase. It is functional enough to launch a window pointed at the hosted BioClaw service, with a place to hang every future native feature.

---

## Features

What ships in this scaffold today:

- **Native desktop window** — custom overlay title bar (no OS chrome), 1280x820 default, remembers position and size across launches via `tauri-plugin-window-state`.
- **Thin-client mode** — loads `https://chat.bioclaw.tech` inside the WebView and treats it as the chat UI; the desktop shell only owns the surrounding chrome.
- **System tray** — a tray icon (template-rendered on macOS) with show/hide and quit; defined in `src-tauri/src/tray.rs`.
- **Auto-update wiring** — the Tauri updater plugin is configured against `https://chat.bioclaw.tech/desktop/updates/{{target}}/{{arch}}/{{current_version}}`. Disabled in `cargo run` debug builds; minisign public key is currently a placeholder and **must** be replaced before release.
- **Strict default CSP** — only `chat.bioclaw.tech` and its subdomains are allowed as connect / frame sources; nothing else loads.
- **Cross-platform bundling** — `npm run tauri:build:mac|win|linux` produces dmg / nsis+msi / AppImage+deb respectively. `wix.language` and an `nsis` Simplified Chinese installer language are pre-wired.

Explicitly **not** in v0.1: voice input, real-time multi-user collaboration, local LLM execution, MCP servers, offline chat history, or any custom chat UI. Those land in later phases.

---

## Quickstart for users

Pre-built installers will be published to the GitHub Releases page once the first signed build ships.

> Download (placeholder): https://github.com/bioclaw/bioclaw-desktop/releases/latest

OS support matrix for the v0.1 series:

| Platform | Minimum version            | Bundle format | Auto-update |
| -------- | -------------------------- | ------------- | ----------- |
| macOS    | 11 Big Sur (universal)     | `.dmg`        | yes         |
| Windows  | 10 1809 (x64)              | `.msi`/`.exe` | yes         |
| Linux    | webkit2gtk 4.1 (Ubuntu 22+)| `.AppImage`/`.deb` | yes (AppImage), manual (deb) |

The desktop app talks to `chat.bioclaw.tech`, so a BioClaw account is required to use it. Log in inside the WebView the same way you would in a browser.

---

## Quickstart for developers

### Prerequisites

- **Node.js 20+** (the `engines` field in `package.json` enforces this; 22 LTS recommended)
- **npm 10+** (ships with Node 20)
- **Rust stable** with `rustup` (Cargo edition 2021, `rust-version = 1.77` is the floor)
- Platform-specific system dependencies — see [`docs/BUILD.md`](./docs/BUILD.md) for the exact apt / brew / winget commands

### Install

```bash
git clone https://github.com/bioclaw/bioclaw-desktop.git
cd bioclaw-desktop
npm install
```

The first `cargo` build inside `src-tauri` will take several minutes — Tauri 2 plus the eleven enabled plugins is a large dep tree. Subsequent builds are incremental.

### Run in dev

```bash
npm run tauri:dev
```

This starts Vite on `http://localhost:1420`, then launches a debug build of the Tauri shell pointing at it. Edits to `src/**` hot-reload; edits to `src-tauri/**` restart the Rust process. The updater plugin is intentionally disabled in debug builds (see `src-tauri/src/lib.rs`).

### Build

```bash
npm run tauri:build          # native target for the current host
npm run tauri:build:mac      # universal Apple darwin
npm run tauri:build:win      # x86_64-pc-windows-msvc
npm run tauri:build:linux    # x86_64-unknown-linux-gnu
```

Artifacts land under `src-tauri/target/<target>/release/bundle/`. Signing identities are `null` in `tauri.conf.json` — release-grade signing belongs in CI secrets, not the repo.

Other useful scripts:

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint, zero warnings allowed
npm run format       # prettier write + (informally) cargo fmt
npm run clean        # nuke dist, src-tauri/target, vite cache
```

---

## Architecture overview

```
+---------------------------------------------------------------+
|                    BioClaw Desktop process                    |
|                                                               |
|  +---------------------+        +---------------------------+ |
|  | Tauri main (Rust)   |  IPC   |  WebView (system webkit)  | |
|  |  - tray, updater    |<------>|   React 19 + Vite shell   | |
|  |  - plugins (11)     |        |   - TitleBar              | |
|  |  - typed commands   |        |   - SettingsDrawer        | |
|  |  - capabilities     |        |   - ConnectionGuard       | |
|  +---------------------+        +-------------+-------------+ |
|                                               |               |
|                                               | <iframe>      |
|                                               v               |
|                            +----------------------------------+
|                            | https://chat.bioclaw.tech (remote)|
|                            +----------------------------------+
+---------------------------------------------------------------+
```

- **Tauri main (Rust)** — `src-tauri/src/lib.rs` boots the runtime, registers plugins, exposes four invoke handlers (`app_version`, `reveal_in_finder`, `open_external_url`, `quit_app`), and installs the tray.
- **React shell** — `src/App.tsx` is a small Zustand-backed view layer. It renders a custom title bar, a settings drawer, and an iframe pointed at `chat.bioclaw.tech`. State lives in `src/lib/store.ts` and intentionally stays small — chat state belongs to the remote app.
- **Remote chat** — the hosted BioClaw service does the actual LLM orchestration, RAG, and tool calls today. The desktop shell never sees raw model traffic.

The CSP in `src-tauri/tauri.conf.json` only whitelists `chat.bioclaw.tech` and its subdomains for `connect-src` / `frame-src`; the rest of the page is locked to `'self'` with `'unsafe-eval'` permitted for Vite-bundled React in dev. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full layer diagram and decision log, and [`docs/SECURITY.md`](./docs/SECURITY.md) for the threat model.

---

## Roadmap

The desktop is being built in three phases, each independently shippable.

**Phase 1 — Thin client (current, v0.1.x).**
Native window + tray + updater wrapping `chat.bioclaw.tech`. The point is to give users a real desktop install (Dock icon, Start Menu shortcut, native notifications, OS-level window state) without forking the chat UI. This is what is in the repo now.

**Phase 2 — Local agent sidecar (v0.2.x).**
Ship an embedded agent runner as a Tauri sidecar binary. The `mode: 'local' | 'remote'` toggle already in `useAppStore` flips the WebView between `chat.bioclaw.tech` and `http://127.0.0.1:3000` served by the sidecar. The sidecar reuses the BioClaw-SaaS agent core but runs locally with user-supplied API keys held in the OS keychain.

**Phase 3 — MCP-native tool integration (v0.3.x).**
Expose desktop-side tools — file system, shell, browser automation, lab notebook ingestion — to the BioClaw agent through the [Model Context Protocol](https://modelcontextprotocol.io/). The Tauri command surface in `src-tauri/src/commands.rs` becomes the boundary between MCP servers and user data, gated by capabilities and per-session consent prompts.

A more granular breakdown lives in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## License

MIT. See [`LICENSE`](./LICENSE) for the full text.

The Tauri runtime is dual-licensed Apache-2.0 / MIT; React is MIT; all bundled npm and Cargo dependencies are MIT, Apache-2.0, BSD, ISC, or compatible. Run `cargo about` / `npm-license-checker` before each release.

---

## Acknowledgements

The desktop wouldn't have shipped this fast without the projects that have done this work openly before us. None of their code is vendored here — these are pure inspirations:

- [**Tauri**](https://tauri.app/) — the runtime that makes this possible at a sane binary size.
- [**opencode**](https://github.com/sst/opencode) — for showing how a TUI-first agent CLI can be cleanly wrapped in a desktop shell.
- [**Jan**](https://github.com/menloresearch/jan) — for the reference architecture of an MIT-licensed local LLM desktop.
- [**Goose**](https://github.com/block/goose) — for proving an MCP-native agent on the desktop is the right shape.

The BioClaw team thanks the maintainers of each.

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for branch strategy, commit style, code style, and the PR checklist. Security reports should go to **security@bioclaw.tech** privately — please do not open a public issue for vulnerabilities.

Internationalized README: [简体中文](./README.zh-CN.md).
