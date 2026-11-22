//! Native = WASM: `wasm-pack test --node crates/sim-wasm` reproduces the
//! native hash fixture for the same seed and level.
#![cfg(target_arch = "wasm32")]
use wasm_bindgen_test::*;

const LEVEL: &str = include_str!("../../../levels/paris-marais.json");
const FIXTURE: &str = include_str!("../../sim-core/tests/fixtures/native_hash.json");

#[wasm_bindgen_test]
fn wasm_hash_matches_native_fixture() {
    let h = sim_wasm::fixture_hash(LEVEL).unwrap();
    assert!(FIXTURE.contains(&h), "wasm hash {h} != native fixture {FIXTURE}");
}

#[wasm_bindgen_test]
fn wasm_sim_runs_and_reports() {
    let mut s = sim_wasm::WasmSim::new(LEVEL, "", 2000, 3).unwrap();
    s.start();
    s.step_untimed();
    let st = s.stats();
    assert_eq!(st[0] + st[1] + st[2], 2000.0);
}
