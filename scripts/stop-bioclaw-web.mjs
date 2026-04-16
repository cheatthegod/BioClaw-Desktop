#!/usr/bin/env node
/**
 * Stop whatever is listening on LOCAL_WEB_PORT (default 3000).
 * Run from project root: npm run stop:web
 *
 * Note: if another app uses that port, it will receive SIGTERM too.
 * Set LOCAL_WEB_PORT in .env to match your BioClaw config.
 */
import 'dotenv/config';
import { execSync } from 'child_process';

const port = String(parseInt(process.env.LOCAL_WEB_PORT || '3000', 10));

let killed = 0;
try {
  const cmd =
    process.platform === 'darwin'
      ? `lsof -ti TCP:${port} -sTCP:LISTEN`
      : `lsof -ti :${port}`;
  const out = execSync(cmd, { encoding: 'utf8' });
  const pids = [...new Set(out.trim().split(/\s+/).filter(Boolean))];
  for (const pid of pids) {
    const n = parseInt(pid, 10);
    if (Number.isNaN(n) || n === process.pid) continue;
    try {
      process.kill(n, 'SIGTERM');
      console.log(`SIGTERM → PID ${n} (port ${port})`);
      killed += 1;
    } catch (e) {
      console.error(`Could not signal PID ${n}:`, e.message);
    }
  }
} catch {
  /* lsof: no listener */
}

if (killed === 0) {
  console.log(`No process listening on port ${port}.`);
}

// Also stop any running bioclaw containers so the next start uses a fresh image
try {
  const ids = execSync('docker ps -q --filter name=bioclaw', { encoding: 'utf8' }).trim();
  if (ids) {
    const count = ids.split(/\s+/).length;
    execSync(`docker stop ${ids.split(/\s+/).join(' ')}`, { timeout: 15000 });
    console.log(`Stopped ${count} bioclaw container(s).`);
  }
} catch {
  /* no containers or docker not available */
}
