#!/usr/bin/env bash
# One-click setup for the Magai Proxy stack on macOS / Linux.
# Run from the repository root after `git clone`:
#   bash scripts/setup.sh
#
# Flags (all optional):
#   --register-count N   Skip the prompt and register N accounts
#   --port P             Override server port (default 8787)
#   --host H             Override server listen host (default 0.0.0.0)
#   --proxy-key KEY      Pre-set PROXY_API_KEY
#   --skip-register      Don't register any new accounts
#   --no-start           Don't launch dev servers at the end

set -uo pipefail
cd "$(dirname "$0")/.."

REGISTER_COUNT=-1
PORT=8787
HOST="0.0.0.0"
PROXY_KEY=""
SKIP_REGISTER=0
NO_START=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --register-count) REGISTER_COUNT="${2:-0}"; shift 2 ;;
        --port)           PORT="${2:-8787}";        shift 2 ;;
        --host)           HOST="${2:-0.0.0.0}";     shift 2 ;;
        --proxy-key)      PROXY_KEY="${2:-}";        shift 2 ;;
        --skip-register)  SKIP_REGISTER=1;           shift   ;;
        --no-start)       NO_START=1;                shift   ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
done

# ---------- pretty helpers ----------
cyan()   { printf "\033[36m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m  [OK]   %s\033[0m\n" "$1"; }
gray()   { printf "\033[90m  [..]   %s\033[0m\n" "$1"; }
yellow() { printf "\033[33m  [!!]   %s\033[0m\n" "$1"; }
red()    { printf "\033[31m  [XX]   %s\033[0m\n" "$1"; }
section() {
    echo
    cyan "================================================================"
    cyan " $1"
    cyan "================================================================"
}
fail() { red "$1"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 1. prerequisites ----------
section "1/6  Check prerequisites"

if ! have node; then
    fail "Node.js not found. Install Node 20+ from https://nodejs.org/ then re-run."
fi
NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
if [[ "$NODE_MAJOR" -lt 18 ]]; then fail "Node $NODE_VER too old; please install Node 20+."; fi
green "Node $NODE_VER"

if ! have pnpm; then
    yellow "pnpm not found; trying corepack..."
    if have corepack; then
        corepack enable >/dev/null 2>&1 || true
        corepack prepare pnpm@10.0.0 --activate >/dev/null 2>&1 || true
    fi
fi
if ! have pnpm; then fail "pnpm still missing. Install with: npm i -g pnpm"; fi
green "pnpm $(pnpm -v)"

have git || yellow "git not found (optional)"

# ---------- 2. .env ----------
section "2/6  Configure server .env"

ENV_FILE="apps/server/.env"
ENV_EXAMPLE="apps/server/.env.example"

DEFAULT_ENV_TEMPLATE="$(cat <<'EOF'
# Auto-generated fallback template by scripts/setup.sh
PROXY_API_KEY=change-me
PORT=8787
HOST=0.0.0.0
MAGAI_BASE_URL=https://beta.magai.co
SUPABASE_URL=https://bkatrpghmzbpjhegvkev.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx
MAGAI_NEXT_ACTION=40cd8b2ec4704e0f3c267bd98f93b0f9806e121b77
MAGAI_CHAT_SNAPSHOT_ACTION=40a34afcf0167f40f2afa1b3ff5a65dc8451eac3a6
MAGAI_ALWAYS_NEW_CHAT=1
MAGAI_ACCOUNTS_FILE=accounts.json
MAGAI_MODEL_CATALOG_FILE=model-catalog.json
EOF
)"

if [[ -f "$ENV_FILE" ]]; then
    green "Found existing apps/server/.env (kept as-is)"
else
    if [[ ! -f "$ENV_EXAMPLE" ]]; then
        yellow "$ENV_EXAMPLE missing; generating fallback template"
        printf "%s\n" "$DEFAULT_ENV_TEMPLATE" > "$ENV_EXAMPLE"
        green "Generated apps/server/.env.example fallback"
    fi
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    green "Created apps/server/.env from .env.example"
fi

# get_env / set_env operate on a flat KEY=VALUE file; preserve unrelated lines.
get_env() {
    local key="$1"
    awk -F= -v k="$key" 'BEGIN{IGNORECASE=0} /^[[:space:]]*#/ {next} {sub(/^[ \t]+/,"",$1); if($1==k){sub(/^[^=]*=/,"",$0); print $0; exit}}' "$ENV_FILE"
}
set_env() {
    local key="$1" value="$2"
    if grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
        # Use a sentinel to avoid sed delimiter clashes with the value.
        local tmp; tmp="$(mktemp)"
        awk -v k="$key" -v v="$value" '
            BEGIN{done=0}
            /^[[:space:]]*#/ {print; next}
            { if (!done && match($0, "^[[:space:]]*"k"=")) { print k"="v; done=1; next } print }
            END{ if(!done) print k"="v }
        ' "$ENV_FILE" > "$tmp"
        mv "$tmp" "$ENV_FILE"
    else
        echo "${key}=${value}" >> "$ENV_FILE"
    fi
}

CURRENT_KEY="$(get_env PROXY_API_KEY)"
if [[ -z "$CURRENT_KEY" || "$CURRENT_KEY" == "change-me" ]]; then
    if [[ -n "$PROXY_KEY" ]]; then
        set_env PROXY_API_KEY "$PROXY_KEY"
        green "PROXY_API_KEY set from --proxy-key"
    else
        echo
        echo "  PROXY_API_KEY is the password your client (Cherry Studio / Cline / curl)"
        echo "  uses to call this proxy. Pick anything you'll remember."
        read -r -p "  Enter PROXY_API_KEY (Enter to auto-generate): " ANS
        if [[ -z "$ANS" ]]; then
            if have openssl; then ANS="$(openssl rand -hex 16)"; else ANS="$(head -c 16 /dev/urandom | xxd -p)"; fi
            gray "Auto-generated: $ANS"
        fi
        set_env PROXY_API_KEY "$ANS"
        green "PROXY_API_KEY saved"
    fi
else
    green "PROXY_API_KEY already set (kept)"
fi

[[ -z "$(get_env PORT)" ]] && set_env PORT "$PORT"
green "Server PORT = $(get_env PORT)"
[[ -z "$(get_env HOST)" ]] && set_env HOST "$HOST"
green "Server HOST = $(get_env HOST)"

# Defaults for required upstream constants (only fill if blank).
[[ -z "$(get_env MAGAI_BASE_URL)" ]]            && set_env MAGAI_BASE_URL "https://beta.magai.co"
[[ -z "$(get_env SUPABASE_URL)"   ]]            && set_env SUPABASE_URL "https://bkatrpghmzbpjhegvkev.supabase.co"
PUBKEY_VAL="$(get_env SUPABASE_PUBLISHABLE_KEY)"
if [[ -z "$PUBKEY_VAL" || "$PUBKEY_VAL" == "sb_publishable_xxx" ]]; then
    set_env SUPABASE_PUBLISHABLE_KEY "sb_publishable_abLi4B3uk35xfTdT1d5Z1g_QVGG3JNo"
fi
[[ -z "$(get_env MAGAI_NEXT_ACTION)" ]]          && set_env MAGAI_NEXT_ACTION "40cd8b2ec4704e0f3c267bd98f93b0f9806e121b77"
[[ -z "$(get_env MAGAI_CHAT_SNAPSHOT_ACTION)" ]] && set_env MAGAI_CHAT_SNAPSHOT_ACTION "40a34afcf0167f40f2afa1b3ff5a65dc8451eac3a6"
[[ -z "$(get_env MAGAI_ALWAYS_NEW_CHAT)" ]]      && set_env MAGAI_ALWAYS_NEW_CHAT "1"
[[ -z "$(get_env MAGAI_ACCOUNTS_FILE)" ]]        && set_env MAGAI_ACCOUNTS_FILE "accounts.json"
[[ -z "$(get_env MAGAI_MODEL_CATALOG_FILE)" ]]   && set_env MAGAI_MODEL_CATALOG_FILE "model-catalog.json"

green "Wrote apps/server/.env"

# ---------- 3. install ----------
section "3/6  Install dependencies (pnpm install)"
pnpm install || fail "pnpm install failed"
green "Dependencies installed"

# ---------- 4. register ----------
section "4/6  Bootstrap accounts (auto-register or skip)"

ACCOUNTS_FILE="apps/server/accounts.json"
EXISTING=0
if [[ -f "$ACCOUNTS_FILE" ]]; then
    EXISTING=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length||0)}catch{console.log(0)}" "$ACCOUNTS_FILE")
fi
gray "Existing accounts on disk: $EXISTING"

if [[ "$SKIP_REGISTER" == "1" ]]; then
    yellow "Skipping registration (--skip-register)"
else
    COUNT="$REGISTER_COUNT"
    if [[ "$COUNT" -lt 0 ]]; then
        echo
        echo "  This proxy needs at least one Magai account to forward requests."
        echo "  The register script will create N free accounts on beta.magai.co"
        echo "  (using a public signup gate) and store them in accounts.json."
        read -r -p "  How many accounts to register now? (Enter to skip; recommended 3): " ANS
        if [[ -z "$ANS" ]]; then COUNT=0; else COUNT="$ANS"; fi
    fi
    if [[ "$COUNT" -gt 0 ]]; then
        gray "Registering $COUNT account(s)..."
        pnpm --filter "@apps/server" register --count "$COUNT" || yellow "register exited non-zero; check output above"
        green "Accounts merged into accounts.json"
    else
        yellow "No new accounts registered. Later: pnpm --filter @apps/server register --count 3"
    fi
fi

if [[ -f "apps/server/registered.json" ]]; then
    gray "Backfilling email/password into accounts.json..."
    pnpm --filter "@apps/server" exec tsx src/backfill-credentials.ts || true
fi

# ---------- 5. seed model catalog ----------
section "5/6  Seed default model catalog"

if [[ -f "$ACCOUNTS_FILE" ]]; then
    MODEL_CATALOG_FILE_CFG="$(get_env MAGAI_MODEL_CATALOG_FILE)"
    if [[ -z "$MODEL_CATALOG_FILE_CFG" ]]; then
        MODEL_CATALOG_FILE_CFG="model-catalog.json"
    fi
    if [[ "$MODEL_CATALOG_FILE_CFG" != /* ]]; then
        MODEL_CATALOG_FILE_PATH="apps/server/$MODEL_CATALOG_FILE_CFG"
    else
        MODEL_CATALOG_FILE_PATH="$MODEL_CATALOG_FILE_CFG"
    fi
    NEED_SEED=$(node -e "
        const fs=require('fs');
        const accountsFile=process.argv[1];
        const modelCatalogFile=process.argv[2];
        try {
            const a=JSON.parse(fs.readFileSync(accountsFile,'utf8'));
            if (!Array.isArray(a)||a.length===0) {
                process.stdout.write('skip');
                process.exit(0);
            }
            if (fs.existsSync(modelCatalogFile)) {
                try {
                    const m=JSON.parse(fs.readFileSync(modelCatalogFile,'utf8'));
                    if (Array.isArray(m) && m.length>0) {
                        process.stdout.write('ok');
                        process.exit(0);
                    }
                } catch {}
            }
            process.stdout.write('seed');
        } catch { process.stdout.write('skip'); }
    " "$ACCOUNTS_FILE" "$MODEL_CATALOG_FILE_PATH")
    case "$NEED_SEED" in
        seed)
            node -e "
                const fs=require('fs');
                const file=process.argv[1];
                const dir=require('path').dirname(file);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
                const data=[{\"id\":\"16c133bc-bab9-41af-b3d4-08dd9157dbca\",\"name\":\"Claude Sonnet 4.6\",\"apiName\":\"anthropic/claude-4.6-sonnet-20260217\"}];
                const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
                fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
                fs.renameSync(tmp, file);
            " "$MODEL_CATALOG_FILE_PATH"
            green "Seeded Claude Sonnet 4.6 into model catalog file" ;;
        ok)   green "Model catalog already configured" ;;
        skip) yellow "No accounts present; skipping model seed" ;;
    esac
fi

# ---------- 6. summary ----------
section "6/6  Summary"

FINAL_PORT="$(get_env PORT)"
FINAL_HOST="$(get_env HOST)"
FINAL_KEY="$(get_env PROXY_API_KEY)"
FINAL_COUNT=0
if [[ -f "$ACCOUNTS_FILE" ]]; then
    FINAL_COUNT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length||0)}catch{console.log(0)}" "$ACCOUNTS_FILE")
fi

echo "  Server URL  : http://$FINAL_HOST:$FINAL_PORT"
echo "  Portal URL  : http://127.0.0.1:5174"
echo "  PROXY_API_KEY (use this as Bearer token):"
printf "\033[33m    %s\033[0m\n" "$FINAL_KEY"
echo "  Accounts on disk: $FINAL_COUNT"
echo
echo "  Quick test (after the server starts):"
echo "    curl http://$FINAL_HOST:$FINAL_PORT/health"
echo "    curl http://$FINAL_HOST:$FINAL_PORT/v1/models -H \"Authorization: Bearer $FINAL_KEY\""
echo

if [[ "$NO_START" == "1" ]]; then
    gray "Skipping auto-start (--no-start). Run when ready:"
    echo "    pnpm dev"
    exit 0
fi

read -r -p "  Start the server + portal now (in this terminal, parallel)? [Y/n] " ANS
case "${ANS:-y}" in
    n|N|no|NO) gray "Not starting. Launch later with: pnpm dev"; exit 0 ;;
esac

gray "Launching pnpm dev (Ctrl+C to stop)..."
exec pnpm dev
