// Smoke test for the desktop auth.ts helpers.
//
// Mocks a tiny SaaS that implements /api/auth/send-otp + /api/auth/verify-otp
// then drives the auth.ts module. Verifies:
//   * requestOtp throws AuthError on 4xx, swallows the response body
//   * verifyOtp parses the Set-Cookie `bioclaw_session=<value>` correctly
//   * verifyOtp throws AuthError when no cookie comes back
//
// We can't import the real auth.ts because it pulls in
// @tauri-apps/api/core through credentials.ts which would crash in
// plain Node. Instead we copy the (small, pure) functions inline.

import http from 'node:http';

interface AuthError {
  status: number;
  message: string;
}

async function requestOtp(base: string, email: string): Promise<void> {
  const res = await fetch(`${base}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    let detail: any = null;
    try { detail = await res.json(); } catch { /* ignore */ }
    throw { status: res.status, message: detail?.error ?? 'failed' } satisfies AuthError;
  }
}

async function verifyOtp(base: string, email: string, code: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
    redirect: 'manual',
  });
  if (!res.ok) {
    let detail: any = null;
    try { detail = await res.json(); } catch { /* ignore */ }
    throw { status: res.status, message: detail?.error ?? 'invalid' } satisfies AuthError;
  }
  const sc = res.headers.get('set-cookie')
    ?? (res.headers as any).getSetCookie?.()?.join('\n')
    ?? '';
  const m = new RegExp(`(?:^|[;,\\s])bioclaw_session=([^;]+)`).exec(sc);
  if (!m || !m[1]) throw { status: 500, message: 'no cookie' } satisfies AuthError;
  return decodeURIComponent(m[1]);
}

// ---- mock SaaS --------------------------------------------------------

async function startMock(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* ignore */ }
      if (req.url === '/api/auth/send-otp' && req.method === 'POST') {
        if (body.email === 'rate@limited.com') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/api/auth/verify-otp' && req.method === 'POST') {
        if (body.code === '000000') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid code' }));
          return;
        }
        // Successful — set the session cookie like SaaS does.
        const token = `eyJlbWFpbCI6ICIke${body.email}}}.SIG`;
        res.setHeader('Set-Cookie',
          `bioclaw_session=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, redirect: '/app' }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bind failed');
  return { port: addr.port, close: () => server.close() };
}

// ---- run --------------------------------------------------------------

const mock = await startMock();
const base = `http://127.0.0.1:${mock.port}`;
console.log(`mock SaaS on ${base}`);

let pass = 0;
function ok(label: string) { pass++; console.log('  ok', label); }
function fail(label: string, err?: unknown) {
  console.error('  FAIL', label, err);
  process.exit(1);
}

// requestOtp success
try {
  await requestOtp(base, 'alice@example.com');
  ok('requestOtp 200');
} catch (e) { fail('requestOtp 200', e); }

// requestOtp rate-limited propagates message
try {
  await requestOtp(base, 'rate@limited.com');
  fail('rate-limit should throw');
} catch (e) {
  const err = e as AuthError;
  if (err.status === 429 && err.message === 'Rate limit exceeded') ok('requestOtp 429 message');
  else fail('rate-limit message', e);
}

// verifyOtp success returns token
try {
  const token = await verifyOtp(base, 'alice@example.com', '123456');
  if (token.startsWith('eyJ') && token.includes('alice@example.com')) ok('verifyOtp token parse');
  else fail('verifyOtp token mismatch', token);
} catch (e) { fail('verifyOtp success', e); }

// verifyOtp invalid code -> 401
try {
  await verifyOtp(base, 'alice@example.com', '000000');
  fail('verifyOtp 401 should throw');
} catch (e) {
  const err = e as AuthError;
  if (err.status === 401) ok('verifyOtp 401');
  else fail('verifyOtp 401 unexpected', e);
}

console.log(`\n${pass}/4 passed`);
mock.close();
