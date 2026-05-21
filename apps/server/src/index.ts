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
const DEFAULT_MAGAI_CHAT_SNAPSHOT_ACTION = process.env.MAGAI_CHAT_SNAPSHOT_ACTION || "40a34afcf0167f40f2afa1b3ff5a65dc8451eac3a6";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(SCRIPT_DIR, "..");
const ACCOUNTS_FILE = process.env.MAGAI_ACCOUNTS_FILE || path.resolve(SERVER_DIR, "accounts.json");
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
  };

const stats: Record<"openai" | "anthropic", Stat> = {
  openai: { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, totalTtftMs: 0, ttftCount: 0 },
  anthropic: { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, totalTtftMs: 0, ttftCount: 0 },
};

let accounts: Account[] = [];

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
    lastError: a.lastError || "",
    lastUsedAt: a.lastUsedAt || 0,
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
    discovery: { models: [], ts: 0 },
    cachedMagaiJwt: "",
    cachedMagaiJwtExp: 0,
    cachedSupabaseAccessToken: "",
    cachedSupabaseAccessExp: 0,
    currentRefreshToken: (input.supabaseRefreshToken || "").trim(),
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

function persistAccounts() {
  const dir = path.dirname(ACCOUNTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const serializable = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    magaiCookie: a.magaiCookie,
    supabaseRefreshToken: a.currentRefreshToken || a.supabaseRefreshToken,
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
    magaiModelCatalogJson: a.magaiModelCatalogJson || "",
    magaiAlwaysNewChat: !!a.magaiAlwaysNewChat,
  }));
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(serializable, null, 2), "utf8");
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

function loadConfiguredModelCatalog(account: Account) {
  if (!account.magaiModelCatalogJson) return [] as DiscoveredModel[];
  try {
    const parsed = JSON.parse(account.magaiModelCatalogJson) as any[];
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

function getKnownModels(account: Account) {
  const byId = new Map<string, DiscoveredModel>();
  for (const m of loadConfiguredModelCatalog(account)) upsertModel(byId, m.id, m.name, m.apiName);
  if (byId.size === 0 && account.magaiDefaultModelId) {
    const name = account.magaiDefaultModelName || DEFAULT_MAGAI_DEFAULT_MODEL_NAME;
    upsertModel(byId, account.magaiDefaultModelId, name, account.magaiDefaultModelApiName || undefined);
  }
  return Array.from(byId.values());
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

async function getSupabaseAccessToken(account: Account) {
  const now = Math.floor(Date.now() / 1000);
  if (account.cachedSupabaseAccessToken && account.cachedSupabaseAccessExp - 30 > now) return account.cachedSupabaseAccessToken;
  if (!account.supabasePublishableKey || !account.currentRefreshToken) throw new Error("supabase credentials not configured");
  const resp = await fetch(`${account.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: account.supabasePublishableKey,
      authorization: `Bearer ${account.supabasePublishableKey}`,
    },
    body: JSON.stringify({ refresh_token: account.currentRefreshToken }),
  });
  if (!resp.ok) throw new Error(`refresh token failed: ${resp.status}`);
  const data = (await resp.json()) as any;
  account.cachedSupabaseAccessToken = data.access_token;
  account.cachedSupabaseAccessExp = Number(data.expires_at || decodeJwtExp(data.access_token));
  if (data.refresh_token) {
    account.currentRefreshToken = data.refresh_token;
    account.supabaseRefreshToken = data.refresh_token;
    persistAccounts();
  }
  return account.cachedSupabaseAccessToken;
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
  account.discovery.models = getKnownModels(account);
  account.discovery.ts = now;
}

function requireDiscoveredModel(account: Account, inputModel: string) {
  const known = getKnownModels(account);
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
  const resolvedModel = requireDiscoveredModel(account, input.model);
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

app.get("/health", (_req, res) => res.json({ ok: true, accountCount: accounts.length, enabledCount: accounts.filter((a) => a.enabled).length }));
app.get("/v1/accounts", auth, (_req, res) => res.json({ object: "list", data: accounts.map(scrubAccount), rrPointer }));
app.post("/v1/accounts/import", auth, (req, res) => {
  const raw = req.body?.accounts;
  if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: { message: "accounts[] required" } });
  for (const item of raw) {
    const account = makeAccount(item || {});
    if (!account.magaiCookie || !account.supabaseRefreshToken) continue;
    const idx = accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) accounts[idx] = { ...accounts[idx], ...account, discovery: { models: [], ts: 0 }, cachedMagaiJwt: "", cachedMagaiJwtExp: 0, cachedSupabaseAccessToken: "", cachedSupabaseAccessExp: 0, currentRefreshToken: account.supabaseRefreshToken };
    else accounts.push(account);
  }
  persistAccounts();
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
  const account = chooseAccount(String(req.body?.accountId || ""));
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
  account.magaiModelCatalogJson = JSON.stringify(normalized);
  account.discovery.models = getKnownModels(account);
  account.discovery.ts = Date.now();
  persistAccounts();
  return res.json({ ok: true, accountId: account.id, count: account.discovery.models.length, data: account.discovery.models });
});

app.get("/v1/models", auth, async (req, res) => {
  try {
    const account = chooseAccount(String(req.query.accountId || ""));
    account.discovery.models = getKnownModels(account);
    return res.json({
      object: "list",
      accountId: account.id,
      data: account.discovery.models.map((m) => ({ id: m.alias, object: "model", owned_by: "magai-proxy", meta: { magaiModelId: m.id, magaiModelName: m.name, magaiModelApiName: m.apiName || "" } })),
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

bootstrapAccounts();
app.listen(PORT, () => console.log(`magai proxy listening on :${PORT}; accounts=${accounts.length}; file=${ACCOUNTS_FILE}; env=${loadedEnvPath || "none"}`));
