//! T6: the streaming-map fixture written by the JS loader
//! (`web/test/unit/fixture.test.ts`, `npm run fixtures:chunks`) works with
//! sim-core: waves 1–2 start a streaming match, the rest is accepted by
//! `add_buildings`, and the map snapshot hash recomputed here matches the
//! JS one (DECISIONS.md, "Map blocks (T6a)"; the hash is
//! `sim_core::mapsnap` since T4).
mod common;
use serde::Deserialize;
use sim_core::level::LevelPack;
use sim_core::mapsnap::{self, canonical_chunk, fnv1a64, hex, round_half_up};
use sim_core::match_::{BuildingChunk, Match, MatchSetup};

#[derive(Deserialize)]
struct Meta {
    center_lat: f64,
    center_lon: f64,
    level_radius_m: f32,
    block_margin_m: f32,
    ring_radii_m: Vec<f32>,
    initial_block_ids: Vec<u64>,
    initial_snapshot_hash: String,
    snapshot_hash: String,
    first_canonical_line: String,
}

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn load() -> (Meta, Vec<BuildingChunk>) {
    let meta: Meta = serde_json::from_str(&fixture("map_chunks.meta.json")).unwrap();
    let chunks: Vec<BuildingChunk> = serde_json::from_str(&fixture("map_chunks.json")).unwrap();
    (meta, chunks)
}

/// The level without buildings that the meta describes.
fn shell(meta: &Meta) -> LevelPack {
    LevelPack {
        name: "map-chunks-fixture".to_string(),
        center_lat: meta.center_lat,
        center_lon: meta.center_lon,
        radius_m: Some(meta.level_radius_m),
        buildings: Vec::new(),
        fences: Vec::new(),
        bounds: None,
    }
}

// The map snapshot hash lives in `sim_core::mapsnap` since T4; these tests
// keep it equal to the JS `snapshotHash`.

fn snapshot_hash(chunks: &[BuildingChunk]) -> String {
    hex(mapsnap::snapshot_hash(chunks).expect("unique block ids"))
}

#[test]
fn fnv1a64_known_vectors() {
    assert_eq!(hex(fnv1a64(b"")), "cbf29ce484222325");
    assert_eq!(hex(fnv1a64(b"a")), "af63dc4c8601ec8c");
    assert_eq!(hex(fnv1a64(b"foobar")), "85944171f73967e8");
    assert_eq!(round_half_up(-12.5), -12);
    assert_eq!(round_half_up(12.5), 13);
}

#[test]
fn fixture_matches_the_config() {
    let (meta, _) = load();
    let cfg = common::cfg();
    assert_eq!(meta.block_margin_m, cfg.match_.block_margin_m);
    assert_eq!(Match::ring_radii(&cfg, meta.level_radius_m), meta.ring_radii_m, "JS matchRingRadii vs Match::ring_radii");
}

#[test]
fn snapshot_hash_matches_js() {
    let (meta, chunks) = load();
    assert!(chunks.windows(2).all(|w| w[0].block_id < w[1].block_id), "fixture in block id order");
    assert_eq!(canonical_chunk(&chunks[0]), meta.first_canonical_line);
    assert_eq!(snapshot_hash(&chunks), meta.snapshot_hash);
    let initial: Vec<BuildingChunk> = chunks.iter().filter(|c| meta.initial_block_ids.contains(&c.block_id)).cloned().collect();
    assert_eq!(initial.len(), meta.initial_block_ids.len());
    assert_eq!(snapshot_hash(&initial), meta.initial_snapshot_hash);
    // Arrival order doesn't matter.
    let mut rev = chunks.clone();
    rev.reverse();
    assert_eq!(snapshot_hash(&rev), meta.snapshot_hash);
}

#[test]
fn streaming_match_from_the_fixture() {
    let (meta, chunks) = load();
    let cfg = common::cfg();
    let shell = shell(&meta);
    let (initial, rest): (Vec<BuildingChunk>, Vec<BuildingChunk>) = chunks.into_iter().partition(|c| meta.initial_block_ids.contains(&c.block_id));
    assert_eq!(initial.len(), meta.initial_block_ids.len());
    assert!(!rest.is_empty());
    assert!(initial.iter().map(|c| c.buildings.len()).sum::<usize>() > 100);
    let setup = MatchSetup::new(7, &cfg);
    let mut m = Match::new_streaming(&shell, cfg, setup, initial).unwrap();
    assert!(m.ring_ready(1));
    assert!(m.ring_ready(2));
    assert!(!m.ring_ready(3));
    for c in rest {
        let id = c.block_id;
        m.add_buildings(c).unwrap_or_else(|e| panic!("block {id}: {e}"));
    }
    for w in 1..=8 {
        assert!(m.ring_ready(w), "ring {w}");
    }
}
