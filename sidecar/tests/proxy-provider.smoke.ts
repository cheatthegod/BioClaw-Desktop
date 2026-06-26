// Smoke test for the bioclaw-proxy provider. Mocks the SaaS endpoint at
// /api/desktop/chat/completions, verifies:
//   * URL ends in /api/desktop/chat/completions (compat helper appends
//     /chat/completions to our `/api/desktop` endpoint)
//   * Cookie: bioclaw_session=<token> is sent (NOT Authorization: Bearer)
//   * The OpenAI-style SSE response is parsed into provider events

import http from 'node:http';
import '../src/skills/registry.ts'; // side-effect register skills
import '../../src/lib/providers/openrouter.ts'; // side-effect register
import '../../src/lib/providers/bioclaw-proxy.ts'; // side-effect register
import { getProvider } from '../../src/lib/providers/index.ts';

interface CapturedReq {
  url: string;
  headers: Record<string, string>;
  body: any;
}

async function startMock(): Promise<{ port: number; captured: CapturedReq[]; close: () => void }> {
  const captured: CapturedReq[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* ignore */ }
      captured.push({ url: req.url ?? '', headers, body });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: 'Hello ' } }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: 'BRCA1!' } }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bind failed');
  return { port: addr.port, captured, close: () => server.close() };
}

const mock = await startMock();
console.log(`mock SaaS on port ${mock.port}`);

const provider = getProvider('bioclaw-proxy');
const events: any[] = [];
const ctrl = new AbortController();
const stream = provider.streamMessages({
  model: {
    provider: 'bioclaw-proxy',
    id: 'openai/gpt-5.5',
    endpoint: `http://127.0.0.1:${mock.port}`,
    auth: { kind: 'cookie', apiKey: 'fake.session.token.value', cookieName: 'bioclaw_session' },
  },
  system: '',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: ctrl.signal,
});

for await (const ev of stream) events.push(ev);

console.log('=== captured request ===');
console.log('URL:', mock.captured[0]?.url);
console.log('cookie header:', mock.captured[0]?.headers?.['cookie']);
console.log('authorization header:', mock.captured[0]?.headers?.['authorization'] ?? '(none — correct)');
console.log('body.model:', mock.captured[0]?.body?.model);
console.log('body.stream:', mock.captured[0]?.body?.stream);

console.log('\n=== events ===');
let text = '';
for (const ev of events) {
  if (ev.type === 'text-delta') text += ev.text;
  else console.log(ev);
}
console.log('final text:', text);

mock.close();

let ok = true;
if (mock.captured[0]?.url !== '/api/desktop/chat/completions') {
  console.error('FAIL: wrong URL', mock.captured[0]?.url); ok = false;
}
if (mock.captured[0]?.headers?.['cookie'] !== 'bioclaw_session=fake.session.token.value') {
  console.error('FAIL: wrong cookie header', mock.captured[0]?.headers?.['cookie']); ok = false;
}
if (mock.captured[0]?.headers?.['authorization']) {
  console.error('FAIL: should NOT send Authorization with cookie auth'); ok = false;
}
if (text !== 'Hello BRCA1!') { console.error('FAIL: wrong text', text); ok = false; }
if (!ok) process.exit(1);
console.log('\nALL OK');
