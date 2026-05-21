#!/usr/bin/env bash
# Manual smoke test for the magai server changes.
# Pipes everything to stdout so you can paste back the result.
#
# What this does (no actual API calls — pure local checks):
#   1) tsc --noEmit on apps/server (type check)
#   2) esbuild build (mirrors `pnpm --filter @apps/server build`)
#   3) Verify accounts.json shape after backfill (dry-run, prints a JOIN preview)
#   4) Quick sanity grep on key edits
#
# Run from repo root: bash scripts/test-token-persistence.sh
set -u
cd "$(dirname "$0")/.."

echo "==========================================================="
echo "[1/5] tsc type-check (apps/server)"
echo "==========================================================="
if [ -x node_modules/.bin/tsc ]; then
  node_modules/.bin/tsc --noEmit -p apps/server/tsconfig.json
  echo "tsc exit=$?"
else
  echo "WARN: node_modules/.bin/tsc not found; trying via pnpm exec"
  pnpm --filter @apps/server exec tsc --noEmit -p tsconfig.json
  echo "tsc exit=$?"
fi
echo

echo "==========================================================="
echo "[2/5] esbuild bundle (apps/server build)"
echo "==========================================================="
pnpm --filter @apps/server build
echo "build exit=$?"
ls -la apps/server/dist/ 2>/dev/null
echo

echo "==========================================================="
echo "[3/5] Backfill credentials (DRY RUN preview)"
echo "==========================================================="
node -e "
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
"
echo

echo "==========================================================="
echo "[4/5] Run real backfill (writes accounts.json atomically)"
echo "==========================================================="
pnpm --filter @apps/server exec tsx src/backfill-credentials.ts
echo "backfill exit=$?"
echo

echo "==========================================================="
echo "[5/5] Verify accounts.json now has email/password"
echo "==========================================================="
node -e "
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
"
echo
echo "DONE. Paste the entire output back to Claude."
