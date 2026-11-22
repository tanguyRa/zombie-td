//! Records the git commit of the build for run records (`SimVersion::git`,
//! informational only). `ZT_GIT_HASH` overrides it (e.g. in Docker builds
//! without `.git`); without git and without the variable it stays unset.
//! No network.

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn watch(path: Option<String>) {
    if let Some(p) = path {
        if std::path::Path::new(&p).exists() {
            println!("cargo:rerun-if-changed={p}");
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=ZT_GIT_HASH");
    println!("cargo:rerun-if-changed=build.rs");
    let hash = std::env::var("ZT_GIT_HASH").ok().filter(|s| !s.is_empty()).or_else(|| git(&["rev-parse", "--short=12", "HEAD"]));
    if let Some(h) = hash {
        println!("cargo:rustc-env=ZT_GIT_HASH={h}");
    }
    // Rebuild when HEAD moves: HEAD itself (branch switch), the branch's ref
    // (commit) and packed refs.
    watch(git(&["rev-parse", "--git-path", "HEAD"]));
    if let Some(r) = git(&["symbolic-ref", "-q", "HEAD"]) {
        watch(git(&["rev-parse", "--git-path", &r]));
    }
    watch(git(&["rev-parse", "--git-path", "packed-refs"]));
}
