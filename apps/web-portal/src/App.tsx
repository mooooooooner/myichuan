import { useCallback, useEffect, useMemo, useState } from "react";

type Account = {
  id: string;
  name: string;
  enabled: boolean;
  hasCookie: boolean;
  hasRefreshToken: boolean;
  lastError: string;
  lastUsedAt: number;
  discovery: { chatId: string; userId: string; modelCount: number; ts: number };
};

async function req(url: string, apiKey: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function ago(ts: number) {
  if (!ts) return "never";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rrPointer, setRrPointer] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [jsonText, setJsonText] = useState("[");
  const [keyInput, setKeyInput] = useState(localStorage.getItem("proxy_api_key") || "test-key");

  const enabledCount = useMemo(() => accounts.filter((a) => a.enabled).length, [accounts]);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await req("/v1/accounts", keyInput);
      setAccounts(data.data || []);
      setRrPointer(Number(data.rrPointer || 0));
    } catch (e: any) {
      setError(e.message || "load failed");
    } finally {
      setLoading(false);
    }
  }, [keyInput]);

  async function doImport() {
    try {
      const parsed = JSON.parse(jsonText);
      await req("/v1/accounts/import", keyInput, { method: "POST", body: JSON.stringify({ accounts: parsed }) });
      await loadAccounts();
    } catch (e: any) {
      setError(e.message || "import failed");
    }
  }

  async function toggle(id: string, enabled: boolean) {
    await req(`/v1/accounts/${id}`, keyInput, { method: "PATCH", body: JSON.stringify({ enabled }) });
    await loadAccounts();
  }

  async function remove(id: string) {
    await req(`/v1/accounts/${id}`, keyInput, { method: "DELETE" });
    await loadAccounts();
  }

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  return (
    <main className="portal-shell mx-auto max-w-6xl px-5 py-8 md:px-8 md:py-12">
      <section className="panel reveal overflow-hidden rounded-[2rem] p-8 md:p-10">
        <p className="text-xs uppercase tracking-[0.35em] text-slate-400">CTF Control Portal</p>
        <h1 className="hero-title mt-3 text-5xl text-white md:text-7xl">Multi-Account Proxy Ops</h1>
        <p className="mt-5 max-w-3xl text-base text-slate-300 md:text-lg">A tactical dark-mode command layer for Magai relay. Import credentials, operate round-robin scheduling, and keep every account visible under pressure.</p>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="inset-line lift rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Total Accounts</p>
            <p className="kpi-num mt-2 text-3xl text-white">{accounts.length}</p>
          </div>
          <div className="inset-line lift rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Enabled Pool</p>
            <p className="kpi-num mt-2 text-3xl text-emerald-300">{enabledCount}</p>
          </div>
          <div className="inset-line lift rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Round Robin Cursor</p>
            <p className="kpi-num mt-2 text-3xl text-blue-300">{rrPointer}</p>
          </div>
        </div>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="panel reveal rounded-3xl p-6">
          <h2 className="text-2xl text-white">Proxy API Key</h2>
          <p className="mt-1 text-sm text-slate-400">Auth is applied as Bearer token for all management requests.</p>
          <input
            className="mt-4 w-full rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none transition focus:border-emerald-300/60"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="PROXY_API_KEY"
          />
          <button
            className="mt-4 rounded-xl border border-emerald-300/50 bg-emerald-300/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200"
            onClick={() => {
              localStorage.setItem("proxy_api_key", keyInput);
              loadAccounts();
            }}
          >
            Save & Refresh
          </button>
        </div>

        <div className="panel reveal rounded-3xl p-6">
          <h2 className="text-2xl text-white">Import Credentials</h2>
          <p className="mt-1 text-sm text-slate-400">Paste exported accounts JSON and ingest into the rotation pool.</p>
          <textarea
            className="mt-4 h-48 w-full rounded-xl border border-slate-600/50 bg-slate-950/70 p-4 font-mono text-xs text-slate-100 outline-none transition focus:border-blue-300/60"
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
          <button className="mt-4 rounded-xl border border-blue-300/50 bg-blue-400/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-blue-300" onClick={doImport}>
            Import Now
          </button>
        </div>
      </section>

      <section className="panel reveal mt-6 rounded-3xl p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-2xl text-white">Account Pool</h2>
          <button className="rounded-xl border border-slate-500/60 px-3 py-2 text-xs uppercase tracking-[0.16em] text-slate-200 transition hover:border-slate-300" onClick={loadAccounts}>
            {loading ? "Loading" : "Refresh"}
          </button>
        </div>

        {error ? <p className="mt-3 rounded-lg border border-rose-300/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

        <div className="mt-4 grid gap-3">
          {accounts.map((a) => (
            <article key={a.id} className="inset-line lift rounded-2xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xl text-white">{a.name}</p>
                  <p className="mt-1 font-mono text-xs text-slate-400">{a.id}</p>
                  <p className="mt-2 text-xs uppercase tracking-[0.14em] text-slate-400">last used {ago(a.lastUsedAt)}</p>
                </div>
                <div className="flex gap-2">
                  <button className="rounded-lg border border-slate-500/50 px-3 py-1 text-xs text-slate-100 transition hover:border-emerald-300/60" onClick={() => toggle(a.id, !a.enabled)}>
                    {a.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="rounded-lg border border-rose-400/50 px-3 py-1 text-xs text-rose-200 transition hover:bg-rose-500/10" onClick={() => remove(a.id)}>
                    Delete
                  </button>
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-300">
                cookie: {a.hasCookie ? "ok" : "missing"} | refresh: {a.hasRefreshToken ? "ok" : "missing"} | models: {a.discovery.modelCount} | chatId: {a.discovery.chatId || "-"}
              </p>
              <p className="mt-1 text-xs text-slate-400">lastError: {a.lastError || "none"}</p>
            </article>
          ))}
          {accounts.length === 0 ? <p className="rounded-xl border border-slate-700/60 bg-slate-950/45 p-4 text-slate-400">No accounts loaded. Save API key and import credentials JSON.</p> : null}
        </div>
      </section>
    </main>
  );
}
