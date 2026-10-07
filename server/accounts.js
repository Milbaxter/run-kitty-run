// Optional player accounts: sign in with Google, chip in any amount (min 0.50) through Stripe Checkout, and the total
// you've paid shows next to your kitty's name online (a lowkey flex). Nothing else depends on an account.
// An account only counts once something is paid; signing in alone just lets you pay.
//
// No SDKs: Google ID tokens are checked against Google's public keys (JWKS) with node:crypto, and Stripe is plain
// HTTPS (fetch) plus its webhook signature (HMAC). State is one JSON file, saved atomically like legends.json;
// every credited payment is also appended to payments.jsonl next to it (bookkeeping, never rewritten).
//
// Env: GOOGLE_CLIENT_ID (comma-separate several: web + iOS/Android clients), STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, PUBLIC_ORIGIN (where Checkout returns to, default https://runkittyrun.fun), CURRENCY (default eur).
// Without GOOGLE_CLIENT_ID + STRIPE_SECRET_KEY accounts are off and the client hides the button.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UNLOCKS, UNLOCK_MODES, isUnlocked } from '../public/js/shared/unlocks.js';

const MIN_CENTS = 50;              // Stripe's minimum charge (EUR / USD; the account settles in EUR, so a USD charge must clear €0.50)
// No cap of our own: this is only the largest amount Stripe's API takes (8 digits); card / payment-method limits still apply
const STRIPE_MAX_CENTS = 99999999;
const MAX_SESSIONS = 10;           // signed-in devices per account
const GOOGLE_ISS = ['accounts.google.com', 'https://accounts.google.com'];
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
// The Stripe account is shared with other projects, and a webhook endpoint gets every project's events: only sessions
// this server created (bound in `checkouts`) and marked with APP are ever credited.
const APP = 'run-kitty-run';
const CHECKOUT_KEEP_MS = 30 * 864e5;   // an unpaid binding is forgotten after this (async methods like SEPA can take days)
// Pinned per request so the shared account's default API version never matters (branding_settings needs 2025-09-30+)
const STRIPE_VERSION = '2026-08-26.dahlia';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

function createAccounts(file, env = process.env) {
  const clientIds = String(env.GOOGLE_CLIENT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  const stripeKey = env.STRIPE_SECRET_KEY || '';
  const hookSecret = env.STRIPE_WEBHOOK_SECRET || '';
  const origins = new Set([env.PUBLIC_ORIGIN || 'https://runkittyrun.fun',
    ...(env.NODE_ENV === 'production' ? [] : [`http://localhost:${env.PORT || 8080}`, `http://127.0.0.1:${env.PORT || 8080}`])]);
  const enabled = !!(clientIds.length && stripeKey);
  const CURRENCY = /^[a-z]{3}$/.test(env.CURRENCY || '') ? env.CURRENCY : 'eur';   // one currency for everyone, so totals compare
  const paymentsFile = file.replace(/[^/]*$/, 'payments.jsonl');
  const LIVE = /^(sk|rk)_live_/.test(stripeKey);   // a test-mode session never credits a live server, and vice versa

  // sub (Google user id) -> { sub, email, name, paid (cents), created, sessions: [sha256 of token], payments: [stripe session ids],
  //   hide (true = the total isn't shown to other players), stats: { online, local } (see "stats" below) }
  let accounts = {};
  // Checkout Session id -> { sub, cents, at }: written when this server creates the session, removed once credited
  let checkouts = {};
  let dirty = false;
  // Tighten files from older deployments too. An unreadable or corrupt store is not a new account store.
  for (const p of [file, paymentsFile, file + '.tmp']) {
    try {
      if (!fs.lstatSync(p).isFile()) throw new Error('account storage must be a regular file: ' + p);
      fs.chmodSync(p, 0o600);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old && old.accounts && typeof old.accounts === 'object') accounts = old.accounts;
    if (old && old.checkouts && typeof old.checkouts === 'object') checkouts = old.checkouts;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const state = () => JSON.stringify({ accounts, checkouts });
  // One synchronous writer: no old asynchronous snapshot can overwrite a newer payment or revocation.
  // Failures propagate to the caller; a Checkout URL must never escape without its saved binding.
  function saveNow() {
    dirty = true;
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, state());
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    dirty = false;
  }
  let statsT = null;   // stats are saved a moment after they change (a full synchronous save, so never a stale one)
  function flush() {
    if (statsT) { clearTimeout(statsT); statsT = null; dirty = true; }
    if (dirty) saveNow();
  }
  // payments.jsonl is the record of truth for money: credit any logged payment the account file missed (a crash
  // between the two writes). Deleted accounts stay deleted.
  (function recover() {
    let lines = [];
    try { lines = fs.readFileSync(paymentsFile, 'utf8').split('\n'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    let n = 0;
    for (const l of lines) {
      let p; try { p = JSON.parse(l); } catch { continue; }
      if (p && checkouts[p.session]) { delete checkouts[p.session]; n++; }
      const a = p && accounts[p.sub];
      if (!a || (a.payments || []).includes(p.session)) continue;
      a.payments = [...(a.payments || []), p.session];
      a.paid = (Number(a.paid) || 0) + (Number(p.amount) || 0);
      n++;
    }
    if (n) { console.log('accounts: recovered payments from payments.jsonl'); saveNow(); }
  })();
  function pruneCheckouts() {
    const old = Date.now() - CHECKOUT_KEEP_MS;
    let pruned = false;
    for (const [id, c] of Object.entries(checkouts)) if (!(c.at > old)) { delete checkouts[id]; pruned = true; }
    if (pruned || dirty) {
      try { saveNow(); } catch (e) { console.error('accounts save failed:', e.message); }
    }
  }
  setInterval(pruneCheckouts, 6 * 3600e3).unref();
  const byToken = new Map();   // sha256(token) -> sub
  const reindex = () => { byToken.clear(); for (const a of Object.values(accounts)) for (const h of a.sessions || []) byToken.set(h, a.sub); };
  reindex();

  // ---- Google ----
  let jwks = { keys: new Map(), until: 0 };
  async function googleKey(kid) {
    if (Date.now() > jwks.until || !jwks.keys.has(kid)) {
      const r = await fetch(JWKS_URL);
      if (!r.ok) throw new Error('google keys ' + r.status);
      const maxAge = +((/max-age=(\d+)/.exec(r.headers.get('cache-control') || '') || [])[1] || 3600);
      const j = await r.json();
      jwks = { keys: new Map(j.keys.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])), until: Date.now() + maxAge * 1000 };
    }
    return jwks.keys.get(kid);
  }
  // a Google ID token (from Sign in with Google) -> its claims, or throws
  async function verifyGoogle(idToken) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('bad token');
    const head = b64json(parts[0]), claims = b64json(parts[1]);
    if (head.alg !== 'RS256') throw new Error('bad alg');
    const key = await googleKey(head.kid);
    if (!key || !crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw new Error('bad signature');
    const now = Date.now() / 1000;
    if (!GOOGLE_ISS.includes(claims.iss) || !clientIds.includes(claims.aud) || !(claims.exp > now) || !claims.sub) throw new Error('bad claims');
    return claims;
  }

  // ---- Stripe ----
  function form(obj, pre = '', out = []) {
    for (const [k, v] of Object.entries(obj)) {
      const key = pre ? `${pre}[${k}]` : k;
      if (v && typeof v === 'object') form(v, key, out);
      else if (v != null) out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
    }
    return out.join('&');
  }
  async function stripe(method, path, body) {
    const r = await fetch('https://api.stripe.com/v1' + path, {
      method,
      headers: { Authorization: 'Bearer ' + stripeKey, 'Stripe-Version': STRIPE_VERSION, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? form(body) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'stripe ' + r.status);
    return j;
  }

  // ---- accounts ----
  // A swag account is active once it has paid (one payment of at least MIN_CENTS): only then are its stats and unlock
  // progress counted and its switched-on unlocks shown. Signing in alone is free (it's how the payment finds the account).
  const active = (a) => (Number(a && a.paid) || 0) > 0;
  const pub = (a) => (a ? { name: a.name, email: a.email, paid: Number(a.paid) || 0, active: active(a), show: !a.hide, unlocks: unlocksOf(a),
    stats: { online: (a.stats && a.stats.online) || blankStats(), local: (a.stats && a.stats.local) || blankStats() } } : null);
  function newSession(a) {
    const token = crypto.randomBytes(24).toString('base64url');
    const h = sha(token);
    const previous = a.sessions;
    a.sessions = [...(a.sessions || []), h].slice(-MAX_SESSIONS);
    try { saveNow(); } catch (e) { a.sessions = previous; throw e; }
    reindex();
    return token;
  }
  const fromToken = (token) => {
    if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
    const sub = byToken.get(sha(token));
    return (sub && accounts[sub]) || null;
  };
  // total paid (cents) for a session token, 0 if none / unpaid / hidden: what the game server shows next to the name
  const paidFor = (token) => { const a = fromToken(token); return a && !a.hide ? Number(a.paid) || 0 : 0; };
  // the account id behind a session token (the game server keeps this per player instead of the token itself)
  const subFor = (token) => { const a = fromToken(token); return a ? a.sub : null; };

  // ---- stats (the account menu) ----
  // Two separate sets: 'online' is counted by this server from the online games it runs; 'local' (solo / local co-op)
  // is reported by the player's own browser, so the menu shows it apart as numbers anyone could edit.
  // { clears: { mode: { level: times the team cleared it } }, reached: { mode: highest level played }, crowns, revives }
  // best: the fastest clear per mode and level, in seconds (Run + Skate: the day and night halves together)
  function blankStats() { return { clears: { run: {}, ice: {}, mixed: {} }, reached: { run: 0, ice: 0, mixed: 0 }, best: { run: {}, ice: {}, mixed: {} }, crowns: 0, revives: 0 }; }
  const STAT_MODES = ['run', 'ice', 'mixed'], MAX_LEVEL = 9;
  const MIN_TIME = 5, MAX_TIME = 4 * 3600;   // a clear time outside this is ignored (seconds)
  function statsOf(a, kind) {
    a.stats ||= {};
    const s = a.stats[kind] ||= blankStats();
    s.best ||= {};
    for (const m of STAT_MODES) { s.clears[m] ||= {}; s.reached[m] ||= 0; s.best[m] ||= {}; }
    return s;
  }
  function statsChanged() {
    if (statsT) return;
    statsT = setTimeout(() => {
      statsT = null;
      try { saveNow(); } catch (e) { dirty = true; console.error('accounts save failed:', e.message); }
    }, 2000);
    statsT.unref();
  }
  // ev: { type: 'reached' | 'clear', mode, level, time? (a clear's seconds) } | { type: 'crown' } | { type: 'revive' }
  function record(a, kind, ev, n = 1) {
    if (!a || !ev || !(n > 0) || !active(a)) return;
    const s = statsOf(a, kind);
    if (ev.type === 'crown') s.crowns += n;
    else if (ev.type === 'revive') s.revives += n;
    else if (ev.type === 'reached' || ev.type === 'clear') {
      if (!STAT_MODES.includes(ev.mode) || !Number.isInteger(ev.level) || ev.level < 1 || ev.level > MAX_LEVEL) return;
      s.reached[ev.mode] = Math.max(s.reached[ev.mode], ev.level);
      if (ev.type === 'clear') {
        s.clears[ev.mode][ev.level] = (s.clears[ev.mode][ev.level] || 0) + n;
        const t = Number(ev.time);
        if (Number.isFinite(t) && t >= MIN_TIME && t <= MAX_TIME) {
          const r = Math.round(t * 10) / 10, old = s.best[ev.mode][ev.level];
          if (!(old <= r)) s.best[ev.mode][ev.level] = r;
        }
      }
    } else return;
    statsChanged();
  }
  // online games: the game server calls this for each signed-in player (by account id)
  const recordOnline = (sub, ev) => { if (sub && accounts[sub]) record(accounts[sub], 'online', ev); };

  // ---- permanent unlocks (shared/unlocks.js): feats done online, per mode, and the items switched off ----
  function unlocksOf(a) {
    const u = a.unlocks ||= {};
    for (const f of ['l8', 'l9']) { u[f] ||= {}; for (const m of UNLOCK_MODES) u[f][m] = Number(u[f][m]) || 0; }
    u.off ||= {};
    return u;
  }
  // the game server: this account's kitty did a feat ('l8' | 'l9') in a mode
  function recordFeat(sub, feat, mode) {
    const a = sub && accounts[sub];
    if (!a || !active(a) || !['l8', 'l9'].includes(feat) || !UNLOCK_MODES.includes(mode)) return;
    unlocksOf(a)[feat][mode]++;
    statsChanged();
  }
  // the unlocked items this account has switched on (the game server sends them to everyone in the room)
  const cosFor = (token) => {
    const a = fromToken(token);
    if (!a || !active(a)) return [];
    const u = unlocksOf(a);
    return UNLOCKS.filter((x) => isUnlocked(u, x) && !u.off[x.id]).map((x) => x.id);
  };

  // Is this paid session one of ours, unchanged? (a session from another project on the shared account, the other
  // mode, or one this server never created gets null, quietly: the webhook sees every project's checkouts)
  function ours(s) {
    if (!s || s.object !== 'checkout.session' || s.livemode !== LIVE || !s.metadata || s.metadata.app !== APP) return null;
    const c = checkouts[s.id];
    if (!c || c.sub !== s.client_reference_id || c.sub !== s.metadata.sub) return null;
    if (s.mode !== 'payment' || s.payment_status !== 'paid' || s.currency !== CURRENCY || s.amount_total !== c.cents) {
      if (s.payment_status === 'paid') console.error('checkout', s.id, 'paid but does not match what was created');
      return null;
    }
    return c;
  }

  // credit a paid Checkout Session once (from the webhook or the return trip, whichever comes first)
  function credit(s) {
    const c = ours(s);
    if (!c) return null;
    const a = accounts[c.sub];
    if (!a) { console.error('paid session for a deleted account', s.id); return null; }
    if ((a.payments || []).includes(s.id)) {
      delete checkouts[s.id];
      try { saveNow(); } catch (e) { checkouts[s.id] = c; throw e; }
      return a;
    }
    const amount = s.amount_total;
    // Written to disk before anyone is told it worked (the webhook's 200, the confirm reply): the log line first (it
    // replays on startup, see recover()), then the account file. A failed log write throws, so Stripe retries the webhook.
    const line = { at: new Date().toISOString(), session: s.id, sub: a.sub, email: a.email, amount, currency: s.currency, total: (Number(a.paid) || 0) + amount };
    const fd = fs.openSync(paymentsFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      // A disk error can leave half a log entry. Separate it before retrying so recovery can read the new entry.
      const size = fs.fstatSync(fd).size, tail = Buffer.alloc(1);
      const separator = size && fs.readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 10 ? '\n' : '';
      fs.writeFileSync(fd, separator + JSON.stringify(line) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    a.payments = [...(a.payments || []), s.id];
    a.paid = line.total;
    delete checkouts[s.id];
    // Keep the binding on failure so a webhook retry commits the snapshot without appending/crediting twice.
    try { saveNow(); } catch (e) { checkouts[s.id] = c; throw e; }
    console.log(`payment: ${a.email} +${(s.amount_total / 100).toFixed(2)} = ${(a.paid / 100).toFixed(2)}`);
    return a;
  }

  // ---- HTTP ----
  const reply = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  function readBody(req, max, cb) {
    const chunks = [];
    let size = 0, stopped = false;
    req.on('data', (c) => {
      if (stopped) return;
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += chunk.length;
      if (size > max) { stopped = true; chunks.length = 0; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { stopped = true; chunks.length = 0; });
    req.on('aborted', () => { stopped = true; chunks.length = 0; });
    req.on('end', () => { if (!stopped) cb(Buffer.concat(chunks, size)); });
  }
  const bearer = (req) => (/^Bearer (\S+)$/.exec(req.headers.authorization || '') || [])[1];

  async function route(name, req, body) {
    if (name === 'config') return { ok: true, enabled, googleClientId: clientIds[0] || null, min: MIN_CENTS, max: STRIPE_MAX_CENTS, currency: CURRENCY };
    if (!enabled) return { ok: false, msg: 'Accounts are not open yet.' };
    let m = {};
    if (body) { try { m = JSON.parse(body) || {}; } catch { return { ok: false }; } }
    if (name === 'google') {
      let c;
      try { c = await verifyGoogle(m.credential); } catch (e) { return { ok: false, msg: 'Google sign-in did not work, try again.' }; }
      if (c.email_verified === false) return { ok: false, msg: 'That Google account has no verified email.' };
      const a = accounts[c.sub] ||= { sub: c.sub, email: '', name: '', paid: 0, created: new Date().toISOString(), sessions: [], payments: [] };
      a.email = String(c.email || '').slice(0, 120);
      a.name = cleanName(c.given_name || c.name);
      return { ok: true, token: newSession(a), account: pub(a) };
    }
    const a = fromToken(bearer(req));
    if (!a) return { ok: false, signedOut: true };
    if (name === 'me') return { ok: true, account: pub(a) };
    if (name === 'pay') {
      const cents = m.cents;
      if (!Number.isSafeInteger(cents) || cents < MIN_CENTS) return { ok: false, msg: `The smallest amount is ${(MIN_CENTS / 100).toFixed(2)}.` };
      if (cents > STRIPE_MAX_CENTS) return { ok: false, msg: 'That is more than one payment can take.' };
      const origin = origins.has(m.origin) ? m.origin : [...origins][0];
      let s;
      try { s = await stripe('POST', '/checkout/sessions', {
        mode: 'payment', client_reference_id: a.sub, customer_email: a.email || undefined, submit_type: 'pay',
        line_items: { 0: { quantity: 1, price_data: { currency: CURRENCY, unit_amount: cents,
          product_data: { name: 'Run Kitty Run: your number', description: 'Adds to the total shown next to your kitty online. One-time, cosmetic only.' } } } },
        metadata: { app: APP, sub: a.sub },
        payment_intent_data: { description: 'Run Kitty Run account', metadata: { app: APP, sub: a.sub } },
        branding_settings: { display_name: 'Run Kitty Run' },   // the Checkout heading (the shared account keeps its name)
        success_url: `${origin}/?paid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?paid=cancel`,
      }); } catch (e) { console.error('checkout failed:', e.message); return { ok: false, msg: /amount/i.test(e.message) ? e.message : 'Checkout is not available right now, try again in a moment.' }; }
      if (s.livemode !== LIVE || !s.url) return { ok: false, msg: 'Checkout is not available right now, try again in a moment.' };
      if (accounts[a.sub] !== a || fromToken(bearer(req)) !== a) return { ok: false, signedOut: true };
      // bind before the player can pay: only sessions in here are ever credited
      checkouts[s.id] = { sub: a.sub, cents, at: Date.now() };
      try { saveNow(); } catch (e) { delete checkouts[s.id]; throw e; }
      return { ok: true, url: s.url };
    }
    if (name === 'confirm') {
      // back from Checkout: ask Stripe directly so it doesn't wait on the webhook
      if (!/^cs_[\w]+$/.test(String(m.session || ''))) return { ok: false };
      const s = await stripe('GET', '/checkout/sessions/' + m.session);
      if (!checkouts[s.id] && !(a.payments || []).includes(s.id)) return { ok: false };   // not a checkout this player started here
      if (s.client_reference_id !== a.sub) return { ok: false };
      credit(s);
      return { ok: true, paid: s.payment_status === 'paid', account: pub(a) };
    }
    if (name === 'equip') {
      // an unlocked item on / off (the player's own switch)
      const item = UNLOCKS.find((x) => x.id === m.item);
      if (!item || typeof m.on !== 'boolean') return { ok: false };
      const u = unlocksOf(a);
      if (!active(a)) return { ok: false, msg: 'Activate your swag account first.' };
      if (!isUnlocked(u, item)) return { ok: false, msg: 'Not unlocked yet.' };
      const previous = !!u.off[item.id];
      if (m.on) delete u.off[item.id]; else u.off[item.id] = true;
      try { saveNow(); } catch (e) { if (previous) u.off[item.id] = true; else delete u.off[item.id]; throw e; }
      return { ok: true, account: pub(a) };
    }
    if (name === 'show') {
      // the player's own switch: show the total to other players online, or not (it stays on the account either way)
      if (typeof m.show !== 'boolean') return { ok: false };
      const previous = a.hide;
      if (m.show) delete a.hide; else a.hide = true;
      try { saveNow(); } catch (e) { if (previous) a.hide = previous; else delete a.hide; throw e; }
      return { ok: true, account: pub(a) };
    }
    if (name === 'progress') {
      // solo / local co-op results, reported by the browser: { mode, reached, clears: [levels], times: [seconds per
      // clear, newer browsers], crowns, revives }.
      // Capped per report (the endpoint is rate limited per IP too); shown apart from the online numbers.
      const mode = STAT_MODES.includes(m.mode) ? m.mode : null;
      if (!mode) return { ok: false };
      const lvl = (v) => (Number.isInteger(v) && v >= 1 && v <= MAX_LEVEL ? v : 0);
      if (lvl(m.reached)) record(a, 'local', { type: 'reached', mode, level: lvl(m.reached) });
      const times = Array.isArray(m.times) ? m.times : [];
      (Array.isArray(m.clears) ? m.clears : []).slice(0, 3).forEach((v, i) => { if (lvl(v)) record(a, 'local', { type: 'clear', mode, level: v, time: times[i] }); });
      const count = (v, max) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : 0);
      record(a, 'local', { type: 'crown' }, count(m.crowns, 3));
      record(a, 'local', { type: 'revive' }, count(m.revives, 100));
      return { ok: true, account: pub(a) };
    }
    if (name === 'logout') {
      const h = sha(bearer(req));
      const previous = a.sessions;
      a.sessions = (a.sessions || []).filter((x) => x !== h);
      try { saveNow(); } catch (e) { a.sessions = previous; throw e; }
      reindex();
      return { ok: true };
    }
    if (name === 'delete') {
      // personal data goes; payments.jsonl keeps its lines (bookkeeping)
      delete accounts[a.sub];
      try { saveNow(); } catch (e) { accounts[a.sub] = a; throw e; }
      reindex();
      return { ok: true };
    }
    return null;
  }

  // POST /api/stripe/webhook: checkout.session.completed (and async payment succeeded) credits the account
  function webhook(req, res) {
    readBody(req, 1 << 16, (raw) => {
      const sig = String(req.headers['stripe-signature'] || '');
      const t = (/(?:^|,)t=(\d+)/.exec(sig) || [])[1];
      const v1s = [...sig.matchAll(/(?:^|,)v1=([0-9a-f]+)/g)].map((x) => x[1]);
      const want = hookSecret && t ? crypto.createHmac('sha256', hookSecret).update(t + '.').update(raw).digest('hex') : '';
      const ok = want && Math.abs(Date.now() / 1000 - +t) < 300
        && v1s.some((v) => v.length === want.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(want)));
      if (!ok) return reply(res, 400, { ok: false });
      let ev;
      try { ev = JSON.parse(raw.toString('utf8')); } catch { return reply(res, 400, { ok: false }); }
      if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
        try { credit(ev.data && ev.data.object); } catch (e) { console.error('credit failed:', e.message); return reply(res, 500, { ok: false }); }   // Stripe retries
      }
      reply(res, 200, { ok: true });
    });
  }

  // /api/account/<name>; returns false if it isn't one of ours
  function handle(req, res, name) {
    if (name === 'config' && req.method === 'GET') { route('config', req).then((j) => reply(res, 200, j)); return true; }
    if (!['google', 'me', 'pay', 'confirm', 'show', 'equip', 'progress', 'logout', 'delete'].includes(name)) return false;
    if (req.method !== (name === 'me' ? 'GET' : 'POST')) { reply(res, 405, { ok: false }); return true; }
    const go = (body) => route(name, req, body)
      .then((j) => reply(res, j ? 200 : 404, j || { ok: false }))
      .catch((e) => { console.error('account', name, 'failed:', e.message); reply(res, 502, { ok: false, msg: 'Something went wrong, try again in a moment.' }); });
    if (req.method === 'GET') go(''); else readBody(req, 8192, (raw) => go(raw.toString('utf8')));
    return true;
  }

  return { enabled, handle, webhook, paidFor, subFor, cosFor, recordOnline, recordFeat, flush };
}

export { createAccounts };
