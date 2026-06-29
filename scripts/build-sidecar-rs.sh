#!/usr/bin/env bash
#
# Build the Rust sidecar (`sidecar-rs`) for a given target triple and place the
# binary where Tauri's externalBin expects it:
#   src-tauri/binaries/bioclaw-sidecar-<target-triple>[.exe]
#
# (tauri.conf.json lists `binaries/bioclaw-sidecar`; Tauri resolves it to
# `<name>-<target-triple>` per platform, with `.exe` on Windows.)
#
# Usage: scripts/build-sidecar-rs.sh <rust-target-triple>
set -euo pipefail

TARGET="${1:?usage: build-sidecar-rs.sh <rust-target-triple>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> cargo build --release --target $TARGET (sidecar-rs)"
( cd sidecar-rs && cargo build --release --target "$TARGET" )

EXE="bioclaw-sidecar"
SUFFIX=""
case "$TARGET" in
  *windows*) EXE="bioclaw-sidecar.exe"; SUFFIX=".exe" ;;
esac

SRC="sidecar-rs/target/$TARGET/release/$EXE"
if [ ! -f "$SRC" ]; then
  echo "ERROR: built binary not found at $SRC" >&2
  exit 1
fi

mkdir -p src-tauri/binaries
DST="src-tauri/binaries/bioclaw-sidecar-${TARGET}${SUFFIX}"
cp "$SRC" "$DST"
chmod +x "$DST" || true
echo "==> placed $DST ($(du -h "$DST" | cut -f1))"
