// Optional player accounts: sign in with Google, chip in any amount (min $0.50) through Stripe Checkout, and the total
// you've paid shows next to your kitty's name online (a lowkey flex). Nothing else depends on an account.
// An account only counts once something is paid; signing in alone just lets you pay.
//
// No SDKs: Google ID tokens are checked against Google's public keys (JWKS) with node:crypto, and Stripe is plain
// HTTPS (fetch) plus its webhook signature (HMAC). State is one JSON file, saved atomically like legends.json;
// every credited payment is also appended to payments.jsonl next to it (bookkeeping, never rewritten).
//
// Env: GOOGLE_CLIENT_ID (comma-separate several: web + iOS/Android clients), STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, PUBLIC_ORIGIN (where Checkout returns to, default https://runkittyrun.fun).
// Without GOOGLE_CLIENT_ID + STRIPE_SECRET_KEY accounts are off and the client hides the button.
import crypto from 'node:crypto';
import fs from 'node:fs';

const MIN_CENTS = 50;              // Stripe's minimum charge in USD
const MAX_CENTS = 100000;          // per payment ($1000): catches typos
const CURRENCY = 'usd';
const MAX_SESSIONS = 10;           // signed-in devices per account
const SAVE_DELAY_MS = 1000;
const GOOGLE_ISS = ['accounts.google.com', 'https://accounts.google.com'];
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

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
  const paymentsFile = file.replace(/[^/]*$/, 'payments.jsonl');

  // sub (Google user id) -> { sub, email, name, paid (cents), created, sessions: [sha256 of token], payments: [stripe session ids] }
  let accounts = {};
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old && old.accounts && typeof old.accounts === 'object') accounts = old.accounts;
  } catch { /* first run */ }
  const byToken = new Map();   // sha256(token) -> sub
  const reindex = () => { byToken.clear(); for (const a of Object.values(accounts)) for (const h of a.sessions || []) byToken.set(h, a.sub); };
  reindex();

  let saveT = null;
  function save() {
    saveT = null;
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify({ accounts }), (err) => {
      if (err) { console.error('accounts save failed:', err.message); return; }
      fs.rename(tmp, file, (e) => { if (e) console.error('accounts save failed:', e.message); });
    });
  }
  const changed = () => { if (!saveT) saveT = setTimeout(save, SAVE_DELAY_MS); };
  function flush() {
    if (!saveT) return;
    clearTimeout(saveT); saveT = null;
    try { fs.writeFileSync(file, JSON.stringify({ accounts })); } catch (e) { console.error('accounts flush failed:', e.message); }
  }

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
      headers: { Authorization: 'Bearer ' + stripeKey, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? form(body) : undefined,
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'stripe ' + r.status);
    return j;
  }

  // ---- accounts ----
  const pub = (a) => (a ? { name: a.name, email: a.email, paid: a.paid | 0 } : null);
  function newSession(a) {
    const token = crypto.randomBytes(24).toString('base64url');
    const h = sha(token);
    a.sessions = [...(a.sessions || []), h].slice(-MAX_SESSIONS);
    reindex();
    changed();
    return token;
  }
  const fromToken = (token) => {
    if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
    const sub = byToken.get(sha(token));
    return (sub && accounts[sub]) || null;
  };
  // total paid (cents) for a session token, 0 if none / unpaid: what the game server shows next to the name
  const paidFor = (token) => { const a = fromToken(token); return a ? a.paid | 0 : 0; };

  // credit a paid Checkout Session once (from the webhook or the return trip, whichever comes first)
  function credit(s) {
    if (!s || s.payment_status !== 'paid' || s.currency !== CURRENCY || s.mode !== 'payment') return null;
    const a = accounts[s.client_reference_id];
    if (!a) { console.error('paid session for unknown account', s.id); return null; }
    if ((a.payments || []).includes(s.id)) return a;
    a.payments = [...(a.payments || []), s.id];
    a.paid = (a.paid | 0) + (s.amount_total | 0);
    changed();
    const line = { at: new Date().toISOString(), session: s.id, sub: a.sub, email: a.email, amount: s.amount_total, currency: s.currency, total: a.paid };
    fs.appendFile(paymentsFile, JSON.stringify(line) + '\n', (e) => { if (e) console.error('payments log failed:', e.message); });
    console.log(`payment: ${a.email} +${(s.amount_total / 100).toFixed(2)} = ${(a.paid / 100).toFixed(2)}`);
    return a;
  }

  // ---- HTTP ----
  const reply = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  function readBody(req, max, cb) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > max) req.destroy(); });
    req.on('end', () => cb(body));
  }
  const bearer = (req) => (/^Bearer (\S+)$/.exec(req.headers.authorization || '') || [])[1];

  async function route(name, req, body) {
    if (name === 'config') return { ok: true, enabled, googleClientId: clientIds[0] || null, min: MIN_CENTS, max: MAX_CENTS, currency: CURRENCY };
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
      const cents = Math.round(+m.cents);
      if (!(cents >= MIN_CENTS && cents <= MAX_CENTS)) return { ok: false, msg: `Pick between $${(MIN_CENTS / 100).toFixed(2)} and $${MAX_CENTS / 100}.` };
      const origin = origins.has(m.origin) ? m.origin : [...origins][0];
      const s = await stripe('POST', '/checkout/sessions', {
        mode: 'payment', client_reference_id: a.sub, customer_email: a.email || undefined, submit_type: 'pay',
        line_items: { 0: { quantity: 1, price_data: { currency: CURRENCY, unit_amount: cents,
          product_data: { name: 'Run Kitty Run: your number', description: 'Adds to the total shown next to your kitty online. One-time, cosmetic only.' } } } },
        metadata: { sub: a.sub },
        payment_intent_data: { description: 'Run Kitty Run account', metadata: { sub: a.sub } },
        success_url: `${origin}/?paid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?paid=cancel`,
      });
      return { ok: true, url: s.url };
    }
    if (name === 'confirm') {
      // back from Checkout: ask Stripe directly so it doesn't wait on the webhook
      if (!/^cs_[\w]+$/.test(String(m.session || ''))) return { ok: false };
      const s = await stripe('GET', '/checkout/sessions/' + m.session);
      if (s.client_reference_id !== a.sub) return { ok: false };
      credit(s);
      return { ok: true, paid: s.payment_status === 'paid', account: pub(a) };
    }
    if (name === 'logout') {
      const h = sha(bearer(req));
      a.sessions = (a.sessions || []).filter((x) => x !== h);
      reindex(); changed();
      return { ok: true };
    }
    if (name === 'delete') {
      // personal data goes; payments.jsonl keeps its lines (bookkeeping)
      delete accounts[a.sub];
      reindex(); changed();
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
      const want = hookSecret && t ? crypto.createHmac('sha256', hookSecret).update(`${t}.${raw}`).digest('hex') : '';
      const ok = want && Math.abs(Date.now() / 1000 - +t) < 300
        && v1s.some((v) => v.length === want.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(want)));
      if (!ok) return reply(res, 400, { ok: false });
      let ev;
      try { ev = JSON.parse(raw); } catch { return reply(res, 400, { ok: false }); }
      if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') credit(ev.data && ev.data.object);
      reply(res, 200, { ok: true });
    });
  }

  // /api/account/<name>; returns false if it isn't one of ours
  function handle(req, res, name) {
    if (name === 'config' && req.method === 'GET') { route('config', req).then((j) => reply(res, 200, j)); return true; }
    if (!['google', 'me', 'pay', 'confirm', 'logout', 'delete'].includes(name)) return false;
    if (req.method !== (name === 'me' ? 'GET' : 'POST')) { reply(res, 405, { ok: false }); return true; }
    const go = (body) => route(name, req, body)
      .then((j) => reply(res, j ? 200 : 404, j || { ok: false }))
      .catch((e) => { console.error('account', name, 'failed:', e.message); reply(res, 502, { ok: false, msg: 'Something went wrong, try again in a moment.' }); });
    if (req.method === 'GET') go(''); else readBody(req, 8192, go);
    return true;
  }

  return { enabled, handle, webhook, paidFor, flush };
}

export { createAccounts };
