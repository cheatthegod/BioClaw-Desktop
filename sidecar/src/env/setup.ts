// Env setup driver — orchestrates the "first launch / repair" flow.
//
// Steps the SetupWizard kicks off via POST /env/setup:
//
//   1. Resolve the project dir (`~/.bioclaw/env` or BIOCLAW_ENV_DIR).
//   2. Copy pyproject.toml, uv.lock, .python-version, README.md from
//      the bundled `bioclaw-env/` resource into the project dir,
//      idempotently. We DON'T copy the .venv — uv builds it fresh.
//   3. Spawn `uv python install 3.11` (uses bundled `uv` next to the
//      sidecar binary, falls back to PATH `uv` if missing). This
//      downloads python-build-standalone into uv's managed cache —
//      ~30 MB, ~10 s on a warm connection.
//   4. Spawn `uv sync --frozen --extra <each>` honouring the wizard's
//      extras checklist. `--frozen` means uv.lock is the contract —
//      no resolver runs, just installs the pinned wheels. ~200 MB
//      base, plus another 300+ MB if `scientific` is selected.
//   5. Stream stdout + stderr lines back to the caller via the
//      provided emit callback so the wizard's progress view stays
//      live. The caller wraps these into SSE events.
//
// Cancellation: the caller passes an AbortSignal; we forward an
// `AbortController.abort()` to the spawned uv processes (SIGTERM,
// then SIGKILL after 1.5 s if uv refuses).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { defaultProjectDir, bundledEnvSourceDir, bundledUvBinary } from './paths.js';

export interface SetupOptions {
  /** Extras to add via `--extra <name>` — passed verbatim to uv sync. */
  readonly extras?: ReadonlyArray<string>;
  /**
   * PyPI index URL override. Defaults to uv's behaviour (whatever
   * `UV_INDEX_URL` or `~/.config/uv/uv.toml` says, else pypi.org).
   * The wizard surfaces "pypi / aliyun / tuna" as preset choices.
   */
  readonly indexUrl?: string;
  /** AbortSignal — cancelling will SIGTERM uv. */
  readonly signal: AbortSignal;
  /**
   * Stream output of every uv subprocess line-by-line. The wizard
   * shows the last ~30 lines as a console-style progress view, and
   * highlights the headline ("uv python install", "uv sync", etc.).
   */
  readonly emit: (event: SetupEvent) => void;
}

export type SetupEvent =
  | { readonly type: 'phase'; readonly label: string }
  | { readonly type: 'log'; readonly stream: 'stdout' | 'stderr'; readonly line: string }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly message: string };

/** Top-level. Drives the whole "from-zero to ready" flow. */
export async function runSetup(opts: SetupOptions): Promise<void> {
  const projectDir = defaultProjectDir();
  const bundledSrc = bundledEnvSourceDir();
  if (!bundledSrc) {
    opts.emit({ type: 'error', message: 'No bundled env source (BIOCLAW_RESOURCE_DIR is unset).' });
    throw new Error('no bundled env source');
  }

  try {
    opts.emit({ type: 'phase', label: 'Initialising project files' });
    await initProjectDir(bundledSrc, projectDir);

    opts.emit({ type: 'phase', label: 'Installing Python 3.11 (uv-managed)' });
    await runUv(['python', 'install', '3.11'], projectDir, opts);

    const args = ['sync', '--frozen'];
    for (const e of opts.extras ?? []) {
      args.push('--extra', e);
    }
    opts.emit({
      type: 'phase',
      label: opts.extras && opts.extras.length > 0
        ? `Resolving + installing base + ${opts.extras.join(', ')} (this is the slow first-run step)`
        : 'Resolving + installing base packages (this is the slow first-run step)',
    });
    await runUv(args, projectDir, opts);

    opts.emit({ type: 'done' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.emit({ type: 'error', message: msg });
    throw err;
  }
}

/** Copy bundle source -> projectDir. Idempotent; overwrites only the
 *  three pinned-source files (pyproject / uv.lock / .python-version)
 *  so a manual edit in projectDir of e.g. README.md sticks. */
async function initProjectDir(bundledSrc: string, projectDir: string): Promise<void> {
  await fs.promises.mkdir(projectDir, { recursive: true });
  const PIN_FILES = ['pyproject.toml', 'uv.lock', '.python-version'];
  for (const f of PIN_FILES) {
    const from = path.join(bundledSrc, f);
    const to = path.join(projectDir, f);
    if (!fs.existsSync(from)) {
      throw new Error(`Bundled env is missing ${f} (looked at ${from})`);
    }
    await fs.promises.copyFile(from, to);
  }
  // README is best-effort — its absence isn't fatal.
  const readme = path.join(bundledSrc, 'README.md');
  if (fs.existsSync(readme)) {
    try { await fs.promises.copyFile(readme, path.join(projectDir, 'README.md')); } catch { /* ignore */ }
  }
}

/** Spawn `uv <args>` in projectDir, line-streaming output. */
function runUv(args: string[], projectDir: string, opts: SetupOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const uv = resolveUvPath();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env['HOME'] ?? '/tmp',
      LANG: process.env['LANG'] ?? 'C.UTF-8',
      TMPDIR: process.env['TMPDIR'] ?? '/tmp',
      // Honour the user's mirror selection if set.
      ...(opts.indexUrl ? { UV_INDEX_URL: opts.indexUrl } : {}),
      // Force colour off so the streamed log lines don't contain
      // ANSI escape codes (the wizard UI renders them as garbage).
      NO_COLOR: '1',
    };

    const child = spawn(uv, args, {
      cwd: projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1500).unref();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      flushLines(stdoutBuf, 'stdout');
      stdoutBuf = lastIncompleteLine(stdoutBuf);
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      flushLines(stderrBuf, 'stderr');
      stderrBuf = lastIncompleteLine(stderrBuf);
    });

    function flushLines(buf: string, stream: 'stdout' | 'stderr') {
      const parts = buf.split('\n');
      for (let i = 0; i < parts.length - 1; i++) {
        const line = parts[i];
        if (line !== undefined && line.length > 0) opts.emit({ type: 'log', stream, line });
      }
    }
    function lastIncompleteLine(buf: string): string {
      const idx = buf.lastIndexOf('\n');
      return idx === -1 ? buf : buf.slice(idx + 1);
    }

    child.on('error', (err) => {
      opts.signal.removeEventListener('abort', onAbort);
      reject(new Error(`failed to spawn uv: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      opts.signal.removeEventListener('abort', onAbort);
      // Flush any trailing partial lines.
      if (stdoutBuf.length > 0) opts.emit({ type: 'log', stream: 'stdout', line: stdoutBuf });
      if (stderrBuf.length > 0) opts.emit({ type: 'log', stream: 'stderr', line: stderrBuf });
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error('uv was cancelled'));
      } else if (code !== 0) {
        reject(new Error(`uv exited ${code}`));
      } else {
        resolve();
      }
    });
  });
}

/** Resolve where `uv` lives. Tauri externalBin places it next to the
 *  sidecar binary at install time. We probe (in order):
 *    1. <sidecar dir>/uv(.exe) — Tauri externalBin layout
 *    2. <resource_dir>/uv(.exe) — fallback if Tauri changes its mind
 *    3. uv on $PATH — for dev runs where the sidecar isn't bundled
 *    4. ~/.local/bin/uv — typical pipx / installer location
 */
function resolveUvPath(): string {
  const exe = bundledUvBinary();

  // 1. Same directory as this script. process.argv[0] is `node`; the
  // bundled sidecar is at process.execPath in some launchers, but
  // here we're a Node module loaded by node — the install dir is
  // process.argv[1] (the .js entry).
  const candidates: string[] = [];
  try {
    const argv1 = process.argv[1];
    if (argv1) candidates.push(path.join(path.dirname(argv1), exe));
  } catch { /* ignore */ }

  // 2. Resource dir's binaries/ (Tauri sometimes places things there
  //    on Linux .deb if explicit `binaries` resource is used).
  const r = process.env['BIOCLAW_RESOURCE_DIR'];
  if (r) candidates.push(path.join(r, exe), path.join(r, 'binaries', exe));

  // 3 + 4. Path-based fallbacks — let `spawn` handle PATH resolution
  // by passing the bare name.
  candidates.push(exe);
  candidates.push(path.join(process.env['HOME'] ?? '/tmp', '.local', 'bin', exe));

  for (const c of candidates) {
    if (c === exe) return c; // let spawn resolve via PATH
    if (fs.existsSync(c)) return c;
  }
  return exe; // last resort — let spawn fail with a clean message
}
