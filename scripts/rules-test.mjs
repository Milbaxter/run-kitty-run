// Game rules: first kitty in the goal clears the level, everyone respawns alive at the start;
// wolves get faster/denser toward the middle.
import { createSim, stepSim } from '../public/js/shared/sim.js';
import { CFG } from '../public/js/shared/config.js';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const sim = createSim({ seed: 5, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] });
stepSim(sim, {}, CFG.TICK);
const [a, b, c] = sim.players;
b.alive = false; b.deaths = 1; sim.circles.push({ playerId: 2, x: b.x, z: b.z, t: 0 });
a.x = 0; a.z = 0;                       // a reaches the goal; c is still out in the maze
let ev = stepSim(sim, {}, CFG.TICK);
const clear = ev.find((e) => e.type === 'levelClear');
ok(clear && clear.by === 1 && sim.state === 'levelclear', 'one kitty in the goal clears the level');
let died = false, levelStart = false;
for (let t = 0; t < 60 * 3 && !levelStart; t++) {
  c.invuln = 0; ev = stepSim(sim, {}, CFG.TICK);
  if (ev.some((e) => e.type === 'death')) died = true;
  if (ev.some((e) => e.type === 'levelStart')) levelStart = true;
}
ok(!died, 'nobody dies during the level-clear celebration');
ok(levelStart && sim.level === 2, 'next level starts');
const spawns = sim.levelData.spawnPoints;
ok(sim.players.every((p) => p.alive && !p.inCenter && Math.hypot(p.x - spawns[0].x, p.z - spawns[0].z) < 4), 'everyone (incl. the dead one) respawns alive at the start');

const ld = sim.levelData;
ok(ld.enemies.length >= 200, `wolves: ${ld.enemies.length}`);
const half = Math.floor(ld.legs.length / 2);
const outer = ld.enemies.filter((e) => e.leg < half), inner = ld.enemies.filter((e) => e.leg >= half);
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const len = (from, to) => ld.legs.slice(from, to).reduce((s, l) => s + l.len, 0);
ok(avg(inner.map((e) => e.speed)) > avg(outer.map((e) => e.speed)) * 1.05, `inner wolves faster (${avg(outer.map((e) => e.speed)).toFixed(2)} -> ${avg(inner.map((e) => e.speed)).toFixed(2)})`);
ok(inner.length / len(half) > outer.length / len(0, half), `inner legs denser (${(outer.length / len(0, half)).toFixed(3)} -> ${(inner.length / len(half)).toFixed(3)} wolves/unit)`);
const n = ld.legs.length;
const fin = ld.enemies.filter((e) => e.leg === n - 1);
ok(fin.length >= 8, `final stretch is crowded (${fin.length} wolves)`);
ok(ld.safeCorners.length === ld.corners.length - 1 && fin.some((e) => e.a0 < CFG.RING_WIDTH / 2), 'the goal-door corner is not a safe square');
