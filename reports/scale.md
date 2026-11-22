## Scale (wave 8)

Synthetic `grid_city_disc` levels (40 m blocks, 14 m streets) cut to a circle, plus the Paris Marais buildings tiled to the same size (`marais-tiled`, real street geometry). No defense, seed 1, 12 outbreak clusters, run until civilians drop below 15% (the wave-defeat rule) or 8000 ticks. Max is dominated by isolated host hiccups (single ticks, not reproducible); p95/p99 are the robust figures. Memory: `Sim::memory_bytes()` natively, the whole linear memory in WASM. Regenerate with `cargo run --release -p sim-headless -- bench --scale`.

| Level | Walkable cells (share) | Runtime | Agents | Ticks | p50 ms | p95 ms | p99 ms | max ms | fields p95 ms | fields max ms | full chase ms | full threat+flee ms | memory MB | setup ms |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grid_city_disc_1100m | 454380 (48%) | native | 20000 | 5565 | 8.59 | 14.46 | 15.43 | 42.49 | 10.82 | 31.26 | 8.8 | 6.0 | 76 | 72 |
| grid_city_disc_1100m | 454380 (48%) | native | 50000 | 3922 | 11.70 | 19.39 | 20.74 | 126.57 | 10.96 | 96.36 | 8.9 | 6.3 | 79 | 94 |
| grid_city_disc_1100m | 454380 (48%) | native | 100000 | 3427 | 16.43 | 27.44 | 28.82 | 86.20 | 11.04 | 34.71 | 9.1 | 6.0 | 83 | 134 |
| grid_city_disc_1100m | 454380 (48%) | native | 150000 | 2993 | 22.71 | 36.39 | 38.58 | 62.79 | 11.55 | 34.56 | 9.7 | 6.9 | 86 | 176 |
| grid_city_disc_1100m | 454380 (48%) | wasm | 20000 | 5565 | 12.26 | 17.87 | 18.64 | 111.88 | 13.56 | 108.69 | – | – | 78 | 202 |
| grid_city_disc_1100m | 454380 (48%) | wasm | 50000 | 3922 | 16.31 | 24.31 | 25.58 | 78.37 | 14.19 | 47.99 | – | – | 81 | 162 |
| grid_city_disc_1100m | 454380 (48%) | wasm | 100000 | 3427 | 21.81 | 34.18 | 35.72 | 139.72 | 14.34 | 31.08 | – | – | 86 | 202 |
| grid_city_disc_1100m | 454380 (48%) | wasm | 150000 | 2993 | 29.21 | 44.14 | 45.40 | 67.86 | 14.91 | 34.89 | – | – | 89 | 242 |
| grid_city_disc_1300m | 628160 (47%) | native | 20000 | 6649 | 10.58 | 18.50 | 21.48 | 74.42 | 14.49 | 68.45 | 13.2 | 7.5 | 108 | 92 |
| grid_city_disc_1300m | 628160 (47%) | native | 50000 | 5366 | 13.71 | 23.42 | 24.71 | 58.48 | 15.08 | 48.51 | 11.8 | 6.2 | 111 | 116 |
| grid_city_disc_1300m | 628160 (47%) | native | 100000 | 4021 | 18.80 | 32.80 | 36.64 | 73.01 | 15.69 | 39.82 | 12.4 | 6.9 | 115 | 159 |
| grid_city_disc_1300m | 628160 (47%) | native | 150000 | 3633 | 23.19 | 41.02 | 50.17 | 101.08 | 16.23 | 50.22 | 13.6 | 6.9 | 118 | 197 |
| grid_city_disc_1300m | 628160 (47%) | wasm | 20000 | 6649 | 15.10 | 23.73 | 25.36 | 93.10 | 18.96 | 60.93 | – | – | 113 | 257 |
| grid_city_disc_1300m | 628160 (47%) | wasm | 50000 | 5366 | 17.70 | 28.39 | 30.36 | 93.40 | 18.51 | 75.56 | – | – | 117 | 206 |
| grid_city_disc_1300m | 628160 (47%) | wasm | 100000 | 4021 | 25.56 | 38.61 | 40.42 | 150.75 | 19.99 | 140.81 | – | – | 121 | 242 |
| grid_city_disc_1300m | 628160 (47%) | wasm | 150000 | 3633 | 28.40 | 46.91 | 48.64 | 52.11 | 18.79 | 20.83 | – | – | 125 | 282 |
| grid_city_disc_1600m | 946240 (47%) | native | 20000 | 8000 | 13.27 | 24.43 | 26.12 | 79.45 | 20.43 | 58.49 | 20.0 | 7.6 | 155 | 124 |
| grid_city_disc_1600m | 946240 (47%) | native | 50000 | 7026 | 14.94 | 29.47 | 31.04 | 48.27 | 20.95 | 33.14 | 18.6 | 7.1 | 157 | 151 |
| grid_city_disc_1600m | 946240 (47%) | native | 100000 | 5587 | 19.10 | 38.02 | 40.03 | 57.44 | 22.23 | 47.96 | 18.4 | 7.2 | 162 | 181 |
| grid_city_disc_1600m | 946240 (47%) | native | 150000 | 4579 | 24.50 | 46.92 | 49.31 | 56.32 | 22.97 | 28.60 | 21.5 | 7.9 | 167 | 226 |
| grid_city_disc_1600m | 946240 (47%) | wasm | 20000 | 8000 | 18.33 | 31.53 | 32.95 | 35.98 | 26.58 | 30.25 | – | – | 159 | 358 |
| grid_city_disc_1600m | 946240 (47%) | wasm | 50000 | 7026 | 20.16 | 36.21 | 37.68 | 139.19 | 26.24 | 108.69 | – | – | 163 | 281 |
| grid_city_disc_1600m | 946240 (47%) | wasm | 100000 | 5587 | 26.33 | 49.04 | 51.18 | 160.00 | 29.09 | 149.33 | – | – | 167 | 319 |
| grid_city_disc_1600m | 946240 (47%) | wasm | 150000 | 4579 | 34.18 | 61.08 | 63.37 | 104.14 | 30.97 | 82.65 | – | – | 171 | 368 |
| marais_tiled_1300m | 907229 (68%) | native | 20000 | 6509 | 15.36 | 23.45 | 26.08 | 95.18 | 19.49 | 76.02 | 24.2 | 12.8 | 118 | 215 |
| marais_tiled_1300m | 907229 (68%) | native | 50000 | 6004 | 18.62 | 28.17 | 30.36 | 82.33 | 19.80 | 66.07 | 23.8 | 11.2 | 117 | 231 |
| marais_tiled_1300m | 907229 (68%) | native | 100000 | 4841 | 23.00 | 36.15 | 38.38 | 67.48 | 20.17 | 53.38 | 22.7 | 10.8 | 124 | 272 |
| marais_tiled_1300m | 907229 (68%) | native | 150000 | 3842 | 29.17 | 45.17 | 47.52 | 83.23 | 20.87 | 69.42 | 21.5 | 10.5 | 130 | 317 |
| marais_tiled_1300m | 907229 (68%) | wasm | 20000 | 6509 | 22.49 | 30.14 | 32.21 | 137.00 | 26.10 | 132.08 | – | – | 124 | 466 |
| marais_tiled_1300m | 907229 (68%) | wasm | 50000 | 6004 | 24.55 | 35.62 | 36.74 | 108.51 | 25.80 | 92.02 | – | – | 124 | 371 |
| marais_tiled_1300m | 907229 (68%) | wasm | 100000 | 4841 | 30.58 | 45.68 | 47.00 | 102.43 | 25.88 | 79.42 | – | – | 135 | 418 |
| marais_tiled_1300m | 907229 (68%) | wasm | 150000 | 3842 | 38.75 | 56.41 | 58.12 | 138.37 | 26.72 | 112.61 | – | – | 135 | 447 |

### Break-heavy case (`grid_fenced`)

`level::grid_city_disc_fenced`: the 1.3 km grid with a fence through every block row and column (every street segment fenced once, no detour), fence hp 6 per cell, fence path cost 100, 12 outbreak clusters, seed 1, no other defense, 2,000 ticks (the setup of the DECISIONS.md break-heavy figures). Field jobs keep the grid of their start tick (frozen copies on fence breaks). Regenerate with `cargo run --release -p sim-headless -- bench --scale --radii none --level none --fenced 1300 --pops 100000 --ticks 2000`.

| Level | Walkable cells (share) | Runtime | Agents | Ticks | p50 ms | p95 ms | p99 ms | max ms | fields p95 ms | fields max ms | full chase ms | full threat+flee ms | memory MB | setup ms | fence cells broken (ticks) |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grid_fenced_1300m | 600246 (45%) | native | 100000 | 2000 | 7.99 | 14.19 | 14.88 | 40.22 | 9.07 | 11.51 | 13.6 | 4.2 | 107 | 156 | 454 (364) |
| grid_fenced_1300m | 600246 (45%) | wasm | 100000 | 2000 | 10.57 | 17.96 | 18.68 | 40.61 | 12.00 | 32.49 | – | – | 111 | 312 | 454 (364) |
