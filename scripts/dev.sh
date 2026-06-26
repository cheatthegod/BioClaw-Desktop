#!/usr/bin/env bash
# scripts/dev.sh
# Convenience launcher for `npm run tauri:dev`.
# Installs node_modules on first run, then hands off to Tauri's dev server.

set -euo pipefail

# Resolve the project root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ ! -d node_modules ]; then
  echo "[dev.sh] node_modules missing — running 'npm install'..."
  npm install --no-audit --no-fund
fi

echo "[dev.sh] starting 'npm run tauri:dev' in $PROJECT_ROOT"
exec npm run tauri:dev
