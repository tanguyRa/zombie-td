import { defineConfig } from "vite";

// COOP/COEP make the page cross-origin isolated, which enables SharedArrayBuffer.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// ZT_E2E=1 (the Playwright web server): no file watching and no HMR, so a
// test page is never reloaded under a running test. Without this, any write
// under web/ (a `npm run wasm` from another Playwright run or run-all.sh
// rewrites src/wasm/pkg even when nothing changed, an edit in src/) made
// Vite reload every open page: the match in progress and `window.__zt` gone.
const e2e = process.env.ZT_E2E === "1";

export default defineConfig({
  server: {
    headers: isolation,
    fs: { allow: [".."] }, // levels/ and config.default.json live in the repo root
    // File events don't cross the Docker mount: poll.
    watch: e2e ? null : { usePolling: true, interval: 300 },
    hmr: !e2e,
  },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022" },
});
