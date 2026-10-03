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
  if (root.userData.onDispose) root.userData.onDispose();
  const done = new Set();
  const free = (r) => { if (r && !done.has(r) && !r.userData.shared) { done.add(r); r.dispose(); } };
  root.traverse((o) => {
    if (o.isInstancedMesh) o.dispose();   // its instance buffers (the wings)
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
    g.lineWidth = 5.5; g.beginPath(); g.arc(0, 0, rO - 6, 0, TAU_); g.stroke();
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
    return { body, head, eyes, ear, leg, tailSeg, tailTip, skate, speedBoot: speedBootGeometry() };
  });
}

// speed boot (one per pair picked up), in leg space (paw at y -0.215): red boot with a gold cuff and little white
// wings, a touch bigger than the skate boot so it covers it on ice. The boots pickup is this same model, scaled up.
function speedBootGeometry() {
  return cgeo('speedBoot', () => bake([
    [P.ico1, mtx([0.025, -0.205, 0], null, [0.092, 0.07, 0.082]), BOOT_RED],
    [P.cyl8, mtx([0.0, -0.15, 0], null, [0.066, 0.09, 0.066]), BOOT_RED],
    [P.cyl8, mtx([0.0, -0.1, 0], null, [0.072, 0.028, 0.072]), BOOT_CUFF],
    [P.box, mtx([-0.035, -0.13, 0.07], [0.5, 0, 0.5], [0.07, 0.03, 0.012]), 0xffffff],
    [P.box, mtx([-0.035, -0.13, -0.07], [-0.5, 0, 0.5], [0.07, 0.03, 0.012]), 0xffffff],
  ]));
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

  // Every win reward and every revive reward: the whole kitty's fur goes rainbow, running from nose to tail and cycling
  // like the rainbow wings. The fur parts get their own copies of their geometry; each vertex keeps its role (fur, belly, stripes) and is
  // recoloured every frame, the rest (nose, inner ears, eyes) stays as it is.
  const furSrc = new Set([G.body, G.head, G.ear, G.leg, G.tailSeg, G.tailTip]);
  let fur = null, furOn = false;
  const furC = new THREE.Color(), FUR_WHITE = new THREE.Color(0xffffff);
  function buildFur() {
    const pal = kittyPalette(color), roles = [pal.base, pal.light, pal.dark];
    const rigInv = new THREE.Matrix4(), mm = new THREE.Matrix4(), v = new THREE.Vector3();
    group.updateMatrixWorld(true); rigInv.copy(rig.matrixWorld).invert();
    fur = [];
    for (const m of meshes) {
      if (!furSrc.has(m.geometry)) continue;
      const geo = m.geometry.clone(), col = geo.attributes.color.array, pos = geo.attributes.position.array, n = col.length / 3;
      const role = new Int8Array(n), u = new Float32Array(n);
      mm.multiplyMatrices(rigInv, m.matrixWorld);
      for (let i = 0; i < n; i++) {
        role[i] = roles.findIndex((c) => Math.abs(c.r - col[i * 3]) + Math.abs(c.g - col[i * 3 + 1]) + Math.abs(c.b - col[i * 3 + 2]) < 1e-3);
        u[i] = v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(mm).x;   // nose (+x) .. tail (-x), rig space
      }
      fur.push({ m, src: m.geometry, geo, role, u });
    }
  }
  let furAt = -1;
  function updateFur(rainbow, t) {
    const on = !!rainbow && !ghost;
    if (on && !fur) buildFur();
    if (on !== furOn && fur) { for (const p of fur) p.m.geometry = on ? p.geo : p.src; furOn = on; furAt = -1; }
    if (!on) return;
    if (furAt >= 0 && Math.abs(t - furAt) < 0.05) return;   // ~20 times a second is plenty for a slow hue drift
    furAt = t;
    const h0 = (t * 0.45 + rainbowOff) % 1;
    for (const p of fur) {
      const col = p.geo.attributes.color.array;
      for (let i = 0; i < p.role.length; i++) {
        const r = p.role[i];
        if (r < 0) continue;
        const c = furC.setHSL(((h0 - p.u[i] * 1.1) % 1 + 1) % 1, 0.9, 0.55);
        if (r === 1) c.lerp(FUR_WHITE, 0.4); else if (r === 2) c.multiplyScalar(0.6);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      p.geo.attributes.color.needsUpdate = true;
    }
  }

  // crown sits on the head (follows its bob/tilt)
  const crown = new THREE.Mesh(chunkyCrownGeometry(false), new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0x7a4a00, emissiveIntensity: 0.6, metalness: 0.45, roughness: 0.35, flatShading: true }));
  crown.position.set(-0.02, 0.25, 0);
  crown.rotation.z = -0.12;
  crown.scale.setScalar(1.32);   // smaller than it was (1.76), so the backpack's kittens show next to it
  crown.castShadow = true;
  crown.visible = false;
  head.add(crown);
  // sunglasses (5+ wins): dark lenses just in front of the eyes, gold bridge, arms back to the ears
  const shades = new THREE.Mesh(sunglassesGeometry(), cmat('shades', () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.2, metalness: 0.35 })));
  shades.visible = false;
  head.add(shades);
  // backpack (8+ wins): a canvas pack on the back, open at the top, with little kittens in the other players'
  // colours peeking out (you carry everyone). Heads are rebuilt only when the colour list (array identity) changes.
  const pack = new THREE.Group();
  pack.position.set(PACK_POS[0], PACK_POS[1], PACK_POS[2]);
  const packBag = new THREE.Mesh(backpackGeometry(), mat);
  packBag.castShadow = true;
  pack.add(packBag);
  pack.visible = false;
  rig.add(pack);
  let packCols = null;
  const packHeads = [];
  function setPackColors(cols) {
    packCols = cols;
    for (const h of packHeads) h.removeFromParent();
    packHeads.length = 0;
    const n = Math.min(cols ? cols.length : 0, PACK_SLOTS.length);
    if (!n) return;
    for (let i = 0; i < n; i++) {
      const [x, y, z, yaw] = PACK_SLOTS[n - 1][i];
      const m = new THREE.Mesh(kittenHeadGeometry(cols[i]), mat);
      m.position.set(x, y, z); m.rotation.y = yaw; m.scale.setScalar(PACK_KIT_S); m.castShadow = true;
      m.userData.y = y; m.userData.yaw = yaw;
      pack.add(m);
      packHeads.push(m);
    }
  }
  // revive rewards (rescues in this run): 10+ a medic cape, 60+ feathered wings (30+ is a heart trail, main.js)
  // Cape: a little cloth simulation. The cape's grid points are particles (verlet, in world space) pinned along the
  // collar; gravity, the body's real movement and drag do the rest, so it drapes over the back, trails behind when you
  // run, swings out on turns and settles when you stop. Kept outside a body-shaped ellipsoid; springs to its draped
  // rest shape keep it from crumpling.
  const capeGeo = new THREE.PlaneGeometry(CAPE_LEN, CAPE_W, CAPE_NX - 1, CAPE_NZ - 1);
  capeGeo.rotateX(-Math.PI / 2);                     // lies flat (normal up), length along x, width along z
  capeGeo.translate(CAPE_X0 - CAPE_LEN / 2, 0, 0);   // front edge at the neck
  const cloth = makeCapeCloth(capeGeo);
  const cape = new THREE.Group();
  const capeCloth = new THREE.Mesh(capeGeo, cmat('capeMat:' + new THREE.Color(color).getHexString(), () => new THREE.MeshStandardMaterial({ map: capeTexture(color), side: THREE.DoubleSide, roughness: 0.85, flatShading: true })));
  capeCloth.castShadow = true;
  const capeCollar = new THREE.Mesh(cgeo('capeCollar', () => new THREE.TorusGeometry(0.1, 0.022, 5, 14).rotateY(Math.PI / 2)), cmat('capeCollarMat:' + new THREE.Color(color).getHexString(), () => new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.6, flatShading: true })));
  capeCollar.position.set(0.17, 0.5, 0);
  capeCollar.rotation.z = -0.5;
  cape.add(capeCloth, capeCollar);
  const capeMat = capeCloth.material, collarMat = capeCollar.material;
  const capeGlowMat = [null, null];   // [white cloth, dark cloth]
  let collarGlowMat = null, capeDarkMat = null;
  cape.visible = false;
  rig.add(cape);
  // Wings: both wings' bones and feathers are instances of one flat feather shape (one draw call), placed every frame
  // from two poses blended by how open the wings are (makeWingPose): folded like a resting bird's / a skyscale's (a Z:
  // wrist up by the shoulder, the wing draped back along the flank) and open (spread to the sides in an arch).
  const wingMesh = new THREE.InstancedMesh(cgeo('wingFeather', () => new THREE.IcosahedronGeometry(1, 0)),
    cmat('wingFeatherMat', () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, flatShading: true })), 2 * WING_INST);
  wingMesh.castShadow = true;
  wingMesh.frustumCulled = false;
  wingMesh.visible = false;
  const wingCols = wingColors(color);
  for (let i = 0; i < 2 * WING_INST; i++) wingMesh.setColorAt(i, wingCols[i % WING_INST]);
  let wingRainbow = false;
  const wingTmp = new THREE.Color();
  rig.add(wingMesh);
  const wingPose = makeWingPose(wingMesh);
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
  let flowGo = 0, wingPh = Math.random() * 6;   // cape / wings: eased movement amount, wing breathing phase
  let flSw = 0, flSwV = 0, flAc = 0, flAcV = 0, runPrev = 0;   // cape / wings springs: turn swing, speed-change throw
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
    pack.visible = !!s.backpack && !ghost;
    // how much the kitty is moving (running or gliding), eased so cloth and wings don't snap
    const goNow = Math.max(runAmt, Math.min(1, glideSp / CFG.KITTY_SPEED));
    flowGo = smoothTo(flowGo, goNow, 3.5, mdt);
    // Cape + wings hang off the body like the tail: floppy springs. Turning swings them out to the outside of the turn,
    // speeding up throws them back, slowing down lets them swing forward. Substepped like the tail.
    const swTgt = Math.max(-0.5, Math.min(0.5, -yawVel * 0.12)), acTgt = Math.max(-0.4, Math.min(0.4, -glideAcc * 0.03 - (runAmt - runPrev) / Math.max(mdt, 1e-3) * 0.05));
    runPrev = runAmt;
    for (let n = Math.max(1, Math.ceil(mdt / 0.008)), h = mdt / n; n > 0; n--) {
      flSwV += ((swTgt - flSw) * 45 - flSwV * 5) * h; flSw += flSwV * h;
      flAcV += ((acTgt - flAc) * 35 - flAcV * 4.5) * h; flAc += flAcV * h;
    }
    cape.visible = !!s.cape && !ghost;
    if (cape.visible) cloth.step(rig, mdt, t, flowGo);
    else cloth.reset();
    const winged = !!s.wings && !ghost;
    wingMesh.visible = winged;
    // 6+ wins (s.auraCycle, when the aura starts cycling through the kitty colours): the revive rewards' victory look.
    // The cape turns near-black with its symbol, border and collar glowing in the aura's colour, and the wings'
    // feathers go rainbow (the boots' clock), running through the rainbow from the shoulder out to the tips
    const rainbowGear = !!s.auraCycle && !ghost;
    updateFur(s.rainbowCat, t);
    if (cape.visible) {
      const glow = !!s.auraCycle && !!s.auraColor && !ghost, dark = rainbowGear ? 1 : 0;
      if (glow && !capeGlowMat[dark]) {
        capeGlowMat[dark] = new THREE.MeshStandardMaterial({ map: capeTexture(0x000000, dark ? CAPE_DARK : CAPE_WHITE), emissiveMap: capeTexture(0xffffff, '#000000'), emissive: 0xffffff, emissiveIntensity: 0.85, side: THREE.DoubleSide, roughness: 0.85, flatShading: true });
      }
      if (glow && !collarGlowMat) collarGlowMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.6, flatShading: true });
      if (!glow && dark && !capeDarkMat) capeDarkMat = cmat('capeDarkMat:' + new THREE.Color(color).getHexString(), () => new THREE.MeshStandardMaterial({ map: capeTexture(color, CAPE_DARK), side: THREE.DoubleSide, roughness: 0.85, flatShading: true }));
      capeCloth.material = glow ? capeGlowMat[dark] : dark ? capeDarkMat : capeMat;
      capeCollar.material = glow ? collarGlowMat : collarMat;
      if (glow) { capeGlowMat[dark].emissive.copy(s.auraColor); collarGlowMat.color.copy(s.auraColor); collarGlowMat.emissive.copy(s.auraColor); }
    }
    if (winged && (rainbowGear || wingRainbow)) {
      const h0 = (t * 0.45 + rainbowOff) % 1;
      for (let i = 0; i < 2 * WING_INST; i++) {
        const k = i % WING_INST;
        if (rainbowGear) wingMesh.setColorAt(i, wingTmp.setHSL((h0 + WING_T[k] * 0.6) % 1, 0.9, 0.5 + 0.2 * WING_SHADE[k]));
        else wingMesh.setColorAt(i, wingCols[k]);
      }
      wingMesh.instanceColor.needsUpdate = true;
      wingRainbow = rainbowGear;
    }
    if (winged) {
      // open: folded at rest, spreading as you run (more when speeding up); breath at rest, bob with the stride,
      // swing with turns and sweep back when speeding up (the springs above, like the tail)
      wingPh += mdt * 0.45 * TAU_;
      const open = Math.min(1, Math.max(0, 0.05 + 0.95 * flowGo + Math.max(0, flAc) * 0.4));
      wingPose.update(mdt, open, flSw * 0.45, Math.max(-0.3, flAc * 0.5), Math.sin(wingPh) * 0.012 * (1 - flowGo) + Math.sin(phase * 2) * 0.014 * runAmt);
    }
    if (pack.visible) {
      if (s.packColors !== packCols) setPackColors(s.packColors);
      // the passengers bounce with the stride (a beat behind the body) and look about when idle
      for (let i = 0; i < packHeads.length; i++) {
        const h = packHeads[i], o = i * 1.7 + seedOff;
        h.position.y = h.userData.y + Math.abs(Math.sin(phase - 0.6 - i * 0.5)) * 0.022 * runAmt + Math.sin(t * 2.4 + o) * 0.005;
        h.rotation.z = Math.sin(phase * 2 + o) * 0.08 * runAmt + Math.sin(t * 1.3 + o) * 0.1 * (1 - Math.min(1, runAmt));
        h.rotation.y = h.userData.yaw + Math.sin(t * 0.8 + o) * 0.35 * (1 - Math.min(1, runAmt));
        h.rotation.x = Math.sin(phase + o) * 0.1 * runAmt;
      }
    }
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
  group.userData.onDispose = () => {
    if (fur) for (const p of fur) p.geo.dispose();
    for (const mt of [capeGlowMat[0], capeGlowMat[1], collarGlowMat]) if (mt) mt.dispose();
  };
  return { group, update: updateAll, setGhost };
}

// ---------------------------------------------------------------------------
// Wolf
// ---------------------------------------------------------------------------
const WOLF_TYPES = {
  patroller: { base: 0x8a909c, light: 0xd8dce4, dark: 0x464b57, accent: 0xffc23d },
  wanderer: { base: 0x8c5a38, light: 0xdcb48a, dark: 0x45291a, accent: 0xff8a2a },
  // Skate-only pattern wolves: wintry coats and a collar band (`scarf`) in the type color. `track` = route color on ice.
  charger: { base: 0x343a4c, light: 0xaab4cc, dark: 0x181b26, accent: 0xff2a55, scarf: 0xd0163f, track: 0xe0244c },
  crosser: { base: 0xc9d6e8, light: 0xf6f9ff, dark: 0x5f7499, accent: 0x18d6ff, scarf: 0x1886c8, track: 0x0f8fd0 },
  diagonal: { base: 0x54477e, light: 0xc4b6ec, dark: 0x251c44, accent: 0xb85cff, scarf: 0x7e34d8, track: 0x8f3ff0 },
};

// The scare ramp: every level the wolves look a bit nastier (tier 1 = grumpy ... 8 = feral, 9 = the final run's
// hellhounds), dressed for the season. Visual only; one baked geometry set per type x tier x season, so the
// instanced wolf pack still draws ~8 meshes per wolf type.
//   fur drifts toward a grim seasonal tint; scruff spikes grow and multiply; flank hackles (3+); scars + a torn
//   ear (4+); claws, extra fangs, elbow tufts (5+); drool (6+); claw-mark scars, spiky tail (7+).
//   collars (2+; pattern wolves always wear one in their type colour): summer studded leather, autumn bramble with
//   thorns (+ burrs and a dead leaf in the fur), winter spiked iron + frost-rimed spikes and icicles (no scarf),
//   spring a chain collar with a broken chain over the shoulder and muddy legs.
//   hell: charred fur, ember cracks (unlit glow mesh), bone spikes and horns, ember eyes.
// Eyes: the run wolves' amber/orange eyes redden with the tier; pattern wolves keep their type colour (it matches
// their track on the ice) until the final run, where every eye is an ember (the collar band keeps the type).
const WOLF_SEASON = { 0: 'summer', 1: 'autumn', 2: 'winter', 3: 'summer', 4: 'spring' };
const WOLF_GRIM = { summer: 0x29231e, autumn: 0x3a1d12, winter: 0x1e2537, spring: 0x272c1b };
const WOLF_HELL = { base: 0x30251f, light: 0x63504a, dark: 0x140d0b };
// the final run's hellhounds still wear a coat per type, so the three kinds read apart in the dim red light:
// chargers sooty black, crossers ash white, diagonals smouldering purple (others: WOLF_HELL)
const WOLF_HELL_TYPES = {
  charger: { base: 0x1d1917, light: 0x403835, dark: 0x090706 },
  crosser: { base: 0xd2d4dc, light: 0xf8f9ff, dark: 0x60626e },   // cool ash white (the red light warms it up)
  diagonal: { base: 0x5a2e66, light: 0x9a62aa, dark: 0x23102a },
};
const WOLF_RED_EYE = 0xff2a12, WOLF_EMBER = 0xff5a1e, WOLF_EMBER_HOT = 0xffa23a;
const BONE = 0xdccdad, STEEL = 0xc2c8d0, FROST = 0xe9f5ff, SCAR = 0xc98585, IRON = 0x2b2f37, LEATHER = 0x3c291c;

function wolfLook(o) {
  o = o || {};
  if (o.finale) return { tier: 9, s: 1, season: 'hell', hell: true, wild: !!o.wild };
  const tier = Math.max(1, Math.min(8, Math.round(o.level || 1)));
  return { tier, s: (tier - 1) / 7, season: WOLF_SEASON[o.theme] || 'summer', hell: false, wild: !!o.wild };   // wild: no collar (a ruff)
}

function wolfEyeColor(T, look) {
  if (look.hell) return new THREE.Color(WOLF_EMBER);
  const c = new THREE.Color(T.accent);
  return T.scarf ? c : c.lerp(new THREE.Color(WOLF_RED_EYE), 0.9 * look.s);
}

// matrix for a unit primitive (y axis, centred) stretched from point a to point b with radius r
const _up = new THREE.Vector3(0, 1, 0);
function along(a, b, r, rz) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d.normalize());
  return new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q,
    new THREE.Vector3(r, len, rz === undefined ? r : rz));
}
const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

function wolfGeos(type, look) {
  look = look || wolfLook();
  return cgeo('wolf:' + type + ':' + look.tier + ':' + look.season + (look.wild ? ':wild' : ''), () => {
    const T = WOLF_TYPES[type];
    const { tier, s, season, hell } = look;
    const winter = season === 'winter';
    const C = (h) => new THREE.Color(h);
    let base, light, dark;
    if (hell) { const H = WOLF_HELL_TYPES[type] || WOLF_HELL; base = C(H.base); light = C(H.light); dark = C(H.dark); }
    else {
      const g = C(WOLF_GRIM[season]);
      base = C(T.base).lerp(g, 0.5 * s); light = C(T.light).lerp(g, 0.36 * s); dark = C(T.dark).lerp(g, 0.42 * s);
    }
    const spikeCol = hell ? C(BONE) : dark;
    // a cone spike from `a` along `dir` (h long, r wide) + its frosted / charred tip
    const spike = (list, a, dir, h, r, col) => {
      const b = [a[0] + dir[0] * h, a[1] + dir[1] * h, a[2] + dir[2] * h];
      list.push([P.cone4, along(a, b, r), col]);
      if (winter) list.push([P.cone4, along(lerp3(a, b, 0.5), lerp3(a, b, 1.015), r * 0.53), FROST]);
      if (hell && col !== dark) list.push([P.cone4, along(lerp3(a, b, 0.62), lerp3(a, b, 1.01), r * 0.42), 0x3a2a22]);
    };
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
    // spiky scruff along the back: grows, multiplies and gets messier with the tier (hell: bone spines)
    const sp = hell ? 1.6 : 0.8 + 0.75 * s;
    const spikes = [[0.36, 0.86, 0.09], [0.22, 0.88, 0.1], [0.08, 0.81, 0.08], [-0.08, 0.77, 0.07], [-0.24, 0.75, 0.06]];
    const extra = [[0.29, 0.86, 0.075], [0.15, 0.85, 0.075], [0.0, 0.79, 0.065], [-0.16, 0.76, 0.06], [-0.32, 0.72, 0.05]];
    const nExtra = hell ? extra.length : Math.max(0, Math.min(extra.length, tier - 2));
    const scruff = spikes.concat(extra.slice(0, nExtra).map((e) => [e[0], e[1], e[2] * 0.85]));
    scruff.forEach(([x, y, sz], i) => {
      const h = sz * 2.1 * sp;
      const dir = norm3([-0.68, 0.73, (i % 2 ? 1 : -1) * (0.08 + 0.3 * s) * (i >= spikes.length ? 1.6 : 1)]);
      spike(body, [x - dir[0] * h * 0.5, y - dir[1] * h * 0.5, -dir[2] * h * 0.5], dir, h, sz * 0.8, spikeCol);
    });
    for (const sz of [1, -1]) spike(body, [0.31, 0.74, 0.1 * sz], norm3([-0.45, 0.85, 0.45 * sz]), 0.16 * sp, 0.06, base);
    // shaggy hackles fanning out of the flanks
    const hackles = [[0.24, 0.72, 0.19], [0.06, 0.72, 0.2], [-0.15, 0.68, 0.2]];
    const nHack = hell ? 3 : tier >= 7 ? 3 : tier >= 5 ? 2 : tier >= 3 ? 1 : 0;
    for (let i = 0; i < nHack; i++) for (const sd of [1, -1]) {
      const [x, y, z] = hackles[i];
      spike(body, [x, y, z * sd], norm3([-0.6, 0.45, 0.65 * sd]), 0.13 + 0.07 * s, 0.045, hell ? dark : base);
    }
    // collar round the neck (a ring in the y-z plane round [0.36, 0.68, 0]): replaces the old scarf, the pattern
    // wolves' band keeps their type colour
    const NECK = [0.36, 0.68, 0];
    const ring = (a, r) => [NECK[0], NECK[1] + Math.cos(a) * r, Math.sin(a) * r];
    const band = T.scarf ? C(T.scarf) : null;
    if (look.wild) {
      // wild (no collar): a shaggy ruff of fur round the neck, longer and messier every level; the skate wolves'
      // type colour streaks the tips instead of a collar band
      const n = 12 + Math.round(5 * s) + (hell ? 3 : 0), len = 0.14 + 0.1 * s + (hell ? 0.05 : 0);
      for (let layer = 0; layer < 2; layer++) {   // an outer ring of long tufts and a shorter one behind it
        for (let i = 0; i < n; i++) {
          const a = -1.8 + 3.6 * (i + layer * 0.5) / (n - 1 + layer), j = ((i * 53 + layer * 17) % 11) / 11 - 0.5;
          const o = ring(a, 0.16), d = norm3([-0.6 - 0.35 * layer + 0.25 * j, Math.cos(a) * 0.85, Math.sin(a) * 0.85]);
          const col = band && (i + layer) % 2 ? band : (i + layer) % 3 === 0 ? light : layer ? dark : base;
          spike(body, [o[0] - 0.05 * layer, o[1], o[2]], d, len * (0.75 + 0.45 * (((i * 29) % 7) / 7)) * (layer ? 0.75 : 1), 0.065, col);
        }
      }
    } else if (T.scarf || tier >= 2) {
      const ringM = (sc, ry) => mtx(NECK, [0, Math.PI / 2 + (ry || 0), 0], sc);
      if (season === 'autumn') {
        // bramble: twisted thorny vines (over the band)
        if (band) body.push([P.torus, ringM([0.2, 0.2, 0.22]), band]);
        for (const ry of [0, 0.22, -0.22]) body.push([P.torus, ringM([0.218, 0.218, 0.16], ry), 0x6a5634]);
        const n = 7 + Math.round(3 * s), th = 0.06 + 0.08 * s;
        for (let i = 0; i < n; i++) {
          const a = -1.5 + 3 * i / (n - 1), w = ((i * 37) % 7) / 7 - 0.5;
          const o = ring(a, 0.225), d = norm3([w * 0.8, Math.cos(a), Math.sin(a)]);
          body.push([P.cone4, along(o, [o[0] + d[0] * th, o[1] + d[1] * th, o[2] + d[2] * th], 0.022), 0x9a3c1e]);
        }
      } else if (season === 'spring') {
        // rusty chain collar + a broken chain trailing over the shoulder
        if (band) body.push([P.torus, ringM([0.19, 0.19, 0.2]), band]);
        const n = 12;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2, o = ring(a, 0.215);
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1),
            i % 2 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, Math.cos(a), Math.sin(a)));
          body.push([P.torus, new THREE.Matrix4().compose(new THREE.Vector3(...o), q, new THREE.Vector3(0.045, 0.045, 0.06)), i % 2 ? 0x8a5232 : 0x6e4028]);
        }
        const nTrail = 2 + Math.round(3 * s);
        for (let i = 0; i < nTrail; i++) {
          const o = [0.24 - i * 0.085, 0.84 + Math.sin(i * 1.3) * 0.012 - (i > 2 ? (i - 2) * 0.02 : 0), 0.1 + i * 0.012];
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), i % 2 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0));
          body.push([P.torus, new THREE.Matrix4().compose(new THREE.Vector3(...o), q, new THREE.Vector3(0.05, 0.035, 0.06)), i % 2 ? 0x8a5232 : 0x6e4028]);
        }
      } else {
        // spiked collar: studded leather in summer, iron with long (frosted) spikes in winter, bone in hell
        const col = band || (season === 'summer' ? LEATHER : IRON);
        body.push([P.torus, ringM([0.2, 0.2, 0.3]), col]);
        const n = winter || hell ? 7 : 5;
        const h = hell ? 0.17 : winter ? 0.07 + 0.12 * s : 0.04 + 0.12 * s;
        for (let i = 0; i < n; i++) {
          const a = -1.35 + 2.7 * i / (n - 1);
          spike(body, ring(a, 0.215), [0, Math.cos(a), Math.sin(a)], h, 0.026 + 0.01 * s, hell ? C(BONE) : C(STEEL));
        }
      }
    }
    // autumn: burrs and a dead leaf caught in the fur
    if (season === 'autumn' && tier >= 3) {
      const burrs = [[0.1, 0.8, 0.12], [-0.2, 0.77, -0.12], [-0.33, 0.7, 0.16], [0.2, 0.79, -0.15], [-0.05, 0.79, 0.15]];
      for (const b of burrs.slice(0, Math.min(5, tier - 2))) {
        body.push([P.ico0, mtx(b, null, 0.03), 0x5a3a1c]);
        for (const d of [[0, 1, 0], [0.7, 0.3, 0.6], [-0.6, 0.4, -0.6]]) body.push([P.cone4, along(b, [b[0] + d[0] * 0.05, b[1] + d[1] * 0.05, b[2] + d[2] * 0.05], 0.01), 0x4a2c12]);
      }
      const leaves = [[[-0.14, 0.81, -0.05], 0.7, 0xb8501a], [[0.12, 0.84, 0.07], -0.4, 0xd08a22], [[-0.34, 0.72, -0.1], 1.6, 0x9a2e16]];
      for (const [p, ry, col] of leaves.slice(0, tier >= 7 ? 3 : tier >= 5 ? 2 : 1)) body.push([P.oct, mtx(p, [0.15, ry, 0.1], [0.085, 0.014, 0.05]), col]);
    }
    // claw-mark scars raked across the rump
    if (tier >= 7 && !hell) for (let k = 0; k < 3; k++) body.push([P.box, mtx([-0.17 - k * 0.05, 0.8, 0.07], [0, 0.55, 0.12], [0.015, 0.026, 0.15]), SCAR]);

    // hell: glowing ember cracks over the back and down the flanks (unlit MeshBasic, colours <= 1)
    const glow = [];
    if (hell) {
      const topY = (x) => Math.max(0.6 + 0.23 * Math.sqrt(Math.max(0, 1 - ((x + 0.08) / 0.46) ** 2)), 0.71 + 0.11 * Math.sqrt(Math.max(0, 1 - ((x + 0.04) / 0.42) ** 2)));
      const zig = [[0.26, 0.03], [0.13, -0.06], [0.01, 0.05], [-0.12, -0.05], [-0.26, 0.05], [-0.39, -0.02]];
      for (let i = 0; i < zig.length - 1; i++) {
        const a = [zig[i][0], topY(zig[i][0]) - 0.005, zig[i][1]], b = [zig[i + 1][0], topY(zig[i + 1][0]) - 0.005, zig[i + 1][1]];
        glow.push([P.box, along(a, b, 0.024, 0.024), i % 2 ? WOLF_EMBER : WOLF_EMBER_HOT]);
      }
      const sideZ = (x, y) => 0.24 * Math.sqrt(Math.max(0, 1 - ((x + 0.08) / 0.46) ** 2 - ((y - 0.6) / 0.23) ** 2));
      for (const sd of [1, -1]) for (const [x0, ph] of [[0.02, 0], [-0.27, 1]]) {
        const pts = [[0, 0.76], [0.045, 0.69], [-0.02, 0.62], [0.035, 0.54]].map(([dx, y]) => [x0 + dx * (ph ? -1 : 1), y]);
        for (let i = 0; i < pts.length - 1; i++) {
          const [xa, ya] = pts[i], [xb, yb] = pts[i + 1];
          glow.push([P.box, along([xa, ya, sd * (sideZ(xa, ya) - 0.004)], [xb, yb, sd * (sideZ(xb, yb) - 0.004)], 0.022, 0.022), i % 2 ? WOLF_EMBER_HOT : WOLF_EMBER]);
        }
      }
    }

    const browA = hell ? 0.78 : 0.3 + 0.42 * s, browT = 0.035 + 0.015 * s;
    const fl = hell ? 0.15 : 0.06 + 0.07 * s, fr = 0.018 + 0.006 * s;
    const torn = tier >= 4 && !hell;
    const headParts = [
      [P.ico1, mtx([0, 0, 0], null, [0.2, 0.17, 0.18]), base],
      [P.ico1, mtx([-0.02, 0.075, 0], null, [0.15, 0.09, 0.13]), dark],
      [P.ico0, mtx([-0.05, -0.07, 0.13], null, [0.1, 0.08, 0.07]), light],
      [P.ico0, mtx([-0.05, -0.07, -0.13], null, [0.1, 0.08, 0.07]), light],
      [P.cone5, mtx([0.26, -0.035, 0], [0, 0, -Math.PI / 2], [0.105, 0.4, 0.095]), base],
      [P.ico1, mtx([0.2, -0.08, 0], null, [0.17, 0.045, 0.08]), light],
      [P.ico0, mtx([0.455, -0.03, 0], null, [0.05, 0.045, 0.05]), 0x161318],
      // ears (from tier 4 the left one is torn short)
      [P.cone4, mtx([-0.06, torn ? 0.2 : 0.24, 0.1], [0.3, Math.PI / 4, 0], [0.085, torn ? 0.15 : 0.24, 0.075]), dark],
      [P.cone4, mtx([-0.06, 0.24, -0.1], [-0.3, Math.PI / 4, 0], [0.085, 0.24, 0.075]), dark],
      [P.cone4, mtx([-0.04, torn ? 0.19 : 0.22, 0.1], [0.3, Math.PI / 4, 0], [0.05, torn ? 0.1 : 0.16, 0.045]), light],
      [P.cone4, mtx([-0.04, 0.22, -0.1], [-0.3, Math.PI / 4, 0], [0.05, 0.16, 0.045]), light],
      // angry brows (steeper and heavier with the tier)
      [P.box, mtx([0.12, 0.09, 0.1], [0.25, 0, -browA], [0.15, browT, 0.05]), dark],
      [P.box, mtx([0.12, 0.09, -0.1], [-0.25, 0, -browA], [0.15, browT, 0.05]), dark],
      // fangs
      [P.cone4, mtx([0.33, -0.075 - fl / 2, 0.045], [Math.PI, 0, 0], [fr, fl, fr]), hell ? BONE : 0xffffff],
      [P.cone4, mtx([0.33, -0.075 - fl / 2, -0.045], [Math.PI, 0, 0], [fr, fl, fr]), hell ? BONE : 0xffffff],
    ];
    if (tier >= 5) for (const sd of [1, -1]) headParts.push([P.cone4, mtx([0.25, -0.08 - fl * 0.35, 0.06 * sd], [Math.PI, 0, 0], [fr * 0.8, fl * 0.7, fr * 0.8]), hell ? BONE : 0xf4f0e8]);
    if (winter) {
      for (const sd of [1, -1]) {   // frost-rimed ear tips
        const half = torn && sd > 0 ? 0.075 : 0.12, cy = torn && sd > 0 ? 0.2 : 0.24;
        const ax = [0, Math.cos(0.3), Math.sin(0.3) * sd], tip = [-0.06, cy + ax[1] * half, 0.1 * sd + ax[2] * half];
        headParts.push([P.cone4, along(tip.map((v, k) => v - ax[k] * 0.08), tip.map((v, k) => v + ax[k] * 0.006), 0.03), FROST]);
      }
      if (tier >= 4) for (const sd of [1, -1]) headParts.push([P.cone4, mtx([0.22, -0.13, 0.075 * sd], [Math.PI, 0, 0], [0.012, 0.05 + 0.04 * s, 0.012]), FROST]);
    }
    if (torn) headParts.push([P.box, mtx([0.05, 0.145, 0.065], [0, 0.6, -0.2], [0.2, 0.014, 0.022]), SCAR]);
    if (tier >= 6 && !hell) {
      headParts.push([P.box, mtx([0.13, 0.04, -0.15], [0.35, 0, 0.3], [0.014, 0.17, 0.02]), SCAR]);
      if (!winter) {   // drool
        headParts.push([P.box, mtx([0.31, -0.075 - fl - 0.035, 0.07], null, [0.011, 0.07, 0.011]), 0xd4ecf6]);
        headParts.push([P.ico0, mtx([0.31, -0.075 - fl - 0.075, 0.07], null, 0.016), 0xd4ecf6]);
      }
    }
    if (hell) {
      // curved demon horns, bone fading to char at the tips
      for (const sd of [1, -1]) {
        const pts = [[-0.03, 0.15, 0.1 * sd], [-0.03, 0.29, 0.17 * sd], [-0.14, 0.39, 0.22 * sd], [-0.29, 0.39, 0.22 * sd], [-0.38, 0.32, 0.2 * sd]];
        const rad = [0.05, 0.04, 0.03, 0.02];
        for (let i = 0; i < 4; i++) {
          const a = pts[i], b = lerp3(a, pts[i + 1], 1.12);
          headParts.push([i < 3 ? P.cyl6 : P.cone5, along(a, b, rad[i]), i < 2 ? BONE : i < 3 ? 0x9a8a72 : 0x3a2c24]);
        }
      }
    }
    const head = bake(headParts);
    const ey = 0.034 - 0.008 * s, et = -0.3 - 0.22 * s;
    const eyes = bake([
      [P.ico0, mtx([0.13, 0.035, 0.13], [0.3, -0.5, et], [0.068 + 0.014 * s, ey, 0.045 + 0.006 * s]), 0xffffff],
      [P.ico0, mtx([0.13, 0.035, -0.13], [-0.3, 0.5, et], [0.068 + 0.014 * s, ey, 0.045 + 0.006 * s]), 0xffffff],
    ]);
    const jf = 0.04 + 0.04 * s;
    const jaw = bake([
      [P.cone4, mtx([0.16, 0, 0], [0, Math.PI / 4, -Math.PI / 2], [0.065, 0.3, 0.065]), light],
      [P.cone4, mtx([0.22, 0.015 + jf / 2, 0.03], null, [0.012 + 0.004 * s, jf, 0.012 + 0.004 * s]), hell ? BONE : 0xffffff],
      [P.cone4, mtx([0.22, 0.015 + jf / 2, -0.03], null, [0.012 + 0.004 * s, jf, 0.012 + 0.004 * s]), hell ? BONE : 0xffffff],
    ]);
    const legParts = [
      [P.ico1, mtx([0, -0.03, 0], null, [0.09, 0.1, 0.08]), base],
      [P.cyl6, mtx([0, -0.22, 0], null, [0.058, 0.42, 0.058]), base],
      [P.ico1, mtx([0.025, -0.455, 0], null, [0.08, 0.05, 0.07]), dark],
    ];
    if (season === 'spring') {   // muddy socks, splashing higher up the leg each level
      const mh = 0.1 + 0.16 * s;
      legParts.push([P.cyl6, mtx([0, -0.43 + mh / 2, 0], null, [0.064, mh, 0.064]), 0x4e3826]);
      legParts.push([P.ico1, mtx([0.025, -0.45, 0], null, [0.086, 0.056, 0.076]), 0x3e2c1e]);
    }
    if (tier >= 5) {
      for (const z of [-0.035, 0, 0.035]) legParts.push([P.cone4, along([0.08, -0.46, z], [0.135, -0.485, z * 1.2], 0.012), hell ? BONE : 0xe8e2d6]);
      spike(legParts, [-0.04, -0.1, 0], norm3([-0.9, -0.35, 0]), 0.09, 0.03, base);
    }
    const leg = bake(legParts);
    const tailMid = [[P.ico1, mtx([0, 0.09, 0], null, [0.125, 0.16, 0.12]), base], [P.ico0, mtx([0.03, 0.06, 0], [0, 0, 0.4], [0.1, 0.12, 0.13]), dark]];
    if (tier >= 7) for (const [y, d] of [[0.04, [1, 0.4, 0.3]], [0.12, [1, 0.4, -0.3]]]) spike(tailMid, [0.09, y, 0], norm3(d), 0.11, 0.035, spikeCol);
    const tail = [
      bake([[P.ico1, mtx([0, 0.08, 0], null, [0.09, 0.12, 0.09]), base]]),
      bake(tailMid),
      bake([[P.ico1, mtx([0, 0.06, 0], null, [0.1, 0.12, 0.1]), base], [P.ico1, mtx([0, 0.15, 0], null, [0.075, 0.1, 0.075]), hell ? 0x7a2412 : light], [P.cone5, mtx([0, 0.26, 0], null, [0.045, 0.1, 0.045]), hell ? 0x2a1a14 : light]]),
    ];
    return { body: bake(body), head, eyes, jaw, leg, tail, glow: glow.length ? bake(glow) : null };
  });
}

// opts: { level, theme, finale } pick the scare tier + season look (see wolfLook); without them: the tier-1 summer wolf
// A wolf: createWolfRig builds the posable model (cached geometries, one rig per wolf type is enough) and
// pose(state, dt, s) animates it from one wolf's own state (newWolfState: its stride phase, run amount, clock and a
// random offset), so many wolves can share one rig (main.js poses it for each visible wolf, then wolfpack.js copies
// the pose). createWolfModel = a rig with a state of its own.
function newWolfState() {
  return { seedOff: Math.random() * 100, phase: Math.random() * 6, runAmt: 0, clock: 0 };
}
function createWolfModel(type, opts) {
  const rig = createWolfRig(type, opts), st = newWolfState();
  rig.pose(st, 0, {});
  return { group: rig.group, update: (dt, s) => rig.pose(st, dt, s) };
}
function createWolfRig(type, opts) {
  if (!WOLF_TYPES[type]) type = 'patroller';
  const T = WOLF_TYPES[type];
  const look = wolfLook(opts);
  const G = wolfGeos(type, look);
  const mat = VC_MAT();
  const group = new THREE.Group();
  group.name = 'wolf';
  const rig = new THREE.Group();
  group.add(rig);

  const body = new THREE.Mesh(G.body, mat); body.castShadow = true; rig.add(body);
  // hell: the ember cracks (unlit, vertex coloured; the wolf pack instances it like the eyes)
  if (G.glow) rig.add(new THREE.Mesh(G.glow, cmat('wolfGlow', () => new THREE.MeshBasicMaterial({ vertexColors: true }))));
  const head = new THREE.Group(); head.position.set(0.5, 0.8, 0); rig.add(head);
  const headMesh = new THREE.Mesh(G.head, mat); headMesh.castShadow = true; head.add(headMesh);

  const eyeMat = new THREE.MeshBasicMaterial({ color: wolfEyeColor(T, look) });
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

  function pose(st, dt, s) {
    s = s || {};
    dt = Math.min(dt || 0, 0.1);
    st.clock += dt;
    const time = s.time !== undefined ? s.time : st.clock;
    const moving = !!s.moving;
    const sp = s.speed01 === undefined ? (moving ? 1 : 0) : Math.max(0, Math.min(1, s.speed01));
    st.runAmt = smoothTo(st.runAmt, moving ? Math.max(0.45, sp) : 0, 9, dt);
    st.phase += dt * (7 + 7 * sp) * (st.runAmt > 0.01 ? 1 : 0);
    const { seedOff, phase, runAmt } = st;
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

  return { group, pose };
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
    // the same speed boot the kitty wears (speedBootGeometry), scaled up to the pickup's usual size (~0.4 tall)
    const boot = new THREE.Mesh(speedBootGeometry(), VC_MAT()); boot.castShadow = QUALITY.propShadows;
    boot.scale.setScalar(2.1); boot.position.set(-0.05, 0.47, 0);
    spin.add(boot);
    spin.rotation.z = 0.12;
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

// Backpack (8+ wins), in pack space (pack group at PACK_POS in kitty rig space, +x forward): a rounded canvas bag
// sitting on the back between shoulders and hips, open at the top (leather rim, dark inside), a rear pocket with a
// flap and gold buckle, side pockets, and two straps round the body (a tilted chest strap and a belly strap).
const PACK_POS = [-0.12, 0.6, 0];
// passenger head slots by count (x, y, z, yaw): front row low (paws on the rim), back row a bit higher, fanned out
const PACK_SLOTS = [
  [[0.0, 0.17, 0, 0]],
  [[0.0, 0.17, 0.065, -0.3], [0.0, 0.17, -0.065, 0.3]],
  [[0.04, 0.16, 0.072, -0.35], [0.04, 0.16, -0.072, 0.35], [-0.05, 0.215, 0, 0]],
  [[0.045, 0.16, 0.068, -0.3], [0.045, 0.16, -0.068, 0.3], [-0.05, 0.21, 0.07, -0.6], [-0.05, 0.21, -0.07, 0.6]],
  [[0.055, 0.15, 0, 0], [0.035, 0.16, 0.1, -0.45], [0.035, 0.16, -0.1, 0.45], [-0.055, 0.21, 0.06, -0.5], [-0.055, 0.21, -0.06, 0.5]],
];
const PACK_KIT_S = 1.3;   // passenger head scale
// medic cape (10+ revives): front edge at the neck, CAPE_LEN back along the body, CAPE_W wide, CAPE_Y above the feet
const CAPE_LEN = 0.44, CAPE_W = 0.36, CAPE_X0 = 0.16, CAPE_Y = 0.62;
// The symbol and the border in the kitty's own colour on white cloth (CAPE_DARK, near-black, from 6+ wins: the aura's
// colours vanish on white), the staff and snake cut out of the symbol in the cloth colour. With the cycling victory aura (6+
// wins) the cape is drawn twice more: with a black symbol (capeTexture(0x000000, cloth)) and as a glow mask (white
// symbol and border on black, cloth and staff black: capeTexture(0xffffff, '#000000')), so the symbol glows in the
// aura's colour and the cloth keeps its own.
const CAPE_WHITE = '#f8f8f5', CAPE_DARK = '#1a1822';
function capeTexture(color, cloth = CAPE_WHITE) {
  const star = '#' + new THREE.Color(color).getHexString();
  return ctex('capeTex7:' + star + cloth, () => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const WHITE = cloth;
    // canvas x runs hem (0) -> neck (256) along the cape, canvas y across it; "up" on the symbol points at the neck (+x)
    g.fillStyle = star; g.fillRect(0, 0, 256, 256);
    g.fillStyle = WHITE; g.fillRect(14, 16, 256 - 14 - 10, 256 - 32);   // white cloth inside a kitty-coloured border all round
    // the star of life, as big as the cape allows (the cape is longer than wide: drawn stretched across so it isn't
    // squashed on the cloth), a little toward the hem (the neck end hides under the head)
    const cx = 124, cy = 128;
    g.save(); g.translate(cx, cy); g.scale(1.34, 1.34 * CAPE_LEN / CAPE_W);   // fills the white cloth edge to edge
    g.fillStyle = star;
    for (const a of [0, Math.PI / 3, -Math.PI / 3]) { g.save(); g.rotate(a); g.fillRect(-66, -19, 132, 38); g.restore(); }
    // the white staff (pointing at the neck) with a snake wound round it
    g.strokeStyle = WHITE; g.fillStyle = WHITE; g.lineCap = 'round';
    g.lineWidth = 8; g.beginPath(); g.moveTo(-54, 0); g.lineTo(54, 0); g.stroke();
    g.beginPath(); g.arc(57, 0, 6.5, 0, Math.PI * 2); g.fill();
    g.lineWidth = 5.5; g.beginPath();
    for (let x = -48; x <= 40; x += 2) { const y = Math.sin(x * 0.15) * 11; if (x === -48) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
    g.beginPath(); g.ellipse(43, Math.sin(43 * 0.15) * 11, 7, 5.5, 0, 0, Math.PI * 2); g.fill();   // the snake's head
    g.restore();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

// ---- medic cape cloth (10+ revives): verlet particles on the cape's grid (CAPE_NX along it, CAPE_NZ across), in
// world space so the body's real movement drives it. The collar edge is pinned to the body; every particle has
// distance springs to its neighbours (along, across, diagonals and two apart, for some stiffness) at their lengths in
// the draped rest shape, gravity and air drag, and is pushed out of a body-shaped ellipsoid. Written back into the
// cape geometry in the rig's space every frame.
const CAPE_NX = 7, CAPE_NZ = 5;
const CAPE_G = 7, CAPE_DRAG = 0.965, CAPE_ITER = 4;
const CAPE_BODY = { c: [-0.05, 0.41, 0], r: [0.34, 0.205, 0.195] };   // the kitty's body (rig space) the cape lies on
function makeCapeCloth(geo) {
  const pos = geo.attributes.position, b = pos.array, n = pos.count;
  const idx = (ix, iz) => iz * CAPE_NX + ix;   // PlaneGeometry: rows across the width, columns along the length
  // draped rest shape (rig space): over the back, the sides hanging, a little longer toward the hem
  const rest = new Float32Array(n * 3), pinned = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = b[i * 3], z = b[i * 3 + 2], u = (CAPE_X0 - x) / CAPE_LEN, v = z / (CAPE_W / 2);
    rest[i * 3] = x; rest[i * 3 + 1] = CAPE_Y - u * 0.07 - v * v * (0.17 + 0.05 * u); rest[i * 3 + 2] = z * (1 + 0.15 * u);
    pinned[i] = u < 1e-4 ? 1 : 0;
  }
  const links = [];
  const link = (a, c) => links.push([a, c, Math.hypot(rest[a * 3] - rest[c * 3], rest[a * 3 + 1] - rest[c * 3 + 1], rest[a * 3 + 2] - rest[c * 3 + 2])]);
  for (let iz = 0; iz < CAPE_NZ; iz++) for (let ix = 0; ix < CAPE_NX; ix++) {
    if (ix + 1 < CAPE_NX) link(idx(ix, iz), idx(ix + 1, iz));
    if (iz + 1 < CAPE_NZ) link(idx(ix, iz), idx(ix, iz + 1));
    if (ix + 1 < CAPE_NX && iz + 1 < CAPE_NZ) { link(idx(ix, iz), idx(ix + 1, iz + 1)); link(idx(ix + 1, iz), idx(ix, iz + 1)); }
    if (ix + 2 < CAPE_NX) link(idx(ix, iz), idx(ix + 2, iz));
    if (iz + 2 < CAPE_NZ) link(idx(ix, iz), idx(ix, iz + 2));
  }
  const P = new Float32Array(n * 3), Q = new Float32Array(n * 3);   // world positions now / a step ago
  const M = new THREE.Matrix4(), Mi = new THREE.Matrix4(), M0 = new THREE.Matrix4(), v3 = new THREE.Vector3(), w3 = new THREE.Vector3();
  let live = false;
  const pin = (i, out) => { v3.set(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]).applyMatrix4(M); out[i * 3] = v3.x; out[i * 3 + 1] = v3.y; out[i * 3 + 2] = v3.z; };
  // the collar slides from where it was last frame to where it is now over the substeps (not in one yank)
  const pinAt = (i, f) => {
    v3.set(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]); w3.copy(v3).applyMatrix4(M0); v3.applyMatrix4(M).lerp(w3, 1 - f);
    P[i * 3] = v3.x; P[i * 3 + 1] = v3.y; P[i * 3 + 2] = v3.z;
  };
  function reset() { live = false; }
  function step(rig, dt, t, go) {
    rig.updateWorldMatrix(true, false);
    M.copy(rig.matrixWorld); Mi.copy(M).invert();
    // first frame, or the kitty jumped (respawn, new level): start from the draped rest shape
    v3.set(rest[0], rest[1], rest[2]).applyMatrix4(M);
    if (!live || dt > 0.1 || Math.hypot(v3.x - P[0], v3.y - P[1], v3.z - P[2]) > 1) {
      for (let i = 0; i < n; i++) { pin(i, P); pin(i, Q); }
      live = true; M0.copy(M);
    }
    const steps = Math.max(1, Math.ceil(dt / 0.012)), h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        if (pinned[i]) { pinAt(i, (s + 1) / steps); Q[k] = P[k]; Q[k + 1] = P[k + 1]; Q[k + 2] = P[k + 2]; continue; }
        // a faint breeze ripple (stronger with speed) so it never looks frozen
        const wob = Math.sin(t * (3 + 5 * go) + i * 1.7) * (0.15 + 0.6 * go);
        for (let a = 0; a < 3; a++) {
          const x = P[k + a], vx = (x - Q[k + a]) * CAPE_DRAG;
          Q[k + a] = x;
          P[k + a] = x + vx + (a === 1 ? -CAPE_G + wob : 0) * h * h;
        }
      }
      for (let it = 0; it < CAPE_ITER; it++) {
        for (const [a, c, L] of links) {
          const ka = a * 3, kc = c * 3;
          const dx = P[kc] - P[ka], dy = P[kc + 1] - P[ka + 1], dz = P[kc + 2] - P[ka + 2], d = Math.hypot(dx, dy, dz) || 1e-6;
          const f = (d - L) / d, wa = pinned[a] ? 0 : pinned[c] ? 1 : 0.5, wc = pinned[c] ? 0 : pinned[a] ? 1 : 0.5;
          P[ka] += dx * f * wa; P[ka + 1] += dy * f * wa; P[ka + 2] += dz * f * wa;
          P[kc] -= dx * f * wc; P[kc + 1] -= dy * f * wc; P[kc + 2] -= dz * f * wc;
        }
        // keep the cloth on the outside of the body, behind the neck (it never flips forward over the head: once there,
        // running would just push it along in front of the chest) and off the ground
        for (let i = 0; i < n; i++) {
          if (pinned[i]) continue;
          const k = i * 3;
          v3.set(P[k], P[k + 1], P[k + 2]).applyMatrix4(Mi);
          let moved = false;
          if (v3.x > CAPE_X0 - 0.02) { v3.x = CAPE_X0 - 0.02; moved = true; }
          if (v3.y < 0.12) { v3.y = 0.12; moved = true; }
          const ex = (v3.x - CAPE_BODY.c[0]) / CAPE_BODY.r[0], ey = (v3.y - CAPE_BODY.c[1]) / CAPE_BODY.r[1], ez = (v3.z - CAPE_BODY.c[2]) / CAPE_BODY.r[2];
          const e = Math.hypot(ex, ey, ez);
          if (e < 1 && e > 1e-6) { v3.set(CAPE_BODY.c[0] + ex / e * CAPE_BODY.r[0], CAPE_BODY.c[1] + ey / e * CAPE_BODY.r[1], CAPE_BODY.c[2] + ez / e * CAPE_BODY.r[2]); moved = true; }
          if (!moved) continue;
          v3.applyMatrix4(M);
          P[k] = v3.x; P[k + 1] = v3.y; P[k + 2] = v3.z;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      v3.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(Mi);
      b[i * 3] = v3.x; b[i * 3 + 1] = v3.y; b[i * 3 + 2] = v3.z;
    }
    M0.copy(M);
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }
  return { step, reset };
}

// ---- feathered wings (60+ revives). Each wing is a chain shoulder -> elbow -> wrist -> tip with feathers rooted along
// it in three rows (long flight feathers at the back, then secondaries, then short coverts on top), and two poses:
//   folded (WING_FOLD): like a resting bird's or a skyscale's, a Z: the arm up and a little back, the forearm forward so
//     the wrist sits high by the shoulder, the hand back along the flank; the feathers lie flat against the side,
//     hanging back and down.
//   open (WING_OPEN): spread out to the side in an arch (up from the shoulder, curving down to the tip), the feathers
//     fanning out behind, flat and facing up.
// The pose blends between them with the shoulder leading and the elbow and wrist following a beat later. Offsets are
// for the right (+z) wing in rig space (the kitty faces +x); the left wing is its mirror image.
const WING_ROOT = [0.12, 0.55, 0.17];
const WING_FOLD = [[-0.07, 0.13, 0.02], [0.08, 0.05, 0.0], [-0.36, -0.1, 0.02]];   // shoulder->elbow, elbow->wrist, wrist->tip
const WING_OPEN = [[0.0, 0.08, 0.13], [-0.01, 0.03, 0.13], [-0.05, -0.06, 0.12]];
const WING_N = 12;   // feathers per row
// [length share, fur shade (0 = the kitty's colour, 1 = its light belly colour), width, layer, where along the wing the
// row starts]; the last row is short puffy fluff over the outer half
const WING_ROWS = [[1, 0, 0.05, 0, 0], [0.6, 0.25, 0.05, 1, 0], [0.3, 0.6, 0.055, 2, 0], [0.42, 0.85, 0.075, 3, 0.45]];
const WING_INST = 3 + WING_ROWS.length * WING_N;   // 3 bones + the feathers
// in the kitty's own fur: darker leading edge, the flight feathers with a few tabby bands, lighter toward the top
// each instance's place along the wing (0 shoulder .. 1 tip) and its row's shade, for the rainbow wings
const WING_T = [], WING_SHADE = [];
for (let k = 0; k < 3; k++) { WING_T.push(k / 3); WING_SHADE.push(0); }
for (const [, shade, , , t0] of WING_ROWS) for (let j = 0; j < WING_N; j++) { WING_T.push(t0 + (1 - t0) * (j + 0.5) / WING_N); WING_SHADE.push(shade); }
function wingColors(color) {
  const { base, light, dark } = kittyPalette(color);
  const c = [];
  for (let k = 0; k < 3; k++) c.push(base.clone().lerp(dark, 0.5));
  for (const [, shade, , layer] of WING_ROWS) for (let i = 0; i < WING_N; i++) {
    const col = base.clone().lerp(light, shade);
    if (layer === 0 && i % 3 === 1) col.lerp(dark, 0.55);
    c.push(col.multiplyScalar(i % 2 ? 1 : 0.95));
  }
  return c;
}
function makeWingPose(mesh) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const pts = [V(), V(), V(), V()], dirF = V(), dirO = V(), nF = V(0, 0, 1), nO = V(0, 1, 0.12).normalize();
  const d = V(), nrm = V(), w = V(), p = V(), m = new THREE.Matrix4();
  let oS = 0, oE = 0, oW = 0;
  // feather / bone matrix: a flat ellipsoid from a along dir (len), width across, thin through nrm
  const n2 = V(), dl = V(), nOs = V(), ORIGIN = V();   // scratch (no allocations per frame)
  const put = (i, a, dir, len, width, thick, nr) => {
    w.crossVectors(nr, dir).normalize();
    n2.crossVectors(dir, w).normalize();
    m.makeBasis(w.multiplyScalar(width), dl.copy(dir).multiplyScalar(len / 2), n2.multiplyScalar(thick));
    m.setPosition(a.x + dir.x * len / 2, a.y + dir.y * len / 2, a.z + dir.z * len / 2);
    mesh.setMatrixAt(i, m);
  };
  const rotY = (v, ang, o) => { const x = v.x - o.x, z = v.z - o.z, c = Math.cos(ang), s = Math.sin(ang); v.x = o.x + x * c + z * s; v.z = o.z - x * s + z * c; };
  function update(dt, open, swing, throwBack, bob) {
    // the shoulder leads, the elbow and wrist follow
    oS = smoothTo(oS, open, 7, dt); oE = smoothTo(oE, oS, 5, dt); oW = smoothTo(oW, oE, 4, dt);
    const os = [oS, oE, oW];
    for (let side = 0; side < 2; side++) {
      const sz = side ? -1 : 1, base = side * WING_INST;
      // the chain: blended joint offsets, then mirrored for the left wing and swung round the shoulder (turns: both
      // wings the same way; speeding up: both back toward the tail)
      pts[0].set(WING_ROOT[0], WING_ROOT[1], WING_ROOT[2] * sz);
      for (let k = 0; k < 3; k++) {
        const f = WING_FOLD[k], o = WING_OPEN[k], a = os[k];
        pts[k + 1].set(pts[k].x + f[0] + (o[0] - f[0]) * a, pts[k].y + f[1] + (o[1] - f[1]) * a + (k ? bob : 0), pts[k].z + (f[2] + (o[2] - f[2]) * a) * sz);
      }
      for (let k = 1; k < 4; k++) rotY(pts[k], swing - throwBack * sz * k / 3, pts[0]);
      for (let k = 0; k < 3; k++) {   // the bones (the wing's leading edge)
        d.subVectors(pts[k + 1], pts[k]);
        const len = d.length();
        put(base + k, pts[k], d.normalize(), len, 0.028 - 0.005 * k, 0.024, nrm.set(0, 1, 0));
      }
      let i = base + 3;
      for (const [share, , width, layer, t0] of WING_ROWS) {
        const fluff = t0 > 0;
        for (let j = 0; j < WING_N; j++) {
          const t = t0 + (1 - t0) * (j + 0.5) / WING_N, s3 = Math.min(2.999, t * 3), k = Math.floor(s3), fk = s3 - k;
          p.lerpVectors(pts[k], pts[k + 1], fk);
          const a = os[k];
          dirF.set(-1, -0.45, 0).normalize(); dirO.set(-1, -0.12, (0.12 + 0.35 * t) * sz).normalize();
          d.lerpVectors(dirF, dirO, a).normalize();
          nrm.set(nF.x, nF.y, nF.z * sz).lerp(nOs.set(nO.x, nO.y, nO.z * sz), a).normalize();
          rotY(d, swing - throwBack * sz * t, ORIGIN);
          if (fluff) { d.y += (j % 2 ? 0.12 : -0.1); d.normalize(); }   // tufts ruffled a little out of line
          const len = (0.12 + 0.24 * t) * share * (0.85 + 0.15 * a) * (fluff ? 0.9 + 0.2 * (j % 3) / 2 : 1);
          p.addScaledVector(nrm, layer * 0.008);   // rows stacked: coverts on top
          put(i++, p, d, len, width * (0.85 + 0.3 * t), fluff ? 0.022 : 0.011, nrm);
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  return { update };
}

function backpackGeometry() {
  return cgeo('backpack', () => {
    const CANVAS = 0xb9814a, CANVAS_L = 0xd3a066, LEATHER = 0x7b4b28, INSIDE = 0x2b1b12, BUCKLE = 0xffd34a, STRAP = 0x6a3f22;
    const ring = new THREE.TorusGeometry(1, 0.075, 4, 20).rotateY(Math.PI / 2);   // strap loop round the x axis
    const out = bake([
      [P.ico1, mtx([0, 0, 0], null, [0.13, 0.12, 0.15]), CANVAS],
      [P.cyl18, mtx([0, 0.095, 0], null, [0.11, 0.03, 0.135]), LEATHER],                 // rim
      [P.cyl18, mtx([0, 0.111, 0], null, [0.092, 0.002, 0.117]), INSIDE],                // the open top
      [P.ico1, mtx([-0.115, -0.025, 0], null, [0.045, 0.07, 0.1]), CANVAS_L],            // rear pocket
      [P.box, mtx([-0.152, 0.02, 0], [0, 0, -0.3], [0.012, 0.06, 0.15]), LEATHER],       // its flap
      [P.box, mtx([-0.167, -0.012, 0], null, [0.012, 0.024, 0.032]), BUCKLE],
      [P.ico1, mtx([-0.01, -0.035, 0.14], null, [0.055, 0.045, 0.025]), CANVAS_L],        // side pockets
      [P.ico1, mtx([-0.01, -0.035, -0.14], null, [0.055, 0.045, 0.025]), CANVAS_L],
      [ring, mtx([0.19, -0.24, 0], [0, 0, 0.35], [0.4, 0.205, 0.222]), STRAP],          // chest strap (top leans back to the pack)
      [ring, mtx([-0.04, -0.26, 0], [0, 0, -0.12], [0.4, 0.205, 0.222]), STRAP],        // belly strap
      [P.box, mtx([0.122, -0.026, 0], [0, 0, 0.35], [0.03, 0.012, 0.05]), BUCKLE],      // strap buckle on the shoulders
    ]);
    ring.dispose();
    return out;
  });
}

// a kitten head peeking out of the backpack (head space, +x = facing): fur in the player's colour, ears, big
// eyes, pink nose and two paws hooked over the rim
function kittenHeadGeometry(color) {
  return cgeo('kitten:' + new THREE.Color(color).getHexString(), () => {
    const { base, light } = kittyPalette(color);
    const parts = [
      [P.ico1, mtx([0, 0, 0], null, [0.055, 0.05, 0.058]), base],
      [P.ico1, mtx([0.042, -0.014, 0], null, [0.022, 0.018, 0.03]), light],                 // muzzle
      [P.ico0, mtx([0.062, -0.006, 0], null, 0.007), PINK],                                  // nose
    ];
    for (const sz of [1, -1]) {
      parts.push([P.cone4, mtx([-0.005, 0.052, 0.03 * sz], [0.35 * sz, Math.PI / 4, 0], [0.026, 0.048, 0.024]), base]);
      parts.push([P.cone4, mtx([0.003, 0.048, 0.029 * sz], [0.35 * sz, Math.PI / 4, 0], [0.015, 0.032, 0.014]), PINK]);
      parts.push([P.ico1, mtx([0.044, 0.012, 0.022 * sz], null, [0.011, 0.016, 0.012]), PUPIL]);      // eyes
      parts.push([P.ico0, mtx([0.053, 0.019, 0.02 * sz], null, 0.0045), EYE_WHITE]);
      parts.push([P.ico1, mtx([0.05, -0.05, 0.026 * sz], null, [0.022, 0.014, 0.018]), light]);       // paws
    }
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

export { WOLF_TYPES, ghostMaterial, disposeModel, createKittyModel, createWolfModel, createWolfRig, newWolfState, createItemModel, createReviveCircleModel, createPortalModel, createCrownPickupModel, createGiantFishModel };
