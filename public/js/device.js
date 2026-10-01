// Device profile: touch phones/tablets get touch controls, a lighter renderer and a minimal HUD.
const params = new URLSearchParams(location.search);
const forced = params.get('mobile');
const TOUCH = forced != null
  ? forced !== '0'
  : (window.matchMedia && matchMedia('(pointer: coarse)').matches) || (navigator.maxTouchPoints || 0) > 1;

const QUALITY = TOUCH
  ? { pixelRatio: 1.5, antialias: false, bloom: false, shadowMap: 1024, particles: 0.45 }
  : { pixelRatio: 2, antialias: true, bloom: true, shadowMap: 2048, particles: 1 };

if (TOUCH) document.documentElement.classList.add('rkr-touch');

// Android Chrome & co: fullscreen + landscape lock on a user gesture. iOS Safari can't do either
// for web pages (we show a "rotate your phone" hint instead).
function goFullscreenLandscape() {
  if (!TOUCH) return;
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req || document.fullscreenElement || document.webkitFullscreenElement) return;
  try {
    const p = req.call(el, { navigationUI: 'hide' });
    if (p && p.then) p.then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {})).catch(() => {});
  } catch { /* not allowed */ }
}

export { TOUCH, QUALITY, goFullscreenLandscape };
