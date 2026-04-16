#!/usr/bin/env bash
# BioClaw One-Click Setup
# Usage: curl -fsSL ... | bash  OR  bash setup.sh
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
err()   { echo -e "${RED}[✗]${NC} $*"; }
step()  { echo -e "\n${CYAN}━━━ $* ━━━${NC}"; }

# ── 1. Check / install Node.js ───────────────────────────────────────

step "Checking Node.js"

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    info "Node.js v${NODE_VER} found"
  else
    warn "Node.js v${NODE_VER} found but v20+ required"
    if command -v brew &>/dev/null; then
      info "Installing via Homebrew..."
      brew install node@22
    elif command -v nvm &>/dev/null; then
      info "Installing via nvm..."
      nvm install 22
      nvm use 22
    else
      err "Please install Node.js 20+: https://nodejs.org"
      exit 1
    fi
  fi
else
  warn "Node.js not found"
  if command -v brew &>/dev/null; then
    info "Installing via Homebrew..."
    brew install node@22
  else
    err "Please install Node.js 20+: https://nodejs.org"
    exit 1
  fi
fi

# ── 2. Install npm dependencies ──────────────────────────────────────

step "Installing dependencies"
npm install
info "npm packages installed"

# ── 3. Check Docker ──────────────────────────────────────────────────

step "Checking container runtime"

HAS_DOCKER=false
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  HAS_DOCKER=true
  info "Docker is available"
fi

if [ "$HAS_DOCKER" = true ]; then
  step "Building agent container image"
  echo "This may take 5-10 minutes on first build..."
  docker build -t bioclaw-agent:latest container/
  info "Container image built: bioclaw-agent:latest"
else
  warn "Docker not found or not running"
  echo ""
  echo "  BioClaw needs Docker to run the agent in isolated containers."
  echo ""
  echo "  Install Docker:"
  echo "    macOS:  brew install --cask docker  (then open Docker.app)"
  echo "    Linux:  curl -fsSL https://get.docker.com | sh"
  echo ""
  echo "  Or use local-web-only mode without containers:"
  echo "    ENABLE_LOCAL_WEB=true npm run dev"
  echo ""
  read -p "  Continue without Docker? (container features won't work) [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    err "Please install Docker first, then re-run this script."
    exit 1
  fi
  warn "Continuing without Docker — container agent will not work"
fi

# ── 4. Configure .env ────────────────────────────────────────────────

step "Configuring environment"

if [ -f .env ]; then
  info ".env already exists, skipping"
else
  cp .env.example .env
  info "Created .env from template"
  echo ""
  echo "  Choose your AI model provider:"
  echo "    1) Anthropic (default, requires ANTHROPIC_API_KEY)"
  echo "    2) OpenRouter (multi-model, requires OPENROUTER_API_KEY)"
  echo "    3) Skip for now (edit .env manually later)"
  echo ""
  read -p "  Choice [1/2/3]: " -n 1 -r PROVIDER_CHOICE
  echo

  case "$PROVIDER_CHOICE" in
    1)
      read -p "  Enter your Anthropic API key: " API_KEY
      if [ -n "$API_KEY" ]; then
        sed -i.bak "s|ANTHROPIC_API_KEY=sk-ant-api03-your-key-here|ANTHROPIC_API_KEY=${API_KEY}|" .env
        rm -f .env.bak
        info "Anthropic API key configured"
      fi
      ;;
    2)
      read -p "  Enter your OpenRouter API key: " API_KEY
      if [ -n "$API_KEY" ]; then
        # Enable OpenRouter, disable Anthropic
        sed -i.bak \
          -e "s|^ANTHROPIC_API_KEY=.*|# ANTHROPIC_API_KEY=|" \
          -e "s|^# MODEL_PROVIDER=openrouter|MODEL_PROVIDER=openrouter|" \
          -e "s|^# OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=${API_KEY}|" \
          -e "s|^# OPENROUTER_BASE_URL=.*|OPENROUTER_BASE_URL=https://openrouter.ai/api/v1|" \
          -e "s|^# OPENROUTER_MODEL=.*|OPENROUTER_MODEL=deepseek/deepseek-chat-v3.1|" \
          .env
        rm -f .env.bak
        info "OpenRouter configured (model: deepseek-chat-v3.1)"
      fi
      ;;
    *)
      warn "Skipped — edit .env before starting"
      ;;
  esac

  # Enable local web by default for easy testing
  if ! grep -q "^ENABLE_LOCAL_WEB=" .env; then
    echo "" >> .env
    echo "# ─── Local Web Chat ──────────────────────────" >> .env
    echo "ENABLE_LOCAL_WEB=true" >> .env
  fi
  info "Local web UI enabled (http://localhost:3000)"
fi

# ── 5. Build TypeScript ──────────────────────────────────────────────

step "Building TypeScript"
npm run build
info "Build complete"

# ── 6. Summary ───────────────────────────────────────────────────────

step "Setup complete!"

echo ""
echo "  Next steps:"
echo ""
if [ "$HAS_DOCKER" = true ]; then
  echo "  ${GREEN}Start with web UI:${NC}"
  echo "    npm run web"
  echo ""
  echo "  ${GREEN}Start with WhatsApp:${NC}"
  echo "    npm run auth    # Scan QR code first"
  echo "    npm run dev     # Start the bot"
  echo ""
else
  echo "  ${YELLOW}Docker not available — install Docker first for full functionality.${NC}"
  echo ""
fi
echo "  ${GREEN}Web UI:${NC}  http://localhost:3000  (chat + lab trace)"
echo ""
echo "  Edit .env to configure API keys and channels."
echo ""
