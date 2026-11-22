# Zombie TD — headless report

Generated 2026-11-22 02:10 UTC from commit `4e84763`. Regenerate with `cargo run --release -p sim-headless -- report`.

## Summary

| Check | Target | Measured | Result |
|---|---|---|---|
| Native p95 tick, 100k | ≤ 15 ms | 13.21 ms | **PASS** |
| Native max tick, 100k | ≤ 30 ms | 19.80 ms | **PASS** |
| WASM p95 tick, 100k | ≤ 25 ms | 16.63 ms | **PASS** |
| WASM max tick, 100k | ≤ 45 ms | 20.28 ms | **PASS** |
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
| Git commit | 4e84763 |

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
| M3 tools | `placement_budgets_and_undo` | ok |
| M3 tools | `fence_break_reopens_cell_and_recomputes_fields_same_tick` | ok |
| M3 tools | `zombies_detour_through_a_gap` | ok |
| M3 tools | `civilians_never_cross_fences` | ok |
| M3 tools | `zombies_attack_the_fence_without_a_gap` | ok |
| Native = WASM | `wasm_sim_runs_and_reports` | ok |
| Native = WASM | `wasm_hash_matches_native_fixture` | ok |

## Scenarios

5 seeds per scenario (1–5). Values are mean (min–max) over seeds. Per-second series: `reports/scenarios/<id>_seed<n>.csv`.

| Id | Level | Defense | Agents | Outcomes | Survival | 50% lost | 90% lost | Zombies killed | First breach |
|---|---|---|---:|---|---|---|---|---|---|
| S1 | paris-marais | None | 20000 | 3× loss, 2× timeout | 0.7% (0.0–2.8) | 342 s (300–379) | 471 s (417–517) | — | — |
| S2 | paris-marais | 8 towers in the 8 largest of the 24 buildings nearest the centre | 20000 | 1× loss, 4× timeout | 0.4% (0.0–1.2) | 359 s (320–397) | 470 s (449–492) | 817 (628–994) | — |
| S3 | walled_compound | Fence ring, 400 civilians inside, 100 zombies outside | 500 | 5× loss | 0.0% (0.0–0.0) | 44 s (41–49) | 49 s (46–52) | — | 18 s (15–20) |
| S4 | suburb | None | 20000 | 5× loss | 0.0% (0.0–0.0) | 193 s (182–205) | 312 s (260–380) | — | — |
| S5 | paris-marais | None (100k agents) | 100000 | 5× loss | 0.0% (0.0–0.0) | 195 s (170–224) | 271 s (232–291) | — | — |

## Benchmarks

Level `paris-marais`, no defense, seed 1, 3000 ticks (150 s of game time), single thread. Native is a release build; WASM runs under Node with simd128.

| Runtime | Agents | p50 ms | p95 ms | p99 ms | max ms | mean ms | dormant share |
|---|---:|---:|---:|---:|---:|---:|---:|
| native | 10000 | 0.74 | 5.11 | 5.29 | 7.94 | 2.01 | 81.3% |
| native | 50000 | 4.45 | 8.53 | 9.81 | 11.41 | 4.80 | 76.1% |
| native | 100000 | 8.12 | 13.21 | 15.11 | 19.80 | 8.22 | 77.0% |
| wasm | 10000 | 0.79 | 6.81 | 7.00 | 12.93 | 2.58 | 81.3% |
| wasm | 50000 | 5.41 | 11.12 | 12.70 | 19.99 | 6.08 | 76.1% |
| wasm | 100000 | 10.11 | 16.63 | 18.87 | 20.28 | 10.23 | 77.0% |

Mean ms per phase:

| Runtime | Agents | hash | fields | civilians | zombies | infected | separation | integrate | towers | fences |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| native | 10000 | 0.264 | 1.341 | 0.074 | 0.023 | 0.007 | 0.278 | 0.021 | 0.000 | 0.000 |
| native | 50000 | 0.492 | 1.407 | 0.406 | 0.235 | 0.033 | 2.109 | 0.114 | 0.000 | 0.000 |
| native | 100000 | 0.751 | 1.459 | 0.749 | 0.503 | 0.066 | 4.459 | 0.233 | 0.000 | 0.000 |
| wasm | 10000 | 0.188 | 1.866 | 0.117 | 0.043 | 0.013 | 0.320 | 0.032 | 0.000 | 0.000 |
| wasm | 50000 | 0.496 | 1.943 | 0.638 | 0.377 | 0.072 | 2.381 | 0.171 | 0.000 | 0.000 |
| wasm | 100000 | 0.839 | 1.990 | 1.175 | 0.780 | 0.130 | 4.967 | 0.344 | 0.000 | 0.000 |

Top hot spots, native 100k: separation (54%), fields (18%), hash (9%).

Top hot spots, wasm 100k: separation (49%), fields (19%), civilians (11%).

## Known issues and simplifications

- Towers have no line-of-sight check: a garrison shoots through buildings (spec simplification).
- Towers are indestructible and zombies ignore them.
- Fields refresh every 5 ticks (chase and threat/flee on alternating ticks), so agents steer on data up to 0.25 s old.
- Separation looks at no more than 8 overlapping neighbours and scans at most 48 candidates, so very dense crowds overlap a little.
- With zombies only 0.3 m/s faster than fleeing civilians, the last survivors can run along the map edge for minutes; such runs end in a timeout with a few survivors.
- Benchmarks run inside the Docker dev container (Linux VM on the host), single-threaded.
