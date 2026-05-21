// One-shot utility: enrich accounts.json with supabaseEmail/supabasePassword
// fields by joining against registered.json. Safe to re-run; only fills empty
// fields, never overwrites existing values.
//
// Run: pnpm --filter @apps/server exec tsx src/backfill-credentials.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(SCRIPT_DIR, "..");
const ACCOUNTS_FILE = process.env.MAGAI_ACCOUNTS_FILE || path.resolve(SERVER_DIR, "accounts.json");
const REGISTER_LOG_FILE = process.env.MAGAI_REGISTER_LOG || path.resolve(SERVER_DIR, "registered.json");

type Account = {
  id?: string;
  name?: string;
  supabaseRefreshToken?: string;
  supabaseEmail?: string;
  supabasePassword?: string;
  [k: string]: any;
};

type RegisterEntry = {
  email?: string;
  password?: string;
  refreshToken?: string;
  ok?: boolean;
};

function readJson<T>(p: string, fallback: T): T {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

const accounts = readJson<Account[]>(ACCOUNTS_FILE, []);
const registered = readJson<RegisterEntry[]>(REGISTER_LOG_FILE, []);

if (!Array.isArray(accounts)) {
  console.error(`[backfill] ${ACCOUNTS_FILE} is not an array; aborting`);
  process.exit(1);
}

// Build lookup maps from registered.json
const byRefresh = new Map<string, RegisterEntry>();
const byEmail = new Map<string, RegisterEntry>();
for (const r of registered) {
  if (!r?.ok) continue;
  if (r.refreshToken) byRefresh.set(r.refreshToken, r);
  if (r.email) byEmail.set(r.email.toLowerCase(), r);
}

let filled = 0;
let skipped = 0;
let missing = 0;

for (const a of accounts) {
  if (a.supabaseEmail && a.supabasePassword) { skipped++; continue; }
  let hit: RegisterEntry | undefined;
  if (a.supabaseRefreshToken) hit = byRefresh.get(a.supabaseRefreshToken);
  if (!hit && a.name) hit = byEmail.get(String(a.name).toLowerCase());
  if (!hit && a.supabaseEmail) hit = byEmail.get(String(a.supabaseEmail).toLowerCase());
  if (!hit) { missing++; continue; }
  if (!a.supabaseEmail && hit.email) a.supabaseEmail = hit.email;
  if (!a.supabasePassword && hit.password) a.supabasePassword = hit.password;
  filled++;
}

const tmp = `${ACCOUNTS_FILE}.tmp.${process.pid}.${Date.now()}`;
fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2), "utf8");
fs.renameSync(tmp, ACCOUNTS_FILE);

console.log(`[backfill] filled=${filled} already=${skipped} no-match=${missing} total=${accounts.length}`);
console.log(`[backfill] wrote -> ${ACCOUNTS_FILE}`);
