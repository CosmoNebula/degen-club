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
import { getCreatorActivity } from './creator-activity.js';

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
             t.is_sniper, t.is_first_block, t.buyer_rank, t.seconds_from_creation,
             COALESCE(w.tracked, 0) AS tracked, COALESCE(w.is_kol, 0) AS is_kol,
             COALESCE(w.bundle_cluster_id, '') AS bundle_id,
             wl.rank AS leaderboard_rank
      FROM trades t
      LEFT JOIN wallets w ON w.address = t.wallet
      LEFT JOIN wallet_leaderboard wl ON wl.address = t.wallet
      WHERE t.mint_address = ? ORDER BY t.timestamp ASC
    `),
    creatorSelfTrades: d.prepare(`
      SELECT
        SUM(CASE WHEN is_buy = 1 THEN 1 ELSE 0 END) AS buys,
        SUM(CASE WHEN is_buy = 0 THEN 1 ELSE 0 END) AS sells
      FROM trades
      WHERE mint_address = ? AND wallet = ?
    `),
    creatorRecentLaunches: d.prepare(`
      SELECT COUNT(*) AS n FROM mints
      WHERE creator_wallet = ?
        AND mint_address != ?
        AND created_at < ?
        AND created_at >= ?
    `),
    // Tier 4 #1 — trend signal match (mirrors snapshot-sweeper).
    trendSignalMatch: d.prepare(`
      SELECT COUNT(*) AS n FROM trend_signals
      WHERE ts >= ? AND UPPER(keyword) LIKE '%' || UPPER(?) || '%'
    `),
    // Symbol ambiguity check: are there OTHER recently-active mints sharing
    // this symbol? If yes, trend_signal_match is meaningless — a $READ Reddit
    // mention could be about any of 727 READ mints, not specifically this one.
    symbolHasOtherActiveMints: d.prepare(`
      SELECT COUNT(*) AS n FROM mints
      WHERE UPPER(symbol) = UPPER(?)
        AND mint_address != ?
        AND last_trade_at IS NOT NULL
        AND last_trade_at > ?
        AND COALESCE(rugged, 0) = 0
    `),
    // Tier 4 #2 — recent news keywords (substring-matched in JS).
    recentNewsKeywords: d.prepare(`
      SELECT keywords FROM news_items
      WHERE ts >= ? AND keywords IS NOT NULL AND keywords != '[]'
    `),
    // Tier 4 #4 — pressure over last 60 trades.
    pressure60: d.prepare(`
      SELECT SUM(is_buy) AS buys, COUNT(*) AS total FROM (
        SELECT is_buy FROM trades
        WHERE mint_address = ? ORDER BY timestamp DESC LIMIT 60
      )
    `),
    // Tier 4 #5 — Telegram member cache.
    telegramMemberCount: d.prepare(`
      SELECT member_count FROM telegram_members
      WHERE mint_address = ? AND fetch_status = 'ok'
    `),
    // Tier 5 #3 — previous snapshot HHI for delta computation.
    prevSnapshotForHhi: d.prepare(`
      SELECT buyer_hhi, seller_hhi FROM ml_mint_snapshots
      WHERE mint_address = ? AND snapshot_age_sec < ?
      ORDER BY snapshot_age_sec DESC LIMIT 1
    `),
    // Tier 5 #5 — creator's prior dead mint timestamp.
    creatorPrevDeath: d.prepare(`
      SELECT last_trade_at FROM mints
      WHERE creator_wallet = ?
        AND mint_address != ?
        AND created_at < ?
        AND last_trade_at IS NOT NULL
        AND last_trade_at < ?
      ORDER BY last_trade_at DESC LIMIT 1
    `),
    microstructure: d.prepare(`SELECT volatility_pct, sandwich_risk, reaction_speed_ms FROM mint_microstructure WHERE mint_address = ?`),
    // p99 not p90 — see snapshot-sweeper for the rationale (pump.fun slots
    // are mostly uncontested so p50/p90 collapse to 0; p99 is the contested-slot signal)
    latestConditions: d.prepare(`SELECT rpc_helius_p90, priority_fee_p99, network_status FROM live_conditions ORDER BY timestamp DESC LIMIT 1`),
  };
  return stmts;
}

// Reversal + run-length stats. Mirrors snapshot-sweeper.reversalStats —
// must stay in sync so train/serve features match exactly.
function reversalStats(trades) {
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
  let direction = 0;
  let reversals = 0;
  let curRunStart = null;
  let curRunDirection = 0;
  let longestUp = 0;
  let longestDown = 0;

  for (const t of trades) {
    const p = t.price_sol;
    if (p == null || p <= 0) continue;
    if (firstPrice === null) {
      firstPrice = p; prevPrice = p; curRunStart = p; continue;
    }
    if (p === prevPrice) continue;
    const nextDir = p > prevPrice ? 1 : -1;
    if (direction === 0) {
      direction = nextDir; curRunDirection = nextDir; curRunStart = prevPrice;
    } else if (nextDir !== direction) {
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
  if (curRunDirection === 1 && prevPrice != null && curRunStart != null) {
    const runPct = (prevPrice - curRunStart) / curRunStart;
    if (runPct > longestUp) longestUp = runPct;
  } else if (curRunDirection === -1 && prevPrice != null && curRunStart != null) {
    const runPct = (curRunStart - prevPrice) / curRunStart;
    if (runPct > longestDown) longestDown = runPct;
  }
  return { reversals, longestUpPct: longestUp, longestDownPct: longestDown };
}

// Narrative match — mirrors snapshot-sweeper.countNarrativeMatches.
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
      if (k.length < 3) continue;
      seen.add(k);
    }
  }
  let matches = 0;
  for (const kw of seen) if (haystack.includes(kw)) matches++;
  return matches;
}

// Volume momentum (Tier 3 #1). Mirrors snapshot-sweeper.velocityStats.
function velocityStats(trades, snapshotTs, ageSec) {
  if (!trades || trades.length === 0 || !ageSec) {
    return { inflowAccelPct: null, buyCountAccelPct: null };
  }
  const midpointMs = snapshotTs - (ageSec * 1000) / 2;
  let h1Sol = 0, h2Sol = 0, h1Buys = 0, h2Buys = 0;
  for (const t of trades) {
    if (t.is_buy !== 1) continue;
    const isSecondHalf = t.timestamp >= midpointMs;
    const amt = t.sol_amount || 0;
    if (isSecondHalf) { h2Sol += amt; h2Buys++; }
    else { h1Sol += amt; h1Buys++; }
  }
  if (h1Buys === 0 && h2Buys === 0) {
    return { inflowAccelPct: null, buyCountAccelPct: null };
  }
  const inflowAccel = h1Sol > 0 ? (h2Sol - h1Sol) / h1Sol : (h2Sol > 0 ? 1.0 : 0);
  const buyCountAccel = h1Buys > 0 ? (h2Buys - h1Buys) / h1Buys : (h2Buys > 0 ? 1.0 : 0);
  return { inflowAccelPct: inflowAccel, buyCountAccelPct: buyCountAccel };
}

// Top-10 KOL cluster timing (Tier 3 #2). Mirrors snapshot-sweeper.top10TimingStats.
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

// Withdrawal cluster (Tier 3 #5). Mirrors snapshot-sweeper.sellBurst30sStats.
function sellBurst30sStats(trades) {
  if (!trades || trades.length === 0) {
    return { maxSellSol: null, maxSellCount: null, maxUniqueSellers: null };
  }
  const WINDOW_MS = 30 * 1000;
  let left = 0;
  let winSellSol = 0, winSellCount = 0;
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

// Rolling 30-sec burst stats. Mirrors snapshot-sweeper.burst30sStats — must
// stay in sync so train/serve features match exactly.
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
// MIN observed rank). Mirrors snapshot-sweeper.buyerRankStats.
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

// Concentration stats for a per-wallet sol map. Mirrors
// snapshot-sweeper.concentrationStats — must stay in sync.
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
  return { top1Pct: top1 / totalSol, top3Pct: top3 / totalSol, top5Pct: top5 / totalSol, hhi };
}

// Distribution stats for an array of trade SOL amounts. Mirrors
// snapshot-sweeper.distStats — must stay in sync so train/serve features
// match. Returns avg/median/p90/max/std OR all nulls if empty.
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

function aggregate(trades, ctx = {}) {
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
      reversals: reversalStats([]),
      burst: burst30sStats([]),
      sellBurst: sellBurst30sStats([]),
      velocity: velocityStats([], ctx.snapshotTs || 0, ctx.ageSec || 0),
      top10Timing: top10TimingStats([]),
      trackedFirstSeenSec: null, kolFirstSeenSec: null,
      secondsTo5Buyers: null, secondsTo10Buyers: null,
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
  let trackedFirstSeenSec = null, kolFirstSeenSec = null;
  let secondsTo5Buyers = null, secondsTo10Buyers = null;
  const buyers = new Set(), trackedBuyers = new Set(), kolBuyers = new Set(), bundleBuyers = new Set();
  const top10Buyers = new Set(), top50Buyers = new Set();
  const sniperBuyers = new Set(), firstBlockBuyers = new Set();
  const botSniperBuyers = new Set();
  const fastHumanSniperBuyers = new Set();
  const buyAmounts = [], sellAmounts = [];
  const buyerSolMap = new Map(), sellerSolMap = new Map();
  const buyerFirstRank = new Map();
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
        if (rank && rank > 0 && rank <= 50 && !top50Buyers.has(t.wallet)) {
          top50Buyers.add(t.wallet);
          if (rank <= 10) top10Buyers.add(t.wallet);
          weightedBuyerQuality += (51 - rank);
        }
        if (rank && rank > 0 && rank <= 10) top10BuyTimestamps.push(t.timestamp);
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
    solIn, solOut, buyCount, sellCount,
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

// Training ages — must mirror TARGETS in snapshot-sweeper.js. Every row in
// ml_mint_snapshots has snapshot_age_sec set to exactly one of these values,
// so the models have never seen any other age. Live inference must snap to
// the closest of these to avoid feeding an out-of-distribution age feature
// (e.g. snapshot_age_sec=237 — which the model has never seen and may not
// handle gracefully on splits keyed by age).
// Expanded 2026-05-12 (Phase B) — added 15, 30, 120, 600, 1800 for finer
// resolution on early-mint dynamics + mid-horizon coverage.
const TRAINING_AGES_SEC = [15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function snapToTrainingAge(actualSec) {
  if (actualSec < TRAINING_AGES_SEC[0]) return TRAINING_AGES_SEC[0];
  let best = TRAINING_AGES_SEC[0];
  let bestDist = Math.abs(actualSec - best);
  for (const a of TRAINING_AGES_SEC) {
    const d = Math.abs(actualSec - a);
    if (d < bestDist) { best = a; bestDist = d; }
  }
  return best;
}

// Returns null if mint not found. Otherwise returns a feature dict matching
// the model's expected column order. snapshotAgeSec, if provided, is used
// as-is (training callers pass the exact bucket). Live inference callers
// pass null and we snap the actual age to the nearest training bucket —
// note this still leaves a residual: the trade aggregates reflect ACTUAL
// age, not snapped age. Full fix requires retraining with continuous age
// or windowed feature collection. See audit memory for follow-up.
export function collectFeatures(mintAddress, snapshotAgeSec = null) {
  const s = S();
  const mint = s.getMint.get(mintAddress);
  if (!mint) return null;
  const now = Date.now();
  const actualAgeSec = Math.max(1, Math.round((now - mint.created_at) / 1000));
  const ageSec = snapshotAgeSec || snapToTrainingAge(actualAgeSec);

  const trades = s.tradesUpToNow.all(mintAddress);
  // velocity needs the "snapshot midpoint" — for live inference we use NOW
  // as the snapshot_ts and the snapped age as the window, so the midpoint
  // is now - snappedAge/2. This mirrors what snapshot-sweeper passes.
  const agg = aggregate(trades, { snapshotTs: now, ageSec });
  const creatorStats = s.creatorStats.get(mint.creator_wallet || '', mint.created_at, mint.creator_wallet || '', mint.created_at);
  const creatorSelf = mint.creator_wallet
    ? s.creatorSelfTrades.get(mintAddress, mint.creator_wallet)
    : { buys: 0, sells: 0 };
  const creatorActivity = mint.creator_wallet ? getCreatorActivity(mintAddress) : null;
  const creatorSiblingCount = mint.creator_wallet
    ? (s.creatorRecentLaunches.get(
        mint.creator_wallet,
        mintAddress,
        mint.created_at,
        mint.created_at - 3600 * 1000,
      )?.n ?? null)
    : null;

  // Tier 4 features (mirrors snapshot-sweeper).
  const trendWindowMs = now - 4 * 3600 * 1000;
  const symbolAmbiguous = mint.symbol
    ? (s.symbolHasOtherActiveMints.get(mint.symbol, mintAddress, trendWindowMs)?.n ?? 0) > 0
    : false;
  const trendSignalMatch = (mint.symbol && !symbolAmbiguous)
    ? ((s.trendSignalMatch.get(trendWindowMs, mint.symbol)?.n ?? 0) > 0 ? 1 : 0)
    : null;
  const newsKwRows = s.recentNewsKeywords.all(trendWindowMs);
  const narrativeMatchCount = countNarrativeMatches(mint, newsKwRows);
  const p60 = s.pressure60.get(mintAddress);
  const p60Total = p60?.total || 0;
  const p60Buys = p60?.buys || 0;
  const pressureBuyPct = p60Total >= 5 ? p60Buys / p60Total : null;
  const pressureNet = p60Total >= 5 ? (p60Buys - (p60Total - p60Buys)) / p60Total : null;
  const tgRow = s.telegramMemberCount.get(mintAddress);
  const telegramMemberCount = tgRow?.member_count ?? null;

  // Tier 5 #3 — HHI delta vs previous snapshot for this mint.
  const prevHhi = ageSec > 60 ? s.prevSnapshotForHhi.get(mintAddress, ageSec) : null;
  const buyerHhiDelta = (prevHhi?.buyer_hhi != null && agg.buyConc?.hhi != null)
    ? agg.buyConc.hhi - prevHhi.buyer_hhi : null;
  const sellerHhiDelta = (prevHhi?.seller_hhi != null && agg.sellConc?.hhi != null)
    ? agg.sellConc.hhi - prevHhi.seller_hhi : null;
  // Tier 5 #5 — revenge-launch detector.
  let secondsSincePrevCreatorDeath = null;
  if (mint.creator_wallet) {
    const prev = s.creatorPrevDeath.get(
      mint.creator_wallet, mintAddress, mint.created_at, mint.created_at,
    );
    if (prev?.last_trade_at) {
      secondsSincePrevCreatorDeath = Math.max(0, (mint.created_at - prev.last_trade_at) / 1000);
    }
  }
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
    top10_buyers: agg.top10Buyers,
    top50_buyers: agg.top50Buyers,
    weighted_buyer_quality: agg.weightedBuyerQuality,
    avg_buy_sol: agg.buyDist.avg,
    median_buy_sol: agg.buyDist.median,
    p90_buy_sol: agg.buyDist.p90,
    max_buy_sol: agg.buyDist.max,
    std_buy_sol: agg.buyDist.std,
    avg_sell_sol: agg.sellDist.avg,
    median_sell_sol: agg.sellDist.median,
    p90_sell_sol: agg.sellDist.p90,
    max_sell_sol: agg.sellDist.max,
    std_sell_sol: agg.sellDist.std,
    top1_buyer_sol_pct: agg.buyConc.top1Pct,
    top3_buyer_sol_pct: agg.buyConc.top3Pct,
    top5_buyer_sol_pct: agg.buyConc.top5Pct,
    buyer_hhi: agg.buyConc.hhi,
    top1_seller_sol_pct: agg.sellConc.top1Pct,
    top3_seller_sol_pct: agg.sellConc.top3Pct,
    top5_seller_sol_pct: agg.sellConc.top5Pct,
    seller_hhi: agg.sellConc.hhi,
    sniper_buyer_count: agg.sniperBuyerCount,
    pct_sniper_buys: agg.pctSniperBuys,
    first_block_buyer_count: agg.firstBlockBuyerCount,
    pct_first_block_buys: agg.pctFirstBlockBuys,
    avg_buyer_rank: agg.buyerRank.avgRank,
    median_buyer_rank: agg.buyerRank.medianRank,
    pct_buyers_in_first_10: agg.buyerRank.pctInFirst10,
    tracked_first_seen_sec: agg.trackedFirstSeenSec,
    kol_first_seen_sec: agg.kolFirstSeenSec,
    seconds_to_5_unique_buyers: agg.secondsTo5Buyers,
    seconds_to_10_unique_buyers: agg.secondsTo10Buyers,
    n_reversals_in_window: agg.reversals.reversals,
    longest_up_run_pct: agg.reversals.longestUpPct,
    longest_down_run_pct: agg.reversals.longestDownPct,
    max_30s_buy_sol: agg.burst.maxSolInflow,
    max_30s_buy_count: agg.burst.maxBuyCount,
    max_30s_buy_sell_ratio: agg.burst.maxBuySellRatio,
    creator_buys_post_launch: creatorSelf?.buys ?? 0,
    creator_sells_post_launch: creatorSelf?.sells ?? 0,
    creator_sol_to_sidewallets: creatorActivity?.sol_to_sidewallets ?? null,
    creator_sidewallet_buyer_count: creatorActivity?.sidewallet_buyer_count ?? null,
    inflow_accel_pct: agg.velocity.inflowAccelPct,
    buy_count_accel_pct: agg.velocity.buyCountAccelPct,
    top10_buy_timing_std_sec: agg.top10Timing.top10TimingStdSec,
    max_30s_sell_sol: agg.sellBurst.maxSellSol,
    max_30s_sell_count: agg.sellBurst.maxSellCount,
    max_30s_unique_sellers: agg.sellBurst.maxUniqueSellers,
    creator_recent_launch_siblings: creatorSiblingCount,
    trend_signal_match: trendSignalMatch,
    narrative_match_count: narrativeMatchCount,
    pressure_60_buy_pct: pressureBuyPct,
    pressure_60_net: pressureNet,
    telegram_member_count: telegramMemberCount,
    buyer_hhi_delta: buyerHhiDelta,
    seller_hhi_delta: sellerHhiDelta,
    bot_sniper_buyer_count: agg.botSniperBuyerCount,
    fast_human_sniper_count: agg.fastHumanSniperCount,
    seconds_since_prev_creator_death: secondsSincePrevCreatorDeath,
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
