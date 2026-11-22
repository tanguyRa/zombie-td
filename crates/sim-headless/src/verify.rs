//! `sim-headless verify <run.json> (--level <level> | --chunks <chunks.json>
//! --shell <shell>) [--expect-seed N] [--expect-deck a,b,...]
//! [--expect-multiplier K]`: replay a run record and check every wave hash
//! (sim-core `record`). The map always comes from the verifier: a level, or
//! the shell and the chunks; the `--expect-*` flags are what the server
//! issued. Exit code 0 when the run verifies, 1 when it is rejected, 2 on
//! bad arguments (an unknown flag, a flag given twice, a stray argument)
//! or unreadable files.

use std::time::Instant;

use sim_core::match_::BuildingChunk;
use sim_core::record::{replay_with, ExpectedRun, ReplayLimits, ReplayMap, ReplayProgress, RunRecord};

use crate::common::*;

const USAGE: &str = "usage: sim-headless verify <run.json> (--level <level.json|name> | --chunks <chunks.json> --shell <shell.json|level name>) \
[--expect-seed N] [--expect-deck id,id,... | --expect-deck deck.json] [--expect-multiplier K] [--max-ticks N] [--quiet]";

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

/// Flags that take a value, and flags that don't.
const VALUED: &[&str] = &["--level", "--chunks", "--shell", "--expect-seed", "--expect-deck", "--expect-multiplier", "--max-ticks"];
const SWITCHES: &[&str] = &["--quiet"];

/// The parsed command line: the run path, then every flag given once.
/// Anything else (an unknown flag, a flag given twice, a stray positional,
/// a flag without its value) is a usage error: an expectation must never be
/// silently dropped or overridden.
struct Args {
    run: String,
    values: std::collections::HashMap<&'static str, String>,
    switches: std::collections::HashSet<&'static str>,
}

impl Args {
    fn parse(args: &[String]) -> Args {
        let Some(run) = args.get(1).filter(|a| !a.starts_with("--")) else { fail(USAGE.into()) };
        let mut out = Args { run: run.clone(), values: Default::default(), switches: Default::default() };
        let mut it = args[2..].iter();
        while let Some(a) = it.next() {
            if let Some(&name) = VALUED.iter().find(|&&n| n == a) {
                let v = match it.next() {
                    Some(v) if !v.starts_with("--") => v.clone(),
                    _ => fail(format!("{name} needs a value\n{USAGE}")),
                };
                if out.values.insert(name, v).is_some() {
                    fail(format!("{name} given twice\n{USAGE}"));
                }
            } else if let Some(&name) = SWITCHES.iter().find(|&&n| n == a) {
                if !out.switches.insert(name) {
                    fail(format!("{name} given twice\n{USAGE}"));
                }
            } else if a.starts_with("--") {
                fail(format!("unknown flag {a}\n{USAGE}"));
            } else {
                fail(format!("unexpected argument {a:?}\n{USAGE}"));
            }
        }
        out
    }

    fn flag(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    /// Like `flag`, parsed; a value that doesn't parse is a usage error.
    fn parsed<T: std::str::FromStr>(&self, name: &str) -> Option<T>
    where
        T::Err: std::fmt::Display,
    {
        self.flag(name).map(|v| v.parse().unwrap_or_else(|e| fail(format!("{name} {v:?}: {e}"))))
    }
}

/// `--expect-*`: `None` when no flag is given.
fn expected_arg(args: &Args) -> Option<ExpectedRun> {
    let deck = args.flag("--expect-deck").map(|v| {
        if std::path::Path::new(v).is_file() {
            serde_json::from_str::<Vec<String>>(&read(v)).unwrap_or_else(|e| fail(format!("{v}: {e}")))
        } else {
            v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
        }
    });
    let x = ExpectedRun { seed: args.parsed("--expect-seed"), deck, population_multiplier: args.parsed("--expect-multiplier") };
    (!x.is_empty()).then_some(x)
}

pub fn cmd(args: &[String]) {
    let args = Args::parse(args);
    let record = RunRecord::from_json(&read(&args.run)).unwrap_or_else(|e| fail(e));
    let level = args.flag("--level");
    let chunks_path = args.flag("--chunks");
    let shell_arg = args.flag("--shell");
    let expected = expected_arg(&args);
    let quiet = args.switches.contains("--quiet");
    let cfg = load_config();
    let mut limits = ReplayLimits::for_config(&cfg);
    if let Some(t) = args.parsed("--max-ticks") {
        limits.max_ticks = t;
    }
    let level_pack;
    let shell;
    let chunks: Vec<BuildingChunk>;
    let map = match (level, chunks_path, shell_arg) {
        (Some(level), None, None) => {
            level_pack = level_arg(level);
            ReplayMap::Level(&level_pack)
        }
        (None, Some(path), Some(s)) => {
            // A shell file, or a level whose buildings are dropped.
            let mut pack = level_arg(s);
            pack.buildings.clear();
            shell = pack;
            chunks = serde_json::from_str(&read(path)).unwrap_or_else(|e| fail(format!("{path}: {e}")));
            ReplayMap::Chunks { shell: &shell, chunks: &chunks }
        }
        _ => fail(format!("give either --level, or --chunks and --shell\n{USAGE}")),
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
    match replay_with(&record, map, expected.as_ref(), cfg, load_cards(), &limits, &mut progress) {
        Ok(s) => {
            println!("{}", serde_json::to_string_pretty(&s).unwrap());
            println!(
                "verified: {:?} at wave {}, {} waves won, {} retries ({} restarts), {} attempts, {} ticks, {:.2}s{}",
                s.phase,
                s.wave,
                s.waves_won,
                s.retries,
                s.restarts,
                s.attempts,
                s.end_tick,
                t0.elapsed().as_secs_f64(),
                if s.setup_checked { "" } else { " (seed, deck and multiplier not checked against an issued run: --expect-*)" }
            );
        }
        Err(e) => {
            println!("{}", serde_json::to_string(&e).unwrap());
            println!("rejected: {e}");
            std::process::exit(1);
        }
    }
}
