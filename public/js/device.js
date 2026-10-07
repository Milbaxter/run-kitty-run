// Device profile: touch phones/tablets get touch controls, a lighter renderer and a minimal HUD.
import { NATIVE, PLATFORM, call } from './platform.js';

const params = new URLSearchParams(location.search);
const forced = params.get('mobile');
const TOUCH = forced != null
  ? forced !== '0'
  : detectTouch();

// Phones / tablets: primary pointer is coarse, or touch points with no fine pointer at all (iPad).
// Touchscreen laptops have touch points AND a mouse/trackpad (any-pointer: fine) -> desktop profile.
function detectTouch() {
  const mm = (q) => !!(window.matchMedia && matchMedia(q).matches);
  return mm('(pointer: coarse)') || ((navigator.maxTouchPoints || 0) > 1 && !mm('(any-pointer: fine)'));
}

// Weak computers get the phone renderer too: few cores / little memory, a software or old Intel HD GPU, or a run that
// already had to drop to the lowest resolution here before (main.js remembers that in 'rkr-lowgfx'). ?gfx=low / ?gfx=high
// force it either way (high also forgets the remembered drop). Looks only: gameplay is the same on every tier.
const gfx = params.get('gfx');
if (gfx === 'high') { try { localStorage.removeItem('rkr-lowgfx'); } catch { /* ignore */ } }
const LOW_GFX = TOUCH || (gfx ? gfx === 'low' : weakDevice());
function weakDevice() {
  try { if (localStorage.getItem('rkr-lowgfx') === '1') return true; } catch { /* ignore */ }
  if ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4) return true;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (gl) gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|Software|Basic Render|Intel.*HD Graphics/i.test(name);
  } catch { return false; }
}

// shadows: off for everyone for now (the shadow pass drew the scene a second time every frame)
const QUALITY = LOW_GFX
  ? { pixelRatio: 1.5, antialias: false, shadows: false, shadowMap: 1024, softShadows: false, propShadows: false, particles: 0.45, low: true }
  : { pixelRatio: 2, antialias: true, shadows: false, shadowMap: 2048, softShadows: true, propShadows: true, particles: 1, low: false };

const root = document.documentElement;
if (TOUCH) root.classList.add('rkr-touch');
if (NATIVE) root.classList.add('rkr-native', 'rkr-' + PLATFORM);

// Touch devices (and the apps): no long-press menus, no pinch / double-tap zoom.
// Text fields keep their normal behaviour (select, paste).
if (TOUCH || NATIVE) {
  const editable = (t) => t && t.closest && t.closest('input, textarea, [contenteditable]');
  document.addEventListener('contextmenu', (e) => { if (!editable(e.target)) e.preventDefault(); });
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('dblclick', (e) => { if (!editable(e.target)) e.preventDefault(); });
}

if (NATIVE) call('StatusBar', 'hide');

// Android Chrome & co: fullscreen + landscape lock on a user gesture. iOS Safari can't do either
// for web pages (we show a "rotate your phone" hint instead). The apps are locked to landscape natively.
function goFullscreenLandscape() {
  if (!TOUCH || NATIVE) return;
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req || document.fullscreenElement || document.webkitFullscreenElement) return;
  try {
    const p = req.call(el, { navigationUI: 'hide' });
    if (p && p.then) p.then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {})).catch(() => {});
  } catch { /* not allowed */ }
}

// Keep the screen on while a run is going (apps only); let it sleep on menus.
let awake = null;
function setKeepAwake(on) {
  if (!NATIVE || awake === on) return;
  awake = on;
  call('KeepAwake', on ? 'keepAwake' : 'allowSleep');
}

let splashDone = false;
function hideSplash() {
  if (splashDone) return;
  splashDone = true;
  if (NATIVE) call('SplashScreen', 'hide', { fadeOutDuration: 250 });
}

export { TOUCH, QUALITY, NATIVE, goFullscreenLandscape, setKeepAwake, hideSplash };
