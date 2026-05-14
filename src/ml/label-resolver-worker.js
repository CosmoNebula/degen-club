// Label-resolver worker — owns the periodic ml_mint_snapshots label backfill.
//
// resolve() walks recently-aged snapshots and writes label columns (migrated,
// peaked_30, peaked_100, hits_5x_within_24h, etc.) once their measurement
// windows have closed. The UPDATE batches can hit ~3s on a busy run.
// Worker thread keeps the main loop clear of this periodic work.
//
// Pattern mirrors src/scoring/wallet-leaderboard-worker.js.

import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db } from '../db/index.js';
import { resolve } from './label-resolver.js';

const RESOLVE_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

// ---------- Worker side ----------
if (!isMainThread) {
  db(); // open DB connection for this thread

  setTimeout(() => {
    try { resolve(); } catch (err) { console.error('[label-worker] initial err:', err.message); }
  }, FIRST_RUN_DELAY_MS);

  setInterval(() => {
    try { resolve(); } catch (err) { console.error('[label-worker] resolve err:', err.message); }
  }, RESOLVE_INTERVAL_MS);

  console.log(`[label-worker] started · first=+${FIRST_RUN_DELAY_MS / 1000}s · resolve every ${RESOLVE_INTERVAL_MS / 60000}min`);
}

// ---------- Main side ----------
let _worker = null;

export function startLabelResolverWorker() {
  if (!isMainThread) return;
  if (_worker) return;
  spawn();
}

function spawn() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'label-resolver-worker.js');
  try {
    _worker = new Worker(workerPath);
  } catch (err) {
    console.error('[label-worker] spawn failed', err.message);
    return;
  }
  _worker.on('error', (err) => console.error('[label-worker] error', err.stack || err.message));
  _worker.on('exit', (code) => {
    _worker = null;
    if (code !== 0) {
      console.error(`[label-worker] exited code=${code} — restarting in 2s`);
      setTimeout(spawn, 2000);
    }
  });
}
