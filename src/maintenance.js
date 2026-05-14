import fs from 'node:fs';
import { db } from './db/index.js';
import { config } from './config.js';

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    countTrades: d.prepare('SELECT COUNT(*) AS n FROM trades'),
    deleteRuggedTrades: d.prepare(`
      DELETE FROM trades WHERE mint_address IN (
        SELECT mint_address FROM mints
        WHERE rugged = 1 AND rugged_at IS NOT NULL AND rugged_at < ?
      )
    `),
    deleteQuietTrades: d.prepare(`
      DELETE FROM trades WHERE mint_address IN (
        SELECT mint_address FROM mints
        WHERE migrated = 0 AND rugged = 0
          AND COALESCE(last_trade_at, created_at) < ?
      )
    `),
    deleteOldFlags: d.prepare('DELETE FROM rug_flags WHERE fired_at < ?'),
    // 2026-05-14: NOT IN against the wallets table planned as a re-eval per
    // row (~3.2s block at 4.45M-row scale). NOT EXISTS with PK lookup on
    // wallets.address is sub-100ms.
    deleteOrphanHoldings: d.prepare(`
      DELETE FROM wallet_holdings
      WHERE NOT EXISTS (
        SELECT 1 FROM wallets WHERE wallets.address = wallet_holdings.wallet
      )
    `),
    deleteStaleMints: d.prepare(`
      DELETE FROM mints
      WHERE migrated = 0
        AND COALESCE(last_trade_at, created_at) < ?
        AND mint_address NOT IN (SELECT mint_address FROM paper_positions WHERE status = 'open')
    `),
    deleteOldCopySignals: d.prepare('DELETE FROM copy_signals WHERE fired_at < ?'),
    deleteOldVolumeSignals: d.prepare('DELETE FROM volume_signals WHERE fired_at < ?'),
  };
  return stmts;
}

// Aux cleanup beyond pruneTrades. Runs alongside it on the maintenance schedule.
// Conservative cuts only — never touches migrated mints or their trades, since
// those feed migrator-hunter scoring permanently.
export function pruneAuxData() {
  const s = S();
  const now = Date.now();

  const orphanHoldings = s.deleteOrphanHoldings.run().changes;
  // Sweep expired SL re-entry watchlist rows (keep table small).
  try { db().prepare(`DELETE FROM sl_watchlist WHERE expires_at < ? OR consumed = 1`).run(now - 60 * 60 * 1000); } catch {}
  // ML-collection mode: extended retention so labels can resolve and we have
  // enough negative-class data for training. Mints kept 7 days (was 24h),
  // signals kept 7 days (was 6h).
  const staleMintCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const staleMints = s.deleteStaleMints.run(staleMintCutoff).changes;
  const oldSignalCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const oldCopySignals = s.deleteOldCopySignals.run(oldSignalCutoff).changes;
  const oldVolumeSignals = s.deleteOldVolumeSignals.run(oldSignalCutoff).changes;

  return { orphanHoldings, staleMints, oldCopySignals, oldVolumeSignals };
}

function fileSize(path) {
  try { return fs.statSync(path).size; } catch { return 0; }
}

export function pruneTrades() {
  const s = S();
  const d = db();
  const now = Date.now();
  const before = s.countTrades.get().n;

  const ruggedCutoff = now - config.maintenance.ruggedRetentionHours * 60 * 60 * 1000;
  const r1 = s.deleteRuggedTrades.run(ruggedCutoff);

  const quietCutoff = now - config.maintenance.quietRetentionMinutes * 60 * 1000;
  const r2 = s.deleteQuietTrades.run(quietCutoff);

  const oldFlagsCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const r3 = s.deleteOldFlags.run(oldFlagsCutoff);

  const after = s.countTrades.get().n;
  return {
    ruggedDeleted: r1.changes,
    quietDeleted: r2.changes,
    flagsDeleted: r3.changes,
    tradesBefore: before,
    tradesAfter: after,
  };
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
