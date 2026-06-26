#!/usr/bin/env bash
# vendor-skills.sh — copy the BioNeMo skill catalog from BioClaw-SaaS into
# BioClaw-Desktop-v2/skills/, ready to be picked up by Tauri's
# `bundle.resources`.
#
# Why this script exists:
#   * The Tauri bundler ships `bundle.resources` paths into the installed
#     app's `resource_dir()`. We point the resources entry at ../skills/
#     (relative to src-tauri/) so we need a real directory there — not a
#     symlink.
#   * The SaaS-side bionemo-* dirs are themselves symlinks (files2 storage).
#     We use `cp -RL` to follow those symlinks and end up with real files
#     on disk so `dpkg-deb -c` packages the actual content.
#
# Phase 4 mode: auto-discover ALL bionemo-* directories under
# $BIOCLAW_SAAS_SKILLS_SRC (or default SaaS path) and copy each. The
# sidecar's skill registry tags each one with requiresApiKey /
# requiresGpu based on SKILL.md content, so the front-end can render
# them differently. We no longer hard-code a subset — the LLM gets to
# see every skill, and the user picks which ones to actually run via the
# permission UI.
#
# Override knobs (env vars):
#   BIOCLAW_SAAS_SKILLS_SRC   — source dir; defaults to the SaaS checkout
#   BIOCLAW_SKILLS_INCLUDE    — comma-separated regex list; if set, only
#                                matching directory names are vendored
#   BIOCLAW_SKILLS_EXCLUDE    — comma-separated regex list; if set,
#                                matching directory names are skipped
#
# Re-running is idempotent — we rm -rf each destination dir before copying.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$DESKTOP_ROOT/skills"

DEFAULT_SRC="/home/ubuntu/Bioclaw_dev/BioClaw-SaaS/container/skills"
SRC_DIR="${BIOCLAW_SAAS_SKILLS_SRC:-$DEFAULT_SRC}"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "vendor-skills.sh: source skill catalog not found at $SRC_DIR" >&2
  echo "  set BIOCLAW_SAAS_SKILLS_SRC to override." >&2
  if [[ -d "$DEST_DIR" ]]; then
    echo "  destination $DEST_DIR exists; assuming a previous vendor pass." >&2
    exit 0
  fi
  mkdir -p "$DEST_DIR"
  exit 0
fi

mkdir -p "$DEST_DIR"

# Auto-discover every bionemo-* under SRC_DIR. Resolves symlinks. Sort for
# deterministic CI output.
mapfile -t discovered < <(
  find "$SRC_DIR" -maxdepth 1 \( -type d -o -type l \) -name 'bionemo-*' \
    -printf '%f\n' | sort
)

if [[ ${#discovered[@]} -eq 0 ]]; then
  echo "vendor-skills.sh: no bionemo-* skill directories found under $SRC_DIR" >&2
  exit 1
fi

# Apply optional include/exclude regex filters.
matches_any() {
  local name="$1"; shift
  local filters="$1"
  [[ -z "$filters" ]] && return 1
  IFS=',' read -ra patterns <<< "$filters"
  for pattern in "${patterns[@]}"; do
    [[ "$name" =~ $pattern ]] && return 0
  done
  return 1
}

ids=()
for name in "${discovered[@]}"; do
  if [[ -n "${BIOCLAW_SKILLS_INCLUDE:-}" ]]; then
    matches_any "$name" "$BIOCLAW_SKILLS_INCLUDE" || continue
  fi
  if [[ -n "${BIOCLAW_SKILLS_EXCLUDE:-}" ]]; then
    matches_any "$name" "$BIOCLAW_SKILLS_EXCLUDE" && continue
  fi
  ids+=("$name")
done

# Wipe the destination so deletions / renames on the SaaS side propagate.
# We do this AFTER discovery so a missing source dir aborts before we wipe.
find "$DEST_DIR" -mindepth 1 -maxdepth 1 -type d -name 'bionemo-*' -exec rm -rf {} +

copied=0
skipped_no_skill_md=0

for id in "${ids[@]}"; do
  src="$SRC_DIR/$id"
  dst="$DEST_DIR/$id"

  if [[ ! -e "$src/SKILL.md" ]]; then
    # Some directories under bionemo-* are wrapper / index dirs without a
    # SKILL.md. Skip silently — the loader on the sidecar side does the
    # same.
    skipped_no_skill_md=$((skipped_no_skill_md + 1))
    continue
  fi

  # -R recursive, -L follow symlinks (the SaaS-side bionemo-* are symlinks
  # to canonical files2 storage; we need real content for `dpkg-deb -c` to
  # actually package something).
  cp -RL "$src" "$dst"
  copied=$((copied + 1))
done

if command -v du >/dev/null 2>&1; then
  size="$(du -sh "$DEST_DIR" 2>/dev/null | awk '{print $1}')"
  echo "vendor-skills.sh: vendored $copied skill(s) (skipped $skipped_no_skill_md without SKILL.md) into $DEST_DIR ($size)"
else
  echo "vendor-skills.sh: vendored $copied skill(s) (skipped $skipped_no_skill_md without SKILL.md) into $DEST_DIR"
fi
