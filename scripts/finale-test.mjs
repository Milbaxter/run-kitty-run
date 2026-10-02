// MANUAL tuning tool, not part of `npm test` / CI (slow). Run it when changing the final run's generator.
// Skate only, THE FINAL RUN (level SKATE_FINAL_LEVEL of mode 'ice'): beatability proof by an oracle bot.
//
// The bot plays the real sim (createSim/stepSim, hits on, NOT invulnerable) with legal inputs only (one input
// vector of length <= 1 per tick). It is an oracle: wolves are pure functions of time, so it records their
// future positions by stepping a private copy of them with the real updateEnemies, and it predicts its own
// motion with the sim's own movement code (predictPlayer: real ice physics, walls, tree snow; boots pickups are
// replayed too). It then plays room by room:
//   - start pocket / under the halfway tree (no ice: it can stand still): stand on a staging spot, scan launch
//     ticks, launch in the middle of the earliest launch window >= --window s (else the widest) and skate the lane;
//   - every other gap (a few units of wolf-free ice, no stopping): carve a holding circle (radius rho, either side
//     of the lane) and leave it where it heads straight down the lane: rho sets the lap time, so the exit time is
//     continuous; it takes the earliest exit whose straight run through the room clears every wolf by --margin
//     even if it left up to --slack s early or late (a human's timing error);
//   - then skates the lane straight through the room to the next gap (or into the goal room).
// The plan is replayed on the real sim and must match the prediction tick for tick; a death, a lost extra life or
// a mismatch fails the run.
//
// Usage: node scripts/finale-test.mjs [--seeds 8 | --seed 42] [--boots 0,1,2,3,4] [--verbose]
//          [--margin 0.1] [--window 0.3] [--slack 0.1] [--level 8]
// Exit code 1 if any run is not won.

import { createSim, stepSim, predictPlayer } from '../public/js/shared/sim.js';
import { CFG, SKATE_FINAL_LEVEL } from '../public/js/shared/config.js';
import { createEnemies, updateEnemies } from '../public/js/shared/enemies.js';
import { inTree } from '../public/js/shared/maze.js';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);
const SEED_LIST = [1, 42, 1337, 9001, 31337, 777777, 2024, 5, 99, 123456, 7, 8080];
const SEEDS = arg('seed', null) != null ? [Number(arg('seed'))] : SEED_LIST.slice(0, Number(arg('seeds', 8)));
const BOOTS = String(arg('boots', '0,1,2,3,4')).split(',').map(Number);
const LEVEL = Number(arg('level', SKATE_FINAL_LEVEL));
const VERBOSE = flag('verbose');
const MARGIN = Number(arg('margin', 0.1));         // clearance (units) beyond the hit distance
const MIN_WIN = Number(arg('window', 0.3));        // launch window wanted when standing (s)
const SLACK = Number(arg('slack', 0.1));           // circle exits must survive leaving this early / late (s)

const TICK = CFG.TICK;
const HIT = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
const PLAN_R = HIT + MARGIN;
const LANES = [-3.6, -1.8, 0, 1.8, 3.6];
const ZMAX = CFG.RING_WIDTH / 2 - CFG.WALL_THICKNESS / 2 - CFG.KITTY_RADIUS;   // kitty center to the wall
const LOOK = 3;
const SLACK_T = Math.round(SLACK / TICK);
const MAXT = Math.round(1200 / TICK);

// ------------------------------------------------------------------ wolves: exact future positions
function makeOracle(ld) {
  const wolves = createEnemies(ld);
  const n = wolves.length;
  const X = wolves.map(() => new Float32Array(MAXT)), Z = wolves.map(() => new Float32Array(MAXT));
  let filled = 0;
  const rec = () => { for (let i = 0; i < n; i++) { X[i][filled] = wolves[i].x; Z[i][filled] = wolves[i].z; } filled++; };
  rec();                                               // tick 0: as created; tick k: after k updates (= after k stepSims)
  const ensure = (k) => { if (k >= MAXT) throw new Error('horizon'); while (filled <= k) { updateEnemies(wolves, ld, TICK); rec(); } };
  const box = ld.enemies.map((e) => {
    const f = e.frame;
    let x0 = Infinity, x1 = -Infinity;
    for (const q of e.route) { const x = f.ox + f.ux * q.th + f.nx * q.r; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    return { x0, x1 };
  });
  return { X, Z, ensure, box, n };
}

// min over a trajectory of (distance to the nearest wolf - PLAN_R); tr.xs[j] is the kitty after tick t0 + j + 1
function clearance(O, tr, t0, from = 0) {
  const N = tr.xs.length;
  if (N <= from) return Infinity;
  let lo = Infinity, hi = -Infinity;
  for (let j = from; j < N; j++) { lo = Math.min(lo, tr.xs[j]); hi = Math.max(hi, tr.xs[j]); }
  const ws = [];
  for (let i = 0; i < O.n; i++) if (O.box[i].x1 > lo - PLAN_R && O.box[i].x0 < hi + PLAN_R) ws.push(i);
  O.ensure(t0 + N);
  let best = Infinity;
  for (const i of ws) {
    const X = O.X[i], Z = O.Z[i], b = O.box[i];
    for (let j = from; j < N; j++) {
      const x = tr.xs[j];
      if (x < b.x0 - PLAN_R - 1 || x > b.x1 + PLAN_R + 1) continue;
      const dx = x - X[t0 + j + 1], dz = tr.zs[j] - Z[t0 + j + 1];
      const d = Math.sqrt(dx * dx + dz * dz) - PLAN_R;
      if (d < best) { best = d; if (best < 0) return best; }
    }
  }
  return best;
}

// ------------------------------------------------------------------ kitty prediction (the sim's own movement code)
function makeKitty(ld, items) {
  const fake = { levelData: ld, state: 'playing' };
  const pickR2 = (CFG.KITTY_RADIUS + CFG.ITEM_RADIUS) ** 2;
  const boots = items.filter((it) => it.type === 'boots');
  // simulate from state `st` with ctrl(p, j) -> {x, z}, until stop(p, j) or maxN ticks
  return function run(st, ctrl, stop, maxN) {
    const p = { ...st, alive: true, waitRelease: false, taken: new Set(st.taken) };
    const xs = [], zs = [], inputs = [];
    for (let j = 0; j < maxN; j++) {
      if (stop && stop(p, j)) break;
      const inp = ctrl(p, j);
      inputs.push(inp);
      predictPlayer(fake, p, inp, TICK);
      for (const it of boots) {
        if (p.taken.has(it.id) || p.speedMult >= CFG.SPEED_MULT_MAX) continue;
        if ((p.x - it.x) ** 2 + (p.z - it.z) ** 2 < pickR2) { p.taken.add(it.id); p.speedMult = Math.min(CFG.SPEED_MULT_MAX, p.speedMult + CFG.SPEED_BOOST); }
      }
      xs.push(p.x); zs.push(p.z);
      if (p.inCenter) break;
    }
    return { xs, zs, inputs, end: p };
  };
}
const snap = (p, taken) => ({ x: p.x, z: p.z, vx: p.vx, vz: p.vz, heading: p.heading, moving: p.moving, onIce: p.onIce, speedMult: p.speedMult, inCenter: p.inCenter, taken });

// controllers
const unit = (x, z) => { const m = Math.hypot(x, z); return m > 1 ? { x: x / m, z: z / m } : { x, z }; };
const laneCtl = (L) => (p) => unit(LOOK, L - p.z);
const goCtl = (tx, tz) => (p) => { const dx = tx - p.x, dz = tz - p.z; return Math.hypot(dx, dz) < 0.03 ? { x: 0, z: 0 } : unit(dx * 1.5, dz * 1.5); };
// circle of radius rho round (cx, cz); s = +1: heading angle increasing (it heads +x at its -z side), -1 mirrored
const orbitCtl = (cx, cz, rho, s) => (p) => {
  const ph = Math.atan2(p.z - cz, p.x - cx), d = Math.hypot(p.x - cx, p.z - cz);
  const chi = ph + s * (Math.PI / 2 + Math.atan(2 * (d - rho)));
  return { x: Math.cos(chi), z: Math.sin(chi) };
};

// ------------------------------------------------------------------ one game
function playFinale(seed, nBoots) {
  const sim = createSim({ seed, players: [{ id: 1, name: 'bot', color: 0 }], startLevel: LEVEL, mode: 'ice' });
  const ld = sim.levelData;
  if (!ld.finale) throw new Error('not the final run');
  const P = sim.players[0];
  P.speedMult = Math.min(CFG.SPEED_MULT_MAX, 1 + CFG.SPEED_BOOST * nBoots);
  const O = makeOracle(ld);
  const run = makeKitty(ld, ld.items);
  const legs = ld.legs, nl = legs.length;
  const tree = ld.trees[0];
  // wolf-free zone of kitty centers in front of room i (x in [a, b]); zone 0 is the start pocket
  const xr = (leg) => {
    let x0 = Infinity, x1 = -Infinity;
    ld.enemies.forEach((e, i) => { if (e.leg === leg) { x0 = Math.min(x0, O.box[i].x0); x1 = Math.max(x1, O.box[i].x1); } });
    return { x0, x1 };
  };
  const zones = [];
  for (let i = 0; i < nl; i++) {
    const a = i === 0 ? ld.corners[0].x - CFG.RING_WIDTH / 2 : xr(i - 1).x1 + PLAN_R;
    const b = xr(i).x0 - PLAN_R;
    zones.push({ a, b, tree: !!tree && tree.x > a && tree.x < b, start: i === 0 });
  }
  const zoneOverlap = zones.map((z, i) => (i > 0 && z.b - z.a < 2.5 ? i : -1)).filter((i) => i >= 0);

  let tick = 0;
  const taken = () => new Set(sim.items.filter((it) => it.taken).map((it) => it.id));
  const log = [];
  let fail = null;
  // replay inputs on the real sim; check the prediction
  const play = (inputs, pred) => {
    for (let j = 0; j < inputs.length && !fail; j++) {
      const ev = stepSim(sim, { 1: inputs[j] }, TICK);
      tick++;
      for (const e of ev) if (e.type === 'death' || e.type === 'extraLife') fail = `${e.type} at x=${P.x.toFixed(1)} t=${sim.levelTime.toFixed(2)} (wolf ${e.enemyId})`;
      if (sim.state === 'victory') return;
      if (pred && j < pred.xs.length && (Math.abs(pred.xs[j] - P.x) > 1e-6 || Math.abs(pred.zs[j] - P.z) > 1e-6)) fail = `prediction mismatch at tick ${tick}`;
    }
  };
  // the first tick: let go of the controls (the sim holds an ice-level spawn until a release)
  play([{ x: 0, z: 0 }]);

  // run from a state through room i: lane L until well inside the next zone (or the goal)
  const runRoom = (st, i, L, ctl0, n0) => {
    const nz = i + 1 < nl ? zones[i + 1] : null;
    return run(st, (p, j) => (j < n0 ? ctl0(p, j) : laneCtl(L)(p)), (p) => nz && p.x >= nz.a + 0.3, Math.round(60 / TICK));
  };

  for (let i = 0; i < nl && !fail && sim.state !== 'victory'; i++) {
    const Z = zones[i];
    const t0 = performance.now();
    let rec;
    if (Z.start || Z.tree) {
      // ---- stand still (no ice here), then launch
      const sx = Z.start ? ld.corners[0].x + 1.5 : tree.x - 1.35, sz = 0;
      const walk = run(snap(P, taken()), goCtl(sx, sz), (p) => Math.hypot(p.x - sx, p.z - sz) < 0.06 && Math.hypot(p.vx, p.vz) < 0.02, Math.round(20 / TICK));
      if (clearance(O, walk, tick) < 0) { fail = `room ${i}: walking to the staging spot is not safe`; break; }
      play(walk.inputs, walk);
      while (!fail && Math.hypot(P.vx, P.vz) > 1e-9) play([{ x: 0, z: 0 }]);   // come to a full stop
      if (fail) break;
      const st = snap(P, taken());
      let best = null;
      for (const L of LANES) {
        const tr = runRoom(st, i, L, null, 0);
        if (i + 1 < nl && tr.end.x < zones[i + 1].a) continue;
        // safe launch delays (ticks): the run is the same whenever it starts
        const H = Math.round(75 / TICK), ok = new Uint8Array(H);
        for (let d = 0; d < H; d++) ok[d] = clearance(O, tr, tick + d) >= 0 ? 1 : 0;
        let s = -1;
        for (let d = 0; d <= H; d++) {
          if (d < H && ok[d]) { if (s < 0) s = d; continue; }
          if (s < 0) continue;
          const w = (d - s) * TICK, cand = { L, tr, d: s + ((d - s) >> 1), w, start: s };
          if (!best || (w >= MIN_WIN && (best.w < MIN_WIN || cand.start < best.start)) || (best.w < MIN_WIN && w > best.w)) best = cand;
          s = -1;
          if (w >= MIN_WIN) break;
        }
      }
      if (!best) { fail = `room ${i}: no launch in 75 s`; break; }
      play(new Array(best.d).fill({ x: 0, z: 0 }));
      play(best.tr.inputs, best.tr);
      rec = { room: i, how: Z.start ? 'start' : 'tree', lane: best.L, wait: best.d * TICK, window: best.w };
    } else {
      // ---- ice gap: holding circle, exit into the lane
      const st = snap(P, taken());
      const cands = [];
      for (const L of LANES) {
        cands.push({ L, rho: 0, exit: 0, ctl: null });         // straight on, no circle
        for (const s of [1, -1]) for (let rho = 1.3; rho <= 3.2; rho += 0.15) {
          const cz = L + s * rho, cx = Z.b - rho - 0.2;
          if (Math.abs(cz) + rho > ZMAX - 0.1 || cx - rho < Z.a + 0.1) continue;
          const ctl = orbitCtl(cx, cz, rho, s);
          const orb = run(st, ctl, null, Math.round(70 / TICK));
          let prev = orb.end.heading;
          let ph = null;
          for (let j = 0; j < orb.xs.length; j++) {
            // heading on the circle: from the velocity direction between samples
            const x0 = j ? orb.xs[j - 1] : st.x, z0 = j ? orb.zs[j - 1] : st.z;
            const h = Math.atan2(orb.zs[j] - z0, orb.xs[j] - x0);
            if (ph != null && j > 10 && (s > 0 ? ph < 0 && h >= 0 : ph > 0 && h <= 0) && Math.abs(orb.zs[j] - L) < 0.3 && Math.abs(orb.xs[j] - cx) < 0.5) {
              cands.push({ L, rho, s, exit: j + 1, ctl, orb });
            }
            ph = h; prev = h;
          }
        }
      }
      cands.sort((a, b) => a.exit - b.exit);
      let pick = null, tried = 0;
      for (const c of cands) {
        tried++;
        const tr = runRoom(st, i, c.L, c.ctl || (() => ({ x: 1, z: 0 })), c.exit);
        if (i + 1 < nl && tr.end.x < zones[i + 1].a) continue;
        if (i + 1 >= nl && !tr.end.inCenter) continue;
        if (clearance(O, tr, tick) < 0) continue;
        // a human leaves the circle a little early or late: shift the run after the exit in time
        let ok = true, worst = Infinity;
        const after = { xs: tr.xs.slice(c.exit), zs: tr.zs.slice(c.exit) };
        for (let sh = -SLACK_T; sh <= SLACK_T && ok; sh++) { const cl = clearance(O, after, tick + c.exit + sh); worst = Math.min(worst, cl); ok = cl >= 0; }
        if (!ok) continue;
        pick = { ...c, tr, worst };
        break;
      }
      if (!pick) { fail = `room ${i}: no safe circle exit within 70 s (${cands.length} candidates)`; break; }
      play(pick.tr.inputs, pick.tr);
      rec = { room: i, how: pick.rho ? `circle r=${pick.rho.toFixed(2)}` : 'straight', lane: pick.L, wait: pick.exit * TICK, tried };
    }
    rec.ms = Math.round(performance.now() - t0);
    log.push(rec);
    if (VERBOSE) console.log('   ', JSON.stringify(rec));
  }
  if (!fail && sim.state !== 'victory') {
    // last room's run ends in the goal room; step until the sim notices
    for (let k = 0; k < 120 && sim.state !== 'victory'; k++) play([{ x: 1, z: 0 }]);
  }
  return { won: sim.state === 'victory', fail, time: sim.levelTime, log, wolves: ld.enemies.length, zoneOverlap, speed: P.speedMult };
}

// ------------------------------------------------------------------ main
let bad = 0;
const t00 = performance.now();
for (const seed of SEEDS) {
  for (const b of BOOTS) {
    const t0 = performance.now();
    const r = playFinale(seed, b);
    const circ = r.log.filter((x) => x.how.startsWith('circle')).length;
    const minWin = Math.min(...r.log.filter((x) => x.window != null).map((x) => x.window));
    console.log(`seed ${String(seed).padEnd(7)} boots ${b}: ${r.won ? 'WON ' : 'LOST'} run ${r.time.toFixed(1)}s, rooms ${r.log.length}, circled ${circ}, ` +
      `longest wait ${Math.max(...r.log.map((x) => x.wait)).toFixed(1)}s, stand windows >= ${minWin.toFixed(2)}s, wolves ${r.wolves}` +
      (r.zoneOverlap.length ? `, NO GAP before rooms ${r.zoneOverlap}` : '') + ` (${Math.round(performance.now() - t0)} ms)` + (r.fail ? `\n    FAIL: ${r.fail}` : ''));
    if (!r.won) bad++;
  }
}
console.log(`${bad ? bad + ' run(s) LOST' : 'all runs won'} in ${((performance.now() - t00) / 1000).toFixed(1)} s`);
process.exit(bad ? 1 : 0);
