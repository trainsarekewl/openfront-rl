/**
 * One OpenFront environment: owns a headless game with a single PlayerType.Human
 * agent. Transport-agnostic; main.ts (stdio) and the tests drive it.
 *
 *   const env = new OpenFrontEnv();
 *   await env.reset({ map: "alps", bots: 10, seed: 1 });
 *   const r = env.step({ type: ActionType.Attack, target: TARGET_UNOWNED, param: 1 });
 *
 * Observations (obs.ts) and action masks (mask.ts) are layered on top of
 * `neighbors`, which both must use so action slots match what the policy saw.
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
import type {
  GameConfig,
  GameStartInfo,
  StampedIntent,
} from "@openfront/engine-api/Schemas";
import { loadTerrainMap } from "@openfront/engine-lib/game/TerrainMapLoader";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import type { Game, Player } from "@openfront/engine/game/Game";
import { createGame } from "@openfront/engine/game/GameImpl";
import { createNationsForGame } from "@openfront/engine/game/NationCreation";
import { GameRunner } from "@openfront/engine/GameRunner";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import path from "path";
import { fileURLToPath } from "url";
import { NodeGameMapLoader } from "../../openfront/tests/perf/fullgame/NodeGameMapLoader";
import {
  Action,
  decodeAction,
  MAX_NEIGHBORS,
  reachableWaterComponents,
  ShoreIndex,
} from "./actions";
import {
  DEFAULT_REWARD,
  RewardCoefs,
  RewardSnapshot,
  shapedReward,
  snapshot,
} from "./reward";

const OPENFRONT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../openfront",
);
// Both must match /^[A-Za-z0-9]{8,10}$/ (they travel as MappedID in intents).
const AGENT_CLIENT_ID = "agent001";
const AGENT_PLAYER_ID = "agentpl1";
const MAX_SPAWN_TURNS = 1000;
const SPAWN_RETRY_EVERY = 5;

export interface ResetConfig {
  /** GameMapType key, case-insensitive: "alps", "world", ... */
  map: string;
  bots: number;
  nations?: "disabled" | "default" | number;
  difficulty?: Difficulty;
  seed: number;
  /** ticks per agent decision (1 tick = 100 ms of game time) */
  interval?: number;
  /** truncate the episode after this many game ticks (excluding spawn phase) */
  maxTicks?: number;
  reward?: Partial<RewardCoefs>;
}

export interface StepResult {
  reward: number;
  terminated: boolean;
  truncated: boolean;
  info: StepInfo;
}

export interface StepInfo {
  tick: number;
  /** false if the action decoded to nothing (noop or invalid target) */
  actionApplied: boolean;
  outcome: "running" | "win" | "loss" | "timeout";
  tileShare: number;
  agentAlive: boolean;
  playersAlive: number;
  /** number of living players the agent is currently allied with */
  alliesCount: number;
  /** true while the agent is marked a traitor (broke an alliance recently) */
  traitor: boolean;
  /** engine state hash at the last tick of this step (determinism checks) */
  hash: string | null;
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

export function resolveMap(name: string): GameMapType {
  const key = Object.keys(GameMapType).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  if (key === undefined) throw new Error(`unknown map "${name}"`);
  return GameMapType[key as keyof typeof GameMapType];
}

export class OpenFrontEnv {
  private mapLoader = new NodeGameMapLoader(
    path.join(OPENFRONT, "resources/maps"),
  );
  private runner: GameRunner | null = null;
  private _game: Game | null = null;
  private fatalError: string | undefined;
  private lastHash: HashUpdate | undefined;
  private turnNumber = 0;
  private interval = 10;
  private maxTicks = 20000;
  private startTick = 0;
  private coefs: RewardCoefs = DEFAULT_REWARD;
  private prev!: RewardSnapshot;
  private done = false;
  private _neighbors: Player[] = [];
  private scratch: TileRef[] = [0, 0, 0, 0];
  private shoreCache = new Map<string, ShoreIndex>();
  private _shore!: ShoreIndex;
  private _waterComps = new Set<number>();

  get game(): Game {
    if (!this._game) throw new Error("call reset() first");
    return this._game;
  }

  get agent(): Player {
    return this.game.playerByClientID(AGENT_CLIENT_ID)!;
  }

  get clientID(): string {
    return AGENT_CLIENT_ID;
  }

  /** Static shore-tile index for the current map (cached across resets). */
  get shore(): ShoreIndex {
    return this._shore;
  }

  /** Water components touching the agent's shoreline, as of the last step. */
  get waterComps(): Set<number> {
    return this._waterComps;
  }

  /** Neighbor slots as of the end of the last reset/step (top-K by size). */
  get neighbors(): readonly Player[] {
    return this._neighbors;
  }

  async reset(cfg: ResetConfig): Promise<StepInfo> {
    console.debug = () => {};
    this.interval = cfg.interval ?? 10;
    this.maxTicks = cfg.maxTicks ?? 20000;
    this.coefs = { ...DEFAULT_REWARD, ...cfg.reward };
    this.fatalError = undefined;
    this.lastHash = undefined;
    this.turnNumber = 0;
    this.done = false;

    const gameConfig: GameConfig = {
      gameMap: resolveMap(cfg.map),
      gameMapSize: GameMapSize.Normal,
      gameMode: GameMode.FFA,
      // Public keeps SpawnTimerExecution, which ends the spawn phase.
      gameType: GameType.Public,
      difficulty: cfg.difficulty ?? Difficulty.Medium,
      nations: cfg.nations ?? "disabled",
      donateGold: false,
      donateTroops: false,
      bots: cfg.bots,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    };
    const gameStart: GameStartInfo = {
      gameID: (cfg.seed >>> 0).toString(36).padStart(8, "0"),
      lobbyCreatedAt: 0,
      config: gameConfig,
      players: [],
    };
    const terrain = await loadTerrainMap(
      await loadMapFiles(
        this.mapLoader,
        gameConfig.gameMap,
        gameConfig.gameMapSize,
      ),
    );
    const humans = [
      new PlayerInfo(
        "agent",
        PlayerType.Human,
        AGENT_CLIENT_ID,
        AGENT_PLAYER_ID,
      ),
    ];
    const nations = createNationsForGame(
      gameStart,
      terrain.nations,
      terrain.additionalNations,
      humans.length,
      new PseudoRandom(cfg.seed),
    );
    const game = createGame(
      humans,
      nations,
      terrain.gameMap,
      terrain.miniGameMap,
      new EngineConfig(gameConfig, false),
      terrain.teamGameSpawnAreas,
    );
    this._game = game;
    this.runner = new GameRunner(
      game,
      new Executor(game, gameStart.gameID, AGENT_CLIENT_ID),
      (gu) => {
        if ("errMsg" in gu) {
          this.fatalError = `${gu.errMsg}\n${gu.stack ?? ""}`;
          return;
        }
        const h = gu.updates[GameUpdateType.Hash] as HashUpdate[];
        if (h.length > 0) this.lastHash = h[h.length - 1];
      },
    );
    this.runner.init();

    // Spawn phase: retry a random free land tile until the spawn sticks
    // (a tribe may take the tile first).
    const rng = mulberry32(cfg.seed);
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
      if (this.turnNumber >= MAX_SPAWN_TURNS) {
        throw new Error("spawn phase never ended");
      }
      const needSpawn =
        this.turnNumber % SPAWN_RETRY_EVERY === 0 && !this.agent.hasSpawned();
      this.tick(
        needSpawn
          ? [
              {
                type: "spawn",
                tile: randomLandTile(),
                clientID: AGENT_CLIENT_ID,
              },
            ]
          : [],
      );
    }
    if (!this.agent.hasSpawned()) throw new Error("agent failed to spawn");

    this.startTick = game.ticks();
    let shore = this.shoreCache.get(cfg.map.toLowerCase());
    if (!shore) {
      shore = new ShoreIndex(game);
      this.shoreCache.set(cfg.map.toLowerCase(), shore);
    }
    this._shore = shore;
    this.refreshNeighbors();
    this.prev = snapshot(game, this.agent);
    return this.info("running", false);
  }

  step(action: Action): StepResult {
    if (this.done) throw new Error("episode finished; call reset()");
    const game = this.game;
    const me = this.agent;

    const intent = decodeAction(action, {
      game,
      me,
      clientID: AGENT_CLIENT_ID,
      neighbors: this._neighbors,
      shore: this._shore,
      waterComps: this._waterComps,
    });
    for (let k = 0; k < this.interval; k++) {
      this.tick(k === 0 && intent !== null ? [intent] : []);
    }

    let outcome: StepInfo["outcome"] = "running";
    let terminal = 0;
    const winner = game.getWinner();
    if (!me.isAlive()) {
      outcome = "loss";
      terminal = this.coefs.loss;
    } else if (winner !== null) {
      outcome = winner === me ? "win" : "loss";
      terminal = winner === me ? this.coefs.win : this.coefs.loss;
    } else if (game.ticks() - this.startTick >= this.maxTicks) {
      outcome = "timeout";
    }

    const cur = snapshot(game, me);
    const reward = shapedReward(this.prev, cur, this.coefs) + terminal;
    this.prev = cur;
    this.refreshNeighbors();
    this.done = outcome !== "running";
    return {
      reward,
      terminated: outcome === "win" || outcome === "loss",
      truncated: outcome === "timeout",
      info: this.info(outcome, intent !== null),
    };
  }

  private tick(intents: StampedIntent[]): void {
    this.runner!.addTurn({ turnNumber: this.turnNumber++, intents });
    if (!this.runner!.executeNextTick() || this.fatalError) {
      throw new Error(
        `engine error at tick ${this.game.ticks()}:\n${this.fatalError}`,
      );
    }
  }

  /** Top-K neighbors by territory, ties broken by id (deterministic). */
  private refreshNeighbors(): void {
    const game = this.game;
    const me = this.agent;
    this._waterComps = reachableWaterComponents(game, me);
    const map = game.map();
    const seen = new Set<Player>();
    for (const t of me.borderTiles()) {
      const n = map.neighbors4(t, this.scratch);
      for (let k = 0; k < n; k++) {
        const o = game.owner(this.scratch[k]);
        if (o.isPlayer() && o !== me && o.isAlive()) seen.add(o);
      }
    }
    this._neighbors = [...seen]
      .sort(
        (a, b) =>
          b.numTilesOwned() - a.numTilesOwned() || (a.id() < b.id() ? -1 : 1),
      )
      .slice(0, MAX_NEIGHBORS);
  }

  private info(outcome: StepInfo["outcome"], applied: boolean): StepInfo {
    const game = this.game;
    return {
      tick: game.ticks(),
      actionApplied: applied,
      outcome,
      tileShare: this.prev.tileShare,
      agentAlive: this.agent.isAlive(),
      playersAlive: game.players().filter((p) => p.isAlive()).length,
      alliesCount: game
        .players()
        .filter((p) => p !== this.agent && p.isAlive() && this.agent.isAlliedWith(p))
        .length,
      traitor: this.agent.isTraitor(),
      hash: this.lastHash ? String(this.lastHash.hash) : null,
    };
  }
}
