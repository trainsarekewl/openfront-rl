// Sanity checks and timing for obs.ts:  npm run obs -- [--map aegean] [--bots 20] [--warm 150]
import { ActionType, TARGET_UNOWNED } from "./actions";
import { OpenFrontEnv } from "./env";
import { NEIGHBOR_FEATURES, NUM_CHANNELS, OBS_SIZE, SCALAR_DIM, SELF_FEATURES, SPATIAL_LEN } from "./obs";

function arg(n: string, d: string) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}

async function main() {
  const map = arg("map", "aegean");
  const env = new OpenFrontEnv();
  await env.reset({ map, bots: parseInt(arg("bots", "20"), 10), seed: 5 });
  for (let i = 0; i < parseInt(arg("warm", "150"), 10); i++) {
    const r = env.step({ type: ActionType.Attack, target: TARGET_UNOWNED, param: 1 });
    if (r.terminated) break;
  }
  const plane = OBS_SIZE * OBS_SIZE;
  const o = env.observe();
  console.log(`spatial ${o.spatial.length}/${SPATIAL_LEN} (${NUM_CHANNELS}ch), scalars ${o.scalars.length}/${SCALAR_DIM}`);
  const frac = (ch: number) => {
    let n = 0;
    for (let k = 0; k < plane; k++) if (o.spatial[ch * plane + k] > 0) n++;
    return n / plane;
  };
  const me = env.agent;
  const g = env.game;
  console.log(
    `land=${frac(0).toFixed(3)} shore=${frac(1).toFixed(3)} self=${frac(2).toFixed(4)} (true tileShare ${(me.numTilesOwned() / g.map().numLandTiles()).toFixed(4)}, ` +
      `land-only share ${(me.numTilesOwned() / (frac(0) * g.width() * g.height())).toFixed(4)}) ally=${frac(3).toFixed(4)} enemy=${frac(4).toFixed(4)}`,
  );
  console.log(`my attack cells=${frac(9) * plane} incoming=${frac(10) * plane} own mobile=${frac(11) * plane} other mobile=${frac(12) * plane}`);
  console.log(`own structs=${frac(6) * plane} other structs=${frac(7) * plane}, neighbors=${env.neighbors.length}`);
  SELF_FEATURES.forEach((n, i) => console.log(`  ${n.padEnd(20)} ${o.scalars[i].toFixed(4)}`));
  for (let k = 0; k < env.neighbors.length; k++) {
    const base = SELF_FEATURES.length + k * NEIGHBOR_FEATURES.length;
    console.log(`  nb${k}: ` + NEIGHBOR_FEATURES.map((n, i) => `${n}=${o.scalars[base + i].toFixed(3)}`).join(" "));
  }
  let bad = 0;
  for (const v of o.scalars) if (!Number.isFinite(v) || Math.abs(v) > 2.01) bad++;
  console.log(`non-finite or |x|>2 scalars: ${bad}`);

  // ASCII view: 32x16 of self(#) ally(a) enemy(e) land(.) water( )
  for (let j = 0; j < OBS_SIZE; j += 8) {
    let row = "";
    for (let i = 0; i < OBS_SIZE; i += 4) {
      const k = j * OBS_SIZE + i;
      row += o.spatial[2 * plane + k] ? "#" : o.spatial[3 * plane + k] ? "a" : o.spatial[4 * plane + k] ? "e" : o.spatial[k] ? "." : " ";
    }
    console.log(row);
  }
  const N = 200;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) env.observe();
  console.log(`observe(): ${((performance.now() - t0) / N).toFixed(2)} ms/call`);
}
main().catch((e) => { console.error(e); process.exit(1); });
