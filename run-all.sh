#!/usr/bin/env bash
# One-shot: build WASM, run the tests (native, WASM, browsers), write the report, start the dev server.
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

step "Running web unit tests (Vitest: map blocks, cache, loader)"
(cd web && npm run test:unit)

step "Running browser tests (Playwright: Chromium, Firefox, WebKit)"
(cd web && npx playwright test)

step "Writing the headless report (scenarios + benchmarks, several minutes)"
cargo run --release -p sim-headless -- report "$@"

step "Starting the dev server on http://localhost:5173"
cd web && exec npx vite --host 0.0.0.0 --port 5173 --strictPort
