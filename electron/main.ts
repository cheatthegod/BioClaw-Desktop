/**
 * BioClaw Desktop — Electron Main Process
 *
 * Lifecycle:
 *   1. Check if fully configured (API key + Python installed)
 *   2. If not → show setup wizard
 *   3. If yes → start BioClaw server + open main window
 *
 * The BioClaw server is the same HTTP server used in `npm run web`,
 * but initialized via RuntimeContext.forDesktop() so it uses local-runner
 * instead of Docker containers.
 */

import { app, BrowserWindow, ipcMain, Tray, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import net from 'net';

import { ConfigStore } from './config-store.js';
import { PythonManager } from './python-manager.js';

// ── Globals ──

let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverUrl = '';
let config: ConfigStore;
let pythonManager: PythonManager;

// In-memory API key for sessions where safeStorage is unavailable
let sessionApiKey = '';

// ── App lifecycle ──

app.setName('BioClaw');

app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  fs.mkdirSync(userDataDir, { recursive: true });

  config = new ConfigStore(userDataDir);
  pythonManager = new PythonManager(userDataDir);

  // Reconcile state: if Python was installed but dir was deleted, reset
  if (config.getSetupState().pythonInstalled && !pythonManager.isInstalled()) {
    config.setPythonInstalled(false);
  }

  if (config.isFullyConfigured() && config.hasApiKey()) {
    await startApp();
  } else {
    showSetupWizard();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow && !setupWindow) {
    if (config.isFullyConfigured()) {
      startApp();
    } else {
      showSetupWizard();
    }
  }
});

// ── Setup Wizard ──

function showSetupWizard() {
  const state = config.getSetupState();
  const startStep = !state.apiKeySet ? 1 : !state.pythonInstalled ? 2 : 1;

  setupWindow = new BrowserWindow({
    width: 620,
    height: 560,
    resizable: false,
    maximizable: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // In dev: __dirname = electron-dist/electron/, HTML at electron/setup-wizard.html
  // In production: app.getAppPath() points to the asar, HTML is in electron/
  const htmlPath = app.isPackaged
    ? path.join(app.getAppPath(), 'electron', 'setup-wizard.html')
    : path.join(__dirname, '..', '..', 'electron', 'setup-wizard.html');
  setupWindow.loadFile(htmlPath);

  // Pass initial step to renderer once ready
  setupWindow.webContents.on('did-finish-load', () => {
    setupWindow?.webContents.send('setup:init', { startStep });
  });

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

// ── IPC Handlers: Setup Wizard ──

ipcMain.handle('setup:validate-api-key', async (_event, apiKey: string) => {
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    return { valid: false, error: 'API Key should start with sk-ant-' };
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // 200 = valid, 400 = valid key but bad request (still proves key works)
    const valid = response.ok || response.status === 400;
    return { valid, error: valid ? null : `API returned ${response.status}` };
  } catch (e: any) {
    return { valid: false, error: `Network error: ${e.message}` };
  }
});

ipcMain.handle('setup:save-api-key', async (_event, apiKey: string) => {
  const stored = config.setApiKey(apiKey);
  if (!stored) {
    // safeStorage unavailable — keep in memory for this session only
    sessionApiKey = apiKey;
    config.setApiKeySet(true); // Mark as set (even though not persisted)
  }
  return { stored };
});

ipcMain.handle('setup:check-python', async () => {
  return { installed: pythonManager.isInstalled() };
});

ipcMain.handle('setup:install-python', async () => {
  try {
    await pythonManager.install((progress) => {
      setupWindow?.webContents.send('setup:progress', progress);
    });
    config.setPythonInstalled(true);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('setup:finish', async () => {
  if (setupWindow) {
    setupWindow.close();
  }
  await startApp();
});

// ── Main App ──

async function startApp() {
  const userDataDir = app.getPath('userData');

  // Resolve API key: prefer stored, fall back to session memory
  const apiKey = config.getApiKey() || sessionApiKey;
  if (!apiKey) {
    showSetupWizard();
    return;
  }

  // Find available port
  const port = await findAvailablePort(19820);

  // ── Set env vars BEFORE importing any src/ modules ──
  // These must be set before config.ts is imported, because some
  // values are frozen at import time.
  process.env.ENABLE_LOCAL_WEB = 'true';
  process.env.LOCAL_WEB_PORT = String(port);
  process.env.LOCAL_WEB_HOST = '127.0.0.1';
  process.env.BIOCLAW_DESKTOP = '1';

  // ── Now import and initialize ──
  const { RuntimeContext, initRuntime } = await import('../src/runtime-context.js');
  const { _freezeLegacyPaths } = await import('../src/config.js');

  const resourcesDir = process.resourcesPath || path.join(__dirname, '..');

  // Build RuntimeContext with ALL required fields
  const ctx = new RuntimeContext({
    mode: 'desktop',
    groupsDir: path.join(userDataDir, 'workspaces'),
    dataDir: path.join(userDataDir, 'data'),
    stateDir: path.join(userDataDir, 'store'),
    skillsDir: path.join(resourcesDir, 'skills'),
    webAssetsDir: path.join(resourcesDir, 'web-assets'),
    logoPath: path.join(resourcesDir, 'web-assets', 'bioclaw_logo.jpg'),
    vendorScriptsDir: path.join(resourcesDir, 'web-assets', 'vendor'),
    agentRunnerPath: path.join(resourcesDir, 'agent-runner', 'dist', 'index.js'),
    pythonPath: pythonManager.getPythonPath(),  // ← Fix #3: use installed Python
    apiKey,
    port,
    host: '127.0.0.1',
  });

  try {
    initRuntime(ctx);
  } catch {
    // Already initialized (e.g. after wizard re-entry) — skip
  }
  _freezeLegacyPaths();  // This also sets ENABLE_LOCAL_WEB=true for desktop

  // Ensure directories exist
  for (const dir of [ctx.groupsDir, ctx.dataDir, ctx.stateDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── Start the BioClaw HTTP server ── Fix #1
  const { startBioClawServer } = await import('../src/index.js');
  await startBioClawServer();

  serverUrl = `http://127.0.0.1:${port}`;

  // Create tray
  createTray();

  // Create main window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: getIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(serverUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── System Tray ──

function createTray() {
  try {
    const iconPath = getIconPath();
    if (!fs.existsSync(iconPath)) return;
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open BioClaw',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray.setContextMenu(contextMenu);
    tray.setToolTip('BioClaw');
    tray.on('click', () => mainWindow?.show());
  } catch {
    // Tray is non-critical
  }
}

// ── Helpers ──

function getIconPath(): string {
  const resourcesDir = process.resourcesPath || path.join(__dirname, '..');
  const candidates = [
    path.join(resourcesDir, 'assets', 'icon.png'),
    path.join(__dirname, '..', 'assets', 'icon.png'),
    path.join(__dirname, '..', 'bioclaw_logo.jpg'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // fallback even if not exists
}

function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : startPort;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
}
