// Shared Playwright fixture and helpers. Every test runs offline. Requests to the Vite
// server go through; the street-map style gets a blank local style (so
// MapLibre still loads and fires its events); everything else (tiles, fonts,
// Overpass, Nominatim, …) is aborted. Blocked URLs are recorded per test.
import { test as base, expect, type Page } from "@playwright/test";
import type { TestHook } from "../src/testhook";
import blankStyle from "./fixtures/style.json" with { type: "json" };

export const MAP_STYLE = /^https:\/\/tiles\.openfreemap\.org\/styles\//;

export const test = base.extend<{ blocked: string[] }>({
  blocked: async ({}, use) => {
    await use([]);
  },
  context: async ({ context, baseURL, blocked }, use) => {
    const local = new URL(baseURL!).origin;
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(local) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
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
