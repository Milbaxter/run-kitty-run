import { CFG, levelParams, SKATE_FINAL_LEVEL } from './config.js';
import { createRng, hashSeed } from './rng.js';
import { buildPlan, patternPose, patternSpeed, EASE_T, createEnemies, updateEnemies } from './enemies.js';

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
// Each room has 2-3 charger lanes (more toward the goal) and is packed as a horde of wolves that each go their own
// way (finaleDesign, FINALE_PACK): no rows or formations. Every wolf of a kind runs at the same speed (FINALE_SPEED),
// but each crosser / diagonal stands at the walls for its own fixed time (FINALE_HOLD) and starts at its own random
// phase, so the wolves have different laps and the room's pattern keeps shifting. The laps are all FINALE_PERIOD / n
// (whole n; the holds are fitted to that), so a room does repeat, every FINALE_PERIOD s, and fairRoom checks it
// over one whole period: a straight skate down some free lane from the gap's middle, at every boot speed, finds a
// launch window of FINALE_FAIR.win at least every FINALE_FAIR.wait seconds; wolves that would break that are
// retimed or left out. mazeSelfTest replays it with the real wolves (finaleGaps).

// Legs follow the spiral's conventions: leg i runs from corner i (s = len, where the kitty enters) to corner
// i + 1 (s = 0); u points back toward the start (run direction is -u). leg.padHi / leg.padLo = wolf-free
// half-gap at the entry / exit end (usableRanges).

const FINALE_GAP = 6.5;          // wolf-free ice between two rooms (wolf bodies), enough for a tight skating circle
const FINALE_TREE_GAP = 13;      // ...around the halfway tree
const FINALE_ROOM = [34, 52];    // room lengths
const FINALE_HEAT = 0.8;         // pattern difficulty at the start of the run...
const FINALE_RAMP = 0.7;         // ...rising by this much toward the goal
// The horde: the final run packs its rooms far tighter than the spiral (~2x the wolves). It must not look like a
// machine: wolves are placed one by one at random distances (finaleDesign) and each has its own hold and phase.
const FINALE_PACK = {
  diagonal: 0.08,        // share of diagonal swings...
  looper: 0.06,          // ...and of lone loopers; the rest are crossers
  gap: [1.35, 3.4],      // from one wolf to the next (th): shoulder to shoulder (no kitty fits between) to far apart...
  gapPow: 3,             // ...mostly close
  chargers: 1.5,         // pushes the charger lanes toward 3 per room
};
// one speed per kind of wolf for the whole run (units/s): same colour, same pace
const FINALE_SPEED = { crosser: 3.4, diagonal: 3.6, looper: 4.0, charger: 5.2 };
const FINALE_HOLD = [0, 1.5];     // a crosser's / diagonal's own wait at each wall (s); loopers never stop
const FINALE_PERIOD = 180;        // every wolf's lap divides this (s): a room repeats, so its check is exact
// fairness (fairRoom): every boot speed, any free lane, all period round
const FINALE_FAIR = { win: 0.4, wait: 6, tries: 6 };   // a good launch (s clear) at least every `wait` s

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
// In Skate only (mode 'ice') wolves don't wander: each runs a fixed route at a fixed rhythm (see the
// pattern section of enemies.js), so a leg is a "room" the kitty studies from the safe corner square and
// then skates through in one go (it can't stop on ice).
//
// Every wolf runs end to end and never stands still: it turns straight round at each end.
//   charger    runs the whole leg in a fixed lane, from the edge of one safe square to the next and back. Charger
//              lanes are solver lanes, so the lanes between them stay open; they own their lane all the time
//              (go beside them). A leg's chargers share one speed and take turns.
//   crosser    crosses the lane wall to wall, in rows (crosswalk: single / wave / comb / ripple / anti offsets)
//   diagonal   crosses wall to wall at an angle (swing, scissors = two crossing half a beat apart, fan)
//   looper     the final run only: a lone looper round a box or diamond spanning the lane (segCarousel, n = 1)
// (The final run has no rows or formations: finaleDesign / fairRoom give every wolf its own hold and phase.)
// A leg = a set of charger lanes + crosser / diagonal segments top (entry, high th) to bottom. Every crosser
// and diagonal in a leg runs there and back once per beat T (its speed is fitted to the beat), so the room
// repeats every T seconds. Each segment's timing offset is chosen by a launch-window solver (solveLeg): a kitty
// skating straight down a free lane (one of PAT_LANES) at full speed, leaving the corner at the right moment,
// gets through the whole leg with spare clearance (PAT_SAFE) and spare timing (PAT_SLACK), also with 1-4 pairs
// of speed boots, and the lane stays open for a fair share of the beat. Segments that would (nearly) close the
// room fall back to a single crosser or are dropped: never an impossible wall.
// Drift (driftLeg): in most rooms one group (one or two wolves of a row, a scissors or a fan, or a lone crosser)
// runs a little faster or slower, so the pattern slides out of step and back: its lap is T / (1 +- 1/n) with
// n = floor(PAT_DRIFT_PERIOD / T), so it gains or loses exactly one lap every n beats and the whole room repeats
// every n * T <= PAT_DRIFT_PERIOD seconds. One group per room keeps it periodic with that short period, so the
// generator can replay the solution lane bin by bin over the whole period: it keeps the group only if every beat
// still meets the room's launch-window targets (the drift may use up the spare timing, never more) and every boot
// speed still finds a gap; otherwise it tries another group or the other direction, or the room keeps its beat.
// mazeSelfTest replays each leg's solution against the real wolves over its whole period (a gap at least every 10 s).
// Level 1's first legs ease in (PAT_LESSONS, no drift); difficulty D = levelParams().patternHeat + 0.5 * depth
// drives the beat (and so the wolf speed), density, charger speed and lanes, variants and the launch-window targets.

const PAT_HIT = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
const PAT_SAFE = PAT_HIT + 0.3;               // solver clearance (spare room for imperfect skating)
const PAT_LANES = [-3.6, -1.8, 0, 1.8, 3.6];   // solver lanes: center, middles, near the walls (hugging a wall on ice is no fun)
const PAT_BIN = 1 / 40;                       // solver time resolution (s); beats are multiples of 0.25 s
const PAT_HZ = 120;                           // pose table rate (3 steps per bin)
const PAT_VK = CFG.KITTY_SPEED;               // skating speed the rooms are designed for
const PAT_VMAX = CFG.KITTY_SPEED * 0.9;
const PAT_HARD = 0.3;                         // never accept a leg whose launch window is shorter (s)
const PAT_FRAC_MIN = 0.07;                    // ...or whose best lane is open for less of the beat
const PAT_BOOSTS = [1.05, 1.1, 1.15, 1.2];    // rooms must also stay passable with 1-4 pairs of speed boots
const PAT_SPEEDS = [PAT_VK].concat(PAT_BOOSTS.map((m) => PAT_VK * m));
const PAT_SLACK = 0.4;                        // spare time kept on both sides of every wolf's pass (s): how densely the
                                              // rooms are packed for the same launch-window targets
const PAT_DRIFT_PERIOD = 60;                  // a drifting group is back in step with its room within this (s)
const PAT_DRIFT_CHANCE = 0.75;                // rooms (after level 1's lessons) that get a drifting group, if one fits
const PAT_TYPES = ['charger', 'crosser', 'diagonal', 'looper'];   // looper: carousels, the final run only
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
  const { rng, vOut } = c;
  let sp = o.sp ? rng.range(o.sp[0], o.sp[1]) : rng.range(2.7, 3.6);
  const k = o.k || Math.max(o.kMin || 1, Math.min(4, 1 + Math.floor(c.D * 2.5 + rng.next() * 1.2), 1 + Math.floor((o.room ?? 99) / sp)));
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
    const sp = rng.range(2.8, 3.4), m = o.fanN || 2;
    depth = d + (m - 1) * sp;
    wolves = [];
    for (let i = 0; i < m; i++) wolves.push({ type: 'diagonal', route: [{ r: A, th: i * sp }, { r: B, th: d + i * sp }], offT: 0, offS: -(m - 1 - i) * sp / PAT_VK });
  } else wolves = [{ type: 'diagonal', route: [{ r: A, th: 0 }, { r: B, th: d }], offT: 0, offS: 0 }];
  return { name: 'diagonal-' + variant, depth, wolves };
}

// carousel (the final run only): two or three loopers chase each other round a loop spanning the lane, evenly spaced,
// a lap per beat: box = a rectangle (two crossings + a run along each wall), diamond = four diagonal runs
function segCarousel(c, o = {}) {
  const { rng, vOut } = c;
  const variant = o.variant || rng.pick(['box', 'diamond']);
  const n = o.n ? (variant === 'diamond' ? Math.min(3, o.n) : o.n) : variant === 'diamond' || rng.chance(0.5) ? 2 : 3;
  const d = variant === 'box' ? rng.range(2.4, 3.4) : rng.range(5, 6.5);
  let route = variant === 'box'
    ? [{ r: -vOut, th: 0 }, { r: vOut, th: 0 }, { r: vOut, th: d }, { r: -vOut, th: d }]
    : [{ r: 0, th: 0 }, { r: vOut, th: d / 2 }, { r: 0, th: d }, { r: -vOut, th: d / 2 }];
  if (rng.chance(0.5)) route = route.reverse();     // either way round
  const wolves = [];
  for (let i = 0; i < n; i++) wolves.push({ type: 'looper', route: route.map((q) => ({ ...q })), loop: true, offT: i / n, offS: 0 });
  return { name: 'carousel-' + variant, depth: d, wolves };
}

const PAT_FAMILIES = { crosswalk: segCrosswalk, diagonal: segDiagonal, carousel: segCarousel };
// Level 1 eases in: two legs of plain crossers, then the first charger lane; after that it's the real thing.
// Each lesson: [chargers (lanes) or null = random, segments to cycle through]
const PAT_LESSONS = [
  [[], [['crosswalk', { k: 1 }]]],
  [[], [['crosswalk', { k: 2, variant: 'wave' }], ['crosswalk', { k: 1 }]]],
  [[0], [['crosswalk', { k: 1 }], ['crosswalk', { k: 2, variant: 'comb' }]]],
];

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

// Inverse of the EASE_T speed profile (enemies.js profileS): time into a run of length L (time T, cruise v) at distance s.
function profileInv(s, T, L, v) {
  if (T <= 0 || L <= 0) return 0;
  const a = v / EASE_T, e = 0.5 * v * EASE_T;
  if (L >= v * EASE_T) {
    if (s <= e) return Math.sqrt(2 * s / a);
    if (s <= L - e) return EASE_T + (s - e) / v;
  } else if (s <= L / 2) return Math.sqrt(2 * s / a);
  return T - Math.sqrt(Math.max(0, 2 * (L - s) / a));
}

// Safe arrival times at a segment's top edge: ok[b] = 1 if a kitty reaching the top edge at b * PAT_BIN (b < N, a
// beat), skating straight down lane r at vk, clears wolf w by PAT_SAFE.
function wolfSafety(w, top, r, N, vk) {
  const ok = new Uint8Array(N).fill(1);
  if (r < w.rMin - PAT_SAFE || r > w.rMax + PAT_SAFE) return ok;
  const S2 = PAT_SAFE * PAT_SAFE, M = w.M, tr = w.tr, tth = w.tth;
  const t0 = Math.max(0, (top - (w.thMax + PAT_SAFE)) / vk), t1 = (top - (w.thMin - PAT_SAFE)) / vk;
  const fk = [], thk = [];      // per sample: pose table step at b = 0, and the kitty's th
  const sample = (t) => { fk.push(((Math.floor((t + w.off) * PAT_HZ) % M) + M) % M); thk.push(top - vk * t); };
  for (let t = t0; t < t1; t += 1 / 60) sample(t);
  sample(t1);
  const K = fk.length, spb = Math.round(PAT_BIN * PAT_HZ);
  for (let b = 0; b < N; b++) {
    const ib = (b * spb) % M;
    for (let k = 0; k < K; k++) {
      let i = ib + fk[k];
      if (i >= M) i -= M;
      const dr = tr[i] - r, dth = tth[i] - thk[k];
      if (dr * dr + dth * dth < S2) { ok[b] = 0; break; }
    }
  }
  return ok;
}

// Safe arrival times at a segment's top edge, per speed (PAT_SPEEDS) and lane: the AND of its wolves' own sets eroded
// by PAT_SLACK (w.E). Each wolf's exact sets stay on it too (w.R[speed][lane]) for driftLeg.
// open (the final run): lanes worth solving (not a charger's); the others get a dummy all-safe set
function segSafety(seg, N, slack = PAT_SLACK, open = null) {
  const J = Math.round(slack / PAT_BIN), ones = open && new Uint8Array(N).fill(1);
  for (const w of seg.wolves) {
    const c = w.memo;      // a fallback row reuses its full row's sets (same wolves, same top)
    if (c && c.top === seg.top && c.N === N && c.J === J) { w.R = c.R; w.E = c.E; continue; }
    w.R = PAT_SPEEDS.map((vk) => PAT_LANES.map((r, k) => (open && !open[k] ? ones : wolfSafety(w, seg.top, r, N, vk))));
    w.E = w.R.map((L) => L.map((a) => { if (a === ones) return ones; const e = new Uint8Array(N).fill(1); erodeAnd(e, a, J); return e; }));
    if (c) Object.assign(c, { top: seg.top, N, J, R: w.R, E: w.E });
  }
  return PAT_SPEEDS.map((_, j) => PAT_LANES.map((_, k) => {
    const ok = new Uint8Array(N).fill(1);
    for (const w of seg.wolves) { const e = w.E[j][k]; for (let b = 0; b < N; b++) ok[b] &= e[b]; }
    return ok;
  }));
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

function andShifted(f, a, s, N) { // out[b] = f[b] & a[(b + s) mod N]; a closed lane stays the shared CLOSED
  if (f.closed) return f;
  const o = new Uint8Array(N);
  s = ((s % N) + N) % N;
  let any = 0;
  for (let b = 0; b < N; b++) { any |= o[b] = f[b] & a[s]; if (++s === N) s = 0; }
  if (!any) o.closed = true;
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
    if (!f.closed) for (let t = 0; t < f.length; t++) n += f[t];
    const run = n ? maxRun(f) : 0, frac = n / f.length;
    if (run + 8 * frac > best.run + 8 * best.frac || (run === best.run && Math.abs(PAT_LANES[li]) < Math.abs(PAT_LANES[best.li]))) best = { li, run, frac };
  });
  return best;
}

// Drift check over a whole drift period: seqs = launch-time safe sets (circular, one per lane). True if every stretch
// of `per` bins holds a launch time with `win` safe bins ahead of it in one of the lanes.
function everyBeat(seqs, win, per) {
  const M = seqs[0].length, good = new Uint8Array(M);
  let any = false;
  for (const S of seqs) {
    let z = 0;
    while (z < M && S[z]) z++;
    if (z === M) return true;                           // never blocked
    for (let q = 0, ahead = 0; q < M; q++) {            // backwards from a blocked bin: safe bins ahead of each
      const i = (z - q + M) % M;
      ahead = S[i] ? ahead + 1 : 0;
      if (ahead >= win) { good[i] = 1; any = true; }
    }
  }
  if (!any) return false;
  let g = 0;
  while (!good[g]) g++;
  for (let q = 1, gap = 0; q <= M; q++) {
    if (good[(g + q) % M]) gap = 0;
    else if (++gap >= per) return false;
  }
  return true;
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

// For each launch bin (kitty at pts[0] at b * PAT_BIN), 1 if the path clears every wolf by `clear`, with `slack` s to spare.
function pathSafety(traj, wolves, N, clear, slack) {
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
    erodeAnd(ok, okw, Math.round(slack / PAT_BIN));
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
  const door = lvl.finale ? -1 : last;   // the spiral's final stretch (door before the goal); the final run has none
  const enemies = [];
  const plans = [];
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
    // the final run: every kind of charger set, 2-3 lanes at the start, 3 toward the goal
    const n = lvl.finale ? 1 + Math.min(2, Math.floor(3 * (0.67 * rng.next() + 0.33 * (D - FINALE_HEAT) / FINALE_RAMP) + FINALE_PACK.chargers))
      : D < 0.25 ? (rng.chance(0.6) ? 1 : 0) : D < 0.6 ? 1 + (rng.chance(0.6) ? 1 : 0) : D < 1 ? 2 + (rng.chance(D - 0.4) ? 1 : 0) : 3;
    const sets = {
      0: [[]], 1: [[0], [-1.8], [1.8], [-3.6], [3.6]],
      2: [[-1.8, 1.8], [-3.6, 3.6], [-3.6, 0], [0, 3.6], [-1.8, 3.6], [-3.6, 1.8]],
      3: [[-3.6, 0, 3.6], [-1.8, 1.8, -3.6], [-1.8, 1.8, 3.6], [-3.6, -1.8, 1.8]],
    };
    return rng.pick(sets[n]);
  };
  const makeChargers = (li, D, lanes) => {
    const leg = legs[li], { lo, hi } = ranges[li];
    const v = lvl.finale ? FINALE_SPEED.charger : Math.min(PAT_VMAX, (3.9 + 1.4 * D) * rng.range(0.95, 1.05));
    const off = rng.next();
    return lanes.map((r, i) => {
      const w = { type: 'charger', route: [{ r, th: lo }, { r, th: hi }], loop: false, speed: v };
      finish(w, leg);
      w.cycle = buildPlan(w, NO_FRAME, v).cycle;
      w.off = ((off + i / lanes.length) % 1) * w.cycle;     // they take turns running at you
      return w;
    });
  };

  const legDesign = (li, D, T0) => {
    const leg = legs[li];
    const { lo, hi } = ranges[li];
    const spacer = () => Math.max(2.4, 8 - 5.5 * D) + rng.range(-0.8, 1.2);
    const c = { D, rng, vOut };
    const lesson = level === 1 ? PAT_LESSONS[li] : null;
    // the room's beat: every crosser / diagonal runs there and back once per beat (at the speed that takes), so the
    // room repeats every T seconds
    const T = T0 || Math.round(Math.max(5, 7.5 - 2 * D) * 4) / 4;
    const fit = (w) => patFit(w, T);
    const segs = [];
    let cursor = li === door ? Math.min(hi, leg.len - W / 2 - 2.0) : hi - rng.range(0, 1.2);
    for (let n = 0; n < 30; n++) {
      let made = null;
      for (let tries = 0; tries < 5 && !made; tries++) {
        let fam = 'crosswalk', opt = {};
        if (lesson) [fam, opt] = lesson[1][n % lesson[1].length];
        else if (li === door) opt = { k: D < 0.5 ? 1 : 2, variant: 'comb' };     // the final door
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
        made = { ...sd, family: fam, top: cursor + PAT_SAFE, bottom: base - PAT_SAFE, base };
        if (sd.wolves.length > 1 || fam !== 'crosswalk') {
          // plan B if this one would close the room: a single crosser where the segment starts
          const alt = segCrosswalk(c, { k: 1 });
          for (const w of alt.wolves) { w.route = w.route.map((q) => ({ r: q.r, th: cursor })); finish(w, leg); }
          if (alt.wolves.every(fit)) made.alt = { ...alt, family: 'crosswalk', top: cursor + PAT_SAFE, bottom: cursor - PAT_SAFE, base: cursor };
        }
      }
      if (!made) break;
      segs.push(made);
      if (li === door) break;
      cursor = made.base - spacer() - 2 * PAT_SAFE;
      if (cursor < lo) break;
    }
    for (const sg of segs) for (const w of sg.wolves.concat(sg.alt ? sg.alt.wolves : [])) {
      patTable(w);
      w.off = w.offT * w.cycle + w.offS;
      wolfBox(w);
    }
    return { segs, T, D };
  };

  // The final run's rooms: no rows, no formations. Wolf after wolf down the room, each on its own: mostly
  // crossers, now and then a diagonal swing or a lone looper (round a box or a diamond spanning the lane), a random
  // distance apart (FINALE_PACK.gap: sometimes shoulder to shoulder, sometimes far apart). Every wolf runs at its
  // kind's speed (FINALE_SPEED); fairRoom gives each its hold and phase (or leaves it out).
  // A crosser's / diagonal's possible holds: its lap (two runs and two holds) is FINALE_PERIOD / n, holds in FINALE_HOLD
  const finaleHolds = (w) => {
    const run = buildPlan(w, NO_FRAME, w.speed).cycle / 2, out = [];
    for (let n = Math.ceil(FINALE_PERIOD / (2 * (run + FINALE_HOLD[1])) - 1e-9); FINALE_PERIOD / n / 2 - run >= FINALE_HOLD[0]; n++) out.push(FINALE_PERIOD / n / 2 - run);
    return out;
  };
  // A lone looper never stops: its loop is resized (along the lane) so its lap is FINALE_PERIOD / n (a random fitting
  // n). False if no n fits the loop's size range.
  const finaleLoop = (sd) => {
    const w = sd.wolves[0], v = FINALE_SPEED.looper, box = sd.name === 'carousel-box';
    const [dLo, dHi] = box ? [2.4, 3.4] : [5, 6.5];
    const dOf = (lap) => {
      const run = (lap - 4 * EASE_T) * v / 4;      // each of the four runs, on average
      return box ? 2 * run - 2 * vOut : run > vOut ? 2 * Math.sqrt(run * run - vOut * vOut) : -1;
    };
    const ns = [];
    for (let n = 1; n <= 60; n++) { const d = dOf(FINALE_PERIOD / n); if (d >= dLo && d <= dHi) ns.push(n); }
    if (!ns.length) return false;
    const d = dOf(FINALE_PERIOD / rng.pick(ns)), k = d / sd.depth;
    w.route = w.route.map((q) => ({ r: q.r, th: q.th * k }));
    sd.depth = d;
    return true;
  };
  const finaleDesign = (li, D) => {
    const leg = legs[li], { lo, hi } = ranges[li], FT = FINALE_PACK, c = { D, rng, vOut };
    const segs = [];
    let cursor = hi - rng.range(0, 1.2);
    while (cursor >= lo) {
      const u = rng.next();
      let sd = u < FT.diagonal ? segDiagonal(c, { variant: 'swing' }) : u < FT.diagonal + FT.looper ? segCarousel(c, { n: 1 }) : null;
      let fam = u < FT.diagonal ? 'diagonal' : 'carousel';
      const place = () => {
        const base = cursor - sd.depth;
        for (const w of sd.wolves) { w.route = w.route.map((q) => ({ r: q.r, th: q.th + base })); finish(w, leg); w.speed = FINALE_SPEED[w.type]; }
        return cursor - sd.depth >= lo ? base : null;
      };
      if (sd && fam === 'carousel' && !finaleLoop(sd)) sd = null;
      let base = sd ? place() : null;
      if (base == null) { sd = segCrosswalk(c, { k: 1 }); fam = 'crosswalk'; base = place(); }    // else a crosser
      if (base == null) break;
      const w = sd.wolves[0];
      if (w.type !== 'looper') w.holds = finaleHolds(w);
      wolfBox(w);
      segs.push({ ...sd, family: fam, top: cursor + PAT_SAFE, bottom: base - PAT_SAFE, base });
      cursor = base - (FT.gap[0] + (FT.gap[1] - FT.gap[0]) * rng.next() ** FT.gapPow);
    }
    return { segs, D };
  };

  // Greedy segment offsets: each segment's timing is shifted so that some straight lane (not a charger's) keeps
  // a launch window of >= wTarget seconds and >= fTarget of the beat at normal speed, and a (smaller) gap with
  // any number of speed boots (PAT_BOOSTS); a segment that can't is dropped.
  const solveLeg = (li, design, chargers, wTarget, fTarget) => {
    const { segs, T } = design;
    const leg = legs[li];
    const N = Math.round(T / PAT_BIN);
    const kept = [];
    const open = PAT_LANES.map((r) => chargers.every((w) => Math.abs(w.route[0].r - r) >= PAT_SAFE + 0.3));
    let Fs = PAT_SPEEDS.map(() => PAT_LANES.map((_, k) => { const a = new Uint8Array(N).fill(open[k] ? 1 : 0); a.closed = !open[k]; return a; }));
    for (const seg0 of segs) for (let seg = seg0, done = false; seg && !done; seg = seg.alt) {
      const Es = segSafety(seg, N, PAT_SLACK);
      const leads = PAT_SPEEDS.map((vk) => Math.round((leg.len - seg.top) / vk / PAT_BIN));
      const base = Math.floor(rng.next() * N);
      const cands = [];
      for (let q = 0; q < 16; q++) {
        const s = (base + Math.round(q * N / 16)) % N;
        const Fc = Fs.map((F, j) => F.map((f, k) => andShifted(f, Es[j][k], leads[j] + s, N)));
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
      seg.leads = leads; seg.shift = pick.s;     // its wolves' launch-time sets: their w.R shifted by these (driftLeg)
      kept.push(seg); Fs = pick.Fc; done = true;
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
    return {
      leg: li, beat: T, segs: kept, li: sc.li, lane: PAT_LANES[sc.li], open, launch: ((bestS + Math.floor(bestL / 2)) % N) * PAT_BIN,
      window: sc.run * PAT_BIN, frac: sc.frac, N, F: f, wTarget, fTarget,
      lanesUsed: [...new Set(Fs.map((Fj) => PAT_LANES[laneScore(Fj).li]))],    // the best lane per speed
    };
  };

  // One drifting group per room (see the notes at the top of this section): a wolf of a row / pair (or two), or a
  // lone crosser, gets the lap T / mu, mu = 1 +- 1/n. Replayed bin by bin over the room's whole period of n beats
  // with the wolves' exact timing, the solution lane (with the final door, if this room leads to it) must still get
  // its target launch window in every beat and its target share of the time, and every boot speed a gap: the drift
  // may use up the room's PAT_SLACK but never takes it below its targets (and so never below the fairness floors).
  // Else the next group or the other direction is tried, or the room keeps its beat.
  const driftLeg = (pl) => {
    const T = pl.beat, N = pl.N, n = Math.floor(PAT_DRIFT_PERIOD / T + 1e-9), M = n * N, leg = legs[pl.leg];
    const segs = pl.segs.filter((sg) => !sg.chargers);
    const segOf = new Map();
    for (const sg of segs) for (const w of sg.wolves) segOf.set(w, sg);
    // (a carousel never drifts: its loopers would run into each other)
    const multi = rng.shuffle(segs.filter((sg) => sg.wolves.length > 1 && sg.family !== 'carousel'));
    const groups = multi.map((sg) => [rng.pick(sg.wolves)]);
    if (multi.length > 1 && rng.chance(0.3)) groups.unshift([groups[0][0], groups[1][0]]);     // one of each of two rows
    else if (multi.length && multi[0].wolves.length > 2 && rng.chance(0.3)) groups.unshift(multi[0].wolves.filter((w) => w !== groups[0][0]).slice(0, 2));   // two of a row
    for (const sg of rng.shuffle(segs.filter((sg) => sg.wolves.length === 1))) groups.push(sg.wolves);
    // a wolf's exact launch-time sets (per speed, lane)
    const own = (w) => w.F || (w.F = w.R.map((L, j) => L.map((a) => shifted(a, segOf.get(w).leads[j] + segOf.get(w).shift, N))));
    const lanes = PAT_LANES.map((_, k) => k).filter((k) => pl.open[k]);
    const share = (S) => { let c = 0; for (let m = 0; m < S.length; m++) c += S[m]; return c / S.length; };
    for (const g of groups.slice(0, 4)) {
      // the rest of the room: one beat of launch-time sets per speed and lane
      const rest = PAT_SPEEDS.map((_, j) => PAT_LANES.map((_, k) => {
        const a = new Uint8Array(N).fill(pl.open[k] ? 1 : 0);
        for (const w of segOf.keys()) if (!g.includes(w)) { const f = own(w)[j][k]; for (let b = 0; b < N; b++) a[b] &= f[b]; }
        if (j === 0 && pl.door) for (let b = 0; b < N; b++) a[b] &= pl.door[b];
        return a;
      }));
      // launch m (bins into the period) at speed j in lane k: a drifting wolf is where it would have been
      // (mu - 1) * (m + lead) bins later, lead = bins from the launch to its row; its own sets are eroded by its
      // drift during one crossing, plus a bin for rounding
      const replay = (mu, j, k) => {
        const vk = PAT_SPEEDS[j], a = rest[j][k], S = new Uint8Array(M);
        const B = g.map((w) => {
          const e = new Uint8Array(N).fill(1);
          erodeAnd(e, own(w)[j][k], Math.ceil(Math.abs(mu - 1) * (w.thMax - w.thMin + 2 * PAT_SAFE) / vk / 2 / PAT_BIN) + 1);
          return e;
        });
        const lead = g.map((w) => (leg.len - 0.5 * (w.thMin + w.thMax)) / vk / PAT_BIN);
        for (let m = 0; m < M; m++) {
          let s = a[m % N];
          for (let q = 0; s && q < g.length; q++) s = B[q][(((m + Math.round((mu - 1) * (m + lead[q]))) % N) + N) % N];
          S[m] = s;
        }
        return S;
      };
      for (const sgn of rng.chance(0.5) ? [1, -1] : [-1, 1]) {
        const mu = 1 + sgn / n;
        const vs = g.map((w) => patternSpeed(w, w.cycle / mu));
        if (vs.some((v) => !(v > 0 && v <= PAT_VMAX))) continue;
        const S0 = replay(mu, 0, pl.li);
        if (!everyBeat([S0], Math.ceil(pl.wTarget / PAT_BIN - 1e-9), N) || share(S0) < pl.fTarget) continue;
        let boots = true;
        for (let j = 1; j < PAT_SPEEDS.length && boots; j++) {
          const seqs = lanes.map((k) => replay(mu, j, k));
          boots = everyBeat(seqs, Math.round(0.2 / PAT_BIN), N) && Math.max(...seqs.map(share)) >= 0.45 * pl.fTarget;
        }
        if (!boots) continue;
        g.forEach((w, i) => { w.speed = vs[i]; });   // lap T / mu; w.cycle (the beat) stays its phase reference
        pl.period = n * T;
        return;
      }
    }
  };

  // The final run's fairness. Every crosser / diagonal stands at the walls for its own hold, so every wolf has its
  // own lap, but each lap is FINALE_PERIOD / n for a whole n (its hold is fitted to that: finaleLaps), so the room
  // as a whole repeats every FINALE_PERIOD s and checking one period checks it for good. Launch times (the kitty
  // leaving the gap's middle at full speed straight down a free lane, every PAT_SPEEDS) every PAT_BIN of the period;
  // a wolf blocks a launch if, while it is within PAT_SAFE of the lane (sideways), the kitty is within PAT_SAFE
  // (along) of where it is then (a box round the wolf: conservative). Per speed and lane the generator counts the
  // wolves in the way of each launch; a launch is good if its lane stays clear for FINALE_FAIR.win from it. Wolf by
  // wolf down the room, each tries FINALE_FAIR.tries random laps (holds) and phases and keeps the first with which,
  // at every speed, a good launch (any lane) comes at least every FINALE_FAIR.wait s all period round; else it is
  // left out.
  const fairRoom = (li, design, chargers) => {
    const leg = legs[li], len = leg.len, BIN = PAT_BIN, FF = FINALE_FAIR, SAFE = PAT_SAFE;
    const open = PAT_LANES.map((r) => chargers.every((w) => Math.abs(w.route[0].r - r) >= PAT_SAFE + 0.3));
    const lanes = PAT_LANES.map((_, k) => k).filter((k) => open[k]);
    const NB = Math.round(FINALE_PERIOD / BIN);
    const cnt = PAT_SPEEDS.map(() => lanes.map(() => new Uint16Array(NB)));
    const vMin = Math.min(...PAT_SPEEDS), vMax = Math.max(...PAT_SPEEDS);
    // launch-bin intervals [b0, b1] (b1 may pass NB: circular) wolf w blocks, per speed and lane
    const marks = (w) => {
      const plan = buildPlan(w, NO_FRAME, w.speed), cyc = plan.cycle, off = w.phase * cyc;
      // per segment and lane: when (in the segment) the wolf is within SAFE of the lane, and its th range then
      const hits = plan.segs.map((sg) => lanes.map((k) => {
        const r = PAT_LANES[k], dr = sg.r1 - sg.r0;
        let q0 = 0, q1 = 1;
        if (Math.abs(dr) < 1e-9) { if (Math.abs(sg.r0 - r) >= SAFE) return null; }
        else {
          q0 = (r - SAFE - sg.r0) / dr; q1 = (r + SAFE - sg.r0) / dr;
          if (q0 > q1) [q0, q1] = [q1, q0];
          q0 = Math.max(0, q0); q1 = Math.min(1, q1);
          if (q0 >= q1) return null;
        }
        const ta = sg.L > 0 ? profileInv(q0 * sg.L, sg.T, sg.L, plan.speed) : 0, tb = sg.L > 0 ? profileInv(q1 * sg.L, sg.T, sg.L, plan.speed) : sg.T;
        const tha = sg.th0 + (sg.th1 - sg.th0) * q0, thb = sg.th0 + (sg.th1 - sg.th0) * q1;
        return { ta, tb, thLo: Math.min(tha, thb), thHi: Math.max(tha, thb) };
      }));
      const out = PAT_SPEEDS.map(() => lanes.map(() => []));
      // wolf times that matter for launches in [0, period): from the earliest meeting to the latest
      const t0 = (len - w.thMax - SAFE) / vMax, t1 = FINALE_PERIOD + (len - w.thMin + SAFE) / vMin;
      for (let m = Math.floor((t0 + off) / cyc); m * cyc - off <= t1; m++) {
        for (let i = 0; i < plan.segs.length; i++) {
          const sg = plan.segs[i], s0 = m * cyc - off + sg.tStart;
          if (s0 > t1 || s0 + sg.T < t0) continue;
          hits[i].forEach((h, x) => {
            if (!h) return;
            PAT_SPEEDS.forEach((vk, j) => {
              const lo = s0 + h.ta - (len - h.thLo + SAFE) / vk, hi = s0 + h.tb - (len - h.thHi - SAFE) / vk;
              let b0 = Math.floor(lo / BIN), b1 = Math.ceil(hi / BIN);
              if (b1 < 0 || b0 >= NB) return;          // the same launches come round again in the period
              b1 = Math.min(b1, b0 + NB - 1);
              out[j][x].push(b0, b1);
            });
          });
        }
      }
      return out;
    };
    const apply = (mk, j, sgn) => {
      const L = mk[j];
      for (let x = 0; x < L.length; x++) {
        const C = cnt[j][x], iv = L[x];
        for (let q = 0; q < iv.length; q += 2) {
          let b = iv[q] < 0 ? iv[q] + NB : iv[q];
          for (let e = iv[q + 1] - iv[q]; e >= 0; e--) { C[b] += sgn; if (++b === NB) b = 0; }
        }
      }
    };
    const win = Math.ceil(FF.win / BIN - 1e-9), wait = Math.floor(FF.wait / BIN + 1e-9);
    const good = new Uint8Array(NB);
    // at speed j: the good launches (any lane), and the longest wait for one, all period round
    const waits = (j) => {
      good.fill(0);
      for (const C of cnt[j]) {
        let run = 0;
        for (let b = NB - 1; b >= 0; b--) run = C[b] ? 0 : run + 1;      // the run carried round from the start
        if (run === NB) return 0;
        for (let b = NB - 1; b >= 0; b--) { if (C[b]) run = 0; else if (++run >= win) good[b] = 1; }
      }
      let first = -1, last = -1, worst = 0;
      for (let b = 0; b < NB; b++) if (good[b]) { if (first < 0) first = b; else if (b - last - 1 > worst) worst = b - last - 1; last = b; }
      return first < 0 ? NB : Math.max(worst, first + NB - last - 1);
    };
    // adds wolf marks mk speed by speed (normal speed first: it fails most), taking them back if it breaks one
    const tryAdd = (mk) => {
      for (let j = 0; j < PAT_SPEEDS.length; j++) {
        apply(mk, j, 1);
        if (waits(j) > wait) { for (let i = 0; i <= j; i++) apply(mk, i, -1); return false; }
      }
      return true;
    };
    const kept = [];
    if (lanes.length) for (const seg of design.segs) {
      const w = seg.wolves[0];
      for (let t = 0; t < FF.tries; t++) {
        if (w.type !== 'looper') {      // the fitting hold nearest a uniform one
          const u = FINALE_HOLD[0] + (FINALE_HOLD[1] - FINALE_HOLD[0]) * rng.next();
          w.hold = w.holds.reduce((a, h) => (Math.abs(h - u) < Math.abs(a - u) ? h : a));
        }
        w.phase = Math.round(rng.next() * 1e9) / 1e9;
        if (tryAdd(marks(w))) { kept.push(seg); break; }
      }
    }
    // the lane open longest at normal speed: the plan's lane (tooling); window = its longest clear run (s)
    let best = null;
    lanes.forEach((k, x) => {
      const C = cnt[0][x];
      let z = 0, run = 0, top = 0, first = -1;
      for (let q = 0; q < 2 * NB; q++) {
        if (C[q % NB]) { run = 0; continue; }
        run++; top = Math.max(top, run);
        if (q < NB) z++;
        if (first < 0 && run >= win) first = ((q - win + 1) % NB) * BIN;
      }
      if (!best || z > best.z) best = { k, z, top: Math.min(top, NB), first };
    });
    if (chargers.length) kept.unshift({ name: 'chargers', top: ranges[li].hi + PAT_SAFE, bottom: ranges[li].lo - PAT_SAFE, wolves: chargers, chargers: true });
    if (!kept.length || !best) return null;
    return {
      leg: li, beat: null, segs: kept, li: best.k, lane: PAT_LANES[best.k], open, launch: best.first, window: best.top * BIN, frac: best.z / NB,
      maxWait: Math.max(...PAT_SPEEDS.map((_, j) => waits(j))) * BIN,
    };
  };

  const heat = p.patternHeat || 0;
  for (let li = 0; li < legs.length; li++) {
    const lesson = level === 1 && li < PAT_LESSONS.length;
    const D = lesson ? 0.1 * li : lvl.finale ? FINALE_HEAT + FINALE_RAMP * li / Math.max(1, last) : Math.min(1.6, heat + 0.5 * li / Math.max(1, last));
    const wTarget = Math.max(0.3, 0.75 - 0.3 * D);
    const fTarget = lesson ? 0.34 : Math.max(0.08, 0.25 - 0.12 * D);
    if (li === door && plans.length && plans[plans.length - 1].leg === li - 1) {
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
          const ok = pathSafety(tr.traj, doorW, N, PAT_SAFE, PAT_SLACK);
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
        prevPlan.door = pathSafety(best.tr.traj, doorW, N, PAT_SAFE, 0);     // exact, for driftLeg
        plans.push({ leg: li, beat: prevPlan.beat, segs: design.segs, lane: best.tr.r, launch: null, window: best.run, frac: best.frac, N, finale: true });
      }
      continue;
    }
    const chargers = makeChargers(li, D, chargerLanes(li, D));
    const pl = lvl.finale ? fairRoom(li, finaleDesign(li, D), chargers)
      : solveLeg(li, legDesign(li, D, 0), chargers, wTarget, fTarget);
    if (pl) plans.push(pl);
  }

  // ---- drift: not in level 1's lessons, nor in the final door (the room before it may drift, door included)
  for (const pl of plans) {
    if (lvl.finale) continue;     // the final run: every wolf on its own lap already (fairRoom)
    if (pl.finale || (level === 1 && pl.leg < PAT_LESSONS.length) || !rng.chance(PAT_DRIFT_CHANCE)) continue;
    driftLeg(pl);
    const door = plans.find((q) => q.finale && q.leg === pl.leg + 1);
    if (door && pl.period) door.period = pl.period;
  }

  // ---- specs (a drifting wolf keeps its phase in the beat: at level start it is exactly in step)
  for (const pl of plans) {
    for (const seg of pl.segs) for (const w of seg.wolves) {
      const id = enemies.length;
      enemies.push({
        id, type: w.type, leg: pl.leg, frame: w.frame,
        rIn: w.rMin, rOut: w.rMax, a0: w.thMin, a1: w.thMax,
        speed: w.speed,
        phase: w.phase ?? Math.round((((w.off % w.cycle) + w.cycle) % w.cycle) / w.cycle * 1e9) / 1e9,
        seed: hashSeed(seed, level, 'wolf', id),
        route: w.route, loop: !!w.loop,
        pattern: seg.name,
      });
      if (w.hold != null) enemies[id].hold = w.hold;
    }
  }
  // One solution per leg (for tests / tooling): skate lane `lane` (leg-local r), leaving the entry corner's
  // center when levelTime mod `beat` == `launch`; `window`/`frac` = launch slack (s) / open share of the beat, with
  // PAT_SLACK to spare. A drifting room is like that at level start; it slides and is back every `period` s.
  // The finale entry describes the door of the final stretch, entered from the previous leg (its `finalLane`).
  const r3 = (x) => Math.round(x * 1000) / 1000;
  // The final run's rooms have no beat: launch = the first good launch time (level time), maxWait = the longest wait
  // for a good launch (any lane, worst boot speed) over the sampled spans.
  if (lvl.finale) {
    lvl.patternPlan = plans.map((pl) => ({
      leg: pl.leg, lane: pl.lane, launch: pl.launch == null || pl.launch < 0 ? null : r3(pl.launch), window: r3(pl.window), frac: r3(pl.frac),
      maxWait: r3(pl.maxWait), finale: false, segs: pl.segs.map((sg) => ({ name: sg.name, top: r3(sg.top), bottom: r3(sg.bottom) })),
    }));
    return enemies;
  }
  lvl.patternPlan = plans.map((pl) => ({
    leg: pl.leg, beat: pl.beat, period: r3(pl.period || pl.beat), lane: pl.lane, launch: pl.launch == null ? null : r3(pl.launch),
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
  const finale = mode === 'ice' && L === SKATE_FINAL_LEVEL;
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
    theme: CFG.ICE_TEST || mode === 'ice' ? ICE_THEME : THEME_ORDER[(L - 1) % 4], // run mode: same seasons, winter just isn't ice
    mode,
    finale,
  };
  lvl.ice = mode !== 'run' && lvl.theme === ICE_THEME;
  lvl.checkpoints = lvl.ice && !finale ? pickCheckpoints(corners, legs, lvl.safeCorners.length) : [];
  if (finale) {
    lvl.loops = 0;
    lvl.runLength = straight.length;              // start square center -> goal center
    lvl.crown = { x: -ROOM + 1.6, z: 0 };
    const t = straight.tree, leg = legs.findIndex((l) => l.ox === t.x);
    lvl.trees = [{ x: t.x, z: t.z, leg }];
  } else {
    // the crown: just inside the goal room's door, on the way to the portal
    const last = corners[corners.length - 1], inner = legs[legs.length - 1], d = CFG.RING_WIDTH / 2 + 1.6;
    lvl.crown = { x: last.x + inner.nx * d, z: last.z + inner.nz * d };
    lvl.trees = lvl.theme === TREE_THEME && !lvl.ice ? placeTrees(createRng(hashSeed(seed, L, 'trees')), legs) : [];
  }
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

// Skate only: how a leg's recorded solution plays with the REAL wolves, checked independently of the generator's
// tables: the skating model follows the plan's lane (for the final stretch: through the previous leg and in through
// the door), and the leg's wolves are created and stepped tick by tick by enemies.js as in a game, over the leg's
// whole period (n beats if a group drifts out of step and back) plus more than the longest allowed wait. Scans
// launch times every `step` s; returns the longest clear launch window and the longest wait for one.
function patternGaps(ld, pl, step = 0.1) {
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
  const specs = ld.enemies.filter((e) => e.leg === pl.leg || (fin && e.leg === fin.leg));
  const horizon = Math.max(40, Math.max(pl.period, fin ? fin.period : 0) + 12);
  const per = Math.round(step / CFG.TICK), n = Math.round(horizon / step), H = n * per + traj.xs.length + 1;
  const wolves = createEnemies({ enemies: specs });
  const X = wolves.map(() => new Float32Array(H)), Z = wolves.map(() => new Float32Array(H));
  for (let j = 0; j < H; j++) {
    if (j) updateEnemies(wolves, ld, CFG.TICK);
    for (let i = 0; i < wolves.length; i++) { X[i][j] = wolves[i].x; Z[i][j] = wolves[i].z; }
  }
  const hit = PAT_HIT, h2 = hit * hit;
  const ok = new Uint8Array(n).fill(1);
  specs.forEach((e, i) => {
    const w = { frame: e.frame, route: e.route };
    wolfBox(w);
    const idx = [];
    for (let k = 0; k < traj.xs.length; k++) if (traj.xs[k] > w.x0 - hit && traj.xs[k] < w.x1 + hit && traj.zs[k] > w.z0 - hit && traj.zs[k] < w.z1 + hit) idx.push(k);
    for (let b = 0; b < n; b++) {
      if (!ok[b]) continue;
      for (const k of idx) {
        const j = b * per + k + 1;          // traj.xs[k] is the kitty k + 1 ticks after it sets off
        const dx = traj.xs[k] - X[i][j], dz = traj.zs[k] - Z[i][j];
        if (dx * dx + dz * dz < h2) { ok[b] = 0; break; }
      }
    }
  });
  let run = 0, best = 0, wait = 0, maxWait = 0;
  for (let b = 0; b < n; b++) {
    if (ok[b]) { run++; best = Math.max(best, run); wait = 0; } else { run = 0; wait++; maxWait = Math.max(maxWait, wait); }
  }
  return { window: best * step, maxWait: maxWait * step };
}

// The final run (no beat; a room repeats every FINALE_PERIOD s): from the middle of the gap before the room,
// straight down every lane that is not a charger's, at the given skating speeds, against the real wolves (created
// and stepped tick by tick by enemies.js; a jump between spans). Launches every `step` s over each span; a launch is
// good if its lane stays clear (PAT_HIT) for FINALE_FAIR.win. Per span: the longest clear run (s) in any lane, and
// the longest wait for a good launch in any lane at the worst speed (from the span's start, to its end).
function finaleGaps(ld, pl, spans = [[0, FINALE_PERIOD]], step = 0.05, speeds = PAT_SPEEDS) {
  const leg = ld.legs[pl.leg], specs = ld.enemies.filter((e) => e.leg === pl.leg);
  const lanes = PAT_LANES.filter((r) => specs.every((e) => e.type !== 'charger' || Math.abs(e.route[0].r - r) >= PAT_SAFE + 0.3));
  const trajs = speeds.map((vk) => lanes.map((r) => skatePath(planPoints(leg, r), vk)));
  const longest = Math.max(...trajs.flat().map((t) => t.xs.length));
  const per = Math.round(step / CFG.TICK), win = Math.round(FINALE_FAIR.win / step), h2 = PAT_HIT * PAT_HIT;
  const boxes = specs.map((e) => { const w = { frame: e.frame, route: e.route }; wolfBox(w); return w; });
  const wolves = createEnemies({ enemies: specs });
  let now = 0;
  return spans.map(([a, b]) => {
    const n = Math.round((b - a) / step), H = n * per + longest + 1;
    updateEnemies(wolves, ld, a - now);
    const X = wolves.map(() => new Float32Array(H)), Z = wolves.map(() => new Float32Array(H));
    for (let j = 0; j < H; j++) {
      if (j) updateEnemies(wolves, ld, CFG.TICK);
      for (let i = 0; i < wolves.length; i++) { X[i][j] = wolves[i].x; Z[i][j] = wolves[i].z; }
    }
    now = a + (H - 1) * CFG.TICK;
    let window = 0, maxWait = 0;
    trajs.forEach((byLane) => {
      const good = new Uint8Array(n);
      for (const traj of byLane) {
        const ok = new Uint8Array(n).fill(1);
        boxes.forEach((w, i) => {
          const idx = [];
          for (let k = 0; k < traj.xs.length; k++) if (traj.xs[k] > w.x0 - PAT_HIT && traj.xs[k] < w.x1 + PAT_HIT && traj.zs[k] > w.z0 - PAT_HIT && traj.zs[k] < w.z1 + PAT_HIT) idx.push(k);
          for (let q = 0; q < n; q++) {
            if (!ok[q]) continue;
            for (const k of idx) {
              const j = q * per + k + 1, dx = traj.xs[k] - X[i][j], dz = traj.zs[k] - Z[i][j];
              if (dx * dx + dz * dz < h2) { ok[q] = 0; break; }
            }
          }
        });
        for (let q = n - 1, run = 0; q >= 0; q--) { run = ok[q] ? run + 1 : 0; window = Math.max(window, run * step); if (run >= win) good[q] = 1; }
      }
      let last = -1, wt = 0;
      for (let q = 0; q < n; q++) if (good[q]) { wt = Math.max(wt, q - last - 1); last = q; }
      maxWait = Math.max(maxWait, (Math.max(wt, n - 1 - last)) * step);
    });
    return { window, maxWait };
  });
}

function checkPatternWolves(ld, P, stats) {
  const ranges = usableRanges(ld.legs);
  const vOut = CFG.RING_WIDTH / 2 - WOLF_MARGIN, eps = 1e-6;
  if (ld.enemies.length < 40) P(`few pattern wolves ${ld.enemies.length}`);
  if (!ld.patternPlan || ld.patternPlan.length < ld.legs.length - 3) P(`rooms missing: ${ld.patternPlan ? ld.patternPlan.length : 0} planned legs`);
  const beat = new Map((ld.patternPlan || []).map((pl) => [pl.leg, pl.beat]));
  const period = new Map((ld.patternPlan || []).map((pl) => [pl.leg, pl.period]));
  const drift = new Map(), chargerLaps = new Map();
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
    // end to end: crossers / diagonals wall to wall (the final run's too: no wolf turns in the middle of the ice); chargers the whole leg, safe square to safe square; loopers
    // (the final run's carousels) round a closed loop that touches both walls
    const rs = e.route.map((q) => q.r);
    if (e.type === 'looper') {
      if (!ld.finale) P(`${tag}: loopers belong to the final run`);
      if (!e.loop || e.route.length < 3) P(`${tag}: route is not a loop`);
      else if (Math.abs(Math.max(...rs) - vOut) > eps || Math.abs(Math.min(...rs) + vOut) > eps) P(`${tag}: loop does not reach both walls`);
    } else if (e.loop || e.route.length !== 2) P(`${tag}: route is not a single end-to-end run`);
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
    if (ld.finale) {
      // the final run: one speed per kind of wolf; crossers / diagonals stand at each wall for their own hold
      if (e.speed !== FINALE_SPEED[e.type]) P(`${tag}: speed ${e.speed} is not the final run's ${e.type} speed ${FINALE_SPEED[e.type]}`);
      const holds = e.type === 'crosser' || e.type === 'diagonal';
      if (holds ? !(e.hold >= FINALE_HOLD[0] && e.hold <= FINALE_HOLD[1]) : e.hold != null) P(`${tag}: hold ${e.hold}`);
      const lap = buildPlan(e, e.frame, e.speed).cycle, n = Math.round(FINALE_PERIOD / lap);
      if (e.type !== 'charger' && Math.abs(n * lap - FINALE_PERIOD) > 1e-6) P(`${tag}: lap ${lap} does not divide the room's period ${FINALE_PERIOD}`);
    } else if (e.hold != null) P(`${tag}: holds belong to the final run`);
    if (!ld.finale && e.type !== 'charger' && (e.type === 'looper' ? e.loop : !e.loop && e.route.length === 2)) {
      // its lap divides the leg beat T, or it drifts: back in step with the beat within PAT_DRIFT_PERIOD, and the leg's
      // period (n beats) is a whole number of its laps
      const cyc = buildPlan(e, e.frame, e.speed).cycle, T = beat.get(e.leg), base = T / Math.max(1, Math.round(T / cyc));
      if (!T) P(`${tag}: leg has no beat`);
      else if (Math.abs(cyc - base) > 1e-4) {
        const back = base * cyc / Math.abs(base - cyc), per = period.get(e.leg), cap = PAT_DRIFT_PERIOD;
        if (back > cap + 1e-6) P(`${tag}: lap ${cyc.toFixed(3)} drifts back into step with the beat ${T} only every ${back.toFixed(1)}s`);
        if (!(per > T && per <= cap + 1e-6) || Math.abs(cyc * Math.round(per / cyc) - per) > 1e-3) P(`${tag}: lap ${cyc.toFixed(3)} does not divide the leg's period ${per}`);
        if (!drift.has(e.leg)) drift.set(e.leg, new Set());
        drift.get(e.leg).add(Math.round(base / cyc * 1e6));
      }
    }
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
  // one drifting group per room (the final run: any number of laps, each dividing the room's period, checked above)
  if (!ld.finale) for (const [leg, mus] of drift) if (mus.size > 1) P(`leg ${leg}: ${mus.size} drifting groups (one at most)`);
  for (const [leg, laps] of chargerLaps) if (Math.max(...laps) - Math.min(...laps) > 1e-6) P(`leg ${leg}: chargers out of step with each other`);
  for (const pl of ld.patternPlan || []) {
    if (pl.period > pl.beat && !pl.finale) stats.iceDriftRooms++;
    if (ld.patternPlan.some((q) => q.leg === pl.leg + 1 && q.finale)) continue;   // checked with its final door
    if (ld.finale) {
      // one whole period (the room repeats), at normal speed and with all the boots; and a stretch an hour in
      const sp = [PAT_VK, PAT_SPEEDS[PAT_SPEEDS.length - 1]];
      const [g, late] = finaleGaps(ld, pl, [[0, FINALE_PERIOD], [3600, 3660]], 0.1, sp);
      stats.finaleRooms++;
      stats.finaleMaxWait = Math.max(stats.finaleMaxWait, g.maxWait, late.maxWait);
      stats.iceMinWindow = Math.min(stats.iceMinWindow, g.window, late.window);
      for (const [x, when] of [[g, ''], [late, ', an hour in']]) {
        if (x.maxWait > FINALE_FAIR.wait + 0.2 || x.window < FINALE_FAIR.win) P(`leg ${pl.leg} (final run${when}): best window ${x.window.toFixed(2)}s, longest wait ${x.maxWait.toFixed(2)}s`);
      }
      continue;
    }
    const g = patternGaps(ld, pl);
    stats.iceMinWindow = Math.min(stats.iceMinWindow, g.window);
    stats.iceMaxWait = Math.max(stats.iceMaxWait, g.maxWait);
    if (g.window < 0.2 || g.maxWait > 10) P(`leg ${pl.leg}${pl.finale ? ' (final door)' : ''}: lane ${pl.lane} best window ${g.window.toFixed(2)}s, longest wait ${g.maxWait.toFixed(1)}s`);
  }
  stats.iceRooms += (ld.patternPlan || []).filter((pl) => !pl.finale).length;
  stats.iceWolves += ld.enemies.length;
}

function mazeSelfTest(levels = 12, modes = ['mixed', 'ice']) {
  const problems = [];
  const seeds = [1, 42, 1337, 9001, 'kitty', 777777];
  const stats = { levels: 0, avgPathLen: 0, enemies: 0, items: 0, iceWolves: 0, iceRooms: 0, iceDriftRooms: 0, iceMinWindow: Infinity, iceMaxWait: 0, finaleRooms: 0, finaleMaxWait: 0 };
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

export { generateLevel, collideCircle, locate, inCenter, onIce, inTree, mazeSelfTest, finaleGaps };
