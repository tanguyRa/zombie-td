// Block cache: the raw (lat/lon) buildings of each fetched block, keyed by
// block id, in IndexedDB. A schema bump (`SCHEMA_VERSION`) is the database
// version: opening with a new version drops every cached block.

import type { BlockId } from "./blocks";
import { fnv1a64Hex } from "./hash";
import type { RawBuilding } from "./overpass";

/// Bump when the cached format or its derivation (kind/floors mapping,
/// block assignment, grid) changes. Every block is then fetched again.
export const SCHEMA_VERSION = 1;
export const DB_NAME = "zt-map-blocks";
const STORE = "blocks";

export interface CachedBlock {
  id: BlockId;
  schema: number;
  /// When the block was downloaded (ISO 8601).
  fetchedAt: string;
  /// `blockContentHash(id, buildings)`.
  hash: string;
  /// Sorted by building id.
  buildings: RawBuilding[];
}

/// FNV-1a 64 (hex) of `JSON.stringify([id, [[bid, kind, floors, ring], ...]])`
/// over the raw lat/lon data, buildings in id order. Identifies the OSM
/// snapshot of a block independently of any match centre.
export function blockContentHash(id: BlockId, buildings: RawBuilding[]): string {
  const sorted = [...buildings].sort((a, b) => a.id - b.id);
  return fnv1a64Hex(JSON.stringify([id, sorted.map((b) => [b.id, b.kind, b.floors, b.ring])]));
}

export function makeCachedBlock(id: BlockId, buildings: RawBuilding[], fetchedAt: Date = new Date(), schema = SCHEMA_VERSION): CachedBlock {
  const sorted = [...buildings].sort((a, b) => a.id - b.id);
  return { id, schema, fetchedAt: fetchedAt.toISOString(), hash: blockContentHash(id, sorted), buildings: sorted };
}

export interface BlockStore {
  get(id: BlockId): Promise<CachedBlock | undefined>;
  /// The cached blocks among `ids` (missing ones are absent from the map).
  getMany(ids: BlockId[]): Promise<Map<BlockId, CachedBlock>>;
  has(id: BlockId): Promise<boolean>;
  put(block: CachedBlock): Promise<void>;
  clear(): Promise<void>;
}

/// In-memory store (tests, or when IndexedDB is unavailable).
export class MemoryBlockCache implements BlockStore {
  private m = new Map<BlockId, CachedBlock>();
  constructor(readonly schema = SCHEMA_VERSION) {}
  async get(id: BlockId) {
    const b = this.m.get(id);
    return b && b.schema === this.schema ? structuredClone(b) : undefined;
  }
  async getMany(ids: BlockId[]) {
    const out = new Map<BlockId, CachedBlock>();
    for (const id of ids) {
      const b = await this.get(id);
      if (b) out.set(id, b);
    }
    return out;
  }
  async has(id: BlockId) {
    return (await this.get(id)) !== undefined;
  }
  async put(block: CachedBlock) {
    this.m.set(block.id, structuredClone(block));
  }
  async clear() {
    this.m.clear();
  }
  get size() {
    return this.m.size;
  }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error("transaction aborted"));
  });
}

export class IdbBlockCache implements BlockStore {
  private constructor(private db: IDBDatabase, readonly schema: number) {}

  /// Open (or create) the cache. A database from another schema version is
  /// emptied (newer) or deleted and recreated (older code opening a newer DB).
  static async open(opts: { name?: string; schema?: number; indexedDB?: IDBFactory } = {}): Promise<IdbBlockCache> {
    const name = opts.name ?? DB_NAME;
    const schema = opts.schema ?? SCHEMA_VERSION;
    const idb = opts.indexedDB ?? globalThis.indexedDB;
    const openOnce = () =>
      new Promise<IDBDatabase>((res, rej) => {
        const r = idb.open(name, schema);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
          db.createObjectStore(STORE, { keyPath: "id" });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error("block cache upgrade blocked by another tab"));
      });
    let db: IDBDatabase;
    try {
      db = await openOnce();
    } catch (e) {
      if ((e as DOMException)?.name !== "VersionError") throw e;
      await req(idb.deleteDatabase(name) as IDBRequest<unknown>);
      db = await openOnce();
    }
    db.onversionchange = () => db.close();
    return new IdbBlockCache(db, schema);
  }

  close() {
    this.db.close();
  }

  async get(id: BlockId) {
    return (await this.getMany([id])).get(id);
  }

  async getMany(ids: BlockId[]) {
    const tx = this.db.transaction(STORE, "readonly");
    const st = tx.objectStore(STORE);
    const rows = await Promise.all(ids.map((id) => req(st.get(id) as IDBRequest<CachedBlock | undefined>)));
    const out = new Map<BlockId, CachedBlock>();
    rows.forEach((b, i) => {
      if (b && b.schema === this.schema) out.set(ids[i], b);
    });
    return out;
  }

  async has(id: BlockId) {
    return (await this.get(id)) !== undefined;
  }

  async put(block: CachedBlock) {
    const tx = this.db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(block);
    await txDone(tx);
  }

  async clear() {
    const tx = this.db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txDone(tx);
  }
}
