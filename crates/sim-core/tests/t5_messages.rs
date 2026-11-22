//! T5 review: `ActionError` messages are player-facing. Phases, card kinds
//! and target kinds read as words, never as Rust `Debug` names, and no
//! building, fence or structure index the player can't know is shown.
use sim_core::cards::{CardKind, TargetKind};
use sim_core::match_::{ActionError, Phase};

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
