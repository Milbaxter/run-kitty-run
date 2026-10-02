import * as THREE from 'three';

// Skate marks on the ice: two blade grooves plus a soft frost streak behind a gliding kitty.
// Samples are dropped every ~0.15 units and fade out over LIFE seconds.

const LIFE = 1.5;
const MAX = 140;            // samples kept
const STEP = 0.15;          // distance between samples
const Y = 0.02;             // above the ice sheet, below the kitty's ground ring
// [lateral offset, width, r, g, b, alpha]
const STRIPS = [
  [0, 0.42, 0.95, 0.98, 1, 0.32],
  [-0.09, 0.045, 0.42, 0.62, 0.82, 0.75],
  [0.09, 0.045, 0.42, 0.62, 0.82, 0.75],
];

// 2+ finishes: the same marks in the kitty's colour (streak more opaque, grooves deeper) so they read on pale ice
function tintStrips(c) {
  const r = c.r * 0.55, g = c.g * 0.55, b = c.b * 0.55;
  return [[0, 0.42, c.r, c.g, c.b, 0.5], [-0.09, 0.045, r, g, b, 0.9], [0.09, 0.045, r, g, b, 0.9]];
}

function createIceTrail(scene) {
  let tinted = null, tintHex = -1; // strips for the last tint colour (a new set only when the colour changes)
  const quads = (MAX + 1) * STRIPS.length;
  const pos = new Float32Array(quads * 4 * 3);
  const col = new Float32Array(quads * 4 * 4);
  const idx = new Uint32Array(quads * 6);
  for (let q = 0; q < quads; q++) {
    const b = q * 4;
    idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], q * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setDrawRange(0, 0);
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);

  const samples = [];        // { x, z, px, pz (unit perpendicular), t, brk, strips }
  let time = 0, wasActive = false;

  // tint (optional colour): draw new marks in it (switches live; older marks keep theirs)
  function update(dt, x, z, heading, active, tint) {
    time += dt;
    while (samples.length && time - samples[0].t > LIFE) samples.shift();
    if (tint && tint.getHex() !== tintHex) { tintHex = tint.getHex(); tinted = tintStrips(tint); }
    const px = -Math.sin(heading), pz = Math.cos(heading), strips = tint ? tinted : STRIPS;
    if (active) {
      const last = samples[samples.length - 1];
      if (!wasActive || !last || Math.hypot(x - last.x, z - last.z) >= STEP) {
        samples.push({ x, z, px, pz, t: time, brk: !wasActive, strips });
        if (samples.length > MAX) samples.shift();
      }
    }
    wasActive = active;

    // segments between consecutive samples (+ a live one to the kitty itself), coloured by the newer end
    const pts = active ? samples.concat([{ x, z, px, pz, t: time, brk: false, strips }]) : samples;
    let q = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (b.brk) continue;
      const fa = Math.max(0, 1 - (time - a.t) / LIFE), fb = Math.max(0, 1 - (time - b.t) / LIFE);
      for (const [off, w, r, g, bl, al] of b.strips) {
        const v = q * 4;
        const h = w / 2;
        const put = (k, s, side, f) => {
          const o = off + side * h;
          pos[(v + k) * 3] = s.x + s.px * o; pos[(v + k) * 3 + 1] = Y; pos[(v + k) * 3 + 2] = s.z + s.pz * o;
          col[(v + k) * 4] = r; col[(v + k) * 4 + 1] = g; col[(v + k) * 4 + 2] = bl; col[(v + k) * 4 + 3] = al * f * f;
        };
        put(0, a, -1, fa); put(1, a, 1, fa); put(2, b, -1, fb); put(3, b, 1, fb);
        q++;
      }
    }
    geo.setDrawRange(0, q * 6);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { update, dispose };
}

export { createIceTrail };
