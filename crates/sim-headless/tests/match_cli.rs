//! `sim-headless match` plays the 8-wave match with the starter deck.
//! Seed 1 on the Marais clears all 8 waves without a retry (DECISIONS.md,
//! "Cards (T3)", balance table).
use std::process::Command;

#[test]
fn scripted_starter_deck_match_clears_the_marais() {
    let out = Command::new(env!("CARGO_BIN_EXE_sim-headless")).args(["match", "--level", "paris-marais", "--seed", "1", "--retries", "3"]).output().expect("run sim-headless");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{s}\n{}", String::from_utf8_lossy(&out.stderr));
    assert!(s.contains("starter deck"), "{s}");
    let rows: Vec<&str> = s.lines().filter(|l| l.starts_with("| ") && l.as_bytes()[2].is_ascii_digit()).collect();
    assert_eq!(rows.len(), 8, "8 waves, no retry needed:\n{s}");
    assert!(rows.iter().all(|r| r.contains("| won |")), "{s}");
    assert!(s.contains("phase MatchWon at wave 8/8"), "{s}");
    // Cards were played every wave.
    for r in &rows {
        let cols: Vec<&str> = r.split('|').map(|c| c.trim()).collect();
        assert!(cols[11].parse::<u32>().unwrap() >= 1, "no card played: {r}");
    }
}
