//! T4: run records, the replay verifier and determinism (DECISIONS.md,
//! "Run records (T4)").
//!
//! The golden record `tests/fixtures/run_record_golden.json` is the scripted
//! 8-wave Marais match below; its hashes are pinned per rules version in
//! `GOLDEN_HASHES`. When the sim changes a hash: bump `SIM_RULES_VERSION`,
//! regenerate with
//!
//!   ZT_REGEN_GOLDEN=1 cargo test --release -p sim-core --test t4_records golden
//!
//! and add the `GOLDEN_HASHES` entry it prints. The regeneration refuses to
//! write hashes that differ from the current version's entry.
mod common;

use std::sync::OnceLock;
use std::time::Instant;

use common::bot::{play_prep, play_tactical, repair_fences, run_wave, steps};
use sim_core::cards::CardKind;
use sim_core::level::LevelPack;
use sim_core::match_::{Action, ActionError, AttemptResult, BuildingChunk, Match, MatchError, MatchSetup, Phase, StructureKind, Target};
use sim_core::record::{replay_with, ExpectedRun, ReplayLimits, ReplayMap, ReplayProgress, RunRecord, SIM_RULES_VERSION};
use sim_core::{replay, CardDb, Config, VerifyError};

const GOLDEN: &str = "run_record_golden.json";
const REGEN: &str = "ZT_REGEN_GOLDEN=1 cargo test --release -p sim-core --test t4_records golden";

/// The golden record's hashes per `SIM_RULES_VERSION`: (rules, final hash,
/// config hash, cards hash, map snapshot hash). One entry per version, never
/// edited: a hash change needs a new version (and a new entry).
const GOLDEN_HASHES: &[(u32, &str, &str, &str, &str)] = &[(1, "b6f30157787dde36", "ceabf38252a0c4ba", "3e157f5ac2531906", "e9b1fbac85820411")];

fn golden_hashes(r: &RunRecord) -> (u32, String, String, String, String) {
    use sim_core::mapsnap::hex;
    (r.sim.rules, hex(r.end.hash), hex(r.config_hash), hex(r.cards_hash), hex(r.map.snapshot_hash))
}

fn pinned(rules: u32) -> Option<(u32, String, String, String, String)> {
    GOLDEN_HASHES.iter().find(|e| e.0 == rules).map(|e| (e.0, e.1.to_string(), e.2.to_string(), e.3.to_string(), e.4.to_string()))
}

fn fixture_path(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn marais() -> &'static LevelPack {
    static L: OnceLock<LevelPack> = OnceLock::new();
    L.get_or_init(|| common::level("paris-marais"))
}

/// The scripted 8-wave Marais match (seed 1, starter deck):
/// - wave 1: 30 idle prep ticks, plays, then a restart; an attempt with no
///   defence (lost); a retry; an attempt with plays abandoned by a retry
///   200 ticks into the wave; then the real attempt;
/// - wave 2: a forced mulligan;
/// - wave 3: the newest structure pulled down in its own prep (undo);
/// - wave 4: an older garrison pulled down (refund);
/// - from wave 2: damaged fences repaired when affordable;
/// - wave 5: won, then retried once from the result screen;
/// - tactical cards every 2 s while waves run; 20 idle prep ticks before
///   each Start. Lost waves are retried.
fn scripted_match() -> Match {
    let cfg = common::cfg();
    let mut m = Match::new(marais(), cfg.clone(), MatchSetup::new(1, &cfg)).unwrap();
    let mut arc = 0;
    steps(&mut m, 30);
    play_prep(&mut m, &mut arc, false);
    steps(&mut m, 5);
    m.apply(Action::RestartMatch).unwrap();
    steps(&mut m, 10);
    m.apply(Action::StartWave).unwrap();
    run_wave(&mut m, false, 12_000);
    m.apply(Action::RetryWave).unwrap();
    arc = 0;
    play_prep(&mut m, &mut arc, false);
    m.apply(Action::StartWave).unwrap();
    run_wave(&mut m, true, 200);
    assert_eq!(m.phase(), Phase::Running);
    m.apply(Action::RetryWave).unwrap();
    let mut retried5 = false;
    let mut losses = 0;
    loop {
        let wave = m.wave();
        let mut arc = 0;
        if wave >= 2 {
            repair_fences(&mut m);
        }
        if wave == 4 {
            let old = m.structures().iter().find(|s| s.wave < 4 && matches!(s.kind, StructureKind::Garrison { .. })).map(|s| s.id).unwrap();
            m.apply(Action::PullDown { placement_id: old }).unwrap();
        }
        play_prep(&mut m, &mut arc, wave == 2);
        if wave == 3 {
            let newest = m.structures().last().unwrap().id;
            m.apply(Action::PullDown { placement_id: newest }).unwrap();
        }
        steps(&mut m, 20);
        m.apply(Action::StartWave).unwrap();
        match run_wave(&mut m, true, 12_000) {
            Phase::WaveWon if wave == 5 && !retried5 => {
                retried5 = true;
                m.apply(Action::RetryWave).unwrap();
            }
            Phase::WaveWon => m.apply(Action::NextWave).unwrap(),
            Phase::WaveLost => {
                losses += 1;
                assert!(losses <= 3, "the script loses too often (wave {wave})");
                m.apply(Action::RetryWave).unwrap();
            }
            Phase::MatchWon => break,
            p => panic!("wave {wave} still {p:?} after 600 s"),
        }
    }
    m
}

/// The scripted match's record, built once per test binary.
fn scripted() -> &'static RunRecord {
    static R: OnceLock<RunRecord> = OnceLock::new();
    R.get_or_init(|| RunRecord::from_match(&scripted_match()))
}

fn level_map() -> ReplayMap<'static> {
    ReplayMap::Level(marais())
}

#[test]
fn scripted_match_covers_the_actions() {
    let r = scripted();
    let names: Vec<&str> = r.actions.iter().map(|a| a.action.name()).collect();
    for n in ["play_card", "mulligan", "keep_cards", "repair", "pull_down", "start_wave", "next_wave", "retry_wave", "restart_match"] {
        assert!(names.contains(&n), "no {n} in the log: {names:?}");
    }
    let results: Vec<AttemptResult> = r.attempts.iter().map(|a| a.result).collect();
    for res in [AttemptResult::Won, AttemptResult::Lost, AttemptResult::Abandoned] {
        assert!(results.contains(&res), "no {res:?} attempt: {results:?}");
    }
    assert_eq!(r.end.phase, Phase::MatchWon);
    assert!(!r.end.abandoned);
    assert_eq!(r.end.waves_won, 8);
    assert!(r.end.retries >= 4 && r.end.restarts == 1, "{} retries {} restarts", r.end.retries, r.end.restarts);
    // A tactical card played mid-wave.
    assert!(r.actions.iter().any(|a| matches!(a.action, Action::PlayCard { target: Target::Point(_), .. })), "no tactical play");
    eprintln!("scripted record: {} actions, {} attempts, {} ticks", r.actions.len(), r.attempts.len(), r.end.tick);
    for a in &r.attempts {
        eprintln!("  wave {} {:?} ticks {}..{} end {:016x}", a.wave, a.result, a.start_tick, a.end_tick, a.end_hash);
    }
}

/// Native determinism: the record replays 3 times (in parallel) with every
/// hash equal, also after a JSON round trip.
#[test]
fn scripted_record_replays_three_times() {
    let r = scripted();
    let json = r.to_json();
    let back = RunRecord::from_json(&json).unwrap();
    assert_eq!(back.actions, r.actions, "actions survive JSON exactly");
    assert_eq!(back.to_json(), json);
    let t = Instant::now();
    let sums: Vec<_> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..3).map(|i| sc.spawn(move || replay(if i == 0 { r } else { &back_ref() }, level_map()))).collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    eprintln!("3 parallel replays of {} ticks: {:.1} s", r.end.tick, t.elapsed().as_secs_f64());
    let first = sums[0].clone().unwrap_or_else(|e| panic!("replay rejected: {e}"));
    for s in &sums {
        assert_eq!(s.as_ref().unwrap(), &first);
    }
    assert_eq!(first.final_hash, r.end.hash);
    let rec: Vec<String> = r.attempts.iter().map(|a| sim_core::mapsnap::hex(a.end_hash)).collect();
    assert_eq!(first.attempt_hashes, rec);
    assert_eq!((first.waves_won, first.phase, first.abandoned), (8, Phase::MatchWon, false));
}

/// The scripted record after a JSON round trip.
fn back_ref() -> &'static RunRecord {
    static B: OnceLock<RunRecord> = OnceLock::new();
    B.get_or_init(|| RunRecord::from_json(&scripted().to_json()).unwrap())
}

/// The golden record must keep replaying with the same hashes, and the
/// scripted match must keep recording exactly it.
#[test]
fn golden_run_record() {
    let path = fixture_path(GOLDEN);
    let bump = "bump SIM_RULES_VERSION (crates/sim-core/src/record.rs), regenerate the golden record with";
    if std::env::var_os("ZT_REGEN_GOLDEN").is_some() {
        let fresh = scripted();
        let got = golden_hashes(fresh);
        match pinned(SIM_RULES_VERSION) {
            // Same hashes (a record format change only): rewriting is safe.
            Some(p) if p == got => {}
            Some(p) => panic!(
                "refusing to regenerate {GOLDEN}: rules version {SIM_RULES_VERSION} is pinned to {p:?} in GOLDEN_HASHES, the sim now records {got:?}. \
                 The sim rules changed: {bump} `{REGEN}` and add the GOLDEN_HASHES entry it prints. Never edit an existing entry."
            ),
            None => eprintln!("add to GOLDEN_HASHES (crates/sim-core/tests/t4_records.rs): ({}, {:?}, {:?}, {:?}, {:?})", got.0, got.1, got.2, got.3, got.4),
        }
        std::fs::write(&path, fresh.to_json_pretty() + "\n").unwrap();
        eprintln!("wrote {path}");
        return;
    }
    let s = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}; generate it with `{REGEN}`"));
    let g = RunRecord::from_json(&s).unwrap();
    assert_eq!(g.sim.rules, SIM_RULES_VERSION, "the golden record is for sim rules version {}, the sim is version {}: regenerate it with `{REGEN}`", g.sim.rules, SIM_RULES_VERSION);
    let p = pinned(SIM_RULES_VERSION).unwrap_or_else(|| {
        panic!("no GOLDEN_HASHES entry for rules version {SIM_RULES_VERSION}: regenerate with `{REGEN}` and add the entry it prints")
    });
    assert_eq!(
        golden_hashes(&g),
        p,
        "{GOLDEN} differs from the GOLDEN_HASHES entry of rules version {SIM_RULES_VERSION} (rules, final, config, cards, map). \
         The fixture was regenerated without a version bump: restore it (git checkout), then {bump} `{REGEN}` and add the new entry"
    );
    let sum = replay(&g, level_map()).unwrap_or_else(|e| panic!("sim rules changed: {bump} `{REGEN}` and add the GOLDEN_HASHES entry it prints. Replaying {GOLDEN}: {e}"));
    assert_eq!(sum.final_hash, g.end.hash);
    assert_eq!(sum.attempts, g.attempts.len());
    let mut fresh = scripted().clone();
    fresh.sim = g.sim.clone();
    assert!(
        fresh.to_json() == g.to_json(),
        "the scripted match no longer records {GOLDEN} (the sim or the test script changed). If the sim changed: {bump} `{REGEN}` and add the GOLDEN_HASHES entry it prints"
    );
    // The summary echoes the setup and the map.
    assert_eq!((sum.setup.clone(), sum.map_source, sum.snapshot_hash), (g.setup.clone(), sim_core::record::MapSource::Level, g.map.snapshot_hash));
    assert_eq!(sum.shell_hash, sim_core::mapsnap::shell_hash(&g.map.shell));
}

/// The record's JSON layout (what T5 exports and T7 stores).
#[test]
fn record_json_layout() {
    let v: serde_json::Value = serde_json::from_str(&scripted().to_json()).unwrap();
    let keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    assert_eq!(keys, ["actions", "attempts", "cards_hash", "config_hash", "end", "format", "map", "setup", "sim"]);
    assert_eq!(v["format"], 1);
    assert_eq!(v["sim"]["rules"], SIM_RULES_VERSION);
    assert!(v["setup"]["seed"].is_string());
    assert_eq!(v["map"]["source"], "level");
    assert_eq!(v["map"]["shell"]["buildings"].as_array().unwrap().len(), 0);
    for k in ["config_hash", "cards_hash"] {
        assert_eq!(v[k].as_str().unwrap().len(), 16);
    }
    assert_eq!(v["attempts"][0]["result"], "abandoned");
    assert_eq!(v["actions"][0]["action"]["type"], "play_card");
    assert_eq!(v["end"]["phase"], "match_won");
}

// ------------------------------------------------------------ tampering

fn rejected(r: &RunRecord, map: ReplayMap) -> VerifyError {
    match replay(r, map) {
        Ok(_) => panic!("tampered record accepted"),
        Err(e) => e,
    }
}

/// The record of the scripted match stopped at match tick `t` (abandoned):
/// its actions before tick `t` applied, then stepped to `t`.
fn record_until(t: u64) -> RunRecord {
    let r = scripted();
    let n = r.actions.iter().position(|a| a.tick >= t).unwrap_or(r.actions.len());
    let mut m = match_before(r, n, false);
    while m.tick() < t {
        m.step();
    }
    RunRecord::from_match(&m)
}

/// A match rebuilt from `r`'s setup with actions `0..n` applied on their
/// ticks, then (`to_next`) stepped to action `n`'s tick.
fn match_before(r: &RunRecord, n: usize, to_next: bool) -> Match {
    let cfg = common::cfg();
    let mut m = Match::new(marais(), cfg, r.setup.to_setup()).unwrap();
    for a in &r.actions[..n] {
        while m.tick() < a.tick {
            m.step();
        }
        m.apply(a.action.clone()).unwrap();
    }
    if let Some(a) = r.actions.get(n).filter(|_| to_next) {
        while m.tick() < a.tick {
            m.step();
        }
    }
    m
}

/// The scripted match up to wave 3's prep (~5,000 ticks: wave 1's four
/// attempts and wave 2), for quick tests.
fn prefix() -> &'static RunRecord {
    static P: OnceLock<RunRecord> = OnceLock::new();
    P.get_or_init(|| record_until(scripted().attempts[4].end_tick + 10))
}

/// Index of the attempt playing at action tick `t` (prep or wave).
fn attempt_at(r: &RunRecord, t: u64) -> usize {
    r.attempts.iter().position(|a| a.end_tick > t).unwrap_or(r.attempts.len())
}

fn assert_diverged(e: VerifyError, attempt: usize, wave: u8) {
    match e {
        VerifyError::Diverged { attempt: a, wave: w, .. } if a == attempt && w == wave => {}
        e => panic!("expected a divergence at attempt {attempt} (wave {wave}), got {e:?}"),
    }
}

#[test]
fn a_truncated_record_verifies_as_abandoned() {
    let p = prefix();
    assert!(p.end.abandoned);
    assert_eq!((p.end.phase, p.end.wave), (Phase::Prep, 3));
    let s = replay(p, level_map()).unwrap();
    assert_eq!((s.waves_won, s.wave, s.abandoned), (2, 3, true));
    // The same, cut mid-wave.
    let a = &scripted().attempts[4];
    let mid = record_until(a.start_tick + (a.end_tick - a.start_tick) / 2);
    assert_eq!(mid.end.phase, Phase::Running);
    replay(&mid, level_map()).unwrap();
    // Without the abandon marker it is refused before any tick.
    let mut r = mid.clone();
    r.end.abandoned = false;
    assert_eq!(rejected(&r, level_map()), VerifyError::Unfinished { phase: Phase::Running, wave: mid.end.wave });
    let mut r = scripted().clone();
    r.end.abandoned = true;
    assert!(matches!(rejected(&r, level_map()), VerifyError::BadRecord { .. }));
}

/// A fence moved by 2 m (a legal play) in wave 3: the wave-3 attempt diverges.
#[test]
fn tamper_changed_action() {
    let r0 = scripted();
    let (i, t) = r0
        .actions
        .iter()
        .enumerate()
        .find(|(_, a)| matches!(a.action, Action::PlayCard { target: Target::Polyline(_), .. }) && r0.attempts[attempt_at(r0, a.tick)].wave >= 3)
        .map(|(i, a)| (i, a.tick))
        .expect("a fence play from wave 3 on");
    let mut r = r0.clone();
    if let Action::PlayCard { target: Target::Polyline(p), .. } = &mut r.actions[i].action {
        for q in p.iter_mut() {
            q[0] += 2.0;
        }
    }
    let k = attempt_at(r0, t);
    assert_diverged(rejected(&r, level_map()), k, r0.attempts[k].wave);
}

/// A tactical play 3 ticks late: its wave diverges.
#[test]
fn tamper_changed_tick() {
    let r0 = prefix();
    let i = (0..r0.actions.len() - 1)
        .find(|&i| {
            let a = &r0.actions[i];
            matches!(a.action, Action::PlayCard { target: Target::Point(_), .. }) && r0.actions[i + 1].tick > a.tick + 3 && r0.attempts[attempt_at(r0, a.tick)].end_tick > a.tick + 10
        })
        .expect("a tactical play");
    let mut r = r0.clone();
    r.actions[i].tick += 3;
    let k = attempt_at(r0, r0.actions[i].tick);
    assert_diverged(rejected(&r, level_map()), k, r0.attempts[k].wave);
}

#[test]
fn tamper_reordered_actions() {
    let mut r = prefix().clone();
    let i = (0..r.actions.len() - 1).find(|&i| r.actions[i].tick < r.actions[i + 1].tick).unwrap();
    r.actions.swap(i, i + 1);
    assert!(matches!(rejected(&r, level_map()), VerifyError::OutOfOrder { index, .. } if index == i + 1));
}

#[test]
fn tamper_card_not_in_hand() {
    let mut r = prefix().clone();
    let i = r.actions.iter().position(|a| matches!(a.action, Action::PlayCard { .. })).unwrap();
    if let Action::PlayCard { hand_index, .. } = &mut r.actions[i].action {
        *hand_index = 99;
    }
    match rejected(&r, level_map()) {
        VerifyError::IllegalAction { index, reason: ActionError::NoSuchCard { hand_index: 99 }, .. } => assert_eq!(index, i),
        e => panic!("{e:?}"),
    }
}

/// Index of the `n`-th StartWave of `r`.
fn nth_start(r: &RunRecord, n: usize) -> usize {
    r.actions.iter().enumerate().filter(|(_, a)| a.action == Action::StartWave).nth(n).unwrap().0
}

/// A tactical card played in prep (just before Start), and a repair while
/// the wave runs.
#[test]
fn tamper_wrong_phase() {
    let r0 = prefix();
    let s = nth_start(r0, 3);
    let m = match_before(r0, s, true);
    let h = m.hand().into_iter().find(|h| h.kind == CardKind::Tactical).expect("a tactical card in hand before Start");
    let c = m.center();
    let mut r = r0.clone();
    r.actions.insert(s, sim_core::match_::LoggedAction { tick: r0.actions[s].tick, action: Action::PlayCard { hand_index: h.hand_index, target: Target::Point(c) } });
    match rejected(&r, level_map()) {
        VerifyError::IllegalAction { index, reason: ActionError::CardWrongPhase { phase: Phase::Prep, .. }, .. } => assert_eq!(index, s),
        e => panic!("{e:?}"),
    }
    let mut r = r0.clone();
    r.actions.insert(s + 1, sim_core::match_::LoggedAction { tick: r0.actions[s].tick + 1, action: Action::Repair { fence_id: 1 } });
    match rejected(&r, level_map()) {
        VerifyError::IllegalAction { index, reason: ActionError::WrongPhase { phase: Phase::Running, .. }, .. } => assert_eq!(index, s + 1),
        e => panic!("{e:?}"),
    }
}

/// A prep card that costs more than the supply left: inserted before the
/// first prep play where the hand holds one.
#[test]
fn tamper_not_enough_supply() {
    let r0 = prefix();
    let cfg = common::cfg();
    let mut m = Match::new(marais(), cfg, r0.setup.to_setup()).unwrap();
    for (i, a) in r0.actions.iter().enumerate() {
        while m.tick() < a.tick {
            m.step();
        }
        if m.phase() == Phase::Prep {
            if let Some(h) = m.hand().into_iter().find(|h| h.kind != CardKind::Tactical && h.cost > m.supply()) {
                let target = match h.kind {
                    CardKind::Armament => Target::Buildings(vec![0]),
                    _ => Target::Polyline(vec![m.center(), [m.center()[0] + 10.0, m.center()[1]]]),
                };
                let mut r = r0.clone();
                r.actions.insert(i, sim_core::match_::LoggedAction { tick: a.tick, action: Action::PlayCard { hand_index: h.hand_index, target } });
                match rejected(&r, level_map()) {
                    VerifyError::IllegalAction { index, reason: ActionError::NotEnoughSupply { need, have }, .. } => {
                        assert_eq!((index, need, have), (i, h.cost, m.supply()));
                        return;
                    }
                    e => panic!("{e:?}"),
                }
            }
        }
        m.apply(a.action.clone()).unwrap();
    }
    panic!("no prep with a card over the supply left");
}

#[test]
fn tamper_edited_wave_hash() {
    let mut r = prefix().clone();
    r.attempts[2].end_hash ^= 1;
    match rejected(&r, level_map()) {
        VerifyError::Diverged { attempt: 2, wave: 1, what, .. } => assert_eq!(what, "end_hash"),
        e => panic!("{e:?}"),
    }
    // A dropped attempt, a wrong final hash, a wrong summary.
    let mut r = prefix().clone();
    r.attempts.remove(1);
    assert_diverged(rejected(&r, level_map()), 1, 1);
    let mut r = prefix().clone();
    r.end.hash ^= 1;
    assert!(matches!(rejected(&r, level_map()), VerifyError::Diverged { what, .. } if what == "final_hash"));
    let mut r = prefix().clone();
    r.end.waves_won = 5;
    assert!(matches!(rejected(&r, level_map()), VerifyError::Outcome { what, .. } if what == "waves_won"));
}

#[test]
fn tamper_seed_and_deck() {
    let mut r = prefix().clone();
    r.setup.seed += 1;
    match rejected(&r, level_map()) {
        VerifyError::Diverged { attempt: 0, wave: 1, tick: 0, what, .. } => assert_eq!(what, "prep_hash"),
        e => panic!("{e:?}"),
    }
    let mut r = prefix().clone();
    let g = r.setup.deck.iter().position(|c| c == "grenades").unwrap();
    r.setup.deck[g] = "light_fence".into();
    assert!(matches!(rejected(&r, level_map()), VerifyError::Diverged { attempt: 0, wave: 1, .. }));
    let mut r = prefix().clone();
    r.setup.deck.push("rifles".into());
    assert!(matches!(rejected(&r, level_map()), VerifyError::Setup { .. }));
    let mut r = prefix().clone();
    r.setup.population_multiplier = 0.31;
    assert!(matches!(rejected(&r, level_map()), VerifyError::Diverged { attempt: 0, wave: 1, .. }));
}

#[test]
fn tamper_versions_config_cards() {
    let p = prefix();
    let mut r = p.clone();
    r.format = 2;
    assert_eq!(rejected(&r, level_map()), VerifyError::Format { record: 2, verifier: 1 });
    let mut r = p.clone();
    r.sim.rules += 1;
    assert!(matches!(rejected(&r, level_map()), VerifyError::SimVersion { .. }));
    // A config or card change on the verifier's side.
    let mut cfg = common::cfg();
    cfg.zombie_speed += 0.01;
    let lim = ReplayLimits::for_config(&cfg);
    let e = replay_with(p, level_map(), None, cfg, CardDb::default_cards(), &lim, &mut |_| true).unwrap_err();
    assert!(matches!(e, VerifyError::ConfigHash { .. }), "{e:?}");
    let cfg = common::cfg();
    let mut cards = CardDb::default_cards();
    cards.cards[0].cost += 1;
    let e = replay_with(p, level_map(), None, cfg.clone(), cards, &lim, &mut |_| true).unwrap_err();
    assert!(matches!(e, VerifyError::CardsHash { .. }), "{e:?}");
    // The record's own hash edited.
    let mut r = p.clone();
    r.config_hash ^= 1;
    assert!(matches!(rejected(&r, level_map()), VerifyError::ConfigHash { .. }));
    let _ = Config::default_config();
}

#[test]
fn tamper_map() {
    let p = prefix();
    let mut level = marais().clone();
    level.buildings[17].polygon[0][0] += 0.01;
    assert!(matches!(rejected(p, ReplayMap::Level(&level)), VerifyError::MapHash { .. }));
    let mut level = marais().clone();
    level.radius_m = Some(390.0);
    assert_eq!(rejected(p, ReplayMap::Level(&level)), VerifyError::MapShell);
    assert_eq!(rejected(p, ReplayMap::Chunks { shell: &p.map.shell, chunks: &[] }), VerifyError::MapSource { record: sim_core::record::MapSource::Level });
}

#[test]
fn tamper_future_tick() {
    let mut r = prefix().clone();
    let n = r.actions.len();
    r.actions[n - 1].tick = r.end.tick + 1;
    assert!(matches!(rejected(&r, level_map()), VerifyError::FutureTick { index, .. } if index == n - 1));
}

// ------------------------------------------------------------ DoS bounds

#[test]
fn huge_logs_and_endless_records_are_refused_quickly() {
    let p = prefix();
    let mut r = p.clone();
    r.actions = vec![sim_core::match_::LoggedAction { tick: 0, action: Action::Mulligan }; 1_000_000];
    let t = Instant::now();
    assert!(matches!(rejected(&r, level_map()), VerifyError::Limit { what, .. } if what == "actions"));
    let mut r = p.clone();
    r.end.tick = 1_000_000_000_000;
    assert!(matches!(rejected(&r, level_map()), VerifyError::Limit { what, .. } if what == "ticks"));
    let mut r = p.clone();
    r.actions[0].action = Action::PlayCard { hand_index: 0, target: Target::Polyline(vec![[1.0, 1.0]; 100_000]) };
    assert!(matches!(rejected(&r, level_map()), VerifyError::Limit { what, .. } if what == "polyline points"));
    let mut r = p.clone();
    r.actions = (0..300).map(|_| sim_core::match_::LoggedAction { tick: 0, action: Action::RestartMatch }).collect();
    assert!(matches!(rejected(&r, level_map()), VerifyError::Limit { .. }));
    assert!(t.elapsed().as_millis() < 500, "{:?}", t.elapsed());
}

/// A wave that never ends, and a prep that lasts forever: stopped at the
/// per-phase limit (small limits here so the test is quick).
#[test]
fn endless_waves_and_preps_stop_at_the_limit() {
    let p = prefix();
    let cfg = common::cfg();
    let mut lim = ReplayLimits::for_config(&cfg);
    lim.max_wave_ticks = 300;
    lim.max_prep_ticks = 200;
    let t = Instant::now();
    let e = replay_with(p, level_map(), None, cfg.clone(), CardDb::default_cards(), &lim, &mut |_| true).unwrap_err();
    assert!(matches!(e, VerifyError::TooLong { phase: Phase::Running, ticks: 301, .. }), "{e:?}");
    // No action at all: prep forever.
    let mut r = p.clone();
    r.actions.clear();
    r.attempts.clear();
    (r.end.wave, r.end.attempt_start_tick, r.end.prep_hash) = (1, 0, p.attempts[0].prep_hash);
    let e = replay_with(&r, level_map(), None, cfg.clone(), CardDb::default_cards(), &lim, &mut |_| true).unwrap_err();
    assert!(matches!(e, VerifyError::TooLong { attempt: 0, wave: 1, phase: Phase::Prep, ticks: 201, .. }), "{e:?}");
    assert!(t.elapsed().as_secs_f64() < 5.0, "{:?}", t.elapsed());
    // Default limits: 30 min per wave at 20 Hz.
    assert_eq!(ReplayLimits::for_config(&cfg).max_wave_ticks, 36_000);
}

#[test]
fn the_progress_callback_can_cancel() {
    let p = prefix();
    let cfg = common::cfg();
    let lim = ReplayLimits::for_config(&cfg);
    let mut seen = Vec::new();
    let mut cb = |pr: ReplayProgress| {
        seen.push(pr.tick);
        pr.tick < 1000
    };
    let e = replay_with(p, level_map(), None, cfg, CardDb::default_cards(), &lim, &mut cb).unwrap_err();
    assert_eq!(e, VerifyError::Cancelled { tick: 1024 });
    assert_eq!(seen, [256, 512, 768, 1024]);
}

// ------------------------------------------------------------ streamed maps

#[derive(serde::Deserialize)]
struct ChunksMeta {
    center_lat: f64,
    center_lon: f64,
    level_radius_m: f32,
    initial_block_ids: Vec<u64>,
}

fn chunks_fixture() -> (LevelPack, Vec<u64>, Vec<BuildingChunk>) {
    let meta: ChunksMeta = serde_json::from_str(&std::fs::read_to_string(fixture_path("map_chunks.meta.json")).unwrap()).unwrap();
    let chunks: Vec<BuildingChunk> = serde_json::from_str(&std::fs::read_to_string(fixture_path("map_chunks.json")).unwrap()).unwrap();
    let shell = LevelPack { name: "map-chunks-fixture".into(), center_lat: meta.center_lat, center_lon: meta.center_lon, radius_m: Some(meta.level_radius_m), buildings: Vec::new(), fences: Vec::new(), bounds: None };
    (shell, meta.initial_block_ids, chunks)
}

/// Wave 1 played (retried once if lost), wave 2 for 300 ticks.
fn play_streamed(m: &mut Match) {
    let mut arc = 0;
    play_prep(m, &mut arc, false);
    steps(m, 10);
    m.apply(Action::StartWave).unwrap();
    if run_wave(m, true, 6000) == Phase::WaveLost {
        m.apply(Action::RetryWave).unwrap();
        play_prep(m, &mut arc, true);
        m.apply(Action::StartWave).unwrap();
        run_wave(m, true, 6000);
    }
    assert_eq!(m.phase(), Phase::WaveWon);
    m.apply(Action::NextWave).unwrap();
    play_prep(m, &mut arc, false);
    m.apply(Action::StartWave).unwrap();
    for _ in 0..300 {
        if m.wave_tick() % 40 == 39 {
            play_tactical(m);
        }
        m.step();
    }
}

/// The same match on streamed blocks, all given up front in block order, or
/// staged (waves 1-2 in reverse order, the rest in a shuffled order during
/// wave 1's prep): the same record hashes; the record verifies with the
/// chunks in any order and refuses a building moved by 1 cm.
#[test]
fn streamed_records_do_not_depend_on_chunk_order() {
    let (shell, initial_ids, chunks) = chunks_fixture();
    let cfg = common::cfg();
    let setup = MatchSetup::new(7, &cfg);
    let mut a = Match::new_streaming(&shell, cfg.clone(), setup.clone(), chunks.clone()).unwrap();
    play_streamed(&mut a);
    let ra = RunRecord::from_match(&a);
    assert_eq!(ra.map.source, sim_core::record::MapSource::Chunks);
    assert_eq!(ra.map.blocks.len(), chunks.len());

    let (mut initial, mut rest): (Vec<BuildingChunk>, Vec<BuildingChunk>) = chunks.iter().cloned().partition(|c| initial_ids.contains(&c.block_id));
    initial.reverse();
    let mut rng = sim_core::rng::Pcg32::new(3, 4);
    for i in (1..rest.len()).rev() {
        rest.swap(i, rng.below(i as u32 + 1) as usize);
    }
    let mut b = Match::new_streaming(&shell, cfg.clone(), setup, initial).unwrap();
    let mut pending = rest.into_iter();
    for la in &ra.actions {
        while b.tick() < la.tick {
            b.step();
            if let Some(c) = pending.next() {
                b.add_buildings(c).unwrap();
            }
        }
        b.apply(la.action.clone()).unwrap();
    }
    while b.tick() < ra.end.tick {
        b.step();
    }
    assert!(pending.next().is_none(), "every block arrived during wave 1's prep");
    let rb = RunRecord::from_match(&b);
    assert_eq!(rb.attempts, ra.attempts);
    assert_eq!((rb.end.hash, rb.map.snapshot_hash, &rb.map.blocks), (ra.end.hash, ra.map.snapshot_hash, &ra.map.blocks));
    assert_eq!(rb.to_json(), ra.to_json());

    let mut rev = chunks.clone();
    rev.reverse();
    let s = replay(&ra, ReplayMap::Chunks { shell: &shell, chunks: &rev }).unwrap();
    assert_eq!(s.final_hash, ra.end.hash);
    assert_eq!((s.map_source, s.snapshot_hash, s.shell_hash), (sim_core::record::MapSource::Chunks, ra.map.snapshot_hash, sim_core::mapsnap::shell_hash(&shell)));
    assert_eq!((s.wave, s.phase, s.abandoned), (2, Phase::Running, true));
    // One building moved by 1 cm; a missing block; a level for a chunks run.
    let mut moved = chunks.clone();
    let k = moved.iter().position(|c| !c.buildings.is_empty()).unwrap();
    moved[k].buildings[0].polygon[1][1] += 0.01;
    assert!(matches!(rejected(&ra, ReplayMap::Chunks { shell: &shell, chunks: &moved }), VerifyError::MapHash { .. }));
    let id = chunks[k].block_id;
    let fewer: Vec<BuildingChunk> = chunks.iter().filter(|c| c.block_id != id).cloned().collect();
    assert_eq!(rejected(&ra, ReplayMap::Chunks { shell: &shell, chunks: &fewer }), VerifyError::MissingBlock { block_id: id });
    assert!(matches!(rejected(&ra, ReplayMap::Level(marais())), VerifyError::MapSource { .. }));
}

/// A streamed record's shell is the server's, not the record's: a record
/// whose shell was forged (smaller radius, other centre, a free fence ring)
/// is refused against genuine chunks and the genuine shell, and a record
/// played on the forged shell is refused too.
#[test]
fn a_forged_chunk_shell_is_refused() {
    let (shell, _, chunks) = chunks_fixture();
    let r = streamed_prefix();
    let genuine = ReplayMap::Chunks { shell: &shell, chunks: &chunks };
    replay(r, genuine).unwrap();
    let ring: Vec<[f32; 2]> = (0..=64).map(|i| {
        let a = i as f32 * std::f32::consts::TAU / 64.0;
        [60.0 * a.cos(), 60.0 * a.sin()]
    }).collect();
    let forgeries: [(&str, fn(&mut LevelPack, &[[f32; 2]])); 4] = [
        ("radius", |s, _| s.radius_m = Some(160.0)),
        ("centre", |s, _| (s.center_lat, s.center_lon) = (0.0, 0.0)),
        ("fences", |s, ring| s.fences.push(ring.to_vec())),
        ("bounds", |s, _| s.bounds = Some([-100.0, -100.0, 100.0, 100.0])),
    ];
    for (what, forge) in forgeries {
        let mut f = r.clone();
        forge(&mut f.map.shell, &ring);
        assert_eq!(rejected(&f, genuine), VerifyError::MapShell, "forged {what}");
        // The forged shell given by the verifier: refused too (the record
        // was played on the genuine one).
        let mut forged_shell = shell.clone();
        forge(&mut forged_shell, &ring);
        assert_eq!(rejected(r, ReplayMap::Chunks { shell: &forged_shell, chunks: &chunks }), VerifyError::MapShell, "server shell {what}");
    }
}

/// Wave 1's prep and a few ticks of the streamed match (cheap).
fn streamed_prefix() -> &'static RunRecord {
    static R: OnceLock<RunRecord> = OnceLock::new();
    R.get_or_init(|| {
        let (shell, _, chunks) = chunks_fixture();
        let cfg = common::cfg();
        let mut m = Match::new_streaming(&shell, cfg.clone(), MatchSetup::new(7, &cfg), chunks).unwrap();
        let mut arc = 0;
        play_prep(&mut m, &mut arc, false);
        steps(&mut m, 10);
        m.apply(Action::StartWave).unwrap();
        steps(&mut m, 20);
        RunRecord::from_match(&m)
    })
}

/// A huge or far shell (bounds +-8 km, a fence with 100k points, 10k
/// fences, a 10^7 m fence, a NaN radius) is refused before any grid is
/// allocated, by the verifier (`bad_shell`) and by `Match::new_streaming`
/// itself (`BadShell`).
#[test]
fn oversized_shells_and_fences_are_refused_quickly() {
    let (shell, _, chunks) = chunks_fixture();
    let r = streamed_prefix();
    let cfg = common::cfg();
    let t = Instant::now();
    let big: [(&str, Box<dyn Fn(&mut LevelPack)>); 6] = [
        ("bounds", Box::new(|s| s.bounds = Some([-8000.0, -8000.0, 8000.0, 8000.0]))),
        ("far bounds", Box::new(|s| s.bounds = Some([1.0e6, 1.0e6, 1.0e6 + 100.0, 1.0e6 + 100.0]))),
        ("points", Box::new(|s| s.fences.push((0..100_000).map(|i| [(i % 100) as f32, (i / 100) as f32 * 0.1]).collect()))),
        ("fences", Box::new(|s| s.fences = vec![vec![[0.0, 0.0], [1.0, 1.0]]; 10_000])),
        ("length", Box::new(|s| s.fences = (0..200).map(|_| vec![[-2500.0, -2500.0], [2500.0, 2500.0], [-2500.0, 2500.0], [2500.0, -2500.0]]).collect())),
        ("radius", Box::new(|s| s.radius_m = Some(f32::NAN))),
    ];
    for (what, grow) in &big {
        let mut s = shell.clone();
        grow(&mut s);
        let mut f = r.clone();
        f.map.shell = s.clone();
        assert!(matches!(rejected(&f, ReplayMap::Chunks { shell: &s, chunks: &chunks }), VerifyError::BadShell { .. }), "{what}");
        match Match::new_streaming(&s, cfg.clone(), MatchSetup::new(7, &cfg), Vec::new()) {
            Err(MatchError::BadShell(_)) => {}
            Err(e) => panic!("{what}: {e:?}"),
            Ok(_) => panic!("{what}: built"),
        }
    }
    assert!(t.elapsed().as_millis() < 500, "{:?}", t.elapsed());
    // The defaults: 2.6 km extent, 256 fences of 1,024 points, ~131 km.
    let lim = sim_core::match_::ShellLimits::for_config(&cfg);
    assert_eq!((lim.max_extent_m, lim.max_fences, lim.max_fence_points, lim.max_fence_length_m.round()), (2600.0, 256, 1024, 130690.0));
}

/// The server's seed, deck and multiplier: a record with another one is
/// refused before any tick, even when it replays.
#[test]
fn the_issued_seed_deck_and_multiplier_are_enforced() {
    let p = prefix();
    let cfg = common::cfg();
    let lim = ReplayLimits::for_config(&cfg);
    let run = |x: &ExpectedRun| replay_with(p, level_map(), Some(x), cfg.clone(), CardDb::default_cards(), &lim, &mut |_| true);
    let issued = ExpectedRun { seed: Some(p.setup.seed), deck: Some(p.setup.deck.clone()), population_multiplier: Some(p.setup.population_multiplier) };
    let s = run(&issued).unwrap();
    assert_eq!(s.setup, p.setup);
    let t = Instant::now();
    let e = run(&ExpectedRun { seed: Some(p.setup.seed + 1), ..issued.clone() }).unwrap_err();
    assert!(matches!(&e, VerifyError::Unexpected { what, .. } if what == "seed"), "{e:?}");
    let mut deck = p.setup.deck.clone();
    deck.rotate_left(1);
    assert_ne!(deck, p.setup.deck);
    let e = run(&ExpectedRun { deck: Some(deck), ..issued.clone() }).unwrap_err();
    assert!(matches!(&e, VerifyError::Unexpected { what, .. } if what.starts_with("deck card ")), "{e:?}");
    let e = run(&ExpectedRun { population_multiplier: Some(p.setup.population_multiplier * 1.25), ..issued.clone() }).unwrap_err();
    assert!(matches!(&e, VerifyError::Unexpected { what, .. } if what == "population_multiplier"), "{e:?}");
    assert!(t.elapsed().as_millis() < 500, "{:?}", t.elapsed());
    // Only the seed given: the rest unchecked.
    run(&ExpectedRun { seed: Some(p.setup.seed), ..Default::default() }).unwrap();
    // JSON: the seed as a string or a number, unknown keys refused.
    let x = ExpectedRun::from_json(r#"{"seed": "18446744073709551615", "population_multiplier": 0.3}"#).unwrap();
    assert_eq!((x.seed, x.deck, x.population_multiplier), (Some(u64::MAX), None, Some(0.3)));
    assert_eq!(ExpectedRun::from_json(r#"{"seed": 3}"#).unwrap().seed, Some(3));
    assert!(ExpectedRun::from_json(r#"{"sede": 3}"#).is_err());
}

/// `population_multiplier` must be finite and within a quarter to four
/// times the config's: `Match::new` refuses others, and so does a replay.
#[test]
fn the_population_multiplier_is_range_checked() {
    let cfg = common::cfg();
    let (lo, hi) = sim_core::match_::population_multiplier_range(&cfg);
    assert_eq!((lo, hi), (cfg.match_.population_multiplier * 0.25, cfg.match_.population_multiplier * 4.0));
    for k in [0.0, -0.3, lo * 0.99, hi * 1.01, f32::NAN, f32::INFINITY, 0.05] {
        let mut setup = MatchSetup::new(1, &cfg);
        setup.population_multiplier = k;
        assert!(matches!(Match::new(marais(), cfg.clone(), setup), Err(MatchError::InvalidSetup(_))), "{k}");
    }
    for k in [lo, hi, cfg.match_.population_multiplier * 2.0] {
        let mut setup = MatchSetup::new(1, &cfg);
        setup.population_multiplier = k;
        Match::new(marais(), cfg.clone(), setup).unwrap();
    }
    let mut r = prefix().clone();
    r.setup.population_multiplier = 0.05;
    assert!(matches!(rejected(&r, level_map()), VerifyError::Setup { reason } if reason.contains("population_multiplier")));
}

/// A record that ends on a result screen: the open attempt's start tick and
/// prep hash in `end` are checked too.
#[test]
fn the_end_prep_hash_and_start_tick_are_checked_on_a_result_screen() {
    let r0 = record_until(scripted().attempts[4].end_tick);
    assert_eq!((r0.end.phase, r0.end.wave), (Phase::WaveWon, 2));
    replay(&r0, level_map()).unwrap();
    let mut r = r0.clone();
    r.end.prep_hash ^= 1;
    assert!(matches!(rejected(&r, level_map()), VerifyError::Diverged { attempt: 5, wave: 2, what, .. } if what == "prep_hash"));
    let mut r = r0.clone();
    r.end.attempt_start_tick += 1;
    assert!(matches!(rejected(&r, level_map()), VerifyError::Diverged { attempt: 5, wave: 2, what, .. } if what == "start_tick"));
    // And in prep (checked when the prep opened).
    let mut r = prefix().clone();
    r.end.prep_hash ^= 1;
    assert!(matches!(rejected(&r, level_map()), VerifyError::Diverged { what, .. } if what == "prep_hash"));
    let mut r = prefix().clone();
    r.end.attempt_start_tick += 1;
    assert!(matches!(rejected(&r, level_map()), VerifyError::Diverged { what, .. } if what == "start_tick"));
}

/// An extra field anywhere in the record is refused when parsing.
#[test]
fn unknown_record_fields_are_refused() {
    let json = prefix().to_json();
    RunRecord::from_json(&json).unwrap();
    let base: serde_json::Value = serde_json::from_str(&json).unwrap();
    for path in ["", "/sim", "/map", "/setup", "/end", "/end/waves/0", "/attempts/0", "/actions/0"] {
        let mut v = base.clone();
        v.pointer_mut(path).unwrap_or_else(|| panic!("{path}")).as_object_mut().unwrap().insert("extra".into(), serde_json::json!(1));
        let e = RunRecord::from_json(&v.to_string()).unwrap_err();
        assert!(e.contains("unknown field"), "{path}: {e}");
    }
}
