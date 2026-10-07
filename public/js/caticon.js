// The cat icon's lion looks, for the pictures drawn on a canvas (the share card in share.js and the revive calling
// card in effects.js; the player card does the same in SVG, ui.js). All in the icon's 40x40 frame.
//   lion: 14+ wins, a mane in a deeper shade of the kitty's colour
//   16+ wins: 'chrome' (silver face and mane), 'rainbow' (rainbow face and mane) or 'celestial' (night sky with stars)
const RAINBOW = ['#ff5a5a', '#ffb84a', '#f4f05a', '#6ef08a', '#5ac8ff', '#b47cff'];

// the mane: tufts round the head, drawn before (behind) the face
function manePath() {
  const p = new Path2D();
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + 0.2;
    const x = 20 + Math.cos(a) * 15.5, y = 21 + Math.sin(a) * 15.5;
    p.moveTo(x + 6, y);
    p.arc(x, y, 6, 0, Math.PI * 2);
  }
  p.moveTo(36, 21); p.arc(20, 21, 16, 0, Math.PI * 2);
  return p;
}

// a deeper shade of a '#rrggbb' colour (toward the ink purple)
function deeper(hex, k = 0.38) {
  const n = parseInt(hex.slice(1), 16), ink = [0x2b, 0x18, 0x40];
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v, i) => Math.round(v + (ink[i] - v) * k));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// fills for the face (and mane) of the 16-win looks; phase slides the rainbow
function rainbowFill(g, phase = 0) {
  const gr = g.createLinearGradient(-40 * phase, -24 * phase, 80 - 40 * phase, 48 - 24 * phase);
  for (let r = 0; r < 2; r++) RAINBOW.forEach((c, i) => gr.addColorStop((r + i / 6) / 2, c));
  gr.addColorStop(1, RAINBOW[0]);
  return gr;
}
function chromeFill(g) {
  const gr = g.createLinearGradient(0, 2, 30, 38);
  gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.35, '#b9c2d0'); gr.addColorStop(0.5, '#f4f7fb');
  gr.addColorStop(0.7, '#8c96a8'); gr.addColorStop(1, '#dfe5ee');
  return gr;
}
function cosmicFill(g) {
  const gr = g.createRadialGradient(20, 19, 1, 20, 21, 21);
  gr.addColorStop(0, '#a99bff'); gr.addColorStop(0.35, '#6a54e0'); gr.addColorStop(0.7, '#33208f'); gr.addColorStop(1, '#141045');
  return gr;
}
// the celestial look's little stars, over the face (clipped to it by the caller)
function stars(g) {
  g.fillStyle = '#fff';
  for (const [x, y, r] of [[30, 8, 0.6], [12, 31, 0.6], [33, 23, 0.5], [7, 23, 0.5], [17, 34, 0.45], [24, 10, 0.45], [35, 30, 0.5], [4, 29, 0.5]]) {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // twinkles: little four-point stars
  for (const [x, y, s] of [[9, 9, 2.2], [28, 31, 2.4], [36, 14, 1.8]]) {
    g.beginPath();
    g.moveTo(x, y - s); g.quadraticCurveTo(x, y, x + s, y); g.quadraticCurveTo(x, y, x, y + s); g.quadraticCurveTo(x, y, x - s, y); g.quadraticCurveTo(x, y, x, y - s);
    g.fill();
  }
}

// the mane behind the face (call with the 40x40 transform already set); look: { lion, lionLook, rainbow }
function drawMane(g, color, look, phase = 0) {
  if (!look || !look.lion) return;
  const p = manePath();
  g.fillStyle = look.lionLook === 'chrome' ? chromeFill(g) : look.lionLook === 'celestial' ? cosmicFill(g)
    : look.lionLook === 'rainbow' ? rainbowFill(g, phase) : deeper(color);
  // outline first, fill over it: only the mane's outer edge keeps the ink line
  const fill = g.fillStyle;
  g.strokeStyle = look.lionLook === 'celestial' ? '#8fb8ff' : '#2b1840';   // (celestial: a starlight edge, dark on dark otherwise)
  g.lineWidth = 3.2; g.lineJoin = 'round'; g.stroke(p);
  g.fillStyle = fill; g.fill(p);
  if (look.lionLook === 'celestial') { g.save(); g.clip(p); stars(g); g.restore(); }
}
// the face's fill for a look (null: the plain colour or the rainbow cat's own rainbow, the caller's)
function faceFill(g, look, phase = 0) {
  if (!look) return null;
  if (look.lionLook === 'chrome') return chromeFill(g);
  if (look.lionLook === 'celestial') return cosmicFill(g);
  if (look.lionLook === 'rainbow' || look.rainbow) return rainbowFill(g, phase);
  return null;
}

export { drawMane, faceFill, stars, deeper, RAINBOW };
