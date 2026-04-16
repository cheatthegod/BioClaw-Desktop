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

export interface SetupState {
  apiKeySet: boolean;
  pythonInstalled: boolean;
}

interface ConfigData {
  setupState: SetupState;
  apiKeyEncrypted?: string;
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
    return this.data.setupState.apiKeySet && this.data.setupState.pythonInstalled;
  }

  setApiKeySet(v: boolean): void {
    this.data.setupState.apiKeySet = v;
    this.save();
  }

  setPythonInstalled(v: boolean): void {
    this.data.setupState.pythonInstalled = v;
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
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        // Ensure setupState exists
        if (!parsed.setupState) {
          parsed.setupState = { apiKeySet: false, pythonInstalled: false };
        }
        return parsed;
      }
    } catch (e) {
      console.warn('Failed to load config:', e);
    }
    return {
      setupState: { apiKeySet: false, pythonInstalled: false },
    };
  }

  private save(): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
  }
}
