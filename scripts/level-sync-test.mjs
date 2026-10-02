// Client mirror stays in sync with the server sim across a level change, in every lobby mode, and a
// serialize -> JSON -> applyEnemyState resync reproduces the server's wolves exactly (random wanderers and
// Skate only pattern wolves alike).
import { createSim, stepSim, loadLevel } from '../public/js/shared/sim.js';
import { updateEnemies, serializeEnemies, applyEnemyState } from '../public/js/shared/enemies.js';
import { CFG } from '../public/js/shared/config.js';

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

let ok = true;
for (const mode of ['mixed', 'run', 'ice']) ok = run(mode) && ok;
process.exitCode = ok ? 0 : 1;
