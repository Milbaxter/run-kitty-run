import { CFG, levelParams } from './config.js';
import { createRng, hashSeed } from './rng.js';

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
  lvl.trees = lvl.theme === TREE_THEME && !lvl.ice ? placeTrees(createRng(hashSeed(seed, L, 'trees')), legs) : [];
  lvl.enemies = placeEnemies(rng, lvl, p);
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

function mazeSelfTest(levels = 12) {
  const problems = [];
  const seeds = [1, 42, 1337, 9001, 'kitty', 777777];
  const P = (s, l, msg) => { if (problems.length < 200) problems.push(`seed ${s} L${l}: ${msg}`); };
  const stats = { levels: 0, avgPathLen: 0, enemies: 0, items: 0 };
  for (const s of seeds) {
    for (let l = 1; l <= levels; l++) {
      const ld = generateLevel(l, s);
      const p = levelParams(l);
      stats.levels++;
      if (JSON.stringify(ld) !== JSON.stringify(generateLevel(l, s))) P(s, l, 'not deterministic');
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
