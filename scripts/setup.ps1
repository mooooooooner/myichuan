# One-click setup for the Magai Proxy stack on Windows.
# Designed for users who do not read code: prints what it is doing, asks the
# minimum questions needed, never silently overwrites secrets.
#
# Run from the repository root after `git clone`:
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

[CmdletBinding()]
param(
    [int]$RegisterCount = -1,         # -1 means "ask interactively"
    [int]$Port = 8787,
    [string]$ListenHost = "0.0.0.0",
    [string]$ProxyApiKey = "",        # empty means "generate or ask"
    [switch]$NoStart,                  # skip launching dev servers at the end
    [switch]$SkipRegister              # skip auto-registering accounts
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# ---------- pretty helpers ----------
function Section($title) {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor DarkCyan
    Write-Host (" " + $title) -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor DarkCyan
}
function Ok($msg)   { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  [..]   $msg" -ForegroundColor Gray }
function Warn($msg) { Write-Host "  [!!]   $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [XX]   $msg" -ForegroundColor Red; exit 1 }

function Test-Cmd($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# ---------- prerequisites ----------
Section "1/6  Check prerequisites"

if (-not (Test-Cmd node)) {
    Fail "Node.js is not installed. Install Node 20+ from https://nodejs.org/ then re-run."
}
$nodeVer = (& node -v).TrimStart('v')
$nodeMajor = [int]($nodeVer -split '\.')[0]
if ($nodeMajor -lt 18) { Fail "Node $nodeVer is too old. Please install Node 20+." }
Ok "Node $nodeVer"

if (-not (Test-Cmd pnpm)) {
    Warn "pnpm not found. Trying to enable via corepack..."
    try {
        & corepack enable | Out-Null
        & corepack prepare pnpm@10.0.0 --activate | Out-Null
    } catch {
        Fail "Failed to enable pnpm. Install manually: npm i -g pnpm"
    }
}
$pnpmVer = (& pnpm -v).Trim()
Ok "pnpm $pnpmVer"

if (-not (Test-Cmd git)) { Warn "git not found (optional, only needed if you want to push changes)" }

# ---------- env file ----------
Section "2/6  Configure server .env"

$envPath     = Join-Path $repoRoot "apps\server\.env"
$envExample  = Join-Path $repoRoot "apps\server\.env.example"
$envExisted  = Test-Path $envPath

$defaultEnvTemplate = @(
    "# Auto-generated fallback template by scripts/setup.ps1",
    "PROXY_API_KEY=change-me",
    "PORT=8787",
    "HOST=0.0.0.0",
    "MAGAI_BASE_URL=https://beta.magai.co",
    "SUPABASE_URL=https://bkatrpghmzbpjhegvkev.supabase.co",
    "SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx",
    "MAGAI_NEXT_ACTION=40cd8b2ec4704e0f3c267bd98f93b0f9806e121b77",
    "MAGAI_CHAT_SNAPSHOT_ACTION=40a34afcf0167f40f2afa1b3ff5a65dc8451eac3a6",
    "MAGAI_ALWAYS_NEW_CHAT=1",
    "MAGAI_ACCOUNTS_FILE=apps/server/accounts.json",
    "MAGAI_MODEL_CATALOG_FILE=apps/server/model-catalog.json"
)

if ($envExisted) {
    Ok "Found existing apps\server\.env (kept as-is)"
} else {
    if (-not (Test-Path $envExample)) {
        Warn "apps\server\.env.example missing; generating fallback template"
        [System.IO.File]::WriteAllLines($envExample, $defaultEnvTemplate, [System.Text.UTF8Encoding]::new($false))
        Ok "Generated apps\server\.env.example fallback"
    }
    Copy-Item $envExample $envPath
    Ok "Created apps\server\.env from .env.example"
}

# Read .env so we can patch fields without clobbering user-set values.
function Read-EnvFile($path) {
    $h = [ordered]@{}
    if (-not (Test-Path $path)) { return $h }
    foreach ($line in Get-Content -Path $path -Encoding UTF8) {
        if ($line -match '^\s*#') { continue }
        if ($line -notmatch '^\s*[A-Za-z0-9_]+\s*=') { continue }
        $idx = $line.IndexOf('=')
        $k = $line.Substring(0, $idx).Trim()
        $v = $line.Substring($idx + 1).Trim()
        $h[$k] = $v
    }
    return $h
}
function Write-EnvFile($path, $hash) {
    $lines = @()
    foreach ($k in $hash.Keys) { $lines += ("{0}={1}" -f $k, $hash[$k]) }
    [System.IO.File]::WriteAllLines($path, $lines, [System.Text.UTF8Encoding]::new($false))
}

$envMap = Read-EnvFile $envPath

# PROXY_API_KEY
$currentKey = $envMap["PROXY_API_KEY"]
if (-not $currentKey -or $currentKey -eq "change-me" -or $currentKey -eq "") {
    if ($ProxyApiKey) {
        $envMap["PROXY_API_KEY"] = $ProxyApiKey
        Ok "PROXY_API_KEY set from -ProxyApiKey arg"
    } else {
        Write-Host ""
        Write-Host "  PROXY_API_KEY is the password your client (Cherry Studio / Cline / curl)" -ForegroundColor White
        Write-Host "  uses to call this proxy. Pick anything you'll remember." -ForegroundColor White
        $ans = Read-Host "  Enter PROXY_API_KEY (Enter to auto-generate)"
        if (-not $ans) {
            $ans = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Min 0 -Max 16) })
            Info "Auto-generated: $ans"
        }
        $envMap["PROXY_API_KEY"] = $ans
        Ok "PROXY_API_KEY saved"
    }
} else {
    Ok "PROXY_API_KEY already set (kept)"
}

# PORT
if (-not $envMap["PORT"]) { $envMap["PORT"] = "$Port" }
Ok ("Server PORT = " + $envMap["PORT"])

# HOST (listen address)
if (-not $envMap["HOST"]) { $envMap["HOST"] = "$ListenHost" }
Ok ("Server HOST = " + $envMap["HOST"])

# Required Magai/Supabase upstream constants 鈥?fill defaults if missing.
if (-not $envMap["MAGAI_BASE_URL"])           { $envMap["MAGAI_BASE_URL"] = "https://beta.magai.co" }
if (-not $envMap["SUPABASE_URL"])             { $envMap["SUPABASE_URL"]   = "https://bkatrpghmzbpjhegvkev.supabase.co" }
if (-not $envMap["SUPABASE_PUBLISHABLE_KEY"] -or $envMap["SUPABASE_PUBLISHABLE_KEY"] -eq "sb_publishable_xxx") {
    $envMap["SUPABASE_PUBLISHABLE_KEY"] = "sb_publishable_abLi4B3uk35xfTdT1d5Z1g_QVGG3JNo"
}
if (-not $envMap["MAGAI_NEXT_ACTION"])         { $envMap["MAGAI_NEXT_ACTION"] = "40cd8b2ec4704e0f3c267bd98f93b0f9806e121b77" }
if (-not $envMap["MAGAI_CHAT_SNAPSHOT_ACTION"]){ $envMap["MAGAI_CHAT_SNAPSHOT_ACTION"] = "40a34afcf0167f40f2afa1b3ff5a65dc8451eac3a6" }
if (-not $envMap["MAGAI_ALWAYS_NEW_CHAT"])     { $envMap["MAGAI_ALWAYS_NEW_CHAT"] = "1" }
if (-not $envMap["MAGAI_ACCOUNTS_FILE"])       { $envMap["MAGAI_ACCOUNTS_FILE"] = "apps/server/accounts.json" }
if (-not $envMap["MAGAI_MODEL_CATALOG_FILE"])  { $envMap["MAGAI_MODEL_CATALOG_FILE"] = "apps/server/model-catalog.json" }

Write-EnvFile $envPath $envMap
Ok "Wrote apps\server\.env"

# ---------- install dependencies ----------
Section "3/6  Install dependencies (pnpm install)"
& pnpm install
if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed" }
Ok "Dependencies installed"

# ---------- register accounts ----------
Section "4/6  Bootstrap accounts (auto-register or skip)"

$accountsFile = Join-Path $repoRoot "apps\server\accounts.json"
$existingCount = 0
if (Test-Path $accountsFile) {
    try {
        $existingCount = (@(Get-Content -Raw $accountsFile | ConvertFrom-Json)).Count
    } catch { $existingCount = 0 }
}
Info "Existing accounts on disk: $existingCount"

if ($SkipRegister) {
    Warn "Skipping account registration (-SkipRegister)"
} else {
    $count = $RegisterCount
    if ($count -lt 0) {
        Write-Host ""
        Write-Host "  This proxy needs at least one Magai account to forward requests." -ForegroundColor White
        Write-Host "  The register script will create N free accounts on beta.magai.co" -ForegroundColor White
        Write-Host "  (using a public signup gate) and store them in accounts.json." -ForegroundColor White
        $ans = Read-Host "  How many accounts to register now? (Enter to skip; recommended 3)"
        if (-not $ans) { $count = 0 } else { $count = [int]$ans }
    }
    if ($count -gt 0) {
        Info "Registering $count account(s)..."
        & pnpm --filter "@apps/server" register --count $count
        if ($LASTEXITCODE -ne 0) { Warn "register exited non-zero; check output above" }
        else { Ok "Accounts merged into accounts.json" }
    } else {
        Warn "No new accounts registered. You can run: pnpm --filter @apps/server register --count 3"
    }
}

# Backfill email/password into pre-existing accounts (no-op if none).
if (Test-Path (Join-Path $repoRoot "apps\server\registered.json")) {
    Info "Backfilling email/password into accounts.json..."
    & pnpm --filter "@apps/server" exec tsx src/backfill-credentials.ts
}

# ---------- import a default model so /v1/models is non-empty ----------
Section "5/6  Seed default model catalog"

$modelCatalogFile = $envMap["MAGAI_MODEL_CATALOG_FILE"]
if (-not $modelCatalogFile) { $modelCatalogFile = "apps/server/model-catalog.json" }
$modelCatalogPath = Join-Path $repoRoot $modelCatalogFile

$hasAccounts = $false
if (Test-Path $accountsFile) {
    try {
        $arr = @(Get-Content -Raw $accountsFile | ConvertFrom-Json)
        if ($arr.Count -gt 0) { $hasAccounts = $true }
    } catch {}
}

if (-not $hasAccounts) {
    Warn "No accounts present; skipping model seed"
} else {
    $needSeed = $true
    if (Test-Path $modelCatalogPath) {
        try {
            $existing = @(Get-Content -Raw $modelCatalogPath | ConvertFrom-Json)
            if ($existing.Count -gt 0) { $needSeed = $false }
        } catch {}
    }
    if ($needSeed) {
        $dir = Split-Path -Parent $modelCatalogPath
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $seed = @(
            @{
                id = "16c133bc-bab9-41af-b3d4-08dd9157dbca"
                name = "Claude Sonnet 4.6"
                apiName = "anthropic/claude-4.6-sonnet-20260217"
            }
        )
        $tmp = "$modelCatalogPath.tmp.$([System.Diagnostics.Process]::GetCurrentProcess().Id).$(Get-Random)"
        ($seed | ConvertTo-Json -Depth 10) | Set-Content -Encoding UTF8 -Path $tmp
        Move-Item -Force $tmp $modelCatalogPath
        Ok "Seeded Claude Sonnet 4.6 into model catalog file"
    } else {
        Ok "Model catalog already configured"
    }
}

# ---------- summary + start ----------
Section "6/6  Summary"

Write-Host "  Server URL  : http://$($envMap['HOST']):$($envMap['PORT'])"
Write-Host "  Portal URL  : http://127.0.0.1:5174"
Write-Host "  PROXY_API_KEY (use this as Bearer token):"
Write-Host ("    " + $envMap["PROXY_API_KEY"]) -ForegroundColor Yellow
Write-Host "  Accounts on disk: $((@(if (Test-Path $accountsFile) { Get-Content -Raw $accountsFile | ConvertFrom-Json } else { @() })).Count)"
Write-Host ""
Write-Host "  Quick test (after the server starts):"
Write-Host "    curl http://$($envMap['HOST']):$($envMap['PORT'])/health"
Write-Host "    curl http://$($envMap['HOST']):$($envMap['PORT'])/v1/models -H ""Authorization: Bearer $($envMap['PROXY_API_KEY'])"""
Write-Host ""

if ($NoStart) {
    Info "Skipping auto-start (-NoStart). Run when ready:"
    Write-Host "    pnpm dev" -ForegroundColor White
    exit 0
}

$ans = Read-Host "  Start the server + portal now in two new windows? [Y/n]"
if ($ans -and $ans.ToLower().StartsWith("n")) {
    Info "Not starting. Launch later with:  pnpm dev"
    exit 0
}

Info "Launching server in a new PowerShell window..."
Start-Process -FilePath "powershell" -WorkingDirectory $repoRoot -ArgumentList @(
    "-NoExit","-Command","pnpm --filter @apps/server dev"
)
Start-Sleep -Seconds 2
Info "Launching web portal in a new PowerShell window..."
Start-Process -FilePath "powershell" -WorkingDirectory $repoRoot -ArgumentList @(
    "-NoExit","-Command","pnpm --filter @apps/web-portal dev"
)
Ok "Both processes launched. Open http://127.0.0.1:5174 in your browser."
