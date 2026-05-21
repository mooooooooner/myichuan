import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "apps/server/.env"),
  path.resolve(process.cwd(), "../.env"),
];
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    loadEnv({ path: p, override: false });
    break;
  }
}

const MAGAI_BASE_URL = process.env.MAGAI_BASE_URL || "https://beta.magai.co";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://bkatrpghmzbpjhegvkev.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_abLi4B3uk35xfTdT1d5Z1g_QVGG3JNo";
const FALLBACK_MAGAI_COOKIE = process.env.MAGAI_COOKIE || "";
const SIGNUP_PATH = process.env.MAGAI_SIGNUP_PATH || "/signup/epa2026";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(SCRIPT_DIR, "..");
const ACCOUNTS_FILE = process.env.MAGAI_ACCOUNTS_FILE || path.resolve(SERVER_DIR, "accounts.json");
const REGISTER_LOG_FILE = process.env.MAGAI_REGISTER_LOG || path.resolve(SERVER_DIR, "registered.json");

// next-action ids captured from the signup flow (regist.txt)
const ACTION_SIGNUP_PREFLIGHT = process.env.MAGAI_ACTION_SIGNUP_PREFLIGHT || "407e2e7eb950201c0032f365753bf0b860169827a5";
const ACTION_SIGNUP_CHECK_EMAIL = process.env.MAGAI_ACTION_SIGNUP_CHECK_EMAIL || "40317846773f2010fd81d02ffddf31efd9865d0c2d";
const ACTION_SIGNUP_CREATE = process.env.MAGAI_ACTION_SIGNUP_CREATE || "60f8e7ce01523ba5fe421581b0024317112b5932d6";
const ACTION_USER_BOOT = process.env.MAGAI_ACTION_USER_BOOT || "40cbd974183faa52e2144ec0b986569236625fd5ff";
const ACTION_NEXT_TOKEN = process.env.MAGAI_NEXT_ACTION || "40cd8b2ec4704e0f3c267bd98f93b0f9806e121b77";

const ROUTER_STATE_TREE = `["",{"children":[["path","chat","oc",null],{"children":["__PAGE__",{},null,null,0]},null,null,0]},null,null,16]`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0";

// Chrome-built referer for the signup page; the upstream gate verifies origin/referer.
const SIGNUP_REFERER = `${MAGAI_BASE_URL}${SIGNUP_PATH}`;

type RegisterResult = {
  email: string;
  password: string;
  ok: boolean;
  step?: string;
  error?: string;
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
  cookie?: string;
  registeredAt: number;
};

function rand(len = 8) {
  const alpha = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < len; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
  return s;
}
function randDigits(len = 4) {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}
function genEmail(domain = "outlook.com", prefix = "frank") {
  return `${prefix}${randDigits(4)}${rand(3)}@${domain}`;
}
function genPassword() {
  return `${rand(4)}${randDigits(3)}`;
}
function uuid() {
  return crypto.randomUUID();
}
function decodeJwtPayload(jwt: string): any {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: "text/x-component",
    "accept-language": "zh-CN,zh;q=0.9",
    "cache-control": "no-cache",
    "content-type": "text/plain;charset=UTF-8",
    "next-router-state-tree": ROUTER_STATE_TREE,
    origin: MAGAI_BASE_URL,
    pragma: "no-cache",
    priority: "u=1, i",
    referer: SIGNUP_REFERER,
    "sec-ch-ua": `"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"Windows"`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": UA,
    ...extra,
  };
}

// Extracts Set-Cookie -> "k=v; k2=v2" suitable for re-sending as Cookie.
function extractCookies(resp: Response, prev = ""): string {
  // node fetch exposes raw via getSetCookie() in undici / node 20+
  const anyHeaders = resp.headers as any;
  const setList: string[] = typeof anyHeaders.getSetCookie === "function" ? anyHeaders.getSetCookie() : [];
  const map = new Map<string, string>();
  if (prev) {
    for (const part of prev.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k) map.set(k, rest.join("="));
    }
  }
  for (const raw of setList) {
    const first = raw.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function callNextAction(actionId: string, body: string, cookie: string, accessToken?: string) {
  const headers = baseHeaders({
    "next-action": actionId,
    cookie,
  });
  if (accessToken) {
    (headers as any).apikey = SUPABASE_PUBLISHABLE_KEY;
    (headers as any).authorization = `Bearer ${accessToken}`;
  }
  const resp = await fetch(`${MAGAI_BASE_URL}/chat`, {
    method: "POST",
    headers,
    body,
  });
  const text = await resp.text();
  return { resp, text };
}

// Some next-action responses include a JSON-tagged "0:{...}" line; we surface known error markers.
function detectActionError(text: string): string | null {
  if (!text) return "empty response";
  // Very loose pattern; refine if upstream changes.
  if (/"error"\s*:\s*"([^"]+)"/.test(text)) return RegExp.$1;
  if (/already.*registered/i.test(text)) return "email already registered";
  if (/invalid.*email/i.test(text)) return "invalid email";
  if (/rate.?limit/i.test(text)) return "rate limited";
  return null;
}

async function passwordSignIn(email: string, password: string) {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      accept: "*/*",
      "accept-language": "zh-CN,zh;q=0.9",
      apikey: SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      "cache-control": "no-cache",
      "content-type": "application/json;charset=UTF-8",
      origin: MAGAI_BASE_URL,
      pragma: "no-cache",
      referer: `${MAGAI_BASE_URL}/`,
      "user-agent": UA,
      "x-client-info": "supabase-js-web/2.74.0",
      "x-supabase-api-version": "2024-01-01",
    },
    body: JSON.stringify({ email, password, gotrue_meta_security: {} }),
  });
  const data = (await resp.json().catch(() => null)) as any;
  if (!resp.ok || !data?.access_token) {
    throw new Error(`password signin failed: ${resp.status} ${JSON.stringify(data)}`);
  }
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    userId: data.user?.id || decodeJwtPayload(data.access_token)?.sub,
  };
}

async function registerOne(email?: string, password?: string): Promise<RegisterResult> {
  const finalEmail = (email || genEmail()).toLowerCase();
  const finalPassword = password || genPassword();
  const startedAt = Date.now();
  let cookie = ""; // accumulates Set-Cookie across hops

  try {
    // Step 1: signup preflight (action with email+password)
    {
      const body = JSON.stringify([{ email: finalEmail, password: finalPassword }]);
      const { resp, text } = await callNextAction(ACTION_SIGNUP_PREFLIGHT, body, cookie);
      cookie = extractCookies(resp, cookie);
      const err = detectActionError(text);
      if (!resp.ok) throw new Error(`preflight HTTP ${resp.status}: ${text.slice(0, 200)}`);
      if (err) throw new Error(`preflight: ${err}`);
    }

    // Step 2: email availability check
    {
      const body = JSON.stringify([finalEmail]);
      const { resp, text } = await callNextAction(ACTION_SIGNUP_CHECK_EMAIL, body, cookie);
      cookie = extractCookies(resp, cookie);
      const err = detectActionError(text);
      if (!resp.ok) throw new Error(`check-email HTTP ${resp.status}: ${text.slice(0, 200)}`);
      if (err) throw new Error(`check-email: ${err}`);
    }

    // Step 3: actual create user
    {
      const body = JSON.stringify([finalEmail, finalPassword]);
      const { resp, text } = await callNextAction(ACTION_SIGNUP_CREATE, body, cookie);
      cookie = extractCookies(resp, cookie);
      const err = detectActionError(text);
      if (!resp.ok) throw new Error(`create HTTP ${resp.status}: ${text.slice(0, 200)}`);
      if (err) throw new Error(`create: ${err}`);
    }

    // Step 4: password sign-in to obtain refresh_token + access_token
    const { accessToken, refreshToken, userId } = await passwordSignIn(finalEmail, finalPassword);

    // Step 5 (optional but matches captured flow): warm up user state via next-action to ensure cookie is valid
    try {
      await callNextAction(ACTION_USER_BOOT, JSON.stringify([userId]), cookie, accessToken);
      const { resp: r2 } = await callNextAction(ACTION_NEXT_TOKEN, JSON.stringify([userId]), cookie, accessToken);
      cookie = extractCookies(r2, cookie);
    } catch {
      // best-effort; the credentials from step 4 are already enough for the proxy to use
    }

    return {
      email: finalEmail,
      password: finalPassword,
      ok: true,
      userId,
      accessToken,
      refreshToken,
      cookie,
      registeredAt: startedAt,
    };
  } catch (e: any) {
    return {
      email: finalEmail,
      password: finalPassword,
      ok: false,
      error: e?.message || String(e),
      registeredAt: startedAt,
    };
  }
}

function appendLog(entry: RegisterResult) {
  const dir = path.dirname(REGISTER_LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing: RegisterResult[] = fs.existsSync(REGISTER_LOG_FILE)
    ? (() => {
        try {
          return JSON.parse(fs.readFileSync(REGISTER_LOG_FILE, "utf8")) as RegisterResult[];
        } catch {
          return [];
        }
      })()
    : [];
  existing.push(entry);
  fs.writeFileSync(REGISTER_LOG_FILE, JSON.stringify(existing, null, 2), "utf8");
}

function mergeIntoAccountsFile(entries: RegisterResult[]) {
  const ok = entries.filter((e) => e.ok && e.refreshToken);
  if (ok.length === 0) return;
  const dir = path.dirname(ACCOUNTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing: any[] = fs.existsSync(ACCOUNTS_FILE)
    ? (() => {
        try {
          const v = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      })()
    : [];
  for (const r of ok) {
    const id = `auto-${r.email.replace(/[^a-z0-9]+/g, "-")}-${r.registeredAt}`;
    if (existing.some((a) => a.supabaseRefreshToken === r.refreshToken)) continue;
    existing.push({
      id,
      name: r.email,
      enabled: true,
      magaiCookie: r.cookie || FALLBACK_MAGAI_COOKIE,
      supabaseRefreshToken: r.refreshToken,
    });
  }
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(existing, null, 2), "utf8");
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = "true";
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const count = Math.max(1, Math.min(500, Number(args.count || args.n || 1)));
  const concurrency = Math.max(1, Math.min(8, Number(args.concurrency || args.c || 1)));
  const delayMs = Math.max(0, Number(args.delay || 800));
  const domain = args.domain || "outlook.com";
  const prefix = args.prefix || "frank";
  const fixedEmail = args.email;
  const fixedPassword = args.password;
  const dryRun = args["dry-run"] === "true";
  const exportPath = args.export || "";
  const skipMerge = args["skip-merge"] === "true";

  console.log(`[register] count=${count} concurrency=${concurrency} domain=${domain} prefix=${prefix}`);
  if (dryRun) {
    console.log(`[register] dry-run sample:`, { email: genEmail(domain, prefix), password: genPassword() });
    return;
  }

  const results: RegisterResult[] = [];
  let nextIdx = 0;
  async function worker(workerId: number) {
    while (true) {
      const idx = nextIdx++;
      if (idx >= count) return;
      const email = fixedEmail && count === 1 ? fixedEmail : genEmail(domain, prefix);
      const password = fixedPassword && count === 1 ? fixedPassword : genPassword();
      const r = await registerOne(email, password);
      results.push(r);
      appendLog(r);
      const tag = r.ok ? "OK " : "ERR";
      const detail = r.ok
        ? `userId=${r.userId} refresh=${(r.refreshToken || "").slice(0, 12)}...`
        : `${r.error}`;
      console.log(`[register][w${workerId}][${idx + 1}/${count}] ${tag} ${r.email} :: ${detail}`);
      if (delayMs > 0 && idx + 1 < count) await sleep(delayMs);
    }
  }
  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const okCount = results.filter((r) => r.ok).length;
  console.log(`[register] done: ok=${okCount} fail=${results.length - okCount}`);

  // Build the canonical pool entry shape (matches /v1/accounts/import body and accounts.json schema)
  const poolEntries = results
    .filter((r) => r.ok && r.refreshToken)
    .map((r) => ({
      id: `auto-${r.email.replace(/[^a-z0-9]+/g, "-")}-${r.registeredAt}`,
      name: r.email,
      enabled: true,
      magaiCookie: r.cookie || FALLBACK_MAGAI_COOKIE,
      supabaseRefreshToken: r.refreshToken!,
    }));

  if (exportPath) {
    const dir = path.dirname(path.resolve(exportPath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(exportPath, JSON.stringify(poolEntries, null, 2), "utf8");
    console.log(`[register] export -> ${exportPath} (${poolEntries.length} entries; feed to /v1/accounts/import or web-portal)`);
  }

  if (!skipMerge) {
    mergeIntoAccountsFile(results);
    console.log(`[register] accounts merged -> ${ACCOUNTS_FILE}`);
  }
  console.log(`[register] log -> ${REGISTER_LOG_FILE}`);
}

main().catch((e) => {
  console.error("[register] fatal:", e);
  process.exit(1);
});
