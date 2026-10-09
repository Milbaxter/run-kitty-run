// iOS in-app purchase server test (accounts.js + appstore.js): starts its own server on a free port with temp state
// and a test certificate chain made with openssl (root -> intermediate -> leaf, with Apple's marker OIDs), trusted
// through APPLE_IAP_TEST_ROOTS (honoured only outside production). Signs StoreKit-style JWS (transactions, app
// transactions, App Store Server Notifications V2) the way the App Store does, then checks:
//   link / restore by App Store account, purchase credit, replay, tampering, untrusted chain, other app, unknown
//   product, quantity, sandbox kept apart, Xcode data refused, the appAccountToken owner, refunds (client + notification,
//   duplicates, reversal, refund before credit), notification backup credit, payments.jsonl recovery, deletion.
// --ui: also the game's purchase screen in headless Chrome (Playwright, PLAYWRIGHT_DIR as in render-lib.mjs; PW_CHANNEL
//   picks an installed browser, e.g. chrome) with a stand-in for the iOS Store plugin that signs like the App Store:
//   prices shown, cancel / failure / success / Ask to Buy / no connection then relaunch / reinstall / restore / refund /
//   delete, and the App Review screenshots of the purchase screen (store/iap/).
// Usage: node scripts/iap-test.mjs [--ui]   (needs openssl). Never point it at the live server.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppStore } from '../server/appstore.js';
import { loadPlaywright } from './render-lib.mjs';

const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) process.exitCode = 1; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-iap-test-'));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const BUNDLE = 'io.runkittyrun.app', APP_ID = 6820576828;
const SMALL = 'io.runkittyrun.app.swag.small', MEDIUM = 'io.runkittyrun.app.swag.medium';

// ---------------------------------------------------------------- test PKI (openssl)
function pki(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  const ssl = (...a) => execFileSync('openssl', a, { stdio: 'pipe' });
  fs.writeFileSync(f('ext.cnf'), [
    '[mid]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', '1.2.840.113635.100.6.2.1=ASN1:NULL',
    '[leaf]', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', '1.2.840.113635.100.6.11.1=ASN1:NULL',
    '[plain]', 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', ''].join('\n'));
  ssl('ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', f('root.key'));
  ssl('req', '-x509', '-new', '-key', f('root.key'), '-subj', `/CN=${name} Root`, '-days', '3650', '-sha384', '-out', f('root.pem'),
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  for (const [k, issuer, ext, curve] of [['mid', 'root', 'mid', 'secp384r1'], ['leaf', 'mid', 'leaf', 'prime256v1'], ['plain', 'mid', 'plain', 'prime256v1']]) {
    ssl('ecparam', '-name', curve, '-genkey', '-noout', '-out', f(k + '.key'));
    ssl('req', '-new', '-key', f(k + '.key'), '-subj', `/CN=${name} ${k}`, '-out', f(k + '.csr'));
    ssl('x509', '-req', '-in', f(k + '.csr'), '-CA', f(issuer + '.pem'), '-CAkey', f(issuer + '.key'), '-CAcreateserial', '-days', '3650',
      '-sha384', '-extfile', f('ext.cnf'), '-extensions', ext, '-out', f(k + '.pem'));
  }
  const der = (k) => new crypto.X509Certificate(fs.readFileSync(f(k + '.pem'))).raw.toString('base64');
  return { rootPem: f('root.pem'), x5c: [der('leaf'), der('mid'), der('root')], x5cPlain: [der('plain'), der('mid'), der('root')],
    key: crypto.createPrivateKey(fs.readFileSync(f('leaf.key'))), plainKey: crypto.createPrivateKey(fs.readFileSync(f('plain.key'))) };
}
const good = pki(path.join(tmp, 'good'), 'Test');
const evil = pki(path.join(tmp, 'evil'), 'Evil');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jws(payload, { chain = good, x5c = chain.x5c, key = chain.key } = {}) {
  const h = b64({ alg: 'ES256', x5c }), p = b64(payload);
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${sig}`;
}
const now = () => Date.now();
const appTx = (id, env = 'Production', extra = {}) => jws({ receiptType: env, appAppleId: APP_ID, bundleId: BUNDLE, appTransactionId: id,
  originalPurchaseDate: now() - 864e5, receiptCreationDate: now(), signedDate: now(), applicationVersion: '1', ...extra });
let txSeq = 2000000000000000;
const tx = (product, token, extra = {}) => {
  const id = String(++txSeq);
  return { id, jws: jws({ transactionId: id, originalTransactionId: id, bundleId: BUNDLE, productId: product, type: 'Consumable',
    purchaseDate: now(), originalPurchaseDate: now(), signedDate: now(), quantity: 1, environment: 'Production', inAppOwnershipType: 'PURCHASED',
    storefront: 'FIN', price: 990, currency: 'EUR', ...(token ? { appAccountToken: token } : {}), ...extra }) };
};
const note = (type, t, env = 'Production', uuid = crypto.randomUUID(), opts) => jws({ notificationType: type, notificationUUID: uuid, version: '2.0',
  signedDate: now(), data: { appAppleId: APP_ID, bundleId: BUNDLE, environment: env, signedTransactionInfo: t } }, opts);

// ---------------------------------------------------------------- unit: appstore.js
{
  const store = createAppStore({ testRoots: [fs.readFileSync(good.rootPem, 'utf8')] });
  const t = tx(SMALL);
  ok(store.transaction(t.jws).productId === SMALL, 'unit: a transaction signed by a trusted chain verifies');
  const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  ok(throws(() => store.transaction(tx(SMALL).jws.replace(/\.[^.]+$/, '.' + Buffer.alloc(64).toString('base64url'))), /signature/), 'unit: a bad signature is refused');
  const [h, p, s] = t.jws.split('.');
  const forged = b64({ ...JSON.parse(Buffer.from(p, 'base64url')), productId: MEDIUM });
  ok(throws(() => store.transaction(`${h}.${forged}.${s}`), /signature/), 'unit: a changed payload is refused');
  ok(throws(() => store.transaction(jws({ transactionId: '1', bundleId: BUNDLE, productId: SMALL, environment: 'Production', signedDate: now() }, { chain: evil })), /untrusted/),
    'unit: a chain to another root is refused');
  ok(throws(() => store.transaction(jws({ transactionId: '1', bundleId: BUNDLE, productId: SMALL, environment: 'Production', signedDate: now() }, { x5c: good.x5cPlain, key: good.plainKey })), /App Store certificate/),
    'unit: a leaf without Apple\'s marker OID is refused');
  ok(throws(() => store.transaction(jws({ transactionId: '1', bundleId: BUNDLE, productId: SMALL, environment: 'Production', signedDate: now() }, { x5c: good.x5c.slice(0, 2) })), /chain/),
    'unit: a short chain is refused');
  ok(throws(() => store.transaction(jws({ transactionId: '1', bundleId: 'com.other.app', productId: SMALL, environment: 'Production', signedDate: now() })), /other app/), 'unit: another app\'s transaction is refused');
  ok(throws(() => store.transaction(jws({ transactionId: '1', bundleId: BUNDLE, productId: SMALL, environment: 'Xcode', signedDate: now() })), /environment/), 'unit: Xcode-signed data is refused by default');
  ok(throws(() => store.appTransaction(appTx('X', 'Production', { appAppleId: 1 })), /other app/), 'unit: a production app transaction of another App Store app is refused');
  const noSandbox = createAppStore({ testRoots: [fs.readFileSync(good.rootPem, 'utf8')], sandbox: false });
  ok(throws(() => noSandbox.transaction(tx(SMALL, null, { environment: 'Sandbox' }).jws), /environment/), 'unit: APPLE_IAP_SANDBOX=off refuses sandbox');
  ok(throws(() => createAppStore().transaction(t.jws), /untrusted/), 'unit: without the test root, the test chain is not trusted (only Apple Root CA - G3)');
}

// ---------------------------------------------------------------- server
const PORT = await freePort(), BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNTS = path.join(tmp, 'accounts.json'), PAYMENTS = path.join(tmp, 'payments.jsonl');
let srv;
async function start() {
  srv = spawn(process.execPath, ['server/index.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
    NODE_ENV: 'test', ACCOUNTS_FILE: ACCOUNTS, FEEDBACK_FILE: path.join(tmp, 'feedback.jsonl'), STATS_FILE: path.join(tmp, 'stats.json'),
    LEGENDS_FILE: path.join(tmp, 'legends.json'), REPORTS_FILE: path.join(tmp, 'reports.jsonl'),
    GOOGLE_CLIENT_ID: '', STRIPE_SECRET_KEY: '', DISCORD_CLIENT_ID: '', APPLE_IAP_TEST_ROOTS: good.rootPem } });
  srv.stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  srv.stdout.on('data', (d) => { if (process.env.VERBOSE) process.stdout.write(d); });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('server did not start');
}
const stop = () => new Promise((r) => { srv.once('exit', r); srv.kill(); });
let ipSeq = 0;
async function api(name, body, token) {
  const r = await fetch(`${BASE}/api/account/${name}`, { method: body === undefined ? 'GET' : 'POST',
    // (each request from its own address: the account routes are rate limited per IP)
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.${++ipSeq >> 8 & 255}.${ipSeq & 255}`, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
}
const notify = async (signedPayload) => (await fetch(`${BASE}/api/apple/notifications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedPayload }) })).status;

try {
  await start();
  const cfg = await api('config');
  ok(cfg.enabled === false && Array.isArray(cfg.iap) && cfg.iap.length === 4 && cfg.iap[0].credit === 99, 'config lists the in-app products (web accounts off)');
  ok((await api('google', { credential: 'x' })).ok === false, 'web sign-in stays closed when web accounts are off');

  // link: nothing yet, then a new account
  ok((await api('apple/link', { appTransaction: appTx('A1') })).found === false, 'link without create: no account yet');
  const L = await api('apple/link', { appTransaction: appTx('A1'), create: true });
  ok(L.ok && L.found && L.token && /^[0-9a-f-]{36}$/.test(L.appAccountToken) && L.account.via === 'apple' && L.account.paid === 0 && !L.account.sandbox,
    'link with create: a new iOS account, a session and its appAccountToken');
  ok((await api('apple/link', { appTransaction: appTx('A1', 'Production', { appAppleId: 42 }) })).ok === false, 'link: another app id is refused');
  ok((await api('apple/link', { appTransaction: jws({ receiptType: 'Production', appAppleId: APP_ID, bundleId: BUNDLE, appTransactionId: 'A1', signedDate: now() }, { chain: evil }) })).ok === false,
    'link: an app transaction from an untrusted chain is refused');

  // purchase, replay, tampering
  const t1 = tx(SMALL, L.appAccountToken.toUpperCase());   // (StoreKit's UUID strings are upper case)
  let r = await api('apple/purchase', { transaction: t1.jws }, L.token);
  ok(r.ok && r.finish && r.credited && r.account.paid === 99 && r.account.active, 'purchase: credited 0.99, account active, finish');
  r = await api('apple/purchase', { transaction: t1.jws }, L.token);
  ok(r.ok && r.finish && !r.credited && r.account.paid === 99, 'replaying the same transaction credits nothing (finish again)');
  const [h, p, s] = tx(SMALL, L.appAccountToken).jws.split('.');
  r = await api('apple/purchase', { transaction: `${h}.${b64({ ...JSON.parse(Buffer.from(p, 'base64url')), productId: 'io.runkittyrun.app.swag.mega' })}.${s}` }, L.token);
  ok(!r.ok && r.finish === false && (await api('me', undefined, L.token)).account.paid === 99, 'a tampered transaction is refused, nothing credited, not finished');
  r = await api('apple/purchase', { transaction: tx('io.runkittyrun.app.coins', L.appAccountToken).jws }, L.token);
  ok(!r.ok && r.finish === false, 'an unknown product is refused and left unfinished');
  r = await api('apple/purchase', { transaction: jws({ transactionId: '9', bundleId: BUNDLE, productId: SMALL, type: 'Consumable', environment: 'Production', signedDate: now(), appAccountToken: L.appAccountToken }, { chain: evil }) }, L.token);
  ok(!r.ok && r.finish === false, 'a transaction from an untrusted chain is refused');
  r = await api('apple/purchase', { transaction: tx(MEDIUM, L.appAccountToken, { quantity: 2 }).jws }, L.token);
  ok(r.ok && r.account.paid === 99 + 2 * 499, 'quantity 2 credits the product twice');
  r = await api('apple/purchase', { transaction: tx(SMALL, L.appAccountToken).jws });
  ok(r.signedOut === true, 'purchase without a session: signed out');

  // other accounts, sandbox
  const L2 = await api('apple/link', { appTransaction: appTx('A2'), create: true });
  r = await api('apple/purchase', { transaction: tx(SMALL, L.appAccountToken).jws }, L2.token);
  ok(r.ok && (await api('me', undefined, L.token)).account.paid === 99 + 998 + 99 && (await api('me', undefined, L2.token)).account.paid === 0,
    'a purchase is credited to the account whose appAccountToken it carries, whoever sends it');
  r = await api('apple/purchase', { transaction: tx(SMALL, crypto.randomUUID()).jws }, L2.token);
  ok(!r.ok && r.finish === false, 'an appAccountToken nobody has: refused');
  r = await api('apple/purchase', { transaction: tx(SMALL, null, { appTransactionId: 'A2' }).jws }, L2.token);
  ok(r.ok && r.account.paid === 99, 'no appAccountToken: the account of the same App Store account (appTransactionId)');
  const S = await api('apple/link', { appTransaction: appTx('A1', 'Sandbox'), create: true });
  ok(S.ok && S.account.sandbox && S.token !== L.token && S.account.paid === 0, 'sandbox: the same App Store account gets a separate sandbox account');
  r = await api('apple/purchase', { transaction: tx(SMALL, S.appAccountToken, { environment: 'Sandbox' }).jws }, S.token);
  ok(r.ok && r.account.paid === 99 && (await api('me', undefined, L.token)).account.paid === 1196, 'sandbox purchase credits only the sandbox account');
  r = await api('apple/purchase', { transaction: tx(SMALL, S.appAccountToken).jws }, S.token);
  ok(!r.ok, 'a production transaction never credits a sandbox account');
  r = await api('apple/purchase', { transaction: tx(SMALL, L.appAccountToken, { environment: 'Xcode' }).jws }, L.token);
  ok(!r.ok, 'Xcode-signed transactions are refused (APPLE_IAP_XCODE not set)');

  // restore after a reinstall: same App Store account -> same swag account
  const R = await api('apple/link', { appTransaction: appTx('A1') });
  ok(R.found && R.account.paid === 1196 && R.appAccountToken === L.appAccountToken && R.token !== L.token, 'restore: linking again finds the same account and total');

  // refunds
  const t2 = tx(MEDIUM, L.appAccountToken);
  await api('apple/purchase', { transaction: t2.jws }, L.token);
  const paidBefore = (await api('me', undefined, L.token)).account.paid;
  const refundUuid = crypto.randomUUID();
  ok(await notify(note('REFUND', tx(MEDIUM, L.appAccountToken, { transactionId: t2.id, revocationDate: now(), revocationReason: 0 }).jws, 'Production', refundUuid)) === 200, 'refund notification accepted');
  ok((await api('me', undefined, L.token)).account.paid === paidBefore - 499, 'refund: 4.99 taken back');
  await notify(note('REFUND', tx(MEDIUM, L.appAccountToken, { transactionId: t2.id, revocationDate: now() }).jws, 'Production', refundUuid));
  await notify(note('REFUND', tx(MEDIUM, L.appAccountToken, { transactionId: t2.id, revocationDate: now() }).jws));
  ok((await api('me', undefined, L.token)).account.paid === paidBefore - 499, 'the same refund again (same or new notification) takes nothing more');
  r = await api('apple/purchase', { transaction: t2.jws }, L.token);
  ok(r.ok && r.finish && r.account.paid === paidBefore - 499, 'the refunded purchase sent again is not credited again');
  await notify(note('REFUND_REVERSED', tx(MEDIUM, L.appAccountToken, { transactionId: t2.id }).jws));
  ok((await api('me', undefined, L.token)).account.paid === paidBefore, 'refund reversed: credited again');
  ok(await notify(note('REFUND', tx(MEDIUM, L.appAccountToken, { transactionId: t2.id, revocationDate: now() }).jws, 'Production', crypto.randomUUID(), { chain: evil })) === 400,
    'a notification from an untrusted chain is refused (400)');
  ok((await api('me', undefined, L.token)).account.paid === paidBefore, '...and changes nothing');
  // a refund the app reports (the transaction comes back revoked)
  const t3 = tx(SMALL, L.appAccountToken);
  await api('apple/purchase', { transaction: t3.jws }, L.token);
  r = await api('apple/purchase', { transaction: tx(SMALL, L.appAccountToken, { transactionId: t3.id, revocationDate: now() }).jws }, L.token);
  ok(r.ok && r.refunded && r.finish && r.account.paid === paidBefore, 'a revoked transaction from the app takes its credit back');
  // refunded before it was ever credited (the app never got through): never credited later
  const t4 = tx(MEDIUM, L.appAccountToken);
  await notify(note('REFUND', tx(MEDIUM, L.appAccountToken, { transactionId: t4.id, revocationDate: now() }).jws));
  r = await api('apple/purchase', { transaction: t4.jws }, L.token);
  ok(r.ok && r.finish && r.account.paid === paidBefore, 'refunded before delivery: the old transaction is finished without credit');
  // backup credit from a ONE_TIME_CHARGE notification; then the app's own report is a duplicate
  const t5 = tx(SMALL, L.appAccountToken);
  await notify(note('ONE_TIME_CHARGE', t5.jws));
  ok((await api('me', undefined, L.token)).account.paid === paidBefore + 99, 'ONE_TIME_CHARGE notification credits (backup path)');
  r = await api('apple/purchase', { transaction: t5.jws }, L.token);
  ok(r.ok && r.finish && !r.credited && r.account.paid === paidBefore + 99, '...and the app\'s report of it is a duplicate');
  ok(await notify(note('TEST', null)) === 200, 'TEST notification: 200');

  // crash between the ledger line and the account file: replayed from payments.jsonl on startup
  const expected = (await api('me', undefined, L.token)).account.paid;
  await stop();
  const st = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8'));
  const sub = Object.keys(st.accounts).find((k) => st.accounts[k].apple && st.accounts[k].apple.appTx === 'A1' && st.accounts[k].apple.env === 'Production');
  st.accounts[sub].paid = 0; st.iap = {};
  fs.writeFileSync(ACCOUNTS, JSON.stringify(st));
  await start();
  ok((await api('me', undefined, L.token)).account.paid === expected, `payments.jsonl replay restores the total (${expected})`);
  ok(fs.readFileSync(PAYMENTS, 'utf8').split('\n').filter((l) => l.includes('"iap":"apple"')).length >= 8, 'every App Store event is in payments.jsonl');

  // deletion and the way back
  r = await api('delete', { confirm: 'DELETE' }, L.token);
  ok(r.ok, 'delete: in-app deletion of an iOS account');
  ok((await api('me', undefined, L.token)).signedOut, '...signs it out');
  const D = await api('apple/link', { appTransaction: appTx('A1') });
  ok(D.found && D.account.deleting, 'linking again within 14 days shows the deleted account (restorable)');
  r = await api('restore', {}, D.token);
  ok(r.ok && !r.account.deleting && r.account.paid === expected, 'restore brings it back with its total');

  if (process.argv.includes('--ui')) await uiTest();
} finally {
  if (srv) await stop().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the purchase screen (headless Chrome)
async function uiTest() {
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const shots = path.join(root, 'store/iap');
  fs.mkdirSync(shots, { recursive: true });
  const signed = [];   // every transaction the stand-in App Store signed
  // a device: its screen, and the App Store account it's signed in to
  const device = async (viewport, deviceScaleFactor, appleAccount) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor, hasTouch: true, isMobile: true });
  await ctx.exposeBinding('__sign', (_, kind, o = {}) => {
    if (kind === 'app') return { jws: appTx(appleAccount), environment: 'Production', appTransactionId: appleAccount };
    const t = tx(o.productId, o.appAccountToken);
    signed.push({ id: t.id, productId: o.productId, token: o.appAccountToken });
    return { jws: t.jws, transactionId: t.id, productId: o.productId, appAccountToken: o.appAccountToken, verified: true, revoked: false, quantity: 1, environment: 'Production' };
  });
  await ctx.addInitScript(() => {
    // stand-in for ios/App/App/StorePlugin.swift; purchases not finished yet survive a relaunch (like StoreKit's)
    const KEY = '__iap_unfinished';
    const load = () => JSON.parse(localStorage.getItem(KEY) || '[]'), save = (u) => localStorage.setItem(KEY, JSON.stringify(u));
    const listeners = [];
    const fail = (code) => Object.assign(new Error(code), { code });
    const NAMES = ['Swag Pack', 'Big Swag Pack', 'Huge Swag Pack', 'Legendary Swag Pack'], PRICES = ['$0.99', '$4.99', '$9.99', '$19.99'];
    window.__iap = { mode: 'success', listeners, load, save, pending: null };
    const store = {
      status: async () => ({ supported: true, canMakePayments: true }),
      products: async ({ ids }) => ({ products: ids.map((id, i) => ({ id, displayName: NAMES[i], description: '', displayPrice: PRICES[i], price: PRICES[i].slice(1), currency: 'USD' })) }),
      appTransaction: () => window.__sign('app'),
      async purchase({ id, appAccountToken }) {
        const m = window.__iap.mode;
        if (m === 'cancelled') return { status: 'cancelled' };
        if (m === 'pending') { window.__iap.pending = { productId: id, appAccountToken }; return { status: 'pending' }; }
        if (m.startsWith('fail-')) throw fail(m.slice(5));
        const t = await window.__sign('tx', { productId: id, appAccountToken });
        save([...load(), t]);
        return { status: 'success', transaction: t };
      },
      unfinished: async () => ({ transactions: load() }),
      history: async () => ({ transactions: [] }),
      async finish({ transactionId }) { const u = load(), n = u.length; save(u.filter((t) => t.transactionId !== transactionId)); return { finished: u.length < n }; },
      addListener(ev, fn) { if (ev === 'transaction') listeners.push(fn); return { remove() {} }; },
    };
    // (like Capacitor's native bridge: plugins on Capacitor.Plugins, no registerPlugin)
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { Store: store } };
  });
  return ctx.newPage();
  };
  // iPhone 6.9" landscape (2868 x 1320 px): the game is landscape only
  const page = await device({ width: 956, height: 440 }, 3, 'UI1');
  const URL_ = `${BASE}/?mobile=1&account=${encodeURIComponent(BASE)}`;
  const boot = async () => {
    page.on('pageerror', (e) => console.error('  page error:', e.message));
    await page.goto(URL_);
    await page.waitForFunction(() => window.__kitty && window.__kitty.sim, null, { timeout: 120000 });
    await page.waitForSelector('.rkr-swag:not(.rkr-hidden)', { timeout: 20000 });
  };
  const msg = () => page.textContent('.rka-msg');
  const waitMsg = (re) => page.waitForFunction((src) => new RegExp(src).test((document.querySelector('.rka-msg') || {}).textContent || ''), re.source, { timeout: 20000 })
    .then(() => true, () => false);
  const openMenu = async () => { await page.evaluate(() => document.querySelector('.rkr-swag').click()); await page.waitForSelector('.rka-box'); };
  const packs = async () => { await page.waitForSelector('.rka-pack', { timeout: 20000 }); return page.$$('.rka-pack'); };
  const mode = (m) => page.evaluate((x) => { window.__iap.mode = x; }, m);
  const unfinishedCount = () => page.evaluate(() => window.__iap.load().length);
  const me = async () => { const tok = await page.evaluate(() => localStorage.getItem('rkr-acct')); return tok ? (await api('me', undefined, tok)).account : null; };

  await boot();
  ok(/get swag packs/.test(await page.textContent('.rkr-swag small')), 'ui: the title screen offers swag packs on iOS');
  await openMenu();
  const ps = await packs();
  const texts = await Promise.all(ps.map((b) => b.textContent()));
  ok(ps.length === 4 && /\$0\.99/.test(texts[0]) && /\$19\.99/.test(texts[3]) && /\+0\.99/.test(texts[0]) && /Restore purchases/.test(await page.textContent('.rka-links')),
    'ui: four packs with the store\'s localized prices, what each adds, and Restore purchases');
  await page.screenshot({ path: path.join(shots, 'iphone-purchase-screen.png') });

  await mode('cancelled'); await (await packs())[0].click();
  ok(await waitMsg(/nothing was charged/), 'ui: cancelled -> "nothing was charged"');
  ok((await me()).paid === 0, 'ui: ...and nothing credited');
  await mode('fail-NETWORK'); await (await packs())[0].click();
  ok(await waitMsg(/Could not reach the App Store/), 'ui: network failure -> its own message');
  await mode('fail-NOT_ALLOWED'); await (await packs())[0].click();
  ok(await waitMsg(/turned off on this device/), 'ui: purchases not allowed (Screen Time) -> its own message');
  await mode('fail-FAILED'); await (await packs())[0].click();
  ok(await waitMsg(/did not go through/), 'ui: other failure -> "did not go through"');

  await mode('success'); await (await packs())[1].click();
  ok(await waitMsg(/\+4\.99! Your swag number is now 4\.99/), 'ui: success -> thanks, the number shown');
  ok(/THANK YOU/.test(await page.textContent('.rka-box h2')) && await unfinishedCount() === 0 && (await me()).paid === 499, 'ui: credited on the server, then finished');
  await page.screenshot({ path: path.join(shots, 'iphone-purchase-done.png') });

  // Ask to Buy: pending, approved later (arrives through Transaction.updates)
  await page.click('.rka-box >> text=ADD MORE');
  await mode('pending'); await (await packs())[0].click();
  ok(await waitMsg(/Waiting for approval/), 'ui: Ask to Buy -> waiting for approval');
  await page.evaluate(async () => {
    const p = window.__iap.pending, t = await window.__sign('tx', p);
    window.__iap.save([...window.__iap.load(), t]);
    window.__iap.listeners.forEach((fn) => fn(t));
  });
  ok(await waitMsg(/Your swag arrived/), 'ui: approved later -> credited when it arrives');
  ok((await me()).paid === 598 && await unfinishedCount() === 0, 'ui: ...4.99 + 0.99, finished');

  // no connection to the game server right after paying: kept by StoreKit, credited at the next launch
  await mode('success');
  await page.route('**/api/account/apple/purchase', (r) => r.abort());
  await page.click('.rka-box >> text=ADD MORE'); await (await packs())[0].click();
  ok(await waitMsg(/Payment done/), 'ui: server unreachable after paying -> "keeps trying"');
  ok(await unfinishedCount() === 1 && (await me()).paid === 598, 'ui: ...the purchase stays unfinished, not credited yet');
  await page.unroute('**/api/account/apple/purchase');
  await boot();
  await page.waitForFunction(() => window.__iap.load().length === 0, null, { timeout: 20000 }).catch(() => {});
  ok(await unfinishedCount() === 0 && (await me()).paid === 697, 'ui: relaunch -> credited and finished');

  // reinstall: storage gone (StoreKit's unfinished list is the App Store's, it stays), the same Apple Account
  await page.evaluate(() => localStorage.removeItem('rkr-acct'));
  await boot();
  await page.waitForFunction(() => /6\.97/.test(document.querySelector('.rkr-swag small').textContent), null, { timeout: 20000 }).catch(() => {});
  ok(/6\.97/.test(await page.textContent('.rkr-swag small')), 'ui: reinstall -> found again at launch, no sign-in (6.97)');
  await openMenu();
  await page.click('.rka-links >> text=Restore purchases');
  ok(await waitMsg(/Restored! Your swag is back/), 'ui: Restore purchases');
  await page.screenshot({ path: path.join(shots, 'iphone-swag-account.png') });

  // refund (App Store Server Notification) -> the number goes down
  const big = signed.find((x) => x.productId === MEDIUM);
  await notify(note('REFUND', tx(MEDIUM, big.token, { transactionId: big.id, revocationDate: now() }).jws));
  ok((await me()).paid === 198, 'ui: refund of the 4.99 pack -> 1.98');

  // delete in the app, then restore it
  await page.keyboard.press('Escape'); await openMenu();
  await page.click('.rka-box >> text=Delete account');
  await page.fill('.rka-del input', 'DELETE');
  await page.click('.rka-box >> text=DELETE FOREVER'); await page.click('.rka-box >> text=YES, DELETE IT');
  ok(await waitMsg(/deleted/), 'ui: delete account in the app');
  await page.click('.rka-links >> text=Restore purchases');
  await page.waitForSelector('.rka-box >> text=RESTORE MY ACCOUNT', { timeout: 20000 });
  await page.click('.rka-box >> text=RESTORE MY ACCOUNT');
  ok(await waitMsg(/restored/i) && (await me()).paid === 198, 'ui: ...and restore it within 14 days');

  await browser.close();
}
