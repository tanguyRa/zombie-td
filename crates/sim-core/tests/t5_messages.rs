//! T5 review: `ActionError` messages are player-facing. Phases, card kinds
//! and target kinds read as words, never as Rust `Debug` names, and no
//! building, fence or structure index the player can't know is shown. The
//! verifier's, deck rules' and match setup's messages read as words too.
mod common;
use sim_core::cards::{CardKind, DeckError, Rarity, TargetKind};
use sim_core::match_::{Action, ActionError, Match, MatchError, MatchSetup, Phase, Target};
use sim_core::record::{MapSource, VerifyError};

/// Rifles played on the same (unknown) building twice, in a real match:
/// the core's placement reason.
fn same_building_twice() -> ActionError {
    let cfg = common::cfg();
    let setup = MatchSetup::new(2, &cfg);
    let mut m = Match::new(&common::level("paris-marais"), cfg, setup).unwrap();
    let rifles = m.hand().iter().find(|c| c.card == "rifles").expect("seed 2's first hand holds rifles").hand_index;
    let sim = m.sim();
    let b = (0..sim.grid.buildings.len() as u32)
        .find(|&b| {
            let i = &sim.grid.buildings[b as usize];
            i.cell_count > 0 && m.wave_of_point(i.centroid[0], i.centroid[1]) <= m.wave()
        })
        .expect("a revealed building");
    m.apply(Action::PlayCard { hand_index: rifles, target: Target::Buildings(vec![b, b]) }).unwrap_err()
}

#[test]
fn phase_and_kind_names_read_as_words() {
    let tactical = ActionError::CardWrongPhase { card: "grenades".into(), kind: CardKind::Tactical, phase: Phase::Prep };
    assert_eq!(tactical.to_string(), "grenades is a tactical card: it can only be played during a wave, not during prep");
    let fence = ActionError::CardWrongPhase { card: "light_fence".into(), kind: CardKind::Fortification, phase: Phase::Running };
    assert_eq!(fence.to_string(), "light_fence is a fortification card: it can only be played during prep, not during a wave in progress");
    let wrong = ActionError::WrongPhase { action: "pull_down".into(), phase: Phase::Running };
    assert_eq!(wrong.to_string(), "pull down is not allowed during a wave in progress");
    assert_eq!(ActionError::WrongTarget { card: "rifles".into(), expected: TargetKind::Buildings }.to_string(), "rifles must target buildings");
    assert_eq!(ActionError::WrongTarget { card: "light_fence".into(), expected: TargetKind::Polyline }.to_string(), "light_fence must target a line");
    assert_eq!(ActionError::WrongTarget { card: "grenades".into(), expected: TargetKind::Point }.to_string(), "grenades must target a point");
}

#[test]
fn no_debug_names_or_hidden_indices() {
    let phases = [Phase::Prep, Phase::Running, Phase::WaveWon, Phase::WaveLost, Phase::MatchWon];
    let mut all = vec![
        ActionError::NotRevealed { building: 4711 },
        ActionError::AlreadyGarrisoned { building: 4711 },
        ActionError::NoSuchCard { hand_index: 4711 },
        ActionError::DuplicateIndex { hand_index: 4711 },
        ActionError::NoSuchStructure { placement_id: 4711 },
        ActionError::NoSuchFence { fence_id: 4711 },
        ActionError::NothingToRepair { fence_id: 4711 },
    ];
    let twice = same_building_twice();
    assert_eq!(twice.to_string(), "the same building is chosen twice");
    all.push(twice);
    for p in phases {
        all.push(ActionError::WrongPhase { action: "start_wave".into(), phase: p });
        for k in [CardKind::Fortification, CardKind::Armament, CardKind::Tactical] {
            all.push(ActionError::CardWrongPhase { card: "x".into(), kind: k, phase: p });
        }
    }
    for e in &all {
        let m = e.to_string();
        assert!(!m.contains("4711"), "index in {m:?}");
        for debug in ["Prep", "Running", "WaveWon", "WaveLost", "MatchWon", "Fortification", "Armament", "Tactical", "Buildings", "Polyline", "Point", "_"] {
            assert!(!m.contains(debug), "{debug:?} in {m:?}");
        }
    }
}

#[test]
fn verifier_deck_and_setup_messages_read_as_words() {
    let debug_names = ["Prep", "Running", "WaveWon", "WaveLost", "MatchWon", "Common", "Uncommon", "Rare", "Legendary", "Level", "Chunks", "(\"", "{ ", "_"];
    let check = |m: String| {
        for d in debug_names {
            assert!(!m.contains(d), "{d:?} in {m:?}");
        }
        m
    };
    assert_eq!(
        check(VerifyError::TooLong { attempt: 0, wave: 1, phase: Phase::Running, ticks: 301, max: 300 }.to_string()),
        "attempt 0 (wave 1) stayed in a wave in progress for 301 ticks, the limit is 300"
    );
    assert_eq!(check(VerifyError::TooLong { attempt: 2, wave: 3, phase: Phase::Prep, ticks: 201, max: 200 }.to_string()), "attempt 2 (wave 3) stayed in prep for 201 ticks, the limit is 200");
    for p in [Phase::Prep, Phase::Running, Phase::WaveWon, Phase::WaveLost, Phase::MatchWon] {
        check(VerifyError::Unfinished { phase: p, wave: 2 }.to_string());
        check(VerifyError::TooLong { attempt: 0, wave: 2, phase: p, ticks: 1, max: 0 }.to_string());
    }
    assert_eq!(
        check(VerifyError::Unfinished { phase: Phase::Running, wave: 2 }.to_string()),
        "the record ends in a wave in progress at wave 2 without being marked abandoned"
    );
    check(VerifyError::MapSource { record: MapSource::Level }.to_string());
    check(VerifyError::MapSource { record: MapSource::Chunks }.to_string());
    for r in [Rarity::Common, Rarity::Uncommon, Rarity::Rare, Rarity::Legendary] {
        check(DeckError::TooManyCopies { card: "x".into(), rarity: r, copies: 4, max: 3 }.to_string());
    }
    assert_eq!(
        check(DeckError::TooManyCopies { card: "rifles".into(), rarity: Rarity::Common, copies: 4, max: 3 }.to_string()),
        "4 copies of \"rifles\": at most 3 of a common card"
    );
    let errs = [
        MatchError::InvalidConfig("x".into()),
        MatchError::NoPlayArea,
        MatchError::LevelHasBuildings,
        MatchError::DuplicateBlock(7),
        MatchError::BadChunk(7),
        MatchError::AreaRevealed(7),
        MatchError::BuildingOutsideBlock { block_id: 7, building_id: 8 },
        MatchError::RingNotLoaded(1),
        MatchError::InvalidDeck(vec![DeckError::WrongSize { size: 19, expected: 20 }, DeckError::UnknownCard { card: "x".into() }]),
        MatchError::InvalidSetup("x".into()),
        MatchError::BadShell("x".into()),
    ];
    for e in errs {
        check(e.to_string());
    }
    assert_eq!(
        MatchError::InvalidDeck(vec![DeckError::WrongSize { size: 19, expected: 20 }, DeckError::UnknownCard { card: "x".into() }]).to_string(),
        "invalid deck: a deck has exactly 20 cards, this one has 19; unknown card \"x\""
    );
    tampered_golden_diverges_in_words(&check);
}

/// The verifier's `Diverged` messages from real tampered records (the golden
/// record with one attempt result flipped, one attempt dropped, one added)
/// name attempt results as words: "won", "lost", "abandoned", never
/// `Won`, `Lost`, `Abandoned`. `check` (no Debug names, no `_`) applies to
/// the result messages; the attempt-count ones name `extra_attempt` and
/// `missing_attempt`, so they only get the result-name check.
fn tampered_golden_diverges_in_words(check: &dyn Fn(String) -> String) {
    use sim_core::match_::AttemptResult::{self, Abandoned, Lost, Won};
    use sim_core::record::{ReplayMap, RunRecord};
    let path = format!("{}/tests/fixtures/run_record_golden.json", env!("CARGO_MANIFEST_DIR"));
    let golden = RunRecord::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let level = common::level("paris-marais");
    let words = |r: AttemptResult| r.to_string();
    assert_eq!([words(Won), words(Lost), words(Abandoned)], ["won", "lost", "abandoned"]);
    // (what, "record / replay", the whole message)
    let diverged = |rec: &RunRecord| -> (String, String, String) {
        let err = sim_core::replay(rec, ReplayMap::Level(&level)).unwrap_err();
        let msg = err.to_string();
        for d in ["Won", "Lost", "Abandoned", "Some(", "{ "] {
            assert!(!msg.contains(d), "{d:?} in {msg:?}");
        }
        match err {
            VerifyError::Diverged { what, record, replay, .. } => {
                assert!(msg.contains(&record) && msg.contains(&replay), "{msg:?}");
                (what, format!("{record} / {replay}"), msg)
            }
            e => panic!("expected Diverged, got {e}"),
        }
    };
    // One attempt result flipped, for each result the golden record holds.
    for (from, to) in [(Won, Lost), (Lost, Abandoned), (Abandoned, Won)] {
        let mut rec = golden.clone();
        let i = rec.attempts.iter().position(|a| a.result == from).unwrap_or_else(|| panic!("no {from} attempt in the golden record"));
        rec.attempts[i].result = to;
        let (what, vals, msg) = diverged(&rec);
        assert_eq!((what.as_str(), vals), ("result", format!("{to} / {from}")));
        check(msg);
    }
    // The last attempt dropped: the replay finishes one more.
    let mut rec = golden.clone();
    let last = rec.attempts.pop().unwrap();
    let (what, vals, _) = diverged(&rec);
    assert_eq!((what.as_str(), vals), ("extra_attempt", format!("none / {} at tick {}", last.result, last.end_tick)));
    // An attempt added: the replay never finishes it.
    let mut rec = golden.clone();
    rec.attempts.push(last.clone());
    let (what, vals, _) = diverged(&rec);
    assert_eq!((what.as_str(), vals), ("missing_attempt", format!("{} at tick {} / none", last.result, last.end_tick)));
}
