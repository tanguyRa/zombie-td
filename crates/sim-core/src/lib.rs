//! Zombie TD simulation core. Pure logic, no I/O: shared by the headless
//! runner (native) and the browser (WASM).

pub mod cards;
pub mod config;
pub mod fixture;
pub mod field;
pub mod grid;
pub mod level;
pub mod mapsnap;
pub mod match_;
pub mod record;
pub mod rng;
pub mod sim;

pub use cards::{validate_deck, CardDb, DeckError};
pub use config::Config;
pub use level::LevelPack;
pub use match_::{Action, ActionError, BuildingChunk, Match, MatchSetup, Phase, Target};
pub use record::{replay, ExpectedRun, ReplayCheck, ReplayMap, ReplayStep, ReplaySummary, Replayer, RunRecord, VerifyError};
pub use sim::{GamePhase, Outcome, Sim};
