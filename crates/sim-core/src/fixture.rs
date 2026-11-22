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

pub const MATCH_FIXTURE_SEED: u64 = 2026;

/// The match fixture: Paris Marais, default config, seed 2026. Wave 1 with
/// the three first revealed buildings garrisoned and one fence, 300 ticks,
/// then the outbreak is cleared (test shortcut) and wave 2 runs 200 ticks.
/// Returns `Match::state_hash` at the end. Must match native and WASM.
pub fn compute_match_fixture_hash(level: &LevelPack) -> u64 {
    use crate::match_::{Action, Match, MatchSetup, Phase};
    use crate::sim::{INFECTED, ZOMBIE};
    let cfg = Config::default_config();
    let setup = MatchSetup::new(MATCH_FIXTURE_SEED, &cfg);
    let mut m = Match::new(level, cfg, setup).expect("match");
    let picks: Vec<u32> = (0..m.sim().grid.buildings.len() as u32)
        .filter(|&b| {
            let c = m.sim().grid.buildings[b as usize].centroid;
            m.sim().grid.buildings[b as usize].cell_count > 0 && m.wave_of_point(c[0], c[1]) == 1
        })
        .take(3)
        .collect();
    for b in picks {
        let _ = m.apply(Action::PlaceTower { building: b });
    }
    let [cx, cy] = m.center();
    let _ = m.apply(Action::PlaceFence { points: vec![[cx - 30.0, cy + 40.0], [cx + 30.0, cy + 40.0]] });
    let _ = m.apply(Action::StartWave);
    for _ in 0..300 {
        m.step();
    }
    let sim = m.debug_sim_mut();
    for i in 0..sim.n {
        if sim.state[i] == ZOMBIE || sim.state[i] == INFECTED {
            sim.force_kill(i);
        }
    }
    m.step();
    assert_eq!(m.phase(), Phase::WaveWon, "match fixture: wave 1 must be won");
    m.apply(Action::NextWave).expect("next wave");
    m.apply(Action::StartWave).expect("start wave 2");
    for _ in 0..200 {
        m.step();
    }
    assert_eq!((m.wave(), m.phase()), (2, Phase::Running));
    m.state_hash()
}
