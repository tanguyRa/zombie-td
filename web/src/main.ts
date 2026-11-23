// Main thread: renders the match with deck.gl on top of the street map,
// handles input and UI. All game logic runs in the worker (WASM sim-core
// `Match`); the page only sends `Action`s and draws what comes back.
import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { BitmapLayer, LineLayer, PathLayer, PolygonLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import parisUrl from "../../levels/paris-marais.json?url";
import suburbUrl from "../../levels/suburb.json?url";
import cardsJson from "../../cards.json?raw";
import { Place, createExplore } from "./explore";
import { MapSession } from "./mapsession";
import { parseSeed } from "./seed";
import {
  Action,
  ActionError,
  FromWorker,
  Geometry,
  H_COUNT,
  H_INTERVAL,
  H_LATEST,
  H_SEQ,
  H_TIME,
  HandCard,
  MatchMap,
  MatchStatus,
  Perf,
  Pick,
  Query,
  QueryResult,
  SLOTS,
  StaticLevel,
  Structure,
  Target,
  ToWorker,
  WaveAttempt,
  WaveResult,
  headerViews,
  nowAbs,
  slotViews,
} from "./protocol";
import "./style.css";

// Built-in levels (committed level packs, no download needed).
const PRESETS: Place[] = [
  { name: "Paris — Le Marais", lat: 48.858, lon: 2.358, presetUrl: parisUrl },
  { name: "Le Vésinet (suburb)", lat: 48.8935, lon: 2.133, presetUrl: suburbUrl },
];

// Card texts and limits for the hand and the targeting hints (the rules
// themselves are checked by the core).
interface CardDef {
  id: string;
  name: string;
  text: string;
  kind: string;
  effect: { type: string; buildings?: number; length_m?: number };
}
const CARDS = new Map<string, CardDef>((JSON.parse(cardsJson).cards as CardDef[]).map((c) => [c.id, c]));

// Agent colours (RGBA) indexed by render state: civilian, infected, zombie,
// corpse, hidden, fresh kill (flashes for kill_flash_seconds, then corpse).
const COLORS: [number, number, number, number][] = [
  [0x4a, 0xa3, 0xff, 255],
  [0xff, 0xd2, 0x3f, 255],
  [0xff, 0x3b, 0x3b, 255],
  [0x9b, 0x6b, 0xe0, 255],
  [0, 0, 0, 0],
  [0xf3, 0xe8, 0xff, 255],
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- state
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const send = (m: ToWorker) => worker.postMessage(m);
// A crash in the worker stops the match: say so instead of freezing.
worker.addEventListener("error", (e) => {
  console.error("sim worker error:", e.message);
  prepError(`The simulation stopped: ${e.message}`);
});

const TEST_MODE = new URLSearchParams(location.search).get("test") === "1";
/** Test mode retries a failed Overpass query after 50 ms instead of 1 s
 *  (doubling each time): a clock control, the blocks are the same. */
const TEST_BACKOFF_MS = 50;

let level: StaticLevel | null = null;
let currentPlace: Place | null = null;
// The map of the place on screen: a built-in level pack, or a picked
// place's streamed map (null until it is ready, and after "← Map").
let currentLevelJson = "";
let session: MapSession | null = null;
const levelCache = new Map<string, string>();
let prepAbort: AbortController | null = null;
let shared: SharedArrayBuffer | null = null;
let status: MatchStatus | null = null;
let perf: Perf | null = null;
let hand: HandCard[] = [];
let structures: Structure[] = [];
let results: WaveResult[] = [];
let attempts: WaveAttempt[] = [];
type F32 = Float32Array<ArrayBufferLike>;
type U8 = Uint8Array<ArrayBufferLike>;
let towers: F32 = new Float32Array(0);
let fences: F32 = new Float32Array(0);
interface Bld {
  polygon: number[][];
  index: number;
  x: number;
  y: number;
  area: number;
  floors: number;
  cells: number;
  wave: number;
}
let buildings: Bld[] = [];
let fieldKind: "none" | "chase" | "flee" = "none";
let fieldImage: HTMLCanvasElement | null = null;
let showHash = false;
let fitted = false;
let lastToast = "";

// Targeting: the selected hand card and what has been picked for it so far.
interface Selection {
  handIndex: number;
  card: HandCard;
  picked: number[]; // buildings
  draft: number[][] | null; // polyline being dragged
  draftInfo: { length: number | null; error: string | null } | null;
  /** A play of this selection is waiting for the core's answer: clicks and
   *  drags are ignored meanwhile. */
  busy: boolean;
}
let sel: Selection | null = null;
// A structure being inspected (repair / pull down) and its current costs
// (asked again after every state, placements and phase change).
let inspected: { id: number; repairCost: number; refund: number } | null = null;
// A phase-changing action (start, next, retry, restart, mulligan) is in
// flight: those buttons are disabled until it is answered.
let phaseBusy = false;
// Keep marks clicked but not answered yet (the whole list each click sends),
// so quick clicks build on each other instead of on the last state.
let keepPending: { list: number[]; inFlight: number } | null = null;
// The seed of the match on screen (a decimal string: u64, exact).
let matchSeed = "1";

// Interpolation buffers (alternated so deck.gl sees a new array each frame).
let posBufs: F32[] = [new Float32Array(0), new Float32Array(0)];
let colBufs: U8[] = [new Uint8Array(0), new Uint8Array(0)];
let posFlip = 0;
let colFlip = 0;
let lastSeq = -1;
let n = 0;
// Fallback (no SharedArrayBuffer): the last two frames from the worker.
let fbPrev: { pos: F32; render: U8; time: number; count: number } | null = null;
let fbCur: { pos: F32; render: U8; time: number; count: number } | null = null;
let fbSeq = 0;

// ---------------------------------------------------------------- worker requests
let nextId = 1;
const pendingActions = new Map<number, (e: ActionError | null) => void>();
// Queries and records reject with ABORTED when the worker has no match to
// ask (stopped or re-initialised); actions resolve with an `aborted` error.
const ABORTED = "aborted";
const pendingQueries = new Map<number, { ok: (r: QueryResult) => void; fail: (e: Error) => void }>();
const pendingRecords = new Map<number, { ok: (json: string) => void; fail: (e: Error) => void }>();

/** Send an action; resolves with the core's refusal or null once applied.
 *  Every UI control and every test-hook helper goes through here. */
function act(action: Action): Promise<ActionError | null> {
  const id = nextId++;
  return new Promise((resolve) => {
    pendingActions.set(id, resolve);
    send({ type: "action", id, action });
  });
}

function query(q: Query): Promise<QueryResult> {
  const id = nextId++;
  return new Promise((ok, fail) => {
    pendingQueries.set(id, { ok, fail });
    send({ type: "query", id, query: q });
  });
}
/** What is at a map point (building, structure, costs): read-only. */
const pickAt = async (x: number, y: number) => ((await query({ q: "pick", x, y })) as Extract<QueryResult, { q: "pick" }>).pick;
/** Repair cost and refund of a structure now (-1: none). */
const costsOf = async (id: number) => (await query({ q: "costs", id })) as Extract<QueryResult, { q: "costs" }>;
/** Placed length of a polyline, or why it can't be placed. */
const fenceLength = async (pts: number[]) => (await query({ q: "fence_length", pts })) as Extract<QueryResult, { q: "fence_length" }>;

function fetchRecord(): Promise<string> {
  const id = nextId++;
  return new Promise((ok, fail) => {
    pendingRecords.set(id, { ok, fail });
    send({ type: "record", id });
  });
}

/** Play an action from the UI: a refusal is shown with the core's message. */
// The last action a UI control sent and how it ended (read by the test hook
// to wait for a click's outcome).
const uiActions = { count: 0, type: "", error: null as ActionError | null };
/** The core's message, with a card id (some errors name the card by id)
 *  replaced by the card's name. */
function errorText(e: ActionError): string {
  const id = typeof e.card === "string" ? e.card : null;
  const def = id ? CARDS.get(id) : undefined;
  return def && e.message.startsWith(`${id} `) ? def.name + e.message.slice(id!.length) : e.message;
}
async function uiAct(action: Action): Promise<ActionError | null> {
  let e = await act(action);
  if (e) {
    e = { ...e, message: errorText(e) };
    // A stopped match answers `aborted`: nothing to tell the player.
    if (e.error !== ABORTED) toast(e.message);
  }
  uiActions.count++;
  uiActions.type = action.type;
  uiActions.error = e;
  return e;
}

/** A phase-changing action from a button: one at a time (a double click
 *  sends one action, never a second retry or a refused second start). */
async function phaseAct(action: Action): Promise<void> {
  await phaseActResult(action);
}
async function phaseActResult(action: Action): Promise<ActionError | null> {
  if (phaseBusy) return null;
  phaseBusy = true;
  updateControls();
  try {
    return await uiAct(action);
  } finally {
    phaseBusy = false;
    updateControls();
  }
}

/** Start or Next wave from a button. On a streamed map the ring it opens
 *  must be loaded first: until then the banner says "Loading the next
 *  district…" (or shows the error and Retry loading), and the action is sent
 *  as soon as the ring is in. The worker adds every chunk it was sent before
 *  the action (they are posted first), so the core finds the ring ready. */
async function waveAct(action: Action): Promise<void> {
  if (phaseBusy || !status) return;
  const s = session;
  const wave = action.type === "next_wave" ? status.wave + 1 : status.wave;
  if (s && !s.loader.ringReady(wave)) {
    if (s.gate.waiting !== null) return; // already waiting for it
    const wait = s.gate.wait(wave);
    updateControls(); // Start / Next wave disabled while it waits
    const ok = await wait;
    updateControls();
    if (!ok || session !== s) return;
  }
  const e = await phaseActResult(action);
  if (e?.error === "ring_not_loaded") console.error("streamed map: the core says the ring is not loaded although the loader has it", e, s?.info());
}

// ---------------------------------------------------------------- map + deck overlay
// The street map from the map screen stays on screen; deck.gl draws the game
// on top of it. The sim works in local meters (grid origin at a corner), the
// level pack in meters around (lat0, lon0) with an equirectangular projection.
// Layers keep their data in sim meters and a model matrix turns them into
// lng/lat offsets from (lon0, lat0), the exact inverse of that projection, so
// footprints land on the map's buildings.
const explore = createExplore({ presets: PRESETS, onStart: enterGame });
const map = explore.map;
const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
map.addControl(overlay);

let geo: { lat0: number; lon0: number; kx: number; ky: number } | null = null;
let geoProps: Record<string, unknown> = {};

function setGeo(lat0: number, lon0: number) {
  geo = { lat0, lon0, kx: Math.cos((lat0 * Math.PI) / 180) * 111320, ky: 110540 };
}

function updateGeoProps() {
  if (!geo || !level) return;
  const sx = 1 / geo.kx;
  const sy = 1 / geo.ky;
  const [cx, cy] = level.center;
  geoProps = {
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS,
    coordinateOrigin: [geo.lon0, geo.lat0, 0],
    // column-major: translate by -center (sim → pack meters), then meters → degrees
    modelMatrix: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, -cx * sx, -cy * sy, 0, 1],
  };
}

function toSim(ll: { lng: number; lat: number }): number[] | null {
  if (!geo || !level) return null;
  return [(ll.lng - geo.lon0) * geo.kx + level.center[0], (ll.lat - geo.lat0) * geo.ky + level.center[1]];
}

function toLngLat(x: number, y: number): { lng: number; lat: number } | null {
  if (!geo || !level) return null;
  return { lng: geo.lon0 + (x - level.center[0]) / geo.kx, lat: geo.lat0 + (y - level.center[1]) / geo.ky };
}

/** Frame the revealed disc and the next ring. */
function fitView(animate = true) {
  if (!geo) return;
  const r = status ? Math.min(status.next_radius_m, status.radius_m * 1.25) : (level?.rings[0] ?? 400);
  const dlon = r / geo.kx;
  const dlat = r / geo.ky;
  map.fitBounds(
    [
      [geo.lon0 - dlon, geo.lat0 - dlat],
      [geo.lon0 + dlon, geo.lat0 + dlat],
    ],
    { padding: { top: 68, bottom: 150, left: 228, right: 264 }, duration: animate ? 1200 : 0 },
  );
}

// Test hook (`?test=1`): loaded on demand so the normal page never runs it.
// See testhook.ts for the `window.__zt` API.
let testTap: ((m: FromWorker) => boolean) | null = null;
if (TEST_MODE) {
  void import("./testhook").then(({ installTestHook }) => {
    testTap = installTestHook({
      send,
      act,
      query,
      record: fetchRecord,
      map,
      overlay,
      presets: PRESETS.map((p) => p.name),
      screen: () => document.body.dataset.screen ?? "",
      status: () => status,
      perf: () => perf,
      hand: () => hand,
      structures: () => structures,
      results: () => results,
      attempts: () => attempts,
      towers: () => towers,
      level: () => level,
      placeName: () => currentPlace?.name ?? null,
      buildings: () => buildings,
      result: () => ($("result").hidden ? null : ($("result").dataset.kind ?? null)),
      toast: () => lastToast,
      uiActions: () => ({ ...uiActions }),
      drawn: () => structuredClone(drawn),
      hint: () => $("hint").textContent ?? "",
      selection: () => (sel ? { handIndex: sel.handIndex, card: sel.card.card, picked: [...sel.picked] } : null),
      inspected: () => (inspected ? { ...inspected } : null),
      toSim,
      toLngLat,
      enterPreset: (i) => enterGame(PRESETS[i]),
      enterPlace: (lat, lon, name) => enterGame({ lat, lon, name }),
      streamMap: () => session?.info() ?? null,
      mapBundle: mapBundleJson,
      district: () => ({ visible: !$("district").hidden, state: $("district").dataset.state ?? "", text: $("d-msg").textContent ?? "" }),
      newMatch: (seed) => {
        // The seed input plus Enter, without the confirmation.
        ($("seed") as HTMLInputElement).value = String(seed);
        newMatch();
      },
    });
  });
} else if (import.meta.env.DEV) {
  (window as unknown as { __zt: unknown }).__zt = { map, overlay, toSim, get level() { return level; }, get buildings() { return buildings; } };
}

const inGame = () => document.body.dataset.screen === "game";
const phase = () => status?.phase ?? null;

// ---------------------------------------------------------------- input
map.on("click", (e) => {
  if (!inGame() || !status) return;
  const p = toSim(e.lngLat);
  if (!p) return;
  void onMapClick(p[0], p[1]);
});

async function onMapClick(x: number, y: number) {
  if (sel) {
    const s = sel;
    if (s.busy) return;
    const c = s.card;
    if (c.target === "point") {
      await playSelection(s, { point: [x, y] });
    } else if (c.target === "buildings") {
      let pick: Pick;
      try {
        pick = await pickAt(x, y);
      } catch {
        return; // the match stopped
      }
      if (sel !== s || s.busy) return;
      const max = CARDS.get(c.card)?.effect.buildings ?? 1;
      const i = s.picked.indexOf(pick.building);
      if (pick.building < 0) {
        setHint("Click a building (inside the revealed area)", true);
        return;
      }
      if (i >= 0) {
        s.picked.splice(i, 1);
        updateTargeting();
        return;
      }
      // Only highlighted buildings: anything else leaves the picks as they are.
      const why = unavailable(pick.building);
      if (why) {
        setHint(`Not available: ${why}. ${s.picked.length}/${max} picked.`, true);
        return;
      }
      if (s.picked.length >= max) {
        setHint(`Already ${max} picked: click one to drop it, or Place.`, true);
        return;
      }
      s.picked.push(pick.building);
      if (s.picked.length >= max) await playSelection(s);
      else updateTargeting();
    }
    return;
  }
  // No card selected: inspect a structure (repair / pull down).
  let pick: Pick;
  try {
    pick = await pickAt(x, y);
  } catch {
    return;
  }
  if (sel) return; // a card was selected meanwhile
  inspected = pick.structure >= 0 ? { id: pick.structure, repairCost: pick.repairCost, refund: pick.refund } : null;
  updateInspect();
}

/** Why building `b` can't take an armament now, or null if it can (the
 *  highlighted `validBuildings`). */
function unavailable(b: number): string | null {
  if (validBuildings().some((v) => v.index === b)) return null;
  for (let i = 0; i < towers.length; i += 5) if (towers[i] === b) return "already garrisoned";
  const bld = buildings[b];
  if (bld && bld.cells === 0) return "too small to garrison";
  return "outside the revealed area";
}

/** Play the selected card on `target` (default: the picked buildings or the
 *  drawn line). A refused play keeps the card selected (and the picks), so
 *  the player can fix the target and try again. */
async function playSelection(s: Selection | null = sel, given?: Target) {
  if (!s || s !== sel || s.busy) return;
  let target: Target;
  if (given) target = given;
  else if (s.card.target === "buildings") target = { buildings: [...s.picked] };
  else if (s.card.target === "polyline" && s.draft) target = { polyline: s.draft.map((p) => [p[0], p[1]] as [number, number]) };
  else return;
  s.busy = true;
  updateTargeting();
  const e = await uiAct({ type: "play_card", hand_index: s.handIndex, target });
  s.busy = false;
  if (sel !== s) return; // cleared meanwhile (the card left the hand, the phase changed)
  if (e) {
    clearTimeout(trailingMeasure);
    s.draft = null;
    s.draftInfo = null;
    updateTargeting();
    if (s.card.target !== "polyline") setHint(e.message, true);
  } else clearSelection();
}

// Line drag for polyline cards (fortifications, convoy routes): map panning
// is disabled while such a card is selected.
let lastLengthQuery = 0;
let trailingMeasure = 0;
map.on("mousedown", (e) => {
  if (!inGame() || !sel || sel.busy || sel.card.target !== "polyline" || e.originalEvent.button !== 0) return;
  const p = toSim(e.lngLat);
  if (!p) return;
  sel.draft = [p];
  sel.draftInfo = null;
  updateTargeting();
});
map.on("mousemove", (e) => {
  if (!sel?.draft || sel.busy) return;
  const p = toSim(e.lngLat);
  if (!p) return;
  const last = sel.draft[sel.draft.length - 1];
  if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2) sel.draft.push(p);
  // Ask the core for the placed length at most every 80 ms, plus once
  // after the last move, so the hint always ends on the whole line.
  const now = performance.now();
  clearTimeout(trailingMeasure);
  if (now - lastLengthQuery > 80 && sel.draft.length >= 2) {
    lastLengthQuery = now;
    void measureDraft();
  } else trailingMeasure = window.setTimeout(() => void measureDraft(), 100);
  updateTargeting();
});
window.addEventListener("mouseup", () => {
  if (!sel?.draft || sel.busy) return;
  if (sel.draft.length >= 2) void playSelection();
  else {
    sel.draft = null;
    updateTargeting();
  }
});

async function measureDraft() {
  const s = sel;
  if (!s?.draft) return;
  const points = s.draft.length;
  let r: Awaited<ReturnType<typeof fenceLength>>;
  try {
    r = await fenceLength(s.draft.flat());
  } catch {
    return;
  }
  if (sel === s && s.draft && s.draft.length === points) {
    s.draftInfo = { length: r.length, error: r.error };
    updateTargeting();
  }
}

function drawnLength(d: number[][] | null): number {
  if (!d) return 0;
  let l = 0;
  for (let i = 1; i < d.length; i++) l += Math.hypot(d[i][0] - d[i - 1][0], d[i][1] - d[i - 1][1]);
  return l;
}

function selectCard(i: number) {
  const c = hand[i];
  if (!c) return;
  if (sel?.handIndex === i) {
    clearSelection();
    return;
  }
  inspected = null;
  updateInspect();
  sel = { handIndex: i, card: c, picked: [], draft: null, draftInfo: null, busy: false };
  if (c.target === "polyline") map.dragPan.disable();
  else map.dragPan.enable();
  map.getCanvas().style.cursor = c.target === "polyline" ? "crosshair" : "pointer";
  updateTargeting();
  renderHand();
}

/** Drop the selection and everything that goes with it: targeting panel,
 *  hint, cursor, map panning, line draft. */
function clearSelection() {
  sel = null;
  clearTimeout(trailingMeasure);
  map.dragPan.enable();
  map.getCanvas().style.cursor = "";
  updateTargeting();
  renderHand();
}

function setHint(t: string, over = false) {
  const h = $("hint");
  h.textContent = t;
  h.classList.toggle("over", over);
}

function updateTargeting() {
  $("targeting").hidden = !sel;
  if (!sel) return;
  const c = sel.card;
  const def = CARDS.get(c.card);
  $("sel-name").textContent = `${c.name} · ${c.cost} supply`;
  const place = $("sel-place") as HTMLButtonElement;
  place.hidden = c.target !== "buildings";
  if (c.target === "buildings") {
    const max = def?.effect.buildings ?? 1;
    setHint(`Click up to ${max} highlighted building${max > 1 ? "s" : ""} (${sel.picked.length}/${max})`);
    place.textContent = `Place (${sel.picked.length}/${max})`;
    place.disabled = sel.picked.length === 0 || sel.busy;
  } else if (c.target === "polyline") {
    const limit = def?.effect.length_m;
    if (!sel.draft) setHint(limit ? `Drag a line on open ground (up to ${limit} m)` : "Drag the route");
    else {
      const info = sel.draftInfo;
      if (info?.error) setHint(info.error, true);
      else {
        const placed = info?.length ?? null;
        const shown = placed !== null ? `${placed.toFixed(0)} m placed` : `${drawnLength(sel.draft).toFixed(0)} m drawn`;
        setHint(`${shown}${limit ? ` / ${limit} m` : ""} · cost ${c.cost}`, !!limit && placed !== null && placed > limit);
      }
    }
  } else {
    setHint(c.kind === "tactical" ? "Click a point in the revealed area (during the wave)" : "Click a point");
  }
}

function updateInspect() {
  $("inspect").hidden = !inspected;
  if (!inspected) return;
  const s = structures.find((x) => x.id === inspected!.id);
  if (!s) {
    inspected = null;
    $("inspect").hidden = true;
    return;
  }
  const name = CARDS.get(s.card)?.name ?? s.card;
  const prep = phase() === "prep";
  const { repairCost, refund } = inspected;
  $("inspect").dataset.structure = String(s.id);
  $("i-name").textContent = `${name} (wave ${s.wave})`;
  const what = s.kind.type === "fence" ? `${s.kind.length_m.toFixed(0)} m of fence` : `${s.kind.buildings.length} building${s.kind.buildings.length > 1 ? "s" : ""}`;
  $("i-info").textContent = prep ? what : `${what} · repair and pull-down in prep only`;
  const rep = $("i-repair") as HTMLButtonElement;
  rep.hidden = s.kind.type !== "fence";
  rep.textContent = repairCost >= 0 ? `Repair (${repairCost} supply)` : "Repair (intact)";
  rep.disabled = !prep || repairCost < 0;
  const pull = $("i-pull") as HTMLButtonElement;
  pull.textContent = `Pull down (+${Math.max(0, refund)} supply)`;
  pull.disabled = !prep || refund < 0;
}

function closeInspect() {
  inspected = null;
  updateInspect();
}

// Costs change with damage and phase: ask the worker again for the
// inspected structure's numbers (one query at a time; a change meanwhile
// asks once more).
let inspectAsking = false;
let inspectAgain = false;
async function refreshInspect() {
  if (!inspected) return;
  if (inspectAsking) {
    inspectAgain = true;
    return;
  }
  inspectAsking = true;
  try {
    do {
      inspectAgain = false;
      const ins: typeof inspected = inspected;
      if (!ins) break;
      if (!structures.some((x) => x.id === ins.id)) {
        closeInspect();
        break;
      }
      let c: Awaited<ReturnType<typeof costsOf>>;
      try {
        c = await costsOf(ins.id);
      } catch {
        break; // the match stopped
      }
      if (inspected !== ins) continue;
      if (!c.exists) {
        closeInspect();
        break;
      }
      ins.repairCost = c.repairCost;
      ins.refund = c.refund;
      updateInspect();
    } while (inspectAgain);
  } finally {
    inspectAsking = false;
  }
}

// ---------------------------------------------------------------- hand
/** The keep marks as they will be once the pending clicks are answered. */
function keptNow(): number[] {
  return keepPending ? [...keepPending.list] : hand.filter((h) => h.keep).map((h) => h.hand_index);
}

async function toggleKeep(i: number) {
  const list = keptNow();
  const at = list.indexOf(i);
  if (at >= 0) list.splice(at, 1);
  else list.push(i);
  keepPending = { list, inFlight: (keepPending?.inFlight ?? 0) + 1 };
  renderHand();
  const e = await uiAct({ type: "keep_cards", hand_indices: [...list] });
  const p = keepPending;
  if (!p) return;
  p.inFlight--;
  if (e) {
    // Refused: take this toggle back from what later clicks build on.
    const k = p.list.indexOf(i);
    if (at >= 0 && k < 0) p.list.push(i);
    else if (at < 0 && k >= 0) p.list.splice(k, 1);
  }
  if (p.inFlight === 0) keepPending = null;
  renderHand();
}

function renderHand() {
  const el = $("hand");
  // Keep the keyboard focus on the same card across the rebuild.
  const focused = el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  const focusIndex = focused?.closest<HTMLElement>(".hcard")?.dataset.index;
  const focusKeep = !!focused?.classList.contains("c-keep");
  const kept = keptNow();
  el.replaceChildren();
  for (const c of hand) {
    const def = CARDS.get(c.card);
    const b = document.createElement("div");
    b.className = `hcard rarity-${c.rarity}${c.playable ? "" : " unplayable"}${sel?.handIndex === c.hand_index ? " selected" : ""}`;
    b.dataset.card = c.card;
    b.dataset.index = String(c.hand_index);
    b.setAttribute("role", "button");
    b.setAttribute("aria-label", `${c.name}, ${c.kind}, cost ${c.cost}`);
    b.tabIndex = 0;
    const kindLabel = c.kind === "tactical" ? "tactical · wave" : `${c.kind} · prep`;
    b.innerHTML = `<span class="c-cost"></span><span class="c-name"></span><span class="c-kind"></span><span class="c-rarity"></span><span class="c-text"></span>`;
    (b.querySelector(".c-cost") as HTMLElement).textContent = String(c.cost);
    (b.querySelector(".c-name") as HTMLElement).textContent = c.name;
    (b.querySelector(".c-kind") as HTMLElement).textContent = kindLabel;
    (b.querySelector(".c-rarity") as HTMLElement).textContent = c.rarity;
    (b.querySelector(".c-text") as HTMLElement).textContent = def?.text ?? "";
    b.addEventListener("click", () => selectCard(c.hand_index));
    // Enter or Space on the focused card selects it (and Space does not
    // also reach the window's pause shortcut).
    b.addEventListener("keydown", (ev) => {
      if (ev.target !== b || (ev.key !== "Enter" && ev.key !== " ")) return;
      ev.preventDefault();
      ev.stopPropagation();
      selectCard(c.hand_index);
    });
    const isKept = kept.includes(c.hand_index);
    const keep = document.createElement("button");
    keep.className = `c-keep${isKept ? " on" : ""}`;
    keep.textContent = isKept ? "Kept for next wave" : "Keep";
    keep.title = "Keep this card for the next wave (up to 2); the others are discarded";
    keep.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void toggleKeep(c.hand_index);
    });
    b.appendChild(keep);
    el.appendChild(b);
    if (focusIndex === String(c.hand_index)) (focusKeep ? keep : b).focus();
  }
}

// ---------------------------------------------------------------- frame
function fenceColor(hp: number): [number, number, number, number] {
  // Intact fences are near-black (readable on the light map), red when nearly broken.
  const t = Math.max(0, Math.min(1, hp));
  return [Math.round(230 - 190 * t), 40, Math.round(40 + 12 * t), 255];
}

function buildFieldImage(data: Int32Array, w: number, h: number): HTMLCanvasElement {
  const INF = Math.floor((2 ** 31 - 1) / 4); // sim-core field::INF = i32::MAX / 4
  const vals: number[] = [];
  for (let i = 0; i < data.length; i += 7) if (data[i] < INF) vals.push(data[i]);
  vals.sort((a, b) => a - b);
  const lo = vals[0] ?? 0;
  const hi = vals[Math.floor(vals.length * 0.98)] ?? 1;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      const o = ((h - 1 - y) * w + x) * 4; // canvas row 0 = top = highest y
      if (v >= INF) continue;
      const t = Math.max(0, Math.min(1, (v - lo) / Math.max(1, hi - lo)));
      img.data[o] = 40 + 200 * t;
      img.data[o + 1] = 20 + 180 * t;
      img.data[o + 2] = 120 + 120 * t;
      img.data[o + 3] = 150;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

let frames = 0;
let fps = 0;
let fpsT = performance.now();

function frame() {
  requestAnimationFrame(frame);
  frames++;
  const now = performance.now();
  if (now - fpsT >= 1000) {
    fps = (frames * 1000) / (now - fpsT);
    frames = 0;
    fpsT = now;
    $("h-fps").textContent = fps.toFixed(0);
    if (fieldKind !== "none" && phase() === "running") send({ type: "field", kind: fieldKind });
  }
  if (!level) return;

  // Pick the two latest snapshots and the interpolation factor.
  let prev: F32, cur: F32, render: U8, seq: number, alpha: number;
  if (shared) {
    const h = headerViews(shared);
    const latest = Atomics.load(h.i32, H_LATEST);
    seq = Atomics.load(h.i32, H_SEQ);
    n = Atomics.load(h.i32, H_COUNT);
    const a = slotViews(shared, level.capacity, (latest + SLOTS - 1) % SLOTS);
    const b = slotViews(shared, level.capacity, latest);
    prev = a.pos;
    cur = b.pos;
    render = b.render;
    alpha = (nowAbs() - h.f64[H_TIME]) / Math.max(1, h.f64[H_INTERVAL]);
  } else {
    if (!fbCur) return;
    n = fbCur.count;
    prev = fbPrev && fbPrev.count >= n ? fbPrev.pos : fbCur.pos;
    cur = fbCur.pos;
    render = fbCur.render;
    seq = fbSeq;
    const interval = fbPrev ? Math.max(1, fbCur.time - fbPrev.time) : 50;
    alpha = (nowAbs() - fbCur.time) / interval;
  }
  if (perf?.paused || phase() !== "running") alpha = 1;
  alpha = Math.max(0, Math.min(1, alpha));

  posFlip ^= 1;
  const pos = posBufs[posFlip];
  for (let i = 0; i < n * 2; i++) pos[i] = prev[i] + (cur[i] - prev[i]) * alpha;

  if (seq !== lastSeq) {
    lastSeq = seq;
    colFlip ^= 1;
    const col = colBufs[colFlip];
    for (let i = 0; i < n; i++) {
      const c = COLORS[render[i]] ?? COLORS[4];
      const o = i * 4;
      col[o] = c[0];
      col[o + 1] = c[1];
      col[o + 2] = c[2];
      col[o + 3] = c[3];
    }
  }
  renderLayers(pos, colBufs[colFlip]);
}

// Layer data derived from placements, rebuilt only when the arrays change so
// deck.gl doesn't re-process unchanged layers every frame.
type Pt = { x: number; y: number };
let pdCache: { t: F32 | null; f: F32 | null; s: Structure[] | null; garrisonData: Bld[]; towerData: (Pt & { r: number })[]; unitData: Pt[]; fenceData: (Pt & { hp: number })[] } = {
  t: null,
  f: null,
  s: null,
  garrisonData: [],
  towerData: [],
  unitData: [],
  fenceData: [],
};
function placementData() {
  if (pdCache.t !== towers || pdCache.s !== structures) {
    const garrisoned = new Set<number>();
    const towerData: (Pt & { r: number })[] = [];
    const unitData: Pt[] = [];
    for (let i = 0; i < towers.length; i += 5) {
      if (towers[i] >= 0) {
        garrisoned.add(towers[i]);
        towerData.push({ x: towers[i + 1], y: towers[i + 2], r: towers[i + 3] });
      } else unitData.push({ x: towers[i + 1], y: towers[i + 2] });
    }
    pdCache.t = towers;
    pdCache.s = structures;
    pdCache.towerData = towerData;
    pdCache.unitData = unitData;
    pdCache.garrisonData = buildings.filter((b) => garrisoned.has(b.index));
  }
  if (pdCache.f !== fences) {
    const fenceData: (Pt & { hp: number })[] = [];
    for (let i = 0; i < fences.length; i += 3) fenceData.push({ x: fences[i], y: fences[i + 1], hp: fences[i + 2] });
    pdCache.f = fences;
    pdCache.fenceData = fenceData;
  }
  return pdCache;
}

/** Buildings an armament can go on now: revealed (the core's rule: centroid
 *  inside the current ring, at least one cell) and not garrisoned yet. */
function garrisonable(): Bld[] {
  if (!status) return [];
  const taken = new Set<number>();
  for (let i = 0; i < towers.length; i += 5) if (towers[i] >= 0) taken.add(towers[i]);
  return buildings.filter((b) => b.cells > 0 && b.wave <= status!.wave && !taken.has(b.index));
}
let validCache: { key: unknown[]; data: Bld[] } = { key: [], data: [] };
function validBuildings(): Bld[] {
  const key = [towers, buildings, status?.wave];
  if (key.some((k, i) => k !== validCache.key[i])) validCache = { key, data: garrisonable() };
  return validCache.data;
}

// One stable data object for the agent layer: replacing `data` every frame
// would make deck.gl rebuild every attribute (including 100k picking colours).
let agentDataObj: { length: number; attributes: Record<string, unknown> } | null = null;
let frameId = 0;
function agentData(pos: F32, col: U8) {
  if (!agentDataObj || agentDataObj.length !== n) agentDataObj = { length: n, attributes: {} };
  agentDataObj.attributes.getPosition = { value: pos, size: 2 };
  agentDataObj.attributes.getFillColor = { value: col, size: 4, normalized: true };
  frameId++;
  return agentDataObj;
}

function circle(cx: number, cy: number, r: number, reverse: boolean): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < 128; i++) {
    const t = ((reverse ? -i : i) / 128) * 2 * Math.PI;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

// Fog: the next ring (between the revealed radius and the next ring's) is
// darkened but stays readable; everything past it is darker still. No
// agents are ever there (cells outside the revealed disc are walls).
let fogCache: { key: string; outside: number[][][]; ring: number[][][] | null } | null = null;
function fogRadii() {
  const r = status?.radius_m ?? level!.rings[0];
  return { revealed: r, next: status && status.wave < status.waves ? status.next_radius_m : r };
}
function fogPolygons() {
  const [cx, cy] = level!.center;
  const { revealed: r, next } = fogRadii();
  const key = `${cx},${cy},${r},${next}`;
  if (fogCache?.key !== key) {
    const R = 20000;
    const outer = [[cx - R, cy - R], [cx + R, cy - R], [cx + R, cy + R], [cx - R, cy + R]];
    fogCache = {
      key,
      outside: [outer, circle(cx, cy, next, true)],
      ring: next > r ? [circle(cx, cy, next, false), circle(cx, cy, r, true)] : null,
    };
  }
  return fogCache;
}

function renderLayers(pos: F32, col: U8) {
  if (!level || !geo) return;
  const { garrisonData, towerData, unitData, fenceData } = placementData();
  const half = level.cell / 2;
  const g = geoProps;
  const fog = fogPolygons();
  const picking = sel?.card.target === "buildings";
  const pickedSet = new Set(sel?.picked ?? []);
  const inspectedCells = inspectedFenceCells();
  const layers: unknown[] = [
    new SolidPolygonLayer({ ...g, id: "outside", data: [fog.outside], getPolygon: (d: number[][][]) => d as never, getFillColor: [16, 18, 22, 160] }),
    fog.ring && new SolidPolygonLayer({ ...g, id: "fog", data: [fog.ring], getPolygon: (d: number[][][]) => d as never, getFillColor: [16, 18, 22, 95] }),
    fieldImage &&
      new BitmapLayer({
        ...g,
        id: "field",
        image: fieldImage,
        bounds: [0, 0, level.gridW * level.cell, level.gridH * level.cell],
        opacity: 0.75,
        textureParameters: { minFilter: "nearest", magFilter: "nearest" },
      }),
    new PolygonLayer({
      ...g,
      id: "buildings",
      data: buildings,
      getPolygon: (d: Bld) => d.polygon,
      getFillColor: [70, 62, 56, 40],
      getLineColor: [70, 62, 56, 90],
      lineWidthMinPixels: 0.5,
      stroked: true,
    }),
    picking &&
      new PolygonLayer({
        ...g,
        id: "valid",
        data: validBuildings(),
        getPolygon: (d: Bld) => d.polygon,
        getFillColor: (d: Bld) => (pickedSet.has(d.index) ? [60, 140, 255, 170] : [60, 140, 255, 45]),
        getLineColor: [40, 110, 230, 220],
        lineWidthMinPixels: 1.2,
        stroked: true,
        updateTriggers: { getFillColor: [...pickedSet].join(",") },
      }),
    new PolygonLayer({
      ...g,
      id: "garrisons",
      data: garrisonData,
      getPolygon: (d: Bld) => d.polygon,
      filled: true,
      stroked: true,
      getFillColor: [30, 170, 90, 110],
      getLineColor: [20, 140, 70, 255],
      lineWidthMinPixels: 2,
    }),
    new ScatterplotLayer({
      ...g,
      id: "ranges",
      data: towerData,
      getPosition: (d: Pt) => [d.x, d.y],
      getRadius: (d: { r: number }) => d.r,
      radiusUnits: "meters",
      stroked: true,
      getFillColor: [30, 170, 90, 22],
      getLineColor: [20, 140, 70, 150],
      lineWidthMinPixels: 1.2,
    }),
    showHash && hashLayer(),
    new SolidPolygonLayer({
      ...g,
      id: "fences",
      data: fenceData,
      getPolygon: (d: Pt) => [
        [d.x - half, d.y - half],
        [d.x + half, d.y - half],
        [d.x + half, d.y + half],
        [d.x - half, d.y + half],
      ],
      getFillColor: (d: { hp: number }) => fenceColor(d.hp),
    }),
    inspectedCells.length > 0 &&
      new ScatterplotLayer({
        ...g,
        id: "inspected",
        data: inspectedCells,
        getPosition: (d: Pt) => [d.x, d.y],
        getRadius: level.cell,
        radiusUnits: "meters",
        getFillColor: [255, 200, 40, 150],
      }),
    new ScatterplotLayer({
      ...g,
      id: "agents",
      data: agentData(pos, col) as never,
      updateTriggers: { getPosition: frameId, getFillColor: lastSeq },
      radiusUnits: "meters",
      getRadius: 0.8,
      radiusMinPixels: 1.8,
      // A dark rim keeps the dots readable on the light street map.
      stroked: true,
      getLineColor: [20, 20, 24, 170],
      lineWidthUnits: "pixels",
      getLineWidth: 0.6,
      parameters: { depthCompare: "always" },
    }),
    unitData.length > 0 &&
      new ScatterplotLayer({
        ...g,
        id: "units",
        data: unitData,
        getPosition: (d: Pt) => [d.x, d.y],
        radiusUnits: "meters",
        getRadius: 2.5,
        radiusMinPixels: 4,
        stroked: true,
        getFillColor: [40, 200, 110, 255],
        getLineColor: [10, 60, 30, 255],
        lineWidthMinPixels: 1.5,
      }),
    sel?.draft &&
      new PathLayer({
        ...g,
        id: "draft",
        data: [sel.draft],
        getPath: (d: number[][]) => d as [number, number][],
        getColor: sel.draftInfo?.error || draftOver() ? [230, 40, 40, 255] : [40, 40, 48, 230],
        getWidth: level.cell,
        widthUnits: "meters",
        widthMinPixels: 2,
      }),
  ].filter(Boolean);
  drawn = { layers: (layers as { id: string }[]).map((l) => l.id), fogRadius: fogRadii(), agents: n };
  overlay.setProps({ layers: layers as never });
}
// What the last frame drew (the test hook reads it).
let drawn: { layers: string[]; fogRadius: { revealed: number; next: number }; agents: number } = { layers: [], fogRadius: { revealed: 0, next: 0 }, agents: 0 };

function draftOver(): boolean {
  if (!sel?.draftInfo || sel.draftInfo.length === null) return false;
  const limit = CARDS.get(sel.card.card)?.effect.length_m;
  return !!limit && sel.draftInfo.length > limit;
}

function inspectedFenceCells(): Pt[] {
  if (!inspected || !level) return [];
  const s = structures.find((x) => x.id === inspected!.id);
  if (!s) return [];
  const w = level.gridW;
  const c = level.cell;
  if (s.kind.type === "fence") return s.kind.cells.map((i) => ({ x: ((i % w) + 0.5) * c, y: (Math.floor(i / w) + 0.5) * c }));
  return s.kind.buildings.map((b) => buildings[b]).filter(Boolean).map((b) => ({ x: b.x, y: b.y }));
}

let hashLines: { s: number[]; t: number[] }[] = [];
function hashLayer() {
  if (!level) return null;
  if (hashLines.length === 0) {
    const [hw, hh, b] = level.hashDims;
    for (let x = 0; x <= hw; x++) hashLines.push({ s: [x * b, 0], t: [x * b, hh * b] });
    for (let y = 0; y <= hh; y++) hashLines.push({ s: [0, y * b], t: [hw * b, y * b] });
  }
  return new LineLayer({
    ...geoProps,
    id: "hash",
    data: hashLines,
    getSourcePosition: (d: { s: number[] }) => d.s as [number, number],
    getTargetPosition: (d: { t: number[] }) => d.t as [number, number],
    getColor: [0, 0, 0, 40],
    getWidth: 1,
  });
}

// ---------------------------------------------------------------- worker messages
worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  if (testTap?.(m)) return;
  // Replies resolve whatever is waiting, even after "← Map".
  if (m.type === "action") {
    pendingActions.get(m.id)?.(m.error);
    pendingActions.delete(m.id);
    return;
  }
  if (m.type === "query") {
    const p = pendingQueries.get(m.id);
    pendingQueries.delete(m.id);
    if ("aborted" in m) p?.fail(new Error(ABORTED));
    else p?.ok(m.result);
    return;
  }
  if (m.type === "record") {
    const p = pendingRecords.get(m.id);
    pendingRecords.delete(m.id);
    if ("aborted" in m) p?.fail(new Error(ABORTED));
    else p?.ok(m.json);
    return;
  }
  if (document.body.dataset.screen !== "game") return; // late messages after "← Map"
  switch (m.type) {
    case "ready": {
      level = m.level;
      shared = m.shared;
      posBufs = [new Float32Array(level.capacity * 2), new Float32Array(level.capacity * 2)];
      colBufs = [new Uint8Array(level.capacity * 4), new Uint8Array(level.capacity * 4)];
      lastSeq = -1;
      n = 0;
      fbPrev = fbCur = null;
      hashLines = [];
      fieldImage = null;
      fogCache = null;
      pdCache = { t: null, f: null, s: null, garrisonData: [], towerData: [], unitData: [], fenceData: [] };
      $("fallback").hidden = !!shared;
      $("result").hidden = true;
      shownResult = null;
      updateGeoProps();
      $("loading").hidden = true;
      break;
    }
    case "geometry":
      setGeometry(m.geometry);
      break;
    case "frame":
      fbPrev = fbCur;
      fbCur = { pos: m.pos, render: m.render, time: m.time, count: m.count };
      fbSeq++;
      break;
    case "status": {
      const prev = status;
      status = m.status;
      perf = m.perf;
      if (!fitted || (prev && prev.wave !== status.wave)) {
        fitView(fitted);
        fitted = true;
      }
      // A retry or a restart (even one that stays in prep) is a new prep:
      // structure ids may be reused, the hand is new.
      const reset = !!prev && (prev.retries !== status.retries || prev.restarts !== status.restarts);
      if (prev?.phase !== status.phase || reset) onPhaseChange(reset);
      updateControls();
      updateHud();
      break;
    }
    case "state":
      hand = m.hand;
      structures = m.structures;
      results = m.results;
      attempts = m.attempts;
      if (sel) {
        // The card at the selected position changed (played, retried,
        // redrawn): the selection was for another card, drop it.
        const c = hand[sel.handIndex];
        if (!c || c.card !== sel.card.card) clearSelection();
        else sel.card = c;
      }
      renderHand();
      void refreshInspect();
      updateControls();
      break;
    case "placements":
      towers = m.towers;
      fences = m.fences;
      // Fence damage changes the inspected fence's repair cost and refund.
      void refreshInspect();
      break;
    case "error":
      if (m.fatal) prepError(m.message);
      else toast(m.message);
      break;
    case "map":
      session?.onWorker(m);
      if (m.refused.length) toast(`Map error: the match refused ${m.refused.length} block${m.refused.length > 1 ? "s" : ""} (see the console)`);
      break;
    case "field":
      fieldImage = buildFieldImage(m.data, m.w, m.h);
      break;
  }
};

function setGeometry(g: Geometry) {
  buildings = [];
  const o = g.buildingOffsets;
  const c = g.buildingCoords;
  const info = g.buildingInfo;
  for (let b = 0; b + 1 < o.length; b++) {
    const poly: number[][] = [];
    for (let k = o[b]; k < o[b + 1]; k++) poly.push([c[2 * k], c[2 * k + 1]]);
    const j = 6 * b;
    buildings.push({ polygon: poly, index: b, x: info[j], y: info[j + 1], area: info[j + 2], floors: info[j + 3], cells: info[j + 4], wave: info[j + 5] });
  }
  pdCache.t = null;
}

// ---------------------------------------------------------------- UI
function toast(msg: string) {
  const t = $("toast");
  lastToast = msg;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((t as unknown as { _h: number })._h);
  (t as unknown as { _h: number })._h = window.setTimeout(() => (t.hidden = true), 3200);
}

/** The seed input's "New match" (Enter or the button): asks first when it
 *  would throw away a running wave or a result on screen. */
function requestNewMatch() {
  // Nothing to play on yet (a streamed map before its first blocks are in).
  if (!currentLevelJson && !session?.ready) return;
  const seed = parseSeed(($("seed") as HTMLInputElement).value);
  if (seed === null) {
    toast("The seed must be a whole number from 0 to 18446744073709551615");
    return;
  }
  const p = phase();
  if ((p === "running" || shownResult !== null) && !confirm(`Start a new match with seed ${seed}? The current match will be lost.`)) return;
  newMatch();
}

/** A new match on the current level (the seed input's seed, starter deck). */
function newMatch() {
  // Nothing to play on yet (a streamed map before its first blocks are in).
  if (!currentLevelJson && !session?.ready) return;
  const seed = parseSeed(($("seed") as HTMLInputElement).value);
  if (seed === null) {
    toast("The seed must be a whole number from 0 to 18446744073709551615");
    return;
  }
  matchSeed = seed;
  ($("seed") as HTMLInputElement).value = seed;
  prepStatus("Preparing the match…");
  status = null;
  hand = [];
  structures = [];
  results = [];
  attempts = [];
  towers = new Float32Array(0);
  fences = new Float32Array(0);
  buildings = [];
  inspected = null;
  keepPending = null;
  clearSelection();
  updateControls();
  // The starter deck ("Civil Defence Issue") until the deck builder (T7b).
  session?.gate.cancel();
  const s = session;
  // A streamed map: the chunks loaded so far, then each later one as it arrives.
  const map: MatchMap = s ? s.matchMap((chunk) => session === s && send({ type: "chunk", chunk })) : { level: currentLevelJson };
  send({ type: "init", map, setup: { seed }, test: TEST_MODE });
}

// ---------------------------------------------------------------- screens
function prepStatus(msg: string) {
  $("loading").hidden = false;
  $("prep-spin").hidden = false;
  $("prep-actions").hidden = true;
  $("prep-msg").textContent = msg;
}

function prepError(msg: string) {
  $("loading").hidden = false;
  $("prep-spin").hidden = true;
  $("prep-actions").hidden = false;
  $("prep-msg").textContent = msg;
}

const placeKey = (p: Place) => p.presetUrl ?? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

async function enterGame(place: Place) {
  document.body.dataset.screen = "game";
  explore.setActive(false);
  overlay.setProps({ layers: [] });
  setGeo(place.lat, place.lon);
  currentPlace = place;
  $("place").textContent = place.name;
  $("place").title = place.name;
  $("result").hidden = true;
  level = null;
  status = null;
  fitted = false;
  fitView();
  updateControls();
  prepAbort?.abort();
  session?.abort();
  session = null;
  currentLevelJson = "";
  const abort = new AbortController();
  prepAbort = abort;
  if (!place.presetUrl) return enterStreamed(place, abort);
  try {
    let json = levelCache.get(placeKey(place));
    if (!json) {
      prepStatus("Loading level…");
      json = await (await fetch(place.presetUrl!, { signal: abort.signal })).text();
      levelCache.set(placeKey(place), json);
    }
    if (abort.signal.aborted) return;
    const meta = JSON.parse(json) as { radius_m: number; center_lat: number; center_lon: number; buildings: unknown[] };
    setGeo(meta.center_lat, meta.center_lon);
    $("place").title = `${place.name} · ${meta.buildings.length} buildings · radius ${meta.radius_m} m`;
    currentLevelJson = json;
    newMatch();
  } catch (e) {
    if (abort.signal.aborted) return;
    prepError(e instanceof Error ? e.message : String(e));
  }
}

/** A picked place: its map streams in blocks (waves 1–2 first, then the
 *  rest in the background, closest ring first), cached in IndexedDB. */
async function enterStreamed(place: Place, abort: AbortController) {
  let s: MapSession | null = null;
  try {
    s = await MapSession.open(place.name, place.lat, place.lon, TEST_MODE ? { backoffMs: TEST_BACKOFF_MS } : {});
    if (abort.signal.aborted) return s.abort();
    session = s;
    setGeo(s.shell.center_lat, s.shell.center_lon);
    await s.start((loaded, needed) => {
      if (session === s) prepStatus(`Downloading the map… ${loaded} / ${needed} blocks`);
    });
    if (session !== s) return;
    $("place").title = `${place.name} · streamed map, radius ${s.shell.radius_m} m · first blocks in ${(s.firstLoadMs / 1000).toFixed(1)} s`;
    newMatch();
  } catch (e) {
    if (abort.signal.aborted || (s && session !== s)) return;
    s?.abort();
    session = null;
    prepError(e instanceof Error ? e.message : String(e));
  }
}

function backToMap() {
  prepAbort?.abort();
  session?.abort();
  session = null;
  send({ type: "stop" });
  level = null;
  status = null;
  hand = [];
  currentLevelJson = "";
  $("result").hidden = true;
  clearSelection();
  inspected = null;
  updateInspect();
  renderHand();
  document.body.dataset.screen = "explore";
  overlay.setProps({ layers: [] });
  explore.setActive(true);
}

function fmtTime(ticks: number) {
  const s = Math.floor(ticks / 20);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const PHASE_LABEL: Record<string, string> = { prep: "Prep", running: "Outbreak", wave_won: "Wave won", wave_lost: "Wave lost", match_won: "Match won" };

function updateControls() {
  const p = phase();
  const startBtn = $("start") as HTMLButtonElement;
  const district = session?.gate.waiting != null;
  startBtn.disabled = phaseBusy || district || (p !== "prep" && p !== "wave_won");
  startBtn.textContent = p === "wave_won" ? "Next wave" : "Start wave";
  ($("pause") as HTMLButtonElement).disabled = p !== "running";
  $("pause").textContent = perf?.paused ? "Resume" : "Pause";
  for (const s of [1, 2, 4]) $(`speed-${s}`).classList.toggle("on", perf?.speed === s);
  // Retry in prep would only count a retry: the prep is already the start.
  ($("retry") as HTMLButtonElement).disabled = phaseBusy || !p || p === "prep" || p === "match_won";
  ($("restart") as HTMLButtonElement).disabled = phaseBusy || !p;
  for (const id of ["r-next", "r-retry", "r-restart"]) ($(id) as HTMLButtonElement).disabled = phaseBusy;
  ($("r-next") as HTMLButtonElement).disabled = phaseBusy || district;
  const mull = $("mulligan") as HTMLButtonElement;
  mull.textContent = `Mulligan (${status?.mulligan_cost ?? 1} supply)`;
  mull.disabled = phaseBusy || !status?.mulligan_available;
  $("phase").textContent = !p ? "Loading" : perf?.paused && p === "running" ? "Paused" : PHASE_LABEL[p];
  $("phase").dataset.phase = p ?? "";
  $("t-title").textContent = p === "running" ? "Wave" : p === "prep" ? "Prep" : "Between waves";
  $("t-help").textContent =
    p === "prep"
      ? "Play fortifications and armaments from your hand, click a structure to repair or pull it down, then Start wave."
      : p === "running"
        ? "Only tactical cards can be played now."
        : "";
  updateInspect();
}

function updateHud() {
  const s = status;
  if (!s) return;
  const set = (id: string, v: string) => ($(id).textContent = v);
  set("h-wave", `${s.wave}/${s.waves}`);
  set("h-time", fmtTime(s.phase === "prep" ? 0 : s.wave_tick));
  set("h-civ", s.stats.civilians.toLocaleString());
  set("h-inf", s.stats.infected.toLocaleString());
  set("h-zom", s.stats.zombies.toLocaleString());
  set("h-dead", s.stats.zombies_killed.toLocaleString());
  set("h-supply", String(s.supply));
  set("h-deck", `${s.deck_count} / ${s.discard_count}`);
  set("h-retries", String(s.retries));
  // Saved: civilians now over the wave's starting civilians (in prep: who
  // will start it), against the defeat line.
  const start = s.phase === "prep" ? s.stats.civilians : s.wave_start_civilians;
  const share = start > 0 ? s.stats.civilians / start : 0;
  const line = start > 0 ? s.defeat_threshold / start : 0.15;
  set("h-saved", start > 0 ? `${(100 * share).toFixed(1)}% · ${s.stats.civilians.toLocaleString()}/${start.toLocaleString()}` : "–");
  const bar = $("h-saved-bar");
  bar.style.width = `${Math.min(100, 100 * share)}%`;
  bar.classList.toggle("low", share < line * 1.5);
  $("h-line").style.left = `${100 * line}%`;
  set("h-line-label", s.phase === "prep" ? "lost below 15%" : `lost below ${s.defeat_threshold.toLocaleString()} civilians (15%)`);
  set("h-fatigue", `${Math.round(100 * s.fatigue)}% speed`);
  $("h-fatigue-bar").style.width = `${Math.round(100 * s.fatigue)}%`;
  if (perf) set("h-sim", `${perf.simMsLast.toFixed(1)} / ${perf.simMsP95.toFixed(1)} ms`);
}

// ---------------------------------------------------------------- results
let shownResult: string | null = null;

/** The phase changed, or a retry or restart opened a new prep (`reset`). */
function onPhaseChange(reset = false) {
  const p = phase();
  // A district wait belongs to the screen it was asked from (a retry or a
  // restart from the result panel ends it).
  session?.gate.cancel();
  // A selection belongs to one phase: the card's rules, the hint and the
  // hand all change with it.
  if (sel) clearSelection();
  // Structure ids are reused after a restart, and a retry puts the
  // structures back: an open inspect panel would show another structure.
  if (reset) closeInspect();
  else void refreshInspect();
  // The worker sends the state (hand, results) before the status that
  // changed the phase, so the results are already here.
  if (p === "wave_won" || p === "wave_lost" || p === "match_won") showResult(p);
  else {
    $("result").hidden = true;
    shownResult = null;
  }
}

function showResult(kind: string) {
  if (!status) return;
  const s = status;
  const r = results[results.length - 1];
  const stats = $("r-stats");
  stats.replaceChildren();
  const row = (k: string, v: string) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    stats.append(dt, dd);
  };
  const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "–");
  const table = $("r-waves") as HTMLTableElement;
  table.hidden = true;
  if (kind === "match_won") {
    $("r-title").textContent = `Match won: ${s.waves} waves cleared`;
    $("r-sub").textContent = s.retries === 0 ? "No retry: the no-retry bonus applies." : `${s.retries} ${s.retries === 1 ? "retry" : "retries"}.`;
    const last = results[results.length - 1];
    row("Civilians saved", last ? `${last.end_civilians.toLocaleString()} (${pct(last.end_civilians, last.start_civilians)} of wave ${last.wave})` : "–");
    row("Zombies killed", results.reduce((a, w) => a + w.zombies_killed, 0).toLocaleString());
    row("Retries", String(s.retries));
    row("Wave attempts", String(attempts.length));
    row("Game time", fmtTime(results.reduce((a, w) => a + w.ticks, 0)));
    table.replaceChildren();
    const head = table.insertRow();
    for (const h of ["Wave", "Start", "Saved", "%", "Killed"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    for (const w of results) {
      const tr = table.insertRow();
      for (const v of [String(w.wave), w.start_civilians.toLocaleString(), w.end_civilians.toLocaleString(), pct(w.end_civilians, w.start_civilians), w.zombies_killed.toLocaleString()]) tr.insertCell().textContent = v;
    }
    table.hidden = false;
  } else {
    const won = kind === "wave_won";
    $("r-title").textContent = won ? `Wave ${s.wave} held` : `Wave ${s.wave} lost`;
    $("r-sub").textContent = won ? "No zombies or infected left." : "Fewer than 15% of the wave's civilians are left.";
    if (r) {
      row("Outcome", won ? "Won" : "Lost");
      row("Saved", `${r.end_civilians.toLocaleString()} / ${r.start_civilians.toLocaleString()} (${pct(r.end_civilians, r.start_civilians)})`);
      row("Zombies killed", r.zombies_killed.toLocaleString());
      row("Supply earned", won ? `+${r.supply_earned}` : "0");
      row("Time", fmtTime(r.ticks));
    }
  }
  $("result").dataset.kind = kind;
  ($("r-next") as HTMLButtonElement).hidden = kind !== "wave_won";
  ($("r-retry") as HTMLButtonElement).hidden = kind === "match_won";
  ($("r-download") as HTMLButtonElement).hidden = kind !== "match_won";
  ($("r-download-map") as HTMLButtonElement).hidden = kind !== "match_won" || !session;
  ($("r-map") as HTMLButtonElement).hidden = kind !== "match_won";
  $("r-retry").classList.toggle("primary", kind === "wave_lost");
  $("result").hidden = false;
  shownResult = kind;
}

function saveJson(json: string, kind: string) {
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  const place = (currentPlace?.name ?? "match").normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  a.href = URL.createObjectURL(blob);
  a.download = `zombie-td-${kind}-${place}-seed${matchSeed}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function downloadRecord() {
  saveJson(await fetchRecord(), "run");
}

/** The streamed map of this run (shell + the record's blocks): verify with
 *  `sim-headless verify run.json --chunks map.json --shell map.json`. */
async function mapBundleJson(): Promise<string> {
  const s = session;
  if (!s) throw new Error("not a streamed match");
  return s.bundle(await fetchRecord());
}
async function downloadMap() {
  saveJson(await mapBundleJson(), "map");
}

// ---------------------------------------------------------------- wiring
$("back").addEventListener("click", backToMap);
$("prep-back").addEventListener("click", backToMap);
$("r-map").addEventListener("click", backToMap);
$("prep-retry").addEventListener("click", () => currentPlace && enterGame(currentPlace));
// The seed only commits on Enter or New match (a blur alone does nothing).
$("seed").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") requestNewMatch();
});
$("new-match").addEventListener("click", requestNewMatch);
$("start").addEventListener("click", () => void waveAct({ type: phase() === "wave_won" ? "next_wave" : "start_wave" }));
$("pause").addEventListener("click", () => send({ type: "pause", paused: !perf?.paused }));
for (const s of [1, 2, 4]) $(`speed-${s}`).addEventListener("click", () => send({ type: "speed", speed: s }));
/** Retry and restart drop the selection and the inspect panel at once. */
function resetAct(action: Action) {
  clearSelection();
  closeInspect();
  void phaseAct(action);
}
$("retry").addEventListener("click", () => resetAct({ type: "retry_wave" }));
$("restart").addEventListener("click", () => resetAct({ type: "restart_match" }));
$("mulligan").addEventListener("click", () => {
  clearSelection();
  void phaseAct({ type: "mulligan" });
});
$("sel-place").addEventListener("click", () => void playSelection());
$("sel-cancel").addEventListener("click", () => clearSelection());
$("i-repair").addEventListener("click", () => inspected && void uiAct({ type: "repair", fence_id: inspected.id }).then(closeInspect));
$("i-pull").addEventListener("click", () => inspected && void uiAct({ type: "pull_down", placement_id: inspected.id }).then(closeInspect));
$("i-close").addEventListener("click", closeInspect);
$("r-next").addEventListener("click", () => void waveAct({ type: "next_wave" }));
$("d-retry").addEventListener("click", () => session?.gate.retry());
$("r-retry").addEventListener("click", () => resetAct({ type: "retry_wave" }));
$("r-restart").addEventListener("click", () => resetAct({ type: "restart_match" }));
$("r-download").addEventListener("click", () => void downloadRecord());
$("r-download-map").addEventListener("click", () => void downloadMap());
$("r-close").addEventListener("click", () => ($("result").hidden = true));
$("fit").addEventListener("click", () => fitView());
for (const k of ["none", "chase", "flee"] as const) {
  $(`field-${k}`).addEventListener("click", () => {
    fieldKind = k;
    for (const j of ["none", "chase", "flee"]) $(`field-${j}`).classList.toggle("on", j === k);
    fieldImage = null;
    if (k !== "none") send({ type: "field", kind: k });
  });
}
$("hash-toggle").addEventListener("change", (e) => (showHash = (e.target as HTMLInputElement).checked));
window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
  if (e.key === "Escape") {
    clearSelection();
    inspected = null;
    updateInspect();
  }
  // Space on a focused button or card activates that control only.
  if (e.key === " " && phase() === "running" && !t.closest("button, [role=button]")) {
    e.preventDefault();
    send({ type: "pause", paused: !perf?.paused });
  }
});

requestAnimationFrame(frame);
