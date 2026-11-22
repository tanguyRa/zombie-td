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
