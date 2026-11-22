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

const STEP_COST: [i32; 8] = [STRAIGHT, STRAIGHT, STRAIGHT, STRAIGHT, DIAGONAL, DIAGONAL, DIAGONAL, DIAGONAL];

/// Reusable, resumable bucket-queue Dijkstra. Allocates on first use only.
///
/// `begin` + `advance` / `settle` let a caller stop early and continue later:
/// every cell whose value is `<= settled` is final, every other cell holds a
/// value `>= its true value` (INF or a tentative one), and both are always
/// `> settled`. Distances don't depend on where the run was paused, so a
/// lazily finished field is identical to one computed in one go.
#[derive(Clone)]
pub struct Dial {
    buckets: Vec<Vec<u32>>,
    /// Cells in the order they were finalized (non-decreasing distance), when
    /// `record_order` was set.
    pub order: Vec<u32>,
    /// Seeds of the current run, sorted by value (filled by the caller).
    pub seeds: Vec<(u32, i32)>,
    next_seed: usize,
    cur: i32,
    pending: usize,
    /// Every cell with a value `<= settled` is final (`i32::MAX` once done).
    pub settled: i32,
    mode: Mode,
    fence_cost: i32,
    record_order: bool,
    preset: bool,
    /// Cells finalized since `begin` (work done, for budgeting).
    pub pops: usize,
}

impl Dial {
    pub fn new(fence_cost: i32) -> Dial {
        // A power of two larger than the largest step, so a bucket index is a
        // mask and each bucket only ever holds one distance value.
        let ring = ((DIAGONAL + fence_cost.max(0) + 1) as usize).next_power_of_two();
        Dial {
            buckets: (0..ring).map(|_| Vec::new()).collect(),
            order: Vec::new(),
            seeds: Vec::new(),
            next_seed: 0,
            cur: 0,
            pending: 0,
            settled: i32::MAX,
            mode: Mode::Chase,
            fence_cost: 0,
            record_order: false,
            preset: false,
            pops: 0,
        }
    }

    pub fn memory_bytes(&self) -> usize {
        self.buckets.iter().map(|b| b.capacity() * 4).sum::<usize>() + self.order.capacity() * 4 + self.seeds.capacity() * 8
    }

    pub fn finished(&self) -> bool {
        self.settled == i32::MAX
    }

    /// Start a run over `self.seeds` (must be sorted by value). `dist` must
    /// already hold INF (or a final value that no path can beat) everywhere.
    pub fn begin(&mut self, mode: Mode, fence_cost: i32, record_order: bool) {
        self.begin_with(mode, fence_cost, record_order, false);
    }

    /// `begin` for seeds whose values the caller has already written into
    /// `dist` (the smallest one per cell): relaxations that can't beat a seed
    /// are then never queued. Same distances. A cell may appear in `seeds`
    /// more than once only with different values.
    pub fn begin_preset(&mut self, mode: Mode, fence_cost: i32) {
        self.begin_with(mode, fence_cost, false, true);
    }

    fn begin_with(&mut self, mode: Mode, fence_cost: i32, record_order: bool, preset: bool) {
        self.preset = preset;
        self.pops = 0;
        if self.pending > 0 {
            for b in self.buckets.iter_mut() {
                b.clear();
            }
        }
        self.pending = 0;
        self.order.clear();
        self.next_seed = 0;
        self.mode = mode;
        self.fence_cost = fence_cost;
        self.record_order = record_order;
        match self.seeds.first() {
            Some(&(_, v)) => {
                self.cur = v;
                self.settled = v - 1;
            }
            None => self.settled = i32::MAX,
        }
    }

    /// Process buckets until every cell with a value `<= limit` is final (or
    /// the queue is empty).
    pub fn advance(&mut self, grid: &Grid, dist: &mut [i32], limit: i32) {
        self.advance_budget(grid, dist, limit, usize::MAX);
    }

    /// `advance`, stopping early (at a bucket boundary) once about
    /// `max_pops` cells were finalized in this call. Where a run pauses
    /// never changes its result.
    pub fn advance_budget(&mut self, grid: &Grid, dist: &mut [i32], limit: i32, max_pops: usize) {
        let fence = self.mode == Mode::Chase && self.fence_cost != 0;
        match (fence, self.record_order) {
            (true, true) => self.advance_impl::<true, true>(grid, dist, limit, max_pops),
            (true, false) => self.advance_impl::<true, false>(grid, dist, limit, max_pops),
            (false, true) => self.advance_impl::<false, true>(grid, dist, limit, max_pops),
            (false, false) => self.advance_impl::<false, false>(grid, dist, limit, max_pops),
        }
    }

    fn advance_impl<const FENCE_COST: bool, const ORDER: bool>(&mut self, grid: &Grid, dist: &mut [i32], limit: i32, max_pops: usize) {
        let rm = self.buckets.len() as i32 - 1;
        let kind = &grid.kind[..];
        let masks = if self.mode == Mode::Chase { &grid.step_chase[..] } else { &grid.step_flee[..] };
        assert!(kind.len() == dist.len() && masks.len() == dist.len());
        let off = offsets(grid.w);
        let fence_cost = self.fence_cost;
        let preset = self.preset;
        let mut pending = self.pending;
        let mut pops = 0usize;
        while self.settled < limit && pops < max_pops {
            let cur = self.cur;
            let b = (cur & rm) as usize;
            while self.next_seed < self.seeds.len() {
                let (c, v) = self.seeds[self.next_seed];
                if v > cur {
                    break;
                }
                self.next_seed += 1;
                let c = c as usize;
                // Preset: the seed is queued unless a path already beat it.
                if v < dist[c] || (preset && v == dist[c]) {
                    dist[c] = v;
                    self.buckets[b].push(c as u32);
                    pending += 1;
                }
            }
            let mut bucket = std::mem::take(&mut self.buckets[b]);
            for &c in bucket.iter() {
                let c = c as usize;
                if dist[c] != cur {
                    continue; // stale entry
                }
                if ORDER {
                    self.order.push(c as u32);
                }
                // Directions in increasing order either way. A fixed 8-step
                // loop is faster in WASM (V8), bit scanning faster natively.
                #[cfg_attr(target_arch = "wasm32", allow(unused_mut))]
                let mut m = masks[c];
                #[cfg(target_arch = "wasm32")]
                let dirs = 0..8usize;
                #[cfg(not(target_arch = "wasm32"))]
                let dirs = std::iter::from_fn(|| {
                    if m == 0 {
                        return None;
                    }
                    let d = m.trailing_zeros() as usize;
                    m &= m - 1;
                    Some(d)
                });
                for d in dirs {
                    #[cfg(target_arch = "wasm32")]
                    if m & (1 << d) == 0 {
                        continue;
                    }
                    let n = c.wrapping_add(off[d] as usize);
                    let mut nd = cur + STEP_COST[d];
                    if FENCE_COST && kind[n] == FENCE {
                        nd += fence_cost;
                    }
                    let dn = &mut dist[n];
                    if nd < *dn {
                        *dn = nd;
                        // nd > cur, so it never lands in the bucket being read.
                        self.buckets[(nd & rm) as usize].push(n as u32);
                        pending += 1;
                    }
                }
                pops += 1;
            }
            pending -= bucket.len();
            bucket.clear();
            self.buckets[b] = bucket;
            self.settled = cur;
            if pending == 0 {
                match self.seeds.get(self.next_seed) {
                    Some(&(_, v)) => {
                        self.cur = v;
                        self.settled = v - 1;
                    }
                    None => self.settled = i32::MAX,
                }
            } else {
                self.cur = cur + 1;
            }
        }
        self.pending = pending;
        self.pops += pops;
    }

    /// Continue until cell `c` is final.
    #[inline]
    pub fn settle(&mut self, grid: &Grid, dist: &mut [i32], c: usize) {
        while dist[c] > self.settled {
            let lim = self.settled.saturating_add(1);
            self.advance(grid, dist, lim);
        }
    }

    /// Multi-source Dijkstra in one go. `seeds` must be sorted by value
    /// (non-decreasing). The source cells must be passable in `mode`.
    pub fn run<I>(&mut self, grid: &Grid, mode: Mode, fence_cost: i32, dist: &mut [i32], seeds: I, record_order: bool)
    where
        I: IntoIterator<Item = (u32, i32)>,
    {
        dist.fill(INF);
        self.seeds.clear();
        self.seeds.extend(seeds);
        self.begin(mode, fence_cost, record_order);
        self.advance(grid, dist, i32::MAX);
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
/// is strictly lower than the current cell. `mask` is the cell's step mask
/// (`Grid::step_chase` / `step_flee`); same result as `downhill`.
#[inline]
pub fn downhill_masked(mask: u8, field: &[i32], c: usize, off: &[isize; 8]) -> Option<usize> {
    let mut best = field[c];
    let mut best_d = None;
    let mut m = mask;
    while m != 0 {
        let d = m.trailing_zeros() as usize;
        m &= m - 1;
        let v = field[(c as isize + off[d]) as usize];
        if v < best {
            best = v;
            best_d = Some(d);
        }
    }
    best_d
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
