//! T2: the 8-wave match loop (rings, ABSENT agents, newcomers, outbreaks,
//! fatigue, persistence, retries, determinism, streamed buildings).
mod common;
use sim_core::grid::{FENCE, WALK, WALL};
use sim_core::level::{self, Building, LevelPack};
use sim_core::match_::{Action, ActionError, BuildingChunk, LoggedAction, Match, MatchError, MatchSetup, Phase, Target};
use sim_core::sim::{ABSENT, CIVILIAN, INFECTED, ZOMBIE};
use sim_core::Config;

fn marais() -> LevelPack {
    common::level("paris-marais")
}

fn new_match(cfg: Config, seed: u64) -> Match {
    let setup = MatchSetup::new(seed, &cfg);
    Match::new(&marais(), cfg, setup).unwrap()
}

/// Remove every zombie and infected (test shortcut, not an action).
fn clear_outbreak(m: &mut Match) {
    let sim = m.debug_sim_mut();
    for i in 0..sim.n {
        if sim.state[i] == ZOMBIE || sim.state[i] == INFECTED {
            sim.force_kill(i);
        }
    }
}

/// Start the wave, let it run `ticks`, then clear it: the next tick wins.
fn fast_win(m: &mut Match, ticks: u32) {
    m.apply(Action::StartWave).unwrap();
    for _ in 0..ticks {
        m.step();
        assert_eq!(m.phase(), Phase::Running, "wave {} ended early", m.wave());
    }
    clear_outbreak(m);
    m.step();
    assert!(matches!(m.phase(), Phase::WaveWon | Phase::MatchWon), "{:?}", m.phase());
}

fn dist_from_center(m: &Match, x: f32, y: f32) -> f64 {
    let [cx, cy] = m.center();
    (((x - cx) as f64).powi(2) + ((y - cy) as f64).powi(2)).sqrt()
}

/// A simple scripted defence: every playable prep card of the hand (since
/// T3 the T2 tower budget is gone; see `fixture::fixture_prep_plays`).
fn script_towers(m: &mut Match) {
    sim_core::fixture::fixture_prep_plays(m);
}

/// A match whose deck is 20 Rifles (deck rules relaxed for the test).
fn rifles_match(seed: u64) -> Match {
    let mut cards = sim_core::CardDb::default_cards();
    cards.deck_rules.max_copies.common = 20;
    let cfg = common::cfg();
    let setup = MatchSetup::new(seed, &cfg).with_deck(vec!["rifles".to_string(); 20]);
    Match::new_with_cards(&marais(), cfg, cards, setup).unwrap()
}

#[test]
fn config_is_valid_and_rings_fit_the_level() {
    let cfg = common::cfg();
    cfg.match_.validate(cfg.wave8_radius_m).unwrap();
    assert_eq!(Match::ring_radii(&cfg, 2000.0), cfg.match_.ring_radius_m);
    let r = Match::ring_radii(&cfg, 400.0);
    assert_eq!(r.len(), 8);
    assert_eq!(r[0], 150.0);
    assert!((r[7] - 400.0).abs() < 1e-3, "{r:?}");
    assert!(r.windows(2).all(|p| p[1] > p[0]));
    let small = Match::ring_radii(&cfg, 100.0);
    assert!((small[7] - 100.0).abs() < 1e-3 && small[0] < 100.0);
    let mut bad = cfg.clone();
    bad.match_.ring_radius_m[7] = 1000.0;
    assert!(Match::new(&marais(), bad.clone(), MatchSetup::new(1, &bad)).is_err());
}

#[test]
fn ring_reveal_walls_cells_outside_the_current_radius() {
    let mut m = rifles_match(3);
    let check = |m: &Match| {
        let g = &m.sim().grid;
        let r = m.radius_m() as f64;
        let mut walk_inside = 0;
        for c in 0..g.kind.len() {
            let [x, y] = g.cell_center(c);
            let d = dist_from_center(m, x, y);
            if d > r + 0.01 {
                assert_eq!(g.kind[c], WALL, "cell {c} at {d:.1} m > {r} m is open");
            } else if g.kind[c] == WALK {
                walk_inside += 1;
            }
        }
        assert!(walk_inside > 1000);
    };
    assert_eq!((m.wave(), m.phase()), (1, Phase::Prep));
    check(&m);
    m.apply(Action::StartWave).unwrap();
    for _ in 0..12 {
        m.step();
    }
    // Fields never reach outside the ring.
    let g = &m.sim().grid;
    for c in 0..g.kind.len() {
        let [x, y] = g.cell_center(c);
        if dist_from_center(&m, x, y) > m.radius_m() as f64 + 0.01 {
            assert!(m.sim().chase[c] >= sim_core::field::INF && m.sim().flee[c] >= sim_core::field::INF);
        }
    }
    clear_outbreak(&mut m);
    m.step();
    m.apply(Action::NextWave).unwrap();
    assert_eq!(m.wave(), 2);
    assert!(m.radius_m() > 150.0);
    check(&m);
    // A building outside the revealed area can't be garrisoned.
    let g = &m.sim().grid;
    let outside = (0..g.buildings.len()).find(|&b| m.wave_of_point(g.buildings[b].centroid[0], g.buildings[b].centroid[1]) > 2).unwrap();
    assert_eq!(m.apply(Action::PlayCard { hand_index: 0, target: Target::Buildings(vec![outside as u32]) }), Err(ActionError::NotRevealed { building: outside as u32 }));
    // A fence entirely outside is refused (every cell is a wall).
    let [cx, cy] = m.center();
    let far = m.radius_m() + 50.0;
    assert!(matches!(m.fence_length_m(&[[cx + far, cy], [cx + far, cy + 20.0]]), Err(_)));
}

#[test]
fn absent_agents_never_move_or_get_bitten() {
    let mut m = new_match(common::cfg(), 4);
    let cap = m.sim().x.len();
    assert_eq!(cap, m.config().max_population as usize);
    let n = m.sim().n;
    assert!(n > 0 && n < cap);
    assert!(m.sim().state[n..].iter().all(|&s| s == ABSENT));
    m.apply(Action::StartWave).unwrap();
    // Park an absent slot right on a zombie.
    let z = (0..n).find(|&i| m.sim().state[i] == ZOMBIE).unwrap();
    let (zx, zy) = (m.sim().x[z], m.sim().y[z]);
    let a = n + 10;
    {
        let s = m.debug_sim_mut();
        s.x[a] = zx;
        s.y[a] = zy;
    }
    for _ in 0..200 {
        m.step();
        let s = m.sim();
        assert_eq!(s.n, n);
        assert_eq!((s.x[a], s.y[a], s.state[a]), (zx, zy, ABSENT));
        assert!(s.state[n..].iter().all(|&st| st == ABSENT));
        assert!(s.vx[n..].iter().all(|&v| v == 0.0));
        let live = s.stats.civilians + s.stats.infected + s.stats.zombies + s.stats.dead;
        assert_eq!(live as usize, n, "stats count only agents in play");
    }
}

#[test]
fn newcomers_come_from_the_new_ring_and_survivors_stay_put() {
    let mut m = new_match(common::cfg(), 5);
    let mult = m.setup().population_multiplier as f64;
    for wave in 1..=4u8 {
        assert_eq!(m.wave(), wave);
        let s = m.sim();
        let ring: Vec<usize> = (0..s.grid.buildings.len()).filter(|&b| m.wave_of_point(s.grid.buildings[b].centroid[0], s.grid.buildings[b].centroid[1]) == wave).collect();
        let weight: f64 = ring.iter().map(|&b| s.spawn_weights[b]).sum();
        let spawned: u32 = ring.iter().map(|&b| s.spawn_counts[b]).sum();
        assert_eq!(m.newcomers(), (weight * mult).round() as u32, "wave {wave}");
        assert_eq!(spawned, m.newcomers());
        assert!(m.newcomers() > 0);
        // Every newcomer stands inside the revealed disc.
        let first_new = s.n - m.newcomers() as usize;
        for i in first_new..s.n {
            assert_eq!(s.state[i], CIVILIAN);
            assert!(dist_from_center(&m, s.x[i], s.y[i]) <= m.radius_m() as f64 + 3.0);
        }
        fast_win(&mut m, 30);
        let (x, y, n) = (m.sim().x.clone(), m.sim().y.clone(), m.sim().n);
        m.apply(Action::NextWave).unwrap();
        let s = m.sim();
        for i in 0..n {
            if s.state[i] == CIVILIAN {
                assert_eq!((s.x[i], s.y[i]), (x[i], y[i]), "survivor {i} moved at reveal");
            }
        }
    }
}

#[test]
fn win_and_lose_thresholds() {
    let mut cfg = common::cfg();
    cfg.bite_radius_m = 0.0; // only the test changes civilians
    cfg.zombie_speed = 0.0;
    let mut m = new_match(cfg, 6);
    m.apply(Action::StartWave).unwrap();
    let start = m.wave_start_civilians();
    let line = m.defeat_threshold();
    assert_eq!(line, (0.15 * start as f64).ceil() as u32);
    m.step();
    // Bring civilians down to exactly the line: not lost yet.
    let infect_down_to = |m: &mut Match, target: u32| {
        let s = m.debug_sim_mut();
        for i in 0..s.n {
            if s.stats.civilians <= target {
                break;
            }
            if s.state[i] == CIVILIAN {
                s.force_infected(i);
            }
        }
    };
    infect_down_to(&mut m, line);
    m.step();
    assert_eq!(m.phase(), Phase::Running);
    infect_down_to(&mut m, line - 1);
    m.step();
    assert_eq!(m.phase(), Phase::WaveLost);
    assert!(!m.results()[0].won);
    assert_eq!(m.apply(Action::NextWave).unwrap_err(), ActionError::WrongPhase { action: "next_wave".into(), phase: Phase::WaveLost });
    // Victory: no zombies and no infected, whatever the civilians.
    m.apply(Action::RetryWave).unwrap();
    m.apply(Action::StartWave).unwrap();
    m.step();
    clear_outbreak(&mut m);
    m.step();
    assert_eq!(m.phase(), Phase::WaveWon);
    // Wave 8 ends the match.
    for _ in 2..=8 {
        m.apply(Action::NextWave).unwrap();
        fast_win(&mut m, 5);
    }
    assert_eq!((m.wave(), m.phase()), (8, Phase::MatchWon));
    assert_eq!(m.results().len(), 8);
    assert!(m.apply(Action::RetryWave).is_err());
}

#[test]
fn fatigue_slows_civilians_only() {
    let cfg = common::cfg();
    let f = &cfg.match_;
    assert_eq!(f.fatigue_at(0.0), 1.0);
    assert_eq!(f.fatigue_at(60.0), 1.0);
    assert!((f.fatigue_at(120.0) - 0.875).abs() < 1e-6);
    assert!((f.fatigue_at(600.0) - 0.35).abs() < 1e-6);
    assert!((f.fatigue_at(5000.0) - 0.35).abs() < 1e-6);

    let mut tired = common::cfg();
    tired.match_.fatigue_curve = vec![[0.0, 0.5]];
    let mut m = new_match(tired.clone(), 7);
    m.apply(Action::StartWave).unwrap();
    let (mut civ_max, mut zom_max) = (0.0f32, 0.0f32);
    for _ in 0..200 {
        m.step();
        assert_eq!(m.fatigue(), 0.5);
        let s = m.sim();
        for i in 0..s.n {
            let v = (s.vx[i] * s.vx[i] + s.vy[i] * s.vy[i]).sqrt();
            match s.state[i] {
                CIVILIAN => civ_max = civ_max.max(v),
                ZOMBIE => zom_max = zom_max.max(v),
                _ => {}
            }
        }
    }
    let cap = tired.civilian_flee_speed * 0.5;
    assert!(civ_max <= cap * 1.0001 && civ_max > cap * 0.9, "civilians {civ_max} vs cap {cap}");
    assert!(zom_max > tired.zombie_speed * 0.95, "zombies {zom_max} unaffected");

    // The default curve reaches the sim as the wave goes on.
    let mut m = new_match(common::cfg(), 7);
    m.apply(Action::StartWave).unwrap();
    while m.wave_tick() < 2400 && m.phase() == Phase::Running {
        m.step();
    }
    if m.phase() == Phase::Running {
        assert!((m.fatigue() - cfg.match_.fatigue_at((m.wave_tick() - 1) as f32 / 20.0)).abs() < 1e-6);
        assert!(m.fatigue() < 1.0);
    }
}

#[test]
fn outbreaks_follow_the_per_wave_placement_rules() {
    let cfg = common::cfg();
    let mut m = new_match(cfg.clone(), 8);
    for wave in 1..=8u8 {
        let w = wave as usize - 1;
        m.apply(Action::StartWave).unwrap();
        let sites = m.outbreak_sites().to_vec();
        let (clusters, inner_expected) = m.outbreak_count(wave);
        assert_eq!(sites.len(), clusters as usize, "wave {wave}");
        assert!(clusters >= 1 && clusters <= cfg.match_.outbreak_clusters[w]);
        let r = m.ring_radius_m(wave) as f64;
        let r_prev = if wave > 1 { m.ring_radius_m(wave - 1) as f64 } else { 0.0 };
        let mut inner = 0;
        for &[x, y] in &sites {
            let d = dist_from_center(&m, x, y);
            assert!(d <= r + 0.01, "wave {wave}: site at {d:.1} m outside {r}");
            if wave > 1 && d <= r_prev + 0.01 {
                inner += 1;
            }
        }
        if wave > 1 {
            assert_eq!(inner, inner_expected as usize, "wave {wave}: inner sites");
        }
        if (2..=4).contains(&wave) {
            assert_eq!(inner, 0);
        }
        // Each site starts a cluster: zombies right there.
        let s = m.sim();
        for &[x, y] in &sites {
            assert!((0..s.n).any(|i| s.state[i] == ZOMBIE && (s.x[i] - x).abs() < 0.01 && (s.y[i] - y).abs() < 0.01));
        }
        for _ in 0..3 {
            m.step();
        }
        clear_outbreak(&mut m);
        m.step();
        if wave < 8 {
            m.apply(Action::NextWave).unwrap();
        }
    }
}

#[test]
fn placements_persist_and_broken_fences_stay_broken() {
    let mut m = new_match(common::cfg(), 9);
    script_towers(&mut m);
    let [cx, cy] = m.center();
    let fence: Vec<usize> = (0..m.sim().grid.kind.len()).filter(|&c| m.sim().grid.kind[c] == FENCE).collect();
    assert!(fence.len() > 5, "the starter hand of seed 9 has a fence card");
    let _ = (cx, cy);
    let towers: Vec<u32> = m.sim().towers.iter().map(|t| t.building).collect();
    assert!(!towers.is_empty());
    let structures = m.structures().to_vec();
    m.apply(Action::StartWave).unwrap();
    m.step();
    // Break one fence cell the way the fence phase does.
    let broken = fence[0];
    {
        let s = m.debug_sim_mut();
        s.grid.fence_hp[broken] = 0.0;
        s.grid.set_kind(broken, WALK);
    }
    clear_outbreak(&mut m);
    m.step();
    m.apply(Action::NextWave).unwrap();
    let s = m.sim();
    assert_eq!(s.towers.iter().map(|t| t.building).collect::<Vec<_>>(), towers);
    assert_eq!(s.grid.kind[broken], WALK, "broken fence stays broken");
    assert!(fence[1..].iter().all(|&c| s.grid.kind[c] == FENCE));
    assert_eq!(m.structures(), &structures[..], "structures persist");
}

#[test]
fn retry_restores_the_prep_state_exactly() {
    let mut m = new_match(common::cfg(), 10);
    let prep1 = m.state_hash();
    assert_eq!(m.prep_hash(), prep1);
    for _ in 0..30 {
        m.step(); // cosmetic prep wander
    }
    script_towers(&mut m);
    m.apply(Action::StartWave).unwrap();
    for _ in 0..150 {
        m.step();
    }
    let after_150 = m.state_hash();
    m.apply(Action::RetryWave).unwrap();
    assert_eq!((m.phase(), m.wave(), m.retries()), (Phase::Prep, 1, 1));
    assert_eq!(m.state_hash(), prep1);
    assert!(m.sim().towers.is_empty());
    // Same actions after the retry: same wave (prep length doesn't matter).
    for _ in 0..7 {
        m.step();
    }
    script_towers(&mut m);
    m.apply(Action::StartWave).unwrap();
    for _ in 0..150 {
        m.step();
    }
    assert_eq!(m.state_hash(), after_150);

    // Retry at wave 2 goes back to wave 2's prep, not wave 1's.
    clear_outbreak(&mut m);
    m.step();
    m.apply(Action::NextWave).unwrap();
    let prep2 = m.state_hash();
    assert_ne!(prep2, prep1);
    m.apply(Action::StartWave).unwrap();
    for _ in 0..40 {
        m.step();
    }
    m.apply(Action::RetryWave).unwrap();
    assert_eq!((m.wave(), m.state_hash()), (2, prep2));
    assert_eq!(m.results().len(), 1, "the retried attempt is gone from the results");
    assert_eq!(m.retries(), 2);
}

#[test]
fn restart_rebuilds_the_initial_match() {
    let mut m = new_match(common::cfg(), 11);
    let h0 = m.state_hash();
    fast_win(&mut m, 20);
    m.apply(Action::NextWave).unwrap();
    script_towers(&mut m);
    m.apply(Action::RestartMatch).unwrap();
    assert_eq!((m.wave(), m.phase(), m.retries(), m.restarts()), (1, Phase::Prep, 1, 1));
    assert_eq!(m.state_hash(), h0);
    assert!(m.results().is_empty());
    assert_eq!(new_match(common::cfg(), 11).state_hash(), h0);
}

/// A short scripted match with real waves: card plays every prep, prep
/// lengths varying, until wave `last` ends or a wave is lost.
fn scripted(seed: u64, last: u8) -> Match {
    let mut m = new_match(common::cfg(), seed);
    loop {
        for _ in 0..(m.wave() as u32 * 3) {
            m.step();
        }
        script_towers(&mut m);
        m.apply(Action::StartWave).unwrap();
        while m.phase() == Phase::Running {
            m.step();
            assert!(m.wave_tick() < 20 * 1800, "wave stalled");
        }
        if m.phase() != Phase::WaveWon || m.wave() >= last {
            return m;
        }
        m.apply(Action::NextWave).unwrap();
    }
}

#[test]
fn same_seed_and_actions_give_the_same_hashes() {
    let a = scripted(12, 3);
    let b = scripted(12, 3);
    assert!(!a.results().is_empty());
    assert_eq!(a.results(), b.results());
    assert_eq!(a.state_hash(), b.state_hash());
    let c = scripted(13, 1);
    assert_ne!(a.results()[0].end_hash, c.results()[0].end_hash);

    // The action log replays: JSON round trip, applied on the logged ticks.
    let json = serde_json::to_string(a.log()).unwrap();
    let log: Vec<LoggedAction> = serde_json::from_str(&json).unwrap();
    assert_eq!(log, a.log());
    let mut r = new_match(common::cfg(), 12);
    for e in &log {
        while r.tick() < e.tick {
            r.step();
        }
        r.apply(e.action.clone()).unwrap();
    }
    while r.tick() < a.tick() {
        r.step();
    }
    assert_eq!(r.results(), a.results());
    assert_eq!(r.state_hash(), a.state_hash());
}

#[test]
fn actions_serialize_as_tagged_json() {
    let a = Action::PlayCard { hand_index: 2, target: Target::Polyline(vec![[1.5, 2.25], [3.0, 0.1]]) };
    let s = serde_json::to_string(&a).unwrap();
    assert_eq!(s, r#"{"type":"play_card","hand_index":2,"target":{"polyline":[[1.5,2.25],[3.0,0.1]]}}"#);
    assert_eq!(serde_json::from_str::<Action>(&s).unwrap(), a);
    assert_eq!(serde_json::to_string(&Action::RetryWave).unwrap(), r#"{"type":"retry_wave"}"#);
    assert_eq!(serde_json::to_string(&Action::Mulligan).unwrap(), r#"{"type":"mulligan"}"#);
    assert_eq!(
        serde_json::from_str::<Action>(r#"{"type":"play_card","hand_index":0,"target":{"buildings":[7,8]}}"#).unwrap(),
        Action::PlayCard { hand_index: 0, target: Target::Buildings(vec![7, 8]) }
    );
    assert_eq!(serde_json::from_str::<Action>(r#"{"type":"play_card","hand_index":1,"target":{"point":[3.5,4]}}"#).unwrap(), Action::PlayCard { hand_index: 1, target: Target::Point([3.5, 4.0]) });
    assert_eq!(serde_json::from_str::<Action>(r#"{"type":"pull_down","placement_id":3}"#).unwrap(), Action::PullDown { placement_id: 3 });
    assert_eq!(serde_json::from_str::<Action>(r#"{"type":"repair","fence_id":4}"#).unwrap(), Action::Repair { fence_id: 4 });
    assert_eq!(serde_json::from_str::<Action>(r#"{"type":"keep_cards","hand_indices":[0,3]}"#).unwrap(), Action::KeepCards { hand_indices: vec![0, 3] });
}

#[test]
fn wrong_phase_actions_are_refused() {
    let mut m = new_match(common::cfg(), 14);
    assert!(matches!(m.apply(Action::NextWave), Err(ActionError::WrongPhase { .. })));
    m.apply(Action::StartWave).unwrap();
    for a in [Action::Mulligan, Action::Repair { fence_id: 1 }, Action::PullDown { placement_id: 1 }, Action::StartWave, Action::NextWave] {
        assert!(matches!(m.apply(a), Err(ActionError::WrongPhase { phase: Phase::Running, .. })));
    }
    // Refused actions are not logged.
    assert_eq!(m.log().len(), 1);
}

// ------------------------------------------------------------------ chunks

/// The Marais cut into 100 m blocks (by building centroid), each block's
/// bounds its tile.
fn marais_chunks() -> (LevelPack, Vec<BuildingChunk>) {
    let l = marais();
    let tile = 100.0f32;
    let mut chunks: Vec<BuildingChunk> = Vec::new();
    for ty in -4..4 {
        for tx in -4..4 {
            let (x0, y0) = (tx as f32 * tile, ty as f32 * tile);
            let bs: Vec<Building> = l
                .buildings
                .iter()
                .filter(|b| {
                    let [cx, cy] = level::polygon_centroid(&b.polygon);
                    cx >= x0 && cx < x0 + tile && cy >= y0 && cy < y0 + tile
                })
                .cloned()
                .collect();
            chunks.push(BuildingChunk { block_id: ((ty + 10) * 100 + tx + 10) as u64, bounds: [x0, y0, x0 + tile, y0 + tile], buildings: bs });
        }
    }
    let mut shell = l;
    shell.buildings.clear();
    (shell, chunks)
}

fn extent_meets(c: &BuildingChunk, r: f32) -> bool {
    let mut e = c.bounds;
    for b in &c.buildings {
        for &[x, y] in &b.polygon {
            e = [e[0].min(x), e[1].min(y), e[2].max(x), e[3].max(y)];
        }
    }
    let nx = 0.0f32.clamp(e[0], e[2]);
    let ny = 0.0f32.clamp(e[1], e[3]);
    nx * nx + ny * ny <= r * r
}

/// Three fast-won waves; returns every wave's (start, end) hash. `late`
/// chunks arrive (shuffled) on the first wave-won screen whose next ring
/// isn't loaded yet.
fn play_chunked(mut m: Match, mut late: Vec<BuildingChunk>) -> Vec<(u64, u64)> {
    let mut waited = late.is_empty();
    for wave in 1..=3u8 {
        fast_win(&mut m, 25);
        if !late.is_empty() && !m.ring_ready(wave + 1) {
            assert_eq!(m.apply(Action::NextWave), Err(ActionError::RingNotLoaded { wave: wave + 1 }));
            let mut k = 7usize;
            while !late.is_empty() {
                k = (k * 31 + 3) % late.len();
                m.add_buildings(late.swap_remove(k)).unwrap();
            }
            waited = true;
        }
        if wave < 3 {
            m.apply(Action::NextWave).unwrap();
        }
    }
    assert!(waited, "the late chunks were never needed");
    m.results().iter().map(|r| (r.start_hash, r.end_hash)).collect()
}

#[test]
fn chunks_give_the_same_match_whatever_their_arrival_order() {
    let cfg = common::cfg();
    let setup = MatchSetup::new(15, &cfg);
    let (shell, chunks) = marais_chunks();
    let sorted = play_chunked(Match::new_streaming(&shell, cfg.clone(), setup.clone(), chunks.clone()).unwrap(), vec![]);
    let mut rev = chunks.clone();
    rev.reverse();
    let reversed = play_chunked(Match::new_streaming(&shell, cfg.clone(), setup.clone(), rev).unwrap(), vec![]);
    assert_eq!(sorted, reversed);

    // Only wave 1's blocks first (what a loader fetches: bounds within the
    // ring + `ring_band_m`), the rest later in another order.
    let r1 = Match::ring_radii(&cfg, 400.0)[0];
    let band = sim_core::match_::ring_band_m(&cfg);
    let (first, late): (Vec<_>, Vec<_>) = chunks.iter().cloned().partition(|c| extent_meets(c, r1 + band));
    assert!(!late.is_empty() && !first.is_empty());
    let staged = play_chunked(Match::new_streaming(&shell, cfg.clone(), setup.clone(), first.clone()).unwrap(), late.clone());
    assert_eq!(sorted, staged);

    // Refusals: duplicate block, revealed area, wave 1 not covered.
    let mut m = Match::new_streaming(&shell, cfg.clone(), setup.clone(), first.clone()).unwrap();
    assert_eq!(m.add_buildings(first[0].clone()), Err(MatchError::DuplicateBlock(first[0].block_id)));
    let mut inside = late[0].clone();
    inside.block_id = 999_999;
    inside.bounds = [-10.0, -10.0, 10.0, 10.0];
    assert_eq!(m.add_buildings(inside), Err(MatchError::AreaRevealed(999_999)));
    assert!(matches!(Match::new_streaming(&shell, cfg.clone(), setup.clone(), late.clone()), Err(MatchError::RingNotLoaded(1))));
    let mut with_buildings = shell.clone();
    with_buildings.buildings = marais().buildings;
    assert!(matches!(Match::new_streaming(&with_buildings, cfg.clone(), setup, first.clone()), Err(MatchError::LevelHasBuildings)));
    let mut stray = late.iter().find(|c| !c.buildings.is_empty()).unwrap().clone();
    stray.block_id = 999_998;
    stray.bounds = [1000.0, 1000.0, 1100.0, 1100.0];
    assert!(matches!(m.add_buildings(stray), Err(MatchError::BuildingOutsideBlock { block_id: 999_998, .. })));
}

#[test]
fn match_hash_fixture() {
    let path = format!("{}/tests/fixtures/match_hash.json", env!("CARGO_MANIFEST_DIR"));
    let got = sim_core::fixture::compute_match_fixture_hash(&marais());
    assert_eq!(got, sim_core::fixture::compute_match_fixture_hash(&marais()));
    if std::env::var("UPDATE_FIXTURES").is_ok() {
        std::fs::write(&path, format!("{{\"hash\": \"{got:016x}\"}}\n")).unwrap();
    }
    let s = std::fs::read_to_string(&path).expect("fixture missing: run with UPDATE_FIXTURES=1");
    assert!(s.contains(&format!("{got:016x}")), "native match hash {got:016x} differs from fixture {s}");
}

// ------------------------------------------------------------------ T2 review

fn rect_building(id: u64, kind: level::BuildingKind, [x0, y0, x1, y1]: [f32; 4]) -> Building {
    Building { id, kind, floors: 3.0, polygon: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }
}

/// The default config with these rings (as many waves as rings; per-wave
/// lists cut to match) and a smaller agent cap, for synthetic levels.
fn ring_cfg(rings: &[f32]) -> Config {
    let mut cfg = common::cfg();
    let w = rings.len();
    let mc = &mut cfg.match_;
    mc.ring_radius_m = rings.to_vec();
    mc.outbreak_clusters.truncate(w);
    mc.inner_outbreaks.truncate(w);
    mc.outbreak_radius_m.truncate(w);
    mc.outbreak_min_per_cluster.truncate(w);
    mc.supply_civilians_per_point.truncate(w);
    cfg.wave8_radius_m = rings[w - 1];
    cfg.max_population = 5_000;
    cfg
}

fn disc_level(radius_m: f32, buildings: Vec<Building>) -> LevelPack {
    LevelPack { name: "t2-review".into(), center_lat: 0.0, center_lon: 0.0, radius_m: Some(radius_m), buildings, fences: vec![], bounds: None }
}

/// Every live agent stands on a walkable cell.
fn assert_agents_on_walk(m: &Match) {
    let s = m.sim();
    for i in 0..s.n {
        if s.state[i] == sim_core::sim::DEAD || s.state[i] == ABSENT {
            continue;
        }
        let c = s.grid.cell_of(s.x[i], s.y[i]);
        assert_eq!(s.grid.kind[c], WALK, "agent {i} (state {}) is on a cell of kind {} at wave {}", s.state[i], s.grid.kind[c], m.wave());
    }
}

/// Reviewer repro: rings 100/200/300/400 m, a closed square of buildings
/// around the centre at 80-86 m, homes inside and in ring 2. The open area
/// of ring 2 is larger than the core and not connected to it: "keep the
/// largest region" walled the whole core (0 walkable cells, survivors
/// stuck in walls). Now only regions touching the area kept so far stay.
#[test]
fn a_reveal_never_walls_off_the_territory_already_played() {
    use level::BuildingKind::{Other, Residential};
    let cfg = ring_cfg(&[100.0, 200.0, 300.0, 400.0]);
    let mut bs = vec![
        rect_building(1, Other, [-86.0, -86.0, 86.0, -80.0]),
        rect_building(2, Other, [-86.0, 80.0, 86.0, 86.0]),
        rect_building(3, Other, [-86.0, -80.0, -80.0, 80.0]),
        rect_building(4, Other, [80.0, -80.0, 86.0, 80.0]),
        rect_building(5, Residential, [-20.0, -20.0, 20.0, 20.0]),
    ];
    for (k, [x, y]) in [[150.0f32, 0.0], [-150.0, 0.0], [0.0, 150.0], [0.0, -150.0]].into_iter().enumerate() {
        bs.push(rect_building(10 + k as u64, Residential, [x - 15.0, y - 15.0, x + 15.0, y + 15.0]));
    }
    let mut m = Match::new(&disc_level(400.0, bs), cfg.clone(), MatchSetup::new(3, &cfg)).unwrap();
    let core_walk = |m: &Match| {
        let g = &m.sim().grid;
        (0..g.kind.len()).filter(|&c| g.kind[c] == WALK && dist_from_center(m, g.cell_center(c)[0], g.cell_center(c)[1]) < 80.0).count()
    };
    let core = core_walk(&m);
    assert!(core > 4_000, "core walkable cells {core}");
    assert!(m.sim().n > 10);
    assert_agents_on_walk(&m);
    fast_win(&mut m, 30);
    m.apply(Action::NextWave).unwrap();
    assert_eq!(core_walk(&m), core, "the core must stay open");
    assert_agents_on_walk(&m);
    // The ring-2 area is cut off from the core by the square: walled.
    let g = &m.sim().grid;
    let [cx, cy] = m.center();
    let mut outside = 0;
    for c in 0..g.kind.len() {
        let [x, y] = g.cell_center(c);
        let square = (x - cx).abs().max((y - cy).abs());
        if square > 87.0 && dist_from_center(&m, x, y) < 190.0 {
            assert_ne!(g.kind[c], WALK, "cell {c} outside the square is open");
            outside += 1;
        }
    }
    assert!(outside > 10_000);
    // The match goes on in the core.
    fast_win(&mut m, 30);
    m.apply(Action::NextWave).unwrap();
    assert_eq!(core_walk(&m), core);
    assert_agents_on_walk(&m);
}

#[test]
fn chunks_with_bad_bounds_or_coordinates_are_refused() {
    let cfg = common::cfg();
    let setup = MatchSetup::new(16, &cfg);
    let (shell, chunks) = marais_chunks();
    let chunk = |id: u64, bounds: [f32; 4], poly: Vec<[f32; 2]>| BuildingChunk {
        block_id: id,
        bounds,
        buildings: if poly.is_empty() { vec![] } else { vec![Building { id: 7, kind: level::BuildingKind::Other, floors: 2.0, polygon: poly }] },
    };
    let far = [2000.0, 2000.0, 2100.0, 2100.0];
    let bad = vec![
        chunk(900, [10.0, 0.0, 0.0, 10.0], vec![]),          // inverted x
        chunk(901, [0.0, 10.0, 10.0, 0.0], vec![]),          // inverted y
        chunk(902, [f32::NAN, 0.0, 10.0, 10.0], vec![]),     // NaN
        chunk(903, [0.0, 0.0, 10.0, f32::NAN], vec![]),      // NaN
        chunk(904, [0.0, 0.0, f32::INFINITY, 10.0], vec![]), // infinite
        chunk(905, [f32::NEG_INFINITY, 0.0, 10.0, 10.0], vec![]),
        chunk(906, [2000.0, 2000.0, 2001.5, 2100.0], vec![]), // thinner than a cell
        chunk(907, far, vec![[2050.0, f32::NAN], [2060.0, 2050.0], [2060.0, 2060.0]]),
        chunk(908, far, vec![[2050.0, 2050.0], [f32::INFINITY, 2050.0], [2060.0, 2060.0]]),
    ];
    let mut m = Match::new_streaming(&shell, cfg.clone(), setup.clone(), chunks.clone()).unwrap();
    for c in &bad {
        assert_eq!(m.add_buildings(c.clone()), Err(MatchError::BadChunk(c.block_id)), "{:?}", c.bounds);
        // Also when it comes with the initial chunks.
        let mut init = chunks.clone();
        init.push(c.clone());
        assert!(matches!(Match::new_streaming(&shell, cfg.clone(), setup.clone(), init), Err(MatchError::BadChunk(id)) if id == c.block_id));
    }
    // Nothing was stored: the match plays on, and a good chunk with the same
    // id is still accepted.
    m.add_buildings(chunk(900, far, vec![])).unwrap();
    fast_win(&mut m, 10);
    m.apply(Action::NextWave).unwrap();
}

/// A streamed match on a 400 m disc (rings 100-400 m, margin 50 m) whose
/// map is `probe` plus four blocks tiling the rest of the plane around it.
fn probe_match(probe: Option<&BuildingChunk>, around: [f32; 4]) -> Result<Match, MatchError> {
    let cfg = ring_cfg(&[100.0, 200.0, 300.0, 400.0]);
    let [x0, y0, x1, y1] = around;
    let e = 1000.0;
    let mut chunks = vec![
        BuildingChunk { block_id: 1, bounds: [-e, -e, x0, e], buildings: vec![] },
        BuildingChunk { block_id: 2, bounds: [x1, -e, e, e], buildings: vec![] },
        BuildingChunk { block_id: 3, bounds: [x0, -e, x1, y0], buildings: vec![] },
        BuildingChunk { block_id: 4, bounds: [x0, y1, x1, e], buildings: vec![] },
    ];
    chunks.extend(probe.cloned());
    Match::new_streaming(&disc_level(400.0, vec![]), cfg.clone(), MatchSetup::new(17, &cfg), chunks)
}

/// Reviewer repro: r1 = 100 m, margin 50 m, a block whose bounds start at
/// x = 149.01 with a building reaching x = 99.2. Its bounds come within
/// r1 + margin but hold no cell centre there, so `ring_ready(1)` did not
/// wait for it; arriving after the reveal it was refused (`AreaRevealed`)
/// and `ring_ready(2)` never became true. The band now has one more cell
/// diagonal, so wave 1 waits for it.
#[test]
fn ring_ready_waits_for_every_block_the_reveal_would_refuse() {
    let b = [149.01, -50.0, 249.01, 50.0];
    let probe = BuildingChunk { block_id: 100, bounds: b, buildings: vec![rect_building(1, level::BuildingKind::Residential, [99.2, -5.0, 140.0, 5.0])] };
    assert_eq!(probe_match(None, b).err(), Some(MatchError::RingNotLoaded(1)));
    let m = probe_match(Some(&probe), b).unwrap();
    assert!(m.applied_blocks().contains(&100), "the block reaching into wave 1 is applied at wave 1");
    let band = sim_core::match_::ring_band_m(m.config());
    assert_eq!(band, 50.0 + 2.0 * std::f32::consts::SQRT_2);
}

/// `ring_ready` and the `AreaRevealed` refusal agree: a block that wave 1
/// does not wait for is never refused after wave 1 is revealed. Probes
/// straddle the band edge with sub-cell offsets, east of the centre and at
/// a diagonal (a building at the block's corner), each with a building
/// reaching as far into the core as the margin allows.
#[test]
fn ring_ready_and_area_revealed_agree() {
    let (r1, mg) = (100.0f32, 50.0f32);
    let mut probes = Vec::new();
    // East: one cell high, x from 148 to 150.4 m, y offsets within a cell.
    for i in 0..=24 {
        for j in 0..=8 {
            let x0 = 148.0 + i as f32 * 0.1;
            let y0 = -1.0 + j as f32 * 0.25;
            let tip = x0 - mg + 0.01;
            probes.push(([x0, y0, x0 + 2.0, y0 + 2.0], vec![[tip, y0 + 1.0], [x0 + 1.0, y0 + 0.5], [x0 + 1.0, y0 + 1.5]]));
        }
    }
    // Diagonal: the block's south-west corner at about r1 + mg from the
    // centre, a building vertex just under mg from that corner (Euclidean).
    for i in 0..=40 {
        let a = 104.5 + i as f32 * 0.075;
        let t = a - (mg - 0.01) / std::f32::consts::SQRT_2;
        probes.push(([a, a, a + 2.0, a + 2.0], vec![[t, t], [a + 1.0, a + 1.5], [a + 1.5, a + 1.0]]));
    }
    let (mut awaited, mut free) = (0, 0);
    for (k, (b, poly)) in probes.into_iter().enumerate() {
        let probe = BuildingChunk { block_id: 100 + k as u64, bounds: b, buildings: vec![Building { id: 1, kind: level::BuildingKind::Residential, floors: 2.0, polygon: poly }] };
        match probe_match(None, b) {
            Err(MatchError::RingNotLoaded(1)) => awaited += 1,
            Ok(mut m) => {
                free += 1;
                assert_eq!(m.add_buildings(probe.clone()), Ok(()), "block {b:?} was not awaited by wave 1 but is refused after its reveal");
                assert!(m.ring_ready(2), "{b:?}");
            }
            Err(e) => panic!("{b:?}: {e:?}"),
        }
        // With the probe there from the start the match is fine.
        probe_match(Some(&probe), b).unwrap();
    }
    assert!(awaited > 0 && free > 0, "the probes must straddle the band edge ({awaited} awaited, {free} not)");
    let _ = r1;
    // A building may stick out by the margin per axis, so up to margin × √2
    // at a block corner: here into wave 1's disc from a block whose bounds
    // are beyond r1 + margin. The block is applied by its bounds (wave 2),
    // never refused, and the result doesn't depend on when it arrived; the
    // corner of the building inside the core stays open ground.
    let a = 112.0;
    let corner = BuildingChunk { block_id: 99, bounds: [a, a, a + 2.0, a + 2.0], buildings: vec![rect_building(5, level::BuildingKind::Other, [a - 45.0, a - 45.0, a + 1.0, a + 1.0])] };
    let mut late = probe_match(None, corner.bounds).unwrap();
    let mut early = probe_match(Some(&corner), corner.bounds).unwrap();
    assert_eq!(late.add_buildings(corner.clone()), Ok(()));
    assert_eq!(late.state_hash(), early.state_hash());
    for m in [&mut late, &mut early] {
        assert!(!m.applied_blocks().contains(&99));
        m.apply(Action::StartWave).unwrap();
        m.step(); // no civilians, no outbreak: won at once
        assert_eq!(m.phase(), Phase::WaveWon);
        m.apply(Action::NextWave).unwrap();
        assert!(m.applied_blocks().contains(&99));
        let [cx, cy] = m.center();
        let g = &m.sim().grid;
        assert_eq!(g.kind[g.cell_of(cx + 69.0, cy + 69.0)], WALK, "inside wave 1, revealed before the block applied");
        assert_eq!(g.kind[g.cell_of(cx + 105.0, cy + 105.0)], sim_core::grid::BUILDING, "in ring 2");
    }
    assert_eq!(late.state_hash(), early.state_hash());
}

/// Reviewer repro: two matches with equal hashes but a different defeat
/// line; one tick later one was Running and the other WaveLost.
#[test]
fn state_hash_sees_the_defeat_line() {
    let mut a = new_match(common::cfg(), 18);
    let mut b = new_match(common::cfg(), 18);
    a.apply(Action::StartWave).unwrap();
    b.apply(Action::StartWave).unwrap();
    assert_eq!(a.state_hash(), b.state_hash());
    let civ = b.sim().stats.civilians;
    b.debug_sim_mut().loss_below = civ + 1;
    assert_ne!(a.state_hash(), b.state_hash());
    a.step();
    b.step();
    assert_eq!((a.phase(), b.phase()), (Phase::Running, Phase::WaveLost));
}

/// The Marais with a deck of 20 light fences at 4 hp per cell.
fn weak_fence_match(seed: u64) -> Match {
    let mut cards = sim_core::CardDb::default_cards();
    cards.deck_rules.max_copies.common = 20;
    for c in cards.cards.iter_mut() {
        if let sim_core::cards::Effect::Fence { cell_hp, .. } = &mut c.effect {
            *cell_hp = 4.0;
        }
    }
    let cfg = common::cfg();
    let setup = MatchSetup::new(seed, &cfg).with_deck(vec!["light_fence".to_string(); 20]);
    Match::new_with_cards(&marais(), cfg, cards, setup).unwrap()
}

/// Wave 1's outbreak sites of `weak_fence_match(seed)` (a throwaway match).
fn outbreak_sites(seed: u64) -> Vec<[f32; 2]> {
    let mut m = weak_fence_match(seed);
    m.apply(Action::StartWave).unwrap();
    m.outbreak_sites().to_vec()
}

/// Prep: a weak fence box around each outbreak site (zombies chew out of
/// it), then start the wave.
fn box_the_outbreak(m: &mut Match, sites: &[[f32; 2]]) {
    for &[x, y] in sites {
        let h = 8.0;
        let pts = vec![[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h]];
        m.apply(Action::PlayCard { hand_index: 0, target: Target::Polyline(pts) }).unwrap();
    }
    m.apply(Action::StartWave).unwrap();
}

/// Match hashes don't depend on how the field work is spread (budgets) or
/// on computing every job in full at once (`eager_fields`), also while
/// fences break under jobs in flight: the hash covers the published fields
/// and the jobs' inputs, not their half-done buffers.
#[test]
fn match_hash_ignores_field_budgets_and_eager_jobs() {
    fn odd(tick: u32, _job: usize, b: usize) -> usize {
        if tick % 3 == 0 { 1 } else { b / 7 + 1 }
    }
    let sites = outbreak_sites(19);
    let run = |mode: u8| {
        let mut m = weak_fence_match(19);
        match mode {
            1 => m.debug_sim_mut().eager_fields = true,
            2 => m.debug_sim_mut().test_budget = Some(odd),
            _ => {}
        }
        box_the_outbreak(&mut m, &sites);
        let mut hashes = Vec::new();
        for _ in 0..400 {
            m.step();
            hashes.push(m.state_hash());
            if m.phase() != Phase::Running {
                break;
            }
        }
        (hashes, m.sim().stats.fence_cells_broken)
    };
    let (lazy, broken) = run(0);
    assert!(broken > 0, "fences must break during the run");
    let (eager, _) = run(1);
    let (budget, _) = run(2);
    assert_eq!(lazy.len(), eager.len());
    assert_eq!(lazy.len(), budget.len());
    for t in 0..lazy.len() {
        assert_eq!(lazy[t], eager[t], "eager differs at tick {t}");
        assert_eq!(lazy[t], budget[t], "budget differs at tick {t}");
    }
}

/// A retry after fence cells broke (field jobs then read frozen grids)
/// lands on the prep hash, and replaying the attempt gives exactly the
/// hashes of a fresh match playing it once.
#[test]
fn retry_after_fence_breaks_replays_exactly() {
    let sites = outbreak_sites(20);
    let attempt = |m: &mut Match, ticks: usize| -> Vec<u64> {
        box_the_outbreak(m, &sites);
        (0..ticks)
            .map(|_| {
                m.step();
                m.state_hash()
            })
            .collect()
    };
    let mut a = weak_fence_match(20);
    let prep = a.state_hash();
    let first = attempt(&mut a, 300);
    assert!(a.sim().stats.fence_cells_broken > 0, "fences must break");
    a.apply(Action::RetryWave).unwrap();
    assert_eq!(a.state_hash(), prep);
    assert_eq!(a.sim().stats.fence_cells_broken, 0);
    let rerun = attempt(&mut a, 300);
    let mut fresh = weak_fence_match(20);
    assert_eq!(fresh.state_hash(), prep);
    let once = attempt(&mut fresh, 300);
    assert_eq!(rerun, once);
    assert_eq!(first, once);
    assert_eq!(a.phase(), fresh.phase());
}

/// A match on the Marais with room for 40 agents: newcomers stop at the
/// cap, and waves still play.
#[test]
fn a_population_capped_match_plays() {
    let mut cfg = common::cfg();
    cfg.max_population = 40;
    let mut m = new_match(cfg, 21);
    assert_eq!(m.sim().x.len(), 40);
    assert_eq!((m.sim().n, m.newcomers()), (40, 40));
    for _ in 0..3 {
        fast_win(&mut m, 20);
        m.apply(Action::NextWave).unwrap();
        assert_eq!((m.sim().n, m.newcomers()), (40, 0), "wave {}", m.wave());
        assert_agents_on_walk(&m);
    }
}

/// Play every wave of `m`: start, clear the outbreak, win.
fn play_all_waves(m: &mut Match) {
    loop {
        assert_agents_on_walk(m);
        m.apply(Action::StartWave).unwrap();
        m.step();
        clear_outbreak(m);
        while m.phase() == Phase::Running {
            m.step();
        }
        match m.phase() {
            Phase::WaveWon => m.apply(Action::NextWave).unwrap(),
            Phase::MatchWon => return,
            p => panic!("wave {} ended {p:?}", m.wave()),
        }
    }
}

/// Tiny levels: rings smaller than a cell, no buildings, one building.
#[test]
fn tiny_levels_play_through() {
    let cfg = common::cfg();
    let mut empty = Match::new(&disc_level(30.0, vec![]), cfg.clone(), MatchSetup::new(22, &cfg)).unwrap();
    assert_eq!(empty.sim().n, 0);
    play_all_waves(&mut empty);
    assert_eq!(empty.wave(), 8);

    let one = vec![rect_building(1, level::BuildingKind::Residential, [2.0, -2.0, 6.0, 2.0])];
    let mut m = Match::new(&disc_level(8.0, one), cfg.clone(), MatchSetup::new(23, &cfg)).unwrap();
    assert!(m.ring_radius_m(1) < 1.0);
    play_all_waves(&mut m);
    assert_eq!((m.wave(), m.phase()), (8, Phase::MatchWon));
}

/// A ring with no buildings: no newcomers, the outbreak falls back to
/// anywhere, and the match goes on.
#[test]
fn an_empty_ring_still_plays() {
    use level::BuildingKind::Residential;
    let cfg = ring_cfg(&[100.0, 200.0, 300.0, 400.0]);
    let bs = vec![rect_building(1, Residential, [-30.0, -30.0, 30.0, 30.0]), rect_building(2, Residential, [240.0, -20.0, 280.0, 20.0])];
    let mut m = Match::new(&disc_level(400.0, bs), cfg.clone(), MatchSetup::new(24, &cfg)).unwrap();
    let n1 = m.sim().n;
    assert!(n1 > 20);
    fast_win(&mut m, 20);
    m.apply(Action::NextWave).unwrap();
    assert_eq!((m.wave(), m.newcomers(), m.sim().n), (2, 0, n1));
    m.apply(Action::StartWave).unwrap();
    assert_eq!(m.outbreak_sites().len(), m.outbreak_count(2).0 as usize);
    for _ in 0..20 {
        m.step();
    }
    clear_outbreak(&mut m);
    m.step();
    assert_eq!(m.phase(), Phase::WaveWon);
    m.apply(Action::NextWave).unwrap();
    assert!(m.newcomers() > 0, "ring 3 has a building");
}
