//! Rasterized level: a uniform grid of 2 m cells built from the level's polygons.

use crate::config::Config;
use crate::field::{self, Mode};
use crate::level::{self, BuildingKind, LevelPack};

pub const WALK: u8 = 0;
pub const BUILDING: u8 = 1;
pub const WALL: u8 = 2;
pub const FENCE: u8 = 3;

pub const NO_BUILDING: u32 = u32::MAX;

#[derive(Clone, Debug)]
pub struct BuildingInfo {
    pub id: u64,
    pub kind: BuildingKind,
    pub floors: f32,
    pub area_m2: f32,
    /// Centroid in sim coordinates (meters from the grid origin).
    pub centroid: [f32; 2],
    /// Polygon in sim coordinates.
    pub polygon: Vec<[f32; 2]>,
    pub cell_count: u32,
}

#[derive(Clone, Debug)]
pub struct Grid {
    pub w: usize,
    pub h: usize,
    pub cell: f32,
    /// Level-local coordinates of the grid's (0, 0) corner.
    pub origin: [f32; 2],
    pub kind: Vec<u8>,
    pub building: Vec<u32>,
    pub fence_hp: Vec<f32>,
    pub buildings: Vec<BuildingInfo>,
    /// Walkable cells removed because they were cut off from the main area.
    pub enclosed_cells_removed: u32,
    /// Per-cell bit masks of allowed steps (bit d: the step in `field::DIRS[d]`
    /// passes `field::step_allowed`), for zombies (`Mode::Chase`) and civilians
    /// (`Mode::Flee`). Border cells are 0. Kept in sync by `set_kind`; call
    /// `rebuild_step_masks` after writing `kind` directly.
    pub step_chase: Vec<u8>,
    pub step_flee: Vec<u8>,
    /// Bumped whenever `kind` changes through `set_kind` or the masks are
    /// rebuilt, so caches derived from `kind` know when to refresh.
    pub version: u32,
}

impl Grid {
    pub fn from_level(level: &LevelPack, cfg: &Config) -> Grid {
        let cell = cfg.cell_size_m;
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        let mut extend = |x: f32, y: f32| {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        };
        for b in &level.buildings {
            for &[x, y] in &b.polygon {
                extend(x, y);
            }
        }
        if let Some(r) = level.radius_m {
            extend(-r, -r);
            extend(r, r);
        }
        if let Some([bx0, by0, bx1, by1]) = level.bounds {
            extend(bx0, by0);
            extend(bx1, by1);
        }
        if level.buildings.is_empty() && level.radius_m.is_none() && level.bounds.is_none() {
            extend(0.0, 0.0);
            extend(100.0, 100.0);
        }
        let m = cfg.grid_margin_m;
        let ox = ((x0 - m) / cell).floor() * cell;
        let oy = ((y0 - m) / cell).floor() * cell;
        let w = (((x1 + m) - ox) / cell).ceil() as usize + 1;
        let h = (((y1 + m) - oy) / cell).ceil() as usize + 1;
        let n = w * h;
        let mut g = Grid {
            w,
            h,
            cell,
            origin: [ox, oy],
            kind: vec![WALK; n],
            building: vec![NO_BUILDING; n],
            fence_hp: vec![0.0; n],
            buildings: Vec::with_capacity(level.buildings.len()),
            enclosed_cells_removed: 0,
            step_chase: vec![0; n],
            step_flee: vec![0; n],
            version: 0,
        };

        // Walls: grid border, outside the circle, outside synthetic bounds.
        for cy in 0..h {
            for cx in 0..w {
                let i = cy * w + cx;
                let (lx, ly) = (ox + (cx as f32 + 0.5) * cell, oy + (cy as f32 + 0.5) * cell);
                let border = cx == 0 || cy == 0 || cx == w - 1 || cy == h - 1;
                let outside_circle = level.radius_m.map_or(false, |r| lx * lx + ly * ly > r * r);
                let outside_bounds = level
                    .bounds
                    .map_or(false, |[bx0, by0, bx1, by1]| lx < bx0 || ly < by0 || lx > bx1 || ly > by1);
                if border || outside_circle || outside_bounds {
                    g.kind[i] = WALL;
                }
            }
        }

        // Buildings: a cell belongs to a building if its centre is inside the polygon.
        for (bi, b) in level.buildings.iter().enumerate() {
            let (info, cells) = g.rasterize_building(b, &g.kind);
            for &c in &cells {
                g.kind[c] = BUILDING;
                g.building[c] = bi as u32;
            }
            g.buildings.push(info);
        }

        g.remove_enclosed_areas();

        for f in &level.fences {
            let pts: Vec<[f32; 2]> = f.iter().map(|&[x, y]| [x - ox, y - oy]).collect();
            let cells = g.rasterize_polyline(&pts);
            for c in cells {
                if g.kind[c] == WALK {
                    g.kind[c] = FENCE;
                    g.fence_hp[c] = cfg.fence_cell_hp;
                }
            }
        }
        g.rebuild_step_masks();
        g
    }

    /// A building's info (polygon moved to sim coordinates) and the cells
    /// whose centre is inside its polygon, skipping cells that are `WALL` in
    /// `kind`. Does not modify the grid.
    pub fn rasterize_building(&self, b: &level::Building, kind: &[u8]) -> (BuildingInfo, Vec<usize>) {
        let (ox, oy, cell, w, h) = (self.origin[0], self.origin[1], self.cell, self.w, self.h);
        let poly: Vec<[f32; 2]> = b.polygon.iter().map(|&[x, y]| [x - ox, y - oy]).collect();
        let (mut px0, mut py0, mut px1, mut py1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &[x, y] in &poly {
            px0 = px0.min(x);
            py0 = py0.min(y);
            px1 = px1.max(x);
            py1 = py1.max(y);
        }
        let mut cells = Vec::new();
        if px1 >= 0.0 && py1 >= 0.0 && !poly.is_empty() {
            let cx0 = ((px0 / cell).floor().max(0.0)) as usize;
            let cy0 = ((py0 / cell).floor().max(0.0)) as usize;
            let cx1 = ((px1 / cell).ceil() as usize).min(w - 1);
            let cy1 = ((py1 / cell).ceil() as usize).min(h - 1);
            for cy in cy0..=cy1 {
                for cx in cx0..=cx1 {
                    let i = cy * w + cx;
                    if kind[i] == WALL {
                        continue;
                    }
                    let (x, y) = ((cx as f32 + 0.5) * cell, (cy as f32 + 0.5) * cell);
                    if level::point_in_polygon(x, y, &poly) {
                        cells.push(i);
                    }
                }
            }
        }
        let info = BuildingInfo {
            id: b.id,
            kind: b.kind,
            floors: b.floors,
            area_m2: level::polygon_area(&b.polygon),
            centroid: level::polygon_centroid(&poly),
            polygon: poly,
            cell_count: cells.len() as u32,
        };
        (info, cells)
    }

    /// Keep every 4-connected region of cells passing `open` that contains a
    /// cell of `anchor`; cells passing `wall` in the other regions become
    /// walls. Without any open anchor cell, `keep_largest_region`. Returns
    /// how many cells were walled. A match passes the cells open before a
    /// reveal, so the territory already played is never walled off, however
    /// large an unconnected region of the new ring is (T2 review).
    pub fn keep_regions_touching(&mut self, open: impl Fn(u8) -> bool, wall: impl Fn(u8) -> bool, anchor: &[bool]) -> u32 {
        let n = self.w * self.h;
        debug_assert_eq!(anchor.len(), n);
        if !(0..n).any(|c| anchor[c] && open(self.kind[c])) {
            return self.keep_largest_region(open, wall);
        }
        // Flood from every open anchor cell; whatever is not reached is cut off.
        let mut kept = vec![false; n];
        let mut stack: Vec<usize> = (0..n).filter(|&c| anchor[c] && open(self.kind[c])).collect();
        for &c in &stack {
            kept[c] = true;
        }
        while let Some(c) = stack.pop() {
            for nb in [c - 1, c + 1, c - self.w, c + self.w] {
                if !kept[nb] && open(self.kind[nb]) {
                    kept[nb] = true;
                    stack.push(nb);
                }
            }
        }
        let mut walled = 0;
        for i in 0..n {
            if !kept[i] && open(self.kind[i]) && wall(self.kind[i]) {
                self.kind[i] = WALL;
                walled += 1;
            }
        }
        walled
    }

    /// Keep only the largest 4-connected region of cells passing `open`
    /// (ties: the first found in index order); open cells elsewhere become
    /// walls. Returns how many cells were walled.
    pub fn keep_largest_region(&mut self, open: impl Fn(u8) -> bool, wall: impl Fn(u8) -> bool) -> u32 {
        let n = self.w * self.h;
        let mut comp = vec![u32::MAX; n];
        let mut stack = Vec::new();
        let mut best = (0u32, 0usize);
        let mut id = 0u32;
        for start in 0..n {
            if !open(self.kind[start]) || comp[start] != u32::MAX {
                continue;
            }
            let mut size = 0usize;
            comp[start] = id;
            stack.push(start);
            while let Some(c) = stack.pop() {
                size += 1;
                for nb in [c - 1, c + 1, c - self.w, c + self.w] {
                    if open(self.kind[nb]) && comp[nb] == u32::MAX {
                        comp[nb] = id;
                        stack.push(nb);
                    }
                }
            }
            if size > best.1 {
                best = (id, size);
            }
            id += 1;
        }
        let mut walled = 0;
        for i in 0..n {
            if comp[i] != u32::MAX && comp[i] != best.0 && wall(self.kind[i]) {
                self.kind[i] = WALL;
                walled += 1;
            }
        }
        walled
    }

    fn masks_at(&self, c: usize) -> (u8, u8) {
        let off = field::offsets(self.w);
        let (mut mc, mut mf) = (0u8, 0u8);
        for d in 0..8 {
            if field::step_allowed(&self.kind, c, d, &off, Mode::Chase) {
                mc |= 1 << d;
            }
            if field::step_allowed(&self.kind, c, d, &off, Mode::Flee) {
                mf |= 1 << d;
            }
        }
        (mc, mf)
    }

    /// Recompute every cell's step masks from `kind`.
    pub fn rebuild_step_masks(&mut self) {
        self.version = self.version.wrapping_add(1);
        for cy in 1..self.h - 1 {
            for cx in 1..self.w - 1 {
                let c = cy * self.w + cx;
                let (mc, mf) = self.masks_at(c);
                self.step_chase[c] = mc;
                self.step_flee[c] = mf;
            }
        }
    }

    /// Change a cell's kind and refresh the masks of the cells around it (a
    /// cell's mask depends only on its 8 neighbours).
    pub fn set_kind(&mut self, c: usize, k: u8) {
        if self.kind[c] == k {
            return;
        }
        self.kind[c] = k;
        self.version = self.version.wrapping_add(1);
        let (cx, cy) = (c % self.w, c / self.w);
        for y in cy.saturating_sub(1).max(1)..=(cy + 1).min(self.h - 2) {
            for x in cx.saturating_sub(1).max(1)..=(cx + 1).min(self.w - 2) {
                let i = y * self.w + x;
                let (mc, mf) = self.masks_at(i);
                self.step_chase[i] = mc;
                self.step_flee[i] = mf;
            }
        }
    }

    /// Keep only the largest 4-connected walkable region; small pockets fully
    /// enclosed by buildings become walls so nobody spawns where zombies can't go.
    fn remove_enclosed_areas(&mut self) {
        let n = self.w * self.h;
        let mut comp = vec![u32::MAX; n];
        let mut stack = Vec::new();
        let mut best = (0u32, 0usize);
        let mut sizes = Vec::new();
        for start in 0..n {
            if self.kind[start] != WALK || comp[start] != u32::MAX {
                continue;
            }
            let id = sizes.len() as u32;
            let mut size = 0usize;
            comp[start] = id;
            stack.push(start);
            while let Some(c) = stack.pop() {
                size += 1;
                for nb in [c - 1, c + 1, c - self.w, c + self.w] {
                    if self.kind[nb] == WALK && comp[nb] == u32::MAX {
                        comp[nb] = id;
                        stack.push(nb);
                    }
                }
            }
            sizes.push(size);
            if size > best.1 {
                best = (id, size);
            }
        }
        for i in 0..n {
            if self.kind[i] == WALK && comp[i] != best.0 {
                self.kind[i] = WALL;
                self.enclosed_cells_removed += 1;
            }
        }
    }

    #[inline]
    pub fn cell_of(&self, x: f32, y: f32) -> usize {
        let cx = (x / self.cell) as usize;
        let cy = (y / self.cell) as usize;
        cy.min(self.h - 1) * self.w + cx.min(self.w - 1)
    }

    #[inline]
    pub fn walkable(&self, i: usize) -> bool {
        self.kind[i] == WALK
    }

    #[inline]
    pub fn walkable_at(&self, x: f32, y: f32) -> bool {
        x >= 0.0 && y >= 0.0 && self.kind[self.cell_of(x, y)] == WALK
    }

    pub fn cell_center(&self, i: usize) -> [f32; 2] {
        [((i % self.w) as f32 + 0.5) * self.cell, ((i / self.w) as f32 + 0.5) * self.cell]
    }

    /// Bresenham rasterization of a polyline (sim coordinates). Diagonal steps
    /// get an extra orthogonal cell so the result is 4-connected (no gaps).
    pub fn rasterize_polyline(&self, pts: &[[f32; 2]]) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        let to_cell = |p: [f32; 2]| -> (i64, i64) { ((p[0] / self.cell).floor() as i64, (p[1] / self.cell).floor() as i64) };
        // Duplicates are removed at the end (first occurrence kept).
        let push = |x: i64, y: i64, out: &mut Vec<usize>| {
            if x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h {
                out.push(y as usize * self.w + x as usize);
            }
        };
        if pts.len() == 1 {
            let (x, y) = to_cell(pts[0]);
            push(x, y, &mut out);
        }
        for s in pts.windows(2) {
            let (mut x, mut y) = to_cell(s[0]);
            let (x1, y1) = to_cell(s[1]);
            let dx = (x1 - x).abs();
            let dy = -(y1 - y).abs();
            let sx = if x < x1 { 1 } else { -1 };
            let sy = if y < y1 { 1 } else { -1 };
            let mut err = dx + dy;
            push(x, y, &mut out);
            while x != x1 || y != y1 {
                let e2 = 2 * err;
                let step_x = e2 >= dy;
                let step_y = e2 <= dx;
                if step_x && step_y {
                    // Diagonal step: fill the corner so the fence has no gap.
                    push(x + sx, y, &mut out);
                }
                if step_x {
                    err += dy;
                    x += sx;
                }
                if step_y {
                    err += dx;
                    y += sy;
                }
                push(x, y, &mut out);
            }
        }
        dedup_keep_first(out)
    }

    /// The nearest `WALK` cell to `c` in the square rings `1..max_r` around
    /// it (Chebyshev distance r): the first ring holding one, and in it the
    /// smallest squared distance, then the lowest index. Walks only each
    /// ring's perimeter, clipped to the grid, and stops once a ring lies
    /// wholly outside, so a full-grid search is O(cells), also on a grid
    /// with no walkable cell (None). The scan of the whole (2r+1)^2 square
    /// per ring made it cubic (T2 review); same result, tie order included.
    pub fn nearest_walk_within(&self, c: usize, max_r: i64) -> Option<usize> {
        let (w, h) = (self.w as i64, self.h as i64);
        let (cx, cy) = (c as i64 % w, c as i64 / w);
        let mut best: Option<(i64, usize)> = None;
        let visit = |x: i64, y: i64, best: &mut Option<(i64, usize)>| {
            let i = (y * w + x) as usize;
            if self.kind[i] == WALK {
                let (dx, dy) = (x - cx, y - cy);
                let d = dx * dx + dy * dy;
                if best.map_or(true, |(bd, bi)| d < bd || (d == bd && i < bi)) {
                    *best = Some((d, i));
                }
            }
        };
        for r in 1..max_r {
            let (x0, x1) = ((cx - r).max(0), (cx + r).min(w - 1));
            // Top and bottom rows (full width), when inside the grid.
            for y in [cy - r, cy + r] {
                if (0..h).contains(&y) {
                    for x in x0..=x1 {
                        visit(x, y, &mut best);
                    }
                }
            }
            // Left and right columns, without the corners.
            let (y0, y1) = ((cy - r + 1).max(0), (cy + r - 1).min(h - 1));
            for x in [cx - r, cx + r] {
                if (0..w).contains(&x) {
                    for y in y0..=y1 {
                        visit(x, y, &mut best);
                    }
                }
            }
            if let Some((_, i)) = best {
                return Some(i);
            }
            if cx - r <= 0 && cy - r <= 0 && cx + r >= w - 1 && cy + r >= h - 1 {
                return None; // later rings lie wholly outside the grid
            }
        }
        None
    }

    pub fn walkable_count(&self) -> usize {
        self.kind.iter().filter(|&&k| k == WALK).count()
    }
}

/// Remove repeated values, keeping each first occurrence in place
/// (O(n log n), no allocation proportional to the grid).
fn dedup_keep_first(v: Vec<usize>) -> Vec<usize> {
    let mut order: Vec<u32> = (0..v.len() as u32).collect();
    order.sort_unstable_by_key(|&k| (v[k as usize], k));
    let mut keep = vec![false; v.len()];
    for (n, &k) in order.iter().enumerate() {
        keep[k as usize] = n == 0 || v[order[n - 1] as usize] != v[k as usize];
    }
    v.iter().zip(&keep).filter(|(_, &k)| k).map(|(&c, _)| c).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Pcg32;

    /// The search before the T2 review: the whole (2r+1)^2 square per ring.
    fn nearest_walk_reference(g: &Grid, c: usize, max_r: i64) -> Option<usize> {
        let (cx, cy) = ((c % g.w) as i64, (c / g.w) as i64);
        for r in 1..max_r {
            let mut best: Option<(i64, usize)> = None;
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let (x, y) = (cx + dx, cy + dy);
                    if x < 0 || y < 0 || x >= g.w as i64 || y >= g.h as i64 {
                        continue;
                    }
                    let i = y as usize * g.w + x as usize;
                    if g.kind[i] == WALK {
                        let d = dx * dx + dy * dy;
                        if best.map_or(true, |(bd, bi)| d < bd || (d == bd && i < bi)) {
                            best = Some((d, i));
                        }
                    }
                }
            }
            if let Some((_, i)) = best {
                return Some(i);
            }
        }
        None
    }

    fn grid(w: usize, h: usize, kind: Vec<u8>) -> Grid {
        let n = w * h;
        Grid {
            w,
            h,
            cell: 2.0,
            origin: [0.0, 0.0],
            kind,
            building: vec![NO_BUILDING; n],
            fence_hp: vec![0.0; n],
            buildings: Vec::new(),
            enclosed_cells_removed: 0,
            step_chase: vec![0; n],
            step_flee: vec![0; n],
            version: 0,
        }
    }

    #[test]
    fn nearest_walk_matches_the_full_square_search() {
        let mut rng = Pcg32::new(7, 1);
        for t in 0..400 {
            let w = 1 + (rng.next_u32() % 40) as usize;
            let h = 1 + (rng.next_u32() % 40) as usize;
            // From dense to nearly empty grids, some with no walkable cell.
            let p = [0, 1, 5, 30, 200, 1000][t % 6];
            let kind = (0..w * h).map(|_| if rng.next_u32() % 1000 < p { WALK } else { [BUILDING, WALL, FENCE][(rng.next_u32() % 3) as usize] }).collect();
            let g = grid(w, h, kind);
            for _ in 0..20 {
                let c = (rng.next_u32() as usize) % (w * h);
                for max_r in [0, 1, 2, 5, 32, w.max(h) as i64 + 1, 100] {
                    assert_eq!(g.nearest_walk_within(c, max_r), nearest_walk_reference(&g, c, max_r), "{w}x{h} p={p} c={c} max_r={max_r}");
                }
            }
        }
        // Equal distances: the lowest index wins, as before.
        let mut kind = vec![WALL; 25];
        for i in [7, 11, 13, 17] {
            kind[i] = WALK;
        }
        assert_eq!(grid(5, 5, kind).nearest_walk_within(12, 32), Some(7));
        // No walkable cell at all: None, from anywhere, even with a huge range.
        let g = grid(300, 200, vec![WALL; 60_000]);
        for c in [0, 150, 59_999, 30_123] {
            assert_eq!(g.nearest_walk_within(c, 1_000_000), None);
        }
    }
}
