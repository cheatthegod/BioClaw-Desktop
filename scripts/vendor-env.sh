#!/usr/bin/env bash
# vendor-env.sh — materialise a Python interpreter + wheel cache for the
# current rustc target triple, package it as a zip, and stage it at
# `src-tauri/binaries/bioclaw-env-<triple>.zip` so the Tauri bundler ships
# it as an externalBin asset.
#
# Why a zip (not a populated .venv directly): the venv would carry
# absolute paths from this build host (pyvenv.cfg, .dist-info RECORD,
# possibly RPATHs). We ship the *inputs* uv needs to rebuild the venv
# without network access:
#   * `_base/`      — uv-installed CPython, pristine
#   * `_uv-cache/`  — uv's cache containing every pinned wheel
#   * `pyproject.toml`, `uv.lock`, `.python-version`, `README.md`
#
# On first launch the sidecar extracts this zip to `~/.bioclaw/env/` and
# runs `uv sync --frozen --offline` against the cached wheels — uv
# rewrites pyvenv.cfg with the user's path, links .venv against the
# bundled `_base/` Python, and the result is a fully-functional sandbox.
# That step takes ~30-60s and runs zero network calls. Matches OmicOS's
# "downloading + installing packages with uv (first run is the slow one)"
# pattern.
#
# Env knobs:
#   UV_PYTHON_VERSION   default = "3.11"
#   BIOCLAW_ENV_TARGET  default = host's rustc triple (vendor-uv.sh
#                       convention). Set this in CI per matrix entry.
#   BIOCLAW_ENV_EXTRAS  comma-separated, default = "" (base only).
#                       Set to e.g. "scientific,phylo" to pre-bake those
#                       extras into the bundled cache.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_DIR="$DESKTOP_ROOT/bioclaw-env"
DEST_DIR="$DESKTOP_ROOT/src-tauri/binaries"

UV_PYTHON_VERSION="${UV_PYTHON_VERSION:-3.11}"

# Detect target triple — same default behaviour as vendor-uv.sh.
if [[ -n "${BIOCLAW_ENV_TARGET:-}" ]]; then
  TARGET="$BIOCLAW_ENV_TARGET"
else
  if command -v rustc >/dev/null 2>&1; then
    TARGET="$(rustc -vV | awk -F': ' '/host:/ {print $2}')"
  else
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64)   TARGET="x86_64-unknown-linux-gnu" ;;
      Linux-aarch64)  TARGET="aarch64-unknown-linux-gnu" ;;
      Darwin-x86_64)  TARGET="x86_64-apple-darwin" ;;
      Darwin-arm64)   TARGET="aarch64-apple-darwin" ;;
      *)
        echo "vendor-env.sh: cannot infer target triple; set BIOCLAW_ENV_TARGET" >&2
        exit 1
        ;;
    esac
  fi
fi

if ! command -v uv >/dev/null 2>&1; then
  # If we already vendored uv into src-tauri/binaries/uv-<target>(.exe),
  # use that — saves a global install on CI runners.
  for cand in "$DEST_DIR/uv-$TARGET" "$DEST_DIR/uv-$TARGET.exe"; do
    if [[ -x "$cand" ]]; then UV_BIN="$cand"; break; fi
  done
  if [[ -z "${UV_BIN:-}" ]]; then
    echo "vendor-env.sh: no uv on PATH and no vendored uv at $DEST_DIR/uv-$TARGET" >&2
    echo "  hint: run scripts/vendor-uv.sh first" >&2
    exit 1
  fi
else
  UV_BIN="$(command -v uv)"
fi

echo "vendor-env.sh: target=$TARGET  uv=$UV_BIN  python=$UV_PYTHON_VERSION"

mkdir -p "$DEST_DIR"
cd "$ENV_DIR"

# Wipe any prior _base / _uv-cache from a previous run so the zip is
# deterministic. Keep the source files (pyproject / lock / etc).
rm -rf _base _uv-cache .venv

# --------------------------------------------------------------------
# 1. Install Python into _base/ (not the user's uv default location).
#    `--install-dir` makes uv put cpython-<ver>-<target>/ as a subdir.
# --------------------------------------------------------------------
echo
echo "==> uv python install $UV_PYTHON_VERSION --install-dir _base"
UV_PYTHON_INSTALL_DIR="$ENV_DIR/_base" "$UV_BIN" python install "$UV_PYTHON_VERSION"

# Resolve the installed Python's bin path. uv's standalone layout:
#   _base/cpython-3.11.<patch>-<target>/{bin/python3.11, ...}  (POSIX)
#   _base/cpython-3.11.<patch>-<target>/python.exe              (Windows)
PYTHON_DIR_GLOB=("$ENV_DIR/_base"/cpython-${UV_PYTHON_VERSION}*)
if [[ ${#PYTHON_DIR_GLOB[@]} -eq 0 || ! -d "${PYTHON_DIR_GLOB[0]}" ]]; then
  echo "vendor-env.sh: could not locate uv-installed Python under _base/" >&2
  ls -la "$ENV_DIR/_base" >&2
  exit 1
fi
PYTHON_DIR="${PYTHON_DIR_GLOB[0]}"
if [[ -x "$PYTHON_DIR/bin/python3" ]]; then
  PYTHON_BIN="$PYTHON_DIR/bin/python3"
elif [[ -x "$PYTHON_DIR/python.exe" ]]; then
  PYTHON_BIN="$PYTHON_DIR/python.exe"
else
  PYTHON_BIN="$(find "$PYTHON_DIR" -maxdepth 2 -type f -name 'python*' -executable | head -1)"
fi
echo "    bundled python = $PYTHON_BIN"

# --------------------------------------------------------------------
# 2. Sync the venv with UV_CACHE_DIR pointed at _uv-cache so every wheel
#    gets pulled into our zip. Extras are baked in optionally.
# --------------------------------------------------------------------
EXTRA_ARGS=()
if [[ -n "${BIOCLAW_ENV_EXTRAS:-}" ]]; then
  IFS=',' read -ra EXTRAS_LIST <<< "$BIOCLAW_ENV_EXTRAS"
  for e in "${EXTRAS_LIST[@]}"; do
    e_trimmed="$(echo "$e" | xargs)"
    [[ -z "$e_trimmed" ]] && continue
    EXTRA_ARGS+=(--extra "$e_trimmed")
  done
  echo
  echo "==> uv sync --frozen --python $PYTHON_BIN ${EXTRA_ARGS[*]}"
else
  echo
  echo "==> uv sync --frozen --python $PYTHON_BIN  (base only)"
fi
UV_CACHE_DIR="$ENV_DIR/_uv-cache" "$UV_BIN" sync --frozen --python "$PYTHON_BIN" "${EXTRA_ARGS[@]}"

# --------------------------------------------------------------------
# 3. Throw away .venv — it has absolute paths from this build host.
#    The user-side first-launch will rebuild it from _uv-cache offline.
#    Don't prune the cache: `uv cache prune --ci` is too aggressive
#    (drops the wheels themselves), and offline sync needs them.
# --------------------------------------------------------------------
rm -rf "$ENV_DIR/.venv"

# --------------------------------------------------------------------
# 5. Report sizes before zipping so CI logs surface them.
# --------------------------------------------------------------------
echo
echo "==> sizes (before zip)"
du -sh "$ENV_DIR/_base" "$ENV_DIR/_uv-cache" 2>/dev/null || true

# --------------------------------------------------------------------
# 6. Zip up everything the user-side needs.
# --------------------------------------------------------------------
OUT="$DEST_DIR/bioclaw-env-$TARGET.zip"
# Tauri bundle.resources doesn't natively support per-rustc-triple file
# variants, so we ALSO write a triple-less alias `bioclaw-env.zip` that
# tauri.conf.json references. CI runs this script per matrix entry, so
# the alias always contains the current platform's bundle.
ALIAS="$DEST_DIR/bioclaw-env.zip"
echo
echo "==> packaging zip"
rm -f "$OUT" "$ALIAS"
( cd "$ENV_DIR" \
  && zip -qr "$OUT" \
        _base \
        _uv-cache \
        pyproject.toml \
        uv.lock \
        .python-version \
        README.md \
)
cp "$OUT" "$ALIAS"

echo
echo "vendor-env.sh: wrote $OUT ($(du -h "$OUT" | awk '{print $1}'))"
echo "vendor-env.sh: aliased to $ALIAS"
