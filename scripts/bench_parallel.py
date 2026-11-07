"""Parallel scaling benchmark for bridge/src/bench.ts.

Runs N concurrent bench processes (each with its own seed) for N in --procs and
reports per-process and aggregate decisions/s (r), plus scaling efficiency
relative to N=1.

    python scripts/bench_parallel.py --procs 1 2 4 6 8 12 --map alps --bots 10
"""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "bridge"
TSX = ROOT / "openfront" / "node_modules" / "tsx" / "dist" / "cli.mjs"

PATTERNS = {
    "r": re.compile(r"r = decisions/s:\s+([\d.]+)"),
    "ticks_s": re.compile(r"\((\d+) ticks/s\)"),
    "ticks": re.compile(r"^ticks:\s+(\d+)", re.M),
    "wall": re.compile(r"^wall:\s+([\d.]+)s", re.M),
    "end": re.compile(r"end reason:\s+(\S+)"),
}


def run_batch(n, bench_args, seed_base):
    procs = []
    for i in range(n):
        seed = f"{seed_base}{i:03d}"[:10].ljust(8, "0")
        cmd = ["node", str(TSX), "src/bench.ts", *bench_args, "--seed", seed]
        procs.append(
            subprocess.Popen(cmd, cwd=BRIDGE, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True)
        )
    results = []
    for p in procs:
        out, _ = p.communicate()
        if p.returncode != 0:
            sys.exit(f"bench failed:\n{out}")
        results.append({k: pat.search(out).group(1) for k, pat in PATTERNS.items()})
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--procs", type=int, nargs="+", default=[1, 2, 4, 6, 8, 12])
    ap.add_argument("--map", default="alps")
    ap.add_argument("--bots", type=int, default=10)
    ap.add_argument("--interval", type=int, default=10)
    ap.add_argument("--max-ticks", type=int, default=3000)
    ap.add_argument("--policy", default="random")
    ap.add_argument("--out", default=None, help="write JSON results here")
    a = ap.parse_args()
    bench_args = ["--map", a.map, "--bots", str(a.bots), "--interval", str(a.interval),
                  "--max-ticks", str(a.max_ticks), "--policy", a.policy]

    rows, base = [], None
    print(f"{'procs':>5} {'agg r':>9} {'r/proc':>8} {'agg ticks/s':>12} {'efficiency':>11} {'batch s':>8}")
    for n in a.procs:
        t0 = time.time()
        res = run_batch(n, bench_args, "par")
        batch = time.time() - t0
        agg_r = sum(float(x["r"]) for x in res)
        agg_t = sum(float(x["ticks_s"]) for x in res)
        if base is None:
            base = agg_r / n
        eff = agg_r / (n * base)
        rows.append(dict(procs=n, agg_r=agg_r, r_per_proc=agg_r / n, agg_ticks_s=agg_t,
                         efficiency=eff, batch_s=batch, ends=[x["end"] for x in res]))
        print(f"{n:>5} {agg_r:>9.1f} {agg_r / n:>8.1f} {agg_t:>12.0f} {eff:>10.0%} {batch:>8.1f}")
    if a.out:
        Path(a.out).write_text(json.dumps(dict(args=vars(a), rows=rows), indent=2))


if __name__ == "__main__":
    main()
