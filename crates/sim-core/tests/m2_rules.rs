//! M2: infection delay, infected immunity, Dijkstra correctness, determinism.
mod common;
use sim_core::field::{brute_force, Dial, Mode};
use sim_core::grid::{Grid, WALK};
use sim_core::level::{self, Building, BuildingKind, LevelPack};
use sim_core::rng::Pcg32;
use sim_core::sim::{CIVILIAN, INFECTED, ZOMBIE};
use sim_core::Sim;

#[test]
fn infection_delay_is_exactly_20_ticks() {
    let mut sim = Sim::new(&level::open_field(60.0), common::cfg(), 3, 5);
    sim.x[1] = 30.5;
    sim.y[1] = 30.0;
    // A distant bystander so the game doesn't end (Loss) at the bite.
    sim.x[2] = 3.0;
    sim.y[2] = 3.0;
    sim.force_zombie(0, 30.0, 30.0);
    sim.start_without_outbreak();
    let mut bitten_at = None;
    let mut turned_at = None;
    for _ in 0..100 {
        let t = sim.tick;
        sim.step();
        match (sim.state[1], bitten_at, turned_at) {
            (INFECTED, None, _) => bitten_at = Some(t),
            (ZOMBIE, Some(_), None) => turned_at = Some(t),
            _ => {}
        }
        if let (Some(b), None) = (bitten_at, turned_at) {
            if t == b + 19 {
                assert_eq!(sim.state[1], INFECTED, "still infected at t + 19");
            }
        }
        if turned_at.is_some() {
            break;
        }
    }
    let (b, z) = (bitten_at.expect("bitten"), turned_at.expect("turned"));
    assert_eq!(z - b, 20, "bitten at {b}, zombie at {z}");
}

#[test]
fn infected_are_never_bitten_again() {
    let mut sim = Sim::new(&level::open_field(60.0), common::cfg(), 6, 5);
    // One infected surrounded by four zombies that are all off cooldown.
    sim.x[5] = 30.0;
    sim.y[5] = 30.0;
    sim.force_infected(5);
    for (k, (dx, dy)) in [(0.3, 0.0), (-0.3, 0.0), (0.0, 0.3), (0.0, -0.3)].into_iter().enumerate() {
        sim.force_zombie(k, 30.0 + dx, 30.0 + dy);
    }
    // A far-away civilian keeps the game running.
    sim.x[4] = 5.0;
    sim.y[4] = 5.0;
    sim.start_without_outbreak();
    for _ in 0..15 {
        sim.step();
        assert_eq!(sim.state[5], INFECTED);
    }
    assert_eq!(sim.stats.bites, 0);
}

#[test]
fn infected_are_never_targeted_by_towers() {
    let lvl = level::grid_city(3, 20.0, 12.0, 1);
    let mut sim = Sim::new(&lvl, common::cfg(), 3, 5);
    sim.place_tower(4).unwrap(); // centre building
    let [cx, cy] = sim.grid.buildings[4].centroid;
    // Infected 15 m from the tower; nothing else in range.
    let (ix, iy) = walkable_near(&sim, cx + 15.0, cy, 4.0);
    sim.x[0] = ix;
    sim.y[0] = iy;
    sim.force_infected(0);
    sim.x[1] = 2.5;
    sim.y[1] = 2.5;
    let hp_before = sim.hp[0];
    sim.start_without_outbreak();
    for _ in 0..15 {
        sim.step();
    }
    assert_eq!(sim.towers[0].shots, 0);
    assert_eq!(sim.hp[0], hp_before);
}

pub fn walkable_near(sim: &Sim, x: f32, y: f32, r: f32) -> (f32, f32) {
    let mut best = None;
    for i in 0..sim.grid.kind.len() {
        if sim.grid.kind[i] != WALK {
            continue;
        }
        let [px, py] = sim.grid.cell_center(i);
        let d = ((px - x).powi(2) + (py - y).powi(2)).sqrt();
        if d <= r && best.map_or(true, |(bd, _, _)| d < bd) {
            best = Some((d, px, py));
        }
    }
    let (_, px, py) = best.expect("a walkable cell nearby");
    (px, py)
}

fn random_blocks_level(seed: u64) -> LevelPack {
    let mut rng = Pcg32::new(seed, 9);
    let mut buildings = Vec::new();
    for id in 0..25 {
        let x = rng.f32() * 50.0;
        let y = rng.f32() * 50.0;
        let w = 2.0 + rng.f32() * 8.0;
        let h = 2.0 + rng.f32() * 8.0;
        buildings.push(Building {
            id,
            kind: BuildingKind::Other,
            floors: 1.0,
            polygon: vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
        });
    }
    // Some fences for the chase mode.
    let fences = vec![vec![[5.0, 25.0], [45.0, 30.0]], vec![[25.0, 3.0], [27.0, 47.0]]];
    LevelPack { name: "random".into(), center_lat: 0.0, center_lon: 0.0, radius_m: None, buildings, fences, bounds: Some([0.0, 0.0, 60.0, 60.0]) }
}

#[test]
fn dijkstra_bucket_queue_matches_brute_force() {
    let cfg = common::cfg();
    for seed in 0..6u64 {
        let lvl = match seed {
            0 => level::walled_compound(),
            1 => level::grid_city(3, 10.0, 6.0, 2),
            _ => random_blocks_level(seed),
        };
        let g = Grid::from_level(&lvl, &cfg);
        let mut rng = Pcg32::new(seed, 1);
        let walk: Vec<u32> = (0..g.kind.len()).filter(|&i| g.kind[i] == WALK).map(|i| i as u32).collect();
        for mode in [Mode::Chase, Mode::Flee] {
            // Zero-valued sources (chase/threat) and arbitrary sorted values (flee pass).
            for valued in [false, true] {
                let mut seeds: Vec<(u32, i32)> = (0..8)
                    .map(|_| (walk[rng.below(walk.len() as u32) as usize], if valued { rng.below(300) as i32 } else { 0 }))
                    .collect();
                seeds.sort_by_key(|&(c, v)| (v, c));
                let fence = if mode == Mode::Chase { cfg.fence_path_cost } else { 0 };
                let mut dial = Dial::new(cfg.fence_path_cost);
                let mut dist = vec![0; g.kind.len()];
                dial.run(&g, mode, fence, &mut dist, seeds.iter().copied(), true);
                let reference = brute_force(&g, mode, fence, &seeds);
                assert_eq!(dist, reference, "seed {seed} mode {mode:?} valued {valued}");
                // Finalization order is non-decreasing.
                assert!(dial.order.windows(2).all(|w| dist[w[0] as usize] <= dist[w[1] as usize]));
            }
        }
    }
}

fn run_hashes(seed: u64, ticks: &[u32]) -> Vec<u64> {
    let lvl = common::level("paris-marais");
    let mut sim = Sim::new(&lvl, common::cfg(), 5_000, seed);
    sim.start();
    let mut out = Vec::new();
    let last = *ticks.iter().max().unwrap();
    while sim.tick < last {
        sim.step();
        if ticks.contains(&sim.tick) {
            out.push(sim.state_hash());
        }
    }
    out
}

#[test]
fn determinism_same_seed_same_hash() {
    let a = run_hashes(42, &[100, 1000]);
    let b = run_hashes(42, &[100, 1000]);
    let c = run_hashes(43, &[100, 1000]);
    assert_eq!(a.len(), 2);
    assert_eq!(a, b, "same seed must give the same hash");
    assert_ne!(a[0], c[0], "different seed must give a different hash at tick 100");
    assert_ne!(a[1], c[1], "different seed must give a different hash at tick 1000");
}

#[test]
fn outbreak_seeds_clusters() {
    let lvl = common::level("paris-marais");
    let mut sim = Sim::new(&lvl, common::cfg(), 20_000, 3);
    sim.start();
    assert!(sim.stats.zombies >= 15, "3 clusters of at least 5");
    assert_eq!(sim.stats.civilians + sim.stats.zombies, 20_000);
    assert!(sim.state.iter().all(|&s| s == CIVILIAN || s == ZOMBIE));
}

#[test]
fn native_hash_fixture() {
    let path = format!("{}/tests/fixtures/native_hash.json", env!("CARGO_MANIFEST_DIR"));
    let got = sim_core::fixture::compute_fixture_hash(&common::level("paris-marais"));
    if std::env::var("UPDATE_FIXTURES").is_ok() {
        std::fs::create_dir_all(format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"))).unwrap();
        std::fs::write(&path, format!("{{\"hash\": \"{got:016x}\"}}\n")).unwrap();
    }
    let s = std::fs::read_to_string(&path).expect("fixture missing: run with UPDATE_FIXTURES=1");
    assert!(s.contains(&format!("{got:016x}")), "native hash {got:016x} differs from fixture {s}");
}
