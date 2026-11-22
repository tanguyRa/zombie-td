# Zombie TD — headless report

Generated 2026-11-22 17:42 UTC from commit `8bc9889 (with uncommitted changes)`. Regenerate with `cargo run --release -p sim-headless -- report`.

## Summary

| Check | Target | Measured | Result |
|---|---|---|---|
| Native p95 tick, 100k | ≤ 15 ms | 8.22 ms | **PASS** |
| Native max tick, 100k | ≤ 30 ms | 59.20 ms | **FAIL** |
| WASM p95 tick, 100k | ≤ 25 ms | 9.55 ms | **PASS** |
| WASM max tick, 100k | ≤ 45 ms | 20.94 ms | **PASS** |
| Tests: sim-core unit | all pass | 1/1 | **PASS** |
| Tests: M1 level | all pass | 4/4 | **PASS** |
| Tests: M2 rules | all pass | 7/7 | **PASS** |
| Tests: M3 tools | all pass | 10/10 | **PASS** |
| Tests: T1 scale | all pass | 5/5 | **PASS** |
| Tests: Native = WASM | all pass | 2/2 | **PASS** |

## Environment

| | |
|---|---|
| Host CPU | unknown (set HOST_CPU) |
| CPU seen by the container | aarch64 (model not exposed inside the container) |
| Cores available | 8 |
| OS | macos (23.6.0 arm64) |
| rustc | rustc 1.100.0 (0ef1bc386 2026-11-09) |
| Node | v26.5.0 |
| Git commit | 8bc9889 (with uncommitted changes) |

## Tests

| Group | Test | Result |
|---|---|---|
| sim-core unit | `rng::tests::reference_stream` | ok |
| M1 level | `synthetic_levels_rasterize` | ok |
| M1 level | `population_follows_building_size` | ok |
| M1 level | `population_exact_and_on_walkable_cells` | ok |
| M1 level | `wall_safety_2000_ticks_real_levels` | ok |
| M2 rules | `infected_are_never_bitten_again` | ok |
| M2 rules | `infected_are_never_targeted_by_towers` | ok |
| M2 rules | `infection_delay_is_exactly_20_ticks` | ok |
| M2 rules | `outbreak_seeds_clusters` | ok |
| M2 rules | `dijkstra_bucket_queue_matches_brute_force` | ok |
| M2 rules | `native_hash_fixture` | ok |
| M2 rules | `determinism_same_seed_same_hash` | ok |
| M3 tools | `fences_are_clipped_at_buildings_and_charged_for_placed_part` | ok |
| M3 tools | `rasterized_fences_have_no_diagonal_gaps` | ok |
| M3 tools | `tower_never_targets_civilians` | ok |
| M3 tools | `tower_ignores_zombie_at_41m` | ok |
| M3 tools | `tower_kills_zombie_at_30m_in_exactly_3_shots` | ok |
| M3 tools | `zombies_detour_through_a_gap` | ok |
| M3 tools | `placement_budgets_and_undo` | ok |
| M3 tools | `fence_break_reopens_cell_and_fields_follow_within_one_interval` | ok |
| M3 tools | `civilians_never_cross_fences` | ok |
| M3 tools | `zombies_attack_the_fence_without_a_gap` | ok |
| T1 scale | `lazy_settle_gives_the_full_field` | ok |
| T1 scale | `step_masks_follow_kind_changes` | ok |
| T1 scale | `lazy_fields_match_eager_through_fence_breaks` | ok |
| T1 scale | `lazy_fields_match_eager_on_paris_with_defenses` | ok |
| T1 scale | `lazy_fields_match_eager_on_grid_city_disc` | ok |
| Native = WASM | `wasm_sim_runs_and_reports` | ok |
| Native = WASM | `wasm_hash_matches_native_fixture` | ok |

## Scenarios

2 seeds per scenario (1–2). Values are mean (min–max) over seeds. Per-second series: `reports/scenarios/<id>_seed<n>.csv`.

| Id | Level | Defense | Agents | Outcomes | Survival | 50% lost | 90% lost | Zombies killed | First breach |
|---|---|---|---:|---|---|---|---|---|---|
| S1 | paris-marais | None | 20000 | 2× loss | 0.0% (0.0–0.0) | 114 s (111–116) | 171 s (169–174) | — | — |
| S2 | paris-marais | 8 towers in the 8 largest of the 24 buildings nearest the centre | 20000 | 2× loss | 0.0% (0.0–0.0) | 115 s (112–118) | 173 s (171–176) | 182 (155–209) | — |
| S3 | walled_compound | Fence ring, 400 civilians inside, 100 zombies outside | 500 | 2× loss | 0.0% (0.0–0.0) | 20 s (19–21) | 24 s (23–25) | — | 9 s (8–10) |
| S4 | suburb | None | 20000 | 2× loss | 0.0% (0.0–0.0) | 76 s (69–84) | 118 s (109–127) | — | — |

## Benchmarks

Level `paris-marais`, no defense, seed 1, 600 ticks (30 s of game time), single thread. Native is a release build; WASM runs under Node with simd128.

| Runtime | Agents | p50 ms | p95 ms | p99 ms | max ms | mean ms | dormant share |
|---|---:|---:|---:|---:|---:|---:|---:|
| native | 10000 | 1.35 | 1.97 | 4.63 | 19.32 | 1.47 | 84.5% |
| native | 50000 | 3.54 | 4.56 | 4.99 | 21.75 | 3.60 | 86.6% |
| native | 100000 | 6.28 | 8.22 | 12.19 | 59.20 | 6.46 | 87.3% |
| wasm | 10000 | 1.94 | 2.71 | 2.90 | 6.07 | 1.91 | 84.5% |
| wasm | 50000 | 4.45 | 5.91 | 6.20 | 12.19 | 4.51 | 86.6% |
| wasm | 100000 | 7.55 | 9.55 | 10.63 | 20.94 | 7.57 | 87.3% |

Mean ms per phase:

| Runtime | Agents | hash | fields | civilians | zombies | infected | separation | integrate | towers | fences |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| native | 10000 | 0.193 | 0.884 | 0.074 | 0.024 | 0.007 | 0.266 | 0.023 | 0.000 | 0.000 |
| native | 50000 | 0.403 | 0.888 | 0.322 | 0.186 | 0.036 | 1.661 | 0.108 | 0.000 | 0.000 |
| native | 100000 | 0.650 | 0.934 | 0.608 | 0.220 | 0.069 | 3.763 | 0.215 | 0.000 | 0.000 |
| wasm | 10000 | 0.177 | 1.286 | 0.109 | 0.040 | 0.010 | 0.265 | 0.026 | 0.000 | 0.001 |
| wasm | 50000 | 0.440 | 1.357 | 0.485 | 0.282 | 0.052 | 1.754 | 0.134 | 0.000 | 0.000 |
| wasm | 100000 | 0.735 | 1.415 | 0.888 | 0.360 | 0.100 | 3.818 | 0.258 | 0.000 | 0.000 |

Top hot spots, native 100k: separation (58%), fields (14%), hash (10%).

Top hot spots, wasm 100k: separation (50%), fields (19%), civilians (12%).

## Scale (wave 8)

Synthetic `grid_city_disc` levels (40 m blocks, 14 m streets) cut to a circle, plus the Paris Marais buildings tiled to the same size (`marais-tiled`, real street geometry). No defense, seed 1, 12 outbreak clusters, run until civilians drop below 15% (the wave-defeat rule) or 600 ticks. Max is dominated by isolated host hiccups (single ticks, not reproducible); p95/p99 are the robust figures. Memory: `Sim::memory_bytes()` natively, the whole linear memory in WASM. Regenerate with `cargo run --release -p sim-headless -- bench --scale`.

| Level | Walkable cells (share) | Runtime | Agents | Ticks | p50 ms | p95 ms | p99 ms | max ms | fields p95 ms | fields max ms | full chase ms | full threat+flee ms | memory MB | setup ms |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grid_city_disc_1300m | 628160 (47%) | native | 20000 | 600 | 6.43 | 9.32 | 10.11 | 12.29 | 7.53 | 9.89 | 13.3 | 7.5 | 94 | 99 |
| grid_city_disc_1300m | 628160 (47%) | native | 100000 | 600 | 7.73 | 13.58 | 14.40 | 21.11 | 9.47 | 14.80 | 13.5 | 7.9 | 102 | 165 |
| grid_city_disc_1300m | 628160 (47%) | wasm | 20000 | 600 | 9.02 | 12.96 | 16.42 | 66.69 | 10.90 | 43.71 | – | – | 95 | 239 |
| grid_city_disc_1300m | 628160 (47%) | wasm | 100000 | 600 | 11.23 | 17.77 | 18.45 | 18.76 | 12.79 | 13.73 | – | – | 108 | 253 |

## Known issues and simplifications

- Towers have no line-of-sight check: a garrison shoots through buildings (spec simplification).
- Towers are indestructible and zombies ignore them.
- Fields refresh every 5 ticks (chase and threat/flee started on staggered ticks), each computed over the 5 ticks after its start, so agents steer on fields 5–9 ticks (0.25–0.45 s) old; a fence break reaches them within 10 ticks.
- Separation looks at no more than 8 overlapping neighbours and scans at most 48 candidates, so very dense crowds overlap a little.
- With zombies only 0.3 m/s faster than fleeing civilians, the last survivors can run along the map edge for minutes; such runs end in a timeout with a few survivors.
- Benchmarks run inside the Docker dev container (Linux VM on the host), single-threaded.
- MISSED: Native max tick, 100k = 59.20 ms (target ≤ 30 ms). Top hot spots: separation 58%, fields 14%, hash 10%.
- QUICK MODE: 2 seeds, no S5, 600 benchmark ticks. Not the reference report.
