import * as THREE from 'three';
import { CFG } from './shared/config.js';
import { QUALITY } from './device.js';

// models.js — procedural low-poly models for Run Kitty Run.
// All models face +X in local space, stand on y = 0.
// Notes / interpretations:
// - Static parts of each rig are baked into single vertex-colored geometries (cached per color/type) and
//   share ONE MeshStandardMaterial (flatShading, vertexColors) to keep draw calls and programs low.
// - Glowing parts use MeshBasicMaterial / ShaderMaterial (often additive) with colours kept <= 1, so nothing glares.
// - createKittyModel(...).setGhost(on, tint?) accepts an optional tint color (used by the revive circle).

// ---------------------------------------------------------------------------
// Caches & helpers
// ---------------------------------------------------------------------------
const GEO_CACHE = new Map();
const MAT_CACHE = new Map();
const TEX_CACHE = new Map();
// Cached resources are flagged userData.shared so disposeModel() leaves them alone.
// (cgeo may also cache a bundle of geometries — an object/array of them — flagged one by one.)
function shared(r) {
  if (r && r.userData) r.userData.shared = true;
  else if (r && typeof r === 'object') for (const v of Object.values(r)) shared(v);
  return r;
}
function cgeo(key, fn) { let g = GEO_CACHE.get(key); if (!g) { g = shared(fn()); GEO_CACHE.set(key, g); } return g; }
function cmat(key, fn) { let m = MAT_CACHE.get(key); if (!m) { m = shared(fn()); MAT_CACHE.set(key, m); } return m; }
function ctex(key, fn) { let t = TEX_CACHE.get(key); if (!t) { t = shared(fn()); TEX_CACHE.set(key, t); } return t; }

// Detach a model and free the GPU buffers / programs of everything it created itself (per-model geometries
// and materials). Shared (cached) geometries/materials and all textures are kept.
function disposeModel(root) {
  if (!root) return;
  root.removeFromParent();
  const done = new Set();
  const free = (r) => { if (r && !done.has(r) && !r.userData.shared) { done.add(r); r.dispose(); } };
  root.traverse((o) => {
    free(o.geometry);
    if (Array.isArray(o.material)) o.material.forEach(free); else free(o.material);
  });
}

const TAU_ = Math.PI * 2;
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function mtx(p, r, s) {
  const m = new THREE.Matrix4();
  _e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0);
  _q.setFromEuler(_e);
  _p.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
  if (s === undefined) _s.set(1, 1, 1);
  else if (typeof s === 'number') _s.set(s, s, s);
  else _s.set(s[0], s[1], s[2]);
  return m.compose(_p, _q, _s);
}

// Unit primitives (never rendered directly; baked).
const P = {
  ico1: new THREE.IcosahedronGeometry(1, 1),
  ico0: new THREE.IcosahedronGeometry(1, 0),
  cone4: new THREE.ConeGeometry(1, 1, 4),
  cone5: new THREE.ConeGeometry(1, 1, 5),
  cone6: new THREE.ConeGeometry(1, 1, 6),
  cyl6: new THREE.CylinderGeometry(1, 1, 1, 6),
  cyl8: new THREE.CylinderGeometry(1, 1, 1, 8),
  cyl18: new THREE.CylinderGeometry(1, 1, 1, 18),
  box: new THREE.BoxGeometry(1, 1, 1),
  oct: new THREE.OctahedronGeometry(1, 0),
  torus: new THREE.TorusGeometry(1, 0.32, 4, 10),
};
for (const g of Object.values(P)) shared(g);

// parts: [geometry, matrix, color | (x,y,z,outColor)=>void]
function bake(parts) {
  const pos = [];
  const col = [];
  for (const part of parts) {
    const src = part[0];
    const g = src.index ? src.toNonIndexed() : src.clone();
    g.applyMatrix4(part[1]);
    const a = g.attributes.position;
    const cc = part[2];
    const fn = typeof cc === 'function' ? cc : null;
    if (!fn) _c.set(cc);
    for (let i = 0; i < a.count; i++) {
      const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
      pos.push(x, y, z);
      if (fn) fn(x, y, z, _c);
      col.push(_c.r, _c.g, _c.b);
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

const VC_MAT = () => cmat('vc', () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0.0 }));

function basicGlow(key, hex, opts) {
  return cmat('glow:' + key + ':' + hex, () => new THREE.MeshBasicMaterial(Object.assign({
    color: hex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }, opts || {})));
}

function radialTexture() {
  return ctex('radial', () => {
    const S = 128;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    gr.addColorStop(0.7, 'rgba(255,255,255,0.15)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

function ringHaloTexture() {
  return ctex('ringHalo', () => {
    const S = 256;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,255,255,0.10)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.18)');
    gr.addColorStop(0.72, 'rgba(255,255,255,0.75)');
    gr.addColorStop(0.78, 'rgba(255,255,255,0.35)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

function runeTexture() {
  return ctex('runes', () => {
    const S = 1024;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    let seed = 1337;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    g.translate(S / 2, S / 2);
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
    const R = S / 2;
    const rO = R * 0.975, rI = R * 0.845, rM = (rO + rI) / 2;
    g.lineWidth = 7; g.beginPath(); g.arc(0, 0, rO - 6, 0, TAU_); g.stroke();
    g.lineWidth = 4; g.beginPath(); g.arc(0, 0, rI + 6, 0, TAU_); g.stroke();
    const n = 28;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU_;
      g.save(); g.rotate(a); g.translate(0, -rM);
      g.lineWidth = 5;
      const h = (rO - rI) * 0.26, w = h * 0.55;
      const strokes = 2 + Math.floor(rnd() * 3);
      g.beginPath(); g.moveTo(0, -h); g.lineTo(0, h); // spine
      for (let k = 0; k < strokes; k++) {
        const y0 = (rnd() * 2 - 1) * h, y1 = (rnd() * 2 - 1) * h;
        const sx = rnd() < 0.5 ? -1 : 1;
        g.moveTo(0, y0); g.lineTo(sx * w, y1);
        if (rnd() < 0.4) { g.lineTo(sx * w * 0.2, y1 + h * 0.4); }
      }
      g.stroke();
      if (rnd() < 0.5) { g.beginPath(); g.arc(rnd() < 0.5 ? -w : w, -h * 0.7, 5, 0, TAU_); g.fill(); }
      g.restore();
      g.save(); g.rotate(a + Math.PI / n); g.translate(0, -rM);
      g.beginPath(); g.arc(0, 0, 4, 0, TAU_); g.fill();
      g.restore();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

// Fresnel bubble shader (shields)
const FRESNEL_VS = `
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vP = position;
  gl_Position = projectionMatrix * mv;
}`;
const FRESNEL_FS = `
uniform vec3 uColor; uniform float uTime; uniform float uOpacity;
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(max(f, 0.0), 2.4);
  float band = 0.5 + 0.5 * sin(vP.y * 13.0 - uTime * 3.2 + sin(vP.x * 5.0 + uTime) * 1.6);
  float hex = smoothstep(0.82, 1.0, abs(sin(vP.x * 11.0 + uTime * 0.7) * sin(vP.y * 11.0) * sin(vP.z * 11.0 - uTime * 0.5)));
  vec3 col = uColor * (0.06 + rim * 0.75 + band * rim * 0.25 + hex * 0.15);
  gl_FragColor = vec4(col * uOpacity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
function makeFresnelMaterial(hex, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(hex) }, uTime: { value: 0 }, uOpacity: { value: opacity === undefined ? 1 : opacity } },
    vertexShader: FRESNEL_VS, fragmentShader: FRESNEL_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

// Vertical gradient beam shader (portal)
const BEAM_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const BEAM_FS = `
uniform vec3 uColor; uniform float uIntensity; uniform float uTime;
varying vec2 vUv;
void main(){
  float fade = pow(max(1.0 - vUv.y, 0.0), 1.6) * smoothstep(0.0, 0.06, vUv.y + 0.02); // max: pow of a negative is NaN (MSAA can push vUv.y past 1), which renders as black
  float streak = 0.65 + 0.35 * sin(vUv.y * 18.0 - uTime * 5.0 + vUv.x * 6.2832 * 3.0);
  gl_FragColor = vec4(uColor * fade * streak * uIntensity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Swirl shader (portal floor)
const SWIRL_VS = `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const SWIRL_FS = `
uniform float uTime; uniform float uIntensity; uniform float uR; uniform vec3 uColA; uniform vec3 uColB;
varying vec2 vP;
void main(){
  vec2 p = vP / uR;
  float r = length(p);
  float a = atan(p.y, p.x);
  float s1 = smoothstep(0.25, 1.0, sin(a * 3.0 + r * 9.0 - uTime * 1.6));
  float s2 = smoothstep(0.5, 1.0, sin(a * 5.0 - r * 15.0 + uTime * 2.3));
  float edge = smoothstep(1.0, 0.82, r);
  float core = exp(-r * 5.0);
  float rimGlow = smoothstep(0.75, 0.97, r) * edge;
  vec3 col = mix(uColB, uColA, smoothstep(0.0, 0.9, r)) * (s1 * 0.55 + s2 * 0.3 + 0.08) * edge;
  col += uColB * core * 0.6 + uColA * rimGlow * 0.5;
  gl_FragColor = vec4(col * uIntensity, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Flat dashed ring in the XZ plane (y = 0), normals +Y.
function dashedRingGeometry(r0, r1, dashes, fill, sub) {
  const pos = [];
  const step = TAU_ / dashes;
  for (let d = 0; d < dashes; d++) {
    const a0 = d * step, a1 = a0 + step * fill;
    for (let k = 0; k < sub; k++) {
      const t0 = a0 + (a1 - a0) * k / sub, t1 = a0 + (a1 - a0) * (k + 1) / sub;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      pos.push(r0 * c0, 0, r0 * s0, r1 * c1, 0, r1 * s1, r1 * c0, 0, r1 * s0);
      pos.push(r0 * c0, 0, r0 * s0, r0 * c1, 0, r0 * s1, r1 * c1, 0, r1 * s1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function flatRing(r0, r1, segs) {
  const g = new THREE.RingGeometry(r0, r1, segs, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}
function flatDisc(r, segs) {
  const g = new THREE.CircleGeometry(r, segs);
  g.rotateX(-Math.PI / 2);
  return g;
}

function smoothTo(cur, target, rate, dt) { return cur + (target - cur) * Math.min(1, dt * rate); }

// ---------------------------------------------------------------------------
// Kitty
// ---------------------------------------------------------------------------
const PINK = 0xff8fb0;
const EYE_WHITE = 0xffffff;
const PUPIL = 0x1b1424;

function kittyPalette(color) {
  const base = new THREE.Color(color);
  const light = base.clone().lerp(new THREE.Color(0xffffff), 0.62);
  const dark = base.clone().multiplyScalar(0.6);
  return { base, light, dark };
}

const K_HEAD_POS = [0.22, 0.53, 0];
const K_EYE_Y = 0.035;

const BOOT_RED = 0xe2493b, BOOT_CUFF = 0xffd36b;
const SKATE_BOOT = 0xf4f6fa, SKATE_SOLE = 0x5b6472, SKATE_BLADE = 0x8e9cae;

function kittyGeos(color) {
  const key = 'kitty:' + new THREE.Color(color).getHexString();
  return cgeo(key, () => {
    const { base, light, dark } = kittyPalette(color);
    const body = bake([
      [P.ico1, mtx([-0.05, 0.34, 0], null, [0.3, 0.21, 0.23]), base],
      [P.ico1, mtx([-0.03, 0.28, 0], null, [0.24, 0.15, 0.19]), light],
      [P.ico1, mtx([0.13, 0.37, 0], null, [0.14, 0.16, 0.16]), light],
      [P.ico1, mtx([-0.21, 0.3, 0.1], null, [0.12, 0.13, 0.09]), base],
      [P.ico1, mtx([-0.21, 0.3, -0.1], null, [0.12, 0.13, 0.09]), base],
      // tabby stripes on the back
      [P.box, mtx([-0.02, 0.538, 0], [0, 0, 0.05], [0.045, 0.02, 0.2]), dark],
      [P.box, mtx([-0.12, 0.525, 0], [0, 0, 0.3], [0.045, 0.02, 0.19]), dark],
      [P.box, mtx([-0.21, 0.485, 0], [0, 0, 0.6], [0.04, 0.02, 0.16]), dark],
    ]);
    const head = bake([
      [P.ico1, mtx([0, 0, 0], null, [0.2, 0.18, 0.21]), base],
      [P.ico1, mtx([0.04, -0.05, 0.1], null, [0.12, 0.1, 0.11]), base], // cheeks
      [P.ico1, mtx([0.04, -0.05, -0.1], null, [0.12, 0.1, 0.11]), base],
      [P.ico1, mtx([0.16, -0.06, 0.045], null, [0.065, 0.055, 0.06]), light], // muzzle puffs
      [P.ico1, mtx([0.16, -0.06, -0.045], null, [0.065, 0.055, 0.06]), light],
      [P.ico1, mtx([0.13, -0.1, 0], null, [0.05, 0.035, 0.045]), light], // chin
      [P.ico0, mtx([0.215, -0.025, 0], [0, 0, 0.3], [0.028, 0.022, 0.035]), PINK], // nose
      [P.box, mtx([0.03, 0.175, 0], [0, 0, -0.15], [0.03, 0.02, 0.09]), dark],
      [P.box, mtx([-0.03, 0.18, 0.05], [0, 0.4, 0], [0.025, 0.02, 0.06]), dark],
      [P.box, mtx([-0.03, 0.18, -0.05], [0, -0.4, 0], [0.025, 0.02, 0.06]), dark],
    ]);
    // eyes, baked relative to the eye pivot (head local y = K_EYE_Y)
    const eyeParts = [];
    for (const sz of [1, -1]) {
      const d = new THREE.Vector3(0.74, 0.17, 0.56 * sz).normalize();
      const w = d.clone().multiplyScalar(0.165);
      const pu = d.clone().multiplyScalar(0.198);
      const hi = d.clone().multiplyScalar(0.226);
      const yaw = Math.atan2(-d.z, d.x);
      eyeParts.push([P.ico1, mtx([w.x, w.y - K_EYE_Y, w.z], [0, yaw, 0], [0.05, 0.072, 0.062]), EYE_WHITE]);
      eyeParts.push([P.ico1, mtx([pu.x, pu.y - K_EYE_Y - 0.004, pu.z], [0, yaw, 0], [0.03, 0.058, 0.044]), PUPIL]);
      eyeParts.push([P.ico0, mtx([hi.x, hi.y - K_EYE_Y + 0.022, hi.z + 0.004 * sz], null, 0.014), EYE_WHITE]);
    }
    const eyes = bake(eyeParts);
    const ear = bake([
      [P.cone4, mtx([0, 0.08, 0], [0, Math.PI / 4, 0], [0.09, 0.17, 0.08]), base],
      [P.cone4, mtx([0.025, 0.065, 0], [0, Math.PI / 4, 0], [0.055, 0.12, 0.05]), PINK],
    ]);
    const leg = bake([
      [P.cyl6, mtx([0, -0.1, 0], null, [0.052, 0.21, 0.052]), base],
      [P.ico1, mtx([0.015, -0.215, 0], null, [0.064, 0.044, 0.058]), light],
    ]);
    const tailSeg = bake([
      [P.cyl6, mtx([0, 0.045, 0], null, [0.04, 0.1, 0.04]), base],
      [P.ico0, mtx([0, 0.0, 0], null, 0.042), base],
    ]);
    const tailTip = bake([
      [P.ico1, mtx([0, 0.05, 0], null, [0.045, 0.075, 0.045]), light],
      [P.ico0, mtx([0, 0.0, 0], null, 0.04), base],
    ]);
    // ice skate, in leg space (paw at y -0.215, +x = forward): white boot, steel blade with a curled toe
    const skate = bake([
      [P.ico1, mtx([0.02, -0.2, 0], null, [0.085, 0.06, 0.075]), SKATE_BOOT],
      [P.cyl8, mtx([0.0, -0.155, 0], null, [0.062, 0.05, 0.062]), SKATE_BOOT],
      [P.box, mtx([0.01, -0.235, 0], null, [0.1, 0.022, 0.05]), SKATE_SOLE],
      [P.box, mtx([0.01, -0.27, 0], null, [0.21, 0.045, 0.016]), SKATE_BLADE],
      [P.box, mtx([0.12, -0.25, 0], [0, 0, 0.9], [0.06, 0.025, 0.016]), SKATE_BLADE],
      [P.box, mtx([0.0, -0.13, 0], null, [0.07, 0.012, 0.07]), dark],
    ]);
    // speed boot (one per pair picked up), in leg space: red boot with a gold cuff and little white wings,
    // a touch bigger than the skate boot so it covers it on ice
    const speedBoot = bake([
      [P.ico1, mtx([0.025, -0.205, 0], null, [0.092, 0.07, 0.082]), BOOT_RED],
      [P.cyl8, mtx([0.0, -0.15, 0], null, [0.066, 0.09, 0.066]), BOOT_RED],
      [P.cyl8, mtx([0.0, -0.1, 0], null, [0.072, 0.028, 0.072]), BOOT_CUFF],
      [P.box, mtx([-0.035, -0.13, 0.07], [0.5, 0, 0.5], [0.07, 0.03, 0.012]), 0xffffff],
      [P.box, mtx([-0.035, -0.13, -0.07], [-0.5, 0, 0.5], [0.07, 0.03, 0.012]), 0xffffff],
    ]);
    return { body, head, eyes, ear, leg, tailSeg, tailTip, skate, speedBoot };
  });
}

function whiskerGeo() {
  return cgeo('whiskers', () => {
    const pts = [];
    for (const sz of [1, -1]) {
      for (let i = 0; i < 3; i++) {
        const y = -0.04 + (i - 1) * 0.018;
        pts.push(0.19, y, 0.05 * sz, 0.3, y + (i - 1) * 0.03 + 0.01, 0.2 * sz);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  });
}

function ghostMaterial(tint) {
  const key = tint === undefined || tint === null ? 'ghost' : 'ghost:' + new THREE.Color(tint).getHexString();
  return cmat(key, () => {
    const col = new THREE.Color(0xdcefff);
    const em = new THREE.Color(0x9cc8ff);
    if (key !== 'ghost') { const t = new THREE.Color(tint); col.lerp(t, 0.25); em.lerp(t, 0.35); }
    return new THREE.MeshStandardMaterial({
      color: col, emissive: em, emissiveIntensity: 0.45, flatShading: true,
      transparent: true, opacity: 0.42, depthWrite: false, roughness: 0.6,
    });
  });
}

// Gold crown (grabbed in the goal) and a super-saiyan flame aura (finished 3+ runs).
// Flame texture: a row of jagged tongues (tileable around a cylinder), solid at the bottom, fading up.
let auraTexCache = null;
const AURA_WHITE = new THREE.Color(0xffffff);
// crown stones (wins 2-6), in fill order: blue, yellow, red, purple, green
const STONE_COLORS = [0x3d7bff, 0xffd23d, 0xff3b4e, 0xa24dff, 0x30d97a];
const STONE_GEO = shared(new THREE.OctahedronGeometry(1, 0));
function stoneMat(n) {
  return cmat('stone' + n, () => new THREE.MeshStandardMaterial({ color: STONE_COLORS[n], emissive: STONE_COLORS[n], emissiveIntensity: 0.4, metalness: 0.2, roughness: 0.25, flatShading: true }));
}
function pearlMat() {
  return cmat('crownPearl', () => new THREE.MeshStandardMaterial({ color: 0xfff2b0, emissive: 0x7a4a00, emissiveIntensity: 0.6, metalness: 0.45, roughness: 0.35, flatShading: true }));
}
function auraTexture() {
  if (auraTexCache) return auraTexCache;
  const W = 256, H = 128;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, H, 0, 0);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  const N = 9; // tongues around (W must tile, so tips at fixed spacing)
  g.beginPath(); g.moveTo(0, H);
  for (let i = 0; i < N; i++) {
    const x0 = (i / N) * W, x1 = ((i + 1) / N) * W, tip = 4 + ((i * 37) % 5) * 7;
    g.lineTo(x0 + (x1 - x0) * 0.15, H * 0.62);
    g.quadraticCurveTo(x0 + (x1 - x0) * 0.35, H * 0.3, x0 + (x1 - x0) * 0.55, tip);
    g.quadraticCurveTo(x0 + (x1 - x0) * 0.62, H * 0.38, x1, H * 0.6);
  }
  g.lineTo(W, H); g.closePath(); g.fill();
  auraTexCache = shared(new THREE.CanvasTexture(c));
  auraTexCache.wrapS = THREE.RepeatWrapping;
  return auraTexCache;
}

function createKittyModel(color) {
  const G = kittyGeos(color);
  const mat = VC_MAT();
  const group = new THREE.Group();
  group.name = 'kitty';
  const rig = new THREE.Group();
  group.add(rig);

  const meshes = [];
  const mk = (geo, parent, shadow) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = !!shadow;
    parent.add(m);
    meshes.push(m);
    return m;
  };

  const bodyMesh = mk(G.body, rig, true);

  const head = new THREE.Group();
  head.position.set(K_HEAD_POS[0], K_HEAD_POS[1], K_HEAD_POS[2]);
  rig.add(head);
  mk(G.head, head, true);
  const eyes = mk(G.eyes, head, false);
  eyes.position.y = K_EYE_Y;
  const ears = [];
  for (const sz of [1, -1]) {
    const p = new THREE.Group();
    p.position.set(-0.03, 0.14, 0.1 * sz);
    p.rotation.x = 0.38 * sz;
    head.add(p);
    mk(G.ear, p, true);
    ears.push(p);
  }
  const whiskerMat = cmat('whiskerMat', () => new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
  const whiskers = new THREE.LineSegments(whiskerGeo(), whiskerMat);
  head.add(whiskers);

  // legs: 0 FL, 1 FR, 2 BL, 3 BR
  const legs = [];
  const skates = [];
  const speedBoots = [];   // one per leg, shown for each pair of speed boots (FL, FR, BL, BR)
  const rainbowBoots = [];
  const rainbowMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.45, flatShading: true, roughness: 0.45 });
  const rainbowOff = Math.random();
  const hips = [[0.12, 0.25, 0.105], [0.12, 0.25, -0.105], [-0.2, 0.25, 0.105], [-0.2, 0.25, -0.105]];
  for (const h of hips) {
    const p = new THREE.Group();
    p.position.set(h[0], h[1], h[2]);
    rig.add(p);
    mk(G.leg, p, true);
    skates.push(mk(G.skate, p, true));
    const sb = mk(G.speedBoot, p, true);
    sb.visible = false;
    speedBoots.push(sb);
    const rb = new THREE.Mesh(rainbowBootGeometry(), rainbowMat);   // 7+ wins: a rainbow shell over the red boot
    rb.visible = false;
    sb.add(rb);
    rainbowBoots.push(rb);
    legs.push(p);
  }

  // tail chain
  const tailRoot = new THREE.Group();
  tailRoot.position.set(-0.32, 0.4, 0);
  rig.add(tailRoot);
  const tail = [];
  const N_TAIL = 6, SEG_LEN = 0.085;
  const SWING_W = [0.3, 0.2, 0.15, 0.13, 0.12, 0.1]; // share of the skating turn bend per segment (base-heavy: the whole tail swings)
  let parent = tailRoot;
  for (let i = 0; i < N_TAIL; i++) {
    const seg = new THREE.Group();
    if (i > 0) seg.position.y = SEG_LEN;
    parent.add(seg);
    const m = mk(i === N_TAIL - 1 ? G.tailTip : G.tailSeg, seg, i < 3);
    const taper = 1 - i * 0.07;
    m.scale.set(taper, 1, taper);
    tail.push(seg);
    parent = seg;
  }

  // shield bubble
  const bubbleMat = makeFresnelMaterial(0x7fd6ff, 1);
  const bubble = new THREE.Mesh(cgeo('sphere24', () => new THREE.SphereGeometry(1, 24, 16)), bubbleMat);
  bubble.position.y = 0.4;
  bubble.visible = false;
  bubble.renderOrder = 5;
  group.add(bubble);

  const seedOff = Math.random() * 100;
  let phase = 0, runAmt = 0, clock = 0;
  let blinkT = 0, nextBlink = 1.5 + Math.random() * 3;
  let earT = 0, nextEar = 2 + Math.random() * 4, earSide = 0;
  let shieldAmt = 0;
  let ghost = false;
  // skating tail: yaw rate + glide speed/accel measured from the group's own transform, sprung swing + pitch that whip down the chain
  let prevYaw = null, prevX = 0, prevZ = 0, yawVel = 0, glideSp = 0, glideAcc = 0, swing = 0, swingV = 0, pitch = 0, pitchV = 0;
  const segSw = new Array(N_TAIL).fill(0);

  function update(dt, s) {
    s = s || {};
    dt = Math.min(dt || 0, 0.1);
    clock += dt;
    const time = s.time !== undefined ? s.time : clock;
    const moving = !!s.moving;
    const sp = s.speed01 === undefined ? (moving ? 1 : 0) : Math.max(0, Math.min(1, s.speed01));
    runAmt = smoothTo(runAmt, moving ? Math.max(0.35, sp) : 0, 10, dt);
    phase += dt * (10 + 8 * sp) * (runAmt > 0.01 ? 1 : 0);
    const sn = Math.sin(phase);
    const idle = 1 - Math.min(1, runAmt);
    const breath = Math.sin(time * 2.6 + seedOff);

    // legs (diagonal pairs)
    const amp = 0.95 * runAmt;
    legs[0].rotation.z = sn * amp;
    legs[3].rotation.z = sn * amp * 0.9;
    legs[1].rotation.z = -sn * amp;
    legs[2].rotation.z = -sn * amp * 0.9;

    // body bob + squash/stretch
    const bounce = Math.abs(Math.sin(phase));
    const sq = Math.cos(phase * 2) * 0.07 * runAmt;
    const onSkates = !!s.skates;
    for (const sk of skates) sk.visible = onSkates;
    const nb = s.boots | 0;
    for (let i = 0; i < speedBoots.length; i++) speedBoots[i].visible = i < nb;
    // 7+ wins: rainbow boots, a full rainbow every ~2.2 s on their own clock (not in step with the aura's colour cycle)
    const rainbow = !!s.rainbowBoots && !ghost && nb > 0;
    for (const rb of rainbowBoots) rb.visible = rainbow;
    if (rainbow) { rainbowMat.color.setHSL((time * 0.45 + rainbowOff) % 1, 1, 0.58); rainbowMat.emissive.copy(rainbowMat.color); }
    rig.position.y = bounce * 0.07 * runAmt + (onSkates ? 0.045 : 0);
    const by = 1 - sq + breath * 0.022 * idle;
    rig.scale.set(1 + sq * 0.5, by, 1 + sq * 0.4 - breath * 0.01 * idle);
    rig.rotation.z = -0.1 * runAmt + Math.sin(phase * 2) * 0.03 * runAmt;
    bodyMesh.position.y = 0;

    // head counter-bob + idle look
    head.position.y = K_HEAD_POS[1] - bounce * 0.045 * runAmt + 0.025 * runAmt;
    head.rotation.z = 0.1 * runAmt + Math.sin(phase * 2 + 0.6) * 0.05 * runAmt + Math.sin(time * 0.9 + seedOff) * 0.05 * idle;
    head.rotation.x = Math.sin(time * 0.55 + seedOff) * 0.12 * idle;
    head.rotation.y = Math.sin(time * 0.37 + seedOff * 2) * 0.2 * idle;

    // ears: flatten back when running, occasional twitch at idle
    earT -= dt;
    if (earT <= 0 && clock > nextEar) { earT = 0.18; nextEar = clock + 2 + Math.random() * 4; earSide = Math.random() < 0.5 ? 0 : 1; }
    for (let i = 0; i < 2; i++) {
      const sz = i === 0 ? 1 : -1;
      const tw = earT > 0 && earSide === i ? Math.sin((0.18 - earT) / 0.18 * Math.PI) * 0.5 : 0;
      ears[i].rotation.z = 0.35 * runAmt + tw * 0.6;
      ears[i].rotation.x = (0.38 + 0.15 * runAmt + tw * 0.3) * sz;
    }

    // skating: turn rate (wrap-safe), glide speed and its change from frame to frame; teleport/respawn frames are skipped
    const yaw = group.rotation.y, gx = group.position.x, gz = group.position.z, step = Math.hypot(gx - prevX, gz - prevZ);
    if (prevYaw !== null && dt > 0 && step < 1.5) {
      const dy = Math.atan2(Math.sin(yaw - prevYaw), Math.cos(yaw - prevYaw));
      yawVel = smoothTo(yawVel, Math.max(-8, Math.min(8, dy / dt)), 25, dt);
      const g = smoothTo(glideSp, Math.min(10, step / dt), 6, dt);
      glideAcc = smoothTo(glideAcc, Math.max(-20, Math.min(20, (g - glideSp) / dt)), 8, dt);
      glideSp = g;
    }
    prevYaw = yaw; prevX = gx; prevZ = gz;
    const skateAmt = onSkates ? idle : 0;                       // running anim untouched
    const glide = skateAmt * Math.min(1, glideSp / CFG.KITTY_SPEED);
    const back = Math.max(runAmt, skateAmt * Math.min(1, glideSp / 2.5)); // gliding: swept back like the running pose
    // floppy underdamped springs: the tail bends to the inside of a turn (along the line you carve) and whips past
    // when the turn ends; it streams back when you speed up and flicks up when you slow down. Substepped.
    const swT = Math.max(-1.3, Math.min(1.3, -yawVel * 0.35)) * skateAmt;
    const piT = Math.max(-0.6, Math.min(0.3, glideAcc * 0.08)) * skateAmt;
    for (let n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n; n > 0; n--) {
      swingV += ((swT - swing) * 80 - swingV * 8) * h;
      swing += swingV * h;
      pitchV += ((piT - pitch) * 40 - pitchV * 5) * h;
      pitch += pitchV * h;
    }
    for (let i = 0; i < N_TAIL; i++) segSw[i] = i === 0 ? swing : smoothTo(segSw[i], segSw[i - 1], 25, dt); // each segment lags the one before

    // tail: lagging swish (+ on ice: streams back while gliding, swings out on turns, flicks on speed changes)
    tailRoot.rotation.z = 0.95 + 0.6 * back + pitch;
    for (let i = 0; i < tail.length; i++) {
      const lag = i * 0.55;
      tail[i].rotation.x = Math.sin(phase * 0.5 - lag) * 0.28 * runAmt + Math.sin(time * 1.7 + seedOff - lag) * 0.2 * idle * (1 - 0.75 * glide)
        + Math.sin(time * 5.5 + seedOff - lag * 1.4) * 0.06 * glide + segSw[i] * SWING_W[i];
      tail[i].rotation.z = i === 0 ? 0 : (-0.26 * (1 - back * 0.6) + Math.sin(phase - lag) * 0.08 * runAmt + Math.sin(time * 2.3 + seedOff - lag) * 0.05 * glide);
    }

    // blink
    if (!ghost) {
      if (blinkT > 0) blinkT -= dt;
      else if (clock > nextBlink) { blinkT = 0.13; nextBlink = clock + 2 + Math.random() * 3.5; }
      eyes.scale.y = blinkT > 0 ? 0.12 : 1;
    }

    // invulnerability blink
    const inv = s.invuln || 0;
    rig.visible = !(inv > 0 && Math.floor(time * 12) % 2 === 1);

    // shield
    const sh = s.shield || 0;
    shieldAmt = smoothTo(shieldAmt, sh > 0 ? 1 : 0, sh > 0 ? 14 : 8, dt);
    bubble.visible = shieldAmt > 0.02;
    if (bubble.visible) {
      const wob = 1 + Math.sin(time * 6) * 0.03;
      const pop = shieldAmt < 1 ? (1 + (1 - shieldAmt) * 0.25) : 1;
      bubble.scale.set(0.62 * wob * pop * shieldAmt, 0.6 * pop * (2 - wob) * shieldAmt, 0.62 * wob * pop * shieldAmt);
      bubble.rotation.y = time * 0.8;
      let op = shieldAmt;
      if (sh > 0 && sh < 1.2) op *= Math.sin(time * 28) > 0 ? 1 : 0.35;
      bubbleMat.uniforms.uOpacity.value = op;
      bubbleMat.uniforms.uTime.value = time;
    }
  }

  function setGhost(on, tint) {
    ghost = !!on;
    const gm = ghostMaterial(tint);
    for (const m of meshes) {
      m.material = ghost ? gm : mat;
      m.castShadow = ghost ? false : (m.userData.shadow !== undefined ? m.userData.shadow : m.castShadow);
    }
    whiskers.visible = !ghost;
    eyes.scale.y = ghost ? 0.12 : 1;
  }
  for (const m of meshes) m.userData.shadow = m.castShadow;

  // crown sits on the head (follows its bob/tilt)
  const crown = new THREE.Mesh(chunkyCrownGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0x7a4a00, emissiveIntensity: 0.6, metalness: 0.45, roughness: 0.35, flatShading: true }));
  crown.position.set(-0.02, 0.25, 0);
  crown.rotation.z = -0.12;
  crown.scale.setScalar(1.76);
  crown.castShadow = true;
  crown.visible = false;
  head.add(crown);
  // sunglasses (5+ wins): dark lenses just in front of the eyes, gold bridge, arms back to the ears
  const shades = new THREE.Mesh(sunglassesGeometry(), cmat('shades', () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.2, metalness: 0.35 })));
  shades.visible = false;
  head.add(shades);
  // crown stones: a win from 2 to 6 sets one gem on a point (front first, then pairs toward the back), in place of its pearl
  const tips = [0, 1, 4, 2, 3].map((i, n) => {
    const a = (i / 5) * TAU_, pearl = new THREE.Mesh(P.ico1, pearlMat());
    pearl.position.set(Math.cos(a) * 0.11, 0.17, Math.sin(a) * 0.11); pearl.scale.setScalar(0.022);
    const stone = new THREE.Mesh(STONE_GEO, stoneMat(n));
    stone.position.set(pearl.position.x, 0.2, pearl.position.z); stone.visible = false;
    crown.add(pearl, stone);
    return { pearl, stone, born: -1 };
  });
  // aura: super-saiyan flames in the kitty's own colour. The outer flame shell uses normal blending so it
  // still shows on bright snow/ice (additive light vanishes there); an additive inner core adds the glow.
  const auraCol = new THREE.Color(color);
  const hot = auraCol.clone().lerp(new THREE.Color(0xffffff), 0.45);
  const flameTex = auraTexture();
  const outerMat = new THREE.MeshBasicMaterial({ map: flameTex, color: auraCol, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
  const innerMat = new THREE.MeshBasicMaterial({ map: flameTex, color: hot.clone().multiplyScalar(0.75), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const aura = new THREE.Group();
  // flares outward toward the top, like the classic aura
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.5, 1.7, 36, 1, true), outerMat);
  outer.position.y = 0.85;
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.42, 1.25, 30, 1, true), innerMat);
  inner.position.y = 0.62;
  const ringMat = new THREE.MeshBasicMaterial({ color: auraCol, transparent: true, opacity: 0.6, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.8, 40), ringMat);
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.035;
  // rising sparks
  const NS = 16;
  const sparkPos = new Float32Array(NS * 3);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ color: hot, size: 0.09, transparent: true, opacity: 0.95, depthWrite: false }));
  sparks.frustumCulled = false;
  const sparkSeed = [];
  for (let i = 0; i < NS; i++) sparkSeed.push([Math.random() * TAU_, 0.35 + Math.random() * 0.45, Math.random(), 0.8 + Math.random() * 0.7]);
  aura.add(outer, inner, ring, sparks);
  for (const o of aura.children) o.renderOrder = 3; // after floor marks (skate trail, decals: 1-2)
  aura.visible = false;
  group.add(aura);
  const baseUpdate = update;
  // munching (the final run's giant fish): head down into the food, bobbing, happy squinty eyes; every bite
  // (s.bites counts up) is a quick chomp
  let munchAmt = 0, munchPh = 0, chompT = 0, lastBites = 0;
  function updateAll(dt, s) {
    baseUpdate(dt, s);
    s = s || {};
    const t = s.time || 0;
    const mdt = Math.min(dt || 0, 0.1);
    munchAmt = smoothTo(munchAmt, s.munch ? 1 : 0, 9, mdt);
    if ((s.bites | 0) !== lastBites) { if ((s.bites | 0) > lastBites) chompT = 0.2; lastBites = s.bites | 0; }
    chompT = Math.max(0, chompT - mdt);
    if (munchAmt > 0.01) {
      munchPh += mdt * 13;
      const ch = chompT > 0 ? Math.sin((chompT / 0.2) * Math.PI) : 0;
      head.rotation.z -= munchAmt * (0.42 + 0.14 * Math.sin(munchPh) + 0.22 * ch);
      head.rotation.x *= 1 - munchAmt;
      head.rotation.y = head.rotation.y * (1 - munchAmt) + Math.sin(munchPh * 0.5) * 0.12 * munchAmt;
      head.position.y -= munchAmt * (0.07 + 0.03 * Math.abs(Math.sin(munchPh)));
      head.position.x = K_HEAD_POS[0] + munchAmt * 0.05;
      head.scale.set(1, 1 - 0.1 * ch, 1 + 0.06 * ch);
      rig.rotation.z -= munchAmt * 0.12;
      if (!ghost && blinkT <= 0) eyes.scale.y = 1 - 0.7 * munchAmt;   // ^ ^
    } else if (head.position.x !== K_HEAD_POS[0]) { head.position.x = K_HEAD_POS[0]; head.scale.set(1, 1, 1); }
    crown.visible = !!s.crown && rig.visible;
    shades.visible = !!s.sunglasses && !ghost;
    if (crown.visible) {
      crown.position.y = 0.25 + Math.sin(t * 3) * 0.008;
      tips.forEach((p, n) => {
        const on = n < (s.crownStones || 0);
        if (on && p.born < 0) p.born = t;
        if (!on) p.born = -1;
        p.pearl.visible = !on; p.stone.visible = on;
        if (!on) return;
        // pop in with a little overshoot, then a gentle spin
        const v = Math.min(1, (t - p.born) / 0.4) - 1, k = 1 + 2.70158 * v * v * v + 1.70158 * v * v; // ease-out-back
        p.stone.scale.set(0.016 * k, 0.024 * k, 0.016 * k);
        p.stone.rotation.y = t * 1.6 + n;
      });
    }
    aura.visible = !!s.aura;
    if (aura.visible) {
      if (s.auraColor) { // live recolour (6+ finishes cycle through the cat colours)
        outerMat.color.copy(s.auraColor); ringMat.color.copy(s.auraColor);
        sparks.material.color.copy(s.auraColor).lerp(AURA_WHITE, 0.45);
        innerMat.color.copy(sparks.material.color).multiplyScalar(0.75);
      }
      // flicker: tongues scroll around, the shell pulses and stretches
      flameTex.offset.x = (t * 0.35) % 1;
      outer.rotation.y = t * 1.3; inner.rotation.y = -t * 1.9;
      const f = Math.sin(t * 17) * 0.5 + Math.sin(t * 29 + 1.3) * 0.5;
      outer.scale.set(1 + 0.04 * f, 1 + 0.12 * Math.abs(f), 1 + 0.04 * f);
      inner.scale.set(1, 1 + 0.15 * Math.abs(Math.sin(t * 23)), 1);
      // brightness only breathes gently (fast strong flicker strained the eyes); the shape still flickers
      outerMat.opacity = 0.5 + 0.06 * f;
      innerMat.opacity = 0.45 + 0.06 * Math.sin(t * 13);
      ringMat.opacity = 0.35 + 0.05 * f;
      for (let i = 0; i < NS; i++) {
        const [a, r, ph, sp] = sparkSeed[i];
        const u = (t * sp * 0.8 + ph) % 1;
        sparkPos[i * 3] = Math.cos(a + t * 0.5) * r * (1 + u * 0.4);
        sparkPos[i * 3 + 1] = 0.1 + u * 1.9;
        sparkPos[i * 3 + 2] = Math.sin(a + t * 0.5) * r * (1 + u * 0.4);
      }
      sparkGeo.attributes.position.needsUpdate = true;
    }
  }

  updateAll(0, {});
  return { group, update: updateAll, setGhost };
}

// ---------------------------------------------------------------------------
// Wolf
// ---------------------------------------------------------------------------
const WOLF_TYPES = {
  patroller: { base: 0x8a909c, light: 0xd8dce4, dark: 0x464b57, accent: 0xffc23d },
  wanderer: { base: 0x8c5a38, light: 0xdcb48a, dark: 0x45291a, accent: 0xff8a2a },
  // Skate-only pattern wolves: wintry coats and a scarf in the type color. `track` = route color on ice.
  charger: { base: 0x343a4c, light: 0xaab4cc, dark: 0x181b26, accent: 0xff2a55, scarf: 0xd0163f, track: 0xe0244c },
  crosser: { base: 0xc9d6e8, light: 0xf6f9ff, dark: 0x5f7499, accent: 0x18d6ff, scarf: 0x1886c8, track: 0x0f8fd0 },
  diagonal: { base: 0x54477e, light: 0xc4b6ec, dark: 0x251c44, accent: 0xb85cff, scarf: 0x7e34d8, track: 0x8f3ff0 },
};

function wolfGeos(type) {
  return cgeo('wolf:' + type, () => {
    const T = WOLF_TYPES[type];
    const { base, light, dark } = T;
    const body = [
      [P.ico1, mtx([-0.08, 0.6, 0], null, [0.46, 0.23, 0.24]), base],
      [P.ico1, mtx([0.24, 0.63, 0], null, [0.26, 0.29, 0.26]), base],
      [P.ico0, mtx([0.36, 0.55, 0], [0, 0, 0.3], [0.18, 0.22, 0.19]), light],
      [P.ico1, mtx([-0.05, 0.51, 0], null, [0.36, 0.13, 0.18]), light],
      [P.ico1, mtx([-0.04, 0.71, 0], null, [0.42, 0.11, 0.16]), dark],
      [P.ico1, mtx([-0.36, 0.57, 0.12], null, [0.17, 0.2, 0.12]), base],
      [P.ico1, mtx([-0.36, 0.57, -0.12], null, [0.17, 0.2, 0.12]), base],
      [P.ico1, mtx([0.3, 0.55, 0.13], null, [0.13, 0.18, 0.12]), base],
      [P.ico1, mtx([0.3, 0.55, -0.13], null, [0.13, 0.18, 0.12]), base],
    ];
    // spiky scruff along the back
    const spikes = [[0.36, 0.86, 0.09], [0.22, 0.88, 0.1], [0.08, 0.81, 0.08], [-0.08, 0.77, 0.07], [-0.24, 0.75, 0.06]];
    for (const [x, y, s] of spikes) body.push([P.cone4, mtx([x, y, 0], [0, Math.PI / 4, 0.75], [s * 0.8, s * 2.1, s * 0.8]), dark]);
    for (const sz of [1, -1]) body.push([P.cone4, mtx([0.32, 0.8, 0.12 * sz], [0.5 * sz, 0, 0.6], [0.06, 0.16, 0.06]), base]);
    if (T.scarf) {
      // scarf: a ring round the neck + two tails streaming back over the shoulder
      const sc = new THREE.Color(T.scarf), sd = sc.clone().multiplyScalar(0.62);
      body.push([P.torus, mtx([0.36, 0.68, 0], [0, Math.PI / 2, 0.55], [0.2, 0.2, 0.28]), sc]);
      body.push([P.box, mtx([0.12, 0.8, 0.09], [0.15, 0.1, 0.35], [0.3, 0.045, 0.1]), sc]);
      body.push([P.box, mtx([-0.08, 0.84, 0.13], [0.25, 0.2, 0.1], [0.22, 0.04, 0.09]), sd]);
      body.push([P.box, mtx([-0.17, 0.85, 0.15], [0.25, 0.2, 0.1], [0.05, 0.05, 0.1]), 0xffffff]);
    }

    const head = bake([
      [P.ico1, mtx([0, 0, 0], null, [0.2, 0.17, 0.18]), base],
      [P.ico1, mtx([-0.02, 0.075, 0], null, [0.15, 0.09, 0.13]), dark],
      [P.ico0, mtx([-0.05, -0.07, 0.13], null, [0.1, 0.08, 0.07]), light],
      [P.ico0, mtx([-0.05, -0.07, -0.13], null, [0.1, 0.08, 0.07]), light],
      [P.cone5, mtx([0.26, -0.035, 0], [0, 0, -Math.PI / 2], [0.105, 0.4, 0.095]), base],
      [P.ico1, mtx([0.2, -0.08, 0], null, [0.17, 0.045, 0.08]), light],
      [P.ico0, mtx([0.455, -0.03, 0], null, [0.05, 0.045, 0.05]), 0x161318],
      // ears
      [P.cone4, mtx([-0.06, 0.24, 0.1], [0.3, Math.PI / 4, 0], [0.085, 0.24, 0.075]), dark],
      [P.cone4, mtx([-0.06, 0.24, -0.1], [-0.3, Math.PI / 4, 0], [0.085, 0.24, 0.075]), dark],
      [P.cone4, mtx([-0.04, 0.22, 0.1], [0.3, Math.PI / 4, 0], [0.05, 0.16, 0.045]), light],
      [P.cone4, mtx([-0.04, 0.22, -0.1], [-0.3, Math.PI / 4, 0], [0.05, 0.16, 0.045]), light],
      // angry brows
      [P.box, mtx([0.12, 0.09, 0.1], [0.25, 0, -0.45], [0.14, 0.035, 0.05]), dark],
      [P.box, mtx([0.12, 0.09, -0.1], [-0.25, 0, -0.45], [0.14, 0.035, 0.05]), dark],
      // fangs
      [P.cone4, mtx([0.33, -0.105, 0.045], [Math.PI, 0, 0], [0.018, 0.06, 0.018]), 0xffffff],
      [P.cone4, mtx([0.33, -0.105, -0.045], [Math.PI, 0, 0], [0.018, 0.06, 0.018]), 0xffffff],
    ]);
    const eyes = bake([
      [P.ico0, mtx([0.13, 0.035, 0.13], [0.3, -0.5, -0.3], [0.065, 0.034, 0.045]), 0xffffff],
      [P.ico0, mtx([0.13, 0.035, -0.13], [-0.3, 0.5, -0.3], [0.065, 0.034, 0.045]), 0xffffff],
    ]);
    const jaw = bake([
      [P.cone4, mtx([0.16, 0, 0], [0, Math.PI / 4, -Math.PI / 2], [0.065, 0.3, 0.065]), light],
      [P.cone4, mtx([0.22, 0.035, 0.03], null, [0.012, 0.04, 0.012]), 0xffffff],
      [P.cone4, mtx([0.22, 0.035, -0.03], null, [0.012, 0.04, 0.012]), 0xffffff],
    ]);
    const leg = bake([
      [P.ico1, mtx([0, -0.03, 0], null, [0.09, 0.1, 0.08]), base],
      [P.cyl6, mtx([0, -0.22, 0], null, [0.058, 0.42, 0.058]), base],
      [P.ico1, mtx([0.025, -0.455, 0], null, [0.08, 0.05, 0.07]), dark],
    ]);
    const tail = [
      bake([[P.ico1, mtx([0, 0.08, 0], null, [0.09, 0.12, 0.09]), base]]),
      bake([[P.ico1, mtx([0, 0.09, 0], null, [0.125, 0.16, 0.12]), base], [P.ico0, mtx([0.03, 0.06, 0], [0, 0, 0.4], [0.1, 0.12, 0.13]), dark]]),
      bake([[P.ico1, mtx([0, 0.06, 0], null, [0.1, 0.12, 0.1]), base], [P.ico1, mtx([0, 0.15, 0], null, [0.075, 0.1, 0.075]), light], [P.cone5, mtx([0, 0.26, 0], null, [0.045, 0.1, 0.045]), light]]),
    ];
    return { body: bake(body), head, eyes, jaw, leg, tail };
  });
}

function createWolfModel(type) {
  if (!WOLF_TYPES[type]) type = 'patroller';
  const T = WOLF_TYPES[type];
  const G = wolfGeos(type);
  const mat = VC_MAT();
  const group = new THREE.Group();
  group.name = 'wolf';
  const rig = new THREE.Group();
  group.add(rig);

  const body = new THREE.Mesh(G.body, mat); body.castShadow = true; rig.add(body);
  const head = new THREE.Group(); head.position.set(0.5, 0.8, 0); rig.add(head);
  const headMesh = new THREE.Mesh(G.head, mat); headMesh.castShadow = true; head.add(headMesh);

  const accent = new THREE.Color(T.accent);
  const eyeMat = new THREE.MeshBasicMaterial({ color: accent.clone() });
  const eyes = new THREE.Mesh(G.eyes, eyeMat); head.add(eyes);
  const jaw = new THREE.Group(); jaw.position.set(0.08, -0.09, 0); head.add(jaw);
  jaw.add(new THREE.Mesh(G.jaw, mat));

  const legs = [];
  const hips = [[0.3, 0.5, 0.13], [0.3, 0.5, -0.13], [-0.36, 0.5, 0.13], [-0.36, 0.5, -0.13]];
  for (const h of hips) {
    const p = new THREE.Group(); p.position.set(h[0], h[1], h[2]); rig.add(p);
    const m = new THREE.Mesh(G.leg, mat); m.castShadow = true; p.add(m);
    legs.push(p);
  }

  const tailRoot = new THREE.Group(); tailRoot.position.set(-0.5, 0.66, 0); rig.add(tailRoot);
  const tail = [];
  let parent = tailRoot;
  for (let i = 0; i < 3; i++) {
    const seg = new THREE.Group();
    if (i > 0) seg.position.y = i === 1 ? 0.13 : 0.17;
    parent.add(seg);
    const m = new THREE.Mesh(G.tail[i], mat); if (i === 1) m.castShadow = true; seg.add(m);
    tail.push(seg); parent = seg;
  }

  const seedOff = Math.random() * 100;
  let phase = Math.random() * 6, runAmt = 0, clock = 0;

  function update(dt, s) {
    s = s || {};
    dt = Math.min(dt || 0, 0.1);
    clock += dt;
    const time = s.time !== undefined ? s.time : clock;
    const moving = !!s.moving;
    const sp = s.speed01 === undefined ? (moving ? 1 : 0) : Math.max(0, Math.min(1, s.speed01));
    runAmt = smoothTo(runAmt, moving ? Math.max(0.45, sp) : 0, 9, dt);
    phase += dt * (7 + 7 * sp) * (runAmt > 0.01 ? 1 : 0);
    const sn = Math.sin(phase);
    const idle = 1 - Math.min(1, runAmt);

    // trot
    const amp = 0.7 * runAmt;
    legs[0].rotation.z = sn * amp;
    legs[3].rotation.z = sn * amp;
    legs[1].rotation.z = -sn * amp;
    legs[2].rotation.z = -sn * amp;
    rig.position.set(0, Math.abs(Math.cos(phase)) * 0.045 * runAmt - 0.02 * runAmt + Math.sin(time * 2 + seedOff) * 0.006 * idle, 0);
    rig.rotation.z = Math.sin(phase * 2) * 0.025 * runAmt - 0.05 * runAmt;

    head.position.y = 0.8 + Math.sin(phase * 2 + 1) * 0.02 * runAmt;
    head.position.x = 0.5;
    head.rotation.z = -0.08 * runAmt + Math.sin(time * 0.8 + seedOff) * 0.06 * idle;
    head.rotation.y = Math.sin(time * 0.5 + seedOff) * 0.35 * idle;
    jaw.rotation.z = -0.08 * runAmt * (0.5 + 0.5 * Math.sin(phase * 2));

    // tail: sways when trotting
    tailRoot.rotation.z = 2.05 - 0.15 * runAmt;
    for (let i = 0; i < tail.length; i++) {
      tail[i].rotation.x = Math.sin(phase - i * 0.7) * 0.25 * runAmt + Math.sin(time * 1.3 + seedOff - i * 0.6) * 0.15 * idle;
      if (i > 0) tail[i].rotation.z = -0.35;
    }
  }

  update(0, {});
  return { group, update };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
const ITEM_GLOW = { boots: 0x6fe0ff, life: 0xff5a8a, shield: 0x7ab8ff };

function itemDisc(type) {
  const m = new THREE.Mesh(
    cgeo('itemDisc', () => flatDisc(0.75, 24)),
    cmat('itemDisc:' + type, () => new THREE.MeshBasicMaterial({ map: radialTexture(), color: ITEM_GLOW[type], transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending })),
  );
  m.position.y = 0.03;
  m.renderOrder = 1;
  return m;
}

function bootGeos() {
  return cgeo('boots', () => {
    const red = 0xe2493b, sole = 0x5a3426, cuff = 0xffd36b, lace = 0xfff3e0;
    const boot = bake([
      [P.box, mtx([-0.03, 0.12, 0], null, [0.16, 0.26, 0.15]), red],
      [P.ico1, mtx([0.08, -0.02, 0], null, [0.17, 0.09, 0.09]), red],
      [P.box, mtx([0.03, -0.085, 0], null, [0.34, 0.04, 0.17]), sole],
      [P.cyl8, mtx([-0.03, 0.26, 0], null, [0.11, 0.06, 0.11]), cuff],
      [P.box, mtx([0.06, 0.07, 0], [0, 0, 0.6], [0.02, 0.1, 0.12]), lace],
    ]);
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.quadraticCurveTo(-0.06, 0.24, -0.3, 0.32);
    s.lineTo(-0.24, 0.23); s.lineTo(-0.36, 0.22); s.lineTo(-0.26, 0.13);
    s.lineTo(-0.35, 0.09); s.lineTo(-0.22, 0.04);
    s.quadraticCurveTo(-0.1, -0.02, 0, 0);
    const wg = new THREE.ShapeGeometry(s, 6);
    const wing = new THREE.BufferGeometry();
    const src = wg.toNonIndexed();
    const pa = src.attributes.position;
    const col = [];
    const cw = new THREE.Color(0xffffff), cg = new THREE.Color(0x7fe8ff);
    for (let i = 0; i < pa.count; i++) {
      const t = Math.min(1, Math.max(0, (-pa.getX(i) - 0.14) / 0.2));
      _c.copy(cw).lerp(cg, t * t);
      col.push(_c.r, _c.g, _c.b);
    }
    wing.setAttribute('position', pa.clone());
    wing.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    wg.dispose(); src.dispose();
    return { boot, wing };
  });
}

function heartGeo() {
  return cgeo('heart', () => {
    const s = new THREE.Shape();
    s.moveTo(0, -0.28);
    s.bezierCurveTo(0.06, -0.19, 0.34, -0.04, 0.29, 0.12);
    s.bezierCurveTo(0.26, 0.27, 0.07, 0.29, 0, 0.15);
    s.bezierCurveTo(-0.07, 0.29, -0.26, 0.27, -0.29, 0.12);
    s.bezierCurveTo(-0.34, -0.04, -0.06, -0.19, 0, -0.28);
    const ex = new THREE.ExtrudeGeometry(s, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.04, bevelSegments: 2, curveSegments: 7 });
    ex.translate(0, 0, -0.04);
    const pink = 0xff4f7d, inner = 0xffb3c8;
    return bake([
      [ex, new THREE.Matrix4(), pink],
      [P.cone4, mtx([0.17, 0.27, 0], [0, Math.PI / 4, -0.35], [0.09, 0.16, 0.07]), pink],
      [P.cone4, mtx([-0.17, 0.27, 0], [0, Math.PI / 4, 0.35], [0.09, 0.16, 0.07]), pink],
      [P.cone4, mtx([0.165, 0.265, 0.04], [0, Math.PI / 4, -0.35], [0.05, 0.11, 0.03]), inner],
      [P.cone4, mtx([-0.165, 0.265, 0.04], [0, Math.PI / 4, 0.35], [0.05, 0.11, 0.03]), inner],
      [P.ico1, mtx([0.1, 0.05, 0.09], null, [0.035, 0.048, 0.02]), 0x2a1520],
      [P.ico1, mtx([-0.1, 0.05, 0.09], null, [0.035, 0.048, 0.02]), 0x2a1520],
      [P.ico1, mtx([0.1, 0.05, -0.09], null, [0.035, 0.048, 0.02]), 0x2a1520],
      [P.ico1, mtx([-0.1, 0.05, -0.09], null, [0.035, 0.048, 0.02]), 0x2a1520],
      [P.ico1, mtx([0.17, -0.03, 0.085], null, [0.04, 0.025, 0.015]), 0xff9ab8],
      [P.ico1, mtx([-0.17, -0.03, 0.085], null, [0.04, 0.025, 0.015]), 0xff9ab8],
      [P.ico1, mtx([0.17, -0.03, -0.085], null, [0.04, 0.025, 0.015]), 0xff9ab8],
      [P.ico1, mtx([-0.17, -0.03, -0.085], null, [0.04, 0.025, 0.015]), 0xff9ab8],
    ]);
  });
}

function starGeo() {
  return cgeo('star', () => {
    const s = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = Math.PI / 2 + (i / 10) * TAU_;
      const r = i % 2 === 0 ? 0.17 : 0.075;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
    }
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 1 });
    g.translate(0, 0, -0.02);
    return g;
  });
}

function createItemModel(type) {
  const group = new THREE.Group();
  group.name = 'item:' + type;
  const float = new THREE.Group();
  float.scale.setScalar(1.3);
  const spin = new THREE.Group();
  float.add(spin);
  group.add(float);
  if (!ITEM_GLOW[type]) type = 'boots';
  group.add(itemDisc(type));
  const off = Math.random() * TAU_;
  let baseY = 0.6;
  let animate = null;

  if (type === 'boots') {
    const G = bootGeos();
    const boot = new THREE.Mesh(G.boot, VC_MAT()); boot.castShadow = QUALITY.propShadows; spin.add(boot);
    const wingMat = cmat('wingMat', () => new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    const wings = [];
    for (const sz of [1, -1]) {
      const p = new THREE.Group(); p.position.set(-0.08, 0.17, 0.085 * sz); spin.add(p);
      const w = new THREE.Mesh(G.wing, wingMat); p.add(w);
      wings.push({ p, sz });
    }
    spin.rotation.z = 0.12;
    animate = (t) => {
      const f = Math.sin(t * 9 + off);
      for (const w of wings) w.p.rotation.x = (0.35 + 0.45 * f) * w.sz;
    };
  } else if (type === 'life') {
    const heartMat = cmat('heartMat', () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, emissive: 0xff2a5a, emissiveIntensity: 0.35 }));
    const heart = new THREE.Mesh(heartGeo(), heartMat); heart.castShadow = QUALITY.propShadows; spin.add(heart);
    const halo = new THREE.Mesh(cgeo('haloTorus', () => new THREE.TorusGeometry(0.19, 0.022, 6, 28)), basicGlow('halo', 0xffd76a, { blending: THREE.NormalBlending, transparent: false, depthWrite: true }));
    halo.rotation.x = Math.PI / 2 - 0.25;
    halo.position.y = 0.45;
    float.add(halo);
    animate = (t) => {
      const b = 1 + Math.max(0, Math.sin(t * 5 + off)) * 0.08;
      heart.scale.set(b, b, b);
      halo.position.y = 0.45 + Math.sin(t * 3 + off) * 0.025;
      halo.rotation.z = t * 1.5;
    };
  } else if (type === 'shield') {
    baseY = 0.65;
    const orbMat = cmat('itemOrb', () => makeFresnelMaterial(0x7ab8ff, 1));
    const orb = new THREE.Mesh(cgeo('sphere24', () => new THREE.SphereGeometry(1, 24, 16)), orbMat);
    orb.scale.setScalar(0.33);
    orb.renderOrder = 4;
    float.add(orb);
    const starMat = cmat('starMat', () => new THREE.MeshStandardMaterial({ color: 0xffd34a, emissive: 0xffb020, emissiveIntensity: 0.45, flatShading: true, roughness: 0.4 }));
    const star = new THREE.Mesh(starGeo(), starMat); spin.add(star);
    animate = (t) => {
      orbMat.uniforms.uTime.value = t;
      star.rotation.y = t * 1.5;
      star.rotation.z = Math.sin(t * 2 + off) * 0.25;
    };
  }

  function update(dt, time) {
    const t = time === undefined ? performance.now() / 1000 : time;
    float.position.y = baseY + Math.sin(t * 2.4 + off) * 0.08;
    spin.rotation.y = t * 1.3 + off;
    if (animate) animate(t);
  }
  update(0, 0);
  return { group, update };
}

// ---------------------------------------------------------------------------
// Revive circle
// ---------------------------------------------------------------------------
function createReviveCircleModel(color) {
  const R = CFG.REVIVE_RADIUS;
  const group = new THREE.Group();
  group.name = 'reviveCircle';
  const col = new THREE.Color(color === undefined ? 0xffffff : color);

  const haloMat = new THREE.MeshBasicMaterial({ map: ringHaloTexture(), color: col.clone().multiplyScalar(0.8), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.Mesh(cgeo('reviveHalo', () => flatDisc(R / 0.75, 40)), haloMat);
  halo.position.y = 0.03; halo.renderOrder = 1; group.add(halo);

  const ringMat = new THREE.MeshBasicMaterial({ color: col.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(cgeo('reviveRing', () => flatRing(R - 0.07, R + 0.05, 56)), ringMat);
  ring.position.y = 0.04; ring.renderOrder = 2; group.add(ring);

  const dashMat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(0.85), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const dash = new THREE.Mesh(cgeo('reviveDash', () => dashedRingGeometry(R * 0.72, R * 0.72 + 0.06, 14, 0.55, 3)), dashMat);
  dash.position.y = 0.045; dash.renderOrder = 2; group.add(dash);
  const dash2 = new THREE.Mesh(cgeo('reviveDash2', () => dashedRingGeometry(R * 0.5, R * 0.5 + 0.035, 8, 0.3, 2)), dashMat);
  dash2.position.y = 0.045; dash2.renderOrder = 2; group.add(dash2);

  const moteMat = new THREE.MeshBasicMaterial({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const motes = [];
  const moteGeo = cgeo('mote', () => new THREE.OctahedronGeometry(0.05, 0));
  for (let i = 0; i < 9; i++) {
    const m = new THREE.Mesh(moteGeo, moteMat);
    const a = (i / 9) * TAU_ + Math.random() * 0.4;
    const r = R * (0.35 + Math.random() * 0.6);
    m.userData = { a, r, ph: Math.random(), sp: 0.35 + Math.random() * 0.3 };
    group.add(m); motes.push(m);
  }

  const ghost = createKittyModel(color === undefined ? 0xffffff : color);
  ghost.setGhost(true, color);
  ghost.group.scale.setScalar(0.95);
  group.add(ghost.group);

  const off = Math.random() * TAU_;
  const baseRing = col.clone();
  function update(dt, time) {
    const t = time === undefined ? performance.now() / 1000 : time;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4 + off);
    ringMat.color.copy(baseRing).multiplyScalar(0.7 + 0.3 * pulse);
    const rs = 1 + 0.04 * pulse;
    ring.scale.set(rs, 1, rs);
    haloMat.opacity = 0.35 + 0.2 * pulse;
    dash.rotation.y = t * 0.9;
    dash2.rotation.y = -t * 1.4;
    for (const m of motes) {
      const u = m.userData;
      const k = (t * u.sp + u.ph) % 1;
      const a = u.a + t * 0.6;
      m.position.set(Math.cos(a) * u.r, 0.1 + k * 1.7, Math.sin(a) * u.r);
      const s = Math.sin(k * Math.PI);
      m.scale.setScalar(0.4 + s);
      m.rotation.y = t * 3 + u.a;
    }
    ghost.group.position.y = 0.35 + Math.sin(t * 2.2 + off) * 0.12;
    ghost.group.rotation.y = Math.sin(t * 0.7 + off) * 0.6;
    ghost.update(dt, { moving: false, time: t });
  }
  update(0, 0);
  return { group, update };
}

// ---------------------------------------------------------------------------
// Portal (center goal)
// ---------------------------------------------------------------------------
function createPortalModel() {
  const R = CFG.CENTER_RADIUS - 0.6;
  const group = new THREE.Group();
  group.name = 'portal';

  // stone dais (low so kitties walk on it)
  const dais = cgeo('portalDais', () => {
    const parts = [
      [P.cyl18, mtx([0, 0.02, 0], null, [R + 0.3, 0.04, R + 0.3]), 0x585c78],
      [P.cyl18, mtx([0, 0.025, 0], null, [R - 0.1, 0.05, R - 0.1]), 0x7a7f9e],
      [P.cyl8, mtx([0, 0.03, 0], [0, Math.PI / 8, 0], [1.9, 0.06, 1.9]), 0x8e94b6],
    ];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU_;
      parts.push([P.box, mtx([Math.cos(a) * (R + 0.15), 0.05, Math.sin(a) * (R + 0.15)], [0, -a, 0], [0.32, 0.1, 0.62]), i % 2 ? 0x666a88 : 0x707494]);
    }
    return bake(parts);
  });
  const daisMesh = new THREE.Mesh(dais, VC_MAT());
  daisMesh.receiveShadow = true;
  group.add(daisMesh);

  // swirling energy
  const swirlMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 }, uR: { value: R - 0.35 }, uColA: { value: new THREE.Color(0x3fd8ff) }, uColB: { value: new THREE.Color(0xd8a0ff) } },
    vertexShader: SWIRL_VS, fragmentShader: SWIRL_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const swirl = new THREE.Mesh(flatDisc(R - 0.35, 64), swirlMat);
  swirl.position.y = 0.065; swirl.renderOrder = 1; group.add(swirl);

  // rune rings
  const runeCol = new THREE.Color(0x6fe6ff);
  const runeMat = new THREE.MeshBasicMaterial({ map: runeTexture(), color: runeCol.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const runeOuter = new THREE.Mesh(flatRing(R * 0.8, R * 1.0, 96), runeMat);
  runeOuter.position.y = 0.075; runeOuter.renderOrder = 2; group.add(runeOuter);
  const runeInnerMat = runeMat.clone(); runeInnerMat.color = new THREE.Color(0xffd27a).multiplyScalar(0.6);
  const runeInner = new THREE.Mesh(flatRing(1.75 * 0.8, 1.75, 64), runeInnerMat);
  runeInner.position.y = 0.08; runeInner.renderOrder = 2; group.add(runeInner);

  // light beams + crystal shards around the rim
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x5fdcff) }, uIntensity: { value: 1 }, uTime: { value: 0 } },
    vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const beamGeo = new THREE.CylinderGeometry(0.06, 0.16, 4.5, 8, 1, true); beamGeo.translate(0, 2.25, 0);
  const shardMat = new THREE.MeshStandardMaterial({ color: 0x9ff0ff, emissive: 0x3fd0ff, emissiveIntensity: 0.5, flatShading: true, roughness: 0.25 });
  const shardGeo = bake([
    [P.oct, mtx([0, 0.28, 0], null, [0.12, 0.3, 0.12]), 0xffffff],
    [P.oct, mtx([0.08, 0.16, 0.04], [0, 0, -0.5], [0.06, 0.16, 0.06]), 0xffffff],
    [P.oct, mtx([-0.06, 0.14, -0.05], [0.4, 0, 0.4], [0.05, 0.13, 0.05]), 0xffffff],
  ]);
  const beams = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU_ + Math.PI / 12;
    const x = Math.cos(a) * (R + 0.15), z = Math.sin(a) * (R + 0.15);
    const b = new THREE.Mesh(beamGeo, beamMat); b.position.set(x, 0.08, z); b.renderOrder = 3; group.add(b); beams.push(b);
    const sh = new THREE.Mesh(shardGeo, shardMat); sh.position.set(x, 0.08, z); sh.rotation.y = a; sh.castShadow = QUALITY.propShadows; group.add(sh);
  }

  // central column + floating crystal
  const colMat = beamMat.clone();
  colMat.uniforms = { uColor: { value: new THREE.Color(0xc8b4ff) }, uIntensity: { value: 1 }, uTime: { value: 0 } };
  const colGeo = new THREE.CylinderGeometry(0.35, 0.75, 2.8, 16, 1, true); colGeo.translate(0, 1.4, 0);
  const column = new THREE.Mesh(colGeo, colMat); column.position.y = 0.08; column.renderOrder = 3; group.add(column);

  const crystalPivot = new THREE.Group(); crystalPivot.position.y = 2.9; group.add(crystalPivot);
  const crystalMat = new THREE.MeshStandardMaterial({ color: 0xb8f6ff, emissive: 0x4fd8ff, emissiveIntensity: 0.55, flatShading: true, roughness: 0.2, metalness: 0.1 });
  const crystal = new THREE.Mesh(bake([
    [P.oct, mtx([0, 0, 0], null, [0.45, 0.9, 0.45]), 0xffffff],
  ]), crystalMat);
  crystal.castShadow = true;
  crystalPivot.add(crystal);
  const glowSprite = new THREE.Mesh(cgeo('portalGlowDisc', () => new THREE.PlaneGeometry(3.2, 3.2)), new THREE.MeshBasicMaterial({ map: radialTexture(), color: new THREE.Color(0x7fe0ff).multiplyScalar(0.35), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  crystalPivot.add(glowSprite);
  const haloMat = new THREE.MeshBasicMaterial({ color: 0xffd36a });
  const halo1 = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.03, 6, 48), haloMat);
  const halo2 = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.022, 6, 48), haloMat);
  crystalPivot.add(halo1, halo2);

  let act = 0, swirlT = 0, clock = 0;
  function update(dt, time, opts) {
    dt = Math.min(dt || 0, 0.1);
    clock += dt;
    const t = time === undefined ? clock : time;
    const active = !!(opts && opts.active);
    act = smoothTo(act, active ? 1 : 0, 3, dt);
    const speed = 1 + 2.2 * act;
    swirlT += dt * speed;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    const I = 0.45 + 0.08 * pulse + 0.25 * act;
    swirlMat.uniforms.uTime.value = swirlT;
    swirlMat.uniforms.uIntensity.value = I;
    runeOuter.rotation.y = swirlT * 0.12;
    runeInner.rotation.y = -swirlT * 0.25;
    runeMat.color.copy(runeCol).multiplyScalar(0.55 + 0.1 * pulse + 0.2 * act);
    beamMat.uniforms.uTime.value = t;
    beamMat.uniforms.uIntensity.value = 0.4 + 0.08 * pulse + 0.35 * act;
    colMat.uniforms.uTime.value = t;
    colMat.uniforms.uIntensity.value = 0.1 + 0.03 * pulse + 0.25 * act;
    for (let i = 0; i < beams.length; i++) {
      const s = 1 + 0.6 * act + 0.08 * Math.sin(t * 3 + i);
      beams[i].scale.set(1 + act, s, 1 + act);
    }
    crystalPivot.position.y = 2.9 + Math.sin(t * 1.6) * 0.15 + 0.3 * act;
    crystal.rotation.y = swirlT * 0.9;
    crystalMat.emissiveIntensity = 0.45 + 0.15 * pulse + 0.3 * act;
    glowSprite.quaternion.identity();
    glowSprite.rotation.x = -0.96; // face the angled camera
    glowSprite.scale.setScalar(1 + 0.15 * pulse + 0.6 * act);
    halo1.rotation.set(Math.PI / 2 + Math.sin(t * 0.8) * 0.35, swirlT * 0.5, 0);
    halo2.rotation.set(Math.PI / 2 + Math.cos(t * 0.6) * 0.45, -swirlT * 0.4, 0.3);
  }
  update(0, 0, {});
  return { group, update };
}

// The crown up for grabs over the goal room's middle (above the portal): big, spinning, bobbing, with a golden glow.
// Rainbow boots (7+ wins): the speed boot's red foot and shaft (kittyGeos speedBoot), a touch bigger so they cover
// the red; the gold cuff and white wings show through unchanged. White: the material colour does the rainbow.
function rainbowBootGeometry() {
  return cgeo('rainbowBoot', () => bake([
    [P.ico1, mtx([0.025, -0.205, 0], null, [0.096, 0.074, 0.086]), 0xffffff],
    [P.cyl8, mtx([0.0, -0.15, 0], null, [0.069, 0.092, 0.069]), 0xffffff],
  ]));
}

// Sunglasses (5+ wins), in kitty head space (+x forward): two dark lenses facing forward with a slight wrap, just in
// front of the eye whites, a white shine streak on each, a gold bridge and gold arms back to the ears.
function sunglassesGeometry() {
  return cgeo('sunglasses', () => {
    const LENS = 0x1e1a2b, SHINE = 0xffffff, GOLD = 0xffd34a, parts = [];
    for (const sz of [1, -1]) {
      const yaw = -0.3 * sz, cx = 0.208, cy = 0.05, cz = 0.1 * sz;   // wrap: outer edge swept back
      parts.push([P.cyl18, mtx([cx, cy, cz], [0, yaw, -Math.PI / 2], [0.07, 0.014, 0.088]), LENS]);
      parts.push([P.box, mtx([cx + 0.009, cy + 0.03, cz + 0.012 * sz], [0, yaw, 0], [0.004, 0.01, 0.042]), SHINE]);
      parts.push([P.box, mtx([0.075, 0.062, 0.2 * sz], [0, 0.1 * sz, 0], [0.22, 0.013, 0.01]), GOLD]);   // arm
    }
    parts.push([P.box, mtx([0.214, 0.066, 0], null, [0.014, 0.013, 0.05]), GOLD]);               // bridge
    return bake(parts);
  });
}

// chunky solid crown (band, spikes, ball tips, red gems): reads from the top-down camera
// (pearls = false: the worn crown, whose pearls are separate meshes so crown stones can replace them)
function chunkyCrownGeometry(pearls = true) {
  return cgeo(pearls ? 'crownChunky' : 'crownChunkyBare', () => bake([
    [P.cyl18, mtx([0, 0, 0], null, [0.13, 0.08, 0.13]), 0xffc83a],
    [P.cyl18, mtx([0, -0.035, 0], null, [0.14, 0.02, 0.14]), 0xe0a020],
    ...[0, 1, 2, 3, 4].flatMap((i) => {
      const a = (i / 5) * Math.PI * 2, x = Math.cos(a) * 0.11, z = Math.sin(a) * 0.11;
      return [
        [P.cone5, mtx([x, 0.1, z], null, [0.05, 0.13, 0.05]), 0xffd34a],
        ...(pearls ? [[P.ico1, mtx([x, 0.17, z], null, 0.022), 0xfff2b0]] : []),
        [P.ico0, mtx([Math.cos(a) * 0.135, 0, Math.sin(a) * 0.135], [0, -a, 0], [0.012, 0.022, 0.022]), 0xff3d6e],
      ];
    }),
  ]));
}

function createCrownPickupModel() {
  const group = new THREE.Group();
  group.name = 'crownPickup';
  const geo = chunkyCrownGeometry();
  const crown = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0x7a4a00, emissiveIntensity: 0.6, metalness: 0.45, roughness: 0.35, flatShading: true }));
  crown.scale.setScalar(7);
  crown.castShadow = true;
  // tipped toward the (top-down) camera so it reads as a crown, not a ring
  const tilt = new THREE.Group();
  tilt.rotation.x = 0.75;
  tilt.add(crown);
  group.add(tilt);
  const glow = new THREE.Mesh(cgeo('crownGlow', () => new THREE.PlaneGeometry(2.4, 2.4)), new THREE.MeshBasicMaterial({ map: radialTexture(), color: new THREE.Color(0xffc23a).multiplyScalar(0.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  group.add(glow);
  function update(dt, t, camera) {
    tilt.position.y = 2.4 + Math.sin(t * 2.2) * 0.15;
    crown.rotation.y = t * 1.4;
    glow.position.y = tilt.position.y + 0.3;
    if (camera) glow.quaternion.copy(camera.quaternion);
    glow.material.opacity = 0.35 + 0.15 * Math.sin(t * 3.1);
  }
  return { group, update };
}

// ---------------------------------------------------------------------------
// The giant fish: the final run's prize, waiting in the goal room
// ---------------------------------------------------------------------------
// A huge salmon on a crescent platter of crushed ice, curled around the back (-z) of the portal so it never hides
// the goal or the door (tail at the back-left, head at the right). It lies on its side, profile up for the top-down
// camera, and its spine follows an arc of radius FISH.R round the origin, so the edge of the goal disc (where the
// kitties are held after the win) runs right along its belly. Purely cosmetic and client-side: the game calls
// nearest(x, z) to find the closest uneaten chunk and bite(i) when a kitty takes a bite. Each chunk shrinks toward its
// head-side face (the cut shows salmon-orange flesh) and the bones underneath appear; when every chunk is gone only
// the skeleton is left, and it sparkles.
const FISH = {
  R: 6.2,                                             // arc radius of the spine (the goal disc's rim is at ~4.7)
  A0: 222 * Math.PI / 180, A1: 338 * Math.PI / 180,  // tail end / snout angle (x = cos a, z = sin a)
  HEAD_U: 0.8, BODY: 10, BODY_BITES: 4, HEAD_BITES: 5,
  BASE: 0.12,                                         // the platter's top
  SIDES: 10,
};
const FISH_D = [[0, 0.34], [0.08, 0.4], [0.25, 0.82], [0.45, 1.2], [0.62, 1.3], [0.78, 1.22], [0.88, 1.04], [0.95, 0.7], [1, 0.22]];
const FISH_SKIN = [[1, 0x203c5c], [0.8, 0x35597f], [0.4, 0x7f9fbf], [0.05, 0xff8f78], [-0.4, 0xffa58c], [-0.8, 0xffd9c6], [-1, 0xfff0e6]];
const FISH_BONE = 0xf7e6c4, FISH_FIN = 0x2c4a6e;

function fishDepth(u) {   // half the dorsal-to-belly depth (horizontal: the fish lies on its side)
  u = Math.max(0, Math.min(1, u));
  for (let i = 1; i < FISH_D.length; i++) {
    const [u1, d1] = FISH_D[i];
    if (u <= u1) {
      const [u0, d0] = FISH_D[i - 1], f = (u - u0) / (u1 - u0);
      return d0 + (d1 - d0) * f * f * (3 - 2 * f);
    }
  }
  return FISH_D[FISH_D.length - 1][1];
}
const fishThick = (d) => 0.18 + 0.5 * d / 1.3;   // half the height
const fishAngle = (u) => FISH.A0 + (FISH.A1 - FISH.A0) * u;
const fishCY = (u) => FISH.BASE + fishThick(fishDepth(u));   // spine height

// local frame at u: x = toward the head (tangent), y = up, z = toward the belly (the portal); origin on the floor
function fishFrame(u) {
  const a = fishAngle(u), nx = Math.cos(a), nz = Math.sin(a);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(-nz, 0, nx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-nx, 0, -nz));
  return m.setPosition(nx * FISH.R, 0, nz * FISH.R);
}
const fishAt = (u, p, r, s) => fishFrame(u).multiply(mtx(p, r, s));

function fishSkinColor(s, out) {
  for (let i = 1; i < FISH_SKIN.length; i++) {
    if (s >= FISH_SKIN[i][0]) {
      const [s0, c0] = FISH_SKIN[i - 1], [s1, c1] = FISH_SKIN[i];
      return out.set(c0).lerp(_c.set(c1), (s0 - s) / (s0 - s1));
    }
  }
  return out.set(FISH_SKIN[FISH_SKIN.length - 1][1]);
}

// Lofted body piece through the stations us (world space, non-indexed): rings of SIDES vertices, both ends capped
// with flesh (only seen once a neighbour is eaten or the piece itself is bitten).
function fishLoft(us, pos, col, snout, tail) {
  const N = FISH.SIDES, flesh = new THREE.Color(0xff8a5c), fleshMid = new THREE.Color(0xffc09a), tip = new THREE.Color(0x3a5878);
  const rings = us.map((u) => {
    const a = fishAngle(u), d = fishDepth(u), t = fishThick(d), cy = FISH.BASE + t;
    const nx = Math.cos(a), nz = Math.sin(a), cx = nx * FISH.R, cz = nz * FISH.R;
    const ring = [];
    for (let j = 0; j < N; j++) {
      const th = (j / N) * TAU_, s = Math.cos(th), v = Math.sin(th);
      const c = fishSkinColor(s, new THREE.Color());
      // salmon spots on the back
      if (s > 0.5 && Math.sin(u * 211 + j * 7.3) > 0.55) c.multiplyScalar(0.62);
      ring.push({ p: [cx + nx * s * d, cy + v * t, cz + nz * s * d], c });
    }
    return { ring, mid: { p: [cx, cy, cz], c: fleshMid } };
  });
  const put = (q, c) => { pos.push(q.p[0], q.p[1], q.p[2]); const k = c || q.c; col.push(k.r, k.g, k.b); };
  for (let r = 0; r + 1 < rings.length; r++) {
    const A = rings[r].ring, B = rings[r + 1].ring;
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      put(A[j]); put(A[j1]); put(B[j1]);
      put(A[j]); put(B[j1]); put(B[j]);
    }
  }
  const capS = rings[0], capE = rings[rings.length - 1];
  for (let j = 0; j < N; j++) {
    const j1 = (j + 1) % N;
    put(capS.mid, tail ? tip : null); put(capS.ring[j1], tail ? tip : flesh); put(capS.ring[j], tail ? tip : flesh);
    put(capE.mid, snout ? tip : null); put(capE.ring[j], snout ? tip : flesh); put(capE.ring[j1], snout ? tip : flesh);
  }
}

function fishMerge(parts, toLocal) {   // parts: [{pos, col}] (plain arrays) or baked geometries
  const pos = [], col = [];
  for (const p of parts) {
    if (p.isBufferGeometry) {
      pos.push(...p.attributes.position.array); col.push(...p.attributes.color.array);
      p.dispose();
    } else { pos.push(...p.pos); col.push(...p.col); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (toLocal) g.applyMatrix4(toLocal);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// chunk i: its u range, the frame its mesh sits in (at the head-side end, on the platter) and the flesh / bone geometry
function fishChunk(i) {
  const head = i === FISH.BODY;
  const u0 = head ? FISH.HEAD_U : (i / FISH.BODY) * FISH.HEAD_U, u1 = head ? 1 : ((i + 1) / FISH.BODY) * FISH.HEAD_U;
  const frame = fishFrame(u1);
  frame.multiply(new THREE.Matrix4().makeTranslation(0, FISH.BASE, 0));
  const inv = frame.clone().invert();
  return cgeo('fishChunk' + i, () => {
    const loft = { pos: [], col: [] };
    fishLoft(head ? [0.8, 0.84, 0.88, 0.92, 0.95, 0.975, 1] : [u0, (u0 + u1) / 2, u1], loft.pos, loft.col, head, i === 0);
    const extra = [];
    if (i === 0) {   // forked tail fin, lying flat
      for (const yaw of [-0.5, 0.5]) extra.push([P.cone4, fishAt(0, [-0.62 * Math.cos(yaw), FISH.BASE + 0.26, 0.62 * Math.sin(yaw)], [0, yaw, Math.PI / 2], [0.07, 1.45, 0.42]), FISH_FIN]);
    }
    if (i === Math.floor(0.5 * FISH.BODY / FISH.HEAD_U)) {   // dorsal fin, sticking out of the back (away from the portal)
      const u = (u0 + u1) / 2, d = fishDepth(u);
      extra.push([P.cone4, fishAt(u, [-0.15, fishCY(u), -(d + 0.2)], [-Math.PI / 2, 0, 0.75], [0.6, 0.75, 0.06]), FISH_FIN]);
    }
    if (i === 2) {   // anal fin, small, on the belly side
      const u = (u0 + u1) / 2, d = fishDepth(u);
      extra.push([P.cone4, fishAt(u, [-0.1, fishCY(u), d + 0.15], [Math.PI / 2, 0, 0.6], [0.3, 0.45, 0.05]), FISH_FIN]);
    }
    if (head) {
      const ue = 0.905, de = fishDepth(ue), te = fishThick(de), top = FISH.BASE + te * 1.93;
      extra.push(
        [P.ico1, fishAt(ue, [0, top, -0.18 * de], null, [0.22, 0.08, 0.22]), 0xffffff],
        [P.ico1, fishAt(ue, [0.03, top + 0.035, -0.18 * de], null, [0.14, 0.07, 0.14]), 0x16121c],
        [P.ico1, fishAt(ue, [0.07, top + 0.09, -0.18 * de - 0.05], null, [0.045, 0.03, 0.045]), 0xffffff],
        // gill line, mouth, pectoral fin lying on top
        [P.box, fishAt(FISH.HEAD_U + 0.005, [0, FISH.BASE + fishThick(fishDepth(0.8)) * 1.95, 0], [0.12, 0, 0], [0.07, 0.05, 1.5]), 0xc98a96],
        [P.box, fishAt(0.975, [0.05, FISH.BASE + fishThick(fishDepth(0.975)) * 1.7, 0.16], [0, 0.35, 0], [0.34, 0.05, 0.05]), 0x7a2f3c],
        [P.cone4, fishAt(0.79, [-0.35, FISH.BASE + fishThick(fishDepth(0.79)) * 2.02, 0.25], [0, 0.35, Math.PI / 2], [0.05, 0.8, 0.26]), 0xe8a0a8],
      );
    }
    const flesh = fishMerge(extra.length ? [loft, bake(extra)] : [loft], inv);
    // bones (shown once the chunk is bitten into): vertebrae along the spine, ribs swept back, skull, tail rays
    const bones = [];
    const by = FISH.BASE + 0.24;
    const step = 0.026;
    for (let u = u0 + step / 2; u < Math.min(u1, 0.82); u += step) {
      bones.push([P.box, fishAt(u, [0, by, 0], null, [0.2, 0.15, 0.2]), FISH_BONE]);
      if (u > 0.1 && u < 0.78 && Math.round(u / step) % 2 === 0) {
        const L = 0.8 * fishDepth(u);
        for (const sd of [-1, 1]) {
          const th = -0.38 * sd;
          bones.push([P.box, fishAt(u, [(L / 2) * Math.sin(th) * sd, by, sd * (0.08 + (L / 2) * Math.cos(th))], [0, th, 0], [0.06, 0.06, L]), FISH_BONE]);
        }
      }
    }
    if (i === 0) {
      for (const yaw of [-0.55, -0.25, 0.25, 0.55]) bones.push([P.box, fishAt(0, [-0.55 * Math.cos(yaw), by, 0.55 * Math.sin(yaw)], [0, yaw, 0], [1.1, 0.05, 0.05]), FISH_BONE]);
      bones.push([P.box, fishAt(0, [-0.05, by, 0], null, [0.25, 0.12, 0.35]), FISH_BONE]);
    }
    if (head) {
      bones.push(
        [P.ico1, fishAt(0.88, [0, by + 0.12, 0], null, [0.8, 0.32, 0.62]), FISH_BONE],
        [P.cone4, fishAt(0.88, [0.95, by + 0.06, 0.05], [0, 0, -Math.PI / 2], [0.14, 0.7, 0.3]), FISH_BONE],
        [P.ico1, fishAt(0.9, [0.1, by + 0.38, -0.12], null, [0.17, 0.06, 0.17]), 0x3a3040],
      );
    }
    return { flesh, bones: fishMerge([bake(bones)], inv), frame, u0, u1, nb: head ? FISH.HEAD_BITES : FISH.BODY_BITES };
  });
}

function fishPlatterGeo() {
  return cgeo('fishPlatter', () => {
    const a0 = 204 * Math.PI / 180, a1 = 352 * Math.PI / 180, r0 = 4.95, r1 = 7.55, n = 40;
    const rm = (r0 + r1) / 2, rr = (r1 - r0) / 2, sh = new THREE.Shape();
    // rounded end at angle a, from the outer edge round to the inner one (dir = +1 head end, -1 tail end)
    const end = (a, dir) => {
      const nx = Math.cos(a), nz = Math.sin(a), tx = -nz * dir, tz = nx * dir;
      for (let k = 1; k < 8; k++) {
        const f = Math.PI * k / 8, c = Math.cos(f) * rr, s = Math.sin(f) * rr;
        sh.lineTo(nx * (rm + c) + tx * s, nz * (rm + c) + tz * s);
      }
    };
    for (let k = 0; k <= n; k++) { const a = a0 + (a1 - a0) * k / n; sh[k ? 'lineTo' : 'moveTo'](Math.cos(a) * r1, Math.sin(a) * r1); }
    end(a1, 1);
    for (let k = n; k >= 0; k--) { const a = a0 + (a1 - a0) * k / n; sh.lineTo(Math.cos(a) * r0, Math.sin(a) * r0); }
    // tail end: from the inner edge round to the outer one
    { const nx = Math.cos(a0), nz = Math.sin(a0), tx = nz, tz = -nx;
      for (let k = 1; k < 8; k++) { const f = Math.PI - Math.PI * k / 8, c = Math.cos(f) * rr, s = Math.sin(f) * rr; sh.lineTo(nx * (rm + c) + tx * s, nz * (rm + c) + tz * s); } }
    const g = new THREE.ExtrudeGeometry(sh, { depth: FISH.BASE, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(Math.PI / 2);   // shape y -> world z, extrusion -> down
    g.translate(0, FISH.BASE, 0);
    return g;
  });
}

function createGiantFishModel() {
  const group = new THREE.Group();
  group.name = 'giantFish';
  const skin = cmat('fishSkin', () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.28, metalness: 0.08, emissive: 0x2a140c, emissiveIntensity: 1 }));
  const boneMat = cmat('fishBone', () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, emissive: 0x000000 }));

  // platter of crushed ice, ice cubes, lemon slices and parsley
  const platter = new THREE.Mesh(fishPlatterGeo(), cmat('fishPlatter', () => new THREE.MeshStandardMaterial({ color: 0x9cc6e6, roughness: 0.35, metalness: 0.05, emissive: 0x2d5878, emissiveIntensity: 0.25, flatShading: true })));
  platter.receiveShadow = true;
  group.add(platter);
  const deco = [];
  const seeded = (k) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  for (let k = 0; k < 30; k++) {
    const inner = k % 2 === 0, a = (210 + 136 * seeded(k)) * Math.PI / 180, r = inner ? 5.1 + 0.3 * seeded(k + 50) : 7.05 + 0.3 * seeded(k + 50), s = 0.2 + 0.16 * seeded(k + 99);
    deco.push([P.box, mtx([Math.cos(a) * r, FISH.BASE + s * 0.4, Math.sin(a) * r], [seeded(k + 7) * 0.6, seeded(k + 3) * 3, seeded(k + 11) * 0.6], s), seeded(k + 21) < 0.5 ? 0xd8f1ff : 0xf4fbff]);
  }
  for (const [ad, r] of [[214, 7.05], [300, 7.2], [346, 6.3], [262, 5.1]]) {
    const a = ad * Math.PI / 180, x = Math.cos(a) * r, z = Math.sin(a) * r;
    deco.push([P.cyl8, mtx([x, FISH.BASE + 0.07, z], [0.25, a, 0.15], [0.36, 0.08, 0.36]), 0xffd83a]);
    deco.push([P.cyl8, mtx([x, FISH.BASE + 0.08, z], [0.25, a, 0.15], [0.29, 0.085, 0.29]), 0xfff3b0]);
    deco.push([P.ico0, mtx([x + 0.42, FISH.BASE + 0.12, z + 0.25], null, [0.2, 0.12, 0.2]), 0x3fae4a]);
    deco.push([P.ico0, mtx([x + 0.3, FISH.BASE + 0.14, z + 0.45], null, [0.16, 0.12, 0.16]), 0x58c45c]);
  }
  const decoMesh = new THREE.Mesh(cgeo('fishDeco', () => bake(deco)), VC_MAT());
  decoMesh.castShadow = true; decoMesh.receiveShadow = true;
  group.add(decoMesh);

  // warm glow under it: the prize at the end of the run
  const glowMat = new THREE.MeshBasicMaterial({ map: radialTexture(), color: new THREE.Color(0xffa060).multiplyScalar(0.35), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const glowGeo = cgeo('fishGlow', () => { const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); return g; });
  for (const u of [0.15, 0.5, 0.85]) {
    const a = fishAngle(u), gm = new THREE.Mesh(glowGeo, glowMat);
    gm.position.set(Math.cos(a) * FISH.R, FISH.BASE + 0.02, Math.sin(a) * FISH.R);
    gm.rotation.y = -a; gm.scale.set(6.5, 1, 6.5);
    gm.renderOrder = 2;
    group.add(gm);
  }

  const chunks = [];
  for (let i = 0; i <= FISH.BODY; i++) {
    const c = fishChunk(i);
    const flesh = new THREE.Mesh(c.flesh, skin);
    flesh.castShadow = true; flesh.receiveShadow = true;
    flesh.matrixAutoUpdate = true;
    c.frame.decompose(flesh.position, flesh.quaternion, flesh.scale);
    const bones = new THREE.Mesh(c.bones, boneMat);
    c.frame.decompose(bones.position, bones.quaternion, bones.scale);
    bones.castShadow = true; bones.visible = false;
    group.add(flesh, bones);
    chunks.push({ flesh, bones, u0: c.u0, u1: c.u1, nb: c.nb, bites: 0, k: 1, kd: 1, pop: 0 });
  }
  const totalBites = chunks.reduce((s, c) => s + c.nb, 0);
  let bitesTaken = 0, doneAt = -1;

  // sparkles twinkling on whatever is left (golden on the bones once it's all gone)
  const NSP = 14;
  const spPos = new Float32Array(NSP * 3), spCol = new Float32Array(NSP * 3);
  const spGeo = new THREE.BufferGeometry();
  spGeo.setAttribute('position', new THREE.BufferAttribute(spPos, 3));
  spGeo.setAttribute('color', new THREE.BufferAttribute(spCol, 3));
  const sparkles = new THREE.Points(spGeo, new THREE.PointsMaterial({ map: radialTexture(), size: 0.75, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  sparkles.frustumCulled = false;
  sparkles.renderOrder = 6;
  group.add(sparkles);
  const sp = [];
  for (let k = 0; k < NSP; k++) sp.push({ t: -Math.random() * 2, life: 1 });
  const placeSparkle = (k) => {
    const left = chunks.filter((c) => c.k > 0);
    let u, top;
    if (left.length) {
      const c = left[(Math.random() * left.length) | 0];
      u = c.u1 - (c.u1 - c.u0) * c.k * Math.random();
      top = FISH.BASE + fishThick(fishDepth(u)) * 1.9;
    } else { u = 0.02 + Math.random() * 0.96; top = FISH.BASE + 0.45; }
    const a = fishAngle(u), off = (Math.random() * 2 - 1) * fishDepth(u) * 0.7, r = FISH.R + off;
    spPos[k * 3] = Math.cos(a) * r; spPos[k * 3 + 1] = top + 0.05; spPos[k * 3 + 2] = Math.sin(a) * r;
  };
  for (let k = 0; k < NSP; k++) placeSparkle(k);
  const gold = new THREE.Color(0xffd36a), white = new THREE.Color(0xfff4e0);

  function wrapAngle(x, z) {
    let a = Math.atan2(z, x);
    if (a < 0) a += TAU_;
    if (a < (FISH.A0 + FISH.A1) / 2 - Math.PI) a += TAU_;
    return a;
  }
  // the closest uneaten chunk to (x, z): { i, d (gap to its surface, < 0 inside), px, pz (surface point) } or null
  function nearest(x, z) {
    const pa = wrapAngle(x, z);
    let best = null;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (c.k <= 0) continue;
      const uS = c.u1 - (c.u1 - c.u0) * c.k;
      const a = Math.max(fishAngle(uS), Math.min(fishAngle(c.u1), pa));
      const u = (a - FISH.A0) / (FISH.A1 - FISH.A0);
      const cx = Math.cos(a) * FISH.R, cz = Math.sin(a) * FISH.R;
      const dx = x - cx, dz = z - cz, L = Math.hypot(dx, dz) || 1e-6;
      const de = fishDepth(u) * (0.55 + 0.45 * c.k);
      const d = L - de;
      if (!best || d < best.d) best = { i, d, px: cx + dx / L * de, pz: cz + dz / L * de };
    }
    return best;
  }
  // a kitty takes a bite of chunk i: returns where the bite came from (for crumbs), and whether that finished the fish
  function bite(i) {
    const c = chunks[i];
    if (!c || c.k <= 0) return null;
    c.bites++; bitesTaken++;
    c.k = Math.max(0, 1 - c.bites / c.nb);
    c.pop = 1;
    c.bones.visible = true;
    const u = c.u1 - (c.u1 - c.u0) * c.k, a = fishAngle(u);
    return { x: Math.cos(a) * FISH.R, y: fishCY(u) + 0.2, z: Math.sin(a) * FISH.R, done: bitesTaken >= totalBites };
  }

  let clock = 0;
  function update(dt, time) {
    dt = Math.min(dt || 0, 0.1);
    clock += dt;
    const t = time === undefined ? clock : time;
    for (const c of chunks) {
      if (c.kd === c.k && c.pop === 0) continue;
      c.kd = Math.abs(c.kd - c.k) < 0.002 ? c.k : smoothTo(c.kd, c.k, 14, dt);
      c.pop = Math.max(0, c.pop - dt * 5);
      const w = Math.sin(c.pop * Math.PI) * 0.12, yz = (0.55 + 0.45 * c.kd) * (1 + w);
      c.flesh.scale.set(Math.max(0.001, c.kd * (1 - w)), yz, yz);
      c.flesh.visible = c.kd > 0.02;
    }
    if (doneAt < 0 && bitesTaken >= totalBites) doneAt = t;
    const done = doneAt >= 0;
    for (let k = 0; k < NSP; k++) {
      const s = sp[k];
      s.t += dt * (done ? 1.4 : 0.9);
      if (s.t >= s.life) { s.t = 0; s.life = 0.6 + Math.random() * 0.8; placeSparkle(k); }
      const f = s.t <= 0 ? 0 : Math.sin((s.t / s.life) * Math.PI);
      const col = done ? gold : white;
      const b = f * f * (done ? 1 : 0.8);
      spCol[k * 3] = col.r * b; spCol[k * 3 + 1] = col.g * b; spCol[k * 3 + 2] = col.b * b;
    }
    spGeo.attributes.position.needsUpdate = true;
    spGeo.attributes.color.needsUpdate = true;
    glowMat.opacity = 0.75 + 0.25 * Math.sin(t * 2.1);
    if (done) glowMat.color.setHex(0xffd36a).multiplyScalar(0.4 + 0.15 * Math.sin(t * 5));
  }
  update(0, 0);
  return {
    group, update, nearest, bite,
    eaten: () => bitesTaken / totalBites,
    done: () => bitesTaken >= totalBites,
    headPos: () => { const a = fishAngle(0.9); return { x: Math.cos(a) * FISH.R, z: Math.sin(a) * FISH.R }; },
  };
}

export { WOLF_TYPES, disposeModel, createKittyModel, createWolfModel, createItemModel, createReviveCircleModel, createPortalModel, createCrownPickupModel, createGiantFishModel };
