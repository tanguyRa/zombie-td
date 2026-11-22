import { defineConfig } from "vite";

// COOP/COEP make the page cross-origin isolated, which enables SharedArrayBuffer.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: {
    headers: isolation,
    fs: { allow: [".."] }, // levels/ and config.default.json live in the repo root
    watch: { usePolling: true, interval: 300 }, // file events don't cross the Docker mount
  },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022" },
});
