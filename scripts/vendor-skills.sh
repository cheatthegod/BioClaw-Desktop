#!/usr/bin/env bash
# vendor-skills.sh — copy the phase-3 offline-safe SKILL.md subset from the
# BioClaw-SaaS skill catalog into BioClaw-Desktop-v2/skills/.
#
# Why this script exists:
#   * The Tauri bundler ships `bundle.resources` paths into the installed
#     app's `resource_dir()`. We point the resources entry at
#     ../skills/ (relative to src-tauri/) which means we need a copy in
#     the desktop repo, not a symlink.
#   * The full SaaS skill catalog is ~189 directories / many MB. The
#     phase-3 desktop bundle MUST stay small and we explicitly exclude
#     skills that require an NVIDIA NGC API key, a local GPU, or a hosted
#     NIM endpoint. The hard-coded list below is the 6 truly offline skills.
#   * `tauri:build` invokes this so the resource path always points at a
#     fresh copy. Re-running is idempotent — we rm -rf the destination
#     dirs before copying.
#
# Add a skill here when:
#   * It's published in BioClaw-SaaS/container/skills/<dir>/SKILL.md
#   * It does NOT mention NVIDIA_API_KEY / NGC_API_KEY in its body
#   * It does NOT require a GPU at runtime
#   * It's actually useful for the desktop user persona (offline biomed
#     research, single-machine workflows)
#
# Run from anywhere. Resolves paths from $BASH_SOURCE so the script can be
# invoked via npm scripts or directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$DESKTOP_ROOT/skills"

# Where the SaaS skills live. Override with $BIOCLAW_SAAS_SKILLS_SRC for CI
# or a different checkout layout.
DEFAULT_SRC="/home/ubuntu/Bioclaw_dev/BioClaw-SaaS/container/skills"
SRC_DIR="${BIOCLAW_SAAS_SKILLS_SRC:-$DEFAULT_SRC}"

# Phase-3 vendored subset. Six skills, all offline + no API key.
# Order matters only for log readability. To add a skill, append here and
# document the choice in docs/SKILLS.md.
SKILLS=(
  bionemo-nvmolkit
  bionemo-cuequivariance
  bionemo-science-skills-uniprot-database
  bionemo-science-skills-alphafold-database-fetch-and-analyze
  bionemo-complexa-target
  bionemo-complexa-sweep
)

if [[ ! -d "$SRC_DIR" ]]; then
  echo "vendor-skills.sh: source skill catalog not found at $SRC_DIR" >&2
  echo "  set BIOCLAW_SAAS_SKILLS_SRC to override." >&2
  # In a clean release build the source may not exist (the SaaS repo isn't
  # cloned). We exit 0 rather than fail the desktop build, since the prior
  # vendored copy in skills/ may already be fine.
  if [[ -d "$DEST_DIR" ]]; then
    echo "  destination $DEST_DIR exists; assuming a previous vendor pass." >&2
    exit 0
  fi
  echo "  destination $DEST_DIR missing too — the sidecar will report 0 skills." >&2
  mkdir -p "$DEST_DIR"
  exit 0
fi

mkdir -p "$DEST_DIR"

copied=0
skipped=0
for skill in "${SKILLS[@]}"; do
  src="$SRC_DIR/$skill"
  dst="$DEST_DIR/$skill"
  if [[ ! -d "$src" ]]; then
    echo "vendor-skills.sh: WARN $skill not found at $src (skipping)" >&2
    skipped=$((skipped + 1))
    continue
  fi
  rm -rf "$dst"
  # We copy the entire skill directory so any companion reference files
  # (references/api.md etc.) come along. Skills that mention NGC_API_KEY
  # internally are excluded by the curated list above — we do NOT scan.
  cp -RL "$src" "$dst"
  copied=$((copied + 1))
  echo "vendor-skills.sh: copied $skill"
done

# Final size report so a future bundle-size regression is obvious in CI logs.
if command -v du >/dev/null 2>&1; then
  size="$(du -sh "$DEST_DIR" 2>/dev/null | awk '{print $1}')"
  echo "vendor-skills.sh: vendored $copied skill(s) ($skipped skipped) into $DEST_DIR ($size)"
else
  echo "vendor-skills.sh: vendored $copied skill(s) ($skipped skipped) into $DEST_DIR"
fi
