// Agent executor — evaluates the agent's live strategy recipes against fresh
// mints and fires paper trades when entry conditions match.
//
// Recipe entry/sizing are evaluated here. Recipe exits are translated to
// strategy_state rows so the existing position monitor handles them with the
// battle-tested SL/TP/trailing logic. The agent doesn't need to reinvent exits.

import { db } from '../db/index.js';
import { collectFeatures } from './feature-collector.js';
import { getAllPredictions, isHealthy } from './ml-client.js';
import { openPaperPosition } from '../trading/paper.js';

// Paper wallet starts with 1 SOL by default. We compute available cash live
// to avoid oversubscribing — agent could otherwise fire 20 trades at 0.10 SOL
// each on a 1 SOL wallet and confuse its own PnL math.
const MIN_RESERVE_SOL = 0.05;  // never spend below this — keeps room for friction

const TICK_INTERVAL_MS = 60 * 1000;       // evaluate strategies once a minute
const ENTRY_COOLDOWN_MS = 10 * 60 * 1000; // don't re-enter same mint in same strategy within 10min
const MAX_CANDIDATES = 30;                // mint candidates per tick

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    liveStrategies: d.prepare(`SELECT * FROM ml_agent_strategies WHERE status = 'live' ORDER BY created_at`),
    // Pre-migration candidates (the original pool — fresh bonding-curve mints)
    candidates: d.prepare(`SELECT mint_address, last_trade_at, created_at FROM mints
       WHERE migrated = 0 AND rugged = 0 AND last_trade_at > ?
       ORDER BY last_trade_at DESC LIMIT ?`),
    // Post-migration candidates — fresh migrators with active AMM volume.
    // Strategies opt-in via the recipe's 'targets_migrated' flag (default false).
    migratedCandidates: d.prepare(`SELECT mint_address, migrated_at, amm_liquidity_usd, amm_volume_h24_usd, current_market_cap_sol
       FROM mints WHERE migrated = 1 AND rugged = 0
         AND migrated_at > strftime('%s','now')*1000 - 72 * 3600000
         AND amm_liquidity_usd > 1000
       ORDER BY amm_volume_h24_usd DESC LIMIT ?`),
    recentEntry: d.prepare(`SELECT id FROM paper_positions
       WHERE strategy = ? AND mint_address = ? AND entered_at > ?
       LIMIT 1`),
    bumpEvaluated: d.prepare(`UPDATE ml_agent_strategies SET last_evaluated_at = ? WHERE id = ?`),
    bumpTrade: d.prepare(`UPDATE ml_agent_strategies SET n_trades = n_trades + 1 WHERE id = ?`),
    paperWallet: d.prepare(`SELECT * FROM paper_wallet WHERE id = 1`),
    paperClosedPnl: d.prepare(`SELECT COALESCE(SUM(realized_pnl_sol), 0) AS pnl
       FROM paper_positions WHERE status = 'closed' AND entered_at >= ?`),
    paperOpenLocked: d.prepare(`SELECT COALESCE(SUM(entry_sol - sol_realized_so_far), 0) AS locked
       FROM paper_positions WHERE status = 'open' AND entered_at >= ?`),
    upsertStrategyState: d.prepare(`INSERT OR REPLACE INTO strategy_state
       (name, label, description, enabled, entry_sol, sl_pct, max_hold_min,
        tier1_trigger_pct, tier1_sell_pct,
        tier2_trigger_pct, tier2_sell_pct,
        tier3_trigger_pct, tier3_sell_pct, tier3_trail_pct,
        breakeven_after_tier1, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  };
  return stmts;
}

// Compute free cash available for a new paper trade. Same math as sizing.js's
// getWalletValue() cash component — starting balance + closed PnL − open locked.
function getAvailableCash() {
  try {
    const w = S().paperWallet.get();
    if (!w) return 0;
    const closed = S().paperClosedPnl.get(w.started_at).pnl || 0;
    const open = S().paperOpenLocked.get(w.started_at).locked || 0;
    const cash = (w.starting_balance_sol || 1.0) + closed - open;
    return Math.max(0, cash);
  } catch (err) { return 0; }
}

// Evaluate one entry condition against features + ML predictions
function evalCondition(c, features, preds) {
  let lhs;
  if (c.kind === 'ml_prediction') {
    lhs = preds[c.name];
    if (lhs == null) return false;  // missing prediction = condition fails (be conservative)
  } else if (c.kind === 'feature') {
    lhs = features[c.name];
    if (lhs == null) return false;
  } else {
    return false;
  }
  switch (c.op) {
    case '>':  return lhs > c.value;
    case '>=': return lhs >= c.value;
    case '<':  return lhs < c.value;
    case '<=': return lhs <= c.value;
    case '==': return lhs === c.value;
    default: return false;
  }
}

function evalEntry(recipe, mint, features, preds) {
  const entry = recipe.entry || {};
  const ageSec = features.snapshot_age_sec || 0;
  if (entry.min_mint_age_sec && ageSec < entry.min_mint_age_sec) return false;
  if (entry.max_mint_age_sec && ageSec > entry.max_mint_age_sec) return false;
  const conds = entry.conditions || [];
  if (conds.length === 0) return false;  // require at least one condition
  for (const c of conds) {
    if (!evalCondition(c, features, preds)) return false;
  }
  return true;
}

function computeEntrySol(recipe, preds) {
  const sizing = recipe.sizing || {};
  let sol = sizing.sol || 0.13;
  if (sizing.type === 'scaled_by_peak_pct' && preds.peak_pct_max != null) {
    // peak_pct_max is a fraction (1.0 = 100% peak). The agent decides if/how
    // to scale — only honor the recipe's own max_sol if it set one.
    const mult = Math.max(0.5, 1 + preds.peak_pct_max);
    sol = sol * mult;
    if (sizing.max_sol) sol = Math.min(sol, sizing.max_sol);
  }
  // Floor only. No ceiling — let the agent size as crazy as it wants.
  // The cash-availability check downstream is the only real constraint.
  return Math.max(0.01, sol);
}

// Translate the recipe's exit block to a strategy_state row so the existing
// position monitor can apply familiar SL/TP/trailing logic.
//
// CRITICAL UNIT CONVENTION: the position monitor compares trigger/SL fields
// against `peakPctRaw` which is a FRACTION (0.30 = +30%). The agent's recipe
// uses PERCENTAGES (30 means +30%). We divide by 100 here so the monitor
// reads fractions like the rest of the code expects.
function syncStrategyStateRow(strategyId, recipe) {
  const exit = recipe.exit || {};
  const sizing = recipe.sizing || {};
  const tiers = (exit.take_profit_tiers || []).slice(0, 3);
  const t1 = tiers[0] || {};
  const t2 = tiers[1] || {};
  const t3 = tiers[2] || {};
  const trail = exit.trailing_stop || {};
  // sl_pct in the monitor is checked as `peakPctRaw <= strat.sl_pct`. Since
  // peakPctRaw is negative on losses, sl_pct must be NEGATIVE fraction.
  // Recipe says `stop_loss_pct: 25` meaning -25% loss → store as -0.25.
  const slFraction = -Math.abs(exit.stop_loss_pct || 25) / 100;
  // tier_trigger_pct: positive fraction (recipe 30 → 0.30)
  const t1Trig = (t1.trigger_pct ?? 30) / 100;
  const t1Sell = (t1.sell_pct ?? 30) / 100;
  const t2Trig = (t2.trigger_pct ?? 100) / 100;
  const t2Sell = (t2.sell_pct ?? 50) / 100;
  const t3Trig = (t3.trigger_pct ?? (trail.arm_pct ?? 200)) / 100;
  const t3Sell = (t3.sell_pct ?? 100) / 100;
  const tier3Trail = (trail.trail_pct || 0) / 100;
  S().upsertStrategyState.run(
    strategyId,
    `🤖 ${recipe.name || strategyId}`,
    (recipe.rationale || '').slice(0, 240),
    1,                                 // enabled — lives in strategy_state but we evaluate entries ourselves
    sizing.sol || 0.13,
    slFraction,
    exit.max_hold_min || 60,
    t1Trig, t1Sell,
    t2Trig, t2Sell,
    t3Trig, t3Sell,
    tier3Trail,
    exit.breakeven_after_tier1 ? 1 : 0,
    Date.now(),
  );
}

// Score a single mint against a strategy. If conditions match AND we haven't
// already entered this mint on this strategy recently, fire a paper trade.
async function evaluateOneMint(strategy, mintAddress) {
  const recipe = strategy.recipe;
  const features = collectFeatures(mintAddress);
  if (!features) return false;
  // Pull all ML predictions in one round-trip
  const preds = await getAllPredictions(mintAddress, `agent_eval:${strategy.id}`);
  if (!preds) return false;
  if (!evalEntry(recipe, null, features, preds)) return false;
  // Cooldown — don't re-enter same mint in same strategy too fast
  const cutoff = Date.now() - ENTRY_COOLDOWN_MS;
  const recent = S().recentEntry.get(strategy.id, mintAddress, cutoff);
  if (recent) return false;
  const sol = computeEntrySol(recipe, preds);
  // Use last_price_sol from features as entry price
  const entryPrice = features.last_price_sol;
  if (!entryPrice || entryPrice <= 0) return false;
  // Paper wallet exhaustion check — don't oversubscribe the simulated 1-SOL
  // pool. If we don't have cash for this trade (with reserve), skip and let
  // open positions resolve before firing more.
  const cash = getAvailableCash();
  if (cash < sol + MIN_RESERVE_SOL) {
    db().prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
       VALUES (?, 'thought', 'execute', ?, ?, ?)`).run(
      Date.now(), strategy.id,
      `skipped entry · insufficient paper cash (${cash.toFixed(3)} SOL free, needed ${sol.toFixed(3)})`,
      JSON.stringify({ cash, needed: sol, mint: mintAddress }));
    return false;
  }
  const positionId = openPaperPosition({
    strategy: strategy.id,
    mintAddress,
    entryPrice,
    entrySol: sol,
    entryMcap: features.last_mcap_sol || 0,
    signalDetails: { agent_strategy: strategy.id, agent_recipe_name: recipe.name, predictions: preds },
  });
  if (positionId) {
    S().bumpTrade.run(strategy.id);
    logTrade(strategy.id, mintAddress, sol, preds);
    return true;
  }
  return false;
}

function logTrade(strategyId, mintAddress, sol, preds) {
  try {
    db().prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
       VALUES (?, 'trade', 'execute', ?, ?, ?)`).run(
      Date.now(), strategyId,
      `entered ${mintAddress.slice(0, 8)}… for ${sol.toFixed(3)} SOL`,
      JSON.stringify({ mint: mintAddress, sol, predictions: preds }),
    );
  } catch (err) { console.error('[agent-exec] log trade failed:', err.message); }
}

let _running = false;
async function tick() {
  if (_running) return;
  if (!isHealthy()) return;
  _running = true;
  try {
    const strategies = S().liveStrategies.all().map(r => ({
      ...r,
      recipe: (() => { try { return JSON.parse(r.recipe_json); } catch { return null; } })(),
    })).filter(s => s.recipe);
    if (strategies.length === 0) return;
    const recentTradeCutoff = Date.now() - 10 * 60 * 1000;
    const preMigCands = S().candidates.all(recentTradeCutoff, MAX_CANDIDATES);
    let entered = 0;
    for (const strat of strategies) {
      // Choose candidate pool based on the recipe's targets_migrated flag.
      // Default = pre-migration only (existing behavior). Set true to target
      // migrated mints in their 72h post-migration window.
      const targetsMig = strat.recipe?.targets_migrated === true;
      const cands = targetsMig
        ? S().migratedCandidates.all(MAX_CANDIDATES).map(c => ({ mint_address: c.mint_address }))
        : preMigCands;
      for (const m of cands) {
        try {
          const fired = await evaluateOneMint(strat, m.mint_address);
          if (fired) entered++;
        } catch (err) { console.error('[agent-exec] eval err:', err.message); }
      }
      S().bumpEvaluated.run(Date.now(), strat.id);
    }
    if (entered > 0) console.log(`[agent-exec] tick · entered ${entered} positions across ${strategies.length} strategies`);
  } finally { _running = false; }
}

// Per-mint debounce — don't re-evaluate the same mint more than once per N seconds
// from event triggers. Prevents fanning out across 50 trade events on a hot mint.
const _evalDebounce = new Map();
const EVAL_DEBOUNCE_MS = 8 * 1000;

// Public: event-driven evaluator. Runs all live strategies against a mint
// IMMEDIATELY when an interesting event happens (tracked buy, whale buy,
// migration-eligible threshold, etc.). Bypasses the 60s polling sweep.
//
// Returns a promise but caller can fire-and-forget. Internally throttled
// per-mint so a flood of trade events doesn't trigger 50 evals.
export async function evaluateMintNow(mintAddress, reason) {
  if (!mintAddress) return;
  if (_running) return;  // skip if main sweep is in flight
  if (!isHealthy()) return;
  const last = _evalDebounce.get(mintAddress) || 0;
  const now = Date.now();
  if (now - last < EVAL_DEBOUNCE_MS) return;
  _evalDebounce.set(mintAddress, now);
  // Periodic GC
  if (_evalDebounce.size > 1000) {
    for (const [k, v] of _evalDebounce) if (now - v > 10 * 60 * 1000) _evalDebounce.delete(k);
  }
  try {
    const strategies = S().liveStrategies.all().map(r => ({
      ...r,
      recipe: (() => { try { return JSON.parse(r.recipe_json); } catch { return null; } })(),
    })).filter(x => x.recipe);
    if (strategies.length === 0) return;
    for (const strat of strategies) {
      try {
        const fired = await evaluateOneMint(strat, mintAddress);
        if (fired) {
          console.log(`[agent-exec] event-driven entry · ${reason} · ${mintAddress.slice(0, 8)}… · ${strat.id.slice(0, 60)}`);
        }
      } catch (err) { /* swallow per-strategy errors */ }
    }
  } catch (err) { console.error('[agent-exec] eval-now err:', err.message); }
}

// Public: install/refresh the strategy_state row when a new strategy is born
// or a recipe is updated. Called by agent.js after proposing.
export function deployStrategy(strategyId, recipe) {
  syncStrategyStateRow(strategyId, recipe);
}

// Public: when retiring, set strategy_state row's enabled=0 so the monitor
// doesn't treat it as a candidate, and update agent strategies table.
export function retireStrategy(strategyId, reason) {
  const d = db();
  d.prepare(`UPDATE strategy_state SET enabled = 0, updated_at = ? WHERE name = ?`).run(Date.now(), strategyId);
  d.prepare(`UPDATE ml_agent_strategies SET status = 'retired', retired_at = ?, retired_reason = ? WHERE id = ?`)
    .run(Date.now(), reason || '', strategyId);
}

export function startAgentExecutor() {
  setTimeout(tick, 30 * 1000);  // first run after 30s warmup
  setInterval(tick, TICK_INTERVAL_MS);
  console.log(`[agent-exec] executor started · interval=60s · max_candidates=${MAX_CANDIDATES}`);
}
