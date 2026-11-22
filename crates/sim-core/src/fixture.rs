//! The fixed run whose hash must match between native and WASM.

use crate::{Config, LevelPack, Sim};

pub const FIXTURE_POPULATION: u32 = 5_000;
pub const FIXTURE_SEED: u64 = 2026;
pub const FIXTURE_TICKS: u32 = 400;

/// Paris Marais, 5k agents, seed 2026, one garrison and one fence, 400 ticks.
pub fn compute_fixture_hash(level: &LevelPack) -> u64 {
    let mut sim = Sim::new(level, Config::default_config(), FIXTURE_POPULATION, FIXTURE_SEED);
    let _ = sim.place_tower(0);
    let [cx, cy] = sim.to_sim(0.0, 0.0);
    let _ = sim.place_fence(&[[cx - 30.0, cy + 40.0], [cx + 30.0, cy + 40.0]]);
    sim.start();
    while sim.tick < FIXTURE_TICKS && sim.outcome().is_none() {
        sim.step();
    }
    sim.state_hash()
}
