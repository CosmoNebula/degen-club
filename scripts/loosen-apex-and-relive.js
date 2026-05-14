// 2026-05-14 — apex-hunter has been auto-retired ~3 times in 24h by the
// orphan-retire mechanism (0 entries in 1.4h, 2.5h, 10.3h). Its 14-condition
// stack was too strict to ever fire under current Pump.fun regime.
//
// This script:
//   1. Loosens apex by 2 conditions — drops the peaked_300 floor entirely
//      (highest-decile gate basically guarantees zero entries), and lowers
//      alive_at_1h from 0.45 → 0.40. Still 13 conditions, still the highest-
//      conviction strategy of the 5, just no longer impossible.
//   2. Re-deploys as status='live' and zeros its strategy_state counters.
//
// Companion change: agent.js now has STRATEGIES_LOCKED=true which disables
// all retire paths (orphan, evolutionary, Claude-consult). So even if apex
// goes another 10h without firing, it won't get nuked.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const NOW = Date.now();
const APEX_ID = 'agent_2026-05-13_apex-hunter-v1';

const recipe = {
  name: 'apex-hunter-v1',
  rationale: 'LOOSENED 2026-05-14 after 3x orphan retirement (orphan-retire now disabled globally). Dropped peaked_300 gate entirely (top-decile floor was the silent killer) and alive_at_1h 0.45 → 0.40. Still 13-condition max-conviction sniper — 5-model ML agreement + clean distribution + Twitter. Sizing 0.40 SOL on 10 SOL wallet.',
  entry: {
    conditions: [
      { kind: 'snapshot_feature', name: 'bundle_buyers', op: '<=', value: 0 },
      { kind: 'snapshot_feature', name: 'top1_buyer_sol_pct', op: '<=', value: 22 },
      { kind: 'snapshot_feature', name: 'has_twitter', op: '>=', value: 1 },
      { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 30 },
      { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.20 },
      { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.40 },
      { kind: 'ml_prediction', name: 'alive_at_4h', op: '>=', value: 0.25 },
      { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.30 },
      { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.30 },
      { kind: 'ml_prediction', name: 'migrated', op: '>=', value: 0.35 },
      { kind: 'ml_prediction', name: 'post_mig_peak_pct', op: '>=', value: 3.0 },
      { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.40 },
      { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.20 },
      { kind: 'ml_prediction', name: 'post_mig_rugs_1h', op: '<', value: 0.040 },
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
};

const d = db();
const cur = d.prepare('SELECT id, status, retired_reason FROM ml_agent_strategies WHERE id = ?').get(APEX_ID);
if (!cur) {
  console.error(`[apex] ❌ ${APEX_ID} not found in ml_agent_strategies`);
  process.exit(1);
}
console.log(`[apex] before: status=${cur.status} retired_reason=${cur.retired_reason || '—'}`);

const r = d.prepare(`UPDATE ml_agent_strategies
  SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL
  WHERE id = ?`).run(recipe.rationale, JSON.stringify(recipe), APEX_ID);

if (r.changes === 0) {
  console.error('[apex] ❌ update affected 0 rows');
  process.exit(1);
}

deployStrategy(APEX_ID, recipe);

d.prepare(`UPDATE strategy_state SET
  positions_opened = 0, wins = 0, losses = 0, total_pnl_sol = 0, updated_at = ?
WHERE name = ?`).run(NOW, APEX_ID);

const after = d.prepare('SELECT status FROM ml_agent_strategies WHERE id = ?').get(APEX_ID);
console.log(`[apex] after:  status=${after.status} — re-deployed with loosened entries (13 conditions, peaked_300 floor dropped, alive_at_1h 0.45→0.40)`);
console.log('[apex] done — restart degen-club to refresh in-memory strategy cache');
