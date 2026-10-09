import { CFG, stageOf } from './config.js';
import { hashSeed } from './rng.js';
import { generateLevel, collideCircle, inCenter, onIce, inTree } from './maze.js';
import { createEnemies, updateEnemies } from './enemies.js';

// Deterministic game simulation core. Pure: no THREE, no DOM, no Math.random, no Date.
// stepSim is the only mutator. All state lives in the Sim object (plain data).
//
// Interpretations / extra fields (beyond CONTRACTS.md):
// - sim.started (bool): false until the first stepSim, which emits levelStart.
// - sim.enteredCenter: array of playerIds that already emitted enterCenter this level.
// - inCenter = in the goal disc right now: safe from wolves while inside, free to run back out (only the final run's
//   victory party is kept in it). The level clears when a kitty touches the crown over its middle (so the first one
//   home can wait for the others, or run out again to help).
// - On level transition, shield is reset to 0 silently (no shieldEnd event).
// - Spawn index = player index modulo spawnPoints.length (small offset if more players than points).
// - Pickup 'life' when lives are already at MAX_EXTRA_LIVES is left on the ground.
// - Game over only triggers if there is at least one player in the sim.
// - Velocity component pointing into a wall is removed after collision (smooth sliding).
// - Extra exports: addPlayer, removePlayer.


// Lobby game modes: running + skating (ice level 2), running only, skating only.
const GAME_MODES = ['mixed', 'run', 'ice'];

const MAX_SUBSTEP_DISP = 0.25;
const MAX_SUBSTEPS = 64;

// Level generation can take 100ms+ (Skate pattern wolves), so clients and the server pre-generate the next level
// off-thread and hand it over in sim.pregen = { level, seed, mode, ld }: makeLevel takes it when it matches
// (same inputs => the very same deterministic layout), otherwise generates synchronously.
function pregenParams(sim, level = sim.level + 1) {
  return { level, seed: hashSeed(sim.seed, level), mode: sim.mode, rf: sim.finales };
}

function makeLevel(sim, level) {
  const { seed, mode, rf } = pregenParams(sim, level);
  const pg = sim.pregen;
  sim.pregen = null;
  sim.level = level;
  sim.levelData = pg && pg.ld && pg.level === level && pg.seed === seed && pg.mode === mode && (pg.rf | 0) === rf ? pg.ld : generateLevel(level, seed, mode, rf);
  sim.enemies = createEnemies(sim.levelData);
  sim.enemyTicks = 0;          // updateEnemies calls since this level's wolves were created (netcode)
  const src = sim.levelData.items || [];
  const items = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i];
    items.push({ id: it.id, type: it.type, x: it.x, z: it.z, taken: false, ...(it.mega ? { mega: true } : {}) });
  }
  sim.items = items;
  sim.circles = [];
  sim.enteredCenter = [];
  sim.checkpointsHit = [];
  sim.crownTaken = false;     // the crown floating over the goal, up for grabs each level
  sim.levelTime = 0;
  sim.state = 'playing';
  sim.stateTimer = 0;
  const shown = sim.levelData.level || level;   // (Run + Skate day / night: both halves are the same level)
  if (shown > sim.stats.bestLevel) sim.stats.bestLevel = shown;
}

function spawnPoint(levelData, index) {
  const pts = levelData.spawnPoints || [];
  if (pts.length === 0) return { x: 0, z: 0, heading: 0 };
  if (index < pts.length) return { x: pts[index].x, z: pts[index].z, heading: pts[index].heading };
  // more players than spawn points: fill the rest of the start square (its center is levelData.corners[0])
  const c = levelData.corners[0], h = pts[0].heading;
  return squareSlot(c.x, c.z, h, index);
}

// Slot k of a 6x6 grid (1.35 apart) on a corner square, filled from the middle outwards; rows run across `heading`.
// (Slots 0-3 are the middle 2x2, which the 4 regular spawn points already cover.)
const SLOT_ORDER = [2, 3, 1, 4, 0, 5];
function squareSlot(cx, cz, heading, k) {
  k %= 36;
  const ring = [];
  for (const r of SLOT_ORDER) for (const c of SLOT_ORDER) ring.push([r, c]);
  ring.sort((A, B) => Math.max(Math.abs(A[0] - 2.5), Math.abs(A[1] - 2.5)) - Math.max(Math.abs(B[0] - 2.5), Math.abs(B[1] - 2.5)));
  const [row, col] = ring[k];
  const a = (2.5 - row) * 1.35, b = (col - 2.5) * 1.35;
  const fx = Math.cos(heading), fz = Math.sin(heading);
  return { x: cx + fx * a - fz * b, z: cz + fz * a + fx * b, heading };
}

function placeAtSpawn(sim, p, index) {
  const sp = spawnPoint(sim.levelData, index);
  p.x = sp.x;
  p.z = sp.z;
  p.heading = sp.heading;
  p.vx = 0;
  p.vz = 0;
  p.moving = false;
  p.alive = true;
  p.invuln = CFG.SPAWN_INVULN;
  p.shield = 0;
  p.inCenter = false;
  holdUntilRelease(sim, p);
}

// Ice levels: after a spawn or a checkpoint gather the kitty ignores input until it is let go once, so a key or
// joystick still held from before (or a stale click target) can't shoot it off the safe square onto the ice.
function holdUntilRelease(sim, p) {
  const ld = sim.levelData;
  // (Run + Skate's level 9: not in its run half, solid ground above iceZMax)
  p.waitRelease = !!(ld && ld.ice) && !(ld.iceZMax != null && p.z > ld.iceZMax);
}

function makePlayer(def) {
  return {
    id: def.id,
    name: def.name,
    color: def.color,
    x: 0, z: 0, vx: 0, vz: 0, heading: 0, moving: false,
    alive: true,
    lives: 0,
    speedMult: 1,
    invuln: CFG.SPAWN_INVULN,
    shield: 0,
    inCenter: false,
    deaths: 0,
    rescues: 0,
    bonus: 0,   // extra score points (REVIVE_DOUBLE_LEVEL)
    finishes: 0,    // levels this kitty finished first this run (run rewards, see main.js)
    crowned: false, // grabbed the crown at least once this run (wears one from then on)
  };
}

// finales: the finale version (maze.js generateLevel fv): 0 original, 1 + Run only's level 9 final run, 2 + the wide
// skate final run. Online rooms with an older client play an older version.
function createSim({ seed, players = [], startLevel = 1, mode = 'mixed', finales = 0 } = {}) {
  const lvl = Math.max(1, startLevel | 0);
  const sim = {
    seed: seed == null ? 0 : seed,
    mode: GAME_MODES.includes(mode) ? mode : 'mixed',
    finales: Math.max(0, Math.min(13, finales | 0)),
    level: lvl,
    time: 0,
    levelTime: 0,
    levelData: null,
    pregen: null,   // { level, seed, mode, ld }: the next level, generated off-thread (see makeLevel)
    enemies: [],
    enemyTicks: 0,
    lastWinner: 0,  // id of the kitty that last grabbed the crown in the goal (wears it)
    crownTaken: false,
    players: [],
    items: [],
    circles: [],
    state: 'playing',
    stateTimer: 0,
    stats: { rescues: 0, deaths: 0, levelsCleared: 0, bestLevel: lvl },
    started: false,
    enteredCenter: [],
    checkpointsHit: [],
  };
  makeLevel(sim, lvl);
  for (let i = 0; i < players.length; i++) {
    const p = makePlayer(players[i]);
    placeAtSpawn(sim, p, i);
    sim.players.push(p);
  }
  return sim;
}

function readInput(inputs, id) {
  const inp = inputs ? inputs[id] : null;
  if (!inp) return { x: 0, z: 0, none: true }; // no input received yet (doesn't count as letting go)
  let x = Number.isFinite(inp.x) ? inp.x : 0;
  let z = Number.isFinite(inp.z) ? inp.z : 0;
  const m2 = x * x + z * z;
  if (m2 > 1) {
    const m = Math.sqrt(m2);
    x /= m;
    z /= m;
  }
  return inp.m ? { x, z, m: 1 } : { x, z };   // m: sound on (CFG.MUSIC_BOOST)
}

function movePlayer(sim, p, inp, dt) {
  const ld = sim.levelData;
  if (p.waitRelease) {
    if (!inp.none && inp.x * inp.x + inp.z * inp.z < 0.01) p.waitRelease = false;
    else inp = { x: 0, z: 0 };
  }
  const maxSpeed = CFG.KITTY_SPEED * p.speedMult * (inp.m ? CFG.MUSIC_BOOST_LEVEL[ld.level || sim.level] || CFG.MUSIC_BOOST : 1);   // (inp.m: sound on, see MUSIC_BOOST)
  const tx = inp.x * maxSpeed;
  const tz = inp.z * maxSpeed;
  const curSpeed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  const tgtSpeed = Math.sqrt(tx * tx + tz * tz);
  const estDisp = Math.max(curSpeed, tgtSpeed) * dt;
  let n = Math.ceil(estDisp / MAX_SUBSTEP_DISP);
  if (!(n >= 1)) n = 1;
  if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
  const h = dt / n;
  const k = 1 - Math.exp(-h / CFG.KITTY_ACCEL_TAU);
  const kIce = 1 - Math.exp(-h / CFG.ICE_ACCEL_TAU);
  const maxTurn = CFG.ICE_TURN_RATE * h;
  const steering = inp.x * inp.x + inp.z * inp.z > 0.01;
  let iced = false;
  const wasInCenter = p.inCenter;
  const maxCenterR = ld.centerRadius - CFG.WALL_THICKNESS / 2 - 0.05;

  for (let s = 0; s < n; s++) {
    if (onIce(ld, p.x, p.z)) {
      // skating: keep going the way we face, turn toward the input at a limited rate
      iced = true;
      let sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
      let ang = sp > 0.05 ? Math.atan2(p.vz, p.vx) : p.heading;
      if (steering && p.freeTurn && sp <= 0.05) ang = Math.atan2(inp.z, inp.x);   // just revived, standing: any way at once
      else if (steering) {
        let d = Math.atan2(inp.z, inp.x) - ang;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d <= -Math.PI) d += 2 * Math.PI;
        ang += d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d;
      }
      if (steering || sp > 0.05) sp += (maxSpeed - sp) * kIce;
      p.vx = Math.cos(ang) * sp;
      p.vz = Math.sin(ang) * sp;
      p.heading = ang;
    } else {
      p.vx += (tx - p.vx) * k;
      p.vz += (tz - p.vz) * k;
    }
    if (steering) p.freeTurn = false;   // (the first steer after a revive used it, on ice or not)
    const nx = p.x + p.vx * h;
    const nz = p.z + p.vz * h;
    const c = collideCircle(ld, nx, nz, CFG.KITTY_RADIUS);
    let cx = c.x;
    let cz = c.z;
    if (c.hit) {
      const px = cx - nx;
      const pz = cz - nz;
      const pl = Math.sqrt(px * px + pz * pz);
      if (pl > 1e-6) {
        const ux = px / pl;
        const uz = pz / pl;
        const vn = p.vx * ux + p.vz * uz;
        if (vn < 0) {
          p.vx -= vn * ux;
          p.vz -= vn * uz;
        }
      }
    }
    if (wasInCenter && sim.state === 'victory') {
      // the final run's victory party stays inside the center disc (otherwise the disc is free to leave)
      const r = Math.sqrt(cx * cx + cz * cz);
      if (r > maxCenterR && r > 1e-6) {
        const ux = cx / r;
        const uz = cz / r;
        cx = ux * maxCenterR;
        cz = uz * maxCenterR;
        const vn = p.vx * ux + p.vz * uz;
        if (vn > 0) {
          p.vx -= vn * ux;
          p.vz -= vn * uz;
        }
      }
    }
    p.x = cx;
    p.z = cz;
  }

  const speed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  if (speed > 0.3 && !iced) p.heading = Math.atan2(p.vz, p.vx);
  p.moving = speed > 0.5;
  p.onIce = onIce(ld, p.x, p.z);
}

function nextLevel(sim, events) {
  makeLevel(sim, sim.level + 1);
  for (let i = 0; i < sim.players.length; i++) {
    placeAtSpawn(sim, sim.players[i], i);
  }
  events.push({ type: 'levelStart', level: sim.level });
}

// the hit check's wolf grid (stepSim): used above HIT_GRID_MIN wolves; cells HIT_CELL wide (more than a hit's reach,
// so a kitty's own cell and its 8 neighbours hold every wolf that can touch it)
const HIT_GRID_MIN = 64, HIT_CELL = 2;
const hitCell = (x, z) => (Math.floor(x / HIT_CELL) + 32768) * 65536 + (Math.floor(z / HIT_CELL) + 32768);
function stepSim(sim, inputs, dt) {
  const events = [];
  if (!(dt > 0)) dt = 0;

  if (!sim.started) {
    sim.started = true;
    events.push({ type: 'levelStart', level: sim.level });
  }

  sim.time += dt;
  sim.levelTime += dt;

  updateEnemies(sim.enemies, sim.levelData, dt);
  sim.enemyTicks++;

  if (sim.state === 'gameover') return events;

  const players = sim.players;
  const ld = sim.levelData;

  // --- timers ---
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.invuln > 0) {
      p.invuln -= dt;
      if (p.invuln < 0) p.invuln = 0;
    }
    if (p.shield > 0) {
      p.shield -= dt;
      if (p.shield <= 0) {
        p.shield = 0;
        if (p.alive) events.push({ type: 'shieldEnd', playerId: p.id });
      }
    }
  }

  // --- movement + center ---
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.alive) {
      p.vx = 0;
      p.vz = 0;
      p.moving = false;
      continue;
    }
    movePlayer(sim, p, readInput(inputs, p.id), dt);
    p.inCenter = inCenterNow(sim, p);
    if (p.inCenter && sim.enteredCenter.indexOf(p.id) < 0) {
      sim.enteredCenter.push(p.id);
      events.push({ type: 'enterCenter', playerId: p.id, level: sim.level });   // (level: the stage it was, for the unlocks)
    }
  }

  // --- pickups ---
  const pickR = CFG.KITTY_RADIUS + CFG.ITEM_RADIUS;
  const pickR2 = pickR * pickR;
  for (let j = 0; j < sim.items.length; j++) {
    const it = sim.items[j];
    if (it.taken) continue;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;
      const dx = p.x - it.x;
      const dz = p.z - it.z;
      if (dx * dx + dz * dz >= pickR2) continue;
      let take = true;
      if (it.type === 'boots') {
        if (p.speedMult >= CFG.SPEED_MULT_MAX) take = false; // already boosted: leave them for a friend
        else p.speedMult = it.mega ? CFG.SPEED_MULT_MAX : Math.min(CFG.SPEED_MULT_MAX, p.speedMult + CFG.SPEED_BOOST);   // (a big pair: full speed at once)
      } else if (it.type === 'life') {
        if (p.lives >= CFG.MAX_EXTRA_LIVES) take = false;   // (already has one: left for a friend, even on HEART_BOOT_LEVEL)
        else {
          p.lives = Math.min(CFG.MAX_EXTRA_LIVES, p.lives + 1);
          if ((sim.levelData.level || sim.level) === CFG.HEART_BOOT_LEVEL) p.speedMult = Math.min(CFG.SPEED_MULT_MAX, p.speedMult + CFG.SPEED_BOOST);   // a pair of boots too
        }
      } else if (it.type === 'shield') {
        p.shield = CFG.SHIELD_TIME;
      }
      if (take) {
        it.taken = true;
        events.push({ type: 'pickup', playerId: p.id, itemType: it.type, itemId: it.id, x: it.x, z: it.z, ...(it.mega ? { mega: true } : {}) });
        break;
      }
    }
  }

  // --- crown: floats over the middle of the goal room. The goal disc only makes you safe (wait there and watch your
  // friends make it); the first kitty to touch the crown wears it and clears the level ---
  let crownBy = null;
  if (!sim.crownTaken) {
    const cr = CFG.KITTY_RADIUS + CFG.CROWN_RADIUS;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const cx = p.x - ld.crown.x, cz = p.z - ld.crown.z;
      if (!p.alive || cx * cx + cz * cz >= cr * cr) continue;
      sim.crownTaken = true;
      sim.lastWinner = p.id;
      p.crowned = true; // keeps wearing a crown for the rest of the run
      events.push({ type: 'crown', playerId: p.id });
      crownBy = p;
      break;
    }
  }

  // --- revive (after movement) ---
  if (sim.circles.length > 0) {
    const revR = CFG.REVIVE_RADIUS + CFG.KITTY_RADIUS;
    const revR2 = revR * revR;
    for (let c = sim.circles.length - 1; c >= 0; c--) {
      const circ = sim.circles[c];
      const dead = findPlayer(sim, circ.playerId);
      if (!dead) {
        sim.circles.splice(c, 1);
        continue;
      }
      if (dead.alive) {
        sim.circles.splice(c, 1);
        continue;
      }
      if (circ.t < CFG.REVIVE_DELAY) continue; // revive cooldown
      let rescuer = null;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p.alive || p.inCenter || p === dead) continue;
        const dx = p.x - circ.x;
        const dz = p.z - circ.z;
        if (dx * dx + dz * dz < revR2) {
          rescuer = p;
          break;
        }
      }
      if (!rescuer) continue;
      dead.alive = true;
      dead.x = circ.x;
      dead.z = circ.z;
      dead.vx = 0;
      dead.vz = 0;
      dead.moving = false;
      dead.inCenter = false;
      dead.invuln = CFG.REVIVE_INVULN;   // a short grace period (it can't go down again, and be revived, at once)
      dead.freeTurn = true;   // on ice: its first steer picks the way it skates off (not the way it faced going down)
      rescuer.rescues++;
      if ((sim.levelData.level || sim.level) === CFG.REVIVE_DOUBLE_LEVEL) rescuer.bonus = (rescuer.bonus || 0) + 1;   // (scores double, REVIVE_DOUBLE_LEVEL)
      sim.stats.rescues++;
      sim.circles.splice(c, 1);
      events.push({ type: 'revive', playerId: dead.id, by: rescuer.id, x: circ.x, z: circ.z });
    }
  }

  // --- checkpoints: first kitty onto one revives everyone and gathers the rest of the team there. The kitty that
  // reached it keeps going untouched (position, speed, heading); the others land on the square's slot grid, skipping
  // any slot the activator is standing on ---
  const cps = ld.checkpoints || [];
  for (let c = 0; c < cps.length; c++) {
    if (sim.state !== 'playing' || sim.checkpointsHit.indexOf(c) >= 0) continue;
    const cp = cps[c];
    const h = (ld.safeSize || ld.corridorWidth) / 2 - CFG.WALL_THICKNESS / 2;
    // a broken (medic) checkpoint: only a kitty with cp.minRescues revives this run can repair it
    const by = players.find((p) => p.alive && !p.inCenter && Math.abs(p.x - cp.x) < h && Math.abs(p.z - cp.z) < h && (p.rescues || 0) >= (cp.minRescues || 0));
    if (!by) continue;
    sim.checkpointsHit.push(c);
    const revived = [], moved = [];
    let slot = 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.inCenter || p === by) continue;
      // the broken (medic) checkpoint: a kitty still alive that is already past it (in the run half, beyond the square in
      // the run direction) stays where it is; only the downed and those behind (skate half, hallway, the square) gather
      if (cp.medic && p.alive && (ld.iceZMax == null || p.z > ld.iceZMax) && ((p.x - cp.x) * Math.cos(cp.heading) + (p.z - cp.z) * Math.sin(cp.heading)) > h) continue;
      if (!p.alive) { p.alive = true; p.shield = 0; revived.push(p.id); }
      moved.push(p.id);
      // a grid filling the square from the middle out (room for 36)
      let sp = squareSlot(cp.x, cp.z, cp.heading, slot);
      for (let g = 0; g < 36 && Math.hypot(sp.x - by.x, sp.z - by.z) < 1; g++) sp = squareSlot(cp.x, cp.z, cp.heading, ++slot);
      p.x = sp.x;
      p.z = sp.z;
      p.heading = cp.heading;
      p.vx = 0; p.vz = 0; p.moving = false;
      p.invuln = 0;
      holdUntilRelease(sim, p);
      slot++;
    }
    sim.circles = sim.circles.filter((circ) => { const q = findPlayer(sim, circ.playerId); return q && !q.alive; });
    events.push({ type: 'checkpoint', index: c, by: by.id, x: cp.x, z: cp.z, revived, moved, ...(cp.medic ? { medic: true } : {}) });
  }

  // --- hits ---
  const hitR = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
  const hitR2 = hitR * hitR;
  const enemies = sim.enemies || [];
  // with many wolves: a coarse grid of them (built once, the first time a kitty needs it), so each kitty only tests
  // the wolves around it. The wolf that catches is the same as with the plain scan: the first in the list that touches.
  let grid = null;
  const big = enemies.length > HIT_GRID_MIN;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (sim.state !== 'playing') break; // no deaths during the level-clear celebration
    if (!p.alive || p.inCenter || p.invuln > 0 || p.shield > 0) continue;
    if (inTree(ld, p.x, p.z)) continue; // up a tree: safe
    let hit = -1;
    if (big) {
      if (!grid) {
        grid = new Map();
        for (let e = 0; e < enemies.length; e++) {
          const k = hitCell(enemies[e].x, enemies[e].z), a = grid.get(k);
          if (a) a.push(e); else grid.set(k, [e]);
        }
      }
      const cx = Math.floor(p.x / HIT_CELL), cz = Math.floor(p.z / HIT_CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const a = grid.get((gx + 32768) * 65536 + (gz + 32768));
        if (!a) continue;
        for (let q = 0; q < a.length; q++) {
          const e = a[q];
          if (hit >= 0 && e >= hit) continue;
          const dx = p.x - enemies[e].x, dz = p.z - enemies[e].z;
          if (dx * dx + dz * dz < hitR2) hit = e;
        }
      }
    } else {
      for (let e = 0; e < enemies.length; e++) {
        const dx = p.x - enemies[e].x, dz = p.z - enemies[e].z;
        if (dx * dx + dz * dz < hitR2) { hit = e; break; }
      }
    }
    if (hit >= 0) {
      const en = enemies[hit];
      if (p.lives > 0) {
        p.lives--;
        p.invuln = CFG.SPAWN_INVULN;
        events.push({ type: 'extraLife', playerId: p.id, x: p.x, z: p.z });
      } else {
        p.alive = false;
        p.vx = 0;
        p.vz = 0;
        p.moving = false;
        p.shield = 0;
        p.invuln = 0;
        p.deaths++;
        p.speedMult = 1; // speed boots are lost when caught
        sim.stats.deaths++;
        sim.circles.push({ playerId: p.id, x: p.x, z: p.z, t: 0 });
        events.push({ type: 'death', playerId: p.id, x: p.x, z: p.z, enemyId: en.id });
      }
    }
  }

  // --- circles age (new circles from this frame stay at t=0) ---
  for (let c = 0; c < sim.circles.length; c++) {
    const circ = sim.circles[c];
    if (circ.t > 0 || !justDied(events, circ.playerId)) circ.t += dt;
  }

  // --- state machine ---
  let alive = 0;
  for (let i = 0; i < players.length; i++) if (players[i].alive) alive++;

  if (sim.state === 'playing') {
    if (alive === 0) {
      if (players.length > 0) {
        sim.state = 'gameover';
        sim.stateTimer = 0;
        events.push({ type: 'gameOver', level: ld.level || sim.level });
      }
    } else if (crownBy) {
      // the crown's been grabbed (from inside the goal disc): its kitty clears the level
      const by = crownBy;
      if (stageOf(sim.mode, sim.finales, sim.level).day) {
        // Run + Skate by day: a checkpoint, not a cleared level; everyone revives on the night rink (nextLevel). The
        // crown still counts as a win (the cosmetic rewards)
        by.finishes = (by.finishes || 0) + 1;
        events.push({ type: 'stageClear', level: ld.level, by: by.id });
        sim.state = 'levelclear';
        sim.stateTimer = CFG.LEVEL_CLEAR_TIME;
      } else {
      by.finishes = (by.finishes || 0) + 1;
      sim.stats.levelsCleared++;
      events.push({ type: 'levelClear', level: ld.level || sim.level, by: by.id });
      if (ld.finale) win(sim, by, events);
      else {
        sim.state = 'levelclear';
        sim.stateTimer = CFG.LEVEL_CLEAR_TIME;
      }
      }
    }
  } else if (sim.state === 'victory') {
    sim.stateTimer += dt;      // seconds since the win (the party never ends; the client / server decide when to leave)
  } else if (sim.state === 'levelclear') {
    sim.stateTimer -= dt;
    if (sim.stateTimer <= 0) {
      sim.stateTimer = 0;
      nextLevel(sim, events);
    }
  }

  return events;
}

// The final run is cleared: the game is won. Every kitty that went down on the way is carried into the goal
// room for the party (a ring around the portal); state 'victory' is final (no next level, no more deaths).
function win(sim, by, events) {
  sim.state = 'victory';
  sim.stateTimer = 0;
  const party = [];
  let slot = 0;
  for (let i = 0; i < sim.players.length; i++) {
    const p = sim.players[i];
    if (p.alive && p.inCenter) continue;
    const a = slot++ * 2.399963;   // golden angle: an even ring however many show up
    const r = 2.6 + 0.35 * (slot % 3);
    p.alive = true;
    p.x = Math.cos(a) * r; p.z = Math.sin(a) * r;
    p.vx = 0; p.vz = 0; p.moving = false;
    p.heading = Math.atan2(-p.z, -p.x);
    p.inCenter = true;
    p.shield = 0; p.invuln = 0;
    party.push(p.id);
  }
  sim.circles = [];
  events.push({ type: 'victory', level: sim.levelData.level || sim.level, by: by.id, time: sim.levelTime, party });
}

function justDied(events, playerId) {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'death' && ev.playerId === playerId) return true;
  }
  return false;
}

function findPlayer(sim, id) {
  for (let i = 0; i < sim.players.length; i++) {
    if (sim.players[i].id === id) return sim.players[i];
  }
  return null;
}

// Join mid-game: spawns alive at a spawn point with spawn invulnerability.
function addPlayer(sim, { id, name, color }) {
  const existing = findPlayer(sim, id);
  if (existing) return existing;
  const p = makePlayer({ id, name, color });
  placeAtSpawn(sim, p, sim.players.length);
  sim.players.push(p);
  return p;
}

function removePlayer(sim, id) {
  const idx = sim.players.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  sim.players.splice(idx, 1);
  sim.circles = sim.circles.filter((c) => c.playerId !== id);
  const ei = sim.enteredCenter.indexOf(id);
  if (ei >= 0) sim.enteredCenter.splice(ei, 1);
  return true;
}

// In the goal disc right now (it makes you safe while you're in it; you can run back out). The final run's victory
// party stays in it.
function inCenterNow(sim, p) {
  const now = inCenter(sim.levelData, p.x, p.z);
  return sim.state === 'victory' ? p.inCenter || now : now;
}

// Client-side prediction: the movement + center part of stepSim for one player (no hits/pickups).
function predictPlayer(sim, p, inp, dt) {
  if (!p.alive || sim.state === 'gameover') return;
  movePlayer(sim, p, readInput({ 0: inp }, 0), dt);
  p.inCenter = inCenterNow(sim, p);
}

// Client mirror: switch to a level the server already generated (same seed => same layout).
function loadLevel(sim, level) {
  makeLevel(sim, level);
}

export { GAME_MODES, pregenParams, createSim, stepSim, addPlayer, removePlayer, predictPlayer, loadLevel };
