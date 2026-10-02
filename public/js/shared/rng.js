
// Seeded deterministic RNG (mulberry32). Pure, no three.js.

function createRng(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,                                              // [0,1)
    getState: () => s,                                 // for network resync
    setState: (v) => { s = v >>> 0; },
    range: (a, b) => a + (b - a) * next(),             // [a,b)
    int: (a, b) => a + Math.floor(next() * (b - a + 1)), // inclusive ints
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const str = String(p);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x9e3779b9; h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const TAU = Math.PI * 2;

// x ** n for a small non-negative integer n as plain multiplies: Math.pow / ** differ in the last bit between
// V8 and JavaScriptCore (iOS), which would make the same seed generate a different level on the two.
function ipow(x, n) {
  let r = 1;
  for (let i = 0; i < n; i++) r *= x;
  return r;
}

// Leg frame (ox/oz origin, u along, n lateral) -> world point; r = lateral offset, th = distance along the leg.
function legPoint(f, r, th) {
  return { x: f.ox + f.ux * th + f.nx * r, z: f.oz + f.uz * th + f.nz * r };
}

export { createRng, hashSeed, TAU, ipow, legPoint };
