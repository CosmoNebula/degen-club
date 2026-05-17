// 2026-05-16: post-retrain calibration check for new will_rug label.
// Compares predicted-bins vs actual rug rates. Should be tight now since
// the label points at canonical mint.rugged_at.

import { db } from '../src/db/index.js';

const d = db();

// Snapshot the validation distribution from the latest model.
console.log('=== will_rug label distribution (sanity check) ===');
const dist = d.prepare(`
  SELECT
    SUM(will_rug = 1) AS pos,
    SUM(will_rug = 0) AS neg,
    SUM(will_rug IS NULL) AS unk,
    ROUND(100.0 * AVG(will_rug), 3) AS pos_rate_pct,
    COUNT(*) AS total
  FROM ml_mint_snapshots
  WHERE snapshot_age_sec = 60
    AND snapshot_ts > strftime('%s','now')*1000 - 7*24*3600*1000
`).get();
console.log(JSON.stringify(dist, null, 2));

console.log('\n=== rejected coins via will_rug gate — actual outcomes ===');
// Pull from strategy_entry_rejections IF the new gate is already active.
const rejBin = d.prepare(`
  WITH rej AS (
    SELECT mint_address, MIN(actual) AS pred FROM strategy_entry_rejections
    WHERE gate_name = 'will_rug' AND rejected_at > strftime('%s','now')*1000 - 24*3600*1000
    GROUP BY mint_address
  )
  SELECT
    COUNT(*) AS n_rejected,
    SUM(CASE WHEN m.rugged = 1 THEN 1 ELSE 0 END) AS actually_rugged,
    SUM(CASE WHEN m.migrated = 1 THEN 1 ELSE 0 END) AS migrated,
    SUM(CASE WHEN m.peak_market_cap_sol >= 140 THEN 1 ELSE 0 END) AS hit_5x
  FROM rej r JOIN mints m ON m.mint_address = r.mint_address
`).get();
console.log(JSON.stringify(rejBin, null, 2));

console.log('\n=== will_migrate label distribution ===');
const migDist = d.prepare(`
  SELECT
    SUM(will_migrate = 1) AS pos,
    SUM(will_migrate = 0) AS neg,
    ROUND(100.0 * AVG(will_migrate), 3) AS pos_rate_pct,
    COUNT(*) AS total
  FROM ml_mint_snapshots
  WHERE snapshot_age_sec = 60
    AND snapshot_ts > strftime('%s','now')*1000 - 7*24*3600*1000
`).get();
console.log(JSON.stringify(migDist, null, 2));
