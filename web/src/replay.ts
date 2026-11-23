// The replay viewer's inputs (T8): a run record and the map it was played
// on, from the match history or from files the player drops or picks. No
// game logic here: the worker replays the record with sim-core's
// `Replayer`, which checks the map, the setup and every attempt itself.
//
// - A run on a built-in level (`map.source: "level"`) replays offline on
//   the committed level whose centre and radius are the record's shell's.
// - A streamed run (`map.source: "chunks"`) needs the blocks it was played
//   on: the map bundle saved with "Download map", or, failing that, the
//   browser's block cache when it still holds every block of the record.
//   Without either, the viewer says it needs the bundle.

import type { BlockStore } from "./map/cache";
import { projectBlock, type BuildingChunk } from "./map/chunks";
import type { MatchMap, WaveAttempt } from "./protocol";
import { buildShell, type ShellJson } from "./stream";

/** The parts of a `RunRecord` (sim-core `record.rs`) the viewer reads. */
export interface RecordView {
  format: number;
  map: {
    source: "level" | "chunks";
    snapshot_hash: string;
    blocks: number[];
    shell: { name?: string; center_lat: number; center_lon: number; radius_m?: number | null };
  };
  setup: { seed: string; population_multiplier: number; deck: string[] };
  actions: { tick: number; action: { type: string } }[];
  attempts: WaveAttempt[];
  end: { tick: number; phase: string; wave: number; abandoned: boolean; waves_won: number; retries: number; restarts: number };
}

/** A replay ready to start: the record and the map for the worker. */
export interface ReplaySource {
  recordJson: string;
  record: RecordView;
  map: MatchMap;
  /** Where the map came from, for the panel ("built-in level", "map bundle", "block cache"). */
  mapFrom: string;
  /** For the title: the built-in level's name, or a place label. */
  title: string;
}

/** What a dropped or picked file is. */
export type ReplayFile =
  | { kind: "record"; json: string; record: RecordView }
  | { kind: "bundle"; shell: ShellJson; chunks: BuildingChunk[] }
  | { kind: "level"; json: string; name: string }
  | { kind: "unknown"; why: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A run record's minimal shape (the worker's verifier checks the rest). */
function asRecord(v: unknown): RecordView | null {
  if (!isObj(v) || typeof v.format !== "number" || !isObj(v.map) || !isObj(v.setup) || !Array.isArray(v.actions) || !Array.isArray(v.attempts) || !isObj(v.end)) return null;
  const map = v.map as Record<string, unknown>;
  if ((map.source !== "level" && map.source !== "chunks") || !isObj(map.shell) || !Array.isArray(map.blocks)) return null;
  return v as unknown as RecordView;
}

/** Classify a file's text: a run record, a map bundle (a shell with
 *  `chunks`), a level pack (buildings), or neither. */
export function classifyFile(text: string): ReplayFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: "unknown", why: "not JSON" };
  }
  const rec = asRecord(v);
  if (rec) return { kind: "record", json: text, record: rec };
  if (isObj(v) && Array.isArray(v.chunks) && typeof v.center_lat === "number") {
    const { chunks, ...shell } = v as unknown as ShellJson & { chunks: BuildingChunk[] };
    return { kind: "bundle", shell: { ...shell, buildings: [] } as ShellJson, chunks };
  }
  if (isObj(v) && Array.isArray(v.buildings) && v.buildings.length > 0 && typeof v.center_lat === "number") {
    return { kind: "level", json: text, name: typeof v.name === "string" ? v.name : "level" };
  }
  return { kind: "unknown", why: "neither a run record, a map bundle nor a level" };
}

/** Parse a run record's text, or say why it isn't one. */
export function parseRecord(text: string): RecordView {
  const f = classifyFile(text);
  if (f.kind !== "record") throw new Error("This file is not a run record");
  return f.record;
}

const close = (a: number, b: number | null | undefined) => typeof b === "number" && Math.abs(a - b) < 1e-6;

/** Whether a level's centre and radius are the record's shell's (the
 *  verifier then compares them bit for bit, with the buildings' hash). */
export function levelMatches(levelJson: string, rec: RecordView): boolean {
  try {
    const l = JSON.parse(levelJson) as { center_lat: number; center_lon: number; radius_m?: number };
    const s = rec.map.shell;
    return close(l.center_lat, s.center_lat) && close(l.center_lon, s.center_lon) && (l.radius_m === undefined ? s.radius_m == null : close(l.radius_m, s.radius_m));
  } catch {
    return false;
  }
}

/** The record's blocks from the block cache, projected on the record's
 *  centre, or how many are missing. */
export async function chunksFromCache(rec: RecordView, cache: BlockStore): Promise<{ chunks: BuildingChunk[] } | { missing: number }> {
  const ids = rec.map.blocks;
  const got = await cache.getMany(ids);
  const missing = ids.filter((id) => !got.has(id)).length;
  if (missing) return { missing };
  const center = { lat: rec.map.shell.center_lat, lon: rec.map.shell.center_lon };
  return { chunks: ids.map((id) => projectBlock(got.get(id)!, center)) };
}

/** The shell a replay of a streamed record is built on: the page's own
 *  shell for the record's centre (the verifier compares it with the
 *  record's bit for bit). */
export function shellFor(rec: RecordView): ShellJson {
  return buildShell(rec.map.shell.center_lat, rec.map.shell.center_lon);
}

export interface ResolveDeps {
  /** The built-in levels: name and a loader for the pack's JSON. */
  levels: { name: string; load: () => Promise<string> }[];
  /** The block cache (streamed runs without a bundle). */
  cache: () => Promise<BlockStore>;
}

/** Why a record can't be replayed yet: it needs a map (a streamed run
 *  without its bundle, or a level run on no built-in level). */
export class NeedsMap extends Error {
  constructor(
    message: string,
    readonly need: "bundle" | "level",
  ) {
    super(message);
  }
}

/** Build the replay source for a record and the map files given (if any).
 *  Throws `NeedsMap` when the map is missing, with the reason in words. */
export async function resolveReplay(recordJson: string, rec: RecordView, files: ReplayFile[], deps: ResolveDeps): Promise<ReplaySource> {
  if (rec.map.source === "level") {
    const given = files.find((f): f is Extract<ReplayFile, { kind: "level" }> => f.kind === "level");
    if (given) return { recordJson, record: rec, map: { level: given.json }, mapFrom: `level file (${given.name})`, title: given.name };
    for (const l of deps.levels) {
      const json = await l.load();
      if (levelMatches(json, rec)) return { recordJson, record: rec, map: { level: json }, mapFrom: "built-in level", title: l.name };
    }
    throw new NeedsMap("This run was played on a level that is not built in: add its level file.", "level");
  }
  const bundle = files.find((f): f is Extract<ReplayFile, { kind: "bundle" }> => f.kind === "bundle");
  if (bundle) {
    const shell = { ...bundle.shell, buildings: [] };
    return { recordJson, record: rec, map: { shell: JSON.stringify(shell), chunks: bundle.chunks }, mapFrom: "map bundle", title: "Streamed map" };
  }
  const cached = await chunksFromCache(rec, await deps.cache());
  if ("chunks" in cached) return { recordJson, record: rec, map: { shell: JSON.stringify(shellFor(rec)), chunks: cached.chunks }, mapFrom: "this browser's block cache", title: "Streamed map" };
  const n = rec.map.blocks.length;
  throw new NeedsMap(
    `This run was played on a streamed map (${n} blocks) and ${cached.missing === n ? "none of them are" : `${cached.missing} of them ${cached.missing === 1 ? "is" : "are"} not`} in this browser's map cache. ` +
      `To replay it, add its map bundle: the file saved with "Download map" at the end of the match.`,
    "bundle",
  );
}
