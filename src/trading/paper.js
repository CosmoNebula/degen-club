// trading/paper.js — Paper position management v3.
// Supports per-position tier exits and trailing stops, set adaptively from
// ML-predicted peak. Each position carries its own tier targets in the DB.

import { db } from '../db.js';
import { config } from '../config.js';

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    walletState: d.prepare(`SELECT
      starting_balance_sol + COALESCE((SELECT SUM(realized_pnl_sol) FROM paper_positions WHERE status='closed' AND entered_at >= paper_wallet.started_at), 0)
      - COALESCE((SELECT SUM(MAX(0, entry_sol - COALESCE(sol_realized_so_far,0))) FROM paper_positions WHERE status='open' AND entered_at >= paper_wallet.started_at), 0) AS cash,
      starting_balance_sol, started_at
      FROM paper_wallet WHERE id = 1`),
    openExposure: d.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(entry_sol - COALESCE(sol_realized_so_far,0)),0) AS exposure FROM paper_positions WHERE status='open' AND is_moonbag=0"),
    openByStrategy: d.prepare("SELECT * FROM paper_positions WHERE status='open' AND strategy=?"),
    insertPosition: d.prepare(`INSERT INTO paper_positions
      (mint_address, strategy, entry_signal, entry_price, entry_sol, token_amount,
       entry_mcap_sol, tokens_remaining, entered_at, updated_at, entry_score,
       tier1_trigger_pct, tier1_sell_pct, tier2_trigger_pct, tier2_sell_pct,
       tier3_trigger_pct, tier3_sell_pct, trail_arm_pct, trail_pct, predicted_peak_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    closePosition: d.prepare(`UPDATE paper_positions SET
      status = 'closed', exit_reason = ?, exit_price = ?, exit_mcap_sol = ?,
      realized_pnl_sol = ?, realized_pnl_pct = ?,
      exited_at = ?, updated_at = ?
      WHERE id = ?`),
    insertPostmortem: d.prepare(`INSERT INTO ml_postmortem
      (position_id, mint_address, strategy, entry_score, predicted_peak_pct,
       actual_peak_pct, realized_pnl_pct, exit_reason, hold_duration_sec,
       pred_will_rug, pred_will_die_fast, pred_hits_2x_within_1h,
       pred_peaked_100, pred_peaked_300, pred_buy_pressure, pred_peak_within_5min,
       closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    entryPreds: d.prepare(`SELECT target, prob FROM ml_predictions
      WHERE mint_address = ? AND timestamp <= ?
        AND target IN ('will_rug','will_die_fast','hits_2x_within_1h',
                       'peaked_100','peaked_300','buy_pressure_continues_60s',
                       'peak_within_5min')
      ORDER BY timestamp DESC LIMIT 200`),
    recordTier: d.prepare(`UPDATE paper_positions SET
      sol_realized_so_far = COALESCE(sol_realized_so_far,0) + ?,
      tokens_remaining = MAX(0, COALESCE(tokens_remaining,0) - ?),
      tiers_hit = ?,
      trail_armed = ?,
      highest_pct = MAX(COALESCE(highest_pct,0), ?),
      updated_at = ?
      WHERE id = ?`),
  };
  return _stmts;
}

// Simple sell-slippage estimate using bonding curve constant-product.
function estimateSell(tokens, vSol, vTokens) {
  if (!tokens || !vSol || !vTokens) return 0;
  const k = vSol * vTokens;
  const newVTokens = vTokens + tokens;
  const newVSol = k / newVTokens;
  return Math.max(0, vSol - newVSol);
}
// Buy-slippage: same constant-product, going the other direction. Paying solIn
// raises the price, so you get fewer tokens than naive (solIn / price) suggests.
function estimateBuy(solIn, vSol, vTokens) {
  if (!solIn || !vSol || !vTokens) return 0;
  const k = vSol * vTokens;
  const newVSol = vSol + solIn;
  const newVTokens = k / newVSol;
  return Math.max(0, vTokens - newVTokens);
}

// =========================================================================
// FRICTION MODEL
// pump.fun charges 1% on every BC trade.
// Network friction (priority fee + base) uses a flat average rather than live
// sampling — Helius Sender handles priority-fee optimization in live mode, so
// the live bot won't need real-time priority data, and burning Helius credits
// to feed paper-mode friction isn't worth it. The 0.0003 SOL average covers
// base fee + a typical priority fee on a 200K-CU pump.fun swap during normal
// congestion (~150K microlamports/CU median).
// =========================================================================
const BUY_FEE_PCT = 0.01;
const SELL_FEE_PCT = 0.01;
const AVG_NETWORK_FRICTION_SOL = 0.0003;

function currentPriorityFeeSol() {
  return AVG_NETWORK_FRICTION_SOL;
}

export function getWalletCash() { return S().walletState.get()?.cash || 0; }
export function getOpenExposure() {
  const r = S().openExposure.get();
  return { n: r?.n || 0, exposureSol: r?.exposure || 0 };
}
export function getOpenPositions(strategyId) { return S().openByStrategy.all(strategyId); }

// Compute adaptive tier targets from the bot's ML peak prediction.
// Bounds keep tiers sane even when the regression is uncertain.
//
// Inputs:
//   predictedPeakPct — the model's predicted peak return as a percent (e.g. 80 for +80%)
//   isMigrated — affects expected magnitudes (post-mig usually bigger runs)
//
// Returns: { t1_trig, t1_sell, t2_trig, t2_sell, t3_trig, t3_sell, trail_arm, trail_pct }
// All triggers are PERCENT returns (e.g. 50 means fire when up 50%).
// All sell_pcts are FRACTIONS of current remaining position (0..1).
export function computeAdaptiveTiers(predictedPeakPct, isMigrated) {
  // Bound the predicted peak. Floor=+50% (don't be too greedy), cap=+500%
  // (don't park behind an unattainable target on a hot mint).
  const pp = Math.max(50, Math.min(500, predictedPeakPct || 100));

  // Tier 1: lock in cost basis + small profit early. 30% of predicted peak
  // but floor at +50% (don't sell on a wiggle), cap at +100%.
  const t1_trig = Math.max(50, Math.min(100, pp * 0.30));
  const t1_sell = 0.40;  // sell 40% of position

  // Tier 2: book real profit. 60% of predicted peak, floor +90%, cap +250%.
  const t2_trig = Math.max(90, Math.min(250, pp * 0.60));
  const t2_sell = 0.30;  // sell 30% of REMAINING position (~18% of original)

  // Tier 3: full target. predicted peak, floor +180%, cap +500%.
  const t3_trig = Math.max(180, Math.min(500, pp));
  const t3_sell = 0.30;  // sell 30% of REMAINING after t2 (~13% of original)

  // Trailing stop on remaining 12% bag. Arms after t1, exits at peak - 20%.
  const trail_arm = t1_trig;
  const trail_pct = 20;  // exit at peak − 20%

  return { t1_trig, t1_sell, t2_trig, t2_sell, t3_trig, t3_sell, trail_arm, trail_pct };
}

export async function openPaperPosition({
  strategy, mintAddress, entryPrice, entrySol, entryMcap, entryScore, phase, tiers,
}) {
  if (!entryPrice || entryPrice <= 0) return null;
  if (!entrySol || entrySol <= 0) return null;
  // Friction: priority fee comes off the SOL spent before the swap.
  // 1% pump.fun trade fee reduces the SOL that actually buys tokens.
  // Pre-mig: use curve math (estimateBuy) — buying raises price so you get
  // less than naive (sol/price). Post-mig (no curve state): naive fallback.
  const priorityFee = currentPriorityFeeSol();
  const solAfterPriorityFee = Math.max(0, entrySol - priorityFee);
  const solAfterTradeFee = solAfterPriorityFee * (1 - BUY_FEE_PCT);
  if (solAfterTradeFee <= 0) return null;
  let tokensReceived;
  const mintCurve = db().prepare(
    'SELECT v_sol_in_curve, v_tokens_in_curve, migrated FROM mints WHERE mint_address=?'
  ).get(mintAddress);
  if (mintCurve && !mintCurve.migrated && mintCurve.v_sol_in_curve > 0 && mintCurve.v_tokens_in_curve > 0) {
    tokensReceived = estimateBuy(solAfterTradeFee, mintCurve.v_sol_in_curve, mintCurve.v_tokens_in_curve);
  } else {
    tokensReceived = solAfterTradeFee / entryPrice;
  }
  if (tokensReceived <= 0) return null;
  const now = Date.now();
  const signal = JSON.stringify({ source: 'ml-policy', phase, score: entryScore, tiers, friction: { priorityFee, buyFeePct: BUY_FEE_PCT } });
  const t = tiers || {};
  // Store gross entry_sol so wallet accounting stays consistent; the friction
  // is captured by us receiving fewer tokens than entry_sol/entry_price would suggest.
  const r = S().insertPosition.run(
    mintAddress, strategy, signal, entryPrice, entrySol, tokensReceived,
    entryMcap || 0, tokensReceived, now, now, entryScore || 0,
    t.t1_trig ?? null, t.t1_sell ?? null,
    t.t2_trig ?? null, t.t2_sell ?? null,
    t.t3_trig ?? null, t.t3_sell ?? null,
    t.trail_arm ?? null, t.trail_pct ?? null,
    t.predictedPeak ?? null,
  );
  return r.lastInsertRowid;
}

// Partial-sell at a tier hit. Updates sol_realized_so_far, tokens_remaining,
// records the tier in tiers_hit JSON. Does NOT close the position.
//
// Returns the SOL realized from this partial sell.
export async function partialSellAtTier(p, tierName, tierSellPct, currentPrice, currentMcap) {
  if (!p || !p.id || !tierSellPct || tierSellPct <= 0) return 0;
  const tokens = p.tokens_remaining || 0;
  if (tokens <= 0) return 0;
  const tokensToSell = tokens * tierSellPct;

  // Compute SOL out via bonding curve if pre-mig and we have curve state
  let solOut;
  const mint = db().prepare('SELECT v_sol_in_curve, v_tokens_in_curve, migrated FROM mints WHERE mint_address=?').get(p.mint_address);
  if (mint && !mint.migrated && mint.v_sol_in_curve > 0 && mint.v_tokens_in_curve > 0) {
    solOut = estimateSell(tokensToSell, mint.v_sol_in_curve, mint.v_tokens_in_curve);
  } else {
    solOut = tokensToSell * (currentPrice || p.entry_price);
  }
  // Friction: 1% sell fee + priority fee deduction
  solOut = Math.max(0, solOut * (1 - SELL_FEE_PCT) - currentPriorityFeeSol());

  // Update tiers_hit JSON
  let tiersHit;
  try { tiersHit = JSON.parse(p.tiers_hit || '[]'); }
  catch { tiersHit = []; }
  if (!tiersHit.includes(tierName)) tiersHit.push(tierName);

  // Trail arms after first tier hit
  const trailArmed = tiersHit.length >= 1 ? 1 : (p.trail_armed || 0);

  const curPct = currentPrice > 0 ? (currentPrice / p.entry_price - 1) * 100 : 0;

  S().recordTier.run(
    solOut,
    tokensToSell,
    JSON.stringify(tiersHit),
    trailArmed,
    curPct,
    Date.now(),
    p.id,
  );

  console.log(`[paper] ${tierName} ${p.mint_address.slice(0,8)}… sold ${(tierSellPct*100).toFixed(0)}% @ ${curPct.toFixed(1)}% pnl, +${solOut.toFixed(4)} SOL realized`);
  return solOut;
}

export async function closePaperPosition(p, exitPrice, exitMcap, exitReason) {
  if (!p || !p.id) return;
  const tokens = p.tokens_remaining || 0;
  let solOut;
  const mint = db().prepare('SELECT v_sol_in_curve, v_tokens_in_curve, migrated FROM mints WHERE mint_address=?').get(p.mint_address);
  if (mint && !mint.migrated && mint.v_sol_in_curve > 0 && mint.v_tokens_in_curve > 0) {
    solOut = estimateSell(tokens, mint.v_sol_in_curve, mint.v_tokens_in_curve);
  } else {
    solOut = tokens * (exitPrice || p.entry_price);
  }
  // Friction on the close leg
  solOut = Math.max(0, solOut * (1 - SELL_FEE_PCT) - currentPriorityFeeSol());
  const totalRealized = (p.sol_realized_so_far || 0) + solOut;
  const pnl = totalRealized - p.entry_sol;
  const pnlPct = p.entry_sol > 0 ? (pnl / p.entry_sol) * 100 : 0;
  const now = Date.now();
  S().closePosition.run(exitReason, exitPrice, exitMcap, pnl, pnlPct, now, now, p.id);
  console.log(`[paper] CLOSE ${p.strategy} on ${p.mint_address.slice(0,8)}… ${exitReason} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`);

  // POST-MORTEM: capture predicted vs actual for future calibration.
  // Latest pred for each target at-or-before entry time (within reason).
  try {
    const entryPreds = S().entryPreds.all(p.mint_address, p.entered_at);
    const predMap = {};
    for (const r of entryPreds) {
      if (!(r.target in predMap)) predMap[r.target] = r.prob;
    }
    const holdSec = Math.floor((now - p.entered_at) / 1000);
    S().insertPostmortem.run(
      p.id, p.mint_address, p.strategy,
      p.entry_score ?? null,
      p.predicted_peak_pct ?? null,
      p.highest_pct ?? 0,
      pnlPct,
      exitReason,
      holdSec,
      predMap.will_rug ?? null,
      predMap.will_die_fast ?? null,
      predMap.hits_2x_within_1h ?? null,
      predMap.peaked_100 ?? null,
      predMap.peaked_300 ?? null,
      predMap.buy_pressure_continues_60s ?? null,
      predMap.peak_within_5min ?? null,
      now,
    );
  } catch (e) {
    console.error('[paper] postmortem insert err:', e.message);
  }
}
