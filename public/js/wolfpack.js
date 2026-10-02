import * as THREE from 'three';

// Draws every wolf of a view with one InstancedMesh per wolf-part geometry (body, head, eyes, jaw, leg, tail x3;
// per wolf type, since each type bakes its own geometry). The wolf models from createWolfModel stay invisible
// proxy rigs that are never added to the scene: their update() animates the rig, add() copies each part's world
// matrix (and the eye glow color) into the instanced meshes. ~11 draws per wolf become ~8 per wolf type.
const _c = new THREE.Color();

function createWolfPack(scene, models) {
  const packs = new Map();          // geometry -> { mesh, n, eye }
  const cap = new Map();
  for (const m of models) m.group.traverse((o) => { if (o.isMesh) cap.set(o.geometry, (cap.get(o.geometry) || 0) + 1); });
  const parts = new Map();          // model -> [[proxyMesh, pack], ...]
  for (const m of models) {
    const list = [];
    m.group.traverse((o) => {
      if (!o.isMesh) return;
      let p = packs.get(o.geometry);
      if (!p) {
        // the eyes have a per-wolf MeshBasicMaterial (accent colour): white material * instance color instead
        const eye = o.material.isMeshBasicMaterial;
        const mesh = new THREE.InstancedMesh(o.geometry, eye ? new THREE.MeshBasicMaterial() : o.material, cap.get(o.geometry));
        mesh.castShadow = o.castShadow;
        mesh.frustumCulled = false;   // wolves are already distance-culled in syncVisuals
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (eye) {
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap.get(o.geometry) * 3), 3);
          mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        }
        mesh.count = 0;
        mesh.name = 'wolfPack';
        scene.add(mesh);
        p = { mesh, n: 0, eye };
        packs.set(o.geometry, p);
      }
      list.push([o, p]);
    });
    parts.set(m, list);
  }

  function begin() { for (const p of packs.values()) p.n = 0; }
  function add(m) {
    m.group.updateMatrixWorld(true);  // proxy has no parent: matrixWorld = its pose in the world
    for (const [o, p] of parts.get(m)) {
      p.mesh.setMatrixAt(p.n, o.matrixWorld);
      if (p.eye) p.mesh.setColorAt(p.n, _c.copy(o.material.color));
      p.n++;
    }
  }
  function end() {
    for (const p of packs.values()) {
      p.mesh.count = p.n;
      p.mesh.visible = p.n > 0;   // skip empty packs (incl. shadow passes)
      if (!p.n) continue;
      const im = p.mesh.instanceMatrix;
      im.clearUpdateRanges(); im.addUpdateRange(0, p.n * 16); im.needsUpdate = true;
      const ic = p.mesh.instanceColor;
      if (ic) { ic.clearUpdateRanges(); ic.addUpdateRange(0, p.n * 3); ic.needsUpdate = true; }
    }
  }
  // frees the instance buffers and the eye materials; the part geometries and the shared wolf material are cached
  function dispose() {
    for (const p of packs.values()) { p.mesh.removeFromParent(); p.mesh.dispose(); if (p.eye) p.mesh.material.dispose(); }
    packs.clear();
    parts.clear();
  }
  return { begin, add, end, dispose };
}

export { createWolfPack };
