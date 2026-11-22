// Profile storage: one IndexedDB database with three object stores, or an
// in-memory fallback (like `openBlockCache` in map/cache.ts).
//
//   state     one record, key "profile": the ProfileState document
//   matches   MatchRecord by match id (summary + run record, grows)
//   coverage  CoverageCell by cell id (grows)
//
// Unlike the block cache this is the player's data, not a cache: nothing is
// ever dropped on a version change. The IndexedDB version only describes the
// stores (`IDB_VERSION`, upgrades only add stores); the data format is
// `ProfileState.schema`, migrated forward in JS on load (`migrateBundle`). A
// database written by newer code is refused (`schema_too_new`), never wiped.
//
// Every write is one `commit`: a single readwrite transaction over the three
// stores that first checks the stored revision. Two tabs writing at once:
// the second commit sees a newer revision, aborts and the service retries
// on fresh data, so a match can't be paid twice from two tabs.

import type { CoverageCell, MatchRecord, ProfileState } from "./types";

export const DB_NAME = "zt-profile";
/// Object-store layout version (not the data schema).
export const IDB_VERSION = 1;
/// Data schema of ProfileState / MatchRecord / CoverageCell.
/// 1: first version (T7a).
export const SCHEMA_VERSION = 1;

const STATE = "state";
const MATCHES = "matches";
const COVERAGE = "coverage";
const STATE_KEY = "profile";

export class ProfileError extends Error {
  constructor(
    readonly code: ProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProfileError";
  }
  /// Plain-JSON form, for an RPC boundary.
  toJSON(): { code: ProfileErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export type ProfileErrorCode =
  | "conflict"
  | "schema_too_new"
  | "bad_import"
  | "bad_summary"
  | "tier_locked"
  | "no_ticket"
  | "unknown_ticket"
  | "unknown_match"
  | "not_cleared"
  | "hometown_claimed"
  | "unknown_deck"
  | "illegal_deck"
  | "storage";

export interface Commit {
  /// The revision read before the change; null when creating the profile.
  expectedRevision: number | null;
  state: ProfileState;
  matches?: MatchRecord[];
  cells?: CoverageCell[];
  /// Replace every match and cell (import, migration, reset).
  replaceAll?: boolean;
}

export interface ProfileBackend {
  readonly persistent: boolean;
  loadState(): Promise<ProfileState | undefined>;
  getMatch(id: string): Promise<MatchRecord | undefined>;
  allMatches(): Promise<MatchRecord[]>;
  getCells(ids: number[]): Promise<CoverageCell[]>;
  allCells(): Promise<CoverageCell[]>;
  /// Atomic. Throws ProfileError("conflict") when the stored revision isn't `expectedRevision`.
  commit(c: Commit): Promise<void>;
  close(): void;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryProfileBackend implements ProfileBackend {
  readonly persistent = false;
  private state: ProfileState | undefined;
  private matches = new Map<string, MatchRecord>();
  private cells = new Map<number, CoverageCell>();

  async loadState() {
    return this.state && clone(this.state);
  }
  async getMatch(id: string) {
    const m = this.matches.get(id);
    return m && clone(m);
  }
  async allMatches() {
    return [...this.matches.values()].map(clone);
  }
  async getCells(ids: number[]) {
    return ids.flatMap((id) => {
      const c = this.cells.get(id);
      return c ? [clone(c)] : [];
    });
  }
  async allCells() {
    return [...this.cells.values()].map(clone);
  }
  async commit(c: Commit) {
    const cur = this.state?.revision ?? null;
    if (cur !== c.expectedRevision) throw new ProfileError("conflict", `profile revision ${cur}, expected ${c.expectedRevision}`);
    if (c.replaceAll) {
      this.matches.clear();
      this.cells.clear();
    }
    this.state = clone(c.state);
    for (const m of c.matches ?? []) this.matches.set(m.summary.matchId, clone(m));
    for (const cell of c.cells ?? []) this.cells.set(cell.cell, clone(cell));
  }
  close() {}
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export interface OpenStoreOptions {
  name?: string;
  indexedDB?: IDBFactory;
}

export class IdbProfileBackend implements ProfileBackend {
  readonly persistent = true;
  private closed = false;
  private constructor(private db: IDBDatabase) {}

  /// Throws when IndexedDB is missing, the open fails or is blocked, or the
  /// database has a newer store layout (`schema_too_new`).
  static async open(opts: OpenStoreOptions = {}): Promise<IdbProfileBackend> {
    const idb = opts.indexedDB ?? globalThis.indexedDB;
    if (!idb) throw new Error("IndexedDB is not available");
    const db = await new Promise<IDBDatabase>((res, rej) => {
      let blocked = false;
      const r = idb.open(opts.name ?? DB_NAME, IDB_VERSION);
      r.onupgradeneeded = () => {
        // Only ever add stores: the profile is never dropped.
        const d = r.result;
        if (!d.objectStoreNames.contains(STATE)) d.createObjectStore(STATE);
        if (!d.objectStoreNames.contains(MATCHES)) d.createObjectStore(MATCHES);
        if (!d.objectStoreNames.contains(COVERAGE)) d.createObjectStore(COVERAGE, { keyPath: "cell" });
      };
      r.onsuccess = () => {
        if (blocked) r.result.close();
        else res(r.result);
      };
      r.onerror = () => {
        const e = r.error;
        rej(e?.name === "VersionError" ? new ProfileError("schema_too_new", "the profile was saved by a newer version of the game") : e);
      };
      r.onblocked = () => {
        blocked = true;
        rej(new Error("profile upgrade blocked by another tab"));
      };
    });
    const b = new IdbProfileBackend(db);
    db.onversionchange = () => b.close();
    db.onclose = () => {
      b.closed = true;
    };
    return b;
  }

  private check() {
    if (this.closed) throw new ProfileError("storage", "the profile database was closed (another tab upgraded it); reload the page");
  }

  async loadState() {
    this.check();
    const tx = this.db.transaction(STATE, "readonly");
    return (await req(tx.objectStore(STATE).get(STATE_KEY))) as ProfileState | undefined;
  }

  async getMatch(id: string) {
    this.check();
    const tx = this.db.transaction(MATCHES, "readonly");
    return (await req(tx.objectStore(MATCHES).get(id))) as MatchRecord | undefined;
  }

  async allMatches() {
    this.check();
    const tx = this.db.transaction(MATCHES, "readonly");
    return (await req(tx.objectStore(MATCHES).getAll())) as MatchRecord[];
  }

  async getCells(ids: number[]) {
    this.check();
    const st = this.db.transaction(COVERAGE, "readonly").objectStore(COVERAGE);
    const rows = await Promise.all(ids.map((id) => req(st.get(id) as IDBRequest<CoverageCell | undefined>)));
    return rows.filter((c): c is CoverageCell => c !== undefined);
  }

  async allCells() {
    this.check();
    const tx = this.db.transaction(COVERAGE, "readonly");
    return (await req(tx.objectStore(COVERAGE).getAll())) as CoverageCell[];
  }

  commit(c: Commit): Promise<void> {
    this.check();
    return new Promise((res, rej) => {
      const tx = this.db.transaction([STATE, MATCHES, COVERAGE], "readwrite");
      let failure: unknown = null;
      tx.oncomplete = () => res();
      tx.onerror = () => rej(failure ?? tx.error);
      tx.onabort = () => rej(failure ?? tx.error ?? new Error("profile transaction aborted"));
      const states = tx.objectStore(STATE);
      // Check-then-write from the request callback, so it stays one transaction.
      const get = states.get(STATE_KEY);
      get.onsuccess = () => {
        const cur = (get.result as ProfileState | undefined)?.revision ?? null;
        if (cur !== c.expectedRevision) {
          failure = new ProfileError("conflict", `profile revision ${cur}, expected ${c.expectedRevision}`);
          tx.abort();
          return;
        }
        const matches = tx.objectStore(MATCHES);
        const cells = tx.objectStore(COVERAGE);
        if (c.replaceAll) {
          matches.clear();
          cells.clear();
        }
        states.put(c.state, STATE_KEY);
        for (const m of c.matches ?? []) matches.put(m, m.summary.matchId);
        for (const cell of c.cells ?? []) cells.put(cell);
      };
    });
  }

  close() {
    this.closed = true;
    this.db.close();
  }
}

/// The IndexedDB backend, or memory when IndexedDB can't be opened (missing,
/// private mode, blocked, any open error). A newer schema is not an open
/// error: it is rethrown, so the game never shows an empty profile over the
/// player's real one.
export async function openProfileBackend(opts: OpenStoreOptions = {}): Promise<ProfileBackend> {
  try {
    return await IdbProfileBackend.open(opts);
  } catch (e) {
    if (e instanceof ProfileError) throw e;
    return new MemoryProfileBackend();
  }
}

/// Everything stored, as one value (export, import, migration).
export interface Bundle {
  state: ProfileState;
  matches: MatchRecord[];
  coverage: CoverageCell[];
}

/// Migration from schema n to n + 1, in place.
export type Migration = (b: Bundle) => void;

/// Real migrations, keyed by the schema they upgrade from. Empty at schema 1.
export const MIGRATIONS: Record<number, Migration> = {};

/// Upgrade a bundle to `target`. Throws `schema_too_new` for a newer bundle
/// and `bad_import` when a step is missing.
export function migrateBundle(b: Bundle, target = SCHEMA_VERSION, migrations: Record<number, Migration> = MIGRATIONS): Bundle {
  const from = b.state?.schema;
  if (!Number.isInteger(from) || from < 1) throw new ProfileError("bad_import", `bad profile schema ${from}`);
  if (from > target) throw new ProfileError("schema_too_new", `profile schema ${from} is newer than this game (${target})`);
  const out = clone(b);
  for (let v = from; v < target; v++) {
    const m = migrations[v];
    if (!m) throw new ProfileError("bad_import", `no migration from profile schema ${v}`);
    m(out);
    out.state.schema = v + 1;
  }
  return out;
}
