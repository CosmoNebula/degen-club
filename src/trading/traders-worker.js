// Traders worker — owns the wallet classification sweep + stale wallet cleanup.
// Runs off main thread so wallet recomputation (potentially thousands of rows
// of synchronous SQLite work) doesn't block trade ingestion or HTTP.
//
// Responsibilities:
//  1. Periodic recompute of *active* wallets only (last activity within window).
//     The expensive boot-time "classify every wallet ever seen" pass is gone —
//     we let activity drive classification instead.
//  2. Hourly stale-wallet cleanup: delete unprotected wallets idle >24h to keep
//     the table lean. Protected = manually_tracked / kol / tracked / has migrator_score.

import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { recomputeAllWallets, cleanupStaleWallets, recomputeEveryWallet } from '../scoring/traders.js';
import { detectRings } from '../scoring/wallet-rings.js';

const STALE_INTERVAL_MS = 60 * 60 * 1000;       // 1 hour
const STALE_MAX_IDLE_MS = 24 * 60 * 60 * 1000;  // 24 hours
const RINGS_INTERVAL_MS = 60 * 60 * 1000;       // 1 hour

// ---------- Worker side ----------
if (!isMainThread) {
  db(); // open DB connection for this thread
  const sweepInterval = config.traders.recomputeIntervalMs;

  setInterval(() => {
    try {
      const n = recomputeAllWallets();
      if (n > 0) console.log(`[traders-worker] recomputed ${n} active wallets`);
    } catch (err) { console.error('[traders-worker] sweep', err.message); }
  }, sweepInterval);

  setInterval(() => {
    try {
      const removed = cleanupStaleWallets({ maxIdleMs: STALE_MAX_IDLE_MS });
      if (removed > 0) console.log(`[traders-worker] stale cleanup: removed ${removed} idle wallets`);
    } catch (err) { console.error('[traders-worker] cleanup', err.message); }
  }, STALE_INTERVAL_MS);

  // Run a stale cleanup shortly after boot so the lean state is achieved fast,
  // not after the first hourly tick.
  setTimeout(() => {
    try {
      const removed = cleanupStaleWallets({ maxIdleMs: STALE_MAX_IDLE_MS });
      console.log(`[traders-worker] startup cleanup: removed ${removed} idle wallets`);
    } catch (err) { console.error('[traders-worker] startup cleanup', err.message); }
  }, 30_000);

  // Phase 1 scoped-stat backfill: traders-worker normally only recomputes
  // recently-active wallets, so newly-added scoped columns (premig_*/postmig_*)
  // stay 0 for the historical wallet base. Run a single full-universe
  // recompute on startup if scoped stats haven't been populated yet. Detected
  // by querying for any wallet with non-zero premig_closed_30d; if none, run.
  // After this one-shot, the periodic recomputeAllWallets keeps things fresh
  // as wallets trade. Runs in this worker thread so it doesn't block main.
  setTimeout(() => {
    try {
      const hasScopedData = db().prepare(
        `SELECT 1 FROM wallets WHERE premig_closed_30d > 0 OR postmig_closed_30d > 0 LIMIT 1`
      ).get();
      if (hasScopedData) {
        console.log('[traders-worker] scoped backfill: skipped (already populated)');
        return;
      }
      console.log('[traders-worker] scoped backfill: starting (one-shot, this will take a few minutes)');
      const t0 = Date.now();
      const n = recomputeEveryWallet();
      console.log(`[traders-worker] scoped backfill: done · ${n} wallets · ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (err) { console.error('[traders-worker] scoped backfill', err.message); }
  }, 60_000);

  // 2026-05-15 (PM): wallet-ring detection DISABLED. detectRings is a
  // 90-244s wm-self-join (`SELECT wallet, COUNT(DISTINCT mint_address) total
  // FROM trades ... GROUP BY wallet HAVING total >= ?, JOIN wm a wm b ON
  // mint_address`) and stores ring_id on wallets. Audit: no strategy recipe
  // gates on ring_id anywhere in the live set, so this is pure analytics
  // CPU + WAL contention — was a documented cause of WSS/RPC disconnect
  // cascades. Re-enable if/when a recipe wires ring membership into a gate.
  console.log('[traders-worker] ring sweep DISABLED (no recipe consumes ring_id)');

  console.log(`[traders-worker] started · sweep every ${sweepInterval}ms · stale cleanup ${STALE_INTERVAL_MS / 60000}min · ring sweep DISABLED`);
}

// ---------- Main side ----------
let _worker = null;

export function startTradersWorker() {
  if (!isMainThread) return; // safety: never re-spawn from inside the worker
  if (_worker) return;
  spawn();
}

function spawn() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'traders-worker.js');
  try {
    _worker = new Worker(workerPath);
  } catch (err) {
    console.error('[traders-worker] spawn failed', err.message);
    return;
  }
  _worker.on('error', (err) => console.error('[traders-worker] error', err.stack || err.message));
  _worker.on('exit', (code) => {
    _worker = null;
    if (code !== 0) {
      console.error(`[traders-worker] exited code=${code} — restarting in 1s`);
      setTimeout(spawn, 1000);
    }
  });
}
