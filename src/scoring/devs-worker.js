// Dev-sweep worker — owns the periodic creator classification recompute.
//
// recomputeAllCreatorsAsync iterates active creators (~1000-1500), runs
// a JOIN-heavy bundleOverlap query per creator (50-300ms each), with a
// per-iteration yield. Even with the yield, individual slow queries
// (~2-3s on hot creators) blocked the main thread enough to flap WSS.
// Worker thread has its own SQLite handle so this work doesn't touch
// the main event loop at all.
//
// Pattern mirrors src/scoring/wallet-leaderboard-worker.js.

import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db } from '../db/index.js';
import { recomputeAllCreatorsAsync } from './devs.js';

const SWEEP_INTERVAL_MS = 4 * 60 * 60 * 1000;  // 4h — matches old schedule
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;       // 3min — past boot storm

// ---------- Worker side ----------
if (!isMainThread) {
  db(); // open DB connection for this thread

  setTimeout(() => {
    recomputeAllCreatorsAsync()
      .then(n => console.log(`[devs-worker] initial classification: ${n} creators`))
      .catch(err => console.error('[devs-worker] initial', err.message));
  }, FIRST_RUN_DELAY_MS);

  setInterval(() => {
    recomputeAllCreatorsAsync()
      .then(n => { if (n > 0) console.log(`[devs-worker] sweep: ${n} creators`); })
      .catch(err => console.error('[devs-worker] sweep', err.message));
  }, SWEEP_INTERVAL_MS);

  console.log(`[devs-worker] started · first=+${FIRST_RUN_DELAY_MS / 60000}min · sweep every ${SWEEP_INTERVAL_MS / 3600000}h`);
}

// ---------- Main side ----------
let _worker = null;

export function startDevsWorker() {
  if (!isMainThread) return;
  if (_worker) return;
  spawn();
}

function spawn() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'devs-worker.js');
  try {
    _worker = new Worker(workerPath);
  } catch (err) {
    console.error('[devs-worker] spawn failed', err.message);
    return;
  }
  _worker.on('error', (err) => console.error('[devs-worker] error', err.stack || err.message));
  _worker.on('exit', (code) => {
    _worker = null;
    if (code !== 0) {
      console.error(`[devs-worker] exited code=${code} — restarting in 2s`);
      setTimeout(spawn, 2000);
    }
  });
}
