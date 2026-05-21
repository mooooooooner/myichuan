# Manual smoke test for the magai server changes (Windows / PowerShell).
# What this does (no upstream API calls — pure local checks):
#   1) tsc --noEmit on apps/server (type check)
#   2) esbuild bundle (mirrors `pnpm --filter @apps/server build`)
#   3) Backfill credentials (dry-run preview)
#   4) Run real backfill (writes accounts.json atomically)
#   5) Verify accounts.json now has email/password
#
# Run from repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\test-token-persistence.ps1

$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Section($n, $title) {
    Write-Host ""
    Write-Host "==========================================================="
    Write-Host "[$n] $title"
    Write-Host "==========================================================="
}

Section "1/5" "tsc type-check (apps/server)"
$tsc = "node_modules\.bin\tsc.cmd"
if (Test-Path $tsc) {
    & $tsc --noEmit -p apps/server/tsconfig.json
    Write-Host "tsc exit=$LASTEXITCODE"
} else {
    Write-Host "WARN: $tsc not found; trying via pnpm exec"
    pnpm --filter @apps/server exec tsc --noEmit -p tsconfig.json
    Write-Host "tsc exit=$LASTEXITCODE"
}

Section "2/5" "esbuild bundle (apps/server build)"
pnpm --filter @apps/server build
Write-Host "build exit=$LASTEXITCODE"
if (Test-Path "apps/server/dist") {
    Get-ChildItem apps/server/dist | Format-Table Name, Length, LastWriteTime
}

Section "3/5" "Backfill credentials (DRY RUN preview)"
$dryRunScript = @'
const fs = require('fs');
const a = JSON.parse(fs.readFileSync('apps/server/accounts.json','utf8'));
const r = JSON.parse(fs.readFileSync('apps/server/registered.json','utf8'));
const okR = r.filter(x => x.ok && x.password && x.email);
const byRefresh = new Map(okR.map(x => [x.refreshToken, x]));
const byEmail = new Map(okR.map(x => [String(x.email).toLowerCase(), x]));
let canFill = 0, alreadyHas = 0, missing = 0;
for (const x of a) {
  if (x.supabaseEmail && x.supabasePassword) { alreadyHas++; continue; }
  let hit = byRefresh.get(x.supabaseRefreshToken);
  if (!hit && x.name) hit = byEmail.get(String(x.name).toLowerCase());
  if (!hit && x.supabaseEmail) hit = byEmail.get(String(x.supabaseEmail).toLowerCase());
  if (hit) canFill++; else missing++;
}
console.log(JSON.stringify({total: a.length, alreadyHas, canFill, missing, registeredOk: okR.length}, null, 2));
'@
node -e $dryRunScript

Section "4/5" "Run real backfill (writes accounts.json atomically)"
pnpm --filter @apps/server exec tsx src/backfill-credentials.ts
Write-Host "backfill exit=$LASTEXITCODE"

Section "5/5" "Verify accounts.json now has email/password"
$verifyScript = @'
const a = JSON.parse(require('fs').readFileSync('apps/server/accounts.json','utf8'));
const stats = {
  total: a.length,
  withEmail: a.filter(x => x.supabaseEmail).length,
  withPassword: a.filter(x => x.supabasePassword).length,
  withRefresh: a.filter(x => x.supabaseRefreshToken).length,
};
console.log(JSON.stringify(stats, null, 2));
console.log('--- first entry (redacted) ---');
const first = a[0] || {};
console.log(JSON.stringify({
  id: first.id, name: first.name, enabled: first.enabled,
  hasCookie: !!first.magaiCookie, hasRefresh: !!first.supabaseRefreshToken,
  hasEmail: !!first.supabaseEmail, hasPassword: !!first.supabasePassword,
}, null, 2));
'@
node -e $verifyScript

Write-Host ""
Write-Host "DONE. Paste the entire output back to Claude."
