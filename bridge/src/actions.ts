/**
 * Factorized action space and its conversion to engine intents.
 *
 * action = { type, target, param }
 *   Noop            -
 *   Attack          target: neighbor slot 0..K-1, or K = unowned land.  param: troop bucket
 *   Boat            target: coarse grid cell (GRID x GRID).             param: troop bucket
 *   Build           target: coarse grid cell.                           param: BUILD_TYPES index
 *   AllianceRequest target: neighbor slot (also accepts a pending request from that player)
 *   AllianceReject  target: neighbor slot (rejects that player's pending request)
 *   BreakAlliance   target: neighbor slot
 *
 * The engine has no troop-ratio intent, so troop buckets become an absolute
 * count: floor(bucket * player.troops()).
 */
import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type { StampedIntent } from "@openfront/engine-api/Schemas";
import type { Game, Player } from "@openfront/engine/game/Game";

export enum ActionType {
  Noop = 0,
  Attack = 1,
  Boat = 2,
  Build = 3,
  AllianceRequest = 4,
  AllianceReject = 5,
  BreakAlliance = 6,
}
export const NUM_ACTION_TYPES = 7;
export const MAX_NEIGHBORS = 8;
/** Attack target index meaning "unowned land" (targetID = null). */
export const TARGET_UNOWNED = MAX_NEIGHBORS;
export const GRID = 32;
export const TROOP_BUCKETS = [0.1, 0.25, 0.5, 0.75] as const;
export const BUILD_TYPES = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
  UnitType.Warship,
] as const;

export interface Action {
  type: ActionType;
  target: number;
  param: number;
}

/**
 * Static per-map index of shore land tiles by grid cell (a few evenly spaced
 * samples each). Boat validity through the engine (`canBuild(TransportShip)`)
 * costs about 3 ms per tile, so masks pre-filter with this index and only call
 * the engine on a handful of candidates.
 */
export class ShoreIndex {
  readonly cells: TileRef[][];
  static readonly SAMPLES = 6;

  constructor(game: Game) {
    const map = game.map();
    const w = game.width();
    const h = game.height();
    const all: TileRef[][] = Array.from({ length: GRID * GRID }, () => []);
    for (let y = 0; y < h; y++) {
      const cy = Math.min(GRID - 1, Math.floor((y * GRID) / h));
      for (let x = 0; x < w; x++) {
        const t = game.ref(x, y);
        if (!map.isLand(t) || !map.isShore(t)) continue;
        all[Math.min(GRID - 1, Math.floor((x * GRID) / w)) + cy * GRID].push(t);
      }
    }
    this.cells = all.map((tiles) => {
      if (tiles.length <= ShoreIndex.SAMPLES) return tiles;
      const step = tiles.length / ShoreIndex.SAMPLES;
      return Array.from(
        { length: ShoreIndex.SAMPLES },
        (_, i) => tiles[Math.floor(i * step)],
      );
    });
  }
}

/** Water components touching the player's own shoreline. */
export function reachableWaterComponents(game: Game, me: Player): Set<number> {
  const map = game.map();
  const out = new Set<number>();
  for (const t of me.borderTiles()) {
    if (!map.isShore(t)) continue;
    const c = game.getWaterComponent(t);
    if (c !== null) out.add(c);
  }
  return out;
}

/**
 * Sample shore tiles of a cell that a transport ship could plausibly land on:
 * not mine, on a water component my shoreline touches. A necessary condition
 * only; `canBuild(TransportShip, t)` is the final check.
 */
export function boatCandidates(
  game: Game,
  me: Player,
  shore: ShoreIndex,
  comps: Set<number>,
  cell: number,
): TileRef[] {
  if (comps.size === 0) return [];
  return shore.cells[cell].filter((t) => {
    if (game.owner(t) === me) return false;
    const c = game.getWaterComponent(t);
    return c !== null && comps.has(c);
  });
}

export interface DecodeContext {
  game: Game;
  me: Player;
  clientID: string;
  /** Neighbor slots, in the same order the observation reported them. */
  neighbors: readonly Player[];
  shore: ShoreIndex;
  /** water components touching my shoreline (recompute per step) */
  waterComps: Set<number>;
}

/** The tile nearest the center of grid cell (cx, cy) that satisfies pred. */
export function findTileInCell(
  game: Game,
  cell: number,
  pred: (t: TileRef) => boolean,
): TileRef | null {
  const cx = cell % GRID;
  const cy = Math.floor(cell / GRID);
  const x0 = Math.floor((cx * game.width()) / GRID);
  const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * game.width()) / GRID));
  const y0 = Math.floor((cy * game.height()) / GRID);
  const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * game.height()) / GRID));
  const mx = (x0 + x1 - 1) / 2;
  const my = (y0 + y1 - 1) / 2;
  const stride = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 6));
  let best: TileRef | null = null;
  let bestD = Infinity;
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d >= bestD) continue;
      const t = game.ref(x, y);
      if (pred(t)) {
        best = t;
        bestD = d;
      }
    }
  }
  return best;
}

/** Converts an action to an intent, or null if it is a noop or invalid. */
export function decodeAction(
  a: Action,
  ctx: DecodeContext,
): StampedIntent | null {
  const { game, me, clientID, neighbors } = ctx;
  const troopsFor = () =>
    Math.floor(me.troops() * TROOP_BUCKETS[a.param % TROOP_BUCKETS.length]);
  const slot = (): Player | null => neighbors[a.target] ?? null;

  switch (a.type) {
    case ActionType.Noop:
      return null;
    case ActionType.Attack: {
      const troops = troopsFor();
      if (troops <= 0) return null;
      if (a.target === TARGET_UNOWNED) {
        return { type: "attack", targetID: null, troops, clientID };
      }
      const t = slot();
      if (t === null || !t.isAlive() || me.isAlliedWith(t)) return null;
      return { type: "attack", targetID: t.id(), troops, clientID };
    }
    case ActionType.Boat: {
      const troops = troopsFor();
      if (troops <= 0) return null;
      const dst = boatCandidates(
        game,
        me,
        ctx.shore,
        ctx.waterComps,
        a.target,
      ).find((t) => me.canBuild(UnitType.TransportShip, t) !== false);
      return dst === undefined ? null : { type: "boat", dst, troops, clientID };
    }
    case ActionType.Build: {
      const unit = BUILD_TYPES[a.param % BUILD_TYPES.length];
      const map = game.map();
      const tile = findTileInCell(
        game,
        a.target,
        (t) =>
          (unit === UnitType.Warship ? map.isWater(t) : map.isLand(t)) &&
          me.canBuild(unit, t) !== false,
      );
      return tile === null ? null : { type: "build_unit", unit, tile, clientID };
    }
    case ActionType.AllianceRequest: {
      const t = slot();
      return t !== null && me.canSendAllianceRequest(t)
        ? { type: "allianceRequest", recipient: t.id(), clientID }
        : null;
    }
    case ActionType.AllianceReject: {
      const t = slot();
      // The engine warns (and does nothing) without a pending request.
      return t !== null &&
        me.incomingAllianceRequests().some((r) => r.requestor() === t)
        ? { type: "allianceReject", requestor: t.id(), clientID }
        : null;
    }
    case ActionType.BreakAlliance: {
      const t = slot();
      return t !== null && me.isAlliedWith(t)
        ? { type: "breakAlliance", recipient: t.id(), clientID }
        : null;
    }
    default:
      return null;
  }
}
