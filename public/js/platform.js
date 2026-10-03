// Platform layer: web browser vs. the Capacitor iOS / Android apps (which load these same files from
// capacitor://localhost or https://localhost and play on the production server).
// Native plugins are reached through window.Capacitor.Plugins (no bundler) and always guarded.

const CAP = window.Capacitor;
const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
const PLATFORM = NATIVE ? (CAP.getPlatform && CAP.getPlatform()) || 'web' : 'web';
const APP_VERSION = '1.0.0';
const PROD_ORIGIN = 'https://80-47-225-25.nip.io';
const STORE_URLS = {
  ios: 'https://apps.apple.com/app/idTODO',
  android: 'https://play.google.com/store/apps/details?id=io.runkittyrun.app',
};

// `?server=ws://host:port/ws` points the game at another server (dev / testing), on web and in the app.
const SERVER_PARAM = new URLSearchParams(location.search).get('server');

function originFromWs(ws) {
  try {
    const u = new URL(ws);
    return (u.protocol === 'wss:' ? 'https:' : 'http:') + '//' + u.host;
  } catch { return null; }
}

const SERVER_ORIGIN = (SERVER_PARAM && originFromWs(SERVER_PARAM))
  || (NATIVE ? PROD_ORIGIN : location.protocol === 'file:' ? 'http://localhost:8080' : location.origin);

function apiUrl(path) {
  // web on the game's own server keeps relative URLs (works under a sub-path too)
  if (!NATIVE && !SERVER_PARAM && location.protocol !== 'file:') return path.replace(/^\//, '');
  return SERVER_ORIGIN + (path.startsWith('/') ? path : '/' + path);
}

function wsUrl() {
  if (SERVER_PARAM) return SERVER_PARAM;
  if (!NATIVE && location.protocol !== 'file:') {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }
  return SERVER_ORIGIN.replace(/^http/, 'ws') + '/ws';
}

// Link that friends open: the web game (or the app, via universal / app links) straight into the lobby.
// pass: a private lobby's password, carried after '#' (stays on the device: never sent to the server with the page
// request) so the link joins without typing it (main.js passFromLink)
function inviteUrl(code, pass) {
  const base = NATIVE || location.protocol === 'file:' ? SERVER_ORIGIN + '/' : location.origin + location.pathname;
  return base + '?room=' + encodeURIComponent(code) + (pass ? '#pw=' + encodeURIComponent(pass) : '');
}

function plugin(name) {
  return (NATIVE && CAP.Plugins && CAP.Plugins[name]) || null;
}

// Fire-and-forget plugin call; never throws, never rejects.
function call(name, method, arg) {
  const p = plugin(name);
  if (!p || typeof p[method] !== 'function') return Promise.resolve(null);
  try { return Promise.resolve(p[method](arg)).catch(() => null); } catch { return Promise.resolve(null); }
}

// Haptics (apps only). Throttled so bursts of events never turn into a buzz.
const HAPTIC_GAP = { light: 90, medium: 160, heavy: 250, success: 400, error: 400 };
const RANK = { light: 0, medium: 1, heavy: 2, success: 2, error: 3 };
let hapticAt = 0, hapticRank = -1;
function haptic(kind = 'light') {
  if (!NATIVE || !(kind in HAPTIC_GAP)) return;
  const now = performance.now();
  // a stronger buzz may cut in right after a weaker one; never the other way round
  if (now < hapticAt && RANK[kind] <= hapticRank) return;
  hapticAt = now + HAPTIC_GAP[kind];
  hapticRank = RANK[kind];
  if (kind === 'success' || kind === 'error') call('Haptics', 'notification', { type: kind.toUpperCase() });
  else call('Haptics', 'impact', { style: kind.toUpperCase() });
}

const COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);

// Native share sheet in the app, Web Share on phones, clipboard on desktop.
// Resolves 'shared' | 'copied' | 'cancelled' | 'failed'.
async function share({ title, text, url }) {
  if (plugin('Share')) {
    try { await CAP.Plugins.Share.share({ title, text, url, dialogTitle: title }); return 'shared'; } catch { return 'cancelled'; }
  }
  if (navigator.share && COARSE) {
    try { await navigator.share({ title, text, url }); return 'shared'; } catch (e) { return e && e.name === 'AbortError' ? 'cancelled' : copy(); }
  }
  return copy();
  async function copy() {
    try { await navigator.clipboard.writeText(url || text); return 'copied'; } catch { return 'failed'; }
  }
}

// Open a page outside the game (system browser in the app, new tab on web).
function openExternal(url) {
  if (plugin('Browser')) { call('Browser', 'open', { url }); return; }
  window.open(url, '_blank', 'noopener');
}

function storeUrl() { return STORE_URLS[PLATFORM] || STORE_URLS.android; }

export {
  NATIVE, PLATFORM, APP_VERSION, SERVER_ORIGIN, PROD_ORIGIN, STORE_URLS,
  apiUrl, wsUrl, haptic, share, inviteUrl, plugin, call, openExternal, storeUrl,
};
