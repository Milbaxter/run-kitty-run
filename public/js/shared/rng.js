
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

// Normalize angle to [0, TAU).
function normAngle(a) {
  a %= TAU;
  return a < 0 ? a + TAU : a;
}

// Smallest signed difference b - a in (-PI, PI].
function angleDiff(a, b) {
  let d = normAngle(b - a);
  return d > Math.PI ? d - TAU : d;
}

export { createRng, hashSeed, TAU, normAngle, angleDiff };
