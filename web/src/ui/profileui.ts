// Profile UI (T7b): the local profile on the map screen. A "Match setup"
// block (deck, difficulty, hometown), buttons for the screens (deck
// builder, collection, crates, match history, progress), the coverage
// toggle, and the payout panel shown when a match is claimed. The match
// wiring itself is profilematch.ts; main.ts only calls `matchSetup()`,
// `tracker` and `hook()`.
//
// Plain DOM, in the style of the rest of the page. Every number and rule
// comes from the profile (`ProfileService`) or the core (the deck
// validator is sim-core's `validate_deck` through WASM).
import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import cardsText from "../../../cards.json";
import config from "../../../config.default.json";
import {
  DEFAULT_TABLES,
  LocalProfileService,
  STARTER_DECK_ID,
  TIERS,
  deckErrorMessage,
  memoryProfile,
  placeLabel,
  tierName,
  type CardInstance,
  type CrateOpening,
  type Deck,
  type DeckProblem,
  type MatchClaim,
  type MatchRecord,
  type ProfileExport,
  type ProfileService,
  type Tier,
} from "../profile";
import type { DeckValidator } from "../profile/types";
import { loadWasmDeckValidator } from "./deckvalidator";
import { MatchTracker, type ClaimNotice, type MatchContext, type MatchPlace, type MatchSnapshot } from "./profilematch";
import "./profile.css";

const DECK_KEY = "ztd.activeDeck";
const TIER_KEY = "ztd.tier";
export const STARTER_DECK = `deck-${STARTER_DECK_ID}`;

/** `match.population_multiplier` of the config: the tier's factor applies on top. */
const BASE_MULTIPLIER = (config as unknown as { match: { population_multiplier: number } }).match.population_multiplier;
/** The verifier's accepted range (sim-core `population_multiplier_range`): [0.25, 4] × the base. */
const MULTIPLIER_RANGE: [number, number] = [0.25 * BASE_MULTIPLIER, 4 * BASE_MULTIPLIER];

interface CardText {
  id: string;
  name: string;
  rarity: string;
  kind: string;
  cost: number;
  text: string;
}
const CARD = new Map<string, CardText>((cardsText as unknown as { cards: CardText[] }).cards.map((c) => [c.id, c]));
const cardName = (id: string | null) => (id ? (CARD.get(id)?.name ?? id) : "");

export type ScreenName = "deck" | "collection" | "crates" | "history" | "progress";
const SCREENS: { id: ScreenName; label: string }[] = [
  { id: "deck", label: "Deck builder" },
  { id: "collection", label: "Collection" },
  { id: "crates", label: "Crates" },
  { id: "history", label: "Match history" },
  { id: "progress", label: "Progress" },
];

const TIER_COLORS: Record<Tier, string> = { recruit: "#43a047", veteran: "#1e88e5", elite: "#8e24aa", nightmare: "#e53935" };

/** The match setup from the profile: the active deck's card ids, the tier and its multiplier. */
export type MatchSetupResult =
  | { ok: true; setup: { deck: string[]; population_multiplier: number }; tier: Tier; deckId: string; hometown: boolean }
  | { ok: false; message: string };

/** What the test hook (`window.__zt.profile`) exposes. */
export interface ProfileHook {
  readonly ready: boolean;
  readonly persistent: boolean | null;
  readonly error: string | null;
  /** The match on screen: its id, tier and deck (null when none). */
  readonly match: { matchId: string; tier: Tier; deckId: string; deck: string[]; populationMultiplier: number; hometown: boolean; city: string; district: string; claimed: boolean; live: boolean } | null;
  /** Coverage cells drawn on the map screen by the last refresh (0 when the toggle is off). */
  readonly coverageDrawn: number;
  /** The open screen, or null. */
  readonly screen: ScreenName | null;
  /** The payout panel (an abandoned or fast-forwarded match) or the result panel's payout: its text, or null when hidden. */
  readonly payoutText: string | null;
  state(): Promise<{
    cards: CardInstance[];
    tickets: number;
    decks: Deck[];
    activeDeckId: string;
    tier: Tier;
    unlocked: Tier[];
    highestCleared: Tier | null;
    history: number;
    hometownCrateClaimed: boolean;
    achievements: number;
  }>;
  /** Wait for every profile call made so far (claims, daily events, screens). */
  settle(): Promise<void>;
  /** Every claim of this page: match id, why, whether it paid and how much. */
  claims(): { matchId: string; reason: string; paid: boolean; total: number; noRetryBonus: number; unlocked: Tier[]; cleared: boolean }[];
  openScreen(name: ScreenName): Promise<void>;
  closeScreen(): void;
  setTier(t: Tier): void;
  setDeck(deckId: string): void;
  setHometown(on: boolean): void;
  /** Test-only fast-forward: claim the match on screen as if wave 8 were
   *  cleared (synthetic 8-wave summary, the real record), through the same
   *  claim path and payout panel as a real clear. */
  fastForwardClear(): Promise<{ paid: boolean; total: number; unlocked: Tier[] } | null>;
  /** `claimMatch` again with the stored summary of `matchId` (must pay nothing). */
  claimAgain(matchId: string): Promise<MatchClaim>;
  getMatch(matchId: string): Promise<MatchRecord | null>;
  exportProfile(): Promise<ProfileExport>;
  importProfile(data: ProfileExport): Promise<void>;
  /** Refresh the map-screen bar and the coverage (after an import). */
  refresh(): Promise<void>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== false) e.append(k);
  return e;
}

function button(label: string, props: Partial<Record<string, string>> = {}, onClick?: () => void): HTMLButtonElement {
  const b = el("button", { type: "button", ...props, text: label });
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function errMessage(e: unknown): string {
  return e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

const WAVE_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

/** The provenance stamp, as shown on a card. */
export function stampText(c: CardInstance): string {
  if (!c.stamp) return "Account-bound · starter deck (no stamp, not tradeable)";
  const s = c.stamp;
  const parts = [
    placeLabel(s.district, s.city),
    `${WAVE_WORDS[Math.min(8, Math.max(1, s.wave)) - 1]} wave`,
    tierName(s.tier),
    `${s.populationSaved.toLocaleString("en-US")} saved`,
    s.mvpCard ? `MVP ${cardName(s.mvpCard)}` : null,
    s.date,
  ];
  return parts.filter(Boolean).join(" · ");
}

function deckProblemText(p: DeckProblem, names: Map<string, string>): string {
  if (p.error === "not_owned") return `a card that is not in your collection (${p.instanceId})`;
  if (p.error === "duplicate_instance") return `the same card twice (${names.get(p.instanceId) ?? p.instanceId})`;
  let m = deckErrorMessage(p);
  if ("card" in p) m = m.replace(`"${p.card}"`, `"${cardName(p.card)}"`);
  return m;
}

function cardRow(c: CardInstance): HTMLElement {
  const def = CARD.get(c.cardId);
  return el(
    "div",
    { class: `coll-card rarity-${def?.rarity ?? "common"}${c.foil ? " is-foil" : ""}`, "data-instance": c.instanceId, "data-card": c.cardId },
    el("span", { class: "cc-name", text: def?.name ?? c.cardId }),
    el("span", { class: "cc-rarity", text: def?.rarity ?? "" }),
    c.foil ? el("span", { class: "foil", text: "foil" }) : null,
    c.accountBound ? el("span", { class: "bound", text: "account-bound" }) : null,
    el("span", { class: c.stamp ? "stamp" : "stamp none", text: stampText(c) }),
  );
}

function saveFile(json: string, name: string) {
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const slug = (s: string) => s.normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "match";

export interface ProfileUiDeps {
  map: MlMap;
  toast: (msg: string) => void;
  snapshot: () => MatchSnapshot | null;
  record: () => Promise<string>;
  /** The result panel is showing the match won (the payout goes into it). */
  resultShowsMatchWon: () => boolean;
  /** Open the replay viewer on a stored run record (the history's Replay). */
  openReplay?: (recordJson: string, name: string) => void;
}

export class ProfileUi {
  profile: LocalProfileService | null = null;
  error: string | null = null;
  readonly tracker: MatchTracker;
  readonly ready: Promise<void>;
  private screen: ScreenName | null = null;
  private coverageCount = 0;
  private coverageOn = false;
  private coverageSeq = 0;
  private busy = new Set<Promise<unknown>>();
  // DOM
  private bar!: HTMLElement;
  private deckSel!: HTMLSelectElement;
  private tierSel!: HTMLSelectElement;
  private tierNote!: HTMLElement;
  private home!: HTMLInputElement;
  private warn!: HTMLElement;
  private cratesBtn!: HTMLButtonElement;
  private modal!: HTMLElement;
  private body!: HTMLElement;
  private tabs = new Map<ScreenName, HTMLButtonElement>();
  private payout!: HTMLElement;
  private rPayout!: HTMLElement;
  // Deck builder state.
  private draft: { deckId: string | null; name: string; ids: string[] } | null = null;

  constructor(private readonly d: ProfileUiDeps) {
    this.tracker = new MatchTracker({
      profile: () => this.profile,
      snapshot: d.snapshot,
      record: d.record,
      maxRadiusM: DEFAULT_TABLES.maxDefendedRadiusM,
      onClaim: (n) => this.onClaim(n),
      onDaily: () => void this.refreshBar(),
      onError: (m) => d.toast(m),
    });
    this.buildDom();
    this.ready = this.open();
  }

  // ------------------------------------------------------------- opening

  private async open(validator?: DeckValidator, memory = false): Promise<void> {
    try {
      let validateDeck = validator;
      if (!validateDeck) {
        try {
          validateDeck = await loadWasmDeckValidator();
        } catch (e) {
          // The TS mirror (same rules, same messages) until the core loads.
          console.warn("profile: the WASM deck validator did not load, using the TS mirror", e);
        }
      }
      this.profile = memory ? await memoryProfile({ validateDeck }) : await LocalProfileService.open({ validateDeck });
      this.error = null;
      if (!this.profile.persistent) console.warn("profile: IndexedDB is not available, the profile is kept in memory only");
    } catch (e) {
      this.profile = null;
      this.error = errMessage(e);
      console.error("profile: could not open", e);
    }
    await this.refreshBar();
  }

  // ------------------------------------------------------------- DOM

  private buildDom() {
    const card = document.querySelector(".pick-card");
    this.deckSel = el("select", { id: "p-deck", "aria-label": "Deck" });
    this.tierSel = el("select", { id: "p-tier", "aria-label": "Difficulty" });
    this.tierNote = el("div", { id: "p-tier-note", class: "p-note" });
    this.home = el("input", { id: "p-home", type: "checkbox" });
    this.warn = el("div", { id: "p-warn", class: "p-warn", hidden: "" });
    this.cratesBtn = button("Crates", { id: "p-open-crates" }, () => void this.openScreen("crates"));
    const coverage = el("input", { id: "p-coverage", type: "checkbox" });
    coverage.addEventListener("change", () => {
      this.coverageOn = coverage.checked;
      void this.refreshCoverage();
    });
    this.deckSel.addEventListener("change", () => {
      try {
        localStorage.setItem(DECK_KEY, this.deckSel.value);
      } catch {
        /* nothing to remember */
      }
    });
    this.tierSel.addEventListener("change", () => {
      try {
        localStorage.setItem(TIER_KEY, this.tierSel.value);
      } catch {
        /* nothing to remember */
      }
      this.showTierNote();
    });
    this.bar = el(
      "div",
      { id: "profile-bar" },
      el("div", { class: "pick-label", text: "Match setup" }),
      el("div", { class: "p-row" }, el("label", {}, "Deck", this.deckSel), el("label", {}, "Difficulty", this.tierSel)),
      this.tierNote,
      el("label", { class: "check", title: "Clearing a match at your hometown offers the one-off Hometown crate" }, this.home, "This is my hometown"),
      el(
        "div",
        { class: "p-buttons" },
        button("Deck builder", { id: "p-open-deck" }, () => void this.openScreen("deck")),
        button("Collection", { id: "p-open-collection" }, () => void this.openScreen("collection")),
        this.cratesBtn,
        button("History", { id: "p-open-history" }, () => void this.openScreen("history")),
        button("Progress", { id: "p-open-progress" }, () => void this.openScreen("progress")),
      ),
      el("label", { class: "check", title: "Cells you defended in cleared matches, coloured by the highest tier" }, coverage, "Show my coverage"),
      this.warn,
    );
    card?.appendChild(this.bar);

    // The screens: one modal on the map screen.
    const tabs = el("div", { class: "ps-tabs", role: "tablist" });
    for (const s of SCREENS) {
      const b = button(s.label, { "data-screen": s.id, role: "tab" }, () => void this.openScreen(s.id));
      this.tabs.set(s.id, b);
      tabs.append(b);
    }
    tabs.append(button("Close", { id: "ps-close", class: "ps-close" }, () => this.closeScreen()));
    this.body = el("div", { id: "ps-body" });
    this.modal = el("div", { id: "profile-screen", class: "modal", hidden: "" }, el("div", { class: "card ps-card" }, tabs, this.body));
    (document.getElementById("explore") ?? document.body).appendChild(this.modal);

    // The payout of an abandoned (or fast-forwarded) match, on any screen.
    this.payout = el("div", { id: "payout", class: "any-screen", hidden: "" });
    document.body.appendChild(this.payout);
    // The payout of a cleared match, inside the match result panel.
    this.rPayout = el("div", { id: "r-payout", hidden: "" });
    const resultCard = document.querySelector("#result .card");
    resultCard?.insertBefore(this.rPayout, resultCard.querySelector(".row"));

    // Coverage on the map screen: hidden in a match, redrawn on moves.
    this.d.map.on("moveend", () => {
      if (this.coverageOn) void this.refreshCoverage();
    });
    new MutationObserver(() => {
      this.setCoverageVisible(document.body.dataset.screen !== "game");
      if (document.body.dataset.screen === "game") this.closeScreen();
      else void this.refreshBar();
    }).observe(document.body, { attributes: true, attributeFilter: ["data-screen"] });
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.busy.add(p);
    void p.finally(() => this.busy.delete(p)).catch(() => undefined);
    return p;
  }

  private async refreshBar() {
    const p = this.profile;
    if (!p) {
      this.warn.hidden = false;
      this.warn.replaceChildren(
        `The profile could not be opened: ${this.error ?? "unknown error"}. `,
        button("Use a temporary profile", { id: "p-temp", class: "small" }, () => void this.track(this.open(undefined, true))),
      );
      return;
    }
    const [decks, tiers, tickets] = await Promise.all([p.listDecks(), p.tiers(), p.listTickets()]);
    const stored = (() => {
      try {
        return { deck: localStorage.getItem(DECK_KEY), tier: localStorage.getItem(TIER_KEY) };
      } catch {
        return { deck: null, tier: null };
      }
    })();
    const wantDeck = this.deckSel.value || stored.deck || STARTER_DECK;
    this.deckSel.replaceChildren(...decks.map((d) => el("option", { value: d.id, text: d.name })));
    this.deckSel.value = decks.some((d) => d.id === wantDeck) ? wantDeck : STARTER_DECK;
    // Only unlocked tiers are offered.
    const wantTier = this.tierSel.value || stored.tier || "recruit";
    this.tierSel.replaceChildren(...tiers.unlocked.map((t) => el("option", { value: t, text: tierName(t) })));
    this.tierSel.value = (tiers.unlocked as string[]).includes(wantTier) ? wantTier : "recruit";
    this.showTierNote();
    this.cratesBtn.textContent = `Crates · ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`;
    this.warn.hidden = p.persistent;
    if (!p.persistent) this.warn.textContent = "Your profile is kept in memory only (private browsing or storage blocked): it is lost when this tab closes.";
    if (this.coverageOn) void this.refreshCoverage();
  }

  private showTierNote() {
    const t = (this.tierSel.value || "recruit") as Tier;
    const k = DEFAULT_TABLES.difficulty[t]?.population_multiplier ?? 1;
    // outbreak_scale and fatigue_scale are not sim inputs yet (a rules bump).
    this.tierNote.textContent = `${tierName(t)}: ${k}× population. Outbreak and fatigue scaling: coming soon.`;
  }

  // ------------------------------------------------------------- match setup

  /** The setup of the next match: the active deck (refused if illegal), the
   *  tier (only unlocked ones) and its population multiplier. */
  async matchSetup(): Promise<MatchSetupResult> {
    await this.ready;
    const p = this.profile;
    if (!p) return { ok: false, message: `No profile: ${this.error ?? "it could not be opened"}. Go back to the map to use a temporary profile.` };
    const deckId = this.deckSel.value || STARTER_DECK;
    const tier = (this.tierSel.value || "recruit") as Tier;
    const tiers = await p.tiers();
    if (!tiers.unlocked.includes(tier)) return { ok: false, message: `${tierName(tier)} is locked: clear a match on the tier below first.` };
    let deck: string[];
    try {
      deck = await p.deckCardIds(deckId);
    } catch (e) {
      const deckName = (await p.getDeck(deckId))?.name ?? deckId;
      const problems = (await p.getDeck(deckId)) ? await p.checkDeck((await p.getDeck(deckId))!.instanceIds) : [];
      const names = new Map((await p.listCards()).map((c) => [c.instanceId, cardName(c.cardId)]));
      const why = problems.length ? problems.map((x) => deckProblemText(x, names)).join("; ") : errMessage(e);
      return { ok: false, message: `The deck "${deckName}" is not legal: ${why}. Fix it in the deck builder.` };
    }
    const k = Math.fround(BASE_MULTIPLIER * (await p.difficulty(tier)).population_multiplier);
    if (!(k >= MULTIPLIER_RANGE[0] && k <= MULTIPLIER_RANGE[1])) return { ok: false, message: `The ${tierName(tier)} population multiplier ${k} is outside the accepted range.` };
    return { ok: true, setup: { deck, population_multiplier: k }, tier, deckId, hometown: this.home.checked };
  }

  /** A match was sent to the worker with `setup`. */
  startMatch(s: Extract<MatchSetupResult, { ok: true }>, place: MatchPlace, seed: string, streamed: boolean): MatchContext {
    this.hidePayout();
    return this.tracker.start({ place, tier: s.tier, deckId: s.deckId, deck: s.setup.deck, populationMultiplier: s.setup.population_multiplier, hometown: s.hometown, seed, streamed });
  }

  /** The match result panel changed: the payout belongs to the match-won panel only. */
  onResult(kind: string | null) {
    if (kind !== "match_won") this.rPayout.hidden = true;
  }

  // ------------------------------------------------------------- payout

  private hidePayout() {
    this.payout.hidden = true;
    this.rPayout.hidden = true;
  }

  private onClaim(n: ClaimNotice) {
    const intoResult = n.reason === "cleared" && this.d.resultShowsMatchWon() && this.tracker.current === n.ctx;
    const box = intoResult ? this.rPayout : this.payout;
    this.renderPayout(box, n, !intoResult);
    box.hidden = false;
    // In a match the panel goes away by itself (on the map screen it stays until closed).
    if (!intoResult && document.body.dataset.screen === "game") {
      const shown = box.firstChild;
      setTimeout(() => {
        if (box.firstChild === shown && document.body.dataset.screen === "game") box.hidden = true;
      }, 10_000);
    }
    void this.refreshBar();
  }

  private renderPayout(box: HTMLElement, n: ClaimNotice, closable: boolean) {
    const c = n.claim;
    const p = c.payout;
    const extra = c.daily?.granted.length ?? 0;
    const lines: (HTMLElement | null)[] = [
      el("h3", { text: n.reason === "cleared" ? "Match cleared: resupply" : "Match abandoned: resupply" }),
      c.paid
        ? el("p", { class: "po-total", text: `+${p.total} resupply ticket${p.total === 1 ? "" : "s"}` })
        : el("p", { class: "po-total", text: "Already claimed: this match pays nothing more." }),
      c.paid
        ? el(
            "p",
            { class: "po-breakdown" },
            `Furthest wave ${n.summary.furthestWave}: ${p.waveTickets} · cleared: ${p.clearedTickets} · civilians saved: ${p.civilianTickets} · `,
            el("span", { class: p.noRetryBonus ? "po-bonus" : "po-nobonus", text: p.noRetryBonus ? `no-retry bonus: +${p.noRetryBonus}` : "no-retry bonus: none (retried)" }),
          )
        : null,
      extra ? el("p", { text: `Match victory (daily): +${extra} ticket${extra === 1 ? "" : "s"}` }) : null,
      c.unlockedTiers.length ? el("p", { class: "po-unlock", text: `Unlocked: ${c.unlockedTiers.map(tierName).join(", ")}` }) : null,
      c.newAchievements.length ? el("p", { text: `Achievement: ${c.newAchievements.map((a) => `${a.city} cleared (${tierName(a.tier)})${a.provisional ? ", provisional" : ""}`).join(", ")}` }) : null,
    ];
    box.replaceChildren(...lines.filter((x): x is HTMLElement => !!x));
    const row = el("div", { class: "row" });
    if (n.reason === "cleared" && n.ctx.hometown) {
      const hb = button("Open the Hometown crate", { id: "hometown-open", class: "primary" });
      hb.addEventListener("click", () => {
        hb.disabled = true;
        void this.track(
          this.profile!.claimHometownCrate(n.ctx.matchId).then(
            (o) => {
              box.append(this.crateView(o));
              void this.refreshBar();
            },
            (e) => {
              this.d.toast(errMessage(e));
            },
          ),
        );
      });
      void this.profile?.info().then((i) => (hb.hidden = i.hometownCrateClaimed));
      row.append(hb);
    }
    row.append(button("Open a crate", { class: "po-crates" }, () => void this.openScreen("crates")));
    if (closable) row.append(button("Close", { id: "payout-close" }, () => (box.hidden = true)));
    box.append(row);
  }

  // ------------------------------------------------------------- screens

  async openScreen(name: ScreenName): Promise<void> {
    if (!this.profile) return;
    if (document.body.dataset.screen === "game") return;
    this.screen = name;
    for (const [id, b] of this.tabs) b.classList.toggle("on", id === name);
    this.modal.hidden = false;
    this.modal.dataset.screen = name;
    await this.track(this.render());
  }

  closeScreen() {
    this.screen = null;
    this.modal.hidden = true;
    void this.refreshBar();
  }

  private async render() {
    const p = this.profile!;
    const s = this.screen;
    let view: HTMLElement;
    if (s === "deck") view = await this.deckView(p);
    else if (s === "collection") view = await this.collectionView(p);
    else if (s === "crates") view = await this.cratesView(p);
    else if (s === "history") view = await this.historyView(p);
    else view = await this.progressView(p);
    if (this.screen === s) this.body.replaceChildren(view);
  }

  // Deck builder: the collection on the left, the deck on the right.
  private async deckView(p: ProfileService): Promise<HTMLElement> {
    const [cards, decks] = await Promise.all([p.listCards(), p.listDecks()]);
    if (!this.draft || (this.draft.deckId && !decks.some((d) => d.id === this.draft!.deckId))) {
      const start = decks.find((d) => d.id === this.deckSel.value) ?? decks[0];
      this.draft = { deckId: start.id, name: start.name, ids: [...start.instanceIds] };
    }
    const draft = this.draft;
    const names = new Map(cards.map((c) => [c.instanceId, cardName(c.cardId)]));
    const byCard = new Map<string, CardInstance[]>();
    for (const c of cards) byCard.set(c.cardId, [...(byCard.get(c.cardId) ?? []), c]);
    const inDeck = new Set(draft.ids);
    const owner = new Map(cards.map((c) => [c.instanceId, c.cardId]));
    const countIn = (cardId: string) => draft.ids.filter((i) => owner.get(i) === cardId).length;
    const order = [...byCard.keys()].sort((a, b) => {
      const ra = ["common", "uncommon", "rare", "legendary"].indexOf(CARD.get(a)?.rarity ?? "");
      const rb = ["common", "uncommon", "rare", "legendary"].indexOf(CARD.get(b)?.rarity ?? "");
      return ra - rb || cardName(a).localeCompare(cardName(b));
    });
    const rerender = () => void this.track(this.render());

    const coll = el("section", { class: "db-coll" }, el("h3", { text: `Collection (${cards.length} cards)` }));
    for (const id of order) {
      const own = byCard.get(id)!;
      const free = own.filter((c) => !inDeck.has(c.instanceId));
      const def = CARD.get(id);
      const add = button("Add", { class: "small db-add" }, () => {
        if (!free.length) return;
        // A stamped copy before a starter one, the newest first.
        const pick = [...free].sort((a, b) => Number(a.accountBound) - Number(b.accountBound) || (a.acquiredAt < b.acquiredAt ? 1 : -1))[0];
        draft.ids.push(pick.instanceId);
        rerender();
      });
      add.disabled = free.length === 0;
      coll.append(
        el(
          "div",
          { class: `db-card rarity-${def?.rarity ?? "common"}`, "data-card": id },
          el("span", { class: "cc-name", text: cardName(id) }),
          el("span", { class: "cc-rarity", text: `${def?.rarity ?? ""} · ${def?.kind ?? ""} · cost ${def?.cost ?? "?"}` }),
          el("span", { class: "db-owned", text: `${countIn(id)} in deck / ${own.length} owned` }),
          add,
        ),
      );
    }

    const pickSel = el("select", { id: "db-pick", "aria-label": "Deck to edit" });
    pickSel.replaceChildren(...decks.map((d) => el("option", { value: d.id, text: d.name })), el("option", { value: "", text: "(new, unsaved)" }));
    pickSel.value = draft.deckId ?? "";
    pickSel.addEventListener("change", () => {
      const d = decks.find((x) => x.id === pickSel.value);
      if (d) this.draft = { deckId: d.id, name: d.name, ids: [...d.instanceIds] };
      rerender();
    });
    const nameIn = el("input", { id: "db-name", type: "text", value: draft.name, "aria-label": "Deck name" });
    nameIn.addEventListener("input", () => (draft.name = nameIn.value));
    const deckList = el("div", { class: "db-list" });
    const seen: string[] = [];
    for (const i of draft.ids) {
      const c = owner.get(i) ?? "?";
      if (!seen.includes(c)) seen.push(c);
    }
    for (const c of seen) {
      const n = countIn(c);
      const unknown = c === "?";
      deckList.append(
        el(
          "div",
          { class: `db-entry rarity-${CARD.get(c)?.rarity ?? "common"}`, "data-card": c },
          el("span", { class: "cc-name", text: unknown ? "Unknown card" : `${cardName(c)} ×${n}` }),
          button("Remove", { class: "small db-remove" }, () => {
            const at = draft.ids.map((x) => owner.get(x) ?? "?").lastIndexOf(c);
            if (at >= 0) draft.ids.splice(at, 1);
            rerender();
          }),
        ),
      );
    }
    const problems = await p.checkDeck(draft.ids);
    const errors = el("ul", { id: "db-errors", class: problems.length ? "bad" : "ok" });
    if (problems.length) for (const x of problems) errors.append(el("li", { text: deckProblemText(x, names) }));
    else errors.append(el("li", { text: "Legal deck." }));
    const status = el("p", { id: "db-status", class: "hint" });
    const saved = decks.find((d) => d.id === draft.deckId);
    const unchanged = !!saved && saved.name === draft.name && saved.instanceIds.length === draft.ids.length && saved.instanceIds.every((x, k) => x === draft.ids[k]);
    const isStarter = draft.deckId === STARTER_DECK;
    const save = async (asNew: boolean) => {
      const r = await p.saveDeck({ id: asNew ? undefined : (draft.deckId ?? undefined), name: draft.name.trim() || "My deck", instanceIds: draft.ids });
      if (!r.ok) {
        status.textContent = `Not saved: ${r.errors.map((x) => deckProblemText(x, names)).join("; ")}.`;
        status.classList.add("over");
        return;
      }
      this.draft = { deckId: r.deck.id, name: r.deck.name, ids: [...r.deck.instanceIds] };
      await this.refreshBar();
      await this.render();
      const st = document.getElementById("db-status");
      if (st) st.textContent = `Saved "${r.deck.name}".`;
    };
    const saveBtn = button("Save", { id: "db-save" }, () => void this.track(save(false)));
    saveBtn.disabled = isStarter || !draft.deckId;
    saveBtn.title = isStarter ? "The starter deck can't be changed: save a copy as a new deck" : "";
    const saveAs = button("Save as new deck", { id: "db-saveas" }, () => void this.track(save(true)));
    const use = button(this.deckSel.value === draft.deckId ? "Used for matches" : "Use for matches", { id: "db-use", class: "primary" }, () => {
      if (!draft.deckId) return;
      this.deckSel.value = draft.deckId;
      this.deckSel.dispatchEvent(new Event("change"));
      rerender();
    });
    use.disabled = !unchanged || problems.length > 0 || this.deckSel.value === draft.deckId;
    const del = button("Delete", { id: "db-delete" }, () => {
      if (!draft.deckId || isStarter) return;
      const id = draft.deckId;
      void this.track(
        p.deleteDeck(id).then(async () => {
          if (this.deckSel.value === id) this.deckSel.value = STARTER_DECK;
          this.draft = null;
          await this.refreshBar();
          await this.render();
        }),
      );
    });
    del.disabled = !draft.deckId || isStarter;
    const fresh = button("New deck from this one", { id: "db-new" }, () => {
      this.draft = { deckId: null, name: `${draft.name} (copy)`, ids: [...draft.ids] };
      rerender();
    });
    const deck = el(
      "section",
      { class: "db-deck" },
      el("h3", { text: "Deck" }),
      el("div", { class: "p-row" }, pickSel, fresh),
      el("label", {}, "Name", nameIn),
      el("p", { id: "db-count", class: draft.ids.length === DEFAULT_TABLES.cards.deck_rules.deck_size ? "" : "over", text: `${draft.ids.length} / ${DEFAULT_TABLES.cards.deck_rules.deck_size} cards` }),
      deckList,
      errors,
      el("div", { class: "row" }, saveBtn, saveAs, use, del),
      status,
    );
    return el("div", { class: "ps-cols", id: "deck-builder" }, coll, deck);
  }

  private async collectionView(p: ProfileService): Promise<HTMLElement> {
    const cards = await p.listCards();
    const sorted = [...cards].sort((a, b) => Number(a.accountBound) - Number(b.accountBound) || (a.acquiredAt < b.acquiredAt ? 1 : a.acquiredAt > b.acquiredAt ? -1 : a.instanceId < b.instanceId ? 1 : -1));
    const list = el("div", { class: "coll-list" });
    for (const c of sorted) list.append(cardRow(c));
    const stamped = cards.filter((c) => c.stamp).length;
    return el("div", { id: "collection" }, el("p", { class: "hint", text: `${cards.length} cards: ${stamped} recovered from crates, ${cards.length - stamped} account-bound starter cards.` }), list);
  }

  private crateView(o: CrateOpening): HTMLElement {
    return el(
      "div",
      { class: "crate-open", "data-crate": o.crate.id },
      el("p", { class: "lore", text: o.crate.lore }),
      el("div", { class: "coll-list" }, ...o.cards.map(cardRow)),
    );
  }

  private async cratesView(p: ProfileService): Promise<HTMLElement> {
    const [tickets, crates, cards] = await Promise.all([p.listTickets(), p.listCrates(), p.listCards()]);
    const byId = new Map(cards.map((c) => [c.instanceId, c]));
    const result = el("div", { id: "cr-result" });
    const open = button(`Open a crate (1 ticket)`, { id: "cr-open", class: "primary" }, () => {
      open.disabled = true;
      void this.track(
        p.openCrate().then(
          async (o) => {
            await this.refreshBar();
            await this.render();
            document.getElementById("cr-result")?.replaceChildren(this.crateView(o));
          },
          (e) => {
            this.d.toast(errMessage(e));
            open.disabled = false;
          },
        ),
      );
    });
    open.disabled = tickets.length === 0;
    const past = el("div", { class: "crate-list" });
    for (const c of [...crates].reverse()) {
      past.append(
        el(
          "div",
          { class: "crate-item", "data-crate": c.id },
          el("p", { class: "lore", text: c.lore }),
          el("p", { class: "hint", text: c.instanceIds.map((i) => cardName(byId.get(i)?.cardId ?? null)).join(", ") }),
        ),
      );
    }
    return el(
      "div",
      { id: "crates" },
      el("p", { id: "cr-tickets", text: `${tickets.length} resupply ticket${tickets.length === 1 ? "" : "s"}` }),
      el("p", { class: "hint", text: "Lost and found military surplus: each crate holds three cards, stamped with where they were recovered." }),
      open,
      result,
      el("h3", { text: `Opened crates (${crates.length})` }),
      past,
    );
  }

  private async historyView(p: ProfileService): Promise<HTMLElement> {
    const items = await p.listMatches();
    const list = el("div", { class: "hist-list" });
    for (const m of items) {
      const s = m.summary;
      const where = placeLabel(s.district, s.city);
      const dl = button("Download run record", { class: "small hist-dl" }, () => {
        void this.track(
          p.getMatch(s.matchId).then((r) => {
            if (!r?.runRecord) {
              this.d.toast("No run record stored for this match");
              return;
            }
            saveFile(JSON.stringify(r.runRecord), `zombie-td-run-${slug(where)}-${m.claimedAt.slice(0, 10)}-${s.matchId.slice(0, 8)}.json`);
          }),
        );
      });
      // Replay: reads the stored record only (the viewer never writes the profile).
      const rp = button("Replay", { class: "small hist-replay" }, () => {
        void this.track(
          p.getMatch(s.matchId).then((r) => {
            if (!r?.runRecord) {
              this.d.toast("No run record stored for this match");
              return;
            }
            this.closeScreen();
            this.d.openReplay?.(JSON.stringify(r.runRecord), `${where} · ${m.claimedAt.slice(0, 10)}`);
          }),
        );
      });
      const outcome = m.cleared ? "Cleared" : `Abandoned in wave ${s.furthestWave}`;
      list.append(
        el(
          "div",
          { class: "hist-item", "data-match": s.matchId },
          el("strong", { text: `${where} · ${tierName(s.tier)}` }),
          el("span", { class: m.cleared ? "hist-outcome won" : "hist-outcome", text: outcome }),
          el(
            "span",
            { class: "hint" },
            `${m.claimedAt.slice(0, 10)} · ${s.wavesWon} wave${s.wavesWon === 1 ? "" : "s"} won · ${s.retries} retr${s.retries === 1 ? "y" : "ies"} · ` +
              `${(s.savedPerWave.length ? Math.max(...s.savedPerWave) : 0).toLocaleString("en-US")} saved · ${m.payout.total} ticket${m.payout.total === 1 ? "" : "s"}` +
              (s.mvpCard ? ` · MVP ${cardName(s.mvpCard)}` : ""),
          ),
          el("span", { class: "hist-buttons" }, rp, dl),
        ),
      );
    }
    return el(
      "div",
      { id: "history" },
      el("p", { class: "hint", text: items.length ? `${items.length} match${items.length === 1 ? "" : "es"}, newest first. Replay plays a run back with its hash checks. The map of a streamed match is not stored: a replay takes it from this browser's map cache, or from the map bundle downloaded from the match panel at the end of the match.` : "No match yet." }),
      list,
    );
  }

  private async progressView(p: ProfileService): Promise<HTMLElement> {
    const [tiers, achievements, matches] = await Promise.all([p.tiers(), p.achievements(), p.listMatches()]);
    const tierList = el("ul", { id: "pr-tiers" });
    for (const t of TIERS) {
      const unlocked = tiers.unlocked.includes(t);
      const k = DEFAULT_TABLES.difficulty[t];
      tierList.append(
        el(
          "li",
          { class: unlocked ? "unlocked" : "locked", "data-tier": t },
          `${tierName(t)}: ${unlocked ? "unlocked" : "locked"} · ${k.population_multiplier}× population`,
          el("span", { class: "hint", text: ` (outbreak ${k.outbreak_scale}×, fatigue ${k.fatigue_scale}×: coming soon)` }),
        ),
      );
    }
    const cities = new Map<string, { city: string; cityId?: string }>();
    for (const m of matches) if (m.cleared && m.summary.city) cities.set(m.summary.cityId ?? m.summary.city, { city: m.summary.city, cityId: m.summary.cityId });
    const cityList = el("div", { id: "pr-cities" });
    for (const c of cities.values()) {
      const pr = await p.cityProgress(c.city, c.cityId);
      const best = TIERS.filter((t) => pr.fractionByTier[t] > 0);
      cityList.append(
        el(
          "div",
          { class: "city-item", "data-city": pr.cityKey },
          el("strong", { text: pr.city }),
          pr.provisional ? el("span", { class: "provisional", title: `The city's area is not known yet: ${pr.areaKm2} km² is a placeholder`, text: "provisional" }) : null,
          el("span", { class: "hint", text: best.length ? best.map((t) => `${tierName(t)} ${(100 * pr.fractionByTier[t]).toFixed(1)}%`).join(" · ") : "nothing defended yet" }),
          el("span", { class: "hint", text: `of ${pr.areaKm2} km²${pr.clearedTiers.length ? ` · cleared: ${pr.clearedTiers.map(tierName).join(", ")}` : ""}` }),
        ),
      );
    }
    const achList = el("ul", { id: "pr-achievements" });
    for (const a of achievements) achList.append(el("li", { class: "ach-item" }, `${a.city} cleared (${tierName(a.tier)})`, a.provisional ? el("span", { class: "provisional", text: "provisional" }) : null));
    if (!achievements.length) achList.append(el("li", { class: "hint", text: "None yet: defend 75% of a city's area to clear it." }));
    return el(
      "div",
      { id: "progress" },
      el("h3", { text: "Difficulty tiers" }),
      tierList,
      el("h3", { text: "Cities" }),
      cityList,
      el("h3", { text: "Achievements" }),
      achList,
    );
  }

  // ------------------------------------------------------------- coverage

  private setCoverageVisible(on: boolean) {
    const m = this.d.map;
    if (m.getLayer("coverage-fill")) {
      m.setLayoutProperty("coverage-fill", "visibility", on && this.coverageOn ? "visible" : "none");
      m.setLayoutProperty("coverage-line", "visibility", on && this.coverageOn ? "visible" : "none");
    }
  }

  private ensureCoverageLayer(): GeoJSONSource | null {
    const m = this.d.map;
    if (!m.isStyleLoaded() && !m.getSource("coverage")) return null;
    if (!m.getSource("coverage")) {
      m.addSource("coverage", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      const color = ["match", ["get", "tier"], ...TIERS.flatMap((t) => [t, TIER_COLORS[t]]), "#888"] as unknown as string;
      m.addLayer({ id: "coverage-fill", type: "fill", source: "coverage", paint: { "fill-color": color, "fill-opacity": 0.28 } });
      m.addLayer({ id: "coverage-line", type: "line", source: "coverage", paint: { "line-color": color, "line-width": 1, "line-opacity": 0.6 } });
    }
    return m.getSource("coverage") as GeoJSONSource;
  }

  private async refreshCoverage() {
    const seq = ++this.coverageSeq;
    const p = this.profile;
    const m = this.d.map;
    if (!p) return;
    if (!this.coverageOn) {
      (m.getSource("coverage") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
      this.coverageCount = 0;
      this.setCoverageVisible(false);
      return;
    }
    if (!m.isStyleLoaded() && !m.getSource("coverage")) {
      m.once("idle", () => void this.refreshCoverage());
      return;
    }
    const b = m.getBounds();
    const cells = await p.coverageInBox({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
    if (seq !== this.coverageSeq) return;
    const src = this.ensureCoverageLayer();
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: cells.map((c) => ({
        type: "Feature" as const,
        properties: { tier: c.tier },
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [c.bounds.west, c.bounds.south],
              [c.bounds.east, c.bounds.south],
              [c.bounds.east, c.bounds.north],
              [c.bounds.west, c.bounds.north],
              [c.bounds.west, c.bounds.south],
            ],
          ],
        },
      })),
    });
    this.coverageCount = cells.length;
    this.setCoverageVisible(document.body.dataset.screen !== "game");
  }

  // ------------------------------------------------------------- test hook

  hook(): ProfileHook {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ui = this;
    const need = () => {
      if (!ui.profile) throw new Error(`no profile: ${ui.error}`);
      return ui.profile;
    };
    return {
      get ready() {
        return !!ui.profile;
      },
      get persistent() {
        return ui.profile ? ui.profile.persistent : null;
      },
      get error() {
        return ui.error;
      },
      get match() {
        const c = ui.tracker.current;
        return c ? { matchId: c.matchId, tier: c.tier, deckId: c.deckId, deck: [...c.deck], populationMultiplier: c.populationMultiplier, hometown: c.hometown, city: c.place.city, district: c.place.district, claimed: c.claimed, live: c.live } : null;
      },
      get coverageDrawn() {
        return ui.coverageOn ? ui.coverageCount : 0;
      },
      get screen() {
        return ui.screen;
      },
      get payoutText() {
        if (!ui.payout.hidden) return ui.payout.textContent;
        if (!ui.rPayout.hidden) return ui.rPayout.textContent;
        return null;
      },
      async state() {
        await ui.ready;
        const p = need();
        const [cards, tickets, decks, tiers, matches, info, ach] = await Promise.all([p.listCards(), p.listTickets(), p.listDecks(), p.tiers(), p.listMatches(), p.info(), p.achievements()]);
        return {
          cards,
          tickets: tickets.length,
          decks,
          activeDeckId: ui.deckSel.value,
          tier: ui.tierSel.value as Tier,
          unlocked: tiers.unlocked,
          highestCleared: tiers.highestCleared,
          history: matches.length,
          hometownCrateClaimed: info.hometownCrateClaimed,
          achievements: ach.length,
        };
      },
      async settle() {
        await ui.ready;
        for (let i = 0; i < 4; i++) {
          await ui.tracker.settle();
          while (ui.busy.size) await Promise.allSettled([...ui.busy]);
        }
      },
      claims: () =>
        ui.tracker.claims.map((n) => ({
          matchId: n.ctx.matchId,
          reason: n.reason,
          paid: n.claim.paid,
          total: n.claim.payout.total,
          noRetryBonus: n.claim.payout.noRetryBonus,
          unlocked: [...n.claim.unlockedTiers],
          cleared: n.summary.wavesWon >= 8,
        })),
      openScreen: (name) => ui.openScreen(name),
      closeScreen: () => ui.closeScreen(),
      setTier(t) {
        ui.tierSel.value = t;
        ui.tierSel.dispatchEvent(new Event("change"));
      },
      setDeck(id) {
        ui.deckSel.value = id;
        ui.deckSel.dispatchEvent(new Event("change"));
      },
      setHometown(on) {
        ui.home.checked = on;
      },
      async fastForwardClear() {
        const snap = ui.d.snapshot();
        const ctx = ui.tracker.current;
        if (!snap || !ctx) return null;
        const civ = snap.status.stats.civilians;
        const results = Array.from({ length: 8 }, (_, i) => ({ ...(snap.results[0] ?? ({} as never)), wave: i + 1, won: true, end_civilians: civ, start_civilians: civ }));
        const fake: MatchSnapshot = { ...snap, results, status: { ...snap.status, phase: "match_won", wave: 8 } };
        const r = await ui.tracker.claim("cleared", fake);
        return r ? { paid: r.claim.paid, total: r.claim.payout.total, unlocked: [...r.claim.unlockedTiers] } : null;
      },
      async claimAgain(matchId) {
        const p = need();
        const m = await p.getMatch(matchId);
        if (!m) throw new Error(`no match ${matchId}`);
        return p.claimMatch(m.summary, m.runRecord);
      },
      getMatch: (id) => need().getMatch(id),
      exportProfile: () => need().exportProfile(),
      importProfile: (data) => need().importProfile(data),
      refresh: () => ui.refreshBar(),
    };
  }
}
