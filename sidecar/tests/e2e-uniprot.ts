// End-to-end test for Phase 4: drive the production sidecar through the
// full skill -> script -> permission -> python3 -> answer chain without
// hitting a real LLM provider.
//
// Wiring:
//   1. Spin up a mock OpenAI-compatible server on 127.0.0.1:<random>.
//      It speaks /v1/chat/completions SSE with three scripted rounds:
//        a. Emit a tool_call for invoke_skill(uniprot)
//        b. Emit a tool_call for run_skill_script(uniprot, count, BRCA1)
//        c. Emit a final assistant text that mentions "128"
//   2. Spawn the production sidecar binary as a real subprocess
//      (same one shipped in the .deb).
//   3. POST /chat with provider=openai-compatible, baseUrl=mock,
//      apiKey=fake, model=fake.
//   4. Parse the SSE stream. When permission-needed arrives, POST
//      /permissions/decide with "allow".
//   5. Verify the assistant turn contains "128" and the tool-call-result
//      for run_skill_script has exit_code=0 + stdout=128.
//
// This validates the full code path we just wrote: bounded tool-call loop,
// runner.ts (invoke_skill -> SKILL.md), scriptRunner.ts (path validation,
// python3 spawn, output capture), webview permission resolver (SSE +
// /permissions/decide), and the wire-format fix (type included in JSON).

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

// Repo root is supplied by REPO_ROOT env var (the runner script sets it)
// because bundling collapses __dirname into the bundle output path.
const REPO_ROOT = process.env['REPO_ROOT'];
if (!REPO_ROOT) {
  console.error('REPO_ROOT env var is required');
  process.exit(1);
}
const SIDECAR_BIN = path.join(
  REPO_ROOT,
  'src-tauri',
  'binaries',
  'bioclaw-sidecar-x86_64-unknown-linux-gnu',
);
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

function log(label: string, x?: unknown) {
  if (x === undefined) console.log(`[e2e] ${label}`);
  else console.log(`[e2e] ${label}:`, typeof x === 'string' ? x : JSON.stringify(x));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- mock OpenAI server ------------------------------------------------
//
// Returns SSE chunks shaped like OpenAI's /v1/chat/completions response.
// We dispatch based on the number of `tool` messages we've already seen
// in the request — the sidecar appends a tool message per tool result,
// so on round N we see N-1 tool messages.

interface MockState {
  round: number;
}
const mockState: MockState = { round: 0 };

function buildMockResponse(messages: Array<{ role: string; content: string }>): string {
  const toolMessages = messages.filter((m) => m.role === 'tool');
  const round = toolMessages.length; // 0 = first call, 1 = after first tool, 2 = after second
  mockState.round = round;

  const id = `chatcmpl-${round}`;
  const chunks: string[] = [];

  function makeChunk(deltaObj: Record<string, unknown>, finishReason: string | null = null) {
    return `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'fake/model',
      choices: [
        {
          index: 0,
          delta: deltaObj,
          finish_reason: finishReason,
        },
      ],
    })}\n\n`;
  }

  if (round === 0) {
    // Tool call: invoke_skill(uniprot)
    chunks.push(
      makeChunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_invoke_1',
            type: 'function',
            function: {
              name: 'invoke_skill',
              arguments: JSON.stringify({ skill_id: 'bionemo-science-skills-uniprot-database' }),
            },
          },
        ],
      }),
    );
    chunks.push(makeChunk({}, 'tool_calls'));
  } else if (round === 1) {
    // Tool call: run_skill_script
    chunks.push(
      makeChunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_run_1',
            type: 'function',
            function: {
              name: 'run_skill_script',
              arguments: JSON.stringify({
                skill_id: 'bionemo-science-skills-uniprot-database',
                script: 'scripts/uniprot_tools.py',
                args: ['count', 'gene:BRCA1 AND organism_id:9606'],
              }),
            },
          },
        ],
      }),
    );
    chunks.push(makeChunk({}, 'tool_calls'));
  } else {
    // Final answer
    chunks.push(makeChunk({ content: 'According to the UniProt search, there are ' }));
    chunks.push(makeChunk({ content: '128 ' }));
    chunks.push(makeChunk({ content: 'human BRCA1 entries.' }));
    chunks.push(makeChunk({}, 'stop'));
  }
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

async function startMock(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const buf: Buffer[] = [];
      req.on('data', (c) => buf.push(c));
      req.on('end', () => {
        let parsed: { messages: Array<{ role: string; content: string }> };
        try {
          parsed = JSON.parse(Buffer.concat(buf).toString('utf-8'));
        } catch {
          res.writeHead(400).end('bad json');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const body = buildMockResponse(parsed.messages ?? []);
        res.write(body);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('mock listen failed');
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

// ---- spawn the production sidecar -------------------------------------

interface Sidecar {
  port: number;
  proc: import('node:child_process').ChildProcess;
  kill: () => void;
}

async function startSidecar(): Promise<Sidecar> {
  const proc = spawn(SIDECAR_BIN, {
    env: { ...process.env, BIOCLAW_SKILLS_DIR: SKILLS_DIR },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutBuf = '';
  let port = 0;
  const ready = new Promise<number>((resolve, reject) => {
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
      const m = /PORT=(\d+)/.exec(stdoutBuf);
      if (m && port === 0) {
        port = Number(m[1]);
      }
      if (/READY/.test(stdoutBuf) && port > 0) {
        resolve(port);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[sidecar] ${chunk.toString('utf-8')}`);
    });
    proc.on('error', reject);
    setTimeout(() => reject(new Error('sidecar boot timeout')), 8000);
  });
  const p = await ready;
  return {
    port: p,
    proc,
    kill: () => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    },
  };
}

// ---- SSE parser -------------------------------------------------------

async function* readSseEvents(res: Response): AsyncIterable<{ type: string; data: any }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = buf.indexOf('\n\n');
      if (idx === -1) break;
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let evType = '';
      let dataLine = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) evType = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLine += line.slice(6).trim();
      }
      if (!evType || !dataLine) continue;
      try {
        yield { type: evType, data: JSON.parse(dataLine) };
      } catch {
        /* skip bad json */
      }
    }
  }
}

// ---- main ------------------------------------------------------------

async function main() {
  log('starting mock OpenAI');
  const mock = await startMock();
  log(`mock port = ${mock.port}`);

  log('starting sidecar');
  const sidecar = await startSidecar();
  log(`sidecar port = ${sidecar.port}`);

  let permissionSeen = false;
  let scriptResultSeen = false;
  let scriptResultText = '';
  let assistantText = '';
  let permissionDecisionPosted = false;

  try {
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'How many human BRCA1 entries are in UniProt?' },
        ],
        apiKey: 'sk-fake-for-e2e',
        model: 'fake/model',
        baseUrl: `http://127.0.0.1:${mock.port}`,
        provider: 'openai-compatible',
      }),
    });
    if (!res.ok) {
      log(`/chat returned ${res.status}`);
      const t = await res.text();
      console.error(t);
      process.exit(2);
    }

    for await (const ev of readSseEvents(res)) {
      if (ev.type === 'text-delta') {
        assistantText += ev.data.text ?? '';
        continue;
      }
      if (ev.type === 'tool-call-start') {
        log(`tool-call-start: ${ev.data.name}`, ev.data.args);
        continue;
      }
      if (ev.type === 'tool-call-result') {
        log(`tool-call-result: ${ev.data.name} isError=${ev.data.isError}`);
        if (ev.data.name === 'run_skill_script') {
          scriptResultSeen = true;
          scriptResultText = ev.data.output;
        }
        continue;
      }
      if (ev.type === 'permission-needed') {
        permissionSeen = true;
        log('permission-needed', {
          skillId: ev.data.skillId,
          script: ev.data.script,
          args: ev.data.args,
        });
        // Drive the prompt: post a decision.
        const decideRes = await fetch(`http://127.0.0.1:${sidecar.port}/permissions/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: ev.data.requestId, decision: 'allow_once' }),
        });
        const decideJson = await decideRes.json();
        log('/permissions/decide reply', decideJson);
        permissionDecisionPosted = true;
        continue;
      }
      if (ev.type === 'finish') {
        log('finish', ev.data);
        if (ev.data.reason === 'error') {
          console.error('FAIL: chat finished with error:', ev.data.error);
          process.exit(3);
        }
        break;
      }
      if (ev.type === 'step-complete') {
        log(`step-complete step=${ev.data.step}`);
        continue;
      }
    }

    // Assertions.
    log('FINAL assistantText', assistantText);
    log('FINAL scriptResultText snippet', scriptResultText.slice(0, 200));

    let ok = true;
    if (!permissionSeen) { console.error('FAIL: no permission-needed event'); ok = false; }
    if (!permissionDecisionPosted) { console.error('FAIL: never posted decision'); ok = false; }
    if (!scriptResultSeen) { console.error('FAIL: no run_skill_script result'); ok = false; }
    if (!/128/.test(scriptResultText)) {
      console.error('FAIL: script stdout did not contain 128');
      ok = false;
    }
    if (!/128/.test(assistantText)) {
      console.error('FAIL: assistant text did not include the count');
      ok = false;
    }
    if (!ok) process.exit(10);
    log('ALL OK');
  } finally {
    sidecar.kill();
    mock.close();
    // Give the sidecar a tick to flush before we exit.
    await sleep(200);
  }
}

main().catch((err) => {
  console.error('e2e crashed:', err);
  process.exit(1);
});
