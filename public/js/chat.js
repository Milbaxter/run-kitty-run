// Lobby/game chat box (bottom-left). Enter opens it, Enter sends, Esc closes.
// Tap a player's name to Mute them (and Report, in the store apps); "Hide chat" turns player messages off.
// All message text is inserted with textContent.

const CSS = `
.rkc{position:absolute;left:16px;bottom:16px;width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;gap:6px;
  pointer-events:none;z-index:20;font-weight:800;font-size:15px;}
.rkc-log{display:flex;flex-direction:column;gap:3px;max-height:40vh;overflow:hidden;justify-content:flex-end;}
.rkc-line{padding:4px 10px;border-radius:10px;background:rgba(10,4,30,.55);color:#fff;text-shadow:0 1px 0 rgba(0,0,0,.6);
  word-wrap:break-word;overflow-wrap:anywhere;transition:opacity .6s;align-self:flex-start;max-width:100%;}
.rkc-line b{margin-right:6px;}
.rkc-line.rkc-sys{color:#cdbfff;font-style:italic;font-weight:700;}
.rkc-line.rkc-old{opacity:0;}
.rkc.rkc-open .rkc-line.rkc-old{opacity:.85;}
.rkc-in{pointer-events:auto;font:inherit;font-weight:800;font-size:15px;padding:8px 12px;border-radius:12px;
  border:2px solid #ffcf5a;background:rgba(10,4,30,.8);color:#fff;outline:none;display:none;user-select:text;-webkit-user-select:text;}
.rkc.rkc-open .rkc-in{display:block;}
.rkc-hint{opacity:.55;font-size:12px;font-weight:700;padding-left:4px;}
.rkc.rkc-open .rkc-hint{display:none;}
.rkc-btn{pointer-events:auto;align-self:flex-start;width:42px;height:42px;border-radius:14px;background:rgba(20,10,40,.55);
  border:2px solid rgba(255,255,255,.18);font-size:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.rkc.rkc-open .rkc-btn{display:none;}
.rkc{left:max(16px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));}
.rkc-bar{display:flex;align-items:center;gap:8px;}
.rkc-tog{pointer-events:auto;cursor:pointer;font:inherit;font-weight:800;font-size:12px;color:#efe7ff;padding:6px 10px;min-height:32px;
  border-radius:10px;border:2px solid rgba(255,255,255,.18);background:rgba(20,10,40,.55);opacity:.75;}
.rkc-tog:hover{opacity:1;}
.rkc.rkc-off .rkc-line:not(.rkc-sys){display:none;}
.rkc-line b{cursor:pointer;pointer-events:auto;}
.rkc-line.rkc-old b{pointer-events:none;}
.rkc.rkc-open .rkc-line.rkc-old b{pointer-events:auto;}
.rkc-pop{position:absolute;bottom:100%;left:0;margin-bottom:8px;pointer-events:auto;z-index:30;min-width:200px;max-width:calc(100vw - 32px);
  display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:16px;background:linear-gradient(160deg,rgba(52,30,96,.98),rgba(26,12,52,.98));
  border:2px solid rgba(255,255,255,.22);box-shadow:0 10px 26px rgba(0,0,0,.45);}
.rkc-pop>*{flex-shrink:0;}
.rkc-pop .rkc-pn{font-weight:900;padding:0 4px 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rkc-pop .rkc-pl{font-size:12px;opacity:.7;padding:0 4px;}
.rkc-pop button{font:inherit;font-weight:800;font-size:15px;min-height:42px;padding:8px 12px;border-radius:12px;cursor:pointer;text-align:left;
  border:2px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;}
.rkc-pop button:hover{background:rgba(255,255,255,.18);}
.rkc-pop button.rkc-warn{border-color:#ff8fa3;color:#ffc2cd;}
.rkc-btns{display:flex;gap:8px;align-self:flex-start;}
.rkc.rkc-open .rkc-btns{display:none;}
.rkc-hist{position:absolute;left:0;bottom:0;width:100%;box-sizing:border-box;pointer-events:auto;z-index:25;display:flex;flex-direction:column;gap:6px;
  padding:8px;border-radius:16px;background:linear-gradient(160deg,rgba(52,30,96,.97),rgba(26,12,52,.97));border:2px solid rgba(255,215,110,.55);
  box-shadow:0 10px 26px rgba(0,0,0,.45);max-height:min(60vh,420px);}
.rkc-hist-head{display:flex;align-items:center;gap:6px;flex-shrink:0;}
.rkc-hist-head span{flex:1;color:#ffcf5a;font-weight:900;padding-left:4px;}
.rkc-hist-head button{font:inherit;font-weight:800;font-size:14px;min-height:36px;min-width:36px;padding:4px 10px;border-radius:10px;cursor:pointer;
  border:2px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;}
.rkc-hist-list{display:flex;flex-direction:column;gap:3px;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;
  touch-action:pan-y;min-height:0;flex:1;}
.rkc-hist-list .rkc-line,.rkc-hist-list .rkc-line.rkc-old{opacity:1;transition:none;flex-shrink:0;}
.rkc-hist-list .rkc-line.rkc-old b{pointer-events:auto;}
.rkc-hist-empty{opacity:.6;font-size:13px;font-weight:700;padding:6px 4px;}
@media (max-height:500px){ .rkc{width:min(300px,calc(100vw - 160px));font-size:13px;} .rkc-log{max-height:30vh;}
  .rkc-pop{gap:4px;padding:8px;} .rkc-pop button{min-height:34px;padding:5px 12px;font-size:14px;}
  .rkc-hist{padding:6px;gap:4px;} .rkc-hist-head button{min-height:32px;font-size:13px;} }
`;

const SHOW_MS = 10000;
const MAX_LINES = 40;
const BLOCK_KEY = 'rkr-blocked';
const HIDE_KEY = 'rkr-chat-off';
const REASONS = [['spam', 'Spam'], ['abuse', 'Abusive'], ['name', 'Offensive name'], ['other', 'Other']];

function load(key, def) { try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

function hex(c) { return '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0'); }

// onReport(id, reason) is optional; without it the Report option is hidden.
function createChat(root, { onSend, onOpen, onReport, onClose, touch = false }) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  const box = document.createElement('div');
  box.className = 'rkc';
  box.style.display = 'none';
  const log = document.createElement('div');
  log.className = 'rkc-log';
  const input = document.createElement('input');
  input.className = 'rkc-in';
  input.maxLength = 120;
  input.placeholder = touch ? 'Say something…' : 'Say something… (Enter to send, Esc to close)';
  const hint = document.createElement('div');
  hint.className = 'rkc-hint';
  hint.textContent = touch ? '' : 'Press Enter to chat';
  const tog = document.createElement('button');
  tog.className = 'rkc-tog';
  const bar = document.createElement('div');
  bar.className = 'rkc-bar';
  // muted players stay listed here, so they can be unmuted after their messages are gone
  const mutedBtn = document.createElement('button');
  mutedBtn.className = 'rkc-tog';
  mutedBtn.title = 'Players you muted';
  bar.append(tog, mutedBtn, hint);
  box.append(log, input, bar);

  // moderation state: blocked names persist, blocked ids are for this session
  const blockedNames = new Set(load(BLOCK_KEY, []).filter((n) => typeof n === 'string'));
  const blockedIds = new Set();
  const idNames = new Map(); // muted id -> name at the time, so unmuting by name from the list clears it too
  let off = !!load(HIDE_KEY, false);
  function applyOff() {
    box.classList.toggle('rkc-off', off);
    tog.textContent = off ? '💬 Show chat' : '🙈 Hide chat';
    tog.title = off ? 'Show player messages' : 'Hide player messages';
  }
  applyOff();
  tog.addEventListener('click', (e) => { e.stopPropagation(); off = !off; save(HIDE_KEY, off); closePop(); applyOff(); });
  const isBlocked = (m) => blockedIds.has(m.id) || blockedNames.has(m.name);
  function setBlocked(m, on) {
    if (on) { blockedIds.add(m.id); blockedNames.add(m.name); idNames.set(m.id, m.name); } else {
      blockedNames.delete(m.name);
      for (const [id, n] of idNames) if (id === m.id || n === m.name) { blockedIds.delete(id); idNames.delete(id); }
    }
    save(BLOCK_KEY, [...blockedNames].slice(-200));
    applyMuted();
    for (const line of log.children) if (line._msg && (line._msg.id === m.id || line._msg.name === m.name)) line.style.display = on ? 'none' : '';
    fillHist();
  }

  function applyMuted() {
    mutedBtn.style.display = blockedNames.size ? '' : 'none';
    mutedBtn.textContent = `🔇 Muted (${blockedNames.size})`;
  }
  applyMuted();

  let pop = null;
  function closePop() { if (pop) pop.remove(); pop = null; }
  function newPop() {
    closePop();
    pop = document.createElement('div');
    pop.className = 'rkc-pop';
    return (text, fn, cls) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (cls) b.className = cls;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      pop.appendChild(b);
      return b;
    };
  }
  function openMuted() {
    const btn = newPop();
    const l = document.createElement('div');
    l.className = 'rkc-pl';
    l.textContent = 'Muted players';
    pop.appendChild(l);
    for (const name of blockedNames) btn(`Unmute ${name}`, () => { setBlocked({ name, id: -1 }, false); if (blockedNames.size) openMuted(); else closePop(); });
    btn('Close', closePop);
    box.appendChild(pop);
    fitPop();
  }
  mutedBtn.addEventListener('click', (e) => { e.stopPropagation(); openMuted(); });
  function openPop(m) {
    const btn = newPop();
    const head = document.createElement('div');
    head.className = 'rkc-pn';
    head.textContent = m.name;
    head.style.color = hex(m.color);
    pop.appendChild(head);
    const blocked = isBlocked(m);
    btn(blocked ? 'Unmute' : 'Mute (hide their messages)', () => { setBlocked(m, !blocked); closePop(); });
    if (onReport) {
      btn('Report…', () => {
        pop.replaceChildren(head);
        const l = document.createElement('div');
        l.className = 'rkc-pl';
        l.textContent = 'Why are you reporting them?';
        pop.appendChild(l);
        for (const [id, label] of REASONS) btn(label, () => { onReport(m.id, id); closePop(); }, 'rkc-warn');
        btn('Cancel', closePop);
        fitPop();
      }, 'rkc-warn');
    }
    btn('Cancel', closePop);
    box.appendChild(pop);
    fitPop();
  }
  // short landscape phones: never let the menu run off the top of the screen
  function fitPop() {
    if (!pop) return;
    pop.style.maxHeight = '';
    const r = pop.getBoundingClientRect();
    if (r.top < 8) { pop.style.maxHeight = Math.max(120, r.bottom - 8) + 'px'; pop.style.overflowY = 'auto'; }
  }
  document.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target)) closePop(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePop(); closeHist(); } });
  // Touch only: a scrollable history panel (older lines fade out and the keyboard covers the log on phones).
  let hist = null, histList = null, histBtn = null;
  function histLine(line) {
    const c = line.cloneNode(true);
    const m = line._msg;
    if (m) {
      c._msg = m;
      const b = c.querySelector('b');
      if (b) b.addEventListener('click', (e) => { e.stopPropagation(); closeHist(); openPop(m); });
    }
    return c;
  }
  function fillHist() {
    if (!histList) return;
    histList.replaceChildren(...[...log.children].map(histLine));
    const empty = document.createElement('div');
    empty.className = 'rkc-hist-empty';
    empty.textContent = 'No messages yet';
    if (!histList.children.length) histList.appendChild(empty);
  }
  // keep the panel inside the visible area (landscape phones, on-screen keyboard)
  function fitHist() {
    if (!hist) return;
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const h = vv ? vv.height : window.innerHeight;
    const bottom = Math.min(box.getBoundingClientRect().bottom, top + h);
    hist.style.maxHeight = Math.max(120, Math.min(bottom - top - 8, h * 0.6, 420)) + 'px';
  }
  function closeHist() { if (hist) hist.remove(); hist = histList = null; }
  function openHist() {
    if (!enabled) return;
    closePop();
    closeHist();
    hist = document.createElement('div');
    hist.className = 'rkc-hist';
    const head = document.createElement('div');
    head.className = 'rkc-hist-head';
    const title = document.createElement('span');
    title.textContent = 'Chat history';
    const write = document.createElement('button');
    write.textContent = '💬';
    write.title = 'Write a message';
    write.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); closeHist(); open(); });
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Close';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeHist(); });
    head.append(title, write, x);
    histList = document.createElement('div');
    histList.className = 'rkc-hist-list';
    hist.append(head, histList);
    box.appendChild(hist);
    fillHist();
    fitHist();
    histList.scrollTop = histList.scrollHeight;
  }
  document.addEventListener('pointerdown', (e) => {
    if (hist && !hist.contains(e.target) && !(histBtn && histBtn.contains(e.target))) closeHist();
  }, true);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitHist);
    window.visualViewport.addEventListener('scroll', fitHist);
  }
  window.addEventListener('resize', fitHist);
  if (touch) {
    const btns = document.createElement('div');
    btns.className = 'rkc-btns';
    const btn = document.createElement('div');
    btn.className = 'rkc-btn';
    btn.textContent = '💬';
    btn.title = 'Chat';
    // pointerdown + preventDefault keeps focus handling simple on mobile keyboards
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); closeHist(); open(); });
    histBtn = document.createElement('div');
    histBtn.className = 'rkc-btn';
    histBtn.textContent = '📜';
    histBtn.title = 'Older messages';
    histBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); if (hist) closeHist(); else openHist(); });
    btns.append(btn, histBtn);
    box.appendChild(btns);
  }
  root.appendChild(box);

  let enabled = false;

  function isOpen() { return box.classList.contains('rkc-open'); }
  function open() {
    if (!enabled || isOpen()) return;
    box.classList.add('rkc-open');
    input.value = '';
    input.focus();
    if (onOpen) onOpen();
  }
  function close() {
    box.classList.remove('rkc-open');
    input.blur();
  }

  // Keys typed into the chat never reach the game's key handlers.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      if (text) onSend(text);
      close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('blur', () => { box.classList.remove('rkc-open'); if (onClose) onClose(); });

  // Returns whether the message is shown (false when blocked / chat hidden) so callers can skip speech bubbles too.
  function add(msg) {
    if (!msg.sys && (off || isBlocked(msg))) return false;
    const line = document.createElement('div');
    line.className = 'rkc-line' + (msg.sys ? ' rkc-sys' : '');
    if (msg.sys) {
      line.textContent = msg.text;
    } else {
      const name = document.createElement('b');
      name.textContent = msg.name + ':';
      name.style.color = hex(msg.color);
      name.addEventListener('click', (e) => { e.stopPropagation(); openPop(msg); });
      line._msg = msg;
      line.append(name, document.createTextNode(msg.text));
    }
    log.appendChild(line);
    while (log.children.length > MAX_LINES) log.firstChild.remove();
    if (histList) {
      const atEnd = histList.scrollHeight - histList.scrollTop - histList.clientHeight < 24;
      fillHist();
      if (atEnd) histList.scrollTop = histList.scrollHeight;
    }
    setTimeout(() => line.classList.add('rkc-old'), SHOW_MS);
    return true;
  }

  function setEnabled(on) {
    enabled = on;
    box.style.display = on ? '' : 'none';
    if (!on) { close(); closePop(); closeHist(); }
  }

  function clear() { log.textContent = ''; fillHist(); }

  return { open, close, isOpen, add, setEnabled, clear, isHidden: (m) => !m.sys && (off || isBlocked(m)) };
}

export { createChat };
