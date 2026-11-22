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
            // Exact up to the flee cap and the wake radius, whichever is larger.
            let cap = (lazy.cfg.flee_threat_cap_m * lazy.cfg.cost_per_m()) as i32;
            let wake = (lazy.cfg.wake_radius_m * lazy.cfg.cost_per_m()) as i32;
            let limit = (cap - 1).max(wake);
            for c in 0..lazy.threat.len() {
                let (a, b) = (lazy.threat[c], eager.threat[c]);
                assert!(a == b || (a > limit && b > limit), "threat differs at cell {c}, tick {}", lazy.tick);
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
    pair_cfg(level, common::cfg(), pop, seed, setup)
}

fn pair_cfg(level: &LevelPack, cfg: sim_core::Config, pop: u32, seed: u64, setup: impl Fn(&mut Sim)) -> (Sim, Sim) {
    let mut a = Sim::new(level, cfg.clone(), pop, seed);
    let mut b = Sim::new(level, cfg, pop, seed);
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
fn lazy_fields_match_eager_with_wake_radius_beyond_the_flee_cap() {
    // Dormancy reads threat up to the wake radius: the lazy threat job must
    // not stop at the flee cap when the wake radius is larger.
    let lvl = level::grid_city_disc(350.0, 40.0, 14.0, 7);
    let mut cfg = common::cfg();
    cfg.wake_radius_m = 250.0;
    assert!(cfg.wake_radius_m > cfg.flee_threat_cap_m);
    let (a, b) = pair_cfg(&lvl, cfg.clone(), 12_000, 4, |_| {});
    let (t, _) = lockstep(a, b, 600);
    assert!(t > 100);
    // A smaller cap and a shorter field interval, same rule.
    cfg.flee_threat_cap_m = 120.0;
    cfg.wake_radius_m = 150.0;
    cfg.field_interval_ticks = 3;
    let (a, b) = pair_cfg(&lvl, cfg, 12_000, 5, |_| {});
    lockstep(a, b, 600);
}

/// Zombies outside the walled compound chew through the fence ring.
fn compound_sim(cfg: sim_core::Config) -> Sim {
    let lvl = level::walled_compound();
    let mut s = Sim::new(&lvl, cfg, 160, 9);
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
}

/// Weaker fences than the default: many more breaks in a short run.
fn weak_fences() -> sim_core::Config {
    let mut cfg = common::cfg();
    cfg.fence_cell_hp = 20.0;
    cfg
}

#[test]
fn lazy_fields_match_eager_through_fence_breaks() {
    for cfg in [common::cfg(), weak_fences()] {
        let (a, mut b) = (compound_sim(cfg.clone()), compound_sim(cfg));
        b.eager_fields = true;
        let (_, broken) = lockstep(a, b, 3000);
        assert!(broken > 0, "no fence broke, the test doesn't cover fence breaks");
    }
}

/// The fence-break rule: a field job reads the grid of its start tick. The
/// chase field published at tick t + interval is exactly a one-shot
/// Dijkstra from the civilians at the start of tick t over the grid at the
/// start of tick t, whatever broke in between; the same for threat (below
/// its read limit) from the zombies. Steering uses the live grid: no agent
/// ever stands on an intact fence cell.
/// A small city sealed by fences across every street, weak fences and an
/// outbreak: fences break all game long.
fn fenced_city(pop: u32, seed: u64) -> Sim {
    let lvl = level::grid_city_disc_fenced(200.0, 40.0, 14.0, 7);
    let mut cfg = common::cfg();
    cfg.fence_cell_hp = 4.0;
    cfg.outbreak_clusters = 6;
    let mut s = Sim::new(&lvl, cfg, pop, seed);
    s.start();
    s
}

#[test]
fn field_jobs_read_the_grid_of_their_start_tick() {
    let mut s = fenced_city(3_000, 3);
    let iv = s.cfg.field_interval_ticks;
    let fc = s.cfg.fence_path_cost;
    let cap = (s.cfg.flee_threat_cap_m * s.cfg.cost_per_m()) as i32;
    let limit = (cap - 1).max((s.cfg.wake_radius_m * s.cfg.cost_per_m()) as i32);
    let cells_of = |s: &Sim, st: u8| -> Vec<(u32, i32)> {
        let mut v: Vec<(u32, i32)> = (0..s.n).filter(|&i| s.state[i] == st).map(|i| (s.grid.cell_of(s.x[i], s.y[i]) as u32, 0)).collect();
        v.sort();
        v
    };
    // (start tick, grid, seeds, fence cells broken at start) per job kind.
    let mut chase_job: Option<(u32, Grid, Vec<(u32, i32)>, u32)> = None;
    let mut threat_job: Option<(u32, Grid, Vec<(u32, i32)>, u32)> = None;
    let (mut checked, mut changed_under) = ([0u32; 2], [0u32; 2]);
    let mut dial = Dial::new(fc);
    let mut dist = Vec::new();
    while s.tick < 1500 && s.outcome().is_none() {
        let t = s.tick;
        let broken = s.stats.fence_cells_broken;
        let start_chase = t % iv == 0 && t > 0;
        let start_threat = t % iv == iv / 2;
        let chase_rec = start_chase.then(|| (t, s.grid.clone(), cells_of(&s, sim_core::sim::CIVILIAN), broken));
        let threat_rec = start_threat.then(|| (t, s.grid.clone(), cells_of(&s, sim_core::sim::ZOMBIE), broken));
        s.step();
        for (k, start, rec, job) in [(0, start_chase, chase_rec, &mut chase_job), (1, start_threat, threat_rec, &mut threat_job)] {
            if !start {
                continue;
            }
            // This tick published the job started one interval ago.
            if let Some((t0, g, seeds, b0)) = job.take() {
                assert_eq!(t0 + iv, t);
                dist.resize(g.kind.len(), INF);
                dial.run(&g, Mode::Chase, fc, &mut dist, seeds.iter().copied(), false);
                let field = if k == 0 { &s.chase } else { &s.threat };
                for c in 0..dist.len() {
                    let (a, b) = (field[c], dist[c]);
                    assert!(a == b || (k == 1 && a > limit && b > limit), "field {k} differs at cell {c} for the job started at tick {t0}");
                }
                checked[k] += 1;
                // Fences broke while the job ran (the grid changed under it).
                if s.stats.fence_cells_broken > b0 && g.kind != s.grid.kind {
                    changed_under[k] += 1;
                }
            }
            *job = rec;
        }
        for i in 0..s.n {
            if s.state[i] != sim_core::sim::DEAD && s.state[i] != sim_core::sim::ABSENT {
                let c = s.grid.cell_of(s.x[i], s.y[i]);
                assert_ne!(s.grid.kind[c], FENCE, "agent {i} on an intact fence cell at tick {}", s.tick);
            }
        }
    }
    assert!(s.stats.fence_cells_broken > 50, "only {} fence cells broke", s.stats.fence_cells_broken);
    assert!(checked[0] > 50 && checked[1] > 50, "{checked:?}");
    assert!(changed_under[0] > 10 && changed_under[1] > 10, "few jobs saw the grid change under them: {changed_under:?}");
}

/// Budgets never change results: tiny ones (a pause after every bucket),
/// crawling ones (the flee seed scan a few cells per tick) and erratic ones
/// (0, 1, small, large, from tick to tick) give the same game as the
/// default budget and as the eager reference, through fence breaks.
#[test]
fn field_budgets_never_change_results() {
    type Budget = fn(u32, usize, usize) -> usize;
    fn tiny(_: u32, _: usize, _: usize) -> usize {
        1
    }
    fn crawl(t: u32, job: usize, b: usize) -> usize {
        // The threat stage gets its usual budget on its first two ticks,
        // then everything crawls.
        if job == 1 && t % 5 < 4 && t % 5 >= 2 {
            b
        } else {
            1
        }
    }
    fn varied(t: u32, job: usize, b: usize) -> usize {
        let h = (t.wrapping_mul(0x9e37_79b9) ^ (job as u32).wrapping_mul(0x85eb_ca6b)) >> 13;
        match h % 6 {
            0 => 0,
            1 => 1,
            2 => (h % 97) as usize + 2,
            3 => b / 7 + 1,
            4 => b * 3,
            _ => b,
        }
    }
    // Stages that must have paused part-way: chase, threat, flee scan, flee.
    let cases: [(Budget, &str, [bool; 4]); 3] = [(tiny, "tiny", [true, true, false, false]), (crawl, "crawl", [true, false, true, false]), (varied, "varied", [true; 4])];
    for (f, name, need) in cases {
        let mut a = fenced_city(2_000, 5);
        a.test_budget = Some(f);
        let (t, broken, pauses) = lockstep_three(a, fenced_city(2_000, 5), fenced_city(2_000, 5), 1200);
        eprintln!("{name}: {t} ticks, {broken} fence cells broken, pauses {pauses:?}");
        assert!(broken > 20, "{name}: only {broken} fence cells broke");
        for k in 0..4 {
            assert!(!need[k] || pauses[k] > 0, "{name}: stage {k} never paused: {pauses:?}");
        }
    }
}

/// `lockstep` against the eager reference, plus the same game at the
/// default budget. Returns ticks run, fence cells broken and `lazy`'s pauses.
fn lockstep_three(lazy: Sim, base: Sim, eager: Sim, ticks: u32) -> (u32, u32, [u32; 4]) {
    let mut base = base;
    let mut lazy = lazy;
    let mut eager = eager;
    eager.eager_fields = true;
    let mut t = 0;
    while t < ticks && lazy.outcome().is_none() {
        lazy.step();
        base.step();
        eager.step();
        t += 1;
        let h = lazy.state_hash();
        assert_eq!(h, base.state_hash(), "budget changed the hash at tick {}", lazy.tick);
        assert_eq!(h, eager.state_hash(), "hash differs from the eager reference at tick {}", lazy.tick);
        if t % 5 == 0 {
            assert_eq!(lazy.chase, base.chase);
            assert_eq!(lazy.flee, base.flee);
            assert_eq!(lazy.flee, eager.flee);
            assert_eq!(lazy.chase, eager.chase);
        }
    }
    assert_eq!(lazy.outcome(), eager.outcome());
    (t, lazy.stats.fence_cells_broken, lazy.job_pauses)
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

/// Golden hash of the break-heavy fixture (also checked in WASM under Node).
#[test]
fn fence_break_hash_fixture() {
    let path = format!("{}/tests/fixtures/fence_break_hash.json", env!("CARGO_MANIFEST_DIR"));
    let (got, broken) = sim_core::fixture::compute_fence_fixture_hash();
    assert!(broken > 25, "the fixture must break fences ({broken})");
    if std::env::var("UPDATE_FIXTURES").is_ok() {
        std::fs::write(&path, format!("{{\"hash\": \"{got:016x}\"}}\n")).unwrap();
    }
    let s = std::fs::read_to_string(&path).expect("fixture missing: run with UPDATE_FIXTURES=1");
    assert!(s.contains(&format!("{got:016x}")), "native hash {got:016x} differs from fixture {s}");
}
