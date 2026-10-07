// Sharing a run's result: a square image card (canvas) plus a short text with the game's link. Phones share both
// through the system share menu (where the browser can share files); elsewhere the text is copied and the card is
// saved as a picture. In the store apps (no file sharing there yet) the text and link go through the Share plugin.
import { NATIVE, share as shareText } from './platform.js';
import { TOUCH } from './device.js';
import { drawMane, faceFill, stars } from './caticon.js';

const FONT = "'Baloo 2','Fredoka','Trebuchet MS','Segoe UI',system-ui,sans-serif";
const INK = '#2b1840';
const MODE_NAMES = { mixed: 'Run + Skate', run: 'Run only', ice: 'Skate only' };
const CLEARED = { mixed: 'Run + Skate', run: 'Run', ice: 'Skate' };   // cleared the ... mode
const LINK = 'https://runkittyrun.fun';   // (the public name, also from the apps)
const SITE = LINK.replace(/^https?:\/\//, '');

const clock = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);

// r: { win, mode, level, time, crowns, revives, name, color, cool, rainbow, lion, lionLook, team (kitties in the game) }
function shareText_(r) {
  const mode = MODE_NAMES[r.mode] || MODE_NAMES.mixed;
  const we = r.team > 1 ? 'We' : 'I';
  const bits = [clock(r.time)];
  if (r.crowns) bits.push(`${r.crowns} crown${r.crowns === 1 ? '' : 's'}`);
  if (r.revives) bits.push(`${r.revives} revive${r.revives === 1 ? '' : 's'}`);
  if (r.win && (r.mode || 'mixed') === 'mixed') return `${we} beat Run Kitty Run: cleared the Run + Skate mode. Legend! 🐱👑 ${bits.join(' · ')}. Can you escape too? ${LINK}`;
  return r.win
    ? `${we} cleared the ${CLEARED[r.mode] || CLEARED.mixed} mode in Run Kitty Run! 🐱👑 ${bits.join(' · ')}. Can you escape too? ${LINK}`
    : `${we} reached level ${r.level} in Run Kitty Run (${mode}) 🐱 ${bits.join(' · ')}. Can you get further? ${LINK}`;
}

// the player card's cat face (ui.js ICONS.cat) in the kitty's colour, 40x40 units at (x, y), size s, wearing what
// the card wears: sunglasses (5+ wins), the rainbow fur (8+ wins and 60+ revives), the lion's mane (14+) and the
// 16-win looks (caticon.js)
function catFace(g, x, y, s, color, look = {}) {
  const P = (d) => new Path2D(d);
  g.save(); g.translate(x, y); g.scale(s / 40, s / 40);
  g.lineJoin = 'round'; g.lineCap = 'round';
  const head = P('M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z');
  drawMane(g, color, look);
  g.fillStyle = faceFill(g, look) || color;
  g.fill(head);
  if (look.lionLook === 'celestial') { g.save(); g.clip(head); stars(g); g.restore(); }
  g.strokeStyle = INK; g.lineWidth = 2.6; g.stroke(head);
  g.fillStyle = '#ff9ec4'; g.fill(P('M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z'));
  if (look.cool) {   // the card's sunglasses (ui.js SHADES_SVG)
    g.strokeStyle = '#ffd34a'; g.lineWidth = 1.6; g.stroke(P('M5 19.6 L10 18.8 M35 19.6 L30 18.8 M18.4 20.2 Q20 18.6 21.6 20.2'));
    g.fillStyle = '#1e1a2b'; g.lineWidth = 1;
    g.beginPath(); g.ellipse(14, 21.6, 4.8, 4.2, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.beginPath(); g.ellipse(26, 21.6, 4.8, 4.2, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.stroke(P('M11.4 19.8 L14.6 19.1 M23.4 19.8 L26.6 19.1'));
  } else {
    g.fillStyle = INK; g.beginPath(); g.ellipse(14.3, 21.5, 2.3, 3.1, 0, 0, Math.PI * 2); g.ellipse(25.7, 21.5, 2.3, 3.1, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(15, 20.4, 0.9, 0, Math.PI * 2); g.arc(26.4, 20.4, 0.9, 0, Math.PI * 2); g.fill();
  }
  const nose = P('M18.2 26.4 L21.8 26.4 L20 28.6 Z');
  g.fillStyle = '#ff6f9f'; g.fill(nose); g.strokeStyle = INK; g.lineWidth = 1; g.stroke(nose);
  g.lineWidth = 1.3; g.stroke(P('M20 28.6 Q18.5 31 16.5 30 M20 28.6 Q21.5 31 23.5 30'));
  g.restore();
}
function paw(g, x, y, s, a) {
  g.save(); g.translate(x, y); g.rotate(a); g.scale(s / 40, s / 40);
  g.beginPath(); g.ellipse(20, 27, 9, 7.5, 0, 0, Math.PI * 2);
  for (const [cx, cy, rot] of [[8.5, 17, -0.35], [15.5, 10, -0.1], [24.5, 10, 0.1], [31.5, 17, 0.35]]) { g.moveTo(cx + 3.6, cy); g.ellipse(cx, cy, 3.6, 4.7, rot, 0, Math.PI * 2); }
  g.fill(); g.restore();
}
// text with the game's chunky outline
function outlined(g, text, x, y, size, fill, stroke = '#3a1650', w = 0.16) {
  g.font = `900 ${size}px ${FONT}`;
  g.lineJoin = 'round'; g.lineWidth = size * w; g.strokeStyle = stroke;
  g.strokeText(text, x, y); g.fillStyle = fill; g.fillText(text, x, y);
}
function fit(g, text, size, max) {
  g.font = `900 ${size}px ${FONT}`;
  const w = g.measureText(text).width;
  return w > max ? Math.floor(size * max / w) : size;
}

// a 1080x1080 card of the result
function drawCard(r) {
  const S = 1080;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  // night-purple background, a soft glow behind the kitty, faint paw prints
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, r.win ? '#3a1a66' : '#2c1452'); bg.addColorStop(1, '#0f0624');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  const glow = g.createRadialGradient(S / 2, 470, 20, S / 2, 470, 420);
  glow.addColorStop(0, r.win ? 'rgba(255,207,90,.38)' : 'rgba(150,110,255,.30)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow; g.fillRect(0, 0, S, S);
  g.fillStyle = 'rgba(255,255,255,.05)';
  for (let i = 0; i < 16; i++) paw(g, (i * 271) % S - 30, (i * 433) % S - 30, 70 + (i * 13) % 40, (i * 0.7) % 6.28);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  // title
  outlined(g, 'RUN KITTY RUN', S / 2, 150, 104, '#ffd56b', '#3a1650', 0.2);
  // the kitty (with a crown when it won), its name and the mode
  catFace(g, S / 2 - 150, 230, 300, hex(r.color), { cool: r.cool, rainbow: r.rainbow, lion: r.lion, lionLook: r.lionLook });
  if (r.win) {
    g.save(); g.translate(S / 2, 222); g.scale(3.2, 3.2);
    const crown = new Path2D('M-15 8 L-17 -11 L-7 -3 L0 -16 L7 -3 L17 -11 L15 8 Z');
    g.fillStyle = '#ffd34a'; g.fill(crown); g.strokeStyle = INK; g.lineWidth = 2.4; g.lineJoin = 'round'; g.stroke(crown);
    g.restore();
  }
  const name = String(r.name || '').slice(0, 24);
  if (name) outlined(g, name, S / 2, 600, fit(g, name, 58, 760), hex(r.color), '#1c0c34', 0.18);
  // the headline: escaped, or how far
  const legend = r.win && (r.mode || 'mixed') === 'mixed';
  const head = legend ? 'LEGEND' : r.win ? 'ESCAPED!' : `LEVEL ${r.level}`;
  outlined(g, head, S / 2, 735, 150, '#fff6d8', '#3a1650', 0.18);
  g.font = `800 44px ${FONT}`; g.fillStyle = 'rgba(239,231,255,.85)';
  g.fillText(r.win ? `cleared the ${CLEARED[r.mode] || CLEARED.mixed} mode`
    : 'reached · ' + (MODE_NAMES[r.mode] || MODE_NAMES.mixed) + (r.team > 1 ? ` · ${r.team} kitties` : ''), S / 2, 800);
  // stat pills: time, crowns, revives
  const pills = [['⏱', clock(r.time), 'time'], ['👑', String(r.crowns | 0), 'crowns'], ['🩹', String(r.revives | 0), 'revives']];
  const pw = 280, gap = 30, x0 = S / 2 - (pills.length * pw + (pills.length - 1) * gap) / 2;
  pills.forEach(([icon, v, label], i) => {
    const x = x0 + i * (pw + gap), y = 850;
    g.fillStyle = 'rgba(20,8,48,.6)'; g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 4;
    g.beginPath(); if (g.roundRect) g.roundRect(x, y, pw, 130, 34); else g.rect(x, y, pw, 130); g.fill(); g.stroke();   // (older browsers: square corners)
    g.font = `900 56px ${FONT}`; g.fillStyle = '#fff6d8'; g.fillText(icon + ' ' + v, x + pw / 2, y + 70);
    g.font = `800 28px ${FONT}`; g.fillStyle = 'rgba(239,231,255,.7)'; g.fillText(label, x + pw / 2, y + 108);
  });
  // the link
  g.font = `900 40px ${FONT}`; g.fillStyle = '#ffd56b';
  g.fillText(SITE, S / 2, 1046);
  return c;
}

const toBlob = (c) => new Promise((ok) => c.toBlob((b) => ok(b), 'image/png'));

// share the result: 'shared' | 'saved' (picture downloaded + text copied) | 'copied' | 'cancelled' | 'failed'
async function shareResult(r) {
  const text = shareText_(r);
  if (NATIVE) return shareText({ title: 'Run Kitty Run', text, url: '' });
  let file = null;
  try {
    const blob = await toBlob(drawCard(r));
    if (blob) file = new File([blob], 'run-kitty-run.png', { type: 'image/png' });
  } catch { /* text only */ }
  // phones and tablets: the system share menu (computers get the picture saved instead of the desktop share dialog)
  if (TOUCH && file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text, title: 'Run Kitty Run' }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  // computers (and browsers without file sharing): the picture is saved and the text copied
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch { /* no clipboard */ }
  if (file) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return 'saved';
  }
  return copied ? 'copied' : 'failed';
}

export { shareResult, drawCard as drawShareCard, shareText_ as shareMessage };
