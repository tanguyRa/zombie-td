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

import { isCityId } from "./place";
import { checkSummary } from "./rewards";
import { sanitizePlace } from "./sanitize";
import { TIERS, type CoverageCell, type MatchRecord, type ProfileState } from "./types";

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
  /// A ticket that can't open a crate (unknown tier or source).
  | "bad_ticket"
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
  /// State, every match and every cell, read in one transaction (export).
  snapshot(): Promise<{ state: ProfileState | undefined; matches: MatchRecord[]; coverage: CoverageCell[] }>;
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
  async snapshot() {
    return { state: this.state && clone(this.state), matches: [...this.matches.values()].map(clone), coverage: [...this.cells.values()].map(clone) };
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
        // Another tab holds an older connection open. Reported (not a
        // memory fallback): an empty profile must not hide the real one.
        blocked = true;
        rej(new ProfileError("storage", "the profile database is held open by another tab of the game; close it and reload"));
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

  async snapshot() {
    this.check();
    const tx = this.db.transaction([STATE, MATCHES, COVERAGE], "readonly");
    // All three requests on one transaction: a commit from another tab
    // lands before or after the whole read, never in between.
    const [state, matches, coverage] = await Promise.all([
      req(tx.objectStore(STATE).get(STATE_KEY)) as Promise<ProfileState | undefined>,
      req(tx.objectStore(MATCHES).getAll()) as Promise<MatchRecord[]>,
      req(tx.objectStore(COVERAGE).getAll()) as Promise<CoverageCell[]>,
    ]);
    return { state, matches, coverage };
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

/// Open errors meaning "this browser gives us no IndexedDB" (private mode,
/// storage disabled): the memory fallback is then the only option.
const UNAVAILABLE_ERRORS = new Set(["SecurityError", "InvalidStateError", "NotSupportedError", "NotAllowedError"]);
const OPEN_ATTEMPTS = 3;

/// The IndexedDB backend, or memory when this browser has no usable
/// IndexedDB (missing, private mode, storage denied). Everything else is
/// reported, never replaced by an empty memory profile over the player's
/// real one: a newer schema (`schema_too_new`), an open blocked by another
/// tab (`storage`), and an open that keeps failing (`storage`, after
/// `OPEN_ATTEMPTS` tries; one failure may be transient). The UI can then
/// offer `memoryProfile()` explicitly.
export async function openProfileBackend(opts: OpenStoreOptions = {}): Promise<ProfileBackend> {
  if (!(opts.indexedDB ?? globalThis.indexedDB)) return new MemoryProfileBackend();
  let last: unknown;
  for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * attempt));
    try {
      return await IdbProfileBackend.open(opts);
    } catch (e) {
      if (e instanceof ProfileError) throw e;
      if (UNAVAILABLE_ERRORS.has((e as { name?: string } | null)?.name ?? "")) return new MemoryProfileBackend();
      last = e;
    }
  }
  throw new ProfileError("storage", `could not open the profile database: ${String((last as Error | null)?.message ?? last)}`);
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

/// Throws ProfileError("bad_import") unless `b` has the full shape of a
/// current-schema bundle. Run on an import after migration and before the
/// commit, so a malformed export can't replace a working profile. Each match
/// is checked in full (`checkSummary` with `maxRadiusM` and `isCard`, plus
/// `cleared`, `claimedAt` and `payout`), and ids must be unique (instances,
/// decks, tickets, crates, matches, cells).
///
/// The place contract (place.ts) holds for imported data too, so `b` is
/// normalised in place: a match `cityId` that fails `isCityId` is dropped
/// (as `claimMatch` ignores it), `summary.city` and `summary.district` are
/// sanitised again (city and district mode), and every coverage city key
/// must be `id:osm:relation:<1-12 digits>` or `name:<non-empty>`.
export function validateBundle(b: Bundle, opts: { maxRadiusM: number; isCard?: (id: string) => boolean }): void {
  const fail = (m: string): never => {
    throw new ProfileError("bad_import", `not a valid profile: ${m}`);
  };
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const isStr = (v: unknown, nonEmpty = false): v is string => typeof v === "string" && (!nonEmpty || v.length > 0);
  const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const isTier = (v: unknown) => typeof v === "string" && (TIERS as readonly string[]).includes(v);
  const arrayOf = (v: unknown, name: string, ok: (x: unknown) => boolean) => {
    if (!Array.isArray(v)) fail(`${name} is not an array`);
    (v as unknown[]).forEach((x, i) => ok(x) || fail(`${name}[${i}] is malformed`));
  };
  const s = b?.state as unknown;
  if (!isObj(s)) return fail("state is not an object");
  if (!isStr(s.profileId, true)) fail("profileId");
  if (!isStr(s.createdAt)) fail("createdAt");
  if (!isCount(s.revision)) fail("revision is not a number");
  if (!isCount(s.nextSeq)) fail("nextSeq is not a number");
  arrayOf(s.instances, "instances", (x) => isObj(x) && isStr(x.instanceId, true) && isStr(x.cardId, true));
  arrayOf(s.decks, "decks", (x) => isObj(x) && isStr(x.id, true) && Array.isArray(x.instanceIds) && x.instanceIds.every((i) => isStr(i, true)));
  arrayOf(s.tickets, "tickets", (x) => isObj(x) && isStr(x.id, true));
  arrayOf(s.crates, "crates", (x) => isObj(x) && isStr(x.id, true));
  arrayOf(s.claimedMatches, "claimedMatches", (x) => isStr(x, true));
  arrayOf(s.dailyKeys, "dailyKeys", (x) => isStr(x, true));
  arrayOf(s.achievements, "achievements", (x) => isObj(x) && isStr(x.id, true));
  const t = s.highestClearedTier;
  if (!(typeof t === "number" && Number.isInteger(t) && t >= -1 && t < TIERS.length)) fail("highestClearedTier");
  if (typeof s.hometownCrateClaimed !== "boolean") fail("hometownCrateClaimed");
  const d = s.daily;
  if (!isObj(d) || !(d.day === "" || (isStr(d.day) && /^\d{4}-\d{2}-\d{2}$/.test(d.day))) || !isObj(d.counts)) fail("daily");
  for (const k of ["first_blood", "wave_victory", "match_victory"]) if (!isCount((d as { counts: Record<string, unknown> }).counts[k])) fail(`daily.counts.${k}`);
  const rng = s.rng;
  const hex = (v: unknown) => isStr(v) && /^[0-9a-f]{1,16}$/i.test(v);
  if (!isObj(rng) || !hex(rng.state) || !hex(rng.inc)) fail("rng is not a pair of hex u64");
  const isIso = (v: unknown) => isStr(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v));
  const isPayout = (v: unknown) => isObj(v) && ["waveTickets", "clearedTickets", "civilianTickets", "noRetryBonus", "total"].every((k) => isCount(v[k]));
  arrayOf(b.matches, "matches", (x) => isObj(x) && isObj(x.summary) && isStr(x.summary.matchId, true));
  b.matches.forEach((m, i) => {
    const problems = checkSummary(m.summary, opts.maxRadiusM, opts.isCard);
    if (problems.length) fail(`matches[${i}].summary: ${problems.join("; ")}`);
    if (typeof m.cleared !== "boolean") fail(`matches[${i}].cleared is not a boolean`);
    if (!isIso(m.claimedAt)) fail(`matches[${i}].claimedAt is not an ISO date`);
    if (!isPayout(m.payout)) fail(`matches[${i}].payout is malformed`);
    const sm = m.summary;
    if ("cityId" in sm && !isCityId(sm.cityId)) delete sm.cityId;
    sm.city = sanitizePlace(sm.city, "city");
    sm.district = sanitizePlace(sm.district);
  });
  const CITY_KEY_RE = /^(id:osm:relation:\d{1,12}|name:.+)$/;
  const fin = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  arrayOf(
    b.coverage,
    "coverage",
    (x) =>
      isObj(x) &&
      typeof x.cell === "number" &&
      Number.isInteger(x.cell) &&
      isTier(x.tier) &&
      isObj(x.cities) &&
      Object.values(x.cities).every(isTier) &&
      Object.keys(x.cities).every((k) => CITY_KEY_RE.test(k)) &&
      fin(x.areaM2) &&
      isObj(x.bounds) &&
      ["south", "west", "north", "east"].every((k) => fin((x.bounds as Record<string, unknown>)[k])),
  );
  const unique = (ids: unknown[], name: string) => {
    const seen = new Set<unknown>();
    for (const id of ids) {
      if (seen.has(id)) fail(`duplicate ${name} ${String(id)}`);
      seen.add(id);
    }
  };
  const st = s as unknown as ProfileState;
  unique(st.instances.map((x) => x.instanceId), "instance id");
  unique(st.decks.map((x) => x.id), "deck id");
  unique(st.tickets.map((x) => x.id), "ticket id");
  unique(st.crates.map((x) => x.id), "crate id");
  unique(b.matches.map((m) => m.summary.matchId), "match id");
  unique(b.coverage.map((c) => c.cell), "coverage cell");
}

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
