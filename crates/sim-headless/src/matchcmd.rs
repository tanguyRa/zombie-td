//! `sim-headless match`: play an 8-wave match with a simple scripted defence
//! and print one row per wave.

use std::time::Instant;

use sim_core::match_::{Action, Match, MatchSetup, Phase};
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
    /// Config overrides for the temporary tools (towers / fence per wave).
    pub tower_budget: Option<u32>,
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
fn pick_towers(m: &Match, variant: u32) -> Vec<u32> {
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
    let want = m.towers_left() as usize;
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

pub fn run(o: &MatchOpts) -> (Match, Vec<WaveRow>) {
    let level = load_any_level(&o.level);
    let mut cfg = load_config();
    if let Some(t) = o.tower_budget {
        cfg.tower_budget = t;
    }
    let mut setup = MatchSetup::new(o.seed, &cfg);
    if let Some(k) = o.multiplier {
        setup.population_multiplier = k;
    }
    let mut m = Match::new(&level, cfg, setup).expect("match");
    let max_ticks = o.max_wave_s * m.config().tick_hz;
    let mut rows = Vec::new();
    let mut attempt = 0u32;
    let mut clock = WallClock::new();
    loop {
        let wave = m.wave();
        let towers = pick_towers(&m, attempt);
        for b in towers {
            m.apply(Action::PlaceTower { building: b }).expect("tower");
        }
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
            towers: sim.towers.len(),
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
    let mut s = String::from("| wave | try | radius m | newcomers | start civ | end civ | saved | killed | bites | towers | game s | result | tick p50 ms | p95 ms | max ms | end hash |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n");
    for r in rows {
        s += &format!(
            "| {} | {} | {:.0} | {} | {} | {} | {:.0}% | {} | {} | {} | {:.0} | {} | {:.2} | {:.2} | {:.2} | {:016x} |\n",
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
        tower_budget: Some(crate::arg(args, "--tower-budget", 32)),
    };
    let t0 = Instant::now();
    let (m, rows) = run(&o);
    println!("match on {} seed {} (population multiplier {}, {} towers per wave)", o.level, o.seed, m.setup().population_multiplier, m.config().tower_budget);
    print!("{}", table(&m, &rows));
    println!("wall {:.1}s", t0.elapsed().as_secs_f64());
}
