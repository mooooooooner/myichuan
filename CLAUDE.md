# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

A reverse-engineered proxy that wraps `https://beta.magai.co`'s internal chat link as OpenAI- and Anthropic-compatible HTTP APIs, with a multi-account rotation pool and a small admin web portal. Used in CTF/research scenarios.

The two apps in the pnpm workspace:

- `apps/server` — Node/Express TypeScript proxy. The whole proxy is one file: `apps/server/src/index.ts` (~660 lines).
- `apps/web-portal` — React 19 + Vite + Tailwind admin portal. The UI is one component: `apps/web-portal/src/App.tsx`.

Persistent state lives at `apps/server/accounts.json` (overridable via `MAGAI_ACCOUNTS_FILE`). Server config comes from `apps/server/.env` (template in `.env.example`). Both files are sensitive — do not commit them.

## Common commands

Run from the repository root.

```bash
# Start server in watch mode (tsx). Default port 8787.
pnpm --filter @apps/server dev

# Start the web portal (Vite). Default port 5174, proxies /v1 and /health to 8787.
pnpm --filter @apps/web-portal dev

# Run both in parallel
pnpm dev

# Build everything. Server builds to apps/server/dist/server.cjs (esbuild --format=cjs, single file).
pnpm -r build

# Run the built server
node apps/server/dist/server.cjs
```

There is no test suite, no linter, and no formatter configured. The server has no separate type-check script — `tsx` runs TS directly; `pnpm --filter @apps/server build` is what surfaces type errors via the esbuild bundle (esbuild does not type-check, so use `tsc --noEmit -p apps/server` if you need strict type checking).

Smoke-test the running server:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer $PROXY_API_KEY"
curl http://127.0.0.1:8787/v1/chat/completions -H "Authorization: Bearer $PROXY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"ping"}]}'
```

## Architecture

### Upstream call chain (the core insight)

Every request to `/v1/chat/completions` or `/anthropic/v1/messages` walks this chain inside `index.ts`:

1. **Pick an account** — `chooseAccount()` round-robins through enabled entries in the in-memory `accounts` array (or honors an explicit `accountId` from the request). Pointer is `rrPointer`.
2. **Refresh Supabase access token** — `getSupabaseAccessToken()` POSTs to `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`. Caches the JWT until ~30s before `exp`. **If Supabase rotates the refresh token in the response, the new token is written back to `accounts.json` via `persistAccounts()`** — without this, restart loses the credential.
3. **Discover identity + chat + models** — `refreshDiscovery()` is throttled to once per 30s per account. It:
   - extracts `userId` from the access-token JWT payload (`sub`),
   - calls the `next-action` server action (`MAGAI_NEXT_ACTION`, default `40cd...`) on `${MAGAI_BASE_URL}/chat`,
   - reads `rest/v1/chat` and `rest/v1/spark` rows for the user to find an existing `chatId`, `team`, `workspace`, and historical model IDs,
   - probes catalog tables (`ai_model`, `models`, etc.) and merges with `MAGAI_MODEL_CATALOG_JSON` static config.
4. **Get short JWT for `/api/chat`** — `getMagaiShortJwt()` calls the `next-action` again with the access token + cookie and parses `1:"<jwt>"` from the `text/x-component` response. Cached until ~30s before `exp`.
5. **(Optional) create a fresh chat row** — if `MAGAI_ALWAYS_NEW_CHAT=1` or the request sets `newChat`, `createFreshChatId()` POSTs a new row to `rest/v1/chat` (cloning team/workspace/persona from a template chat).
6. **Hit `/api/chat`** — `requestMagaiChat()` POSTs NDJSON-streaming JSON. Important: the body must use the model's **`apiName`** (e.g. `anthropic/claude-4.6-sonnet-20260217`), not the display name — sending the display name returns 200 with empty content. The `apiName` is discovered from `spark.chat_json.modelDisplay` or supplied via `MAGAI_DEFAULT_MODEL_API_NAME`.
7. **Adapt the NDJSON stream** — `proxyNdjsonToOpenAI()` reads `text-delta` events line-by-line and re-emits either OpenAI SSE (`chat.completion.chunk` + `[DONE]`) or Anthropic SSE (`message_start` → `content_block_delta` → `message_delta` → `message_stop`). Non-stream mode buffers and returns one JSON.

### Account model

Each `Account` carries its own credentials (`magaiCookie`, `currentRefreshToken`, optional per-account overrides for every `MAGAI_*` and `SUPABASE_*` env var) plus per-account caches (`cachedSupabaseAccessToken`, `cachedMagaiJwt`, `discovery`). Per-env-var defaults are read once at startup into `DEFAULT_*` constants and applied via `makeAccount()`.

`bootstrapAccounts()` loads `accounts.json` if present; otherwise it builds a single `default` account from `MAGAI_COOKIE` + `SUPABASE_REFRESH_TOKEN` env vars. `persistAccounts()` writes back the serializable subset (caches and discovery state are not persisted).

`scrubAccount()` is the only thing the management endpoints expose — it strips cookies, tokens, and JWTs.

### Endpoints (all under one Express app, all auth'd via `auth()` middleware which accepts both `Authorization: Bearer` and `x-api-key`)

- Public: `GET /health`
- Account pool: `GET /v1/accounts`, `POST /v1/accounts/import`, `PATCH /v1/accounts/:id`, `DELETE /v1/accounts/:id`
- Models / stats: `GET /v1/models?accountId=…`, `GET /v1/stats`
- Chat: `POST /v1/chat/completions` (OpenAI), `POST /anthropic/v1/messages` and `POST /v1/messages` (Anthropic)

The OpenAI and Anthropic chat handlers both call into `proxyNdjsonToOpenAI(...,  anthropicMode)`. `accountId` can be passed in the request body (OpenAI) or in `metadata.accountId` (Anthropic) to bypass round-robin.

### Web portal

`apps/web-portal/src/App.tsx` is a single self-contained component. It hits the proxy via Vite's dev proxy (`/v1`, `/health` → `127.0.0.1:8787`). It stores the API key in `localStorage` under `proxy_api_key` and offers: enable/disable, delete, and bulk import via a JSON textarea. The README contains a browser-console snippet that scrapes `localStorage` on `beta.magai.co` to produce the import payload.

## Things that bite

- **Refresh-token rotation**: Supabase responses can include a new `refresh_token`. The code persists it; if you bypass `persistAccounts()` (e.g. holding accounts in memory only), restarts will fail with `refresh_token_already_used`.
- **`apiName` vs display name**: a model's `apiName` (with a `/` in it) is what `/api/chat` actually accepts. The fallback `MAGAI_DEFAULT_MODEL_API_NAME` exists for when discovery is degraded.
- **Discovery is best-effort**: if cookie or refresh token is dead, `/v1/models` may return only the configured default. Symptom of "models list is short" is almost always a stale token.
- **`next-action` IDs are upstream-build-specific**: `40cd…` (chat) and `40a3…` (chat snapshot) come from a specific Magai build. If they change upstream, both `MAGAI_NEXT_ACTION` and `MAGAI_CHAT_SNAPSHOT_ACTION` must be updated.
- **CJS-only build**: the production build is `--format=cjs` to avoid ESM `dynamic require` issues; do not introduce ESM-only top-level constructs (e.g. `import.meta.url`-based path tricks) that the bundler can't lower.
- **`pnpm-workspace.yaml` and `package.json` must not have a UTF-8 BOM** — pnpm rejects them as invalid JSON/YAML. This has bitten the repo before.

## Handover docs

`README.md`, `交接总结.md`, and `交接-代理服务实现说明.md` (Chinese) capture the original reverse-engineering work and field-tested gotchas. Read `交接-代理服务实现说明.md` if you're modifying the upstream call chain — it documents the exact `next-action` request shape and prior fix history.
