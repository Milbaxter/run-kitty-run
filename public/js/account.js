// Optional account (web only for now): sign in with Google or Discord, chip in what you like (from 0.50) through Stripe
// Checkout, and your total shows next to your kitty's name online. Server side: server/accounts.js.
// The session token lives in localStorage; main.js passes it to the game server ('hi' / 'acct').
import { accountApiUrl, NATIVE } from './platform.js';
import { UNLOCKS, UNLOCK_MODES, isUnlocked, featTotal } from './shared/unlocks.js';
import { progressId } from './net.js';

const CSS = `
.rka-modal{z-index:40;}
.rka-box{max-width:460px;max-height:calc(100dvh - 24px);overflow-y:auto;overscroll-behavior:contain;text-align:center;background:linear-gradient(160deg,rgba(52,30,96,.97),rgba(26,12,52,.97)) !important;}
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
.rka-del{display:flex;flex-direction:column;gap:8px;align-items:center;padding:12px;border-radius:14px;border:2px solid rgba(255,143,163,.45);background:rgba(255,80,110,.08);}
.rka-del input{font:inherit;font-weight:900;width:150px;text-align:center;letter-spacing:.12em;padding:8px 10px;border-radius:12px;border:2px solid rgba(255,255,255,.3);background:rgba(0,0,0,.3);color:#fff;outline:none;}
.rka-del input:focus{border-color:#ff8fa3;}
.rka-del .rka-amt:disabled{opacity:.35;cursor:default;}
.rka-del .rka-delgo:not(:disabled){border-color:#ff8fa3;color:#ff8fa3;}
.rka-del-sure{display:flex;flex-direction:column;gap:10px;align-items:center;}
.rka-del[hidden],.rka-del [hidden]{display:none;}
.rka-sure{font-weight:900;font-size:22px;letter-spacing:.06em;color:#ff8fa3;}
.rka-msg{min-height:20px;font-weight:800;}
.rka-msg.rka-err{color:#ff8fa3;}
.rka-msg.rka-ok{color:#9dff7a;}
.rka-gbtn{display:flex;justify-content:center;min-height:44px;}
.rka-dbtn{font:inherit;font-weight:800;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  min-height:40px;padding:0 22px;border-radius:999px;border:0;background:#5865f2;color:#fff;text-decoration:none;}
.rka-dbtn:hover{background:#4752c4;}
/* account menu: one card per section */
.rka-sec{align-self:stretch;display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 14px;border-radius:16px;background:rgba(10,4,30,.38);border:1px solid rgba(255,255,255,.12);}
.rka-sech{align-self:flex-start;font-size:12px;font-weight:900;letter-spacing:.14em;opacity:.6;}
.rka-note{font-size:14px;font-weight:700;opacity:.85;}
.rka-tabs{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;}
.rka-amt.rka-tab{font-size:13px;padding:6px 12px;min-width:0;}
.rka-stats{align-self:stretch;display:flex;flex-direction:column;gap:8px;}
.rka-table{border-collapse:collapse;width:100%;font-size:14px;font-weight:800;}
.rka-table th{font-size:11px;font-weight:900;letter-spacing:.08em;opacity:.6;padding:2px 4px;text-align:center;}
.rka-table td{padding:3px 4px;text-align:center;border-top:1px solid rgba(255,255,255,.08);}
.rka-table th:first-child,.rka-table td:first-child{text-align:left;}
.rka-table td.rka-zero{opacity:.35;}
.rka-unl{align-self:stretch;display:flex;flex-direction:column;gap:6px;}
.rka-ugoal{font-size:12px;font-weight:800;opacity:.7;text-align:left;margin-top:4px;}
.rka-urow{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:12px;background:rgba(255,255,255,.05);text-align:left;}
.rka-uname{flex:1;font-weight:900;font-size:15px;}
.rka-urow.rka-locked .rka-uname{opacity:.55;}
.rka-uprog{font-size:12px;font-weight:800;opacity:.75;white-space:nowrap;}
.rka-uprog b{color:#9dff7a;}
.rka-amt.rka-utog{font-size:13px;padding:5px 12px;min-width:58px;}
.rka-tot{display:flex;gap:18px;justify-content:center;font-weight:900;color:#ffd56b;}
`;

const PRESETS = [50, 420, 1337];
const TOKEN_KEY = 'rkr-acct';

// totals are in the server's one currency (config); lobby.js and ui.js format with this too
const SYMBOLS = { eur: '€', usd: '$', gbp: '£' };
let symbol = '€';
const fmtPaid = (c) => symbol + (c / 100).toFixed(2);
// in game (lobby slots, player cards, the menu button): just the number, digit for digit as paid, so funny numbers
// read as meant (1337, 80085, 69.69): no separators, and no .00 on whole amounts
const fmtNum = (c) => (c % 100 ? (c / 100).toFixed(2) : String(Math.round(c / 100)));

// Stats & progress in the account menu: times the team cleared each level, per mode, plus crowns and revives.
// Level 9 (the final run) only gets a row once you've got that far in some mode, and a number only in modes you
// have: no spoilers.
let statsTab = 'online';   // 'online' | 'local'
let statsWhat = 'clears';  // 'clears' (times cleared) | 'best' (fastest clear)
const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const STAT_COLS = [['run', 'RUN'], ['ice', 'SKATE'], ['mixed', 'RUN + SKATE']];
function statsView(s) {
  const clears = (s && s.clears) || {}, reached = (s && s.reached) || {}, best = (s && s.best) || {};
  const t = el('table', 'rka-table');
  const head = el('tr');
  head.append(el('th', null, 'LEVEL'), ...STAT_COLS.map(([, label]) => el('th', null, label)));
  t.appendChild(head);
  const last = STAT_COLS.some(([m]) => (reached[m] || 0) >= 9) ? 9 : 8;
  for (let L = 1; L <= last; L++) {
    const tr = el('tr');
    tr.appendChild(el('td', null, String(L)));
    for (const [m] of STAT_COLS) {
      const n = (clears[m] || {})[L] || 0, b = (best[m] || {})[L];
      const text = statsWhat === 'best' ? (b > 0 ? fmtTime(b) : '–') : String(n);
      tr.appendChild(el('td', (statsWhat === 'best' ? b > 0 : n) ? null : 'rka-zero', L === 9 && (reached[m] || 0) < 9 ? '–' : text));
    }
    t.appendChild(tr);
  }
  const tot = el('div', 'rka-tot');
  tot.append(el('span', null, `CROWNS ${(s && s.crowns) || 0}`), el('span', null, `REVIVES ${(s && s.revives) || 0}`));
  const wrap = el('div', 'rka-stats');
  wrap.append(t, tot);
  return wrap;
}

const signedInAs = (a) => (a.via === 'discord' ? `Signed in with Discord as ${a.name || 'you'}` : `Signed in as ${a.email}`);
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
  let eqFor, eqGuest, eqMode, eqSet = new Set();   // equipped(): made once per account / guest progress object and mode
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
  // the guest unlock routes: no sign-in, just this browser's progress id
  async function guestApi(name, body) {
    const r = await fetch(accountApiUrl('/api/account/' + name), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.msg || 'Something went wrong, try again in a moment.');
    return j;
  }
  async function loadGuest() {
    const pid = progressId();
    if (!pid) return false;
    try {
      const j = await guestApi('guest', { pid });
      const before = JSON.stringify(A.guest || null);
      A.guest = j.unlocks || null;
      if (JSON.stringify(A.guest) !== before) { changed(); return true; }
    } catch { /* offline */ }
    return false;
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
    loadGuest();   // this browser's unlocks (no account needed: its own kitty wears them in solo games too)
    if (!A.enabled) { changed(); return; }
    // back from Sign in with Discord (server/accounts.js): #signin=<one-time code> or #signin-error=<why>
    const h = new URLSearchParams(location.hash.slice(1)), handoff = h.get('signin'), signinErr = h.get('signin-error');
    if (handoff || signinErr) history.replaceState(null, '', location.pathname + location.search);
    const q = new URLSearchParams(location.search), paid = q.get('paid');
    if (paid) {
      q.delete('paid');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    }
    if (handoff) {
      try {
        const j = await api('handoff', { code: handoff });
        setSession(j.token, j.account);
        open(j.account && j.account.deleting ? {} : { msg: Number(j.account && j.account.paid) > 0 ? 'Welcome back! Your swag is on this browser now.' : 'Signed in!', ok: true });
        return;
      } catch (e) { open({ err: e.message }); }
    } else if (signinErr) {
      open({ err: { denied: 'Discord sign-in was cancelled.', expired: 'Sign-in timed out, try again.', off: 'Discord sign-in is not available right now.' }[signinErr] || 'Discord sign-in did not work, try again.' });
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

  // one modal: signed out (create one, or sign back in); signed in: the account menu, or the amount picker (opts.view 'pay')
  function open(opts = {}) {
    // no active account: the guest progress may have moved on (an online game): fetch it, redraw if it did
    if (!opts.fresh && !(A.account && Number(A.account.paid) > 0)) loadGuest().then((ch) => { if (ch && modal) open({ ...opts, fresh: true }); });
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
    const section = (title) => { const s = el('div', 'rka-sec'); s.appendChild(el('div', 'rka-sech', title)); return s; };
    // the unlocks with their progress per mode and on / off switches: an account's, or this browser's (no account)
    const unlocksBox = (title, prog, toggle, note) => {
      const box_ = section(title);
      const ulist = el('div', 'rka-unl');
      const SHORT = { run: 'Run', ice: 'Skate', mixed: 'Run + Skate' };
      const GOALS = { l8: 'Clear level 8 having reached the goal yourself on every level (both halves in Run + Skate). Each mode unlocks it for that mode:',
        l9: 'Beat level 9 having reached the goal yourself on every level, the final one too. Each mode unlocks it for that mode:',
        win: 'Clear the final level to unlock a new song (any mode):',
        rev: 'Revive kitties in Multiplayer games (all modes together):' };
      let lastFeat = '';
      // no spoilers: level 9's unlocks only once this player has seen level 9 (this browser, the account's stats, or progress)
      let seen9 = false;
      try { seen9 = localStorage.getItem('rkr-seen9') === '1'; } catch { /* ignore */ }
      const st = A.account && A.account.stats;
      seen9 ||= ['online', 'local'].some((k) => st && st[k] && Object.values(st[k].reached || {}).some((v) => v >= 9));
      seen9 ||= Object.values((prog && prog.l9) || {}).some((v) => v > 0);
      for (const u of UNLOCKS) {
        if (u.feat === 'l9' && !seen9) continue;
        if (u.feat !== lastFeat) { lastFeat = u.feat; ulist.appendChild(el('div', 'rka-ugoal', GOALS[u.feat])); }
        const open_ = isUnlocked(prog, u);   // (in some mode: its switch shows; each mode's own tick below)
        const row = el('div', 'rka-urow' + (open_ ? '' : ' rka-locked'));
        row.appendChild(el('span', 'rka-uname', (open_ ? '' : '🔒 ') + (u.song && !open_ ? 'New song' : u.name) + (u.all ? ' (all 3 modes)' : '')));   // (u.all: needs every mode, then worn in all)
        if (u.song) {
          // a song has no switch: it joins the soundtrack, and the settings can play it on its own
          row.appendChild(el('span', 'rka-uprog', open_ ? 'Switch it on / off in Settings' : ''));
        } else {
          // each mode on its own: a tick where it's unlocked (and worn), the count toward it elsewhere (a total item:
          // one count over all modes)
          const p = el('span', 'rka-uprog');
          if (u.total) p.appendChild(el(open_ ? 'b' : 'span', null, open_ ? '✓' : `${Math.min(u.times, featTotal(prog, u.feat))}/${u.times}`));
          else (u.modes || UNLOCK_MODES).forEach((m, i) => {   // (only the modes it can be earned in)
            const n = Math.min(u.times, ((prog[u.feat] || {})[m]) || 0);
            if (i) p.append(' · ');
            p.appendChild(el(n >= u.times ? 'b' : 'span', null, n >= u.times ? `${SHORT[m]} ✓` : `${SHORT[m]} ${n}/${u.times}`));
          });
          row.appendChild(p);
          if (open_) {   // one switch for every mode it's unlocked in
            const on = !(prog.off && prog.off[u.id]);
            const t = el('button', 'rka-amt rka-utog' + (on ? ' rka-on' : ''), on ? 'ON' : 'OFF');
            t.addEventListener('click', async () => {
              t.disabled = true;
              try { await toggle(u.id, !on); changed(); open({ fresh: true }); }
              catch (e) { t.disabled = false; say(e.message, 'err'); }
            });
            row.appendChild(t);
          }
        }
        ulist.appendChild(row);
      }
      box_.append(ulist, el('div', 'rka-fine', note));
      return box_;
    };
    // this browser's own progress (no active account), kept by the server under its progress id
    const guestBox = () => unlocksBox('YOUR UNLOCKS (THIS BROWSER)', A.guest || {},
      async (id, on) => { A.guest = (await guestApi('guestequip', { pid: progressId(), item: id, on })).unlocks; },
      'Earned in Multiplayer games and saved on this browser only: clearing its data, another device or two months without playing Multiplayer loses them. Activate a swag account to keep them safe.');
    const sayOpts = () => { if (opts.msg || opts.err) say(opts.err || opts.msg, opts.err ? 'err' : opts.thanks || opts.ok ? 'ok' : ''); };

    if (!A.token || !a) {
      // Signed out: create one, or sign back in (another browser, cleared storage). Accounts are keyed by the Google /
      // Discord account, so both sections do the same thing: the same Google or Discord account always gets the same
      // swag account back (a Google one and a Discord one are two separate accounts).
      const create = section('NEW HERE?'), back = section('ALREADY HAVE ONE?');
      const gNew = el('div', 'rka-gbtn'), gBack = el('div', 'rka-gbtn');
      const discordBtn = (text) => {
        const b = el('a', 'rka-dbtn', text);
        b.href = accountApiUrl('/api/account/discord') + '?origin=' + encodeURIComponent(location.origin);
        return b;
      };
      create.append(el('div', 'rka-note', `Totally optional, you do not need an account to play the game. Sign up, then chip in whatever you like once to activate it: the total shows next to your kitty for everyone online (can toggle it on and off), and your account keeps your stats and earns unlocks in Multiplayer games.`), gNew);
      back.append(el('div', 'rka-note', `Sign in with the same ${A.cfg.discord ? 'Google or Discord' : 'Google'} account as before and your swag comes back, on any browser.`), gBack);
      if (A.cfg.discord) { create.append(discordBtn('Sign up with Discord')); back.append(discordBtn('Sign in with Discord')); }
      box.append(el('h2', null, 'SWAG ACCOUNT'), create, back, guestBox(), msg, fine('By signing in you agree to the '), closeBtn);
      loadGsi().then(() => {
        if (!modal || !gNew.isConnected) return;
        google.accounts.id.initialize({
          client_id: A.cfg.googleClientId,
          callback: async (r) => {
            say('Signing in…');
            try {
              const j = await api('google', { credential: r.credential });
              setSession(j.token, j.account);
              // always the account menu, never straight to paying (paying is only ever the player's own click)
              open(j.account && j.account.deleting ? {} : { msg: Number(j.account && j.account.paid) > 0 ? 'Welcome back! Your swag is on this browser now.' : 'Signed in!', ok: true });   // (deleted: the restore view says it all)
            } catch (e) { say(e.message, 'err'); }
          },
        });
        const look = { theme: 'filled_black', size: 'large', shape: 'pill' };
        google.accounts.id.renderButton(gNew, { ...look, text: 'signup_with' });
        google.accounts.id.renderButton(gBack, { ...look, text: 'signin_with' });
      }).catch((e) => say(e.message, 'err'));
      root.appendChild(modal);
      return;
    }

    // a deleted account (signed in again within its 14 days): only a way back
    if (a.deleting) {
      const until = new Date(a.deleting).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
      const sec = section('ACCOUNT DELETED');
      const back = el('button', 'rka-amt rka-on', 'RESTORE MY ACCOUNT');
      back.addEventListener('click', async () => {
        back.disabled = true;
        try { const j = await api('restore', {}); A.account = j.account; changed(); open({ fresh: true, msg: 'Welcome back! Your account is restored.', ok: true }); }
        catch (e) { back.disabled = false; say(e.message, 'err'); }
      });
      sec.append(el('div', 'rka-note', `You deleted this account. You can still restore this account within 14 days: it's gone for good on ${until}.`), back);
      const links = el('div', 'rka-links'), out = el('a', null, 'Sign out');
      out.addEventListener('click', async () => { try { await api('logout', {}); } catch { /* gone anyway */ } setSession('', null); close(); });
      links.append(out);
      box.append(el('h2', null, 'YOUR SWAG ACCOUNT'), sec, msg, closeBtn, links, fine(`${signedInAs(a)}. `));
      sayOpts();
      root.appendChild(modal);
      return;
    }

    const paid = Number(a.paid) || 0;
    const shown = a.show !== false;

    // Signed in: the account menu, one section per thing (stats & progress go in here later). The amount picker is
    // its own view (opts.view 'pay', with BACK).
    if (opts.view !== 'pay') {
      box.append(el('h2', null, opts.thanks ? 'THANK YOU!' : 'YOUR SWAG ACCOUNT'), el('div', 'rkr-gsub', `Hi ${a.name || 'there'}!`));
      // Swag: your total, the "shown online" switch (server: accounts.js 'show') and adding more
      const swag = section(paid > 0 ? 'SWAG' : 'ACTIVATE YOUR SWAG ACCOUNT');
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
        swag.append(el('div', 'rka-note', `Chip in once, from ${fmtPaid(A.cfg.min)}, to activate your account: the total shows next to your kitty for everyone online (can toggle it on and off), the game keeps your stats and you can earn unlocks in Multiplayer games.`), pick);
      }
      // Unlocks (shared/unlocks.js): earned online, kept forever, each switched on or off here
      const unl = unlocksBox('UNLOCKS', a.unlocks || {}, async (id, on) => { A.account = (await api('equip', { item: id, on })).account; },
        'Earned in Multiplayer games. Switched on, they show on your kitty in every game, for everyone.');
      // Stats & progress: online (counted by the game server) or solo / local (reported by this browser), a tab each
      const stats = section('STATS & PROGRESS');
      const tabs = el('div', 'rka-tabs');
      for (const [k, label] of [['online', 'ONLINE'], ['local', 'SOLO & LOCAL']]) {
        const t = el('button', 'rka-amt rka-tab' + (k === statsTab ? ' rka-on' : ''), label);
        t.addEventListener('click', () => { statsTab = k; open({ fresh: true }); });
        tabs.appendChild(t);
      }
      // what the table shows: times cleared, or the fastest clear
      const what = el('div', 'rka-tabs');
      for (const [k, label] of [['clears', 'TIMES CLEARED'], ['best', 'FASTEST']]) {
        const t = el('button', 'rka-amt rka-tab' + (k === statsWhat ? ' rka-on' : ''), label);
        t.addEventListener('click', () => { statsWhat = k; open({ fresh: true }); });
        what.appendChild(t);
      }
      stats.append(tabs, what, statsView(a.stats && a.stats[statsTab]),
        el('div', 'rka-fine', statsTab === 'online' ? 'Counted by the game server in Multiplayer games.'
          : 'Counted by your own browser in solo and local co-op games.'));
      const links = el('div', 'rka-links');
      const out = el('a', null, 'Sign out'), del = el('a', null, 'Delete account');
      out.addEventListener('click', async () => { try { await api('logout', {}); } catch { /* gone anyway */ } setSession('', null); close(); });
      // deleting takes typing DELETE (in capitals), then a yes to ARE YOU SURE?: no account goes by an accidental click
      const delBox = el('div', 'rka-del');
      delBox.hidden = true;
      const delIn = el('input'); delIn.type = 'text'; delIn.placeholder = 'DELETE'; delIn.autocomplete = 'off'; delIn.spellcheck = false;
      const delGo = el('button', 'rka-amt rka-delgo', 'DELETE FOREVER'); delGo.disabled = true;
      const delNo = el('button', 'rka-amt', 'KEEP MY ACCOUNT');
      const delRow = el('div', 'rka-amts'); delRow.append(delNo, delGo);
      const delNote = el('div', 'rka-note', `This deletes your account${paid ? `, your ${fmtPaid(paid)} total` : ''}, your stats and your unlocks. You can still restore this account within 14 days by signing in again; after that it's gone for good. Payments aren't refunded. Type DELETE to confirm.`);
      // the last step: ARE YOU SURE?
      const sure = el('div', 'rka-del-sure');
      sure.hidden = true;
      const sureYes = el('button', 'rka-amt rka-delgo', 'YES, DELETE IT'), sureNo = el('button', 'rka-amt', 'NO, KEEP IT');
      const sureRow = el('div', 'rka-amts'); sureRow.append(sureNo, sureYes);
      sure.append(el('div', 'rka-sure', 'ARE YOU SURE?'), sureRow);
      delBox.append(delNote, delIn, delRow, sure);
      const reset = () => { delBox.hidden = true; sure.hidden = true; delNote.hidden = delIn.hidden = delRow.hidden = false; delIn.value = ''; delGo.disabled = true; sureYes.disabled = false; };
      delIn.addEventListener('input', () => { delGo.disabled = delIn.value.trim() !== 'DELETE'; });
      delNo.addEventListener('click', reset);
      sureNo.addEventListener('click', reset);
      del.addEventListener('click', () => { reset(); delBox.hidden = false; delIn.focus(); });
      delGo.addEventListener('click', () => {
        if (delIn.value.trim() !== 'DELETE') return;
        delNote.hidden = delIn.hidden = delRow.hidden = true;
        sure.hidden = false;
      });
      sureYes.addEventListener('click', async () => {
        if (delIn.value.trim() !== 'DELETE') return;
        sureYes.disabled = true;
        try {
          await api('delete', { confirm: 'DELETE' });
          setSession('', null);
          open({ msg: 'Your account is deleted. You can still restore this account within 14 days: just sign in again.' });
        } catch (e) { sureYes.disabled = false; say(e.message, 'err'); }
      });
      links.append(out, del);
      // stats and unlocks only on an active account (one that has paid; the server counts nothing before)
      box.append(swag, ...(paid > 0 ? [unl, stats] : [guestBox()]), msg, closeBtn, links, delBox, fine(`${signedInAs(a)}. `));
      sayOpts();
      root.appendChild(modal);
      // fresh numbers (a game may have counted since this page loaded): redraw if the menu is still the one showing
      if (!opts.fresh) {
        const mine = modal;
        api('me').then((j) => { if (modal === mine && j.account) { A.account = j.account; open({ ...opts, fresh: true }); } }).catch(() => { /* keep what we have */ });
      }
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
      fine(`${signedInAs(a)}. One-time payment through Stripe, no subscription. Your total shows right away, so payments can't be refunded. `));
    sync();
    sayOpts();
    root.appendChild(modal);
  }

  // Solo / local co-op stats: picked up from the local game's events and sent in small batches (server: 'progress').
  // A cleared level counts for the team; crowns and revives only for kitty 1 (whoever is signed in on this device).
  let local = null, localT = null, dayTime = null;
  function sendLocal() {
    clearTimeout(localT); localT = null;
    const p = local; local = null;
    if (!p || !A.token || !A.account) return;
    api('progress', p).then((j) => { if (j.account) A.account = j.account; }).catch(() => { /* best effort */ });
  }
  function noteLocal(sim, events) {
    if (!A.enabled || !A.token || !A.account || !(Number(A.account.paid) > 0)) return;
    const me = sim.players[0];
    for (const e of events) {
      if (e.type === 'gameOver' || e.type === 'victory') { sendLocal(); dayTime = null; continue; }
      if (e.type === 'stageClear') { dayTime = { level: e.level, time: sim.levelTime }; continue; }   // Run + Skate's day half
      const t = e.type === 'levelStart' ? 'reached' : e.type === 'levelClear' ? 'clear'
        : e.type === 'crown' && me && e.playerId === me.id ? 'crown' : e.type === 'revive' && me && e.by === me.id ? 'revive' : null;
      if (!t) continue;
      if (local && local.mode !== sim.mode) sendLocal();
      local ||= { mode: sim.mode, reached: 0, clears: [], times: [], crowns: 0, revives: 0 };
      const level = e.type === 'levelClear' ? e.level : (sim.levelData && sim.levelData.level) || sim.level;
      if (t === 'reached') local.reached = Math.max(local.reached, level);
      else if (t === 'clear') {
        local.reached = Math.max(local.reached, level); local.clears.push(level);
        local.times.push(sim.levelTime + (dayTime && dayTime.level === level ? dayTime.time : 0));
        dayTime = null;
      }
      else if (t === 'crown') local.crowns++;
      else local.revives++;
      if (t === 'clear' || local.crowns >= 3 || local.revives >= 100) sendLocal();
      else if (!localT) localT = setTimeout(sendLocal, 5000);
    }
  }

  return {
    init, open, close, noteLocal,
    isOpen: () => !!modal,
    enabled: () => A.enabled,
    token: () => A.token,
    signedIn: () => !!(A.token && A.account),
    paid: () => (A.account ? Number(A.account.paid) || 0 : 0),
    shown: () => !A.account || A.account.show !== false,   // the player's "shown online" switch
    onChange(fn) { changeFn = fn; },
    // an unlock this player has (an active account's, or this browser's), switched on or not (songs: settings.js)
    // fresh unlocks (a game was just won online): the account's, or this browser's
    async refresh() {
      if (A.token && A.account) { try { const j = await api('me'); if (j.account) { A.account = j.account; changed(); } } catch { /* keep what we have */ } }
      else loadGuest();
    },
    has(id) {
      const u = (A.account && Number(A.account.paid) > 0 && A.account.unlocks) || A.guest;
      return !!u && isUnlocked(u, id);
    },
    // the unlocks worn in this mode (each mode earns its own), switched on
    equipped(mode) {
      if (eqFor !== A.account || eqGuest !== A.guest || eqMode !== mode) {
        eqFor = A.account; eqGuest = A.guest; eqMode = mode;
        const u = (A.account && Number(A.account.paid) > 0 && A.account.unlocks) || A.guest;
        eqSet = new Set(u ? UNLOCKS.filter((x) => !x.song && isUnlocked(u, x, mode) && !(u.off && u.off[x.id])).map((x) => x.id) : []);
      }
      return eqSet;
    },
  };
}

export { createAccount, fmtPaid, fmtNum };
