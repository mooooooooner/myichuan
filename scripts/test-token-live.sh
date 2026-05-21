#!/usr/bin/env bash
# End-to-end live test for the token persistence rework.
# Assumes the proxy is already running on :8787 and you can read the server log.
#
# Run from repo root: bash scripts/test-token-live.sh <PROXY_API_KEY>
# Default key: test-key
set -u
KEY="${1:-test-key}"
HOST="${MAGAI_PROXY_HOST:-http://127.0.0.1:8787}"

echo "==========================================================="
echo "[1/6] Health check"
echo "==========================================================="
curl -s "$HOST/health" -w "\nHTTP=%{http_code}\n"
echo

echo "==========================================================="
echo "[2/6] /v1/accounts (expect hasPassword=true, lastRefreshAt set after first heartbeat)"
echo "==========================================================="
curl -s "$HOST/v1/accounts" -H "Authorization: Bearer $KEY" | node -e "
let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
  const d = JSON.parse(s);
  const list = d.data || [];
  console.log(JSON.stringify({
    total: list.length,
    enabled: list.filter(x=>x.enabled).length,
    hasPasswordCount: list.filter(x=>x.hasPassword).length,
    hasRefreshCount: list.filter(x=>x.hasRefreshToken).length,
    sample: list.slice(0,3).map(x => ({
      name: x.name, enabled: x.enabled,
      hasPassword: x.hasPassword, hasRefreshToken: x.hasRefreshToken,
      lastRefreshAt: x.lastRefreshAt, lastError: x.lastError
    }))
  }, null, 2));
});"
echo

echo "==========================================================="
echo "[3/6] /v1/models (forces a Supabase access_token refresh end-to-end)"
echo "==========================================================="
curl -s "$HOST/v1/models" -H "Authorization: Bearer $KEY" -w "\nHTTP=%{http_code}\n" | head -c 2000
echo

echo "==========================================================="
echo "[4/6] Concurrent x10 chat completions (stress refreshPromise dedup)"
echo "==========================================================="
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s "$HOST/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"reply OK only"}]}' \
    -o /tmp/magai-c$i.json -w "[req-$i] HTTP=%{http_code} time=%{time_total}s\n" &
done
wait
echo
for i in 1 2 3 4 5 6 7 8 9 10; do
  echo "--- req-$i (first 200B) ---"
  head -c 200 /tmp/magai-c$i.json
  echo
done
echo

echo "==========================================================="
echo "[5/6] /v1/accounts again (lastRefreshAt should have moved; lastError empty)"
echo "==========================================================="
curl -s "$HOST/v1/accounts" -H "Authorization: Bearer $KEY" | node -e "
let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{
  const d = JSON.parse(s);
  console.log(JSON.stringify((d.data||[]).map(x => ({
    name: x.name, lastRefreshAt: x.lastRefreshAt,
    lastUsedAt: x.lastUsedAt, lastError: x.lastError
  })), null, 2));
});"
echo

echo "==========================================================="
echo "[6/6] accounts.json on disk (refresh_token should have rotated since boot)"
echo "==========================================================="
node -e "
const a = JSON.parse(require('fs').readFileSync('apps/server/accounts.json','utf8'));
console.log(JSON.stringify(a.map(x => ({
  name: x.name,
  refreshHead: (x.supabaseRefreshToken||'').slice(0, 16),
  refreshLen: (x.supabaseRefreshToken||'').length,
  hasEmail: !!x.supabaseEmail, hasPassword: !!x.supabasePassword
})), null, 2));"
echo
echo "DONE. Paste the entire output back to Claude."
