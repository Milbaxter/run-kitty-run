// Pre-generates the next level in a module worker while the current one is played, so the level change doesn't
// stall the main thread (Skate levels take 100ms+ to generate). The result goes into sim.pregen, which makeLevel
// (shared/sim.js) takes when it matches; without module-worker support it's a no-op (synchronous fallback).
import { pregenParams } from './shared/sim.js';

let worker = null;
let nextId = 0;
const pending = new Map(); // job id -> { sim, job }

function stop() {
  if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
  worker = null;
  pending.clear();
}

// Started right away (not on first use) so the worker loads the same shared/*.js build as the page.
try {
  worker = new Worker(new URL('./levelworker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ld } = e.data || {};
    const p = pending.get(id);
    pending.delete(id);
    if (!p || !ld) return;
    if (p.sim.level < p.job.level) p.sim.pregen = { ...p.job, ld };
  };
  worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); stop(); }; // e.g. no module workers
} catch { stop(); }

// Call at level start: queues level + 1 of this sim (none after the final run).
export function pregenNext(sim) {
  if (!worker || !sim || !sim.levelData || sim.levelData.finale) return;
  const job = pregenParams(sim);
  const id = ++nextId;
  pending.set(id, { sim, job });
  worker.postMessage({ id, ...job });
}
