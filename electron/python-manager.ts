/**
 * Python Environment Manager for BioClaw Desktop.
 *
 * Downloads and installs Miniconda + scientific packages on first run.
 * Version-pinned with SHA256 verification.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

// ── Pinned Miniconda versions ──

interface MinicondaRelease {
  url: string;
  sha256: string;
}

// Miniconda3 py311_24.11.1-0 — pinned for reproducibility
const MINICONDA: Record<string, MinicondaRelease> = {
  'win32-x64': {
    url: 'https://repo.anaconda.com/miniconda/Miniconda3-py311_24.11.1-0-Windows-x86_64.exe',
    sha256: '43dcbcc315ff91edf959e002cd2f1ede38c64b999fefcc951bccf2ed69c9e8bb',
  },
  'darwin-x64': {
    url: 'https://repo.anaconda.com/miniconda/Miniconda3-py311_24.11.1-0-MacOSX-x86_64.sh',
    sha256: '388f669ab95d659b4c97353f756ce93ed2000ec0114edaec9688f8541fa4bcab',
  },
  'darwin-arm64': {
    url: 'https://repo.anaconda.com/miniconda/Miniconda3-py311_24.11.1-0-MacOSX-arm64.sh',
    sha256: '862af4d7cb257219c6b280848049e09e1aff27acd06d5422359f2249f938e282',
  },
  'linux-x64': {
    url: 'https://repo.anaconda.com/miniconda/Miniconda3-py311_24.11.1-0-Linux-x86_64.sh',
    sha256: '807774bae6cd87132094458217ebf713df436f64779faf9bb4c3d4b6615c1e3a',
  },
};

// ── Pinned pip packages ──

const PIP_PACKAGES = [
  'numpy==1.26.4',
  'scipy==1.14.1',
  'pandas==2.2.3',
  'matplotlib==3.9.3',
  'seaborn==0.13.2',
  'biopython==1.84',
  'typst==0.14.8',
  'fpdf2==2.8.2',
  'openpyxl==3.1.5',
  'scikit-learn==1.5.2',
];

export interface InstallProgress {
  percent: number;
  message: string;
}

// Pip mirror sources — Chinese mirrors are much faster in mainland China
const PIP_MIRRORS: Record<string, string> = {
  default: 'https://pypi.org/simple',
  tsinghua: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  aliyun: 'https://mirrors.aliyun.com/pypi/simple',
  ustc: 'https://pypi.mirrors.ustc.edu.cn/simple',
};

export class PythonManager {
  private dataDir: string;
  private pythonDir: string;
  private pipMirror: string;

  constructor(dataDir: string, mirror: string = 'default') {
    this.dataDir = dataDir;
    this.pythonDir = path.join(dataDir, 'python');
    this.pipMirror = PIP_MIRRORS[mirror] || PIP_MIRRORS.default;
  }

  setMirror(mirror: string): void {
    this.pipMirror = PIP_MIRRORS[mirror] || mirror;  // support custom URLs too
  }

  isInstalled(): boolean {
    return fs.existsSync(this.getPythonPath());
  }

  getPythonPath(): string {
    if (process.platform === 'win32') {
      return path.join(this.pythonDir, 'python.exe');
    }
    return path.join(this.pythonDir, 'bin', 'python3');
  }

  private getPipPath(): string {
    if (process.platform === 'win32') {
      return path.join(this.pythonDir, 'Scripts', 'pip.exe');
    }
    return path.join(this.pythonDir, 'bin', 'pip');
  }

  async install(
    onProgress: (p: InstallProgress) => void,
  ): Promise<void> {
    const platformKey = `${process.platform}-${process.arch}`;
    const release = MINICONDA[platformKey];
    if (!release) {
      throw new Error(`Unsupported platform: ${platformKey}`);
    }

    // ── Step 1: Download Miniconda ──
    onProgress({ percent: 5, message: 'Downloading Python environment...' });

    const ext = process.platform === 'win32' ? '.exe' : '.sh';
    const installerPath = path.join(this.dataDir, `miniconda-installer${ext}`);

    await this.downloadFile(release.url, installerPath, (frac) => {
      onProgress({
        percent: 5 + Math.round(frac * 35),
        message: `Downloading... ${Math.round(frac * 100)}%`,
      });
    });

    // ── Step 1b: Verify checksum (if hash is set) ──
    if (release.sha256) {
      onProgress({ percent: 40, message: 'Verifying download integrity...' });
      const valid = await this.verifyChecksum(installerPath, release.sha256);
      if (!valid) {
        fs.unlinkSync(installerPath);
        throw new Error('Download integrity check failed — SHA256 mismatch');
      }
    }

    // ── Step 2: Install Miniconda ──
    onProgress({ percent: 42, message: 'Installing Python runtime...' });
    await this.runInstaller(installerPath);

    // ── Step 3: Install pip packages ──
    const pip = this.getPipPath();
    const total = PIP_PACKAGES.length;
    for (let i = 0; i < total; i++) {
      const pkg = PIP_PACKAGES[i];
      const name = pkg.split('==')[0];
      onProgress({
        percent: 50 + Math.round((i / total) * 45),
        message: `Installing ${name} (${i + 1}/${total})...`,
      });
      try {
        const pipArgs = ['install', '--quiet', pkg];
        if (this.pipMirror !== PIP_MIRRORS.default) {
          pipArgs.push('-i', this.pipMirror);
          pipArgs.push('--trusted-host', new URL(this.pipMirror).hostname);
        }
        await execFile(pip, pipArgs, { timeout: 180_000 });
      } catch (e) {
        console.error(`Failed to install ${pkg}:`, e);
        // Non-critical packages: warn but continue
      }
    }

    // ── Step 4: Cleanup ──
    onProgress({ percent: 97, message: 'Cleaning up...' });
    try {
      fs.unlinkSync(installerPath);
    } catch { /* ignore */ }

    // ── Step 5: Verify ──
    const python = this.getPythonPath();
    if (!fs.existsSync(python)) {
      throw new Error(`Python installation failed — ${python} not found`);
    }

    onProgress({ percent: 100, message: 'Python environment ready!' });
  }

  private async runInstaller(installerPath: string): Promise<void> {
    // Clean up target directory if partial install exists
    if (fs.existsSync(this.pythonDir)) {
      fs.rmSync(this.pythonDir, { recursive: true, force: true });
    }

    if (process.platform === 'win32') {
      // Windows: use spawn with explicit args (no shell) to avoid
      // cmd.exe quoting issues with NSIS /D= parameter
      await this.spawnAsync(installerPath, [
        '/InstallationType=JustMe',
        '/RegisterPython=0',
        '/AddToPath=0',
        '/S',
        `/D=${this.pythonDir}`,
      ], 600_000);
    } else {
      fs.chmodSync(installerPath, 0o755);
      await this.spawnAsync('bash', [
        installerPath, '-b', '-p', this.pythonDir,
      ], 600_000);
    }
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
        shell: false,  // critical: do NOT use shell
        windowsHide: true,
      });

      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Installer timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(
            `Installer exited with code ${code}` +
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

  private async verifyChecksum(
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
          .get(requestUrl, { headers: { 'User-Agent': 'BioClaw-Desktop/1.0' } }, (response) => {
            // Handle redirects
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

            const totalBytes = parseInt(
              response.headers['content-length'] || '0',
              10,
            );
            let downloadedBytes = 0;

            response.on('data', (chunk: Buffer) => {
              downloadedBytes += chunk.length;
              if (totalBytes > 0) {
                onProgress(downloadedBytes / totalBytes);
              }
            });

            response.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
          })
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
