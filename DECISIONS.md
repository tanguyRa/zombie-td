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
    below still hold.
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
  which blocks happened to be loaded.
- **Reveal** happens when a wave's prep opens. The match keeps a `base`
  geometry per cell (walk / building / wall with all applied buildings);
  newly revealed cells take it (plus the level's own fences), older cells
  keep their kind (fences placed or broken stay as they are). Then the
  "largest 4-connected area" rule runs again over the disc with fences
  counted as open, and pockets walled off earlier are re-opened first, since
  a pocket cut by the ring edge may now connect. Step masks are rebuilt.
- **Buildings arrive in chunks** (`BuildingChunk { block_id, bounds,
  buildings }`, level-local meters). `add_buildings` works in any phase but
  refuses a chunk whose area (bounds grown to its buildings) touches the
  revealed disc, or a duplicate id. Chunks are stored, not applied: each
  reveal applies, in block-id order, every stored chunk whose area touches
  the new disc. Building indices therefore depend only on the chunks and
  the rings, never on arrival order or timing (tested: sorted, reversed,
  and staged arrival give the same per-wave hashes). `Match::new(level)`
  wraps a whole level as one chunk (id 0, infinite bounds).
- **`ring_ready(wave)`** means every grid cell within the ring radius +
  `match.block_margin_m` (50 m) is inside some chunk's bounds. The margin
  is needed: a block whose bounds stop short of a ring can still hold a
  building that reaches into it; without the margin the ring was declared
  ready without it and the staged test diverged. Buildings sticking out of
  their block by more than the margin are refused
  (`BuildingOutsideBlock`). Contract for T6: blocks tile the plane without
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
- **Prep is cosmetic, as before:** civilians wander from their own stream
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
  in play and applied block ids. `WaveResult` stores it at prep start and
  after the tick that ended the wave. A second fixture, two waves of a
  Marais match (`fixture::compute_match_fixture_hash`), hashes
  `4909c13c5beea4e9` natively and in WASM under Node (tested both sides).
  (T3 changed it on purpose to `e1061f2da92f6c9f`, see "Cards".)
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
  while running.
- **Commands** are applied by the worker between ticks, as soon as they
  arrive. The worker is single-threaded, so that is the start of the next
  tick.
- **Replay same seed** re-creates the sim with the same level, population and
  seed, re-applies the placement history and starts immediately.
- **Debug heatmaps** are refreshed once per second while enabled.

## Map screen and live levels

- **Base map:** MapLibre GL 5.24 with the OpenFreeMap "liberty" style (free,
  no API key, CORS headers so it works under COEP `require-corp`).
- **Search:** Nominatim, one request per submit (its usage policy forbids
  search-as-you-type). Clicking the map drops a pin and asks Nominatim's
  reverse endpoint for a street name.
- **Play area preview:** the dashed circle on the map is the maximum query
  radius (600 m). The real radius is chosen after the download.
- **Live level generation** (`web/src/levelgen.ts`) follows `levelgen.py`:
  one Overpass query at 600 m, radius grown from 100 m in 50 m steps until
  600–1,200 buildings, same kinds, floors and 15 m² minimum. Sparse places
  use the full 600 m; fewer than 40 buildings is refused with a message. It
  differs in clipping: without shapely, footprints crossing the circle are
  clipped with Sutherland–Hodgman against a 64-gon, so a footprint cut into
  pieces stays one polygon joined along the edge (those cells are walls
  anyway), and invalid rings are not repaired. If overpass-api.de fails, a
  second public instance (overpass.private.coffee) is tried.
- **Built-in levels** stay as presets on the map screen and need no network.
- **Downloaded levels are cached in memory** for the session, so going back
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
- **The smoke test sizes its own timeout** from `max_game_seconds` in
  `config.default.json`: the result-panel wait is `max_game_seconds / 4 × 1.5`
  (a game that hits the time limit at 4×, plus slack for slow browsers), and
  the test timeout adds the setup waits on top.
- **Tests run offline.** A shared fixture (`web/e2e/offline.ts`) routes every
  request: the Vite server passes, the OpenFreeMap style URL gets a blank
  local style (`e2e/fixtures/style.json`, one background layer) so MapLibre
  still loads and fires its events, and everything else (tiles, Nominatim,
  Overpass, fonts) is aborted. The tests only use the built-in levels.
- **Test hook behind `?test=1`.** `main.ts` imports `src/testhook.ts`
  dynamically only in test mode, so the normal page never loads or runs it.
  `window.__zt` exposes read-only snapshots (screen, phase, tick, stats,
  placements, level summary, state hash) and helpers that send exactly the
  worker messages the UI sends. The only protocol addition is a `hash`
  request/reply, answered by the worker with the current tick and hash.
- **The smoke test clicks through the real UI** (preset chip, population
  slider, Tower/Fence tools, a click on a building, a drag for the fence,
  Start, 4×) and uses the hook only to find screen positions and to assert.
  It plays Le Vésinet at 5k agents, the quickest built-in game.
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
  and so the snapshot hash. `levelgen.ts` now uses the same shared
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
  blocks are dropped. Only ways, like `levelgen.ts` (no multipolygon
  relations). The test fake answers with the same vertex-or-segment rule.
- **An Overpass runtime error is a failure, never an empty block.** On a
  timeout or out-of-memory Overpass answers HTTP 200 with
  `remark: "runtime error: …"` and partial or empty `elements`. A `remark`
  containing "error", an unparsable body or a body whose `elements` is not
  an array counts as a failed endpoint (`overpassQuery` tries the next one,
  then the loader's retry), so it is never cached. `levelgen.ts` shares the
  check.
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
  and checks the fixture's hashes; T4 moves it into sim-core). It hashes the
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
  from `config.default.json`: 2.83 m): today's sim-core `ring_ready` checks
  the cells within `ring_radius + block_margin_m`, and a pending fix widens
  that to `+ cell_size_m × √2` for cells straddling the disc. The larger
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
- **`levelgen.ts`'s grow-the-radius logic stays** for now (the current
  game still uses it); retiring or porting it to blocks is part of the
  integration step.

## Profile (T7a)

The local meta layer lives in `web/src/profile/` (library only: the deck
builder, collection, crate and coverage screens and the match wiring come
later).

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
  profile. `openProfileBackend` falls back to memory only when IndexedDB is
  missing or fails to open; `service.persistent` tells the UI to warn.
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
- **Stamp sanitiser** (`sanitizePlace`): strict on purpose, privacy before
  a pretty name. Postcode patterns are removed (UK, Canada, NL, PL, PT,
  SE/CZ, US ZIP+4, any 3+ digit run); a segment (split on `, ; / | ( )`
  and ` - `) is dropped whole when it holds a house number or looks like a
  street (street words in a dozen languages next to a name, glued suffixes
  such as `-straße`, `-straat`, `-gatan`, abbreviations such as `St`, `Bd`,
  `ul.`); the first segment left is kept, minus every token with a digit.
  A street word alone is a town ("Rue", "Largo"), and "St" counts only in
  last position ("St Albans" stays). Accepted false positives: areas named
  after a street ("Earls Court") fall back to the city. Limit: a bare
  street name with no marker and no number ("Strøget") is undetectable;
  geocoder district/city fields don't carry those. Match history stores the
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
  once. Each event has a key (`wave_victory:<match>:<wave>`,
  `match_victory:<match>`, `first_blood:<day>`) kept for all time, so a
  retried or restarted wave never counts twice, even the next day.
- **Crates**: one ticket opens one crate of `cards_per_crate` (3) cards;
  the Hometown crate has `hometown_cards` (5), needs a cleared match in the
  history and is granted once per profile (the UI decides which match is
  the player's own address). Each card: rarity from the tier's odds
  (`rewards.json` → `crates.odds`, cumulative against one 24-bit float),
  then a card of that rarity uniformly in `cards.json` order, then foil
  against a second float. Lore: a template of the crate's source picked
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
  matches, the 10–20 of GAMEPLAY.md. A cell counts when its **centre** is
  inside the defended radius (not when it merely touches the disc), so
  the covered area matches the disc's on average (within 15%, tested). Only
  cleared matches add coverage. Each cell keeps its highest tier and its
  highest tier per city key (a cell on a border can count for two cities).
  `coverageInBox` reads the box's candidate cells (or scans all when the box
  spans more than 20 000 cells).
- **City cleared**: the area of the cells counted for the city at a tier or
  harder, over the city's area, ≥ `coverage.city_cleared_fraction` (0.75),
  one achievement per tier. The city key is the place search's `cityId`
  when there is one (OSM relation later), else the folded name ("Paris" =
  " PARIS "), so homonyms in different countries merge until ids are
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
  one refused.
- **Data tables**: `rewards.json` at the repo root (next to `cards.json`):
  payout, daily caps, crate odds, foil chance, lore templates, coverage
  threshold and placeholder area. `checkTables` validates them when a
  service is created (odds sum to 1, every tier present, lore not empty).
