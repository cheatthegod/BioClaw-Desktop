# BioClaw One-Click Setup (Windows PowerShell)
# Usage: powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

function Write-Info  { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "[!]  $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[X]  $msg" -ForegroundColor Red }
function Write-Step  { param($msg) Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ── 1. Check / install Node.js ───────────────────────────────────────

Write-Step "Checking Node.js"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeVer = (node -v) -replace '^v', ''
    $nodeMajor = [int]($nodeVer -split '\.')[0]
    if ($nodeMajor -ge 20) {
        Write-Info "Node.js v$nodeVer found"
    } else {
        Write-Warn "Node.js v$nodeVer found but v20+ required"
        $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
        if ($wingetCmd) {
            Write-Info "Installing via winget..."
            winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
        } else {
            Write-Err "Please install Node.js 20+: https://nodejs.org"
            exit 1
        }
    }
} else {
    Write-Warn "Node.js not found"
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        Write-Info "Installing via winget..."
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    } else {
        Write-Err "Please install Node.js 20+: https://nodejs.org"
        exit 1
    }
}

# ── 2. Install npm dependencies ──────────────────────────────────────

Write-Step "Installing dependencies"
npm install
if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed"; exit 1 }
Write-Info "npm packages installed"

# ── 3. Check Docker ──────────────────────────────────────────────────

Write-Step "Checking container runtime"

$hasDocker = $false
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if ($dockerCmd) {
    try {
        docker info 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $hasDocker = $true }
    } catch {}
}

if ($hasDocker) {
    Write-Info "Docker is available"
    Write-Step "Building agent container image"
    Write-Host "This may take 5-10 minutes on first build..."
    docker build -t bioclaw-agent:latest container/
    if ($LASTEXITCODE -ne 0) { Write-Err "Docker build failed"; exit 1 }
    Write-Info "Container image built: bioclaw-agent:latest"
} else {
    Write-Warn "Docker not found or not running"
    Write-Host ""
    Write-Host "  BioClaw needs Docker to run the agent in isolated containers."
    Write-Host ""
    Write-Host "  Install Docker Desktop for Windows:"
    Write-Host "    https://docs.docker.com/desktop/install/windows-install/"
    Write-Host "    Or: winget install Docker.DockerDesktop"
    Write-Host ""
    Write-Host "  Or use local-web-only mode without containers:"
    Write-Host "    `$env:ENABLE_LOCAL_WEB='true'; npm run dev"
    Write-Host ""
    $reply = Read-Host "  Continue without Docker? (container features won't work) [y/N]"
    if ($reply -notmatch '^[Yy]') {
        Write-Err "Please install Docker first, then re-run this script."
        exit 1
    }
    Write-Warn "Continuing without Docker - container agent will not work"
}

# ── 4. Configure .env ────────────────────────────────────────────────

Write-Step "Configuring environment"

if (Test-Path .env) {
    Write-Info ".env already exists, skipping"
} else {
    Copy-Item .env.example .env
    Write-Info "Created .env from template"
    Write-Host ""
    Write-Host "  Choose your AI model provider:"
    Write-Host "    1) Anthropic (default, requires ANTHROPIC_API_KEY)"
    Write-Host "    2) OpenRouter (multi-model, requires OPENROUTER_API_KEY)"
    Write-Host "    3) Skip for now (edit .env manually later)"
    Write-Host ""
    $providerChoice = Read-Host "  Choice [1/2/3]"

    $envContent = Get-Content .env -Raw

    switch ($providerChoice) {
        '1' {
            $apiKey = Read-Host "  Enter your Anthropic API key"
            if ($apiKey) {
                $envContent = $envContent -replace 'ANTHROPIC_API_KEY=sk-ant-api03-your-key-here', "ANTHROPIC_API_KEY=$apiKey"
                Write-Info "Anthropic API key configured"
            }
        }
        '2' {
            $apiKey = Read-Host "  Enter your OpenRouter API key"
            if ($apiKey) {
                $envContent = $envContent -replace '^ANTHROPIC_API_KEY=.*', '# ANTHROPIC_API_KEY=' -replace '(?m)^# MODEL_PROVIDER=openrouter', 'MODEL_PROVIDER=openrouter' -replace '(?m)^# OPENROUTER_API_KEY=.*', "OPENROUTER_API_KEY=$apiKey" -replace '(?m)^# OPENROUTER_BASE_URL=.*', 'OPENROUTER_BASE_URL=https://openrouter.ai/api/v1' -replace '(?m)^# OPENROUTER_MODEL=.*', 'OPENROUTER_MODEL=deepseek/deepseek-chat-v3.1'
                Write-Info "OpenRouter configured (model: deepseek-chat-v3.1)"
            }
        }
        default {
            Write-Warn "Skipped - edit .env before starting"
        }
    }

    # Enable local web by default
    if ($envContent -notmatch '(?m)^ENABLE_LOCAL_WEB=') {
        $envContent += "`n# --- Local Web Chat ---`nENABLE_LOCAL_WEB=true`n"
    }

    Set-Content .env -Value $envContent -NoNewline
    Write-Info "Local web UI enabled (http://localhost:3000)"
}

# ── 5. Build TypeScript ──────────────────────────────────────────────

Write-Step "Building TypeScript"
npm run build
if ($LASTEXITCODE -ne 0) { Write-Err "Build failed"; exit 1 }
Write-Info "Build complete"

# ── 6. Summary ───────────────────────────────────────────────────────

Write-Step "Setup complete!"

Write-Host ""
Write-Host "  Next steps:"
Write-Host ""
if ($hasDocker) {
    Write-Host "  Start with web UI:" -ForegroundColor Green
    Write-Host "    npm run web"
    Write-Host ""
    Write-Host "  Start with WhatsApp:" -ForegroundColor Green
    Write-Host "    npm run auth    # Scan QR code first"
    Write-Host "    npm run dev     # Start the bot"
    Write-Host ""
} else {
    Write-Host "  Docker not available - install Docker Desktop first for full functionality." -ForegroundColor Yellow
    Write-Host ""
}
Write-Host "  Web UI:  http://localhost:3000  (chat + lab trace)" -ForegroundColor Green
Write-Host ""
Write-Host "  Edit .env to configure API keys and channels."
Write-Host ""
