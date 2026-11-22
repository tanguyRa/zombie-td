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
/// A slot not in play yet (the match sizes agent arrays for every wave up
/// front). Never moves, pushes, bites or gets bitten. Render state 4.
pub const ABSENT: u8 = 4;

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

/// What a tower (or a unit) shoots with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Weapon {
    pub range_m: f32,
    /// Zombies closer than this are not targeted (mortars). 0: none.
    pub min_range_m: f32,
    pub damage: u16,
    /// Ticks between shots.
    pub period_ticks: u32,
    /// Every zombie within this radius of the target is hit too. 0: none.
    pub splash_m: f32,
}

/// A shooter: a garrisoned building, or a unit (`building == NO_BUILDING`)
/// such as a paratrooper or a convoy vehicle.
#[derive(Clone, Debug)]
pub struct Tower {
    pub building: u32,
    pub x: f32,
    pub y: f32,
    pub cooldown: u32,
    pub shots: u32,
    pub kills: u32,
    pub weapon: Weapon,
    /// Sim tick from which it acts (a paratrooper landing). 0: at once.
    pub active_from: u32,
    /// Waypoints still ahead, sim coordinates (a convoy). Empty: static.
    pub path: Vec<[f32; 2]>,
    /// Meters per tick along `path`.
    pub speed_m_tick: f32,
}

/// A timed area attack (airstrike, napalm): `pulses_left` pulses of
/// `damage` to every zombie within `radius_m`, the first at `next_tick`,
/// then every `interval_ticks`.
#[derive(Clone, Debug, PartialEq)]
pub struct AreaEffect {
    pub x: f32,
    pub y: f32,
    pub radius_m: f32,
    pub damage: u16,
    pub next_tick: u32,
    pub interval_ticks: u32,
    pub pulses_left: u32,
    pub kills: u32,
}

impl Tower {
    /// A static garrison in `building`, at (x, y), active at once.
    pub fn garrison(building: u32, x: f32, y: f32, weapon: Weapon) -> Tower {
        Tower { building, x, y, cooldown: 0, shots: 0, kills: 0, weapon, active_from: 0, path: Vec::new(), speed_m_tick: 0.0 }
    }
    /// A unit (no building) that starts acting at sim tick `active_from`.
    pub fn unit(x: f32, y: f32, weapon: Weapon, active_from: u32, path: Vec<[f32; 2]>, speed_m_tick: f32) -> Tower {
        Tower { building: NO_BUILDING, x, y, cooldown: 0, shots: 0, kills: 0, weapon, active_from, path, speed_m_tick }
    }
    pub fn is_unit(&self) -> bool {
        self.building == NO_BUILDING
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThreatJob {
    Idle,
    Threat,
    /// Building the flee seeds, `flee_scan` cells done so far.
    FleeScan,
    Flee,
    Done,
}

#[derive(Clone, Debug)]
pub enum Placement {
    Tower(u32),
    Fence { cells: Vec<u32>, length_m: f32 },
}

#[derive(Clone)]
pub struct Sim {
    pub cfg: Config,
    pub grid: Grid,
    pub seed: u64,
    pub(crate) rng: Pcg32,

    /// Slots in play: agents `0..n`. The arrays may be longer (a match sizes
    /// them for all waves); slots past `n` are `ABSENT`.
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
    pub(crate) step_mul: Vec<u8>,
    pub sep_x: Vec<f32>,
    pub sep_y: Vec<f32>,
    /// Positions `start` resets to (the spawn, or a match wave's prep start).
    pub(crate) spawn_x: Vec<f32>,
    pub(crate) spawn_y: Vec<f32>,

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
    /// Back buffers the field jobs write into (see `update_fields`).
    chase_next: Vec<i32>,
    threat_next: Vec<i32>,
    flee_next: Vec<i32>,
    chase_dial: Dial,
    /// Threat stops at the flee cap; cells beyond hold values >= the cap.
    threat_dial: Dial,
    flee_dial: Dial,
    chase_job: bool,
    threat_job: ThreatJob,
    /// Cells a field can reach (walkable or fence): bounds the job budgets.
    pub(crate) field_cells: usize,
    /// Cells finalized by the last job of each kind (sizes the budgets).
    chase_work: usize,
    threat_work: usize,
    /// Flee field start values (0 on walkable cells, INF elsewhere), cached
    /// for one `Grid::version`.
    flee_base: Vec<i32>,
    flee_base_version: Option<u32>,
    flee_counts: Vec<u32>,
    /// Zone cells found by the flee scan, in index order.
    flee_zone: Vec<u32>,
    flee_scan: usize,
    /// Compute every field in full, the pre-T1 way (reference for the
    /// equivalence tests; same results, slower).
    pub eager_fields: bool,
    pub field_recomputes: u32,

    // Fences.
    fence_damage: Vec<f32>,
    fence_touched: Vec<u32>,

    pub towers: Vec<Tower>,
    /// Area attacks in progress (match tactical cards).
    pub effects: Vec<AreaEffect>,
    pub placements: Vec<Placement>,
    pub fence_used_m: f32,
    /// Civilians spawned per building (index = building index).
    pub spawn_counts: Vec<u32>,
    /// Raw (unscaled) population weight per building.
    pub spawn_weights: Vec<f64>,

    pub tick: u32,
    pub phase: GamePhase,
    pub stats: Stats,

    // Rules a match changes per wave (the single-wave defaults are neutral).
    /// Civilian speed multiplier (fatigue), 1 outside a match.
    pub fatigue: f32,
    /// The game is lost when civilians drop below this (1: when none are left).
    pub loss_below: u32,
    /// End with `Timeout` after `max_game_seconds` (a match has no timeout).
    pub timeout: bool,
    /// Towers / fence meters allowed in total (placed ones included).
    pub tower_budget: u32,
    pub fence_budget_m: f32,
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

/// Split `population` over weights `raw` (total > 0): floors first, then one
/// more to the biggest fractional parts (ties by index).
fn largest_remainder(raw: &[f64], population: u32) -> Vec<u32> {
    let nb = raw.len();
    let total: f64 = raw.iter().sum();
    let mut counts = vec![0u32; nb];
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
    counts
}

impl Sim {
    pub fn new(level: &LevelPack, cfg: Config, population: u32, seed: u64) -> Sim {
        let grid = Grid::from_level(level, &cfg);
        let mut sim = Sim::with_capacity(grid, cfg, population as usize, seed);
        sim.n = population as usize;
        sim.spawn_population(population);
        sim.spawn_x = sim.x.clone();
        sim.spawn_y = sim.y.clone();
        sim.stats.civilians = population;
        sim.stats.initial_civilians = population;
        sim
    }

    /// A sim on `grid` with room for `capacity` agents and none in play (all
    /// slots `ABSENT`). The match adds civilians wave by wave.
    pub fn with_capacity(grid: Grid, cfg: Config, capacity: usize, seed: u64) -> Sim {
        let cells = grid.w * grid.h;
        let bucket_m = cfg.hash_bucket_m;
        let hash_w = ((grid.w as f32 * grid.cell) / bucket_m).ceil() as usize + 1;
        let hash_h = ((grid.h as f32 * grid.cell) / bucket_m).ceil() as usize + 1;
        let n = capacity;
        Sim {
            rng: Pcg32::new(seed, 0x7a6f_6d62),
            seed,
            n: 0,
            x: vec![0.0; n],
            y: vec![0.0; n],
            vx: vec![0.0; n],
            vy: vec![0.0; n],
            state: vec![ABSENT; n],
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
            chase_next: vec![INF; cells],
            threat_next: vec![INF; cells],
            flee_next: vec![INF; cells],
            chase_job: false,
            threat_job: ThreatJob::Idle,
            field_cells: cells,
            chase_work: cells,
            threat_work: 2 * cells,
            chase_dial: Dial::new(cfg.fence_path_cost),
            threat_dial: Dial::new(cfg.fence_path_cost),
            flee_dial: Dial::new(cfg.fence_path_cost),
            flee_base: Vec::new(),
            flee_base_version: None,
            flee_counts: Vec::new(),
            flee_zone: Vec::new(),
            flee_scan: 0,
            eager_fields: false,
            field_recomputes: 0,
            fence_damage: vec![0.0; cells],
            fence_touched: Vec::with_capacity(cells),
            towers: Vec::new(),
            effects: Vec::new(),
            placements: Vec::new(),
            fence_used_m: 0.0,
            spawn_counts: Vec::new(),
            spawn_weights: Vec::new(),
            tick: 0,
            phase: GamePhase::Setup,
            stats: Stats::default(),
            phase_ms: [0.0; 9],
            fatigue: 1.0,
            loss_below: 1,
            timeout: true,
            tower_budget: cfg.tower_budget,
            fence_budget_m: cfg.fence_budget_m,
            grid,
            cfg,
        }
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

    /// Spawn cells of building `b` (the radius grows in steps if it has none)
    /// and its raw population weight (0 without cells).
    pub(crate) fn building_spawn(&self, b: usize) -> (Vec<u32>, f64) {
        let mut r = self.cfg.spawn_radius_m;
        let mut c = self.spawn_candidates(b, r);
        while c.is_empty() && r < self.cfg.spawn_radius_m * 5.0 {
            r += self.cfg.spawn_radius_m;
            c = self.spawn_candidates(b, r);
        }
        let info = &self.grid.buildings[b];
        let w = if c.is_empty() { 0.0 } else { info.area_m2 as f64 * info.floors.max(1.0) as f64 * density(info.kind) };
        (c, w)
    }

    /// Put civilian slot `a` on a random cell of `list`, jittered inside it.
    fn place_civilian(&mut self, list: &[u32], a: usize, rng: &mut Pcg32) {
        let cell = self.grid.cell;
        let c = list[rng.below(list.len() as u32) as usize] as usize;
        let jx = 0.1 + 0.8 * rng.f32();
        let jy = 0.1 + 0.8 * rng.f32();
        self.x[a] = ((c % self.grid.w) as f32 + jx) * cell;
        self.y[a] = ((c / self.grid.w) as f32 + jy) * cell;
    }

    fn spawn_population(&mut self, population: u32) {
        let nb = self.grid.buildings.len();
        let mut candidates: Vec<Vec<u32>> = Vec::with_capacity(nb);
        let mut raw: Vec<f64> = Vec::with_capacity(nb);
        for b in 0..nb {
            let (c, w) = self.building_spawn(b);
            raw.push(w);
            candidates.push(c);
        }
        let total: f64 = raw.iter().sum();
        let counts = if total > 0.0 { largest_remainder(&raw, population) } else { vec![0u32; nb] };
        // Levels with no buildings (open_field): scatter over all walkable cells.
        let all_walk: Vec<u32> = if total > 0.0 {
            Vec::new()
        } else {
            (0..self.grid.kind.len()).filter(|&i| self.grid.kind[i] == WALK).map(|i| i as u32).collect()
        };
        let mut rng = self.rng.clone();
        let mut a = 0usize;
        for b in 0..nb {
            for _ in 0..counts[b] {
                self.place_civilian(&candidates[b], a, &mut rng);
                a += 1;
            }
        }
        if !all_walk.is_empty() {
            while a < self.n {
                self.place_civilian(&all_walk, a, &mut rng);
                a += 1;
            }
        }
        self.rng = rng;
        debug_assert_eq!(a, self.n);
        for i in 0..self.n {
            self.state[i] = CIVILIAN;
        }
        self.spawn_counts = counts;
        self.spawn_weights = raw;
    }

    /// Add the civilians of `buildings` (a match ring): `round(sum of raw
    /// weights × multiplier)`, capped by the free slots, split by largest
    /// remainder and placed in building order from `rng`. Returns how many.
    pub(crate) fn spawn_newcomers(&mut self, buildings: &[usize], multiplier: f64, rng: &mut Pcg32) -> u32 {
        let nb = self.grid.buildings.len();
        self.spawn_counts.resize(nb, 0);
        self.spawn_weights.resize(nb, 0.0);
        let mut candidates = Vec::with_capacity(buildings.len());
        let mut raw = Vec::with_capacity(buildings.len());
        for &b in buildings {
            let (c, w) = self.building_spawn(b);
            self.spawn_weights[b] = w;
            raw.push(w);
            candidates.push(c);
        }
        let total: f64 = raw.iter().sum();
        if total <= 0.0 {
            return 0;
        }
        let free = (self.x.len() - self.n) as f64;
        let want = (total * multiplier).round().clamp(0.0, free) as u32;
        let counts = largest_remainder(&raw, want);
        for (k, &b) in buildings.iter().enumerate() {
            for _ in 0..counts[k] {
                let a = self.n;
                self.place_civilian(&candidates[k], a, rng);
                self.state[a] = CIVILIAN;
                self.n += 1;
            }
            self.spawn_counts[b] += counts[k];
        }
        self.stats.civilians += want;
        want
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
        self.tower_budget.saturating_sub(self.towers.len() as u32)
    }
    pub fn fence_left_m(&self) -> f32 {
        (self.fence_budget_m - self.fence_used_m).max(0.0)
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
        self.towers.push(Tower::garrison(building, x, y, self.cfg.tower_weapon()));
        self.placements.push(Placement::Tower(building));
        Ok(())
    }

    /// The placed length (meters) and open cells of a fence polyline (sim
    /// coordinates), without placing it. Cells on buildings or the map edge
    /// are clipped away: a fence drawn from wall to wall seals the street,
    /// and only the share of the line actually placed counts.
    pub fn fence_preview(&self, pts: &[[f32; 2]]) -> Result<(f32, Vec<usize>), String> {
        if pts.len() < 2 {
            return Err("a fence needs at least two points".into());
        }
        if pts.iter().any(|p| !p[0].is_finite() || !p[1].is_finite()) {
            return Err("fence points must be finite".into());
        }
        let length: f32 = pts
            .windows(2)
            .map(|s| {
                let (dx, dy) = (s[1][0] - s[0][0], s[1][1] - s[0][1]);
                (dx * dx + dy * dy).sqrt()
            })
            .sum();
        let cells = self.grid.rasterize_polyline(pts);
        let open: Vec<usize> = cells.iter().copied().filter(|&c| self.grid.kind[c] == WALK || self.grid.kind[c] == FENCE).collect();
        if open.is_empty() {
            return Err("fences cannot be placed on buildings or the map edge".into());
        }
        let length = (length * open.len() as f32 / cells.len() as f32).max(self.grid.cell);
        Ok((length, open))
    }

    /// Turn the walkable cells among `cells` into fence cells with `hp` each
    /// (cells that already are fences are left alone). Returns the new cells.
    pub(crate) fn build_fence_cells(&mut self, cells: &[usize], hp: f32) -> Vec<u32> {
        let mut new_cells = Vec::new();
        for &c in cells {
            if self.grid.kind[c] == WALK {
                self.grid.set_kind(c, FENCE);
                self.grid.fence_hp[c] = hp;
                new_cells.push(c as u32);
            }
        }
        self.push_agents_off_blocked_cells();
        new_cells
    }

    /// Place a fence polyline (sim coordinates). Returns its length in meters.
    pub fn place_fence(&mut self, pts: &[[f32; 2]]) -> Result<f32, String> {
        if self.phase != GamePhase::Setup {
            return Err("fences can only be placed during setup".into());
        }
        let (length, open) = self.fence_preview(pts)?;
        if length > self.fence_left_m() + 1e-3 {
            return Err(format!("fence is {:.0} m, only {:.0} m left", length, self.fence_left_m()));
        }
        let new_cells = self.build_fence_cells(&open, self.cfg.fence_cell_hp);
        self.fence_used_m += length;
        self.placements.push(Placement::Fence { cells: new_cells, length_m: length });
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
                    self.grid.set_kind(c as usize, WALK);
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

    pub(crate) fn nearest_walkable(&self, c: usize) -> Option<usize> {
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

    pub(crate) fn push_agents_off_blocked_cells(&mut self) {
        for i in 0..self.n {
            if self.state[i] == DEAD || self.state[i] == ABSENT {
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
        self.grid.rebuild_step_masks();
        self.field_cells = self.grid.kind.iter().filter(|&&k| k == WALK || k == FENCE).count();
        self.tick = 0;
        self.seed_outbreak();
        self.phase = GamePhase::Running;
        self.recompute_chase();
        self.recompute_threat_and_flee();
    }

    fn seed_outbreak(&mut self) {
        let n = self.n;
        if n == 0 {
            return;
        }
        let all: Vec<u32> = (0..n as u32).collect();
        let mut rng = self.rng.clone();
        let mut seeds = Vec::new();
        self.pick_outbreak_seeds(&all, self.cfg.outbreak_clusters as usize, &mut rng, &mut seeds);
        self.rng = rng;
        self.infect_clusters(&seeds, self.cfg.outbreak_radius_m, self.cfg.outbreak_min_per_cluster as usize);
    }

    /// Add up to `count` cluster seeds drawn uniformly from `candidates`
    /// (agent indices), each at least `outbreak_min_separation_m` from every
    /// seed already in `seeds`. After 5,000 failed tries any distinct
    /// candidate is accepted, so small maps still start.
    pub(crate) fn pick_outbreak_seeds(&self, candidates: &[u32], count: usize, rng: &mut Pcg32, seeds: &mut Vec<usize>) {
        if candidates.is_empty() {
            return;
        }
        let min_sep2 = self.cfg.outbreak_min_separation_m * self.cfg.outbreak_min_separation_m;
        let target = seeds.len() + count;
        let mut tries = 0;
        while seeds.len() < target && tries < 10_000 {
            tries += 1;
            let c = candidates[rng.below(candidates.len() as u32) as usize] as usize;
            let ok = seeds.iter().all(|&s| {
                let (dx, dy) = (self.x[s] - self.x[c], self.y[s] - self.y[c]);
                dx * dx + dy * dy >= min_sep2
            });
            if ok || (tries > 5_000 && !seeds.contains(&c)) {
                seeds.push(c);
            }
        }
    }

    /// Around each seed, every civilian within `radius` becomes a zombie (the
    /// `min_per` nearest if fewer).
    pub(crate) fn infect_clusters(&mut self, seeds: &[usize], radius: f32, min_per: usize) {
        let n = self.n;
        let r2 = radius * radius;
        for &s in seeds {
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

    /// Kill a zombie or infected agent outright (tests and tools).
    pub fn force_kill(&mut self, i: usize) {
        match self.state[i] {
            ZOMBIE => self.stats.zombies -= 1,
            INFECTED => self.stats.infected -= 1,
            _ => return,
        }
        self.state[i] = DEAD;
        self.timer[i] = 0;
        self.vx[i] = 0.0;
        self.vy[i] = 0.0;
        self.stats.dead += 1;
    }

    /// Convert local level coordinates (meters from the level centre) to sim coordinates.
    pub fn to_sim(&self, x: f32, y: f32) -> [f32; 2] {
        [x - self.grid.origin[0], y - self.grid.origin[1]]
    }

    /// Start without an outbreak (tests place zombies themselves).
    pub fn start_without_outbreak(&mut self) {
        self.grid.rebuild_step_masks();
        self.field_cells = self.grid.kind.iter().filter(|&&k| k == WALK || k == FENCE).count();
        self.phase = GamePhase::Running;
        self.tick = 0;
        self.recompute_chase();
        self.recompute_threat_and_flee();
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
            } else if s.civilians < self.loss_below {
                self.phase = GamePhase::Ended(Outcome::Loss);
            } else if self.timeout && self.tick + 1 >= self.cfg.max_ticks() {
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
            if self.state[i] == DEAD || self.state[i] == ABSENT {
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
        self.nearest_of_state_beyond(x, y, r, 0.0, state, skip)
    }

    /// Like `nearest_of_state`, ignoring agents closer than `min_r`. With
    /// `min_r == 0` the result is the same (`d2 >= 0` always holds).
    fn nearest_of_state_beyond(&self, x: f32, y: f32, r: f32, min_r: f32, state: u8, skip: usize) -> Option<(usize, f32)> {
        let min2 = min_r * min_r;
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
                    if d2 <= r2 && d2 >= min2 && best.map_or(true, |(bj, bd)| d2 < bd || (d2 == bd && j < bj)) {
                        best = Some((j, d2));
                    }
                }
            }
        }
        best
    }

    // ------------------------------------------------------------- fields
    //
    // Each field is a job: its seeds are a snapshot of the agents at the
    // job's start tick, the Dijkstra runs a budget of cells per tick, and the
    // result is published (swapped into the front buffer the agents read)
    // one interval later. Chase starts on tick % interval == 0, threat + flee
    // on tick % interval == interval / 2. A job's result depends only on its
    // snapshot and the grid, never on the budget, so the budget is free to
    // adapt. A fence break restarts the jobs in flight on the new grid (same
    // snapshot). See DECISIONS.md, "Scale".

    fn update_fields(&mut self) {
        let iv = self.cfg.field_interval_ticks.max(1);
        let phase = self.tick % iv;
        if phase == 0 {
            self.publish_chase();
            self.start_chase_job();
        }
        if phase == iv / 2 {
            self.publish_threat();
            self.start_threat_job();
        }
        // Budgets: the last job's work + 50%, never more than an upper bound
        // (a chase job finalizes each passable cell at most once, threat +
        // flee at most twice, plus the flee seed scan), spread over the
        // interval. Whatever is left at
        // the publish tick is finished there. Budgets never change results.
        let slots = iv as usize;
        let est = |last: usize, bound: usize| (last + last / 2).min(bound).div_ceil(slots).max(1024);
        let chase_budget = est(self.chase_work, self.field_cells);
        let threat_budget = est(self.threat_work, 2 * self.field_cells + self.grid.kind.len() / 2);
        self.advance_chase_job(chase_budget);
        self.advance_threat_job(threat_budget);
    }

    fn threat_cap(&self) -> i32 {
        (self.cfg.flee_threat_cap_m * self.cfg.cost_per_m()) as i32
    }

    /// Recompute the chase field from the current state and publish it now.
    pub fn recompute_chase(&mut self) {
        self.start_chase_job();
        self.publish_chase();
        self.field_recomputes += 1;
    }

    /// Recompute threat and flee from the current state and publish them now.
    pub fn recompute_threat_and_flee(&mut self) {
        self.start_threat_job();
        self.publish_threat();
        self.field_recomputes += 1;
    }

    fn start_chase_job(&mut self) {
        let (grid, x, y, state) = (&self.grid, &self.x, &self.y, &self.state);
        let d = &mut self.chase_dial;
        d.seeds.clear();
        d.seeds.extend((0..self.n).filter(|&i| state[i] == CIVILIAN).map(|i| (grid.cell_of(x[i], y[i]) as u32, 0)));
        self.restart_chase_job();
    }

    /// (Re)start the chase job from its snapshot on the current grid.
    fn restart_chase_job(&mut self) {
        self.chase_next.fill(INF);
        self.chase_dial.begin(Mode::Chase, self.cfg.fence_path_cost, false);
        self.chase_job = true;
        if self.eager_fields {
            self.advance_chase_job(usize::MAX);
        }
    }

    fn advance_chase_job(&mut self, budget: usize) {
        if self.chase_job && !self.chase_dial.finished() {
            self.chase_dial.advance_budget(&self.grid, &mut self.chase_next, i32::MAX, budget);
        }
    }

    fn publish_chase(&mut self) {
        if !self.chase_job {
            return;
        }
        self.advance_chase_job(usize::MAX);
        std::mem::swap(&mut self.chase, &mut self.chase_next);
        self.chase_work = self.chase_dial.pops;
        self.chase_job = false;
    }

    fn start_threat_job(&mut self) {
        let (grid, x, y, state) = (&self.grid, &self.x, &self.y, &self.state);
        let d = &mut self.threat_dial;
        d.seeds.clear();
        d.seeds.extend((0..self.n).filter(|&i| state[i] == ZOMBIE).map(|i| (grid.cell_of(x[i], y[i]) as u32, 0)));
        self.restart_threat_job();
    }

    fn restart_threat_job(&mut self) {
        self.threat_next.fill(INF);
        // The reference flee seeding reads the finalization order.
        let order = self.eager_fields || self.cfg.flee_multiplier < 0.0;
        self.threat_dial.begin(Mode::Chase, self.cfg.fence_path_cost, order);
        self.threat_job = ThreatJob::Threat;
        if self.eager_fields {
            self.advance_threat_job(usize::MAX);
        }
    }

    fn advance_threat_job(&mut self, budget: usize) {
        let before = self.threat_dial.pops;
        if self.threat_job == ThreatJob::Threat {
            // Only values below the cap are ever read exactly (dormancy
            // compares with the wake radius, flee caps the threat): stop there.
            let limit = if self.eager_fields { i32::MAX } else { self.threat_cap() - 1 };
            self.threat_dial.advance_budget(&self.grid, &mut self.threat_next, limit, budget);
            if self.threat_dial.settled < limit {
                return;
            }
            self.setup_flee();
        }
        // Work spent in this call, in finalized-cell units; a scanned (or
        // placed) flee seed cell costs about a quarter of one.
        let mut spent = self.threat_dial.pops - before;
        if self.threat_job == ThreatJob::FleeScan {
            let cells = budget.saturating_sub(spent).max(1).saturating_mul(4);
            let (scanned, done) = self.scan_flee_zone(cells);
            spent += scanned / 4;
            if !done {
                return;
            }
            spent += self.flee_zone.len() / 4;
        }
        if self.threat_job == ThreatJob::Flee {
            if spent >= budget {
                return;
            }
            let left = budget - spent;
            self.flee_dial.advance_budget(&self.grid, &mut self.flee_next, i32::MAX, left);
            if self.flee_dial.finished() {
                self.threat_job = ThreatJob::Done;
            }
        }
    }

    fn publish_threat(&mut self) {
        if self.threat_job == ThreatJob::Idle {
            return;
        }
        self.advance_threat_job(usize::MAX);
        std::mem::swap(&mut self.threat, &mut self.threat_next);
        std::mem::swap(&mut self.flee, &mut self.flee_next);
        // Same units as `advance_threat_job` (a scanned cell is a quarter).
        let scan = if self.eager_fields { 0 } else { (self.grid.kind.len() + self.flee_zone.len()) / 4 };
        self.threat_work = self.threat_dial.pops + self.flee_dial.pops + scan;
        self.threat_job = ThreatJob::Idle;
    }

    /// Flee field (Brogue): -k × threat, then one more Dijkstra pass over it.
    /// Prepares the flee job from the finished threat job (`threat_next`).
    fn setup_flee(&mut self) {
        let cap = self.threat_cap();
        let k = self.cfg.flee_multiplier;
        let off = (cap as f32 * k) as i32;
        if self.eager_fields || k < 0.0 {
            // Reference version: seeds sorted by value come for free (capped
            // cells first, then the threat's finalization order reversed).
            let fd = &mut self.flee_dial;
            fd.seeds.clear();
            for c in 0..self.grid.kind.len() {
                if self.grid.kind[c] == WALK && self.threat_next[c] >= cap {
                    fd.seeds.push((c as u32, 0));
                }
            }
            for &c in self.threat_dial.order.iter().rev() {
                let c = c as usize;
                let th = self.threat_next[c];
                if self.grid.kind[c] == WALK && th < cap {
                    fd.seeds.push((c as u32, off - (th as f32 * k) as i32));
                }
            }
            self.flee_next.fill(INF);
            fd.begin(Mode::Flee, 0, false);
            self.threat_job = ThreatJob::Flee;
        } else {
            self.start_flee_zone_scan(off);
        }
    }

    /// The same flee field, computed only inside the threat zone (cells with
    /// threat < cap). Capped cells are seeds at 0, so they end at exactly 0
    /// and only matter through their zone neighbours: each zone cell next to
    /// one is seeded with min(its own seed, that step's cost). Seeds are >= 0
    /// because k >= 0, which is what makes capped cells final at 0.
    /// Seeds are counting-sorted by value over cells in index order
    /// (sequential memory); the order among equal values doesn't change any
    /// distance.
    fn start_flee_zone_scan(&mut self, off: i32) {
        if self.flee_base_version != Some(self.grid.version) {
            let g = &self.grid;
            self.flee_base.clear();
            self.flee_base.extend(g.kind.iter().map(|&kd| if kd == WALK { 0 } else { INF }));
            self.flee_base_version = Some(g.version);
        }
        // Capped walkable cells end at 0; zone cells start at their seed.
        self.flee_next.copy_from_slice(&self.flee_base);
        self.flee_counts.clear();
        self.flee_counts.resize(off.max(0) as usize + 2, 0);
        self.flee_zone.clear();
        self.flee_scan = 0;
        self.threat_job = ThreatJob::FleeScan;
    }

    /// Scan up to `cells` more cells for the flee seeds. Returns the cells
    /// scanned and whether the scan is complete (the flee Dijkstra has then
    /// begun).
    fn scan_flee_zone(&mut self, cells: usize) -> (usize, bool) {
        let cap = self.threat_cap();
        let k = self.cfg.flee_multiplier;
        let off = (cap as f32 * k) as i32;
        let g = &self.grid;
        let threat = &self.threat_next;
        let flee = &mut self.flee_next;
        let offs = field::offsets(g.w);
        let counts = &mut self.flee_counts;
        let start = self.flee_scan;
        let end = start.saturating_add(cells).min(g.kind.len());
        for c in self.flee_scan..end {
            let th = threat[c];
            if th >= cap || g.kind[c] != WALK {
                continue;
            }
            let seed = off - (th as f32 * k) as i32;
            let mut best = seed;
            let mut m = g.step_flee[c];
            while m != 0 {
                let d = m.trailing_zeros() as usize;
                m &= m - 1;
                if threat[(c as isize + offs[d]) as usize] >= cap {
                    best = best.min(if d < 4 { field::STRAIGHT } else { field::DIAGONAL });
                    if d < 4 {
                        break;
                    }
                }
            }
            flee[c] = best;
            counts[best as usize + 1] += 1;
            self.flee_zone.push(c as u32);
        }
        self.flee_scan = end;
        if end < g.kind.len() {
            return (end - start, false);
        }
        for v in 1..counts.len() {
            counts[v] += counts[v - 1];
        }
        let fd = &mut self.flee_dial;
        fd.seeds.clear();
        fd.seeds.resize(self.flee_zone.len(), (0, 0));
        for &c in &self.flee_zone {
            let v = flee[c as usize];
            let slot = &mut counts[v as usize];
            fd.seeds[*slot as usize] = (c, v);
            *slot += 1;
        }
        fd.begin_preset(Mode::Flee, 0);
        self.threat_job = ThreatJob::Flee;
        (end - start, true)
    }

    /// The grid changed (a fence broke): restart the jobs in flight so the
    /// next published fields see the new grid.
    fn restart_field_jobs(&mut self) {
        if self.chase_job {
            self.restart_chase_job();
        }
        if self.threat_job != ThreatJob::Idle {
            self.restart_threat_job();
        }
    }

    fn update_civilians(&mut self, running: bool) {
        let cfg = &self.cfg;
        let wake = if running { (cfg.wake_radius_m * cfg.cost_per_m()) as i32 } else { -1 };
        let period = cfg.dormant_period_ticks.max(1);
        let slot = self.tick % period;
        let keep = cfg.velocity_keep;
        let blend = 1.0 - keep;
        let off = field::offsets(self.grid.w);
        // Fatigue slows civilians only (1 outside a match: same floats).
        let wander_v = cfg.civilian_wander_speed * self.fatigue;
        let flee_v = cfg.civilian_flee_speed * self.fatigue;
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
                vmax = wander_v;
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
                vmax = flee_v;
                match field::downhill_masked(self.grid.step_flee[c], &self.flee, c, &off) {
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
                    || (0..8).any(|d| (c as isize + off[d]) as usize == tc && self.grid.kind[tc] == WALK && (self.grid.step_flee[c] >> d) & 1 != 0);
                if reachable && d2 > 0.0 {
                    let inv = speed / d2.sqrt();
                    desired = Some(((self.x[j] - x) * inv, (self.y[j] - y) * inv));
                }
            }
            let (dx, dy) = match desired {
                Some(v) => v,
                None => match field::downhill_masked(self.grid.step_chase[c], &self.chase, c, &off) {
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
        self.sep_x[..self.n].fill(0.0);
        self.sep_y[..self.n].fill(0.0);
        // Visit agents in spatial-hash order so neighbouring agents (and their
        // buckets) are processed together: same per-agent result, far fewer
        // cache misses than index order. Only the live part of `agent_ids`
        // (dead agents aren't hashed; slots past it are stale).
        let live = self.bucket_start[self.hash_w * self.hash_h] as usize;
        for k0 in 0..live {
            let i = self.agent_ids[k0] as usize;
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

    /// Every zombie (hash-time position) within `r` of (x, y), in bucket order.
    fn zombies_within(&self, x: f32, y: f32, r: f32, out: &mut Vec<usize>) {
        out.clear();
        let bm = self.bucket_m;
        let bx0 = (((x - r) / bm).max(0.0)) as usize;
        let by0 = (((y - r) / bm).max(0.0)) as usize;
        let bx1 = (((x + r) / bm).max(0.0) as usize).min(self.hash_w - 1);
        let by1 = (((y + r) / bm).max(0.0) as usize).min(self.hash_h - 1);
        let r2 = r * r;
        for by in by0..=by1 {
            for bx in bx0..=bx1 {
                let b = by * self.hash_w + bx;
                for k in self.bucket_civ_end[b]..self.bucket_start[b + 1] {
                    let k = k as usize;
                    let j = self.agent_ids[k] as usize;
                    if self.state[j] != ZOMBIE {
                        continue;
                    }
                    let (dx, dy) = (self.hx[k] - x, self.hy[k] - y);
                    if dx * dx + dy * dy <= r2 {
                        out.push(j);
                    }
                }
            }
        }
    }

    /// Damage zombie `j`; returns whether it died.
    fn hit_zombie(&mut self, j: usize, dmg: u16, dead_ticks: u16) -> bool {
        self.hp[j] = self.hp[j].saturating_sub(dmg);
        if self.hp[j] == 0 {
            self.state[j] = DEAD;
            self.timer[j] = dead_ticks;
            self.vx[j] = 0.0;
            self.vy[j] = 0.0;
            self.stats.zombies -= 1;
            self.stats.dead += 1;
            self.stats.zombies_killed += 1;
            true
        } else {
            false
        }
    }

    fn fire_towers(&mut self) {
        let dead_ticks = (self.cfg.kill_flash_seconds * self.cfg.tick_hz as f32) as u16;
        let mut hits = Vec::new();
        for t in 0..self.towers.len() {
            if self.tick < self.towers[t].active_from {
                continue;
            }
            if !self.towers[t].path.is_empty() {
                let tw = &mut self.towers[t];
                let [px, py] = tw.path[0];
                let (dx, dy) = (px - tw.x, py - tw.y);
                let d = (dx * dx + dy * dy).sqrt();
                if d <= tw.speed_m_tick {
                    tw.x = px;
                    tw.y = py;
                    tw.path.remove(0);
                } else {
                    let k = tw.speed_m_tick / d;
                    tw.x += dx * k;
                    tw.y += dy * k;
                }
            }
            if self.towers[t].cooldown > 0 {
                self.towers[t].cooldown -= 1;
                if self.towers[t].cooldown > 0 {
                    continue;
                }
            }
            let (tx, ty) = (self.towers[t].x, self.towers[t].y);
            let w = self.towers[t].weapon;
            if let Some((j, _)) = self.nearest_of_state_beyond(tx, ty, w.range_m, w.min_range_m, ZOMBIE, usize::MAX) {
                self.towers[t].shots += 1;
                self.towers[t].cooldown = w.period_ticks;
                if w.splash_m > 0.0 {
                    self.zombies_within(self.x[j], self.y[j], w.splash_m, &mut hits);
                    if !hits.contains(&j) {
                        hits.push(j);
                    }
                    for k in 0..hits.len() {
                        if self.hit_zombie(hits[k], w.damage, dead_ticks) {
                            self.towers[t].kills += 1;
                        }
                    }
                } else if self.hit_zombie(j, w.damage, dead_ticks) {
                    self.towers[t].kills += 1;
                }
            }
        }
        for e in 0..self.effects.len() {
            let ef = &self.effects[e];
            if ef.pulses_left == 0 || self.tick < ef.next_tick {
                continue;
            }
            let (x, y, r, dmg) = (ef.x, ef.y, ef.radius_m, ef.damage);
            self.zombies_within(x, y, r, &mut hits);
            for k in 0..hits.len() {
                if self.hit_zombie(hits[k], dmg, dead_ticks) {
                    self.effects[e].kills += 1;
                }
            }
            let ef = &mut self.effects[e];
            ef.pulses_left -= 1;
            ef.next_tick += ef.interval_ticks.max(1);
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
                self.grid.set_kind(c, WALK);
                self.stats.fence_cells_broken += 1;
                if self.stats.first_breach_tick.is_none() {
                    self.stats.first_breach_tick = Some(self.tick);
                }
                broke = true;
            }
        }
        self.fence_touched.clear();
        if broke {
            self.restart_field_jobs();
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

    /// Approximate heap bytes held by the sim (agent arrays, hash, fields,
    /// grid). Benchmarks report it; it excludes allocator overhead.
    pub fn memory_bytes(&self) -> usize {
        fn b<T>(v: &Vec<T>) -> usize {
            v.capacity() * std::mem::size_of::<T>()
        }
        let agents = b(&self.x) + b(&self.y) + b(&self.vx) + b(&self.vy) + b(&self.state) + b(&self.timer) + b(&self.hp) + b(&self.bite_cd) + b(&self.step_mul);
        let agents = agents + b(&self.sep_x) + b(&self.sep_y) + b(&self.spawn_x) + b(&self.spawn_y);
        let hash = b(&self.bucket_start) + b(&self.bucket_civ_end) + b(&self.bucket_fill) + b(&self.agent_ids) + b(&self.agent_bucket) + b(&self.hx) + b(&self.hy) + b(&self.hs);
        let fields = b(&self.chase) + b(&self.threat) + b(&self.flee) + b(&self.chase_next) + b(&self.threat_next) + b(&self.flee_next) + self.chase_dial.memory_bytes() + self.threat_dial.memory_bytes() + self.flee_dial.memory_bytes();
        let fields = fields + b(&self.flee_base) + b(&self.flee_counts) + b(&self.flee_zone);
        let fences = b(&self.fence_damage) + b(&self.fence_touched);
        let g = &self.grid;
        let grid = b(&g.kind) + b(&g.building) + b(&g.fence_hp) + b(&g.step_chase) + b(&g.step_flee) + g.buildings.iter().map(|bi| b(&bi.polygon) + std::mem::size_of_val(bi)).sum::<usize>();
        agents + hash + fields + fences + grid
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

    // ------------------------------------------------------------ snapshots

    /// Move the scratch buffers out (fields, field jobs, spatial hash,
    /// separation, fence damage). None of them carries state between ticks
    /// that a fresh field computation doesn't overwrite.
    fn take_scratch(&mut self) -> Scratch {
        use std::mem::take;
        let empty = || Dial::new(0);
        Scratch {
            fields: [take(&mut self.chase), take(&mut self.threat), take(&mut self.flee), take(&mut self.chase_next), take(&mut self.threat_next), take(&mut self.flee_next), take(&mut self.flee_base)],
            dials: [std::mem::replace(&mut self.chase_dial, empty()), std::mem::replace(&mut self.threat_dial, empty()), std::mem::replace(&mut self.flee_dial, empty())],
            u32s: [take(&mut self.flee_counts), take(&mut self.flee_zone), take(&mut self.bucket_start), take(&mut self.bucket_civ_end), take(&mut self.bucket_fill), take(&mut self.agent_ids), take(&mut self.agent_bucket), take(&mut self.fence_touched)],
            f32s: [take(&mut self.hx), take(&mut self.hy), take(&mut self.sep_x), take(&mut self.sep_y), take(&mut self.fence_damage)],
            hs: take(&mut self.hs),
        }
    }

    fn put_scratch(&mut self, s: Scratch) {
        let Scratch { fields, dials, u32s, f32s, hs } = s;
        [self.chase, self.threat, self.flee, self.chase_next, self.threat_next, self.flee_next, self.flee_base] = fields;
        [self.chase_dial, self.threat_dial, self.flee_dial] = dials;
        [self.flee_counts, self.flee_zone, self.bucket_start, self.bucket_civ_end, self.bucket_fill, self.agent_ids, self.agent_bucket, self.fence_touched] = u32s;
        [self.hx, self.hy, self.sep_x, self.sep_y, self.fence_damage] = f32s;
        self.hs = hs;
    }

    /// A copy of the persistent state without the scratch buffers (about a
    /// sixth of the memory at wave-8 size). Only valid between ticks while
    /// no field job is needed until the next full recompute (a match prep:
    /// `start` recomputes every field). Restore it with `restore_from`.
    pub(crate) fn snapshot(&mut self) -> Sim {
        let scratch = self.take_scratch();
        let copy = self.clone();
        self.put_scratch(scratch);
        copy
    }

    /// Become `snap` (from `snapshot`), keeping this sim's scratch buffers.
    pub(crate) fn restore_from(&mut self, snap: &Sim) {
        let scratch = self.take_scratch();
        *self = snap.clone();
        self.put_scratch(scratch);
        self.flee_base_version = None;
        self.chase_job = false;
        self.threat_job = ThreatJob::Idle;
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

/// Buffers moved aside by `Sim::snapshot` / `restore_from`.
struct Scratch {
    fields: [Vec<i32>; 7],
    dials: [Dial; 3],
    u32s: [Vec<u32>; 8],
    f32s: [Vec<f32>; 5],
    hs: Vec<u8>,
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
