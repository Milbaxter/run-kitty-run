// Settings (remembered per browser): music and sound-effect volume, which songs play (main.js owns that choice),
// graphics quality (device.js reads it at load, main.js switches it live) and the keyboard controls. The window is
// opened from the main menu's SETTINGS button and the Esc menu (ui.js); main.js passes in what only it knows (the
// songs, applying the volumes and the graphics).
import { TOUCH } from './device.js';

const KEY = 'rkr-settings';
const DEFAULT_KEYS = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', pause: 'KeyP', sound: 'KeyM', hud: 'KeyH', zoomIn: 'Equal', zoomOut: 'Minus' };
const ACTIONS = [
  ['up', 'Move up'], ['down', 'Move down'], ['left', 'Move left'], ['right', 'Move right'],
  ['pause', 'Pause / menu'], ['sound', 'Sound on / off'], ['hud', 'Show / hide the HUD'], ['zoomIn', 'Zoom in'], ['zoomOut', 'Zoom out'],
];
// keys that keep their fixed job (arrows move, Esc pauses and cancels, Enter chats and confirms, Tab switches the watched kitty)
const RESERVED = new Set(['Escape', 'Enter', 'NumpadEnter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'MetaLeft', 'MetaRight']);
const GFX = [['auto', 'AUTO'], ['high', 'HIGH'], ['medium', 'MEDIUM'], ['low', 'LOW'], ['ultra', 'ULTRA LOW']];
// the frame rate limit (main.js frame()): 0 = none (the screen's own refresh)
const FPS = [[0, 'MAX'], [240, '240'], [144, '144'], [120, '120'], [60, '60'], [30, '30']];

const S = { music: 1, sfx: 1, gfx: 'auto', fps: 0, keys: { ...DEFAULT_KEYS } };
try {
  const v = JSON.parse(localStorage.getItem(KEY) || '{}');
  const pct = (x, d) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d);
  S.music = pct(v.music, 1); S.sfx = pct(v.sfx, 1);
  if (GFX.some(([id]) => id === v.gfx)) S.gfx = v.gfx;
  if (FPS.some(([n]) => n === v.fps)) S.fps = v.fps;
  for (const [a] of ACTIONS) if (typeof (v.keys || {})[a] === 'string' && !RESERVED.has(v.keys[a])) S.keys[a] = v.keys[a];
} catch { /* defaults */ }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* ignore */ } }

const key = (action) => S.keys[action];
// a key's name on a keycap: KeyW -> W, Digit1 -> 1, Equal -> =
const NAMES = { Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\',
  Comma: ',', Period: '.', Slash: '/', Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'R-Shift', ControlLeft: 'Ctrl', ControlRight: 'R-Ctrl',
  AltLeft: 'Alt', AltRight: 'AltGr', CapsLock: 'Caps', Backspace: 'Bksp', Delete: 'Del', Insert: 'Ins', PageUp: 'PgUp', PageDown: 'PgDn',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .' };
function keyName(code) {
  if (!code) return '?';
  if (NAMES[code]) return NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'Num ' + code.slice(6);
  return code;
}

const CSS = `
.rkr-glass.rkst-box{width:min(880px,100%);max-width:880px;max-height:calc(100% - 8px);overflow:hidden auto;text-align:left;gap:14px;background:rgba(22,10,50,.94);}
.rkst-cols{display:grid;grid-template-columns:1fr 1fr;gap:18px 32px;align-self:stretch;align-items:start;}
.rkst-col{display:flex;flex-direction:column;gap:18px;}
@media (max-width:720px){ .rkst-cols{grid-template-columns:1fr;} }
.rkr-glass.rkst-box h2{margin:0;text-align:center;font-size:clamp(30px,4vw,42px);}
.rkst-sec{display:flex;flex-direction:column;gap:10px;align-self:stretch;}
.rkst-sec h3{margin:0;font-size:13px;font-weight:900;letter-spacing:.1em;color:#ffcf5a;}
.rkst-row{display:flex;align-items:center;gap:12px;font-weight:800;font-size:15px;}
.rkst-row > span:first-child{flex:0 0 120px;}
.rkst-stack{display:flex;flex-direction:column;gap:8px;font-weight:800;font-size:15px;}
.rkst-row input[type=range]{flex:1;accent-color:#ffcf5a;min-width:0;cursor:pointer;}
.rkst-row output{flex:0 0 44px;text-align:right;font-variant-numeric:tabular-nums;}
.rkst-seg{display:flex;flex-wrap:wrap;gap:6px;}
.rkst-seg button,.rkst-kbtn,.rkst-small{font:inherit;font-weight:900;font-size:13px;letter-spacing:.04em;cursor:pointer;color:#fff6d8;
  padding:6px 12px;border-radius:999px;border:2px solid rgba(255,255,255,.25);background:rgba(20,8,48,.55);}
.rkst-seg button:hover,.rkst-kbtn:hover,.rkst-small:hover{background:rgba(60,30,110,.75);}
.rkst-hint{font-size:13px;opacity:.7;}
.rkst-seg button.rkst-on{border-color:#ffcf5a;background:rgba(255,207,90,.22);}
.rkst-note{font-size:13px;font-weight:700;color:rgba(239,231,255,.7);}
.rkst-keys{display:grid;grid-template-columns:1fr auto;gap:6px 12px;align-items:center;font-weight:800;font-size:15px;}
.rkst-kbtn{min-width:86px;border-radius:10px;}
.rkst-kbtn.rkst-wait{border-color:#ffcf5a;animation:rkst-pulse 1s ease-in-out infinite;}
@keyframes rkst-pulse{50%{background:rgba(255,207,90,.25);}}
.rkst-foot{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;}
.rkst-sec > .rkst-small{align-self:flex-start;}
.rkst-small[hidden]{display:none;}
`;

let styled = false;
let modal = null;
let capture = null;   // { action, button }: waiting for a key
const isOpen = () => !!modal;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// opts (main.js): music: { songs: [[i, label]], on(i), toggle(i), speed: null | { choices: [[x, label]], get(), set(x) } },
//   invites: { choices: [[id, label]], get(), set(id), blocked() -> count, clearBlocked() }, onVolume(), onGraphics(id) -> true if smooth edges wait for a reload, onKeys(), onClose()
function openSettings(root, opts = {}) {
  if (!styled) { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); styled = true; }
  closeSettings();
  modal = el('div', 'rkr-overlay rkr-dim');
  const box = el('div', 'rkr-glass rkst-box');
  box.appendChild(el('h2', null, 'SETTINGS'));

  // ---- sound
  const sound = el('div', 'rkst-sec');
  sound.appendChild(el('h3', null, 'SOUND'));
  const slider = (label, prop) => {
    const row = el('label', 'rkst-row');
    const input = el('input'); input.type = 'range'; input.min = '0'; input.max = '100'; input.step = '5';
    input.value = String(Math.round(S[prop] * 100));
    const out = el('output', null, input.value + '%');
    input.addEventListener('input', () => {
      S[prop] = +input.value / 100; out.textContent = input.value + '%'; save();
      if (opts.onVolume) opts.onVolume();
    });
    row.append(el('span', null, label), input, out);
    return row;
  };
  sound.append(slider('Music volume', 'music'), slider('Sound effects', 'sfx'));
  if (opts.music) {
    const seg = el('div', 'rkst-seg');
    // each song on or off: the ones on play one after the other on repeat (one: on a loop), none: no music
    const hint = el('span', 'rkst-hint');
    const paint = () => {
      let n = 0;
      for (const b of seg.children) { const on = opts.music.on(+b.dataset.id); b.classList.toggle('rkst-on', on); n += on; }
      hint.textContent = n ? (n === 1 ? 'Plays on a loop' : 'Played one after the other') : 'No music';
    };
    for (const [i, label] of opts.music.songs) {
      const b = el('button', null, label); b.dataset.id = String(i); b.type = 'button';
      b.addEventListener('click', () => { opts.music.toggle(i); paint(); });
      seg.appendChild(b);
    }
    paint();
    const stack = el('div', 'rkst-stack');
    stack.append(el('span', null, 'Songs (click to switch on / off)'), seg, hint);
    sound.appendChild(stack);
    const sp = opts.music.speed;
    if (sp) {
      const sseg = el('div', 'rkst-seg');
      const spaint = () => { for (const b of sseg.children) b.classList.toggle('rkst-on', +b.dataset.x === sp.get()); };
      for (const [x, label] of sp.choices) {
        const b = el('button', null, label); b.dataset.x = String(x); b.type = 'button';
        b.addEventListener('click', () => { sp.set(x); spaint(); });
        sseg.appendChild(b);
      }
      spaint();
      const sstack = el('div', 'rkst-stack');
      sstack.append(el('span', null, 'We Skate speed'), sseg);
      sound.appendChild(sstack);
    }
  }
  const cols = el('div', 'rkst-cols');
  const left = el('div', 'rkst-col');
  cols.appendChild(left);
  box.appendChild(cols);
  left.appendChild(sound);

  // ---- graphics
  const gfx = el('div', 'rkst-sec');
  gfx.appendChild(el('h3', null, 'GRAPHICS'));
  const gseg = el('div', 'rkst-seg');
  const note = el('div', 'rkst-note');
  // switched on the spot (main.js applyGraphics), mid-run too; only the edge smoothing waits for the next load
  const paintGfx = (edgesLater) => {
    for (const b of gseg.children) b.classList.toggle('rkst-on', b.dataset.id === S.gfx);
    note.textContent = 'Auto picks for your device. Lower settings run smoother on slower computers: Low turns shadows off, Ultra low also the weather and draws the game at a lower resolution.'
      + (edgesLater ? ' Smooth edges change the next time the game opens.' : '');
  };
  for (const [id, label] of GFX) {
    const b = el('button', null, label); b.dataset.id = id; b.type = 'button';
    b.addEventListener('click', () => { S.gfx = id; save(); paintGfx(opts.onGraphics ? opts.onGraphics(id) : false); });
    gseg.appendChild(b);
  }
  paintGfx(false);
  // the frame rate limit: switched on the spot
  const fseg = el('div', 'rkst-seg');
  const paintFps = () => { for (const b of fseg.children) b.classList.toggle('rkst-on', +b.dataset.n === S.fps); };
  for (const [n, label] of FPS) {
    const b = el('button', null, label); b.dataset.n = String(n); b.type = 'button';
    b.addEventListener('click', () => { S.fps = n; save(); paintFps(); });
    fseg.appendChild(b);
  }
  paintFps();
  const fstack = el('div', 'rkst-stack');
  fstack.append(el('span', null, 'Frame rate limit'), fseg,
    el('div', 'rkst-note', 'MAX draws every refresh of your screen. A limit saves graphics work and heat; the game plays the same.'));
  gfx.append(gseg, note, fstack);
  left.appendChild(gfx);

  // ---- invites (Multiplayer): who may invite you, and unblocking the players you blocked
  if (opts.invites) {
    const iv = opts.invites;
    const inv = el('div', 'rkst-sec');
    inv.appendChild(el('h3', null, 'INVITES'));
    const iseg = el('div', 'rkst-seg');
    const inote = el('div', 'rkst-note');
    const clear = el('button', 'rkst-small', 'UNBLOCK ALL'); clear.type = 'button';
    const NOTES = { on: 'Players you played Multiplayer with can invite you to their lobby.', friends: 'Only your ★ friends can invite you.', off: 'Nobody can invite you.' };
    const paintInv = () => {
      for (const b of iseg.children) b.classList.toggle('rkst-on', b.dataset.id === iv.get());
      const n = iv.blocked();
      inote.textContent = NOTES[iv.get()] + (n ? ` You blocked invites from ${n} player${n === 1 ? '' : 's'}.` : '');
      clear.hidden = !n;
    };
    for (const [id, label] of iv.choices) {
      const b = el('button', null, label); b.dataset.id = id; b.type = 'button';
      b.addEventListener('click', () => { iv.set(id); paintInv(); });
      iseg.appendChild(b);
    }
    clear.addEventListener('click', () => { iv.clearBlocked(); paintInv(); });
    paintInv();
    inv.append(iseg, inote, clear);
    left.appendChild(inv);
  }

  // ---- controls (keyboards only)
  if (!TOUCH) {
    const ctl = el('div', 'rkst-sec');
    ctl.appendChild(el('h3', null, 'CONTROLS'));
    const grid = el('div', 'rkst-keys');
    const btns = {};
    const paintKeys = () => { for (const [a] of ACTIONS) btns[a].textContent = keyName(S.keys[a]); };
    for (const [a, label] of ACTIONS) {
      const b = el('button', 'rkst-kbtn'); b.type = 'button';
      b.addEventListener('click', () => {
        if (capture) capture.button.classList.remove('rkst-wait');
        capture = { action: a, button: b, paint: paintKeys };
        b.classList.add('rkst-wait'); b.textContent = 'press a key';
      });
      btns[a] = b;
      grid.append(el('span', null, label), b);
    }
    paintKeys();
    const reset = el('button', 'rkst-small', 'RESET KEYS');
    reset.type = 'button';
    reset.addEventListener('click', () => { S.keys = { ...DEFAULT_KEYS }; save(); cancelCapture(); paintKeys(); if (opts.onKeys) opts.onKeys(); });
    ctl.append(grid, el('div', 'rkst-note', 'The arrow keys always move too, Esc always pauses and Enter opens the chat online.'), reset);
    cols.appendChild(ctl);
  }

  const foot = el('div', 'rkst-foot');
  const done = el('button', 'rkr-btn', 'DONE');
  done.type = 'button';
  done.addEventListener('click', () => closeSettings());
  foot.appendChild(done);
  box.appendChild(foot);

  modal.appendChild(box);
  modal.addEventListener('pointerdown', (e) => { if (e.target === modal) closeSettings(); });
  modal._opts = opts;
  root.appendChild(modal);
}

function cancelCapture() {
  if (!capture) return;
  capture.button.classList.remove('rkst-wait');
  const p = capture.paint;
  capture = null;
  p();
}

function closeSettings() {
  if (!modal) return;
  cancelCapture();
  const opts = modal._opts || {};
  modal.remove();
  modal = null;
  if (opts.onClose) opts.onClose();
}

// While the window is open it gets the keys first (capture phase): binding a key, Esc to cancel or close. Nothing
// reaches the game, so a kitty can't walk off while you pick a key.
window.addEventListener('keydown', (e) => {
  if (!modal) return;
  if (capture) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.code === 'Escape' || !e.code) { cancelCapture(); return; }
    if (RESERVED.has(e.code)) return;   // keep waiting
    const { action, paint } = capture;
    const other = Object.keys(S.keys).find((a) => a !== action && S.keys[a] === e.code);
    if (other) S.keys[other] = S.keys[action];   // that key was taken: the two swap
    S.keys[action] = e.code;
    save();
    capture.button.classList.remove('rkst-wait');
    capture = null;
    paint();
    if (modal._opts && modal._opts.onKeys) modal._opts.onKeys();
    return;
  }
  e.stopImmediatePropagation();
  if (e.code === 'Escape') { e.preventDefault(); closeSettings(); }
}, true);   // (key releases still reach the game: nothing stays held)

const musicVolume = () => S.music;
const sfxVolume = () => S.sfx;

const fpsLimit = () => S.fps;
export { openSettings, closeSettings, isOpen as settingsOpen, key, keyName, musicVolume, sfxVolume, fpsLimit, KEY as SETTINGS_KEY };
