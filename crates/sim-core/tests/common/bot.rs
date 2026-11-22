//! A scripted player for the run-record tests, adapted from
//! `sim-headless match` (coverage-greedy armaments, fence arcs inside the
//! previous ring, tactical cards on the densest zombies). It only produces
//! actions. No trig (arcs rotate a unit vector by fixed 2° steps), so a
//! regenerated record is bit-identical on every platform.
use sim_core::cards::{CardKind, Effect, TargetKind};
use sim_core::match_::{Action, Match, Phase, Target};
use sim_core::sim::ZOMBIE;

pub fn steps(m: &mut Match, n: u32) {
    for _ in 0..n {
        m.step();
    }
}

/// Unit vectors at 0°, 2°, 4°, ... 358°, by repeated rotation.
fn units() -> Vec<[f32; 2]> {
    let (c, s) = (0.999_390_8_f32, 0.034_899_496_f32);
    let mut v = [1.0f32, 0.0];
    let mut out = Vec::with_capacity(180);
    for _ in 0..180 {
        out.push(v);
        v = [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
    }
    out
}

fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dy * dy).sqrt()
}

/// Revealed buildings farthest from every shooter (and from the edge).
pub fn pick_spread(m: &Match, want: usize) -> Vec<u32> {
    let sim = m.sim();
    let taken: Vec<u32> = sim.towers.iter().map(|t| t.building).collect();
    let mut pts: Vec<[f32; 2]> = sim.towers.iter().filter(|t| !t.is_unit()).map(|t| [t.x, t.y]).collect();
    let c = m.center();
    let r = m.radius_m();
    let cands: Vec<(u32, [f32; 2])> = (0..sim.grid.buildings.len() as u32)
        .filter(|&b| {
            let i = &sim.grid.buildings[b as usize];
            i.cell_count > 0 && i.area_m2 >= 10.0 && !taken.contains(&b) && m.wave_of_point(i.centroid[0], i.centroid[1]) <= m.wave()
        })
        .map(|b| (b, sim.grid.buildings[b as usize].centroid))
        .collect();
    let mut out = Vec::new();
    while out.len() < want {
        let score = |p: [f32; 2]| pts.iter().map(|&q| dist(p, q)).fold((r - dist(p, c)).max(0.0) + 25.0, f32::min);
        let best = cands.iter().filter(|(b, _)| !out.contains(b)).map(|&(b, p)| (score(p), b, p)).max_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(b.1.cmp(&a.1)));
        let Some((_, b, p)) = best else { break };
        out.push(b);
        pts.push(p);
    }
    out
}

/// An arc of circle (c, r) from step `k0` (2° each) while the fence fits
/// `limit_m` placed meters. Returns the points and the end step.
fn fence_arc(m: &Match, c: [f32; 2], r: f32, k0: u32, limit_m: f32) -> (Vec<[f32; 2]>, u32) {
    let u = units();
    let at = |k: u32| {
        let v = u[(k % 180) as usize];
        [c[0] + r * v[0], c[1] + r * v[1]]
    };
    let mut pts = vec![at(k0), at(k0 + 1)];
    let mut k = k0 + 1;
    while k < k0 + 180 {
        pts.push(at(k + 1));
        if !matches!(m.fence_length_m(&pts), Ok(l) if l <= limit_m) {
            pts.pop();
            break;
        }
        k += 1;
    }
    (pts, k)
}

/// Prep: mulligan a hand with no armament (or when `force_mulligan`), then
/// armaments, then fortifications while supply lasts; keep tactical cards.
pub fn play_prep(m: &mut Match, arc: &mut u32, force_mulligan: bool) -> u32 {
    let has_armament = m.hand().iter().any(|c| c.kind == CardKind::Armament);
    if (force_mulligan || !has_armament) && m.mulligan_available() {
        m.apply(Action::Mulligan).unwrap();
    }
    let mut played = 0;
    let wave = m.wave();
    let c = m.center();
    let r = if wave == 1 { 0.6 * m.ring_radius_m(1) } else { m.ring_radius_m(wave - 1) - 4.0 };
    for kind in [CardKind::Armament, CardKind::Fortification] {
        loop {
            let hand = m.hand();
            let Some(h) = hand.iter().find(|h| h.kind == kind && h.playable) else { break };
            let def = m.cards().get(&h.card).unwrap().clone();
            let target = match (&def.effect, h.target) {
                (Effect::Garrison { buildings, .. }, _) => Target::Buildings(pick_spread(m, *buildings as usize)),
                (Effect::Fence { length_m, .. }, TargetKind::Polyline) => {
                    let (pts, end) = fence_arc(m, c, r, *arc, *length_m);
                    *arc = end;
                    Target::Polyline(pts)
                }
                _ => break,
            };
            match m.apply(Action::PlayCard { hand_index: h.hand_index, target }) {
                Ok(()) => played += 1,
                Err(_) => break,
            }
        }
    }
    let keep: Vec<u32> = m.hand().iter().filter(|h| h.kind == CardKind::Tactical).map(|h| h.hand_index).take(m.config().match_.hand_keep as usize).collect();
    m.apply(Action::KeepCards { hand_indices: keep }).unwrap();
    played
}

/// The mean position of the zombies in the 20 m square holding the most.
fn zombie_hotspot(m: &Match) -> Option<[f32; 2]> {
    let s = m.sim();
    let mut cells: std::collections::BTreeMap<(i32, i32), (u32, f32, f32)> = Default::default();
    for i in 0..s.n {
        if s.state[i] == ZOMBIE {
            let e = cells.entry(((s.x[i] / 20.0) as i32, (s.y[i] / 20.0) as i32)).or_insert((0, 0.0, 0.0));
            e.0 += 1;
            e.1 += s.x[i];
            e.2 += s.y[i];
        }
    }
    let (_, &(n, x, y)) = cells.iter().max_by_key(|(k, v)| (v.0, std::cmp::Reverse(**k)))?;
    Some([x / n as f32, y / n as f32])
}

/// One tactical card on the hotspot, if any is playable.
pub fn play_tactical(m: &mut Match) -> bool {
    let Some(h) = m.hand().into_iter().find(|h| h.kind == CardKind::Tactical && h.playable && h.target == TargetKind::Point) else { return false };
    let Some(p) = zombie_hotspot(m) else { return false };
    m.apply(Action::PlayCard { hand_index: h.hand_index, target: Target::Point(p) }).is_ok()
}

/// Step the running wave until it ends or `cap` wave ticks, a tactical card
/// every 2 s when `tactical`.
pub fn run_wave(m: &mut Match, tactical: bool, cap: u32) -> Phase {
    while m.phase() == Phase::Running && m.wave_tick() < cap {
        if tactical && m.wave_tick() % 40 == 39 {
            play_tactical(m);
        }
        m.step();
    }
    m.phase()
}

/// Repair every damaged fence the supply allows.
pub fn repair_fences(m: &mut Match) -> u32 {
    let mut n = 0;
    let ids: Vec<u32> = m.structures().iter().map(|s| s.id).collect();
    for id in ids {
        if let Some(cost) = m.repair_cost(id) {
            if cost <= m.supply() && m.apply(Action::Repair { fence_id: id }).is_ok() {
                n += 1;
            }
        }
    }
    n
}
