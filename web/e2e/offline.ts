// Shared Playwright fixture and helpers. Every test runs offline. Requests to the Vite
// server go through; the street-map style gets a blank local style (so
// MapLibre still loads and fires its events); everything else (tiles, fonts,
// Overpass, Nominatim, …) is aborted. Every request URL and every aborted URL
// are recorded per test.
import { test as base, expect, type Page } from "@playwright/test";
import type { TestHook } from "../src/testhook";
import blankStyle from "./fixtures/style.json" with { type: "json" };

export const MAP_STYLE = /^https:\/\/tiles\.openfreemap\.org\/styles\//;

/** True for URLs served by the local test server (same origin), `data:` and `blob:`. */
export function isLocal(url: string, local: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return true;
  try {
    return new URL(url).origin === local;
  } catch {
    return false;
  }
}

export const test = base.extend<{ blocked: string[]; requests: string[]; local: string }>({
  blocked: async ({}, use) => {
    await use([]);
  },
  requests: async ({}, use) => {
    await use([]);
  },
  local: async ({ baseURL }, use) => {
    await use(new URL(baseURL!).origin);
  },
  context: async ({ context, local, blocked, requests }, use) => {
    context.on("request", (req) => requests.push(req.url()));
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (isLocal(url, local)) return route.continue();
      if (MAP_STYLE.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" },
          body: JSON.stringify(blankStyle),
        });
      }
      blocked.push(url);
      return route.abort("internetdisconnected");
    });
    await use(context);
  },
});

export { expect };

declare global {
  interface Window {
    __zt: TestHook;
  }
}

/** Runs `f(window.__zt)` in the page (`/?test=1`). The function is serialised,
 *  so it can only use its argument. */
export function hook<T>(page: Page, f: (h: TestHook) => T): Promise<T> {
  return page.evaluate(`(${f.toString()})(window.__zt)`) as Promise<T>;
}
