// Migration snapshot capture + label resolver — MULTI-AGE.
//
// Each migrated mint gets snapshotted at 6 ages post-migration:
//   age=0     (at migration — pre-mig features + initial AMM state)
//   age=30    (30 min after — early dump or breakout?)
//   age=60    (1 hour — trend establishing)
//   age=360   (6 hours — momentum check)
//   age=720   (12 hours — sustained interest?)
//   age=1440  (24 hours — final outcome window)
//
// Each row is one (mint, age) tuple with features AT that age. Labels resolve
// once 24h has passed and are written to all age rows for easy joins.
//
// The agent gets a TIME SERIES of how a mint's day unfolds — perfect for
// "did it 10x?" prediction and "is it about to rug?" inference.

import { db } from '../db/index.js';

const SNAPSHOT_AGES_MIN = [0, 30, 60, 360, 720, 1440];     // minutes post-migration
const SWEEP_INTERVAL_MS = 60 * 1000;                        // every 60s
const FIRST_RUN_DELAY_MS = 60 * 1000;
const RESOLVE_TICK_INTERVAL_MS = 5 * 60 * 1000;
const RESOLVE_AFTER_HOURS = 24;
const ONE_MILLION_USD = 1_000_000;
const SOL_USD_FALLBACK = 90;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    // Find migration ages that haven't been captured yet for any migrated mint
    // (For each (mint, target_age), check if a row exists)
    needsAgeSnapshot: d.prepare(`
      SELECT m.mint_address, m.creator_wallet, m.migrated_at, m.created_at,
             m.peak_market_cap_sol, m.bundle_buyer_count,
             m.twitter, m.telegram, m.website, m.name, m.symbol,
             m.amm_pool_address, m.amm_dex, m.amm_liquidity_usd,
             m.current_market_cap_sol, m.last_price_sol,
             m.amm_volume_h1_usd, m.amm_volume_h24_usd,
             m.amm_buys_h24, m.amm_sells_h24,
             m.amm_price_change_h1, m.amm_price_change_h24
      FROM mints m
      WHERE m.migrated = 1 AND m.migrated_at IS NOT NULL
        AND m.migrated_at <= strftime('%s','now')*1000 - ? * 60000
        AND m.migrated_at > strftime('%s','now')*1000 - 7 * 86400000
        AND NOT EXISTS (
          SELECT 1 FROM ml_migration_snapshots s
          WHERE s.mint_address = m.mint_address AND s.snapshot_age_min = ?
        )
      ORDER BY m.migrated_at ASC LIMIT 30
    `),
    // Aggregates from trades up to a specific timestamp
    aggregateUpTo: d.prepare(`
      SELECT
        COUNT(*) AS trade_count,
        SUM(CASE WHEN is_buy = 1 THEN 1 ELSE 0 END) AS buy_count,
        SUM(CASE WHEN is_buy = 0 THEN 1 ELSE 0 END) AS sell_count,
        COUNT(DISTINCT CASE WHEN is_buy = 1 THEN wallet END) AS unique_buyers
      FROM trades WHERE mint_address = ? AND timestamp <= ?
    `),
    // Window aggregates (between two timestamps)
    windowAgg: d.prepare(`
      SELECT
        SUM(CASE WHEN is_buy = 1 THEN 1 ELSE 0 END) AS buys,
        SUM(CASE WHEN is_buy = 0 THEN 1 ELSE 0 END) AS sells,
        COUNT(DISTINCT CASE WHEN is_buy = 1 THEN wallet END) AS unique_buyers
      FROM trades WHERE mint_address = ? AND timestamp BETWEEN ? AND ?
    `),
    windowTrackedKol: d.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN w.tracked = 1 THEN t.wallet END) AS tracked,
        COUNT(DISTINCT CASE WHEN w.is_kol = 1 THEN t.wallet END) AS kol
      FROM trades t JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp BETWEEN ? AND ?
    `),
    creatorStats: d.prepare(`
      SELECT
        (SELECT COUNT(*) FROM mints WHERE creator_wallet = ? AND created_at < ?) AS launches,
        (SELECT COUNT(*) FROM mints WHERE creator_wallet = ? AND migrated = 1 AND COALESCE(migrated_at, created_at) < ?) AS migrations
    `),
    microstructure: d.prepare(`SELECT volatility_pct, sandwich_risk FROM mint_microstructure WHERE mint_address = ?`),
    intelVerdict: d.prepare(`SELECT verdict FROM ml_mint_intel WHERE mint_address = ?`),
    migAnchorPrice: d.prepare(`
      SELECT price_sol, market_cap_sol FROM trades
      WHERE mint_address = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 1
    `),
    peakSinceMig: d.prepare(`
      SELECT MAX(price_sol) AS peak_price, MAX(market_cap_sol) AS peak_mcap
      FROM trades WHERE mint_address = ? AND timestamp BETWEEN ? AND ?
    `),
    insertSnapshot: d.prepare(`INSERT OR IGNORE INTO ml_migration_snapshots
      (mint_address, snapshot_age_min, migrated_at, snapshot_ts,
       current_mcap_sol, current_price_sol, liquidity_usd,
       amm_volume_h1_usd, amm_volume_h24_usd, amm_buys_h24, amm_sells_h24,
       amm_price_change_h1, amm_price_change_h24,
       window_buys, window_sells, window_unique_buyers, window_tracked_buyers, window_kol_buyers,
       pct_from_migration, peak_pct_so_far,
       pre_mig_age_min, pre_mig_peak_mcap_sol, pre_mig_unique_buyers, pre_mig_trade_count,
       pre_mig_buy_count, pre_mig_sell_count, pre_mig_buy_sell_ratio,
       pre_mig_tracked_buyers, pre_mig_kol_buyers, pre_mig_bundle_buyers,
       pre_mig_volatility_pct, pre_mig_sandwich_risk,
       pre_mig_creator_launches, pre_mig_creator_migrations,
       has_twitter, has_telegram, has_website, name_length, symbol_length,
       migration_hour_utc, migration_dow,
       amm_initial_liquidity_usd, amm_dex, amm_pool_address, pre_mig_intel_verdict)
      VALUES (?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?,  ?, ?,
              ?, ?, ?, ?, ?,  ?, ?,
              ?, ?, ?, ?,  ?, ?, ?,
              ?, ?, ?,  ?, ?,
              ?, ?,  ?, ?, ?, ?, ?,
              ?, ?,  ?, ?, ?, ?)`),

    // Label resolver
    unresolvedAnchors: d.prepare(`
      SELECT DISTINCT s.mint_address, s.migrated_at FROM ml_migration_snapshots s
      WHERE s.labels_resolved_at IS NULL
        AND s.migrated_at < strftime('%s','now')*1000 - ? * 3600000
      LIMIT 100
    `),
    earlyDumpCheck: d.prepare(`
      SELECT MIN(price_sol) AS min_price FROM trades
      WHERE mint_address = ? AND timestamp BETWEEN ? AND ?
    `),
    aliveCheck: d.prepare(`
      SELECT COUNT(*) AS n FROM trades WHERE mint_address = ? AND timestamp BETWEEN ? AND ?
    `),
    mintCurrent: d.prepare(`SELECT peak_market_cap_sol, amm_liquidity_usd, amm_volume_h24_usd FROM mints WHERE mint_address = ?`),
    updateLabelsForMint: d.prepare(`UPDATE ml_migration_snapshots SET
      post_mig_peak_mcap_sol = ?, post_mig_peak_pct = ?,
      post_mig_hits_2x = ?, post_mig_hits_5x = ?, post_mig_hits_10x = ?,
      post_mig_hits_1m_usd = ?,
      post_mig_rugs_1h = ?, post_mig_alive_24h = ?, post_mig_alive_72h = ?,
      post_mig_volume_24h_usd = ?, post_mig_max_liquidity_usd = ?,
      labels_resolved_at = ?
      WHERE mint_address = ?`),
  };
  return stmts;
}

function captureOneAge(m, ageMin) {
  const s = S();
  const targetTs = m.migrated_at + ageMin * 60000;
  const isAnchor = ageMin === 0;

  // Anchor price (first trade at/after migration) — used for pct_from_migration
  const anchor = s.migAnchorPrice.get(m.mint_address, m.migrated_at);
  const anchorPrice = anchor?.price_sol || 0;
  const anchorMcap = anchor?.market_cap_sol || 0;

  // Current state at this age:
  // For ages > 0, use whatever data we have at that timestamp
  // (we store the most recent mcap/price as a proxy for "at age X" state)
  // Realistic: we only have mints table snapshot, so "current_mcap_sol" is mostly NOW
  const currentMcapSol = m.current_market_cap_sol || 0;
  const currentPrice = m.last_price_sol || 0;
  const liquidityUsd = m.amm_liquidity_usd || 0;

  // Window aggregates: between (targetTs - window) and targetTs
  const windowMs = ageMin === 0 ? 0 : ageMin * 60000;
  const windowStart = ageMin === 0 ? m.migrated_at : (m.migrated_at + Math.max(0, (ageMin - 30) * 60000));
  const windowEnd = targetTs;
  const winAgg = ageMin === 0
    ? { buys: 0, sells: 0, unique_buyers: 0 }
    : s.windowAgg.get(m.mint_address, windowStart, windowEnd);
  const winTk = ageMin === 0
    ? { tracked: 0, kol: 0 }
    : s.windowTrackedKol.get(m.mint_address, windowStart, windowEnd);

  // Peak so far (since migration up to this age)
  const peakRow = s.peakSinceMig.get(m.mint_address, m.migrated_at, targetTs);
  const peakMcap = peakRow?.peak_mcap || anchorMcap;
  const peakPctSoFar = anchorMcap > 0 ? (peakMcap - anchorMcap) / anchorMcap : 0;
  const pctFromMig = anchorMcap > 0 ? (currentMcapSol - anchorMcap) / anchorMcap : 0;

  // For age=0, also gather pre-migration features
  let preMig = {};
  if (isAnchor) {
    const agg = s.aggregateUpTo.get(m.mint_address, m.migrated_at);
    const tk = ageMin === 0 ? s.windowTrackedKol.get(m.mint_address, 0, m.migrated_at) : { tracked: 0, kol: 0 };
    const cs = s.creatorStats.get(m.creator_wallet || '', m.migrated_at, m.creator_wallet || '', m.migrated_at);
    const ms = s.microstructure.get(m.mint_address);
    const intel = s.intelVerdict.get(m.mint_address);
    const dt = new Date(m.migrated_at);
    const buySellRatio = agg.sell_count > 0 ? agg.buy_count / agg.sell_count : (agg.buy_count > 0 ? 99 : 0);
    preMig = {
      pre_mig_age_min: m.created_at ? (m.migrated_at - m.created_at) / 60000 : null,
      pre_mig_peak_mcap_sol: m.peak_market_cap_sol || 0,
      pre_mig_unique_buyers: agg.unique_buyers || 0,
      pre_mig_trade_count: agg.trade_count || 0,
      pre_mig_buy_count: agg.buy_count || 0,
      pre_mig_sell_count: agg.sell_count || 0,
      pre_mig_buy_sell_ratio: buySellRatio,
      pre_mig_tracked_buyers: tk.tracked || 0,
      pre_mig_kol_buyers: tk.kol || 0,
      pre_mig_bundle_buyers: m.bundle_buyer_count || 0,
      pre_mig_volatility_pct: ms?.volatility_pct ?? null,
      pre_mig_sandwich_risk: ms?.sandwich_risk ?? null,
      pre_mig_creator_launches: cs?.launches || 0,
      pre_mig_creator_migrations: cs?.migrations || 0,
      has_twitter: m.twitter ? 1 : 0,
      has_telegram: m.telegram ? 1 : 0,
      has_website: m.website ? 1 : 0,
      name_length: (m.name || '').length,
      symbol_length: (m.symbol || '').length,
      migration_hour_utc: dt.getUTCHours(),
      migration_dow: dt.getUTCDay(),
      amm_initial_liquidity_usd: m.amm_liquidity_usd || 0,
      amm_dex: m.amm_dex || null,
      amm_pool_address: m.amm_pool_address || null,
      pre_mig_intel_verdict: intel?.verdict || null,
    };
  } else {
    preMig = {
      pre_mig_age_min: null, pre_mig_peak_mcap_sol: null, pre_mig_unique_buyers: null,
      pre_mig_trade_count: null, pre_mig_buy_count: null, pre_mig_sell_count: null, pre_mig_buy_sell_ratio: null,
      pre_mig_tracked_buyers: null, pre_mig_kol_buyers: null, pre_mig_bundle_buyers: null,
      pre_mig_volatility_pct: null, pre_mig_sandwich_risk: null,
      pre_mig_creator_launches: null, pre_mig_creator_migrations: null,
      has_twitter: null, has_telegram: null, has_website: null, name_length: null, symbol_length: null,
      migration_hour_utc: null, migration_dow: null,
      amm_initial_liquidity_usd: null, amm_dex: null, amm_pool_address: null, pre_mig_intel_verdict: null,
    };
  }

  s.insertSnapshot.run(
    m.mint_address, ageMin, m.migrated_at, Date.now(),
    currentMcapSol, currentPrice, liquidityUsd,
    m.amm_volume_h1_usd || 0, m.amm_volume_h24_usd || 0,
    m.amm_buys_h24 || 0, m.amm_sells_h24 || 0,
    m.amm_price_change_h1 || 0, m.amm_price_change_h24 || 0,
    winAgg?.buys || 0, winAgg?.sells || 0, winAgg?.unique_buyers || 0,
    winTk?.tracked || 0, winTk?.kol || 0,
    pctFromMig, peakPctSoFar,
    preMig.pre_mig_age_min, preMig.pre_mig_peak_mcap_sol, preMig.pre_mig_unique_buyers, preMig.pre_mig_trade_count,
    preMig.pre_mig_buy_count, preMig.pre_mig_sell_count, preMig.pre_mig_buy_sell_ratio,
    preMig.pre_mig_tracked_buyers, preMig.pre_mig_kol_buyers, preMig.pre_mig_bundle_buyers,
    preMig.pre_mig_volatility_pct, preMig.pre_mig_sandwich_risk,
    preMig.pre_mig_creator_launches, preMig.pre_mig_creator_migrations,
    preMig.has_twitter, preMig.has_telegram, preMig.has_website, preMig.name_length, preMig.symbol_length,
    preMig.migration_hour_utc, preMig.migration_dow,
    preMig.amm_initial_liquidity_usd, preMig.amm_dex, preMig.amm_pool_address, preMig.pre_mig_intel_verdict,
  );
}

function captureTick() {
  try {
    let totalCaptured = 0;
    for (const ageMin of SNAPSHOT_AGES_MIN) {
      const candidates = S().needsAgeSnapshot.all(ageMin, ageMin);
      for (const m of candidates) {
        try { captureOneAge(m, ageMin); totalCaptured++; } catch (err) { /* swallow */ }
      }
    }
    if (totalCaptured > 0) console.log(`[mig-snap] captured ${totalCaptured} migration snapshot rows across ${SNAPSHOT_AGES_MIN.length} ages`);
  } catch (err) { console.error('[mig-snap] capture err:', err.message); }
}

function resolveTick(getSolUsd) {
  try {
    const rows = S().unresolvedAnchors.all(RESOLVE_AFTER_HOURS);
    if (rows.length === 0) return;
    const solUsd = getSolUsd() || SOL_USD_FALLBACK;
    let resolved = 0;
    for (const r of rows) {
      try {
        const migAt = r.migrated_at;
        const anchor = S().migAnchorPrice.get(r.mint_address, migAt);
        const migMcap = anchor?.market_cap_sol || 0;
        const migPrice = anchor?.price_sol || 0;
        if (migMcap <= 0) {
          // Not enough data — mark resolved so we don't re-try
          S().updateLabelsForMint.run(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, Date.now(), r.mint_address);
          resolved++;
          continue;
        }
        const peakRow = S().peakSinceMig.get(r.mint_address, migAt, migAt + 72 * 3600000);
        const mintRow = S().mintCurrent.get(r.mint_address);
        const peakMcap = Math.max(peakRow?.peak_mcap || 0, mintRow?.peak_market_cap_sol || 0);
        const peakPct = (peakMcap - migMcap) / migMcap;
        const peakUsd = peakMcap * solUsd;
        const dump = S().earlyDumpCheck.get(r.mint_address, migAt, migAt + 3600000);
        const rugs1h = (dump?.min_price && migPrice > 0 && dump.min_price < migPrice * 0.20) ? 1 : 0;
        const alive24h = S().aliveCheck.get(r.mint_address, migAt + 22 * 3600000, migAt + 26 * 3600000).n >= 5 ? 1 : 0;
        const alive72hWin = Date.now() - migAt >= 72 * 3600000;
        const alive72h = alive72hWin
          ? (S().aliveCheck.get(r.mint_address, migAt + 70 * 3600000, migAt + 74 * 3600000).n >= 3 ? 1 : 0)
          : null;

        S().updateLabelsForMint.run(
          peakMcap, peakPct,
          peakMcap >= migMcap * 2 ? 1 : 0,
          peakMcap >= migMcap * 5 ? 1 : 0,
          peakMcap >= migMcap * 10 ? 1 : 0,
          peakUsd >= ONE_MILLION_USD ? 1 : 0,
          rugs1h, alive24h, alive72h,
          mintRow?.amm_volume_h24_usd || 0, mintRow?.amm_liquidity_usd || 0,
          Date.now(), r.mint_address,
        );
        resolved++;
      } catch (err) { /* swallow */ }
    }
    if (resolved > 0) console.log(`[mig-snap] resolved labels for ${resolved} migrated mints`);
  } catch (err) { console.error('[mig-snap] resolve err:', err.message); }
}

export function startMigrationSnapshot(getSolUsd) {
  setTimeout(() => { captureTick(); resolveTick(getSolUsd); }, FIRST_RUN_DELAY_MS);
  setInterval(captureTick, SWEEP_INTERVAL_MS);
  setInterval(() => resolveTick(getSolUsd), RESOLVE_TICK_INTERVAL_MS);
  console.log(`[mig-snap] migration multi-age snapshot system started · ages=${SNAPSHOT_AGES_MIN.join(',')} min · capture/60s · resolve/5min`);
}
