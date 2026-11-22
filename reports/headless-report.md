# Zombie TD — headless report

Generated 2026-11-22 08:51 UTC from commit `b1829d3 (with uncommitted changes)`. Regenerate with `cargo run --release -p sim-headless -- report`.

## Summary

| Check | Target | Measured | Result |
|---|---|---|---|
| Native p95 tick, 100k | ≤ 15 ms | 21.16 ms | **FAIL** |
| Native max tick, 100k | ≤ 30 ms | 29.95 ms | **PASS** |
| WASM p95 tick, 100k | ≤ 25 ms | 26.48 ms | **FAIL** |
| WASM max tick, 100k | ≤ 45 ms | 38.93 ms | **PASS** |
| Tests: sim-core unit | all pass | 1/1 | **PASS** |
| Tests: M1 level | all pass | 4/4 | **PASS** |
| Tests: M2 rules | all pass | 7/7 | **PASS** |
| Tests: M3 tools | all pass | 10/10 | **PASS** |
| Tests: Native = WASM | all pass | 2/2 | **PASS** |

## Environment

| | |
|---|---|
| Host CPU | Apple M1 Pro |
| CPU seen by the container | aarch64 (model not exposed inside the container) |
| Cores available | 8 |
| OS | Debian GNU/Linux 12 (bookworm) (6.12.76-linuxkit aarch64) |
| rustc | rustc 1.100.0 (0ef1bc386 2026-11-09) |
| Node | v22.23.5 |
| Git commit | b1829d3 (with uncommitted changes) |

## Tests

| Group | Test | Result |
|---|---|---|
| sim-core unit | `rng::tests::reference_stream` | ok |
| M1 level | `synthetic_levels_rasterize` | ok |
| M1 level | `population_follows_building_size` | ok |
| M1 level | `population_exact_and_on_walkable_cells` | ok |
| M1 level | `wall_safety_2000_ticks_real_levels` | ok |
| M2 rules | `infected_are_never_bitten_again` | ok |
| M2 rules | `infection_delay_is_exactly_20_ticks` | ok |
| M2 rules | `infected_are_never_targeted_by_towers` | ok |
| M2 rules | `dijkstra_bucket_queue_matches_brute_force` | ok |
| M2 rules | `outbreak_seeds_clusters` | ok |
| M2 rules | `native_hash_fixture` | ok |
| M2 rules | `determinism_same_seed_same_hash` | ok |
| M3 tools | `fences_are_clipped_at_buildings_and_charged_for_placed_part` | ok |
| M3 tools | `rasterized_fences_have_no_diagonal_gaps` | ok |
| M3 tools | `tower_never_targets_civilians` | ok |
| M3 tools | `tower_kills_zombie_at_30m_in_exactly_3_shots` | ok |
| M3 tools | `tower_ignores_zombie_at_41m` | ok |
| M3 tools | `zombies_detour_through_a_gap` | ok |
| M3 tools | `placement_budgets_and_undo` | ok |
| M3 tools | `fence_break_reopens_cell_and_recomputes_fields_same_tick` | ok |
| M3 tools | `civilians_never_cross_fences` | ok |
| M3 tools | `zombies_attack_the_fence_without_a_gap` | ok |
| Native = WASM | `wasm_sim_runs_and_reports` | ok |
| Native = WASM | `wasm_hash_matches_native_fixture` | ok |

## Scenarios

5 seeds per scenario (1–5). Values are mean (min–max) over seeds. Per-second series: `reports/scenarios/<id>_seed<n>.csv`.

| Id | Level | Defense | Agents | Outcomes | Survival | 50% lost | 90% lost | Zombies killed | First breach |
|---|---|---|---:|---|---|---|---|---|---|
| S1 | paris-marais | None | 20000 | 5× loss | 0.0% (0.0–0.0) | 91 s (84–97) | 136 s (123–148) | — | — |
| S2 | paris-marais | 8 towers in the 8 largest of the 24 buildings nearest the centre | 20000 | 5× loss | 0.0% (0.0–0.0) | 93 s (86–98) | 141 s (131–154) | 183 (162–223) | — |
| S3 | walled_compound | Fence ring, 400 civilians inside, 100 zombies outside | 500 | 5× loss | 0.0% (0.0–0.0) | 20 s (19–20) | 22 s (21–23) | — | 10 s (8–10) |
| S4 | suburb | None | 20000 | 5× loss | 0.0% (0.0–0.0) | 59 s (52–63) | 90 s (88–97) | — | — |
| S5 | paris-marais | None (100k agents) | 100000 | 5× loss | 0.0% (0.0–0.0) | 75 s (70–81) | 105 s (95–110) | — | — |

## Benchmarks

Level `paris-marais`, no defense, seed 1, 3000 ticks (150 s of game time), single thread. Native is a release build; WASM runs under Node with simd128.

| Runtime | Agents | p50 ms | p95 ms | p99 ms | max ms | mean ms | dormant share |
|---|---:|---:|---:|---:|---:|---:|---:|
| native | 10000 | 1.70 | 6.36 | 6.48 | 6.86 | 2.59 | 65.4% |
| native | 50000 | 7.36 | 12.80 | 13.10 | 14.26 | 7.19 | 63.0% |
| native | 100000 | 15.31 | 21.16 | 23.11 | 29.95 | 13.80 | 53.1% |
| wasm | 10000 | 1.96 | 8.30 | 8.48 | 13.01 | 3.28 | 65.4% |
| wasm | 50000 | 8.97 | 16.19 | 16.66 | 30.17 | 8.92 | 63.0% |
| wasm | 100000 | 18.73 | 26.48 | 28.89 | 38.93 | 17.02 | 53.1% |

Mean ms per phase:

| Runtime | Agents | hash | fields | civilians | zombies | infected | separation | integrate | towers | fences |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| native | 10000 | 0.276 | 1.376 | 0.066 | 0.184 | 0.007 | 0.655 | 0.027 | 0.000 | 0.000 |
| native | 50000 | 0.540 | 1.427 | 0.313 | 1.024 | 0.035 | 3.713 | 0.142 | 0.000 | 0.000 |
| native | 100000 | 0.792 | 1.476 | 0.538 | 2.517 | 0.070 | 8.122 | 0.285 | 0.000 | 0.000 |
| wasm | 10000 | 0.201 | 1.901 | 0.104 | 0.277 | 0.020 | 0.734 | 0.040 | 0.000 | 0.000 |
| wasm | 50000 | 0.544 | 1.947 | 0.497 | 1.500 | 0.097 | 4.124 | 0.212 | 0.000 | 0.000 |
| wasm | 100000 | 0.883 | 1.999 | 0.884 | 3.693 | 0.155 | 8.978 | 0.425 | 0.000 | 0.000 |

Top hot spots, native 100k: separation (59%), zombies (18%), fields (11%).

Top hot spots, wasm 100k: separation (53%), zombies (22%), fields (12%).

## Known issues and simplifications

- Towers have no line-of-sight check: a garrison shoots through buildings (spec simplification).
- Towers are indestructible and zombies ignore them.
- Fields refresh every 5 ticks (chase and threat/flee on alternating ticks), so agents steer on data up to 0.25 s old.
- Separation looks at no more than 8 overlapping neighbours and scans at most 48 candidates, so very dense crowds overlap a little.
- With zombies only 0.3 m/s faster than fleeing civilians, the last survivors can run along the map edge for minutes; such runs end in a timeout with a few survivors.
- Benchmarks run inside the Docker dev container (Linux VM on the host), single-threaded.
- MISSED: Native p95 tick, 100k = 21.16 ms (target ≤ 15 ms). Top hot spots: separation 59%, zombies 18%, fields 11%.
- MISSED: WASM p95 tick, 100k = 26.48 ms (target ≤ 25 ms). Top hot spots: separation 53%, zombies 22%, fields 12%.
