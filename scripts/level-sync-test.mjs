// Client mirror stays in sync with the server sim across a level change.
import { createSim, stepSim, loadLevel } from '../public/js/shared/sim.js';
import { updateEnemies } from '../public/js/shared/enemies.js';
import { CFG } from '../public/js/shared/config.js';
const players = [{ id: 1, name: 'a', color: 1 }];
const server = createSim({ seed: 777, players });
let k = 0;
for (; k < 300; k++) stepSim(server, {}, CFG.TICK);
server.players[0].x = 0; server.players[0].z = 0; // teleport into the goal
let lvlK = -1;
for (; k < 900; k++) { const ev = stepSim(server, {}, CFG.TICK); if (ev.some((e) => e.type === 'levelStart')) lvlK = k + 1; }
// client hears about it from a snapshot at server tick k (enemyTicks = lt)
const client = createSim({ seed: 777, players });
loadLevel(client, server.level);
const levelStartTick = k - server.enemyTicks;
for (let t = levelStartTick; t < k; t++) { updateEnemies(client.enemies, client.levelData, CFG.TICK); client.enemyTicks++; }
let maxD = 0;
for (let i = 0; i < server.enemies.length; i++) maxD = Math.max(maxD, Math.hypot(server.enemies[i].x - client.enemies[i].x, server.enemies[i].z - client.enemies[i].z));
const items = server.items.length === client.items.length && server.items.every((it, i) => it.x === client.items[i].x);
console.log(`level ${server.level} (started tick ${lvlK}), enemyTicks ${server.enemyTicks}/${client.enemyTicks}, max wolf diff ${maxD}, items match ${items}`);
process.exitCode = server.level === 2 && maxD === 0 && items ? 0 : 1;
