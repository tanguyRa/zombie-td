use std::path::PathBuf;
use std::time::Instant;

use sim_core::sim::Clock;
use sim_core::{Config, LevelPack};

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

pub fn load_level(name: &str) -> LevelPack {
    match name {
        "walled_compound" => sim_core::level::walled_compound(),
        _ => {
            let p = repo_root().join("levels").join(format!("{name}.json"));
            let s = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            LevelPack::from_json(&s).unwrap()
        }
    }
}

pub fn load_config() -> Config {
    let p = repo_root().join("config.default.json");
    Config::from_json(&std::fs::read_to_string(p).expect("config.default.json")).unwrap()
}

pub struct WallClock(Instant);
impl WallClock {
    pub fn new() -> WallClock {
        WallClock(Instant::now())
    }
}
impl Clock for WallClock {
    fn now_ms(&mut self) -> f64 {
        self.0.elapsed().as_secs_f64() * 1000.0
    }
}

pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}
