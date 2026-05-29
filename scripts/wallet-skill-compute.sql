-- wallet-skill-compute.sql — Standalone SQLite job that computes per-wallet
-- behavioral skill scores from the trades firehose. Run via sqlite3 CLI, not
-- inside the bot process (the GROUP BY working set is large enough to OOM).
--
-- Idempotent: rebuilds wallet_stats from scratch each run. Schema is in
-- workers/wallet-skill-tracker.js (still imported for the table definition,
-- just not the worker startup).

PRAGMA temp_store = FILE;
PRAGMA cache_size = -262144;  -- 256 MB cache (negative = KiB)

-- Make sure the table exists (idempotent — does nothing if already present)
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

-- Window: trades in last 30 days. Freshness: only count (wallet,mint) pairs
-- whose last trade is > 6h ago (still-trading positions can't be evaluated).
-- Constants substituted at script-run time via .parameter set in the runner.

DROP TABLE IF EXISTS pair_pnl_tmp;

CREATE TEMP TABLE pair_pnl_tmp AS
SELECT
  wallet,
  mint_address,
  SUM(CASE WHEN is_buy = 1 THEN sol_amount ELSE 0 END) AS sol_in,
  SUM(CASE WHEN is_buy = 0 THEN sol_amount ELSE 0 END) AS sol_out,
  MAX(timestamp)                                        AS last_ts
FROM trades
WHERE is_junk = 0
  AND timestamp > (strftime('%s','now')-30*86400)*1000
GROUP BY wallet, mint_address
HAVING sol_in > 0
   AND sol_out > 0
   AND last_ts < (strftime('%s','now')-6*3600)*1000;

SELECT 'pair_count', COUNT(*) FROM pair_pnl_tmp;

-- Now atomically rebuild wallet_stats from the pair table.
DELETE FROM wallet_stats;

INSERT INTO wallet_stats (
  wallet, mints_completed, mints_profitable, win_rate, skill_score,
  total_sol_in, total_sol_out, total_pnl_sol, avg_pnl_pct,
  computed_at, window_days
)
SELECT
  wallet,
  COUNT(*)                                                            AS mints_completed,
  SUM(CASE WHEN sol_out > sol_in THEN 1 ELSE 0 END)                   AS mints_profitable,
  CAST(SUM(CASE WHEN sol_out > sol_in THEN 1.0 ELSE 0 END) AS REAL) /
    COUNT(*)                                                          AS win_rate,
  (CAST(SUM(CASE WHEN sol_out > sol_in THEN 1.0 ELSE 0 END) AS REAL) /
    COUNT(*)) * sqrt(CAST(COUNT(*) AS REAL))                          AS skill_score,
  SUM(sol_in)                                                         AS total_sol_in,
  SUM(sol_out)                                                        AS total_sol_out,
  (SUM(sol_out) - SUM(sol_in))                                        AS total_pnl_sol,
  AVG((sol_out - sol_in) / sol_in) * 100                              AS avg_pnl_pct,
  strftime('%s','now') * 1000                                         AS computed_at,
  30                                                                  AS window_days
FROM pair_pnl_tmp
GROUP BY wallet
HAVING COUNT(*) >= 5;

SELECT 'wallets_scored', COUNT(*) FROM wallet_stats;

DROP TABLE pair_pnl_tmp;
