import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxy = {
  "/v1": "http://127.0.0.1:8787",
  "/health": "http://127.0.0.1:8787",
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
