//! Tick-time benchmarks: Paris Marais, no defense, fixed seed, 3,000 ticks.

use serde::{Deserialize, Serialize};
use sim_core::sim::PHASES;
use sim_core::Sim;

use crate::common::*;

pub const BENCH_TICKS: u32 = 3000;
pub const BENCH_SEED: u64 = 1;
pub const BENCH_POPS: [u32; 3] = [10_000, 50_000, 100_000];
pub const BENCH_LEVEL: &str = "paris-marais";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BenchRun {
    pub runtime: String,
    pub population: u32,
    pub ticks: u32,
    /// Total ms per tick.
    pub tick_ms: Vec<f64>,
    /// Per-phase ms per tick, in `PHASES` order.
    pub phase_ms: Vec<Vec<f64>>,
    /// Share of civilians that were dormant, per tick.
    pub dormant_share: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BenchSummary {
    pub runtime: String,
    pub population: u32,
    pub ticks: u32,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
    pub mean: f64,
    pub dormant_mean: f64,
    pub phase_mean: Vec<(String, f64)>,
}

impl BenchRun {
    pub fn summary(&self) -> BenchSummary {
        let mut s = self.tick_ms.clone();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = s.len().max(1) as f64;
        BenchSummary {
            runtime: self.runtime.clone(),
            population: self.population,
            ticks: self.ticks,
            p50: percentile(&s, 50.0),
            p95: percentile(&s, 95.0),
            p99: percentile(&s, 99.0),
            max: s.last().copied().unwrap_or(0.0),
            mean: s.iter().sum::<f64>() / n,
            dormant_mean: self.dormant_share.iter().sum::<f64>() / self.dormant_share.len().max(1) as f64,
            phase_mean: (0..PHASES.len())
                .map(|k| (PHASES[k].to_string(), self.phase_ms.iter().map(|p| p[k]).sum::<f64>() / self.phase_ms.len().max(1) as f64))
                .collect(),
        }
    }
}

pub fn run_native(population: u32, ticks: u32) -> BenchRun {
    let level = load_level(BENCH_LEVEL);
    let mut sim = Sim::new(&level, load_config(), population, BENCH_SEED);
    sim.start();
    let mut clock = WallClock::new();
    let mut run = BenchRun {
        runtime: "native".into(),
        population,
        ticks,
        tick_ms: Vec::with_capacity(ticks as usize),
        phase_ms: Vec::with_capacity(ticks as usize),
        dormant_share: Vec::with_capacity(ticks as usize),
    };
    for _ in 0..ticks {
        if sim.outcome().is_some() {
            break;
        }
        sim.step_timed(&mut clock);
        run.tick_ms.push(sim.phase_ms.iter().sum());
        run.phase_ms.push(sim.phase_ms.to_vec());
        run.dormant_share.push(sim.stats.dormant as f64 / sim.stats.civilians.max(1) as f64);
    }
    run
}
