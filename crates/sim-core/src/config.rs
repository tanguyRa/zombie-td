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
    pub kill_flash_seconds: f32,

    /// Playable radius of the last (8th) wave, in meters. The match loop (T2)
    /// grows the rings up to it. Chosen in T1 from the scale benchmarks.
    pub wave8_radius_m: f32,
    /// Most agents a match may hold (every civilian, zombie and corpse of
    /// all waves). Agent arrays are sized for it up front (T2).
    pub max_population: u32,

    /// The 8-wave match (`Match`, T2).
    #[serde(rename = "match")]
    pub match_: MatchConfig,
}

/// Match rules. Every per-wave list has one entry per wave (8).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MatchConfig {
    /// Playable radius of each wave, in meters from the level centre. The
    /// last entry must equal `wave8_radius_m`. Levels smaller than the wave-8
    /// cap squeeze the rings (see `Match::ring_radii`).
    pub ring_radius_m: Vec<f32>,
    /// Civilians per unit of building weight (area × floors × density by
    /// kind), before difficulty. Tuned so a 1.3 km disc of Marais-like
    /// density holds about `max_population`.
    pub population_multiplier: f32,
    /// A wave is lost when civilians drop below this share of the wave's
    /// starting civilians.
    pub defeat_fraction: f32,
    /// Outbreak clusters per wave.
    pub outbreak_clusters: Vec<u32>,
    /// Of those, clusters placed inside earlier territory (the rest are in
    /// the newly revealed ring). Wave 1 places everything at random.
    pub inner_outbreaks: Vec<u32>,
    /// Cluster size per wave: every civilian within this radius of a seed...
    pub outbreak_radius_m: Vec<f32>,
    /// ...or at least this many (the nearest).
    pub outbreak_min_per_cluster: Vec<u32>,
    /// Civilian speed multiplier by seconds since the wave started:
    /// `[seconds, factor]` points, linear in between, flat before the first
    /// and after the last. Zombies are not affected.
    pub fatigue_curve: Vec<[f32; 2]>,
    /// How far a block's buildings may stick out of its bounds (per axis). A
    /// reveal applies the blocks whose bounds come within its radius + this
    /// margin; a ring is ready once every cell within its radius + this
    /// margin + one cell diagonal is covered, so all of them have arrived
    /// (`match_::ring_band_m`).
    pub block_margin_m: f32,

    // Cards and supply (T3).
    /// Cards drawn at every prep.
    pub hand_draw: u32,
    /// Unplayed cards kept into the next wave (the rest are discarded).
    pub hand_keep: u32,
    /// Supply before wave 1's income.
    pub supply_start: u32,
    /// Supply granted when each wave's prep opens.
    pub supply_base_income: u32,
    /// +1 supply per this many civilians saved in a wave (per wave, paid
    /// into the next wave's prep).
    pub supply_civilians_per_point: Vec<u32>,
    /// Supply cost of the one mulligan per wave.
    pub mulligan_cost: u32,
    /// Repairing a fence costs `ceil(card cost × this × damaged share)`.
    pub repair_cost_factor: f32,
    /// Pulling down a structure from an earlier wave refunds
    /// `floor(card cost × this × condition)` (condition: fence hp left).
    pub pull_down_refund: f32,
}

impl MatchConfig {
    pub fn validate(&self, wave8_radius_m: f32) -> Result<(), String> {
        let w = self.ring_radius_m.len();
        if w == 0 {
            return Err("match.ring_radius_m is empty".into());
        }
        for (name, len) in [
            ("outbreak_clusters", self.outbreak_clusters.len()),
            ("inner_outbreaks", self.inner_outbreaks.len()),
            ("outbreak_radius_m", self.outbreak_radius_m.len()),
            ("outbreak_min_per_cluster", self.outbreak_min_per_cluster.len()),
            ("supply_civilians_per_point", self.supply_civilians_per_point.len()),
        ] {
            if len != w {
                return Err(format!("match.{name} has {len} entries, ring_radius_m has {w}"));
            }
        }
        if self.ring_radius_m.windows(2).any(|p| p[1] <= p[0]) || self.ring_radius_m[0] <= 0.0 {
            return Err("match.ring_radius_m must be positive and increasing".into());
        }
        if self.ring_radius_m[w - 1] != wave8_radius_m {
            return Err(format!("match.ring_radius_m ends at {} but wave8_radius_m is {wave8_radius_m}", self.ring_radius_m[w - 1]));
        }
        if self.inner_outbreaks.iter().zip(&self.outbreak_clusters).any(|(i, c)| i > c) {
            return Err("match.inner_outbreaks exceeds outbreak_clusters".into());
        }
        if !(self.block_margin_m >= 0.0) {
            return Err("match.block_margin_m must be >= 0".into());
        }
        if self.supply_civilians_per_point.contains(&0) {
            return Err("match.supply_civilians_per_point must be > 0".into());
        }
        if !(self.repair_cost_factor >= 0.0) || !(0.0..=1.0).contains(&self.pull_down_refund) {
            return Err("match.repair_cost_factor must be >= 0 and pull_down_refund in [0, 1]".into());
        }
        if self.fatigue_curve.windows(2).any(|p| p[1][0] <= p[0][0]) {
            return Err("match.fatigue_curve times must increase".into());
        }
        Ok(())
    }

    /// Fatigue factor `t` seconds into a wave.
    pub fn fatigue_at(&self, t: f32) -> f32 {
        let c = &self.fatigue_curve;
        match c.first() {
            None => 1.0,
            Some(&[t0, f0]) if t <= t0 => f0,
            _ => {
                for p in c.windows(2) {
                    let ([ta, fa], [tb, fb]) = (p[0], p[1]);
                    if t <= tb {
                        return fa + (fb - fa) * ((t - ta) / (tb - ta));
                    }
                }
                c[c.len() - 1][1]
            }
        }
    }
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
        self.period_ticks(self.tower_fire_rate)
    }
    /// Ticks between shots at `rate` shots per second (at least 1).
    pub fn period_ticks(&self, rate: f32) -> u32 {
        ((self.tick_hz as f32 / rate).round() as u32).max(1)
    }
    /// Ticks in `s` seconds, rounded.
    pub fn ticks(&self, s: f32) -> u32 {
        (s * self.tick_hz as f32).round().max(0.0) as u32
    }
    /// The single-wave tower (and the base of the Rifles card).
    pub fn tower_weapon(&self) -> crate::sim::Weapon {
        crate::sim::Weapon { range_m: self.tower_range_m, min_range_m: 0.0, damage: self.tower_damage, period_ticks: self.tower_period_ticks(), splash_m: 0.0 }
    }
    pub fn max_ticks(&self) -> u32 {
        self.max_game_seconds * self.tick_hz
    }
}
