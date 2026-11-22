# Zombie TD — headless report

Generated 2026-11-22 20:30 UTC from commit `da571d7 (with uncommitted changes)`. Regenerate with `cargo run --release -p sim-headless -- report`.

## Summary

| Check | Target | Measured | Result |
|---|---|---|---|
| Native p95 tick, 100k | ≤ 15 ms | 7.90 ms | **PASS** |
| Native max tick, 100k | ≤ 30 ms | 9.26 ms | **PASS** |
| WASM p95 tick, 100k | ≤ 25 ms | 9.72 ms | **PASS** |
| WASM max tick, 100k | ≤ 45 ms | 10.33 ms | **PASS** |
| Tests: sim-core unit | all pass | 59/59 | **PASS** |
| Tests: M1 level | all pass | 4/4 | **PASS** |
| Tests: M2 rules | all pass | 7/7 | **PASS** |
| Tests: M3 tools | all pass | 10/10 | **PASS** |
| Tests: T1 scale | all pass | 9/9 | **PASS** |
| Tests: Native = WASM | all pass | 4/4 | **PASS** |

## Environment

| | |
|---|---|
| Host CPU | unknown (set HOST_CPU) |
| CPU seen by the container | aarch64 (model not exposed inside the container) |
| Cores available | 8 |
| OS | macos (23.6.0 arm64) |
| rustc | rustc 1.100.0 (0ef1bc386 2026-11-09) |
| Node | v26.5.0 |
| Git commit | da571d7 (with uncommitted changes) |

## Tests

| Group | Test | Result |
|---|---|---|
| sim-core unit | `rng::tests::reference_stream` | ok |
| sim-core unit | `sim::tests::agents_far_inside_walls_are_pushed_out` | ok |
| sim-core unit | `sim::tests::splash_is_centred_on_the_hash_time_position` | ok |
| sim-core unit | `match_::tests::state_hash_covers_what_the_rest_of_a_wave_depends_on` | ok |
| M1 level | `synthetic_levels_rasterize` | ok |
| M1 level | `population_follows_building_size` | ok |
| M1 level | `population_exact_and_on_walkable_cells` | ok |
| M1 level | `wall_safety_2000_ticks_real_levels` | ok |
| M2 rules | `infected_are_never_bitten_again` | ok |
| M2 rules | `infection_delay_is_exactly_20_ticks` | ok |
| M2 rules | `infected_are_never_targeted_by_towers` | ok |
| M2 rules | `outbreak_seeds_clusters` | ok |
| M2 rules | `dijkstra_bucket_queue_matches_brute_force` | ok |
| M2 rules | `native_hash_fixture` | ok |
| M2 rules | `determinism_same_seed_same_hash` | ok |
| M3 tools | `rasterized_fences_have_no_diagonal_gaps` | ok |
| M3 tools | `fences_are_clipped_at_buildings_and_charged_for_placed_part` | ok |
| M3 tools | `tower_never_targets_civilians` | ok |
| M3 tools | `tower_kills_zombie_at_30m_in_exactly_3_shots` | ok |
| M3 tools | `tower_ignores_zombie_at_41m` | ok |
| M3 tools | `zombies_detour_through_a_gap` | ok |
| M3 tools | `placement_budgets_and_undo` | ok |
| M3 tools | `fence_break_reopens_cell_and_fields_follow_within_two_intervals` | ok |
| M3 tools | `civilians_never_cross_fences` | ok |
| M3 tools | `zombies_attack_the_fence_without_a_gap` | ok |
| T1 scale | `lazy_settle_gives_the_full_field` | ok |
| T1 scale | `step_masks_follow_kind_changes` | ok |
| T1 scale | `lazy_fields_match_eager_through_fence_breaks` | ok |
| T1 scale | `fence_break_hash_fixture` | ok |
| T1 scale | `field_jobs_read_the_grid_of_their_start_tick` | ok |
| T1 scale | `lazy_fields_match_eager_with_wake_radius_beyond_the_flee_cap` | ok |
| T1 scale | `lazy_fields_match_eager_on_paris_with_defenses` | ok |
| T1 scale | `field_budgets_never_change_results` | ok |
| T1 scale | `lazy_fields_match_eager_on_grid_city_disc` | ok |
| sim-core unit | `actions_serialize_as_tagged_json` | ok |
| sim-core unit | `config_is_valid_and_rings_fit_the_level` | ok |
| sim-core unit | `an_empty_ring_still_plays` | ok |
| sim-core unit | `a_reveal_never_walls_off_the_territory_already_played` | ok |
| sim-core unit | `a_population_capped_match_plays` | ok |
| sim-core unit | `absent_agents_never_move_or_get_bitten` | ok |
| sim-core unit | `chunks_with_bad_bounds_or_coordinates_are_refused` | ok |
| sim-core unit | `placements_persist_and_broken_fences_stay_broken` | ok |
| sim-core unit | `newcomers_come_from_the_new_ring_and_survivors_stay_put` | ok |
| sim-core unit | `raw_grid_write_mid_wave_panics - should panic` | ok |
| sim-core unit | `outbreaks_follow_the_per_wave_placement_rules` | ok |
| sim-core unit | `restart_rebuilds_the_initial_match` | ok |
| sim-core unit | `retry_restores_the_prep_state_exactly` | ok |
| sim-core unit | `ring_ready_waits_for_every_block_the_reveal_would_refuse` | ok |
| sim-core unit | `chunks_give_the_same_match_whatever_their_arrival_order` | ok |
| sim-core unit | `ring_reveal_walls_cells_outside_the_current_radius` | ok |
| sim-core unit | `state_hash_sees_the_defeat_line` | ok |
| sim-core unit | `tiny_levels_play_through` | ok |
| sim-core unit | `match_hash_fixture` | ok |
| sim-core unit | `wrong_phase_actions_are_refused` | ok |
| sim-core unit | `win_and_lose_thresholds` | ok |
| sim-core unit | `fatigue_slows_civilians_only` | ok |
| sim-core unit | `debug_fence_break_mid_wave_ignores_field_budgets` | ok |
| sim-core unit | `same_seed_and_actions_give_the_same_hashes` | ok |
| sim-core unit | `ring_ready_and_area_revealed_agree` | ok |
| sim-core unit | `retry_after_fence_breaks_replays_exactly` | ok |
| sim-core unit | `match_hash_ignores_field_budgets_and_eager_jobs` | ok |
| sim-core unit | `cards_json_has_the_v1_cards` | ok |
| sim-core unit | `deck_rules_are_enforced_with_clear_errors` | ok |
| sim-core unit | `fences_from_cards_have_their_length_and_hp` | ok |
| sim-core unit | `garrison_cards_equip_buildings` | ok |
| sim-core unit | `an_empty_keep_choice_keeps_nothing` | ok |
| sim-core unit | `huge_fence_coordinates_are_refused_quickly` | ok |
| sim-core unit | `a_cell_taken_over_twice_goes_back_whatever_the_pull_down_order` | ok |
| sim-core unit | `a_mulligan_drops_an_earlier_keep_choice` | ok |
| sim-core unit | `outbreaks_scale_with_squeezed_rings` | ok |
| sim-core unit | `airstrike_and_convoy` | ok |
| sim-core unit | `phase_restrictions_use_the_right_error` | ok |
| sim-core unit | `mortar_splash_and_minimum_range` | ok |
| sim-core unit | `pulling_down_a_fence_gives_taken_over_cells_back` | ok |
| sim-core unit | `mulligan_and_keep_rules` | ok |
| sim-core unit | `repair_and_pull_down` | ok |
| sim-core unit | `paratrooper_lands_after_ten_seconds_and_shoots` | ok |
| sim-core unit | `strikes_hit_an_area_after_their_delay` | ok |
| sim-core unit | `retry_restores_hand_deck_supply_and_structures` | ok |
| sim-core unit | `draw_keep_discard_reshuffle_over_eight_waves` | ok |
| sim-core unit | `card_state_is_in_the_state_hash` | ok |
| sim-core unit | `a_mulligan_on_an_empty_deck_draws_from_the_reshuffled_discard` | ok |
| sim-core unit | `supply_income_and_carry_over` | ok |
| sim-core unit | `scripted_match_with_the_starter_deck` | ok |
| sim-core unit | `fnv1a64_known_vectors` | ok |
| sim-core unit | `fixture_matches_the_config` | ok |
| sim-core unit | `snapshot_hash_matches_js` | ok |
| sim-core unit | `streaming_match_from_the_fixture` | ok |
| sim-core unit | `scripted_starter_deck_match_clears_the_marais` | ok |
| Native = WASM | `wasm_sim_runs_and_reports` | ok |
| Native = WASM | `wasm_match_hash_matches_native_fixture` | ok |
| Native = WASM | `wasm_hash_matches_native_fixture` | ok |
| Native = WASM | `wasm_fence_break_hash_matches_native_fixture` | ok |

## Scenarios

2 seeds per scenario (1–2). Values are mean (min–max) over seeds. Per-second series: `reports/scenarios/<id>_seed<n>.csv`.

| Id | Level | Defense | Agents | Outcomes | Survival | 50% lost | 90% lost | Zombies killed | First breach |
|---|---|---|---:|---|---|---|---|---|---|
| S1 | paris-marais | None | 20000 | 2× loss | 0.0% (0.0–0.0) | 114 s (111–116) | 171 s (169–174) | — | — |
| S2 | paris-marais | 8 towers in the 8 largest of the 24 buildings nearest the centre | 20000 | 2× loss | 0.0% (0.0–0.0) | 115 s (112–118) | 173 s (171–176) | 182 (155–209) | — |
| S3 | walled_compound | Fence ring, 400 civilians inside, 100 zombies outside | 500 | 2× loss | 0.0% (0.0–0.0) | 20 s (20–20) | 22 s (22–22) | — | 9 s (8–10) |
| S4 | suburb | None | 20000 | 2× loss | 0.0% (0.0–0.0) | 76 s (69–84) | 118 s (109–127) | — | — |

## Benchmarks

Level `paris-marais`, no defense, seed 1, 600 ticks (30 s of game time), single thread. Native is a release build; WASM runs under Node with simd128.

| Runtime | Agents | p50 ms | p95 ms | p99 ms | max ms | mean ms | dormant share |
|---|---:|---:|---:|---:|---:|---:|---:|
| native | 10000 | 1.40 | 1.90 | 2.01 | 2.09 | 1.37 | 84.5% |
| native | 50000 | 3.51 | 4.52 | 4.88 | 5.08 | 3.53 | 86.6% |
| native | 100000 | 6.33 | 7.90 | 8.29 | 9.26 | 6.28 | 87.3% |
| wasm | 10000 | 1.99 | 2.86 | 3.14 | 3.24 | 1.95 | 84.5% |
| wasm | 50000 | 4.42 | 5.83 | 6.16 | 7.23 | 4.47 | 86.6% |
| wasm | 100000 | 7.72 | 9.72 | 10.08 | 10.33 | 7.68 | 87.3% |

Mean ms per phase:

| Runtime | Agents | hash | fields | civilians | zombies | infected | separation | integrate | towers | fences |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| native | 10000 | 0.183 | 0.822 | 0.073 | 0.024 | 0.007 | 0.243 | 0.021 | 0.000 | 0.000 |
| native | 50000 | 0.397 | 0.856 | 0.322 | 0.190 | 0.035 | 1.624 | 0.105 | 0.000 | 0.000 |
| native | 100000 | 0.644 | 0.928 | 0.598 | 0.214 | 0.070 | 3.616 | 0.214 | 0.000 | 0.000 |
| wasm | 10000 | 0.179 | 1.309 | 0.114 | 0.041 | 0.010 | 0.268 | 0.027 | 0.000 | 0.001 |
| wasm | 50000 | 0.439 | 1.347 | 0.490 | 0.277 | 0.053 | 1.734 | 0.131 | 0.000 | 0.000 |
| wasm | 100000 | 0.741 | 1.448 | 0.918 | 0.358 | 0.102 | 3.846 | 0.263 | 0.001 | 0.000 |

Top hot spots, native 100k: separation (58%), fields (15%), hash (10%).

Top hot spots, wasm 100k: separation (50%), fields (19%), civilians (12%).

## Scale (wave 8)

Synthetic `grid_city_disc` levels (40 m blocks, 14 m streets) cut to a circle, plus the Paris Marais buildings tiled to the same size (`marais-tiled`, real street geometry). `grid_fenced` is the break-heavy case: the same grid with a fence through every block row and column (every street segment fenced once, no detour), fence hp 6 per cell and fence path cost 100, so zombies chew through all wave. No other defense, seed 1, 12 outbreak clusters, run until civilians drop below 15% (the wave-defeat rule) or 600 ticks. Max is dominated by isolated host hiccups (single ticks, not reproducible); p95/p99 are the robust figures. Memory: `Sim::memory_bytes()` natively, the whole linear memory in WASM. Regenerate with `cargo run --release -p sim-headless -- bench --scale`.

| Level | Walkable cells (share) | Runtime | Agents | Ticks | p50 ms | p95 ms | p99 ms | max ms | fields p95 ms | fields max ms | full chase ms | full threat+flee ms | memory MB | setup ms | fence cells broken (ticks) |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grid_city_disc_1300m | 628160 (47%) | native | 20000 | 600 | 6.79 | 10.05 | 11.08 | 34.62 | 8.21 | 28.04 | 12.7 | 7.3 | 94 | 97 | 0 (0) |
| grid_city_disc_1300m | 628160 (47%) | native | 100000 | 600 | 8.02 | 14.01 | 14.41 | 15.05 | 9.73 | 10.44 | 13.0 | 7.3 | 102 | 163 | 0 (0) |
| grid_city_disc_1300m | 628160 (47%) | wasm | 20000 | 600 | 9.58 | 14.95 | 15.90 | 53.60 | 12.68 | 28.20 | – | – | 95 | 247 | 0 (0) |
| grid_city_disc_1300m | 628160 (47%) | wasm | 100000 | 600 | 11.79 | 18.60 | 19.29 | 20.00 | 13.59 | 14.69 | – | – | 108 | 257 | 0 (0) |
| grid_fenced_1300m | 599852 (45%) | native | 20000 | 600 | 5.56 | 7.62 | 8.04 | 20.16 | 5.80 | 13.05 | 12.9 | 4.7 | 100 | 96 | 60 (55) |
| grid_fenced_1300m | 599839 (45%) | native | 100000 | 600 | 6.42 | 12.94 | 13.96 | 39.12 | 9.12 | 29.17 | 13.6 | 4.3 | 105 | 161 | 47 (40) |
| grid_fenced_1300m | 599852 (45%) | wasm | 20000 | 600 | 7.57 | 10.36 | 10.90 | 36.82 | 8.33 | 34.68 | – | – | 102 | 244 | 60 (55) |
| grid_fenced_1300m | 599839 (45%) | wasm | 100000 | 600 | 8.28 | 16.27 | 17.12 | 31.62 | 11.87 | 26.72 | – | – | 109 | 253 | 47 (40) |

## Known issues and simplifications

- Towers have no line-of-sight check: a garrison shoots through buildings (spec simplification).
- Towers are indestructible and zombies ignore them.
- Fields refresh every 5 ticks (chase and threat/flee started on staggered ticks), each computed over the 5 ticks after its start, so agents steer on fields 5–9 ticks (0.25–0.45 s) old; a fence break reaches them within 10 ticks.
- Separation looks at no more than 8 overlapping neighbours and scans at most 48 candidates, so very dense crowds overlap a little.
- With zombies only 0.3 m/s faster than fleeing civilians, the last survivors can run along the map edge for minutes; such runs end in a timeout with a few survivors.
- Benchmarks run inside the Docker dev container (Linux VM on the host), single-threaded.
- QUICK MODE: 2 seeds, no S5, 600 benchmark ticks. Not the reference report.
