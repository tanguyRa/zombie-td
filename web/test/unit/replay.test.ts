// The replay viewer's inputs (src/replay.ts): classifying dropped files,
// finding the built-in level of a level run, and the map of a streamed run
// from its bundle or from the block cache (else "needs the bundle").
import { describe, expect, it } from "vitest";
import { MemoryBlockCache, makeCachedBlock } from "../../src/map/cache";
import { MapLoader } from "../../src/map/loader";
import { NeedsMap, classifyFile, levelMatches, resolveReplay, type RecordView } from "../../src/replay";
import { buildShell, mapBundle, shellRingRadii } from "../../src/stream";
import { REPO, fakeOverpass, loadLevel, waysFromLevel } from "./fixtures";
import { readFileSync } from "node:fs";

const GOLDEN = readFileSync(`${REPO}crates/sim-core/tests/fixtures/run_record_golden.json`, "utf8");
const MARAIS = readFileSync(`${REPO}levels/paris-marais.json`, "utf8");
const SUBURB = readFileSync(`${REPO}levels/suburb.json`, "utf8");
const levels = [
  { name: "Le Vésinet", load: async () => SUBURB },
  { name: "Paris — Le Marais", load: async () => MARAIS },
];

/** A streamed record's shape for `blocks` around the Marais centre. */
function streamedRecord(blocks: number[]): RecordView {
  const lvl = loadLevel("paris-marais");
  const g = JSON.parse(GOLDEN) as RecordView;
  return { ...g, map: { source: "chunks", snapshot_hash: "0", blocks, shell: buildShell(lvl.center_lat, lvl.center_lon) } };
}

describe("replay inputs", () => {
  it("classifies a run record, a map bundle, a level and anything else", () => {
    expect(classifyFile(GOLDEN).kind).toBe("record");
    expect(classifyFile(MARAIS).kind).toBe("level");
    const bundle = JSON.stringify({ ...buildShell(48.858, 2.358), chunks: [] });
    const b = classifyFile(bundle);
    expect(b.kind).toBe("bundle");
    if (b.kind === "bundle") expect(b.shell).not.toHaveProperty("chunks");
    expect(classifyFile("{nope").kind).toBe("unknown");
    expect(classifyFile('{"a": 1}').kind).toBe("unknown");
    expect(classifyFile("[]").kind).toBe("unknown");
  });

  it("finds the built-in level of a level run, offline", async () => {
    const rec = classifyFile(GOLDEN);
    if (rec.kind !== "record") throw new Error("golden");
    expect(levelMatches(MARAIS, rec.record)).toBe(true);
    expect(levelMatches(SUBURB, rec.record)).toBe(false);
    const src = await resolveReplay(GOLDEN, rec.record, [], { levels, cache: async () => new MemoryBlockCache() });
    expect(src.title).toBe("Paris — Le Marais");
    expect(src.mapFrom).toBe("built-in level");
    expect("level" in src.map && src.map.level).toBe(MARAIS);
    // A level run on no built-in level needs its level file.
    await expect(resolveReplay(GOLDEN, rec.record, [], { levels: levels.slice(0, 1), cache: async () => new MemoryBlockCache() })).rejects.toMatchObject({ need: "level" });
  });

  it("a streamed run: the bundle, else the block cache, else it says it needs the bundle", async () => {
    const lvl = loadLevel("paris-marais");
    const shell = buildShell(lvl.center_lat, lvl.center_lon);
    const cache = new MemoryBlockCache();
    const loader = new MapLoader({ center: { lat: shell.center_lat, lon: shell.center_lon }, ringRadii: shellRingRadii(shell), cache, fetch: fakeOverpass(waysFromLevel(lvl)).fetch, urls: ["https://o.test/api"], sleep: async () => {} });
    await loader.start();
    const chunks = loader.chunks();
    const ids = chunks.map((c) => c.block_id).sort((a, b) => a - b);
    const rec = streamedRecord(ids);
    const json = JSON.stringify(rec);
    // From the cache: the same chunks as the loader's (same projection).
    const fromCache = await resolveReplay(json, rec, [], { levels, cache: async () => cache });
    expect(fromCache.mapFrom).toBe("this browser's block cache");
    expect("chunks" in fromCache.map && fromCache.map.chunks).toEqual(ids.map((id) => chunks.find((c) => c.block_id === id)));
    expect("shell" in fromCache.map && JSON.parse(fromCache.map.shell)).toEqual(shell);
    // From a bundle (preferred over the cache).
    const bundle = classifyFile(JSON.stringify(mapBundle(shell, chunks, ids)));
    const fromBundle = await resolveReplay(json, rec, [bundle], { levels, cache: async () => cache });
    expect(fromBundle.mapFrom).toBe("map bundle");
    expect("shell" in fromBundle.map && JSON.parse(fromBundle.map.shell)).toEqual(shell);
    // Nothing cached: it needs the bundle, and says so.
    const e = await resolveReplay(json, rec, [], { levels, cache: async () => new MemoryBlockCache() }).catch((x) => x);
    expect(e).toBeInstanceOf(NeedsMap);
    expect(e.need).toBe("bundle");
    expect(e.message).toMatch(/streamed map \(\d+ blocks\) and none of them are in this browser's map cache.*map bundle.*Download map/);
    // One block missing.
    const partial = new MemoryBlockCache();
    for (const id of ids.slice(1)) await partial.put((await cache.get(id)) ?? makeCachedBlock(id, []));
    const e2 = await resolveReplay(json, rec, [], { levels, cache: async () => partial }).catch((x) => x);
    expect(e2.message).toMatch(/and 1 of them is not in this browser's map cache/);
  });
});
