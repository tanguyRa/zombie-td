//! Wave-8 scale benchmark (`sim-headless bench --scale`): synthetic
//! `grid_city_disc` levels at 1.1 / 1.3 / 1.6 km radius (and an optional real
//! level) at 20k–150k agents, native and WASM under Node.

use std::fmt::Write as _;
use std::process::Command;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sim_core::grid::WALK;
use sim_core::{Config, LevelPack, Sim};

use crate::bench::{BenchRun, BenchSummary};
use crate::common::*;

pub const SCALE_RADII: [f32; 3] = [1100.0, 1300.0, 1600.0];
pub const SCALE_POPS: [u32; 4] = [20_000, 50_000, 100_000, 150_000];
pub const SCALE_TICKS: u32 = 8000;
pub const SCALE_SEED: u64 = 1;
/// Paris-like blocks: 40 m buildings, 14 m streets. Walkable share is close
/// to the Marais level (see DECISIONS.md, "Scale").
pub const BLOCK_M: f32 = 40.0;
pub const STREET_M: f32 = 14.0;
/// Wave 8 is "massive": more outbreak clusters than the 3 of a 400 m level.
pub const SCALE_CLUSTERS: u32 = 12;
/// A wave is lost when civilians drop below this share of the start (T2
/// defeat rule), so the benchmark stops there too.
pub const STOP_CIVILIAN_SHARE: f64 = 0.15;
/// Fenced case: fence hp per cell (default 300) and the zombies' extra path
/// cost through a fence (default 400). Weak fences, so they break often.
pub const FENCED_CELL_HP: f32 = 6.0;
pub const FENCED_PATH_COST: i32 = 100;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScaleRun {
    pub level: String,
    pub radius_m: f32,
    pub cells: usize,
    pub walkable: usize,
    /// `Sim::new` + `start()` (native only).
    pub setup_ms: f64,
    /// One full chase recompute and one full threat + flee recompute, timed
    /// right after start (native only; 0 for WASM).
    pub full_chase_ms: f64,
    pub full_threat_flee_ms: f64,
    /// Native: `Sim::memory_bytes()`. WASM: linear memory size.
    pub memory_bytes: u64,
    /// Fence cells broken, and ticks on which at least one broke.
    pub fence_cells_broken: u32,
    pub break_ticks: u32,
    pub run: BenchRun,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScaleSummary {
    pub level: String,
    pub radius_m: f32,
    pub walkable: usize,
    /// Walkable cells over the disc's cell count (street share).
    pub walkable_share: f64,
    pub runtime: String,
    pub population: u32,
    pub ticks: u32,
    pub memory_mb: f64,
    pub setup_ms: f64,
    pub full_chase_ms: f64,
    pub full_threat_flee_ms: f64,
    pub fields_p95: f64,
    pub fields_max: f64,
    pub fence_cells_broken: u32,
    pub break_ticks: u32,
    pub tick: BenchSummary,
}

impl ScaleRun {
    pub fn summary(&self) -> ScaleSummary {
        let mut f: Vec<f64> = self.run.phase_ms.iter().map(|p| p[1]).collect();
        f.sort_by(|a, b| a.partial_cmp(b).unwrap());
        ScaleSummary {
            level: self.level.clone(),
            radius_m: self.radius_m,
            walkable: self.walkable,
            walkable_share: self.walkable as f64 * 4.0 / (std::f64::consts::PI * (self.radius_m as f64).powi(2)).max(1.0),
            runtime: self.run.runtime.clone(),
            population: self.run.population,
            ticks: self.run.tick_ms.len() as u32,
            memory_mb: self.memory_bytes as f64 / (1024.0 * 1024.0),
            setup_ms: self.setup_ms,
            full_chase_ms: self.full_chase_ms,
            full_threat_flee_ms: self.full_threat_flee_ms,
            fields_p95: percentile(&f, 95.0),
            fields_max: f.last().copied().unwrap_or(0.0),
            fence_cells_broken: self.fence_cells_broken,
            break_ticks: self.break_ticks,
            tick: self.run.summary(),
        }
    }
}

pub fn scale_level(radius_m: f32) -> LevelPack {
    sim_core::level::grid_city_disc(radius_m, BLOCK_M, STREET_M, 7)
}

/// The break-heavy case: `scale_level` sealed by a fence across every
/// street segment (`level::grid_city_disc_fenced`). Used with
/// `fenced_config` (weak fences), so fences keep breaking all wave.
pub fn fenced_level(radius_m: f32) -> LevelPack {
    sim_core::level::grid_city_disc_fenced(radius_m, BLOCK_M, STREET_M, 7)
}

pub fn fenced_config(clusters: u32) -> Config {
    let mut c = scale_config(clusters);
    c.fence_cell_hp = FENCED_CELL_HP;
    c.fence_path_cost = FENCED_PATH_COST;
    c
}

/// Real street geometry at wave-8 size without a network query: the square
/// inside the committed Paris Marais circle (400 m), tiled with alternate
/// tiles mirrored so streets line up at the seams, cut to `radius_m`.
pub fn marais_tiled(radius_m: f32) -> LevelPack {
    let src = load_level("paris-marais");
    let s = src.radius_m.unwrap_or(400.0) / std::f32::consts::SQRT_2;
    let inside: Vec<&sim_core::level::Building> = src.buildings.iter().filter(|b| b.polygon.iter().all(|p| p[0].abs() <= s && p[1].abs() <= s)).collect();
    let n = (radius_m / (2.0 * s)).ceil() as i32 + 1;
    let keep = radius_m - 10.0;
    let mut buildings = Vec::new();
    let mut id = 1;
    for j in -n..=n {
        for i in -n..=n {
            let (fx, fy) = (if i % 2 != 0 { -1.0 } else { 1.0 }, if j % 2 != 0 { -1.0 } else { 1.0 });
            let (ox, oy) = (2.0 * s * i as f32, 2.0 * s * j as f32);
            for b in &inside {
                let mut poly: Vec<[f32; 2]> = b.polygon.iter().map(|p| [ox + fx * p[0], oy + fy * p[1]]).collect();
                if fx * fy < 0.0 {
                    poly.reverse();
                }
                let [cx, cy] = sim_core::level::polygon_centroid(&poly);
                if cx * cx + cy * cy > keep * keep {
                    continue;
                }
                buildings.push(sim_core::level::Building { id, kind: b.kind, floors: b.floors, polygon: poly });
                id += 1;
            }
        }
    }
    LevelPack {
        name: format!("marais_tiled_{radius_m}m"),
        center_lat: src.center_lat,
        center_lon: src.center_lon,
        radius_m: Some(radius_m),
        buildings,
        fences: vec![],
        bounds: None,
    }
}

pub fn scale_config(clusters: u32) -> Config {
    let mut c = load_config();
    c.outbreak_clusters = clusters;
    c
}

pub fn run_native(level: &LevelPack, radius_m: f32, cfg: &Config, population: u32, ticks: u32) -> ScaleRun {
    let t0 = Instant::now();
    let mut sim = Sim::new(level, cfg.clone(), population, SCALE_SEED);
    sim.start();
    let setup_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = Instant::now();
    sim.recompute_chase();
    let full_chase_ms = t1.elapsed().as_secs_f64() * 1000.0;
    let t2 = Instant::now();
    sim.recompute_threat_and_flee();
    let full_threat_flee_ms = t2.elapsed().as_secs_f64() * 1000.0;
    let mut clock = WallClock::new();
    let mut run = BenchRun {
        runtime: "native".into(),
        population,
        ticks,
        tick_ms: Vec::with_capacity(ticks as usize),
        phase_ms: Vec::with_capacity(ticks as usize),
        dormant_share: Vec::with_capacity(ticks as usize),
    };
    let mut break_ticks = 0;
    for _ in 0..ticks {
        if sim.outcome().is_some() || (sim.stats.civilians as f64) < STOP_CIVILIAN_SHARE * population as f64 {
            break;
        }
        let broken = sim.stats.fence_cells_broken;
        sim.step_timed(&mut clock);
        break_ticks += (sim.stats.fence_cells_broken > broken) as u32;
        run.tick_ms.push(sim.phase_ms.iter().sum());
        run.phase_ms.push(sim.phase_ms.to_vec());
        run.dormant_share.push(sim.stats.dormant as f64 / sim.stats.civilians.max(1) as f64);
    }
    ScaleRun {
        level: level.name.clone(),
        radius_m,
        cells: sim.grid.w * sim.grid.h,
        walkable: sim.grid.kind.iter().filter(|&&k| k == WALK).count(),
        setup_ms,
        full_chase_ms,
        full_threat_flee_ms,
        memory_bytes: sim.memory_bytes() as u64,
        fence_cells_broken: sim.stats.fence_cells_broken,
        break_ticks,
        run,
    }
}

#[derive(Deserialize)]
struct WasmOut {
    memory_bytes: u64,
    setup_ms: f64,
    #[serde(default)]
    fence_cells_broken: u32,
    #[serde(default)]
    break_ticks: u32,
    #[serde(flatten)]
    run: BenchRun,
}

/// Run the same cases in WASM under Node (needs `pkg-node`, see wasm-bench.mjs).
pub fn run_wasm(level: &LevelPack, radius_m: f32, cfg: &Config, pops: &[u32], ticks: u32, native: &[ScaleRun]) -> Result<Vec<ScaleRun>, String> {
    let dir = std::env::temp_dir();
    let lf = dir.join(format!("zombie-td-scale-{}.json", level.name));
    let cf = dir.join(format!("zombie-td-scale-config-{}.json", level.name));
    let of = dir.join("zombie-td-scale-wasm.json");
    std::fs::write(&lf, serde_json::to_string(level).unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&cf, serde_json::to_string(cfg).unwrap()).map_err(|e| e.to_string())?;
    let pops_s = pops.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let o = Command::new("node")
        .current_dir(repo_root())
        .args(["tools/wasm-bench.mjs", "--level-file", lf.to_str().unwrap(), "--config-file", cf.to_str().unwrap()])
        .args(["--pops", &pops_s, "--ticks", &ticks.to_string(), "--seed", &SCALE_SEED.to_string(), "--out", of.to_str().unwrap()])
        .args(["--stop-civ-share", &STOP_CIVILIAN_SHARE.to_string()])
        .output()
        .map_err(|e| e.to_string())?;
    eprint!("{}", String::from_utf8_lossy(&o.stderr));
    if !o.status.success() {
        return Err(format!("wasm-bench failed: {}", String::from_utf8_lossy(&o.stderr)));
    }
    let raw: Vec<WasmOut> = serde_json::from_str(&std::fs::read_to_string(&of).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(raw
        .into_iter()
        .map(|w| {
            let nat = native.iter().find(|n| n.run.population == w.run.population);
            ScaleRun {
                level: level.name.clone(),
                radius_m,
                cells: nat.map_or(0, |n| n.cells),
                walkable: nat.map_or(0, |n| n.walkable),
                setup_ms: w.setup_ms,
                full_chase_ms: 0.0,
                full_threat_flee_ms: 0.0,
                memory_bytes: w.memory_bytes,
                fence_cells_broken: w.fence_cells_broken,
                break_ticks: w.break_ticks,
                run: w.run,
            }
        })
        .collect())
}

pub struct ScaleOpts {
    pub radii: Vec<f32>,
    pub pops: Vec<u32>,
    pub ticks: u32,
    pub clusters: u32,
    pub wasm: bool,
    /// Extra committed or local level files (levels/<name>.json).
    pub real_levels: Vec<String>,
    /// Radii of the fenced, break-heavy case (`fenced_level`).
    pub fenced: Vec<f32>,
}

pub fn run_all(o: &ScaleOpts) -> Vec<ScaleRun> {
    let cfg = scale_config(o.clusters);
    let mut cases: Vec<(LevelPack, f32, Config)> = o.radii.iter().map(|&r| (scale_level(r), r, cfg.clone())).collect();
    for name in &o.real_levels {
        // "marais-tiled:<radius>" builds the tiled Marais level; anything else
        // is a file in levels/.
        let l = match name.strip_prefix("marais-tiled:") {
            Some(r) => marais_tiled(r.parse().expect("marais-tiled:<radius m>")),
            None => load_level(name),
        };
        let r = l.radius_m.unwrap_or(0.0);
        cases.push((l, r, cfg.clone()));
    }
    for &r in &o.fenced {
        cases.push((fenced_level(r), r, fenced_config(o.clusters)));
    }
    let mut out = Vec::new();
    for (level, r, cfg) in &cases {
        let mut native = Vec::new();
        for &p in &o.pops {
            eprintln!("[scale] native {} {} agents, {} ticks", level.name, p, o.ticks);
            let run = run_native(level, *r, cfg, p, o.ticks);
            eprintln!("[scale]   {}", summary_line(&run.summary()));
            native.push(run);
        }
        if o.wasm {
            eprintln!("[scale] wasm {}", level.name);
            match run_wasm(level, *r, cfg, &o.pops, o.ticks, &native) {
                Ok(w) => {
                    for run in &w {
                        eprintln!("[scale]   {}", summary_line(&run.summary()));
                    }
                    out.extend(native);
                    out.extend(w);
                    continue;
                }
                Err(e) => eprintln!("[scale] {e}"),
            }
        }
        out.extend(native);
    }
    out
}

pub fn summary_line(s: &ScaleSummary) -> String {
    format!(
        "{} {} {:>6}: p50 {:.2} p95 {:.2} p99 {:.2} max {:.2} ms | fields p95 {:.2} max {:.2} | full chase {:.1} threat+flee {:.1} ms | {:.0} MB | {} ticks | {} fence cells broken on {} ticks",
        s.level, s.runtime, s.population, s.tick.p50, s.tick.p95, s.tick.p99, s.tick.max, s.fields_p95, s.fields_max, s.full_chase_ms, s.full_threat_flee_ms, s.memory_mb, s.ticks, s.fence_cells_broken, s.break_ticks
    )
}

/// One paragraph describing the scale runs.
pub fn intro_md(ticks: u32, clusters: u32) -> String {
    format!(
        "Synthetic `grid_city_disc` levels ({BLOCK_M} m blocks, {STREET_M} m streets) cut to a circle, plus the Paris Marais buildings tiled to the same size (`marais-tiled`, real street geometry). `grid_fenced` is the break-heavy case: the same grid with a fence through every block row and column (every street segment fenced once, no detour), fence hp {FENCED_CELL_HP} per cell and fence path cost {FENCED_PATH_COST}, so zombies chew through all wave. No other defense, seed {SCALE_SEED}, {clusters} outbreak clusters, run until civilians drop below {:.0}% (the wave-defeat rule) or {ticks} ticks. Max is dominated by isolated host hiccups (single ticks, not reproducible); p95/p99 are the robust figures. Memory: `Sim::memory_bytes()` natively, the whole linear memory in WASM. Regenerate with `cargo run --release -p sim-headless -- bench --scale`.",
        100.0 * STOP_CIVILIAN_SHARE
    )
}

pub fn table_md(runs: &[ScaleRun]) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "| Level | Walkable cells (share) | Runtime | Agents | Ticks | p50 ms | p95 ms | p99 ms | max ms | fields p95 ms | fields max ms | full chase ms | full threat+flee ms | memory MB | setup ms | fence cells broken (ticks) |");
    let _ = writeln!(s, "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for r in runs {
        let m = r.summary();
        let fc = if m.full_chase_ms > 0.0 { format!("{:.1}", m.full_chase_ms) } else { "–".into() };
        let ft = if m.full_threat_flee_ms > 0.0 { format!("{:.1}", m.full_threat_flee_ms) } else { "–".into() };
        let _ = writeln!(
            s,
            "| {} | {} ({:.0}%) | {} | {} | {} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {} | {} | {:.0} | {:.0} | {} ({}) |",
            m.level, m.walkable, 100.0 * m.walkable_share, m.runtime, m.population, m.ticks, m.tick.p50, m.tick.p95, m.tick.p99, m.tick.max, m.fields_p95, m.fields_max, fc, ft, m.memory_mb, m.setup_ms, m.fence_cells_broken, m.break_ticks
        );
    }
    s
}

/// Markdown section for the report.
pub fn section_md(runs: &[ScaleRun], ticks: u32, clusters: u32) -> String {
    format!("## Scale (wave 8)\n\n{}\n\n{}\n", intro_md(ticks, clusters), table_md(runs))
}
