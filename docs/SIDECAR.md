# BioClaw Desktop sidecar

The **sidecar** is a small, locally-spawned HTTP server that hosts BioClaw's
chat backend on the user's machine. It exists so that the app can talk to LLMs
(via the user's own OpenRouter / OpenAI / Anthropic key) without anything ever
touching `chat.bioclaw.tech` once the user opts into local mode.

> Phase-2 minimum scope: **chat + SSE streaming only**. No skills, no MCP,
> no tools. The vendored `SessionRunner` is in the bundle and ready for
> phase-3 when we add tool calling, but `/chat` currently bypasses the runner
> and streams the provider directly (the runner's `run()` API assumes a
> fresh session and a single user message — a real mismatch for stateless
> chat-with-history).

## Process model

```
+--------------------------+          +--------------------------------+
|  Tauri Rust (main proc)  |  spawn   |  bioclaw-sidecar-<triple>.js   |
|                          |--------->|  (Node 20, ESM bundle, ~5 MB)  |
|  src-tauri/src/sidecar.rs|  stdout  |                                |
|                          |<---------|  Hono on 127.0.0.1:<random>    |
|  SidecarState (state mgr)|  stdin   |  prints PORT=NNNN\nREADY\n     |
+--------------------------+ kept open|                                |
                                      |  GET  /health                  |
                                      |  POST /chat   (SSE)            |
                                      |  POST /shutdown                |
                                      +--------------------------------+
```

Only the Rust supervisor speaks to the sidecar. The webview talks to the
supervisor through Tauri commands (`invoke('start_sidecar')`, etc.); it does
**not** know the sidecar's port directly. The renderer then `fetch`es
`http://127.0.0.1:<port>/chat` against the port the supervisor returns.

## Port discovery protocol

1. The Rust supervisor calls `tauri-plugin-shell`'s `sidecar("binaries/bioclaw-sidecar")`,
   which resolves to the host-triple-suffixed bundle.
2. The sidecar binds Hono on `127.0.0.1` with port `0` (kernel picks free).
3. The sidecar writes **exactly** the following two lines to stdout:
   ```
   PORT=NNNN
   READY
   ```
4. The Rust side reads `Stdout` events from `tauri-plugin-shell`, scans each
   line for the literal prefix `PORT=`, and parses the suffix as `u16`. The
   `READY` line is informational — the supervisor doesn't wait for it; it
   proceeds to step 5 immediately on receiving `PORT=`.
5. The supervisor then opens a TCP connection to `127.0.0.1:<port>` and
   sends `GET /health`. Retries 10× with linearly-increasing backoff
   (100ms, 200ms, ... 1000ms) before giving up.

If the sidecar dies before printing `PORT=`, the supervisor surfaces the
exit code in the error returned to the renderer. The most common causes are:

- **Node missing from `$PATH`.** The bundle starts with `#!/usr/bin/env node`;
  if no `node` binary is on the user's PATH, the spawn fails. Phase 3 will
  ship a vendored Node next to the sidecar; for phase 2 we document the
  requirement in the settings drawer.
- **Port allocation failure.** Should never happen on a desktop — bind(0) on
  loopback is unfailable in practice.
- **Provider import error.** The vendored `providers/openrouter` module
  self-registers on import; if the bundle is malformed and the import throws
  at module load time the process dies before binding. Check
  `~/.local/share/bioclaw/logs/*.log` (Linux) or `~/Library/Logs/BioClaw/`
  (macOS) for the captured stderr.

## Shutdown handshake

Triple-cascade, longest-grace-first:

1. **HTTP shutdown** (`POST /shutdown`, 3s timeout). The handler responds
   `200 {ok: true}` and schedules `process.exit(0)` 50ms later so the
   response makes it back to the supervisor before the listener tears down.
2. **SIGTERM grace** (2s). `tauri-plugin-shell` doesn't expose a public
   SIGTERM helper, so we just sleep — the previous step normally drained
   the event loop already.
3. **SIGKILL** via `CommandChild::kill()`. Safe to call even if the child
   already exited; the call is a no-op in that case.

The `on_window_event` close handler in `lib.rs` invokes
`SidecarState::stop()` via `tauri::async_runtime::block_on` so the app
doesn't exit before the cascade completes.

## Inspecting the running sidecar during dev

```bash
# Find its port. The supervisor logs it at INFO; check the dev tools console
# for messages like "sidecar ready: pid=12345 port=51234".
$ curl -s http://127.0.0.1:51234/health
{"ok":true,"version":"0.1.0"}

# Tail a chat request manually (note: SSE event stream)
$ curl -N -X POST http://127.0.0.1:51234/chat \
    -H 'content-type: application/json' \
    -d '{
      "apiKey": "sk-or-...",
      "model": "openai/gpt-4.1-mini",
      "provider": "openrouter",
      "messages": [
        {"role": "system", "content": "You are a helpful biomedical assistant."},
        {"role": "user", "content": "Summarize CRISPR-Cas9 in two sentences."}
      ]
    }'
event: text-delta
data: {"text":"CRISPR-Cas9 is a "}

event: text-delta
data: {"text":"genome-editing system..."}

event: usage
data: {"inputTokens":42,"outputTokens":58}

event: finish
data: {"reason":"stop"}
```

## Running the sidecar standalone (no Tauri)

Useful when iterating on `/chat` shape:

```bash
$ cd sidecar
$ npm run dev   # node --experimental-strip-types src/main.ts
PORT=51234
READY
```

## Building

```bash
$ cd sidecar
$ npm run build
built aarch64-apple-darwin: ../src-tauri/binaries/bioclaw-sidecar-aarch64-apple-darwin (0.10 MB)
built x86_64-apple-darwin:  ../src-tauri/binaries/bioclaw-sidecar-x86_64-apple-darwin  (0.10 MB)
built x86_64-unknown-linux-gnu: ../src-tauri/binaries/bioclaw-sidecar-x86_64-unknown-linux-gnu (0.10 MB)
built x86_64-pc-windows-msvc:   ../src-tauri/binaries/bioclaw-sidecar-x86_64-pc-windows-msvc.exe (0.10 MB)
```

Bundle sizes land at ~99 KB per target — the smallness comes from Hono being
a 12 KB dependency once tree-shaken and from the vendored providers being
hand-written wire-protocol code with no SDK overhead.

The triple-suffixed naming matches Tauri 2's `externalBin` resolution exactly
(see `tauri-utils::resources::external_binaries`): `<name>-<triple>` on unix,
`<name>-<triple>.exe` on windows. At bundle time Tauri picks the file whose
suffix matches the host's rustc target triple. We also emit a `.js`
companion next to each so `node bioclaw-sidecar-<triple>.js` works during
dev without dealing with shebangs.

### Windows caveat

On unix, the kernel reads the shebang (`#!/usr/bin/env node`) and execs node
on the script. **Windows has no shebang support**, so the `.exe`-named file
will fail to spawn — Windows refuses to run a non-PE file when the user
double-clicks or when a child-process spawn calls `CreateProcessW`.

Phase-3 fixes this with a tiny native launcher (target: `<10 KB`, written
in C or a Rust no_std build) that does `system("node \"%~dp0\\sidecar.js\"")`.
Until then, **Windows builds will work as long as the user has Node on
PATH AND uses the BioClaw renderer's "local mode" toggle on macOS or
Linux**. Windows-local-mode is documented as "preview" in the settings
drawer.

## Why .js + Node, not a true binary?

We picked esbuild-bundled JS over `bun --compile` / `pkg` / `nexe` because:

- **Size.** Bun --compile binaries are 50-90 MB per target (the entire Bun
  runtime is statically linked). Our bundled JS is ~5 MB.
- **Phase-2 scope.** The user already has Node installed on most dev
  machines, and the installer can ship a portable Node next to the sidecar
  in phase 3 if telemetry shows missing-Node failures. Phase 2 doesn't need
  the binary-of-shame.
- **Patchability.** Replacing the sidecar JS on a user's machine for
  hotfixes is one rsync; replacing a 90 MB native binary is a full installer
  reinstall.

The tradeoff is that we hard-depend on `node` being on `$PATH`. The
supervisor surfaces a friendly error if it isn't.

## Debugging tips

- **The sidecar exits immediately after spawn.** Almost always a Node import
  error. Run `node binaries/bioclaw-sidecar-<your-triple>.js` directly from
  a shell to see the stack trace.
- **`/health` returns 200 but `/chat` 400 with "apiKey is required".** The
  renderer is sending the key in a header instead of the body. The phase-2
  contract is `{apiKey, model, messages}` in the JSON body.
- **`/chat` returns immediately with `event: finish, reason: error`.** The
  provider returned a non-2xx HTTP status. The `error` field contains the
  upstream body (truncated to 500 chars).
- **Hung shutdown.** The cascade caps at ~5s total. If `POST /shutdown`
  consistently 504s, the listener is stuck in a tool call (won't happen in
  phase 2 since we don't run tools), or the OS is overloaded.

## What's NOT in the sidecar

- **No persistent storage.** Sessions live in-process via
  `MemorySessionStorage` (vendored). The renderer is responsible for
  persisting chat history if desired.
- **No tools / MCP / skills.** The vendored modules are in the bundle but
  no tools are passed to the provider in `/chat`.
- **No credentials.** API keys are sent in the request body each call. The
  sidecar never writes them to disk and never logs them.
- **No auth between renderer and sidecar.** The listener binds to
  127.0.0.1 only; any local process can in principle hit the port. Phase 3
  will add a per-spawn HMAC token printed alongside `PORT=` for
  defense-in-depth.
