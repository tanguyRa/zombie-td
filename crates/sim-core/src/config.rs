//! Every tunable number of the simulation. Loaded from `config.default.json`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    pub tick_hz: u32,
    pub cell_size_m: f32,
    pub target_population: u32,
    pub outbreak_clusters: u32,
    pub outbreak_radius_m: f32,
    pub outbreak_min_separation_m: f32,
    pub outbreak_min_per_cluster: u32,
    pub infection_delay_ticks: u16,
    pub civilian_wander_speed: f32,
    pub civilian_flee_speed: f32,
    pub zombie_speed: f32,
    pub zombie_hp: u16,
    pub bite_radius_m: f32,
    pub bite_cooldown_ticks: u8,
    pub wake_radius_m: f32,
    pub field_interval_ticks: u32,
    pub fence_path_cost: i32,
    pub fence_cell_hp: f32,
    pub zombie_fence_dps: f32,
    pub max_game_seconds: u32,

    pub tower_budget: u32,
    pub fence_budget_m: f32,
    pub tower_range_m: f32,
    pub tower_fire_rate: f32,
    pub tower_damage: u16,

    pub grid_margin_m: f32,
    pub spawn_radius_m: f32,
    pub hash_bucket_m: f32,
    pub dormant_period_ticks: u32,
    pub wander_turn_chance: f32,
    pub velocity_keep: f32,
    pub flee_multiplier: f32,
    pub flee_threat_cap_m: f32,
    pub zombie_seek_radius_m: f32,
    pub separation_radius_m: f32,
    pub separation_max_neighbors: u32,
    pub separation_max_scan: u32,
    pub dead_visible_seconds: f32,
}

/// The repository's `config.default.json`, embedded so tests and the WASM
/// build always have the defaults without touching the file system.
pub const DEFAULT_CONFIG_JSON: &str = include_str!("../../../config.default.json");

impl Config {
    pub fn from_json(s: &str) -> Result<Config, String> {
        serde_json::from_str(s).map_err(|e| format!("config: {e}"))
    }
    pub fn default_config() -> Config {
        Config::from_json(DEFAULT_CONFIG_JSON).expect("config.default.json is valid")
    }
    pub fn dt(&self) -> f32 {
        1.0 / self.tick_hz as f32
    }
    /// Field cost units per meter (a straight step of one cell costs 10).
    pub fn cost_per_m(&self) -> f32 {
        10.0 / self.cell_size_m
    }
    pub fn tower_period_ticks(&self) -> u32 {
        ((self.tick_hz as f32 / self.tower_fire_rate).round() as u32).max(1)
    }
    pub fn max_ticks(&self) -> u32 {
        self.max_game_seconds * self.tick_hz
    }
}
