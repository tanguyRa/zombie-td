#!/usr/bin/env bash
# One-shot: build WASM, run every test suite (native, native with debug
# assertions, WASM under Node, typecheck and web unit tests, Playwright in
# Chromium, Firefox and WebKit), write the headless report, start the dev
# server. Extra arguments go to the report (e.g. `./run-all.sh --quick`).
#
# On the host this re-runs itself inside the Docker dev container (the only
# prerequisite is Docker). Inside the container it runs the steps directly.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${IN_DEV_CONTAINER:-}" ]; then
  command -v docker >/dev/null || { echo "Docker is required (see README.md)"; exit 1; }
  docker compose build
  exec ./dev.sh ./run-all.sh "$@"
fi

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "Installing web dependencies"
(cd web && npm ci --no-audit --no-fund)

step "Building WASM (web + Node targets, simd128)"
wasm-pack build crates/sim-wasm --release --target web --out-dir ../../web/src/wasm/pkg
wasm-pack build crates/sim-wasm --release --target nodejs --out-dir pkg-node

step "Running tests (native)"
cargo test --release --workspace

step "Running tests (native, release with debug assertions: the start-grid and other checks)"
CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true cargo test --release --workspace

step "Running tests (WASM under Node: native = WASM hash)"
wasm-pack test --node --release crates/sim-wasm

step "Typechecking the web app and its tests (tsc)"
(cd web && npm run typecheck)

step "Running web unit tests (Vitest: map blocks, cache, loader, profile, replay inputs)"
(cd web && npm run test:unit)

step "Running browser tests (Playwright: Chromium, Firefox, WebKit; the first-session test plays 8 streamed waves)"
(cd web && npx playwright test)

step "Writing the headless report (tests, scenarios, benchmarks, the 8-wave match and its replay, the wave-8 scale bench)"
cargo run --release -p sim-headless -- report "$@"

step "Starting the dev server on http://localhost:5173"
cd web && exec npx vite --host 0.0.0.0 --port 5173 --strictPort
