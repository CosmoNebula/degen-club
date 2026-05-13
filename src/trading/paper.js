import { db } from '../db/index.js';
import { config } from '../config.js';
import { isLiveMode } from './wallet.js';
import { getMedianLatency, getPriorityFeeSol } from '../scoring/live-conditions.js';
import { estimateBuyFriction, estimateSellFriction } from '../scoring/mint-microstructure.js';
import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const _pendingSells = new Set();
const _pendingPaperSells = new Set();

// Track strategies we've already warned about for peak-floor misconfig so the
// log doesn't spam every 250ms tick on a broken config.
const _peakFloorWarned = new Set();
// Same idea for tier ladder inversions (t2<=t1, t3<=t2). A broken ladder
// means earlier tiers absorb fills meant for later tiers — peaked30 quickflip
// shipped with t1=10% t2=80% t3=50% on 2026-05-10, masking real moonbag carve.
const _tierLadderWarned = new Set();
// And for FAST_FAIL/FAKE_PUMP params that go dead after tier1 fires.
const _fastFailWarned = new Set();

// Effective paper latency. Defaults to live-measured Helius p90 — replaces the
// old static config.paper.latencyMs guess. If the dashboard explicitly sets
// config.paper.latencyMs > 0, that override wins (manual control). Otherwise
// the bot uses whatever the network is doing right now.
//
// REALISM CAP: real Solana confirmation is 1-2 slots = 400-800ms typical,
// ~3s worst case during congestion. When the RPC probe times out (5-15s+),
// that's a PROBE failure, not real execution latency — a real trader would
// see a timeout error and retry on a different RPC, not actually wait 15s.
// Capping at 3000ms keeps paper simulation grounded in plausible execution.
const MAX_REALISTIC_PAPER_LAG_MS = 3000;
function effectiveLatencyMs() {
  const override = config.paper?.latencyMs;
  if (override != null && override > 0) return Math.min(Math.round(override), MAX_REALISTIC_PAPER_LAG_MS);
  const measured = Math.max(0, Math.round(getMedianLatency('helius')));
  return Math.min(measured, MAX_REALISTIC_PAPER_LAG_MS);
}

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
    // Atomic tier-fire UPDATE — refuses to apply if this tier is already
    // present in tiers_hit. Defends against any concurrent fireTier path
    // (duplicate processes, future race conditions, recovery edge cases).
    // The last param is the LIKE pattern, e.g. '%"TIER_1"%'. If the row's
    // current tiers_hit matches, UPDATE matches 0 rows — caller checks
    // result.changes to decide whether to record the sell.
    updateTierHit: d.prepare(`UPDATE paper_positions SET
      tokens_remaining = ?, sol_realized_so_far = ?, tiers_hit = ?, breakeven_armed = ?, updated_at = ?
      WHERE id = ? AND tiers_hit NOT LIKE ?`),
    bumpWin: d.prepare('UPDATE strategy_state SET wins = wins + 1, total_pnl_sol = total_pnl_sol + ? WHERE name = ?'),
    bumpLoss: d.prepare('UPDATE strategy_state SET losses = losses + 1, total_pnl_sol = total_pnl_sol + ? WHERE name = ?'),
    bumpFlat: d.prepare('UPDATE strategy_state SET total_pnl_sol = total_pnl_sol + ? WHERE name = ?'),
    updateUnrealized: d.prepare(`UPDATE paper_positions SET
      unrealized_pnl_sol = ?, unrealized_pnl_pct = ?,
      highest_pct = MAX(highest_pct, ?), updated_at = ?
      WHERE id = ?`),
    getStrategy: d.prepare('SELECT * FROM strategy_state WHERE name = ?'),
    // Most-recent inflow_accel_pct for a mint — feeds the momentum-confirmed
    // staying-power gate on STAGNATED. Snapshots fire at age 60s/300s/900s/3600s
    // so the freshest one is at most ~hour old; for the typical position
    // lifetime (~5-30min), the 60s or 300s snapshot's velocity is current.
    getRecentVelocity: d.prepare(`SELECT inflow_accel_pct FROM ml_mint_snapshots
      WHERE mint_address = ? ORDER BY snapshot_ts DESC LIMIT 1`),
    // DCA scale-in: applies an averaging-down buy to an existing position.
    // Updates entry_price (weighted avg), entry_sol (cumulative cost basis),
    // token_amount + tokens_remaining (add new tokens), and resets the
    // tier ladder + breakeven so the new bag can fire tiers again on
    // recovery. Stores the DCA event in sell_events JSON for auditability.
    applyDca: d.prepare(`UPDATE paper_positions SET
      entry_price = ?, entry_sol = ?, token_amount = ?, tokens_remaining = ?,
      tiers_hit = '[]', breakeven_armed = 0, highest_pct = 0,
      dca_count = dca_count + 1, dca_total_sol_added = dca_total_sol_added + ?,
      sell_events = ?, updated_at = ?
      WHERE id = ?`),
    // Per-mint DCA safety re-check: freshest probabilities for the rug-side
    // targets. If the model thinks this is rugging RIGHT NOW, we don't add
    // more capital — the dip is real, not an opportunity. ml_predictions is
    // appended to every snapshot + every scoring sweep, so the freshest row
    // per target is current within ~60s.
    getDcaSafety: d.prepare(`SELECT
        MAX(CASE WHEN target='rug_within_5min' THEN prob END) AS p_rug5,
        MAX(CASE WHEN target='will_die_fast' THEN prob END) AS p_die_fast,
        MAX(CASE WHEN target='peaked_100' THEN prob END) AS p_peaked_100
      FROM (
        SELECT target, prob FROM ml_predictions
        WHERE mint_address = ? AND prob IS NOT NULL
          AND target IN ('rug_within_5min','will_die_fast','peaked_100')
          AND timestamp > (strftime('%s','now')*1000 - 600000)
        ORDER BY timestamp DESC LIMIT 30
      )`),
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

// Dynamic friction model — when mintAddress is provided, compute per-mint
// per-network friction from microstructure + live conditions. Fall back to
// static config.friction otherwise (preserves existing behavior for callers
// that don't have mint context).
//
// Components when dynamic:
//   - slippage: exact bonding-curve math (bondingCurveSlippageBuy/Sell)
//   - volatility drift: mint volatility × √(network latency seconds)
//   - sandwich surcharge: 0-4% based on detected MEV pressure
//   - priority fee: live p90 from getPriorityFeeSol()
//   - fee pct: still from config (~1% pump.fun fee, deterministic)

// `ctx` may be a string (legacy: just the mint address) or an object with
// { mintAddress, positionId, strategy } — when positionId is provided, we log
// the friction event to the friction_log table for Phase 1D analysis.
function _normalizeCtx(ctx) {
  if (!ctx) return {};
  if (typeof ctx === 'string') return { mintAddress: ctx };
  return ctx;
}

let _logStmt = null;
function _logFriction(row) {
  try {
    if (!_logStmt) {
      _logStmt = db().prepare(`INSERT INTO friction_log
        (timestamp, position_id, mint_address, strategy, side, trade_size_sol,
         total_slippage_pct, curve_slip_pct, vol_drift_pct, sandwich_pct,
         priority_fee_sol, latency_ms, v_sol_in_curve, was_dynamic)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    }
    _logStmt.run(
      row.timestamp, row.positionId || null, row.mintAddress || null, row.strategy || null,
      row.side, row.tradeSizeSol || 0,
      row.totalSlippagePct || 0, row.curveSlipPct || 0, row.volDriftPct || 0, row.sandwichPct || 0,
      row.priorityFeeSol || 0, row.latencyMs || 0, row.vSolInCurve || 0, row.wasDynamic ? 1 : 0
    );
  } catch (err) { /* never throw from friction logging */ }
}

function applyBuyFriction(solIn, price, ctx = null) {
  const c = _normalizeCtx(ctx);
  const mintAddress = c.mintAddress;
  const f = config.friction || {};
  const fee = f.feePct || 0;
  let priority, slip, components = null, latencyMs = 0, dynamic = false;
  if (mintAddress) {
    latencyMs = getMedianLatency('helius');
    const friction = estimateBuyFriction(mintAddress, solIn, latencyMs);
    slip = friction.totalSlippagePct;
    components = friction.components;
    priority = getPriorityFeeSol();
    dynamic = true;
  } else {
    priority = f.priorityFeeSol || 0;
    slip = f.slippagePct || 0;
  }
  const effectiveSol = Math.max(0, solIn - priority);
  const effectivePrice = price * (1 + slip);
  const tokens = (effectiveSol * (1 - fee)) / effectivePrice;
  if (mintAddress) {
    _logFriction({
      timestamp: Date.now(),
      positionId: c.positionId || null,
      mintAddress,
      strategy: c.strategy,
      side: 'buy',
      tradeSizeSol: solIn,
      totalSlippagePct: slip,
      curveSlipPct: components?.curve || 0,
      volDriftPct: components?.volatilityDrift || 0,
      sandwichPct: components?.sandwich || 0,
      priorityFeeSol: priority,
      latencyMs,
      vSolInCurve: components?.vSol || 0,
      wasDynamic: dynamic,
    });
  }
  return { tokens, costSol: solIn };
}

function applySellFriction(tokens, price, ctx = null) {
  const c = _normalizeCtx(ctx);
  const mintAddress = c.mintAddress;
  const f = config.friction || {};
  const fee = f.feePct || 0;
  let priority, slip, components = null, latencyMs = 0, dynamic = false;
  if (mintAddress) {
    latencyMs = getMedianLatency('helius');
    const friction = estimateSellFriction(mintAddress, tokens, latencyMs);
    slip = friction.totalSlippagePct;
    components = friction.components;
    priority = getPriorityFeeSol();
    dynamic = true;
  } else {
    priority = f.priorityFeeSol || 0;
    slip = f.slippagePct || 0;
  }
  const effectivePrice = price * (1 - slip);
  const gross = tokens * effectivePrice;
  const sol = Math.max(0, gross * (1 - fee) - priority);
  if (mintAddress) {
    const tradeSizeSolApprox = gross; // sell SOL pre-fee, useful for aggregation
    _logFriction({
      timestamp: Date.now(),
      positionId: c.positionId,
      mintAddress,
      strategy: c.strategy,
      side: 'sell',
      tradeSizeSol: tradeSizeSolApprox,
      totalSlippagePct: slip,
      curveSlipPct: components?.curve || 0,
      volDriftPct: components?.volatilityDrift || 0,
      sandwichPct: components?.sandwich || 0,
      priorityFeeSol: priority,
      latencyMs,
      vSolInCurve: components?.vSol || 0,
      wasDynamic: dynamic,
    });
  }
  return sol;
}

export function openPaperPosition({ strategy, mintAddress, entryPrice, entrySol, entryMcap, signalDetails, entryScore, positionMode = 'paper' }) {
  if (!entryPrice || entryPrice <= 0) return null;
  // Agent strategies (`agent_*`) bypass the dashboard "Max / Trade" cap — the
  // agent gets full creative latitude on sizing. Available paper cash is the
  // only real constraint; the agent's executor checks that before calling here.
  const isAgent = typeof strategy === 'string' && strategy.startsWith('agent_');
  if (!isAgent) {
    const maxPerTrade = config.safety?.maxPerTradeSol || 0.5;
    if (entrySol > maxPerTrade) {
      console.log(`[size-cap] ${strategy} on ${mintAddress.slice(0,8)}… clamped ${entrySol.toFixed(4)} → ${maxPerTrade.toFixed(4)} SOL (maxPerTradeSol)`);
      entrySol = maxPerTrade;
    }
  }
  const s = S();
  // Snapshot mint state at entry for post-hoc analysis. Stored inside
  // signalDetails so all downstream JSON.stringify call sites capture it.
  try {
    const mintRow = s.getMint.get(mintAddress);
    if (mintRow) {
      const ageSec = mintRow.created_at ? Math.round((Date.now() - mintRow.created_at) / 1000) : null;
      const concurrentOpen = db().prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE status='open'`).get().n;
      signalDetails = {
        ...(signalDetails || {}),
        _entry_state: {
          age_sec: ageSec,
          mcap_sol: mintRow.current_market_cap_sol || null,
          peak_mcap_sol: mintRow.peak_market_cap_sol || null,
          v_sol_in_curve: mintRow.v_sol_in_curve || null,
          unique_buyers: mintRow.unique_buyer_count || 0,
          trade_count: mintRow.trade_count || 0,
          bundle_buyers: mintRow.bundle_buyer_count || 0,
          runner_score: mintRow.runner_score == null ? null : mintRow.runner_score,
          concurrent_open: concurrentOpen,
        },
      };
    }
  } catch {}
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
      broadcastEntryToTelegram({ strategy, mintAddress, entryPrice: realPrice, entrySol: r.solSpent || entrySol, entryMcap, signalDetails });
    }).catch(err => {
      const updNow = Date.now();
      try {
        db().prepare(`UPDATE paper_positions SET status = 'closed', exit_reason = 'LIVE_BUY_THROW', exited_at = ?, updated_at = ?, realized_pnl_sol = 0, pending_fill = 0 WHERE id = ?`).run(updNow, updNow, positionId);
      } catch {}
      console.error('[live] open threw', err.message);
    });
    return positionId;
  }

  const paperLatencyMs = effectiveLatencyMs();
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
        const { tokens } = applyBuyFriction(entrySol, fillPrice, { mintAddress, positionId, strategy });
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
        broadcastEntryToTelegram({ strategy, mintAddress, entryPrice: fillPrice, entrySol, entryMcap, signalDetails });
      } catch (err) {
        console.error('[paper-lat] fill threw:', err.message);
      }
    }, paperLatencyMs);
    return positionId;
  }

  // 2026-05-13 CRITICAL FIX: the caller passes entryPrice from a snapshot's
  // last_price_sol which can be tens of seconds stale. Without this drift
  // check we book phantom wins — ALgoat case: snapshot price 1.22e-08, live
  // price at "fill" 2.27e-07 (18x higher) → bot pretends to buy 9.8M tokens
  // for 0.12 SOL when reality could only get 528K → on legit exit at 2.30e-07
  // we record 14x phantom PnL. The latency-simulation branch above already
  // does this; this branch silently bypassed it.
  // Read live price at fill time, abort if drift > maxEntrySlippagePct,
  // otherwise use the LIVE fill price (not the stale trigger price) for
  // token math + entry_price storage. All downstream pct calculations
  // (tiers, trail, SL) then operate from a real entry.
  const mintNow = s.getMint.get(mintAddress);
  const fillPrice = (mintNow && mintNow.last_price_sol > 0) ? mintNow.last_price_sol : entryPrice;
  const drift = entryPrice > 0 ? (fillPrice - entryPrice) / entryPrice : 0;
  const maxDrift = config.safety?.maxEntrySlippagePct ?? 0.17;
  if (drift > maxDrift) {
    const stamp = Date.now();
    const abortResult = s.insertPosition.run(
      mintAddress, strategy, JSON.stringify({ ...(signalDetails || {}), triggerPrice: entryPrice, fillPrice }),
      entryPrice, entrySol, 0, 0, entryMcap || 0, stamp, stamp
    );
    db().prepare(`UPDATE paper_positions SET status = 'closed', exit_reason = ?, exited_at = ?, updated_at = ?, realized_pnl_sol = 0, realized_pnl_pct = 0 WHERE id = ?`)
      .run(`STALE_QUOTE_PAPER:${(drift * 100).toFixed(1)}%`, stamp, stamp, abortResult.lastInsertRowid);
    console.log(`[paper] BUY ABORT ${strategy} on ${mintAddress.slice(0, 8)}… STALE_QUOTE drift ${(drift * 100).toFixed(1)}% > ${(maxDrift * 100).toFixed(1)}%`);
    return null;
  }
  ({ tokens: tokenAmount } = applyBuyFriction(entrySol, fillPrice, { mintAddress, strategy }));
  if (tokenAmount <= 0) return null;
  const now = Date.now();
  const result = s.insertPosition.run(
    mintAddress, strategy,
    JSON.stringify({ ...(signalDetails || {}), triggerPrice: entryPrice, fillPrice, driftPct: drift }),
    fillPrice, entrySol, tokenAmount, tokenAmount, entryMcap || 0, now, now
  );
  s.bumpOpened.run(strategy);
  if (entryScore && entryScore !== 1.0) {
    db().prepare('UPDATE paper_positions SET entry_score = ? WHERE id = ?').run(entryScore, result.lastInsertRowid);
  }
  console.log(`[paper] OPEN ${strategy} on ${mintAddress.slice(0, 8)}… @ ${fillPrice.toExponential(3)} SOL/tok (drift ${(drift * 100).toFixed(1)}%, ${entrySol.toFixed(4)} SOL${entryScore && entryScore !== 1.0 ? ` · ${entryScore.toFixed(2)}x` : ''})`);
  broadcastEntryToTelegram({ strategy, mintAddress, entryPrice, entrySol, entryMcap, signalDetails });
  return result.lastInsertRowid;
}

// Fire-and-forget TG broadcaster — invoked after every successful entry path
// (synchronous paper fill, latency-deferred paper fill, and live fill). Was
// previously only wired into the synchronous branch, which meant production
// (paperLatencyMs > 0) never broadcast a single call.
function broadcastEntryToTelegram({ strategy, mintAddress, entryPrice, entrySol, entryMcap, signalDetails }) {
  import('../ingestion/telegram-calls.js').then(m => {
    const mintRow = S().getMint.get(mintAddress);
    if (!mintRow) return;
    return m.postCall({
      mint: mintRow,
      strategy,
      entryPrice,
      entrySol,
      entryMcap: entryMcap || 0,
      predictions: signalDetails?.predictions || null,
      features: signalDetails?.features || null,
    });
  }).catch((err) => { console.log(`[tg-calls] hook err: ${err.message}`); });
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
  finalSol = applySellFriction(p.tokens_remaining || 0, exitPrice, { mintAddress: p.mint_address, positionId: p.id, strategy: p.strategy });
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

  // SL re-entry watchlist: if the position closed via SL_HIT, mark the mint
  // for a 30-min "bounce" window. tryFire checks this and allows a re-entry
  // (at half size) when a tracked-wallet buys AND price recovered to ≥80% of
  // original entry. See backtest evidence: 33% of SL'd mints showed bounce
  // signals, 85% of those re-entries hit +30% target.
  if (exitReason === 'SL_HIT') {
    try {
      const expires = now + 30 * 60 * 1000;
      db().prepare(`INSERT OR REPLACE INTO sl_watchlist (mint_address, original_strategy, original_entry_price, sl_at, expires_at, consumed) VALUES (?, ?, ?, ?, ?, 0)`)
        .run(p.mint_address, p.strategy, p.entry_price, now, expires);
    } catch (err) { console.error('[reentry] watchlist insert failed:', err.message); }
  }
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
      // Dedup guard: tier already in fresh.tiers_hit → race detected, skip.
      const tierMark = `"TIER_${tierIdx}"`;
      if ((fresh?.tiers_hit || '').includes(tierMark)) {
        console.warn(`[live] TIER_${tierIdx} race-skip on ${p.mint_address.slice(0,8)}… — tier already in tiers_hit`);
        return;
      }
      const newRem = Math.max(0, (fresh?.tokens_remaining || 0) - tokensSold);
      const newReal = (fresh?.sol_realized_so_far || 0) + liveSol;
      let tiers = []; try { tiers = JSON.parse(fresh?.tiers_hit || '[]'); } catch {}
      if (r.success) tiers.push(`TIER_${tierIdx}`);
      const be = (tierIdx === 1 && p._breakeven_after_tier1 && r.success) ? 1 : (fresh?.breakeven_armed || 0);
      // Atomic UPDATE — last param is the LIKE pattern that must NOT match.
      const dedupPattern = `%${tierMark}%`;
      const upd = s.updateTierHit.run(newRem, newReal, JSON.stringify(tiers), be, Date.now(), p.id, dedupPattern);
      if (upd.changes === 0) {
        console.warn(`[live] TIER_${tierIdx} atomic-reject on ${p.mint_address.slice(0,8)}… — tier raced in via another path`);
        return;
      }
      if (r.success) {
        const liveMint = db().prepare('SELECT current_market_cap_sol FROM mints WHERE mint_address = ?').get(p.mint_address);
        appendSellEvent(p.id, { r: `TIER_${tierIdx}`, m: liveMint?.current_market_cap_sol || 0, s: liveSol });
        console.log(`[live] TIER_${tierIdx} ${p.strategy} on ${p.mint_address.slice(0,8)}… +${liveSol.toFixed(4)} SOL`);
      } else console.log(`[live] TIER_${tierIdx} FAIL ${p.strategy} on ${p.mint_address.slice(0,8)}… ${r.error || 'unknown'}`);
    }).catch(err => console.error('[live] tier failed', err.message))
      .finally(() => _pendingSells.delete(p.id));
    return p;
  }
  const paperLatencyMs = effectiveLatencyMs();
  if (paperLatencyMs > 0 && !_pendingPaperSells.has(p.id)) {
    _pendingPaperSells.add(p.id);
    const triggerPrice = currentPrice;
    const triggerTier = tierIdx;
    const triggerPctSell = tierPctSell;
    const triggerBeFlag = p._breakeven_after_tier1;
    setTimeout(() => {
      try {
        const fresh = db().prepare('SELECT tokens_remaining, sol_realized_so_far, tiers_hit, breakeven_armed FROM paper_positions WHERE id = ?').get(p.id);
        // Dedup guard: tier already fired by another path (e.g. duplicate
        // process — should be impossible under launchd but defense in depth).
        const tierMark = `"TIER_${triggerTier}"`;
        if ((fresh?.tiers_hit || '').includes(tierMark)) {
          console.warn(`[paper-lat] TIER_${triggerTier} race-skip on ${p.mint_address.slice(0,8)}… — tier already in tiers_hit`);
          return;
        }
        const m = s.getMint.get(p.mint_address);
        const fillPrice = (m && m.last_price_sol > 0) ? m.last_price_sol : triggerPrice;
        const sellNow = Math.min(p.token_amount * triggerPctSell, fresh?.tokens_remaining || 0);
        if (sellNow <= 0) return;
        const drift = (fillPrice - triggerPrice) / Math.max(1e-30, triggerPrice);
        const sol = applySellFriction(sellNow, fillPrice, { mintAddress: p.mint_address, positionId: p.id, strategy: p.strategy });
        const newRem = Math.max(0, (fresh?.tokens_remaining || 0) - sellNow);
        const newReal = (fresh?.sol_realized_so_far || 0) + sol;
        let tiers = []; try { tiers = JSON.parse(fresh?.tiers_hit || '[]'); } catch {}
        tiers.push(`TIER_${triggerTier}`);
        const be = (triggerTier === 1 && triggerBeFlag) ? 1 : (fresh?.breakeven_armed || 0);
        // Atomic UPDATE — refuses to apply if dedup pattern matches.
        const dedupPattern = `%${tierMark}%`;
        const upd = s.updateTierHit.run(newRem, newReal, JSON.stringify(tiers), be, Date.now(), p.id, dedupPattern);
        if (upd.changes === 0) {
          console.warn(`[paper-lat] TIER_${triggerTier} atomic-reject on ${p.mint_address.slice(0,8)}… — tier raced in`);
          return;
        }
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

  // Instant paper path — pre-fire dedup guard against `p` being stale.
  const tierMark = `"TIER_${tierIdx}"`;
  if ((p.tiers_hit || '').includes(tierMark)) {
    console.warn(`[paper] TIER_${tierIdx} race-skip on ${p.mint_address.slice(0, 8)}… — tier already in passed-in p.tiers_hit`);
    return p;
  }
  solReceived = applySellFriction(sellTokens, currentPrice, { mintAddress: p.mint_address, positionId: p.id, strategy: p.strategy });
  const newRemaining = Math.max(0, p.tokens_remaining - sellTokens);
  const newRealized = (p.sol_realized_so_far || 0) + solReceived;
  let tiers = [];
  try { tiers = JSON.parse(p.tiers_hit || '[]'); } catch {}
  tiers.push(`TIER_${tierIdx}`);
  const breakeven = (tierIdx === 1 && p._breakeven_after_tier1) ? 1 : (p.breakeven_armed || 0);
  // Atomic UPDATE — last param is the LIKE pattern that must NOT match.
  const dedupPattern = `%${tierMark}%`;
  const upd = s.updateTierHit.run(newRemaining, newRealized, JSON.stringify(tiers), breakeven, Date.now(), p.id, dedupPattern);
  if (upd.changes === 0) {
    console.warn(`[paper] TIER_${tierIdx} atomic-reject on ${p.mint_address.slice(0, 8)}… — tier was already fired by another writer`);
    return p;
  }
  appendSellEvent(p.id, { r: `TIER_${tierIdx}`, m: currentMcap || 0, s: solReceived });
  console.log(`[paper] TIER_${tierIdx} ${p.strategy} on ${p.mint_address.slice(0, 8)}… sold ${(tierPctSell*100).toFixed(0)}% of bag for +${solReceived.toFixed(4)} SOL`);
  return { ...p, tokens_remaining: newRemaining, sol_realized_so_far: newRealized, tiers_hit: JSON.stringify(tiers), breakeven_armed: breakeven };
}

// DCA scale-in — adds size to an existing losing position at a lower entry,
// averaging down the cost basis. Re-arms tiers + breakeven on the new bag
// so the recovered position can fire tier exits again.
//
// Paper mode only for now (live mode would need executor.executeBuy() with
// reason='DCA' wiring + pending_buy tracking). Returns the updated position
// row so checkPosition can keep using fresh values for the rest of the tick.
function fireDca(p, addSol, currentPrice, currentMcap, strat) {
  const s = S();
  if (p.position_mode === 'live') {
    // Punt for now — live DCA requires more pending-buy plumbing. Log and skip.
    console.log(`[dca] LIVE mode DCA not wired yet for ${p.mint_address.slice(0,8)}… (paper only)`);
    return p;
  }
  // Apply buy friction to the additional SOL — same as initial entry.
  // applyBuyFriction returns { tokens, costSol }. Derive effective fill
  // price from the inverse (avg cost per token) for audit logging.
  const fricResult = applyBuyFriction(addSol, currentPrice, { mintAddress: p.mint_address, positionId: p.id, strategy: p.strategy });
  const addedTokens = fricResult.tokens || 0;
  if (addedTokens <= 0) {
    console.warn(`[dca] friction returned 0 tokens for ${p.mint_address.slice(0,8)}… — skipping DCA`);
    return p;
  }
  const fillPrice = addSol / addedTokens;
  const oldTokenAmount = p.token_amount || 0;
  const oldEntrySol = p.entry_sol || 0;
  const oldRemaining = p.tokens_remaining || 0;
  const newTokenAmount = oldTokenAmount + addedTokens;
  const newEntrySol = oldEntrySol + addSol;
  const newRemaining = oldRemaining + addedTokens;
  // Weighted-avg entry price using TOTAL cost basis / TOTAL tokens. This
  // produces the true average — current price * tokens may not = entry_sol
  // due to friction, so we use entry_sol as the canonical cost basis.
  const newEntryPrice = newEntrySol / Math.max(newTokenAmount, 1e-30);
  // Append DCA event to sell_events JSON for audit trail.
  let events = []; try { events = JSON.parse(p.sell_events || '[]'); } catch {}
  events.push({
    r: 'DCA',
    at: Date.now(),
    add_sol: addSol,
    add_tokens: addedTokens,
    fill_price: fillPrice,
    pre_entry_price: p.entry_price,
    post_entry_price: newEntryPrice,
    pre_peak_pct: p.highest_pct || 0,
    m: currentMcap || 0,
  });
  s.applyDca.run(
    newEntryPrice, newEntrySol, newTokenAmount, newRemaining,
    addSol, JSON.stringify(events).slice(0, 8000), Date.now(),
    p.id,
  );
  console.log(`[dca] ${p.strategy} on ${p.mint_address.slice(0,8)}… added ${addSol.toFixed(4)} SOL · entry ${p.entry_price.toExponential(2)} → ${newEntryPrice.toExponential(2)} · tiers + breakeven reset`);
  return {
    ...p,
    entry_price: newEntryPrice,
    entry_sol: newEntrySol,
    token_amount: newTokenAmount,
    tokens_remaining: newRemaining,
    tiers_hit: '[]',
    breakeven_armed: 0,
    highest_pct: 0,
    dca_count: (p.dca_count || 0) + 1,
    sell_events: JSON.stringify(events),
  };
}

function convertToMoonbag(p, m) {
  const s = S();
  const cfg = config.moonbag;
  const now = Date.now();
  const sellTokens = (p.tokens_remaining || 0) * cfg.sellPctAtMigration;
  const sellPrice = m.last_price_sol || p.entry_price;
  const sellSol = applySellFriction(sellTokens, sellPrice, { mintAddress: p.mint_address, positionId: p.id, strategy: p.strategy });
  const newRemaining = (p.tokens_remaining || 0) - sellTokens;
  const newRealized = (p.sol_realized_so_far || 0) + sellSol;

  s.convertToMoonbag.run(
    newRemaining, newRealized, now,
    sellPrice, m.current_market_cap_sol || 0, now,
    p.id
  );
  console.log(`[moonbag] CONVERT ${p.strategy} on ${p.mint_address.slice(0, 8)}… sold ${(cfg.sellPctAtMigration*100).toFixed(0)}% @ migration for +${sellSol.toFixed(4)} SOL · keeping ${((1-cfg.sellPctAtMigration)*100).toFixed(0)}% bag for ride`);
}

// Per-position debounce: require N consecutive polls confirming the
// exit-trigger condition before actually closing. Migration-moment ticks
// (2026-05-11 Goblinjak) caused a single bad price reading to fire the
// trail. Requiring 2 confirming polls means a one-off bad tick gets
// overridden by the next legit poll within ~20s and the position stays open.
const _moonbagExitConfirm = new Map(); // positionId -> { reason, count }
const MOONBAG_EXIT_CONFIRMATIONS = 2;

function checkMoonbag(p, m) {
  const s = S();
  const cfg = config.moonbag;
  const now = Date.now();
  if (!p.migration_price || p.migration_price <= 0) return;
  const currentPrice = m.last_price_sol || p.migration_price;
  // Defense: ignore ticks that imply >70% drop from migration_price within
  // the first 10 min after migration — those are usually stale bond-curve
  // final-state artifacts, not real price action. AFTER 10 min, trust the
  // tick and let MOONBAG_SL fire normally. (2026-05-11: superapp position
  // 4562 stuck for 2.5h because this filter was time-unbounded.)
  const ageSinceMigMs = now - (p.moonbag_started_at || p.entered_at || now);
  if (ageSinceMigMs < 10 * 60 * 1000 && currentPrice < p.migration_price * 0.3 && !m.rugged) {
    return;
  }
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
    // RUG and TIME exits don't debounce — they're certain. TARGET/SL/TRAIL
    // are price-driven and need a second confirming poll to dodge bad ticks.
    if (exitReason === 'MOONBAG_RUG' || exitReason === 'MOONBAG_TIME') {
      _moonbagExitConfirm.delete(p.id);
      finalizePosition(p, currentPrice, m.current_market_cap_sol || 0, exitReason);
      return;
    }
    const prev = _moonbagExitConfirm.get(p.id);
    const count = (prev && prev.reason === exitReason) ? prev.count + 1 : 1;
    if (count < MOONBAG_EXIT_CONFIRMATIONS) {
      _moonbagExitConfirm.set(p.id, { reason: exitReason, count });
      return;
    }
    _moonbagExitConfirm.delete(p.id);
    finalizePosition(p, currentPrice, m.current_market_cap_sol || 0, exitReason);
    return;
  }
  _moonbagExitConfirm.delete(p.id);
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
  // Sanity guard: pump.fun mints legitimately peak around +500-1000% on
  // strong runners. Anything ≥ +5000% (50x) is a data artifact — typically
  // a stale-quote tick, a precision error, or a near-zero denominator on
  // the price computation. On 2026-05-10 a single such tick on mint
  // FffvxVAR registered as a +734,545% peak and triggered a PEAK_FLOOR
  // exit at +206,117%, injecting fake +309 SOL into the paper wallet.
  // Reject the tick entirely — don't update highest_pct, don't fire exits.
  // The next tick (with a real price) processes normally.
  const SANITY_PEAK_CAP = 1000;  // 100,000% from entry (1000x)
  // SANITY_PRICE_FLOOR — pump.fun bonding curve has a mathematical price
  // floor at ~2.8e-8 SOL/token (30 SOL initial / 1.073B initial tokens).
  // Any price BELOW that during bonding-curve phase is junk — a single bad
  // trade with miscalculated price made it into mint state. Reject the tick;
  // wait for the next real one. Only applies pre-migration: post-mig AMM
  // prices can legitimately crater, and rugged mints can also be ~0.
  // This guard catches the recording bug observed 2026-05-11 where positions
  // entered at 100+ SOL mcap exited with stored exit_mcap_sol < 5 SOL.
  const SANITY_PRICE_FLOOR = 1e-8;
  if (!p.entry_price || p.entry_price <= 0) return;
  const rawPct = (currentPrice - p.entry_price) / p.entry_price;
  if (!isFinite(rawPct) || rawPct > SANITY_PEAK_CAP || rawPct < -1) {
    console.warn(`[position] REJECT bogus price tick for ${p.mint_address.slice(0, 8)}… : current=${currentPrice} entry=${p.entry_price} rawPct=${rawPct.toFixed(2)}`);
    return;
  }
  if (currentPrice < SANITY_PRICE_FLOOR && !m.migrated && !m.rugged) {
    console.warn(`[position] REJECT sub-curve-floor tick for ${p.mint_address.slice(0, 8)}… : current=${currentPrice.toExponential(2)} (floor=${SANITY_PRICE_FLOOR.toExponential(0)}) — bonding curve math says this is impossible. Waiting for real tick.`);
    return;
  }
  const peakPctRaw = rawPct;
  const ageMin = (now - p.entered_at) / 60000;
  const ageSec = (now - p.entered_at) / 1000;
  // peakFromEntry needed early — DCA logic at line ~830 references it before
  // the tier-firing block below redefines/uses it. Compute once up-front.
  const peakFromEntry = Math.max(p.highest_pct || 0, peakPctRaw);
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
  // Ladder sanity — t1 < t2 < t3 must hold or the cascade is broken. Both
  // tiers can fire on the same tick if t2 < t1, and tier3 trail/sell never
  // happens if t3 <= t2 because tier2 absorbs the fill first.
  if (t1Trig > 0 && t2Trig > 0 && t3Trig > 0 &&
      (t2Trig <= t1Trig || t3Trig <= t2Trig) &&
      !_tierLadderWarned.has(p.strategy)) {
    _tierLadderWarned.add(p.strategy);
    console.warn(`[tier-ladder] BROKEN on ${p.strategy}: t1=${t1Trig.toFixed(2)} t2=${t2Trig.toFixed(2)} t3=${t3Trig.toFixed(2)} — expect t1 < t2 < t3. Tiers may fire out of order or be absorbed.`);
  }

  // DCA scale-in evaluation — fires BEFORE tier sells. Strict gates:
  //   1) strategy opted in (dca_enabled = 1)
  //   2) we haven't already exhausted dca_max_dca for this position
  //   3) position is in the [dca_min_age_sec, dca_max_age_min] window — too
  //      young = haven't seen real action yet; too old = the thesis has died
  //   4) position peaked at +1%+ before dumping (showed promise vs never-pumped)
  //   5) current PnL is at-or-below dca_trigger_pct (the dip we're buying)
  //   6) PER-MINT SAFETY: ml says rug-side targets are LOW (skip rugs)
  // When all true, fires a buy of (entry_sol × dca_size_pct), averages down,
  // resets tiers + breakeven so the rebuilt bag can take profit again.
  // Skip in live mode for now (fireDca() noops in live, paper-only v1).
  if (
    p.position_mode !== 'live' &&
    (strat.dca_enabled || 0) === 1 &&
    (p.dca_count || 0) < (strat.dca_max_dca || 1) &&
    ageSec >= (strat.dca_min_age_sec || 60) &&
    ageMin <= (strat.dca_max_age_min || 30) &&
    peakFromEntry >= 0.01 &&
    peakPctRaw <= (strat.dca_trigger_pct || -0.25)
  ) {
    // Per-mint safety re-check — don't add capital if ML thinks this is
    // rugging right now. Thresholds are intentionally conservative (high
    // bar to abort) so legitimate dips still DCA. Tunable per-strategy
    // via dca_rug_skip_threshold if we want, but keeping it global for now.
    const safety = s.getDcaSafety.get(p.mint_address);
    const RUG5_SKIP = 0.40;
    const DIE_FAST_SKIP = 0.60;
    const safetyVeto = safety && (
      (safety.p_rug5 != null && safety.p_rug5 >= RUG5_SKIP) ||
      (safety.p_die_fast != null && safety.p_die_fast >= DIE_FAST_SKIP)
    );
    if (safetyVeto) {
      // One-time log per position so we can see when DCA was vetoed — useful
      // for the agent's future analysis of when DCA helped vs hurt.
      if (!p._dcaVetoedLogged) {
        p._dcaVetoedLogged = true;
        console.log(`[dca] VETO ${p.mint_address.slice(0,8)}… on ${p.strategy} — ML flags rug (rug5=${(safety.p_rug5 ?? 0).toFixed(2)} die_fast=${(safety.p_die_fast ?? 0).toFixed(2)}) at ${(peakPctRaw*100).toFixed(0)}% drawdown`);
      }
    } else {
      const addSol = (p.entry_sol || 0) * (strat.dca_size_pct || 0.5);
      if (addSol > 0) {
        // Respect exposure cap — check before firing.
        const exposureRow = db().prepare(
          "SELECT COALESCE(SUM(MAX(0, entry_sol - COALESCE(sol_realized_so_far, 0))), 0) AS s FROM paper_positions WHERE status = 'open'"
        ).get();
        const wouldBeExposure = (exposureRow?.s || 0) + addSol;
        const maxExposure = config.limits?.maxSolExposure || config.strategies?.global?.maxSolExposure || 50;
        if (wouldBeExposure <= maxExposure) {
          p = fireDca(p, addSol, currentPrice, m.current_market_cap_sol || 0, strat);
          // Recompute peak metrics from the updated entry — fresh basis means
          // the current tick's tier checks should NOT fire (we just averaged
          // down; price hasn't actually moved). Skip rest of tick.
          const newRem = p.tokens_remaining || 0;
          const remValue = newRem * currentPrice;
          const totalUnrealized = (p.sol_realized_so_far || 0) + remValue - (p.entry_sol || 0);
          const totalUnrealizedPct = totalUnrealized / Math.max(p.entry_sol, 0.001);
          s.updateUnrealized.run(totalUnrealized, totalUnrealizedPct, 0, now, p.id);
          return;
        } else {
          console.log(`[dca] ${p.mint_address.slice(0,8)}… SKIP — adding ${addSol.toFixed(3)} SOL would exceed maxSolExposure ${maxExposure}`);
        }
      }
    }
  }

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

  const tier3TrailFloor = peakFromEntry - (strat.tier3_trail_pct || 0);

  let exitReason = null;
  const beArmPct = strat.breakeven_arm_pct || 0;
  // When breakeven_after_tier1 = 0 AND breakeven_arm_pct > 0, the breakeven
  // trail arms on peak threshold WITHOUT needing tier1 to fire first.
  // Lets a strategy say "if peak >= +X% and pulls back below +Y%, sell" as a
  // standalone exit (no tier1 dependency).
  const beStandalone = !strat.breakeven_after_tier1 && beArmPct > 0;
  const beActive = (breakevenArmed || beStandalone) && peakFromEntry >= beArmPct;
  const postT1TrailPct = strat.tp_trail_pct || 0;
  const postT1ArmPct = strat.tp_trail_arm_pct || 0;
  // 2026-05-13: removed `breakevenArmed &&` prerequisite. Original gating tied
  // trail to "tier1 has locked profit" which made the trail INERT for any
  // strategy with breakeven_after_tier1=0 OR whose runners peaked above
  // arm_pct but below T1 trigger. Caught when alive-migrator-v1 round-tripped
  // 5 positions that peaked +100-145% back down to TIME_EXIT at -50-70%
  // because the trail never armed. peakFromEntry >= postT1ArmPct is itself
  // the correct gate — once peak crosses the arm threshold, protect it.
  const trailArmed = postT1TrailPct > 0 && peakFromEntry >= postT1ArmPct;
  const postT1TrailFloor = trailArmed
    ? Math.max(0, peakFromEntry - postT1TrailPct)
    : null;

  const fastFailSec = strat.fast_fail_sec || 0;
  const fastFailMinPeak = strat.fast_fail_min_peak_pct || 0;
  const fastFailSl = strat.fast_fail_sl_pct || 0;
  // INTENTIONAL gate: FAST_FAIL/FAKE_PUMP only fire BEFORE tier1 has locked
  // in profit. After breakevenArmed, BREAKEVEN_SL takes over as the floor
  // (and is typically tighter). If a strategy ships with FAST_FAIL params
  // AND breakeven_after_tier1=1, those params silently become dead code
  // after tier1 fires — warn once so the user can see the conflict.
  if ((fastFailSec > 0 || strat.fakepump_sec > 0) &&
      strat.breakeven_after_tier1 === 1 &&
      !_fastFailWarned.has(p.strategy)) {
    _fastFailWarned.add(p.strategy);
    console.warn(`[exit-config] NOTE ${p.strategy}: FAST_FAIL/FAKE_PUMP configured AND breakeven_after_tier1=1 — those modes ONLY fire pre-tier1. Post-tier1 the BREAKEVEN_SL floor takes over.`);
  }
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

  // Recent inflow_accel_pct from the freshest ml_mint_snapshots row for this
  // mint — feeds the momentum-confirmed staying-power gate on STAGNATED.
  // NULL means no snapshot yet (mint < 60s old, or this is a non-pump.fun mint).
  // One DB read per checkPosition call — cheap.
  const recentVelocity = s.getRecentVelocity.get(p.mint_address)?.inflow_accel_pct ?? null;
  const volumeAccelerating = recentVelocity != null && recentVelocity > 0.20;

  // Realized PnL lock: once tier sells have realized ≥50% of entry SOL, the
  // remaining bag should NEVER exit at a loss vs entry. Lock a hard floor at
  // +20% so we keep at least *some* gain on the residual bag even if it
  // collapses. Fires only when this is the strictest active floor (cascade
  // priority means TP_TRAIL/PEAK_FLOOR/BREAKEVEN_SL trump REALIZED_LOCK when
  // configured with higher thresholds — REALIZED_LOCK catches the rest).
  const realizedFrac = (p.sol_realized_so_far || 0) / Math.max(p.entry_sol, 0.001);
  const REALIZED_LOCK_THRESHOLD = 0.5;
  const REALIZED_LOCK_FLOOR = 0.20;
  const realizedLockActive = realizedFrac >= REALIZED_LOCK_THRESHOLD;

  // SANITY: a peak-floor level only makes sense when exit < arm. If a strategy
  // ships with exit >= arm (e.g. arm=1.0/exit=1.2), the level would arm at
  // peakFromEntry >= 1.0 and then fire IMMEDIATELY on any tick where current
  // dipped below 1.2 — which is always, post-pullback. That's exactly what
  // was burning winners. Drop misconfigured levels and warn once per strategy.
  const _rawPfLevels = [
    { name: 'L1', arm: strat.peak_floor_arm_pct || 0, exit: strat.peak_floor_exit_pct || 0 },
    { name: 'L2', arm: strat.peak_floor_arm2_pct || 0, exit: strat.peak_floor_exit2_pct || 0 },
    { name: 'L3', arm: strat.peak_floor_arm3_pct || 0, exit: strat.peak_floor_exit3_pct || 0 },
  ];
  const pfLevels = _rawPfLevels
    .filter(l => {
      if (l.arm <= 0) return false;
      if (l.exit >= l.arm || l.exit < 0) {
        const key = `${p.strategy}:${l.name}`;
        if (!_peakFloorWarned.has(key)) {
          _peakFloorWarned.add(key);
          console.warn(`[peak-floor] DROPPING misconfigured ${l.name} on ${p.strategy}: arm=${l.arm} exit=${l.exit} — exit must be > 0 and < arm. Would fire immediately on any pullback.`);
        }
        return false;
      }
      return true;
    })
    .sort((a, b) => b.arm - a.arm);
  const armedLevel = pfLevels.find(l => peakFromEntry >= l.arm);
  const peakFloorActive = !!armedLevel;
  const peakFloorExit = armedLevel ? armedLevel.exit : 0;

  if (m.rugged) exitReason = 'RUGGED';
  // 2026-05-13: removed `else if (m.migrated)` auto-exit. With config.moonbag
  // disabled, this line was firing on EVERY migrated position — CUPPY entered
  // and exited within 1 second of migration. The strategy's tier/trail/SL
  // should own post-migration behavior. AMM pollers (dexscreener.js, etc.)
  // keep price ticking; smart-SL + spike-guard already defend against
  // migration-moment phantom prices.
  else if ((p.tokens_remaining || 0) <= 0) exitReason = ((strat.tier2_sell_pct || 0) > 0) ? 'TIERED_FULL' : 'TARGET_HIT';
  else if (t3Armed && peakPctRaw <= tier3TrailFloor) exitReason = 'TP_TRAIL';
  else if (postT1TrailFloor !== null && peakPctRaw <= postT1TrailFloor) exitReason = 'POST_T1_TRAIL';
  else if (peakFloorActive && peakPctRaw < peakFloorExit) exitReason = 'PEAK_FLOOR';
  else if (beActive && !trailArmed && peakPctRaw <= (strat.breakeven_floor_pct || 0)) exitReason = 'BREAKEVEN_SL';
  else if (fastFailActive && peakPctRaw <= fastFailSl) exitReason = 'FAST_FAIL';
  else if (fakePumpActive && peakPctRaw <= fakeSl) exitReason = 'FAKE_PUMP';
  else if (flatActive) exitReason = 'FLAT_EXIT';
  // REALIZED_LOCK — once 50%+ of entry SOL has been realized via tier sells,
  // never let the residual bag drop below +20% from entry. Skips when other
  // floor-style exits (PEAK_FLOOR, BREAKEVEN_SL) already handled it via a
  // stricter trigger; only fires when this would be the active floor.
  else if (realizedLockActive && peakPctRaw <= REALIZED_LOCK_FLOOR) exitReason = 'REALIZED_LOCK';
  else if (!breakevenArmed && peakPctRaw <= strat.sl_pct) {
    // Smart SL — require ML confirmation that the coin is actually dying
    // before cutting. 2026-05-12 data: SL_HIT trades had +649% avg post-exit
    // peak — we were cutting positions that recovered. Now SL fires only if:
    //   - rug_within_5min ≥ 0.40 (model thinks it's rugging), OR
    //   - will_die_fast ≥ 0.60 (model thinks it's flatlining), OR
    //   - peakPctRaw ≤ -0.90 (catastrophic — exit regardless), OR
    //   - mint.rugged flag set.
    // Otherwise hold and let time_exit, dead_bag, or actual rug clean up.
    const catastrophic = peakPctRaw <= -0.90;
    const rugConf = s.getDcaSafety.get(p.mint_address);
    const rugConfirmed = catastrophic || m.rugged || (rugConf && (
      (rugConf.p_rug5 != null && rugConf.p_rug5 >= 0.40) ||
      (rugConf.p_die_fast != null && rugConf.p_die_fast >= 0.60)
    ));
    if (rugConfirmed) exitReason = 'SL_HIT';
  }
  else if (
    strat.stagnant_exit_min > 0 &&
    minutesSinceLastTrade >= strat.stagnant_exit_min &&
    peakPctRaw <= strat.stagnant_loss_pct &&
    // Momentum-confirmed staying power: skip STAGNATED if volume is
    // accelerating (>+20%). Price stagnant + volume building = breakout
    // setup, not death.
    !volumeAccelerating
  ) exitReason = 'STAGNATED';
  else if (
    (strat.dead_bag_age_min || 0) > 0 &&
    ageMin >= strat.dead_bag_age_min &&
    peakFromEntry < (strat.dead_bag_max_peak_pct || 0) &&
    peakPctRaw <= (strat.dead_bag_loss_pct || 0)
  ) exitReason = 'DEAD_BAG';
  // FADE_EXIT / MID_FADE deleted 2026-05-11 — never fired in any closed
  // position across all of history. The fade_exit_* / mid_fade_* strategy
  // columns remain but are now no-ops (no value in dropping cols on SQLite).
  else if (
    // LAZY_EXIT — alive but going nowhere. Cycles stuck positions out so the
    // exposure cap doesn't lock us out of fresh runners. Asymmetric band:
    // only fires when CURRENT PnL is at-or-below breakeven AND within band
    // of zero on the loss side. We never cycle a position that's currently
    // in profit — even a small winner deserves to keep running.
    (strat.lazy_exit_age_min || 0) > 0 &&
    ageMin >= strat.lazy_exit_age_min &&
    peakFromEntry < (strat.lazy_exit_max_peak_pct || 0) &&
    peakPctRaw <= 0 &&
    peakPctRaw >= -(strat.lazy_exit_band_pct || 0)
  ) exitReason = 'LAZY_EXIT';
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

let _monitorWorker = null;

export function startPositionMonitor() {
  if (!isMainThread) return; // worker imports this module too — never re-spawn from inside the worker
  spawnMonitorWorker();
}

function spawnMonitorWorker() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'position-monitor-worker.js');
  try {
    _monitorWorker = new Worker(workerPath);
  } catch (err) {
    console.error('[monitor-worker] spawn failed:', err.message);
    return;
  }
  _monitorWorker.on('error', (err) => console.error('[monitor-worker] error', err.stack || err.message));
  _monitorWorker.on('exit', (code) => {
    _monitorWorker = null;
    if (code !== 0) {
      console.error(`[monitor-worker] exited code=${code} — restarting in 1s`);
      setTimeout(spawnMonitorWorker, 1000);
    }
  });
}

// Main thread → worker: ask the worker to re-check open positions for a mint
// that just had a trade. Worker handles it off the main event loop.
export function notifyTradeForMint(mintAddress) {
  if (!_monitorWorker) {
    // Fallback: if the worker isn't up yet (early boot), do it inline.
    try { checkPositionsForMint(mintAddress); } catch {}
    return;
  }
  _monitorWorker.postMessage({ type: 'checkMint', mint: mintAddress });
}

// Reconcile open live positions against on-chain state on startup. Handles
// crash-during-buy (pending_fill rows) and crash-after-sell (DB says open but
// wallet has 0 tokens). Paper rows are skipped — no on-chain reality to check.
export async function recoverLivePositions() {
  const wallet = await import('./wallet.js');
  const d = db();
  const open = d.prepare(`SELECT * FROM paper_positions WHERE status='open' AND position_mode='live'`).all();
  if (open.length === 0) return { checked: 0 };
  console.log(`[recover] reconciling ${open.length} live position(s) on startup`);
  let closed = 0, reconciled = 0, ok = 0;
  for (const p of open) {
    const tag = `id=${p.id} ${p.mint_address.slice(0,8)}…`;
    try {
      const onChain = await wallet.getTokenBalance(p.mint_address);
      const now = Date.now();
      if (p.pending_fill === 1) {
        if (!onChain || onChain <= 0) {
          d.prepare(`UPDATE paper_positions SET status='closed', exit_reason='RECOVERED_BUY_LOST', exited_at=?, updated_at=?, realized_pnl_sol=0, realized_pnl_pct=0, pending_fill=0 WHERE id=?`).run(now, now, p.id);
          console.log(`[recover] ${tag} pending buy never landed → CLOSED RECOVERED_BUY_LOST`);
          closed++; continue;
        }
        d.prepare(`UPDATE paper_positions SET pending_fill=0, tokens_remaining=?, token_amount=?, updated_at=? WHERE id=?`).run(onChain, onChain, now, p.id);
        console.log(`[recover] ${tag} pending buy resolved · ${onChain} tokens · marked OPEN`);
        reconciled++; continue;
      }
      if (!onChain || onChain <= 0) {
        const realized = p.sol_realized_so_far || 0;
        const pnl = realized - p.entry_sol;
        const pnlPct = p.entry_sol > 0 ? pnl / p.entry_sol : 0;
        d.prepare(`UPDATE paper_positions SET status='closed', exit_reason='RECOVERED_NO_TOKENS', exited_at=?, updated_at=?, realized_pnl_sol=?, realized_pnl_pct=? WHERE id=?`).run(now, now, pnl, pnlPct, p.id);
        console.log(`[recover] ${tag} 0 tokens on-chain (DB had ${p.tokens_remaining}) → CLOSED RECOVERED_NO_TOKENS · pnl ${pnl.toFixed(4)} SOL`);
        closed++; continue;
      }
      const dbRem = p.tokens_remaining || 0;
      const drift = dbRem > 0 ? Math.abs(onChain - dbRem) / dbRem : 0;
      if (drift > 0.05) {
        d.prepare(`UPDATE paper_positions SET tokens_remaining=?, updated_at=? WHERE id=?`).run(onChain, now, p.id);
        console.log(`[recover] ${tag} reconciled tokens_remaining ${dbRem} → ${onChain} (drift ${(drift*100).toFixed(1)}%)`);
        reconciled++; continue;
      }
      console.log(`[recover] ${tag} OK · ${onChain} tokens (DB ${dbRem})`);
      ok++;
    } catch (err) {
      console.error(`[recover] ${tag} reconcile error:`, err.message);
    }
  }
  console.log(`[recover] done: ${ok} ok, ${reconciled} reconciled, ${closed} closed`);
  return { checked: open.length, ok, reconciled, closed };
}

// Symmetric recovery for paper positions. Live positions can be reconciled
// against on-chain token balances; paper positions have no external truth.
// If a paper position is stuck in pending_fill=1 on startup, it means we
// crashed during the latency-deferred entry block — entry_price was already
// set, but the friction-application + drift-check never completed. We close
// these as RECOVERED_PAPER_PENDING (treat as failed entry rather than
// keeping a half-initialized position alive) so the strategy can cleanly
// re-evaluate the mint on its next signal.
export function recoverPaperPositions() {
  const d = db();
  const stuck = d.prepare(
    `SELECT id, mint_address, strategy FROM paper_positions
     WHERE status='open' AND position_mode='paper' AND pending_fill=1`
  ).all();
  if (stuck.length === 0) return { checked: 0 };
  console.log(`[recover-paper] releasing ${stuck.length} stuck paper position(s)`);
  const now = Date.now();
  for (const p of stuck) {
    try {
      d.prepare(
        `UPDATE paper_positions SET status='closed',
         exit_reason='RECOVERED_PAPER_PENDING',
         exited_at=?, updated_at=?,
         realized_pnl_sol=0, realized_pnl_pct=0, pending_fill=0
         WHERE id=?`
      ).run(now, now, p.id);
      console.log(`[recover-paper] id=${p.id} ${p.mint_address.slice(0,8)}… → CLOSED RECOVERED_PAPER_PENDING`);
    } catch (err) {
      console.error(`[recover-paper] id=${p.id} failed:`, err.message);
    }
  }
  return { checked: stuck.length };
}
