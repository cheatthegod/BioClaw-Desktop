# Windows sidecar launcher

The BioClaw sidecar is bundled by esbuild into a single Node.js script
(`bioclaw-sidecar-x86_64-pc-windows-msvc.js`). On macOS/Linux a shebang
`#!/usr/bin/env node` is enough — the kernel will exec node for us. On
Windows there's no shebang, so we ship this tiny launcher.exe to bridge
the gap.

This is a pure Cargo project (no deps) intended to be built **on
Windows** during the release CI job. We don't cross-compile from
Linux/macOS in the normal dev loop — the dev loop targets Linux/macOS,
where the JS bundle runs directly.

## Build (in CI)

```
cd sidecar/launcher-win
cargo build --release --target x86_64-pc-windows-msvc
copy target\x86_64-pc-windows-msvc\release\bioclaw-sidecar-launcher.exe ^
     ..\..\src-tauri\binaries\bioclaw-sidecar-x86_64-pc-windows-msvc.exe
```

The CI workflow (`.github/workflows/release.yml`) wraps this. The
resulting binary is roughly 150 KB stripped and looks for `node.exe`
on PATH or in well-known install locations.

## Behaviour at runtime

1. Locate `node.exe` (PATH first; then `C:\Program Files\nodejs\node.exe`
   and a few NVM / Scoop / per-user fallbacks).
2. Resolve the JS bundle path (same directory as the launcher, `.exe` →
   `.js`).
3. Spawn `node.exe <bundle.js>` with inherited stdio so Tauri's port-
   discovery (the `PORT=NNNN` line on stdout) and the stdin-EOF
   shutdown signal work transparently.
4. Wait for the child, propagate exit code.

If `node.exe` is missing, the launcher prints a clear error to stderr
pointing the user at nodejs.org. We could later embed a portable
node distribution to avoid this dependency entirely — that's tracked
under phase 3.
