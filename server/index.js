// Run Kitty Run online server: serves the static client and runs authoritative lobbies over WebSockets.
// One Room = one lobby (max NET.MAX_PLAYERS). The first player in the lobby is its host and decides when to start.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CFG, NET, PLAYER_COLORS, PLAYER_NAMES } from '../public/js/shared/config.js';
import { hashSeed } from '../public/js/shared/rng.js';
import { GAME_MODES, createSim, stepSim, addPlayer, removePlayer } from '../public/js/shared/sim.js';
import { serializeEnemies } from '../public/js/shared/enemies.js';
import { createStats } from './stats.js';

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const GAMEOVER_TO_LOBBY_MS = 4000;
// Player feedback is appended here as JSON lines (systemd gives the service /var/lib/run-kitty-run).
const FEEDBACK_FILE = process.env.FEEDBACK_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../feedback.jsonl');
const FEEDBACK_MAX = 1000;          // characters per message
const FEEDBACK_PER_HOUR = 6;        // per IP
const MAX_ROOMS = 200;
// Anonymous play stats (title screen STATS page) live next to the feedback file.
const stats = createStats(process.env.STATS_FILE || path.join(path.dirname(FEEDBACK_FILE), 'stats.json'));

// ---------------- static files ----------------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.end('ok'); return; }
  if (url.pathname === '/api/feedback') { handleFeedback(req, res); return; }
  if (url.pathname === '/api/event' || url.pathname === '/api/stats') { stats.handle(req, res, clientIp(req), () => wss.clients.size); return; }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/music/') ? 'public, max-age=86400' : 'no-cache',
      'Accept-Ranges': 'bytes',
    };
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
});

// ---------------- feedback ----------------
const feedbackHits = new Map(); // ip -> [timestamps]

function clientIp(req) {
  // behind Caddy: the first X-Forwarded-For entry is the real client
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '?';
}

function handleFeedback(req, res) {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST') return reply(405, { ok: false });
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (feedbackHits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= FEEDBACK_PER_HOUR) return reply(429, { ok: false, msg: 'Thanks! That is plenty of feedback for now.' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', () => {
    let m;
    try { m = JSON.parse(body); } catch { return reply(400, { ok: false }); }
    const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);
    const text = clean(m.text, FEEDBACK_MAX);
    if (text.length < 2) return reply(400, { ok: false, msg: 'Type a little more first.' });
    const entry = {
      at: new Date(now).toISOString(), text,
      name: clean(m.name, 20), mode: clean(m.mode, 12), level: Number.isFinite(m.level) ? m.level | 0 : null,
      ua: clean(req.headers['user-agent'], 160),
    };
    hits.push(now);
    feedbackHits.set(ip, hits);
    fs.appendFile(FEEDBACK_FILE, JSON.stringify(entry) + '\n', (err) => {
      if (err) { console.error('feedback write failed:', err.message); return reply(500, { ok: false }); }
      reply(200, { ok: true });
    });
  });
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

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const m of room.members) send(m.ws, s);
}

function roomInfo(room) {
  return {
    t: 'room', code: room.code, host: room.hostId, phase: room.phase, mode: room.mode, max: NET.MAX_PLAYERS,
    members: room.members.map((m) => ({ id: m.id, name: m.name, color: m.color })),
  };
}

function sendRoom(room) {
  const info = roomInfo(room);
  for (const m of room.members) send(m.ws, { ...info, you: m.id });
}

function lobbyList() {
  const list = [];
  for (const r of rooms.values()) {
    if (r.members.length === 0) continue;
    list.push({
      code: r.code, players: r.members.length, max: NET.MAX_PLAYERS, phase: r.phase,
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

function joinRoom(client, room, name) {
  if (room.members.length >= NET.MAX_PLAYERS) return send(client.ws, { t: 'error', msg: `That lobby is full (${NET.MAX_PLAYERS}/${NET.MAX_PLAYERS}).` });
  leaveRoom(client);
  const slot = freeColorSlot(room);
  client.room = room;
  client.slot = slot;
  client.name = cleanName(name, PLAYER_NAMES[slot]);
  client.color = PLAYER_COLORS[slot];
  client.inputs = new Map();
  client.lastInput = { x: 0, z: 0 };
  client.margin = NET.INPUT_LEAD;
  room.members.push(client);
  if (!room.hostId) room.hostId = client.id;
  sendRoom(room);
  broadcast(room, { t: 'chat', sys: true, text: `${client.name} joined` });
  if (room.phase === 'playing') {
    // Join mid-game: spawn now; send full state (including wolves) so the newcomer is in sync.
    addPlayer(room.sim, { id: client.id, name: client.name, color: client.color });
    send(client.ws, startMsg(room, true));
  }
}

function leaveRoom(client) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  room.members = room.members.filter((m) => m !== client);
  if (room.sim) removePlayer(room.sim, client.id);
  if (room.members.length === 0) { rooms.delete(room.code); return; }
  if (room.hostId === client.id) room.hostId = room.members[0].id; // next in join order
  sendRoom(room);
  broadcast(room, { t: 'chat', sys: true, text: `${client.name} left` });
}

function startMsg(room, withWolves) {
  const sim = room.sim;
  return {
    t: 'start', seed: sim.seed, mode: sim.mode, level: sim.level, tick: room.tick, lt: sim.enemyTicks,
    players: sim.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    wolves: withWolves ? serializeEnemies(sim.enemies) : null,
  };
}

function startGame(room) {
  stats.onlineGameStarted();
  room.phase = 'playing';
  room.tick = 0;
  room.pending = [];
  room.overAt = 0;
  const seed = hashSeed(Date.now(), Math.random(), room.code) >>> 0;
  room.sim = createSim({
    seed, startLevel: 1, mode: room.mode,
    players: room.members.map((m) => ({ id: m.id, name: m.name, color: m.color })),
  });
  for (const m of room.members) { m.inputs.clear(); m.lastInput = { x: 0, z: 0 }; }
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
  }
  const events = stepSim(sim, inputs, CFG.TICK);
  room.tick = k;
  for (const e of events) room.pending.push(e);
  if (events.some((e) => e.type === 'gameOver')) room.overAt = Date.now() + GAMEOVER_TO_LOBBY_MS;
  if (k % NET.SNAP_EVERY === 0 || events.length) sendSnapshot(room);
}

const r3 = (v) => Math.round(v * 1000) / 1000;

function sendSnapshot(room) {
  const sim = room.sim;
  const margins = new Map(room.members.map((m) => [m.id, m.margin]));
  broadcast(room, {
    t: 'snap', k: room.tick, lvl: sim.level, st: sim.state, lt: sim.enemyTicks, tm: r3(sim.time),
    // [id, x, z, vx, vz, heading, alive, inCenter, lives, speedMult, invuln, shield, deaths, rescues, inputMargin, finishes]
    p: sim.players.map((p) => [p.id, r3(p.x), r3(p.z), r3(p.vx), r3(p.vz), r3(p.heading), p.alive ? 1 : 0, p.inCenter ? 1 : 0,
      p.lives, r3(p.speedMult), r3(p.invuln), r3(p.shield), p.deaths, p.rescues, Math.round((margins.get(p.id) ?? 0) * 10) / 10, p.finishes || 0]),
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
    for (const room of rooms.values()) if (room.phase === 'playing') stepRoom(room);
  }
  for (const room of rooms.values()) {
    if (room.phase === 'playing' && room.overAt && Date.now() >= room.overAt) {
      room.phase = 'lobby';
      room.sim = null;
      sendRoom(room);
    }
  }
}, 1000 / 120);

// ---------------- websocket ----------------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  stats.online(wss.clients.size);
  const client = { id: nextClientId++, ws, room: null, name: '' };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'hello', id: client.id });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const room = client.room;
    switch (msg.t) {
      case 'list':
        send(ws, { t: 'lobbies', list: lobbyList() });
        break;
      case 'create': {
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Server is full, try again later.' });
        const mode = GAME_MODES.includes(msg.mode) ? msg.mode : 'mixed';
        const r = { code: makeCode(), mode, members: [], hostId: 0, phase: 'lobby', sim: null, tick: 0, pending: [], overAt: 0 };
        stats.lobbyCreated();
        rooms.set(r.code, r);
        joinRoom(client, r, msg.name);
        break;
      }
      case 'join': {
        const r = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'error', msg: 'No lobby with that code.' });
        if (r === room) return;
        joinRoom(client, r, msg.name);
        break;
      }
      case 'leave':
        leaveRoom(client);
        send(ws, { t: 'left' });
        break;
      case 'start':
        if (room && room.hostId === client.id && room.phase === 'lobby') startGame(room);
        break;
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
        client.chatTokens = Math.min(5, (client.chatTokens ?? 5) + (now - (client.chatAt || now)) / 1000);
        client.chatAt = now;
        if (client.chatTokens < 1) return send(ws, { t: 'chat', sys: true, text: 'Slow down a little!' });
        client.chatTokens -= 1;
        const text = String(msg.text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
        if (!text) return;
        broadcast(room, { t: 'chat', id: client.id, name: client.name, color: client.color, text });
        break;
      }
      case 'ping':
        send(ws, { t: 'pong', c: msg.c, k: room && room.phase === 'playing' ? room.tick : 0 });
        break;
      case 'resync':
        if (room && room.sim) send(ws, { t: 'wolves', lvl: room.sim.level, lt: room.sim.enemyTicks, wolves: serializeEnemies(room.sim.enemies) });
        break;
    }
  });

  ws.on('close', () => leaveRoom(client));
  ws.on('error', () => {});
});

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(PORT, HOST, () => console.log(`Run Kitty Run server on http://${HOST}:${PORT}`));
