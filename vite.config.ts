import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Tauri 2 dev-server contract — the dev server runs on a fixed port so the
// Rust side knows where to point its WebView. See src-tauri/tauri.conf.json
// `build.devUrl`. Vite ignores `host` env when 1420 isn't free; pin it.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  // Tauri expects a fixed port, fail if that's not available
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // Tell Vite to ignore watching `src-tauri` — Rust changes are picked up
      // by the Tauri CLI, not Vite, and the target/ dir thrashes the watcher.
      ignored: ['**/src-tauri/**'],
    },
  },
  // Bundle the front-end for the WebView. Tauri reads `dist/` per the
  // `build.frontendDist` field in tauri.conf.json.
  build: {
    target: ['es2022', 'safari16'],
    minify: process.env.TAURI_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: 'dist',
    emptyOutDir: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
}));
