// Adapted from sst/opencode (Apache-2.0). See docs/VENDORED.md for the diff.
//
// Original source: packages/opencode/src/mcp/index.ts in github.com/sst/opencode.
// We keep the three-transport shape (stdio / SSE / streamable HTTP) and the
// retry-then-degrade flow opencode uses for remote connects. Effect, OAuth,
// notifications, prompts, resource templates, and the InstanceState plumbing
// are dropped; phase 3 will reintroduce OAuth via the Tauri shell plugin.

import type {
  McpClient,
  McpClientConfig,
  McpStatus,
  McpTool,
  McpToolResult,
  McpContentPart,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The MCP SDK is only loaded on demand. Phase 1 doesn't ship it — the spec is
 * stable in 2026 but we don't want every dev build to download the SDK before
 * we actually have an MCP-using feature. `loadSdk()` throws a friendly error
 * if the dep is missing.
 *
 * To enable: `npm i @modelcontextprotocol/sdk` (peer dep, see package.json).
 */
type SdkModule = {
  Client: new (info: { name: string; version: string }, opts?: { capabilities?: object }) => SdkClient;
  StdioClientTransport: new (opts: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: 'pipe' | 'inherit' | 'ignore';
  }) => SdkTransport;
  SSEClientTransport: new (
    url: URL,
    opts?: { requestInit?: { headers?: Record<string, string> } },
  ) => SdkTransport;
  StreamableHTTPClientTransport: new (
    url: URL,
    opts?: { requestInit?: { headers?: Record<string, string> } },
  ) => SdkTransport;
};

interface SdkTransport {
  close(): Promise<void>;
}

interface SdkClient {
  connect(transport: SdkTransport): Promise<void>;
  listTools(opts?: { timeout?: number }): Promise<{ tools: ReadonlyArray<SdkToolDef> }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    schema?: undefined,
    opts?: { timeout?: number },
  ): Promise<{ content?: ReadonlyArray<RawContent>; isError?: boolean }>;
  close(): Promise<void>;
  onclose?: () => void;
}

interface SdkToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

type RawContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }
  | { type: string; [k: string]: unknown };

let cachedSdk: SdkModule | null = null;
let sdkLoadError: Error | null = null;

async function loadSdk(): Promise<SdkModule> {
  if (cachedSdk) return cachedSdk;
  if (sdkLoadError) throw sdkLoadError;
  try {
    // Dynamic import so the bundler treats this as optional. The SDK exposes
    // submodules under `@modelcontextprotocol/sdk/<path>.js`. We deliberately
    // do not let TypeScript resolve these specifiers (the SDK is an *optional*
    // peer dep — see `peerDependenciesMeta` in package.json). The `as string`
    // tricks `import()` into accepting the path without compile-time lookup.
    const sdkRoot = '@modelcontextprotocol/sdk' as string;
    const [coreMod, stdioMod, sseMod, httpMod] = (await Promise.all([
      import(/* @vite-ignore */ `${sdkRoot}/client/index.js`),
      import(/* @vite-ignore */ `${sdkRoot}/client/stdio.js`),
      import(/* @vite-ignore */ `${sdkRoot}/client/sse.js`),
      import(/* @vite-ignore */ `${sdkRoot}/client/streamableHttp.js`),
    ])) as [
      { Client: SdkModule['Client'] },
      { StdioClientTransport: SdkModule['StdioClientTransport'] },
      { SSEClientTransport: SdkModule['SSEClientTransport'] },
      { StreamableHTTPClientTransport: SdkModule['StreamableHTTPClientTransport'] },
    ];
    cachedSdk = {
      Client: coreMod.Client,
      StdioClientTransport: stdioMod.StdioClientTransport,
      SSEClientTransport: sseMod.SSEClientTransport,
      StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
    };
    return cachedSdk;
  } catch (err) {
    sdkLoadError = new Error(
      '@modelcontextprotocol/sdk is not installed. Run `npm i @modelcontextprotocol/sdk` ' +
        'before using BioClaw\'s MCP client. Underlying error: ' +
        (err instanceof Error ? err.message : String(err)),
    );
    throw sdkLoadError;
  }
}

/**
 * Timebox a promise. Opencode uses `withTimeout` from `@/util/timeout`; we
 * inline a 10-line equivalent so we don't grow a util/ folder this early.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP ${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface ClientState {
  current: McpStatus;
  sdkClient: SdkClient | null;
  transport: SdkTransport | null;
}

/**
 * Internal: construct an McpClient around an already-connected SDK client.
 * Centralizes status tracking, list/call wrappers, and close semantics so
 * the three public `connect*` entry points stay tiny.
 */
function makeClient(
  config: McpClientConfig,
  state: ClientState,
  transportLabel: McpClient['transport'],
): McpClient {
  const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;

  return {
    name: config.name,
    transport: transportLabel,
    status: () => state.current,
    async listTools() {
      if (!state.sdkClient) throw new Error(`MCP client "${config.name}" is not connected`);
      const result = await withTimeout(state.sdkClient.listTools({ timeout }), timeout, 'listTools');
      return result.tools.map(normalizeTool);
    },
    async callTool(name, params) {
      if (!state.sdkClient) throw new Error(`MCP client "${config.name}" is not connected`);
      const raw = await withTimeout(
        state.sdkClient.callTool({ name, arguments: params }, undefined, { timeout }),
        timeout,
        `callTool(${name})`,
      );
      return normalizeResult(raw);
    },
    async close() {
      state.current = { status: 'disabled' };
      const sdkClient = state.sdkClient;
      state.sdkClient = null;
      state.transport = null;
      if (sdkClient) await sdkClient.close().catch(() => undefined);
    },
  };
}

function normalizeTool(def: SdkToolDef): McpTool {
  const schema =
    def.inputSchema && typeof def.inputSchema === 'object'
      ? (def.inputSchema as McpTool['inputSchema'])
      : { type: 'object' as const, properties: {} };
  return {
    name: def.name,
    description: def.description,
    inputSchema: schema,
  };
}

function normalizeResult(raw: { content?: ReadonlyArray<RawContent>; isError?: boolean }): McpToolResult {
  const content: McpContentPart[] = [];
  let text = '';
  for (const part of raw.content ?? []) {
    if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
      const t = (part as { text: string }).text;
      content.push({ type: 'text', text: t });
      text += (text ? '\n' : '') + t;
    } else if (
      part.type === 'image' &&
      typeof (part as { data?: unknown }).data === 'string' &&
      typeof (part as { mimeType?: unknown }).mimeType === 'string'
    ) {
      content.push({
        type: 'image',
        data: (part as { data: string }).data,
        mimeType: (part as { mimeType: string }).mimeType,
      });
    } else if (part.type === 'resource' && (part as { resource?: unknown }).resource) {
      const res = (part as { resource: { uri: string; mimeType?: string; text?: string } }).resource;
      content.push({ type: 'resource', resource: res });
      if (res.text) text += (text ? '\n' : '') + res.text;
    }
    // Unknown content parts are dropped silently; the LLM doesn't need them.
  }
  return { text, isError: raw.isError === true, content };
}

async function connectWith(
  config: McpClientConfig,
  transportLabel: McpClient['transport'],
  makeTransport: (sdk: SdkModule) => SdkTransport,
): Promise<McpClient> {
  const sdk = await loadSdk();
  const state: ClientState = {
    current: { status: 'connecting' },
    sdkClient: null,
    transport: null,
  };
  const client = makeClient(config, state, transportLabel);

  const sdkClient = new sdk.Client(
    { name: 'bioclaw-desktop', version: '0.1.0' },
    { capabilities: { roots: {} } },
  );
  const transport = makeTransport(sdk);
  const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;

  try {
    await withTimeout(sdkClient.connect(transport), timeout, `connect(${transportLabel})`);
  } catch (err) {
    state.current = {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
    // Release the transport on failure — opencode's `acquireUseRelease` pattern.
    await transport.close().catch(() => undefined);
    throw err;
  }

  sdkClient.onclose = () => {
    if (state.sdkClient === sdkClient) {
      state.current = { status: 'failed', error: 'Connection closed' };
      state.sdkClient = null;
    }
  };

  state.sdkClient = sdkClient;
  state.transport = transport;
  state.current = { status: 'connected' };
  return client;
}

/**
 * Spawn a local MCP server over stdio. `env` is merged on top of the parent
 * process env (opencode does the same). On Tauri this runs in the Node-style
 * sidecar, not the WebView — call it from the Rust-spawned helper, not the
 * renderer.
 */
export function connectStdio(
  name: string,
  command: string,
  args: readonly string[] = [],
  env?: Readonly<Record<string, string>>,
  opts?: { timeout?: number },
): Promise<McpClient> {
  const config: McpClientConfig = {
    name,
    transport: 'stdio',
    command,
    args,
    env,
    timeout: opts?.timeout,
  };
  return connectWith(config, 'stdio', (sdk) => {
    // `process.env` is Node-only; we guard for the rare case this gets
    // imported into the renderer (where it'd be undefined).
    const baseEnv =
      typeof process !== 'undefined' && process.env
        ? (process.env as Record<string, string | undefined>)
        : {};
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(baseEnv)) if (typeof v === 'string') mergedEnv[k] = v;
    if (env) for (const [k, v] of Object.entries(env)) mergedEnv[k] = v;
    return new sdk.StdioClientTransport({
      command,
      args: args.slice(),
      env: mergedEnv,
      stderr: 'pipe',
    });
  });
}

/** Connect to a remote MCP server over SSE (legacy transport). */
export function connectSse(
  name: string,
  url: string,
  headers?: Readonly<Record<string, string>>,
  opts?: { timeout?: number },
): Promise<McpClient> {
  const config: McpClientConfig = { name, transport: 'sse', url, headers, timeout: opts?.timeout };
  return connectWith(config, 'sse', (sdk) => {
    const parsed = new URL(url);
    return new sdk.SSEClientTransport(parsed, headers ? { requestInit: { headers: { ...headers } } } : undefined);
  });
}

/** Connect to a remote MCP server over streamable HTTP (modern transport). */
export function connectHttpStream(
  name: string,
  url: string,
  headers?: Readonly<Record<string, string>>,
  opts?: { timeout?: number },
): Promise<McpClient> {
  const config: McpClientConfig = { name, transport: 'http', url, headers, timeout: opts?.timeout };
  return connectWith(config, 'http', (sdk) => {
    const parsed = new URL(url);
    return new sdk.StreamableHTTPClientTransport(
      parsed,
      headers ? { requestInit: { headers: { ...headers } } } : undefined,
    );
  });
}

/**
 * Connect a remote MCP server, trying streamable HTTP first then falling
 * back to SSE — same pattern opencode uses in `connectRemote`. Returns the
 * first transport that succeeds.
 */
export async function connectRemoteAuto(
  name: string,
  url: string,
  headers?: Readonly<Record<string, string>>,
  opts?: { timeout?: number },
): Promise<McpClient> {
  try {
    return await connectHttpStream(name, url, headers, opts);
  } catch (httpErr) {
    try {
      return await connectSse(name, url, headers, opts);
    } catch (sseErr) {
      const httpMsg = httpErr instanceof Error ? httpErr.message : String(httpErr);
      const sseMsg = sseErr instanceof Error ? sseErr.message : String(sseErr);
      throw new Error(`MCP connect failed for "${name}": http=${httpMsg}; sse=${sseMsg}`);
    }
  }
}
