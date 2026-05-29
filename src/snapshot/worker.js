// snapshot/worker.js — Periodically computes the 88+ ML feature snapshots from
// the trades table and upserts them into ml_mint_snapshots so /predict-mint can
// score fresh mints.
//
// Strategy: capture each mint exactly once at each of a few canonical ages
// (60s, 300s, 900s, 1800s). The model picks the latest-age snapshot, so the
// bot's "view" of a mint matures as the mint ages.
//
// We only snapshot mints that were created AFTER this process started running,
// because mints created before that have no trade data in our DB → features
// would be misleading garbage.

import { db } from '../db.js';

// Expanded 2026-05-28: added sniper-window ages (5/15/30s) and fills in mid/late
// gaps (120, 600, 2400). Focus on sniper ages — that's where launches differentiate
// and our model can't currently see early-life dynamics.
const AGES_TO_CAPTURE = [5, 15, 30, 60, 120, 300, 600, 900, 1800, 2400, 3600]; // seconds
const WORKER_INTERVAL_MS = 30_000;
const TARGET_AGE_WINDOW_S = 90; // capture each age within a 90s window of crossing it

// Track when this process started so we don't backfill snapshots for old mints
// that have no trade data in our table.
let _bornAtMs = 0;
function setBornAt() { _bornAtMs = Date.now(); }

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    // Mints in the snapshot window: created since process start, fresh enough
    // that at least one age threshold could still apply.
    candidateMints: d.prepare(`SELECT
      mint_address, creator_wallet, name, symbol, description,
      twitter, telegram, website,
      initial_buy_sol, created_at, migrated, rugged,
      last_price_sol, current_market_cap_sol, peak_market_cap_sol,
      v_sol_in_curve, v_tokens_in_curve
      FROM mints
      WHERE created_at > ?
        AND created_at < ?
        AND rugged = 0
        AND name IS NOT NULL
        AND trade_count >= 20`),
    // Existing snapshots for a mint (so we don't double-insert at the same age)
    existingAges: d.prepare(`SELECT snapshot_age_sec FROM ml_mint_snapshots
      WHERE mint_address = ?`),
    // Trades in the as-of window: created_at .. created_at + ageSec*1000
    tradesInWindow: d.prepare(`SELECT timestamp, wallet, is_buy, sol_amount,
      token_amount, price_sol, seconds_from_creation
      FROM trades
      WHERE mint_address = ?
        AND timestamp <= ?
      ORDER BY timestamp ASC`),
    // Creator stats — how many other mints has this wallet launched/migrated?
    creatorStats: d.prepare(`SELECT
      COUNT(*) AS launches,
      SUM(migrated) AS migrated,
      MIN(created_at) AS first_seen,
      MAX(CASE WHEN created_at < ? THEN created_at ELSE 0 END) AS last_before
      FROM mints WHERE creator_wallet = ?`),
    creatorSiblings: d.prepare(`SELECT COUNT(*) AS n FROM mints
      WHERE creator_wallet = ? AND created_at BETWEEN ? AND ?
        AND mint_address != ?`),
    // Wallet skill lookup — returns null if wallet hasn't been scored yet.
    // is_* flags are smart-money-pool filters (drop high-freq bots, flippers,
    // and net-unprofitable wallets).
    walletStat: d.prepare(`SELECT skill_score, median_hold_sec,
      is_high_freq, is_flipper, is_unprofitable
      FROM wallet_stats WHERE wallet = ?`),
    insertSnap: null, // built dynamically once we know the column list
  };
  return _stmts;
}

const FEATURE_COLS = [
  'snapshot_age_sec',
  'initial_buy_sol',
  'creator_launch_count', 'creator_migrated_count',
  'has_twitter', 'has_telegram', 'has_website',
  'name_length', 'symbol_length',
  'created_hour_utc', 'created_dow',
  'last_price_sol', 'last_mcap_sol', 'peak_mcap_sol_so_far',
  'v_sol_in_curve',
  'sol_inflow', 'sol_outflow',
  'buy_count', 'sell_count', 'buy_sell_ratio',
  'unique_buyers', 'tracked_buyers', 'kol_buyers', 'bundle_buyers',
  'top10_buyers', 'top50_buyers', 'weighted_buyer_quality',
  'avg_buy_sol', 'median_buy_sol', 'p90_buy_sol', 'max_buy_sol', 'std_buy_sol',
  'avg_sell_sol', 'median_sell_sol', 'p90_sell_sol', 'max_sell_sol', 'std_sell_sol',
  'top1_buyer_sol_pct', 'top3_buyer_sol_pct', 'top5_buyer_sol_pct', 'buyer_hhi',
  'top1_seller_sol_pct', 'top3_seller_sol_pct', 'top5_seller_sol_pct', 'seller_hhi',
  'sniper_buyer_count', 'pct_sniper_buys',
  'first_block_buyer_count', 'pct_first_block_buys',
  'avg_buyer_rank', 'median_buyer_rank',
  'pct_buyers_in_first_10',
  'tracked_first_seen_sec', 'kol_first_seen_sec',
  'seconds_to_5_unique_buyers', 'seconds_to_10_unique_buyers',
  'n_reversals_in_window', 'longest_up_run_pct', 'longest_down_run_pct',
  'max_30s_buy_sol', 'max_30s_buy_count', 'max_30s_buy_sell_ratio',
  'creator_buys_post_launch', 'creator_sells_post_launch',
  'creator_sol_to_sidewallets', 'creator_sidewallet_buyer_count',
  'inflow_accel_pct', 'buy_count_accel_pct',
  'top10_buy_timing_std_sec',
  'max_30s_sell_sol', 'max_30s_sell_count', 'max_30s_unique_sellers',
  'creator_recent_launch_siblings',
  'trend_signal_match', 'narrative_match_count',
  'pressure_60_buy_pct', 'pressure_60_net',
  'telegram_member_count',
  'buyer_hhi_delta', 'seller_hhi_delta',
  'bot_sniper_buyer_count', 'fast_human_sniper_count',
  'seconds_since_prev_creator_death',
  'trade_count', 'trades_per_min',
  'volatility_pct', 'sandwich_risk',
  'reaction_speed_ms', 'rpc_latency_p90_ms', 'priority_fee_p90',
  'network_status',
  'migrated',
  // 2026-05-28: WALLET SKILL features. Computed from wallet_stats table at
  // snapshot time. Smart-money signal — see scripts/wallet-skill-compute.py.
  'top_buyer_skill_p90',     // 90th-percentile skill score among this mint's buyers
  'smart_buyer_count',       // count of buyers with skill_score >= 2 AND no flags
  'whale_buyer_count',       // count of buyers with skill_score >= 5 AND no flags
  'avg_buyer_hold_sec',      // mean of buyer median-hold-secs (diamond-hands proxy)
  'top_seller_skill_p90',    // 90th-percentile skill among sellers (warning signal)
  'smart_seller_count',      // count of sellers with skill_score >= 2 AND no flags
  'snapshot_ts',
];
// snapshot_age_sec, snapshot_ts, mint_address aren't features but are required cols.

function getInsertStmt() {
  if (S().insertSnap) return S().insertSnap;
  const cols = ['mint_address', ...FEATURE_COLS];
  const sql = `INSERT INTO ml_mint_snapshots (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  S().insertSnap = db().prepare(sql);
  return S().insertSnap;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)));
  return sorted[idx];
}
function median(arr) { return quantile([...arr].sort((a, b) => a - b), 0.5); }
function p90(arr) { return quantile([...arr].sort((a, b) => a - b), 0.9); }
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// Herfindahl-Hirschman Index over wallet → SOL concentration
function hhi(weights) {
  const total = weights.reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  return weights.reduce((s, v) => s + (v / total) ** 2, 0);
}

function topNPct(weights, n) {
  if (!weights.length) return 0;
  const sorted = [...weights].sort((a, b) => b - a);
  const top = sorted.slice(0, n).reduce((s, v) => s + v, 0);
  const total = sorted.reduce((s, v) => s + v, 0);
  return total > 0 ? top / total : 0;
}

function computeFeatures(mint, ageSec) {
  const s = S();
  const cutoffMs = mint.created_at + ageSec * 1000;
  const trades = s.tradesInWindow.all(mint.mint_address, cutoffMs);

  const buys = trades.filter((t) => t.is_buy === 1);
  const sells = trades.filter((t) => t.is_buy === 0);
  const buyAmts = buys.map((t) => t.sol_amount);
  const sellAmts = sells.map((t) => t.sol_amount);

  const buyerWallets = new Map(); // wallet → total sol bought
  const sellerWallets = new Map();
  for (const t of buys) buyerWallets.set(t.wallet, (buyerWallets.get(t.wallet) || 0) + t.sol_amount);
  for (const t of sells) sellerWallets.set(t.wallet, (sellerWallets.get(t.wallet) || 0) + t.sol_amount);

  const uniqueBuyers = buyerWallets.size;
  const buyerVols = [...buyerWallets.values()];
  const sellerVols = [...sellerWallets.values()];

  // Sniper buyers: bought within first 30s of mint creation
  const sniperBuyers = new Set();
  for (const t of buys) {
    if (t.seconds_from_creation != null && t.seconds_from_creation <= 30) sniperBuyers.add(t.wallet);
  }

  // First-block buyers (within first 1s)
  const firstBlockBuyers = new Set();
  for (const t of buys) {
    if (t.seconds_from_creation != null && t.seconds_from_creation <= 1) firstBlockBuyers.add(t.wallet);
  }

  // Buyer rank per wallet (order-of-first-buy)
  const firstBuyOrder = new Map();
  let idx = 0;
  for (const t of buys) {
    if (!firstBuyOrder.has(t.wallet)) firstBuyOrder.set(t.wallet, ++idx);
  }
  const buyerRanks = [...firstBuyOrder.values()];

  // Seconds to N unique buyers
  let secsTo5 = null, secsTo10 = null;
  const seen = new Set();
  for (const t of buys) {
    if (!seen.has(t.wallet)) {
      seen.add(t.wallet);
      if (seen.size === 5 && secsTo5 == null) secsTo5 = t.seconds_from_creation;
      if (seen.size === 10 && secsTo10 == null) secsTo10 = t.seconds_from_creation;
    }
  }

  // % buyers in first 10 unique
  let pctIn10 = 0;
  if (uniqueBuyers > 0) {
    const first10 = Math.min(10, uniqueBuyers);
    pctIn10 = first10 / uniqueBuyers;
  }

  // Price reversal + run analysis
  let reversals = 0, longestUpPct = 0, longestDownPct = 0;
  if (trades.length >= 3) {
    let prevDir = 0, runStart = trades[0].price_sol;
    for (let i = 1; i < trades.length; i++) {
      const p = trades[i].price_sol, prev = trades[i - 1].price_sol;
      if (!p || !prev) continue;
      const dir = p > prev ? 1 : (p < prev ? -1 : 0);
      if (dir !== 0 && prevDir !== 0 && dir !== prevDir) {
        reversals++;
        const pct = runStart > 0 ? (prev - runStart) / runStart : 0;
        if (prevDir > 0 && pct > longestUpPct) longestUpPct = pct;
        if (prevDir < 0 && pct < longestDownPct) longestDownPct = pct;
        runStart = prev;
      }
      if (dir !== 0) prevDir = dir;
    }
  }

  // 30s window stats — sliding maxes
  let max30Buy = 0, max30BuyCount = 0, max30Sell = 0, max30SellCount = 0, max30UniqueSellers = 0;
  let max30BuySellRatio = 0;
  for (let i = 0; i < trades.length; i++) {
    const winStart = trades[i].timestamp;
    const winEnd = winStart + 30_000;
    let bSol = 0, bN = 0, sSol = 0, sN = 0;
    const sellerSet = new Set();
    for (let j = i; j < trades.length && trades[j].timestamp <= winEnd; j++) {
      if (trades[j].is_buy) { bSol += trades[j].sol_amount; bN++; }
      else { sSol += trades[j].sol_amount; sN++; sellerSet.add(trades[j].wallet); }
    }
    if (bSol > max30Buy) max30Buy = bSol;
    if (bN > max30BuyCount) max30BuyCount = bN;
    if (sSol > max30Sell) max30Sell = sSol;
    if (sN > max30SellCount) max30SellCount = sN;
    if (sellerSet.size > max30UniqueSellers) max30UniqueSellers = sellerSet.size;
    const ratio = sSol > 0 ? bSol / sSol : (bSol > 0 ? 99 : 0);
    if (ratio > max30BuySellRatio) max30BuySellRatio = ratio;
  }

  // Pressure window (last 60s of the window)
  const pressureStart = cutoffMs - 60_000;
  let pBuys = 0, pSells = 0, pBuySol = 0, pSellSol = 0;
  for (const t of trades) {
    if (t.timestamp < pressureStart) continue;
    if (t.is_buy) { pBuys++; pBuySol += t.sol_amount; }
    else { pSells++; pSellSol += t.sol_amount; }
  }
  const pressure60BuyPct = (pBuys + pSells) > 0 ? pBuys / (pBuys + pSells) : 0;
  const pressure60Net = pBuySol - pSellSol;

  // Inflow / count acceleration: compare last 30s vs prior 30s
  const midT = cutoffMs - 30_000;
  let lateBuys = 0, lateBuySol = 0, earlyBuys = 0, earlyBuySol = 0;
  const earlyStart = midT - 30_000;
  for (const t of trades) {
    if (!t.is_buy) continue;
    if (t.timestamp >= midT) { lateBuys++; lateBuySol += t.sol_amount; }
    else if (t.timestamp >= earlyStart) { earlyBuys++; earlyBuySol += t.sol_amount; }
  }
  const inflowAccelPct = earlyBuySol > 0 ? (lateBuySol - earlyBuySol) / earlyBuySol : 0;
  const buyCountAccelPct = earlyBuys > 0 ? (lateBuys - earlyBuys) / earlyBuys : 0;

  // Top10 buyer timing std (seconds among top-10 wallets by buy sol)
  const sortedBuyers = [...buyerWallets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const top10Wallets = new Set(sortedBuyers.map((e) => e[0]));
  const top10Times = [];
  for (const t of buys) {
    if (top10Wallets.has(t.wallet) && t.seconds_from_creation != null) {
      top10Times.push(t.seconds_from_creation);
    }
  }
  const top10TimingStd = stddev(top10Times);

  // Creator stats
  const creator = s.creatorStats.get(mint.created_at, mint.creator_wallet);
  const launches = (creator?.launches || 1) - 1; // exclude self
  const migrated = creator?.migrated || 0;
  const lastBefore = creator?.last_before || 0;
  const secsSincePrev = lastBefore > 0 ? Math.floor((mint.created_at - lastBefore) / 1000) : -1;
  const siblings = s.creatorSiblings.get(
    mint.creator_wallet,
    mint.created_at - 3600 * 1000,
    mint.created_at + 3600 * 1000,
    mint.mint_address,
  );

  // Creator's own activity post-launch (in window)
  const creatorTrades = trades.filter((t) => t.wallet === mint.creator_wallet);
  const creatorBuys = creatorTrades.filter((t) => t.is_buy === 1).length;
  const creatorSells = creatorTrades.filter((t) => t.is_buy === 0).length;

  // Last price + mcap at the cutoff (use most recent trade if available)
  const lastTrade = trades.length ? trades[trades.length - 1] : null;
  const lastPrice = lastTrade?.price_sol || mint.last_price_sol || 0;
  const PUMP_SUPPLY = 1_000_000_000;
  const lastMcap = lastPrice > 0 ? lastPrice * PUMP_SUPPLY : 0;
  const peakMcap = Math.max(mint.peak_market_cap_sol || 0, lastMcap);

  // SOL inflow / outflow
  const solInflow = buyAmts.reduce((s, v) => s + v, 0);
  const solOutflow = sellAmts.reduce((s, v) => s + v, 0);

  // Volatility: stddev of consecutive price % changes
  let volatilityPct = 0;
  if (trades.length >= 3) {
    const rets = [];
    for (let i = 1; i < trades.length; i++) {
      const p = trades[i].price_sol, prev = trades[i - 1].price_sol;
      if (p > 0 && prev > 0) rets.push((p - prev) / prev);
    }
    volatilityPct = stddev(rets);
  }

  // ============= WALLET SKILL FEATURES =============
  // Pull skill scores for every buyer/seller we've seen. Only count wallets
  // that pass the smart-money filters (no high-freq bots, no flippers, profitable).
  const buyerSkills = [];
  const buyerHoldSecs = [];
  let smartBuyerCount = 0;
  let whaleBuyerCount = 0;
  for (const wallet of buyerWallets.keys()) {
    const stat = s.walletStat.get(wallet);
    if (!stat) continue;
    if (stat.is_high_freq || stat.is_flipper || stat.is_unprofitable) continue;
    if (stat.skill_score != null) {
      buyerSkills.push(stat.skill_score);
      if (stat.skill_score >= 2) smartBuyerCount++;
      if (stat.skill_score >= 5) whaleBuyerCount++;
    }
    if (stat.median_hold_sec != null) buyerHoldSecs.push(stat.median_hold_sec);
  }
  const sellerSkills = [];
  let smartSellerCount = 0;
  for (const wallet of sellerWallets.keys()) {
    const stat = s.walletStat.get(wallet);
    if (!stat) continue;
    if (stat.is_high_freq || stat.is_flipper || stat.is_unprofitable) continue;
    if (stat.skill_score != null) {
      sellerSkills.push(stat.skill_score);
      if (stat.skill_score >= 2) smartSellerCount++;
    }
  }
  const topBuyerSkillP90 = p90(buyerSkills);
  const topSellerSkillP90 = p90(sellerSkills);
  const avgBuyerHoldSec = buyerHoldSecs.length
    ? buyerHoldSecs.reduce((s, v) => s + v, 0) / buyerHoldSecs.length
    : 0;
  // ============= END WALLET SKILL =============

  const createdDate = new Date(mint.created_at);
  const hasTwitter = mint.twitter ? 1 : 0;
  const hasTelegram = mint.telegram ? 1 : 0;
  const hasWebsite = mint.website ? 1 : 0;

  return {
    snapshot_age_sec: ageSec,
    initial_buy_sol: mint.initial_buy_sol || 0,
    creator_launch_count: launches,
    creator_migrated_count: migrated,
    has_twitter: hasTwitter, has_telegram: hasTelegram, has_website: hasWebsite,
    name_length: (mint.name || '').length,
    symbol_length: (mint.symbol || '').length,
    created_hour_utc: createdDate.getUTCHours(),
    created_dow: createdDate.getUTCDay(),
    last_price_sol: lastPrice,
    last_mcap_sol: lastMcap,
    peak_mcap_sol_so_far: peakMcap,
    v_sol_in_curve: mint.v_sol_in_curve || 0,
    sol_inflow: solInflow,
    sol_outflow: solOutflow,
    buy_count: buys.length,
    sell_count: sells.length,
    buy_sell_ratio: sells.length > 0 ? buys.length / sells.length : (buys.length > 0 ? 99 : 0),
    unique_buyers: uniqueBuyers,
    // Wallet-label features default to 0: we don't have labels yet.
    tracked_buyers: 0, kol_buyers: 0, bundle_buyers: 0,
    top10_buyers: Math.min(10, uniqueBuyers),
    top50_buyers: Math.min(50, uniqueBuyers),
    weighted_buyer_quality: 0,
    avg_buy_sol: buyAmts.length ? buyAmts.reduce((s, v) => s + v, 0) / buyAmts.length : 0,
    median_buy_sol: median(buyAmts),
    p90_buy_sol: p90(buyAmts),
    max_buy_sol: buyAmts.length ? Math.max(...buyAmts) : 0,
    std_buy_sol: stddev(buyAmts),
    avg_sell_sol: sellAmts.length ? sellAmts.reduce((s, v) => s + v, 0) / sellAmts.length : 0,
    median_sell_sol: median(sellAmts),
    p90_sell_sol: p90(sellAmts),
    max_sell_sol: sellAmts.length ? Math.max(...sellAmts) : 0,
    std_sell_sol: stddev(sellAmts),
    top1_buyer_sol_pct: topNPct(buyerVols, 1),
    top3_buyer_sol_pct: topNPct(buyerVols, 3),
    top5_buyer_sol_pct: topNPct(buyerVols, 5),
    buyer_hhi: hhi(buyerVols),
    top1_seller_sol_pct: topNPct(sellerVols, 1),
    top3_seller_sol_pct: topNPct(sellerVols, 3),
    top5_seller_sol_pct: topNPct(sellerVols, 5),
    seller_hhi: hhi(sellerVols),
    sniper_buyer_count: sniperBuyers.size,
    pct_sniper_buys: buys.length > 0 ? sniperBuyers.size / buys.length : 0,
    first_block_buyer_count: firstBlockBuyers.size,
    pct_first_block_buys: buys.length > 0 ? firstBlockBuyers.size / buys.length : 0,
    avg_buyer_rank: buyerRanks.length ? buyerRanks.reduce((s, v) => s + v, 0) / buyerRanks.length : 0,
    median_buyer_rank: median(buyerRanks),
    pct_buyers_in_first_10: pctIn10,
    // KOL labels missing — null
    tracked_first_seen_sec: -1, kol_first_seen_sec: -1,
    seconds_to_5_unique_buyers: secsTo5 ?? -1,
    seconds_to_10_unique_buyers: secsTo10 ?? -1,
    n_reversals_in_window: reversals,
    longest_up_run_pct: longestUpPct,
    longest_down_run_pct: longestDownPct,
    max_30s_buy_sol: max30Buy,
    max_30s_buy_count: max30BuyCount,
    max_30s_buy_sell_ratio: max30BuySellRatio,
    creator_buys_post_launch: creatorBuys,
    creator_sells_post_launch: creatorSells,
    // Sidewallet / linked wallet features default 0 (no cluster analysis yet)
    creator_sol_to_sidewallets: 0,
    creator_sidewallet_buyer_count: 0,
    inflow_accel_pct: inflowAccelPct,
    buy_count_accel_pct: buyCountAccelPct,
    top10_buy_timing_std_sec: top10TimingStd,
    max_30s_sell_sol: max30Sell,
    max_30s_sell_count: max30SellCount,
    max_30s_unique_sellers: max30UniqueSellers,
    creator_recent_launch_siblings: siblings?.n || 0,
    // Trend / narrative / sentiment features default 0 (no signal pipeline yet)
    trend_signal_match: 0, narrative_match_count: 0,
    pressure_60_buy_pct: pressure60BuyPct,
    pressure_60_net: pressure60Net,
    telegram_member_count: 0,
    // HHI delta needs prior snapshot — left 0 (will be computed if we go multi-age)
    buyer_hhi_delta: 0, seller_hhi_delta: 0,
    // Bot vs human classification needs a labeler — default 0
    bot_sniper_buyer_count: 0,
    fast_human_sniper_count: sniperBuyers.size, // best-effort: assume sniper = human if not flagged bot
    seconds_since_prev_creator_death: secsSincePrev,
    trade_count: trades.length,
    trades_per_min: ageSec > 0 ? (trades.length / ageSec) * 60 : 0,
    volatility_pct: volatilityPct,
    sandwich_risk: 0,
    reaction_speed_ms: 0,
    rpc_latency_p90_ms: 0,
    priority_fee_p90: 0,
    network_status: 'unknown',
    migrated: mint.migrated || 0,
    // wallet-skill features (2026-05-28)
    top_buyer_skill_p90: topBuyerSkillP90,
    smart_buyer_count: smartBuyerCount,
    whale_buyer_count: whaleBuyerCount,
    avg_buyer_hold_sec: avgBuyerHoldSec,
    top_seller_skill_p90: topSellerSkillP90,
    smart_seller_count: smartSellerCount,
    snapshot_ts: Date.now(),
  };
}

function snapshotMintAtAge(mint, ageSec) {
  const feats = computeFeatures(mint, ageSec);
  const values = [mint.mint_address, ...FEATURE_COLS.map((c) => feats[c] ?? null)];
  try {
    getInsertStmt().run(...values);
    return true;
  } catch (e) {
    console.error(`[snap] insert err ${mint.mint_address.slice(0, 8)}… age=${ageSec}: ${e.message}`);
    return false;
  }
}

function runWorkerOnce() {
  const s = S();
  const now = Date.now();
  const maxAgeMs = (AGES_TO_CAPTURE[AGES_TO_CAPTURE.length - 1] + TARGET_AGE_WINDOW_S) * 1000;
  // Only consider mints created during this process's lifetime — we won't have
  // trade data from before logs-sub started.
  // 2026-05-26: removed bornAt floor — we have trade data for any recent mint
  // regardless of when the worker started.
  const lowerBound = now - maxAgeMs;
  // And exclude mints too young to have crossed any age threshold.
  const upperBound = now - AGES_TO_CAPTURE[0] * 1000;
  if (lowerBound > upperBound) return { mints: 0, snaps: 0 };

  const mints = s.candidateMints.all(lowerBound, upperBound);
  let snapsTaken = 0;
  for (const mint of mints) {
    const ageNow = (now - mint.created_at) / 1000;
    const existing = s.existingAges.all(mint.mint_address).map((r) => r.snapshot_age_sec);
    for (const targetAge of AGES_TO_CAPTURE) {
      if (existing.includes(targetAge)) continue;
      if (ageNow < targetAge) continue;
      // Skip if we missed the capture window — feature freshness matters,
      // backfilling a 60s snapshot for a 10-min-old mint isn't useful.
      if (ageNow > targetAge + TARGET_AGE_WINDOW_S) continue;
      if (snapshotMintAtAge(mint, targetAge)) snapsTaken++;
    }
  }
  return { mints: mints.length, snaps: snapsTaken };
}

export function startSnapshotWorker() {
  setBornAt();
  console.log('[snap] worker armed · capturing ages', AGES_TO_CAPTURE.join('/'), 's');
  setInterval(() => {
    try {
      const r = runWorkerOnce();
      if (r.snaps > 0) console.log(`[snap] swept ${r.mints} fresh mints · ${r.snaps} new snapshots`);
    } catch (e) {
      console.error('[snap] worker err:', e.stack || e.message);
    }
  }, WORKER_INTERVAL_MS);
}
