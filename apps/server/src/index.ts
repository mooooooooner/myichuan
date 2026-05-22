import express, { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "apps/server/.env"),
  path.resolve(process.cwd(), "../.env"),
];
let loadedEnvPath = "";
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    loadEnv({ path: p, override: false });
    loadedEnvPath = p;
    break;
  }
}

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = Number(process.env.PORT || 8787);
const HOST = (process.env.HOST || "127.0.0.1").trim();
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const DEFAULT_MAGAI_BASE_URL = process.env.MAGAI_BASE_URL || "https://beta.magai.co";
const DEFAULT_MAGAI_COOKIE = process.env.MAGAI_COOKIE || "";
const DEFAULT_MAGAI_NEXT_ACTION = process.env.MAGAI_NEXT_ACTION || "40cd8b2ec4704e0f3c267bd98f93b0f9806e121b77";
const DEFAULT_SUPABASE_URL = process.env.SUPABASE_URL || "https://bkatrpghmzbpjhegvkev.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const DEFAULT_MAGAI_DEFAULT_CHAT_ID = process.env.MAGAI_DEFAULT_CHAT_ID || "";
const DEFAULT_MAGAI_DEFAULT_MODEL_ID = process.env.MAGAI_DEFAULT_MODEL_ID || "";
const DEFAULT_MAGAI_DEFAULT_MODEL_NAME = process.env.MAGAI_DEFAULT_MODEL_NAME || "Claude Sonnet 4.6";
const DEFAULT_MAGAI_DEFAULT_MODEL_API_NAME = process.env.MAGAI_DEFAULT_MODEL_API_NAME || "";
const DEFAULT_MAGAI_ALWAYS_NEW_CHAT = process.env.MAGAI_ALWAYS_NEW_CHAT === "1";
const DEFAULT_MAGAI_USER_ID = process.env.MAGAI_USER_ID || "";
const DEFAULT_MAGAI_MODEL_CATALOG_JSON = process.env.MAGAI_MODEL_CATALOG_JSON || "";
const DEFAULT_MAGAI_IMAGE_ACTION = process.env.MAGAI_IMAGE_ACTION || "7fa3b9255f2ff4eef604b8c9a7bbc1b37ceb871dae";
const DEFAULT_MAGAI_IMAGE_PRESET = process.env.MAGAI_IMAGE_PRESET || "v2";
const DEFAULT_MAGAI_IMAGE_MODEL_NAME = process.env.MAGAI_IMAGE_MODEL_NAME || "Nano Banana";
const DEFAULT_MAGAI_IMAGE_RESOLUTION = process.env.MAGAI_IMAGE_RESOLUTION || "1K";
const DEFAULT_MAGAI_CHAT_SNAPSHOT_ACTION = process.env.MAGAI_CHAT_SNAPSHOT_ACTION || "40a34afcf0167f40f2afa1b3ff5a65dc8451eac3a6";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(SCRIPT_DIR, "..");
const ACCOUNTS_FILE = process.env.MAGAI_ACCOUNTS_FILE || path.resolve(SERVER_DIR, "accounts.json");
const MODEL_CATALOG_FILE = process.env.MAGAI_MODEL_CATALOG_FILE || path.resolve(SERVER_DIR, "model-catalog.json");
const FALLBACK_ROUTER_STATE_TREE = `["",{"children":[["path","chat","oc",null],{"children":["__PAGE__",{},null,null,0]},null,null,0]},null,null,16]`;

const startAt = Date.now();
let rrPointer = 0;

type Stat = { calls: number; errors: number; promptTokens: number; completionTokens: number; totalDurationMs: number; totalTtftMs: number; ttftCount: number };
type DiscoveredModel = { id: string; name: string; alias: string; apiName?: string };
type DiscoveryState = { userId?: string; chatId?: string; teamId?: string; workspaceId?: string; models: DiscoveredModel[]; ts: number };
type AccountInput = {
  id?: string;
  name?: string;
  enabled?: boolean;
  magaiCookie?: string;
  supabaseRefreshToken?: string;
  supabaseEmail?: string;
  supabasePassword?: string;
  supabasePublishableKey?: string;
  supabaseUrl?: string;
  magaiBaseUrl?: string;
  magaiNextAction?: string;
  magaiChatSnapshotAction?: string;
  magaiUserId?: string;
  magaiDefaultChatId?: string;
  magaiDefaultModelId?: string;
  magaiDefaultModelName?: string;
  magaiDefaultModelApiName?: string;
  magaiModelCatalogJson?: string;
  magaiAlwaysNewChat?: boolean;
  magaiImageAction?: string;
  magaiImagePreset?: string;
};
type Account = Required<Pick<AccountInput, "id" | "name" | "enabled" | "magaiCookie" | "supabaseRefreshToken">> &
  Omit<AccountInput, "id" | "name" | "enabled" | "magaiCookie" | "supabaseRefreshToken"> & {
    discovery: DiscoveryState;
    cachedMagaiJwt: string;
    cachedMagaiJwtExp: number;
    cachedSupabaseAccessToken: string;
    cachedSupabaseAccessExp: number;
    currentRefreshToken: string;
    lastError?: string;
    lastUsedAt?: number;
    lastRefreshAt?: number;
    refreshPromise?: Promise<string> | null;
  };

const stats: Record<"openai" | "anthropic", Stat> = {
  openai: { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, totalTtftMs: 0, ttftCount: 0 },
  anthropic: { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, totalTtftMs: 0, ttftCount: 0 },
};

let accounts: Account[] = [];
let modelCatalog: DiscoveredModel[] = [];

function uuid() { return crypto.randomUUID(); }
function countWords(s: string) { return (s.trim().match(/\S+/g) || []).length; }
function toAlias(name: string) { return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function decodeJwtExp(jwt: string) { try { return Number(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).exp || 0); } catch { return 0; } }
function decodeJwtPayload(jwt: string): any { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")); }
function extractChatId(text: string) { const m = text.match(/"chatId":"([0-9a-f-]{36})"/i); return m?.[1]; }
function extractUserId(text: string) { const m = text.match(/"created_by":"([0-9a-f-]{36})"/i) || text.match(/"owner":"([0-9a-f-]{36})"/i); return m?.[1]; }
function parseModelNameFromChatJson(chatJson: any): string | undefined {
  if (!chatJson) return undefined;
  if (typeof chatJson === "string") {
    try { return parseModelNameFromChatJson(JSON.parse(chatJson)); } catch { return chatJson.match(/"modelDisplay":"([^"]+)"/)?.[1]; }
  }
  if (typeof chatJson === "object") {
    if (Array.isArray(chatJson.timeline) && chatJson.timeline.length > 0) return chatJson.timeline.find((t: any) => typeof t?.modelDisplay === "string")?.modelDisplay;
    if (typeof chatJson.modelDisplay === "string") return chatJson.modelDisplay;
  }
  return undefined;
}
function normalizeMessages(messages: any[]) {
  return (messages || []).map((m: any) => ({ role: m.role || "user", content: typeof m.content === "string" ? m.content : (m.content || []).map((p: any) => p.text || "").join("\n") }));
}
function scrubAccount(a: Account) {
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    hasCookie: !!a.magaiCookie,
    hasRefreshToken: !!a.currentRefreshToken,
    hasPassword: !!(a.supabaseEmail && a.supabasePassword),
    supabaseEmail: a.supabaseEmail || "",
    lastError: a.lastError || "",
    lastUsedAt: a.lastUsedAt || 0,
    lastRefreshAt: a.lastRefreshAt || 0,
    discovery: { chatId: a.discovery.chatId || "", userId: a.discovery.userId || "", modelCount: a.discovery.models.length, ts: a.discovery.ts || 0 },
  };
}

function makeAccount(input: AccountInput): Account {
  return {
    id: (input.id || uuid()).trim(),
    name: (input.name || `account-${Math.floor(Math.random() * 1e5)}`).trim(),
    enabled: input.enabled !== false,
    magaiCookie: (input.magaiCookie || DEFAULT_MAGAI_COOKIE || "").trim(),
    supabaseRefreshToken: (input.supabaseRefreshToken || "").trim(),
    supabaseEmail: (input.supabaseEmail || "").trim(),
    supabasePassword: input.supabasePassword || "",
    supabasePublishableKey: input.supabasePublishableKey || DEFAULT_SUPABASE_PUBLISHABLE_KEY,
    supabaseUrl: input.supabaseUrl || DEFAULT_SUPABASE_URL,
    magaiBaseUrl: input.magaiBaseUrl || DEFAULT_MAGAI_BASE_URL,
    magaiNextAction: input.magaiNextAction || DEFAULT_MAGAI_NEXT_ACTION,
    magaiChatSnapshotAction: input.magaiChatSnapshotAction || DEFAULT_MAGAI_CHAT_SNAPSHOT_ACTION,
    magaiUserId: input.magaiUserId || DEFAULT_MAGAI_USER_ID,
    magaiDefaultChatId: input.magaiDefaultChatId || DEFAULT_MAGAI_DEFAULT_CHAT_ID,
    magaiDefaultModelId: input.magaiDefaultModelId || DEFAULT_MAGAI_DEFAULT_MODEL_ID,
    magaiDefaultModelName: input.magaiDefaultModelName || DEFAULT_MAGAI_DEFAULT_MODEL_NAME,
    magaiDefaultModelApiName: input.magaiDefaultModelApiName || DEFAULT_MAGAI_DEFAULT_MODEL_API_NAME,
    magaiModelCatalogJson: input.magaiModelCatalogJson || DEFAULT_MAGAI_MODEL_CATALOG_JSON,
    magaiAlwaysNewChat: input.magaiAlwaysNewChat ?? DEFAULT_MAGAI_ALWAYS_NEW_CHAT,
    magaiImageAction: input.magaiImageAction || DEFAULT_MAGAI_IMAGE_ACTION,
    magaiImagePreset: input.magaiImagePreset || DEFAULT_MAGAI_IMAGE_PRESET,
    discovery: { models: [], ts: 0 },
    cachedMagaiJwt: "",
    cachedMagaiJwtExp: 0,
    cachedSupabaseAccessToken: "",
    cachedSupabaseAccessExp: 0,
    currentRefreshToken: (input.supabaseRefreshToken || "").trim(),
    refreshPromise: null,
  };
}

function loadAccountsFromDisk() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [] as Account[];
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((a) => makeAccount(a));
  } catch {
    return [];
  }
}

let persistQueue: Promise<void> = Promise.resolve();
function persistAccounts() {
  // Serialize all writes through a single chain to avoid concurrent overwrites
  // clobbering rotated refresh_tokens. Each call is atomic via tmp+rename.
  persistQueue = persistQueue.then(async () => {
    const dir = path.dirname(ACCOUNTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const serializable = accounts.map((a) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      magaiCookie: a.magaiCookie,
      supabaseRefreshToken: a.currentRefreshToken || a.supabaseRefreshToken,
      supabaseEmail: a.supabaseEmail || "",
      supabasePassword: a.supabasePassword || "",
      supabasePublishableKey: a.supabasePublishableKey || "",
      supabaseUrl: a.supabaseUrl || "",
      magaiBaseUrl: a.magaiBaseUrl || "",
      magaiNextAction: a.magaiNextAction || "",
      magaiChatSnapshotAction: a.magaiChatSnapshotAction || "",
      magaiUserId: a.magaiUserId || "",
      magaiDefaultChatId: a.magaiDefaultChatId || "",
      magaiDefaultModelId: a.magaiDefaultModelId || "",
      magaiDefaultModelName: a.magaiDefaultModelName || "",
      magaiDefaultModelApiName: a.magaiDefaultModelApiName || "",
      magaiAlwaysNewChat: !!a.magaiAlwaysNewChat,
      magaiImageAction: a.magaiImageAction || "",
      magaiImagePreset: a.magaiImagePreset || "",
    }));
    const tmp = `${ACCOUNTS_FILE}.tmp.${process.pid}.${Date.now()}`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(serializable, null, 2), "utf8");
      await fs.promises.rename(tmp, ACCOUNTS_FILE);
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch {}
      throw e;
    }
  }).catch((e) => {
    console.error("[persistAccounts] failed:", (e as Error)?.message || e);
  });
}

function persistModelCatalog() {
  const serializable = getKnownModels().map((m) => ({ id: m.id, name: m.name, apiName: m.apiName || "" }));
  persistQueue = persistQueue.then(async () => {
    const dir = path.dirname(MODEL_CATALOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${MODEL_CATALOG_FILE}.tmp.${process.pid}.${Date.now()}`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(serializable, null, 2), "utf8");
      await fs.promises.rename(tmp, MODEL_CATALOG_FILE);
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch {}
      throw e;
    }
  }).catch((e) => {
    console.error("[persistModelCatalog] failed:", (e as Error)?.message || e);
  });
}

function bootstrapAccounts() {
  const disk = loadAccountsFromDisk();
  if (disk.length > 0) {
    accounts = disk;
    return;
  }
  const fallbackCookie = process.env.MAGAI_COOKIE || "";
  const fallbackRefresh = process.env.SUPABASE_REFRESH_TOKEN || "";
  if (fallbackCookie && fallbackRefresh) {
    accounts = [makeAccount({ id: "default", name: "default", enabled: true, magaiCookie: fallbackCookie, supabaseRefreshToken: fallbackRefresh })];
  }
}

function bootstrapModelCatalog() {
  // Priority: dedicated catalog file -> legacy env var -> legacy per-account fields -> default model.
  const fromFile = loadModelCatalogFromDisk();
  if (fromFile.length > 0) {
    modelCatalog = fromFile;
    return;
  }

  const merged = new Map<string, DiscoveredModel>();
  for (const m of parseModelCatalogJson(DEFAULT_MAGAI_MODEL_CATALOG_JSON)) upsertModel(merged, m.id, m.name, m.apiName);
  for (const a of accounts) {
    for (const m of parseModelCatalogJson(a.magaiModelCatalogJson || "")) upsertModel(merged, m.id, m.name, m.apiName);
    if (a.magaiDefaultModelId) {
      const name = a.magaiDefaultModelName || DEFAULT_MAGAI_DEFAULT_MODEL_NAME;
      upsertModel(merged, a.magaiDefaultModelId, name, a.magaiDefaultModelApiName || undefined);
    }
  }
  if (merged.size === 0 && DEFAULT_MAGAI_DEFAULT_MODEL_ID) {
    upsertModel(merged, DEFAULT_MAGAI_DEFAULT_MODEL_ID, DEFAULT_MAGAI_DEFAULT_MODEL_NAME, DEFAULT_MAGAI_DEFAULT_MODEL_API_NAME || undefined);
  }
  modelCatalog = Array.from(merged.values());
  if (modelCatalog.length > 0) persistModelCatalog();
}

function auth(req: Request, res: Response, next: NextFunction) {
  if (!PROXY_API_KEY) return res.status(500).json({ error: { message: "PROXY_API_KEY not configured" } });
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  const xApiKey = (req.headers["x-api-key"] as string) || "";
  if (bearer !== PROXY_API_KEY && xApiKey !== PROXY_API_KEY) return res.status(401).json({ error: { message: "Unauthorized" } });
  next();
}

function chooseAccount(explicitId?: string) {
  if (explicitId) {
    const hit = accounts.find((a) => a.id === explicitId && a.enabled);
    if (!hit) throw new Error(`account not found or disabled: ${explicitId}`);
    hit.lastUsedAt = Date.now();
    return hit;
  }
  const enabled = accounts.filter((a) => a.enabled);
  if (enabled.length === 0) throw new Error("no enabled accounts");
  const picked = enabled[rrPointer % enabled.length];
  rrPointer = (rrPointer + 1) % enabled.length;
  picked.lastUsedAt = Date.now();
  return picked;
}

function upsertModel(map: Map<string, DiscoveredModel>, id: string, name?: string, apiName?: string) {
  if (!id) return;
  const prev = map.get(id);
  const normalizedName = (name || "").trim();
  if (!prev) {
    const finalName = normalizedName || `model-${id.slice(0, 8)}`;
    map.set(id, { id, name: finalName, alias: toAlias(finalName), apiName: apiName || (finalName.includes("/") ? finalName : undefined) });
    return;
  }
  if (!prev.name.startsWith("model-") || !normalizedName) return;
  prev.name = normalizedName;
  prev.alias = toAlias(normalizedName);
  if (apiName && !prev.apiName) prev.apiName = apiName;
}

function parseModelCatalogJson(raw: string) {
  if (!raw) return [] as DiscoveredModel[];
  try {
    const parsed = JSON.parse(raw) as any[];
    if (!Array.isArray(parsed)) return [];
    const out: DiscoveredModel[] = [];
    for (const item of parsed) {
      const id = String(item?.id || "").trim();
      const name = String(item?.name || "").trim();
      if (!id || !name) continue;
      const apiName = String(item?.apiName || item?.model || "").trim() || (name.includes("/") ? name : "");
      out.push({ id, name, alias: toAlias(name), apiName: apiName || undefined });
    }
    return out;
  } catch {
    return [];
  }
}

function normalizeModelCatalog(models: DiscoveredModel[]) {
  const byId = new Map<string, DiscoveredModel>();
  for (const m of models) upsertModel(byId, m.id, m.name, m.apiName);
  return Array.from(byId.values());
}

function loadModelCatalogFromDisk() {
  if (!fs.existsSync(MODEL_CATALOG_FILE)) return [] as DiscoveredModel[];
  try {
    const parsed = JSON.parse(fs.readFileSync(MODEL_CATALOG_FILE, "utf8")) as any;
    if (!Array.isArray(parsed)) return [];
    return normalizeModelCatalog(parsed.map((m: any) => ({
      id: String(m?.id || "").trim(),
      name: String(m?.name || "").trim(),
      apiName: String(m?.apiName || m?.model || "").trim(),
      alias: "",
    })));
  } catch {
    return [];
  }
}

function getKnownModels() {
  return normalizeModelCatalog(modelCatalog);
}

async function fetchJsonArray(url: string, headers: Record<string, string>) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) return [] as any[];
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}


async function callServerAction(account: Account, actionId: string, accessToken: string | null, userId: string) {
  const bearer = accessToken || account.supabasePublishableKey || "";
  const resp = await fetch(`${account.magaiBaseUrl}/chat`, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId,
      "next-router-state-tree": FALLBACK_ROUTER_STATE_TREE,
      cookie: account.magaiCookie,
      apikey: account.supabasePublishableKey || "",
      authorization: `Bearer ${bearer}`,
      origin: account.magaiBaseUrl || "",
      referer: `${account.magaiBaseUrl}/chat`,
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    body: `["${userId}"]`,
  });
  const txt = await resp.text();
  return { ok: resp.ok, status: resp.status, text: txt };
}

async function callChatAction(account: Account, actionId: string, accessToken: string | null, chatId: string) {
  const bearer = accessToken || account.supabasePublishableKey || "";
  const resp = await fetch(`${account.magaiBaseUrl}/chat`, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": actionId,
      "next-router-state-tree": FALLBACK_ROUTER_STATE_TREE,
      cookie: account.magaiCookie,
      apikey: account.supabasePublishableKey || "",
      authorization: `Bearer ${bearer}`,
      origin: account.magaiBaseUrl || "",
      referer: `${account.magaiBaseUrl}/chat/${chatId}`,
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    body: `["${chatId}"]`,
  });
  const txt = await resp.text();
  return { ok: resp.ok, status: resp.status, text: txt };
}

async function supabasePasswordSignIn(account: Account) {
  if (!account.supabaseEmail || !account.supabasePassword) {
    throw new Error("password fallback unavailable: supabaseEmail/supabasePassword not configured");
  }
  const resp = await fetch(`${account.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      accept: "*/*",
      apikey: account.supabasePublishableKey || "",
      authorization: `Bearer ${account.supabasePublishableKey || ""}`,
      "content-type": "application/json;charset=UTF-8",
      "x-client-info": "supabase-js-web/2.74.0",
      "x-supabase-api-version": "2024-01-01",
    },
    body: JSON.stringify({ email: account.supabaseEmail, password: account.supabasePassword, gotrue_meta_security: {} }),
  });
  const data = (await resp.json().catch(() => null)) as any;
  if (!resp.ok || !data?.access_token) {
    throw new Error(`password signin failed: ${resp.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

async function refreshSupabaseTokenLocked(account: Account): Promise<string> {
  // Tries refresh_token first; falls back to password grant if email/password are
  // configured. Either path writes back the freshly-issued refresh_token so the
  // next call has a valid one.
  let lastErr: any = null;

  if (account.currentRefreshToken && account.supabasePublishableKey) {
    try {
      const resp = await fetch(`${account.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: account.supabasePublishableKey,
          authorization: `Bearer ${account.supabasePublishableKey}`,
        },
        body: JSON.stringify({ refresh_token: account.currentRefreshToken }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as any;
        account.cachedSupabaseAccessToken = data.access_token;
        account.cachedSupabaseAccessExp = Number(data.expires_at || decodeJwtExp(data.access_token));
        if (data.refresh_token) {
          account.currentRefreshToken = data.refresh_token;
          account.supabaseRefreshToken = data.refresh_token;
          persistAccounts();
        }
        account.lastRefreshAt = Date.now();
        account.lastError = "";
        return account.cachedSupabaseAccessToken;
      }
      lastErr = new Error(`refresh token failed: ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
  }

  // Fallback: password grant. Survives refresh_token_already_used, invalid_grant,
  // inactivity timeout, family revocation, etc.
  if (account.supabaseEmail && account.supabasePassword) {
    const data = await supabasePasswordSignIn(account);
    account.cachedSupabaseAccessToken = data.access_token;
    account.cachedSupabaseAccessExp = Number(data.expires_at || decodeJwtExp(data.access_token));
    if (data.refresh_token) {
      account.currentRefreshToken = data.refresh_token;
      account.supabaseRefreshToken = data.refresh_token;
      persistAccounts();
    }
    account.lastRefreshAt = Date.now();
    account.lastError = "";
    return account.cachedSupabaseAccessToken;
  }

  throw lastErr || new Error("supabase credentials not configured");
}

async function getSupabaseAccessToken(account: Account) {
  const now = Math.floor(Date.now() / 1000);
  // Renew 5 minutes early (was 30s) to give breathing room to refresh-token
  // reuse-interval windows and avoid mid-request expiry.
  if (account.cachedSupabaseAccessToken && account.cachedSupabaseAccessExp - 300 > now) return account.cachedSupabaseAccessToken;
  if (!account.supabasePublishableKey) throw new Error("supabase credentials not configured");
  if (!account.currentRefreshToken && !(account.supabaseEmail && account.supabasePassword)) {
    throw new Error("supabase credentials not configured");
  }
  // In-flight de-duplication: N concurrent requests share one refresh round-trip.
  if (account.refreshPromise) return account.refreshPromise;
  const p = refreshSupabaseTokenLocked(account)
    .catch((e) => {
      account.lastError = (e as Error)?.message || "refresh failed";
      throw e;
    })
    .finally(() => {
      account.refreshPromise = null;
    });
  account.refreshPromise = p;
  return p;
}

async function refreshDiscovery(account: Account, accessToken: string) {
  const now = Date.now();
  if (now - account.discovery.ts < 30_000 && account.discovery.chatId) return;
  const payload = decodeJwtPayload(accessToken);
  const userId = payload.sub as string;
  account.discovery.userId = userId;

  // Fresh accounts can have active_team / active_workspace before any chat rows exist.
  // Pull them directly from user profile to enable new-chat creation.
  try {
    const userResp = await fetch(
      `${account.supabaseUrl}/rest/v1/user?select=active_team,active_workspace&id=eq.${userId}`,
      {
        headers: {
          accept: "application/vnd.pgrst.object+json",
          apikey: account.supabasePublishableKey || "",
          authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (userResp.ok) {
      const u = (await userResp.json()) as any;
      if (u?.active_team && !account.discovery.teamId) account.discovery.teamId = String(u.active_team);
      if (u?.active_workspace && !account.discovery.workspaceId) account.discovery.workspaceId = String(u.active_workspace);
    }
  } catch {
    // Best-effort only; downstream discovery continues.
  }

  const tokenAction = await callServerAction(account, account.magaiNextAction || DEFAULT_MAGAI_NEXT_ACTION, accessToken, userId);
  if (!tokenAction.ok) throw new Error(`next-action preflight failed: ${tokenAction.status}`);

  const h = { apikey: account.supabasePublishableKey || "", authorization: `Bearer ${accessToken}` };
  const chatRows = await fetchJsonArray(
    `${account.supabaseUrl}/rest/v1/chat?select=id,team,workspace,modified_at&or=(is_deleted.is.null,is_deleted.eq.false)&created_by=eq.${userId}&order=modified_at.desc&limit=20`,
    h,
  );
  for (const row of chatRows) {
    if (!account.discovery.chatId && row?.id) account.discovery.chatId = row.id;
    if (!account.discovery.teamId && row?.team) account.discovery.teamId = row.team;
    if (!account.discovery.workspaceId && row?.workspace) account.discovery.workspaceId = row.workspace;
  }

  if (!account.discovery.chatId) account.discovery.chatId = extractChatId(tokenAction.text);
  account.discovery.models = getKnownModels();
  account.discovery.ts = now;
}

function requireDiscoveredModel(inputModel: string) {
  const known = getKnownModels();
  if (known.length === 0) throw new Error("No known models configured. Import models first.");
  const needle = inputModel.toLowerCase();
  const hit =
    known.find((m) => m.id.toLowerCase() === needle) ||
    known.find((m) => m.name.toLowerCase() === needle) ||
    known.find((m) => m.alias === needle);
  if (hit) return hit;
  return known[0];
}

async function createFreshChatId(account: Account, accessToken: string, modelId: string) {
  const h = { apikey: account.supabasePublishableKey || "", authorization: `Bearer ${accessToken}`, "content-type": "application/json", prefer: "return=representation" };
  const userId = account.discovery.userId || account.magaiUserId;
  if (!userId) throw new Error("cannot create chat: userId unavailable");

  let team = account.discovery.teamId;
  let workspace = account.discovery.workspaceId;
  let chatPersona = "";
  let owner = userId;
  const baseChatId = account.discovery.chatId || account.magaiDefaultChatId;
  if (baseChatId) {
    const templateRows = await fetchJsonArray(`${account.supabaseUrl}/rest/v1/chat?select=id,team,workspace,owner,chat_persona&id=eq.${baseChatId}&limit=1`, h);
    const t = templateRows[0];
    if (t?.team) team = String(t.team);
    if (t?.workspace) workspace = String(t.workspace);
    if (t?.chat_persona) chatPersona = String(t.chat_persona);
    if (t?.owner) owner = String(t.owner);
  }
  if (!team || !workspace) throw new Error("cannot create chat: team/workspace unavailable");
  const title = `New Chat - ${new Date().toISOString().replace("T", " ").slice(0, 19)}`;
  const chatResp = await fetch(`${account.supabaseUrl}/rest/v1/chat?select=id,team,workspace`, {
    method: "POST",
    headers: h,
    body: JSON.stringify([{ title, archived: false, pinned: false, team, workspace, folder: null, owner, created_by: userId, ai_model: modelId, chat_persona: chatPersona || null }]),
  });
  if (!chatResp.ok) throw new Error(`create chat failed: ${chatResp.status}`);
  const created = (await chatResp.json())[0];
  const chatId = created?.id as string;
  if (!chatId) throw new Error("create chat failed: missing chatId");
  account.discovery.chatId = chatId;
  account.discovery.teamId = team;
  account.discovery.workspaceId = workspace;
  return chatId;
}

async function getMagaiShortJwt(account: Account) {
  const now = Math.floor(Date.now() / 1000);
  if (account.cachedMagaiJwt && account.cachedMagaiJwtExp - 30 > now) return account.cachedMagaiJwt;
  if (!account.magaiCookie) throw new Error("MAGAI_COOKIE not configured");
  let accessToken: string | null = null;
  try {
    accessToken = await getSupabaseAccessToken(account);
    await refreshDiscovery(account, accessToken);
  } catch {
    // fallback without token
  }
  if (!account.discovery.userId) {
    const knownChatId = account.discovery.chatId || account.magaiDefaultChatId;
    if (knownChatId) {
      const snap = await callChatAction(account, account.magaiChatSnapshotAction || DEFAULT_MAGAI_CHAT_SNAPSHOT_ACTION, accessToken, knownChatId);
      if (snap.ok) {
        const uid = extractUserId(snap.text);
        if (uid) account.discovery.userId = uid;
        const cid = extractChatId(snap.text);
        if (!account.discovery.chatId && cid) account.discovery.chatId = cid;
      }
    }
  }
  const userId = account.discovery.userId || account.magaiUserId;
  if (!userId) throw new Error("failed to discover userId");
  const resp = await callServerAction(account, account.magaiNextAction || DEFAULT_MAGAI_NEXT_ACTION, accessToken, userId);
  const m = resp.text.match(/\n1:"([^"]+)"/) || resp.text.match(/^1:"([^"]+)"/m);
  if (!resp.ok || !m) throw new Error(`next-action failed: ${resp.status}`);
  account.cachedMagaiJwt = m[1];
  account.cachedMagaiJwtExp = decodeJwtExp(account.cachedMagaiJwt);
  return account.cachedMagaiJwt;
}

async function requestMagaiChat(account: Account, input: { model: string; messages: any[]; chatId?: string; newChat?: boolean }) {
  const token = await getMagaiShortJwt(account);
  const resolvedModel = requireDiscoveredModel(input.model);
  let chatId = input.chatId || account.discovery.chatId || account.magaiDefaultChatId;
  if (!input.chatId && (input.newChat || account.magaiAlwaysNewChat)) {
    try {
      const accessToken = await getSupabaseAccessToken(account);
      chatId = await createFreshChatId(account, accessToken, resolvedModel.id);
    } catch {
      // Fallback: if new-chat creation cannot resolve team/workspace for a fresh account,
      // continue with discovered/default chatId instead of failing the whole request.
      chatId = input.chatId || account.discovery.chatId || account.magaiDefaultChatId;
    }
  }
  if (!chatId) throw new Error("chatId not discovered automatically; pass chatId in request body");
  const resp = await fetch(`${account.magaiBaseUrl}/api/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/x-ndjson",
      origin: account.magaiBaseUrl || "",
      referer: `${account.magaiBaseUrl}/chat`,
    },
    body: JSON.stringify({
      model: resolvedModel.apiName || resolvedModel.name,
      modelId: resolvedModel.id,
      chatId,
      sparkId: uuid(),
      messages: normalizeMessages(input.messages),
      skipTitleGeneration: true,
      enabledTools: [],
      enabledToolkits: [],
      userTimezone: "Asia/Shanghai",
    }),
  });
  if (!resp.ok || !resp.body) throw new Error(`/api/chat failed: ${resp.status}`);
  return resp;
}

function toAspectRatio(size?: string) {
  const val = (size || "").trim().toLowerCase();
  if (!val) return "1:1";
  if (val === "1024x1024" || val === "1:1") return "1:1";
  if (val === "1024x1536" || val === "2:3") return "2:3";
  if (val === "1536x1024" || val === "3:2") return "3:2";
  if (val === "1024x1792" || val === "9:16") return "9:16";
  if (val === "1792x1024" || val === "16:9") return "16:9";
  if (val === "1152x896" || val === "9:7") return "9:7";
  if (val === "896x1152" || val === "7:9") return "7:9";
  return "1:1";
}

function extractImagePayload(text: string) {
  const urls = Array.from(new Set((text.match(/https?:\/\/[^\s"'\\]+/g) || []).filter((u) => /(png|jpe?g|webp|gif)(\?|$)/i.test(u))));
  const dataUrl = text.match(/data:image\/[a-zA-Z+.-]+;base64,([a-zA-Z0-9+/=]+)/)?.[1] || "";
  const b64 =
    dataUrl ||
    text.match(/"([A-Za-z0-9+/]{200,}={0,2})"/)?.[1] ||
    "";
  return { urls, b64 };
}

async function requestMagaiImage(
  account: Account,
  input: { prompt: string; size?: string; quality?: string; chatId?: string; accountId?: string; style?: string; background?: string },
) {
  const token = await getMagaiShortJwt(account);
  const accessToken = await getSupabaseAccessToken(account);
  await refreshDiscovery(account, accessToken);
  const userId = account.discovery.userId || account.magaiUserId;
  if (!userId) throw new Error("userId not discovered automatically");
  const aspectRatio = toAspectRatio(input.size);
  const preset = account.magaiImagePreset || DEFAULT_MAGAI_IMAGE_PRESET;
  const modelLabel = DEFAULT_MAGAI_IMAGE_MODEL_NAME;
  const resolution = DEFAULT_MAGAI_IMAGE_RESOLUTION;
  const bodyCandidates = [
    JSON.stringify(["", aspectRatio, userId, preset, modelLabel, "$undefined", resolution, null, "$undefined"]),
    JSON.stringify([input.prompt, aspectRatio, userId, preset, modelLabel, "$undefined", resolution, null, "$undefined"]),
    JSON.stringify(["", aspectRatio, userId, preset, modelLabel, input.prompt, resolution, null, "$undefined"]),
  ];
  const actionCandidates = Array.from(new Set([account.magaiImageAction || "", DEFAULT_MAGAI_IMAGE_ACTION, "7f58ff553f4cfd13f25c1a6204f1dcf10061086e3c", "7fa3b9255f2ff4eef604b8c9a7bbc1b37ceb871dae"].filter(Boolean)));
  const baseAttempts: Array<Omit<Record<string, string>, "next-action">> = [
    {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-router-state-tree": FALLBACK_ROUTER_STATE_TREE,
      cookie: account.magaiCookie,
      origin: account.magaiBaseUrl || "",
      referer: `${account.magaiBaseUrl}/chat`,
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-router-state-tree": FALLBACK_ROUTER_STATE_TREE,
      cookie: account.magaiCookie,
      apikey: account.supabasePublishableKey || "",
      authorization: `Bearer ${accessToken}`,
      origin: account.magaiBaseUrl || "",
      referer: `${account.magaiBaseUrl}/chat`,
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-router-state-tree": FALLBACK_ROUTER_STATE_TREE,
      cookie: account.magaiCookie,
      apikey: account.supabasePublishableKey || "",
      authorization: `Bearer ${token}`,
      origin: account.magaiBaseUrl || "",
      referer: `${account.magaiBaseUrl}/chat`,
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  ];
  let lastErr = "";
  for (const actionId of actionCandidates) {
    for (const body of bodyCandidates) {
      for (const base of baseAttempts) {
        const headers = { ...base, "next-action": actionId };
        const resp = await fetch(`${account.magaiBaseUrl}/chat`, { method: "POST", headers, body });
        const text = await resp.text();
        if (resp.ok && !/\n1:E\{/.test(text) && !/"switched":false/.test(text)) return text;
        lastErr = `action=${actionId}; status=${resp.status}; body=${text.slice(0, 500)}`;
      }
    }
  }
  throw new Error(`image action failed: ${lastErr}`);
}

app.get("/health", (_req, res) => res.json({ ok: true, accountCount: accounts.length, enabledCount: accounts.filter((a) => a.enabled).length }));
app.get("/v1/accounts", auth, (_req, res) => res.json({ object: "list", data: accounts.map(scrubAccount), rrPointer }));
app.post("/v1/accounts/import", auth, (req, res) => {
  const raw = req.body?.accounts;
  if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: { message: "accounts[] required" } });
  const mergedModels = new Map<string, DiscoveredModel>();
  for (const m of getKnownModels()) upsertModel(mergedModels, m.id, m.name, m.apiName);
  for (const item of raw) {
    const account = makeAccount(item || {});
    if (!account.magaiCookie || !account.supabaseRefreshToken) continue;
    for (const m of parseModelCatalogJson(account.magaiModelCatalogJson || "")) upsertModel(mergedModels, m.id, m.name, m.apiName);
    const idx = accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) accounts[idx] = { ...accounts[idx], ...account, discovery: { models: [], ts: 0 }, cachedMagaiJwt: "", cachedMagaiJwtExp: 0, cachedSupabaseAccessToken: "", cachedSupabaseAccessExp: 0, currentRefreshToken: account.supabaseRefreshToken };
    else accounts.push(account);
  }
  modelCatalog = Array.from(mergedModels.values());
  for (const a of accounts) a.discovery.models = getKnownModels();
  persistAccounts();
  persistModelCatalog();
  return res.json({ ok: true, count: accounts.length, data: accounts.map(scrubAccount) });
});
app.patch("/v1/accounts/:id", auth, (req, res) => {
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: { message: "account not found" } });
  const patch = req.body || {};
  if (typeof patch.name === "string") account.name = patch.name.trim() || account.name;
  if (typeof patch.enabled === "boolean") account.enabled = patch.enabled;
  persistAccounts();
  return res.json({ ok: true, data: scrubAccount(account) });
});
app.delete("/v1/accounts/:id", auth, (req, res) => {
  const before = accounts.length;
  accounts = accounts.filter((a) => a.id !== req.params.id);
  if (accounts.length === before) return res.status(404).json({ error: { message: "account not found" } });
  persistAccounts();
  return res.json({ ok: true, count: accounts.length });
});

app.post("/v1/models/import", auth, (req, res) => {
  const models = req.body?.models;
  if (!Array.isArray(models) || models.length === 0) {
    return res.status(400).json({ error: { message: "models[] required" } });
  }
  const normalized = models
    .map((m: any) => ({
      id: String(m?.id || "").trim(),
      name: String(m?.name || "").trim(),
      apiName: String(m?.apiName || "").trim(),
    }))
    .filter((m: any) => m.id && m.name);
  if (normalized.length === 0) {
    return res.status(400).json({ error: { message: "valid models[] required (id + name)" } });
  }
  const merged = new Map<string, DiscoveredModel>();
  for (const m of getKnownModels()) upsertModel(merged, m.id, m.name, m.apiName);
  for (const m of normalized) upsertModel(merged, m.id, m.name, m.apiName || undefined);
  modelCatalog = Array.from(merged.values());
  for (const a of accounts) {
    a.discovery.models = getKnownModels();
    a.discovery.ts = Date.now();
  }
  persistModelCatalog();
  return res.json({ ok: true, count: modelCatalog.length, data: getKnownModels() });
});

app.get("/v1/models", auth, async (_req, res) => {
  try {
    const models = getKnownModels();
    return res.json({
      object: "list",
      data: models.map((m) => ({ id: m.alias, object: "model", owned_by: "magai-proxy", meta: { magaiModelId: m.id, magaiModelName: m.name, magaiModelApiName: m.apiName || "" } })),
    });
  } catch (e: any) {
    return res.status(500).json({ error: { message: e?.message || "models error" } });
  }
});

app.get("/v1/stats", auth, (_req, res) => {
  const f = (s: Stat) => ({ calls: s.calls, errors: s.errors, promptTokens: s.promptTokens, completionTokens: s.completionTokens, avgTtftMs: s.ttftCount ? Math.round(s.totalTtftMs / s.ttftCount) : 0, avgDurationMs: s.calls ? Math.round(s.totalDurationMs / s.calls) : 0, health: s.errors > s.calls * 0.3 ? "degraded" : "healthy" });
  res.json({ uptimeMs: Date.now() - startAt, rrPointer, accounts: accounts.map(scrubAccount), backends: { openai: f(stats.openai), anthropic: f(stats.anthropic) } });
});

async function proxyNdjsonToOpenAI(
  req: Request,
  res: Response,
  backend: "openai" | "anthropic",
  stream: boolean,
  model: string,
  messages: any[],
  chatId?: string,
  anthropicMode = false,
  newChat = false,
) {
  const t0 = Date.now();
  stats[backend].calls += 1;
  let account: Account | null = null;
  try {
    account = chooseAccount(String(req.body?.accountId || req.query?.accountId || ""));
    const upstream = await requestMagaiChat(account, { model, messages, chatId, newChat });
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let output = "";
    let first = false;

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      if (anthropicMode) res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: `msg_${uuid()}`, type: "message", role: "assistant", model, content: [] } })}\n\n`);
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        let evt: any;
        try { evt = JSON.parse(l); } catch { continue; }
        if (evt.type !== "text-delta" || !evt.text) continue;
        if (!first) {
          first = true;
          stats[backend].totalTtftMs += Date.now() - t0;
          stats[backend].ttftCount += 1;
        }
        output += evt.text;
        if (!stream) continue;
        if (anthropicMode) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: evt.text } })}\n\n`);
        else res.write(`data: ${JSON.stringify({ id: `chatcmpl-${uuid()}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }], model })}\n\n`);
      }
    }

    const inTok = countWords(normalizeMessages(messages).map((m) => m.content).join(" "));
    const outTok = countWords(output);
    stats[backend].promptTokens += inTok;
    stats[backend].completionTokens += outTok;
    stats[backend].totalDurationMs += Date.now() - t0;

    if (stream) {
      if (anthropicMode) {
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: inTok, output_tokens: outTok } })}\n\n`);
        res.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      } else {
        res.write(`data: ${JSON.stringify({ id: `chatcmpl-${uuid()}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], model })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
      return res.end();
    }

    if (anthropicMode) return res.json({ id: `msg_${uuid()}`, type: "message", role: "assistant", model, content: [{ type: "text", text: output }], stop_reason: "end_turn", usage: { input_tokens: inTok, output_tokens: outTok } });
    return res.json({ id: `chatcmpl-${uuid()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }], usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok } });
  } catch (e: any) {
    stats[backend].errors += 1;
    stats[backend].totalDurationMs += Date.now() - t0;
    if (account) account.lastError = e?.message || "proxy error";
    return res.status(500).json({ error: { message: e?.message || "proxy error" } });
  }
}

app.post("/v1/chat/completions", auth, async (req, res) => {
  const model = req.body?.model;
  const messages = req.body?.messages || [];
  if (!model || !Array.isArray(messages)) return res.status(400).json({ error: { message: "invalid payload" } });
  return proxyNdjsonToOpenAI(req, res, "openai", !!req.body?.stream, model, messages, req.body?.chatId, false, !!req.body?.newChat);
});

app.post(["/anthropic/v1/messages", "/v1/messages"], auth, async (req, res) => {
  const model = req.body?.model;
  const messages = req.body?.messages || [];
  if (!model || !Array.isArray(messages)) return res.status(400).json({ error: { message: "invalid payload" } });
  return proxyNdjsonToOpenAI(req, res, "anthropic", !!req.body?.stream, model, messages, req.body?.metadata?.chatId, true, !!req.body?.metadata?.newChat);
});

app.post("/v1/images/generations", auth, async (req, res) => {
  let account: Account | null = null;
  try {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: { message: "prompt required" } });
    account = chooseAccount(String(req.body?.accountId || ""));
    const raw = await requestMagaiImage(account, {
      prompt,
      size: req.body?.size,
      quality: req.body?.quality,
      style: req.body?.style,
      background: req.body?.background,
      chatId: req.body?.chatId,
      accountId: req.body?.accountId,
    });
    const { urls, b64 } = extractImagePayload(raw);
    if (urls.length === 0 && !b64) throw new Error(`no image payload parsed from upstream response; raw=${raw.slice(0, 1200)}`);
    const n = Math.max(1, Math.min(Number(req.body?.n || 1), 4));
    const responseFormat = String(req.body?.response_format || "url");
    const resolvedB64 = b64 || (responseFormat === "b64_json" && urls[0]
      ? await (async () => {
          try {
            const imgResp = await fetch(urls[0]);
            if (!imgResp.ok) return "";
            const buf = Buffer.from(await imgResp.arrayBuffer());
            return buf.toString("base64");
          } catch {
            return "";
          }
        })()
      : "");
    const data = Array.from({ length: n }).map((_, idx) => {
      const url = urls[idx] || urls[0] || "";
      const entry: any = {};
      if (responseFormat === "b64_json") {
        entry.b64_json = resolvedB64 || "";
      } else {
        entry.url = url;
      }
      entry.revised_prompt = prompt;
      return entry;
    });
    return res.json({ created: Math.floor(Date.now() / 1000), data });
  } catch (e: any) {
    if (account) account.lastError = e?.message || "image proxy error";
    return res.status(500).json({ error: { message: e?.message || "image proxy error" } });
  }
});

// Background heartbeat: proactively refresh access_token for every enabled
// account, on a cadence shorter than the JWT TTL. Goals:
//  - Keep refresh_token "in use" so inactivity timeout never fires.
//  - Pre-warm the cache so user requests never pay refresh latency.
//  - Single-flight per account (refreshPromise dedup) avoids the dangerous
//    parallel-refresh-token-reuse window.
//
// Cadence: 50min default; tuneable via MAGAI_HEARTBEAT_INTERVAL_MS. Disable
// with MAGAI_HEARTBEAT_DISABLE=1.
const HEARTBEAT_INTERVAL_MS = Math.max(60_000, Number(process.env.MAGAI_HEARTBEAT_INTERVAL_MS || 50 * 60 * 1000));
const HEARTBEAT_DISABLED = process.env.MAGAI_HEARTBEAT_DISABLE === "1";

async function heartbeatTick() {
  const targets = accounts.filter((a) => a.enabled && (a.currentRefreshToken || (a.supabaseEmail && a.supabasePassword)));
  if (targets.length === 0) return;
  // Stagger refreshes a bit to avoid hammering Supabase in lockstep when many accounts share an upstream.
  const stride = Math.min(2_000, Math.floor(HEARTBEAT_INTERVAL_MS / Math.max(1, targets.length * 4)));
  for (let i = 0; i < targets.length; i++) {
    const a = targets[i];
    try {
      // Force renewal even if cached token still has runway: pretend it's expired.
      a.cachedSupabaseAccessExp = 0;
      await getSupabaseAccessToken(a);
    } catch (e) {
      a.lastError = `heartbeat: ${(e as Error)?.message || e}`;
      console.warn(`[heartbeat] ${a.name} (${a.id}) failed: ${a.lastError}`);
    }
    if (stride > 0 && i + 1 < targets.length) await new Promise((r) => setTimeout(r, stride));
  }
}

function startHeartbeat() {
  if (HEARTBEAT_DISABLED) {
    console.log("[heartbeat] disabled via MAGAI_HEARTBEAT_DISABLE=1");
    return;
  }
  // Kick off a first tick shortly after boot so a freshly-restarted proxy warms up
  // accounts even before any traffic arrives. Then run on the configured cadence.
  setTimeout(() => { heartbeatTick().catch(() => {}); }, 5_000);
  setInterval(() => { heartbeatTick().catch(() => {}); }, HEARTBEAT_INTERVAL_MS).unref?.();
  console.log(`[heartbeat] enabled; interval=${HEARTBEAT_INTERVAL_MS}ms`);
}

bootstrapAccounts();
bootstrapModelCatalog();
startHeartbeat();
app.listen(PORT, HOST, () => console.log(`magai proxy listening on ${HOST}:${PORT}; accounts=${accounts.length}; accountsFile=${ACCOUNTS_FILE}; modelCatalogFile=${MODEL_CATALOG_FILE}; env=${loadedEnvPath || "none"}`));
