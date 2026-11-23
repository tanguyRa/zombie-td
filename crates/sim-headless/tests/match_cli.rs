//! `sim-headless match` plays the 8-wave match with the starter deck.
//! Seed 1 on the Marais clears all 8 waves without a retry (DECISIONS.md,
//! "Cards (T3)", balance table).
use std::process::Command;

#[test]
fn scripted_starter_deck_match_clears_the_marais() {
    let out = Command::new(env!("CARGO_BIN_EXE_sim-headless")).args(["match", "--level", "paris-marais", "--seed", "1", "--retries", "3"]).output().expect("run sim-headless");
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{s}\n{}", String::from_utf8_lossy(&out.stderr));
    assert!(s.contains("starter deck"), "{s}");
    let rows: Vec<&str> = s.lines().filter(|l| l.starts_with("| ") && l.as_bytes()[2].is_ascii_digit()).collect();
    assert_eq!(rows.len(), 8, "8 waves, no retry needed:\n{s}");
    assert!(rows.iter().all(|r| r.contains("| won |")), "{s}");
    assert!(s.contains("phase MatchWon at wave 8/8"), "{s}");
    // Cards were played every wave.
    for r in &rows {
        let cols: Vec<&str> = r.split('|').map(|c| c.trim()).collect();
        assert!(cols[11].parse::<u32>().unwrap() >= 1, "no card played: {r}");
    }
}

/// `match --record` writes a run record that `verify` accepts; a tampered
/// copy is rejected (exit 1) and names the diverging attempt.
#[test]
fn recorded_match_verifies_and_tampering_is_rejected() {
    let dir = std::env::temp_dir().join(format!("zt-verify-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let run = dir.join("run.json");
    let bin = env!("CARGO_BIN_EXE_sim-headless");
    let out = Command::new(bin).args(["match", "--level", "paris-marais", "--seed", "2", "--retries", "1", "--max-wave-s", "300", "--record"]).arg(&run).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let level = concat!(env!("CARGO_MANIFEST_DIR"), "/../../levels/paris-marais.json");
    let out = Command::new(bin).arg("verify").arg(&run).args(["--level", level, "--quiet"]).output().unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{s}\n{}", String::from_utf8_lossy(&out.stderr));
    assert!(s.contains("verified: "), "{s}");
    assert!(s.contains("\"setup_checked\": false") && s.contains("not checked against an issued run"), "{s}");
    // The issued seed, deck and multiplier: accepted when they match.
    let deck = sim_core::CardDb::default_cards().starter_deck_ids().join(",");
    let out = Command::new(bin).arg("verify").arg(&run).args(["--level", "paris-marais", "--quiet", "--expect-seed", "2", "--expect-multiplier", "0.3", "--expect-deck", &deck]).output().unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{s}\n{}", String::from_utf8_lossy(&out.stderr));
    assert!(s.contains("\"seed\": \"2\""), "the summary echoes the setup: {s}");
    assert!(s.contains("\"setup_checked\": true") && !s.contains("not checked"), "{s}");
    // A typo'd flag, a repeated flag or a stray argument is a usage error
    // (exit 2), never an expectation silently skipped or overridden.
    for (extra, why) in [
        (&["--expect-sed", "4"][..], "unknown flag --expect-sed"),
        (&["--expect-seed", "3", "--expect-seed", "2"][..], "--expect-seed given twice"),
        (&["--expect-seed", "2", "3"][..], "unexpected argument \"3\""),
        (&["--quiet"][..], "--quiet given twice"),
        (&["--level", "paris-marais"][..], "--level given twice"),
    ] {
        let out = Command::new(bin).arg("verify").arg(&run).args(["--level", "paris-marais", "--quiet"]).args(extra).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{extra:?}: {err}");
        assert!(err.contains(why) && err.contains("usage:"), "{extra:?}: {err}");
        assert!(out.stdout.is_empty(), "{extra:?}: nothing verified");
    }
    // Another seed issued: rejected before any tick.
    let out = Command::new(bin).arg("verify").arg(&run).args(["--level", "paris-marais", "--quiet", "--expect-seed", "3"]).output().unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{s}");
    assert!(s.contains("\"error\":\"unexpected\"") && s.contains("seed is 2, the server issued 3"), "{s}");
    // An expectation that doesn't parse is a usage error, never skipped.
    let out = Command::new(bin).arg("verify").arg(&run).args(["--level", "paris-marais", "--expect-seed", "x"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    // Edit the first attempt's end hash.
    let mut r: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&run).unwrap()).unwrap();
    let h = r["attempts"][0]["end_hash"].as_str().unwrap().to_string();
    let flipped = format!("{:016x}", u64::from_str_radix(&h, 16).unwrap() ^ 1);
    r["attempts"][0]["end_hash"] = serde_json::Value::String(flipped);
    let bad = dir.join("bad.json");
    std::fs::write(&bad, r.to_string()).unwrap();
    let out = Command::new(bin).arg("verify").arg(&bad).args(["--level", "paris-marais", "--quiet"]).output().unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{s}");
    assert!(s.contains("rejected: diverged at attempt 0 (wave 1)") && s.contains("end_hash"), "{s}");
    // Both or neither map argument, or chunks without a shell: usage error.
    let out = Command::new(bin).arg("verify").arg(&run).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    let out = Command::new(bin).arg("verify").arg(&run).args(["--chunks", "x.json"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    std::fs::remove_dir_all(&dir).ok();
}

/// `verify --chunks --shell`: a streamed run verifies on the server's shell
/// file and the T6a chunks; the record's own shell, forged, is refused.
#[test]
fn streamed_run_verifies_with_a_shell_file() {
    let dir = std::env::temp_dir().join(format!("zt-verify-chunks-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let fx = concat!(env!("CARGO_MANIFEST_DIR"), "/../sim-core/tests/fixtures");
    let chunks_path = format!("{fx}/map_chunks.json");
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{fx}/map_chunks.meta.json")).unwrap()).unwrap();
    let shell_json = serde_json::json!({ "name": "map-chunks", "center_lat": meta["center_lat"], "center_lon": meta["center_lon"], "radius_m": meta["level_radius_m"], "buildings": [] });
    let shell_path = dir.join("shell.json");
    std::fs::write(&shell_path, shell_json.to_string()).unwrap();
    let shell = sim_core::LevelPack::from_json(&shell_json.to_string()).unwrap();
    let chunks: Vec<sim_core::match_::BuildingChunk> = serde_json::from_str(&std::fs::read_to_string(&chunks_path).unwrap()).unwrap();
    let cfg = sim_core::Config::default_config();
    let mut m = sim_core::match_::Match::new_streaming(&shell, cfg.clone(), sim_core::match_::MatchSetup::new(5, &cfg), chunks).unwrap();
    for _ in 0..30 {
        m.step();
    }
    m.apply(sim_core::match_::Action::StartWave).unwrap();
    for _ in 0..60 {
        m.step();
    }
    let rec = sim_core::RunRecord::from_match(&m);
    let run = dir.join("run.json");
    std::fs::write(&run, rec.to_json()).unwrap();
    let bin = env!("CARGO_BIN_EXE_sim-headless");
    let verify = |run: &std::path::Path, extra: &[&str]| {
        let out = Command::new(bin).arg("verify").arg(run).args(["--chunks", &chunks_path, "--shell"]).arg(&shell_path).arg("--quiet").args(extra).output().unwrap();
        (out.status.code(), String::from_utf8_lossy(&out.stdout).to_string())
    };
    let (code, s) = verify(&run, &["--expect-seed", "5"]);
    assert_eq!(code, Some(0), "{s}");
    assert!(s.contains("\"map_source\": \"chunks\"") && s.contains("\"shell_hash\""), "{s}");
    // A map bundle (the browser's "Download map"): the shell with the
    // chunks in it, given as both --chunks and --shell.
    let mut bundle = shell_json.clone();
    bundle["fences"] = serde_json::json!([]);
    bundle["chunks"] = serde_json::from_str(&std::fs::read_to_string(&chunks_path).unwrap()).unwrap();
    let bundle_path = dir.join("map.json");
    std::fs::write(&bundle_path, bundle.to_string()).unwrap();
    let out = Command::new(bin).arg("verify").arg(&run).arg("--chunks").arg(&bundle_path).arg("--shell").arg(&bundle_path).arg("--quiet").output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stdout));
    // A wrong --chunks file: the error is the one of the form it is in
    // (an object is a bundle, anything else a list).
    for (name, body, why) in [
        ("no-chunks.json", "{\"name\": \"x\"}", "(map bundle: missing field `chunks`"),
        ("bad-bundle.json", "{\"name\": \"x\", \"chunks\": [{\"block_id\": 1}]}", "(map bundle: missing field `bounds`"),
        ("bad-list.json", "[{\"block_id\": 1}]", "(chunk list: missing field `bounds`"),
        ("number.json", "3", "(chunk list: invalid type: integer `3`"),
        ("garbage.json", "{not json", "(invalid JSON: key must be a string"),
    ] {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        let out = Command::new(bin).arg("verify").arg(&run).arg("--chunks").arg(&p).arg("--shell").arg(&shell_path).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{name}: {err}");
        assert!(err.contains("not a chunk list or a map bundle") && err.contains(why), "{name}: {err}");
    }
    let mut forged = rec.clone();
    forged.map.shell.radius_m = Some(160.0);
    let bad = dir.join("forged.json");
    std::fs::write(&bad, forged.to_json()).unwrap();
    let (code, s) = verify(&bad, &[]);
    assert_eq!(code, Some(1), "{s}");
    assert!(s.contains("\"error\":\"map_shell\""), "{s}");
    std::fs::remove_dir_all(&dir).ok();
}

/// `tools/verify-run.mjs` refuses the same bad arguments with exit 2. Its
/// arguments are parsed before the WASM package is loaded, so this needs
/// Node but not a `pkg-node` build; skipped when `node` isn't on the PATH.
#[test]
fn verify_run_mjs_rejects_bad_arguments() {
    let tool = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/verify-run.mjs");
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node not found: verify-run.mjs argument check skipped");
        return;
    }
    for (args, why) in [
        (&["run.json", "--level", "l.json", "--expect-sed", "4"][..], "unknown flag --expect-sed"),
        (&["run.json", "--level", "l.json", "--expect-seed", "3", "--expect-seed", "4"][..], "--expect-seed given twice"),
        (&["run.json", "--level", "l.json", "stray"][..], "unexpected argument \"stray\""),
        (&["run.json", "--level", "l.json", "--quiet"][..], "unknown flag --quiet"),
        (&["run.json", "--level"][..], "--level needs a value"),
        (&["run.json", "--level", "l.json", "--expect-seed", "x"][..], "--expect-seed \"x\""),
        (&["run.json", "--level", "l.json", "--expect-multiplier", ""][..], "--expect-multiplier \"\""),
        (&["run.json", "--chunks", "c.json"][..], "give either --level"),
        (&["--level", "l.json"][..], "usage:"),
    ] {
        let out = Command::new("node").arg(tool).args(args).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{args:?}: {err}");
        assert!(err.contains(why) && err.contains("usage:"), "{args:?}: {err}");
    }
    // A --chunks file that is neither a chunk list nor a map bundle (read
    // before the WASM package is loaded, so no build is needed either).
    let dir = std::env::temp_dir().join(format!("zt-verify-run-mjs-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for (name, body, why) in [
        ("no-chunks.json", "{\"name\": \"x\"}", "(map bundle: no `chunks` array)"),
        ("number.json", "3", "(neither an array nor an object)"),
        ("garbage.json", "{not json", "(invalid JSON: "),
    ] {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        let p = p.to_str().unwrap();
        let out = Command::new("node").arg(tool).args(["run.json", "--chunks", p, "--shell", "s.json"]).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{name}: {err}");
        assert!(err.contains(&format!("{p}: not a chunk list or a map bundle {why}")), "{name}: {err}");
    }
    std::fs::remove_dir_all(&dir).ok();
}

/// `sim-headless verify` and `tools/verify-run.mjs` read numbers with one
/// grammar: a seed is `^\d+$` (up to 2^64 - 1), a multiplier a plain
/// decimal `^\d+(\.\d+)?$`. Each refused value is a usage error (exit 2,
/// naming the flag) in both, before any file is read; accepted values get
/// past the argument check in both.
#[test]
fn both_verifiers_share_one_number_grammar() {
    let bin = env!("CARGO_BIN_EXE_sim-headless");
    let tool = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/verify-run.mjs");
    let node = Command::new("node").arg("--version").output().is_ok();
    let huge = format!("1{}", "0".repeat(400));
    let bad: Vec<(&str, &str)> = [
        ("--expect-seed", vec!["", "+3", "-1", " 3", "3 ", "0x1", "1e3", "3.0", "18446744073709551616"]),
        ("--expect-multiplier", vec!["", "+0.3", "-0.3", " 0.3", ".3", "3.", "0x1", "1e-1", "inf", "NaN", huge.as_str()]),
    ]
    .into_iter()
    .flat_map(|(f, vs)| vs.into_iter().map(move |v| (f, v)))
    .collect();
    for (flag, v) in &bad {
        let out = Command::new(bin).args(["verify", "missing-run.json", "--level", "paris-marais", flag, v]).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "verify {flag} {v:?}: {err}");
        assert!(err.contains(&format!("{flag} {v:?}: ")), "verify {flag} {v:?}: {err}");
        if node {
            let out = Command::new("node").arg(tool).args(["missing-run.json", "--level", "l.json", flag, v]).output().unwrap();
            let err = String::from_utf8_lossy(&out.stderr);
            assert_eq!(out.status.code(), Some(2), "verify-run.mjs {flag} {v:?}: {err}");
            assert!(err.contains(&format!("{flag} {v:?}: ")), "verify-run.mjs {flag} {v:?}: {err}");
        }
    }
    // Accepted values reach the next step (reading the run file).
    for (flag, v) in [("--expect-seed", "0"), ("--expect-seed", "18446744073709551615"), ("--expect-multiplier", "0.3"), ("--expect-multiplier", "1")] {
        let out = Command::new(bin).args(["verify", "missing-run.json", "--level", "paris-marais", flag, v]).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains("missing-run.json") && !err.contains(flag), "verify {flag} {v:?}: {err}");
        if node {
            let out = Command::new("node").arg(tool).args(["missing-run.json", "--level", "l.json", flag, v]).output().unwrap();
            let err = String::from_utf8_lossy(&out.stderr);
            assert!(!err.contains("usage:") && !err.contains(flag), "verify-run.mjs {flag} {v:?}: {err}");
        }
    }
    if !node {
        eprintln!("node not found: the verify-run.mjs half of the grammar check was skipped");
    }
}
