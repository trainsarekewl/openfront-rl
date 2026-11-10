// Mask validity + timing:  npm run mask -- [--map aegean] [--bots 20] [--steps 300] [--seed 5]
import { ActionType } from "./actions";
import { OpenFrontEnv } from "./env";
import { sampleMaskedAction } from "./mask";

function arg(n: string, d: string) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}

async function main() {
  const map = arg("map", "aegean");
  const steps = parseInt(arg("steps", "300"), 10);
  const seed = parseInt(arg("seed", "5"), 10);
  const env = new OpenFrontEnv();
  await env.reset({ map, bots: parseInt(arg("bots", "20"), 10), seed });
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);

  const typeCount = new Array(7).fill(0);
  const applied = new Array(7).fill(0);
  let maskMs = 0, exactMs = 0, n = 0;
  for (let i = 0; i < steps; i++) {
    let t0 = performance.now();
    const m = env.mask(false);
    maskMs += performance.now() - t0;
    if (i % 25 === 0) {
      t0 = performance.now();
      env.mask(true);
      exactMs += performance.now() - t0;
      n++;
    }
    const m2 = env.mask(true);
    const a = sampleMaskedAction(m2, rnd);
    const r = env.step(a);
    typeCount[a.type]++;
    if (r.info.actionApplied) applied[a.type]++;
    if (r.terminated || r.truncated) break;
  }
  console.log(`mask(cheap) ${(maskMs / steps).toFixed(2)} ms, mask(exact) ${(exactMs / Math.max(1, n)).toFixed(1)} ms`);
  for (let t = 0; t < 7; t++) {
    console.log(`  ${ActionType[t].padEnd(16)} sampled=${typeCount[t]} applied=${applied[t]}`);
  }
  // Noop is never "applied"; every other sampled type should apply (boat may miss).
  let bad = 0;
  for (let t = 1; t < 7; t++) {
    if (t !== ActionType.Boat && applied[t] < typeCount[t]) bad += typeCount[t] - applied[t];
  }
  console.log(bad === 0 ? "OK: all masked non-boat actions decoded to intents" : `FAIL: ${bad} masked actions decoded to nothing`);
  process.exit(bad === 0 ? 0 : 1);
}
main();
