// Spawns main.ts and drives it over stdio like the Python client will.
//   npm run main-check -- [--map aegean] [--bots 10] [--steps 200]
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

function arg(n: string, d: string) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const dir = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.resolve(dir, "../../openfront/node_modules/tsx/dist/cli.mjs");
const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
  tsx,
  path.join(dir, "main.ts"),
]);
child.stderr.on("data", () => {});
let acc = Buffer.alloc(0);
let waiter: ((f: Buffer) => void) | null = null;
child.stdout.on("data", (c: Buffer) => {
  acc = Buffer.concat([acc, c]);
  if (waiter && acc.length >= 4 && acc.length >= 4 + acc.readUInt32LE(0)) {
    const len = acc.readUInt32LE(0);
    const f = acc.subarray(4, 4 + len);
    acc = acc.subarray(4 + len);
    const w = waiter;
    waiter = null;
    w(f);
  }
});

type Resp = { h: any; payload: Buffer };
function call(req: object): Promise<Resp> {
  const h = Buffer.from(JSON.stringify(req));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(4 + h.length, 0);
  head.writeUInt32LE(h.length, 4);
  return new Promise((res) => {
    waiter = (f) => {
      const hl = f.readUInt32LE(0);
      res({ h: JSON.parse(f.subarray(4, 4 + hl).toString()), payload: f.subarray(4 + hl) });
    };
    child.stdin.write(Buffer.concat([head, h]));
  });
}

async function main() {
  const t0 = performance.now();
  let r = await call({
    cmd: "reset",
    map: arg("map", "aegean"),
    bots: parseInt(arg("bots", "10"), 10),
    seed: 3,
  });
  if (!r.h.ok) throw new Error(r.h.error);
  console.log(
    `reset ${(performance.now() - t0).toFixed(0)} ms, mapId=${r.h.mapId}`,
    r.h.arrays.map((a: any) => `${a.name}:${a.nbytes}`).join(" "),
  );
  const bad = await call({ cmd: "bogus" });
  console.log("bad cmd ->", bad.h.ok, String(bad.h.error).split("\n")[0]);

  const n = parseInt(arg("steps", "200"), 10);
  const t1 = performance.now();
  let steps = 0;
  for (; steps < n; steps++) {
    r = await call({ cmd: "step", action: { type: 1, target: 8, param: 1 } });
    if (!r.h.ok) throw new Error(r.h.error);
    if (r.h.terminated || r.h.truncated) break;
  }
  const sp = r.h.arrays.find((a: any) => a.name === "scalars");
  const base = r.payload.byteOffset + sp.offset;
  const f = new Float32Array(r.payload.buffer.slice(base, base + sp.nbytes));
  console.log(
    `${steps} steps, ${(steps / ((performance.now() - t1) / 1000)).toFixed(0)} steps/s over pipe; ` +
      `scalars[0..2]=${Array.from(f.slice(0, 3)).map((x) => x.toFixed(3))}`,
  );
  const again = await call({ cmd: "reset", map: "aegean", bots: 5, seed: 4 });
  console.log("second reset ok:", again.h.ok);
  child.kill();
}
main().then(() => process.exit(0));
