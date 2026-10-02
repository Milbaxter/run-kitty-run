// Sim + rules tests (the bulk of `npm test`): pure, no server, ~6s (mostly the maze self-test). Add new checks here rather than new scripts.
// Exit code 1 if any check fails.
import { createSim, stepSim } from '../public/js/shared/sim.js';
import { CFG, SKATE_FINAL_LEVEL, FINAL_MODES, PLAYER_NAMES } from '../public/js/shared/config.js';
import { generateLevel, mazeSelfTest } from '../public/js/shared/maze.js';
import { filterChat, filterName } from '../public/js/shared/filter.js';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

// ======== rules: first kitty home clears the level, everyone respawns; wolves ramp toward the goal; pickups, crown, trees
{
  // Game rules: first kitty in the goal clears the level, everyone respawns alive at the start;
  // wolves get faster/denser toward the middle.

  const sim = createSim({ seed: 5, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] });
  stepSim(sim, {}, CFG.TICK);
  const [a, b, c] = sim.players;
  b.alive = false; b.deaths = 1; sim.circles.push({ playerId: 2, x: b.x, z: b.z, t: 0 });
  a.x = 0; a.z = 0;                       // a reaches the goal; c is still out in the maze
  let ev = stepSim(sim, {}, CFG.TICK);
  const clear = ev.find((e) => e.type === 'levelClear');
  ok(clear && clear.by === 1 && sim.state === 'levelclear', 'one kitty in the goal clears the level');
  let died = false, levelStart = false;
  for (let t = 0; t < 60 * 3 && !levelStart; t++) {
    c.invuln = 0; ev = stepSim(sim, {}, CFG.TICK);
    if (ev.some((e) => e.type === 'death')) died = true;
    if (ev.some((e) => e.type === 'levelStart')) levelStart = true;
  }
  ok(!died, 'nobody dies during the level-clear celebration');
  ok(levelStart && sim.level === 2, 'next level starts');
  const spawns = sim.levelData.spawnPoints;
  ok(sim.players.every((p) => p.alive && !p.inCenter && Math.hypot(p.x - spawns[0].x, p.z - spawns[0].z) < 4), 'everyone (incl. the dead one) respawns alive at the start');

  // running levels ramp up toward the goal (winter levels in the default mode are the gentler ice rink, so use run mode)
  const ld = generateLevel(sim.level, sim.levelData.seed, 'run');
  ok(ld.enemies.length >= 200, `wolves: ${ld.enemies.length}`);
  const half = Math.floor(ld.legs.length / 2);
  const outer = ld.enemies.filter((e) => e.leg < half), inner = ld.enemies.filter((e) => e.leg >= half);
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const len = (from, to) => ld.legs.slice(from, to).reduce((s, l) => s + l.len, 0);
  ok(avg(inner.map((e) => e.speed)) > avg(outer.map((e) => e.speed)) * 1.05, `inner wolves faster (${avg(outer.map((e) => e.speed)).toFixed(2)} -> ${avg(inner.map((e) => e.speed)).toFixed(2)})`);
  ok(inner.length / len(half) > outer.length / len(0, half), `inner legs denser (${(outer.length / len(0, half)).toFixed(3)} -> ${(inner.length / len(half)).toFixed(3)} wolves/unit)`);
  const n = ld.legs.length;
  const fin = ld.enemies.filter((e) => e.leg === n - 1);
  ok(fin.length >= 8, `final stretch is crowded (${fin.length} wolves)`);
  {
    // the default mode's winter ice rink keeps wanderers; Skate only mode has pattern wolves (ice-pattern-test.mjs)
    const winter = [1, 2, 3, 4].find((L) => generateLevel(L, sim.levelData.seed, 'mixed').ice);
    const ice = generateLevel(winter, sim.levelData.seed, 'mixed');
    const sp = (l, f) => avg(l.enemies.filter(f).map((e) => e.speed));
    const gain = (l) => sp(l, (e) => e.leg >= half) / sp(l, (e) => e.leg < half);
    ok(ice.ice && gain(ice) < gain(ld), `ice levels ramp more gently (inner/outer speed x${gain(ice).toFixed(3)} vs x${gain(ld).toFixed(3)} running)`);
  }
  ok(ld.safeCorners.length === ld.corners.length - 2 && fin.some((e) => e.a0 < CFG.RING_WIDTH / 2), 'the goal-door corner is not a safe square');
  {
    // nothing marked safe is ever touched by a wolf; the final stretch's first corner is not marked safe
    const s2 = createSim({ seed: 11, players: [] });
    const W = s2.levelData.corridorWidth;
    let touched = 0;
    for (let t = 0; t < 60 * 60; t++) {
      stepSim(s2, {}, CFG.TICK);
      for (const e of s2.enemies) for (const c of s2.levelData.safeCorners) if (Math.abs(e.x - c.x) < W / 2 + e.radius && Math.abs(e.z - c.z) < W / 2 + e.radius) touched++;
    }
    const c5 = s2.levelData.corners.at(-2);
    ok(touched === 0 && !s2.levelData.safeCorners.includes(c5), 'safe tiles are truly wolf-free; final-stretch corners have no tile');
  }

  // revive cooldown: standing on a fresh circle does nothing until REVIVE_DELAY has passed
  {
    const s = createSim({ seed: 8, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    stepSim(s, {}, CFG.TICK);
    const [p1, p2] = s.players;
    p1.invuln = 99; p2.invuln = 0;
    p2.alive = false; s.circles.push({ playerId: 2, x: p1.x, z: p1.z, t: 0 });
    let t = 0, revivedAt = -1;
    for (; t < 120 && revivedAt < 0; t++) { p1.invuln = 99; if (stepSim(s, {}, CFG.TICK).some((e) => e.type === 'revive')) revivedAt = t; }
    const secs = (revivedAt + 1) * CFG.TICK;
    ok(revivedAt >= 0 && secs >= CFG.REVIVE_DELAY - 1e-9 && secs < CFG.REVIVE_DELAY + 0.05, `revive only after the ${CFG.REVIVE_DELAY}s cooldown (${secs.toFixed(2)}s)`);
  }

  // speed boots: 4 pairs max, lost when caught (an extra life keeps them)
  {
    const s = createSim({ seed: 21, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    stepSim(s, {}, CFG.TICK);
    const p = s.players[0];
    const grab = () => { s.items.push({ id: 900 + s.items.length, type: 'boots', x: p.x, z: p.z, taken: false }); stepSim(s, {}, CFG.TICK); return s.items.at(-1).taken; };
    const took = [grab(), grab(), grab(), grab(), grab()];
    ok(took.join() === 'true,true,true,true,false' && Math.abs(p.speedMult - (1 + 4 * CFG.SPEED_BOOST)) < 1e-9, `4 pairs of boots max (picked ${took}, speed x${p.speedMult.toFixed(2)})`);
    // (wolf positions are recomputed every tick, so move the kitty onto a wolf instead)
    const w = s.enemies[0];
    const hit = () => { p.invuln = 0; p.shield = 0; p.x = w.x; p.z = w.z; return stepSim(s, {}, CFG.TICK); };
    p.lives = 1;
    const ev1 = hit();
    ok(ev1.some((e) => e.type === 'extraLife') && p.alive && p.speedMult > 1.1, 'an extra life keeps your boots');
    const ev2 = hit();
    ok(ev2.some((e) => e.type === 'death') && !p.alive && p.speedMult === 1, 'boots are lost when caught');
  }

  // crown + aura bookkeeping: the first kitty home wears the crown; finishes are counted per kitty
  {
    const s = createSim({ seed: 31, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    stepSim(s, {}, CFG.TICK);
    const finish = (p) => { for (const q of s.players) q.invuln = 99; p.x = s.levelData.crown.x; p.z = s.levelData.crown.z; stepSim(s, {}, CFG.TICK); p.x = 0; p.z = 0; let t = 0; while (t++ < 400 && !stepSim(s, {}, CFG.TICK).some((e) => e.type === 'levelStart')); };
    const [a, b] = s.players;
    finish(a);
    ok(s.lastWinner === 1 && a.finishes === 1, 'first finisher wears the crown');
    finish(b);
    ok(s.lastWinner === 2 && b.finishes === 1 && a.finishes === 1, 'crown moves to the newest finisher');
    finish(a);
    ok(a.finishes === 2 && s.lastWinner === 1, 'two finishes = aura');
  }
  // autumn levels: a kitty up a climbable tree can't be caught
  {
    const s = createSim({ seed: 41, startLevel: 2, players: [{ id: 1, name: 'a' }] });
    stepSim(s, {}, CFG.TICK);
    const p = s.players[0], t = s.levelData.trees[2];
    ok(s.levelData.trees.length >= 10, `autumn level has climbable trees (${s.levelData.trees.length})`);
    // (wolf positions are recomputed every tick, so put the kitty onto a wolf, with and without a tree there)
    const w = s.enemies[0];
    const onWolf = () => { p.invuln = 0; p.x = w.x; p.z = w.z; return stepSim(s, {}, CFG.TICK); };
    s.levelData.trees.push({ x: w.x, z: w.z });
    let ev = onWolf();
    ok(p.alive && !ev.some((e) => e.type === 'death'), 'a kitty up a tree is safe');
    s.levelData.trees.pop();
    ev = onWolf();
    ok(ev.some((e) => e.type === 'death'), 'the same spot without a tree is deadly');
    const tb = s.levelData.items.filter((it) => it.tree);
    ok(tb.length === s.levelData.trees.length && tb.every((it, i) => it.type === 'boots' && it.x === s.levelData.trees[i].x), `a pair of boots on top of every tree (${tb.length})`);
    void t;
  }
  // the crown is a pickup over the goal's center: reaching the goal's edge clears the level but doesn't grab it
  {
    const s = createSim({ seed: 32, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    stepSim(s, {}, CFG.TICK);
    const [a, b] = s.players;
    for (const q of s.players) q.invuln = 99;
    a.x = s.levelData.centerRadius - 1; a.z = 0;
    let ev = stepSim(s, {}, CFG.TICK);
    ok(ev.some((e) => e.type === 'levelClear') && !s.crownTaken && s.lastWinner === 0, 'goal edge clears the level, crown still up for grabs');
    b.x = s.levelData.crown.x; b.z = s.levelData.crown.z; // a teammate darts to the crown during the celebration
    ev = stepSim(s, {}, CFG.TICK);
    ok(ev.some((e) => e.type === 'crown' && e.playerId === 2) && s.lastWinner === 2 && a.finishes === 1, 'whoever touches the crown wears it');
  }
}

// ======== playthrough: a kitty steering along the level path (invulnerable) reaches the goal and clears the level
{
  // A kitty steering along the level path (invulnerable) reaches the goal and clears the level.
  const sim = createSim({ seed: 31337, players: [{ id: 1, name: 'bot', color: 0 }] });
  const path = sim.levelData.path;
  let k = 0, cleared = -1;
  for (let t = 0; t < 60 * 400 && cleared < 0; t++) {
    const p = sim.players[0];
    p.invuln = 1;
    while (k < path.length - 1 && Math.hypot(path[k].x - p.x, path[k].z - p.z) < 1.5) k++;
    const dx = path[k].x - p.x, dz = path[k].z - p.z, d = Math.hypot(dx, dz) || 1;
    const ev = stepSim(sim, { 1: { x: dx / d, z: dz / d } }, CFG.TICK);
    if (ev.some((e) => e.type === 'levelClear')) cleared = t;
  }
  ok(cleared > 0, cleared > 0 ? `level cleared after ${(cleared / 60).toFixed(1)}s of running` : `stuck at path point ${k}/${path.length}`);
}

// ======== victory: Skate only / Run + Skate final run ends the game; other levels and modes unchanged
{
  // Skate only's final run ends the game: reaching the goal on level SKATE_FINAL_LEVEL wins ('victory', final),
  // downed kitties are carried to the party, and no other level or mode changed its flow.
  const players = [1, 2, 3].map((id) => ({ id, name: 'k' + id, color: id }));
  // Run + Skate seasons: summer, fall, winter (ice) x3; the third winter is the boss run
  const themes = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => generateLevel(l, 9, 'mixed').theme).join(',');
  ok(themes === '0,1,2,0,1,2,0,1,2', `Run + Skate themes by level: ${themes}`);
  const toGoal = (sim, id) => { const p = sim.players.find((q) => q.id === id); p.x = 0; p.z = 0; };
  const run = (sim, ticks) => { const all = []; for (let t = 0; t < ticks; t++) all.push(...stepSim(sim, {}, CFG.TICK)); return all; };

  for (const mode of FINAL_MODES) {
  const fin = createSim({ seed: 9, players, startLevel: SKATE_FINAL_LEVEL, mode });
  ok(fin.levelData.finale && fin.levelData.ice && fin.levelData.checkpoints.length === 0 && fin.levelData.trees.length === 1 && fin.enemies.every((e) => e.route), `${mode}: level ${SKATE_FINAL_LEVEL} is the final run (ice, pattern wolves, no checkpoints, one tree)`);
  run(fin, 1);
  fin.players[1].alive = false;
  toGoal(fin, 1);
  const ev = run(fin, 1).map((e) => e.type);
  ok(ev.includes('levelClear') && ev.includes('victory') && fin.state === 'victory', `goal -> victory (${ev.join(',')})`);
  ok(fin.players.every((p) => p.alive && p.inCenter), 'downed and lagging kitties carried to the party');
  run(fin, 60 * 60);
  ok(fin.state === 'victory' && fin.level === SKATE_FINAL_LEVEL, `${mode}: after 60 s still victory on the final level (never the next one)`);
  }

  for (const [mode, lvl, next] of [['mixed', 8, 9], ['ice', 8, 9], ['run', 8, 9], ['run', 9, 10]]) {
    const sim = createSim({ seed: 9, players: players.slice(0, 1), startLevel: lvl, mode });
    run(sim, 1); toGoal(sim, 1);
    run(sim, Math.ceil(CFG.LEVEL_CLEAR_TIME * 60) + 5);
    ok(sim.level === next && sim.state === 'playing' && !!sim.levelData.finale === (FINAL_MODES.includes(mode) && next === SKATE_FINAL_LEVEL), `${mode} level ${lvl}: cleared -> level ${next}${sim.levelData.finale ? ' (the final run)' : ''}`);
  }
}

// ======== chat + name filter (public/js/shared/filter.js, store apps only)
{
  const masked = ['fuck you', 'F U C K', 'f.u.c.k', 'sh1t', '$h!t', 'a$$', 'fuuuuck', 'b!tch', 'you ass!', 'fück', 'n1gger',
    'sh*t', 'bullshit', 'kys', 'kill yourself', 'stupid c u n t', 'sexy'];
  const clean = ['hello class', 'Scunthorpe', 'my therapist', 'cocktail', 'assassin', 'Shiitake', 'grapes', 'Sussex',
    'pass the ball', 'annals', 'analysis', 'cumulative', 'Dickens', 'spicy', 'hello!!!', 'level 3 lol', 'c++', 'I a m', 'gg wp',
    'Mississippi', 'shell', 'title', 'document', 'peacock', 'raccoon', 'Hancock', 'sextant', 'butterfly', 'pussycat'];
  for (const t of masked) ok(filterChat(t).includes('♥♥♥'), `masks "${t}" -> "${filterChat(t)}"`);
  for (const t of clean) ok(filterChat(t) === t, `keeps "${t}"`);
  ok(filterChat('go to www.evil.com now') === 'go to [link] now', 'strips www link');
  ok(filterChat('see https://x.y/z?a=1 ok') === 'see [link] ok', 'strips http link');
  ok(filterChat('discord.gg/abc') === '[link]', 'strips bare domain');
  ok(filterChat('3.5 is fine') === '3.5 is fine', 'keeps numbers with dots');
  ok(filterName('Mittens').name === 'Mittens' && !filterName('Mittens').changed, 'nice name kept');
  for (const n of ['Sh_it', 'xXfuckerXx', 'N1gga', 'Hitler']) {
    const f = filterName(n);
    ok(f.changed && PLAYER_NAMES.includes(f.name), `name "${n}" -> ${f.name}`);
  }
  {
    const long = 'the quick brown fox jumps over the lazy dog '.repeat(3).slice(0, 120);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) filterChat(long);
    const us = ((performance.now() - t0) / 2000) * 1000;
    ok(us < 500, `filter is fast (${us.toFixed(0)} µs per 120-char message)`);
  }
}

// ======== maze generator self-test: levels 1-2, every seed, mixed + ice (determinism, paths, spawns, wolves, pattern gaps)
{
  const r = mazeSelfTest(2);
  ok(r.ok, 'maze self-test (2 levels)' + (r.ok ? '' : ':\n  ' + r.problems.join('\n  ')));
}

console.log(process.exitCode ? 'FAIL sim-test' : 'PASS sim-test');
