// Legends board: the teams that beat Run Kitty Run, with one line per kitty. Only finishers see it: online winners get
// it from the server over ws ('legends', live 'legend' updates) and sign over ws; offline (solo / local co-op) winners
// read it with GET /api/legends and sign with POST /api/legends (one line per local kitty). Either way lines can be
// changed for 15 minutes after the win. Opened from the victory screen (and, while an online winner can still sign,
// from a small button in the lobby). All player text goes in with textContent; the apps mask it like chat (net.js).
import { apiUrl, NATIVE } from './platform.js';
import { cleanForApp } from './net.js';
import { TOUCH } from './device.js';

const MAX = 140;
const MODES = { mixed: 'Run + Skate', run: 'Run only', ice: 'Skate only' };

const CSS = `
.rkg-wrap{position:absolute;inset:0;z-index:45;display:flex;align-items:center;justify-content:flex-end;pointer-events:none;
  padding:max(14px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));}
.rkg-box{pointer-events:auto;position:relative;width:100%;max-width:480px;max-height:100%;display:flex;flex-direction:column;gap:10px;padding:18px 18px 14px;
  border-radius:26px;background:linear-gradient(160deg,rgba(52,30,96,.94),rgba(26,12,52,.94));border:3px solid rgba(255,215,100,.75);
  box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 40px rgba(255,200,80,.25),inset 0 1px 0 rgba(255,255,255,.35);animation:rkr-cardin .4s cubic-bezier(.2,1.4,.4,1);
  user-select:text;-webkit-user-select:text;}
.rkg-box h2{margin:0;text-align:center;font-weight:900;font-size:clamp(26px,4vw,38px);line-height:1;color:#ffe27a;-webkit-text-stroke:2px #3a1650;paint-order:stroke fill;
  text-shadow:0 4px 0 #3a1650,0 0 26px rgba(255,200,80,.7);}
.rkg-sub{text-align:center;font-weight:700;font-size:14px;color:#efe7ff;opacity:.85;}
.rkg-x{position:absolute;right:10px;top:8px;width:38px;height:38px;border-radius:12px;border:2px solid rgba(255,255,255,.25);background:rgba(0,0,0,.25);
  color:#fff;font:inherit;font-weight:900;font-size:20px;line-height:1;cursor:pointer;}
.rkg-x:hover{border-color:rgba(255,255,255,.6);}
.rkg-sign{display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:16px;background:rgba(255,210,80,.1);border:2px solid rgba(255,210,80,.45);}
.rkg-row{display:flex;gap:8px;align-items:center;}
.rkg-in{flex:1;min-width:0;font:inherit;font-weight:700;font-size:16px;padding:9px 12px;border-radius:12px;border:2px solid rgba(255,255,255,.3);
  background:rgba(10,4,30,.6);color:#fff;outline:none;}
.rkg-in:focus{border-color:#ffcf5a;}
.rkg-go{font-size:16px !important;padding:9px 16px !important;flex:none;}
.rkg-meta{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:800;opacity:.75;}
.rkg-msg.rkg-err{color:#ff8fa3;opacity:1;}
.rkg-msg.rkg-ok{color:#9dff7a;opacity:1;}
.rkg-who{flex:none;max-width:30%;overflow:hidden;text-overflow:ellipsis;font-size:14px;}
.rkg-list{flex:1 1 auto;min-height:60px;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px;touch-action:pan-y;-webkit-overflow-scrolling:touch;}
.rkg-card{padding:9px 12px;border-radius:16px;background:rgba(0,0,0,.24);border:2px solid rgba(255,255,255,.12);}
.rkg-card.rkg-mine{border-color:rgba(255,215,100,.8);background:rgba(255,210,80,.08);}
.rkg-head{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;font-size:12px;font-weight:900;letter-spacing:.06em;color:#ffcf5a;margin-bottom:4px;}
.rkg-head span{opacity:.85;}
.rkg-head .rkg-you{background:#ff5c93;color:#fff;border-radius:6px;padding:0 6px;letter-spacing:.1em;opacity:1;}
.rkg-line{font-weight:700;font-size:14.5px;line-height:1.4;color:#f4eeff;overflow-wrap:anywhere;margin:2px 0;}
.rkg-line q{font-style:italic;quotes:"\\201C" "\\201D";}
.rkg-n{font-weight:900;-webkit-text-stroke:3px #2b1840;paint-order:stroke fill;white-space:nowrap;}
.rkg-also{font-size:13px;font-weight:800;opacity:.85;margin-top:3px;}
.rkg-empty{text-align:center;font-weight:700;opacity:.7;padding:14px;}
.rkg-close{align-self:center;font-size:16px !important;padding:8px 22px !important;}
.rkg-fab{position:absolute;z-index:44;right:max(16px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top));pointer-events:auto;cursor:pointer;
  font:inherit;font-weight:900;font-size:14px;letter-spacing:.04em;color:#2b1840;padding:8px 14px;border-radius:999px;border:0;
  background:linear-gradient(180deg,#fff3c4,#ffcf5a);box-shadow:0 4px 0 #3a1650,0 8px 18px rgba(0,0,0,.35);display:none;}
.rkg-fab.rkg-on{display:block;}
@media (max-width:760px){ .rkg-wrap{justify-content:center;} .rkg-box{max-width:none;} }
@media (max-height:500px){
  .rkg-box{padding:10px 12px 8px;gap:6px;border-radius:18px;}
  .rkg-box h2{font-size:24px;}
  .rkg-sub{display:none;}
  .rkg-sign{padding:6px 8px;gap:4px;}
  .rkg-in{font-size:15px;padding:6px 10px;}
  .rkg-close{display:none;}
  .rkg-line{font-size:13.5px;}
}
`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const hex = (c) => (typeof c === 'number' ? '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0') : /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#ffffff');
const fmtTime = (t) => { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return iso.slice(0, 10); }
}

// send(msg): ws send; isOnline(): connected to the server; onOpenChange(open): the board opened / closed
function createLegends(root, { send, isOnline, onOpenChange }) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  let wins = null;          // newest first, or null = not loaded
  // while this player may sign: online { id, text, until (performance.now ms) };
  // offline { offline: true, id, key (null until the first SIGN), ctx: { mode, runTime, time }, players: [{ name, color, text }], until }
  let can = null;
  let offline = false;      // the board of an offline win (HTTP)
  let loadErr = '';
  let wrap = null, refs = null;

  const fab = el('button', 'rkg-fab', '📜 LEGENDS BOARD');
  fab.addEventListener('click', () => open());
  root.appendChild(fab);

  const canSign = () => !!can && performance.now() < can.until;

  // ---- data ----
  function onBoard(m) {   // ws 'legends': the board plus this player's own slot
    wins = Array.isArray(m.wins) ? m.wins : [];
    can = m.can ? { id: m.can.id, text: m.can.text || '', until: performance.now() + (m.can.left || 0) } : null;
    offline = false;
    loadErr = '';
    render();
  }
  function onLegend(m) {  // ws 'legend': someone on a legend you're part of signed it
    if (!wins || !m.win) return;
    const i = wins.findIndex((w) => w.id === m.win.id);
    if (i >= 0) wins[i] = m.win; else wins.unshift(m.win);
    render();
  }
  function onSigned(m) {
    if (!refs || !refs.msg) return;
    refs.go.disabled = false;
    if (m.ok) {
      if (can) can.text = m.text || '';
      refs.msg.className = 'rkg-msg rkg-ok';
      refs.msg.textContent = m.text ? 'Signed! You can still change it.' : 'Your line is cleared.';
    } else {
      refs.msg.className = 'rkg-msg rkg-err';
      refs.msg.textContent = m.msg || 'Could not sign right now.';
      if (/closed/.test(m.msg || '')) { can = null; render(); }
    }
  }
  const appClean = (w) => { const m = { t: 'legend', win: w }; if (NATIVE) cleanForApp(m); return m.win; }; // apps: mask like chat
  function putWin(w) {
    if (!w) return;
    w = appClean(w);
    if (!wins) wins = [];
    const i = wins.findIndex((q) => q.id === w.id);
    if (i >= 0) wins[i] = w; else wins.unshift(w);
  }
  // offline win (ctx: { mode, runTime, time, players: [{ name, color }] }): fetch the board; the kitties may sign it
  async function fetchOffline(ctx) {
    offline = true;
    can = ctx && Array.isArray(ctx.players) && ctx.players.length ? {
      offline: true, id: null, key: null, until: performance.now() + 15 * 60e3,
      ctx: { mode: ctx.mode, runTime: ctx.runTime, time: ctx.time },
      players: ctx.players.map((p) => ({ name: p.name, color: p.color, text: '' })),
    } : null;
    wins = null;
    loadErr = '';
    render();
    try {
      const r = await fetch(apiUrl('/api/legends'), { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error();
      const msg = { t: 'legends', wins: Array.isArray(j.wins) ? j.wins : [] };
      if (NATIVE) cleanForApp(msg); // the apps mask names and lines like chat
      if (offline) { const mine = can && can.id && wins && wins.find((w) => w.id === can.id); wins = msg.wins; if (mine) putWin(mine); }
    } catch {
      loadErr = 'The legends board is out of reach right now (no connection?).';
    }
    render();
  }

  // ---- panel ----
  function onKey(e) { // window, capture: Esc closes the board wherever the focus is (and goes no further)
    if (!wrap || e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation(); close();
  }
  function open() {
    if (wrap) { render(); return; }
    wrap = el('div', 'rkg-wrap');
    const box = el('div', 'rkg-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Legends board');
    box.tabIndex = -1;
    const x = el('button', 'rkg-x', '✕');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    const h = el('h2', null, 'LEGENDS BOARD');
    const sub = el('div', 'rkg-sub', 'Every team that beat Run Kitty Run, in their own words.');
    const signSlot = el('div');
    const list = el('div', 'rkg-list');
    const closeBtn = el('button', 'rkr-btn rkr-alt rkg-close', 'CLOSE');
    closeBtn.addEventListener('click', close);
    box.append(x, h, sub, signSlot, list, closeBtn);
    wrap.appendChild(box);
    // typing must not move the kitty / trigger game keys (the board's own keys stop here, after the input saw them)
    wrap.addEventListener('keydown', (e) => e.stopPropagation());
    wrap.addEventListener('keyup', (e) => e.stopPropagation());
    root.appendChild(wrap);
    refs = { box, signSlot, list, signKey: '' };
    window.addEventListener('keydown', onKey, true);
    fab.classList.remove('rkg-on');
    render();
    setTimeout(() => { if (refs) (refs.input && !TOUCH ? refs.input : box).focus({ preventScroll: true }); }, 30);
    if (onOpenChange) onOpenChange(true);
  }
  function close() {
    if (!wrap) return;
    window.removeEventListener('keydown', onKey, true);
    wrap.remove();
    wrap = null; refs = null;
    if (onOpenChange) onOpenChange(false);
  }

  const oneLine = (v) => v.replace(/\s+/g, ' ').trim().slice(0, MAX);
  function setMsg(text, cls) { if (refs && refs.msg) { refs.msg.className = 'rkg-msg' + (cls ? ' rkg-' + cls : ''); refs.msg.textContent = text; } }

  // offline: first SIGN puts the win on the board (server returns id + key), later ones edit the lines
  async function signOffline(texts) {
    const c = can;
    const body = c.id
      ? { id: c.id, key: c.key, players: texts.map((text) => ({ text })) }
      : { ...c.ctx, players: c.players.map((p, i) => ({ name: p.name, color: p.color, text: texts[i] })) };
    let j = {};
    try {
      const r = await fetch(apiUrl('/api/legends'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.msg || 'Could not sign right now.');
    } catch (err) {
      if (refs && refs.go) refs.go.disabled = false;
      setMsg(err.message && !/fetch|network/i.test(err.message) ? err.message : 'Could not reach the board, try again in a moment.', 'err');
      if (/closed/.test(j.msg || '')) { can = null; render(); }
      return;
    }
    if (can !== c) return;
    if (j.id) { c.id = j.id; c.key = j.key; }
    if (Number.isFinite(j.left)) c.until = performance.now() + j.left;
    texts.forEach((t, i) => { c.players[i].text = t; });
    putWin(j.win);
    render();
    if (refs && refs.go) refs.go.disabled = false;
    setMsg(texts.some(Boolean) ? 'Signed! You can still change it.' : 'On the board!', 'ok');
  }

  function renderSign() {
    const key = canSign() ? 'sign:' + (can.offline ? 'offline:' + (can.id ? 'on' : 'new') : can.id) : 'none';
    if (key === refs.signKey) return;
    refs.signKey = key;
    refs.signSlot.textContent = '';
    refs.input = refs.go = refs.msg = null;
    if (key === 'none') return;
    // one input per kitty: online that's you; offline the local players (solo, or both co-op kitties on this device)
    const slots = can.offline ? can.players : [{ text: can.text }];
    const signed = can.offline ? !!can.id : !!can.text;
    const box = el('div', 'rkg-sign');
    const inputs = [];
    const go = el('button', 'rkr-btn rkg-go', signed ? 'UPDATE' : 'SIGN');
    slots.forEach((p, i) => {
      const row = el('div', 'rkg-row');
      if (slots.length > 1) {
        const n = el('span', 'rkg-n rkg-who', p.name);
        n.style.color = hex(p.color);
        row.appendChild(n);
      }
      const input = el('input', 'rkg-in');
      input.type = 'text';
      input.maxLength = MAX;
      input.placeholder = 'Leave your mark (1–2 sentences)';
      input.value = p.text || '';
      input.setAttribute('aria-label', slots.length > 1 ? `${p.name}'s line on the legends board` : 'Your line on the legends board');
      input.enterKeyHint = i === slots.length - 1 ? 'send' : 'next';
      inputs.push(input);
      row.appendChild(input);
      if (i === slots.length - 1) row.appendChild(go);
      box.appendChild(row);
    });
    const meta = el('div', 'rkg-meta');
    const msg = el('span', 'rkg-msg', slots.length > 1 ? 'One line each, signed with your kitties\' names' : can.offline ? `Signed as ${slots[0].name || 'you'}` : 'Signed with your kitty\'s name');
    const count = el('span', null, `${inputs[0].value.length} / ${MAX}`);
    meta.append(msg, count);
    box.appendChild(meta);
    refs.signSlot.appendChild(box);
    Object.assign(refs, { input: inputs[0], go, msg });
    inputs.forEach((input) => {
      const upd = () => { count.textContent = `${input.value.length} / ${MAX}`; };
      input.addEventListener('input', upd);
      input.addEventListener('focus', upd);
    });
    const submit = () => {
      if (!canSign()) { setMsg('The signing window for your win has closed.', 'err'); return; }
      const texts = inputs.map((x) => oneLine(x.value));
      go.disabled = true;
      setMsg('Signing…');
      if (can.offline) { signOffline(texts); return; }
      if (!isOnline()) { go.disabled = false; setMsg('Not connected, try again in a moment.', 'err'); return; }
      send({ t: 'sign', text: texts[0] });
      go.textContent = 'UPDATE';
      setTimeout(() => { go.disabled = false; }, 1500); // in case no reply comes back
    };
    go.addEventListener('click', submit);
    inputs.forEach((input, i) => input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i < inputs.length - 1) inputs[i + 1].focus(); else submit();
    }));
  }

  function render() {
    if (!refs) return;
    renderSign();
    const list = refs.list;
    const top = list.scrollTop;
    list.textContent = '';
    if (!wins) { list.appendChild(el('div', 'rkg-empty', loadErr || 'Unrolling the scroll…')); return; }
    if (!wins.length) { list.appendChild(el('div', 'rkg-empty', 'No legends yet. Be the first team to sign!')); return; }
    const mine = can && can.id;
    for (const w of wins) {
      const card = el('div', 'rkg-card' + (w.id === mine ? ' rkg-mine' : ''));
      const head = el('div', 'rkg-head');
      head.appendChild(el('span', null, fmtDate(w.at)));
      head.appendChild(el('span', null, (MODES[w.mode] || 'Run Kitty Run') + (w.kind === 'solo' ? ' · solo' : w.kind === 'coop' ? ' · co-op' : '')));
      if (Number.isFinite(w.runTime)) head.appendChild(el('span', null, '⏱ ' + fmtTime(w.runTime)));
      if (w.id === mine) head.appendChild(el('span', 'rkg-you', 'YOUR TEAM'));
      card.appendChild(head);
      const entries = Array.isArray(w.entries) ? w.entries : [];
      const quiet = [];
      for (const e of entries) {
        if (!e || typeof e.name !== 'string') continue;
        if (!e.text) { quiet.push(e); continue; }
        const line = el('div', 'rkg-line');
        line.append(el('q', null, String(e.text)), ' — ');
        const n = el('span', 'rkg-n', e.name);
        n.style.color = hex(e.color);
        line.appendChild(n);
        card.appendChild(line);
      }
      if (quiet.length) {
        const also = el('div', 'rkg-also');
        also.append(entries.some((e) => e && e.text) ? 'with ' : '');
        quiet.forEach((e, i) => {
          if (i) also.append(', ');
          const n = el('span', 'rkg-n', e.name);
          n.style.color = hex(e.color);
          also.appendChild(n);
        });
        card.appendChild(also);
      }
      list.appendChild(card);
    }
    list.scrollTop = top;
  }

  // gamepad: d-pad up/down scrolls the list
  function scrollBy(dy) { if (refs) refs.list.scrollTop += dy; }
  // lobby shortcut while you can still sign (set from main.js)
  function setFab(on) { fab.classList.toggle('rkg-on', !!on && !wrap); }
  function reset() { close(); if (offline) { wins = null; can = null; offline = false; loadErr = ''; } } // a new run: offline boards are per win

  return {
    onBoard, onLegend, onSigned, fetchOffline, open, close, isOpen: () => !!wrap, scrollBy, setFab, reset,
    canSign, available: () => offline || !!wins,
  };
}

export { createLegends };
