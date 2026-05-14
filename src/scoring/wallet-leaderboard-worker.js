// Wallet-leaderboard worker — owns the periodic recompute of the top-50
// dynamic leaderboard (combined + premig + postmig).
//
// The recompute is a 13-16s CPU-bound query (the WITH candidates AS … +
// correlated subselects across ~3,400 wallets). Running it on the main
// thread dropped WSS connections every 15 minutes when the periodic tick
// fired. This worker thread has its own better-sqlite3 handle and absorbs
// the synchronous SQL cost without touching the main event loop.
//
// Pattern mirrors src/trading/traders-worker.js.

import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db } from '../db/index.js';
import { recomputeAllLeaderboards } from './wallet-leaderboard.js';

const RECOMPUTE_INTERVAL_MS = 15 * 60 * 1000; // 15min — matches old schedule
const FIRST_RUN_DELAY_MS = 60 * 1000;          // 1min — bot is up + settled

// ---------- Worker side ----------
if (!isMainThread) {
  db(); // open DB connection for this thread

  setTimeout(() => {
    try {
      recomputeAllLeaderboards({ verbose: true });
    } catch (err) {
      console.error('[leaderboard-worker] initial', err.message);
    }
  }, FIRST_RUN_DELAY_MS);

  setInterval(() => {
    try {
      recomputeAllLeaderboards({ verbose: true });
    } catch (err) {
      console.error('[leaderboard-worker] tick', err.message);
    }
  }, RECOMPUTE_INTERVAL_MS);

  console.log(`[leaderboard-worker] started · first=+${FIRST_RUN_DELAY_MS / 1000}s · then every ${RECOMPUTE_INTERVAL_MS / 60000}min`);
}

// ---------- Main side ----------
let _worker = null;

export function startWalletLeaderboardWorker() {
  if (!isMainThread) return;
  if (_worker) return;
  spawn();
}

function spawn() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'wallet-leaderboard-worker.js');
  try {
    _worker = new Worker(workerPath);
  } catch (err) {
    console.error('[leaderboard-worker] spawn failed', err.message);
    return;
  }
  _worker.on('error', (err) => console.error('[leaderboard-worker] error', err.stack || err.message));
  _worker.on('exit', (code) => {
    _worker = null;
    if (code !== 0) {
      console.error(`[leaderboard-worker] exited code=${code} — restarting in 2s`);
      setTimeout(spawn, 2000);
    }
  });
}
