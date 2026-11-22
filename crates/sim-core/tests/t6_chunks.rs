//! T6: the streaming-map fixture written by the JS loader
//! (`web/test/unit/fixture.test.ts`, `npm run fixtures:chunks`) works with
//! sim-core: waves 1–2 start a streaming match, the rest is accepted by
//! `add_buildings`, and the map snapshot hash recomputed here matches the
//! JS one (DECISIONS.md, "Map blocks (T6a)").
mod common;
use serde::Deserialize;
use sim_core::level::LevelPack;
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

// ------------------------------------------------- map snapshot hash (port)
// T4 will move this into sim-core; kept here until then.

/// FNV-1a 64 of `bytes` (offset 0xcbf29ce484222325, prime 0x100000001b3).
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Round half up, `floor(v + 0.5)`: the JS rule (`f64::round` differs on negative halves).
fn round_half_up(v: f64) -> i64 {
    (v + 0.5).floor() as i64
}

fn cm(v: f32) -> i64 {
    round_half_up(v as f64 * 100.0)
}

/// `[block_id,[x0,y0,x1,y1],[[id,"kind",floors_dm,[x,y,...]],...]]`, compact,
/// integer centimetres and tenths of floors, buildings in id order.
fn canonical_chunk(c: &BuildingChunk) -> String {
    let mut bs: Vec<_> = c.buildings.iter().collect();
    bs.sort_by_key(|b| b.id);
    let buildings: Vec<(u64, String, i64, Vec<i64>)> = bs
        .iter()
        .map(|b| {
            let kind = serde_json::to_value(b.kind).unwrap().as_str().unwrap().to_string();
            let pts = b.polygon.iter().flat_map(|&[x, y]| [cm(x), cm(y)]).collect();
            (b.id, kind, round_half_up(b.floors as f64 * 10.0), pts)
        })
        .collect();
    let bounds = [cm(c.bounds[0]), cm(c.bounds[1]), cm(c.bounds[2]), cm(c.bounds[3])];
    serde_json::to_string(&(c.block_id, bounds, buildings)).unwrap()
}

/// `"zt-map-v1\n"` then each chunk's canonical line + `"\n"`, ascending
/// block id; FNV-1a 64 as 16 lowercase hex digits.
fn snapshot_hash(chunks: &[BuildingChunk]) -> String {
    let mut sorted: Vec<&BuildingChunk> = chunks.iter().collect();
    sorted.sort_by_key(|c| c.block_id);
    let mut s = String::from("zt-map-v1\n");
    for (i, c) in sorted.iter().enumerate() {
        assert!(i == 0 || sorted[i - 1].block_id != c.block_id, "duplicate block {}", c.block_id);
        s.push_str(&canonical_chunk(c));
        s.push('\n');
    }
    format!("{:016x}", fnv1a64(s.as_bytes()))
}

#[test]
fn fnv1a64_known_vectors() {
    assert_eq!(format!("{:016x}", fnv1a64(b"")), "cbf29ce484222325");
    assert_eq!(format!("{:016x}", fnv1a64(b"a")), "af63dc4c8601ec8c");
    assert_eq!(format!("{:016x}", fnv1a64(b"foobar")), "85944171f73967e8");
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
