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

// Graphics quality: the player's pick in the settings (settings.js) or 'auto' (phones and tablets get medium,
// everything else high). Looks only: the game plays the same on every one. setQuality() switches it live (main.js
// applies it); only antialiasing is fixed when the page loads.
const PROFILES = {
  high: { pixelRatio: 2, antialias: true, shadows: true, shadowMap: 2048, softShadows: true, propShadows: true, particles: 1 },
  medium: { pixelRatio: 1.5, antialias: false, shadows: true, shadowMap: 1024, softShadows: false, propShadows: false, particles: 0.45 },
  low: { pixelRatio: 1, antialias: false, shadows: false, shadowMap: 1024, softShadows: false, propShadows: false, particles: 0.3 },
  // the most speed for weak computers: drawn at 60% of the screen's resolution (scaled up), no weather, fewest effects
  ultra: { pixelRatio: 0.6, antialias: false, shadows: false, shadowMap: 1024, softShadows: false, propShadows: false, particles: 0 },
};
let gfxPick = 'auto';
try { gfxPick = (JSON.parse(localStorage.getItem('rkr-settings') || '{}') || {}).gfx || 'auto'; } catch { /* auto */ }
// 'auto' on a computer: high, unless it looks weak. A software renderer or an old Intel HD GPU gets low (the shadow
// pass and the 2x resolution are what make those stutter); few cores or little memory gets medium. The player's own
// pick in the settings always wins over this.
const WEAK = TOUCH ? null : weakDevice();
function weakDevice() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (gl) { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
    if (/SwiftShader|llvmpipe|Software|Basic Render|Intel.*HD Graphics/i.test(name)) return 'low';
  } catch { /* no WebGL info: judge by the rest */ }
  if ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4) return 'medium';
  return null;
}
const profileFor = (pick) => PROFILES[pick] || (TOUCH ? PROFILES.medium : PROFILES[WEAK] || PROFILES.high);
const QUALITY = { ...profileFor(gfxPick) };
function setQuality(pick) { Object.assign(QUALITY, profileFor(pick), { antialias: QUALITY.antialias }); return profileFor(pick).antialias; }

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

export { TOUCH, QUALITY, NATIVE, setQuality, goFullscreenLandscape, setKeepAwake, hideSplash };
