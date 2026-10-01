import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CFG, PLAYER_COLORS, PLAYER_NAMES, NET } from './shared/config.js';
import { hashSeed } from './shared/rng.js';
import { collideCircle, onIce } from './shared/maze.js';
import { updateEnemies, nearestEnemyDist, applyEnemyState } from './shared/enemies.js';
import { createSim, stepSim, predictPlayer, loadLevel } from './shared/sim.js';
import { createKittyModel, createWolfModel, createItemModel, createReviveCircleModel, createPortalModel } from './models.js';
import { buildWorld, setupLighting } from './world.js';
import { createEffects } from './effects.js';
import { createIceTrail } from './trail.js';
import { createAudio } from './audio.js';
import { createUI } from './ui.js';
import { createNet } from './net.js';
import { createLobbyUI } from './lobby.js';
import { createChat } from './chat.js';
import { TOUCH, QUALITY, goFullscreenLandscape } from './device.js';

// Integration: renderer, input, camera, presentation of the pure sim.

const params = new URLSearchParams(location.search);
const DEBUG_LEVEL = Math.max(1, parseInt(params.get('level') || '1', 10) || 1);
const DEBUG_GOD = params.has('god');

// ---------- renderer / scene ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: QUALITY.antialias, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(0, 40, 30);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.45, 0.88);
if (QUALITY.bloom) composer.addPass(bloom); // bloom is the most expensive pass: skipped on phones
composer.addPass(new OutputPass());

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
});

const lighting = setupLighting(scene);
const effects = createEffects(scene);
const audio = createAudio();
const ui = createUI(document.getElementById('ui'));

// Soundtrack: a playlist of mp3s next to index.html, played one after the other on repeat.
// Plain <audio> element. A track that fails to load is skipped; if all fail, procedural music plays.
const PLAYLIST = ['music/soundtrack.mp3', 'music/soundtrack2.mp3'];
let trackIdx = 0;
const badTracks = new Set();
const track = new Audio(PLAYLIST[0]);
track.volume = 0.5;
track.preload = 'auto';
let trackWanted = false, trackFailed = false, musicLevel = 1;
function nextTrack() {
  for (let k = 1; k <= PLAYLIST.length; k++) {
    const i = (trackIdx + k) % PLAYLIST.length;
    if (badTracks.has(i)) continue;
    trackIdx = i;
    track.src = PLAYLIST[i];
    if (trackWanted && !audio.isMuted()) track.play().catch(() => {});
    return;
  }
}
track.addEventListener('ended', nextTrack);
track.addEventListener('error', () => {
  badTracks.add(trackIdx);
  if (badTracks.size >= PLAYLIST.length) { trackFailed = true; if (trackWanted) audio.startMusic(musicLevel); return; }
  nextTrack();
});

function musicPlay(level) {
  musicLevel = level;
  trackWanted = true;
  if (trackFailed) { audio.startMusic(level); return; }
  if (!audio.isMuted() && track.paused) track.play().catch(() => { /* needs a user gesture; retried on input */ });
}
function musicStop() {
  trackWanted = false;
  track.pause();
  audio.stopMusic();
}
function syncTrack() {
  if (trackFailed) return;
  if (audio.isMuted() || !trackWanted) track.pause();
  else if (track.paused) track.play().catch(() => {});
}

// Sound starts ON unless the player muted it before (remembered per browser).
let soundPref = 'on';
try { soundPref = localStorage.getItem('rkr-sound') || 'on'; } catch (e) { /* storage unavailable */ }
audio.setMuted(soundPref === 'off');
ui.setMutedIcon(audio.isMuted());
let soundHintShown = false;

function toggleSound() {
  audio.unlock();
  audio.setMuted(!audio.isMuted());
  ui.setMutedIcon(audio.isMuted());
  try { localStorage.setItem('rkr-sound', audio.isMuted() ? 'off' : 'on'); } catch (e) { /* ignore */ }
  if (!audio.isMuted()) audio.play('click');
  syncTrack();
}
ui.onMuteClick(toggleSound);
ui.onMenuClick(() => {
  if (mode !== 'play' || sim.state === 'gameover') return;
  if (online.playing) toggleOnlineMenu(); else togglePause();
});

// ---------- input ----------
const keys = new Set();
// P2 is mouse-driven (see below); arrows remain a fallback for P2.
const KEYMAP = [
  { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'] },
  { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'] },
];
const SOLO_KEYMAP = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] };

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && online.room && !chat.isOpen() && !ui.isOverlayOpen() && !e.target.closest?.('input')) {
    e.preventDefault();
    chat.open();
    return;
  }
  audio.unlock();
  if (e.code !== 'KeyM') syncTrack(); // browsers only start media after a user gesture
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  if (e.repeat) { keys.add(e.code); return; }
  keys.add(e.code);
  if (e.code === 'KeyM') {
    toggleSound();
  } else if ((e.code === 'KeyP' || e.code === 'Escape') && mode === 'play' && sim.state !== 'gameover') {
    if (online.playing) toggleOnlineMenu();
    else togglePause();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); if (mode === 'play' && !online.playing && !paused && sim.state === 'playing') togglePause(); });
window.addEventListener('pointerdown', () => { audio.unlock(); syncTrack(); });

function anyKey(list) { for (const k of list) if (keys.has(k)) return true; return false; }

function readInput(index, playerCount) {
  const map = playerCount === 1 ? SOLO_KEYMAP : KEYMAP[index];
  let x = 0, z = 0;
  if (map) {
    if (anyKey(map.left)) x -= 1;
    if (anyKey(map.right)) x += 1;
    if (anyKey(map.up)) z -= 1;
    if (anyKey(map.down)) z += 1;
  }
  // Gamepads: pad i drives player i (if present).
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads && pads[index];
  if (pad && pad.connected) {
    let gx = pad.axes[0] || 0, gz = pad.axes[1] || 0;
    if (pad.buttons[14]?.pressed) gx = -1;
    if (pad.buttons[15]?.pressed) gx = 1;
    if (pad.buttons[12]?.pressed) gz = -1;
    if (pad.buttons[13]?.pressed) gz = 1;
    if (Math.hypot(gx, gz) > 0.18) { x = gx; z = gz; }
  }
  const m = Math.hypot(x, z);
  if (m > 1) { x /= m; z /= m; }
  return { x, z };
}

// Mouse: drives player 2 in co-op (player 1 in solo). Click = run to that spot, hold = steer toward cursor.
const mouse = { ndc: new THREE.Vector2(), has: false, held: false, target: null, iceDir: null };
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const mouseHit = new THREE.Vector3();

// Touch: the kitty heads for a point a little above the thumb so the finger doesn't cover it.
const TOUCH_LEAD_PX = 55;
let touchId = null, touchDownAt = 0;
function setMouseNdc(e) {
  const y = e.pointerType === 'touch' ? e.clientY - TOUCH_LEAD_PX : e.clientY;
  mouse.ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  mouse.has = true;
}
function mouseGround() {
  raycaster.setFromCamera(mouse.ndc, camera);
  return raycaster.ray.intersectPlane(groundPlane, mouseHit) ? { x: mouseHit.x, z: mouseHit.z } : null;
}
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && e.pointerId !== touchId) return; // only the first finger steers
  setMouseNdc(e);
});
canvas.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (mode !== 'play' || paused || (e.button !== 0 && e.button !== 2)) return;
  if (e.pointerType === 'touch') {
    if (touchId !== null) return;
    touchId = e.pointerId;
    touchDownAt = performance.now();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  setMouseNdc(e);
  mouse.held = true;
  mouse.iceDir = null;
  mouse.target = mouseGround();
  if (mouse.target) targetPulse = 1;
});
function pointerEnd(e) {
  if (e.pointerType === 'touch') {
    if (e.pointerId !== touchId) return;
    touchId = null;
    // hold = follow the thumb, so letting go stops; a quick tap = run to that spot
    if (performance.now() - touchDownAt > 250) mouse.target = null;
  }
  mouse.held = false;
}
window.addEventListener('pointerup', pointerEnd);
window.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function mousePlayerIndex() {
  if (online.playing) return sim.players.findIndex((p) => p.id === online.me);
  return playerCount === 2 ? 1 : 0;
}

function mouseInput(p, kb) {
  if (Math.hypot(kb.x, kb.z) > 0.1 || !p.alive) { mouse.target = null; mouse.iceDir = null; return kb; }
  if (mouse.held && mouse.has) mouse.target = mouseGround() || mouse.target;
  if (!onIce(sim.levelData, p.x, p.z)) mouse.iceDir = null;
  else if (mouse.held || mouse.iceDir) {
    // ice: a click sets a direction to skate in (not a spot to stop at); holding keeps steering at the cursor
    if (mouse.target) {
      const dx = mouse.target.x - p.x, dz = mouse.target.z - p.z, d = Math.hypot(dx, dz);
      if (mouse.held && d > 0.3) mouse.iceDir = { x: dx / d, z: dz / d };
      else if (mouse.iceDir && dx * mouse.iceDir.x + dz * mouse.iceDir.z < 0) mouse.target = null; // slid past the spot
    }
    return mouse.iceDir || kb;
  } else if (mouse.target) {
    const dx = mouse.target.x - p.x, dz = mouse.target.z - p.z, d = Math.hypot(dx, dz);
    if (d > 0.3) { mouse.iceDir = { x: dx / d, z: dz / d }; return mouse.iceDir; }
  }
  if (!mouse.target) return kb;
  const dx = mouse.target.x - p.x, dz = mouse.target.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.15) { if (!mouse.held) mouse.target = null; return { x: 0, z: 0 }; }
  const m = Math.min(1, d / 0.6) / d; // ease in on arrival so the kitty stops cleanly
  return { x: dx * m, z: dz * m };
}

// Ground marker showing where the mouse kitty is headed.
let targetPulse = 0;
const targetMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.32, 0.44, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }),
);
targetMarker.rotation.x = -Math.PI / 2;
targetMarker.visible = false;
scene.add(targetMarker);

function updateTargetMarker(dt) {
  const p = sim && sim.players[mousePlayerIndex()];
  if (mode !== 'play' || !p || !p.alive || !mouse.target) { targetMarker.visible = false; return; }
  targetMarker.visible = true;
  targetMarker.material.color.set(p.color).multiplyScalar(1.8);
  targetPulse = Math.max(0, targetPulse - dt * 3);
  const s = 1 + targetPulse * 0.8 + Math.sin(simTime * 6) * 0.06;
  targetMarker.scale.set(s, s, s);
  targetMarker.position.set(mouse.target.x, 0.04, mouse.target.z);
}

// ---------- game state ----------
let mode = 'title';      // 'title' | 'play'
let paused = false;
let sim = null;
let playerCount = 1;
let simTime = 0;          // presentation clock (seconds)
let accumulator = 0;
let gameOverShown = false;

// Visual bindings
let view = null;          // { levelData, world, portal, wolves: Map, items: Map, circles: Map }
const kitties = new Map(); // playerId -> { model, dustT }
const prevPos = new Map(); // id -> {x,z} for interpolation (players 'p'+id, enemies 'e'+id)

function newSeed() { return hashSeed(Date.now(), Math.random()) >>> 0; }

function startSim(players, startLevel) {
  sim = createSim({ seed: newSeed(), players, startLevel });
  accumulator = 0;
  gameOverShown = false;
  prevPos.clear();
}

function clearView() {
  if (!view) return;
  view.world.dispose();
  scene.remove(view.world.group);
  scene.remove(view.portal.group);
  for (const w of view.wolves.values()) scene.remove(w.group);
  for (const it of view.items.values()) scene.remove(it.group);
  for (const c of view.circles.values()) scene.remove(c.group);
  view = null;
}

function buildView() {
  clearView();
  const ld = sim.levelData;
  const world = buildWorld(scene, ld);
  if (world.group.parent !== scene) scene.add(world.group);
  lighting.setTheme(ld.theme);
  const portal = createPortalModel();
  scene.add(portal.group);
  const wolves = new Map();
  for (const e of sim.enemies) {
    const m = createWolfModel(e.type);
    m.group.scale.setScalar(CFG.WOLF_RADIUS / 0.55); // models are built for the original 0.55 radius
    m.group.position.set(e.x, 0, e.z);
    m.group.rotation.y = -e.heading;
    scene.add(m.group);
    wolves.set(e.id, m);
  }
  const items = new Map();
  for (const it of sim.items) {
    if (it.taken) continue;
    const m = createItemModel(it.type);
    m.group.position.set(it.x, 0, it.z);
    scene.add(m.group);
    items.set(it.id, m);
  }
  view = { levelData: ld, world, portal, wolves, items, circles: new Map() };
  prevPos.clear();
}

function ensureKitties() {
  for (const p of sim.players) {
    if (!kitties.has(p.id)) {
      const model = createKittyModel(p.color);
      // Player-colored ground marker with a heading pip (readability + co-op identity).
      const glow = new THREE.Color(p.color).multiplyScalar(1.6);
      const mat = new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.58, 0.7, 40), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      const pipShape = new THREE.Shape();
      pipShape.moveTo(0.95, 0); pipShape.lineTo(0.76, 0.14); pipShape.lineTo(0.76, -0.14); pipShape.closePath();
      const pip = new THREE.Mesh(new THREE.ShapeGeometry(pipShape), mat);
      pip.rotation.x = -Math.PI / 2;
      pip.position.y = 0.03;
      model.group.add(ring, pip);
      scene.add(model.group);
      kitties.set(p.id, { model, dustT: 0, stepN: 0, trail: createIceTrail(scene) });
    }
  }
  for (const [id, k] of kitties) {
    if (!sim.players.find((p) => p.id === id)) { scene.remove(k.model.group); k.trail.dispose(); kitties.delete(id); }
  }
}

function removeKitties() {
  for (const k of kitties.values()) { scene.remove(k.model.group); k.trail.dispose(); }
  kitties.clear();
}

// ---------- flow ----------
function enterTitle(showTitleScreen = true) {
  mode = 'title';
  paused = false;
  online.playing = false;
  removeKitties();
  startSim([], 1 + Math.floor(Math.random() * 3));
  stepSim(sim, {}, CFG.TICK); // generate level
  buildView();
  if (showTitleScreen) ui.showTitle(({ players }) => (players === 3 ? openOnline() : startGame(players)));
  musicPlay(1);
}

function startGame(n) {
  goFullscreenLandscape();
  audio.unlock();
  audio.play('click');
  playerCount = n;
  ui.hideTitle();
  ui.hideGameOver();
  mode = 'play';
  paused = false;
  const players = [];
  for (let i = 0; i < n; i++) players.push({ id: i + 1, name: PLAYER_NAMES[i], color: PLAYER_COLORS[i] });
  removeKitties();
  startSim(players, DEBUG_LEVEL);
  cameraSnap = true;
  // First step emits levelStart which triggers buildView.
}

function togglePause() {
  paused = !paused;
  if (paused) {
    ui.showPause(() => { paused = false; ui.hidePause(); });
  } else {
    ui.hidePause();
  }
  audio.play('click');
}

function playerById(id) { return sim.players.find((p) => p.id === id); }
function hexCss(c) { return '#' + c.toString(16).padStart(6, '0'); }

function handleEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case 'levelStart': {
        mouse.target = null;
        buildView();
        ensureKitties();
        for (const p of sim.players) effects.teleport(p.x, p.z, p.color);
        ui.banner(`LEVEL ${ev.level}`, levelSubtitle(ev.level), 2200);
        if (audio.isMuted() && !soundHintShown) {
          soundHintShown = true;
          ui.toast('Sound is off. Press M or click the speaker to turn it on', '#b9a4ff');
        }
        audio.play('levelStart');
        musicPlay(ev.level);
        cameraSnap = cameraSnap || ev.level === DEBUG_LEVEL;
        break;
      }
      case 'death': {
        const p = playerById(ev.playerId);
        effects.deathPoof(ev.x, ev.z, p ? p.color : 0xffffff);
        effects.shake(0.55);
        audio.play('death', { pan: panFor(ev.x) });
        const alive = sim.players.filter((q) => q.alive).length;
        if (p && alive > 0) ui.toast(`${p.name} is down! Touch their circle to revive`, hexCss(p.color));
        break;
      }
      case 'extraLife': {
        const p = playerById(ev.playerId);
        effects.reviveBeam(ev.x, ev.z, p ? p.color : 0xffffff);
        effects.floatText(ev.x, 1.6, ev.z, 'EXTRA LIFE!', '#ff8fb8');
        effects.shake(0.3);
        audio.play('extraLife');
        break;
      }
      case 'revive': {
        const p = playerById(ev.playerId);
        const by = playerById(ev.by);
        effects.reviveBeam(ev.x, ev.z, p ? p.color : 0xffffff);
        effects.floatText(ev.x, 1.6, ev.z, 'SAVED!', p ? hexCss(p.color) : '#fff');
        audio.play('revive', { pan: panFor(ev.x) });
        if (p && by) ui.toast(`${by.name} saved ${p.name}!`, hexCss(by.color));
        break;
      }
      case 'pickup': {
        const colors = { boots: 0x5ff3ff, life: 0xff6fa8, shield: 0x7aa8ff };
        const labels = { boots: 'SPEED UP!', life: '+1 LIFE', shield: 'SHIELD!' };
        effects.pickup(ev.x, ev.z, colors[ev.itemType] || 0xffffff);
        effects.floatText(ev.x, 1.4, ev.z, labels[ev.itemType] || '', hexCss(colors[ev.itemType] || 0xffffff));
        audio.play(ev.itemType, { pan: panFor(ev.x) });
        const m = view && view.items.get(ev.itemId);
        if (m) { scene.remove(m.group); view.items.delete(ev.itemId); }
        break;
      }
      case 'enterCenter': {
        const p = playerById(ev.playerId);
        if (p) {
          effects.pickup(p.x, p.z, p.color);
          audio.play('pickup');
        }
        break;
      }
      case 'levelClear': {
        effects.confetti(0, 0);
        effects.shake(0.2);
        const by = playerById(ev.by);
        ui.banner(by && sim.players.length > 1 ? `${by.name.toUpperCase()} MADE IT!` : 'MADE IT!', 'Everyone back to the start…', 2000);
        audio.play('levelClear');
        break;
      }
      case 'gameOver': {
        audio.play('gameOver');
        musicStop();
        break;
      }
      case 'shieldEnd': {
        const p = playerById(ev.playerId);
        if (p) effects.shieldPop(p.x, p.z);
        audio.play('shieldEnd');
        break;
      }
    }
  }
}

function levelSubtitle(level) {
  const tips = [
    'Reach the heart of the labyrinth',
    'Watch the wolves — they pause before they move',
    'Orbiters circle the rings. Wait for the gap!',
    'Grab boots: speed is forever',
    'Sweepers cut across corridors',
    'Never leave a kitty behind',
  ];
  return tips[(level - 1) % tips.length];
}

function panFor(x) {
  return Math.max(-1, Math.min(1, (x - camTarget.x) / 18));
}

// ---------- camera ----------
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 40, 30);
let camDist = 22;
let cameraSnap = true;
const CAM_DIR = new THREE.Vector3(0, 0.83, 0.56).normalize(); // ~56° pitch, looking toward -Z

function updateCamera(dt, alpha) {
  let tx = 0, tz = 0, want = 22;
  if (mode === 'title') {
    const r = (sim.levelData.outerRadius || 20) * 0.35;
    const a = simTime * 0.08;
    tx = Math.cos(a) * r; tz = Math.sin(a) * r;
    want = (sim.levelData.outerRadius || 20) * 1.45 + 6;
  } else {
    let n = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const consider = (x, z) => { n++; tx += x; tz += z; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); };
    const meAlive = online.playing && sim.players.some((p) => p.id === online.me && p.alive);
    for (const p of sim.players) {
      if (!p.alive) continue;
      if (meAlive && p.id !== online.me) continue;
      const pp = prevPos.get('p' + p.id);
      const x = pp ? pp.x + (p.x - pp.x) * alpha : p.x;
      const z = pp ? pp.z + (p.z - pp.z) * alpha : p.z;
      consider(x + p.vx * 0.18, z + p.vz * 0.18);
    }
    if (n === 0) { for (const c of sim.circles) consider(c.x, c.z); }
    if (n === 0) consider(0, 0);
    tx /= n; tz /= n;
    const spread = Math.max(maxX - minX, (maxZ - minZ) * 1.4);
    want = Math.max(17, Math.min(50, 15 + spread * 0.9));
    if (sim.state === 'levelclear') want += 6;
  }
  const k = cameraSnap ? 1 : 1 - Math.exp(-dt * 5);
  camTarget.x += (tx - camTarget.x) * k;
  camTarget.z += (tz - camTarget.z) * k;
  camDist += (want - camDist) * (cameraSnap ? 1 : 1 - Math.exp(-dt * 2.5));
  cameraSnap = false;
  camPos.copy(camTarget).addScaledVector(CAM_DIR, camDist);
  const sh = effects.getShakeOffset();
  camera.position.set(camPos.x + sh.x, camPos.y + sh.y, camPos.z + sh.z);
  camera.lookAt(camTarget.x + sh.x * 0.5, 0, camTarget.z + sh.z * 0.5);
}

// ---------- per-frame visual sync ----------
function lerpPos(key, x, z, alpha) {
  const pp = prevPos.get(key);
  if (!pp) return [x, z];
  return [pp.x + (x - pp.x) * alpha, pp.z + (z - pp.z) * alpha];
}

function snapshotPrev() {
  for (const p of sim.players) {
    const k = 'p' + p.id; let o = prevPos.get(k);
    if (!o) { o = { x: 0, z: 0 }; prevPos.set(k, o); }
    o.x = p.x; o.z = p.z;
  }
  for (const e of sim.enemies) {
    const k = 'e' + e.id; let o = prevPos.get(k);
    if (!o) { o = { x: 0, z: 0 }; prevPos.set(k, o); }
    o.x = e.x; o.z = e.z;
  }
}

function syncVisuals(dt, alpha) {
  if (!view) return;
  if (view.levelData !== sim.levelData) buildView();
  const t = simTime;
  // wolves
  // With 100-200 wolves, only show/animate those near the camera (view + shadow range).
  const cullR = camDist * 1.35 + 12;
  const cullR2 = cullR * cullR;
  for (const e of sim.enemies) {
    const m = view.wolves.get(e.id);
    if (!m) continue;
    const near = (e.x - camTarget.x) ** 2 + (e.z - camTarget.z) ** 2 < cullR2;
    m.group.visible = near;
    if (!near) continue;
    const [x, z] = lerpPos('e' + e.id, e.x, e.z, alpha);
    m.group.position.set(x, 0, z);
    m.group.rotation.y = -e.heading;
    m.update(dt, { moving: e.moving, tell: e.tell, speed01: Math.min(1, (e.speedNow || 0) / 4), time: t });
  }
  // items
  for (const m of view.items.values()) m.update(dt, t);
  // revive circles
  const seen = new Set();
  for (const c of sim.circles) {
    seen.add(c.playerId);
    let m = view.circles.get(c.playerId);
    if (!m) {
      const p = playerById(c.playerId);
      m = createReviveCircleModel(p ? p.color : 0xffffff);
      scene.add(m.group);
      view.circles.set(c.playerId, m);
    }
    m.group.position.set(c.x, 0, c.z);
    m.update(dt, t);
  }
  for (const [id, m] of view.circles) if (!seen.has(id)) { scene.remove(m.group); view.circles.delete(id); }
  // portal
  view.portal.update(dt, t, { active: sim.state === 'levelclear' });
  // kitties
  for (const p of sim.players) {
    const k = kitties.get(p.id);
    if (!k) continue;
    k.model.group.visible = p.alive;
    if (!p.alive) { k.trail.update(dt, p.x, p.z, p.heading, false); continue; }
    let [x, z] = lerpPos('p' + p.id, p.x, p.z, alpha);
    if (online.playing && p.id === online.me) { x += online.errX; z += online.errZ; }
    k.model.group.position.set(x, 0, z);
    // smooth turn
    const cur = -k.model.group.rotation.y;
    let d = p.heading - cur;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    k.model.group.rotation.y = -(cur + d * (1 - Math.exp(-dt * 18)));
    const speed = Math.hypot(p.vx, p.vz);
    const gliding = onIce(sim.levelData, p.x, p.z); // skating: hold still, no steps or dust
    k.model.update(dt, {
      speed01: gliding ? 0 : Math.min(1, speed / (CFG.KITTY_SPEED * 1.2)),
      moving: p.moving && !gliding, skates: !!sim.levelData.ice, invuln: p.invuln, shield: p.shield, time: t,
    });
    k.trail.update(dt, x, z, -k.model.group.rotation.y, gliding && speed > 0.5);
    if (p.moving && !gliding && sim.state !== 'gameover') {
      k.dustT -= dt;
      if (k.dustT <= 0) {
        k.dustT = 0.13;
        effects.dust(x - Math.cos(p.heading) * 0.3, z - Math.sin(p.heading) * 0.3);
        k.stepN++;
        if (k.stepN % 2 === 0) audio.play('step', { volume: 0.35, pitch: 0.9 + Math.random() * 0.2, pan: panFor(x) });
      }
    }
  }
  world_update(dt, t);
}

function world_update(dt, t) {
  view.world.update(dt, t);
  lighting.update(dt, t, camTarget.x, camTarget.z);
}

function updateHUD() {
  if (mode !== 'play') { ui.setScores(null); return; }
  // score: +1 per friend saved, -1 per time caught
  ui.setScores(sim.players.map((p) => ({ name: p.name, color: p.color, score: p.rescues - p.deaths, me: online.playing ? p.id === online.me : true, you: online.playing && p.id === online.me })));
  ui.setHUD({
    level: sim.level,
    players: sim.players.map((p) => ({
      name: p.name, color: p.color, alive: p.alive, lives: p.lives,
      speedMult: p.speedMult, shield: p.shield,
    })),
    time: sim.time,
    rescues: sim.stats.rescues,
  });
}


// ---------- online ----------
// Server-authoritative netcode. The server runs the real sim; this client:
//  - runs ahead of the server by ~one-way latency + a few ticks, sending its input tagged with the tick
//    it should be applied on, and predicts its own kitty with the same movement code;
//  - simulates the wolves locally (they are deterministic from the seed), checking a few against the server;
//  - reconciles its kitty on each snapshot (server state + replay of unacknowledged inputs);
//  - shows other kitties extrapolated from their last snapshot to the same "present" as the wolves.
const net = createNet();
const lobbyUI = createLobbyUI(document.getElementById('ui'), {
  onCreate: (name) => net.send({ t: 'create', name }),
  onJoin: (code, name) => net.send({ t: 'join', code, name }),
  onLeave: () => net.send({ t: 'leave' }),
  onStart: () => net.send({ t: 'start' }),
  onRefresh: () => net.send({ t: 'list' }),
  onBack: () => { net.disconnect(); lobbyUI.hide(); setRoomInUrl(null); online.room = null; chat.setEnabled(false); ui.showTitle(({ players }) => (players === 3 ? openOnline() : startGame(players))); },
});

const chat = createChat(document.getElementById('ui'), {
  touch: TOUCH,
  onSend: (text) => net.send({ t: 'chat', text }),
  onOpen: () => keys.clear(), // don't keep running while typing
});
net.on('chat', (m) => {
  chat.add(m);
  // speech bubble over the sender's kitty during a run
  if (!m.sys && online.playing && mode === 'play') {
    const p = sim.players.find((q) => q.id === m.id);
    if (p && p.alive) effects.floatText(p.x, 2.2, p.z, m.text.length > 28 ? m.text.slice(0, 27) + '…' : m.text, hexCss(m.color));
  }
});

const WOLF_HIST = 64;
const online = {
  playing: false, me: 0, room: null, roster: new Map(),
  tick: 0, acc: 0, rate: 1, levelStartTick: 0, lastK: -1, shownLevel: 0,
  inputs: new Map(), remote: new Map(), errX: 0, errZ: 0, menu: false,
  wolfTicks: new Int32Array(WOLF_HIST).fill(-1), wolfPos: null, resyncAt: 0,
};

function setRoomInUrl(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
  history.replaceState(null, '', u);
}

function openOnline() {
  goFullscreenLandscape();
  net.connect();
  const code = new URLSearchParams(location.search).get('room');
  lobbyUI.showBrowser();
  if (code) {
    let name = '';
    try { name = localStorage.getItem('rkr-name') || ''; } catch { /* ignore */ }
    net.send({ t: 'join', code, name });
  }
}

net.on('lobbies', (m) => lobbyUI.setLobbies(m.list));
net.on('error', (m) => {
  if (lobbyUI.isOpen()) lobbyUI.showError(m.msg);
  else ui.toast(m.msg, 0xff8fa3);
  if (/code/.test(m.msg)) setRoomInUrl(null);
});
net.on('room', (m) => {
  if (!online.room || online.room.code !== m.code) chat.clear();
  online.room = m;
  online.me = m.you;
  chat.setEnabled(true);
  for (const mem of m.members) online.roster.set(mem.id, mem);
  setRoomInUrl(m.code);
  if (!online.playing || mode !== 'play') lobbyUI.showRoom(m);
});
net.on('left', () => { online.room = null; chat.setEnabled(false); setRoomInUrl(null); if (online.playing) enterTitle(false); lobbyUI.showBrowser(); });
net.on('close', () => {
  online.room = null;
  chat.setEnabled(false);
  if (online.playing) enterTitle(false);
  ui.hideGameOver();
  ui.hidePause();
  online.menu = false;
  lobbyUI.showBrowser();
  lobbyUI.showError('Connection lost. Reconnecting…');
});
net.on('start', (m) => beginOnlineGame(m));
net.on('snap', (m) => applySnapshot(m));
net.on('wolves', (m) => {
  if (!online.playing || m.lvl !== sim.level) return;
  applyEnemyState(sim.enemies, m.wolves);
  sim.enemyTicks = m.lt;
  online.wolfTicks.fill(-1);
  catchUpWolves();
});

function leadTicks() { return Math.ceil(net.rtt / 2 / (CFG.TICK * 1000)) + NET.INPUT_LEAD; }

function beginOnlineGame(m) {
  lobbyUI.hide();
  ui.hideTitle();
  ui.hideGameOver();
  ui.hidePause();
  audio.unlock();
  online.menu = false;
  mode = 'play';
  paused = false;
  for (const p of m.players) online.roster.set(p.id, p);
  playerCount = m.players.length;
  removeKitties();
  sim = createSim({ seed: m.seed, players: m.players, startLevel: m.level });
  sim.started = true;
  gameOverShown = false;
  prevPos.clear();
  online.playing = true;
  online.inputs.clear();
  online.remote.clear();
  online.errX = online.errZ = 0;
  online.lastK = m.tick;
  online.acc = 0;
  online.rate = 1;
  online.levelStartTick = m.tick - m.lt;
  online.tick = m.tick + leadTicks();
  online.wolfTicks.fill(-1);
  online.wolfPos = new Float32Array(WOLF_HIST * sim.enemies.length * 2);
  if (m.wolves) { applyEnemyState(sim.enemies, m.wolves); sim.enemyTicks = m.lt; }
  catchUpWolves();
  cameraSnap = true;
  online.shownLevel = sim.level;
  handleEvents([{ type: 'levelStart', level: sim.level }]);
}

function backToLobby() {
  online.playing = false;
  enterTitle(false);
  if (online.room) lobbyUI.showRoom(online.room);
  else lobbyUI.showBrowser();
}

function toggleOnlineMenu() {
  online.menu = !online.menu;
  if (online.menu) {
    ui.showPause(() => { online.menu = false; }, () => { online.menu = false; net.send({ t: 'leave' }); });
  } else {
    ui.hidePause();
  }
  audio.play('click');
}

// Step local wolves up to the level tick matching our current tick, remembering recent positions.
function catchUpWolves() {
  const target = online.tick - online.levelStartTick;
  let guard = 0;
  while (sim.enemyTicks < target && guard++ < 7200) {
    updateEnemies(sim.enemies, sim.levelData, CFG.TICK);
    sim.enemyTicks++;
    if (target - sim.enemyTicks < WOLF_HIST) recordWolves();
  }
}

function recordWolves() {
  const n = sim.enemies.length;
  if (!online.wolfPos || online.wolfPos.length !== WOLF_HIST * n * 2) online.wolfPos = new Float32Array(WOLF_HIST * n * 2);
  const slot = sim.enemyTicks % WOLF_HIST;
  online.wolfTicks[slot] = sim.enemyTicks;
  const base = slot * n * 2;
  for (let i = 0; i < n; i++) {
    online.wolfPos[base + i * 2] = sim.enemies[i].x;
    online.wolfPos[base + i * 2 + 1] = sim.enemies[i].z;
  }
}

function checkWolves(lt, checks) {
  const slot = lt % WOLF_HIST;
  if (online.wolfTicks[slot] !== lt || !checks) return;
  const n = sim.enemies.length;
  const base = slot * n * 2;
  for (const [id, x, z] of checks) {
    const i = sim.enemies.findIndex((e) => e.id === id);
    if (i < 0) continue;
    const dx = online.wolfPos[base + i * 2] - x, dz = online.wolfPos[base + i * 2 + 1] - z;
    if (dx * dx + dz * dz > 0.05 * 0.05) {
      const now = performance.now();
      if (now > online.resyncAt) { online.resyncAt = now + 2000; net.send({ t: 'resync' }); }
      return;
    }
  }
}

function myInput() {
  if (online.menu) return { x: 0, z: 0 };
  const me = sim.players.find((p) => p.id === online.me);
  const kb = readInput(0, 1);
  return me ? mouseInput(me, kb) : kb;
}

function onlineFrame(dt) {
  online.acc += dt * online.rate;
  let steps = 0;
  while (online.acc >= CFG.TICK && steps < 8) {
    online.acc -= CFG.TICK;
    steps++;
    onlineTick();
  }
  if (steps === 8) online.acc = 0;
  const k = 1 - Math.exp(-dt / 0.12);
  online.errX -= online.errX * k;
  online.errZ -= online.errZ * k;
}

function onlineTick() {
  snapshotPrev();
  const t = ++online.tick;
  const inp = myInput();
  const q = { x: Math.round(inp.x * 1000) / 1000, z: Math.round(inp.z * 1000) / 1000 };
  online.inputs.set(t, q);
  online.inputs.delete(t - 240);
  net.send({ t: 'in', k: t, x: q.x, z: q.z });

  const me = sim.players.find((p) => p.id === online.me);
  if (me) predictPlayer(sim, me, q, CFG.TICK);
  catchUpWolves();
  for (const p of sim.players) if (p.id !== online.me) extrapolateRemote(p, t);
  sim.time += CFG.TICK;
  for (const p of sim.players) {
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - CFG.TICK);
    if (p.shield > 0) p.shield = Math.max(0, p.shield - CFG.TICK);
  }
}

function extrapolateRemote(p, t) {
  const r = online.remote.get(p.id);
  if (!r || !p.alive) return;
  const age = Math.min(12, Math.max(0, t - r.k)) * CFG.TICK;
  let tx = r.x + r.vx * age, tz = r.z + r.vz * age;
  const c = collideCircle(sim.levelData, tx, tz, CFG.KITTY_RADIUS);
  tx = c.x; tz = c.z;
  if (Math.hypot(tx - p.x, tz - p.z) > 3) { p.x = tx; p.z = tz; return; }
  p.x += (tx - p.x) * 0.3;
  p.z += (tz - p.z) * 0.3;
}

function applySnapshot(m) {
  if (!online.playing || !sim || m.k <= online.lastK) return;
  online.lastK = m.k;

  // Keep our clock ~INPUT_LEAD ticks ahead of when the server needs our input.
  if (online.tick < m.k || online.tick - m.k > 120) {
    online.tick = m.k + leadTicks();
  }

  // Level change (the server already moved on): mirror it.
  if (m.lvl !== sim.level) {
    loadLevel(sim, m.lvl);
    online.levelStartTick = m.k - m.lt;
    online.wolfTicks.fill(-1);
    online.wolfPos = null;
    catchUpWolves();
  }

  sim.state = m.st;
  sim.time = m.tm + (online.tick - m.k) * CFG.TICK;
  sim.stats = m.s;
  const taken = new Set(m.it);
  for (const it of sim.items) it.taken = taken.has(it.id);
  sim.circles = m.c.map(([playerId, x, z, t]) => ({ playerId, x, z, t }));

  const seen = new Set();
  let rosterChanged = false;
  for (const a of m.p) {
    const [id, x, z, vx, vz, heading, alive, inC, lives, speedMult, invuln, shield, deaths, rescues, margin] = a;
    seen.add(id);
    let p = sim.players.find((q) => q.id === id);
    const fresh = !p;
    if (!p) {
      const info = online.roster.get(id) || { name: 'Kitty', color: 0xffffff };
      p = { id, name: info.name, color: info.color, x, z, vx: 0, vz: 0, heading, moving: false, alive: true, lives: 0,
        speedMult: 1, invuln: 0, shield: 0, inCenter: false, deaths: 0, rescues: 0 };
      sim.players.push(p);
      rosterChanged = true;
    }
    const wasAlive = p.alive;
    const oldX = p.x + (id === online.me ? online.errX : 0), oldZ = p.z + (id === online.me ? online.errZ : 0);
    Object.assign(p, { vx, vz, heading, alive: !!alive, inCenter: !!inC, lives, speedMult, invuln, shield, deaths, rescues });
    p.moving = Math.hypot(vx, vz) > 0.5;
    if (id === online.me) {
      p.x = x; p.z = z;
      // replay inputs the server hasn't processed yet
      for (let t = m.k + 1; t <= online.tick; t++) predictPlayer(sim, p, online.inputs.get(t) || { x: 0, z: 0 }, CFG.TICK);
      online.errX = oldX - p.x;
      online.errZ = oldZ - p.z;
      if (fresh || !wasAlive || Math.hypot(online.errX, online.errZ) > 4) online.errX = online.errZ = 0;
      // margin = how many ticks early our inputs arrive; steer toward NET.INPUT_LEAD
      const err = margin - NET.INPUT_LEAD;
      online.rate = 1 - Math.max(-0.08, Math.min(0.08, err * 0.01));
      if (Math.abs(err) > 30) online.tick += -Math.round(err);
    } else {
      online.remote.set(id, { x, z, vx, vz, k: m.k });
      if (fresh || !wasAlive) { p.x = x; p.z = z; }
    }
  }
  for (let i = sim.players.length - 1; i >= 0; i--) {
    if (!seen.has(sim.players[i].id)) { sim.players.splice(i, 1); rosterChanged = true; }
  }
  if (rosterChanged) ensureKitties();

  checkWolves(m.lt, m.ec);

  const events = m.ev.filter((e) => {
    if (e.type !== 'levelStart') return true;
    if (e.level === online.shownLevel) return false;
    online.shownLevel = e.level;
    return true;
  });
  if (events.length) handleEvents(events);
}

// ---------- main loop ----------
let last = performance.now();
let minimapT = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  tick(dt);
}

function tick(dt) {
  const running = !paused;
  if (online.playing) {
    simTime += dt;
    onlineFrame(dt);
  } else if (running) {
    simTime += dt;
    accumulator += dt;
    let steps = 0;
    while (accumulator >= CFG.TICK && steps < 6) {
      snapshotPrev();
      const inputs = {};
      if (mode === 'play') {
        const mi = mousePlayerIndex();
        sim.players.forEach((p, i) => {
          const kb = readInput(i, playerCount);
          inputs[p.id] = i === mi ? mouseInput(p, kb) : kb;
        });
        if (window.__bot) Object.assign(inputs, window.__bot(sim));
      }
      if (DEBUG_GOD) for (const p of sim.players) { p.invuln = Math.max(p.invuln, 0.5); }
      const events = stepSim(sim, inputs, CFG.TICK);
      if (mode === 'play') handleEvents(events);
      else if (events.some((e) => e.type === 'levelStart')) buildView();
      accumulator -= CFG.TICK;
      steps++;
    }
    if (steps === 6) accumulator = 0;
  }
  const alpha = online.playing ? Math.min(1, online.acc / CFG.TICK) : Math.min(1, accumulator / CFG.TICK);

  if (mode === 'play' && sim.state === 'gameover' && !gameOverShown) {
    gameOverShown = true;
    const wasOnline = online.playing;
    const runSim = sim;
    setTimeout(() => {
      if (sim !== runSim) return; // a new run already started
      ui.showGameOver({
        level: sim.level, deaths: sim.stats.deaths, rescues: sim.stats.rescues,
        time: sim.time,
      }, () => { ui.hideGameOver(); if (wasOnline) backToLobby(); else startGame(playerCount); }, wasOnline ? 'BACK TO LOBBY' : null);
    }, 1400);
  }

  const vdt = running ? dt : 0;
  syncVisuals(vdt, alpha);
  updateTargetMarker(vdt);
  effects.update(vdt);
  updateCamera(dt, alpha);
  updateHUD();

  // danger audio
  if (mode === 'play' && sim.state === 'playing') {
    let d = Infinity;
    for (const p of sim.players) if (p.alive && !p.inCenter && (!online.playing || p.id === online.me)) d = Math.min(d, nearestEnemyDist(sim.enemies, p.x, p.z));
    audio.setDanger(Math.max(0, Math.min(1, 1 - d / 3.5)));
  } else {
    audio.setDanger(0);
  }

  minimapT -= dt;
  if (mode === 'play' && minimapT <= 0) {
    minimapT = 1 / 30;
    ui.updateMinimap(sim.levelData, sim);
  }

  composer.render();
}

enterTitle();
if (params.get('room')) { ui.hideTitle(); openOnline(); }
requestAnimationFrame(frame);

// Debug handle
window.__kitty = {
  get sim() { return sim; }, scene, camera, renderer, effects, audio, ui, startGame, keys, online, net, track,
  advance(seconds) { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) tick(1 / 60); },
};


