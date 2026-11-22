//! T1 scale optimisations: field jobs spread over several ticks (with a
//! budget), threat cut at the flee cap, flee computed only in the threat zone
//! and step masks must give exactly the same game as computing every job in
//! full the moment it starts (`eager_fields`, with the reference flee seeding).

mod common;

use sim_core::field::{self, Dial, Mode, INF};
use sim_core::grid::{Grid, FENCE, WALK};
use sim_core::level::{self, COMPOUND_CENTER, COMPOUND_HALF};
use sim_core::rng::Pcg32;
use sim_core::{LevelPack, Sim};

/// Step a lazy sim and an eager reference side by side; compare the state
/// hash every tick and the fields regularly.
fn lockstep(mut lazy: Sim, mut eager: Sim, ticks: u32) -> (u32, u32) {
    eager.eager_fields = true;
    let mut t = 0;
    while t < ticks && lazy.outcome().is_none() {
        lazy.step();
        eager.step();
        t += 1;
        assert_eq!(lazy.state_hash(), eager.state_hash(), "hash differs at tick {}", lazy.tick);
        // The flee field is always computed in full: it must be identical.
        // Threat must match wherever it is read exactly (below the cap).
        if t % 7 == 0 {
            assert_eq!(lazy.flee, eager.flee, "flee differs at tick {}", lazy.tick);
            let cap = (lazy.cfg.flee_threat_cap_m * lazy.cfg.cost_per_m()) as i32;
            for c in 0..lazy.threat.len() {
                let (a, b) = (lazy.threat[c], eager.threat[c]);
                assert!(a == b || (a >= cap && b >= cap), "threat differs at cell {c}, tick {}", lazy.tick);
            }
        }
        if t % 5 == 0 {
            assert_eq!(lazy.chase, eager.chase, "chase differs at tick {}", lazy.tick);
        }
    }
    assert_eq!(lazy.outcome(), eager.outcome());
    (t, lazy.stats.fence_cells_broken)
}

fn pair(level: &LevelPack, pop: u32, seed: u64, setup: impl Fn(&mut Sim)) -> (Sim, Sim) {
    let mut a = Sim::new(level, common::cfg(), pop, seed);
    let mut b = Sim::new(level, common::cfg(), pop, seed);
    b.eager_fields = true;
    setup(&mut a);
    setup(&mut b);
    a.start();
    b.start();
    (a, b)
}

#[test]
fn lazy_fields_match_eager_on_paris_with_defenses() {
    let lvl = common::level("paris-marais");
    let (a, b) = pair(&lvl, 8_000, 11, |s| {
        for t in [0, 5, 17, 40] {
            let _ = s.place_tower(t);
        }
        let [cx, cy] = s.to_sim(0.0, 0.0);
        let _ = s.place_fence(&[[cx - 60.0, cy - 20.0], [cx + 60.0, cy - 20.0]]);
        let _ = s.place_fence(&[[cx + 20.0, cy - 80.0], [cx + 20.0, cy + 80.0]]);
    });
    let (t, _) = lockstep(a, b, 1500);
    assert!(t > 300);
}

#[test]
fn lazy_fields_match_eager_on_grid_city_disc() {
    let lvl = level::grid_city_disc(350.0, 40.0, 14.0, 7);
    let (a, b) = pair(&lvl, 12_000, 4, |_| {});
    lockstep(a, b, 2500);
}

#[test]
fn lazy_fields_match_eager_through_fence_breaks() {
    // Zombies outside the compound chew through the fence ring.
    let lvl = level::walled_compound();
    let mk = || {
        let mut s = Sim::new(&lvl, common::cfg(), 160, 9);
        let [cx, cy] = s.to_sim(COMPOUND_CENTER[0], COMPOUND_CENTER[1]);
        for i in 0..60 {
            s.x[i] = cx - 15.0 + (i % 10) as f32 * 3.0 + 0.3;
            s.y[i] = cy - 15.0 + (i / 10) as f32 * 5.0 + 0.3;
        }
        for k in 0..100 {
            s.force_zombie(60 + k, cx + COMPOUND_HALF + 12.0 + (k % 10) as f32, cy - 5.0 + (k / 10) as f32);
        }
        s.start_without_outbreak();
        s
    };
    let (a, mut b) = (mk(), mk());
    b.eager_fields = true;
    let (_, broken) = lockstep(a, b, 3000);
    assert!(broken > 0, "no fence broke, the test doesn't cover fence breaks");
}

#[test]
fn lazy_settle_gives_the_full_field() {
    // Settling single cells in any order, then finishing, equals one full run.
    let lvl = level::grid_city(5, 24.0, 10.0, 3);
    let mut cfg = common::cfg();
    cfg.fence_path_cost = 400;
    let mut g = Grid::from_level(&lvl, &cfg);
    // A few fences so the chase mode pays the fence cost somewhere.
    for c in (0..g.kind.len()).step_by(37) {
        if g.kind[c] == WALK {
            g.set_kind(c, FENCE);
        }
    }
    let walk: Vec<usize> = (0..g.kind.len()).filter(|&i| g.kind[i] == WALK).collect();
    let mut rng = Pcg32::new(5, 1);
    for mode in [Mode::Chase, Mode::Flee] {
        let fence = if mode == Mode::Chase { cfg.fence_path_cost } else { 0 };
        let mut seeds: Vec<(u32, i32)> = (0..6).map(|_| (walk[rng.below(walk.len() as u32) as usize] as u32, rng.below(50) as i32)).collect();
        seeds.sort_by_key(|&(c, v)| (v, c));
        let reference = field::brute_force(&g, mode, fence, &seeds);
        let mut d = Dial::new(cfg.fence_path_cost);
        let mut dist = vec![INF; g.kind.len()];
        d.seeds.extend(seeds.iter().copied());
        d.begin(mode, fence, false);
        for _ in 0..40 {
            let c = walk[rng.below(walk.len() as u32) as usize];
            d.settle(&g, &mut dist, c);
            assert_eq!(dist[c], reference[c], "settled cell {c} in {mode:?}");
            // Everything at or below the settled value is final already.
            for i in 0..dist.len() {
                if dist[i] <= d.settled {
                    assert_eq!(dist[i], reference[i]);
                } else {
                    assert!(dist[i] >= reference[i]);
                }
            }
        }
        d.advance(&g, &mut dist, i32::MAX);
        assert!(d.finished());
        assert_eq!(dist, reference, "{mode:?}");
    }
}

#[test]
fn step_masks_follow_kind_changes() {
    let lvl = common::level("paris-marais");
    let cfg = common::cfg();
    let mut g = Grid::from_level(&lvl, &cfg);
    let mut rng = Pcg32::new(1, 2);
    for _ in 0..500 {
        let c = rng.below(g.kind.len() as u32) as usize;
        let k = [WALK, FENCE][rng.below(2) as usize];
        if g.kind[c] == WALK || g.kind[c] == FENCE {
            g.set_kind(c, k);
        }
    }
    let (sc, sf) = (g.step_chase.clone(), g.step_flee.clone());
    g.rebuild_step_masks();
    assert_eq!(sc, g.step_chase);
    assert_eq!(sf, g.step_flee);
    let off = field::offsets(g.w);
    for c in (g.w + 1..g.kind.len() - g.w - 1).step_by(13) {
        if c % g.w == 0 || c % g.w == g.w - 1 {
            continue;
        }
        for d in 0..8 {
            assert_eq!((g.step_chase[c] >> d) & 1 != 0, field::step_allowed(&g.kind, c, d, &off, Mode::Chase));
            assert_eq!((g.step_flee[c] >> d) & 1 != 0, field::step_allowed(&g.kind, c, d, &off, Mode::Flee));
        }
    }
}
