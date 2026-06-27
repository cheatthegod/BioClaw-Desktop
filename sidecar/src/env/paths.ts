// Cross-platform paths for the bundled Python env.
//
// Three layers:
//   1. Resource dir  — read-only, ships in the installer.
//      Set by the Tauri Rust supervisor via BIOCLAW_RESOURCE_DIR.
//      Contains: `bioclaw-env/{pyproject.toml,uv.lock,.python-version,README.md}`
//      plus the bundled `uv` binary (next to the sidecar in
//      `binaries/uv-<rustc-triple>`).
//   2. Project dir   — writable, lives under the user's home.
//      Default: `~/.bioclaw/env/`. This is where we COPY the
//      resource-dir source files on first setup and where uv writes
//      `.venv/`. Survives app upgrades; users can wipe it to force a
//      re-sync.
//   3. uv data dir   — uv's own cache + downloaded interpreters,
//      shared across BioClaw versions (and any other uv consumer on
//      the machine). uv chooses this itself unless we override.

import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

/** Default user-side project dir. Override via BIOCLAW_ENV_DIR. */
export function defaultProjectDir(): string {
  const override = process.env['BIOCLAW_ENV_DIR'];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), '.bioclaw', 'env');
}

/** Per-platform venv interpreter path inside the project dir. */
export function venvPython(projectDir: string): string {
  if (process.platform === 'win32') {
    return path.join(projectDir, '.venv', 'Scripts', 'python.exe');
  }
  return path.join(projectDir, '.venv', 'bin', 'python');
}

/** Tauri's resource_dir() lands here at runtime — set by Rust supervisor. */
export function resourceDir(): string | null {
  const v = process.env['BIOCLAW_RESOURCE_DIR'];
  return v && v.length > 0 ? v : null;
}

/** Where the bundled env sources live within resource_dir. */
export function bundledEnvSourceDir(): string | null {
  const r = resourceDir();
  return r ? path.join(r, 'bioclaw-env') : null;
}

/** Pre-baked env zip (CPython + uv-cache + sources) — primary install
 *  path. Tauri ships it as a bundle resource at
 *  `<resource_dir>/bioclaw-env.zip`. The legacy
 *  `bundledEnvSourceDir()` (pyproject + lock as loose files) is still
 *  accepted as a fallback for the network-install code path. */
export function bundledEnvZip(): string | null {
  const r = resourceDir();
  if (!r) return null;
  const p = path.join(r, 'bioclaw-env.zip');
  return p;
}

/** Where the bundled uv binary lives. tauri-bundler renames
 *  `binaries/uv-<rustc-triple>(.exe)` to plain `uv(.exe)` at install
 *  time and drops it next to the main binary. We probe both the
 *  resource dir (Linux .deb layout) and the install dir + PATH for
 *  resilience. */
export function bundledUvBinary(): string {
  return process.platform === 'win32' ? 'uv.exe' : 'uv';
}
