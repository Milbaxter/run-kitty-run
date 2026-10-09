// Optional player accounts: sign in with Google, chip in any amount (min 0.50) through Stripe Checkout, and the total
// you've paid shows next to your kitty's name online (a lowkey flex). Nothing else depends on an account.
// An account only counts once something is paid; signing in alone just lets you pay.
//
// No SDKs: Google ID tokens are checked against Google's public keys (JWKS) with node:crypto, and Stripe is plain
// HTTPS (fetch) plus its webhook signature (HMAC). State is one JSON file, saved atomically like legends.json;
// every credited payment is also appended to payments.jsonl next to it (bookkeeping, never rewritten).
//
// The iOS app pays through Apple's in-app purchases instead (no sign-in there): its swag account belongs to the App
// Store account that installed the app (the signed app transaction's appTransactionId, the same on every device and
// reinstall), each verified purchase credits a fixed amount per product (shared/iap.js), once, and refunds take it
// back. See appstore.js and "App Store" below.
//
// Sign in with Discord is a plain OAuth2 code flow run here (GET /api/account/discord -> Discord -> .../discord/callback);
// those accounts are keyed 'discord_<user id>' (Google ones stay keyed by the bare Google id) and have no email.
//
// Env: GOOGLE_CLIENT_ID (comma-separate several: web + iOS/Android clients), DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET
// (optional: without them there's no Discord button), APPLE_IAP=off (no in-app purchases), APPLE_IAP_SANDBOX=off
// (refuse sandbox / TestFlight / App Review purchases), STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, PUBLIC_ORIGIN (where Checkout returns to, default https://runkittyrun.fun), CURRENCY (default eur).
// Without GOOGLE_CLIENT_ID + STRIPE_SECRET_KEY web accounts are off and the client hides the button.
// Tests only (never with NODE_ENV=production): APPLE_IAP_TEST_ROOTS (a PEM file of extra trusted roots),
// APPLE_IAP_XCODE=1 (accept StoreKit Testing in Xcode data, which Xcode signs itself).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UNLOCKS, UNLOCK_MODES, FEAT_IDS, isUnlocked } from '../public/js/shared/unlocks.js';
import { IAP_PRODUCTS, IAP_BY_ID } from '../public/js/shared/iap.js';
import { createAppStore } from './appstore.js';

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
  const discordId = env.DISCORD_CLIENT_ID || '', discordSecret = env.DISCORD_CLIENT_SECRET || '';
  const discordOn = enabled && !!(discordId && discordSecret);
  // iOS in-app purchases: on unless APPLE_IAP=off. Test roots and Xcode-signed data never in production.
  const testing = env.NODE_ENV !== 'production';
  const iapOn = env.APPLE_IAP !== 'off';
  const appStore = createAppStore({
    sandbox: env.APPLE_IAP_SANDBOX !== 'off',
    xcode: testing && env.APPLE_IAP_XCODE === '1',
    testRoots: testing && env.APPLE_IAP_TEST_ROOTS
      ? fs.readFileSync(env.APPLE_IAP_TEST_ROOTS, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [] : [],
  });
  const CURRENCY = /^[a-z]{3}$/.test(env.CURRENCY || '') ? env.CURRENCY : 'eur';   // one currency for everyone, so totals compare
  const paymentsFile = file.replace(/[^/]*$/, 'payments.jsonl');
  const LIVE = /^(sk|rk)_live_/.test(stripeKey);   // a test-mode session never credits a live server, and vice versa

  // sub (Google user id, or 'discord_<id>') -> { sub, email, name, paid (cents), created, sessions: [sha256 of token], payments: [stripe session ids],
  //   hide (true = the total isn't shown to other players), stats: { online, local } (see "stats" below),
  //   iOS accounts (sub 'ios_<hex>', via 'apple'): apple: { env (Production | Sandbox), appTx (the App Store account's
  //   appTransactionId), token (the appAccountToken every purchase carries) } }
  let accounts = {};
  // Checkout Session id -> { sub, cents, at }: written when this server creates the session, removed once credited
  let checkouts = {};
  // players without an active account: unlock progress under their browser's random progress id (shared/unlocks.js),
  // { unlocks, at (last seen, ms) }; moved onto their account when they activate one (mergeGuest)
  let guests = {};
  // App Store purchases, '<environment>:<transactionId>' -> { sub, product, credit (cents, x quantity), at,
  //   refunded (ms, while refunded), never (a refund for a purchase that was never credited: it never will be) }
  let iap = {};
  // App Store Server Notifications already handled: notificationUUID -> when (kept 40 days)
  let notes = {};
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
    if (old && old.guests && typeof old.guests === 'object') guests = old.guests;
    if (old && old.iap && typeof old.iap === 'object') iap = old.iap;
    if (old && old.notes && typeof old.notes === 'object') notes = old.notes;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const state = () => JSON.stringify({ accounts, checkouts, guests, iap, notes });
  // guest progress nobody has played online with for two months goes (at start, then daily)
  const GUEST_KEEP_MS = 61 * 864e5;
  function pruneGuests() {
    let n = 0;
    for (const [k, g] of Object.entries(guests)) if (!g || !(Date.now() - (g.at || 0) < GUEST_KEEP_MS)) { delete guests[k]; n++; }
    return n;
  }
  // a deleted account is kept (hidden, signed out everywhere) for DELETE_KEEP_MS so its owner can restore it by signing
  // in again; then it goes for good (at start, then daily)
  const DELETE_KEEP_MS = 14 * 864e5;
  const deleteGone = (a) => a && a.deleting && !(Date.now() - a.deleting < DELETE_KEEP_MS);
  function pruneDeleted() {
    let n = 0;
    for (const [k, a] of Object.entries(accounts)) if (deleteGone(a)) { delete accounts[k]; n++; }
    return n;
  }
  const NOTES_KEEP_MS = 40 * 864e5;   // Apple retries a notification for 3 days at most
  function pruneNotes() {
    let n = 0;
    for (const [k, at] of Object.entries(notes)) if (!(Date.now() - at < NOTES_KEEP_MS)) { delete notes[k]; n++; }
    return n;
  }
  pruneGuests(); pruneDeleted(); pruneNotes();
  setInterval(() => { if (pruneGuests() + pruneDeleted() + pruneNotes()) { statsChanged(); reindex(); } }, 864e5).unref();
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
      if (p && p.iap === 'apple') { if (iapApply(p.kind, p.key, { sub: p.sub, product: p.product, credit: p.credit, at: Date.parse(p.at) })) n++; continue; }
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
  // iOS accounts: appAccountToken -> sub, '<environment>:<appTransactionId>' -> sub
  const byAppleToken = new Map(), byAppTx = new Map();
  const reindex = () => {
    byToken.clear(); byAppleToken.clear(); byAppTx.clear();
    for (const a of Object.values(accounts)) {
      for (const h of a.sessions || []) byToken.set(h, a.sub);
      if (a.apple) { byAppleToken.set(a.apple.token, a.sub); byAppTx.set(a.apple.env + ':' + a.apple.appTx, a.sub); }
    }
  };
  reindex();

  // ---- Google ----
  let jwks = { keys: new Map(), until: 0, at: 0 };
  async function googleKey(kid) {
    if (Date.now() > jwks.until || !jwks.keys.has(kid)) {
      // an unknown kid refetches the keys (rotation), but not more than once a minute: a made-up kid shouldn't
      // turn every bad token into a request to Google
      if (!jwks.keys.has(kid) && Date.now() - jwks.at < 60e3 && Date.now() <= jwks.until) return null;
      jwks.at = Date.now();
      const r = await fetch(JWKS_URL);
      if (!r.ok) throw new Error('google keys ' + r.status);
      const maxAge = +((/max-age=(\d+)/.exec(r.headers.get('cache-control') || '') || [])[1] || 3600);
      const j = await r.json();
      jwks = { keys: new Map(j.keys.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])), until: Date.now() + maxAge * 1000, at: Date.now() };
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

  // ---- Discord ----
  // state -> { origin, at }: one per sign-in started here (the browser also holds it in a cookie, so a callback only
  // signs in the browser that started it); handoff code -> { token, at }: the callback hands the session token to the
  // page through a one-time code in the URL fragment, never the token itself
  const discordStates = new Map(), handoffs = new Map();
  const FLOW_MS = 10 * 60e3, HANDOFF_MS = 2 * 60e3;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of discordStates) if (now - v.at > FLOW_MS) discordStates.delete(k);
    for (const [k, v] of handoffs) if (now - v.at > HANDOFF_MS) handoffs.delete(k);
  }, 60e3).unref();
  const STATE_COOKIE = 'rkr_discord';
  const discordRedirect = (origin) => origin + '/api/account/discord/callback';
  // a Discord authorization code -> the Discord user ({ id, username, global_name }), or throws
  async function discordUser(code, origin) {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(discordId + ':' + discordSecret).toString('base64') },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: discordRedirect(origin) }),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) throw new Error('discord token ' + r.status + ' ' + (t.error || ''));
    const u = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + t.access_token } });
    const j = await u.json().catch(() => ({}));
    if (!u.ok || !/^\d{1,25}$/.test(String(j.id || ''))) throw new Error('discord user ' + u.status);
    // we only needed who it is: hand the access token back (best effort)
    fetch('https://discord.com/api/oauth2/token/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(discordId + ':' + discordSecret).toString('base64') },
      body: new URLSearchParams({ token: t.access_token, token_type_hint: 'access_token' }),
    }).catch(() => {});
    return j;
  }
  // GET /api/account/discord?origin=...: off to Discord's consent screen
  function discordStart(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const origin = origins.has(q.get('origin')) ? q.get('origin') : [...origins][0];
    if (!discordOn) { res.writeHead(302, { Location: origin + '/#signin-error=off', 'Cache-Control': 'no-store' }).end(); return; }
    const state = crypto.randomBytes(18).toString('base64url');
    discordStates.set(state, { origin, at: Date.now() });
    const to = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: discordId, scope: 'identify', state, redirect_uri: discordRedirect(origin), prompt: 'none',
    });
    res.writeHead(302, {
      Location: to, 'Cache-Control': 'no-store',
      'Set-Cookie': `${STATE_COOKIE}=${state}; Path=/api/account/discord; Max-Age=600; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`,
    }).end();
  }
  // GET /api/account/discord/callback?code&state: back from Discord; signs in and returns to the game
  async function discordCallback(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const state = String(q.get('state') || '');
    const cookie = (new RegExp('(?:^|;\\s*)' + STATE_COOKIE + '=([\\w-]+)').exec(req.headers.cookie || '') || [])[1];
    const flow = discordStates.get(state);
    discordStates.delete(state);
    const back = (hash) => res.writeHead(302, {
      Location: ((flow && flow.origin) || [...origins][0]) + '/#' + hash, 'Cache-Control': 'no-store',
      'Set-Cookie': `${STATE_COOKIE}=; Path=/api/account/discord; Max-Age=0; HttpOnly; SameSite=Lax`,
    }).end();
    if (!flow || !cookie || cookie !== state || Date.now() - flow.at > FLOW_MS) return back('signin-error=expired');
    if (q.get('error')) return back('signin-error=' + (q.get('error') === 'access_denied' ? 'denied' : 'failed'));
    const code = String(q.get('code') || '');
    if (!/^[\w-]{10,100}$/.test(code)) return back('signin-error=failed');
    let u;
    try { u = await discordUser(code, flow.origin); } catch (e) { console.error('discord sign-in failed:', e.message); return back('signin-error=failed'); }
    const sub = 'discord_' + u.id;
    if (deleteGone(accounts[sub])) delete accounts[sub];   // (its grace period is over: a new account)
    const a = accounts[sub] ||= { sub, via: 'discord', email: '', name: '', paid: 0, created: new Date().toISOString(), sessions: [], payments: [] };
    a.name = cleanName(u.global_name || u.username);
    let token;
    try { token = newSession(a); } catch (e) { console.error('discord sign-in failed:', e.message); return back('signin-error=failed'); }
    const handoff = crypto.randomBytes(18).toString('base64url');
    handoffs.set(handoff, { token, at: Date.now() });
    back('signin=' + handoff);
  }

  // ---- App Store (the iOS app's in-app purchases) ----
  // Who an iOS player is: the App Store account that installed the app. The app sends its signed app transaction
  // (AppTransaction, iOS 16+); its appTransactionId is the same on every device and reinstall of that App Store account,
  // so linking again (Restore Purchases, or quietly at launch) finds the same swag account: no sign-in, no email.
  // Sandbox (TestFlight, sandbox testers, App Review) gets its own accounts, never mixed with real ones.
  // Each purchase carries the account's appAccountToken (set when buying), so it's credited to that account only.
  function appleLink(m) {
    let at;
    try { at = appStore.appTransaction(m.appTransaction); }
    catch (e) { console.error('app transaction rejected:', e.message); return { ok: false, msg: 'Could not check your App Store account. Try again in a moment.' }; }
    const envName = at.receiptType, appTx = String(at.appTransactionId || '');
    if (!/^[\w-]{1,64}$/.test(appTx)) return { ok: false, msg: 'Your App Store account could not be checked. Update iOS, then try again.' };
    let a = accounts[byAppTx.get(envName + ':' + appTx)] || null;
    if (a && deleteGone(a)) { delete accounts[a.sub]; reindex(); a = null; }   // (its grace period is over: a new account)
    let made = false;
    if (!a) {
      if (!m.create) return { ok: true, found: false };
      const sub = 'ios_' + crypto.randomBytes(12).toString('hex');
      a = accounts[sub] = { sub, via: 'apple', email: '', name: '', paid: 0, created: new Date().toISOString(), sessions: [], payments: [],
        apple: { env: envName, appTx, token: crypto.randomUUID() } };
      made = true;
    }
    let token;
    try { token = newSession(a); } catch (e) { if (made) delete accounts[a.sub]; throw e; }
    return { ok: true, found: true, token, account: pub(a), appAccountToken: a.apple.token };
  }
  // the account a verified transaction pays for: the one whose appAccountToken it carries; else (its account was
  // deleted for good, or none was set) the one of the same App Store account; the environments must match
  function iapOwner(t) {
    const tok = typeof t.appAccountToken === 'string' ? t.appAccountToken.toLowerCase() : '';
    const byTok = tok ? accounts[byAppleToken.get(tok)] : null;
    if (byTok) return byTok.apple.env === t.environment ? byTok : null;
    return (t.appTransactionId && accounts[byAppTx.get(t.environment + ':' + t.appTransactionId)]) || null;
  }
  // one App Store ledger event onto the state: 'purchase' (credit it once), 'refund' (take it back once; a refund of
  // a purchase never credited leaves a marker so it never will be), 'reversed' (Apple undid the refund: credit again).
  // Used live and to replay payments.jsonl. -> { a (the account changed, if any) } or null if it was already applied.
  function iapWould(kind, key) {
    const cur = iap[key];
    return kind === 'purchase' ? !cur : kind === 'refund' ? !(cur && cur.refunded) : kind === 'reversed' ? !!(cur && cur.refunded) : false;
  }
  function iapApply(kind, key, rec) {
    if (typeof key !== 'string' || !iapWould(kind, key)) return null;
    const cur = iap[key];
    let delta = 0;
    if (kind === 'purchase') { iap[key] = { sub: rec.sub, product: rec.product, credit: rec.credit, at: rec.at }; delta = rec.credit; }
    else if (kind === 'refund') {
      if (!cur) { iap[key] = { sub: rec.sub || null, product: rec.product, credit: rec.credit, at: rec.at, refunded: rec.at, never: true }; return { a: null }; }
      cur.refunded = rec.at; delta = -cur.credit;
    } else {
      if (cur.never) { delete iap[key]; return { a: null }; }
      delete cur.refunded; delta = cur.credit;
    }
    const a = accounts[iap[key].sub] || null;
    if (a) a.paid = Math.max(0, (Number(a.paid) || 0) + (Number(delta) || 0));
    return { a };
  }
  // a purchase's ledger key: environment + transaction id (StoreKit Testing in Xcode restarts its ids at 0 whenever its
  // transactions are cleared, so there the purchase time goes in too)
  const iapKey = (t) => t.environment + ':' + t.transactionId + (t.environment === 'Xcode' ? ':' + t.purchaseDate : '');
  // live: the ledger line first (replayed on startup, like a Stripe payment), then the account file
  function iapEvent(kind, t, sub) {
    const key = iapKey(t);
    if (!iapWould(kind, key)) return null;
    const p = IAP_BY_ID.get(t.productId);
    const qty = Number.isInteger(t.quantity) && t.quantity > 1 ? t.quantity : 1;
    const rec = { sub: sub || null, product: t.productId, credit: p.credit * qty, at: Date.now() };
    logPayment({ at: new Date(rec.at).toISOString(), iap: 'apple', kind, key, sub: rec.sub, product: rec.product, credit: rec.credit,
      storefront: t.storefront, price: t.price, currency: t.currency });
    const r = iapApply(kind, key, rec);
    saveNow();
    const a = r && r.a;
    console.log(`app store ${kind}: ${key} ${rec.product}${a ? ` ${a.sub} = ${((Number(a.paid) || 0) / 100).toFixed(2)}` : ''}`);
    return r;
  }
  // the app sends a signed transaction (a purchase just made, or one waiting since: Ask to Buy, a crash, no network)
  // -> credit it once. `finish`: the app may finish the transaction now (credited, or nothing left to deliver).
  function applePurchase(a, m) {
    let t;
    try { t = appStore.transaction(m.transaction); }
    catch (e) { console.error('app store transaction rejected:', e.message); return { ok: false, finish: false, msg: 'Could not check this purchase with the App Store. Try again in a moment.' }; }
    const p = IAP_BY_ID.get(t.productId);
    if (!p || t.type !== 'Consumable') { console.error('app store: unknown product', t.productId, t.type); return { ok: false, finish: false, msg: 'Unknown item. Update the app, then try again.' }; }
    const key = iapKey(t);
    if (testing) console.log('app store transaction:', JSON.stringify({ id: t.transactionId, product: t.productId, env: t.environment, at: t.purchaseDate,
      revoked: t.revocationDate || null, token: t.appAccountToken || null, appTx: t.appTransactionId || null, qty: t.quantity }));
    const owner = iapOwner(t);
    if (t.revocationDate) {
      // refunded before it got here: nothing to deliver (and if it was credited, take that back now)
      iapEvent('refund', t, owner && owner.sub);
      return { ok: true, finish: true, refunded: true, account: pub(a) };
    }
    if (!owner) {
      if (iap[key]) return { ok: true, finish: true, account: pub(a) };   // (handled already, e.g. refunded)
      console.error('app store: no account for', key);
      return { ok: false, finish: false, msg: 'This purchase belongs to another App Store account.' };
    }
    const fresh = !!iapEvent('purchase', t, owner.sub);
    return { ok: true, finish: true, credited: fresh, account: pub(owner === a || !a ? owner : a) };
  }
  // POST /api/apple/notifications: App Store Server Notifications V2 (refunds; purchases too, as a backup when the
  // app couldn't reach us). 200 only once handled and saved: Apple retries anything else for 3 days (production).
  function appleNotification(req, res) {
    readBody(req, 1 << 17, (raw) => {
      let n;
      try { n = appStore.notification(JSON.parse(raw.toString('utf8')).signedPayload); }
      catch (e) { console.error('app store notification rejected:', e.message); return reply(res, 400, { ok: false }); }
      if (notes[n.uuid]) return reply(res, 200, { ok: true });
      try {
        const t = n.transaction;
        if (t && IAP_BY_ID.has(t.productId)) {
          const owner = iapOwner(t);
          if (n.type === 'REFUND') iapEvent('refund', t, owner && owner.sub);
          else if (n.type === 'REFUND_REVERSED') iapEvent('reversed', t, owner && owner.sub);
          else if (n.type === 'ONE_TIME_CHARGE' && !t.revocationDate && owner) iapEvent('purchase', t, owner.sub);
        }
        console.log('app store notification:', n.type, n.subtype, n.env, t ? t.transactionId : '');
        notes[n.uuid] = Date.now();
        saveNow();
      } catch (e) { console.error('app store notification failed:', e.message); return reply(res, 500, { ok: false }); }
      reply(res, 200, { ok: true });
    });
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
  // (a deleted account waiting out its grace period is not active: nothing shown or counted)
  const active = (a) => (Number(a && a.paid) || 0) > 0 && !(a && a.deleting);
  const pub = (a) => (a ? { name: a.name, email: a.email, via: a.via || 'google', sandbox: !!(a.apple && a.apple.env !== 'Production'), appAccountToken: a.apple ? a.apple.token : undefined, paid: Number(a.paid) || 0, active: active(a), show: !a.hide, unlocks: unlocksOf(a),
    deleting: a.deleting ? new Date(a.deleting + DELETE_KEEP_MS).toISOString() : null,   // deleted: gone for good at this time
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
  const paidFor = (token) => { const a = fromToken(token); return a && !a.hide && !a.deleting ? Number(a.paid) || 0 : 0; };
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
    for (const f of FEAT_IDS) { u[f] ||= {}; for (const m of UNLOCK_MODES) u[f][m] = Number(u[f][m]) || 0; }
    // the medic badge counts revives from its start; a swag account brings the ones its stats counted before (once)
    if (u.rev.past == null) u.rev.past = Number(a.stats && a.stats.online && a.stats.online.revives) || 0;
    // the offline track (Solo and Local, one track): reported by the browser, so worn offline only (account.js)
    u.solo ||= {};
    for (const f of FEAT_IDS) { u.solo[f] ||= {}; for (const m of UNLOCK_MODES) u.solo[f][m] = Number(u.solo[f][m]) || 0; }
    u.off ||= {};
    return u;
  }
  // who's playing: { sub (account id, maybe not active), pid (the browser's progress id) } or just an account id.
  // An active account keeps its own progress; anyone else keeps it under their progress id.
  const PID = /^[a-z0-9]{24,40}$/;
  const validPid = (p) => (typeof p === 'string' && PID.test(p) ? p : '');
  function holderOf(who, create = false) {
    const sub = typeof who === 'string' ? who : who && who.sub;
    const a = sub && accounts[sub];
    if (a && active(a)) return a;
    const pid = validPid(who && who.pid);
    if (!pid) return null;
    if (!guests[pid] && create) guests[pid] = { at: Date.now() };
    return guests[pid] || null;
  }
  // the game server: this kitty did a feat ('l8' | 'l9' | 'win') in a mode
  function recordFeat(who, feat, mode) {
    if (!FEAT_IDS.includes(feat) || !UNLOCK_MODES.includes(mode)) return;
    const h = holderOf(who, true);
    if (!h) return;
    unlocksOf(h)[feat][mode]++;
    if (h.sub == null) h.at = Date.now();
    statsChanged();
  }
  // the items worn in this game mode: unlocked in that mode (each mode earns its own) and switched on
  const switchedOn = (h, mode) => {
    if (!h || !mode) return [];
    const u = unlocksOf(h);
    return UNLOCKS.filter((x) => !x.song && isUnlocked(u, x, mode) && !u.off[x.id]).map((x) => x.id);   // (a song isn't worn)
  };
  // the unlocked items switched on (the game server sends them to everyone in the room)
  const cosFor = (token, mode) => { const a = fromToken(token); return a && active(a) ? switchedOn(a, mode) : []; };
  const cosForPlayer = (who, mode) => switchedOn(holderOf(who), mode);
  // this browser plays online: its guest progress (if any) is kept another two months from now
  function seenGuest(pid) { const g = (pid = validPid(pid)) && guests[pid]; if (g) { g.at = Date.now(); statsChanged(); } }
  // an account that is active now takes over this browser's guest progress (counts add up; its own switches stay)
  function mergeGuest(sub, pid) {
    const a = sub && accounts[sub], g = (pid = validPid(pid)) && guests[pid];
    if (!a || !active(a) || !g || !g.unlocks) return;
    const u = unlocksOf(a), gu = unlocksOf(g);
    for (const f of FEAT_IDS) for (const m of UNLOCK_MODES) u[f][m] += gu[f][m];
    for (const k of Object.keys(gu.off)) if (!(k in u.off)) u.off[k] = gu.off[k];
    delete guests[pid];
    statsChanged();
  }
  // a guest's own menu (no sign-in): its progress, and its switches
  function guestRoute(name, m) {
    const pid = validPid(m.pid);
    if (!pid) return { ok: false };
    const g = guests[pid];
    if (name === 'guest') return { ok: true, unlocks: g ? unlocksOf(g) : null };
    const item = UNLOCKS.find((x) => x.id === m.item && !x.song);   // (a song has no switch: it's picked in the settings)
    if (!g || !item || typeof m.on !== 'boolean') return { ok: false };
    const u = unlocksOf(g);
    if (!isUnlocked(u, item)) return { ok: false, msg: 'Not unlocked yet.' };
    if (m.on) delete u.off[item.id]; else u.off[item.id] = true;
    g.at = Date.now();
    statsChanged();
    return { ok: true, unlocks: u };
  }

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

  // one line onto payments.jsonl, on disk before anyone is told it worked (throws if it can't be written)
  function logPayment(line) {
    const fd = fs.openSync(paymentsFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      // A disk error can leave half a log entry. Separate it before retrying so recovery can read the new entry.
      const size = fs.fstatSync(fd).size, tail = Buffer.alloc(1);
      const separator = size && fs.readSync(fd, tail, 0, 1, size - 1) === 1 && tail[0] !== 10 ? '\n' : '';
      fs.writeFileSync(fd, separator + JSON.stringify(line) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
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
    logPayment(line);
    a.payments = [...(a.payments || []), s.id];
    a.paid = line.total;
    delete checkouts[s.id];
    // Keep the binding on failure so a webhook retry commits the snapshot without appending/crediting twice.
    try { saveNow(); } catch (e) { checkouts[s.id] = c; throw e; }
    console.log(`payment: ${a.email || a.sub} +${(s.amount_total / 100).toFixed(2)} = ${(a.paid / 100).toFixed(2)}`);
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
    if (name === 'config') return { ok: true, enabled, googleClientId: clientIds[0] || null, discord: discordOn,
      iap: iapOn ? IAP_PRODUCTS.map(({ id, credit }) => ({ id, credit })) : null, min: MIN_CENTS, max: STRIPE_MAX_CENTS, currency: CURRENCY };
    if (name === 'guest' || name === 'guestequip') {
      let gm = {};
      if (body) { try { gm = JSON.parse(body) || {}; } catch { return { ok: false }; } }
      return guestRoute(name, gm);
    }
    const closed = { ok: false, msg: 'Accounts are not open yet.' };
    if (!enabled && !iapOn) return closed;
    let m = {};
    if (body) { try { m = JSON.parse(body) || {}; } catch { return { ok: false }; } }
    if (name === 'apple/link') return iapOn ? appleLink(m) : closed;
    if (name === 'google') {
      if (!enabled) return closed;
      let c;
      try { c = await verifyGoogle(m.credential); } catch (e) { return { ok: false, msg: 'Google sign-in did not work, try again.' }; }
      if (c.email_verified === false) return { ok: false, msg: 'That Google account has no verified email.' };
      if (deleteGone(accounts[c.sub])) delete accounts[c.sub];   // (its grace period is over: a new account)
      const a = accounts[c.sub] ||= { sub: c.sub, email: '', name: '', paid: 0, created: new Date().toISOString(), sessions: [], payments: [] };
      a.email = String(c.email || '').slice(0, 120);
      a.name = cleanName(c.given_name || c.name);
      return { ok: true, token: newSession(a), account: pub(a) };
    }
    if (name === 'handoff') {
      // the page, back from the Discord callback: its one-time code -> the session token
      const h = handoffs.get(String(m.code || ''));
      handoffs.delete(String(m.code || ''));
      const a = h && Date.now() - h.at <= HANDOFF_MS ? fromToken(h.token) : null;
      if (!a) return { ok: false, msg: 'Sign-in timed out, try again.' };
      return { ok: true, token: h.token, account: pub(a) };
    }
    const a = fromToken(bearer(req));
    if (!a) return { ok: false, signedOut: true };
    if (name === 'me') return { ok: true, account: pub(a) };
    // (a real payment is credited even to an account waiting out its deletion)
    if (name === 'apple/purchase') return iapOn ? applePurchase(a, m) : closed;
    if (name === 'restore') {
      // a deleted account, signed in again within its grace period: back as it was
      if (!a.deleting) return { ok: true, account: pub(a) };
      const at = a.deleting;
      delete a.deleting;
      try { saveNow(); } catch (e) { a.deleting = at; throw e; }
      return { ok: true, account: pub(a) };
    }
    if (a.deleting && name !== 'logout') return { ok: false, msg: 'This account is deleted. Restore it first.' };
    if (name === 'pay') {
      if (!enabled || a.apple) return closed;   // (iOS accounts pay through the App Store)
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
      // only a checkout this player started here is ever looked up (no asking Stripe about other people's sessions)
      if (!checkouts[m.session] && !(a.payments || []).includes(m.session)) return { ok: false };
      const s = await stripe('GET', '/checkout/sessions/' + m.session);
      if (s.id !== m.session || (!checkouts[s.id] && !(a.payments || []).includes(s.id))) return { ok: false };
      if (s.client_reference_id !== a.sub) return { ok: false };
      credit(s);
      return { ok: true, paid: s.payment_status === 'paid', account: pub(a) };
    }
    if (name === 'equip') {
      // an unlocked item on / off (the player's own switch)
      const item = UNLOCKS.find((x) => x.id === m.item && !x.song);
      if (!item || typeof m.on !== 'boolean') return { ok: false };
      const u = unlocksOf(a);
      if (!active(a)) return { ok: false, msg: 'Activate your swag account first.' };
      if (!isUnlocked(u, item) && !isUnlocked(u.solo, item)) return { ok: false, msg: 'Not unlocked yet.' };   // (online or offline)
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
      // offline unlock progress ({ feat: count } in this mode): only ever worn offline, so a faked one shows only to its
      // own player. (Capped per report; bigger when a browser's own track moves onto the account.)
      if (m.solo && typeof m.solo === 'object' && active(a)) {
        const u = unlocksOf(a);
        for (const f of FEAT_IDS) { const n = count(m.solo[f], f === 'rev' ? 5000 : 50); if (n) u.solo[f][mode] += n; }
        statsChanged();
      }
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
      // only with DELETE typed in the menu (no account goes by an accidental click, or an old page's one-click delete)
      if (m.confirm !== 'DELETE') return { ok: false, msg: 'Type DELETE to delete your account.' };
      // hidden and signed out everywhere now, gone for good after DELETE_KEEP_MS (pruneDeleted; signing in again within
      // that time can restore it); payments.jsonl keeps its lines (bookkeeping)
      const previous = a.sessions;
      a.deleting = Date.now(); a.sessions = [];
      try { saveNow(); } catch (e) { delete a.deleting; a.sessions = previous; throw e; }
      reindex();
      return { ok: true, until: new Date(a.deleting + DELETE_KEEP_MS).toISOString() };
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
    if (name === 'discord' && req.method === 'GET') { discordStart(req, res); return true; }
    if (name === 'discord/callback' && req.method === 'GET') {
      discordCallback(req, res).catch((e) => { console.error('discord sign-in failed:', e.message); if (!res.headersSent) reply(res, 502, { ok: false }); });
      return true;
    }
    if (!['google', 'handoff', 'apple/link', 'apple/purchase', 'me', 'pay', 'confirm', 'show', 'equip', 'guest', 'guestequip', 'progress', 'logout', 'delete', 'restore'].includes(name)) return false;
    if (req.method !== (name === 'me' ? 'GET' : 'POST')) { reply(res, 405, { ok: false }); return true; }
    const go = (body) => route(name, req, body)
      .then((j) => reply(res, j ? 200 : 404, j || { ok: false }))
      .catch((e) => { console.error('account', name, 'failed:', e.message); reply(res, 502, { ok: false, msg: 'Something went wrong, try again in a moment.' }); });
    if (req.method === 'GET') go(''); else readBody(req, name.startsWith('apple/') ? 32768 : 8192, (raw) => go(raw.toString('utf8')));
    return true;
  }

  return { enabled, handle, webhook, appleNotification, paidFor, subFor, cosFor, cosForPlayer, mergeGuest, seenGuest, validPid, recordOnline, recordFeat, flush };
}

// One credit per player, however many of its tabs are in the game: of these kitties (members: { acct, pid }), the
// ones that count, in order. A kitty doesn't when one before it has the same account or the same browser (progress
// id): 10 tabs in one lobby still clear a level once. (Kitties with neither have nothing to count on anyway.)
function onePerPlayer(members) {
  const seen = new Set();
  return members.filter((m) => {
    const keys = [m && m.acct && 'a:' + m.acct, m && m.pid && 'p:' + m.pid].filter(Boolean);
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
}
// the same player (account or browser) behind both kitties: reviving your own other tab doesn't count
const samePlayer = (a, b) => !!(a && b && ((a.acct && a.acct === b.acct) || (a.pid && a.pid === b.pid)));

export { createAccounts, onePerPlayer, samePlayer };
