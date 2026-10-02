// Store screenshots from real gameplay (headless chromium, phone/touch mode), with caption banners.
//   PLAYWRIGHT_DIR=/tmp/rkr-render node scripts/render-screens.mjs [sceneName ...]
// Scenes are staged through the game's debug handle (window.__kitty / window.__bot): kitties follow the level path,
// the lobby shot uses real WebSocket clients joining a room on the local server. Writes straight into the fastlane
// layouts (fastlane/screenshots/en-US for iOS deliver, fastlane/metadata/android/en-US/images/* for Play).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { ROOT, BASE, loadPlaywright, ensureServer, launch } from './render-lib.mjs';

const WebSocket = createRequire(path.join(ROOT, 'package.json'))('ws');

// [dir, width, height]; screens render at devicePixelRatio 1.5 (the game's phone cap) so the 3D view is native-res
const DEVICES = [
  ['iphone-6.9', 2868, 1320],
  ['ipad-13', 2752, 2064],
  ['android-phone', 2400, 1080],
  ['android-7in', 1920, 1200],
  ['android-10in', 2560, 1600],
];
const DPR = 1.5;

const SCENES = [
  { name: 'wolves', title: 'Outrun the wolves', sub: 'One touch and you’re down', stage: stageWolves },
  { name: 'crossplay', title: 'Play with friends', sub: 'Cross-play with friends on any phone or the web', stage: stageLobby },
  { name: 'eight-kitties', title: 'Up to 8 kitties online', sub: 'Run the spiral together', stage: stageEight },
  { name: 'ice', title: 'Skate the ice levels', sub: 'Slide, carve and dodge', stage: stageIce },
  { name: 'revive', title: 'Never leave a kitty behind', sub: 'Run over a friend’s circle to revive them', stage: stageRevive },
  { name: 'goal', title: 'Reach the goal together', sub: 'Wind your way to the heart of the spiral', stage: stageGoal },
];

// ---------------------------------------------------------------- page helpers
async function gamePage(ctx, query) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message));
  await page.goto(`${BASE}/?mobile=1${query || ''}`);
  await page.waitForFunction(() => window.__kitty && window.__kitty.sim);
  await page.evaluate(installBot);
  return page;
}

// runs in the page: path-following bot for every local kitty (+ optional per-scene tweaks)
function installBot() {
  window.__shot = { mortal: false, delay: 0.35, victim: 0, rescue: false };
  window.__bot = (sim) => {
    const S = window.__shot, out = {}, path = sim.levelData.path;
    sim.players.forEach((p, i) => {
      if (p.id === S.victim) { out[p.id] = { x: 0, z: 0 }; return; }
      // tiny invulnerability that expires inside the step: wolves can't catch us, and no blink when rendered
      p.invuln = S.mortal ? 0 : 1 / 60 + 1e-6;
      if (sim.time < i * S.delay) { out[p.id] = { x: 0, z: 0 }; return; }
      const c = S.rescue && sim.circles[0];
      if (c) { const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz) || 1; out[p.id] = { x: dx / d, z: dz / d }; return; }
      p._k = p._k || 0;
      while (p._k < path.length - 1 && Math.hypot(path[p._k].x - p.x, path[p._k].z - p.z) < 1.5) p._k++;
      const dx = path[p._k].x - p.x, dz = path[p._k].z - p.z, d = Math.hypot(dx, dz) || 1;
      out[p.id] = { x: dx / d, z: dz / d };
    });
    return out;
  };
}

const adv = (page, s) => page.evaluate((s) => window.__kitty.advance(s), s);
const state = (page) => page.evaluate(() => {
  const sim = window.__kitty.sim;
  const wolf = (p) => Math.min(...sim.enemies.map((e) => Math.hypot(e.x - p.x, e.z - p.z)));
  return {
    t: sim.time, st: sim.state, circles: sim.circles.length,
    players: sim.players.map((p) => ({ id: p.id, x: p.x, z: p.z, alive: p.alive, inCenter: p.inCenter, wolf: wolf(p), k: p._k || 0 })),
    near6: sim.players[0] ? sim.enemies.filter((e) => Math.hypot(e.x - sim.players[0].x, e.z - sim.players[0].z) < 6).length : 0,
  };
});

// ---------------------------------------------------------------- scenes
async function stageWolves(ctx) {
  const page = await gamePage(ctx, '&level=1');
  await page.evaluate(() => window.__kitty.startGame(1));
  await adv(page, 4);
  for (let i = 0; i < 150; i++) {
    const s = await state(page);
    const p = s.players[0];
    if (p.alive && p.wolf > 1.3 && p.wolf < 2.4 && s.near6 >= 3) break;
    await adv(page, 0.1);
  }
  return { page, zoom: 0.62 };
}

async function stageEight(ctx) {
  const page = await gamePage(ctx, '&level=1');
  await page.evaluate(() => { window.__shot.delay = 0.22; window.__kitty.startGame(8); });
  await adv(page, 5.5);
  return { page, zoom: 0.8 };
}

async function stageIce(ctx) {
  const page = await gamePage(ctx, '&level=2');
  await page.evaluate(() => { window.__shot.delay = 0.5; window.__kitty.startGame(3); });
  await adv(page, 7);
  return { page, zoom: 0.72 };
}

async function stageRevive(ctx) {
  const page = await gamePage(ctx, '&level=1');
  await page.evaluate(() => { window.__shot.delay = 0.6; window.__kitty.startGame(4); });
  await adv(page, 6);
  // the last kitty bumps into the nearest wolf for real (the sim handles the catch + revive circle)
  await page.evaluate(() => {
    const sim = window.__kitty.sim, v = sim.players[3];
    let best = null, bd = Infinity;
    for (const e of sim.enemies) { const d = Math.hypot(e.x - v.x, e.z - v.z); if (d < bd) { bd = d; best = e; } }
    window.__shot.victim = v.id; v.lives = 0; v.invuln = 0; v.shield = 0; v.x = best.x; v.z = best.z;
  });
  await adv(page, 0.2);
  await page.evaluate(() => { window.__shot.rescue = true; });
  for (let i = 0; i < 80; i++) {
    const s = await state(page);
    const c = await page.evaluate(() => window.__kitty.sim.circles[0]);
    if (!c) break;
    const near = Math.min(...s.players.filter((p) => p.alive).map((p) => Math.hypot(p.x - c.x, p.z - c.z)));
    if (near < 2.2) break;
    await adv(page, 0.1);
  }
  return { page, zoom: 0.7 };
}

async function stageGoal(ctx) {
  const page = await gamePage(ctx, '&level=1');
  await page.evaluate(() => { window.__shot.delay = 0; window.__kitty.startGame(4); });
  await adv(page, 1);
  // skip the long run: drop the team onto the last stretch of the path, then let them run into the goal room
  await page.evaluate(() => {
    const sim = window.__kitty.sim, path = sim.levelData.path;
    sim.players.forEach((p, i) => { const k = Math.max(0, path.length - 14 - i * 2); p.x = path[k].x; p.z = path[k].z; p._k = k; });
  });
  for (let i = 0; i < 120; i++) {
    const s = await state(page);
    if (s.players.filter((p) => p.inCenter).length >= 2) break;
    await adv(page, 0.25);
  }
  await adv(page, 0.6);
  return { page, zoom: 0.85 };
}

async function stageLobby(ctx) {
  // 7 real clients (mixed platforms) + this page join one lobby on the local server
  const bots = [];
  const NAMES = [['Mochi', 'ios'], ['Biscuit', 'android'], ['Luna', 'web'], ['Pumpkin', 'ios'], ['Noodle', 'android'], ['Ziggy', 'web'], ['Waffles', 'ios']];
  const wsUrl = BASE.replace(/^http/, 'ws') + '/ws';
  let code = null;
  for (const [name, app] of NAMES) {
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ t: 'hi', v: 1, app, ver: '1.0.0' }));
    const got = new Promise((r) => ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'room') r(m.code); }));
    ws.send(JSON.stringify(code ? { t: 'join', code, name } : { t: 'create', name, mode: 'mixed' }));
    code = await got;
    bots.push(ws);
  }
  await ctx.addInitScript((name) => { try { localStorage.setItem('rkr-name', name); localStorage.setItem('rkr-terms-v1', '1'); } catch {} }, 'Mittens');
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message));
  await page.goto(`${BASE}/?mobile=1&room=${code}`);
  await page.waitForFunction(() => document.querySelectorAll('.rkl-slot:not(.rkl-open)').length >= 8, null, { timeout: 15000 });
  return { page, zoom: 0, ui: true, cleanup: () => bots.forEach((ws) => ws.close()) };
}

// ---------------------------------------------------------------- capture
// ---------------------------------------------------------------- capture
// The game renders into the area BELOW a caption band (never under it), then both are composed into the store image.
const BAND = 0.22; // caption band, fraction of the image height
const HIDE_CSS = '.rkf-btn,.rkl-link{display:none!important;}';

const brightness = (file) => Number(execFileSync('magick', [file, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']).toString());

async function captureGame(page, shot, W, H, file) {
  await page.setViewportSize({ width: Math.round(W / DPR), height: Math.round(H / DPR) });
  await page.waitForTimeout(400); // resize handler
  await page.evaluate((css) => {
    if (document.getElementById('shot-css')) return;
    const st = document.createElement('style'); st.id = 'shot-css'; st.textContent = css; document.head.appendChild(st);
  }, HIDE_CSS);
  // retry until the 3D view has really drawn (a cold WebGL context can hand back a blank first frame)
  for (let attempt = 1; ; attempt++) {
    if (!shot.ui) {
      await page.evaluate((zoom) => {
        const K = window.__kitty;
        // last tick without the bot's tiny invulnerability, so no kitty is caught mid-blink (invisible)
        window.__shot.mortal = true; K.advance(1 / 60); window.__shot.mortal = false;
        // re-render with the camera pulled in a bit (store framing)
        const cam = K.camera, f = cam.getWorldDirection(cam.position.clone());
        const dist = -cam.position.y / f.y; // ray to the ground plane
        const target = cam.position.clone().addScaledVector(f, dist);
        cam.position.copy(target).addScaledVector(f, -dist * zoom);
        K.renderer.render(K.scene, cam);
      }, shot.zoom);
    } else {
      await page.evaluate(() => window.__kitty.advance(0.5)); // title backdrop behind the lobby
    }
    await page.waitForTimeout(150 * attempt);
    await page.screenshot({ path: file });
    const b = brightness(file);
    if (b > 0.15) return;
    if (attempt >= 6) throw new Error(`scene still dark (mean ${b.toFixed(3)}) after ${attempt} tries: ${file}`);
    console.log(`  dark frame (mean ${b.toFixed(3)}), re-rendering`);
  }
}

async function compose(cpage, scene, W, H, gameFile, outFile) {
  const cw = Math.round(W / DPR), ch = Math.round(H / DPR);
  const band = Math.round(ch * BAND);
  const fs_ = Math.round(Math.min(band * 0.44, cw * 0.065));
  await cpage.setViewportSize({ width: cw, height: ch });
  const img = 'data:image/png;base64,' + fs.readFileSync(gameFile).toString('base64');
  await cpage.setContent(`<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@800&display=block">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0d1020;}
.band{position:absolute;left:0;right:0;top:0;height:${band}px;display:flex;flex-direction:column;align-items:center;justify-content:center;
  background:radial-gradient(ellipse 60% 140% at 50% 0%,#5a2aa8 0%,#341478 45%,#1b0b44 100%);font-family:'Baloo 2','Trebuchet MS',sans-serif;text-align:center;
  --fs:${fs_}px;--o:calc(var(--fs) * .055);}
h1{margin:0;font-weight:800;font-size:var(--fs);line-height:1;color:#ffcf5a;
  text-shadow:var(--o) 0 0 #3a1650,calc(-1*var(--o)) 0 0 #3a1650,0 var(--o) 0 #3a1650,0 calc(-1*var(--o)) 0 #3a1650,
  var(--o) var(--o) 0 #3a1650,calc(-1*var(--o)) var(--o) 0 #3a1650,var(--o) calc(-1*var(--o)) 0 #3a1650,calc(-1*var(--o)) calc(-1*var(--o)) 0 #3a1650,
  0 calc(var(--o) * 2.2) 0 #3a1650,0 0 calc(var(--fs)*.6) rgba(255,180,60,.35);}
p{margin:calc(var(--fs) * .08) 0 0;font-weight:800;font-size:calc(var(--fs) * .4);color:#fff6e6;text-shadow:0 2px 0 rgba(0,0,0,.45);}
.game{position:absolute;left:0;top:${band}px;width:${cw}px;height:${ch - band}px;display:block;}
.edge{position:absolute;left:0;right:0;top:${band}px;height:${Math.round(band * 0.12)}px;background:linear-gradient(180deg,rgba(27,11,68,.85),rgba(27,11,68,0));}
.gold{position:absolute;left:0;right:0;top:${band - 2}px;height:3px;background:linear-gradient(90deg,rgba(255,207,90,0),#ffcf5a 30%,#ffcf5a 70%,rgba(255,207,90,0));}
</style></head><body>
<img class="game" src="${img}"><div class="edge"></div>
<div class="band"><h1></h1><p></p></div><div class="gold"></div></body></html>`);
  await cpage.evaluate(({ t, s }) => { document.querySelector('h1').textContent = t; document.querySelector('p').textContent = s; }, { t: scene.title, s: scene.sub });
  await cpage.evaluate(() => document.fonts.ready);
  await cpage.screenshot({ path: outFile });
  // exact store size (viewport rounding can add a pixel) and no alpha channel
  execFileSync('magick', [outFile, '-crop', `${W}x${H}+0+0`, '+repage', '-background', '#0d1020', '-alpha', 'remove', '-alpha', 'off', '-strip', outFile]);
}

// ---------------------------------------------------------------- output (fastlane is the single source of truth)
// iOS deliver detects the device class from the image size; Play supply uses the folder names.
const IOS = path.join(ROOT, 'fastlane/screenshots/en-US');
const PLAY = path.join(ROOT, 'fastlane/metadata/android/en-US/images');
const OUT = {
  'iphone-6.9': (n) => path.join(IOS, `iPhone69-${n}.png`),
  'ipad-13': (n) => path.join(IOS, `iPad13-${n}.png`),
  'android-phone': (n) => path.join(PLAY, 'phoneScreenshots', `${n}.png`),
  'android-7in': (n) => path.join(PLAY, 'sevenInchScreenshots', `${n}.png`),
  'android-10in': (n) => path.join(PLAY, 'tenInchScreenshots', `${n}.png`),
};

// ---------------------------------------------------------------- main
const only = process.argv.slice(2);
const pw = await loadPlaywright();
const stop = await ensureServer();
const browser = await launch(pw);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-shots-'));
try {
  const cctx = await browser.newContext({ deviceScaleFactor: DPR });
  const cpage = await cctx.newPage();
  for (const [i, scene] of SCENES.entries()) {
    if (only.length && !only.includes(scene.name)) continue;
    console.log('scene', scene.name);
    const ctx = await browser.newContext({ viewport: { width: 480, height: 220 }, deviceScaleFactor: DPR, hasTouch: true, isMobile: false });
    // drive frames by hand (deterministic, cheap): rAF only ticks when we ask, and no fullscreen requests
    await ctx.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => (window.__rafOn ? raf(cb) : 0);
      Element.prototype.requestFullscreen = undefined;
      Element.prototype.webkitRequestFullscreen = undefined;
    });
    const shot = await scene.stage(ctx);
    const n = `${String(i + 1).padStart(2, '0')}-${scene.name}`;
    for (const [dev, W, H] of DEVICES) {
      const gh = H - Math.round(Math.round(H / DPR) * BAND) * DPR;
      const gameFile = path.join(tmpDir, `${dev}-${n}.png`);
      await captureGame(shot.page, shot, W, gh, gameFile);
      const out = OUT[dev](n);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await compose(cpage, scene, W, H, gameFile, out);
    }
    shot.cleanup?.();
    await ctx.close();
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await browser.close();
  stop();
}
console.log('screenshots written to fastlane/screenshots/en-US and fastlane/metadata/android/en-US/images');
