#!/usr/bin/env bash
# scripts/check-prereqs.sh
# Verify the host has everything needed to build BioClaw Desktop (Tauri 2).
# Exits non-zero with a clear remediation hint when something is missing.

set -u
set -o pipefail

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

missing=0
apt_packages=()

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s[ok]%s %s\n' "$GREEN" "$RESET" "$*"; }
bad()  { printf '  %s[missing]%s %s\n' "$RED" "$RESET" "$*"; missing=$((missing + 1)); }
warn() { printf '  %s[warn]%s %s\n' "$YELLOW" "$RESET" "$*"; }

say "${BOLD}BioClaw Desktop — prerequisite check${RESET}"

# ---------- Node >= 20 ----------
say ""
say "${BOLD}Node.js >= 20${RESET}"
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>/dev/null | sed 's/^v//')"
  node_major="${node_version%%.*}"
  if [ -n "$node_major" ] && [ "$node_major" -ge 20 ] 2>/dev/null; then
    ok "node v$node_version"
  else
    bad "node v$node_version (need >= 20). Install via https://nodejs.org or nvm."
  fi
else
  bad "node not found in PATH. Install Node.js >= 20 (https://nodejs.org or nvm)."
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm --version 2>/dev/null)"
else
  bad "npm not found in PATH."
fi

# ---------- Rust toolchain ----------
say ""
say "${BOLD}Rust toolchain${RESET}"
if command -v rustc >/dev/null 2>&1; then
  ok "rustc $(rustc --version 2>/dev/null | awk '{print $2}')"
else
  bad "rustc not found. Install via: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi
if command -v cargo >/dev/null 2>&1; then
  ok "cargo $(cargo --version 2>/dev/null | awk '{print $2}')"
else
  bad "cargo not found. Install rustup (see rustc line above)."
fi

# ---------- Linux system libs ----------
uname_s="$(uname -s 2>/dev/null || echo unknown)"
if [ "$uname_s" = "Linux" ]; then
  say ""
  say "${BOLD}Linux system libraries (Tauri 2 / WebKitGTK)${RESET}"

  check_pkg_or_lib() {
    # $1 = apt package name, $2 = pkg-config name (optional), $3 = ldconfig substring (optional)
    local apt_name="$1" pc_name="${2:-}" lib_substr="${3:-}"
    if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Status}' "$apt_name" 2>/dev/null | grep -q "install ok installed"; then
      ok "$apt_name (dpkg)"
      return 0
    fi
    if [ -n "$pc_name" ] && command -v pkg-config >/dev/null 2>&1 && pkg-config --exists "$pc_name" 2>/dev/null; then
      ok "$apt_name (pkg-config: $pc_name)"
      return 0
    fi
    if [ -n "$lib_substr" ] && command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q "$lib_substr"; then
      warn "$apt_name dev headers not detected, but runtime lib '$lib_substr' present. Install -dev anyway for builds."
      apt_packages+=("$apt_name")
      missing=$((missing + 1))
      return 1
    fi
    bad "$apt_name"
    apt_packages+=("$apt_name")
    return 1
  }

  check_pkg_or_lib libwebkit2gtk-4.1-dev   webkit2gtk-4.1            libwebkit2gtk-4.1
  check_pkg_or_lib libssl-dev              openssl                   libssl
  check_pkg_or_lib libayatana-appindicator3-dev ayatana-appindicator3-0.1 libayatana-appindicator3
  check_pkg_or_lib librsvg2-dev            librsvg-2.0               librsvg-2

  # build-essential is always needed.
  if command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1; then
    ok "C toolchain (gcc/cc)"
  else
    bad "build-essential (gcc)"
    apt_packages+=("build-essential")
  fi
elif [ "$uname_s" = "Darwin" ]; then
  say ""
  say "${BOLD}macOS${RESET}"
  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode command line tools at $(xcode-select -p)"
  else
    bad "Xcode command line tools. Install with: xcode-select --install"
  fi
fi

# ---------- Summary ----------
say ""
if [ "$missing" -eq 0 ]; then
  say "${GREEN}${BOLD}All prerequisites satisfied.${RESET}"
  exit 0
fi

say "${RED}${BOLD}Missing $missing prerequisite(s).${RESET}"
if [ "${#apt_packages[@]}" -gt 0 ] && [ "$uname_s" = "Linux" ]; then
  say ""
  say "On Debian/Ubuntu, install with:"
  say ""
  printf '    sudo apt-get update && sudo apt-get install -y \\\n        %s\n' "${apt_packages[*]}"
  say ""
fi
exit 1
