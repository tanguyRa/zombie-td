//! M3: towers, fences, fence breaks, placement budgets.
mod common;
use sim_core::grid::{FENCE, WALK};
use sim_core::level::{self, COMPOUND_CENTER, COMPOUND_HALF};
use sim_core::sim::{CIVILIAN, DEAD, ZOMBIE};
use sim_core::Sim;

fn walkable_at_distance(sim: &Sim, cx: f32, cy: f32, dmin: f32, dmax: f32) -> (f32, f32) {
    for i in 0..sim.grid.kind.len() {
        if sim.grid.kind[i] != WALK {
            continue;
        }
        let [px, py] = sim.grid.cell_center(i);
        let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
        if d >= dmin && d <= dmax {
            return (px, py);
        }
    }
    panic!("no walkable cell at {dmin}..{dmax} m");
}

fn tower_sim(zombie_dist: (f32, f32)) -> (Sim, usize) {
    let mut cfg = common::cfg();
    cfg.zombie_speed = 0.0; // keep the target exactly where we put it
    let lvl = level::grid_city(3, 20.0, 12.0, 1);
    let mut sim = Sim::new(&lvl, cfg, 2, 5);
    sim.place_tower(4).unwrap();
    let [cx, cy] = sim.grid.buildings[4].centroid;
    let (zx, zy) = walkable_at_distance(&sim, cx, cy, zombie_dist.0, zombie_dist.1);
    sim.force_zombie(0, zx, zy);
    // A civilian in the far corner, out of the tower's range.
    sim.x[1] = 3.0;
    sim.y[1] = 3.0;
    sim.start_without_outbreak();
    (sim, 0)
}

#[test]
fn tower_kills_zombie_at_30m_in_exactly_3_shots() {
    let (mut sim, z) = tower_sim((29.5, 30.5));
    for _ in 0..20 {
        sim.step();
        assert_eq!(sim.state[z], ZOMBIE, "alive before the third shot (tick {})", sim.tick);
    }
    sim.step(); // tick 20: third shot (2 shots/s = every 10 ticks)
    assert_eq!(sim.state[z], DEAD);
    assert_eq!(sim.towers[0].shots, 3);
    assert_eq!(sim.towers[0].kills, 1);
    assert_eq!(sim.stats.zombies_killed, 1);
}

#[test]
fn tower_ignores_zombie_at_41m() {
    let (mut sim, z) = tower_sim((41.0, 42.0));
    let hp = sim.hp[z];
    for _ in 0..60 {
        sim.step();
    }
    assert_eq!(sim.hp[z], hp);
    assert_eq!(sim.towers[0].shots, 0);
}

#[test]
fn tower_never_targets_civilians() {
    let lvl = level::grid_city(3, 20.0, 12.0, 1);
    let mut sim = Sim::new(&lvl, common::cfg(), 200, 5);
    sim.place_tower(4).unwrap();
    sim.start_without_outbreak(); // civilians all around the tower, no zombies
    for _ in 0..40 {
        sim.step();
    }
    assert_eq!(sim.towers[0].shots, 0);
    assert!(sim.state.iter().all(|&s| s == CIVILIAN));
}

/// Walled compound with civilians inside and zombies outside on the east.
fn compound(gap: bool, zombies: usize) -> Sim {
    let lvl = level::walled_compound();
    let pop = 60 + zombies;
    let mut sim = Sim::new(&lvl, common::cfg(), pop as u32, 9);
    let [cx, cy] = sim.to_sim(COMPOUND_CENTER[0], COMPOUND_CENTER[1]);
    if gap {
        // Open three cells in the east wall at the compound's centre line.
        let east = cx + COMPOUND_HALF + 1.0;
        for dy in [-2.0, 0.0, 2.0] {
            let c = sim.grid.cell_of(east, cy + dy);
            assert_eq!(sim.grid.kind[c], FENCE);
            sim.grid.kind[c] = WALK;
        }
    }
    for i in 0..60 {
        let (gx, gy) = ((i % 10) as f32, (i / 10) as f32);
        sim.x[i] = cx - 15.0 + gx * 3.0 + 0.3;
        sim.y[i] = cy - 15.0 + gy * 5.0 + 0.3;
    }
    for k in 0..zombies {
        sim.force_zombie(60 + k, cx + 35.0, cy + 10.0 + k as f32 * 0.7);
    }
    sim.start_without_outbreak();
    sim
}

fn inside(sim: &Sim, i: usize) -> bool {
    let [cx, cy] = sim.to_sim(COMPOUND_CENTER[0], COMPOUND_CENTER[1]);
    (sim.x[i] - cx).abs() < COMPOUND_HALF && (sim.y[i] - cy).abs() < COMPOUND_HALF
}

fn fence_damaged(sim: &Sim, cfg_hp: f32) -> bool {
    (0..sim.grid.kind.len()).any(|c| sim.grid.kind[c] == FENCE && sim.grid.fence_hp[c] < cfg_hp)
}

#[test]
fn zombies_detour_through_a_gap() {
    let mut sim = compound(true, 5);
    let hp = sim.cfg.fence_cell_hp;
    let mut entered = None;
    for _ in 0..600 {
        sim.step();
        assert!(!fence_damaged(&sim, hp), "zombies attacked the fence although a gap exists (tick {})", sim.tick);
        if (0..sim.n).any(|i| sim.state[i] == ZOMBIE && inside(&sim, i)) {
            entered = Some(sim.tick);
            break;
        }
    }
    assert!(entered.is_some(), "no zombie got in through the gap");
}

#[test]
fn zombies_attack_the_fence_without_a_gap() {
    let mut sim = compound(false, 5);
    let hp = sim.cfg.fence_cell_hp;
    let mut attacked = false;
    for _ in 0..800 {
        sim.step();
        if sim.stats.first_breach_tick.is_none() {
            assert!((0..sim.n).all(|i| !(sim.state[i] == ZOMBIE && inside(&sim, i))), "zombie inside before any breach");
        }
        attacked |= fence_damaged(&sim, hp) || sim.stats.fence_cells_broken > 0;
    }
    assert!(attacked, "zombies never attacked the fence");
}

#[test]
fn civilians_never_cross_fences() {
    let mut sim = compound(false, 0);
    // Wake them up with a zombie inside the compound (they can't escape).
    let [cx, cy] = sim.to_sim(COMPOUND_CENTER[0], COMPOUND_CENTER[1]);
    for i in 0..60 {
        assert!(inside(&sim, i));
    }
    sim.force_zombie(0, cx, cy);
    sim.recompute_threat_and_flee();
    for _ in 0..400 {
        sim.step();
        for i in 0..sim.n {
            if sim.state[i] != DEAD {
                let c = sim.grid.cell_of(sim.x[i], sim.y[i]);
                assert_ne!(sim.grid.kind[c], FENCE);
                assert!(inside(&sim, i), "agent {i} left the compound");
            }
        }
        if sim.outcome().is_some() {
            break;
        }
    }
}

#[test]
fn fence_break_reopens_cell_and_recomputes_fields_same_tick() {
    let mut sim = compound(false, 6);
    let [cx, cy] = sim.to_sim(COMPOUND_CENTER[0], COMPOUND_CENTER[1]);
    let east = cx + COMPOUND_HALF + 1.0;
    // Make one east-wall cell nearly broken; zombies are drawn to it.
    let weak = sim.grid.cell_of(east, cy + 10.0);
    sim.grid.fence_hp[weak] = 1.0;
    let fence_cost = sim.cfg.fence_path_cost;
    let fences_before: Vec<usize> = (0..sim.grid.kind.len()).filter(|&c| sim.grid.kind[c] == FENCE).collect();
    for _ in 0..1500 {
        sim.step();
        if sim.stats.fence_cells_broken > 0 {
            break;
        }
    }
    assert!(sim.stats.fence_cells_broken > 0, "the weak cell never broke");
    let broken: Vec<usize> = fences_before.iter().copied().filter(|&c| sim.grid.kind[c] == WALK).collect();
    assert_eq!(broken.len() as u32, sim.stats.fence_cells_broken, "broken cells are walkable again");
    // Fields already reflect the break at the end of the breaking tick.
    for &c in &broken {
        assert!(sim.chase[c] < fence_cost, "chase field still charges the fence cost");
        assert!(sim.flee[c] < sim_core::field::INF, "flee field still treats the cell as a fence");
    }
    let (chase, flee, threat) = (sim.chase.clone(), sim.flee.clone(), sim.threat.clone());
    sim.recompute_chase();
    sim.recompute_threat_and_flee();
    assert_eq!(chase, sim.chase);
    assert_eq!(threat, sim.threat);
    assert_eq!(flee, sim.flee);
}

#[test]
fn placement_budgets_and_undo() {
    let lvl = common::level("paris-marais");
    let mut sim = Sim::new(&lvl, common::cfg(), 1000, 1);
    for b in 0..8 {
        sim.place_tower(b).unwrap();
    }
    assert!(sim.place_tower(8).is_err(), "9th tower");
    assert!(sim.place_tower(3).is_err() || sim.towers_left() == 0);
    assert!(sim.undo());
    assert_eq!(sim.towers.len(), 7);
    assert!(sim.place_tower(3).is_err(), "duplicate garrison");

    // Fence: find a 50 m open stretch.
    let [cx, cy] = sim.to_sim(0.0, 0.0);
    let mut placed = None;
    'search: for dy in (-300..300).step_by(4) {
        for dx in (-300..300).step_by(4) {
            let (x0, y0) = (cx + dx as f32, cy + dy as f32);
            match sim.place_fence(&[[x0, y0], [x0 + 50.0, y0]]) {
                Ok(l) if (l - 50.0).abs() < 0.01 => {
                    placed = Some((x0, y0));
                    break 'search;
                }
                Ok(_) => {
                    sim.undo(); // partly clipped by a building: keep looking
                }
                Err(_) => {}
            }
        }
    }
    let (x0, y0) = placed.expect("some open 50 m stretch");
    assert!((sim.fence_used_m - 50.0).abs() < 0.01);
    let c = sim.grid.cell_of(x0 + 10.0, y0);
    assert_eq!(sim.grid.kind[c], FENCE);
    // Budget on open ground (nothing to clip): 350 m fits, 60 m more does not.
    let mut open = Sim::new(&level::open_field(500.0), common::cfg(), 1, 1);
    assert!(open.place_fence(&[[30.0, 30.0], [380.0, 30.0]]).is_ok());
    assert!(open.place_fence(&[[30.0, 60.0], [90.0, 60.0]]).is_err());
    assert!(open.place_fence(&[[30.0, 60.0], [70.0, 60.0]]).is_ok());
    // Entirely on a building: refused. (Lines that only cross buildings are clipped.)
    let b = &sim.grid.buildings[0];
    let [bx, by] = b.centroid;
    if sim.grid.kind[sim.grid.cell_of(bx, by)] == sim_core::grid::BUILDING {
        assert!(sim.place_fence(&[[bx - 1.0, by], [bx + 1.0, by]]).is_err());
    }
    assert!(sim.undo());
    assert_eq!(sim.grid.kind[c], WALK);
    assert!(sim.fence_used_m.abs() < 0.01);
    sim.clear_placements();
    assert!(sim.towers.is_empty() && sim.placements.is_empty());
}

#[test]
fn rasterized_fences_have_no_diagonal_gaps() {
    let lvl = level::open_field(100.0);
    let sim = Sim::new(&lvl, common::cfg(), 1, 1);
    let cells = sim.grid.rasterize_polyline(&[[10.3, 10.7], [83.1, 61.9], [20.0, 90.0]]);
    // Every consecutive pair of cells along the line shares an edge.
    let w = sim.grid.w as i64;
    for pair in cells.windows(2) {
        let (a, b) = (pair[0] as i64, pair[1] as i64);
        let (ax, ay, bx, by) = (a % w, a / w, b % w, b / w);
        assert_eq!((ax - bx).abs() + (ay - by).abs(), 1, "cells {a} and {b} only touch diagonally");
    }
}

#[test]
fn fences_are_clipped_at_buildings_and_charged_for_placed_part() {
    let lvl = level::grid_city(2, 20.0, 10.0, 1);
    let mut sim = Sim::new(&lvl, common::cfg(), 10, 1);
    // A line across the middle street and through two buildings.
    let [ax, ay] = sim.grid.buildings[0].centroid;
    let [bx, _] = sim.grid.buildings[1].centroid;
    let cells = sim.grid.rasterize_polyline(&[[ax, ay], [bx, ay]]);
    let l = sim.place_fence(&[[ax, ay], [bx, ay]]).unwrap();
    let placed = cells.iter().filter(|&&c| sim.grid.kind[c] == FENCE).count();
    assert!(placed > 0 && placed < cells.len(), "only the street part is fenced");
    let full = bx - ax;
    assert!((l - full * placed as f32 / cells.len() as f32).abs() < 0.01);
    assert!(cells.iter().all(|&c| sim.grid.kind[c] != WALK), "every open cell of the line is fenced");
}
