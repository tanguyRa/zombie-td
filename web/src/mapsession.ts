// A picked place's streamed map on the page: the shell, the block loader
// (IndexedDB cache, then Overpass), the chunks handed to the worker, the
// "Loading the next district…" banner and the map bundle download. main.ts
// owns one per visit and aborts it when the player leaves.

import type { BuildingChunk } from "./map/chunks";
import { openBlockCache, type BlockStore } from "./map/cache";
import { MapLoader, type MapLoaderStats } from "./map/loader";
import type { MatchMap } from "./protocol";
import { DistrictGate, buildShell, mapBundle, shellRingRadii, tooEmpty, type ShellJson } from "./stream";

let cachePromise: Promise<BlockStore> | null = null;
/** The page's block cache, opened once (IndexedDB, else memory). */
export function blockCache(): Promise<BlockStore> {
  cachePromise ??= openBlockCache();
  return cachePromise;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** The banner over the game while a ring loads. */
const banner = {
  progress(_wave: number, loaded: number, needed: number) {
    $("district").hidden = false;
    $("district").dataset.state = "loading";
    $("d-msg").textContent = `Loading the next district… ${loaded} / ${needed} blocks`;
    const bar = $("d-bar") as HTMLProgressElement;
    bar.hidden = false;
    bar.max = Math.max(1, needed);
    bar.value = loaded;
    $("d-retry").hidden = true;
  },
  failed(_wave: number, message: string) {
    $("district").hidden = false;
    $("district").dataset.state = "failed";
    $("d-msg").textContent = `Could not load the next district. ${message}`;
    ($("d-bar") as HTMLProgressElement).hidden = true;
    $("d-retry").hidden = false;
  },
  hide() {
    $("district").hidden = true;
    $("district").dataset.state = "";
  },
};

export interface MapSessionOptions {
  /** Backoff before the first retry of a failed query (test mode shortens it). */
  backoffMs?: number;
  /** Per-endpoint request limit and per-batch budget (test mode lengthens
   *  them: the E2E holds a "slow" request through whole waves). */
  requestTimeoutMs?: number;
  batchBudgetMs?: number;
}

export class MapSession {
  readonly shell: ShellJson;
  readonly shellJson: string;
  readonly loader: MapLoader;
  readonly gate: DistrictGate;
  /** Chunks the core refused (never expected: see `ChunkQueue`). */
  readonly refused: { block: number; error: string }[] = [];
  /** The worker's last `map` report. */
  worker = { stored: 0, queued: 0 };
  /** Wall time of the first load (ms), for the HUD title and the report. */
  firstLoadMs = 0;
  /** Waves 1–2 are in: a match can be built on this map. */
  ready = false;
  private toWorker: ((c: BuildingChunk) => void) | null = null;
  private aborted = false;

  private constructor(shell: ShellJson, cache: BlockStore, opts: MapSessionOptions) {
    this.shell = shell;
    this.shellJson = JSON.stringify(shell);
    this.loader = new MapLoader({
      center: { lat: shell.center_lat, lon: shell.center_lon },
      ringRadii: shellRingRadii(shell),
      cache,
      ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}),
      ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
      ...(opts.batchBudgetMs !== undefined ? { batchBudgetMs: opts.batchBudgetMs } : {}),
    });
    this.gate = new DistrictGate(this.loader, banner);
    // Background blocks go to the worker once a match was built on this map
    // (before that, `matchMap()` picks them up from `loader.chunks()`).
    this.loader.on("chunk", (c) => this.toWorker?.(c));
    this.loader.on("listenerError", ({ event, error }) => console.error(`map loader: a ${event} listener failed`, error));
    this.loader.on("error", ({ blocks, error }) => console.warn(`map loader: ${blocks.length} blocks failed`, error));
  }

  static async open(name: string, lat: number, lon: number, opts: MapSessionOptions = {}): Promise<MapSession> {
    return new MapSession(buildShell(name, lat, lon), await blockCache(), opts);
  }

  /** Load waves 1–2 (cache, then Overpass), reporting progress. Throws when
   *  it fails or the place is too empty to play. */
  async start(progress: (loaded: number, needed: number) => void): Promise<void> {
    const t0 = performance.now();
    const tick = () => {
      const p = this.loader.ringProgress(2);
      progress(p.loaded, p.needed);
    };
    tick();
    const timer = setInterval(tick, 200);
    try {
      const first = await this.loader.start();
      this.firstLoadMs = performance.now() - t0;
      const empty = tooEmpty(first);
      if (empty) {
        this.abort();
        throw new Error(empty);
      }
      this.ready = true;
    } finally {
      clearInterval(timer);
    }
  }

  /** The map for a new match (`init`): every chunk loaded so far. Later
   *  chunks go to `send` as they arrive. */
  matchMap(send: (c: BuildingChunk) => void): MatchMap {
    this.toWorker = send;
    return { shell: this.shellJson, chunks: this.loader.chunks() };
  }

  /** The worker's `map` report. A refused chunk is a bug in the loader's
   *  superset rule: loud in the console. */
  onWorker(m: { stored: number; queued: number; refused: { block: number; error: string }[] }) {
    this.worker = { stored: m.stored, queued: m.queued };
    for (const r of m.refused) {
      console.error(`streamed map: the match refused block ${r.block}: ${r.error}`);
      this.refused.push(r);
    }
  }

  /** The map bundle JSON for this run record (its blocks, the shell). */
  bundle(recordJson: string): string {
    const rec = JSON.parse(recordJson) as { map: { source: string; blocks: number[] } };
    if (rec.map.source !== "chunks") throw new Error("not a streamed match");
    return JSON.stringify(mapBundle(this.shell, this.loader.chunks(), rec.map.blocks));
  }

  /** For the test hook and the HUD. */
  info(): { center: [number, number]; radius: number; waveBlocks: number[][]; ready: boolean[]; stats: MapLoaderStats; worker: { stored: number; queued: number }; refused: { block: number; error: string }[]; firstLoadMs: number; district: number | null; aborted: boolean } {
    return {
      center: [this.shell.center_lat, this.shell.center_lon],
      radius: this.shell.radius_m,
      waveBlocks: this.loader.waveBlocks.map((w) => [...w]),
      ready: this.loader.waveBlocks.map((_, w) => this.loader.ringReady(w + 1)),
      stats: { ...this.loader.stats },
      worker: { ...this.worker },
      refused: this.refused.map((r) => ({ ...r })),
      firstLoadMs: this.firstLoadMs,
      district: this.gate.waiting,
      aborted: this.aborted,
    };
  }

  /** Leaving: stop loading (pending waits end), nothing more reaches the worker. */
  abort() {
    this.aborted = true;
    this.toWorker = null;
    this.gate.cancel();
    this.loader.abort();
  }
}
