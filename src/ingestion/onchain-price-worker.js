// Onchain-price WSS worker — runs the held-position bonding-curve subscriber
// inside its own worker thread.
//
// 2026-05-15 (PM): the WSS heartbeat was getting kicked off by main-thread
// sync-SQL wedges (slow query → no ping/pong processing → Helius timeout →
// reconnect). 249 disconnect events over the day. Moving the WS loop to a
// worker insulates the connection from main-thread stalls: even if main is
// blocked for 5s by a heavy SELECT, this worker keeps pinging/ponging and
// the Helius WSS stays alive.
//
// The worker uses its own SQLite handle (writes to mints.last_price_sol still
// serialize at the file-level writer lock, but the connection itself doesn't
// drop — that's the win). Pattern mirrors src/maintenance-worker.js.

import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------- Worker side ----------
if (!isMainThread) {
  // Load db (opens this thread's connection + runs idempotent migrations)
  // then start the price-feed loop. The feed manages its own setInterval +
  // WS lifecycle.
  const { db } = await import('../db/index.js');
  db();
  const { startOnchainPriceFeed } = await import('./onchain-price.js');
  startOnchainPriceFeed();
  console.log('[onchain-price-worker] worker thread up · WSS loop running here, isolated from main event loop');
}

// ---------- Main side ----------
let _worker = null;

export function startOnchainPriceWorker() {
  if (!isMainThread) return;
  if (_worker) return;
  spawn();
}

function spawn() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'onchain-price-worker.js');
  try {
    _worker = new Worker(workerPath);
  } catch (err) {
    console.error('[onchain-price-worker] spawn failed', err.message);
    return;
  }
  _worker.on('error', (err) => console.error('[onchain-price-worker] error', err.stack || err.message));
  _worker.on('exit', (code) => {
    _worker = null;
    if (code !== 0) {
      console.error(`[onchain-price-worker] exited code=${code} — restarting in 2s`);
      setTimeout(spawn, 2000);
    }
  });
  console.log('[onchain-price-worker] spawned · Helius BC-decode runs in isolated thread');
}
