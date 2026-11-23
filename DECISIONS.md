# Decisions

Every choice the spec left open, and every simplification, in one place.

## Environment

- **Dev environment in Docker.** The owner asked for a Dockerfile-based dev
  environment instead of installing Rust on the host. `Dockerfile` +
  `docker-compose.yml` hold every tool; `./dev.sh <cmd>` runs a command inside
  it with the project folder mounted at `/work`. Rust build output and
  `web/node_modules` live in named Docker volumes, not in the checkout.
- **Pinned tools:** Rust stable (`rust:1-bookworm`, rustc 1.100 when this was
  built), wasm-bindgen 0.2.100 (crate pinned with `=0.2.100` so wasm-pack
  never downloads a CLI), wasm-pack 0.13.1, Node 22, Python 3.11 with
  requests and shapely from Debian.
- **`wasm-opt` is disabled** in `sim-wasm`'s wasm-pack metadata, so builds
  never download binaryen. The WASM is still built with `+simd128`.
- **sim-core depends on serde + serde_json** to read level packs and
  `config.default.json`. They are the only dependencies; everything else
  (PRNG, Dijkstra, hash) is hand-written.

## Level data

- **One Overpass query per level.** `levelgen.py` queries once at a generous
  radius (`--query-radius`, 500 m for Paris, 600 m for the suburb) and then
  grows the radius locally in 50 m steps until the building count is in range.
  Same result as querying at every step, with one request instead of up to
  ten.
- **Building kinds:** `building=yes` (most of Paris) counts as residential.
  `commercial, retail, office, supermarket, hotel, kiosk, shop, mall,
  restaurant, bank, warehouse, industrial` are commercial. Everything else is
  "other".
- **Floors:** `building:levels`, else `height / 3`, else 2, never below 1.
- **Clipping:** a footprint cut by the circle keeps its largest part. Inner
  rings (holes) are ignored. Footprints under 15 m² after clipping are
  dropped.
- **Paris Marais:** centre 48.8580, 2.3580 gives 659 buildings at 400 m.
- **Suburb:** Le Vésinet (Yvelines, France), centre **48.8935, 2.1330**. It
  gives 375 buildings at 250 m: detached houses with gardens.
- **Enclosed pockets become walls.** After rasterizing, only the largest
  4-connected walkable area is kept. Courtyards and gaps fully enclosed by
  buildings are marked as walls, so nobody spawns where zombies can never
  reach (which would otherwise force every game to time out). Level fences are
  applied after this step, so a fenced compound is not removed.
- **Grid border:** the outermost ring of cells is always a wall, in addition
  to the circle edge. Synthetic levels carry rectangular `bounds` and cells
  outside them are walls.

## Population

- **Spawn cells:** walkable cells whose centre is inside, or within 6 m of,
  the building polygon. If a building has none, the radius grows in 6 m steps
  up to 30 m. A building still without cells gets zero weight.
- **Levels with no buildings** (open_field) scatter civilians uniformly over
  walkable cells.
- **Setup wandering is cosmetic.** Civilians wander during setup so the map
  looks alive, but `start()` puts every agent back on its spawn position and
  reseeds the PRNG. The outcome then depends only on seed + placements, not
  on how long the player spent in setup. Agents visibly snap back at Start.

## Simulation

- **Tick phases are exactly the spec's order.** No change. The game ends
  (win / loss / timeout) after the stats of the tick that caused it.
- **Infection timing:** a bite sets `timer = infection_delay_ticks + 1`
  because the Infected phase of the same tick decrements it once. So a
  civilian bitten at tick t is Infected from t and a Zombie exactly at t + 20
  (tested).
- **Field schedule (changed in T1, see "Scale"):** a chase job starts when
  `tick % 5 == 0` and a threat + flee job when `tick % 5 == 2`, each from a
  snapshot of the agents at that tick; each is published 5 ticks later.
  Start computes both at once. A job reads the grid of its start tick: a
  fence break during a job is picked up by the next job of that kind
  (within 10 ticks), see "Scale", *Fence breaks*.
- **Field units:** 10 per straight step = 5 cost units per meter. The wake
  radius (60 m) is therefore a threat value of 300.
- **Flee field:** threat is capped at `flee_threat_cap_m` (200 m) before
  multiplying by −1.2, so far-away regions are flat instead of infinite. The
  "one more Dijkstra pass" runs Dial's algorithm seeded with every walkable
  cell at its scaled value. Since T1 it only runs inside the threat zone (see
  "Scale"); the reference version (`eager_fields`) still seeds capped cells
  first, then the threat field's finalization order reversed.
- **Corner cutting:** a diagonal step is allowed only if neither orthogonal
  neighbour blocks (building, wall, and for civilians also fences). The same
  rule is used to build the fields and to steer.
- **Steering detail:** a zombie that has a civilian within
  `zombie_seek_radius_m` (3 m) in its own cell or an open neighbour cell
  steers straight at it instead of at the cell centre. Without this, zombies
  hover a cell away from targets (bite radius 0.8 m < cell size 2 m).
  Otherwise agents steer to the lowest of their 8 neighbours, as specified.
- **Dormant civilians** (threat > wake radius) update on 1 tick in 4 and then
  move 4 ticks' worth, so their average speed is unchanged. They are skipped by
  separation on their off ticks but still push others.
- **Random walk:** a dormant civilian keeps its heading and turns to one of
  16 fixed directions with probability `wander_turn_chance` per update. The
  table is literal constants (no sin/cos).
- **Separation:** pushes by half the overlap per neighbour, stops after 8
  overlapping neighbours or 48 scanned candidates, and is clamped to one
  radius per tick. It reads the hash-time state, so a civilian bitten this
  tick still pushes during this tick.
- **Separation visits agents in spatial-hash order** (not index order), so
  neighbouring agents are processed together. Each agent's push is computed
  exactly as before, so the state hash is unchanged.
- **Spatial hash:** besides `bucket_start` / `agent_ids`, the counting sort
  stores civilians first inside each bucket, plus bucket-ordered copies of x,
  y and state. Bites scan only civilians and towers only non-civilians. This
  cut the late-game zombie phase from 13 ms to under 1 ms at 20k agents.
- **Outbreak:** cluster seeds are drawn uniformly among civilians and
  rejected if closer than 150 m to an earlier seed (after 5,000 failed tries,
  any distinct civilian is accepted so tiny maps still start). Every civilian
  within 8 m becomes a zombie; if fewer than 5, the 5 nearest do.
- **Fence damage** accumulates as floats (10 hp/s = 0.5 hp per tick per
  zombie) and is applied in the fence phase. Several zombies on one cell
  stack.
- **Towers fire immediately** when a target first appears, then every 10
  ticks (2 shots/s), so a zombie at 30 m dies on ticks 0, 10, 20 (1 s).
- **Speeds (owner request, after the first hand-back):** civilians 2× (wander
  1.2 m/s, flee 4.4 m/s), zombies 3× (7.5 m/s) compared with the spec. Zombies
  now outrun fleeing civilians by 3.1 m/s instead of 0.3 m/s, so chases end
  quickly and games last minutes instead of timing out. A zombie still moves
  0.375 m per tick, well under one 2 m cell.
- **Dead zombies stay on the map.** A killed zombie keeps its slot with state
  Dead. For `kill_flash_seconds` (1 s) it renders as a pale "fresh kill",
  then as a violet corpse until the end of the game, so tower kills stay
  visible. Corpses don't move, push or block.
- **Determinism** relies on f32 arithmetic with no FMA contraction, no
  trig, sqrt only, PCG32, and index-order iteration. The fixture run (Paris,
  5k agents, seed 2026, one tower, one fence, 400 ticks) hashes identically
  native and in WASM under Node (tested).

## Scale (T1, wave-8 size)

- **Wave-8 caps: `wave8_radius_m` 1300, `max_population` 100,000** (in
  `config.default.json`; the 8-wave loop that reads them comes in T2). With
  them, the WASM tick p95 stays under 50 ms on the heaviest real geometry we
  have (the Marais tiled to 1.3 km), so 1× is playable in the browser
  worker. Measurements below and in `reports/scale.md`.
- **Benchmark (`sim-headless bench --scale`).** Levels: `grid_city_disc`
  (40 m blocks, 14 m streets, cut to a circle; 47% walkable) at 1.1, 1.3 and
  1.6 km, and the committed Marais tiled to 1.3 km (`marais-tiled:1300`;
  alternate tiles mirrored so streets meet at the seams; 68% walkable, real
  street geometry). 20k / 50k / 100k / 150k agents, no defense, seed 1, 12
  outbreak clusters ("wave 8 is massive"), run until civilians drop below
  15% (the T2 defeat rule; nothing runs past it). Native and WASM under Node
  (`tools/wasm-bench.mjs --level-file --config-file`). Single thread, host
  M1 Pro, macOS 14, not in Docker. Max tick is dominated by isolated host
  hiccups (different ticks on each run, also in phases that do no field
  work); p95/p99 are the figures to read.
- **No real 1.3 km level is committed.** One Overpass query at 1.3 km
  (48.862, 2.376, Paris 11e) got a 502 from overpass-api.de and a read
  timeout from the fallback instance; we did not insist. The tiled Marais
  stands in for real geometry offline and is generated in the bench.
- **Before (pre-T1 code), 1.3 km:** WASM p95 53 / 62 / 70 / 81 ms at 20k /
  50k / 100k / 150k on `grid_city_disc`, 74 / 75 / 86 / 93 ms on the tiled
  Marais. The cost was the fields, not the agents: one threat + flee
  recompute over the whole map (30–40 ms native, 2× that in WASM) landing
  on a single tick.
- **What changed (all in sim-core, native == WASM bit for bit):**
  - *Step masks* (`Grid::step_chase` / `step_flee`): one byte per cell with
    the allowed directions, so Dijkstra and steering skip the corner checks.
    Kept in sync by `Grid::set_kind`, rebuilt at start. Same results.
  - *Resumable Dial* (`Dial::begin` / `advance_budget` / `settle`): a run can
    pause at a bucket boundary and continue later; the result never depends
    on where it paused. Ring size rounded to a power of two (mask instead of
    `rem_euclid`). Same results.
  - *Threat stops at the flee cap* (200 m): values at or above the cap are
    only ever compared with the cap or the wake radius. Same results. The
    stop is `max(cap - 1, wake)` in field units (`Sim::threat_limit`):
    dormancy reads `threat > wake` exactly, so with `wake_radius_m` at or
    beyond `flee_threat_cap_m` the job runs on to the wake radius (a T1
    review finding: stopping at the cap made dormancy diverge from the
    reference at tick 0 with wake 250 m). Allowed rather than rejected in
    config; tested with wake 250 / cap 200 and wake 150 / cap 120.
  - *Flee only inside the threat zone*: capped cells end at exactly 0, so
    only zone cells are seeded (each next to a capped cell at min(seed,
    step cost)), counting-sorted by value over cells in index order, with
    their values preset. Bit-identical flee field (tested against the
    reference seeding every 7 ticks).
  - *Field jobs spread over ticks* (**rule change**): instead of computing a
    field inside the tick that needs it, each field is a job seeded from a
    snapshot, advanced by a budget every tick, and published one interval
    (5 ticks) later. Agents therefore steer on fields 5–9 ticks old instead
    of 0–4 (0.25 s more). Budget = the last job's work + 50%, capped by an
    upper bound (each passable cell finalized at most once for chase, twice
    for threat + flee, plus the flee seed scan at a quarter per cell); the
    flee seed scan is itself incremental. Any leftover is finished at the
    publish tick. The budget never changes results, only where the work
    happens. This is the change that moved the hash: **fixture
    `db5a39a980ef2a0a` → `0ea142296a5795a9`**, updated on purpose. WASM
    under Node reproduces it.
  - *Fence breaks* (**rule change**, T1 review fix): a job reads the grid
    as it was at its start tick, and a break during a job is picked up by
    the next job of that kind, so the fields agents read reflect a break
    within two intervals (10 ticks) instead of one. Until T1's review a
    break restarted the jobs in flight on the new grid, and the leftover
    was finished on the publish tick: a whole chase job (~13–16 ms native
    at 1.3 km / 100k, 1.2–2× that in WASM) on one tick, every interval
    with a break. Now, just before the first break under a job still on
    the live grid, its field inputs (kind and both step masks, 3 bytes per
    cell, ~5 MB at 1.3 km) are copied into one of two frozen copies (jobs
    on the same grid share one; at most one copy per job) and the job
    finishes on the copy; the work stays spread out. Steering always uses
    the live grid and its step masks, so nobody walks through an intact
    fence because of a stale field (zombies still chew a fence cell the
    field leads them into; tested: no agent ever stands on a fence cell).
    The two existing fixtures have no fence break, so **their hashes do not
    change** (`native_hash.json` `0ea142296a5795a9`, `match_hash.json`
    `e1061f2da92f6c9f`); a new **break-heavy fixture**
    (`fence_break_hash.json`, `948428b482f65852`:
    `fixture::compute_fence_fixture_hash`, a 200 m city sealed by fences,
    4 hp fences, 1,200 ticks) pins the new rule natively and in WASM under
    Node. Rejected: postponing the publish after a break (simpler, but
    breaks every few ticks would starve the fields).
  - *Break-heavy bench* (`bench --scale --fenced 1300`, on by default):
    `grid_city_disc` with a fence through every block row and column
    (`level::grid_city_disc_fenced`: every street segment fenced once, no
    detour), fence hp 6, fence path cost 100, 12 clusters. 1.3 km, 100k,
    2,000 ticks, before → after the fix (same host as below): native p95
    20.5–29.1 → 14.0 ms, p99 29.7–45.7 → 14.9, fields max 34–124 → 10.2;
    WASM p95 29.5 → 18.0, p99 41.7 → 18.9 (273 fence cells broken on 231
    ticks before, 454 on 364 after: zombies now walk through a hole up to
    one interval later, so the game differs; native and WASM equal in
    both). Fence-free runs do no copies and are unchanged, so the caps
    below still hold. Re-run at the T1 second review (committed in
    `reports/scale.md`, "Break-heavy case"): native p95 14.2 ms, p99 14.9,
    fields max 11.5; WASM p95 18.0, p99 18.7; 454 cells on 364 ticks, the
    same game.
- **Tested:** `tests/t1_scale.rs` runs a sim and an `eager_fields` reference
  (every job computed in full the moment it starts, original flee seeding,
  uncapped threat) side by side on Paris with towers and fences, on a
  `grid_city_disc` and through fence breaks: same hash every tick, same
  chase and flee fields, same threat below the cap. Plus resumable Dial vs
  brute force and step masks vs `step_allowed`. Since the T1 review also:
  a config with the wake radius beyond the flee cap; the fence-break rule
  against an independent one-shot Dijkstra over the grid recorded at each
  job's start (published chase and threat, on jobs the grid changed
  under); and forced budgets (`Sim::test_budget`: 1 everywhere, a crawling
  flee scan, erratic 0 / 1 / small / 3×) equal to the default budget and
  the eager reference, with pauses counted in every stage (chase, threat,
  flee seed scan, flee).
- **Tried and dropped:** a lazy chase field (zombies settle it up to their
  own cell): civilians are everywhere, so it still settles almost the whole
  map, just inside the zombie phase. Coarser cells were not needed.
- **WASM inner loop:** the Dijkstra visits directions with a fixed 8-step
  loop in WASM (25% faster in V8) and with bit scanning natively (10%
  faster there). Same order, same results.
- **Measurements, tick p95 in ms (before → after T1), WASM under Node:**

  | Level | 20k | 50k | 100k | 150k |
  |---|---|---|---|---|
  | grid 1.1 km | – | – | 50.7 → 34.2 | – |
  | grid 1.3 km | 53.3 → 23.7 | 62.5 → 28.4 | 69.8 → 38.6 | 81.0 → 46.9 |
  | grid 1.6 km | – | – | 88.4 → 49.0 | – |
  | Marais tiled 1.3 km | 74.4 → 30.1 | 74.8 → 35.6 | 86.1 → **45.7** | 93.1 → 56.4 |

  Native, same order: grid 1.3 km 45.7 / 52.4 / 58.2 / 68.4 → 18.5 / 23.4 /
  32.8 / 41.0; Marais tiled 73.8 / 78.2 / 79.4 / 90.3 → 23.5 / 28.2 / 36.2
  / 45.2. Fields p95 at 1.3 km went from ~43 (native) / ~52 (WASM) to ~16 /
  ~20 on the grid and ~20 / ~26 on the Marais. Full table (p50, p99, max,
  memory, setup): `reports/scale.md`. Memory at the caps: ~125 MB native
  (`Sim::memory_bytes`, double-buffered fields included), ~135 MB WASM
  linear memory; setup (`Sim::new` + start) ~0.4 s in WASM.
- **Why 1.3 km / 100k:** the heaviest case we have (real Paris geometry,
  68% walkable) stays at 45.7 ms p95 / 47 ms p99 in WASM, with ~10% left
  for the browser's own overhead. 150k misses there (56 ms): agent phases
  (separation, zombie steering) grow with the population while the field
  work is set by the area. 1.6 km fits 100k only on the synthetic grid
  (49 ms); with real geometry, ~45% more walkable cells, it would hold about
  50k, too few for "wave 8 is massive". 1.3 km is the middle of the
  1.1–1.6 km target (about 5.3 km² per match, ~15 matches for 75% of
  Paris).
- **Firefox runs our WASM ~6× slower** (p50 8.3 ms vs 1.4 ms Chromium and
  1.3 ms WebKit, Marais 5k agents, same hash). Measured on Playwright's
  Firefox 151 (build 1532, macOS arm64): same speed outside Playwright (the
  binary launched directly, so not Juggler), same with a non-SIMD build, no
  tier-up after 2,500 ticks, and with `javascript.options.wasm_baselinejit`
  off the page fails with "no WebAssembly compiler available". So this build
  has no optimizing wasm tier and runs everything in the baseline compiler.
  Nothing in our code can fix that; stock Firefox (with Ion) was not
  available on the host to compare. Wave-8 sizes are therefore not playable
  in that Firefox build.

## Match (T2, the 8-wave loop)

- **`Match` owns a `Sim`** (`sim-core/src/match_.rs`). The only ways to
  change it are `Match::apply(Action) -> Result<(), ActionError>` between
  ticks, `Match::step()`, and `add_buildings` (map data, not a player
  action). `Action` is serde-tagged JSON (`{"type":"place_tower",
  "building":3}`); coordinates are sim meters, like the existing `Sim`
  API. Accepted actions are logged as `(tick, action)` where `tick` counts
  every `step()` since creation (all phases, never reset by a retry); T4
  turns that log into run records. Refused actions are not logged.
- **The single-wave `Sim` API is unchanged** and keeps its tests. The match
  needs a few per-sim rules, added as fields whose defaults are neutral:
  `fatigue` (1.0), `loss_below` (1: lose at 0 civilians), `timeout` (true),
  `tower_budget` / `fence_budget_m` (from config). Multiplying by 1.0 gives
  the same floats, so **the fixture hash is unchanged (`0ea142296a5795a9`)**;
  spawning and outbreak seeding were split into helpers that draw the PRNG
  in exactly the old order.
- **Phases:** `Prep → Running → WaveWon | WaveLost`; `WaveWon → NextWave →`
  the next wave's `Prep`; winning wave 8 goes straight to `MatchWon` (no
  `WaveWon` first). `WaveLost` only allows `RetryWave` or `RestartMatch`
  (zombies are still on the map, so there is no "next wave" from a loss).
  Victory is checked before defeat, after the tick's stats, as in `Sim`.
  Defeat: civilians < `ceil(defeat_fraction × civilians at Start)` (the
  starting count is taken before the outbreak converts anyone). No timeout;
  `sim-headless match` has a `--max-wave-s` safety cap only.
- **Rings:** `match.ring_radius_m` (150, 300, 450, 600, 775, 950, 1125,
  1300 m; the last must equal `wave8_radius_m`, checked). On a level smaller
  than the wave-8 cap the core keeps its 150 m and the other rings are
  squeezed linearly up to the level radius (Marais, 400 m: 150, 183, 215,
  248, 286, 324, 362, 400 m), so every wave still reveals a ring.
  Rectangular synthetic levels use the bounds' centre and half their
  smaller side. Cells whose centre is outside the current disc are `WALL`,
  so fields, steering and placements never see them (fences there are
  clipped like on buildings; towers there are refused with `NotRevealed`,
  judged by building centroid).
- **The grid is sized from the final radius only**, never from the
  buildings, so its origin (and every sim coordinate) doesn't depend on
  which blocks happened to be loaded. Its margin past the final disc (or
  bounds) is `max(grid_margin_m, ring_band_m + cell_size_m)`, 54.8 m with
  the defaults (`Match::grid_margin_m`; second T2 review). With the 20 m
  `grid_margin_m` the grid ended inside the `ring_ready` band of the last
  rings: a block lying wholly past the grid edge covered no cell, so
  `ring_ready` did not wait for it, yet the reveal applied it when present
  (its buildings may reach the margin into the disc) and refused it with
  `AreaRevealed` when late, so a cell of the last ring was building or
  open ground depending on arrival time (tested: a block at x 430–680 m
  with a building reaching x = 381 m on a 400 m disc). Now every block a
  reveal applies holds a grid cell centre inside the band. Cost: the
  Marais grid (400 m) grows from about 421² to 456² cells (+17%), the
  wave-8 grid (1300 m) from 1.74M to 1.84M cells (+5%), the extra cells
  all walls. The match fixture changed on purpose to
  **`b0b7f9703b3cc1c0`** (grid size only: with the old margin the other
  fixes of that review leave it at `524027b630e0338f`). Single-wave
  `Sim` grids keep `grid_margin_m`.
- **Reveal** happens when a wave's prep opens. The match keeps a `base`
  geometry per cell (walk / building / wall with all applied buildings);
  newly revealed cells take it (plus the level's own fences), older cells
  keep their kind (fences placed or broken stay as they are). Pockets walled
  off earlier are re-opened first, since a pocket cut by the ring edge may
  now connect; then every open region (fences counted as open) not
  connected to the cells open before this reveal is walled
  (`Grid::keep_regions_touching`). Wave 1 keeps its largest region. The
  anchors are the cells WALK before the reveal, not fences: walling turns
  WALK into WALL and leaves fences, so a level fence inside a walled pocket
  stayed FENCE, anchored the next reveal and reopened the pocket for good
  (second T2 review, tested with a fenced box pocket and a fence in a
  walled ring 2 outside a closed core). Fences of the played area still
  join it through the flood. Fences in a pocket are kept as fences, not
  walled: they are unreachable behind the walled cells, and if the pocket
  later connects to the played area the level fence is still there (a
  walled cell reopens as its base, WALK, which would erase it). Step
  masks are rebuilt. (T2 review: the rule used to be "keep the largest
  region" every wave, and a new ring with a larger open area not connected
  to the old one walled the whole territory already played: 0 walkable
  cells in the core, survivors stuck in walls. Now the played area is never
  walled; an unconnected part of a new ring is. Agents left on a cell that
  is not walkable go to the nearest walkable cell anywhere on the grid, no
  longer only within 32 cells. The Marais sweep, seeds 1–16, is unchanged
  row for row. The search, `Grid::nearest_walk_within`, walks only the
  perimeter of each square ring, clipped to the grid, and stops once a
  ring lies wholly outside it: O(cells) for a whole-grid search, also on
  a grid with no walkable cell; it scanned the full square per ring, which
  was cubic. Same result, tie order included: tested against the old scan
  on random grids.)
- **Buildings arrive in chunks** (`BuildingChunk { block_id, bounds,
  buildings }`, level-local meters). `add_buildings` works in any phase but
  refuses a chunk the revealed area already needed (below), a duplicate id,
  and (`BadChunk`, T2 review: `f32::clamp` panicked on them) bounds that are
  not finite, inverted or narrower than one cell on an axis, or a building
  with a non-finite coordinate or floor count; `new_streaming` checks its
  chunks the same way. Chunks are stored, not applied: each reveal applies,
  in block-id order, every stored chunk whose **bounds** come within the
  new radius + `block_margin_m` of the centre (Euclidean distance from the
  centre to the bounds box), and `add_buildings` refuses a chunk with
  `AreaRevealed` by the same test against the current radius. The
  buildings never enter that test (before the T2 review it used the bounds
  grown to the buildings): a building may stick out by the margin per axis,
  so margin × √2 at a block corner, and could make a block due that
  `ring_ready` didn't wait for. The part of such a building that reaches
  into rings revealed before its block is applied stays open ground, the
  same for any arrival order (tested), and is not the building's: only its
  cells in the new ring, later rings or past the last ring get `base`
  BUILDING, `grid.building` and count in `cell_count` (second T2 review:
  the open part used to count as building, tested). `Sim::building_at`
  still falls back to the polygon for points on no building cell, so it
  can name such a building on its open part; the match does not use it. Building indices therefore depend only on the chunks and
  the rings, never on arrival order or timing (tested: sorted, reversed,
  and staged arrival give the same per-wave hashes). `Match::new(level)`
  wraps a whole level as one chunk (id 0, infinite bounds).
- **`ring_ready(wave)`** (exact rule since the T2 review; the browser's map
  loader mirrors it): every grid cell whose centre `p` satisfies
  `|p − centre|² ≤ (r_k + block_margin_m + cell_size_m × SQRT_2)²` for some
  wave k ≤ `wave` (f32; `SQRT_2` is `std::f32::consts::SQRT_2`, no trig;
  `match_::ring_band_m`) is covered by a chunk, a cell being covered by a
  chunk when `min_x ≤ p.x < max_x` and `min_y ≤ p.y < max_y` (half-open, so
  blocks that tile the plane cover each cell once even when a shared edge
  runs through cell centres). Only cells of the grid count. Why the extra
  cell diagonal: a block is due at reveal k once its bounds come within
  `r_k + margin`, and a block at least one cell wide whose bounds come
  within that distance holds a cell centre within one cell diagonal of the
  nearest point, so it is always awaited before the reveal that would
  apply it, and so never refused afterwards. With `r_k + margin` alone, a
  block starting at x = 149.01 (r1 = 100, margin 50) held no cell centre in
  the band, was not awaited, was refused after the reveal, and
  `ring_ready(2)` never became true (tested, plus a sweep of sub-cell
  offsets on both sides of the band edge, straight out and at a diagonal,
  checking that a block wave 1 doesn't await is accepted after its reveal).
  The margin is needed: a block whose bounds stop short of a ring can still
  hold a building that reaches into it. Buildings sticking out of their
  block by more than the margin on either axis are refused
  (`BuildingOutsideBlock`). A loader fetching every block whose bounds meet
  the disc of radius `r_k + block_margin_m + cell_size_m × √2` (as the JS
  loader does, with 5 cm slack) always has what `ring_ready` needs; for an
  f32 tie exactly on the band edge it should fetch a little beyond, never
  less. Contract for T6: blocks tile the plane without
  overlapping and each building is in exactly one block. `NextWave` is
  refused with `RingNotLoaded` until the next ring is ready;
  `new_streaming` refuses to start without wave 1's ring.
- **Population:** agent arrays always have `max_population` slots (100k),
  whatever the level, so a streamed match and a fully loaded one hash the
  same; slots not in play are `ABSENT` (state 4, the reserved render
  state). `Sim::n` is the number of slots in play and every per-agent loop
  stops there; the hash covers all slots (absent ones are constant).
  Newcomers of wave k come from the applied buildings whose centroid is in
  ring k: `round(Σ weight × population_multiplier)` (weight = area × floors
  × density by kind, as before), capped by the free slots, split by largest
  remainder and placed from the `SPAWN` stream on walkable cells of the new
  disc. Survivors stay where they are. Corpses keep their slots for the
  whole match (as in T1's definition of `max_population`).
- **`population_multiplier` 0.5** (lowered to 0.3 in T3, see "Cards"): the 1.3 km tiled Marais then holds
  92,303 agents at wave 8 (1,266 in the core), under the 100k cap with room
  for denser places. The committed Marais (400 m) holds about 10.4k over
  the match. Difficulty (T7) scales `MatchSetup::population_multiplier`.
- **Prep is cosmetic, as before:** (the browser no longer steps prep at all
  since T5, see "Browser match (T5)") civilians wander from their own stream
  (`PREP_WANDER`), and Start puts everyone back where the prep began,
  zeroes velocities and reseeds `WANDER`. Kill flashes are cleared when a
  prep opens. So how long the player stays in prep never changes the game.
- **Fatigue:** `match.fatigue_curve`, `[seconds, factor]` points, linear in
  between (f32, no trig), flat outside; set on the sim before every running
  tick from the wave tick. It multiplies the civilians' wander and flee
  speeds only. Default: 1.0 for the first minute, 0.75 at 3 min, 0.5 at
  6 min, 0.35 from 10 min on.
- **Outbreaks** (wave 1 reduced and squeezed-ring scaling added in T3,
  see "Cards"): per-wave `outbreak_clusters` (2, 2, 3, 3, 4, 5, 6, 10),
  `inner_outbreaks` (0, 0, 0, 0, 1, 1, 2, 3), `outbreak_radius_m` and
  `outbreak_min_per_cluster` (5 to 12). Wave 1 draws among all civilians;
  later waves first draw the inner seeds among civilians inside the previous
  radius, then the rest among civilians in the new ring (an empty new ring
  falls back to anywhere). The 150 m separation applies across both groups,
  with the old fallback after 5,000 tries. Seed positions are kept
  (`outbreak_sites`, hidden information for tests and debug views).
- **Temporary tools until T3 (removed in T3: `PlaceTower`, `PlaceFence`
  and `Undo` are gone, cards replace them):** each prep grants `tower_budget` towers and
  `fence_budget_m` meters on top of what is placed; unused budget is lost.
  `Undo` only takes back this prep's placements. Placements persist; broken
  fence cells stay walkable.
- **Retries:** one snapshot, taken when the current wave's prep opens. It
  leaves out the scratch buffers (fields and their back buffers, Dijkstra
  queues, spatial hash, separation, fence damage), which Start recomputes
  in full, so it is about 25 MB at the caps instead of a second ~125 MB.
  `RetryWave` (any phase except `MatchWon`) restores it and keeps the live
  scratch buffers. `RestartMatch` rebuilds wave 0 from the level shell and
  the stored chunks (no re-fetch) and reveals wave 1 again. Both count in
  `retries` (and `restarts` for the latter); neither is part of the state
  hash, so a retry lands on exactly the prep's hash (tested). The retried
  attempt's `WaveResult` is dropped; results keep the latest attempt of
  each wave.
- **RNG streams:** `Pcg32::new(match seed, ("matc" << 24) | (system << 8) |
  wave)` with fixed system ids: `SPAWN` 1, `OUTBREAK` 2, `WANDER` 3,
  `PREP_WANDER` 4, `DECK` 5 and `CARD_EFFECTS` 6 (reserved for T3). A
  stream is re-created whenever its wave starts, so a retry or a restart
  replays the same newcomers, outbreak and wander.
- **`Match::state_hash`** = FNV-1a over the sim's hash, wave, phase, agents
  in play and applied block ids (more since T3 and the T2 review, below). `WaveResult` stores it at prep start and
  after the tick that ended the wave. A second fixture, two waves of a
  Marais match (`fixture::compute_match_fixture_hash`), hashes
  `4909c13c5beea4e9` natively and in WASM under Node (tested both sides).
  (T3 changed it on purpose to `e1061f2da92f6c9f`, see "Cards"; the T2
  review changed it on purpose to `524027b630e0338f`, below.)
- **What the match hash covers (T2 review).** It left out state that
  changes the rest of a running wave, so two matches with equal hashes
  could diverge (equal hashes, different defeat line: one tick later one
  was Running, the other WaveLost). It now also eats
  `Sim::wave_state_hash`: the sim RNG (wander), `n`, `loss_below`, the
  `fatigue` bits, `timeout`, every `Stats` counter and `spawn_x`/`spawn_y`
  of the agents in play; and, only while the wave runs (in prep Start
  recomputes every field; an ended wave never steps), the published chase
  and flee fields, the threat field clamped to `threat_limit + 1` (higher
  values are never read exactly and the lazy job leaves them unfinished),
  and for each pending field job its seeds and the cells broken since it
  started. A job's result depends only on its seeds and the grid of its
  start tick, which is the live grid with those cells put back to fence, so
  this is exact without hashing the half-built back buffers, the Dijkstra
  queues or the frozen grid copies. Those depend on the work budget and on
  `eager_fields` and the hash must not (tested: per-tick match hashes are
  equal for lazy, eager and odd budgets with fences breaking under jobs in
  flight). The match itself adds `wave_start_civilians`, the newcomers,
  the counters taken at Start and the results so far (without their
  hashes). Left out: the spatial hash, separation and fence-damage scratch
  (rebuilt every tick), `step_mul`, the single-wave tool budgets and
  placements, spawn counts and weights, outbreak sites (debug only), the
  prep snapshot, timings and test counters. `Sim::state_hash` is
  unchanged, so the single-wave fixture (`0ea142296a5795a9`, checked in
  every browser) and the break fixture (`948428b482f65852`) hold; the match
  fixture changed on purpose to **`524027b630e0338f`** (native = WASM under
  Node). Bulk arrays in `wave_state_hash` are mixed one u64 word per step
  (a bijection per word, so a single-word change always shows). Cost at
  wave-8 size (100k agents, 1.75M cells, native M1 Pro): `Sim::state_hash`
  14.7 ms + `wave_state_hash` 9.3 ms, so ~24 ms per `Match::state_hash`
  (was ~15 ms). It runs twice per wave in a game; T4's divergence search
  calls it per tick only while bisecting a replay.
- **`sim-headless match`** (T2 version; since T3 it plays the starter
  deck) plays with 32 towers per wave (`--tower-budget`;
  the config keeps today's 8): with 8, wave 1 already ends at the 15% line
  on the Marais, as every single-wave scenario in the report already ended
  at 0% survival. Up to 3 retries per lost wave, each with a different
  tower choice (newest ring largest at 50 m or 80 m spacing, largest
  anywhere, nearest the centre). Seed 2 clears all 8 waves (6 retries);
  seeds 1 and 3 lose wave 7. Balance is left to the cards (T3). The
  squeezed Marais rings also keep the full wave-8 outbreak counts in much
  less area.
- **Perf re-check at the caps (native, M1 Pro, single thread):**
  `sim-headless match --level marais-tiled:1300 --seed 1 --fast-forward-to
  8 --max-wave-s 150`, so waves 1–7 are won instantly and wave 8 runs for
  real with 92,303 agents, 10 outbreak clusters and 256 towers for
  3,000 ticks: tick **p50 17.1 ms, p95 32.3 ms**, max 56.7 ms (one tick),
  memory ~159 MB including the prep snapshot. T1 measured 36.2 ms native
  p95 for 100k with no defence on the same level; with T1's WASM/native
  ratio there (1.26) that puts WASM around 41 ms p95, under the 50 ms
  target. It is an estimate: the WASM match bindings come in T5. All seven
  reveals and Starts together took under 1 s.

## Cards (T3)

- **Data:** `cards.json` at the repo root, embedded in `sim-core` like the
  config (`CardDb::default_cards()`; the headless CLI reads the file at run
  time and `ZT_CARDS` / `ZT_CONFIG` swap either file for balance sweeps).
  It holds the cards, the deck rules and the starter decks. Each card has
  an id, name, rarity, kind, supply cost, text and one effect, tagged by
  `type`:
  - `fence {length_m, cell_hp}`: a polyline of at most `length_m` placed
    meters (clipped at buildings as before).
  - `garrison {buildings, weapon}`: up to N distinct revealed buildings.
  - `unit {delay_s, scatter_m, follows_path, speed_m_s, weapon}`: a shooter
    with no building, at a point or along a polyline.
  - `strike {delay_s, radius_m, damage, pulses, interval_s}`: area damage.

  A weapon is `{range_m, min_range_m, damage, fire_rate, splash_m}`.
  Loading checks unique ids, that the kind matches the effect
  (fence = fortification, garrison = armament, unit/strike = tactical),
  sane numbers and that every starter deck is legal.
- **v1 cards** (cost, numbers):
  - Fortifications: Light fence (common, 2, 400 m, 300 hp per cell, i.e.
    today's fence), Barbed wire (common, 1, 200 m, 120 hp), Heavy stockade
    (uncommon, 3, 100 m, 2,400 hp: 240 zombie-seconds per cell), Concrete
    barriers (rare, 4, 300 m, 1,800 hp).
  - Armaments: Rifles (common, 3, 3 buildings, 40 m, 34 dmg, 2/s: today's
    tower), Hunting rifles (common, 2, 2 buildings, 55 m, 50 dmg, 1/s),
    Militia (common, 2, 4 buildings, 25 m, 34 dmg, 1/s), Machine-gun nest
    (uncommon, 3, 1 building, 35 m, 25 dmg, 8/s), Mortar (uncommon, 4, 2
    buildings, 90 m, minimum 20 m, 60 dmg, 0.5/s, 8 m splash), Sniper nest
    (rare, 3, 1 building, 120 m, 100 dmg, 0.67/s).
  - Tactical: Grenades (common, 1, 8 m, 100 dmg after 1 s), Paratrooper
    (uncommon, 2, lands within 15 m of the point after 10 s, assault rifle
    30 m, 34 dmg, 5/s), Napalm (rare, 4, 20 m, 25 dmg per second for 12 s
    after 3 s), Airstrike (legendary, 6, 40 m, 1,000 dmg after 5 s),
    Armored convoy (legendary, 6, drives a polyline at 5 m/s after 5 s,
    heavy machine gun 40 m, 34 dmg, 8/s).
- **Starter deck "Civil Defence Issue"** (`civil_defence_issue`): Rifles ×3,
  Hunting rifles ×3, Militia ×3, Light fence ×2, Barbed wire, Grenades,
  Machine-gun nest ×2, Mortar ×2, Heavy stockade ×2, Paratrooper.
  That is 13 armaments, 5 fortifications and 2 tactical cards. Militia was
  added in the balance pass: the first version averaged ~1 building per
  card (~5 towers per hand), and wave 1 needs about 9–12 spread towers.
- **Deck rules** (`deck_rules` in `cards.json`): exactly 20 cards; at most
  3 / 2 / 1 / 1 copies of a common / uncommon / rare / legendary; at most 2
  legendaries. `validate_deck` returns every problem (`WrongSize`,
  `UnknownCard`, `TooManyCopies`, `TooManyLegendaries`), in a fixed order,
  each with a readable `Display`. `Match::new` refuses an illegal deck
  (`MatchError::InvalidDeck`).
- **The deck is a match input:** `MatchSetup { seed, population_multiplier,
  deck }`, card ids in the order given (`MatchSetup::new` uses the starter
  deck). `Match::new_with_cards` / `new_streaming_with_cards` take another
  card list (tests use relaxed copy limits); `new` / `new_streaming` use
  the embedded one. `CardDb::content_hash` is there for T4's run record.
- **Hand, deck, discard:** at wave 1's prep the deck is shuffled
  (Fisher-Yates) from the `DECK` stream of wave 1. Every prep re-creates
  the stream for its wave (`stream(DECK, k)`), so a retry redraws exactly
  the same. Each prep then:
  1. gets its supply income;
  2. keeps up to `hand_keep` (2) unplayed cards and discards the rest in
     hand order. If `KeepCards` was applied since the last prep opened
     (`keep_chosen`, reset at every prep and by a mulligan, whose new hand
     carries no marks; before that fix a keep choice survived the mulligan
     and kept nothing, T3 review), the marked cards stay: an empty
     list is a choice and keeps nothing, and the last choice counts.
     Without a choice, the first two in hand order stay;
  3. draws `hand_draw` (5) on top, so a hand holds up to 7.

  The draw pile is a stack. When it is empty at a draw, the whole discard
  becomes the deck and is shuffled from the current prep's stream (counted
  in `reshuffles`). Played cards go to the discard right away, and their
  structures stay on the map.
- **Mulligan:** prep only, once per wave, only before any card is played
  this prep, costs `mulligan_cost` (1). The hand is set aside, the same
  number of cards is drawn (with the usual reshuffle of the discard,
  from the current prep's `DECK` stream and counted in `reshuffles`, if the
  deck runs out), and then the old hand goes to the bottom of the deck in
  hand order (no RNG), first card lowest. So an old card can only come
  back once every other card in the deck and discard has been drawn (with
  20 cards and a 7-card hand that never happens). Putting the cards at the
  bottom instead of discarding them keeps them in this pass of the deck;
  requiring "before any play" keeps the pull-down rule below simple.
  - The first version put the hand at the bottom and then drew. With an
    empty deck, which happens at every wave-4 prep with the starter deck
    (20 − 4 × 5 = 0), the same 7 cards came back and the supply was still
    paid (T3 review). When the deck holds at least the hand size, both
    orders draw the same cards, so the match fixture did not change.
- **Supply:** wave 1's prep grants `supply_start + supply_base_income`
  (8 + 6). A won wave k earns `supply_base_income + floor(civilians alive
  at the end / supply_civilians_per_point[k])`, with N = 150, 200, 250,
  300, 400, 500, 650, 800. It is paid when the next prep opens
  (`WaveResult::supply_earned`, `Match::supply_income()`). Lost waves and
  wave 8 earn nothing. Unspent supply carries over.
- **Actions** (`Action`, tagged `type`, snake_case):
  - `play_card {hand_index, target}`, where `target` is externally tagged:
    `{"buildings": [..]}`, `{"polyline": [[x, y], ..]}` or
    `{"point": [x, y]}`, in sim meters.
  - `mulligan`.
  - `keep_cards {hand_indices}`: Prep, Running or WaveWon.
  - `repair {fence_id}` and `pull_down {placement_id}`: prep only.

  Checks run in this order: card index, phase for the kind (fortification
  and armament in Prep, tactical in Running, so nothing on a result
  screen), supply, target kind, then the effect's own checks. A refused
  play changes nothing and is not logged.
- **Errors** (`ActionError`, tagged `error`):
  - `no_such_card`; `card_wrong_phase {card, kind, phase}`, whose message
    says "can only be played during prep / during a wave";
  - `not_enough_supply {need, have}`; `wrong_target {card, expected}`;
  - `too_many_buildings {card, max}`; `already_garrisoned {building}`;
    `not_revealed {building}`;
  - `outside_revealed`: a point or route point outside the revealed disc;
  - `placement {reason}`: geometry, or a fence longer than its card, e.g.
    "fence is 512 m, Light fence allows 400 m";
  - `mulligan_used`, `mulligan_after_play`, `empty_hand`;
  - `too_many_kept {max}`, `duplicate_index`;
  - `no_such_structure`, `no_such_fence`, `nothing_to_repair`;
  - `wrong_phase` for non-card actions in the wrong phase.
- **Structures:** every fortification or armament play adds a `Structure
  {id, card, cost, wave, kind: fence {cells, cell_hp, length_m} | garrison
  {buildings}}`. Ids are never reused (the counter is part of the state, so
  a retry gives the same ids). A new fence over broken cells of an older
  fence takes those cells over, so each cell has one owner for repairs.
  The new fence records them in `taken_over` (`TakenCell {cell, from,
  index}`: the old owner and the cell's position in its list). Pulling the
  new fence down (in the same prep or later) gives each cell it still holds
  back to its old owner, if that fence still stands, at its old position
  and broken as it was (open ground, 0 hp), so the gap can be repaired
  again. Before this fix a same-prep undo left a permanent gap with no
  owner (T3 review). A cell can be taken over more than once (A, then B,
  then C): pulling a fence down re-points the other fences' `TakenCell`s
  that name it to its own `TakenCell` for that cell (the older owner and
  index), or drops them if it built the cell, then sorts that list by
  index so give-back stays in ascending order. So the cell always goes
  back to the newest fence still standing, whatever the pull-down order.
  Before this, pulling down B then C lost the cell for good (second T3
  review).
- **Repair:** costs `max(1, ceil(card cost × repair_cost_factor (0.5) ×
  damaged share))`. The damaged share is missing hp over full hp, and a
  broken cell counts as fully missing. Every cell goes back to full hp,
  and broken cells become fence again (agents on them are pushed off).
- **Pull down:** for a structure placed during this prep, the full cost
  comes back and the card returns to the hand (taken back from the discard;
  it is an undo, replacing T2's `Undo`). For an older structure the refund
  is `floor(cost × pull_down_refund (0.5) × condition)`, with condition =
  hp left / full hp for fences and 1 for garrisons, and the card stays in
  the discard. Fence cells become open ground; garrisons lose their
  towers.
- **Card effects in the sim:**
  - `Tower` now carries its `Weapon` (range, minimum range, damage, period,
    splash), plus `active_from` (the sim tick it starts acting), an
    optional `path` and a speed. A unit is a tower whose building is
    `NO_BUILDING`.
  - Targeting is the same nearest-zombie search with a minimum distance.
    A minimum of 0 accepts every `d² >= 0`, so the plain towers give the
    same floats as before.
  - Splash hits every zombie within `splash_m` of the target's hash-time
    position (where the targeting scan found it, not where it moved in
    this tick's integrate). It uses the spatial hash (bucket order,
    hash-time positions), so the target is always among the hits. (The
    first version centred on the current position and added the target by
    hand; T3 review.)
  - Strikes are `Sim::effects` (`AreaEffect`), pulsed in the towers phase
    after the towers.
  - Delays count from the play: an action applied before tick t with a
    10 s delay acts from tick t + 200, so 200 steps with no shot and a
    shot on the 201st (tested).
  - The paratrooper's landing spot is the point plus an offset drawn
    uniformly in the scatter disc (rejection sampling, at most 16 tries,
    no trig) from the `CARD_EFFECTS` stream of the wave. That stream is
    re-created at Start, so a retry lands it in the same place. The spot
    is moved to the nearest open cell if it is on a building.
  - The convoy starts at the route's first point and moves straight
    between points (it ignores buildings; a known simplification).
  - Units and strikes last one wave: they are removed when the next prep
    opens.
  - Units are not bitten and do not block.
- **Single-wave `Sim` unchanged:** `place_tower` builds the tower from
  `Config::tower_weapon()` (the config values), `place_fence` is
  `fence_preview` + `build_fence_cells` with the same float operations,
  and the new tower fields and effects are not in `Sim::state_hash`.
  **The single-wave fixture stays `0ea142296a5795a9`** (native, WASM and
  the three browsers). `tower_budget` / `fence_budget_m` remain for the
  single-wave prototype only.
- **`Match::state_hash`** now also covers every shooter's position, weapon,
  activation tick, kills and route, the strikes, and the card state:
  supply, hand (ids and keep marks), deck order, discard, both RNG
  positions, the mulligan flag, the keep choice, play counters, income,
  reshuffles and the structures (with taken-over cells). A test changes
  each piece of card state alone (`Match::debug_edit_cards`, hidden) and
  checks the hash changes.
  - The keep choice shares the mulligan flag's byte (bit 1), and the
    taken-over cells follow a fence's cells after a `u32::MAX` marker
    (never a cell index), only when there are some. Both add nothing when
    unset, so runs without them hash as before.
- **Fence input limits** (T3 review, a guard for the server-side replay
  verifier): `Sim::fence_preview` (cards, `fence_length_m` and the
  single-wave `place_fence`) refuses a point off the map (outside `[0, w ×
  cell] × [0, h × cell]`, "fence points must be on the map") and a polyline
  longer than `MAX_FENCE_DRAWN_M` (10 km) as drawn, before rasterizing. That
  is far above any card (400 m placed) even when most of the line is
  clipped. `rasterize_polyline` removes repeated cells with a sort
  (first occurrence kept, so the cell order is unchanged) instead of an
  O(n²) `contains`. Previously `[1e12, y]` walked ~5e11 off-map cells and
  `1e30` overflowed the i64 Bresenham. Both are now refused in microseconds
  (tested under 10 ms). Points outside the revealed disc are still
  accepted and clipped, since cells outside it are walls.
- **Match fixture changed on purpose:** `4909c13c5beea4e9` →
  **`e1061f2da92f6c9f`** (native = WASM under Node, tested). The T3
  review fixes leave it unchanged: its only mulligan has 10 cards in the
  deck, it never uses `KeepCards` or a takeover, and the mortar's
  hash-time splash centre does not change its run. The fixture
  now plays cards: every playable prep card via
  `fixture::fixture_prep_plays`, a tactical card at tick 20 of wave 1, and
  a mulligan in wave 2. It also runs on the T3 defaults (population,
  wave-1 outbreak, supply).
- **Defeat line rounding fix:** `ceil(defeat_fraction × start)` is now
  computed with a 1e-3 tolerance. f32 0.15 is slightly above 0.15, so
  15% of 760 came out as 115 instead of 114. The f32 error is at most
  ~0.006 at 100k civilians, and decimal fractions times an integer have a
  fractional part of at least 0.05, so the tolerance never hides a real
  rounding.
- **Outbreaks on squeezed rings:** on a level smaller than the wave-8 cap
  the rings are squeezed (T2), and outbreak counts now scale with the disc
  area. Wave k gets `max(1, round(clusters[k] × (r_k / r_config_k)²))`
  clusters, and inner clusters likewise (at most the total), so outbreaks
  per km² match the full-size match. A level at least 1.3 km keeps the
  config counts (tested). The Marais (400 m) gets 1 cluster in every
  wave: wave 1's core is full size and its config count is 1. Cluster
  size is not scaled. `Match::outbreak_count(wave)` exposes the result.
- **Balance pass (first pass, Marais, `sim-headless match`, 3 retries per
  lost wave):**
  - Defaults changed: `population_multiplier` 0.5 → **0.3**; wave 1
    outbreak 2 clusters × (8 m, min 5) → **1 cluster × (2 m, min 3)**;
    `supply_start` 4 → **8**; Militia added to the starter deck (see
    above).
  - Tried (seeds 1–6 or 1–8, retries 0 unless noted):

    | variant | cleared 8 waves | wave 1 first try |
    |---|---|---|
    | first card set, T2 outbreak, multiplier 0.5 | 2/6 | 2/6 |
    | + 1 cluster in wave 1 | 2/6 | 2/6 |
    | + wave 1 cluster 4 m, min 3 | 4/8 | 4/8 |
    | + `supply_start` 10, coverage-greedy tower picks | 5/8 | 5/8 |
    | multiplier 0.3, `supply_start` 8 (A, retries 3) | 8/8 | 6/8 |
    | same on seeds 9–16 | 4/8 | 4/8 |
    | multiplier 0.35 (B, retries 3) | 6/8 | 6/8 |

    Once wave 1 is held, the later Marais waves are easy with
    area-scaled outbreaks.
  - A wave-1 probe with N spread rifle towers and no cards needed ~16–24
    towers against the T2 outbreak at multiplier 0.5. Against 1 × 3
    zombies at 0.3 it needed 9–12.
  - **Final (committed defaults), seeds 1–16, 3 retries per lost wave:
    13/16 clear all 8 waves, wave 1 held on the first try in 12/16.**
    Retries per seed: 0, 0, 0, 0, 0, 0, 1, 3 (fails wave 2), 0, 0, 3
    (fails wave 1), 0, 0, 4 (clears), 0, 3 (fails wave 1). Seed 1 clears
    with no retry (a test checks it). A retry replays the same draws, so
    a wave-1 hand that can't hold stays lost unless the player
    mulligans; the script only mulligans a hand with no armament.
    Rerun after the T3 review fixes (mulligan order, keep choice, splash
    centre): the same 13/16 and 12/16, with the same retries per seed.
    Rerun after the T2 review fixes (pockets walled by connection to the
    played area): every wave row of seeds 1–16 identical (13/16, 12/16).
  - Tactical cards barely change the scripted results. With
    `--no-tactical`, seeds 1–16 still give 13/16 and 12/16; only seed 5
    needs 2 retries instead of 0. The script plays them late, on the
    densest visible group.
  - One run on the full-size tiled Marais (1300 m, seed 1): waves 1–2
    won, wave 3 (3 full-size clusters at 450 m) still running at the
    240 s cap with 49% saved. Full-size levels are harder than the Marais
    with the starter deck; tune them with difficulty (T7).
  - With 0.3 the tiled 1.3 km Marais holds about 55k agents at wave 8
    (0.6 × T2's 92k), more headroom under the 100k cap.
- **Script for `sim-headless match`** (`matchcmd.rs`):
  - In prep: mulligan if the hand has no armament; armaments on
    buildings chosen greedily for coverage (the revealed building farthest
    from every shooter and from the edge; odd retries use T2's
    "largest" variants); fences as arcs of a circle 4 m inside the
    previous ring (wave 1: 60% of the core), grown in 2° steps while the
    placed length fits the card; tactical cards kept.
  - While running: every 2 s, a tactical card at the mean position of the
    20 m square with the most zombies.
  - The script only produces actions, so its trig is not part of the sim.

## Player tools

- **Fences are clipped at buildings.** Cells of the drawn line that fall on
  buildings or the map edge are simply not placed, so a line dragged from
  wall to wall seals a street. (Refusing the whole fence made sealing streets
  in Paris nearly impossible.) A line entirely on buildings is refused.
- **Fence cost** is the polyline's geometric length (min one cell) times the
  share of its cells actually placed. Cells that are already fences are
  reused.
- **Undo** is a placement history in the core (towers and fences in one
  stack). Clear undoes everything.
- **Garrison targeting** uses the building's polygon centroid. There is no
  line-of-sight check (spec: known simplification, listed in the report).

## Headless harness

- **S2 towers:** "the 8 largest buildings nearest the centre" is read as the
  8 largest by footprint among the 24 buildings whose centroids are nearest
  the level centre.
- **S3 population:** 20k agents can't fit in a 40 × 40 m compound, so S3 uses
  400 civilians on random interior cells and 100 zombies on random cells at
  least 8 m outside the ring. Outbreak clusters are not used.
- **Time to 50% / 90% lost** counts Infected as lost (civilians remaining ≤
  50% / 10% of the initial count).
- **Scenario runs execute in parallel** (one sim per thread). Benchmarks
  are single-threaded and run one at a time.
- **WASM benchmark:** `tools/wasm-bench.mjs` loads the Node build of
  `sim-wasm` and runs the same level, seed and tick count. Phase timing in
  WASM uses `performance.now()`.
- **Test results in the report** come from running `cargo test --release
  --workspace` and `wasm-pack test --node` and parsing libtest's output.
- **Report charts** are hand-written SVG with an inline hover tooltip, using
  the game's own colours for civilians, infected and zombies. The phase chart
  shows 5-tick means; the tables keep the exact max.
- **Environment:** the report names the host CPU (passed in by `dev.sh` as
  `HOST_CPU`) and what the container sees, because benchmarks run in Docker's
  Linux VM.

## Browser

- **Triple buffering instead of double.** The main thread interpolates
  between the two latest ticks, so it reads two slots while the worker writes
  a third. With only two buffers the worker would overwrite the "previous"
  slot mid-read.
- **WASM memory is not shared** (that would need nightly `build-std` with
  atomics). The worker copies positions and render states from WASM memory
  into the SharedArrayBuffer after each step (about 1 MB at 100k agents).
- **Setup ticks run at 1×** regardless of the speed setting. Speed applies
  while running. (Single-wave prototype; since T5 prep is not stepped at
  all, see "Browser match (T5)".)
- **Commands** are applied by the worker between ticks. Since T5 they are
  queued and applied at the start of the worker's next loop turn, which is
  a tick boundary.
- **Replay same seed** (single-wave prototype, removed in T5) re-created the
  sim with the same level, population and seed and re-applied the placement
  history. The match has Retry wave / Restart match instead.
- **Debug heatmaps** are refreshed once per second while enabled.

## Map screen and live levels

- **Base map:** MapLibre GL 5.24 with the OpenFreeMap "liberty" style (free,
  no API key, CORS headers so it works under COEP `require-corp`).
- **Search:** Nominatim, one request per submit (its usage policy forbids
  search-as-you-type). Clicking the map drops a pin and asks Nominatim's
  reverse endpoint for a street name.
- **Play area preview:** the dashed circle on the map is the play area,
  the 1.3 km wave-8 disc (T6b; it was levelgen's 600 m query radius).
- **Live level generation** (`web/src/levelgen.ts`, retired by T6b:
  picked places now stream blocks, "Streaming map (T6b)") followed `levelgen.py`:
  one Overpass query at 600 m, radius grown from 100 m in 50 m steps until
  600–1,200 buildings, same kinds, floors and 15 m² minimum. Sparse places
  use the full 600 m; fewer than 40 buildings is refused with a message. It
  differs in clipping: without shapely, footprints crossing the circle are
  clipped with Sutherland–Hodgman against a 64-gon, so a footprint cut into
  pieces stays one polygon joined along the edge (those cells are walls
  anyway), and invalid rings are not repaired. If overpass-api.de fails, a
  second public instance (overpass.private.coffee) is tried.
- **Built-in levels** stay as presets on the map screen and need no network.
- **Downloaded levels are cached in memory** for the session (T6b: picked
  places use the IndexedDB block cache instead; the built-in level packs
  are still kept in memory), so going back
  to the map and starting the same pin again doesn't re-query Overpass. The
  last started place is remembered in `localStorage` (map position only).
- **One map for both screens.** The MapLibre map from the map screen stays
  on screen during setup and play; deck.gl draws the game on it through
  `MapboxOverlay` (non-interleaved: its own canvas on top, map events passed
  through). In game mode every `symbol` layer of the style (street names,
  POI icons, road shields) is hidden; buildings, roads, water and parks stay.
  A darkened mask covers everything outside the play circle. Map rotation is
  disabled.
- **Map ↔ sim coordinates.** The level pack uses an equirectangular
  projection around (lat0, lon0). Layers keep their data in sim meters and use
  `LNGLAT_OFFSETS` with a model matrix (translate by the grid centre, scale by
  1/(cos lat0 · 111320) and 1/110540), the exact inverse, so footprints sit on
  the map's buildings without per-frame conversion of 100k positions. Clicks
  and fence drags convert the map's lng/lat back the same way.
- **Our building footprints** are drawn only as a faint tint and outline,
  since the base map already draws the buildings. Fences are near-black
  (white vanished on the light map) and turn red as they take damage.
- **Replay** passes the level JSON itself to the worker, so replays never
  re-download.

## Browser tests

- **Playwright 1.61.1, pinned exactly**, with Chromium, Firefox and WebKit
  projects (`web/playwright.config.ts`). The Docker image installs the same
  version's browsers with `--with-deps` into `/ms-playwright`, outside the
  `node_modules` volume; `PLAYWRIGHT_VERSION` in the Dockerfile must follow
  `web/package.json`.
- **Why 1.61 and not the latest (1.65):** Playwright froze WebKit for macOS 14
  at build 2251, and from 1.62 on the driver sends a setting
  (`PushAPIEnabled`) that this build does not know, so every WebKit page
  fails to open on a macOS 14 host. 1.61.1 is the newest version that works
  there. Moving up is safe once the host runs macOS 15+.
- **The test server is Vite dev on port 5199**, not 5173, so tests can run
  while `npm run dev` is up. Its command runs `npm run wasm` first, so a bare
  `npx playwright test` never tests a stale WASM build (the rebuild is
  incremental, a few seconds).
  The port is `PW_PORT` (default 5199) and a running server is reused only
  with `PW_REUSE=1`: by default a busy port fails the run, so a leftover Vite
  or another worktree's server is never tested by mistake.
- **The smoke test sized its own timeout** from `max_game_seconds` (T0;
  the smoke test was replaced by the match tests in T5, which derive their
  timeouts from their own waits: `OPEN_LEVEL_MS` in `e2e/ui.ts` plus the
  play and verify budgets).
- **Tests run offline.** A shared fixture (`web/e2e/offline.ts`) routes every
  request: the Vite server passes, the OpenFreeMap style URL gets a blank
  local style (`e2e/fixtures/style.json`, one background layer) so MapLibre
  still loads and fires its events, and everything else (tiles, Nominatim,
  Overpass, fonts) is aborted. The tests only use the built-in levels.
  Since T5 the fixture's teardown checks, for every test, that each
  non-local request was handled by the router (answered or aborted),
  matched per `Request` object rather than per URL (the T0 smoke test
  checked URLs, once, at its end, so a URL aborted once could hide a later
  request to it that got through).
- **Test hook behind `?test=1`.** `main.ts` imports `src/testhook.ts`
  dynamically only in test mode, so the normal page never loads or runs it.
  `window.__zt` exposes read-only snapshots (screen, phase, tick, stats,
  placements, level summary, state hash) and helpers that send exactly the
  worker messages the UI sends. The only protocol addition is a `hash`
  request/reply, answered by the worker with the current tick and hash.
  (Version 2 since T5, see "Browser match (T5)".)
- **The smoke test clicked through the real UI** (preset chip, population
  slider, Tower/Fence tools, a click on a building, a drag for the fence,
  Start, 4×) and used the hook only to find screen positions and to assert.
  It played Le Vésinet at 5k agents. T5 replaced it with the match tests.
- **Chromium runs as full Chromium in new headless mode** (`channel:
  "chromium"`), not the default headless shell. With the shell, every input
  event waited about half a second on software-rendered frames and the smoke
  test took 1.5 minutes instead of under one.
- **Firefox WebGL in Docker:** headless Firefox on a GPU-less Linux refuses
  WebGL, so MapLibre can't start and the page never gets past the map. The
  Firefox project sets the `webgl.force-enabled` pref and the image sets
  `MOZ_WEBGL_FORCE_EGL=1`; together they give Mesa's llvmpipe (both are
  needed). A Linux host without a GPU needs the same variable.
- **Generous waits instead of retries:** level load and spawning get 60 s
  (they take a few seconds, but three browsers share the CPU) and the whole
  game 170 s (about 45–55 s at 4×). `retries` stays 0 so flakiness shows.
  The smoke test logs the end tick, kills and final state hash per browser;
  in practice all three end on the same tick, but that is not asserted
  because the placements come from browser-dependent pixel → meter
  conversions.
- **The cross-browser determinism test** runs the existing fixture through a
  small test page (`web/e2e/pages/fixture.html`) that loads the same WASM
  build as the game and calls the existing `fixture_hash` export. No new
  WASM export was needed. It runs on the main thread; the worker uses the
  same module, so the engine and the result are the same.

## Browser match (T5)

- **The worker owns a `WasmMatch`** built with `Match::new` on the whole
  level pack for the built-in levels, or `Match::new_streaming` on a shell
  and blocks for a picked place (T6b, "Streaming map"), with the setup from the profile (T7b: `setup {seed, deck, population_multiplier}`; T5 sent no deck, i.e. the starter deck; the deck
  builder is T7b, "Profile UI"). The seed is sent as a decimal string, end to end: the
  input is a text field parsed with `BigInt` (`web/src/seed.ts`, 0 to
  2^64 - 1, never through `Number`), so seeds above 2^53 are exact (a test
  checks the record's `setup.seed` for 2^53 + 1).
- **Protocol** (`web/src/protocol.ts`). To the worker: `init {levelJson,
  setup {seed, deck?}, test?}`, `stop`, `action {id, action}`, `pause`,
  `pause_toggle`, `speed`, `pause_at {tick}` (test only), `query {id, query}` (`pick`
  at a point, `fence_length` of a polyline, `costs` of a structure id,
  `agents` (test only)),
  `record {id}`, `field`, `hash` (test only). From the worker: `ready
  {level, shared}`, `geometry` (applied buildings, sent again when a reveal
  adds some), `frame` (fallback mode), `status` (the `status_json` HUD
  numbers and the clock: paused, speed, sim ms), `state` (hand,
  structures, results, attempts), `placements` (shooters and fence cells
  with their hp share), `action {id, action, error}`, `query`, `record`,
  `error`, `field`, `hash`. Actions are JSON `Action`s (sim-core's serde
  format) and refusals the `ActionError` JSON with its `message`.
- **Every request settles (T5 review).** On `stop` or a re-`init` the
  worker answers each queued action with an `aborted` error, and with no
  match it answers actions the same way and queries, records and hashes
  with `{aborted: true}` (also an `agents` query outside test mode). The
  page resolves the action promise with that error (no toast) and rejects
  the others with "aborted", so nothing waits forever and the pending maps
  don't grow.
- **Actions apply at a tick boundary.** The worker queues them and applies
  the queue at the start of its next loop turn, before stepping; the loop
  is the only place that steps, so that is always between two ticks (as the
  input log assumes: an action is logged with the match tick it was
  applied before). The worker posts `state`, then `status`, then the
  `action` replies, so whoever awaits an action (the UI, the test hook)
  already has the state it produced.
- **Prep is not stepped.** The worker steps the match only while a wave
  runs: prep and the result screens are static, with no cosmetic wander.
  `Match::step` in prep only moves the wander, which Start resets, so the
  game is the same; but each prep tick is in the record's tick count, is
  covered by the state hash and must be replayed at full cost (T4, "Prep
  ticks are replayed"). Not stepping keeps run records short (every prep
  is zero ticks: an attempt starts on the tick the previous one ended,
  which the match test checks) and the server's replays cheap, however
  long the player thinks in prep. It also matches `sim-headless match`,
  which never steps prep. The cost is a frozen crowd during prep.
- **Pause and speed never reach the sim.** They only decide how many ticks
  the worker steps per 50 ms of wall time (1, 2 or 4; result screens and
  prep step none). A pause belongs to its wave (T5 review): `pause` is
  ignored unless a wave runs, and entering prep (next wave, retry,
  restart) clears both the pause and `pause_at`, so a wave never starts
  paused because the previous one was. A test checks it: the same seed and actions run once
  with button clicks at 1×, paused, then 4×, and once as fast as possible,
  hash the same at the same wave tick. That test waits on the worker's
  status and on sim ticks after each click, never on wall-clock time.
- **Pause is toggled in the worker (T5 review).** The Pause button and
  Space send `pause_toggle`, which the worker applies to its own `paused`
  (only while a wave runs, like `pause`). They used to send `pause
  {paused: !perf.paused}`, but `perf` is only as fresh as the last
  `status`, so two presses before the next status both asked for "paused"
  and the second was lost. The worker owns the state and applies messages
  in order, so a toggle there needs no reconciliation; a page-side
  "wanted" flag reconciled from status was the alternative, but it cannot
  tell a stale in-flight status from the worker pausing itself on
  `pause_at` or a prep clearing the pause. `pause {paused}` stays for the
  test hook. A test clicks Pause twice, and presses Space twice, in one
  task and checks the wave is left unpaused and its ticks advance.
- **Test-only speeds:** with `?test=1` (the page sends `test: true` in
  `init`; the worker refuses them otherwise) the speed may also be 16
  ticks per 50 ms or 0, "as fast as possible": the worker steps for 40 ms
  slices and yields between them so messages get through. `pause_at` makes
  the worker pause itself on a given match tick while a wave runs, so a
  test can act at an exact tick whatever the browser's speed; set to the
  prep's tick (the hook's `startPaused`), the next wave starts paused on
  its first tick. That replaced the tests' "pause in prep, then Start",
  which relied on the pause carrying over. Both are clock controls: they
  change when ticks run, never what a tick does.
- **Triple-buffered rendering is unchanged**, but the slots now hold the
  capacity (`max_population`, 100k: ~2.7 MB for the three slots) and a new
  header field `H_COUNT` says how many agents are in play, since newcomers
  join at each reveal. After any phase change (a reveal or a retry moves
  everyone) the worker publishes twice so both interpolation slots agree.
- **Targeting uses the core only.** Building clicks go through
  `WasmMatch.building_at` (the clicked cell, never the old `Sim` polygon
  fallback, DECISIONS "Run records"); valid armament targets are
  highlighted from `WasmMatch.building_info` (added in T5, marshalling
  only: centroid, area, floors, cell count and the centroid's wave), using
  the core's rule (cells > 0, centroid wave ≤ current wave, not
  garrisoned). The core still decides: a refused play shows its
  `ActionError` message (with a card id replaced by the card's name; the
  test hook gets the raw error). Fence drags ask the worker for the placed
  length (`fence_length_m`) at most every 80 ms plus once after the last
  move, and show it against the card's limit (from `cards.json`) and the
  cost. Repair and pull-down: a click with no card selected asks the worker
  for the structure within 3 m of the point (fence cells are 2 m, so a
  click needn't hit the exact cell) or the garrison on the clicked
  building, with its repair cost and refund. A click inside a garrisoned
  building picks that garrison even with a fence within 3 m (T5 review).
- **Building picks (T5 review).** An armament only takes highlighted
  buildings (`validBuildings`); a click on any other building leaves the
  picks as they are and says why ("Not available: already garrisoned",
  "outside the revealed area", "too small to garrison"). A play the core
  refuses keeps the card selected (the picks too; a line draft is
  dropped), so the player fixes the target instead of starting over.
  While a play waits for its answer, clicks and drags are ignored.
- **A selection lives in one hand and one phase (T5 review).** It is
  dropped (with the targeting panel, hint, cursor, map-panning lock and
  line draft) when the card at its hand position is no longer the same
  card, on every phase change, and on a retry or restart, including one
  that stays in prep (the status's `retries`/`restarts` counters moved).
  Before, the selection silently became whatever card took the position,
  so the next map press could draft and play a fence nobody chose.
- **Phase buttons are one at a time (T5 review).** Start / Next wave,
  Retry, Restart (toolbar and result panel) and Mulligan are disabled while
  one of those actions waits for its answer, so a double click sends one
  action (no second retry, no refused second Start and its toast). Retry
  is disabled in prep: there it would only count a retry.
- **The inspect panel asks again (T5 review).** It holds the structure id
  and asks the worker for that id's repair cost and refund (`costs`) on
  every `state`, `placements` (fence damage, every 250 ms while a wave
  runs) and phase change, one query at a time. It closes when the
  structure is gone and on every retry or restart, since structure ids are
  reused after a restart. Its element carries `data-structure` for tests.
- **Seed changes commit on Enter or "New match" only** (a blur does
  nothing), and ask for confirmation while a wave runs or a result panel
  is up. The download name uses the seed of the match on screen, not the
  input.
- **Keep clicks build on each other.** The page keeps the list it last
  sent until every pending `keep_cards` is answered, so two quick clicks
  keep both cards; a refused toggle is taken back from that list.
- **Keyboard:** a focused hand card is selected with Enter or Space (it
  keeps the focus across the hand's re-render); Space on a focused card or
  button only activates that control, never also the pause shortcut.
- **Error wording (T5 review).** `ActionError`'s `Display` is player
  facing: `Phase`, `CardKind` and `TargetKind` have their own `Display`
  ("prep", "a wave in progress", "tactical", "a line", ...), action names
  read as words ("pull down is not allowed during a wave in progress"),
  and no building, fence, structure or hand index appears. Errors keep the
  card id (the error carries no card database); the page swaps a leading
  id for the card's name. Messages are not hashed: no fixture, golden
  record or hash changed.
- **Fog** is drawn from `radius_m` and `next_radius_m`: the next ring gets
  a light dark veil, everything past it a darker one. No agent can be in
  the fog (cells outside the revealed disc are walls; a test checks it), so
  nothing is filtered.
- **Keep marks** are per card toggles that send the whole new list
  (`keep_cards`); the core refuses a third. The UI cannot send an empty
  explicit choice other than by unmarking (the core's "no choice" default
  keeps the first two).
- **"Total saved" on the match panel** is the civilians alive at the end of
  wave 8 (survivors carry over from wave to wave, so summing the waves
  would count people several times), with its share of wave 8's starting
  civilians and a per-wave table.
- **The run record** comes from `WasmMatch.record()` in the worker and is
  saved with a Blob download named after the place and seed. It is
  `abandoned` unless the match is won (T4's rule); only the match panel
  offers it for now (the test hook can fetch it at any time).
- **The single-wave UI is gone** (population slider, Tower/Fence tools and
  their budgets, Undo/Clear, Replay same seed). `WasmSim` stays in
  `sim-wasm` for the cross-browser fixture test.
- **Test hook version 2** (`window.__zt`, `web/src/testhook.ts`): match
  snapshots (screen, phase, tick, wave, supply, status, hand, structures,
  results, attempts, towers, buildings, level, result panel, toast, hint,
  selection, what the last frame drew), `record()`, `stateHash()`, action
  helpers (`act`, `playCard`, `mulligan`, `keep`, `repair`, `pullDown`,
  `startWave`, `nextWave`, `retryWave`, `restartMatch`) that go through the
  same `act` function as the UI controls, read-only queries (`pick`,
  `fenceLength`, `agents`, `zombies`), the clock (`pause`, `speed` with
  the test-only 16 and 0, `pauseAt`, `startPaused`), the inspect panel
  (`inspected`), and screen helpers. `uiActions`
  counts the actions the UI controls sent and keeps the last refusal, so a
  test can wait for a click's outcome.
- **The full-match test** (`web/e2e/match.spec.ts`) plays a scripted
  scenario (`e2e/scenario.ts`) on the Marais with seed 2: wave 1 lost with
  no defence and retried, a mulligan in wave 2, keep choices every wave,
  one armament by building clicks, one fence by a drag pulled down again
  by a click on it, the first repair by a click on the damaged fence and
  the panel's Repair button (after checking the panel shows the worker's
  current cost), the first tactical card by a click on the map, and a
  bot (`e2e/bot.ts`, a TypeScript port of `sim-headless match`'s
  strategy) for the rest. While a tactical card is playable it pauses on
  every 40th wave tick (`pause_at`), like the Node check, so the browser
  plays exactly the same actions on the same ticks as `node
  e2e/bot-check.mts 2` (8,463 ticks, 9 attempts, 69 actions in Chromium,
  Firefox and WebKit alike; UI clicks map to the same building indices,
  the pulled-down fence leaves no trace, and the tactical click's few
  centimetres of pixel rounding did not change the outcome). Seed 2 was
  picked among 1–10 for being quick and having both a pull-down and a
  repair. The record is downloaded with the panel's button and verified
  by the native `sim-headless verify` (`cargo run --release`, so it is
  rebuilt if needed); every attempt's end hash must equal the browser's
  (`attempts`), and the final hash the browser's state hash. Native
  rather than Node WASM: it needs no `pkg-node` build and checks the
  cross-platform claim (browser WASM = native) directly.
- **Losing wave 1 takes ~3,400 ticks** (no defence until the 15% line),
  about 40% of the test's ticks. A faster loss isn't available without
  changing the rules, and it runs at test speed.

## Map blocks (T6a)

The streaming-map library lives in `web/src/map/` (not wired into the game
yet: that comes after T5).

- **The grid is a lat/lon grid, not Web Mercator.** Rows are 1/440° of
  latitude (110540 / 440 = 251.2 m). Each row has a whole number of equal
  columns around the globe, `round(360 × 440 × cos(mid-lat) × 111320 /
  110540)`, so blocks are about 251 m square everywhere. Every block is a
  lat/lon rectangle, and the level projection is linear in lat and in lon
  separately, so a block projects to an exact axis-aligned rectangle for any
  match centre and neighbours share their projected edges bit for bit (the
  sim-core tiling contract). Web Mercator blocks would also be lat/lon
  rectangles, but their size in meters drifts with latitude and their edges
  need `atan(sinh())`. Rows don't align their columns, which tiling doesn't
  need. The antimeridian isn't handled (no match centre near ±180°).
- **Block id = `row × 2^18 + col`**, row 0 at the south pole. Columns per
  row are at most about 163 000 < 2^18 and rows 79 200, so ids are below
  2^35: a plain JS safe integer, a JSON number and a Rust `u64`, with no
  string encoding. The Paris fixture centre's block is 16016265130 (pinned
  in a test: changing the grid breaks every cache and run record).
- **`detCos` instead of `Math.cos`.** The column count and the projection
  use a cosine computed with + − × ÷ only (Taylor series to x^24, |x| ≤
  π/2), because `Math.cos` is implementation-defined and could differ by an
  ulp between browsers, moving a block edge or a building by a centimetre
  and so the snapshot hash. `levelgen.ts` (retired in T6b) used the same shared
  projection (`map/osm.ts`); the Python tool keeps `math.cos` (identical
  after cm rounding in practice).
- **A building belongs to the block containing its anchor vertex**: the
  lexicographically smallest (lat, then lon) vertex of its ring (closing
  vertex excluded), so the rule doesn't depend on the ring's starting
  vertex or direction. It has to be a vertex: Overpass `way(bbox)` returns
  a way only when one of its vertices or segments is in the box, and the
  vertex lies in its block's (padded) box, so that block's own query always
  returns it. The first version used the vertex mean, which can fall in a
  block that no vertex or segment enters (a C-shaped building around it):
  the building was then lost when that block was fetched alone, and found
  when it was batched with a neighbour, so a block's content depended on
  the batching. The Overpass query for a batch is a union of
  `way["building"](bbox)` boxes (each padded by 1e-6°); ways owned by other
  blocks are dropped. Only ways, like the retired `levelgen.ts` (no multipolygon
  relations). The test fake answers with the same vertex-or-segment rule.
- **An Overpass runtime error is a failure, never an empty block.** On a
  timeout or out-of-memory Overpass answers HTTP 200 with
  `remark: "runtime error: …"` and partial or empty `elements`. A `remark`
  containing "error", an unparsable body or a body whose `elements` is not
  an array counts as a failed endpoint (`overpassQuery` tries the next one,
  then the loader's retry), so it is never cached. The retired
  `levelgen.ts` had the same check; `tools/levelgen/levelgen.py` (static
  levels, run by hand) does not.
- **The cache stores raw lat/lon** (`[lat, lon, ...]`, not closed), the
  derived kind and floors, the fetch date and a content hash (FNV-1a 64 of
  `JSON.stringify([id, [[bid, kind, floors, ring], ...]])`). The schema
  version is the IndexedDB version: opening with another version drops the
  store (an older build opening a newer database deletes and recreates it).
  **Schema 2**: anchor-vertex assignment, error remarks rejected, floors
  rounded half up. Empty blocks are cached too, so a second visit makes no
  request. The cache is best effort both ways: a failed `put` or `getMany`
  doesn't fail the load (a failed read counts as nothing cached). When
  another tab opens a newer schema, `onversionchange` closes the connection
  and the cache marks itself closed: reads then return nothing and writes
  are no-ops. `openBlockCache()` falls back to `MemoryBlockCache` when
  IndexedDB is missing or the open fails or is blocked. Blocks never expire
  by default; `MapLoader`'s `maxAgeMs` option re-fetches older ones.
- **Projection rules** (`projectBlock`): the level projection relative to
  the match centre, rounded to cm like level packs (half up, see below); bounds are the projected
  block corners rounded to cm (the same rounding on a shared edge, so tiling
  stays exact). A building with a vertex more than 49.9 m outside its block
  is **clipped** to the block grown by 49.9 m (Sutherland–Hodgman), not
  dropped; the 0.1 m below `block_margin_m` absorbs cm rounding and f32.
  The part beyond is lost (no other block has it). Trade-off of the anchor
  vertex: it is the building's southernmost vertex, so the building can
  stick out of its block by up to its full depth (north) or width (east or
  west), against about half of it under the vertex mean. A building 50 to
  100 m across is therefore more likely to be clipped, and one much larger
  than 50 m (a station, a museum) loses whatever lies beyond 49.9 m. On the
  Marais fixture nothing is clipped, but the worst overshoot is 49.4 m
  (30.8 m with the vertex mean); `loader.test.ts` reports both. Buildings
  under 15 m² are dropped, as in `levelgen.ts`. Buildings are sorted by OSM
  id.
- **`abort()` is final, even with a warm cache.** `start()` checks the
  signal before and after loading the initial blocks, so it rejects with an
  AbortError even when every block came from the cache without a network
  wait. After an abort no block is added and no `chunk` or `ring` event is
  emitted: cache hits are skipped and the put loop checks the signal before
  each block. This holds when a listener aborts mid-event: the remaining
  `chunk`/`ring` listeners are skipped and no `ring` event follows the
  `chunk` that triggered the abort.
- **Listeners can't break the loader.** Each `chunk`, `ring` and `error`
  listener is called in its own try/catch: a throw (in the planned wiring,
  `match.add_buildings` returning an error) is not a network failure, so it
  causes no refetch, no extra query, no `error` event and no failed block,
  and `start()` still resolves. The error goes to the `listenerError` event;
  with no `listenerError` listener (or when that one throws) it is rethrown
  from `queueMicrotask`, so it shows as an uncaught error in the console
  without touching the load.
- **Map snapshot hash** (`snapshotHash`, for the run record in T4):
  FNV-1a 64 (offset 0xcbf29ce484222325, prime 0x100000001b3) over the UTF-8
  bytes of `"zt-map-v1\n"` followed by, for each chunk in ascending block
  id order, its canonical line and `"\n"`. The canonical line is the
  compact JSON `[block_id,[x0,y0,x1,y1],[[id,"kind",floors_dm,[x,y,x,y,...]],...]]`
  with buildings in id order, coordinates as integer centimetres
  (`floor(v × 100 + 0.5)`) and floors as integer tenths
  (`floor(floors × 10 + 0.5)`). Result: 16 lowercase hex digits. Integers
  make it portable: Rust gets the same bytes from its f32 chunks with
  `(v as f64 * 100.0 + 0.5).floor() as i64` and `serde_json::to_string`
  of the same tuple shape (`crates/sim-core/tests/t6_chunks.rs` does this
  and checks the fixture's hashes; since T4 it is `sim_core::mapsnap`). It hashes the
  projected chunks (what the sim consumes), so it depends on the match
  centre; the per-block content hash of the raw data is kept alongside
  (`MapLoader.blockHashes()`). JS computes FNV in 16-bit limbs, checked
  against a BigInt reference.
- **Rounding is `floor(v + 0.5)` everywhere** (cm coordinates and bounds,
  the canonical line's centimetres and tenths, floors from tags), written
  literally as `Math.floor(v + 0.5)` in JS (`roundHalfUp` in `map/osm.ts`).
  A server-side port must use that formula, not its language's `round`:
  Rust's `f64::round` rounds negative halves away from zero (−12.5 → −13,
  where JS gives −12), and coordinates west and south of the centre are
  negative.
- **Loader order:** waves are the rings of discs of radius
  `ring_radius + block_margin_m + coverageSlackM`; wave w's blocks touch
  disc w but not disc w−1 (a 5 cm slack counts tangent blocks).
  `coverageSlackM` defaults to one cell diagonal (`cell_size_m × √2`, read
  from `config.default.json`: 2.83 m): sim-core's `ring_ready` checked the
  cells within `ring_radius + block_margin_m`, and the T2 review fixes widened
  that to `+ cell_size_m × √2` (see "Match", `ring_ready`). The larger
  disc is a superset of both, so the JS loader is right with either rule
  (`MapLoader.ringReady` implies sim-core's). `start()` loads waves 1–2
  (cache first, then Overpass) and resolves with their chunks; the rest
  follows in wave order, closest block first, 6 blocks per query, 2
  queries in flight, 5 attempts with backoff from 1 s doubling. A
  background batch that still fails emits `error` and waits for
  `retryFailed()`. `start()`'s chunks are not emitted as `chunk` events, so
  each block reaches the sim once. `matchRingRadii` ports
  `Match::ring_radii` (f32 via `Math.fround`) for squeezed levels.
- **Loader failures and abort.** Every exit from a load (success, failure,
  abort) releases the blocks it claimed and didn't load, so `start()` can
  be called again after it rejects and only fetches the initial blocks
  still missing (concurrent calls share one load; after a success it
  returns the same chunks). `abort()` cuts requests and backoff sleeps
  short (the sleep is raced against the abort signal, whatever `sleep`
  option is given). Pending `whenRingReady(w)` promises reject with an
  `AbortError` on abort, and with "map ring w can't be loaded" once a block
  that wave needs failed all its attempts (initial or background); after
  `retryFailed()` or a new `start()` they can be awaited again.
- **Unit tests run under Vitest in Node** (`npm run test:unit`, config in
  `web/vitest.config.ts`, tests in `web/test/unit/`, typechecked with
  `@types/node` through `web/test/tsconfig.json` so the browser code keeps
  its DOM-only types). The fixtures rebuild Overpass ways from the committed
  `levels/paris-marais.json` (inverse projection, 7 decimals) and a fake
  Overpass server answers the bbox queries; no network.
- **Rust fixture:** `npm run fixtures:chunks` writes
  `crates/sim-core/tests/fixtures/map_chunks.json` (`BuildingChunk[]`, the
  Paris buildings as a 500 m streaming level) and `map_chunks.meta.json`
  (centre, schema, margin, slack, ring radii, waves 1–2 block ids, snapshot
  hashes); the unit test fails when they are stale. 500 m rather than the
  pack's 400 m because on a 400 m level ring 3 is only 33 m past ring 2 and
  the waves 1–2 blocks already cover it. `crates/sim-core/tests/t6_chunks.rs`
  reads it: `Match::new_streaming` with the waves 1–2 chunks gives
  `ring_ready(1)`, `ring_ready(2)` and not `ring_ready(3)`; every other chunk
  is accepted by `add_buildings`; then `ring_ready(8)`; and the snapshot
  hashes recomputed in Rust equal the JS ones.
- **`levelgen.ts`'s grow-the-radius logic** was retired by T6b (below).

## Streaming map (T6b)

- **Picked places stream; built-in levels don't.** A place picked on the map
  is played on a **shell**: its centre (rounded to 1e-6°, ~10 cm), radius
  `wave8_radius_m` (1300 m), no buildings, no fences (`stream.ts`
  `buildShell`, checked against the `ShellLimits` rules a radius-only shell
  can break, plus the block grid's own limits: no centre within 1° of the
  antimeridian or above 85° latitude). Its rings are the config's
  (`matchRingRadii` on a 1300 m level). The worker builds it with
  `WasmMatch.new_streaming(shell, setup, chunks)`. The built-in levels
  (Paris Le Marais, Le Vésinet) keep `WasmMatch::new` on their whole level
  pack, so their records, golden hashes and the T5 tests are unchanged.
- **`levelgen.ts` is retired.** Its single Overpass query and its sizing
  rule (grow the radius in 50 m steps until 600–1,200 buildings, up to
  600 m) are replaced by the fixed ring radii: every picked place is a
  1.3 km wave-8 match, the scale T1 chose, however dense. The "too empty to
  play" check stays, on the waves 1–2 blocks: fewer than 40 buildings there
  refuses the place ("Only n buildings around the pin"). The blocks reach
  past the wave-2 disc (350 m) by up to a block (~250 m), so the message
  names no distance. The map screen's dashed
  circle is now the 1.3 km play area. `tools/levelgen/levelgen.py` stays,
  for the committed levels only (they are whole-level packs, sized by its
  600–1,200 rule); it is not ported to blocks, since nothing else uses it.
  Its "One Overpass query per level" note (Level data) applies to it
  alone.
- **Flow.** "Start here" opens a `MapSession` (`mapsession.ts`): the shell,
  a `MapLoader` with the page's block cache (`openBlockCache()`, opened
  once) and its `DistrictGate`. `start()` loads waves 1–2 (cache, then
  Overpass), shown as "Downloading the map… n / m blocks" (polled every
  200 ms). Then `init` sends the shell and **every chunk loaded so far**
  (`loader.chunks()`), and every later `chunk` event is posted to the worker
  as it arrives. Chunks the loader emits before the first `init` are in
  that snapshot, so each block reaches a match once; "New match" (another
  seed) rebuilds on the same snapshot with no request.
- **Protocol additions.** To the worker: `init {map: {level} | {shell,
  chunks}, setup, test?}` (was `levelJson`) and `chunk {chunk}`. From the
  worker: `map {stored, queued, refused}` after an init and after each
  chunk is added or queued.
- **Chunks are added only while no wave runs.** The worker's `ChunkQueue`
  (`stream.ts`) adds a chunk at once in prep and on the result screens and
  queues it while a wave runs; the queue is flushed at the start of every
  loop turn (before the queued actions, so a Next wave posted after a chunk
  always finds it added). "At the next prep" in the plan would deadlock: the
  next ring's chunks that arrived mid-wave must be in before Next wave, which
  is pressed on the result screen. The core allows `add_buildings` in any
  phase and stores chunks outside the match state (applied at the reveal
  that first needs them, in block id order), so the timing never reaches a
  hash; holding them during a wave only keeps that work out of the wave's
  ticks. A block is handed over once (`ChunkQueue` drops repeats); `init`
  and `stop` drop the queue.
- **A refused chunk is a bug, reported loudly.** With the loader's superset
  rule (`MapLoader.ringReady` implies `ring_ready`) and chunks added before
  every Next wave, `AreaRevealed` can't happen. If the core refuses one
  anyway, the worker reports it in `map.refused`, the page logs
  `console.error`, shows a toast and keeps it in the test hook
  (`map.refused`, which every stream test asserts empty). A `ring_not_loaded`
  refusal of Next wave while the loader says the ring is in is logged the
  same way.
- **Next wave waits for its ring.** Start and Next wave go through
  `waveAct`: on a streamed map, when `loader.ringReady(wave)` is false
  (Next wave: the next wave; Start: the current one, always ready since
  `start()` covers waves 1–2), the `DistrictGate` shows a banner, "Loading
  the next district… n / m blocks" (`MapLoader.ringProgress`, the blocks of
  waves 1..w, updated on each `chunk` event), with Start and Next wave
  disabled, and sends the action as soon as `whenRingReady` resolves. When a
  block the ring needs failed all its attempts, `whenRingReady` rejects:
  the banner turns into the error with a **Retry loading** button
  (`loader.retryFailed()`, then it waits again). While the error shows, the
  loader goes on with the other rings' batches; their `chunk` events leave
  the banner alone (the gate's `failed` flag, cleared by Retry loading), or
  they would turn it back to "Loading…" and hide Retry loading with
  nothing waiting for the ring any more. Any phase change (a retry
  or restart from the result panel), a new match or leaving cancels the
  wait. The core still has the last word (`NextWave` refuses
  `ring_not_loaded`), so a page bug can't start a wave on partial data.
- **Retry and restart never re-fetch:** the match keeps its stored chunks
  and the loader keeps going (or is done) in the background; the cache
  only matters to the next visit. Leaving the match (← Map, New location)
  aborts the loader: no request and no chunk after it. A second visit to the
  same area is served from IndexedDB with zero requests.
- **Each Overpass request has a 90 s limit; a batch starts nothing new
  after 150 s, so it fails for good within 240 s.**
  `OVERPASS_REQUEST_TIMEOUT_MS` (`map/osm.ts`, 90 s, above the queries' own
  `[timeout:80]`): past it the endpoint counts as failed ("Overpass did not
  answer within 90 s") and the next one, then the loader's backoff, takes
  over. 90 s is well above the slow but working answers of the manual check
  below (one batch took 48 s, a single block 31 s), so those load on the
  first attempt. `batchBudgetMs` (`DEFAULT_BATCH_BUDGET_MS` in
  `map/loader.ts`, 150 s): once it has run out no new attempt, endpoint or
  backoff starts (a backoff under way is cut short), but the request in
  flight is never cut by the budget, only by its own limit, and its answer
  is used if it comes. Otherwise the batch has failed for good ("Overpass
  could not load these blocks in time (last error: …). Try again in a
  minute."; T8: the message used to say "within 150 s", which a batch whose
  last request started near the budget overshoots by up to 90 s, so it now
  names no duration), so the first load fails or the banner shows the error and
  Retry loading. Bound: budget + one request limit, 240 s (a request
  started just before 150 s runs to 240 s); servers that never answer fail
  at 180 s (both endpoints once), servers that answer 504 at once after the
  5 attempts and 15 s of backoff. Without the budget, servers that hold
  every request would take 5 attempts × 2 endpoints × 90 s plus the backoff,
  ~15 min, to count as failed. Cutting the request in flight at the budget
  (the first T6b fix, with a 45 s limit) failed a server that answers
  correctly in 48 s for good. Found in that check: the fallback instance
  held one request for 267 s; with no limit a request that never answers
  would never fail, so neither the retry nor Retry loading would ever come.
- **Test-only backoff and limits.** With `?test=1` a failed Overpass query
  is retried after 50 ms (doubling, 5 attempts) instead of 1 s, so the
  failure check sees the error in under a second, and the request limit
  and batch budget are an hour each instead of 90 s and 150 s: the stream
  E2E holds its "slow" request through waves 1–2, which is minutes in
  Firefox (with the real limits that hold itself turned into the failure).
  Clock controls: the blocks are the same. The real limits are unit-tested
  with fake timers and fetches that never answer (`loader.test.ts`, "time
  to a permanent failure").
- **Map bundle for headless verification.** The match panel of a streamed
  match has **Download map** next to Download run record: one JSON file,
  the shell (a `LevelPack` without buildings, so it is a valid `--shell`)
  plus `chunks`, the record's `map.blocks` in block id order. `sim-headless
  verify --chunks` (and `tools/verify-run.mjs`) now also takes that bundle
  as well as a plain `BuildingChunk[]` (a tooling change in sim-headless
  only; sim-core, sim-wasm and the record format are unchanged), so
  `verify run.json --chunks map.json --shell map.json` replays it. The
  record covers the blocks the match holds when it is saved (every chunk
  stored, applied or not), which the bundle reproduces exactly. A server
  never uses a client's bundle (Run records, "the server must replay only
  on map chunks it fetched itself"): it is a tester's tool.
- **Tests.** Unit (`stream.test.ts`): the shell, the chunk queue (added
  outside waves in block id order, held while a wave runs, repeats dropped,
  refusals reported), the gate on a real `MapLoader` with the fake
  Overpass (progress while a block is held, the error and Retry loading,
  the error kept while other rings' chunks arrive, cancel and abort), the
  bundle; `loader.test.ts` bounds the time to a permanent failure. E2E (`e2e/stream.spec.ts`, all three
  browsers) routes Overpass to per-block fixture answers built from the
  committed Marais level (the T6a fixtures' bbox parsing and
  vertex-or-segment rule), through `routeExternal` in `e2e/offline.ts`, so
  the network-leak teardown counts them as handled. One test, on seed 1
  (the default; the bot wins waves 1 and 2 on the first try there, seeds
  2–8 lose one of them, and the test asserts no lost attempt):
  the first load asks for exactly the 10 waves 1–2 blocks (2 queries)
  while every background query is held, so prep can't have waited for one;
  background blocks released during a paused wave 1 wait in the worker
  (`queued` > 0) and are added at its end; wave 2 opens without the banner;
  a held wave-3 batch makes Next wave show "Loading the next district… n /
  m blocks" with Start and Next wave disabled; that batch is then switched
  to 504 and let through: after its five attempts (test backoff) the banner
  shows the error and Retry loading; a held ring-8 batch let through after
  that leaves the error and Retry loading up (the gate's `failed` flag);
  with the server fixed, Retry loading opens wave 3's prep, all 109 blocks
  then held by the match; Retry wave (from prep 3) and Restart make zero
  requests; the record (chunks mode, 109 blocks, 4 attempts: waves 1–2 and
  wave 3's prep twice) and the map bundle verify with the native
  `sim-headless verify --chunks map.json --shell map.json`, every attempt
  hash and the final hash equal to the browser's (identical in the three
  browsers: snapshot `8bfb826a2d0cdf55`); ← Map aborts the loader; after a
  reload the same place gets to prep with zero requests (109 IndexedDB
  hits). Wave 3 is not played: its prep hash is already checked by the
  verifier.
  Run times (M1 Pro, the stream file alone on three workers, with other
  work on the machine): 1.4 min in Chromium and WebKit, 4.5–4.8 min in
  Firefox. Before this fix (two tests, waves 1–3 played): 3.8 + 0.7 min in
  Chromium, 3.9 + 0.7 min in WebKit, over 7.6 + 4.3 min in Firefox. In
  the whole suite (60 tests, 7.4 min) it takes 1.8, 1.3 and 5.0 min. The
  budgets (12 min a wave, 30 min the test) are wide because a wave's cost
  on the 1.3 km grid is minutes in Firefox under contention.
- **Manual check, a dense picked place** (central Paris, 48.8604 N 2.3470 E,
  live Overpass, Chromium in the desktop preview, M1 Pro, test speed "as
  fast as possible"). The 1.3 km shell has 110 blocks (6, 6, 10, 11, 15,
  20, 22, 20 per wave) and a 1357² grid. **Loading** depended entirely on
  the public Overpass servers, which were overloaded that evening: the
  first load (12 blocks, 2 queries) took 267 s, because overpass-api.de
  answered one batch 502 at once and the fallback instance held it for
  267 s (the other batch took 48 s; a single block by curl took 31 s). The
  background then fetched 12 more blocks, and later queries timed out
  (hence the request limit above, 120 s then, 90 s now). A second visit from the cache reached
  prep in 0.6 s with no request. **Sim cost** (wall ms per tick over the
  wave, and the worst sim p95 seen): wave 1 993 ticks, 2.8 ms, p95 3.8 ms,
  1.3k agents; wave 2 6,768 ticks, 3.3 ms, p95 4.8 ms, 5.2k agents; wave 3
  ~7,000 ticks, 4.2–4.6 ms, p95 5.6–11.5 ms, 7.1k agents; wave 4
  6,200–7,800 ticks, 5.5–5.7 ms, p95 8.1–8.5 ms, 7.9k agents. That is
  well inside the 50 ms of a 20 Hz tick at 1×, with headroom for waves 5–8.
  The number of buildings applied grew 540 → 884 → 1,638 → 2,428 over
  waves 1–4.

## Run records (T4)

- **`RunRecord`** (`sim-core/src/record.rs`, serde JSON, `format: 1`;
  every record struct, `LoggedAction` and `WaveAttempt` included, is
  `deny_unknown_fields`, so an extra key anywhere is refused at parse
  time and adding a field is a format change. `Action`, `Target` and the
  shell's `LevelPack` still ignore unknown keys: the browser sends actions
  and level files carry extra keys; neither is compared through them):
  - `sim {rules, crate_version, git}`: `rules` is `SIM_RULES_VERSION` (1),
    the only part a verifier compares; the crate version and the git commit
    of the build (`build.rs` runs `git rev-parse --short=12 HEAD`, no
    network; `ZT_GIT_HASH` overrides it, absent without git) are
    informational, so a rebuild or a docs commit doesn't invalidate runs.
    **Bump `SIM_RULES_VERSION` with any change that changes a hash** and
    regenerate the golden record.
  - `config_hash` (`Config::content_hash`: FNV-1a of the config
    re-serialised as compact JSON, so key order and formatting of the file
    don't count) and `cards_hash` (`CardDb::content_hash`).
  - `map {source: level|chunks, snapshot_hash, blocks, shell}`: the level
    without its buildings (centre lat/lon, radius or bounds, fences) and the
    snapshot of the buildings (below). The record's shell is only compared:
    a replay always builds on the verifier's own shell (the level's, or the
    one given with the chunks).
  - `setup {seed, population_multiplier, deck}`: the seed is a decimal
    string and every hash 16 hex digits, since JS numbers stop at 2^53.
  - `actions`: `Match::log()`, every accepted action with its match tick,
    retries, restarts, mulligans and keep choices included.
  - `attempts`: every wave attempt that ended, `{wave, result:
    won|lost|abandoned, start_tick, end_tick, prep_hash, end_hash}`. The
    match keeps them outside the retry state (`Match::attempts`; a retry
    drops the attempt's `WaveResult` but not this), so a lost attempt
    before a retry is verified too. A `RetryWave` / `RestartMatch` during
    prep or a running wave ends that attempt as `abandoned` with the hash
    just before the restore (one `state_hash`, ~24 ms at wave-8 size); one
    from a result screen adds nothing (the win or loss is recorded).
  - `end {tick, phase, wave, abandoned, hash, prep_hash,
    attempt_start_tick, waves_won, retries, restarts, waves: [{wave, won,
    start_civilians, end_civilians, saved}]}`: where the record stops, the
    state hash there and the outcome summary.
- **`RunRecord::from_match(&Match)`** takes no map argument: the match
  holds its chunks (`Match::chunks`) and knows whether it was built from a
  whole level (`Match::is_whole_level`), so it computes the snapshot itself.
- **Map snapshot.** Streamed matches: `mapsnap::snapshot_hash` (the JS
  `snapshotHash`, moved from `t6_chunks.rs`, which still checks it against
  the JS fixture) of **every chunk the match holds** at export, applied or
  not, with their ids in `blocks`. A chunk refused with `AreaRevealed` was
  never stored and is not in it. Stored but unapplied chunks don't change
  the sim, but including them keeps the rule "exactly what the match was
  given" (a replay gets them all up front, which the arrival-order tests
  of T2 show is equivalent). **Whole levels** (`Match::new`): the snapshot
  is `snapshot_hash` of one chunk with block id 0, bounds `[0, 0, 0, 0]`
  and every building of the level (`mapsnap::level_snapshot_hash`; the
  match's own block 0 has unbounded bounds, which have no centimetre form).
  The shell (radius, bounds, centre, fences) is compared bit for bit with
  the verifier's, for levels and chunks alike (T4 review: a chunks replay
  used to build on the record's own shell, unchecked, so a forged radius,
  centre or free fence ring verified against genuine chunks).
  Both hashes round to centimetres, so a building moved by 1 cm is refused
  as a map mismatch; a sub-centimetre change that alters the game still
  fails at the first wave hash. Because of that rounding **the server must
  replay only on map chunks it fetched itself** (from its own map source,
  keyed by the block ids of the record), never on chunks a client
  uploaded: two chunk sets that differ below a centimetre have the same
  snapshot hash, so a client-supplied set could carry a sub-centimetre
  edit that the snapshot doesn't see, and a server that stored it would
  then replay (and accept) a run played on that edited map.
- **`replay(record, ReplayMap::Level(&level) | ReplayMap::Chunks { shell:
  &shell, chunks: &chunks }) -> Result<ReplaySummary, VerifyError>`** uses
  the embedded config and cards, the default limits and no expectation;
  `replay_with(record, map, expected: Option<&ExpectedRun>, cfg, cards,
  &limits, &mut progress)` takes others. For chunks, the record's blocks
  are picked out of the chunks given (any order, extras ignored, a missing
  one is `missing_block`). The match is rebuilt from the setup and the
  verifier's map, each action is applied on its tick with plain `step()`s
  in between, and the replay stops at `end.tick`, never later. Checks, in
  order:
  1. no simulation: `format`, `sim_version`, the limits, action sizes, tick
     order (`out_of_order`), ticks past the end (`future_tick`), the end
     marker, `config_hash`, `cards_hash`, the record shell's bounds
     (`bad_shell`, below), then the expected setup (`unexpected {what:
     seed|deck|population_multiplier, record, expected}`);
  2. the map: `map_source`, `map_shell` (the verifier's shell against the
     record's, in both modes), `missing_block`, `map_hash`, then `setup`
     (the match can't be built: illegal deck, multiplier out of range,
     shell over its bounds, chunks...);
  3. replaying: `illegal_action {index, tick, action, reason: ActionError}`
     (card not in hand, wrong phase, not enough supply, bad target: the
     same checks as play), `too_long` (a wave or a prep over its limit),
     and `diverged {attempt, wave, tick, what, record, replay}` as soon as
     an attempt differs. Each attempt's wave, start tick and prep hash are
     checked when its prep opens, its end tick, result and end hash when it
     ends, and a recorded attempt still running past its end tick diverges
     right away. `attempt` indexes `attempts` (`attempts.len()` is the
     attempt open at the end);
  4. the end: phase, wave, the open attempt's `start_tick` and `prep_hash`
     (`end.attempt_start_tick`, `end.prep_hash`: checked here in every
     phase, since a record that ends on a result screen never reopened a
     prep; T4 review), `final_hash` (all as `diverged`), then the summary
     (`outcome`). `cancelled` if the callback stopped it.

  So an edited seed, deck or multiplier diverges at attempt 0's prep hash
  (tick 0), before any action; a changed play diverges at the attempt it
  was played in. The `ReplaySummary` echoes what was verified: `setup`
  (seed, multiplier, deck), `map_source`, `snapshot_hash` and `shell_hash`
  (`mapsnap::shell_hash`: FNV-1a 64 of the shell's bit patterns, centre,
  radius, bounds and fences; name and buildings excluded, so equal hashes
  mean "the verifier takes one shell for the other"), then the outcome
  and every attempt hash.
- **What the server must check** (the replay proves only that the record
  is a genuine run of *its own* setup on the map given):
  - **Seed:** the server issues it when the match starts and passes it as
    `ExpectedRun.seed`. Without that, a player can play many seeds offline
    and upload the best genuine record.
  - **Issued runs are single-use and bound to an account:** the server
    keys each issued `ExpectedRun` by a run id bound to the account it
    was issued to, and a submission names that run id (a record
    submitted by another account, or for an unknown id, is refused
    without a replay). The first submission for a run id marks it
    consumed, whether the replay accepts or rejects it; any later one is
    refused. A run that is issued but never submitted counts as
    abandoned (as a lost run would, for streaks and rewards). Together
    this ends seed rerolling at the run level: asking for new runs until
    a good seed comes up costs an abandoned run each time, and a record
    can't be replayed against a second issue of the same seed.
  - **Deck:** the server checks the player owns every card of the deck
    when issuing the run and passes it as `ExpectedRun.deck` (setup order).
    `Match::new` only checks the deck rules (`CardDb::validate_deck`), not
    ownership.
  - **Difficulty:** the server maps the chosen tier to the exact
    multiplier (`match.population_multiplier` × the tier's
    `population_multiplier` from the `difficulty` table, as an `f32`) and
    passes it as `ExpectedRun.population_multiplier` (compared bit for
    bit). The sim itself only refuses multipliers that are not finite or
    outside `population_multiplier_range` = [0.25, 4] × the config's base
    ([0.075, 1.2] by default; `POPULATION_SCALE_MIN/MAX` in `match_.rs`,
    `MatchError::InvalidSetup`): the tiers span 1.0–2.0, the rest is room
    for tuning. sim-core doesn't read the `difficulty` table (it isn't in
    the config hash, see below), so the range can't be derived from it.
  - **Map:** the level file, or for streamed runs the shell and the chunks
    from the server's own map source (never the client's, see "Map
    snapshot" above), the shell for the record's centre as the server
    computes it.
  - **Rewards:** paid from the `ReplaySummary`, never from the record's
    own `end`.
  `ExpectedRun` fields left `None` are not checked (`replay` passes no
  expectation at all: tests and tools); a server passes all three.
  `ReplaySummary.setup_checked` is `true` only when the seed, the deck
  **and** the multiplier were all checked (T8 fix: it used to be `true`
  for an expectation with at least one field, so a server bug that
  dropped the seed would still read as checked), and
  `ReplaySummary.checked {seed, deck, population_multiplier}` says which
  fields were; a server refuses to pay out on `false`. The CLI and
  `tools/verify-run.mjs` name the fields not checked in their verdict
  line ("(deck, multiplier not checked against an issued run: --expect-*)"). In WASM (`verify_level` / `verify_chunks`) only
  `undefined` means "no expectation": `""`, `"null"` and `{}` are refused
  as `bad_expected`, so a caller's bug can't switch every check off. The
  CLI (`sim-headless verify`) and `tools/verify-run.mjs` refuse an
  unknown flag, a flag given twice or a stray argument (exit 2), so a
  typo'd `--expect-*` can't be skipped silently. **One number grammar in
  both (T8):** a seed (and `--max-ticks`) is `^\d+$` up to 2^64 - 1, a
  multiplier a plain decimal `^\d+(\.\d+)?$`; a sign, spaces, `0x`, an
  exponent, `inf` or `nan` is a usage error (exit 2) naming the flag,
  before any file is read. Before, Rust's `parse` took `+3` and `inf`
  and JS's `Number` took `0x1`, ` 3 ` and `1e3`. `parse_integer` /
  `parse_decimal` (sim-headless `verify.rs`) have unit tests, and the CLI
  test runs the same refused and accepted values through both tools.
- **Shell bounds** (`ShellLimits::for_config`, checked by
  `Match::new_streaming` itself as `MatchError::BadShell` before the grid
  is allocated, and by the verifier on the record's shell as `bad_shell`
  before the map): centre a finite latitude / longitude; radius finite
  and positive (the match cuts it to the last ring, so its size costs
  nothing); bounds finite, ordered, every coordinate within `max_extent_m`
  = 2 × `wave8_radius_m` (2.6 km) of the origin and at most that wide and
  high, so the grid is never larger than about the wave-8 disc's; at most
  256 fences of 1,024 points, every point finite and within the extent,
  and at most 16 wave-8 circumferences of fence in total (~131 km, which
  rasterises in a few ms). Before this, a shell with ±8 km bounds took
  3.7 s to build (growing with the square), and fences had no cap (tested:
  ±8 km bounds, far bounds, a 100k-point fence, 10k fences, a 3,800 km
  fence set and a NaN radius are all refused in well under 500 ms).
- **A record that ends before the match is won must say `abandoned:
  true`**, else `unfinished` (checked before any tick; `abandoned` on a won
  match is `bad_record`). `from_match` sets it from the phase, so the
  marker means "the client exported this as a left match", and a truncated
  or hand-cut upload is refused rather than read as a run in progress.
  Abandoned records still verify (the server can pay per wave won).
- **DoS bounds** (`ReplayLimits::for_config`, verifier policy, not in the
  config hash): 20,000 actions, 256 attempts (and as many retries plus
  restarts), `end.tick` at most 4 h of game time (288,000 ticks at 20 Hz),
  one wave at most 30 min (36,000 ticks), one prep at most 30 min, 1,024
  points per polyline target, 64 entries per building list or keep list,
  64 waves in the summary. Everything but the per-phase lengths is checked
  before the first tick (tested: a 1M-action log, a 10^12-tick end, a
  100k-point polyline and 300 restarts are refused in well under 500 ms in
  total); a wave that never ends or a prep that lasts forever stops at its
  limit. The JSON itself must be size-capped by the server before parsing.
  Worst case at the bounds: 288,000 ticks at ~17 ms (wave-8 size) is
  ~80 min of CPU, so the server should still queue and time out replays;
  `--max-ticks` (CLI) or `ReplayLimits` tighten it.
- **Progress / cancel:** `replay_with`'s callback gets `{tick, end_tick,
  wave, attempts}` every 256 ticks and returns `false` to stop
  (`cancelled {tick}`); `sim-headless verify` uses it for progress lines.
- **Prep ticks are replayed** like any tick (`Match::step` in prep moves
  the cosmetic wander, which `state_hash` covers until Start resets it), so
  time a player idles in prep costs the verifier as much as wave time. T5
  can pause the sim in prep without breaking anything (pause and speed
  never reach the sim).
- **JSON floats round-trip exactly:** serde_json writes the shortest
  string that reads back to the same f32 (checked on 20M random values and
  on every record of the tests), so polyline and point targets replay bit
  for bit from the JSON.
- **CLI:** `sim-headless verify <run.json> (--level <name or level.json> |
  --chunks <chunks.json> --shell <shell.json or level>) [--expect-seed N]
  [--expect-deck id,id,... | --expect-deck deck.json] [--expect-multiplier
  K]` (exit 0 verified, 1 rejected, 2 usage or I/O; an `--expect-*` value
  that doesn't parse is a usage error, never skipped; `--shell` drops the
  buildings of a level given as the shell) and `sim-headless match ...
  --record out.json` (refused with `--fast-forward-to`, which removes
  zombies outside the log). Node: `tools/verify-run.mjs` with the
  `pkg-node` WASM build, same flags.
- **WASM** (`sim-wasm`, marshalling only): `WasmMatch` (`new(level_json,
  setup_json)`, `new_streaming(shell_json, setup_json, chunks_json)`,
  `add_buildings`, `ring_ready`, `apply(action_json)` throwing the
  `ActionError` JSON with a `message`, `step(ticks)`, render buffers like
  `WasmSim`, `status_json`, `hand_json`, `results_json`, `attempts_json`,
  `structures_json`, `repair_cost`, `pull_down_refund`, `structure_at`,
  `fence_length_m`, `building_at`, geometry, `state_hash`, `prep_hash`,
  `record()`), and `verify_level(record_json, level_json, expected_json?)`
  / `verify_chunks(record_json, shell_json, chunks_json, expected_json?)`
  returning the summary JSON or throwing the `VerifyError` JSON
  (`bad_expected` for an `expected_json` that doesn't parse;
  `expected_json` is the `ExpectedRun` JSON, `{"seed"?: "123" | 123,
  "deck"?: [ids], "population_multiplier"?: number}`, unknown keys
  refused; omitted, `null` or `""` checks nothing). The setup JSON takes the seed as a
  string or a number; config and cards are the embedded ones.
- **`Match::building_at(x, y)`** looks at the clicked cell only: `None`
  off the grid, on a cell with no building or for a building with
  `cell_count == 0`. `Sim::building_at`'s polygon fallback names a
  half-applied building on its open part (T2 review), so `WasmMatch` uses
  the match's (tested on the half-applied building of the T2 test).
- **Tests** (`crates/sim-core/tests/t4_records.rs`): a scripted 8-wave
  Marais match (seed 1, a test bot with no trig) with prep idling, a
  restart, a lost attempt, a retry, an attempt abandoned mid-wave, a
  mulligan, a same-prep pull-down, an older pull-down, a repair, a retry
  after a win and tactical cards mid-wave (90 actions, 12 attempts, 17,577
  ticks) replays 3 times with equal hashes, also after a JSON round trip.
  Tampering: a changed play, a changed tick, reordered actions, a card not
  in hand, wrong phases, not enough supply, an edited wave hash, a dropped
  attempt, an edited final hash or summary, seed, deck, multiplier,
  format, rules version, config, cards, a level building moved 1 cm, the
  level radius, a chunk building moved 1 cm, a missing block and the wrong
  map kind, each with its error and the right attempt. T4 review fixes: a
  forged chunks shell (radius, centre, a 64-point fence ring, bounds) in
  the record or from the verifier is `map_shell`; oversized shells are
  refused quickly (above); a seed, deck or multiplier other than the
  issued one is `unexpected` before any tick; multipliers out of range
  (0, negative, NaN, infinite, 0.05) are refused by `Match::new` and by a
  replay; `end.prep_hash` and `end.attempt_start_tick` edited on a record
  that ends on a result screen (and in prep) diverge; an extra key in any
  record struct is refused at parse time. The WASM tests cover
  `verify_chunks` with the shell, a forged shell and `expected_json`; the
  CLI test covers `--expect-*` and `--chunks --shell`. Streamed: the same
  match on the T6a `map_chunks.json` blocks given up front or staged
  (waves 1–2 reversed, the rest shuffled during wave 1's prep) records
  byte-identical JSON and verifies with the chunks reversed. WASM under
  Node verifies the golden record with every attempt hash equal and
  drives `WasmMatch` through its first three attempts. A CLI test records
  a match, verifies it and rejects a tampered copy.
- **Replay cost** (native M1 Pro, single thread; the server replays every
  claimed run). A replay costs what playing costs: the same ticks, plus a
  state hash per prep and per attempt end.

  | run | ticks | agents at the end | native | WASM (Node) |
  |---|---|---|---|---|
  | Marais, 8 waves won, `sim-headless match --seed 1` (no retry) | 9,120 | 6,257 | 3.9 s | 5.2 s |
  | Marais golden record (8 waves, 4 retries, 1 restart, 12 attempts) | 17,577 | ~6,300 | 9.0 s | 11.9 s |
  | Wave-8 size: 1.3 km tiled Marais, 150 s of one wave | 3,000 | 88,991 | 51.7 s (17.2 ms/tick) | — |

  The last row is a proxy, since the scripted defence can't win waves 3–8
  at 1.3 km (T3): a config whose first ring is already 1,265 m with wave
  8's outbreak (10 clusters, 14 m, min 12) and multiplier 0.5, played by
  `sim-headless match --level marais-tiled:1300 --max-wave-s 150 --record`
  and verified with the same `ZT_CONFIG` (peak RSS 217 MB; playing it took
  53 s). Its 17.2 ms/tick matches T2's live wave-8 p50 (17.1 ms). A full
  1.3 km match whose waves each run ~2.5 min would replay in roughly
  2–4 min native (smaller early waves are cheaper), so the server needs
  about one core-minute or more per claimed full-size run.
- **Golden record** `crates/sim-core/tests/fixtures/run_record_golden.json`
  (the scripted match; config `ceabf38252a0c4ba`, cards `3e157f5ac2531906`,
  map `e9b1fbac85820411`, final hash `b6f30157787dde36`). Its hashes are
  **pinned per rules version** in `GOLDEN_HASHES` (`t4_records.rs`:
  `(rules, final, config, cards, map)`, one entry per version, never
  edited). The test fails when the fixture differs from the entry of the
  current `SIM_RULES_VERSION` (a regeneration without a bump), when there
  is no entry, when the fixture no longer replays ("sim rules changed:
  bump SIM_RULES_VERSION …, regenerate … and add the GOLDEN_HASHES entry
  it prints") and when the script no longer records it byte for byte.
  `ZT_REGEN_GOLDEN=1 cargo test --release -p sim-core --test t4_records
  golden` refuses to write hashes that differ from the current version's
  entry (so the only way through is a bump); with equal hashes (a record
  format change only) it rewrites the file, and for a version with no
  entry it writes the file and prints the entry to add. Any balance change in
  `config.default.json` or `cards.json` changes the config or cards hash
  and needs the same bump (that is the point: a run replays only on the
  rules it was played with). No other fixture changed (`0ea142296a5795a9`,
  `b0b7f9703b3cc1c0`, the fence-break hash).
- **The config hash covers what the sim reads, not the file.** It hashes
  `Config` re-serialised, so keys sim-core doesn't parse (T7a's
  `difficulty` section, read only by the web profile) don't change it: the
  golden record held through the T7a merge. Difficulty reaches the sim
  through the record's setup (`population_multiplier`); when T7 makes
  `outbreak_scale` or `fatigue_scale` sim inputs they must become setup or
  `Config` fields (and the rules version is bumped), or a record could
  replay on other difficulty numbers.
- **Versions after the T4 review fixes:** `SIM_RULES_VERSION` stays 1 and
  `RECORD_FORMAT` stays 1. No hash changed (the golden record and every
  fixture are byte-identical; the new multiplier range and shell bounds
  accept every record the sim could produce with the default config). The
  record JSON shape is unchanged: the new fields are in the
  `ReplaySummary` (verifier output), not the record, and
  `deny_unknown_fields` only refuses keys no writer ever produced. The
  API changes (`ReplayMap::Chunks { shell, chunks }`, `replay_with`'s
  `expected`, `verify_chunks`' shell argument) are source-level only.

## Profile (T7a)

The local meta layer lives in `web/src/profile/` (library only: the deck
builder, collection, crate and coverage screens and the match wiring are
T7b, "Profile UI (T7b)" below).

- **`ProfileService` is the boundary to the future server.** Every method
  is async and takes and returns plain JSON (no Date, Map, bigint or class),
  so an HTTP/RPC client can implement the same interface. Errors are
  `ProfileError { code, message }` (`toJSON` gives the wire form); deck
  problems are data (`{ ok: false, errors }`), not exceptions.
  `LocalProfileService` is the v1 implementation. The server will re-run
  the run record before `claimMatch` pays, own the daily counters (its own
  clock, not the client's) and the crate RNG.
- **Storage: one IndexedDB database `zt-profile`, three stores**: `state`
  (one `ProfileState` document: collection, decks, tickets, crates, claimed
  match ids, tiers, daily counters, achievements, RNG state), `matches`
  (summary + run record by match id) and `coverage` (cells by id). The two
  that grow are separate so the state document stays small. Unlike the
  block cache this is the player's data: nothing is ever dropped. The
  IndexedDB version only describes the stores (upgrades only add stores);
  the data format is `ProfileState.schema` (1), migrated forward in JS on
  open (`migrateBundle`, one function per step over the whole bundle). A
  profile written by newer code (data schema or store layout) is refused
  with `schema_too_new`, never wiped and never replaced by an empty memory
  profile. `openProfileBackend` falls back to memory only when the browser
  has no usable IndexedDB (missing, or the open fails with `SecurityError`,
  `InvalidStateError`, `NotSupportedError` or `NotAllowedError`: private
  mode, storage denied); `service.persistent` tells the UI to warn. An open
  blocked by another tab is reported (`storage`), and any other open error
  is retried twice (50 ms, 100 ms) and then reported (`storage`): an empty
  memory profile must never hide the real one. The UI can offer
  `memoryProfile()` explicitly.
- **Every write is one transaction with a revision check.** The service
  reads the state, applies the change to a copy and commits state, matches
  and cells in one readwrite transaction that first checks the stored
  `revision`. If another tab wrote in between, the commit aborts with
  `conflict` and the operation reruns on fresh data (up to 8 times). So
  two tabs claiming the same match pay once (tested on fake-indexeddb and
  with a counting backend). Operations in one tab are also queued.
- **Card instances**: `<profile id prefix>-<kind><seq>` ids from a counter
  in the state (no randomness, stable in tests). The provenance stamp holds
  district, city, wave, tier, population saved, MVP card and the **local
  day** (`YYYY-MM-DD`, no time of day). The match id is kept on the crate
  record, not on the stamp, so a traded card doesn't carry a link to the
  match (and its centre). Starter cards: `source: "starter"`, `stamp:
  null`, `accountBound: true`, `tradeable: false`, `salvageable: false`,
  granted with the deck "Civil Defence Issue" when the profile is created
  (one commit that requires no existing profile, so it can't happen twice).
- **Place input contract: the privacy guarantee.** `MatchSummary.city` and
  `.district` (and `DailyEvent.city` / `.district`) come **only** from the
  place search's administrative fields, never from `road`,
  `house_number`, `postcode`, `display_name` or free text. The helper is
  `placeFromGeocoder(address, cityResult?)` (`web/src/profile/place.ts`):
  it reads a Nominatim-style `address` object, city = the first of `city`,
  `town`, `village`, `municipality` that sanitises to a name; district = the
  first of `suburb`, `city_district`, `borough`, `quarter`, `neighbourhood`
  that sanitises to a name other than the city ("" if none). Other keys
  are never read. Another geocoder maps its own admin levels to the same
  two fields. A blacklist sanitiser can never be complete and also hits
  real towns ("Piazza Armerina", "Road Town"), so the guarantee is this
  contract; `sanitizePlace` is defence in depth behind it. Tested on
  Nominatim-shaped addresses for Paris, Barcelona, Tokyo, Seoul, Istanbul,
  Moscow, Shanghai, Jakarta, London and New York: no output holds the
  road, house number or postcode.
- **`cityId` is an admin relation or nothing**: only
  `osm:relation:<1–12 digits>` is accepted (`isCityId`), in `claimMatch`,
  `cityProgress` and `cityKeyOf`. Any other value (a node or way id, an
  address pasted in by mistake) is ignored, not stored in the match
  history, and the city is keyed on its sanitised name. `placeFromGeocoder`
  sets `cityId` only from a city-level result with `osm_type ===
  "relation"` and an `addresstype` of city, town, village or
  municipality. Fail-closed: a result without `addresstype` (Photon, older
  Nominatim `format=json`) gives no `cityId`, since a building
  multipolygon relation would pin the player's address.
- **Stamp sanitiser** (`sanitizePlace(raw, field)`): defence in depth, not
  a complete street detector. Two modes. `"district"` (default) is strict:
  a street-looking segment is dropped, privacy before a pretty name.
  `"city"` is lenient, because the city field is an admin name and many
  towns start with a street word ("Strada in Chianti", "Plaza Huincul",
  "Crescent City", "Neustadt an der Weinstraße"): numbers and postcodes
  still go, a segment with a street abbreviation or a hyphenated street
  suffix ("Main St", "ul. Długa", "Teheran-ro") still goes, and a
  street-looking segment is skipped only when another segment is left
  ("Rue de Rivoli, Paris" → "Paris"; "Piazza Armerina" stays). In the
  city mode `Ave` starts a street only with a dot ("Ave. Foch" goes, the
  town "Ave Maria" stays). The city
  mode keeps a parenthesised qualifier, so the city key tells "Halle
  (Saale)" from "Halle (Westf.)". A numbered district that is the whole
  field, `<one word> <1–2 digits>`, keeps its name ("Praha 1" → "Praha",
  "Wien 3" → "Wien"); in a longer address the segment still goes ("Unter
  den Linden 77, Berlin" → "Berlin"). A segment starting or ending with an
  admin word (`Kreis`, `County`, `Mahallesi`, `Okrug`, ...) or in a short
  list of admin names with a street suffix ("Landstraße", Vienna's 3rd
  district) is never a street. Postcode patterns are removed (UK, Canada, NL, PL, PT,
  SE/CZ, US ZIP+4, any 3+ digit run); a segment (split on `, ; / | ( )`
  and ` - `) is dropped whole when it holds a house number or looks like a
  street (street words in a dozen languages next to a name, glued suffixes
  such as `-straße`, `-straat`, `-gatan`, abbreviations such as `St`, `Bd`,
  `ul.`); the first segment left is kept, minus every token with a digit.
  Also covered: Catalan (`carrer`, `passeig`, `avinguda`, `plaça`,
  `rambla`, `travessera`), dotted Italian and Spanish abbreviations (`V.le`,
  `P.za`, `C.so`, `Pº`/`P.º`, `Ctra.`), French `Imp.`, `Fbg`, `Rte`,
  Japanese `-dōri`, Korean `-ro`, `-gil`, `-daero` (only hyphenated: "San
  Gil" stays) and Chinese `Lu`, `Jie` as the last word ("Nanjing Lu";
  "Lu County" and "Lu-kang" stay). Review 2 added, where they don't hit a
  real name: Russian `ул`, `пр`, `наб`, `пер`, `ш` (with or without a dot,
  first or last), `улица`, `проспект`, `ulitsa`, `prospekt`; Turkish
  `Cd.`, `Cad.`, `Sk.`, `Blv.`, `Bulvarı` (dotless ı is folded), `Caddesi`,
  `Sokak`; Hungarian `út`, `u.`, `utca`; `Jalan`, `Jln`, `Jl.`, `Soi`,
  `Thanon`, `Đường`, `Phố`; `Marg`, `Path` (last word only), `Rehov`,
  `Sderot` (first word only: Sderot is a city); `-kaidō`, `-suji`;
  `Str.` last; `Pso.`, `Pg.`, `Rbla.`, `Avgda.`, `Ptge.`, `Calz.`,
  `Calzada`, `Jr.`, `Jirón`, `Diag.`, `Tv.`, `Lgo.`, `Pç.`, `Calçada`,
  `Ladeira`, `Sq.`, `All.`, `Ch.`, `Fg`; `Fondamenta`, `Salizada`; glued
  `-damm`, `-ufer`, `-dajie`, `-hutong`, `-suji`. **Skipped on purpose**:
  glued `-lu` (Honolulu), glued `-kaido` (Hokkaido), the word `Faubourg`
  (official Paris quartiers "Faubourg-Montmartre", "Faubourg-du-Roule";
  `Fbg`/`Fg` stay), `mahallesi` (it means neighbourhood: "Caferağa
  Mahallesi" is a district), and glued Finnish `-tie` without the genitive
  `n` (`-ntie` is kept: "Mannerheimintie" goes, "Carnoustie" stays).
  A lone street abbreviation ("Rd") names nothing and is skipped. District suffixes (`-gu`, `-ku`, `-dong`) are not street
  markers ("Gangnam-gu" stays). The tests check a hand-written list of real
  street names with their expected output, and a list of districts that
  must stay ("Roppongi", "Le Marais", "Gràcia", "Montmartre", ...), on
  top of the fuzz test. **A stamp never shows a digit**: ordinals go too,
  and when one goes the division word next to it goes with it ("Paris 4e
  Arrondissement" → "Paris", "1st Arrondissement" → "", so the stamp falls
  back to the city), rather than a mangled "Paris Arrondissement".
  Vietnamese `Quận`, `Phường`, `Huyện` are division words too ("Quận 1"
  → "", the stamp falls back to the city).
  A street word alone is a town ("Rue", "Largo"), and "St" counts only in
  last position ("St Albans" stays). Accepted false positives: areas named
  after a street ("Earls Court", "Jalan Besar") fall back to the city in
  the district field. Limit: a bare street name with no marker and no
  number ("Strøget"), or a street word in the lenient city field, is not
  caught; the input contract keeps those out. Match history stores the
  sanitised names too, so no screen can show a street. Lore writes the wave
  as a word ("the eighth wave"), so a lore line has no digit at all; a test
  checks every template is free of street words.
- **Decks**: named lists of instance ids. Ownership is checked by the
  profile (`not_owned`, `duplicate_instance`), then the core's rules run on
  the card ids of the owned, distinct instances. The validator is injected
  (`validateDeck: (cardIds) => DeckError[]`, sim-core's `validate_deck`
  through WASM in T5); the default is `mirrorValidateDeck`, a TS mirror of
  `CardDb::validate_deck` with the same error shape
  (`{ error: "wrong_size", ... }`, sim-core's serde tag), the same order and
  the same messages (`deckErrorMessage`). `profile_deck.test.ts` replays the
  cases of `t3_cards.rs`.
- **Payout** (`computePayout`, numbers in `rewards.json` → `payout`):
  `furthest_wave_tickets[furthestWave − 1]` + `cleared_tickets` if wave 8 was
  won + `min(max_civilian_tickets, floor(max(savedPerWave) /
  civilians_per_ticket))` + `no_retry_bonus_tickets` if cleared with 0
  retries. Defaults: 0,1,1,2,2,3,3,4 by wave, +2 cleared, 1 per 4000
  civilians up to 4, +2 no retry: 12 tickets for a perfect clear, 4 for
  quitting in wave 4 with 8000 alive, 0 for quitting in wave 1 (no farming
  by starting and quitting). Civilians use the max over waves, not the sum:
  survivors carry over, a sum would count them up to 8 times. The tier
  doesn't change the ticket count: harder tiers pay better crates, not more
  of them. Idempotent on `matchId`: a second claim (even with other
  numbers) pays nothing and returns the first payout with `paid: false`.
- **Tickets carry their provenance** (match, sanitised district and city,
  tier, wave, population saved, MVP, local day), so the crate a ticket opens
  can name where it was recovered and stamp its cards, whenever it is
  opened.
- **Daily caps** (`rewards.json` → `daily`): first blood 1/day (1 ticket),
  wave victory 5/day (1 ticket), match victory 5/day (2 tickets, counted by
  `claimMatch` for a cleared match). The day is the **local day** from an
  injectable clock (`now()` and `utcOffsetMinutes()`), and it **never goes
  backwards**: the effective day is the later of today's local date and the
  stored day. Flying west after midnight (or setting the clock back) can't
  reopen a day whose caps are used; flying east starts the next day early,
  once. The stored day is held only while it is plausible: at most one day
  ahead of today's local day (or no later than today at UTC+14, for the
  date line). Further ahead, the clock was wrong when it was stored (set a
  year ahead, then corrected) and today is used, so the caps don't freeze
  for a year; the cost is one extra set of caps per such clock change, which
  the server (its own clock) removes. `recordDailyEvent` checks its event
  like `claimMatch` does: a known tier that is unlocked (`tier_locked`
  otherwise), an integer wave 1–8, a non-empty match id and a finite
  population ≥ 0 (`bad_summary` otherwise). Each event has a key (`wave_victory:<match>:<wave>`,
  `match_victory:<match>`, `first_blood:<day>`) kept for all time, so a
  retried or restarted wave never counts twice, even the next day.
- **Crates**: one ticket opens one crate of `cards_per_crate` (3) cards;
  the Hometown crate has `hometown_cards` (5), needs a cleared match in the
  history and is granted once per profile (the UI decides which match is
  the player's own address). Each card: rarity from the tier's odds
  (`rewards.json` → `crates.odds`, cumulative against one 24-bit float),
  then a card of that rarity uniformly in `cards.json` order, then foil
  against a second float. A ticket that can't open a crate (unknown tier or
  source, from a corrupt profile) is skipped by `openCrate()` and refused
  with `bad_ticket` by `openCrate(id)`; `rollCrate` and `crateLore` throw
  `bad_ticket` on it before the RNG moves. Lore: a template of the crate's source picked
  with the same RNG. The RNG is a **PCG32 port of sim-core's** (same
  seeding, same `below`, checked against the reference stream), stream
  `CRATE_STREAM`, seeded once per profile from `crypto.getRandomValues`
  (injectable), its state saved in the profile after each crate. It never
  sees the match seed: crates are not part of replays. Harder tiers: fewer
  commons, more rares, legendaries and foils (a test checks the table is
  monotonic and frequencies over 40 000 rolls are within 5 σ).
- **Difficulty tiers**: Recruit, Veteran, Elite, Nightmare. A tier unlocks
  when a match is cleared on the tier below (stored as the highest cleared
  tier index); claiming a match on a locked tier is refused. The
  multipliers are in `config.default.json` → `difficulty.<tier>`:
  `population_multiplier` (a factor on `match.population_multiplier`),
  `outbreak_scale` (number and size of outbreak clusters) and
  `fatigue_scale` (how much civilians slow down). The profile only reads
  them (`difficulty(tier)`); the sim consumes them later. sim-core's
  `Config` ignores the new key (no `deny_unknown_fields`).
- **Coverage grid = the map block grid** (`map/blocks.ts`, ~251 m cells),
  not a coarser one: a wave-8 disc (1300 m) is about 84 cells, Paris
  (105 km²) about 1700, so 75% of Paris takes about 15 non-overlapping
  matches, the 10–20 of GAMEPLAY.md. `defendedRadiusM` must be finite and at most
  `wave8_radius_m` × 1.5 (1950 m, `ProfileTables.maxDefendedRadiusM`, read
  from `config.default.json`), else `bad_summary`: the cells are
  enumerated from the radius. An unknown tier is a `bad_summary` too. A
  cell counts when its **centre** is
  inside the defended radius (not when it merely touches the disc), so
  the covered area matches the disc's on average (within 15%, tested). Only
  cleared matches add coverage. Each cell keeps its highest tier and its
  highest tier per city key (a cell on a border can count for two cities).
  `coverageInBox` reads the box's candidate cells (or scans all when the box
  spans more than 20 000 cells).
- **City cleared**: the area of the cells counted for the city at a tier or
  harder, over the city's area, ≥ `coverage.city_cleared_fraction` (0.75),
  one achievement per tier. The city key is the place search's `cityId`
  when it is an accepted `osm:relation:<digits>`, else the folded
  **sanitised** name ("Paris" = " PARIS " = "12 Rue de Rivoli, 75004 Paris";
  "Halle (Saale)" ≠ "Halle (Westf.)"): the key is stored in cells and
  achievement ids, so it goes through `sanitizePlace(city, "city")`
  like every other place name, in `claimMatch` and in `cityProgress`
  (which also returns the sanitised name). A city that sanitises to nothing,
  with no id, still adds coverage but tags no city. Homonyms in different countries merge until ids are
  passed. The area comes from an injected lookup (km², OSM admin boundary
  later); when it is unknown the **placeholder** `placeholder_city_area_km2`
  (100 km²) is used and the achievement is **provisional**. A provisional
  achievement becomes final when a later claim in that city has the real
  area and it still holds, and is dropped if the real area shows the city
  isn't cleared; final achievements are never taken away.
- **Privacy**: coverage cells and match centres stay in the local profile;
  nothing in `web/src/profile/` sends anything anywhere. The comments on
  `ProfileService.coverageInBox` and in `coverage.ts` say what a server
  would publish: aggregates only (the combined liberation map, per-city
  percentages over all players), never one player's cells or centres.
- **Match history**: `listMatches` (newest first, no run record) and
  `getMatch` (with the run record, opaque JSON until T4). `exportProfile` /
  `importProfile` dump and restore everything (state, matches, coverage, RNG
  state, claimed ids) for debugging; an older export is migrated, a newer
  one refused. The export reads the three stores in one transaction
  (`ProfileBackend.snapshot`). An import is validated in full after
  migration and before the commit (`validateBundle`: every state array,
  the counters, the RNG hex, the daily shape, deck `instanceIds` as
  strings, each cell's id, tiers and bounds, and each match in full:
  `checkSummary` with the same radius bound and card list as `claimMatch`,
  `cleared` a boolean, `claimedAt` an ISO date, `payout` five counts).
  Instance, deck, ticket, crate, match and cell ids must be unique, and
  the export's `schema` must equal `state.schema`. The place contract
  holds for imports too: a match `cityId` that fails `isCityId` is
  dropped, `summary.city` and `summary.district` are sanitised again
  (city and district mode), and every coverage city key must match
  `^(id:osm:relation:\d{1,12}|name:.+)$`. Anything malformed is
  `bad_import` and the current profile is left untouched (so a summary
  without `savedPerWave` can't be imported and crash
  `claimHometownCrate`). A valid export round-trips, fresh and after
  claims and crates, on memory and on IndexedDB (tested).
- **Import sanitises every place-bearing string, not only match
  summaries.** A hand-edited export can put an address anywhere, and card
  stamps are the provenance shown on tradeable cards. `validateBundle`
  also: sanitises again each instance stamp and each ticket (`district`
  in district mode, `city` in city mode; `mvpCard` must be `null` or a
  card); rebuilds each crate's lore (`rebuildLore`, crates.ts: the lore
  template the line reads as, with `{place}` made again from the sanitised
  stamps of the crate's cards, else from its match, keeping the wave word
  and tier name, which can only be fixed words), and refuses a line that
  reads as no template (other tables) when `looksLikeAddress` is true;
  sanitises each achievement `city` and refuses an achievement whose
  `cityKey` fails the key pattern, whose `name:` key isn't
  `cityKeyOf(city)`, or whose `id` isn't `city_cleared:<cityKey>:<tier>`
  (achievement ids must be unique too). A coverage `name:` key that isn't
  `cityKeyOf(sanitizePlace(<name>, "city"))` is **dropped** from its cell,
  not refused: the cell and its tier stay, only that key's progress goes
  (a cell's city entries are derived data; re-keying it to the sanitised
  name could credit another city). A key that fails the pattern is still
  refused. Sanitising is idempotent, so a valid export still round-trips
  byte for byte (tested, with a profile holding stamps, tickets, both
  crate kinds, an achievement and coverage, all hand-edited with "12 Rue
  de Rivoli, 75004 Paris"). Not place fields, left as they are: deck
  `name` (the player's own text), ids and dates, and the run record
  (opaque JSON until T4).
- **Summary field types**: `checkSummary` also requires `savedPerWave` to be
  finite integers ≥ 0 (no `Infinity`), `city` and `district` to be strings
  and `mvpCard` to be a card id of `cards.json` or `null`;
  `recordDailyEvent` requires string `city` and `district`.
- **Data tables**: `rewards.json` at the repo root (next to `cards.json`):
  payout, daily caps, crate odds, foil chance, lore templates, coverage
  threshold and placeholder area. `checkTables` validates them when a
  service is created (odds sum to 1, every tier present, lore not empty).

## Profile UI (T7b)

The profile library (T7a) wired into the page: `web/src/ui/profileui.ts`
(the map screen's match setup, the screens, coverage, the payout panel,
the test hook's `profile`), `web/src/ui/profilematch.ts` (match id, daily
events, the summary and the one claim per match),
`web/src/ui/deckvalidator.ts` and `web/src/ui/profile.css`. `main.ts` only
calls `matchSetup()`, `startMatch()`, the tracker's `abandon()` /
`onStatus()` / `onPhase()` and `onResult()`.

- **Opening.** `LocalProfileService.open` at page load, with sim-core's deck
  rules injected (`validateDeck`). When IndexedDB is unavailable the library
  falls back to memory and the map screen says the profile is temporary;
  when the open fails (`schema_too_new`, `storage`) the screen says why and
  offers **Use a temporary profile** (`memoryProfile()`), never silently. A
  match can't start without a profile.
- **The core's deck rules through WASM.** `sim-wasm` exports
  `validate_deck(card_ids_json) -> errors_json` (marshalling only:
  `CardDb::validate_deck` on the embedded cards, parsed once; `bad_deck`
  for anything but an array of strings). The page loads the web WASM build
  once on the main thread too (the worker has its own instance) and wraps
  it as the profile's validator; if it fails to load, the TS mirror (same
  rules and messages) is used with a console warning. The cases of
  `t3_cards.rs` are a shared fixture,
  `crates/sim-wasm/tests/fixtures/deck_cases.json` (decks and expected
  errors, written from the mirror with `UPDATE_FIXTURES=1`): the WASM test
  (`wasm_validate_deck_matches_the_cases`) checks the core gives exactly
  those errors, and `deck_wasm.test.ts` checks the mirror and the web WASM
  build give them too, plus 2,000 random decks on which WASM and the
  mirror agree. The "three legendaries" case needs a custom card table and
  stays in the mirror test only.
- **Match setup** (map screen, under the built-in levels): the deck (every
  saved deck; the starter deck by default), the difficulty (a select with
  **only the unlocked tiers**) and **This is my hometown** (a checkbox,
  read when the match starts). The active deck and tier are browser
  preferences in `localStorage` (`ztd.activeDeck`, `ztd.tier`), not
  profile data. A stored tier that is not unlocked (another profile
  imported) falls back to Recruit.
- **Every match is set up by the profile.** `newMatch` (a level, Enter or
  New match, Retry after a load error) asks `matchSetup()`: the active
  deck's card ids (`deckCardIds`, which refuses an illegal deck: the
  loading card then says 'The deck "…" is not legal: …. Fix it in the deck
  builder.' and no match is built), the tier (refused if locked) and the
  multiplier, then sends `init {setup: {seed, deck, population_multiplier}}`.
  The setup now waits for IndexedDB, so `newMatch` first sends `stop` to
  the old match (after asking for its record, see the claims): the old
  match must not keep posting its state while the new one is set up. A
  setup overtaken by another new match or by ← Map is dropped (`matchGen`).
- **The multiplier** is `Math.fround(match.population_multiplier ×
  difficulty[tier].population_multiplier)` (an f32, as the server will
  compute it for `ExpectedRun.population_multiplier`), checked against the
  verifier's range [0.25, 4] × the base before the match is built: 0.3,
  0.375, 0.45 and 0.6 for the four tiers with the default config. Recruit
  gives the f32 of 0.3, the config's own, so the T5 match and its hashes
  are unchanged (the full-match test still verifies).
- **`outbreak_scale` and `fatigue_scale` are not wired.** They are not sim
  inputs: making them so changes what a record replays, so they must
  become setup or `Config` fields with a `SIM_RULES_VERSION` bump (Run
  records (T4), "The config hash covers what the sim reads"). The match
  setup shows the tier's population factor and "Outbreak and fatigue
  scaling: coming soon"; the Progress screen lists their values as coming
  soon.
- **Place names.** The profile's `city`, `district` (and `cityId`) come
  only from `placeFromGeocoder` (`adminOf` in profilematch.ts):
  - the place search now asks Nominatim with `addressdetails=1` and keeps
    `placeFromGeocoder(result.address, result)` of the chosen result: the
    admin fields only, and a `cityId` only when the result itself is a
    city relation (the player searched the city; an address result gives
    none, fail-closed as in T7a);
  - a dropped pin's reverse geocode is now at **zoom 14** (suburb, an admin
    level) with `addressdetails=1`, so the answer names no street at all;
    its admin fields give the city and district, its display name the
    pin's label (which used to be street level, at zoom 17). If the reverse
    fails, the match has an empty city and district (it pays and is
    stored, but tags no city);
  - the built-in levels have fixed names: Le Marais / Paris, and "" / Le
    Vésinet, with no `cityId`: a searched "Paris" (keyed on its relation)
    and the Marais level (keyed on the name) are two city keys until a city
    lookup gives the level an id;
  - the display label (`Place.name`, from `display_name`) never reaches the
    profile. It is for the page's titles only (the pin, the game screen's
    place line). The run record carries the map's shell, and the profile
    stores the record, so a streamed shell's `name` is the constant
    `"streamed"` (`STREAMED_SHELL_NAME`, stream.ts), not the label (it used
    to be the label, so a searched address put its street and house number
    into every stored record). The verifier ignores shell names
    (`shells_equal` and `shell_hash` compare centre, radius, bounds and
    fences only), so verification is unchanged. The map bundle carries the
    same shell. Downloaded file names use `placeLabel(district, city)`, not
    the label. The last place remembered in `localStorage` (the map
    screen's pin, a UI convenience outside the profile) keeps the label for
    its title and its admin names, which go through `placeFromGeocoder`
    again when read back.
  Tests: Nominatim-shaped results with a road, a house number and a
  postcode give only the admin names (unit); the E2E routes the search and
  the reverse geocode to fixture answers and checks the pin's admin names
  and the request parameters; a streamed match started from a searched
  house ("12, Rue des Rosiers … 75004") stores a record whose shell is
  `"streamed"`, and no street, house number or postcode appears in the run
  record, the history entry, the profile export or the map bundle (E2E).
- **Match id and daily events** (`MatchTracker`). A UUID is made when the
  match is sent to the worker (`startMatch`); retries and restarts stay in
  the same match. The first status with `zombies_killed > 0` reports
  `first_blood` (once per match; the profile counts it once a day); each
  wave won (`wave_won`, or wave 8's `match_won`) reports `wave_victory`
  with that wave's end civilians (once per wave per match; the profile
  keys it per match and wave too, so a retried wave never counts twice).
- **One claim per match.** Wave 8 won claims at once ("cleared"). Leaving a
  match claims it ("abandoned") when it made progress: a wave started, won
  or lost, or a retry or restart (`hasProgress`; a wave-1 prep where cards
  were only placed is no claim and leaves no history). Leaving is ← Map
  (and New location), a new match (another seed, or New match), and
  entering another level while one is on screen. The tracker takes the
  snapshot and posts the `record` request synchronously, before the
  worker's `stop` or `init`, so the record is the abandoned match's (the
  worker answers a record at once, in message order). The claim is marked
  sent before the profile call, and the profile is idempotent on the match
  id, so a match is paid once whatever the UI does (a second claim pays
  nothing and returns the first payout).
  **The old match's messages.** A new match sends `stop`, then waits for
  the profile (IndexedDB) before its `init`. The old match's `status`,
  `state` and `placements` that were already queued arrive in that window.
  They used to put the old status back, so leaving the new match at once
  claimed it as "abandoned, paid" with the old match's data, and daily
  events could be credited to it. Now every `init` carries a `match` id
  (the page's match generation). The worker tags every message it posts
  with the id of the last `init` (0 after a `stop`), and the page drops
  every match message whose id is not the match on screen (none between a
  `stop` and the next `init`). Defence in depth: the tracker reports a
  daily event, or claims a match, only once it has seen a status after
  that match's own `ready` (`MatchContext.live`). E2E (each exit path,
  hook `newMatch`, a new seed with Enter, New match): during a running
  wave the main thread is kept busy for 300 ms, then the new match starts
  and ← Map is pressed as soon as it has an id. The old match only is
  claimed, and the new one is nowhere in the profile. Each guard alone
  passes the test, and with both removed it fails. Closing the tab is not a claim
  (IndexedDB can't be written reliably on unload): that match is lost, as
  an issued but never submitted server run counts as abandoned.
- **The summary** (`buildSummary`) comes from what the worker reported:
  waves won are the distinct waves with a won result (a retry drops the
  retried attempt's result, a restart drops them all), `savedPerWave` their
  end civilians, `retries` the wave retries plus match restarts,
  `defendedRadiusM` the ring radius of the last wave won (capped by the
  profile's bound), the centre the level's (or the shell's). The **MVP
  card** is the armament whose garrisons still on the map have the most
  kills (the towers' kill counts mapped to their garrison's card; ties by
  card id). The core keeps no per-card kill count, so tactical cards and
  pulled-down garrisons don't count, and a match without a garrison kill
  has none. It is cosmetic (it goes on stamps); a server derives it from
  the replay.
- **Rewards are not verified locally.** The claim stores the record but
  does not replay it first: the profile is the player's own data on their
  machine (IndexedDB can be edited anyway), and a replay costs what
  playing cost (about 5 s for a Marais match, minutes at 1.3 km, on the
  main thread or a second worker while the player is in the next match).
  The server re-runs every record before it pays (Run records, "What the
  server must check"). The E2E tests verify the stored records headless
  instead.
- **The payout** is shown where the claim happened: in the match panel
  after wave 8 (tickets with the breakdown by furthest wave, clear,
  civilians and the no-retry bonus, the match victory daily tickets,
  unlocked tiers, new achievements), or in a panel over the map screen for
  an abandoned match (also shown in a match after New match). "Already
  claimed: this match pays nothing more" when the profile says `paid:
  false`.
- **Hometown crate.** When the match was started with "This is my
  hometown" checked and it is cleared, the payout offers **Open the
  Hometown crate** (`claimHometownCrate(matchId)`, once per profile; the
  button is hidden once it was claimed). The checkbox is the player's
  word: nothing compares the place with an address.
- **Screens** (one modal on the map screen, with tabs): **Deck builder**
  (the collection grouped by card with owned and in-deck counts and Add,
  which prefers the newest stamped copy; the deck grouped by card with
  Remove; the live `checkDeck` problems in words with card names; Save,
  not for the starter deck, which can only be copied with "New deck from
  this one"; Save as new deck; Use for matches, only for a saved, unchanged
  and legal deck; Delete); **Collection** (every instance: name, rarity,
  foil, account-bound or its stamp: place, wave, tier, civilians saved,
  MVP, date); **Crates** (tickets, Open a crate with its lore and the three
  new cards, the crates opened); **Match history** (place, tier, cleared or
  abandoned in wave n, waves won, retries, saved, tickets, MVP, and
  Download run record from the stored record); **Progress** (tiers, the
  cities of the cleared matches with their defended share per tier,
  *provisional* while the area is the placeholder, achievements).
- **No map bundle in the history.** A streamed match's map (the shell and
  up to ~110 blocks) is several MB; the history stores only the run
  record, so the map bundle is still downloaded from the match panel at
  the end of the match (Streaming map (T6b)). The history says so.
- **Coverage on the map screen**: **Show my coverage** draws the
  `coverageInBox` cells of the visible map as a MapLibre fill layer
  coloured by the cell's highest tier (Recruit green, Veteran blue, Elite
  purple, Nightmare red), refreshed on every map move and after each
  claim, hidden during a match.
- **Test hook** `window.__zt.profile` (`ProfileHook`, testhook.ts):
  `state()` (cards, tickets, decks, active deck, tier, unlocked tiers,
  history count, hometown claimed), `settle()`, `claims()`, `match` (id,
  tier, deck, multiplier, place names), `coverageDrawn`, `payoutText`, the
  screens (`openScreen`, `closeScreen`), `setTier` / `setDeck` /
  `setHometown`, `claimAgain(matchId)`, `getMatch`, export / import and
  `refresh`; plus `__zt.picked` (the map screen's pin with its admin names)
  and `__zt.backToMap()`. The one test-only power is
  **`fastForwardClear()`**: it claims the match on screen as cleared with a
  synthetic 8-wave summary (and the real record) through the same claim
  path and payout panel. It writes the profile only, never the sim, and
  the real 8-wave clear stays in the suite (match.spec.ts checks its
  claim, the Veteran unlock, coverage and the history's record).
- **`crateLore` replacements (T7a review).** `{place}`, `{wave}` and
  `{tier}` are replaced with functions: a replacement string expanded `$&`,
  `` $` ``, `$'` and `$$` in a place label ("Saint-$&-Ville" read
  "Saint-{place}-Ville"). A unit test checks each pattern comes through as
  is.
- **Tests.** Unit: `deck_wasm.test.ts` (above), `profile_match.test.ts`
  (the summary, the MVP card, progress, the geocoder's admin names, and a
  tracker on a memory profile: first blood and wave victories once, one
  clear paid once, a pristine match never claimed, an abandoned match paid
  once and a second claim paying nothing), the `crateLore` test. E2E
  (`profile.spec.ts`, all three browsers; M1 Pro, the whole suite on three
  workers while other agents' builds shared the machine, load 4–10):
  1. a new profile: the starter deck (20 account-bound cards), only Recruit
     offered; an illegal deck (19 cards) refused by the deck builder and,
     imported, at match start (1–2 s);
  2. wave 1 won by the bot, then ← Map: first blood and wave victory
     tickets, the payout once, `claimAgain` pays nothing, a pristine match
     left is no claim, and the history's record verifies with the native
     `sim-headless verify` (4 s Chromium and WebKit, 8–15 s Firefox);
  3. a fast-forwarded clear with "This is my hometown": Veteran unlocked,
     the Hometown crate (5 cards), coverage drawn, a crate opened (stamps
     with the district and city, no street in stamps, lore or the screen),
     a deck built with a crate card in the builder used in a Veteran match
     (the record's `setup.deck` and multiplier 0.375), Elite unlocked by a
     Veteran clear, the city provisional on Progress (2–6 s);
  4. the place search and a dropped pin answered by fixture Nominatim
     results: admin names only, `addressdetails=1`, `zoom=14` (1–2 s).
  `match.spec.ts` (the real 8-wave clear) also checks the record's deck and
  multiplier, the one claim with no no-retry bonus, Veteran unlocked,
  coverage, and that the history's record equals the panel's (30 s
  Chromium and WebKit, 1.1–1.4 min Firefox, as before). Whole suite: 75
  tests in 13.6–16.6 min, green twice. One run had a WebKit failure in
  T5's "phase buttons" test (the Pause click did not register, in a 17 s
  run of a 4 s test under load); it passed 6 of 6 when rerun alone.

## Replay viewer and first session (T8)

- **The replay is sim-core's verifier, stepped.** `record::Replayer` is
  `replay_with` cut into steps: `Replayer::start(record, map, expected,
  cfg, cards, limits)` makes every check that needs no simulation and the
  map's, and builds the match from the record's setup on the given map;
  each `step(&mut match)` applies the action due on this tick, else steps
  one tick, else (at `end.tick`) makes the final checks, with the same
  checks in the same order as before. `replay_with` is now a loop over
  it (every T4 test, the golden record and the tamper tests unchanged).
  Every check that passes is kept as a `ReplayCheck {attempt, wave, tick,
  what: prep|end|final, hash, result}`; the first failure ends the replay
  and every later step returns it. The replayer doesn't own the match, so
  the viewer renders it between steps; `check_start` makes the opening
  check (attempt 0's prep) without stepping, so a record that diverges at
  tick 0 still shows its map.
- **In the browser** the worker runs it: `init` with `replay {record}` (and
  the map: the level, or the shell and every block of the record) builds
  `WasmMatch.replay_level` / `replay_chunks` (marshalling only: a
  `WasmMatch` holding a `Replayer`). `replay_run(max_ticks, max_actions,
  max_ms, stop_wave)` steps it within those budgets and returns the new
  checks, the position and the outcome (summary or `VerifyError` JSON).
  The worker's replay loop: the panel offers 1×, 4× and Max. 1× and 4×
  step that many ticks per 50 ms like a played match, one action per
  slice and then a hold of 400 ms / speed (the browser never steps prep,
  so a whole prep's plays are on one tick: the hold lets them be
  followed), and only the ticks a slice ran use up its time budget; Max
  runs 40 ms slices back to back. The replay speed is kept apart from the
  played speed (each carries over to the next match of its kind), so a
  replay at Max never makes the next played match run flat out;
  Step (`replay_ctl step`) is one tick plus the actions due before it,
  paused; Jump to wave n runs at Max until wave n's prep opens
  (`stop_wave`), then pauses, and a jump to the current wave or before
  rebuilds the match from the record first (the replay only goes
  forward), already paused (wave 1) or already jumping, so no slice
  without a stop wave runs after the rebuild. Pause works in any phase. The worker posts the usual
  `status` / `state` / `placements` / `geometry`, so the game view draws
  the replay as it draws a match, plus a `replay` progress message.
- **Read-only, and never the profile.** In replay mode `WasmMatch.apply`
  and `add_buildings` are refused (`read_only`), the worker answers every
  `action` with that error and ignores `chunk`, and the page hides the
  match controls (seed, start, retry, restart, speed buttons, mulligan,
  the tools panel and the result panel), renders the hand without click
  handlers, and never calls the match tracker (no claim, no daily event:
  `ready`, `status` and phase changes skip it). The history's Replay
  button only reads the stored record (`getMatch`). The E2E tests compare
  the whole profile state before and after a replay.
- **The checks on screen.** One row per recorded attempt (plus the
  attempt open at the end of a record that stops in a prep or a wave)
  with a prep and an end dot, and a last row for the end of the record:
  grey until reached, green when the replay made that check, red at the
  `diverged` error's attempt and check (`what`: wave, start tick or prep
  hash is the prep dot; end tick, result, end hash, extra or missing
  attempt the end dot; phase and final hash the end row). The verdict
  line says "Diverged at attempt k (wave w), tick t: the end hash is X in
  the replay, Y in the record." (attempts numbered from 1 for people,
  the hook keeps the 0-based index), or the rejection's message for the
  other errors (illegal action, map hash...), or "Verified".
- **Where the map comes from** (`web/src/replay.ts`). A level run: the
  built-in level whose centre and radius are the record shell's (the
  verifier then compares them bit for bit and hashes the buildings), or a
  level file given with the record: offline. A streamed run: a map bundle
  given with the record ("Download map"), else **the browser's block
  cache** when it still holds every block of the record (projected on the
  record's centre, exactly as the loader did, on a shell rebuilt with
  `buildShell` for that centre), else the picker says it needs the bundle
  and how many blocks are missing. The cache is a convenience for one's
  own recent runs: a block refreshed since (new OSM data) changes the
  snapshot hash and the replay says `map_hash`; the bundle is the sure
  way. The files are told apart by content (a record, a bundle with
  `chunks`, a level with buildings), so they can be dropped together or
  one after the other.
- **The history has no map** (T7b): Replay on a streamed match tries the
  cache, then asks for the bundle in the picker, the record already
  loaded. The first-session test empties the cache first (the test hook's
  `clearMapCache`, map data only) so it goes through the bundle.
- **The first-session E2E** (`web/e2e/first-session.spec.ts`, all three
  browsers, offline): a new profile; the place search answered by a
  fixture Nominatim (the Marais centre, admin names Le Marais / Paris),
  picked and marked as hometown; "Start here" on the streamed 1.3 km
  shell with the fixture Overpass of stream.spec.ts (now shared in
  `e2e/streamfixture.ts`); 8 waves cleared on seed 1 by the test bot
  (`playPrep` through the hook), the first armament of wave 1 played with
  real clicks on the buildings the bot would have picked (so the plays
  are the bot's, and the Node check below predicts the browser run tick
  for tick); the claim (cleared, paid, Veteran unlocked, the no-retry
  bonus); the Hometown crate (5 cards stamped Le Marais, Paris, wave 8);
  the run record and the map bundle downloaded from the match panel and
  equal to the history's record; then the block cache emptied (test hook
  `clearMapCache`), Replay in the history, the picker asking for the
  bundle, the bundle given, the replay run at Max to the end with all 17
  checks green (8 attempts × prep and end, and the end of the record),
  the profile unchanged by it; and `sim-headless verify --chunks` on the
  downloaded files with the browser's attempt and final hashes.
- **Its map is a village**, the Marais buildings within 150 m of the
  centre (109 buildings, `villageLevel` in `test/unit/fixtures.ts`), on
  the full 1.3 km streamed map (109 blocks, all fetched). The test bot
  can't clear 8 streamed waves on the whole Marais fixture: under Node
  (the WASM build, the same bot), seeds 1–20 with the simple bot or with
  tactical cards (`zombieHotspot` every 40 ticks, as the T5 scenario)
  mostly lose the dense wave 2 or 3, and the best (seed 1) wins waves
  1–7 and then loses wave 8 in 43 ticks: about 200 civilians are left by
  then (nothing lives past 400 m, so the outer rings bring no
  newcomers), and wave 8's inner outbreaks take the wave under 15% at
  once. Filling the outer rings with sparse copies of the Marais (one
  building in 4 to 64, over the whole disc, only in the outer rings, or
  thinning the core too) made it worse: the bot can't protect those
  newcomers, so the waves that reveal them fall under 15%. On the
  village every civilian and every garrison is in wave 1's ring and the
  outer outbreaks have to come to them: seed 1 clears all 8 waves at the
  first try (5,106 ticks); with tactical cards seed 3 clears it too (one
  lost attempt), and a 120 m village clears seeds 1 and 2. It keeps
  what the test is about (a streamed place, the loader, the 1.3 km grid
  and its flow fields, the full loop) without needing a better bot.
- **Run times** (M1 Pro, one browser at a time or two in parallel; the
  sim is identical, 5,106 ticks in each): Chromium 1.5 min (8 waves
  33 s, replay at Max 26 s), WebKit 1.2 min (32 s, 24 s), Firefox
  5.9 min (8 waves 173 s, replay 163 s: Firefox's WASM is several times
  slower in Playwright's build, as in the stream test). No shortened
  Firefox variant was needed. Replaying the golden record (17,577 ticks,
  the Marais level) at Max takes 12 s in Chromium and WebKit and 72 s in
  Firefox (`replay.spec.ts`).
- **Whole suite after T8:** 90 tests (30 per browser) in 9.1 min on three
  workers, green twice in a row; in it the first session takes 93 s in
  Chromium, 74 s in WebKit and 371 s in Firefox. The report was
  regenerated with `report --quick` (6.8 min; the full one's scale bench
  takes about an hour) and has a new **8-wave match** section: the
  per-wave table of `sim-headless match --level paris-marais --seed 1`,
  the time to play it (3.9 s native) and to replay its record (3.9 s
  native, 5.2 s WASM under Node with `tools/verify-run.mjs`).
- **Manual check (T8, the dev server in the desktop preview, Chromium):**
  a Marais match played with clicks only (rifles, a mortar and a fence
  placed by building clicks and a drag; wave 1 lost twice, retried, won;
  wave 2 won), ← Map with its payout panel, the deck builder, a crate
  opened (three stamped cards), the history's Replay run at 4× then Max
  to the end with every check green. A golden-record replay dropped in
  the picker, a jump back to wave 3 and a tampered record (attempt 3 in
  red with both hashes) were checked the same way. Nothing needed fixing.
  Seen and left as is: a wave's result panel covers the toolbar, so ← Map
  needs Close first (T5 behaviour); the abandoned match's payout says
  "Furthest wave 3" after two waves won (T7a's rule: the wave reached).
