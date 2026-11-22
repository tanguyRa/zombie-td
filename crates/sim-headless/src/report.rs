//! `sim-headless report`: runs tests, scenarios and benchmarks (native and
//! WASM under Node), then writes reports/headless-report.{md,html} plus the
//! raw JSON and CSV files.
//!
//! Options: --quick (2 seeds, no S5, 600 bench ticks, small scale run),
//! --skip-tests, --skip-wasm, --skip-scale.

use std::fmt::Write as _;
use std::path::Path;
use std::process::Command;

use serde::Serialize;
use sim_core::sim::PHASES;

use crate::bench::{self, BenchRun, BenchSummary};
use crate::charts::{self, Series};
use crate::scale;
use crate::common::*;
use crate::scenarios::{self, RunResult, SCENARIOS};

pub const TARGET_NATIVE_P95: f64 = 15.0;
pub const TARGET_NATIVE_MAX: f64 = 30.0;
pub const TARGET_WASM_P95: f64 = 25.0;
pub const TARGET_WASM_MAX: f64 = 45.0;

#[derive(Clone, Debug, Serialize)]
pub struct TestCase {
    pub group: String,
    pub name: String,
    pub ok: bool,
}

#[derive(Clone, Debug, Serialize)]
struct Target {
    name: String,
    target: String,
    measured: String,
    pass: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
struct Env {
    host_cpu: String,
    container_cpu: String,
    cores: usize,
    os: String,
    rustc: String,
    node: String,
    git_commit: String,
    generated: String,
}

fn sh(cmd: &str, args: &[&str]) -> (bool, String) {
    match Command::new(cmd).args(args).current_dir(repo_root()).output() {
        Ok(o) => (o.status.success(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))),
        Err(e) => (false, format!("could not run {cmd}: {e}")),
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

fn group_of(running_line: &str) -> String {
    let l = running_line;
    if l.contains("tests/m1_level.rs") {
        "M1 level".into()
    } else if l.contains("tests/m2_rules.rs") {
        "M2 rules".into()
    } else if l.contains("tests/m3_tools.rs") {
        "M3 tools".into()
    } else if l.contains("tests/t1_scale.rs") {
        "T1 scale".into()
    } else if l.contains("native_equals_wasm") {
        "Native = WASM".into()
    } else if l.contains("sim_core") || l.contains("sim-core") {
        "sim-core unit".into()
    } else {
        "other".into()
    }
}

/// Parse libtest output ("Running <file>" headers, "test name ... ok" lines).
pub fn parse_tests(out: &str, default_group: &str) -> Vec<TestCase> {
    let mut group = default_group.to_string();
    let mut v = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if t.starts_with("Running ") {
            group = group_of(t);
            if group == "other" {
                group = default_group.to_string();
            }
        } else if let Some(rest) = t.strip_prefix("test ") {
            if let Some((name, res)) = rest.rsplit_once(" ... ") {
                let res = res.trim();
                if res == "ok" || res.starts_with("FAILED") {
                    v.push(TestCase { group: group.clone(), name: name.trim().to_string(), ok: res == "ok" });
                }
            }
        }
    }
    v
}

fn environment() -> Env {
    let container_cpu = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("model name")).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string()))
        .or_else(|| {
            let (_, o) = sh("lscpu", &[]);
            o.lines().find(|l| l.starts_with("Model name")).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string())
        })
        .filter(|s| !s.is_empty() && s != "-")
        .map(|s| format!("{s} ({})", std::env::consts::ARCH))
        .unwrap_or_else(|| format!("{} (model not exposed inside the container)", std::env::consts::ARCH));
    let os = std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("PRETTY_NAME=")).map(|l| l[12..].trim_matches('"').to_string()))
        .unwrap_or_else(|| std::env::consts::OS.to_string());
    let kernel = first_line(&sh("uname", &["-rm"]).1);
    let (_, commit) = sh("git", &["rev-parse", "--short", "HEAD"]);
    let (_, dirty) = sh("git", &["status", "--porcelain", "--untracked-files=no"]);
    let (_, date) = sh("date", &["-u", "+%Y-%m-%d %H:%M UTC"]);
    Env {
        host_cpu: std::env::var("HOST_CPU").unwrap_or_else(|_| "unknown (set HOST_CPU)".into()),
        container_cpu,
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        os: format!("{os} ({kernel})"),
        rustc: first_line(&sh("rustc", &["--version"]).1),
        node: first_line(&sh("node", &["--version"]).1),
        git_commit: format!("{}{}", first_line(&commit), if dirty.trim().is_empty() { "" } else { " (with uncommitted changes)" }),
        generated: first_line(&date),
    }
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}
fn stat3(v: &[f64]) -> (f64, f64, f64) {
    if v.is_empty() {
        return (f64::NAN, f64::NAN, f64::NAN);
    }
    (mean(v), v.iter().copied().fold(f64::MAX, f64::min), v.iter().copied().fold(f64::MIN, f64::max))
}
fn fmt3(v: &[f64], unit: &str, total: usize) -> String {
    if v.is_empty() {
        return "never".into();
    }
    let (m, lo, hi) = stat3(v);
    let never = if v.len() < total { format!(" ({} of {} never)", total - v.len(), total) } else { String::new() };
    format!("{m:.0}{unit} ({lo:.0}–{hi:.0}){never}")
}

struct ScenarioRow {
    id: String,
    level: String,
    defense: String,
    population: u32,
    outcomes: String,
    survival: String,
    t50: String,
    t90: String,
    killed: String,
    breach: String,
}

fn scenario_rows(runs: &[RunResult]) -> Vec<ScenarioRow> {
    let mut rows = Vec::new();
    for sc in SCENARIOS.iter() {
        let rs: Vec<&RunResult> = runs.iter().filter(|r| r.id == sc.id).collect();
        if rs.is_empty() {
            continue;
        }
        let n = rs.len();
        let mut counts = Vec::new();
        for o in ["win", "loss", "timeout"] {
            let c = rs.iter().filter(|r| r.outcome == o).count();
            if c > 0 {
                counts.push(format!("{c}× {o}"));
            }
        }
        let surv: Vec<f64> = rs.iter().map(|r| r.survival * 100.0).collect();
        let t50: Vec<f64> = rs.iter().filter_map(|r| r.t50).collect();
        let t90: Vec<f64> = rs.iter().filter_map(|r| r.t90).collect();
        let killed: Vec<f64> = rs.iter().map(|r| r.zombies_killed as f64).collect();
        let breach: Vec<f64> = rs.iter().filter_map(|r| r.first_breach_s).collect();
        let (sm, slo, shi) = stat3(&surv);
        rows.push(ScenarioRow {
            id: sc.id.into(),
            level: sc.level.into(),
            defense: sc.defense.into(),
            population: sc.population,
            outcomes: counts.join(", "),
            survival: format!("{sm:.1}% ({slo:.1}–{shi:.1})"),
            t50: fmt3(&t50, " s", n),
            t90: fmt3(&t90, " s", n),
            killed: if sc.id == "S2" { fmt3(&killed, "", n) } else { "—".into() },
            breach: if sc.id == "S3" { fmt3(&breach, " s", n) } else { "—".into() },
        });
    }
    rows
}

/// Mean civilians / infected / zombies per second over seeds (ended runs hold their last value).
fn scenario_series(runs: &[RunResult], id: &str) -> Vec<Series> {
    let rs: Vec<&RunResult> = runs.iter().filter(|r| r.id == id).collect();
    let len = rs.iter().map(|r| r.series.len()).max().unwrap_or(0);
    let mut out = Vec::new();
    for (col, name, var) in [(1usize, "civilians", "--civ"), (2, "infected", "--inf"), (3, "zombies", "--zom")] {
        let pts = (0..len)
            .map(|k| {
                let v: Vec<f64> = rs.iter().map(|r| r.series.get(k).or(r.series.last()).map_or(0.0, |row| row[col])).collect();
                (k as f64, mean(&v))
            })
            .collect();
        out.push(Series { name: name.into(), color_var: var, points: pts });
    }
    out
}

fn phase_series(run: &BenchRun) -> Vec<Series> {
    // 5-tick means keep the SVG small; the max column in the table keeps the spikes.
    let groups: [(&str, &[usize], &'static str); 7] = [
        ("separation", &[5], "--series-1"),
        ("fields", &[1], "--series-2"),
        ("hash", &[0], "--series-3"),
        ("civilians", &[2], "--series-4"),
        ("zombies", &[3], "--series-5"),
        ("integrate", &[6], "--series-6"),
        ("other (infected, towers, fences)", &[4, 7, 8], "--series-7"),
    ];
    let step = 5;
    groups
        .iter()
        .map(|(name, idx, var)| {
            let pts = run
                .phase_ms
                .chunks(step)
                .enumerate()
                .map(|(k, ch)| {
                    let v: f64 = ch.iter().map(|p| idx.iter().map(|&i| p[i]).sum::<f64>()).sum::<f64>() / ch.len() as f64;
                    ((k * step) as f64, v)
                })
                .collect();
            Series { name: name.to_string(), color_var: var, points: pts }
        })
        .collect()
}

fn hot_spots(s: &BenchSummary) -> Vec<(String, f64)> {
    let total: f64 = s.phase_mean.iter().map(|p| p.1).sum::<f64>().max(1e-9);
    let mut v: Vec<(String, f64)> = s.phase_mean.iter().map(|(n, m)| (n.clone(), m / total * 100.0)).collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    v.truncate(3);
    v
}

pub fn run(args: &[String]) {
    let quick = args.iter().any(|a| a == "--quick");
    let skip_tests = args.iter().any(|a| a == "--skip-tests");
    let skip_wasm = args.iter().any(|a| a == "--skip-wasm");
    let root = repo_root();
    let reports = root.join("reports");
    std::fs::create_dir_all(reports.join("scenarios")).unwrap();

    // ---------------------------------------------------------- tests
    let mut tests: Vec<TestCase> = Vec::new();
    let mut test_notes = Vec::new();
    if !skip_tests {
        eprintln!("[report] cargo test --release --workspace");
        // libtest prints "Running <file>" to stderr and results to stdout:
        // merge them in order so each test lands in its file's group.
        let (ok, out) = sh("sh", &["-c", "cargo test --release --workspace --no-fail-fast 2>&1"]);
        tests.extend(parse_tests(&out, "sim-core unit"));
        if !ok {
            test_notes.push("cargo test reported failures (see table)".to_string());
        }
        if !skip_wasm {
            eprintln!("[report] wasm-pack test --node --release crates/sim-wasm");
            let (ok, out) = sh("sh", &["-c", "wasm-pack test --node --release crates/sim-wasm 2>&1"]);
            let mut w = parse_tests(&out, "Native = WASM");
            for t in &mut w {
                t.group = "Native = WASM".into();
            }
            if w.is_empty() {
                w.push(TestCase { group: "Native = WASM".into(), name: "wasm-pack test --node".into(), ok });
            }
            tests.extend(w);
        }
    }

    // ------------------------------------------------------ scenarios
    let seeds = if quick { 2 } else { 5 };
    eprintln!("[report] scenarios ({seeds} seeds each)");
    let only = if quick { Some("S1,S2,S3,S4") } else { None };
    let runs = scenarios::run_all(seeds, only);
    for r in &runs {
        std::fs::write(reports.join("scenarios").join(format!("{}_seed{}.csv", r.id, r.seed)), r.csv()).unwrap();
    }
    let runs_json: Vec<serde_json::Value> = runs
        .iter()
        .map(|r| {
            let mut v = serde_json::to_value(r).unwrap();
            v.as_object_mut().unwrap().remove("series");
            v
        })
        .collect();
    std::fs::write(reports.join("scenarios.json"), serde_json::to_string_pretty(&runs_json).unwrap()).unwrap();

    // ------------------------------------------------------ benchmarks
    let ticks = if quick { 600 } else { bench::BENCH_TICKS };
    let mut bench_runs: Vec<BenchRun> = Vec::new();
    for &p in &bench::BENCH_POPS {
        eprintln!("[report] native bench {p} agents, {ticks} ticks");
        bench_runs.push(bench::run_native(p, ticks));
    }
    let mut wasm_note = None;
    if !skip_wasm {
        eprintln!("[report] building WASM for Node");
        let (ok, out) = sh("wasm-pack", &["build", "crates/sim-wasm", "--release", "--target", "nodejs", "--out-dir", "pkg-node"]);
        if !ok {
            wasm_note = Some(format!("WASM build failed: {}", out.lines().rev().take(5).collect::<Vec<_>>().join(" | ")));
        } else {
            eprintln!("[report] WASM bench under Node");
            let raw = std::env::temp_dir().join("zombie-td-bench-wasm.json");
            let pops = bench::BENCH_POPS.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
            let (ok, out) = sh("node", &["tools/wasm-bench.mjs", "--pops", &pops, "--ticks", &ticks.to_string(), "--out", raw.to_str().unwrap()]);
            match (ok, std::fs::read_to_string(&raw)) {
                (true, Ok(s)) => bench_runs.extend(serde_json::from_str::<Vec<BenchRun>>(&s).expect("wasm bench json")),
                _ => wasm_note = Some(format!("WASM bench failed: {}", out.trim())),
            }
        }
    }
    let summaries: Vec<BenchSummary> = bench_runs.iter().map(|r| r.summary()).collect();
    std::fs::write(reports.join("bench.json"), serde_json::to_string_pretty(&summaries).unwrap()).unwrap();
    let mut csv = String::from("runtime,population,p50_ms,p95_ms,p99_ms,max_ms,mean_ms,dormant_mean\n");
    for s in &summaries {
        let _ = writeln!(csv, "{},{},{:.3},{:.3},{:.3},{:.3},{:.3},{:.4}", s.runtime, s.population, s.p50, s.p95, s.p99, s.max, s.mean, s.dormant_mean);
    }
    std::fs::write(reports.join("bench.csv"), csv).unwrap();
    for r in &bench_runs {
        if r.population == 100_000 {
            let mut c = format!("tick,{},total\n", PHASES.join(","));
            for (k, p) in r.phase_ms.iter().enumerate() {
                let _ = writeln!(c, "{k},{},{:.4}", p.iter().map(|v| format!("{v:.4}")).collect::<Vec<_>>().join(","), p.iter().sum::<f64>());
            }
            std::fs::write(reports.join(format!("bench-{}-100k-phases.csv", r.runtime)), c).unwrap();
        }
    }

    // ------------------------------------------------------ scale (wave 8)
    let scale_sec = if args.iter().any(|a| a == "--skip-scale") {
        None
    } else {
        let o = scale::ScaleOpts {
            radii: if quick { vec![1300.0] } else { scale::SCALE_RADII.to_vec() },
            pops: if quick { vec![20_000, 100_000] } else { scale::SCALE_POPS.to_vec() },
            ticks: if quick { 600 } else { scale::SCALE_TICKS },
            clusters: scale::SCALE_CLUSTERS,
            wasm: !skip_wasm && wasm_note.is_none(),
            real_levels: if quick { vec![] } else { vec!["marais-tiled:1300".into()] },
        };
        eprintln!("[report] scale runs (wave 8)");
        let runs = scale::run_all(&o);
        let summaries: Vec<scale::ScaleSummary> = runs.iter().map(|r| r.summary()).collect();
        // Not scale.json: that one belongs to `bench --scale --out reports/scale.md`.
        std::fs::write(reports.join("headless-scale.json"), serde_json::to_string_pretty(&summaries).unwrap()).unwrap();
        Some((scale::intro_md(o.ticks, o.clusters), scale::table_md(&runs)))
    };

    // ------------------------------------------------------ targets
    let find = |rt: &str| summaries.iter().find(|s| s.runtime == rt && s.population == 100_000).cloned();
    let mut targets = Vec::new();
    let mut add = |name: &str, target: f64, measured: Option<f64>| {
        targets.push(Target {
            name: name.into(),
            target: format!("≤ {target:.0} ms"),
            measured: measured.map_or("not run".into(), |m| format!("{m:.2} ms")),
            pass: measured.map(|m| m <= target),
        });
    };
    let nat = find("native");
    let was = find("wasm");
    add("Native p95 tick, 100k", TARGET_NATIVE_P95, nat.as_ref().map(|s| s.p95));
    add("Native max tick, 100k", TARGET_NATIVE_MAX, nat.as_ref().map(|s| s.max));
    add("WASM p95 tick, 100k", TARGET_WASM_P95, was.as_ref().map(|s| s.p95));
    add("WASM max tick, 100k", TARGET_WASM_MAX, was.as_ref().map(|s| s.max));

    let env = environment();
    let mut groups: Vec<(String, usize, usize)> = Vec::new();
    for t in &tests {
        match groups.iter_mut().find(|g| g.0 == t.group) {
            Some(g) => {
                g.1 += t.ok as usize;
                g.2 += 1
            }
            None => groups.push((t.group.clone(), t.ok as usize, 1)),
        }
    }
    let rows = scenario_rows(&runs);

    let ctx = Ctx { quick, env, targets, groups, tests, test_notes, rows, summaries, wasm_note, ticks, seeds, scale: scale_sec };
    let md = markdown(&ctx);
    std::fs::write(reports.join("headless-report.md"), &md).unwrap();
    let html = html(&ctx, &runs, &bench_runs);
    std::fs::write(reports.join("headless-report.html"), html).unwrap();
    std::fs::write(reports.join("environment.json"), serde_json::to_string_pretty(&ctx.env).unwrap()).unwrap();
    std::fs::write(reports.join("tests.json"), serde_json::to_string_pretty(&ctx.tests).unwrap()).unwrap();
    eprintln!("[report] wrote {}", Path::new("reports/headless-report.md").display());
    println!("{}", summary_table_md(&ctx));
}

struct Ctx {
    quick: bool,
    env: Env,
    targets: Vec<Target>,
    groups: Vec<(String, usize, usize)>,
    tests: Vec<TestCase>,
    test_notes: Vec<String>,
    rows: Vec<ScenarioRow>,
    summaries: Vec<BenchSummary>,
    wasm_note: Option<String>,
    ticks: u32,
    seeds: u32,
    /// Scale section: intro paragraph and table (markdown).
    scale: Option<(String, String)>,
}

fn pf(p: Option<bool>) -> &'static str {
    match p {
        Some(true) => "PASS",
        Some(false) => "FAIL",
        None => "NOT RUN",
    }
}

fn summary_table_md(c: &Ctx) -> String {
    let mut s = String::from("| Check | Target | Measured | Result |\n|---|---|---|---|\n");
    for t in &c.targets {
        let _ = writeln!(s, "| {} | {} | {} | **{}** |", t.name, t.target, t.measured, pf(t.pass));
    }
    for (g, ok, n) in &c.groups {
        let _ = writeln!(s, "| Tests: {g} | all pass | {ok}/{n} | **{}** |", pf(Some(ok == n)));
    }
    if c.groups.is_empty() {
        let _ = writeln!(s, "| Tests | all pass | skipped | **NOT RUN** |");
    }
    s
}

fn known_issues(c: &Ctx) -> Vec<String> {
    let mut v = vec![
        "Towers have no line-of-sight check: a garrison shoots through buildings (spec simplification).".to_string(),
        "Towers are indestructible and zombies ignore them.".to_string(),
        "Fields refresh every 5 ticks (chase and threat/flee on alternating ticks), so agents steer on data up to 0.25 s old.".to_string(),
        "Separation looks at no more than 8 overlapping neighbours and scans at most 48 candidates, so very dense crowds overlap a little.".to_string(),
        "With zombies only 0.3 m/s faster than fleeing civilians, the last survivors can run along the map edge for minutes; such runs end in a timeout with a few survivors.".to_string(),
        "Benchmarks run inside the Docker dev container (Linux VM on the host), single-threaded.".to_string(),
    ];
    for t in &c.targets {
        if t.pass == Some(false) {
            let rt = if t.name.starts_with("WASM") { "wasm" } else { "native" };
            if let Some(s) = c.summaries.iter().find(|s| s.runtime == rt && s.population == 100_000) {
                let hs = hot_spots(s).iter().map(|(n, p)| format!("{n} {p:.0}%")).collect::<Vec<_>>().join(", ");
                v.push(format!("MISSED: {} = {} (target {}). Top hot spots: {hs}.", t.name, t.measured, t.target));
            }
        }
    }
    if let Some(n) = &c.wasm_note {
        v.push(n.clone());
    }
    v.extend(c.test_notes.iter().cloned());
    if c.quick {
        v.push("QUICK MODE: 2 seeds, no S5, 600 benchmark ticks. Not the reference report.".into());
    }
    v
}

fn bench_table_md(c: &Ctx) -> String {
    let mut s = String::from("| Runtime | Agents | p50 ms | p95 ms | p99 ms | max ms | mean ms | dormant share |\n|---|---:|---:|---:|---:|---:|---:|---:|\n");
    for b in &c.summaries {
        let _ = writeln!(s, "| {} | {} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.1}% |", b.runtime, b.population, b.p50, b.p95, b.p99, b.max, b.mean, b.dormant_mean * 100.0);
    }
    s
}

fn phase_table_md(c: &Ctx) -> String {
    let mut s = String::from("| Runtime | Agents |");
    for p in PHASES {
        let _ = write!(s, " {p} |");
    }
    s.push_str("\n|---|---:|");
    for _ in PHASES {
        s.push_str("---:|");
    }
    s.push('\n');
    for b in &c.summaries {
        let _ = write!(s, "| {} | {} |", b.runtime, b.population);
        for (_, m) in &b.phase_mean {
            let _ = write!(s, " {m:.3} |");
        }
        s.push('\n');
    }
    s
}

fn markdown(c: &Ctx) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "# Zombie TD — headless report\n");
    let _ = writeln!(s, "Generated {} from commit `{}`. Regenerate with `cargo run --release -p sim-headless -- report`.\n", c.env.generated, c.env.git_commit);
    let _ = writeln!(s, "## Summary\n\n{}", summary_table_md(c));
    let _ = writeln!(s, "## Environment\n");
    let _ = writeln!(s, "| | |\n|---|---|\n| Host CPU | {} |\n| CPU seen by the container | {} |\n| Cores available | {} |\n| OS | {} |\n| rustc | {} |\n| Node | {} |\n| Git commit | {} |\n", c.env.host_cpu, c.env.container_cpu, c.env.cores, c.env.os, c.env.rustc, c.env.node, c.env.git_commit);
    let _ = writeln!(s, "## Tests\n");
    if c.tests.is_empty() {
        let _ = writeln!(s, "Tests were skipped for this report.\n");
    } else {
        let _ = writeln!(s, "| Group | Test | Result |\n|---|---|---|");
        for t in &c.tests {
            let _ = writeln!(s, "| {} | `{}` | {} |", t.group, t.name, if t.ok { "ok" } else { "**FAILED**" });
        }
        s.push('\n');
    }
    let _ = writeln!(s, "## Scenarios\n\n{} seeds per scenario (1–{}). Values are mean (min–max) over seeds. Per-second series: `reports/scenarios/<id>_seed<n>.csv`.\n", c.seeds, c.seeds);
    let _ = writeln!(s, "| Id | Level | Defense | Agents | Outcomes | Survival | 50% lost | 90% lost | Zombies killed | First breach |\n|---|---|---|---:|---|---|---|---|---|---|");
    for r in &c.rows {
        let _ = writeln!(s, "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |", r.id, r.level, r.defense, r.population, r.outcomes, r.survival, r.t50, r.t90, r.killed, r.breach);
    }
    let _ = writeln!(s, "\n## Benchmarks\n\nLevel `{}`, no defense, seed {}, {} ticks ({} s of game time), single thread. Native is a release build; WASM runs under Node with simd128.\n", bench::BENCH_LEVEL, bench::BENCH_SEED, c.ticks, c.ticks / 20);
    let _ = writeln!(s, "{}", bench_table_md(c));
    let _ = writeln!(s, "Mean ms per phase:\n\n{}", phase_table_md(c));
    for rt in ["native", "wasm"] {
        if let Some(b) = c.summaries.iter().find(|b| b.runtime == rt && b.population == 100_000) {
            let hs = hot_spots(b).iter().map(|(n, p)| format!("{n} ({p:.0}%)")).collect::<Vec<_>>().join(", ");
            let _ = writeln!(s, "Top hot spots, {rt} 100k: {hs}.\n");
        }
    }
    if let Some((intro, table)) = &c.scale {
        let _ = writeln!(s, "## Scale (wave 8)\n\n{intro}\n\n{table}");
    }
    let _ = writeln!(s, "## Known issues and simplifications\n");
    for k in known_issues(c) {
        let _ = writeln!(s, "- {k}");
    }
    s
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Very small Markdown-table → HTML conversion for the tables we generate.
fn md_table_to_html(md: &str) -> String {
    let lines: Vec<&str> = md.lines().filter(|l| l.starts_with('|')).collect();
    if lines.len() < 2 {
        return String::new();
    }
    let cells = |l: &str| -> Vec<String> { l.trim().trim_matches('|').split('|').map(|c| c.trim().to_string()).collect() };
    let fmt_cell = |c: &str| -> String {
        let c = esc(c);
        let c = c.replace("**PASS**", "<span class=\"pass\">✓ PASS</span>").replace("**FAIL**", "<span class=\"fail\">✗ FAIL</span>").replace("**FAILED**", "<span class=\"fail\">✗ FAILED</span>").replace("**NOT RUN**", "<span class=\"muted\">NOT RUN</span>");
        let mut out = String::new();
        let mut code = false;
        for ch in c.chars() {
            if ch == '`' {
                out.push_str(if code { "</code>" } else { "<code>" });
                code = !code;
            } else {
                out.push(ch);
            }
        }
        out
    };
    let mut s = String::from("<div class=\"tw\"><table><thead><tr>");
    for h in cells(lines[0]) {
        let _ = write!(s, "<th>{}</th>", fmt_cell(&h));
    }
    s.push_str("</tr></thead><tbody>");
    for l in &lines[2..] {
        s.push_str("<tr>");
        for c in cells(l) {
            let num = c.chars().next().map_or(false, |ch| ch.is_ascii_digit()) && !c.contains(' ');
            let _ = write!(s, "<td{}>{}</td>", if num { " class=\"num\"" } else { "" }, fmt_cell(&c));
        }
        s.push_str("</tr>");
    }
    s.push_str("</tbody></table></div>");
    s
}

fn html(c: &Ctx, runs: &[RunResult], bench_runs: &[BenchRun]) -> String {
    let mut body = String::new();
    let _ = write!(body, "<header><h1>Zombie TD — headless report</h1><p class=\"sub\">Generated {} · commit <code>{}</code> · regenerate with <code>cargo run --release -p sim-headless -- report</code></p></header>", esc(&c.env.generated), esc(&c.env.git_commit));
    let _ = write!(body, "<section><h2>Summary</h2>{}</section>", md_table_to_html(&summary_table_md(c)));
    let env_md = format!("| | |\n|---|---|\n| Host CPU | {} |\n| CPU seen by the container | {} |\n| Cores available | {} |\n| OS | {} |\n| rustc | {} |\n| Node | {} |\n| Git commit | {} |\n", c.env.host_cpu, c.env.container_cpu, c.env.cores, c.env.os, c.env.rustc, c.env.node, c.env.git_commit);
    let _ = write!(body, "<section><h2>Environment</h2>{}</section>", md_table_to_html(&env_md));

    // Scenarios
    let mut sc_md = String::from("| Id | Level | Defense | Agents | Outcomes | Survival | 50% lost | 90% lost | Zombies killed | First breach |\n|---|---|---|---|---|---|---|---|---|---|\n");
    for r in &c.rows {
        let _ = writeln!(sc_md, "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |", r.id, r.level, r.defense, r.population, r.outcomes, r.survival, r.t50, r.t90, r.killed, r.breach);
    }
    let _ = write!(body, "<section><h2>Scenarios</h2><p>{} seeds per scenario. Values are mean (min–max) over seeds. Charts show the mean over seeds; a finished run holds its final value.</p>{}<div class=\"grid2\">", c.seeds, md_table_to_html(&sc_md));
    for r in &c.rows {
        let series = scenario_series(runs, &r.id);
        let title = format!("{} · {} · {}", r.id, r.level, r.defense);
        let _ = write!(body, "{}", charts::line_chart(&format!("sc-{}", r.id), &title, "game time (s)", "agents", &series));
    }
    body.push_str("</div></section>");

    // Benchmarks
    let _ = write!(
        body,
        "<section><h2>Benchmarks</h2><p>Level <code>{}</code>, no defense, seed {}, {} ticks ({} s of game time), single thread. Targets apply to the 100k runs.</p>{}<h3>Mean ms per phase</h3>{}",
        bench::BENCH_LEVEL,
        bench::BENCH_SEED,
        c.ticks,
        c.ticks / 20,
        md_table_to_html(&bench_table_md(c)),
        md_table_to_html(&phase_table_md(c))
    );
    body.push_str("<div class=\"grid2\">");
    for rt in ["native", "wasm"] {
        if let Some(r) = bench_runs.iter().find(|r| r.runtime == rt && r.population == 100_000) {
            let _ = write!(body, "{}", charts::stacked_area(&format!("ph-{rt}"), &format!("Phase time per tick, {rt}, 100k agents (5-tick means)"), "tick", "ms", &phase_series(r)));
        }
    }
    body.push_str("</div>");
    for rt in ["native", "wasm"] {
        if let Some(b) = c.summaries.iter().find(|b| b.runtime == rt && b.population == 100_000) {
            let hs = hot_spots(b).iter().map(|(n, p)| format!("{n} ({p:.0}%)")).collect::<Vec<_>>().join(", ");
            let _ = write!(body, "<p>Top hot spots, {rt} 100k: {}.</p>", esc(&hs));
        }
    }
    body.push_str("</section>");

    if let Some((intro, table)) = &c.scale {
        let _ = write!(body, "<section><h2>Scale (wave 8)</h2><p>{}</p>{}</section>", esc(intro), md_table_to_html(table));
    }

    // Tests
    let _ = write!(body, "<section><h2>Tests</h2>");
    if c.tests.is_empty() {
        body.push_str("<p>Tests were skipped for this report.</p>");
    } else {
        let mut t_md = String::from("| Group | Test | Result |\n|---|---|---|\n");
        for t in &c.tests {
            let _ = writeln!(t_md, "| {} | `{}` | {} |", t.group, t.name, if t.ok { "ok" } else { "**FAILED**" });
        }
        body.push_str(&md_table_to_html(&t_md));
    }
    body.push_str("</section>");

    let _ = write!(body, "<section><h2>Known issues and simplifications</h2><ul>");
    for k in known_issues(c) {
        let _ = write!(body, "<li>{}</li>", esc(&k));
    }
    body.push_str("</ul></section>");

    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Zombie TD headless report</title><style>{CSS}</style></head><body><main>{body}</main>{}</body></html>"#,
        charts::CHART_ASSETS
    )
}

const CSS: &str = r#"
:root{color-scheme:light;--surface:#fcfcfb;--surface-2:#f3f2ef;--text:#0b0b0b;--text-2:#52514e;--muted:#7a7974;--rule:#e4e2dd;--grid:#ecebe7;
--civ:#2a78d6;--inf:#c98500;--zom:#e34948;
--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-4:#eda100;--series-5:#e87ba4;--series-6:#008300;--series-7:#6250d6;
--pass:#0a7d32;--fail:#c22b2b}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--surface:#1a1a19;--surface-2:#242422;--text:#f0efec;--text-2:#c3c2b7;--muted:#8f8e86;--rule:#363532;--grid:#2c2b29;
--civ:#3987e5;--inf:#c98500;--zom:#e66767;
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--series-6:#0ca30c;--series-7:#9085e9;--pass:#3fbf6a;--fail:#ef6b6b}}
:root[data-theme="dark"]{color-scheme:dark;--surface:#1a1a19;--surface-2:#242422;--text:#f0efec;--text-2:#c3c2b7;--muted:#8f8e86;--rule:#363532;--grid:#2c2b29;
--civ:#3987e5;--inf:#c98500;--zom:#e66767;
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--series-6:#0ca30c;--series-7:#9085e9;--pass:#3fbf6a;--fail:#ef6b6b}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:40px 0 12px;padding-top:16px;border-top:1px solid var(--rule)}h3{font-size:15px;margin:20px 0 8px}
.sub,p{color:var(--text-2)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:1px 5px;border-radius:4px}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--rule);vertical-align:top}th{color:var(--text-2);font-weight:600;font-size:13px}td.num{text-align:right}
.pass{color:var(--pass);font-weight:700}.fail{color:var(--fail);font-weight:700}.muted{color:var(--muted)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(520px,100%),1fr));gap:20px;margin-top:16px}
figure.viz{margin:0;position:relative;background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:14px 14px 6px}figcaption{font-weight:600;font-size:14px;margin-bottom:6px}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--text-2);margin-bottom:4px}.legend i,.tip i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
svg.chart{width:100%;height:auto;display:block}svg .grid{stroke:var(--grid);stroke-width:1}svg .axis{stroke:var(--muted);stroke-width:1}svg .tick{fill:var(--muted);font-size:11px}svg .label{fill:var(--text-2);font-size:12px}
svg .line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}svg .band{stroke:var(--surface);stroke-width:1}svg .dlabel{fill:var(--text-2);font-size:12px}svg .cross{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.tip{display:none;position:absolute;pointer-events:none;min-width:170px;background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.12)}
.tip .th{color:var(--text-2);margin-bottom:4px}.tip div{display:flex;align-items:center}.tip b{margin-left:auto;padding-left:12px;font-variant-numeric:tabular-nums}.tip .tot{border-top:1px solid var(--rule);margin-top:4px;padding-top:4px}
ul{color:var(--text-2)}li{margin:4px 0}
"#;
