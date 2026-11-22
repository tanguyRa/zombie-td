# Zombie TD dev environment.
# Everything needed to build, test, benchmark and serve the POC.
# Usage: see README.md ("Dev environment"), or simply `./dev.sh`.
FROM rust:1-bookworm

ARG NODE_MAJOR=22
ARG WASM_BINDGEN_VERSION=0.2.100
ARG WASM_PACK_VERSION=0.13.1

ENV DEBIAN_FRONTEND=noninteractive

# Python (3.11 on bookworm) with the level tool's deps, plus Node.js.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git \
        python3 python3-requests python3-shapely \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Rust WASM tooling. wasm-bindgen-cli is pinned to match the crate's
# `wasm-bindgen = "=…"` so wasm-pack never downloads anything at build time.
RUN rustup target add wasm32-unknown-unknown \
    && cargo install --locked wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} \
    && cargo install --locked wasm-pack --version ${WASM_PACK_VERSION} \
    && rm -rf /usr/local/cargo/registry /usr/local/cargo/git

# Build outputs live in a container volume (fast, and Linux binaries
# don't leak into the macOS checkout).
ENV CARGO_TARGET_DIR=/cache/target \
    IN_DEV_CONTAINER=1

RUN git config --system --add safe.directory /work

WORKDIR /work
EXPOSE 5173
CMD ["bash"]
