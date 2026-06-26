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
  // On windows there is no shebang support, so a `.exe`-named JS file
  // cannot be executed by the OS. We emit ONLY the `.js` bundle for the
  // windows-msvc triple; the real `bioclaw-sidecar-<triple>.exe` is built
  // by `sidecar/launcher-win/` (a tiny native Rust launcher) in CI and
  // dropped alongside this `.js` so Tauri's externalBin path resolves at
  // bundle-time.
  //
  // For local dev where Linux/macOS contributors don't have a Windows
  // toolchain, the missing `.exe` is fine: `tauri dev` only picks the
  // current-host triple's binary.
  const isWindows = triple.includes('windows');
  const suffix = isWindows ? '' : ''; // both branches drop the suffix here
  const outfile = isWindows
    ? null // launcher-win produces the .exe at build time in CI
    : resolve(OUT_DIR, `bioclaw-sidecar-${triple}${suffix}`);
  // Also emit a .js companion for the sourcemap reference and for direct
  // node invocation during dev / debugging. On windows this IS the only
  // artifact esbuild emits — the launcher.exe will exec `node` against it.
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
  // Unix: copy the JS companion to the Tauri-expected externalBin path
  // (`bioclaw-sidecar-<triple>` with no extension). Tauri-build refuses
  // to bundle if the file is missing at that exact path.
  if (outfile) {
    await copyFile(jsCompanion, outfile);
    // chmod 0755 so the unix file is directly executable. The shebang in
    // the banner makes the kernel exec `node`; without exec bit the spawn
    // fails with EACCES.
    try {
      await chmod(outfile, 0o755);
      await chmod(jsCompanion, 0o755);
    } catch {
      // Some filesystems (e.g. an NTFS mount on linux) don't accept chmod.
      // Document this in SIDECAR.md — best-effort.
    }
  } else {
    try {
      await chmod(jsCompanion, 0o755);
    } catch {
      /* best-effort */
    }
  }
  const reportPath = outfile ?? jsCompanion;
  const s = await stat(reportPath);
  return { triple, outfile: reportPath, bytes: s.size };
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
