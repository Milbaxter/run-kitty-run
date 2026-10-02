// Client mirror stays in sync with the server sim across a level change, in every lobby mode, and a
// serialize -> JSON -> applyEnemyState resync reproduces the server's wolves exactly (random wanderers and
// Skate only pattern wolves alike).
import { createSim, stepSim, loadLevel } from '../public/js/shared/sim.js';
import { updateEnemies, serializeEnemies, applyEnemyState } from '../public/js/shared/enemies.js';
import { CFG, SKATE_FINAL_LEVEL } from '../public/js/shared/config.js';
import { generateLevel } from '../public/js/shared/maze.js';

const players = [{ id: 1, name: 'a', color: 1 }];
const maxDiff = (a, b) => {
  let d = a.length === b.length ? 0 : Infinity;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d = Math.max(d, Math.hypot(a[i].x - b[i].x, a[i].z - b[i].z), Math.abs(a[i].heading - b[i].heading));
  return d;
};

function run(mode) {
  const server = createSim({ seed: 777, players, mode });
  let k = 0;
  for (; k < 300; k++) stepSim(server, {}, CFG.TICK);
  server.players[0].x = 0; server.players[0].z = 0; // teleport into the goal
  let lvlK = -1;
  for (; k < 900; k++) { const ev = stepSim(server, {}, CFG.TICK); if (ev.some((e) => e.type === 'levelStart')) lvlK = k + 1; }
  // client hears about it from a snapshot at server tick k (enemyTicks = lt)
  const client = createSim({ seed: 777, players, mode });
  loadLevel(client, server.level);
  const levelStartTick = k - server.enemyTicks;
  for (let t = levelStartTick; t < k; t++) { updateEnemies(client.enemies, client.levelData, CFG.TICK); client.enemyTicks++; }
  const dMirror = maxDiff(server.enemies, client.enemies);
  const items = server.items.length === client.items.length && server.items.every((it, i) => it.x === client.items[i].x);

  // resync: a fresh mirror (wolves at level start) takes the server's full wolf state over the wire
  const fresh = createSim({ seed: 777, players, mode });
  loadLevel(fresh, server.level);
  applyEnemyState(fresh.enemies, JSON.parse(JSON.stringify(serializeEnemies(server.enemies))));
  const dApply = maxDiff(server.enemies, fresh.enemies);
  for (let i = 0; i < 600; i++) {
    updateEnemies(server.enemies, server.levelData, CFG.TICK);
    updateEnemies(fresh.enemies, fresh.levelData, CFG.TICK);
  }
  const dAfter = maxDiff(server.enemies, fresh.enemies);
  const patterns = server.enemies.filter((e) => e.pattern).length;

  const pass = server.level === 2 && dMirror === 0 && items && dApply === 0 && dAfter === 0 && (mode !== 'ice' || patterns > 0);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${mode}: level ${server.level} (started tick ${lvlK}), enemyTicks ${server.enemyTicks}/${client.enemyTicks}, `
    + `mirror diff ${dMirror}, items match ${items}, resync diff ${dApply} / after 10s ${dAfter}, pattern wolves ${patterns}/${server.enemies.length}`);
  return pass;
}

// Skate only final run: the server reaches it by clearing level 7 (nextLevel); a client builds it either from a
// 'start' message (createSim startLevel 8: game start / mid-game join) or from a snapshot's level change
// (loadLevel). All three must produce the identical level and identical wolves, and it must be deterministic.
function finale(seed) {
  const F = SKATE_FINAL_LEVEL;
  const server = createSim({ seed, players, mode: 'ice', startLevel: F - 1 });
  stepSim(server, {}, CFG.TICK);
  server.players[0].x = 0; server.players[0].z = 0;
  let k = 0;
  for (; k < 600 && server.level < F; k++) stepSim(server, {}, CFG.TICK);
  for (let i = 0; i < 300; i++) stepSim(server, {}, CFG.TICK);   // the final run is under way
  const viaStart = createSim({ seed, players, mode: 'ice', startLevel: F });
  const viaSnap = createSim({ seed, players, mode: 'ice' });
  loadLevel(viaSnap, F);
  const J = (ld) => JSON.stringify(ld);
  const same = J(server.levelData) === J(viaStart.levelData) && J(server.levelData) === J(viaSnap.levelData)
    && J(generateLevel(F, server.levelData.seed, 'ice')) === J(server.levelData);
  const ld = server.levelData;
  const shape = ld.finale === true && ld.runLength > 800 && ld.checkpoints.length === 0 && ld.trees.length === 1
    && ld.safeCorners.length === 1 && server.enemies.length > 100 && server.enemies.every((e) => e.pattern);
  // mirrors step their wolves as many ticks as the server did since the level started
  for (const c of [viaStart, viaSnap]) for (let t = 0; t < server.enemyTicks; t++) { updateEnemies(c.enemies, c.levelData, CFG.TICK); c.enemyTicks++; }
  const d1 = maxDiff(server.enemies, viaStart.enemies), d2 = maxDiff(server.enemies, viaSnap.enemies);
  // other modes keep the spiral on level 8; a different seed gives a different final run
  const spiral = ['mixed', 'run'].every((m) => !generateLevel(F, ld.seed, m).finale);
  const other = J(createSim({ seed: seed + 1, players, mode: 'ice', startLevel: F }).levelData.enemies) !== J(ld.enemies);   // wolves differ (the corridor itself may not)
  const pass = server.level === F && same && shape && d1 === 0 && d2 === 0 && spiral && other;
  console.log(`${pass ? 'PASS' : 'FAIL'} ice final run (seed ${seed}): level ${server.level}, identical level data server/start/snapshot/regenerated ${same}, `
    + `run ${ld.runLength} units, ${server.enemies.length} pattern wolves, trees ${ld.trees.length}, checkpoints ${ld.checkpoints.length}, `
    + `wolf diff after ${server.enemyTicks} ticks ${d1}/${d2}, spiral in mixed/run ${spiral}, seed-dependent wolves ${other}`);
  return pass;
}

let ok = true;
for (const mode of ['mixed', 'run', 'ice']) ok = run(mode) && ok;
for (const seed of [777, 4242]) ok = finale(seed) && ok;
process.exitCode = ok ? 0 : 1;
