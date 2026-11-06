# OpenFront RL

Train a PPO agent to play [OpenFront.io](https://openfront.io)

## License
This repo is AGPL-3.0, because it builds on the OpenFront engine ([openfrontio/OpenFrontIO](https://github.com/openfrontio/OpenFrontIO), AGPL-3.0).

## Layout
- `openfront/` - submodule: fork of OpenFrontIO (`upstream` remote = openfrontio/OpenFrontIO)
- `bridge/` - TypeScript env bridge
- `agent/` - Python Gymnasium env + PPO
- `scripts/` - benchmarks and helpers

## Setup (Windows / PowerShell)
```powershell
git clone --recurse-submodules <this repo>
winget install Schniz.fnm
# add to $PROFILE: fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
fnm install 24            # .node-version pins 24; upstream needs >=24.15 <25
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt   # torch: use the CPU index if desired
cd openfront
npm run inst
npm run dev
```

## Benchmarks (Phase 1)
Machine: 12 threads, 16 GB, Node 22.18. Engine commit `c2d66cdad`.

**Engine only** (`npm run perf:game -- --nations disabled --ticks 3000`, mean ms/tick):

| Map | Bots | ms/tick |
|---|---|---|
| alps | 10 | 0.61 |
| world | 10 | 0.85 |
| aegean | 30 | 1.90 |
| world | 50 | 2.22 |
| world | 200 | 4.51 |

**Agent slot** (`bridge/src/bench.ts`, alps, 10 bots, decision every 10 ticks, random policy, 3000 ticks after the 202-tick spawn phase):
r = about 49 decisions/s on one core (about 490 ticks/s). It is lower than the engine-only number because the random agent grows large and attacks constantly. The agent's decision cost is under 1% of the time.

**Parallel scaling** (`python scripts/bench_parallel.py`, raw data in `scripts/bench_parallel_alps10.json`):

| Processes | Aggregate r (decisions/s) | Per process | Efficiency |
|---|---|---|---|
| 1 | 49 | 49 | 100% |
| 2 | 92 | 46 | 93% |
| 4 | 153 | 38 | 78% |
| 6 | 216 | 36 | 73% |
| 8 | 273 | 34 | 69% |
| 12 | 334 | 28 | 57% |

**T_wall** = decisions needed / aggregate r. This is an upper bound on speed: the real observation, mask and IPC cost is not included yet, and PPO updates need CPU too. Use the 8-process column for planning, which leaves 4 threads for the learner.

| Decisions (steps) | 8 procs (273/s) | 12 procs (334/s) |
|---|---|---|
| 10 M | 10.2 h | 8.3 h |
| 50 M | 2.1 d | 1.7 d |
| 100 M | 4.2 d | 3.5 d |
| 500 M | 21 d | 17 d |

Conclusion: 10–50 M steps (hours to 2 days) is realistic locally; 100 M+ needs rented CPU or a lower decision rate (larger interval, fewer bots, smaller maps).
