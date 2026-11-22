//! Level packs (building polygons in local meters) and synthetic levels.

use crate::rng::Pcg32;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildingKind {
    Residential,
    Commercial,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Building {
    pub id: u64,
    pub kind: BuildingKind,
    pub floors: f32,
    /// Outer ring, local meters, not closed (first point not repeated).
    pub polygon: Vec<[f32; 2]>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LevelPack {
    pub name: String,
    #[serde(default)]
    pub center_lat: f64,
    #[serde(default)]
    pub center_lon: f64,
    /// Radius of the playable circle in meters (cells outside are walls).
    /// `None` for synthetic rectangular levels.
    #[serde(default)]
    pub radius_m: Option<f32>,
    pub buildings: Vec<Building>,
    /// Fences placed by the level itself (polylines, local meters).
    #[serde(default)]
    pub fences: Vec<Vec<[f32; 2]>>,
    /// Extra playable bounds for synthetic levels: [min_x, min_y, max_x, max_y].
    #[serde(default)]
    pub bounds: Option<[f32; 4]>,
}

impl LevelPack {
    pub fn from_json(s: &str) -> Result<LevelPack, String> {
        serde_json::from_str(s).map_err(|e| format!("level: {e}"))
    }
}

pub fn polygon_area(p: &[[f32; 2]]) -> f32 {
    let mut a = 0.0f64;
    for i in 0..p.len() {
        let [x0, y0] = p[i];
        let [x1, y1] = p[(i + 1) % p.len()];
        a += x0 as f64 * y1 as f64 - x1 as f64 * y0 as f64;
    }
    (a.abs() * 0.5) as f32
}

pub fn polygon_centroid(p: &[[f32; 2]]) -> [f32; 2] {
    let (mut cx, mut cy, mut a) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..p.len() {
        let [x0, y0] = p[i];
        let [x1, y1] = p[(i + 1) % p.len()];
        let c = x0 as f64 * y1 as f64 - x1 as f64 * y0 as f64;
        a += c;
        cx += (x0 as f64 + x1 as f64) * c;
        cy += (y0 as f64 + y1 as f64) * c;
    }
    if a.abs() < 1e-9 {
        let n = p.len().max(1) as f64;
        let sx: f64 = p.iter().map(|q| q[0] as f64).sum();
        let sy: f64 = p.iter().map(|q| q[1] as f64).sum();
        return [(sx / n) as f32, (sy / n) as f32];
    }
    [(cx / (3.0 * a)) as f32, (cy / (3.0 * a)) as f32]
}

pub fn point_in_polygon(x: f32, y: f32, p: &[[f32; 2]]) -> bool {
    let mut inside = false;
    let n = p.len();
    let mut j = n - 1;
    for i in 0..n {
        let [xi, yi] = p[i];
        let [xj, yj] = p[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Squared distance from a point to a polygon's boundary.
pub fn dist2_to_polygon_edge(x: f32, y: f32, p: &[[f32; 2]]) -> f32 {
    let mut best = f32::MAX;
    for i in 0..p.len() {
        let [ax, ay] = p[i];
        let [bx, by] = p[(i + 1) % p.len()];
        let (dx, dy) = (bx - ax, by - ay);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((x - ax) * dx + (y - ay) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (px, py) = (ax + t * dx - x, ay + t * dy - y);
        best = best.min(px * px + py * py);
    }
    best
}

fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<[f32; 2]> {
    vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

/// A regular grid of rectangular buildings separated by streets.
pub fn grid_city(n_blocks: u32, block_m: f32, street_m: f32, seed: u64) -> LevelPack {
    let mut rng = Pcg32::new(seed, 0x6772_6964);
    let mut buildings = Vec::new();
    let pitch = block_m + street_m;
    let mut id = 1;
    for by in 0..n_blocks {
        for bx in 0..n_blocks {
            let x0 = bx as f32 * pitch + street_m;
            let y0 = by as f32 * pitch + street_m;
            let kind = match rng.below(10) {
                0..=6 => BuildingKind::Residential,
                7..=8 => BuildingKind::Commercial,
                _ => BuildingKind::Other,
            };
            buildings.push(Building {
                id,
                kind,
                floors: (1 + rng.below(6)) as f32,
                polygon: rect(x0, y0, x0 + block_m, y0 + block_m),
            });
            id += 1;
        }
    }
    let size = n_blocks as f32 * pitch + street_m;
    LevelPack {
        name: format!("grid_city_{n_blocks}x{block_m}_{street_m}"),
        center_lat: 0.0,
        center_lon: 0.0,
        radius_m: None,
        buildings,
        fences: vec![],
        bounds: Some([0.0, 0.0, size, size]),
    }
}

/// An empty square with no buildings, for isolated rule tests.
pub fn open_field(size_m: f32) -> LevelPack {
    LevelPack {
        name: format!("open_field_{size_m}"),
        center_lat: 0.0,
        center_lon: 0.0,
        radius_m: None,
        buildings: vec![],
        fences: vec![],
        bounds: Some([0.0, 0.0, size_m, size_m]),
    }
}

/// Centre of the walled compound's open square (local meters).
pub const COMPOUND_CENTER: [f32; 2] = [100.0, 100.0];
/// Half-size of the compound's open interior.
pub const COMPOUND_HALF: f32 = 20.0;

/// A 40 × 40 m open square surrounded by a fence ring, with buildings outside.
pub fn walled_compound() -> LevelPack {
    let [cx, cy] = COMPOUND_CENTER;
    let h = COMPOUND_HALF + 1.0; // fence runs one cell outside the 40 m interior
    let ring = vec![[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h], [cx - h, cy - h]];
    let mut buildings = Vec::new();
    let mut id = 1;
    // A ring of 12 m buildings, 12 m streets, around the compound.
    let mut y = 10.0;
    while y < 190.0 {
        let mut x = 10.0;
        while x < 190.0 {
            let inside = (x + 12.0 > cx - h - 10.0 && x < cx + h + 10.0) && (y + 12.0 > cy - h - 10.0 && y < cy + h + 10.0);
            if !inside {
                buildings.push(Building {
                    id,
                    kind: BuildingKind::Residential,
                    floors: 2.0,
                    polygon: rect(x, y, x + 12.0, y + 12.0),
                });
                id += 1;
            }
            x += 24.0;
        }
        y += 24.0;
    }
    LevelPack {
        name: "walled_compound".into(),
        center_lat: 0.0,
        center_lon: 0.0,
        radius_m: None,
        buildings,
        fences: vec![ring],
        bounds: Some([0.0, 0.0, 200.0, 200.0]),
    }
}

/// `grid_city_disc` with a straight fence through the middle of every block
/// row and column, across the whole disc. Every street segment is fenced
/// once, so the city is sealed into one compartment per crossing: there is
/// no detour, zombies chew through to reach anyone (break-heavy benchmark
/// and tests).
pub fn grid_city_disc_fenced(radius_m: f32, block_m: f32, street_m: f32, seed: u64) -> LevelPack {
    let mut l = grid_city_disc(radius_m, block_m, street_m, seed);
    let pitch = block_m + street_m;
    // Same layout as `grid_city_disc`: block centres at
    // b * pitch + street + block / 2 - half.
    let n = ((2.0 * radius_m) / pitch).ceil() as u32 + 1;
    let half = (n as f32 * pitch + street_m) * 0.5;
    let r = radius_m;
    for b in 0..n {
        let c = b as f32 * pitch + street_m + block_m * 0.5 - half;
        if c.abs() >= r {
            continue;
        }
        l.fences.push(vec![[c, -r], [c, r]]);
        l.fences.push(vec![[-r, c], [r, c]]);
    }
    l.name = format!("grid_fenced_{radius_m}m");
    l
}

/// A `grid_city` centred on the origin and cut to a circle of `radius_m`,
/// for wave-8-sized benchmarks. Blocks whose centre is not at least half a
/// block inside the circle are dropped, so the edge is a street ring.
pub fn grid_city_disc(radius_m: f32, block_m: f32, street_m: f32, seed: u64) -> LevelPack {
    let pitch = block_m + street_m;
    let n = ((2.0 * radius_m) / pitch).ceil() as u32 + 1;
    let mut l = grid_city(n, block_m, street_m, seed);
    let half = (n as f32 * pitch + street_m) * 0.5;
    let keep = radius_m - block_m * 0.75;
    l.buildings.retain_mut(|b| {
        for p in b.polygon.iter_mut() {
            p[0] -= half;
            p[1] -= half;
        }
        let [cx, cy] = polygon_centroid(&b.polygon);
        cx * cx + cy * cy <= keep * keep
    });
    l.name = format!("grid_city_disc_{radius_m}m");
    l.radius_m = Some(radius_m);
    l.bounds = None;
    l
}
