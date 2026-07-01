# BioClaw Desktop — feature-parity status

Tracking the goal in `docs/GOAL_full_parity.md`. One row per feature/milestone.
Status: not-started / in-progress / done / N-A (with reason).

> Environment note: this work happens on a **headless Linux H100 box** (no
> display). Sidecar (Rust HTTP server) milestones are verified end-to-end with
> `curl` against the live SaaS. Frontend (React/Tauri GUI) milestones are
> verified by `npm run build` (tsc+vite) + curl of the data flow they drive;
> true GUI "run + screenshot" verification needs a desktop session and is
> deferred to a machine with a display.

## Phase 0 — foundation
| Milestone | Status | Notes |
|---|---|---|
| M0.1 device session token → keychain | done | keychain persist/restore already existed (auth.ts); added the bridge in AuthedShell pushing the token to the sidecar on boot/login (setSaasSession) + clearing on logout, so the /saas/* proxy is authenticated. tsc+eslint+vite green. |
| M0.2 MCP client + JSON-RPC framing | done (client) | mcp module: stdio line-framed JSON-RPC 2.0 client (initialize→tools/list→tools/call) + adapter (McpTool→namespaced ToolSchema mcp__server__tool). 3 tests incl integration vs a real Python mock server (echo round-trip). Spawning configured servers into the live chat loop is the remaining wiring. |
| M0.3 ship Rust sidecar as externalBin | done (CI) | scripts/build-sidecar-rs.sh builds sidecar-rs per target → src-tauri/binaries/bioclaw-sidecar-<triple>; wired into ci.yml + release.yml so the bundled binary is the Rust one (tauri.conf externalBin already points there). Script verified locally (4.7MB linux binary placed). Full Node-dir removal + GUI spawn check deferred to a desktop session. |
| M0.4 SQLite memory tools | done | memory module (rusqlite bundled) + memory_write/read/search chat tools; 4 unit tests incl persist-across-reopen; clippy+test+release green. |
| M0.5 CI 3-platform matrix | done (authored) | ci.yml build-matrix (linux/macos-14/windows) + release.yml build&sign; build the Rust sidecar per target via build-sidecar-rs.sh. **Bug fixed (would have failed first push):** both workflows still (a) built the obsolete Node `sidecar/` bundle and (b) on Windows **overwrote the real Rust `.exe` with the dead Node launcher** → shipped a broken Windows sidecar. Removed both steps; build-sidecar-rs.sh is now the sole sidecar producer on all 3 OSes (emits `.exe` for Windows). YAML re-validated. First real run 2026-07-01: mac+win build-matrix GREEN (10m/14m); linux hit the 60-min timeout because the default `targets:all` AppImage step hangs on FUSE-less runners — fixed by pinning linux to `--bundles deb` (proven-fast) in both workflows. |

## Phase 1 — keystone
| Milestone | Status | Notes |
|---|---|---|
| M1.1 generic authed streaming SaaS proxy | done | sidecar `/saas/*` + `/auth/session`; 3 integration tests + live-SaaS curl (16 GPU tools incl RNAGenesis/FoldMark, 401→typed auth, logout) |
| M1.2 typed frontend client + hooks | done | `src/lib/api/saas.ts` (saasGet/Post/Delete/Stream + iterateSse + session) + `useSaasQuery`/`useSaasStream`; tsc+eslint+vite green. Exercised by M2.1. |

## Phase 2 — panels
| Milestone | Status | Notes |
|---|---|---|
| M2.1 GPU Tools panel (RNAGenesis/FoldMark) | done | GpuToolsPanel: tool list grouped by category, dynamic param/file form, submit, live SSE job log, cancel, results; host-status badge. Wired via M1.2 hooks. Data path verified through the proxy (submit + SSE stream to done). GUI screenshot needs a display. |
| M2.2 chat history/threads | done | Hub "历史/History" tab: lists the user's threads (/threads) and, on selecting one, shows its recent messages read-only (/messages?chatJid=…, `enabled`-gated). Complements the live local-chat surface (which only shows the current conversation) with access to past threads. Response shapes read from channel.ts (`{threads:[{chatJid,title}]}`, `{messages:[{sender,content,timestamp,is_from_me}]}`). Verified: npm build green, eslint clean; rides the unit+live-tested /saas proxy. |
| M2.3 skills center (SaaS) | done | SaaS catalog tab in SaasHubPanel (/saas/skills); local catalog already in chat. |
| M2.4 KB search | done | KB tab (/saas/kb/search?q=) in SaasHubPanel. |
| M2.5 quota | done | Quota tab (/saas/quota/my-requests + /quota/request) in SaasHubPanel. |
| M2.6 projects+datasets (+files) | done (+download) | 项目与数据 hub tab (/saas/projects + /saas/datasets); GPU panel does file upload AND now download. Workspace-file download wired: sidecar `/saas-files/*` proxies to the SaaS top-level `/files/chat/<chatJid>/<relPath>` route (outputs live outside `/api/`), cookie-attached + streaming; GPU JobView renders each output as a ↓ download button (blob+anchor save). Verified: unit test (mock upstream, cookie attach + `/files` path mapping), live smoke (real SaaS → typed 401), npm build green, AND code-correctness cross-check — `workspaceFileUrl()` is byte-identical to the SaaS web client's own `/files/chat/${encodeURIComponent(chatJid)}/${relPath.split('/').map(encodeURIComponent).join('/')}` builder (channel.ts:3918), and a real done-job's `outputFiles` are the workspace-root-relative shape the helper expects (e.g. `uploads/gpu-<id>/output/…/model_0.cif`). Only the actual click-to-save-dialog (and a fresh authed RNAGenesis/FoldMark run) needs a display. Full multi-folder file browser still deferred. |
| M2.7 sharing | done | 分享 hub tab now full CRUD: list (/share/my) + **create** (POST /share/chat, default `unlisted` mode → shows the `/share/<id>` link) + **revoke** (DELETE /share/<id>), all via the keystone proxy. Body/response shapes read from BioClaw-SaaS channel.ts (not guessed). Verified: npm build green, eslint clean; the underlying /saas proxy is unit+live-tested. Actual POST round-trip needs an authed session (display). |
| M2.8 profile/account/feedback | done | Account tab (/saas/profile + /config redacted + /feedback/message) in SaasHubPanel. |
| M2.9 paper-digest | done | 论文摘要 hub tab (/saas/paper-digest/list). |
| M2.10 contacts | done | 联系人 hub tab (/saas/contacts → contacts+invites). |
| M2.11 lab module | done (read) | 实验室 hub tab (/saas/lab/feed, read-only). |
| M2.12 manage | done | 管理 hub tab (/saas/manage/overview + status; server-gated, 403 handled). |
| M2.13 admin (gated) | done | 管理员 hub tab — hidden unless /saas/admin/overview returns 200 (non-admins get 403/404 → "无管理员权限"). |

## Phase 3 — local-first
| Milestone | Status | Notes |
|---|---|---|
| M3.1 local GPU inference option | done (probe) | sidecar `GET /gpu/local-envs` scans `$HOME/miniconda3/envs` + `$BIOCLAW_GPU_ENVS_DIR`; GPU panel shows "N GPU envs ready on this machine" footer when present (default execution stays cloud). Live-verified: 34 envs incl. foldmark/boltz. |
| M3.2 offline mode | done | OfflineBanner + useSaasReachable: proxy returns 502 when SaaS unreachable → global banner; local chat/skills/env keep working. 502 path verified via curl. |
| M3.3 native notifications/tray/deeplinks/drag-drop | done (build-verified) | **Tray**: Show/Quit menu + left-click focus (tray.rs, pre-existing). **Notifications**: src/lib/notify.ts wraps @tauri-apps/plugin-notification (lazy permission, no-ops outside Tauri); JobView fires one native notification on terminal status (done/failed/cancelled). **Drag-drop**: window `dragDropEnabled:false` lets the webview get HTML5 file drops → existing `handleFile(File)` upload path (no fs-scope widening, no security tradeoff); GPU file inputs are drop zones with a "drop to upload" hint. **Deep links**: tauri-plugin-deep-link + `bioclaw://` scheme; lib.rs registers `register_all()` + `on_open_url` → focus window + emit `deep-link` event to the webview; `deep-link:default` capability added. Verified by building: cargo release build + clippy -D warnings green, npm build green, `.deb` rebuilt, and `dpkg-deb -x` confirms the installed `BioClaw.desktop` carries `MimeType=x-scheme-handler/bioclaw`. GUI interaction (actual drop / click / OS URL routing, and Linux cross-launch `%u` forwarding which benefits from the single-instance plugin) still needs a desktop session. |

## Phase 4 — release
| Milestone | Status | Notes |
|---|---|---|
| M4.1 theming parity | partial | new panels use sage palette tokens + match existing patterns; full pixel audit needs a display |
| M4.2 i18n zh-CN+en | done | src/lib/i18n.ts (zh+en, useT/translate, system-default persisted locale, 中文/English toggle). Fully migrated: GpuToolsPanel, SaasHubPanel (all tabs+content), SettingsDrawer, OfflineBanner, App nav — 0 residual CJK in their JSX. prettier+eslint+vite green. |
| M4.3 two-tier auto-update | N-A-on-this-host | needs signing + an update server |
| M4.4 code signing config | done (config) / N-A (run) | release.yml already wires Apple notarization + Windows cert + Tauri updater signing from secrets.* (keys never committed, no-op when empty). Producing the *signed* mac/win installers needs CI runners + the certs — user-side. |
| M4.4b Linux installer (built here) | done | `npm run tauri build --bundles deb` produces `BioClaw_0.2.0_amd64.deb` (294MB) bundling the real 4.7MB **Rust** sidecar (`usr/bin/bioclaw-sidecar`) + `uv` + the app. Linux pkgs need no signing cert. Unblocked by the Cargo.lock fix below. |
| M4.5 e2e acceptance on 3 OSes | N-A-on-this-host | needs 3 OSes with displays |

> **Build-system fix (also unblocks CI on all 3 platforms):** the lockfile had resolved `proc-macro-crate v3.5.0`, which forces the broken `toml_edit v0.25.12+spec-1.1.0` (TOML-1.1 preview crate that fails to compile — "can't find crate for toml_parser/toml_datetime/indexmap"). Pinned `proc-macro-crate` to `3.4.0` (uses the stable `toml_edit 0.23.10+spec-1.0.0`); kept `zbus`/`zbus_macros` matched at 5.16.0. Without this, `cargo build` of the Tauri app fails identically on every OS, so CI would have been red. Verified: full release build + .deb bundle succeed locally.

> Note: ApiKeysPanel.tsx is dead code (unused since device-code auth dropped the API-key UI, Stage D) — its residual zh strings are not rendered. SetupWizard remains zh-first; "清华源" is a proper noun (Tsinghua PyPI mirror).
