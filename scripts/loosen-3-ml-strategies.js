// 2026-05-14 — only 6 trades in 5 hours of operation. Strategies are over-
// tightened post-bleed reset. Loosen the 3 ML strategies (trendweaver,
// slipstream, apex-hunter) to fire more entries. Leave alive-migrator
// and runner-mode at current settings since they have richer condition
// stacks and were the heaviest bleeders pre-tighten.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const updates = [
  // ============ trendweaver-v1 ============
  {
    id: 'agent_2026-05-13_trendweaver-v1',
    recipe: {
      name: 'trendweaver-v1',
      rationale: 'LOOSENED 2026-05-14 to unblock entries. ML floors dropped: alive_at_1h 0.45→0.35, peaked_100 0.25→0.18. Sentiment floors: bull_mentions 3→2, total 5→3. Unique_buyers 20→12.',
      entry: {
        conditions: [
          { kind: 'sentiment', metric: 'bull_mentions', op: '>=', value: 2 },
          { kind: 'sentiment', metric: 'total_mentions', op: '>=', value: 3 },
          { kind: 'narrative_match', op: '>=', value: 1 },
          { kind: 'snapshot_feature', name: 'inflow_accel_pct', op: '>', value: 0.10 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 12 },
          { kind: 'snapshot_feature', name: 'buy_sell_ratio', op: '>=', value: 1.1 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.30 },
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.35 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.18 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.40 },
        ],
        max_mint_age_sec: 1800,
      },
      sizing: { type: 'fixed', sol: 0.25 },
      exit: {
        stop_loss_pct: 45,
        take_profit_tiers: [
          { trigger_pct: 60, sell_pct: 25 },
          { trigger_pct: 180, sell_pct: 30 },
          { trigger_pct: 500, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 600, trail_pct: 35 },
        max_hold_min: 90,
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.90 },
      },
    },
  },

  // ============ slipstream-v1 ============
  {
    id: 'agent_2026-05-13_slipstream-v1',
    recipe: {
      name: 'slipstream-v1',
      rationale: 'LOOSENED 2026-05-14. ML floors: hits_2x 0.35→0.22, peaked_100 0.35→0.22, peaked_30 0.65→0.50, will_die_fast 0.45→0.55. Snapshot: unique_buyers 20→15, buy_sell_ratio 1.5→1.2, pct_sniper 0.25→0.35.',
      entry: {
        conditions: [
          { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 50 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '<=', value: 250 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.35 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.25 },
          { kind: 'snapshot_feature', name: 'buy_sell_ratio', op: '>=', value: 1.2 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 15 },
          { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.22 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.22 },
          { kind: 'ml_prediction', name: 'peaked_30', op: '>=', value: 0.50 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.30 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.55 },
        ],
        max_mint_age_sec: 600,
      },
      sizing: { type: 'fixed', sol: 0.15 },
      exit: {
        stop_loss_pct: 25,
        take_profit_tiers: [
          { trigger_pct: 30, sell_pct: 60 },
          { trigger_pct: 80, sell_pct: 100 },
        ],
        max_hold_min: 15,
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.85 },
        breakeven_after_tier1: 1,
        fast_fail: { sec: 90, min_peak_pct: 10, sl_pct: -15 },
      },
    },
  },

  // ============ apex-hunter-v1 ============
  {
    id: 'agent_2026-05-13_apex-hunter-v1',
    recipe: {
      name: 'apex-hunter-v1',
      rationale: 'LOOSENED 2026-05-14 — went 24h without firing. Lowered ML floors: alive_at_1h 0.40→0.30, alive_at_4h 0.25→0.15, peaked_100 0.30→0.20, hits_2x 0.30→0.20, migrated 0.35→0.25, post_mig_peak_pct 3.0→2.0, will_die_fast 0.40→0.50, rug_within_5min 0.20→0.30. Snapshot unique_buyers 30→18. Still tighter than the rider strategies; intent is max-conviction sniper that fires occasionally.',
      entry: {
        conditions: [
          { kind: 'snapshot_feature', name: 'bundle_buyers', op: '<=', value: 0 },
          { kind: 'snapshot_feature', name: 'top1_buyer_sol_pct', op: '<=', value: 25 },
          { kind: 'snapshot_feature', name: 'has_twitter', op: '>=', value: 1 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 18 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.25 },
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.30 },
          { kind: 'ml_prediction', name: 'alive_at_4h', op: '>=', value: 0.15 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.20 },
          { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.20 },
          { kind: 'ml_prediction', name: 'migrated', op: '>=', value: 0.25 },
          { kind: 'ml_prediction', name: 'post_mig_peak_pct', op: '>=', value: 2.0 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.50 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.30 },
          { kind: 'ml_prediction', name: 'post_mig_rugs_1h', op: '<', value: 0.060 },
        ],
        max_mint_age_sec: 300,
      },
      sizing: { type: 'fixed', sol: 0.40 },
      exit: {
        stop_loss_pct: 65,
        take_profit_tiers: [
          { trigger_pct: 100, sell_pct: 20 },
          { trigger_pct: 400, sell_pct: 25 },
          { trigger_pct: 1000, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 1100, trail_pct: 55 },
        max_hold_min: 240,
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.95 },
        breakeven_after_tier1: 0,
      },
    },
  },
];

const d = db();
const updateStmt = d.prepare(`UPDATE ml_agent_strategies
  SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL
  WHERE id = ?`);

for (const u of updates) {
  const r = updateStmt.run(u.recipe.rationale, JSON.stringify(u.recipe), u.id);
  if (r.changes === 0) {
    console.log(`[deploy] ⚠ ${u.id} not found`);
    continue;
  }
  deployStrategy(u.id, u.recipe);
  console.log(`[deploy] ↻ ${u.id}`);
}
console.log('[deploy] done — restart degen-club to pick up changes');
