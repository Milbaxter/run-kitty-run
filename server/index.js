// Run Kitty Run online server: serves the static client and runs authoritative lobbies over WebSockets.
// One Room = one lobby (max NET.MAX_PLAYERS). The first player in the lobby is its host and decides when to start.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CFG, NET, PLAYER_COLORS, PLAYER_NAMES, SKATE_FINAL_LEVEL } from '../public/js/shared/config.js';
import { hashSeed } from '../public/js/shared/rng.js';
import { GAME_MODES, createSim, stepSim, addPlayer, removePlayer } from '../public/js/shared/sim.js';
import { serializeEnemies } from '../public/js/shared/enemies.js';
import { levelHash, collideCircle } from '../public/js/shared/maze.js';
import { createStats } from './stats.js';
import { createLegends } from './legends.js';
import { pregenNext } from './levelgen.js';

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const GAMEOVER_TO_LOBBY_MS = 4000;
// Skate only final run won (sim state 'victory'): keep the room stepping and snapshotting for the party, then lobby.
const VICTORY_TO_LOBBY_MS = 12000;
// Client protocol versions (sent in the client's first 'hi' message, see net.js; clients that never send one
// count as 0). Bump a mode's floor when the shared sim changes so that an older client would desync there.
// Older clients can still play the other modes; they can't create or join these lobbies and don't see them listed.
//   2 = Skate only wolves walk deterministic patterns (protocol-1 clients simulate random wanderers)
//   3 = Skate only level 8 (SKATE_FINAL_LEVEL) is the final run and clearing it wins (older clients build the spiral)
//   4 = slim wolf resync format, used by every mode (with MIN_PROTOCOL 4 this only still matters for clients without 'hi')
const MODE_MIN_PROTOCOL = { ice: 4, mixed: 4, run: 4 };
// Finale versions (sim.finales, see maze.js generateLevel): the protocol each needs. A room plays the newest version
// every member has (older clients would build the older level 9 and desync); once it plays one, older clients can't
// join it mid-game.
const FINALE_PROTOCOL = [0, 5, 6, 7];   // 1 = Run only's level 9 final run, 2 = the wide skate final run, 3 = Run + Skate's both in a row
const finalesOf = (members) => Math.min(...members.map((m) => FINALE_PROTOCOL.filter((p) => m.v >= p).length - 1));
const runFinaleOk = (client, room) => !(room.phase === 'playing' && room.sim) || client.v >= FINALE_PROTOCOL[room.sim.finales | 0];
const modeOk = (client, mode) => client.v >= (MODE_MIN_PROTOCOL[mode] || 0);
const MODE_NAMES = { mixed: 'Default (Run + Skate)', run: 'Run only', ice: 'Skate only' };
const updateHow = (client) => (client.app === 'web' ? 'reload the page' : 'update the app');
const APPS = ['web', 'ios', 'android'];
// Test hooks (scripts/server-test.mjs): 'start' may pick a level and 'dbg' can drop a kitty in the goal.
// Never set this in production.
const TEST_HOOKS = process.env.RKR_TEST_HOOKS === '1';
// Player feedback is appended here as JSON lines (systemd gives the service /var/lib/run-kitty-run).
const FEEDBACK_FILE = process.env.FEEDBACK_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../feedback.jsonl');
const FEEDBACK_MAX = 1000;          // characters per message
const FEEDBACK_PER_HOUR = 6;        // per IP
const MAX_ROOMS = 200;
const FEEDBACK_FILE_MAX = 5 << 20;  // bytes; stop appending past this (someone has to read it)
// Abuse limits per connection / IP. MAX_CONN_PER_IP can be raised for local load tests (scripts/server-test.mjs opens ~35).
const MAX_CONN_PER_IP = +process.env.MAX_CONN_PER_IP || 10;
const MSG_RATE = 150, MSG_BURST = 300;   // any message; ~60 inputs/s + pings is normal play. Over it: disconnect
const LOBBY_RATE = 1, LOBBY_BURST = 5;   // create / join / leave / list / start
const LOBBY_MSGS = new Set(['create', 'join', 'leave', 'list', 'start']);
// A client that stops reading would make us buffer its messages forever. Snapshots are ~1-10 KB at 20 Hz,
// so 1 MB is many seconds behind: it can't play anyway, drop it (it reconnects).
const MAX_BUFFERED = 1 << 20;
// Reconnect grace: a kitty that drops out mid-game and comes back (same tab token) within this keeps its state.
const REJOIN_GRACE_MS = 60e3;
// Anonymous play stats (title screen STATS page) live next to the feedback file.
const stats = createStats(process.env.STATS_FILE || path.join(path.dirname(FEEDBACK_FILE), 'stats.json'));
// Legends board (online winners sign it; see legends.js), next to the feedback file too.
const legends = createLegends(process.env.LEGENDS_FILE || path.join(path.dirname(FEEDBACK_FILE), 'legends.json'));
const SIGN_RATE = 0.2, SIGN_BURST = 3;     // legends: sign / edit your line
const LEGENDS_RATE = 0.5, LEGENDS_BURST = 3; // legends: ask for the board again (after a reconnect)
// Oldest client protocol still accepted at all (see PROTOCOL_VERSION in shared/config.js). App store builds lag the
// web, so only raise this when old clients would really break; they get an 'outdated' notice instead of a broken game.
// (Per-mode floors are MODE_MIN_PROTOCOL above.)
const MIN_PROTOCOL = 4;   // 4: slim wolf resync format (every mode resyncs wolves; older clients would break)
// Player reports (only the store apps have a Report button) are appended here as JSON lines, next to the feedback file by default.
const REPORTS_FILE = process.env.REPORTS_FILE || path.join(path.dirname(FEEDBACK_FILE), 'reports.jsonl');
const REPORTS_PER_HOUR = 10;        // per connection
const REPORT_REASONS = ['spam', 'abuse', 'name', 'other'];
const CHAT_HISTORY = 10;            // recent lines kept per player, attached to reports
// App deep links (Universal Links / Android App Links); set on the server, see deploy/run-kitty-run.service.
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || 'TEAMID_PLACEHOLDER';
const ANDROID_CERT_SHA256 = (process.env.ANDROID_CERT_SHA256 || 'AA:BB:CC:PLACEHOLDER').split(',').map((s) => s.trim()).filter(Boolean);
const APP_ID = 'io.runkittyrun.app';
// The native apps load the client from these origins and call /api/* cross-origin.
const CORS_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);

// ---------------- static files ----------------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const WELL_KNOWN = {
  '/.well-known/apple-app-site-association': () => ({
    applinks: { details: [{ appIDs: [`${APPLE_TEAM_ID}.${APP_ID}`], components: [{ '/': '/', '?': { room: '*' } }] }] },
  }),
  '/.well-known/assetlinks.json': () => ([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: APP_ID, sha256_cert_fingerprints: ANDROID_CERT_SHA256 },
  }]),
};
const PAGES = { '/privacy': '/privacy.html', '/terms': '/terms.html', '/support': '/support.html' };

const server = http.createServer((req, res) => {
  try { handleHttp(req, res); } catch (err) {
    console.error('http handler failed:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// weak validator: size + mtime is enough for files that are only ever replaced by a deploy
const etagOf = (st) => `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
function notModified(req, st, etag) {
  const inm = req.headers['if-none-match'];
  if (inm) return inm.split(',').some((t) => { t = t.trim(); return t === '*' || t === etag || t === etag.slice(2); });
  const ims = Date.parse(req.headers['if-modified-since'] || '');
  return Number.isFinite(ims) && Math.floor(st.mtimeMs / 1000) * 1000 <= ims;
}

function handleHttp(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok'); return; }
  if (url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      }).end();
      return;
    }
    if (url.pathname === '/api/feedback') { handleFeedback(req, res); return; }
    if (url.pathname === '/api/legends') { handleLegends(req, res); return; }
    if (url.pathname === '/api/event' || url.pathname === '/api/stats') { stats.handle(req, res, clientIp(req), () => wss.clients.size); return; }
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"ok":false}');
    return;
  }
  if (WELL_KNOWN[url.pathname]) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify(WELL_KNOWN[url.pathname]()));
    return;
  }
  let p;
  try { p = decodeURIComponent(PAGES[url.pathname] || url.pathname); } catch { res.writeHead(400).end(); return; }
  if (p.includes('\0')) { res.writeHead(400).end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    // no-cache = revalidate every time, which the ETag makes a cheap 304 (vendor/ isn't versioned, so it gets the same)
    const etag = etagOf(st);
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/music/') ? 'public, max-age=86400' : 'no-cache',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
    };
    if ((req.method === 'GET' || req.method === 'HEAD') && notModified(req, st, etag)) {
      res.writeHead(304, { ETag: etag, 'Last-Modified': headers['Last-Modified'], 'Cache-Control': headers['Cache-Control'] }).end();
      return;
    }
    // Range requests: needed for seeking audio, and Safari won't play media without them.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? +m[1] : st.size - +m[2];
      let end = m[1] && m[2] ? +m[2] : st.size - 1;
      if (start < 0) start = 0;
      end = Math.min(end, st.size - 1);
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------- feedback ----------------
const feedbackHits = new Map(); // ip -> [timestamps]
setInterval(() => { const now = Date.now(); for (const [ip, h] of feedbackHits) if (!h.some((t) => now - t < 3600e3)) feedbackHits.delete(ip); }, 600e3).unref();

const isLoopback = (a) => a === '::1' || /^(::ffff:)?127\./.test(a || '');
function clientIp(req) {
  const ra = req.socket.remoteAddress || '?';
  // behind Caddy (same box, so loopback): the first X-Forwarded-For entry is the real client.
  // From anywhere else the header is whatever the client made up.
  if (!isLoopback(ra)) return ra;
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || ra;
}

function handleFeedback(req, res) {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST') return reply(405, { ok: false });
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (feedbackHits.get(ip) || []).filter((t) => now - t < 3600e3);
  feedbackHits.set(ip, hits);
  if (hits.length >= FEEDBACK_PER_HOUR) return reply(429, { ok: false, msg: 'Thanks! That is plenty of feedback for now.' });
  hits.push(now); // counted up front: junk and oversized bodies use up the allowance too
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', () => {
    let m;
    try { m = JSON.parse(body); } catch { return reply(400, { ok: false }); }
    if (!m || typeof m !== 'object') return reply(400, { ok: false });
    const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);
    const text = clean(m.text, FEEDBACK_MAX);
    if (text.length < 2) return reply(400, { ok: false, msg: 'Type a little more first.' });
    const entry = {
      at: new Date(now).toISOString(), text,
      name: clean(m.name, 20), mode: clean(m.mode, 12), app: clean(m.app, 8), ver: clean(m.ver, 16), level: Number.isFinite(m.level) ? m.level | 0 : null,
      ua: clean(req.headers['user-agent'], 160),
    };
    fs.stat(FEEDBACK_FILE, (e, st) => {
      if (!e && st.size > FEEDBACK_FILE_MAX) { console.error('feedback file full, dropping feedback'); return reply(503, { ok: false, msg: 'Feedback is full right now, try again later.' }); }
      fs.appendFile(FEEDBACK_FILE, JSON.stringify(entry) + '\n', (err) => {
        if (err) { console.error('feedback write failed:', err.message); return reply(500, { ok: false }); }
        reply(200, { ok: true });
      });
    });
  });
}

// ---------------- legends board ----------------
// Read-only board for offline winners (the client only asks after beating the final run: a soft gate).
const legendsHits = new Map(); // ip -> [timestamps]
setInterval(() => { const now = Date.now(); for (const [ip, h] of legendsHits) if (!h.some((t) => now - t < 60e3)) legendsHits.delete(ip); }, 600e3).unref();
const offlineSigns = new Map(); // ip -> [timestamps of offline wins put on the board]
const OFFLINE_WIN_EVERY_MS = 10 * 60e3;
setInterval(() => { const now = Date.now(); for (const [ip, h] of offlineSigns) if (!h.some((t) => now - t < OFFLINE_WIN_EVERY_MS)) offlineSigns.delete(ip); }, 600e3).unref();
function handleLegends(req, res) {
  if (req.method === 'POST') { handleOfflineSign(req, res); return; }
  if (req.method !== 'GET') { res.writeHead(405, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
  const ip = clientIp(req), now = Date.now();
  const hits = (legendsHits.get(ip) || []).filter((t) => now - t < 60e3);
  legendsHits.set(ip, hits);
  if (hits.length >= 20) { res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"ok":false}'); return; }
  hits.push(now);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(legends.boardJson());
}

// Offline (solo / local co-op) win: POST { mode, runTime, time, players: [{ name, color, text }] } puts it on the board
// (one per IP per 10 minutes) and returns { id, key }; POST { id, key, players: [{ text }] } edits the lines for 15 min.
function handleOfflineSign(req, res) {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const ip = clientIp(req), now = Date.now();
  const hits = (legendsHits.get(ip) || []).filter((t) => now - t < 60e3);
  legendsHits.set(ip, hits);
  if (hits.length >= 20) return reply(429, { ok: false, msg: 'Slow down a little!' });
  hits.push(now);
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => { try { offlineSign(); } catch (err) { console.error('legends sign failed:', err); if (!res.headersSent) reply(400, { ok: false }); } });
  function offlineSign() {
    let m;
    try { m = JSON.parse(body); } catch { return reply(400, { ok: false }); }
    if (!m || typeof m !== 'object') return reply(400, { ok: false });
    if (m.id) {
      const r = legends.editOffline(m);
      return r.err ? reply(403, { ok: false, msg: r.err }) : reply(200, { ok: true, win: r.win, left: r.left });
    }
    const bad = legends.checkOffline(m);
    if (bad) return reply(400, { ok: false, msg: bad });
    const recent = (offlineSigns.get(ip) || []).filter((t) => now - t < OFFLINE_WIN_EVERY_MS);
    if (recent.length >= 1) return reply(429, { ok: false, msg: 'One win on the board every 10 minutes, legend. Try again in a bit!' });
    offlineSigns.set(ip, [...recent, now]);
    const r = legends.createOffline(m);
    reply(200, { ok: true, id: r.win.id, key: r.key, win: r.win, left: r.left });
  }
}

// A room just won: everyone in it at this moment is on the board and may sign it; each gets the board right away.
function legendsOnWin(room, e) {
  legends.recordWin(room.mode, e.time, room.members);
  for (const m of room.members) { const b = legends.boardFor(m); if (b) send(m.ws, b); }
}

function handleSign(client, msg) {
  if (!take(client, 'sign', SIGN_RATE, SIGN_BURST, Date.now())) return send(client.ws, { t: 'signed', ok: false, msg: 'Slow down a little!' });
  const r = legends.sign(client, msg.text);
  if (r.err) return send(client.ws, { t: 'signed', ok: false, msg: r.err });
  send(client.ws, { t: 'signed', ok: true, id: r.win.id, text: r.entry.text });
  // everyone else on that legend who is online sees the line appear (only winners of that run, never bystanders)
  const s = JSON.stringify({ t: 'legend', win: r.win });
  for (const c of clients.values()) {
    if (c.ws.readyState !== 1) continue;
    const el = legends.eligibility(c);
    if (el && el.win === r.win) send(c.ws, s);
  }
}

// ---------------- rooms ----------------
const rooms = new Map(); // code -> Room
let nextClientId = 1;

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}

function cleanName(n, fallback) {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  return s || fallback;
}

// private lobbies: a short password (case-sensitive), '' = public
function cleanPass(p) {
  return String(p ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20);
}

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
  ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const m of room.members) send(m.ws, s);
}

function roomInfo(room) {
  return {
    t: 'room', code: room.code, host: room.hostId, phase: room.phase, mode: room.mode, max: room.max || NET.MAX_PLAYERS,
    locked: !!room.pass, pass: room.pass || undefined,   // private lobby: its members see the password (to pass it on)
    members: room.members.map((m) => ({ id: m.id, name: m.name, color: m.color, app: m.app })),
  };
}

function sendRoom(room) {
  const info = roomInfo(room);
  for (const m of room.members) send(m.ws, { ...info, you: m.id });
}

function lobbyList(client) {
  const list = [];
  for (const r of rooms.values()) {
    if (r.members.length === 0) continue;
    if (!modeOk(client, r.mode) || !runFinaleOk(client, r)) continue; // this client's build can't play that mode / game
    list.push({
      code: r.code, players: r.members.length, max: r.max || NET.MAX_PLAYERS, phase: r.phase, locked: !!r.pass,
      host: (r.members.find((m) => m.id === r.hostId) || r.members[0]).name,
      level: r.sim ? r.sim.level : 0, mode: r.mode,
    });
  }
  return list.sort((a, b) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || b.players - a.players).slice(0, 30);
}

function freeColorSlot(room) {
  for (let i = 0; i < NET.MAX_PLAYERS; i++) if (!room.members.some((m) => m.slot === i)) return i;
  return 0;
}

// The client's preferred colour (index into PLAYER_COLORS, sent with create / join) if no one in the lobby has it.
function colorSlot(room, pref) {
  const p = Number.isInteger(pref) && pref >= 0 && pref < Math.min(NET.MAX_PLAYERS, PLAYER_COLORS.length) ? pref : -1;
  return p >= 0 && !room.members.some((m) => m.slot === p) ? p : freeColorSlot(room);
}

function joinRoom(client, room, name, pref, pass) {
  // Covers every way in: lobby list, code, invite deep link, reconnect rejoin, mid-game join.
  // 'code' in the text makes clients drop ?room= from the URL so they don't retry the link.
  if (!modeOk(client, room.mode)) return send(client.ws, { t: 'error', msg: `That lobby code is for ${MODE_NAMES[room.mode]}, which needs the latest version - ${updateHow(client)} to play it.` });
  if (!runFinaleOk(client, room)) return send(client.ws, { t: 'error', msg: `That game is playing the new level 9 - ${updateHow(client)} to join it.` });
  const max = room.max || NET.MAX_PLAYERS;
  if (room.members.length >= max) return send(client.ws, { t: 'error', msg: `That lobby is full (${max}/${max}).` });
  // private lobby: the password, unless this is a kitty coming back within the reconnect grace (room.left)
  if (room.pass && cleanPass(pass) !== room.pass && !(client.tok && room.left && room.left.has(client.tok))) {
    return send(client.ws, { t: 'error', need: 'password', code: room.code, msg: pass ? 'Wrong password for that lobby.' : 'That lobby is private: enter its password.' });
  }
  leaveRoom(client);
  const slot = colorSlot(room, pref);
  client.room = room;
  client.slot = slot;
  client.name = cleanName(name, PLAYER_NAMES[slot]);
  client.color = PLAYER_COLORS[slot];
  client.inputs = new Map();
  client.lastInput = null; // nothing received yet
  client.margin = NET.INPUT_LEAD;
  room.members.push(client);
  if (!room.hostId) room.hostId = client.id;
  sendRoom(room);
  broadcast(room, { t: 'chat', sys: true, text: `${client.name} joined` });
  if (room.phase === 'playing') {
    // Join mid-game: spawn now; send full state (including wolves) so the newcomer is in sync.
    const p = addPlayer(room.sim, { id: client.id, name: client.name, color: client.color });
    restoreLeft(room, client, p);
    // Mid-victory: join the party in the goal room instead of starting alone at the far end of the final run.
    if (room.sim.state === 'victory') {
      const a = room.sim.players.length * 2.399963, r = 3.3;
      p.x = Math.cos(a) * r; p.z = Math.sin(a) * r; p.vx = 0; p.vz = 0;
      p.heading = Math.atan2(-p.z, -p.x);
      p.inCenter = true;
    }
    send(client.ws, startMsg(room, true));
  }
}

// ---- reconnect grace ----
// Someone who leaves a running game (dropped socket or LEAVE) and comes back within REJOIN_GRACE_MS gets their kitty
// back as it was: lives, deaths, rescues, crown... and a kitty that was down stays down (in its rescue circle) on the
// same level, so leaving and rejoining is not a free revive. Matched by the tab token from 'hi' (net.js); a downed
// kitty is also matched by IP, so a new tab / cleared storage doesn't dodge it either. Anyone else joining mid-game is
// a genuine drop-in and spawns alive with spawn invulnerability, as before (that is how friends join a running game).
function pruneLeft(room, now = Date.now()) {
  for (const [k, r] of room.left) if (now - r.at > REJOIN_GRACE_MS || r.sim !== room.sim) room.left.delete(k);
}

function rememberLeft(room, client) {
  const sim = room.sim;
  const p = sim && room.phase === 'playing' && sim.players.find((q) => q.id === client.id);
  if (!p) return;
  pruneLeft(room);
  const circ = sim.circles.find((c) => c.playerId === p.id);
  room.left.set(client.tok || `ip:${client.ip}#${client.id}`, {
    at: Date.now(), sim, level: sim.level, ip: client.ip,
    alive: p.alive, x: p.x, z: p.z, circleT: circ ? circ.t : 0,
    lives: p.lives, deaths: p.deaths, rescues: p.rescues, finishes: p.finishes, crowned: p.crowned, speedMult: p.speedMult,
  });
}

function restoreLeft(room, client, p) {
  if (!room.left) return;
  pruneLeft(room);
  let key = client.tok && room.left.has(client.tok) ? client.tok : null;
  if (!key) for (const [k, r] of room.left) if (!r.alive && r.ip === client.ip) { key = k; break; }
  if (!key) return;
  const r = room.left.get(key);
  room.left.delete(key);
  const sim = room.sim;
  Object.assign(p, { lives: r.lives, deaths: r.deaths, rescues: r.rescues, finishes: r.finishes, crowned: r.crowned, speedMult: r.speedMult });
  // a new level (or the victory party) revives everyone anyway
  if (!r.alive && r.level === sim.level && sim.state !== 'victory') {
    Object.assign(p, { alive: false, x: r.x, z: r.z, vx: 0, vz: 0, moving: false, inCenter: false, invuln: 0, shield: 0, speedMult: 1 });
    sim.circles.push({ playerId: p.id, x: r.x, z: r.z, t: r.circleT });
  }
}

function leaveRoom(client) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  room.members = room.members.filter((m) => m !== client);
  rememberLeft(room, client);
  if (room.sim) removePlayer(room.sim, client.id);
  if (room.members.length === 0) { rooms.delete(room.code); return; }
  if (room.hostId === client.id) room.hostId = room.members[0].id; // next in join order
  sendRoom(room);
  broadcast(room, { t: 'chat', sys: true, text: `${client.name} left` });
}

function startMsg(room, withWolves) {
  const sim = room.sim;
  return {
    t: 'start', seed: sim.seed, mode: sim.mode, level: sim.level, tick: room.tick, lt: sim.enemyTicks, rf: sim.finales | 0,
    st: sim.state, vic: room.victory || null, // mid-game joiners: the run may already be won (the 'victory' event went out before)
    players: sim.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    wolves: withWolves ? serializeEnemies(sim.enemies) : null,
    lh: levelHash(sim.levelData),   // level fingerprint: the client reports a mismatch (no fallback)
    it: sim.items.filter((i) => i.taken).map((i) => i.id), ct: sim.crownTaken ? 1 : 0, // mid-game joiners: already picked up
  };
}

function startGame(room, startLevel = 1) {
  stats.onlineGameStarted();
  room.phase = 'playing';
  room.tick = 0;
  room.pending = [];
  room.overAt = 0;
  room.victory = null;
  room.left = new Map();
  const seed = hashSeed(Date.now(), Math.random(), room.code) >>> 0;
  room.sim = createSim({
    seed, startLevel, mode: room.mode, finales: finalesOf(room.members),
    players: room.members.map((m) => ({ id: m.id, name: m.name, color: m.color })),
  });
  for (const m of room.members) { m.inputs.clear(); m.lastInput = null; }
  sendRoom(room);
  broadcast(room, startMsg(room, false));
}

// ---------------- simulation ----------------
function stepRoom(room) {
  const sim = room.sim;
  const k = room.tick + 1;
  const inputs = {};
  for (const m of room.members) {
    const inp = m.inputs.get(k);
    if (inp) m.lastInput = inp;
    inputs[m.id] = m.lastInput;
    for (const key of m.inputs.keys()) if (key <= k) m.inputs.delete(key);
    if (m.god !== undefined) { const p = sim.players.find((q) => q.id === m.id); if (p) p.god = m.god; } // dev: playtest godmode
  }
  const events = stepSim(sim, inputs, CFG.TICK);
  room.tick = k;
  for (const e of events) room.pending.push(e);
  for (const e of events) {
    if (e.type === 'levelStart') {
      e.lh = levelHash(sim.levelData);
      pregenNext(sim); // next level off the event loop (makeLevel picks it up)
    }
    else if (e.type === 'gameOver') room.overAt = Date.now() + GAMEOVER_TO_LOBBY_MS;
    else if (e.type === 'victory') {
      // final state: the sim keeps stepping (snapshots carry st 'victory') until the room goes back to the lobby
      room.victory = e;
      room.overAt = Date.now() + VICTORY_TO_LOBBY_MS;
      stats.onlineGameWon(room.mode);
      legendsOnWin(room, e);
    }
  }
  if (k % NET.SNAP_EVERY === 0 || events.length) sendSnapshot(room);
}

const r3 = (v) => Math.round(v * 1000) / 1000;

function sendSnapshot(room) {
  const sim = room.sim;
  const margins = new Map(room.members.map((m) => [m.id, m.margin]));
  broadcast(room, {
    t: 'snap', k: room.tick, lvl: sim.level, st: sim.state, lt: sim.enemyTicks, tm: r3(sim.time),
    // [id, x, z, vx, vz, heading, alive, inCenter, lives, speedMult, invuln, shield, deaths, rescues, inputMargin, finishes, waitRelease, crowned]
    p: sim.players.map((p) => [p.id, r3(p.x), r3(p.z), r3(p.vx), r3(p.vz), r3(p.heading), p.alive ? 1 : 0, p.inCenter ? 1 : 0,
      p.lives, r3(p.speedMult), r3(p.invuln), r3(p.shield), p.deaths, p.rescues, Math.round((margins.get(p.id) ?? 0) * 10) / 10, p.finishes || 0, p.waitRelease ? 1 : 0,
      p.crowned ? 1 : 0]),
    lw: sim.lastWinner || 0, ct: sim.crownTaken ? 1 : 0,
    it: sim.items.filter((i) => i.taken).map((i) => i.id),
    c: sim.circles.map((c) => [c.playerId, r3(c.x), r3(c.z), r3(c.t)]),
    s: sim.stats,
    ec: wolfCheck(sim),
    ev: room.pending,
  });
  room.pending = [];
}

// A few wolf positions per snapshot (rotating) so clients can detect a desynced local wolf sim.
function wolfCheck(sim) {
  const n = sim.enemies.length;
  if (!n) return [];
  const out = [];
  const start = (sim.enemyTicks * 7) % n;
  for (let i = 0; i < 8; i++) {
    const e = sim.enemies[(start + i * 29) % n];
    out.push([e.id, r3(e.x), r3(e.z)]);
  }
  return out;
}

let lastTime = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += (now - lastTime) / 1000;
  lastTime = now;
  if (acc > 0.25) acc = 0.25; // never spiral after a stall
  while (acc >= CFG.TICK) {
    acc -= CFG.TICK;
    for (const room of rooms.values()) {
      if (room.phase !== 'playing') continue;
      try { stepRoom(room); } catch (err) { roomCrashed(room, err); }
    }
  }
  for (const room of rooms.values()) {
    if (room.phase === 'playing' && room.overAt && Date.now() >= room.overAt) {
      room.phase = 'lobby';
      room.sim = null;
      room.victory = null;
      room.overAt = 0;
      sendRoom(room);
    }
  }
}, 1000 / 120);

// A sim bug in one room must not take the other rooms down: log it and send that room back to the lobby.
function roomCrashed(room, err) {
  console.error(`room ${room.code} step failed:`, err);
  room.phase = 'lobby'; room.sim = null; room.victory = null; room.overAt = 0; room.pending = []; room.left = new Map();
  try {
    sendRoom(room);
    broadcast(room, { t: 'chat', sys: true, text: 'Something went wrong — back to the lobby' });
  } catch (e) { console.error('room reset failed:', e); }
}

// ---------------- websocket ----------------
// Compress only big messages (the full wolf state for 'resync' / mid-game 'start'); snapshots go out as they are.
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 16 * 1024,
  perMessageDeflate: { threshold: 16384, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: true, clientNoContextTakeover: true },
});

const clients = new Map(); // id -> client (kept ~10 min after disconnect so late reports still work)
const connsPerIp = new Map(); // ip -> open sockets

// token bucket on client[key + 'Tok'] / [key + 'At']: true if a message may pass
function take(client, key, rate, burst, now) {
  const tok = Math.min(burst, (client[key + 'Tok'] ?? burst) + (now - (client[key + 'At'] ?? now)) / 1000 * rate);
  client[key + 'At'] = now;
  if (tok < 1) { client[key + 'Tok'] = tok; return false; }
  client[key + 'Tok'] = tok - 1;
  return true;
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const n = (connsPerIp.get(ip) || 0) + 1;
  if (n > MAX_CONN_PER_IP) { ws.close(1013, 'too many connections'); return; }
  connsPerIp.set(ip, n);
  stats.online(wss.clients.size);
  // v/app/ver/tok come from the client's 'hi' (sent before anything else); clients that never send one are old web tabs
  const client = { id: nextClientId++, ws, room: null, name: '', app: 'web', ver: '', hi: false, v: 0, tok: '', ip, chatLog: [], reportTimes: [] };
  clients.set(client.id, client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'hello', id: client.id });

  ws.on('message', (raw) => {
    if (!take(client, 'msg', MSG_RATE, MSG_BURST, Date.now())) { ws.terminate(); return; } // flooding: not a real client
    try { onMessage(raw); } catch (err) { console.error('ws message failed:', err); }
  });
  function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const room = client.room;
    if (LOBBY_MSGS.has(msg.t) && !take(client, 'lobby', LOBBY_RATE, LOBBY_BURST, Date.now())) {
      if (msg.t !== 'list') send(ws, { t: 'error', msg: 'Slow down a little!' });
      return;
    }
    switch (msg.t) {
      case 'hi': {
        const v = Number.isFinite(msg.v) ? msg.v : 0;
        client.hi = true;
        client.v = v;
        client.app = APPS.includes(msg.app) ? msg.app : 'web';
        client.ver = String(msg.ver ?? '').replace(/[^\w.+-]/g, '').slice(0, 16);
        if (typeof msg.tok === 'string' && /^[\w-]{8,64}$/.test(msg.tok)) client.tok = msg.tok; // reconnect grace (net.js)
        if (v < MIN_PROTOCOL) {
          send(ws, { t: 'outdated', msg: 'A new version of Run Kitty Run is out - update to keep playing online.' });
          ws.close(4000, 'outdated');
        }
        break;
      }
      case 'report':
        handleReport(client, msg);
        break;
      case 'sign':
        handleSign(client, msg);
        break;
      case 'legends': {
        // a winner asks for the board again (e.g. after a reconnect); nothing for anyone else
        if (!take(client, 'legends', LEGENDS_RATE, LEGENDS_BURST, Date.now())) return;
        const b = legends.boardFor(client);
        if (b) send(ws, b);
        break;
      }
      case 'list':
        send(ws, { t: 'lobbies', list: lobbyList(client) });
        break;
      case 'create': {
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Server is full, try again later.' });
        const mode = GAME_MODES.includes(msg.mode) ? msg.mode : 'mixed';
        if (!modeOk(client, mode)) return send(ws, { t: 'error', msg: `${MODE_NAMES[mode]} needs the latest version - ${updateHow(client)} to play it. The other modes work as usual.` });
        // max: how many kitties may join (2..NET.MAX_PLAYERS); pass: private lobby's password ('' = public)
        const maxReq = Number.isInteger(msg.max) ? msg.max : NET.MAX_PLAYERS;
        const r = { code: makeCode(), mode, max: Math.max(2, Math.min(NET.MAX_PLAYERS, maxReq)), pass: cleanPass(msg.password),
          members: [], hostId: 0, phase: 'lobby', sim: null, tick: 0, pending: [], overAt: 0, victory: null,
          left: new Map() }; // tab token -> state of a kitty that left this game (reconnect grace)
        stats.lobbyCreated();
        rooms.set(r.code, r);
        joinRoom(client, r, msg.name, msg.color, r.pass);
        break;
      }
      case 'join': {
        const r = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'error', msg: 'No lobby with that code.' });
        if (r === room) return;
        joinRoom(client, r, msg.name, msg.color, msg.password);
        break;
      }
      case 'leave':
        leaveRoom(client);
        send(ws, { t: 'left' });
        break;
      case 'start':
        if (room && room.hostId === client.id && room.phase === 'lobby') {
          startGame(room, TEST_HOOKS && Number.isFinite(msg.level) ? Math.max(1, Math.min(SKATE_FINAL_LEVEL, msg.level | 0)) : 1);
        }
        break;
      case 'dbg': {
        // test hooks: put the sender's kitty in the goal (it clears the level on the next tick) ...
        if (!TEST_HOOKS || !room || !room.sim) return;
        const p = room.sim.players.find((q) => q.id === client.id);
        if (p && msg.do === 'goal') { p.alive = true; p.x = 0; p.z = 0; p.vx = 0; p.vz = 0; }
        if (p && p.alive && msg.do === 'die') { // ... or knock it down where it stands (rescue circle and all)
          Object.assign(p, { alive: false, vx: 0, vz: 0, moving: false, shield: 0, invuln: 0, speedMult: 1 });
          p.deaths++;
          room.sim.circles.push({ playerId: p.id, x: p.x, z: p.z, t: 0 });
        }
        break;
      }
      case 'in': {
        if (!room || room.phase !== 'playing') return;
        const k = msg.k | 0;
        const x = Number.isFinite(msg.x) ? Math.max(-1, Math.min(1, msg.x)) : 0;
        const z = Number.isFinite(msg.z) ? Math.max(-1, Math.min(1, msg.z)) : 0;
        const margin = k - room.tick; // >0: arrived early enough to be used on time
        client.margin += (margin - client.margin) * 0.1;
        if (k <= room.tick) { client.lastInput = { x, z }; return; }    // late: best effort
        if (k > room.tick + 120) return;                               // nonsense / far future
        client.inputs.set(k, { x, z });
        break;
      }
      case 'chat': {
        if (!room) return;
        // token bucket: bursts of 5, refills one message per second
        const now = Date.now();
        if (!take(client, 'chat', 1, 5, now)) return send(ws, { t: 'chat', sys: true, text: 'Slow down a little!' });
        const raw = String(msg.text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
        if (!raw) return;
        client.chatLog.push({ at: new Date(now).toISOString(), room: room.code, text: raw });
        if (client.chatLog.length > CHAT_HISTORY) client.chatLog.shift();
        broadcast(room, { t: 'chat', id: client.id, name: client.name, color: client.color, text: raw }); // unfiltered (the apps mask on their side)
        break;
      }
      case 'god':
        // dev: playtest godmode for the sender's kitty (applied every tick in stepRoom)
        client.god = !!msg.on;
        break;
      case 'tp': {
        // dev: godmode right-click teleport of the sender's own kitty (never into a wall)
        if (!client.god || !room || room.phase !== 'playing' || !room.sim) return;
        const x = Number(msg.x), z = Number(msg.z);
        const p = room.sim.players.find((q) => q.id === client.id);
        if (!p || !p.alive || !Number.isFinite(x) || !Number.isFinite(z) || collideCircle(room.sim.levelData, x, z, CFG.KITTY_RADIUS).hit) return;
        p.x = x; p.z = z; p.vx = 0; p.vz = 0;
        break;
      }
      case 'ping':
        send(ws, { t: 'pong', c: msg.c, k: room && room.phase === 'playing' ? room.tick : 0 });
        break;
      case 'resync': {
        // the client asks at most every 2 s (main.js); the full wolf state is big, so hold it to 1/s
        const now = Date.now();
        if (!room || !room.sim || now - (client.resyncAt || 0) < 1000) return;
        client.resyncAt = now;
        send(ws, { t: 'wolves', lvl: room.sim.level, lt: room.sim.enemyTicks, wolves: serializeEnemies(room.sim.enemies) });
        break;
      }
    }
  }

  ws.on('close', () => {
    const left = (connsPerIp.get(ip) || 1) - 1;
    if (left > 0) connsPerIp.set(ip, left); else connsPerIp.delete(ip);
    leaveRoom(client);
    setTimeout(() => clients.delete(client.id), 10 * 60e3);
  });
  ws.on('error', () => {});
});

// ---------------- moderation ----------------
function handleReport(client, msg) {
  const now = Date.now();
  const reply = (text) => send(client.ws, { t: 'chat', sys: true, text });
  client.reportTimes = client.reportTimes.filter((t) => now - t < 3600e3);
  if (client.reportTimes.length >= REPORTS_PER_HOUR) return reply('You have sent a lot of reports — try again later.');
  const target = clients.get(msg.id | 0);
  if (!target || target === client) return reply('Could not find that player.');
  client.reportTimes.push(now);
  const reason = REPORT_REASONS.includes(msg.reason) ? msg.reason : 'other';
  const room = client.room || target.room;
  const who = (c) => ({ id: c.id, name: c.name, app: c.app, ver: c.ver });
  const entry = {
    at: new Date(now).toISOString(), reason, room: room ? room.code : null,
    reporter: who(client), reported: { ...who(target), ip: target.ip, chat: target.chatLog.slice() },
  };
  fs.appendFile(REPORTS_FILE, JSON.stringify(entry) + '\n', (err) => { if (err) console.error('report write failed:', err.message); });
  reply('Thanks — report sent.');
}

// Cross-play usage at a glance in the service log.
setInterval(() => {
  const n = { web: 0, ios: 0, android: 0, old: 0 };
  for (const c of clients.values()) if (c.ws.readyState === 1) n[c.hi ? c.app : 'old']++;
  if (n.web + n.ios + n.android + n.old) console.log(`clients: web ${n.web}, ios ${n.ios}, android ${n.android}, no-hi ${n.old}; rooms ${rooms.size}`);
}, 5 * 60e3).unref();

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

// Last resort: anything that still escapes is logged; state may be inconsistent, so exit and let systemd restart us.
process.on('uncaughtException', (err) => {
  console.error('uncaught:', err);
  try { stats.flush(); } catch { /* ignore */ }
  try { legends.flush(); } catch { /* ignore */ }
  process.exit(1);
});

// Deploy / restart: tell the players, close with 1012 (service restart) so clients reconnect, save stats, go.
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const room of rooms.values()) {
    try { broadcast(room, { t: 'chat', sys: true, text: 'Server restarting…' }); } catch { /* ignore */ }
  }
  for (const ws of wss.clients) { try { ws.close(1012, 'restarting'); } catch { /* ignore */ } }
  stats.flush();
  legends.flush();
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

server.listen(PORT, HOST, () => console.log(`Run Kitty Run server on http://${HOST}:${PORT}`));
