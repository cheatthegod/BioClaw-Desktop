#!/usr/bin/env node
/**
 * Open the Local Web UI in the default browser.
 * Uses .env when run via `npm run open:web` (cwd = project root).
 *
 * Override: LOCAL_WEB_URL=https://127.0.0.1:3000/ npm run open:web
 */
import 'dotenv/config';
import { execSync } from 'child_process';

const url =
  process.env.LOCAL_WEB_URL ||
  (() => {
    const host = process.env.LOCAL_WEB_HOST || 'localhost';
    const port = process.env.LOCAL_WEB_PORT || '3000';
    return `http://${host}:${port}/`;
  })();

const plat = process.platform;
let cmd;
if (plat === 'darwin') {
  cmd = `open "${url}"`;
} else if (plat === 'win32') {
  cmd = `start "" "${url}"`;
} else {
  cmd = `xdg-open "${url}"`;
}

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log(`Opened: ${url}`);
} catch (e) {
  console.error(`Could not open browser. Open manually: ${url}`);
  process.exit(1);
}
