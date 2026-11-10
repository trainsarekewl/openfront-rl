/**
 * Action masks (DRAFT). Mirrors the validity checks in actions.ts `decodeAction`.
 *
 * Masks are hierarchical, matching the factorized action (type -> target -> param):
 *
 *   type[7]              ActionType is possible at all (derived: any target valid)
 *   attackTarget[9]      neighbor slots 0..7, slot 8 = unowned land
 *   boatCell[1024]       grid cells with a plausible landing shore tile
 *   buildType[7]         BUILD_TYPES index is affordable and the unit count allows it
 *   buildCell[7*1024]    [unit][cell] -> a tile in the cell passes canBuild
 *   allyRequest[8], allyReject[8], breakAlly[8]   neighbor slots
 *   param[4]             troop buckets (all valid when the bucket yields >= 1 troop)
 *
 * Policy-side sampling order for Build: type -> unit (buildType) -> cell
 * (buildCell[unit]). The head must therefore sample `param` BEFORE `target`
 * for Build; for Attack/Boat, param is independent of target.
 *
 * Boat is an over-approximation: the pre-filter (ShoreIndex + water components)
 * is necessary but not sufficient; `decodeAction` runs the real `canBuild`
 * (~3 ms) and falls back to a noop. Calling `canBuild` for every cell here
 * would cost seconds per step (see API_NOTES.md "Action validity").
 */
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type { TileRef } from "@openfront/engine-api/game/GameMap";
import type { Game, Player } from "@openfront/engine/game/Game";
import {
  ActionType,
  boatCandidates,
  BUILD_TYPES,
  GRID,
  MAX_NEIGHBORS,
  NUM_ACTION_TYPES,
  ShoreIndex,
  TARGET_UNOWNED,
  TROOP_BUCKETS,
} from "./actions";

const CELLS = GRID * GRID;

/** Existence-only variant of findTileInCell: stops at the first tile that passes. */
function cellHasTile(game: Game, cell: number, pred: (t: TileRef) => boolean): boolean {
  const cx = cell % GRID;
  const cy = Math.floor(cell / GRID);
  const x0 = Math.floor((cx * game.width()) / GRID);
  const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * game.width()) / GRID));
  const y0 = Math.floor((cy * game.height()) / GRID);
  const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * game.height()) / GRID));
  const stride = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 6));
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      if (pred(game.ref(x, y))) return true;
    }
  }
  return false;
}
const MAX_TRANSPORTS = 3; // engine limit, see API_NOTES.md

export interface ActionMask {
  type: Uint8Array;
  attackTarget: Uint8Array;
  boatCell: Uint8Array;
  buildType: Uint8Array;
  buildCell: Uint8Array;
  allyRequest: Uint8Array;
  allyReject: Uint8Array;
  breakAlly: Uint8Array;
  param: Uint8Array;
}

export interface MaskContext {
  game: Game;
  me: Player;
  neighbors: readonly Player[];
  shore: ShoreIndex;
  waterComps: Set<number>;
  /**
   * Per-cell canBuild sweeps are the expensive part (~10 ms per unit type).
   * Set false to mark every affordable build cell valid without checking
   * (decodeAction still validates); useful for benchmarking.
   */
  exactBuildCells?: boolean;
}

export function emptyMask(): ActionMask {
  return {
    type: new Uint8Array(NUM_ACTION_TYPES),
    attackTarget: new Uint8Array(MAX_NEIGHBORS + 1),
    boatCell: new Uint8Array(CELLS),
    buildType: new Uint8Array(BUILD_TYPES.length),
    buildCell: new Uint8Array(BUILD_TYPES.length * CELLS),
    allyRequest: new Uint8Array(MAX_NEIGHBORS),
    allyReject: new Uint8Array(MAX_NEIGHBORS),
    breakAlly: new Uint8Array(MAX_NEIGHBORS),
    param: new Uint8Array(TROOP_BUCKETS.length),
  };
}

/** True if any border tile of `me` touches unowned land. */
function bordersUnownedLand(game: Game, me: Player): boolean {
  const map = game.map();
  const scratch: TileRef[] = [0, 0, 0, 0];
  for (const t of me.borderTiles()) {
    const n = map.neighbors4(t, scratch);
    for (let k = 0; k < n; k++) {
      const q = scratch[k];
      if (map.isLand(q) && !game.hasOwner(q)) return true;
    }
  }
  return false;
}

/** Fills `out` (reused between calls; copy or serialize before the next build). */
export function buildMask(ctx: MaskContext, out: ActionMask): ActionMask {
  const { game, me, neighbors, shore, waterComps } = ctx;
  for (const a of Object.values(out)) (a as Uint8Array).fill(0);

  const troops = me.troops();

  // Troop buckets: param is valid iff it yields at least one troop.
  let anyParam = false;
  TROOP_BUCKETS.forEach((b, i) => {
    if (Math.floor(troops * b) > 0) {
      out.param[i] = 1;
      anyParam = true;
    }
  });

  // Attack: any non-allied living neighbor, plus unowned land if we border it.
  if (anyParam) {
    neighbors.forEach((n, k) => {
      if (n.isAlive() && !me.isAlliedWith(n)) out.attackTarget[k] = 1;
    });
    if (bordersUnownedLand(game, me)) out.attackTarget[TARGET_UNOWNED] = 1;
  }

  // Boat: pre-filter only (see header).
  if (anyParam && me.unitCount(UnitType.TransportShip) < MAX_TRANSPORTS) {
    for (let c = 0; c < CELLS; c++) {
      if (boatCandidates(game, me, shore, waterComps, c).length > 0) {
        out.boatCell[c] = 1;
      }
    }
  }

  // Build: affordability first (cheap), then per-cell canBuild for those types.
  const gold = me.gold();
  const costs = new Map<UnitType, bigint>();
  for (const b of me.buildableUnits(null)) costs.set(b.type, BigInt(b.cost));
  BUILD_TYPES.forEach((unit, u) => {
    const cost = costs.get(unit as never);
    if (cost === undefined || BigInt(gold) < cost) return;
    const map = game.map();
    const base = u * CELLS;
    let any = false;
    for (let c = 0; c < CELLS; c++) {
      const ok =
        ctx.exactBuildCells === false ||
        cellHasTile(
          game,
          c,
          (t) =>
            unit === UnitType.Warship
              ? map.isWater(t) && me.canBuild(unit, t) !== false
              : map.isLand(t) &&
                game.owner(t) === me && // land structures need own territory
                me.canBuild(unit, t) !== false,
        );
      if (ok) {
        out.buildCell[base + c] = 1;
        any = true;
      }
    }
    if (any) out.buildType[u] = 1;
  });

  // Diplomacy, per neighbor slot.
  const incoming = me.incomingAllianceRequests();
  neighbors.forEach((n, k) => {
    if (me.canSendAllianceRequest(n)) out.allyRequest[k] = 1;
    if (incoming.some((r) => r.requestor() === n)) {
      out.allyReject[k] = 1;
      out.allyRequest[k] = 1; // accepting a pending request, per actions.ts
    }
    if (me.isAlliedWith(n)) out.breakAlly[k] = 1;
  });

  // Type mask is derived: a type is possible iff some target is valid.
  const any = (a: Uint8Array) => a.some((v) => v !== 0);
  out.type[ActionType.Noop] = 1; // always legal, keeps the mask non-empty
  out.type[ActionType.Attack] = any(out.attackTarget) ? 1 : 0;
  out.type[ActionType.Boat] = any(out.boatCell) ? 1 : 0;
  out.type[ActionType.Build] = any(out.buildType) ? 1 : 0;
  out.type[ActionType.AllianceRequest] = any(out.allyRequest) ? 1 : 0;
  out.type[ActionType.AllianceReject] = any(out.allyReject) ? 1 : 0;
  out.type[ActionType.BreakAlliance] = any(out.breakAlly) ? 1 : 0;
  return out;
}

/**
 * Uniformly samples a valid action: type, then (for Build) unit, then target,
 * then troop bucket. Used by tests and the stdio smoke client.
 */
export function sampleMaskedAction(
  m: ActionMask,
  rnd: () => number,
): { type: ActionType; target: number; param: number } {
  const pick = (a: Uint8Array, off = 0, len = a.length - off): number => {
    let n = 0;
    for (let i = 0; i < len; i++) if (a[off + i]) n++;
    if (n === 0) return 0;
    let r = Math.floor(rnd() * n);
    for (let i = 0; i < len; i++) {
      if (a[off + i] && r-- === 0) return i;
    }
    return 0;
  };
  const type = pick(m.type) as ActionType;
  const param = pick(m.param);
  switch (type) {
    case ActionType.Attack:
      return { type, target: pick(m.attackTarget), param };
    case ActionType.Boat:
      return { type, target: pick(m.boatCell), param };
    case ActionType.Build: {
      const unit = pick(m.buildType);
      return { type, target: pick(m.buildCell, unit * CELLS, CELLS), param: unit };
    }
    case ActionType.AllianceRequest:
      return { type, target: pick(m.allyRequest), param: 0 };
    case ActionType.AllianceReject:
      return { type, target: pick(m.allyReject), param: 0 };
    case ActionType.BreakAlliance:
      return { type, target: pick(m.breakAlly), param: 0 };
    default:
      return { type: ActionType.Noop, target: 0, param: 0 };
  }
}
