// Shared Playwright fixture and helpers. Every test runs offline. Requests to the Vite
// server go through; the street-map style gets a blank local style (so
// MapLibre still loads and fires its events); everything else (tiles, fonts,
// Overpass, Nominatim, …) is aborted. Every request and every request the
// router handled are recorded per test, and the fixture's teardown fails the
// test if any non-local request was neither answered locally nor aborted.
import { test as base, expect, type Page, type Request, type Route } from "@playwright/test";
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

/** Answer requests to `url` in the test (e.g. fixture Overpass responses).
 *  Registered on the context after the offline router, so it runs first;
 *  every request it sees counts as handled for the leak check (the handler
 *  must fulfil or abort it). */
export type RouteExternal = (url: RegExp, handler: (route: Route) => Promise<void> | void) => Promise<void>;

export const test = base.extend<{ blocked: string[]; requests: Request[]; local: string; handled: Set<Request>; routeExternal: RouteExternal }>({
  blocked: async ({}, use) => {
    await use([]);
  },
  requests: async ({}, use) => {
    await use([]);
  },
  local: async ({ baseURL }, use) => {
    await use(new URL(baseURL!).origin);
  },
  // Requests the router answered locally or aborted (the same Request
  // objects as the context's "request" events): matched per request, so
  // a URL blocked once can't hide a later request to it that got out.
  handled: async ({}, use) => {
    await use(new Set<Request>());
  },
  routeExternal: async ({ context, handled }, use) => {
    await use(async (url, handler) => {
      await context.route(url, (route) => {
        handled.add(route.request());
        return handler(route);
      });
    });
  },
  context: async ({ context, local, blocked, requests, handled }, use) => {
    context.on("request", (req) => requests.push(req));
    await context.route("**/*", (route) => {
      const req = route.request();
      const url = req.url();
      if (isLocal(url, local)) return route.continue();
      handled.add(req);
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
    // Teardown, for every test: nothing outside the local server got through.
    const leaked = requests.filter((r) => !isLocal(r.url(), local) && !handled.has(r)).map((r) => r.url());
    expect(leaked, "requests that left the test machine").toEqual([]);
  },
});

export { expect };

declare global {
  interface Window {
    __zt: TestHook;
  }
}

// The hook, or a clear error when it is not there: the page was reloaded
// or navigated away (its state is gone, so waiting would not help), or a
// test asked before the `?test=1` page installed it (open helpers wait for it).
const HOOK = `(() => {
  const h = window.__zt;
  if (!h || h.version !== 2) throw new Error("window.__zt (v2) is not installed on " + location.href + ": the page was reloaded or navigated, or is not a ?test=1 page");
  return h;
})()`;

/** Runs `f(window.__zt)` in the page (`/?test=1`). The function is serialised,
 *  so it can only use its argument. */
export function hook<T>(page: Page, f: (h: TestHook) => T): Promise<Awaited<T>> {
  return page.evaluate(`(${f.toString()})(${HOOK})`) as Promise<Awaited<T>>;
}

/** Like `hook`, with one serialisable argument: `f(window.__zt, arg)`. */
export function hookWith<A, T>(page: Page, f: (h: TestHook, a: A) => T, arg: A): Promise<Awaited<T>> {
  return page.evaluate(({ src, hk, arg }) => new Function("h", "a", `return (${src})(h, a)`)(new Function(`return ${hk}`)(), arg), { src: f.toString(), hk: HOOK, arg }) as Promise<Awaited<T>>;
}
