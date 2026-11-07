/**
 * Smoke test for env.ts: random actions, applied-action stats, determinism.
 *   npm run smoke -- [--map alps] [--bots 3] [--episodes 2] [--max-ticks 3000]
 */
import {
  Action,
  ActionType,
  GRID,
  MAX_NEIGHBORS,
  NUM_ACTION_TYPES,
  TARGET_UNOWNED,
} from "./actions";
import { OpenFrontEnv } from "./env";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomAction(rnd: () => number): Action {
  const type = Math.floor(rnd() * NUM_ACTION_TYPES) as ActionType;
  let target: number;
  switch (type) {
    case ActionType.Attack:
      target = Math.floor(rnd() * (MAX_NEIGHBORS + 1));
      if (rnd() < 0.5) target = TARGET_UNOWNED;
      break;
    case ActionType.Boat:
    case ActionType.Build:
      target = Math.floor(rnd() * GRID * GRID);
      break;
    default:
      target = Math.floor(rnd() * MAX_NEIGHBORS);
  }
  return { type, target, param: Math.floor(rnd() * 7) };
}

async function episode(
  env: OpenFrontEnv,
  map: string,
  bots: number,
  seed: number,
  maxTicks: number,
) {
  const t0 = performance.now();
  await env.reset({ map, bots, seed, maxTicks });
  const resetMs = performance.now() - t0;
  const rnd = lcg(seed);
  const applied = new Array(NUM_ACTION_TYPES).fill(0);
  const tried = new Array(NUM_ACTION_TYPES).fill(0);
  let steps = 0;
  let total = 0;
  let last;
  const t1 = performance.now();
  for (;;) {
    const a = randomAction(rnd);
    const r = env.step(a);
    steps++;
    total += r.reward;
    tried[a.type]++;
    if (r.info.actionApplied) applied[a.type]++;
    last = r;
    if (r.terminated || r.truncated) break;
  }
  const stepMs = performance.now() - t1;
  return { resetMs, stepMs, steps, total, applied, tried, last: last! };
}

async function main() {
  const map = arg("map", "alps");
  const bots = parseInt(arg("bots", "3"), 10);
  const episodes = parseInt(arg("episodes", "2"), 10);
  const maxTicks = parseInt(arg("max-ticks", "3000"), 10);
  const env = new OpenFrontEnv();

  for (let e = 0; e < episodes; e++) {
    const r = await episode(env, map, bots, 100 + e, maxTicks);
    console.log(
      `ep ${e}: ${r.last.info.outcome} steps=${r.steps} reward=${r.total.toFixed(3)} ` +
        `tileShare=${r.last.info.tileShare.toFixed(4)} reset=${r.resetMs.toFixed(0)}ms ` +
        `steps/s=${((r.steps / r.stepMs) * 1000).toFixed(1)} hash=${r.last.info.hash}`,
    );
    console.log(
      "  applied/tried by type:",
      r.applied.map((a, i) => `${ActionType[i]} ${a}/${r.tried[i]}`).join(", "),
    );
  }

  // Determinism: same seed + same action stream => same final hash.
  const a = await episode(env, map, bots, 7, 1500);
  const b = await episode(env, map, bots, 7, 1500);
  const same = a.last.info.hash === b.last.info.hash && a.steps === b.steps;
  console.log(
    `determinism: ${same ? "OK" : "MISMATCH"} (${a.last.info.hash} vs ${b.last.info.hash})`,
  );
  if (!same) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
