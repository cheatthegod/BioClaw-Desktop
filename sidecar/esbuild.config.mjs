// esbuild driver for the sidecar.
//
// We DON'T build a true native binary — Bun --compile / pkg / nexe all add
// 40-90 MB per target. Instead we ship a single .js file and let Tauri invoke
// it via `node bioclaw-sidecar-<triple>.js`. The runtime Node is expected on
// PATH; on Windows we'll bundle a portable Node alongside the installer in
// phase 3 if user feedback shows missing-Node breakage. See docs/SIDECAR.md
// for the size/perf rationale.
//
// Output: one bundle per Tauri target triple. Tauri 2's externalBin convention
// is `<name>-<rustc-target-triple>` (no extension on unix, .exe on windows for
// real binaries). Since we ship .js files, we append .js to keep `node` happy
// and let the Rust supervisor invoke `node <path>`.

import { build } from 'esbuild';
import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname);
const OUT_DIR = resolve(ROOT, '../src-tauri/binaries');

// Tauri 2 external-bin naming uses rustc target triples. We emit one bundle
// per triple even though the JS is identical — Tauri appends the host triple
// at bundle time and refuses to find the binary if the file is missing.
//
// If you add a target, ALSO add it to tauri.conf.json's externalBin (Tauri
// reads the list and looks for each <name>-<triple>{.ext} variant on disk).
const TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
];

const ENTRY = resolve(ROOT, 'src/main.ts');

// Shebang first so we can chmod +x and Tauri's externalBin spawn just works
// on unix. Node ignores the shebang line; Windows ignores it too because the
// .cmd shim launches `node <file>` explicitly (see README and the post-build
// step that emits the .cmd companion for the windows-msvc triple).
//
// ESM-bundle banner: shim CommonJS `require()` for any vendored dep that
// reaches for it at top level. Some Node-only modules (mostly Hono's adapters)
// still emit `require('node:http')` style calls when bundled as ESM.
const BANNER = `#!/usr/bin/env node
import { createRequire as _crq } from 'module'; const require = _crq(import.meta.url); import { fileURLToPath as _fu } from 'url'; import { dirname as _dn } from 'path'; const __filename = _fu(import.meta.url); const __dirname = _dn(__filename);`;

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function buildOne(triple) {
  // Tauri 2 expects externalBin entries at exactly `<name>-<triple>` on unix
  // and `<name>-<triple>.exe` on windows — see
  // tauri-utils/src/resources.rs::external_binaries. We respect that naming.
  //
  // On unix the shebang (`#!/usr/bin/env node`) + chmod +x makes the file
  // directly executable; the kernel reads the shebang and execs node.
  //
  // On windows there is no shebang support. Phase-2 ships a `.exe`-named
  // file that is actually the JS bundle; this WILL FAIL on Windows when
  // Tauri tries to exec it. The phase-3 plan is to ship a tiny native
  // launcher.exe that calls `node bioclaw-sidecar.js` — until then the
  // Windows installer is documented as "requires Node on PATH and a future
  // launcher fix". The bundle file is still emitted so `tauri build`
  // doesn't fail bundling; runtime users on windows get a clear error.
  const isWindows = triple.includes('windows');
  const suffix = isWindows ? '.exe' : '';
  const outfile = resolve(OUT_DIR, `bioclaw-sidecar-${triple}${suffix}`);
  // Also emit a .js companion for the sourcemap reference and for direct
  // node invocation during dev / debugging.
  const jsCompanion = resolve(OUT_DIR, `bioclaw-sidecar-${triple}.js`);
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: jsCompanion,
    sourcemap: 'linked',
    minify: false, // keep stack traces readable; size win is small (<1MB)
    legalComments: 'none',
    banner: { js: BANNER },
    external: [],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'info',
  });
  // Copy the JS companion to the Tauri-expected externalBin path. On unix
  // this is `bioclaw-sidecar-<triple>` (no extension); on windows it's
  // `bioclaw-sidecar-<triple>.exe`. Tauri-build refuses to bundle if the
  // file is missing at exactly that path.
  await copyFile(jsCompanion, outfile);
  // chmod 0755 so the unix file is directly executable. The shebang in the
  // banner makes the kernel exec `node`; without exec bit the spawn fails
  // with EACCES.
  try {
    await chmod(outfile, 0o755);
    await chmod(jsCompanion, 0o755);
  } catch {
    // Some filesystems (e.g. an NTFS mount on linux) don't accept chmod.
    // Document this in SIDECAR.md — best-effort.
  }
  const s = await stat(outfile);
  return { triple, outfile, bytes: s.size };
}

async function main() {
  await ensureDir(OUT_DIR);
  const results = [];
  for (const t of TARGETS) {
    // eslint-disable-next-line no-await-in-loop -- esbuild is already parallel internally
    results.push(await buildOne(t));
  }
  for (const r of results) {
    const mb = (r.bytes / (1024 * 1024)).toFixed(2);
    process.stdout.write(`built ${r.triple}: ${r.outfile} (${mb} MB)\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`esbuild driver failed: ${err.stack || err}\n`);
  process.exit(1);
});
