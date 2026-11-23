# Implementation plan: gameplay v1

Goal: take the single-wave prototype to the game described in
[GAMEPLAY.md](GAMEPLAY.md), **ready for live browser testing**. Every task is
tested **headless** (cargo tests and the `sim-headless` CLI) and **in the
browser** (Playwright end-to-end tests in Chromium, Firefox and WebKit).

Branch: `gameplay-v1`. One commit (or a few) per task; each task leaves
`main`-quality code with every test green.

## Scope

In scope for v1 (playable and testable locally):

- The 8-wave match loop, cards, deck, supply, fatigue, retries.
- Run records (seed + actions), the replay verifier, determinism tests across
  native, Node WASM and three browsers.
- Streaming map loading with a per-block cache.
- The meta layer **as a local profile** behind a `ProfileService` interface:
  collection with stamped unique cards, starter deck, deck builder, crates and
  tickets, the per-match payout, daily-capped rewards, difficulty tiers,
  coverage map and achievements. A server will later replace the local
  implementation behind the same interface.
- A replay viewer.

Out of scope for v1 (needs a backend and/or legal review): accounts, the
server, the market and wallet, salvage for credit, public leaderboards,
liberation map, events, multiplayer. Design the interfaces so they can be
added, but don't build them.

## Ground rules for every task

- **Determinism is a hard requirement** (GAMEPLAY.md, "Determinism"). All
  randomness comes from the match seed through per-system PCG32 streams
  (`Pcg32::new(seed, stream_id)`, a named constant per system). f32, no FMA
  contraction, no trig, no hash-map iteration order, index-order loops. The UI
  never mutates sim state directly; it sends actions applied on a tick.
- All game logic lives in `sim-core`. `sim-wasm` only marshals. The browser
  only renders and sends actions.
- Tunable numbers go in `config.default.json` (or a new data file such as
  `cards.json`), not in code.
- Keep `DECISIONS.md` updated with every non-obvious choice (one bullet
  each, in the existing style).
- Tests to keep green at the end of every task:
  - `cargo test --release --workspace`
  - `wasm-pack test --node --release crates/sim-wasm`
  - `cd web && npm run typecheck`
  - `cd web && npx playwright test` (from T0 on)
- The host has cargo, wasm-pack (with the wasm32 target) and Node 22, so
  commands can run without `./dev.sh`. Docker must also keep working
  (`./run-all.sh`).
- Browser tests must not hit the network: use the committed levels in
  `levels/` and fixture Overpass responses served through Playwright request
  routing.

## Tasks

### T0. Browser test harness

- Add Playwright (pinned version) to `web/` with projects for Chromium,
  Firefox and WebKit. Add `npm run e2e`. Vite serves the app for tests
  (`webServer` in the Playwright config; WASM built beforehand).
- Add a **test hook**: when the page is opened with `?test=1`, expose
  `window.__zt` with read-only state (phase, tick, stats, state hash, current
  screen) and helpers that send the same actions the UI sends. Tests use real
  UI clicks where practical, and the hook for setup and assertions.
- Block real network in tests (route `overpass*` and tile servers to
  fixtures or empty responses). The map tiles must not be needed for tests to
  pass.
- Tests:
  - a smoke test: start a built-in level, place a tower and a fence through
    the UI, start, run to the end at 4×, check the result panel.
  - a **cross-browser determinism test**: run the existing fixture
    (`crates/sim-core/src/fixture.rs`, hash in
    `crates/sim-core/tests/fixtures/native_hash.json`) in each browser and
    compare the hash to native.
- Update the Dockerfile so `run-all.sh` also runs the Playwright tests
  (`npx playwright install --with-deps`), and add it to `run-all.sh`.
- Done when: `npx playwright test` is green in all three browsers on the
  host, and the README says how to run it.

### T1. Scale spike (wave-8 size)

- Wave 8 covers a radius of about 1.1–1.6 km (GAMEPLAY.md, "The match"). On
  the 2 m grid that is ~1.5–2.5M cells (~360k today), possibly over 100k
  agents in dense places. The 100k-agent p95 tick already misses the targets
  at 600 m (`reports/headless-report.md`: native 21 ms, WASM 26 ms).
- Measure with a synthetic level of the right size (`level::grid_city`) and,
  if possible, a real dense one: field recompute cost, tick p95, memory, at
  20k / 50k / 100k / 150k agents.
- Then implement what is needed to keep a 1.3 km radius playable at 1× in
  the browser worker (tick ≤ 50 ms p95 in WASM at the wave-8 population
  chosen), and pick the **wave-8 radius and population caps** that fit.
  Options to consider: recompute flow fields only inside a bounding box of
  active agents, keep dormant regions frozen, cheaper separation, a coarser
  cell size only if nothing else works. Any optimisation must keep the state
  hash identical between native and WASM (update the fixture hash only if the
  rules change, and say so in DECISIONS.md).
- Add a `sim-headless bench --scale` mode and a section in the report.
- Done when: the chosen caps are in `config.default.json`, documented in
  DECISIONS.md with the measurements, and all tests are green.

### T2. The match loop in sim-core

New `Match` type (in `sim-core/src/match_.rs` or similar) that owns the sim
and runs **8 waves**. All changes to it go through one entry point,
`Match::apply(Action) -> Result<(), ActionError>`, plus `step()`; the action
enum is serde-serialisable (it becomes the input log in T4).

- **Rings**: the playable radius for each wave comes from config (wave 1 core
  ≈150 m, growing to the T1 wave-8 cap). Cells outside the current radius are
  walls for agents and fields. The grid is sized for the final radius from
  the start.
- **Buildings can be added later**: `Action::ExtendLevel` is not a player
  action; instead `Match::add_buildings(chunk)` may be called while in prep,
  only for area not yet revealed, and the match refuses to start a wave whose
  ring isn't loaded (`Match::ring_ready(wave)`). Headless tests add everything
  at the start. Chunks are applied in a canonical order (sorted by block id)
  so the result never depends on arrival order.
- **Population**: agent arrays sized for the whole match up front; agents not
  yet in play are in a new state `ABSENT` (render state 4, already reserved).
  Newcomers per ring come from building footprints × `population_multiplier`.
  Survivors stay where they are.
- **Phases per wave**: `Prep` → `Running` → `WaveWon` | `WaveLost` → next
  wave's `Prep`, or `MatchWon` after wave 8.
  - Victory: no zombies and no infected left.
  - Defeat: civilians < 15% of the wave's starting civilians (config).
  - No timeout. **Fatigue**: civilian speeds are multiplied by a factor that
    decreases with time since the wave started (curve in config); zombies
    unaffected.
- **Outbreaks** per wave (count and size grow, from config): wave 1 random;
  waves 2–4 always in the newly revealed ring; waves 5–8 mostly in the new
  ring, `inner_outbreaks[wave]` inside earlier territory.
- **Placements persist**; broken fence cells stay broken.
- **Retries**: `Action::RetryWave` (back to the start of the current wave's
  prep) and `Action::RestartMatch`. Implement with a snapshot of the whole
  match state taken at each wave's prep start (`Clone`). Retries count in a
  `retries` stat (for the no-retry bonus).
- **RNG streams**: a named stream per system (spawn, outbreak per wave,
  wander, deck, card effects…), derived from the match seed and the wave
  number, so a retry replays the same outbreaks and draws.
- Keep the existing single-wave `Sim` API working for the current tests and
  report, or migrate those tests to a 1-wave match. Don't delete coverage.
- Temporary tools until T3: keep today's tower/fence budgets per wave so the
  loop is playable headless.
- Tests (headless): ring reveal walls; ABSENT agents never move or get bitten;
  newcomer spawn counts; win/lose thresholds; fatigue slows civilians only;
  outbreak placement rules per wave; persistence across waves; retry
  restores the exact state hash of the earlier prep; restart; same seed +
  same actions ⇒ same hashes; `sim-headless match --level paris-marais --seed
  N` runs 8 waves with a simple scripted defence and prints a per-wave table.

### T3. Cards, deck and supply in sim-core

- `cards.json` (data file, embedded like the config): id, name, rarity,
  kind (`fortification` | `armament` | `tactical`), supply cost, parameters.
  v1 card list: Light fence (400 m, medium hp), Heavy stockade (100 m, very
  high hp), Rifles (3 buildings, today's tower), Mortar (2 buildings, slower,
  area damage, minimum range), Paratrooper (tactical: a soldier with an
  assault rifle lands at a point after 10 s), plus enough commons and
  uncommons to make the 20-card starter deck "Civil Defence Issue" and a few
  rares and legendaries for the collection (e.g. Sniper nest, Airstrike,
  Napalm, Armored convoy). Keep effects simple and data-driven.
- **Deck rules**: 20 cards; at most 3 copies of a common, 2 of an uncommon,
  1 of a rare; legendaries 1 copy each and at most 2 legendaries per deck.
  `validate_deck()` with clear errors.
- **In the match**: shuffle the deck from the deck RNG stream; draw 5 per
  wave; keep up to 2 unplayed cards; discard the rest; played cards go to
  the discard; reshuffle the discard when the deck runs out; one mulligan
  per wave for a supply cost.
- **Supply**: base income per wave + 1 per N civilians saved in the last
  wave (N per wave in config); unspent supply carries over.
- **Phases**: fortification and armament only in prep, tactical only while
  running. Actions: `PlayCard { hand_index, target }` where target is a
  building, a polyline or a point; `Mulligan`; `Repair { fence_id }` and
  `PullDown { placement_id }` for supply, no card.
- Replace the T2 temporary budgets with cards.
- Tests: every deck rule; draw/keep/discard/reshuffle sequence is
  deterministic and correct over 8 waves; supply math; phase restrictions
  rejected with the right error; each card's effect (mortar splash and
  minimum range, stockade hp, paratrooper delay and shooting); repair and
  pull-down refunds; a headless scripted match with the starter deck.

### T4. Run records, replay verifier, determinism

- `RunRecord` (serde JSON): sim version (crate version + git hash at build
  if available), **config hash and cards hash**, **map snapshot hash**
  (canonical hash of all building chunks used), deck list, difficulty,
  match seed, the action log (`(tick, Action)` in order, including retries),
  and the **state hash at the end of each wave**.
- `Match` records its own log; `RunRecord::from_match()`;
  `replay(record, level) -> Result<ReplaySummary, VerifyError>` that rejects
  illegal actions and hash mismatches (and says which wave first diverged).
- CLI: `sim-headless verify <run.json> --level <level.json>` and
  `sim-headless match ... --record out.json`.
- Determinism tests:
  - native: record a full scripted 8-wave match with card plays, a retry
    and a mulligan; replay it 3 times; all hashes equal.
  - native = WASM under Node for the same record (extend
    `crates/sim-wasm/tests`).
  - tampering tests: changed action, changed tick, card not in hand, wrong
    phase, edited wave hash ⇒ rejected with the right error.
  - commit a golden run record fixture whose hashes must never change
    without a deliberate version bump.

### T5. Browser: match flow and cards

- WASM bindings and worker protocol for `Match`: actions, per-wave phase,
  hand, supply, deck/discard counts, wave number, ring radius, fatigue,
  retries, and the run record export.
- UI:
  - wave HUD (wave n/8, phase, civilians/zombies, % saved vs the 15% line,
    fatigue indicator, supply);
  - the **hand** as cards at the bottom (name, cost, kind, rarity), with
    play targeting: building click (armaments), line drag (fortifications),
    point click (tactical, during the wave only); invalid plays explain why;
  - mulligan, repair (click a damaged fence), pull-down;
  - **fog**: the next ring drawn darker, buildings and roads visible, no
    agents shown in it;
  - wave result panel (won/lost, saved, supply earned) with Next wave,
    Retry wave, Restart match; match result panel (8 waves cleared, retries,
    total saved);
  - pause, speed 1×/2×/4× still work (they never affect sim state).
- Starter deck is used until T7 adds the deck builder.
- E2E tests (all three browsers): play a full match on a committed level with
  a scripted sequence of card plays through the UI, including a mulligan, a
  tactical card mid-wave, a lost wave and a retry; at the end, export the run
  record from the page and check it **verifies headless** (the test calls
  the native verifier or a Node WASM verifier) with equal per-wave hashes.

### T6. Streaming map loading and block cache

- Split the area around the address into fixed **city grid blocks** (e.g.
  250 m tiles in a projection anchored on a global grid, so different
  addresses share blocks). One Overpass query per missing block (or per
  batch), cached in IndexedDB keyed by block id, with the fetch date.
- First load: blocks for waves 1–2. Then the rest in the background,
  closest ring first, feeding `add_buildings` while in prep. If a ring isn't
  ready when the player presses Start, show "Loading the next district…" and
  start as soon as it is.
- Retry and restart never re-fetch. The map snapshot hash in the run record
  covers exactly the blocks used.
- Port the grow-the-radius logic in `web/src/levelgen.ts` and the Python
  tool to the block model, or retire it with a note in DECISIONS.md.
  (Done in T6b: `levelgen.ts` is retired, deleted, in favour of the fixed
  ring radii; the Python tool stays for the committed levels only. See
  DECISIONS.md, "Streaming map (T6b)".)
- Tests: unit tests for block ids and projection (Node), headless test that
  the same blocks added in a different order give the same hash and state,
  E2E with fixture Overpass responses per block (routed): first load
  requests only waves 1–2 blocks, the rest arrive later, a second visit is
  served from the cache with zero requests, a slow block delays the wave
  start correctly.

### T7. Meta layer (local profile)

- `ProfileService` interface in `web/src/profile/` with a local
  implementation (IndexedDB). Everything the future server will own goes
  through it.
- **Collection**: unique card instances (instance id, card id, provenance
  stamp: district/city name (never a street), wave/difficulty, population
  saved, MVP card, date, foil flag). The starter deck is account-bound (no
  stamp, not salvageable or tradeable).
- **Deck builder** screen with validation from the core (`validate_deck`
  exposed through WASM).
- **Rewards**: one payout per match (when wave 8 is cleared or the match is
  abandoned), scaled by the furthest wave and civilians saved, in resupply
  tickets; no-retry bonus. **Daily caps**: first blood, wave victory (5/day),
  match victory (5/day), stored per local day.
- **Crates**: tickets open crates whose lore names where and how they were
  recovered; contents rolled with a non-match RNG (crates aren't part of
  replays); rarity odds by difficulty tier. A Hometown crate once.
- **Difficulty tiers** Recruit/Veteran/Elite/Nightmare (config multipliers),
  unlocked by clearing a match on the tier below.
- **Coverage map**: defended area per cleared match (cells of a coarse
  global grid inside the wave-8 radius), highest tier per cell, shown on the
  map screen; city achievements by city name (from the place search) with
  the city's area from OSM if available, otherwise a documented placeholder.
- **Match history** with the run records.
- Tests: Node unit tests for the profile logic (payout once per match, daily
  caps across a day boundary, unlock rules, crate odds over many rolls with
  a fixed seed, stamps never contain a street); E2E: new profile has the
  starter deck, finish a match ⇒ tickets granted once, open a crate ⇒ new
  stamped card in the collection, build a valid deck and use it in a match,
  invalid deck refused, tier unlock, coverage shown on the map.

### T8. Replay viewer, polish, hand-back

- Replay viewer: open a run from match history (or a dropped JSON file) and
  play it back at any speed, with the per-wave hashes checked live.
- Update README (how to play the new loop, how to run all tests),
  `run-all.sh`, the headless report (add a section for an 8-wave match and
  the scale bench).
- A full E2E "first session" test: new profile, hometown match on a fixture
  level, play 8 waves, open the crate, view the replay.
- Done when: `./run-all.sh` is green from a clean checkout and the game is
  ready for live browser testing.

## Order and dependencies

T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8, one at a time. They mostly
touch the same files (`sim.rs`, the worker, `main.ts`), so they don't run in
parallel. After each task, the main session reviews the diff and reruns all
tests before the next one starts.
