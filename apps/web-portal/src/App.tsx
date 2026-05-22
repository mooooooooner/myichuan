import { useCallback, useEffect, useMemo, useState } from "react";

type Account = {
  id: string;
  name: string;
  enabled: boolean;
  hasCookie: boolean;
  hasRefreshToken: boolean;
  hasPassword: boolean;
  supabaseEmail: string;
  lastError: string;
  lastUsedAt: number;
  lastRefreshAt: number;
  discovery: { chatId: string; userId: string; modelCount: number; ts: number };
};

type ModelItem = {
  id: string;
  object: string;
  owned_by: string;
  meta?: { magaiModelId?: string; magaiModelName?: string; magaiModelApiName?: string };
};

type ImageOutput = { url?: string; b64_json?: string; revised_prompt?: string };

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
  const [modelsJsonText, setModelsJsonText] = useState(
    JSON.stringify(
      [
        {
          id: "16c133bc-bab9-41af-b3d4-08dd9157dbca",
          name: "Claude Sonnet 4.6",
          apiName: "anthropic/claude-4.6-sonnet-20260217",
        },
      ],
      null,
      2,
    ),
  );
  const [keyInput, setKeyInput] = useState(localStorage.getItem("proxy_api_key") || "");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState("");
  const [models, setModels] = useState<ModelItem[]>([]);
  const [prompt, setPrompt] = useState("A cinematic night street in Shanghai, rain reflections, ultra detailed.");
  const [imageModel, setImageModel] = useState("claude-sonnet-4-6");
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("hd");
  const [style, setStyle] = useState("vivid");
  const [responseFormat, setResponseFormat] = useState("url");
  const [n, setN] = useState(1);
  const [imageAccountId, setImageAccountId] = useState("");
  const [imageChatId, setImageChatId] = useState("");
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState("");
  const [imageOutputs, setImageOutputs] = useState<ImageOutput[]>([]);

  const enabledCount = useMemo(() => accounts.filter((a) => a.enabled).length, [accounts]);

  const loadAccounts = useCallback(async () => {
    if (!authed) return;
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
  }, [authed, keyInput]);

  const loadModels = useCallback(async () => {
    if (!authed) return;
    try {
      const data = await req("/v1/models", keyInput);
      const list = Array.isArray(data.data) ? data.data : [];
      setModels(list);
      if (list.length > 0) setImageModel(list[0].id);
    } catch {
      setModels([]);
    }
  }, [authed, keyInput]);

  async function login() {
    setAuthError("");
    setError("");
    const key = keyInput.trim();
    if (!key) {
      setAuthError("PROXY_API_KEY is required");
      return;
    }
    try {
      const data = await req("/v1/accounts", key);
      localStorage.setItem("proxy_api_key", key);
      setAuthed(true);
      setAccounts(data.data || []);
      setRrPointer(Number(data.rrPointer || 0));
      await loadModels();
    } catch (e: any) {
      setAuthed(false);
      setAuthError(e.message || "authentication failed");
    }
  }

  async function doImport() {
    try {
      const parsed = JSON.parse(jsonText);
      await req("/v1/accounts/import", keyInput, { method: "POST", body: JSON.stringify({ accounts: parsed }) });
      await loadAccounts();
    } catch (e: any) {
      setError(e.message || "import failed");
    }
  }

  async function doImportModels() {
    try {
      const parsed = JSON.parse(modelsJsonText);
      await req("/v1/models/import", keyInput, { method: "POST", body: JSON.stringify({ models: parsed }) });
      await loadAccounts();
      await loadModels();
    } catch (e: any) {
      setError(e.message || "model import failed");
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

  async function generateImage() {
    setImageLoading(true);
    setImageError("");
    setImageOutputs([]);
    try {
      const body: Record<string, any> = {
        model: imageModel,
        prompt,
        size,
        quality,
        style,
        n,
        response_format: responseFormat,
      };
      if (imageAccountId.trim()) body.accountId = imageAccountId.trim();
      if (imageChatId.trim()) body.chatId = imageChatId.trim();
      const data = await req("/v1/images/generations", keyInput, { method: "POST", body: JSON.stringify(body) });
      setImageOutputs(Array.isArray(data.data) ? data.data : []);
    } catch (e: any) {
      setImageError(e.message || "image generation failed");
    } finally {
      setImageLoading(false);
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem("proxy_api_key") || "";
    if (saved) {
      setKeyInput(saved);
      setAuthed(true);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    loadAccounts();
    loadModels();
  }, [authed, loadAccounts, loadModels]);

  return (
    <main className="portal-shell mx-auto max-w-7xl px-5 py-8 md:px-8 md:py-12">
      <section className="panel reveal overflow-hidden rounded-[2rem] p-8 md:p-10">
        <p className="text-xs uppercase tracking-[0.35em] text-slate-400">Magai Proxy Control</p>
        <h1 className="hero-title mt-3 text-5xl text-white md:text-7xl">Text + Image Ops Deck</h1>
        <p className="mt-5 max-w-3xl text-base text-slate-300 md:text-lg">Unify account rotation, model ingestion, and image generation in one operational board with direct OpenAI-compatible calls.</p>
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

      <section className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <div className="panel reveal rounded-3xl p-6">
            <h2 className="text-2xl text-white">Proxy API Key</h2>
            <input className="mt-4 w-full rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none transition focus:border-emerald-300/60" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="PROXY_API_KEY" />
            <button className="mt-4 rounded-xl border border-emerald-300/50 bg-emerald-300/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200" onClick={login}>
              {authed ? "Re-Login & Refresh" : "Login"}
            </button>
            {authError ? <p className="mt-3 rounded-lg border border-rose-300/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{authError}</p> : null}
          </div>

          <div className="panel reveal rounded-3xl p-6">
            <h2 className="text-2xl text-white">Import Credentials</h2>
            <textarea className="mt-4 h-40 w-full rounded-xl border border-slate-600/50 bg-slate-950/70 p-4 font-mono text-xs text-slate-100 outline-none transition focus:border-blue-300/60" value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
            <button className="mt-4 rounded-xl border border-blue-300/50 bg-blue-400/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-blue-300" onClick={doImport}>Import Now</button>
          </div>

          <div className="panel reveal rounded-3xl p-6">
            <h2 className="text-2xl text-white">Import Known Models</h2>
            <textarea className="mt-4 h-44 w-full rounded-xl border border-slate-600/50 bg-slate-950/70 p-4 font-mono text-xs text-slate-100 outline-none transition focus:border-fuchsia-300/60" value={modelsJsonText} onChange={(e) => setModelsJsonText(e.target.value)} />
            <button className="mt-4 rounded-xl border border-fuchsia-300/50 bg-fuchsia-300/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-fuchsia-200" onClick={doImportModels}>Import Models</button>
          </div>
        </div>

        <div className="panel reveal rounded-3xl p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-2xl text-white">Image Studio</h2>
            <button className="rounded-xl border border-slate-500/60 px-3 py-2 text-xs uppercase tracking-[0.16em] text-slate-200 transition hover:border-slate-300" onClick={loadModels}>Refresh Models</button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <select className="rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" value={imageModel} onChange={(e) => setImageModel(e.target.value)}>
              {(models.length > 0 ? models : [{ id: "claude-sonnet-4-6", object: "model", owned_by: "local" }]).map((m) => <option key={m.id} value={m.id}>{m.meta?.magaiModelName || m.id}</option>)}
            </select>
            <select className="rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" value={size} onChange={(e) => setSize(e.target.value)}>
              <option value="1024x1024">1024x1024</option><option value="1024x1536">1024x1536</option><option value="1536x1024">1536x1024</option><option value="1024x1792">1024x1792</option><option value="1792x1024">1792x1024</option>
            </select>
            <select className="rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" value={quality} onChange={(e) => setQuality(e.target.value)}>
              <option value="standard">standard</option><option value="hd">hd</option>
            </select>
            <select className="rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" value={style} onChange={(e) => setStyle(e.target.value)}>
              <option value="vivid">vivid</option><option value="natural">natural</option>
            </select>
            <select className="rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" value={responseFormat} onChange={(e) => setResponseFormat(e.target.value)}>
              <option value="url">url</option><option value="b64_json">b64_json</option>
            </select>
            <input className="rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" type="number" min={1} max={4} value={n} onChange={(e) => setN(Math.max(1, Math.min(4, Number(e.target.value) || 1)))} />
            <input className="rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 font-mono text-xs text-slate-100 outline-none md:col-span-2" value={imageAccountId} onChange={(e) => setImageAccountId(e.target.value)} placeholder="accountId (optional)" />
            <input className="rounded-xl border border-slate-600/50 bg-slate-950/70 px-4 py-3 font-mono text-xs text-slate-100 outline-none md:col-span-2" value={imageChatId} onChange={(e) => setImageChatId(e.target.value)} placeholder="chatId (optional)" />
          </div>
          <textarea className="mt-3 h-24 w-full rounded-xl border border-slate-600/50 bg-slate-950/70 p-4 text-sm text-slate-100 outline-none" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <button className="mt-4 rounded-xl border border-amber-300/50 bg-amber-300/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-200" onClick={generateImage} disabled={imageLoading}>
            {imageLoading ? "Generating..." : "Generate Image"}
          </button>
          {imageError ? <p className="mt-3 rounded-lg border border-rose-300/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{imageError}</p> : null}
          {imageOutputs.length > 0 ? (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {imageOutputs.map((it, idx) => {
                const src = it.url || (it.b64_json ? `data:image/png;base64,${it.b64_json}` : "");
                return (
                  <article key={`${idx}-${src.slice(0, 40)}`} className="inset-line rounded-2xl p-3">
                    {src ? <img src={src} alt={`generated-${idx + 1}`} className="h-auto w-full rounded-xl object-cover" /> : <p className="text-xs text-slate-400">No renderable image payload.</p>}
                    <p className="mt-2 text-xs text-slate-300">{it.revised_prompt || prompt}</p>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel reveal mt-6 rounded-3xl p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-2xl text-white">Account Pool</h2>
          <button className="rounded-xl border border-slate-500/60 px-3 py-2 text-xs uppercase tracking-[0.16em] text-slate-200 transition hover:border-slate-300" onClick={loadAccounts}>{loading ? "Loading" : "Refresh"}</button>
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
                  <button className="rounded-lg border border-slate-500/50 px-3 py-1 text-xs text-slate-100 transition hover:border-emerald-300/60" onClick={() => toggle(a.id, !a.enabled)}>{a.enabled ? "Disable" : "Enable"}</button>
                  <button className="rounded-lg border border-rose-400/50 px-3 py-1 text-xs text-rose-200 transition hover:bg-rose-500/10" onClick={() => remove(a.id)}>Delete</button>
                </div>
              </div>
              <p className="mt-3 text-xs text-slate-300">cookie: {a.hasCookie ? "ok" : "missing"} | refresh: {a.hasRefreshToken ? "ok" : "missing"} | password: {a.hasPassword ? "ok" : "missing"} | models: {a.discovery.modelCount} | chatId: {a.discovery.chatId || "-"}</p>
              <p className="mt-1 text-xs text-slate-400">email: {a.supabaseEmail || "-"} | last refresh: {ago(a.lastRefreshAt)}</p>
              <p className="mt-1 text-xs text-slate-400">lastError: {a.lastError || "none"}</p>
            </article>
          ))}
          {accounts.length === 0 ? <p className="rounded-xl border border-slate-700/60 bg-slate-950/45 p-4 text-slate-400">No accounts loaded. Save API key and import credentials JSON.</p> : null}
        </div>
      </section>
    </main>
  );
}
