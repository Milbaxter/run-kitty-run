import * as THREE from 'three';
import { CFG } from './shared/config.js';
import { createRng, hashSeed, TAU } from './shared/rng.js';
import { locate, collideCircle } from './shared/maze.js';
import { QUALITY } from './device.js';

// world.js — maze scenery, decor, ambient particles and lighting. (owner: world agent)
//
// Notes / interpretations:
// - buildWorld adds its group to the scene itself; dispose() removes it and frees every
//   geometry/material/texture it created.
// - THEMES entries carry extra fields beyond the contract (lighting, fog, decor palettes).
// - The theme index is levelData.theme, falling back to (level-1)%4.
// - Radial walls are swept walls (same style as ring walls), shortened by half the wall
//   thickness at both ends so they butt against the ring walls.
// - Lantern pillars sit flush at both ends of every gap (inset into the wall end) and every
//   ~9 units along the outer wall. No real point lights: emissive orbs + additive ground glows.
// - setupLighting expects renderer.shadowMap.enabled = true / PCFSoftShadowMap (done in main).


const THEMES = [
  {
    name: 'Sunny Meadow',
    sky: 0x9fd8ff, fog: 0xbfe3f5, fogNear: 48, fogFar: 125,
    ground: 0x86c95f, groundAlt: 0x97d26c, outerGround: 0x7cbf58, plaza: 0xeee2c6,
    wall: 0x3f8e3d, wallTop: 0x8ed86f, accent: 0xfff2a0, lamp: 0xffd27a,
    pillar: 0xe0d6bd, trunk: 0x8a5a3a, rock: 0xa3a39a, tuft: 0x5fae45, chevron: 0xffffff,
    hemiSky: 0xd8f0ff, hemiGround: 0x5d7a3c, hemiIntensity: 1.2,
    sunColor: 0xfff0d8, sunIntensity: 2.3, lampBoost: 2.6, glowK: 0.22, chevronOpacity: 0.32,
    floorStyle: 'grass', wallStyle: 'hedge', particles: 'pollen', crownEmissive: 0,
    crowns: [0x5cb84a, 0x4aa63f, 0x78c850, 0x3f9a45, 0x8fd35a],
    smalls: [0xffffff, 0xff8fc8, 0xffe14d, 0xb48cff, 0xff6b6b],
  },
  {
    name: 'Autumn Grove',
    sky: 0xffd9a8, fog: 0xf2cfa4, fogNear: 48, fogFar: 120,
    ground: 0xb9a457, groundAlt: 0xc4ae60, outerGround: 0xab9649, plaza: 0xe3d1b0,
    wall: 0xa8432a, wallTop: 0xf08c3c, accent: 0xffc04a, lamp: 0xffa040,
    pillar: 0xcdb89c, trunk: 0x6b4430, rock: 0x948a7c, tuft: 0xb08d3c, chevron: 0xfff2cc,
    hemiSky: 0xffe4c4, hemiGround: 0x6e4a2c, hemiIntensity: 1.1,
    sunColor: 0xffc890, sunIntensity: 2.2, lampBoost: 2.8, glowK: 0.28, chevronOpacity: 0.32,
    floorStyle: 'autumn', wallStyle: 'hedge', particles: 'leaves', crownEmissive: 0,
    crowns: [0xe8642c, 0xd83f2a, 0xf2a03a, 0xf5c542, 0xb8462e],
    smalls: [0xe8642c, 0xd83f2a, 0xf2a03a, 0xf5c542, 0x9c3b22],
  },
  {
    name: 'Snowy Peaks',
    sky: 0xcfe4f7, fog: 0xdbe9f6, fogNear: 44, fogFar: 115,
    ground: 0xdfe7f3, groundAlt: 0xd2ddee, outerGround: 0xdbe4f1, plaza: 0xbcc8da,
    wall: 0x7f90ab, wallTop: 0xf6f9ff, accent: 0x8fdcff, lamp: 0xffc878,
    pillar: 0x9aa6ba, trunk: 0x5a4636, rock: 0x8d9bb0, tuft: 0xffffff, chevron: 0x5aa8f0,
    hemiSky: 0xe4eeff, hemiGround: 0x5f7fc0, hemiIntensity: 1.15,
    sunColor: 0xfff4e6, sunIntensity: 1.6, lampBoost: 3.0, glowK: 0.3, chevronOpacity: 0.38,
    floorStyle: 'snow', wallStyle: 'stone', particles: 'snow', crownEmissive: 0,
    crowns: [0x2f6b52, 0x3a7a5e, 0x2a5e4a, 0x497f68, 0xbfd8dc],
    smalls: [0xffffff, 0xd8ecff, 0x9fd8ff],
  },
  {
    name: 'Neon Garden',
    sky: 0x150a2e, fog: 0x1e0f40, fogNear: 30, fogFar: 90,
    ground: 0x2c2650, groundAlt: 0x342c5c, outerGround: 0x221c40, plaza: 0x4a4280,
    wall: 0x352c66, wallTop: 0xff4fd8, accent: 0x3ff6ff, lamp: 0x7cf8ff,
    pillar: 0x40367a, trunk: 0x2a2040, rock: 0x3e3570, tuft: 0x3b2f7a, chevron: 0x3ff6ff,
    hemiSky: 0x9a84ff, hemiGround: 0x2a1a48, hemiIntensity: 1.2,
    sunColor: 0xb8a8ff, sunIntensity: 1.1, lampBoost: 2.8, glowK: 0.35, chevronOpacity: 0.6,
    floorStyle: 'neon', wallStyle: 'neon', particles: 'motes', crownEmissive: 0.12,
    crowns: [0x5b2fa0, 0x47288a, 0x6a35b0, 0x3a2470, 0x2f6fa0],
    smalls: [0x3ff6ff, 0xff4fd8, 0xb6ff4f, 0xffd24f],
  },
];

// ---------------------------------------------------------------- small helpers

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function hash2(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function makeTracker() {
  const geos = new Set(), mats = new Set(), texs = new Set();
  return {
    g(x) { geos.add(x); return x; },
    m(x) { mats.add(x); return x; },
    t(x) { texs.add(x); return x; },
    dispose() {
      geos.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose()); texs.forEach((x) => x.dispose());
      geos.clear(); mats.clear(); texs.clear();
    },
  };
}

function canvasTex(size, draw, { srgb = true, repeat = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// draw fn at (x,y) plus wrapped copies near edges so the texture tiles seamlessly
function wrapDraw(size, x, y, m, fn) {
  for (let dx = -size; dx <= size; dx += size) {
    for (let dy = -size; dy <= size; dy += size) {
      const px = x + dx, py = y + dy;
      if (px > -m && px < size + m && py > -m && py < size + m) fn(px, py);
    }
  }
}

function blotches(g, S, rng, n, rMin, rMax, light, dark) {
  for (let i = 0; i < n; i++) {
    const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(rMin, rMax);
    const col = rng.chance(0.5) ? light : dark;
    const rgb = `${col[0]},${col[1]},${col[2]}`;
    wrapDraw(S, x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, `rgba(${rgb},${col[3]})`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
    });
  }
}

function makeFloorTextures(style, T) {
  const rng = createRng(hashSeed('floor', style));
  const S = 512;
  let map, emissiveMap = null;
  if (style === 'grass' || style === 'autumn') {
    const autumn = style === 'autumn';
    map = canvasTex(S, (g) => {
      g.fillStyle = autumn ? '#d4cdbf' : '#cfd2cb'; g.fillRect(0, 0, S, S);
      blotches(g, S, rng, 70, 25, 80, [255, 255, 235, 0.22], [60, 70, 30, 0.14]);
      g.lineCap = 'round';
      const blades = autumn ? 1800 : 4200;
      for (let i = 0; i < blades; i++) {
        const x = rng.range(0, S), y = rng.range(0, S), len = rng.range(5, 13);
        const ang = -Math.PI / 2 + rng.range(-0.7, 0.7);
        const v = rng.int(165, 255);
        g.strokeStyle = autumn ? `rgb(${v},${(v * 0.95) | 0},${(v * 0.8) | 0})` : `rgb(${(v * 0.93) | 0},${v},${(v * 0.82) | 0})`;
        g.lineWidth = rng.range(1.2, 2.4);
        wrapDraw(S, x, y, 14, (px, py) => {
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len); g.stroke();
        });
      }
      if (autumn) {
        const leafCols = ['rgb(255,170,120)', 'rgb(255,130,100)', 'rgb(255,225,140)', 'rgb(140,110,90)', 'rgb(255,200,150)'];
        for (let i = 0; i < 650; i++) {
          const x = rng.range(0, S), y = rng.range(0, S), rx = rng.range(3, 7), ry = rx * rng.range(0.4, 0.6), rot = rng.range(0, TAU);
          g.fillStyle = rng.pick(leafCols);
          wrapDraw(S, x, y, 8, (px, py) => { g.beginPath(); g.ellipse(px, py, rx, ry, rot, 0, TAU); g.fill(); });
        }
      } else {
        // a few tiny clover dots
        for (let i = 0; i < 300; i++) {
          const x = rng.range(0, S), y = rng.range(0, S);
          g.fillStyle = `rgba(255,255,230,${rng.range(0.25, 0.6)})`;
          wrapDraw(S, x, y, 3, (px, py) => { g.beginPath(); g.arc(px, py, rng.range(1, 2.2), 0, TAU); g.fill(); });
        }
      }
    });
  } else if (style === 'snow') {
    map = canvasTex(S, (g) => {
      g.fillStyle = '#f0f2f6'; g.fillRect(0, 0, S, S);
      blotches(g, S, rng, 50, 40, 120, [255, 255, 255, 0.35], [150, 175, 225, 0.14]);
      for (let i = 0; i < 700; i++) {
        const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(0.8, 2.2);
        g.fillStyle = `rgba(160,185,230,${rng.range(0.05, 0.12)})`;
        wrapDraw(S, x, y, 6, (px, py) => { g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill(); });
      }
    });
    emissiveMap = canvasTex(S, (g) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 260; i++) {
        const x = rng.range(0, S), y = rng.range(0, S), v = rng.int(120, 255);
        g.fillStyle = `rgb(${v},${v},${v})`;
        const s = rng.chance(0.15) ? 2 : 1;
        g.fillRect(x, y, s, s);
      }
    });
  } else {
    // neon: dark tiles + glowing grid emissive map
    const N = 4, ts = S / N;
    map = canvasTex(S, (g) => {
      g.fillStyle = '#6a6a80'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const v = rng.int(185, 235);
        g.fillStyle = `rgb(${v},${v},${(v * 1.04) | 0})`;
        g.fillRect(i * ts + 3, j * ts + 3, ts - 6, ts - 6);
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(i * ts + 3, j * ts + 3, ts - 6, (ts - 6) * 0.4);
      }
    });
    emissiveMap = canvasTex(S, (g) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
      for (const [w, a] of [[8, 0.18], [3, 0.55], [1.2, 1]]) {
        g.strokeStyle = `rgba(255,255,255,${a})`; g.lineWidth = w;
        for (let i = 0; i <= N; i++) {
          g.beginPath(); g.moveTo(i * ts, 0); g.lineTo(i * ts, S); g.stroke();
          g.beginPath(); g.moveTo(0, i * ts); g.lineTo(S, i * ts); g.stroke();
        }
      }
    });
  }
  T.t(map); if (emissiveMap) T.t(emissiveMap);
  return { map, emissiveMap };
}

// Square stone tile with a bright border and a paw print: marks the wolf-free corner squares.
function makeSafeTileTexture(T) {
  const rng = createRng(4242);
  const S = 256;
  return T.t(canvasTex(S, (g) => {
    g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, S, S);
    const n = 6, cell = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = rng.int(200, 245);
      g.fillStyle = `rgb(${v},${v},${(v * 0.98) | 0})`;
      g.fillRect(i * cell + 2.5, j * cell + 2.5, cell - 5, cell - 5);
    }
    g.strokeStyle = '#ffffff'; g.lineWidth = 10; g.strokeRect(9, 9, S - 18, S - 18);
    // paw print
    g.fillStyle = 'rgba(120,120,120,.75)';
    const C = S / 2;
    g.beginPath(); g.ellipse(C, C + 14, 30, 25, 0, 0, TAU); g.fill();
    for (const [dx, dy, r] of [[-36, -14, 11], [-14, -36, 12], [14, -36, 12], [36, -14, 11]]) {
      g.beginPath(); g.ellipse(C + dx, C + dy, r, r * 1.25, 0, 0, TAU); g.fill();
    }
  }, { repeat: false }));
}

function makePlazaTexture(T) {
  const rng = createRng(777);
  const S = 512, C = S / 2;
  return T.t(canvasTex(S, (g) => {
    g.fillStyle = '#8f8f8f'; g.fillRect(0, 0, S, S);
    const stone = (r0, r1, a0, a1) => {
      const v = rng.int(205, 248);
      g.fillStyle = `rgb(${v},${v},${(v * 0.98) | 0})`;
      g.beginPath(); g.arc(C, C, r1, a0, a1); g.arc(C, C, r0, a1, a0, true); g.closePath(); g.fill();
    };
    g.fillStyle = '#f4f4f4'; g.beginPath(); g.arc(C, C, 38, 0, TAU); g.fill();
    // little star inlay
    g.fillStyle = '#c8c8c8'; g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = k / 10 * TAU, r = k % 2 ? 12 : 30;
      g.lineTo(C + Math.cos(a) * r, C + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
    let r = 42;
    while (r < 256) {
      const w = 34, rm = r + w / 2;
      const n = Math.max(6, Math.round(TAU * rm / 46));
      const off = rng.range(0, TAU);
      const gapA = 2.2 / rm;
      for (let k = 0; k < n; k++) {
        const a0 = off + k / n * TAU + gapA, a1 = off + (k + 1) / n * TAU - gapA;
        stone(r, r + w - 2.5, a0, a1);
      }
      r += w;
    }
    // edge darkening near the wall
    const gr = g.createRadialGradient(C, C, 190, C, C, 256);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }, { repeat: false }));
}

function makeWallTexture(style, T) {
  const rng = createRng(hashSeed('wall', style));
  const S = 256;
  return T.t(canvasTex(S, (g) => {
    if (style === 'hedge') {
      g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 1500; i++) {
        const x = rng.range(0, S), y = rng.range(0, S), rx = rng.range(4, 9), ry = rx * rng.range(0.45, 0.7), rot = rng.range(0, TAU);
        const v = rng.int(150, 255);
        g.fillStyle = `rgb(${v},${v},${(v * 0.92) | 0})`;
        wrapDraw(S, x, y, 10, (px, py) => { g.beginPath(); g.ellipse(px, py, rx, ry, rot, 0, TAU); g.fill(); });
      }
      for (let i = 0; i < 260; i++) {
        const x = rng.range(0, S), y = rng.range(0, S);
        g.fillStyle = 'rgba(40,40,40,0.35)';
        wrapDraw(S, x, y, 3, (px, py) => { g.beginPath(); g.arc(px, py, rng.range(1, 2.5), 0, TAU); g.fill(); });
      }
    } else if (style === 'stone') {
      g.fillStyle = '#909090'; g.fillRect(0, 0, S, S);
      const bh = 32, bw = 64;
      for (let row = 0; row < S / bh; row++) {
        const off = (row % 2) * bw / 2;
        for (let k = -1; k < S / bw + 1; k++) {
          const x = k * bw + off, y = row * bh, v = rng.int(190, 240);
          g.fillStyle = `rgb(${v},${v},${Math.min(255, v + 6)})`;
          wrapDraw(S, x, y, bw, (px, py) => g.fillRect(px + 2, py + 2, bw - 4, bh - 4));
          g.fillStyle = 'rgba(255,255,255,0.18)';
          wrapDraw(S, x, y, bw, (px, py) => g.fillRect(px + 2, py + 2, bw - 4, 4));
        }
      }
      for (let i = 0; i < 500; i++) {
        g.fillStyle = `rgba(60,60,70,${rng.range(0.05, 0.2)})`;
        g.fillRect(rng.range(0, S), rng.range(0, S), 2, 2);
      }
    } else {
      g.fillStyle = '#c8c8d8'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#7a7a90';
      g.fillRect(0, 0, 4, S); g.fillRect(S / 2, 0, 4, S);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(6, 0, 10, S); g.fillRect(S / 2 + 6, 0, 10, S);
      for (let i = 0; i < 8; i++) {
        g.fillStyle = '#9a9ab0';
        g.beginPath(); g.arc(S / 4 + (i % 2) * S / 2, (i * 37) % S + 10, 3, 0, TAU); g.fill();
      }
    }
  }));
}

function makeGlowTexture(T) {
  return T.t(canvasTex(128, (g, S) => {
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }, { repeat: false }));
}

function makeChevronTexture(T) {
  return T.t(canvasTex(128, (g, S) => {
    g.clearRect(0, 0, S, S);
    g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = 13;
    for (const ox of [30, 66]) {
      g.globalAlpha = ox === 30 ? 0.6 : 1;
      g.beginPath(); g.moveTo(ox, 28); g.lineTo(ox + 30, 64); g.lineTo(ox, 100); g.stroke();
    }
    g.globalAlpha = 1;
  }, { repeat: false }));
}

function makeSpriteTexture(kind, T) {
  return T.t(canvasTex(64, (g, S) => {
    if (kind === 'leaf') {
      g.fillStyle = '#fff';
      g.beginPath(); g.ellipse(S / 2, S / 2, S * 0.42, S * 0.2, 0.7, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(S * 0.2, S * 0.75); g.lineTo(S * 0.8, S * 0.25); g.stroke();
    } else {
      const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(kind === 'snow' ? 0.5 : 0.25, 'rgba(255,255,255,0.8)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }
  }, { repeat: false }));
}

// Make a MeshStandardMaterial's emissive get multiplied by vertex / instance color.
function emissiveByColor(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )\n\ttotalEmissiveRadiance *= vColor.rgb;\n#endif'
    );
  };
  mat.customProgramCacheKey = () => 'emissiveByColor';
  return mat;
}

// Merge geometries (position + normal [+ color]) into one non-indexed geometry. Disposes inputs.
function mergeGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const p of parts) total += p.attributes.position.count;
  const hasColor = parts.every((p) => p.attributes.color);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  const col = hasColor ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const p of parts) {
    if (!p.attributes.normal) p.computeVertexNormals();
    pos.set(p.attributes.position.array, o * 3);
    nor.set(p.attributes.normal.array, o * 3);
    if (col) col.set(p.attributes.color.array, o * 3);
    o += p.attributes.position.count;
  }
  for (const g of geos) g.dispose();
  for (const p of parts) p.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function place(geo, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz)
  );
  geo.applyMatrix4(m);
  return geo;
}

function paint(geo, color) {
  const n = geo.attributes.position.count, c = new THREE.Color(color), arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function makeInstanced(geo, mat, items, { cast = false, receive = false } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
  mesh.count = items.length;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    p.set(it.x, it.y || 0, it.z);
    e.set(it.rx || 0, it.ry || 0, it.rz || 0);
    q.setFromEuler(e);
    s.set(it.sx ?? it.s ?? 1, it.sy ?? it.s ?? 1, it.sz ?? it.s ?? 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    if (it.color) mesh.setColorAt(i, it.color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

// ---------------------------------------------------------------- swept wall geometry

function linePath(ax, az, bx, bz, segLen) {
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / segLen));
  const tx = (bx - ax) / L, tz = (bz - az) / L, pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push({ x: ax + (bx - ax) * f, z: az + (bz - az) * f, tx, tz, s: L * f });
  }
  return pts;
}

// Sweep a CCW (u right/outward, y up) profile along a path. Profile closing edge (last->first)
// is the bottom and is skipped. End caps are fans. Side normal N = (tz, -tx), so T = N x Y.
function sweep(buf, path, profile, colorFn, uvs, caps = true) {
  const P = profile.length;
  const plen = [0];
  for (let k = 1; k < P; k++) plen.push(plen[k - 1] + Math.hypot(profile[k].u - profile[k - 1].u, profile[k].y - profile[k - 1].y));
  const col = new THREE.Color();
  const push = (x, y, z, nx, ny, nz, u, v) => {
    buf.p.push(x, y, z); buf.n.push(nx, ny, nz); buf.uv.push(u, v);
    colorFn(x, y, z, col); buf.c.push(col.r, col.g, col.b);
  };
  const vert = (pt, k, nu, ny) => {
    const nx = pt.tz, nz = -pt.tx, pr = profile[k];
    push(pt.x + nx * pr.u, pr.y, pt.z + nz * pr.u, nx * nu, ny, nz * nu, pt.s * uvs, plen[k] * uvs);
  };
  for (let k = 0; k < P - 1; k++) {
    const du = profile[k + 1].u - profile[k].u, dy = profile[k + 1].y - profile[k].y, L = Math.hypot(du, dy) || 1;
    const nu = dy / L, ny = -du / L;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      // A=(a,k) B=(b,k) C=(b,k+1) D=(a,k+1); winding A,C,B / A,D,C
      vert(a, k, nu, ny); vert(b, k + 1, nu, ny); vert(b, k, nu, ny);
      vert(a, k, nu, ny); vert(a, k + 1, nu, ny); vert(b, k + 1, nu, ny);
    }
  }
  if (!caps) return;
  const capAt = (pt, sign) => {
    const nx = pt.tz, nz = -pt.tx;
    const V = (k) => {
      const pr = profile[k];
      push(pt.x + nx * pr.u, pr.y, pt.z + nz * pr.u, pt.tx * sign, 0, pt.tz * sign, pr.u * uvs, pr.y * uvs);
    };
    for (let k = 1; k < P - 1; k++) {
      if (sign > 0) { V(0); V(k); V(k + 1); } else { V(0); V(k + 1); V(k); }
    }
  };
  capAt(path[0], -1);
  capAt(path[path.length - 1], 1);
}

function bufToGeo(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.c, 3));
  g.computeBoundingSphere();
  return g;
}

function roundedProfile(hw, base, h, steps) {
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const phi = (k / steps) * Math.PI;
    // squircle-ish: flatter top
    const c = Math.cos(phi), s = Math.sin(phi);
    pts.push({ u: hw * Math.sign(c) * Math.pow(Math.abs(c), 0.8), y: base + h * Math.pow(s, 0.7) });
  }
  return pts;
}

function buildWalls(levelData, theme, T) {
  const H = CFG.WALL_HEIGHT, t = CFG.WALL_THICKNESS, ht = t / 2;
  const style = theme.wallStyle;
  let body, cap;
  if (style === 'stone') {
    body = [{ u: ht + 0.05, y: 0 }, { u: ht, y: H }, { u: -ht, y: H }, { u: -ht - 0.05, y: 0 }];
    cap = roundedProfile(ht + 0.13, H - 0.1, 0.34, 8);
  } else if (style === 'neon') {
    body = [{ u: ht, y: 0 }, { u: ht, y: H }, { u: -ht, y: H }, { u: -ht, y: 0 }];
    cap = [{ u: ht * 0.45, y: H - 0.01 }, { u: ht * 0.45, y: H + 0.07 }, { u: -ht * 0.45, y: H + 0.07 }, { u: -ht * 0.45, y: H - 0.01 }];
  } else {
    body = [{ u: ht, y: 0 }, { u: ht, y: H }, { u: -ht, y: H }, { u: -ht, y: 0 }];
    cap = roundedProfile(ht + 0.08, H - 0.12, 0.3, 6);
  }

  const wallC = new THREE.Color(theme.wall), topC = new THREE.Color(theme.wallTop), accC = new THREE.Color(theme.accent);
  const aoStrength = style === 'stone' ? 0.35 : style === 'neon' ? 0.3 : 0.5;
  const bodyColor = (x, y, z, out) => {
    const n = vnoise(x * 0.7 + y * 0.6, z * 0.7 - y * 0.8), n2 = vnoise(x * 2.7 + 13.1, z * 2.7 + y * 2.1);
    const f = 0.8 + 0.28 * n + 0.12 * n2;
    const ao = 1 - aoStrength + aoStrength * Math.min(1, y / (H * 0.85));
    out.copy(wallC).multiplyScalar(f * ao);
  };
  const capColor = style === 'neon'
    ? (x, y, z, out) => {
      const a = Math.atan2(z, x), r = Math.hypot(x, z);
      const k = 0.5 + 0.5 * Math.sin(a * 2 + r * 0.25);
      out.copy(topC).lerp(accC, k);
    }
    : (x, y, z, out) => {
      const n = vnoise(x * 1.3 + 5.1, z * 1.3 - 2.7);
      out.copy(topC).multiplyScalar((style === 'stone' ? 0.94 : 0.82) + 0.16 * n);
    };

  const bb = { p: [], n: [], uv: [], c: [] }, cb = { p: [], n: [], uv: [], c: [] };
  const SEG = 0.6, UVS = 1 / 1.6;
  for (const w of levelData.walls) {
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1;
    const ex = ((w.bx - w.ax) / L) * ht, ez = ((w.bz - w.az) / L) * ht;
    const path = linePath(w.ax - ex, w.az - ez, w.bx + ex, w.bz + ez, SEG);
    sweep(bb, path, body, bodyColor, UVS);
    sweep(cb, path, cap, capColor, UVS);
  }

  const wallTex = makeWallTexture(style, T);
  const bodyMat = T.m(new THREE.MeshStandardMaterial({ map: wallTex, vertexColors: true, roughness: style === 'neon' ? 0.55 : 0.92, metalness: style === 'neon' ? 0.2 : 0 }));
  let capMat;
  if (style === 'neon') {
    capMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.85, roughness: 0.4 })));
  } else if (style === 'stone') {
    capMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));
  } else {
    capMat = T.m(new THREE.MeshStandardMaterial({ map: wallTex, vertexColors: true, roughness: 0.9 }));
  }
  const bodyMesh = new THREE.Mesh(T.g(bufToGeo(bb)), bodyMat);
  bodyMesh.castShadow = bodyMesh.receiveShadow = true;
  const capMesh = new THREE.Mesh(T.g(bufToGeo(cb)), capMat);
  capMesh.castShadow = style !== 'neon';
  capMesh.receiveShadow = true;
  return [bodyMesh, capMesh];
}

// ---------------------------------------------------------------- floors

function buildFloors(levelData, theme, T) {
  const W = levelData.corridorWidth, legs = levelData.legs, rh = levelData.roomHalf;
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const UVS = 1 / 3.5;
  // Quad grid: `us` across (with edge-darkening factors), two rows along.
  const addStrip = (ox, oz, ax, az, bx, bz, s0, s1, us, factors, color, y = 0) => {
    const base = pos.length / 3, c = new THREE.Color(color);
    for (const sv of [s0, s1]) {
      for (let k = 0; k < us.length; k++) {
        const x = ox + ax * sv + bx * us[k], z = oz + az * sv + bz * us[k];
        pos.push(x, y, z); nor.push(0, 1, 0); uv.push(x * UVS, z * UVS);
        const f = factors[k];
        col.push(c.r * f, c.g * f, c.b * f);
      }
    }
    const n = us.length;
    for (let k = 0; k < n - 1; k++) {
      const A = base + k, B = A + 1, C = A + n, D = C + 1;
      // keep triangles facing up whatever the frame handedness
      const cross = ax * bz - az * bx;
      if (cross > 0) idx.push(A, B, C, B, D, C); else idx.push(A, C, B, B, C, D);
    }
  };
  const h = W / 2;
  const across = [-h, -h + 0.25, -h + 0.9, h - 0.9, h - 0.25, h];
  const edge = [0.62, 0.78, 1, 1, 0.78, 0.62];
  legs.forEach((l, i) => {
    // each leg owns the corner square at its far end (s = len); the innermost leg also owns its start
    const s0 = i === legs.length - 1 ? -h : h;
    addStrip(l.ox, l.oz, l.ux, l.uz, l.nx, l.nz, s0, l.len + h, across, edge, l.loop % 2 ? theme.groundAlt : theme.ground);
  });
  // goal room
  addStrip(0, 0, 1, 0, 0, 1, -rh, rh, [-rh, -rh + 0.25, -rh + 0.9, rh - 0.9, rh - 0.25, rh], edge, theme.ground);
  // the outside: a big ground plane slightly below the corridors
  const big = levelData.outerRadius + 150;
  addStrip(0, 0, 1, 0, 0, 1, -big, big, [-big, big], [1, 1], theme.outerGround, -0.03);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  T.g(g);

  const { map, emissiveMap } = makeFloorTextures(theme.floorStyle, T);
  const opts = { map, vertexColors: true, roughness: 0.95, metalness: 0 };
  if (theme.floorStyle === 'snow') Object.assign(opts, { emissiveMap, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.8 });
  if (theme.floorStyle === 'neon') Object.assign(opts, { emissiveMap, emissive: theme.accent, emissiveIntensity: 0.16, roughness: 0.6, metalness: 0.15 });
  const floor = new THREE.Mesh(g, T.m(new THREE.MeshStandardMaterial(opts)));
  floor.receiveShadow = true;

  // center plaza
  const pg = T.g(new THREE.CircleGeometry(levelData.centerRadius + 0.05, 72));
  pg.rotateX(-Math.PI / 2);
  const pmOpts = { map: makePlazaTexture(T), color: theme.plaza, roughness: 0.85 };
  const plaza = new THREE.Mesh(pg, T.m(new THREE.MeshStandardMaterial(pmOpts)));
  plaza.position.y = 0.005;
  plaza.receiveShadow = true;

  // safe corners: wolves never enter these squares
  const size = levelData.corridorWidth - CFG.WALL_THICKNESS;
  const tp = [], tn = [], tuv = [], ti = [];
  for (const c of levelData.safeCorners) {
    const b = tp.length / 3, h = size / 2;
    tp.push(c.x - h, 0.012, c.z - h, c.x + h, 0.012, c.z - h, c.x - h, 0.012, c.z + h, c.x + h, 0.012, c.z + h);
    tn.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    tuv.push(0, 1, 1, 1, 0, 0, 1, 0);
    ti.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
  tg.setAttribute('normal', new THREE.Float32BufferAttribute(tn, 3));
  tg.setAttribute('uv', new THREE.Float32BufferAttribute(tuv, 2));
  tg.setIndex(ti);
  const tiles = new THREE.Mesh(T.g(tg), T.m(new THREE.MeshStandardMaterial({ map: makeSafeTileTexture(T), color: theme.plaza, roughness: 0.85 })));
  tiles.receiveShadow = true;
  const out = [floor, plaza, tiles];
  if (levelData.ice) out.push(buildIce(levelData, T));
  return out;
}

// Glossy ice sheet over every corridor (under the safe tiles; the goal room stays snow).
function buildIce(levelData, T) {
  const rng = createRng(777);
  const S = 512;
  const map = T.t(canvasTex(S, (g) => {
    g.fillStyle = '#cfeaff'; g.fillRect(0, 0, S, S);
    blotches(g, S, rng, 40, 50, 140, [255, 255, 255, 0.22], [90, 150, 210, 0.16]);
    g.lineCap = 'round';
    // skate scratches: long faint arcs
    for (let i = 0; i < 70; i++) {
      const x = rng.range(0, S), y = rng.range(0, S), r = rng.range(60, 260), a = rng.range(0, TAU), sweep = rng.range(0.15, 0.5);
      g.strokeStyle = `rgba(255,255,255,${rng.range(0.25, 0.55)})`; g.lineWidth = rng.range(0.8, 1.8);
      wrapDraw(S, x, y, r + 4, (px, py) => { g.beginPath(); g.arc(px, py, r, a, a + sweep); g.stroke(); });
    }
    // cracks: short jagged dark-blue polylines
    for (let i = 0; i < 18; i++) {
      let x = rng.range(0, S), y = rng.range(0, S), a = rng.range(0, TAU);
      const pts = [[x, y]];
      for (let k = 0; k < 6; k++) { a += rng.range(-0.8, 0.8); x += Math.cos(a) * rng.range(8, 22); y += Math.sin(a) * rng.range(8, 22); pts.push([x, y]); }
      g.strokeStyle = `rgba(70,120,180,${rng.range(0.25, 0.45)})`; g.lineWidth = rng.range(0.8, 1.6);
      wrapDraw(S, pts[0][0], pts[0][1], 140, (px, py) => {
        const ox = px - pts[0][0], oy = py - pts[0][1];
        g.beginPath(); g.moveTo(px, py); for (const [qx, qy] of pts) g.lineTo(qx + ox, qy + oy); g.stroke();
      });
    }
  }));
  const W = levelData.corridorWidth, h = W / 2 - CFG.WALL_THICKNESS / 2, UVS = 1 / 9;
  const pos = [], uv = [], idx = [];
  levelData.legs.forEach((l, i) => {
    // leg i runs from corner i+1 (s=0) to corner i (s=len). Butt up against safe tiles instead of running under
    // them (no flicker); an unsafe corner at s=len is iced by this leg, and the last leg also ices its s=0 door corner.
    const endSafe = i < levelData.safeCorners.length;
    const s0 = i === levelData.legs.length - 1 ? -h : h, s1 = endSafe ? l.len - h : l.len + h;
    const b = pos.length / 3;
    for (const [sv, v] of [[s0, -h], [s0, h], [s1, -h], [s1, h]]) {
      const x = l.ox + l.ux * sv + l.nx * v, z = l.oz + l.uz * sv + l.nz * v;
      pos.push(x, 0.004, z); uv.push(x * UVS, z * UVS);
    }
    if (l.ux * l.nz - l.uz * l.nx > 0) idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); else idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const mat = new THREE.MeshStandardMaterial({
    map, color: 0xd6efff, transparent: true, opacity: 0.82, roughness: 1, metalness: 0, // matte: no sun glare
    emissive: 0x5aa8f0, emissiveIntensity: 0.12, depthWrite: false,
  });
  const ice = new THREE.Mesh(T.g(g), T.m(mat));
  ice.receiveShadow = true;
  return ice;
}

// ---------------------------------------------------------------- lanterns + chevrons

function buildLanterns(levelData, theme, T, rng) {
  const H = CFG.WALL_HEIGHT;
  const spots = levelData.wallCorners.map((p) => ({ x: p.x, z: p.z }));
  // extra lanterns along the outermost loop (last 4 arms + cap)
  for (const w of levelData.walls.slice(-6)) {
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az), n = Math.floor(L / 9);
    for (let k = 1; k < n; k++) spots.push({ x: w.ax + (w.bx - w.ax) * k / n, z: w.az + (w.bz - w.az) * k / n });
  }

  const PH = H + 0.25;
  const pillarGeo = T.g(mergeGeos([
    place(new THREE.BoxGeometry(0.76, 0.18, 0.76), 0, 0.09, 0),
    place(new THREE.BoxGeometry(0.6, PH, 0.6), 0, PH / 2, 0),
    place(new THREE.BoxGeometry(0.74, 0.12, 0.74), 0, PH + 0.02, 0),
    place(new THREE.CylinderGeometry(0.2, 0.12, 0.14, 8), 0, PH + 0.14, 0),
  ]));
  const orbGeo = T.g(new THREE.IcosahedronGeometry(0.21, 2));
  const glowGeo = T.g(new THREE.PlaneGeometry(1, 1)); glowGeo.rotateX(-Math.PI / 2);

  const pillarItems = [], orbItems = [], glowItems = [];
  const pc = new THREE.Color(theme.pillar);
  for (const sp of spots) {
    const { x, z } = sp;
    pillarItems.push({ x, z, ry: 0, color: pc.clone().multiplyScalar(rng.range(0.9, 1.08)) });
    orbItems.push({ x, z, y: PH + 0.36, color: new THREE.Color(1, 1, 1) });
    glowItems.push({ x, z, y: 0.03, s: 4.2, color: new THREE.Color(1, 1, 1) });
  }
  const pillarMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }));
  const orbMat = T.m(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const glowTex = makeGlowTexture(T);
  const glowMat = T.m(new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }));

  const pillars = makeInstanced(pillarGeo, pillarMat, pillarItems, { cast: true, receive: true });
  const orbs = makeInstanced(orbGeo, orbMat, orbItems);
  const glows = makeInstanced(glowGeo, glowMat, glowItems);
  glows.renderOrder = 1;

  const phases = spots.map(() => rng.range(0, 10));
  const lampC = new THREE.Color(theme.lamp);
  const tmp = new THREE.Color();
  const update = (time) => {
    for (let i = 0; i < spots.length; i++) {
      const ph = phases[i];
      const f = 0.86 + 0.08 * Math.sin(time * 6.3 + ph * 7) + 0.06 * Math.sin(time * 17.1 + ph * 13);
      tmp.copy(lampC).multiplyScalar(theme.lampBoost * f);
      orbs.setColorAt(i, tmp);
      tmp.copy(lampC).multiplyScalar(theme.glowK * f);
      glows.setColorAt(i, tmp);
    }
    if (orbs.instanceColor) orbs.instanceColor.needsUpdate = true;
    if (glows.instanceColor) glows.instanceColor.needsUpdate = true;
  };
  update(0);

  // chevrons: in each corridor corner, pointing the way on
  const chevGeo = T.g(new THREE.PlaneGeometry(1.5, 1.5)); chevGeo.rotateX(-Math.PI / 2);
  const chevItems = [];
  const cs = levelData.corners;
  for (let k = 1; k < cs.length - 1; k++) {
    const dx = cs[k + 1].x - cs[k].x, dz = cs[k + 1].z - cs[k].z;
    chevItems.push({ x: cs[k].x, z: cs[k].z, y: 0.02, ry: -Math.atan2(dz, dx) });
  }
  const chevMat = T.m(new THREE.MeshBasicMaterial({
    map: makeChevronTexture(T), color: new THREE.Color(theme.chevron).multiplyScalar(theme.wallStyle === 'neon' ? 1.6 : 1),
    transparent: true, opacity: theme.chevronOpacity, depthWrite: false, fog: true,
  }));
  const chevrons = makeInstanced(chevGeo, chevMat, chevItems);
  chevrons.renderOrder = 1;
  const chevUpdate = (time) => { chevMat.opacity = theme.chevronOpacity * (0.75 + 0.25 * Math.sin(time * 2.4)); };

  return { meshes: [pillars, orbs, glows, chevrons], update: (time) => { update(time); chevUpdate(time); } };
}

// ---------------------------------------------------------------- decor

function buildDecor(levelData, theme, ti, T, rng) {
  const W = levelData.corridorWidth, rh = levelData.roomHalf;
  const meshes = [];
  // bounding box of the walls
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const w of levelData.walls) {
    x0 = Math.min(x0, w.ax, w.bx); x1 = Math.max(x1, w.ax, w.bx);
    z0 = Math.min(z0, w.az, w.bz); z1 = Math.max(z1, w.az, w.bz);
  }
  const Rn = Math.max(x1 - x0, z1 - z0) / 2;      // for perimeter-ish counts

  const sampleCorridor = (margin) => {
    for (let tries = 0; tries < 24; tries++) {
      const x = rng.range(x0, x1), z = rng.range(z0, z1);
      if (locate(levelData, x, z).leg < 0) continue;
      if (collideCircle(levelData, x, z, margin).hit) continue;
      return { x, z, r: Math.hypot(x, z), a: Math.atan2(z, x) };
    }
    return null;
  };
  // points outside the spiral, between `lo` and `hi` units beyond its outer walls
  const sampleOuter = (lo, hi) => {
    for (let tries = 0; tries < 40; tries++) {
      const x = rng.range(x0 - hi, x1 + hi), z = rng.range(z0 - hi, z1 + hi);
      if (Math.max(x0 - x, x - x1, z0 - z, z - z1) > hi) continue;
      if (locate(levelData, x, z).leg !== -2) continue;
      if (collideCircle(levelData, x, z, Math.max(0.05, lo - CFG.WALL_THICKNESS / 2)).hit) continue;
      return { x, z, r: Math.hypot(x, z), a: Math.atan2(z, x) };
    }
    return { x: x1 + hi, z: z1 + hi, r: 0, a: 0 };
  };
  const corridorArea = levelData.legs.reduce((a, l) => a + l.len * W, 0) + 4 * rh * rh;
  const outerArea = (x1 - x0 + 52) * (z1 - z0 + 52) - (x1 - x0 + 5) * (z1 - z0 + 5);
  const jitterColor = (hex, b = 0.12) => new THREE.Color(hex).multiplyScalar(rng.range(1 - b, 1 + b));

  // ---- trees
  const pine = ti === 2;
  const trunkGeo = T.g(place(new THREE.CylinderGeometry(0.13, 0.2, pine ? 1.0 : 1.6, 6), 0, pine ? 0.5 : 0.8, 0));
  const crownGeo = T.g(pine
    ? mergeGeos([
      place(new THREE.ConeGeometry(1.05, 1.3, 7), 0, 1.3, 0),
      place(new THREE.ConeGeometry(0.82, 1.1, 7), 0, 2.0, 0, 1, 1, 1, 0, 0.4, 0),
      place(new THREE.ConeGeometry(0.56, 0.9, 7), 0, 2.65, 0, 1, 1, 1, 0, 0.8, 0),
    ])
    : mergeGeos([
      place(new THREE.IcosahedronGeometry(0.95, 1), 0, 2.0, 0),
      place(new THREE.IcosahedronGeometry(0.72, 1), 0.6, 1.7, 0.25),
      place(new THREE.IcosahedronGeometry(0.66, 1), -0.5, 1.75, -0.3),
      place(new THREE.IcosahedronGeometry(0.6, 1), 0.1, 2.55, 0.1),
    ]));
  const trunkMat = T.m(new THREE.MeshStandardMaterial({ color: theme.trunk, roughness: 1, flatShading: true }));
  const crownMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }));
  if (theme.crownEmissive > 0) { crownMat.emissive.set(0xffffff); crownMat.emissiveIntensity = theme.crownEmissive; emissiveByColor(crownMat); }
  const trees = [];
  const nTrees = Math.round(outerArea * 0.017);
  for (let i = 0; i < nTrees; i++) {
    const p = sampleOuter(2.8, 26), s = rng.range(0.8, 1.55);
    trees.push({ x: p.x, z: p.z, s, ry: rng.range(0, TAU), color: jitterColor(rng.pick(theme.crowns)) });
  }
  meshes.push(makeInstanced(trunkGeo, trunkMat, trees.map((t) => ({ ...t, color: null })), { cast: true }));
  meshes.push(makeInstanced(crownGeo, crownMat, trees, { cast: true, receive: true }));

  // ---- bushes (hug the outer wall + scattered)
  const bushGeo = T.g(mergeGeos([
    place(new THREE.IcosahedronGeometry(0.5, 1), 0, 0.32, 0),
    place(new THREE.IcosahedronGeometry(0.38, 1), 0.42, 0.25, 0.1),
    place(new THREE.IcosahedronGeometry(0.36, 1), -0.38, 0.24, -0.12),
  ]));
  const bushMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
  if (theme.crownEmissive > 0) { bushMat.emissive.set(0xffffff); bushMat.emissiveIntensity = theme.crownEmissive; emissiveByColor(bushMat); }
  const bushes = [];
  for (const w of levelData.walls.slice(-6, -2)) {
    // outer side of the outermost arms = away from the centre
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az), ux = (w.bx - w.ax) / L, uz = (w.bz - w.az) / L;
    const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
    let nx = uz, nz = -ux;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    for (let d = 0.5; d < L; d += 2.6) {
      if (rng.chance(0.3)) continue;
      const off = CFG.WALL_THICKNESS / 2 + rng.range(0.45, 1.0);
      const x = w.ax + ux * d + nx * off, z = w.az + uz * d + nz * off;
      if (locate(levelData, x, z).leg !== -2) continue;
      bushes.push({ x, z, s: rng.range(0.8, 1.3), ry: rng.range(0, TAU), color: jitterColor(rng.pick(theme.crowns), 0.18).multiplyScalar(0.85) });
    }
  }
  const nBush = Math.round(outerArea * 0.008);
  for (let i = 0; i < nBush; i++) {
    const p = sampleOuter(2, 26);
    bushes.push({ x: p.x, z: p.z, s: rng.range(0.7, 1.4), ry: rng.range(0, TAU), color: jitterColor(rng.pick(theme.crowns), 0.18) });
  }
  meshes.push(makeInstanced(bushGeo, bushMat, bushes, { cast: true, receive: true }));

  // ---- rocks
  const rockGeo = T.g(new THREE.DodecahedronGeometry(0.5, 0));
  const rockMat = T.m(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }));
  const rocks = [];
  const nRocks = Math.round(outerArea * 0.006);
  for (let i = 0; i < nRocks; i++) {
    const p = sampleOuter(2, 26), s = rng.range(0.5, 1.6);
    rocks.push({ x: p.x, z: p.z, y: 0.12 * s, sx: s * rng.range(0.8, 1.3), sy: s * rng.range(0.45, 0.8), sz: s, ry: rng.range(0, TAU), rx: rng.range(-0.2, 0.2), color: jitterColor(theme.rock, 0.12) });
  }
  // pebbles in corridors (same mesh)
  const nPeb = Math.round(corridorArea * 0.025);
  for (let i = 0; i < nPeb; i++) {
    const p = sampleCorridor(0.4); if (!p) continue;
    const s = rng.range(0.12, 0.26);
    rocks.push({ x: p.x, z: p.z, y: 0.03, sx: s * 1.3, sy: s * 0.5, sz: s, ry: rng.range(0, TAU), color: jitterColor(theme.rock, 0.15) });
  }
  meshes.push(makeInstanced(rockGeo, rockMat, rocks, { cast: true, receive: true }));

  // ---- grass tufts (not in snow)
  if (ti !== 2) {
    const blades = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      blades.push(place(new THREE.ConeGeometry(0.05, 0.38, 3), Math.cos(a) * 0.06, 0.17, Math.sin(a) * 0.06, 1, rng.range(0.7, 1.2), 1, Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35));
    }
    const tuftGeo = T.g(mergeGeos(blades));
    const tuftMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
    const tufts = [];
    const nIn = Math.round(corridorArea * 0.07), nOut = Math.round(outerArea * 0.03);
    for (let i = 0; i < nIn; i++) {
      const p = sampleCorridor(0.3); if (!p) continue;
      tufts.push({ x: p.x, z: p.z, s: rng.range(0.7, 1.3), ry: rng.range(0, TAU), color: jitterColor(theme.tuft, 0.18) });
    }
    for (let i = 0; i < nOut; i++) {
      const p = sampleOuter(1.2, 26);
      tufts.push({ x: p.x, z: p.z, s: rng.range(0.9, 1.6), ry: rng.range(0, TAU), color: jitterColor(theme.tuft, 0.18) });
    }
    meshes.push(makeInstanced(tuftGeo, tuftMat, tufts));
  }

  // ---- theme-specific small things in corridors
  const clusters = (count, per, spread, margin, make) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const p = sampleCorridor(margin); if (!p) continue;
      const n = rng.int(per[0], per[1]);
      for (let k = 0; k < n; k++) out.push(make(p.x + rng.range(-spread, spread), p.z + rng.range(-spread, spread)));
    }
    return out;
  };

  if (ti === 0) {
    const petals = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU;
      petals.push(place(new THREE.OctahedronGeometry(0.075, 0), Math.cos(a) * 0.08, 0.1, Math.sin(a) * 0.08, 1, 0.35, 0.65, 0, -a, 0));
    }
    petals.push(paint(place(new THREE.OctahedronGeometry(0.055, 0), 0, 0.12, 0, 1, 0.6, 1), 0xffd040));
    for (let k = 0; k < 5; k++) paint(petals[k], 0xffffff);
    const flowerGeo = T.g(mergeGeos(petals));
    const flowerMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, flatShading: true }));
    const flowers = clusters(Math.round(corridorArea * 0.035), [2, 5], 0.45, 0.6, (x, z) => ({ x, z, s: rng.range(0.9, 1.4), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) }));
    // a few around the outside too
    for (let i = 0; i < outerArea * 0.02; i++) {
      const p = sampleOuter(1.2, 20);
      flowers.push({ x: p.x, z: p.z, s: rng.range(1, 1.6), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) });
    }
    meshes.push(makeInstanced(flowerGeo, flowerMat, flowers));
  } else if (ti === 1) {
    const leafShape = new THREE.Shape();
    leafShape.moveTo(-0.5, 0); leafShape.quadraticCurveTo(0, 0.32, 0.5, 0); leafShape.quadraticCurveTo(0, -0.32, -0.5, 0);
    const leafGeo = T.g(new THREE.ShapeGeometry(leafShape, 3)); leafGeo.rotateX(-Math.PI / 2);
    const leafMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide }));
    const leaves = clusters(Math.round(corridorArea * 0.06), [3, 7], 0.8, 0.5, (x, z) => ({ x, z, y: 0.015 + rng.range(0, 0.02), s: rng.range(0.22, 0.38), ry: rng.range(0, TAU), rx: rng.range(-0.15, 0.15), color: jitterColor(rng.pick(theme.smalls), 0.15) }));
    for (let i = 0; i < outerArea * 0.12; i++) {
      const p = sampleOuter(1, 26);
      leaves.push({ x: p.x, z: p.z, y: 0.02, s: rng.range(0.25, 0.42), ry: rng.range(0, TAU), color: jitterColor(rng.pick(theme.smalls), 0.15) });
    }
    meshes.push(makeInstanced(leafGeo, leafMat, leaves));
    // pumpkins outside (cute)
    const pumpGeo = T.g(mergeGeos([
      paint(place(new THREE.SphereGeometry(0.4, 10, 6), 0, 0.3, 0, 1, 0.75, 1), 0xffffff),
      paint(place(new THREE.CylinderGeometry(0.04, 0.06, 0.18, 5), 0, 0.62, 0), 0x3b5a20),
    ]));
    const pumpMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true }));
    const pumps = [];
    for (let i = 0; i < Math.round(8 * Rn / 7); i++) {
      const p = sampleOuter(1.0, 6);
      pumps.push({ x: p.x, z: p.z, s: rng.range(0.6, 1.2), ry: rng.range(0, TAU), color: jitterColor(0xf08a24, 0.1) });
    }
    meshes.push(makeInstanced(pumpGeo, pumpMat, pumps, { cast: true }));
  } else if (ti === 2) {
    const moundGeo = T.g(new THREE.IcosahedronGeometry(0.5, 1));
    const moundMat = T.m(new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.8, flatShading: true }));
    const mounds = [];
    for (let i = 0; i < corridorArea * 0.025; i++) {
      const p = sampleCorridor(0.6); if (!p) continue;
      const s = rng.range(0.4, 0.9);
      mounds.push({ x: p.x, z: p.z, y: -0.1 * s, sx: s * 1.4, sy: s * 0.35, sz: s });
    }
    for (let i = 0; i < outerArea * 0.02; i++) {
      const p = sampleOuter(1.2, 26), s = rng.range(0.8, 2.2);
      mounds.push({ x: p.x, z: p.z, y: -0.15 * s, sx: s * 1.5, sy: s * 0.45, sz: s * 1.1, ry: rng.range(0, TAU) });
    }
    meshes.push(makeInstanced(moundGeo, moundMat, mounds, { receive: true }));
    // ice crystals (faintly glowing)
    const crysGeo = T.g(place(new THREE.OctahedronGeometry(0.12, 0), 0, 0.12, 0, 1, 1.8, 1));
    const crysMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: 0.35 })));
    const crys = clusters(Math.round(corridorArea * 0.012), [2, 4], 0.25, 0.5, (x, z) => ({ x, z, s: rng.range(0.7, 1.4), ry: rng.range(0, TAU), rz: rng.range(-0.3, 0.3), color: new THREE.Color(rng.pick(theme.smalls)) }));
    meshes.push(makeInstanced(crysGeo, crysMat, crys));
    // snowmen outside
    const smGeo = T.g(mergeGeos([
      paint(place(new THREE.IcosahedronGeometry(0.55, 1), 0, 0.5, 0), 0xffffff),
      paint(place(new THREE.IcosahedronGeometry(0.4, 1), 0, 1.15, 0), 0xffffff),
      paint(place(new THREE.IcosahedronGeometry(0.28, 1), 0, 1.65, 0), 0xffffff),
      paint(place(new THREE.ConeGeometry(0.06, 0.3, 5), 0.38, 1.66, 0, 1, 1, 1, 0, 0, -Math.PI / 2), 0xff8a2a),
      paint(place(new THREE.CylinderGeometry(0.2, 0.22, 0.25, 8), 0, 1.98, 0), 0x2a2a3a),
    ]));
    const smMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true }));
    const sms = [];
    for (let i = 0; i < Math.max(4, Math.round(8 * Rn / 20)); i++) {
      const p = sampleOuter(1.5, 8);
      sms.push({ x: p.x, z: p.z, s: rng.range(0.8, 1.1), ry: -p.a + Math.PI + rng.range(-0.5, 0.5) });
    }
    meshes.push(makeInstanced(smGeo, smMat, sms, { cast: true }));
  } else {
    // neon: glowing mushrooms in corridors and outside, crystals outside
    const mushGeo = T.g(mergeGeos([
      paint(place(new THREE.CylinderGeometry(0.035, 0.05, 0.16, 5), 0, 0.08, 0), 0x777799),
      paint(place(new THREE.SphereGeometry(0.13, 8, 4, 0, TAU, 0, Math.PI / 2), 0, 0.15, 0, 1, 0.7, 1), 0xffffff),
    ]));
    const mushMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.9 })));
    const mush = clusters(Math.round(corridorArea * 0.02), [2, 5], 0.4, 0.6, (x, z) => ({ x, z, s: rng.range(0.7, 1.5), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) }));
    for (let i = 0; i < outerArea * 0.03; i++) {
      const p = sampleOuter(1, 26);
      mush.push({ x: p.x, z: p.z, s: rng.range(1.2, 2.8), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) });
    }
    meshes.push(makeInstanced(mushGeo, mushMat, mush));
    const crysGeo = T.g(place(new THREE.OctahedronGeometry(0.35, 0), 0, 0.6, 0, 0.7, 2.2, 0.7));
    const crysMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.2, emissive: 0xffffff, emissiveIntensity: 1.6 })));
    const crys = [];
    for (let i = 0; i < outerArea * 0.006; i++) {
      const p = sampleOuter(2, 26), n = rng.int(2, 4);
      for (let k = 0; k < n; k++) {
        crys.push({ x: p.x + rng.range(-0.6, 0.6), z: p.z + rng.range(-0.6, 0.6), s: rng.range(0.6, 1.4), ry: rng.range(0, TAU), rx: rng.range(-0.35, 0.35), rz: rng.range(-0.35, 0.35), color: new THREE.Color(rng.pick([theme.accent, theme.wallTop, 0xb68cff])) });
      }
    }
    meshes.push(makeInstanced(crysGeo, crysMat, crys, { cast: true }));
  }
  return meshes;
}

// ---------------------------------------------------------------- particles

function buildParticles(theme, rng, radius, T) {
  const kind = theme.particles;
  const area = Math.PI * radius * radius;
  const count = Math.round(clamp(area * 0.1, 300, 1300) * QUALITY.particles);
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  const base = new Float32Array(count * 5); // bx, bz, by, phase, speed
  const c = new THREE.Color();
  let palette, H, size, additive, sprite;
  if (kind === 'pollen') { palette = [0xfff6c0, 0xffffff, 0xfff0a0]; H = 4; size = 0.16; additive = true; sprite = 'dot'; }
  else if (kind === 'leaves') { palette = theme.crowns; H = 11; size = 0.42; additive = false; sprite = 'leaf'; }
  else if (kind === 'snow') { palette = [0xffffff, 0xf0f6ff]; H = 12; size = 0.2; additive = false; sprite = 'snow'; }
  else { palette = [theme.accent, theme.wallTop, 0xb68cff]; H = 7; size = 0.26; additive = true; sprite = 'dot'; }
  const bright = kind === 'motes' ? 1.8 : kind === 'pollen' ? 1.1 : 1;
  for (let i = 0; i < count; i++) {
    const r = radius * Math.sqrt(rng.next()), a = rng.range(0, TAU);
    base[i * 5] = r * Math.cos(a); base[i * 5 + 1] = r * Math.sin(a);
    base[i * 5 + 2] = kind === 'pollen' ? rng.range(0.4, 3.5) : rng.range(0, H);
    base[i * 5 + 3] = rng.range(0, 100);
    base[i * 5 + 4] = kind === 'leaves' ? rng.range(0.6, 1.2) : kind === 'snow' ? rng.range(0.7, 1.5) : rng.range(0.25, 0.6);
    c.set(rng.pick(palette)).multiplyScalar(bright * rng.range(0.85, 1.1));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const g = T.g(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = T.m(new THREE.PointsMaterial({
    size, map: makeSpriteTexture(sprite, T), vertexColors: true, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, sizeAttenuation: true, opacity: kind === 'pollen' ? 0.75 : 1,
  }));
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  const update = (t) => {
    for (let i = 0; i < count; i++) {
      const o = i * 5, bx = base[o], bz = base[o + 1], by = base[o + 2], ph = base[o + 3], sp = base[o + 4];
      let x, y, z;
      if (kind === 'pollen') {
        x = bx + Math.sin(t * 0.3 * sp + ph) * 1.6; z = bz + Math.cos(t * 0.27 * sp + ph * 1.3) * 1.6;
        y = by + Math.sin(t * 0.8 * sp + ph * 2) * 0.35;
      } else if (kind === 'motes') {
        y = (by + t * sp) % H + 0.2;
        x = bx + Math.sin(t * 0.5 + ph) * 0.8; z = bz + Math.cos(t * 0.43 + ph * 1.7) * 0.8;
      } else {
        const fall = ((by - t * sp) % H + H) % H;
        y = fall + 0.05;
        const sway = kind === 'leaves' ? 1.1 : 0.45;
        x = bx + Math.sin(t * 1.2 * sp + ph) * sway + (H - fall) * 0.25;
        z = bz + Math.cos(t * 0.9 * sp + ph * 1.3) * sway;
      }
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    }
    g.attributes.position.needsUpdate = true;
  };
  update(0);
  return { points: pts, update };
}

// Climbable trees (autumn levels): a thick trunk and a broad, flat-topped canopy the kitties stand on (CLIMB_Y).
const CLIMB_Y = 2.2;
function buildClimbTrees(levelData, theme, T) {
  const trees = levelData.trees || [];
  if (!trees.length) return [];
  const R = CFG.TREE_RADIUS;
  const rng = createRng(hashSeed(levelData.seed ?? 1, levelData.level ?? 1, 'climbtrees'));
  const trunkGeo = T.g(new THREE.CylinderGeometry(0.28, 0.42, CLIMB_Y, 7));
  trunkGeo.translate(0, CLIMB_Y / 2 - 0.1, 0);
  const blobGeo = T.g(new THREE.IcosahedronGeometry(1, 1));
  const trunkMat = T.m(new THREE.MeshStandardMaterial({ color: theme.trunk, roughness: 1, flatShading: true }));
  const leafMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const per = 6;
  const blobs = new THREE.InstancedMesh(blobGeo, leafMat, trees.length * per);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  const c = new THREE.Color();
  trees.forEach((t, i) => {
    m.compose(pos.set(t.x, 0, t.z), q.setFromEuler(e.set(0, rng.range(0, TAU), 0)), sc.set(1, 1, 1));
    trunks.setMatrixAt(i, m);
    // one big flat center pad (what the kitties stand on) + puffs around its rim
    for (let k = 0; k < per; k++) {
      let x = t.x, z = t.z, y = CLIMB_Y - 0.45, sx = R + 0.2, sy = 0.45, sz = R + 0.2;
      if (k > 0) {
        const a = (k / (per - 1)) * TAU + rng.range(-0.3, 0.3), d = R * 0.85;
        x += Math.cos(a) * d; z += Math.sin(a) * d; y = CLIMB_Y - 0.55; sx = sz = rng.range(0.7, 0.95); sy = 0.5;
      }
      m.compose(pos.set(x, y, z), q.setFromEuler(e.set(0, rng.range(0, TAU), 0)), sc.set(sx, sy, sz));
      blobs.setMatrixAt(i * per + k, m);
      blobs.setColorAt(i * per + k, c.set(theme.crowns[(i + k) % theme.crowns.length]).multiplyScalar(k ? 0.9 : 1));
    }
  });
  trunks.castShadow = blobs.castShadow = true;
  blobs.receiveShadow = true;
  return [trunks, blobs];
}

// Checkpoint squares (ice levels): a glowing ring on the tile and a flag in its back corner.
function buildCheckpoints(levelData, T) {
  const out = [];
  const ringMat = T.m(new THREE.MeshBasicMaterial({ color: 0x8fdcff, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
  const poleMat = T.m(new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.6, metalness: 0.3 }));
  const flagMat = T.m(new THREE.MeshStandardMaterial({ color: 0x3fb8ff, emissive: 0x2a8fe0, emissiveIntensity: 0.5, roughness: 0.7, side: THREE.DoubleSide }));
  const ringGeo = T.g(new THREE.RingGeometry(2.6, 3.0, 48));
  const poleGeo = T.g(new THREE.CylinderGeometry(0.06, 0.08, 2.6, 8));
  const flagShape = new THREE.Shape();
  flagShape.moveTo(0, 0); flagShape.lineTo(1.1, -0.32); flagShape.lineTo(0, -0.7); flagShape.closePath();
  const flagGeo = T.g(new THREE.ShapeGeometry(flagShape));
  for (const cp of levelData.checkpoints || []) {
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cp.x, 0.02, cp.z);
    out.push(ring);
    // back corner of the square (behind the run direction, on the left), clear of the 3x3 arrival block
    const fx = Math.cos(cp.heading), fz = Math.sin(cp.heading), off = levelData.corridorWidth / 2 - 1;
    const x = cp.x - fx * off - fz * off, z = cp.z - fz * off + fx * off;
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(x, 1.3, z);
    pole.castShadow = true;
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(x, 2.55, z);
    flag.rotation.y = -cp.heading;
    out.push(pole, flag);
  }
  return out;
}

// ---------------------------------------------------------------- public API

function buildWorld(scene, levelData) {
  const T = makeTracker();
  const ti = (((levelData.theme ?? ((levelData.level || 1) - 1)) % 4) + 4) % 4;
  const theme = THEMES[ti];
  const rng = createRng(hashSeed(levelData.seed ?? 1, levelData.level ?? 1, 'world'));
  const group = new THREE.Group();
  group.name = 'world';

  for (const m of buildFloors(levelData, theme, T)) group.add(m);
  for (const m of buildCheckpoints(levelData, T)) group.add(m);
  for (const m of buildClimbTrees(levelData, theme, T)) group.add(m);
  for (const m of buildWalls(levelData, theme, T)) group.add(m);
  const lanterns = buildLanterns(levelData, theme, T, rng);
  for (const m of lanterns.meshes) group.add(m);
  for (const m of buildDecor(levelData, theme, ti, T, rng)) group.add(m);
  const parts = buildParticles(theme, rng, levelData.outerRadius + 14, T);
  group.add(parts.points);

  scene.add(group);

  let disposed = false;
  return {
    group,
    theme: ti,
    update(dt, time) {
      lanterns.update(time);
      parts.update(time);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (group.parent) group.parent.remove(group);
      T.dispose();
    },
  };
}

function setupLighting(scene) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 2);
  const EXT = 30, MAP = QUALITY.shadowMap, DIST = 60;
  sun.castShadow = true;
  sun.shadow.mapSize.set(MAP, MAP);
  const sc = sun.shadow.camera;
  sc.left = -EXT; sc.right = EXT; sc.top = EXT; sc.bottom = -EXT;
  sc.near = 1; sc.far = DIST + 60;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 4;
  scene.add(sun);
  scene.add(sun.target);

  // light comes from behind-left (screen up/left); shadows fall toward the viewer/right
  const dir = new THREE.Vector3(-0.45, 1, -0.38).normalize();
  // shadow camera basis (lookAt with up = +Y): z = dir, x = up × z, y = z × x
  const ax = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const ay = new THREE.Vector3().crossVectors(dir, ax).normalize();
  const texel = (EXT * 2) / MAP;
  const F = new THREE.Vector3(), out = new THREE.Vector3();

  const bg = new THREE.Color();
  const fog = new THREE.Fog(0xffffff, 40, 120);
  scene.fog = fog;
  scene.background = bg;

  function setTheme(theme) {
    const t = THEMES[(((theme | 0) % 4) + 4) % 4];
    bg.set(t.sky);
    fog.color.set(t.fog); fog.near = t.fogNear; fog.far = t.fogFar;
    scene.fog = fog; scene.background = bg;
    hemi.color.set(t.hemiSky); hemi.groundColor.set(t.hemiGround); hemi.intensity = t.hemiIntensity;
    sun.color.set(t.sunColor); sun.intensity = t.sunIntensity;
  }
  setTheme(0);

  function update(dt, time, focusX = 0, focusZ = 0) {
    F.set(focusX, 0, focusZ);
    const fx = Math.round(F.dot(ax) / texel) * texel;
    const fy = Math.round(F.dot(ay) / texel) * texel;
    const fz = F.dot(dir);
    out.copy(ax).multiplyScalar(fx).addScaledVector(ay, fy).addScaledVector(dir, fz);
    sun.target.position.copy(out);
    sun.position.copy(out).addScaledVector(dir, DIST);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }
  update(0, 0, 0, 0);

  return { update, setTheme, hemi, sun };
}

export { THEMES, buildWorld, setupLighting };
