// Snapshot-sweeper worker — moves the periodic ml_mint_snapshots writer off
// the main thread.
//
// 2026-05-15 (PM): the sweeper INSERTs into ml_mint_snapshots every interval.
// Each batch holds the SQLite writer lock for hundreds of ms during a heavy
// burst (just-graduated coins, multi-snapshot-age windows hitting at once).
// On main thread that lock contended with trade INSERTs from webhook
// handler + paper-position UPDATEs — every burst made the WS heartbeat
// path slow, contributing to the WSS-disconnect storm. Moving here means
// the writes still serialize with main writes at the SQLite file level,
// but the JS-side work + setInterval lives in its own event loop.
//
// Pattern mirrors src/maintenance-worker.js and src/ingestion/
// onchain-price-worker.js.

import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------- Worker side ----------
if (!isMainThread) {
  const { db } = await import('../db/index.js');
  db();
  const { startSnapshotSweeper } = await import('./snapshot-sweeper.js');
  startSnapshotSweeper();
  console.log('[snapshot-sweeper-worker] worker thread up · ml_mint_snapshots writes off main');
}

// ---------- Main side ----------
let _worker = null;

export function startSnapshotSweeperWorker() {
  if (!isMainThread) return;
  if (_worker) return;
  spawn();
}

function spawn() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'snapshot-sweeper-worker.js');
  try {
    _worker = new Worker(workerPath);
  } catch (err) {
    console.error('[snapshot-sweeper-worker] spawn failed', err.message);
    return;
  }
  _worker.on('error', (err) => console.error('[snapshot-sweeper-worker] error', err.stack || err.message));
  _worker.on('exit', (code) => {
    _worker = null;
    if (code !== 0) {
      console.error(`[snapshot-sweeper-worker] exited code=${code} — restarting in 2s`);
      setTimeout(spawn, 2000);
    }
  });
  console.log('[snapshot-sweeper-worker] spawned · sweep runs in isolated thread');
}
