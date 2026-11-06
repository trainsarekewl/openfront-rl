/**
 * Agent-slot benchmark: a headless game with one PlayerType.Human "agent"
 * that decides every --interval ticks (noop or random attack), plus tribes.
 * Reports decisions/second on one core (r in the project plan).
 *
 *   npm run bench -- [--map alps] [--bots 10] [--nations disabled]
 *                    [--interval 10] [--max-ticks 20000] [--seed bench]
 *                    [--policy random|noop] [--troops 0.25]
 */
import type { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  HashUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import {
  GameConfig,
  GameStartInfo,
  StampedIntent,
} from "@openfront/engine-api/Schemas";
import { loadTerrainMap } from "@openfront/engine-lib/game/TerrainMapLoader";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { Player } from "@openfront/engine/game/Game";
import { createGame } from "@openfront/engine/game/GameImpl";
import { createNationsForGame } from "@openfront/engine/game/NationCreation";
import { GameRunner } from "@openfront/engine/GameRunner";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import path from "path";
import { fileURLToPath } from "url";
import { NodeGameMapLoader } from "../../openfront/tests/perf/fullgame/NodeGameMapLoader";

const OPENFRONT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../openfront",
);
// Both must match /^[A-Za-z0-9]{8,10}$/ (they travel as MappedID in intents).
const AGENT_CLIENT_ID = "agent001";
const AGENT_PLAYER_ID = "agentpl1";
const MAX_SPAWN_TURNS = 1000;

interface Options {
  map: string;
  bots: number;
  nations: "disabled" | "default" | number;
  interval: number;
  maxTicks: number;
  seed: string;
  policy: "random" | "noop";
  troopFrac: number;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    map: "alps",
    bots: 10,
    nations: "disabled",
    interval: 10,
    maxTicks: 20000,
    seed: "benchdef",
    policy: "random",
    troopFrac: 0.25,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = () => argv[++i];
    switch (argv[i]) {
      case "--map":
        o.map = v();
        break;
      case "--bots":
        o.bots = parseInt(v(), 10);
        break;
      case "--nations": {
        const n = v();
        o.nations = n === "disabled" || n === "default" ? n : parseInt(n, 10);
        break;
      }
      case "--interval":
        o.interval = parseInt(v(), 10);
        break;
      case "--max-ticks":
        o.maxTicks = parseInt(v(), 10);
        break;
      case "--seed":
        o.seed = v();
        break;
      case "--policy":
        o.policy = v() as Options["policy"];
        break;
      case "--troops":
        o.troopFrac = parseFloat(v());
        break;
      default:
        throw new Error(`unknown arg ${argv[i]}`);
    }
  }
  return o;
}

function resolveMap(name: string): GameMapType {
  const key = Object.keys(GameMapType).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  if (key === undefined) throw new Error(`unknown map "${name}"`);
  return GameMapType[key as keyof typeof GameMapType];
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.debug = () => {};
  const rng = mulberry32(simpleHash(opts.seed));

  const gameConfig: GameConfig = {
    gameMap: resolveMap(opts.map),
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Public, // Public keeps SpawnTimerExecution (ends spawn phase)
    difficulty: Difficulty.Medium,
    nations: opts.nations,
    donateGold: false,
    donateTroops: false,
    bots: opts.bots,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  };
  const gameStart: GameStartInfo = {
    gameID: opts.seed.padEnd(8, "0").slice(0, 10),
    lobbyCreatedAt: 0,
    config: gameConfig,
    players: [],
  };

  const config = new EngineConfig(gameConfig, false);
  const loader = new NodeGameMapLoader(path.join(OPENFRONT, "resources/maps"));
  const terrain = await loadTerrainMap(
    await loadMapFiles(loader, gameConfig.gameMap, gameConfig.gameMapSize),
  );
  const random = new PseudoRandom(simpleHash(gameStart.gameID));
  const humans = [
    new PlayerInfo("agent", PlayerType.Human, AGENT_CLIENT_ID, AGENT_PLAYER_ID),
  ];
  const nations = createNationsForGame(
    gameStart,
    terrain.nations,
    terrain.additionalNations,
    humans.length,
    random,
  );
  const game = createGame(
    humans,
    nations,
    terrain.gameMap,
    terrain.miniGameMap,
    config,
    terrain.teamGameSpawnAreas,
  );

  let lastHash: HashUpdate | undefined;
  let fatalError: string | undefined;
  const runner = new GameRunner(
    game,
    new Executor(game, gameStart.gameID, AGENT_CLIENT_ID),
    (gu) => {
      if ("errMsg" in gu) {
        fatalError = `${gu.errMsg}\n${gu.stack ?? ""}`;
        return;
      }
      const h = gu.updates[GameUpdateType.Hash] as HashUpdate[];
      if (h.length > 0) lastHash = h[h.length - 1];
    },
  );
  runner.init();

  let turnNumber = 0;
  const tick = (intents: StampedIntent[]): void => {
    runner.addTurn({ turnNumber: turnNumber++, intents });
    if (!runner.executeNextTick() || fatalError) {
      throw new Error(`engine error at tick ${game.ticks()}:\n${fatalError}`);
    }
  };
  const agent = (): Player => game.playerByClientID(AGENT_CLIENT_ID)!;

  // --- Spawn phase: try a random free land tile every 5 turns until spawned.
  const map = game.map();
  const randomLandTile = (): TileRef => {
    for (;;) {
      const t = game.ref(
        Math.floor(rng() * game.width()),
        Math.floor(rng() * game.height()),
      );
      if (map.isLand(t) && !game.hasOwner(t)) return t;
    }
  };
  while (game.inSpawnPhase()) {
    if (turnNumber >= MAX_SPAWN_TURNS) {
      throw new Error("spawn phase never ended");
    }
    const needSpawn = turnNumber % 5 === 0 && !agent()?.hasSpawned();
    tick(
      needSpawn
        ? [{ type: "spawn", tile: randomLandTile(), clientID: AGENT_CLIENT_ID }]
        : [],
    );
  }
  if (!agent()?.hasSpawned()) throw new Error("agent failed to spawn");
  console.log(
    `Spawned; spawn phase took ${turnNumber} turns, ${game.players().length} ` +
      `players, agent has ${agent().numTilesOwned()} tiles`,
  );

  // --- Decision loop
  const scratch: TileRef[] = [0, 0, 0, 0];
  const neighbors = (p: Player): Player[] => {
    const seen = new Set<Player>();
    for (const t of p.borderTiles()) {
      const n = map.neighbors4(t, scratch);
      for (let k = 0; k < n; k++) {
        const o = game.owner(scratch[k]);
        if (o.isPlayer() && o !== p) seen.add(o);
      }
    }
    return [...seen];
  };

  const decide = (): StampedIntent[] => {
    if (opts.policy === "noop") return [];
    const me = agent();
    const nb = neighbors(me); // stand-in for observation cost
    const roll = rng();
    const troops = Math.floor(me.troops() * opts.troopFrac);
    if (roll < 0.2) return [];
    if (nb.length === 0 || roll < 0.6) {
      return [
        { type: "attack", targetID: null, troops, clientID: AGENT_CLIENT_ID },
      ];
    }
    const target = nb[Math.floor(rng() * nb.length)];
    return [
      {
        type: "attack",
        targetID: target.id(),
        troops,
        clientID: AGENT_CLIENT_ID,
      },
    ];
  };

  let decisions = 0;
  let intentsSent = 0;
  let decideMs = 0;
  let ticks = 0;
  let end = "max-ticks";
  const t0 = performance.now();
  while (ticks < opts.maxTicks) {
    const d0 = performance.now();
    const intents = decide();
    decideMs += performance.now() - d0;
    decisions++;
    intentsSent += intents.length;
    for (let k = 0; k < opts.interval && ticks < opts.maxTicks; k++, ticks++) {
      tick(k === 0 ? intents : []);
    }
    if (game.getWinner() !== null) {
      end = "winner";
      break;
    }
    if (!agent().isAlive()) {
      end = "agent-eliminated";
      break;
    }
  }
  const wall = (performance.now() - t0) / 1000;

  const me = agent();
  const alive = game.players().filter((p) => p.isAlive()).length;
  console.log(
    `\n=== bench: ${opts.map}, bots=${opts.bots}, nations=${opts.nations}, ` +
      `interval=${opts.interval}, policy=${opts.policy} ===`,
  );
  console.log(`end reason:       ${end}`);
  console.log(`ticks:            ${ticks} (${(ticks / wall).toFixed(0)} ticks/s)`);
  console.log(`decisions:        ${decisions} (${intentsSent} intents)`);
  console.log(`wall:             ${wall.toFixed(2)}s (decide ${decideMs.toFixed(0)}ms)`);
  console.log(`r = decisions/s:  ${(decisions / wall).toFixed(1)}`);
  console.log(
    `agent:            alive=${me.isAlive()} tiles=${me.numTilesOwned()} troops=${Math.round(me.troops())}`,
  );
  console.log(`players alive:    ${alive}/${game.players().length}`);
  console.log(
    `final hash:       ${lastHash ? `${lastHash.hash} (tick ${lastHash.tick})` : "n/a"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
