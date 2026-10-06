// Optional account (web only for now): sign in with Google, chip in what you like (from 0.50) through Stripe
// Checkout, and your total shows next to your kitty's name online. Server side: server/accounts.js.
// The session token lives in localStorage; main.js passes it to the game server ('hi' / 'acct').
import { accountApiUrl, NATIVE } from './platform.js';

const CSS = `
.rka-modal{z-index:40;}
.rka-box{max-width:460px;text-align:center;background:linear-gradient(160deg,rgba(52,30,96,.97),rgba(26,12,52,.97)) !important;}
.rka-box h2{font-size:clamp(30px,4.5vw,44px) !important;}
.rka-big{font-size:clamp(40px,7vw,60px);font-weight:900;color:#ffd56b;text-shadow:0 3px 0 #3a1650;line-height:1;}
.rka-amts{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}
.rka-amt{font:inherit;font-weight:900;font-size:17px;cursor:pointer;padding:9px 14px;border-radius:14px;border:2px solid rgba(255,255,255,.25);
  background:rgba(10,4,30,.5);color:#fff;min-width:74px;}
.rka-amt.rka-on{border-color:#ffd56b;background:rgba(255,213,107,.18);color:#ffd56b;}
.rka-custom{display:flex;align-items:center;justify-content:center;gap:6px;font-weight:900;font-size:18px;}
.rka-custom input{font:inherit;font-weight:900;width:110px;padding:8px 10px;border-radius:12px;border:2px solid rgba(255,255,255,.3);
  background:rgba(10,4,30,.6);color:#fff;outline:none;text-align:center;user-select:text;-webkit-user-select:text;}
.rka-custom input:focus{border-color:#ffd56b;}
.rka-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
.rka-fine{font-size:12px;opacity:.6;}
.rka-links{display:flex;gap:14px;justify-content:center;font-size:13px;}
.rka-links a{cursor:pointer;opacity:.7;text-decoration:underline;}
.rka-links a:hover{opacity:1;}
.rka-msg{min-height:20px;font-weight:800;}
.rka-msg.rka-err{color:#ff8fa3;}
.rka-msg.rka-ok{color:#9dff7a;}
.rka-gbtn{display:flex;justify-content:center;min-height:44px;}
/* account menu: one card per section */
.rka-sec{align-self:stretch;display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 14px;border-radius:16px;background:rgba(10,4,30,.38);border:1px solid rgba(255,255,255,.12);}
.rka-sech{align-self:flex-start;font-size:12px;font-weight:900;letter-spacing:.14em;opacity:.6;}
.rka-note{font-size:14px;font-weight:700;opacity:.85;}
.rka-soon{opacity:.55;}
`;

const PRESETS = [50, 420, 1337];
const TOKEN_KEY = 'rkr-acct';

// totals are in the server's one currency (config); lobby.js and ui.js format with this too
const SYMBOLS = { eur: '€', usd: '$', gbp: '£' };
let symbol = '€';
const fmtPaid = (c) => symbol + (c / 100).toFixed(2);
const fmtNum = (c) => (c / 100).toFixed(2);   // in game (lobby slots, player cards): just the number

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function readToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function writeToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } }

let gsiLoading = null;
function loadGsi() {
  return (gsiLoading ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = ok;
    s.onerror = () => { gsiLoading = null; fail(new Error('Could not reach Google.')); };
    document.head.appendChild(s);
  }));
}

function createAccount(root) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  const A = { enabled: false, token: NATIVE ? '' : readToken(), account: null, cfg: null };
  let modal = null, changeFn = null;
  const changed = () => { if (changeFn) changeFn(); };

  async function api(name, body) {
    const r = await fetch(accountApiUrl('/api/account/' + name), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',   // credentials must never follow a redirect to another server
      headers: { 'Content-Type': 'application/json', ...(A.token ? { Authorization: 'Bearer ' + A.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (j.signedOut) { setSession('', null); throw new Error('You were signed out, sign in again.'); }
    if (!j.ok) throw new Error(j.msg || 'Something went wrong, try again in a moment.');
    return j;
  }
  function setSession(token, account) {
    A.token = token; A.account = account;
    writeToken(token);
    changed();
  }

  async function init() {
    if (NATIVE) return;   // the apps get sign-in later (native Google / Apple sign-in); paying stays on the web
    try {
      A.cfg = await fetch(accountApiUrl('/api/account/config'), { redirect: 'error' }).then((r) => r.json());
      A.enabled = !!(A.cfg && A.cfg.enabled);
      if (A.cfg && A.cfg.currency) symbol = SYMBOLS[A.cfg.currency] || A.cfg.currency.toUpperCase() + ' ';
    } catch { A.enabled = false; }
    if (!A.enabled) { changed(); return; }
    const q = new URLSearchParams(location.search), paid = q.get('paid');
    if (paid) {
      q.delete('paid');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    }
    if (A.token) { try { A.account = (await api('me')).account; } catch { /* signed out */ } }
    changed();
    if (paid === 'cancel' && A.token) open({ msg: 'No worries, nothing was charged.' });
    else if (paid && A.token) {
      open({ msg: 'Confirming your payment…' });
      try {
        const j = await api('confirm', { session: paid });
        A.account = j.account; changed();
        open({ thanks: j.paid, msg: j.paid ? '' : 'Your payment is still processing; your total updates as soon as it clears.' });
      } catch (e) { open({ err: e.message }); }
    }
  }

  function close() { if (modal) modal.remove(); modal = null; }

  // small print ending in links to the Terms and Privacy pages
  function fine(text) {
    const d = el('div', 'rka-fine', text);
    const link = (page, label) => { const l = el('a', null, label); l.href = page + '.html'; l.target = '_blank'; l.rel = 'noopener'; l.style.color = 'inherit'; return l; };
    d.append(link('terms', 'Terms'), ' & ', link('privacy', 'Privacy'), '.');
    return d;
  }

  // one modal: signed out (Google button); signed in: the account menu, or the amount picker (opts.view 'pay')
  function open(opts = {}) {
    if (!A.enabled) return;
    close();
    modal = el('div', 'rkr-overlay rkr-dim rka-modal');
    const box = el('div', 'rkr-glass rka-box');
    modal.appendChild(box);
    modal.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    box.tabIndex = -1;   // focus inside, so title / game keys don't fire behind the box
    setTimeout(() => { if (modal && !modal.contains(document.activeElement)) box.focus(); }, 0);
    modal.addEventListener('keyup', (e) => e.stopPropagation());
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    const msg = el('div', 'rka-msg' + (opts.err ? ' rka-err' : opts.thanks ? ' rka-ok' : ''), opts.err || opts.msg || '');
    const say = (t, kind) => { msg.className = 'rka-msg' + (kind ? ' rka-' + kind : ''); msg.textContent = t; };
    const closeBtn = el('button', 'rkr-btn rkr-alt', 'CLOSE');
    closeBtn.addEventListener('click', close);
    const a = A.account;

    if (!A.token || !a) {
      box.append(el('h2', null, 'CREATE SWAG ACCOUNT'),
        el('div', 'rkr-gsub', `Totally optional. Chip in whatever you like (from ${fmtPaid(A.cfg.min)}) and the total shows next to your kitty for everyone online (can toggle it on and off).`));
      const g = el('div', 'rka-gbtn');
      box.append(g, msg, fine('By signing in you agree to the '), closeBtn);
      loadGsi().then(() => {
        if (!modal || !g.isConnected) return;
        google.accounts.id.initialize({
          client_id: A.cfg.googleClientId,
          callback: async (r) => {
            say('Signing in…');
            try {
              const j = await api('google', { credential: r.credential });
              setSession(j.token, j.account);
              open(Number(j.account && j.account.paid) > 0 ? {} : { view: 'pay' });
            } catch (e) { say(e.message, 'err'); }
          },
        });
        google.accounts.id.renderButton(g, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with' });
      }).catch((e) => say(e.message, 'err'));
      root.appendChild(modal);
      return;
    }

    const paid = Number(a.paid) || 0;
    const shown = a.show !== false;
    const section = (title) => { const s = el('div', 'rka-sec'); s.appendChild(el('div', 'rka-sech', title)); return s; };
    const sayOpts = () => { if (opts.msg || opts.err) say(opts.err || opts.msg, opts.err ? 'err' : opts.thanks ? 'ok' : ''); };

    // Signed in: the account menu, one section per thing (stats & progress go in here later). The amount picker is
    // its own view (opts.view 'pay', with BACK).
    if (opts.view !== 'pay') {
      box.append(el('h2', null, opts.thanks ? 'THANK YOU!' : 'YOUR SWAG ACCOUNT'), el('div', 'rkr-gsub', `Hi ${a.name || 'there'}!`));
      // Swag: your total, the "shown online" switch (server: accounts.js 'show') and adding more
      const swag = section('SWAG');
      if (paid > 0) {
        const sw = el('button', 'rka-amt' + (shown ? ' rka-on' : ''), shown ? 'SHOWN ONLINE: ON' : 'SHOWN ONLINE: OFF');
        sw.addEventListener('click', async () => {
          sw.disabled = true;
          try { A.account = (await api('show', { show: !shown })).account; changed(); open(); } catch (e) { say(e.message, 'err'); sw.disabled = false; }
        });
        const add = el('button', 'rka-amt', 'ADD MORE');
        add.addEventListener('click', () => open({ view: 'pay' }));
        const r = el('div', 'rka-row');
        r.append(sw, add);
        swag.append(el('div', 'rka-big', fmtPaid(paid)),
          el('div', 'rka-note', shown ? 'Shows next to your kitty for everyone online.' : 'Hidden: other players don\'t see it right now.'), r);
      } else {
        const pick = el('button', 'rka-amt rka-on', 'PICK AN AMOUNT');
        pick.addEventListener('click', () => open({ view: 'pay' }));
        swag.append(el('div', 'rka-note', `No swag yet. Chip in from ${fmtPaid(A.cfg.min)} and it shows next to your kitty for everyone online (can toggle it on and off).`), pick);
      }
      // Stats & progress: not saved to accounts yet (wins, revives and rewards only last a run), so a placeholder
      const stats = section('STATS & PROGRESS');
      stats.classList.add('rka-soon');
      stats.appendChild(el('div', 'rka-note', 'Coming soon: your wins, revives and rewards, saved to your account.'));
      const links = el('div', 'rka-links');
      const out = el('a', null, 'Sign out'), del = el('a', null, 'Delete account');
      out.addEventListener('click', async () => { try { await api('logout', {}); } catch { /* gone anyway */ } setSession('', null); close(); });
      del.addEventListener('click', async () => {
        if (!confirm(`Delete your account${paid ? ` and your ${fmtPaid(paid)}` : ''}? This can't be undone, and payments aren't refunded.`)) return;
        try { await api('delete', {}); setSession('', null); close(); } catch (e) { say(e.message, 'err'); }
      });
      links.append(out, del);
      box.append(swag, stats, msg, closeBtn, links, fine(`Signed in as ${a.email}. `));
      sayOpts();
      root.appendChild(modal);
      return;
    }

    // Amount picker
    box.append(el('h2', null, paid > 0 ? 'ADD SWAG' : 'CREATE SWAG ACCOUNT'),
      el('div', 'rkr-gsub', paid > 0 ? `You have ${fmtPaid(paid)}. Add more any time, it only goes up.`
        : `Hi ${a.name || 'there'}! How much? Whatever you pick shows next to your kitty for everyone online (can toggle it on and off).`));
    let cents = 50;
    const amts = el('div', 'rka-amts');
    const btns = PRESETS.map((c) => {
      const b = el('button', 'rka-amt', fmtPaid(c));
      b.addEventListener('click', () => { cents = c; input.value = ''; sync(); });
      amts.appendChild(b);
      return [b, c];
    });
    const custom = el('label', 'rka-custom', symbol);
    const input = el('input');
    input.type = 'text'; input.inputMode = 'decimal'; input.placeholder = 'other';
    input.addEventListener('input', () => {
      // whole units and up to 2 decimals ("13.37" / "13,37"); anything else is not an amount yet
      const mm = /^\s*(\d{1,15})(?:[.,](\d{1,2}))?\s*$/.exec(input.value);
      cents = mm ? +mm[1] * 100 + +(mm[2] || '0').padEnd(2, '0') : 0; sync();
    });
    custom.appendChild(input);
    const pay = el('button', 'rkr-btn');
    const min = A.cfg.min, max = A.cfg.max;   // max: only Stripe's own per-payment limit
    function sync() {
      for (const [b, c] of btns) b.classList.toggle('rka-on', !input.value && c === cents);
      const ok = Number.isSafeInteger(cents) && cents >= min && cents <= max;
      pay.disabled = !ok;
      pay.textContent = ok ? (paid > 0 ? 'ADD ' : 'PAY ') + fmtPaid(cents) : cents > max ? 'TOO MUCH FOR ONE PAYMENT' : `MIN ${fmtPaid(min)}`;
      if (paid > 0 && ok) say(`New total: ${fmtPaid(paid + cents)}`);
    }
    pay.addEventListener('click', async () => {
      pay.disabled = true; say('Opening secure checkout…');
      try { location.href = (await api('pay', { cents, origin: location.origin })).url; } catch (e) { say(e.message, 'err'); pay.disabled = false; }
    });
    const back = el('button', 'rkr-btn rkr-alt', 'BACK');
    back.addEventListener('click', () => open());
    const row = el('div', 'rka-row');
    row.append(pay, back);
    box.append(amts, custom, row, msg,
      fine(`Signed in as ${a.email}. One-time payment through Stripe, no subscription. Your total shows right away, so payments can't be refunded. `));
    sync();
    sayOpts();
    root.appendChild(modal);
  }

  return {
    init, open, close,
    isOpen: () => !!modal,
    enabled: () => A.enabled,
    token: () => A.token,
    signedIn: () => !!(A.token && A.account),
    paid: () => (A.account ? Number(A.account.paid) || 0 : 0),
    shown: () => !A.account || A.account.show !== false,   // the player's "shown online" switch
    onChange(fn) { changeFn = fn; },
  };
}

export { createAccount, fmtPaid, fmtNum };
