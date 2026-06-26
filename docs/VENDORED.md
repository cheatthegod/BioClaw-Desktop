# Vendored modules

This document tracks every file in `src/` whose design is adapted from a
third-party open-source project. We do not vendor binaries or copy files
verbatim; we port the *shape* and call out the divergence. Required for
license hygiene (BioClaw Desktop is MIT; everything below is Apache-2.0,
which is one-way compatible — we preserve attribution headers in each file).

Last reviewed: 2026-06-26.

## sst/opencode (Apache-2.0)

Upstream: <https://github.com/sst/opencode>
Upstream commit basis: HEAD of `main` at the time of the desktop-agent
survey (snapshot in `/lambda/nfs/file2/cqr_files/Bioclaw_paper/desktop-agent-survey/opencode`).
Upstream license: `Apache-2.0` (`LICENSE` at repo root).

### Ported files

| Our path                          | Upstream source                                              | Ported |
| --------------------------------- | ------------------------------------------------------------ | ------ |
| `src/lib/mcp/types.ts`            | `packages/opencode/src/mcp/index.ts` (type surface only)     | 2026-06-26 |
| `src/lib/mcp/client.ts`           | `packages/opencode/src/mcp/index.ts` (connect/list/call)     | 2026-06-26 |
| `src/lib/agent/types.ts`          | `packages/opencode/src/session/{message-v2,llm}.ts` + tool/  | 2026-06-26 |
| `src/lib/agent/session.ts`        | `packages/opencode/src/session/{llm,processor,retry}.ts`     | 2026-06-26 |
| `src/lib/agent/storage.ts`        | `packages/opencode/src/session/session.ts` (event log)       | 2026-06-26 |
| `src/lib/providers/index.ts`      | `packages/opencode/src/session/llm/{native-request,native-runtime}.ts` + `provider/provider.ts` | 2026-06-26 |
| `src/lib/providers/openrouter.ts` | `packages/opencode/src/session/llm/native-request.ts` (OpenRouter branch) | 2026-06-26 |

### What we changed

- **No Effect.js.** Every `Effect.fn`, `Effect.gen`, `Layer`, `Stream`, and
  `Schema.Struct` is replaced with plain Promise-based TypeScript. Discriminated
  unions replace `Schema.Union`; `AbortController` replaces `Effect.Scope` for
  cancellation; `AsyncIterable` replaces `Stream.Stream`.
- **No Bun.** No `Bun.spawn`, no `Bun.file`. We use Node 20+ APIs only
  (`fetch`, `ReadableStream`, `TextDecoder`, `crypto.getRandomValues`) so the
  modules run unmodified in both Node and the Tauri WebView where applicable.
- **No `ai` SDK / no per-provider SDK.** Opencode's default path goes through
  Vercel `ai`'s `streamText`. We ported the *native* runtime path only and
  speak the OpenAI / Anthropic / Ollama wire formats over plain `fetch`.
- **No OAuth.** Opencode's MCP client includes a full OAuth 2.1 + dynamic
  client registration flow. Phase 1 ships stdio + SSE + streamable-HTTP
  transports without OAuth. Phase 3 will reintroduce it via Tauri's shell
  plugin for the system browser redirect.
- **No permission engine.** Opencode prompts the user before destructive
  tool calls via `Permission.ask`. We drop that for phase 1 and rely on the
  caller wrapping `ToolDefinition.handler` if they need approval gates.
- **No SQLite.** The `SessionStorage` interface is in-memory in phase 1.
  Phase 2 will add a `TauriStoreSessionStorage` backed by `tauri-plugin-store`.
- **No agents-spawning-agents, no todo lists, no snapshots, no OpenTelemetry.**
- **`@modelcontextprotocol/sdk` is loaded via dynamic `import()`** so the
  bundler treats it as optional. The MCP client throws a friendly error if
  the dep isn't present. It is *not* a hard dep in `package.json`; add it
  with `npm i @modelcontextprotocol/sdk` when wiring MCP up in phase 2.

### What we preserved

- The three-transport shape for MCP (`stdio` / `sse` / `http`) and the
  remote-with-fallback connect order.
- The durable event log invariant: every tool call is appended to storage
  BEFORE the handler runs, so a crash mid-tool leaves a replayable trail.
- Parallel tool dispatch (`Promise.all`) within a step.
- Step-limit + transient-error retry with exponential backoff.
- The `tool` / `assistant` / `user` / `system` message split that maps
  cleanly to both OpenAI's `tool_calls` shape and Anthropic's
  `tool_use` / `tool_result` content blocks.

### Attribution

Each ported file starts with:

```
// Adapted from sst/opencode (Apache-2.0). See docs/VENDORED.md for the diff.
```

A copy of the Apache-2.0 license text is available at
<https://www.apache.org/licenses/LICENSE-2.0>. We are not redistributing the
unmodified source, so a `LICENSE-opencode` file is not required, but we keep
this VENDORED.md current as the equivalent NOTICE.
