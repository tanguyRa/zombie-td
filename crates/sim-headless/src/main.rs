//! Headless runner: scenarios, benchmarks and the report.
//!
//!   cargo run --release -p sim-headless -- report      # everything, writes reports/
//!   cargo run --release -p sim-headless -- run --level paris-marais --pop 20000 --seed 1
//!   cargo run --release -p sim-headless -- bench --pop 100000
//!   cargo run --release -p sim-headless -- scenarios

mod bench;
mod charts;
mod common;
mod report;
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
        "bench" => {
            let pop: u32 = arg(&args, "--pop", 100_000);
            let ticks: u32 = arg(&args, "--ticks", bench::BENCH_TICKS);
            let r = bench::run_native(pop, ticks);
            println!("{}", serde_json::to_string_pretty(&r.summary()).unwrap());
        }
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
            eprintln!("usage: sim-headless <report|run|bench|scenarios> [options]");
            std::process::exit(2);
        }
    }
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
