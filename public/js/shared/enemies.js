import { CFG } from './config.js';
import { createRng, TAU, legPoint } from './rng.js';

// Wolves: deterministic enemy behaviors. Pure (no THREE, no DOM).
//
// Each wolf lives in a straight corridor leg of the square spiral, in leg-local coordinates:
// `th` = distance along the leg, `r` = lateral offset (spec.frame maps them to world x/z).
// (The names r/th are kept from the old circular map: territory bounds are still a0..a1 / rIn..rOut.)
//
// Interpretation notes (contract ambiguities):
// - EnemySpec has no start position; the start position is derived from spec.phase + spec.seed.
// - Every wolf is a wanderer (random spots in its territory) or a pattern wolf (below; Skate only).
// - Every enemy starts with a short phase-dependent pause so wolves are out of sync. There is no
//   "tell": wolves give no warning before they move.
// - rOut<rIn -> both collapse to the midpoint.
// - Private per-enemy state lives in enemy._st (includes an RNG closure; serializeEnemies ships its
//   integer state).
// - nearestEnemyDist returns Infinity when there are no enemies; distance is clamped at >= 0.


const EASE_T = 0.15;          // accel / decel time at move start / end (s)
const TURN_RATE_MOVE = 40;    // heading smoothing while moving (â‰ˆ exact after ease-in)
const LONG_REST_CHANCE = 0.15; // chance a wolf stands still for a while before its next move
const LONG_REST_MIN = 1.8, LONG_REST_MAX = 4.5;   // seconds

const UNIT_FRAME = { ox: 0, oz: 0, ux: 1, uz: 0, nx: 0, nz: 1 };

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function wrapPi(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

function turnToward(h, target, k, dt) {
  return wrapPi(h + wrapPi(target - h) * (1 - Math.exp(-k * dt)));
}

// Heading of a move by (dr lateral, dth along) in the wolf's leg frame.
function frameDir(st, dr, dth) {
  const f = st.f;
  return Math.atan2(f.uz * dth + f.nz * dr, f.ux * dth + f.nx * dr);
}

function pathLen(r0, th0, r1, th1) {
  return Math.hypot(r1 - r0, th1 - th0);
}

// Trapezoidal (or triangular for short moves) speed profile with EASE_T ramps.
function profileT(L, v) {
  if (L <= 1e-5) return 0;
  if (L >= v * EASE_T) return L / v + EASE_T;
  const a = v / EASE_T;
  return 2 * Math.sqrt(L / a);
}

function profileS(t, T, L, v) {
  if (T <= 0) return L;
  const a = v / EASE_T;
  if (L >= v * EASE_T) {
    if (t < EASE_T) return 0.5 * a * t * t;
    if (t < T - EASE_T) return 0.5 * v * EASE_T + v * (t - EASE_T);
    const u = T - t;
    return L - 0.5 * a * u * u;
  }
  const tp = T * 0.5;
  if (t < tp) return 0.5 * a * t * t;
  const u = T - t;
  return L - 0.5 * a * u * u;
}

function profileV(t, T, L, v) {
  if (T <= 0) return 0;
  const a = v / EASE_T;
  if (L >= v * EASE_T) {
    if (t < EASE_T) return a * t;
    if (t < T - EASE_T) return v;
    return a * Math.max(0, T - t);
  }
  const tp = T * 0.5;
  return t < tp ? a * t : a * Math.max(0, T - t);
}

// ---------------------------------------------------------------------------

function pickWanderTarget(st) {
  const { rng, rIn, rOut, a0, a1, r, th } = st;
  for (let i = 0; i < 24; i++) {
    const d = rng.range(2, 7);
    const phi = rng.range(0, TAU);
    const tr = r + d * Math.sin(phi);
    if (tr < rIn || tr > rOut) continue;
    const tth = th + d * Math.cos(phi);
    if (tth < a0 || tth > a1) continue;
    st.nr = tr; st.nth = tth;
    return;
  }
  // Tiny bounds fallback: random in-bounds point whose distance is closest to 4.5.
  let best = Infinity;
  st.nr = r; st.nth = th;
  for (let i = 0; i < 8; i++) {
    const tr = rng.range(rIn, rOut);
    const tth = rng.range(a0, a1);
    const score = Math.abs(pathLen(r, th, tr, tth) - 4.5);
    if (score < best) { best = score; st.nr = tr; st.nth = tth; }
  }
}

// Per-leg speed variation, capped safely below kitty speed so every wolf stays outrunnable.
function legSpeed(st, mult) {
  return Math.min(st.speed * mult, CFG.KITTY_SPEED * 0.92);
}

// Plans the next move target (st.nr, st.nth), the pause before it (st.pauseDur) and the leg speed.
// Randomness: variable pauses, per-leg speed, occasional dashes; sometimes a wolf stands still for a
// few seconds (LONG_REST_*).
function planNext(e, initial) {
  const st = e._st;
  const rng = st.rng;
  pickWanderTarget(st);
  st.longRest = false;
  if (!initial) {
    const roll = rng.next();
    if (roll < LONG_REST_CHANCE) { st.pauseDur = rng.range(LONG_REST_MIN, LONG_REST_MAX); st.longRest = true; }
    else st.pauseDur = roll < LONG_REST_CHANCE + 0.2 ? rng.range(0.12, 0.3) : rng.range(0.3, 1.1);
  }
  st.vLeg = legSpeed(st, rng.chance(0.18) ? 1.5 : rng.range(0.75, 1.25));
  // Higher levels / inner legs: shorter rests (spec.pauseScale < 1); long rests only shrink a little.
  if (!initial) st.pauseDur = Math.max(0.12, st.pauseDur * (st.longRest ? 0.6 + 0.4 * Math.min(1, st.pauseScale) : st.pauseScale));
}

function startMove(e) {
  const st = e._st;
  st.mode = 'move';
  st.t = 0;
  st.r0 = st.r; st.th0 = st.th;
  st.r1 = st.nr; st.th1 = st.nth;
  st.L = pathLen(st.r0, st.th0, st.r1, st.th1);
  st.T = profileT(st.L, st.vLeg);
}

function arrive(e) {
  const st = e._st;
  st.r = st.r1; st.th = st.th1;
  st.mode = 'pause';
  st.t = 0;
  planNext(e, false);
}

function place(e, r, th) {
  const p = legPoint(e._st.f, r, th);
  e.x = p.x; e.z = p.z;
}

function createEnemy(spec) {
  const rng = createRng((spec.seed >>> 0) || 1);
  let rIn = Number.isFinite(spec.rIn) ? spec.rIn : 0;
  let rOut = Number.isFinite(spec.rOut) ? spec.rOut : rIn;
  if (rOut < rIn) { const m = 0.5 * (rIn + rOut); rIn = rOut = m; }
  const a0 = Number.isFinite(spec.a0) ? spec.a0 : 0;
  const a1 = Number.isFinite(spec.a1) && spec.a1 >= a0 ? spec.a1 : a0;
  const phase = Number.isFinite(spec.phase) ? spec.phase : 0;
  const speed = Math.max(0.1, Number.isFinite(spec.speed) ? spec.speed : 2.4);
  const rMid = 0.5 * (rIn + rOut);
  const f = spec.frame || UNIT_FRAME;

  const st = {
    rng, f, rIn, rOut, a0, a1, speed,
    r: rMid, th: a0, mode: 'pause', t: 0, pauseDur: 0, longRest: false,
    nr: rMid, nth: a0, r0: 0, th0: 0, r1: 0, th1: 0, L: 0, T: 0,
    vLeg: speed,
    pauseScale: Number.isFinite(spec.pauseScale) ? spec.pauseScale : 1,
  };
  const e = {
    id: spec.id, type: spec.type, spec,
    x: 0, z: 0, heading: 0,
    radius: CFG.WOLF_RADIUS,
    moving: false, speedNow: 0,
    _st: st,
  };
  st.r = rng.range(rIn, rOut);
  st.th = a0 + phase * (a1 - a0);
  st.pauseDur = 0.2 + phase * 0.7;

  planNext(e, true);
  e.heading = wrapPi(frameDir(st, 0, 1)); // face along the leg; never hint at the first move
  place(e, st.r, st.th);
  return e;
}

function stepEnemy(e, dt) {
  const st = e._st;

  let rem = dt;
  for (let guard = 0; rem > 0 && guard < 8; guard++) {
    if (st.mode === 'pause') {
      const left = st.pauseDur - st.t;
      if (rem < left) { st.t += rem; rem = 0; break; }
      rem -= Math.max(0, left);
      startMove(e);
    } else {
      const left = st.T - st.t;
      if (rem < left) { st.t += rem; rem = 0; break; }
      rem -= Math.max(0, left);
      arrive(e);
    }
  }
  if (rem > 0) st.t += rem;

  let r, th;
  if (st.mode === 'move') {
    const s = profileS(st.t, st.T, st.L, st.vLeg);
    const f = st.L > 0 ? clamp(s / st.L, 0, 1) : 1;
    r = st.r0 + (st.r1 - st.r0) * f;
    th = st.th0 + (st.th1 - st.th0) * f;
    e.moving = true;
    e.speedNow = profileV(st.t, st.T, st.L, st.vLeg);
    if (st.L > 1e-5) {
      const dir = frameDir(st, st.r1 - st.r0, st.th1 - st.th0);
      e.heading = turnToward(e.heading, dir, TURN_RATE_MOVE, dt);
    }
  } else {
    r = st.r; th = st.th;
    e.moving = false;
    e.speedNow = 0;
    // keep facing the last direction while resting: wolves only turn as they set off
  }
  r = clamp(r, st.rIn, st.rOut);
  th = clamp(th, st.a0, st.a1);
  place(e, r, th);
}


// ---------------------------------------------------------------------------
// Pattern wolves (Skate only mode): no randomness at all. A pattern wolf runs a fixed route of waypoints
// in its leg frame at a constant cruise speed and never stands still: it slows into each waypoint and sets
// straight off for the next one (the EASE_T ramps), so its position is a pure function of time and players
// can learn the rhythm.
//
// Spec (from maze.js placement; any spec with a `route` is a pattern wolf, whatever its `type`):
//   route: [{ r, th }]  waypoints in leg-local coords
//   loop:  true  -> A > B > C > A ...   false/absent -> ping-pong A > B > C > B > A ...
//   speed: cruise speed (units/s);  phase: 0..1 offset into the cycle (same phase = same timing)
//   hold:  (the final run, ping-pong routes) seconds it stands at each end before running back (the lap grows by
//          2 holds; still a pure function of time: st.time is the whole state)
//   rIn/rOut/a0/a1: bounding box of the route (kept for bounds checks / selftest)
// Public extras on the enemy: e.route (the spec route), e.cycleT (cycle length, s), e.cycleU (0..1 now).
// No tell: a pattern wolf turns round at the end of a run without warning.

function isPattern(spec) { return !!(spec && Array.isArray(spec.route) && spec.route.length >= 2); }

// Builds the timed segment list: [{ r0, th0, r1, th1, L, T, dir, tStart }] and the cycle length.
function buildPlan(spec, f, speed) {
  const pts = spec.route.map((w) => ({ r: Number(w.r) || 0, th: Number(w.th) || 0 }));
  const order = [];
  for (let i = 0; i < pts.length; i++) order.push(i);
  if (spec.loop) order.push(0);
  else for (let i = pts.length - 2; i >= 0; i--) order.push(i);   // ping-pong back to the start
  const segs = [];
  const hold = !spec.loop && spec.hold > 0 ? spec.hold : 0;
  let t = 0;
  for (let k = 0; k + 1 < order.length; k++) {
    const a = pts[order[k]], b = pts[order[k + 1]];
    const L = pathLen(a.r, a.th, b.r, b.th);
    const T = profileT(L, speed);
    const dir = L > 1e-5 ? Math.atan2(f.uz * (b.th - a.th) + f.nz * (b.r - a.r), f.ux * (b.th - a.th) + f.nx * (b.r - a.r)) : null;
    segs.push({ r0: a.r, th0: a.th, r1: b.r, th1: b.th, L, T, dir, tStart: t });
    t += T;
    // the final run: a wolf may stand at each end of its run for its own fixed time (spec.hold) before running back
    if (hold > 0) { segs.push({ r0: b.r, th0: b.th, r1: b.r, th1: b.th, L: 0, T: hold, dir: null, tStart: t, hold: true }); t += hold; }
  }
  // segments with no movement inherit the previous direction
  let last = null;
  for (let pass = 0; pass < 2; pass++) for (const s of segs) { if (s.dir == null) s.dir = last; else last = s.dir; }
  for (const s of segs) if (s.dir == null) s.dir = 0;
  return { segs, cycle: Math.max(1e-3, t), speed };
}

// Cruise speed at which a route takes exactly `cycle` seconds per lap, for routes whose every run is long enough
// to reach cruise speed (maze.js fits each room wolf to its leg's beat this way and checks the resulting cycle).
function patternSpeed(spec, cycle) {
  const plan = buildPlan(spec, UNIT_FRAME, 1), runs = plan.segs.filter((s) => s.L > 1e-5);
  const held = plan.segs.reduce((a, s) => a + (s.hold ? s.T : 0), 0);
  return runs.reduce((a, s) => a + s.L, 0) / (cycle - held - runs.length * EASE_T);
}

// Pure: pose of a pattern wolf at cycle time tc (0 <= tc < cycle).
function patternPose(plan, tc) {
  const segs = plan.segs;
  let i = segs.length - 1;
  for (let k = 0; k < segs.length; k++) { if (tc < segs[k].tStart + segs[k].T) { i = k; break; } }
  const s = segs[i];
  if (s.hold) return { r: s.r0, th: s.th0, heading: s.dir, speed: 0, hold: true };
  const u = tc - s.tStart;
  const d = profileS(u, s.T, s.L, plan.speed);
  const q = s.L > 0 ? clamp(d / s.L, 0, 1) : 1;
  return { r: s.r0 + (s.r1 - s.r0) * q, th: s.th0 + (s.th1 - s.th0) * q, heading: s.dir, speed: profileV(u, s.T, s.L, plan.speed) };
}

function poseEnemy(e) {
  const plan = e._plan;
  const tc = clamp(e._st.time, 0, plan.cycle - 1e-9);
  const p = patternPose(plan, tc);
  e.heading = p.heading; e.moving = !p.hold; e.speedNow = p.speed;
  e.cycleU = tc / plan.cycle;
  place(e, p.r, p.th);
}

function createPatternEnemy(spec) {
  const f = spec.frame || UNIT_FRAME;
  const speed = Math.max(0.1, Number.isFinite(spec.speed) ? spec.speed : 2.4);
  const plan = buildPlan(spec, f, speed);
  const phase = Number.isFinite(spec.phase) ? spec.phase : 0;
  // the time in the cycle is the whole state (all serializeEnemies ships)
  const st = { f, time: (((phase % 1) + 1) % 1) * plan.cycle };
  const e = {
    id: spec.id, type: spec.type, spec, pattern: true,
    x: 0, z: 0, heading: 0, radius: CFG.WOLF_RADIUS,
    moving: true, speedNow: 0,
    route: spec.route, loop: !!spec.loop, cycleT: plan.cycle, cycleU: 0,
    _st: st, _plan: plan,
  };
  poseEnemy(e);
  return e;
}

function stepPatternEnemy(e, dt) {
  const st = e._st;
  st.time = (st.time + dt) % e._plan.cycle;
  poseEnemy(e);
}

// ---------------------------------------------------------------------------

function createEnemies(levelData) {
  const specs = (levelData && levelData.enemies) || [];
  const out = [];
  for (const spec of specs) out.push(isPattern(spec) ? createPatternEnemy(spec) : createEnemy(spec));
  return out;
}

function updateEnemies(enemies, levelData, dt) {
  if (!(dt > 0)) return;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e.pattern) stepPatternEnemy(e, dt); else stepEnemy(e, dt);
  }
}

// Distance from (x, z) to the nearest enemy's body edge (>= 0). Infinity if none.
function nearestEnemyDist(enemies, x, z) {
  let best = Infinity;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const d = Math.hypot(e.x - x, e.z - z) - e.radius;
    if (d < best) best = d;
  }
  return best < 0 ? 0 : best;
}

// Network resync: only the mutable state (spec constants and the frame are rebuilt from the level seed).
// Pattern wolf: [id, time]. Wanderer: [id, heading, rngState, ...WANDER_SYNC]; x/z/moving/speedNow are derived.
const WANDER_SYNC = ['r', 'th', 'mode', 't', 'pauseDur', 'nr', 'nth', 'r0', 'th0', 'r1', 'th1', 'L', 'T', 'vLeg', 'longRest'];

function serializeEnemies(enemies) {
  return enemies.map((e) => {
    const st = e._st;
    return e.pattern ? [e.id, st.time] : [e.id, e.heading, st.rng.getState(), ...WANDER_SYNC.map((k) => st[k])];
  });
}

function applyEnemyState(enemies, data) {
  const byId = new Map(data.map((d) => [d[0], d]));
  for (const e of enemies) {
    const d = byId.get(e.id);
    if (!d) continue;
    const st = e._st;
    if (e.pattern) { st.time = d[1]; poseEnemy(e); continue; }
    st.rng.setState(d[2]);
    WANDER_SYNC.forEach((k, i) => { st[k] = d[3 + i]; });
    stepEnemy(e, 0);   // x/z/moving/speedNow from the state (dt 0: nothing advances)
    e.heading = d[1];  // after: stepEnemy's wrapPi could move the last bit
  }
}

export { createEnemies, updateEnemies, nearestEnemyDist, serializeEnemies, applyEnemyState, isPattern, patternPose, buildPlan, patternSpeed, EASE_T };
