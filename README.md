# Zombie TD — proof of concept

A real neighbourhood turned into a zombie-outbreak tower defense. Buildings
come from OpenStreetMap. Up to 100,000 agents are simulated at 20 ticks/s by
one Rust core that runs natively (headless tests, scenarios, benchmarks) and
as WASM in the browser.

![The browser prototype: Paris Le Marais, 20k agents, two garrisons and a fence, two minutes into the outbreak](docs/screenshot.jpg)

*Paris Le Marais, 20k agents, two rifle garrisons (green) and a fence, two
minutes in. Civilians are blue, zombies red. The "Render fps 1" in this
capture comes from the hidden preview pane it was taken in, not from the app.*

## Prerequisites

Only **Docker** with Compose v2 (Docker Desktop on macOS, Docker Engine on
Linux). Tested with Docker 29.6.1 and Compose v5.3.0 on an Apple M1 Pro.

Everything else lives in the dev image (`Dockerfile`):

| Tool | Version |
|---|---|
| Rust (stable, `rust:1-bookworm`) | 1.100.0 |
| wasm-pack / wasm-bindgen | 0.13.1 / 0.2.100 |
| Node.js / npm | 22.23 / 10.9 |
| Python (level tool), requests, shapely | 3.11.2, 2.28, 1.8.5 |
| Web: Vite, TypeScript, deck.gl | 6.4.6, 5.9.3, 9.4.1 |

`./dev.sh <command>` runs a command in that container with this folder
mounted at `/work`. `./dev.sh` alone opens a shell. Rust build output and
`web/node_modules` live in Docker volumes, so the checkout stays clean.

If you already have Rust (with the `wasm32-unknown-unknown` target),
wasm-pack and Node 22 on the host, the commands below also work without the
`./dev.sh` prefix.

## Commands

| What | Command | Output |
|---|---|---|
| Everything | `./run-all.sh` | Builds WASM, runs all tests, writes the report, serves http://localhost:5173 |
| Headless test suite | `./dev.sh cargo test --release` | All tests green |
| Native = WASM hash test | `./dev.sh wasm-pack test --node --release crates/sim-wasm` | WASM reproduces the native hash |
| Headless report | `./dev.sh cargo run --release -p sim-headless -- report` | `reports/headless-report.md` and `.html` (charts), raw `reports/*.json` and `*.csv` |
| Browser prototype | `./dev.sh bash -c "cd web && npm install && npm run dev"` | Playable page at http://localhost:5173 |

Useful extras:

- `./dev.sh cargo run --release -p sim-headless -- run --level suburb --pop 20000 --seed 3`
  plays one game headless and prints the population every 10 s.
- `./dev.sh cargo run --release -p sim-headless -- report --quick` makes a
  fast report (2 seeds, no S5, short benchmarks) for iteration. It is marked
  "QUICK MODE".
- `./dev.sh python3 tools/levelgen/levelgen.py --name paris-marais --lat 48.8580 --lon 2.3580 --query-radius 500`
  regenerates a level from Overpass (one query). Nothing else touches the
  network.

The generated report is committed in [`reports/`](reports/headless-report.md),
so you can read the results without running anything.

## Playing

1. **Setup.** Pick a level, population (5k–100k) and seed. Civilians wander;
   the outbreak locations are hidden.
2. **Tower** (8 available): click a building to garrison it. It shoots the
   nearest zombie within 40 m, 2 shots/s, 3 hits to kill.
3. **Fence** (400 m): drag on the ground. The parts that fall on buildings
   are clipped off, so a line drawn from wall to wall seals a street. Zombies
   detour when a cheap way around exists and otherwise break through
   (300 hp per 2 m cell, 10 hp/s per zombie). Civilians never cross fences.
4. **Undo** (also Ctrl/⌘-Z) and **Clear** while in setup.
5. **Start.** The outbreak begins in 3 clusters. **Pause** (Space), speed
   1× / 2× / 4×, **Reset**.
6. The game ends when no zombies or infected are left (**win**), no civilians
   are left (**loss**), or after 10 minutes (**timeout**). Score = surviving
   civilians. **Replay same seed** re-runs the same setup and gives the same
   result.

Pan by dragging, zoom with the wheel, **Frame level** to re-centre. The debug
panel shows the chase or flee field as a heatmap and the spatial-hash grid.

Colours: civilians blue, infected (1 s before turning) yellow, zombies red,
dead grey, fences white fading to red as they take damage.

## Results

From the committed [headless report](reports/headless-report.md), generated
on the Apple M1 Pro inside the Docker dev container (Linux VM, one thread).

| Check | Target | Measured | Result |
|---|---|---|---|
| Native p95 tick, 100k agents | ≤ 15 ms | 13.21 ms | PASS |
| Native max tick, 100k agents | ≤ 30 ms | 19.80 ms | PASS |
| WASM (Node) p95 tick, 100k agents | ≤ 25 ms | 16.63 ms | PASS |
| WASM (Node) max tick, 100k agents | ≤ 45 ms | 20.28 ms | PASS |
| Tests (24, incl. native = WASM hash) | all pass | 24/24 | PASS |

Separation is the biggest cost (about half the tick), then the flow fields
(about 18%). About 77% of civilians are dormant on average over the first
150 s.

**Browser, measured on this machine (Apple M1 Pro, Chrome-based preview):**
at 100k agents the sim keeps real time at 9.7 ms last / 18.6–19.3 ms p95
per tick (target: under 50 ms), with no fallback mode. A full game at 20k
agents with 2 garrisons and a fence ended Loss at 9:42 with 249 zombies
killed, three times in a row (two fresh page loads and one "Replay same
seed").

**Not verified: the 60 fps render target.** The preview window used during
development was hidden, so the browser throttled it to about 1 fps and frame
rate couldn't be measured. deck.gl reports no per-frame attribute rebuilds,
and the main thread only interpolates positions (one pass over 200k floats)
per frame. Check the "Render fps" line in the HUD in a normal browser window
at 100k agents and record it here.

Scenario highlights (5 seeds each): without defense, Paris loses half its
civilians after about 342 s (S1). Eight central garrisons kill about 820
zombies but barely move the outcome (S2). The fence ring in S3 is first
breached after 18 s. The suburb falls faster than Paris (S4, half lost at
193 s), and 100k agents in Paris behave like 20k but faster (S5).

## How it works

- **`crates/sim-core`**: the whole game. Level rasterization (2 m cells),
  struct-of-arrays agents, a counting-sort spatial hash, Dijkstra flow fields
  with a bucket queue (chase for zombies; threat and a Brogue-style flee field
  for civilians), dormant civilians far from danger updated 1 tick in 4,
  bites, a 1 s infection, separation, wall sliding, towers and fences.
  Deterministic: PCG32, no trig, index-order iteration, FNV-1a state hash.
- **`crates/sim-headless`**: tests support, scenarios S1–S5, benchmarks and
  the report writer (SVG charts, no Python).
- **`crates/sim-wasm`**: wasm-bindgen wrapper with no logic of its own.
- **`web/`**: the sim runs in a Web Worker on a fixed 20 Hz accumulator. It
  publishes positions and states through a triple-buffered SharedArrayBuffer
  (COOP/COEP headers set by Vite). If the page is not cross-origin isolated,
  it posts transferable snapshots instead and shows a "fallback mode" badge.
  The main thread interpolates between the last two ticks and renders with
  deck.gl (`OrthographicView`, meters as units).
- **`tools/levelgen`**: Overpass → level pack JSON. Committed levels:
  `levels/paris-marais.json` (659 buildings, r = 400 m) and
  `levels/suburb.json` (Le Vésinet, 375 buildings, r = 250 m).
- **`config.default.json`**: every tunable number, read by both the headless
  runner and the browser.

Every choice the spec left open is in [DECISIONS.md](DECISIONS.md).
