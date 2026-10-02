// Skate only's final run ends the game: reaching the goal on level SKATE_FINAL_LEVEL wins ('victory', final),
// downed kitties are carried to the party, and no other level or mode changed its flow.
import { createSim, stepSim } from '../public/js/shared/sim.js';
import { CFG, SKATE_FINAL_LEVEL, FINAL_MODES } from '../public/js/shared/config.js';
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fails++; };
const players = [1, 2, 3].map((id) => ({ id, name: 'k' + id, color: id }));
// Run + Skate seasons: summer, fall, winter (ice) x3; the third winter is the boss run
import { generateLevel } from '../public/js/shared/maze.js';
const themes = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => generateLevel(l, 9, 'mixed').theme).join(',');
check(themes === '0,1,2,0,1,2,0,1,2', `Run + Skate themes by level: ${themes}`);
const toGoal = (sim, id) => { const p = sim.players.find((q) => q.id === id); p.x = 0; p.z = 0; };
const run = (sim, ticks) => { const all = []; for (let t = 0; t < ticks; t++) all.push(...stepSim(sim, {}, CFG.TICK)); return all; };

for (const mode of FINAL_MODES) {
const fin = createSim({ seed: 9, players, startLevel: SKATE_FINAL_LEVEL, mode });
check(fin.levelData.finale && fin.levelData.ice && fin.levelData.checkpoints.length === 0 && fin.levelData.trees.length === 1 && fin.enemies.every((e) => e.route), `${mode}: level ${SKATE_FINAL_LEVEL} is the final run (ice, pattern wolves, no checkpoints, one tree)`);
run(fin, 1);
fin.players[1].alive = false;
toGoal(fin, 1);
const ev = run(fin, 1).map((e) => e.type);
check(ev.includes('levelClear') && ev.includes('victory') && fin.state === 'victory', `goal -> victory (${ev.join(',')})`);
check(fin.players.every((p) => p.alive && p.inCenter), 'downed and lagging kitties carried to the party');
run(fin, 60 * 60);
check(fin.state === 'victory' && fin.level === SKATE_FINAL_LEVEL, `${mode}: after 60 s still victory on the final level (never the next one)`);
}

for (const [mode, lvl, next] of [['mixed', 8, 9], ['ice', 8, 9], ['run', 8, 9], ['run', 9, 10]]) {
  const sim = createSim({ seed: 9, players: players.slice(0, 1), startLevel: lvl, mode });
  run(sim, 1); toGoal(sim, 1);
  run(sim, Math.ceil(CFG.LEVEL_CLEAR_TIME * 60) + 5);
  check(sim.level === next && sim.state === 'playing' && !!sim.levelData.finale === (FINAL_MODES.includes(mode) && next === SKATE_FINAL_LEVEL), `${mode} level ${lvl}: cleared -> level ${next}${sim.levelData.finale ? ' (the final run)' : ''}`);
}
process.exitCode = fails ? 1 : 0;
