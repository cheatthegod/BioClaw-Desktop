/**
 * Runtime Context — the single source of truth for all paths, ports, and mode.
 *
 * Every module that needs a directory path, the DB location, the HTTP binding,
 * or the assets root MUST read it from here — never from process.cwd() or
 * hardcoded constants.
 *
 * Two construction patterns:
 *   RuntimeContext.forServer()   — backward-compatible with current npm run web
 *   RuntimeContext.forDesktop()  — Electron desktop app
 */

import path from 'path';
import { getHomeDir } from './platform.js';

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface RuntimeOptions {
  /** 'server' = Docker containers, 'desktop' = local subprocess */
  mode: 'server' | 'desktop';

  // ── Mutable state directories ──
  /** Root for workspaces / group folders */
  groupsDir: string;
  /** Root for IPC, sessions, migrations */
  dataDir: string;
  /** Root for SQLite DB files */
  stateDir: string;

  // ── Immutable resource directories ──
  /** Directory containing skill modules */
  skillsDir: string;
  /** Directory containing web UI assets (index.html, app.js, style.css) */
  webAssetsDir: string;
  /** Path to favicon / logo image */
  logoPath: string;
  /** Directory containing vendor scripts (marked.umd.js, purify.min.js) */
  vendorScriptsDir?: string;

  // ── Executables (desktop only) ──
  /** Python executable path */
  pythonPath?: string;
  /** Bash executable path (portable Git Bash on Windows, /bin/bash elsewhere) */
  bashPath?: string;
  /** Compiled agent-runner entry point (index.js) */
  agentRunnerPath?: string;

  // ── Credentials & Provider ──
  /** API key (works for Anthropic, OpenRouter, or custom provider) */
  apiKey?: string;
  /** Provider type: 'anthropic' | 'openrouter' | 'custom' */
  providerType?: string;
  /** Base URL for OpenRouter or custom provider */
  providerBaseUrl?: string;
  /** Model name for OpenRouter or custom provider */
  providerModel?: string;

  // ── HTTP binding ──
  /** Port for the local web server (0 = auto-assign) */
  port?: number;
  /** Host for the local web server */
  host?: string;
}

// ---------------------------------------------------------------------------
// RuntimeContext class
// ---------------------------------------------------------------------------

export class RuntimeContext {
  readonly mode: 'server' | 'desktop';

  // State directories
  readonly groupsDir: string;
  readonly dataDir: string;
  readonly stateDir: string;

  // Resource directories
  readonly skillsDir: string;
  readonly webAssetsDir: string;
  readonly logoPath: string;
  readonly vendorScriptsDir: string;

  // Executables
  readonly pythonPath: string;
  readonly bashPath: string;
  readonly agentRunnerPath: string;

  // Credentials & Provider
  readonly apiKey: string;
  readonly providerType: string;
  readonly providerBaseUrl: string;
  readonly providerModel: string;

  // HTTP
  readonly port: number;
  readonly host: string;

  constructor(opts: RuntimeOptions) {
    this.mode = opts.mode;

    // State
    this.groupsDir = path.resolve(opts.groupsDir);
    this.dataDir = path.resolve(opts.dataDir);
    this.stateDir = path.resolve(opts.stateDir);

    // Resources
    this.skillsDir = path.resolve(opts.skillsDir);
    this.webAssetsDir = path.resolve(opts.webAssetsDir);
    this.logoPath = path.resolve(opts.logoPath);
    this.vendorScriptsDir = opts.vendorScriptsDir
      ? path.resolve(opts.vendorScriptsDir)
      : path.resolve(this.webAssetsDir, '..', 'vendor');

    // Executables
    this.pythonPath = opts.pythonPath || 'python3';
    // Windows has no /bin/bash; caller (Electron main) must pass a real
    // path from BashManager. Non-Windows defaults to /bin/bash.
    this.bashPath = opts.bashPath || (process.platform === 'win32' ? '' : '/bin/bash');
    this.agentRunnerPath = opts.agentRunnerPath || '';

    // Credentials & Provider
    this.apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.providerType = opts.providerType || 'anthropic';
    this.providerBaseUrl = opts.providerBaseUrl || '';
    this.providerModel = opts.providerModel || '';

    // HTTP
    this.port = opts.port ?? parseInt(process.env.LOCAL_WEB_PORT || '3000', 10);
    this.host = opts.host ?? (process.env.LOCAL_WEB_HOST || 'localhost');
  }

  // ── Derived paths ──

  /** SQLite database file */
  get dbPath(): string {
    return path.join(this.stateDir, 'messages.db');
  }

  /** IPC base directory */
  get ipcBaseDir(): string {
    return path.join(this.dataDir, 'ipc');
  }

  /** Sessions base directory */
  get sessionsDir(): string {
    return path.join(this.dataDir, 'sessions');
  }

  /** Mount security allowlist path (always outside project) */
  get mountAllowlistPath(): string {
    return path.join(getHomeDir(), '.config', 'bioclaw', 'mount-allowlist.json');
  }

  // ── Per-agent paths ──

  ipcDirForAgent(agentId: string): string {
    return path.join(this.ipcBaseDir, agentId);
  }

  sessionDirForAgent(agentId: string): string {
    return path.join(this.sessionsDir, agentId, '.claude');
  }

  skillsDirForAgent(agentId: string): string {
    return path.join(this.sessionsDir, agentId, '.claude', 'skills');
  }

  /** Workspace directory for a group folder */
  groupDir(folder: string): string {
    return path.join(this.groupsDir, folder);
  }

  /** Logs directory for a group */
  logsDir(folder: string): string {
    return path.join(this.groupsDir, folder, 'logs');
  }

  /** Notebooks directory for a group */
  notebooksDir(folder: string): string {
    return path.join(this.groupsDir, folder, 'notebooks');
  }

  // ── Mode helpers ──

  get isDesktop(): boolean {
    return this.mode === 'desktop';
  }

  get isServer(): boolean {
    return this.mode === 'server';
  }

  // ── Factory: server mode (backward-compatible with current behavior) ──

  static forServer(): RuntimeContext {
    const root = process.cwd();
    return new RuntimeContext({
      mode: 'server',
      groupsDir: path.join(root, 'groups'),
      dataDir: path.join(root, 'data'),
      stateDir: path.join(root, 'store'),
      skillsDir: path.join(root, 'container', 'skills'),
      webAssetsDir: path.join(root, 'src', 'channels', 'local-web', 'assets'),
      logoPath: path.join(root, 'bioclaw_logo.jpg'),
    });
  }

  // ── Factory: desktop mode (Electron) ──

  static forDesktop(userDataDir: string, resourcesDir: string): RuntimeContext {
    return new RuntimeContext({
      mode: 'desktop',
      groupsDir: path.join(userDataDir, 'workspaces'),
      dataDir: path.join(userDataDir, 'data'),
      stateDir: path.join(userDataDir, 'store'),
      skillsDir: path.join(resourcesDir, 'skills'),
      webAssetsDir: path.join(resourcesDir, 'web-assets'),
      logoPath: path.join(resourcesDir, 'web-assets', 'bioclaw_logo.jpg'),
      vendorScriptsDir: path.join(resourcesDir, 'web-assets', 'vendor'),
      agentRunnerPath: path.join(
        resourcesDir,
        'agent-runner',
        'dist',
        'index.js',
      ),
      port: 0, // auto-assign
      host: '127.0.0.1',
    });
  }
}

// ---------------------------------------------------------------------------
// Global singleton — set once at startup, read everywhere
// ---------------------------------------------------------------------------

let _ctx: RuntimeContext | null = null;

/**
 * Initialize the global runtime context. Must be called exactly once,
 * before any module reads getRuntime().
 */
export function initRuntime(ctx: RuntimeContext): void {
  if (_ctx) {
    throw new Error(
      'initRuntime() called twice — runtime context is immutable after init',
    );
  }
  _ctx = ctx;
}

/**
 * Get the global runtime context. Throws if initRuntime() hasn't been called.
 */
export function getRuntime(): RuntimeContext {
  if (!_ctx) {
    throw new Error(
      'getRuntime() called before initRuntime() — ' +
        'ensure the entry point calls initRuntime() before importing other modules',
    );
  }
  return _ctx;
}
