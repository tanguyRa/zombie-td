//! Native = WASM: `wasm-pack test --node crates/sim-wasm` reproduces the
//! native hash fixture for the same seed and level.
#![cfg(target_arch = "wasm32")]
use wasm_bindgen_test::*;

const LEVEL: &str = include_str!("../../../levels/paris-marais.json");
const FIXTURE: &str = include_str!("../../sim-core/tests/fixtures/native_hash.json");
const MATCH_FIXTURE: &str = include_str!("../../sim-core/tests/fixtures/match_hash.json");
const FENCE_FIXTURE: &str = include_str!("../../sim-core/tests/fixtures/fence_break_hash.json");

#[wasm_bindgen_test]
fn wasm_hash_matches_native_fixture() {
    let h = sim_wasm::fixture_hash(LEVEL).unwrap();
    assert!(FIXTURE.contains(&h), "wasm hash {h} != native fixture {FIXTURE}");
}

/// The 8-wave match (two waves of it) is deterministic across native and WASM.
#[wasm_bindgen_test]
fn wasm_match_hash_matches_native_fixture() {
    let level = sim_core::LevelPack::from_json(LEVEL).unwrap();
    let h = format!("{:016x}", sim_core::fixture::compute_match_fixture_hash(&level));
    assert!(MATCH_FIXTURE.contains(&h), "wasm match hash {h} != native fixture {MATCH_FIXTURE}");
}

/// Fence breaks under field jobs in flight: same hash in WASM.
#[wasm_bindgen_test]
fn wasm_fence_break_hash_matches_native_fixture() {
    let (h, broken) = sim_core::fixture::compute_fence_fixture_hash();
    let h = format!("{h:016x}");
    assert!(broken > 25);
    assert!(FENCE_FIXTURE.contains(&h), "wasm fence-break hash {h} != native fixture {FENCE_FIXTURE}");
}

#[wasm_bindgen_test]
fn wasm_sim_runs_and_reports() {
    let mut s = sim_wasm::WasmSim::new(LEVEL, "", 2000, 3).unwrap();
    s.start();
    s.step_untimed();
    let st = s.stats();
    assert_eq!(st[0] + st[1] + st[2], 2000.0);
}

// ------------------------------------------------------------ T4 run records

const GOLDEN: &str = include_str!("../../sim-core/tests/fixtures/run_record_golden.json");

/// Native = WASM for a whole scripted 8-wave match: the golden run record
/// (recorded natively) verifies in WASM with every attempt hash equal.
#[wasm_bindgen_test]
fn wasm_verifies_the_golden_run_record() {
    let g = sim_core::RunRecord::from_json(GOLDEN).unwrap();
    let s: serde_json::Value = serde_json::from_str(&sim_wasm::verify_level(GOLDEN, LEVEL).unwrap()).unwrap();
    assert_eq!(s["final_hash"], format!("{:016x}", g.end.hash));
    let hashes: Vec<String> = g.attempts.iter().map(|a| format!("{:016x}", a.end_hash)).collect();
    assert_eq!(s["attempt_hashes"], serde_json::json!(hashes));
    assert_eq!(s["waves_won"], 8);
    assert_eq!(s["phase"], "match_won");
}

/// A tampered record is rejected in WASM with the error JSON.
#[wasm_bindgen_test]
fn wasm_rejects_a_tampered_record() {
    let mut g = sim_core::RunRecord::from_json(GOLDEN).unwrap();
    g.setup.seed += 1;
    let e = sim_wasm::verify_level(&g.to_json(), LEVEL).unwrap_err().as_string().unwrap();
    let v: serde_json::Value = serde_json::from_str(&e).unwrap();
    assert_eq!(v["error"], "diverged");
    assert_eq!(v["what"], "prep_hash");
    assert!(v["message"].as_str().unwrap().contains("wave 1"), "{e}");
    let e = sim_wasm::verify_chunks(GOLDEN, "[]").unwrap_err().as_string().unwrap();
    assert!(e.contains("map_source"), "{e}");
}

/// `WasmMatch` driven by the golden log's JSON actions reproduces its first
/// attempts and records them; refusals come back as `ActionError` JSON.
#[wasm_bindgen_test]
fn wasm_match_binding_follows_the_golden_log() {
    let g = sim_core::RunRecord::from_json(GOLDEN).unwrap();
    let setup = serde_json::json!({ "seed": g.setup.seed.to_string(), "population_multiplier": g.setup.population_multiplier, "deck": g.setup.deck }).to_string();
    let mut m = sim_wasm::WasmMatch::new(LEVEL, &setup).unwrap();
    assert_eq!(m.phase(), "prep");
    assert_eq!(m.building_at(-5.0, -5.0), -1);
    let e = m.apply(r#"{"type":"next_wave"}"#).unwrap_err().as_string().unwrap();
    assert!(e.contains("\"error\":\"wrong_phase\""), "{e}");
    let stop = g.attempts[2].end_tick;
    for a in g.actions.iter().take_while(|a| a.tick <= stop) {
        let t = m.tick() as u64;
        m.step((a.tick - t) as u32);
        m.apply(&serde_json::to_string(&a.action).unwrap()).unwrap();
    }
    let attempts: Vec<sim_core::match_::WaveAttempt> = serde_json::from_str(&m.attempts_json()).unwrap();
    assert_eq!(attempts, g.attempts[..3]);
    let rec = sim_core::RunRecord::from_json(&m.record()).unwrap();
    assert_eq!(rec.attempts, g.attempts[..3]);
    assert!(rec.end.abandoned);
    let st: serde_json::Value = serde_json::from_str(&m.status_json()).unwrap();
    assert_eq!(st["wave"], 1);
    assert!(m.count() > 0);
}
