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
import { bundledEnvZip } from './paths.js';

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

/**
 * Top-level setup. Tries (in order):
 *
 *   1. Bundled offline install — extract `bioclaw-env.zip` from the
 *      Tauri resource dir, then run `uv sync --frozen --offline`
 *      against the bundled CPython + cache. ~30-60 s total, zero
 *      network. This is the default OmicOS-style first-launch path.
 *
 *   2. Legacy online install — copy pyproject + uv.lock from the
 *      loose-files bundle dir, then `uv python install` + `uv sync`
 *      against PyPI / aliyun / tuna. ~2-5 min. Used when the zip is
 *      absent (dev runs, sideloaded builds without vendor-env.sh).
 *
 * Either path emits the same SetupEvent stream so the frontend's
 * progress banner doesn't care which one ran.
 */
export async function runSetup(opts: SetupOptions): Promise<void> {
  const projectDir = defaultProjectDir();
  const zip = bundledEnvZip();
  const bundledSrc = bundledEnvSourceDir();

  // Add-extra requests always need the online path — extras aren't
  // baked into the offline cache (it'd bloat the installer by 300+ MB
  // for a stack only some users want).
  const wantOnline = (opts.extras?.length ?? 0) > 0;

  if (!wantOnline && zip && fs.existsSync(zip)) {
    return runOfflineSetup({ zip, projectDir, opts });
  }
  if (bundledSrc) {
    return runOnlineSetup({ bundledSrc, projectDir, opts });
  }
  opts.emit({
    type: 'error',
    message:
      'No bundled env: BIOCLAW_RESOURCE_DIR is unset AND no bioclaw-env.zip on disk.',
  });
  throw new Error('no bundled env source');
}

/** Path A — offline install from `bioclaw-env.zip`. */
async function runOfflineSetup(args: {
  zip: string;
  projectDir: string;
  opts: SetupOptions;
}): Promise<void> {
  const { zip, projectDir, opts } = args;
  try {
    opts.emit({ type: 'phase', label: 'Unpacking local Python kernel' });
    await extractZip(zip, projectDir, opts.signal);

    const pythonBin = locateBundledPython(projectDir);
    if (!pythonBin) {
      throw new Error(`Bundled python not found under ${projectDir}/_base`);
    }

    opts.emit({ type: 'phase', label: 'Finalising venv (offline, no network)' });
    await runUvOffline(
      ['sync', '--frozen', '--offline', '--python', pythonBin],
      projectDir,
      opts,
    );
    opts.emit({ type: 'done' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.emit({ type: 'error', message: msg });
    throw err;
  }
}

/** Path B — legacy online install. Same flow as before. */
async function runOnlineSetup(args: {
  bundledSrc: string;
  projectDir: string;
  opts: SetupOptions;
}): Promise<void> {
  const { bundledSrc, projectDir, opts } = args;
  try {
    opts.emit({ type: 'phase', label: 'Initialising project files' });
    await initProjectDir(bundledSrc, projectDir);

    opts.emit({ type: 'phase', label: 'Installing Python 3.11 (uv-managed)' });
    await runUv(['python', 'install', '3.11'], projectDir, opts);

    const syncArgs = ['sync', '--frozen'];
    for (const e of opts.extras ?? []) {
      syncArgs.push('--extra', e);
    }
    opts.emit({
      type: 'phase',
      label:
        opts.extras && opts.extras.length > 0
          ? `Resolving + installing base + ${opts.extras.join(', ')} (downloading wheels)`
          : 'Resolving + installing base packages (downloading wheels)',
    });
    await runUv(syncArgs, projectDir, opts);

    opts.emit({ type: 'done' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.emit({ type: 'error', message: msg });
    throw err;
  }
}

/** Find the bundled CPython interpreter under <projectDir>/_base/.
 *  uv standalone layout: `_base/cpython-<ver>-<target>/{bin/python,python.exe}`. */
function locateBundledPython(projectDir: string): string | null {
  const baseDir = path.join(projectDir, '_base');
  if (!fs.existsSync(baseDir)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(baseDir, e);
    if (!fs.statSync(full).isDirectory()) continue;
    // POSIX: bin/python3 or bin/python
    const posix = path.join(full, 'bin', 'python3');
    if (fs.existsSync(posix)) return posix;
    const posix2 = path.join(full, 'bin', 'python');
    if (fs.existsSync(posix2)) return posix2;
    // Windows: python.exe at the top of the standalone dir
    const win = path.join(full, 'python.exe');
    if (fs.existsSync(win)) return win;
  }
  return null;
}

/** Extract a zip into projectDir. Uses Node's built-in (Node 22+) where
 *  possible; falls back to shelling out to `unzip` on Linux/mac and
 *  `tar` (which can read zip on Windows 10+) elsewhere. */
async function extractZip(
  zipPath: string,
  destDir: string,
  signal: AbortSignal,
): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });
  // Built-in zip extraction landed in Node 22 (`fs.cp` doesn't do it).
  // The cross-platform path is to shell out — Windows 10+ has a
  // `tar.exe` that handles zip, Linux/macOS have `unzip`.
  return new Promise<void>((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'tar' : 'unzip';
    const args =
      process.platform === 'win32'
        ? ['-xf', zipPath, '-C', destDir]
        : ['-q', '-o', zipPath, '-d', destDir];
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1500).unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error(`failed to spawn ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

/** Run uv with UV_CACHE_DIR pointed at the bundled cache (offline). */
function runUvOffline(
  args: string[],
  projectDir: string,
  opts: SetupOptions,
): Promise<void> {
  const extraEnv: NodeJS.ProcessEnv = {
    UV_CACHE_DIR: path.join(projectDir, '_uv-cache'),
    UV_PYTHON_INSTALL_DIR: path.join(projectDir, '_base'),
  };
  return runUv(args, projectDir, opts, extraEnv);
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

/** Spawn `uv <args>` in projectDir, line-streaming output.
 *  Optional `extraEnv` is merged on top of the base env — the offline
 *  path uses this to pin UV_CACHE_DIR / UV_PYTHON_INSTALL_DIR. */
function runUv(
  args: string[],
  projectDir: string,
  opts: SetupOptions,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
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
      ...extraEnv,
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
