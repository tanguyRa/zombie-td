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
