// A kitty steering along the level path (invulnerable) reaches the goal and clears the level.
import { createSim, stepSim } from '../public/js/shared/sim.js';
import { CFG } from '../public/js/shared/config.js';
const sim = createSim({ seed: 31337, players: [{ id: 1, name: 'bot', color: 0 }] });
const path = sim.levelData.path;
let k = 0, cleared = -1;
for (let t = 0; t < 60 * 400 && cleared < 0; t++) {
  const p = sim.players[0];
  p.invuln = 1;
  while (k < path.length - 1 && Math.hypot(path[k].x - p.x, path[k].z - p.z) < 1.5) k++;
  const dx = path[k].x - p.x, dz = path[k].z - p.z, d = Math.hypot(dx, dz) || 1;
  const ev = stepSim(sim, { 1: { x: dx / d, z: dz / d } }, CFG.TICK);
  if (ev.some((e) => e.type === 'levelClear')) cleared = t;
}
const ok = cleared > 0;
console.log(ok ? `PASS level cleared after ${(cleared / 60).toFixed(1)}s of running` : `FAIL stuck at path point ${k}/${path.length}`);
process.exitCode = ok ? 0 : 1;
