// Online Skate only finale against a locally started server (test hooks on): version gating for old clients,
// a room started on the final run, the 'victory' event + st 'victory' snapshots, a late joiner mid-victory,
// the room going back to the lobby, the win in /api/stats, and a fresh game afterwards.
// Usage: node scripts/victory-online-test.mjs   (PORT=8134 by default; starts and stops its own server)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { CFG, SKATE_FINAL_LEVEL as F } from '../public/js/shared/config.js';
import { createSim } from '../public/js/shared/sim.js';
import { updateEnemies } from '../public/js/shared/enemies.js';

const PORT = +process.env.PORT || 8134;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-victory-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', RKR_TEST_HOOKS: '1', FEEDBACK_FILE: path.join(tmp, 'feedback.jsonl'), STATS_FILE: path.join(tmp, 'stats.json') },
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((res, rej) => { srv.stdout.on('data', (d) => { if (/server on/.test(d)) res(); }); srv.on('exit', () => rej(new Error('server exited: ' + srvErr))); });

const bots = [];
function bot(hi) {
  const ws = new WebSocket(URL);
  const b = { ws, msgs: [], snaps: [], last: {} };
  ws.on('message', (d) => { const m = JSON.parse(d); b.last[m.t] = m; if (m.t === 'snap') b.snaps.push(m); else b.msgs.push(m); });
  b.send = (m) => ws.send(JSON.stringify(m));
  b.ready = new Promise((r) => ws.on('open', () => { if (hi) b.send({ t: 'hi', ...hi }); r(); }));
  bots.push(b);
  return b;
}
const NEW = { v: 3, app: 'web', ver: 'test' };

try {
  // ---- version gating: builds without the final run can't play Skate only (they'd build the spiral on level 8)
  const noHi = bot(null), app2 = bot({ v: 2, app: 'ios', ver: '1.0' });
  await Promise.all([noHi.ready, app2.ready]);
  for (const [b, who] of [[noHi, 'no-hi client'], [app2, 'protocol-2 app']]) {
    b.send({ t: 'create', name: 'Old', mode: 'ice' }); await sleep(150);
    ok(b.last.error && /Skate only/.test(b.last.error.msg) && !b.last.room, `${who} can't create a Skate only lobby: "${b.last.error && b.last.error.msg}"`);
  }
  const host = bot(NEW); await host.ready;
  host.send({ t: 'create', name: 'Host', mode: 'ice' }); await sleep(150);
  const code = host.last.room && host.last.room.code;
  ok(code && host.last.room.mode === 'ice', `protocol-3 client creates Skate only lobby ${code}`);
  app2.send({ t: 'list' }); noHi.send({ t: 'list' }); host.send({ t: 'list' }); await sleep(150);
  ok(!app2.last.lobbies.list.some((l) => l.code === code) && !noHi.last.lobbies.list.some((l) => l.code === code)
    && host.last.lobbies.list.some((l) => l.code === code), 'Skate only lobby hidden from old clients, listed for new ones');
  app2.last.error = null;
  app2.send({ t: 'join', code, name: 'Old' }); await sleep(150);
  ok(app2.last.error && /code/.test(app2.last.error.msg) && !app2.last.room, `old app can't join it by code: "${app2.last.error && app2.last.error.msg}"`);
  app2.send({ t: 'create', name: 'Old', mode: 'mixed' }); await sleep(150);
  ok(!app2.last.room && app2.last.error, 'old app can\'t create a Run + Skate lobby either (boss run on level 9)');
  app2.last.error = null;
  app2.send({ t: 'create', name: 'Old', mode: 'run' }); await sleep(150);
  ok(app2.last.room && app2.last.room.mode === 'run', 'old app can still create a Run only lobby');

  // ---- start on the final run
  const guest = bot(NEW); await guest.ready;
  guest.send({ t: 'join', code, name: 'Guest' }); await sleep(150);
  host.send({ t: 'start', level: F }); await sleep(300);
  const st = guest.last.start;
  ok(st && st.level === F && st.mode === 'ice' && st.st === 'playing' && st.vic === null, `start message: level ${st && st.level}, mode ${st && st.mode}, st ${st && st.st}`);
  // the client path: build the level from the start message and mirror the wolves; compare with the server's wolf checks
  const mirror = createSim({ seed: st.seed, players: st.players, startLevel: st.level, mode: st.mode });
  await sleep(500);
  const snap = guest.snaps.at(-1);
  for (let t = 0; t < snap.lt; t++) updateEnemies(mirror.enemies, mirror.levelData, CFG.TICK);
  const wd = Math.max(...snap.ec.map(([id, x, z]) => { const e = mirror.enemies.find((q) => q.id === id); return e ? Math.hypot(e.x - x, e.z - z) : Infinity; }));
  ok(mirror.levelData.finale && snap.lvl === F && snap.st === 'playing' && wd < 0.002,
    `client-built final run matches the server (${mirror.enemies.length} wolves, wolf check diff ${wd.toFixed(4)} after ${snap.lt} ticks)`);

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
  ok(stats.totals.onlineWins === 1 && stats.onlineWinsByMode.ice === 1 && stats.totals.onlineGames === 1, `stats: onlineWins ${stats.totals.onlineWins}, ice ${stats.onlineWinsByMode.ice}`);
  host.send({ t: 'start' }); await sleep(300);
  ok(guest.last.start.level === 1 && guest.last.start.st === 'playing' && guest.last.snap.st === 'playing', 'host can start a new run (level 1) afterwards');
} finally {
  for (const b of bots) b.ws.close();
  await sleep(100);
  srv.kill('SIGTERM');
  await new Promise((r) => srv.once('exit', r));
  if (srvErr.trim()) { console.log('FAIL server stderr:\n' + srvErr); process.exitCode = 1; }
  fs.rmSync(tmp, { recursive: true, force: true });
}
