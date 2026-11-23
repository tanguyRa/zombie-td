# Zombie TD — headless report

Generated 2026-11-23 04:57 UTC from commit `a9b5fae (with uncommitted changes)`. Regenerate with `cargo run --release -p sim-headless -- report`.

## Summary

| Check | Target | Measured | Result |
|---|---|---|---|
| Native p95 tick, 100k | ≤ 15 ms | 7.50 ms | **PASS** |
| Native max tick, 100k | ≤ 30 ms | 8.34 ms | **PASS** |
| WASM p95 tick, 100k | ≤ 25 ms | 9.02 ms | **PASS** |
| WASM max tick, 100k | ≤ 45 ms | 9.54 ms | **PASS** |
| Tests: sim-core unit | all pass | 101/101 | **PASS** |
| Tests: M1 level | all pass | 4/4 | **PASS** |
| Tests: M2 rules | all pass | 7/7 | **PASS** |
| Tests: M3 tools | all pass | 10/10 | **PASS** |
| Tests: T1 scale | all pass | 9/9 | **PASS** |
| Tests: Native = WASM | all pass | 12/12 | **PASS** |

## Environment

| | |
|---|---|
| Host CPU | unknown (set HOST_CPU) |
| CPU seen by the container | aarch64 (model not exposed inside the container) |
| Cores available | 8 |
| OS | macos (23.6.0 arm64) |
| rustc | rustc 1.100.0 (0ef1bc386 2026-11-09) |
| Node | v26.5.0 |
| Git commit | a9b5fae (with uncommitted changes) |

## Tests

| Group | Test | Result |
|---|---|---|
| sim-core unit | `mapsnap::tests::duplicate_block_is_refused` | ok |
| sim-core unit | `rng::tests::reference_stream` | ok |
| sim-core unit | `mapsnap::tests::fnv1a64_known_vectors` | ok |
| sim-core unit | `sim::tests::agents_far_inside_walls_are_pushed_out` | ok |
| sim-core unit | `sim::tests::splash_is_centred_on_the_hash_time_position` | ok |
| sim-core unit | `match_::tests::state_hash_covers_what_the_rest_of_a_wave_depends_on` | ok |
| sim-core unit | `grid::tests::nearest_walk_matches_the_full_square_search` | ok |
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
| sim-core unit | `a_half_applied_building_owns_only_its_new_cells` | ok |
| sim-core unit | `an_empty_ring_still_plays` | ok |
| sim-core unit | `a_reveal_never_walls_off_the_territory_already_played` | ok |
| sim-core unit | `config_is_valid_and_rings_fit_the_level` | ok |
| sim-core unit | `a_level_fence_in_a_walled_ring_never_opens_it` | ok |
| sim-core unit | `a_population_capped_match_plays` | ok |
| sim-core unit | `a_level_fence_never_reopens_a_walled_pocket` | ok |
| sim-core unit | `a_block_beyond_the_old_grid_edge_is_awaited` | ok |
| sim-core unit | `absent_agents_never_move_or_get_bitten` | ok |
| sim-core unit | `chunks_with_bad_bounds_or_coordinates_are_refused` | ok |
| sim-core unit | `newcomers_come_from_the_new_ring_and_survivors_stay_put` | ok |
| sim-core unit | `placements_persist_and_broken_fences_stay_broken` | ok |
| sim-core unit | `raw_grid_write_mid_wave_panics - should panic` | ok |
| sim-core unit | `outbreaks_follow_the_per_wave_placement_rules` | ok |
| sim-core unit | `restart_rebuilds_the_initial_match` | ok |
| sim-core unit | `chunks_give_the_same_match_whatever_their_arrival_order` | ok |
| sim-core unit | `ring_ready_waits_for_every_block_the_reveal_would_refuse` | ok |
| sim-core unit | `retry_restores_the_prep_state_exactly` | ok |
| sim-core unit | `ring_reveal_walls_cells_outside_the_current_radius` | ok |
| sim-core unit | `state_hash_sees_the_defeat_line` | ok |
| sim-core unit | `match_hash_fixture` | ok |
| sim-core unit | `tiny_levels_play_through` | ok |
| sim-core unit | `wrong_phase_actions_are_refused` | ok |
| sim-core unit | `win_and_lose_thresholds` | ok |
| sim-core unit | `fatigue_slows_civilians_only` | ok |
| sim-core unit | `debug_fence_break_mid_wave_ignores_field_budgets` | ok |
| sim-core unit | `ring_ready_and_area_revealed_agree` | ok |
| sim-core unit | `retry_after_fence_breaks_replays_exactly` | ok |
| sim-core unit | `match_hash_ignores_field_budgets_and_eager_jobs` | ok |
| sim-core unit | `same_seed_and_actions_give_the_same_hashes` | ok |
| sim-core unit | `cards_json_has_the_v1_cards` | ok |
| sim-core unit | `deck_rules_are_enforced_with_clear_errors` | ok |
| sim-core unit | `fences_from_cards_have_their_length_and_hp` | ok |
| sim-core unit | `garrison_cards_equip_buildings` | ok |
| sim-core unit | `an_empty_keep_choice_keeps_nothing` | ok |
| sim-core unit | `huge_fence_coordinates_are_refused_quickly` | ok |
| sim-core unit | `airstrike_and_convoy` | ok |
| sim-core unit | `a_cell_taken_over_twice_goes_back_whatever_the_pull_down_order` | ok |
| sim-core unit | `outbreaks_scale_with_squeezed_rings` | ok |
| sim-core unit | `a_mulligan_drops_an_earlier_keep_choice` | ok |
| sim-core unit | `phase_restrictions_use_the_right_error` | ok |
| sim-core unit | `mortar_splash_and_minimum_range` | ok |
| sim-core unit | `repair_and_pull_down` | ok |
| sim-core unit | `pulling_down_a_fence_gives_taken_over_cells_back` | ok |
| sim-core unit | `mulligan_and_keep_rules` | ok |
| sim-core unit | `paratrooper_lands_after_ten_seconds_and_shoots` | ok |
| sim-core unit | `strikes_hit_an_area_after_their_delay` | ok |
| sim-core unit | `retry_restores_hand_deck_supply_and_structures` | ok |
| sim-core unit | `draw_keep_discard_reshuffle_over_eight_waves` | ok |
| sim-core unit | `card_state_is_in_the_state_hash` | ok |
| sim-core unit | `a_mulligan_on_an_empty_deck_draws_from_the_reshuffled_discard` | ok |
| sim-core unit | `supply_income_and_carry_over` | ok |
| sim-core unit | `scripted_match_with_the_starter_deck` | ok |
| sim-core unit | `oversized_shells_and_fences_are_refused_quickly` | ok |
| sim-core unit | `a_forged_chunk_shell_is_refused` | ok |
| sim-core unit | `streamed_records_do_not_depend_on_chunk_order` | ok |
| sim-core unit | `scripted_match_covers_the_actions` | ok |
| sim-core unit | `record_json_layout` | ok |
| sim-core unit | `golden_run_record` | ok |
| sim-core unit | `huge_logs_and_endless_records_are_refused_quickly` | ok |
| sim-core unit | `tamper_card_not_in_hand` | ok |
| sim-core unit | `tamper_future_tick` | ok |
| sim-core unit | `tamper_map` | ok |
| sim-core unit | `tamper_reordered_actions` | ok |
| sim-core unit | `tamper_seed_and_deck` | ok |
| sim-core unit | `tamper_versions_config_cards` | ok |
| sim-core unit | `endless_waves_and_preps_stop_at_the_limit` | ok |
| sim-core unit | `tamper_changed_tick` | ok |
| sim-core unit | `tamper_changed_action` | ok |
| sim-core unit | `the_population_multiplier_is_range_checked` | ok |
| sim-core unit | `the_progress_callback_can_cancel` | ok |
| sim-core unit | `tamper_not_enough_supply` | ok |
| sim-core unit | `unknown_record_fields_are_refused` | ok |
| sim-core unit | `tamper_edited_wave_hash` | ok |
| sim-core unit | `tamper_wrong_phase` | ok |
| sim-core unit | `a_truncated_record_verifies_as_abandoned` | ok |
| sim-core unit | `the_replayer_steps_to_the_same_summary_with_every_check` | ok |
| sim-core unit | `scripted_record_replays_three_times` | ok |
| sim-core unit | `the_issued_seed_deck_and_multiplier_are_enforced` | ok |
| sim-core unit | `the_end_prep_hash_and_start_tick_are_checked_on_a_result_screen` | ok |
| sim-core unit | `phase_and_kind_names_read_as_words` | ok |
| sim-core unit | `no_debug_names_or_hidden_indices` | ok |
| sim-core unit | `verifier_deck_and_setup_messages_read_as_words` | ok |
| sim-core unit | `fnv1a64_known_vectors` | ok |
| sim-core unit | `fixture_matches_the_config` | ok |
| sim-core unit | `snapshot_hash_matches_js` | ok |
| sim-core unit | `streaming_match_from_the_fixture` | ok |
| sim-core unit | `verify::tests::numbers_are_digits_or_a_plain_decimal` | ok |
| sim-core unit | `streamed_run_verifies_with_a_shell_file` | ok |
| sim-core unit | `verify_run_mjs_rejects_bad_arguments` | ok |
| sim-core unit | `both_verifiers_share_one_number_grammar` | ok |
| sim-core unit | `scripted_starter_deck_match_clears_the_marais` | ok |
| sim-core unit | `recorded_match_verifies_and_tampering_is_rejected` | ok |
| Native = WASM | `wasm_verifies_the_golden_run_record` | ok |
| Native = WASM | `wasm_verifies_streamed_runs_on_the_servers_shell` | ok |
| Native = WASM | `wasm_validate_deck_matches_the_cases` | ok |
| Native = WASM | `wasm_summary_says_whether_the_setup_was_checked` | ok |
| Native = WASM | `wasm_sim_runs_and_reports` | ok |
| Native = WASM | `wasm_replay_mode_plays_the_golden_record` | ok |
| Native = WASM | `wasm_rejects_a_tampered_record` | ok |
| Native = WASM | `wasm_match_hash_matches_native_fixture` | ok |
| Native = WASM | `wasm_match_binding_follows_the_golden_log` | ok |
| Native = WASM | `wasm_hash_matches_native_fixture` | ok |
| Native = WASM | `wasm_fence_break_hash_matches_native_fixture` | ok |
| Native = WASM | `wasm_checks_the_issued_run` | ok |

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
| native | 10000 | 1.34 | 1.78 | 1.84 | 1.93 | 1.31 | 84.5% |
| native | 50000 | 3.29 | 4.30 | 4.48 | 4.59 | 3.35 | 86.6% |
| native | 100000 | 5.96 | 7.50 | 7.85 | 8.34 | 5.92 | 87.3% |
| wasm | 10000 | 1.88 | 2.73 | 2.97 | 3.02 | 1.85 | 84.5% |
| wasm | 50000 | 4.21 | 5.51 | 5.87 | 6.52 | 4.24 | 86.6% |
| wasm | 100000 | 7.29 | 9.02 | 9.36 | 9.54 | 7.23 | 87.3% |

Mean ms per phase:

| Runtime | Agents | hash | fields | civilians | zombies | infected | separation | integrate | towers | fences |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| native | 10000 | 0.176 | 0.785 | 0.065 | 0.022 | 0.007 | 0.237 | 0.020 | 0.000 | 0.000 |
| native | 50000 | 0.376 | 0.806 | 0.291 | 0.180 | 0.033 | 1.564 | 0.097 | 0.000 | 0.000 |
| native | 100000 | 0.604 | 0.867 | 0.543 | 0.200 | 0.064 | 3.448 | 0.190 | 0.000 | 0.000 |
| wasm | 10000 | 0.173 | 1.245 | 0.101 | 0.038 | 0.010 | 0.259 | 0.025 | 0.000 | 0.001 |
| wasm | 50000 | 0.425 | 1.272 | 0.446 | 0.269 | 0.049 | 1.660 | 0.122 | 0.000 | 0.000 |
| wasm | 100000 | 0.697 | 1.364 | 0.845 | 0.336 | 0.097 | 3.650 | 0.241 | 0.000 | 0.000 |

Top hot spots, native 100k: separation (58%), fields (15%), hash (10%).

Top hot spots, wasm 100k: separation (50%), fields (19%), civilians (12%).

## 8-wave match

`sim-headless match --level paris-marais --seed 1`: the starter deck "Civil Defence Issue" played by the scripted defence (armaments on spread-out buildings, fences as arcs, tactical cards on the densest zombies, up to 3 retries per lost wave). One row per wave attempt; tick times are this run's, native, single thread.

| wave | try | radius m | newcomers | start civ | end civ | saved | killed | bites | towers | cards | supply left | game s | result | tick p50 ms | p95 ms | max ms | end hash |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 150 | 760 | 760 | 630 | 83% | 130 | 127 | 10 | 5 | 0 | 81 | won | 0.28 | 0.36 | 4.68 | 582f5a765e254c50 |
| 2 | 1 | 183 | 358 | 988 | 861 | 87% | 127 | 116 | 22 | 4 | 0 | 83 | won | 0.32 | 0.44 | 4.70 | 5ea0e20955c70dcd |
| 3 | 1 | 215 | 398 | 1259 | 1170 | 93% | 89 | 83 | 25 | 4 | 5 | 103 | won | 0.35 | 0.45 | 4.72 | 9835a452c0b14d77 |
| 4 | 1 | 248 | 603 | 1773 | 1591 | 90% | 182 | 173 | 33 | 3 | 4 | 105 | won | 0.42 | 0.56 | 4.62 | aa2236f13c5dd86c |
| 5 | 1 | 286 | 927 | 2518 | 2482 | 99% | 36 | 18 | 45 | 5 | 1 | 30 | won | 0.48 | 0.66 | 4.67 | c83e3bc1853abc45 |
| 6 | 1 | 324 | 811 | 3293 | 3281 | 100% | 12 | 2 | 54 | 4 | 2 | 8 | won | 0.53 | 0.68 | 4.99 | 39bf2cf41b88f11b |
| 7 | 1 | 362 | 1429 | 4710 | 4665 | 99% | 45 | 28 | 56 | 5 | 9 | 17 | won | 0.63 | 0.85 | 5.03 | 89bab5ce00edcca5 |
| 8 | 1 | 400 | 971 | 5636 | 5587 | 99% | 49 | 31 | 66 | 5 | 6 | 30 | won | 0.78 | 1.08 | 5.44 | 9aaa56d15f51b737 |

phase MatchWon at wave 8/8, retries 0, civilians alive 5587, agents in play 6257 of 100000, memory ~24 MB. Played in 3.9 s (wall, native). Run record: 58 actions, 8 attempts, 9120 ticks (456 s of game time). Native replay: 3.9 s, verified (8 attempts, final hash `f88fe8517996e2a6`). WASM (Node) replay: 5.2 s, verified (`tools/verify-run.mjs`, Node start-up included).

## Scale (wave 8)

Synthetic `grid_city_disc` levels (40 m blocks, 14 m streets) cut to a circle, plus the Paris Marais buildings tiled to the same size (`marais-tiled`, real street geometry). `grid_fenced` is the break-heavy case: the same grid with a fence through every block row and column (every street segment fenced once, no detour), fence hp 6 per cell and fence path cost 100, so zombies chew through all wave. No other defense, seed 1, 12 outbreak clusters, run until civilians drop below 15% (the wave-defeat rule) or 600 ticks. Max is dominated by isolated host hiccups (single ticks, not reproducible); p95/p99 are the robust figures. Memory: `Sim::memory_bytes()` natively, the whole linear memory in WASM. Regenerate with `cargo run --release -p sim-headless -- bench --scale`.

| Level | Walkable cells (share) | Runtime | Agents | Ticks | p50 ms | p95 ms | p99 ms | max ms | fields p95 ms | fields max ms | full chase ms | full threat+flee ms | memory MB | setup ms | fence cells broken (ticks) |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grid_city_disc_1300m | 628160 (47%) | native | 20000 | 600 | 6.19 | 8.94 | 9.30 | 10.14 | 7.24 | 8.22 | 12.1 | 6.5 | 94 | 90 | 0 (0) |
| grid_city_disc_1300m | 628160 (47%) | native | 100000 | 600 | 7.26 | 12.90 | 13.38 | 13.66 | 9.01 | 9.78 | 12.2 | 6.5 | 102 | 154 | 0 (0) |
| grid_city_disc_1300m | 628160 (47%) | wasm | 20000 | 600 | 8.41 | 12.67 | 13.11 | 14.94 | 10.72 | 12.84 | – | – | 95 | 250 | 0 (0) |
| grid_city_disc_1300m | 628160 (47%) | wasm | 100000 | 600 | 10.75 | 16.71 | 17.18 | 18.51 | 12.03 | 13.17 | – | – | 108 | 256 | 0 (0) |
| grid_fenced_1300m | 599852 (45%) | native | 20000 | 600 | 4.99 | 6.87 | 7.18 | 7.90 | 5.17 | 6.05 | 12.1 | 4.3 | 100 | 88 | 60 (55) |
| grid_fenced_1300m | 599839 (45%) | native | 100000 | 600 | 5.75 | 11.68 | 12.01 | 12.96 | 8.21 | 8.95 | 12.3 | 3.9 | 105 | 145 | 47 (40) |
| grid_fenced_1300m | 599852 (45%) | wasm | 20000 | 600 | 6.81 | 9.25 | 9.68 | 10.90 | 7.41 | 8.86 | – | – | 102 | 244 | 60 (55) |
| grid_fenced_1300m | 599839 (45%) | wasm | 100000 | 600 | 7.56 | 14.99 | 15.30 | 15.97 | 10.94 | 11.76 | – | – | 109 | 255 | 47 (40) |

## Known issues and simplifications

- Towers have no line-of-sight check: a garrison shoots through buildings (spec simplification).
- Towers are indestructible and zombies ignore them.
- Fields refresh every 5 ticks (chase and threat/flee started on staggered ticks), each computed over the 5 ticks after its start, so agents steer on fields 5–9 ticks (0.25–0.45 s) old; a fence break reaches them within 10 ticks.
- Separation looks at no more than 8 overlapping neighbours and scans at most 48 candidates, so very dense crowds overlap a little.
- With zombies only 0.3 m/s faster than fleeing civilians, the last survivors can run along the map edge for minutes; such runs end in a timeout with a few survivors.
- Benchmarks run inside the Docker dev container (Linux VM on the host), single-threaded.
- QUICK MODE: 2 seeds, no S5, 600 benchmark ticks. Not the reference report.
