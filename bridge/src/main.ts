/**
 * stdio server around OpenFrontEnv. One process = one environment.
 *
 * Framing (both directions): u32le frameLen | u32le headerLen | header JSON | payload
 *   frameLen counts everything after itself. Requests carry no payload.
 *
 * Requests (header JSON):
 *   {cmd:"reset", map, bots, seed, nations?, difficulty?, interval?, maxTicks?, reward?, alliances?}
 *   {cmd:"step",  action:{type,target,param}}
 *   {cmd:"close"}
 * Responses: {ok:true, ...} or {ok:false, error}. Engine exceptions are reported
 * this way instead of killing the process; the client should then reset().
 *   reset -> {ok, mapId, mapName, info, arrays}
 *   step  -> {ok, reward, terminated, truncated, info, arrays}
 * `arrays` = [{name, dtype, shape, offset, nbytes}] indexing into the payload
 * (offsets are 8-byte aligned). Arrays: spatial u8 [C,128,128], scalars f32 [S],
 * and mask_* u8 (see mask.ts), all from the state AFTER the request. On a
 * terminal step the arrays describe the final state.
 *
 * stdout carries frames only: console.* is redirected to stderr.
 */
import { GameMapType } from "@openfront/engine-api/game/GameTypes";
import { writeSync } from "fs";
import { Action } from "./actions";
import { OpenFrontEnv, ResetConfig, resolveMap } from "./env";
import { NUM_CHANNELS, OBS_SIZE, SCALAR_DIM } from "./obs";

for (const k of ["log", "info", "warn", "debug", "error"] as const) {
  console[k] = (...a: unknown[]) => {
    process.stderr.write(a.map(String).join(" ") + "\n");
  };
}

type Arr = {
  name: string;
  dtype: "u8" | "f32";
  shape: number[];
  data: Uint8Array | Float32Array;
};

function encode(header: Record<string, unknown>, arrays: Arr[] = []): Buffer {
  const descs: unknown[] = [];
  const chunks: Buffer[] = [];
  let off = 0;
  for (const a of arrays) {
    const bytes = Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength);
    descs.push({
      name: a.name,
      dtype: a.dtype,
      shape: a.shape,
      offset: off,
      nbytes: bytes.length,
    });
    chunks.push(bytes);
    const pad = (8 - (bytes.length % 8)) % 8;
    if (pad) chunks.push(Buffer.alloc(pad));
    off += bytes.length + pad;
  }
  const h = Buffer.from(JSON.stringify({ ...header, arrays: descs }));
  const out = Buffer.alloc(8);
  out.writeUInt32LE(4 + h.length + off, 0);
  out.writeUInt32LE(h.length, 4);
  return Buffer.concat([out, h, ...chunks]);
}

function send(buf: Buffer): void {
  // Synchronous full write: stdout may be a pipe, so loop over partial writes.
  let o = 0;
  while (o < buf.length) {
    try {
      o += writeSync(1, buf, o, buf.length - o);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") continue;
      throw e;
    }
  }
}

const env = new OpenFrontEnv();

function stateArrays(): Arr[] {
  const o = env.observe();
  const m = env.mask(true);
  return [
    { name: "spatial", dtype: "u8", shape: [NUM_CHANNELS, OBS_SIZE, OBS_SIZE], data: o.spatial },
    { name: "scalars", dtype: "f32", shape: [SCALAR_DIM], data: o.scalars },
    ...Object.entries(m).map(
      ([k, v]): Arr => ({ name: `mask_${k}`, dtype: "u8", shape: [v.length], data: v }),
    ),
  ];
}

async function handle(req: Record<string, unknown>): Promise<Buffer | null> {
  switch (req.cmd) {
    case "reset": {
      const cfg = req as unknown as ResetConfig;
      const info = await env.reset(cfg);
      const mapId = Object.values(GameMapType).indexOf(resolveMap(cfg.map));
      return encode({ ok: true, mapId, mapName: cfg.map, info }, stateArrays());
    }
    case "step": {
      const r = env.step(req.action as Action);
      return encode(
        {
          ok: true,
          reward: r.reward,
          terminated: r.terminated,
          truncated: r.truncated,
          info: r.info,
        },
        stateArrays(),
      );
    }
    case "close":
      return null;
    default:
      throw new Error(`unknown cmd ${String(req.cmd)}`);
  }
}

let buf = Buffer.alloc(0);
let queue: Promise<void> = Promise.resolve();

process.stdin.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const frame = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    const hl = frame.readUInt32LE(0);
    const text = frame.subarray(4, 4 + hl).toString();
    queue = queue.then(async () => {
      try {
        const out = await handle(JSON.parse(text));
        if (out === null) process.exit(0);
        send(out);
      } catch (e) {
        const err = e as Error;
        send(encode({ ok: false, error: `${err.message}\n${err.stack ?? ""}` }));
      }
    });
  }
});
process.stdin.on("end", () => process.exit(0));
