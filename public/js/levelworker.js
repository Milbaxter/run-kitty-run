// Module worker: generates levels off the main thread (see levelpregen.js). Same shared/maze.js as the sim,
// so the result is the very same deterministic layout; it comes back as a structured clone (plain data).
import { generateLevel } from './shared/maze.js';

self.onmessage = (e) => {
  const { id, level, seed, mode } = e.data || {};
  let ld = null, error = null;
  try { ld = generateLevel(level, seed, mode); } catch (err) { error = String(err && err.message || err); }
  self.postMessage({ id, ld, error });
};
