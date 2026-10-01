import { CFG } from './config.js';
import { hashSeed } from './rng.js';
import { generateLevel, collideCircle, inCenter } from './maze.js';
import { createEnemies, updateEnemies } from './enemies.js';

// Deterministic game simulation core. Pure: no THREE, no DOM, no Math.random, no Date.
// stepSim is the only mutator. All state lives in the Sim object (plain data).
//
// Interpretations / extra fields (beyond CONTRACTS.md):
// - sim.started (bool): false until the first stepSim, which emits levelStart.
// - sim.enteredCenter: array of playerIds that already emitted enterCenter this level.
// - Players already inCenter are clamped to stay inside the center disc.
// - On level transition, shield is reset to 0 silently (no shieldEnd event).
// - Spawn index = player index modulo spawnPoints.length (small offset if more players than points).
// - Pickup 'life' when lives are already at MAX_EXTRA_LIVES is left on the ground.
// - Game over only triggers if there is at least one player in the sim.
// - Velocity component pointing into a wall is removed after collision (smooth sliding).
// - Extra exports: simSummary, addPlayer, removePlayer.


const MAX_SUBSTEP_DISP = 0.25;
const MAX_SUBSTEPS = 64;

function makeLevel(sim, level) {
  sim.level = level;
  sim.levelData = generateLevel(level, hashSeed(sim.seed, level));
  sim.enemies = createEnemies(sim.levelData);
  sim.enemyTicks = 0;          // updateEnemies calls since this level's wolves were created (netcode)
  const src = sim.levelData.items || [];
  const items = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i];
    items.push({ id: it.id, type: it.type, x: it.x, z: it.z, taken: false });
  }
  sim.items = items;
  sim.circles = [];
  sim.enteredCenter = [];
  sim.levelTime = 0;
  sim.state = 'playing';
  sim.stateTimer = 0;
  if (level > sim.stats.bestLevel) sim.stats.bestLevel = level;
}

function spawnPoint(levelData, index) {
  const pts = levelData.spawnPoints || [];
  if (pts.length === 0) return { x: 0, z: 0, heading: 0 };
  const p = pts[index % pts.length];
  const round = Math.floor(index / pts.length);
  if (round === 0) return { x: p.x, z: p.z, heading: p.heading };
  // more players than spawn points: nudge along heading
  const off = 0.9 * round;
  return { x: p.x + Math.cos(p.heading) * off, z: p.z + Math.sin(p.heading) * off, heading: p.heading };
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
  };
}

function createSim({ seed, players = [], startLevel = 1 } = {}) {
  const lvl = Math.max(1, startLevel | 0);
  const sim = {
    seed: seed == null ? 0 : seed,
    level: lvl,
    time: 0,
    levelTime: 0,
    levelData: null,
    enemies: [],
    enemyTicks: 0,
    players: [],
    items: [],
    circles: [],
    state: 'playing',
    stateTimer: 0,
    stats: { rescues: 0, deaths: 0, levelsCleared: 0, bestLevel: lvl },
    started: false,
    enteredCenter: [],
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
  if (!inp) return { x: 0, z: 0 };
  let x = Number.isFinite(inp.x) ? inp.x : 0;
  let z = Number.isFinite(inp.z) ? inp.z : 0;
  const m2 = x * x + z * z;
  if (m2 > 1) {
    const m = Math.sqrt(m2);
    x /= m;
    z /= m;
  }
  return { x, z };
}

function movePlayer(sim, p, inp, dt) {
  const ld = sim.levelData;
  const maxSpeed = CFG.KITTY_SPEED * p.speedMult;
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
  const wasInCenter = p.inCenter;
  const maxCenterR = ld.centerRadius - CFG.WALL_THICKNESS / 2 - 0.05;

  for (let s = 0; s < n; s++) {
    p.vx += (tx - p.vx) * k;
    p.vz += (tz - p.vz) * k;
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
    if (wasInCenter) {
      // stay inside the center disc
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
  if (speed > 0.3) p.heading = Math.atan2(p.vz, p.vx);
  p.moving = speed > 0.5;
}

function nextLevel(sim, events) {
  makeLevel(sim, sim.level + 1);
  for (let i = 0; i < sim.players.length; i++) {
    placeAtSpawn(sim, sim.players[i], i);
  }
  events.push({ type: 'levelStart', level: sim.level });
}

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
    p.inCenter = p.inCenter || inCenter(ld, p.x, p.z);
    if (p.inCenter && sim.enteredCenter.indexOf(p.id) < 0) {
      sim.enteredCenter.push(p.id);
      events.push({ type: 'enterCenter', playerId: p.id });
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
        else p.speedMult = Math.min(CFG.SPEED_MULT_MAX, p.speedMult + CFG.SPEED_BOOST);
      } else if (it.type === 'life') {
        if (p.lives >= CFG.MAX_EXTRA_LIVES) take = false;
        else p.lives = Math.min(CFG.MAX_EXTRA_LIVES, p.lives + 1);
      } else if (it.type === 'shield') {
        p.shield = CFG.SHIELD_TIME;
      }
      if (take) {
        it.taken = true;
        events.push({ type: 'pickup', playerId: p.id, itemType: it.type, itemId: it.id, x: it.x, z: it.z });
        break;
      }
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
      dead.invuln = 0; // no grace period after a friend's revive
      rescuer.rescues++;
      sim.stats.rescues++;
      sim.circles.splice(c, 1);
      events.push({ type: 'revive', playerId: dead.id, by: rescuer.id, x: circ.x, z: circ.z });
    }
  }

  // --- hits ---
  const hitR = CFG.KITTY_RADIUS * CFG.KITTY_HIT_SCALE + CFG.WOLF_RADIUS * CFG.WOLF_HIT_SCALE;
  const hitR2 = hitR * hitR;
  const enemies = sim.enemies || [];
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.alive || p.inCenter || p.invuln > 0 || p.shield > 0) continue;
    for (let e = 0; e < enemies.length; e++) {
      const en = enemies[e];
      const dx = p.x - en.x;
      const dz = p.z - en.z;
      if (dx * dx + dz * dz >= hitR2) continue;
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
        sim.stats.deaths++;
        sim.circles.push({ playerId: p.id, x: p.x, z: p.z, t: 0 });
        events.push({ type: 'death', playerId: p.id, x: p.x, z: p.z, enemyId: en.id });
      }
      break;
    }
  }

  // --- circles age (new circles from this frame stay at t=0) ---
  for (let c = 0; c < sim.circles.length; c++) {
    const circ = sim.circles[c];
    if (circ.t > 0 || !justDied(events, circ.playerId)) circ.t += dt;
  }

  // --- state machine ---
  let alive = 0;
  let aliveInCenter = 0;
  for (let i = 0; i < players.length; i++) {
    if (players[i].alive) {
      alive++;
      if (players[i].inCenter) aliveInCenter++;
    }
  }

  if (sim.state === 'playing') {
    if (alive === 0) {
      if (players.length > 0) {
        sim.state = 'gameover';
        sim.stateTimer = 0;
        events.push({ type: 'gameOver', level: sim.level });
      }
    } else if (aliveInCenter === alive) {
      sim.state = 'levelclear';
      sim.stateTimer = CFG.LEVEL_CLEAR_TIME;
      sim.stats.levelsCleared++;
      events.push({ type: 'levelClear', level: sim.level });
    }
  } else if (sim.state === 'levelclear') {
    sim.stateTimer -= dt;
    if (sim.stateTimer <= 0) {
      sim.stateTimer = 0;
      nextLevel(sim, events);
    }
  }

  return events;
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

function simSummary(sim) {
  let alive = 0;
  for (let i = 0; i < sim.players.length; i++) if (sim.players[i].alive) alive++;
  return {
    level: sim.level,
    alive,
    total: sim.players.length,
    rescues: sim.stats.rescues,
    deaths: sim.stats.deaths,
  };
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

// Client-side prediction: the movement + center part of stepSim for one player (no hits/pickups).
function predictPlayer(sim, p, inp, dt) {
  if (!p.alive || sim.state === 'gameover') return;
  movePlayer(sim, p, readInput({ 0: inp }, 0), dt);
  p.inCenter = p.inCenter || inCenter(sim.levelData, p.x, p.z);
}

// Client mirror: switch to a level the server already generated (same seed => same layout).
function loadLevel(sim, level) {
  makeLevel(sim, level);
}

export { createSim, stepSim, simSummary, addPlayer, removePlayer, predictPlayer, loadLevel };
