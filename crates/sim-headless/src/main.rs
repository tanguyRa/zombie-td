//! Headless runner: scenarios, benchmarks and the report.
//!
//!   cargo run --release -p sim-headless -- report      # everything, writes reports/
//!   cargo run --release -p sim-headless -- run --level paris-marais --pop 20000 --seed 1
//!   cargo run --release -p sim-headless -- bench --pop 100000
//!   cargo run --release -p sim-headless -- bench --scale [--radii 1100,1300,1600] [--pops 20000,...]
//!        [--ticks 8000] [--clusters 12] [--level marais-tiled:1300,<levels/ name>|none] [--skip-wasm] [--out reports/scale.md]
//!   cargo run --release -p sim-headless -- scenarios
//!   cargo run --release -p sim-headless -- match --level paris-marais --seed 1 [--retries 2] [--max-wave-s 1800]
//!        [--multiplier 0.3] [--fast-forward-to 8]   # level may also be marais-tiled:1300

mod bench;
mod charts;
mod common;
mod matchcmd;
mod report;
mod scale;
mod scenarios;

use std::time::Instant;

use common::*;
use sim_core::sim::PHASES;
use sim_core::Sim;

fn arg<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> T {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("help");
    match cmd {
        "run" => cmd_run(&args),
        "match" => matchcmd::cmd(&args),
        "bench" if args.iter().any(|a| a == "--scale") => cmd_scale(&args),
        "bench" => {
            let pop: u32 = arg(&args, "--pop", 100_000);
            let ticks: u32 = arg(&args, "--ticks", bench::BENCH_TICKS);
            let r = bench::run_native(pop, ticks);
            println!("{}", serde_json::to_string_pretty(&r.summary()).unwrap());
        }
        "fieldbench" => cmd_fieldbench(&args),
        "scenarios" => {
            let seeds: u32 = arg(&args, "--seeds", 5);
            let only: String = arg(&args, "--only", String::new());
            let res = scenarios::run_all(seeds, if only.is_empty() { None } else { Some(only.as_str()) });
            for s in &res {
                println!("{}", s.summary_line());
            }
        }
        "report" => report::run(&args),
        _ => {
            eprintln!("usage: sim-headless <report|run|match|bench|scenarios> [options]");
            std::process::exit(2);
        }
    }
}

fn list<T: std::str::FromStr>(args: &[String], name: &str, default: &[T]) -> Vec<T>
where
    T: Clone,
{
    let s: String = arg(args, name, String::new());
    if s.is_empty() {
        return default.to_vec();
    }
    s.split(',').filter_map(|v| v.trim().parse().ok()).collect()
}

fn cmd_scale(args: &[String]) {
    let o = scale::ScaleOpts {
        radii: list(args, "--radii", &scale::SCALE_RADII),
        pops: list(args, "--pops", &scale::SCALE_POPS),
        ticks: arg(args, "--ticks", scale::SCALE_TICKS),
        clusters: arg(args, "--clusters", scale::SCALE_CLUSTERS),
        wasm: !args.iter().any(|a| a == "--skip-wasm"),
        real_levels: list::<String>(args, "--level", &["marais-tiled:1300".to_string()]).into_iter().filter(|l| l != "none").collect(),
    };
    if o.wasm {
        let st = std::process::Command::new("wasm-pack")
            .current_dir(repo_root())
            .args(["build", "crates/sim-wasm", "--release", "--target", "nodejs", "--out-dir", "pkg-node"])
            .status();
        if !st.map_or(false, |s| s.success()) {
            eprintln!("[scale] wasm-pack build failed");
            std::process::exit(1);
        }
    }
    let runs = scale::run_all(&o);
    let md = scale::section_md(&runs, o.ticks, o.clusters);
    println!("{md}");
    let out: String = arg(args, "--out", String::new());
    if !out.is_empty() {
        let p = repo_root().join(&out);
        std::fs::write(&p, &md).unwrap();
        let summaries: Vec<scale::ScaleSummary> = runs.iter().map(|r| r.summary()).collect();
        std::fs::write(p.with_extension("json"), serde_json::to_string_pretty(&summaries).unwrap()).unwrap();
        eprintln!("[scale] wrote {}", p.display());
    }
}

/// Time full field recomputes on a wave-8-sized level in a late-game state
/// (most agents zombies, spread everywhere): the worst case for the fields.
fn cmd_fieldbench(args: &[String]) {
    let r: f32 = arg(args, "--radius", 1300.0);
    let pop: u32 = arg(args, "--pop", 100_000);
    let zshare: f32 = arg(args, "--zombies", 0.9);
    let reps: u32 = arg(args, "--reps", 10);
    let level = scale::scale_level(r);
    let mut sim = Sim::new(&level, load_config(), pop, 1);
    sim.start();
    let nz = (pop as f32 * zshare) as usize;
    for i in 0..nz {
        let (x, y) = (sim.x[i], sim.y[i]);
        sim.force_zombie(i, x, y);
    }
    let walk = sim.grid.walkable_count();
    let (mut tc, mut tt) = (Vec::new(), Vec::new());
    for _ in 0..reps {
        let t = Instant::now();
        sim.recompute_chase();
        tc.push(t.elapsed().as_secs_f64() * 1000.0);
        let t = Instant::now();
        sim.recompute_threat_and_flee();
        tt.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    tc.sort_by(|a, b| a.partial_cmp(b).unwrap());
    tt.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!("radius {r} m, {walk} walkable cells, {pop} agents, {nz} zombies: chase {:.2} ms, threat+flee {:.2} ms (median of {reps})", tc[tc.len() / 2], tt[tt.len() / 2]);
}

fn cmd_run(args: &[String]) {
    let level_name: String = arg(args, "--level", "paris-marais".to_string());
    let pop: u32 = arg(args, "--pop", 20_000);
    let seed: u64 = arg(args, "--seed", 1);
    let level = load_level(&level_name);
    let mut sim = Sim::new(&level, load_config(), pop, seed);
    sim.start();
    let mut clock = WallClock::new();
    let t0 = Instant::now();
    let mut worst = 0.0f64;
    let mut phase_tot = [0.0f64; 9];
    while sim.outcome().is_none() {
        sim.step_timed(&mut clock);
        let ms: f64 = sim.phase_ms.iter().sum();
        worst = worst.max(ms);
        for k in 0..9 {
            phase_tot[k] += sim.phase_ms[k];
        }
        if sim.tick % 200 == 0 {
            let s = &sim.stats;
            println!(
                "t={:>5.0}s civ={:>6} inf={:>4} zom={:>6} dead={:>5} dormant={:>5.1}% tick={:.2}ms",
                sim.tick as f32 / 20.0,
                s.civilians,
                s.infected,
                s.zombies,
                s.dead,
                100.0 * s.dormant as f32 / s.civilians.max(1) as f32,
                ms
            );
        }
    }
    println!("outcome={:?} after {} ticks, wall {:.1}s, worst tick {:.2}ms", sim.outcome().unwrap(), sim.tick, t0.elapsed().as_secs_f64(), worst);
    for k in 0..9 {
        println!("  {:<11} {:>7.3} ms/tick", PHASES[k], phase_tot[k] / sim.tick as f64);
    }
}
