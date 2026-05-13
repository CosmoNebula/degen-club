// ML Snapshot Sweeper — captures forward-looking training data.
//
// Every 10s, finds mints whose age falls within a per-target tolerance band of
// a TARGET age (15s, 30s, 60s, 2m, 5m, 10m, 15m, 30m, 60m) and that haven't
// been snapshotted at that target yet. For each, computes ~90 features from
// data available at that exact moment and writes a row to ml_mint_snapshots.
// Labels (migrated, peaked_N, hold_24h_pct, etc.) get filled in later by the
// label resolver once the mint's trajectory has played out.
//
// Phase 2B (2026-05-12): expanded from 4 to 9 target ages with per-target
// tolerance + 10s sweep cadence. Earlier 30s sweep + ±30s tolerance was fine
// for 60s+ targets but couldn't reliably catch sub-30s windows. Sub-minute
// targets capture pump.fun's competitive launch dynamics — sniper bots,
// first-block buys, KOL discovery — that the 60s baseline blurs over.

import { db } from '../db/index.js';
import { maybeFetchCreatorActivity, getCreatorActivity } from './creator-activity.js';

// Each entry: { age: target snapshot age in sec, tolerance: ±sec window }.
// Tolerance widens with age — early windows must be tight to avoid overlap
// between adjacent ages (e.g., 15 vs 30); older windows can be lazier because
// nothing else competes nearby. Bands are non-overlapping by design.
const TARGETS = [
  { age: 15,   tolerance: 7   },
  { age: 30,   tolerance: 7   },
  { age: 60,   tolerance: 15  },
  { age: 120,  tolerance: 30  },
  { age: 300,  tolerance: 30  },
  { age: 600,  tolerance: 60  },
  { age: 900,  tolerance: 60  },
  { age: 1800, tolerance: 120 },
  { age: 3600, tolerance: 300 },
];
const SWEEP_INTERVAL_MS = 10 * 1000;

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
             t.is_sniper, t.is_first_block, t.buyer_rank, t.seconds_from_creation,
             COALESCE(w.tracked, 0) AS tracked, COALESCE(w.is_kol, 0) AS is_kol,
             COALESCE(w.bundle_cluster_id, '') AS bundle_id,
             wl.rank AS leaderboard_rank
      FROM trades t
      LEFT JOIN wallets w ON w.address = t.wallet
      LEFT JOIN wallet_leaderboard wl ON wl.address = t.wallet
      WHERE t.mint_address = ? AND t.timestamp <= ? ORDER BY t.timestamp ASC
    `),
    // Creator self-trades on THIS mint (Tier 2 #3). Cheap aggregation off
    // the trades table — captures dev support/dump from their main wallet.
    creatorSelfTrades: d.prepare(`
      SELECT
        SUM(CASE WHEN is_buy = 1 THEN 1 ELSE 0 END) AS buys,
        SUM(CASE WHEN is_buy = 0 THEN 1 ELSE 0 END) AS sells
      FROM trades
      WHERE mint_address = ? AND wallet = ? AND timestamp <= ?
    `),
    // Creator heat-map (Tier 3 #7): count of OTHER mints by the same creator
    // in the hour before this one. Mass-launchers split attention and rarely
    // push any single mint to migration.
    creatorRecentLaunches: d.prepare(`
      SELECT COUNT(*) AS n FROM mints
      WHERE creator_wallet = ?
        AND mint_address != ?
        AND created_at < ?
        AND created_at >= ?
    `),
    // Trend signal match (Tier 4 #1): is this mint's symbol in trend_signals
    // in the last 4h? Geckoterminal keywords come as "SYMBOL / SOL"; Reddit
    // mentions come as bare "$SYMBOL". LIKE handles both: "%SYMBOL%".
    trendSignalMatch: d.prepare(`
      SELECT COUNT(*) AS n FROM trend_signals
      WHERE ts >= ? AND UPPER(keyword) LIKE '%' || UPPER(?) || '%'
    `),
    // Narrative match (Tier 4 #2): count of distinct news_items keywords in
    // the last 4h that appear as substrings of the mint's name+symbol+description.
    // Done in JS (this stmt just returns the raw keyword set; we do the
    // substring match locally to handle case + array unwrapping cleanly).
    recentNewsKeywords: d.prepare(`
      SELECT keywords FROM news_items
      WHERE ts >= ? AND keywords IS NOT NULL AND keywords != '[]'
    `),
    // Real-time pressure (Tier 4 #4): buy/sell distribution over the LAST 60
    // trades regardless of timeframe. Lag-eliminator vs 60s-bucketed window.
    pressure60: d.prepare(`
      SELECT
        SUM(is_buy) AS buys,
        COUNT(*) AS total
      FROM (
        SELECT is_buy FROM trades
        WHERE mint_address = ? AND timestamp <= ?
        ORDER BY timestamp DESC LIMIT 60
      )
    `),
    // Telegram member count cache (Tier 4 #5).
    telegramMemberCount: d.prepare(`
      SELECT member_count FROM telegram_members
      WHERE mint_address = ? AND fetch_status = 'ok'
    `),
    // Tier 5 #3 — previous (younger) snapshot of this mint, for d/dt HHI.
    // Picks the youngest snapshot strictly newer than this one's age (e.g.,
    // for a 300s snapshot, fetches the 60s one). If none exists, returns
    // nothing and the deltas are NULL.
    prevSnapshotForHhi: d.prepare(`
      SELECT buyer_hhi, seller_hhi FROM ml_mint_snapshots
      WHERE mint_address = ? AND snapshot_age_sec < ?
      ORDER BY snapshot_age_sec DESC LIMIT 1
    `),
    // Tier 5 #5 — creator's most recent PRIOR mint that has stopped trading
    // (last_trade_at set, before this mint's creation). Used to compute
    // seconds_since_prev_creator_death.
    creatorPrevDeath: d.prepare(`
      SELECT last_trade_at FROM mints
      WHERE creator_wallet = ?
        AND mint_address != ?
        AND created_at < ?
        AND last_trade_at IS NOT NULL
        AND last_trade_at < ?
      ORDER BY last_trade_at DESC LIMIT 1
    `),
    // Phase C — sentiment for the mint in the current 4h window. Returns NULL
    // if no mention has landed yet, which the model handles natively (NaN).
    mintSentiment: d.prepare(`SELECT bull_mentions, bear_mentions, shill_mentions,
       total_mentions, sum_confidence
       FROM mint_sentiment WHERE mint_address = ? AND window_start = ?`),
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
      top10_buyers, top50_buyers, weighted_buyer_quality,
      avg_buy_sol, median_buy_sol, p90_buy_sol, max_buy_sol, std_buy_sol,
      avg_sell_sol, median_sell_sol, p90_sell_sol, max_sell_sol, std_sell_sol,
      top1_buyer_sol_pct, top3_buyer_sol_pct, top5_buyer_sol_pct, buyer_hhi,
      top1_seller_sol_pct, top3_seller_sol_pct, top5_seller_sol_pct, seller_hhi,
      sniper_buyer_count, pct_sniper_buys, first_block_buyer_count, pct_first_block_buys,
      avg_buyer_rank, median_buyer_rank, pct_buyers_in_first_10,
      tracked_first_seen_sec, kol_first_seen_sec,
      seconds_to_5_unique_buyers, seconds_to_10_unique_buyers,
      n_reversals_in_window, longest_up_run_pct, longest_down_run_pct,
      max_30s_buy_sol, max_30s_buy_count, max_30s_buy_sell_ratio,
      creator_buys_post_launch, creator_sells_post_launch,
      creator_sol_to_sidewallets, creator_sidewallet_buyer_count,
      inflow_accel_pct, buy_count_accel_pct, top10_buy_timing_std_sec,
      max_30s_sell_sol, max_30s_sell_count, max_30s_unique_sellers,
      creator_recent_launch_siblings,
      trend_signal_match, narrative_match_count,
      pressure_60_buy_pct, pressure_60_net,
      telegram_member_count,
      buyer_hhi_delta, seller_hhi_delta,
      bot_sniper_buyer_count, fast_human_sniper_count,
      seconds_since_prev_creator_death,
      trade_count, trades_per_min, volatility_pct, sandwich_risk, reaction_speed_ms,
      rpc_latency_p90_ms, priority_fee_p90, network_status,
      sentiment_bull_4h, sentiment_bear_4h, sentiment_shill_4h,
      sentiment_total_4h, sentiment_avg_confidence
    ) VALUES (${Array(98).fill('?').join(',')})`),
  };
  return stmts;
}

// Price-reversal + run-length stats from a chronological price series.
// A "reversal" is a direction flip (up→down or down→up). Trending mints
// have low reversal counts; choppy mints have many. Combined with the run
// lengths, gives the model a structural read on price action beyond raw stdev.
//
// Implementation: walk the trade sequence; track the current direction
// (1 = up, -1 = down, 0 = unchanged). When direction changes (and is non-zero),
// increment reversal count. Track the longest contiguous up-move and down-move
// (as pct of entry price = first trade in the window).
function reversalStats(trades) {
  // Need at least 3 trades to have a meaningful reversal (any flip)
  let usable = 0;
  let lastPrice = null;
  for (const t of trades) {
    const p = t.price_sol;
    if (p == null || p <= 0) continue;
    if (lastPrice !== p) usable++;
    lastPrice = p;
    if (usable >= 3) break;
  }
  if (usable < 3) return { reversals: null, longestUpPct: null, longestDownPct: null };

  let firstPrice = null;
  let prevPrice = null;
  let direction = 0; // -1 down, 0 flat, +1 up
  let reversals = 0;
  let curRunStart = null;     // price at start of current monotonic run
  let curRunDirection = 0;
  let longestUp = 0;          // absolute pct gain of longest contiguous up-run
  let longestDown = 0;        // absolute pct loss of longest contiguous down-run

  for (const t of trades) {
    const p = t.price_sol;
    if (p == null || p <= 0) continue;
    if (firstPrice === null) {
      firstPrice = p;
      prevPrice = p;
      curRunStart = p;
      continue;
    }
    if (p === prevPrice) continue; // flat tick — keep current direction
    const nextDir = p > prevPrice ? 1 : -1;
    if (direction === 0) {
      direction = nextDir;
      curRunDirection = nextDir;
      curRunStart = prevPrice;
    } else if (nextDir !== direction) {
      // direction flipped — finalize the just-ended run, count reversal
      reversals++;
      if (curRunDirection === 1) {
        const runPct = (prevPrice - curRunStart) / curRunStart;
        if (runPct > longestUp) longestUp = runPct;
      } else if (curRunDirection === -1) {
        const runPct = (curRunStart - prevPrice) / curRunStart;
        if (runPct > longestDown) longestDown = runPct;
      }
      curRunStart = prevPrice;
      curRunDirection = nextDir;
      direction = nextDir;
    }
    prevPrice = p;
  }
  // Finalize the LAST run (it didn't reverse, so it wasn't counted above)
  if (curRunDirection === 1 && prevPrice != null && curRunStart != null) {
    const runPct = (prevPrice - curRunStart) / curRunStart;
    if (runPct > longestUp) longestUp = runPct;
  } else if (curRunDirection === -1 && prevPrice != null && curRunStart != null) {
    const runPct = (curRunStart - prevPrice) / curRunStart;
    if (runPct > longestDown) longestDown = runPct;
  }

  return {
    reversals,
    longestUpPct: longestUp,
    longestDownPct: longestDown,
  };
}

// Narrative match — count of distinct trending keywords (from news_items in
// last 4h) that match this mint's name/symbol/description tokens. Each
// keywords value is a JSON array like ["trump","truth-social"]. We flatten
// across all recent items, dedupe, then count substring hits in the mint's
// haystack. Returns 0 if mint has no name/symbol text.
function countNarrativeMatches(mint, keywordsRows) {
  const haystack = ((mint.name || '') + ' ' + (mint.symbol || '') + ' ' + (mint.description || '')).toLowerCase();
  if (!haystack.trim()) return 0;
  const seen = new Set();
  for (const row of keywordsRows) {
    let arr;
    try { arr = JSON.parse(row.keywords || '[]'); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const kw of arr) {
      if (typeof kw !== 'string') continue;
      const k = kw.toLowerCase().trim();
      if (k.length < 3) continue;  // skip 1-2 char fragments
      seen.add(k);
    }
  }
  let matches = 0;
  for (const kw of seen) if (haystack.includes(kw)) matches++;
  return matches;
}

// Volume momentum: split the snapshot window in two equal halves by time, sum
// inflow + buy_count in each, compare. Returns NULL halves if first half is
// empty (model handles NaN). Positive = accelerating; negative = decelerating.
//   inflow_accel_pct  = (h2.sol - h1.sol) / max(h1.sol, ε)
//   buy_count_accel_pct = (h2.count - h1.count) / max(h1.count, 1)
// Why two halves vs more buckets: with 60s windows (smallest snapshot age),
// even halves can be sparse. Two halves is the cleanest signal at every age.
function velocityStats(trades, snapshotTs, ageSec) {
  if (!trades || trades.length === 0 || !ageSec) {
    return { inflowAccelPct: null, buyCountAccelPct: null };
  }
  const midpointMs = snapshotTs - (ageSec * 1000) / 2;
  let h1Sol = 0, h2Sol = 0;
  let h1Buys = 0, h2Buys = 0;
  for (const t of trades) {
    if (t.is_buy !== 1) continue;
    const isSecondHalf = t.timestamp >= midpointMs;
    const amt = t.sol_amount || 0;
    if (isSecondHalf) { h2Sol += amt; h2Buys++; }
    else { h1Sol += amt; h1Buys++; }
  }
  // If first half is empty, treat that as "starting from zero" — cap at +1.0
  // (a full doubling) to avoid Infinity. NULL only on completely-empty windows.
  if (h1Buys === 0 && h2Buys === 0) {
    return { inflowAccelPct: null, buyCountAccelPct: null };
  }
  const inflowAccel = h1Sol > 0 ? (h2Sol - h1Sol) / h1Sol : (h2Sol > 0 ? 1.0 : 0);
  const buyCountAccel = h1Buys > 0 ? (h2Buys - h1Buys) / h1Buys : (h2Buys > 0 ? 1.0 : 0);
  return { inflowAccelPct: inflowAccel, buyCountAccelPct: buyCountAccel };
}

// Top-10 wallet buy timing: std of buy timestamps (in seconds) for trades
// where buyer's leaderboard rank ≤ 10. Synchronized buys (low std) = coordinated
// pump; spread (high std) = organic. NULL if fewer than 3 top-10 buys.
function top10TimingStats(top10BuyTimestamps) {
  const n = top10BuyTimestamps.length;
  if (n < 3) return { top10TimingStdSec: null };
  let sum = 0;
  for (const t of top10BuyTimestamps) sum += t;
  const mean = sum / n;
  let varSum = 0;
  for (const t of top10BuyTimestamps) { const d = t - mean; varSum += d * d; }
  const stdMs = Math.sqrt(varSum / n);
  return { top10TimingStdSec: stdMs / 1000 };
}

// Sell-side burst stats — mirror of burst30sStats but on sells. The
// max-unique-sellers signal is the key discriminator: many sells from FEW
// wallets = single whale exit; many sells from MANY distinct wallets =
// coordinated dump (rug-bait). Two-pointer rolling window over trades.
function sellBurst30sStats(trades) {
  if (!trades || trades.length === 0) {
    return { maxSellSol: null, maxSellCount: null, maxUniqueSellers: null };
  }
  const WINDOW_MS = 30 * 1000;
  let left = 0;
  let winSellSol = 0, winSellCount = 0;
  // Per-wallet sell count in the current window — used to track distinct
  // sellers without resorting to nested Sets. When a wallet's count drops
  // to 0, it leaves the unique-sellers tally.
  const winSellerCounts = new Map();
  let winUniqueSellers = 0;
  let maxSol = 0, maxCount = 0, maxUnique = 0;
  let sawAnySell = false;
  for (let right = 0; right < trades.length; right++) {
    const tr = trades[right];
    if (tr.is_buy === 0) {
      winSellSol += tr.sol_amount || 0;
      winSellCount++;
      sawAnySell = true;
      const wallet = tr.wallet || '__unknown__';
      const prev = winSellerCounts.get(wallet) || 0;
      if (prev === 0) winUniqueSellers++;
      winSellerCounts.set(wallet, prev + 1);
    }
    while (left <= right && (tr.timestamp - trades[left].timestamp) > WINDOW_MS) {
      const tl = trades[left];
      if (tl.is_buy === 0) {
        winSellSol -= tl.sol_amount || 0;
        winSellCount--;
        const wallet = tl.wallet || '__unknown__';
        const prev = winSellerCounts.get(wallet) || 0;
        if (prev === 1) winUniqueSellers--;
        winSellerCounts.set(wallet, prev - 1);
      }
      left++;
    }
    if (winSellSol > maxSol) maxSol = winSellSol;
    if (winSellCount > maxCount) maxCount = winSellCount;
    if (winUniqueSellers > maxUnique) maxUnique = winUniqueSellers;
  }
  if (!sawAnySell) {
    return { maxSellSol: 0, maxSellCount: 0, maxUniqueSellers: 0 };
  }
  return { maxSellSol: maxSol, maxSellCount: maxCount, maxUniqueSellers: maxUnique };
}

// Rolling 30-sec burst stats. Slides a 30s window over the chronological
// trade stream; tracks the peak (a) SOL inflow, (b) buy count, (c) buy/sell
// ratio observed in any window. Captures BURST shape: same total volume looks
// very different if it was one 30s rip vs. a steady trickle. Two-pointer walk
// in O(n) — trades are pre-sorted by timestamp ASC.
function burst30sStats(trades) {
  if (!trades || trades.length === 0) {
    return { maxSolInflow: null, maxBuyCount: null, maxBuySellRatio: null };
  }
  const WINDOW_MS = 30 * 1000;
  let left = 0;
  let winSol = 0, winBuy = 0, winSell = 0;
  let maxSol = 0, maxBuy = 0, maxRatio = 0;
  let sawAnyBuy = false;
  for (let right = 0; right < trades.length; right++) {
    const tr = trades[right];
    if (tr.is_buy === 1) {
      winSol += tr.sol_amount || 0;
      winBuy++;
      sawAnyBuy = true;
    } else {
      winSell++;
    }
    while (left <= right && (tr.timestamp - trades[left].timestamp) > WINDOW_MS) {
      const tl = trades[left];
      if (tl.is_buy === 1) {
        winSol -= tl.sol_amount || 0;
        winBuy--;
      } else {
        winSell--;
      }
      left++;
    }
    if (winSol > maxSol) maxSol = winSol;
    if (winBuy > maxBuy) maxBuy = winBuy;
    if (winBuy > 0) {
      const r = winSell > 0 ? (winBuy / winSell) : 99;
      if (r > maxRatio) maxRatio = r;
    }
  }
  return {
    maxSolInflow: maxSol,
    maxBuyCount: maxBuy,
    maxBuySellRatio: sawAnyBuy ? maxRatio : null,
  };
}

// Buyer-rank stats: averages rank across UNIQUE wallets (using each wallet's
// MIN observed rank) so repeat buyers don't artificially pull avg toward 1.
// Returns avg/median/pctInFirst10 OR all nulls if no ranked unique buyers.
function buyerRankStats(buyerFirstRank) {
  if (buyerFirstRank.size === 0) return { avgRank: null, medianRank: null, pctInFirst10: null };
  const ranks = [...buyerFirstRank.values()].sort((a, b) => a - b);
  const n = ranks.length;
  let sum = 0;
  for (const r of ranks) sum += r;
  const avgRank = sum / n;
  const medianRank = n % 2 === 0
    ? (ranks[n / 2 - 1] + ranks[n / 2]) / 2
    : ranks[(n - 1) / 2];
  let inFirst10 = 0;
  for (const r of ranks) if (r <= 10) inFirst10++;
  return { avgRank, medianRank, pctInFirst10: inFirst10 / n };
}

// Concentration stats for a per-wallet sol-amount map. Returns top1/3/5
// share-of-total + Herfindahl index, or all nulls if the map is empty.
// HHI = sum of (wallet_share)², range [1/N, 1].
//   - 1.0 = one wallet did everything (max concentration)
//   - 1/N = N wallets contributed equally
function concentrationStats(walletSolMap, totalSol) {
  if (totalSol <= 0 || walletSolMap.size === 0) {
    return { top1Pct: null, top3Pct: null, top5Pct: null, hhi: null };
  }
  const sorted = [...walletSolMap.values()].sort((a, b) => b - a);
  const top1 = sorted[0] || 0;
  let top3 = 0; for (let i = 0; i < Math.min(3, sorted.length); i++) top3 += sorted[i];
  let top5 = 0; for (let i = 0; i < Math.min(5, sorted.length); i++) top5 += sorted[i];
  let hhi = 0;
  for (const v of sorted) {
    const share = v / totalSol;
    hhi += share * share;
  }
  return {
    top1Pct: top1 / totalSol,
    top3Pct: top3 / totalSol,
    top5Pct: top5 / totalSol,
    hhi,
  };
}

// Distribution stats for an array of trade SOL amounts. Returns avg/median/
// p90/max/std OR all nulls if empty. NULL is the right sentinel because
// HistGradientBoosting handles NaN natively as its own split — feeding 0
// would create train/serve skew (model trained on NaN, served fake 0).
function distStats(amounts) {
  const n = amounts.length;
  if (n === 0) return { avg: null, median: null, p90: null, max: null, std: null };
  const sorted = [...amounts].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  const avg = sum / n;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[(n - 1) / 2];
  const p90 = sorted[Math.min(n - 1, Math.floor(n * 0.9))];
  const max = sorted[n - 1];
  let varSum = 0;
  for (const v of sorted) { const d = v - avg; varSum += d * d; }
  const std = n > 1 ? Math.sqrt(varSum / n) : 0;
  return { avg, median, p90, max, std };
}

function computeAggregates(trades, ctx = {}) {
  if (!trades || trades.length === 0) {
    return {
      lastPrice: 0, lastMcap: 0, peakMcap: 0,
      solIn: 0, solOut: 0, buyCount: 0, sellCount: 0,
      buySellRatio: 0, uniqueBuyers: 0, trackedBuyers: 0,
      kolBuyers: 0, bundleBuyers: 0,
      top10Buyers: 0, top50Buyers: 0, weightedBuyerQuality: 0,
      sniperBuyerCount: 0, pctSniperBuys: null,
      firstBlockBuyerCount: 0, pctFirstBlockBuys: null,
      botSniperBuyerCount: 0, fastHumanSniperCount: 0,
      buyerRank: buyerRankStats(new Map()),
      trackedFirstSeenSec: null, kolFirstSeenSec: null,
      secondsTo5Buyers: null, secondsTo10Buyers: null,
      reversals: reversalStats([]),
      burst: burst30sStats([]),
      sellBurst: sellBurst30sStats([]),
      velocity: velocityStats([], ctx.snapshotTs || 0, ctx.ageSec || 0),
      top10Timing: top10TimingStats([]),
      tradeCount: 0,
      buyDist: distStats([]), sellDist: distStats([]),
      buyConc: concentrationStats(new Map(), 0),
      sellConc: concentrationStats(new Map(), 0),
    };
  }
  let solIn = 0, solOut = 0, buyCount = 0, sellCount = 0;
  let peakMcap = 0;
  let weightedBuyerQuality = 0;
  let sniperBuyTrades = 0, firstBlockBuyTrades = 0;
  // Time-to-first/N tracking. Trades are sorted by timestamp ASC, so the
  // first time we observe each condition is when it actually happened.
  let trackedFirstSeenSec = null, kolFirstSeenSec = null;
  let secondsTo5Buyers = null, secondsTo10Buyers = null;
  const buyers = new Set(), trackedBuyers = new Set(), kolBuyers = new Set(), bundleBuyers = new Set();
  const top10Buyers = new Set(), top50Buyers = new Set();
  const sniperBuyers = new Set(), firstBlockBuyers = new Set();
  // Tier 5 #4 — bot snipers (slot-1, is_first_block=1) vs fast humans
  // (is_sniper=1 AND is_first_block=0). Different cohort behaviors.
  const botSniperBuyers = new Set();
  const fastHumanSniperBuyers = new Set();
  const buyAmounts = [], sellAmounts = [];
  // Per-wallet sol totals (separately for buys and sells) — feeds whale
  // concentration stats. Each wallet may appear multiple times in the trade
  // stream; we sum their net buy/sell volumes individually.
  const buyerSolMap = new Map(), sellerSolMap = new Map();
  // Per-wallet first (min) buyer_rank — feeds buyer-rank stats. Aggregating
  // by unique wallet's earliest rank avoids repeat-buyer skew.
  const buyerFirstRank = new Map();
  // Top-10 buy timestamps for cluster-timing analysis. ALL buys by a top-10
  // wallet count (not just first), since the question is "are top-10 wallets
  // synchronized in their accumulation" not "when did the first top-10 enter."
  const top10BuyTimestamps = [];
  for (const t of trades) {
    if (t.market_cap_sol && t.market_cap_sol > peakMcap) peakMcap = t.market_cap_sol;
    const amt = t.sol_amount || 0;
    if (t.is_buy === 1) {
      solIn += amt;
      buyCount++;
      if (amt > 0) buyAmounts.push(amt);
      if (t.is_sniper === 1) sniperBuyTrades++;
      if (t.is_first_block === 1) firstBlockBuyTrades++;
      if (t.wallet) {
        const wasNewBuyer = !buyers.has(t.wallet);
        buyers.add(t.wallet);
        if (wasNewBuyer && typeof t.seconds_from_creation === 'number') {
          if (buyers.size === 5 && secondsTo5Buyers === null) secondsTo5Buyers = t.seconds_from_creation;
          if (buyers.size === 10 && secondsTo10Buyers === null) secondsTo10Buyers = t.seconds_from_creation;
        }
        if (amt > 0) buyerSolMap.set(t.wallet, (buyerSolMap.get(t.wallet) || 0) + amt);
        if (t.is_sniper === 1) sniperBuyers.add(t.wallet);
        if (t.is_first_block === 1) firstBlockBuyers.add(t.wallet);
        // Tier 5 #4 — bot (slot-1) vs fast-human (slot-2-5) split
        if (t.is_first_block === 1) botSniperBuyers.add(t.wallet);
        else if (t.is_sniper === 1) fastHumanSniperBuyers.add(t.wallet);
        if (typeof t.buyer_rank === 'number' && t.buyer_rank > 0) {
          const existing = buyerFirstRank.get(t.wallet);
          if (existing === undefined || t.buyer_rank < existing) {
            buyerFirstRank.set(t.wallet, t.buyer_rank);
          }
        }
        if (t.tracked === 1) {
          trackedBuyers.add(t.wallet);
          if (trackedFirstSeenSec === null && typeof t.seconds_from_creation === 'number') {
            trackedFirstSeenSec = t.seconds_from_creation;
          }
        }
        if (t.is_kol === 1) {
          kolBuyers.add(t.wallet);
          if (kolFirstSeenSec === null && typeof t.seconds_from_creation === 'number') {
            kolFirstSeenSec = t.seconds_from_creation;
          }
        }
        if (t.bundle_id) bundleBuyers.add(t.wallet);
        const rank = t.leaderboard_rank;
        // Count each top-50 buyer once. Weight = 51 - rank, so rank 1 = 50pts,
        // rank 50 = 1pt. Sum across distinct top-50 buyers.
        if (rank && rank > 0 && rank <= 50 && !top50Buyers.has(t.wallet)) {
          top50Buyers.add(t.wallet);
          if (rank <= 10) top10Buyers.add(t.wallet);
          weightedBuyerQuality += (51 - rank);
        }
        // Every top-10 buy gets its timestamp recorded — feeds top10TimingStats.
        // Multiple buys from the same top-10 wallet all count toward "are they
        // accumulating together?" pattern detection.
        if (rank && rank > 0 && rank <= 10) {
          top10BuyTimestamps.push(t.timestamp);
        }
      }
    } else {
      solOut += amt;
      sellCount++;
      if (amt > 0) sellAmounts.push(amt);
      if (t.wallet && amt > 0) sellerSolMap.set(t.wallet, (sellerSolMap.get(t.wallet) || 0) + amt);
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
    top10Buyers: top10Buyers.size,
    top50Buyers: top50Buyers.size,
    weightedBuyerQuality,
    tradeCount: buyCount + sellCount,
    buyDist: distStats(buyAmounts),
    sellDist: distStats(sellAmounts),
    buyConc: concentrationStats(buyerSolMap, solIn),
    sellConc: concentrationStats(sellerSolMap, solOut),
    sniperBuyerCount: sniperBuyers.size,
    pctSniperBuys: buyCount > 0 ? sniperBuyTrades / buyCount : null,
    firstBlockBuyerCount: firstBlockBuyers.size,
    pctFirstBlockBuys: buyCount > 0 ? firstBlockBuyTrades / buyCount : null,
    botSniperBuyerCount: botSniperBuyers.size,
    fastHumanSniperCount: fastHumanSniperBuyers.size,
    buyerRank: buyerRankStats(buyerFirstRank),
    trackedFirstSeenSec,
    kolFirstSeenSec,
    secondsTo5Buyers,
    secondsTo10Buyers,
    reversals: reversalStats(trades),
    burst: burst30sStats(trades),
    sellBurst: sellBurst30sStats(trades),
    velocity: velocityStats(trades, ctx.snapshotTs || 0, ctx.ageSec || 0),
    top10Timing: top10TimingStats(top10BuyTimestamps),
  };
}

function takeSnapshot(mint, target, snapshotTs) {
  const s = S();
  const trades = s.tradesUpTo.all(mint.mint_address, snapshotTs);
  const agg = computeAggregates(trades, { snapshotTs, ageSec: target });
  const creatorStats = s.creatorStats.get(mint.creator_wallet || '', mint.created_at, mint.creator_wallet || '', mint.created_at);
  const creatorSelf = mint.creator_wallet
    ? s.creatorSelfTrades.get(mint.mint_address, mint.creator_wallet, snapshotTs)
    : { buys: 0, sells: 0 };
  // Sidewallet stats come from the async parse-API worker. NULL on first
  // sight (worker hadn't landed yet); label resolver / backfill can populate
  // later snapshots from the cache once available.
  const creatorActivity = mint.creator_wallet
    ? getCreatorActivity(mint.mint_address)
    : null;
  // Trigger creator-activity fetch at age=60s — but ONLY when the mint shows
  // ≥2 tracked-wallet buyers. Each parse-history call costs 100 Helius credits
  // (we learned this the expensive way on 2026-05-11 after burning 102k credits
  // / 1k calls in 12h). Without a gate, the unbounded volume would consume
  // ~75% of monthly budget on a signal that produced 8 cross-matches in 965
  // fetches. The tracked>=2 gate concentrates on coordinated smart-money
  // launches — exactly the population where dev-side shenanigans matter.
  // creator-activity.js also enforces a 24h rolling fetch cap as a hard ceiling.
  if (target === 60 && mint.creator_wallet && agg.trackedBuyers >= 2) {
    maybeFetchCreatorActivity(mint.mint_address);
  }
  // Tier 3 #7 — count of OTHER mints by this creator launched in the hour
  // BEFORE this mint. Pure SQL lookup; 0 cost. Returns NULL if no creator.
  const creatorSiblingCount = mint.creator_wallet
    ? (s.creatorRecentLaunches.get(
        mint.creator_wallet,
        mint.mint_address,
        mint.created_at,
        mint.created_at - 3600 * 1000,
      )?.n ?? null)
    : null;

  // Tier 4 #1 — trend signal match. Skip if mint has no symbol.
  const trendWindowMs = snapshotTs - 4 * 3600 * 1000;
  const trendSignalMatch = mint.symbol
    ? ((s.trendSignalMatch.get(trendWindowMs, mint.symbol)?.n ?? 0) > 0 ? 1 : 0)
    : null;
  // Tier 4 #2 — narrative match count. Pull recent news keywords, count
  // overlaps with mint's name+symbol+description.
  const newsKwRows = s.recentNewsKeywords.all(trendWindowMs);
  const narrativeMatchCount = countNarrativeMatches(mint, newsKwRows);
  // Tier 4 #4 — real-time pressure over last 60 trades. NULL if <5 trades.
  const p60 = s.pressure60.get(mint.mint_address, snapshotTs);
  const p60Total = p60?.total || 0;
  const p60Buys = p60?.buys || 0;
  const pressureBuyPct = p60Total >= 5 ? p60Buys / p60Total : null;
  const pressureNet = p60Total >= 5 ? (p60Buys - (p60Total - p60Buys)) / p60Total : null;
  // Tier 4 #5 — Telegram member count from cache (worker populates async).
  const tgRow = s.telegramMemberCount.get(mint.mint_address);
  const telegramMemberCount = tgRow?.member_count ?? null;

  // Tier 5 #3 — d/dt HHI. Look up the most recent younger snapshot of this
  // mint; delta = current HHI minus previous HHI. NULL on first (60s)
  // snapshot or on absent values.
  const prevHhi = target > 60 ? s.prevSnapshotForHhi.get(mint.mint_address, target) : null;
  const currBuyerHhi = agg.buyConc?.hhi;
  const currSellerHhi = agg.sellConc?.hhi;
  const buyerHhiDelta = (prevHhi?.buyer_hhi != null && currBuyerHhi != null)
    ? currBuyerHhi - prevHhi.buyer_hhi : null;
  const sellerHhiDelta = (prevHhi?.seller_hhi != null && currSellerHhi != null)
    ? currSellerHhi - prevHhi.seller_hhi : null;

  // Tier 5 #5 — seconds since the creator's previous mint died. NULL if
  // first mint by creator or no prior death recorded.
  let secondsSincePrevCreatorDeath = null;
  if (mint.creator_wallet) {
    const prev = s.creatorPrevDeath.get(
      mint.creator_wallet,
      mint.mint_address,
      mint.created_at,
      mint.created_at,
    );
    if (prev?.last_trade_at) {
      secondsSincePrevCreatorDeath = Math.max(0, (mint.created_at - prev.last_trade_at) / 1000);
    }
  }
  const ms = s.microstructure.get(mint.mint_address);
  const lc = s.latestConditions.get();
  // Phase C — current-4h sentiment for this mint (NULL if no mentions yet).
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const currentSentWindow = Math.floor(snapshotTs / FOUR_HOURS) * FOUR_HOURS;
  const sent = s.mintSentiment.get(mint.mint_address, currentSentWindow);
  const sentAvgConf = (sent && sent.total_mentions > 0)
    ? sent.sum_confidence / sent.total_mentions : null;
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
    agg.top10Buyers, agg.top50Buyers, agg.weightedBuyerQuality,
    agg.buyDist.avg, agg.buyDist.median, agg.buyDist.p90, agg.buyDist.max, agg.buyDist.std,
    agg.sellDist.avg, agg.sellDist.median, agg.sellDist.p90, agg.sellDist.max, agg.sellDist.std,
    agg.buyConc.top1Pct, agg.buyConc.top3Pct, agg.buyConc.top5Pct, agg.buyConc.hhi,
    agg.sellConc.top1Pct, agg.sellConc.top3Pct, agg.sellConc.top5Pct, agg.sellConc.hhi,
    agg.sniperBuyerCount, agg.pctSniperBuys, agg.firstBlockBuyerCount, agg.pctFirstBlockBuys,
    agg.buyerRank.avgRank, agg.buyerRank.medianRank, agg.buyerRank.pctInFirst10,
    agg.trackedFirstSeenSec, agg.kolFirstSeenSec,
    agg.secondsTo5Buyers, agg.secondsTo10Buyers,
    agg.reversals.reversals, agg.reversals.longestUpPct, agg.reversals.longestDownPct,
    agg.burst.maxSolInflow, agg.burst.maxBuyCount, agg.burst.maxBuySellRatio,
    creatorSelf?.buys ?? 0, creatorSelf?.sells ?? 0,
    creatorActivity?.sol_to_sidewallets ?? null,
    creatorActivity?.sidewallet_buyer_count ?? null,
    agg.velocity.inflowAccelPct, agg.velocity.buyCountAccelPct,
    agg.top10Timing.top10TimingStdSec,
    agg.sellBurst.maxSellSol, agg.sellBurst.maxSellCount, agg.sellBurst.maxUniqueSellers,
    creatorSiblingCount,
    trendSignalMatch, narrativeMatchCount,
    pressureBuyPct, pressureNet,
    telegramMemberCount,
    buyerHhiDelta, sellerHhiDelta,
    agg.botSniperBuyerCount, agg.fastHumanSniperCount,
    secondsSincePrevCreatorDeath,
    agg.tradeCount, agg.tradeCount / Math.max(1, target / 60),
    // Use ?? not || so legitimate 0 values aren't turned into null
    ms?.volatility_pct ?? null,
    ms?.sandwich_risk ?? null,
    ms?.reaction_speed_ms ?? null,
    lc?.rpc_helius_p90 ?? null,
    lc?.priority_fee_p99 ?? null,  // see latestConditions comment — p99 is the real signal
    lc?.network_status ?? null,
    sent?.bull_mentions ?? null,
    sent?.bear_mentions ?? null,
    sent?.shill_mentions ?? null,
    sent?.total_mentions ?? null,
    sentAvgConf,
  );
}

function sweep() {
  const s = S();
  const now = Date.now();
  let total = 0;
  for (const t of TARGETS) {
    const minCreated = now - (t.age + t.tolerance) * 1000;
    const maxCreated = now - (t.age - t.tolerance) * 1000;
    const candidates = s.findCandidates.all(t.age, minCreated, maxCreated);
    for (const m of candidates) {
      try {
        takeSnapshot(m, t.age, now);
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
  const ages = TARGETS.map(t => `${t.age}s±${t.tolerance}`).join(',');
  console.log(`[ml-snap] snapshot sweeper started · targets=[${ages}] · interval=${SWEEP_INTERVAL_MS/1000}s`);
}
