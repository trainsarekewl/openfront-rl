# Engine API notes (Phase 1, step 2)

Upstream commit: `c2d66cdad` (openfront submodule). Paths are relative to `openfront/`.

## Game assembly (copy from `tests/perf/fullgame/FullGamePerf.ts`, ~l.220-260)
FullGamePerf builds the game by hand rather than via `createGameRunner`:
1. `EngineConfig(gameConfig, false)`
2. `NodeGameMapLoader(resources/maps)` -> `loadMapFiles(...)` -> `loadTerrainMap(...)`
3. `createNationsForGame(gameStart, terrain.nations, terrain.additionalNations, humanCount, random)`
4. `createGame(humans, nations, terrain.gameMap, terrain.miniGameMap, config, terrain.teamGameSpawnAreas)`
5. `new GameRunner(game, new Executor(game, gameID, undefined), callback)`; `runner.init()`

**FullGamePerf passes `humans = []` and `players: []`.** For the agent slot, pass
`new PlayerInfo(name, PlayerType.Human, clientID, id)` in the humans array to `createGame`
(this is what `createGameRunner` does from `gameStart.players`). The agent is then
found by `game.playerByClientID(clientID)`.

`gameType: GameType.Public` adds `SpawnTimerExecution`, which ends the spawn phase after
`numSpawnPhaseTurns` (202 turns in the benchmark). `Singleplayer` skips it, so the spawn
phase would then need `game.endSpawnPhase()` (as `tests/util/Setup.ts` does).

## Tick loop
- `runner.addTurn({ turnNumber, intents: StampedIntent[] })` queues one turn.
- `runner.executeNextTick()` consumes one queued turn and runs one tick. It returns false on
  an engine exception (also reported via callback as `{errMsg, stack}`).
- One tick = 100 ms of game time (`config.msPerTick()`).
- The callback receives packed updates every tick. The `GameUpdateType.Hash` update gives the
  state hash, which is what the determinism test should compare.
- The runner builds name-placement data and packed update buffers on every tick even if
  nobody reads them. If the bridge profile shows this cost, it is worth skipping by calling
  `game.executeNextTick()` directly (needs `game.addExecution(...executor.createExecs(turn))`).

## Intents (`packages/engine-api/src/Schemas.ts`, mapped in `ExecutionManager.createExec`)
Every intent is stamped with `clientID`. Unknown clientIDs become a NoOp with a console warning.

| type | fields | RL use |
|---|---|---|
| `spawn` | `tile` | initial spawn (`fromIntent` only works in the spawn phase) |
| `attack` | `targetID: string\|null`, `troops: number\|null` | null target = attack unowned land. **Troop count is absolute, not a ratio** |
| `boat` | `dst` tile, `troops` | transport ship |
| `build_unit` | `unit: UnitType`, `tile` | City, Port, Factory, DefensePost, SAMLauncher, MissileSilo, Warship, nukes |
| `upgrade_structure` | `unit`, `unitId`, `amount?` | |
| `allianceRequest` / `allianceReject` / `allianceExtension` / `breakAlliance` | `recipient` or `requestor` (small id) | |
| `donate_gold` / `donate_troops` | `recipient`, amount | |
| `cancel_attack` / `cancel_boat` | `attackID` / `unitID` | |
| `targetPlayer`, `embargo`, `embargo_all`, `emoji`, `quick_chat`, `move_warship`, `delete_unit` | | skip in v1 |
| `kick_player`, `toggle_pause`, `mark_disconnected`, `update_game_config` | | never send |

Player references (`targetID`, `recipient`, `requestor`) are string `player.id()` values (MappedID, /^[A-Za-z0-9]{8,10}$/), not small IDs. The agent's clientID and id must match that regex too.

## Plan corrections this implies
- There is **no troop-ratio intent**. The plan's `setTroopRatio` becomes a parameter bucket on
  `attack`/`boat`: `troops = bucket * player.troops()`.
- Plan's `allianceAccept` does not exist. Accepting is done by sending `allianceRequest` back to the
  requestor (check `AllianceRequestExecution`); `allianceReject` is the only explicit reject.
  Verify this in step 3.
- Mask building: `runner.playerActions(playerID, x, y)` is per-tile (`canAttack`, buildable units,
  and `interaction.*` for the owner of that tile). Per-player action masks need a call per neighbor
  (use a border tile of that neighbor), so `mask.ts` should call `Player` methods directly
  (`canAttack`, `canSendAllianceRequest`, `isAlliedWith`, `buildableUnits(tile)`) rather than going
  through `GameRunner`.

## State needed for observations (`Player`, `Game` in `packages/engine/src/game/Game.ts`)
- Player: `smallID()`, `clientID()`, `isAlive()`, `gold()`, `troops()`, `numTilesOwned()`, `tiles()`,
  `borderTiles()`, `units(types)`, `outgoingAttacks()`, `sharesBorderWith(other)`, `relation(other)`,
  `isAlliedWith(other)`, `allianceInfo(other)`, `canAttack(tile)`, `canSendAllianceRequest(other)`,
  `buildableUnits(tile, units?)`, `largestClusterBoundingBox`.
- Game: `width()`, `height()`, `map()`, `owner(ref)`, `players()`, `ticks()`, `inSpawnPhase()`.
- `GameMap` (`engine-api/src/game/GameMap.ts`): `isLand/isOcean/isShore`, `ownerID(ref)`,
  `neighbors(ref)`, `x/y/ref`. Tile refs index typed arrays, so the 128x128 downsample can read
  `ownerID` straight from the tile buffer.
- There is no neighbor list API. Neighbors have to be derived by walking `borderTiles()` and
  collecting `owner()` of adjacent tiles (cache per decision).

## Test maps (`tests/testdata/maps/`)
`big_plains`, `giantworldmap`, `half_land_half_ocean`, `ocean_and_land`, `plains`, `world`.
`setup()` in `tests/util/Setup.ts` loads them via `genTerrainFromBin` and uses `TestConfig`,
which is separate from the production map loader. Production maps (`resources/maps/*`, e.g. `alps`,
`achiran`, `aegean`) are loaded through `NodeGameMapLoader`.

## Answers from step 3 (bench.ts)
1. `Executor` takes the agent's clientID (or undefined); both work. Intents from unknown clientIDs become NoOps.
2. The Human spawns via a `spawn` intent issued during the spawn phase (`fromIntent` gate in `SpawnExecution`). The tile can be taken by a tribe's spawn, so retry a new random free land tile every few turns until `hasSpawned()`. Spawn phase is 202 turns.
3. Accepting an alliance = sending `allianceRequest` to a player that already has a pending request to you (`AllianceRequestExecution.init` calls `incoming.accept()`). Confirmed.
4. Tribes (bots) do attack the Human; a random policy is often eliminated. `Player.isAlive()` is false after elimination; `game.getWinner()` is non-null at game end (checked by `WinCheckExecution` every 10 ticks).
5. Measured with bench.ts, alps map, 10 bots, interval 10: 1100-1300 ticks/s, i.e. r of about 110-130 decisions/s/core before real obs/mask cost.
