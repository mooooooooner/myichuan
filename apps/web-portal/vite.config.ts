import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function readServerEnv() {
  const envPath = path.resolve(process.cwd(), "apps/server/.env");
  const out: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i <= 0) continue;
    const k = trimmed.slice(0, i).trim();
    const v = trimmed.slice(i + 1).trim();
    out[k] = v;
  }
  return out;
}

const serverEnv = readServerEnv();
const targetPort = Number(serverEnv.PORT || 8787);
const targetHostRaw = (serverEnv.HOST || "127.0.0.1").trim();
const targetHost = targetHostRaw === "0.0.0.0" ? "127.0.0.1" : targetHostRaw;
const proxyTarget = `http://${targetHost}:${targetPort}`;

const proxy = {
  "/v1": proxyTarget,
  "/health": proxyTarget,
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5174,
    proxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 5174,
    proxy,
  },
});

