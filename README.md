# Zombie TD — proof of concept

A real neighbourhood turned into a zombie-outbreak tower defense. Pick any
place on a street map; its buildings are downloaded from OpenStreetMap. Up to 100,000 agents are simulated at 20 ticks/s by
one Rust core that runs natively (headless tests, scenarios, benchmarks) and
as WASM in the browser.

![The browser match: Paris Le Marais, wave 6 of 8 in progress, with the wave HUD, the hand and the fogged next ring](docs/screenshot.jpg)

*Paris Le Marais, wave 6 of 8, 19 s into the outbreak: about 3,600
civilians (blue), the zombies of the outbreak (red), the garrisons placed
over six preps (green, with their ranges). The disc is the revealed area,
the lighter band around it the fogged next ring, everything past it
darker. Right: the wave HUD (saved share against the 15% line, stamina,
supply, deck and discard); bottom: the hand (the two tactical cards kept
for this wave are playable now, the fortifications wait for the next
prep). The "Render fps 1" comes from the preview pane it was taken in,
which throttles a page in the background, not from the app.*

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
| Web: Vite, TypeScript, deck.gl, MapLibre GL | 6.4.6, 5.9.3, 9.4.1, 5.24.0 |
| Browser tests: Playwright (Chromium, Firefox, WebKit) | 1.61.1 |

`./dev.sh <command>` runs a command in that container with this folder
mounted at `/work`. `./dev.sh` alone opens a shell. Rust build output and
`web/node_modules` live in Docker volumes, so the checkout stays clean.

If you already have Rust (with the `wasm32-unknown-unknown` target),
wasm-pack and Node 22 on the host, the commands below also work without the
`./dev.sh` prefix.

## Commands

| What | Command | Output |
|---|---|---|
| Everything | `./run-all.sh` | Builds WASM, runs every suite (native, native with debug assertions, WASM under Node, typecheck, web unit tests, Playwright in three browsers), writes the report, serves http://localhost:5173. `./run-all.sh --quick` passes `--quick` to the report |
| Headless test suite | `./dev.sh cargo test --release` | All tests green |
| Headless test suite with debug assertions | `./dev.sh env CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true cargo test --release --workspace` | All tests green with `debug_assert!`s on (release speed, own build cache) |
| Native = WASM hash test | `./dev.sh wasm-pack test --node --release crates/sim-wasm` | WASM reproduces the native hashes and verifies the golden 8-wave run record |
| Verify a run record | `./dev.sh cargo run --release -p sim-headless -- verify run.json --level paris-marais --expect-seed 1` | `verified: …` and the replay summary (exit 0), or `rejected: …` naming the first diverging wave attempt (exit 1) |
| Headless report | `./dev.sh cargo run --release -p sim-headless -- report` | `reports/headless-report.md` and `.html` (charts), raw `reports/*.json` and `*.csv` |
| Typecheck (app, E2E and unit tests) | `./dev.sh bash -c "cd web && npm ci && npm run wasm && npm run typecheck"` | No TypeScript error |
| Web unit tests (Node, Vitest) | `./dev.sh bash -c "cd web && npm ci && npm run test:unit"` | Map blocks, projection, snapshot hash, block cache and loader tests pass (no network, no browser); `cargo test --release -p sim-core --test t6_chunks` checks their Rust fixture. The local profile tests (`web/src/profile/`: collection, decks, payouts, daily caps, crates, tiers, coverage, storage) and the replay viewer's inputs (`replay.test.ts`) run in the same suite |
| Browser tests (Chromium, Firefox, WebKit) | `./dev.sh bash -c "cd web && npm ci && npm run e2e"` | The first session (new profile to replay), a full 8-wave match through the UI (its run record verified headless), the match UI, streaming, profile and replay tests and the native = browser hash test pass in all three browsers |
| Browser prototype | `./dev.sh bash -c "cd web && npm install && npm run dev"` | Playable page at http://localhost:5173 |

Useful extras:

- `./dev.sh cargo run --release -p sim-headless -- run --level suburb --pop 20000 --seed 3`
  plays one game headless and prints the population every 10 s.
- `./dev.sh cargo run --release -p sim-headless -- match --level paris-marais --seed 1`
  plays an 8-wave match headless with the starter deck "Civil Defence
  Issue" and a simple scripted defence. In prep it mulligans a hand with no
  armament, plays armaments on spread-out buildings and fences as arcs
  inside the previous ring, and keeps tactical cards. While the wave runs it
  plays tactical cards on the densest group of zombies. It retries a lost
  wave up to 3 times with a different building choice. It prints one row
  per wave attempt: radius, newcomers, civilians at start and end, kills,
  bites, towers, cards played, supply left, game time, tick times and the
  end-of-wave state hash. `--retries`, `--multiplier`, `--no-tactical` and
  `--max-wave-s` (a safety cap; the match itself has no timeout) tune it.
  `ZT_CONFIG=<file>` and `ZT_CARDS=<file>` swap `config.default.json` /
  `cards.json` for balance sweeps; `--level marais-tiled:1300 --fast-forward-to 8 --max-wave-s 150`
  times a real wave 8 at the wave-8 caps (earlier waves won instantly).
  `--record run.json` also writes the match's **run record** (setup, map
  snapshot hash, every action with its tick, the state hash at the end of
  every wave attempt; not with `--fast-forward-to`, which bypasses the
  action log).
- `./dev.sh cargo run --release -p sim-headless -- verify run.json --level paris-marais`
  (or `--level <path to level.json>`, or `--chunks chunks.json --shell
  shell.json` for a match on streamed map blocks: the shell is the level
  without buildings, from the verifier, never the record's) replays a run
  record and checks every action and every wave hash, as the server will
  before paying rewards. `--expect-seed N`, `--expect-deck id,id,...` and
  `--expect-multiplier K` reject a record whose setup is not the one the
  server issued. It prints the replay summary (with the setup and the map
  and shell hashes), or why the run was rejected and at which wave attempt
  it first diverged. `ZT_CONFIG` / `ZT_CARDS` apply as for `match`
  (a record only verifies with the config and cards it was played with);
  `--max-ticks` changes the tick bound, `--quiet` drops the progress lines.
  `node tools/verify-run.mjs run.json --level levels/paris-marais.json` does
  the same with the WASM build (`pkg-node`, see `tools/wasm-bench.mjs`),
  with the same flags.
- `./dev.sh cargo run --release -p sim-headless -- report --quick` makes a
  fast report (2 seeds, no S5, short benchmarks) for iteration. It is marked
  "QUICK MODE".
- `./dev.sh cargo run --release -p sim-headless -- bench --scale --out reports/scale.md`
  runs the wave-8 scale benchmark (1.1 / 1.3 / 1.6 km levels and the tiled
  Marais, 20k–150k agents, native and WASM; about an hour). `--radii`,
  `--pops`, `--level`, `--ticks` and `--skip-wasm` narrow it down.
- `./dev.sh python3 tools/levelgen/levelgen.py --name paris-marais --lat 48.8580 --lon 2.3580 --query-radius 500`
  regenerates a committed level from Overpass (one query; picked places
  stream blocks instead).

### Browser tests

Playwright end-to-end tests live in `web/e2e/` and run in Chromium, Firefox
and WebKit. On the host, install the browsers once, then run them:

```sh
cd web
npm install
npx playwright install chromium firefox webkit   # once per Playwright version
npm run e2e                                      # = npx playwright test
npx playwright test --project=firefox            # one browser
npx playwright test e2e/determinism.spec.ts      # one file
```

Playwright starts its own Vite server on port 5199 (after `npm run wasm`), so
`npm run dev` can stay up. That server runs with `ZT_E2E=1`: no file
watching and no HMR, so a write under `web/` during a run (another run's
`npm run wasm`, an edit) never reloads a test's page. Two environment
variables change the server:

- `PW_PORT=5288 npx playwright test` uses another port, for example to run a
  second worktree's tests at the same time. If the port is busy the run fails
  at once (`--strictPort`) instead of testing whatever server is there.
- `PW_REUSE=1` reuses a server already running on that port instead. It skips
  `npm run wasm`, so rebuild the WASM yourself first, and start that server
  with `ZT_E2E=1` (e.g. `ZT_E2E=1 npx vite --port 5288`) or a file change
  can reload the pages under test.

The tests need no network: map tiles, search and Overpass are blocked and the
built-in levels are used (every test fails if a request leaves the machine).
The Docker image has the browsers already, and `./run-all.sh` runs these
tests too.

- `match.spec.ts`: a full 8-wave match on Paris Le Marais (seed 2) through
  the UI: wave 1 lost on purpose and retried, a mulligan, keep choices,
  armament building clicks, a fence drag pulled down again with a click,
  a tactical card clicked mid-wave; a test bot (`e2e/bot.ts`, the
  `sim-headless match` strategy) plays the rest at a test-only "as fast as
  possible" speed. The run record is downloaded from the match result panel
  and must verify with `sim-headless verify` (run through `cargo run
  --release`), with every wave attempt's hash equal to the browser's. About
  25 s in Chromium and WebKit, 1–1.5 min in Firefox.
  `node e2e/bot-check.mts 2` plays the same scenario on WASM under Node in
  a few seconds (useful when the balance changes and seed 2 no longer
  clears it).
- `match-ui.spec.ts`: the HUD and the hand, invalid plays and their
  messages (fence too long, building not revealed, too many buildings,
  mulligan after a play, a tactical card in prep), keep marks, a tactical
  card clicked mid-wave, the fog, and pause/speed leaving the state hash
  unchanged.
- `profile.spec.ts`: the local profile on the Marais: a new profile's
  starter deck, an illegal deck refused by the deck builder and at match
  start, wave 1 won by the bot then abandoned (paid once, a second claim
  pays nothing, the history's record verifies headless), a
  fast-forwarded clear (test hook) with the Veteran and Elite unlocks, the
  Hometown crate, coverage on the map, a crate's stamped cards (no
  street), a deck built with a crate card used in a Veteran match (the
  record's `setup.deck` and multiplier), and place names from fixture
  Nominatim answers. `match.spec.ts` also checks the real clear's claim,
  Veteran unlock, coverage and history.
- `determinism.spec.ts`: runs the native/WASM fixture in each browser and
  compares its hash to `crates/sim-core/tests/fixtures/native_hash.json`.
- `first-session.spec.ts`: the whole loop on a new profile: a place found
  by the search (fixture Nominatim) and marked as hometown, the streamed
  match on fixture Overpass blocks (a village: the Marais buildings within
  150 m of the pin, on the full 1.3 km streamed map), all 8 waves cleared
  (one armament played with real clicks, the test bot for the rest), the payout, the Hometown crate,
  then the match's replay opened from the history with its map bundle and
  run to the end at max speed with every hash check green, and the record
  and bundle verified with `sim-headless verify --chunks`. See
  DECISIONS.md, "Replay viewer and first session (T8)", for its run times.
- `replay.spec.ts`: the replay viewer on the golden run record (a picked
  file, a built-in level, offline): jump to a wave (forward and back),
  step, max speed, every check green, actions refused, the profile
  untouched; a tampered record shows which attempt diverged and both
  hashes; a streamed run without its map asks for the bundle, then
  replays on it.
- `stream.spec.ts`: a picked place's streamed map (first blocks, background
  rings, a slow and then failing block, Retry loading, no re-fetch, the
  cache on a second visit) and its record verified headless.
- `match-review.spec.ts`: the T5 review fixes (pause toggles, selections,
  phase buttons, the inspect panel).

Opening the app with `?test=1` (for example http://localhost:5173/?test=1)
installs the test hook `window.__zt` (version 2: match state snapshots, the
run record, action helpers that send exactly what the UI sends, and
test-only clock controls; see `web/src/testhook.ts`). Without the flag it is
never loaded.

The generated report is committed in [`reports/`](reports/headless-report.md),
so you can read the results without running anything.

## Playing

The loop in one paragraph: on the map screen pick a place (search, a pin,
or a built-in level), then under **Match setup** a deck and a difficulty
(and whether it is your hometown), and **Start here**. Each of the 8 waves
starts with a prep: you draw 5 cards and spend supply on fences and
garrisons, then start the outbreak, play tactical cards while it runs, and
win when no zombie or infected is left (lose under 15% of the wave's
civilians: retry it). Clearing wave 8, or leaving after some progress,
pays resupply tickets once; tickets open crates of stamped cards for the
deck builder, the match goes to the history, and the history replays it
with its hash checks. Step by step:

1. **Map.** Browse the street map, search an address (press Enter) or click
   to drop a pin, then **Start here**. The dashed circle is the play area:
   1.3 km around the pin, wave 8's ring. The two built-in levels (Paris Le
   Marais, Le Vésinet) start without any download. The last place you
   started is remembered.
2. **Loading.** A picked place's buildings come from OpenStreetMap
   (Overpass) in city grid blocks of about 250 m, shared by every place
   that covers them. The match starts as soon as the blocks of waves 1–2
   are in (about 350 m around the pin: "Downloading the map… n / m
   blocks"); the rest loads in the background while you play, closest ring
   first. If you press **Next wave** before the next ring is loaded, a
   banner says "Loading the next district… n / m blocks" and the wave opens
   as soon as it is; if a block can't be downloaded (Overpass busy or
   unreachable after five tries), it says so with a **Retry loading**
   button. Blocks are cached in the browser (IndexedDB): retries, restarts,
   a new seed and later visits to the same area need no download. A place
   with fewer than 40 buildings in its first blocks is refused ("Pick a more
   built-up spot").
3. **The match.** 8 waves at that place. Wave 1 plays a core of 150 m around
   the pin; each wave reveals a ring around it, up to 1.3 km (a built-in
   level's rings are squeezed into its radius).
   The street map stays on screen with street names hidden; the next ring is
   drawn darker (its buildings and streets stay visible, nothing about the
   people there) and everything past it darker still. The **Seed** box
   starts a new match with another seed. **← Map** goes back.
4. **Prep.** Your deck is the one picked under **Match setup** (at first
   the starter deck "Civil Defence Issue", 20 cards). Each prep you draw 5 cards (up to 2 kept from the last wave) and get
   supply (shown in the HUD with the deck and discard counts). The hand is
   at the bottom: name, supply cost, kind, rarity. Click a card, then:
   - **armaments** (Rifles, Mortar…): click buildings; the ones you can arm
     are highlighted, the card plays when you have picked as many as it
     equips (or press **Place** with fewer);
   - **fortifications** (fences): drag a line; while dragging the panel
     shows the placed length (parts on buildings are clipped off) against
     the card's limit, and the cost.
   A refused play says why (for example "fence is 512 m, Light fence allows
   400 m"). **Mulligan** (1 supply, once per wave, before playing a card)
   draws a new hand. **Keep** on a card keeps it for the next wave (up to
   2; without a choice the first two stay). Click a fence or a garrisoned
   building to **Repair** it (cost shown) or **Pull it down** (refund
   shown: the full cost and the card back for something placed in this
   prep, half otherwise). Then **Start wave**.
5. **The wave.** The outbreak starts (its locations are hidden). Only
   **tactical** cards can be played now (Grenades, Paratrooper…): click the
   card, then a point. The HUD shows the wave n/8, civilians, infected and
   zombies, the share saved against the red **15%** line, and the
   civilians' stamina: they tire as the wave goes on (zombies don't), so
   stalling punishes itself. **Pause** (Space) and 1× / 2× / 4× only change
   how fast you watch; they never change the outcome.
6. **Result.** A wave is won when no zombies or infected are left, lost when
   fewer than 15% of its civilians are. The panel shows the saved share and
   the supply earned, with **Next wave**, **Retry wave** (same outbreak,
   same draws) and **Restart match**. After wave 8, the match panel shows
   the retries, the civilians saved and a table per wave, and **Download run
   record** saves the run (seed, deck, every action with its tick, the
   state hash after every wave attempt), which `sim-headless verify`
   replays and checks. On a picked place **Download map** saves the map the
   run used (the shell and its blocks) next to it: `sim-headless verify
   run.json --chunks map.json --shell map.json`.
7. **Profile.** Your profile is kept in this browser (IndexedDB; a warning
   says so when the browser only allows a temporary one). On the map
   screen, **Match setup** picks the deck, the difficulty (only the tiers
   you have unlocked: Veteran after clearing a match on Recruit, and so on;
   a harder tier has more people, its outbreak and fatigue scaling are
   coming later) and **This is my hometown**. A match pays **resupply
   tickets once**: when you clear wave 8 (in the match panel) or when you
   leave it (← Map, New match, another seed or level) after any progress,
   by the furthest wave and the civilians saved, plus a no-retry bonus for
   a clear without retries. Daily rewards add tickets for the day's first
   zombie killed, wave victories (5 a day) and match victories (5 a day).
   Clearing your hometown offers the one-off **Hometown crate**. The
   screens:
   - **Deck builder**: your collection on the left, the deck on the right
     (20 cards; at most 3 copies of a common, 2 of an uncommon, 1 of a rare
     or a legendary, 2 legendaries). The core's rules are checked as you
     edit; an illegal deck can't be saved or used. **Use for matches**
     makes it the active deck. The starter deck can't be changed, only
     copied.
   - **Collection**: every card with its rarity, foil, and its provenance
     stamp (district and city, wave, tier, civilians saved, MVP card,
     date); starter cards are account-bound.
   - **Crates**: one ticket opens a crate of three cards, with its lore
     (where and how it was recovered).
   - **Match history**: every claimed match, with **Replay** and
     **Download run record**.
   - **Progress**: the tiers, the cities you defended (marked
     *provisional* while the city's real area is unknown) and the
     achievements.
   **Show my coverage** draws the cells you defended in cleared matches,
   coloured by the highest tier (Recruit green, Veteran blue, Elite purple,
   Nightmare red). Stamps and the history name a district and a city only,
   from the place search's administrative fields, never a street.

8. **Replay.** **Replay** in the match history, or **Open a replay…** on
   the map screen (drop or pick a run record, plus its map bundle for a
   streamed map), plays a run back in the game view: the worker rebuilds
   the match from the record's seed, deck and multiplier and applies its
   actions on their ticks. The panel on the left has Pause / Play,
   **Step** (one tick), 1×, 4× and **Max**, and **Jump to wave n** (back in
   time rebuilds from the start). Below it, every wave attempt has two
   checks, its prep and its end: grey until reached, green when the state
   hash equals the record's, red with the attempt, the tick and both
   values when it doesn't; the last row checks the end of the record. A
   run on a built-in level replays offline. A streamed run needs its
   blocks: the map bundle ("Download map" in the match panel), or this
   browser's map cache when it still has them all; without either the
   viewer says it needs the bundle. A replay is read-only: no card, no
   claim, no daily reward, nothing written to the profile.

Pan by dragging the map (except while drawing a fence), zoom with the wheel
or the +/− buttons, **Frame level** to re-centre. The debug panel shows the
chase or flee field as a heatmap and the spatial-hash grid.

Colours: civilians blue, infected (1 s before turning) yellow, zombies red
(all with a thin dark rim so they read on the map), garrisons green with
their range, paratroopers and convoys as green dots, fences near-black
turning red as they take damage. A zombie killed by a garrison flashes pale
for 1 s and then stays on the map as a violet corpse.

Speeds: civilians wander at 1.2 m/s and flee at 4.4 m/s; zombies run at
7.5 m/s.

## Results

From the committed [headless report](reports/headless-report.md), regenerated
in T8 with `report --quick` (2 seeds per scenario, no S5, 600-tick
benchmarks, the wave-8 scale bench at 1.3 km only; the full report's scale
bench takes about an hour) on the host, an Apple M1 Pro, one thread.

| Check | Target | Measured | Result |
|---|---|---|---|
| Native p95 tick, 100k agents | ≤ 15 ms | 7.50 ms | PASS |
| Native max tick, 100k agents | ≤ 30 ms | 8.34 ms | PASS |
| WASM (Node) p95 tick, 100k agents | ≤ 25 ms | 9.02 ms | PASS |
| WASM (Node) max tick, 100k agents | ≤ 45 ms | 9.54 ms | PASS |
| Tests (`cargo test --release --workspace`, `wasm-pack test --node`) | all pass | 143/143 | PASS |

(The quick benchmark runs 600 ticks, 30 s of game time, before the
outbreak has spread; the full report's 3,000-tick runs are the stricter
figure, see "Scale (T1, wave-8 size)" in DECISIONS.md.)

- **8-wave match** (`sim-headless match --level paris-marais --seed 1`,
  the starter deck and the scripted defence): all 8 waves won at the first
  try, 9,120 ticks, 5,587 civilians alive at the end; played in 3.9 s
  native; its run record replays in 3.9 s native and 5.2 s in WASM under
  Node.
- **Wave-8 scale** (1.3 km synthetic city, 100k agents): p95 12.9 ms
  native and 16.7 ms WASM per tick, within the browser's 50 ms.
- **Browser**: the first-session E2E clears a streamed 1.3 km match and
  replays it in 1.2–1.5 min in Chromium and WebKit, 5.9 min in Firefox
  (DECISIONS.md, "Replay viewer and first session (T8)").

## How it works

- **`crates/sim-core`**: the whole game. Level rasterization (2 m cells),
  struct-of-arrays agents, a counting-sort spatial hash, Dijkstra flow fields
  with a bucket queue (chase for zombies; threat and a Brogue-style flee field
  for civilians), dormant civilians far from danger updated 1 tick in 4,
  bites, a 1 s infection, separation, wall sliding, towers and fences.
  Deterministic: PCG32, no trig, index-order iteration, FNV-1a state hash.
  `Match` (`match_.rs`) runs the 8-wave loop on top of `Sim`: rings revealed
  wave by wave, newcomers from the new ring's buildings, per-wave outbreaks,
  fatigue, persistent placements, retry / restart, buildings streamed in
  chunks. Every change goes through `Match::apply(Action)` and `step()`.
  Cards (`cards.rs`, data in `cards.json`) are the player's tools: a 20-card
  deck, a hand of 5 per wave (2 can be kept), supply per wave, one
  mulligan, repair and pull-down. Fortifications and armaments are played
  in prep, tactical cards during the wave.
  Run records (`record.rs`) and the replay verifier: `RunRecord::from_match`
  and `replay(record, map)`; the map snapshot hash is `mapsnap.rs`.
  The browser plays the match through `WasmMatch` since T5.
- **`crates/sim-headless`**: tests support, scenarios S1–S5, benchmarks and
  the report writer (SVG charts, no Python).
- **`crates/sim-wasm`**: wasm-bindgen wrapper with no logic of its own:
  `WasmSim` (the single-wave prototype), `WasmMatch` (the 8-wave match:
  JSON actions in, state and the run record out) and `verify_level` /
  `verify_chunks`.
- **`web/`**: the match runs in a Web Worker on a fixed 20 Hz accumulator,
  stepped only while a wave runs (prep and result screens are static). The
  page sends actions (JSON `Action`s) that the worker applies at the next
  tick boundary. It
  publishes positions and states through a triple-buffered SharedArrayBuffer
  (COOP/COEP headers set by Vite). If the page is not cross-origin isolated,
  it posts transferable snapshots instead and shows a "fallback mode" badge.
  The main thread interpolates between the last two ticks and renders with
  deck.gl as an overlay on the MapLibre street map (`@deck.gl/mapbox`).
  Layer data stays in sim meters; a model matrix turns it into lng/lat
  offsets from the level centre, the exact inverse of the level projection.
- **`web/src/replay.ts`, `web/src/ui/replayui.ts`**: the replay viewer:
  the record and its map (built-in level, map bundle or block cache), the
  picker and the panel. The replay itself runs in the worker on
  `WasmMatch.replay_level` / `replay_chunks`, which drive sim-core's
  `Replayer` (the step-by-step form of the verifier: `replay_with` runs
  the same thing to the end).
- **`web/src/explore.ts`**: the map screen (MapLibre GL with OpenFreeMap
  tiles, Nominatim search).
- **`web/src/map/`, `web/src/stream.ts`, `web/src/mapsession.ts`**: the
  streamed map of a picked place: the global block grid, per-block Overpass
  queries, the IndexedDB block cache, the loader (waves 1–2 first, the
  rest in the background), and the glue to the worker's match
  (`Match::new_streaming` + `add_buildings`).
- **`tools/levelgen`**: Overpass → level pack JSON, for the committed
  (built-in) levels only. Committed levels:
  `levels/paris-marais.json` (659 buildings, r = 400 m) and
  `levels/suburb.json` (Le Vésinet, 375 buildings, r = 250 m).
- **`config.default.json`**: every tunable number, read by both the headless
  runner and the browser. **`cards.json`**: the cards (cost, rarity, kind,
  effect numbers), the deck rules and the starter deck, embedded in
  `sim-core` like the config.

Every choice the spec left open is in [DECISIONS.md](DECISIONS.md).
