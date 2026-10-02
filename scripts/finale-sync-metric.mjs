// The final run's synchrony: how much its wolves move like one machine. Per room (leg), over its crossers,
// diagonals and loopers (chargers own their lanes and are left out; flankers counted separately):
//   laps      distinct lap times / wolves (1 lap for the whole room = everything in step with the beat)
//   locked    share of wolf pairs with the same lap: their relative timing never changes (a formation)
//   distinct  distinct (lap, phase in 1/20ths of the lap) pairs / wolves
//   cvar      circular variance of the wolves' phases (0 = all in phase, 1 = spread evenly)
// Also the wolf count and the generation time (fresh process: run it once per seed for timing).
//
// Usage: node scripts/finale-sync-metric.mjs [--seeds 8] [--hash]   (--hash: sha1 of the other levels too)
import { generateLevel } from '../public/js/shared/maze.js';
import { buildPlan } from '../public/js/shared/enemies.js';
import { SKATE_FINAL_LEVEL } from '../public/js/shared/config.js';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const SEEDS = [1, 42, 1337, 9001, 31337, 777777, 2024, 5, 99, 123456, 7, 8080].slice(0, argv.includes('--seeds') ? Number(argv[argv.indexOf('--seeds') + 1]) : 8);
const r3 = (x) => x.toFixed(3);
const agg = { n: 0, drift: 0, wolves: 0, rooms: 0, laps: 0, locked: 0, distinct: 0, cvar: 0, flankLocked: 0, flankRooms: 0, ms: [] };
for (const seed of SEEDS) {
  const t0 = performance.now();
  const ld = generateLevel(SKATE_FINAL_LEVEL, seed, 'ice');
  const ms = performance.now() - t0;
  agg.ms.push(ms);
  const rooms = new Map();
  for (const e of ld.enemies) {
    if (e.type === 'charger') continue;
    const key = e.pattern === 'flank' ? 'f' : 'r';
    if (!rooms.has(e.leg)) rooms.set(e.leg, { r: [], f: [] });
    const lap = buildPlan(e, e.frame, e.speed).cycle, T = ld.patternPlan.find((pl) => pl.leg === e.leg).beat;
    rooms.get(e.leg)[key].push({ lap, ph: e.phase });
    agg.n++; if (Math.abs(T / Math.max(1, Math.round(T / lap)) - lap) > 1e-4) agg.drift++;
  }
  const locked = (ws) => {
    let same = 0, all = 0;
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) { all++; if (Math.abs(ws[i].lap - ws[j].lap) < 1e-6) same++; }
    return all ? same / all : 0;
  };
  let s = { laps: 0, locked: 0, distinct: 0, cvar: 0, n: 0 };
  for (const { r, f } of rooms.values()) {
    if (r.length < 2) continue;
    s.n++;
    s.laps += new Set(r.map((w) => w.lap.toFixed(4))).size / r.length;
    s.locked += locked(r);
    s.distinct += new Set(r.map((w) => w.lap.toFixed(4) + ':' + Math.floor(w.ph * 20))).size / r.length;
    const cx = r.reduce((a, w) => a + Math.cos(2 * Math.PI * w.ph), 0) / r.length, sx = r.reduce((a, w) => a + Math.sin(2 * Math.PI * w.ph), 0) / r.length;
    s.cvar += 1 - Math.hypot(cx, sx);
    if (f.length > 1) { agg.flankLocked += locked(f); agg.flankRooms++; }
  }
  const drift = ld.patternPlan.filter((pl) => pl.period > pl.beat).length;
  console.log(`seed ${String(seed).padEnd(7)} wolves ${ld.enemies.length} rooms ${s.n} drifting rooms ${drift}  laps/wolf ${r3(s.laps / s.n)} locked pairs ${r3(s.locked / s.n)} ` +
    `distinct (lap,phase)/wolf ${r3(s.distinct / s.n)} phase circ.var ${r3(s.cvar / s.n)}  (${Math.round(ms)} ms)`);
  agg.wolves += ld.enemies.length; agg.rooms += s.n;
  for (const k of ['laps', 'locked', 'distinct', 'cvar']) agg[k] += s[k];
}
console.log(`AVG wolves ${(agg.wolves / SEEDS.length).toFixed(1)}  own-lap (drifting) share ${r3(agg.drift / agg.n)}  laps/wolf ${r3(agg.laps / agg.rooms)} locked pairs ${r3(agg.locked / agg.rooms)} ` +
  `distinct ${r3(agg.distinct / agg.rooms)} circ.var ${r3(agg.cvar / agg.rooms)}  flankers: locked pairs ${r3(agg.flankLocked / Math.max(1, agg.flankRooms))}  ` +
  `gen ms first ${Math.round(agg.ms[0])} max ${Math.round(Math.max(...agg.ms))}`);
if (argv.includes('--hash')) {
  const h = createHash('sha1');
  for (const seed of [1, 42, 1337, 9001, 'kitty', 777777, 31337, 2024]) {
    for (let l = 1; l <= 12; l++) h.update(JSON.stringify(generateLevel(l, seed, 'mixed')));
    for (let l = 1; l < SKATE_FINAL_LEVEL; l++) h.update(JSON.stringify(generateLevel(l, seed, 'ice')));
  }
  console.log('other levels sha1', h.digest('hex'));
}
