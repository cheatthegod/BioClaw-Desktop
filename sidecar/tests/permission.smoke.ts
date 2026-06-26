// Smoke test for the webview permission resolver. Simulates the flow:
//   1. caller invokes the resolver (as if from inside run_skill_script)
//   2. resolver emits a `permission-needed` event via the SSE writer
//   3. an external "frontend" calls resolvePendingPermission(requestId, 'allow')
//   4. resolver returns 'allow'
//
// Also covers:
//   * preloadAllowAlwaysPermissions seeds the cache so a subsequent call
//     short-circuits without emitting.
//   * abort() rejects the pending promise so the resolver returns 'deny'.

import {
  buildWebviewPermissionResolver,
  preloadAllowAlwaysPermissions,
  resolvePendingPermission,
  _resetPermissionState,
} from '../src/skills/scriptRunner.ts';

let nextId = 0;
const newId = () => `req-${++nextId}`;

function header(label: string) {
  console.log(`\n=== ${label} ===`);
}

// --- happy path: prompt -> allow -> resolver returns 'allow' ---
{
  _resetPermissionState();
  const ctrl = new AbortController();
  const emitted: any[] = [];
  const resolver = buildWebviewPermissionResolver({
    emit: (ev) => emitted.push(ev),
    signal: ctrl.signal,
    newRequestId: newId,
  });
  const promise = resolver({
    skillId: 'bionemo-science-skills-uniprot-database',
    scriptPath: 'scripts/uniprot_tools.py',
    interpreter: 'python3',
    args: ['count', 'gene:BRCA1'],
  });
  // Give the microtask queue a tick to flush the emit.
  await Promise.resolve();
  header('happy path: emit');
  console.log('emitted:', JSON.stringify(emitted, null, 2));
  if (emitted.length !== 1 || emitted[0].type !== 'permission-needed') {
    console.error('FAIL: expected single permission-needed event'); process.exit(1);
  }
  const reqId = emitted[0].requestId as string;
  const ok = resolvePendingPermission(reqId, 'allow');
  if (!ok) { console.error('FAIL: resolvePendingPermission returned false'); process.exit(2); }
  const decision = await promise;
  console.log('decision =', decision);
  if (decision !== 'allow') { console.error('FAIL: expected allow'); process.exit(3); }
}

// --- second call short-circuits (cache hit) ---
{
  const ctrl = new AbortController();
  const emitted: any[] = [];
  const resolver = buildWebviewPermissionResolver({
    emit: (ev) => emitted.push(ev),
    signal: ctrl.signal,
    newRequestId: newId,
  });
  const decision = await resolver({
    skillId: 'bionemo-science-skills-uniprot-database',
    scriptPath: 'scripts/uniprot_tools.py',
    interpreter: 'python3',
    args: [],
  });
  header('cache hit (second call after allow)');
  console.log('decision =', decision, 'emitted =', emitted.length);
  if (decision !== 'allow' || emitted.length !== 0) {
    console.error('FAIL: expected silent allow'); process.exit(4);
  }
}

// --- preload seeds the cache before any prompt ---
{
  _resetPermissionState();
  preloadAllowAlwaysPermissions([{ skillId: 'sk-alpha', script: 'scripts/foo.py' }]);
  const ctrl = new AbortController();
  const emitted: any[] = [];
  const resolver = buildWebviewPermissionResolver({
    emit: (ev) => emitted.push(ev),
    signal: ctrl.signal,
    newRequestId: newId,
  });
  const decision = await resolver({
    skillId: 'sk-alpha',
    scriptPath: 'scripts/foo.py',
    interpreter: 'python3',
    args: [],
  });
  header('preload short-circuit');
  console.log('decision =', decision, 'emitted =', emitted.length);
  if (decision !== 'allow' || emitted.length !== 0) {
    console.error('FAIL: preload should suppress prompt'); process.exit(5);
  }
}

// --- abort rejects pending promise -> deny ---
{
  _resetPermissionState();
  const ctrl = new AbortController();
  const emitted: any[] = [];
  const resolver = buildWebviewPermissionResolver({
    emit: (ev) => emitted.push(ev),
    signal: ctrl.signal,
    newRequestId: newId,
  });
  const promise = resolver({
    skillId: 'sk-beta',
    scriptPath: 'scripts/bar.py',
    interpreter: 'python3',
    args: [],
  });
  await Promise.resolve();
  ctrl.abort();
  const decision = await promise;
  header('abort -> deny');
  console.log('decision =', decision);
  if (decision !== 'deny') { console.error('FAIL: abort should deny'); process.exit(6); }
}

// --- allow_once does NOT cache ---
{
  _resetPermissionState();
  const ctrl = new AbortController();
  const emitted: any[] = [];
  const resolver = buildWebviewPermissionResolver({
    emit: (ev) => emitted.push(ev),
    signal: ctrl.signal,
    newRequestId: newId,
  });
  // First call: allow_once
  const p1 = resolver({
    skillId: 'sk-gamma', scriptPath: 'scripts/x.py', interpreter: 'python3', args: [],
  });
  await Promise.resolve();
  const reqId1 = (emitted[0] as any).requestId as string;
  resolvePendingPermission(reqId1, 'allow_once');
  const d1 = await p1;
  // Second call: should prompt again (no cache)
  const p2 = resolver({
    skillId: 'sk-gamma', scriptPath: 'scripts/x.py', interpreter: 'python3', args: [],
  });
  await Promise.resolve();
  header('allow_once -> no cache -> re-prompt');
  console.log('first =', d1, 'emitted now =', emitted.length);
  if (d1 !== 'allow_once' || emitted.length !== 2) {
    console.error('FAIL: allow_once should NOT cache'); process.exit(7);
  }
  // Resolve to clean up
  resolvePendingPermission((emitted[1] as any).requestId, 'deny');
  await p2;
}

console.log('\nALL OK');
