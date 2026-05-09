// ML Snapshot Sweeper — captures forward-looking training data.
//
// Every 30s, finds mints whose age is within ±15s of a target age (60s, 5m,
// 15m, 60m) and that haven't been snapshotted at that target yet. For each,
// computes ~25 features from data available at that exact moment and writes
// a row to ml_mint_snapshots. Labels (migrated, peaked_N) get filled in
// later by the label resolver once the mint's trajectory has played out.
//
// This is what we'll train the migration classifier on (Phase 2C+).

import { db } from '../db/index.js';

const TARGETS_SEC = [60, 300, 900, 3600];
const SWEEP_INTERVAL_MS = 30 * 1000;
const TOLERANCE_SEC = 30; // mint age must fall within target ± 30s

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    findCandidates: d.prepare(`
      SELECT m.* FROM mints m
      LEFT JOIN ml_mint_snapshots s ON s.mint_address = m.mint_address AND s.snapshot_age_sec = ?
      WHERE m.created_at BETWEEN ? AND ?
        AND s.mint_address IS NULL
      LIMIT 200
    `),
    creatorStats: d.prepare(`
      SELECT
        (SELECT COUNT(*) FROM mints WHERE creator_wallet = ? AND created_at < ?) AS launches,
        (SELECT COUNT(*) FROM mints WHERE creator_wallet = ? AND migrated = 1
           AND COALESCE(migrated_at, created_at) < ?) AS migrations
    `),
    tradesUpTo: d.prepare(`
      SELECT t.timestamp, t.wallet, t.is_buy, t.sol_amount, t.price_sol, t.market_cap_sol,
             COALESCE(w.tracked, 0) AS tracked, COALESCE(w.is_kol, 0) AS is_kol,
             COALESCE(w.bundle_cluster_id, '') AS bundle_id
      FROM trades t LEFT JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? AND t.timestamp <= ? ORDER BY t.timestamp ASC
    `),
    microstructure: d.prepare(`SELECT volatility_pct, sandwich_risk, reaction_speed_ms FROM mint_microstructure WHERE mint_address = ?`),
    // priority_fee_p99 captures the *contested-slot* fee, not the median.
    // Most pump.fun slots have 0 fee competition so p50/p90 are always 0;
    // p99 is the only fee percentile that carries real signal. Stored into
    // the existing priority_fee_p90 ml_mint_snapshots column for back-compat.
    latestConditions: d.prepare(`SELECT rpc_helius_p90, priority_fee_p99, network_status FROM live_conditions ORDER BY timestamp DESC LIMIT 1`),
    insertSnapshot: d.prepare(`INSERT OR IGNORE INTO ml_mint_snapshots (
      mint_address, snapshot_age_sec, snapshot_ts,
      initial_buy_sol, creator_launch_count, creator_migrated_count,
      has_twitter, has_telegram, has_website, name_length, symbol_length,
      created_hour_utc, created_dow,
      last_price_sol, last_mcap_sol, peak_mcap_sol_so_far, v_sol_in_curve,
      sol_inflow, sol_outflow, buy_count, sell_count, buy_sell_ratio,
      unique_buyers, tracked_buyers, kol_buyers, bundle_buyers,
      trade_count, trades_per_min, volatility_pct, sandwich_risk, reaction_speed_ms,
      rpc_latency_p90_ms, priority_fee_p90, network_status
    ) VALUES (?,?,?, ?,?,?, ?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?, ?,?,?, ?,?,?)`),
  };
  return stmts;
}

function computeAggregates(trades) {
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
    solIn,
    solOut,
    buyCount,
    sellCount,
    buySellRatio: sellCount > 0 ? (buyCount / sellCount) : (buyCount > 0 ? 99 : 0),
    uniqueBuyers: buyers.size,
    trackedBuyers: trackedBuyers.size,
    kolBuyers: kolBuyers.size,
    bundleBuyers: bundleBuyers.size,
    tradeCount: buyCount + sellCount,
  };
}

function takeSnapshot(mint, target, snapshotTs) {
  const s = S();
  const trades = s.tradesUpTo.all(mint.mint_address, snapshotTs);
  const agg = computeAggregates(trades);
  const creatorStats = s.creatorStats.get(mint.creator_wallet || '', mint.created_at, mint.creator_wallet || '', mint.created_at);
  const ms = s.microstructure.get(mint.mint_address);
  const lc = s.latestConditions.get();
  const dt = new Date(mint.created_at);

  // EVENT: trigger agent eval when a mint first becomes scoring-eligible (60s age)
  // and shows interesting tracked-buyer activity. Async fire-and-forget.
  if (target === 60 && agg.trackedBuyers >= 1) {
    import('./agent-executor.js').then(m => {
      m.evaluateMintNow(mint.mint_address, `60s-age-tracked-${agg.trackedBuyers}`).catch(() => {});
    }).catch(() => {});
  }

  s.insertSnapshot.run(
    mint.mint_address, target, snapshotTs,
    mint.initial_buy_sol || 0,
    creatorStats?.launches || 0,
    creatorStats?.migrations || 0,
    mint.twitter ? 1 : 0,
    mint.telegram ? 1 : 0,
    mint.website ? 1 : 0,
    (mint.name || '').length,
    (mint.symbol || '').length,
    dt.getUTCHours(),
    dt.getUTCDay(),
    agg.lastPrice, agg.lastMcap, agg.peakMcap,
    mint.v_sol_in_curve || 0,
    agg.solIn, agg.solOut, agg.buyCount, agg.sellCount, agg.buySellRatio,
    agg.uniqueBuyers, agg.trackedBuyers, agg.kolBuyers, agg.bundleBuyers,
    agg.tradeCount, agg.tradeCount / Math.max(1, target / 60),
    // Use ?? not || so legitimate 0 values aren't turned into null
    ms?.volatility_pct ?? null,
    ms?.sandwich_risk ?? null,
    ms?.reaction_speed_ms ?? null,
    lc?.rpc_helius_p90 ?? null,
    lc?.priority_fee_p99 ?? null,  // see latestConditions comment — p99 is the real signal
    lc?.network_status ?? null,
  );
}

function sweep() {
  const s = S();
  const now = Date.now();
  let total = 0;
  for (const target of TARGETS_SEC) {
    const minCreated = now - (target + TOLERANCE_SEC) * 1000;
    const maxCreated = now - (target - TOLERANCE_SEC) * 1000;
    const candidates = s.findCandidates.all(target, minCreated, maxCreated);
    for (const m of candidates) {
      try {
        takeSnapshot(m, target, now);
        total++;
      } catch (err) { console.error('[ml-snap] err:', err.message); }
    }
  }
  if (total > 0) console.log(`[ml-snap] swept · ${total} new snapshots`);
}

export function startSnapshotSweeper() {
  setInterval(() => {
    try { sweep(); } catch (err) { console.error('[ml-snap] sweep error:', err.message); }
  }, SWEEP_INTERVAL_MS);
  console.log('[ml-snap] snapshot sweeper started · targets=' + TARGETS_SEC.join('s,') + 's · interval=30s');
}
