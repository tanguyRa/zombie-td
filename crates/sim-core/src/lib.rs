//! Zombie TD simulation core. Pure logic, no I/O: shared by the headless
//! runner (native) and the browser (WASM).

pub mod config;
pub mod fixture;
pub mod field;
pub mod grid;
pub mod level;
pub mod match_;
pub mod rng;
pub mod sim;

pub use config::Config;
pub use level::LevelPack;
pub use match_::{Action, ActionError, BuildingChunk, Match, MatchSetup, Phase};
pub use sim::{GamePhase, Outcome, Sim};
