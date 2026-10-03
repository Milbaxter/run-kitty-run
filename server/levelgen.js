// Off-event-loop level generation for the server: a small worker_threads pool pre-generates each playing room's
// next level at level start and drops it into sim.pregen, which makeLevel (shared/sim.js) takes when it matches.
// If it isn't ready yet (or a worker died) makeLevel just generates synchronously, so this is purely an optimization.
// LEVELGEN_WORKERS=0 turns it off.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { pregenParams } from '../public/js/shared/sim.js';

if (!isMainThread && parentPort) {
  // ---- worker side ----
  const { generateLevel } = await import('../public/js/shared/maze.js');
  parentPort.on('message', ({ id, level, seed, mode, rf }) => {
    let ld = null, error = null;
    try { ld = generateLevel(level, seed, mode, rf); } catch (err) { error = String(err && err.message || err); }
    parentPort.postMessage({ id, ld, error });
  });
}

const SIZE = Math.max(0, Math.min(2, Number(process.env.LEVELGEN_WORKERS ?? 2) | 0));
const RESPAWN_MS = 1000;
const slots = [];          // { worker, busy: job | null, ready }
const queue = [];          // jobs waiting for a free worker
let nextId = 0;

function spawn(slot) {
  const w = new Worker(new URL(import.meta.url));
  slot.worker = w;
  slot.busy = null;
  w.unref();
  w.on('message', ({ id, ld, error }) => {
    const job = slot.busy;
    slot.busy = null;
    if (job && job.id === id) {
      if (ld && job.sim.level < job.level) job.sim.pregen = { level: job.level, seed: job.seed, mode: job.mode, rf: job.rf, ld };
      else if (error) console.error(`levelgen: level ${job.level} (${job.mode}) failed in worker: ${error}`);
    }
    pump();
  });
  w.on('error', (err) => console.error('levelgen: worker error', err && err.message || err));
  w.on('exit', (code) => {
    if (slot.worker !== w) return;
    slot.worker = null;
    slot.busy = null;        // that job is dropped: makeLevel falls back to generating synchronously
    if (code !== 0) console.error(`levelgen: worker exited (${code}), respawning`);
    setTimeout(() => { spawn(slot); pump(); }, RESPAWN_MS).unref();
  });
}

function pump() {
  for (const slot of slots) {
    if (!queue.length) return;
    if (!slot.worker || slot.busy) continue;
    const job = queue.shift();
    if (job.sim.level >= job.level) { pump(); return; } // stale (already generated synchronously)
    slot.busy = job;
    slot.worker.postMessage({ id: job.id, level: job.level, seed: job.seed, mode: job.mode, rf: job.rf });
  }
}

// Call at level start: queues level + 1 of this sim (none after the final run).
export function pregenNext(sim) {
  if (!SIZE || !sim || !sim.levelData || sim.levelData.finale) return;
  if (!slots.length) for (let i = 0; i < SIZE; i++) { const s = {}; slots.push(s); spawn(s); }
  const job = { id: ++nextId, sim, ...pregenParams(sim) };
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].sim === sim) queue.splice(i, 1); // newest wins
  queue.push(job);
  pump();
}

// For tests / shutdown.
export function stopLevelgen() {
  queue.length = 0;
  for (const s of slots) { const w = s.worker; s.worker = null; if (w) w.terminate(); }
  slots.length = 0;
}
