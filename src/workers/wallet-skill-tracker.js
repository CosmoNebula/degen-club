// workers/wallet-skill-tracker.js — Continuous behavioral scoring of every
// wallet we've seen trade on pump.fun. No curated lists, no external feeds.
//
// PHILOSOPHY (vs V1 tracked_buyers):
//   V1 had STATIC lists of "smart wallets" that decayed and produced noise.
//   V2 computes a CONTINUOUS skill score from observed PnL across all mints,
//   weighted by sample size so lucky one-shots don't pollute the signal.
//   Wallets with <5 completed round-trips get NULL (no signal yet — not bad).
//
// SCORE FORMULA:
//   For each (wallet, mint) pair where the wallet has both bought AND sold
//   (a completed round-trip), determine profitability: sol_out > sol_in.
//   For each wallet:
//     n        = # completed mints
//     wins     = # profitable completed mints
//     win_rate = wins / n
//     skill    = win_rate * sqrt(n)
//
//   sqrt(n) is the trust-by-sample-size scaler. A wallet with 5 wins out of
//   10 (skill ≈ 1.58) beats a wallet with 1 win out of 1 (skill = 1.0) even
//   though raw win rate is identical, because we have more evidence.
//
// FRESHNESS:
//   Only score mints whose last trade is > FRESHNESS_HOURS old. Open positions
//   on still-trading mints can't be evaluated yet — sol_out might be incomplete.
//
// IMPLEMENTATION NOTES:
//   - 25M+ trades, 500K+ wallets. Earlier JS-side aggregation OOMed the bot
//     loading per-wallet result rows into the V8 heap (5.6GB).
//   - This version does EVERYTHING in SQL via INSERT INTO ... SELECT. Zero
//     rows cross the JS boundary except for the final summary count.
//   - temp_store=FILE forces the temp table to disk instead of memory.

import { db } from '../db.js';

const COMPUTE_INTERVAL_MS = 4 * 60 * 60 * 1000;   // 4hr
const WINDOW_DAYS = 30;
const FRESHNESS_HOURS = 6;
const MIN_TRADES_FOR_SCORE = 5;
const FIRST_RUN_DELAY_MS = 60_000;

let _initialized = false;
function ensureTable() {
  if (_initialized) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS wallet_stats (
      wallet TEXT PRIMARY KEY,
      mints_completed INTEGER NOT NULL,
      mints_profitable INTEGER NOT NULL,
      win_rate REAL,
      skill_score REAL,
      total_sol_in REAL NOT NULL,
      total_sol_out REAL NOT NULL,
      total_pnl_sol REAL,
      avg_pnl_pct REAL,
      computed_at INTEGER NOT NULL,
      window_days INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_stats_skill ON wallet_stats(skill_score DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_stats_computed ON wallet_stats(computed_at);
  `);
  _initialized = true;
}

function recompute() {
  ensureTable();
  const t0 = Date.now();
  const now = Date.now();
  const sinceMs = now - WINDOW_DAYS * 86400 * 1000;
  const cutoffMs = now - FRESHNESS_HOURS * 3600 * 1000;

  console.log(`[wallet-skill] recompute starting · window=${WINDOW_DAYS}d · freshness_excl=${FRESHNESS_HOURS}h`);

  const d = db();

  // Use file-backed temp tables so the per-pair aggregate doesn't sit in
  // memory. The default is in-memory; for a multi-million-row temp table that
  // would balloon the process.
  d.exec(`PRAGMA temp_store = FILE`);

  // Drop any prior temp tables (in case a previous run died mid-way).
  d.exec(`DROP TABLE IF EXISTS _wallet_pair_pnl_tmp`);

  // Materialize per-(wallet, mint) round-trip aggregates for COMPLETED pairs.
  // Completed = both buy AND sell present AND last trade for this pair is
  // older than the freshness cutoff. Avoids inflating skill from positions
  // that haven't had time to resolve.
  d.exec(`
    CREATE TEMP TABLE _wallet_pair_pnl_tmp AS
    SELECT
      wallet,
      mint_address,
      SUM(CASE WHEN is_buy = 1 THEN sol_amount ELSE 0 END) AS sol_in,
      SUM(CASE WHEN is_buy = 0 THEN sol_amount ELSE 0 END) AS sol_out,
      MAX(timestamp)                                        AS last_ts
    FROM trades
    WHERE is_junk = 0
      AND timestamp > ${sinceMs}
    GROUP BY wallet, mint_address
    HAVING sol_in > 0 AND sol_out > 0 AND last_ts < ${cutoffMs}
  `);

  const pairsCount = d.prepare('SELECT COUNT(*) AS n FROM _wallet_pair_pnl_tmp').get().n;
  console.log(`[wallet-skill] ${pairsCount} completed (wallet,mint) pairs in window`);

  // Single INSERT OR REPLACE ... SELECT does the full per-wallet rollup AND
  // upsert in one statement. SQLite handles sqrt() natively since 3.38.
  // No rows crossing the JS boundary.
  const result = d.prepare(`
    INSERT OR REPLACE INTO wallet_stats (
      wallet, mints_completed, mints_profitable, win_rate, skill_score,
      total_sol_in, total_sol_out, total_pnl_sol, avg_pnl_pct,
      computed_at, window_days
    )
    SELECT
      wallet,
      COUNT(*)                                                  AS mints_completed,
      SUM(CASE WHEN sol_out > sol_in THEN 1 ELSE 0 END)         AS mints_profitable,
      (SUM(CASE WHEN sol_out > sol_in THEN 1.0 ELSE 0 END) /
       COUNT(*))                                                AS win_rate,
      (SUM(CASE WHEN sol_out > sol_in THEN 1.0 ELSE 0 END) /
       COUNT(*)) * sqrt(CAST(COUNT(*) AS REAL))                 AS skill_score,
      SUM(sol_in)                                               AS total_sol_in,
      SUM(sol_out)                                              AS total_sol_out,
      (SUM(sol_out) - SUM(sol_in))                              AS total_pnl_sol,
      AVG((sol_out - sol_in) / sol_in) * 100                    AS avg_pnl_pct,
      ${now}                                                    AS computed_at,
      ${WINDOW_DAYS}                                            AS window_days
    FROM _wallet_pair_pnl_tmp
    GROUP BY wallet
    HAVING COUNT(*) >= ${MIN_TRADES_FOR_SCORE}
  `).run();

  // Prune wallets that no longer qualify (their last update was a prior run).
  const pruned = d.prepare(`DELETE FROM wallet_stats WHERE computed_at < ?`).run(now);

  d.exec(`DROP TABLE IF EXISTS _wallet_pair_pnl_tmp`);

  const tookMs = Date.now() - t0;
  console.log(`[wallet-skill] done in ${tookMs}ms · ${result.changes} scored · ${pruned.changes} pruned · ${pairsCount} pairs evaluated`);
}

export function startWalletSkillTracker() {
  console.log(`[wallet-skill] worker armed · recompute every ${COMPUTE_INTERVAL_MS/3600000}h · window=${WINDOW_DAYS}d · min ${MIN_TRADES_FOR_SCORE} round-trips`);
  setTimeout(() => {
    try { recompute(); } catch (e) { console.error('[wallet-skill] err:', e.message); }
  }, FIRST_RUN_DELAY_MS);
  setInterval(() => {
    try { recompute(); } catch (e) { console.error('[wallet-skill] err:', e.message); }
  }, COMPUTE_INTERVAL_MS);
}
