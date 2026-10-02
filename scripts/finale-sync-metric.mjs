// The final run's wolves: one speed per kind, each crosser / diagonal with its own wall hold and phase (so every wolf
// has its own lap and the room never repeats as a whole). Per seed: wolf counts per kind, the speeds per kind (must
// be one each), the hold range, the generator's sampled worst wait (patternPlan maxWait), the generation time
// (fresh process: run it once per seed for timing), and with --gaps the real-wolf replay (maze.js finaleGaps) over
// later stretches of level time (a room repeats every FINALE_PERIOD s, so these should match the generator).
//
// Usage: node scripts/finale-sync-metric.mjs [--seeds 8] [--gaps] [--hash]   (--hash: sha1 of the other levels too)
import { generateLevel, finaleGaps } from '../public/js/shared/maze.js';
import { buildPlan } from '../public/js/shared/enemies.js';
import { SKATE_FINAL_LEVEL } from '../public/js/shared/config.js';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const SEEDS = [1, 42, 1337, 9001, 31337, 777777, 2024, 5, 99, 123456, 7, 8080, 'kitty', 11, 12, 13, 14, 15, 16, 17]
  .slice(0, argv.includes('--seeds') ? Number(argv[argv.indexOf('--seeds') + 1]) : 8);
const UNSEEN = [[600, 660], [2000, 2060]];
const agg = { wolves: 0, kinds: {}, ms: [], holds: [], laps: 0, lapsN: 0, genWait: 0, waits: [], minWin: Infinity };
for (const seed of SEEDS) {
  const t0 = performance.now();
  const ld = generateLevel(SKATE_FINAL_LEVEL, seed, 'ice');
  const ms = performance.now() - t0;
  agg.ms.push(ms);
  const kinds = {}, speeds = {};
  for (const e of ld.enemies) {
    kinds[e.type] = (kinds[e.type] || 0) + 1;
    (speeds[e.type] ||= new Set()).add(e.speed);
    if (e.hold != null) agg.holds.push(e.hold);
  }
  // distinct laps per room (crossers / diagonals / loopers): 1 = in step with each other, 1 per wolf = all own laps
  const rooms = new Map();
  for (const e of ld.enemies) if (e.type !== 'charger') (rooms.get(e.leg) || rooms.set(e.leg, []).get(e.leg)).push(buildPlan(e, e.frame, e.speed).cycle.toFixed(4));
  for (const laps of rooms.values()) { agg.laps += new Set(laps).size / laps.length; agg.lapsN++; }
  const genWait = Math.max(...ld.patternPlan.map((p) => p.maxWait));
  agg.genWait = Math.max(agg.genWait, genWait);
  let line = '';
  if (argv.includes('--gaps')) {
    const ws = [];
    for (const pl of ld.patternPlan) for (const g of finaleGaps(ld, pl, UNSEEN)) { ws.push(g.maxWait); agg.minWin = Math.min(agg.minWin, g.window); }
    agg.waits.push(...ws);
    line = `  later spans: worst wait ${Math.max(...ws).toFixed(2)}s mean ${(ws.reduce((a, b) => a + b, 0) / ws.length).toFixed(2)}s`;
  }
  for (const k in kinds) agg.kinds[k] = (agg.kinds[k] || 0) + kinds[k];
  agg.wolves += ld.enemies.length;
  const sp = Object.entries(speeds).map(([k, s]) => `${k} ${[...s].join('/')}`).join(', ');
  console.log(`seed ${String(seed).padEnd(7)} wolves ${ld.enemies.length} ${JSON.stringify(kinds)} speeds: ${sp}  generator worst wait ${genWait}s  (${Math.round(ms)} ms)${line}`);
}
const n = SEEDS.length, h = agg.holds;
console.log(`AVG wolves ${(agg.wolves / n).toFixed(1)} ` + Object.entries(agg.kinds).map(([k, v]) => `${k} ${(v / n).toFixed(1)}`).join(' ')
  + `  holds ${Math.min(...h).toFixed(2)}..${Math.max(...h).toFixed(2)} mean ${(h.reduce((a, b) => a + b, 0) / h.length).toFixed(2)}s  distinct laps/wolf ${(agg.laps / agg.lapsN).toFixed(3)}`
  + `  generator worst wait ${agg.genWait}s  gen ms first ${Math.round(agg.ms[0])} max ${Math.round(Math.max(...agg.ms))}`);
if (agg.waits.length) {
  const w = agg.waits.slice().sort((a, b) => a - b), q = (p) => w[Math.min(w.length - 1, Math.floor(p * w.length))].toFixed(2);
  console.log(`later spans ${JSON.stringify(UNSEEN)}, per room: worst wait median ${q(0.5)} p90 ${q(0.9)} p99 ${q(0.99)} max ${q(1)}s, rooms > 8s ${w.filter((x) => x > 8).length}/${w.length}, min window ${agg.minWin.toFixed(2)}s`);
}
if (argv.includes('--hash')) {
  const hh = createHash('sha1');
  for (const seed of [1, 42, 1337, 9001, 'kitty', 777777, 31337, 2024]) {
    for (let l = 1; l <= 12; l++) hh.update(JSON.stringify(generateLevel(l, seed, 'mixed')));
    for (let l = 1; l < SKATE_FINAL_LEVEL; l++) hh.update(JSON.stringify(generateLevel(l, seed, 'ice')));
  }
  console.log('other levels sha1', hh.digest('hex'));
}
