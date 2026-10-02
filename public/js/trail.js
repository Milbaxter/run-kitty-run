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

  // samples in a ring buffer (oldest at `tail`); no per-frame allocations
  const sx = new Float32Array(MAX), sz = new Float32Array(MAX), spx = new Float32Array(MAX), spz = new Float32Array(MAX);
  const st = new Float64Array(MAX), sbrk = new Uint8Array(MAX), sstrips = new Array(MAX).fill(null);
  let tail = 0, n = 0;
  let time = 0, wasActive = false;

  // one quad per strip between points a and b, coloured by the newer end (b)
  function segment(q, ax, az, apx, apz, fa, bx, bz, bpx, bpz, fb, strips) {
    for (let k = 0; k < strips.length; k++) {
      const sp = strips[k], off = sp[0], h = sp[1] / 2, r = sp[2], g = sp[3], bl = sp[4], al = sp[5];
      const v = q * 4, ca = al * fa * fa, cb = al * fb * fb;
      let p3 = v * 3, p4 = v * 4;
      // vertex 0/1: a at -h/+h, vertex 2/3: b at -h/+h
      pos[p3] = ax + apx * (off - h); pos[p3 + 1] = Y; pos[p3 + 2] = az + apz * (off - h);
      pos[p3 + 3] = ax + apx * (off + h); pos[p3 + 4] = Y; pos[p3 + 5] = az + apz * (off + h);
      pos[p3 + 6] = bx + bpx * (off - h); pos[p3 + 7] = Y; pos[p3 + 8] = bz + bpz * (off - h);
      pos[p3 + 9] = bx + bpx * (off + h); pos[p3 + 10] = Y; pos[p3 + 11] = bz + bpz * (off + h);
      for (let j = 0; j < 4; j++, p4 += 4) { col[p4] = r; col[p4 + 1] = g; col[p4 + 2] = bl; col[p4 + 3] = j < 2 ? ca : cb; }
      q++;
    }
    return q;
  }

  // tint (optional colour): draw new marks in it (switches live; older marks keep theirs)
  function update(dt, x, z, heading, active, tint) {
    time += dt;
    while (n && time - st[tail] > LIFE) { tail = (tail + 1) % MAX; n--; }
    if (!active && n === 0) {
      // idle: nothing to draw, skip the rebuild and the upload
      if (mesh.visible) { mesh.visible = false; geo.setDrawRange(0, 0); }
      wasActive = false;
      return;
    }
    mesh.visible = true;
    if (tint && tint.getHex() !== tintHex) { tintHex = tint.getHex(); tinted = tintStrips(tint); }
    const px = -Math.sin(heading), pz = Math.cos(heading), strips = tint ? tinted : STRIPS;
    if (active) {
      const li = (tail + n - 1) % MAX;
      if (!wasActive || !n || Math.hypot(x - sx[li], z - sz[li]) >= STEP) {
        if (n === MAX) { tail = (tail + 1) % MAX; n--; }
        const i = (tail + n) % MAX;
        sx[i] = x; sz[i] = z; spx[i] = px; spz[i] = pz; st[i] = time; sbrk[i] = wasActive ? 0 : 1; sstrips[i] = strips;
        n++;
      }
    }
    wasActive = active;

    // segments between consecutive samples (+ a live one to the kitty itself)
    let q = 0;
    for (let k = 1; k < n; k++) {
      const a = (tail + k - 1) % MAX, b = (tail + k) % MAX;
      if (sbrk[b]) continue;
      q = segment(q, sx[a], sz[a], spx[a], spz[a], Math.max(0, 1 - (time - st[a]) / LIFE),
        sx[b], sz[b], spx[b], spz[b], Math.max(0, 1 - (time - st[b]) / LIFE), sstrips[b]);
    }
    if (active && n) {
      const a = (tail + n - 1) % MAX;
      q = segment(q, sx[a], sz[a], spx[a], spz[a], Math.max(0, 1 - (time - st[a]) / LIFE), x, z, px, pz, 1, strips);
    }
    geo.setDrawRange(0, q * 6);
    const pa = geo.attributes.position, ca = geo.attributes.color;
    pa.clearUpdateRanges(); ca.clearUpdateRanges();
    if (q) {
      pa.addUpdateRange(0, q * 12); ca.addUpdateRange(0, q * 16);
      pa.needsUpdate = true; ca.needsUpdate = true;
    }
  }

  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { update, dispose };
}

export { createIceTrail };
