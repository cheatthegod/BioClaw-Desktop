/**
 * Encrypted configuration store for BioClaw Desktop.
 *
 * Uses Electron's safeStorage API (OS keychain) to encrypt the API key.
 * If safeStorage is unavailable, refuses to store — user must input each time.
 */

import fs from 'fs';
import path from 'path';

// Import safeStorage at the top level (ESM-compatible).
// This file is only ever loaded by Electron main process, so the import is safe.
import { safeStorage } from 'electron';

function getSafeStorage() {
  // safeStorage is available in the main process after app 'ready'
  return safeStorage;
}

export type ProviderType = 'anthropic' | 'openrouter' | 'custom';

export interface ProviderConfig {
  provider: ProviderType;
  baseUrl?: string;   // custom/openrouter base URL
  model?: string;     // model name for openrouter/custom
}

export interface SetupState {
  apiKeySet: boolean;
  pythonInstalled: boolean;
  /** Windows-only; always true on macOS/Linux (system /bin/bash). */
  bashInstalled: boolean;
}

interface ConfigData {
  setupState: SetupState;
  apiKeyEncrypted?: string;
  providerConfig?: ProviderConfig;
  theme?: 'light' | 'dark';
  language?: 'zh' | 'en';
  lastPort?: number;
}

export class ConfigStore {
  private configPath: string;
  private data: ConfigData;

  constructor(userDataDir: string) {
    this.configPath = path.join(userDataDir, 'config.json');
    this.data = this.load();
  }

  // ── Setup state ──

  getSetupState(): SetupState {
    return { ...this.data.setupState };
  }

  isFullyConfigured(): boolean {
    return this.data.setupState.apiKeySet
      && this.data.setupState.pythonInstalled
      && this.data.setupState.bashInstalled;
  }

  setApiKeySet(v: boolean): void {
    this.data.setupState.apiKeySet = v;
    this.save();
  }

  setPythonInstalled(v: boolean): void {
    this.data.setupState.pythonInstalled = v;
    this.save();
  }

  setBashInstalled(v: boolean): void {
    this.data.setupState.bashInstalled = v;
    this.save();
  }

  // ── API Key (encrypted) ──

  setApiKey(key: string): boolean {
    const ss = getSafeStorage();
    if (ss && ss.isEncryptionAvailable()) {
      this.data.apiKeyEncrypted = ss.encryptString(key).toString('base64');
      this.data.setupState.apiKeySet = true;
      this.save();
      return true;
    }
    // safeStorage not available — refuse to store in plaintext
    console.warn(
      'safeStorage not available — API key will not be persisted. ' +
        'Install a keychain service (libsecret on Linux) for persistent storage.',
    );
    return false;
  }

  getApiKey(): string {
    if (!this.data.apiKeyEncrypted) return '';
    const ss = getSafeStorage();
    if (!ss || !ss.isEncryptionAvailable()) return '';
    try {
      return ss.decryptString(
        Buffer.from(this.data.apiKeyEncrypted, 'base64'),
      );
    } catch {
      return '';
    }
  }

  /** Check if we have a stored (encrypted) API key */
  hasApiKey(): boolean {
    return Boolean(this.data.apiKeyEncrypted);
  }

  // ── Provider config ──

  setProviderConfig(cfg: ProviderConfig): void {
    this.data.providerConfig = cfg;
    this.save();
  }

  getProviderConfig(): ProviderConfig {
    return this.data.providerConfig || { provider: 'anthropic' };
  }

  // ── Generic get/set ──

  get<K extends keyof ConfigData>(key: K): ConfigData[K] {
    return this.data[key];
  }

  set<K extends keyof ConfigData>(key: K, value: ConfigData[K]): void {
    this.data[key] = value;
    this.save();
  }

  // ── Persistence ──

  private load(): ConfigData {
    // Non-Windows systems always have /bin/bash, so treat it as
    // pre-installed for default state and for migrating older configs
    // written before the bashInstalled flag existed.
    const bashDefault = process.platform !== 'win32';

    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed.setupState) {
          parsed.setupState = {
            apiKeySet: false,
            pythonInstalled: false,
            bashInstalled: bashDefault,
          };
        } else if (parsed.setupState.bashInstalled === undefined) {
          // Migration: older configs predate the bash flag.
          parsed.setupState.bashInstalled = bashDefault;
        }
        return parsed;
      }
    } catch (e) {
      console.warn('Failed to load config:', e);
    }
    return {
      setupState: {
        apiKeySet: false,
        pythonInstalled: false,
        bashInstalled: bashDefault,
      },
    };
  }

  private save(): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
  }
}
