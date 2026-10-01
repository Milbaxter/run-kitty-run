import { CFG, levelParams } from './config.js';
import { createRng, hashSeed, TAU, normAngle, angleDiff } from './rng.js';

// Circular labyrinth generation + collision. Pure (no THREE, no DOM).
// The wall layout is a fixed spiral (same on every level); only wolves/items vary by level+seed.
//
// Contract notes / interpretations:
// - segments carry an extra boolean `full` (true only for corridors without radial walls,
//   which are reported as a0=0, a1=TAU). A corridor with exactly ONE radial wall yields a
//   segment a0=w, a1=w+TAU with full=false (a C-shaped loop blocked at w).
// - All angular intervals (wallArcs, segments, enemy a0/a1) use a0 in [0,TAU), a1 > a0,
//   a1 may exceed TAU. Sweeper `angle` lies inside [a0,a1] in that same unwrapped frame.
// - Enemy a0/a1 are a "territory": a sub-range of the (shrunk) segment, so wolves spread out
//   over the maze. Orbiters get their whole segment (full ring => exactly 0..TAU).
// - Gap halfAngle = (GAP_WIDTH/2) / wallRadius (linear opening GAP_WIDTH at the wall centerline).
// - collideCircle uses a lazily built spatial grid cached in a WeakMap keyed by levelData
//   (no extra fields are added to LevelData).


const HALF_T = CFG.WALL_THICKNESS / 2;
const WOLF_MARGIN = HALF_T + CFG.WOLF_RADIUS + 0.06;
const REST_STOP = 4.5;            // wolf-free arc (units) on each side of every corridor divider
const GRID_CELL = 2.0;
const GRID_MAX_R = 1.0;           // grid query valid for radii up to this; larger -> brute force

// ---------------------------------------------------------------- helpers

function midR(R, i) { return (R[i] + R[i + 1]) / 2; }

// unwrap angle `a` into [base, base+TAU)
function unwrapFrom(base, a) { return base + normAngle(a - base); }

function segContains(seg, a) {
  if (seg.full) return true;
  return normAngle(a - seg.a0) <= seg.a1 - seg.a0 + 1e-12;
}

// angular travel distance between angles A and B inside segment (radians)
function segArcDist(seg, A, B) {
  if (seg.full) return Math.abs(angleDiff(A, B));
  return Math.abs(unwrapFrom(seg.a0, A) - unwrapFrom(seg.a0, B));
}

// largest piece of [lo,hi] after removing [f0,f1] (and its TAU-periodic copies)
function clipArc(lo, hi, f0, f1) {
  let pieces = [[lo, hi]];
  for (let k = -2; k <= 2; k++) {
    const F0 = f0 + k * TAU, F1 = f1 + k * TAU;
    const next = [];
    for (const [p, q] of pieces) {
      if (F1 <= p || F0 >= q) { next.push([p, q]); continue; }
      if (F0 > p) next.push([p, F0]);
      if (q > F1) next.push([F1, q]);
    }
    pieces = next;
  }
  let best = null;
  for (const pc of pieces) if (!best || pc[1] - pc[0] > best[1] - best[0]) best = pc;
  return best;
}

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

// ---------------------------------------------------------------- topology

function buildSegments(rings, radialWalls) {
  const segments = [];
  for (let i = 0; i < rings; i++) {
    const angs = radialWalls.filter(w => w.corridor === i).map(w => w.angle).sort((a, b) => a - b);
    if (angs.length === 0) {
      segments.push({ id: segments.length, corridor: i, a0: 0, a1: TAU, full: true });
      continue;
    }
    for (let k = 0; k < angs.length; k++) {
      const a0 = angs[k];
      const len = angs.length === 1 ? TAU : normAngle(angs[(k + 1) % angs.length] - a0);
      segments.push({ id: segments.length, corridor: i, a0, a1: a0 + len, full: false });
    }
  }
  return segments;
}

function findSeg(segments, corridor, a) {
  for (const s of segments) if (s.corridor === corridor && segContains(s, a)) return s;
  return null;
}

// Dijkstra over points of interest: start, gaps, center.
// Returns { ok, legs: [{ seg, from, to, gapTo }], segOnPath:Set, gapLinks } where legs walk the route.
function solveRoute(ctx, segments) {
  const { R, rings, gaps, startAngle } = ctx;
  const RW = CFG.RING_WIDTH;
  // nodes: 0 = start, 1..G = gaps, G+1 = center
  const G = gaps.length;
  const CENTER = G + 1;
  const gapSegs = gaps.map(g => ({
    inner: g.wall === 0 ? null : findSeg(segments, g.wall - 1, g.angle),
    outer: g.wall >= rings ? null : findSeg(segments, g.wall, g.angle),
  }));
  const startSeg = findSeg(segments, rings - 1, startAngle);
  // per segment: list of [node, angle]
  const touch = new Map();
  const addTouch = (seg, node, ang) => {
    if (!seg) return;
    if (!touch.has(seg.id)) touch.set(seg.id, []);
    touch.get(seg.id).push([node, ang]);
  };
  addTouch(startSeg, 0, startAngle);
  gaps.forEach((g, k) => { addTouch(gapSegs[k].inner, k + 1, g.angle); addTouch(gapSegs[k].outer, k + 1, g.angle); });
  const adj = [];
  for (let n = 0; n <= CENTER; n++) adj.push([]);
  for (const [sid, list] of touch) {
    const seg = segments[sid];
    const rm = midR(R, seg.corridor);
    for (let a = 0; a < list.length; a++) {
      for (let b = 0; b < list.length; b++) {
        if (a === b || list[a][0] === list[b][0]) continue;
        const cost = segArcDist(seg, list[a][1], list[b][1]) * rm + (list[b][0] === 0 ? 0 : RW);
        adj[list[a][0]].push({ to: list[b][0], cost, seg, fromA: list[a][1], toA: list[b][1] });
      }
    }
  }
  gaps.forEach((g, k) => { if (g.wall === 0 && gapSegs[k].outer) adj[k + 1].push({ to: CENTER, cost: RW, seg: null, fromA: g.angle, toA: g.angle }); });

  const dist = new Array(CENTER + 1).fill(Infinity);
  const prev = new Array(CENTER + 1).fill(null);
  const done = new Array(CENTER + 1).fill(false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let n = 0; n <= CENTER; n++) if (!done[n] && dist[n] < Infinity && (u < 0 || dist[n] < dist[u])) u = n;
    if (u < 0) break;
    done[u] = true;
    if (u === CENTER) break;
    for (const e of adj[u]) {
      const nd = dist[u] + e.cost;
      if (nd < dist[e.to] - 1e-9) { dist[e.to] = nd; prev[e.to] = { from: u, e }; }
    }
  }
  // reachable segments (for dead-end detection etc.)
  const reach = new Set();
  if (dist[CENTER] === Infinity) return { ok: false, legs: [], length: Infinity, gapSegs, startSeg, reach };
  const legs = [];
  let n = CENTER;
  while (n !== 0) { legs.push(prev[n].e); n = prev[n].from; }
  legs.reverse();
  return { ok: true, legs, length: dist[CENTER], gapSegs, startSeg, reach };
}

// ---------------------------------------------------------------- generation

// Fixed spiral layout (identical on every level): each corridor has one divider wall with the
// entrance gap just on its + side and the exit gap just on its - side, so the only route runs
// ~360 deg around every ring, then drops inward. No choices, no dead ends.
const SPIRAL_CLEAR = 0.35;   // linear clearance between a gap edge and the divider beside it
function buildSpiral(R, rings) {
  const gaps = [], radialWalls = [];
  const off = (r) => (CFG.GAP_WIDTH / 2 + HALF_T + SPIRAL_CLEAR) / r;
  const rmOut = midR(R, rings - 1);
  const startAngle = Math.PI / 2;                 // nearest the camera (screen bottom)
  let w = startAngle - 3.2 / rmOut;               // outermost divider sits just behind the start
  for (let i = rings - 1; i >= 0; i--) {
    radialWalls.push({ angle: normAngle(w), r0: R[i], r1: R[i + 1], corridor: i });
    const g = w - off(R[i]);
    gaps.push({ wall: i, angle: normAngle(g), halfAngle: (CFG.GAP_WIDTH / 2) / R[i] });
    w = g - off(R[i]);
  }
  gaps.sort((a, b) => a.wall - b.wall || a.angle - b.angle);
  return { startAngle: normAngle(startAngle), gaps, radialWalls };
}

function buildWallArcs(R, rings, gaps) {
  const arcs = [];
  for (let j = 0; j <= rings; j++) {
    const gs = gaps.filter(g => g.wall === j).sort((a, b) => a.angle - b.angle);
    if (gs.length === 0) { arcs.push({ radius: R[j], a0: 0, a1: TAU, wall: j }); continue; }
    for (let k = 0; k < gs.length; k++) {
      const g = gs[k], h = gs[(k + 1) % gs.length];
      const start = g.angle + g.halfAngle;
      const len = normAngle((h.angle - h.halfAngle) - start);
      if (len < 1e-6) continue;
      arcs.push({ radius: R[j], a0: normAngle(start), a1: normAngle(start) + len, wall: j });
    }
  }
  return arcs;
}

function buildWallSegments(arcs, radialWalls) {
  const out = [];
  for (const arc of arcs) {
    const len = (arc.a1 - arc.a0) * arc.radius;
    const n = Math.max(1, Math.ceil(len / 1.0));
    let px = arc.radius * Math.cos(arc.a0), pz = arc.radius * Math.sin(arc.a0);
    for (let k = 1; k <= n; k++) {
      const a = arc.a0 + (arc.a1 - arc.a0) * (k / n);
      const qx = arc.radius * Math.cos(a), qz = arc.radius * Math.sin(a);
      out.push({ ax: px, az: pz, bx: qx, bz: qz });
      px = qx; pz = qz;
    }
  }
  for (const w of radialWalls) {
    const c = Math.cos(w.angle), s = Math.sin(w.angle);
    out.push({ ax: w.r0 * c, az: w.r0 * s, bx: w.r1 * c, bz: w.r1 * s });
  }
  return out;
}

function buildPath(R, startAngle, rings, legs) {
  const pts = [];
  const STEP = 2.0;
  const push = (x, z) => {
    const l = pts[pts.length - 1];
    if (l && Math.hypot(l.x - x, l.z - z) < 1e-6) return;
    pts.push({ x, z });
  };
  let curCorr = rings - 1;
  let curAng = startAngle;
  push(midR(R, curCorr) * Math.cos(curAng), midR(R, curCorr) * Math.sin(curAng));
  const radialTo = (ang, rFrom, rTo) => {
    const n = Math.max(1, Math.ceil(Math.abs(rTo - rFrom) / STEP));
    for (let k = 1; k <= n; k++) {
      const r = rFrom + (rTo - rFrom) * (k / n);
      push(r * Math.cos(ang), r * Math.sin(ang));
    }
  };
  for (const leg of legs) {
    if (!leg.seg) { // into center
      radialTo(leg.toA, midR(R, curCorr), 0);
      curCorr = -1;
      continue;
    }
    const c = leg.seg.corridor;
    if (c !== curCorr) { radialTo(curAng, midR(R, curCorr), midR(R, c)); curCorr = c; }
    const rm = midR(R, c);
    let uA, uB;
    if (leg.seg.full) { uA = leg.fromA; uB = uA + angleDiff(leg.fromA, leg.toA); }
    else { uA = unwrapFrom(leg.seg.a0, leg.fromA); uB = unwrapFrom(leg.seg.a0, leg.toA); }
    const n = Math.max(1, Math.ceil(Math.abs(uB - uA) * rm / STEP));
    for (let k = 1; k <= n; k++) {
      const a = uA + (uB - uA) * (k / n);
      push(rm * Math.cos(a), rm * Math.sin(a));
    }
    curAng = leg.toA;
  }
  return pts;
}

function placeEnemies(rng, lvl, p, route) {
  const { R, rings, segments, startAngle, seed, level } = lvl;
  const enemies = [];
  const count = p.enemyCount;
  const safeHalf = (CFG.START_SAFE_ARC + CFG.WOLF_RADIUS) / (R[rings - 1] + WOLF_MARGIN);
  const safe0 = startAngle - safeHalf, safe1 = startAngle + safeHalf;
  // corridor quotas proportional to usable length
  const lens = [];
  for (let i = 0; i < rings; i++) {
    let L = TAU * midR(R, i);
    if (i === rings - 1) L -= 2 * CFG.START_SAFE_ARC;
    lens.push(Math.max(1, L));
  }
  const total = lens.reduce((a, b) => a + b, 0);
  const quota = lens.map(L => Math.floor(L / total * count));
  const fracs = lens.map((L, i) => ({ i, f: L / total * count - quota[i] })).sort((a, b) => b.f - a.f);
  let left = count - quota.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0; k++, left--) quota[fracs[k % fracs.length].i]++;

  for (let i = 0; i < rings; i++) {
    const m = quota[i];
    if (m <= 0) continue;
    const rIn = R[i] + WOLF_MARGIN, rOut = R[i + 1] - WOLF_MARGIN;
    const rm = midR(R, i);
    // Divider ends are rest stops: keep wolves REST_STOP units away from each corridor's divider
    // (covers the entrance and exit gaps that flank it).
    const sh = (WOLF_MARGIN + REST_STOP) / rIn;
    const spanScale = 1 + Math.min(1, 0.1 * (level - 1));   // territories grow with level
    // stratified centers over the usable angular range
    let rangeLo = 0, rangeLen = TAU;
    if (i === rings - 1) { rangeLo = safe1 + 0.5 / rm; rangeLen = TAU - 2 * safeHalf - 1.0 / rm; }
    const off = rng.next();
    for (let k = 0; k < m; k++) {
      let spec = null;
      for (let attempt = 0; attempt < 6 && !spec; attempt++) {
        const t = attempt === 0 ? (k + off * 0.6 + 0.2) / m : rng.next();
        const c = normAngle(rangeLo + rangeLen * Math.min(0.999, t) + rng.range(-0.15, 0.15) / m * rangeLen * (attempt === 0 ? 1 : 0));
        const seg = findSeg(segments, i, c);
        if (!seg) continue;
        const segLen = seg.a1 - seg.a0;
        let type = rng.pick(p.enemyTypes);
        if (type === 'orbiter' && !(seg.full || segLen >= TAU / 3)) {
          const others = p.enemyTypes.filter(x => x !== 'orbiter');
          type = rng.pick(others);
        }
        let lo, hi;
        if (type === 'orbiter') {
          if (seg.full) {
            if (i === rings - 1) { lo = normAngle(safe1); hi = lo + (TAU - 2 * safeHalf); }
            else { lo = 0; hi = TAU; }
          } else { lo = seg.a0 + sh; hi = seg.a1 - sh; }
        } else {
          const spanLin = spanScale * (type === 'patroller' ? rng.range(8, 18) : type === 'wanderer' ? rng.range(10, 20) : rng.range(2, 5));
          const half = spanLin / 2 / rm;
          const cu = seg.full ? c : unwrapFrom(seg.a0, c);
          lo = cu - half; hi = cu + half;
          if (!seg.full) { lo = Math.max(lo, seg.a0 + sh); hi = Math.min(hi, seg.a1 - sh); }
        }
        if (i === rings - 1) {
          const piece = clipArc(lo, hi, safe0, safe1);
          if (!piece) continue;
          [lo, hi] = piece;
        }
        if ((hi - lo) * rIn < (type === 'sweeper' ? 0.5 : 2.5)) continue;
        const a0 = normAngle(lo);
        const a1 = a0 + Math.min(TAU, hi - lo);
        const full = type === 'orbiter' && hi - lo >= TAU - 1e-9;
        const speedBase = p.enemySpeed * rng.range(0.85, 1.15);
        const id = enemies.length;
        spec = {
          id, type, corridor: i, segment: seg.id,
          rIn, rOut,
          a0: full ? 0 : a0, a1: full ? TAU : a1,
          speed: speedBase * (type === 'orbiter' ? 0.8 : type === 'sweeper' ? 0.9 : 1),
          phase: rng.next(),
          pauseScale: p.enemyPauseScale,
          seed: hashSeed(seed, level, 'wolf', id),
        };
        if (type === 'patroller' || type === 'orbiter') spec.r = rng.range(rIn + 0.2, rOut - 0.2);
        if (type === 'orbiter') spec.dir = rng.chance(0.5) ? 1 : -1;
        if (type === 'sweeper') spec.angle = (spec.a0 + spec.a1) / 2;
      }
      if (spec) enemies.push(spec);
    }
  }
  return enemies;
}

function distToPath(path, x, z) {
  let d = Infinity;
  for (const q of path) d = Math.min(d, (q.x - x) * (q.x - x) + (q.z - z) * (q.z - z));
  return Math.sqrt(d);
}

function placeItems(rng, lvl, p, route) {
  const { R, rings, segments, spawnPoints, path, enemies } = lvl;
  const items = [];
  const taken = [];
  const okSpot = (x, z, minSep) => {
    for (const s of spawnPoints) if (Math.hypot(s.x - x, s.z - z) < 4) return false;
    for (const t of taken) if (Math.hypot(t.x - x, t.z - z) < minSep) return false;
    if (collideCircle(lvl, x, z, CFG.ITEM_RADIUS + 0.15).hit) return false;
    return true;
  };
  // segment degrees (number of gap connections) -> dead ends
  const degree = new Map();
  for (const gs of route.gapSegs) {
    if (gs.inner) degree.set(gs.inner.id, (degree.get(gs.inner.id) || 0) + 1);
    if (gs.outer) degree.set(gs.outer.id, (degree.get(gs.outer.id) || 0) + 1);
  }
  const onPath = new Set(route.legs.filter(l => l.seg).map(l => l.seg.id));
  const randomPointIn = (seg) => {
    const i = seg.corridor;
    const r = rng.range(R[i] + 1.2, R[i + 1] - 1.2);
    const pad = 1.2 / R[i];
    const span = (seg.a1 - seg.a0) - 2 * pad;
    const a = seg.full ? rng.next() * TAU : seg.a0 + pad + rng.next() * Math.max(0, span);
    return { x: r * Math.cos(a), z: r * Math.sin(a), seg };
  };
  const segWeight = (s) => (s.a1 - s.a0) * midR(R, s.corridor);

  // power-ups
  const types = [['boots', 5], ['life', 2], ['shield', 3]];
  for (let n = 0; n < p.itemCount; n++) {
    const type = pickWeighted(rng, types, t => t[1])[0];
    let best = null, bestScore = -Infinity;
    for (let s = 0; s < 40; s++) {
      const seg = pickWeighted(rng, segments, segWeight);
      const c = randomPointIn(seg);
      if (!okSpot(c.x, c.z, 6)) continue;
      const deadEnd = !onPath.has(seg.id) && (degree.get(seg.id) || 0) <= 1;
      const score = Math.min(distToPath(path, c.x, c.z), 12) + (deadEnd ? 8 : 0) + rng.next() * 4;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best) {
      const it = { id: items.length, type, x: best.x, z: best.z };
      items.push(it); taken.push(it);
    }
  }

  // fish breadcrumb trails (groups of up to 3 along the corridor arc)
  let fishLeft = p.fishCount;
  for (let g = 0; g < p.fishCount * 3 && fishLeft > 0; g++) {
    let ax, az;
    const roll = rng.next();
    if (roll < 0.55 && path.length > 4) {
      const q = path[rng.int(2, path.length - 2)];
      ax = q.x; az = q.z;
    } else if (roll < 0.75 && enemies.length) {
      // lure towards a wolf territory (risky!)
      const e = rng.pick(enemies);
      const a = e.type === 'sweeper' ? e.angle : rng.range(e.a0, e.a1);
      const r = rng.range(e.rIn, e.rOut);
      ax = r * Math.cos(a); az = r * Math.sin(a);
    } else {
      const c = randomPointIn(pickWeighted(rng, segments, segWeight));
      ax = c.x; az = c.z;
    }
    const loc = locate(lvl, ax, az);
    if (loc.corridor < 0 || loc.corridor >= rings) continue;
    const i = loc.corridor;
    const r = Math.min(Math.max(loc.r + rng.range(-0.8, 0.8), R[i] + 1.0), R[i + 1] - 1.0);
    const dir = rng.chance(0.5) ? 1 : -1;
    const step = 1.6 / r;
    const groupN = Math.min(3, fishLeft);
    const group = [];
    for (let k = 0; k < groupN; k++) {
      const a = loc.angle + dir * step * k;
      const x = r * Math.cos(a), z = r * Math.sin(a);
      if (locate(lvl, x, z).segment !== loc.segment) break;
      if (!okSpot(x, z, 1.3)) break;
      group.push({ x, z });
    }
    if (group.length < groupN) continue;
    for (const f of group) {
      const it = { id: items.length, type: 'fish', x: f.x, z: f.z };
      items.push(it); taken.push(it);
    }
    fishLeft -= groupN;
  }
  return items;
}

function generateLevel(level, seed) {
  const L = Math.max(1, level | 0);
  const p = levelParams(L);
  const rng = createRng(hashSeed(seed, L));
  const rings = p.rings;
  const R = [];
  for (let j = 0; j <= rings; j++) R.push(CFG.CENTER_RADIUS + j * CFG.RING_WIDTH);

  const { startAngle, gaps, radialWalls } = buildSpiral(R, rings);
  const ctx = { R, rings, gaps, startAngle };
  const segments = buildSegments(rings, radialWalls);
  const route = solveRoute(ctx, segments);

  const wallArcs = buildWallArcs(R, rings, gaps);
  const wallSegments = buildWallSegments(wallArcs, radialWalls);
  const path = buildPath(R, startAngle, rings, route.legs);

  // spawn points: 2x2 block around startAngle, facing the route's first direction
  const firstLeg = route.legs[0];
  let dirSign = 1;
  if (firstLeg && firstLeg.seg) {
    const d = firstLeg.seg.full ? angleDiff(firstLeg.fromA, firstLeg.toA)
      : unwrapFrom(firstLeg.seg.a0, firstLeg.toA) - unwrapFrom(firstLeg.seg.a0, firstLeg.fromA);
    dirSign = d >= 0 ? 1 : -1;
  }
  const rmOut = midR(R, rings - 1);
  const spawnPoints = [];
  for (const [dr, dt] of [[-1.1, 0.9], [1.1, 0.9], [-1.1, -0.9], [1.1, -0.9]]) {
    const r = rmOut + dr;
    const a = startAngle + (dt * dirSign) / r;
    spawnPoints.push({ x: r * Math.cos(a), z: r * Math.sin(a), heading: normAngle(a + dirSign * Math.PI / 2) });
  }

  const lvl = {
    level: L, seed, rings,
    ringRadii: R,
    outerRadius: R[rings],
    gaps,
    wallArcs,
    radialWalls,
    segments,
    wallSegments,
    startAngle,
    spawnPoints,
    enemies: [],
    items: [],
    path,
    theme: (L - 1) % 4,
  };
  // internal fields used during generation only (removed below)
  lvl.R = R;
  lvl.enemies = placeEnemies(rng, lvl, p, route);
  lvl.items = placeItems(rng, lvl, p, route);
  delete lvl.R;
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

function locate(levelData, x, z) {
  const R = levelData.ringRadii;
  const rings = levelData.rings;
  const r = Math.hypot(x, z);
  const angle = normAngle(Math.atan2(z, x));
  if (r < R[0]) return { corridor: -1, segment: -1, r, angle };
  if (r >= R[rings]) return { corridor: rings, segment: -1, r, angle };
  const i = Math.min(rings - 1, Math.max(0, Math.floor((r - R[0]) / CFG.RING_WIDTH)));
  let segment = -1;
  for (const s of levelData.segments) {
    if (s.corridor !== i) continue;
    if (s.a1 - s.a0 >= TAU - 1e-9 && s.full !== false) { segment = s.id; break; }
    if (normAngle(angle - s.a0) <= s.a1 - s.a0) { segment = s.id; break; }
  }
  return { corridor: i, segment, r, angle };
}

function inCenter(levelData, x, z) {
  return Math.hypot(x, z) < levelData.ringRadii[0] - HALF_T;
}

// ---------------------------------------------------------------- self test

function mazeSelfTest(levels = 12) {
  const problems = [];
  const seeds = [1, 42, 1337, 9001, 'kitty', 777777];
  const P = (s, l, msg) => { if (problems.length < 200) problems.push(`seed ${s} L${l}: ${msg}`); };
  const stats = { levels: 0, avgPathLen: 0, radialWalls: 0, enemies: 0, items: 0, fish: 0 };
  for (const s of seeds) {
    for (let l = 1; l <= levels; l++) {
      const ld = generateLevel(l, s);
      const p = levelParams(l);
      stats.levels++;
      // determinism
      const ld2 = generateLevel(l, s);
      if (JSON.stringify(ld) !== JSON.stringify(ld2)) P(s, l, 'not deterministic');
      // angles
      for (const a of ld.wallArcs) if (!(a.a0 >= 0 && a.a0 < TAU && a.a1 > a.a0 && a.a1 - a.a0 <= TAU + 1e-9)) P(s, l, 'bad wallArc ' + JSON.stringify(a));
      for (const g of ld.segments) if (!(g.a0 >= 0 && g.a0 < TAU && g.a1 > g.a0 && g.a1 - g.a0 <= TAU + 1e-9)) P(s, l, 'bad segment ' + JSON.stringify(g));
      for (let j = 0; j < ld.rings; j++) if (!ld.gaps.some(g => g.wall === j)) P(s, l, 'wall ' + j + ' without gap');
      if (ld.gaps.some(g => g.wall >= ld.rings)) P(s, l, 'gap in outer wall');
      // path: starts at start, ends in center, never inside walls
      const path = ld.path;
      if (path.length < 2) P(s, l, 'no path');
      else {
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
      }
      // spawn points
      for (const sp of ld.spawnPoints) {
        if (collideCircle(ld, sp.x, sp.z, CFG.KITTY_RADIUS).hit) P(s, l, 'spawn collides');
        if (locate(ld, sp.x, sp.z).corridor !== ld.rings - 1) P(s, l, 'spawn not in outer corridor');
      }
      if (ld.spawnPoints.length !== 4) P(s, l, 'spawn count');
      // enemies
      if (ld.enemies.length < p.enemyCount * 0.85) P(s, l, `few enemies ${ld.enemies.length}/${p.enemyCount}`);
      const safeA = CFG.START_SAFE_ARC / ld.ringRadii[ld.rings - 1];
      for (const e of ld.enemies) {
        if (!(e.rIn < e.rOut)) P(s, l, 'enemy rIn>=rOut ' + e.id);
        if (!(e.a0 >= 0 && e.a0 < TAU && e.a1 > e.a0 && e.a1 - e.a0 <= TAU + 1e-9)) P(s, l, 'enemy bad angles ' + e.id);
        if (!p.enemyTypes.includes(e.type)) P(s, l, 'enemy type ' + e.type);
        if ((e.type === 'patroller' || e.type === 'orbiter') && !(e.r >= e.rIn && e.r <= e.rOut)) P(s, l, 'enemy r out of bounds');
        if (e.type === 'sweeper' && !(e.angle >= e.a0 && e.angle <= e.a1)) P(s, l, 'sweeper angle out of bounds');
        if (e.type === 'orbiter') { const sg = ld.segments[e.segment]; if (!(sg.full || sg.a1 - sg.a0 >= TAU / 3 - 1e-9)) P(s, l, 'orbiter in short segment'); }
        if (!(e.speed > 0 && e.speed < CFG.KITTY_SPEED)) P(s, l, 'enemy speed ' + e.speed);
        let clip = 0, unsafe = 0;
        for (let u = 0; u <= 8; u++) for (let v = 0; v <= 4; v++) {
          const a = e.a0 + (e.a1 - e.a0) * u / 8, r = e.rIn + (e.rOut - e.rIn) * v / 4;
          const x = r * Math.cos(a), z = r * Math.sin(a);
          if (collideCircle(ld, x, z, CFG.WOLF_RADIUS).hit) clip++;
          if (e.corridor === ld.rings - 1 && Math.abs(angleDiff(a, ld.startAngle)) < safeA) unsafe++;
          if (locate(ld, x, z).corridor !== e.corridor) clip++;
        }
        if (clip) P(s, l, `enemy ${e.id} (${e.type}) bounds clip walls (${clip})`);
        if (unsafe) P(s, l, `enemy ${e.id} covers start safe arc`);
      }
      // items
      const fish = ld.items.filter(i => i.type === 'fish').length;
      if (fish < p.fishCount * 0.8) P(s, l, `few fish ${fish}/${p.fishCount}`);
      if (ld.items.length - fish < p.itemCount) P(s, l, `few items ${ld.items.length - fish}/${p.itemCount}`);
      for (const it of ld.items) {
        if (collideCircle(ld, it.x, it.z, CFG.ITEM_RADIUS).hit) P(s, l, 'item in wall ' + it.id);
        for (const sp of ld.spawnPoints) if (Math.hypot(sp.x - it.x, sp.z - it.z) < 2) P(s, l, 'item near spawn');
        const lc = locate(ld, it.x, it.z);
        if (lc.corridor < 0 || lc.corridor >= ld.rings) P(s, l, 'item outside maze');
      }
      ld.items.forEach((it, k) => { if (it.id !== k) P(s, l, 'item ids not sequential'); });
      ld.enemies.forEach((e, k) => { if (e.id !== k) P(s, l, 'enemy ids not sequential'); });
      stats.radialWalls += ld.radialWalls.length;
      stats.enemies += ld.enemies.length;
      stats.items += ld.items.length - fish;
      stats.fish += fish;
    }
  }
  stats.avgPathLen /= Math.max(1, stats.levels);
  return { ok: problems.length === 0, problems, stats };
}

export { generateLevel, collideCircle, locate, inCenter, mazeSelfTest };
