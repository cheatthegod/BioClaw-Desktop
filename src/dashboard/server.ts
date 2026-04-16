import fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { URL } from 'url';

import { setAgentTraceListener, type AgentTraceRow } from '../agent-trace.js';
import {
  DASHBOARD_TOKEN,
  GROUPS_DIR,
} from '../config.js';
import { getAgentTraceEvents } from '../db/index.js';

const sseClients = new Set<ServerResponse>();

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function authOk(req: IncomingMessage, url: URL): boolean {
  if (!DASHBOARD_TOKEN) return true;
  const auth = req.headers.authorization;
  if (auth === `Bearer ${DASHBOARD_TOKEN}`) return true;
  if (url.searchParams.get('token') === DASHBOARD_TOKEN) return true;
  return false;
}

function broadcastTrace(row: AgentTraceRow): void {
  const line = `data: ${JSON.stringify(row)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(line);
    } catch {
      sseClients.delete(client);
    }
  }
}

function safeResolvedGroupDir(folder: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(folder)) return null;
  const base = path.resolve(GROUPS_DIR);
  const target = path.resolve(path.join(GROUPS_DIR, folder));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return null;
  return target;
}

interface TreeNode {
  name: string;
  relPath: string;
  type: 'dir' | 'file';
  children?: TreeNode[];
}

function readTree(
  absDir: string,
  relPrefix: string,
  depth: number,
  maxDepth: number,
  budget: { n: number },
  maxNodes: number,
): TreeNode[] {
  if (depth > maxDepth || budget.n >= maxNodes) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => {
    if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name);
    return a.isDirectory() ? -1 : 1;
  });
  const out: TreeNode[] = [];
  for (const ent of entries) {
    if (budget.n >= maxNodes) break;
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const relPath = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      budget.n += 1;
      const children = readTree(
        path.join(absDir, ent.name),
        relPath,
        depth + 1,
        maxDepth,
        budget,
        maxNodes,
      );
      out.push({ name: ent.name, relPath, type: 'dir', children });
    } else if (ent.isFile()) {
      budget.n += 1;
      out.push({ name: ent.name, relPath, type: 'file' });
    }
  }
  return out;
}

function listGroupFolders(): string[] {
  try {
    return fs
      .readdirSync(GROUPS_DIR)
      .filter((name) => {
        const p = path.join(GROUPS_DIR, name);
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}


/** Register SSE broadcast for trace rows (call from local web when merged, or from standalone server start). */
export function initDashboardTraceBroadcast(): void {
  setAgentTraceListener((row) => broadcastTrace(row));
}

/** Tear down trace listener and close all dashboard SSE clients. */
export function shutdownDashboardTraceBroadcast(): void {
  setAgentTraceListener(null);
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
}

/**
 * Handle trace/workspace API routes. Returns true if the request was handled.
 * Called from local-web channel's HTTP server.
 */
export async function handleDashboardRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _mode?: string,
): Promise<boolean> {
  const isDashboardPage =
    req.method === 'GET' &&
    (url.pathname === '/dashboard' || url.pathname === '/dashboard/');
  const isApi =
    url.pathname.startsWith('/api/trace/') || url.pathname.startsWith('/api/workspace/');

  if (!isDashboardPage && !isApi) return false;

  if (!authOk(req, url)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  if (isDashboardPage) {
    const tokenParam = url.searchParams.get('token');
    const dest =
      tokenParam !== null && tokenParam !== ''
        ? `/?tab=trace&token=${encodeURIComponent(tokenParam)}`
        : '/?tab=trace';
    res.statusCode = 302;
    res.setHeader('Location', dest);
    res.end();
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/trace/list') {
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);
    const group_folder = url.searchParams.get('group_folder') || undefined;
    const compact = url.searchParams.get('compact') === '1' || url.searchParams.get('compact') === 'true';
    const extraOmit = (url.searchParams.get('omit_types') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let omit_types: string[] | undefined;
    if (compact) {
      omit_types = [...new Set(['stream_output', ...extraOmit])];
    } else if (extraOmit.length > 0) {
      omit_types = extraOmit;
    }
    const events = getAgentTraceEvents({ group_folder, limit, omit_types });
    sendJson(res, 200, { events });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/trace/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': stream\n\n');
    sseClients.add(res);
    const hb = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(hb);
      }
    }, 25_000);
    res.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/workspace/groups') {
    sendJson(res, 200, { folders: listGroupFolders() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/workspace/tree') {
    const folder = url.searchParams.get('group_folder') || '';
    const dir = safeResolvedGroupDir(folder);
    if (!dir) {
      sendJson(res, 400, { error: 'Invalid group_folder' });
      return true;
    }
    const budget = { n: 0 };
    const tree = readTree(dir, '', 0, 5, budget, 400);
    sendJson(res, 200, { group_folder: folder, tree });
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}

