//! The map snapshot hash of a run record: a canonical content hash of the
//! building chunks a match used. It must equal the browser's
//! `snapshotHash` (`web/src/map/chunks.ts`); the algorithm is in
//! DECISIONS.md, "Map blocks (T6a)", and `tests/t6_chunks.rs` checks it
//! against the JS fixture.
//!
//! A whole level (`Match::new`) has no block grid: its snapshot is the hash
//! of one chunk with block id 0, bounds `[0, 0, 0, 0]` and every building of
//! the level (`level_snapshot_hash`). See DECISIONS.md, "Run records (T4)".

use crate::level::{BuildingKind, LevelPack};
use crate::match_::BuildingChunk;

/// FNV-1a 64 (offset 0xcbf29ce484222325, prime 0x100000001b3).
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// A hash as the record writes it: 16 lowercase hex digits.
pub fn hex(h: u64) -> String {
    format!("{h:016x}")
}

/// Round half up, `floor(v + 0.5)`: the JS rule. `f64::round` differs on
/// negative halves (-12.5 -> -13, JS gives -12).
pub fn round_half_up(v: f64) -> i64 {
    (v + 0.5).floor() as i64
}

fn cm(v: f32) -> i64 {
    round_half_up(v as f64 * 100.0)
}

fn kind_name(k: BuildingKind) -> &'static str {
    match k {
        BuildingKind::Residential => "residential",
        BuildingKind::Commercial => "commercial",
        BuildingKind::Other => "other",
    }
}

/// `[block_id,[x0,y0,x1,y1],[[id,"kind",floors_dm,[x,y,...]],...]]`, compact
/// JSON, integer centimetres and tenths of floors, buildings in id order.
pub fn canonical_chunk(c: &BuildingChunk) -> String {
    let mut bs: Vec<_> = c.buildings.iter().collect();
    bs.sort_by_key(|b| b.id);
    let buildings: Vec<(u64, &str, i64, Vec<i64>)> = bs
        .iter()
        .map(|b| {
            let pts = b.polygon.iter().flat_map(|&[x, y]| [cm(x), cm(y)]).collect();
            (b.id, kind_name(b.kind), round_half_up(b.floors as f64 * 10.0), pts)
        })
        .collect();
    let bounds = [cm(c.bounds[0]), cm(c.bounds[1]), cm(c.bounds[2]), cm(c.bounds[3])];
    serde_json::to_string(&(c.block_id, bounds, buildings)).expect("canonical chunk serialises")
}

/// `"zt-map-v1\n"` then each chunk's canonical line + `"\n"` in ascending
/// block id order, FNV-1a 64. Arrival order does not matter. `Err(id)` for a
/// block id given twice.
pub fn snapshot_hash(chunks: &[BuildingChunk]) -> Result<u64, u64> {
    let mut sorted: Vec<&BuildingChunk> = chunks.iter().collect();
    sorted.sort_by_key(|c| c.block_id);
    let mut s = String::from("zt-map-v1\n");
    for (i, c) in sorted.iter().enumerate() {
        if i > 0 && sorted[i - 1].block_id == c.block_id {
            return Err(c.block_id);
        }
        s.push_str(&canonical_chunk(c));
        s.push('\n');
    }
    Ok(fnv1a64(s.as_bytes()))
}

/// The snapshot of a whole level: `snapshot_hash` of one chunk, block id 0,
/// bounds `[0, 0, 0, 0]`, holding every building of the level. (`Match::new`
/// wraps the level as block 0 with unbounded bounds, which have no
/// centimetre form; the zeros stand for "no block grid".)
pub fn level_snapshot_hash(level: &LevelPack) -> u64 {
    let c = BuildingChunk { block_id: 0, bounds: [0.0; 4], buildings: level.buildings.clone() };
    snapshot_hash(std::slice::from_ref(&c)).expect("one chunk")
}

/// The hash of a shell as the verifier compares it (bit for bit: centre,
/// radius, bounds, fences; the name and the buildings don't count):
/// FNV-1a 64 of `"zt-shell-v1\n"`, then lines `c <lat bits> <lon bits>`,
/// `r <radius bits>|-`, `b <4 bounds bits>|-`, then one `f <point bits>...`
/// line per fence, bits in lowercase hex (`f64` 16 digits, `f32` 8).
/// Two shells have the same hash exactly when the verifier takes one for
/// the other (up to FNV collisions).
pub fn shell_hash(shell: &LevelPack) -> u64 {
    use std::fmt::Write;
    let mut s = String::from("zt-shell-v1\n");
    let _ = writeln!(s, "c {:016x} {:016x}", shell.center_lat.to_bits(), shell.center_lon.to_bits());
    match shell.radius_m {
        Some(r) => writeln!(s, "r {:08x}", r.to_bits()),
        None => writeln!(s, "r -"),
    }
    .unwrap();
    match shell.bounds {
        Some(b) => writeln!(s, "b {:08x} {:08x} {:08x} {:08x}", b[0].to_bits(), b[1].to_bits(), b[2].to_bits(), b[3].to_bits()),
        None => writeln!(s, "b -"),
    }
    .unwrap();
    for f in &shell.fences {
        s.push('f');
        for p in f {
            let _ = write!(s, " {:08x} {:08x}", p[0].to_bits(), p[1].to_bits());
        }
        s.push('\n');
    }
    fnv1a64(s.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a64_known_vectors() {
        assert_eq!(hex(fnv1a64(b"")), "cbf29ce484222325");
        assert_eq!(hex(fnv1a64(b"a")), "af63dc4c8601ec8c");
        assert_eq!(hex(fnv1a64(b"foobar")), "85944171f73967e8");
        assert_eq!(round_half_up(-12.5), -12);
        assert_eq!(round_half_up(12.5), 13);
    }

    #[test]
    fn duplicate_block_is_refused() {
        let c = BuildingChunk { block_id: 4, bounds: [0.0, 0.0, 10.0, 10.0], buildings: Vec::new() };
        assert_eq!(snapshot_hash(&[c.clone(), c]), Err(4));
    }
}
