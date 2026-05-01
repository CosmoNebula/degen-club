// Position monitor worker — runs the periodic checkPosition sweep AND handles
// per-trade checkMint requests from the main thread, off the main event loop.
//
// Why a worker:
//  - Main thread handles WebSocket trade ingestion + signal evaluation.
//  - The 250ms monitor sweep does many synchronous SQLite reads/writes that
//    block the event loop and delay live trade detection.
//  - Worker has its own better-sqlite3 connection sharing the same WAL file,
//    so writes serialize cleanly at the DB layer.
//
// Coordination is DB-mediated:
//  - Main thread writes pending_fill=1 when opening; worker's checkPosition
//    skips pending positions until the open completes.
//  - In-memory pendingSell sets are per-thread; only the worker runs sells now
//    so no cross-thread coordination needed.

import { parentPort } from 'node:worker_threads';
import { monitorPositions, checkPositionsForMint } from './paper.js';
import { config } from '../config.js';
import { db } from '../db/index.js';

db(); // open DB connection on this thread

const intervalMs = config.strategies.monitorIntervalMs || 250;

setInterval(() => {
  try { monitorPositions(); } catch (err) { console.error('[monitor-worker] sweep', err.message); }
}, intervalMs);

parentPort.on('message', (msg) => {
  if (msg?.type === 'checkMint' && msg.mint) {
    try { checkPositionsForMint(msg.mint); } catch (err) { console.error('[monitor-worker] checkMint', err.message); }
  }
});

console.log(`[monitor-worker] started · sweep every ${intervalMs}ms · checkMint on demand`);
