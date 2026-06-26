// providers-bridge — SINGLE SOURCE OF TRUTH for provider wiring inside the
// sidecar.
//
// Why this file exists:
//   The vendored provider implementations live at `src/lib/providers/` in the
//   main app (so the renderer can also import them directly, e.g. during
//   future in-process modes). The sidecar bundle reuses the SAME modules — we
//   do NOT fork them. esbuild walks the import graph and inlines whatever it
//   finds; the bridge below is the one and only place where sidecar code
//   reaches across the workspace boundary.
//
// If you ever need to add a provider, do it in `src/lib/providers/` and either
//   - register it via `registerProvider(...)` at module load time
//     (e.g. the openrouter provider auto-registers when imported), OR
//   - export a class here and let the consumer call `registerProvider`.
//
// Phase-2 minimum scope means we only NEED openai-compatible + openrouter for
// the user's "enter your OpenRouter key and chat" flow. Anthropic and Ollama
// come along for free because they're already in the registry.

// IMPORTANT: importing `openrouter` for its side-effect — it registers itself
// in the shared REGISTRY map inside `providers/index.ts`. Without this import
// `getProvider('openrouter')` throws "Unknown provider".
//
// Path note: these paths are relative to the sidecar source dir. esbuild
// resolves them at bundle time; no Node ESM lookups happen at runtime because
// every module is inlined into bioclaw-sidecar-<target>.js.
import '../../src/lib/providers/openrouter';
import '../../src/lib/providers/bioclaw-proxy';

export {
  getProvider,
  registerProvider,
  type Provider,
  type ProviderEvent,
  type ProviderStreamRequest,
} from '../../src/lib/providers/index';

export type {
  AgentEvent,
  AgentMessage,
  AgentResult,
  ModelSpec,
  ProviderId,
  ToolDefinition,
  ToolHandlerContext,
  ToolHandlerResult,
} from '../../src/lib/agent/types';

export { SessionRunner } from '../../src/lib/agent/session';
export type { SessionRunnerOptions } from '../../src/lib/agent/session';

export {
  MemorySessionStorage,
  type SessionRecord,
  type SessionStorage,
} from '../../src/lib/agent/storage';
