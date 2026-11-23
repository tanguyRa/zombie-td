// The replay viewer's UI (T8): the picker on the map screen (run record and
// map files, dropped or picked, or a run from the match history) and the
// panel over the game view while a replay plays (pause, step, speed, jump to
// a wave, the live per-attempt checks, the verdict).
//
// Read-only by construction: the worker's replay refuses actions, the page
// sends none, and nothing here calls the profile (main.ts only reads the
// history to get a record). The checks are sim-core's `Replayer`'s: the page
// only shows what the worker reports.

import type { ReplayCheck, ReplayProgressMsg, VerifyErrorJson } from "../protocol";
import { NeedsMap, classifyFile, resolveReplay, type RecordView, type ReplayFile, type ReplaySource, type ResolveDeps } from "../replay";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null) e.append(k);
  return e;
}

const fmtTime = (ticks: number) => {
  const s = Math.floor(ticks / 20);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Which check row a `diverged` error belongs to (`what` of VerifyError). */
function divergedAt(e: VerifyErrorJson): "prep" | "end" | "final" {
  const w = e.what ?? "";
  if (w === "prep_hash" || w === "start_tick" || w === "wave") return "prep";
  if (w === "phase" || w === "final_hash") return "final";
  return "end";
}

/** A rejection in words, naming the attempt (1-based for people) and what
 *  diverged, with both values. */
export function rejectionText(e: VerifyErrorJson, rec: RecordView | null): string {
  if (e.error === "diverged" && typeof e.attempt === "number") {
    const n = rec?.attempts.length ?? 0;
    const which = e.attempt < n ? `attempt ${e.attempt + 1} (wave ${e.wave})` : `the end of the record (wave ${e.wave})`;
    const what = (e.what ?? "").replace(/_/g, " ");
    return `Diverged at ${which}, tick ${e.tick}: the ${what} is ${e.replay} in the replay, ${e.record} in the record.`;
  }
  return `Rejected: ${e.message}`;
}

export interface ReplayHook {
  active: boolean;
  title: string;
  mapFrom: string;
  tick: number;
  endTick: number;
  nextAction: number;
  actions: number;
  done: boolean;
  paused: boolean;
  speed: number;
  jumping: number | null;
  error: VerifyErrorJson | null;
  errorText: string | null;
  summary: Record<string, unknown> | null;
  checks: ReplayCheck[];
  /** The panel's rows: per attempt, the state of its prep and end checks. */
  rows: { attempt: number; wave: number; prep: string; end: string; result: string }[];
  final: string;
  /** The picker on the map screen: open, and its message. */
  picker: { open: boolean; message: string };
}

export interface ReplayUiDeps extends ResolveDeps {
  /** Start the replay (main.ts: the game view, the worker's replay init). */
  start(src: ReplaySource): void;
  send(ctl: { type: "replay_ctl"; op: "step" } | { type: "replay_ctl"; op: "jump"; wave: number } | { type: "pause_toggle" } | { type: "speed"; speed: number }): void;
  toast(msg: string): void;
}

type CheckState = "pending" | "ok" | "bad";

export class ReplayUi {
  // ---- picker state
  private pickRecord: { json: string; record: RecordView; name: string } | null = null;
  private pickMaps: (ReplayFile & { name: string })[] = [];
  private pickerMsg = "";
  // ---- the replay on screen
  private src: ReplaySource | null = null;
  private progress: ReplayProgressMsg | null = null;
  private checks: ReplayCheck[] = [];

  constructor(private readonly d: ReplayUiDeps) {
    this.buildPicker();
    this.buildPanel();
  }

  get active(): boolean {
    return this.src !== null;
  }

  // =========================================================== picker

  private buildPicker() {
    const input = el("input", { id: "rp-files", type: "file", accept: ".json,application/json", multiple: "" });
    input.addEventListener("change", () => {
      void this.addFiles([...(input.files ?? [])]);
      input.value = "";
    });
    const drop = el(
      "label",
      { id: "rp-drop", class: "rp-drop", for: "rp-files" },
      el("strong", { text: "Drop a run record here" }),
      el("span", { text: " (and, for a streamed map, its map bundle), or click to pick the files." }),
    );
    for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over")));
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      void this.addFiles([...((e as DragEvent).dataTransfer?.files ?? [])]);
    });
    const modal = el(
      "div",
      { id: "replay-picker", class: "modal", hidden: "" },
      el(
        "div",
        { class: "card rp-card" },
        el("h2", { text: "Open a replay" }),
        el("p", {
          class: "hint",
          text: "A run on a built-in level replays on its own. A run on a streamed map also needs the blocks it was played on: its map bundle (\"Download map\" at the end of the match), unless this browser still has them all in its map cache.",
        }),
        drop,
        input,
        el("ul", { id: "rp-loaded" }),
        el("p", { id: "rp-msg", class: "hint" }),
        el(
          "div",
          { class: "row" },
          el("button", { id: "rp-start", class: "primary", type: "button", text: "Replay" }),
          el("button", { id: "rp-cancel", type: "button", text: "Cancel" }),
        ),
      ),
    );
    (document.getElementById("explore") ?? document.body).appendChild(modal);
    $("rp-start").addEventListener("click", () => void this.tryStart());
    $("rp-cancel").addEventListener("click", () => this.closePicker());
    this.renderPicker();
  }

  /** The picker, empty (the map screen's "Open a replay…"). */
  openPicker() {
    this.pickRecord = null;
    this.pickMaps = [];
    this.pickerMsg = "";
    $("replay-picker").hidden = false;
    this.renderPicker();
  }

  closePicker() {
    $("replay-picker").hidden = true;
  }

  /** A run from the match history: replayed at once when its map is at
   *  hand, else the picker opens asking for the bundle. */
  async openRecord(json: string, name: string) {
    this.pickRecord = null;
    this.pickMaps = [];
    this.pickerMsg = "";
    const f = classifyFile(json);
    if (f.kind !== "record") {
      this.d.toast("The stored run record can't be read");
      return;
    }
    this.pickRecord = { json, record: f.record, name };
    await this.tryStart(true);
  }

  private async addFiles(files: File[]) {
    for (const file of files) {
      let text: string;
      try {
        text = await file.text();
      } catch (e) {
        this.pickerMsg = `${file.name}: ${String(e)}`;
        continue;
      }
      const f = classifyFile(text);
      if (f.kind === "record") this.pickRecord = { json: f.json, record: f.record, name: file.name };
      else if (f.kind === "unknown") this.pickerMsg = `${file.name}: ${f.why}.`;
      else this.pickMaps = [...this.pickMaps.filter((m) => m.kind !== f.kind), { ...f, name: file.name }];
    }
    this.renderPicker();
    if (this.pickRecord) await this.tryStart(true);
  }

  /** Resolve the map and start, or say what is missing. `quiet`: only open
   *  the picker when something is missing. */
  private async tryStart(quiet = false) {
    const r = this.pickRecord;
    if (!r) {
      this.pickerMsg = "Add a run record first.";
      this.renderPicker();
      return;
    }
    try {
      const src = await resolveReplay(r.json, r.record, this.pickMaps, this.d);
      this.closePicker();
      this.d.start(src);
    } catch (e) {
      this.pickerMsg = e instanceof NeedsMap ? e.message : `Can't replay this run: ${e instanceof Error ? e.message : String(e)}`;
      $("replay-picker").hidden = false;
      $("replay-picker").dataset.need = e instanceof NeedsMap ? e.need : "";
      this.renderPicker();
      if (!quiet) this.d.toast(this.pickerMsg);
    }
  }

  private renderPicker() {
    const list = $("rp-loaded");
    list.replaceChildren();
    if (this.pickRecord) {
      const rec = this.pickRecord.record;
      list.append(el("li", { class: "rp-file", "data-kind": "record", text: `Run record: ${this.pickRecord.name} (${rec.map.source === "chunks" ? `streamed map, ${rec.map.blocks.length} blocks` : "level"}, seed ${rec.setup.seed}, ${rec.end.waves_won} waves won)` }));
    }
    for (const m of this.pickMaps) list.append(el("li", { class: "rp-file", "data-kind": m.kind, text: `${m.kind === "bundle" ? "Map bundle" : "Level"}: ${m.name}` }));
    $("rp-msg").textContent = this.pickerMsg;
    ($("rp-start") as HTMLButtonElement).disabled = !this.pickRecord;
  }

  // =========================================================== panel

  private buildPanel() {
    const speeds = el("div", { class: "seg", "aria-label": "Replay speed" });
    for (const [s, label] of [
      [1, "1×"],
      [4, "4×"],
      [0, "Max"],
    ] as const) {
      const b = el("button", { id: `rv-speed-${s}`, type: "button", text: label });
      b.addEventListener("click", () => this.d.send({ type: "speed", speed: s }));
      speeds.append(b);
    }
    const jump = el("select", { id: "rv-wave", "aria-label": "Wave" });
    const panel = el(
      "aside",
      { id: "replay-panel", hidden: "" },
      el("h2", { text: "Replay" }),
      el("p", { id: "rv-title", class: "help" }),
      el(
        "div",
        { class: "row" },
        el("button", { id: "rv-pause", type: "button", class: "primary", text: "Pause" }),
        el("button", { id: "rv-step", type: "button", text: "Step", title: "One tick (pauses)" }),
      ),
      speeds,
      el("div", { class: "row" }, el("label", {}, "Jump to wave ", jump), el("button", { id: "rv-jump", type: "button", text: "Go" })),
      el("div", { class: "rv-progress" }, el("div", { id: "rv-bar", class: "fill" })),
      el("p", { id: "rv-pos", class: "hint" }),
      el("h3", { text: "Hash checks" }),
      el("ol", { id: "rv-checks" }),
      el("p", { id: "rv-verdict", class: "rv-verdict" }),
    );
    document.body.appendChild(panel);
    $("rv-pause").addEventListener("click", () => this.d.send({ type: "pause_toggle" }));
    $("rv-step").addEventListener("click", () => this.d.send({ type: "replay_ctl", op: "step" }));
    $("rv-jump").addEventListener("click", () => this.d.send({ type: "replay_ctl", op: "jump", wave: Number(jump.value) }));
  }

  /** A replay starts (main.ts sends the worker's init). */
  begin(src: ReplaySource) {
    this.src = src;
    this.progress = null;
    this.checks = [];
    const rec = src.record;
    $("rv-title").textContent = `${src.title} · seed ${rec.setup.seed} · ${rec.attempts.length} attempts, ${rec.actions.length} actions · map from ${src.mapFrom}`;
    const sel = $("rv-wave") as HTMLSelectElement;
    sel.replaceChildren();
    const waves = Math.max(1, rec.end.wave, ...rec.attempts.map((a) => a.wave));
    for (let w = 1; w <= waves; w++) sel.append(el("option", { value: String(w), text: String(w) }));
    $("replay-panel").hidden = false;
    this.render();
  }

  /** The replay left the screen (← Map, another match). */
  end() {
    this.src = null;
    this.progress = null;
    this.checks = [];
    $("replay-panel").hidden = true;
  }

  onProgress(p: ReplayProgressMsg) {
    if (!this.src) return;
    if (p.reset) this.checks = [];
    this.checks.push(...p.checks);
    this.progress = p;
    this.render();
  }

  /** Per attempt: its prep and end check states, plus the final row. */
  private rows() {
    const rec = this.src?.record;
    if (!rec) return { rows: [], final: "pending" as CheckState };
    const err = this.progress?.error ?? null;
    const at = err?.error === "diverged" ? divergedAt(err) : null;
    const n = rec.attempts.length;
    // The attempt open at the end of the record (a record ending in a
    // prep or a wave) has a prep check too.
    const open = rec.end.phase === "prep" || rec.end.phase === "running" ? 1 : 0;
    const rows: { attempt: number; wave: number; prep: CheckState; end: CheckState; result: string }[] = [];
    for (let i = 0; i < n + open; i++) {
      const a = rec.attempts[i];
      const state = (what: "prep" | "end"): CheckState => {
        if (this.checks.some((c) => c.attempt === i && c.what === what)) return "ok";
        if (err && at === what && err.attempt === i) return "bad";
        return "pending";
      };
      rows.push({ attempt: i, wave: a?.wave ?? rec.end.wave, prep: state("prep"), end: a ? state("end") : "pending", result: a ? a.result : "open at the end" });
    }
    let final: CheckState = this.checks.some((c) => c.what === "final") ? "ok" : "pending";
    if (err && (at === "final" || (at === null && err.error !== "diverged"))) final = "bad";
    if (err && err.error === "diverged" && at === "end" && (err.attempt ?? 0) >= n) final = "bad";
    return { rows, final };
  }

  private render() {
    if (!this.src) return;
    const p = this.progress;
    const rec = this.src.record;
    $("rv-pause").textContent = p?.paused ? "Play" : "Pause";
    for (const s of [1, 4, 0]) $(`rv-speed-${s}`).classList.toggle("on", p?.speed === s);
    const end = Math.max(1, rec.end.tick);
    ($("rv-bar") as HTMLElement).style.width = `${Math.min(100, (100 * (p?.tick ?? 0)) / end)}%`;
    $("rv-pos").textContent = p ? `${fmtTime(p.tick)} / ${fmtTime(rec.end.tick)} game time · tick ${p.tick.toLocaleString("en-US")} / ${rec.end.tick.toLocaleString("en-US")} · action ${p.nextAction} / ${p.actions}${p.jumping ? ` · jumping to wave ${p.jumping}…` : ""}` : "Starting…";
    const { rows, final } = this.rows();
    const list = $("rv-checks");
    list.replaceChildren();
    const dot = (s: CheckState, what: string) => el("span", { class: `rv-dot ${s}`, "data-check": what, title: `${what}: ${s === "ok" ? "hash matches the record" : s === "bad" ? "differs from the record" : "not reached yet"}`, text: what });
    for (const r of rows) {
      list.append(el("li", { "data-attempt": String(r.attempt), class: r.prep === "bad" || r.end === "bad" ? "bad" : "" }, el("span", { class: "rv-att", text: `Attempt ${r.attempt + 1} · wave ${r.wave} · ${r.result}` }), dot(r.prep, "prep"), r.result === "open at the end" ? null : dot(r.end, "end")));
    }
    list.append(el("li", { "data-attempt": "final", class: final === "bad" ? "bad" : "" }, el("span", { class: "rv-att", text: `End of the record · ${rec.end.phase.replace(/_/g, " ")}` }), dot(final, "final")));
    const v = $("rv-verdict");
    if (p?.error) {
      v.textContent = rejectionText(p.error, rec);
      v.dataset.state = "bad";
    } else if (p?.done) {
      v.textContent = `Verified: every hash matches the record (${rec.attempts.length} attempts, final hash ${String(p.summary?.final_hash ?? "")}).`;
      v.dataset.state = "ok";
    } else {
      v.textContent = "";
      v.dataset.state = "";
    }
    const blocked = !!p?.done || !!p?.error;
    ($("rv-pause") as HTMLButtonElement).disabled = blocked;
    ($("rv-step") as HTMLButtonElement).disabled = blocked;
  }

  hook(): ReplayHook {
    const p = this.progress;
    const { rows, final } = this.rows();
    return {
      active: !!this.src,
      title: this.src?.title ?? "",
      mapFrom: this.src?.mapFrom ?? "",
      tick: p?.tick ?? 0,
      endTick: this.src?.record.end.tick ?? 0,
      nextAction: p?.nextAction ?? 0,
      actions: p?.actions ?? 0,
      done: !!p?.done,
      paused: !!p?.paused,
      speed: p?.speed ?? 1,
      jumping: p?.jumping ?? null,
      error: p?.error ? { ...p.error } : null,
      errorText: p?.error ? rejectionText(p.error, this.src?.record ?? null) : null,
      summary: p?.summary ? { ...p.summary } : null,
      checks: this.checks.map((c) => ({ ...c })),
      rows: rows.map((r) => ({ ...r })),
      final,
      picker: { open: !$("replay-picker").hidden, message: this.pickerMsg },
    };
  }
}
