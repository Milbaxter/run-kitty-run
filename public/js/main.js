import * as THREE from 'three';
import { CFG, PLAYER_COLORS, PLAYER_NAMES, NET, DAY_NIGHT_FV, stageOf, stageStep } from './shared/config.js';
import { hashSeed } from './shared/rng.js';
import { collideCircle, onIce, inTree, levelHash } from './shared/maze.js';
import { updateEnemies, nearestEnemyDist, applyEnemyState } from './shared/enemies.js';
import { createSim, stepSim, predictPlayer, loadLevel } from './shared/sim.js';
import { pregenNext } from './levelpregen.js';
import { ghostMaterial, disposeModel, createKittyModel, createWolfRig, newWolfState, createItemModel, createReviveCircleModel, createPortalModel, createCrownPickupModel, createGiantFishModel } from './models.js';
import { createWolfPack } from './wolfpack.js';
import { buildWorld, setupLighting } from './world.js';
import { createEffects } from './effects.js';
import { createIceTrail } from './trail.js';
import { createAuraTrail } from './auratrail.js';
import { createPawPrints } from './pawprints.js';
import { createAudio } from './audio.js';
import { createUI } from './ui.js';
import { createNet } from './net.js';
import { createLobbyUI } from './lobby.js';
import { createPadNav } from './padnav.js';
import { prefColor, localSlots } from './kittycolor.js';
import { createChat } from './chat.js';
import { createFeedback } from './feedback.js';
import { createAccount } from './account.js';
import { createLegends } from './legends.js';
import { analytics, openStatsPage } from './analytics.js';
import { TOUCH, QUALITY, goFullscreenLandscape, setKeepAwake, hideSplash } from './device.js';
import { NATIVE, haptic, plugin, call, storeUrl, openExternal, APP_VERSION } from './platform.js';

// Integration: renderer, input, camera, presentation of the pure sim.

const params = new URLSearchParams(location.search);
const DEBUG_LEVEL = Math.max(1, parseInt(params.get('level') || '1', 10) || 1);
const DEBUG_NIGHT = params.has('night');   // ?level=3&night: Run + Skate's level 3 by night
const DEBUG_MODE = ['mixed', 'run', 'ice'].includes(params.get('mode')) ? params.get('mode') : undefined; // offline testing: ?mode=ice
// local testing only (localhost): ?wins=7 starts every offline kitty with that many wins and a crown (all run rewards)
const DEBUG_WINS = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? Math.max(0, parseInt(params.get('wins') || '0', 10) || 0) : 0;
// local testing of the revive rewards: ?rescues=60 (localhost only, like ?wins=), and ?look=crown,pack to wear the
// crown and a kitten backpack without the other win rewards (the aura hides the kitty)
const DEBUG_RESCUES = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? Math.max(0, parseInt(params.get('rescues') || '0', 10) || 0) : 0;
const DEBUG_LOOK = new Set(/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? (params.get('look') || '').split(',') : []);
const DEBUG_PACK = [PLAYER_COLORS[1], PLAYER_COLORS[2], PLAYER_COLORS[3]];

// ---------- renderer / scene ----------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: QUALITY.antialias, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = QUALITY.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(0, 40, 30);

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

const lighting = setupLighting(scene);
const effects = createEffects(scene);
const audio = createAudio();
const ui = createUI(document.getElementById('ui'));

// Soundtrack: a playlist of mp3s next to index.html, played one after the other on repeat.
// Plain <audio> element. A track that fails to load is skipped; if all fail, procedural music plays.
const PLAYLIST = ['music/catjam2.mp3', 'music/catjam3.mp3', 'music/catjam4.mp3'];   // (catjam1.mp3 is resting for now)
let trackIdx = 0;
const badTracks = new Set();
// No src until the first real play(): nothing (4+ MB) is fetched at load, or ever while muted.
const track = new Audio();
track.volume = 0.5;
track.preload = 'none';
let trackWanted = false, trackFailed = false, musicLevel = 1;
let inBackground = false; // see setBackground()
function playTrack() {
  if (!track.getAttribute('src')) track.src = PLAYLIST[trackIdx];
  track.play().catch(() => { /* needs a user gesture; retried on input */ });
}
// Which songs play (remembered): 'both' (one after the other) or the index of one song, played on a loop
const MUSIC_CHOICES = ['both', ...PLAYLIST.map((_, i) => String(i))];   // ('both': all songs, the old name kept for saved choices)
let musicChoice = 'both';
try { const v = localStorage.getItem('rkr-music'); if (MUSIC_CHOICES.includes(v)) musicChoice = v; } catch { /* ignore */ }
function musicLabel() { return musicChoice === 'both' ? (PLAYLIST.length === 2 ? 'MUSIC: BOTH SONGS' : 'MUSIC: ALL SONGS') : `MUSIC: SONG ${+musicChoice + 1} ON LOOP`; }
function applyMusicChoice() {
  const one = musicChoice === 'both' ? -1 : +musicChoice;
  track.loop = one >= 0;
  if (one >= 0 && one !== trackIdx && !badTracks.has(one)) {
    trackIdx = one;   // switch now (the new song starts from the top)
    if (trackWanted && !audio.isMuted() && !inBackground && !trackFailed) { track.src = PLAYLIST[one]; playTrack(); }
    else track.removeAttribute('src');
  }
}
function cycleMusic() {
  musicChoice = MUSIC_CHOICES[(MUSIC_CHOICES.indexOf(musicChoice) + 1) % MUSIC_CHOICES.length];
  try { localStorage.setItem('rkr-music', musicChoice); } catch { /* ignore */ }
  applyMusicChoice();
  return musicLabel();
}
function nextTrack() {
  for (let k = 1; k <= PLAYLIST.length; k++) {
    const i = (trackIdx + k) % PLAYLIST.length;
    if (badTracks.has(i)) continue;
    trackIdx = i;
    if (trackWanted && !audio.isMuted() && !inBackground) { track.src = PLAYLIST[i]; playTrack(); }
    else track.removeAttribute('src'); // loaded lazily by the next playTrack()
    return;
  }
}
track.addEventListener('ended', nextTrack);   // (one song on a loop: track.loop, 'ended' never fires)
applyMusicChoice();
track.addEventListener('error', () => {
  badTracks.add(trackIdx);
  if (badTracks.size >= PLAYLIST.length) { trackFailed = true; if (trackWanted) audio.startMusic(musicLevel); return; }
  nextTrack();
});

function musicPlay(level) {
  musicLevel = level;
  trackWanted = true;
  if (trackFailed) { audio.startMusic(level); return; }
  if (!audio.isMuted() && !inBackground && track.paused) playTrack();
}
// after the victory fanfare the soundtrack comes back in softly (ramped in tick())
function musicFadeIn(level) {
  track.volume = 0.04;
  musicPlay(level);
}
function musicStop() {
  trackWanted = false;
  track.pause();
  audio.stopMusic();
}
function syncTrack() {
  if (trackFailed) return;
  if (audio.isMuted() || !trackWanted || inBackground) track.pause();
  else if (track.paused) playTrack();
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
ui.setMusicControl({ label: musicLabel, cycle: cycleMusic });
ui.onMenuClick(() => {
  if (mode !== 'play' || runOver()) return;
  if (online.playing) toggleOnlineMenu(); else togglePause();
});

// ---------- camera zoom (on your kitty): mouse wheel, + / -, a two-finger pinch, a controller's right stick ----------
// camZoom scales the camera's distance while playing: 1 = the usual view, down to ZOOM_MIN (closer). Remembered.
const ZOOM_MIN = 0.45;
let camZoom = 1;
try { camZoom = Math.max(ZOOM_MIN, Math.min(1, +localStorage.getItem('rkr-zoom') || 1)); } catch { /* ignore */ }
let zoomSaveT = 0;
function zoomBy(f) {
  camZoom = Math.max(ZOOM_MIN, Math.min(1, camZoom * f));
  clearTimeout(zoomSaveT);
  zoomSaveT = setTimeout(() => { try { localStorage.setItem('rkr-zoom', String(Math.round(camZoom * 1000) / 1000)); } catch { /* ignore */ } }, 400);
}

// ---------- input ----------
const keys = new Set();
// Co-op: P1 is mouse-driven (see below); P2 moves with WASD or the arrows.
const KEYMAP = [
  null,
  { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] },
];
const SOLO_KEYMAP = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] };
const SPECTATE_KEYS = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1, Tab: 1 };

window.addEventListener('keydown', (e) => {
  if (!e.code) return;   // a synthetic event (the controller's B in the lobby): not a key to hold
  if (e.key === 'Enter' && online.room && !chat.isOpen() && !ui.isOverlayOpen() && !e.target.closest?.('input')) {
    e.preventDefault();
    chat.open();
    return;
  }
  audio.unlock();
  if (e.code !== 'KeyM') syncTrack(); // browsers only start media after a user gesture
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  // spectating (online, your kitty down): Left/Right/A/D/Tab switch the watched kitty. These presses are kept out
  // of `keys` so they don't count as movement held from before a revive (keyup deletes them harmlessly).
  if (SPECTATE_KEYS[e.code] && spectating() && !chat.isOpen() && !ui.isOverlayOpen() && !e.target.closest?.('input, textarea')) {
    e.preventDefault();
    if (!e.repeat) cycleWatch(e.code === 'Tab' && e.shiftKey ? -1 : SPECTATE_KEYS[e.code]);
    return;
  }
  // zoom: + / - (also the number pad), not while typing
  if ((e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'Minus' || e.code === 'NumpadSubtract') && mode === 'play'
    && !chat.isOpen() && !ui.isOverlayOpen() && !e.target.closest?.('input, textarea')) {
    e.preventDefault();
    zoomBy(e.code === 'Equal' || e.code === 'NumpadAdd' ? 0.9 : 1 / 0.9);
    return;
  }
  if (e.repeat) { keys.add(e.code); return; }
  keys.add(e.code);
  if (e.code === 'KeyM') {
    toggleSound();
  } else if ((e.code === 'KeyP' || e.code === 'Escape') && mode === 'play' && !runOver()) {
    if (online.playing) toggleOnlineMenu();
    else togglePause();
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.key === 'Meta') keys.clear();   // macOS sends no keyup for keys let go while Cmd was held
});
// lose focus (alt-tab etc.): let go of everything, the mouse button and a pinch too (their release never arrives)
function releaseAllInput() { keys.clear(); mouse.held = false; mouse.target = null; pinch.id = null; }
window.addEventListener('blur', () => { releaseAllInput(); if (mode === 'play' && !online.playing && !paused && sim.state === 'playing') togglePause(); });
window.addEventListener('pointerdown', () => { audio.unlock(); syncTrack(); });

// navigator.getGamepads() snapshot, taken once per tick() and shared by readInput / padActive / pollPadNav
let framePads = [];
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
  // (one kitty on this device: the first connected controller, whatever slot the browser put it in)
  const pad = framePads && (playerCount === 1 ? Array.prototype.find.call(framePads, (q) => q && q.connected) : framePads[index]);
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

// Mouse: always drives player 1 (in co-op too). Click = run to that spot, hold = steer toward cursor.
const mouse = { ndc: new THREE.Vector2(), has: false, held: false, target: null, iceDir: null };
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const mouseHit = new THREE.Vector3();

// Touch: a floating joystick wherever the thumb lands (anywhere on screen, so it never covers the kitty).
// Drag direction = screen direction the kitty moves; letting go = no input (stop, or keep sliding on ice).
const JOY_R = 55, JOY_DEAD = 8;
let touchId = null;
const joy = { on: false, ox: 0, oy: 0, x: 0, y: 0 };
const joyEl = document.createElement('div');
joyEl.innerHTML = '<div></div>';
joyEl.style.cssText = `position:fixed;left:0;top:0;width:${JOY_R * 2}px;height:${JOY_R * 2}px;margin:-${JOY_R}px 0 0 -${JOY_R}px;border-radius:50%;` +
  'border:3px solid rgba(255,255,255,.55);background:rgba(20,10,40,.22);pointer-events:none;z-index:5;display:none;';
joyEl.firstChild.style.cssText = 'position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;' +
  'background:rgba(255,255,255,.75);box-shadow:0 2px 8px rgba(0,0,0,.35);';
document.body.appendChild(joyEl);
function drawJoy() {
  joyEl.style.display = joy.on ? 'block' : 'none';
  if (!joy.on) return;
  joyEl.style.transform = `translate(${joy.ox}px,${joy.oy}px)`;
  joyEl.firstChild.style.transform = `translate(${joy.x - joy.ox}px,${joy.y - joy.oy}px)`;
}
function joyMove(e) {
  joy.x = e.clientX; joy.y = e.clientY;
  // the base trails the thumb once it is pulled past the rim
  const dx = joy.x - joy.ox, dy = joy.y - joy.oy, d = Math.hypot(dx, dy);
  if (d > JOY_R) { joy.ox = joy.x - dx / d * JOY_R; joy.oy = joy.y - dy / d * JOY_R; }
  drawJoy();
}
const _camRight = new THREE.Vector3(), _camFwd = new THREE.Vector3();
function joyInput() {
  const dx = joy.x - joy.ox, dy = joy.y - joy.oy, d = Math.hypot(dx, dy);
  if (d < JOY_DEAD) return { x: 0, z: 0 };
  // screen right/up -> ground directions as the camera sees them
  _camRight.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
  camera.getWorldDirection(_camFwd).setY(0).normalize();
  const m = Math.min(1, d / JOY_R) / d;
  const sx = dx * m, sy = -dy * m;
  return { x: _camRight.x * sx + _camFwd.x * sy, z: _camRight.z * sx + _camFwd.z * sy };
}
function setMouseNdc(e) {
  mouse.ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  mouse.has = true;
}
function mouseGround() {
  raycaster.setFromCamera(mouse.ndc, camera);
  return raycaster.ray.intersectPlane(groundPlane, mouseHit) ? { x: mouseHit.x, z: mouseHit.z } : null;
}
// a second finger pinches (zoom) while the first keeps steering
const pinch = { id: null, x: 0, y: 0, d: 0 };
const fingerGap = () => Math.hypot(pinch.x - joy.x, pinch.y - joy.y);
canvas.addEventListener('wheel', (e) => {
  if (mode !== 'play') return;
  e.preventDefault();
  zoomBy(Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.004));
}, { passive: false });
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    if (e.pointerId === touchId) joyMove(e); // only the first finger steers
    else if (e.pointerId === pinch.id) { pinch.x = e.clientX; pinch.y = e.clientY; }
    if (pinch.id !== null && touchId !== null) { const d = fingerGap(); if (pinch.d > 20 && d > 20) zoomBy(pinch.d / d); pinch.d = d; }
    return;
  }
  setMouseNdc(e);
});
canvas.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (mode !== 'play' || paused || (e.button !== 0 && e.button !== 2)) return;
  if (e.pointerType === 'touch') {
    if (touchId !== null) {   // a second finger: pinch to zoom
      if (pinch.id === null) { pinch.id = e.pointerId; pinch.x = e.clientX; pinch.y = e.clientY; pinch.d = fingerGap(); try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
      return;
    }
    touchId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    joy.on = true; joy.ox = joy.x = e.clientX; joy.oy = joy.y = e.clientY;
    if (pinch.id !== null) pinch.d = fingerGap();   // a pinch still going: measure from here (no jump)
    mouse.target = null; mouse.iceDir = null;
    drawJoy();
    return;
  }
  setMouseNdc(e);
  mouse.held = true;
  mouse.iceDir = null;
  mouse.target = mouseGround();
  if (mouse.target) targetPulse = 1;
});
function pointerEnd(e) {
  if (e.pointerType === 'touch') {
    if (e.pointerId === pinch.id) { pinch.id = null; return; }
    if (e.pointerId !== touchId) return;
    touchId = null;
    joy.on = false;
    drawJoy();
    return;
  }
  mouse.held = false;
}
window.addEventListener('pointerup', pointerEnd);
window.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function mousePlayerIndex() {
  if (online.playing) return sim.players.findIndex((p) => p.id === online.me);
  return 0;
}

function mouseInput(p, kb) {
  if (Math.hypot(kb.x, kb.z) > 0.1 || !p.alive) { mouse.target = null; mouse.iceDir = null; return kb; }
  if (joy.on) return joyInput();
  if (p.waitRelease) {
    // the sim holds the kitty until it reads "let go" once: a click (or a press held from before the checkpoint)
    // would aim at a spot the frozen kitty never reaches and keep it stuck, so drop it and send a release
    mouse.target = null; mouse.iceDir = null; mouse.held = false;
    return kb;
  }
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
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }), // exact player colour
);
targetMarker.rotation.x = -Math.PI / 2;
targetMarker.visible = false;
scene.add(targetMarker);

function updateTargetMarker(dt) {
  const p = sim && sim.players[mousePlayerIndex()];
  if (mode !== 'play' || !p || !p.alive || !mouse.target) { targetMarker.visible = false; return; }
  targetMarker.visible = true;
  targetMarker.material.color.set(p.color);
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
let localSetup = { mode: undefined, names: [] };   // single player / co-op: the mode and names from the setup screen (lobby.js)
let simTime = 0;         // presentation clock (seconds)
let accumulator = 0;
let gameOverShown = false;
let victory = null;       // the final run is beaten: { sim, t, ev, shown, shownAt, lobbyAt, nextFw, musicBack } (presentation only)
let intro = null;         // the final run's opening fly-over: { sim, t }
// the run is over: everyone down, or the final run was beaten (no pause menu, no game-over screen after a win)
function runOver() { return sim.state === 'gameover' || sim.state === 'victory'; }

// Visual bindings
let view = null;          // { levelData, world, portal, wolves: Map, items: Map, circles: Map }
const kitties = new Map(); // playerId -> { model, dustT }
const prevPos = new Map(); // id -> {x,z} for interpolation (players 'p'+id, enemies 'e'+id)

function newSeed() { return hashSeed(Date.now(), Math.random()) >>> 0; }

function startSim(players, startLevel, simMode = DEBUG_MODE) {
  sim = createSim({ seed: newSeed(), players, startLevel: stageStep(simMode || 'mixed', DAY_NIGHT_FV, startLevel, DEBUG_NIGHT), mode: simMode, finales: DAY_NIGHT_FV });
  if (DEBUG_WINS) for (const p of sim.players) { p.finishes = DEBUG_WINS; p.crowned = true; }
  if (DEBUG_RESCUES) for (const p of sim.players) p.rescues = DEBUG_RESCUES;
  accumulator = 0;
  gameOverShown = false;
  victory = null;
  intro = null;
  prevPos.clear();
}

function clearView() {
  if (!view) return;
  view.world.dispose();
  scene.remove(view.world.group);
  disposeModel(view.portal.group);
  disposeModel(view.crown.group);
  if (view.fish) disposeModel(view.fish.group);
  view.wolfPack.dispose(); // wolf models are proxy rigs outside the scene (cached geometries, no GPU state)
  for (const it of view.items.values()) disposeModel(it.group);
  for (const c of view.circles.values()) disposeModel(c.group);
  view = null;
}

function buildView() {
  clearView();
  const ld = sim.levelData;
  const world = buildWorld(scene, ld);
  if (world.group.parent !== scene) scene.add(world.group);
  lighting.setTheme(ld.theme, ld);   // the final run: hell, warming to gold at the goal room
  const portal = createPortalModel();
  scene.add(portal.group);
  const crown = createCrownPickupModel();
  crown.group.position.set(ld.crown.x, 0, ld.crown.z);
  scene.add(crown.group);
  // one posable rig per wolf type (they all look alike within a type), a little state per wolf (its stride etc.)
  const wolves = new Map(), rigs = new Map();
  for (const e of sim.enemies) {
    // the look goes by how it runs: crossers cutting across the last lanes' junction at a slant wear the diagonals' coat
    const spec = ld.enemies[e.id], kind = spec && spec.pattern === 'junction-crosser' ? 'diagonal' : e.type;
    let r = rigs.get(kind);
    if (!r) {
      // scarier every level, dressed for the season; wild: a shaggy ruff of fur round the neck instead of a collar
      const rig = createWolfRig(kind, { level: ld.level, theme: ld.theme, finale: !!ld.finale, wild: true });
      rig.group.scale.setScalar(CFG.WOLF_RADIUS / 0.55); // models are built for the original 0.55 radius
      r = { rig, n: 0 };
      rigs.set(kind, r);
    }
    r.n++;
    wolves.set(e.id, { rig: r.rig, st: newWolfState(), lastHeading: undefined });
  }
  const wolfPack = createWolfPack(scene, [...rigs.values()].map((r) => [r.rig, r.n])); // draws all wolves instanced
  const items = new Map();
  for (const it of sim.items) {
    if (it.taken) continue;
    const m = createItemModel(it.type);
    if (it.mega) m.group.scale.setScalar(1.7);   // level 9's big pair of boots (full speed at once)
    m.group.position.set(it.x, inTree(ld, it.x, it.z) ? 2.2 : 0, it.z); // tree boots sit on the canopy
    scene.add(m.group);
    items.set(it.id, m);
  }
  // the final run: a giant fish waits in the goal room for the kitties (eaten client-side, see feast())
  let fish = null;
  if (ld.finale) { fish = createGiantFishModel(); scene.add(fish.group); }
  view = { levelData: ld, world, portal, crown, fish, wolves, wolfPack, items, circles: new Map() };
  prevPos.clear();
  warmShaders();
}

// Get every material of the level ready on the GPU while it loads. A shader is otherwise compiled the first time its
// material is drawn: the first checkpoint coming into view, the first revive beam / teleport sparkles, the first
// wolf of a kind on screen, the first kitty down (ghost + revive circle)... each a hitch of 20-150 ms mid-run. Hidden
// things are shown for the call only; with KHR_parallel_shader_compile (compileAsync) the driver compiles in the
// background instead of stalling the frame.
// While the driver compiles them in the background (compileAsync), drawing would just wait for it (a frame of ~0.7 s at
// a level start): keep showing the last picture instead, until they're ready (WARM_HOLD_MS at most).
const WARM_HOLD_MS = 2000;
let warmExtras = null, warmHoldUntil = 0;
function warmShaders() {
  if (!warmExtras) {   // things that only exist later (a kitty down): one hidden copy of each, kept for this
    warmExtras = new THREE.Group();
    warmExtras.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), ghostMaterial()), createReviveCircleModel(0xffffff).group);
    warmExtras.visible = false;
    scene.add(warmExtras);
  }
  const hidden = [];
  scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
  try {
    if (renderer.compileAsync) {
      const hold = performance.now() + WARM_HOLD_MS;
      warmHoldUntil = hold;
      const done = () => { if (warmHoldUntil === hold) warmHoldUntil = 0; };
      renderer.compileAsync(scene, camera).then(done, done);
    }
    else renderer.compile(scene, camera);
  } catch { /* a missing shader just compiles on first use, as before */ }
  for (const o of hidden) o.visible = false;
}

function ensureKitties() {
  for (const p of sim.players) {
    if (!kitties.has(p.id)) {
      const model = createKittyModel(p.color);
      // Player-colored ground marker with a heading pip (readability + co-op identity).
      // not tone mapped: shows the exact swatch colour (ACES would wash it out), never brighter than it
      const mat = new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
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
      kitties.set(p.id, { model, dustT: 0, stepN: 0, fx: new THREE.Color(p.color), trail: createIceTrail(scene), auraTrail: createAuraTrail(scene, p.color), paws: createPawPrints(scene, p.color) });
    }
  }
  for (const [id, k] of kitties) {
    if (!sim.players.find((p) => p.id === id)) { disposeModel(k.model.group); k.trail.dispose(); k.auraTrail.dispose(); k.paws.dispose(); kitties.delete(id); }
  }
}

function removeKitties() {
  for (const k of kitties.values()) { disposeModel(k.model.group); k.trail.dispose(); k.auraTrail.dispose(); k.paws.dispose(); }
  kitties.clear();
}

// ---------- flow ----------
function enterTitle(showTitleScreen = true) {
  if (online.menu) { online.menu = false; ui.hidePause(); }
  if (mode === 'play' && sim) analytics.runEnd(runSummary());
  mode = 'title';
  paused = false;
  online.playing = false;
  ui.hideVictory();
  if (showTitleScreen) legends.reset(); // back to the lobby keeps an open board (sign while the others head back)
  ui.hideHUD();
  removeKitties();
  startSim([], 1 + Math.floor(Math.random() * 3));
  stepSim(sim, {}, CFG.TICK); // generate level
  buildView();
  if (showTitleScreen) ui.showTitle(onTitlePick);
  musicPlay(1);
}

// LOCAL (solo or co-op, picked on the setup screen with name, kitty colour, mode; lobby.js), then the run.
// Phones have no second keyboard player: solo only. The last pick is remembered.
const LOCAL_N_KEY = 'rkr-local-players';
function onTitlePick({ players }) {
  if (players === 3) return openOnline();
  audio.unlock();
  audio.play('click');
  let n = 1;
  if (!TOUCH) { try { n = localStorage.getItem(LOCAL_N_KEY) === '2' ? 2 : 1; } catch { /* ignore */ } }
  lobbyUI.showLocal(n, {
    mode: DEBUG_MODE,   // ?mode= (offline testing) preselects
    coop: !TOUCH,
    onPlayers: (k) => { try { localStorage.setItem(LOCAL_N_KEY, String(k)); } catch { /* ignore */ } },
    onStart: ({ mode: m, names, players: k }) => { localSetup = { mode: m, names }; startGame(k); },
    onBack: () => ui.showTitle(onTitlePick),
  });
}

function startGame(n, level = DEBUG_LEVEL) {
  goFullscreenLandscape();
  audio.unlock();
  audio.play('click');
  playerCount = n;
  ui.hideTitle();
  ui.hideGameOver();
  ui.hideVictory();
  legends.reset();
  mode = 'play';
  paused = false;
  const players = [];
  const slots = localSlots(n); // player 1 in the preferred colour (kittycolor.js)
  // the names from the setup screen (empty: the colour's own name)
  for (let i = 0; i < n; i++) players.push({ id: i + 1, name: localSetup.names[i] || PLAYER_NAMES[slots[i]], color: PLAYER_COLORS[slots[i]] });
  removeKitties();
  startSim(players, level, localSetup.mode || DEBUG_MODE);
  analytics.runStart(n === 1 ? 'solo' : 'coop', sim.mode || 'mixed');
  cameraSnap = true;
  // First step emits levelStart which triggers buildView.
}

function togglePause() {
  paused = !paused;
  if (paused) {
    // LEAVE GAME: back to the title screen (the run is dropped)
    ui.showPause(() => { paused = false; ui.hidePause(); }, () => enterTitle(), { online: false });
  } else {
    ui.hidePause();
  }
  audio.play('click');
}

// stats for the anonymous play counter: your own kitty online, the whole team offline
function runSummary() {
  const me = online.playing ? playerById(online.me) : null;
  return me ? { deaths: me.deaths, rescues: me.rescues } : { deaths: sim.stats.deaths, rescues: sim.stats.rescues };
}

function playerById(id) { return sim.players.find((p) => p.id === id); }
function hexCss(c) { return '#' + c.toString(16).padStart(6, '0'); }

function handleEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case 'levelStart': {
        pregenNext(sim); // the next level, off the main thread (offline nextLevel and online loadLevel pick it up)
        mouse.target = null; mouse.iceDir = null;
        buildView();
        ensureKitties();
        for (const k of kitties.values()) k.paws.clear(); // prints belong to the old map
        for (const p of sim.players) effects.teleport(p.x, p.z, p.color);
        const finale = !!sim.levelData.finale;
        const L = sim.levelData.level || ev.level, night = stageOf(sim.mode, sim.finales, sim.level).night;
        if (finale) ui.banner('WELCOME TO HELL', 'Think you can escape?', 4200, 'finale');
        else if (night) ui.banner(`LEVEL ${L} · NIGHT`, 'Lace up your skates!', 2200);
        else ui.banner(`LEVEL ${L}`, levelSubtitle(L), 2200);
        if (audio.isMuted() && !soundHintShown) {
          soundHintShown = true;
          ui.toast('Sound is off. Press M or click the speaker to turn it on', '#b9a4ff');
        }
        audio.play(finale ? 'finale' : 'levelStart');
        if (finale) effects.shake(0.35);
        musicPlay(L);
        cameraSnap = cameraSnap || L === DEBUG_LEVEL;
        // the final run: the camera stays on the start square, pushing in, until you touch anything
        intro = finale ? { sim, t: 0 } : null;
        break;
      }
      case 'death': {
        const p = playerById(ev.playerId);
        if (mine(ev.playerId)) haptic('heavy');
        effects.deathPoof(ev.x, ev.z, p ? p.color : 0xffffff);
        effects.shake(0.55);
        audio.play('death', { pan: panFor(ev.x) });
        const alive = sim.players.filter((q) => q.alive).length;
        if (p && alive > 0) downToast(p);
        break;
      }
      case 'extraLife': {
        const p = playerById(ev.playerId);
        if (mine(ev.playerId)) haptic('medium');
        effects.reviveBeam(ev.x, ev.z, p ? p.color : 0xffffff);
        effects.floatText(ev.x, 1.6, ev.z, 'EXTRA LIFE!', '#ff8fb8');
        effects.shake(0.3);
        audio.play('extraLife');
        break;
      }
      case 'revive': {
        const p = playerById(ev.playerId);
        const by = playerById(ev.by);
        if (mine(ev.playerId) || mine(ev.by)) haptic('medium');
        if (by && (by.rescues || 0) >= 120) effects.callingCard(ev.x, ev.z, by.color, { cool: (by.finishes || 0) >= 5, rainbow: (by.finishes || 0) >= 8 });   // 120+ revives: the rescuer's calling card, as their player card looks
        effects.reviveBeam(ev.x, ev.z, p ? p.color : 0xffffff);
        effects.floatText(ev.x, 1.6, ev.z, 'SAVED!', p ? hexCss(p.color) : '#fff');
        audio.play('revive', { pan: panFor(ev.x) });
        // (only to the two of them: everyone sees SAVED! over the kitty; with 8 kitties these toasts never stopped)
        if (p && by && (mine(ev.playerId) || mine(ev.by))) ui.toast(`${by.name} saved ${p.name}!`, hexCss(by.color));
        break;
      }
      case 'crown': {
        const p = playerById(ev.playerId);
        const c = sim.levelData.crown;
        effects.pickup(c.x, c.z, 0xffd34a);
        effects.floatText(c.x, 2.2, c.z, 'CROWN!', '#ffd34a');
        audio.play('extraLife');
        if (p) ui.toast(`👑 ${p.name} grabbed the crown!`, hexCss(p.color));
        break;
      }
      case 'checkpoint': {
        const by = playerById(ev.by);
        haptic('medium');
        // the kitties gathered there (ev.moved; older servers: everyone but the one that reached it) drop their old heading
        const mp = sim.players[mousePlayerIndex()];
        if (!mp || (ev.moved ? ev.moved.includes(mp.id) : mp.id !== ev.by)) { mouse.target = null; mouse.iceDir = null; }
        if (ev.medic) {   // the broken checkpoint, repaired by a kitty with 60+ revives
          ui.banner('MEDICAT TO THE RESCUE!!!', ev.revived.length ? `${by ? by.name : 'A medicat'} fixed the checkpoint: everyone is back on their paws` : `${by ? by.name : 'A medicat'} fixed the checkpoint`, 2600);
          if (view && view.world.repairCheckpoint) view.world.repairCheckpoint(ev.index);
        } else ui.banner('CHECKPOINT!', ev.revived.length ? 'Everyone is back on their paws' : (by && sim.players.length > 1 ? `${by.name} gathered the team` : 'Progress saved'), 1600);
        effects.teleport(ev.x, ev.z, by ? by.color : 0x8fdcff);
        effects.reviveBeam(ev.x, ev.z, ev.medic ? 0xff5a6a : 0x8fdcff);
        audio.play('revive');
        break;
      }
      case 'pickup': {
        if (mine(ev.playerId)) haptic('light');
        const colors = { boots: 0x5ff3ff, life: 0xff6fa8, shield: 0x7aa8ff };
        const labels = { boots: 'SPEED UP!', life: '+1 LIFE', shield: 'SHIELD!' };
        effects.pickup(ev.x, ev.z, colors[ev.itemType] || 0xffffff);
        effects.floatText(ev.x, 1.4, ev.z, ev.mega ? 'MAX SPEED!' : labels[ev.itemType] || '', hexCss(colors[ev.itemType] || 0xffffff));
        audio.play(ev.itemType, { pan: panFor(ev.x) });
        const m = view && view.items.get(ev.itemId);
        if (m) { disposeModel(m.group); view.items.delete(ev.itemId); }
        break;
      }
      case 'enterCenter': {
        const p = playerById(ev.playerId);
        if (p) {
          effects.pickup(p.x, p.z, p.color);
          audio.play('pickup');
          // the disc only makes you safe: the crown in the middle clears the level (wait for your friends first)
          if (mine(p.id) && !sim.crownTaken) ui.toast(sim.players.length > 1 ? 'Safe! Grab the crown in the middle when your team is ready' : 'Safe! Grab the crown in the middle to finish', '#ffcf5a');
        }
        break;
      }
      case 'stageClear': {
        // Run + Skate by day: the goal is a checkpoint, the night half of the same level comes next
        haptic('success');
        effects.confetti(0, 0);
        effects.shake(0.2);
        const by = playerById(ev.by);
        ui.banner(by && sim.players.length > 1 ? `${by.name.toUpperCase()} MADE IT!` : 'MADE IT!', 'Night falls… off to the ice!', 2000);
        audio.play('levelClear');
        break;
      }
      case 'levelClear': {
        haptic('success');
        effects.confetti(0, 0);
        effects.shake(0.2);
        analytics.level(ev.level);
        if (sim.levelData.finale) break; // the final run: the 'victory' event that follows throws the party
        const by = playerById(ev.by);
        ui.banner(by && sim.players.length > 1 ? `${by.name.toUpperCase()} MADE IT!` : 'MADE IT!', 'Everyone back to the start…', 2000);
        audio.play('levelClear');
        break;
      }
      case 'gameOver': {
        haptic('error');
        analytics.runEnd(runSummary());
        audio.play('gameOver');
        musicStop();
        break;
      }
      case 'victory': {
        startVictory(ev);
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

// haptics: only for your own kitty online; every kitty on this device offline
function mine(id) { return !online.playing || id === online.me; }
// one 'down' toast for everyone who's down, updated as more go down (not one per kitty)
function downToast(p) {
  const down = sim.players.filter((q) => !q.alive), others = down.filter((q) => q.id !== p.id);
  const text = !others.length ? `${p.name} is down! Touch their circle to revive`
    : down.length === 2 ? `${p.name} and ${others[0].name} are down!` : `${down.length} kitties are down!`;
  ui.toast(text, hexCss(p.color), 'down');
}

// ---------- the final run: opening fly-over and the victory party ----------
const FW_COLORS = [0xff5c8a, 0xffd23f, 0x3ee08f, 0x4cc9ff, 0xb388ff, 0xff8c42, 0xffffff];
const FW_KINDS = ['peony', 'peony', 'ring', 'willow'];

function launchFirework(fuse) {
  const R = (sim.levelData.roomHalf || 8) - 1;
  const a = Math.random() * Math.PI * 2;
  const x0 = Math.cos(a) * R, z0 = Math.sin(a) * R;
  const x = (Math.random() * 2 - 1) * 6, z = (Math.random() * 2 - 1) * 6 - 2, y = 7 + Math.random() * 5;
  // mostly the kitties' own colours
  const pc = sim.players.length && Math.random() < 0.6 ? sim.players[(Math.random() * sim.players.length) | 0].color : null;
  const color = pc != null ? pc : FW_COLORS[(Math.random() * FW_COLORS.length) | 0];
  const color2 = Math.random() < 0.5 ? color : FW_COLORS[(Math.random() * FW_COLORS.length) | 0];
  const kind = FW_KINDS[(Math.random() * FW_KINDS.length) | 0];
  audio.play('fireworkLaunch', { pan: panFor(x0), volume: 0.6, pitch: 0.9 + Math.random() * 0.25 });
  effects.firework(x0, z0, x, y, z, {
    color, color2, kind, fuse, scale: QUALITY.particles,
    onBurst: (bx) => { audio.play('fireworkBoom', { pan: panFor(bx), volume: 0.7, pitch: 0.85 + Math.random() * 0.3 }); effects.shake(0.06); },
  });
}

function startVictory(ev) {
  if (victory && victory.sim === sim) return;
  victory = { sim, t: 0, ev: ev || null, shown: false, nextFw: 1.6, musicBack: false };
  intro = null;
  mouse.target = null; mouse.iceDir = null;
  if (online.menu) { online.menu = false; ui.hidePause(); } // the victory screen replaces the online menu
  analytics.runEnd({ ...runSummary(), won: true });
  if (!online.playing) {
    // offline win: the board, and a line for each local kitty (player 1 signs with the saved online name if there is one)
    const p1 = savedName();
    legends.fetchOffline({
      mode: sim.mode, time: sim.time, runTime: ev && Number.isFinite(ev.time) ? ev.time : sim.levelTime,
      players: sim.players.map((p, i) => ({ name: i === 0 && p1 ? p1 : p.name, color: p.color })),
    });
  }
  musicStop();
  audio.play('victory');
  effects.confetti(0, 0);
  effects.shake(0.6);
  effects.reviveBeam(0, 0, 0xffd34a);
  // kitties that went down on the way were carried into the room for the party
  for (const id of (ev && ev.party) || []) {
    const p = playerById(id);
    if (p) { effects.teleport(p.x, p.z, p.color); prevPos.delete('p' + p.id); }
  }
  const by = ev ? playerById(ev.by) : null;
  ui.banner('VICTORY!', by && sim.players.length > 1 ? `${by.name} reached the end first!` : 'You beat the final run!', 3800, 'gold');
  for (let i = 0; i < 3; i++) launchFirework(0.6 + i * 0.3); // opening salvo
}

function updateVictory(dt) {
  if (victory && (victory.sim !== sim || mode !== 'play' || sim.state !== 'victory')) victory = null;
  if (!victory && mode === 'play' && sim.state === 'victory') startVictory(null); // missed the event: still party
  if (!victory) return;
  const v = victory;
  if (!(dt > 0)) return;
  v.t += dt;
  v.nextFw -= dt;
  while (v.nextFw <= 0) {
    launchFirework();
    v.nextFw += v.t < 10 ? 0.25 + Math.random() * 0.4 : 0.9 + Math.random() * 1.5; // a big show, then a calmer one
  }
  if (v.t < 7) effects.confettiRain(0, 0, 10, Math.max(1, Math.round(3 * QUALITY.particles)));
  if (!v.musicBack && v.t > 4.8) { v.musicBack = true; musicFadeIn(sim.levelData.level || sim.level); }
  if (view && view.fish) {
    if (!v.feastCue && v.t > 2.4) { v.feastCue = true; if (!view.fish.done()) { const h = view.fish.headPos(); effects.floatText(h.x * 0.75, 2.4, h.z * 0.75, 'FISH FEAST!', '#ffb27a'); } }
    if (v.shown) ui.updateVictoryFish(Math.floor(view.fish.eaten() * 100));
  }
  if (!v.shown && v.t > 5.5) { v.shown = true; v.shownAt = v.t; showVictoryScreen(); }
  // online: the server sent everyone back to the lobby; give the victory screen a few seconds, then follow
  if (v.lobbyAt != null && online.playing && v.shown && v.t - Math.max(v.lobbyAt, v.shownAt) > 5) {
    ui.hideVictory();
    backToLobby();
  }
}

function showVictoryScreen() {
  const ev = victory.ev;
  const by = ev ? playerById(ev.by) : null;
  const wasOnline = online.playing;
  const stats = {
    runTime: ev && Number.isFinite(ev.time) ? ev.time : (wasOnline ? undefined : sim.levelTime),
    totalTime: Math.max(0, sim.time - victory.t), // time at the win (online, sim.time only arrives with the snapshots)
    deaths: sim.stats.deaths, rescues: sim.stats.rescues,
    fish: view && view.fish ? Math.floor(view.fish.eaten() * 100) : undefined,
    first: by ? { name: by.name, color: by.color } : null,
    players: sim.players.map((p) => ({ name: p.name, color: p.color, first: !!by && p.id === by.id })),
  };
  const buttons = wasOnline
    ? [{ label: 'BACK TO LOBBY', onClick: () => backToLobby() }]
    : [{ label: 'PLAY AGAIN', sub: 'from level 1', onClick: () => startGame(playerCount, 1) },
      { label: 'MAIN MENU', alt: true, onClick: () => enterTitle() }];
  // finishers only: online the server sends the board to the winners; offline it was fetched at the win (read-only)
  victory.legendsBtn = !wasOnline || legends.available();
  if (victory.legendsBtn) {
    buttons.push({ label: 'LEGENDS BOARD', sub: legends.canSign() ? 'sign your name' : 'see who did it', alt: true, mini: true, keep: true, onClick: () => legends.open() });
  }
  ui.showVictory(stats, buttons);
}

function padActive() {
  for (const pad of framePads || []) {
    if (!pad || !pad.connected) continue;
    if (Math.abs(pad.axes[0] || 0) > 0.3 || Math.abs(pad.axes[1] || 0) > 0.3) return true;
    if (pad.buttons.some((b) => b.pressed)) return true;
  }
  return false;
}

// The fly-over ends by itself, or the moment anyone touches a control / a kitty moves (it never holds anyone back).
function updateIntro(dt) {
  if (!intro) return;
  if (intro.sim !== sim || mode !== 'play' || sim.state !== 'playing' || paused) { intro = null; return; }
  intro.t += dt;
  const moved = sim.players.some((p) => (!online.playing || p.id === online.me) && p.alive && Math.hypot(p.vx, p.vz) > 0.5);
  if (intro.t > 5.2 || moved || keys.size > 0 || mouse.held || joy.on || padActive()) intro = null;
}

// Gamepad on the overlays (victory / game over / pause): A or Start = confirm, d-pad / stick left-right = switch.
// On the legends board: B or Start closes it, d-pad up/down (or the right stick) scrolls.
const padNav = { confirm: false, prev: false, next: false, back: false, spPrev: false, spNext: false };
// The menus (title, online lobby screens, single player / co-op setup, pause menu, notices) get a highlight moved
// with the d-pad / left stick, A = press, B = back (padnav.js). Start pauses a run (offline) or opens the menu
// (online), and closes the pause menu again.
const menuPad = createPadNav();
let padNavAt = performance.now();
function pollPadNav() {
  const now = performance.now(), dt = Math.min(0.1, (now - padNavAt) / 1000);
  padNavAt = now;
  let confirm = false, prev = false, next = false, back = false, scroll = 0, spPrev = false, spNext = false;
  let a = false, bBtn = false, start = false, select = false, up = false, down = false, left = false, right = false;
  for (const pad of framePads || []) {
    if (!pad || !pad.connected) continue;
    const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    spPrev = spPrev || b(4) || b(14); // LB / d-pad left
    spNext = spNext || b(5) || b(15); // RB / d-pad right
    confirm = confirm || b(0) || b(9);
    prev = prev || b(14) || b(12) || ax < -0.6;
    next = next || b(15) || b(13) || ax > 0.6;
    back = back || b(1) || b(9);
    scroll += (b(13) ? 1 : 0) - (b(12) ? 1 : 0) + (Math.abs(pad.axes[3] || 0) > 0.3 ? pad.axes[3] : 0);
    a = a || b(0); bBtn = bBtn || b(1); start = start || b(9); select = select || b(8);
    up = up || b(12) || ay < -0.55; down = down || b(13) || ay > 0.55;
    left = left || b(14) || ax < -0.55; right = right || b(15) || ax > 0.55;
  }
  const aEdge = a && !padNav.a, bEdge = bBtn && !padNav.b, startEdge = start && !padNav.start;
  // Select / View / Share: sound on / off, anywhere (like M)
  if (select && !padNav.select) { toggleSound(); ui.toast(audio.isMuted() ? 'Sound off' : 'Sound on', '#b9a4ff'); }
  const dir = up ? 'up' : down ? 'down' : left ? 'left' : right ? 'right' : '';
  const pauseEl = ui.pauseRoot();
  const fbEl = feedback.isOpen() ? feedback.root() : null;
  const statsEl = document.querySelector('.rks-modal');   // the STATS window (analytics.js)
  const menu = legends.isOpen() ? null
    : fbEl || statsEl || pauseEl || ui.noticeRoot() || ui.gameOverRoot() || (lobbyUI.isOpen() && !(online.playing && mode === 'play') ? lobbyUI.root() : null) || ui.titleRoot();
  const res = menuPad.poll(menu, { dir, a: aEdge, b: bEdge }, dt);
  if (legends.isOpen()) {
    if (back && !padNav.back) legends.close();
    else if (scroll) legends.scrollBy(scroll * 14);
  } else if (fbEl) {
    if (res === 'back') feedback.close();
  } else if (statsEl) {
    if (res === 'back') { const b = statsEl.querySelector('button'); if (b) b.click(); }
  } else if (pauseEl) {
    if (res === 'back' || startEdge) ui.navigate('confirm');   // B / Start: back to the run
  } else if (menu) {
    // B: back (the lobby browser / setup go back to the title on Esc, lobby.js)
    if (res === 'back' && lobbyUI.isOpen()) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  } else if (ui.isOverlayOpen()) {
    if (prev && !padNav.prev) ui.navigate('prev');
    if (next && !padNav.next) ui.navigate('next');
    if (confirm && !padNav.confirm) ui.navigate('confirm');
  } else {
    if (spectating()) {
      if (spPrev && !padNav.spPrev) cycleWatch(-1);
      if (spNext && !padNav.spNext) cycleWatch(1);
    }
    // Start in a run: pause (offline) / the online menu
    if (startEdge && mode === 'play' && !runOver() && !chat.isOpen()) { if (online.playing) toggleOnlineMenu(); else togglePause(); }
  }
  padNav.confirm = confirm; padNav.prev = prev; padNav.next = next; padNav.back = back;
  padNav.spPrev = spPrev; padNav.spNext = spNext;
  padNav.a = a; padNav.b = bBtn; padNav.start = start; padNav.select = select;
}

// one line per level (levels past 8: the last one); some of them are hints (see CFG.MUSIC_BOOST and the level rules
// after it)
function levelSubtitle(level) {
  const tips = [
    'Get to the middle',
    'Music makes you go faster',
    'CATJAM',
    'Speed is life',
    'Never leave a kitty behind',
    'Grind never stops',
    'Getting close!',
    'Is it over...?',
  ];
  return tips[Math.min(level, tips.length) - 1];
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
// victory: the camera pulls back and slowly orbits the goal room at a lower pitch (so the fireworks are in view)
let camOrbit = 0, camYaw = 0;
const _orbDir = new THREE.Vector3(), _camDir = new THREE.Vector3();
const smooth01 = (v) => { v = Math.max(0, Math.min(1, v)); return v * v * (3 - 2 * v); };
// online, while your kitty is down: follow the nearest kitty still standing (nearest to your revive circle),
// sticking with it until it falls too, so you can watch the rescue. The usual camera lerp makes the switch smooth.
let watchId = null;
function pickWatch(meP) {
  const cur = watchId != null ? playerById(watchId) : null;
  if (cur && cur.alive) return cur;
  const c = sim.circles.find((q) => q.playerId === meP.id);
  const ox = c ? c.x : meP.x, oz = c ? c.z : meP.z;
  let best = null, bd = Infinity;
  for (const p of sim.players) {
    if (!p.alive || p.id === meP.id) continue;
    const d = (p.x - ox) ** 2 + (p.z - oz) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  watchId = best ? best.id : null;
  return best;
}
// the kitties you can switch to while spectating, in player order (stable, so cycling is predictable)
function watchCandidates() {
  return sim.players.filter((p) => p.alive && p.id !== online.me);
}
function spectating() {
  return online.playing && mode === 'play' && watchId != null && sim.state !== 'gameover' && !online.menu;
}
// manual switch: Left/Right/A/D/Tab, the pill's ‹ › buttons, or gamepad shoulders / d-pad. The pick sticks
// (pickWatch keeps an alive watchId) until that kitty goes down or you're revived.
function cycleWatch(dir) {
  if (!spectating()) return;
  const list = watchCandidates();
  if (list.length < 2) return;
  const i = list.findIndex((p) => p.id === watchId);
  watchId = list[((i < 0 ? 0 : i + dir) % list.length + list.length) % list.length].id;
  haptic('light');
}
const FINE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
let watchEl = null, watchNameEl = null, watchShown = '';
function updateWatchLabel() {
  const p = online.playing && mode === 'play' && watchId != null && sim.state !== 'gameover' ? playerById(watchId) : null;
  const multi = !!p && watchCandidates().length > 1;
  const key = p ? p.id + '|' + p.name + '|' + multi : '';
  if (key === watchShown) return;
  watchShown = key;
  if (!watchEl) {
    watchEl = document.createElement('div');
    watchEl.style.cssText = 'position:fixed;left:50%;bottom:18%;transform:translateX(-50%);display:flex;align-items:center;gap:4px;' +
      'padding:2px;border-radius:999px;background:rgba(0,0,0,0.45);color:#fff;font:600 14px system-ui,sans-serif;' +
      'z-index:5;user-select:none;-webkit-user-select:none;white-space:nowrap;touch-action:manipulation;';
    const mkBtn = (label, dir, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText = 'width:40px;height:40px;border:0;border-radius:50%;background:rgba(255,255,255,0.18);color:#fff;' +
        'font:700 24px/1 system-ui,sans-serif;cursor:pointer;padding:0;touch-action:manipulation;';
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); cycleWatch(dir); b.blur(); });
      return b;
    };
    watchEl.prevBtn = mkBtn('‹', -1, 'Previous kitty');
    watchEl.nextBtn = mkBtn('›', 1, 'Next kitty');
    watchNameEl = document.createElement('span');
    watchNameEl.style.cssText = 'padding:4px 10px;pointer-events:none;';
    watchEl.append(watchEl.prevBtn, watchNameEl, watchEl.nextBtn);
    document.body.appendChild(watchEl);
  }
  watchNameEl.textContent = p ? 'Watching ' + p.name + (multi && FINE_POINTER ? '  (← → to switch)' : '') : '';
  watchEl.prevBtn.style.display = watchEl.nextBtn.style.display = multi ? '' : 'none';
  watchEl.style.pointerEvents = multi ? 'auto' : 'none';
  watchEl.style.display = p ? 'flex' : 'none';
}

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
    const meP = online.playing ? playerById(online.me) : null;
    const meAlive = !!(meP && meP.alive);
    const watch = online.playing && meP && !meAlive ? pickWatch(meP) : null;
    if (!watch) watchId = null;
    for (const p of sim.players) {
      if (!p.alive) continue;
      if (meAlive && p.id !== online.me) continue;
      if (watch && p !== watch) continue;
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
    if (victory) { tx = 0; tz = 0; want = 30; }
  }
  let flyover = false;
  if (intro && mode === 'play') {
    // never show how long it is: the camera stays on the start square where you spawn, slowly pushing in from higher up
    tx = sim.levelData.corners[0].x; tz = sim.levelData.corners[0].z; want = 30 - 12 * smooth01(intro.t / 4.5);
    flyover = true;
  }
  if (mode === 'play' && !flyover && !victory) {
    // a controller's right stick (up = closer) zooms too
    for (const pad of framePads || []) {
      const ry = pad && pad.connected ? pad.axes[3] || 0 : 0;
      if (Math.abs(ry) > 0.3) { zoomBy(Math.exp(ry * dt * 1.4)); break; }
    }
    want *= camZoom;
  }
  const k = cameraSnap || flyover ? 1 : 1 - Math.exp(-dt * 5);
  camTarget.x += (tx - camTarget.x) * k;
  camTarget.z += (tz - camTarget.z) * k;
  camDist += (want - camDist) * (cameraSnap ? 1 : 1 - Math.exp(-dt * 2.5));
  cameraSnap = false;
  let dir = CAM_DIR, lookY = 0;
  if (victory && mode === 'play') {
    camOrbit += (1 - camOrbit) * (1 - Math.exp(-dt * 0.9));
    camYaw += dt * 0.2 * camOrbit;
    const pitch = 0.62, cp = Math.cos(pitch);
    _orbDir.set(Math.sin(camYaw) * cp, Math.sin(pitch), Math.cos(camYaw) * cp);
    dir = _camDir.copy(CAM_DIR).lerp(_orbDir, camOrbit).normalize();
    lookY = 4 * camOrbit;
  } else {
    camOrbit = 0; camYaw = 0; // leaving the party always means a new scene
  }
  camPos.copy(camTarget).addScaledVector(dir, camDist);
  const sh = effects.getShakeOffset();
  camera.position.set(camPos.x + sh.x, camPos.y + sh.y, camPos.z + sh.z);
  camera.lookAt(camTarget.x + sh.x * 0.5, lookY, camTarget.z + sh.z * 0.5);
}

// ---------- per-frame visual sync ----------
// returns a shared scratch object (read it before the next call)
const _lerp = { x: 0, z: 0 };
function lerpPos(key, x, z, alpha) {
  const pp = prevPos.get(key);
  if (!pp) { _lerp.x = x; _lerp.z = z; return _lerp; }
  _lerp.x = pp.x + (x - pp.x) * alpha; _lerp.z = pp.z + (z - pp.z) * alpha;
  return _lerp;
}

function snapshotPrev() {
  for (const p of sim.players) {
    const k = 'p' + p.id; let o = prevPos.get(k);
    if (!o) { o = { x: 0, z: 0 }; prevPos.set(k, o); }
    o.x = p.x; o.z = p.z;
  }
  // wolves: on the wolf object itself (thousands of them: no string keys / map lookups every tick)
  for (const e of sim.enemies) { e.px = e.x; e.pz = e.z; }
}

// 6+ finishes: smoothly blend through all the cat colours, ~1 s each
const _cycB = new THREE.Color();
function cycleColor(t, out) {
  const n = PLAYER_COLORS.length, i = Math.floor(t) % n, f = t - Math.floor(t);
  return out.set(PLAYER_COLORS[i]).lerp(_cycB.set(PLAYER_COLORS[(i + 1) % n]), f * f * (3 - 2 * f));
}

// ---------- the final run's giant fish: kitties next to it eat it ----------
// Pure presentation: the sim knows nothing about the fish, so every client counts its own bites from where the kitties
// stand (kitties that reached the goal are held inside the goal disc, whose rim runs along the fish's belly). A kitty
// standing still within FEAST_REACH of an uneaten chunk faces it and munches; after the win, kitties left standing
// around near the fish wander over to it by themselves (a small visual offset that melts away as soon as they move).
const FEAST_REACH = 1.3;     // gap between a kitty's centre and the fish's surface (kitties in the goal stay within ~4.7 of the origin)
const FEAST_WANDER = 4.5;    // after the win: idle kitties this close walk over by themselves (offset at most FEAST_STRAY)
const FEAST_STRAY = 7;
function feast(k, p, x, z, dt) {
  const fish = view.fish;
  if (k.ox === undefined) { k.ox = 0; k.oz = 0; k.idleT = 0; k.biteT = 0.3; k.bites = 0; }
  const st = sim.state;
  if (st !== 'playing' && st !== 'victory') { k.ox = 0; k.oz = 0; return null; }
  const still = !p.moving;
  k.idleT = still ? k.idleT + dt : 0;
  const vx = x + k.ox, vz = z + k.oz;   // where the kitty is shown
  const near = fish.nearest(vx, vz);
  if ((!near || near.d > FEAST_WANDER + 0.5) && Math.abs(k.ox) + Math.abs(k.oz) < 1e-3) { k.ox = 0; k.oz = 0; return null; }
  // standing still: stay where you are shown; moving: the offset melts away
  let wx = still ? k.ox : 0, wz = still ? k.oz : 0;
  if (victory && near && still && k.idleT > 2 && near.d > FEAST_REACH * 0.8 && near.d < FEAST_WANDER) {
    const gx = near.px - vx, gz = near.pz - vz, L = Math.hypot(gx, gz), m = Math.max(0, near.d - FEAST_REACH * 0.5);
    if (L > 1e-6) { wx += gx / L * m; wz += gz / L * m; }
    // stay on the dais side of the fish (never stroll out over the bones), and not too far from the real kitty
    const tx = x + wx, tz = z + wz, tr = Math.hypot(tx, tz), RMAX = sim.levelData.centerRadius;
    if (tr > RMAX) { wx = tx * RMAX / tr - x; wz = tz * RMAX / tr - z; }
    const wl = Math.hypot(wx, wz);
    if (wl > FEAST_STRAY) { wx *= FEAST_STRAY / wl; wz *= FEAST_STRAY / wl; }
  }
  // walk there at a stroll; snap back quickly once the player moves
  const px = k.ox, pz = k.oz, gx = wx - k.ox, gz = wz - k.oz, gl = Math.hypot(gx, gz), step = Math.min(gl, dt * (still ? 2.4 : 10));
  if (gl > 1e-6) { k.ox += gx / gl * step; k.oz += gz / gl * step; }
  const vel = dt > 0 ? Math.hypot(k.ox - px, k.oz - pz) / dt : 0;
  const ex = x + k.ox, ez = z + k.oz;
  const walking = still && vel > 0.35;
  let face = walking ? Math.atan2(k.oz - pz, k.ox - px) : null, munch = false;
  const n2 = near && (k.ox !== px || k.oz !== pz) ? fish.nearest(ex, ez) : near;
  if (n2 && still && !walking && n2.d < FEAST_REACH) {
    munch = true;
    face = Math.atan2(n2.pz - ez, n2.px - ex);
    k.biteT -= dt;
    if (k.biteT <= 0) {
      k.biteT = 0.5 + Math.random() * 0.25;
      const b = fish.bite(n2.i);
      if (b) {
        k.bites++;
        const fx = Math.cos(face), fz = Math.sin(face), mx = ex + fx * 0.5, mz = ez + fz * 0.5;
        effects.munch(mx, 0.55, mz, -fx, -fz, k.bites % 3 === 1, QUALITY.particles);
        audio.play('chomp', { volume: 0.45, pan: panFor(mx), pitch: 0.95 + Math.random() * 0.15 });
        if (b.done) fishFinished();
      }
    }
  } else k.biteT = 0.25;
  return { x: ex, z: ez, face, munch, walking };
}

function fishFinished() {
  const h = view.fish.headPos();
  effects.burst(h.x, 0.8, h.z, { color: 0xffd36a, count: Math.round(40 * QUALITY.particles), speed: 5, size: 0.3, life: 1.1, spread: 0.5 });
  effects.floatText(h.x, 2.2, h.z, 'ALL GONE!', '#ffd34a');
  audio.play('fishDone', { volume: 0.8, pan: panFor(h.x) });
  ui.updateVictoryFish(100);
}

const _seenCircles = new Set();
const _kitArgs = {}; // reused kitty model.update() args (the model only reads them)
// 8+ wins backpack passengers: the other players' colours (more than PACK_MAX others: the PACK_MAX with the lowest
// scoreboard score, ties by player order, shown in player order; solo: a few default cats). Returns the kitty's
// cached array, replaced only when the chosen set changes (the model rebuilds the heads on a new array).
const PACK_MAX = 5, _packTmp = [];
const packScore = (o) => (o.rescues | 0) - (o.deaths | 0) + 20 * (o.finishes || 0);   // as on the scoreboard
function packColors(k, p) {
  _packTmp.length = 0;
  const ps = sim.players, crowded = ps.length - 1 > PACK_MAX;
  for (let i = 0; i < ps.length; i++) {
    const o = ps[i];
    if (o.id === p.id) continue;
    if (crowded) {   // rank = other players ahead of o (lower score, or same score earlier in order)
      const s = packScore(o);
      let rank = 0;
      for (let j = 0; j < ps.length && rank < PACK_MAX; j++) {
        const q = ps[j];
        if (q.id === p.id || j === i) continue;
        const sq = packScore(q);
        if (sq < s || (sq === s && j < i)) rank++;
      }
      if (rank >= PACK_MAX) continue;
    }
    _packTmp.push(o.color);
  }
  if (!_packTmp.length) for (const c of PLAYER_COLORS) if (c !== p.color && _packTmp.length < 3) _packTmp.push(c);
  const old = k.packCols;
  let same = !!old && old.length === _packTmp.length;
  for (let i = 0; same && i < old.length; i++) same = old[i] === _packTmp[i];
  if (!same) k.packCols = _packTmp.slice();
  return k.packCols;
}
const WOLF_CULL_PAD = 3;   // how far outside the view a wolf still counts (its body and shadow reach in)
const _cullFrustum = new THREE.Frustum(), _cullM = new THREE.Matrix4(), _cullS = new THREE.Sphere(), _cullP = new THREE.Vector3();
const _wolfArgs = { moving: false, speed01: 0, time: 0 };
function syncVisuals(dt, alpha) {
  if (!view) return;
  if (view.levelData !== sim.levelData) buildView();
  const t = simTime;
  // wolves: only those the camera can see (its view, widened by WOLF_CULL_PAD for their shadows; last frame's
  // camera, a frame behind at most) are posed and drawn. Each is posed on its type's shared rig from its own state.
  camera.updateMatrixWorld();
  _cullFrustum.setFromProjectionMatrix(_cullM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  view.wolfPack.begin();
  for (const e of sim.enemies) {
    const m = view.wolves.get(e.id);
    if (!m) continue;
    const x = e.px === undefined ? e.x : e.px + (e.x - e.px) * alpha, z = e.pz === undefined ? e.z : e.pz + (e.z - e.pz) * alpha;
    if (!_cullFrustum.intersectsSphere(_cullS.set(_cullP.set(x, 0.5, z), WOLF_CULL_PAD))) { m.lastHeading = undefined; continue; }
    const g = m.rig.group;
    g.position.set(x, 0, z);
    g.rotation.y = -e.heading;
    _wolfArgs.moving = e.moving; _wolfArgs.speed01 = Math.min(1, (e.speedNow || 0) / 4); _wolfArgs.time = t;
    m.rig.pose(m.st, dt, _wolfArgs);
    view.wolfPack.add(m.rig);
    if (e.pattern) {
      // push-off: shavings the moment a wolf turns round at the end of a run (its heading changes once per run)
      if (m.lastHeading !== undefined && e.heading !== m.lastHeading) effects.iceKick(x, z, e.heading);
      m.lastHeading = e.heading;
    }
  }
  view.wolfPack.end();
  // items
  // drop pickups the server says are taken (a 'pickup' event from before we joined / reconnected never reached us)
  for (const it of sim.items) {
    const m = it.taken && view.items.get(it.id);
    if (m) { disposeModel(m.group); view.items.delete(it.id); }
  }
  for (const m of view.items.values()) m.update(dt, t);
  // revive circles
  const seen = _seenCircles; seen.clear();
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
  for (const [id, m] of view.circles) if (!seen.has(id)) { disposeModel(m.group); view.circles.delete(id); }
  // portal
  view.portal.update(dt, t, { active: sim.state === 'levelclear' || sim.state === 'victory' });
  if (view.fish) view.fish.update(dt, t);
  view.crown.group.visible = !sim.crownTaken;
  if (!sim.crownTaken) view.crown.update(dt, t, camera);
  // kitties
  for (const p of sim.players) {
    const k = kitties.get(p.id);
    if (!k) continue;
    k.model.group.visible = p.alive;
    if (!p.alive) { k.trail.update(dt, p.x, p.z, p.heading, false); k.auraTrail.update(dt, p.x, 0, p.z, p.heading, false); k.paws.update(dt); continue; }
    const lp = lerpPos('p' + p.id, p.x, p.z, alpha);
    let x = lp.x, z = lp.z;
    if (online.playing && p.id === online.me) { x += online.errX; z += online.errZ; }
    const eat = view.fish ? feast(k, p, x, z, dt) : null;   // the final run's giant fish
    if (eat) { x = eat.x; z = eat.z; }
    // autumn levels: up a tree = standing on its canopy
    k.climb = (k.climb || 0) + ((inTree(sim.levelData, x, z) ? 2.2 : 0) - (k.climb || 0)) * (1 - Math.exp(-dt * 12));
    k.model.group.position.set(x, k.climb, z);
    // smooth turn
    const cur = -k.model.group.rotation.y;
    let d = (eat && eat.face != null ? eat.face : p.heading) - cur;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    k.model.group.rotation.y = -(cur + d * (1 - Math.exp(-dt * 18)));
    const speed = Math.hypot(p.vx, p.vz);
    const gliding = onIce(sim.levelData, p.x, p.z); // skating: hold still, no steps or dust
    // run rewards (finishes = runs won): 2+ paw prints + coloured skate marks, 3+ flame aura, 4+ aura trail,
    // 6+ all of them cycle through the cat colours (the fur keeps its own); wins 2-6 also set stones in the crown
    const wins = p.finishes || 0, paws = wins >= 2;
    if (wins >= 6) cycleColor(t + p.id * 2.3, k.fx);
    const ka = _kitArgs;
    ka.speed01 = gliding ? 0 : eat && eat.walking ? 0.45 : Math.min(1, speed / (CFG.KITTY_SPEED * 1.2));
    ka.moving = (p.moving && !gliding) || !!(eat && eat.walking); ka.munch = !!(eat && eat.munch); ka.bites = k.bites | 0;
    ka.skates = !!sim.levelData.ice && !(sim.levelData.iceZMax != null && z > sim.levelData.iceZMax);   // (not on Run + Skate level 9's run half)
    ka.boots = Math.round(((p.speedMult || 1) - 1) / CFG.SPEED_BOOST); ka.invuln = p.invuln; ka.shield = p.shield; ka.time = t;
    ka.crown = !!p.crowned; ka.crownStones = Math.max(0, Math.min(5, wins - 1)); ka.aura = wins >= 3; ka.auraColor = k.fx; ka.sunglasses = wins >= 5; ka.rainbowBoots = wins >= 7; ka.auraCycle = wins >= 6;
    ka.backpack = wins >= 8; ka.packColors = ka.backpack ? packColors(k, p) : null;
    // wins 9-16: night crown (9) and its stars (10-14), golden skates (10), fluffy tail
    // with a glowing tip (11), a rainbow name (12, ui.js), backpack kittens turning rainbow (13: one, 14: two, 15: all),
    // lion (14; at 16 a celestial or silver lion, see below). 120 revives: medevac rotor blades on the back
    ka.moonCrown = wins >= 9; ka.crownStars = Math.max(0, Math.min(5, wins - 9));
    ka.goldSkates = wins >= 10; ka.fluffyTail = wins >= 11;
    ka.packRainbow = wins >= 15 ? 99 : wins >= 14 ? 2 : wins >= 13 ? 1 : 0;
    // 14: the lion (and the crown's moon lights up); 16: celestial lion with 120 revives, the rainbow cat stays rainbow
    // (60+ revives), otherwise the chrome moon lion; 120 revives: the medevac rotor
    const res = p.rescues || 0;
    ka.lion = wins >= 14; ka.moonGlow = wins >= 14; ka.moonCat = wins >= 15;   // 15: the crown's moon becomes a moon cat
    ka.celestial = wins >= 16 && res >= 120; ka.silver = wins >= 16 && res < 60; ka.rotor = res >= 120;
    // revive rewards (rescues this run): 10+ medic cape, 30+ a trail of little stars of life, 60+ angel wings (they add up)
    const saves = p.rescues || 0;
    ka.cape = saves >= 10; ka.wings = saves >= 60;
    ka.rainbowCat = wins >= 8 && saves >= 60;   // every win reward and every revive reward: rainbow fur
    if (DEBUG_LOOK.has('crown')) ka.crown = true;
    if (DEBUG_LOOK.has('pack')) { ka.backpack = true; ka.packColors = DEBUG_PACK; }
    if (saves >= 30 && !ka.celestial && p.alive && speed > 1) {   // (celestial lion: its own space trail instead, below)
      k.heartT = (k.heartT || 0) - dt;
      if (k.heartT <= 0) {
        k.heartT = 0.11;
        // 6+ wins: each star a step further round the rainbow, so the trail is a rainbow
        const col = ka.auraCycle ? _trailRainbow.setHSL((t * 1.6 + (k.rbOff ??= Math.random())) % 1, 1, 0.55) : p.color;
        effects.medicTrail(x - Math.cos(p.heading) * 0.35, k.climb || 0, z - Math.sin(p.heading) * 0.35, col);
      }
    }
    if (ka.celestial && p.alive && speed > 0.5) {   // celestial lion: a trail of space behind
      k.cosT = (k.cosT || 0) - dt;
      if (k.cosT <= 0) {
        k.cosT = 0.045;
        const cy = k.climb || 0, fx = Math.cos(p.heading), fz = Math.sin(p.heading);
        effects.cosmicTrail(x - fx * 0.4, cy, z - fz * 0.4);
        // a thin stream of stars off each open wing's tip (rig space: 0.1 back, 0.62 up, 0.65 out to each side)
        for (const side of [1, -1]) effects.cosmicTrail(x - fx * 0.1 - fz * 0.65 * side, cy + 0.52, z - fz * 0.1 + fx * 0.65 * side, 1, 0.04, 0.12, 0.55);
      }
    }
    k.model.update(dt, ka);
    k.trail.update(dt, x, z, -k.model.group.rotation.y, gliding && speed > 0.5, paws ? k.fx : null);
    k.auraTrail.update(dt, x, k.climb, z, -k.model.group.rotation.y, wins >= 4 && speed > 1, k.fx);
    k.paws.update(dt);
    if (p.moving && !gliding && sim.state !== 'gameover') {
      k.dustT -= dt;
      if (k.dustT <= 0) {
        k.dustT = 0.13;
        const bx = x - Math.cos(p.heading) * 0.3, bz = z - Math.sin(p.heading) * 0.3;
        if (paws) k.paws.add(bx, inTree(sim.levelData, bx, bz) ? 2.2 : 0, bz, p.heading, k.fx); // on the ground or up on a canopy
        else effects.dust(bx, bz);
        k.stepN++;
        if (k.stepN % 2 === 0) audio.play('step', { volume: 0.35, pitch: 0.9 + Math.random() * 0.2, pan: panFor(x) });
      }
    }
  }
  world_update(dt, t);
}

const _trailRainbow = new THREE.Color();
function world_update(dt, t) {
  view.world.update(dt, t);
  lighting.update(dt, t, camTarget.x, camTarget.z);
}

const feedback = createFeedback(document.getElementById('ui'), {
  getContext: () => {
    if (mode !== 'play' || !sim) return { name: '', mode: 'title', level: 0 };
    const me = online.playing ? sim.players.find((p) => p.id === online.me) : sim.players[0];
    return { name: me ? me.name : '', mode: online.playing ? 'online' : playerCount === 2 ? 'coop' : 'solo', level: sim ? sim.levelData.level || sim.level : 0 };
  },
});

ui.onFeedbackClick(() => feedback.open());


const hudScores = [], hudPlayers = [];
const hudData = { level: 0, players: hudPlayers, time: 0, rescues: 0 };
let hudScoresOff = false;
function updateHUD() {
  // feedback button: while your kitty is down, or on the game-over screen
  let down = false;
  if (mode === 'play') {
    if (sim.state === 'gameover') down = true;
    else if (online.playing) down = sim.players.some((p) => p.id === online.me && !p.alive);
    else down = sim.players.some((p) => !p.alive);
  }
  feedback.setVisible(down);
  feedback.dock(ui.gameOverSlot()); // on the game-over card it sits under 'press Enter', not over it
  if (mode !== 'play') { if (!hudScoresOff) { hudScoresOff = true; ui.setScores(null); } return; }
  // score: +1 per friend saved, -1 per time caught, +20 per win (finishing a level first)
  // The row objects persist; ui.setScores (sort + DOM key) only runs when a score row actually changes.
  const ps = sim.players;
  let dirty = hudScoresOff || hudScores.length !== ps.length;
  hudScoresOff = false;
  if (dirty) { hudScores.length = ps.length; hudPlayers.length = ps.length; }
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const score = p.rescues + (p.bonus || 0) - p.deaths + 20 * (p.finishes || 0), crown = !!p.crowned;
    const me = online.playing ? p.id === online.me : true, you = online.playing && p.id === online.me;
    let r = hudScores[i];
    if (!r) r = hudScores[i] = {};
    const shimmer = (p.finishes || 0) >= 12;   // 12+ wins: a rainbow name on the scoreboard
    if (r.name !== p.name || r.color !== p.color || r.score !== score || r.crown !== crown || r.me !== me || r.you !== you || r.shimmer !== shimmer) {
      r.name = p.name; r.color = p.color; r.score = score; r.crown = crown; r.me = me; r.you = you; r.shimmer = shimmer;
      dirty = true;
    }
    let h = hudPlayers[i];
    if (!h) h = hudPlayers[i] = {};
    h.name = p.name; h.color = p.color; h.cool = (p.finishes || 0) >= 5; h.shimmer = (p.finishes || 0) >= 12; h.rainbow = (p.finishes || 0) >= 8 && (p.rescues || 0) >= 60; h.alive = p.alive; h.lives = p.lives; h.speedMult = p.speedMult; h.shield = p.shield; h.you = you;
    h.paid = online.playing ? ((online.roster.get(p.id) || {}).paid || 0) : i === 0 && account.shown() ? account.paid() : 0;   // account total (unless switched off)
  }
  if (dirty) ui.setScores(hudScores);
  hudData.level = sim.levelData.level || sim.level; hudData.time = sim.time; hudData.rescues = sim.stats.rescues;
  ui.setHUD(hudData);
}


// ---------- online ----------
// Server-authoritative netcode. The server runs the real sim; this client:
//  - runs ahead of the server by ~one-way latency + a few ticks, sending its input tagged with the tick
//    it should be applied on, and predicts its own kitty with the same movement code;
//  - simulates the wolves locally (they are deterministic from the seed), checking a few against the server;
//  - reconciles its kitty on each snapshot (server state + replay of unacknowledged inputs);
//  - shows other kitties extrapolated from their last snapshot to the same "present" as the wolves.
const net = createNet();
// optional account: your total shows next to your name online (and on your card offline)
const account = createAccount(document.getElementById('ui'));
net.acct = account.token;
account.onChange(() => {
  ui.setAccountButton(account.enabled() ? { paid: account.paid(), hidden: !account.shown(), signedIn: account.signedIn() } : null);
  if (net.connected) net.send({ t: 'acct', acct: account.token() || '' });
});
ui.onAccountClick(() => account.open());
account.init();

const lobbyUI = createLobbyUI(document.getElementById('ui'), {
  // opts: { max: how many kitties may join, password: '' = public } (lobby.js)
  onCreate: (name, mode, opts = {}) => net.send({ t: 'create', name, mode, color: prefColor(), max: opts.max, password: opts.password || '' }),
  onJoin: (code, name, password = '') => net.send({ t: 'join', code, name, color: prefColor(), password }),
  onLeave: () => net.send({ t: 'leave' }),
  onStart: () => net.send({ t: 'start' }),
  onRefresh: () => net.send({ t: 'list' }),
  onBack: () => leaveOnline(),
});

const chat = createChat(document.getElementById('ui'), {
  touch: TOUCH,
  onSend: (text) => {
    if (online.room) net.send({ t: 'chat', text });
  },
  onOpen: () => keys.clear(), // don't keep running while typing
  onReport: NATIVE ? (id, reason) => net.send({ t: 'report', id, reason }) : null, // Report only in the store apps
});
// Legends board (legends.js): online winners get it over ws and may sign; offline winners read it over HTTP.
const legends = createLegends(document.getElementById('ui'), {
  send: (m) => net.send(m),
  isOnline: () => net.connected,
  onOpenChange: (on) => { ui.setVictoryHidden(on); keys.clear(); },
});
ui.setBlocker(() => legends.isOpen());
net.on('legends', (m) => {
  legends.onBoard(m);
  // arrived after the victory screen went up without the button (reconnect): put it up again with the button
  if (victory && victory.shown && !victory.legendsBtn && ui.isVictoryOpen() && online.playing) showVictoryScreen();
});
net.on('legend', (m) => legends.onLegend(m));
net.on('signed', (m) => legends.onSigned(m));
// back in the lobby while you can still sign: a small shortcut to the board (only the winners ever see it)
setInterval(() => legends.setFab(legends.canSign() && lobbyUI.isOpen() && lobbyUI.view() === 'room'), 1000);

net.on('chat', (m) => {
  if (!chat.add(m)) return; // blocked player or chat hidden: no bubble either
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

function leaveOnline() {
  net.disconnect();
  lobbyUI.hide();
  setRoomInUrl(null);
  online.room = null;
  online.rejoin = null;
  chat.setEnabled(false);
  ui.showTitle(onTitlePick);
}

// pass: a private lobby's password, kept after '#' like in its invite link (platform.js inviteUrl)
function setRoomInUrl(code, pass) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
  u.hash = code && pass ? 'pw=' + encodeURIComponent(pass) : '';
  history.replaceState(null, '', u);
}

// a private lobby's password from an invite link (…?room=ABCD#pw=secret), '' if none
function passFromLink(url) {
  const m = /[#&]pw=([^&#]*)/.exec(url || '');
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}

function savedName() {
  try { return localStorage.getItem('rkr-name') || ''; } catch { return ''; }
}

// First time online in the store apps: Terms / zero-tolerance notice (terms.js; App Store 1.2). The web has no gate.
function termsAccepted() {
  if (!NATIVE) return Promise.resolve(true);
  return import('./terms.js').then((m) => (m.ensureTermsAccepted ? m.ensureTermsAccepted() : true), () => true);
}

let opening = false;
async function openOnline(joinCode, joinPass) {
  goFullscreenLandscape(); // needs the user gesture: before any await
  if (opening) return;
  if (net.outdated) { showOutdated(); return; }
  opening = true;
  let ok = true;
  try { ok = await termsAccepted(); } catch { ok = true; }
  opening = false;
  if (!ok) { setRoomInUrl(null); if (!ui.isTitleOpen()) ui.showTitle(onTitlePick); return; }
  net.connect();
  const code = joinCode || new URLSearchParams(location.search).get('room');
  const password = joinCode ? joinPass || '' : passFromLink(location.hash);
  lobbyUI.showBrowser();
  if (code) net.send({ t: 'join', code, name: savedName(), color: prefColor(), password });
}

// "Update the app" (native) / "Reload" (web) when the server says this build is too old.
function showOutdated(msg) {
  lobbyUI.hide();
  chat.setEnabled(false);
  online.room = null;
  online.rejoin = null;
  setRoomInUrl(null);
  if (online.playing || mode === 'play') enterTitle(false);
  ui.hideTitle();
  ui.showNotice({
    title: 'UPDATE TIME',
    text: msg || 'A new version of Run Kitty Run is out — update to keep playing online.',
    button: NATIVE ? 'UPDATE' : 'RELOAD',
    onClick: () => (NATIVE ? openExternal(storeUrl()) : location.reload()),
    alt: 'PLAY SOLO',
    onAlt: () => { ui.hideNotice(); ui.showTitle(onTitlePick); },
  });
}
net.on('outdated', (m) => showOutdated(m.msg));

net.on('lobbies', (m) => lobbyUI.setLobbies(m.list));
net.on('error', (m) => {
  if (m.need === 'password' && lobbyUI.isOpen()) lobbyUI.askPassword(m.code); // a private lobby (list, code or invite link)
  if (lobbyUI.isOpen()) lobbyUI.showError(m.msg);
  else ui.toast(m.msg, 0xff8fa3);
  if (/code/.test(m.msg)) setRoomInUrl(null);
});
net.on('room', (m) => {
  if (!online.room || online.room.code !== m.code) chat.clear();
  online.room = m;
  online.me = m.you;
  online.pass = m.pass || '';   // a private lobby's password: sent again when we rejoin after a dropped connection
  chat.setEnabled(true);
  for (const mem of m.members) online.roster.set(mem.id, mem);
  setRoomInUrl(m.code, m.locked ? m.pass : '');
  if (!online.playing || mode !== 'play') lobbyUI.showRoom(m);
  else if (m.phase === 'lobby' && victory) victory.lobbyAt = victory.t; // the party is over on the server: head back soon
});
net.on('left', () => { online.room = null; chat.setEnabled(false); setRoomInUrl(null); if (online.playing) enterTitle(false); lobbyUI.showBrowser(); });
net.on('open', () => {
  // back after a dropped connection (or the app was in the background): rejoin the same lobby
  const code = online.rejoin;
  online.rejoin = null;
  if (code && !online.room) net.send({ t: 'join', code, name: savedName(), color: prefColor(), password: online.pass || '' });
  net.send({ t: 'legends' }); // a winner still in its signing window (same tab, even after a reload) gets the board back
});
net.on('close', () => {
  if (online.room) online.rejoin = online.room.code;
  online.room = null;
  chat.setEnabled(false);
  if (online.playing) enterTitle(false);
  ui.hideGameOver();
  ui.hideVictory();
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

// Desync tripwire: the server sends its level's hash (start message, levelStart events); a client that generated the
// level differently (e.g. a float op that differs between JS engines) reports it. No fallback: wolf resyncs still apply.
function checkLevelHash(level, lh) {
  if (lh == null || !sim || sim.level !== level || !sim.levelData) return;
  const mine = levelHash(sim.levelData);
  if (mine === lh) return;
  console.warn(`level ${level} (${sim.mode}) generated differently from the server: hash ${mine} vs ${lh}`);
  analytics.levelMismatch(sim.mode, level, APP_VERSION);
}

function leadTicks() { return Math.ceil(net.rtt / 2 / (CFG.TICK * 1000)) + NET.INPUT_LEAD; }

function beginOnlineGame(m) {
  lobbyUI.hide();
  if (m.st !== 'victory') legends.reset();
  ui.hideTitle();
  ui.hideGameOver();
  ui.hideVictory();
  ui.hidePause();
  audio.unlock();
  online.menu = false;
  mode = 'play';
  paused = false;
  for (const p of m.players) online.roster.set(p.id, { ...online.roster.get(p.id), ...p });   // (keeps the room's paid totals)
  playerCount = m.players.length;
  removeKitties();
  sim = createSim({ seed: m.seed, players: m.players, startLevel: m.level, mode: m.mode, finales: +m.rf || 0 });
  analytics.runStart('online', m.mode || 'mixed');
  sim.started = true;
  if (m.it) { const taken = new Set(m.it); for (const it of sim.items) it.taken = taken.has(it.id); } // joined mid-level
  sim.crownTaken = !!m.ct;
  gameOverShown = false;
  victory = null;
  intro = null;
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
  checkLevelHash(sim.level, m.lh);
  handleEvents([{ type: 'levelStart', level: sim.level }]);
  // joined mid-game: checkpoints already reached (a repaired medic checkpoint shows repaired)
  if (Array.isArray(m.cp)) {
    sim.checkpointsHit = m.cp.slice();
    for (const i of m.cp) if (sim.levelData.checkpoints && sim.levelData.checkpoints[i] && sim.levelData.checkpoints[i].medic && view) view.world.repairCheckpoint(i);
  }
  // joined (or reconnected) after the final run was won: the stored victory event won't come again
  if (m.st === 'victory') {
    sim.state = 'victory';
    intro = null;
    startVictory(m.vic || null);
  }
}

function backToLobby() {
  if (online.menu) { online.menu = false; ui.hidePause(); }
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

// Step local wolves up to the level tick matching our current tick, remembering recent positions. Far behind (back
// from the background, a late level change): don't replay it all (seconds of frozen game on a big level), ask the
// server for its wolves instead; they wait where they are until the reply ('wolves') catches them up.
const WOLF_CATCHUP_MAX = 300;   // ticks (5 s)
function catchUpWolves() {
  const target = online.tick - online.levelStartTick;
  if (target - sim.enemyTicks > WOLF_CATCHUP_MAX) {
    const now = performance.now();
    if (net.connected && now > online.resyncAt) { online.resyncAt = now + 2000; net.send({ t: 'resync' }); }
    return;
  }
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
    const i = sim.enemies[id] && sim.enemies[id].id === id ? id : sim.enemies.findIndex((e) => e.id === id);
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
  const q = { x: Math.round(inp.x * 1000) / 1000, z: Math.round(inp.z * 1000) / 1000, m: audio.isMuted() ? 0 : 1 };   // m: CFG.MUSIC_BOOST
  online.inputs.set(t, q);
  online.inputs.delete(t - 240);
  net.send({ t: 'in', k: t, x: q.x, z: q.z, m: q.m });

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

  sim.lastWinner = m.lw || 0;
  sim.crownTaken = !!m.ct;
  sim.state = m.st;
  sim.time = m.tm + (online.tick - m.k) * CFG.TICK;
  sim.stats = m.s;
  const taken = new Set(m.it);
  for (const it of sim.items) it.taken = taken.has(it.id);
  sim.circles = m.c.map(([playerId, x, z, t]) => ({ playerId, x, z, t }));

  const seen = new Set();
  let rosterChanged = false;
  for (const a of m.p) {
    const [id, x, z, vx, vz, heading, alive, inC, lives, speedMult, invuln, shield, deaths, rescues, margin, finishes = 0, waitRelease, crowned = 0, bonus = 0] = a;
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
    Object.assign(p, { vx, vz, heading, alive: !!alive, inCenter: !!inC, lives, speedMult, invuln, shield, deaths, rescues, finishes, crowned: !!crowned, bonus });
    p.moving = Math.hypot(vx, vz) > 0.5;
    if (id === online.me) {
      p.x = x; p.z = z;
      if (waitRelease !== undefined) p.waitRelease = !!waitRelease;
      // replay inputs the server hasn't processed yet
      for (let t = m.k + 1; t <= online.tick; t++) predictPlayer(sim, p, online.inputs.get(t) || null, CFG.TICK);
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
    checkLevelHash(e.level, e.lh);
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
  framePads = navigator.getGamepads ? navigator.getGamepads() : [];
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
          inputs[p.id] = { ...(i === mi ? mouseInput(p, kb) : kb), m: audio.isMuted() ? 0 : 1 };   // m: CFG.MUSIC_BOOST
        });
        if (window.__bot) Object.assign(inputs, window.__bot(sim));
      }
      const events = stepSim(sim, inputs, CFG.TICK);
      if (mode === 'play') { handleEvents(events); account.noteLocal(sim, events); }   // solo / local stats (account.js)
      else if (events.some((e) => e.type === 'levelStart')) { pregenNext(sim); buildView(); }
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
      if (online.menu) { online.menu = false; ui.hidePause(); }   // the game-over card replaces the online menu
      ui.showGameOver({
        level: sim.levelData.level || sim.level, deaths: sim.stats.deaths, rescues: sim.stats.rescues,
        time: sim.time,
        // alone: nobody could revive you; nudge toward friends
        alone: sim.players.length === 1 ? (wasOnline ? 'online' : 'solo') : null,
      }, () => { ui.hideGameOver(); if (wasOnline) backToLobby(); else startGame(playerCount); }, wasOnline ? 'BACK TO LOBBY' : null,
      // LEAVE GAME: offline back to the title, online out of the lobby (to the lobby list)
      () => { if (wasOnline) net.send({ t: 'leave' }); else enterTitle(); });
    }, 1400);
  }

  const vdt = running ? dt : 0;
  updateVictory(vdt);
  updateIntro(vdt);
  pollPadNav();
  if (track.volume < 0.5) track.volume = Math.min(0.5, track.volume + dt * 0.15); // musicFadeIn
  syncVisuals(vdt, alpha);
  updateTargetMarker(vdt);
  effects.update(vdt);
  updateCamera(dt, alpha);
  updateWatchLabel();
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
    ui.updateMinimap(sim.levelData, sim, online.playing ? online.me : null);
  }

  setKeepAwake(mode === 'play' && !paused && sim.state !== 'gameover');
  if (!(warmHoldUntil && performance.now() < warmHoldUntil)) renderer.render(scene, camera);   // (not while shaders compile)
  hideSplash(); // after the first rendered frame
}

// ---------- app / platform glue ----------
// Light tap on buttons (apps only; haptic() is a no-op on the web).
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('button, .rkr-mute, .rkr-hudbtn, .rkr-menubtn, .rkl-lob')) haptic('light');
}, true);

// Background / foreground (web tab hidden / page hidden, or app backgrounded): silence the
// soundtrack and suspend the audio context; back in front wake both up again (respecting mute)
// and make sure the socket is alive. Apps also pause a local run. visibilitychange, pagehide and
// appStateChange can all fire for one transition; the inBackground guard makes that a no-op.
function setBackground(bg) {
  if (bg === inBackground) return;
  inBackground = bg;
  if (bg) {
    releaseAllInput();
    touchId = null; joy.on = false; drawJoy();
    track.pause();
    audio.setBackground(true);
    if (NATIVE && mode === 'play' && !online.playing && !paused && sim.state === 'playing') togglePause();
  } else {
    audio.setBackground(false);
    syncTrack();
    net.wake();
    if (online.playing && net.connected) net.send({ t: 'resync' });
  }
}
document.addEventListener('visibilitychange', () => setBackground(document.visibilityState === 'hidden'));
window.addEventListener('pagehide', () => setBackground(true));
window.addEventListener('pageshow', (e) => { if (e.persisted && document.visibilityState === 'visible') setBackground(false); });
const App = plugin('App');
if (App) {
  App.addListener('appStateChange', (st) => setBackground(!st.isActive));
  App.addListener('backButton', onBackButton);
  App.addListener('appUrlOpen', (e) => joinFromLink(roomFromLink(e && e.url), passFromLink(e && e.url)));
  call('App', 'getLaunchUrl').then((r) => { if (r && r.url) joinFromLink(roomFromLink(r.url), passFromLink(r.url)); });
}

// Android back: close the top-most thing; on the title screen, minimize the app.
function onBackButton() {
  if (feedback.isOpen()) { feedback.close(); return; }
  if (legends.isOpen()) { legends.close(); return; }
  if (chat.isOpen()) { chat.close(); return; }
  const terms = document.querySelector('.rkt-modal .rkr-alt'); // terms.js notice: "Not now"
  if (terms) { terms.click(); return; }
  if (ui.isNoticeOpen()) { ui.hideNotice(); if (!ui.isTitleOpen()) ui.showTitle(onTitlePick); return; }
  if (mode === 'play') {
    if (ui.isGameOverOpen()) { ui.hideGameOver(); if (online.playing) backToLobby(); else enterTitle(); return; }
    if (ui.isVictoryOpen()) { ui.hideVictory(); if (online.playing) backToLobby(); else enterTitle(); return; }
    if (online.playing && online.menu) { online.menu = false; ui.hidePause(); net.send({ t: 'leave' }); } // = LEAVE GAME
    else if (online.playing) toggleOnlineMenu();
    else if (paused) { ui.hidePause(); enterTitle(); } // back on the pause menu = quit the run
    else togglePause();
    return;
  }
  if (lobbyUI.isOpen()) {
    if (lobbyUI.view() === 'room') net.send({ t: 'leave' });
    else leaveOnline();
    return;
  }
  if (ui.isTitleOpen()) { call('App', 'minimizeApp'); return; }
  enterTitle();
}

// Invite links: https://<server>/?room=ABCD (universal / app links) and runkittyrun://join?room=ABCD
function roomFromLink(url) {
  const m = /[?&]room=([A-Za-z0-9]{4,8})/.exec(url || '');
  return m ? m[1].toUpperCase() : null;
}
let lastLink = '', lastLinkAt = 0;
function joinFromLink(code, pass = '') {
  if (!code) return;
  const now = performance.now();
  if (code === lastLink && now - lastLinkAt < 3000) return; // launch URL + appUrlOpen can both fire
  lastLink = code; lastLinkAt = now;
  if (online.room && online.room.code === code) return;
  feedback.close();
  chat.close();
  ui.hideNotice();
  if (online.room) net.send({ t: 'leave' });
  if (mode === 'play') enterTitle(false); // a link wins over a local run
  online.menu = false;
  ui.hidePause();
  ui.hideGameOver();
  ui.hideTitle();
  setRoomInUrl(code, pass);
  openOnline(code, pass);
}

enterTitle();
if (params.has('stats')) openStatsPage(document.getElementById('ui')); // shareable link straight to the STATS page
if (params.get('room')) { ui.hideTitle(); openOnline(); }
requestAnimationFrame(frame);

// Debug handle
window.__kitty = {
  get sim() { return sim; }, get view() { return view; }, scene, camera, renderer, effects, audio, ui, startGame, keys, online, net, track,
  advance(seconds) { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) tick(1 / 60); },
};

analytics.visit();
