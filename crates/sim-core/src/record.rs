//! Run records and the replay verifier (T4). A run is its inputs (sim
//! version, config, cards, map snapshot, setup, the action log) plus the
//! `Match::state_hash` at the end of every wave attempt. `replay` rebuilds
//! the match from the inputs, applies every action on its tick and checks
//! every hash; the first attempt whose hash differs is where the runs
//! diverged. See DECISIONS.md, "Run records (T4)".

use serde::{Deserialize, Serialize};

use crate::cards::CardDb;
use crate::config::Config;
use crate::level::{Building, LevelPack};
use crate::mapsnap::{hex, shell_hash, snapshot_hash};
use crate::match_::{Action, ActionError, BuildingChunk, LoggedAction, Match, MatchSetup, Phase, ShellLimits, Target, WaveAttempt};

/// Version of the record layout (`RunRecord::format`). Unknown fields are
/// refused (`deny_unknown_fields`), so adding a field to the record is a
/// format change.
pub const RECORD_FORMAT: u32 = 1;

/// Version of the simulation rules. **Bump it whenever a change makes old
/// runs replay differently** (any hash change: `Match::state_hash`, the
/// fixtures, the golden run record), then regenerate the golden record. A
/// replay always runs on the version it was recorded with, so a verifier
/// refuses records of another version.
pub const SIM_RULES_VERSION: u32 = 1;

/// A `u64` as 16 lowercase hex digits (hashes: JS numbers can't hold them).
pub mod hex64 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{v:016x}"))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let s = String::deserialize(d)?;
        if s.len() != 16 {
            return Err(serde::de::Error::custom(format!("hash {s:?}: 16 hex digits expected")));
        }
        u64::from_str_radix(&s, 16).map_err(|e| serde::de::Error::custom(format!("hash {s:?}: {e}")))
    }
}

/// A `u64` as a decimal string (the seed: JS numbers stop at 2^53).
pub mod u64_str {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(|e| serde::de::Error::custom(format!("seed {s:?}: {e}")))
    }
}

/// An optional seed as a decimal string or a JSON number (`ExpectedRun`).
mod opt_seed {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &Option<u64>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => s.serialize_str(&v.to_string()),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Seed {
            S(String),
            N(u64),
        }
        Ok(match Option::<Seed>::deserialize(d)? {
            None => None,
            Some(Seed::N(n)) => Some(n),
            Some(Seed::S(s)) => Some(s.parse().map_err(|e| serde::de::Error::custom(format!("seed {s:?}: {e}")))?),
        })
    }
}

/// Which simulation recorded the run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimVersion {
    /// `SIM_RULES_VERSION`: must equal the verifier's.
    pub rules: u32,
    /// The sim-core crate version (informational).
    pub crate_version: String,
    /// Git commit of the build, when the build knew it (informational).
    pub git: Option<String>,
}

impl SimVersion {
    pub fn current() -> SimVersion {
        SimVersion { rules: SIM_RULES_VERSION, crate_version: env!("CARGO_PKG_VERSION").to_string(), git: option_env!("ZT_GIT_HASH").map(str::to_string) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapSource {
    /// A whole level (`Match::new`): verified with the level file.
    Level,
    /// Streamed blocks (`Match::new_streaming`): verified with the chunks.
    Chunks,
}

/// The map a run was played on.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapRef {
    pub source: MapSource,
    /// `mapsnap::snapshot_hash` of the chunks the match held (chunks), or
    /// `mapsnap::level_snapshot_hash` (level).
    #[serde(with = "hex64")]
    pub snapshot_hash: u64,
    /// Block ids of those chunks, ascending (empty for a level).
    pub blocks: Vec<u64>,
    /// The level without buildings: centre (lat, lon), radius or bounds and
    /// fences. A chunks replay builds the match on it.
    pub shell: LevelPack,
}

/// The match setup (difficulty is `population_multiplier`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordSetup {
    #[serde(with = "u64_str")]
    pub seed: u64,
    pub population_multiplier: f32,
    pub deck: Vec<String>,
}

impl RecordSetup {
    pub fn to_setup(&self) -> MatchSetup {
        MatchSetup { seed: self.seed, population_multiplier: self.population_multiplier, deck: self.deck.clone() }
    }
}

/// A wave's latest attempt, as `Match::results` keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaveOutcome {
    pub wave: u8,
    pub won: bool,
    pub start_civilians: u32,
    pub end_civilians: u32,
    /// `end_civilians / start_civilians` (f32, as `WaveResult::saved`).
    pub saved: f32,
}

/// Where the record stops and the outcome summary.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunEnd {
    /// `Match::tick` when the record was taken: the replay steps exactly
    /// this far, never beyond.
    pub tick: u64,
    pub phase: Phase,
    pub wave: u8,
    /// The player left before the match was won. Required whenever `phase`
    /// is not `match_won`; `from_match` sets it from the phase.
    pub abandoned: bool,
    /// `Match::state_hash` at `tick`.
    #[serde(with = "hex64")]
    pub hash: u64,
    /// Prep hash and start tick of the attempt open at `tick`.
    #[serde(with = "hex64")]
    pub prep_hash: u64,
    pub attempt_start_tick: u64,
    pub waves_won: u32,
    pub retries: u32,
    pub restarts: u32,
    /// Per wave played, its latest attempt.
    pub waves: Vec<WaveOutcome>,
}

/// Everything needed to replay and verify a run.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunRecord {
    /// `RECORD_FORMAT`.
    pub format: u32,
    pub sim: SimVersion,
    /// `Config::content_hash`.
    #[serde(with = "hex64")]
    pub config_hash: u64,
    /// `CardDb::content_hash`.
    #[serde(with = "hex64")]
    pub cards_hash: u64,
    pub map: MapRef,
    pub setup: RecordSetup,
    /// Every accepted action with its tick, in order (retries, restarts and
    /// mulligans included).
    pub actions: Vec<LoggedAction>,
    /// Every wave attempt that ended (won, lost, abandoned by a retry or a
    /// restart), in order, with its hashes.
    pub attempts: Vec<WaveAttempt>,
    pub end: RunEnd,
}

/// The snapshot hash of a whole level's buildings (see `mapsnap`).
fn whole_level_hash(buildings: &[Building]) -> u64 {
    let c = BuildingChunk { block_id: 0, bounds: [0.0; 4], buildings: buildings.to_vec() };
    snapshot_hash(std::slice::from_ref(&c)).expect("one chunk")
}

fn outcome_of(m: &Match) -> (u32, Vec<WaveOutcome>) {
    let waves: Vec<WaveOutcome> =
        m.results().iter().map(|r| WaveOutcome { wave: r.wave, won: r.won, start_civilians: r.start_civilians, end_civilians: r.end_civilians, saved: r.saved() }).collect();
    (waves.iter().filter(|w| w.won).count() as u32, waves)
}

impl RunRecord {
    /// The record of a match so far. The match holds everything: its log,
    /// its attempts and its map (the chunks it stored, or the whole level).
    /// A match not yet won is marked `abandoned`. Costs one
    /// `Match::state_hash` (~24 ms at wave-8 size).
    pub fn from_match(m: &Match) -> RunRecord {
        let map = if m.is_whole_level() {
            let buildings = m.chunks().next().map_or(&[][..], |c| &c.buildings[..]);
            MapRef { source: MapSource::Level, snapshot_hash: whole_level_hash(buildings), blocks: Vec::new(), shell: m.shell().clone() }
        } else {
            let chunks: Vec<BuildingChunk> = m.chunks().cloned().collect();
            let snapshot_hash = snapshot_hash(&chunks).expect("a match holds each block once");
            MapRef { source: MapSource::Chunks, snapshot_hash, blocks: chunks.iter().map(|c| c.block_id).collect(), shell: m.shell().clone() }
        };
        let s = m.setup();
        let (waves_won, waves) = outcome_of(m);
        RunRecord {
            format: RECORD_FORMAT,
            sim: SimVersion::current(),
            config_hash: m.config().content_hash(),
            cards_hash: m.cards().content_hash(),
            map,
            setup: RecordSetup { seed: s.seed, population_multiplier: s.population_multiplier, deck: s.deck.clone() },
            actions: m.log().to_vec(),
            attempts: m.attempts().to_vec(),
            end: RunEnd {
                tick: m.tick(),
                phase: m.phase(),
                wave: m.wave(),
                abandoned: m.phase() != Phase::MatchWon,
                hash: m.state_hash(),
                prep_hash: m.prep_hash(),
                attempt_start_tick: m.attempt_start_tick(),
                waves_won,
                retries: m.retries(),
                restarts: m.restarts(),
                waves,
            },
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("record serialises")
    }
    pub fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(self).expect("record serialises")
    }
    pub fn from_json(s: &str) -> Result<RunRecord, String> {
        serde_json::from_str(s).map_err(|e| format!("run record: {e}"))
    }
}

// ------------------------------------------------------------------ replay

/// The map a replay runs on, **supplied by the verifier, never taken from
/// the record**: the level file, or the shell (the level without buildings:
/// centre, radius or bounds, fences) and the chunks (any order; the
/// record's blocks are picked out, extra chunks are ignored). Either way
/// the record's shell must equal the given one bit for bit (`map_shell`).
#[derive(Clone, Copy)]
pub enum ReplayMap<'a> {
    Level(&'a LevelPack),
    Chunks { shell: &'a LevelPack, chunks: &'a [BuildingChunk] },
}

/// What the server issued for this run (DECISIONS.md, "Run records (T4)"):
/// the seed it handed out, the deck it checked ownership of, and the
/// difficulty's multiplier. Each field given must equal the record's
/// (`unexpected`); `None` leaves it unchecked. JSON: `{"seed": "123" | 123,
/// "deck": [ids], "population_multiplier": 0.3}`, every key optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedRun {
    #[serde(default, with = "opt_seed", skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    /// The deck in setup order (the order before the first shuffle).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deck: Option<Vec<String>>,
    /// Compared bit for bit as an `f32`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub population_multiplier: Option<f32>,
}

impl ExpectedRun {
    pub fn from_json(s: &str) -> Result<ExpectedRun, String> {
        serde_json::from_str(s).map_err(|e| format!("expected run: {e}"))
    }

    /// No field given: nothing would be checked.
    pub fn is_empty(&self) -> bool {
        *self == ExpectedRun::default()
    }
}

/// Bounds that keep a replay cheap whatever the record says (DECISIONS.md,
/// "Run records (T4)"). Everything is checked before the first tick except
/// the per-phase lengths, which stop a wave or prep that runs too long.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayLimits {
    /// Most actions in the log.
    pub max_actions: usize,
    /// Most wave attempts (each retry or restart starts one).
    pub max_attempts: usize,
    /// Most match ticks (`end.tick`).
    pub max_ticks: u64,
    /// Most ticks one wave may run.
    pub max_wave_ticks: u64,
    /// Most ticks one prep may last.
    pub max_prep_ticks: u64,
    /// Most points in one polyline target.
    pub max_polyline_points: usize,
    /// Most buildings in one target / indices in one `keep_cards`.
    pub max_list_len: usize,
}

impl ReplayLimits {
    /// Seconds of game time per wave, per prep and for the whole match.
    pub const MAX_WAVE_S: u64 = 30 * 60;
    pub const MAX_PREP_S: u64 = 30 * 60;
    pub const MAX_MATCH_S: u64 = 4 * 3600;

    /// The default bounds at the config's tick rate: 30 min per wave and per
    /// prep, 4 h per match, 20,000 actions, 256 attempts, 1,024 points per
    /// polyline, 64 entries per list.
    pub fn for_config(cfg: &Config) -> ReplayLimits {
        let hz = cfg.tick_hz as u64;
        ReplayLimits {
            max_actions: 20_000,
            max_attempts: 256,
            max_ticks: ReplayLimits::MAX_MATCH_S * hz,
            max_wave_ticks: ReplayLimits::MAX_WAVE_S * hz,
            max_prep_ticks: ReplayLimits::MAX_PREP_S * hz,
            max_polyline_points: 1024,
            max_list_len: 64,
        }
    }
}

/// Reported to the progress callback every `PROGRESS_TICKS` ticks; the
/// callback returns `false` to stop the replay (`VerifyError::Cancelled`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ReplayProgress {
    pub tick: u64,
    pub end_tick: u64,
    pub wave: u8,
    pub attempts: usize,
}

pub const PROGRESS_TICKS: u64 = 256;

/// What a successful replay found (equal to the record's summary).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReplaySummary {
    /// The record's setup (seed, multiplier, deck): what the run was
    /// played with, for the server to store or check.
    pub setup: RecordSetup,
    /// Whether `setup` was checked against what the server issued: an
    /// `ExpectedRun` with at least one field was given (`replay_with`).
    /// `false` for `replay` and for `None` (tests and tools).
    pub setup_checked: bool,
    pub map_source: MapSource,
    /// `mapsnap::snapshot_hash` of the buildings replayed on (= the record's).
    #[serde(with = "hex64")]
    pub snapshot_hash: u64,
    /// `mapsnap::shell_hash` of the shell replayed on (the verifier's, equal
    /// bit for bit to the record's).
    #[serde(with = "hex64")]
    pub shell_hash: u64,
    pub phase: Phase,
    pub wave: u8,
    pub waves_won: u32,
    pub retries: u32,
    pub restarts: u32,
    pub abandoned: bool,
    pub end_tick: u64,
    pub attempts: usize,
    pub actions: usize,
    #[serde(with = "hex64")]
    pub final_hash: u64,
    /// End hash of every attempt, in order.
    pub attempt_hashes: Vec<String>,
    pub waves: Vec<WaveOutcome>,
}

/// Why a record was rejected. Serialised with an `error` tag.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum VerifyError {
    /// `format` is not `RECORD_FORMAT`.
    Format { record: u32, verifier: u32 },
    /// Recorded with other simulation rules.
    SimVersion { record: u32, verifier: u32 },
    ConfigHash { record: String, verifier: String },
    CardsHash { record: String, verifier: String },
    /// A level given for a chunks record or the reverse.
    MapSource { record: MapSource },
    /// The verifier's shell (the level's, or the one given with the chunks):
    /// radius, bounds, centre or fences differ from the record's.
    MapShell,
    /// The record's shell is over a `ShellLimits` bound or not finite.
    BadShell { reason: String },
    /// The record's seed, deck or multiplier (`what`) is not the one the
    /// server issued (`ExpectedRun`).
    Unexpected { what: String, record: String, expected: String },
    /// A block of the record is not among the chunks given.
    MissingBlock { block_id: u64 },
    /// The map content differs (or a block id is listed twice).
    MapHash { record: String, verifier: String },
    /// The match could not be built (bad deck, config, chunks...).
    Setup { reason: String },
    /// Inconsistent record (e.g. abandoned yet won).
    BadRecord { reason: String },
    /// Over a `ReplayLimits` bound.
    Limit { what: String, value: u64, max: u64 },
    /// An action's tick is before the previous action's.
    OutOfOrder { index: usize, tick: u64, previous: u64 },
    /// An action's tick is past the record's end.
    FutureTick { index: usize, tick: u64, end_tick: u64 },
    /// `Match::apply` refused the action (illegal play, wrong phase, supply...).
    IllegalAction { index: usize, tick: u64, action: String, reason: ActionError },
    /// A wave ran (or a prep lasted) longer than the limit.
    TooLong { attempt: usize, wave: u8, phase: Phase, ticks: u64, max: u64 },
    /// The replay differs from the record at this wave attempt (index into
    /// `attempts`; `attempts.len()` is the attempt open at the end). `what`:
    /// `wave`, `start_tick`, `prep_hash`, `end_tick`, `result`, `end_hash`,
    /// `extra_attempt`, `missing_attempt` or `final_hash`.
    Diverged { attempt: usize, wave: u8, tick: u64, what: String, record: String, replay: String },
    /// The record ends before the match is won without `abandoned`.
    Unfinished { phase: Phase, wave: u8 },
    /// The outcome summary differs from the replay's.
    Outcome { what: String, record: String, replay: String },
    /// The progress callback stopped the replay.
    Cancelled { tick: u64 },
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use VerifyError::*;
        match self {
            Format { record, verifier } => write!(f, "record format {record}, this verifier reads format {verifier}"),
            SimVersion { record, verifier } => write!(f, "recorded with sim rules version {record}, this verifier runs version {verifier}"),
            ConfigHash { record, verifier } => write!(f, "config hash {record} differs from the verifier's {verifier}"),
            CardsHash { record, verifier } => write!(f, "cards hash {record} differs from the verifier's {verifier}"),
            MapSource { record } => write!(f, "the run was played on {record:?} map data; give the matching --level, or --chunks with --shell"),
            MapShell => write!(f, "the map shell given (radius, bounds, centre or fences) differs from the record's"),
            BadShell { reason } => write!(f, "the record's map shell is out of bounds: {reason}"),
            Unexpected { what, record, expected } => write!(f, "the record's {what} is {record}, the server issued {expected}"),
            MissingBlock { block_id } => write!(f, "map block {block_id} of the run is not among the chunks given"),
            MapHash { record, verifier } => write!(f, "map snapshot hash {record} differs from the map given ({verifier})"),
            Setup { reason } => write!(f, "the match can't be built: {reason}"),
            BadRecord { reason } => write!(f, "bad record: {reason}"),
            Limit { what, value, max } => write!(f, "{what} {value} is over the verifier's limit {max}"),
            OutOfOrder { index, tick, previous } => write!(f, "action {index} at tick {tick} comes after tick {previous}"),
            FutureTick { index, tick, end_tick } => write!(f, "action {index} at tick {tick} is past the record's end (tick {end_tick})"),
            IllegalAction { index, tick, action, reason } => write!(f, "action {index} ({action}) at tick {tick} is illegal: {reason}"),
            TooLong { attempt, wave, phase, ticks, max } => write!(f, "attempt {attempt} (wave {wave}) stayed in {phase:?} for {ticks} ticks, the limit is {max}"),
            Diverged { attempt, wave, tick, what, record, replay } => {
                write!(f, "diverged at attempt {attempt} (wave {wave}), tick {tick}: {what} is {replay} in the replay, {record} in the record")
            }
            Unfinished { phase, wave } => write!(f, "the record ends in {phase:?} at wave {wave} without being marked abandoned"),
            Outcome { what, record, replay } => write!(f, "outcome {what}: record says {record}, replay gives {replay}"),
            Cancelled { tick } => write!(f, "replay cancelled at tick {tick}"),
        }
    }
}

impl std::error::Error for VerifyError {}

/// Verify `record` on `map` with the embedded config and cards and the
/// default limits.
/// No `ExpectedRun`: the seed, deck and multiplier are only checked by the
/// replay itself (tests, tools; a server uses `replay_with` with one).
pub fn replay(record: &RunRecord, map: ReplayMap) -> Result<ReplaySummary, VerifyError> {
    let cfg = Config::default_config();
    let limits = ReplayLimits::for_config(&cfg);
    replay_with(record, map, None, cfg, CardDb::default_cards(), &limits, &mut |_| true)
}

fn shells_equal(a: &LevelPack, b: &LevelPack) -> bool {
    let bits = |v: Option<f32>| v.map(f32::to_bits);
    let fbits = |f: &Vec<Vec<[f32; 2]>>| f.iter().map(|l| l.iter().map(|p| (p[0].to_bits(), p[1].to_bits())).collect::<Vec<_>>()).collect::<Vec<_>>();
    a.center_lat.to_bits() == b.center_lat.to_bits()
        && a.center_lon.to_bits() == b.center_lon.to_bits()
        && bits(a.radius_m) == bits(b.radius_m)
        && a.bounds.map(|x| x.map(f32::to_bits)) == b.bounds.map(|x| x.map(f32::to_bits))
        && fbits(&a.fences) == fbits(&b.fences)
}

/// Checks that need no simulation: format, version, limits, action sizes
/// and order, the end marker, the config and cards hashes, the record
/// shell's bounds and the expected setup.
fn precheck(record: &RunRecord, expected: Option<&ExpectedRun>, cfg: &Config, cards: &CardDb, lim: &ReplayLimits) -> Result<(), VerifyError> {
    if record.format != RECORD_FORMAT {
        return Err(VerifyError::Format { record: record.format, verifier: RECORD_FORMAT });
    }
    if record.sim.rules != SIM_RULES_VERSION {
        return Err(VerifyError::SimVersion { record: record.sim.rules, verifier: SIM_RULES_VERSION });
    }
    let limit = |what: &str, value: usize, max: usize| if value > max { Err(VerifyError::Limit { what: what.to_string(), value: value as u64, max: max as u64 }) } else { Ok(()) };
    limit("actions", record.actions.len(), lim.max_actions)?;
    limit("attempts", record.attempts.len(), lim.max_attempts)?;
    let restarts = record.actions.iter().filter(|a| matches!(a.action, Action::RetryWave | Action::RestartMatch)).count();
    limit("retries and restarts", restarts, lim.max_attempts)?;
    if record.end.tick > lim.max_ticks {
        return Err(VerifyError::Limit { what: "ticks".into(), value: record.end.tick, max: lim.max_ticks });
    }
    limit("waves in the summary", record.end.waves.len(), 64)?;
    let mut prev = 0u64;
    for (index, la) in record.actions.iter().enumerate() {
        let len = match &la.action {
            Action::PlayCard { target: Target::Polyline(p), .. } => limit("polyline points", p.len(), lim.max_polyline_points).map(|_| 0),
            Action::PlayCard { target: Target::Buildings(b), .. } => Ok(b.len()),
            Action::KeepCards { hand_indices } => Ok(hand_indices.len()),
            _ => Ok(0),
        }?;
        limit("list entries", len, lim.max_list_len)?;
        if la.tick < prev {
            return Err(VerifyError::OutOfOrder { index, tick: la.tick, previous: prev });
        }
        if la.tick > record.end.tick {
            return Err(VerifyError::FutureTick { index, tick: la.tick, end_tick: record.end.tick });
        }
        prev = la.tick;
    }
    match (record.end.phase, record.end.abandoned) {
        (Phase::MatchWon, true) => return Err(VerifyError::BadRecord { reason: "a won match is marked abandoned".into() }),
        (p, false) if p != Phase::MatchWon => return Err(VerifyError::Unfinished { phase: p, wave: record.end.wave }),
        _ => {}
    }
    if record.config_hash != cfg.content_hash() {
        return Err(VerifyError::ConfigHash { record: hex(record.config_hash), verifier: hex(cfg.content_hash()) });
    }
    if record.cards_hash != cards.content_hash() {
        return Err(VerifyError::CardsHash { record: hex(record.cards_hash), verifier: hex(cards.content_hash()) });
    }
    ShellLimits::for_config(cfg).check(&record.map.shell).map_err(|reason| VerifyError::BadShell { reason })?;
    if let Some(x) = expected {
        let s = &record.setup;
        let unexpected = |what: &str, record: String, expected: String| Err(VerifyError::Unexpected { what: what.into(), record, expected });
        if let Some(seed) = x.seed.filter(|&v| v != s.seed) {
            return unexpected("seed", s.seed.to_string(), seed.to_string());
        }
        if let Some(deck) = x.deck.as_ref().filter(|d| **d != s.deck) {
            return unexpected("deck", format!("{:?}", s.deck), format!("{deck:?}"));
        }
        if let Some(k) = x.population_multiplier.filter(|k| k.to_bits() != s.population_multiplier.to_bits()) {
            return unexpected("population_multiplier", s.population_multiplier.to_string(), k.to_string());
        }
    }
    Ok(())
}

/// Check the map against the record and build the match.
fn build_match(record: &RunRecord, map: ReplayMap, cfg: Config, cards: CardDb) -> Result<Match, VerifyError> {
    let setup = record.setup.to_setup();
    let mh = |verifier: u64| VerifyError::MapHash { record: hex(record.map.snapshot_hash), verifier: hex(verifier) };
    let built = match (record.map.source, map) {
        (MapSource::Level, ReplayMap::Level(level)) => {
            if !shells_equal(level, &record.map.shell) || !record.map.blocks.is_empty() {
                return Err(VerifyError::MapShell);
            }
            let h = whole_level_hash(&level.buildings);
            if h != record.map.snapshot_hash {
                return Err(mh(h));
            }
            Match::new_with_cards(level, cfg, cards, setup)
        }
        (MapSource::Chunks, ReplayMap::Chunks { shell, chunks }) => {
            // The verifier's shell, never the record's: compared first, so a
            // forged radius, centre or fence set is refused, and the match
            // is built on the verifier's copy.
            if !shells_equal(shell, &record.map.shell) {
                return Err(VerifyError::MapShell);
            }
            let blocks = &record.map.blocks;
            if blocks.windows(2).any(|w| w[0] >= w[1]) {
                return Err(VerifyError::BadRecord { reason: "map blocks must be ascending and unique".into() });
            }
            let mut picked: Vec<BuildingChunk> = Vec::with_capacity(blocks.len());
            for &id in blocks {
                let mut found = chunks.iter().filter(|c| c.block_id == id);
                let c = found.next().ok_or(VerifyError::MissingBlock { block_id: id })?;
                if found.next().is_some() {
                    return Err(VerifyError::Setup { reason: format!("block {id} given twice") });
                }
                picked.push(c.clone());
            }
            let h = snapshot_hash(&picked).expect("unique ids");
            if h != record.map.snapshot_hash {
                return Err(mh(h));
            }
            Match::new_streaming_with_cards(shell, cfg, cards, setup, picked)
        }
        (source, _) => return Err(VerifyError::MapSource { record: source }),
    };
    built.map_err(|e| VerifyError::Setup { reason: e.to_string() })
}

/// The replay's bookkeeping: which recorded attempts were matched so far
/// and how long the current phase has lasted.
struct Checker<'r> {
    rec: &'r RunRecord,
    lim: &'r ReplayLimits,
    /// Attempts of the replay compared so far.
    verified: usize,
    /// (phase, wave, attempts) when the current phase was entered, and the
    /// tick it was entered on.
    phase_key: (Phase, u8, usize),
    phase_since: u64,
}

fn diverged(attempt: usize, wave: u8, tick: u64, what: &str, record: String, replay: String) -> VerifyError {
    VerifyError::Diverged { attempt, wave, tick, what: what.to_string(), record, replay }
}

impl<'r> Checker<'r> {
    /// The attempt that just opened (phase Prep): its wave, start tick and
    /// prep hash against the record (the final open attempt's are in `end`).
    fn check_prep(&self, m: &Match) -> Result<(), VerifyError> {
        let i = m.attempts().len();
        let (wave, start, prep) = match self.rec.attempts.get(i) {
            Some(a) => (a.wave, a.start_tick, a.prep_hash),
            None => (self.rec.end.wave, self.rec.end.attempt_start_tick, self.rec.end.prep_hash),
        };
        let t = m.tick();
        if wave != m.wave() {
            return Err(diverged(i, m.wave(), t, "wave", wave.to_string(), m.wave().to_string()));
        }
        if start != m.attempt_start_tick() {
            return Err(diverged(i, wave, t, "start_tick", start.to_string(), m.attempt_start_tick().to_string()));
        }
        if prep != m.prep_hash() {
            return Err(diverged(i, wave, t, "prep_hash", hex(prep), hex(m.prep_hash())));
        }
        Ok(())
    }

    /// Attempts the replay finished since the last call, against the record.
    fn check_finished(&mut self, m: &Match) -> Result<(), VerifyError> {
        while self.verified < m.attempts().len() {
            let i = self.verified;
            let a = &m.attempts()[i];
            let t = m.tick();
            let Some(r) = self.rec.attempts.get(i) else {
                return Err(diverged(i, a.wave, t, "extra_attempt", "none".into(), format!("{:?} at tick {}", a.result, a.end_tick)));
            };
            if r.wave != a.wave {
                return Err(diverged(i, a.wave, t, "wave", r.wave.to_string(), a.wave.to_string()));
            }
            if r.start_tick != a.start_tick {
                return Err(diverged(i, a.wave, t, "start_tick", r.start_tick.to_string(), a.start_tick.to_string()));
            }
            if r.prep_hash != a.prep_hash {
                return Err(diverged(i, a.wave, t, "prep_hash", hex(r.prep_hash), hex(a.prep_hash)));
            }
            if r.end_tick != a.end_tick {
                return Err(diverged(i, a.wave, t, "end_tick", r.end_tick.to_string(), a.end_tick.to_string()));
            }
            if r.result != a.result {
                return Err(diverged(i, a.wave, t, "result", format!("{:?}", r.result), format!("{:?}", a.result)));
            }
            if r.end_hash != a.end_hash {
                return Err(diverged(i, a.wave, t, "end_hash", hex(r.end_hash), hex(a.end_hash)));
            }
            self.verified += 1;
        }
        if m.attempts().len() > self.lim.max_attempts {
            return Err(VerifyError::Limit { what: "attempts".into(), value: m.attempts().len() as u64, max: self.lim.max_attempts as u64 });
        }
        Ok(())
    }

    /// After a tick: the next recorded attempt should have ended by now, and
    /// the current wave or prep must not run past its limit.
    fn check_tick(&mut self, m: &Match) -> Result<(), VerifyError> {
        self.check_finished(m)?;
        let t = m.tick();
        if let Some(r) = self.rec.attempts.get(self.verified) {
            if t > r.end_tick {
                return Err(diverged(self.verified, r.wave, t, "end_tick", r.end_tick.to_string(), format!("not over at tick {t}")));
            }
        }
        let key = (m.phase(), m.wave(), m.attempts().len());
        if key != self.phase_key {
            self.phase_key = key;
            self.phase_since = t;
        }
        let max = match m.phase() {
            Phase::Running => self.lim.max_wave_ticks,
            Phase::Prep => self.lim.max_prep_ticks,
            _ => u64::MAX,
        };
        let ticks = t - self.phase_since;
        if ticks > max {
            return Err(VerifyError::TooLong { attempt: m.attempts().len(), wave: m.wave(), phase: m.phase(), ticks, max });
        }
        Ok(())
    }
}

/// Verify `record` on `map` with this config and card list. `progress` is
/// called every `PROGRESS_TICKS` ticks and stops the replay when it returns
/// `false`. `expected` is what the server issued (seed, deck, multiplier).
/// Rejections, in the order they are checked: format, sim version, limits,
/// action sizes and tick order, the end marker, config and cards hashes,
/// the record shell's bounds, the expected setup, the map, then while
/// replaying refused actions, overlong waves or preps and the first
/// diverging attempt, and finally the end state and the outcome summary.
pub fn replay_with(
    record: &RunRecord,
    map: ReplayMap,
    expected: Option<&ExpectedRun>,
    cfg: Config,
    cards: CardDb,
    lim: &ReplayLimits,
    progress: &mut dyn FnMut(ReplayProgress) -> bool,
) -> Result<ReplaySummary, VerifyError> {
    precheck(record, expected, &cfg, &cards, lim)?;
    let shell_hash = shell_hash(match map {
        ReplayMap::Level(level) => level,
        ReplayMap::Chunks { shell, .. } => shell,
    });
    let mut m = build_match(record, map, cfg, cards)?;
    let mut ck = Checker { rec: record, lim, verified: 0, phase_key: (m.phase(), m.wave(), 0), phase_since: 0 };
    ck.check_prep(&m)?;
    let end = record.end.tick;
    let mut step_to = |m: &mut Match, ck: &mut Checker, t: u64| -> Result<(), VerifyError> {
        while m.tick() < t {
            m.step();
            ck.check_tick(m)?;
            if m.tick() % PROGRESS_TICKS == 0 && !progress(ReplayProgress { tick: m.tick(), end_tick: end, wave: m.wave(), attempts: m.attempts().len() }) {
                return Err(VerifyError::Cancelled { tick: m.tick() });
            }
        }
        Ok(())
    };
    for (index, la) in record.actions.iter().enumerate() {
        step_to(&mut m, &mut ck, la.tick)?;
        m.apply(la.action.clone()).map_err(|reason| VerifyError::IllegalAction { index, tick: la.tick, action: la.action.name().to_string(), reason })?;
        if matches!(la.action, Action::NextWave | Action::RetryWave | Action::RestartMatch) {
            ck.check_finished(&m)?;
            ck.check_prep(&m)?;
        }
        ck.check_tick(&m)?;
    }
    step_to(&mut m, &mut ck, end)?;
    ck.check_finished(&m)?;
    if let Some(r) = record.attempts.get(ck.verified) {
        return Err(diverged(ck.verified, r.wave, end, "missing_attempt", format!("{:?} at tick {}", r.result, r.end_tick), "none".into()));
    }
    let n = m.attempts().len();
    let e = &record.end;
    if e.phase != m.phase() || e.wave != m.wave() {
        return Err(diverged(n, m.wave(), end, "phase", format!("{:?} wave {}", e.phase, e.wave), format!("{:?} wave {}", m.phase(), m.wave())));
    }
    // The open attempt's start tick and prep hash: checked when its prep
    // opened only if the record ends in that prep or wave; a record ending
    // on a result screen is checked here.
    if e.attempt_start_tick != m.attempt_start_tick() {
        return Err(diverged(n, m.wave(), end, "start_tick", e.attempt_start_tick.to_string(), m.attempt_start_tick().to_string()));
    }
    if e.prep_hash != m.prep_hash() {
        return Err(diverged(n, m.wave(), end, "prep_hash", hex(e.prep_hash), hex(m.prep_hash())));
    }
    let final_hash = m.state_hash();
    if e.hash != final_hash {
        return Err(diverged(n, m.wave(), end, "final_hash", hex(e.hash), hex(final_hash)));
    }
    let (waves_won, waves) = outcome_of(&m);
    let out = |what: &str, r: String, p: String| if r != p { Err(VerifyError::Outcome { what: what.into(), record: r, replay: p }) } else { Ok(()) };
    out("waves_won", e.waves_won.to_string(), waves_won.to_string())?;
    out("retries", e.retries.to_string(), m.retries().to_string())?;
    out("restarts", e.restarts.to_string(), m.restarts().to_string())?;
    out("waves", format!("{:?}", e.waves), format!("{waves:?}"))?;
    Ok(ReplaySummary {
        setup: record.setup.clone(),
        setup_checked: expected.is_some_and(|x| !x.is_empty()),
        map_source: record.map.source,
        snapshot_hash: record.map.snapshot_hash,
        shell_hash,
        phase: m.phase(),
        wave: m.wave(),
        waves_won,
        retries: m.retries(),
        restarts: m.restarts(),
        abandoned: e.abandoned,
        end_tick: end,
        attempts: n,
        actions: record.actions.len(),
        final_hash,
        attempt_hashes: m.attempts().iter().map(|a| hex(a.end_hash)).collect(),
        waves,
    })
}
