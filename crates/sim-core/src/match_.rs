//! The 8-wave match: rings that grow every wave, newcomers, outbreaks per
//! wave, fatigue, persistence, retries. Owns a `Sim` and drives it wave by
//! wave. Every change goes through `Match::apply(Action)`; time goes through
//! `Match::step()`. See DECISIONS.md, "Match".

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::cards::{CardDb, CardDef, CardKind, DeckError, Effect, Rarity, TargetKind};
use crate::config::Config;
use crate::grid::{Grid, BUILDING, FENCE, WALK, WALL};
use crate::level::{Building, LevelPack};
use crate::rng::Pcg32;
use crate::sim::{AreaEffect, Clock, GamePhase, NoClock, Outcome, Sim, Tower, CIVILIAN, DEAD};

/// Waves in a match.
pub const WAVES: u8 = 8;

/// RNG streams. Each system draws from `Pcg32::new(match seed, stream(system,
/// wave))`, so a system never shifts another one and a retry replays the
/// same draws. Ids are fixed forever (changing one changes every run).
pub mod streams {
    /// Newcomer placement when a ring is revealed.
    pub const SPAWN: u64 = 1;
    /// Outbreak cluster seeds.
    pub const OUTBREAK: u64 = 2;
    /// Civilian random walk while the wave runs.
    pub const WANDER: u64 = 3;
    /// Cosmetic random walk during prep (reset at Start, never affects play).
    pub const PREP_WANDER: u64 = 4;
    /// Deck shuffle, draws and reshuffles (T3).
    pub const DECK: u64 = 5;
    /// Card effects, e.g. a paratrooper's landing spot (T3).
    pub const CARD_EFFECTS: u64 = 6;

    const TAG: u64 = 0x6d61_7463; // "matc"

    /// The PCG32 stream id of `system` in `wave` (1-based; 0 for match-wide).
    pub const fn stream(system: u64, wave: u8) -> u64 {
        (TAG << 24) | (system << 8) | wave as u64
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Placements allowed; agents wander cosmetically.
    Prep,
    /// The outbreak plays out.
    Running,
    /// No zombies or infected left (waves 1-7).
    WaveWon,
    /// Civilians fell below the defeat line: retry or restart.
    WaveLost,
    /// Wave 8 won.
    MatchWon,
}

/// What a card is played on. Serialised externally tagged:
/// `{"buildings": [3, 4]}`, `{"polyline": [[x, y], ...]}`, `{"point": [x, y]}`
/// (sim coordinates).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    /// Building indices (armaments: up to the card's count, distinct).
    Buildings(Vec<u32>),
    /// A polyline (fences, convoy routes).
    Polyline(Vec<[f32; 2]>),
    /// A point (paratroopers, strikes).
    Point([f32; 2]),
}

impl Target {
    pub fn kind(&self) -> TargetKind {
        match self {
            Target::Buildings(_) => TargetKind::Buildings,
            Target::Polyline(_) => TargetKind::Polyline,
            Target::Point(_) => TargetKind::Point,
        }
    }
}

/// Everything a player (or a replay) can do to a match. Serialised as
/// `{"type": "play_card", "hand_index": 0, "target": {"point": [1, 2]}}`
/// etc.; it is the input log. Coordinates are sim coordinates (meters from
/// the grid origin).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// Play the card at `hand_index` on `target` (pays its supply cost).
    /// Fortifications and armaments in prep, tactical cards while running.
    PlayCard { hand_index: u32, target: Target },
    /// Prep only, once per wave, before any card is played: as many cards
    /// are drawn as the hand holds (the discard is reshuffled if the deck
    /// runs short), then the old hand goes to the bottom of the deck
    /// (`mulligan_cost`).
    Mulligan,
    /// Choose which unplayed cards (at most `hand_keep`) stay in hand for the
    /// next wave; the rest are discarded when its prep opens. Without a
    /// choice this wave, the first `hand_keep` cards of the hand stay; an
    /// empty list is a choice (keep nothing). The last choice counts.
    KeepCards { hand_indices: Vec<u32> },
    /// Prep only: restore a fence structure to full hp (broken cells too)
    /// for supply.
    Repair { fence_id: u32 },
    /// Prep only: remove a structure. One placed during this prep refunds
    /// its full cost and its card returns to the hand; older ones refund
    /// part of the cost.
    PullDown { placement_id: u32 },
    /// Prep -> Running.
    StartWave,
    /// WaveWon -> next wave's Prep (reveals the next ring).
    NextWave,
    /// Back to the start of the current wave's prep (same outbreak, same draws).
    RetryWave,
    /// Back to wave 1's prep, rebuilt from the initial inputs.
    RestartMatch,
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Action::PlayCard { .. } => "play_card",
            Action::Mulligan => "mulligan",
            Action::KeepCards { .. } => "keep_cards",
            Action::Repair { .. } => "repair",
            Action::PullDown { .. } => "pull_down",
            Action::StartWave => "start_wave",
            Action::NextWave => "next_wave",
            Action::RetryWave => "retry_wave",
            Action::RestartMatch => "restart_match",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum ActionError {
    /// The action is not allowed in this phase.
    WrongPhase { action: String, phase: Phase },
    /// The next wave's ring has not been fully loaded (`add_buildings`).
    RingNotLoaded { wave: u8 },
    /// The building does not exist or is outside the revealed area.
    NotRevealed { building: u32 },
    /// The placement itself was refused (geometry, fence too long...).
    Placement { reason: String },
    /// No card at this hand index.
    NoSuchCard { hand_index: u32 },
    /// Fortifications and armaments are played in prep, tactical cards while
    /// the wave runs.
    CardWrongPhase { card: String, kind: CardKind, phase: Phase },
    NotEnoughSupply { need: u32, have: u32 },
    /// The target is not of the kind the card needs.
    WrongTarget { card: String, expected: TargetKind },
    /// More buildings than the card equips.
    TooManyBuildings { card: String, max: u32 },
    AlreadyGarrisoned { building: u32 },
    /// A point (or route point) outside the revealed area.
    OutsideRevealed,
    /// One mulligan per wave.
    MulliganUsed,
    /// The mulligan is only allowed before any card is played this prep.
    MulliganAfterPlay,
    EmptyHand,
    /// More cards marked to keep than `hand_keep`.
    TooManyKept { max: u32 },
    /// The same hand index twice.
    DuplicateIndex { hand_index: u32 },
    /// No structure with this id.
    NoSuchStructure { placement_id: u32 },
    /// No fence structure with this id.
    NoSuchFence { fence_id: u32 },
    /// The fence has no damage.
    NothingToRepair { fence_id: u32 },
}

impl std::fmt::Display for ActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ActionError::WrongPhase { action, phase } => write!(f, "{action} is not allowed during {phase:?}"),
            ActionError::RingNotLoaded { wave } => write!(f, "the district of wave {wave} is still loading"),
            ActionError::NotRevealed { building } => write!(f, "building {building} is not in the revealed area"),
            ActionError::Placement { reason } => write!(f, "{reason}"),
            ActionError::NoSuchCard { hand_index } => write!(f, "no card at hand position {hand_index}"),
            ActionError::CardWrongPhase { card, kind, phase } => {
                let when = if *kind == CardKind::Tactical { "during a wave" } else { "during prep" };
                write!(f, "{card} is a {kind:?} card: it can only be played {when}, not during {phase:?}")
            }
            ActionError::NotEnoughSupply { need, have } => write!(f, "needs {need} supply, you have {have}"),
            ActionError::WrongTarget { card, expected } => write!(f, "{card} must target {expected:?}"),
            ActionError::TooManyBuildings { card, max } => write!(f, "{card} equips at most {max} buildings"),
            ActionError::AlreadyGarrisoned { building } => write!(f, "building {building} already has a garrison"),
            ActionError::OutsideRevealed => write!(f, "the target is outside the revealed area"),
            ActionError::MulliganUsed => write!(f, "only one mulligan per wave"),
            ActionError::MulliganAfterPlay => write!(f, "mulligan only before playing a card"),
            ActionError::EmptyHand => write!(f, "the hand is empty"),
            ActionError::TooManyKept { max } => write!(f, "keep at most {max} cards"),
            ActionError::DuplicateIndex { hand_index } => write!(f, "hand position {hand_index} listed twice"),
            ActionError::NoSuchStructure { placement_id } => write!(f, "no structure {placement_id}"),
            ActionError::NoSuchFence { fence_id } => write!(f, "no fence {fence_id}"),
            ActionError::NothingToRepair { fence_id } => write!(f, "fence {fence_id} is not damaged"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchError {
    InvalidConfig(String),
    /// The level has neither `radius_m` nor `bounds`.
    NoPlayArea,
    /// `new_streaming` needs a level without buildings (they come in chunks).
    LevelHasBuildings,
    DuplicateBlock(u64),
    /// The chunk's bounds are not finite, inverted or narrower than one cell
    /// (`cell_size_m`) on an axis, or a building has a non-finite coordinate
    /// or floor count.
    BadChunk(u64),
    /// The chunk touches the already revealed area (it had to arrive earlier).
    AreaRevealed(u64),
    /// A building sticks out of its block by more than `block_margin_m` (on
    /// either axis).
    BuildingOutsideBlock { block_id: u64, building_id: u64 },
    /// Wave 1's ring is not covered by the initial chunks.
    RingNotLoaded(u8),
    /// The deck breaks the deck rules (`CardDb::validate_deck`).
    InvalidDeck(Vec<DeckError>),
}

impl std::fmt::Display for MatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Buildings of one map block, added with `Match::add_buildings`.
/// Coordinates are level-local meters (like `LevelPack`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildingChunk {
    pub block_id: u64,
    /// The area this block covers, `[min_x, min_y, max_x, max_y]`: once
    /// added, it counts as loaded for `ring_ready`. Blocks must tile the
    /// plane without overlapping, each building in one block; buildings may
    /// stick out by up to `match.block_margin_m`.
    pub bounds: [f32; 4],
    pub buildings: Vec<Building>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MatchSetup {
    pub seed: u64,
    /// Civilians per unit of building weight (difficulty scales it).
    pub population_multiplier: f32,
    /// The deck (card ids). Its order is the order before the first shuffle.
    pub deck: Vec<String>,
}

impl MatchSetup {
    /// The config's base multiplier and the starter deck.
    pub fn new(seed: u64, cfg: &Config) -> MatchSetup {
        MatchSetup { seed, population_multiplier: cfg.match_.population_multiplier, deck: CardDb::default_cards().starter_deck_ids() }
    }
    pub fn with_deck(mut self, deck: Vec<String>) -> MatchSetup {
        self.deck = deck;
        self
    }
}

/// A card in hand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HandCard {
    /// Index in `CardDb::cards`.
    card: u16,
    /// Marked by `KeepCards` to stay for the next wave.
    keep: bool,
}

/// A hand card as the UI sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HandCardView {
    pub hand_index: u32,
    pub card: String,
    pub name: String,
    pub kind: CardKind,
    pub rarity: Rarity,
    pub cost: u32,
    pub target: TargetKind,
    /// Marked to stay for the next wave.
    pub keep: bool,
    /// Right phase and enough supply now (the target is checked on play).
    pub playable: bool,
}

/// Something a card left on the map. Ids are unique within a match (never
/// reused, also across retries since a retry restores the counter).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Structure {
    pub id: u32,
    pub card: String,
    /// The card's supply cost (refunds and repairs scale with it).
    pub cost: u32,
    /// The wave whose prep placed it.
    pub wave: u8,
    pub kind: StructureKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StructureKind {
    /// Fence cells this structure built (a later fence over a broken cell
    /// takes it over), each with `cell_hp` when intact. `taken_over`: the
    /// broken cells it took from older fences, given back on pull-down.
    Fence {
        cells: Vec<u32>,
        cell_hp: f32,
        length_m: f32,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        taken_over: Vec<TakenCell>,
    },
    Garrison { buildings: Vec<u32> },
}

/// A broken fence cell a newer fence took over from an older one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TakenCell {
    pub cell: u32,
    /// Id of the structure that owned it.
    pub from: u32,
    /// Its position in that structure's `cells` before the takeover.
    pub index: u32,
}

/// Supply granted when a prep opened.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupplyIncome {
    /// `supply_start` (wave 1 only) + `supply_base_income`.
    pub base: u32,
    /// +1 per `supply_civilians_per_point` civilians saved in the last wave.
    pub civilians: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WaveResult {
    pub wave: u8,
    pub won: bool,
    /// Ticks the wave ran.
    pub ticks: u32,
    pub radius_m: f32,
    /// Civilians added when this wave's ring was revealed.
    pub newcomers: u32,
    /// Civilians at Start (survivors + newcomers), before the outbreak.
    pub start_civilians: u32,
    pub end_civilians: u32,
    pub zombies_killed: u32,
    pub bites: u32,
    pub fence_cells_broken: u32,
    pub outbreak_clusters: u32,
    /// Supply this wave earned for the next prep (base income + civilians
    /// saved); 0 if lost or the last wave.
    pub supply_earned: u32,
    /// Cards played during this wave (prep and running).
    pub cards_played: u32,
    /// `Match::state_hash` at the start of this wave's prep.
    pub start_hash: u64,
    /// `Match::state_hash` after the tick that ended the wave.
    pub end_hash: u64,
}

impl WaveResult {
    /// Share of the wave's starting civilians still civilians at the end.
    pub fn saved(&self) -> f32 {
        if self.start_civilians == 0 {
            0.0
        } else {
            self.end_civilians as f32 / self.start_civilians as f32
        }
    }
}

/// An accepted action and the match tick it was applied on (`Match::tick`:
/// steps done before it).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoggedAction {
    pub tick: u64,
    pub action: Action,
}

struct StoredChunk {
    chunk: BuildingChunk,
}

/// Hand, deck, discard, supply and structures (part of `MatchState`).
#[derive(Clone)]
struct CardState {
    supply: u32,
    hand: Vec<HandCard>,
    /// Draw pile; the next card is the last element.
    deck: Vec<u16>,
    discard: Vec<u16>,
    /// `DECK` stream of the current wave (shuffles), re-created at each prep.
    deck_rng: Pcg32,
    /// `CARD_EFFECTS` stream of the current wave, re-created at Start.
    effects_rng: Pcg32,
    mulligan_used: bool,
    /// `KeepCards` was applied since this prep opened (the keep marks are
    /// the player's choice, even if none is set).
    keep_chosen: bool,
    /// Cards played since this prep opened (pull-downs of same-prep plays
    /// take theirs back).
    played_this_prep: u32,
    played_this_wave: u32,
    structures: Vec<Structure>,
    next_structure_id: u32,
    income: SupplyIncome,
    reshuffles: u32,
}

impl CardState {
    fn new(deck: Vec<u16>, seed: u64) -> CardState {
        CardState {
            supply: 0,
            hand: Vec::new(),
            deck,
            discard: Vec::new(),
            deck_rng: Pcg32::new(seed, streams::stream(streams::DECK, 0)),
            effects_rng: Pcg32::new(seed, streams::stream(streams::CARD_EFFECTS, 0)),
            mulligan_used: false,
            keep_chosen: false,
            played_this_prep: 0,
            played_this_wave: 0,
            structures: Vec::new(),
            next_structure_id: 1,
            income: SupplyIncome::default(),
            reshuffles: 0,
        }
    }

    /// Fisher-Yates from the deck stream.
    fn shuffle_deck(&mut self) {
        for i in (1..self.deck.len()).rev() {
            let j = self.deck_rng.below(i as u32 + 1) as usize;
            self.deck.swap(i, j);
        }
    }

    /// Draw `n` cards; when the deck runs out the discard is shuffled into it.
    fn draw(&mut self, n: u32) {
        for _ in 0..n {
            if self.deck.is_empty() {
                if self.discard.is_empty() {
                    return;
                }
                std::mem::swap(&mut self.deck, &mut self.discard);
                self.shuffle_deck();
                self.reshuffles += 1;
            }
            let card = self.deck.pop().expect("deck not empty");
            self.hand.push(HandCard { card, keep: false });
        }
    }
}

/// One direct change to the card state (`Match::debug_edit_cards`).
#[doc(hidden)]
#[derive(Clone, Copy, Debug)]
pub enum DebugCardEdit {
    Supply(u32),
    /// Swap two positions (raw indices; the deck's next card is the last).
    SwapHand(usize, usize),
    SwapDeck(usize, usize),
    SwapDiscard(usize, usize),
    Keep(usize, bool),
    KeepChosen(bool),
    MulliganUsed(bool),
}

/// The game state a retry restores (everything but the inputs).
#[derive(Clone)]
struct MatchState {
    sim: Sim,
    wave: u8,
    phase: Phase,
    /// Geometry of every cell with all applied buildings (`WALK`,
    /// `BUILDING`, `WALL`), ignoring rings and fences.
    base: Vec<u8>,
    /// Block ids applied to the grid, in application order.
    applied: Vec<u64>,
    newcomers: u32,
    wave_start_civilians: u32,
    /// Sim counters at Start (killed, bites, fence cells broken).
    counters0: [u32; 3],
    outbreak_sites: Vec<[f32; 2]>,
    start_hash: u64,
    results: Vec<WaveResult>,
    cards: CardState,
}

impl MatchState {
    fn snapshot(&mut self) -> MatchState {
        MatchState {
            sim: self.sim.snapshot(),
            wave: self.wave,
            phase: self.phase,
            base: self.base.clone(),
            applied: self.applied.clone(),
            newcomers: self.newcomers,
            wave_start_civilians: self.wave_start_civilians,
            counters0: self.counters0,
            outbreak_sites: self.outbreak_sites.clone(),
            start_hash: self.start_hash,
            results: self.results.clone(),
            cards: self.cards.clone(),
        }
    }

    fn restore(&mut self, s: &MatchState) {
        self.sim.restore_from(&s.sim);
        self.wave = s.wave;
        self.phase = s.phase;
        self.base.clone_from(&s.base);
        self.applied.clone_from(&s.applied);
        self.newcomers = s.newcomers;
        self.wave_start_civilians = s.wave_start_civilians;
        self.counters0 = s.counters0;
        self.outbreak_sites.clone_from(&s.outbreak_sites);
        self.start_hash = s.start_hash;
        self.results.clone_from(&s.results);
        self.cards.clone_from(&s.cards);
    }
}

pub struct Match {
    cfg: Config,
    cards: CardDb,
    setup: MatchSetup,
    /// The setup deck as card indices.
    deck_list: Vec<u16>,
    /// Outbreak (clusters, inner clusters) per wave after scaling to the
    /// level's rings (see `outbreak_counts`).
    outbreaks: Vec<(u32, u32)>,
    /// The level without buildings (name, centre, radius or bounds, fences).
    shell: LevelPack,
    /// Play-area centre, level-local meters.
    center: [f32; 2],
    rings: Vec<f32>,
    /// First wave whose disc contains each cell's centre (0: never).
    cell_ring: Vec<u8>,
    /// Same with the disc grown by `ring_band_m` (what `ring_ready` checks).
    cell_ring_margin: Vec<u8>,
    level_fence: Vec<bool>,
    chunks: BTreeMap<u64, StoredChunk>,
    loaded: Vec<bool>,
    /// Cells of each wave's ring (index wave - 1) not covered by any chunk yet.
    missing: Vec<u32>,
    state: MatchState,
    /// The current wave's prep start (one, not one per wave).
    prep_snapshot: MatchState,
    retries: u32,
    restarts: u32,
    tick: u64,
    log: Vec<LoggedAction>,
}

/// The `ring_ready` band: every cell whose centre is within the ring radius +
/// `block_margin_m` + `cell_size_m * SQRT_2` must be covered by a chunk.
/// The extra cell diagonal makes it agree with the reveal and the
/// `AreaRevealed` refusal (`Match::bounds_due`: bounds within radius +
/// margin): a block at least one cell wide whose bounds come that close
/// holds a cell centre (half-open, see `add_buildings`) within a diagonal
/// of that point, so the block is awaited before the ring opens (T2 review: without it a late block could be
/// refused while the next ring waited for its cells forever). The browser's
/// map loader mirrors this rule (DECISIONS.md, "Match").
pub fn ring_band_m(cfg: &Config) -> f32 {
    cfg.match_.block_margin_m + cfg.cell_size_m * std::f32::consts::SQRT_2
}

/// Callers validate the box first (`validate_chunk`): `clamp` panics on an
/// inverted or NaN range.
fn box_meets_disc(b: [f32; 4], c: [f32; 2], r: f32) -> bool {
    let nx = c[0].clamp(b[0], b[2]);
    let ny = c[1].clamp(b[1], b[3]);
    let (dx, dy) = (nx - c[0], ny - c[1]);
    dx * dx + dy * dy <= r * r
}

impl Match {
    /// A match on a complete level: all its buildings are known up front
    /// (one chunk, block id 0, covering everything). Headless and tests.
    /// Uses the embedded `cards.json`.
    pub fn new(level: &LevelPack, cfg: Config, setup: MatchSetup) -> Result<Match, MatchError> {
        Match::new_with_cards(level, cfg, CardDb::default_cards(), setup)
    }

    pub fn new_with_cards(level: &LevelPack, cfg: Config, cards: CardDb, setup: MatchSetup) -> Result<Match, MatchError> {
        let mut shell = level.clone();
        shell.buildings = Vec::new();
        let all = BuildingChunk { block_id: 0, bounds: [f32::MIN, f32::MIN, f32::MAX, f32::MAX], buildings: level.buildings.clone() };
        Match::new_streaming_with_cards(&shell, cfg, cards, setup, vec![all])
    }

    /// A match whose buildings arrive in chunks: `shell` gives the play area
    /// and fences (no buildings); `chunks` must cover wave 1's ring. Later
    /// chunks come through `add_buildings`. Uses the embedded `cards.json`.
    pub fn new_streaming(shell: &LevelPack, cfg: Config, setup: MatchSetup, chunks: Vec<BuildingChunk>) -> Result<Match, MatchError> {
        Match::new_streaming_with_cards(shell, cfg, CardDb::default_cards(), setup, chunks)
    }

    pub fn new_streaming_with_cards(shell: &LevelPack, cfg: Config, cards: CardDb, setup: MatchSetup, chunks: Vec<BuildingChunk>) -> Result<Match, MatchError> {
        cfg.match_.validate(cfg.wave8_radius_m).map_err(MatchError::InvalidConfig)?;
        cards.validate_deck(&setup.deck).map_err(MatchError::InvalidDeck)?;
        let deck_list: Vec<u16> = setup.deck.iter().map(|id| cards.index(id).expect("validated") as u16).collect();
        if !shell.buildings.is_empty() {
            return Err(MatchError::LevelHasBuildings);
        }
        let (center, level_r) = match (shell.radius_m, shell.bounds) {
            (Some(r), _) => ([0.0, 0.0], r),
            (None, Some([x0, y0, x1, y1])) => ([(x0 + x1) * 0.5, (y0 + y1) * 0.5], ((x1 - x0) * 0.5).min((y1 - y0) * 0.5)),
            _ => return Err(MatchError::NoPlayArea),
        };
        let rings = Match::ring_radii(&cfg, level_r);
        let outbreaks = Match::outbreak_counts(&cfg, &rings);
        let mut shell = shell.clone();
        if shell.radius_m.is_some() {
            shell.radius_m = Some(rings[rings.len() - 1]);
        }
        let grid = Match::shell_grid(&shell, &cfg);
        let cells = grid.w * grid.h;
        let mut cell_ring = vec![0u8; cells];
        let mut cell_ring_margin = vec![0u8; cells];
        let margin = ring_band_m(&cfg);
        for c in 0..cells {
            let [lx, ly] = Match::cell_local(&grid, c);
            let (dx, dy) = (lx - center[0], ly - center[1]);
            let d2 = dx * dx + dy * dy;
            if let Some(w) = rings.iter().position(|&r| d2 <= r * r) {
                cell_ring[c] = w as u8 + 1;
            }
            if let Some(w) = rings.iter().position(|&r| d2 <= (r + margin) * (r + margin)) {
                cell_ring_margin[c] = w as u8 + 1;
            }
        }
        let mut level_fence = vec![false; cells];
        for f in &shell.fences {
            let pts: Vec<[f32; 2]> = f.iter().map(|&[x, y]| [x - grid.origin[0], y - grid.origin[1]]).collect();
            for c in grid.rasterize_polyline(&pts) {
                level_fence[c] = true;
            }
        }
        let mut missing = vec![0u32; rings.len()];
        for &r in &cell_ring_margin {
            if r > 0 {
                missing[r as usize - 1] += 1;
            }
        }
        let mut state = Match::fresh_state(grid, &cfg, &setup, &deck_list);
        let mut m = Match {
            prep_snapshot: state.snapshot(),
            state,
            cfg,
            cards,
            setup,
            deck_list,
            outbreaks,
            shell,
            center,
            rings,
            cell_ring,
            cell_ring_margin,
            level_fence,
            chunks: BTreeMap::new(),
            loaded: vec![false; cells],
            missing,
            retries: 0,
            restarts: 0,
            tick: 0,
            log: Vec::new(),
        };
        for ch in chunks {
            m.add_buildings(ch)?;
        }
        if !m.ring_ready(1) {
            return Err(MatchError::RingNotLoaded(1));
        }
        m.enter_prep();
        Ok(m)
    }

    /// Each wave's radius on a level of radius `level_r`. On a level at least
    /// as large as the wave-8 cap, the config's rings (cut at the level).
    /// On a smaller one the core keeps its size and the other rings are
    /// squeezed linearly between it and the level edge (all scaled if the
    /// level is smaller than the core).
    pub fn ring_radii(cfg: &Config, level_r: f32) -> Vec<f32> {
        let rc = &cfg.match_.ring_radius_m;
        let cap = cfg.wave8_radius_m;
        let l = level_r.min(cap);
        let r1 = rc[0];
        rc.iter()
            .map(|&r| {
                if l >= cap {
                    r
                } else if l > r1 {
                    r1 + (r - r1) * ((l - r1) / (cap - r1))
                } else {
                    r * (l / cap)
                }
            })
            .collect()
    }

    /// Outbreak (clusters, inner clusters) per wave for these rings. The
    /// config's counts are for the full-size rings; on a level whose rings
    /// are squeezed they scale with the disc area,
    /// `max(1, round(clusters × (r / r_config)²))`, so outbreaks per km²
    /// stay the same (inner clusters likewise, at most the total).
    pub fn outbreak_counts(cfg: &Config, rings: &[f32]) -> Vec<(u32, u32)> {
        let mc = &cfg.match_;
        (0..rings.len())
            .map(|w| {
                let q = (rings[w] / mc.ring_radius_m[w]).min(1.0);
                let a = q * q;
                let c = mc.outbreak_clusters[w];
                let i = mc.inner_outbreaks[w];
                let cs = if c == 0 { 0 } else { ((c as f32 * a + 0.5).floor() as u32).clamp(1, c) };
                let is = ((i as f32 * a + 0.5).floor() as u32).min(cs);
                (cs, is)
            })
            .collect()
    }

    /// The match grid: the final disc (or the bounds) plus a margin of at
    /// least `ring_band_m` + one cell, more than `grid_margin_m` if needed.
    /// Every block a reveal applies (bounds within radius + `block_margin_m`)
    /// then holds a grid cell centre inside the `ring_ready` band, so it is
    /// awaited. With the 20 m `grid_margin_m` alone the grid ended inside
    /// the band of the last rings: a block lying wholly beyond the grid edge
    /// covered no cell, `ring_ready` did not wait for it, yet the reveal
    /// applied it if present (its buildings may reach the margin into the
    /// disc) and refused it if late, so the result depended on arrival
    /// time (T2 review).
    fn shell_grid(shell: &LevelPack, cfg: &Config) -> Grid {
        let mut gc = cfg.clone();
        gc.grid_margin_m = cfg.grid_margin_m.max(Match::grid_margin_m(cfg));
        Grid::from_level(shell, &gc)
    }

    /// The smallest grid margin a match needs (`ring_band_m` + one cell).
    pub fn grid_margin_m(cfg: &Config) -> f32 {
        ring_band_m(cfg) + cfg.cell_size_m
    }

    fn cell_local(grid: &Grid, c: usize) -> [f32; 2] {
        let (cx, cy) = (c % grid.w, c / grid.w);
        [grid.origin[0] + (cx as f32 + 0.5) * grid.cell, grid.origin[1] + (cy as f32 + 0.5) * grid.cell]
    }

    /// Wave 0: no ring revealed, no buildings, no agents.
    fn fresh_state(mut grid: Grid, cfg: &Config, setup: &MatchSetup, deck: &[u16]) -> MatchState {
        let base = grid.kind.clone();
        grid.kind.fill(WALL);
        grid.rebuild_step_masks();
        let mut sim = Sim::with_capacity(grid, cfg.clone(), cfg.max_population as usize, setup.seed);
        sim.timeout = false;
        MatchState {
            sim,
            wave: 0,
            phase: Phase::Prep,
            base,
            applied: Vec::new(),
            newcomers: 0,
            wave_start_civilians: 0,
            counters0: [0; 3],
            outbreak_sites: Vec::new(),
            start_hash: 0,
            results: Vec::new(),
            cards: CardState::new(deck.to_vec(), setup.seed),
        }
    }

    // ------------------------------------------------------------ loading

    /// Add a block of buildings. Allowed at any time, but only for area not
    /// yet revealed; chunks are applied when their area is first revealed,
    /// in block-id order, so the result never depends on arrival order.
    pub fn add_buildings(&mut self, chunk: BuildingChunk) -> Result<(), MatchError> {
        let id = chunk.block_id;
        Match::validate_chunk(&chunk, self.cfg.cell_size_m)?;
        if self.chunks.contains_key(&id) {
            return Err(MatchError::DuplicateBlock(id));
        }
        let mg = self.cfg.match_.block_margin_m;
        let [bx0, by0, bx1, by1] = chunk.bounds;
        for b in &chunk.buildings {
            for &[x, y] in &b.polygon {
                if x < bx0 - mg || y < by0 - mg || x > bx1 + mg || y > by1 + mg {
                    return Err(MatchError::BuildingOutsideBlock { block_id: id, building_id: b.id });
                }
            }
        }
        if self.state.wave > 0 && self.chunk_due(&chunk.bounds, self.radius_m()) {
            return Err(MatchError::AreaRevealed(id));
        }
        let g = &self.state.sim.grid;
        // Cells whose centre is inside the bounds, half-open (`min <= centre
        // < max`, clamped to the grid): blocks that tile the plane cover each
        // cell once, even when an edge runs through cell centres. Closed
        // intervals let a neighbour cover a block's only cells, so the block
        // was not awaited (T2 review).
        let cx0 = (((bx0 - g.origin[0]) / g.cell - 0.5).ceil().max(0.0) as usize).min(g.w);
        let cy0 = (((by0 - g.origin[1]) / g.cell - 0.5).ceil().max(0.0) as usize).min(g.h);
        let cx1 = (((bx1 - g.origin[0]) / g.cell - 0.5).ceil() - 1.0).min(g.w as f32 - 1.0);
        let cy1 = (((by1 - g.origin[1]) / g.cell - 0.5).ceil() - 1.0).min(g.h as f32 - 1.0);
        if cx1 >= 0.0 && cy1 >= 0.0 {
            let (w, cx1, cy1) = (g.w, cx1 as usize, cy1 as usize);
            for cy in cy0..=cy1 {
                for cx in cx0..=cx1 {
                    let c = cy * w + cx;
                    if !self.loaded[c] {
                        self.loaded[c] = true;
                        let r = self.cell_ring_margin[c];
                        if r > 0 {
                            self.missing[r as usize - 1] -= 1;
                        }
                    }
                }
            }
        }
        self.chunks.insert(id, StoredChunk { chunk });
        Ok(())
    }

    /// Whether a chunk with these bounds is applied by the reveal of a disc
    /// of radius `r`: its bounds come within `r + block_margin_m` of the
    /// centre. Decided by the bounds alone, never by the buildings: a
    /// building may stick out by the margin per axis, so up to margin × √2
    /// at a block corner, and a rule on the buildings could then apply (and
    /// refuse) a block that `ring_ready` did not wait for (T2 review). With
    /// this rule `ring_band_m` covers every block a reveal applies. The part
    /// of a building reaching farther than the margin into rings already
    /// revealed is not added there (open ground), whatever the arrival order.
    fn bounds_due(b: &[f32; 4], c: [f32; 2], r: f32, margin: f32) -> bool {
        box_meets_disc(*b, c, r + margin)
    }

    fn chunk_due(&self, b: &[f32; 4], r: f32) -> bool {
        Match::bounds_due(b, self.center, r, self.cfg.match_.block_margin_m)
    }

    /// `BadChunk` unless the bounds are finite, `min <= max` and at least one
    /// cell wide on both axes (so they hold a cell centre, see `ring_band_m`),
    /// and every building coordinate (and floor count) is finite.
    fn validate_chunk(chunk: &BuildingChunk, cell: f32) -> Result<(), MatchError> {
        let [x0, y0, x1, y1] = chunk.bounds;
        let finite = chunk.bounds.iter().all(|v| v.is_finite());
        // `>=` is false for NaN; `MAX - MIN` overflows to +inf, which passes.
        if !finite || !(x1 - x0 >= cell) || !(y1 - y0 >= cell) {
            return Err(MatchError::BadChunk(chunk.block_id));
        }
        if chunk.buildings.iter().any(|b| !b.floors.is_finite() || b.polygon.iter().any(|p| !p[0].is_finite() || !p[1].is_finite())) {
            return Err(MatchError::BadChunk(chunk.block_id));
        }
        Ok(())
    }

    /// Whether every grid cell whose centre is within wave `wave`'s radius +
    /// `ring_band_m` (`block_margin_m` + one cell diagonal) is covered by a
    /// chunk (cells of the grid only).
    pub fn ring_ready(&self, wave: u8) -> bool {
        let w = (wave as usize).min(self.rings.len());
        self.missing[..w].iter().all(|&m| m == 0)
    }

    // ------------------------------------------------------------ actions

    /// Apply a player action between ticks. Accepted actions are logged.
    pub fn apply(&mut self, action: Action) -> Result<(), ActionError> {
        let phase = self.state.phase;
        let wrong = || Err(ActionError::WrongPhase { action: action.name().to_string(), phase });
        match &action {
            Action::PlayCard { hand_index, target } => self.play_card(*hand_index, target)?,
            Action::Mulligan => {
                if phase != Phase::Prep {
                    return wrong();
                }
                self.mulligan()?;
            }
            Action::KeepCards { hand_indices } => {
                if !matches!(phase, Phase::Prep | Phase::Running | Phase::WaveWon) {
                    return wrong();
                }
                self.keep_cards(hand_indices)?;
            }
            Action::Repair { fence_id } => {
                if phase != Phase::Prep {
                    return wrong();
                }
                self.repair(*fence_id)?;
            }
            Action::PullDown { placement_id } => {
                if phase != Phase::Prep {
                    return wrong();
                }
                self.pull_down(*placement_id)?;
            }
            Action::StartWave => {
                if phase != Phase::Prep {
                    return wrong();
                }
                self.start_wave();
            }
            Action::NextWave => {
                if phase != Phase::WaveWon {
                    return wrong();
                }
                let next = self.state.wave + 1;
                if !self.ring_ready(next) {
                    return Err(ActionError::RingNotLoaded { wave: next });
                }
                self.enter_prep();
            }
            Action::RetryWave => {
                if phase == Phase::MatchWon {
                    return wrong();
                }
                self.state.restore(&self.prep_snapshot);
                self.retries += 1;
            }
            Action::RestartMatch => {
                let grid = Match::shell_grid(&self.shell, &self.cfg);
                self.state = Match::fresh_state(grid, &self.cfg, &self.setup, &self.deck_list);
                self.enter_prep();
                self.retries += 1;
                self.restarts += 1;
            }
        }
        self.log.push(LoggedAction { tick: self.tick, action });
        Ok(())
    }

    // ------------------------------------------------------------ cards

    fn card_def(&self, card: u16) -> &CardDef {
        &self.cards.cards[card as usize]
    }

    /// Phase and supply checks for the card at `hand_index` (not the target).
    pub fn can_play(&self, hand_index: u32) -> Result<(), ActionError> {
        let phase = self.state.phase;
        let hc = self.state.cards.hand.get(hand_index as usize).ok_or(ActionError::NoSuchCard { hand_index })?;
        let def = self.card_def(hc.card);
        let right = if def.kind == CardKind::Tactical { phase == Phase::Running } else { phase == Phase::Prep };
        if !right {
            return Err(ActionError::CardWrongPhase { card: def.id.clone(), kind: def.kind, phase });
        }
        let have = self.state.cards.supply;
        if have < def.cost {
            return Err(ActionError::NotEnoughSupply { need: def.cost, have });
        }
        Ok(())
    }

    /// Whether sim point (x, y) is inside the grid and the revealed disc.
    pub fn point_revealed(&self, x: f32, y: f32) -> bool {
        let g = &self.state.sim.grid;
        if !(x >= 0.0 && y >= 0.0 && x < g.w as f32 * g.cell && y < g.h as f32 * g.cell) {
            return false;
        }
        let [cx, cy] = self.center();
        let (dx, dy) = (x - cx, y - cy);
        let r = self.radius_m();
        dx * dx + dy * dy <= r * r
    }

    fn play_card(&mut self, hand_index: u32, target: &Target) -> Result<(), ActionError> {
        self.can_play(hand_index)?;
        let hc = self.state.cards.hand[hand_index as usize];
        let def = self.card_def(hc.card).clone();
        let expected = def.effect.target_kind();
        if target.kind() != expected {
            return Err(ActionError::WrongTarget { card: def.id.clone(), expected });
        }
        let wave = self.state.wave;
        let mut structure = None;
        match (&def.effect, target) {
            (Effect::Fence { length_m, cell_hp }, Target::Polyline(pts)) => {
                let sim = &mut self.state.sim;
                let (len, open) = sim.fence_preview(pts).map_err(|reason| ActionError::Placement { reason })?;
                if len > length_m + 1e-3 {
                    return Err(ActionError::Placement { reason: format!("fence is {len:.0} m, {} allows {length_m:.0} m", def.name) });
                }
                let cells = sim.build_fence_cells(&open, *cell_hp);
                // A broken cell of an older fence now belongs to this one;
                // remember where it came from for a pull-down.
                let mut sorted = cells.clone();
                sorted.sort_unstable();
                let mut taken_over = Vec::new();
                for st in self.state.cards.structures.iter_mut() {
                    let from = st.id;
                    if let StructureKind::Fence { cells: old, .. } = &mut st.kind {
                        let mut index = 0u32;
                        old.retain(|&c| {
                            let taken = sorted.binary_search(&c).is_ok();
                            if taken {
                                taken_over.push(TakenCell { cell: c, from, index });
                            }
                            index += 1;
                            !taken
                        });
                    }
                }
                structure = Some(StructureKind::Fence { cells, cell_hp: *cell_hp, length_m: len, taken_over });
            }
            (Effect::Garrison { buildings, weapon }, Target::Buildings(bs)) => {
                if bs.is_empty() {
                    return Err(ActionError::Placement { reason: "choose at least one building".into() });
                }
                if bs.len() as u32 > *buildings {
                    return Err(ActionError::TooManyBuildings { card: def.id.clone(), max: *buildings });
                }
                for (k, &b) in bs.iter().enumerate() {
                    if bs[..k].contains(&b) {
                        return Err(ActionError::Placement { reason: format!("building {b} chosen twice") });
                    }
                    if !self.building_revealed(b) {
                        return Err(ActionError::NotRevealed { building: b });
                    }
                    if self.state.sim.towers.iter().any(|t| t.building == b) {
                        return Err(ActionError::AlreadyGarrisoned { building: b });
                    }
                }
                let w = weapon.weapon(&self.cfg);
                let sim = &mut self.state.sim;
                for &b in bs {
                    let [x, y] = sim.grid.buildings[b as usize].centroid;
                    sim.towers.push(Tower::garrison(b, x, y, w));
                }
                structure = Some(StructureKind::Garrison { buildings: bs.clone() });
            }
            (Effect::Unit { delay_s, scatter_m, follows_path, speed_m_s, weapon }, t) => {
                let pts: Vec<[f32; 2]> = match t {
                    Target::Point(p) => vec![*p],
                    Target::Polyline(p) if *follows_path && !p.is_empty() => p.clone(),
                    _ => return Err(ActionError::WrongTarget { card: def.id.clone(), expected }),
                };
                if pts.iter().any(|p| !self.point_revealed(p[0], p[1])) {
                    return Err(ActionError::OutsideRevealed);
                }
                let [mut x, mut y] = pts[0];
                if !*follows_path && *scatter_m > 0.0 {
                    // Landing spot: uniform in the scatter disc (rejection, no trig).
                    let rng = &mut self.state.cards.effects_rng;
                    let s = *scatter_m;
                    for _ in 0..16 {
                        let dx = (rng.f32() * 2.0 - 1.0) * s;
                        let dy = (rng.f32() * 2.0 - 1.0) * s;
                        if dx * dx + dy * dy <= s * s {
                            if self.point_revealed(x + dx, y + dy) {
                                x += dx;
                                y += dy;
                            }
                            break;
                        }
                    }
                    let sim = &self.state.sim;
                    let c = sim.grid.cell_of(x, y);
                    if sim.grid.kind[c] != WALK {
                        match sim.nearest_walkable(c) {
                            Some(t) => [x, y] = sim.grid.cell_center(t),
                            None => return Err(ActionError::Placement { reason: "no open ground near this point".into() }),
                        }
                    }
                }
                let sim = &mut self.state.sim;
                let from = sim.tick + self.cfg.ticks(*delay_s);
                let speed = speed_m_s * self.cfg.dt();
                sim.towers.push(Tower::unit(x, y, weapon.weapon(&self.cfg), from, pts[1..].to_vec(), speed));
            }
            (Effect::Strike { delay_s, radius_m, damage, pulses, interval_s }, Target::Point([x, y])) => {
                if !self.point_revealed(*x, *y) {
                    return Err(ActionError::OutsideRevealed);
                }
                let sim = &mut self.state.sim;
                let next_tick = sim.tick + self.cfg.ticks(*delay_s);
                let interval_ticks = self.cfg.ticks(*interval_s).max(1);
                sim.effects.push(AreaEffect { x: *x, y: *y, radius_m: *radius_m, damage: *damage, next_tick, interval_ticks, pulses_left: *pulses, kills: 0 });
            }
            _ => return Err(ActionError::WrongTarget { card: def.id.clone(), expected }),
        }
        let cs = &mut self.state.cards;
        if let Some(kind) = structure {
            let id = cs.next_structure_id;
            cs.next_structure_id += 1;
            cs.structures.push(Structure { id, card: def.id.clone(), cost: def.cost, wave, kind });
        }
        cs.supply -= def.cost;
        cs.hand.remove(hand_index as usize);
        cs.discard.push(hc.card);
        cs.played_this_wave += 1;
        if self.state.phase == Phase::Prep {
            cs.played_this_prep += 1;
        }
        Ok(())
    }

    fn mulligan(&mut self) -> Result<(), ActionError> {
        let cost = self.cfg.match_.mulligan_cost;
        let cs = &mut self.state.cards;
        if cs.mulligan_used {
            return Err(ActionError::MulliganUsed);
        }
        if cs.played_this_prep > 0 {
            return Err(ActionError::MulliganAfterPlay);
        }
        if cs.hand.is_empty() {
            return Err(ActionError::EmptyHand);
        }
        if cs.supply < cost {
            return Err(ActionError::NotEnoughSupply { need: cost, have: cs.supply });
        }
        cs.supply -= cost;
        cs.mulligan_used = true;
        // The keep marks pointed into the old hand: a choice made before the
        // mulligan no longer counts (T3 review).
        cs.keep_chosen = false;
        let n = cs.hand.len() as u32;
        // Draw the new hand first, the old one set aside: if the deck runs
        // short the discard is reshuffled into it (`draw`), so an old card
        // only comes back once every other card has been drawn.
        let old: Vec<u16> = cs.hand.drain(..).map(|h| h.card).collect();
        cs.draw(n);
        let short = n - cs.hand.len() as u32;
        // Bottom of the deck (index 0), hand order kept: the first old card
        // ends up at the very bottom.
        cs.deck.splice(0..0, old);
        if short > 0 {
            // Deck and discard ran dry: the rest comes from the old hand.
            cs.draw(short);
        }
        Ok(())
    }

    fn keep_cards(&mut self, idx: &[u32]) -> Result<(), ActionError> {
        let max = self.cfg.match_.hand_keep;
        let cs = &mut self.state.cards;
        if idx.len() as u32 > max {
            return Err(ActionError::TooManyKept { max });
        }
        for (k, &i) in idx.iter().enumerate() {
            if i as usize >= cs.hand.len() {
                return Err(ActionError::NoSuchCard { hand_index: i });
            }
            if idx[..k].contains(&i) {
                return Err(ActionError::DuplicateIndex { hand_index: i });
            }
        }
        for (i, h) in cs.hand.iter_mut().enumerate() {
            h.keep = idx.contains(&(i as u32));
        }
        cs.keep_chosen = true;
        Ok(())
    }

    /// (missing hp, total hp) of a fence structure's cells.
    fn fence_damage(&self, st: &Structure) -> Option<(f32, f32)> {
        let StructureKind::Fence { cells, cell_hp, .. } = &st.kind else { return None };
        let g = &self.state.sim.grid;
        let mut missing = 0.0f32;
        let mut total = 0.0f32;
        for &c in cells {
            let c = c as usize;
            match g.kind[c] {
                FENCE => missing += (cell_hp - g.fence_hp[c]).max(0.0),
                WALK => missing += cell_hp,
                _ => continue,
            }
            total += cell_hp;
        }
        Some((missing, total))
    }

    /// Supply cost of repairing fence `fence_id` now (`None`: not a fence or
    /// not damaged).
    pub fn repair_cost(&self, fence_id: u32) -> Option<u32> {
        let st = self.state.cards.structures.iter().find(|s| s.id == fence_id)?;
        let (missing, total) = self.fence_damage(st)?;
        if missing <= 0.0 || total <= 0.0 {
            return None;
        }
        let c = (st.cost as f32 * self.cfg.match_.repair_cost_factor * (missing / total)).ceil();
        Some((c as u32).max(1))
    }

    /// Supply refunded by pulling down structure `id` now.
    pub fn pull_down_refund(&self, id: u32) -> Option<u32> {
        let st = self.state.cards.structures.iter().find(|s| s.id == id)?;
        if st.wave == self.state.wave && self.state.phase == Phase::Prep {
            return Some(st.cost);
        }
        let condition = match self.fence_damage(st) {
            Some((missing, total)) if total > 0.0 => (total - missing) / total,
            Some(_) => 0.0,
            None => 1.0,
        };
        Some((st.cost as f32 * self.cfg.match_.pull_down_refund * condition).floor() as u32)
    }

    fn repair(&mut self, fence_id: u32) -> Result<(), ActionError> {
        let Some(k) = self.state.cards.structures.iter().position(|s| s.id == fence_id && matches!(s.kind, StructureKind::Fence { .. })) else {
            return Err(ActionError::NoSuchFence { fence_id });
        };
        let cost = self.repair_cost(fence_id).ok_or(ActionError::NothingToRepair { fence_id })?;
        let have = self.state.cards.supply;
        if have < cost {
            return Err(ActionError::NotEnoughSupply { need: cost, have });
        }
        let StructureKind::Fence { cells, cell_hp, .. } = self.state.cards.structures[k].kind.clone() else { unreachable!() };
        let sim = &mut self.state.sim;
        for &c in &cells {
            let c = c as usize;
            if sim.grid.kind[c] == WALK {
                sim.grid.set_kind(c, FENCE);
            }
            if sim.grid.kind[c] == FENCE {
                sim.grid.fence_hp[c] = cell_hp;
            }
        }
        sim.push_agents_off_blocked_cells();
        self.state.cards.supply -= cost;
        Ok(())
    }

    fn pull_down(&mut self, id: u32) -> Result<(), ActionError> {
        let k = self.state.cards.structures.iter().position(|s| s.id == id).ok_or(ActionError::NoSuchStructure { placement_id: id })?;
        let refund = self.pull_down_refund(id).expect("structure exists");
        let st = self.state.cards.structures.remove(k);
        let sim = &mut self.state.sim;
        match &st.kind {
            StructureKind::Fence { cells, taken_over, .. } => {
                for &c in cells {
                    let c = c as usize;
                    if sim.grid.kind[c] == FENCE {
                        sim.grid.set_kind(c, WALK);
                        sim.grid.fence_hp[c] = 0.0;
                    }
                }
                // Cells taken over from older fences go back to them, broken
                // as they were (open ground, 0 hp), at their old position.
                // Only those this fence still holds, and only to a fence that
                // still stands. Ascending original index rebuilds the order.
                for t in taken_over {
                    if !cells.contains(&t.cell) {
                        continue;
                    }
                    let owner = self.state.cards.structures.iter_mut().find(|s| s.id == t.from);
                    if let Some(Structure { kind: StructureKind::Fence { cells: old, .. }, .. }) = owner {
                        let at = (t.index as usize).min(old.len());
                        old.insert(at, t.cell);
                    }
                }
                // Cells newer fences took over from this one are re-pointed to
                // where this fence got them from (its own `TakenCell`), or no
                // longer go back anywhere if it built them. Without this a
                // cell taken over twice was lost once both newer fences were
                // pulled down (T3 review).
                for other in self.state.cards.structures.iter_mut() {
                    if let StructureKind::Fence { taken_over: theirs, .. } = &mut other.kind {
                        if !theirs.iter().any(|t| t.from == id) {
                            continue;
                        }
                        theirs.retain_mut(|t| {
                            if t.from != id {
                                return true;
                            }
                            match taken_over.iter().find(|o| o.cell == t.cell) {
                                Some(o) => {
                                    *t = *o;
                                    true
                                }
                                None => false,
                            }
                        });
                        // Give-back inserts in ascending index (stable sort).
                        theirs.sort_by_key(|t| t.index);
                    }
                }
            }
            StructureKind::Garrison { buildings } => sim.towers.retain(|t| !buildings.contains(&t.building)),
        }
        let cs = &mut self.state.cards;
        cs.supply += refund;
        if st.wave == self.state.wave {
            // Placed this prep: the card comes back to the hand.
            let card = self.cards.index(&st.card).expect("known card") as u16;
            if let Some(p) = cs.discard.iter().rposition(|&c| c == card) {
                cs.discard.remove(p);
            } else if let Some(p) = cs.deck.iter().rposition(|&c| c == card) {
                cs.deck.remove(p);
            }
            cs.hand.push(HandCard { card, keep: false });
            cs.played_this_prep = cs.played_this_prep.saturating_sub(1);
            cs.played_this_wave = cs.played_this_wave.saturating_sub(1);
        }
        Ok(())
    }

    fn building_revealed(&self, b: u32) -> bool {
        let g = &self.state.sim.grid;
        match g.buildings.get(b as usize) {
            Some(info) if info.cell_count > 0 => {
                let (lx, ly) = (info.centroid[0] + g.origin[0], info.centroid[1] + g.origin[1]);
                let (dx, dy) = (lx - self.center[0], ly - self.center[1]);
                let r = self.radius_m();
                dx * dx + dy * dy <= r * r
            }
            _ => false,
        }
    }

    // ------------------------------------------------------------ the loop

    pub fn step(&mut self) {
        self.step_timed(&mut NoClock);
    }

    /// One tick. Prep: cosmetic wander. Running: the wave. Otherwise idle.
    pub fn step_timed<C: Clock>(&mut self, clock: &mut C) {
        self.tick += 1;
        match self.state.phase {
            Phase::Prep => self.state.sim.step_timed(clock),
            Phase::Running => {
                let sim = &mut self.state.sim;
                let t = sim.tick as f32 / sim.cfg.tick_hz as f32;
                sim.fatigue = self.cfg.match_.fatigue_at(t);
                sim.step_timed(clock);
                if let Some(o) = sim.outcome() {
                    self.finish_wave(o);
                }
            }
            _ => {}
        }
    }

    /// Reveal the next wave's ring, add its newcomers and open its prep.
    fn enter_prep(&mut self) {
        let k = self.state.wave + 1;
        self.reveal(k);
        let st = &mut self.state;
        st.wave = k;
        let sim = &mut st.sim;
        sim.push_agents_off_blocked_cells();
        // Newcomers: buildings whose centroid is in this ring.
        let (origin, center, rings) = (sim.grid.origin, self.center, &self.rings);
        let ring_buildings: Vec<usize> = (0..sim.grid.buildings.len())
            .filter(|&b| {
                let [x, y] = sim.grid.buildings[b].centroid;
                let (dx, dy) = (x + origin[0] - center[0], y + origin[1] - center[1]);
                let d2 = dx * dx + dy * dy;
                let ring = rings.iter().position(|&r| d2 <= r * r).map_or(rings.len(), |w| w + 1);
                ring == k as usize
            })
            .collect();
        let mut rng = Pcg32::new(self.setup.seed, streams::stream(streams::SPAWN, k));
        st.newcomers = sim.spawn_newcomers(&ring_buildings, self.setup.population_multiplier as f64, &mut rng);
        for i in 0..sim.n {
            if sim.state[i] == DEAD {
                sim.timer[i] = 0; // no kill flash carried into prep
            }
            sim.vx[i] = 0.0;
            sim.vy[i] = 0.0;
        }
        sim.phase = GamePhase::Setup;
        sim.tick = 0;
        // Tactical units and strikes last one wave.
        sim.towers.retain(|t| !t.is_unit());
        sim.effects.clear();
        sim.rng = Pcg32::new(self.setup.seed, streams::stream(streams::PREP_WANDER, k));
        sim.spawn_x.clone_from(&sim.x);
        sim.spawn_y.clone_from(&sim.y);
        st.phase = Phase::Prep;
        st.outbreak_sites.clear();
        // Cards: supply income, keep / discard, draw.
        let mc = &self.cfg.match_;
        let cs = &mut st.cards;
        let earned = st.results.last().filter(|r| r.wave + 1 == k).map_or(0, |r| r.supply_earned);
        cs.income = if k == 1 {
            SupplyIncome { base: mc.supply_start + mc.supply_base_income, civilians: 0 }
        } else {
            SupplyIncome { base: mc.supply_base_income, civilians: earned.saturating_sub(mc.supply_base_income) }
        };
        cs.supply += cs.income.base + cs.income.civilians;
        cs.deck_rng = Pcg32::new(self.setup.seed, streams::stream(streams::DECK, k));
        if k == 1 {
            cs.shuffle_deck();
        } else {
            let chosen = cs.keep_chosen;
            let mut kept = Vec::new();
            for (i, h) in cs.hand.drain(..).enumerate() {
                let keep = if chosen { h.keep } else { (i as u32) < mc.hand_keep };
                if keep && (kept.len() as u32) < mc.hand_keep {
                    kept.push(HandCard { card: h.card, keep: false });
                } else {
                    cs.discard.push(h.card);
                }
            }
            cs.hand = kept;
        }
        cs.draw(mc.hand_draw);
        cs.mulligan_used = false;
        cs.keep_chosen = false;
        cs.played_this_prep = 0;
        cs.played_this_wave = 0;
        let h = self.state_hash();
        self.state.start_hash = h;
        self.prep_snapshot = self.state.snapshot();
    }

    /// Open wave `k`'s disc: apply the chunks it touches (block-id order),
    /// restore the geometry inside it, add level fences of the new ring, and
    /// wall off pockets not connected to the area kept so far (wave 1: not
    /// in its largest region).
    fn reveal(&mut self, k: u8) {
        let r = self.rings[k as usize - 1];
        let st = &mut self.state;
        for (id, sc) in &self.chunks {
            if st.applied.contains(id) || !Match::bounds_due(&sc.chunk.bounds, self.center, r, self.cfg.match_.block_margin_m) {
                continue;
            }
            for b in &sc.chunk.buildings {
                let g = &mut st.sim.grid;
                let (mut info, mut cells) = g.rasterize_building(b, &st.base);
                // Only the cells not revealed yet (this ring, later rings and
                // cells beyond the last ring) take the building: the part of
                // a late block's building reaching into rings revealed
                // before stays open ground, and `building_at`, `base` and
                // `cell_count` agree with that (T2 review).
                let cr = &self.cell_ring;
                cells.retain(|&c| cr[c] == 0 || cr[c] >= k);
                info.cell_count = cells.len() as u32;
                let bi = g.buildings.len() as u32;
                for c in cells {
                    st.base[c] = BUILDING;
                    g.building[c] = bi;
                }
                g.buildings.push(info);
            }
            st.applied.push(*id);
        }
        let g = &mut st.sim.grid;
        // The area kept so far (walkable before this reveal): it is never
        // walled. WALK cells only: walling turns WALK into WALL but leaves
        // fences, so a level fence inside a walled pocket is still FENCE and
        // as an anchor reopened the pocket at the next reveal (T2 review).
        // Fences of the played area still join it through the flood (fences
        // count as open there).
        let kept: Vec<bool> = g.kind.iter().map(|&kd| kd == WALK).collect();
        for c in 0..g.kind.len() {
            let rc = self.cell_ring[c];
            if rc == 0 || rc > k {
                continue;
            }
            if rc == k {
                g.kind[c] = st.base[c];
                if self.level_fence[c] && st.base[c] == WALK {
                    g.kind[c] = FENCE;
                    g.fence_hp[c] = self.cfg.fence_cell_hp;
                }
            } else if g.kind[c] == WALL && st.base[c] == WALK {
                g.kind[c] = WALK; // a pocket walled earlier may connect now
            }
        }
        // Wall the pockets: open regions connected to none of the cells kept
        // so far (wave 1: everything but the largest region). Not "keep the
        // largest", which walled the whole played area when the new ring
        // held a larger region not connected to it (T2 review).
        g.keep_regions_touching(|kd| kd == WALK || kd == FENCE, |kd| kd == WALK, &kept);
        g.rebuild_step_masks();
    }

    fn start_wave(&mut self) {
        let k = self.state.wave;
        let mc = &self.cfg.match_;
        let st = &mut self.state;
        let sim = &mut st.sim;
        // Prep wandering was cosmetic: back to the prep-start positions.
        sim.x.copy_from_slice(&sim.spawn_x);
        sim.y.copy_from_slice(&sim.spawn_y);
        sim.vx.fill(0.0);
        sim.vy.fill(0.0);
        sim.rng = Pcg32::new(self.setup.seed, streams::stream(streams::WANDER, k));
        st.cards.effects_rng = Pcg32::new(self.setup.seed, streams::stream(streams::CARD_EFFECTS, k));
        st.cards.played_this_prep = 0;
        sim.push_agents_off_blocked_cells();
        sim.grid.rebuild_step_masks();
        sim.field_cells = sim.grid.kind.iter().filter(|&&k| k == WALK || k == FENCE).count();
        sim.tick = 0;
        for t in sim.towers.iter_mut() {
            t.cooldown = 0;
        }
        let start = sim.stats.civilians;
        st.wave_start_civilians = start;
        sim.stats.initial_civilians = start;
        sim.stats.first_breach_tick = None;
        // f32 0.15 is a hair above 0.15 (relative error ~4e-8, so up to
        // ~0.006 at 100k civilians): without the tolerance an exact product
        // (15% of 760 = 114) would round up to 115.
        sim.loss_below = (mc.defeat_fraction as f64 * start as f64 - 1e-3).ceil() as u32;
        sim.fatigue = mc.fatigue_at(0.0);
        st.counters0 = [sim.stats.zombies_killed, sim.stats.bites, sim.stats.fence_cells_broken];

        // Outbreak: wave 1 anywhere; later waves in the new ring, except
        // `inner_outbreaks` clusters inside earlier territory.
        let w = k as usize - 1;
        let mut rng = Pcg32::new(self.setup.seed, streams::stream(streams::OUTBREAK, k));
        let (clusters, n_inner) = self.outbreaks[w];
        let (clusters, n_inner) = (clusters as usize, n_inner as usize);
        let (origin, center) = (sim.grid.origin, self.center);
        let civilians: Vec<u32> = (0..sim.n as u32).filter(|&i| sim.state[i as usize] == CIVILIAN).collect();
        let mut seeds = Vec::new();
        if k == 1 {
            sim.pick_outbreak_seeds(&civilians, clusters, &mut rng, &mut seeds);
        } else {
            let r_prev = self.rings[w - 1];
            let inside = |i: u32| {
                let (dx, dy) = (sim.x[i as usize] + origin[0] - center[0], sim.y[i as usize] + origin[1] - center[1]);
                dx * dx + dy * dy <= r_prev * r_prev
            };
            let (inner, ring): (Vec<u32>, Vec<u32>) = civilians.iter().partition(|&&i| inside(i));
            sim.pick_outbreak_seeds(&inner, n_inner, &mut rng, &mut seeds);
            // An empty new ring (no buildings there) falls back to anywhere.
            let rest = if ring.is_empty() { &civilians } else { &ring };
            sim.pick_outbreak_seeds(rest, clusters - seeds.len(), &mut rng, &mut seeds);
        }
        st.outbreak_sites = seeds.iter().map(|&s| [sim.x[s], sim.y[s]]).collect();
        sim.infect_clusters(&seeds, mc.outbreak_radius_m[w], mc.outbreak_min_per_cluster[w] as usize);
        sim.phase = GamePhase::Running;
        sim.recompute_chase();
        sim.recompute_threat_and_flee();
        st.phase = Phase::Running;
    }

    fn finish_wave(&mut self, o: Outcome) {
        let k = self.state.wave;
        let won = o == Outcome::Win;
        self.state.phase = match (won, k >= self.waves()) {
            (true, true) => Phase::MatchWon,
            (true, false) => Phase::WaveWon,
            (false, _) => Phase::WaveLost,
        };
        let end_hash = self.state_hash();
        let mc = &self.cfg.match_;
        let st = &mut self.state;
        let s = &st.sim.stats;
        let supply_earned = if won && k < self.rings.len() as u8 { mc.supply_base_income + s.civilians / mc.supply_civilians_per_point[k as usize - 1] } else { 0 };
        let r = WaveResult {
            wave: k,
            won,
            ticks: st.sim.tick,
            radius_m: self.rings[k as usize - 1],
            newcomers: st.newcomers,
            start_civilians: st.wave_start_civilians,
            end_civilians: s.civilians,
            zombies_killed: s.zombies_killed - st.counters0[0],
            bites: s.bites - st.counters0[1],
            fence_cells_broken: s.fence_cells_broken - st.counters0[2],
            outbreak_clusters: st.outbreak_sites.len() as u32,
            supply_earned,
            cards_played: st.cards.played_this_wave,
            start_hash: st.start_hash,
            end_hash,
        };
        st.results.push(r);
    }

    // ------------------------------------------------------------ queries

    pub fn phase(&self) -> Phase {
        self.state.phase
    }
    /// Current wave, 1-based.
    pub fn wave(&self) -> u8 {
        self.state.wave
    }
    pub fn waves(&self) -> u8 {
        self.rings.len() as u8
    }
    /// Radius of wave `wave`'s disc (1-based), meters.
    pub fn ring_radius_m(&self, wave: u8) -> f32 {
        self.rings[(wave.max(1) as usize - 1).min(self.rings.len() - 1)]
    }
    /// The revealed radius (the current wave's), meters.
    pub fn radius_m(&self) -> f32 {
        if self.state.wave == 0 {
            0.0
        } else {
            self.ring_radius_m(self.state.wave)
        }
    }
    /// Play-area centre in sim coordinates.
    pub fn center(&self) -> [f32; 2] {
        let o = self.state.sim.grid.origin;
        [self.center[0] - o[0], self.center[1] - o[1]]
    }
    /// The sim, for rendering and inspection.
    pub fn sim(&self) -> &Sim {
        &self.state.sim
    }
    /// Direct access for tests and tools only: changes made here bypass the
    /// action log, so a replay will not reproduce them.
    pub fn debug_sim_mut(&mut self) -> &mut Sim {
        &mut self.state.sim
    }
    pub fn config(&self) -> &Config {
        &self.cfg
    }
    pub fn setup(&self) -> &MatchSetup {
        &self.setup
    }
    /// Ticks stepped since the match was created (any phase, never reset).
    pub fn tick(&self) -> u64 {
        self.tick
    }
    /// Ticks since the current wave started (or since its prep began).
    pub fn wave_tick(&self) -> u32 {
        self.state.sim.tick
    }
    pub fn log(&self) -> &[LoggedAction] {
        &self.log
    }
    /// RetryWave + RestartMatch count (0 earns the no-retry bonus).
    pub fn retries(&self) -> u32 {
        self.retries
    }
    pub fn restarts(&self) -> u32 {
        self.restarts
    }
    /// Results of the waves played so far (the latest attempt of each).
    pub fn results(&self) -> &[WaveResult] {
        &self.state.results
    }
    /// Civilians added by the current wave's ring.
    pub fn newcomers(&self) -> u32 {
        self.state.newcomers
    }
    /// Civilians at the current wave's Start (0 before it).
    pub fn wave_start_civilians(&self) -> u32 {
        self.state.wave_start_civilians
    }
    /// The wave is lost when civilians drop below this.
    pub fn defeat_threshold(&self) -> u32 {
        self.state.sim.loss_below
    }
    /// Civilian speed factor now.
    pub fn fatigue(&self) -> f32 {
        self.state.sim.fatigue
    }
    /// Outbreak seed positions of the current wave (sim coordinates). Hidden
    /// information: for tests and debug views, not for the player.
    pub fn outbreak_sites(&self) -> &[[f32; 2]] {
        &self.state.outbreak_sites
    }
    // ------------------------------------------------------------ card queries

    /// The card list this match uses.
    pub fn cards(&self) -> &CardDb {
        &self.cards
    }
    /// Supply available now.
    pub fn supply(&self) -> u32 {
        self.state.cards.supply
    }
    /// Supply granted when the current prep opened.
    pub fn supply_income(&self) -> SupplyIncome {
        self.state.cards.income
    }
    /// The hand, in order, with what the UI needs to draw and grey out cards.
    pub fn hand(&self) -> Vec<HandCardView> {
        self.state
            .cards
            .hand
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let d = self.card_def(h.card);
                HandCardView {
                    hand_index: i as u32,
                    card: d.id.clone(),
                    name: d.name.clone(),
                    kind: d.kind,
                    rarity: d.rarity,
                    cost: d.cost,
                    target: d.effect.target_kind(),
                    keep: h.keep,
                    playable: self.can_play(i as u32).is_ok(),
                }
            })
            .collect()
    }
    /// Card ids in hand, in order.
    pub fn hand_ids(&self) -> Vec<&str> {
        self.state.cards.hand.iter().map(|h| self.card_def(h.card).id.as_str()).collect()
    }
    /// Cards left in the draw pile (its order is hidden information).
    pub fn deck_count(&self) -> u32 {
        self.state.cards.deck.len() as u32
    }
    /// Draw pile, next card first. Hidden information: tests and debug only.
    pub fn debug_deck_ids(&self) -> Vec<&str> {
        self.state.cards.deck.iter().rev().map(|&c| self.card_def(c).id.as_str()).collect()
    }
    /// Change one piece of card state directly. Tests only (hash coverage).
    #[doc(hidden)]
    pub fn debug_edit_cards(&mut self, edit: DebugCardEdit) {
        let cs = &mut self.state.cards;
        match edit {
            DebugCardEdit::Supply(v) => cs.supply = v,
            DebugCardEdit::SwapHand(i, j) => cs.hand.swap(i, j),
            DebugCardEdit::SwapDeck(i, j) => cs.deck.swap(i, j),
            DebugCardEdit::SwapDiscard(i, j) => cs.discard.swap(i, j),
            DebugCardEdit::Keep(i, v) => cs.hand[i].keep = v,
            DebugCardEdit::KeepChosen(v) => cs.keep_chosen = v,
            DebugCardEdit::MulliganUsed(v) => cs.mulligan_used = v,
        }
    }
    /// The discard pile, oldest first (public information).
    pub fn discard_ids(&self) -> Vec<&str> {
        self.state.cards.discard.iter().map(|&c| self.card_def(c).id.as_str()).collect()
    }
    pub fn discard_count(&self) -> u32 {
        self.state.cards.discard.len() as u32
    }
    /// Times the discard was shuffled back into the deck so far.
    pub fn reshuffles(&self) -> u32 {
        self.state.cards.reshuffles
    }
    /// The match's deck list (setup order).
    pub fn deck_list(&self) -> &[String] {
        &self.setup.deck
    }
    /// Whether `Mulligan` would be accepted now (phase, unused, nothing
    /// played, non-empty hand, supply).
    pub fn mulligan_available(&self) -> bool {
        let cs = &self.state.cards;
        self.state.phase == Phase::Prep && !cs.mulligan_used && cs.played_this_prep == 0 && !cs.hand.is_empty() && cs.supply >= self.cfg.match_.mulligan_cost
    }
    pub fn mulligan_used(&self) -> bool {
        self.state.cards.mulligan_used
    }
    pub fn mulligan_cost(&self) -> u32 {
        self.cfg.match_.mulligan_cost
    }
    /// Everything cards left on the map (fences, garrisons), oldest first.
    pub fn structures(&self) -> &[Structure] {
        &self.state.cards.structures
    }
    /// The fence structure that owns grid cell `c` (what a click on a fence
    /// selects for repair or pull-down).
    pub fn structure_at_cell(&self, c: u32) -> Option<&Structure> {
        self.state.cards.structures.iter().find(|s| matches!(&s.kind, StructureKind::Fence { cells, .. } if cells.contains(&c)))
    }
    /// The garrison structure on building `b`.
    pub fn structure_of_building(&self, b: u32) -> Option<&Structure> {
        self.state.cards.structures.iter().find(|s| matches!(&s.kind, StructureKind::Garrison { buildings } if buildings.contains(&b)))
    }
    /// Placed length (meters) a fence along `points` would have, or why it
    /// can't be placed: lets the UI show "312 / 400 m" while dragging.
    pub fn fence_length_m(&self, points: &[[f32; 2]]) -> Result<f32, String> {
        self.state.sim.fence_preview(points).map(|(l, _)| l)
    }
    /// Outbreak (clusters, inner clusters) of wave `wave` (1-based) after
    /// scaling to this level's rings.
    pub fn outbreak_count(&self, wave: u8) -> (u32, u32) {
        self.outbreaks[(wave.max(1) as usize - 1).min(self.outbreaks.len() - 1)]
    }
    /// Block ids applied to the grid so far, in application order.
    pub fn applied_blocks(&self) -> &[u64] {
        &self.state.applied
    }
    /// The first wave whose disc contains sim point (x, y) (`waves() + 1`
    /// outside the last).
    pub fn wave_of_point(&self, x: f32, y: f32) -> u8 {
        let [cx, cy] = self.center();
        let (dx, dy) = (x - cx, y - cy);
        let d2 = dx * dx + dy * dy;
        self.rings.iter().position(|&r| d2 <= r * r).map_or(self.waves() + 1, |w| w as u8 + 1)
    }
    /// `Match::state_hash` at the start of the current wave's prep.
    pub fn prep_hash(&self) -> u64 {
        self.state.start_hash
    }

    /// FNV-1a over everything the rest of the match depends on: the sim
    /// (`Sim::state_hash` plus `Sim::wave_state_hash`: RNG, defeat line,
    /// fatigue, spawn positions, stats and, while a wave runs, the published
    /// fields and the pending field jobs), the wave, phase, agents in play,
    /// applied blocks, the wave's starting civilians, newcomers and counters,
    /// the results so far (without their hashes), shooters and strikes, and
    /// the card state. Two matches with the same hash play on identically,
    /// so T4 can find the first tick where two runs diverge. Excludes inputs
    /// and what a retry must not reset (retries, the log, the match tick)
    /// and the prep snapshot (a copy of an earlier state). See DECISIONS.md,
    /// "Match", for what is left out and why.
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |bytes: &[u8]| {
            for &b in bytes {
                h ^= b as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        eat(&self.state.sim.state_hash().to_le_bytes());
        eat(&[self.state.wave, self.state.phase as u8]);
        eat(&(self.state.sim.n as u32).to_le_bytes());
        for id in &self.state.applied {
            eat(&id.to_le_bytes());
        }
        // Added in the T2 review fixes (the match fixture hash changed).
        let st = &self.state;
        eat(&st.sim.wave_state_hash().to_le_bytes());
        for v in [st.wave_start_civilians, st.newcomers, st.counters0[0], st.counters0[1], st.counters0[2], st.results.len() as u32] {
            eat(&v.to_le_bytes());
        }
        for r in &st.results {
            eat(&[r.wave, r.won as u8]);
            eat(&r.radius_m.to_bits().to_le_bytes());
            for v in [r.ticks, r.newcomers, r.start_civilians, r.end_civilians, r.zombies_killed, r.bites, r.fence_cells_broken, r.outbreak_clusters, r.supply_earned, r.cards_played] {
                eat(&v.to_le_bytes());
            }
        }
        // Shooters and strikes beyond what `Sim::state_hash` covers.
        let sim = &self.state.sim;
        for t in &sim.towers {
            for v in [t.x, t.y, t.weapon.range_m, t.weapon.min_range_m, t.weapon.splash_m, t.speed_m_tick] {
                eat(&v.to_bits().to_le_bytes());
            }
            eat(&t.weapon.damage.to_le_bytes());
            eat(&t.weapon.period_ticks.to_le_bytes());
            eat(&t.active_from.to_le_bytes());
            eat(&t.kills.to_le_bytes());
            eat(&(t.path.len() as u32).to_le_bytes());
            for p in &t.path {
                eat(&p[0].to_bits().to_le_bytes());
                eat(&p[1].to_bits().to_le_bytes());
            }
        }
        for e in &sim.effects {
            for v in [e.x, e.y, e.radius_m] {
                eat(&v.to_bits().to_le_bytes());
            }
            for v in [e.damage as u32, e.next_tick, e.interval_ticks, e.pulses_left, e.kills] {
                eat(&v.to_le_bytes());
            }
        }
        // Cards: supply, hand, deck, discard, RNG positions, structures.
        let cs = &self.state.cards;
        let id = |c: u16| self.cards.cards[c as usize].id.as_bytes();
        let eat_ids = |tag: u8, list: &mut dyn Iterator<Item = u16>, eat: &mut dyn FnMut(&[u8])| {
            eat(&[tag]);
            for c in list {
                eat(id(c));
                eat(&[0]);
            }
        };
        let mut eat_dyn = |b: &[u8]| eat(b);
        eat_dyn(&cs.supply.to_le_bytes());
        eat_ids(1, &mut cs.hand.iter().map(|h| h.card), &mut eat_dyn);
        let keeps: Vec<u8> = cs.hand.iter().map(|h| h.keep as u8).collect();
        eat_dyn(&keeps);
        eat_ids(2, &mut cs.deck.iter().copied(), &mut eat_dyn);
        eat_ids(3, &mut cs.discard.iter().copied(), &mut eat_dyn);
        for r in [&cs.deck_rng, &cs.effects_rng] {
            let (a, b) = r.raw_state();
            eat_dyn(&a.to_le_bytes());
            eat_dyn(&b.to_le_bytes());
        }
        // Both flags in one byte: bit 1 (keep choice) is new in the T3
        // review fixes and 0 in every older run, so older hashes still hold.
        eat_dyn(&[cs.mulligan_used as u8 | (cs.keep_chosen as u8) << 1]);
        for v in [cs.played_this_prep, cs.played_this_wave, cs.next_structure_id, cs.reshuffles, cs.income.base, cs.income.civilians] {
            eat_dyn(&v.to_le_bytes());
        }
        for st in &cs.structures {
            eat_dyn(&st.id.to_le_bytes());
            eat_dyn(st.card.as_bytes());
            eat_dyn(&[0, st.wave]);
            eat_dyn(&st.cost.to_le_bytes());
            match &st.kind {
                StructureKind::Fence { cells, cell_hp, length_m, taken_over } => {
                    eat_dyn(&[1]);
                    eat_dyn(&cell_hp.to_bits().to_le_bytes());
                    eat_dyn(&length_m.to_bits().to_le_bytes());
                    for c in cells {
                        eat_dyn(&c.to_le_bytes());
                    }
                    // Taken-over cells after a u32::MAX marker (never a cell
                    // index), only when there are some (older hashes hold).
                    if !taken_over.is_empty() {
                        eat_dyn(&u32::MAX.to_le_bytes());
                        for t in taken_over {
                            for v in [t.cell, t.from, t.index] {
                                eat_dyn(&v.to_le_bytes());
                            }
                        }
                    }
                }
                StructureKind::Garrison { buildings } => {
                    eat_dyn(&[2]);
                    for b in buildings {
                        eat_dyn(&b.to_le_bytes());
                    }
                }
            }
        }
        h
    }

    /// Approximate heap bytes: the sim, the prep snapshot and the match's
    /// own per-cell arrays.
    pub fn memory_bytes(&self) -> usize {
        let snap = &self.prep_snapshot;
        let g = &snap.sim.grid;
        let snap_bytes = g.kind.len() * 11 + snap.base.len() + snap.sim.x.len() * 34;
        self.state.sim.memory_bytes() + self.state.base.len() + snap_bytes + self.cell_ring.len() * 4
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::INF;

    fn marais() -> LevelPack {
        let path = format!("{}/../../levels/paris-marais.json", env!("CARGO_MANIFEST_DIR"));
        LevelPack::from_json(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// Wave 1 of a Marais match, 13 ticks into the wave (field jobs in
    /// flight, one of them past a publish).
    fn running() -> Match {
        let cfg = Config::default_config();
        let mut m = Match::new(&marais(), cfg.clone(), MatchSetup::new(5, &cfg)).unwrap();
        crate::fixture::fixture_prep_plays(&mut m);
        m.apply(Action::StartWave).unwrap();
        for _ in 0..13 {
            m.step();
        }
        assert_eq!(m.phase(), Phase::Running);
        m
    }

    /// Changing any one piece of state the rest of a running wave depends
    /// on changes `Match::state_hash` (T2 review: the RNG, the defeat line,
    /// fatigue, spawn positions, the fields and the field jobs were left out).
    #[test]
    fn state_hash_covers_what_the_rest_of_a_wave_depends_on() {
        let base = running().state_hash();
        assert_eq!(running().state_hash(), base);
        type Edit = fn(&mut Match);
        let edits: Vec<(&str, Edit)> = vec![
            ("rng", |m| {
                m.state.sim.rng.next_u32();
            }),
            ("loss_below", |m| m.state.sim.loss_below += 1),
            ("wave_start_civilians", |m| m.state.wave_start_civilians += 1),
            ("newcomers", |m| m.state.newcomers += 1),
            ("counters at start", |m| m.state.counters0[1] += 1),
            ("fatigue (one bit)", |m| m.state.sim.fatigue = f32::from_bits(m.state.sim.fatigue.to_bits() ^ 1)),
            ("spawn_x", |m| m.state.sim.spawn_x[3] += 0.25),
            ("spawn_y", |m| m.state.sim.spawn_y[3] += 0.25),
            ("n", |m| m.state.sim.n += 1),
            ("stats", |m| m.state.sim.stats.bites += 1),
            ("results", |m| {
                let r = WaveResult { wave: 1, won: true, ticks: 1, radius_m: 150.0, newcomers: 0, start_civilians: 0, end_civilians: 0, zombies_killed: 0, bites: 0, fence_cells_broken: 0, outbreak_clusters: 0, supply_earned: 0, cards_played: 0, start_hash: 0, end_hash: 0 };
                m.state.results.push(r);
            }),
            ("published chase field", |m| {
                let s = &mut m.state.sim;
                let c = (0..s.chase.len()).find(|&c| s.chase[c] < INF).unwrap();
                s.chase[c] += 1;
            }),
            ("published flee field", |m| {
                let s = &mut m.state.sim;
                let c = (0..s.flee.len()).find(|&c| s.flee[c] < INF).unwrap();
                s.flee[c] += 1;
            }),
            ("published threat field", |m| {
                let s = &mut m.state.sim;
                let lim = s.threat_limit();
                let c = (0..s.threat.len()).find(|&c| s.threat[c] < lim).unwrap();
                s.threat[c] += 1;
            }),
            ("chase job seeds", |m| m.state.sim.chase_dial.seeds[0].0 += 1),
            ("threat job seeds", |m| m.state.sim.threat_dial.seeds[0].0 += 1),
            ("chase job pending", |m| m.state.sim.chase_job = false),
            ("cells broken under the chase job", |m| m.state.sim.chase_breaks.push(7)),
            ("cells broken under the threat job", |m| m.state.sim.threat_breaks.push(7)),
        ];
        for (name, edit) in edits {
            let mut m = running();
            edit(&mut m);
            assert_ne!(m.state_hash(), base, "{name} is not in the hash");
        }
        // Threat values above `threat_limit` are never read exactly (the lazy
        // job leaves them unfinished): they don't count.
        let mut m = running();
        let s = &mut m.state.sim;
        let lim = s.threat_limit();
        let c = (0..s.threat.len()).find(|&c| s.threat[c] > lim + 1 && s.threat[c] < INF).unwrap();
        s.threat[c] += 1;
        assert_eq!(m.state_hash(), base);
    }
}
