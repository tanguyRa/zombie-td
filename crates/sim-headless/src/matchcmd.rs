//! `sim-headless match`: play an 8-wave match with the starter deck and a
//! simple scripted defence, and print one row per wave.
//!
//! The script, per prep: mulligan a hand with no armament; play armaments
//! (buildings chosen by `pick_towers`), then fortifications as arcs of a
//! circle just inside the previous ring (wave 1: 60% of the core), while
//! supply lasts; keep tactical cards. While the wave runs: every 2 s, play
//! a tactical card on the densest visible group of zombies.

use std::time::Instant;

use sim_core::cards::{CardKind, Effect, TargetKind};
use sim_core::match_::{Action, Match, MatchSetup, Phase, Target};
use sim_core::sim::{CIVILIAN, INFECTED, ZOMBIE};
use sim_core::LevelPack;

use crate::common::*;

pub struct MatchOpts {
    pub level: String,
    pub seed: u64,
    /// Retries per lost wave (each with a different tower choice).
    pub retries: u32,
    /// Safety cap on one wave's length (game seconds); the match has no timeout.
    pub max_wave_s: u32,
    /// Waves below this are won instantly (zombies removed right after the
    /// outbreak) to reach a late wave quickly. Benchmarks only.
    pub fast_forward_to: u8,
    pub multiplier: Option<f32>,
    /// Play no tactical card (to measure what they add).
    pub no_tactical: bool,
}

pub struct WaveRow {
    pub wave: u8,
    pub attempt: u32,
    pub radius_m: f32,
    pub newcomers: u32,
    pub start_civ: u32,
    pub end_civ: u32,
    pub saved: f32,
    pub killed: u32,
    pub bites: u32,
    pub towers: usize,
    /// Supply at Start (after the prep's plays) and cards played this wave.
    pub supply: u32,
    pub played: u32,
    pub ticks: u32,
    pub outcome: &'static str,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    pub hash: u64,
}

pub fn load_any_level(name: &str) -> LevelPack {
    match name.strip_prefix("marais-tiled:") {
        Some(r) => crate::scale::marais_tiled(r.parse().expect("marais-tiled:<radius m>")),
        None => load_level(name),
    }
}

/// Towers for this prep: revealed buildings without a garrison, newest ring
/// first, largest first, at least 50 m apart where possible. `variant`
/// shifts the choice for retries.
/// Coverage picks: repeatedly the revealed building farthest from every
/// shooter already placed (and the play-area edge counts as covered), so
/// towers spread over the revealed disc. Among buildings at least 10 m²,
/// ties by index.
fn pick_spread(m: &Match, want: usize) -> Vec<u32> {
    let sim = m.sim();
    let taken: Vec<u32> = sim.towers.iter().map(|t| t.building).collect();
    let mut pts: Vec<[f32; 2]> = sim.towers.iter().filter(|t| !t.is_unit()).map(|t| [t.x, t.y]).collect();
    let [cx, cy] = m.center();
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
        let score = |p: [f32; 2]| {
            let edge = r - ((p[0] - cx).powi(2) + (p[1] - cy).powi(2)).sqrt();
            pts.iter().map(|q| ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt()).fold(edge.max(0.0) + 25.0, f32::min)
        };
        let best = cands.iter().filter(|(b, _)| !out.contains(b)).map(|&(b, p)| (score(p), b, p)).max_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(b.1.cmp(&a.1)));
        let Some((_, b, p)) = best else { break };
        out.push(b);
        pts.push(p);
    }
    out
}

fn pick_towers(m: &Match, variant: u32, want: usize) -> Vec<u32> {
    if variant % 2 == 0 {
        return pick_spread(m, want);
    }
    let variant = variant / 2;
    let sim = m.sim();
    let wave = m.wave();
    let taken: Vec<u32> = sim.towers.iter().map(|t| t.building).collect();
    let mut cands: Vec<(u8, f32, u32)> = sim
        .grid
        .buildings
        .iter()
        .enumerate()
        .filter(|(b, info)| info.cell_count > 0 && !taken.contains(&(*b as u32)))
        .map(|(b, info)| (m.wave_of_point(info.centroid[0], info.centroid[1]), info.area_m2 * info.floors, b as u32))
        .filter(|&(w, _, _)| w <= wave)
        .collect();
    // Variants: 0 newest ring, largest, 50 m apart; 1 the same 80 m apart;
    // 2 largest anywhere; 3 nearest the centre.
    let [cx, cy] = m.center();
    let spacing: f32 = if variant % 4 == 1 { 80.0 } else { 50.0 };
    match variant % 4 {
        0 | 1 => cands.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.partial_cmp(&a.1).unwrap()).then(a.2.cmp(&b.2))),
        2 => cands.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then(a.2.cmp(&b.2))),
        _ => {
            let d = |b: u32| {
                let c = sim.grid.buildings[b as usize].centroid;
                (c[0] - cx).powi(2) + (c[1] - cy).powi(2)
            };
            cands.sort_by(|a, b| d(a.2).partial_cmp(&d(b.2)).unwrap().then(a.2.cmp(&b.2)))
        }
    }
    let mut out: Vec<u32> = Vec::new();
    let far = |out: &[u32], b: u32| {
        let c = sim.grid.buildings[b as usize].centroid;
        out.iter().chain(taken.iter()).all(|&o| {
            let p = sim.grid.buildings[o as usize].centroid;
            (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) >= spacing * spacing
        })
    };
    for &(_, _, b) in &cands {
        if out.len() < want && far(&out, b) {
            out.push(b);
        }
    }
    for &(_, _, b) in &cands {
        if out.len() < want && !out.contains(&b) {
            out.push(b);
        }
    }
    out
}

/// Points of an arc of the circle (cx, cy, r) from angle `a0` (radians)
/// growing in 2° steps while the fence would stay within `limit_m` placed
/// meters. Returns the points and the end angle. (Trig is fine here: the
/// script only produces action inputs, which a replay reads back.)
fn fence_arc(m: &Match, c: [f32; 2], r: f32, a0: f32, limit_m: f32) -> (Vec<[f32; 2]>, f32) {
    let at = |a: f32| [c[0] + r * a.cos(), c[1] + r * a.sin()];
    let step = 2.0f32.to_radians();
    let mut pts = vec![at(a0), at(a0 + step)];
    let mut a = a0 + step;
    while a < a0 + std::f32::consts::TAU {
        let next = at(a + step);
        pts.push(next);
        if !matches!(m.fence_length_m(&pts), Ok(l) if l <= limit_m) {
            pts.pop();
            break;
        }
        a += step;
    }
    (pts, a)
}

/// The prep part of the script. Returns the cards played.
fn play_prep(m: &mut Match, variant: u32, arc: &mut f32) -> u32 {
    let has_armament = m.hand().iter().any(|c| c.kind == CardKind::Armament);
    if !has_armament && m.mulligan_available() {
        m.apply(Action::Mulligan).unwrap();
    }
    let mut played = 0;
    let wave = m.wave();
    let [cx, cy] = m.center();
    let r = if wave == 1 { 0.6 * m.ring_radius_m(1) } else { m.ring_radius_m(wave - 1) - 4.0 };
    for kind in [CardKind::Armament, CardKind::Fortification] {
        loop {
            let hand = m.hand();
            let Some(c) = hand.iter().find(|c| c.kind == kind && c.playable) else { break };
            let def = m.cards().get(&c.card).unwrap().clone();
            let target = match (&def.effect, c.target) {
                (Effect::Garrison { buildings, .. }, _) => Target::Buildings(pick_towers(m, variant, *buildings as usize)),
                (Effect::Fence { length_m, .. }, TargetKind::Polyline) => {
                    let (pts, end) = fence_arc(m, [cx, cy], r, *arc, *length_m);
                    *arc = end;
                    Target::Polyline(pts)
                }
                _ => break,
            };
            match m.apply(Action::PlayCard { hand_index: c.hand_index, target }) {
                Ok(()) => played += 1,
                Err(_) => break,
            }
        }
    }
    // Keep tactical cards for later waves.
    let keep: Vec<u32> = m.hand().iter().filter(|c| c.kind == CardKind::Tactical).map(|c| c.hand_index).take(m.config().match_.hand_keep as usize).collect();
    m.apply(Action::KeepCards { hand_indices: keep }).unwrap();
    played
}

/// The densest group of zombies: the 20 m square holding the most, at the
/// mean position of its zombies.
fn zombie_hotspot(m: &Match) -> Option<[f32; 2]> {
    let s = m.sim();
    let cell = 20.0f32;
    let mut cells: std::collections::BTreeMap<(i32, i32), (u32, f32, f32)> = Default::default();
    for i in 0..s.n {
        if s.state[i] == ZOMBIE {
            let e = cells.entry(((s.x[i] / cell) as i32, (s.y[i] / cell) as i32)).or_insert((0, 0.0, 0.0));
            e.0 += 1;
            e.1 += s.x[i];
            e.2 += s.y[i];
        }
    }
    let (_, &(n, x, y)) = cells.iter().max_by_key(|(k, v)| (v.0, std::cmp::Reverse(**k)))?;
    Some([x / n as f32, y / n as f32])
}

/// The running part of the script: one tactical card on the hotspot.
fn play_tactical(m: &mut Match) -> u32 {
    let Some(c) = m.hand().into_iter().find(|c| c.kind == CardKind::Tactical && c.playable && c.target == TargetKind::Point) else { return 0 };
    let Some(p) = zombie_hotspot(m) else { return 0 };
    m.apply(Action::PlayCard { hand_index: c.hand_index, target: Target::Point(p) }).map_or(0, |_| 1)
}

pub fn run(o: &MatchOpts) -> (Match, Vec<WaveRow>) {
    let level = load_any_level(&o.level);
    let cfg = load_config();
    let cards = load_cards();
    let mut setup = MatchSetup::new(o.seed, &cfg).with_deck(cards.starter_deck_ids());
    if let Some(k) = o.multiplier {
        setup.population_multiplier = k;
    }
    let mut m = Match::new_with_cards(&level, cfg, cards, setup).expect("match");
    let max_ticks = o.max_wave_s * m.config().tick_hz;
    let mut rows = Vec::new();
    let mut attempt = 0u32;
    let mut clock = WallClock::new();
    loop {
        let wave = m.wave();
        let mut arc = 0.37 * attempt as f32;
        let mut played = play_prep(&mut m, attempt, &mut arc);
        let supply = m.supply();
        m.apply(Action::StartWave).unwrap();
        let mut times = Vec::new();
        if wave < o.fast_forward_to {
            let sim = m.debug_sim_mut();
            for i in 0..sim.n {
                if sim.state[i] == ZOMBIE || sim.state[i] == INFECTED {
                    sim.force_kill(i);
                }
            }
        }
        let mut stalled = false;
        while m.phase() == Phase::Running {
            if !o.no_tactical && m.wave_tick() % 40 == 39 {
                played += play_tactical(&mut m);
            }
            let t = clock_ms(&mut clock);
            m.step_timed(&mut clock);
            times.push(clock_ms(&mut clock) - t);
            if m.wave_tick() >= max_ticks {
                stalled = true;
                break;
            }
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let sim = m.sim();
        let (outcome, start_civ, end_civ, newcomers, killed, bites, ticks, hash) = match m.results().last().filter(|r| r.wave == wave && !stalled) {
            Some(r) => (if r.won { "won" } else { "lost" }, r.start_civilians, r.end_civilians, r.newcomers, r.zombies_killed, r.bites, r.ticks, r.end_hash),
            None => ("stalled", m.wave_start_civilians(), sim.stats.civilians, m.newcomers(), 0, 0, m.wave_tick(), m.state_hash()),
        };
        let outcome = if wave < o.fast_forward_to && outcome == "won" { "skipped" } else { outcome };
        rows.push(WaveRow {
            wave,
            attempt,
            radius_m: m.radius_m(),
            newcomers,
            start_civ,
            end_civ,
            saved: if start_civ > 0 { end_civ as f32 / start_civ as f32 } else { 0.0 },
            killed,
            bites,
            towers: sim.towers.iter().filter(|t| !t.is_unit()).count(),
            supply,
            played,
            ticks,
            outcome,
            p50_ms: percentile(&times, 50.0),
            p95_ms: percentile(&times, 95.0),
            max_ms: times.last().copied().unwrap_or(0.0),
            hash,
        });
        match m.phase() {
            Phase::WaveWon => {
                m.apply(Action::NextWave).unwrap();
                attempt = 0;
            }
            Phase::WaveLost if attempt < o.retries => {
                m.apply(Action::RetryWave).unwrap();
                attempt += 1;
            }
            _ => break,
        }
    }
    (m, rows)
}

fn clock_ms(c: &mut WallClock) -> f64 {
    use sim_core::sim::Clock;
    c.now_ms()
}

pub fn table(m: &Match, rows: &[WaveRow]) -> String {
    let mut s = String::from("| wave | try | radius m | newcomers | start civ | end civ | saved | killed | bites | towers | cards | supply left | game s | result | tick p50 ms | p95 ms | max ms | end hash |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n");
    for r in rows {
        s += &format!(
            "| {} | {} | {:.0} | {} | {} | {} | {:.0}% | {} | {} | {} | {} | {} | {:.0} | {} | {:.2} | {:.2} | {:.2} | {:016x} |\n",
            r.wave,
            r.attempt + 1,
            r.radius_m,
            r.newcomers,
            r.start_civ,
            r.end_civ,
            100.0 * r.saved,
            r.killed,
            r.bites,
            r.towers,
            r.played,
            r.supply,
            r.ticks as f32 / 20.0,
            r.outcome,
            r.p50_ms,
            r.p95_ms,
            r.max_ms,
            r.hash
        );
    }
    let alive = (0..m.sim().n).filter(|&i| m.sim().state[i] == CIVILIAN).count();
    s += &format!(
        "\nphase {:?} at wave {}/{}, retries {}, civilians alive {}, agents in play {} of {}, memory ~{:.0} MB\n",
        m.phase(),
        m.wave(),
        m.waves(),
        m.retries(),
        alive,
        m.sim().n,
        m.sim().x.len(),
        m.memory_bytes() as f64 / 1e6
    );
    s
}

pub fn cmd(args: &[String]) {
    let o = MatchOpts {
        level: crate::arg(args, "--level", "paris-marais".to_string()),
        seed: crate::arg(args, "--seed", 1),
        retries: crate::arg(args, "--retries", 3),
        max_wave_s: crate::arg(args, "--max-wave-s", 1800),
        fast_forward_to: crate::arg(args, "--fast-forward-to", 0),
        multiplier: crate::arg::<String>(args, "--multiplier", String::new()).parse().ok(),
        no_tactical: args.iter().any(|a| a == "--no-tactical"),
    };
    let record: String = crate::arg(args, "--record", String::new());
    if !record.is_empty() && o.fast_forward_to > 0 {
        eprintln!("--record can't be used with --fast-forward-to: it removes zombies outside the action log, so the run would not replay");
        std::process::exit(2);
    }
    let t0 = Instant::now();
    let (m, rows) = run(&o);
    println!("match on {} seed {} (population multiplier {}, starter deck, {} reshuffles)", o.level, o.seed, m.setup().population_multiplier, m.reshuffles());
    print!("{}", table(&m, &rows));
    println!("wall {:.1}s", t0.elapsed().as_secs_f64());
    if !record.is_empty() {
        let r = sim_core::RunRecord::from_match(&m);
        std::fs::write(&record, r.to_json_pretty() + "\n").unwrap_or_else(|e| panic!("{record}: {e}"));
        println!("run record: {record} ({} actions, {} attempts, {} ticks{})", r.actions.len(), r.attempts.len(), r.end.tick, if r.end.abandoned { ", abandoned" } else { "" });
    }
}
