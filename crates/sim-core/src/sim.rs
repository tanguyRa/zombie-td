//! The simulation: struct-of-arrays agents, spatial hash, flow fields, rules,
//! towers and fences, advanced by a fixed-order tick.

use crate::config::Config;
use crate::field::{self, Dial, Mode, DIR_UNIT, INF};
use crate::grid::{Grid, BUILDING, FENCE, NO_BUILDING, WALK};
use crate::level::{self, BuildingKind, LevelPack};
use crate::rng::Pcg32;

pub const CIVILIAN: u8 = 0;
pub const INFECTED: u8 = 1;
pub const ZOMBIE: u8 = 2;
pub const DEAD: u8 = 3;

const NONE: u32 = u32::MAX;

/// 16 unit directions for the random walk (precomputed, no trig at runtime).
const WANDER_DIRS: [[f32; 2]; 16] = [
    [1.0, 0.0],
    [0.923_879_5, 0.382_683_43],
    [0.707_106_77, 0.707_106_77],
    [0.382_683_43, 0.923_879_5],
    [0.0, 1.0],
    [-0.382_683_43, 0.923_879_5],
    [-0.707_106_77, 0.707_106_77],
    [-0.923_879_5, 0.382_683_43],
    [-1.0, 0.0],
    [-0.923_879_5, -0.382_683_43],
    [-0.707_106_77, -0.707_106_77],
    [-0.382_683_43, -0.923_879_5],
    [0.0, -1.0],
    [0.382_683_43, -0.923_879_5],
    [0.707_106_77, -0.707_106_77],
    [0.923_879_5, -0.382_683_43],
];

pub const PHASES: [&str; 9] = ["hash", "fields", "civilians", "zombies", "infected", "separation", "integrate", "towers", "fences"];

/// Time source for per-phase timing (milliseconds). The core does no I/O, so
/// the caller provides it.
pub trait Clock {
    fn now_ms(&mut self) -> f64;
}
pub struct NoClock;
impl Clock for NoClock {
    fn now_ms(&mut self) -> f64 {
        0.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Win,
    Loss,
    Timeout,
}

impl Outcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Outcome::Win => "win",
            Outcome::Loss => "loss",
            Outcome::Timeout => "timeout",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GamePhase {
    Setup,
    Running,
    Ended(Outcome),
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub civilians: u32,
    pub infected: u32,
    pub zombies: u32,
    pub dead: u32,
    pub dormant: u32,
    pub initial_civilians: u32,
    pub zombies_killed: u32,
    pub bites: u32,
    pub fence_cells_broken: u32,
    pub first_breach_tick: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct Tower {
    pub building: u32,
    pub x: f32,
    pub y: f32,
    pub cooldown: u32,
    pub shots: u32,
    pub kills: u32,
}

#[derive(Clone, Debug)]
pub enum Placement {
    Tower(u32),
    Fence { cells: Vec<u32>, length_m: f32 },
}

pub struct Sim {
    pub cfg: Config,
    pub grid: Grid,
    pub seed: u64,
    rng: Pcg32,

    pub n: usize,
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub vx: Vec<f32>,
    pub vy: Vec<f32>,
    pub state: Vec<u8>,
    pub timer: Vec<u16>,
    pub hp: Vec<u16>,
    pub bite_cd: Vec<u8>,
    /// Movement multiplier this tick: 0 = not updated, 1 = awake, P = dormant update.
    step_mul: Vec<u8>,
    pub sep_x: Vec<f32>,
    pub sep_y: Vec<f32>,
    spawn_x: Vec<f32>,
    spawn_y: Vec<f32>,

    // Spatial hash (counting sort into flat arrays).
    pub hash_w: usize,
    pub hash_h: usize,
    bucket_m: f32,
    bucket_start: Vec<u32>,
    /// End of the civilian run inside each bucket (civilians are stored first).
    bucket_civ_end: Vec<u32>,
    bucket_fill: Vec<u32>,
    agent_ids: Vec<u32>,
    agent_bucket: Vec<u32>,
    /// Positions and states copied in bucket order at hash time, so
    /// neighbour scans read contiguous memory.
    hx: Vec<f32>,
    hy: Vec<f32>,
    hs: Vec<u8>,

    // Flow fields.
    pub chase: Vec<i32>,
    pub threat: Vec<i32>,
    pub flee: Vec<i32>,
    dial: Dial,
    flee_seeds: Vec<(u32, i32)>,
    fields_dirty: bool,
    pub field_recomputes: u32,

    // Fences.
    fence_damage: Vec<f32>,
    fence_touched: Vec<u32>,

    pub towers: Vec<Tower>,
    pub placements: Vec<Placement>,
    pub fence_used_m: f32,
    /// Civilians spawned per building (index = building index).
    pub spawn_counts: Vec<u32>,
    /// Raw (unscaled) population weight per building.
    pub spawn_weights: Vec<f64>,

    pub tick: u32,
    pub phase: GamePhase,
    pub stats: Stats,
    /// Milliseconds spent in each phase during the last tick (see `PHASES`).
    pub phase_ms: [f64; 9],
}

#[inline]
fn density(kind: BuildingKind) -> f64 {
    match kind {
        BuildingKind::Residential => 1.0 / 30.0,
        BuildingKind::Commercial => 1.0 / 60.0,
        BuildingKind::Other => 1.0 / 100.0,
    }
}

impl Sim {
    pub fn new(level: &LevelPack, cfg: Config, population: u32, seed: u64) -> Sim {
        let grid = Grid::from_level(level, &cfg);
        let cells = grid.w * grid.h;
        let bucket_m = cfg.hash_bucket_m;
        let hash_w = ((grid.w as f32 * grid.cell) / bucket_m).ceil() as usize + 1;
        let hash_h = ((grid.h as f32 * grid.cell) / bucket_m).ceil() as usize + 1;
        let n = population as usize;
        let mut sim = Sim {
            rng: Pcg32::new(seed, 0x7a6f_6d62),
            seed,
            n,
            x: vec![0.0; n],
            y: vec![0.0; n],
            vx: vec![0.0; n],
            vy: vec![0.0; n],
            state: vec![CIVILIAN; n],
            timer: vec![0; n],
            hp: vec![0; n],
            bite_cd: vec![0; n],
            step_mul: vec![0; n],
            sep_x: vec![0.0; n],
            sep_y: vec![0.0; n],
            spawn_x: Vec::new(),
            spawn_y: Vec::new(),
            hash_w,
            hash_h,
            bucket_m,
            bucket_start: vec![0; hash_w * hash_h + 1],
            bucket_civ_end: vec![0; hash_w * hash_h],
            bucket_fill: vec![0; hash_w * hash_h],
            agent_ids: vec![0; n],
            agent_bucket: vec![NONE; n],
            hx: vec![0.0; n],
            hy: vec![0.0; n],
            hs: vec![0; n],
            chase: vec![INF; cells],
            threat: vec![INF; cells],
            flee: vec![INF; cells],
            dial: Dial::new(cfg.fence_path_cost),
            flee_seeds: Vec::with_capacity(cells),
            fields_dirty: true,
            field_recomputes: 0,
            fence_damage: vec![0.0; cells],
            fence_touched: Vec::with_capacity(cells),
            towers: Vec::new(),
            placements: Vec::new(),
            fence_used_m: 0.0,
            spawn_counts: Vec::new(),
            spawn_weights: Vec::new(),
            tick: 0,
            phase: GamePhase::Setup,
            stats: Stats::default(),
            phase_ms: [0.0; 9],
            grid,
            cfg,
        };
        sim.spawn_population(population);
        sim.spawn_x = sim.x.clone();
        sim.spawn_y = sim.y.clone();
        sim.stats.civilians = n as u32;
        sim.stats.initial_civilians = n as u32;
        sim
    }

    // ------------------------------------------------------------------ setup

    /// Walkable cells within `r` meters of each building's polygon.
    fn spawn_candidates(&self, b: usize, r: f32) -> Vec<u32> {
        let g = &self.grid;
        let poly = &g.buildings[b].polygon;
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &[x, y] in poly {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        let cx0 = (((x0 - r) / g.cell).floor().max(0.0)) as usize;
        let cy0 = (((y0 - r) / g.cell).floor().max(0.0)) as usize;
        let cx1 = (((x1 + r) / g.cell).ceil() as usize).min(g.w - 1);
        let cy1 = (((y1 + r) / g.cell).ceil() as usize).min(g.h - 1);
        let mut out = Vec::new();
        for cy in cy0..=cy1 {
            for cx in cx0..=cx1 {
                let i = cy * g.w + cx;
                if g.kind[i] != WALK {
                    continue;
                }
                let [px, py] = g.cell_center(i);
                if level::point_in_polygon(px, py, poly) || level::dist2_to_polygon_edge(px, py, poly) <= r * r {
                    out.push(i as u32);
                }
            }
        }
        out
    }

    fn spawn_population(&mut self, population: u32) {
        let nb = self.grid.buildings.len();
        let mut candidates: Vec<Vec<u32>> = Vec::with_capacity(nb);
        let mut raw: Vec<f64> = Vec::with_capacity(nb);
        for b in 0..nb {
            let mut r = self.cfg.spawn_radius_m;
            let mut c = self.spawn_candidates(b, r);
            while c.is_empty() && r < self.cfg.spawn_radius_m * 5.0 {
                r += self.cfg.spawn_radius_m;
                c = self.spawn_candidates(b, r);
            }
            let info = &self.grid.buildings[b];
            raw.push(if c.is_empty() { 0.0 } else { info.area_m2 as f64 * info.floors.max(1.0) as f64 * density(info.kind) });
            candidates.push(c);
        }
        let total: f64 = raw.iter().sum();
        let mut counts = vec![0u32; nb];
        if total > 0.0 {
            // Largest remainder: floors first, then the biggest fractional parts.
            let quotas: Vec<f64> = raw.iter().map(|r| r / total * population as f64).collect();
            let mut assigned = 0u32;
            for b in 0..nb {
                counts[b] = quotas[b].floor() as u32;
                assigned += counts[b];
            }
            let mut order: Vec<usize> = (0..nb).filter(|&b| raw[b] > 0.0).collect();
            order.sort_by(|&a, &b| {
                let fa = quotas[a] - quotas[a].floor();
                let fb = quotas[b] - quotas[b].floor();
                fb.partial_cmp(&fa).unwrap().then(a.cmp(&b))
            });
            let mut k = 0;
            while assigned < population {
                counts[order[k % order.len()]] += 1;
                assigned += 1;
                k += 1;
            }
        }
        // Levels with no buildings (open_field): scatter over all walkable cells.
        let all_walk: Vec<u32> = if total > 0.0 {
            Vec::new()
        } else {
            (0..self.grid.kind.len()).filter(|&i| self.grid.kind[i] == WALK).map(|i| i as u32).collect()
        };
        let mut a = 0usize;
        let cell = self.grid.cell;
        let place = |sim: &mut Sim, list: &[u32], a: &mut usize| {
            let c = list[sim.rng.below(list.len() as u32) as usize] as usize;
            let jx = 0.1 + 0.8 * sim.rng.f32();
            let jy = 0.1 + 0.8 * sim.rng.f32();
            sim.x[*a] = ((c % sim.grid.w) as f32 + jx) * cell;
            sim.y[*a] = ((c / sim.grid.w) as f32 + jy) * cell;
            *a += 1;
        };
        for b in 0..nb {
            for _ in 0..counts[b] {
                place(self, &candidates[b], &mut a);
            }
        }
        if !all_walk.is_empty() {
            while a < self.n {
                place(self, &all_walk, &mut a);
            }
        }
        debug_assert_eq!(a, self.n);
        for i in 0..self.n {
            self.state[i] = CIVILIAN;
        }
        self.spawn_counts = counts;
        self.spawn_weights = raw;
    }

    /// Building index under a sim-space point (cell lookup, then polygons).
    pub fn building_at(&self, x: f32, y: f32) -> Option<u32> {
        if x < 0.0 || y < 0.0 {
            return None;
        }
        let c = self.grid.cell_of(x, y);
        if self.grid.building[c] != NO_BUILDING {
            return Some(self.grid.building[c]);
        }
        self.grid.buildings.iter().position(|b| level::point_in_polygon(x, y, &b.polygon)).map(|b| b as u32)
    }

    pub fn towers_left(&self) -> u32 {
        self.cfg.tower_budget.saturating_sub(self.towers.len() as u32)
    }
    pub fn fence_left_m(&self) -> f32 {
        (self.cfg.fence_budget_m - self.fence_used_m).max(0.0)
    }

    pub fn place_tower(&mut self, building: u32) -> Result<(), String> {
        if self.phase != GamePhase::Setup {
            return Err("towers can only be placed during setup".into());
        }
        if building as usize >= self.grid.buildings.len() {
            return Err("no such building".into());
        }
        if self.towers.iter().any(|t| t.building == building) {
            return Err("this building already has a garrison".into());
        }
        if self.towers_left() == 0 {
            return Err("tower budget exhausted".into());
        }
        let [x, y] = self.grid.buildings[building as usize].centroid;
        self.towers.push(Tower { building, x, y, cooldown: 0, shots: 0, kills: 0 });
        self.placements.push(Placement::Tower(building));
        Ok(())
    }

    /// Place a fence polyline (sim coordinates). Returns its length in meters.
    pub fn place_fence(&mut self, pts: &[[f32; 2]]) -> Result<f32, String> {
        if self.phase != GamePhase::Setup {
            return Err("fences can only be placed during setup".into());
        }
        if pts.len() < 2 {
            return Err("a fence needs at least two points".into());
        }
        let length: f32 = pts
            .windows(2)
            .map(|s| {
                let (dx, dy) = (s[1][0] - s[0][0], s[1][1] - s[0][1]);
                (dx * dx + dy * dy).sqrt()
            })
            .sum();
        let cells = self.grid.rasterize_polyline(pts);
        // Cells on buildings or the map edge are clipped away: a fence drawn
        // from wall to wall seals the street. The budget pays only for the
        // share of the line that is actually placed.
        let open: Vec<usize> = cells.iter().copied().filter(|&c| self.grid.kind[c] == WALK || self.grid.kind[c] == FENCE).collect();
        if open.is_empty() {
            return Err("fences cannot be placed on buildings or the map edge".into());
        }
        let length = (length * open.len() as f32 / cells.len() as f32).max(self.grid.cell);
        if length > self.fence_left_m() + 1e-3 {
            return Err(format!("fence is {:.0} m, only {:.0} m left", length, self.fence_left_m()));
        }
        let cells = open;
        let mut new_cells = Vec::new();
        for c in cells {
            if self.grid.kind[c] == WALK {
                self.grid.kind[c] = FENCE;
                self.grid.fence_hp[c] = self.cfg.fence_cell_hp;
                new_cells.push(c as u32);
            }
        }
        self.fence_used_m += length;
        self.placements.push(Placement::Fence { cells: new_cells, length_m: length });
        self.push_agents_off_blocked_cells();
        Ok(length)
    }

    pub fn undo(&mut self) -> bool {
        if self.phase != GamePhase::Setup {
            return false;
        }
        match self.placements.pop() {
            Some(Placement::Tower(b)) => {
                self.towers.retain(|t| t.building != b);
                true
            }
            Some(Placement::Fence { cells, length_m }) => {
                for c in cells {
                    self.grid.kind[c as usize] = WALK;
                    self.grid.fence_hp[c as usize] = 0.0;
                }
                self.fence_used_m = (self.fence_used_m - length_m).max(0.0);
                true
            }
            None => false,
        }
    }

    pub fn clear_placements(&mut self) {
        while self.undo() {}
    }

    fn nearest_walkable(&self, c: usize) -> Option<usize> {
        let g = &self.grid;
        let (cx, cy) = ((c % g.w) as i64, (c / g.w) as i64);
        for r in 1..32i64 {
            let mut best: Option<(i64, usize)> = None;
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let (x, y) = (cx + dx, cy + dy);
                    if x < 0 || y < 0 || x >= g.w as i64 || y >= g.h as i64 {
                        continue;
                    }
                    let i = y as usize * g.w + x as usize;
                    if g.kind[i] == WALK {
                        let d = dx * dx + dy * dy;
                        if best.map_or(true, |(bd, bi)| d < bd || (d == bd && i < bi)) {
                            best = Some((d, i));
                        }
                    }
                }
            }
            if let Some((_, i)) = best {
                return Some(i);
            }
        }
        None
    }

    fn push_agents_off_blocked_cells(&mut self) {
        for i in 0..self.n {
            if self.state[i] == DEAD {
                continue;
            }
            let c = self.grid.cell_of(self.x[i], self.y[i]);
            if self.grid.kind[c] != WALK {
                if let Some(t) = self.nearest_walkable(c) {
                    let [px, py] = self.grid.cell_center(t);
                    self.x[i] = px;
                    self.y[i] = py;
                }
            }
        }
    }

    /// Start the game: reset agents to their spawn, seed the outbreak, compute fields.
    pub fn start(&mut self) {
        if self.phase != GamePhase::Setup {
            return;
        }
        self.x.copy_from_slice(&self.spawn_x);
        self.y.copy_from_slice(&self.spawn_y);
        self.vx.fill(0.0);
        self.vy.fill(0.0);
        self.rng = Pcg32::new(self.seed, 0x6f75_7462);
        self.push_agents_off_blocked_cells();
        self.tick = 0;
        self.seed_outbreak();
        self.phase = GamePhase::Running;
        self.recompute_chase();
        self.recompute_threat_and_flee();
        self.fields_dirty = false;
    }

    fn seed_outbreak(&mut self) {
        let n = self.n;
        if n == 0 {
            return;
        }
        let min_sep2 = self.cfg.outbreak_min_separation_m * self.cfg.outbreak_min_separation_m;
        let mut seeds: Vec<usize> = Vec::new();
        let clusters = self.cfg.outbreak_clusters as usize;
        let mut tries = 0;
        while seeds.len() < clusters && tries < 10_000 {
            tries += 1;
            let c = self.rng.below(n as u32) as usize;
            let ok = seeds.iter().all(|&s| {
                let (dx, dy) = (self.x[s] - self.x[c], self.y[s] - self.y[c]);
                dx * dx + dy * dy >= min_sep2
            });
            // After many failures, accept any distinct civilian so small maps still start.
            if ok || (tries > 5_000 && !seeds.contains(&c)) {
                seeds.push(c);
            }
        }
        let r2 = self.cfg.outbreak_radius_m * self.cfg.outbreak_radius_m;
        let min_per = self.cfg.outbreak_min_per_cluster as usize;
        for &s in &seeds {
            let (sx, sy) = (self.x[s], self.y[s]);
            let mut near: Vec<(f32, usize)> = (0..n)
                .filter(|&i| self.state[i] == CIVILIAN)
                .map(|i| {
                    let (dx, dy) = (self.x[i] - sx, self.y[i] - sy);
                    (dx * dx + dy * dy, i)
                })
                .collect();
            near.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
            for (k, &(d2, i)) in near.iter().enumerate() {
                if d2 <= r2 || k < min_per {
                    self.make_zombie(i);
                } else {
                    break;
                }
            }
        }
    }

    fn make_zombie(&mut self, i: usize) {
        match self.state[i] {
            CIVILIAN => self.stats.civilians -= 1,
            INFECTED => self.stats.infected -= 1,
            _ => {}
        }
        self.state[i] = ZOMBIE;
        self.hp[i] = self.cfg.zombie_hp;
        self.bite_cd[i] = 0;
        self.timer[i] = 0;
        self.stats.zombies += 1;
    }

    /// Spawn a zombie at a position (tests and scripted scenarios).
    pub fn force_zombie(&mut self, i: usize, x: f32, y: f32) {
        self.x[i] = x;
        self.y[i] = y;
        if self.state[i] != ZOMBIE {
            self.make_zombie(i);
        }
    }

    /// Turn a civilian into an Infected agent (tests).
    pub fn force_infected(&mut self, i: usize) {
        if self.state[i] == CIVILIAN {
            self.stats.civilians -= 1;
            self.stats.infected += 1;
            self.state[i] = INFECTED;
            self.timer[i] = self.cfg.infection_delay_ticks;
        }
    }

    /// Convert local level coordinates (meters from the level centre) to sim coordinates.
    pub fn to_sim(&self, x: f32, y: f32) -> [f32; 2] {
        [x - self.grid.origin[0], y - self.grid.origin[1]]
    }

    /// Start without an outbreak (tests place zombies themselves).
    pub fn start_without_outbreak(&mut self) {
        self.phase = GamePhase::Running;
        self.tick = 0;
        self.recompute_chase();
        self.recompute_threat_and_flee();
        self.fields_dirty = false;
    }

    // ------------------------------------------------------------- the tick

    pub fn step(&mut self) {
        self.step_timed(&mut NoClock);
    }

    pub fn step_timed<C: Clock>(&mut self, clock: &mut C) {
        if let GamePhase::Ended(_) = self.phase {
            return;
        }
        let running = self.phase == GamePhase::Running;
        let mut t = clock.now_ms();
        let mut mark = |k: usize, clock: &mut C, ms: &mut [f64; 9]| {
            let now = clock.now_ms();
            ms[k] = now - t;
            t = now;
        };
        let mut ms = [0.0f64; 9];

        self.rebuild_hash();
        mark(0, clock, &mut ms);
        if running {
            self.update_fields();
        }
        mark(1, clock, &mut ms);
        self.update_civilians(running);
        mark(2, clock, &mut ms);
        if running {
            self.update_zombies();
        }
        mark(3, clock, &mut ms);
        self.update_infected_and_dead();
        mark(4, clock, &mut ms);
        self.compute_separation();
        mark(5, clock, &mut ms);
        self.integrate();
        mark(6, clock, &mut ms);
        if running {
            self.fire_towers();
        }
        mark(7, clock, &mut ms);
        if running {
            self.apply_fence_damage();
        }
        mark(8, clock, &mut ms);
        self.phase_ms = ms;

        if running {
            let s = &self.stats;
            if s.zombies == 0 && s.infected == 0 {
                self.phase = GamePhase::Ended(Outcome::Win);
            } else if s.civilians == 0 {
                self.phase = GamePhase::Ended(Outcome::Loss);
            } else if self.tick + 1 >= self.cfg.max_ticks() {
                self.phase = GamePhase::Ended(Outcome::Timeout);
            }
        }
        self.tick += 1;
    }

    #[inline]
    fn bucket_of(&self, x: f32, y: f32) -> usize {
        let bx = ((x / self.bucket_m) as usize).min(self.hash_w - 1);
        let by = ((y / self.bucket_m) as usize).min(self.hash_h - 1);
        by * self.hash_w + bx
    }

    /// Counting sort of agents into buckets. Inside a bucket, civilians come
    /// first, so queries for civilians (bites) or for zombies (towers) only
    /// scan their own run.
    fn rebuild_hash(&mut self) {
        let nb = self.hash_w * self.hash_h;
        self.bucket_start.fill(0);
        self.bucket_civ_end[..nb].fill(0);
        for i in 0..self.n {
            if self.state[i] == DEAD {
                self.agent_bucket[i] = NONE;
                continue;
            }
            let b = self.bucket_of(self.x[i], self.y[i]);
            self.agent_bucket[i] = b as u32;
            self.bucket_start[b + 1] += 1;
            if self.state[i] == CIVILIAN {
                self.bucket_civ_end[b] += 1; // civilian count for now
            }
        }
        for b in 0..nb {
            self.bucket_start[b + 1] += self.bucket_start[b];
        }
        for b in 0..nb {
            let civ = self.bucket_civ_end[b];
            self.bucket_civ_end[b] = self.bucket_start[b] + civ;
            self.bucket_fill[b] = self.bucket_start[b];
        }
        // Civilians first...
        for i in 0..self.n {
            let b = self.agent_bucket[i];
            if b != NONE && self.state[i] == CIVILIAN {
                let slot = self.bucket_fill[b as usize] as usize;
                self.bucket_fill[b as usize] += 1;
                self.agent_ids[slot] = i as u32;
                self.hx[slot] = self.x[i];
                self.hy[slot] = self.y[i];
                self.hs[slot] = CIVILIAN;
            }
        }
        // ...then everyone else, after the civilian run.
        for b in 0..nb {
            self.bucket_fill[b] = self.bucket_civ_end[b];
        }
        for i in 0..self.n {
            let b = self.agent_bucket[i];
            if b != NONE && self.state[i] != CIVILIAN {
                let slot = self.bucket_fill[b as usize] as usize;
                self.bucket_fill[b as usize] += 1;
                self.agent_ids[slot] = i as u32;
                self.hx[slot] = self.x[i];
                self.hy[slot] = self.y[i];
                self.hs[slot] = self.state[i];
            }
        }
    }

    /// Nearest agent in `state` within `r` of (x, y), excluding `skip`.
    fn nearest_of_state(&self, x: f32, y: f32, r: f32, state: u8, skip: usize) -> Option<(usize, f32)> {
        let bm = self.bucket_m;
        let bx0 = (((x - r) / bm).max(0.0)) as usize;
        let by0 = (((y - r) / bm).max(0.0)) as usize;
        let bx1 = (((x + r) / bm) as usize).min(self.hash_w - 1);
        let by1 = (((y + r) / bm) as usize).min(self.hash_h - 1);
        let mut best: Option<(usize, f32)> = None;
        let r2 = r * r;
        for by in by0..=by1 {
            for bx in bx0..=bx1 {
                let b = by * self.hash_w + bx;
                let range = if state == CIVILIAN {
                    self.bucket_start[b]..self.bucket_civ_end[b]
                } else {
                    self.bucket_civ_end[b]..self.bucket_start[b + 1]
                };
                for k in range {
                    let k = k as usize;
                    let (dx, dy) = (self.hx[k] - x, self.hy[k] - y);
                    let j = self.agent_ids[k] as usize;
                    if j == skip || self.state[j] != state {
                        continue;
                    }
                    let d2 = dx * dx + dy * dy;
                    if d2 <= r2 && best.map_or(true, |(bj, bd)| d2 < bd || (d2 == bd && j < bj)) {
                        best = Some((j, d2));
                    }
                }
            }
        }
        best
    }

    fn update_fields(&mut self) {
        let iv = self.cfg.field_interval_ticks.max(1);
        let phase = self.tick % iv;
        if self.fields_dirty || phase == 0 {
            self.recompute_chase();
        }
        if self.fields_dirty || phase == iv / 2 {
            self.recompute_threat_and_flee();
        }
        self.fields_dirty = false;
    }

    pub fn recompute_chase(&mut self) {
        let (grid, x, y, state) = (&self.grid, &self.x, &self.y, &self.state);
        let seeds = (0..self.n).filter(|&i| state[i] == CIVILIAN).map(|i| (grid.cell_of(x[i], y[i]) as u32, 0));
        self.dial.run(grid, Mode::Chase, self.cfg.fence_path_cost, &mut self.chase, seeds, false);
        self.field_recomputes += 1;
    }

    pub fn recompute_threat_and_flee(&mut self) {
        {
            let (grid, x, y, state) = (&self.grid, &self.x, &self.y, &self.state);
            let seeds = (0..self.n).filter(|&i| state[i] == ZOMBIE).map(|i| (grid.cell_of(x[i], y[i]) as u32, 0));
            self.dial.run(grid, Mode::Chase, self.cfg.fence_path_cost, &mut self.threat, seeds, true);
        }
        // Flee field (Brogue): -k × threat, then one more Dijkstra pass over it.
        // Seeds sorted by value come for free: capped cells first, then the
        // threat's finalization order reversed.
        let cap = (self.cfg.flee_threat_cap_m * self.cfg.cost_per_m()) as i32;
        let k = self.cfg.flee_multiplier;
        let off = (cap as f32 * k) as i32;
        self.flee_seeds.clear();
        for c in 0..self.grid.kind.len() {
            if self.grid.kind[c] == WALK && self.threat[c] >= cap {
                self.flee_seeds.push((c as u32, 0));
            }
        }
        for &c in self.dial.order.iter().rev() {
            let c = c as usize;
            let th = self.threat[c];
            if self.grid.kind[c] == WALK && th < cap {
                self.flee_seeds.push((c as u32, off - (th as f32 * k) as i32));
            }
        }
        let seeds = std::mem::take(&mut self.flee_seeds);
        self.dial.run(&self.grid, Mode::Flee, 0, &mut self.flee, seeds.iter().copied(), false);
        self.flee_seeds = seeds;
        self.field_recomputes += 1;
    }

    fn update_civilians(&mut self, running: bool) {
        let cfg = &self.cfg;
        let wake = if running { (cfg.wake_radius_m * cfg.cost_per_m()) as i32 } else { -1 };
        let period = cfg.dormant_period_ticks.max(1);
        let slot = self.tick % period;
        let keep = cfg.velocity_keep;
        let blend = 1.0 - keep;
        let off = field::offsets(self.grid.w);
        let mut dormant = 0u32;
        for i in 0..self.n {
            if self.state[i] != CIVILIAN {
                continue;
            }
            let c = self.grid.cell_of(self.x[i], self.y[i]);
            let is_dormant = !running || self.threat[c] > wake;
            let (dx, dy, vmax);
            if is_dormant {
                dormant += 1;
                if (i as u32) % period != slot {
                    self.step_mul[i] = 0;
                    continue;
                }
                self.step_mul[i] = period as u8;
                vmax = cfg.civilian_wander_speed;
                if self.rng.f32() < cfg.wander_turn_chance || (self.vx[i] == 0.0 && self.vy[i] == 0.0) {
                    let d = WANDER_DIRS[(self.rng.next_u32() & 15) as usize];
                    dx = d[0] * vmax;
                    dy = d[1] * vmax;
                } else {
                    dx = self.vx[i];
                    dy = self.vy[i];
                }
            } else {
                self.step_mul[i] = 1;
                vmax = cfg.civilian_flee_speed;
                match field::downhill(&self.grid.kind, &self.flee, c, &off, Mode::Flee) {
                    Some(d) => {
                        dx = DIR_UNIT[d][0] * vmax;
                        dy = DIR_UNIT[d][1] * vmax;
                    }
                    None => {
                        dx = 0.0;
                        dy = 0.0;
                    }
                }
            }
            let (vx, vy) = clamp_speed(keep * self.vx[i] + blend * dx, keep * self.vy[i] + blend * dy, vmax);
            self.vx[i] = vx;
            self.vy[i] = vy;
        }
        self.stats.dormant = if running { dormant } else { 0 };
    }

    fn update_zombies(&mut self) {
        let keep = self.cfg.velocity_keep;
        let blend = 1.0 - keep;
        let off = field::offsets(self.grid.w);
        let bite_r = self.cfg.bite_radius_m;
        let seek_r = self.cfg.zombie_seek_radius_m.max(bite_r);
        let speed = self.cfg.zombie_speed;
        let dps_tick = self.cfg.zombie_fence_dps * self.cfg.dt();
        for i in 0..self.n {
            if self.state[i] != ZOMBIE {
                continue;
            }
            self.step_mul[i] = 1;
            if self.bite_cd[i] > 0 {
                self.bite_cd[i] -= 1;
            }
            let (x, y) = (self.x[i], self.y[i]);
            let c = self.grid.cell_of(x, y);
            let mut target = self.nearest_of_state(x, y, seek_r, CIVILIAN, i);
            if let Some((j, d2)) = target {
                if self.bite_cd[i] == 0 && d2 <= bite_r * bite_r {
                    self.state[j] = INFECTED;
                    // +1: the Infected phase of this same tick decrements it once.
                    self.timer[j] = self.cfg.infection_delay_ticks + 1;
                    self.vx[j] = 0.0;
                    self.vy[j] = 0.0;
                    self.stats.civilians -= 1;
                    self.stats.infected += 1;
                    self.stats.bites += 1;
                    self.bite_cd[i] = self.cfg.bite_cooldown_ticks;
                    target = None;
                }
            }
            // Steer straight at a close civilian only when it is in this cell or
            // a reachable open neighbour; otherwise follow the chase field.
            let mut desired = None;
            if let Some((j, d2)) = target {
                let tc = self.grid.cell_of(self.x[j], self.y[j]);
                let reachable = tc == c
                    || (0..8).any(|d| (c as isize + off[d]) as usize == tc && self.grid.kind[tc] == WALK && field::step_allowed(&self.grid.kind, c, d, &off, Mode::Flee));
                if reachable && d2 > 0.0 {
                    let inv = speed / d2.sqrt();
                    desired = Some(((self.x[j] - x) * inv, (self.y[j] - y) * inv));
                }
            }
            let (dx, dy) = match desired {
                Some(v) => v,
                None => match field::downhill(&self.grid.kind, &self.chase, c, &off, Mode::Chase) {
                    Some(d) => {
                        let nc = (c as isize + off[d]) as usize;
                        if self.grid.kind[nc] == FENCE {
                            if self.fence_damage[nc] == 0.0 {
                                self.fence_touched.push(nc as u32);
                            }
                            self.fence_damage[nc] += dps_tick;
                            (0.0, 0.0)
                        } else {
                            (DIR_UNIT[d][0] * speed, DIR_UNIT[d][1] * speed)
                        }
                    }
                    None => (0.0, 0.0),
                },
            };
            let (vx, vy) = clamp_speed(keep * self.vx[i] + blend * dx, keep * self.vy[i] + blend * dy, speed);
            self.vx[i] = vx;
            self.vy[i] = vy;
        }
    }

    fn update_infected_and_dead(&mut self) {
        for i in 0..self.n {
            match self.state[i] {
                INFECTED => {
                    self.step_mul[i] = 1;
                    self.timer[i] = self.timer[i].saturating_sub(1);
                    if self.timer[i] == 0 {
                        self.make_zombie(i);
                    }
                }
                DEAD => {
                    self.step_mul[i] = 0;
                    self.timer[i] = self.timer[i].saturating_sub(1);
                }
                _ => {}
            }
        }
    }

    fn compute_separation(&mut self) {
        let r = self.cfg.separation_radius_m;
        let r2 = r * r;
        let max_hits = self.cfg.separation_max_neighbors;
        let max_scan = self.cfg.separation_max_scan;
        let bm = self.bucket_m;
        for i in 0..self.n {
            self.sep_x[i] = 0.0;
            self.sep_y[i] = 0.0;
            if self.step_mul[i] == 0 || self.state[i] == DEAD {
                continue;
            }
            let (x, y) = (self.x[i], self.y[i]);
            let bx0 = (((x - r) / bm).max(0.0)) as usize;
            let by0 = (((y - r) / bm).max(0.0)) as usize;
            let bx1 = (((x + r) / bm) as usize).min(self.hash_w - 1);
            let by1 = (((y + r) / bm) as usize).min(self.hash_h - 1);
            let (mut sx, mut sy) = (0.0f32, 0.0f32);
            let (mut hits, mut scanned) = (0u32, 0u32);
            'outer: for by in by0..=by1 {
                for bx in bx0..=bx1 {
                    let b = by * self.hash_w + bx;
                    for k in self.bucket_start[b] as usize..self.bucket_start[b + 1] as usize {
                        let j = self.agent_ids[k] as usize;
                        if j == i {
                            continue;
                        }
                        scanned += 1;
                        if scanned > max_scan {
                            break 'outer;
                        }
                        // Hash-time state: infected are pushed but don't push.
                        if self.hs[k] == INFECTED {
                            continue;
                        }
                        let (dx, dy) = (x - self.hx[k], y - self.hy[k]);
                        let d2 = dx * dx + dy * dy;
                        if d2 >= r2 {
                            continue;
                        }
                        if d2 > 1e-8 {
                            let d = d2.sqrt();
                            let push = 0.5 * (r - d) / d;
                            sx += dx * push;
                            sy += dy * push;
                        } else {
                            let u = DIR_UNIT[(i ^ j) & 7];
                            let s = if i < j { 0.5 * r } else { -0.5 * r };
                            sx += u[0] * s;
                            sy += u[1] * s;
                        }
                        hits += 1;
                        if hits >= max_hits {
                            break 'outer;
                        }
                    }
                }
            }
            // Never push more than one radius per tick.
            let (sx, sy) = clamp_speed(sx, sy, r);
            self.sep_x[i] = sx;
            self.sep_y[i] = sy;
        }
    }

    fn integrate(&mut self) {
        let dt = self.cfg.dt();
        for i in 0..self.n {
            let m = self.step_mul[i];
            if m == 0 {
                continue;
            }
            let (x, y) = (self.x[i], self.y[i]);
            let nx = x + self.vx[i] * dt * m as f32 + self.sep_x[i];
            let ny = y + self.vy[i] * dt * m as f32 + self.sep_y[i];
            if self.grid.walkable_at(nx, ny) {
                self.x[i] = nx;
                self.y[i] = ny;
            } else if self.grid.walkable_at(nx, y) {
                self.x[i] = nx;
                self.vy[i] = 0.0;
            } else if self.grid.walkable_at(x, ny) {
                self.y[i] = ny;
                self.vx[i] = 0.0;
            } else {
                self.vx[i] = 0.0;
                self.vy[i] = 0.0;
            }
        }
    }

    fn fire_towers(&mut self) {
        let range = self.cfg.tower_range_m;
        let period = self.cfg.tower_period_ticks();
        let dmg = self.cfg.tower_damage;
        let dead_ticks = (self.cfg.dead_visible_seconds * self.cfg.tick_hz as f32) as u16;
        for t in 0..self.towers.len() {
            if self.towers[t].cooldown > 0 {
                self.towers[t].cooldown -= 1;
                if self.towers[t].cooldown > 0 {
                    continue;
                }
            }
            let (tx, ty) = (self.towers[t].x, self.towers[t].y);
            if let Some((j, _)) = self.nearest_of_state(tx, ty, range, ZOMBIE, usize::MAX) {
                self.hp[j] = self.hp[j].saturating_sub(dmg);
                self.towers[t].shots += 1;
                self.towers[t].cooldown = period;
                if self.hp[j] == 0 {
                    self.state[j] = DEAD;
                    self.timer[j] = dead_ticks;
                    self.vx[j] = 0.0;
                    self.vy[j] = 0.0;
                    self.stats.zombies -= 1;
                    self.stats.dead += 1;
                    self.stats.zombies_killed += 1;
                    self.towers[t].kills += 1;
                }
            }
        }
    }

    fn apply_fence_damage(&mut self) {
        let mut broke = false;
        for k in 0..self.fence_touched.len() {
            let c = self.fence_touched[k] as usize;
            let dmg = self.fence_damage[c];
            self.fence_damage[c] = 0.0;
            if self.grid.kind[c] != FENCE {
                continue;
            }
            self.grid.fence_hp[c] -= dmg;
            if self.grid.fence_hp[c] <= 0.0 {
                self.grid.fence_hp[c] = 0.0;
                self.grid.kind[c] = WALK;
                self.stats.fence_cells_broken += 1;
                if self.stats.first_breach_tick.is_none() {
                    self.stats.first_breach_tick = Some(self.tick);
                }
                broke = true;
            }
        }
        self.fence_touched.clear();
        if broke {
            self.recompute_chase();
            self.recompute_threat_and_flee();
        }
    }

    // ------------------------------------------------------------- queries

    /// FNV-1a over every simulation array.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |bytes: &[u8]| {
            for &b in bytes {
                h ^= b as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        eat(&self.tick.to_le_bytes());
        for a in [&self.x, &self.y, &self.vx, &self.vy] {
            for v in a.iter() {
                eat(&v.to_bits().to_le_bytes());
            }
        }
        eat(&self.state);
        for v in &self.timer {
            eat(&v.to_le_bytes());
        }
        for v in &self.hp {
            eat(&v.to_le_bytes());
        }
        eat(&self.bite_cd);
        eat(&self.grid.kind);
        for v in &self.grid.fence_hp {
            eat(&v.to_bits().to_le_bytes());
        }
        for t in &self.towers {
            eat(&t.building.to_le_bytes());
            eat(&t.cooldown.to_le_bytes());
            eat(&t.shots.to_le_bytes());
        }
        h
    }

    pub fn is_building_cell(&self, i: usize) -> bool {
        self.grid.kind[i] == BUILDING
    }

    pub fn outcome(&self) -> Option<Outcome> {
        match self.phase {
            GamePhase::Ended(o) => Some(o),
            _ => None,
        }
    }

    pub fn survival(&self) -> f32 {
        if self.stats.initial_civilians == 0 {
            return 0.0;
        }
        self.stats.civilians as f32 / self.stats.initial_civilians as f32
    }

    /// Run to the end of the game (or `max_ticks`), returning the outcome.
    pub fn run_to_end(&mut self) -> Outcome {
        loop {
            self.step();
            if let Some(o) = self.outcome() {
                return o;
            }
        }
    }
}

#[inline]
fn clamp_speed(vx: f32, vy: f32, max: f32) -> (f32, f32) {
    let s2 = vx * vx + vy * vy;
    if s2 > max * max {
        let k = max / s2.sqrt();
        (vx * k, vy * k)
    } else {
        (vx, vy)
    }
}
