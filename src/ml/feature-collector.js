// Real-time feature extraction for ML inference.
//
// Mirrors what snapshot-sweeper.js writes to ml_mint_snapshots, but computes
// features ON DEMAND for any mint. This is what the ml-client passes to the
// Python inference service.
//
// Feature set must stay in sync with:
//   - ml_mint_snapshots schema
//   - ml/scripts/extract_from_snapshots.py FEATURE_COLS
//   - ml/scripts/train.py FEATURE_COLS

import { db } from '../db/index.js';

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    getMint: d.prepare(`SELECT * FROM mints WHERE mint_address = ?`),
    creatorStats: d.prepare(`
      SELECT
        (SELECT COUNT(*) FROM mints WHERE creator_wallet = ? AND created_at < ?) AS launches,
        (SELECT COUNT(*) FROM mints WHERE creator_wallet = ? AND migrated = 1
           AND COALESCE(migrated_at, created_at) < ?) AS migrations
    `),
    tradesUpToNow: d.prepare(`
      SELECT t.timestamp, t.wallet, t.is_buy, t.sol_amount, t.price_sol, t.market_cap_sol,
             COALESCE(w.tracked, 0) AS tracked, COALESCE(w.is_kol, 0) AS is_kol,
             COALESCE(w.bundle_cluster_id, '') AS bundle_id
      FROM trades t LEFT JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? ORDER BY t.timestamp ASC
    `),
    microstructure: d.prepare(`SELECT volatility_pct, sandwich_risk, reaction_speed_ms FROM mint_microstructure WHERE mint_address = ?`),
    // p99 not p90 — see snapshot-sweeper for the rationale (pump.fun slots
    // are mostly uncontested so p50/p90 collapse to 0; p99 is the contested-slot signal)
    latestConditions: d.prepare(`SELECT rpc_helius_p90, priority_fee_p99, network_status FROM live_conditions ORDER BY timestamp DESC LIMIT 1`),
  };
  return stmts;
}

function aggregate(trades) {
  if (!trades || trades.length === 0) {
    return {
      lastPrice: 0, lastMcap: 0, peakMcap: 0,
      solIn: 0, solOut: 0, buyCount: 0, sellCount: 0,
      buySellRatio: 0, uniqueBuyers: 0, trackedBuyers: 0,
      kolBuyers: 0, bundleBuyers: 0, tradeCount: 0,
    };
  }
  let solIn = 0, solOut = 0, buyCount = 0, sellCount = 0;
  let peakMcap = 0;
  const buyers = new Set(), trackedBuyers = new Set(), kolBuyers = new Set(), bundleBuyers = new Set();
  for (const t of trades) {
    if (t.market_cap_sol && t.market_cap_sol > peakMcap) peakMcap = t.market_cap_sol;
    if (t.is_buy === 1) {
      solIn += t.sol_amount || 0;
      buyCount++;
      if (t.wallet) {
        buyers.add(t.wallet);
        if (t.tracked === 1) trackedBuyers.add(t.wallet);
        if (t.is_kol === 1) kolBuyers.add(t.wallet);
        if (t.bundle_id) bundleBuyers.add(t.wallet);
      }
    } else {
      solOut += t.sol_amount || 0;
      sellCount++;
    }
  }
  const last = trades[trades.length - 1];
  return {
    lastPrice: last.price_sol || 0,
    lastMcap: last.market_cap_sol || 0,
    peakMcap,
    solIn, solOut, buyCount, sellCount,
    buySellRatio: sellCount > 0 ? (buyCount / sellCount) : (buyCount > 0 ? 99 : 0),
    uniqueBuyers: buyers.size,
    trackedBuyers: trackedBuyers.size,
    kolBuyers: kolBuyers.size,
    bundleBuyers: bundleBuyers.size,
    tradeCount: buyCount + sellCount,
  };
}

// Returns null if mint not found. Otherwise returns a feature dict matching
// the model's expected column order.
export function collectFeatures(mintAddress, snapshotAgeSec = null) {
  const s = S();
  const mint = s.getMint.get(mintAddress);
  if (!mint) return null;
  const now = Date.now();
  const ageSec = snapshotAgeSec || Math.max(1, Math.round((now - mint.created_at) / 1000));

  const trades = s.tradesUpToNow.all(mintAddress);
  const agg = aggregate(trades);
  const creatorStats = s.creatorStats.get(mint.creator_wallet || '', mint.created_at, mint.creator_wallet || '', mint.created_at);
  const ms = s.microstructure.get(mintAddress);
  const lc = s.latestConditions.get();
  const dt = new Date(mint.created_at);

  return {
    snapshot_age_sec: ageSec,
    initial_buy_sol: mint.initial_buy_sol || 0,
    creator_launch_count: creatorStats?.launches || 0,
    creator_migrated_count: creatorStats?.migrations || 0,
    has_twitter: mint.twitter ? 1 : 0,
    has_telegram: mint.telegram ? 1 : 0,
    has_website: mint.website ? 1 : 0,
    name_length: (mint.name || '').length,
    symbol_length: (mint.symbol || '').length,
    created_hour_utc: dt.getUTCHours(),
    created_dow: dt.getUTCDay(),
    last_price_sol: agg.lastPrice,
    last_mcap_sol: agg.lastMcap,
    peak_mcap_sol_so_far: agg.peakMcap,
    v_sol_in_curve: mint.v_sol_in_curve || 0,
    sol_inflow: agg.solIn,
    sol_outflow: agg.solOut,
    buy_count: agg.buyCount,
    sell_count: agg.sellCount,
    buy_sell_ratio: agg.buySellRatio,
    unique_buyers: agg.uniqueBuyers,
    tracked_buyers: agg.trackedBuyers,
    kol_buyers: agg.kolBuyers,
    bundle_buyers: agg.bundleBuyers,
    trade_count: agg.tradeCount,
    trades_per_min: agg.tradeCount / Math.max(1, ageSec / 60),
    // Pass through nulls for sparse features. The training pipeline writes
    // genuine NULLs to ml_mint_snapshots and HistGradientBoosting handles NaN
    // natively as its own split direction. Coercing to 0 would create
    // train/serve skew (model trained on NaN, served 0 = fake "instant" signal).
    volatility_pct: ms?.volatility_pct ?? null,
    sandwich_risk: ms?.sandwich_risk ?? null,
    reaction_speed_ms: ms?.reaction_speed_ms ?? null,
    rpc_latency_p90_ms: lc?.rpc_helius_p90 ?? null,
    priority_fee_p90: lc?.priority_fee_p99 ?? null,  // column kept as p90 name for back-compat; populated from p99
  };
}
