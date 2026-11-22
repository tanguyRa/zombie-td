#!/usr/bin/env bash
# Run a command inside the dev container (or open a shell with no args).
#   ./dev.sh                          -> interactive shell (port 5173 published)
#   ./dev.sh cargo test --release
#   ./dev.sh ./run-all.sh             -> port 5173 published for the dev server
set -euo pipefail
cd "$(dirname "$0")"
# Host CPU name, so the report can name the real machine behind the Docker VM.
export HOST_CPU="${HOST_CPU:-$(sysctl -n machdep.cpu.brand_string 2>/dev/null || grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo unknown)}"
# Only commands that serve the web app publish port 5173, so other commands
# can run while the dev server is up.
ports=()
case "${*:-shell}" in
  shell|*"npm run dev"*|*run-all.sh*|*"vite"*) ports=(--service-ports) ;;
esac
if [ $# -eq 0 ]; then
  exec docker compose run --rm ${ports[@]+"${ports[@]}"} -e HOST_CPU dev bash
fi
exec docker compose run --rm ${ports[@]+"${ports[@]}"} -e HOST_CPU dev "$@"
