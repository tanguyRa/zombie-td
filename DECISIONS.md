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
- **Field schedule:** chase is recomputed when `tick % 5 == 0`, threat + flee
  when `tick % 5 == 2` ("alternating ticks"), plus both at Start and both,
  immediately, in the fence phase of any tick where a fence cell breaks.
- **Field units:** 10 per straight step = 5 cost units per meter. The wake
  radius (60 m) is therefore a threat value of 300.
- **Flee field:** threat is capped at `flee_threat_cap_m` (200 m) before
  multiplying by −1.2, so far-away regions are flat instead of infinite. The
  "one more Dijkstra pass" runs Dial's algorithm seeded with every walkable
  cell at its scaled value. The seeds come pre-sorted for free: capped cells
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
