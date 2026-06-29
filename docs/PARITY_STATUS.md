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
| M0.5 CI 3-platform matrix | done (authored) | ci.yml build-matrix (linux/macos-14/windows) + release.yml build&sign; now also build the Rust sidecar per target. YAML validated. Actually RUNNING it needs the repo on GitHub Actions (mac/win runners) — that is the user trigger, not codeable here. |

## Phase 1 — keystone
| Milestone | Status | Notes |
|---|---|---|
| M1.1 generic authed streaming SaaS proxy | done | sidecar `/saas/*` + `/auth/session`; 3 integration tests + live-SaaS curl (16 GPU tools incl RNAGenesis/FoldMark, 401→typed auth, logout) |
| M1.2 typed frontend client + hooks | done | `src/lib/api/saas.ts` (saasGet/Post/Delete/Stream + iterateSse + session) + `useSaasQuery`/`useSaasStream`; tsc+eslint+vite green. Exercised by M2.1. |

## Phase 2 — panels
| Milestone | Status | Notes |
|---|---|---|
| M2.1 GPU Tools panel (RNAGenesis/FoldMark) | done | GpuToolsPanel: tool list grouped by category, dynamic param/file form, submit, live SSE job log, cancel, results; host-status badge. Wired via M1.2 hooks. Data path verified through the proxy (submit + SSE stream to done). GUI screenshot needs a display. |
| M2.2 chat history/threads | deferred | overlaps the existing local-chat surface; SaaS /messages reachable via proxy if a unified history view is wanted |
| M2.3 skills center (SaaS) | done | SaaS catalog tab in SaasHubPanel (/saas/skills); local catalog already in chat. |
| M2.4 KB search | done | KB tab (/saas/kb/search?q=) in SaasHubPanel. |
| M2.5 quota | done | Quota tab (/saas/quota/my-requests + /quota/request) in SaasHubPanel. |
| M2.6 projects+datasets (+files) | done (lists) | 项目与数据 hub tab (/saas/projects + /saas/datasets); GPU panel does file upload; full file browser/download deferred. |
| M2.7 sharing | done (read) | 分享 hub tab (/saas/share/my); create-share action deferred. |
| M2.8 profile/account/feedback | done | Account tab (/saas/profile + /config redacted + /feedback/message) in SaasHubPanel. |
| M2.9 paper-digest | done | 论文摘要 hub tab (/saas/paper-digest/list). |
| M2.10 contacts | done | 联系人 hub tab (/saas/contacts → contacts+invites). |
| M2.11 lab module | done (read) | 实验室 hub tab (/saas/lab/feed, read-only). |
| M2.12 manage | done | 管理 hub tab (/saas/manage/overview + status; server-gated, 403 handled). |
| M2.13 admin (gated) | done | 管理员 hub tab — hidden unless /saas/admin/overview returns 200 (non-admins get 403/404 → "无管理员权限"). |

## Phase 3 — local-first
| Milestone | Status | Notes |
|---|---|---|
| M3.1 local GPU inference option | not-started | buildable here (probe local conda env); deferred |
| M3.2 offline mode | done | OfflineBanner + useSaasReachable: proxy returns 502 when SaaS unreachable → global banner; local chat/skills/env keep working. 502 path verified via curl. |
| M3.3 native notifications/tray/deeplinks/drag-drop | not-started | tray scaffolded; notifications/deeplinks need a desktop session to verify |

## Phase 4 — release
| Milestone | Status | Notes |
|---|---|---|
| M4.1 theming parity | partial | new panels use sage palette tokens + match existing patterns; full pixel audit needs a display |
| M4.2 i18n zh-CN+en | done | src/lib/i18n.ts (zh+en, useT/translate, system-default persisted locale, 中文/English toggle). Fully migrated: GpuToolsPanel, SaasHubPanel (all tabs+content), SettingsDrawer, OfflineBanner, App nav — 0 residual CJK in their JSX. prettier+eslint+vite green. |
| M4.3 two-tier auto-update | N-A-on-this-host | needs signing + an update server |
| M4.4 code signing config | done (config) / N-A (run) | release.yml already wires Apple notarization + Windows cert + Tauri updater signing from secrets.* (keys never committed, no-op when empty). Producing the signed installers needs CI runners + the certs — user-side. |
| M4.5 e2e acceptance on 3 OSes | N-A-on-this-host | needs 3 OSes with displays |

> Note: ApiKeysPanel.tsx is dead code (unused since device-code auth dropped the API-key UI, Stage D) — its residual zh strings are not rendered. SetupWizard remains zh-first; "清华源" is a proper noun (Tsinghua PyPI mirror).
