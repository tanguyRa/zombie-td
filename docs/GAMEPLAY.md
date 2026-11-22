# Gameplay design: game loop and player progression

Agreed in a design interview on 2026-11-22. This is the target design; the
current prototype implements a single **wave** (see README and DECISIONS.md).

## Structure

| Level | What it is |
|---|---|
| **Wave** | One outbreak on the current map: prep, then the outbreak plays out. What the prototype does today. |
| **Match** | 8 waves at one real address. The map, population and outbreak grow each wave. Placements persist across waves. |
| **Meta** | Between matches: a card collection (roguelite/TCG), crates, achievements, a coverage map of places defended, and a player-to-player market. |

## The wave

- **Prep phase**: play fortification and armament cards, repair or pull down
  your structures.
- **Wave phase**: the outbreak starts (locations hidden). Only tactical cards
  can be played.
- **Victory**: no zombies or infected left.
- **Defeat**: fewer than **15%** of the wave's civilians alive.
- **No timeout.** Soft cap: civilians get **tired** and slow down as the wave
  goes on; zombies don't. Stalling punishes itself.

## The match

- **8 waves**, wave 8 is massive. Size target: 10–20 matches clear 75% of
  Paris, so one match covers roughly 4–8 km² (radius ~1.1–1.6 km).
- **Map growth**: wave 1 is a core around the address; each wave reveals a ring.
- **Loading**: the first download covers waves 1–2; the rest streams in the
  background while playing. Queries are cached per city grid block. Retries
  need no reload.
- **Fog**: the next ring is darkened but buildings and roads are clearly
  visible. No information on infection or civilians there.
- **Population** comes from the buildings × an outside multiplier
  (difficulty). Wave population = survivors + newcomers in the new ring. No
  population slider.
- **Outbreaks**: wave 1 random; waves 2–4 always in the new ring; waves 5–8
  mostly in the new ring, with a few inside previous territory.
- **Placements persist** from wave to wave. Broken fences stay broken until
  repaired.
- **Retries are unlimited**: retry the current wave or restart the match. A
  run cleared with no retry earns a bonus.

## Cards in a match

- **Deck**: 20 cards.
- **Hand**: draw 5 before each wave; keep up to 2 unplayed cards into the next
  wave; discard the rest.
- **Cycling**: played cards go to the discard pile (the structure stays on the
  map); the discard is reshuffled when the deck runs out. About 2 passes
  through the deck per match.
- **Mulligan**: once per wave, for a small supply cost.
- **Supply**: a small base income per wave + 1 per N civilians saved (N
  grows each wave). Unspent supply carries over.
- **Upkeep**: repairing fences and pulling down structures (partial refund)
  cost or give supply, without a card.
- **Card phases**: fortifications and armaments in prep only; tactical cards
  during the wave only.

Example cards:

| Card | Kind | Effect |
|---|---|---|
| Light fence | Fortification | 400 m, medium resistance |
| Heavy stockade | Fortification | 100 m, very resistant |
| Rifles | Armament | Equip 3 buildings with rifles |
| Mortar | Armament | Equip 2 buildings with mortars |
| Paratrooper | Tactical | During a wave: a soldier with an assault rifle lands after a 10 s delay |

## Collection

- **No card levels.** A card is equally strong for every player; power comes
  from which cards you own.
- **Rarity**: common, uncommon, rare, legendary.
- **Deck limits**: up to 3 copies of a common, 2 of an uncommon, 1 of a rare;
  legendaries 1 copy each and **at most 2 legendaries per deck**.
- **Unique cards**: every earned card carries a **provenance stamp** (where
  and how it was recovered, difficulty tier) and a cosmetic twist based on the
  population saved and the match's MVP card. Stamps never change stats.
  Stamps name a district or city, never a street.
- **Starter deck "Civil Defence Issue"**: 20 fixed commons/uncommons,
  account-bound (no stamp, can't be traded or salvaged).

## Rewards

- **Crates** ("lost and found military surplus") hold random cards. They are
  **never sold for money**; every crate is earned and carries its own lore
  (where, how).
- **Resupply tickets** open crates. A match pays out **once**: when you clear
  wave 8 or abandon the match, scaled by the furthest wave and civilians saved.
  Retries never pay out on their own; lost matches still pay.
- **Daily-capped rewards**, for example:
  - first blood (first zombie kill of the day)
  - wave victory (5×/day)
  - match victory (5×/day)
- **Long-term achievements**, for example: **city cleared** (75% of a major
  city defended across matches), region and country achievements.
- **Hometown crate**: a one-off crate for clearing your first match at your
  own address (optional).

## Difficulty

- Tiers: **Recruit, Veteran, Elite, Nightmare**, each unlocked by clearing a
  match on the tier below.
- Each tier raises the population multiplier, the number and size of
  outbreak clusters, and civilian fatigue.
- Harder tiers pay **better, not more often**: better crate rarity odds,
  stamps record the tier, daily caps unchanged.
- The coverage map records the highest tier cleared for each place; city
  achievements come in tiers ("Paris cleared — Veteran").

## Market and money

- The market is the **only** place real money is used.
- **Closed wallet at launch** (Steam-like): add money, trade cards for wallet
  credit, no withdrawal. Cash-out through a licensed third party is an option
  for later.
- **Sinks**:
  - a **market fee** (a percentage destroyed on each trade; it's the revenue)
  - **salvage**: sell cards to an NPC group at a deep discount for wallet
    credit, which puts a price floor under the market
- **Access**: buying is open from day one; selling requires one fully cleared
  match.

## Social

- **Leaderboards per city grid block and tier**: most population saved,
  with a no-retry badge.
- **Replays of top runs** from the stored input logs.
- **A shared liberation map** ("Paris is 34% liberated") and **weekly outbreak
  events** in one city, with event-only crate lore.
- **Privacy**: a player's coverage map is private by default (public views
  show only the combined map); hometown matches stay off public leaderboards;
  stamps never show a street or address.
- **Later**: async co-op, last-one-standing in endless waves, other
  multiplayer modes.

## Server side

- Accounts, collections, market and wallet, achievements and daily caps,
  match history with locations cleared, coverage maps, and leaderboards.
- **Run verification**: see Determinism below. The server re-runs the logs
  before it pays rewards.
- Map cache shared per city grid block.

## Determinism (hard requirement)

The whole match is **fully deterministic**: the same inputs replay
**bit-for-bit** the same game any number of times, on any OS, browser, CPU,
or natively on the server. This is the base for replays, leaderboards and
anti-cheat. The server only has to accept or reject the **player's
actions**; every other state comes from re-running the sim.

**A run is exactly:**

1. A **sim version** (code + config/balance hash). A replay always runs on
   the version it was recorded with.
2. A **map snapshot hash**: the content hash of every cached grid block the
   match used. OSM changes over time, so a replay refers to the stored
   snapshot, never to a fresh query.
3. The **deck list** (card ids, with the server's ownership check).
4. The **match seed**, **issued by the server** at match start. Players
   can't pick or reroll seeds to find good draws.
5. An **input log**: every player action with the **sim tick** it applies
   on (placements, card plays, mulligans, repairs, pull-downs, retries).
   Wall-clock time, render speed (1×/2×/4×), pause and frame rate never
   enter the sim.

**Everything random comes from the match seed**: outbreak sites, civilian
spawns, the deck shuffle, draws, reshuffles, mulligans, card effects
(paratrooper landing spot…), wave composition. Each system gets its **own
RNG stream derived from the seed** (seed + stream id), so adding a random
system later never shifts the others. A retry re-runs from the start of the
wave with the same streams, so you get the same draws and outbreaks, not a
reroll.

**Rules for the sim code** (already followed by the prototype, see
DECISIONS.md):

- f32 with no FMA contraction, no trig, `sqrt` only, PCG32, iteration in
  index order, no hash-map iteration order, no threads that affect results.
- **Map streaming must never affect the sim**: a ring has to be fully
  loaded before the wave that reveals it starts. If it isn't, the game
  waits in prep rather than starting on partial data.
- The UI never changes sim state directly; it only queues actions for a
  tick.

**Verification:**

- The client sends the run (items 1–5) plus its **state hash at the end of
  each wave**. The server replays it natively and compares. A mismatch means
  the run is rejected, and the first mismatching wave shows where.
- The server also checks each action is legal: the card was in hand, enough
  supply, the right phase (prep or wave), a placement inside revealed
  territory.
- Rewards, leaderboard entries and stamps are only granted after a
  successful replay.
- Crate contents are rolled **on the server** with its own RNG, not the
  match seed, since crates aren't part of the replay.

**Tests to keep:** the existing native = WASM hash fixture, extended to a
full 8-wave match with card plays, and run in **Chrome, Firefox and Safari**
(today it's only checked in WASM under Node).

## Risks and open questions

1. **Scale.** Wave 8 at ~1.1–1.6 km radius on the 2 m grid
   (`cell_size_m`) is ~1.5–2.5M cells vs ~360k today, with chase/flee fields
   recomputed every few ticks, and possibly >100k agents in dense cities.
   Needs an early benchmark spike: coarser cells for far areas, recomputing
   fields only where agents are active, keeping inactive rings dormant.
2. **Legal review** of the wallet, the market, and earned random crates with
   tradeable real-money value, per launch country. Required before the
   market ships, more so if cash-out (C) is added.
3. **Bots and farming.** Daily caps, the account-bound starter deck, the sell
   gate and server-side replay checks limit it; still needs monitoring and
   rate limits.
4. **Economy tuning**: crate rates, salvage price vs market prices, fee
   percentage, supply per civilian, fatigue curve.
5. **Coverage unit**: how "defended ground" is measured (buildings vs grid
   cells) and what "75% of a major city" is measured against (an
   administrative boundary from OSM).

## Suggested build order

1. **Scale spike**: benchmark a wave-8-sized area; decide on grid and field
   strategy.
2. **Match loop, offline**: 8 waves, ring reveal, persistence, fatigue,
   win/defeat rules, retries.
3. **Cards in the match**: deck, hand, supply, discard, mulligan, phases,
   repair and pull-down; a hardcoded starter deck; tactical cards in the
   input log.
4. **Streaming map loading** and the per-block cache.
5. **Backend v1**: accounts, collection, crates and tickets, daily rewards,
   match history, run verification.
6. **Difficulty tiers, coverage map, achievements**.
7. **Leaderboards, replays, liberation map, events**.
8. **Market + closed wallet + salvage** (after legal review).
9. **Later**: cash-out, co-op and multiplayer modes.
