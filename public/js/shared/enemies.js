import { CFG } from './config.js';
import { createRng, TAU } from './rng.js';

// Wolves: deterministic enemy behaviors. Pure (no THREE, no DOM).
//
// Each wolf lives in a straight corridor leg of the square spiral, in leg-local coordinates:
// `th` = distance along the leg, `r` = lateral offset (spec.frame maps them to world x/z).
// (The names r/th are kept from the old circular map: territory bounds are still a0..a1 / rIn..rOut.)
//
// Interpretation notes (contract ambiguities):
// - EnemySpec has no start position; the start position is derived from spec.phase + spec.seed.
// - Every enemy starts with a short phase-dependent pause (tell ramps up) so wolves crouch, then
//   go, and are out of sync with each other.
// - Patroller sub-range: legs longer than ~6 units may use a random sub-range (>=55% of the arc),
//   and the patrolled arc is capped at 24 units so a lap stays readable on huge rings.
// - Missing/invalid spec.r -> middle of [rIn,rOut]; rOut<rIn -> both collapse to the midpoint.
// - Private per-enemy state lives in enemy._st (includes an RNG closure: not serializable;
//   network clients should replicate x/z/heading/moving/tell rather than the internal state).
// - nearestEnemyDist returns Infinity when there are no enemies; distance is clamped at >= 0.


const EASE_T = 0.15;          // accel / decel time at move start / end (s)
const TURN_RATE_MOVE = 40;    // heading smoothing while moving (≈ exact after ease-in)
const TELL_WINDOW = 0.5;      // tell ramps over the last N seconds of a pause

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
  return Math.min(st.speed * mult, CFG.KITTY_SPEED * 0.85);
}

// Plans the next move target (st.nr, st.nth), the pause before it (st.pauseDur) and the leg speed.
// Randomness: variable pauses, per-leg speed, occasional dashes, patrollers that stop short and
// double back. The tell (crouch + glowing eyes during the pause) still telegraphs every move.
function planNext(e, initial) {
  const st = e._st;
  const rng = st.rng;
  switch (e.type) {
    case 'wanderer':
      pickWanderTarget(st);
      if (!initial) st.pauseDur = rng.chance(0.2) ? rng.range(0.12, 0.3) : rng.range(0.3, 1.1);
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
  // Higher levels: shorter rests (spec.pauseScale < 1), but always leave a brief readable tell.
  if (!initial) st.pauseDur = Math.max(0.12, st.pauseDur * st.pauseScale);
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
      st.amp = 2.5;                               // ~±2.5 units of random drift along the leg per sweep
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
    const win = Math.min(st.pauseDur, TELL_WINDOW);
    const x = win > 0 ? clamp((st.t - (st.pauseDur - win)) / win, 0, 1) : 1;
    e.tell = x * x * (3 - 2 * x);
    // keep facing the last direction while resting: wolves only turn as they set off
  }
  r = clamp(r, st.rIn, st.rOut);
  th = clamp(th, st.a0, st.a1);
  place(e, r, th);
}

// ---------------------------------------------------------------------------

function createEnemies(levelData) {
  const specs = (levelData && levelData.enemies) || [];
  const out = [];
  for (const spec of specs) out.push(createEnemy(spec));
  return out;
}

function updateEnemies(enemies, levelData, dt) {
  if (!(dt > 0)) return;
  for (let i = 0; i < enemies.length; i++) stepEnemy(enemies[i], dt);
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
  }
}

export { createEnemies, updateEnemies, nearestEnemyDist, serializeEnemies, applyEnemyState };
