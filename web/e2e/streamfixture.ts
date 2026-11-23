// Fixture Overpass for the streamed-map E2E tests (stream.spec.ts,
// first-session.spec.ts): answers each `way["building"](bbox)` union from
// the committed Marais level's ways, per block, through `routeExternal`
// (so the network-leak teardown counts them as handled), with holds and
// failures on demand; and the native chunks-mode verifier.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Route } from "@playwright/test";
import type { OsmWay } from "../src/map/osm";
import { blockAt } from "../src/map/blocks";
import { loadLevel, parseBboxes, wayInBbox, waysFromLevel } from "../test/unit/fixtures";
import { expect, type RouteExternal } from "./offline";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MARAIS_WAYS = waysFromLevel(loadLevel("paris-marais"));
export const OVERPASS = /^https:\/\/(overpass-api\.de|overpass\.private\.coffee)\//;
const CORS = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin" };

interface Call {
  blocks: number[];
  status: number;
}

/** A fixture Overpass: answers each `way["building"](bbox)` union from the
 *  Marais ways, or `ways` (vertex or segment in a box, like Overpass). `hold` delays
 *  matching queries until released; `fail` answers them 504. */
export function fixtureOverpass(ways: OsmWay[] = MARAIS_WAYS) {
  const calls: Call[] = [];
  const holds: { pred: (blocks: number[]) => boolean; gate: Promise<void>; release: () => void }[] = [];
  let fail: ((blocks: number[]) => boolean) | null = null;
  const handler = async (route: Route) => {
    const q = new URLSearchParams(route.request().postData() ?? "").get("data") ?? "";
    const boxes = parseBboxes(q);
    const blocks = boxes.map(([s, w, n, e]) => blockAt((s + n) / 2, (w + e) / 2));
    const call: Call = { blocks, status: 0 };
    calls.push(call);
    // A copy: a release removes its hold while others still wait on it.
    for (const h of [...holds]) if (h.pred(blocks)) await h.gate;
    try {
      if (fail?.(blocks)) {
        call.status = 504;
        return await route.fulfill({ status: 504, headers: CORS, body: "busy" });
      }
      const elements = ways.filter((w) => boxes.some((b) => wayInBbox(w, b)));
      call.status = 200;
      await route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ elements }) });
    } catch {
      // The page aborted the request meanwhile (leaving the match).
    }
  };
  return {
    calls,
    install: (routeExternal: RouteExternal) => routeExternal(OVERPASS, handler),
    hold(pred: (blocks: number[]) => boolean) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const h = { pred, gate, release };
      holds.push(h);
      return {
        release: () => {
          holds.splice(holds.indexOf(h), 1);
          release();
        },
      };
    },
    setFail(f: ((blocks: number[]) => boolean) | null) {
      fail = f;
    },
    /** Every block id a query asked for (answered or not). */
    blocks: () => new Set(calls.flatMap((c) => c.blocks)),
  };
}

/** `sim-headless verify --chunks --shell` (native, release): the summary. */
export function verifyChunks(run: string, map: string): { phase: string; map_source: string; snapshot_hash: string; attempt_hashes: string[]; final_hash: string } {
  let out: string;
  try {
    out = execFileSync("cargo", ["run", "--release", "-q", "-p", "sim-headless", "--", "verify", run, "--chunks", map, "--shell", map, "--quiet"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 << 20,
      timeout: 5 * 60_000,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`sim-headless verify rejected the record:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
  const at = out.lastIndexOf("\nverified:");
  expect(at, out).toBeGreaterThan(0);
  console.log(out.slice(at + 1).trim());
  return JSON.parse(out.slice(0, at));
}

