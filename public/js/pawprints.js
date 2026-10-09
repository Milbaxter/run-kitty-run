import * as THREE from 'three';

// Paw prints: a kitty with 2+ finished runs leaves little paw prints in its own colour instead of dust puffs.
// One pooled ring buffer of flat quads per kitty (shared canvas paw texture, tinted by vertex colour). A print is
// written once when the paw lands; after that only its alpha changes, fading out over LIFE seconds.

const LIFE = 2.2;           // seconds a print lasts (full for ~1 s, then fades)
const FADE = 1.2;           // fade-out time at the end of LIFE
const MAX = 20;             // pooled prints per kitty (a step every 0.13 s)
const SIZE = 0.3;           // world-space print size (kitty radius 0.4)
const SIDE = 0.1;           // left/right paw offset from the path
const GAP = 0.4;            // min distance between prints (steps are timed, so slow walking would pile them up)
const Y = 0.05;             // above floor decals and autumn leaves
const OPACITY = 0.92;
// the celestial lion's prints boom once before they fade (as if switched on a second time): they swell to
// PULSE_GROW times their size and glow brighter in their own colour, then settle back
const PULSE_AT = 1.55, PULSE_LEN = 0.34, PULSE_GROW = 0.55;   // (1.55: just before the print fades away)

// the UI paw icon (40x40 box, toes up = forward): main pad + 4 toe beans [x, y, rx, ry, tilt]
const PADS = [[20, 26.5, 8.6, 7, 0], [8.6, 16, 3.5, 4.4, -0.35], [15.4, 9.4, 3.5, 4.6, -0.1], [24.6, 9.4, 3.5, 4.6, 0.1], [31.4, 16, 3.5, 4.4, 0.35]];

let texCache = null;
function pawTexture() {
  if (texCache) return texCache;
  const S = 128, k = S / 40, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const paw = (grow) => {
    g.beginPath();
    for (const [x, y, rx, ry, a] of PADS) {
      g.moveTo((x + (rx + grow) * Math.cos(a)) * k, (y + (rx + grow) * Math.sin(a)) * k);
      g.ellipse(x * k, y * k, (rx + grow) * k, (ry + grow) * k, a, 0, Math.PI * 2);
    }
    g.fill();
  };
  // rgb multiplies the kitty colour: a soft dark halo (reads on pale snow), a darker rim, then the colour itself
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 7;
  g.fillStyle = 'rgba(0,0,0,0.28)'; paw(1.4);
  g.shadowColor = 'rgba(0,0,0,0)';
  g.fillStyle = '#6a6a6a'; paw(0.8);
  g.fillStyle = '#ffffff'; paw(0);
  texCache = new THREE.CanvasTexture(c);
  return texCache;
}

function createPawPrints(scene, color) {
  const pos = new Float32Array(MAX * 12);
  const col = new Float32Array(MAX * 16);
  const uv = new Float32Array(MAX * 8);
  const idx = new Uint16Array(MAX * 6);
  const born = new Float32Array(MAX).fill(-1e9);
  const c = new THREE.Color(color);
  // per print, for the pulse: [centre x, y, centre z, forward x, forward z, right x, right z, pulses?] and its tint
  const shape = new Float32Array(MAX * 8), tints = new Float32Array(MAX * 3);
  for (let i = 0, b = 0; i < MAX; i++, b += 4) {
    uv.set([0, 0, 1, 0, 0, 1, 1, 1], i * 8); // v = 1 at the toes
    idx.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.MeshBasicMaterial({ map: pawTexture(), vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2; // a floor mark: after the ice sheet (-1), with the skate trail (2), before the aura (3)
  mesh.visible = false;
  scene.add(mesh);

  let time = 0, head = 0, side = 1, lx = Infinity, lz = Infinity;

  // a step at x, z on ground height y, heading that way: left and right paws take turns (toes turned out a little);
  // tint (optional): this print's colour instead of the kitty's (6+ finishes cycle through the cat colours)
  function add(x, y, z, heading, tint, pulse = false) {
    if ((x - lx) ** 2 + (z - lz) ** 2 < GAP * GAP) return;
    lx = x; lz = z; side = -side;
    const i = head; head = (head + 1) % MAX;
    born[i] = time;
    const t = tint || c;
    for (let o = i * 16; o < i * 16 + 16; o += 4) { col[o] = t.r; col[o + 1] = t.g; col[o + 2] = t.b; }
    const a = heading + side * 0.12, h = SIZE / 2;
    const fx = Math.cos(a) * h, fz = Math.sin(a) * h, rx = -fz, rz = fx;
    const cx = x - Math.sin(heading) * side * SIDE, cz = z + Math.cos(heading) * side * SIDE;
    place(i, cx, y + Y, cz, fx, fz, rx, rz, 1);
    shape.set([cx, y + Y, cz, fx, fz, rx, rz, pulse ? 1 : 0], i * 8);
    tints.set([t.r, t.g, t.b], i * 3);
    geo.attributes.position.needsUpdate = true;
  }
  // a print's quad at size k (1: as it landed)
  function place(i, cx, y, cz, fx, fz, rx, rz, k) {
    for (let v = 0, o = i * 12; v < 4; v++, o += 3) {
      const su = v & 1 ? 1 : -1, sv = v & 2 ? 1 : -1;
      pos[o] = cx + (rx * su + fx * sv) * k; pos[o + 1] = y; pos[o + 2] = cz + (rz * su + fz * sv) * k;
    }
  }

  function update(dt) {
    time += dt;
    let live = 0, moved = false;
    for (let i = 0; i < MAX; i++) {
      const age = time - born[i];
      let al = age < LIFE ? OPACITY * Math.min(1, age * 16, (LIFE - age) / FADE) : 0;
      if (al > 0) live++;
      const s = i * 8;
      if (shape[s + 7] && age >= PULSE_AT && age < PULSE_AT + PULSE_LEN + dt) {
        // the boom: up fast, down softer (back to exactly its size and colour at the end)
        const u = Math.min(1, (age - PULSE_AT) / PULSE_LEN), b = u < 0.3 ? u / 0.3 : 1 - ((u - 0.3) / 0.7) ** 0.8;
        place(i, shape[s], shape[s + 1], shape[s + 2], shape[s + 3], shape[s + 4], shape[s + 5], shape[s + 6], 1 + PULSE_GROW * b);
        // its own colour at full strength: the same hue raised until its brightest channel is 1 (violet glows the
        // brightest violet, no white in it), and fully solid at the peak
        const t = i * 3, peak = Math.max(tints[t], tints[t + 1], tints[t + 2], 0.05), g = 1 + (1 / peak - 1) * b;
        for (let o = i * 16; o < i * 16 + 16; o += 4) {
          for (let ch = 0; ch < 3; ch++) col[o + ch] = Math.min(1, tints[t + ch] * g);
        }
        al = al + (1 - al) * b;
        moved = true;
      }
      for (let v = 0, o = i * 16 + 3; v < 4; v++, o += 4) col[o] = al;
    }
    mesh.visible = live > 0;
    if (live) geo.attributes.color.needsUpdate = true; // rgb is written by add() (and the pulse)
    if (moved) geo.attributes.position.needsUpdate = true;
  }

  // new level: wipe the old map's prints
  function clear() { born.fill(-1e9); lx = lz = Infinity; mesh.visible = false; }

  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { add, update, clear, dispose };
}

export { createPawPrints };
