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
    let s: serde_json::Value = serde_json::from_str(&sim_wasm::verify_level(GOLDEN, LEVEL, None).unwrap()).unwrap();
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
    let e = sim_wasm::verify_level(&g.to_json(), LEVEL, None).unwrap_err().as_string().unwrap();
    let v: serde_json::Value = serde_json::from_str(&e).unwrap();
    assert_eq!(v["error"], "diverged");
    assert_eq!(v["what"], "prep_hash");
    assert!(v["message"].as_str().unwrap().contains("wave 1"), "{e}");
    let shell = r#"{"name": "s", "radius_m": 400, "buildings": []}"#;
    let e = sim_wasm::verify_chunks(GOLDEN, shell, "[]", None).unwrap_err().as_string().unwrap();
    assert!(e.contains("map_source"), "{e}");
}

/// The issued seed, deck and multiplier (`expected_json`) in WASM.
#[wasm_bindgen_test]
fn wasm_checks_the_issued_run() {
    // Checked before any tick: the golden record is refused at once.
    let r = sim_core::RunRecord::from_json(GOLDEN).unwrap();
    let e = sim_wasm::verify_level(&r.to_json(), LEVEL, Some(r#"{"seed": "999"}"#.into())).unwrap_err().as_string().unwrap();
    let v: serde_json::Value = serde_json::from_str(&e).unwrap();
    assert_eq!((v["error"].as_str(), v["what"].as_str()), (Some("unexpected"), Some("seed")), "{e}");
    let e = sim_wasm::verify_level(&r.to_json(), LEVEL, Some(r#"{"population_multiplier": 0.6}"#.into())).unwrap_err().as_string().unwrap();
    assert!(e.contains("\"what\":\"population_multiplier\""), "{e}");
    let e = sim_wasm::verify_level(&r.to_json(), LEVEL, Some(r#"{"seeed": 1}"#.into())).unwrap_err().as_string().unwrap();
    assert!(e.contains("bad_expected"), "{e}");
    // Only `undefined` means no expectation: an empty string, `null` or an
    // object with no field would switch every check off, so they're refused.
    for x in ["", "  ", "null", "{}", " { } "] {
        let e = sim_wasm::verify_level(&r.to_json(), LEVEL, Some(x.into())).unwrap_err().as_string().unwrap();
        let v: serde_json::Value = serde_json::from_str(&e).unwrap();
        assert_eq!(v["error"], "bad_expected", "{x:?}: {e}");
    }
    let e = sim_wasm::verify_level(&r.to_json(), LEVEL, Some("{}".into())).unwrap_err().as_string().unwrap();
    assert!(e.contains("no field given"), "{e}");
}

/// `setup_checked`: whether the summary's setup was compared with an
/// issued run on **all** of seed, deck and multiplier; `checked` says which
/// fields were (WASM and native agree; `None` = nothing checked). A partial
/// expectation (a server that forgot a field) is not `setup_checked`.
#[wasm_bindgen_test]
fn wasm_summary_says_whether_the_setup_was_checked() {
    let r = sim_core::RunRecord::from_json(GOLDEN).unwrap();
    let summary = |x: Option<String>| -> serde_json::Value { serde_json::from_str(&sim_wasm::verify_level(GOLDEN, LEVEL, x).unwrap()).unwrap() };
    let seed_only = summary(Some(format!(r#"{{"seed": "{}"}}"#, r.setup.seed)));
    assert_eq!(seed_only["setup_checked"], false);
    assert_eq!(seed_only["checked"], serde_json::json!({ "seed": true, "deck": false, "population_multiplier": false }));
    let no_deck = summary(Some(format!(r#"{{"seed": "{}", "population_multiplier": {}}}"#, r.setup.seed, r.setup.population_multiplier)));
    assert_eq!(no_deck["setup_checked"], false);
    assert_eq!(no_deck["checked"], serde_json::json!({ "seed": true, "deck": false, "population_multiplier": true }));
    let all = summary(Some(serde_json::json!({ "seed": r.setup.seed.to_string(), "deck": r.setup.deck, "population_multiplier": r.setup.population_multiplier }).to_string()));
    assert_eq!(all["setup_checked"], true);
    assert_eq!(all["checked"], serde_json::json!({ "seed": true, "deck": true, "population_multiplier": true }));
    let none = summary(None);
    assert_eq!(none["setup_checked"], false);
    assert_eq!(none["checked"], serde_json::json!({ "seed": false, "deck": false, "population_multiplier": false }));
}

const CHUNKS: &str = include_str!("../../sim-core/tests/fixtures/map_chunks.json");
const CHUNKS_META: &str = include_str!("../../sim-core/tests/fixtures/map_chunks.meta.json");

/// A streamed run verifies with the server's shell and chunks in WASM; a
/// forged shell in the record (or a different server shell) is refused.
#[wasm_bindgen_test]
fn wasm_verifies_streamed_runs_on_the_servers_shell() {
    let meta: serde_json::Value = serde_json::from_str(CHUNKS_META).unwrap();
    let shell_with = |radius: serde_json::Value| serde_json::json!({ "name": "chunks", "center_lat": meta["center_lat"], "center_lon": meta["center_lon"], "radius_m": radius, "buildings": [] }).to_string();
    let shell = shell_with(meta["level_radius_m"].clone());
    let mut m = sim_wasm::WasmMatch::new_streaming(&shell, r#"{"seed": 7}"#, CHUNKS).unwrap();
    m.step(30);
    m.apply(r#"{"type":"start_wave"}"#).unwrap();
    m.step(30);
    let rec = m.record();
    let s: serde_json::Value = serde_json::from_str(&sim_wasm::verify_chunks(&rec, &shell, CHUNKS, Some(r#"{"seed": "7"}"#.into())).unwrap()).unwrap();
    assert_eq!(s["map_source"], "chunks");
    assert_eq!(s["setup"]["seed"], "7");
    assert_eq!(s["shell_hash"].as_str().unwrap().len(), 16);
    let mut forged: serde_json::Value = serde_json::from_str(&rec).unwrap();
    forged["map"]["shell"]["radius_m"] = serde_json::json!(160.0);
    let e = sim_wasm::verify_chunks(&forged.to_string(), &shell, CHUNKS, None).unwrap_err().as_string().unwrap();
    assert!(e.contains("\"error\":\"map_shell\""), "{e}");
    let other = shell_with(serde_json::json!(160.0));
    let e = sim_wasm::verify_chunks(&rec, &other, CHUNKS, None).unwrap_err().as_string().unwrap();
    assert!(e.contains("\"error\":\"map_shell\""), "{e}");
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

/// `validate_deck` (sim-core's rules, marshalled) gives the errors of the
/// shared fixture, which the web unit test (`deck_wasm.test.ts`) checks
/// against the TS mirror: the core and the mirror agree on the t3 cases.
#[wasm_bindgen_test]
fn wasm_validate_deck_matches_the_cases() {
    let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("fixtures/deck_cases.json")).unwrap();
    assert!(cases.len() >= 12);
    for c in &cases {
        let got: serde_json::Value = serde_json::from_str(&sim_wasm::validate_deck(&c["deck"].to_string()).unwrap()).unwrap();
        assert_eq!(got, c["errors"], "case {}", c["name"]);
    }
    let e = sim_wasm::validate_deck("{}").unwrap_err().as_string().unwrap();
    assert!(e.contains("\"error\":\"bad_deck\""), "{e}");
}

/// The replay viewer's `WasmMatch` (replay mode): it plays the golden
/// record to the end in slices with every check passing, stops at a wave's
/// prep when asked, refuses actions, and reports the first divergence of a
/// tampered record.
#[wasm_bindgen_test]
fn wasm_replay_mode_plays_the_golden_record() {
    let rec = sim_core::RunRecord::from_json(GOLDEN).unwrap();
    let mut w = sim_wasm::WasmMatch::replay_level(GOLDEN, LEVEL).unwrap();
    assert!(w.is_replay());
    assert!(w.apply(r#"{"type":"start_wave"}"#).is_err(), "a replay is read-only");
    let mut checks = Vec::new();
    let out = loop {
        let o: serde_json::Value = serde_json::from_str(&w.replay_run(1500, u32::MAX, 0.0, 0).unwrap()).unwrap();
        checks.extend(o["checks"].as_array().unwrap().iter().cloned());
        if o["done"] == true {
            break o;
        }
    };
    assert!(out["error"].is_null(), "{out}");
    assert_eq!(out["summary"]["final_hash"], format!("{:016x}", rec.end.hash));
    assert_eq!(out["tick"], rec.end.tick);
    let n = rec.attempts.len();
    // A won match has no attempt open at its end.
    assert_eq!(checks.len(), 2 * n + 1, "a prep and an end per attempt, then the final check");
    assert_eq!(checks.last().unwrap()["what"], "final");
    for (i, a) in rec.attempts.iter().enumerate() {
        let end = checks.iter().find(|c| c["what"] == "end" && c["attempt"] == i).unwrap();
        assert_eq!(end["hash"], format!("{:016x}", a.end_hash));
    }
    // Jump: stop as wave 3's prep opens.
    let mut w = sim_wasm::WasmMatch::replay_level(GOLDEN, LEVEL).unwrap();
    let o: serde_json::Value = serde_json::from_str(&w.replay_run(u32::MAX, u32::MAX, 0.0, 3).unwrap()).unwrap();
    assert_eq!(o["stopped_at_wave"], true, "{o}");
    assert_eq!((w.wave(), w.phase()), (3, "prep".to_string()));
    // A tampered attempt hash: the error names it, and stays.
    let mut bad = rec.clone();
    bad.attempts[1].end_hash ^= 1;
    let mut w = sim_wasm::WasmMatch::replay_level(&bad.to_json(), LEVEL).unwrap();
    let o: serde_json::Value = serde_json::from_str(&w.replay_run(u32::MAX, u32::MAX, 0.0, 0).unwrap()).unwrap();
    assert_eq!((o["done"].clone(), o["error"]["error"].clone(), o["error"]["attempt"].clone(), o["error"]["what"].clone()), (true.into(), "diverged".into(), 1.into(), "end_hash".into()), "{o}");
    assert!(o["error"]["message"].as_str().unwrap().contains("attempt 1"));
    // A normal match is not a replay.
    let mut m = sim_wasm::WasmMatch::new(LEVEL, r#"{"seed": 1}"#).unwrap();
    assert!(!m.is_replay() && m.replay_run(1, 1, 0.0, 0).is_err());
}
