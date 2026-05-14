// Maintenance worker — owns pruneTrades + pruneAuxData on a schedule.
//
// pruneAuxData includes a DELETE FROM wallet_holdings WHERE NOT EXISTS …
// query that scans millions of rows (7-8s). Firing on the main thread
// was dropping WSS every maintenance cycle. Worker thread has its own
// SQLite handle so this work stays off the main event loop.
//
// Pattern mirrors src/scoring/wallet-leaderboard-worker.js.

import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db/index.js';
import { pruneTrades, pruneAuxData } from './maintenance.js';

// ---------- Worker side ----------
if (!isMainThread) {
  db(); // open DB connection for this thread

  setTimeout(() => {
    try {
      const r = pruneTrades();
      console.log(`[maintenance-worker] startup prune: rugged=${r.ruggedDeleted} quiet=${r.quietDeleted} flags=${r.flagsDeleted} trades ${r.tradesBefore}→${r.tradesAfter}`);
      const a = pruneAuxData();
      console.log(`[maintenance-worker] startup aux: orphan_holdings=${a.orphanHoldings} stale_mints=${a.staleMints} copy_signals=${a.oldCopySignals} volume_signals=${a.oldVolumeSignals}`);
    } catch (err) {
      console.error('[maintenance-worker] startup', err.message);
    }
  }, config.maintenance.startupDelayMs);

  setInterval(() => {
    try {
      const r = pruneTrades();
      if (r.ruggedDeleted + r.quietDeleted + r.flagsDeleted > 0) {
        console.log(`[maintenance-worker] sweep: rugged=${r.ruggedDeleted} quiet=${r.quietDeleted} flags=${r.flagsDeleted} trades ${r.tradesBefore}→${r.tradesAfter}`);
      }
      const a = pruneAuxData();
      const auxTotal = a.orphanHoldings + a.staleMints + a.oldCopySignals + a.oldVolumeSignals;
      if (auxTotal > 0) {
        console.log(`[maintenance-worker] aux: orphan_holdings=${a.orphanHoldings} stale_mints=${a.staleMints} copy_signals=${a.oldCopySignals} volume_signals=${a.oldVolumeSignals}`);
      }
    } catch (err) {
      console.error('[maintenance-worker]', err.message);
    }
  }, config.maintenance.intervalMs);

  console.log(`[maintenance-worker] started · interval=${config.maintenance.intervalMs / 60000}min`);
}

// ---------- Main side ----------
let _worker = null;

export function startMaintenanceWorker() {
  if (!isMainThread) return;
  if (_worker) return;
  spawn();
}

function spawn() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'maintenance-worker.js');
  try {
    _worker = new Worker(workerPath);
  } catch (err) {
    console.error('[maintenance-worker] spawn failed', err.message);
    return;
  }
  _worker.on('error', (err) => console.error('[maintenance-worker] error', err.stack || err.message));
  _worker.on('exit', (code) => {
    _worker = null;
    if (code !== 0) {
      console.error(`[maintenance-worker] exited code=${code} — restarting in 2s`);
      setTimeout(spawn, 2000);
    }
  });
}
