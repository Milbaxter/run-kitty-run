# Wall safety on running levels: how to tune it

Running levels = Run only and the summer / fall levels of Run + Skate (ice levels and the final run use pattern wolves
and aren't affected).

## The problem (2026-10)

Hugging a wall was by far the safest way through a lane. Measured on the old code: a kitty standing still right against
the wall was touched 1.4-2.4% of the time, one step in 8-10%, in the middle 10-14% (level 8). Two causes:

1. Wolves picked a random walk direction; near a wall half the directions are blocked, so walks mostly went inward and
   crossed the middle. Moving wolves spent 2-3x more time in the middle than near the walls.
2. A wolf's centre stops further from the wall than a kitty's can, so a wolf only reaches a wall-hugging kitty when it's
   in the last half unit by the wall, which random targets almost never picked.

## The fix that shipped: "A + C"

In `public/js/shared/enemies.js`, wolves with `spec.lateral` (every wolf on a running level, set in `placeEnemies` in
`public/js/shared/maze.js`) first pick *where across the lane* to end up, then walk there with their usual walk length:

| Constant | Value | What it does | Turn it... |
|---|---|---|---|
| `wallShare` in `placeEnemies` (maze.js; `WALL_SHARE` is only the default) | 0.4 on level 1 -> 0.6 on level 8 | share of those moves that end right against a wall (so wolves pause by the wall and walk along it) | **up** if walls still feel like the strongest play, down if the walls became the most dangerous spot |
| `WALL_BAND` | 0.05 | how far from the wall (units) such a target may be; 0 = as close as a wolf can get | up spreads the wall wolves over the strip one step in (that strip was the hottest at 0.3) |
| `LATERAL_RANDOM` | 0.4 | share of moves that keep the old random direction (how wolves find the corner crossings and the goal room) | down = flatter across the lane but fewer crossings (0.25 dropped level 1 goal-room visits 7 -> 0) |

The rest of each move (pause length, walk length, speed) is unchanged, so this only moves danger around the lane, it
doesn't add or remove it.

Sweep (Run only, wall / middle % touched): one value doesn't fit every level, so it ramps with the level.

| wall share | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
|---|---|---|---|---|---|---|
| level 1 wall / middle | 0.93 | 1.21 | 1.57 | 1.81 | 2.25 | 2.93 |
| level 8 wall / middle | 0.61 | 0.78 | 1.01 | 1.29 | 1.56 | 1.97 |

With the ramp: level 1 ~8% everywhere, level 8 ~9.3% at the wall vs ~9.2% in the middle.

## Other options if that's not enough

- **B. Wall patrol wolves:** about 1 wolf in 6 per lane only roams a narrow strip along a wall (`rIn`/`rOut` of its
  territory squeezed to ~1 unit next to the wall, both walls). Simple and very readable, but can look scripted.
- **More wolves / shorter pauses** if spreading the danger made levels feel easier overall.

## Measuring it

`node danger.mjs . <level>` (save it anywhere outside the repo): % of time a kitty standing still at 9 points across
the lane (wall ... middle ... wall) is touched by a wolf, over 60 s on 2 seeds in Run only. Aim for a roughly flat row.

```js
import { pathToFileURL } from 'node:url';
const [dir, L] = [process.argv[2], +(process.argv[3] || 4)];
const { createSim, stepSim } = await import(pathToFileURL(dir + '/public/js/shared/sim.js').href);
const { CFG } = await import(pathToFileURL(dir + '/public/js/shared/config.js').href);
const W = CFG.RING_WIDTH, half = (W - CFG.WALL_THICKNESS) / 2, KR = CFG.KITTY_RADIUS, HIT = 0.4 * 0.85 + 0.66 * 0.8;
const NP = 9, rs = Array.from({ length: NP }, (_, k) => -half + KR + (2 * (half - KR)) * k / (NP - 1));
const hits = Array(NP).fill(0);
let probes = 0;
for (const seed of [3, 11]) {
  const s = createSim({ seed, players: [{ id: 1, name: 'a' }], startLevel: L, mode: 'run' });
  stepSim(s, {}, 1 / 60);
  const legs = s.levelData.legs;
  for (let i = 0; i < 60 * 60; i++) {
    stepSim(s, {}, 1 / 60); s.players[0].invuln = 99;
    if (i % 10) continue;
    const byLeg = legs.map(() => []);
    for (const e of s.enemies) legs.forEach((l, li) => {
      const th = (e.x - l.ox) * l.ux + (e.z - l.oz) * l.uz, r = (e.x - l.ox) * l.nx + (e.z - l.oz) * l.nz;
      if (th > -2 && th < l.len + 2 && Math.abs(r) < W / 2 + 1) byLeg[li].push({ r, th });
    });
    legs.forEach((l, li) => {
      for (let th = W / 2 + 1; th < l.len - W / 2 - 1; th += 1) {
        probes++;
        rs.forEach((r, k) => { if (byLeg[li].some((w) => Math.hypot(w.r - r, w.th - th) < HIT)) hits[k]++; });
      }
    });
  }
}
console.log(hits.map((h) => (100 * h / probes).toFixed(2)).join('  '));
```
