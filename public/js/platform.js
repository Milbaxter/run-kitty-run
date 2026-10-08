// Platform layer: web browser vs. the Capacitor iOS / Android apps (which load these same files from
// capacitor://localhost or https://localhost and play on the production server).
// Native plugins are reached through window.Capacitor.Plugins (no bundler) and always guarded.

const CAP = window.Capacitor;
const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
const PLATFORM = NATIVE ? (CAP.getPlatform && CAP.getPlatform()) || 'web' : 'web';
const APP_VERSION = '1.0.0';
const PROD_ORIGIN = 'https://80-47-225-25.nip.io';
const STORE_URLS = {
  ios: 'https://apps.apple.com/app/id6820576828',
  android: 'https://play.google.com/store/apps/details?id=io.runkittyrun.app',
};

function originFromWs(ws) {
  try {
    const u = new URL(ws);
    if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.hash) return null;
    return (u.protocol === 'wss:' ? 'https:' : 'http:') + '//' + u.host;
  } catch { return null; }
}

// Custom servers are a development feature, never a setting an invite link can change on the public site.
// Keep loopback, LAN testing and locally bundled native apps working (see docs/MOBILE.md).
function localHost(host) {
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    && (octets[0] === 10 || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
}
const serverParam = new URLSearchParams(location.search).get('server');
const SERVER_PARAM = (location.protocol === 'file:' || localHost(location.hostname))
  && originFromWs(serverParam) ? serverParam : null;

// Account credentials always belong to the page's own server, independently of any game-server override.
// Development only (like ?server=): a local page or a locally bundled app may use a local account server
// (?account=http://127.0.0.1:8080), never anything but a local address.
const accountParam = (() => {
  if (!(location.protocol === 'file:' || localHost(location.hostname))) return null;
  try {
    const u = new URL(new URLSearchParams(location.search).get('account') || '');
    return ['http:', 'https:'].includes(u.protocol) && localHost(u.hostname) && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
})();
const ACCOUNT_ORIGIN = accountParam || (NATIVE ? PROD_ORIGIN : location.protocol === 'file:' ? 'http://localhost:8080' : location.origin);
const SERVER_ORIGIN = (SERVER_PARAM && originFromWs(SERVER_PARAM))
  || ACCOUNT_ORIGIN;

function accountApiUrl(path) {
  return ACCOUNT_ORIGIN + (path.startsWith('/') ? path : '/' + path);
}

function accountSocketTrusted(url) {
  try { return new URL(url).href === new URL('/ws', ACCOUNT_ORIGIN.replace(/^http/, 'ws')).href; }
  catch { return false; }
}

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
  apiUrl, accountApiUrl, accountSocketTrusted, wsUrl, haptic, share, inviteUrl, plugin, call, openExternal, storeUrl,
};
