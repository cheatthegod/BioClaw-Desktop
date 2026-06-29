/**
 * Typed client for the SaaS proxy exposed by the local sidecar (M1.1).
 *
 * Every BioClaw-SaaS feature is reached through `http://127.0.0.1:<port>/saas/<path>`
 * — the sidecar attaches the device-code session cookie and streams the
 * response. Panels MUST go through this module (or the hooks in
 * `src/hooks/useSaasQuery.ts` / `useSaasStream.ts`) rather than calling
 * `fetch` directly, so auth + error handling stay in one place.
 */

const SIDECAR_HOST = '127.0.0.1';

/** Thrown when the SaaS returns 401 — the UI should trigger re-auth. */
export class SaasAuthError extends Error {
  readonly loginUrl: string;
  constructor(loginUrl = '/login') {
    super('Not authenticated with BioClaw');
    this.name = 'SaasAuthError';
    this.loginUrl = loginUrl;
  }
}

/** Thrown for any non-2xx, non-401 upstream/proxy failure. */
export class SaasError extends Error {
  readonly status: number;
  readonly detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'SaasError';
    this.status = status;
    this.detail = detail;
  }
}

function base(port: number): string {
  return `http://${SIDECAR_HOST}:${port}`;
}

function saasUrl(port: number, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base(port)}/saas${p}`;
}

interface RequestOpts {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

async function handle(res: Response): Promise<Response> {
  if (res.status === 401) {
    let loginUrl = '/login';
    try {
      const body = await res.clone().json();
      if (body && typeof body.loginUrl === 'string') loginUrl = body.loginUrl;
    } catch {
      /* non-JSON 401 */
    }
    throw new SaasAuthError(loginUrl);
  }
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = await res.clone().json();
      detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body);
    } catch {
      detail = await res
        .clone()
        .text()
        .catch(() => undefined);
    }
    throw new SaasError(res.status, `SaaS request failed (${res.status})`, detail);
  }
  return res;
}

/** GET `<saas>/<path>` and parse JSON. */
export async function saasGet<T = unknown>(
  port: number,
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const res = await fetch(saasUrl(port, path), {
    method: 'GET',
    headers: { accept: 'application/json', ...(opts.headers ?? {}) },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  await handle(res);
  return res.json() as Promise<T>;
}

/** POST JSON to `<saas>/<path>` and parse the JSON response (if any). */
export async function saasPost<T = unknown>(
  port: number,
  path: string,
  body?: unknown,
  opts: RequestOpts = {},
): Promise<T> {
  const res = await fetch(saasUrl(port, path), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  await handle(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** DELETE `<saas>/<path>`. */
export async function saasDelete<T = unknown>(
  port: number,
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const res = await fetch(saasUrl(port, path), {
    method: 'DELETE',
    headers: { accept: 'application/json', ...(opts.headers ?? {}) },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  await handle(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Open a streaming (SSE-style) connection to `<saas>/<path>`. Returns the raw
 * `Response`; use `iterateSse` to decode `event:`/`data:` frames. Throws
 * `SaasAuthError` on 401 before streaming begins.
 */
export async function saasStream(
  port: number,
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const res = await fetch(saasUrl(port, path), {
    method: opts.method ?? 'GET',
    headers: {
      accept: 'text/event-stream',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  await handle(res);
  return res;
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Decode an SSE response body into `{ event, data }` frames. Buffers across
 * chunk boundaries; yields once per blank-line-terminated frame.
 */
export async function* iterateSse(res: Response, signal?: AbortSignal): AsyncIterable<SseEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      // Frames are separated by a blank line (\n\n).
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── session handoff (M0.1 bridge) ───────────────────────────────────

/** Push the device-code session token into the sidecar (after login / on boot). */
export async function setSaasSession(port: number, token: string): Promise<void> {
  const res = await fetch(`${base(port)}/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new SaasError(res.status, 'failed to set session');
}

/** Whether the sidecar currently holds a session token. */
export async function getSaasSession(port: number): Promise<{ authenticated: boolean }> {
  const res = await fetch(`${base(port)}/auth/session`);
  if (!res.ok) return { authenticated: false };
  return res.json() as Promise<{ authenticated: boolean }>;
}

/** Clear the sidecar session (logout). */
export async function clearSaasSession(port: number): Promise<void> {
  await fetch(`${base(port)}/auth/session`, { method: 'DELETE' }).catch(() => undefined);
}
