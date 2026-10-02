import * as THREE from 'three';

// Aura wake: a kitty with 4+ finished runs sheds short-lived flame wisps in its own colour while it moves.
// Wisps float at body height (not on the ground), drift up a little, shrink and fade over LIFE seconds.
// Two point layers share one pooled geometry: a normal-blended colour shell (reads on bright snow/ice)
// and an additive hot core for the glow. No per-frame allocations.

const LIFE = 0.42;          // seconds a wisp lives (skate marks last 1.5 s)
const MAX = 56;             // pooled wisps per kitty
const STEP = 0.11;          // distance between emitted wisps
const SIZE = 0.62;          // world-space wisp diameter at birth
const RISE = 0.55;          // upward drift, units/s

const VERT = `
  attribute float aSize;
  attribute float aAlpha;
  uniform float uHalfH;
  uniform float uSizeMul;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uSizeMul * uHalfH * projectionMatrix[1][1] / max(0.1, -mv.z);
  }`;
const FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uSharp;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float a = pow(1.0 - d * d, uSharp) * vAlpha * uOpacity;
    gl_FragColor = vec4(uColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const bufSize = new THREE.Vector2();
const WHITE = new THREE.Color(0xffffff);

function createAuraTrail(scene, color) {
  const pos = new Float32Array(MAX * 3);
  const size = new Float32Array(MAX);
  const alpha = new Float32Array(MAX);
  const born = new Float32Array(MAX).fill(-1e9);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));

  const base = new THREE.Color(color);
  const hot = base.clone().lerp(WHITE, 0.3).multiplyScalar(1.2);
  const layer = (col, opacity, sizeMul, sharp, blending, order) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: col }, uOpacity: { value: opacity }, uSizeMul: { value: sizeMul }, uSharp: { value: sharp }, uHalfH: { value: 400 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = order; // above floor marks / ice (skate trail is 2)
    pts.onBeforeRender = (renderer) => { mat.uniforms.uHalfH.value = renderer.getDrawingBufferSize(bufSize).y * 0.5; };
    scene.add(pts);
    return pts;
  };
  const shell = layer(base, 0.75, 1, 1.4, THREE.NormalBlending, 3);
  const core = layer(hot, 0.85, 0.55, 2.2, THREE.AdditiveBlending, 3);
  shell.visible = core.visible = false;

  let time = 0, head = 0, live = 0, lx = 0, lz = 0, wasActive = false;

  function emit(x, y, z) {
    const i = head; head = (head + 1) % MAX;
    born[i] = time;
    pos[i * 3] = x + (Math.random() - 0.5) * 0.12;
    pos[i * 3 + 1] = y + (Math.random() - 0.5) * 0.14;
    pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.12;
  }

  // x, z: kitty position; y: ground height under it; heading: facing angle; active: emit this frame;
  // color (optional): recolour live (6+ finishes cycle through the cat colours)
  function update(dt, x, y, z, heading, active, color) {
    time += dt;
    if (!active && live === 0) return; // idle: nothing alive, nothing to emit (layers already hidden)
    if (color) { base.copy(color); hot.copy(color).lerp(WHITE, 0.3).multiplyScalar(1.2); }
    if (active) {
      // emit from just behind the body, at aura height, spaced by distance so speed/framerate don't leave gaps
      const bx = x - Math.cos(heading) * 0.22, bz = z - Math.sin(heading) * 0.22;
      if (!wasActive) { lx = bx; lz = bz; emit(bx, y + 0.62, bz); }
      const dist = Math.hypot(bx - lx, bz - lz);
      const n = Math.min(8, Math.floor(dist / STEP));
      for (let s = 1; s <= n; s++) {
        const f = (s * STEP) / dist;
        emit(lx + (bx - lx) * f, y + 0.62, lz + (bz - lz) * f);
      }
      if (n > 0) { lx = n === 8 ? bx : lx + (bx - lx) * (n * STEP) / dist; lz = n === 8 ? bz : lz + (bz - lz) * (n * STEP) / dist; }
    }
    wasActive = active;

    live = 0;
    for (let i = 0; i < MAX; i++) {
      const age = time - born[i];
      if (age >= LIFE) { size[i] = 0; alpha[i] = 0; continue; }
      live++;
      const u = age / LIFE;
      pos[i * 3 + 1] += RISE * dt;
      size[i] = SIZE * (1 - u * 0.75);
      alpha[i] = (1 - u) * (1 - u) * Math.min(1, age * 30 + 0.4);
    }
    shell.visible = core.visible = live > 0;
    if (live > 0) {
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
    }
  }

  function dispose() {
    scene.remove(shell, core);
    geo.dispose();
    shell.material.dispose();
    core.material.dispose();
  }

  return { update, dispose };
}

export { createAuraTrail };
