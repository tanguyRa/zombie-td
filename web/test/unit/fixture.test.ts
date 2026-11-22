// Writes (with UPDATE_FIXTURES=1, `npm run fixtures:chunks`) or checks the
// streaming-map fixture for Rust tests:
//   crates/sim-core/tests/fixtures/map_chunks.json       BuildingChunk[] (block id order)
//   crates/sim-core/tests/fixtures/map_chunks.meta.json  centre, rings, initial blocks, hashes
// Source: levels/paris-marais.json rebuilt as Overpass ways, loaded through
// MapLoader as a 500 m streaming level (rings squeezed like Match::ring_radii).
// 500 m, not the pack's 400 m: on a 400 m level ring 3 is only 33 m past
// ring 2 and the waves 1–2 blocks already cover it, so the fixture couldn't
// show that `start()`'s chunks stop at ring 2 (`!ring_ready(3)` in Rust).
// Here they cover out to ~270 m and ring 3 + margin is 291 m.
// Read by crates/sim-core/tests/t6_chunks.rs (new_streaming, ring_ready, and
// the snapshot hash recomputed in Rust).

import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MemoryBlockCache, SCHEMA_VERSION } from "../../src/map/cache";
import { canonicalChunk, snapshotHash } from "../../src/map/chunks";
import { MapLoader, matchRingRadii } from "../../src/map/loader";
import { REPO, fakeOverpass, loadConfig, loadLevel, waysFromLevel } from "./fixtures";

const DIR = `${REPO}crates/sim-core/tests/fixtures/`;
const LEVEL_RADIUS_M = 500;

it("map chunk fixture is up to date", async () => {
  const cfg = loadConfig();
  const level = loadLevel("paris-marais");
  const center = { lat: level.center_lat, lon: level.center_lon };
  const ringRadii = matchRingRadii(cfg.match.ring_radius_m, cfg.wave8_radius_m, LEVEL_RADIUS_M);
  const loader = new MapLoader({ center, ringRadii, cache: new MemoryBlockCache(), fetch: fakeOverpass(waysFromLevel(level)).fetch, urls: ["u"] });
  const initial = await loader.start();
  await loader.done();
  const chunks = loader.chunks();
  const meta = {
    source: "levels/paris-marais.json via web/test/unit/fixture.test.ts",
    center_lat: center.lat,
    center_lon: center.lon,
    level_radius_m: LEVEL_RADIUS_M,
    schema_version: SCHEMA_VERSION,
    block_margin_m: loader.marginM,
    coverage_slack_m: loader.coverageSlackM,
    ring_radii_m: ringRadii,
    initial_block_ids: initial.map((c) => c.block_id),
    initial_snapshot_hash: snapshotHash(initial),
    snapshot_hash: snapshotHash(chunks),
    first_canonical_line: canonicalChunk(chunks[0]),
  };
  const chunksJson = JSON.stringify(chunks) + "\n";
  const metaJson = JSON.stringify(meta, null, 2) + "\n";
  if (process.env.UPDATE_FIXTURES) {
    writeFileSync(`${DIR}map_chunks.json`, chunksJson);
    writeFileSync(`${DIR}map_chunks.meta.json`, metaJson);
  }
  expect(readFileSync(`${DIR}map_chunks.json`, "utf8")).toBe(chunksJson);
  expect(readFileSync(`${DIR}map_chunks.meta.json`, "utf8")).toBe(metaJson);
  expect(chunks.reduce((n, c) => n + c.buildings.length, 0)).toBeGreaterThan(500);
});
