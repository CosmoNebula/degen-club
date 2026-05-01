import { db } from '../db/index.js';

// Migrator-hunter scoring: who buys mints that end up graduating, and how early do they get in?
//
// Per-wallet stats over migrated mints:
//   migrator_buys           — distinct migrated mints the wallet bought (any time).
//   migrator_pre_mig_buys   — distinct migrated mints bought BEFORE migrated_at (the harder skill).
//   migrator_avg_entry_pct  — mean of (first_buy_mcap / peak_mcap) across pre-migration buys; lower = earlier.
//   migrator_realized_sol   — sum of (sell_sol - buy_sol) across all migrated mints (proxy for exit quality).
//   migrator_score          — composite, see scoreFor().

const MIN_SAMPLE = 3;

export function backfillMigratorStats({ verbose = false } = {}) {
  const d = db();
  const t0 = Date.now();

  // Per (wallet, mint) aggregates over migrated mints only.
  // Single pass: window-pick first buy per (wallet, mint), aggregate net SOL, then roll up by wallet.
  const rows = d.prepare(`
    WITH mig AS (
      SELECT mint_address, peak_market_cap_sol AS peak, migrated_at AS mig_at
      FROM mints WHERE migrated = 1 AND peak_market_cap_sol > 0
    ),
    pair_first AS (
      SELECT t.wallet, t.mint_address, t.market_cap_sol AS first_buy_mcap, t.timestamp AS first_buy_ts
      FROM (
        SELECT wallet, mint_address, market_cap_sol, timestamp,
               ROW_NUMBER() OVER (PARTITION BY wallet, mint_address ORDER BY timestamp ASC) rn
        FROM trades
        WHERE is_buy = 1 AND mint_address IN (SELECT mint_address FROM mig)
      ) t WHERE t.rn = 1
    ),
    pair_net AS (
      SELECT wallet, mint_address,
             SUM(CASE WHEN is_buy = 0 THEN sol_amount ELSE -sol_amount END) AS net_sol
      FROM trades
      WHERE mint_address IN (SELECT mint_address FROM mig)
      GROUP BY wallet, mint_address
    ),
    per_pair AS (
      SELECT pf.wallet, pf.mint_address, pf.first_buy_mcap, pf.first_buy_ts,
             mig.peak, mig.mig_at, COALESCE(pn.net_sol, 0) AS net_sol
      FROM pair_first pf
      JOIN mig ON mig.mint_address = pf.mint_address
      LEFT JOIN pair_net pn ON pn.wallet = pf.wallet AND pn.mint_address = pf.mint_address
    )
    SELECT
      wallet,
      COUNT(*) AS migrator_buys,
      SUM(CASE WHEN mig_at IS NOT NULL AND first_buy_ts < mig_at THEN 1 ELSE 0 END) AS pre_mig_buys,
      AVG(CASE WHEN mig_at IS NOT NULL AND first_buy_ts < mig_at AND first_buy_mcap > 0
               THEN first_buy_mcap / peak END) AS avg_entry_pct,
      SUM(net_sol) AS realized_sol
    FROM per_pair
    GROUP BY wallet
  `).all();

  const upd = d.prepare(`UPDATE wallets SET
    migrator_buys = ?,
    migrator_pre_mig_buys = ?,
    migrator_avg_entry_pct = ?,
    migrator_realized_sol = ?,
    migrator_score = ?,
    migrator_stats_updated_at = ?
    WHERE address = ?`);
  const now = Date.now();

  let updated = 0;
  const tx = d.transaction((rs) => {
    for (const r of rs) {
      const score = scoreFor(r);
      const info = upd.run(
        r.migrator_buys || 0,
        r.pre_mig_buys || 0,
        r.avg_entry_pct || 0,
        r.realized_sol || 0,
        score,
        now,
        r.wallet,
      );
      if (info.changes > 0) updated++;
    }
  });
  tx(rows);

  const took = Date.now() - t0;
  if (verbose) console.log(`[migrator-stats] scanned ${rows.length} wallets, updated ${updated}, in ${took}ms`);
  return { scanned: rows.length, updated, ms: took };
}

// Composite score. Idea: reward wallets that buy migraters early (low avg_entry_pct),
// hit a meaningful sample, and net positive SOL on those bets.
// Below MIN_SAMPLE, force score = 0 to keep noise out of the leaderboard.
export function scoreFor(r) {
  const preMig = r.pre_mig_buys || 0;
  if (preMig < MIN_SAMPLE) return 0;
  const entryPct = r.avg_entry_pct || 1;       // 1 = entered at peak (worst), 0 = at zero (best)
  const earliness = Math.max(0, 1 - entryPct); // 0..1
  const realized = r.realized_sol || 0;
  // Tanh-clamp realized into [-1,1] using 5 SOL as the "good" scale.
  const realizedNorm = Math.tanh(realized / 5);
  // Sample weight saturates at ~20 pre-mig buys.
  const sampleWeight = Math.min(1, preMig / 20);
  return Number((earliness * sampleWeight * (0.5 + 0.5 * realizedNorm)).toFixed(4));
}

// Called when a single mint just flipped migrated=1.
// Recomputes stats from scratch for every wallet that ever traded this mint —
// that subset is small (typically <500 wallets), so it's cheap and stays consistent
// with the full backfill (no incremental drift).
export function updateMigratorStatsForMint(mintAddress) {
  const d = db();
  const wallets = d.prepare(
    `SELECT DISTINCT wallet FROM trades WHERE mint_address = ?`
  ).all(mintAddress).map(r => r.wallet);
  if (wallets.length === 0) return { wallets: 0, updated: 0 };

  const placeholders = wallets.map(() => '?').join(',');
  const rows = d.prepare(`
    WITH mig AS (
      SELECT mint_address, peak_market_cap_sol AS peak, migrated_at AS mig_at
      FROM mints WHERE migrated = 1 AND peak_market_cap_sol > 0
    ),
    pair_first AS (
      SELECT t.wallet, t.mint_address, t.market_cap_sol AS first_buy_mcap, t.timestamp AS first_buy_ts
      FROM (
        SELECT wallet, mint_address, market_cap_sol, timestamp,
               ROW_NUMBER() OVER (PARTITION BY wallet, mint_address ORDER BY timestamp ASC) rn
        FROM trades
        WHERE is_buy = 1 AND wallet IN (${placeholders})
          AND mint_address IN (SELECT mint_address FROM mig)
      ) t WHERE t.rn = 1
    ),
    pair_net AS (
      SELECT wallet, mint_address,
             SUM(CASE WHEN is_buy = 0 THEN sol_amount ELSE -sol_amount END) AS net_sol
      FROM trades
      WHERE wallet IN (${placeholders}) AND mint_address IN (SELECT mint_address FROM mig)
      GROUP BY wallet, mint_address
    ),
    per_pair AS (
      SELECT pf.wallet, pf.mint_address, pf.first_buy_mcap, pf.first_buy_ts,
             mig.peak, mig.mig_at, COALESCE(pn.net_sol, 0) AS net_sol
      FROM pair_first pf
      JOIN mig ON mig.mint_address = pf.mint_address
      LEFT JOIN pair_net pn ON pn.wallet = pf.wallet AND pn.mint_address = pf.mint_address
    )
    SELECT
      wallet,
      COUNT(*) AS migrator_buys,
      SUM(CASE WHEN mig_at IS NOT NULL AND first_buy_ts < mig_at THEN 1 ELSE 0 END) AS pre_mig_buys,
      AVG(CASE WHEN mig_at IS NOT NULL AND first_buy_ts < mig_at AND first_buy_mcap > 0
               THEN first_buy_mcap / peak END) AS avg_entry_pct,
      SUM(net_sol) AS realized_sol
    FROM per_pair
    GROUP BY wallet
  `).all(...wallets, ...wallets);

  const upd = d.prepare(`UPDATE wallets SET
    migrator_buys = ?, migrator_pre_mig_buys = ?, migrator_avg_entry_pct = ?,
    migrator_realized_sol = ?, migrator_score = ?, migrator_stats_updated_at = ?
    WHERE address = ?`);
  const now = Date.now();
  let updated = 0;
  const tx = d.transaction((rs) => {
    for (const r of rs) {
      const info = upd.run(
        r.migrator_buys || 0, r.pre_mig_buys || 0, r.avg_entry_pct || 0,
        r.realized_sol || 0, scoreFor(r), now, r.wallet,
      );
      if (info.changes > 0) updated++;
    }
  });
  tx(rows);
  return { wallets: wallets.length, scored: rows.length, updated };
}

export function topMigratorHunters({ limit = 50, minPreMigBuys = MIN_SAMPLE, minRealized = 0 } = {}) {
  const d = db();
  return d.prepare(`
    SELECT address, migrator_buys, migrator_pre_mig_buys,
           ROUND(migrator_avg_entry_pct, 4) AS avg_entry_pct,
           ROUND(migrator_realized_sol, 3) AS realized_sol,
           migrator_score AS score,
           category, label, is_kol, auto_blocked
    FROM wallets
    WHERE migrator_pre_mig_buys >= ? AND migrator_realized_sol >= ?
    ORDER BY migrator_score DESC, migrator_realized_sol DESC
    LIMIT ?
  `).all(minPreMigBuys, minRealized, limit);
}
