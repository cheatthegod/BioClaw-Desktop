#!/usr/bin/env bash
# vendor-uv.sh — fetch Astral's pre-built uv binaries and stage them as
# Tauri externalBin assets at src-tauri/binaries/uv-<triple>(.exe).
#
# tauri-bundler's externalBin contract: declare `binaries/uv` in
# tauri.conf.json and the bundler looks for binaries/uv-<rustc-triple>
# (.exe on Windows) at build time. We download the official tarball /
# zip from github.com/astral-sh/uv/releases, extract the `uv` binary,
# and rename it to match. Run once per release bump.
#
# Re-runs are idempotent — the script overwrites existing binaries
# rather than skipping. CI calls it before `tauri build`.
#
# Env knobs:
#   UV_VERSION              pin a specific uv release (default = "latest")
#   BIOCLAW_UV_TARGETS      space-separated rustc triples (default = all
#                           four desktop targets we ship)
#
# Why uv rather than pip / conda: deterministic resolution, single
# static binary, ships pre-built wheels for every platform, no Python
# bootstrap mess. OmicOS made the same call (see omicos-env analysis).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$DESKTOP_ROOT/src-tauri/binaries"

UV_VERSION="${UV_VERSION:-latest}"

# Defaults to the four targets we ship. Build CI overrides by setting
# BIOCLAW_UV_TARGETS to just the current platform's triple.
DEFAULT_TARGETS=(
  "x86_64-unknown-linux-gnu"
  "aarch64-unknown-linux-gnu"
  "x86_64-apple-darwin"
  "aarch64-apple-darwin"
  "x86_64-pc-windows-msvc"
)
if [[ -n "${BIOCLAW_UV_TARGETS:-}" ]]; then
  IFS=' ' read -ra TARGETS <<< "$BIOCLAW_UV_TARGETS"
else
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

# Resolve "latest" once so all targets bind to the same version
# (otherwise a release cut between two downloads gets mixed binaries).
if [[ "$UV_VERSION" == "latest" ]]; then
  echo "vendor-uv.sh: querying github for latest uv release"
  if ! UV_VERSION="$(
    curl -fsSL https://api.github.com/repos/astral-sh/uv/releases/latest \
      | grep -E '"tag_name":' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
  )"; then
    echo "vendor-uv.sh: failed to resolve latest uv version" >&2
    exit 1
  fi
fi
echo "vendor-uv.sh: pinning uv to ${UV_VERSION}"

mkdir -p "$DEST_DIR"

for triple in "${TARGETS[@]}"; do
  case "$triple" in
    *-pc-windows-*)
      asset="uv-${triple}.zip"
      ext=".exe"
      ;;
    *)
      asset="uv-${triple}.tar.gz"
      ext=""
      ;;
  esac
  url="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}"
  out="$DEST_DIR/uv-${triple}${ext}"

  tmpdir="$(mktemp -d -t bioclaw-uv-XXXXXX)"
  trap 'rm -rf "$tmpdir"' EXIT

  echo "vendor-uv.sh: ${triple} <- ${url}"
  if ! curl -fsSL "$url" -o "$tmpdir/asset"; then
    echo "vendor-uv.sh: download failed for ${triple}; skipping" >&2
    continue
  fi

  if [[ "$asset" == *.zip ]]; then
    (cd "$tmpdir" && unzip -q asset)
  else
    (cd "$tmpdir" && tar -xzf asset)
  fi

  # Astral packs the tar/zip with a top-level directory named
  # `uv-<triple>` containing `uv` (+ `uvx`). Locate the binary
  # without assuming layout — find one matching name regardless of
  # depth. On Windows it's `uv.exe`.
  if [[ "$ext" == ".exe" ]]; then
    src="$(find "$tmpdir" -maxdepth 3 -type f -name 'uv.exe' | head -1)"
  else
    src="$(find "$tmpdir" -maxdepth 3 -type f -name 'uv' | head -1)"
  fi
  if [[ -z "$src" ]]; then
    echo "vendor-uv.sh: could not locate uv binary inside ${asset}" >&2
    rm -rf "$tmpdir"
    continue
  fi
  cp "$src" "$out"
  chmod +x "$out"

  size="$(du -h "$out" | awk '{print $1}')"
  echo "vendor-uv.sh:   ok  ${out} (${size})"
  rm -rf "$tmpdir"
  trap - EXIT
done

echo
echo "vendor-uv.sh: vendored uv ${UV_VERSION} into ${DEST_DIR}"
ls -lh "$DEST_DIR"/uv-* 2>/dev/null || true
