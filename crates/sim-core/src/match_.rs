//! The 8-wave match: rings that grow every wave, newcomers, outbreaks per
//! wave, fatigue, persistence, retries. Owns a `Sim` and drives it wave by
//! wave. Every change goes through `Match::apply(Action)`; time goes through
//! `Match::step()`. See DECISIONS.md, "Match".

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::grid::{Grid, BUILDING, FENCE, WALK, WALL};
use crate::level::{Building, LevelPack};
use crate::rng::Pcg32;
use crate::sim::{Clock, GamePhase, NoClock, Outcome, Sim, CIVILIAN, DEAD};

/// Waves in a match.
pub const WAVES: u8 = 8;

/// RNG streams. Each system draws from `Pcg32::new(match seed, stream(system,
/// wave))`, so a system never shifts another one and a retry replays the
/// same draws. Ids are fixed forever (changing one changes every run).
pub mod streams {
    /// Newcomer placement when a ring is revealed.
    pub const SPAWN: u64 = 1;
    /// Outbreak cluster seeds.
    pub const OUTBREAK: u64 = 2;
    /// Civilian random walk while the wave runs.
    pub const WANDER: u64 = 3;
    /// Cosmetic random walk during prep (reset at Start, never affects play).
    pub const PREP_WANDER: u64 = 4;
    /// Deck shuffle, draws and reshuffles (T3).
    pub const DECK: u64 = 5;
    /// Card effects, e.g. a paratrooper's landing spot (T3).
    pub const CARD_EFFECTS: u64 = 6;

    const TAG: u64 = 0x6d61_7463; // "matc"

    /// The PCG32 stream id of `system` in `wave` (1-based; 0 for match-wide).
    pub const fn stream(system: u64, wave: u8) -> u64 {
        (TAG << 24) | (system << 8) | wave as u64
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Placements allowed; agents wander cosmetically.
    Prep,
    /// The outbreak plays out.
    Running,
    /// No zombies or infected left (waves 1-7).
    WaveWon,
    /// Civilians fell below the defeat line: retry or restart.
    WaveLost,
    /// Wave 8 won.
    MatchWon,
}

/// Everything a player (or a replay) can do to a match. Serialised as
/// `{"type": "place_tower", "building": 3}` etc.; it is the input log.
/// Coordinates are sim coordinates (meters from the grid origin).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// Temporary tool until cards (T3): garrison a revealed building.
    PlaceTower { building: u32 },
    /// Temporary tool until cards (T3): a fence polyline.
    PlaceFence { points: Vec<[f32; 2]> },
    /// Undo the last placement of this prep.
    Undo,
    /// Prep -> Running.
    StartWave,
    /// WaveWon -> next wave's Prep (reveals the next ring).
    NextWave,
    /// Back to the start of the current wave's prep (same outbreak, same draws).
    RetryWave,
    /// Back to wave 1's prep, rebuilt from the initial inputs.
    RestartMatch,
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Action::PlaceTower { .. } => "place_tower",
            Action::PlaceFence { .. } => "place_fence",
            Action::Undo => "undo",
            Action::StartWave => "start_wave",
            Action::NextWave => "next_wave",
            Action::RetryWave => "retry_wave",
            Action::RestartMatch => "restart_match",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum ActionError {
    /// The action is not allowed in this phase.
    WrongPhase { action: String, phase: Phase },
    /// The next wave's ring has not been fully loaded (`add_buildings`).
    RingNotLoaded { wave: u8 },
    /// The building does not exist or is outside the revealed area.
    NotRevealed { building: u32 },
    /// Nothing placed during this prep.
    NothingToUndo,
    /// The placement itself was refused (budget, geometry...).
    Placement { reason: String },
}

impl std::fmt::Display for ActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ActionError::WrongPhase { action, phase } => write!(f, "{action} is not allowed during {phase:?}"),
            ActionError::RingNotLoaded { wave } => write!(f, "the district of wave {wave} is still loading"),
            ActionError::NotRevealed { building } => write!(f, "building {building} is not in the revealed area"),
            ActionError::NothingToUndo => write!(f, "nothing to undo in this prep"),
            ActionError::Placement { reason } => write!(f, "{reason}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchError {
    InvalidConfig(String),
    /// The level has neither `radius_m` nor `bounds`.
    NoPlayArea,
    /// `new_streaming` needs a level without buildings (they come in chunks).
    LevelHasBuildings,
    DuplicateBlock(u64),
    /// The chunk touches the already revealed area (it had to arrive earlier).
    AreaRevealed(u64),
    /// A building sticks out of its block by more than `block_margin_m`.
    BuildingOutsideBlock { block_id: u64, building_id: u64 },
    /// Wave 1's ring is not covered by the initial chunks.
    RingNotLoaded(u8),
}

impl std::fmt::Display for MatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Buildings of one map block, added with `Match::add_buildings`.
/// Coordinates are level-local meters (like `LevelPack`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildingChunk {
    pub block_id: u64,
    /// The area this block covers, `[min_x, min_y, max_x, max_y]`: once
    /// added, it counts as loaded for `ring_ready`. Blocks must tile the
    /// plane without overlapping, each building in one block; buildings may
    /// stick out by up to `match.block_margin_m`.
    pub bounds: [f32; 4],
    pub buildings: Vec<Building>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MatchSetup {
    pub seed: u64,
    /// Civilians per unit of building weight (difficulty scales it).
    pub population_multiplier: f32,
}

impl MatchSetup {
    /// The config's base multiplier.
    pub fn new(seed: u64, cfg: &Config) -> MatchSetup {
        MatchSetup { seed, population_multiplier: cfg.match_.population_multiplier }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WaveResult {
    pub wave: u8,
    pub won: bool,
    /// Ticks the wave ran.
    pub ticks: u32,
    pub radius_m: f32,
    /// Civilians added when this wave's ring was revealed.
    pub newcomers: u32,
    /// Civilians at Start (survivors + newcomers), before the outbreak.
    pub start_civilians: u32,
    pub end_civilians: u32,
    pub zombies_killed: u32,
    pub bites: u32,
    pub fence_cells_broken: u32,
    pub outbreak_clusters: u32,
    /// `Match::state_hash` at the start of this wave's prep.
    pub start_hash: u64,
    /// `Match::state_hash` after the tick that ended the wave.
    pub end_hash: u64,
}

impl WaveResult {
    /// Share of the wave's starting civilians still civilians at the end.
    pub fn saved(&self) -> f32 {
        if self.start_civilians == 0 {
            0.0
        } else {
            self.end_civilians as f32 / self.start_civilians as f32
        }
    }
}

/// An accepted action and the match tick it was applied on (`Match::tick`:
/// steps done before it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoggedAction {
    pub tick: u64,
    pub action: Action,
}

struct StoredChunk {
    chunk: BuildingChunk,
    /// `bounds` grown to every building's bounding box.
    extent: [f32; 4],
}

/// The game state a retry restores (everything but the inputs).
#[derive(Clone)]
struct MatchState {
    sim: Sim,
    wave: u8,
    phase: Phase,
    /// Geometry of every cell with all applied buildings (`WALK`,
    /// `BUILDING`, `WALL`), ignoring rings and fences.
    base: Vec<u8>,
    /// Block ids applied to the grid, in application order.
    applied: Vec<u64>,
    /// `sim.placements.len()` at prep start: only later ones can be undone.
    placements_mark: usize,
    newcomers: u32,
    wave_start_civilians: u32,
    /// Sim counters at Start (killed, bites, fence cells broken).
    counters0: [u32; 3],
    outbreak_sites: Vec<[f32; 2]>,
    start_hash: u64,
    results: Vec<WaveResult>,
}

impl MatchState {
    fn snapshot(&mut self) -> MatchState {
        MatchState {
            sim: self.sim.snapshot(),
            wave: self.wave,
            phase: self.phase,
            base: self.base.clone(),
            applied: self.applied.clone(),
            placements_mark: self.placements_mark,
            newcomers: self.newcomers,
            wave_start_civilians: self.wave_start_civilians,
            counters0: self.counters0,
            outbreak_sites: self.outbreak_sites.clone(),
            start_hash: self.start_hash,
            results: self.results.clone(),
        }
    }

    fn restore(&mut self, s: &MatchState) {
        self.sim.restore_from(&s.sim);
        self.wave = s.wave;
        self.phase = s.phase;
        self.base.clone_from(&s.base);
        self.applied.clone_from(&s.applied);
        self.placements_mark = s.placements_mark;
        self.newcomers = s.newcomers;
        self.wave_start_civilians = s.wave_start_civilians;
        self.counters0 = s.counters0;
        self.outbreak_sites.clone_from(&s.outbreak_sites);
        self.start_hash = s.start_hash;
        self.results.clone_from(&s.results);
    }
}

pub struct Match {
    cfg: Config,
    setup: MatchSetup,
    /// The level without buildings (name, centre, radius or bounds, fences).
    shell: LevelPack,
    /// Play-area centre, level-local meters.
    center: [f32; 2],
    rings: Vec<f32>,
    /// First wave whose disc contains each cell's centre (0: never).
    cell_ring: Vec<u8>,
    /// Same with the disc grown by `block_margin_m` (what `ring_ready` checks).
    cell_ring_margin: Vec<u8>,
    level_fence: Vec<bool>,
    chunks: BTreeMap<u64, StoredChunk>,
    loaded: Vec<bool>,
    /// Cells of each wave's ring (index wave - 1) not covered by any chunk yet.
    missing: Vec<u32>,
    state: MatchState,
    /// The current wave's prep start (one, not one per wave).
    prep_snapshot: MatchState,
    retries: u32,
    restarts: u32,
    tick: u64,
    log: Vec<LoggedAction>,
}

fn box_meets_disc(b: [f32; 4], c: [f32; 2], r: f32) -> bool {
    let nx = c[0].clamp(b[0], b[2]);
    let ny = c[1].clamp(b[1], b[3]);
    let (dx, dy) = (nx - c[0], ny - c[1]);
    dx * dx + dy * dy <= r * r
}

impl Match {
    /// A match on a complete level: all its buildings are known up front
    /// (one chunk, block id 0, covering everything). Headless and tests.
    pub fn new(level: &LevelPack, cfg: Config, setup: MatchSetup) -> Result<Match, MatchError> {
        let mut shell = level.clone();
        shell.buildings = Vec::new();
        let all = BuildingChunk { block_id: 0, bounds: [f32::MIN, f32::MIN, f32::MAX, f32::MAX], buildings: level.buildings.clone() };
        Match::new_streaming(&shell, cfg, setup, vec![all])
    }

    /// A match whose buildings arrive in chunks: `shell` gives the play area
    /// and fences (no buildings); `chunks` must cover wave 1's ring. Later
    /// chunks come through `add_buildings`.
    pub fn new_streaming(shell: &LevelPack, cfg: Config, setup: MatchSetup, chunks: Vec<BuildingChunk>) -> Result<Match, MatchError> {
        cfg.match_.validate(cfg.wave8_radius_m).map_err(MatchError::InvalidConfig)?;
        if !shell.buildings.is_empty() {
            return Err(MatchError::LevelHasBuildings);
        }
        let (center, level_r) = match (shell.radius_m, shell.bounds) {
            (Some(r), _) => ([0.0, 0.0], r),
            (None, Some([x0, y0, x1, y1])) => ([(x0 + x1) * 0.5, (y0 + y1) * 0.5], ((x1 - x0) * 0.5).min((y1 - y0) * 0.5)),
            _ => return Err(MatchError::NoPlayArea),
        };
        let rings = Match::ring_radii(&cfg, level_r);
        let mut shell = shell.clone();
        if shell.radius_m.is_some() {
            shell.radius_m = Some(rings[rings.len() - 1]);
        }
        let grid = Match::shell_grid(&shell, &cfg);
        let cells = grid.w * grid.h;
        let mut cell_ring = vec![0u8; cells];
        let mut cell_ring_margin = vec![0u8; cells];
        let margin = cfg.match_.block_margin_m;
        for c in 0..cells {
            let [lx, ly] = Match::cell_local(&grid, c);
            let (dx, dy) = (lx - center[0], ly - center[1]);
            let d2 = dx * dx + dy * dy;
            if let Some(w) = rings.iter().position(|&r| d2 <= r * r) {
                cell_ring[c] = w as u8 + 1;
            }
            if let Some(w) = rings.iter().position(|&r| d2 <= (r + margin) * (r + margin)) {
                cell_ring_margin[c] = w as u8 + 1;
            }
        }
        let mut level_fence = vec![false; cells];
        for f in &shell.fences {
            let pts: Vec<[f32; 2]> = f.iter().map(|&[x, y]| [x - grid.origin[0], y - grid.origin[1]]).collect();
            for c in grid.rasterize_polyline(&pts) {
                level_fence[c] = true;
            }
        }
        let mut missing = vec![0u32; rings.len()];
        for &r in &cell_ring_margin {
            if r > 0 {
                missing[r as usize - 1] += 1;
            }
        }
        let mut state = Match::fresh_state(grid, &cfg, &setup);
        let mut m = Match {
            prep_snapshot: state.snapshot(),
            state,
            cfg,
            setup,
            shell,
            center,
            rings,
            cell_ring,
            cell_ring_margin,
            level_fence,
            chunks: BTreeMap::new(),
            loaded: vec![false; cells],
            missing,
            retries: 0,
            restarts: 0,
            tick: 0,
            log: Vec::new(),
        };
        for ch in chunks {
            m.add_buildings(ch)?;
        }
        if !m.ring_ready(1) {
            return Err(MatchError::RingNotLoaded(1));
        }
        m.enter_prep();
        Ok(m)
    }

    /// Each wave's radius on a level of radius `level_r`. On a level at least
    /// as large as the wave-8 cap, the config's rings (cut at the level).
    /// On a smaller one the core keeps its size and the other rings are
    /// squeezed linearly between it and the level edge (all scaled if the
    /// level is smaller than the core).
    pub fn ring_radii(cfg: &Config, level_r: f32) -> Vec<f32> {
        let rc = &cfg.match_.ring_radius_m;
        let cap = cfg.wave8_radius_m;
        let l = level_r.min(cap);
        let r1 = rc[0];
        rc.iter()
            .map(|&r| {
                if l >= cap {
                    r
                } else if l > r1 {
                    r1 + (r - r1) * ((l - r1) / (cap - r1))
                } else {
                    r * (l / cap)
                }
            })
            .collect()
    }

    fn shell_grid(shell: &LevelPack, cfg: &Config) -> Grid {
        Grid::from_level(shell, cfg)
    }

    fn cell_local(grid: &Grid, c: usize) -> [f32; 2] {
        let (cx, cy) = (c % grid.w, c / grid.w);
        [grid.origin[0] + (cx as f32 + 0.5) * grid.cell, grid.origin[1] + (cy as f32 + 0.5) * grid.cell]
    }

    /// Wave 0: no ring revealed, no buildings, no agents.
    fn fresh_state(mut grid: Grid, cfg: &Config, setup: &MatchSetup) -> MatchState {
        let base = grid.kind.clone();
        grid.kind.fill(WALL);
        grid.rebuild_step_masks();
        let mut sim = Sim::with_capacity(grid, cfg.clone(), cfg.max_population as usize, setup.seed);
        sim.timeout = false;
        MatchState {
            sim,
            wave: 0,
            phase: Phase::Prep,
            base,
            applied: Vec::new(),
            placements_mark: 0,
            newcomers: 0,
            wave_start_civilians: 0,
            counters0: [0; 3],
            outbreak_sites: Vec::new(),
            start_hash: 0,
            results: Vec::new(),
        }
    }

    // ------------------------------------------------------------ loading

    /// Add a block of buildings. Allowed at any time, but only for area not
    /// yet revealed; chunks are applied when their area is first revealed,
    /// in block-id order, so the result never depends on arrival order.
    pub fn add_buildings(&mut self, chunk: BuildingChunk) -> Result<(), MatchError> {
        let id = chunk.block_id;
        if self.chunks.contains_key(&id) {
            return Err(MatchError::DuplicateBlock(id));
        }
        let mut e = chunk.bounds;
        let mg = self.cfg.match_.block_margin_m;
        let [bx0, by0, bx1, by1] = chunk.bounds;
        for b in &chunk.buildings {
            for &[x, y] in &b.polygon {
                if x < bx0 - mg || y < by0 - mg || x > bx1 + mg || y > by1 + mg {
                    return Err(MatchError::BuildingOutsideBlock { block_id: id, building_id: b.id });
                }
                e = [e[0].min(x), e[1].min(y), e[2].max(x), e[3].max(y)];
            }
        }
        if self.state.wave > 0 && box_meets_disc(e, self.center, self.radius_m()) {
            return Err(MatchError::AreaRevealed(id));
        }
        let g = &self.state.sim.grid;
        // Cells whose centre is inside the bounds (clamped to the grid).
        let cx0 = (((bx0 - g.origin[0]) / g.cell - 0.5).ceil().max(0.0) as usize).min(g.w);
        let cy0 = (((by0 - g.origin[1]) / g.cell - 0.5).ceil().max(0.0) as usize).min(g.h);
        let cx1 = ((bx1 - g.origin[0]) / g.cell - 0.5).floor().min(g.w as f32 - 1.0);
        let cy1 = ((by1 - g.origin[1]) / g.cell - 0.5).floor().min(g.h as f32 - 1.0);
        if cx1 >= 0.0 && cy1 >= 0.0 {
            let (w, cx1, cy1) = (g.w, cx1 as usize, cy1 as usize);
            for cy in cy0..=cy1 {
                for cx in cx0..=cx1 {
                    let c = cy * w + cx;
                    if !self.loaded[c] {
                        self.loaded[c] = true;
                        let r = self.cell_ring_margin[c];
                        if r > 0 {
                            self.missing[r as usize - 1] -= 1;
                        }
                    }
                }
            }
        }
        self.chunks.insert(id, StoredChunk { chunk, extent: e });
        Ok(())
    }

    /// Whether every cell within wave `wave`'s radius + `block_margin_m` is
    /// covered by a chunk (cells of the grid only).
    pub fn ring_ready(&self, wave: u8) -> bool {
        let w = (wave as usize).min(self.rings.len());
        self.missing[..w].iter().all(|&m| m == 0)
    }

    // ------------------------------------------------------------ actions

    /// Apply a player action between ticks. Accepted actions are logged.
    pub fn apply(&mut self, action: Action) -> Result<(), ActionError> {
        let phase = self.state.phase;
        let wrong = || Err(ActionError::WrongPhase { action: action.name().to_string(), phase });
        match &action {
            Action::PlaceTower { building } => {
                if phase != Phase::Prep {
                    return wrong();
                }
                let b = *building;
                if !self.building_revealed(b) {
                    return Err(ActionError::NotRevealed { building: b });
                }
                self.state.sim.place_tower(b).map_err(|reason| ActionError::Placement { reason })?;
            }
            Action::PlaceFence { points } => {
                if phase != Phase::Prep {
                    return wrong();
                }
                self.state.sim.place_fence(points).map_err(|reason| ActionError::Placement { reason })?;
            }
            Action::Undo => {
                if phase != Phase::Prep {
                    return wrong();
                }
                if self.state.sim.placements.len() <= self.state.placements_mark {
                    return Err(ActionError::NothingToUndo);
                }
                self.state.sim.undo();
            }
            Action::StartWave => {
                if phase != Phase::Prep {
                    return wrong();
                }
                self.start_wave();
            }
            Action::NextWave => {
                if phase != Phase::WaveWon {
                    return wrong();
                }
                let next = self.state.wave + 1;
                if !self.ring_ready(next) {
                    return Err(ActionError::RingNotLoaded { wave: next });
                }
                self.enter_prep();
            }
            Action::RetryWave => {
                if phase == Phase::MatchWon {
                    return wrong();
                }
                self.state.restore(&self.prep_snapshot);
                self.retries += 1;
            }
            Action::RestartMatch => {
                let grid = Match::shell_grid(&self.shell, &self.cfg);
                self.state = Match::fresh_state(grid, &self.cfg, &self.setup);
                self.enter_prep();
                self.retries += 1;
                self.restarts += 1;
            }
        }
        self.log.push(LoggedAction { tick: self.tick, action });
        Ok(())
    }

    fn building_revealed(&self, b: u32) -> bool {
        let g = &self.state.sim.grid;
        match g.buildings.get(b as usize) {
            Some(info) if info.cell_count > 0 => {
                let (lx, ly) = (info.centroid[0] + g.origin[0], info.centroid[1] + g.origin[1]);
                let (dx, dy) = (lx - self.center[0], ly - self.center[1]);
                let r = self.radius_m();
                dx * dx + dy * dy <= r * r
            }
            _ => false,
        }
    }

    // ------------------------------------------------------------ the loop

    pub fn step(&mut self) {
        self.step_timed(&mut NoClock);
    }

    /// One tick. Prep: cosmetic wander. Running: the wave. Otherwise idle.
    pub fn step_timed<C: Clock>(&mut self, clock: &mut C) {
        self.tick += 1;
        match self.state.phase {
            Phase::Prep => self.state.sim.step_timed(clock),
            Phase::Running => {
                let sim = &mut self.state.sim;
                let t = sim.tick as f32 / sim.cfg.tick_hz as f32;
                sim.fatigue = self.cfg.match_.fatigue_at(t);
                sim.step_timed(clock);
                if let Some(o) = sim.outcome() {
                    self.finish_wave(o);
                }
            }
            _ => {}
        }
    }

    /// Reveal the next wave's ring, add its newcomers and open its prep.
    fn enter_prep(&mut self) {
        let k = self.state.wave + 1;
        self.reveal(k);
        let st = &mut self.state;
        st.wave = k;
        let sim = &mut st.sim;
        sim.push_agents_off_blocked_cells();
        // Newcomers: buildings whose centroid is in this ring.
        let (origin, center, rings) = (sim.grid.origin, self.center, &self.rings);
        let ring_buildings: Vec<usize> = (0..sim.grid.buildings.len())
            .filter(|&b| {
                let [x, y] = sim.grid.buildings[b].centroid;
                let (dx, dy) = (x + origin[0] - center[0], y + origin[1] - center[1]);
                let d2 = dx * dx + dy * dy;
                let ring = rings.iter().position(|&r| d2 <= r * r).map_or(rings.len(), |w| w + 1);
                ring == k as usize
            })
            .collect();
        let mut rng = Pcg32::new(self.setup.seed, streams::stream(streams::SPAWN, k));
        st.newcomers = sim.spawn_newcomers(&ring_buildings, self.setup.population_multiplier as f64, &mut rng);
        for i in 0..sim.n {
            if sim.state[i] == DEAD {
                sim.timer[i] = 0; // no kill flash carried into prep
            }
            sim.vx[i] = 0.0;
            sim.vy[i] = 0.0;
        }
        sim.phase = GamePhase::Setup;
        sim.tick = 0;
        sim.tower_budget = sim.towers.len() as u32 + self.cfg.tower_budget;
        sim.fence_budget_m = sim.fence_used_m + self.cfg.fence_budget_m;
        sim.rng = Pcg32::new(self.setup.seed, streams::stream(streams::PREP_WANDER, k));
        sim.spawn_x.clone_from(&sim.x);
        sim.spawn_y.clone_from(&sim.y);
        st.placements_mark = sim.placements.len();
        st.phase = Phase::Prep;
        st.outbreak_sites.clear();
        let h = self.state_hash();
        self.state.start_hash = h;
        self.prep_snapshot = self.state.snapshot();
    }

    /// Open wave `k`'s disc: apply the chunks it touches (block-id order),
    /// restore the geometry inside it, add level fences of the new ring, and
    /// wall off pockets not connected to the main area.
    fn reveal(&mut self, k: u8) {
        let r = self.rings[k as usize - 1];
        let st = &mut self.state;
        for (id, sc) in &self.chunks {
            if st.applied.contains(id) || !box_meets_disc(sc.extent, self.center, r) {
                continue;
            }
            for b in &sc.chunk.buildings {
                let g = &mut st.sim.grid;
                let (info, cells) = g.rasterize_building(b, &st.base);
                let bi = g.buildings.len() as u32;
                for c in cells {
                    st.base[c] = BUILDING;
                    g.building[c] = bi;
                }
                g.buildings.push(info);
            }
            st.applied.push(*id);
        }
        let g = &mut st.sim.grid;
        for c in 0..g.kind.len() {
            let rc = self.cell_ring[c];
            if rc == 0 || rc > k {
                continue;
            }
            if rc == k {
                g.kind[c] = st.base[c];
                if self.level_fence[c] && st.base[c] == WALK {
                    g.kind[c] = FENCE;
                    g.fence_hp[c] = self.cfg.fence_cell_hp;
                }
            } else if g.kind[c] == WALL && st.base[c] == WALK {
                g.kind[c] = WALK; // a pocket walled earlier may connect now
            }
        }
        g.keep_largest_region(|kd| kd == WALK || kd == FENCE, |kd| kd == WALK);
        g.rebuild_step_masks();
    }

    fn start_wave(&mut self) {
        let k = self.state.wave;
        let mc = &self.cfg.match_;
        let st = &mut self.state;
        let sim = &mut st.sim;
        // Prep wandering was cosmetic: back to the prep-start positions.
        sim.x.copy_from_slice(&sim.spawn_x);
        sim.y.copy_from_slice(&sim.spawn_y);
        sim.vx.fill(0.0);
        sim.vy.fill(0.0);
        sim.rng = Pcg32::new(self.setup.seed, streams::stream(streams::WANDER, k));
        sim.push_agents_off_blocked_cells();
        sim.grid.rebuild_step_masks();
        sim.field_cells = sim.grid.kind.iter().filter(|&&k| k == WALK || k == FENCE).count();
        sim.tick = 0;
        for t in sim.towers.iter_mut() {
            t.cooldown = 0;
        }
        let start = sim.stats.civilians;
        st.wave_start_civilians = start;
        sim.stats.initial_civilians = start;
        sim.stats.first_breach_tick = None;
        sim.loss_below = (mc.defeat_fraction as f64 * start as f64).ceil() as u32;
        sim.fatigue = mc.fatigue_at(0.0);
        st.counters0 = [sim.stats.zombies_killed, sim.stats.bites, sim.stats.fence_cells_broken];

        // Outbreak: wave 1 anywhere; later waves in the new ring, except
        // `inner_outbreaks` clusters inside earlier territory.
        let w = k as usize - 1;
        let mut rng = Pcg32::new(self.setup.seed, streams::stream(streams::OUTBREAK, k));
        let clusters = mc.outbreak_clusters[w] as usize;
        let (origin, center) = (sim.grid.origin, self.center);
        let civilians: Vec<u32> = (0..sim.n as u32).filter(|&i| sim.state[i as usize] == CIVILIAN).collect();
        let mut seeds = Vec::new();
        if k == 1 {
            sim.pick_outbreak_seeds(&civilians, clusters, &mut rng, &mut seeds);
        } else {
            let r_prev = self.rings[w - 1];
            let inside = |i: u32| {
                let (dx, dy) = (sim.x[i as usize] + origin[0] - center[0], sim.y[i as usize] + origin[1] - center[1]);
                dx * dx + dy * dy <= r_prev * r_prev
            };
            let (inner, ring): (Vec<u32>, Vec<u32>) = civilians.iter().partition(|&&i| inside(i));
            let n_inner = (mc.inner_outbreaks[w] as usize).min(clusters);
            sim.pick_outbreak_seeds(&inner, n_inner, &mut rng, &mut seeds);
            // An empty new ring (no buildings there) falls back to anywhere.
            let rest = if ring.is_empty() { &civilians } else { &ring };
            sim.pick_outbreak_seeds(rest, clusters - seeds.len(), &mut rng, &mut seeds);
        }
        st.outbreak_sites = seeds.iter().map(|&s| [sim.x[s], sim.y[s]]).collect();
        sim.infect_clusters(&seeds, mc.outbreak_radius_m[w], mc.outbreak_min_per_cluster[w] as usize);
        sim.phase = GamePhase::Running;
        sim.recompute_chase();
        sim.recompute_threat_and_flee();
        st.phase = Phase::Running;
    }

    fn finish_wave(&mut self, o: Outcome) {
        let k = self.state.wave;
        let won = o == Outcome::Win;
        self.state.phase = match (won, k >= self.waves()) {
            (true, true) => Phase::MatchWon,
            (true, false) => Phase::WaveWon,
            (false, _) => Phase::WaveLost,
        };
        let end_hash = self.state_hash();
        let st = &mut self.state;
        let s = &st.sim.stats;
        let r = WaveResult {
            wave: k,
            won,
            ticks: st.sim.tick,
            radius_m: self.rings[k as usize - 1],
            newcomers: st.newcomers,
            start_civilians: st.wave_start_civilians,
            end_civilians: s.civilians,
            zombies_killed: s.zombies_killed - st.counters0[0],
            bites: s.bites - st.counters0[1],
            fence_cells_broken: s.fence_cells_broken - st.counters0[2],
            outbreak_clusters: st.outbreak_sites.len() as u32,
            start_hash: st.start_hash,
            end_hash,
        };
        st.results.push(r);
    }

    // ------------------------------------------------------------ queries

    pub fn phase(&self) -> Phase {
        self.state.phase
    }
    /// Current wave, 1-based.
    pub fn wave(&self) -> u8 {
        self.state.wave
    }
    pub fn waves(&self) -> u8 {
        self.rings.len() as u8
    }
    /// Radius of wave `wave`'s disc (1-based), meters.
    pub fn ring_radius_m(&self, wave: u8) -> f32 {
        self.rings[(wave.max(1) as usize - 1).min(self.rings.len() - 1)]
    }
    /// The revealed radius (the current wave's), meters.
    pub fn radius_m(&self) -> f32 {
        if self.state.wave == 0 {
            0.0
        } else {
            self.ring_radius_m(self.state.wave)
        }
    }
    /// Play-area centre in sim coordinates.
    pub fn center(&self) -> [f32; 2] {
        let o = self.state.sim.grid.origin;
        [self.center[0] - o[0], self.center[1] - o[1]]
    }
    /// The sim, for rendering and inspection.
    pub fn sim(&self) -> &Sim {
        &self.state.sim
    }
    /// Direct access for tests and tools only: changes made here bypass the
    /// action log, so a replay will not reproduce them.
    pub fn debug_sim_mut(&mut self) -> &mut Sim {
        &mut self.state.sim
    }
    pub fn config(&self) -> &Config {
        &self.cfg
    }
    pub fn setup(&self) -> &MatchSetup {
        &self.setup
    }
    /// Ticks stepped since the match was created (any phase, never reset).
    pub fn tick(&self) -> u64 {
        self.tick
    }
    /// Ticks since the current wave started (or since its prep began).
    pub fn wave_tick(&self) -> u32 {
        self.state.sim.tick
    }
    pub fn log(&self) -> &[LoggedAction] {
        &self.log
    }
    /// RetryWave + RestartMatch count (0 earns the no-retry bonus).
    pub fn retries(&self) -> u32 {
        self.retries
    }
    pub fn restarts(&self) -> u32 {
        self.restarts
    }
    /// Results of the waves played so far (the latest attempt of each).
    pub fn results(&self) -> &[WaveResult] {
        &self.state.results
    }
    /// Civilians added by the current wave's ring.
    pub fn newcomers(&self) -> u32 {
        self.state.newcomers
    }
    /// Civilians at the current wave's Start (0 before it).
    pub fn wave_start_civilians(&self) -> u32 {
        self.state.wave_start_civilians
    }
    /// The wave is lost when civilians drop below this.
    pub fn defeat_threshold(&self) -> u32 {
        self.state.sim.loss_below
    }
    /// Civilian speed factor now.
    pub fn fatigue(&self) -> f32 {
        self.state.sim.fatigue
    }
    /// Outbreak seed positions of the current wave (sim coordinates). Hidden
    /// information: for tests and debug views, not for the player.
    pub fn outbreak_sites(&self) -> &[[f32; 2]] {
        &self.state.outbreak_sites
    }
    pub fn towers_left(&self) -> u32 {
        self.state.sim.towers_left()
    }
    pub fn fence_left_m(&self) -> f32 {
        self.state.sim.fence_left_m()
    }
    /// Block ids applied to the grid so far, in application order.
    pub fn applied_blocks(&self) -> &[u64] {
        &self.state.applied
    }
    /// The first wave whose disc contains sim point (x, y) (`waves() + 1`
    /// outside the last).
    pub fn wave_of_point(&self, x: f32, y: f32) -> u8 {
        let [cx, cy] = self.center();
        let (dx, dy) = (x - cx, y - cy);
        let d2 = dx * dx + dy * dy;
        self.rings.iter().position(|&r| d2 <= r * r).map_or(self.waves() + 1, |w| w as u8 + 1)
    }
    /// `Match::state_hash` at the start of the current wave's prep.
    pub fn prep_hash(&self) -> u64 {
        self.state.start_hash
    }

    /// FNV-1a over the sim's state hash and the match state (wave, phase,
    /// applied blocks). Excludes inputs and counters that a retry must not
    /// reset (retries, the log, the match tick).
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |bytes: &[u8]| {
            for &b in bytes {
                h ^= b as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        eat(&self.state.sim.state_hash().to_le_bytes());
        eat(&[self.state.wave, self.state.phase as u8]);
        eat(&(self.state.sim.n as u32).to_le_bytes());
        for id in &self.state.applied {
            eat(&id.to_le_bytes());
        }
        h
    }

    /// Approximate heap bytes: the sim, the prep snapshot and the match's
    /// own per-cell arrays.
    pub fn memory_bytes(&self) -> usize {
        let snap = &self.prep_snapshot;
        let g = &snap.sim.grid;
        let snap_bytes = g.kind.len() * 11 + snap.base.len() + snap.sim.x.len() * 34;
        self.state.sim.memory_bytes() + self.state.base.len() + snap_bytes + self.cell_ring.len() * 4
    }
}
