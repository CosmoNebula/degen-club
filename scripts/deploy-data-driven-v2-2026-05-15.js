// 2026-05-15 (PM-7): Rewrite all 3 strategies to use Phase 1+2 features.
//
// New tools each strategy uses:
//   1. condition_groups       — OR-of-AND logic
//   2. sizing.confidence_*    — ML-weighted position sizing
//   3. cooldowns.*            — per-strategy cooldown control
//   4. sniper_seconds_window  — per-strategy sniper definition
//   5. skip_smell_test        — opt out of universal veto when warranted
//
// Each v2 retires the v1 of the same name. Capital-preservation defaults
// (rug/drawdown safety ML, mcap floor/ceiling) carry forward.

import { db } from '../src/db/index.js';
import { deployStrategy, retireStrategy } from '../src/ml/agent-executor.js';

const TODAY = '2026-05-15';
const NOW = Date.now();
const RETIRE_REASON = '2026-05-15 PM-7 — v2 rewrite using Phase 1+2 dynamic features (OR-logic, confidence-weighted sizing, per-strategy cooldowns/sniper window).';

const strategies = [
  // -------------------------------------------------------------------------
  // 1) tracker-elite-v2 — the 3.7x lift play, broadened with OR logic
  // -------------------------------------------------------------------------
  // v1 problem: tracked_buyers≥1 fires on only ~4.5% of snapshots. Strategy
  // sat idle even when EXCEPTIONAL organic candidates appeared.
  // v2: tracker presence OR exceptional-organic stencil match → either fires.
  // sniper_seconds_window: 5 (looser) — tracker presence proves human
  // interest, so fast-but-not-instant buys (3-5s) count as organic, not bot.
  // Sizing: inverse-scale on rug_within_5min — bet bigger when rug risk low.
  {
    id: `agent_${TODAY}_tracker-elite-v2`,
    recipe: {
      name: 'tracker-elite-v2',
      rationale: 'v2 rewrite: OR-logic broadens entry from tracker-only to (tracker OR exceptional-organic). Sniper window loosened to 5s when tracker validates human interest. Confidence-weighted sizing on rug_within_5min (inverse) — when rug risk is near zero, size up to 1.8x base.',
      entry: {
        // Universal flat AND — safety + geometry
        conditions: [
          { kind: 'ml_prediction', name: 'rug_within_5min',     op: '<',  value: 0.10 },
          { kind: 'ml_prediction', name: 'drawdown_20pct_300s', op: '<',  value: 0.50 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',    op: '>=', value: 8 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',    op: '<=', value: 120 },
        ],
        // OR groups — either path wins
        condition_groups: [
          // A: tracker buyer present (the high-conviction signal)
          [
            { kind: 'snapshot_feature', name: 'tracked_buyers', op: '>=', value: 1 },
            { kind: 'snapshot_feature', name: 'unique_buyers',  op: '>=', value: 8 },
            { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.35 },
          ],
          // B: KOL buyer present (similar lift signal per data)
          [
            { kind: 'snapshot_feature', name: 'kol_buyers',     op: '>=', value: 1 },
            { kind: 'snapshot_feature', name: 'unique_buyers',  op: '>=', value: 10 },
            { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.35 },
          ],
          // C: no tracker but exceptional-organic stencil (winner avg+)
          [
            { kind: 'snapshot_feature', name: 'unique_buyers',   op: '>=', value: 30 },
            { kind: 'snapshot_feature', name: 'trades_per_min',  op: '>=', value: 75 },
            { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.25 },
            { kind: 'snapshot_feature', name: 'pressure_60_net', op: '>',  value: 0.2 },
          ],
        ],
        max_mint_age_sec: 300,
        sniper_seconds_window: 5,
      },
      sizing: {
        type: 'confidence_weighted',
        sol: 0.18,
        confidence_scale_by: 'rug_within_5min',
        scale_direction: 'inverse', // low rug prob → bigger size
        min_mult: 0.6,
        max_mult: 1.8,
      },
      cooldowns: {
        after_exit_ms: 5 * 60 * 1000,
        after_fast_fail_ms: 30 * 60 * 1000,
      },
      exit: {
        stop_loss_pct: 40,
        take_profit_tiers: [
          { trigger_pct: 75,  sell_pct: 35 },
          { trigger_pct: 200, sell_pct: 40 },
          { trigger_pct: 600, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 250, trail_pct: 30 },
        peak_floor_tiers: [
          { arm_pct: 50,  exit_pct: 20 },
          { arm_pct: 150, exit_pct: 80 },
          { arm_pct: 400, exit_pct: 200 },
        ],
        max_hold_min: 15,
        breakeven_after_tier1: 1,
      },
    },
  },

  // -------------------------------------------------------------------------
  // 2) organic-runner-v2 — three paths to "real demand"
  // -------------------------------------------------------------------------
  // v1 problem: required full winner-stencil match (unique_buyers≥18 +
  // trades_per_min≥45 + pressure≥0 + up_run≥5 — ALL). Almost never fired.
  // v2: three independent paths — strong-all-around OR fresh-breakout OR
  // KOL-validated. Each represents a different "this is real" signature.
  // Strict 3s sniper window (organic by definition rejects fast bots).
  // Sizing: positive-scale on hits_2x_within_1h — bet bigger when ML says 2x.
  {
    id: `agent_${TODAY}_organic-runner-v2`,
    recipe: {
      name: 'organic-runner-v2',
      rationale: 'v2 rewrite: 3-way OR (strong-all-around / fresh-breakout / KOL-validated). Each path captures a different "this is real demand" signature. Confidence-weighted sizing on hits_2x_within_1h — when model predicts high 2x odds, size up to 2x base.',
      entry: {
        conditions: [
          { kind: 'ml_prediction', name: 'rug_within_5min',      op: '<',  value: 0.10 },
          { kind: 'ml_prediction', name: 'drawdown_20pct_300s',  op: '<',  value: 0.50 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys',   op: '<=', value: 0.30 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.20 },
          { kind: 'snapshot_feature', name: 'pressure_60_net',   op: '>',  value: 0 },
          { kind: 'snapshot_feature', name: 'creator_migrated_count', op: '<', value: 3 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',     op: '>=', value: 6 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',     op: '<=', value: 100 },
        ],
        condition_groups: [
          // A: strong-all-around (winner-stencil match)
          [
            { kind: 'snapshot_feature', name: 'unique_buyers',     op: '>=', value: 18 },
            { kind: 'snapshot_feature', name: 'trades_per_min',    op: '>=', value: 40 },
            { kind: 'snapshot_feature', name: 'longest_up_run_pct', op: '>=', value: 3 },
          ],
          // B: fresh breakout — fewer buyers but BIG up-run already
          [
            { kind: 'snapshot_feature', name: 'unique_buyers',      op: '>=', value: 12 },
            { kind: 'snapshot_feature', name: 'longest_up_run_pct', op: '>=', value: 8 },
            { kind: 'snapshot_feature', name: 'trades_per_min',     op: '>=', value: 30 },
          ],
          // C: KOL-validated
          [
            { kind: 'snapshot_feature', name: 'kol_buyers',     op: '>=', value: 1 },
            { kind: 'snapshot_feature', name: 'unique_buyers',  op: '>=', value: 10 },
            { kind: 'snapshot_feature', name: 'trades_per_min', op: '>=', value: 25 },
          ],
        ],
        max_mint_age_sec: 180,
        sniper_seconds_window: 3, // strict
      },
      sizing: {
        type: 'confidence_weighted',
        sol: 0.18,
        confidence_scale_by: 'hits_2x_within_1h',
        scale_direction: 'positive',
        min_mult: 0.6,
        max_mult: 2.0,
      },
      cooldowns: {
        after_exit_ms: 3 * 60 * 1000, // fast re-fire — runners can chain
        after_fast_fail_ms: 20 * 60 * 1000,
      },
      exit: {
        stop_loss_pct: 40,
        take_profit_tiers: [
          { trigger_pct: 80,  sell_pct: 35 },
          { trigger_pct: 250, sell_pct: 40 },
          { trigger_pct: 700, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 250, trail_pct: 30 },
        peak_floor_tiers: [
          { arm_pct: 50,  exit_pct: 20 },
          { arm_pct: 150, exit_pct: 80 },
          { arm_pct: 400, exit_pct: 200 },
        ],
        max_hold_min: 12,
        breakeven_after_tier1: 1,
      },
    },
  },

  // -------------------------------------------------------------------------
  // 3) momentum-confirmed-v2 — three ways to confirm "actually moving"
  // -------------------------------------------------------------------------
  // v1 problem: price_up_60s ≥ 0.35 was an ML probability that rarely cleared
  // 0.35 in the current regime (calibration ceiling).
  // v2: three independent paths to confirmation — ML-prediction-pair OR
  // observed-up-run OR strong-organic-momentum. Each represents a different
  // angle on "this coin is mid-pump."
  // skip_smell_test=true: this strategy ONLY enters confirmed-up coins;
  // the universal veto can be overly cautious on mid-pumps with heavy
  // sentiment volume (shill/bull overlap noise).
  {
    id: `agent_${TODAY}_momentum-confirmed-v2`,
    recipe: {
      name: 'momentum-confirmed-v2',
      rationale: 'v2 rewrite: 3-way OR for momentum confirmation (ML-pair / observed-up-run / strong-organic). Skips smell-test (this strategy by design only fires on confirmed-up coins). Sizing scales positively on price_up_300s — longer-horizon up signal as conviction proxy.',
      entry: {
        conditions: [
          { kind: 'ml_prediction', name: 'rug_within_5min',      op: '<',  value: 0.08 },
          { kind: 'ml_prediction', name: 'drawdown_20pct_300s',  op: '<',  value: 0.45 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys',   op: '<=', value: 0.30 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',     op: '>=', value: 10 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',     op: '<=', value: 150 },
        ],
        condition_groups: [
          // A: ML-pair confirmation (original v1 intent, loosened)
          [
            { kind: 'ml_prediction', name: 'price_up_60s',              op: '>=', value: 0.25 },
            { kind: 'ml_prediction', name: 'buy_pressure_continues_60s', op: '>=', value: 0.30 },
            { kind: 'snapshot_feature', name: 'unique_buyers',          op: '>=', value: 15 },
          ],
          // B: observed positive up-run (no ML needed)
          [
            { kind: 'snapshot_feature', name: 'longest_up_run_pct', op: '>=', value: 4 },
            { kind: 'snapshot_feature', name: 'unique_buyers',      op: '>=', value: 18 },
            { kind: 'snapshot_feature', name: 'pressure_60_net',    op: '>',  value: 0 },
          ],
          // C: strong organic momentum
          [
            { kind: 'snapshot_feature', name: 'longest_up_run_pct', op: '>=', value: 10 },
            { kind: 'snapshot_feature', name: 'unique_buyers',      op: '>=', value: 12 },
            { kind: 'snapshot_feature', name: 'trades_per_min',     op: '>=', value: 35 },
          ],
        ],
        max_mint_age_sec: 600,
      },
      sizing: {
        type: 'confidence_weighted',
        sol: 0.18,
        confidence_scale_by: 'price_up_300s',
        scale_direction: 'positive',
        min_mult: 0.5,
        max_mult: 1.8,
      },
      cooldowns: {
        after_exit_ms: 8 * 60 * 1000,
        after_fast_fail_ms: 45 * 60 * 1000,
      },
      skip_smell_test: true,
      exit: {
        stop_loss_pct: 35,
        take_profit_tiers: [
          { trigger_pct: 60,  sell_pct: 40 },
          { trigger_pct: 180, sell_pct: 40 },
          { trigger_pct: 500, sell_pct: 20 },
        ],
        trailing_stop: { arm_pct: 200, trail_pct: 30 },
        peak_floor_tiers: [
          { arm_pct: 40,  exit_pct: 15 },
          { arm_pct: 120, exit_pct: 60 },
          { arm_pct: 350, exit_pct: 180 },
        ],
        max_hold_min: 10,
        breakeven_after_tier1: 1,
      },
    },
  },
];

const d = db();
const liveStmt = d.prepare(`SELECT id, n_trades, realized_pnl_sol FROM ml_agent_strategies WHERE status='live'`);
const live = liveStmt.all();
console.log(`[deploy] retiring ${live.length} live strategies:`);
for (const s of live) {
  retireStrategy(s.id, RETIRE_REASON);
  console.log(`[deploy]   ✗ retired ${s.id} (${s.n_trades} trades, ${(s.realized_pnl_sol || 0).toFixed(3)} SOL)`);
}

const existsStmt = d.prepare(`SELECT id FROM ml_agent_strategies WHERE id = ?`);
const insertStmt = d.prepare(`INSERT INTO ml_agent_strategies
  (id, name, rationale, recipe_json, status, created_at, generation)
  VALUES (?, ?, ?, ?, 'live', ?, 2)`);
const updateStmt = d.prepare(`UPDATE ml_agent_strategies
  SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL
  WHERE id = ?`);

for (const s of strategies) {
  if (existsStmt.get(s.id)) {
    updateStmt.run(s.recipe.rationale, JSON.stringify(s.recipe), s.id);
    deployStrategy(s.id, s.recipe);
    console.log(`[deploy] ↻ updated ${s.id}`);
  } else {
    insertStmt.run(s.id, s.recipe.name, s.recipe.rationale, JSON.stringify(s.recipe), NOW);
    deployStrategy(s.id, s.recipe);
    console.log(`[deploy] ✓ ${s.id}`);
  }
}
console.log('[deploy] done — restart degen-club to flush executor cache');
