import { CFG, WAVE10_FV } from './config.js';
import { createRng, hashSeed } from './rng.js';

// Hell's wolf waves (hell level 2 on, in a game with sim.waves: every kitty's game has them, protocol 26). Waves of
// wolves, a few ragged rows deep and the run's full width, walk the whole run from the goal room toward the start at
// WAVE_SPEED, one reaching the start every waveEvery(level) seconds (the first that far into the level): the level
// starts with them spread along the run already, and new ones keep coming from the goal end. A wave rises out of the
// ground (WAVE_CHARGE seconds of warning, its gap already showing; the ones already on the run at the level's start
// rise where they are), walks, and at the start sinks into the ground again (WAVE_SINK seconds; it catches no one
// then). Each wave has one gap (WAVE_GAP wide, somewhere across the run, its own spot every wave). Pure: everything
// follows from the game's seed, the hell level and the level's tick count (sim.enemyTicks), so the server and every
// client agree with nothing sent; the server's sim does the catching (sim.js), clients only draw them (main.js).
// s between waves reaching the start (the first one: this far into the level): 45 on hell 2, 35 on hell 3, 25 on hell 4,
// 15 on hell 5, 8 from hell 6 (Hell Run, finale version 23+: 10 from hell 6; sim: its mode and finales)
const waveEvery = (level, sim) => (level >= 6 ? (sim && sim.mode === 'run' && (sim.finales | 0) >= WAVE10_FV ? 10 : 8) : level === 5 ? 15 : level === 4 ? 25 : level === 3 ? 35 : 45);
const WAVE_SINK = 1.5;                      // s to sink into the ground at the start
const WAVE_CHARGE = 3;                      // s of warning before a wave sets off
const WAVE_SPEED = CFG.KITTY_SPEED * 0.45;  // units / s
const WAVE_GAP = 7;                         // the gap's clear width (about 5 kitties)
const WAVE_ROWS = 3;                        // rows deep
const WAVE_ROW_GAP = 1.15;                  // between rows (wolves almost touching)
const WAVE_SPACING = 1.2;                   // between wolves in a row
const WAVE_JITTER = 0.3;                    // how far each wolf strays from its spot (a wave, not a parade)
const WAVE_DEPTH = (WAVE_ROWS - 1) * WAVE_ROW_GAP + WAVE_JITTER;   // front row to back row
const WAVE_SAME = 5;                        // gaps closer than this are "the same spot" (never three in a row)

const wavesOn = (sim) => !!(sim && sim.hell && sim.waves && sim.level >= 2 && sim.levelData && sim.levelData.finale);

// the run's ends along x: where a wave starts (just outside the goal room) and where it is gone (the start room's edge)
function runOf(ld) {
  const sx = ld.corners[0].x, dir = Math.sign(sx) || 1;   // dir: from the goal toward the start
  return { dir, x0: dir * (ld.roomHalf + WAVE_DEPTH + 1.5), x1: sx - dir * (ld.roomHalf + 1), half: ld.corridorWidth / 2 - 0.75 };
}

// the gaps' middles of a game's hell level, wave by wave (each its own random spot across the run; two waves in a row
// may have theirs in about the same spot, a third is moved elsewhere), made once
const gapLists = new Map();
function gapOf(sim, k, half) {
  const key = sim.seed + ':' + sim.level + ':' + sim.mode;
  let L = gapLists.get(key);
  if (!L) { L = []; if (gapLists.size > 16) gapLists.delete(gapLists.keys().next().value); gapLists.set(key, L); }
  while (L.length <= k) {
    const i = L.length, rng = createRng(hashSeed(sim.seed, sim.level, 'wavegap', i));
    let g = rng.range(-half + WAVE_GAP / 2, half - WAVE_GAP / 2);
    for (let tries = 0; tries < 20 && i >= 2 && Math.abs(g - L[i - 1]) < WAVE_SAME && Math.abs(g - L[i - 2]) < WAVE_SAME; tries++) g = rng.range(-half + WAVE_GAP / 2, half - WAVE_GAP / 2);
    L.push(g);
  }
  return L[k];
}

// a wave's wolves (offsets from its front: dx back toward the goal side, z across) and its gap's middle, made once
const shapes = new Map();
function waveShape(sim, k) {
  const key = sim.seed + ':' + sim.level + ':' + k + ':' + sim.mode;
  let w = shapes.get(key);
  if (w) return w;
  const { half } = runOf(sim.levelData);
  const rng = createRng(hashSeed(sim.seed, sim.level, 'wave', k));
  const gap = gapOf(sim, k, half);
  const keepOut = WAVE_GAP / 2 + CFG.WOLF_RADIUS;   // no wolf's body reaches into the gap
  const wolves = [];
  for (let r = 0; r < WAVE_ROWS; r++) {
    const off = (r % 2) * WAVE_SPACING / 2;
    for (let z = -half + off; z <= half + 1e-6; z += WAVE_SPACING) {
      const jz = Math.max(-half, Math.min(half, z + rng.range(-WAVE_JITTER, WAVE_JITTER)));
      const dx = r * WAVE_ROW_GAP + rng.range(-WAVE_JITTER, WAVE_JITTER);
      if (Math.abs(jz - gap) < keepOut) continue;
      wolves.push({ dx: Math.max(0, dx), z: jz, i: wolves.length });
    }
  }
  w = { k, gap, wolves, depth: WAVE_DEPTH };
  if (shapes.size > 64) shapes.delete(shapes.keys().next().value);
  shapes.set(key, w);
  return w;
}

// the waves there are right now: [{ k, charge: 0..1 (rising) or 1, sink: 0 or 0..1 (going under at the start), moving,
// front: x of the front row, dir, gap, wolves, depth }]. dir: the way they walk (+1 / -1 along x); a wolf's
// x = front - dir * wolf.dx (the rows behind). Wave k reaches the start at arrive = every * (k + 1); it sets off
// len / WAVE_SPEED before that from the goal end, or (already on the run when the level starts) after its rise, from
// where it has to be to get there in time.
// (The list and its waves are reused from call to call, so a game with dozens of waves makes no garbage every tick:
// use what it returns before calling it again.)
const NONE = [];
const reuse = new WeakMap();   // sim -> { out: [], byK: Map(k -> wave object) }
function hellWaves(sim) {
  if (!wavesOn(sim)) return NONE;
  const t = sim.enemyTicks * CFG.TICK, ld = sim.levelData, run = runOf(ld);
  const walk = Math.abs(run.x1 - run.x0) / WAVE_SPEED;   // s from the goal end to the start
  let R = reuse.get(sim);
  if (!R || R.level !== sim.level || R.ld !== ld) { R = { out: [], byK: new Map(), level: sim.level, ld }; reuse.set(sim, R); }
  const out = R.out;
  out.length = 0;
  const every = waveEvery(sim.level, sim);
  const kHi = Math.floor((t + walk + WAVE_CHARGE) / every) - 1;
  for (let k = Math.max(0, Math.floor((t - WAVE_SINK) / every)); k <= kHi; k++) {
    const arrive = every * (k + 1), off = Math.max(WAVE_CHARGE, arrive - walk), rise = off - WAVE_CHARGE;
    if (t < rise || t >= arrive + WAVE_SINK) continue;
    let w = R.byK.get(k);
    if (!w) {
      const shape = waveShape(sim, k);
      w = { k, gap: shape.gap, wolves: shape.wolves, depth: shape.depth, dir: run.dir, half: run.half, charge: 0, sink: 0, moving: false, front: 0 };
      R.byK.set(k, w);
      if (R.byK.size > 80) for (const old of R.byK.keys()) { if (old < k - 60) R.byK.delete(old); else break; }
    }
    w.moving = t >= off && t < arrive;
    w.front = run.x1 - run.dir * WAVE_SPEED * (arrive - Math.min(arrive, Math.max(off, t)));
    w.charge = t < off ? (t - rise) / WAVE_CHARGE : 1;
    w.sink = t >= arrive ? (t - arrive) / WAVE_SINK : 0;
    out.push(w);
  }
  return out;
}

// the wave wolf touching a kitty at (x, z), if any (moving waves only; r2: the hit distance squared)
function waveHit(waves, x, z, r2) {
  const r = Math.sqrt(r2);
  for (const w of waves) {
    if (!w.moving) continue;
    const back = w.front - w.dir * w.depth;
    if ((x - w.front) * w.dir > r || (back - x) * w.dir > r) continue;   // nowhere near this wave
    for (const o of w.wolves) {
      const dx = x - (w.front - w.dir * o.dx), dz = z - o.z;
      if (dx * dx + dz * dz < r2) return true;
    }
  }
  return false;
}

export { hellWaves, waveHit, wavesOn, waveEvery, WAVE_CHARGE, WAVE_SPEED, WAVE_SINK };
