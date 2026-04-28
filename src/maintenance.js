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
  };
  return stmts;
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

export function dbStats() {
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
  return {
    sizeBytes: dbSize,
    walBytes: walSize,
    shmBytes: shmSize,
    totalBytes: dbSize + walSize + shmSize,
    counts,
  };
}

export function startMaintenance() {
  setTimeout(() => {
    try {
      const r = pruneTrades();
      console.log(`[maintenance] startup prune: rugged=${r.ruggedDeleted} quiet=${r.quietDeleted} flags=${r.flagsDeleted} trades ${r.tradesBefore}→${r.tradesAfter}`);
    } catch (err) {
      console.error('[maintenance] startup', err.message);
    }
  }, config.maintenance.startupDelayMs);

  setInterval(() => {
    try {
      const r = pruneTrades();
      if (r.ruggedDeleted + r.quietDeleted + r.flagsDeleted > 0) {
        console.log(`[maintenance] sweep: rugged=${r.ruggedDeleted} quiet=${r.quietDeleted} flags=${r.flagsDeleted} trades ${r.tradesBefore}→${r.tradesAfter}`);
      }
    } catch (err) {
      console.error('[maintenance]', err.message);
    }
  }, config.maintenance.intervalMs);
}
