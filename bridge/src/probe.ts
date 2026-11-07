// Probe which actions are valid, and how expensive validity checks are.
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  Action,
  ActionType,
  BUILD_TYPES,
  decodeAction,
  GRID,
  MAX_NEIGHBORS,
  TARGET_UNOWNED,
} from "./actions";
import { OpenFrontEnv } from "./env";

function arg(n: string, d: string) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}

async function main() {
  const map = arg("map", "aegean");
  const bots = parseInt(arg("bots", "10"), 10);
  const seed = parseInt(arg("seed", "1"), 10);
  const warm = parseInt(arg("warm", "60"), 10); // steps of attacking unowned
  const env = new OpenFrontEnv();
  await env.reset({ map, bots, seed });
  for (let i = 0; i < warm; i++) {
    const r = env.step({ type: ActionType.Attack, target: TARGET_UNOWNED, param: 1 });
    if (r.terminated) break;
  }
  const g = env.game;
  const me = env.agent;
  const mp = g.map();
  let shore = 0;
  for (const t of me.borderTiles()) if (mp.isShore(t)) shore++;
  console.log(
    `${map} seed=${seed} tick=${g.ticks()} tiles=${me.numTilesOwned()} border=${me.borderTiles().size} ` +
      `shoreBorder=${shore} gold=${me.gold()} troops=${Math.round(me.troops())} neighbors=${env.neighbors.length}`,
  );

  const ctx = {
    game: g,
    me,
    clientID: env.clientID,
    neighbors: env.neighbors,
    shore: env.shore,
    waterComps: env.waterComps,
  };

  // Boat sweep
  let t0 = performance.now();
  let boatOk = 0;
  for (let c = 0; c < GRID * GRID; c++) {
    const a: Action = { type: ActionType.Boat, target: c, param: 1 };
    if (decodeAction(a, ctx)) boatOk++;
  }
  console.log(`boat: ${boatOk}/${GRID * GRID} cells valid, sweep ${(performance.now() - t0).toFixed(0)}ms`);

  // Build sweeps
  for (let b = 0; b < BUILD_TYPES.length; b++) {
    t0 = performance.now();
    let ok = 0;
    for (let c = 0; c < GRID * GRID; c++) {
      if (decodeAction({ type: ActionType.Build, target: c, param: b }, ctx)) ok++;
    }
    console.log(
      `build ${BUILD_TYPES[b]}: ${ok} cells valid, cost=${me.buildableUnits(null).find((u) => u.type === BUILD_TYPES[b])?.cost}, sweep ${(performance.now() - t0).toFixed(0)}ms`,
    );
  }

  // Alliances
  for (let s = 0; s < env.neighbors.length; s++) {
    const n = env.neighbors[s];
    console.log(
      `neighbor ${s} ${n.id()} type=${n.type()} tiles=${n.numTilesOwned()} canSendAlliance=${me.canSendAllianceRequest(n)} allied=${me.isAlliedWith(n)} ` +
        `incoming=${me.incomingAllianceRequests().some((r) => r.requestor() === n)}`,
    );
  }
  console.log(`incoming requests total: ${me.incomingAllianceRequests().length}`);
  // Send requests to all neighbors, step, see what happens.
  for (let s = 0; s < env.neighbors.length; s++) {
    env.step({ type: ActionType.AllianceRequest, target: s, param: 0 });
  }
  for (let i = 0; i < 20; i++) env.step({ type: ActionType.Noop, target: 0, param: 0 });
  console.log(
    `after requests: allies=${env.game.players().filter((p) => p !== me && me.isAlliedWith(p)).length}, incoming=${me.incomingAllianceRequests().length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
void UnitType;
void MAX_NEIGHBORS;
