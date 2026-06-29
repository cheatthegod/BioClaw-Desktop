# GOAL: BioClaw Desktop → full feature parity with the BioClaw website

> Paste this whole file as the goal for an autonomous ("goal mode") run.
> It is self-contained: an agent with repo access should be able to execute
> it milestone by milestone without further clarification.

---

## 0. Mission

Turn **BioClaw Desktop** (`/lambda/nfs/file2/cqr_files/Bioclaw_paper/BioClaw-Desktop-v2`,
Tauri 2 + React/TS shell with a Rust sidecar) into a **complete native client of
the BioClaw SaaS** — every feature a user can reach on the website
(`chat.bioclaw.tech`, served from `/home/ubuntu/Bioclaw_dev/BioClaw-SaaS`) must be
usable from the desktop app — **plus** the local-first capabilities the desktop
uniquely offers (offline skills, bundled Python env, local model inference).

"Done" = a signed installer for macOS / Windows / Linux where a user signs in
once (device-code) and can do everything the web UI does, with no feature that
silently 404s or dead-ends.

---

## 1. Architecture decision (do NOT re-litigate)

The desktop is a **native client to the same SaaS backend**, not a re-implementation.

```
React UI ──http──> local Rust sidecar (127.0.0.1) ──https + session cookie──> chat.bioclaw.tech/api/*
                         │
                         ├─ local-first: skills loader, bundled Python env, local model inference
                         └─ keychain: device-code session token (never in the renderer)
```

The single most important primitive to build first is a **generic authenticated
SaaS proxy in the sidecar** (Milestone 1). Once it exists, every SaaS feature is
"just" a React panel that calls `http://127.0.0.1:<port>/saas/<path>` — the
sidecar attaches the session cookie, handles streaming, and keeps the token out
of the webview. This is the same pattern the existing chat already uses
(`bioclaw-proxy`).

Features split into three buckets:
- **Proxy-backed** (call the SaaS): chat history, GPU jobs, projects, datasets,
  docs/drive, sharing, contacts, KB, paper-digest, lab module, manage, admin,
  quota, profile/config.
- **Local-first** (run on the user's machine): skills catalog, Python env setup,
  permission gating, local model inference, memory.
- **Hybrid**: chat completions (already proxied), GPU tools (dispatch is on the
  SaaS H100 host today; keep that — the desktop is a thin client to `/api/gpu/*`).

---

## 2. Current state — already DONE, do not redo

Rust sidecar (`sidecar-rs/`) is ported through **Stage L.7**:
- L.1 axum skeleton + tracing + workspace lock
- L.2 skill catalog loader + `GET /skills`
- L.3 env state machine + `GET /env/state` + `POST /env/setup` (SSE, uv driver)
- L.4 `POST /chat` SSE + openai-compatible + bioclaw-proxy provider + bounded loop
- L.5 persistent permissions + `POST /permissions/{decide,preload}`
- L.6 `invoke_skill` + `run_skill_script` tools + chat tool dispatch + skill-ranked system prompt
- L.7 device-code auth client + `POST /auth/device-code/{start,poll}` (RFC 8628). **SaaS side of L.7 lives uncommitted in `/lambda/nfs/file2/.../BioClaw-SaaS` working tree — reconcile/deploy it to the production copy `/home/ubuntu/Bioclaw_dev/BioClaw-SaaS` before relying on device-code in prod.**

Frontend components that exist: `LocalChat`, `LoginGate`, `ModelPicker`,
`PermissionPrompt`, `SettingsDrawer`, `SetupWizard`, `EnvInstallBanner`,
`ApiKeysPanel`, `ApiKeyMissingBanner`, `TitleBar`.

src-tauri: `commands.rs`, `credentials.rs` (OS keychain), `sidecar.rs`
(supervisor — reads `PORT=`/`READY` from sidecar stdout), `tray.rs`.

The Rust sidecar (`sidecar-rs`) is NOT yet the shipped binary — the Tauri shell
still spawns the Node sidecar (`sidecar/`). Swapping that is Milestone 0.3.

---

## 3. Hard constraints / guardrails (NEVER violate)

1. Install everything to **files2** (`/lambda/nfs/file2/cqr_files/Bioclaw_paper/...`), never to `/home/ubuntu/`.
2. **Never** commit `.signing-keys/` or any private key / cert. They stay out of git.
3. **Never** send the real OpenRouter / NVIDIA / any production API key to an external endpoint, or bake it into the client. The desktop authenticates as a user (device-code) and the SaaS holds the upstream keys.
4. Do **not** break or restart the production `bioclaw` systemd service without explicit confirmation. The website serves real users.
5. The production SaaS canonical copy is `/home/ubuntu/Bioclaw_dev/BioClaw-SaaS` (systemd runs `tsx src/index.ts` from there). The files2 copy is a separate branch — don't confuse them.
6. Every milestone must end **green**: `cargo build --release` + `cargo clippy --all-targets -- -D warnings` + `cargo test` for the sidecar; `npm run build` (tsc + vite) for the frontend; `cargo fmt`/`prettier` applied. No milestone is "done" with warnings.
7. One git commit per milestone, with a body that lists what was verified. Branch off `main`; do not force-push.
8. Keep the **sage palette + fonts** visual language already established (Stage E). New panels must look native to the app, not bolted on.
9. Bilingual: the user is a Chinese researcher — UI strings go through an i18n layer with zh-CN + en (Milestone P4.2). Don't hardcode English.

---

## 4. Feature-parity matrix (website → desktop)

Authoritative list of SaaS route groups (from
`BioClaw-SaaS/src/channels/local-web/channel.ts`). Each maps to a desktop
milestone. Priority: P0 = must-have core, P1 = important, P2 = nice-to-have,
SKIP = server-only / N/A on a single-user desktop (still reachable read-only if
trivial via the proxy, but no dedicated build effort).

| Website area | SaaS endpoints | Desktop plan | Prio |
|---|---|---|---|
| Auth (device-code) | `/api/auth/cli-*`, `send-otp`, `verify-otp`, `logout`, `magic` | keychain session + LoginGate (device-code) | P0 |
| Chat completions | `/api/desktop/chat/completions`, `/chat` | already done (sidecar) | done |
| Chat history/threads | `/api/chats`, `/api/messages`, `/api/messages/stop`, `/api/events` (SSE) | ChatHistory panel + thread list + stop | P0 |
| Skills | `/api/skills`, `/api/skills/` | local catalog (done) + SaaS skills merge | P0 |
| **GPU tools** | `/api/gpu/tools`, `/api/gpu/jobs`, `/api/gpu/jobs/<id>` (SSE), `/api/gpu/host/status` | **GpuToolsPanel: tool list, param form, submit, live job log, output download** (incl. RNAGenesis/FoldMark) | P0 |
| Projects | `/api/projects`, `/api/projects/` | ProjectsPanel (list/create/open) | P1 |
| Datasets | `/api/datasets`, `/api/datasets/` | DatasetsPanel | P1 |
| Docs / CloudDocs / Drive | `/api/docs`, `/api/clouddocs`, `/api/drive` | FilesPanel (browse/upload/download) | P1 |
| Sharing | `/api/share/chat`, `/api/share/file`, `/api/share/my`, `/api/share/view/` | Share dialog + "my shares" | P1 |
| Contacts / invites | `/api/contacts`, `/api/contacts/invites` | ContactsPanel | P2 |
| KB search | `/api/kb/search` | KB search box in chat | P1 |
| Paper digest | `/api/paper-digest/list`, `/prefs` | PaperDigestPanel | P2 |
| Lab module | `/api/lab/*` (feed, rooms, mentions, notifications, presence, leaderboard, profile, resources, wishlist, meeting) | LabPanel (read + post); presence/notifications in a sidebar bell | P2 |
| Manage | `/api/manage/*` (agents, tasks, workspaces, doctor, command, overview, status) | ManagePanel (admin-of-own-workspace) | P2 |
| Admin | `/api/admin/*` (users, requests, quota, spend) | AdminPanel — render ONLY if session is admin | P2 |
| Quota | `/api/quota/*` | quota badge + request dialog | P1 |
| Profile / config / feedback | `/api/profile`, `/api/config`, `/api/feedback/message` | Settings → Account + Feedback | P1 |

When in doubt on a P2 lab/social feature that is inherently multi-user
(presence, leaderboard, live rooms), implement it as a **read-mostly thin
client** — show the data, allow posting where it makes sense, don't rebuild the
realtime server.

---

## 5. Milestones (ordered; each is one commit, each ends green)

### Phase 0 — Finish the Rust foundation (close out Stage L)

**M0.1 — process_token separation (Stage L.8).** The device-code poll already
mints a per-device session token (`bioclaw_session`). Persist it in the OS
keychain via `src-tauri/credentials.rs`, separate from any user cookie, so a lost
device can be revoked SaaS-side without logging the user out of the web.
*Accept:* token survives app restart; `Logout` clears only the keychain entry.

**M0.2 — JSON-RPC framing + MCP client (Stage L.10 + L.11).** Add an
`mcp` module to the sidecar: spawn skill-declared MCP servers, expose their tools
through the same `chat::tools::registry` so the chat loop can call them.
*Accept:* a sample MCP server's tool is callable end-to-end from `/chat`.

**M0.3 — Ship the Rust sidecar as the externalBin (Stage L.13).** Build
`bioclaw-sidecar` per target, register it as a Tauri `externalBin`, update
`src-tauri/src/sidecar.rs` to spawn it (it already prints `PORT=`/`READY`), and
delete the Node `sidecar/` from the bundle. *Accept:* app launches, `/health`
returns 200, no Node on the user's PATH is required.

**M0.4 — Persistent memory tools (Stage L.12).** SQLite-backed memory tools
(`memory_write`/`memory_read`/`memory_search`) in the sidecar, surfaced as chat
tools. Store under the workspace dir. *Accept:* a memory written in one session
is recalled in the next.

**M0.5 — CI per-platform (Stage L.14).** GitHub Actions matrix
(macos/windows/ubuntu) that builds the Rust sidecar + Tauri app, runs
clippy/test/tsc, and uploads unsigned artifacts. *Accept:* green CI on a PR.

### Phase 1 — Authenticated SaaS proxy (the keystone)

**M1.1 — Generic SaaS proxy route.** In the sidecar add `ANY /saas/*path` that
forwards to `<SAAS_BASE>/api/*path`, attaching `Cookie: bioclaw_session=<token>`
from the keychain, copying method/headers/body, and **streaming** the response
(so SSE endpoints like `/api/events` and `/api/gpu/jobs/<id>` pass through).
Strip hop-by-hop headers. 401 from upstream → surface a typed
`{ error: "auth", loginUrl }` so the UI can trigger re-auth.
*Accept:* `curl 127.0.0.1:<port>/saas/gpu/tools` returns the 16 tools when signed
in; an SSE endpoint streams.

**M1.2 — Typed frontend API client.** `src/lib/api/saas.ts`: a thin typed
wrapper over the proxy (`get/post/stream`), with a React `useSaasQuery` hook
(loading/error/data) and a `useSaasStream` hook for SSE. All feature panels use
this — no panel calls `fetch` directly.
*Accept:* one panel (GPU tools, M2.1) is fully wired through it.

### Phase 2 — Feature-parity panels (one milestone each; build P0 → P1 → P2)

Each panel milestone follows the same recipe:
*scaffold the React panel → wire it to the SaaS proxy via the typed client →
match the web UI's data + actions → handle empty/error/loading/offline →
add to the app's nav → verify against the live SaaS with a signed-in session →
screenshot the production build (not a dev override).*

**M2.1 — GPU Tools panel (P0, do first — the user just added RNAGenesis/FoldMark).**
- List tools from `/saas/gpu/tools` grouped by category; show estimated time/GPU mem.
- Dynamic param form from each tool's `params` (enum/number/boolean/string) + file inputs from `inputs[]` (upload to the workspace, then reference by relative path).
- Submit `POST /saas/gpu/jobs`; render a live job view that streams `/saas/gpu/jobs/<id>` (status, stdout/stderr tail), a cancel button (`/cancel`), and a results list with download.
- Host status badge from `/saas/gpu/host/status` (GPU free mem, selected host).
*Accept:* from the built app, submit a real `rnagenesis-design` job (4 seqs) and a `foldmark-watermark` job (short peptide) and see them reach `done` with downloadable FASTA / CIF. (Both are verified working server-side as of 2026-06-29.)

**M2.2 — Chat history / threads (P0).** Thread list from `/saas/chats`, load
`/saas/messages`, live updates via `/saas/events` (SSE), stop via
`/saas/messages/stop`. Reconcile with the existing local `/chat` so the user sees
one unified conversation list. *Accept:* history persists across restarts; stop works.

**M2.3 — Skills center (P0).** Merge the local catalog (`/skills`) with SaaS
skills (`/saas/skills`); show source + whether each needs API key / GPU; let the
user invoke a skill into the chat. *Accept:* both local and SaaS skills listed; invoke works.

**M2.4 — KB search (P1).** Search box (`/saas/kb/search`) with results
insertable into chat context. *Accept:* query returns hits; insert works.

**M2.5 — Quota (P1).** Quota badge (from `/saas/quota/my-requests` / config) +
"request more" dialog (`/saas/quota/request`). *Accept:* badge reflects server; request posts.

**M2.6 — Projects + Datasets + Files (P1).** Three panels over
`/saas/projects`, `/saas/datasets`, `/saas/{docs,clouddocs,drive}`: list, open,
create, upload, download. Use native file dialogs (Tauri `dialog` plugin).
*Accept:* create a project, upload a file, download it back.

**M2.7 — Sharing (P1).** "Share" action on a chat / file → `POST
/saas/share/{chat,file}`; "My shares" list (`/saas/share/my`); open a shared link.
*Accept:* share a chat, see it in My shares, open the view URL.

**M2.8 — Profile / Account / Feedback (P1).** Settings → Account (read
`/saas/profile`, `/saas/config`), Feedback form (`/saas/feedback/message`),
Logout. *Accept:* profile renders; feedback posts; logout clears keychain.

**M2.9 — Paper digest (P2).** List (`/saas/paper-digest/list`) + prefs
(`/saas/paper-digest/prefs`). *Accept:* digest renders; prefs save.

**M2.10 — Contacts / invites (P2).** `/saas/contacts`, `/saas/contacts/invites`.
*Accept:* contacts list; invite posts.

**M2.11 — Lab module (P2).** A `LabPanel` with tabs over `/saas/lab/*`: feed,
rooms, mentions, notifications (bell with unread count + read-all), leaderboard,
members, profile/showcase, resources, wishlist. Realtime = poll
`/saas/lab/presence` + `/saas/lab/notifications` on an interval; don't rebuild a
websocket server. *Accept:* feed renders; post a message; notifications mark read.

**M2.12 — Manage (P2).** `/saas/manage/*`: overview, status, agents, tasks,
workspaces, doctor, command. Gate the destructive `command` action behind a confirm.
*Accept:* overview + status render; a safe command runs.

**M2.13 — Admin (P2, gated).** Render `AdminPanel` ONLY when the session is an
admin (probe `/saas/admin/overview` → 403 hides it). Users, requests
(approve/reject), quota requests, spend totals. *Accept:* non-admin never sees it; admin can approve a request.

### Phase 3 — Local-first superpowers (desktop-only advantages)

**M3.1 — Local GPU inference option.** Where a GPU tool has a local conda env on
the user's machine, offer "run locally" vs "run on BioClaw cloud". (Most users
won't have an H100 — default to cloud; expose local only when a probe finds the env.)
*Accept:* cloud path unchanged; local path appears only when env present.

**M3.2 — Offline mode.** When the SaaS is unreachable, the app still does local
chat (if a local model/key is configured), local skills, and the Python env. Show
a clear "offline — cloud features unavailable" banner; queue nothing silently.
*Accept:* pull the network → local chat + skills still work; cloud panels show the banner.

**M3.3 — Native niceties.** Tray actions (already scaffolded), native
notifications for finished GPU jobs, deep links (`bioclaw://`) for shared content,
drag-and-drop files into chat/GPU forms. *Accept:* a finished GPU job raises a native notification.

### Phase 4 — Polish & release

**M4.1 — Theming + UX parity.** Audit every panel against the web UI; sage
palette, fonts, spacing, empty/error states. No panel looks bolted-on.

**M4.2 — i18n (zh-CN + en).** Extract all strings to a resource bundle; language
toggle in Settings; default to system locale. *Accept:* switching to zh-CN translates the whole UI.

**M4.3 — Two-tier auto-update.** Desktop-shell updates (Tauri updater, signed)
+ core/skills/env updates (download into the writable env dir without reinstalling
the app). *Accept:* a bumped version is offered and applies.

**M4.4 — Code signing + per-platform installers.** macOS notarized `.dmg`,
Windows signed `.msi`/`.exe`, Linux `.deb`/`.AppImage`. Signing keys come from CI
secrets, never from git. *Accept:* CI produces signed installers for all three; each launches and reaches `/health`.

**M4.5 — End-to-end acceptance pass.** On each OS: install → sign in
(device-code) → run a GPU job (RNAGenesis) → open chat history → share a chat →
browse files → toggle language. Record a short clip / screenshots from the
**production** build. *Accept:* the Definition of Done (§6) holds on all three platforms.

---

## 6. Definition of Done

- A signed installer exists for macOS, Windows, Linux.
- Fresh install → device-code sign-in → no feature in §4 dead-ends or 404s
  (every P0/P1 panel works against the live SaaS; P2 panels render and do their
  primary action; SKIP/admin gated correctly).
- RNAGenesis and FoldMark are runnable from the GPU panel and return downloadable
  outputs.
- Works offline for local chat + skills + Python env, with a clear banner for
  cloud features.
- UI is bilingual (zh-CN/en) and matches the web's visual language.
- `cargo clippy -D warnings`, `cargo test`, `npm run build` all green; CI builds
  all three platforms.
- No secret/key committed; no production service disrupted without confirmation.

---

## 7. How to work (process for the goal-mode agent)

1. Read this file + `docs/ARCHITECTURE.md`, `docs/SIDECAR.md`, `docs/SECURITY.md`,
   `docs/BUILD.md`, `docs/RELEASE.md` before starting.
2. Work milestone by milestone in the order above. **Do not start a milestone
   until the previous one is committed and green.**
3. For each milestone: implement → `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test` (sidecar) and `npm run build` (frontend) → fix until green → verify the acceptance criterion **against the live SaaS with a real signed-in session** (don't trust code-reading; run it) → screenshot the production build → commit with a body that lists what was verified.
4. When a SaaS endpoint's shape is unknown, read it in
   `BioClaw-SaaS/src/channels/local-web/channel.ts` (search the pathname) — don't guess.
5. If a feature is genuinely server-only and can't sensibly run on a single-user
   desktop, say so in the commit and either gate it (admin) or make it
   read-only — don't silently skip without recording it.
6. Keep a running `docs/PARITY_STATUS.md` checklist (one row per §4 feature:
   not-started / in-progress / done / N-A-with-reason) and update it every milestone.
7. Never claim a milestone done without having run the built app and observed the
   behavior. "It compiles" is not "it works."

---

## 8. Quick reference

- Desktop repo: `/lambda/nfs/file2/cqr_files/Bioclaw_paper/BioClaw-Desktop-v2`
- Sidecar (Rust): `sidecar-rs/` — build `cargo build --release`, run `./target/release/bioclaw-sidecar serve`
- Frontend: `src/` (Vite + React + Tailwind), build `npm run build`, dev `npm run tauri dev`
- Tauri shell: `src-tauri/` (supervisor `src/sidecar.rs`, keychain `src/credentials.rs`)
- SaaS (prod, read for endpoint shapes): `/home/ubuntu/Bioclaw_dev/BioClaw-SaaS/src/channels/local-web/channel.ts`
- SaaS base URL: `https://chat.bioclaw.tech` (override `BIOCLAW_SAAS_BASE` for staging/local `http://127.0.0.1:3000`)
- GPU tools registry (for the panel's contract): `BioClaw-SaaS/src/gpu/tools.ts`
- Device-code: sidecar `POST /auth/device-code/{start,poll}` → keychain; SaaS `/api/auth/cli-{device-code,poll,approve}` + `/device` page.
```
```
