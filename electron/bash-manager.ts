/**
 * Bash Environment Manager for BioClaw Desktop (Windows only).
 *
 * The agent-runner's Bash tool (container/agent-runner/src/index.ts)
 * hard-wires `shell: '/bin/bash'`. On Windows that path does not exist,
 * so every shell command from the agent fails with `ENOENT`. To keep the
 * desktop app self-contained (no Docker, no external Git install) we
 * download a portable Git Bash on first run, unpack it under
 *   `<userData>/data/bash/`
 * and tell the agent-runner to use that bash via `BIOCLAW_BASH_BIN`.
 *
 * On macOS and Linux `/bin/bash` is always present, so this module is a
 * no-op (`isNeeded()` returns false).
 *
 * The release asset used is Git for Windows' PortableGit — a 7-Zip
 * self-extracting archive (no real installer, just unpacks files) that
 * ships bash.exe plus the coreutils (sed, awk, grep, curl, …) BioClaw
 * skills rely on.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import os from 'os';
import { spawn } from 'child_process';

// ── Pinned Git for Windows PortableGit release ─────────────────────────
//
// To re-pin: download the asset from the URL below, run `sha256sum`, and
// paste the 64-char hex string into PORTABLE_GIT_SHA256.
//
//   https://github.com/git-for-windows/git/releases/tag/v2.47.0.windows.1
//
const PORTABLE_GIT_VERSION = '2.47.0.windows.1';
const PORTABLE_GIT_FILENAME = 'PortableGit-2.47.0-64-bit.7z.exe';
const PORTABLE_GIT_URL =
  `https://github.com/git-for-windows/git/releases/download/v${PORTABLE_GIT_VERSION}/${PORTABLE_GIT_FILENAME}`;

// SHA256 of the binary above. Empty string = verification skipped (dev
// only). Pin before shipping a release build.
const PORTABLE_GIT_SHA256 = '';

export interface BashInstallProgress {
  percent: number;
  message: string;
}

export class BashManager {
  private dataDir: string;
  private bashDir: string;
  /**
   * Cache for detected system Git Bash path so we don't re-scan every
   * call. Null = not yet scanned; '' = scanned and nothing found.
   */
  private cachedSystemBashPath: string | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.bashDir = path.join(dataDir, 'bash');
  }

  /** True only on Windows — other platforms already have /bin/bash. */
  static isNeeded(): boolean {
    return process.platform === 'win32';
  }

  /**
   * Whether a usable bash is available for the agent. On non-Windows
   * the OS provides it, so we always report installed.
   *
   * On Windows we consider bash installed if EITHER:
   *   - we already downloaded our own copy under <userData>/data/bash/, OR
   *   - the user has Git for Windows installed (we reuse its bash.exe)
   */
  isInstalled(): boolean {
    if (!BashManager.isNeeded()) return true;
    if (fs.existsSync(this.bundledBashPath())) return true;
    return !!this.findSystemBash();
  }

  /**
   * Absolute path to the bash executable the agent should use. On
   * non-Windows this is the system /bin/bash.
   *
   * On Windows, prefer bundled > system — bundled is deterministic
   * (we know the version) and always present once install() has run.
   */
  getBashPath(): string {
    if (process.platform !== 'win32') return '/bin/bash';
    const bundled = this.bundledBashPath();
    if (fs.existsSync(bundled)) return bundled;
    const system = this.findSystemBash();
    if (system) return system;
    // Return the bundled path anyway — callers can check isInstalled()
    // to decide whether to kick off an install.
    return bundled;
  }

  /** Path we would unpack PortableGit to. May or may not exist. */
  private bundledBashPath(): string {
    return path.join(this.bashDir, 'bin', 'bash.exe');
  }

  /**
   * Search the common install locations for an existing Git for Windows
   * and return bash.exe if found. Returns null if nothing usable exists.
   *
   * Order matches what pheuter/claude-agent-desktop does — we check
   * per-user installs first (no admin rights needed) before machine
   * installs, and PATH last because it's the slowest to probe.
   */
  private findSystemBash(): string | null {
    if (process.platform !== 'win32') return null;
    if (this.cachedSystemBashPath !== null) {
      return this.cachedSystemBashPath || null;
    }

    const candidates: string[] = [];

    // 1. Per-user install (winget / scoop / manual)
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'));
    }
    const userProfile = process.env.USERPROFILE || os.homedir();
    if (userProfile) {
      // Scoop shim
      candidates.push(path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'));
    }

    // 2. Machine-wide installs
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
    candidates.push(path.join(programFiles86, 'Git', 'bin', 'bash.exe'));

    // 3. Anything on PATH (last resort — iterates PATH entries)
    const envPath = process.env.PATH || '';
    for (const dir of envPath.split(path.delimiter)) {
      if (!dir) continue;
      // Git install layout always has bin/bash.exe — don't accept a
      // bare bash.exe on PATH (that's usually WSL shim which can't
      // execute Windows paths).
      if (/[\\/]Git[\\/](cmd|bin)[\\/]?$/i.test(dir)) {
        candidates.push(path.join(dir, 'bash.exe'));
        // Git's cmd dir has bash.exe shim; real bash is under bin/
        candidates.push(path.join(path.dirname(dir), 'bin', 'bash.exe'));
      }
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          this.cachedSystemBashPath = candidate;
          return candidate;
        }
      } catch {
        // ignore EACCES etc and keep scanning
      }
    }

    this.cachedSystemBashPath = '';
    return null;
  }

  async install(
    onProgress: (p: BashInstallProgress) => void,
  ): Promise<void> {
    if (!BashManager.isNeeded()) {
      onProgress({ percent: 100, message: 'Bash already available' });
      return;
    }

    // Fast path 1: we already extracted a bundled copy earlier.
    if (fs.existsSync(this.bundledBashPath())) {
      onProgress({ percent: 100, message: 'Bash already installed' });
      return;
    }

    // Fast path 2: user has Git for Windows installed — reuse it and
    // skip the 50 MB download. We cache the detected path so getBashPath()
    // returns it immediately.
    const systemBash = this.findSystemBash();
    if (systemBash) {
      onProgress({
        percent: 100,
        message: `Found existing Git Bash at ${systemBash}`,
      });
      return;
    }

    // ── Step 1: Download ──
    onProgress({ percent: 5, message: 'Downloading Git Bash...' });
    const installerPath = path.join(this.dataDir, 'portable-git-installer.exe');
    await this.downloadFile(PORTABLE_GIT_URL, installerPath, (frac) => {
      onProgress({
        percent: 5 + Math.round(frac * 55),
        message: `Downloading Git Bash... ${Math.round(frac * 100)}%`,
      });
    });

    // ── Step 2: Verify checksum (if pinned) ──
    if (PORTABLE_GIT_SHA256) {
      onProgress({ percent: 60, message: 'Verifying download integrity...' });
      const valid = await this.verifyChecksum(installerPath, PORTABLE_GIT_SHA256);
      if (!valid) {
        try { fs.unlinkSync(installerPath); } catch { /* ignore */ }
        throw new Error('Download integrity check failed — SHA256 mismatch');
      }
    }

    // ── Step 3: Extract ──
    onProgress({ percent: 65, message: 'Extracting Git Bash...' });
    // Start fresh — remove any previous partial extraction.
    if (fs.existsSync(this.bashDir)) {
      fs.rmSync(this.bashDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.bashDir, { recursive: true });

    // PortableGit-xxx.7z.exe is a 7-Zip SFX archive. Flags:
    //   -y        answer yes to all prompts (no UI)
    //   -o<path>  output directory — NO space between -o and path
    await this.spawnAsync(
      installerPath,
      ['-y', `-o${this.bashDir}`],
      300_000,
    );

    // ── Step 4: Verify ──
    onProgress({ percent: 95, message: 'Verifying bash installation...' });
    const bash = this.getBashPath();
    if (!fs.existsSync(bash)) {
      throw new Error(
        `Bash installation failed — ${bash} not found after extraction`,
      );
    }
    // Smoke test: can we actually launch the thing?
    try {
      await this.spawnAsync(bash, ['--version'], 15_000);
    } catch (e) {
      throw new Error(
        `Bash installed but failed to run: ${(e as Error).message}`,
      );
    }

    // Clean up the installer blob — the extracted files are what we need.
    try { fs.unlinkSync(installerPath); } catch { /* ignore */ }

    onProgress({ percent: 100, message: 'Git Bash ready!' });
  }

  /** Spawn a process and return a promise. No shell involved. */
  private spawnAsync(
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Operation timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(
            `Exited with code ${code}` +
            (stderr ? `\n${stderr.slice(0, 500)}` : ''),
          ));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private verifyChecksum(
    filePath: string,
    expectedSha256: string,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex') === expectedSha256));
      stream.on('error', reject);
    });
  }

  private downloadFile(
    url: string,
    dest: string,
    onProgress: (fraction: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const doRequest = (requestUrl: string, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'));
          return;
        }

        const file = fs.createWriteStream(dest);
        https
          .get(
            requestUrl,
            { headers: { 'User-Agent': 'BioClaw-Desktop/1.0' } },
            (response) => {
              if (
                (response.statusCode === 301 || response.statusCode === 302) &&
                response.headers.location
              ) {
                file.close();
                try { fs.unlinkSync(dest); } catch { /* ignore */ }
                doRequest(response.headers.location, redirectCount + 1);
                return;
              }

              if (response.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(dest); } catch { /* ignore */ }
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
              }

              const total = parseInt(
                String(response.headers['content-length'] || '0'),
                10,
              );
              let received = 0;
              response.on('data', (chunk: Buffer) => {
                received += chunk.length;
                if (total > 0) onProgress(received / total);
              });
              response.pipe(file);
              file.on('finish', () => {
                file.close(() => resolve());
              });
              file.on('error', (err) => {
                try { fs.unlinkSync(dest); } catch { /* ignore */ }
                reject(err);
              });
            },
          )
          .on('error', (err) => {
            file.close();
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
            reject(err);
          });
      };
      doRequest(url);
    });
  }
}
