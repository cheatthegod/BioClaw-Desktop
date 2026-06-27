// Env state — single source of truth for the bundled-Python lifecycle.
//
// Three "kinds" of state coexist:
//   1. Disk facts (synchronous) — does the project dir exist, is the
//      venv populated, was the bundle source extracted? Read via
//      `readDiskState()`.
//   2. In-flight install — the auto-setup task that fires on sidecar
//      start when a bundled zip exists. Held in module-level mutable
//      state (`currentInstall`) so /env/state reflects progress
//      without a second IPC mechanism.
//   3. Composite — `readEnvState()` merges the two: if an install is
//      in progress we report `status: 'installing'` regardless of
//      what's on disk, so the frontend renders the inline progress
//      banner instead of pretending the env is ready.
//
// Consumers:
//   * GET /health         — surfaces `env.status` for boot decisions.
//   * GET /env/state      — full state for the frontend banner.
//   * run_skill_script    — uses `preferredInterpreter()` to pick the
//                           venv python (falls back to host python3).

import fs from 'node:fs';
import path from 'node:path';

import { defaultProjectDir, venvPython, bundledEnvSourceDir } from './paths.js';

export type EnvStatus = 'unknown' | 'needs-setup' | 'installing' | 'ready' | 'broken';

export interface EnvState {
  readonly status: EnvStatus;
  readonly projectDir: string;
  readonly pythonPath: string | null;
  readonly projectInitialized: boolean;
  readonly bundledSourceDir: string | null;
  /** Set while status === 'installing'. Latest phase label from the installer. */
  readonly installPhase?: string;
  /** Set if the last install attempt failed; cleared on retry. */
  readonly lastError?: string;
}

interface DiskFacts {
  readonly projectDir: string;
  readonly bundledSourceDir: string | null;
  readonly projectInitialized: boolean;
  readonly pythonPath: string | null;
  readonly venvOk: boolean;
}

/** Synchronous probe of disk-side facts only. */
export function readDiskState(): DiskFacts {
  const projectDir = defaultProjectDir();
  const bundledSourceDir = bundledEnvSourceDir();

  const pyproject = path.join(projectDir, 'pyproject.toml');
  const lock = path.join(projectDir, 'uv.lock');
  const pyVersion = path.join(projectDir, '.python-version');
  const projectInitialized =
    fs.existsSync(pyproject) && fs.existsSync(lock) && fs.existsSync(pyVersion);

  const py = venvPython(projectDir);
  const venvOk = fs.existsSync(py);

  return {
    projectDir,
    bundledSourceDir,
    projectInitialized,
    pythonPath: venvOk ? py : null,
    venvOk,
  };
}

// ---- in-flight install bookkeeping ---------------------------------

interface CurrentInstall {
  phase: string;
  lastError: string | null;
  doneAt: number | null;
}
let currentInstall: CurrentInstall | null = null;

export function beginInstall(initialPhase = 'Preparing local Python kernel'): void {
  currentInstall = { phase: initialPhase, lastError: null, doneAt: null };
}
export function setInstallPhase(phase: string): void {
  if (currentInstall) currentInstall.phase = phase;
}
export function failInstall(message: string): void {
  if (currentInstall) {
    currentInstall.lastError = message;
    currentInstall.doneAt = Date.now();
  }
}
export function completeInstall(): void {
  if (currentInstall) currentInstall.doneAt = Date.now();
}
/** Drop the install bookkeeping. Called after a clean success — the
 *  composite read then exposes status: 'ready' purely from disk. */
export function clearInstall(): void {
  currentInstall = null;
}
export function isInstalling(): boolean {
  return currentInstall !== null && currentInstall.doneAt === null;
}

// ---- composite read ------------------------------------------------

/** What the frontend sees. Merges disk facts with the in-flight install. */
export function readEnvState(): EnvState {
  const disk = readDiskState();

  let status: EnvStatus;
  if (isInstalling()) {
    status = 'installing';
  } else if (disk.venvOk) {
    status = 'ready';
  } else if (!disk.projectInitialized && !disk.venvOk) {
    status = 'needs-setup';
  } else if (disk.projectInitialized && !disk.venvOk) {
    status = 'needs-setup';
  } else {
    status = 'unknown';
  }

  return {
    status,
    projectDir: disk.projectDir,
    pythonPath: disk.pythonPath,
    projectInitialized: disk.projectInitialized,
    bundledSourceDir: disk.bundledSourceDir,
    ...(currentInstall?.phase ? { installPhase: currentInstall.phase } : {}),
    ...(currentInstall?.lastError ? { lastError: currentInstall.lastError } : {}),
  };
}

/** Pick the interpreter for `run_skill_script`. Null = fall back to PATH. */
export function preferredInterpreter(): string | null {
  const state = readEnvState();
  if (state.status === 'ready' && state.pythonPath) return state.pythonPath;
  return null;
}
