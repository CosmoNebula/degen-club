import fs from 'node:fs';
import { db } from './db/index.js';
import { config } from './config.js';

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    countTrades: d.prepare('SELECT COUNT(*) AS n FROM trades'),
    // 2026-05-14: chunked DELETEs. Single big DELETE held the SQLite
    // writer lock for 5-8s, blocking unrelated INSERTs on the main
    // thread. We now SELECT rowids in batches and DELETE by rowid,
    // yielding briefly between batches so other writers can grab the
    // lock. Use these via the chunked* helpers in pruneAuxData/Trades.
    pickRuggedTradeRowids: d.prepare(`
      SELECT rowid FROM trades WHERE mint_address IN (
        SELECT mint_address FROM mints
        WHERE rugged = 1 AND rugged_at IS NOT NULL AND rugged_at < ?
      ) LIMIT ?
    `),
    pickQuietTradeRowids: d.prepare(`
      SELECT rowid FROM trades WHERE mint_address IN (
        SELECT mint_address FROM mints
        WHERE migrated = 0 AND rugged = 0
          AND COALESCE(last_trade_at, created_at) < ?
      ) LIMIT ?
    `),
    pickOrphanHoldingsRowids: d.prepare(`
      SELECT rowid FROM wallet_holdings
      WHERE NOT EXISTS (
        SELECT 1 FROM wallets WHERE wallets.address = wallet_holdings.wallet
      ) LIMIT ?
    `),
    pickStaleMintsRowids: d.prepare(`
      SELECT rowid FROM mints
      WHERE migrated = 0
        AND COALESCE(last_trade_at, created_at) < ?
        AND mint_address NOT IN (SELECT mint_address FROM paper_positions WHERE status = 'open')
      LIMIT ?
    `),
    deleteOldFlags: d.prepare('DELETE FROM rug_flags WHERE fired_at < ?'),
    deleteOldCopySignals: d.prepare('DELETE FROM copy_signals WHERE fired_at < ?'),
    deleteOldVolumeSignals: d.prepare('DELETE FROM volume_signals WHERE fired_at < ?'),
  };
  return stmts;
}

// Chunked-delete helper. Selects up to BATCH rowids matching the pick statement,
// then DELETEs them by rowid in one statement. Each batch holds the SQLite
// writer lock for ~50-100ms instead of 5-8s. Yields YIELD_MS between batches
// so other writers (main-thread INSERTs, other workers) can take the lock.
// Returns total rows deleted across all batches.
const CHUNK_BATCH = 2000;
const CHUNK_YIELD_MS = 50;
const CHUNK_MAX_BATCHES = 500; // safety cap — at 2k/batch = 1M rows per sweep call
async function chunkedDelete(table, pickStmt, ...pickArgs) {
  const d = db();
  let total = 0;
  for (let i = 0; i < CHUNK_MAX_BATCHES; i++) {
    const rows = pickStmt.all(...pickArgs, CHUNK_BATCH);
    if (rows.length === 0) break;
    const placeholders = rows.map(() => '?').join(',');
    const ids = rows.map(r => r.rowid);
    const r = d.prepare(`DELETE FROM ${table} WHERE rowid IN (${placeholders})`).run(...ids);
    total += r.changes;
    if (rows.length < CHUNK_BATCH) break; // less-than-full batch = drained
    await new Promise(resolve => setTimeout(resolve, CHUNK_YIELD_MS));
  }
  return total;
}

// Aux cleanup beyond pruneTrades. Runs alongside it on the maintenance schedule.
// Conservative cuts only — never touches migrated mints or their trades, since
// those feed migrator-hunter scoring permanently.
export async function pruneAuxData() {
  const s = S();
  const now = Date.now();

  const orphanHoldings = await chunkedDelete('wallet_holdings', s.pickOrphanHoldingsRowids);
  // Sweep expired SL re-entry watchlist rows (keep table small).
  try { db().prepare(`DELETE FROM sl_watchlist WHERE expires_at < ? OR consumed = 1`).run(now - 60 * 60 * 1000); } catch {}
  // ML-collection mode: extended retention so labels can resolve and we have
  // enough negative-class data for training. Mints kept 7 days (was 24h),
  // signals kept 7 days (was 6h).
  const staleMintCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const staleMints = await chunkedDelete('mints', s.pickStaleMintsRowids, staleMintCutoff);
  const oldSignalCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const oldCopySignals = s.deleteOldCopySignals.run(oldSignalCutoff).changes;
  const oldVolumeSignals = s.deleteOldVolumeSignals.run(oldSignalCutoff).changes;

  return { orphanHoldings, staleMints, oldCopySignals, oldVolumeSignals };
}

function fileSize(path) {
  try { return fs.statSync(path).size; } catch { return 0; }
}

export async function pruneTrades() {
  const s = S();
  const now = Date.now();
  const before = s.countTrades.get().n;

  const ruggedCutoff = now - config.maintenance.ruggedRetentionHours * 60 * 60 * 1000;
  const ruggedDeleted = await chunkedDelete('trades', s.pickRuggedTradeRowids, ruggedCutoff);

  const quietCutoff = now - config.maintenance.quietRetentionMinutes * 60 * 1000;
  const quietDeleted = await chunkedDelete('trades', s.pickQuietTradeRowids, quietCutoff);

  const oldFlagsCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const flagsDeleted = s.deleteOldFlags.run(oldFlagsCutoff).changes;

  const after = s.countTrades.get().n;
  return { ruggedDeleted, quietDeleted, flagsDeleted, tradesBefore: before, tradesAfter: after };
}

export function vacuumDb() {
  const d = db();
  const beforeMain = fileSize(config.dbPath);
  const beforeWal = fileSize(config.dbPath + '-wal');
  try { d.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  d.exec('VACUUM');
  const afterMain = fileSize(config.dbPath);
  const afterWal = fileSize(config.dbPath + '-wal');
  return {
    before: beforeMain + beforeWal,
    after: afterMain + afterWal,
    freed: Math.max(0, (beforeMain + beforeWal) - (afterMain + afterWal)),
  };
}

// COUNT(*) on multi-million-row tables full-scans (~4s on trades) and blocks
// the synchronous better-sqlite3 event loop. Cache for 60s — these are
// display-only counters that don't need live precision.
const _dbStatsCache = { v: null, t: 0 };
const DB_STATS_TTL_MS = 60 * 1000;

export function dbStats() {
  if (_dbStatsCache.v && (Date.now() - _dbStatsCache.t) < DB_STATS_TTL_MS) return _dbStatsCache.v;
  const d = db();
  const dbSize = fileSize(config.dbPath);
  const walSize = fileSize(config.dbPath + '-wal');
  const shmSize = fileSize(config.dbPath + '-shm');
  const counts = {
    mints: d.prepare('SELECT COUNT(*) AS n FROM mints').get().n,
    trades: d.prepare('SELECT COUNT(*) AS n FROM trades').get().n,
    wallets: d.prepare('SELECT COUNT(*) AS n FROM wallets').get().n,
    holdings: d.prepare('SELECT COUNT(*) AS n FROM wallet_holdings').get().n,
    creators: d.prepare('SELECT COUNT(*) AS n FROM creators').get().n,
    rugFlags: d.prepare('SELECT COUNT(*) AS n FROM rug_flags').get().n,
    bundleClusters: d.prepare('SELECT COUNT(*) AS n FROM bundle_clusters').get().n,
    copySignals: d.prepare('SELECT COUNT(*) AS n FROM copy_signals').get().n,
  };
  const out = {
    sizeBytes: dbSize,
    walBytes: walSize,
    shmBytes: shmSize,
    totalBytes: dbSize + walSize + shmSize,
    counts,
  };
  _dbStatsCache.v = out;
  _dbStatsCache.t = Date.now();
  return out;
}

export function startMaintenance() {
  // 2026-05-14: scheduler moved off main thread to maintenance-worker.js.
  // pruneTrades + pruneAuxData stay exported for the worker. No-op here
  // so index.js doesn't need a wiring change; worker is started separately.
  console.log('[maintenance] in-process scheduler disabled — sweep owned by maintenance-worker thread');
}
