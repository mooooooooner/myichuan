# Manual commit + push helper.
# Run this in PowerShell from the repo root after reviewing changes.
# It does NOT push automatically — review each step.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\commit-and-push.ps1

# Use Continue (not Stop): we deliberately tolerate `git ls-files` printing to
# stderr when a file is not tracked, and we check $LASTEXITCODE explicitly.
$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false  # PS7+: don't auto-throw on non-zero exit
Set-Location (Split-Path -Parent $PSScriptRoot)

function Section($title) {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor DarkCyan
    Write-Host (" " + $title) -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor DarkCyan
}

Section "Pre-flight: confirm sensitive files are ignored"
$mustIgnore = @(
    "apps/server/.env",
    "apps/server/accounts.json",
    "apps/server/registered.json",
    "output.txt",
    "output2.txt",
    "output3.txt"
)
$leaked = @()
foreach ($f in $mustIgnore) {
    if (-not (Test-Path $f)) { continue }
    # `git ls-files --error-unmatch` exits non-zero with a stderr message when the
    # file is not tracked. We want that — it means the file is safely ignored.
    # Redirect both streams to $null so the noise doesn't look like a real error.
    & git ls-files --error-unmatch $f 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { $leaked += $f }
}
if ($leaked.Count -gt 0) {
    Write-Host "[ABORT] These files are tracked by git but should not be:" -ForegroundColor Red
    $leaked | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host "Run 'git rm --cached <file>' first." -ForegroundColor Red
    exit 1
}
Write-Host "  OK — no sensitive files staged" -ForegroundColor Green

Section "Current git status"
& git status --short

Section "Commit 1/2: token persistence + refresh resilience"
Write-Host "Files staged:" -ForegroundColor Gray
& git add `
    .gitignore `
    apps/server/src/index.ts `
    apps/server/src/register.ts `
    apps/server/src/backfill-credentials.ts `
    apps/web-portal/src/App.tsx
& git diff --cached --stat
Write-Host ""
Write-Host "Press Enter to create commit 1, Ctrl+C to abort"
Read-Host | Out-Null

$msg1 = @"
feat: persistent token refresh + password fallback

Eliminates the recurring 'refresh_token_already_used' / inactivity
timeout failures by making the auth path self-healing.

- refreshPromise single-flight dedup: N concurrent requests share one
  Supabase refresh round-trip, so two parallel handlers can never
  burn the same refresh_token and trigger session-family revocation.
- Password grant fallback: when a refresh fails for any reason
  (already_used, invalid_grant, inactivity timeout, network), we
  re-login with the email/password saved by the register script and
  write back the new refresh_token.
- Atomic persistAccounts: tmp file + rename + serialized Promise queue
  so two simultaneous rotations cannot clobber each other on disk.
- Renew 5 min early (was 30s) to clear Supabase reuse-interval window.
- New backfill-credentials.ts enriches pre-existing accounts.json from
  registered.json so old pools survive the upgrade.
- Web portal now shows hasPassword / lastRefreshAt / supabaseEmail.
- .gitignore: also exclude transient test output files.
"@

& git commit -m $msg1
if ($LASTEXITCODE -ne 0) { Write-Host "[ABORT] commit 1 failed" -ForegroundColor Red; exit 1 }

Section "Commit 2/2: one-click setup + test scripts"
& git add `
    README.md `
    scripts/setup.ps1 `
    scripts/setup.sh `
    scripts/test-token-persistence.ps1 `
    scripts/test-token-persistence.sh `
    scripts/test-token-live.ps1 `
    scripts/test-token-live.sh `
    scripts/commit-and-push.ps1
& git diff --cached --stat
Write-Host ""
Write-Host "Press Enter to create commit 2, Ctrl+C to abort"
Read-Host | Out-Null

$msg2 = @"
feat: one-click setup scripts + README quick start

For users who clone the repo and don't want to read code.

- scripts/setup.ps1 (Windows) and scripts/setup.sh (macOS/Linux):
    1) check Node + pnpm (auto-enables pnpm via corepack)
    2) create apps/server/.env, prompt for PROXY_API_KEY (auto-gen
       32-hex if blank), preserve existing values
    3) pnpm install
    4) prompt for how many Magai accounts to register, run the
       register flow, then backfill email/password
    5) seed Claude Sonnet 4.6 into the model catalog
    6) optionally launch server + portal in two new windows
   Both support flags for non-interactive use
   (-RegisterCount / --register-count, -ProxyApiKey / --proxy-key,
    -NoStart / --no-start, -SkipRegister / --skip-register).
- scripts/test-token-persistence.* and test-token-live.* let users
  validate the auth-path rework end to end on their own machine.
- scripts/commit-and-push.ps1 is the manual commit helper.
- README §0 documents the one-click flow up front; §9.5 explains the
  token persistence mechanism.
"@

& git commit -m $msg2
if ($LASTEXITCODE -ne 0) { Write-Host "[ABORT] commit 2 failed" -ForegroundColor Red; exit 1 }

Section "Recent commits"
& git log --oneline -5

Section "Push to origin/main"
Write-Host "About to run: git push origin main" -ForegroundColor Yellow
Write-Host "Press Enter to push, Ctrl+C to skip (you can push later manually)"
Read-Host | Out-Null
& git push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "[!!] push failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "DONE. Both commits pushed to origin/main." -ForegroundColor Green
