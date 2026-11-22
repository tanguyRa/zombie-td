//! wasm-bindgen wrapper around sim-core. No game logic lives here: it only
//! marshals data between JS and the core.

use sim_core::sim::{Clock, GamePhase, Outcome, DEAD};
use sim_core::{Config, LevelPack, Sim};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn perf_now() -> f64;
}

struct PerfClock;
impl Clock for PerfClock {
    fn now_ms(&mut self) -> f64 {
        perf_now()
    }
}

/// Render state per agent: 0 civilian, 1 infected, 2 zombie, 3 corpse,
/// 4 hidden (unused), 5 fresh kill (the first `kill_flash_seconds` after a
/// tower kill). Corpses stay on the map for the rest of the game.
pub const FRESH_KILL: u8 = 5;

#[wasm_bindgen]
pub struct WasmSim {
    sim: Sim,
    pos: Vec<f32>,
    render: Vec<u8>,
}

#[wasm_bindgen]
impl WasmSim {
    #[wasm_bindgen(constructor)]
    pub fn new(level_json: &str, config_json: &str, population: u32, seed: u32) -> Result<WasmSim, JsValue> {
        let level = LevelPack::from_json(level_json).map_err(|e| JsValue::from_str(&e))?;
        let cfg = if config_json.is_empty() { Config::default_config() } else { Config::from_json(config_json).map_err(|e| JsValue::from_str(&e))? };
        let sim = Sim::new(&level, cfg, population, seed as u64);
        let n = sim.n;
        let mut w = WasmSim { sim, pos: vec![0.0; n * 2], render: vec![0; n] };
        w.pack();
        Ok(w)
    }

    /// Advance `ticks` ticks (stops early if the game ends).
    pub fn step(&mut self, ticks: u32) {
        for _ in 0..ticks {
            self.sim.step_timed(&mut PerfClock);
        }
    }

    /// Advance one tick without per-phase timing.
    pub fn step_untimed(&mut self) {
        self.sim.step();
    }

    /// Copy positions (interleaved x, y) and render states into the export buffers.
    pub fn pack(&mut self) {
        let s = &self.sim;
        for i in 0..s.n {
            self.pos[2 * i] = s.x[i];
            self.pos[2 * i + 1] = s.y[i];
            self.render[i] = if s.state[i] == DEAD && s.timer[i] > 0 { FRESH_KILL } else { s.state[i] };
        }
    }
    pub fn positions_ptr(&self) -> *const f32 {
        self.pos.as_ptr()
    }
    pub fn render_ptr(&self) -> *const u8 {
        self.render.as_ptr()
    }
    pub fn count(&self) -> u32 {
        self.sim.n as u32
    }
    pub fn tick(&self) -> u32 {
        self.sim.tick
    }
    /// 0 setup, 1 running, 2 win, 3 loss, 4 timeout.
    pub fn game_phase(&self) -> u8 {
        match self.sim.phase {
            GamePhase::Setup => 0,
            GamePhase::Running => 1,
            GamePhase::Ended(Outcome::Win) => 2,
            GamePhase::Ended(Outcome::Loss) => 3,
            GamePhase::Ended(Outcome::Timeout) => 4,
        }
    }

    /// [civilians, infected, zombies, dead, dormant, initial_civilians,
    ///  zombies_killed, tick, towers_left, fence_left_m, first_breach_tick or -1,
    ///  fence_cells_broken]
    pub fn stats(&self) -> Vec<f64> {
        let s = &self.sim.stats;
        vec![
            s.civilians as f64,
            s.infected as f64,
            s.zombies as f64,
            s.dead as f64,
            s.dormant as f64,
            s.initial_civilians as f64,
            s.zombies_killed as f64,
            self.sim.tick as f64,
            self.sim.towers_left() as f64,
            self.sim.fence_left_m() as f64,
            s.first_breach_tick.map_or(-1.0, |t| t as f64),
            s.fence_cells_broken as f64,
        ]
    }

    /// Milliseconds per phase in the last tick (hash, fields, civilians, zombies,
    /// infected, separation, integrate, towers, fences).
    pub fn phase_ms(&self) -> Vec<f64> {
        self.sim.phase_ms.to_vec()
    }

    pub fn state_hash(&self) -> String {
        format!("{:016x}", self.sim.state_hash())
    }

    // --------------------------------------------------------------- level

    pub fn grid_w(&self) -> u32 {
        self.sim.grid.w as u32
    }
    pub fn grid_h(&self) -> u32 {
        self.sim.grid.h as u32
    }
    pub fn cell_size(&self) -> f32 {
        self.sim.grid.cell
    }
    /// Level-local coordinates of the level centre in sim coordinates.
    pub fn center(&self) -> Vec<f32> {
        self.sim.to_sim(0.0, 0.0).to_vec()
    }
    /// All building polygons, concatenated x, y pairs.
    pub fn building_coords(&self) -> Vec<f32> {
        self.sim.grid.buildings.iter().flat_map(|b| b.polygon.iter().flat_map(|p| [p[0], p[1]])).collect()
    }
    /// Start index (in points) of each building in `building_coords`, plus a final end.
    pub fn building_offsets(&self) -> Vec<u32> {
        let mut out = Vec::with_capacity(self.sim.grid.buildings.len() + 1);
        let mut k = 0u32;
        for b in &self.sim.grid.buildings {
            out.push(k);
            k += b.polygon.len() as u32;
        }
        out.push(k);
        out
    }
    pub fn building_centroids(&self) -> Vec<f32> {
        self.sim.grid.buildings.iter().flat_map(|b| b.centroid).collect()
    }
    /// Cells outside the playable area (the circle edge), for drawing the boundary.
    pub fn level_radius(&self) -> f32 {
        // Distance from the centre to the farthest walkable cell.
        let [cx, cy] = self.sim.to_sim(0.0, 0.0);
        let g = &self.sim.grid;
        let mut r2 = 0.0f32;
        for i in 0..g.kind.len() {
            if g.kind[i] != sim_core::grid::WALL {
                let [x, y] = g.cell_center(i);
                r2 = r2.max((x - cx) * (x - cx) + (y - cy) * (y - cy));
            }
        }
        r2.sqrt()
    }

    /// Fence cells as [x, y, hp_ratio] triples (cell centres).
    pub fn fences(&self) -> Vec<f32> {
        let g = &self.sim.grid;
        let hp = self.sim.cfg.fence_cell_hp;
        let mut out = Vec::new();
        for i in 0..g.kind.len() {
            if g.kind[i] == sim_core::grid::FENCE {
                let [x, y] = g.cell_center(i);
                out.extend_from_slice(&[x, y, g.fence_hp[i] / hp]);
            }
        }
        out
    }

    /// Towers as [building, x, y, shots, kills] groups.
    pub fn towers(&self) -> Vec<f32> {
        self.sim.towers.iter().flat_map(|t| [t.building as f32, t.x, t.y, t.shots as f32, t.kills as f32]).collect()
    }

    pub fn tower_range(&self) -> f32 {
        self.sim.cfg.tower_range_m
    }

    // ---------------------------------------------------------- commands

    pub fn building_at(&self, x: f32, y: f32) -> i32 {
        self.sim.building_at(x, y).map_or(-1, |b| b as i32)
    }
    pub fn place_tower_at(&mut self, x: f32, y: f32) -> Result<u32, JsValue> {
        let b = self.sim.building_at(x, y).ok_or_else(|| JsValue::from_str("click a building to garrison it"))?;
        self.sim.place_tower(b).map_err(|e| JsValue::from_str(&e))?;
        Ok(b)
    }
    pub fn place_tower(&mut self, building: u32) -> Result<(), JsValue> {
        self.sim.place_tower(building).map_err(|e| JsValue::from_str(&e))
    }
    /// Place a fence from a flat [x0, y0, x1, y1, ...] polyline.
    pub fn place_fence(&mut self, pts: &[f32]) -> Result<f32, JsValue> {
        let p: Vec<[f32; 2]> = pts.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let r = self.sim.place_fence(&p).map_err(|e| JsValue::from_str(&e));
        self.pack();
        r
    }
    pub fn undo(&mut self) -> bool {
        self.sim.undo()
    }
    pub fn clear(&mut self) {
        self.sim.clear_placements()
    }
    pub fn start(&mut self) {
        self.sim.start();
        self.pack();
    }

    // ------------------------------------------------------------- debug

    pub fn chase_field(&self) -> Vec<i32> {
        self.sim.chase.clone()
    }
    pub fn flee_field(&self) -> Vec<i32> {
        self.sim.flee.clone()
    }
    pub fn hash_dims(&self) -> Vec<f32> {
        vec![self.sim.hash_w as f32, self.sim.hash_h as f32, self.sim.cfg.hash_bucket_m]
    }
}

/// The native/WASM determinism fixture (see sim-core `fixture`).
#[wasm_bindgen]
pub fn fixture_hash(level_json: &str) -> Result<String, JsValue> {
    let level = LevelPack::from_json(level_json).map_err(|e| JsValue::from_str(&e))?;
    Ok(format!("{:016x}", sim_core::fixture::compute_fixture_hash(&level)))
}

// ================================================================== match

use sim_core::match_::{Action, BuildingChunk, Match, MatchSetup};
use sim_core::record::{ReplayMap, RunRecord};

/// A JS error value: the JSON of `{"error": <kind>, ...fields, "message":
/// <readable text>}` (parse it with `JSON.parse(String(e))`).
fn js_err<E: serde::Serialize + std::fmt::Display>(e: &E) -> JsValue {
    let mut v = serde_json::to_value(e).unwrap_or(serde_json::Value::Null);
    if !v.is_object() {
        v = serde_json::json!({ "error": v });
    }
    v["message"] = serde_json::Value::String(e.to_string());
    JsValue::from_str(&v.to_string())
}

fn js_msg(kind: &str, msg: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&serde_json::json!({ "error": kind, "message": msg.to_string() }).to_string())
}

/// `{"seed": "123" | 123, "population_multiplier"?: number, "deck"?: [card ids]}`:
/// missing fields take the config's multiplier and the starter deck. The
/// seed may be a decimal string (JS numbers stop at 2^53).
fn parse_setup(json: &str, cfg: &Config) -> Result<MatchSetup, JsValue> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| js_msg("bad_setup", e))?;
    let seed = match &v["seed"] {
        serde_json::Value::String(s) => s.parse::<u64>().map_err(|e| js_msg("bad_setup", format!("seed: {e}")))?,
        serde_json::Value::Number(n) => n.as_u64().ok_or_else(|| js_msg("bad_setup", "seed must be a non-negative integer"))?,
        _ => return Err(js_msg("bad_setup", "seed is required")),
    };
    let mut setup = MatchSetup::new(seed, cfg);
    if let Some(k) = v["population_multiplier"].as_f64() {
        setup.population_multiplier = k as f32;
    }
    if !v["deck"].is_null() {
        setup.deck = serde_json::from_value(v["deck"].clone()).map_err(|e| js_msg("bad_setup", format!("deck: {e}")))?;
    }
    Ok(setup)
}

/// The 8-wave match (sim-core `Match`) for the browser: actions in, state
/// out, plus the run record. Uses the embedded config and cards.
#[wasm_bindgen]
pub struct WasmMatch {
    m: Match,
    pos: Vec<f32>,
    render: Vec<u8>,
}

#[wasm_bindgen]
impl WasmMatch {
    /// A match on a whole level (`level_json`: a level pack). See
    /// `parse_setup` for `setup_json`.
    #[wasm_bindgen(constructor)]
    pub fn new(level_json: &str, setup_json: &str) -> Result<WasmMatch, JsValue> {
        let level = LevelPack::from_json(level_json).map_err(|e| js_msg("bad_level", e))?;
        let cfg = Config::default_config();
        let setup = parse_setup(setup_json, &cfg)?;
        let m = Match::new(&level, cfg, setup).map_err(|e| js_err(&e))?;
        Ok(WasmMatch::wrap(m))
    }

    /// A streamed match: `shell_json` is the level without buildings,
    /// `chunks_json` a `BuildingChunk[]` covering at least wave 1's ring.
    pub fn new_streaming(shell_json: &str, setup_json: &str, chunks_json: &str) -> Result<WasmMatch, JsValue> {
        let shell = LevelPack::from_json(shell_json).map_err(|e| js_msg("bad_level", e))?;
        let chunks: Vec<BuildingChunk> = serde_json::from_str(chunks_json).map_err(|e| js_msg("bad_chunks", e))?;
        let cfg = Config::default_config();
        let setup = parse_setup(setup_json, &cfg)?;
        let m = Match::new_streaming(&shell, cfg, setup, chunks).map_err(|e| js_err(&e))?;
        Ok(WasmMatch::wrap(m))
    }

    fn wrap(m: Match) -> WasmMatch {
        let cap = m.sim().x.len();
        let mut w = WasmMatch { m, pos: vec![0.0; cap * 2], render: vec![0; cap] };
        w.pack();
        w
    }

    /// Add one `BuildingChunk` (JSON). Map data, not a player action.
    pub fn add_buildings(&mut self, chunk_json: &str) -> Result<(), JsValue> {
        let c: BuildingChunk = serde_json::from_str(chunk_json).map_err(|e| js_msg("bad_chunks", e))?;
        self.m.add_buildings(c).map_err(|e| js_err(&e))
    }
    pub fn ring_ready(&self, wave: u8) -> bool {
        self.m.ring_ready(wave)
    }

    /// Apply an `Action` (JSON, e.g. `{"type":"play_card","hand_index":0,
    /// "target":{"point":[x,y]}}`). A refusal throws the `ActionError` JSON.
    pub fn apply(&mut self, action_json: &str) -> Result<(), JsValue> {
        let a: Action = serde_json::from_str(action_json).map_err(|e| js_msg("bad_action", e))?;
        let r = self.m.apply(a).map_err(|e| js_err(&e));
        self.pack();
        r
    }

    /// Advance `ticks` ticks (any phase; result phases just count ticks).
    pub fn step(&mut self, ticks: u32) {
        for _ in 0..ticks {
            self.m.step_timed(&mut PerfClock);
        }
    }

    /// Copy positions (interleaved x, y) and render states of the agents in
    /// play into the export buffers (see `WasmSim::pack`).
    pub fn pack(&mut self) {
        let s = self.m.sim();
        for i in 0..s.n {
            self.pos[2 * i] = s.x[i];
            self.pos[2 * i + 1] = s.y[i];
            self.render[i] = if s.state[i] == DEAD && s.timer[i] > 0 { FRESH_KILL } else { s.state[i] };
        }
    }
    pub fn positions_ptr(&self) -> *const f32 {
        self.pos.as_ptr()
    }
    pub fn render_ptr(&self) -> *const u8 {
        self.render.as_ptr()
    }
    /// Agents in play (the export buffers hold the slot capacity).
    pub fn count(&self) -> u32 {
        self.m.sim().n as u32
    }

    // -------------------------------------------------------- queries

    /// Match tick (steps since creation; exact below 2^53).
    pub fn tick(&self) -> f64 {
        self.m.tick() as f64
    }
    pub fn wave(&self) -> u8 {
        self.m.wave()
    }
    pub fn waves(&self) -> u8 {
        self.m.waves()
    }
    /// `prep`, `running`, `wave_won`, `wave_lost` or `match_won`.
    pub fn phase(&self) -> String {
        serde_json::to_value(self.m.phase()).unwrap().as_str().unwrap().to_string()
    }
    /// Everything a HUD needs, as JSON: tick, wave, waves, phase, wave_tick,
    /// radius_m, next_radius_m, next_ring_ready, supply, income, deck_count,
    /// discard_count, reshuffles, retries, restarts, fatigue,
    /// defeat_threshold, wave_start_civilians, newcomers,
    /// mulligan_available, mulligan_cost, stats {civilians, infected,
    /// zombies, dead, zombies_killed, bites, fence_cells_broken}.
    pub fn status_json(&self) -> String {
        let m = &self.m;
        let s = &m.sim().stats;
        let next = (m.wave() + 1).min(m.waves());
        serde_json::json!({
            "tick": m.tick(),
            "wave": m.wave(),
            "waves": m.waves(),
            "phase": m.phase(),
            "wave_tick": m.wave_tick(),
            "radius_m": m.radius_m(),
            "next_radius_m": m.ring_radius_m(next),
            "next_ring_ready": m.ring_ready(next),
            "supply": m.supply(),
            "income": m.supply_income(),
            "deck_count": m.deck_count(),
            "discard_count": m.discard_count(),
            "reshuffles": m.reshuffles(),
            "retries": m.retries(),
            "restarts": m.restarts(),
            "fatigue": m.fatigue(),
            "defeat_threshold": m.defeat_threshold(),
            "wave_start_civilians": m.wave_start_civilians(),
            "newcomers": m.newcomers(),
            "mulligan_available": m.mulligan_available(),
            "mulligan_cost": m.mulligan_cost(),
            "stats": {
                "civilians": s.civilians, "infected": s.infected, "zombies": s.zombies, "dead": s.dead,
                "zombies_killed": s.zombies_killed, "bites": s.bites, "fence_cells_broken": s.fence_cells_broken,
            },
        })
        .to_string()
    }
    /// `HandCardView[]` JSON.
    pub fn hand_json(&self) -> String {
        serde_json::to_string(&self.m.hand()).unwrap()
    }
    /// `WaveResult[]` JSON (latest attempt of each wave; hashes as numbers
    /// may lose precision in JS, use `attempts_json` for hashes).
    pub fn results_json(&self) -> String {
        serde_json::to_string(self.m.results()).unwrap()
    }
    /// `WaveAttempt[]` JSON (hashes as hex strings).
    pub fn attempts_json(&self) -> String {
        serde_json::to_string(self.m.attempts()).unwrap()
    }
    /// `Structure[]` JSON (fences and garrisons with ids for repair / pull-down).
    pub fn structures_json(&self) -> String {
        serde_json::to_string(self.m.structures()).unwrap()
    }
    pub fn repair_cost(&self, fence_id: u32) -> i32 {
        self.m.repair_cost(fence_id).map_or(-1, |c| c as i32)
    }
    pub fn pull_down_refund(&self, id: u32) -> i32 {
        self.m.pull_down_refund(id).map_or(-1, |c| c as i32)
    }
    /// The fence structure owning the cell under (x, y), or -1.
    pub fn structure_at(&self, x: f32, y: f32) -> i32 {
        let g = &self.m.sim().grid;
        if !(x >= 0.0 && y >= 0.0 && x < g.w as f32 * g.cell && y < g.h as f32 * g.cell) {
            return -1;
        }
        self.m.structure_at_cell(g.cell_of(x, y) as u32).map_or(-1, |s| s.id as i32)
    }
    /// Placed length of a fence along a flat [x0, y0, x1, y1, ...] polyline;
    /// throws why it can't be placed.
    pub fn fence_length_m(&self, pts: &[f32]) -> Result<f32, JsValue> {
        let p: Vec<[f32; 2]> = pts.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        self.m.fence_length_m(&p).map_err(|e| js_msg("placement", e))
    }
    /// The building on the clicked cell, or -1 (`Match::building_at`: no
    /// polygon fallback, so never a half-applied building's open part).
    pub fn building_at(&self, x: f32, y: f32) -> i32 {
        self.m.building_at(x, y).map_or(-1, |b| b as i32)
    }
    pub fn point_revealed(&self, x: f32, y: f32) -> bool {
        self.m.point_revealed(x, y)
    }
    pub fn wave_of_point(&self, x: f32, y: f32) -> u8 {
        self.m.wave_of_point(x, y)
    }
    pub fn state_hash(&self) -> String {
        format!("{:016x}", self.m.state_hash())
    }
    pub fn prep_hash(&self) -> String {
        format!("{:016x}", self.m.prep_hash())
    }

    // ------------------------------------------------------- geometry

    pub fn grid_w(&self) -> u32 {
        self.m.sim().grid.w as u32
    }
    pub fn grid_h(&self) -> u32 {
        self.m.sim().grid.h as u32
    }
    pub fn cell_size(&self) -> f32 {
        self.m.sim().grid.cell
    }
    /// Play-area centre, sim coordinates.
    pub fn center(&self) -> Vec<f32> {
        self.m.center().to_vec()
    }
    pub fn radius_m(&self) -> f32 {
        self.m.radius_m()
    }
    pub fn ring_radius_m(&self, wave: u8) -> f32 {
        self.m.ring_radius_m(wave)
    }
    /// Applied building polygons (grows as rings are revealed), flat x, y.
    pub fn building_coords(&self) -> Vec<f32> {
        self.m.sim().grid.buildings.iter().flat_map(|b| b.polygon.iter().flat_map(|p| [p[0], p[1]])).collect()
    }
    /// Start index (in points) of each building in `building_coords`, plus a final end.
    pub fn building_offsets(&self) -> Vec<u32> {
        let mut out = Vec::with_capacity(self.m.sim().grid.buildings.len() + 1);
        let mut k = 0u32;
        for b in &self.m.sim().grid.buildings {
            out.push(k);
            k += b.polygon.len() as u32;
        }
        out.push(k);
        out
    }
    pub fn building_centroids(&self) -> Vec<f32> {
        self.m.sim().grid.buildings.iter().flat_map(|b| b.centroid).collect()
    }
    /// Fence cells as [x, y, hp] triples (cell centres, hp in points).
    pub fn fences(&self) -> Vec<f32> {
        let g = &self.m.sim().grid;
        let mut out = Vec::new();
        for i in 0..g.kind.len() {
            if g.kind[i] == sim_core::grid::FENCE {
                let [x, y] = g.cell_center(i);
                out.extend_from_slice(&[x, y, g.fence_hp[i]]);
            }
        }
        out
    }
    /// Shooters as [building or -1, x, y, range_m, kills] groups.
    pub fn towers(&self) -> Vec<f32> {
        self.m.sim().towers.iter().flat_map(|t| [if t.is_unit() { -1.0 } else { t.building as f32 }, t.x, t.y, t.weapon.range_m, t.kills as f32]).collect()
    }

    // --------------------------------------------------------- record

    /// The run record of the match so far (`RunRecord` JSON); abandoned
    /// unless the match is won. Costs one state hash (~24 ms at wave 8).
    pub fn record(&self) -> String {
        RunRecord::from_match(&self.m).to_json()
    }
}

/// Verify a run record (JSON) on a whole level (JSON) with the embedded
/// config and cards. `expected_json` (optional) is what the server issued,
/// `{"seed"?: "123" | 123, "deck"?: [card ids], "population_multiplier"?:
/// number}` (`ExpectedRun`); a record that differs is rejected as
/// `unexpected`. Only `undefined` means no expectation: `""`, `"null"`
/// and `{}` throw `bad_expected`. Returns the `ReplaySummary` JSON
/// (`setup_checked` says whether the expectation ran); throws the
/// `VerifyError` JSON (with `message`).
#[wasm_bindgen]
pub fn verify_level(record_json: &str, level_json: &str, expected_json: Option<String>) -> Result<String, JsValue> {
    let record = RunRecord::from_json(record_json).map_err(|e| js_msg("bad_record", e))?;
    let level = LevelPack::from_json(level_json).map_err(|e| js_msg("bad_level", e))?;
    verify_on(&record, ReplayMap::Level(&level), expected_json)
}

/// Verify a run record (JSON) on streamed chunks (`BuildingChunk[]` JSON,
/// any order) and the server's shell (`LevelPack` JSON without buildings:
/// centre, radius or bounds, fences), never the record's own: the record's
/// shell must equal it bit for bit (`map_shell`). `expected_json` as for
/// `verify_level`. Same results as `verify_level`.
#[wasm_bindgen]
pub fn verify_chunks(record_json: &str, shell_json: &str, chunks_json: &str, expected_json: Option<String>) -> Result<String, JsValue> {
    let record = RunRecord::from_json(record_json).map_err(|e| js_msg("bad_record", e))?;
    let shell = LevelPack::from_json(shell_json).map_err(|e| js_msg("bad_shell", e))?;
    let chunks: Vec<BuildingChunk> = serde_json::from_str(chunks_json).map_err(|e| js_msg("bad_chunks", e))?;
    verify_on(&record, ReplayMap::Chunks { shell: &shell, chunks: &chunks }, expected_json)
}

fn verify_on(record: &RunRecord, map: ReplayMap, expected_json: Option<String>) -> Result<String, JsValue> {
    // Only `undefined` / `None` means "no expectation": `""`, `"null"` and
    // `{}` are refused, so a caller's bug can't switch every check off.
    let expected = match expected_json.as_deref() {
        Some(s) => {
            let x = sim_core::record::ExpectedRun::from_json(s).map_err(|e| js_msg("bad_expected", e))?;
            if x.is_empty() {
                return Err(js_msg("bad_expected", "expected run: no field given (pass undefined for no expectation)"));
            }
            Some(x)
        }
        None => None,
    };
    let cfg = Config::default_config();
    let limits = sim_core::record::ReplayLimits::for_config(&cfg);
    let s = sim_core::record::replay_with(record, map, expected.as_ref(), cfg, sim_core::CardDb::default_cards(), &limits, &mut |_| true).map_err(|e| js_err(&e))?;
    Ok(serde_json::to_string(&s).unwrap())
}
