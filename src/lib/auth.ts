/**
 * BioClaw email-OTP login helpers. The desktop app talks to the SaaS's
 * existing `/api/auth/send-otp` and `/api/auth/verify-otp` endpoints
 * (same ones the web login at chat.bioclaw.tech uses).
 *
 * Flow:
 *   1. requestOtp(email) → SaaS emails a 6-digit code.
 *   2. verifyOtp(email, code) → SaaS sets a `bioclaw_session` cookie via
 *      Set-Cookie; we parse it out, return the opaque token.
 *   3. Caller stores token in OS keychain via lib/credentials.ts and
 *      hands it to /chat as `apiKey` with `provider: 'bioclaw-proxy'`.
 *
 * The desktop bundle does NOT keep the user's password (there isn't one
 * — OTP only). Logout = delete the keychain entry + clear in-memory state.
 */

import { credentials } from './credentials';

const DEFAULT_SAAS_BASE_URL = 'https://chat.bioclaw.tech';
const COOKIE_NAME = 'bioclaw_session';

export interface AuthError {
  readonly status: number;
  readonly message: string;
}

function saasBaseUrl(override?: string): string {
  if (override && override.length > 0) return override.replace(/\/+$/, '');
  // Optional vite env override so `npm run dev` can point at localhost.
  const viteEnv = (import.meta as { env?: Record<string, string> }).env;
  const fromEnv = viteEnv?.['VITE_BIOCLAW_SAAS_BASE_URL'];
  return (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_SAAS_BASE_URL).replace(/\/+$/, '');
}

/**
 * Ask the SaaS to send a 6-digit OTP to the given email. The SaaS
 * itself rate-limits per-email and per-IP — we surface its error
 * verbatim so the user understands "wait a minute, you already have a
 * code in flight".
 *
 * Throws AuthError on non-2xx.
 */
export async function requestOtp(email: string, saasUrlOverride?: string): Promise<void> {
  const base = saasBaseUrl(saasUrlOverride);
  const res = await fetch(`${base}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const detail = await safeReadJson(res);
    throw {
      status: res.status,
      message: detail?.['error'] ?? `Failed to send code (HTTP ${res.status})`,
    } satisfies AuthError;
  }
}

/**
 * Submit the OTP. On success the SaaS returns the session token in
 * the JSON body — the body path is the canonical one for desktop. The
 * SaaS ALSO sets a normal `Set-Cookie` so web users keep working
 * unchanged, but the desktop can't read Set-Cookie from a `fetch()`
 * response: `Set-Cookie` is a "forbidden response header name" per
 * the Fetch spec, no browser exposes it to JS regardless of
 * `Access-Control-Expose-Headers`. So we read body.token instead, and
 * only fall back to the cookie parser if a future SaaS version drops
 * the body-token shim (defensive, shouldn't fire today).
 *
 * Throws AuthError on non-2xx (wrong code, expired, allow-list reject).
 */
export async function verifyOtp(
  email: string,
  code: string,
  saasUrlOverride?: string,
): Promise<{ token: string; email: string }> {
  const base = saasBaseUrl(saasUrlOverride);
  const res = await fetch(`${base}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
    credentials: 'include',
    redirect: 'manual',
  });
  if (!res.ok) {
    const detail = await safeReadJson(res);
    throw {
      status: res.status,
      message: detail?.['error'] ?? `Invalid code (HTTP ${res.status})`,
    } satisfies AuthError;
  }
  const bodyJson = (await safeReadJson(res)) as
    | { ok?: boolean; token?: string; email?: string }
    | null;
  if (bodyJson?.token && bodyJson.token.length > 0) {
    return { token: bodyJson.token, email: bodyJson.email ?? email };
  }
  // Fallback: try the cookie parser. Will almost certainly return null
  // in a Tauri webview, but keeps the code resilient if the SaaS ever
  // drops the body-token field by accident.
  const setCookie =
    res.headers.get('set-cookie') ??
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()?.join('\n');
  const token = parseCookieValue(setCookie ?? '', COOKIE_NAME);
  if (!token) {
    throw {
      status: 500,
      message:
        'Server did not return a session token. ' +
        'Either the SaaS is out of date (missing body.token shim) or the response was tampered with.',
    } satisfies AuthError;
  }
  return { token, email };
}

/**
 * Convenience: full login pass after verifyOtp returns — saves the
 * token + email to the keychain so future launches skip the login
 * screen.
 */
export async function persistSession(email: string, token: string): Promise<void> {
  await credentials.save('bioclaw_session_token', token);
  await credentials.save('bioclaw_session_email', email);
}

/** Read a previously-saved session, if any. Returns null when absent. */
export async function loadStoredSession(): Promise<{ email: string; token: string } | null> {
  const [token, email] = await Promise.all([
    credentials.get('bioclaw_session_token'),
    credentials.get('bioclaw_session_email'),
  ]);
  if (!token || !email) return null;
  return { token, email };
}

/** Wipe the stored session. Idempotent. */
export async function clearStoredSession(): Promise<void> {
  await Promise.all([
    credentials.delete('bioclaw_session_token'),
    credentials.delete('bioclaw_session_email'),
  ]);
}

function parseCookieValue(setCookieHeader: string, name: string): string | null {
  if (!setCookieHeader) return null;
  // Set-Cookie can be a comma-joined list of multiple cookies (rare but
  // possible when fetch normalises). Split on newline OR on the
  // attribute-aware comma. We use a simpler heuristic: search for
  // `name=...;` in the whole string.
  const re = new RegExp(`(?:^|[;,\\s])${name}=([^;]+)`);
  const match = re.exec(setCookieHeader);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

async function safeReadJson(res: Response): Promise<Record<string, string> | null> {
  try {
    return (await res.json()) as Record<string, string>;
  } catch {
    return null;
  }
}
