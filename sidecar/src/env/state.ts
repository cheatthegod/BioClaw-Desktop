// Env state detection. Used by:
//   * GET /health  — surfaces { needsSetup: bool, projectDir, pythonPath }
//   * GET /env/state — explicit query from the SetupWizard
//   * the `run_skill_script` tool — picks which interpreter to invoke
//     (bundled venv first, then user-selected, then host python3 as
//     a last-resort fallback so existing-Phase-4 behavior still
//     works on machines where the user hasn't run setup yet).

import fs from 'node:fs';
import path from 'node:path';
import { defaultProjectDir, venvPython, bundledEnvSourceDir } from './paths.js';

export type EnvStatus = 'unknown' | 'needs-setup' | 'ready' | 'broken';

export interface EnvState {
  /** Coarse state for the wizard's decision tree. */
  readonly status: EnvStatus;
  /** Resolved project dir (whether it exists yet or not). */
  readonly projectDir: string;
  /** Path to the venv interpreter, OR null when no venv exists. */
  readonly pythonPath: string | null;
  /** Has the bundled `bioclaw-env/` source been copied into projectDir yet? */
  readonly projectInitialized: boolean;
  /** Path of the bundled source (read-only). */
  readonly bundledSourceDir: string | null;
}

/** Synchronous probe — fast, no shell exec. */
export function readEnvState(): EnvState {
  const projectDir = defaultProjectDir();
  const bundledSourceDir = bundledEnvSourceDir();

  // The wizard treats the project as "initialized" once we've copied
  // pyproject.toml + uv.lock + .python-version from the bundle. Those
  // three are the contract uv reads from.
  const pyproject = path.join(projectDir, 'pyproject.toml');
  const lock = path.join(projectDir, 'uv.lock');
  const pyVersion = path.join(projectDir, '.python-version');
  const projectInitialized =
    fs.existsSync(pyproject) && fs.existsSync(lock) && fs.existsSync(pyVersion);

  const py = venvPython(projectDir);
  const venvOk = fs.existsSync(py);

  let status: EnvStatus;
  if (!projectInitialized && !venvOk) status = 'needs-setup';
  else if (venvOk) status = 'ready';
  else if (projectInitialized && !venvOk) status = 'needs-setup';
  else status = 'unknown';

  return {
    status,
    projectDir,
    pythonPath: venvOk ? py : null,
    projectInitialized,
    bundledSourceDir,
  };
}

/** Pick the interpreter to use for `run_skill_script`. Returns null
 *  when nothing is available — the runner falls back to `python3` on
 *  PATH in that case (Phase-4 behavior). */
export function preferredInterpreter(): string | null {
  // Future: also honour BIOCLAW_KERNEL_PYTHON for user-selected envs.
  const state = readEnvState();
  if (state.status === 'ready' && state.pythonPath) return state.pythonPath;
  return null;
}
