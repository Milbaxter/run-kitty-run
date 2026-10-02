import * as THREE from 'three';
import { CFG } from './shared/config.js';
import { createRng, hashSeed, TAU } from './shared/rng.js';
import { locate, collideCircle } from './shared/maze.js';
import { QUALITY } from './device.js';
import { WOLF_TYPES } from './models.js';

// world.js — maze scenery, decor, ambient particles and lighting. (owner: world agent)
//
// Notes / interpretations:
// - buildWorld adds its group to the scene itself; dispose() removes it and frees every
//   geometry/material/texture it created.
// - THEMES entries carry extra fields beyond the contract (lighting, fog, decor palettes).
// - The theme index is levelData.theme (see THEME_ORDER in maze.js), falling back to (level-1)%THEMES.length.
// - Radial walls are swept walls (same style as ring walls), shortened by half the wall
//   thickness at both ends so they butt against the ring walls.
// - Lantern pillars sit flush at both ends of every gap (inset into the wall end) and every
//   ~9 units along the outer wall. No real point lights: emissive orbs + additive ground glows.
// - setupLighting expects renderer.shadowMap.enabled = true / PCFSoftShadowMap (PCFShadowMap on phones; done in main).


const THEMES = [
  {
    name: 'Sunny Meadow',
    sky: 0x9fd8ff, fog: 0xbfe3f5, fogNear: 48, fogFar: 125,
    ground: 0x86c95f, groundAlt: 0x97d26c, outerGround: 0x7cbf58, plaza: 0xeee2c6,
    wall: 0x3f8e3d, wallTop: 0x8ed86f, accent: 0xfff2a0, lamp: 0xffd27a,
    pillar: 0xe0d6bd, trunk: 0x8a5a3a, rock: 0xa3a39a, tuft: 0x5fae45, chevron: 0xffffff,
    hemiSky: 0xd8f0ff, hemiGround: 0x5d7a3c, hemiIntensity: 1.2,
    sunColor: 0xfff0d8, sunIntensity: 2.3, glowK: 0.22, chevronOpacity: 0.32,
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
    sunColor: 0xffc890, sunIntensity: 2.2, glowK: 0.28, chevronOpacity: 0.32,
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
    sunColor: 0xfff4e6, sunIntensity: 1.6, glowK: 0.3, chevronOpacity: 0.38,
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
    sunColor: 0xb8a8ff, sunIntensity: 1.1, glowK: 0.35, chevronOpacity: 0.6,
    floorStyle: 'neon', wallStyle: 'neon', particles: 'motes', crownEmissive: 0.12,
    crowns: [0x5b2fa0, 0x47288a, 0x6a35b0, 0x3a2470, 0x2f6fa0],
    smalls: [0x3ff6ff, 0xff4fd8, 0xb6ff4f, 0xffd24f],
  },
  {
    name: 'Spring Blossom',
    sky: 0xbfe6ff, fog: 0xd8eefa, fogNear: 48, fogFar: 125,
    ground: 0x9edb73, groundAlt: 0xaae27f, outerGround: 0x92d468, plaza: 0xf3e6d8,
    wall: 0x4f9a48, wallTop: 0xf6b8d4, accent: 0xffd0e6, lamp: 0xffd6a0,
    pillar: 0xeadfd0, trunk: 0x6e4a3a, rock: 0xa8a8a0, tuft: 0x6cc24f, chevron: 0xffffff,
    hemiSky: 0xf0f4ff, hemiGround: 0x6a8a4a, hemiIntensity: 1.2,
    sunColor: 0xfff4ec, sunIntensity: 2.2, glowK: 0.22, chevronOpacity: 0.32,
    floorStyle: 'grass', wallStyle: 'hedge', particles: 'leaves', crownEmissive: 0,
    crowns: [0xffb7d5, 0xff9ec7, 0xffc9df, 0xf7a8c8, 0xfff0f6],   // cherry blossom trees (and falling petals)
    smalls: [0xffffff, 0xffb7d5, 0xfff07a, 0xb7e4ff, 0xd6b8ff],
  },
];

// The final run (level 9) is a frozen hell: the winter theme with these overrides (see buildWorld). Charred ground
// with ember specks, dark basalt walls with pale caps (the corridor edge must read), dim red lanterns, steel-blue ice
// so the wolves pop, rising embers. The goal room at the end (room*) is the warm, golden reward; the lighting blends
// from HELL_LIGHT to HEAVEN_LIGHT as the camera reaches it (setupLighting).
const HELL = {
  hell: true,
  ground: 0x3a2c2e, groundAlt: 0x3a2c2e, outerGround: 0x3b2a2b, plaza: 0xf2d29a, tile: 0x7a6a6c,
  roomGround: 0xf6dcb0, roomWall: 0xb07a52, roomWallTop: 0xffe6c0, roomLamp: 0xffc870,
  wall: 0x5c4a50, wallTop: 0xa08a8e, accent: 0xff6a3a, lamp: 0xff5a28,
  pillar: 0x3e3234, trunk: 0x2a1e1c, rock: 0x4c3e40, glowK: 0.34,
  floorEmissive: 0xff5a20, floorEmissiveIntensity: 0.55,
  ice: 0xa9bdd4, iceEmissive: 0x24476e,
  particles: 'motes', particlePalette: [0xff7a3a, 0xffa040, 0xd8401c],
};
const HELL_LIGHT = { sky: 0x0e0507, fog: 0x1c0a0c, fogNear: 30, fogFar: 88, hemiSky: 0xb898a8, hemiGround: 0x4a1a1a, hemiIntensity: 1.15, sunColor: 0xffb098, sunIntensity: 1.25 };
const HEAVEN_LIGHT = { sky: 0xffd9a8, fog: 0xf5d2a0, fogNear: 48, fogFar: 125, hemiSky: 0xfff0d8, hemiGround: 0x8a6a4a, hemiIntensity: 1.2, sunColor: 0xffe2b8, sunIntensity: 1.9 };

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

// One InstancedMesh per `chunk`-wide band of x (items sorted into bands), so each band can be frustum-culled.
function makeInstancedChunks(geo, mat, items, opts, chunk) {
  const bands = new Map();
  for (const it of items) {
    const k = Math.floor(it.x / chunk);
    if (!bands.has(k)) bands.set(k, []);
    bands.get(k).push(it);
  }
  const out = [];
  for (const list of bands.values()) {
    const mesh = makeInstanced(geo, mat, list, opts);
    mesh.computeBoundingSphere();
    out.push(mesh);
  }
  return out.length ? out : [makeInstanced(geo, mat, [], opts)];
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
  // the final run: the goal room's walls are warm (the reward at the end of hell)
  const rr = levelData.roomHalf + t;
  const inRoom = (x, z) => Math.abs(x) <= rr && Math.abs(z) <= rr;
  const roomC = theme.roomWall != null ? new THREE.Color(theme.roomWall) : null;
  const roomTopC = roomC ? new THREE.Color(theme.roomWallTop) : null;
  const bodyColor = (x, y, z, out) => {
    const n = vnoise(x * 0.7 + y * 0.6, z * 0.7 - y * 0.8), n2 = vnoise(x * 2.7 + 13.1, z * 2.7 + y * 2.1);
    const f = 0.8 + 0.28 * n + 0.12 * n2;
    const ao = 1 - aoStrength + aoStrength * Math.min(1, y / (H * 0.85));
    out.copy(roomC && inRoom(x, z) ? roomC : wallC).multiplyScalar(f * ao);
  };
  const capColor = style === 'neon'
    ? (x, y, z, out) => {
      const a = Math.atan2(z, x), r = Math.hypot(x, z);
      const k = 0.5 + 0.5 * Math.sin(a * 2 + r * 0.25);
      out.copy(topC).lerp(accC, k);
    }
    : (x, y, z, out) => {
      const n = vnoise(x * 1.3 + 5.1, z * 1.3 - 2.7);
      out.copy(roomTopC && inRoom(x, z) ? roomTopC : topC).multiplyScalar((style === 'stone' ? 0.94 : 0.82) + 0.16 * n);
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
    capMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.4 })));
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
  addStrip(0, 0, 1, 0, 0, 1, -rh, rh, [-rh, -rh + 0.25, -rh + 0.9, rh - 0.9, rh - 0.25, rh], edge, theme.roomGround ?? theme.ground);
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
  if (theme.floorStyle === 'snow') Object.assign(opts, { emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.8 });
  if (theme.floorEmissive != null) Object.assign(opts, { emissive: theme.floorEmissive, emissiveIntensity: theme.floorEmissiveIntensity });   // the final run: ember specks in the ash
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
  const tiles = new THREE.Mesh(T.g(tg), T.m(new THREE.MeshStandardMaterial({ map: makeSafeTileTexture(T), color: theme.tile ?? theme.plaza, roughness: 0.85 })));
  tiles.receiveShadow = true;
  const out = [floor, plaza, tiles];
  if (levelData.ice) out.push(buildIce(levelData, T, theme));
  return out;
}

// Glossy ice sheet over every corridor (under the safe tiles; the goal room stays snow).
function buildIce(levelData, T, theme) {
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
    map, color: theme.ice ?? 0xd6efff, transparent: true, opacity: 0.82, roughness: 1, metalness: 0, // matte: no sun glare
    emissive: theme.iceEmissive ?? 0x5aa8f0, emissiveIntensity: 0.12, depthWrite: false,
  });
  const ice = new THREE.Mesh(T.g(g), T.m(mat));
  ice.receiveShadow = true;
  // one sheet for the whole map, sorted by its centre: without this it draws over see-through things (the aura)
  // on whichever side of the map is farther from the camera than the centre. It's the floor: always draw it first.
  ice.renderOrder = -1;
  return ice;
}

// ---------------------------------------------------------------- lanterns + chevrons

function buildLanterns(levelData, theme, T, rng) {
  const H = CFG.WALL_HEIGHT;
  const spots = levelData.wallCorners.map((p) => ({ x: p.x, z: p.z }));
  if (levelData.finale) {
    // the final run: a steady rhythm of lanterns down both corridor walls (staggered), plus the goal room and start cap
    // (from just past the start square to just before the goal room's door)
    const rh = levelData.roomHalf, step = 12, x0 = levelData.corners[0].x + levelData.corridorWidth / 2 + 5;
    for (const [w, off] of [[levelData.walls[0], 0], [levelData.walls[1], step / 2]]) {
      for (let x = x0 + off; x < -rh - 4; x += step) spots.push({ x, z: w.az });
    }
    for (const w of levelData.walls.slice(3)) {
      const L = Math.hypot(w.bx - w.ax, w.bz - w.az), n = Math.max(1, Math.floor(L / 8));
      for (let k = 1; k < n; k++) spots.push({ x: w.ax + (w.bx - w.ax) * k / n, z: w.az + (w.bz - w.az) * k / n });
    }
  } else {
    // extra lanterns along the outermost loop (last 4 arms + cap)
    for (const w of levelData.walls.slice(-6)) {
      const L = Math.hypot(w.bx - w.ax, w.bz - w.az), n = Math.floor(L / 9);
      for (let k = 1; k < n; k++) spots.push({ x: w.ax + (w.bx - w.ax) * k / n, z: w.az + (w.bz - w.az) * k / n });
    }
  }

  const PH = H + 0.25;
  const pillarGeo = T.g(mergeGeos([
    place(new THREE.BoxGeometry(0.76, 0.18, 0.76), 0, 0.09, 0),
    place(new THREE.BoxGeometry(0.6, PH, 0.6), 0, PH / 2, 0),
    place(new THREE.BoxGeometry(0.74, 0.12, 0.74), 0, PH + 0.02, 0),
    place(new THREE.CylinderGeometry(0.2, 0.12, 0.14, 8), 0, PH + 0.14, 0),
  ]));
  const orbGeo = T.g(new THREE.IcosahedronGeometry(0.21, levelData.finale ? 1 : 2));   // the final run has ~150 lanterns
  const glowGeo = T.g(new THREE.PlaneGeometry(1, 1)); glowGeo.rotateX(-Math.PI / 2);

  const pillarItems = [], orbItems = [], glowItems = [];
  const pc = new THREE.Color(theme.pillar), rpc = new THREE.Color(theme.roomWall ?? theme.pillar), prr = levelData.roomHalf + 1;
  for (const sp of spots) {
    const { x, z } = sp;
    const c = Math.abs(x) <= prr && Math.abs(z) <= prr ? rpc : pc;
    pillarItems.push({ x, z, ry: 0, color: c.clone().multiplyScalar(rng.range(0.9, 1.08)) });
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
  // the final run: red lanterns down the run, warm gold ones in the goal room
  const roomLampC = theme.roomLamp != null ? new THREE.Color(theme.roomLamp) : lampC, rr = levelData.roomHalf + 1;
  const lamps = spots.map((s) => (Math.abs(s.x) <= rr && Math.abs(s.z) <= rr ? roomLampC : lampC));
  const tmp = new THREE.Color();
  const update = (time) => {
    for (let i = 0; i < spots.length; i++) {
      const ph = phases[i], lc = lamps[i];
      const f = 0.86 + 0.08 * Math.sin(time * 6.3 + ph * 7) + 0.06 * Math.sin(time * 17.1 + ph * 13);
      orbs.setColorAt(i, tmp.copy(lc).multiplyScalar(f));
      tmp.copy(lc).multiplyScalar(theme.glowK * f);
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
    map: makeChevronTexture(T), color: theme.chevron,
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
  // the final run is ~870 units long: split along x so off-screen stretches get frustum-culled (also in the shadow pass)
  const inst = (geo, mat, items, opts) => (levelData.finale ? makeInstancedChunks(geo, mat, items, opts, 96) : [makeInstanced(geo, mat, items, opts)]);
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
  if (theme.hell) return buildHellDecor(levelData, theme, T, rng, { inst, sampleOuter, sampleCorridor, outerArea, corridorArea, jitterColor });

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
  meshes.push(...inst(trunkGeo, trunkMat, trees.map((t) => ({ ...t, color: null })), { cast: true }));
  meshes.push(...inst(crownGeo, crownMat, trees, { cast: true, receive: true }));

  // ---- bushes (hug the outer wall + scattered)
  const bushGeo = T.g(mergeGeos([
    place(new THREE.IcosahedronGeometry(0.5, 1), 0, 0.32, 0),
    place(new THREE.IcosahedronGeometry(0.38, 1), 0.42, 0.25, 0.1),
    place(new THREE.IcosahedronGeometry(0.36, 1), -0.38, 0.24, -0.12),
  ]));
  const bushMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }));
  if (theme.crownEmissive > 0) { bushMat.emissive.set(0xffffff); bushMat.emissiveIntensity = theme.crownEmissive; emissiveByColor(bushMat); }
  const bushes = [];
  for (const w of (levelData.finale ? levelData.walls.slice(0, 2) : levelData.walls.slice(-6, -2))) {
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
  meshes.push(...inst(bushGeo, bushMat, bushes, { cast: true, receive: true }));

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
  meshes.push(...inst(rockGeo, rockMat, rocks, { cast: true, receive: true }));

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
    meshes.push(...inst(tuftGeo, tuftMat, tufts));
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

  if (ti === 0 || ti === 4) { // summer + spring: flowers
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
    meshes.push(...inst(flowerGeo, flowerMat, flowers));
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
    meshes.push(...inst(leafGeo, leafMat, leaves));
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
    meshes.push(...inst(pumpGeo, pumpMat, pumps, { cast: QUALITY.propShadows }));
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
    meshes.push(...inst(moundGeo, moundMat, mounds, { receive: true }));
    // ice crystals (faintly glowing)
    const crysGeo = T.g(place(new THREE.OctahedronGeometry(0.12, 0), 0, 0.12, 0, 1, 1.8, 1));
    const crysMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: 0.35 })));
    const crys = clusters(Math.round(corridorArea * 0.012), [2, 4], 0.25, 0.5, (x, z) => ({ x, z, s: rng.range(0.7, 1.4), ry: rng.range(0, TAU), rz: rng.range(-0.3, 0.3), color: new THREE.Color(rng.pick(theme.smalls)) }));
    meshes.push(...inst(crysGeo, crysMat, crys));
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
    const nSm = levelData.finale ? Math.round(levelData.runLength / 18) : Math.max(4, Math.round(8 * Rn / 20));
    for (let i = 0; i < nSm; i++) {
      const p = sampleOuter(1.5, 8);
      sms.push({ x: p.x, z: p.z, s: rng.range(0.8, 1.1), ry: (levelData.finale ? -Math.PI / 2 : -p.a + Math.PI) + rng.range(-0.5, 0.5) });   // the final run: face the camera
    }
    meshes.push(...inst(smGeo, smMat, sms, { cast: true }));
  } else {
    // neon: glowing mushrooms in corridors and outside, crystals outside
    const mushGeo = T.g(mergeGeos([
      paint(place(new THREE.CylinderGeometry(0.035, 0.05, 0.16, 5), 0, 0.08, 0), 0x777799),
      paint(place(new THREE.SphereGeometry(0.13, 8, 4, 0, TAU, 0, Math.PI / 2), 0, 0.15, 0, 1, 0.7, 1), 0xffffff),
    ]));
    const mushMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.45 })));
    const mush = clusters(Math.round(corridorArea * 0.02), [2, 5], 0.4, 0.6, (x, z) => ({ x, z, s: rng.range(0.7, 1.5), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) }));
    for (let i = 0; i < outerArea * 0.03; i++) {
      const p = sampleOuter(1, 26);
      mush.push({ x: p.x, z: p.z, s: rng.range(1.2, 2.8), ry: rng.range(0, TAU), color: new THREE.Color(rng.pick(theme.smalls)) });
    }
    meshes.push(...inst(mushGeo, mushMat, mush));
    const crysGeo = T.g(place(new THREE.OctahedronGeometry(0.35, 0), 0, 0.6, 0, 0.7, 2.2, 0.7));
    const crysMat = T.m(emissiveByColor(new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.2, emissive: 0xffffff, emissiveIntensity: 0.5 })));
    const crys = [];
    for (let i = 0; i < outerArea * 0.006; i++) {
      const p = sampleOuter(2, 26), n = rng.int(2, 4);
      for (let k = 0; k < n; k++) {
        crys.push({ x: p.x + rng.range(-0.6, 0.6), z: p.z + rng.range(-0.6, 0.6), s: rng.range(0.6, 1.4), ry: rng.range(0, TAU), rx: rng.range(-0.35, 0.35), rz: rng.range(-0.35, 0.35), color: new THREE.Color(rng.pick([theme.accent, theme.wallTop, 0xb68cff])) });
      }
    }
    meshes.push(...inst(crysGeo, crysMat, crys, { cast: true }));
  }
  return meshes;
}

// The final run's surroundings: a frozen hell. Bare dead trees, jagged basalt spikes, scattered bones and skulls,
// dim ember glows in the ash. Everything instanced (in x chunks, so the off-screen stretches get culled). Tall things
// on the near side (+z, toward the camera) stand well back from the wall so they never hide the kitties.
function buildHellDecor(levelData, theme, T, rng, { inst, sampleOuter, sampleCorridor, outerArea, corridorArea, jitterColor }) {
  const meshes = [];
  const zWall = levelData.corridorWidth / 2 + CFG.WALL_THICKNESS / 2;
  const nearOk = (p, clear) => p.z < 0 || p.z - zWall > clear;   // far side: anything; near side: `clear` units back
  const outer = (lo, hi, clear) => {
    for (let k = 0; k < 6; k++) { const p = sampleOuter(lo, hi); if (nearOk(p, clear)) return p; }
    return null;
  };

  // ---- dead trees: a crooked trunk and a few bare, forking branches (3 shapes)
  const limb = (geos, x0, y0, z0, th, ph, L, r0, r1) => {
    const dx = Math.sin(th) * Math.cos(ph), dy = Math.cos(th), dz = -Math.sin(th) * Math.sin(ph);
    geos.push(place(new THREE.CylinderGeometry(r1, r0, L, 5, 1), x0 + dx * L / 2, y0 + dy * L / 2, z0 + dz * L / 2, 1, 1, 1, 0, ph, -th));
    return [x0 + dx * L, y0 + dy * L, z0 + dz * L];
  };
  const treeGeos = [0, 1, 2].map((v) => {
    const r = createRng(hashSeed('deadtree', v)), geos = [];
    const lean = r.range(-0.12, 0.12);
    const top = limb(geos, 0, -0.1, 0, lean, r.range(0, TAU), 2.7 + v * 0.3, 0.2, 0.09);
    const nb = 3 + (v % 2);
    for (let k = 0; k < nb; k++) {
      const f = 0.45 + 0.5 * (k / nb), ph = (k / nb) * TAU + r.range(-0.4, 0.4);
      const th = r.range(0.55, 1.05), L = r.range(0.8, 1.3) * (1.1 - f * 0.4);
      const b = limb(geos, top[0] * f, top[1] * f, top[2] * f, th, ph, L, 0.075, 0.035);
      limb(geos, b[0], b[1], b[2], th * 0.5, ph + r.range(-0.8, 0.8), L * 0.55, 0.035, 0.012);
      limb(geos, b[0], b[1], b[2], th + 0.5, ph + r.range(-0.6, 0.6), L * 0.4, 0.03, 0.01);
    }
    limb(geos, top[0], top[1], top[2], 0.35, r.range(0, TAU), 0.6, 0.06, 0.012);
    return T.g(mergeGeos(geos));
  });
  const barkMat = T.m(new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }));
  const treeItems = [[], [], []];
  for (let i = 0, n = Math.round(outerArea * 0.011); i < n; i++) {
    const p = outer(2.6, 26, 6); if (!p) continue;
    treeItems[i % 3].push({ x: p.x, z: p.z, s: rng.range(0.85, 1.5), ry: rng.range(0, TAU), color: jitterColor(theme.trunk, 0.25) });
  }
  treeItems.forEach((items, v) => meshes.push(...inst(treeGeos[v], barkMat, items, { cast: true })));

  // ---- jagged basalt spikes, in clumps
  const spikeGeo = T.g(mergeGeos([
    place(new THREE.ConeGeometry(0.42, 2.2, 4), 0, 1.0, 0, 1, 1, 1, 0.08, 0.3, 0.1),
    place(new THREE.ConeGeometry(0.3, 1.4, 4), 0.55, 0.62, 0.2, 1, 1, 1, -0.1, 1.1, -0.35),
    place(new THREE.ConeGeometry(0.26, 1.0, 4), -0.45, 0.42, -0.15, 1, 1, 1, 0.2, 2.0, 0.4),
  ]));
  const spikeMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.1, flatShading: true }));
  const spikes = [];
  for (let i = 0, n = Math.round(outerArea * 0.006); i < n; i++) {
    const p = outer(2.2, 26, 4); if (!p) continue;
    spikes.push({ x: p.x, z: p.z, s: rng.range(0.7, 1.5), ry: rng.range(0, TAU), color: jitterColor(theme.rock, 0.2) });
  }
  meshes.push(...inst(spikeGeo, spikeMat, spikes, { cast: true, receive: true }));

  // ---- rocks outside, and the odd pebble on the ice (dark: they read on the pale ice)
  const rockGeo = T.g(new THREE.DodecahedronGeometry(0.5, 0));
  const rockMat = T.m(new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }));
  const rocks = [];
  for (let i = 0, n = Math.round(outerArea * 0.006); i < n; i++) {
    const p = sampleOuter(1.5, 26), s = rng.range(0.5, 1.5);
    rocks.push({ x: p.x, z: p.z, y: 0.12 * s, sx: s * rng.range(0.8, 1.3), sy: s * rng.range(0.45, 0.8), sz: s, ry: rng.range(0, TAU), color: jitterColor(theme.rock, 0.15) });
  }
  for (let i = 0, n = Math.round(corridorArea * 0.012); i < n; i++) {
    const p = sampleCorridor(0.4); if (!p) continue;
    const s = rng.range(0.12, 0.24);
    rocks.push({ x: p.x, z: p.z, y: 0.03, sx: s * 1.3, sy: s * 0.5, sz: s, ry: rng.range(0, TAU), color: jitterColor(theme.rock, 0.15) });
  }
  meshes.push(...inst(rockGeo, rockMat, rocks, { cast: true, receive: true }));

  // ---- bones and skulls in the ash (never on the ice)
  const BONE = 0xd9cdb2;
  const boneGeo = T.g(mergeGeos([
    paint(place(new THREE.CylinderGeometry(0.045, 0.045, 0.62, 5), 0, 0.06, 0, 1, 1, 1, 0, 0, Math.PI / 2), BONE),
    ...[[-0.33, 0.06], [-0.33, -0.06], [0.33, 0.06], [0.33, -0.06]].map(([x, z]) => paint(place(new THREE.IcosahedronGeometry(0.075, 0), x, 0.06, z), BONE)),
  ]));
  const skullGeo = T.g(mergeGeos([
    paint(place(new THREE.IcosahedronGeometry(0.3, 1), 0, 0.27, -0.03, 1, 0.85, 1.05), BONE),
    paint(place(new THREE.BoxGeometry(0.3, 0.14, 0.2), 0, 0.1, 0.18), BONE),
    paint(place(new THREE.IcosahedronGeometry(0.075, 0), -0.11, 0.28, 0.23), 0x1a0808),
    paint(place(new THREE.IcosahedronGeometry(0.075, 0), 0.11, 0.28, 0.23), 0x1a0808),
    paint(place(new THREE.ConeGeometry(0.035, 0.07, 3), 0, 0.17, 0.29, 1, 1, 1, Math.PI / 2, 0, 0), 0x1a0808),
  ]));
  const boneMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true }));
  const bones = [], skulls = [];
  for (let i = 0, n = Math.round(outerArea * 0.012); i < n; i++) {
    const p = sampleOuter(0.9, 20), s = rng.range(0.8, 1.4);
    bones.push({ x: p.x, z: p.z, s, ry: rng.range(0, TAU), color: new THREE.Color(1, 1, 1).multiplyScalar(rng.range(0.75, 1)) });
    if (rng.chance(0.4)) bones.push({ x: p.x + rng.range(-0.3, 0.3), z: p.z + rng.range(-0.3, 0.3), y: 0.08, s, ry: rng.range(0, TAU), color: new THREE.Color(1, 1, 1).multiplyScalar(rng.range(0.75, 1)) });
  }
  for (let i = 0, n = Math.round(outerArea * 0.0018); i < n; i++) {
    const p = sampleOuter(1.0, 18);
    skulls.push({ x: p.x, z: p.z, s: rng.range(0.9, 1.4), ry: rng.range(-0.6, 0.6), rx: rng.range(-0.15, 0.1), color: new THREE.Color(1, 1, 1).multiplyScalar(rng.range(0.8, 1)) });
  }
  meshes.push(...inst(boneGeo, boneMat, bones, { receive: true }));
  meshes.push(...inst(skullGeo, boneMat, skulls, { cast: true, receive: true }));

  // ---- faint ember glows smouldering in the ash
  const glowGeo = T.g(new THREE.PlaneGeometry(1, 1)); glowGeo.rotateX(-Math.PI / 2);
  const glowMat = T.m(new THREE.MeshBasicMaterial({ map: makeGlowTexture(T), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const embers = [];
  for (let i = 0, n = Math.round(outerArea * 0.0025); i < n; i++) {
    const p = sampleOuter(2, 26);
    embers.push({ x: p.x, z: p.z, y: 0.02, s: rng.range(2.5, 6), ry: rng.range(0, TAU), color: new THREE.Color(0xff3a10).multiplyScalar(rng.range(0.12, 0.26)) });
  }
  for (const g of inst(glowGeo, glowMat, embers)) { g.renderOrder = 1; meshes.push(g); }
  return meshes;
}

// ---------------------------------------------------------------- particles

// box = { w, d } (the final run): instead of a disc over the whole map, the particles fill a w x d box that wraps
// around the camera's ground focus (read in onBeforeRender), so a 870-unit straight keeps the spiral's density.
function buildParticles(theme, rng, radius, T, box = null) {
  const kind = theme.particles;
  const area = box ? box.w * box.d : Math.PI * radius * radius;
  const count = Math.round(clamp(area * 0.1, 300, 1300) * QUALITY.particles);
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  const base = new Float32Array(count * 5); // bx, bz, by, phase, speed
  const c = new THREE.Color();
  let palette, H, size, additive, sprite;
  if (kind === 'pollen') { palette = [0xfff6c0, 0xffffff, 0xfff0a0]; H = 4; size = 0.16; additive = true; sprite = 'dot'; }
  else if (kind === 'leaves') { palette = theme.crowns; H = 11; size = 0.42; additive = false; sprite = 'leaf'; }
  else if (kind === 'snow') { palette = [0xffffff, 0xf0f6ff]; H = 12; size = 0.2; additive = false; sprite = 'snow'; }
  else { palette = theme.particlePalette || [theme.accent, theme.wallTop, 0xb68cff]; H = 7; size = 0.26; additive = true; sprite = 'dot'; }
  const bright = kind === 'motes' || kind === 'pollen' ? 0.9 : 1;
  for (let i = 0; i < count; i++) {
    if (box) { base[i * 5] = rng.range(0, box.w); base[i * 5 + 1] = rng.range(0, box.d); } else {
      const r = radius * Math.sqrt(rng.next()), a = rng.range(0, TAU);
      base[i * 5] = r * Math.cos(a); base[i * 5 + 1] = r * Math.sin(a);
    }
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
  let fx = 0, fz = 0;
  if (box) {
    const dir = new THREE.Vector3();
    pts.onBeforeRender = (renderer, scene, camera) => {
      camera.getWorldDirection(dir);
      const p = camera.position, k = dir.y < -0.05 ? -p.y / dir.y : 0;
      fx = p.x + dir.x * k; fz = p.z + dir.z * k;
    };
  }
  const update = (t) => {
    const ox = fx - (box ? box.w / 2 : 0), oz = fz - (box ? box.d / 2 : 0);
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
      if (box) { x = ox + (((x - ox) % box.w) + box.w) % box.w; z = oz + (((z - oz) % box.d) + box.d) % box.d; }
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
  if (!levelData.finale) return [trunks, blobs];
  // the final run's tree: frosted. Snow caps on the pad and the rim puffs, icicles hanging off the rim.
  const caps = [], icicles = [];
  trees.forEach((t, i) => {
    caps.push({ x: t.x, z: t.z, y: CLIMB_Y - 0.08, sx: R * 0.78, sy: 0.16, sz: R * 0.7, ry: rng.range(0, TAU) });
    for (let k = 1; k < per; k++) {
      blobs.getMatrixAt(i * per + k, m); m.decompose(pos, q, sc);
      caps.push({ x: pos.x, z: pos.z, y: pos.y + sc.y * 0.55, sx: sc.x * 0.62, sy: 0.18, sz: sc.z * 0.62, ry: rng.range(0, TAU) });
    }
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * TAU + rng.range(-0.15, 0.15), d = R + rng.range(0.1, 0.45);
      icicles.push({ x: t.x + Math.cos(a) * d, z: t.z + Math.sin(a) * d, y: CLIMB_Y - 0.75, s: rng.range(0.6, 1.15), ry: rng.range(0, TAU) });
    }
  });
  const capMesh = makeInstanced(T.g(new THREE.IcosahedronGeometry(1, 1)), T.m(new THREE.MeshStandardMaterial({ color: 0xf6faff, roughness: 0.7, flatShading: true })), caps, { cast: true, receive: true });
  const iceGeo = T.g(new THREE.ConeGeometry(0.07, 0.55, 5)); iceGeo.rotateX(Math.PI); iceGeo.translate(0, -0.27, 0);
  const iceMat = T.m(new THREE.MeshStandardMaterial({ color: 0xcfeeff, emissive: 0x6fc8ff, emissiveIntensity: 0.35, roughness: 0.2, metalness: 0.1, flatShading: true }));
  return [trunks, blobs, capMesh, makeInstanced(iceGeo, iceMat, icicles)];
}

// Checkpoint squares (every level but the final run): a glowing ring on the tile and a flag in its back corner.
function buildCheckpoints(levelData, T) {
  const out = [];
  const ringMat = T.m(new THREE.MeshBasicMaterial({ color: 0x8fdcff, transparent: true, opacity: 0.55, depthWrite: false }));
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

// ---------------------------------------------------------------- the final run (last level)
//
// Set dressing for levelData.finale, a frozen hell (no start / finish markings, nothing that tells how far is left):
// fire braziers outside both walls at a steady rhythm, a faint blood-red shimmer on the ice, and a snow patch under
// the halfway tree (the one place to rest). At the end, the goal room is the sweet reward:
// cushions, yarn balls, bowls of milk and golden sparkles round the giant fish (models.js). Nothing tall stands on
// the near (+z) side: the camera looks down toward -z at ~56° and it would hide the kitties.

function textTexture(T, w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return T.t(t);
}

function buildFinale(levelData, theme, T, rng) {
  const meshes = [];
  const W = levelData.corridorWidth, h = W / 2, rh = levelData.roomHalf, R = CFG.TREE_RADIUS;
  const xs = levelData.corners[0].x, xStart = xs + h + 0.4, xEnd = -rh - 1;
  const xHi = -rh;                               // the corridor's ice ends at the goal room's door

  // ---- fire braziers outside both walls (staggered); evenly spaced, so they don't tell how far is left
  const brazGeo = T.g(mergeGeos([
    paint(place(new THREE.CylinderGeometry(0.42, 0.5, 0.16, 7), 0, 0.08, 0), 0x2a2224),
    paint(place(new THREE.CylinderGeometry(0.1, 0.16, 0.85, 6), 0, 0.55, 0), 0x2a2224),
    paint(place(new THREE.CylinderGeometry(0.58, 0.3, 0.34, 8), 0, 1.08, 0), 0x3a2e30),
    paint(place(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 8), 0, 1.24, 0), 0x601a0c),   // the coals
  ]));
  const brazMat = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.3, flatShading: true }));
  const flameGeo = T.g(new THREE.ConeGeometry(0.4, 1, 7)); flameGeo.translate(0, 0.5, 0);
  const flameOut = T.m(new THREE.MeshBasicMaterial({ color: 0xe8461a, transparent: true, opacity: 0.85, depthWrite: false }));
  const flameIn = T.m(new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.9, depthWrite: false }));
  const braz = [], flames = [], brazGlow = [];
  const brazier = (x, z) => {
    const S = z > 0 ? 0.75 : 1;                // near side (toward the camera): keep them low
    braz.push({ x, z, s: S, ry: rng.range(0, TAU) });
    flames.push({ x, z, y: 1.25 * S, s: S, ph: rng.range(0, 10) });
    brazGlow.push({ x, z, y: 0.03, s: 6.5, color: new THREE.Color(0xff4a18).multiplyScalar(0.32) });
  };
  const off = h + CFG.WALL_THICKNESS / 2 + 1.5;
  for (let x = xStart + 10; x < xEnd - 6; x += 24) {
    brazier(x, -off - rng.range(0, 0.6));
    brazier(x + 12, off + rng.range(0, 0.6));
  }
  meshes.push(...makeInstancedChunks(brazGeo, brazMat, braz, { cast: true }, 96));
  // flames: two cones per brazier that flicker (one instanced mesh each, matrices rewritten every frame)
  const outerF = new THREE.InstancedMesh(flameGeo, flameOut, flames.length), innerF = new THREE.InstancedMesh(flameGeo, flameIn, flames.length);
  outerF.frustumCulled = innerF.frustumCulled = false;
  outerF.renderOrder = 2; innerF.renderOrder = 3;
  meshes.push(outerF, innerF);
  const glowGeo = T.g(new THREE.PlaneGeometry(1, 1)); glowGeo.rotateX(-Math.PI / 2);
  const glowTex = makeGlowTexture(T);
  const glowMat = T.m(new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  for (const g of makeInstancedChunks(glowGeo, glowMat, brazGlow, {}, 96)) { g.renderOrder = 1; meshes.push(g); }

  // ---- a faint blood-red / violet shimmer drifting over the ice (not under the tree's snow patch)
  const tr = (levelData.trees && levelData.trees[0]) || { x: 1e5, z: 0 };
  const auroraGeo = T.g(new THREE.PlaneGeometry(xHi - xStart, 2 * h - CFG.WALL_THICKNESS, Math.ceil((xHi - xStart) / 8), 1));
  auroraGeo.rotateX(-Math.PI / 2);
  auroraGeo.translate((xStart + xHi) / 2, 0.009, 0);
  const auroraMat = T.m(new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uTree: { value: new THREE.Vector3(tr.x, tr.z, R + 0.6) }, uK: { value: 0.2 } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vP; uniform float uTime; uniform vec3 uTree; uniform float uK;
      void main(){
        float t = uTime;
        float w = sin(vP.y * 0.32 + vP.x * 0.011 + t * 0.21) * 1.7;
        float b1 = sin(vP.x * 0.043 + t * 0.33 + w);
        float b2 = sin(vP.x * 0.019 - t * 0.19 + vP.y * 0.16 + 1.7);
        float a = smoothstep(0.3, 1.0, b1) * 0.75 + smoothstep(0.55, 1.0, b2) * 0.55;
        vec3 blood = vec3(0.75, 0.08, 0.06), ember = vec3(0.9, 0.3, 0.1), violet = vec3(0.4, 0.12, 0.55);
        float m = 0.5 + 0.5 * sin(vP.x * 0.0071 + t * 0.07);
        vec3 col = mix(mix(blood, ember, m), violet, smoothstep(0.6, 1.0, b2));
        float edge = 1.0 - smoothstep(3.6, 5.2, abs(vP.y));
        float hole = smoothstep(uTree.z, uTree.z + 1.2, distance(vP, uTree.xy));
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * edge * hole * uK);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false,
  }));
  const aurora = new THREE.Mesh(auroraGeo, auroraMat);
  aurora.renderOrder = 0;   // after the ice sheet (-1), before the snow patch / glows (1)
  aurora.frustumCulled = false;
  meshes.push(aurora);

  // ---- the halfway tree: a disc of snow over the ice (you can stand still here)
  if (levelData.trees && levelData.trees.length) {
    const snowTex = textTexture(T, 128, 128, (g, S) => {
      const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.78, 'rgba(250,252,255,1)'); gr.addColorStop(1, 'rgba(240,246,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 120; i++) { g.fillStyle = `rgba(170,195,235,${0.08 + 0.1 * Math.random()})`; g.beginPath(); g.arc(S / 2 + (Math.random() - 0.5) * S * 0.8, S / 2 + (Math.random() - 0.5) * S * 0.8, 1 + Math.random() * 2, 0, TAU); g.fill(); }
    });
    const snowGeo = T.g(new THREE.PlaneGeometry(2 * R + 1.4, 2 * R + 1.4)); snowGeo.rotateX(-Math.PI / 2);
    const snowMat = T.m(new THREE.MeshStandardMaterial({ map: snowTex, transparent: true, roughness: 0.85, depthWrite: false, emissive: 0x9fb8e0, emissiveIntensity: 0.15 }));
    for (const t of levelData.trees) {
      const snow = new THREE.Mesh(snowGeo, snowMat);
      snow.position.set(t.x, 0.011, t.z); snow.renderOrder = 1; snow.receiveShadow = true;
      meshes.push(snow);
    }
  }

  const room = buildRewardRoom(levelData, T, rng, glowGeo, glowMat);
  meshes.push(...room.meshes);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const update = (time) => {
    auroraMat.uniforms.uTime.value = time;
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i], k = f.ph;
      const fy = 0.85 + 0.2 * Math.sin(time * 9.1 + k * 7) + 0.1 * Math.sin(time * 23.7 + k * 3);
      const fw = 0.92 + 0.08 * Math.sin(time * 13.3 + k * 5);
      q.setFromEuler(e.set(0.08 * Math.sin(time * 5.3 + k), k, 0.08 * Math.sin(time * 4.1 + k * 2)));
      m4.compose(p.set(f.x, f.y, f.z), q, s.set(f.s * fw, f.s * fy * 1.1, f.s * fw));
      outerF.setMatrixAt(i, m4);
      m4.compose(p, q, s.set(f.s * fw * 0.55, f.s * fy * 0.7, f.s * fw * 0.55));
      innerF.setMatrixAt(i, m4);
    }
    outerF.instanceMatrix.needsUpdate = innerF.instanceMatrix.needsUpdate = true;
    room.update(time);
  };
  update(0);
  return { meshes, update };
}

// The goal room after hell: cosy and warm. Cushions in the corners, yarn balls and bowls of milk along the front
// wall, a soft golden glow on the floor and slow golden sparkles drifting in the air (all clear of the goal disc
// and the giant fish curled round its back; purely cosmetic, nothing here collides).
function buildRewardRoom(levelData, T, rng, glowGeo, glowMat) {
  const meshes = [];
  const rh = levelData.roomHalf;
  const vc = T.m(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }));

  // cushions: a plump pillow with a tufted button, tinted per instance
  const cushionGeo = T.g(mergeGeos([
    paint(place(new THREE.SphereGeometry(1, 14, 8), 0, 0.26, 0, 1.0, 0.3, 1.0), 0xffffff),
    paint(place(new THREE.IcosahedronGeometry(0.12, 1), 0, 0.53, 0, 1, 0.5, 1), 0xe8e0f0),
    ...[0, 1, 2, 3].map((k) => paint(place(new THREE.IcosahedronGeometry(0.16, 0), Math.cos(k * Math.PI / 2 + Math.PI / 4) * 0.98, 0.24, Math.sin(k * Math.PI / 2 + Math.PI / 4) * 0.98), 0xffe9a8)),
  ]));
  const c = rh - 1.55;
  const cushions = [
    { x: -c + 0.3, z: c - 0.5, color: 0xff9ec7 }, { x: c, z: c - 0.5, color: 0xc4a8ff }, { x: c, z: -c, color: 0xffc49a }, { x: -c, z: -c, color: 0xa8e4c8 },
  ].map((o) => ({ ...o, s: 1.15, ry: rng.range(0, TAU), color: new THREE.Color(o.color) }));
  meshes.push(makeInstanced(cushionGeo, vc, cushions, { cast: true, receive: true }));

  // yarn balls: a ball wound with a few strands
  const yarnGeo = T.g(mergeGeos([
    paint(place(new THREE.IcosahedronGeometry(0.3, 2), 0, 0.3, 0), 0xffffff),
    paint(place(new THREE.TorusGeometry(0.3, 0.028, 4, 18), 0, 0.3, 0, 1, 1, 1, 0.3, 0, 0), 0xd8d8d8),
    paint(place(new THREE.TorusGeometry(0.3, 0.028, 4, 18), 0, 0.3, 0, 1, 1, 1, 1.4, 0.8, 0), 0xd8d8d8),
    paint(place(new THREE.TorusGeometry(0.3, 0.028, 4, 18), 0, 0.3, 0, 1, 1, 1, 2.2, -0.6, 0.4), 0xd8d8d8),
    paint(place(new THREE.CylinderGeometry(0.025, 0.025, 0.7, 4), 0.42, 0.03, 0.18, 1, 1, 1, 0, 0.4, Math.PI / 2), 0xd8d8d8),   // a loose end
  ]));
  // (the front wall hides the last ~1 unit of floor from the camera: nothing goes past z = rh - 1.4)
  const yarn = [[-4.3, rh - 1.6, 0xff5a6a], [-c + 1.5, c - 1.2, 0x5ab4ff], [4.4, rh - 1.7, 0xffd04a], [c - 0.4, c - 2.2, 0xff8ad0], [c + 0.3, 2.4, 0x8ae070]]
    .map(([x, z, col]) => ({ x, z, s: rng.range(0.9, 1.15), ry: rng.range(0, TAU), color: new THREE.Color(col) }));
  meshes.push(makeInstanced(yarnGeo, vc, yarn, { cast: true, receive: true }));

  // bowls of milk
  const bowlGeo = T.g(mergeGeos([
    paint(place(new THREE.CylinderGeometry(0.46, 0.32, 0.24, 16), 0, 0.12, 0), 0x7aa8ff),
    paint(place(new THREE.CylinderGeometry(0.4, 0.4, 0.02, 16), 0, 0.245, 0), 0xfffaf0),
    paint(place(new THREE.TorusGeometry(0.44, 0.035, 4, 20), 0, 0.24, 0, 1, 1, 1, Math.PI / 2, 0, 0), 0xa8c8ff),
  ]));
  const bowls = [[-2.3, rh - 1.75], [0, rh - 1.55], [2.3, rh - 1.75]].map(([x, z]) => ({ x, z, s: 1 }));
  meshes.push(makeInstanced(bowlGeo, vc, bowls, { cast: true, receive: true }));

  // soft golden pools of light: one over the room, one under every cushion
  const glows = [{ x: 0, z: 0, y: 0.02, s: 2 * rh + 6, color: new THREE.Color(0xffb060).multiplyScalar(0.12) }];
  for (const o of cushions) glows.push({ x: o.x, z: o.z, y: 0.025, s: 4.5, color: new THREE.Color(0xffc070).multiplyScalar(0.2) });
  const g = makeInstanced(glowGeo, glowMat, glows);
  g.renderOrder = 1;
  meshes.push(g);

  // golden sparkles drifting in the air
  const N = 34, sp = [];
  for (let i = 0; i < N; i++) {
    let x, z;
    do { x = rng.range(-rh + 0.6, rh - 0.6); z = rng.range(-rh + 0.6, rh - 0.6); } while (Math.hypot(x, z) < 3.5);
    sp.push({ x, z, y: rng.range(0.6, 2.8), ph: rng.range(0, TAU), sp: rng.range(0.4, 0.9) });
  }
  const spGeo = T.g(new THREE.OctahedronGeometry(0.09, 0)); spGeo.scale(1, 1.6, 1);
  const spMat = T.m(new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.9, depthWrite: false }));
  const spMesh = new THREE.InstancedMesh(spGeo, spMat, N);
  spMesh.frustumCulled = false;
  meshes.push(spMesh);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const update = (time) => {
    for (let i = 0; i < N; i++) {
      const o = sp[i], t = time * o.sp + o.ph;
      const k = Math.max(0, Math.sin(t * 2.3));   // twinkle: grow and shrink
      m4.compose(p.set(o.x + Math.sin(t) * 0.4, o.y + Math.sin(t * 0.7) * 0.35, o.z + Math.cos(t * 0.9) * 0.4), q.setFromEuler(e.set(0, t * 2, 0)), s.setScalar(0.25 + 0.9 * k));
      spMesh.setMatrixAt(i, m4);
    }
    spMesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { meshes, update };
}

// ---------------------------------------------------------------- public API

function buildWorld(scene, levelData) {
  const T = makeTracker();
  const ti = (((levelData.theme ?? ((levelData.level || 1) - 1)) % THEMES.length) + THEMES.length) % THEMES.length;
  const base = THEMES[ti];
  const theme = levelData.finale ? { ...base, ...HELL } : base;   // the final run: a frozen hell (see HELL)
  const rng = createRng(hashSeed(levelData.seed ?? 1, levelData.level ?? 1, 'world'));
  const group = new THREE.Group();
  group.name = 'world';

  for (const m of buildFloors(levelData, theme, T)) group.add(m);
  for (const m of buildCheckpoints(levelData, T)) group.add(m);
  for (const m of buildClimbTrees(levelData, base, T)) group.add(m);   // the halfway tree stays green and frosted: the one refuge
  for (const m of buildWalls(levelData, theme, T)) group.add(m);
  const lanterns = buildLanterns(levelData, theme, T, rng);
  for (const m of lanterns.meshes) group.add(m);
  for (const m of buildDecor(levelData, theme, ti, T, rng)) group.add(m);
  const finale = levelData.finale ? buildFinale(levelData, theme, T, rng) : null;
  if (finale) for (const m of finale.meshes) group.add(m);
  const parts = buildParticles(theme, rng, levelData.outerRadius + 14, T, levelData.finale ? { w: 96, d: 80 } : null);
  group.add(parts.points);

  scene.add(group);

  let disposed = false;
  return {
    group,
    theme: ti,
    update(dt, time) {
      lanterns.update(time);
      if (finale) finale.update(time);
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
  // PCFSoft (desktop) ignores radius; plain PCF (phones) uses it as the 3x3 tap spread in texels
  sun.shadow.radius = QUALITY.softShadows ? 1 : 1.5;
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

  const apply = (t) => {
    bg.set(t.sky);
    fog.color.set(t.fog); fog.near = t.fogNear; fog.far = t.fogFar;
    hemi.color.set(t.hemiSky); hemi.groundColor.set(t.hemiGround); hemi.intensity = t.hemiIntensity;
    sun.color.set(t.sunColor); sun.intensity = t.sunIntensity;
  };
  // the final run: hell lighting down the run, warming up to the goal room's golden light as the camera gets there
  let blend = null, blendK = -1;
  const ca = new THREE.Color(), cb = new THREE.Color();
  const mixLight = (k) => {
    const A = HELL_LIGHT, B = HEAVEN_LIGHT, L = (a, b) => a + (b - a) * k;
    bg.copy(ca.set(A.sky)).lerp(cb.set(B.sky), k);
    fog.color.copy(ca.set(A.fog)).lerp(cb.set(B.fog), k); fog.near = L(A.fogNear, B.fogNear); fog.far = L(A.fogFar, B.fogFar);
    hemi.color.copy(ca.set(A.hemiSky)).lerp(cb.set(B.hemiSky), k);
    hemi.groundColor.copy(ca.set(A.hemiGround)).lerp(cb.set(B.hemiGround), k);
    hemi.intensity = L(A.hemiIntensity, B.hemiIntensity);
    sun.color.copy(ca.set(A.sunColor)).lerp(cb.set(B.sunColor), k); sun.intensity = L(A.sunIntensity, B.sunIntensity);
  };

  // levelData (optional): the final run's lighting follows the camera (see update)
  function setTheme(theme, levelData = null) {
    scene.fog = fog; scene.background = bg;
    blend = levelData && levelData.finale ? { x0: -levelData.roomHalf - 34, x1: -levelData.roomHalf + 2 } : null;
    blendK = -1;
    if (blend) { mixLight(0); return; }
    apply(THEMES[(((theme | 0) % THEMES.length) + THEMES.length) % THEMES.length]);
  }
  setTheme(0);

  function update(dt, time, focusX = 0, focusZ = 0) {
    if (blend) {
      const u = clamp((focusX - blend.x0) / (blend.x1 - blend.x0), 0, 1), k = u * u * (3 - 2 * u);
      if (Math.abs(k - blendK) > 0.002) { blendK = k; mixLight(k); }
    }
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
