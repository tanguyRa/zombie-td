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

/// `match --record` writes a run record that `verify` accepts; a tampered
/// copy is rejected (exit 1) and names the diverging attempt.
#[test]
fn recorded_match_verifies_and_tampering_is_rejected() {
    let dir = std::env::temp_dir().join(format!("zt-verify-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let run = dir.join("run.json");
    let bin = env!("CARGO_BIN_EXE_sim-headless");
    let out = Command::new(bin).args(["match", "--level", "paris-marais", "--seed", "2", "--retries", "1", "--max-wave-s", "300", "--record"]).arg(&run).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let level = concat!(env!("CARGO_MANIFEST_DIR"), "/../../levels/paris-marais.json");
    let out = Command::new(bin).arg("verify").arg(&run).args(["--level", level, "--quiet"]).output().unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{s}\n{}", String::from_utf8_lossy(&out.stderr));
    assert!(s.contains("verified: "), "{s}");
    // Edit the first attempt's end hash.
    let mut r: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&run).unwrap()).unwrap();
    let h = r["attempts"][0]["end_hash"].as_str().unwrap().to_string();
    let flipped = format!("{:016x}", u64::from_str_radix(&h, 16).unwrap() ^ 1);
    r["attempts"][0]["end_hash"] = serde_json::Value::String(flipped);
    let bad = dir.join("bad.json");
    std::fs::write(&bad, r.to_string()).unwrap();
    let out = Command::new(bin).arg("verify").arg(&bad).args(["--level", "paris-marais", "--quiet"]).output().unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{s}");
    assert!(s.contains("rejected: diverged at attempt 0 (wave 1)") && s.contains("end_hash"), "{s}");
    // Both or neither map argument: usage error.
    let out = Command::new(bin).arg("verify").arg(&run).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    std::fs::remove_dir_all(&dir).ok();
}
