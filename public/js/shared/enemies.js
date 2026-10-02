import { CFG } from './config.js';
import { createRng, hashSeed, TAU } from './rng.js';

// Wolves: deterministic enemy behaviors. Pure (no THREE, no DOM).
//
// Each wolf lives in a straight corridor leg of the square spiral, in leg-local coordinates:
// `th` = distance along the leg, `r` = lateral offset (spec.frame maps them to world x/z).
// (The names r/th are kept from the old circular map: territory bounds are still a0..a1 / rIn..rOut.)
//
// Interpretation notes (contract ambiguities):
// - EnemySpec has no start position; the start position is derived from spec.phase + spec.seed.
// - Every enemy starts with a short phase-dependent pause so wolves are out of sync. There is no
//   "tell": wolves give no warning before they move (e.tell stays 0).
//   go, and are out of sync with each other.
// - Patroller sub-range: legs longer than ~6 units may use a random sub-range (>=55% of the arc),
//   and the patrolled arc is capped at 24 units so a lap stays readable on huge rings.
// - Missing/invalid spec.r -> middle of [rIn,rOut]; rOut<rIn -> both collapse to the midpoint.
// - Private per-enemy state lives in enemy._st (includes an RNG closure: not serializable;
//   network clients should replicate x/z/heading/moving/tell rather than the internal state).
// - nearestEnemyDist returns Infinity when there are no enemies; distance is clamped at >= 0.


const EASE_T = 0.15;          // accel / decel time at move start / end (s)
const TURN_RATE_MOVE = 40;    // heading smoothing while moving (â‰ˆ exact after ease-in)
const LONG_REST_CHANCE = 0.15; // chance a wolf stands still for a while before its next move
const LONG_REST_MIN = 1.8, LONG_REST_MAX = 4.5;   // seconds

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
// Randomness: variable pauses, per-leg speed, occasional dashes, patrollers that stop short and
// double back. Wanderers sometimes stand still for a few seconds (LONG_REST_*).
function planNext(e, initial) {
  const st = e._st;
  const rng = st.rng;
  switch (e.type) {
    case 'wanderer':
      pickWanderTarget(st);
      st.longRest = false;
      if (!initial) {
        const roll = rng.next();
        if (roll < LONG_REST_CHANCE) { st.pauseDur = rng.range(LONG_REST_MIN, LONG_REST_MAX); st.longRest = true; }
        else st.pauseDur = roll < LONG_REST_CHANCE + 0.2 ? rng.range(0.12, 0.3) : rng.range(0.3, 1.1);
      }
      st.vLeg = legSpeed(st, rng.chance(0.18) ? 1.5 : rng.range(0.75, 1.25));
      break;
    case 'sweeper': {
      if (!initial) st.toHigh = rng.chance(0.85) ? !st.toHigh : st.toHigh;
      st.k++;
      st.nr = st.toHigh ? st.rOut : rng.chance(0.5) ? st.rIn : rng.range(st.rIn, st.rOut);
      if (Math.abs(st.nr - st.r) < 1) st.nr = st.r > 0.5 * (st.rIn + st.rOut) ? st.rIn : st.rOut;
      st.nth = clamp(st.center + st.amp * rng.range(-1, 1), st.a0, st.a1);
      if (!initial) st.pauseDur = rng.range(0.15, 0.7);
      st.vLeg = legSpeed(st, rng.range(0.8, 1.3));
      break;
    }
    case 'orbiter':
    case 'patroller':
    default: {
      const eps = 1e-4;
      const isOrb = e.type === 'orbiter';
      if (!initial) {
        if (st.th >= st.pa1 - eps) st.toHigh = false;
        else if (st.th <= st.pa0 + eps) st.toHigh = true;
        else st.toHigh = rng.chance(isOrb ? 0.7 : 0.5) ? !st.toHigh : st.toHigh;
      }
      const end = st.toHigh ? st.pa1 : st.pa0;
      st.nr = isOrb ? st.r : clamp(st.r + rng.range(-0.8, 0.8), st.rIn, st.rOut);
      const remain = Math.abs(end - st.th);
      // ~40% of legs stop short somewhere along the way (if there is room), then pick a new direction.
      if (!initial && remain > 4 && rng.chance(isOrb ? 0.25 : 0.4)) {
        st.nth = st.th + (end - st.th) * rng.range(0.3, 0.75);
      } else {
        st.nth = end;
      }
      if (!initial) st.pauseDur = rng.range(isOrb ? 0.2 : 0.18, isOrb ? 0.6 : 0.8);
      st.vLeg = legSpeed(st, rng.range(0.8, 1.3));
      break;
    }
  }
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
  const f = e._st.f;
  e.x = f.ox + f.ux * th + f.nx * r;
  e.z = f.oz + f.uz * th + f.nz * r;
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
  const fixedR = clamp(Number.isFinite(spec.r) ? spec.r : rMid, rIn, rOut);
  const f = spec.frame || { ox: 0, oz: 0, ux: 1, uz: 0, nx: 0, nz: 1 };

  const st = {
    rng, f, rIn, rOut, a0, a1, phase, speed,
    r: rMid, th: a0, mode: 'pause', t: 0, pauseDur: 0,
    nr: rMid, nth: a0, r0: 0, th0: 0, r1: 0, th1: 0, L: 0, T: 0,
    toHigh: true, pa0: a0, pa1: a1, center: a0, amp: 0, k: 0, v: 0, dir: 1,
    vLeg: speed,
    pauseScale: Number.isFinite(spec.pauseScale) ? spec.pauseScale : 1,
  };
  const e = {
    id: spec.id, type: spec.type, spec,
    x: 0, z: 0, heading: 0,
    radius: CFG.WOLF_RADIUS,
    moving: false, tell: 0, speedNow: 0,
    _st: st,
  };
  const initialPause = 0.25 + phase * 0.75;

  switch (spec.type) {
    case 'orbiter': {
      st.r = fixedR;
      st.dir = spec.dir < 0 ? -1 : 1;
      st.th = a0 + phase * (a1 - a0);
      st.pa0 = a0; st.pa1 = a1;
      st.toHigh = st.dir > 0;
      st.pauseDur = initialPause;
      break;
    }
    case 'wanderer': {
      st.r = rng.range(rIn, rOut);
      st.th = a0 + phase * (a1 - a0);
      st.pauseDur = 0.2 + phase * 0.7;
      break;
    }
    case 'sweeper': {
      st.center = clamp(Number.isFinite(spec.angle) ? spec.angle : 0.5 * (a0 + a1), a0, a1);
      st.amp = 2.5;                               // ~Â±2.5 units of random drift along the leg per sweep
      st.r = rIn + phase * (rOut - rIn);
      st.th = clamp(st.center + st.amp * Math.sin(phase * TAU), a0, a1);
      st.toHigh = rng.chance(0.5);
      st.pauseDur = initialPause;
      break;
    }
    case 'patroller':
    default: {
      st.r = fixedR;
      const span = a1 - a0;
      let subLen = span;
      if (span > 6) subLen = rng.range(Math.max(6, 0.55 * span), span);
      const subSpan = Math.min(span, subLen, 24);
      st.pa0 = a0 + rng.range(0, Math.max(0, (a1 - a0) - subSpan));
      st.pa1 = st.pa0 + subSpan;
      st.th = st.pa0 + phase * subSpan;
      st.toHigh = rng.chance(0.5);
      st.pauseDur = initialPause;
      break;
    }
  }
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
    e.tell = 0;
    e.speedNow = profileV(st.t, st.T, st.L, st.vLeg);
    if (st.L > 1e-5) {
      const dir = frameDir(st, st.r1 - st.r0, st.th1 - st.th0);
      e.heading = turnToward(e.heading, dir, TURN_RATE_MOVE, dt);
    }
  } else {
    r = st.r; th = st.th;
    e.moving = false;
    e.speedNow = 0;
    e.tell = 0; // no crouch / eye-glow warning before moving
    // keep facing the last direction while resting: wolves only turn as they set off
  }
  r = clamp(r, st.rIn, st.rOut);
  th = clamp(th, st.a0, st.a1);
  place(e, r, th);
}


// ---------------------------------------------------------------------------
// Pattern wolves (Skate only mode): no randomness at all. A pattern wolf walks a fixed route of
// waypoints in its leg frame at a constant cruise speed, holding a fixed time at each waypoint, so its
// position is a pure function of time and players can learn the rhythm.
//
// Spec (from maze.js placement; any spec with a `route` is a pattern wolf, whatever its `type`):
//   route: [{ r, th, hold }]  waypoints in leg-local coords; hold = seconds standing at that waypoint
//                             before leaving it (default spec.hold, else 0.5)
//   loop:  true  -> A > B > C > A ...   false/absent -> ping-pong A > B > C > B > A ...
//   speed: cruise speed (units/s);  phase: 0..1 offset into the cycle (same phase = same timing)
//   jitter: optional per-cycle hold variation (see cyclePlan)
//   rIn/rOut/a0/a1: bounding box of the route (kept for bounds checks / selftest)
// Public extras on the enemy: e.route (the spec route), e.cycleT (cycle length, s), e.cycleU (0..1 now).
// No tell: a pattern wolf keeps facing the way it came while it holds and sets off without warning
// (e.tell stays 0; TELL_T > 0 would turn it toward its next move over the end of each hold).

const TELL_T = 0;

function isPattern(spec) { return !!(spec && Array.isArray(spec.route) && spec.route.length >= 2); }

// Builds the timed segment list: [{ hold, r0, th0, r1, th1, L, T, dir, tStart }] and the cycle length.
function buildPlan(spec, f, speed) {
  const pts = spec.route.map((w) => ({
    r: Number(w.r) || 0, th: Number(w.th) || 0,
    hold: Math.max(0, Number.isFinite(w.hold) ? w.hold : Number.isFinite(spec.hold) ? spec.hold : 0.5),
  }));
  const order = [];
  for (let i = 0; i < pts.length; i++) order.push(i);
  if (spec.loop) order.push(0);
  else for (let i = pts.length - 2; i >= 0; i--) order.push(i);   // ping-pong back to the start
  const segs = [];
  let t = 0;
  for (let k = 0; k + 1 < order.length; k++) {
    const a = pts[order[k]], b = pts[order[k + 1]];
    const L = pathLen(a.r, a.th, b.r, b.th);
    const T = profileT(L, speed);
    const dir = L > 1e-5 ? Math.atan2(f.uz * (b.th - a.th) + f.nz * (b.r - a.r), f.ux * (b.th - a.th) + f.nx * (b.r - a.r)) : null;
    segs.push({ hold: a.hold, r0: a.r, th0: a.th, r1: b.r, th1: b.th, L, T, dir, tStart: t });
    t += a.hold + T;
  }
  // segments with no movement inherit the previous direction
  let last = null;
  for (let pass = 0; pass < 2; pass++) for (const s of segs) { if (s.dir == null) s.dir = last; else last = s.dir; }
  for (const s of segs) if (s.dir == null) s.dir = 0;
  return { segs, cycle: Math.max(1e-3, t), speed };
}

// Pure: pose of a pattern wolf at cycle time tc (0 <= tc < cycle).
function patternPose(plan, tc) {
  const segs = plan.segs;
  let i = segs.length - 1;
  for (let k = 0; k < segs.length; k++) { if (tc < segs[k].tStart + segs[k].hold + segs[k].T) { i = k; break; } }
  const s = segs[i];
  const prev = segs[(i - 1 + segs.length) % segs.length];
  const u = tc - s.tStart;
  if (u < s.hold) {
    // holding at the waypoint: face the way we came (turn toward the next move during the tell, if any)
    const tellT = Math.min(TELL_T, s.hold);
    const k = tellT > 0 ? clamp((u - (s.hold - tellT)) / tellT, 0, 1) : 0;
    const e = k * k * (3 - 2 * k);
    return { r: s.r0, th: s.th0, heading: wrapPi(prev.dir + wrapPi(s.dir - prev.dir) * e), moving: false, speed: 0, tell: k };
  }
  const tm = u - s.hold;
  const d = profileS(tm, s.T, s.L, plan.speed);
  const q = s.L > 0 ? clamp(d / s.L, 0, 1) : 1;
  return {
    r: s.r0 + (s.r1 - s.r0) * q, th: s.th0 + (s.th1 - s.th0) * q,
    heading: s.dir, moving: true, speed: profileV(tm, s.T, s.L, plan.speed), tell: 0,
  };
}

// spec.jitter (0..MAX_JITTER, default 0): every cycle each hold is stretched or shortened by up to jitter * hold,
// from a hash of (seed, cycle, segment), then rebalanced so the cycle length stays the same. Wolves stop being
// metronomes but stay deterministic (same on every client) and keep their beat with their neighbours.
// Jittered wolves also skip a hold now and then (NO_STOP_CHANCE per hold per cycle): they turn straight round
// without stopping, and the skipped time goes on their other holds, so the cycle length still stays the same.
const MAX_JITTER = 0.45;
const NO_STOP_CHANCE = 0.15;

// deterministic 0..1 from (seed, tag, cycle, segment)
function hash01(seed, tag, k, i) {
  let h = hashSeed(seed, tag, k, i);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h = (h ^ (h >>> 16)) >>> 0; // fmix: FNV alone is clumpy
  return h / 4294967296;
}

function cyclePlan(e, k) {
  const plan = e._plan, j = e._jitter;
  if (!(j > 0)) return plan;
  if (e._cyc && e._cyc.k === k) return e._cyc.plan;
  const segs = plan.segs;
  const seed = e.spec.seed >>> 0;
  let sumD = 0, sumH = 0;
  const d = segs.map((s, i) => {
    const u = hash01(seed, 'hold', k, i) * 2 - 1;
    sumD += j * s.hold * u; sumH += s.hold;
    return j * s.hold * u;
  });
  let holds = segs.map((s, i) => Math.max(0, s.hold + d[i] - (sumH > 0 ? s.hold * sumD / sumH : 0)));
  const skip = segs.map((s, i) => hash01(seed, 'skip', k, i) < NO_STOP_CHANCE);
  let freed = 0, kept = 0;
  holds.forEach((h, i) => { if (skip[i]) freed += h; else kept += h; });
  if (freed > 0 && kept > 0) holds = holds.map((h, i) => (skip[i] ? 0 : h * (1 + freed / kept)));
  let t = 0;
  const out = segs.map((s, i) => {
    const hold = holds[i];
    const o = Object.assign({}, s, { hold, tStart: t });
    t += hold + s.T;
    return o;
  });
  const cp = { segs: out, cycle: plan.cycle, speed: plan.speed };
  e._cyc = { k, plan: cp };
  return cp;
}

function poseEnemy(e) {
  const st = e._st, plan = e._plan;
  const tc = clamp(st.time, 0, plan.cycle - 1e-9);
  const p = patternPose(cyclePlan(e, st.k), tc);
  e.heading = p.heading; e.moving = p.moving; e.speedNow = p.speed; e.tell = p.tell;
  e.cycleU = tc / plan.cycle;
  place(e, p.r, p.th);
}

function createPatternEnemy(spec) {
  const f = spec.frame || { ox: 0, oz: 0, ux: 1, uz: 0, nx: 0, nz: 1 };
  const speed = Math.max(0.1, Number.isFinite(spec.speed) ? spec.speed : 2.4);
  const plan = buildPlan(spec, f, speed);
  const phase = Number.isFinite(spec.phase) ? spec.phase : 0;
  // st is what serializeEnemies ships: keep it tiny (cycle count + time in the cycle is the whole state)
  const st = { rng: createRng((spec.seed >>> 0) || 1), f, k: 0, time: (((phase % 1) + 1) % 1) * plan.cycle };
  const e = {
    id: spec.id, type: spec.type, spec, pattern: true,
    x: 0, z: 0, heading: 0, radius: CFG.WOLF_RADIUS,
    moving: false, tell: 0, speedNow: 0,
    route: spec.route, loop: !!spec.loop, cycleT: plan.cycle, cycleU: 0,
    _st: st, _plan: plan, _jitter: clamp(Number(spec.jitter) || 0, 0, MAX_JITTER), _cyc: null,
  };
  poseEnemy(e);
  return e;
}

function stepPatternEnemy(e, dt) {
  const st = e._st, cycle = e._plan.cycle;
  st.time += dt;
  if (st.time >= cycle) { const n = Math.floor(st.time / cycle); st.k += n; st.time -= n * cycle; }
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

// Network resync: full wolf state as plain data (the per-wolf RNG is stored as its integer state).
const PUBLIC_FIELDS = ['x', 'z', 'heading', 'moving', 'tell', 'speedNow'];

function serializeEnemies(enemies) {
  return enemies.map((e) => {
    const st = {};
    for (const k in e._st) if (k !== 'rng') st[k] = e._st[k];
    st.rngState = e._st.rng.getState();
    const o = { id: e.id, st };
    for (const k of PUBLIC_FIELDS) o[k] = e[k];
    return o;
  });
}

function applyEnemyState(enemies, data) {
  const byId = new Map(data.map((d) => [d.id, d]));
  for (const e of enemies) {
    const d = byId.get(e.id);
    if (!d) continue;
    const { rngState, ...st } = d.st;
    Object.assign(e._st, st);
    e._st.rng.setState(rngState);
    for (const k of PUBLIC_FIELDS) e[k] = d[k];
    if (e.pattern) poseEnemy(e);
  }
}

export { createEnemies, updateEnemies, nearestEnemyDist, serializeEnemies, applyEnemyState, isPattern, patternPose, buildPlan, cyclePlan, MAX_JITTER };
