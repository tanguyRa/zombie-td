//! M1: population and wall safety on the real levels.
mod common;
use sim_core::grid::WALK;
use sim_core::sim::DEAD;
use sim_core::Sim;

fn assert_all_walkable(sim: &Sim, when: &str) {
    for i in 0..sim.n {
        if sim.state[i] == DEAD {
            continue;
        }
        let (x, y) = (sim.x[i], sim.y[i]);
        assert!(x >= 0.0 && y >= 0.0, "{when}: agent {i} at negative position");
        let c = sim.grid.cell_of(x, y);
        assert_eq!(sim.grid.kind[c], WALK, "{when}: agent {i} on a non-walkable cell at ({x}, {y})");
    }
}

#[test]
fn population_exact_and_on_walkable_cells() {
    for name in ["paris-marais", "suburb"] {
        let level = common::level(name);
        for pop in [20_000u32, 10_007, 1] {
            let sim = Sim::new(&level, common::cfg(), pop, 1);
            assert_eq!(sim.n as u32, pop, "{name}");
            assert_eq!(sim.stats.civilians, pop, "{name}");
            assert_all_walkable(&sim, &format!("{name} spawn {pop}"));
        }
    }
}

#[test]
fn population_follows_building_size() {
    // Per-building counts are the largest-remainder rounding of
    // area × floors × density, scaled to the target.
    for (level, pop) in [(sim_core::level::grid_city(4, 20.0, 10.0, 3), 10_000u32), (common::level("paris-marais"), 20_000)] {
        let sim = Sim::new(&level, common::cfg(), pop, 3);
        let total_w: f64 = sim.spawn_weights.iter().sum();
        let total: u32 = sim.spawn_counts.iter().sum();
        assert_eq!(total, pop);
        for (b, &c) in sim.spawn_counts.iter().enumerate() {
            let quota = sim.spawn_weights[b] / total_w * pop as f64;
            assert!((c as f64 - quota).abs() < 1.0, "building {b}: {c} vs quota {quota}");
        }
        assert_all_walkable(&sim, "spawn");
    }
}

#[test]
fn wall_safety_2000_ticks_real_levels() {
    for name in ["paris-marais", "suburb"] {
        let level = common::level(name);
        let mut sim = Sim::new(&level, common::cfg(), 20_000, 11);
        sim.start();
        for t in 0..2000 {
            sim.step();
            assert_all_walkable(&sim, &format!("{name} tick {t}"));
            if sim.outcome().is_some() {
                break;
            }
        }
    }
}

#[test]
fn synthetic_levels_rasterize() {
    let cfg = common::cfg();
    let g = sim_core::grid::Grid::from_level(&sim_core::level::open_field(100.0), &cfg);
    assert!(g.walkable_count() > 2000);
    let g = sim_core::grid::Grid::from_level(&sim_core::level::walled_compound(), &cfg);
    let fences = g.kind.iter().filter(|&&k| k == sim_core::grid::FENCE).count();
    assert_eq!(fences, 4 * 21, "fence ring is 4 sides of 21 cells");
    let g = sim_core::grid::Grid::from_level(&sim_core::level::grid_city(5, 20.0, 10.0, 1), &cfg);
    assert_eq!(g.buildings.len(), 25);
    assert!(g.buildings.iter().all(|b| b.cell_count == 100));
}
