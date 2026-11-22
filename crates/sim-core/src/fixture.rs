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

/// Play every playable prep card of the hand, in hand order: armaments on
/// the first revealed buildings without a garrison, fences as horizontal
/// lines north of the centre. A fixed script shared by native and WASM.
pub fn fixture_prep_plays(m: &mut crate::match_::Match) {
    use crate::cards::{Effect, TargetKind};
    use crate::match_::{Action, Target};
    let [cx, cy] = m.center();
    let mut row = 0.0f32;
    loop {
        let Some(c) = m.hand().into_iter().find(|c| c.playable) else { break };
        let target = match c.target {
            TargetKind::Buildings => {
                let max = match &m.cards().get(&c.card).expect("card").effect {
                    Effect::Garrison { buildings, .. } => *buildings as usize,
                    _ => 1,
                };
                let sim = m.sim();
                let bs: Vec<u32> = (0..sim.grid.buildings.len() as u32)
                    .filter(|&b| {
                        let info = &sim.grid.buildings[b as usize];
                        info.cell_count > 0 && m.wave_of_point(info.centroid[0], info.centroid[1]) <= m.wave() && !sim.towers.iter().any(|t| t.building == b)
                    })
                    .take(max)
                    .collect();
                Target::Buildings(bs)
            }
            TargetKind::Polyline => {
                row += 12.0;
                Target::Polyline(vec![[cx - 30.0, cy + 30.0 + row], [cx + 30.0, cy + 30.0 + row]])
            }
            TargetKind::Point => Target::Point([cx, cy]),
        };
        if m.apply(Action::PlayCard { hand_index: c.hand_index, target }).is_err() {
            break;
        }
    }
}

/// The match fixture: Paris Marais, default config and cards, starter deck,
/// seed 2026. Wave 1: every playable prep card (`fixture_prep_plays`), 300
/// ticks with the first tactical card in hand played at the centre on tick
/// 20, then the outbreak is cleared (test shortcut); wave 2: a mulligan,
/// the prep plays again, 200 ticks. Returns `Match::state_hash` at the end.
/// Must match native and WASM.
pub fn compute_match_fixture_hash(level: &LevelPack) -> u64 {
    use crate::match_::{Action, Match, MatchSetup, Phase, Target};
    use crate::sim::{INFECTED, ZOMBIE};
    let cfg = Config::default_config();
    let setup = MatchSetup::new(MATCH_FIXTURE_SEED, &cfg);
    let mut m = Match::new(level, cfg, setup).expect("match");
    fixture_prep_plays(&mut m);
    let _ = m.apply(Action::StartWave);
    for t in 0..300 {
        if t == 20 {
            let [cx, cy] = m.center();
            if let Some(c) = m.hand().into_iter().find(|c| c.playable) {
                let _ = m.apply(Action::PlayCard { hand_index: c.hand_index, target: Target::Point([cx, cy]) });
            }
        }
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
    let _ = m.apply(Action::Mulligan);
    fixture_prep_plays(&mut m);
    m.apply(Action::StartWave).expect("start wave 2");
    for _ in 0..200 {
        m.step();
    }
    assert_eq!((m.wave(), m.phase()), (2, Phase::Running));
    m.state_hash()
}

/// A break-heavy run: a 200 m city sealed by fences across every street
/// (`level::grid_city_disc_fenced`), weak fences (4 hp per cell), 6
/// outbreak clusters, 2k agents, 1200 ticks. Covers field jobs that finish
/// on the grid of their start tick while fences break under them. Returns
/// the state hash and the fence cells broken. Must match native and WASM.
pub fn compute_fence_fixture_hash() -> (u64, u32) {
    let level = crate::level::grid_city_disc_fenced(200.0, 40.0, 14.0, 7);
    let mut cfg = Config::default_config();
    cfg.fence_cell_hp = 4.0;
    cfg.outbreak_clusters = 6;
    let mut sim = Sim::new(&level, cfg, 2_000, FIXTURE_SEED);
    sim.start();
    while sim.tick < 1200 && sim.outcome().is_none() {
        sim.step();
    }
    (sim.state_hash(), sim.stats.fence_cells_broken)
}
