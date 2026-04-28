import { db } from '../db/index.js';
import { config } from '../config.js';

function getStrategyTriggers() {
  const out = {};
  for (const [name, cfg] of Object.entries(config.strategies || {})) {
    if (!cfg || typeof cfg !== 'object' || !cfg.trigger) continue;
    out[name] = cfg.trigger;
  }
  return out;
}

const BACKTESTABLE_TRIGGERS = new Set(['smart_trade', 'copy_signal', 'volume_surge']);

function applyBuyFriction(solIn, price) {
  const f = config.friction || {};
  const priority = f.priorityFeeSol || 0;
  const fee = f.feePct || 0;
  const slip = f.slippagePct || 0;
  const effectiveSol = Math.max(0, solIn - priority);
  const effectivePrice = price * (1 + slip);
  const tokens = (effectiveSol * (1 - fee)) / effectivePrice;
  return tokens;
}
function applySellFriction(tokens, price) {
  const f = config.friction || {};
  const priority = f.priorityFeeSol || 0;
  const fee = f.feePct || 0;
  const slip = f.slippagePct || 0;
  const effectivePrice = price * (1 - slip);
  const gross = tokens * effectivePrice;
  return Math.max(0, gross * (1 - fee) - priority);
}

function getSignals(strategyName, trigger) {
  const d = db();
  if (trigger === 'copy_signal') {
    return d.prepare(`
      SELECT mint_address, fired_at AS ts, NULL AS suggested_entry_sol
      FROM copy_signals
      ORDER BY fired_at ASC
    `).all();
  }
  if (trigger === 'volume_surge') {
    return d.prepare(`
      SELECT mint_address, fired_at AS ts, suggested_entry_sol
      FROM volume_signals
      ORDER BY fired_at ASC
    `).all();
  }
  if (trigger === 'smart_trade') {
    return d.prepare(`
      SELECT t.mint_address, t.timestamp AS ts, NULL AS suggested_entry_sol, t.wallet
      FROM trades t
      JOIN wallets w ON w.address = t.wallet
      JOIN mints m ON m.mint_address = t.mint_address
      WHERE t.is_buy = 1
        AND w.tracked = 1
        AND w.copy_friendly = 1
        AND (w.bundle_cluster_id IS NULL OR w.bundle_cluster_id = '')
        AND w.auto_blocked = 0
        AND t.seconds_from_creation BETWEEN 10 AND 600
      ORDER BY t.timestamp ASC
    `).all();
  }
  return [];
}

function simulatePosition(strat, signal) {
  const d = db();
  const mint = d.prepare('SELECT * FROM mints WHERE mint_address = ?').get(signal.mint_address);
  if (!mint) return null;

  const fwd = d.prepare(`
    SELECT timestamp, price_sol, market_cap_sol, is_buy
    FROM trades
    WHERE mint_address = ? AND timestamp >= ? AND price_sol IS NOT NULL
    ORDER BY timestamp ASC LIMIT 5000
  `).all(signal.mint_address, signal.ts);
  if (fwd.length < 1) return null;

  const entryPrice = fwd[0].price_sol;
  if (!entryPrice || entryPrice <= 0) return null;

  let entrySol = signal.suggested_entry_sol > 0 ? signal.suggested_entry_sol : strat.entry_sol;
  if (!entrySol || entrySol <= 0) return null;
  const cap = config.safety?.maxPerTradeSol;
  if (cap && entrySol > cap) entrySol = cap;

  const initialTokens = applyBuyFriction(entrySol, entryPrice);
  if (initialTokens <= 0) return null;

  let tokensRemaining = initialTokens;
  let solRealizedSoFar = 0;
  let highestPct = 0;
  let lastPriceTs = signal.ts;
  let lastPrice = entryPrice;
  const tiersHit = new Set();
  let breakevenArmed = false;

  const cashbackBoost = (mint.cashback_enabled === 1 && (strat.cashback_trigger_boost || 1.0) > 1.0)
    ? strat.cashback_trigger_boost : 1.0;
  const t1Trig = strat.tier1_trigger_pct * cashbackBoost;
  const t2Trig = strat.tier2_trigger_pct * cashbackBoost;
  const t3Trig = strat.tier3_trigger_pct * cashbackBoost;
  const t1Sell = strat.tier1_sell_pct;
  const t2Sell = strat.tier2_sell_pct;
  const t3Sell = strat.tier3_sell_pct;
  const t3Trail = strat.tier3_trail_pct || 0;
  const beArm = strat.breakeven_arm_pct || 0;
  const beFloor = strat.breakeven_floor_pct || 0;
  const tpTrail = strat.tp_trail_pct || 0;
  const tpTrailArm = strat.tp_trail_arm_pct || 0;
  const fastFailSec = strat.fast_fail_sec || 0;
  const fastFailMin = strat.fast_fail_min_peak_pct || 0;
  const fastFailSl = strat.fast_fail_sl_pct || 0;
  const fakeSec = strat.fakepump_sec || 0;
  const fakeMin = strat.fakepump_min_peak_pct || 0;
  const fakeSl = strat.fakepump_sl_pct || 0;
  const flatMin = strat.flat_exit_min || 0;
  const flatMaxPeak = strat.flat_exit_max_peak_pct || 0;

  for (let i = 0; i < fwd.length; i++) {
    const t = fwd[i];
    const currentPrice = t.price_sol;
    if (!currentPrice || currentPrice <= 0) continue;
    lastPrice = currentPrice;
    lastPriceTs = t.timestamp;

    const peakPct = (currentPrice - entryPrice) / entryPrice;
    highestPct = Math.max(highestPct, peakPct);

    if (!tiersHit.has(1) && peakPct >= t1Trig) {
      const sellTokens = Math.min(initialTokens * t1Sell, tokensRemaining);
      solRealizedSoFar += applySellFriction(sellTokens, currentPrice);
      tokensRemaining -= sellTokens;
      tiersHit.add(1);
      if (strat.breakeven_after_tier1) breakevenArmed = true;
    }
    if (!tiersHit.has(2) && peakPct >= t2Trig) {
      const sellTokens = Math.min(initialTokens * t2Sell, tokensRemaining);
      solRealizedSoFar += applySellFriction(sellTokens, currentPrice);
      tokensRemaining -= sellTokens;
      tiersHit.add(2);
    }
    if (!tiersHit.has(3) && peakPct >= t3Trig && t3Trail <= 0) {
      const sellTokens = Math.min(initialTokens * t3Sell, tokensRemaining);
      solRealizedSoFar += applySellFriction(sellTokens, currentPrice);
      tokensRemaining -= sellTokens;
      tiersHit.add(3);
    }

    const t3Armed = !tiersHit.has(3) && t3Trail > 0 && peakPct >= t3Trig;
    const tier3TrailFloor = highestPct - t3Trail;

    const ageMs = t.timestamp - signal.ts;
    const ageSec = ageMs / 1000;
    const ageMin = ageMs / 60000;
    const minutesSinceLastTrade = (i + 1 < fwd.length)
      ? (fwd[i + 1].timestamp - t.timestamp) / 60000
      : 0;

    const beActive = breakevenArmed && highestPct >= beArm;
    const trailArmed = breakevenArmed && tpTrail > 0 && highestPct >= tpTrailArm;
    const postT1TrailFloor = trailArmed ? Math.max(0, highestPct - tpTrail) : null;
    const fastFailActive = !breakevenArmed && fastFailSec > 0 && ageSec >= fastFailSec && highestPct < fastFailMin;
    const fakeActive = !breakevenArmed && fakeSec > 0 && ageSec >= fakeSec && highestPct < fakeMin;
    const flatActive = flatMin > 0 && ageMin >= flatMin && highestPct < flatMaxPeak;

    let exitReason = null;
    if (tokensRemaining <= 0.0001) exitReason = 'TIERED_FULL';
    else if (t3Armed && peakPct <= tier3TrailFloor) exitReason = 'TP_TRAIL';
    else if (postT1TrailFloor !== null && peakPct <= postT1TrailFloor) exitReason = 'POST_T1_TRAIL';
    else if (beActive && !trailArmed && peakPct <= beFloor) exitReason = 'BREAKEVEN_SL';
    else if (fastFailActive && peakPct <= fastFailSl) exitReason = 'FAST_FAIL';
    else if (fakeActive && peakPct <= fakeSl) exitReason = 'FAKE_PUMP';
    else if (flatActive) exitReason = 'FLAT_EXIT';
    else if (!breakevenArmed && peakPct <= strat.sl_pct) exitReason = 'SL_HIT';
    else if (
      strat.stagnant_exit_min > 0 &&
      minutesSinceLastTrade >= strat.stagnant_exit_min &&
      peakPct <= strat.stagnant_loss_pct
    ) exitReason = 'STAGNATED';
    else if (ageMin >= strat.max_hold_min) exitReason = 'TIME_EXIT';

    if (exitReason) {
      return finalize(entrySol, currentPrice, tokensRemaining, solRealizedSoFar, highestPct, t.timestamp, signal.ts, exitReason, [...tiersHit]);
    }
  }

  if (mint.rugged) {
    return finalize(entrySol, lastPrice * 0.05, tokensRemaining, solRealizedSoFar, highestPct, lastPriceTs, signal.ts, 'RUGGED', [...tiersHit]);
  }
  if (mint.migrated) {
    return finalize(entrySol, lastPrice, tokensRemaining, solRealizedSoFar, highestPct, lastPriceTs, signal.ts, 'MIGRATED', [...tiersHit]);
  }
  return finalize(entrySol, lastPrice, tokensRemaining, solRealizedSoFar, highestPct, lastPriceTs, signal.ts, 'NO_DATA', [...tiersHit]);
}

function finalize(entrySol, exitPrice, tokensRemaining, solRealizedSoFar, highestPct, exitTs, signalTs, exitReason, tiersHit) {
  const finalSol = applySellFriction(tokensRemaining, exitPrice);
  const totalRealized = solRealizedSoFar + finalSol;
  const realizedPnlSol = totalRealized - entrySol;
  const realizedPnlPct = realizedPnlSol / entrySol;
  return {
    entrySol, exitPrice, exitReason,
    realizedPnlSol, realizedPnlPct,
    highestPct, holdMinutes: (exitTs - signalTs) / 60000,
    tiersHit,
  };
}

export function backtestStrategy(strategyName) {
  const d = db();
  const strat = d.prepare('SELECT * FROM strategy_state WHERE name = ?').get(strategyName);
  if (!strat) return null;
  const triggers = getStrategyTriggers();
  const trigger = triggers[strategyName];
  if (!trigger) return { strategy: strategyName, signalCount: 0, results: [], note: 'no-trigger-in-config' };
  if (!BACKTESTABLE_TRIGGERS.has(trigger)) {
    return { strategy: strategyName, signalCount: 0, results: [], note: `trigger '${trigger}' not backtestable (no historical signal log)` };
  }

  const signals = getSignals(strategyName, trigger);
  if (!signals.length) return { strategy: strategyName, signalCount: 0, results: [] };

  const seenMints = new Set();
  const results = [];
  for (const sig of signals) {
    if (seenMints.has(sig.mint_address)) continue;
    seenMints.add(sig.mint_address);
    const r = simulatePosition(strat, sig);
    if (r) results.push(r);
  }

  return summarize(strategyName, signals.length, results);
}

function summarize(name, signalCount, results) {
  const positions = results.length;
  const wins = results.filter(r => r.realizedPnlSol > 0);
  const losses = results.filter(r => r.realizedPnlSol < 0);
  const flats = results.filter(r => r.realizedPnlSol === 0);
  const totalPnl = results.reduce((s, r) => s + r.realizedPnlSol, 0);
  const totalEntered = results.reduce((s, r) => s + r.entrySol, 0);
  const winRate = positions > 0 ? wins.length / positions : 0;
  const avgWin = wins.length ? wins.reduce((s, r) => s + r.realizedPnlSol, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + r.realizedPnlSol, 0) / losses.length : 0;
  const bestWin = wins.length ? Math.max(...wins.map(r => r.realizedPnlSol)) : 0;
  const worstLoss = losses.length ? Math.min(...losses.map(r => r.realizedPnlSol)) : 0;
  const avgHoldMin = positions ? results.reduce((s, r) => s + r.holdMinutes, 0) / positions : 0;
  const reasons = {};
  for (const r of results) reasons[r.exitReason] = (reasons[r.exitReason] || 0) + 1;
  const rrRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  return {
    strategy: name,
    signalCount,
    positions,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    winRate,
    totalEntered: +totalEntered.toFixed(4),
    totalPnlSol: +totalPnl.toFixed(4),
    roi: totalEntered > 0 ? totalPnl / totalEntered : 0,
    avgWin: +avgWin.toFixed(4),
    avgLoss: +avgLoss.toFixed(4),
    rrRatio: +rrRatio.toFixed(2),
    bestWin: +bestWin.toFixed(4),
    worstLoss: +worstLoss.toFixed(4),
    avgHoldMin: +avgHoldMin.toFixed(1),
    exitReasons: reasons,
  };
}

export function backtestAll({ enabledOnly = true } = {}) {
  const out = {};
  const triggers = getStrategyTriggers();
  const d = db();
  for (const name of Object.keys(triggers)) {
    if (enabledOnly) {
      const row = d.prepare('SELECT enabled FROM strategy_state WHERE name = ?').get(name);
      if (!row || !row.enabled) continue;
    }
    out[name] = backtestStrategy(name);
  }
  return out;
}
