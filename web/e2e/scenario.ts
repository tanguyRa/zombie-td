// The scripted 8-wave match of the browser match test (match.spec.ts),
// shared with the Node check (bot-check.mts). It covers everything T5's
// test must show: a deliberately lost wave 1 and its retry, a mulligan,
// keep choices, a same-prep pull-down, repairs, tactical cards mid-wave, and
// the bot (bot.ts) for the rest. The `ui` callbacks let the browser test
// make some of those plays with real clicks and drags instead.
import { type BotApi, type CardInfo, keepTactical, pickTowers, fenceRadius, playPrep, zombieHotspot } from "./bot.ts";

export interface Status {
  tick: number;
  wave: number;
  waves: number;
  phase: "prep" | "running" | "wave_won" | "wave_lost" | "match_won";
  wave_tick: number;
  supply: number;
  retries: number;
  mulligan_available: boolean;
}

export interface Structure {
  id: number;
  card: string;
  cost: number;
  wave: number;
  kind: { type: "fence"; cells: number[]; cell_hp: number; length_m: number } | { type: "garrison"; buildings: number[] };
}

export interface ScenarioApi extends BotApi {
  status(): Promise<Status>;
  structures(): Promise<Structure[]>;
  repairCost(id: number): Promise<number>;
  zombies(): Promise<[number, number][]>;
  /** Run the wave to its end, calling `every` on each 40th wave tick. */
  runWave(every: () => Promise<void>): Promise<void>;
  /** Optional UI versions of some plays (the browser test). Each returns
   *  the error message or null, like `apply`. */
  ui?: {
    playArmament?(handIndex: number, buildings: number[]): Promise<string | null>;
    playFence?(handIndex: number, pts: [number, number][]): Promise<string | null>;
    /** Pull down structure `id` (a fence) by clicking it. */
    pullDown?(id: number): Promise<string | null>;
    /** Repair fence `id` by clicking it, then the panel's Repair button. */
    repair?(id: number): Promise<string | null>;
    playTactical?(handIndex: number, p: [number, number]): Promise<string | null>;
    mulligan?(): Promise<string | null>;
    keep?(handIndices: number[]): Promise<string | null>;
    startWave?(): Promise<string | null>;
    /** After a wave ends: the result panel's buttons. */
    nextWave?(): Promise<string | null>;
    retryWave?(): Promise<string | null>;
  };
}

export interface ScenarioLog {
  counts: { mulligans: number; keeps: number; tactical: number; pullDowns: number; repairs: number; uiRepairs: number; lost: number; uiPlays: number };
  waves: { wave: number; attempt: number; result: string; ticks: number }[];
}

const MAX_RETRIES_PER_WAVE = 4;

export async function runScenario(api: ScenarioApi, cardsJson: { cards: ({ id: string } & CardInfo)[] }, say: (s: string) => void = () => {}): Promise<ScenarioLog> {
  const cards: Record<string, CardInfo> = {};
  for (const c of cardsJson.cards) cards[c.id] = c;
  const log: ScenarioLog = { counts: { mulligans: 0, keeps: 0, tactical: 0, pullDowns: 0, repairs: 0, uiRepairs: 0, lost: 0, uiPlays: 0 }, waves: [] };
  const ui = api.ui ?? {};
  const must = async (what: string, r: Promise<string | null>) => {
    const e = await r;
    if (e !== null) throw new Error(`${what}: ${e}`);
  };
  let attempt = 0;
  let uiTacticalDone = false;
  let startTick = 0;

  for (let guard = 0; guard < 80; guard++) {
    const st = await api.status();
    if (st.phase === "match_won") return log;
    if (st.phase === "prep") {
      startTick = st.tick;
      if (st.wave === 1 && attempt === 0) {
        // Attempt 0 of wave 1: no defence at all, so it is lost. Keep
        // nothing (an explicit, empty keep choice).
        await must("keep", (ui.keep ?? ((k) => api.apply({ type: "keep_cards", hand_indices: k })))([]));
        log.counts.keeps++;
      } else {
        await prep(st);
      }
      await must("start", (ui.startWave ?? (() => api.apply({ type: "start_wave" })))());
      say(`wave ${st.wave} attempt ${attempt}: started at tick ${st.tick}`);
      continue;
    }
    if (st.phase === "running") {
      await api.runWave(async () => {
        const v = await api.view();
        const c = v.hand.find((h) => h.kind === "tactical" && h.playable && h.target === "point");
        if (!c) return;
        const p = zombieHotspot(await api.zombies());
        if (!p) return;
        const viaUi = !uiTacticalDone && !!ui.playTactical;
        const e = await (viaUi ? ui.playTactical!(c.hand_index, p) : api.apply({ type: "play_card", hand_index: c.hand_index, target: { point: p } }));
        if (e === null) {
          log.counts.tactical++;
          if (viaUi) {
            uiTacticalDone = true;
            log.counts.uiPlays++;
          }
        }
      });
      continue;
    }
    const done = await api.status();
    log.waves.push({ wave: done.wave, attempt, result: done.phase, ticks: done.tick - startTick });
    say(`wave ${done.wave} attempt ${attempt}: ${done.phase} after ${done.tick - startTick} ticks`);
    if (done.phase === "wave_won") {
      await must("next wave", (ui.nextWave ?? (() => api.apply({ type: "next_wave" })))());
      attempt = 0;
    } else if (done.phase === "wave_lost") {
      log.counts.lost++;
      if (attempt >= MAX_RETRIES_PER_WAVE) throw new Error(`wave ${done.wave} lost ${attempt + 1} times`);
      await must("retry", (ui.retryWave ?? (() => api.apply({ type: "retry_wave" })))());
      attempt++;
    }
  }
  throw new Error("scenario did not finish");

  async function prep(st: Status) {
    const variant = st.wave === 1 ? attempt - 1 : attempt;
    let v = await api.view();
    // A mulligan in wave 2 (once, first attempt), else when the hand has no
    // armament.
    const wantMulligan = (st.wave === 2 && attempt === 0) || !v.hand.some((h) => h.kind === "armament");
    if (wantMulligan && v.mulliganAvailable) {
      await must("mulligan", (ui.mulligan ?? (() => api.apply({ type: "mulligan" })))());
      log.counts.mulligans++;
      v = await api.view();
    }
    // The first prep after the lost wave: one armament and one fence with
    // the UI, then pull the fence down again (same prep: full refund and
    // the card back in hand) and let the bot play everything.
    if (st.wave === 1 && attempt === 1) {
      const arm = v.hand.find((h) => h.kind === "armament" && h.playable);
      if (arm) {
        const b = pickTowers(v, variant, cards[arm.card].effect.buildings!);
        await must("armament", (ui.playArmament ?? ((i, bs) => api.apply({ type: "play_card", hand_index: i, target: { buildings: bs } })))(arm.hand_index, b));
        if (ui.playArmament) log.counts.uiPlays++;
        v = await api.view();
      }
      const fence = v.hand.find((h) => h.kind === "fortification" && h.playable);
      if (fence) {
        // A short straight fence across the core, then pulled down.
        const r = fenceRadius(v);
        const pts: [number, number][] = [
          [v.center[0] - r * 0.5, v.center[1] + r * 0.3],
          [v.center[0] + r * 0.5, v.center[1] + r * 0.3],
        ];
        await must("fence", (ui.playFence ?? ((i, p) => api.apply({ type: "play_card", hand_index: i, target: { polyline: p } })))(fence.hand_index, pts));
        if (ui.playFence) log.counts.uiPlays++;
        const s = (await api.structures()).filter((x) => x.kind.type === "fence").pop()!;
        await must("pull down", (ui.pullDown ?? ((id) => api.apply({ type: "pull_down", placement_id: id })))(s.id));
        log.counts.pullDowns++;
      }
    }
    await playPrep(api, cards, variant, { a: 0.37 * attempt });
    // Repair damaged fences with what supply is left (the first one
    // through the UI: a click on the fence, then Repair).
    for (const s of await api.structures()) {
      if (s.kind.type !== "fence") continue;
      const cost = await api.repairCost(s.id);
      if (cost <= 0 || cost > (await api.status()).supply) continue;
      const viaUi = !!ui.repair && log.counts.uiRepairs === 0;
      if ((await (viaUi ? ui.repair!(s.id) : api.apply({ type: "repair", fence_id: s.id }))) === null) {
        log.counts.repairs++;
        if (viaUi) log.counts.uiRepairs++;
      }
    }
    // Keep the tactical cards (the first keep choice through the UI).
    if (ui.keep && log.counts.keeps === 1) {
      const keep = (await api.view()).hand.filter((h) => h.kind === "tactical").map((h) => h.hand_index).slice(0, 2);
      await must("keep", ui.keep(keep));
    } else await keepTactical(api, 2);
    log.counts.keeps++;
  }
}

