//! `sim-headless verify <run.json> --level <level> | --chunks <chunks.json>`:
//! replay a run record and check every wave hash (sim-core `record`).
//! Exit code 0 when the run verifies, 1 when it is rejected, 2 on bad
//! arguments or unreadable files.

use std::time::Instant;

use sim_core::match_::BuildingChunk;
use sim_core::record::{replay_with, ReplayLimits, ReplayMap, ReplayProgress, RunRecord};

use crate::common::*;

fn fail(msg: String) -> ! {
    eprintln!("verify: {msg}");
    std::process::exit(2);
}

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| fail(format!("{path}: {e}")))
}

/// A level by file path, or by name (`levels/<name>.json`, `marais-tiled:<r>`).
fn level_arg(s: &str) -> sim_core::LevelPack {
    if std::path::Path::new(s).is_file() {
        sim_core::LevelPack::from_json(&read(s)).unwrap_or_else(|e| fail(e))
    } else {
        crate::matchcmd::load_any_level(s)
    }
}

pub fn cmd(args: &[String]) {
    let Some(run) = args.get(1).filter(|a| !a.starts_with("--")) else {
        fail("usage: sim-headless verify <run.json> (--level <level.json|name> | --chunks <chunks.json>) [--max-ticks N] [--quiet]".into())
    };
    let record = RunRecord::from_json(&read(run)).unwrap_or_else(|e| fail(e));
    let level: String = crate::arg(args, "--level", String::new());
    let chunks_path: String = crate::arg(args, "--chunks", String::new());
    let quiet = args.iter().any(|a| a == "--quiet");
    let cfg = load_config();
    let mut limits = ReplayLimits::for_config(&cfg);
    limits.max_ticks = crate::arg(args, "--max-ticks", limits.max_ticks);
    let level_pack;
    let chunks: Vec<BuildingChunk>;
    let map = match (level.is_empty(), chunks_path.is_empty()) {
        (false, true) => {
            level_pack = level_arg(&level);
            ReplayMap::Level(&level_pack)
        }
        (true, false) => {
            chunks = serde_json::from_str(&read(&chunks_path)).unwrap_or_else(|e| fail(format!("{chunks_path}: {e}")));
            ReplayMap::Chunks(&chunks)
        }
        _ => fail("give exactly one of --level and --chunks".into()),
    };
    let t0 = Instant::now();
    let mut last = 0u64;
    let mut progress = |p: ReplayProgress| {
        if !quiet && p.end_tick > 0 && p.tick * 10 / p.end_tick > last {
            last = p.tick * 10 / p.end_tick;
            eprintln!("[verify] tick {}/{} (wave {}, {} attempts), {:.1}s", p.tick, p.end_tick, p.wave, p.attempts, t0.elapsed().as_secs_f64());
        }
        true
    };
    match replay_with(&record, map, cfg, load_cards(), &limits, &mut progress) {
        Ok(s) => {
            println!("{}", serde_json::to_string_pretty(&s).unwrap());
            println!(
                "verified: {:?} at wave {}, {} waves won, {} retries ({} restarts), {} attempts, {} ticks, {:.2}s",
                s.phase,
                s.wave,
                s.waves_won,
                s.retries,
                s.restarts,
                s.attempts,
                s.end_tick,
                t0.elapsed().as_secs_f64()
            );
        }
        Err(e) => {
            println!("{}", serde_json::to_string(&e).unwrap());
            println!("rejected: {e}");
            std::process::exit(1);
        }
    }
}
