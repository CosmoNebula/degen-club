// Mint Microstructure (Phase 1B) — per-mint execution-cost intelligence.
// Computes and caches the metrics needed by the dynamic friction model in 1C.
//
// Two layers:
//   1) Pure-function bonding curve math — exact slippage given trade size & curve state
//   2) Cached scores per mint — volatility, sandwich risk, reaction speed, etc.
//      refreshed by a tiered sweep (hot: 30s, warm: 2min, cold: skip)
//
// Pump.fun bonding curve is constant-product AMM:
//   k = v_sol * v_tokens (invariant)
//   buying N SOL → tokens_out = v_tokens × N / (v_sol + N)
//   exact slippage = (fill_price − mid_price) / mid_price
//
// Cache strategy: every 30s, scan mints traded in last 5min ("hot"). For each,
// compute all metrics and upsert. Mints traded 5-30min ago ("warm") refreshed
// every 2min if stale. Older mints skipped until they trade again.

import { db } from '../db/index.js';

// ---------------------------------------------------------------------------
// Bonding curve math (pure functions — no caching needed)
// ---------------------------------------------------------------------------

const FALLBACK_SLIPPAGE = 0.025; // 2.5% used when curve state unavailable
const SLIPPAGE_CAP = 0.99;       // safety cap for absurd inputs

// Slippage % a buy of `solIn` SOL would incur on a curve with given reserves.
// Returns positive decimal (e.g. 0.033 = 3.3% slippage).
export function bondingCurveSlippageBuy(solIn, vSolInCurve, vTokensInCurve) {
  if (!vSolInCurve || vSolInCurve <= 0 || !vTokensInCurve || vTokensInCurve <= 0) return FALLBACK_SLIPPAGE;
  if (solIn <= 0) return 0;
  const k = vSolInCurve * vTokensInCurve;
  const newVSol = vSolInCurve + solIn;
  const newVTokens = k / newVSol;
  const tokensOut = vTokensInCurve - newVTokens;
  if (tokensOut <= 0) return SLIPPAGE_CAP;
  const fillPrice = solIn / tokensOut;
  const midPrice = vSolInCurve / vTokensInCurve;
  return Math.min(SLIPPAGE_CAP, Math.max(0, (fillPrice - midPrice) / midPrice));
}

// Slippage % a sell of `tokensIn` tokens would incur. Returns positive decimal.
export function bondingCurveSlippageSell(tokensIn, vSolInCurve, vTokensInCurve) {
  if (!vSolInCurve || vSolInCurve <= 0 || !vTokensInCurve || vTokensInCurve <= 0) return FALLBACK_SLIPPAGE;
  if (tokensIn <= 0) return 0;
  const k = vSolInCurve * vTokensInCurve;
  const newVTokens = vTokensInCurve + tokensIn;
  const newVSol = k / newVTokens;
  const solOut = vSolInCurve - newVSol;
  if (solOut <= 0) return SLIPPAGE_CAP;
  const fillPrice = solOut / tokensIn;
  const midPrice = vSolInCurve / vTokensInCurve;
  return Math.min(SLIPPAGE_CAP, Math.max(0, (midPrice - fillPrice) / midPrice));
}

// ---------------------------------------------------------------------------
// Cached metrics — read API
// ---------------------------------------------------------------------------

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    getCached: d.prepare(`SELECT * FROM mint_microstructure WHERE mint_address = ?`),
    upsert: d.prepare(`INSERT INTO mint_microstructure
      (mint_address, v_sol_in_curve, trades_per_min, unique_buyers_5min,
       buy_sell_ratio, sol_inflow_5min, sol_outflow_5min, volatility_pct,
       sandwich_risk, reaction_speed_ms, trade_count, computed_at, active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint_address) DO UPDATE SET
        v_sol_in_curve = excluded.v_sol_in_curve,
        trades_per_min = excluded.trades_per_min,
        unique_buyers_5min = excluded.unique_buyers_5min,
        buy_sell_ratio = excluded.buy_sell_ratio,
        sol_inflow_5min = excluded.sol_inflow_5min,
        sol_outflow_5min = excluded.sol_outflow_5min,
        volatility_pct = excluded.volatility_pct,
        sandwich_risk = excluded.sandwich_risk,
        reaction_speed_ms = excluded.reaction_speed_ms,
        trade_count = excluded.trade_count,
        computed_at = excluded.computed_at,
        active_at = excluded.active_at`),
    pruneCold: d.prepare(`DELETE FROM mint_microstructure WHERE active_at < ?`),
    getMint: d.prepare(`SELECT mint_address, v_sol_in_curve, v_tokens_in_curve, last_trade_at FROM mints WHERE mint_address = ?`),
    // hot-tier: traded in last 5min
    hotMints: d.prepare(`SELECT mint_address, last_trade_at FROM mints
       WHERE migrated = 0 AND rugged = 0 AND last_trade_at > ?
       ORDER BY last_trade_at DESC LIMIT 500`),
    // warm tier: traded 5-30min ago AND not refreshed in last 90s
    warmMints: d.prepare(`SELECT m.mint_address, m.last_trade_at FROM mints m
       LEFT JOIN mint_microstructure ms ON ms.mint_address = m.mint_address
       WHERE m.migrated = 0 AND m.rugged = 0
         AND m.last_trade_at BETWEEN ? AND ?
         AND (ms.computed_at IS NULL OR ms.computed_at < ?)
       ORDER BY m.last_trade_at DESC LIMIT 200`),
    // recent trades for a mint
    recentTrades: d.prepare(`SELECT timestamp, wallet, is_buy, sol_amount, price_sol
       FROM trades WHERE mint_address = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 100`),
    last20Trades: d.prepare(`SELECT timestamp, price_sol FROM trades
       WHERE mint_address = ? AND price_sol > 0 ORDER BY timestamp DESC LIMIT 20`),
    quickFlipsCount: d.prepare(`SELECT COUNT(*) AS n FROM trades t1
       JOIN trades t2 ON t2.mint_address = t1.mint_address AND t2.wallet = t1.wallet
         AND t2.is_buy = 0 AND t2.timestamp BETWEEN t1.timestamp + 500 AND t1.timestamp + 5000
       WHERE t1.mint_address = ? AND t1.is_buy = 1 AND t1.timestamp > ?`),
    trackedReactionSamples: d.prepare(`SELECT t.timestamp AS tracked_t, w.tracked, w.is_kol,
        (SELECT MIN(t2.timestamp) FROM trades t2
          WHERE t2.mint_address = t.mint_address AND t2.timestamp > t.timestamp
            AND t2.wallet != t.wallet) AS next_t
       FROM trades t JOIN wallets w ON w.address = t.wallet
       WHERE t.mint_address = ? AND t.is_buy = 1 AND (w.tracked = 1 OR w.is_kol = 1)
         AND t.timestamp > ?
       ORDER BY t.timestamp DESC LIMIT 8`),
  };
  return stmts;
}

// ---------------------------------------------------------------------------
// Metric computations
// ---------------------------------------------------------------------------

function computeVolatility(trades) {
  // trades: most-recent-first list with price_sol. Need consecutive pairs.
  if (!trades || trades.length < 3) return 0;
  // Sort ascending for pair walk
  const asc = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const changes = [];
  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1].price_sol;
    const cur = asc[i].price_sol;
    if (!prev || prev <= 0 || !cur || cur <= 0) continue;
    let pct = (cur - prev) / prev;
    // Clip extreme outliers (often single-trade wicks) to keep stat representative
    pct = Math.max(-0.5, Math.min(0.5, pct));
    changes.push(pct);
  }
  if (changes.length < 2) return 0;
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / changes.length;
  return Math.sqrt(variance);
}

function computeReactionSpeed(samples) {
  // samples: rows with tracked_t and next_t
  const diffs = samples
    .filter((s) => s.next_t && s.tracked_t)
    .map((s) => s.next_t - s.tracked_t)
    .filter((d) => d > 0 && d < 60000); // ignore implausible >60s gaps
  if (diffs.length < 3) return null;
  const sorted = [...diffs].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]); // median
}

// ---------------------------------------------------------------------------
// Per-mint compute & cache
// ---------------------------------------------------------------------------

function computeOneMint(mintAddress) {
  const s = S();
  const now = Date.now();
  const mint = s.getMint.get(mintAddress);
  if (!mint) return null;
  const fiveMinAgo = now - 5 * 60 * 1000;
  const sixtySecAgo = now - 60 * 1000;

  // Recent trades (last 5min, capped 100)
  const recent = s.recentTrades.all(mintAddress, fiveMinAgo);
  const tradeCount = recent.length;
  const tradesPerMin = tradeCount / 5;

  // Buy/sell flow
  let solIn = 0, solOut = 0, buyCount = 0, sellCount = 0;
  const buyerSet = new Set();
  for (const t of recent) {
    if (t.is_buy) { solIn += t.sol_amount || 0; buyCount++; if (t.wallet) buyerSet.add(t.wallet); }
    else { solOut += t.sol_amount || 0; sellCount++; }
  }
  const buySellRatio = sellCount > 0 ? buyCount / sellCount : (buyCount > 0 ? 99 : 0);

  // Volatility — combine last-20-trades and last-60s windows, dedupe by timestamp
  const last20 = s.last20Trades.all(mintAddress);
  const last60s = recent.filter((t) => t.timestamp >= sixtySecAgo && t.price_sol > 0);
  const merged = new Map();
  for (const t of [...last20, ...last60s]) merged.set(t.timestamp, { timestamp: t.timestamp, price_sol: t.price_sol });
  const volatilityInputs = [...merged.values()];
  const volatility = computeVolatility(volatilityInputs);

  // Sandwich proxy: count of "buy then sell by same wallet within 5s" in last 5min
  const flipsRow = s.quickFlipsCount.get(mintAddress, fiveMinAgo);
  const flips = flipsRow ? flipsRow.n : 0;
  // 0-1 score, saturates at 10 quick-flips/5min
  const sandwichRisk = Math.min(1, flips / 10);

  // Reaction speed: median delay from tracked-wallet buy → next non-same-wallet trade
  const reactionSamples = s.trackedReactionSamples.all(mintAddress, now - 30 * 60 * 1000);
  const reactionMs = computeReactionSpeed(reactionSamples);

  s.upsert.run(
    mintAddress,
    mint.v_sol_in_curve || 0,
    tradesPerMin,
    buyerSet.size,
    buySellRatio,
    solIn,
    solOut,
    volatility,
    sandwichRisk,
    reactionMs,
    tradeCount,
    now,
    mint.last_trade_at || now
  );

  return { mintAddress, vSol: mint.v_sol_in_curve, volatility, sandwichRisk, reactionMs, tradesPerMin };
}

// ---------------------------------------------------------------------------
// Tiered sweep (hot every 30s, warm every 2min)
// ---------------------------------------------------------------------------

const HOT_SWEEP_INTERVAL_MS = 30 * 1000;
const WARM_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const PRUNE_RETAIN_MS = 60 * 60 * 1000;
const HOT_AGE_MS = 5 * 60 * 1000;
const WARM_AGE_MS = 30 * 60 * 1000;

function hotSweep() {
  const s = S();
  const now = Date.now();
  const cutoff = now - HOT_AGE_MS;
  const hot = s.hotMints.all(cutoff);
  let updated = 0;
  for (const row of hot) {
    try { computeOneMint(row.mint_address); updated++; } catch (err) {
      if (updated === 0) console.error('[microstructure] hot compute err:', err.message);
    }
  }
  if (updated > 0) console.log(`[microstructure] hot sweep · ${updated} mints updated`);
}

function warmSweep() {
  const s = S();
  const now = Date.now();
  const warmCutoffOld = now - WARM_AGE_MS;
  const warmCutoffYoung = now - HOT_AGE_MS;
  const stalenessCutoff = now - 90 * 1000;
  const warm = s.warmMints.all(warmCutoffOld, warmCutoffYoung, stalenessCutoff);
  let updated = 0;
  for (const row of warm) {
    try { computeOneMint(row.mint_address); updated++; } catch {}
  }
  if (updated > 0) console.log(`[microstructure] warm sweep · ${updated} mints updated`);
}

function prune() {
  try { S().pruneCold.run(Date.now() - PRUNE_RETAIN_MS); } catch {}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getMicrostructure(mintAddress) {
  const cached = S().getCached.get(mintAddress);
  if (cached) return cached;
  // Fall through to live compute if not cached. Bot only does this for mints
  // it cares about right now, so the on-demand cost is acceptable.
  return computeOneMint(mintAddress);
}

// Convenience: full friction estimate for a buy.
// Combines bonding-curve slippage + volatility drift + sandwich-risk surcharge.
export function estimateBuyFriction(mintAddress, solIn, latencyMs) {
  const m = getMicrostructure(mintAddress) || {};
  const mint = S().getMint.get(mintAddress);
  const vSol = (mint && mint.v_sol_in_curve) || m.v_sol_in_curve || 0;
  const vTokens = (mint && mint.v_tokens_in_curve) || 0;
  const slip = bondingCurveSlippageBuy(solIn, vSol, vTokens);
  const volDrift = (m.volatility_pct || 0) * Math.sqrt(Math.max(0, latencyMs || 0) / 1000);
  const sandwich = (m.sandwich_risk || 0) * 0.04; // up to +4% surcharge in heavily-sandwich-y mints
  const total = slip + volDrift + sandwich;
  return { totalSlippagePct: total, components: { curve: slip, volatilityDrift: volDrift, sandwich, vSol, latencyMs } };
}

export function estimateSellFriction(mintAddress, tokensIn, latencyMs) {
  const m = getMicrostructure(mintAddress) || {};
  const mint = S().getMint.get(mintAddress);
  const vSol = (mint && mint.v_sol_in_curve) || m.v_sol_in_curve || 0;
  const vTokens = (mint && mint.v_tokens_in_curve) || 0;
  const slip = bondingCurveSlippageSell(tokensIn, vSol, vTokens);
  const volDrift = (m.volatility_pct || 0) * Math.sqrt(Math.max(0, latencyMs || 0) / 1000);
  const sandwich = (m.sandwich_risk || 0) * 0.04;
  const total = slip + volDrift + sandwich;
  return { totalSlippagePct: total, components: { curve: slip, volatilityDrift: volDrift, sandwich, vSol, latencyMs } };
}

export function startMicrostructureSweep() {
  // Initial hot sweep at boot so cache populates fast
  setTimeout(hotSweep, 5000);
  setInterval(hotSweep, HOT_SWEEP_INTERVAL_MS);
  setInterval(warmSweep, WARM_SWEEP_INTERVAL_MS);
  setInterval(prune, PRUNE_INTERVAL_MS);
  console.log('[microstructure] sweep started · hot=30s · warm=2min · prune=10min');
}
