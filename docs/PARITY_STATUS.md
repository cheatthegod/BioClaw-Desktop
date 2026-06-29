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
| M0.2 MCP client + JSON-RPC framing | not-started | |
| M0.3 ship Rust sidecar as Tauri externalBin (drop Node) | not-started | needs per-target build + bundle config |
| M0.4 SQLite memory tools | not-started | |
| M0.5 CI 3-platform matrix | not-started | needs CI runners (mac/win) — not doable from this box |

## Phase 1 — keystone
| Milestone | Status | Notes |
|---|---|---|
| M1.1 generic authed streaming SaaS proxy | done | sidecar `/saas/*` + `/auth/session`; 3 integration tests + live-SaaS curl (16 GPU tools incl RNAGenesis/FoldMark, 401→typed auth, logout) |
| M1.2 typed frontend client + hooks | done | `src/lib/api/saas.ts` (saasGet/Post/Delete/Stream + iterateSse + session) + `useSaasQuery`/`useSaasStream`; tsc+eslint+vite green. Exercised by M2.1. |

## Phase 2 — panels
| Milestone | Status | Notes |
|---|---|---|
| M2.1 GPU Tools panel (RNAGenesis/FoldMark) | done | GpuToolsPanel: tool list grouped by category, dynamic param/file form, submit, live SSE job log, cancel, results; host-status badge. Wired via M1.2 hooks. Data path verified through the proxy (submit + SSE stream to done). GUI screenshot needs a display. |
| M2.2 chat history/threads | not-started | |
| M2.3 skills center (local+SaaS) | not-started | |
| M2.4 KB search | not-started | |
| M2.5 quota | not-started | |
| M2.6 projects+datasets+files | not-started | |
| M2.7 sharing | not-started | |
| M2.8 profile/account/feedback | not-started | |
| M2.9 paper-digest | not-started | |
| M2.10 contacts | not-started | |
| M2.11 lab module | not-started | |
| M2.12 manage | not-started | |
| M2.13 admin (gated) | not-started | |

## Phase 3 — local-first
| Milestone | Status | Notes |
|---|---|---|
| M3.1 local GPU inference option | not-started | |
| M3.2 offline mode | not-started | |
| M3.3 native notifications/tray/deeplinks/drag-drop | not-started | |

## Phase 4 — release
| Milestone | Status | Notes |
|---|---|---|
| M4.1 theming parity | not-started | |
| M4.2 i18n zh-CN+en | not-started | |
| M4.3 two-tier auto-update | not-started | |
| M4.4 code signing + per-platform installers | not-started | needs mac/win signing infra |
| M4.5 e2e acceptance on 3 OSes | not-started | needs 3 OSes with displays |
