// Sim/rules and isolated security tests (the bulk of `npm test`): no server or external requests, ~7s.
// Add new checks here rather than new scripts. Account checks use disposable temporary files and fake Stripe responses.
// Exit code 1 if any check fails.
import { createSim, stepSim } from '../public/js/shared/sim.js';
import { CFG, SKATE_FINAL_LEVEL, FINAL_MODES, PLAYER_NAMES } from '../public/js/shared/config.js';
import { generateLevel, mazeSelfTest, collideCircle, onIce } from '../public/js/shared/maze.js';
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

  // the default mode's running levels ramp up toward the goal (level 2 = autumn, a running level)
  const ld = generateLevel(sim.level, sim.levelData.seed, 'mixed');
  {
    // Run only: tuned wolves (one shared speed; level 1: always 6 s pauses) and original ones, 1/3 original on
    // level 1 up to 3/4 on level 8
    const run = generateLevel(sim.level, sim.levelData.seed, 'run'), run1 = generateLevel(1, sim.levelData.seed, 'run');
    const run8 = generateLevel(8, sim.levelData.seed, 'run');
    const tuned = run.enemies.filter((e) => e.pauseRange);
    // original wolves stay about as many as before (1/3 of the usual 216 on level 1, 3/4 on level 8, + guards);
    // the tuned ones come on top
    const n1 = run1.enemies.filter((e) => !e.pauseRange).length, n8 = run8.enemies.filter((e) => !e.pauseRange).length;
    ok(new Set(tuned.map((e) => e.speed)).size === 1, 'Run only: tuned wolves share one speed');
    ok(n1 >= 66 && n1 <= 86 && n8 >= 150 && n8 <= 185, `Run only: original wolves ${n1} on level 1, ${n8} on level 8`);
    ok(run1.enemies.length - n1 > 216 - 72, `Run only: extra tuned wolves (${run1.enemies.length - n1} on level 1)`);
    ok(run1.enemies.filter((e) => e.pauseRange).every((e) => e.pauseRange[0] === 6 && e.pauseRange[1] === 6), 'Run only level 1: tuned wolves stand still 6 s');
  }
  ok(ld.enemies.length >= 200, `wolves: ${ld.enemies.length}`);
  const half = Math.floor(ld.legs.length / 2);
  const outer = ld.enemies.filter((e) => e.leg < half), inner = ld.enemies.filter((e) => e.leg >= half);
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const len = (from, to) => ld.legs.slice(from, to).reduce((s, l) => s + l.len, 0);
  ok(new Set(ld.enemies.map((e) => e.speed)).size === 1 && ld.enemies.some((e) => e.pauseRange), 'Run + Skate running levels: Run only tuning, every wolf at one speed');
  ok(inner.length / len(half) > outer.length / len(0, half), `inner legs denser (${(outer.length / len(0, half)).toFixed(3)} -> ${(inner.length / len(half)).toFixed(3)} wolves/unit)`);
  const n = ld.legs.length;
  const fin = ld.enemies.filter((e) => e.leg === n - 1);
  ok(fin.length >= 8, `final stretch is crowded (${fin.length} wolves)`);
  {
    // the default mode's winter (ice) levels have exactly Skate only's pattern wolves for that level number
    // (ice-pattern-test.mjs); its other levels keep wanderers
    const winter = [1, 2, 3, 4].find((L) => generateLevel(L, sim.levelData.seed, 'mixed').ice);
    const ice = generateLevel(winter, sim.levelData.seed, 'mixed'), skate = generateLevel(winter, sim.levelData.seed, 'ice');
    ok(ice.ice && ice.enemies.every((e) => e.pattern) && JSON.stringify(ice.enemies) === JSON.stringify(skate.enemies) && ld.enemies.every((e) => !e.pattern),
      `Run + Skate winter level ${winter} has Skate only level ${winter}'s ${skate.enemies.length} pattern wolves; running levels keep wanderers`);
    // skate levels' final stretch: a full room on top of the count (straight chargers), and crossers / diagonals in
    // the goal room
    const fs = skate.enemies.filter((e) => e.finalStretch), lastLeg = skate.legs.length - 1;
    const room = fs.filter((e) => String(e.pattern).startsWith('room-'));
    ok(fs.length >= 8 && fs.every((e) => e.leg === lastLeg) && fs.filter((e) => e.type === 'charger').every((e) => e.route.length === 2)
      && room.some((e) => e.type === 'crosser') && room.some((e) => e.type === 'diagonal'),
      `Skate only level ${winter}: ${fs.length} wolves on the final stretch, ${room.length} of them in the goal room`);
  }
  ok(ld.safeCorners.length === ld.corners.length - 2 && fin.some((e) => e.a0 < CFG.RING_WIDTH / 2), 'the goal-door corner is not a safe square');
  // Run only level 9: the final run on foot (from the right, wide, wandering wolves) only with runFinale; without it
  // (online rooms with an older client) the old spiral
  {
    const rf = generateLevel(SKATE_FINAL_LEVEL, 7, 'run', true), old = generateLevel(SKATE_FINAL_LEVEL, 7, 'run');
    ok(rf.finale && rf.finaleSide === 1 && !rf.ice && rf.corners[0].x > 0 && rf.corridorWidth > CFG.RING_WIDTH && rf.enemies.length > 1500 && rf.enemies.every((e) => !e.pattern),
      `Run only level 9 final run: from the right, ${rf.corridorWidth.toFixed(1)} wide, ${rf.enemies.length} wandering wolves`);
    ok(!old.finale && old.corridorWidth === CFG.RING_WIDTH, 'Run only level 9 without runFinale is the old spiral');
    const s = createSim({ seed: 7, players: [{ id: 1, name: 'a' }], startLevel: SKATE_FINAL_LEVEL, mode: 'run', finales: 1 });
    const sk1 = createSim({ seed: 7, players: [], startLevel: SKATE_FINAL_LEVEL, mode: 'ice', finales: 1 }).levelData;
    ok(s.levelData.finale && sk1.finaleSide === -1 && sk1.corridorWidth === CFG.RING_WIDTH, 'finale version 1: Run only level 9 final run, the skate final run still narrow');
    const sk2 = createSim({ seed: 7, players: [], startLevel: SKATE_FINAL_LEVEL, mode: 'ice', finales: 2 }).levelData;
    const runWolves = sk2.enemies.filter((e) => e.type === 'wanderer'), skate = sk2.enemies.filter((e) => e.pattern);
    ok(sk2.finale && sk2.ice && sk2.corridorWidth > CFG.RING_WIDTH && skate.length > 1000 && runWolves.length > 100 && sk2.enemies.every((e, i) => e.id === i),
      `finale version 2: wide skate final run, ${skate.length} skate wolves and ${runWolves.length} run wolves at the end`);
    // version 4: skate goal rooms keep only their three wolves on the door's side of the disc (the rest of the level as before)
    {
      const v3 = generateLevel(4, 21, 'ice', 3), v4 = generateLevel(4, 21, 'ice', 4), dc = v4.corners.at(-1);
      const room = (ld) => ld.enemies.filter((e) => /^room-/.test(e.pattern));
      // ...and no last-lane crosser / diagonal turning round in the open (the junction); every other wolf as before
      const key = (e) => JSON.stringify({ ...e, id: 0, seed: 0 }), was = new Set(v3.enemies.map(key));
      const at = (e, q) => ({ x: e.frame.ox + e.frame.ux * q.th + e.frame.nx * q.r, z: e.frame.oz + e.frame.uz * q.th + e.frame.nz * q.r });
      const inOpen = v4.enemies.filter((e) => e.leg === v4.legs.length - 1 && (e.type === 'crosser' || e.type === 'diagonal') && !/^room-/.test(e.pattern)
        && [e.route[0], e.route.at(-1)].some((q) => { const p = at(e, q); return !(Math.abs(p.x) < 9 && Math.abs(p.z) < 9) && !collideCircle(v4, p.x, p.z, CFG.WOLF_RADIUS + 0.6).hit; }));
      const early = (e) => e.leg < v4.legs.length - 2;   // (the last two lanes are picked for their risk in version 4: new designs)
      ok(room(v3).length === 6 && room(v4).length === 3 && inOpen.length === 0 && v4.enemies.filter(early).filter((e) => !was.has(key(e))).length <= 3   // (the level's count trim may take a different row end)
        && room(v4).every((e) => e.route.every((q) => at(e, q).x * dc.x + at(e, q).z * dc.z > 0)),
        `finale version 4: skate goal rooms without the three wolves behind the disc, no last-lane wolf turning round in the open (${v3.enemies.length} -> ${v4.enemies.length} wolves)`);
      // version 5: the lane before's neither (those ending at a wall stay); checked on a few levels
      // ...and level + 1 white wolves in the doorway, from the outer wall to the victory circle's edge (never inside it)
      let open5 = 0, wall5 = 0, door5 = true, doors5 = 0;
      for (const [L, s] of [[3, 1], [4, 21], [6, 2], [8, 5]]) {
        const v5 = generateLevel(L, s, 'ice', 5), d = v5.legs.length - 1;
        const dw = v5.enemies.filter((e) => e.pattern === 'door-crosser');
        doors5 += dw.length;
        door5 &&= v5.enemies.every((e) => e.route.every((q) => Number.isFinite(q.r) && Number.isFinite(q.th)));
        const jw = v5.enemies.filter((e) => e.pattern === 'junction-crosser');   // (the junction square's slanted crossers: wall to wall)
        door5 &&= jw.length === 1 + Math.ceil(L / 2) && jw.every((e) => e.route.every((q) => collideCircle(v5, at(e, q).x, at(e, q).z, CFG.WOLF_RADIUS + 0.3).hit));   // (rows through the door beside the disc: their end came out NaN)
        door5 &&= dw.length <= L + 1 && dw.every((e) => [e.route[0], e.route[1]].sort((p, q) => p.r - q.r).every((q, j) => (j ? Math.hypot(at(e, q).x, at(e, q).z) >= v5.centerRadius + CFG.WOLF_RADIUS : collideCircle(v5, at(e, q).x, at(e, q).z, CFG.WOLF_RADIUS + 0.3).hit)));
        for (const e of v5.enemies) if ((e.leg === d || e.leg === d - 1) && (e.type === 'crosser' || e.type === 'diagonal') && !/^room-/.test(e.pattern)) {
          // (turning round with a wall ahead: one it only runs alongside doesn't count)
          const [A, B] = [e.route[0], e.route.at(-1)].map((q) => at(e, q)), k = CFG.WOLF_RADIUS + 0.6;
          const ahead = (p, o) => (Math.abs(p.x) < 9 && Math.abs(p.z) < 9) || collideCircle(v5, p.x + (p.x - o.x) / Math.hypot(p.x - o.x, p.z - o.z) * k, p.z + (p.z - o.z) / Math.hypot(p.x - o.x, p.z - o.z) * k, 0.3).hit;
          if (!ahead(A, B) || !ahead(B, A)) open5++; else if (e.leg === d - 1) wall5++;
        }
      }
      ok(open5 === 0 && wall5 > 0 && door5 && doors5 > 0, `finale version 5: no wolf in the last two skate lanes turning round in the open (${wall5} in the lane before still run wall to wall), doorway wolves (${doors5} new) and junction crossers`);
      // version 6: the last lane's purple wolves (but the goal room's) swapped for black chargers (wall to wall)
      {
        let ok6 = true, ch6 = 0;
        for (const [L, s] of [[2, 1], [5, 4], [8, 5]]) {
          const v6 = generateLevel(L, s, 'ice', 6), jc = v6.enemies.filter((e) => e.pattern === 'junction-charger');
          ch6 += jc.length;
          ok6 &&= !v6.enemies.some((e) => e.leg === v6.legs.length - 1 && (e.pattern === 'junction-crosser' || /^diagonal/.test(e.pattern)))
            && jc.every((e) => e.type === 'charger' && e.route.every((q) => collideCircle(v6, at(e, q).x, at(e, q).z, CFG.WOLF_RADIUS + 0.3).hit));
        }
        ok(ok6 && ch6 >= 3, `finale version 6: no purple wolves in the last lane but the goal room's, ${ch6} more chargers in it`);
      }
      // version 7: every lane (but level 1's lessons and the last two) gets more wolves every level
      {
        const per = [2, 3, 7, 8].map((L) => { const v7 = generateLevel(L, 3, 'ice', 7); return v7.legs.map((_, i) => v7.enemies.filter((e) => e.leg === i).length); });
        const lanes = [...Array(13).keys()];
        ok(lanes.every((i) => per.every((c, j) => !j || c[i] > per[j - 1][i])), `finale version 7: every lane busier every level (lane ${lanes[0]}: ${per.map((c) => c[lanes[0]]).join(' -> ')})`);
      }
      // version 8: running levels' first six lanes reach 37/38/34/35/31/32 wolves on level 8 (the rest as in version 7)
      {
        const lanes = (ld) => ld.legs.map((_, i) => ld.enemies.filter((e) => e.leg === i).length);
        const r7 = lanes(generateLevel(8, 11, 'run', 7)), r8 = lanes(generateLevel(8, 11, 'run', 8)), r1 = lanes(generateLevel(1, 11, 'run', 8));
        ok(r8.slice(0, 6).join() === '37,38,34,35,31,32' && r8.slice(6).join() === r7.slice(6).join() && r1.join() === lanes(generateLevel(1, 11, 'run', 7)).join(),
          `finale version 8: running level 8's long lanes ${r8.slice(0, 6).join('/')} (was ${r7.slice(0, 6).join('/')}), level 1 as before`);
      }
      // version 9: running levels' lanes 7-15 rise 5% a level up to their level 8 count (level 8 as in version 8)
      {
        const lanes = (ld) => ld.legs.map((_, i) => ld.enemies.filter((e) => e.leg === i).length);
        const r = [1, 4, 8].map((L) => lanes(generateLevel(L, 11, 'run', 9)));
        ok(r[0].slice(6).join() === '16,18,16,17,14,15,11,11,10' && r[2].join() === lanes(generateLevel(8, 11, 'run', 8)).join(),
          `finale version 9: running lanes 7-15 ${r.map((c) => c.slice(6).join('/')).join(' -> ')} (levels 1, 4, 8)`);
      }
      // version 10: running levels 1-8 rest as long in every lane (version 9 rested less toward the middle); level 9 as before
      {
        const rests = (ld) => [...new Set(ld.enemies.filter((e) => e.type === 'wanderer' && !e.goalRoom).map((e) => e.pauseScale.toFixed(3)))];
        const r9 = rests(generateLevel(5, 11, 'run', 9)), r10 = rests(generateLevel(5, 11, 'run', 10));
        ok(r9.length > 5 && r10.length === 1 && rests(generateLevel(9, 11, 'run', 10)).join() === rests(generateLevel(9, 11, 'run', 9)).join(),
          `finale version 10: running level 5 rests ${r10.join()} in every lane (was ${r9[0]} to ${r9.at(-1)}), level 9 unchanged`);
      }
      // version 11: 8 items a level (autumn: 4 hearts / shields + the tree boots), at most 2 hearts and 3 shields;
      // level 9's tree boots are a big pair; Run + Skate's level 9: 8 per half, 2 hearts each, 3 shields in all
      {
        const kinds = (ld) => { const c = { boots: 0, life: 0, shield: 0, tree: 0, mega: 0 }; for (const it of ld.items) { if (it.tree) c.tree++; else c[it.type]++; if (it.mega) c.mega++; } return c; };
        const plain = [[1, 'run'], [4, 'ice'], [7, 'mixed']].map(([L, m]) => kinds(generateLevel(L, 31, m, 11)));
        const fall = kinds(generateLevel(2, 31, 'run', 11)), r9 = kinds(generateLevel(9, 31, 'run', 11)), c9 = kinds(generateLevel(9, 31, 'mixed', 11));
        ok(plain.every((c) => c.boots + c.life + c.shield === 8 && c.life <= 2 && c.shield <= 3 && !c.tree) && fall.boots === 0 && fall.life + fall.shield === 4 && fall.tree > 0
          && r9.mega === 1 && c9.boots + c9.life + c9.shield === 16 && c9.life <= 4 && c9.shield <= 3 && c9.mega === 2 && kinds(generateLevel(1, 31, 'run', 10)).boots + kinds(generateLevel(1, 31, 'run', 10)).life + kinds(generateLevel(1, 31, 'run', 10)).shield === 8,
          `finale version 11: items 8 a level (autumn ${fall.life + fall.shield} + ${fall.tree} tree boots), Run + Skate level 9 ${c9.boots + c9.life + c9.shield} + ${c9.mega} big boots`);
        const sim = createSim({ seed: 31, players: [{ id: 'a', name: 'A' }], startLevel: 9, mode: 'run', finales: 11 }), it = sim.items.find((i) => i.mega), q = sim.players[0];
        q.x = it.x; q.z = it.z; q.invuln = 99; stepSim(sim, {}, CFG.TICK);
        ok(it.taken && q.speedMult === CFG.SPEED_MULT_MAX, `finale version 11: the big boots give full speed at once (x${q.speedMult})`);
      }
      // version 12: Skate only's levels 1-8 go through the seasons from winter, as night levels (the wolves as in 11)
      {
        const lv = [1, 2, 3, 4, 5].map((L) => [generateLevel(L, 13, 'ice', 12), generateLevel(L, 13, 'ice', 11)]);
        ok(lv.map(([a]) => a.theme).join() === '2,4,0,1,2' && lv.every(([a, b]) => a.ice && a.night && JSON.stringify(a.enemies) === JSON.stringify(b.enemies))
          && !generateLevel(9, 13, 'ice', 12).night && !generateLevel(2, 13, 'mixed', 12).night && !generateLevel(2, 13, 'run', 12).night,
          'finale version 12: Skate only levels winter, spring, summer, autumn at night (wolves unchanged; not level 9 or the other modes)');
      }
    }
    // version 3: Run + Skate's level 9 is both in a row (skate, a hallway, the run back to the goal room); Skate only keeps
    // the wide skate final run
    const cb = generateLevel(SKATE_FINAL_LEVEL, 7, 'mixed', 3), ice3 = generateLevel(SKATE_FINAL_LEVEL, 7, 'ice', 3);
    const [a, b] = cb.safeCorners, hall = cb.extraFloors[0];
    const route = [[cb.spawnPoints[0].x, cb.spawnPoints[0].z], [cb.spawnPoints[0].x, a.z], [b.x, a.z], [b.x, 0], [0, 0]];
    let blocked = 0;
    for (let i = 1; i < route.length; i++) for (let k = 0; k <= 400; k++) {
      const x = route[i - 1][0] + (route[i][0] - route[i - 1][0]) * k / 400, z = route[i - 1][1] + (route[i][1] - route[i - 1][1]) * k / 400;
      if (collideCircle(cb, x, z, CFG.KITTY_RADIUS).hit) blocked++;
    }
    ok(cb.combo && a.x < b.x && a.z < hall.z0 && blocked === 0 && onIce(cb, b.x - 100, a.z) && !onIce(cb, b.x - 100, 0) && !onIce(cb, (hall.x0 + hall.x1) / 2, (hall.z0 + hall.z1) / 2)
      && cb.enemies.every((e, i) => e.id === i) && cb.trees.length === 2 && !ice3.combo && ice3.corridorWidth > CFG.RING_WIDTH
      && collideCircle(cb, 0, -cb.roomHalf, CFG.KITTY_RADIUS).hit,   // the goal room keeps its back wall (the fish side)
      `finale version 3: Run + Skate level 9 = skate half, hallway, run half (${cb.enemies.length} wolves, a clear way through, ice only on the skate half)`);
  }
  {
    // no wolf ever steps onto a safe square's tiles (they're W - WALL_THICKNESS wide; wolves may walk right up to
    // their edge); the final stretch's first corner is not marked safe
    for (const mode of ['mixed', 'run', 'ice']) {
    const s2 = createSim({ seed: 11, players: [], mode });
    const half = (s2.levelData.corridorWidth - CFG.WALL_THICKNESS) / 2 - 1e-6;
    let touched = 0;
    for (let t = 0; t < 60 * 60; t++) {
      stepSim(s2, {}, CFG.TICK);
      for (const e of s2.enemies) for (const c of s2.levelData.safeCorners) if (Math.abs(e.x - c.x) < half + e.radius && Math.abs(e.z - c.z) < half + e.radius) touched++;
    }
    const c5 = s2.levelData.corners.at(-2);
    ok(touched === 0 && !s2.levelData.safeCorners.includes(c5), `${mode}: safe tiles are truly wolf-free; final-stretch corners have no tile`);
    }
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

  // Run + Skate level 9: the broken checkpoint (the run half's start room) only works for a kitty with 60+ revives,
  // and then revives the team like any checkpoint (a 'checkpoint' event with medic)
  {
    const s = createSim({ seed: 9, players: [1, 2, 3, 4].map((id) => ({ id, name: 'k' + id })), startLevel: SKATE_FINAL_LEVEL, mode: 'mixed', finales: 3 });
    stepSim(s, {}, CFG.TICK);
    const cp = s.levelData.checkpoints[0], [p1, p2, p3, p4] = s.players;
    const ahead = { x: cp.x - 60, z: 3 }, skating = { x: p4.x + 40, z: p4.z };   // p3 in the run half past it, p4 still skating
    const onCp = () => {
      p1.x = cp.x; p1.z = cp.z; p1.vx = p1.vz = 0;
      Object.assign(p3, ahead, { vx: 0, vz: 0 }); Object.assign(p4, skating, { vx: 0, vz: 0 });
      for (const p of s.players) p.invuln = 99;
      return stepSim(s, {}, CFG.TICK).filter((e) => e.type === 'checkpoint');
    };
    p2.alive = false;
    p1.rescues = 59; const before = onCp();
    p1.rescues = 60; const after = onCp();
    const near = (p, c) => Math.abs(p.x - c.x) < 9 && Math.abs(p.z - c.z) < 9;
    ok(cp && cp.medic && before.length === 0 && after.length === 1 && after[0].medic && after[0].revived.includes(2) && p2.alive,
      'Run + Skate level 9: the broken checkpoint needs 60 revives, then revives the team (medic)');
    ok(Math.abs(p3.x - ahead.x) < 0.5 && !after[0].moved.includes(3) && near(p4, cp) && near(p2, cp) && after[0].moved.includes(4),
      'the broken checkpoint leaves living kitties already past it where they are, gathers the downed and the skaters');
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
  // the goal disc only makes you safe: the first kitty home can wait there for its friends; the level clears when a
  // kitty touches the crown in the middle (it wears it and gets the finish)
  {
    const s = createSim({ seed: 32, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
    stepSim(s, {}, CFG.TICK);
    const [a, b] = s.players;
    a.x = s.levelData.centerRadius - 1; a.z = 0;   // a: just inside the goal's edge, far from the crown
    let ev = [];
    for (let t = 0; t < 60 * 3; t++) { a.invuln = 0; b.invuln = 99; ev.push(...stepSim(s, {}, CFG.TICK)); }
    ok(a.alive && a.inCenter && s.state === 'playing' && !ev.some((e) => e.type === 'levelClear') && !a.crowned,
      'the goal disc is safe but does not clear the level: the first one home can wait for the others');
    {
      // ... and can run back out (to help a friend): out of the disc it's not safe any more
      const r = s.levelData.centerRadius;
      a.x = r - 0.6; a.z = 0; a.vx = 0; a.vz = 0; a.invuln = 99;
      for (let t = 0; t < 60 && a.x < r + 1; t++) stepSim(s, { 1: { x: 1, z: 0 } }, CFG.TICK);
      ok(a.x > r + 0.5 && !a.inCenter, `a kitty can run back out of the goal disc (x ${a.x.toFixed(2)} vs radius ${r})`);
    }
    a.x = s.levelData.crown.x; a.z = s.levelData.crown.z;
    ev = stepSim(s, {}, CFG.TICK);
    ok(ev.some((e) => e.type === 'levelClear' && e.by === 1) && ev.some((e) => e.type === 'crown' && e.playerId === 1) && a.crowned && s.lastWinner === 1 && a.finishes === 1,
      'touching the crown clears the level and crowns that kitty');
    b.x = s.levelData.crown.x; b.z = s.levelData.crown.z; // a teammate darts to the middle during the celebration
    ev = stepSim(s, {}, CFG.TICK);
    ok(!ev.some((e) => e.type === 'crown') && !b.crowned && b.finishes === 0, 'the crown is gone once the winner has it');
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
  // sound on (input m): 1% faster (CFG.MUSIC_BOOST)
  {
    const run = (m) => { const s = createSim({ seed: 5, players: [{ id: 'a', name: 'A' }], startLevel: 1, mode: 'run' }); stepSim(s, {}, CFG.TICK); const p = s.players[0]; p.invuln = 99; for (let i = 0; i < 30; i++) stepSim(s, { a: { x: 0, z: -1, m } }, CFG.TICK); return Math.hypot(p.vx, p.vz); };
    const off = run(0), on = run(1);
    ok(Math.abs(on / off - CFG.MUSIC_BOOST) < 1e-6, `input m: kitty speed x${(on / off).toFixed(3)}`);
  }
  // level rules: sound on runs 2% faster on level 3 (CFG.MUSIC_BOOST_LEVEL), a heart is a pair of boots too on level 4,
  // revives score double on level 5 (p.bonus)
  {
    const sp = (L) => { const s = createSim({ seed: 5, players: [{ id: 'a', name: 'A' }], startLevel: L, mode: 'run' }); stepSim(s, {}, CFG.TICK); const p = s.players[0]; p.invuln = 99; const v = []; for (const m of [0, 1]) { p.vx = p.vz = 0; for (let i = 0; i < 30; i++) stepSim(s, { a: { x: 1, z: 0, m } }, CFG.TICK); v.push(Math.hypot(p.vx, p.vz)); p.x = s.levelData.spawnPoints[0].x; p.z = s.levelData.spawnPoints[0].z; } return v[1] / v[0]; };
    const heart = (L, full) => { const s = createSim({ seed: 5, players: [{ id: 'a', name: 'A' }], startLevel: L, mode: 'run' }); stepSim(s, {}, CFG.TICK); const p = s.players[0], it = s.items.find((i) => i.type === 'life') || s.items[0]; it.type = 'life'; p.lives = full ? CFG.MAX_EXTRA_LIVES : 0; p.x = it.x; p.z = it.z; p.invuln = 99; stepSim(s, {}, CFG.TICK); return [it.taken, p.speedMult]; };
    const [h3, h4, h4full] = [heart(3), heart(4), heart(4, true)];
    ok(Math.abs(sp(3) - 1.02) < 1e-6 && Math.abs(sp(2) - 1.01) < 1e-6 && h3[0] && h3[1] === 1 && h4[0] && h4[1] > 1 && !h4full[0], `level rules: sound-on speed x${sp(3).toFixed(3)} on level 3, a heart on level 4 is boots too (x${h4[1]})`);
    const rev = (L) => { const s = createSim({ seed: 5, players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], startLevel: L, mode: 'run' }); stepSim(s, {}, CFG.TICK); const [a, b] = s.players; b.alive = false; s.circles.push({ playerId: "b", x: a.x, z: a.z, t: CFG.REVIVE_DELAY }); a.invuln = 99; for (let i = 0; i < 10; i++) stepSim(s, {}, CFG.TICK); return [a.rescues, a.bonus]; };
    const [r4, r5] = [rev(4), rev(5)];
    ok(r4[0] === 1 && !r4[1] && r5[0] === 1 && r5[1] === 1, `level rules: a revive on level 5 scores double (rescues ${r5[0]} + bonus ${r5[1]})`);
  }
  const r = mazeSelfTest(2);
  ok(r.ok, 'maze self-test (2 levels)' + (r.ok ? '' : ':\n  ' + r.problems.join('\n  ')));
}

// ======== Run + Skate by day then by night (level version 13): by day Run only's level, by night Skate only's; the
// day goal is a checkpoint (everyone revives on the night rink), only the night goal clears the level
{
  const sim = createSim({ seed: 21, players: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }], mode: 'mixed', finales: 13 });
  stepSim(sim, {}, CFG.TICK);
  const day = sim.levelData, [a, b] = sim.players;
  ok(sim.level === 1 && day.level === 1 && !day.ice && !day.night, 'Run + Skate (v13): level 1 starts by day, on foot');
  ok(JSON.stringify(day.enemies) === JSON.stringify(generateLevel(1, day.seed, 'run', 11).enemies), "Run + Skate (v13): by day it's Run only's level");
  b.alive = false; b.deaths = 1; sim.circles.push({ playerId: 2, x: b.x, z: b.z, t: 0 });
  a.x = 0; a.z = 0;
  let ev = stepSim(sim, {}, CFG.TICK);
  ok(ev.some((e) => e.type === 'stageClear' && e.level === 1) && !ev.some((e) => e.type === 'levelClear') && a.finishes === 1 && sim.stats.levelsCleared === 0, 'Run + Skate (v13): the day goal is a checkpoint, not a cleared level (its crown still counts as a win)');
  for (let t = 0; t < 60 * 4 && sim.level === 1; t++) stepSim(sim, {}, CFG.TICK);
  const night = sim.levelData;
  ok(sim.level === 2 && night.level === 1 && night.ice && night.night, 'Run + Skate (v13): then level 1 by night, on the ice');
  ok(sim.players.every((p) => p.alive) && sim.circles.length === 0, 'Run + Skate (v13): everyone revives for the night half');
  ok(JSON.stringify(night.enemies) === JSON.stringify(generateLevel(1, night.seed, 'ice', 12).enemies), "Run + Skate (v13): by night it's Skate only's level");
  a.x = 0; a.z = 0; a.invuln = 99;
  ev = stepSim(sim, {}, CFG.TICK);
  ok(ev.some((e) => e.type === 'levelClear' && e.level === 1) && a.finishes === 2 && sim.stats.levelsCleared === 1, 'Run + Skate (v13): the night goal clears level 1');
  for (let t = 0; t < 60 * 4 && sim.level === 2; t++) stepSim(sim, {}, CFG.TICK);
  ok(sim.level === 3 && sim.levelData.level === 2 && !sim.levelData.ice, 'Run + Skate (v13): then level 2 by day');
  const fin = generateLevel(17, 5, 'mixed', 13);
  ok(fin.finale && fin.level === SKATE_FINAL_LEVEL && fin.checkpoints.some((c) => c.medic), 'Run + Skate (v13): step 17 is the unchanged level 9 final run');
  ok(!generateLevel(2, 5, 'mixed', 12).night && generateLevel(2, 5, 'mixed', 12).level === 2, 'Run + Skate before v13: one level per level, as before');
}

// ======== browser trust boundaries (mock browser/socket; never connects to a server)
{
  const keys = ['window', 'location', 'WebSocket', 'sessionStorage'];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  try {
    globalThis.window = {};
    globalThis.location = new URL('https://runkittyrun.fun/?server=wss://untrusted.invalid/ws&room=ABCD');
    globalThis.sessionStorage = { getItem: () => 'regression-tab-token', setItem() {} };
    const prod = await import('../public/js/platform.js');
    ok(prod.wsUrl() === 'wss://runkittyrun.fun/ws'
      && prod.accountApiUrl('/api/account/me') === 'https://runkittyrun.fun/api/account/me',
    'production invite cannot change the game or account server');
    ok(!prod.accountSocketTrusted('wss://untrusted.invalid/ws')
      && !prod.accountSocketTrusted('wss://runkittyrun.fun/other')
      && prod.accountSocketTrusted('wss://runkittyrun.fun/ws'), 'account credentials require the trusted socket endpoint');

    let socket, socketOverride;
    globalThis.WebSocket = class {
      constructor(url) { this.url = socketOverride || url; this.readyState = 0; this.sent = []; socket = this; }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.readyState = 3; }
    };
    const { createNet } = await import('../public/js/net.js');
    for (const trusted of [true, false]) {
      socketOverride = trusted ? null : 'wss://untrusted.invalid/ws';
      const net = createNet(); net.acct = () => 'dummy-session-token';
      try {
        net.connect();
        net.send({ t: 'acct', acct: 'dummy-session-token' }); // queued while connecting
        socket.readyState = 1; socket.onopen();
        net.send({ t: 'acct', acct: 'dummy-session-token' }); // later sign-in update
        ok(socket.sent.length === 3 && socket.sent.every((m) => trusted ? m.acct === 'dummy-session-token' : !m.acct),
          `account handshake and queued/live updates ${trusted ? 'reach only the trusted server' : 'omit credentials for custom servers'}`);
      } finally { net.disconnect(); }
    }
    globalThis.location = new URL('http://localhost:8091/?server=ws://localhost:8092/ws');
    const dev = await import('../public/js/platform.js?local-development-test');
    ok(dev.wsUrl() === 'ws://localhost:8092/ws'
      && dev.accountApiUrl('/api/account/me') === 'http://localhost:8091/api/account/me'
      && !dev.accountSocketTrusted(dev.wsUrl()), 'local custom servers work without receiving account credentials');
    globalThis.location = new URL('https://runkittyrun.fun/?server=javascript:alert(1)');
    const invalid = await import('../public/js/platform.js?invalid-server-test');
    ok(invalid.wsUrl() === 'wss://runkittyrun.fun/ws', 'invalid server URLs cannot override production');
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

// ======== account durability + webhook bytes (temporary files and fake Stripe; no external requests)
{
  const fs = (await import('node:fs')).default;
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { EventEmitter } = await import('node:events');
  const { createAccounts } = await import('../server/accounts.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-accounts-test-'));
  const file = path.join(dir, 'accounts.json'), ledger = path.join(dir, 'payments.jsonl');
  const token = 'dummy-session-token-for-regression', sub = 'test-google-sub';
  const env = { GOOGLE_CLIENT_ID: 'test-client', STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: 'whsec_dummy', NODE_ENV: 'production' };
  const session = { id: 'cs_test_regression', object: 'checkout.session', livemode: false, mode: 'payment',
    client_reference_id: sub, metadata: { app: 'run-kitty-run', sub }, amount_total: 50, currency: 'eur',
    payment_status: 'paid', url: 'https://checkout.stripe.com/test-only' };
  const savedFetch = globalThis.fetch, savedRename = fs.renameSync, savedWrite = fs.writeFileSync, savedError = console.error;
  const errors = [];
  const request = (accounts, name, chunks = [], headers = {}) => new Promise((resolve, reject) => {
    const req = new EventEmitter(); req.method = name === 'me' ? 'GET' : 'POST';
    req.headers = { authorization: 'Bearer ' + token, ...headers }; req.destroy = () => reject(new Error('unexpected oversized request'));
    let status;
    const res = { writeHead(code) { status = code; }, end(body) { resolve({ status, ...JSON.parse(body) }); } };
    if (name === 'webhook') accounts.webhook(req, res); else accounts.handle(req, res, name);
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
  const pay = (accounts) => request(accounts, 'pay', [Buffer.from(JSON.stringify({ cents: 50 }))]);
  try {
    fs.writeFileSync(file, JSON.stringify({ accounts: { [sub]: { sub, email: 'test@example.invalid', name: 'Test', paid: 0,
      sessions: [crypto.createHash('sha256').update(token).digest('hex')], payments: [] },
      // a second account that never pays (signing in is free, the swag account is only active once paid)
      'unpaid-sub': { sub: 'unpaid-sub', email: 'unpaid@example.invalid', name: 'Unpaid', paid: 0,
        sessions: [crypto.createHash('sha256').update('unpaid-session-token-for-regression').digest('hex')], payments: [] } }, checkouts: {} }), { mode: 0o644 });
    fs.writeFileSync(ledger, '', { mode: 0o644 });
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith('https://api.stripe.com/v1/checkout/sessions')) throw new Error('unexpected network call');
      return { ok: true, json: async () => ({ ...session }) };
    };
    console.error = (...args) => errors.push(args.join(' '));
    let accounts = createAccounts(file, env);
    ok((fs.statSync(file).mode & 0o777) === 0o600 && (fs.statSync(ledger).mode & 0o777) === 0o600,
      'existing account and payment files become private');

    fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('simulated storage failure'), { code: 'EIO' }); return savedRename(from, to); };
    const failed = await pay(accounts);
    ok(failed.status >= 400 && !failed.url && !JSON.parse(fs.readFileSync(file)).checkouts[session.id],
      'failed checkout persistence never returns a payable URL');
    fs.renameSync = savedRename;
    const created = await pay(accounts);
    ok(created.ok && created.url === session.url && JSON.parse(fs.readFileSync(file)).checkouts[session.id],
      'checkout binding is on disk before returning its URL');

    accounts = createAccounts(file, env); // simulate a restart before the player completes payment
    const raw = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { object: { ...session, customer_details: { name: 'Mäxi 🐈' } } } }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(timestamp + '.').update(raw).digest('hex');
    const headers = { 'stripe-signature': `t=${timestamp},v1=${signature}` };
    const split = raw.indexOf(Buffer.from('ä')) + 1;
    const credited = await request(accounts, 'webhook', [raw.subarray(0, split), raw.subarray(split)], headers);
    const duplicate = await request(accounts, 'webhook', [raw], headers);
    const bad = await request(accounts, 'webhook', [raw], { 'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}` });
    ok(credited.status === 200 && duplicate.status === 200 && accounts.paidFor(token) === 50
      && fs.readFileSync(ledger, 'utf8').trim().split('\n').length === 1 && bad.status === 400,
    'split Unicode webhook verifies exact bytes; duplicates credit once and bad signatures fail');
    for (const restart of [false, true]) {
      session.id = restart ? 'cs_test_snapshot_restart' : 'cs_test_snapshot_retry';
      await pay(accounts);
      const event = Buffer.from(JSON.stringify({ type: 'checkout.session.async_payment_succeeded', data: { object: session } }));
      const digest = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(timestamp + '.').update(event).digest('hex');
      const signed = { 'stripe-signature': `t=${timestamp},v1=${digest}` };
      fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('simulated snapshot failure'), { code: 'EIO' }); return savedRename(from, to); };
      const failedCredit = await request(accounts, 'webhook', [event], signed);
      fs.renameSync = savedRename;
      if (restart) accounts = createAccounts(file, env);
      const retry = await request(accounts, 'webhook', [event], signed);
      ok(failedCredit.status === 500 && retry.status === 200 && accounts.paidFor(token) === (restart ? 150 : 100)
        && fs.readFileSync(ledger, 'utf8').trim().split('\n').length === (restart ? 3 : 2),
      `failed credit snapshot recovers exactly once on ${restart ? 'restart and webhook retry' : 'webhook retry'}`);
    }
    session.id = 'cs_test_partial_ledger';
    await pay(accounts);
    const partialEvent = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { object: session } }));
    const partialDigest = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(timestamp + '.').update(partialEvent).digest('hex');
    const partialHeaders = { 'stripe-signature': `t=${timestamp},v1=${partialDigest}` };
    fs.writeFileSync = (fd, data, ...options) => {
      if (typeof fd === 'number' && String(data).includes('"session":"cs_test_partial_ledger"')) {
        savedWrite(fd, String(data).slice(0, 23));
        throw Object.assign(new Error('simulated partial ledger write'), { code: 'ENOSPC' });
      }
      return savedWrite(fd, data, ...options);
    };
    const partialFailure = await request(accounts, 'webhook', [partialEvent], partialHeaders);
    fs.writeFileSync = savedWrite;
    fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('simulated snapshot failure'), { code: 'EIO' }); return savedRename(from, to); };
    const snapshotFailure = await request(accounts, 'webhook', [partialEvent], partialHeaders);
    fs.renameSync = savedRename;
    accounts = createAccounts(file, env);
    const partialRetry = await request(accounts, 'webhook', [partialEvent], partialHeaders);
    ok(partialFailure.status === 500 && snapshotFailure.status === 500 && partialRetry.status === 200 && accounts.paidFor(token) === 200,
      'partial ledger append cannot swallow the retried payment during restart recovery');
    // "shown online" switch: off = the game server gets 0 for this player, saved on disk (survives a restart)
    const total = accounts.paidFor(token);
    const hide = await request(accounts, 'show', [Buffer.from(JSON.stringify({ show: false }))]);
    const hiddenAfterRestart = createAccounts(file, env).paidFor(token);
    const unhide = await request(accounts, 'show', [Buffer.from(JSON.stringify({ show: true }))]);
    const badShow = await request(accounts, 'show', [Buffer.from(JSON.stringify({ show: 'no' }))]);
    ok(hide.ok && hide.account.show === false && total > 0 && hide.account.paid === total && hiddenAfterRestart === 0
      && unhide.ok && unhide.account.show === true && accounts.paidFor(token) === total && !badShow.ok,
    'shown-online switch hides the total from the game server, is saved, and turns back on');
    // stats: online games counted by the server (by account id), solo / local reported by the browser (capped)
    accounts.recordOnline(sub, { type: 'reached', mode: 'run', level: 9 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 2 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 2 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'nope', level: 2 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'ice', level: 12 });
    accounts.recordOnline(sub, { type: 'crown' });
    accounts.recordOnline(sub, { type: 'revive' });
    accounts.recordOnline('someone-else', { type: 'crown' });
    const local = await request(accounts, 'progress', [Buffer.from(JSON.stringify({ mode: 'mixed', reached: 3, clears: [1, 2, 3, 4, 5], crowns: 50, revives: 500 }))]);
    const me = await request(accounts, 'me');
    const on = me.account.stats.online, lo = me.account.stats.local;
    ok(accounts.subFor(token) === sub && on.clears.run[2] === 2 && on.reached.run === 9 && !on.clears.ice[12] && on.crowns === 1 && on.revives === 1
      && local.ok && lo.clears.mixed[1] === 1 && lo.clears.mixed[3] === 1 && !lo.clears.mixed[4] && lo.crowns === 3 && lo.revives === 100
      && lo.reached.mixed === 3 && !lo.clears.run[2],
    'account stats: online counted per mode / level, bad modes and levels ignored, local reports capped and kept apart');
    // fastest clear per mode / level: only a faster time replaces it, times out of range are ignored
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 3, time: 95.04 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 3, time: 120 });
    accounts.recordOnline(sub, { type: 'clear', mode: 'run', level: 4, time: 1 });
    await request(accounts, 'progress', [Buffer.from(JSON.stringify({ mode: 'ice', reached: 2, clears: [2], times: [61.26], crowns: 0, revives: 0 }))]);
    const fast = await request(accounts, 'me');
    ok(fast.account.stats.online.best.run[3] === 95 && !fast.account.stats.online.best.run[4] && fast.account.stats.local.best.ice[2] === 61.3
      && !fast.account.stats.online.best.ice[2],
    'account stats: fastest clear per mode and level (online and local apart), slower and implausible times ignored');
    // permanent unlocks: a feat in every mode unlocks the item (on by default); it can be switched off; locked ones can't
    accounts.recordFeat(sub, 'l8', 'run'); accounts.recordFeat(sub, 'l8', 'ice');
    const before = accounts.cosFor(token);
    accounts.recordFeat(sub, 'l8', 'mixed'); accounts.recordFeat(sub, 'l8', 'nope'); accounts.recordFeat(sub, 'l7', 'run');
    const after = accounts.cosFor(token);
    const lockedOn = await request(accounts, 'equip', [Buffer.from(JSON.stringify({ item: 'rboots', on: true }))]);
    const off = await request(accounts, 'equip', [Buffer.from(JSON.stringify({ item: 'shades', on: false }))]);
    ok(!before.includes('shades') && after.join() === 'shades' && !lockedOn.ok && off.ok && accounts.cosFor(token).length === 0
      && off.account.unlocks.l8.mixed === 1 && off.account.unlocks.off.shades === true,
    'unlocks: an item unlocks once its feat is done in every mode, bad feats / modes are ignored, switched off it is not sent');
    // never paid: signed in, but not active: no stats, no unlock progress, nothing sent to other players
    accounts.recordOnline('unpaid-sub', { type: 'crown' }); for (const m of ['run', 'ice', 'mixed']) accounts.recordFeat('unpaid-sub', 'l8', m);
    const unpaid = await request(accounts, 'me', [], { authorization: 'Bearer unpaid-session-token-for-regression' });
    ok(unpaid.ok && unpaid.account.active === false && unpaid.account.stats.online.crowns === 0 && unpaid.account.unlocks.l8.run === 0
      && accounts.cosFor('unpaid-session-token-for-regression').length === 0 && off.account.active === true,
    'an account that has never paid is not active: nothing is counted or shown');
    // no active account: the progress is kept under the browser's progress id, switched there, and moves onto the
    // account once it is active (counts add up)
    const pid = 'abcdefghijklmnopqrstuvwxyz0123';
    for (const m of ['run', 'ice', 'mixed']) accounts.recordFeat({ sub: 'unpaid-sub', pid }, 'l8', m);
    accounts.recordFeat({ pid: 'too-short' }, 'l8', 'run');
    const guestCos = accounts.cosForPlayer({ sub: 'unpaid-sub', pid });
    const gOff = await request(accounts, 'guestequip', [Buffer.from(JSON.stringify({ pid, item: 'shades', on: false }))]);
    const gRead = await request(accounts, 'guest', [Buffer.from(JSON.stringify({ pid }))]);
    const gBad = await request(accounts, 'guestequip', [Buffer.from(JSON.stringify({ pid, item: 'rboots', on: true }))]);
    const beforeMerge = (await request(accounts, 'me')).account.unlocks.l8.run;
    accounts.mergeGuest(sub, pid);
    const merged = (await request(accounts, 'me')).account.unlocks;
    ok(guestCos.join() === 'shades' && gOff.ok && gRead.unlocks.off.shades === true && !gBad.ok
      && merged.l8.run === beforeMerge + 1 && merged.l8.mixed >= 1 && (await request(accounts, 'guest', [Buffer.from(JSON.stringify({ pid }))])).unlocks === null,
    'unlocks without an account: kept under the progress id, switched there, moved onto the account once it is active');
    accounts.flush();
    ok(createAccounts(file, env).subFor(token) === sub && JSON.parse(fs.readFileSync(file)).accounts[sub].stats.online.clears.run[2] === 2,
      'account stats are saved on flush and survive a restart');
    const deleted = await request(accounts, 'delete');
    await new Promise((resolve) => setTimeout(resolve, 1100)); // any old delayed save must not resurrect this account
    ok(deleted.ok && createAccounts(file, env).paidFor(token) === 0 && !JSON.parse(fs.readFileSync(file)).accounts[sub],
      'deleted account and session stay deleted after saves settle and restart');
    ok(errors.some((e) => e.includes('simulated storage failure')), 'storage failure is logged');
  } finally {
    fs.renameSync = savedRename; fs.writeFileSync = savedWrite; globalThis.fetch = savedFetch; console.error = savedError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ======== legends board: the newest wins of each mode (a busy mode can't push another off the board)
{
  const { createLegends } = await import('../server/legends.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-legends-test-'));
  try {
    const lg = createLegends(path.join(dir, 'legends.json'));
    lg.recordWin('run', 1200, [{ id: 1, name: 'Shadow', color: 1 }]);
    for (let i = 0; i < 105; i++) lg.recordWin('mixed', 1500, [{ id: 10 + i, name: 'Tofu', color: 2 }]);
    const wins = JSON.parse(lg.boardJson()).wins;
    ok(wins.filter((w) => w.mode === 'mixed').length === 100 && wins.some((w) => w.mode === 'run') && wins[0].mode === 'mixed',
      'legends board: the newest 100 of each mode, newest first (an older win of a quieter mode stays on)');
    lg.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(process.exitCode ? 'FAIL sim-test' : 'PASS sim-test');
