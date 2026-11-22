//! Zombie TD simulation core. Pure logic, no I/O: shared by the headless
//! runner (native) and the browser (WASM).

pub mod config;
pub mod field;
pub mod grid;
pub mod level;
pub mod rng;
pub mod sim;

pub use config::Config;
pub use level::LevelPack;
pub use sim::{GamePhase, Outcome, Sim};
