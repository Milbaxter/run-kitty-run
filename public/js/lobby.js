// Online lobby screens (browser + room), styled with the same rkr-* look as ui.js.
// All player-supplied text is inserted with textContent.
import { inviteUrl, share } from './platform.js';

const CAT = `<svg viewBox="0 0 40 40"><path d="M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z" fill="currentColor" stroke="#2b1840" stroke-width="2.6" stroke-linejoin="round"/><path d="M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z" fill="#ff9ec4"/><ellipse cx="14.3" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/><ellipse cx="25.7" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/></svg>`;
const CROWN = `<svg viewBox="0 0 40 30"><path d="M3 26 L6 7 L14 16 L20 3 L26 16 L34 7 L37 26 Z" fill="#ffcf5a" stroke="#7a4b00" stroke-width="2.4" stroke-linejoin="round"/></svg>`;

const MODES = [
  { id: 'mixed', label: 'Run + Skate', tip: 'Level 2 is an ice rink' },
  { id: 'run', label: 'Run only', tip: 'No ice' },
  { id: 'ice', label: 'Skate only', tip: 'Every level is ice' },
];
const modeLabel = (id) => (MODES.find((m) => m.id === id) || MODES[0]).label;
const PLAT = { ios: ['🍎', 'iPhone / iPad app'], android: ['🤖', 'Android app'], web: ['🌐', 'Browser'] };

const CSS = `
.rkl-box{max-width:560px;text-align:center;}
.rkl-box h2{font-size:clamp(34px,5vw,50px)!important;}
.rkl-row{display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap;width:100%;}
.rkl-in{font:inherit;font-weight:800;font-size:18px;padding:10px 14px;border-radius:14px;border:2px solid rgba(255,255,255,.3);
  background:rgba(10,4,30,.55);color:#fff;outline:none;min-width:0;user-select:text;-webkit-user-select:text;}
.rkl-in:focus{border-color:#ffcf5a;}
.rkl-name{width:220px;text-align:center;}
.rkl-code{width:120px;text-align:center;text-transform:uppercase;letter-spacing:.2em;}
.rkl-small{font-size:15px!important;padding:10px 16px!important;}
.rkl-list{width:100%;display:flex;flex-direction:column;gap:6px;max-height:34vh;overflow:auto;text-align:left;}
.rkl-lob{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:14px;background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.14);
  font-weight:800;cursor:pointer;}
.rkl-lob:hover{background:rgba(255,255,255,.16);}
.rkl-lob .rkl-c{letter-spacing:.15em;color:#ffcf5a;min-width:58px;}
.rkl-lob .rkl-h{flex:1;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rkl-lob .rkl-n{opacity:.8;}
.rkl-lob.rkl-busy{opacity:.6;}
.rkl-empty{opacity:.6;font-weight:700;text-align:center;padding:10px;}
.rkl-err{min-height:20px;color:#ff8fa3;font-weight:800;}
.rkl-label{font-size:13px;font-weight:900;letter-spacing:.14em;color:#ffcf5a;text-transform:uppercase;margin-top:4px;}
.rkl-slots{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;width:100%;}
.rkl-slot{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:14px;background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.12);
  font-weight:800;min-height:46px;text-align:left;}
.rkl-slot.rkl-open{opacity:.35;border-style:dashed;}
.rkl-slot .rkl-cat{width:30px;height:30px;flex:none;}
.rkl-slot .rkl-pn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rkl-slot .rkl-crown{width:22px;height:18px;flex:none;}
.rkl-slot.rkl-me{border-color:rgba(255,207,90,.8);}
.rkl-you{font-size:11px;opacity:.7;margin-left:4px;}
.rkl-bigcode{font-size:44px;font-weight:900;letter-spacing:.25em;color:#fff6d8;line-height:1;margin-right:-.25em;}
.rkl-wait{font-weight:800;opacity:.85;}
@media (max-height:500px){
  .rkl-box h2{font-size:28px !important;}
  .rkl-slots{grid-template-columns:repeat(4,1fr);gap:5px;}
  .rkl-slot{min-height:36px;padding:3px 6px;font-size:13px;}
  .rkl-slot .rkl-cat{width:22px;height:22px;}
  .rkl-bigcode{font-size:30px;}
  .rkl-list{max-height:28vh;}
  .rkl-label{margin-top:0;}
}
.rkl-modes{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;}
.rkl-mode{font:inherit;font-weight:900;font-size:14px;padding:7px 12px;border-radius:12px;cursor:pointer;color:#fff;
  background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.18);}
.rkl-mode:hover{background:rgba(255,255,255,.16);}
.rkl-mode.rkl-on{background:rgba(255,207,90,.22);border-color:#ffcf5a;color:#fff6d8;}
.rkl-modetip{font-size:12px;font-weight:700;opacity:.7;min-height:15px;}
.rkl-tag{font-size:11px;font-weight:900;letter-spacing:.06em;padding:2px 7px;border-radius:8px;background:rgba(143,220,255,.18);color:#bfe8ff;white-space:nowrap;}
.rkl-roommode{font-weight:900;color:#bfe8ff;}
.rkl-link{font-size:13px;font-weight:700;opacity:.75;word-break:break-all;user-select:text;-webkit-user-select:text;}
.rkl-invite{min-width:220px;}
.rkl-plat{font-size:13px;flex:none;opacity:.85;}
@media (max-height:500px){ .rkl-invite{padding:8px 22px 10px!important;} }
`;

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
const hex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');

function createLobbyUI(root, cb) {
  if (!document.getElementById('rkl-style')) {
    const s = document.createElement('style');
    s.id = 'rkl-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  let node = null;
  let view = null; // 'browser' | 'room'
  let errEl = null;
  let listEl = null;
  let roomRefs = null;
  let refreshT = 0;

  function savedName() {
    try { return localStorage.getItem('rkr-name') || ''; } catch { return ''; }
  }
  function savedMode() {
    try { const m = localStorage.getItem('rkr-mode'); return MODES.some((x) => x.id === m) ? m : 'mixed'; } catch { return 'mixed'; }
  }
  function saveMode(m) {
    try { localStorage.setItem('rkr-mode', m); } catch { /* ignore */ }
  }
  function saveName(n) {
    try { localStorage.setItem('rkr-name', n); } catch { /* ignore */ }
  }

  function mount(inner) {
    clearInterval(refreshT);
    if (node) node.remove();
    node = el('div', 'rkr-overlay rkr-dim');
    const box = el('div', 'rkr-glass rkl-box');
    box.append(...inner);
    node.appendChild(box);
    // keep game keys (WASD, M, P) from firing while typing
    node.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') e.stopPropagation(); });
    root.appendChild(node);
  }

  function showBrowser() {
    view = 'browser';
    roomRefs = null;
    errEl = null;
    const h = el('h2', null, 'ONLINE');
    const sub = el('div', 'rkr-gsub', 'Up to 8 kitties per lobby. The first one in starts the run.');
    const nameLab = el('div', 'rkl-label', 'Your name');
    const name = el('input', 'rkl-in rkl-name');
    name.maxLength = 14;
    name.placeholder = 'Kitty name';
    name.value = savedName();
    const getName = () => { const n = name.value.trim(); saveName(n); return n; };

    // game mode for a new lobby (remembered)
    let mode = savedMode();
    const modeLab = el('div', 'rkl-label', 'Mode for a new lobby');
    const modes = el('div', 'rkl-modes');
    const tip = el('div', 'rkl-modetip');
    const paint = () => {
      for (const b of modes.children) b.classList.toggle('rkl-on', b.dataset.mode === mode);
      tip.textContent = MODES.find((m) => m.id === mode).tip;
    };
    for (const m of MODES) {
      const b = el('button', 'rkl-mode');
      b.textContent = m.label;
      b.dataset.mode = m.id;
      b.addEventListener('click', () => { mode = m.id; saveMode(mode); paint(); });
      modes.appendChild(b);
    }
    paint();

    const create = el('button', 'rkr-btn', '<span>CREATE LOBBY</span>');
    create.addEventListener('click', () => cb.onCreate(getName(), mode));

    const code = el('input', 'rkl-in rkl-code');
    code.maxLength = 4;
    code.placeholder = 'CODE';
    const join = el('button', 'rkr-btn rkr-alt rkl-small', 'JOIN');
    const doJoin = () => { if (code.value.trim()) cb.onJoin(code.value.trim().toUpperCase(), getName()); };
    join.addEventListener('click', doJoin);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

    const listLab = el('div', 'rkl-label', 'Open lobbies');
    listEl = el('div', 'rkl-list', '<div class="rkl-empty">Looking for lobbies…</div>');
    errEl = el('div', 'rkl-err');
    const back = el('button', 'rkr-btn rkr-alt rkl-small', 'BACK');
    back.addEventListener('click', () => cb.onBack());

    const row1 = el('div', 'rkl-row');
    row1.append(create);
    const row2 = el('div', 'rkl-row');
    row2.append(code, join);
    mount([h, sub, listLab, listEl, nameLab, name, modeLab, modes, tip, row1, row2, errEl, back]); // open lobbies first, then create / join by code
    listEl._getName = getName;
    cb.onRefresh();
    clearInterval(refreshT);
    refreshT = setInterval(() => cb.onRefresh(), 3000);
  }

  function setLobbies(list) {
    if (view !== 'browser' || !listEl) return;
    listEl.textContent = '';
    if (!list.length) {
      listEl.appendChild(el('div', 'rkl-empty', 'No open lobbies yet. Create one!'));
      return;
    }
    for (const l of list) {
      const full = l.players >= l.max;
      const row = el('div', 'rkl-lob' + (l.phase !== 'lobby' || full ? ' rkl-busy' : ''));
      const c = el('span', 'rkl-c'); c.textContent = l.code;
      const h = el('span', 'rkl-h'); h.textContent = l.host + (l.phase === 'lobby' ? '' : ` · playing L${l.level}`);
      const tg = el('span', 'rkl-tag'); tg.textContent = modeLabel(l.mode);
      const n = el('span', 'rkl-n'); n.textContent = `${l.players}/${l.max}`;
      row.append(c, h, tg, n);
      if (!full) row.addEventListener('click', () => cb.onJoin(l.code, listEl._getName()));
      listEl.appendChild(row);
    }
  }

  function showRoom(info) {
    if (view !== 'room') {
      view = 'room';
      listEl = null;
      const h = el('h2', null, 'LOBBY');
      const code = el('div', 'rkl-bigcode');
      const roomMode = el('div', 'rkl-roommode');
      const link = el('div', 'rkl-link');
      // share sheet in the app / on phones, clipboard on desktop
      const copy = el('button', 'rkr-btn rkr-alt rkl-invite', '<span>INVITE FRIENDS</span><small>send the lobby link</small>');
      let copyT = 0;
      copy.addEventListener('click', async () => {
        if (!roomRefs) return;
        const c = roomRefs.code.textContent;
        const res = await share({ title: 'Run Kitty Run', text: `Join my Run Kitty Run lobby! Code ${c}`, url: inviteUrl(c) });
        if (res !== 'copied' && res !== 'failed') return;
        copy.firstChild.textContent = res === 'copied' ? 'LINK COPIED!' : 'COPY FAILED';
        clearTimeout(copyT);
        copyT = setTimeout(() => { copy.firstChild.textContent = 'INVITE FRIENDS'; }, 1400);
      });
      const slots = el('div', 'rkl-slots');
      const wait = el('div', 'rkl-wait');
      const start = el('button', 'rkr-btn', '<span>START GAME</span>');
      start.addEventListener('click', () => cb.onStart());
      errEl = el('div', 'rkl-err');
      const leave = el('button', 'rkr-btn rkr-alt rkl-small', 'LEAVE');
      leave.addEventListener('click', () => cb.onLeave());
      const row = el('div', 'rkl-row');
      row.append(copy);
      const row2 = el('div', 'rkl-row');
      row2.append(start, leave);
      mount([h, code, roomMode, link, row, slots, wait, row2, errEl]);
      roomRefs = { code, roomMode, link, slots, wait, start };
    }
    const r = roomRefs;
    r.code.textContent = info.code;
    r.roomMode.textContent = 'Mode: ' + modeLabel(info.mode);
    r.link.textContent = inviteUrl(info.code);
    r.slots.textContent = '';
    for (let i = 0; i < 8; i++) {
      const m = info.members[i];
      const s = el('div', 'rkl-slot' + (m ? '' : ' rkl-open') + (m && m.id === info.you ? ' rkl-me' : ''));
      const cat = el('div', 'rkl-cat', CAT);
      cat.style.color = m ? hex(m.color) : '#888';
      const pn = el('span', 'rkl-pn');
      pn.textContent = m ? m.name : 'open';
      if (m && m.id === info.you) pn.appendChild(el('span', 'rkl-you', '(you)'));
      s.append(cat, pn);
      if (m && PLAT[m.app]) {
        const b = el('span', 'rkl-plat');
        b.textContent = PLAT[m.app][0];
        b.title = PLAT[m.app][1];
        s.appendChild(b);
      }
      if (m && m.id === info.host) s.appendChild(el('div', 'rkl-crown', CROWN));
      r.slots.appendChild(s);
    }
    const isHost = info.host === info.you;
    const host = info.members.find((m) => m.id === info.host);
    r.start.style.display = isHost && info.phase === 'lobby' ? '' : 'none';
    r.wait.textContent = info.phase !== 'lobby'
      ? 'A run is in progress. Joining…'
      : isHost ? `You're the host. Start whenever you're ready (${info.members.length}/8).`
        : `Waiting for ${host ? host.name : 'the host'} to start…`;
  }

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    // short landscape phones: the panel scrolls, so make sure the message is actually on screen
    if (msg && errEl.scrollIntoView) errEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function hide() {
    clearInterval(refreshT);
    if (node) node.remove();
    node = null;
    view = null;
    errEl = null;
    listEl = null;
    roomRefs = null;
  }

  return { showBrowser, setLobbies, showRoom, showError, hide, isOpen: () => !!node, view: () => view };
}

export { createLobbyUI };
