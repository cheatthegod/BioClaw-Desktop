import { loadEnvFile } from './env.js';
import { getHomeDir } from './platform.js';
import path from 'path';
import { getRuntime } from './runtime-context.js';

loadEnvFile();

// ─── Static configuration (no path dependency) ──────────────────────────────

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Bioclaw';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const ENABLE_WHATSAPP = process.env.ENABLE_WHATSAPP === 'true';
export const ALLOW_WHATSAPP_SELF_MESSAGES =
  process.env.ALLOW_WHATSAPP_SELF_MESSAGES === 'true';
export let ENABLE_LOCAL_WEB = process.env.ENABLE_LOCAL_WEB === 'true';
export const LOCAL_WEB_GROUP_JID =
  process.env.LOCAL_WEB_GROUP_JID || 'local-web@local.web';
export const LOCAL_WEB_GROUP_NAME =
  process.env.LOCAL_WEB_GROUP_NAME || 'Local Web Chat';
export const LOCAL_WEB_GROUP_FOLDER =
  process.env.LOCAL_WEB_GROUP_FOLDER || 'local-web';
export const LOCAL_WEB_SECRET = process.env.LOCAL_WEB_SECRET || '';
export const QQ_APP_ID = process.env.QQ_APP_ID || '';
export const QQ_CLIENT_SECRET = process.env.QQ_CLIENT_SECRET || '';
export const QQ_SANDBOX = process.env.QQ_SANDBOX === 'true';
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
export const FEISHU_CONNECTION_MODE =
  (process.env.FEISHU_CONNECTION_MODE || 'websocket').toLowerCase();
export const FEISHU_VERIFICATION_TOKEN =
  process.env.FEISHU_VERIFICATION_TOKEN || '';
export const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || '';
export const FEISHU_HOST = process.env.FEISHU_HOST || '0.0.0.0';
export const FEISHU_PORT = parseInt(process.env.FEISHU_PORT || '8080', 10);
export const FEISHU_PATH = process.env.FEISHU_PATH || '/feishu/events';
export const ENABLE_WECHAT = process.env.ENABLE_WECHAT === 'true';

/** If set, require Authorization: Bearer <token> on trace API routes */
export const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

// ─── Path configuration — now reads from RuntimeContext ─────────────────────
//
// MIGRATION STRATEGY:
//   - These exports keep their original names for backward compatibility.
//   - They are `let` variables, initialized to '' at import time.
//   - `_freezeLegacyPaths()` must be called after `initRuntime()` to populate them.
//   - Eventually, consumers should migrate to getRuntime().groupsDir etc.
//   - LOCAL_WEB_HOST / LOCAL_WEB_PORT also read from RuntimeContext.
//

/** @deprecated Use getRuntime().groupsDir */
export let GROUPS_DIR = '';
/** @deprecated Use getRuntime().dataDir */
export let DATA_DIR = '';
/** @deprecated Use getRuntime().stateDir */
export let STORE_DIR = '';
/** @deprecated Use getRuntime().mountAllowlistPath */
export let MOUNT_ALLOWLIST_PATH = '';
/** @deprecated Use getRuntime().host */
export let LOCAL_WEB_HOST = process.env.LOCAL_WEB_HOST || 'localhost';
/** @deprecated Use getRuntime().port */
export let LOCAL_WEB_PORT = parseInt(process.env.LOCAL_WEB_PORT || '3000', 10);

export const MAIN_GROUP_FOLDER = 'main';

/**
 * Populate legacy path constants from the RuntimeContext singleton.
 * Must be called once, immediately after initRuntime().
 */
export function _freezeLegacyPaths(): void {
  const ctx = getRuntime();
  GROUPS_DIR = ctx.groupsDir;
  DATA_DIR = ctx.dataDir;
  STORE_DIR = ctx.stateDir;
  MOUNT_ALLOWLIST_PATH = ctx.mountAllowlistPath;
  LOCAL_WEB_HOST = ctx.host;
  LOCAL_WEB_PORT = ctx.port;
  // Desktop mode: always enable local web (it's the only UI)
  if (ctx.isDesktop) {
    ENABLE_LOCAL_WEB = true;
  }
}

// ─── Container configuration (server mode only) ─────────────────────────────

export const CONTAINER_RUNTIME: 'docker' | 'apptainer' | 'local' =
  (process.env.CONTAINER_RUNTIME || 'docker').toLowerCase() as
    | 'docker'
    | 'apptainer'
    | 'local';
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'bioclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// ─── Trigger / summary patterns ─────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

export const SUMMARY_PATTERN =
  /总结|汇总|概括|recap|summary|summarize|回顾/i;

export const SUMMARY_HISTORY_LIMIT = parseInt(
  process.env.SUMMARY_HISTORY_LIMIT || '200',
  10,
);

export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
