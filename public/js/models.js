import * as THREE from 'three';
import { CFG } from './shared/config.js';

// models.js — procedural low-poly models for Run Kitty Run.
// All models face +X in local space, stand on y = 0.
// Notes / interpretations:
// - Static parts of each rig are baked into single vertex-colored geometries (cached per color/type) and
//   share ONE MeshStandardMaterial (flatShading, vertexColors) to keep draw calls and programs low.
// - Glowing parts use MeshBasicMaterial / ShaderMaterial with colors > 1 so the bloom pass picks them up.
// - createKittyModel(...).setGhost(on, tint?) accepts an optional tint color (used by the revive circle).
// - createWolfModel adds a faint type-colored ground ring for readability from above.

// ---------------------------------------------------------------------------
// Caches & helpers
// ---------------------------------------------------------------------------
const GEO_CACHE = new Map();
const MAT_CACHE = new Map();
const TEX_CACHE = new Map();
function cgeo(key, fn) { let g = GEO_CACHE.get(key); if (!g) { g = fn(); GEO_CACHE.set(key, g); } return g; }
function cmat(key, fn) { let m = MAT_CACHE.get(key); if (!m) { m = fn(); MAT_CACHE.set(key, m); } return m; }
function ctex(key, fn) { let t = TEX_CACHE.get(key); if (!t) { t = fn(); TEX_CACHE.set(key, t); } return t; }

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
};

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

function glowColor(hex, k) { return new THREE.Color(hex).multiplyScalar(k); }

const VC_MAT = () => cmat('vc', () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0.0 }));

function basicGlow(key, hex, k, opts) {
  return cmat('glow:' + key + ':' + hex + ':' + k, () => new THREE.MeshBasicMaterial(Object.assign({
    color: glowColor(hex, k), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: true,
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
  float rim = pow(f, 2.4);
  float band = 0.5 + 0.5 * sin(vP.y * 13.0 - uTime * 3.2 + sin(vP.x * 5.0 + uTime) * 1.6);
  float hex = smoothstep(0.82, 1.0, abs(sin(vP.x * 11.0 + uTime * 0.7) * sin(vP.y * 11.0) * sin(vP.z * 11.0 - uTime * 0.5)));
  vec3 col = uColor * (0.10 + rim * 2.4 + band * rim * 0.9 + hex * 0.35);
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
  float fade = pow(1.0 - vUv.y, 1.6) * smoothstep(0.0, 0.06, vUv.y + 0.02);
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
  col += uColB * core * 1.6 + uColA * rimGlow * 0.6;
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
    return { body, head, eyes, ear, leg, tailSeg, tailTip };
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
      color: col, emissive: em, emissiveIntensity: 1.0, flatShading: true,
      transparent: true, opacity: 0.42, depthWrite: false, roughness: 0.6,
    });
  });
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
  const hips = [[0.12, 0.25, 0.105], [0.12, 0.25, -0.105], [-0.2, 0.25, 0.105], [-0.2, 0.25, -0.105]];
  for (const h of hips) {
    const p = new THREE.Group();
    p.position.set(h[0], h[1], h[2]);
    rig.add(p);
    mk(G.leg, p, true);
    legs.push(p);
  }

  // tail chain
  const tailRoot = new THREE.Group();
  tailRoot.position.set(-0.32, 0.4, 0);
  rig.add(tailRoot);
  const tail = [];
  const N_TAIL = 6, SEG_LEN = 0.085;
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
    rig.position.y = bounce * 0.07 * runAmt;
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

    // tail: lagging swish
    tailRoot.rotation.z = 0.95 + 0.6 * runAmt;
    for (let i = 0; i < tail.length; i++) {
      const lag = i * 0.55;
      tail[i].rotation.x = Math.sin(phase * 0.5 - lag) * 0.28 * runAmt + Math.sin(time * 1.7 + seedOff - lag) * 0.2 * idle;
      tail[i].rotation.z = i === 0 ? 0 : (-0.26 * (1 - runAmt * 0.6) + Math.sin(phase - lag) * 0.08 * runAmt);
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

  update(0, {});
  return { group, update, setGhost };
}

// ---------------------------------------------------------------------------
// Wolf
// ---------------------------------------------------------------------------
const WOLF_TYPES = {
  patroller: { base: 0x8a909c, light: 0xd8dce4, dark: 0x464b57, accent: 0xffc23d },
  wanderer: { base: 0x8c5a38, light: 0xdcb48a, dark: 0x45291a, accent: 0xff8a2a },
  orbiter: { base: 0x3e5088, light: 0x9fb2e0, dark: 0x1d2548, accent: 0x52d6ff },
  sweeper: { base: 0xa83c33, light: 0xeaa58e, dark: 0x51201b, accent: 0xff3a3a },
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

  // ground ring (type color) for readability from above
  const ringMat = new THREE.MeshBasicMaterial({ color: glowColor(T.accent, 1.2), transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(cgeo('wolfRing', () => flatRing(0.62, 0.72, 28)), ringMat);
  ring.position.y = 0.025;
  ring.renderOrder = 1;
  group.add(ring);

  const seedOff = Math.random() * 100;
  let phase = Math.random() * 6, runAmt = 0, tellS = 0, clock = 0;

  function update(dt, s) {
    s = s || {};
    dt = Math.min(dt || 0, 0.1);
    clock += dt;
    const time = s.time !== undefined ? s.time : clock;
    const moving = !!s.moving;
    const sp = s.speed01 === undefined ? (moving ? 1 : 0) : Math.max(0, Math.min(1, s.speed01));
    runAmt = smoothTo(runAmt, moving ? Math.max(0.45, sp) : 0, 9, dt);
    tellS = smoothTo(tellS, Math.max(0, Math.min(1, s.tell || 0)), 14, dt);
    const tell = tellS;
    phase += dt * (7 + 7 * sp) * (runAmt > 0.01 ? 1 : 0);
    const sn = Math.sin(phase);
    const idle = (1 - Math.min(1, runAmt)) * (1 - tell);

    // trot + crouch (legs splay to lower the body)
    const amp = 0.7 * runAmt;
    const crouch = 0.6 * tell;
    legs[0].rotation.z = sn * amp + crouch;
    legs[3].rotation.z = sn * amp - crouch;
    legs[1].rotation.z = -sn * amp + crouch;
    legs[2].rotation.z = -sn * amp - crouch;
    const drop = 0.5 * (1 - Math.cos(crouch));
    let jitter = 0;
    if (tell > 0.55) jitter = Math.sin(time * 75 + seedOff) * 0.014 * (tell - 0.55) / 0.45;
    rig.position.set(jitter, -drop + Math.abs(Math.cos(phase)) * 0.045 * runAmt - 0.02 * runAmt + Math.sin(time * 2 + seedOff) * 0.006 * idle, 0);
    rig.rotation.z = Math.sin(phase * 2) * 0.025 * runAmt - 0.05 * runAmt - 0.06 * tell;

    head.position.y = 0.8 - 0.06 * tell + Math.sin(phase * 2 + 1) * 0.02 * runAmt;
    head.position.x = 0.5 + 0.04 * tell;
    head.rotation.z = -0.32 * tell - 0.08 * runAmt + Math.sin(time * 0.8 + seedOff) * 0.06 * idle;
    head.rotation.y = Math.sin(time * 0.5 + seedOff) * 0.35 * idle;
    jaw.rotation.z = -0.38 * tell + (tell > 0.6 ? Math.sin(time * 30) * 0.06 : 0) - 0.08 * runAmt * (0.5 + 0.5 * Math.sin(phase * 2));

    // tail: raises stiff during tell, sways when trotting
    tailRoot.rotation.z = 2.05 - 0.45 * tell - 0.15 * runAmt;
    for (let i = 0; i < tail.length; i++) {
      tail[i].rotation.x = Math.sin(phase - i * 0.7) * 0.25 * runAmt + Math.sin(time * 1.3 + seedOff - i * 0.6) * 0.15 * idle + Math.sin(time * 40 - i) * 0.04 * tell;
      if (i > 0) tail[i].rotation.z = -0.35 + 0.25 * tell;
    }

    // glowing eyes 1 -> 4
    const ei = 1 + 3 * tell;
    eyeMat.color.copy(accent).multiplyScalar(ei);
    const es = 1 + 0.25 * tell;
    eyes.scale.set(es, es, es);

    ringMat.opacity = 0.32 + 0.55 * tell;
    const rs = 1 + 0.12 * tell + 0.03 * Math.sin(time * 3 + seedOff);
    ring.scale.set(rs, 1, rs);
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
    cmat('itemDisc:' + type, () => new THREE.MeshBasicMaterial({ map: radialTexture(), color: glowColor(ITEM_GLOW[type], 1.1), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending })),
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
    const cw = new THREE.Color(0xffffff), cg = glowColor(0x7fe8ff, 3.2);
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
    const boot = new THREE.Mesh(G.boot, VC_MAT()); boot.castShadow = true; spin.add(boot);
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
    const heart = new THREE.Mesh(heartGeo(), heartMat); heart.castShadow = true; spin.add(heart);
    const halo = new THREE.Mesh(cgeo('haloTorus', () => new THREE.TorusGeometry(0.19, 0.022, 6, 28)), basicGlow('halo', 0xffd76a, 2.6, { blending: THREE.NormalBlending, transparent: false, depthWrite: true }));
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
    const starMat = cmat('starMat', () => new THREE.MeshStandardMaterial({ color: 0xffd34a, emissive: 0xffb020, emissiveIntensity: 1.3, flatShading: true, roughness: 0.4 }));
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

  const haloMat = new THREE.MeshBasicMaterial({ map: ringHaloTexture(), color: col.clone().multiplyScalar(1.3), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const halo = new THREE.Mesh(cgeo('reviveHalo', () => flatDisc(R / 0.75, 40)), haloMat);
  halo.position.y = 0.03; halo.renderOrder = 1; group.add(halo);

  const ringMat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(2.4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(cgeo('reviveRing', () => flatRing(R - 0.07, R + 0.05, 56)), ringMat);
  ring.position.y = 0.04; ring.renderOrder = 2; group.add(ring);

  const dashMat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.8), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const dash = new THREE.Mesh(cgeo('reviveDash', () => dashedRingGeometry(R * 0.72, R * 0.72 + 0.06, 14, 0.55, 3)), dashMat);
  dash.position.y = 0.045; dash.renderOrder = 2; group.add(dash);
  const dash2 = new THREE.Mesh(cgeo('reviveDash2', () => dashedRingGeometry(R * 0.5, R * 0.5 + 0.035, 8, 0.3, 2)), dashMat);
  dash2.position.y = 0.045; dash2.renderOrder = 2; group.add(dash2);

  const moteMat = new THREE.MeshBasicMaterial({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.5).multiplyScalar(3), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
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
  const baseRing = col.clone().multiplyScalar(2.4);
  function update(dt, time) {
    const t = time === undefined ? performance.now() / 1000 : time;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4 + off);
    ringMat.color.copy(baseRing).multiplyScalar(0.7 + 0.6 * pulse);
    const rs = 1 + 0.04 * pulse;
    ring.scale.set(rs, 1, rs);
    haloMat.opacity = 0.4 + 0.3 * pulse;
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
  const runeMat = new THREE.MeshBasicMaterial({ map: runeTexture(), color: runeCol.clone().multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const runeOuter = new THREE.Mesh(flatRing(R * 0.8, R * 1.0, 96), runeMat);
  runeOuter.position.y = 0.075; runeOuter.renderOrder = 2; group.add(runeOuter);
  const runeInnerMat = runeMat.clone(); runeInnerMat.color = new THREE.Color(0xffd27a).multiplyScalar(1.6);
  const runeInner = new THREE.Mesh(flatRing(1.75 * 0.8, 1.75, 64), runeInnerMat);
  runeInner.position.y = 0.08; runeInner.renderOrder = 2; group.add(runeInner);

  // light beams + crystal shards around the rim
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x5fdcff) }, uIntensity: { value: 1 }, uTime: { value: 0 } },
    vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const beamGeo = new THREE.CylinderGeometry(0.06, 0.16, 4.5, 8, 1, true); beamGeo.translate(0, 2.25, 0);
  const shardMat = new THREE.MeshStandardMaterial({ color: 0x9ff0ff, emissive: 0x3fd0ff, emissiveIntensity: 1.4, flatShading: true, roughness: 0.25 });
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
    const sh = new THREE.Mesh(shardGeo, shardMat); sh.position.set(x, 0.08, z); sh.rotation.y = a; sh.castShadow = true; group.add(sh);
  }

  // central column + floating crystal
  const colMat = beamMat.clone();
  colMat.uniforms = { uColor: { value: new THREE.Color(0xc8b4ff) }, uIntensity: { value: 1 }, uTime: { value: 0 } };
  const colGeo = new THREE.CylinderGeometry(0.35, 0.75, 2.8, 16, 1, true); colGeo.translate(0, 1.4, 0);
  const column = new THREE.Mesh(colGeo, colMat); column.position.y = 0.08; column.renderOrder = 3; group.add(column);

  const crystalPivot = new THREE.Group(); crystalPivot.position.y = 2.9; group.add(crystalPivot);
  const crystalMat = new THREE.MeshStandardMaterial({ color: 0xb8f6ff, emissive: 0x4fd8ff, emissiveIntensity: 1.5, flatShading: true, roughness: 0.2, metalness: 0.1 });
  const crystal = new THREE.Mesh(bake([
    [P.oct, mtx([0, 0, 0], null, [0.45, 0.9, 0.45]), 0xffffff],
  ]), crystalMat);
  crystal.castShadow = true;
  crystalPivot.add(crystal);
  const glowSprite = new THREE.Mesh(cgeo('portalGlowDisc', () => new THREE.PlaneGeometry(3.2, 3.2)), new THREE.MeshBasicMaterial({ map: radialTexture(), color: new THREE.Color(0x7fe0ff).multiplyScalar(0.9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  crystalPivot.add(glowSprite);
  const haloMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd36a).multiplyScalar(2.2) });
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
    const I = 0.85 + 0.15 * pulse + 1.3 * act;
    swirlMat.uniforms.uTime.value = swirlT;
    swirlMat.uniforms.uIntensity.value = I;
    runeOuter.rotation.y = swirlT * 0.12;
    runeInner.rotation.y = -swirlT * 0.25;
    runeMat.color.copy(runeCol).multiplyScalar(1.3 + 0.5 * pulse + 1.5 * act);
    beamMat.uniforms.uTime.value = t;
    beamMat.uniforms.uIntensity.value = 0.7 + 0.2 * pulse + 1.4 * act;
    colMat.uniforms.uTime.value = t;
    colMat.uniforms.uIntensity.value = 0.5 + 0.15 * pulse + 1.2 * act;
    for (let i = 0; i < beams.length; i++) {
      const s = 1 + 0.6 * act + 0.08 * Math.sin(t * 3 + i);
      beams[i].scale.set(1 + act, s, 1 + act);
    }
    crystalPivot.position.y = 2.9 + Math.sin(t * 1.6) * 0.15 + 0.3 * act;
    crystal.rotation.y = swirlT * 0.9;
    crystalMat.emissiveIntensity = 1.3 + 0.4 * pulse + 1.8 * act;
    glowSprite.quaternion.identity();
    glowSprite.rotation.x = -0.96; // face the angled camera
    glowSprite.scale.setScalar(1 + 0.15 * pulse + 0.6 * act);
    halo1.rotation.set(Math.PI / 2 + Math.sin(t * 0.8) * 0.35, swirlT * 0.5, 0);
    halo2.rotation.set(Math.PI / 2 + Math.cos(t * 0.6) * 0.45, -swirlT * 0.4, 0.3);
  }
  update(0, 0, {});
  return { group, update };
}

export { createKittyModel, createWolfModel, createItemModel, createReviveCircleModel, createPortalModel };
