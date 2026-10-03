// Preferred kitty colour (an index into PLAYER_COLORS, or -1 for no preference), remembered in localStorage.
// Online it goes with 'create' / 'join' (the server gives it unless someone in the lobby already has it);
// offline player 1 uses it. createColorPicker is a small cat button that opens a row of swatches (title screen);
// createColorRow shows the swatches inline (online lobby browser).
import { PLAYER_COLORS } from './shared/config.js';

const KEY = 'rkr-color';
const KEY2 = 'rkr-color2';   // local co-op: player 2's own preference
const CAT = `<svg viewBox="0 0 40 40"><path d="M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z" fill="currentColor" stroke="#2b1840" stroke-width="2.6" stroke-linejoin="round"/><path d="M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z" fill="#ff9ec4"/><ellipse cx="14.3" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/><ellipse cx="25.7" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/></svg>`;
const hex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');

function prefColor(key = KEY) {
  try {
    const v = localStorage.getItem(key);
    const i = v == null ? -1 : parseInt(v, 10);
    return Number.isInteger(i) && i >= 0 && i < PLAYER_COLORS.length ? i : -1;
  } catch { return -1; }
}
function savePrefColor(i, key = KEY) {
  try { if (i >= 0) localStorage.setItem(key, String(i)); else localStorage.removeItem(key); } catch { /* ignore */ }
}

// Colour slots for n local players: player 1 gets its preference, player 2 its own (KEY2) unless player 1 has it,
// the rest the first free slots (never one a later player asked for).
function localSlots(n) {
  const prefs = [prefColor(), prefColor(KEY2)];
  const slots = [];
  for (let i = 0; i < n; i++) {
    const want = i < prefs.length ? prefs[i] : -1;
    if (want >= 0 && !slots.includes(want)) { slots.push(want); continue; }
    let s = 0;
    while (slots.includes(s) || prefs.slice(i + 1).includes(s)) s++;
    slots.push(s);
  }
  return slots;
}

const CSS = `
.rkcp{display:flex;flex-direction:column;align-items:center;gap:6px;}
.rkcp-btn{font:inherit;font-weight:900;font-size:14px;display:inline-flex;align-items:center;gap:8px;padding:5px 12px 5px 6px;border-radius:14px;cursor:pointer;color:#fff;
  background:rgba(255,255,255,.08);border:2px solid rgba(255,255,255,.18);}
.rkcp-btn:hover{background:rgba(255,255,255,.16);}
.rkcp-btn.rkcp-open{border-color:#ffcf5a;}
.rkcp-cat{width:28px;height:28px;flex:none;}
.rkcp-any .rkcp-cat{animation:rkcp-hue 4s linear infinite;}
@keyframes rkcp-hue{0%{color:#ffb347}25%{color:#6ec6ff}50%{color:#ff7eb6}75%{color:#9dff7a}100%{color:#ffb347}}
.rkcp-grid{display:none;flex-wrap:wrap;justify-content:center;gap:5px;max-width:372px;padding:8px;border-radius:16px;background:rgba(10,4,30,.55);border:2px solid rgba(255,255,255,.14);}
.rkcp-open + .rkcp-grid{display:flex;}
.rkcp-sw{width:27px;height:27px;border-radius:50%;cursor:pointer;padding:0;border:3px solid rgba(0,0,0,.35);box-shadow:inset 0 -3px 0 rgba(0,0,0,.18);}
.rkcp-sw:hover{transform:scale(1.15);}
.rkcp-sw.rkcp-on{border-color:#fff;box-shadow:0 0 0 2px #ffcf5a;}
.rkcp-none{width:auto;border-radius:14px;padding:0 9px;font:inherit;font-weight:900;font-size:11px;letter-spacing:.05em;color:#fff;background:rgba(255,255,255,.1);border:2px dashed rgba(255,255,255,.45);box-shadow:none;}
.rkcp-none.rkcp-on{border-style:solid;}
/* inline row: 40px tap targets around a smaller dot */
.rkcr{display:flex;flex-wrap:wrap;align-items:center;gap:0;min-width:0;}
.rkcr-b{font:inherit;width:34px;height:40px;padding:0;border:0;background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none;border-radius:12px;}
.rkcr-b:focus:not(:focus-visible){outline:none;}
.rkcr-b:focus-visible{outline:2px solid #fff;outline-offset:-2px;}
.rkcr-b .rkcp-sw{pointer-events:none;width:24px;height:24px;display:block;}
.rkcr-b:hover .rkcp-sw{transform:scale(1.15);}
.rkcr-b .rkcp-none{width:auto;height:24px;line-height:19px;padding:0 6px;}
.rkcr-any,.rkcr-more{width:auto;padding:0 3px;}
.rkcr-more span{font-weight:900;font-size:12px;color:#fff;opacity:.8;padding:3px 7px;border-radius:10px;border:2px solid rgba(255,255,255,.3);white-space:nowrap;}
.rkcr-more:hover span{opacity:1;border-color:#ffcf5a;}
.rkcr-x{display:none;}
.rkcr.rkcr-open .rkcr-x{display:flex;}
.rkcr-b.rkcr-taken{cursor:not-allowed;}
.rkcr-b.rkcr-taken .rkcp-sw{opacity:.2;transform:none;}
@media (max-height:500px){.rkcp-sw{width:22px;height:22px;}.rkcp-cat{width:22px;height:22px;}.rkcp-btn{font-size:12px;}}
`;

// onChange(index) is called after the choice is saved (index -1 = no preference).
function injectCss() {
  if (document.getElementById('rkcp-style')) return;
  const s = document.createElement('style');
  s.id = 'rkcp-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function createColorPicker(onChange) {
  injectCss();
  const wrap = document.createElement('div');
  wrap.className = 'rkcp';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rkcp-btn';
  const cat = document.createElement('span');
  cat.className = 'rkcp-cat';
  cat.innerHTML = CAT;
  const lab = document.createElement('span');
  btn.append(cat, lab);
  const grid = document.createElement('div');
  grid.className = 'rkcp-grid';
  const noFocus = (e) => e.preventDefault(); // keep Enter / gamepad on the menu buttons
  btn.addEventListener('mousedown', noFocus);
  btn.addEventListener('click', () => btn.classList.toggle('rkcp-open'));
  const sws = [];
  const add = (i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rkcp-sw' + (i < 0 ? ' rkcp-none' : '');
    if (i < 0) b.textContent = 'ANY';
    else b.style.background = hex(PLAYER_COLORS[i]);
    b.title = i < 0 ? 'No preference' : 'Kitty colour ' + (i + 1);
    b.addEventListener('mousedown', noFocus);
    b.addEventListener('click', () => {
      savePrefColor(i);
      paint();
      btn.classList.remove('rkcp-open');
      if (onChange) onChange(i);
    });
    sws.push([i, b]);
    grid.appendChild(b);
  };
  add(-1);
  for (let i = 0; i < PLAYER_COLORS.length; i++) add(i);
  function paint() {
    const p = prefColor();
    btn.classList.toggle('rkcp-any', p < 0);
    cat.style.color = p < 0 ? '' : hex(PLAYER_COLORS[p]);
    lab.textContent = p < 0 ? 'KITTY COLOUR: ANY' : 'KITTY COLOUR';
    for (const [i, b] of sws) b.classList.toggle('rkcp-on', i === p);
  }
  paint();
  wrap.append(btn, grid);
  return wrap;
}

// Inline swatches: ANY + the first `few` colours (+ the chosen one if it's further down) and a "more" toggle that
// expands the whole palette in place. onChange(index) is called after the choice is saved. opts: key (where the
// choice is saved; player 1's by default), taken() -> a colour index another local player has (greyed out, can't be
// picked). The element's refresh() repaints it (after the other player picks).
function createColorRow(onChange, few = 8, { key = KEY, taken = null } = {}) {
  injectCss();
  const wrap = document.createElement('div');
  wrap.className = 'rkcr';
  const items = [];
  const add = (i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rkcr-b' + (i < 0 ? ' rkcr-any' : '');
    const dot = document.createElement('span');
    dot.className = 'rkcp-sw' + (i < 0 ? ' rkcp-none' : '');
    if (i < 0) dot.textContent = 'ANY';
    else dot.style.background = hex(PLAYER_COLORS[i]);
    b.title = i < 0 ? 'Any colour' : 'Kitty colour ' + (i + 1);
    b.setAttribute('aria-label', b.title);
    b.appendChild(dot);
    b.addEventListener('click', () => {
      if (i >= 0 && taken && taken() === i) return;
      savePrefColor(i, key);
      wrap.classList.remove('rkcr-open'); // the pick stays visible in the short row
      paint();
      if (onChange) onChange(i);
    });
    items.push([i, b, dot]);
    wrap.appendChild(b);
  };
  add(-1);
  for (let i = 0; i < PLAYER_COLORS.length; i++) add(i);
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'rkcr-b rkcr-more';
  more.innerHTML = '<span></span>';
  more.addEventListener('click', () => { wrap.classList.toggle('rkcr-open'); paint(); });
  wrap.appendChild(more);
  function paint() {
    const p = prefColor(key), t = taken ? taken() : -1;
    const open = wrap.classList.contains('rkcr-open');
    for (const [i, b, dot] of items) {
      dot.classList.toggle('rkcp-on', i === p);
      b.classList.toggle('rkcr-taken', i >= 0 && i === t);
      b.setAttribute('aria-pressed', String(i === p));
      b.classList.toggle('rkcr-x', i >= few && i !== p); // hidden while collapsed
    }
    more.firstChild.textContent = open ? 'less' : `+${PLAYER_COLORS.length - few - (p >= few ? 1 : 0)}`;
    more.title = open ? 'Fewer colours' : 'More colours';
  }
  paint();
  wrap.refresh = paint;
  return wrap;
}

export { prefColor, savePrefColor, localSlots, createColorPicker, createColorRow, KEY2 as P2_COLOR_KEY };
