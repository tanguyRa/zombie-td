import { defineConfig, devices } from "@playwright/test";

// Browser end-to-end tests (`npm run e2e` or `npx playwright test`).
// The web server builds the WASM first, then serves the app with Vite on its
// own port, so tests can run while `npm run dev` is up on 5173.
// PW_PORT picks another port (e.g. for a second worktree running at the same
// time). The port must be free: `--strictPort` makes a busy port fail loudly,
// unless PW_REUSE=1 asks to reuse a server already running there (which then
// skips `npm run wasm`, so it may serve a stale build, and is a server
// that may still reload pages on file changes unless started with ZT_E2E=1).
const PORT = Number(process.env.PW_PORT ?? 5199);

export default defineConfig({
  testDir: "./e2e",
  // Default per-test budget; the full-match test sets its own (it plays 8 waves).
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // The match test plays a whole match; three browsers at once on a laptop is
  // fine, more workers mostly add CPU contention.
  workers: 3,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium", viewport: { width: 1280, height: 800 } } },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1280, height: 800 },
        // Headless Firefox on a GPU-less Linux (the Docker image) refuses
        // WebGL, which MapLibre needs. This pref plus MOZ_WEBGL_FORCE_EGL=1
        // (set in the Dockerfile) gives it Mesa's software renderer.
        launchOptions: { firefoxUserPrefs: { "webgl.force-enabled": true } },
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    // ZT_E2E=1: Vite without file watching or HMR (vite.config.ts), so
    // nothing written under web/ during a run reloads a test's page.
    command: `npm run wasm && npx vite --port ${PORT} --strictPort`,
    env: { ZT_E2E: "1" },
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !!process.env.PW_REUSE,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
