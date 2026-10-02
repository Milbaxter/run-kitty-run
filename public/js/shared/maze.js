import { CFG, levelParams } from './config.js';
import { createRng, hashSeed } from './rng.js';
import { buildPlan, patternPose, cyclePlan, MAX_JITTER } from './enemies.js';

// Square-spiral level generation + collision. Pure (no THREE, no DOM).
//
// The map is one continuous wall that spirals outward from a square goal room in the middle,
// plus a short cap that closes the outer end. Between consecutive loops of the wall runs a single
// corridor (CFG.RING_WIDTH wide) from the start pocket in the outer corner all the way to the room:
// straight legs joined by 90-degree corners. No choices, no dead ends.
// The wall layout is identical on every level; only wolves/items vary by level + seed.
//
// LevelData:
//   walls / wallSegments: [{ax,az,bx,bz}] wall centerlines (thickness CFG.WALL_THICKNESS)
//   wallCorners: [{x,z}] outer corners of the spiral (for lanterns)
//   legs: corridor legs, each a straight frame { ox,oz (start corner center), ux,uz (along),
//         nx,nz (toward the inner side), len, loop } — wolves live in leg-local coordinates
//   corners: [{x,z}] corridor corner centers along the path
//   centerRadius: radius of the glowing goal disc; roomHalf: half-size of the square goal room
//   outerRadius: half-extent of the whole map (max |x|,|z| of any wall)

const HALF_T = CFG.WALL_THICKNESS / 2;
const WOLF_MARGIN = HALF_T + CFG.WOLF_RADIUS + 0.06;
const CORNER_REST = 0.6;          // extra wolf-free distance past each corner square
const GRID_CELL = 2.0;
const GRID_MAX_R = 1.0;           // grid query valid for radii up to this; larger -> brute force

// Arm directions in order: left, up (-z, away from camera), right, down (+z, toward camera).
const DIRS = [[-1, 0], [0, -1], [1, 0], [0, 1]];
const ARMS = 19;                  // spiral wall arms; path ~845 units with 10.8-wide lanes
const ROOM = 8;                   // goal room half-size
const ICE_THEME = 2;              // Snowy Peaks
const TREE_THEME = 1;             // Autumn Grove: one climbable tree per lane
const ICE_RAMP = 0.3;              // ice levels: how much of the usual toward-the-goal difficulty ramp applies
const SPRING_THEME = 4;
// Seasons: summer meadow, autumn (climbable trees), winter (the ice rink), spring blossom, repeat.
// (Theme 3, the neon night garden, is out of the rotation.)
const THEME_ORDER = [0, TREE_THEME, ICE_THEME, SPRING_THEME];

// The 8 rotations/reflections of the plane; the spiral is mapped by the one that puts the start
// in the top-left corner with the run going clockwise on screen (first step: to the right).
const SYMS = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0], [-1, 0, 0, 1], [1, 0, 0, -1], [0, 1, 1, 0], [0, -1, -1, 0]];

function pickWeighted(rng, items, weightFn) {
  let total = 0;
  for (const it of items) total += Math.max(0, weightFn(it));
  if (total <= 0) return items[Math.floor(rng.next() * items.length)];
  let t = rng.next() * total;
  for (const it of items) {
    t -= Math.max(0, weightFn(it));
    if (t <= 0) return it;
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------- geometry

// Outward square spiral. Horizontal arms grow (2R-W, 2R, 2R+W...), vertical arms (2R, 2R+W, ...),
// so parallel arms are exactly W apart and the first loop encloses a 2R x 2R room.
function buildSpiral() {
  const W = CFG.RING_WIDTH;
  const v = [{ x: ROOM - W, z: ROOM }];             // first loop encloses the room [-ROOM, ROOM]^2
  for (let i = 0; i < ARMS; i++) {
    const L = (i % 2 === 0 ? 2 * ROOM - W : 2 * ROOM) + Math.floor(i / 2) * W;
    const [dx, dz] = DIRS[i % 4];
    v.push({ x: v[i].x + dx * L, z: v[i].z + dz * L });
  }
  const walls = [];
  for (let i = 0; i < ARMS; i++) walls.push({ ax: v[i].x, az: v[i].z, bx: v[i + 1].x, bz: v[i + 1].z });
  // cap: close the outer end of the corridor (back wall of the start pocket)
  const [d1x, d1z] = DIRS[ARMS % 4], [d2x, d2z] = DIRS[(ARMS + 1) % 4];
  const e = v[ARMS];
  const k = { x: e.x + d1x * W, z: e.z + d1z * W };
  walls.push({ ax: e.x, az: e.z, bx: k.x, bz: k.z });
  walls.push({ ax: k.x, az: k.z, bx: k.x + d2x * W, bz: k.z + d2z * W });

  // corridor corner centers: c_i = v_i + W/2 (d_i + d_{i+1})
  const c = (i) => {
    const [ax, az] = DIRS[i % 4], [bx, bz] = DIRS[(i + 1) % 4];
    return { x: v[i].x + (W / 2) * (ax + bx), z: v[i].z + (W / 2) * (az + bz) };
  };
  // legs from the outside in: leg along arm i runs between c_i and c_{i+1}
  const legs = [];
  for (let i = ARMS - 1; i >= 4; i--) {
    const a = c(i), b = c(i + 1);
    const [ux, uz] = DIRS[i % 4], [nx, nz] = DIRS[(i + 1) % 4];
    legs.push({ arm: i, ox: a.x, oz: a.z, ux, uz, nx, nz, len: Math.hypot(b.x - a.x, b.z - a.z), loop: Math.floor((i - 4) / 4) });
  }
  const corners = [];
  for (let i = ARMS; i >= 4; i--) corners.push(c(i));

  // orient: start top-left (x<0, z<0), first step heading +x
  const start = corners[0], fdx = -legs[0].ux, fdz = -legs[0].uz;
  const [a, b, cc, d] = SYMS.find(([a, b, c, d]) =>
    a * start.x + b * start.z < 0 && c * start.x + d * start.z < 0 && a * fdx + b * fdz === 1 && c * fdx + d * fdz === 0);
  const tx = (x, z) => a * x + b * z, tz = (x, z) => cc * x + d * z;
  const tp = (p) => ({ x: tx(p.x, p.z), z: tz(p.x, p.z) });
  for (const w of walls) {
    const A = tp({ x: w.ax, z: w.az }), B = tp({ x: w.bx, z: w.bz });
    w.ax = A.x; w.az = A.z; w.bx = B.x; w.bz = B.z;
  }
  for (const l of legs) {
    [l.ox, l.oz, l.ux, l.uz, l.nx, l.nz] = [tx(l.ox, l.oz), tz(l.ox, l.oz), tx(l.ux, l.uz), tz(l.ux, l.uz), tx(l.nx, l.nz), tz(l.nx, l.nz)];
  }
  for (let k = 0; k < corners.length; k++) corners[k] = tp(corners[k]);
  for (let k = 0; k < v.length; k++) v[k] = tp(v[k]);
  let ext = 0;
  for (const w of walls) ext = Math.max(ext, Math.abs(w.ax), Math.abs(w.az), Math.abs(w.bx), Math.abs(w.bz));
  return { walls, legs, corners, wallCorners: v.slice(4), outer: ext };
}

function buildPath(corners, legs) {
  const W = CFG.RING_WIDTH;
  const pts = [];
  const STEP = 2.0;
  const pushTo = (x, z) => {
    const l = pts[pts.length - 1];
    if (!l) { pts.push({ x, z }); return; }
    const L = Math.hypot(x - l.x, z - l.z);
    if (L < 1e-6) return;
    const n = Math.max(1, Math.ceil(L / STEP));
    for (let k = 1; k <= n; k++) pts.push({ x: l.x + (x - l.x) * k / n, z: l.z + (z - l.z) * k / n });
  };
  for (const c of corners) pushTo(c.x, c.z);
  // last corner sits just outside the room opening: step in, then to the middle
  const last = corners[corners.length - 1];
  const { nx, nz } = legs[legs.length - 1];       // innermost leg: its inner side is the room
  pushTo(last.x + nx * W, last.z + nz * W);
  pushTo(0, 0);
  return pts;
}

// ---------------------------------------------------------------- placement

function placeEnemies(rng, lvl, p) {
  const { legs, seed, level } = lvl;
  const W = CFG.RING_WIDTH;
  const enemies = [];
  const count = p.enemyCount;
  const vIn = -W / 2 + WOLF_MARGIN, vOut = W / 2 - WOLF_MARGIN;
  // usable s-range per leg: skip both corner squares (+ a little rest), and the start pocket
  const last = legs.length - 1;
  const ranges = legs.map((leg, li) => {
    let lo = W / 2 + CORNER_REST + CFG.WOLF_RADIUS;
    let hi = leg.len - W / 2 - CORNER_REST - CFG.WOLF_RADIUS;
    // final stretch: neither of its corners is safe (wolves roam from its first corner to the goal room's door)
    if (li === last) { lo = -W / 2 + WOLF_MARGIN; hi = leg.len + W / 2 - WOLF_MARGIN; }
    if (li === 0) hi = leg.len - W / 2 - CFG.START_SAFE_ARC - CFG.WOLF_RADIUS; // start leg: c_M is the start
    return { lo, hi: Math.max(lo, hi) };
  });
  // 0 at the start leg -> 1 at the innermost leg: wolves get denser, faster and restless toward the middle
  // (ice levels ramp much more gently: skating is hard enough)
  const ramp = lvl.ice ? ICE_RAMP : 1;
  const depth = (li) => ramp * li / Math.max(1, legs.length - 1);
  const lens = ranges.map((r, li) => Math.max(0, r.hi - r.lo) * (0.55 + 1.1 * depth(li)) * (li === last ? 0.95 : 1));
  const total = lens.reduce((a, b) => a + b, 0);
  const quota = lens.map((L) => Math.floor(L / total * count));
  const fracs = lens.map((L, i) => ({ i, f: L / total * count - quota[i] })).sort((a, b) => b.f - a.f);
  let left = count - quota.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0; k++, left--) quota[fracs[k % fracs.length].i]++;
  const spanScale = 1 + Math.min(1, 0.1 * (level - 1));   // territories grow with level

  legs.forEach((leg, li) => {
    const m = quota[li];
    const { lo: R0, hi: R1 } = ranges[li];
    if (m <= 0 || R1 - R0 < 1) return;
    const frame = { ox: leg.ox, oz: leg.oz, ux: leg.ux, uz: leg.uz, nx: leg.nx, nz: leg.nz };
    const dk = depth(li);
    const off = rng.next();
    for (let k = 0; k < m; k++) {
      const t = (k + off * 0.6 + 0.2) / m;
      const cs = R0 + (R1 - R0) * Math.min(0.999, t) + rng.range(-0.15, 0.15) / m * (R1 - R0);
      const type = rng.pick(p.enemyTypes);
      let lo, hi;
      if (type === 'orbiter') { lo = R0; hi = R1; }          // runs the whole leg
      else {
        const span = spanScale * (1 + 0.4 * dk) * (type === 'patroller' ? rng.range(8, 18) : type === 'wanderer' ? rng.range(10, 20) : rng.range(2, 5));
        lo = Math.max(R0, cs - span / 2); hi = Math.min(R1, cs + span / 2);
      }
      if (hi - lo < (type === 'sweeper' ? 0.5 : 2.5)) continue;
      const id = enemies.length;
      const spec = {
        id, type, leg: li, frame,
        rIn: vIn, rOut: vOut, a0: lo, a1: hi,
        speed: Math.min(CFG.KITTY_SPEED * 0.92, p.enemySpeed * (0.9 + 0.2 * dk) * rng.range(0.9, 1.1)) * (type === 'orbiter' ? 0.8 : type === 'sweeper' ? 0.9 : 1),
        phase: rng.next(),
        pauseScale: p.enemyPauseScale * (1.15 - 0.45 * dk),
        seed: hashSeed(seed, level, 'wolf', id),
      };
      if (type === 'patroller' || type === 'orbiter') spec.r = rng.range(vIn + 0.2, vOut - 0.2);
      if (type === 'orbiter') spec.dir = rng.chance(0.5) ? 1 : -1;
      if (type === 'sweeper') spec.angle = (lo + hi) / 2;
      enemies.push(spec);
    }
  });
  return enemies;
}

// ---------------------------------------------------------------- pattern wolves (Skate only mode)
//
// In Skate only (mode 'ice') wolves don't wander: each walks a fixed route at a fixed rhythm (see the
// pattern section of enemies.js), so a leg is a "room" the kitty studies from the safe corner square and
// then skates through in one go (it can't stop on ice).
//
// Every wolf runs end to end, holding a moment at each end:
//   charger    runs the whole leg in a fixed lane, from the edge of one safe square to the next and back. Charger
//              lanes are solver lanes, so the lanes between them stay open; they own their lane all the time
//              (go beside them) and keep their own rhythm.
//   crosser    crosses the lane wall to wall, in rows (crosswalk: single / wave / comb / ripple / anti offsets)
//   diagonal   crosses wall to wall at an angle (swing, scissors = two crossing half a beat apart, fan)
// A leg = a set of charger lanes + crosser / diagonal segments top (entry, high th) to bottom. Every crosser
// and diagonal in a leg shares the leg's beat T (its cycle is T, T/2 or T/3), so the room repeats every T
// seconds (up to the hold jitter, spec.jitter). Each segment's timing offset is chosen by a launch-window solver
// (solveLeg): a kitty skating straight down a free lane (one of PAT_LANES) at full speed, leaving the corner at
// the right moment, gets through the whole leg with spare clearance, also with 1-4 pairs of speed boots, and
// the lane stays open for a fair share of the beat. Segments that would (nearly) close the room fall back to a
// single crosser or are dropped: never an impossible wall. mazeSelfTest replays each leg's solution against
// the real jittered wolves (a gap at least every 10 s).
// Level 1's first legs ease in (PAT_LESSONS); difficulty D = levelParams().patternHeat + 0.5 * depth drives
// wolf speed, holds, density, charger lanes, variants and the launch-window targets.

const PAT_HIT = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
const PAT_SAFE = PAT_HIT + 0.3;               // solver clearance (spare room for imperfect skating)
const PAT_LANES = [-3.6, -1.8, 0, 1.8, 3.6];   // solver lanes: center, middles, near the walls (hugging a wall on ice is no fun)
const PAT_BIN = 1 / 40;                       // solver time resolution (s); beats are multiples of 0.25 s
const PAT_HZ = 120;                           // pose table rate
const PAT_VK = CFG.KITTY_SPEED;               // skating speed the rooms are designed for
const PAT_VMAX = CFG.KITTY_SPEED * 0.9;
const PAT_HARD = 0.3;                         // never accept a leg whose launch window is shorter (s)
const PAT_FRAC_MIN = 0.07;                    // ...or whose best lane is open for less of the beat
const PAT_BOOSTS = [1.05, 1.1, 1.15, 1.2];    // rooms must also stay passable with 1-4 pairs of speed boots
const PAT_TYPES = ['charger', 'crosser', 'diagonal'];
const NO_FRAME = { ox: 0, oz: 0, ux: 1, uz: 0, nx: 0, nz: 1 };

function usableRanges(legs) {
  const W = CFG.RING_WIDTH, last = legs.length - 1;
  return legs.map((leg, li) => {
    let lo = W / 2 + CORNER_REST + CFG.WOLF_RADIUS;
    let hi = leg.len - W / 2 - CORNER_REST - CFG.WOLF_RADIUS;
    if (li === last) { lo = -W / 2 + WOLF_MARGIN; hi = leg.len + W / 2 - WOLF_MARGIN; }
    if (li === 0) hi = leg.len - W / 2 - CFG.START_SAFE_ARC - CFG.WOLF_RADIUS;
    return { lo, hi: Math.max(lo, hi) };
  });
}

// --- pattern library. Every wolf runs end to end: crossers / diagonals go wall to wall, chargers run the whole
// leg between the two safe squares (edge to edge), holding a moment at each end.
// Segment builders return { name, depth, wolves } with th in [0, depth] (depth = the end the kitty meets first);
// wolf: { type, route: [{r, th}], loop, offT (fraction of its own cycle), offS (s), vMul }. c = { D, rng, vOut }.

function segCrosswalk(c, o = {}) {
  const { rng, vOut } = c;
  let sp = rng.range(2.7, 3.6);
  const k = o.k || Math.max(1, Math.min(4, 1 + Math.floor(c.D * 2.5 + rng.next() * 1.2), 1 + Math.floor((o.room ?? 99) / sp)));
  if (k === 1) sp = 0;
  const variant = o.variant || (k === 1 ? 'single' : c.D < 0.3 ? 'wave' : rng.pick(c.D < 0.9 ? ['wave', 'comb', 'ripple', 'anti', 'comb', 'wave'] : ['wave', 'comb', 'ripple', 'anti', 'comb', 'anti']));
  const side = rng.chance(0.5) ? 1 : -1;
  const wolves = [];
  for (let i = 0; i < k; i++) {
    const s = variant === 'comb' && i % 2 ? -side : side;
    const th = (k - 1 - i) * sp;
    const w = { type: 'crosser', route: [{ r: -s * vOut, th }, { r: s * vOut, th }], offT: 0, offS: 0 };
    if (variant === 'wave') w.offS = -i * sp / PAT_VK;          // a kitty in one lane meets every crosser in the same state
    else if (variant === 'anti') w.offS = i * sp / PAT_VK;      // ...or each one a little further along
    else if (variant === 'ripple') w.offT = i * 0.2;            // a ripple you can see travelling down the row
    wolves.push(w);
  }
  return { name: 'crosswalk-' + variant, depth: (k - 1) * sp, wolves };
}

// diagonals: wall to wall at an angle. swing = one; scissors = two crossing half a beat apart; fan = parallel swings
function segDiagonal(c, o = {}) {
  const { rng, vOut } = c;
  const variant = o.variant || rng.pick(c.D < 0.6 || (o.room ?? 99) < 10 ? ['swing', 'scissors'] : ['swing', 'scissors', 'fan']);
  const s = rng.chance(0.5) ? 1 : -1, A = -s * vOut, B = s * vOut;
  const d = rng.range(4, 6);
  let wolves, depth = d;
  if (variant === 'scissors') {
    wolves = [
      { type: 'diagonal', route: [{ r: A, th: 0 }, { r: B, th: d }], offT: 0, offS: 0 },
      { type: 'diagonal', route: [{ r: B, th: 0 }, { r: A, th: d }], offT: 0.5, offS: 0 },
    ];
  } else if (variant === 'fan') {
    const sp = rng.range(2.8, 3.4);
    depth = d + sp;
    wolves = [0, 1].map((i) => ({ type: 'diagonal', route: [{ r: A, th: i * sp }, { r: B, th: d + i * sp }], offT: 0, offS: -(1 - i) * sp / PAT_VK }));
  } else wolves = [{ type: 'diagonal', route: [{ r: A, th: 0 }, { r: B, th: d }], offT: 0, offS: 0 }];
  return { name: 'diagonal-' + variant, depth, wolves };
}

const PAT_FAMILIES = { crosswalk: segCrosswalk, diagonal: segDiagonal };

// Level 1 eases in: two legs of plain crossers, then the first charger lane; after that it's the real thing.
// Each lesson: [chargers (lanes) or null = random, segments to cycle through]
const PAT_LESSONS = [
  [[], [['crosswalk', { k: 1 }]]],
  [[], [['crosswalk', { k: 2, variant: 'wave' }], ['crosswalk', { k: 1 }]]],
  [[0], [['crosswalk', { k: 1 }], ['crosswalk', { k: 2, variant: 'comb' }]]],
];

// --- timing helpers

// Sets per-waypoint holds so the wolf's cycle is exactly Tw; builds its pose table.
function patTime(w, Tw) {
  const n = w.route.length, segs = w.loop ? n : 2 * (n - 1);
  const zero = buildPlan({ route: w.route.map((q) => ({ r: q.r, th: q.th, hold: 0 })), loop: w.loop }, NO_FRAME, w.speed);
  let sumW = 0;
  for (let s = 0; s < segs; s++) sumW += w.w ? w.w[w.loop ? s : s < n - 1 ? s : 2 * (n - 1) - s] : 1;
  const unit = (Tw - zero.cycle) / sumW;
  w.route = w.route.map((q, i) => ({ r: q.r, th: q.th, hold: Math.round(unit * (w.w ? w.w[i] : 1) * 1e6) / 1e6 }));
  const plan = buildPlan({ route: w.route, loop: w.loop }, NO_FRAME, w.speed);
  w.cycle = plan.cycle;
  const m = Math.ceil(plan.cycle * PAT_HZ) + 1;
  w.tr = new Float64Array(m); w.tth = new Float64Array(m);
  for (let i = 0; i < m; i++) { const p = patternPose(plan, Math.min(i / PAT_HZ, plan.cycle - 1e-9)); w.tr[i] = p.r; w.tth[i] = p.th; }
}

// natural cycle: moving time + base holds
function patNatural(w, h) {
  const zero = buildPlan({ route: w.route.map((q) => ({ r: q.r, th: q.th, hold: 0 })), loop: w.loop }, NO_FRAME, w.speed);
  const n = w.route.length, segs = w.loop ? n : 2 * (n - 1);
  let sumW = 0;
  for (let s = 0; s < segs; s++) sumW += w.w ? w.w[w.loop ? s : s < n - 1 ? s : 2 * (n - 1) - s] : 1;
  return { move: zero.cycle, nat: zero.cycle + h * sumW };
}

function patPoseIdx(w, t) {
  let tc = (t + w.off) % w.cycle;
  if (tc < 0) tc += w.cycle;
  return Math.min(w.tr.length - 1, Math.floor(tc * PAT_HZ));
}

// Safe arrival times at a segment's top edge, per lane, for a kitty skating straight down the leg at vk.
// Hold jitter (spec.jitter, see enemies.js cyclePlan) only shifts when a wolf sets off (its position at time t
// is always the plain pattern's position at some t' near t), so each wolf's safe times are eroded by w.jbins
// bins either way: a launch that is safe here is safe in most cycles.
function patSafety(seg, N, vk) {
  const S2 = PAT_SAFE * PAT_SAFE;
  const out = [];
  for (const r of PAT_LANES) {
    const ok = new Uint8Array(N).fill(1);
    for (const w of seg.wolves) {
      if (r < w.rMin - PAT_SAFE || r > w.rMax + PAT_SAFE) continue;
      const t0 = Math.max(0, (seg.top - (w.thMax + PAT_SAFE)) / vk), t1 = (seg.top - (w.thMin - PAT_SAFE)) / vk;
      const ts = [];
      for (let t = t0; t < t1; t += 1 / 60) ts.push(t);
      ts.push(t1);
      const okw = new Uint8Array(N);
      for (let b = 0; b < N; b++) {
        const tb = b * PAT_BIN;
        let safe = 1;
        for (let k = 0; k < ts.length; k++) {
          const i = patPoseIdx(w, tb + ts[k]);
          const dr = w.tr[i] - r, dth = w.tth[i] - (seg.top - vk * ts[k]);
          if (dr * dr + dth * dth < S2) { safe = 0; break; }
        }
        okw[b] = safe;
      }
      erodeAnd(ok, okw, w.jbins || 0);
    }
    out.push(ok);
  }
  return out;
}

// ok[b] &= (okw is 1 on all of b-J..b+J), circular
function erodeAnd(ok, okw, J) {
  const N = ok.length, z = new Int32Array(3 * N + 1);
  for (let i = 0; i < 3 * N; i++) z[i + 1] = z[i] + (okw[i % N] ? 0 : 1);
  J = Math.min(J, N);
  for (let b = 0; b < N; b++) if (ok[b] && z[N + b + J + 1] - z[N + b - J] > 0) ok[b] = 0;
}

function shifted(a, s, N) { // out[b] = a[(b + s) mod N]
  const o = new Uint8Array(N);
  s = ((s % N) + N) % N;
  for (let b = 0; b < N; b++) o[b] = a[(b + s) % N];
  return o;
}

function maxRun(a) { // longest circular run of ones
  const N = a.length;
  let best = 0, cur = 0;
  for (let k = 0; k < 2 * N; k++) { if (a[k % N]) { cur++; if (cur > best) best = cur; } else cur = 0; }
  return Math.min(best, N);
}

// Per lane: launch times (kitty leaving the entry corner's center, mod the beat) that clear every segment so far.
function laneScore(F) {
  let best = { li: 0, run: 0, frac: 0 };
  F.forEach((f, li) => {
    let n = 0;
    for (let t = 0; t < f.length; t++) n += f[t];
    const run = maxRun(f), frac = n / f.length;
    if (run + 8 * frac > best.run + 8 * best.frac || (run === best.run && Math.abs(PAT_LANES[li]) < Math.abs(PAT_LANES[best.li]))) best = { li, run, frac };
  });
  return best;
}

// --- kitty skating model (shared with the self test): pure pursuit along a world polyline at full speed with
// the ice turn rate; returns positions every 1/60 s from the moment it leaves pts[0].
function skatePath(pts, vk = PAT_VK) {
  const dt = 1 / 60, xs = [], zs = [];
  let x = pts[0].x, z = pts[0].z, k = 1;
  let h = Math.atan2(pts[1].z - z, pts[1].x - x);
  for (let n = 0; n < 60 * 60; n++) {
    while (k < pts.length - 1) {
      const A = pts[k - 1], B = pts[k];
      const ex = B.x - A.x, ez = B.z - A.z, L2 = ex * ex + ez * ez;
      const u = L2 > 0 ? ((x - A.x) * ex + (z - A.z) * ez) / L2 : 1;
      if (u > 1 || Math.hypot(B.x - x, B.z - z) < 1.6) k++; else break;
    }
    const T = pts[k];
    if (k === pts.length - 1 && Math.hypot(T.x - x, T.z - z) < 0.6) break;
    let d = Math.atan2(T.z - z, T.x - x) - h;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const mt = CFG.ICE_TURN_RATE * dt;
    h += d > mt ? mt : d < -mt ? -mt : d;
    x += Math.cos(h) * vk * dt; z += Math.sin(h) * vk * dt;
    xs.push(x); zs.push(z);
  }
  return { xs, zs };
}

// Plan of a leg -> world polyline: start on the entry corner square in the first lane, lanes per segment.
function planPoints(leg, lane, end = 0) {
  const P = (r, th) => ({ x: leg.ox + leg.ux * th + leg.nx * r, z: leg.oz + leg.uz * th + leg.nz * r });
  return [P(lane, leg.len), P(lane, end)];
}

// For each launch bin (kitty at pts[0] at b * PAT_BIN), 1 if the path clears every wolf by `clear`.
function pathSafety(traj, wolves, N, clear) {
  const C2 = clear * clear, ok = new Uint8Array(N).fill(1);
  for (const w of wolves) {
    const idx = [];
    for (let k = 0; k < traj.xs.length; k++) {
      const x = traj.xs[k], z = traj.zs[k];
      if (x > w.x0 - clear && x < w.x1 + clear && z > w.z0 - clear && z < w.z1 + clear) idx.push(k);
    }
    if (!idx.length) continue;
    const f = w.frame, okw = new Uint8Array(N).fill(1);
    for (let b = 0; b < N; b++) {
      for (const k of idx) {
        const i = patPoseIdx(w, b * PAT_BIN + k / 60);
        const wx = f.ox + f.ux * w.tth[i] + f.nx * w.tr[i], wz = f.oz + f.uz * w.tth[i] + f.nz * w.tr[i];
        const dx = traj.xs[k] - wx, dz = traj.zs[k] - wz;
        if (dx * dx + dz * dz < C2) { okw[b] = 0; break; }
      }
    }
    erodeAnd(ok, okw, w.jbins || 0);   // hold jitter: see patSafety
  }
  return ok;
}

function wolfBox(w) {
  const f = w.frame;
  w.x0 = w.z0 = Infinity; w.x1 = w.z1 = -Infinity;
  for (const q of w.route) {
    const x = f.ox + f.ux * q.th + f.nx * q.r, z = f.oz + f.uz * q.th + f.nz * q.r;
    w.x0 = Math.min(w.x0, x); w.x1 = Math.max(w.x1, x); w.z0 = Math.min(w.z0, z); w.z1 = Math.max(w.z1, z);
  }
}

function placePatternEnemies(rng, lvl, p) {
  const { legs, seed, level } = lvl;
  const W = CFG.RING_WIDTH;
  const vOut = W / 2 - WOLF_MARGIN;
  const ranges = usableRanges(legs);
  const last = legs.length - 1;
  const enemies = [];
  const plans = [];
  // per-cycle hold variation (enemies.js cyclePlan): a little on level 1's first legs, more later
  const patJitter = (li, D) => Math.min(MAX_JITTER, level === 1 && li < PAT_LESSONS.length ? 0.2 : 0.3 + 0.1 * D);
  const frameOf = (leg) => ({ ox: leg.ox, oz: leg.oz, ux: leg.ux, uz: leg.uz, nx: leg.nx, nz: leg.nz });
  const finish = (w, leg) => {
    w.rMin = Math.min(...w.route.map((q) => q.r)); w.rMax = Math.max(...w.route.map((q) => q.r));
    w.thMin = Math.min(...w.route.map((q) => q.th)); w.thMax = Math.max(...w.route.map((q) => q.th));
    w.frame = frameOf(leg);
  };

  // Chargers: full-length runners in fixed lanes (solver lanes, so the lanes between them stay open). They
  // own their lane all the time, so they don't need the room's beat; they keep their own rhythm.
  const chargerLanes = (li, D) => {
    if (li === last) return [];
    const lesson = level === 1 ? PAT_LESSONS[li] : null;
    if (lesson) return lesson[0];
    const n = D < 0.25 ? (rng.chance(0.6) ? 1 : 0) : D < 0.6 ? 1 + (rng.chance(0.6) ? 1 : 0) : D < 1 ? 2 + (rng.chance(D - 0.4) ? 1 : 0) : 3;
    const sets = {
      0: [[]], 1: [[0], [-1.8], [1.8], [-3.6], [3.6]],
      2: [[-1.8, 1.8], [-3.6, 3.6], [-3.6, 0], [0, 3.6], [-1.8, 3.6], [-3.6, 1.8]],
      3: [[-3.6, 0, 3.6], [-1.8, 1.8, -3.6], [-1.8, 1.8, 3.6], [-3.6, -1.8, 1.8]],
    };
    return rng.pick(sets[n]);
  };
  const makeChargers = (li, D, lanes) => {
    const leg = legs[li], { lo, hi } = ranges[li];
    const v = Math.min(PAT_VMAX, (3.9 + 1.4 * D) * rng.range(0.95, 1.05));
    const h = Math.max(0.5, 1.2 - 0.4 * D);
    const off = rng.next();
    return lanes.map((r, i) => {
      const w = { type: 'charger', route: [{ r, th: lo }, { r, th: hi }], loop: false, speed: Math.min(PAT_VMAX, v * rng.range(0.94, 1.06)) };
      finish(w, leg);
      const move = buildPlan({ route: w.route.map((q) => ({ ...q, hold: 0 })) }, NO_FRAME, w.speed).cycle;
      w.route = w.route.map((q) => ({ ...q, hold: Math.round(h * rng.range(0.8, 1.3) * 1000) / 1000 }));
      w.cycle = move + w.route[0].hold + w.route[1].hold;
      w.off = ((off + i / lanes.length) % 1) * w.cycle;     // they take turns running at you
      w.jitter = patJitter(li, D);
      return w;
    });
  };

  const legDesign = (li, D, T0) => {
    const leg = legs[li];
    const { lo, hi } = ranges[li];
    const v = Math.min(PAT_VMAX, (3.8 + 1.7 * D) * rng.range(0.96, 1.04));
    const h = Math.max(0.5, 1.2 - 0.4 * D);         // base hold at each wall (stretched to fit the beat)
    const jitter = patJitter(li, D);
    const spacer = () => Math.max(2.4, 8 - 5.5 * D) + rng.range(-0.8, 1.2);
    const c = { D, rng, vOut };
    const lesson = level === 1 ? PAT_LESSONS[li] : null;
    // the room's beat: every crosser / diagonal cycle is T / k (k = 1..3), so the room repeats every T seconds
    const T = T0 || Math.round(Math.max(5, 7.5 - 2 * D) * 4) / 4;
    const fit = (w) => {   // pick k and (if needed) a faster speed so the wolf keeps the beat; false = can't
      for (let it = 0; it < 12; it++) {
        if (patNatural(w, h * 0.6).nat <= T + 1e-9) break;
        if (w.speed >= PAT_VMAX) return false;
        w.speed = Math.min(PAT_VMAX, w.speed * 1.1);
      }
      const { nat, move } = patNatural(w, h);
      let k = Math.max(1, Math.min(3, Math.floor(T / nat + 1e-9)));
      while (k > 1 && T / k - move < 0.25 * w.route.length) k--;
      if (T / k - move < 0.05) return false;
      w.k = k;
      return true;
    };
    const segs = [];
    let cursor = li === last ? Math.min(hi, leg.len - W / 2 - 2.0) : hi - rng.range(0, 1.2);
    for (let n = 0; n < 30; n++) {
      let made = null;
      for (let tries = 0; tries < 5 && !made; tries++) {
        let fam = 'crosswalk', opt = {};
        if (lesson) [fam, opt] = lesson[1][n % lesson[1].length];
        else if (li === last) opt = { k: D < 0.5 ? 1 : 2, variant: 'comb' };     // the final door
        else if (D >= 0.3 && rng.chance(0.3)) fam = 'diagonal';
        if (tries > 2) { fam = 'crosswalk'; opt = { k: 1 }; }
        const sd = PAT_FAMILIES[fam](c, { room: cursor - lo, ...opt });
        if (cursor - sd.depth < lo + 0.01) continue;
        const base = cursor - sd.depth;
        for (const w of sd.wolves) {
          w.route = w.route.map((q) => ({ r: q.r, th: q.th + base }));
          w.speed = Math.min(PAT_VMAX, v * (w.vMul || 1));
          finish(w, leg);
        }
        if (!sd.wolves.every(fit)) continue;
        made = { ...sd, family: fam, top: cursor + PAT_SAFE, bottom: base - PAT_SAFE, base };
        if (sd.wolves.length > 1 || fam !== 'crosswalk') {
          // plan B if this one would close the room: a single crosser where the segment starts
          const alt = segCrosswalk(c, { k: 1 });
          for (const w of alt.wolves) { w.route = w.route.map((q) => ({ r: q.r, th: cursor })); w.speed = Math.min(PAT_VMAX, v); finish(w, leg); }
          if (alt.wolves.every(fit)) made.alt = { ...alt, family: 'crosswalk', top: cursor + PAT_SAFE, bottom: cursor - PAT_SAFE, base: cursor };
        }
      }
      if (!made) break;
      segs.push(made);
      if (li === last) break;
      cursor = made.base - spacer() - 2 * PAT_SAFE;
      if (cursor < lo) break;
    }
    for (const sg of segs) for (const w of sg.wolves.concat(sg.alt ? sg.alt.wolves : [])) {
      patTime(w, T / w.k);
      w.off = w.offT * w.cycle + w.offS;
      w.jitter = jitter;
      // erode by ~a third of the worst-case shift: the departure shift is (d0 - d1) / 2 of two independent draws, so
      // it mostly stays within that; mazeSelfTest checks the real jittered motion (a gap at least every ~10 s).
      // + a quarter hold for the occasional skipped hold (enemies.js NO_STOP_CHANCE), which shifts it a whole hold
      w.jbins = Math.ceil((0.35 * jitter + 0.25) * Math.max(...w.route.map((q) => q.hold)) / PAT_BIN) + 1;
      wolfBox(w);
    }
    return { segs, T, D, v };
  };

  // Greedy segment offsets: each segment's timing is shifted so that some straight lane (not a charger's) keeps
  // a launch window of >= wTarget seconds and >= fTarget of the beat at normal speed, and a (smaller) gap with
  // any number of speed boots (PAT_BOOSTS); a segment that can't is dropped.
  const speeds = [PAT_VK].concat(PAT_BOOSTS.map((m) => PAT_VK * m));
  const solveLeg = (li, design, chargers, wTarget, fTarget) => {
    const { segs, T } = design;
    const leg = legs[li];
    const N = Math.round(T / PAT_BIN);
    const kept = [];
    const open = PAT_LANES.map((r) => chargers.every((w) => Math.abs(w.route[0].r - r) >= PAT_SAFE + 0.3));
    let Fs = speeds.map(() => PAT_LANES.map((_, k) => new Uint8Array(N).fill(open[k] ? 1 : 0)));
    for (const seg0 of segs) for (const seg of [seg0, seg0.alt]) {
      if (!seg || (seg !== seg0 && kept[kept.length - 1] === seg0)) continue;
      const Es = speeds.map((vk) => patSafety(seg, N, vk));
      const leads = speeds.map((vk) => Math.round((leg.len - seg.top) / vk / PAT_BIN));
      const base = Math.floor(rng.next() * N);
      const cands = [];
      for (let q = 0; q < 16; q++) {
        const s = (base + Math.round(q * N / 16)) % N;
        const Fc = Fs.map((F, j) => F.map((f, k) => { const e = shifted(Es[j][k], leads[j] + s, N); const o = new Uint8Array(N); for (let t = 0; t < N; t++) o[t] = f[t] & e[t]; return o; }));
        const sc = Fc.map(laneScore);
        const b = sc.slice(1);
        cands.push({ s, Fc, run: sc[0].run * PAT_BIN, frac: sc[0].frac, run2: Math.min(...b.map((x) => x.run)) * PAT_BIN, frac2: Math.min(...b.map((x) => x.frac)) });
      }
      const val = (cd) => cd.run + 4 * cd.frac + 0.5 * Math.min(cd.frac2, fTarget);
      const boostOK = (cd, m) => cd.run2 >= 0.2 && cd.frac2 >= m * fTarget;
      const good = cands.filter((cd) => cd.run >= wTarget && cd.frac >= fTarget && boostOK(cd, 0.45));
      let pick;
      good.sort((a, b) => val(b) - val(a));
      if (good.length) {
        // keep slack for the segments still to come; only the last one may squeeze the window to the target
        if (design.D < 0.3 || seg0 !== segs[segs.length - 1]) pick = good[Math.floor(rng.next() * Math.min(design.D < 0.6 ? 1 : 2, good.length))];
        else if (design.D < 0.6) pick = good[Math.floor(rng.next() * Math.min(4, good.length))];
        else if (design.D < 0.9) pick = good[good.length - 1 - Math.floor(rng.next() * Math.ceil(good.length / 2))];   // tight but fair
        else pick = good[good.length - 1 - Math.floor(rng.next() * Math.min(2, good.length))];
      }
      else pick = cands.filter((cd) => boostOK(cd, 0.3)).reduce((a, b) => (!a || val(b) > val(a) ? b : a), null);
      // would (nearly) close the room: drop this segment
      if (!pick || pick.run < Math.max(PAT_HARD, 0.6 * wTarget) || pick.frac < Math.max(PAT_FRAC_MIN, 0.7 * fTarget)) continue;
      for (const w of seg.wolves) w.off += pick.s * PAT_BIN;
      kept.push(seg); Fs = pick.Fc;
    }
    const F = Fs[0];
    const sc = laneScore(F), f = F[sc.li];
    // launch time: middle of the lane's longest window
    let bestS = 0, bestL = 0;
    for (let t = 0; t < N; t++) {
      if (!f[t] || f[(t + N - 1) % N]) continue;
      let L = 0; while (L < N && f[(t + L) % N]) L++;
      if (L > bestL) { bestL = L; bestS = t; }
    }
    if (!bestL && f[0]) { bestL = N; bestS = 0; }
    if (chargers.length) kept.unshift({ name: 'chargers', top: ranges[li].hi + PAT_SAFE, bottom: ranges[li].lo - PAT_SAFE, wolves: chargers, chargers: true });
    if (!kept.length) return null;
    return { leg: li, beat: T, segs: kept, lane: PAT_LANES[sc.li], launch: ((bestS + Math.floor(bestL / 2)) % N) * PAT_BIN, window: sc.run * PAT_BIN, frac: sc.frac, frac2: Math.min(...Fs.slice(1).map((F2) => laneScore(F2).frac)), N, F: f };
  };

  const heat = p.patternHeat || 0;
  for (let li = 0; li < legs.length; li++) {
    const lesson = level === 1 && li < PAT_LESSONS.length;
    const D = lesson ? 0.1 * li : Math.min(1.6, heat + 0.5 * li / Math.max(1, last));
    const wTarget = Math.max(0.3, 0.75 - 0.3 * D);
    const fTarget = lesson ? 0.34 : Math.max(0.08, 0.25 - 0.12 * D);
    if (li === last && plans.length && plans[plans.length - 1].leg === li - 1) {
      // final stretch: the door before the goal. Its first corner is ice, so it is timed together with the
      // previous leg (launch from the last safe square) using the skating model.
      const prevPlan = plans[plans.length - 1];
      const design = legDesign(li, D, prevPlan.beat);
      const N = prevPlan.N, pleg = legs[li - 1], leg = legs[li];
      const P = (r, th) => ({ x: leg.ox + leg.ux * th + leg.nx * r, z: leg.oz + leg.uz * th + leg.nz * r });
      const doorW = design.segs.flatMap((sg) => sg.wolves);
      const tries = [];
      for (const r of [-1.8, 0, 1.8]) {
        const pts = planPoints(pleg, prevPlan.lane, CFG.RING_WIDTH / 2).concat([P(r, leg.len - 2), P(r, 1), P(W, 0), { x: 0, z: 0 }]);
        tries.push({ r, traj: skatePath(pts) });
      }
      const baseS = Math.floor(rng.next() * N);
      let best = null;
      for (let q = 0; q < 16; q++) {
        const sh = (baseS + Math.round(q * N / 16)) % N;
        for (const w of doorW) w.off += sh * PAT_BIN;
        for (const tr of tries) {
          const ok = pathSafety(tr.traj, doorW, N, PAT_SAFE);
          let n = 0;
          for (let b = 0; b < N; b++) { ok[b] &= prevPlan.F[b]; n += ok[b]; }
          const cd = { sh, run: maxRun(ok) * PAT_BIN, frac: n / N, tr };
          const v = (x) => Math.min(x.run, wTarget) + 4 * Math.min(x.frac, fTarget) + 0.01 * x.frac;
          if (!best || v(cd) > v(best)) best = cd;
        }
        for (const w of doorW) w.off -= sh * PAT_BIN;
      }
      if (doorW.length && best && best.run >= PAT_HARD && best.frac >= PAT_FRAC_MIN) {
        for (const w of doorW) w.off += best.sh * PAT_BIN;
        prevPlan.finalLane = best.tr.r; prevPlan.window = best.run; prevPlan.frac = best.frac;
        plans.push({ leg: li, beat: prevPlan.beat, segs: design.segs, lane: best.tr.r, launch: null, window: best.run, frac: best.frac, N, finale: true });
      }
      continue;
    }
    const chargers = makeChargers(li, D, chargerLanes(li, D));
    const pl = solveLeg(li, legDesign(li, D, 0), chargers, wTarget, fTarget);
    if (pl) plans.push(pl);
  }

  // ---- specs
  for (const pl of plans) {
    for (const seg of pl.segs) for (const w of seg.wolves) {
      const id = enemies.length;
      enemies.push({
        id, type: w.type, leg: pl.leg, frame: w.frame,
        rIn: w.rMin, rOut: w.rMax, a0: w.thMin, a1: w.thMax,
        speed: w.speed,
        phase: Math.round((((w.off % w.cycle) + w.cycle) % w.cycle) / w.cycle * 1e9) / 1e9,
        hold: 0.5,
        seed: hashSeed(seed, level, 'wolf', id),
        route: w.route, loop: !!w.loop, jitter: w.jitter,
        pattern: seg.name,
      });
    }
  }
  // One solution per leg (for tests / tooling): skate lane `lane` (leg-local r), leaving the entry corner's
  // center when levelTime mod `beat` == `launch`; `window`/`frac` = launch slack (s) / open share of the beat.
  // The finale entry describes the door of the final stretch, entered from the previous leg (its `finalLane`).
  const r3 = (x) => Math.round(x * 1000) / 1000;
  lvl.patternPlan = plans.map((pl) => ({
    leg: pl.leg, beat: pl.beat, lane: pl.lane, launch: pl.launch == null ? null : r3(pl.launch),
    window: r3(pl.window), frac: r3(pl.frac), finalLane: pl.finalLane, finale: !!pl.finale,
    segs: pl.segs.map((sg) => ({ name: sg.name, top: r3(sg.top), bottom: r3(sg.bottom) })),
  }));
  return enemies;
}


function placeItems(rng, lvl, p) {
  const { legs, spawnPoints } = lvl;
  const W = CFG.RING_WIDTH;
  const items = [];
  const okSpot = (x, z) => {
    for (const s of spawnPoints) if (Math.hypot(s.x - x, s.z - z) < 4) return false;
    for (const t of items) if (Math.hypot(t.x - x, t.z - z) < 6) return false;
    if (collideCircle(lvl, x, z, CFG.ITEM_RADIUS + 0.15).hit) return false;
    for (const t of lvl.trees || []) if (Math.hypot(t.x - x, t.z - z) < CFG.TREE_RADIUS + 1) return false; // not hidden under a canopy
    return true;
  };
  const types = [['boots', 5], ['life', 2], ['shield', 3]];
  for (let n = 0; n < p.itemCount; n++) {
    const type = pickWeighted(rng, types, (t) => t[1])[0];
    for (let s = 0; s < 40; s++) {
      const leg = pickWeighted(rng, legs, (l) => l.len);
      const along = rng.range(0, leg.len), lat = rng.range(-W / 2 + 1.2, W / 2 - 1.2);
      const x = leg.ox + leg.ux * along + leg.nx * lat, z = leg.oz + leg.uz * along + leg.nz * lat;
      if (!okSpot(x, z)) continue;
      items.push({ id: items.length, type, x, z });
      break;
    }
  }
  return items;
}

// Ice levels: two safe squares are checkpoints (see sim.js): the one nearest 1/3 of the way along
// the path, and the fifth safe square before the end. Each faces down the leg that leaves it (legs[i] runs from corner i+1 at s=0 to corner i).
function pickCheckpoints(corners, legs, nSafe) {
  const cum = [0];
  for (let i = 1; i < corners.length; i++) cum.push(cum[i - 1] + Math.hypot(corners[i].x - corners[i - 1].x, corners[i].z - corners[i - 1].z));
  const total = cum[cum.length - 1];
  const late = nSafe - 5;          // fifth safe square before the end
  let third = 1;
  for (let i = 1; i < late; i++) if (Math.abs(cum[i] - total / 3) < Math.abs(cum[third] - total / 3)) third = i;
  return [third, late].map((i) => ({ corner: i, x: corners[i].x, z: corners[i].z, heading: Math.atan2(-legs[i].uz, -legs[i].ux) })); // run direction is -u
}

// Autumn levels: one climbable tree per lane (not the final stretch), somewhere in the middle of the leg,
// off to one side. A kitty under its canopy (within CFG.TREE_RADIUS) has climbed up and wolves can't reach it.
function placeTrees(rng, legs) {
  const W = CFG.RING_WIDTH;
  const lat = W / 2 - CFG.WALL_THICKNESS / 2 - CFG.TREE_RADIUS - 0.4; // keep the canopy off the walls
  const trees = [];
  for (let i = 0; i < legs.length - 1; i++) {
    const l = legs[i];
    if (l.len < 2 * W) continue;
    const s = rng.range(W, l.len - W), v = rng.range(-lat, lat);
    trees.push({ x: l.ox + l.ux * s + l.nx * v, z: l.oz + l.uz * s + l.nz * v, leg: i });
  }
  return trees;
}

function inTree(levelData, x, z) {
  const t = levelData.trees;
  if (!t || !t.length) return false;
  const r2 = CFG.TREE_RADIUS * CFG.TREE_RADIUS;
  for (let i = 0; i < t.length; i++) {
    const dx = x - t[i].x, dz = z - t[i].z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

// ---------------------------------------------------------------- generation

// mode: 'mixed' (default: level 2 of every 4 is the ice rink), 'run' (no ice, original theme order), 'ice' (every level is ice)
function generateLevel(level, seed, mode = 'mixed') {
  const L = Math.max(1, level | 0);
  const p = levelParams(L);
  const rng = createRng(hashSeed(seed, L));
  const { walls, legs, corners, wallCorners, outer } = buildSpiral();
  const path = buildPath(corners, legs);

  // spawn: 2x2 block in the start pocket, facing up the first leg
  const start = corners[0];
  const first = legs[0];
  const fx = -first.ux, fz = -first.uz;          // travel direction = back along the outermost arm
  const heading = Math.atan2(fz, fx);
  const spawnPoints = [];
  for (const [a, b] of [[0.9, -1.1], [0.9, 1.1], [-0.9, -1.1], [-0.9, 1.1]]) {
    spawnPoints.push({ x: start.x + fx * a + first.nx * b, z: start.z + fz * a + first.nz * b, heading });
  }

  const lvl = {
    level: L, seed,
    loops: Math.floor((ARMS - 4) / 4),
    corridorWidth: CFG.RING_WIDTH,
    centerRadius: CFG.CENTER_RADIUS,
    roomHalf: ROOM,
    outerRadius: outer,
    walls,
    wallSegments: walls,
    wallCorners,
    legs,
    corners,
    safeCorners: corners.slice(0, -2),          // wolf-free squares (not the two corners of the final stretch)
    startAngle: heading,
    spawnPoints,
    enemies: [],
    items: [],
    path,
    theme: CFG.ICE_TEST || mode === 'ice' ? ICE_THEME : THEME_ORDER[(L - 1) % 4], // run mode: same seasons, winter just isn't ice
    mode,
  };
  lvl.ice = mode !== 'run' && lvl.theme === ICE_THEME;
  lvl.checkpoints = lvl.ice ? pickCheckpoints(corners, legs, lvl.safeCorners.length) : [];
  // the crown: just inside the goal room's door, on the way to the portal
  {
    const last = corners[corners.length - 1], inner = legs[legs.length - 1], d = CFG.RING_WIDTH / 2 + 1.6;
    lvl.crown = { x: last.x + inner.nx * d, z: last.z + inner.nz * d };
  }
  lvl.trees = lvl.theme === TREE_THEME && !lvl.ice ? placeTrees(createRng(hashSeed(seed, L, 'trees')), legs) : [];
  lvl.enemies = mode === 'ice' ? placePatternEnemies(rng, lvl, p) : placeEnemies(rng, lvl, p);
  lvl.items = placeItems(rng, lvl, p);
  for (const t of lvl.trees) lvl.items.push({ id: lvl.items.length, type: 'boots', x: t.x, z: t.z, tree: true }); // a pair of boots up every tree
  return lvl;
}

// ---------------------------------------------------------------- collision

const gridCache = new WeakMap();

function getGrid(ld) {
  let g = gridCache.get(ld);
  if (g && g.src === ld.wallSegments) return g;
  const segs = ld.wallSegments;
  const n = segs.length;
  const data = new Float64Array(n * 4);
  for (let k = 0; k < n; k++) {
    const s = segs[k];
    data[k * 4] = s.ax; data[k * 4 + 1] = s.az; data[k * 4 + 2] = s.bx; data[k * 4 + 3] = s.bz;
  }
  const ext = (ld.outerRadius || 0) + 3;
  const dim = Math.max(1, Math.ceil((2 * ext) / GRID_CELL));
  const cells = new Array(dim * dim);
  for (let c = 0; c < cells.length; c++) cells[c] = [];
  const E = HALF_T + GRID_MAX_R + 0.01;
  const toCell = (v) => Math.min(dim - 1, Math.max(0, Math.floor((v + ext) / GRID_CELL)));
  for (let k = 0; k < n; k++) {
    const ax = data[k * 4], az = data[k * 4 + 1], bx = data[k * 4 + 2], bz = data[k * 4 + 3];
    const cx0 = toCell(Math.min(ax, bx) - E), cx1 = toCell(Math.max(ax, bx) + E);
    const cz0 = toCell(Math.min(az, bz) - E), cz1 = toCell(Math.max(az, bz) + E);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) cells[cz * dim + cx].push(k);
  }
  const all = [];
  for (let k = 0; k < n; k++) all.push(k);
  g = { src: segs, data, cells, dim, ext, all };
  gridCache.set(ld, g);
  return g;
}

function collideCircle(levelData, x, z, radius) {
  const g = getGrid(levelData);
  const d = g.data;
  const minD = radius + HALF_T;
  const minD2 = minD * minD;
  let hit = false;
  for (let pass = 0; pass < 3; pass++) {
    let list;
    if (radius <= GRID_MAX_R) {
      const cx = Math.floor((x + g.ext) / GRID_CELL), cz = Math.floor((z + g.ext) / GRID_CELL);
      list = (cx < 0 || cz < 0 || cx >= g.dim || cz >= g.dim) ? null : g.cells[cz * g.dim + cx];
      if (!list) list = g.all;
    } else list = g.all;
    let moved = false;
    for (let m = 0; m < list.length; m++) {
      const k = list[m] * 4;
      const ax = d[k], az = d[k + 1], bx = d[k + 2], bz = d[k + 3];
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + ex * t, pz = az + ez * t;
      const dx = x - px, dz = z - pz;
      const dd = dx * dx + dz * dz;
      if (dd >= minD2) continue;
      const dl = Math.sqrt(dd);
      let nx, nz;
      if (dl > 1e-9) { nx = dx / dl; nz = dz / dl; }
      else {
        const el = Math.sqrt(len2) || 1;
        nx = -ez / el; nz = ex / el;
        if (nx * px + nz * pz > 0) { nx = -nx; nz = -nz; } // degenerate: prefer pushing inward
      }
      x = px + nx * minD; z = pz + nz * minD;
      hit = true; moved = true;
    }
    if (!moved) break;
  }
  return { x, z, hit };
}


// Which corridor leg (index into levelData.legs) a point is in; -1 = goal room, -2 = outside.
function locate(levelData, x, z) {
  const W = levelData.corridorWidth;
  const rh = levelData.roomHalf;
  if (Math.abs(x) < rh && Math.abs(z) < rh) return { leg: -1, s: 0, v: 0 };
  const legs = levelData.legs;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    const dx = x - l.ox, dz = z - l.oz;
    const s = dx * l.ux + dz * l.uz, v = dx * l.nx + dz * l.nz;
    if (s >= -W / 2 && s <= l.len + W / 2 && Math.abs(v) <= W / 2) return { leg: i, s, v };
  }
  return { leg: -2, s: 0, v: 0 };
}

// Ice level: everything except the goal room and the safe corner squares is ice.
function onIce(levelData, x, z) {
  if (!levelData.ice) return false;
  const rh = levelData.roomHalf;
  if (Math.abs(x) < rh && Math.abs(z) < rh) return false;
  const h = levelData.corridorWidth / 2;
  const sc = levelData.safeCorners;
  for (let i = 0; i < sc.length; i++) if (Math.abs(x - sc[i].x) < h && Math.abs(z - sc[i].z) < h) return false;
  return true;
}

function inCenter(levelData, x, z) {
  return Math.hypot(x, z) < levelData.centerRadius - HALF_T;
}

// ---------------------------------------------------------------- self test

// Skate only: how a leg's recorded solution plays with the REAL (hold-jittered) wolves, checked independently of
// the generator's tables: the skating model follows the plan's lane (for the final stretch: through the previous
// leg and in through the door); wolves are posed with enemies.js cyclePlan/patternPose for every cycle. Scans
// launch times over `horizon` seconds; returns the longest clear launch window and the longest wait for one.
function patternGaps(ld, pl, horizon = 40, step = 0.1) {
  const legs = ld.legs;
  const fin = pl.finale ? ld.patternPlan.find((q) => q.leg === pl.leg - 1) : null;
  const legI = fin ? fin.leg : pl.leg, leg = legs[legI];
  let pts;
  if (fin) {
    const L2 = legs[pl.leg], W = ld.corridorWidth;
    const P = (r, th) => ({ x: L2.ox + L2.ux * th + L2.nx * r, z: L2.oz + L2.uz * th + L2.nz * r });
    pts = planPoints(leg, fin.lane, W / 2).concat([P(pl.lane, L2.len - 2), P(pl.lane, 1), P(W, 0), { x: 0, z: 0 }]);
  } else pts = planPoints(leg, pl.lane);
  const traj = skatePath(pts);
  const wolves = ld.enemies.filter((e) => e.leg === pl.leg || (fin && e.leg === fin.leg)).map((e) => {
    const plan = buildPlan(e, e.frame, e.speed);
    const w = { e: { spec: e, _plan: plan, _jitter: Math.min(MAX_JITTER, e.jitter || 0), _cyc: null }, plan, frame: e.frame, route: e.route };
    wolfBox(w);
    return w;
  });
  const n = Math.round(horizon / step), hit = PAT_HIT, h2 = hit * hit;
  const ok = new Uint8Array(n).fill(1);
  for (const w of wolves) {
    const idx = [];
    for (let k = 0; k < traj.xs.length; k++) if (traj.xs[k] > w.x0 - hit && traj.xs[k] < w.x1 + hit && traj.zs[k] > w.z0 - hit && traj.zs[k] < w.z1 + hit) idx.push(k);
    const f = w.frame, cyc = w.plan.cycle;
    for (let b = 0; b < n; b++) {
      if (!ok[b]) continue;
      for (const k of idx) {
        const t = w.e.spec.phase * cyc + b * step + k / 60, kc = Math.floor(t / cyc);
        const q = patternPose(cyclePlan(w.e, kc), Math.min(cyc - 1e-9, t - kc * cyc));
        const dx = traj.xs[k] - (f.ox + f.ux * q.th + f.nx * q.r), dz = traj.zs[k] - (f.oz + f.uz * q.th + f.nz * q.r);
        if (dx * dx + dz * dz < h2) { ok[b] = 0; break; }
      }
    }
  }
  let run = 0, best = 0, wait = 0, maxWait = 0;
  for (let b = 0; b < n; b++) {
    if (ok[b]) { run++; best = Math.max(best, run); wait = 0; } else { run = 0; wait++; maxWait = Math.max(maxWait, wait); }
  }
  return { window: best * step, maxWait: maxWait * step };
}

function checkPatternWolves(ld, P, stats) {
  const ranges = usableRanges(ld.legs);
  const vOut = CFG.RING_WIDTH / 2 - WOLF_MARGIN, eps = 1e-6;
  if (ld.enemies.length < 40) P(`few pattern wolves ${ld.enemies.length}`);
  if (!ld.patternPlan || ld.patternPlan.length < ld.legs.length - 3) P(`rooms missing: ${ld.patternPlan ? ld.patternPlan.length : 0} planned legs`);
  const beat = new Map((ld.patternPlan || []).map((pl) => [pl.leg, pl.beat]));
  for (const e of ld.enemies) {
    const tag = `wolf ${e.id} (${e.type}/${e.pattern}, leg ${e.leg})`;
    if (!PAT_TYPES.includes(e.type)) P(`${tag}: type not allowed in Skate only`);
    if (!Array.isArray(e.route) || e.route.length < 2) { P(`${tag}: no route`); continue; }
    if (!(e.speed > 0 && e.speed < CFG.KITTY_SPEED * 0.92)) P(`${tag}: speed ${e.speed}`);
    if (!(e.phase >= 0 && e.phase < 1)) P(`${tag}: phase ${e.phase}`);
    if (!(e.rIn <= e.rOut && e.a0 <= e.a1)) P(`${tag}: bad bounds`);
    const rg = ranges[e.leg];
    for (const q of e.route) {
      if (!(Math.abs(q.r) <= vOut + eps && q.th >= rg.lo - eps && q.th <= rg.hi + eps)) P(`${tag}: waypoint out of bounds (${q.r.toFixed(2)}, ${q.th.toFixed(2)})`);
      if (!(q.r >= e.rIn - eps && q.r <= e.rOut + eps && q.th >= e.a0 - eps && q.th <= e.a1 + eps)) P(`${tag}: waypoint outside its spec bounds`);
    }
    // end to end: crossers / diagonals wall to wall; chargers the whole leg, safe square to safe square
    if (e.loop || e.route.length !== 2) P(`${tag}: route is not a single end-to-end run`);
    else if (e.type === 'charger') {
      const [A, B] = e.route;
      if (Math.abs(A.r - B.r) > eps || Math.abs(Math.min(A.th, B.th) - rg.lo) > eps || Math.abs(Math.max(A.th, B.th) - rg.hi) > eps) P(`${tag}: charger does not run the whole leg`);
    } else {
      const [A, B] = e.route;
      if (Math.abs(Math.abs(A.r) - vOut) > eps || Math.abs(Math.abs(B.r) - vOut) > eps || Math.sign(A.r) === Math.sign(B.r)) P(`${tag}: does not run wall to wall`);
      if (e.type === 'crosser' && Math.abs(A.th - B.th) > eps) P(`${tag}: crosser not straight across`);
      const cyc = buildPlan(e, e.frame, e.speed).cycle, T = beat.get(e.leg);
      if (!T || Math.abs(cyc * Math.round(T / cyc) - T) > 1e-4) P(`${tag}: cycle ${cyc.toFixed(3)} does not divide the leg beat ${T}`);
    }
    if (!(e.jitter >= 0 && e.jitter <= MAX_JITTER)) P(`${tag}: jitter ${e.jitter}`);
    const f = e.frame, pts = e.loop ? e.route.concat([e.route[0]]) : e.route;
    let clip = 0, unsafe = 0;
    for (let k = 1; k < pts.length; k++) {
      const A = pts[k - 1], B = pts[k], n = Math.max(1, Math.ceil(Math.hypot(B.r - A.r, B.th - A.th) / 0.25));
      for (let t = 0; t <= n; t++) {
        const r = A.r + (B.r - A.r) * t / n, th = A.th + (B.th - A.th) * t / n;
        const x = f.ox + f.ux * th + f.nx * r, z = f.oz + f.uz * th + f.nz * r;
        if (collideCircle(ld, x, z, CFG.WOLF_RADIUS).hit) clip++;
        for (const sp of ld.spawnPoints) if (Math.hypot(sp.x - x, sp.z - z) < CFG.START_SAFE_ARC) unsafe++;
      }
    }
    if (clip) P(`${tag}: route clips walls (${clip})`);
    if (unsafe) P(`${tag}: route enters the start safe area`);
  }
  for (const pl of ld.patternPlan || []) {
    if (ld.patternPlan.some((q) => q.leg === pl.leg + 1 && q.finale)) continue;   // checked with its final door
    const g = patternGaps(ld, pl);
    stats.iceMinWindow = Math.min(stats.iceMinWindow, g.window);
    stats.iceMaxWait = Math.max(stats.iceMaxWait || 0, g.maxWait);
    if (g.window < 0.2 || g.maxWait > 10) P(`leg ${pl.leg}${pl.finale ? ' (final door)' : ''}: lane ${pl.lane} best window ${g.window.toFixed(2)}s, longest wait ${g.maxWait.toFixed(1)}s`);
  }
  stats.iceWolves += ld.enemies.length;
}

function mazeSelfTest(levels = 12, modes = ['mixed', 'ice']) {
  const problems = [];
  const seeds = [1, 42, 1337, 9001, 'kitty', 777777];
  const stats = { levels: 0, avgPathLen: 0, enemies: 0, items: 0, iceWolves: 0, iceMinWindow: Infinity };
  for (const mode of modes) for (const s of seeds) {
    for (let l = 1; l <= levels; l++) {
      const P = (s, l, msg) => { if (problems.length < 200) problems.push(`${mode} seed ${s} L${l}: ${msg}`); };
      const ld = generateLevel(l, s, mode);
      const p = levelParams(l);
      const pattern = mode === 'ice';
      stats.levels++;
      if (JSON.stringify(ld) !== JSON.stringify(generateLevel(l, s, mode))) P(s, l, 'not deterministic');
      // path: starts at start, ends in center, never inside walls
      const path = ld.path;
      if (!inCenter(ld, path[path.length - 1].x, path[path.length - 1].z)) P(s, l, 'path does not end in center');
      let len = 0, bad = 0;
      for (let k = 1; k < path.length; k++) {
        const A = path[k - 1], B = path[k];
        const sl = Math.hypot(B.x - A.x, B.z - A.z);
        len += sl;
        if (sl > 2.6) P(s, l, 'path step too long ' + sl.toFixed(2));
        const n = Math.ceil(sl / 0.2);
        for (let t = 0; t <= n; t++) {
          const x = A.x + (B.x - A.x) * t / n, z = A.z + (B.z - A.z) * t / n;
          if (collideCircle(ld, x, z, CFG.KITTY_RADIUS).hit) bad++;
        }
      }
      if (bad) P(s, l, `path hits walls at ${bad} samples`);
      stats.avgPathLen += len;
      // spawn points
      for (const sp of ld.spawnPoints) {
        if (collideCircle(ld, sp.x, sp.z, CFG.KITTY_RADIUS).hit) P(s, l, 'spawn collides');
        if (locate(ld, sp.x, sp.z).leg !== 0) P(s, l, 'spawn not in the first leg');
      }
      // enemies: territories inside their leg, clear of walls and the start pocket
      if (pattern) checkPatternWolves(ld, (msg) => P(s, l, msg), stats);
      else {
        if (ld.enemies.length < p.enemyCount * 0.85) P(s, l, `few enemies ${ld.enemies.length}/${p.enemyCount}`);
        for (const e of ld.enemies) {
          if (!(e.rIn < e.rOut && e.a0 < e.a1)) P(s, l, 'enemy bad bounds ' + e.id);
          if (!p.enemyTypes.includes(e.type)) P(s, l, 'enemy type ' + e.type);
          if (!(e.speed > 0 && e.speed < CFG.KITTY_SPEED)) P(s, l, 'enemy speed ' + e.speed);
          let clip = 0, unsafe = 0;
          const f = e.frame;
          for (let u = 0; u <= 8; u++) for (let v = 0; v <= 4; v++) {
            const a = e.a0 + (e.a1 - e.a0) * u / 8, r = e.rIn + (e.rOut - e.rIn) * v / 4;
            const x = f.ox + f.ux * a + f.nx * r, z = f.oz + f.uz * a + f.nz * r;
            if (collideCircle(ld, x, z, CFG.WOLF_RADIUS).hit) clip++;
            for (const sp of ld.spawnPoints) if (Math.hypot(sp.x - x, sp.z - z) < CFG.START_SAFE_ARC) unsafe++;
          }
          if (clip) P(s, l, `enemy ${e.id} (${e.type}) bounds clip walls (${clip})`);
          if (unsafe) P(s, l, `enemy ${e.id} covers start safe area`);
        }
      }
      // items
      if (ld.items.length < p.itemCount) P(s, l, `few items ${ld.items.length}/${p.itemCount}`);
      for (const it of ld.items) {
        if (collideCircle(ld, it.x, it.z, CFG.ITEM_RADIUS).hit) P(s, l, 'item in wall ' + it.id);
        if (locate(ld, it.x, it.z).leg < 0) P(s, l, 'item outside corridors');
      }
      ld.items.forEach((it, k) => { if (it.id !== k) P(s, l, 'item ids not sequential'); });
      ld.enemies.forEach((e, k) => { if (e.id !== k) P(s, l, 'enemy ids not sequential'); });
      stats.enemies += ld.enemies.length;
      stats.items += ld.items.length;
    }
  }
  stats.avgPathLen /= Math.max(1, stats.levels);
  return { ok: problems.length === 0, problems, stats };
}

export { generateLevel, collideCircle, locate, inCenter, onIce, inTree, mazeSelfTest };
