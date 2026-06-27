// Adapted from sst/opencode (Apache-2.0). See docs/VENDORED.md for the diff.
//
// Original source: packages/opencode/src/mcp/index.ts in github.com/sst/opencode
// Effect.js + opencode-specific config plumbing has been removed; what remains
// is the small typed surface BioClaw needs for an MCP-over-stdio/SSE/HTTP client.

/**
 * Transport flavours the MCP spec defines. We support all three; the in-tree
 * client wires each one through `@modelcontextprotocol/sdk`'s respective
 * Transport implementation.
 *
 * - `stdio`: launches a child process and speaks JSON-RPC over stdin/stdout.
 *   Used for local tool servers (e.g. `npx -y @modelcontextprotocol/server-filesystem`).
 * - `sse`: HTTP SSE long-polling. Legacy remote transport, still common.
 * - `http`: streamable HTTP (POST with chunked/SSE responses), the newer
 *   remote transport. Prefer this over `sse` when the server supports it.
 */
export type McpTransport = 'stdio' | 'sse' | 'http';

/**
 * Connection config for a single MCP server. Mirrors the shape opencode uses
 * for `mcp.<name>` entries in its config, minus OAuth (we'll layer that in
 * phase 3 via Tauri's webview-based redirect flow rather than the SDK's
 * Node-only auth provider).
 */
export interface McpClientConfig {
  /** Human-readable name; used as a prefix when surfacing tool names. */
  readonly name: string;
  readonly transport: McpTransport;
  /** For `stdio`: argv[0]. Ignored for remote transports. */
  readonly command?: string;
  /** For `stdio`: argv[1..]. Ignored for remote transports. */
  readonly args?: readonly string[];
  /** For `stdio`: environment variables merged on top of `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
  /** For `sse` / `http`: the endpoint URL. Ignored for stdio. */
  readonly url?: string;
  /** Optional extra headers for remote transports (e.g. bearer token). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-server timeout in ms. Falls back to a 30s default. */
  readonly timeout?: number;
  /** If false, the client never connects (mirrors opencode's `enabled`). */
  readonly enabled?: boolean;
}

/**
 * A tool advertised by an MCP server. The SDK's `Tool` type is fairly loose;
 * we narrow `inputSchema` to a JSON Schema object since every server in the
 * wild returns one.
 *
 * NOTE: name is the *server-side* name (e.g. `read_file`). When surfacing
 * tools to an LLM we prefix it with the server name, opencode-style, to avoid
 * collisions across servers (`fs__read_file`).
 */
export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaObject;
}

/** Minimal JSON Schema shape we accept. We don't validate; the LLM does. */
export interface JsonSchemaObject {
  readonly type?: 'object';
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly [k: string]: unknown;
}

/** A request to invoke a tool on an MCP server. */
export interface McpToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * Result of a tool invocation. MCP responses are a list of content parts
 * (text, image, resource link); we flatten text parts into `text` for
 * convenience and keep the raw `content` array for callers that need it.
 *
 * `isError` is set when the server returned `isError: true` in its result
 * envelope. The call still resolved — the LLM should be shown the error so
 * it can self-correct.
 */
export interface McpToolResult {
  readonly text: string;
  readonly isError: boolean;
  readonly content: ReadonlyArray<McpContentPart>;
}

export type McpContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | {
      readonly type: 'resource';
      readonly resource: {
        readonly uri: string;
        readonly mimeType?: string;
        readonly text?: string;
      };
    };

/** Status of a single MCP server connection. Mirrors opencode's Status union. */
export type McpStatus =
  | { readonly status: 'connected' }
  | { readonly status: 'disabled' }
  | { readonly status: 'connecting' }
  | { readonly status: 'failed'; readonly error: string };

/**
 * Public client interface. Implementations are produced by the `connect*`
 * helpers in `./client.ts`. All methods are Promise-based — Effect, fibers,
 * and Bun-specific APIs have been deliberately removed.
 */
export interface McpClient {
  readonly name: string;
  readonly transport: McpTransport;
  readonly status: () => McpStatus;
  listTools(): Promise<readonly McpTool[]>;
  callTool(name: string, params: Readonly<Record<string, unknown>>): Promise<McpToolResult>;
  close(): Promise<void>;
}
