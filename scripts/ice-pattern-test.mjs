// Skate-only playability check: an honest (NOT invulnerable) bot clears ice-mode levels with pattern wolves.
//
// How it works
// - Wolves in Skate only mode are pure functions of time, so from any moment the bot can predict them exactly:
//   it clones the relevant wolves (serializeEnemies/applyEnemyState) and steps them ahead with the real
//   updateEnemies, recording their positions tick by tick.
// - The kitty's own motion doesn't depend on time, so for every steering policy the bot simulates the kitty once
//   with the real stepSim (real ice physics, walls, pickups, checkpoints) on a wolf-free clone:
//   walk to a staging spot on the safe corner square, stand still, then launch and skate the next leg until it
//   stops on the next safe square (or reaches the goal).
// - It then scans launch times (every SCAN_STEP ticks) x policies against the predicted wolves and picks the
//   earliest launch window at least --window seconds wide (a human needs some timing slack), launching a little
//   into it. If there is none it takes the widest window; if no launch works at all within --maxwait it fails the leg.
// - The plan is then played out on the REAL sim (all wolves, hits on). A death is counted, the bot rewinds to its
//   arrival on the corner (as a player retrying would) and plans again without that policy; 3 deaths fail the level.
//
// Policies: lateral offset profiles relative to the path's centre line, followed by pure pursuit:
//   constant lanes, lane changes, weaves.
//
// Usage: node scripts/ice-pattern-test.mjs [--levels 1-5] [--seeds 5 | --seed 42] [--fake] [--verbose]
//          [--margin 0.1] [--window 0.25] [--maxwait 45] [--mode ice]
//   --fake  replaces each level's wolves with injected pattern specs (for testing the bot without real placement)
// With --strict: exit code 1 if any of levels 1-3 is not cleared for a tested seed. Without it the clears are only
// reported (Skate only rooms are currently built without a fairness solver; their balance is playtested), and only a
// crash fails the run.

import { createSim, stepSim } from '../public/js/shared/sim.js';
import { CFG } from '../public/js/shared/config.js';
import { createEnemies, serializeEnemies, applyEnemyState, updateEnemies } from '../public/js/shared/enemies.js';
import { createRng, hashSeed } from '../public/js/shared/rng.js';

// The bot plays like a human who has let go of the controls after each spawn / checkpoint gather
// (on ice the sim ignores input until it sees a release, see holdUntilRelease in sim.js).
function step(s, inputs) {
  for (const p of s.players) p.waitRelease = false;
  return stepSim(s, inputs, TICK);
}

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);
const [L0, L1] = String(arg('levels', '1-5')).split('-').map(Number);
const LEVELS = []; for (let l = L0; l <= (L1 || L0); l++) LEVELS.push(l);
const SEED_LIST = [1, 42, 1337, 9001, 31337, 777777, 2024, 5, 99, 123456];
const SEEDS = arg('seed', null) != null ? [arg('seed')] : SEED_LIST.slice(0, Math.max(1, Number(arg('seeds', 5))));
const FAKE = flag('fake');
const VERBOSE = flag('verbose');
const MODE = arg('mode', 'ice');
const MARGIN = Number(arg('margin', 0.1));            // extra clearance (units) the plan keeps from wolves
const MIN_WIN = Number(arg('window', 0.25));          // launch window a human can hit (s)
const MAX_WAIT = Number(arg('maxwait', 45));          // give up on a leg after waiting this long (s)
const WAIT_SMELL = 12;                                // waiting longer than this for a gap = design smell (s)
const MAX_DEATHS = 3;

const TICK = CFG.TICK;
const W = CFG.RING_WIDTH;
const HIT_R = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
const PLAN_R = HIT_R + MARGIN, PLAN_R2 = PLAN_R * PLAN_R;
const SCAN_STEP = 2;                                  // launch-time scan resolution (ticks)
const SCAN_CHUNK = Math.round(15 / TICK);             // scan this many ticks at a time
const SKILL_WIN = Math.round(20 / TICK);              // skill fraction measured over the first 20 s
const MAX_T = Math.round(30 / TICK);                  // max skate time for one leg
const LOOK = 3.0;                                     // pure-pursuit lookahead (units)
const ID = 1;

// ------------------------------------------------------------------ sim cloning
function cloneEnemies(list) {
  const c = createEnemies({ enemies: list.map((e) => e.spec) });
  applyEnemyState(c, serializeEnemies(list));
  return c;
}
function cloneSim(sim, enemies) {
  return {
    ...sim,
    players: sim.players.map((p) => ({ ...p })),
    items: sim.items.map((i) => ({ ...i })),
    circles: sim.circles.map((c) => ({ ...c })),
    enteredCenter: [...sim.enteredCenter],
    checkpointsHit: [...sim.checkpointsHit],
    stats: { ...sim.stats },
    enemies: enemies || cloneEnemies(sim.enemies),
  };
}

// ------------------------------------------------------------------ path geometry
function pathInfo(ld) {
  const P = ld.path;
  const cum = [0], dx = [], dz = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const L = Math.hypot(P[i + 1].x - P[i].x, P[i + 1].z - P[i].z) || 1e-9;
    dx.push((P[i + 1].x - P[i].x) / L); dz.push((P[i + 1].z - P[i].z) / L);
    cum.push(cum[i] + L);
  }
  const at = (s) => {
    let i = 0;
    if (s <= 0) i = 0; else if (s >= cum[cum.length - 1]) i = P.length - 2;
    else { let lo = 0, hi = P.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cum[m] <= s) lo = m; else hi = m - 1; } i = lo; }
    const u = Math.max(0, Math.min(s - cum[i], cum[i + 1] - cum[i]));
    return { x: P[i].x + dx[i] * u, z: P[i].z + dz[i] * u, nx: -dz[i], nz: dx[i], i };
  };
  const sOf = (x, z) => { // arc length of the nearest path vertex
    let b = 0, bd = Infinity;
    for (let i = 0; i < P.length; i++) { const d = Math.hypot(P[i].x - x, P[i].z - z); if (d < bd) { bd = d; b = i; } }
    return cum[b];
  };
  // progress of (x,z) projected on segments near index i0
  const project = (x, z, i0) => {
    let best = Infinity, bs = cum[i0], bi = i0;
    for (let i = Math.max(0, i0 - 1); i <= Math.min(P.length - 2, i0 + 6); i++) {
      const L = cum[i + 1] - cum[i];
      let u = (x - P[i].x) * dx[i] + (z - P[i].z) * dz[i];
      u = Math.max(0, Math.min(L, u));
      const d = Math.hypot(P[i].x + dx[i] * u - x, P[i].z + dz[i] * u - z);
      if (d < best) { best = d; bs = cum[i] + u; bi = i; }
    }
    return { s: bs, i: bi };
  };
  return { P, cum, at, sOf, project, total: cum[cum.length - 1] };
}

const inSquare = (c, x, z) => Math.abs(x - c.x) < W / 2 && Math.abs(z - c.z) < W / 2;

// ------------------------------------------------------------------ policies
const LANES = [-3.6, -1.8, 0, 1.8, 3.6];
function policies() {
  const out = [];
  for (const v of LANES) out.push({ name: `lane ${v}`, v: () => v });
  const ends = [-3.6, 0, 3.6];
  for (const a of ends) for (const b of ends) {
    if (a === b) continue;
    for (const f of [0.35, 0.65]) {
      out.push({ name: `shift ${a}>${b}@${f}`, v: (u, len) => { const k = Math.max(0, Math.min(1, (u - f) * len / 5 + 0.5)); return a + (b - a) * k * k * (3 - 2 * k); } });
    }
  }
  for (const ph of [0, Math.PI]) out.push({ name: `weave ${ph ? 'R' : 'L'}`, v: (u, len) => 3.2 * Math.sin(u * len / 14 * 2 * Math.PI + ph) });
  return out;
}

// segment geometry: from safe square k to square k+1 (or to the goal if k is the last safe square)
function segInfo(ld, pi, k) {
  const sc = ld.safeCorners;
  const s0 = pi.sOf(sc[k].x, sc[k].z);
  const last = k + 1 >= sc.length;
  const s1 = last ? pi.total : pi.sOf(sc[k + 1].x, sc[k + 1].z);
  return { k, s0, s1, len: s1 - s0, last, from: sc[k], to: last ? null : sc[k + 1] };
}

function vAt(pol, seg, s) {
  const u = (s - seg.s0) / seg.len;
  let v = pol.v(Math.max(0, Math.min(1, u)), seg.len);
  if (seg.last) v *= Math.max(0, Math.min(1, (seg.s1 - s - 8) / 8)); // centre up through the room door
  return v;
}

function stagingPoint(pi, seg, pol) {
  const s = seg.s0 + W / 2 - 1.5;
  const p = pi.at(s), v = vAt(pol, seg, seg.s0 + W / 2);
  return { x: p.x + p.nx * v, z: p.z + p.nz * v };
}

// walk to the staging spot on the safe square, then stand still (input 0 once settled)
function walkCtl(S) {
  let settled = false;
  return (p) => {
    if (settled) return { x: 0, z: 0 };
    const dx = S.x - p.x, dz = S.z - p.z, d = Math.hypot(dx, dz), sp = Math.hypot(p.vx, p.vz);
    if (d < 0.03 && sp < 1e-4) { settled = true; return { x: 0, z: 0 }; }
    let ix = dx * 3, iz = dz * 3; const m = Math.hypot(ix, iz); if (m > 1) { ix /= m; iz /= m; }
    return { x: ix, z: iz, settledNow: false };
  };
}
// skate: pure pursuit along the offset centre line; input 0 once on the target square
function skateCtl(pi, seg, pol) {
  let idx = pi.at(seg.s0).i;
  return (p) => {
    if (seg.to && inSquare(seg.to, p.x, p.z)) return { x: 0, z: 0 };
    const pr = pi.project(p.x, p.z, idx); idx = pr.i;
    const st = Math.min(seg.s1, pr.s + LOOK);
    const t = pi.at(st), v = vAt(pol, seg, st);
    const tx = t.x + t.nx * v - p.x, tz = t.z + t.nz * v - p.z, m = Math.hypot(tx, tz) || 1;
    return { x: tx / m, z: tz / m };
  };
}
const arrived = (seg, p) => seg.to && inSquare(seg.to, p.x, p.z) && Math.hypot(p.vx, p.vz) < 0.1;

// ------------------------------------------------------------------ planning
function label(spec) {
  return spec.pattern || spec.kind || spec.name || (spec.route ? `${spec.type}:${spec.loop ? 'loop' : 'pp'}${spec.route.length}` : spec.type);
}

function planSegment(sim, pi, seg, banned) {
  const pols = policies().filter((p) => !banned.has(p.name));
  // 1) kitty trajectories (wolf-free clone of the real sim)
  const trajs = [];
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  const grow = (x, z) => { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z; };
  for (const pol of pols) {
    const c = cloneSim(sim, []);
    const p = () => c.players[0];
    const wc = walkCtl(stagingPoint(pi, seg, pol));
    const WX = [], WZ = [];
    let w = 0;
    for (; w < 300; w++) {
      const inp = wc(p());
      if (inp.x === 0 && inp.z === 0) break;
      step(c, { [ID]: inp }); WX.push(p().x); WZ.push(p().z); grow(p().x, p().z);
    }
    const hold = { x: p().x, z: p().z };
    grow(hold.x, hold.z);
    const sc = skateCtl(pi, seg, pol);
    const KX = [], KZ = [];
    let ok = false;
    for (let t = 0; t < MAX_T; t++) {
      const ev = step(c, { [ID]: sc(p()) });
      KX.push(p().x); KZ.push(p().z); grow(p().x, p().z);
      if (seg.last ? ev.some((e) => e.type === 'levelClear') : arrived(seg, p())) { ok = true; break; }
    }
    if (ok) trajs.push({ pol, w, WX, WZ, hold, KX, KZ, T: KX.length });
  }
  if (!trajs.length) return { fail: 'no policy reaches the next square' };
  // 2) relevant wolves, predicted over the horizon
  const pad = PLAN_R + 1.0;
  const rel = sim.enemies.filter((e) => {
    const s = e.spec, f = s.frame;
    if (!f) return true;
    const pts = [];
    for (const th of [s.a0, s.a1]) for (const r of [s.rIn, s.rOut]) if (Number.isFinite(th) && Number.isFinite(r)) pts.push([r, th]);
    if (s.route) for (const q of s.route) pts.push([q.r, q.th]);
    if (!pts.length) return true;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [r, th] of pts) { const x = f.ox + f.ux * th + f.nx * r, z = f.oz + f.uz * th + f.nz * r; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    return x1 + pad > bx0 && x0 - pad < bx1 && z1 + pad > bz0 && z0 - pad < bz1;
  });
  const maxW = Math.max(...trajs.map((t) => t.w)), maxTT = Math.max(...trajs.map((t) => t.T));
  const scanEnd = Math.round(MAX_WAIT / TICK);
  const H = scanEnd + maxW + maxTT + 2;
  const nW = rel.length;
  const EX = [], EZ = [], box = [];
  const clones = cloneEnemies(rel);
  for (let w = 0; w < nW; w++) { EX.push(new Float64Array(H + 1)); EZ.push(new Float64Array(H + 1)); box.push([Infinity, -Infinity, Infinity, -Infinity]); }
  for (let j = 0; j <= H; j++) {
    if (j > 0) updateEnemies(clones, sim.levelData, TICK);
    for (let w = 0; w < nW; w++) {
      const x = clones[w].x, z = clones[w].z; EX[w][j] = x; EZ[w][j] = z;
      const b = box[w]; if (x < b[0]) b[0] = x; if (x > b[1]) b[1] = x; if (z < b[2]) b[2] = z; if (z > b[3]) b[3] = z;
    }
  }
  const near = (w, x, z) => { const b = box[w]; return x > b[0] - PLAN_R && x < b[1] + PLAN_R && z > b[2] - PLAN_R && z < b[3] + PLAN_R; };
  // 3) per trajectory: candidate wolves per tick, first unsafe pre-launch tick
  for (const tr of trajs) {
    tr.cand = [];
    for (let t = 0; t < tr.T; t++) { const l = []; for (let w = 0; w < nW; w++) if (near(w, tr.KX[t], tr.KZ[t])) l.push(w); tr.cand.push(l); }
    tr.firstBad = H + 1;
    const holdW = []; for (let w = 0; w < nW; w++) if (near(w, tr.hold.x, tr.hold.z)) holdW.push(w);
    for (let j = 1; j <= scanEnd + maxW && tr.firstBad > H; j++) {
      const x = j <= tr.w ? tr.WX[j - 1] : tr.hold.x, z = j <= tr.w ? tr.WZ[j - 1] : tr.hold.z;
      const list = j <= tr.w ? [...Array(nW).keys()] : holdW;
      for (const w of list) { const dx = x - EX[w][j], dz = z - EZ[w][j]; if (dx * dx + dz * dz < PLAN_R2) { tr.firstBad = j; break; } }
    }
  }
  // launch at offset j0 (steps 1..j0 pre-launch; step j0+t+1 is skate tick t). Returns blocking wolf or -1.
  const check = (tr, j0, step = 1) => {
    if (j0 < tr.w || j0 >= tr.firstBad) return -2;
    for (let t = 0; t < tr.T; t += step) {
      const l = tr.cand[t], j = j0 + t + 1, x = tr.KX[t], z = tr.KZ[t];
      for (let q = 0; q < l.length; q++) { const w = l[q]; const dx = x - EX[w][j], dz = z - EZ[w][j]; if (dx * dx + dz * dz < PLAN_R2) return w; }
    }
    return -1;
  };
  // 4) scan launch times
  const blockers = new Map();
  const ok = trajs.map(() => new Uint8Array(Math.ceil(scanEnd / SCAN_STEP) + 1));
  let skillAny = 0, skillN = 0;
  const skillPol = trajs.map(() => 0);
  let chosen = null;
  const runsOf = (ti, upto) => { // contiguous ok runs (in scan steps) for trajectory ti up to step index upto
    const a = ok[ti], runs = []; let st = -1;
    for (let q = 0; q <= upto; q++) { if (a[q] && st < 0) st = q; if ((!a[q] || q === upto) && st >= 0) { runs.push([st, a[q] ? q : q - 1]); st = -1; } }
    return runs;
  };
  const inSkill = (j0) => j0 >= maxW && j0 < maxW + SKILL_WIN;
  let scanned = -1;
  for (let chunk = 0; chunk * SCAN_CHUNK < scanEnd && !chosen; chunk++) {
    const qa = Math.ceil(chunk * SCAN_CHUNK / SCAN_STEP), qb = Math.min(Math.floor(scanEnd / SCAN_STEP), Math.floor((chunk + 1) * SCAN_CHUNK / SCAN_STEP) - 1);
    for (let q = qa; q <= qb; q++) {
      const j0 = q * SCAN_STEP; let any = false;
      for (let ti = 0; ti < trajs.length; ti++) {
        const b = check(trajs[ti], j0);
        if (b === -1) { ok[ti][q] = 1; any = true; if (inSkill(j0)) skillPol[ti]++; }
        else if (b >= 0) { const id = rel[b].id; blockers.set(id, (blockers.get(id) || 0) + 1); }
      }
      if (inSkill(j0)) { skillN++; if (any) skillAny++; }
    }
    scanned = qb;
    // earliest window >= MIN_WIN among policies (whole scan so far)
    if (scanned * SCAN_STEP >= Math.min(scanEnd, maxW + SKILL_WIN)) {
      let best = null;
      for (let ti = 0; ti < trajs.length; ti++) for (const [a, b] of runsOf(ti, scanned)) {
        if (b === scanned && scanned * SCAN_STEP < scanEnd - SCAN_STEP) continue; // may continue in the next chunk
        const width = (b - a + 1) * SCAN_STEP;
        if (width * TICK + 1e-9 < MIN_WIN) continue;
        if (!best || a < best.a || (a === best.a && width > best.width)) best = { ti, a, b, width };
      }
      if (best) chosen = best;
    }
  }
  if (!chosen) { // widest window of any size
    for (let ti = 0; ti < trajs.length; ti++) for (const [a, b] of runsOf(ti, scanned)) {
      const width = (b - a + 1) * SCAN_STEP;
      if (!chosen || width > chosen.width) chosen = { ti, a, b, width };
    }
  }
  const top = [...blockers.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id]) => {
    const e = sim.enemies.find((q) => q.id === id); return `#${id} ${label(e.spec)}(leg ${e.spec.leg})`;
  });
  const skill = { any: skillN ? skillAny / skillN : 0, bestPol: skillN ? Math.max(...skillPol) / skillN : 0 };
  if (!chosen) return { fail: `no gap within ${MAX_WAIT}s`, blockers: top, skill };
  // launch a little into the window (or its middle if short), verified tick by tick
  const tr = trajs[chosen.ti];
  const start = chosen.a * SCAN_STEP, end = chosen.b * SCAN_STEP;
  let j0 = Math.min(start + Math.round(0.4 / TICK), Math.round((start + end) / 2));
  if (check(tr, j0) !== -1) { j0 = -1; for (let q = start; q <= end; q++) if (check(tr, q) === -1) { j0 = q; break; } }
  if (j0 < 0) return { fail: 'window vanished on tick check', blockers: top, skill };
  // clearance of the chosen plan
  let minClear = Infinity;
  for (let t = 0; t < tr.T; t++) for (const w of tr.cand[t]) minClear = Math.min(minClear, Math.hypot(tr.KX[t] - EX[w][j0 + t + 1], tr.KZ[t] - EZ[w][j0 + t + 1]) - HIT_R);
  return { pol: tr.pol, j0, T: tr.T, window: chosen.width * TICK, skill, blockers: top, minClear, nWolves: nW };
}

// ------------------------------------------------------------------ fake pattern placement (--fake)
function injectFake(sim) {
  const ld = sim.levelData, L = sim.level;
  const rng = createRng(hashSeed(sim.seed, L, 'fake'));
  const m = CFG.WALL_THICKNESS / 2 + CFG.WOLF_RADIUS + 0.06, vIn = -W / 2 + m, vOut = W / 2 - m;
  const specs = [];
  const last = ld.legs.length - 1;
  ld.legs.forEach((leg, li) => {
    const frame = { ox: leg.ox, oz: leg.oz, ux: leg.ux, uz: leg.uz, nx: leg.nx, nz: leg.nz };
    let lo = W / 2 + 0.6 + CFG.WOLF_RADIUS + 3, hi = leg.len - lo;
    if (li === 0) hi = leg.len - W / 2 - CFG.START_SAFE_ARC - CFG.WOLF_RADIUS - 3;
    if (li === last - 1) lo = 2;            // its s=0 end is the unsafe corner of the final stretch
    if (li === last) { lo = 2; hi = leg.len - 2; }
    const spd = Math.min(CFG.KITTY_SPEED * 0.85, 3.8 + 0.25 * L);
    for (let c = lo; c <= hi; c += 13) {
      const kind = ['crosser', 'charger', 'diagonal', 'looper'][Math.floor(rng.next() * 4)];
      let route, loop = false;
      if (kind === 'crosser') route = [{ r: vIn, th: c }, { r: vOut, th: c }];
      else if (kind === 'charger') { const r = rng.range(-2.5, 2.5); route = [{ r, th: c - 4 }, { r, th: c + 4 }]; }
      else if (kind === 'diagonal') route = [{ r: vIn, th: c - 3 }, { r: vOut, th: c + 3 }];
      else { route = [{ r: -3, th: c - 2.5 }, { r: 3, th: c - 2.5 }, { r: 3, th: c + 2.5 }, { r: -3, th: c + 2.5 }]; loop = true; }
      const id = specs.length;
      specs.push({
        id, type: 'wanderer', pattern: kind, leg: li, frame, route, loop, speed: spd, phase: rng.next(),
        rIn: Math.min(...route.map((q) => q.r)), rOut: Math.max(...route.map((q) => q.r)),
        a0: Math.min(...route.map((q) => q.th)), a1: Math.max(...route.map((q) => q.th)),
        seed: hashSeed(sim.seed, L, 'fakewolf', id),
      });
    }
  });
  ld.enemies = specs;
  sim.enemies = createEnemies(ld);
}

// ------------------------------------------------------------------ run one level
function runLevel(seed, level) {
  let sim = createSim({ seed, players: [{ id: ID, name: 'bot', color: 0 }], startLevel: level, mode: MODE });
  if (FAKE) injectFake(sim);
  const ld = sim.levelData;
  const pi = pathInfo(ld);
  const nPattern = sim.enemies.filter((e) => e.pattern).length;
  const res = { seed, level, cleared: false, time: 0, deaths: 0, maxWait: 0, maxWaitLeg: -1, fail: null, legs: [], wolves: sim.enemies.length, pattern: nPattern };
  const nSeg = ld.safeCorners.length;
  for (let k = 0; k < nSeg; k++) {
    const seg = segInfo(ld, pi, k);
    const snap = cloneSim(sim);
    const banned = new Set();
    const arriveT = sim.levelTime;
    let done = false;
    while (!done) {
      const plan = planSegment(sim, pi, seg, banned);
      if (plan.fail) {
        res.fail = { leg: k, why: plan.fail, wolves: plan.blockers || [] };
        res.legs.push({ leg: k, fail: plan.fail, skill: plan.skill });
        if (VERBOSE) console.log(`  seed ${seed} L${level} leg ${k}: FAIL ${plan.fail}; blockers ${(plan.blockers || []).join(', ')}`);
        return finish(res, sim);
      }
      // play it out on the real sim
      const wc = walkCtl(stagingPoint(pi, seg, plan.pol));
      const sc = skateCtl(pi, seg, plan.pol);
      let died = null, reached = false;
      for (let j = 0; j < plan.j0 + MAX_T && !died && !reached; j++) {
        const p = sim.players[0];
        const inp = j < plan.j0 ? wc(p) : sc(p);
        const ev = step(sim, { [ID]: inp });
        const d = ev.find((e) => e.type === 'death');
        if (d) died = d;
        if (seg.last ? ev.some((e) => e.type === 'levelClear') : j >= plan.j0 && arrived(seg, sim.players[0])) reached = true;
      }
      const wait = plan.j0 * TICK;
      if (VERBOSE) console.log(`  seed ${seed} L${level} leg ${k}: ${plan.pol.name.padEnd(18)} wait ${wait.toFixed(2)}s window ${plan.window.toFixed(2)}s skill any ${(plan.skill.any * 100).toFixed(0)}% best ${(plan.skill.bestPol * 100).toFixed(0)}% clear ${plan.minClear.toFixed(2)} wolves ${plan.nWolves}${plan.skill.bestPol < 0.15 ? '  blockers: ' + plan.blockers.join(', ') : ''}${died ? '  DIED' : ''}${!died && !reached ? '  STUCK' : ''}`);
      if (died) {
        res.deaths++;
        const e = sim.enemies.find((q) => q.id === died.enemyId);
        (res.deathInfo = res.deathInfo || []).push(`leg ${k} by #${died.enemyId} ${e ? label(e.spec) : '?'}`);
        if (res.deaths >= MAX_DEATHS) { res.fail = { leg: k, why: 'died', wolves: [res.deathInfo.at(-1)] }; return finish(res, sim); }
        sim = cloneSim(snap); banned.add(plan.pol.name);
        continue;
      }
      if (!reached) { res.fail = { leg: k, why: 'did not arrive', wolves: [] }; return finish(res, sim); }
      const totalWait = sim.levelTime - arriveT - plan.T * TICK;
      if (totalWait > res.maxWait) { res.maxWait = totalWait; res.maxWaitLeg = k; }
      res.legs.push({ leg: k, wait: totalWait, window: plan.window, skill: plan.skill, pol: plan.pol.name, clear: plan.minClear });
      done = true;
    }
  }
  res.cleared = sim.state === 'levelclear';
  return finish(res, sim);
}
function finish(res, sim) { res.time = sim.levelTime; return res; }

// ------------------------------------------------------------------ main
const t0 = Date.now();
console.log(`ice-pattern-test: mode ${MODE}${FAKE ? ' (FAKE pattern wolves)' : ''}, levels ${LEVELS.join(',')}, seeds ${SEEDS.join(',')}, margin ${MARGIN}, min window ${MIN_WIN}s, maxwait ${MAX_WAIT}s`);
const rows = [];
let bad = false;
for (const seed of SEEDS) {
  for (const level of LEVELS) {
    const r = runLevel(seed, level);
    rows.push(r);
    if (!r.cleared && level <= 3) bad = true;
    const legs = r.legs.filter((l) => l.skill);
    const minWin = Math.min(...r.legs.filter((l) => l.window != null).map((l) => l.window));
    const minSkill = legs.length ? legs.reduce((m, l) => (l.skill.bestPol < m.skill.bestPol ? l : m)) : null;
    const smells = [];
    if (r.maxWait > WAIT_SMELL) smells.push(`long wait ${r.maxWait.toFixed(1)}s @leg ${r.maxWaitLeg}`);
    const tight = r.legs.filter((l) => l.window != null && l.window < MIN_WIN).map((l) => l.leg);
    if (tight.length) smells.push(`tight window legs ${tight.join(',')}`);
    const lowSkill = r.legs.filter((l) => l.skill && l.skill.bestPol < 0.15).map((l) => l.leg);
    if (lowSkill.length) smells.push(`<15% launchable legs ${lowSkill.join(',')}`);
    console.log(
      `seed ${String(seed).padEnd(7)} L${level}  ${r.cleared ? 'CLEAR' : 'FAIL '}  t ${r.time.toFixed(1).padStart(6)}s  deaths ${r.deaths}  maxWait ${r.maxWait.toFixed(1).padStart(5)}s(leg ${r.maxWaitLeg})` +
      `  minWin ${Number.isFinite(minWin) ? minWin.toFixed(2) : '-'}s  minSkill ${minSkill ? (minSkill.skill.bestPol * 100).toFixed(0) + '%(leg ' + minSkill.leg + ')' : '-'}` +
      `  wolves ${r.wolves}/${r.pattern} pattern` +
      (r.fail ? `  -> leg ${r.fail.leg}: ${r.fail.why}${r.fail.wolves.length ? ' [' + r.fail.wolves.join('; ') + ']' : ''}` : '') +
      (r.deathInfo ? `  deaths: ${r.deathInfo.join('; ')}` : '') +
      (smells.length ? `  SMELL: ${smells.join('; ')}` : ''));
  }
}
// per-level summary
console.log('\nskill = fraction of launch times (20 s after settling) that get through: any = some policy works, best = the single best policy\nlevel  cleared  avgTime  deaths  worstWait  skill any avg/worst  skill best avg/worst');
for (const level of LEVELS) {
  const rs = rows.filter((r) => r.level === level);
  const cl = rs.filter((r) => r.cleared);
  const legs = rs.flatMap((r) => r.legs.filter((l) => l.skill));
  const avgSkill = legs.length ? legs.reduce((a, l) => a + l.skill.any, 0) / legs.length : 0;
  const worst = legs.length ? Math.min(...legs.map((l) => l.skill.any)) : 0;
  const avgB = legs.length ? legs.reduce((a, l) => a + l.skill.bestPol, 0) / legs.length : 0;
  const worstB = legs.length ? Math.min(...legs.map((l) => l.skill.bestPol)) : 0;
  console.log(`L${level}     ${cl.length}/${rs.length}      ${cl.length ? (cl.reduce((a, r) => a + r.time, 0) / cl.length).toFixed(1).padStart(6) : '     -'}s  ${rs.reduce((a, r) => a + r.deaths, 0)}       ${Math.max(...rs.map((r) => r.maxWait)).toFixed(1).padStart(5)}s     ${(avgSkill * 100).toFixed(0).padStart(3)}% / ${(worst * 100).toFixed(0).padStart(3)}%          ${(avgB * 100).toFixed(0).padStart(3)}% / ${(worstB * 100).toFixed(0).padStart(3)}%`);
}
const strict = flag('strict');
console.log(`\n${bad ? (strict ? 'FAIL' : 'NOTE') : 'PASS'} (levels 1-3 ${bad ? 'not all cleared' : 'all cleared'}${bad && !strict ? '; report only, --strict to fail' : ''})  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exitCode = bad && strict ? 1 : 0;
