//! Flow fields (Dijkstra maps) on the cell grid, computed with a bucket queue
//! (Dial's algorithm). 8-connected, straight step 10, diagonal 14.

use crate::grid::{Grid, BUILDING, FENCE, WALK, WALL};

pub const INF: i32 = i32::MAX / 4;
pub const STRAIGHT: i32 = 10;
pub const DIAGONAL: i32 = 14;

/// Neighbour order: 4 straight, then 4 diagonal. Fixed, so ties break the
/// same way everywhere.
pub const DIRS: [(i32, i32); 8] = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)];
const H: f32 = std::f32::consts::FRAC_1_SQRT_2;
/// Unit vectors matching `DIRS`.
pub const DIR_UNIT: [[f32; 2]; 8] = [[1.0, 0.0], [-1.0, 0.0], [0.0, 1.0], [0.0, -1.0], [H, H], [-H, H], [H, -H], [-H, -H]];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Zombies (chase and threat fields): fences are passable at an extra cost.
    Chase,
    /// Civilians (flee field): fences are impassable.
    Flee,
}

#[inline]
fn enter_cost(kind: u8, mode: Mode, fence_cost: i32) -> i32 {
    match kind {
        WALK => 0,
        FENCE if mode == Mode::Chase => fence_cost,
        _ => -1,
    }
}

#[inline]
fn blocks_corner(kind: u8, mode: Mode) -> bool {
    kind == BUILDING || kind == WALL || (kind == FENCE && mode == Mode::Flee)
}

/// Offsets of the 8 neighbours for a grid of width `w`.
#[inline]
pub fn offsets(w: usize) -> [isize; 8] {
    let w = w as isize;
    [1, -1, w, -w, w + 1, w - 1, -w + 1, -w - 1]
}

/// Whether the step from `c` in direction `d` is allowed in `mode`
/// (target passable; diagonals may not cut a blocked corner).
#[inline]
pub fn step_allowed(kind: &[u8], c: usize, d: usize, off: &[isize; 8], mode: Mode) -> bool {
    let n = (c as isize + off[d]) as usize;
    let k = kind[n];
    if !(k == WALK || (k == FENCE && mode == Mode::Chase)) {
        return false;
    }
    if d >= 4 {
        let (dx, dy) = DIRS[d];
        let ox = (c as isize + dx as isize) as usize;
        let oy = (c as isize + if dy > 0 { off[2] } else { off[3] }) as usize;
        if blocks_corner(kind[ox], mode) || blocks_corner(kind[oy], mode) {
            return false;
        }
    }
    true
}

/// Reusable bucket-queue Dijkstra. Allocates on first use only.
pub struct Dial {
    buckets: Vec<Vec<u32>>,
    /// Cells in the order they were finalized (non-decreasing distance).
    pub order: Vec<u32>,
}

impl Dial {
    pub fn new(fence_cost: i32) -> Dial {
        let ring = (DIAGONAL + fence_cost.max(0) + 1) as usize;
        Dial { buckets: (0..ring).map(|_| Vec::new()).collect(), order: Vec::new() }
    }

    /// Multi-source Dijkstra. `seeds` must be sorted by value (non-decreasing).
    /// Cells are passable per `mode`; the source cells must be passable.
    pub fn run<I>(&mut self, grid: &Grid, mode: Mode, fence_cost: i32, dist: &mut [i32], seeds: I, record_order: bool)
    where
        I: IntoIterator<Item = (u32, i32)>,
    {
        let r = self.buckets.len() as i32;
        let kind = &grid.kind[..];
        let off = offsets(grid.w);
        dist.fill(INF);
        self.order.clear();
        let mut seeds = seeds.into_iter().peekable();
        let Some(&(_, first)) = seeds.peek() else { return };
        let mut cur = first;
        let mut pending: usize = 0;
        loop {
            while let Some(&(c, v)) = seeds.peek() {
                if v > cur {
                    break;
                }
                seeds.next();
                let c = c as usize;
                if v < dist[c] {
                    dist[c] = v;
                    self.buckets[cur.rem_euclid(r) as usize].push(c as u32);
                    pending += 1;
                }
            }
            let b = cur.rem_euclid(r) as usize;
            let mut k = 0;
            while k < self.buckets[b].len() {
                let c = self.buckets[b][k] as usize;
                k += 1;
                if dist[c] != cur {
                    continue; // stale entry
                }
                if record_order {
                    self.order.push(c as u32);
                }
                for d in 0..8 {
                    if !step_allowed(kind, c, d, &off, mode) {
                        continue;
                    }
                    let n = (c as isize + off[d]) as usize;
                    let nd = cur + if d < 4 { STRAIGHT } else { DIAGONAL } + enter_cost(kind[n], mode, fence_cost);
                    if nd < dist[n] {
                        dist[n] = nd;
                        self.buckets[nd.rem_euclid(r) as usize].push(n as u32);
                        pending += 1;
                    }
                }
            }
            pending -= self.buckets[b].len();
            self.buckets[b].clear();
            if pending == 0 {
                match seeds.peek() {
                    Some(&(_, v)) => cur = v,
                    None => break,
                }
            } else {
                cur += 1;
            }
        }
    }
}

/// Plain O(n²)-ish reference used by the tests: Bellman-Ford style relaxation
/// until nothing changes.
pub fn brute_force(grid: &Grid, mode: Mode, fence_cost: i32, seeds: &[(u32, i32)]) -> Vec<i32> {
    let n = grid.w * grid.h;
    let mut dist = vec![INF; n];
    for &(c, v) in seeds {
        dist[c as usize] = dist[c as usize].min(v);
    }
    let off = offsets(grid.w);
    loop {
        let mut changed = false;
        for c in 0..n {
            if dist[c] >= INF {
                continue;
            }
            let k = grid.kind[c];
            if !(k == WALK || (k == FENCE && mode == Mode::Chase)) {
                continue;
            }
            for d in 0..8 {
                if !step_allowed(&grid.kind, c, d, &off, mode) {
                    continue;
                }
                let nb = (c as isize + off[d]) as usize;
                let nd = dist[c] + if d < 4 { STRAIGHT } else { DIAGONAL } + enter_cost(grid.kind[nb], mode, fence_cost);
                if nd < dist[nb] {
                    dist[nb] = nd;
                    changed = true;
                }
            }
        }
        if !changed {
            return dist;
        }
    }
}

/// Direction (index into `DIRS`) of the lowest-valued allowed neighbour, if it
/// is strictly lower than the current cell.
#[inline]
pub fn downhill(kind: &[u8], field: &[i32], c: usize, off: &[isize; 8], mode: Mode) -> Option<usize> {
    let mut best = field[c];
    let mut best_d = None;
    for d in 0..8 {
        let n = (c as isize + off[d]) as usize;
        let v = field[n];
        if v < best && step_allowed(kind, c, d, off, mode) {
            best = v;
            best_d = Some(d);
        }
    }
    best_d
}
