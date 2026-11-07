/**
 * Shaped reward: delta tile share + small delta troop-share / gold terms +
 * an elimination bonus + a terminal win/loss. Coefficients come from
 * `reset` so Python can anneal them.
 */
import type { Game, Player } from "@openfront/engine/game/Game";

export interface RewardCoefs {
  /** per unit of change in (my tiles / land tiles) */
  tile: number;
  /** per unit of change in (my troops / total troops of living players) */
  troops: number;
  /** per unit of change in log1p(gold) / 20 */
  gold: number;
  /** per other player eliminated since the last step */
  elim: number;
  /** terminal reward on win / on loss (agent eliminated or someone else won) */
  win: number;
  loss: number;
}

export const DEFAULT_REWARD: RewardCoefs = {
  tile: 10,
  troops: 0.5,
  gold: 0.1,
  elim: 0.2,
  win: 1,
  loss: -1,
};

export interface RewardSnapshot {
  tileShare: number;
  troopShare: number;
  goldTerm: number;
  aliveOthers: number;
}

export function snapshot(game: Game, me: Player): RewardSnapshot {
  let totalTroops = 0;
  let aliveOthers = 0;
  for (const p of game.players()) {
    if (!p.isAlive()) continue;
    totalTroops += p.troops();
    if (p !== me) aliveOthers++;
  }
  return {
    tileShare: me.numTilesOwned() / Math.max(1, game.map().numLandTiles()),
    troopShare: totalTroops > 0 ? me.troops() / totalTroops : 0,
    goldTerm: Math.log1p(Number(me.gold())) / 20,
    aliveOthers,
  };
}

export function shapedReward(
  prev: RewardSnapshot,
  cur: RewardSnapshot,
  c: RewardCoefs,
): number {
  return (
    c.tile * (cur.tileShare - prev.tileShare) +
    c.troops * (cur.troopShare - prev.troopShare) +
    c.gold * (cur.goldTerm - prev.goldTerm) +
    c.elim * Math.max(0, prev.aliveOthers - cur.aliveOthers)
  );
}
