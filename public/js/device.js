// Device profile: touch phones/tablets get touch controls, a lighter renderer and a minimal HUD.
import { NATIVE, PLATFORM, call } from './platform.js';

const params = new URLSearchParams(location.search);
const forced = params.get('mobile');
const TOUCH = forced != null
  ? forced !== '0'
  : (window.matchMedia && matchMedia('(pointer: coarse)').matches) || (navigator.maxTouchPoints || 0) > 1;

const QUALITY = TOUCH
  ? { pixelRatio: 1.5, antialias: false, bloom: false, shadowMap: 1024, particles: 0.45 }
  : { pixelRatio: 2, antialias: true, bloom: true, shadowMap: 2048, particles: 1 };

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
