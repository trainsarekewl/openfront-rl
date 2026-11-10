/**
 * Observation builder.
 *
 *   spatial: Uint8Array  C x 128 x 128, channel-first
 *   scalars: Float32Array  SCALAR_DIM
 *
 * The spatial grid is a *sample*, not an average: each output cell reads the
 * tile at the center of its block of the map. That keeps the per-step cost at
 * 16k lookups regardless of map size (a full-map scan is 1-4M tiles). Thin
 * features (single-tile borders) can alias; structures are painted from the
 * unit list instead of sampled, so they never vanish.
 *
 * Channels
 *   0 land            255 on land (static)
 *   1 shore           255 on land tiles touching water (static)
 *   2 self            255 where the agent owns the sampled tile
 *   3 ally            255 where an ally owns it
 *   4 enemy           255 where any other player owns it (tribes included)
 *   5 troop density   owner's troops per tile, relative to the densest player
 *   6 own structures  255 where one of the agent's structures sits in the cell
 *   7 other structs   same, for other players' structures
 *   8 neighbor slot  28 * (slot + 1) on tiles owned by neighbor `slot`, so the
 *                     policy can tie an attack/alliance slot to a blob on the map
 *   9 my attacks      255 where the front of one of the agent's attacks is
 *  10 incoming attacks 255 where the front of an attack on the agent is
 *  11 own mobile      255 where one of the agent's ships / nukes is
 *  12 other mobile    255 for other players' ships / nukes
 * (Unowned land = land and none of 2, 3, 4.)
 *
 * Scalars (see SELF_FEATURES / NEIGHBOR_FEATURES): 17 self features then MAX_NEIGHBORS x 10
 * neighbor features, all roughly in [-1, 1] or [0, 1].
 */
import type { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import type { Game, Player } from "@openfront/engine/game/Game";
import { MAX_NEIGHBORS } from "./actions";

export const OBS_SIZE = 128;
export const NUM_CHANNELS = 13;
export const SPATIAL_LEN = NUM_CHANNELS * OBS_SIZE * OBS_SIZE;

export const SELF_FEATURES = [
  "log_gold",
  "troops_frac_of_max",
  "tile_share",
  "log_tiles",
  "elapsed_frac",
  "boats_frac",
  "n_city",
  "n_port",
  "n_factory",
  "n_defense_post",
  "n_other_structs",
  "n_allies",
  "traitor",
  "incoming_requests",
  "outgoing_attacks",
  "incoming_attacks",
  "attack_troops_frac", // troops committed to my outgoing attacks / max troops
] as const;
export const NEIGHBOR_FEATURES = [
  "present",
  "tile_share",
  "log_troop_ratio", // log2(their troops / mine), clipped to [-4, 4] / 4
  "allied",
  "they_requested_me",
  "i_requested_them",
  "border_frac", // my border tiles touching them / my border tiles
  "their_relation", // THEIR attitude to me, n.relation(me) 0..3 -> 0..1 (drops when I attack them)
  "is_tribe",
  "can_send_request",
] as const;
export const SCALAR_DIM =
  SELF_FEATURES.length + MAX_NEIGHBORS * NEIGHBOR_FEATURES.length;

const CH = {
  land: 0,
  shore: 1,
  self: 2,
  ally: 3,
  enemy: 4,
  density: 5,
  ownStruct: 6,
  otherStruct: 7,
  slot: 8,
  myAttack: 9,
  inAttack: 10,
  ownMobile: 11,
  otherMobile: 12,
} as const;

const MOBILE = [
  UnitType.TransportShip,
  UnitType.Warship,
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
] as const;
const MAX_FRONT_TILES = 2000; // per attack, bounds the cost of huge fronts

const CORE_STRUCTS = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
] as const;
const ALL_STRUCTS = [
  ...CORE_STRUCTS,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
] as const;

export interface Observation {
  spatial: Uint8Array;
  scalars: Float32Array;
}

/** Static per-map data: sample positions and the terrain channels. */
export class ObsStatic {
  readonly sampleRef = new Int32Array(OBS_SIZE * OBS_SIZE);
  readonly land = new Uint8Array(OBS_SIZE * OBS_SIZE);
  readonly shore = new Uint8Array(OBS_SIZE * OBS_SIZE);
  readonly width: number;
  readonly height: number;

  constructor(game: Game) {
    const map = game.map();
    this.width = game.width();
    this.height = game.height();
    for (let j = 0; j < OBS_SIZE; j++) {
      const y = Math.min(
        this.height - 1,
        Math.floor(((j + 0.5) * this.height) / OBS_SIZE),
      );
      for (let i = 0; i < OBS_SIZE; i++) {
        const x = Math.min(
          this.width - 1,
          Math.floor(((i + 0.5) * this.width) / OBS_SIZE),
        );
        const t = game.ref(x, y);
        const k = j * OBS_SIZE + i;
        this.sampleRef[k] = t;
        this.land[k] = map.isLand(t) ? 255 : 0;
        this.shore[k] = map.isLand(t) && map.isShore(t) ? 255 : 0;
      }
    }
  }

  /** Grid cell index (row-major) containing tile `t`. */
  cellOf(game: Game, t: TileRef): number {
    const i = Math.min(
      OBS_SIZE - 1,
      Math.floor((game.map().x(t) * OBS_SIZE) / this.width),
    );
    const j = Math.min(
      OBS_SIZE - 1,
      Math.floor((game.map().y(t) * OBS_SIZE) / this.height),
    );
    return j * OBS_SIZE + i;
  }
}

export class ObsBuilder {
  private spatial = new Uint8Array(SPATIAL_LEN);
  private scalars = new Float32Array(SCALAR_DIM);

  /**
   * Returned arrays are reused between calls; copy (or serialize) them before
   * the next `build`.
   */
  build(
    game: Game,
    me: Player,
    neighbors: readonly Player[],
    st: ObsStatic,
    ctx: { elapsedTicks: number; maxTicks: number },
  ): Observation {
    const map = game.map();
    const plane = OBS_SIZE * OBS_SIZE;
    const sp = this.spatial;
    sp.fill(0);
    sp.set(st.land, CH.land * plane);
    sp.set(st.shore, CH.shore * plane);

    // smallID -> category / slot / density, built once per call.
    const meId = me.smallID();
    const slotOf = new Map<number, number>();
    neighbors.forEach((n, k) => slotOf.set(n.smallID(), k));
    const catCache = new Map<number, number>(); // 0 none, 1 self, 2 ally, 3 enemy
    const densityOf = new Map<number, number>();
    let maxDensity = 1e-9;
    for (const p of game.players()) {
      if (!p.isAlive()) continue;
      const d = p.troops() / Math.max(1, p.numTilesOwned());
      densityOf.set(p.smallID(), d);
      if (d > maxDensity) maxDensity = d;
    }
    const category = (id: number): number => {
      let c = catCache.get(id);
      if (c === undefined) {
        if (id === 0) c = 0;
        else if (id === meId) c = 1;
        else {
          const o = game.playerBySmallID(id);
          c = o.isPlayer() ? (me.isAlliedWith(o) ? 2 : 3) : 0;
        }
        catCache.set(id, c);
      }
      return c;
    };

    for (let k = 0; k < plane; k++) {
      const id = map.ownerID(st.sampleRef[k]);
      if (id === 0) continue;
      const c = category(id);
      if (c === 0) continue;
      sp[(CH.self - 1 + c) * plane + k] = 255; // c: 1 self, 2 ally, 3 enemy
      sp[CH.density * plane + k] = Math.min(
        255,
        Math.round(((densityOf.get(id) ?? 0) / maxDensity) * 255),
      );
      const slot = slotOf.get(id);
      if (slot !== undefined) sp[CH.slot * plane + k] = 28 * (slot + 1);
    }

    // Structures, painted from the unit list.
    for (const u of game.units(ALL_STRUCTS)) {
      const cell = st.cellOf(game, u.tile());
      sp[(u.owner() === me ? CH.ownStruct : CH.otherStruct) * plane + cell] =
        255;
    }

    // Attack fronts and units in transit.
    const paintFront = (ch: number, tiles: ReadonlySet<TileRef>) => {
      let n = 0;
      for (const t of tiles) {
        sp[ch * plane + st.cellOf(game, t)] = 255;
        if (++n >= MAX_FRONT_TILES) break;
      }
    };
    const outAttacks = me.outgoingAttacks();
    let attackTroops = 0;
    for (const a of outAttacks) {
      paintFront(CH.myAttack, a.borderTiles());
      attackTroops += a.troops();
    }
    const inAttacks = me.incomingAttacks();
    for (const a of inAttacks) paintFront(CH.inAttack, a.borderTiles());
    for (const u of game.units(MOBILE)) {
      sp[
        (u.owner() === me ? CH.ownMobile : CH.otherMobile) * plane +
          st.cellOf(game, u.tile())
      ] = 255;
    }

    // Scalars.
    const s = this.scalars;
    s.fill(0);
    const landTiles = Math.max(1, map.numLandTiles());
    const maxTroops = Math.max(1, game.config().maxTroops(me));
    const myTiles = me.numTilesOwned();
    let o = 0;
    s[o++] = Math.log1p(Number(me.gold())) / 20;
    s[o++] = Math.min(2, me.troops() / maxTroops);
    s[o++] = myTiles / landTiles;
    s[o++] = Math.log1p(myTiles) / 15;
    s[o++] = Math.min(1, ctx.elapsedTicks / Math.max(1, ctx.maxTicks));
    s[o++] = me.unitCount(UnitType.TransportShip) / 3;
    for (const t of CORE_STRUCTS) s[o++] = Math.min(1, me.unitCount(t) / 10);
    s[o++] = Math.min(
      1,
      (me.unitCount(UnitType.SAMLauncher) + me.unitCount(UnitType.MissileSilo)) /
        10,
    );
    let allies = 0;
    for (const p of game.players()) {
      if (p !== me && p.isAlive() && me.isAlliedWith(p)) allies++;
    }
    s[o++] = Math.min(1, allies / 4);
    s[o++] = me.isTraitor() ? 1 : 0;
    const incoming = me.incomingAllianceRequests();
    s[o++] = Math.min(1, incoming.length / 4);
    s[o++] = Math.min(1, outAttacks.length / 4);
    s[o++] = Math.min(1, inAttacks.length / 4);
    s[o++] = Math.min(1, attackTroops / maxTroops);

    // Neighbors: border contact per slot, then features.
    const contact = new Array<number>(neighbors.length).fill(0);
    const scratch: TileRef[] = [0, 0, 0, 0];
    let borderTotal = 0;
    for (const t of me.borderTiles()) {
      borderTotal++;
      const n = map.neighbors4(t, scratch);
      const seen = new Set<number>();
      for (let q = 0; q < n; q++) {
        const id = map.ownerID(scratch[q]);
        const slot = slotOf.get(id);
        if (slot !== undefined && !seen.has(slot)) {
          seen.add(slot);
          contact[slot]++;
        }
      }
    }
    const outgoing = me.outgoingAllianceRequests();
    for (let k = 0; k < neighbors.length; k++) {
      const n = neighbors[k];
      s[o++] = 1;
      s[o++] = n.numTilesOwned() / landTiles;
      const ratio = Math.log2((n.troops() + 1) / (me.troops() + 1));
      s[o++] = Math.max(-4, Math.min(4, ratio)) / 4;
      s[o++] = me.isAlliedWith(n) ? 1 : 0;
      s[o++] = incoming.some((r) => r.requestor() === n) ? 1 : 0;
      s[o++] = outgoing.some((r) => r.recipient() === n) ? 1 : 0;
      s[o++] = borderTotal > 0 ? contact[k] / borderTotal : 0;
      s[o++] = n.relation(me) / 3;
      s[o++] = n.type() === PlayerType.Bot ? 1 : 0;
      s[o++] = me.canSendAllianceRequest(n) ? 1 : 0;
    }
    return { spatial: sp, scalars: s };
  }
}
