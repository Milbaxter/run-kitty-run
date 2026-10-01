// Online lobby screens (browser + room), styled with the same rkr-* look as ui.js.
// All player-supplied text is inserted with textContent.

const CAT = `<svg viewBox="0 0 40 40"><path d="M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z" fill="currentColor" stroke="#2b1840" stroke-width="2.6" stroke-linejoin="round"/><path d="M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z" fill="#ff9ec4"/><ellipse cx="14.3" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/><ellipse cx="25.7" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/></svg>`;
const CROWN = `<svg viewBox="0 0 40 30"><path d="M3 26 L6 7 L14 16 L20 3 L26 16 L34 7 L37 26 Z" fill="#ffcf5a" stroke="#7a4b00" stroke-width="2.4" stroke-linejoin="round"/></svg>`;

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
.rkl-link{font-size:13px;font-weight:700;opacity:.75;word-break:break-all;user-select:text;-webkit-user-select:text;}
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

    const create = el('button', 'rkr-btn', '<span>CREATE LOBBY</span>');
    create.addEventListener('click', () => cb.onCreate(getName()));

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
    mount([h, sub, nameLab, name, row1, row2, listLab, listEl, errEl, back]);
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
      const n = el('span', 'rkl-n'); n.textContent = `${l.players}/${l.max}`;
      row.append(c, h, n);
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
      const link = el('div', 'rkl-link');
      const copy = el('button', 'rkr-btn rkr-alt rkl-small', 'COPY INVITE LINK');
      copy.addEventListener('click', () => {
        const done = () => { copy.textContent = 'COPIED!'; setTimeout(() => { copy.textContent = 'COPY INVITE LINK'; }, 1400); };
        if (navigator.clipboard) navigator.clipboard.writeText(link.textContent).then(done, () => {});
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
      mount([h, code, link, row, slots, wait, row2, errEl]);
      roomRefs = { code, link, slots, wait, start };
    }
    const r = roomRefs;
    r.code.textContent = info.code;
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', info.code);
    r.link.textContent = url.toString();
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
    if (errEl) errEl.textContent = msg;
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
