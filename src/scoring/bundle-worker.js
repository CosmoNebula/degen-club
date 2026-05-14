// Bundle-clustering worker — owns the periodic detectBundles sweep.
//
// detectBundles scans recent trades (6h window post-2026-05-14) doing a
// GROUP_CONCAT(DISTINCT wallet) GROUP BY mint_address — 2-6s of solid
// SQL work depending on volume. Firing every 15min on the main thread
// dropped WSS each cycle. Worker thread has its own SQLite handle so
// this work stays off the main event loop.
//
// Pattern mirrors src/scoring/wallet-leaderboard-worker.js.

import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { detectBundles } from './bundle.js';

const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;  // 2min — past boot storm

// ---------- Worker side ----------
if (!isMainThread) {
  db(); // open DB connection for this thread

  setTimeout(() => {
    try {
      const r = detectBundles();
      console.log(`[bundle-worker] initial sweep: ${r.clusters} clusters from ${r.mintsScanned} mints`);
    } catch (err) {
      console.error('[bundle-worker] initial', err.message);
    }
  }, FIRST_RUN_DELAY_MS);

  setInterval(() => {
    try {
      const r = detectBundles();
      if (r.clusters > 0) console.log(`[bundle-worker] sweep: ${r.clusters} clusters from ${r.mintsScanned} mints`);
    } catch (err) {
      console.error('[bundle-worker] sweep', err.message);
    }
  }, config.bundle.intervalMs);

  console.log(`[bundle-worker] started · first=+${FIRST_RUN_DELAY_MS / 60000}min · sweep every ${config.bundle.intervalMs / 60000}min`);
}

// ---------- Main side ----------
let _worker = null;

export function startBundleWorker() {
  if (!isMainThread) return;
  if (_worker) return;
  spawn();
}

function spawn() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'bundle-worker.js');
  try {
    _worker = new Worker(workerPath);
  } catch (err) {
    console.error('[bundle-worker] spawn failed', err.message);
    return;
  }
  _worker.on('error', (err) => console.error('[bundle-worker] error', err.stack || err.message));
  _worker.on('exit', (code) => {
    _worker = null;
    if (code !== 0) {
      console.error(`[bundle-worker] exited code=${code} — restarting in 2s`);
      setTimeout(spawn, 2000);
    }
  });
}
