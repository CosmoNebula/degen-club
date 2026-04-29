import { db } from '../db/index.js';
import { config } from '../config.js';
import { isLiveMode } from './wallet.js';
import { shouldForceExit as kingShouldForceExit, kingHasBoughtSince } from './king-tracker.js';

const _pendingSells = new Set();
const _pendingPaperSells = new Set();

function appendSellEvent(positionId, event) {
  try {
    const d = db();
    const row = d.prepare('SELECT sell_events FROM paper_positions WHERE id = ?').get(positionId);
    let events = [];
    try { events = JSON.parse(row?.sell_events || '[]'); } catch {}
    events.push(event);
    d.prepare('UPDATE paper_positions SET sell_events = ? WHERE id = ?').run(JSON.stringify(events), positionId);
  } catch (err) { console.error('[sell-event]', err.message); }
}

let cached = null;
function S() {
  if (cached) return cached;
  const d = db();
  cached = {
    getMint: d.prepare('SELECT * FROM mints WHERE mint_address = ?'),
    insertPosition: d.prepare(`INSERT INTO paper_positions
      (mint_address, strategy, entry_signal, entry_price, entry_sol, token_amount,
       tokens_remaining, sol_realized_so_far, tiers_hit, breakeven_armed,
       entry_mcap_sol, status, entered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]', 0, ?, 'open', ?, ?)`),
    bumpOpened: d.prepare('UPDATE strategy_state SET positions_opened = positions_opened + 1 WHERE name = ?'),
    openPositions: d.prepare("SELECT * FROM paper_positions WHERE status = 'open'"),
    closePosition: d.prepare(`UPDATE paper_positions SET
      status = 'closed', exit_price = ?, exit_mcap_sol = ?, exit_reason = ?,
      realized_pnl_sol = ?, realized_pnl_pct = ?, exited_at = ?, updated_at = ?
      WHERE id = ?`),
    updateTierHit: d.prepare(`UPDATE paper_positions SET
      tokens_remaining = ?, sol_realized_so_far = ?, tiers_hit = ?, breakeven_armed = ?, updated_at = ?
      WHERE id = ?`),
    bumpWin: d.prepare('UPDATE strategy_state SET wins = wins + 1, total_pnl_sol = total_pnl_sol + ? WHERE name = ?'),
    bumpLoss: d.prepare('UPDATE strategy_state SET losses = losses + 1, total_pnl_sol = total_pnl_sol + ? WHERE name = ?'),
    bumpFlat: d.prepare('UPDATE strategy_state SET total_pnl_sol = total_pnl_sol + ? WHERE name = ?'),
    updateUnrealized: d.prepare(`UPDATE paper_positions SET
      unrealized_pnl_sol = ?, unrealized_pnl_pct = ?,
      highest_pct = MAX(highest_pct, ?), updated_at = ?
      WHERE id = ?`),
    getStrategy: d.prepare('SELECT * FROM strategy_state WHERE name = ?'),
    openPositionsForMint: d.prepare("SELECT * FROM paper_positions WHERE mint_address = ? AND status = 'open'"),
    convertToMoonbag: d.prepare(`UPDATE paper_positions SET
      tokens_remaining = ?, sol_realized_so_far = ?,
      is_moonbag = 1, moonbag_started_at = ?,
      migration_price = ?, migration_mcap_sol = ?,
      moonbag_peak_pct = 0, updated_at = ?
      WHERE id = ?`),
    updateMoonbagPeak: d.prepare(`UPDATE paper_positions SET
      moonbag_peak_pct = MAX(moonbag_peak_pct, ?),
      unrealized_pnl_sol = ?, unrealized_pnl_pct = ?,
      updated_at = ?
      WHERE id = ?`),
  };
  return cached;
}

function applyBuyFriction(solIn, price) {
  const f = config.friction || {};
  const priority = f.priorityFeeSol || 0;
  const fee = f.feePct || 0;
  const slip = f.slippagePct || 0;
  const effectiveSol = Math.max(0, solIn - priority);
  const effectivePrice = price * (1 + slip);
  const tokens = (effectiveSol * (1 - fee)) / effectivePrice;
  return { tokens, costSol: solIn };
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

export function openPaperPosition({ strategy, mintAddress, entryPrice, entrySol, entryMcap, signalDetails, entryScore, positionMode = 'paper' }) {
  if (!entryPrice || entryPrice <= 0) return null;
  const maxPerTrade = config.safety?.maxPerTradeSol || 0.5;
  if (entrySol > maxPerTrade) {
    console.log(`[size-cap] ${strategy} on ${mintAddress.slice(0,8)}… clamped ${entrySol.toFixed(4)} → ${maxPerTrade.toFixed(4)} SOL (maxPerTradeSol)`);
    entrySol = maxPerTrade;
  }
  const s = S();
  let tokenAmount, finalEntryPrice = entryPrice, finalEntrySol = entrySol;

  if (positionMode === 'live') {
    const now = Date.now();
    const result = s.insertPosition.run(
      mintAddress, strategy, JSON.stringify({ ...(signalDetails || {}), pending: true }),
      entryPrice, entrySol, 0, 0, entryMcap || 0, now, now
    );
    const positionId = result.lastInsertRowid;
    db().prepare("UPDATE paper_positions SET position_mode = 'live', pending_fill = 1 WHERE id = ?").run(positionId);
    if (entryScore && entryScore !== 1.0) {
      db().prepare('UPDATE paper_positions SET entry_score = ? WHERE id = ?').run(entryScore, positionId);
    }
    console.log(`[live] PENDING ${strategy} on ${mintAddress.slice(0,8)}… firing buy ${entrySol.toFixed(4)} SOL`);
    import('./executor.js').then(async exec => {
      const r = await exec.executeBuy({ mint: mintAddress, solAmount: entrySol, strategy, triggerPrice: entryPrice, force: true });
      const updNow = Date.now();
      if (!r.success) {
        db().prepare(`UPDATE paper_positions SET status = 'closed', exit_reason = ?, exited_at = ?, updated_at = ?, realized_pnl_sol = 0, realized_pnl_pct = 0, pending_fill = 0 WHERE id = ?`)
          .run(`LIVE_BUY_FAIL:${(r.error || 'unknown').slice(0, 60)}`, updNow, updNow, positionId);
        console.log(`[live] BUY FAIL ${strategy} on ${mintAddress.slice(0,8)}… ${r.error || 'unknown'} — placeholder closed`);
        return;
      }
      const realPrice = r.fillPrice || entryPrice;
      const realTokens = r.tokensReceived || 0;
      db().prepare(`UPDATE paper_positions SET
        entry_price = ?, entry_sol = ?, token_amount = ?, tokens_remaining = ?,
        entry_signal = ?, pending_fill = 0, updated_at = ?
        WHERE id = ?`).run(
        realPrice, r.solSpent || entrySol, realTokens, realTokens,
        JSON.stringify({ ...(signalDetails || {}), txSig: r.txSig, fillPrice: realPrice }),
        updNow, positionId
      );
      s.bumpOpened.run(strategy);
      console.log(`[live] OPEN ${strategy} on ${mintAddress.slice(0,8)}… ${realTokens} tokens @ ${realPrice.toExponential(3)} (${(r.solSpent || entrySol).toFixed(4)} SOL paid, tx ${r.txSig?.slice(0,8)}…)`);
    }).catch(err => {
      const updNow = Date.now();
      try {
        db().prepare(`UPDATE paper_positions SET status = 'closed', exit_reason = 'LIVE_BUY_THROW', exited_at = ?, updated_at = ?, realized_pnl_sol = 0, pending_fill = 0 WHERE id = ?`).run(updNow, updNow, positionId);
      } catch {}
      console.error('[live] open threw', err.message);
    });
    return positionId;
  }

  const paperLatencyMs = Math.max(0, config.paper?.latencyMs || 0);
  if (paperLatencyMs > 0) {
    const now = Date.now();
    const insertResult = s.insertPosition.run(
      mintAddress, strategy, JSON.stringify({ ...(signalDetails || {}), pending: true, triggerPrice: entryPrice }),
      entryPrice, entrySol, 0, 0, entryMcap || 0, now, now
    );
    const positionId = insertResult.lastInsertRowid;
    db().prepare("UPDATE paper_positions SET pending_fill = 1 WHERE id = ?").run(positionId);
    if (entryScore && entryScore !== 1.0) {
      db().prepare('UPDATE paper_positions SET entry_score = ? WHERE id = ?').run(entryScore, positionId);
    }
    console.log(`[paper-lat] PENDING ${strategy} on ${mintAddress.slice(0,8)}… defer ${paperLatencyMs}ms (trigger ${entryPrice.toExponential(3)})`);
    setTimeout(() => {
      try {
        const m = s.getMint.get(mintAddress);
        const fillPrice = (m && m.last_price_sol > 0) ? m.last_price_sol : entryPrice;
        const drift = (fillPrice - entryPrice) / entryPrice;
        const maxDrift = config.safety?.maxEntrySlippagePct ?? 0.17;
        if (drift > maxDrift) {
          const updNow = Date.now();
          db().prepare(`UPDATE paper_positions SET status = 'closed', exit_reason = ?, exited_at = ?, updated_at = ?, realized_pnl_sol = 0, realized_pnl_pct = 0, pending_fill = 0 WHERE id = ?`)
            .run(`STALE_QUOTE_PAPER:${(drift*100).toFixed(1)}%`, updNow, updNow, positionId);
          console.log(`[paper-lat] BUY ABORT ${strategy} on ${mintAddress.slice(0,8)}… STALE_QUOTE drift ${(drift*100).toFixed(1)}% > ${(maxDrift*100).toFixed(1)}%`);
          return;
        }
        const { tokens } = applyBuyFriction(entrySol, fillPrice);
        if (tokens <= 0) {
          const updNow = Date.now();
          db().prepare(`UPDATE paper_positions SET status = 'closed', exit_reason = 'BAD_FILL', exited_at = ?, updated_at = ?, pending_fill = 0 WHERE id = ?`).run(updNow, updNow, positionId);
          return;
        }
        const updNow = Date.now();
        db().prepare(`UPDATE paper_positions SET
          entry_price = ?, token_amount = ?, tokens_remaining = ?,
          entry_signal = ?, pending_fill = 0, updated_at = ?
          WHERE id = ?`).run(
          fillPrice, tokens, tokens,
          JSON.stringify({ ...(signalDetails || {}), triggerPrice: entryPrice, fillPrice, driftPct: drift, latencyMs: paperLatencyMs }),
          updNow, positionId
        );
        s.bumpOpened.run(strategy);
        console.log(`[paper-lat] OPEN ${strategy} on ${mintAddress.slice(0,8)}… @ ${fillPrice.toExponential(3)} (drift ${(drift*100).toFixed(1)}%, ${entrySol.toFixed(4)} SOL)`);
      } catch (err) {
        console.error('[paper-lat] fill threw:', err.message);
      }
    }, paperLatencyMs);
    return positionId;
  }

  ({ tokens: tokenAmount } = applyBuyFriction(entrySol, entryPrice));
  if (tokenAmount <= 0) return null;
  const now = Date.now();
  const result = s.insertPosition.run(
    mintAddress, strategy, JSON.stringify(signalDetails || {}),
    entryPrice, entrySol, tokenAmount, tokenAmount, entryMcap || 0, now, now
  );
  s.bumpOpened.run(strategy);
  if (entryScore && entryScore !== 1.0) {
    db().prepare('UPDATE paper_positions SET entry_score = ? WHERE id = ?').run(entryScore, result.lastInsertRowid);
  }
  console.log(`[paper] OPEN ${strategy} on ${mintAddress.slice(0, 8)}… @ ${entryPrice.toExponential(3)} SOL/tok (${entrySol.toFixed(4)} SOL${entryScore && entryScore !== 1.0 ? ` · ${entryScore.toFixed(2)}x` : ''})`);
  return result.lastInsertRowid;
}

function finalizePosition(p, exitPrice, exitMcap, exitReason) {
  const s = S();
  let finalSol;
  if (p.position_mode === 'live') {
    if (_pendingSells.has(p.id)) return;
    _pendingSells.add(p.id);
    import('./executor.js').then(async exec => {
      const fresh = db().prepare('SELECT tokens_remaining, sol_realized_so_far FROM paper_positions WHERE id = ?').get(p.id);
      const realizedSoFar = fresh?.sol_realized_so_far || 0;
      const r = await exec.executeSell({ mint: p.mint_address, pct: 1.0, reason: exitReason, force: true });
      const liveSol = r.success ? (r.solReceived || 0) : 0;
      const total = realizedSoFar + liveSol;
      const pnlSol = total - p.entry_sol;
      const pnlPct = pnlSol / p.entry_sol;
      const now = Date.now();
      s.closePosition.run(exitPrice, exitMcap || 0, exitReason, pnlSol, pnlPct, now, now, p.id);
      appendSellEvent(p.id, { r: exitReason, m: exitMcap || 0, s: liveSol });
      if (pnlSol > 0) s.bumpWin.run(pnlSol, p.strategy);
      else if (pnlSol < 0) s.bumpLoss.run(pnlSol, p.strategy);
      else s.bumpFlat.run(pnlSol, p.strategy);
      console.log(`[live] CLOSE ${p.strategy} on ${p.mint_address.slice(0,8)}… ${exitReason} ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${(pnlPct*100).toFixed(1)}%) tx=${r.txSig?.slice(0,8) || 'none'}`);
    }).catch(err => console.error('[live] close failed', err.message))
      .finally(() => _pendingSells.delete(p.id));
    return;
  }
  finalSol = applySellFriction(p.tokens_remaining || 0, exitPrice);
  const totalRealized = (p.sol_realized_so_far || 0) + finalSol;
  const realizedPnlSol = totalRealized - p.entry_sol;
  const realizedPnlPct = realizedPnlSol / p.entry_sol;
  const now = Date.now();
  s.closePosition.run(
    exitPrice, exitMcap || 0, exitReason,
    realizedPnlSol, realizedPnlPct, now, now,
    p.id
  );
  appendSellEvent(p.id, { r: exitReason, m: exitMcap || 0, s: finalSol });
  if (realizedPnlSol > 0) s.bumpWin.run(realizedPnlSol, p.strategy);
  else if (realizedPnlSol < 0) s.bumpLoss.run(realizedPnlSol, p.strategy);
  else s.bumpFlat.run(realizedPnlSol, p.strategy);
  console.log(`[paper] CLOSE ${p.strategy} on ${p.mint_address.slice(0, 8)}… ${exitReason} ${realizedPnlSol >= 0 ? '+' : ''}${realizedPnlSol.toFixed(4)} SOL (${(realizedPnlPct * 100).toFixed(1)}%)`);
}

function fireTier(p, tierIdx, tierPctSell, currentPrice, currentMcap) {
  const s = S();
  const sellTokens = Math.min(p.token_amount * tierPctSell, p.tokens_remaining);
  if (sellTokens <= 0) return p;
  let solReceived;
  if (p.position_mode === 'live') {
    if (_pendingSells.has(p.id)) return p;
    _pendingSells.add(p.id);
    const tierPct = Math.min(1, sellTokens / Math.max(1, p.tokens_remaining));
    import('./executor.js').then(async exec => {
      const r = await exec.executeSell({ mint: p.mint_address, pct: tierPct, reason: `TIER_${tierIdx}`, force: true });
      const liveSol = r.success ? (r.solReceived || 0) : 0;
      const tokensSold = r.success ? (r.tokensSold || sellTokens) : 0;
      const fresh = db().prepare('SELECT tokens_remaining, sol_realized_so_far, tiers_hit, breakeven_armed FROM paper_positions WHERE id = ?').get(p.id);
      const newRem = Math.max(0, (fresh?.tokens_remaining || 0) - tokensSold);
      const newReal = (fresh?.sol_realized_so_far || 0) + liveSol;
      let tiers = []; try { tiers = JSON.parse(fresh?.tiers_hit || '[]'); } catch {}
      if (r.success) tiers.push(`TIER_${tierIdx}`);
      const be = (tierIdx === 1 && p._breakeven_after_tier1 && r.success) ? 1 : (fresh?.breakeven_armed || 0);
      s.updateTierHit.run(newRem, newReal, JSON.stringify(tiers), be, Date.now(), p.id);
      if (r.success) {
        const liveMint = db().prepare('SELECT current_market_cap_sol FROM mints WHERE mint_address = ?').get(p.mint_address);
        appendSellEvent(p.id, { r: `TIER_${tierIdx}`, m: liveMint?.current_market_cap_sol || 0, s: liveSol });
        console.log(`[live] TIER_${tierIdx} ${p.strategy} on ${p.mint_address.slice(0,8)}… +${liveSol.toFixed(4)} SOL`);
      } else console.log(`[live] TIER_${tierIdx} FAIL ${p.strategy} on ${p.mint_address.slice(0,8)}… ${r.error || 'unknown'}`);
    }).catch(err => console.error('[live] tier failed', err.message))
      .finally(() => _pendingSells.delete(p.id));
    return p;
  }
  const paperLatencyMs = Math.max(0, config.paper?.latencyMs || 0);
  if (paperLatencyMs > 0 && !_pendingPaperSells.has(p.id)) {
    _pendingPaperSells.add(p.id);
    const triggerPrice = currentPrice;
    const triggerTier = tierIdx;
    const triggerPctSell = tierPctSell;
    const triggerBeFlag = p._breakeven_after_tier1;
    setTimeout(() => {
      try {
        const fresh = db().prepare('SELECT tokens_remaining, sol_realized_so_far, tiers_hit, breakeven_armed FROM paper_positions WHERE id = ?').get(p.id);
        const m = s.getMint.get(p.mint_address);
        const fillPrice = (m && m.last_price_sol > 0) ? m.last_price_sol : triggerPrice;
        const sellNow = Math.min(p.token_amount * triggerPctSell, fresh?.tokens_remaining || 0);
        if (sellNow <= 0) return;
        const drift = (fillPrice - triggerPrice) / Math.max(1e-30, triggerPrice);
        const sol = applySellFriction(sellNow, fillPrice);
        const newRem = Math.max(0, (fresh?.tokens_remaining || 0) - sellNow);
        const newReal = (fresh?.sol_realized_so_far || 0) + sol;
        let tiers = []; try { tiers = JSON.parse(fresh?.tiers_hit || '[]'); } catch {}
        tiers.push(`TIER_${triggerTier}`);
        const be = (triggerTier === 1 && triggerBeFlag) ? 1 : (fresh?.breakeven_armed || 0);
        s.updateTierHit.run(newRem, newReal, JSON.stringify(tiers), be, Date.now(), p.id);
        appendSellEvent(p.id, { r: `TIER_${triggerTier}`, m: m?.current_market_cap_sol || 0, s: sol, drift });
        console.log(`[paper-lat] TIER_${triggerTier} ${p.strategy} on ${p.mint_address.slice(0,8)}… defer ${paperLatencyMs}ms · drift ${(drift*100).toFixed(2)}% · +${sol.toFixed(4)} SOL`);
      } catch (err) {
        console.error('[paper-lat] tier fill threw:', err.message);
      } finally {
        _pendingPaperSells.delete(p.id);
      }
    }, paperLatencyMs);
    return p;
  }

  solReceived = applySellFriction(sellTokens, currentPrice);
  const newRemaining = Math.max(0, p.tokens_remaining - sellTokens);
  const newRealized = (p.sol_realized_so_far || 0) + solReceived;
  let tiers = [];
  try { tiers = JSON.parse(p.tiers_hit || '[]'); } catch {}
  tiers.push(`TIER_${tierIdx}`);
  const breakeven = (tierIdx === 1 && p._breakeven_after_tier1) ? 1 : (p.breakeven_armed || 0);
  s.updateTierHit.run(newRemaining, newRealized, JSON.stringify(tiers), breakeven, Date.now(), p.id);
  appendSellEvent(p.id, { r: `TIER_${tierIdx}`, m: currentMcap || 0, s: solReceived });
  console.log(`[paper] TIER_${tierIdx} ${p.strategy} on ${p.mint_address.slice(0, 8)}… sold ${(tierPctSell*100).toFixed(0)}% of bag for +${solReceived.toFixed(4)} SOL`);
  return { ...p, tokens_remaining: newRemaining, sol_realized_so_far: newRealized, tiers_hit: JSON.stringify(tiers), breakeven_armed: breakeven };
}

function convertToMoonbag(p, m) {
  const s = S();
  const cfg = config.moonbag;
  const now = Date.now();
  const sellTokens = (p.tokens_remaining || 0) * cfg.sellPctAtMigration;
  const sellPrice = m.last_price_sol || p.entry_price;
  const sellSol = applySellFriction(sellTokens, sellPrice);
  const newRemaining = (p.tokens_remaining || 0) - sellTokens;
  const newRealized = (p.sol_realized_so_far || 0) + sellSol;

  s.convertToMoonbag.run(
    newRemaining, newRealized, now,
    sellPrice, m.current_market_cap_sol || 0, now,
    p.id
  );
  console.log(`[moonbag] CONVERT ${p.strategy} on ${p.mint_address.slice(0, 8)}… sold ${(cfg.sellPctAtMigration*100).toFixed(0)}% @ migration for +${sellSol.toFixed(4)} SOL · keeping ${((1-cfg.sellPctAtMigration)*100).toFixed(0)}% bag for ride`);
}

function checkMoonbag(p, m) {
  const s = S();
  const cfg = config.moonbag;
  const now = Date.now();
  if (!p.migration_price || p.migration_price <= 0) return;
  const currentPrice = m.last_price_sol || p.migration_price;
  const moonbagPct = (currentPrice - p.migration_price) / p.migration_price;
  const moonbagPeak = Math.max(p.moonbag_peak_pct || 0, moonbagPct);
  const ageHours = (now - (p.moonbag_started_at || now)) / 3600000;

  let exitReason = null;
  if (m.rugged) exitReason = 'MOONBAG_RUG';
  else if (moonbagPct >= cfg.hardTargetPct) exitReason = 'MOONBAG_TARGET';
  else if (moonbagPct <= cfg.hardSlPct) exitReason = 'MOONBAG_SL';
  else if (moonbagPeak >= cfg.armTrailAtPct && moonbagPct <= moonbagPeak - cfg.trailPct) exitReason = 'MOONBAG_TRAIL';
  else if (ageHours >= cfg.maxHoldHours) exitReason = 'MOONBAG_TIME';

  if (exitReason) {
    finalizePosition(p, currentPrice, m.current_market_cap_sol || 0, exitReason);
    return;
  }
  const remainingValue = (p.tokens_remaining || 0) * currentPrice;
  const totalUnrealized = (p.sol_realized_so_far || 0) + remainingValue - p.entry_sol;
  const totalUnrealizedPct = totalUnrealized / p.entry_sol;
  s.updateMoonbagPeak.run(moonbagPeak, totalUnrealized, totalUnrealizedPct, now, p.id);
}

function checkPosition(p) {
  const s = S();
  const now = Date.now();
  if (p.pending_fill) return;
  if (p.position_mode === 'live' && _pendingSells.has(p.id)) return;
  if (_pendingPaperSells.has(p.id)) return;
  const m = s.getMint.get(p.mint_address);
  if (!m) return;

  if (p.is_moonbag) {
    return checkMoonbag(p, m);
  }

  if (m.migrated && config.moonbag.enabled && (p.tokens_remaining || 0) > 0) {
    convertToMoonbag(p, m);
    return;
  }

  const strat = s.getStrategy.get(p.strategy);
  if (!strat) return;

  const currentPrice = m.last_price_sol || p.entry_price;
  const peakPctRaw = (currentPrice - p.entry_price) / p.entry_price;
  const ageMin = (now - p.entered_at) / 60000;
  const minutesSinceLastTrade = m.last_trade_at ? (now - m.last_trade_at) / 60000 : ageMin;
  const tiers = (() => { try { return JSON.parse(p.tiers_hit || '[]'); } catch { return []; } })();

  const t1Hit = tiers.includes('TIER_1');
  const t2Hit = tiers.includes('TIER_2');
  const t3Hit = tiers.includes('TIER_3');

  p._breakeven_after_tier1 = strat.breakeven_after_tier1;

  const cashbackBoost = (m.cashback_enabled === 1 && (strat.cashback_trigger_boost || 1.0) > 1.0)
    ? strat.cashback_trigger_boost : 1.0;
  const t1Trig = strat.tier1_trigger_pct * cashbackBoost;
  const t2Trig = strat.tier2_trigger_pct * cashbackBoost;
  const t3Trig = strat.tier3_trigger_pct * cashbackBoost;

  if (!t1Hit && peakPctRaw >= t1Trig) {
    p = fireTier(p, 1, strat.tier1_sell_pct, currentPrice, m.current_market_cap_sol || 0);
  }
  if (!t2Hit && peakPctRaw >= t2Trig) {
    p = fireTier(p, 2, strat.tier2_sell_pct, currentPrice, m.current_market_cap_sol || 0);
  }
  if (!t3Hit && peakPctRaw >= t3Trig && (strat.tier3_trail_pct || 0) <= 0) {
    p = fireTier(p, 3, strat.tier3_sell_pct, currentPrice, m.current_market_cap_sol || 0);
  }

  const tiersAfter = (() => { try { return JSON.parse(p.tiers_hit || '[]'); } catch { return []; } })();
  const t3Armed = tiersAfter.includes('TIER_3') ? false : (peakPctRaw >= t3Trig && (strat.tier3_trail_pct || 0) > 0);
  const breakevenArmed = !!p.breakeven_armed;

  const peakFromEntry = Math.max(p.highest_pct || 0, peakPctRaw);
  const tier3TrailFloor = peakFromEntry - (strat.tier3_trail_pct || 0);

  let exitReason = null;
  const beArmPct = strat.breakeven_arm_pct || 0;
  const beActive = breakevenArmed && peakFromEntry >= beArmPct;
  const postT1TrailPct = strat.tp_trail_pct || 0;
  const postT1ArmPct = strat.tp_trail_arm_pct || 0;
  const trailArmed = breakevenArmed && postT1TrailPct > 0 && peakFromEntry >= postT1ArmPct;
  const postT1TrailFloor = trailArmed
    ? Math.max(0, peakFromEntry - postT1TrailPct)
    : null;

  const ageSec = (Date.now() - p.entered_at) / 1000;
  const fastFailSec = strat.fast_fail_sec || 0;
  const fastFailMinPeak = strat.fast_fail_min_peak_pct || 0;
  const fastFailSl = strat.fast_fail_sl_pct || 0;
  const fastFailActive = !breakevenArmed && fastFailSec > 0 &&
    ageSec >= fastFailSec && peakFromEntry < fastFailMinPeak;

  const fakeSec = strat.fakepump_sec || 0;
  const fakeMinPeak = strat.fakepump_min_peak_pct || 0;
  const fakeSl = strat.fakepump_sl_pct || 0;
  const fakePumpActive = !breakevenArmed && fakeSec > 0 &&
    ageSec >= fakeSec && peakFromEntry < fakeMinPeak;

  const flatMin = strat.flat_exit_min || 0;
  const flatMaxPeak = strat.flat_exit_max_peak_pct || 0;
  const flatActive = flatMin > 0 && ageMin >= flatMin && peakFromEntry < flatMaxPeak;

  const pfLevels = [
    { arm: strat.peak_floor_arm_pct || 0, exit: strat.peak_floor_exit_pct || 0 },
    { arm: strat.peak_floor_arm2_pct || 0, exit: strat.peak_floor_exit2_pct || 0 },
    { arm: strat.peak_floor_arm3_pct || 0, exit: strat.peak_floor_exit3_pct || 0 },
  ].filter(l => l.arm > 0).sort((a, b) => b.arm - a.arm);
  const armedLevel = pfLevels.find(l => peakFromEntry >= l.arm);
  const peakFloorActive = !!armedLevel;
  const peakFloorExit = armedLevel ? armedLevel.exit : 0;

  if (p.strategy === 'kingFollow') {
    const kingExit = kingShouldForceExit(p.mint_address, p.entered_at);
    if (kingExit) {
      console.log(`[king-exit] ${p.mint_address.slice(0,8)}… ${kingExit.wallet.slice(0,6)}… dumped ${(kingExit.sellRatio*100).toFixed(0)}% of bag (${kingExit.sellCount} sells, ${kingExit.soldSol.toFixed(2)}/${kingExit.boughtSol.toFixed(2)} SOL) — exiting`);
      exitReason = 'KING_DUMPED';
    }
  }
  if (p.strategy === 'preKing') {
    const kingBuy = kingHasBoughtSince(p.mint_address, p.entered_at);
    if (kingBuy) {
      console.log(`[preKing] 👑 ${kingBuy.wallet.slice(0,6)}… bought ${p.mint_address.slice(0,8)}… (we entered ${((kingBuy.kingBuyAt - p.entered_at)/1000).toFixed(1)}s earlier) — front-run hit, exiting into pump`);
      exitReason = 'KING_BOUGHT';
    }
  }
  if (exitReason) { /* king-dump already set — skip the rest */ }
  else if (m.rugged) exitReason = 'RUGGED';
  else if (m.migrated) exitReason = 'MIGRATED';
  else if ((p.tokens_remaining || 0) <= 0) exitReason = 'TIERED_FULL';
  else if (t3Armed && peakPctRaw <= tier3TrailFloor) exitReason = 'TP_TRAIL';
  else if (postT1TrailFloor !== null && peakPctRaw <= postT1TrailFloor) exitReason = 'POST_T1_TRAIL';
  else if (peakFloorActive && peakPctRaw < peakFloorExit) exitReason = 'PEAK_FLOOR';
  else if (beActive && !trailArmed && peakPctRaw <= (strat.breakeven_floor_pct || 0)) exitReason = 'BREAKEVEN_SL';
  else if (fastFailActive && peakPctRaw <= fastFailSl) exitReason = 'FAST_FAIL';
  else if (fakePumpActive && peakPctRaw <= fakeSl) exitReason = 'FAKE_PUMP';
  else if (flatActive) exitReason = 'FLAT_EXIT';
  else if (!breakevenArmed && peakPctRaw <= strat.sl_pct) exitReason = 'SL_HIT';
  else if (
    strat.stagnant_exit_min > 0 &&
    minutesSinceLastTrade >= strat.stagnant_exit_min &&
    peakPctRaw <= strat.stagnant_loss_pct
  ) exitReason = 'STAGNATED';
  else if (ageMin >= strat.max_hold_min) exitReason = 'TIME_EXIT';

  if (exitReason) {
    finalizePosition(p, currentPrice, m.current_market_cap_sol || 0, exitReason);
  } else {
    const remaining = p.tokens_remaining || 0;
    const remainingValue = remaining * currentPrice;
    const totalUnrealized = (p.sol_realized_so_far || 0) + remainingValue - p.entry_sol;
    const totalUnrealizedPct = totalUnrealized / p.entry_sol;
    s.updateUnrealized.run(totalUnrealized, totalUnrealizedPct, peakFromEntry, now, p.id);
  }
}

export function monitorPositions() {
  const s = S();
  const opens = s.openPositions.all();
  if (!opens.length) return;
  for (const p of opens) {
    try { checkPosition(p); } catch (err) { console.error('[paper] monitor', err.message); }
  }
}

export function checkPositionsForMint(mintAddress) {
  const s = S();
  const opens = s.openPositionsForMint.all(mintAddress);
  if (!opens.length) return;
  for (const p of opens) {
    try { checkPosition(p); } catch (err) { console.error('[paper] checkForMint', err.message); }
  }
}

export function startPositionMonitor() {
  setInterval(monitorPositions, config.strategies.monitorIntervalMs);
}
