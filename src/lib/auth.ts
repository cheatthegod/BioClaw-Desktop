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
 * Submit the OTP. On success the SaaS sets a session cookie via
 * Set-Cookie; we parse the cookie value out and return the opaque
 * token. The caller persists it to the OS keychain.
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
    // We need to read Set-Cookie ourselves; don't auto-follow.
    redirect: 'manual',
  });
  if (!res.ok) {
    const detail = await safeReadJson(res);
    throw {
      status: res.status,
      message: detail?.['error'] ?? `Invalid code (HTTP ${res.status})`,
    } satisfies AuthError;
  }
  const setCookie =
    res.headers.get('set-cookie') ??
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()?.join('\n');
  const token = parseCookieValue(setCookie ?? '', COOKIE_NAME);
  if (!token) {
    throw {
      status: 500,
      message: 'Server did not return a session cookie',
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
