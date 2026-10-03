// Online lobby screens (browser + room), styled with the same rkr-* look as ui.js.
// All player-supplied text is inserted with textContent.
import { createColorRow, prefColor } from './kittycolor.js';
import { PLAYER_COLORS, PLAYER_NAMES } from './shared/config.js';
import { inviteUrl, share } from './platform.js';

const CAT = `<svg viewBox="0 0 40 40"><path d="M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z" fill="currentColor" stroke="#2b1840" stroke-width="2.6" stroke-linejoin="round"/><path d="M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z" fill="#ff9ec4"/><ellipse cx="14.3" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/><ellipse cx="25.7" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/></svg>`;
const CROWN = `<svg viewBox="0 0 40 30"><path d="M3 26 L6 7 L14 16 L20 3 L26 16 L34 7 L37 26 Z" fill="#ffcf5a" stroke="#7a4b00" stroke-width="2.4" stroke-linejoin="round"/></svg>`;

const MODES = [
  { id: 'mixed', label: 'Run + Skate', tip: 'Summer, fall, winter (ice); level 9 is the final boss run' },
  { id: 'run', label: 'Run only', tip: 'No ice' },
  { id: 'ice', label: 'Skate only', tip: 'Every level is ice; level 9 is the final boss run' },
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
.rkl-small{font-size:15px!important;padding:10px 16px!important;}
.rkl-err{min-height:20px;color:#ff8fa3;font-weight:800;}
.rkl-label{font-size:13px;font-weight:900;letter-spacing:.14em;color:#ffcf5a;text-transform:uppercase;margin-top:4px;}
.rkl-slots{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;width:100%;max-height:34vh;overflow:auto;}
.rkl-slot{min-width:0;}
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
  .rkl-label{margin-top:0;}
}
.rkl-roommode{font-weight:900;color:#bfe8ff;}
.rkl-link{font-size:13px;font-weight:700;opacity:.75;word-break:break-all;user-select:text;-webkit-user-select:text;}
.rkl-invite{min-width:220px;}
.rkl-plat{font-size:13px;flex:none;opacity:.85;}
@media (max-height:500px){ .rkl-invite{padding:8px 22px 10px!important;} }
/* lobby browser: header, "you" row, then join (left) / start your own (right) */
.rkr-glass.rkl-bbox{max-width:880px;text-align:left;align-items:stretch;gap:12px;padding:16px 20px 18px;}
.rkl-head{display:flex;align-items:center;gap:12px;min-width:0;}
.rkl-bbox h2{font-size:34px!important;}
.rkl-hsub{margin-left:auto;font-weight:700;font-size:13px;opacity:.6;text-align:right;}
.rkl-back{flex:none;width:44px;height:44px;padding:0 0 3px;border-radius:14px;border:3px solid #3a1650;cursor:pointer;font:inherit;font-weight:900;font-size:24px;line-height:1;
  color:#3a1650;background:linear-gradient(180deg,#e3f7ff,#7fd8ff 55%,#5b9dff);box-shadow:0 4px 0 #3a1650;transition:transform .12s,box-shadow .12s;}
.rkl-back:hover{transform:translateY(-2px);box-shadow:0 6px 0 #3a1650;}
.rkl-back:active{transform:translateY(3px);box-shadow:0 1px 0 #3a1650;}
.rkl-back:focus:not(:focus-visible){outline:none;}
.rkl-you{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;padding:4px 10px;border-radius:18px;background:rgba(10,4,30,.32);border:2px solid rgba(255,255,255,.14);}
.rkl-youlab{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:900;letter-spacing:.12em;color:#ffcf5a;text-transform:uppercase;white-space:nowrap;}
.rkl-youcat{width:32px;height:32px;flex:none;}
.rkl-youcat.rkl-any{animation:rkcp-hue 4s linear infinite;}
.rkl-namebox{display:flex;align-items:center;gap:6px;}
.rkl-in.rkl-name{width:150px;height:40px;box-sizing:border-box;padding:6px 12px;font-size:17px;}
.rkl-dice{flex:none;width:40px;height:40px;padding:0;border-radius:12px;cursor:pointer;font-size:20px;line-height:1;background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.22);}
.rkl-dice:hover{background:rgba(255,255,255,.2);border-color:#ffcf5a;}
.rkl-dice:active{transform:rotate(-25deg) scale(.92);}
.rkl-you .rkcr{flex:1 1 auto;}
.rkl-cols{display:flex;gap:12px;align-items:stretch;min-height:0;}
.rkl-col{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px 12px;border-radius:20px;background:rgba(255,255,255,.06);
  border:2px solid rgba(255,255,255,.14);transition:border-color .25s,box-shadow .25s;}
.rkl-joincol{flex:3 1 0;}
.rkl-newcol{flex:2 1 0;}
.rkl-col.rkl-hot{border-color:rgba(255,207,90,.85);box-shadow:0 0 0 3px rgba(255,207,90,.15),0 0 24px rgba(255,207,90,.2);}
.rkl-ctitle{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:900;letter-spacing:.12em;color:#fff6d8;text-transform:uppercase;white-space:nowrap;}
.rkl-live{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;letter-spacing:.06em;color:#b6ffb0;}
.rkl-dot{width:9px;height:9px;border-radius:50%;background:#4fe36a;box-shadow:0 0 8px #4fe36a;animation:rkl-pulse 1.6s ease-in-out infinite;}
.rkl-live.rkl-zero{color:#fff;opacity:.5;}
.rkl-live.rkl-zero .rkl-dot{background:#aaa;box-shadow:none;animation:none;}
@keyframes rkl-pulse{50%{opacity:.35;}}
.rkl-list{display:flex;flex-direction:column;gap:6px;overflow:auto;padding:3px;margin:-3px;min-height:120px;max-height:min(300px,calc(100vh - 330px));}
.rkl-lob{flex:none;display:flex;align-items:center;gap:10px;padding:5px 6px 5px 12px;border-radius:14px;background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.12);}
.rkl-lob.rkl-new{animation:rkl-in .4s ease-out;}
@keyframes rkl-in{from{opacity:0;transform:translateY(6px);}}
.rkl-lt{flex:1;min-width:0;}
.rkl-lh,.rkl-ls{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rkl-lh{font-weight:900;font-size:16px;}
.rkl-ls{font-weight:700;font-size:12px;opacity:.65;}
.rkl-lob.rkl-run .rkl-ls{color:#bfe8ff;opacity:.85;}
.rkl-lob.rkl-full{opacity:.6;}
.rkr-btn.rkl-mini{flex:none;justify-content:center;min-width:80px;min-height:40px;font-size:14px;padding:6px 14px 7px;border-radius:14px;border-width:3px;
  box-shadow:0 4px 0 #3a1650,0 6px 12px rgba(0,0,0,.3);white-space:nowrap;}
.rkr-btn.rkl-mini:hover,.rkr-btn.rkl-mini.rkr-sel{transform:translateY(-2px);box-shadow:0 6px 0 #3a1650,0 8px 14px rgba(0,0,0,.35),0 0 0 3px rgba(255,255,255,.35);}
.rkr-btn.rkl-mini:active{transform:translateY(3px);box-shadow:0 1px 0 #3a1650;}
.rkr-btn.rkl-mini:disabled{cursor:default;filter:grayscale(1);opacity:.7;transform:none;box-shadow:0 4px 0 #3a1650;}
.rkl-empty{margin:auto 0;padding:14px 8px;text-align:center;font-weight:700;line-height:1.4;opacity:.8;}
.rkl-empty b{color:#ffcf5a;white-space:nowrap;}
.rkl-coderow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto;}
.rkl-codelab{font-size:13px;font-weight:800;opacity:.75;}
.rkl-in.rkl-code{width:96px;height:40px;box-sizing:border-box;padding:6px 8px;font-size:17px;text-align:center;text-transform:uppercase;letter-spacing:.2em;}
.rkl-modes{display:flex;flex-direction:column;gap:6px;}
.rkl-mode{display:flex;align-items:center;gap:10px;min-height:40px;padding:5px 12px;border-radius:12px;cursor:pointer;text-align:left;
  font:inherit;font-weight:900;font-size:15px;color:#fff;background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.16);}
.rkl-mode::before{content:'';flex:none;width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,.6);}
.rkl-mode:hover{background:rgba(255,255,255,.16);}
.rkl-mode.rkl-on{background:rgba(255,207,90,.2);border-color:#ffcf5a;color:#fff6d8;}
.rkl-mode.rkl-on::before{background:#ffcf5a;border-color:#fff6d8;}
.rkl-mode:focus:not(:focus-visible){outline:none;}
.rkl-modetip{font-size:12px;font-weight:700;opacity:.7;line-height:1.3;min-height:31px;}
.rkr-btn.rkl-create{margin-top:auto;font-size:19px;padding:9px 18px 11px;border-radius:18px;}
.rkl-bbox .rkl-err{min-height:0;font-size:13px;}
.rkl-bbox .rkl-err:empty{display:none;}
@media (max-width:560px){
  .rkl-cols{flex-direction:column;}
  .rkl-list{max-height:none;min-height:0;}
  .rkl-hsub{display:none;}
}
@media (max-height:500px){
  .rkr-glass.rkl-bbox{gap:7px;padding:6px 14px 6px;}
  .rkl-bbox h2{font-size:24px!important;}
  .rkl-back{width:40px;height:40px;font-size:20px;}
  .rkl-you{padding:0 8px;border:0;box-shadow:inset 0 0 0 2px rgba(255,255,255,.14);}
  .rkl-youcat{width:26px;height:26px;}
  .rkl-cols{gap:8px;}
  .rkl-col{padding:5px 10px 6px;gap:5px;}
  .rkr-overlay.rkl-ov{padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom));}
  .rkl-in.rkl-name{width:120px;}
  .rkl-you .rkcr-b{width:30px;}
  .rkl-list{min-height:80px;max-height:calc(100vh - 222px);}
  .rkl-joincol:has(.rkl-err:not(:empty)) .rkl-list{max-height:calc(100vh - 242px);}
  .rkl-modes{gap:4px;}
  .rkl-modetip{min-height:0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .rkr-btn.rkl-create{font-size:16px;padding:5px 14px 6px;min-height:40px;justify-content:center;}
}
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
  let roomRefs = null;
  let br = null; // lobby browser refs
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

  function mount(inner, boxCls = '', ovCls = '') {
    clearInterval(refreshT);
    if (node) node.remove();
    node = el('div', 'rkr-overlay rkr-dim' + ovCls);
    const box = el('div', 'rkr-glass rkl-box' + boxCls);
    box.append(...inner);
    node.appendChild(box);
    // keep game keys (WASD, M, P) from firing while typing (Esc still bubbles: it means "back")
    node.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' && e.key !== 'Escape') e.stopPropagation(); });
    root.appendChild(node);
  }

  // Esc on the lobby browser = back to the title (unless a dialog is on top of it)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || view !== 'browser' || !node || e.defaultPrevented) return;
    if (document.querySelector('.rkt-modal')) return;
    if (node.nextElementSibling && node.nextElementSibling.classList.contains('rkr-overlay')) return;
    e.preventDefault();
    cb.onBack();
  });

  function showBrowser() {
    view = 'browser';
    roomRefs = null;
    // header: back + title
    const back = el('button', 'rkl-back', '←');
    back.type = 'button';
    back.title = 'Back (Esc)';
    back.setAttribute('aria-label', 'Back');
    back.addEventListener('click', () => cb.onBack());
    const h = el('h2', null, 'ONLINE');
    const hsub = el('div', 'rkl-hsub', 'Up to 32 kitties per lobby');
    const head = el('div', 'rkl-head');
    head.append(back, h, hsub);

    // you: name (always visible), random name, colour swatches
    const youCat = el('span', 'rkl-youcat', CAT);
    const youLab = el('label', 'rkl-youlab');
    youLab.append(youCat, document.createTextNode('Your name'));
    const name = el('input', 'rkl-in rkl-name');
    name.id = 'rkl-name';
    youLab.htmlFor = name.id;
    name.maxLength = 14;
    name.placeholder = PLAYER_NAMES[Math.floor(Math.random() * PLAYER_NAMES.length)];
    name.value = savedName();
    name.autocomplete = 'off';
    name.spellcheck = false;
    name.addEventListener('input', () => saveName(name.value.trim()));
    const dice = el('button', 'rkl-dice', '🎲');
    dice.type = 'button';
    dice.title = 'Random name';
    dice.setAttribute('aria-label', 'Random name');
    dice.addEventListener('click', () => {
      const cur = name.value.trim();
      const pool = PLAYER_NAMES.filter((n) => n !== cur);
      name.value = pool[Math.floor(Math.random() * pool.length)];
      saveName(name.value);
    });
    const nameBox = el('div', 'rkl-namebox');
    nameBox.append(name, dice);
    const paintCat = () => {
      const p = prefColor();
      youCat.classList.toggle('rkl-any', p < 0);
      youCat.style.color = p < 0 ? '' : hex(PLAYER_COLORS[p]);
    };
    paintCat();
    const colors = createColorRow(paintCat); // preferred colour, sent with create / join (main.js)
    const you = el('div', 'rkl-you');
    you.append(youLab, nameBox, colors);
    const getName = () => { const n = name.value.trim(); saveName(n); return n; };

    // left: join a game
    const live = el('span', 'rkl-live rkl-zero', '<span class="rkl-dot"></span><span></span>');
    const jt = el('div', 'rkl-ctitle', '<span>Join a game</span>');
    jt.appendChild(live);
    const list = el('div', 'rkl-list', '<div class="rkl-empty">Looking for lobbies…</div>');
    const code = el('input', 'rkl-in rkl-code');
    code.id = 'rkl-code';
    code.maxLength = 4;
    code.placeholder = 'CODE';
    code.autocomplete = 'off';
    code.spellcheck = false;
    code.autocapitalize = 'characters';
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    const codeLab = el('label', 'rkl-codelab', 'Got a code?');
    codeLab.htmlFor = code.id;
    const codeJoin = el('button', 'rkr-btn rkr-alt rkl-mini', 'JOIN');
    const doJoin = () => { if (code.value.trim()) { lastAct = 'join'; cb.onJoin(code.value.trim().toUpperCase(), getName()); } };
    codeJoin.addEventListener('click', doJoin);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });
    const codeRow = el('div', 'rkl-coderow');
    codeRow.append(codeLab, code, codeJoin);
    const joinErr = el('div', 'rkl-err');
    const joinCol = el('div', 'rkl-col rkl-joincol');
    joinCol.append(jt, list, codeRow, joinErr);

    // right: start your own (mode remembered)
    let mode = savedMode();
    const modes = el('div', 'rkl-modes');
    modes.setAttribute('role', 'radiogroup');
    const tip = el('div', 'rkl-modetip');
    const paint = () => {
      for (const b of modes.children) {
        const on = b.dataset.mode === mode;
        b.classList.toggle('rkl-on', on);
        b.setAttribute('aria-checked', String(on));
      }
      tip.textContent = tip.title = MODES.find((m) => m.id === mode).tip;
    };
    for (const m of MODES) {
      const b = el('button', 'rkl-mode');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.textContent = m.label;
      b.dataset.mode = m.id;
      b.addEventListener('click', () => { mode = m.id; saveMode(mode); paint(); });
      modes.appendChild(b);
    }
    paint();
    const create = el('button', 'rkr-btn rkl-create', '<span>CREATE LOBBY</span>');
    create.addEventListener('click', () => { lastAct = 'create'; cb.onCreate(getName(), mode); });
    const createErr = el('div', 'rkl-err');
    const newCol = el('div', 'rkl-col rkl-newcol');
    newCol.append(el('div', 'rkl-ctitle', 'Start your own'), modes, tip, create, createErr);

    const cols = el('div', 'rkl-cols');
    cols.append(joinCol, newCol);
    let lastAct = 'join';
    errEl = null;
    mount([head, you, cols], ' rkl-bbox', ' rkl-ov');
    br = { list, live, joinCol, newCol, create, getName, rows: new Map(), errFor: () => (lastAct === 'create' ? [createErr, joinErr] : [joinErr, createErr]) };
    emphasize(0);
    cb.onRefresh();
    clearInterval(refreshT);
    refreshT = setInterval(() => cb.onRefresh(), 3000);
  }

  // one yellow primary at a time: the first joinable lobby's JOIN, or CREATE LOBBY when there's nothing to join
  function emphasize(joinable) {
    br.joinCol.classList.toggle('rkl-hot', joinable > 0);
    br.create.classList.toggle('rkr-alt', joinable > 0);
  }

  const lobbyRank = (l) => (l.players >= l.max ? 2 : l.phase === 'lobby' ? 0 : 1);

  // rows are kept per lobby code and updated in place, so refreshes don't flicker or drop hover / focus
  function setLobbies(list) {
    if (view !== 'browser' || !br) return;
    const sorted = [...list].sort((a, b) => lobbyRank(a) - lobbyRank(b) || b.players - a.players || (a.code < b.code ? -1 : 1));
    const seen = new Set();
    let joinable = 0;
    let first = true;
    for (const l of sorted) {
      seen.add(l.code);
      let r = br.rows.get(l.code);
      if (!r) {
        const row = el('div', 'rkl-lob rkl-new');
        const t = el('div', 'rkl-lt');
        const hh = el('div', 'rkl-lh');
        const sub = el('div', 'rkl-ls');
        t.append(hh, sub);
        const btn = el('button', 'rkr-btn rkl-mini');
        btn.type = 'button';
        const code = l.code;
        btn.addEventListener('click', () => { if (!btn.disabled) cb.onJoin(code, br.getName()); });
        row.append(t, btn);
        row.addEventListener('animationend', () => row.classList.remove('rkl-new'), { once: true });
        r = { row, hh, sub, btn };
        br.rows.set(l.code, r);
      }
      const full = l.players >= l.max;
      const playing = l.phase !== 'lobby';
      const set = (e, v) => { if (e.textContent !== v) e.textContent = v; };
      set(r.hh, `${l.host}'s lobby`);
      set(r.sub, playing ? `${modeLabel(l.mode)} · playing level ${l.level} · ${l.players}/${l.max}`
        : `${modeLabel(l.mode)} · waiting · ${l.players}/${l.max}`);
      set(r.btn, full ? 'FULL' : playing ? 'HOP IN' : 'JOIN');
      r.row.title = `Code ${l.code}`;
      r.btn.disabled = full;
      r.row.classList.toggle('rkl-run', playing);
      r.row.classList.toggle('rkl-full', full);
      if (!full) joinable++;
      r.btn.classList.toggle('rkr-alt', !(first && !full));
      first = false;
    }
    for (const [c, r] of br.rows) if (!seen.has(c)) { r.row.remove(); br.rows.delete(c); }
    // order: only move nodes that are out of place (moving a focused node would blur it)
    const L = br.list;
    if (sorted.length) {
      const empty = L.querySelector('.rkl-empty');
      if (empty) empty.remove();
      sorted.forEach((l, i) => {
        const row = br.rows.get(l.code).row;
        if (L.children[i] !== row) L.insertBefore(row, L.children[i] || null);
      });
    } else if (!L.querySelector('.rkl-empty') || L.firstChild.dataset.k !== 'none') {
      L.textContent = '';
      const e = el('div', 'rkl-empty', 'Nobody\'s playing right now.<br>Start a lobby and invite your friends <b>→</b>');
      e.dataset.k = 'none';
      L.appendChild(e);
    }
    br.live.classList.toggle('rkl-zero', !sorted.length);
    br.live.lastChild.textContent = `${sorted.length} live`;
    emphasize(joinable);
  }

  function showRoom(info) {
    if (view !== 'room') {
      view = 'room';
      br = null;
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
    // everyone in the lobby + one open slot (up to info.max)
    const max = info.max || 32;
    for (let i = 0; i < Math.min(max, info.members.length + 1); i++) {
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
      : isHost ? `You're the host. Start whenever you're ready (${info.members.length}/${max}).`
        : `Waiting for ${host ? host.name : 'the host'} to start…`;
  }

  function showError(msg) {
    let target = errEl;
    if (view === 'browser' && br) {
      const [near, other] = br.errFor(); // under the action that was tried last (join or create)
      other.textContent = '';
      target = near;
    }
    if (!target) return;
    target.textContent = msg;
    // short landscape phones: the panel scrolls, so make sure the message is actually on screen
    if (msg && target.scrollIntoView) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function hide() {
    clearInterval(refreshT);
    if (node) node.remove();
    node = null;
    view = null;
    errEl = null;
    br = null;
    roomRefs = null;
  }

  return { showBrowser, setLobbies, showRoom, showError, hide, isOpen: () => !!node, view: () => view };
}

export { createLobbyUI };
