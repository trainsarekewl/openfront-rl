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
