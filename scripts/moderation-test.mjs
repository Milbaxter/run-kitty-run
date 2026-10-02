// Moderation / cross-play server test: filter unit tests, then a live server on PORT (default 8091) checking the
// hi/outdated gate, member app badges, chat filtering, reports, auto-mute, CORS and deep-link files.
// Usage: node scripts/moderation-test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { filterChat, filterName } from '../server/filter.js';
import { PLAYER_NAMES, PROTOCOL_VERSION } from '../public/js/shared/config.js';

const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- filter unit tests ----------------
const masked = ['fuck you', 'F U C K', 'f.u.c.k', 'sh1t', '$h!t', 'a$$', 'fuuuuck', 'b!tch', 'you ass!', 'fück', 'n1gger',
  'sh*t', 'bullshit', 'kys', 'kill yourself', 'stupid c u n t', 'sexy'];
const clean = ['hello class', 'Scunthorpe', 'my therapist', 'cocktail', 'assassin', 'Shiitake', 'grapes', 'Sussex',
  'pass the ball', 'annals', 'analysis', 'cumulative', 'Dickens', 'spicy', 'hello!!!', 'level 3 lol', 'c++', 'I a m', 'gg wp',
  'Mississippi', 'shell', 'title', 'document', 'peacock', 'raccoon', 'Hancock', 'sextant', 'butterfly', 'pussycat'];
for (const t of masked) ok(filterChat(t).includes('♥♥♥'), `masks "${t}" -> "${filterChat(t)}"`);
for (const t of clean) ok(filterChat(t) === t, `keeps "${t}"`);
ok(filterChat('go to www.evil.com now') === 'go to [link] now', 'strips www link');
ok(filterChat('see https://x.y/z?a=1 ok') === 'see [link] ok', 'strips http link');
ok(filterChat('discord.gg/abc') === '[link]', 'strips bare domain');
ok(filterChat('3.5 is fine') === '3.5 is fine', 'keeps numbers with dots');
ok(filterName('Mittens').name === 'Mittens' && !filterName('Mittens').changed, 'nice name kept');
for (const n of ['Sh_it', 'xXfuckerXx', 'N1gga', 'Hitler']) {
  const f = filterName(n);
  ok(f.changed && PLAYER_NAMES.includes(f.name), `name "${n}" -> ${f.name}`);
}
{
  const long = 'the quick brown fox jumps over the lazy dog '.repeat(3).slice(0, 120);
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) filterChat(long);
  const us = ((performance.now() - t0) / 2000) * 1000;
  ok(us < 500, `filter is fast (${us.toFixed(0)} µs per 120-char message)`);
}

// ---------------- live server ----------------
const PORT = +process.env.PORT || 8091;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-mod-'));
const REPORTS_FILE = path.join(tmp, 'reports.jsonl');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: root, stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', REPORTS_FILE, FEEDBACK_FILE: path.join(tmp, 'feedback.jsonl'),
    APPLE_TEAM_ID: 'TEAM123456', ANDROID_CERT_SHA256: 'AA:BB, CC:DD' },
});
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
// the server may still be flushing stats.json into tmp as it exits: retry the cleanup, never fail the test on it
const stop = () => { try { srv.kill(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {} };
process.on('exit', stop);

for (let i = 0; i < 50 && !srvOut.includes('server on'); i++) await sleep(100);
ok(srvOut.includes('server on'), 'server started on ' + PORT);

// ip: distinct X-Forwarded-For per bot, like distinct players behind Caddy
let ipN = 0;
function bot(name, ip = '10.0.' + (++ipN >> 8) + '.' + (ipN & 255)) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { 'x-forwarded-for': ip } });
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
ok(PLAYER_NAMES.includes(weirdName), `offensive name replaced with ${weirdName}`);
ok(weird.sys().some((t) => /name isn't allowed/.test(t)), 'renamed player is told why');

// chat filtering
droid.send({ t: 'chat', text: 'what the fuck, join www.spam.com' }); await sleep(200);
const got = host.chats().at(-1);
ok(got && got.text === 'what the ♥♥♥, join [link]', 'chat filtered: ' + (got && got.text));
droid.send({ t: 'chat', text: 'gg nice class' }); await sleep(200);
ok(host.chats().at(-1).text === 'gg nice class', 'clean chat unchanged');

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

// auto-mute: 3 distinct reporters in the room (the same person twice doesn't count)
const before = host.chats().length;
legacy.send({ t: 'report', id: idOf(droid), reason: 'abuse' });
legacy.send({ t: 'report', id: idOf(droid), reason: 'abuse' }); await sleep(200);
droid.send({ t: 'chat', text: 'still here' }); await sleep(200);
ok(host.chats().length === before + 1, 'not muted after 2 distinct reporters');
weird.send({ t: 'report', id: idOf(droid), reason: 'spam' }); await sleep(200);
ok(droid.sys().some((t) => /muted/.test(t)), 'muted player is told');
droid.send({ t: 'chat', text: 'can you hear me' }); await sleep(200);
ok(host.chats().length === before + 1 && !legacy.chats().some((m) => m.text === 'can you hear me'), 'muted player chat not relayed');
ok(droid.sys().some((t) => /muted for 10 more min/.test(t)), 'muted player gets remaining time');
legacy.send({ t: 'chat', text: 'others still chat' }); await sleep(200);
ok(host.chats().at(-1).text === 'others still chat', 'others unaffected');

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
stop();
process.exit();
