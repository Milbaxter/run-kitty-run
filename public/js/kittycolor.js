// Preferred kitty colour (an index into PLAYER_COLORS, or -1 for no preference), remembered in localStorage.
// Online it goes with 'create' / 'join' (the server gives it unless someone in the lobby already has it);
// offline player 1 uses it. The picker is a small cat button that opens a row of swatches.
import { PLAYER_COLORS } from './shared/config.js';

const KEY = 'rkr-color';
const CAT = `<svg viewBox="0 0 40 40"><path d="M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z" fill="currentColor" stroke="#2b1840" stroke-width="2.6" stroke-linejoin="round"/><path d="M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z" fill="#ff9ec4"/><ellipse cx="14.3" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/><ellipse cx="25.7" cy="21.5" rx="2.3" ry="3.1" fill="#2b1840"/></svg>`;
const hex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');

function prefColor() {
  try {
    const v = localStorage.getItem(KEY);
    const i = v == null ? -1 : parseInt(v, 10);
    return Number.isInteger(i) && i >= 0 && i < PLAYER_COLORS.length ? i : -1;
  } catch { return -1; }
}
function savePrefColor(i) {
  try { if (i >= 0) localStorage.setItem(KEY, String(i)); else localStorage.removeItem(KEY); } catch { /* ignore */ }
}

// Colour slots for n local players: player 1 gets the preference, the rest the first free slots (as before).
function localSlots(n) {
  const pref = prefColor();
  const slots = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 && pref >= 0) { slots.push(pref); continue; }
    let s = 0;
    while (slots.includes(s) || (s === pref && pref >= 0)) s++;
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
@media (max-height:500px){.rkcp-sw{width:22px;height:22px;}.rkcp-cat{width:22px;height:22px;}.rkcp-btn{font-size:12px;}}
`;

// onChange(index) is called after the choice is saved (index -1 = no preference).
function createColorPicker(onChange) {
  if (!document.getElementById('rkcp-style')) {
    const s = document.createElement('style');
    s.id = 'rkcp-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
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

export { prefColor, savePrefColor, localSlots, createColorPicker };
