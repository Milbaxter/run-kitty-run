import { CFG, levelParams, SKATE_FINAL_LEVEL, FINAL_MODES } from './config.js';
import { createRng, hashSeed, ipow, legPoint } from './rng.js';
import { buildPlan, patternPose, patternSpeed } from './enemies.js';

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
const THEME_ORDER = [0, TREE_THEME, ICE_THEME, SPRING_THEME];   // Run only: meadow, autumn, snow, spring
const MIXED_THEME_ORDER = [0, TREE_THEME, ICE_THEME];             // Run + Skate: summer, fall, winter (ice); level 9's winter is the boss run

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

function buildStraightPath(corners) {
  const pts = [];
  const end = corners[corners.length - 1].x;
  for (let x = corners[0].x; x < end; x += 2) pts.push({ x, z: 0 });
  pts.push({ x: end, z: 0 });
  for (let x = end + 2; x < 0; x += 2) pts.push({ x, z: 0 });
  pts.push({ x: 0, z: 0 });
  return pts;
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

// ---------------------------------------------------------------- the final run (Skate only, last level)
//
// One long straight corridor from the start pocket (far left) to the goal room (right; the room keeps its
// usual place around the origin, so everything that knows where the goal is still does). The path is exactly as
// long as the spiral's. There are no safe squares besides the start pocket: the corridor is cut into invisible
// "rooms" (collinear legs, each solved by the pattern-wolf generator like a spiral leg), and between two rooms is
// only a short wolf-free gap of ice (FINALE_GAP) where a good skater can carve a tight circle to wait for the
// next opening. Halfway along, one gap is wider and holds a climbable tree: under its canopy is snow, not ice
// (onIce), and wolves can't reach you (inTree), the only real breather of the run.
// Its rooms get their wolves exactly like Skate only's spiral legs (legDesign / placeLeg, see the pattern-wolf
// section): charger lanes, tight rows that open up through drifting wolves, no pauses and no launch-window solver,
// at the final level's difficulty and wolf count.

// Legs follow the spiral's conventions: leg i runs from corner i (s = len, where the kitty enters) to corner
// i + 1 (s = 0); u points back toward the start (run direction is -u). leg.padHi / leg.padLo = wolf-free
// half-gap at the entry / exit end (usableRanges).

const FINALE_GAP = 6.5;          // wolf-free ice between two rooms (wolf bodies), enough for a tight skating circle
const FINALE_TREE_GAP = 13;      // ...around the halfway tree
const FINALE_ROOM = [34, 52];    // room lengths
const FINALE_WOLVES = 385;       // the run's wolf count (the spiral's level-7+ count would be 412)

let spiralPathLen = 0;
function spiralLength() {
  if (!spiralPathLen) {
    const { legs, corners } = buildSpiral();
    const pts = buildPath(corners, legs);
    for (let k = 1; k < pts.length; k++) spiralPathLen += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
  }
  return spiralPathLen;
}

function buildStraight(rng) {
  const W = CFG.RING_WIDTH, h = W / 2;
  const total = Math.round(spiralLength());
  const xs = -total;                 // start square center: the path start -> goal center is `total` long
  const xd = -ROOM - h;              // the last corner: the ice square in front of the goal room's door
  const xTree = Math.round(xs + total / 2);
  // room boundaries: two runs of rooms, start -> tree and tree -> door, each split into near-equal random rooms
  const split = (a, b) => {
    const n = Math.max(1, Math.round((b - a) / ((FINALE_ROOM[0] + FINALE_ROOM[1]) / 2)));
    const w = [];
    for (let i = 0; i < n; i++) w.push(rng.range(FINALE_ROOM[0], FINALE_ROOM[1]));
    const sum = w.reduce((x, y) => x + y, 0);
    const out = [];
    let x = a;
    for (let i = 0; i < n - 1; i++) { x += (b - a) * w[i] / sum; out.push(Math.round(x * 10) / 10); }
    return out;
  };
  const xsCorners = [xs, ...split(xs, xTree), xTree, ...split(xTree, xd), xd];
  const corners = xsCorners.map((x) => ({ x, z: 0 }));
  const gapAt = (i) => (corners[i].x === xTree ? FINALE_TREE_GAP : FINALE_GAP);
  const legs = [];
  for (let i = 0; i < corners.length - 1; i++) {
    legs.push({
      arm: i, ox: corners[i + 1].x, oz: 0, ux: -1, uz: 0, nx: 0, nz: 1, len: corners[i + 1].x - corners[i].x, loop: 0,
      padHi: gapAt(i) / 2, padLo: gapAt(i + 1) / 2,
    });
  }
  const x0 = xs - h;
  const walls = [
    { ax: x0, az: -h, bx: -ROOM, bz: -h },          // far wall of the corridor
    { ax: -ROOM, az: h, bx: x0, bz: h },            // near wall
    { ax: x0, az: h, bx: x0, bz: -h },              // back wall of the start pocket
    { ax: -ROOM, az: -h, bx: -ROOM, bz: -ROOM },    // goal room
    { ax: -ROOM, az: -ROOM, bx: ROOM, bz: -ROOM },
    { ax: ROOM, az: -ROOM, bx: ROOM, bz: ROOM },
    { ax: ROOM, az: ROOM, bx: -ROOM, bz: ROOM },
    { ax: -ROOM, az: ROOM, bx: -ROOM, bz: h },
  ];
  return { walls, legs, corners, wallCorners: [], outer: -x0, tree: { x: xTree, z: 0 }, length: total };
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
      const type = rng.pick(p.enemyTypes);   // always 'wanderer' now, but the pick's rng.next() keeps levels unchanged
      const span = spanScale * (1 + 0.4 * dk) * rng.range(10, 20);
      const lo = Math.max(R0, cs - span / 2), hi = Math.min(R1, cs + span / 2);
      if (hi - lo < 2.5) continue;
      const id = enemies.length;
      const spec = {
        id, type, leg: li, frame,
        rIn: vIn, rOut: vOut, a0: lo, a1: hi,
        speed: Math.min(CFG.KITTY_SPEED * 0.92, p.enemySpeed * (0.9 + 0.2 * dk) * rng.range(0.9, 1.1)),
        phase: rng.next(),
        pauseScale: p.enemyPauseScale * (1.15 - 0.45 * dk),
        seed: hashSeed(seed, level, 'wolf', id),
      };
      enemies.push(spec);
    }
  });
  return enemies;
}

// ---------------------------------------------------------------- pattern wolves (Skate only mode)
//
// In Skate only (mode 'ice') wolves don't wander: each runs a fixed route at a fixed rhythm (see the
// pattern section of enemies.js), so a leg is a "room" the kitty studies from the safe corner square and
// then skates through in one go (it can't stop on ice).
//
// Every wolf runs end to end and never stands still: it turns straight round at each end.
//   charger    runs the whole leg in a fixed lane, from the edge of one safe square to the next and back. Charger
//              lanes are skating lanes (PAT_LANES), so the lanes between them stay open; they own their lane all the time
//              (go beside them). A leg's charger lanes run at speeds whose laps share a period <= 60 s and take
//              turns; a lane holds 1-5 wolves, loosely spaced (more only where the level needs them for its count).
//   crosser    crosses the lane wall to wall, in rows walking shoulder to shoulder (crosswalk: line / wave / anti =
//              abreast, slightly staggered one way or the other / split = two halves from opposite walls; single)
//   diagonal   crosses wall to wall at an angle (swing, scissors = two crossing half a beat apart, fan = a row of swings)
// The final run (level 9's straight corridor) is built the same way: its rooms are legs too, with no door, and it
// has FINALE_WOLVES wolves.
// A leg = a set of charger lanes + crosser / diagonal segments top (entry, high th) to bottom. The room's beat is T:
// a crosser / diagonal runs there and back once per T. Rows are tight (PAT_ROW_SP < 2 * PAT_HIT: the kitty can't slip
// between two neighbours), so a row in step is a wall; it opens up through speed differences: in every row of 3+ at
// least one wolf in four (patRowNeed, more at random, spread along the row) drifts, lap T / (1 + j / n), n in
// PAT_DRIFT_N, j a whole number of laps gained / lost every n beats, picked so its speed is PAT_DRIFT_MU (0.8x - 1.4x)
// of the room's; lone crossers, pairs and scissors drift
// now and then. The room repeats every n * T <= PAT_DRIFT_PERIOD seconds. Rooms are built as designed, with no
// launch-window solver (the balance is playtested): each segment gets a random timing offset (placeLeg), about half
// of a room's rows starting the level nearer the other wall.
// Level 1's first legs ease in (PAT_LESSONS, only their rows drift); difficulty D = levelParams().patternHeat + 0.5 *
// depth drives the beat (and so the wolf speed), density, charger speed and lanes, and the variants.

const PAT_HIT = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
const PAT_SAFE = PAT_HIT + 0.3;               // clearance (spare room for imperfect skating)
const PAT_LANES = [-3.6, -1.8, 0, 1.8, 3.6];   // skating lanes: center, middles, near the walls (charger lanes are among them)
const PAT_BIN = 1 / 40;                       // timing resolution (s); beats are multiples of 0.25 s
const PAT_HZ = 120;                           // pose table rate (3 steps per bin)
const PAT_VK = CFG.KITTY_SPEED;               // skating speed the rooms are designed for
const PAT_VMAX = CFG.KITTY_SPEED * 0.9;
const PAT_DRIFT_PERIOD = 60;                  // drifting wolves are back in step with their room within this (s)
const PAT_DRIFT_N = [9, 12];                  // a room's drifting wolves gain / lose whole laps every n beats (n in this
                                              // range, 8 in the slowest rooms), so they're back in step every n beats
const PAT_DRIFT_MU = [0.8, 1.4];              // a drifting wolf's speed vs its room's (as far as PAT_VMAX allows)
const PAT_ROW_SP = [1.35, 1.6];               // spacing within a row (units): under 2 * PAT_HIT, shoulder to shoulder
const PAT_ROW_GAP = 1.69;                     // a staggered row's neighbours stay closer than this (< 2 * PAT_HIT)
const patRowNeed = (k) => (k >= 3 ? Math.ceil(k / 4) : 0);   // wolves of a row of k that run at a speed of their own
const PAT_TYPES = ['charger', 'crosser', 'diagonal'];
// How many wolves a level has: level 1 ~2x the 116 of the first pattern design, +10% per level up to level 7.
// Rooms are packed by density G (shorter spacers, longer rows, wider fans); the count is then made exact with
// charger packs (followers in a charger's own lane) or, if a level came out over, by shortening its longest rows,
// then leaving out lone crossers.
const PAT_WOLVES_L1 = 232.6, PAT_WOLVES_GROWTH = 1.1, PAT_WOLVES_TOP = 7;
const PAT_PACK_MAX = 5;                       // wolves per charger lane, at most (lanes fill evenly: 4-5 only at level 6+)
const PAT_PACK_GAP = 2.2;                     // distance between pack members (units): 1-2x this, at random
const patWolfTarget = (level, finale) => finale ? FINALE_WOLVES : Math.round(PAT_WOLVES_L1 * ipow(PAT_WOLVES_GROWTH, Math.min(level, PAT_WOLVES_TOP) - 1));
const patDensity = (level) => Math.min(2, 1.2 + 0.14 * (Math.min(level, PAT_WOLVES_TOP) - 1));
const NO_FRAME = { ox: 0, oz: 0, ux: 1, uz: 0, nx: 0, nz: 1 };

function usableRanges(legs) {
  const W = CFG.RING_WIDTH, last = legs.length - 1;
  return legs.map((leg, li) => {
    let lo = (leg.padLo ?? W / 2 + CORNER_REST) + CFG.WOLF_RADIUS;
    let hi = leg.len - (leg.padHi ?? W / 2 + CORNER_REST) - CFG.WOLF_RADIUS;
    // the spiral's final stretch: neither corner is safe; the final run's last room keeps its entry gap (padHi)
    if (li === last) { lo = -W / 2 + WOLF_MARGIN; if (leg.padHi == null) hi = leg.len + W / 2 - WOLF_MARGIN; }
    if (li === 0) hi = leg.len - W / 2 - CFG.START_SAFE_ARC - CFG.WOLF_RADIUS;
    return { lo, hi: Math.max(lo, hi) };
  });
}

// --- pattern library. Every wolf runs end to end: crossers / diagonals go wall to wall, chargers run the whole
// leg between the two safe squares (edge to edge), turning straight round at each end.
// Segment builders return { name, depth, wolves } with th in [0, depth] (depth = the end the kitty meets first);
// wolf: { type, route: [{r, th}], loop, offT (fraction of its own cycle), offS (s) }. c = { D, rng, vOut }.

function segCrosswalk(c, o = {}) {
  const { rng, vOut } = c, G = c.G || 0;
  let k = o.k || Math.max(1, 1 + Math.floor(c.D * 2.5 + G * 2 + rng.next() * 1.6));
  // rows walk shoulder to shoulder (PAT_ROW_SP: the kitty can't slip between two neighbours): line = abreast, wave /
  // anti = abreast with a slight stagger one way or the other, split = two halves starting on opposite walls. Rows
  // only open up through their wolves' speed differences (placeLeg). comb (alternate sides) is for the final door.
  let variant = o.variant || (k === 1 ? 'single' : rng.pick(k >= 4 && rng.chance(0.25) ? ['split'] : ['line', 'line', 'wave', 'anti']));
  const g = Math.min(1, G);
  let sp = rng.range(PAT_ROW_SP[0], PAT_ROW_SP[1]);
  if (k > 1) {     // (a lone crosser draws nothing more)
    if (!o.k) k += Math.floor(G * 2 * rng.next());
    k = Math.min(k, 3 + Math.round(3 * g * rng.next()) + (rng.chance(0.15 * g) ? 1 : 0), 1 + Math.floor((o.room ?? 99) / sp));
  }
  if (k === 1) { sp = 0; if (!o.variant) variant = 'single'; }
  if (variant === 'split' && k < 4) variant = 'line';
  const side = rng.chance(0.5) ? 1 : -1, half = variant === 'split' ? Math.round(k * rng.range(0.35, 0.65)) : 0;
  const wolves = [];
  for (let i = 0; i < k; i++) {
    const s = (variant === 'comb' && i % 2) || (variant === 'split' && i >= half) ? -side : side;
    const th = (k - 1 - i) * sp;
    const w = { type: 'crosser', route: [{ r: -s * vOut, th }, { r: s * vOut, th }], offT: 0, offS: 0 };
    // stagger (in units of one step: set once the speed is known, see legDesign)
    w.stag = variant === 'wave' ? -i : variant === 'anti' ? i : 0;
    wolves.push(w);
  }
  return { name: 'crosswalk-' + variant, depth: (k - 1) * sp, wolves, sp };
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
    // parallel swings shoulder to shoulder (a row at an angle); denser levels fan out wider
    const sp = rng.range(PAT_ROW_SP[0], PAT_ROW_SP[1]);
    const m = Math.max(2, Math.min(2 + Math.floor((c.G || 0) * rng.next() * 2.5), 1 + Math.floor(((o.room ?? 99) - d) / sp)));
    depth = d + (m - 1) * sp;
    wolves = [...Array(m).keys()].map((i) => ({ type: 'diagonal', route: [{ r: A, th: i * sp }, { r: B, th: d + i * sp }], offT: 0, offS: 0 }));
  } else wolves = [{ type: 'diagonal', route: [{ r: A, th: 0 }, { r: B, th: d }], offT: 0, offS: 0 }];
  return { name: 'diagonal-' + variant, depth, wolves };
}

const PAT_FAMILIES = { crosswalk: segCrosswalk, diagonal: segDiagonal };
// Level 1 eases in: two legs of plain crossers, then the first charger lane; after that it's the real thing.
// Each lesson: [chargers (lanes) or null = random, segments to cycle through]. Lessons are packed with density
// PAT_LESSON_G (busier than they used to be, still one idea per room).
const PAT_LESSONS = [
  [[], [['crosswalk', { k: 1 }], ['crosswalk', { k: 1 }], ['crosswalk', { k: 2, variant: 'wave' }]]],
  [[], [['crosswalk', { k: 3, variant: 'wave' }], ['crosswalk', { k: 1 }]]],
  [[0], [['crosswalk', { k: 1 }], ['crosswalk', { k: 2, variant: 'comb' }], ['crosswalk', { k: 3, variant: 'wave' }]]],
];
const PAT_LESSON_G = 0.6;

// --- timing helpers

// Fits the wolf's speed so it runs its route there and back in exactly Tw seconds (false: it would be too fast).
function patFit(w, Tw) {
  w.speed = patternSpeed(w, Tw);
  return w.speed > 0 && w.speed <= PAT_VMAX && Math.abs(buildPlan(w, NO_FRAME, w.speed).cycle - Tw) < 1e-9;
}

// Pose table over one lap (w.cycle) at PAT_HZ; w.M = table steps per lap (a whole number: laps are beats).
function patTable(w) {
  const plan = buildPlan(w, NO_FRAME, w.speed);
  w.cycle = plan.cycle;
  w.M = Math.round(plan.cycle * PAT_HZ);
  w.tr = new Float64Array(w.M); w.tth = new Float64Array(w.M);
  for (let i = 0; i < w.M; i++) { const p = patternPose(plan, i / PAT_HZ); w.tr[i] = p.r; w.tth[i] = p.th; }
}

function patPoseIdx(w, t) {
  let tc = (t + w.off) % w.cycle;
  if (tc < 0) tc += w.cycle;
  return Math.min(w.M - 1, Math.floor(tc * PAT_HZ));
}

function placePatternEnemies(rng, lvl, p) {
  const { legs, seed, level } = lvl;
  const W = CFG.RING_WIDTH;
  const vOut = W / 2 - WOLF_MARGIN;
  const ranges = usableRanges(legs);
  const last = legs.length - 1;
  const door = lvl.finale ? -1 : last;   // the spiral's final stretch (door before the goal); the final run has none
  const enemies = [];
  const plans = [];
  const G0 = patDensity(level);
  const target = patWolfTarget(level, lvl.finale);
  const frameOf = (leg) => ({ ox: leg.ox, oz: leg.oz, ux: leg.ux, uz: leg.uz, nx: leg.nx, nz: leg.nz });
  const finish = (w, leg) => {
    w.rMin = Math.min(...w.route.map((q) => q.r)); w.rMax = Math.max(...w.route.map((q) => q.r));
    w.thMin = Math.min(...w.route.map((q) => q.th)); w.thMax = Math.max(...w.route.map((q) => q.th));
    w.frame = frameOf(leg);
  };

  // Chargers: full-length runners in fixed lanes (solver lanes, so the lanes between them stay open). They
  // own their lane all the time, so they don't need the room's beat. A leg's chargers share one speed and take
  // turns: their laps (5-35 s) would need speeds up to 60% apart to come back into step within PAT_DRIFT_PERIOD.
  const chargerLanes = (li, D) => {
    if (li === door) return [];
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
    const off = rng.next();
    // lanes run at different speeds where they can: laps P / m (m = n +- 0..2) all fit the period P = n * lap
    // (P <= PAT_DRIFT_PERIOD), so the lanes come back into step every P seconds
    const ms = [];
    return lanes.map((r, i) => {
      const w = { type: 'charger', route: [{ r, th: lo }, { r, th: hi }], loop: false, speed: v };
      finish(w, leg);
      const lap = buildPlan(w, NO_FRAME, v).cycle, n = Math.floor(PAT_DRIFT_PERIOD / lap + 1e-9);
      if (n >= 3) {
        for (const m of rng.shuffle([n, n - 1, n + 1, n - 2, n + 2])) {
          if (ms.includes(m)) continue;
          const vm = patternSpeed(w, n * lap / m);
          if (vm >= 0.75 * v && vm <= PAT_VMAX) { w.speed = vm; ms.push(m); break; }
        }
      }
      w.cycle = buildPlan(w, NO_FRAME, w.speed).cycle;
      w.off = ((off + i / lanes.length) % 1) * w.cycle;     // they take turns running at you
      return w;
    });
  };

  const legDesign = (li, D, T0, doorK = 0) => {
    const leg = legs[li];
    const { lo, hi } = ranges[li];
    const lesson = level === 1 ? PAT_LESSONS[li] : null;
    const G = lesson ? PAT_LESSON_G : G0;
    // gap between segments: their nearest rows are at least 2 * PAT_SAFE * 0.7 (~1.6) apart
    const spacer = () => (Math.max(2.4, 8 - 5.5 * D) + rng.range(-0.8, 1.2)) * Math.max(0.1, 1 - 0.8 * G) + 2 * PAT_SAFE * Math.max(0.7, 1 - 0.3 * G);
    const c = { D, G, rng, vOut };
    // the room's beat T: every crosser / diagonal runs there and back once per T (at the speed that takes); some
    // drift a little off it (placeLeg)
    const T = T0 || Math.round(Math.max(5, 7.5 - 2 * D) * 4) / 4;
    const fit = (w) => patFit(w, T);
    const segs = [];
    let cursor = li === door ? Math.min(hi, leg.len - W / 2 - 2.0) : hi - rng.range(0, 1.2);
    for (let n = 0; n < 30; n++) {
      let made = null;
      for (let tries = 0; tries < 5 && !made; tries++) {
        let fam = 'crosswalk', opt = {};
        if (lesson) [fam, opt] = lesson[1][n % lesson[1].length];
        else if (li === door) opt = doorK ? { k: 1 } : { k: D < 0.5 ? 1 : 2, variant: 'comb' };     // the final door
        else if (D >= 0.3 && rng.chance(0.3)) fam = 'diagonal';
        if (tries > 2) { fam = 'crosswalk'; opt = { k: 1 }; }
        const sd = PAT_FAMILIES[fam](c, { room: cursor - lo, ...opt });
        if (cursor - sd.depth < lo + 0.01) continue;
        const base = cursor - sd.depth;
        for (const w of sd.wolves) {
          w.route = w.route.map((q) => ({ r: q.r, th: q.th + base }));
          finish(w, leg);
        }
        if (!sd.wolves.every(fit)) continue;
        // a staggered row: each wolf a step behind (wave) / ahead (anti) of its neighbour, small enough that two
        // neighbours stay closer than PAT_ROW_GAP even mid-crossing
        for (const w of sd.wolves) if (w.stag) w.offS = w.stag * Math.min(sd.sp / PAT_VK, Math.sqrt(PAT_ROW_GAP * PAT_ROW_GAP - sd.sp * sd.sp) / w.speed);
        made = { ...sd, family: fam, top: cursor + PAT_SAFE, bottom: base - PAT_SAFE, base };
      }
      if (!made) break;
      segs.push(made);
      if (li === door) break;
      cursor = made.base - spacer();
      if (cursor < lo) break;
    }
    for (const sg of segs) for (const w of sg.wolves) {
      patTable(w);
      w.off = w.offT * w.cycle + w.offS;
    }
    return { segs, T, D };
  };

  // A room's timing (no launch-window solver: rooms are built as designed). Each segment gets a random timing offset,
  // chosen so that about half the room's rows start the level nearer the other wall. Drifting wolves: each row of 3+
  // gets at least one wolf in four (patRowNeed, sometimes more, spread along the row so gaps open in different places)
  // on lap T / mu, mu = 1 + j / n (n in PAT_DRIFT_N, j laps gained / lost every n beats, mu within PAT_DRIFT_MU);
  // lone crossers, pairs and scissors now and then (calm: level 1's lessons and the final door, only their rows). The
  // room repeats every n beats (<= PAT_DRIFT_PERIOD s).
  const placeLeg = (li, design, chargers, calm) => {
    const { segs, T } = design;
    const N = Math.round(T / PAT_BIN);
    const nTop = Math.min(PAT_DRIFT_N[1], Math.floor(PAT_DRIFT_PERIOD / T + 1e-9));
    const n = nTop <= PAT_DRIFT_N[0] ? nTop : PAT_DRIFT_N[0] + Math.floor(rng.next() * (nTop - PAT_DRIFT_N[0] + 1));
    let period = 0;
    // j laps more (j > 0) or fewer (j < 0) every n beats: any whole j != 0 with 1 + j / n within PAT_DRIFT_MU
    const jLo = Math.max(1, Math.floor((1 - PAT_DRIFT_MU[0]) * n + 1e-9)), jHi = Math.max(1, Math.floor((PAT_DRIFT_MU[1] - 1) * n + 1e-9));
    const sign = () => { const k = 1 + Math.floor(rng.next() * (jLo + jHi)); return k <= jLo ? -k : k - jLo; };
    // too fast for PAT_VMAX: fewer extra laps, down to none (then a lap less)
    const drift = (w, j) => {
      for (let jj = j; jj !== 0; jj = jj > 1 ? jj - 1 : jj === 1 ? -1 : 0) {
        const v = patternSpeed(w, w.cycle / (1 + jj / n));
        if (v > 0 && v <= PAT_VMAX) { w.speed = v; w.drift = true; period = n * T; return; }   // w.cycle (the beat) stays its phase reference
      }
    };
    // c wolves of a row spread along it: one from each of c even stretches
    const spread = (ws, c) => [...Array(c).keys()].map((q) => {
      const a = Math.floor(q * ws.length / c), b = Math.floor((q + 1) * ws.length / c);
      return ws[a + Math.floor(rng.next() * (b - a))];
    });
    const sides = rng.shuffle(segs.map((_, i) => (i % 2 ? 1 : -1)));
    const sideAt = (seg, s) => { const w = seg.wolves[0], i = patPoseIdx(w, s * PAT_BIN); return w.tr[i] >= 0 ? 1 : -1; };
    segs.forEach((seg, si) => {
      const ws = seg.wolves;
      let s = Math.floor(rng.next() * N);
      if (sideAt(seg, s) !== sides[si]) s = (s + Math.round(N / 2)) % N;     // half a lap on: the other wall
      for (const w of ws) w.off += s * PAT_BIN;
      if (seg.name === 'diagonal-scissors') {      // both or neither, on one drift (so they never meet)
        if (!calm && rng.chance(0.6)) { const j = sign(); ws.forEach((w) => drift(w, j)); }
      } else if (patRowNeed(ws.length)) {
        const need = patRowNeed(ws.length), most = Math.max(need, Math.floor(ws.length / 2));
        for (const w of spread(ws, need + Math.floor(rng.next() * (most - need + 1)))) drift(w, sign());
      } else if (!calm && rng.chance(ws.length === 1 ? 0.4 : 0.5)) drift(rng.pick(ws), sign());
    });
    const open = PAT_LANES.map((r) => chargers.every((w) => Math.abs(w.route[0].r - r) >= PAT_SAFE + 0.3));
    const kept = segs.slice();
    if (chargers.length) kept.unshift({ name: 'chargers', top: ranges[li].hi + PAT_SAFE, bottom: ranges[li].lo - PAT_SAFE, wolves: chargers, chargers: true });
    if (!kept.length) return null;
    return { leg: li, beat: T, period, segs: kept, open };
  };

  const heat = p.patternHeat || 0;
  for (let li = 0; li < legs.length; li++) {
    const lesson = level === 1 && li < PAT_LESSONS.length;
    const D = lesson ? 0.1 * li : Math.min(1.6, heat + 0.5 * li / Math.max(1, last));
    if (li === door) {
      // final stretch: the door before the goal, on the beat of the room before it
      const prev = plans.length && plans[plans.length - 1].leg === li - 1 ? plans[plans.length - 1] : null;
      const pl = placeLeg(li, legDesign(li, D, prev ? prev.beat : 0), [], true);
      if (pl) plans.push({ ...pl, finale: true });
      continue;
    }
    const chargers = makeChargers(li, D, chargerLanes(li, D));
    const pl = placeLeg(li, legDesign(li, D, 0), chargers, lesson);
    if (pl) plans.push(pl);
  }

  // ---- wolf count: exactly `target` where the rooms allow it (see PAT_WOLVES_L1). Not in level 1's lessons.
  const tamed = (pl) => pl.finale || (level === 1 && pl.leg < PAT_LESSONS.length);
  let count = plans.reduce((a, pl) => a + pl.segs.reduce((b, sg) => b + sg.wolves.length, 0), 0);
  const packs = [];
  for (const pl of plans) {
    const cs = tamed(pl) ? null : pl.segs.find((sg) => sg.chargers);
    if (cs) for (const lead of cs.wolves.slice()) packs.push({ cs, lead, n: 1, back: 0 });
  }
  while (count < target && packs.length) {
    const n = Math.min(...packs.map((pk) => pk.n));
    if (n >= PAT_PACK_MAX) break;
    const cand = packs.filter((pk) => pk.n === n), pk = cand[Math.floor(rng.next() * cand.length)];
    const w = { ...pk.lead, route: pk.lead.route.map((q) => ({ ...q })) };
    pk.back += rng.range(PAT_PACK_GAP, 2 * PAT_PACK_GAP);       // following the leader down its lane, loosely
    w.off = pk.lead.off - pk.back / pk.lead.speed;
    pk.cs.wolves.push(w); pk.n++; count++;
  }
  // over: the longest rows lose an end wolf (fewer wolves only widen the gaps), keeping their drifting share
  const trimEnd = (sg) => {
    const ws = sg.wolves, k = ws.length, drift = ws.filter((w) => w.drift).length;
    return [ws[k - 1], ws[0]].find((w) => drift - (w.drift ? 1 : 0) >= patRowNeed(k - 1));
  };
  while (count > target) {
    let best = null;
    for (const pl of plans) if (!tamed(pl)) for (const sg of pl.segs) {
      if (!sg.chargers && sg.name !== 'diagonal-scissors' && sg.wolves.length > 2 && trimEnd(sg) && (!best || sg.wolves.length > best.wolves.length)) best = sg;
    }
    if (best) { best.wolves.splice(best.wolves.indexOf(trimEnd(best)), 1); count--; continue; }
    // ...then lone crossers go, at random
    const lone = plans.filter((pl) => !tamed(pl)).flatMap((pl) => pl.segs.filter((sg) => sg.name === 'crosswalk-single').map((sg) => [pl, sg]));
    if (!lone.length) break;
    const [pl, sg] = lone[Math.floor(rng.next() * lone.length)];
    pl.segs.splice(pl.segs.indexOf(sg), 1); count--;
  }

  // ---- specs (a drifting wolf keeps its phase in the beat: at level start it is exactly in step)
  for (const pl of plans) {
    for (const seg of pl.segs) for (const w of seg.wolves) {
      const id = enemies.length;
      enemies.push({
        id, type: w.type, leg: pl.leg, frame: w.frame,
        rIn: w.rMin, rOut: w.rMax, a0: w.thMin, a1: w.thMax,
        speed: w.speed,
        phase: Math.round((((w.off % w.cycle) + w.cycle) % w.cycle) / w.cycle * 1e9) / 1e9,
        seed: hashSeed(seed, level, 'wolf', id),
        route: w.route, loop: !!w.loop,
        pattern: seg.name,
      });
    }
  }
  const r3 = (x) => Math.round(x * 1000) / 1000;
  // Skate only, per leg (for tests / tooling): its beat, the period it repeats with (n beats if some wolves drift),
  // the lanes no charger runs in; finale = the door of the final stretch
  lvl.patternPlan = plans.map((pl) => ({
    leg: pl.leg, beat: pl.beat, period: r3(pl.period || pl.beat), finale: !!pl.finale,
    lanes: pl.finale ? undefined : PAT_LANES.filter((_, k) => pl.open[k]),
    segs: pl.segs.map((sg) => ({ name: sg.name, top: r3(sg.top), bottom: r3(sg.bottom), n: sg.wolves.length })),
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
      const { x, z } = legPoint(leg, lat, along);
      if (!okSpot(x, z)) continue;
      items.push({ id: items.length, type, x, z });
      break;
    }
  }
  return items;
}

// Every level but the final run: two safe squares are checkpoints (see sim.js): the one nearest 1/3 of the way along
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
    trees.push({ ...legPoint(l, v, s), leg: i });
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
  const finale = FINAL_MODES.includes(mode) && L === SKATE_FINAL_LEVEL;
  const straight = finale ? buildStraight(createRng(hashSeed(seed, L, 'straight'))) : null;
  const { walls, legs, corners, wallCorners, outer } = straight || buildSpiral();
  const path = finale ? buildStraightPath(corners) : buildPath(corners, legs);

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
    safeCorners: finale ? corners.slice(0, 1) : corners.slice(0, -2),   // wolf-free squares (not the two corners of the final stretch; the final run: just the start)
    startAngle: heading,
    spawnPoints,
    enemies: [],
    items: [],
    path,
    theme: CFG.ICE_TEST || mode === 'ice' || finale ? ICE_THEME : mode === 'mixed' ? MIXED_THEME_ORDER[(L - 1) % 3] : THEME_ORDER[(L - 1) % 4], // run mode: winter just isn't ice
    mode,
    finale,
  };
  lvl.ice = mode !== 'run' && lvl.theme === ICE_THEME;
  lvl.checkpoints = !finale ? pickCheckpoints(corners, legs, lvl.safeCorners.length) : [];
  // the crown: floats over the middle of the goal room (above the portal)
  lvl.crown = { x: 0, z: 0 };
  if (finale) {
    lvl.loops = 0;
    lvl.runLength = straight.length;              // start square center -> goal center
    const t = straight.tree, leg = legs.findIndex((l) => l.ox === t.x);
    lvl.trees = [{ x: t.x, z: t.z, leg }];
  } else {
    lvl.trees = lvl.theme === TREE_THEME && !lvl.ice ? placeTrees(createRng(hashSeed(seed, L, 'trees')), legs) : [];
  }
  lvl.enemies = mode === 'ice' || finale ? placePatternEnemies(rng, lvl, p) : placeEnemies(rng, lvl, p);   // the boss run has pattern wolves in every mode
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
  if (levelData.finale && inTree(levelData, x, z)) return false;   // the final run's tree: up there you can sit still
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

function checkPatternWolves(ld, P, stats) {
  const ranges = usableRanges(ld.legs);
  const vOut = CFG.RING_WIDTH / 2 - WOLF_MARGIN, eps = 1e-6;
  if (ld.enemies.length < 40) P(`few pattern wolves ${ld.enemies.length}`);
  const target = patWolfTarget(ld.level, ld.finale);
  if (ld.enemies.length !== target) P(`${ld.enemies.length} pattern wolves, not ${target}`);
  if (!ld.patternPlan || ld.patternPlan.length < ld.legs.length - 3) P(`rooms missing: ${ld.patternPlan ? ld.patternPlan.length : 0} planned legs`);
  const beat = new Map((ld.patternPlan || []).map((pl) => [pl.leg, pl.beat]));
  const period = new Map((ld.patternPlan || []).map((pl) => [pl.leg, pl.period]));
  const chargerLaps = new Map();
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
    // end to end: crossers / diagonals wall to wall; chargers the whole leg, safe square (or gap) to safe square
    if (e.loop || e.route.length !== 2) { P(`${tag}: route is not a single end-to-end run`); continue; }
    else if (e.type === 'charger') {
      const [A, B] = e.route;
      if (Math.abs(A.r - B.r) > eps || Math.abs(Math.min(A.th, B.th) - rg.lo) > eps || Math.abs(Math.max(A.th, B.th) - rg.hi) > eps) P(`${tag}: charger does not run the whole leg`);
      if (!chargerLaps.has(e.leg)) chargerLaps.set(e.leg, []);
      chargerLaps.get(e.leg).push(buildPlan(e, e.frame, e.speed).cycle);
    } else {
      const [A, B] = e.route;
      if (Math.abs(Math.abs(A.r) - vOut) > eps || Math.abs(Math.abs(B.r) - vOut) > eps || Math.sign(A.r) === Math.sign(B.r)) P(`${tag}: does not run wall to wall`);
      if (e.type === 'crosser' && Math.abs(A.th - B.th) > eps) P(`${tag}: crosser not straight across`);
    }
    if (e.hold != null) P(`${tag}: has a hold (wolves never pause)`);
    if (e.type !== 'charger') {
      // its lap divides the leg beat T, or it drifts: back in step with the beat within PAT_DRIFT_PERIOD, and the leg's
      // period (n beats) is a whole number of its laps
      const cyc = buildPlan(e, e.frame, e.speed).cycle, T = beat.get(e.leg), base = T / Math.max(1, Math.round(T / cyc));
      if (!T) P(`${tag}: leg has no beat`);
      else if (Math.abs(cyc - base) > 1e-4) {
        const back = base * cyc / Math.abs(base - cyc), per = period.get(e.leg);
        if (back > PAT_DRIFT_PERIOD + 1e-6) P(`${tag}: lap ${cyc.toFixed(3)} drifts back into step with the beat ${T} only every ${back.toFixed(1)}s`);
        if (!(per > T && per <= PAT_DRIFT_PERIOD + 1e-6) || Math.abs(cyc * Math.round(per / cyc) - per) > 1e-3) P(`${tag}: lap ${cyc.toFixed(3)} does not divide the leg's period ${per}`);
      }
    }
    const f = e.frame, pts = e.route;
    let clip = 0, unsafe = 0;
    for (let k = 1; k < pts.length; k++) {
      const A = pts[k - 1], B = pts[k], n = Math.max(1, Math.ceil(Math.hypot(B.r - A.r, B.th - A.th) / 0.25));
      for (let t = 0; t <= n; t++) {
        const r = A.r + (B.r - A.r) * t / n, th = A.th + (B.th - A.th) * t / n;
        const { x, z } = legPoint(f, r, th);
        if (collideCircle(ld, x, z, CFG.WOLF_RADIUS).hit) clip++;
        for (const sp of ld.spawnPoints) if (Math.hypot(sp.x - x, sp.z - z) < CFG.START_SAFE_ARC) unsafe++;
      }
    }
    if (clip) P(`${tag}: route clips walls (${clip})`);
    if (unsafe) P(`${tag}: route enters the start safe area`);
  }
  // a leg's charger lanes may run at different speeds, but come back into step within PAT_DRIFT_PERIOD
  for (const [leg, laps] of chargerLaps) {
    const L = Math.max(...laps);
    let ok = false;
    for (let j = 1; j * L <= PAT_DRIFT_PERIOD + 1e-6 && !ok; j++) ok = laps.every((c) => Math.abs(j * L / c - Math.round(j * L / c)) * c < 1e-3);
    if (!ok) P(`leg ${leg}: chargers never back in step with each other within ${PAT_DRIFT_PERIOD}s`);
  }
  // Skate only rooms (the final run's too) are built as designed: no launch-window / wait checks (the user
  // playtests their balance)
  for (const pl of ld.patternPlan || []) if (pl.period > pl.beat && !pl.finale) stats.iceDriftRooms++;
  stats.iceRooms += (ld.patternPlan || []).filter((pl) => !pl.finale).length;
  stats.iceWolves += ld.enemies.length;
}

function mazeSelfTest(levels = 12, modes = ['mixed', 'ice']) {
  const problems = [];
  const seeds = [1, 42, 1337, 9001, 'kitty', 777777];
  const stats = { levels: 0, avgPathLen: 0, enemies: 0, items: 0, iceWolves: 0, iceRooms: 0, iceDriftRooms: 0 };
  for (const mode of modes) for (const s of seeds) {
    for (let l = 1; l <= levels; l++) {
      const P = (s, l, msg) => { if (problems.length < 200) problems.push(`${mode} seed ${s} L${l}: ${msg}`); };
      const ld = generateLevel(l, s, mode);
      const p = levelParams(l);
      const pattern = mode === 'ice' || ld.finale;
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
            const { x, z } = legPoint(f, r, a);
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

// Cheap fingerprint of a generated level (wolf specs without their shared leg frames, and items): the server sends
// it with each level so clients can report a level they generated differently (e.g. a float op that differs between
// JS engines). JSON number formatting is exact and engine independent.
function levelHash(ld) {
  return hashSeed(JSON.stringify([(ld.enemies || []).map(({ frame, ...s }) => s), ld.items || []]));
}

export { generateLevel, collideCircle, locate, inCenter, onIce, inTree, mazeSelfTest, levelHash };
