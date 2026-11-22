//! Scenarios S1–S5, several seeds each, run in parallel (one sim per thread).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sim_core::level::{COMPOUND_CENTER, COMPOUND_HALF};
use sim_core::sim::CIVILIAN;
use sim_core::Sim;

use crate::common::*;

#[derive(Clone, Debug)]
pub struct Scenario {
    pub id: &'static str,
    pub level: &'static str,
    pub defense: &'static str,
    pub population: u32,
}

pub const SCENARIOS: [Scenario; 5] = [
    Scenario { id: "S1", level: "paris-marais", defense: "None", population: 20_000 },
    Scenario { id: "S2", level: "paris-marais", defense: "8 towers in the 8 largest of the 24 buildings nearest the centre", population: 20_000 },
    Scenario { id: "S3", level: "walled_compound", defense: "Fence ring, 400 civilians inside, 100 zombies outside", population: 500 },
    Scenario { id: "S4", level: "suburb", defense: "None", population: 20_000 },
    Scenario { id: "S5", level: "paris-marais", defense: "None (100k agents)", population: 100_000 },
];

pub const S3_CIVILIANS: usize = 400;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunResult {
    pub id: String,
    pub level: String,
    pub defense: String,
    pub population: u32,
    pub seed: u64,
    pub outcome: String,
    pub game_seconds: f64,
    pub initial_civilians: u32,
    pub survivors: u32,
    pub survival: f64,
    /// Seconds until 50% / 90% of the initial civilians were lost (None: never).
    pub t50: Option<f64>,
    pub t90: Option<f64>,
    pub zombies_killed: u32,
    pub first_breach_s: Option<f64>,
    pub wall_seconds: f64,
    /// Per second: t, civilians, infected, zombies, dead, dormant_share.
    pub series: Vec<[f64; 6]>,
}

impl RunResult {
    pub fn summary_line(&self) -> String {
        format!(
            "{} seed {} {:<7} survival {:>5.1}% t50 {:>6} t90 {:>6} killed {:>5} breach {:>6} ({:.0}s game, {:.1}s wall)",
            self.id,
            self.seed,
            self.outcome,
            self.survival * 100.0,
            fmt_opt(self.t50),
            fmt_opt(self.t90),
            self.zombies_killed,
            fmt_opt(self.first_breach_s),
            self.game_seconds,
            self.wall_seconds
        )
    }

    pub fn csv(&self) -> String {
        let mut s = String::from("t,civilians,infected,zombies,dead,dormant_share\n");
        for r in &self.series {
            s.push_str(&format!("{},{},{},{},{},{:.4}\n", r[0], r[1], r[2], r[3], r[4], r[5]));
        }
        s
    }
}

pub fn fmt_opt(v: Option<f64>) -> String {
    v.map(|x| format!("{x:.0}s")).unwrap_or_else(|| "—".into())
}

/// The 8 largest of the 24 buildings whose centroids are nearest the centre.
pub fn s2_tower_buildings(sim: &Sim) -> Vec<u32> {
    let [cx, cy] = sim.to_sim(0.0, 0.0);
    let mut by_dist: Vec<(f32, usize)> = sim
        .grid
        .buildings
        .iter()
        .enumerate()
        .map(|(i, b)| ((b.centroid[0] - cx).powi(2) + (b.centroid[1] - cy).powi(2), i))
        .collect();
    by_dist.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
    let mut near: Vec<usize> = by_dist.iter().take(24).map(|&(_, i)| i).collect();
    near.sort_by(|&a, &b| sim.grid.buildings[b].area_m2.partial_cmp(&sim.grid.buildings[a].area_m2).unwrap().then(a.cmp(&b)));
    near.into_iter().take(8).map(|i| i as u32).collect()
}

pub fn build(sc: &Scenario, seed: u64) -> Sim {
    let level = load_level(sc.level);
    let mut sim = Sim::new(&level, load_config(), sc.population, seed);
    match sc.id {
        "S2" => {
            for b in s2_tower_buildings(&sim) {
                sim.place_tower(b).expect("S2 tower");
            }
            sim.start();
        }
        "S3" => {
            setup_s3(&mut sim, seed);
        }
        _ => sim.start(),
    }
    sim
}

/// Civilians on random interior cells; zombies on random cells outside the ring.
fn setup_s3(sim: &mut Sim, seed: u64) {
    let mut rng = sim_core::rng::Pcg32::new(seed, 0x5333);
    let [cx, cy] = sim.to_sim(COMPOUND_CENTER[0], COMPOUND_CENTER[1]);
    let walk: Vec<usize> = (0..sim.grid.kind.len()).filter(|&c| sim.grid.walkable(c)).collect();
    let inside: Vec<usize> = walk
        .iter()
        .copied()
        .filter(|&c| {
            let [x, y] = sim.grid.cell_center(c);
            (x - cx).abs() < COMPOUND_HALF && (y - cy).abs() < COMPOUND_HALF
        })
        .collect();
    let outside: Vec<usize> = walk
        .iter()
        .copied()
        .filter(|&c| {
            let [x, y] = sim.grid.cell_center(c);
            (x - cx).abs() > COMPOUND_HALF + 8.0 || (y - cy).abs() > COMPOUND_HALF + 8.0
        })
        .collect();
    for i in 0..sim.n {
        let list = if i < S3_CIVILIANS { &inside } else { &outside };
        let c = list[rng.below(list.len() as u32) as usize];
        let [x, y] = sim.grid.cell_center(c);
        let (jx, jy) = ((rng.f32() - 0.5) * 1.6, (rng.f32() - 0.5) * 1.6);
        if i < S3_CIVILIANS {
            sim.x[i] = x + jx;
            sim.y[i] = y + jy;
        } else {
            sim.force_zombie(i, x + jx, y + jy);
        }
    }
    sim.stats.initial_civilians = sim.stats.civilians;
    sim.start_without_outbreak();
}

pub fn run_one(sc: &Scenario, seed: u64) -> RunResult {
    let t0 = std::time::Instant::now();
    let mut sim = build(sc, seed);
    let hz = sim.cfg.tick_hz;
    let initial = sim.stats.initial_civilians;
    let mut series = Vec::new();
    let (mut t50, mut t90) = (None, None);
    let record = |sim: &Sim, series: &mut Vec<[f64; 6]>| {
        let s = &sim.stats;
        series.push([
            (sim.tick / hz) as f64,
            s.civilians as f64,
            s.infected as f64,
            s.zombies as f64,
            s.dead as f64,
            s.dormant as f64 / s.civilians.max(1) as f64,
        ]);
    };
    record(&sim, &mut series);
    while sim.outcome().is_none() {
        sim.step();
        let lost = initial - sim.stats.civilians.min(initial);
        let t = sim.tick as f64 / hz as f64;
        if t50.is_none() && lost * 2 >= initial {
            t50 = Some(t);
        }
        if t90.is_none() && lost * 10 >= initial * 9 {
            t90 = Some(t);
        }
        if sim.tick % hz == 0 {
            record(&sim, &mut series);
        }
    }
    if sim.tick % hz != 0 {
        record(&sim, &mut series);
    }
    debug_assert_eq!(sim.state.iter().filter(|&&s| s == CIVILIAN).count() as u32, sim.stats.civilians);
    RunResult {
        id: sc.id.into(),
        level: sc.level.into(),
        defense: sc.defense.into(),
        population: sc.population,
        seed,
        outcome: sim.outcome().unwrap().as_str().into(),
        game_seconds: sim.tick as f64 / hz as f64,
        initial_civilians: initial,
        survivors: sim.stats.civilians,
        survival: sim.survival() as f64,
        t50,
        t90,
        zombies_killed: sim.stats.zombies_killed,
        first_breach_s: sim.stats.first_breach_tick.map(|t| t as f64 / hz as f64),
        wall_seconds: t0.elapsed().as_secs_f64(),
        series,
    }
}

/// Run every scenario × seed (seeds 1..=n) across all cores.
pub fn run_all(seeds: u32, only: Option<&str>) -> Vec<RunResult> {
    let mut jobs: Vec<(usize, u64)> = Vec::new();
    for (k, sc) in SCENARIOS.iter().enumerate() {
        if only.map_or(true, |o| o.split(',').any(|x| x == sc.id)) {
            for s in 1..=seeds as u64 {
                jobs.push((k, s));
            }
        }
    }
    // Heaviest first so the long S5 runs don't end up last.
    jobs.sort_by_key(|&(k, s)| (std::cmp::Reverse(SCENARIOS[k].population), k, s));
    let next = AtomicUsize::new(0);
    let out = Mutex::new(Vec::new());
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let j = next.fetch_add(1, Ordering::SeqCst);
                let Some(&(k, seed)) = jobs.get(j) else { break };
                let r = run_one(&SCENARIOS[k], seed);
                eprintln!("  {}", r.summary_line());
                out.lock().unwrap().push(r);
            });
        }
    });
    let mut v = out.into_inner().unwrap();
    v.sort_by(|a, b| a.id.cmp(&b.id).then(a.seed.cmp(&b.seed)));
    v
}
