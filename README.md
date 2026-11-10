# OpenFront RL

Train a PPO agent to play [OpenFront.io](https://openfront.io)

## License
This repo is AGPL-3.0, because it builds on the OpenFront engine ([openfrontio/OpenFrontIO](https://github.com/openfrontio/OpenFrontIO), AGPL-3.0).

## Layout
- `openfront/` - submodule: fork of OpenFrontIO (`upstream` remote = openfrontio/OpenFrontIO)
- `bridge/` - TypeScript env bridge
- `agent/` - Python Gymnasium env + PPO
- `scripts/` - benchmarks and helpers

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
