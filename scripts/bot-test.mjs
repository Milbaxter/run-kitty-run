// Server smoke test: lobby limits, host start/migration, inputs, snapshots.
import WebSocket from 'ws';
import { NET, PROTOCOL_VERSION } from '../public/js/shared/config.js';
const MAXP = NET.MAX_PLAYERS;
const URL = process.env.URL || 'ws://localhost:8080/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// v: protocol sent in the client's 'hi' (default: this build's; null: an old client that never says hi)
function bot(name, v = PROTOCOL_VERSION) {
  const ws = new WebSocket(URL);
  if (v != null) ws.on('open', () => ws.send(JSON.stringify({ t: 'hi', v, app: 'ios', ver: 'test' })));
  const b = { name, ws, msgs: [], last: {}, snaps: 0 };
  ws.on('message', (d) => { const m = JSON.parse(d); b.last[m.t] = m; if (m.t === 'snap') b.snaps++; else b.msgs.push(m); });
  b.send = (m) => ws.send(JSON.stringify(m));
  b.ready = new Promise((r) => ws.on('open', r));
  return b;
}
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };

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
for (const v of [0, PROTOCOL_VERSION - 1]) {
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
