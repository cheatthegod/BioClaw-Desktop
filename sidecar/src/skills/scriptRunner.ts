// Skill script runner — implements the `run_skill_script` tool handler.
//
// What this does:
//   1. Look up the skill_id in the registry to get its absolute directory.
//   2. Validate the requested script path: must be one we discovered at
//      load time (whitelist), AND the resolved absolute path must stay
//      inside the skill dir (defense-in-depth against `..` traversal).
//   3. Pick an interpreter (`python3` for .py, `bash` for .sh/.bash).
//   4. Spawn the interpreter with the requested argv, capture stdout +
//      stderr separately (truncated to ~64 KB each), enforce a timeout.
//   5. Return a structured result to the LLM.
//
// What this does NOT do (intentional security boundary):
//   * No shell interpretation: argv is passed as an array, no `sh -c`.
//   * No env passthrough: we hand the child a minimal env (PATH, HOME,
//     LANG, TMPDIR) so secrets like the OpenRouter key or NVIDIA API key
//     can't leak into a runaway script. Skills that legitimately need an
//     API key will get one via a separate path in a future phase.
//   * No cwd inheritance: the child runs with cwd set to the skill dir,
//     so relative paths in the script resolve against its own files.
//
// Permission gate:
//   The handler consults a `PermissionResolver` injected at registration
//   time. Phase-4 step 4 will wire this to a Tauri webview prompt; in the
//   interim, the resolver defaults to:
//     * if BIOCLAW_ALLOW_SCRIPT_EXEC=1 → allow all
//     * otherwise → deny, with a clear "ask the user to enable in
//       Settings → Permissions" message that the LLM surfaces to the user.

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import type { ToolHandlerContext, ToolHandlerResult } from '../providers-bridge';
import { getSkill } from './registry';

/** What the sidecar asks before actually exec'ing a script. */
export type PermissionDecision = 'allow' | 'allow_once' | 'deny';
export type PermissionResolver = (req: {
  skillId: string;
  scriptPath: string;
  interpreter: string;
  args: readonly string[];
}) => PermissionDecision | Promise<PermissionDecision>;

/** Env-flag gate — used as the fallback when no SSE writer is available. */
export const envFlagPermissionResolver: PermissionResolver = () => {
  return process.env['BIOCLAW_ALLOW_SCRIPT_EXEC'] === '1' ? 'allow' : 'deny';
};

// ---- Webview-prompt resolver --------------------------------------------
//
// The webview resolver is what main.ts hands the script-runner during a
// real /chat request. Flow:
//
//   1. Resolver checks the module-level `allowAlwaysCache` for an
//      "always-allow" decision keyed on (skillId, scriptPath). Hit ->
//      return "allow" immediately, no prompt.
//   2. Otherwise we mint a requestId, register a pending Promise in
//      `pendingPermissions`, and emit a `permission-needed` SSE event so
//      the frontend can pop a modal.
//   3. The frontend POSTs to /permissions/decide which calls
//      `resolvePendingPermission(requestId, decision)`. That resolves
//      the Promise so the resolver returns and the script runs (or not).
//   4. If the request gets aborted (user cancels chat) we reject the
//      Promise so the resolver returns "deny" without a hung tool call.

interface PendingPermission {
  readonly resolve: (decision: PermissionDecision) => void;
  readonly cacheKey: string;
}
const pendingPermissions = new Map<string, PendingPermission>();
const allowAlwaysCache = new Set<string>();

function permissionCacheKey(skillId: string, scriptPath: string): string {
  return `${skillId}::${scriptPath}`;
}

/**
 * Called by the POST /permissions/decide endpoint with the user's choice.
 * `allow` runs the script once; `allow_always` also caches the decision
 * for the remaining lifetime of this sidecar process. Persistence across
 * desktop restarts lives on the Tauri side — the frontend re-pushes
 * cached decisions via /permissions/preload at chat start.
 */
export function resolvePendingPermission(
  requestId: string,
  decision: PermissionDecision,
): boolean {
  const entry = pendingPermissions.get(requestId);
  if (!entry) return false;
  pendingPermissions.delete(requestId);
  if (decision === 'allow' || decision === 'allow_once') {
    // "allow" sticks; "allow_once" doesn't.
    if (decision === 'allow') allowAlwaysCache.add(entry.cacheKey);
  }
  entry.resolve(decision);
  return true;
}

/**
 * Seed the always-allow cache from the frontend's persisted store at
 * chat start. Idempotent.
 */
export function preloadAllowAlwaysPermissions(
  entries: ReadonlyArray<{ skillId: string; script: string }>,
): void {
  for (const e of entries) {
    allowAlwaysCache.add(permissionCacheKey(e.skillId, e.script));
  }
}

/** Test helper — reset all in-memory permission state. */
export function _resetPermissionState(): void {
  pendingPermissions.clear();
  allowAlwaysCache.clear();
}

export interface PermissionEvent {
  readonly type: 'permission-needed';
  readonly requestId: string;
  readonly skillId: string;
  readonly script: string;
  readonly interpreter: string;
  readonly args: readonly string[];
}

/**
 * Build a resolver that pumps `permission-needed` events through the
 * caller-supplied `emit` callback (typically the SSE writer for the
 * active /chat request) and waits for the matching /permissions/decide
 * post. `signal` is the chat request's AbortSignal — if the user
 * cancels the chat, we hang up the prompt and deny.
 */
export function buildWebviewPermissionResolver(opts: {
  emit: (ev: PermissionEvent) => Promise<void> | void;
  signal: AbortSignal;
  newRequestId: () => string;
}): PermissionResolver {
  return async (req) => {
    const key = permissionCacheKey(req.skillId, req.scriptPath);
    if (allowAlwaysCache.has(key)) return 'allow';

    const requestId = opts.newRequestId();
    let resolved = false;
    const decisionPromise = new Promise<PermissionDecision>((resolve) => {
      pendingPermissions.set(requestId, {
        cacheKey: key,
        resolve: (d) => {
          if (resolved) return;
          resolved = true;
          resolve(d);
        },
      });
      const onAbort = () => {
        const entry = pendingPermissions.get(requestId);
        if (!entry) return;
        pendingPermissions.delete(requestId);
        if (!resolved) {
          resolved = true;
          resolve('deny');
        }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      await opts.emit({
        type: 'permission-needed',
        requestId,
        skillId: req.skillId,
        script: req.scriptPath,
        interpreter: req.interpreter,
        args: req.args,
      });
    } catch (err) {
      // Emit failed (stream closed?) — clean up and deny.
      pendingPermissions.delete(requestId);
      return 'deny';
    }

    return decisionPromise;
  };
}

const STDOUT_LIMIT = 64 * 1024;
const STDERR_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * Spawn an interpreter and collect output. Returns the typed result the
 * caller (`runSkillScriptTool`) shapes into an LLM tool response.
 */
interface SpawnResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

function spawnAndCollect(
  interpreter: string,
  argv: readonly string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;

    const child = spawn(interpreter, argv as string[], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1500).unref();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1500).unref();
    }, opts.timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length >= STDOUT_LIMIT) {
        stdoutTruncated = true;
        return;
      }
      const room = STDOUT_LIMIT - stdout.length;
      if (chunk.length > room) {
        stdout += chunk.slice(0, room);
        stdoutTruncated = true;
      } else {
        stdout += chunk;
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length >= STDERR_LIMIT) {
        stderrTruncated = true;
        return;
      }
      const room = STDERR_LIMIT - stderr.length;
      if (chunk.length > room) {
        stderr += chunk.slice(0, room);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stdoutTruncated,
        stderr: stderr + `\n[sidecar: failed to spawn ${interpreter}: ${err.message}]`,
        stderrTruncated,
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      const finalStderr = aborted
        ? stderr + '\n[sidecar: child was aborted by client]'
        : timedOut
          ? stderr + `\n[sidecar: timeout after ${opts.timeoutMs}ms]`
          : stderr;
      resolve({
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        stdout,
        stdoutTruncated,
        stderr: finalStderr,
        stderrTruncated,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Validate that the requested script path is one of the scripts we
 * discovered at load time, AND that its resolved absolute path stays
 * inside the skill directory. We compare against the loader's whitelist
 * BEFORE filesystem ops so a missing file gives the LLM a deterministic
 * error rather than spawning a syscall on attacker-controlled input.
 *
 * Returns the absolute path on success, or an error string on failure.
 */
function resolveScript(
  skillAbsDir: string,
  scripts: readonly { relativePath: string; kind: 'python' | 'shell' }[],
  requested: string,
): { absPath: string; kind: 'python' | 'shell' } | string {
  // Normalize separators so 'scripts\\foo.py' on Windows lands in the
  // same shape as 'scripts/foo.py' from POSIX.
  const normalized = requested.replace(/\\/g, '/');
  const hit = scripts.find((s) => s.relativePath === normalized);
  if (!hit) {
    const sample = scripts
      .slice(0, 8)
      .map((s) => s.relativePath)
      .join(', ');
    return `script "${requested}" is not in this skill's allow-list. Available: ${sample || '(none)'}`;
  }
  const candidate = path.resolve(skillAbsDir, hit.relativePath);
  const dirWithSep = skillAbsDir.endsWith(path.sep) ? skillAbsDir : skillAbsDir + path.sep;
  if (candidate !== skillAbsDir && !candidate.startsWith(dirWithSep)) {
    return `script "${requested}" resolves outside its skill directory (refusing)`;
  }
  return { absPath: candidate, kind: hit.kind };
}

/**
 * Build the OpenAI-compatible tool definition the chat loop registers when
 * skills are enabled. Args:
 *   skill_id:    must match a loaded skill
 *   script:      relative path from the skill dir (e.g. "scripts/foo.py")
 *   args:        argv passed to the interpreter
 *   timeout_ms:  optional, clamped to [1000, MAX_TIMEOUT_MS]
 */
export function buildScriptRunnerToolDefinition(
  resolver: PermissionResolver = envFlagPermissionResolver,
) {
  return {
    name: 'run_skill_script',
    description:
      'Execute a Python or shell script that ships with a BioClaw skill. ' +
      'Use this AFTER reading SKILL.md (via invoke_skill) to actually run one of the scripts the skill documents. ' +
      'Returns stdout, stderr, exit_code, and timing. The user must have granted execution permission — if not, the call returns a permission-denied result and you should ask the user to enable it in Settings → Permissions.',
    schema: {
      type: 'object' as const,
      properties: {
        skill_id: {
          type: 'string' as const,
          description: 'The id of the skill whose script to run (e.g. "bionemo-science-skills-uniprot-database").',
        },
        script: {
          type: 'string' as const,
          description: 'Relative path of the script inside the skill dir (e.g. "scripts/uniprot_tools.py"). Must be one of the scripts the skill ships with.',
        },
        args: {
          type: 'array' as const,
          description: 'Command-line arguments passed to the script after the interpreter. Always pass as an array, NOT a single shell string.',
          items: { type: 'string' as const },
        },
        timeout_ms: {
          type: 'number' as const,
          description: 'Optional timeout in milliseconds. Defaults to 30000, capped at 300000.',
        },
      },
      required: ['skill_id', 'script'],
      additionalProperties: false,
    },
    kind: 'local' as const,
    handler: async (
      args: Readonly<Record<string, unknown>>,
      ctx: ToolHandlerContext,
    ): Promise<ToolHandlerResult> => {
      const skillId = typeof args['skill_id'] === 'string' ? args['skill_id'] : '';
      const scriptArg = typeof args['script'] === 'string' ? args['script'] : '';
      const argvRaw = Array.isArray(args['args']) ? args['args'] : [];
      const argv = argvRaw.filter((x): x is string => typeof x === 'string');
      const timeoutRaw = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutRaw)));

      if (!skillId) {
        return errorResult('run_skill_script: missing required argument `skill_id`.');
      }
      if (!scriptArg) {
        return errorResult('run_skill_script: missing required argument `script`.');
      }
      const skill = getSkill(skillId);
      if (!skill) {
        return errorResult(`run_skill_script: no skill with id "${skillId}" is installed.`);
      }
      const resolved = resolveScript(skill.absoluteDir, skill.scripts, scriptArg);
      if (typeof resolved === 'string') return errorResult(`run_skill_script: ${resolved}`);

      const interpreter = resolved.kind === 'python' ? 'python3' : 'bash';
      const interpArgs = [resolved.absPath, ...argv];

      const decision = await resolver({
        skillId,
        scriptPath: scriptArg,
        interpreter,
        args: argv,
      });
      if (decision === 'deny') {
        return errorResult(
          `run_skill_script: execution denied. The user has not granted permission to run scripts from this skill. ` +
            `Tell the user: "I can run \`${scriptArg}\` from \`${skillId}\` for you, but you'll need to allow script execution in Settings → Permissions first."`,
        );
      }

      const minimalEnv: NodeJS.ProcessEnv = {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/tmp',
        LANG: process.env['LANG'] ?? 'C.UTF-8',
        TMPDIR: process.env['TMPDIR'] ?? '/tmp',
      };

      const result = await spawnAndCollect(interpreter, interpArgs, {
        cwd: skill.absoluteDir,
        env: minimalEnv,
        timeoutMs,
        signal: ctx.signal,
      });

      const summary = formatResultForLlm({
        skillId,
        script: scriptArg,
        interpreter,
        argv,
        result,
        decisionLabel: decision,
      });
      return {
        output: summary,
        metadata: {
          ok: result.exitCode === 0 && !result.timedOut,
          exit_code: result.exitCode,
          signal: result.signal,
          timed_out: result.timedOut,
          duration_ms: result.durationMs,
          stdout_truncated: result.stdoutTruncated,
          stderr_truncated: result.stderrTruncated,
        },
      };
    },
  };
}

function errorResult(message: string): ToolHandlerResult {
  return { output: message, metadata: { ok: false } };
}

function formatResultForLlm(args: {
  skillId: string;
  script: string;
  interpreter: string;
  argv: readonly string[];
  result: SpawnResult;
  decisionLabel: PermissionDecision;
}): string {
  const { skillId, script, interpreter, argv, result } = args;
  const status =
    result.timedOut
      ? `TIMED OUT after ${result.durationMs}ms`
      : result.signal
        ? `terminated by ${result.signal}`
        : `exited ${result.exitCode}`;
  const cmdLine = `${interpreter} ${script}${argv.length > 0 ? ' ' + argv.map((a) => JSON.stringify(a)).join(' ') : ''}`;
  const lines: string[] = [];
  lines.push(`# run_skill_script result`);
  lines.push(`Skill: \`${skillId}\``);
  lines.push(`Command: \`${cmdLine}\``);
  lines.push(`Status: **${status}** (${result.durationMs}ms)`);
  if (args.decisionLabel === 'allow_once') {
    lines.push('Permission: allowed for this turn only.');
  }
  lines.push('');
  lines.push('## stdout');
  if (result.stdout.length > 0) {
    lines.push('```');
    lines.push(result.stdout.trimEnd());
    lines.push('```');
    if (result.stdoutTruncated) lines.push(`_(stdout truncated to ${STDOUT_LIMIT} chars)_`);
  } else {
    lines.push('_(empty)_');
  }
  if (result.stderr.length > 0) {
    lines.push('');
    lines.push('## stderr');
    lines.push('```');
    lines.push(result.stderr.trimEnd());
    lines.push('```');
    if (result.stderrTruncated) lines.push(`_(stderr truncated to ${STDERR_LIMIT} chars)_`);
  }
  return lines.join('\n');
}
