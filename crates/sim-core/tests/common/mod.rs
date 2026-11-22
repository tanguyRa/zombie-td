#![allow(dead_code)]
use sim_core::{Config, LevelPack};

pub fn level(name: &str) -> LevelPack {
    let path = format!("{}/../../levels/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let s = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    LevelPack::from_json(&s).unwrap()
}

pub fn cfg() -> Config {
    Config::default_config()
}
pub mod bot;
