// Manual server test (NOT in CI): starts its own server on a free port (test hooks on, temp state files) and runs
//   1. online Skate only finale: version gating, start on the final run, victory event/snapshots, late joiner,
//      back to the lobby, the win in /api/stats, a fresh game afterwards
//   2. moderation / cross-play: hi/outdated gate, app badges, unfiltered chat, reports (apps), CORS, deep-link files
//   3. lobby/server smoke: lobby limits, chat, host start/migration, inputs, snapshots, mode gating for old clients
// Usage: node scripts/server-test.mjs   (PORT=... to pick a port; default: a free one). Never point it at the live server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { CFG, NET, PLAYER_NAMES, PROTOCOL_VERSION, SKATE_FINAL_LEVEL as F } from '../public/js/shared/config.js';
import { createSim } from '../public/js/shared/sim.js';
import { updateEnemies } from '../public/js/shared/enemies.js';
import { levelHash } from '../public/js/shared/maze.js';

const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = +process.env.PORT || await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-server-test-'));
const REPORTS_FILE = path.join(tmp, 'reports.jsonl');
const SERVER_MIN = 4;   // server/index.js MIN_PROTOCOL (protocol 4 clients still play, minus Run only's level 9 ending)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', RKR_TEST_HOOKS: '1', MAX_CONN_PER_IP: '100', REPORTS_FILE,
    FEEDBACK_FILE: path.join(tmp, 'feedback.jsonl'), STATS_FILE: path.join(tmp, 'stats.json'),
    APPLE_TEAM_ID: 'TEAM123456', ANDROID_CERT_SHA256: 'AA:BB, CC:DD' },
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res, rej) => { srv.stdout.on('data', (d) => { if (/server on/.test(d)) res(); }); srv.on('exit', () => rej(new Error('server exited: ' + srvErr))); });
console.log(`server on port ${PORT}`);

// ---------------- 1. online Skate only finale ----------------
async function victory() {
  const bots = [];
  function bot(hi) {
    const ws = new WebSocket(WS_URL);
    const b = { ws, msgs: [], snaps: [], last: {} };
    ws.on('message', (d) => { const m = JSON.parse(d); b.last[m.t] = m; if (m.t === 'snap') b.snaps.push(m); else b.msgs.push(m); });
    b.send = (m) => ws.send(JSON.stringify(m));
    b.ready = new Promise((r) => ws.on('open', () => { if (hi) b.send({ t: 'hi', ...hi }); r(); }));
    bots.push(b);
    return b;
  }
  const NEW = { v: PROTOCOL_VERSION, app: 'web', ver: 'test' };

  // ---- version gating: older builds are told to update (protocol 4: slim wolf resync, every mode); clients
  // without a 'hi' can't play any mode
  const noHi = bot(null), app3 = bot({ v: SERVER_MIN - 1, app: 'ios', ver: '1.0' });
  await Promise.all([noHi.ready, app3.ready]); await sleep(150);
  ok(app3.last.outdated && app3.ws.readyState >= 2, `protocol-${SERVER_MIN - 1} app told to update and dropped`);

  // ---- Run only's level 9 ending (protocol 5): a room with a protocol-4 kitty keeps the old spiral; a room playing
  // the ending can't be joined by one
  {
    const a = bot(NEW), old = bot({ v: 4, app: 'ios', ver: '1.0' }), b = bot(NEW), old2 = bot({ v: 4, app: 'ios', ver: '1.0' });
    await Promise.all([a.ready, old.ready, b.ready, old2.ready]);
    a.send({ t: 'create', name: 'A', mode: 'run' }); b.send({ t: 'create', name: 'B', mode: 'run' }); await sleep(150);
    old.send({ t: 'join', code: a.last.room.code, name: 'Old' }); await sleep(150);
    a.send({ t: 'start', level: F }); b.send({ t: 'start', level: F }); await sleep(300);
    ok(old.last.start && old.last.start.rf === 0 && a.last.start.rf === 0, 'Run only room with a protocol-4 kitty: no level 9 ending (rf 0)');
    ok(b.last.start && b.last.start.rf === 4, 'Run only room of current kitties plays the newest levels (rf 4)');
    old2.send({ t: 'join', code: b.last.room.code, name: 'Old2' }); await sleep(150);
    ok(old2.last.error && /new level 9/.test(old2.last.error.msg) && !old2.last.start, `protocol-4 kitty can't join it mid-game: "${old2.last.error && old2.last.error.msg}"`);
    for (const x of [a, old, b, old2]) x.ws.close();
    // Run + Skate (protocol 7): level 9 is both final runs in a row; a client builds the very same level from 'start'
    const c = bot(NEW); await c.ready;
    c.send({ t: 'create', name: 'C', mode: 'mixed' }); await sleep(150);
    c.send({ t: 'start', level: F }); await sleep(400);
    const cs = c.last.start, cm = cs && createSim({ seed: cs.seed, players: cs.players, startLevel: cs.level, mode: cs.mode, finales: +cs.rf || 0 });
    ok(cs && cs.rf === 4 && cm.levelData.combo && levelHash(cm.levelData) === cs.lh, `Run + Skate level 9 online: both final runs (rf ${cs && cs.rf}), same level on the client`);
    c.ws.close();
  }
  noHi.send({ t: 'create', name: 'Old', mode: 'ice' }); await sleep(150);
  ok(noHi.last.error && /Skate only/.test(noHi.last.error.msg) && !noHi.last.room, `no-hi client can't create a Skate only lobby: "${noHi.last.error && noHi.last.error.msg}"`);
  const host = bot(NEW); await host.ready;
  host.send({ t: 'create', name: 'Host', mode: 'ice' }); await sleep(150);
  const code = host.last.room && host.last.room.code;
  ok(code && host.last.room.mode === 'ice', `protocol-${PROTOCOL_VERSION} client creates Skate only lobby ${code}`);
  noHi.send({ t: 'list' }); host.send({ t: 'list' }); await sleep(150);
  ok(!noHi.last.lobbies.list.some((l) => l.code === code) && host.last.lobbies.list.some((l) => l.code === code), 'Skate only lobby hidden from old clients, listed for new ones');
  noHi.last.error = null;
  noHi.send({ t: 'join', code, name: 'Old' }); await sleep(150);
  ok(noHi.last.error && /code/.test(noHi.last.error.msg) && !noHi.last.room, `no-hi client can't join it by code: "${noHi.last.error && noHi.last.error.msg}"`);

  // ---- start on the final run
  const guest = bot({ ...NEW, tok: 'guest-tab-token' }); await guest.ready;
  guest.send({ t: 'join', code, name: 'Guest' }); await sleep(150);
  host.send({ t: 'start', level: F }); await sleep(300);
  const st = guest.last.start;
  ok(st && st.level === F && st.mode === 'ice' && st.st === 'playing' && st.vic === null, `start message: level ${st && st.level}, mode ${st && st.mode}, st ${st && st.st}`);
  // the client path: build the level from the start message and mirror the wolves; compare with the server's wolf checks
  const mirror = createSim({ seed: st.seed, players: st.players, startLevel: st.level, mode: st.mode, finales: +st.rf || 0 });
  await sleep(500);
  const snap = guest.snaps.at(-1);
  for (let t = 0; t < snap.lt; t++) updateEnemies(mirror.enemies, mirror.levelData, CFG.TICK);
  const wd = Math.max(...snap.ec.map(([id, x, z]) => { const e = mirror.enemies.find((q) => q.id === id); return e ? Math.hypot(e.x - x, e.z - z) : Infinity; }));
  ok(mirror.levelData.finale && snap.lvl === F && snap.st === 'playing' && wd < 0.002,
    `client-built final run matches the server (${mirror.enemies.length} wolves, wolf check diff ${wd.toFixed(4)} after ${snap.lt} ticks)`);
  ok(st.lh === levelHash(mirror.levelData), `start message level hash ${st.lh} matches the client-built level`);

  // ---- win
  guest.snaps.length = 0;
  host.send({ t: 'dbg', do: 'goal' });
  await sleep(400);
  const evSnap = guest.snaps.find((s) => s.ev.some((e) => e.type === 'victory'));
  const vic = evSnap && evSnap.ev.find((e) => e.type === 'victory');
  const hostId = host.last.room.you, guestId = guest.last.room.you;
  ok(vic && vic.by === hostId && vic.level === F && Array.isArray(vic.party) && vic.party.includes(guestId),
    `guest receives the victory event in a snapshot (by ${vic && vic.by}, party [${vic && vic.party}])`);
  ok(evSnap && evSnap.ev.some((e) => e.type === 'levelClear') && evSnap.st === 'victory', `that snapshot also has levelClear and st '${evSnap && evSnap.st}'`);
  const tWin = Date.now();

  // ---- late joiner mid-victory
  await sleep(1500);
  const late = bot(NEW); await late.ready;
  late.send({ t: 'join', code, name: 'Late' }); await sleep(400);
  const ls = late.last.start;
  ok(ls && ls.level === F && ls.st === 'victory' && ls.vic && ls.vic.type === 'victory' && Array.isArray(ls.wolves),
    `late joiner gets start with st '${ls && ls.st}', the victory event and full wolf state`);
  const lateId = late.last.room && late.last.room.you;
  const lp = late.snaps.at(-1) && late.snaps.at(-1).p.find((p) => p[0] === lateId);
  ok(lp && lp[6] === 1 && lp[7] === 1 && Math.hypot(lp[1], lp[2]) < 5, `late joiner is in the party (alive, in goal, ${lp && Math.hypot(lp[1], lp[2]).toFixed(1)} from the portal)`);

  // ---- legends board: the winners (not the late joiner) get it and may sign once each, editable, capped
  const lg = guest.last.legends, lw = lg && lg.wins[0];
  ok(host.last.legends && lg && lg.can && lw.id === lg.can.id && lw.mode === 'ice' && lw.entries.map((e) => e.name).join() === 'Host,Guest' && lw.entries.every((e) => e.text === ''),
    `winners get the legends board with their team on it (${lw && lw.entries.map((e) => e.name)})`);
  late.send({ t: 'sign', text: 'I was not there' }); await sleep(150);
  ok(!late.last.legends && late.last.signed && late.last.signed.ok === false, 'late joiner gets no board and can\'t sign');
  guest.send({ t: 'sign', text: '  Hello\nworld\u0007 ' + 'x'.repeat(300) }); await sleep(150);
  const gl = host.last.legend && host.last.legend.win.entries[1].text;
  ok(guest.last.signed.ok && gl && gl.length === 140 && gl.startsWith('Hello world x') && !late.last.legend, `guest signs (single line, capped at ${gl && gl.length}), host sees it live, the late joiner doesn't`);
  guest.send({ t: 'sign', text: 'Edited' }); await sleep(150);
  const lb = await (await fetch(`http://127.0.0.1:${PORT}/api/legends`)).json();
  ok(host.last.legend.win.entries.length === 2 && lb.wins[0].entries[1].text === 'Edited' && lb.wins[0].entries[0].text === '', 'the guest edits its line (still one entry each); /api/legends has it');
  // offline (solo / co-op) wins sign over HTTP: plausible runs only, one per IP per 10 minutes, edits with the key
  const post = (body, ip = '10.9.9.9') => fetch(`${BASE}/api/legends`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const coop = { mode: 'mixed', time: 900, runTime: 120, players: [{ name: 'Mittens', color: 0xffb347, text: 'We did it!' }, { name: 'Socks', color: 0x6ec6ff, text: '' }] };
  const quick = await post({ ...coop, time: 60 }), noMode = await post({ ...coop, mode: 'tag' });
  const made = await post(coop), again2 = await post(coop);
  ok(!quick.ok && !noMode.ok && made.ok && made.win.kind === 'coop' && made.win.entries.length === 2 && made.key && again2.status === 429,
    `offline co-op win signed (${made.win && made.win.kind}); too-quick / unknown mode rejected; a 2nd win from the same IP within 10 min refused (${again2.status})`);
  const bad = await post({ id: made.id, key: 'nope', players: [{ text: 'hacked' }] });
  const edit = await post({ id: made.id, key: made.key, players: [{ text: 'We did it!' }, { text: 'Me too' }] });
  ok(!bad.ok && edit.ok && edit.win.entries[1].text === 'Me too' && edit.win.entries[0].text === 'We did it!', 'offline lines editable with the key only');

  // ---- snapshots keep coming, all 'victory', until the room returns to the lobby
  const n0 = guest.snaps.length;
  while (!(guest.last.room && guest.last.room.phase === 'lobby') && Date.now() - tWin < 20000) await sleep(100);
  const back = (Date.now() - tWin) / 1000;
  const during = guest.snaps.slice(n0);
  ok(guest.last.room.phase === 'lobby' && back > 11 && back < 14, `room back in the lobby ${back.toFixed(1)}s after the win`);
  ok(during.length > 100 && during.every((s) => s.st === 'victory' && s.lvl === F), `${during.length} snapshots during the party, all st 'victory' on level ${F}`);
  ok(!during.some((s) => s.ev.some((e) => ['levelStart', 'gameOver', 'death'].includes(e.type))), 'no level change / game over / deaths during the party');
  const cnt = guest.snaps.length; await sleep(300);
  ok(guest.snaps.length === cnt, 'snapshots stop in the lobby');
  ok(host.last.room.members.length === 3, 'everyone (incl. the late joiner) is still in the lobby');

  // ---- stats + a new game
  const stats = await (await fetch(`http://127.0.0.1:${PORT}/api/stats`)).json();
  // onlineGames: this game + the two Run only level 9 rooms + the Run + Skate one
  ok(stats.totals.onlineWins === 1 && stats.onlineWinsByMode.ice === 1 && stats.totals.onlineGames === 4, `stats: onlineWins ${stats.totals.onlineWins}, ice ${stats.onlineWinsByMode.ice}`);
  const prevStart = guest.last.start;
  host.send({ t: 'start' });
  for (let i = 0; i < 30 && !(guest.last.start !== prevStart && guest.last.snap.st === 'playing'); i++) await sleep(100); // can lag on a busy machine
  ok(guest.last.start.level === 1 && guest.last.start.st === 'playing' && guest.last.snap.st === 'playing', 'host can start a new run (level 1) afterwards');
  // same tab reconnects (new connection, same token) after the party (the room has moved on): still in the signing window
  guest.ws.close();
  const again = bot({ ...NEW, tok: 'guest-tab-token' }); await again.ready;
  again.send({ t: 'legends' }); await sleep(150);
  again.send({ t: 'sign', text: 'From the lobby' }); await sleep(150);
  ok(again.last.legends && again.last.legends.can && again.last.signed && again.last.signed.ok && host.last.legend.win.entries[1].text === 'From the lobby',
    'after a reconnect (back in the lobby, new run started) the guest can still sign');
  for (const b of bots) b.ws.close();
  await sleep(100);
}

// ---------------- 2. moderation / cross-play ----------------
async function moderation() {
  // ip: distinct X-Forwarded-For per bot, like distinct players behind Caddy
  let ipN = 0;
  function bot(name, ip = '10.0.' + (++ipN >> 8) + '.' + (ipN & 255)) {
    const ws = new WebSocket(WS_URL, { headers: { 'x-forwarded-for': ip } });
    const b = { name, ws, msgs: [], last: {}, closed: false };
    ws.on('message', (d) => { const m = JSON.parse(d); b.last[m.t] = m; if (m.t !== 'snap') b.msgs.push(m); });
    ws.on('close', () => { b.closed = true; });
    b.send = (m) => ws.send(JSON.stringify(m));
    b.ready = new Promise((r) => ws.on('open', r));
    b.sys = () => b.msgs.filter((m) => m.t === 'chat' && m.sys).map((m) => m.text);
    b.chats = () => b.msgs.filter((m) => m.t === 'chat' && !m.sys);
    return b;
  }

  // protocol gate
  const old = bot('old'); await old.ready;
  old.send({ t: 'hi', v: 0, app: 'ios', ver: '0.9' }); await sleep(200);
  ok(old.last.outdated && /update/.test(old.last.outdated.msg) && old.closed, 'outdated protocol gets "outdated" and is closed');

  const host = bot('Host'); await host.ready;
  host.send({ t: 'hi', v: PROTOCOL_VERSION, app: 'ios', ver: '1.0.0' });
  host.send({ t: 'create', name: 'Host', mode: 'run' }); await sleep(200);
  ok(!host.closed && host.last.room, 'current protocol accepted');
  const code = host.last.room.code;
  const droid = bot('Droid'); await droid.ready;
  droid.send({ t: 'hi', v: PROTOCOL_VERSION, app: 'android', ver: '1.0.0<script>' });
  droid.send({ t: 'join', code, name: 'Droid' });
  const legacy = bot('Legacy'); await legacy.ready; // says hi without an app field (counts as web)
  legacy.send({ t: 'hi', v: PROTOCOL_VERSION });
  legacy.send({ t: 'join', code, name: 'Legacy' });
  const weird = bot('Weird'); await weird.ready;
  weird.send({ t: 'hi', v: PROTOCOL_VERSION, app: 'windows-phone' });
  weird.send({ t: 'join', code, name: 'xXfuckerXx' });
  await sleep(300);
  const apps = Object.fromEntries(host.last.room.members.map((m) => [m.id, m.app]));
  const idOf = (b) => b.last.room.you;
  ok(apps[idOf(host)] === 'ios' && apps[idOf(droid)] === 'android' && apps[idOf(legacy)] === 'web' && apps[idOf(weird)] === 'web',
    'member app field: ' + JSON.stringify(Object.values(apps)));
  const weirdName = host.last.room.members.find((m) => m.id === idOf(weird)).name;
  ok(weirdName === 'xXfuckerXx', `names relayed as typed (${weirdName})`);

  // chat is relayed unfiltered (only the store apps mask words, client side)
  droid.send({ t: 'chat', text: 'what the fuck, join www.spam.com' }); await sleep(200);
  const got = host.chats().at(-1);
  ok(got && got.text === 'what the fuck, join www.spam.com', 'chat unfiltered: ' + (got && got.text));

  // reports
  const sysCount = host.sys().length;
  host.send({ t: 'report', id: idOf(droid), reason: 'abuse' }); await sleep(200);
  ok(host.sys().slice(sysCount).includes('Thanks — report sent.'), 'reporter thanked');
  const lines = fs.existsSync(REPORTS_FILE) ? fs.readFileSync(REPORTS_FILE, 'utf8').trim().split('\n') : [];
  const rep = lines.length ? JSON.parse(lines[0]) : {};
  ok(lines.length === 1 && rep.reason === 'abuse' && rep.room === code && rep.reported.name === 'Droid' && rep.reported.app === 'android'
    && rep.reported.ver === '1.0.0script' && rep.reported.chat.some((c) => c.text.includes('fuck')) && rep.reporter.name === 'Host',
    'report written with context: ' + (lines[0] || '').slice(0, 160));
  host.send({ t: 'report', id: idOf(host), reason: 'spam' }); await sleep(100);
  ok(fs.readFileSync(REPORTS_FILE, 'utf8').trim().split('\n').length === 1, 'cannot report yourself');

  // rate limit: 10 per hour per connection
  const spammer = bot('Spammer'); await spammer.ready;
  spammer.send({ t: 'hi', v: PROTOCOL_VERSION, app: 'web' });
  spammer.send({ t: 'join', code, name: 'Spammer' }); await sleep(150);
  for (let i = 0; i < 12; i++) spammer.send({ t: 'report', id: idOf(legacy), reason: 'bogus' });
  await sleep(300);
  const all = fs.readFileSync(REPORTS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(all.filter((r) => r.reporter.name === 'Spammer').length === 10, 'reports rate limited to 10/hour');
  ok(all.filter((r) => r.reporter.name === 'Spammer').every((r) => r.reason === 'other'), 'unknown reason stored as "other"');

  // no auto-mute: reports never silence anyone
  for (const b of [legacy, weird, spammer]) b.send({ t: 'report', id: idOf(droid), reason: 'abuse' });
  await sleep(200);
  droid.send({ t: 'chat', text: 'still here' }); await sleep(200);
  ok(host.chats().at(-1).text === 'still here' && !droid.sys().some((t) => /muted/.test(t)), 'reports never mute');

  // HTTP: CORS + deep-link files + pages
  {
    const r = await fetch(`${BASE}/api/feedback`, { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    ok(r.status === 204 && r.headers.get('access-control-allow-origin') === 'capacitor://localhost'
      && /POST/.test(r.headers.get('access-control-allow-methods')) && /content-type/i.test(r.headers.get('access-control-allow-headers')), 'CORS preflight for capacitor://localhost');
    const r2 = await fetch(`${BASE}/api/feedback`, { method: 'POST', headers: { Origin: 'https://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'from the app', name: 'T' }) });
    ok(r2.status === 200 && r2.headers.get('access-control-allow-origin') === 'https://localhost', 'CORS POST from https://localhost');
    const r3 = await fetch(`${BASE}/api/feedback`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    ok(!r3.headers.get('access-control-allow-origin'), 'no CORS for other origins');
    const r4 = await fetch(`${BASE}/.well-known/apple-app-site-association`, { redirect: 'manual' });
    const aasa = await r4.json();
    ok(r4.status === 200 && r4.headers.get('content-type') === 'application/json'
      && aasa.applinks.details[0].appIDs[0] === 'TEAM123456.io.runkittyrun.app' && aasa.applinks.details[0].components[0]['?'].room === '*', 'AASA served');
    const r5 = await fetch(`${BASE}/.well-known/assetlinks.json`, { redirect: 'manual' });
    const al = await r5.json();
    ok(r5.status === 200 && /application\/json/.test(r5.headers.get('content-type')) && al[0].target.package_name === 'io.runkittyrun.app'
      && JSON.stringify(al[0].target.sha256_cert_fingerprints) === '["AA:BB","CC:DD"]', 'assetlinks.json served');
    for (const p of ['privacy.html', 'terms.html', 'support.html', 'privacy']) {
      const r6 = await fetch(`${BASE}/${p}`);
      ok(r6.status === 200 && /text\/html/.test(r6.headers.get('content-type')), `/${p} served`);
    }
    const r7 = await fetch(`${BASE}/%E0%A4%A`);
    ok(r7.status === 400, 'malformed URL does not crash the server');
    ok((await fetch(`${BASE}/healthz`)).ok, 'server still healthy');
  }

  for (const b of [host, droid, legacy, weird, spammer]) b.ws.close();
  await sleep(100);
}

// ---------------- 3. lobby / server smoke ----------------
async function lobby() {
  const MAXP = NET.MAX_PLAYERS;
  // v: protocol sent in the client's 'hi' (default: this build's; null: an old client that never says hi)
  function bot(name, v = PROTOCOL_VERSION) {
    const ws = new WebSocket(WS_URL);
    if (v != null) ws.on('open', () => ws.send(JSON.stringify({ t: 'hi', v, app: 'ios', ver: 'test' })));
    const b = { name, ws, msgs: [], last: {}, snaps: 0 };
    ws.on('message', (d) => { const m = JSON.parse(d); b.last[m.t] = m; if (m.t === 'snap') b.snaps++; else b.msgs.push(m); });
    b.send = (m) => ws.send(JSON.stringify(m));
    b.ready = new Promise((r) => ws.on('open', r));
    return b;
  }

  const host = bot('Host'); await host.ready;
  host.send({ t: 'create', name: 'Host' }); await sleep(200);
  const code = host.last.room.code;
  ok(/^[A-Z]{4}$/.test(code) && host.last.room.host === host.last.room.you, `create lobby ${code}, creator is host`);
  const others = [];
  for (let i = 0; i < MAXP; i++) { const b = bot('B' + i); await b.ready; b.send({ t: 'join', code, name: 'Bot' + i }); others.push(b); await sleep(30); }
  await sleep(300);
  ok(host.last.room.members.length === MAXP, `${MAXP} members (${host.last.room.members.length})`);
  ok(others[MAXP - 1].last.error && /full/.test(others[MAXP - 1].last.error.msg), `${MAXP + 1}th player rejected: ` + (others[MAXP - 1].last.error || {}).msg);
  others[0].send({ t: 'start' }); await sleep(200);
  ok(host.last.room.phase === 'lobby', 'non-host cannot start');
  const lister = bot('L'); await lister.ready; lister.send({ t: 'list' }); await sleep(200);
  ok(lister.last.lobbies.list.some((l) => l.code === code && l.players === MAXP), 'lobby appears in list');

  // chat: broadcast to the lobby, sanitized, rate limited, not leaked to other lobbies
  const chats = (b) => b.msgs.filter((m) => m.t === 'chat' && !m.sys);
  const outsider = bot('O'); await outsider.ready; outsider.send({ t: 'create', name: 'Outsider' }); await sleep(100);
  host.send({ t: 'chat', text: '  hi <b>kitties</b>\u0007 ' + 'x'.repeat(300) }); await sleep(200);
  const got = chats(others[3]).at(-1);
  ok(got && got.name === 'Host' && got.text.startsWith('hi <b>kitties</b> x') && got.text.length === 120, 'chat reaches lobby, trimmed to 120 chars');
  ok(chats(outsider).length === 0, 'chat does not leak to other lobbies');
  for (let i = 0; i < 8; i++) others[2].send({ t: 'chat', text: 'spam ' + i });
  await sleep(300);
  ok(chats(others[3]).filter((m) => m.text.startsWith('spam')).length === 5, 'chat rate limited to a burst of 5');
  ok(others[0].msgs.some((m) => m.t === 'chat' && m.sys && /joined/.test(m.text)), 'join notices sent');
  outsider.ws.close();

  host.send({ t: 'start' }); await sleep(100);
  ok(others[0].last.start && others[0].last.start.players.length === MAXP, 'host starts, everyone gets start');
  // host runs right for 1s using tick-tagged inputs
  const s0 = others[0].snaps;
  const me = host.last.room.you;
  let k = host.last.start.tick + 5;
  const p0 = () => host.last.snap.p.find((p) => p[0] === me);
  await sleep(200);
  const x0 = p0()[1], z0 = p0()[2], h0 = p0()[5];
  const t0 = Date.now();
  while (Date.now() - t0 < 1000) { k += 1; host.send({ t: 'in', k, x: Math.cos(h0), z: Math.sin(h0) }); await sleep(1000 / 60); }
  await sleep(300);
  const x1 = p0()[1], z1 = p0()[2];
  ok(Math.hypot(x1 - x0, z1 - z0) > 2, `host kitty moved ${Math.hypot(x1 - x0, z1 - z0).toFixed(2)} units`);
  const rate = (others[0].snaps - s0) / ((Date.now() - t0 + 200) / 1000);
  ok(rate > 15 && rate < 30, `snapshot rate ~${rate.toFixed(1)}/s`);
  ok(Array.isArray(host.last.snap.ec) && host.last.snap.ec.length === 8, 'wolf checks included');

  // host leaves mid-game -> next player becomes host
  host.ws.close(); await sleep(300);
  ok(others[0].last.room.host === others[0].last.room.you, 'host migrates to next player');
  ok(others[0].last.snap.p.length === MAXP - 1, 'leaver removed from sim');

  // mid-game join gets wolves
  const late = bot('Late'); await late.ready; late.send({ t: 'join', code, name: 'Late' }); await sleep(300);
  ok(late.last.start && Array.isArray(late.last.start.wolves) && late.last.start.wolves.length >= 150, 'mid-game joiner gets full wolf state');

  for (const b of [...others, late, lister]) b.ws.close();
  await sleep(200);
  lister.ws.close();
  const chk = bot('C'); await chk.ready; chk.send({ t: 'list' }); await sleep(200);
  ok(!chk.last.lobbies.list.some((l) => l.code === code), 'empty lobby is removed');
  chk.ws.close();

  // Every mode needs the current protocol (4: slim wolf resync). A client that never says hi can't see, create or join
  // any lobby; one below MIN_PROTOCOL is told to update and dropped.
  const nu = bot('New'); await nu.ready;
  const nohi = bot('NoHi', null); await nohi.ready;
  await sleep(100);
  nohi.send({ t: 'create', name: 'NoHi', mode: 'run' }); await sleep(200);
  ok(!nohi.last.room && nohi.last.error && /Run only/.test(nohi.last.error.msg), 'client without hi cannot create Run only: ' + (nohi.last.error || {}).msg);
  nu.send({ t: 'create', name: 'New', mode: 'ice' }); await sleep(200);
  const iceCode = nu.last.room && nu.last.room.code;
  ok(nu.last.room && nu.last.room.mode === 'ice', `new client creates Skate only lobby ${iceCode}`);
  nohi.send({ t: 'list' }); nu.send({ t: 'list' }); await sleep(200);
  ok(!nohi.last.lobbies.list.some((l) => l.code === iceCode), 'Skate only lobby hidden from clients without hi');
  ok(nu.last.lobbies.list.some((l) => l.code === iceCode && l.mode === 'ice'), 'Skate only lobby listed for new clients');
  nohi.last.error = null;
  nohi.send({ t: 'join', code: iceCode, name: 'NoHi' }); await sleep(200);
  ok(!nohi.last.room && nohi.last.error, 'client without hi refused joining by code');
  ok(nu.last.room.members.length === 1, 'refused clients never entered the lobby');
  nu.send({ t: 'start' }); await sleep(300);
  const nu2 = bot('New2'); await nu2.ready; await sleep(50);
  nu2.send({ t: 'join', code: iceCode, name: 'New2' }); await sleep(300);
  ok(nu2.last.start && nu2.last.start.mode === 'ice' && Array.isArray(nu2.last.start.wolves) && Number.isFinite(nu2.last.start.lh), 'new client joins Skate only mid-game with wolf state and level hash');
  for (const b of [nu, nu2, nohi]) b.ws.close();
  await sleep(100);

  // a client below the server's MIN_PROTOCOL gets 'outdated' and is disconnected
  for (const v of [0, SERVER_MIN - 1]) {
    const ancient = bot('Ancient', v); await ancient.ready; await sleep(200);
    ok(ancient.last.outdated && ancient.ws.readyState >= 2, `protocol-${v} client told to update and dropped`);
  }

  // reports: three different reporters auto-mute a player's chat in that lobby
  // (the server counts distinct reporter IPs; all bots share 127.0.0.1, so only the reply is checked here)
  const r1 = bot('R1'); await r1.ready; r1.send({ t: 'create', name: 'R1' }); await sleep(200);
  const r2 = bot('R2'); await r2.ready; r2.send({ t: 'join', code: r1.last.room.code, name: 'R2' }); await sleep(200);
  r2.send({ t: 'report', id: r1.last.room.you, reason: 'spam' }); await sleep(200);
  ok(r2.msgs.some((m) => m.t === 'chat' && m.sys && /report sent/.test(m.text)), 'report acknowledged');
  for (const b of [r1, r2]) b.ws.close();
  await sleep(100);
}

const t0 = Date.now();
try {
  for (const [name, fn] of [['finale', victory], ['moderation', moderation], ['lobby', lobby]]) {
    console.log(`\n== ${name}`);
    await fn();
  }
} catch (e) {
  ok(false, 'threw: ' + (e && e.stack || e));
} finally {
  srv.kill('SIGTERM');
  await new Promise((r) => srv.once('exit', r));
  if (srvErr.trim()) { console.log('FAIL server stderr:\n' + srvErr); process.exitCode = 1; }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
}
console.log(`\n${process.exitCode ? 'FAIL' : 'PASS'} server-test  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit();
