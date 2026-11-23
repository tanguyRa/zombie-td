//! `sim-headless verify <run.json> (--level <level> | --chunks <chunks.json>
//! --shell <shell>) [--expect-seed N] [--expect-deck a,b,...]
//! [--expect-multiplier K]`: replay a run record and check every wave hash
//! (sim-core `record`). The map always comes from the verifier: a level, or
//! the shell and the chunks; the `--expect-*` flags are what the server
//! issued. `--chunks` takes a `BuildingChunk[]` or a map bundle (the
//! browser's "Download map": a shell with a `chunks` array, so the same
//! file is also the `--shell`). Exit code 0 when the run verifies, 1 when it is rejected, 2 on
//! bad arguments (an unknown flag, a flag given twice, a stray argument)
//! or unreadable files.

use std::time::Instant;

use sim_core::match_::BuildingChunk;
use sim_core::record::{replay_with, ExpectedRun, ReplayLimits, ReplayMap, ReplayProgress, RunRecord, SetupChecked};

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

/// A `BuildingChunk[]`, or a map bundle `{ ..shell, "chunks": [...] }`.
/// A JSON object is read as a bundle and anything else as a list, so the
/// error is the one of the form the file is in.
fn chunks_arg(path: &str) -> Vec<BuildingChunk> {
    #[derive(serde::Deserialize)]
    struct Bundle {
        chunks: Vec<BuildingChunk>,
    }
    let text = read(path);
    let bad = |what: &str, e: serde_json::Error| -> ! { fail(format!("{path}: not a chunk list or a map bundle ({what}: {e})")) };
    // Only the form is taken from this parse; the chunks are read from the text.
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| bad("invalid JSON", e));
    if v.is_object() {
        serde_json::from_str::<Bundle>(&text).unwrap_or_else(|e| bad("map bundle", e)).chunks
    } else {
        serde_json::from_str::<Vec<BuildingChunk>>(&text).unwrap_or_else(|e| bad("chunk list", e))
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

    /// A whole number (`^\d+$`, no sign, no spaces, no `0x`), as a `u64`;
    /// anything else, or a value over `u64::MAX`, is a usage error.
    fn integer(&self, name: &str) -> Option<u64> {
        self.flag(name).map(|v| parse_integer(v).unwrap_or_else(|e| fail(format!("{name} {v:?}: {e}"))))
    }

    /// A plain decimal (`^\d+(\.\d+)?$`: no sign, exponent, `inf`, `nan`
    /// or hex), as an `f32`; anything else is a usage error.
    fn decimal(&self, name: &str) -> Option<f32> {
        self.flag(name).map(|v| parse_decimal(v).unwrap_or_else(|e| fail(format!("{name} {v:?}: {e}"))))
    }
}

/// The one number grammar of `verify` and `tools/verify-run.mjs` (same
/// rules, same tests): seeds and tick counts are `^\d+$`.
pub fn parse_integer(v: &str) -> Result<u64, String> {
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return Err("not a whole number (digits only)".into());
    }
    v.parse::<u64>().map_err(|_| "over 18446744073709551615".into())
}

/// Multipliers are a plain decimal, `^\d+(\.\d+)?$`.
pub fn parse_decimal(v: &str) -> Result<f32, String> {
    let (int, frac) = v.split_once('.').unwrap_or((v, "1"));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(int) || !digits(frac) {
        return Err("not a plain decimal number (digits, optionally a point and more digits)".into());
    }
    let k: f32 = v.parse().map_err(|e| format!("{e}"))?;
    if !k.is_finite() {
        return Err("too large".into());
    }
    Ok(k)
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
    let x = ExpectedRun { seed: args.integer("--expect-seed"), deck, population_multiplier: args.decimal("--expect-multiplier") };
    (!x.is_empty()).then_some(x)
}

/// The verdict line's note on the setup fields not compared with an issued
/// run ("" when all three were: `setup_checked`).
fn not_checked_note(c: &SetupChecked) -> String {
    let missing: Vec<&str> = [(c.seed, "seed"), (c.deck, "deck"), (c.population_multiplier, "multiplier")].iter().filter(|(on, _)| !on).map(|(_, n)| *n).collect();
    if missing.is_empty() {
        return String::new();
    }
    format!(" ({} not checked against an issued run: --expect-*)", missing.join(", "))
}

pub fn cmd(args: &[String]) {
    let args = Args::parse(args);
    // Every flag value is checked before any file is read.
    let expected = expected_arg(&args);
    let max_ticks = args.integer("--max-ticks");
    let record = RunRecord::from_json(&read(&args.run)).unwrap_or_else(|e| fail(e));
    let level = args.flag("--level");
    let chunks_path = args.flag("--chunks");
    let shell_arg = args.flag("--shell");
    let quiet = args.switches.contains("--quiet");
    let cfg = load_config();
    let mut limits = ReplayLimits::for_config(&cfg);
    if let Some(t) = max_ticks {
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
            chunks = chunks_arg(path);
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
                not_checked_note(&s.checked)
            );
        }
        Err(e) => {
            println!("{}", serde_json::to_string(&e).unwrap());
            println!("rejected: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_decimal, parse_integer};

    /// The grammar shared with `tools/verify-run.mjs` (the CLI test runs the
    /// same values through both).
    #[test]
    fn numbers_are_digits_or_a_plain_decimal() {
        for (v, want) in [("0", Some(0)), ("2", Some(2)), ("007", Some(7)), ("18446744073709551615", Some(u64::MAX))] {
            assert_eq!(parse_integer(v).ok(), want, "{v:?}");
        }
        for v in ["", "+3", "-1", " 3", "3 ", "0x1", "1e3", "3.0", "18446744073709551616", "\u{663}"] {
            assert!(parse_integer(v).is_err(), "{v:?} must be refused");
        }
        for (v, want) in [("0.3", 0.3f32), ("1", 1.0), ("0.375", 0.375), ("2.50", 2.5)] {
            assert_eq!(parse_decimal(v).map(f32::to_bits), Ok(want.to_bits()), "{v:?}");
        }
        let huge = format!("1{}", "0".repeat(400));
        for v in ["", "+0.3", "-0.3", " 0.3", "0.3 ", ".3", "3.", "0x1", "1e-1", "1E2", "inf", "NaN", "0.3.1", huge.as_str()] {
            assert!(parse_decimal(v).is_err(), "{v:?} must be refused");
        }
    }
}
