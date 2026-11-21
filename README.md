# sokoban-solver-01

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/faridmuse/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/faridmuse/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: one program answers 5 instances drawn after the deadline, each scored 0 to 1,000 by a sealed checker. Built by an AI agent for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty, $100 in USDC.

## How it works

The generator builds every level as a one-wide hallway with one to four rooms off it, each room opening onto the hallway through a single door — and a box pushed out of a door into the hallway can never be pushed back, so every box stays in its room and each room is its own little Sokoban problem. The solver exploits that:

1. **Split** the level into its rooms: the hallway is the player's row, a door is a floor square in the row beside it that opens onto a hallway square, and a room is everything reachable from its door without stepping into the hallway row.
2. **Solve each room on its own** with a push-based A*: a state is the sorted boxes plus the player's reachable region, a step is one push, and the estimate is the cheapest matching of boxes to goals by shortest-path distance. It is pruned by a dead-square table (reverse-push reachability from the goals) and freeze deadlocks. The first goal it finds is push-optimal.
3. **Stitch** the rooms' push sequences into one player-move string by walking the player between pushes and between rooms with BFS, then **replay** the whole string on the level before writing it out.

All budgets are counts of expanded states, never the wall clock, so two runs write the same bytes.

## Results

Practice set (kit): **1,000,000 / 1,000,000** — every instance solved in exactly its push-optimal count (13, 16, 29, 47, 60 pushes), in about 0.6 s on one CPU. The house baseline plain-astar 1.0.0 scores 200,000 on the same set. Eight further sets drawn fresh from the kit's generator with other seeds all score 1,000,000 too.

## Run it

```sh
node main.ts
```

It reads `/input/i001/` … `/input/i005/level.txt` and writes `/output/<id>/solution.txt` for each. For a local run, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`, as in the kit's starter. Node 22, no dependencies, no network.
