// 2026-05-16: deploy elite-5x-follow-v1.
//
// Fires on the new `elite-5x-buy-XXXXXX` trigger from processor.js (any
// wallet flagged is_elite=1 in wallet_5x_score table). Pool: ~1,484 wallets
// in last 8d with >=100 buys AND >=25% 5x hit rate. Only 8% overlap with
// our current tracker/KOL/hunter pools — the rest are untagged elite.
//
// Minimal gates: rug filter only. The elite wallet IS the conviction.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const strategy = {
  id: 'agent_2026-05-16_elite-5x-follow-v1',
  recipe: {
    name: 'elite-5x-follow-v1',
    rationale: 'Follow wallets statistically proven to catch 5x runners. Pool = ~1,484 wallets with >=100 buys / >=25% hit rate on coins that peaked >=140 SOL in last 8d. Trigger does the picking; strategy just filters rugs.',
    entry: {
      conditions: [
        { kind: 'ml_prediction',    name: 'rug_within_5min',  op: '<',  value: 0.30 },
      ],
      max_mint_age_sec: 7200,
    },
    sizing: { type: 'fixed', sol: 0.20 },
    exit: {
      stop_loss_pct: 60,
      take_profit_tiers: [
        { trigger_pct: 80,  sell_pct: 50 },
        { trigger_pct: 250, sell_pct: 50 },
      ],
      trailing_stop: { arm_pct: 200, trail_pct: 30 },
      max_hold_min: 30,
      breakeven_after_tier1: 1,
    },
  },
};

const d = db();
const exists = d.prepare('SELECT id FROM ml_agent_strategies WHERE id = ?').get(strategy.id);
const ins = d.prepare(`INSERT INTO ml_agent_strategies (id, name, rationale, recipe_json, status, created_at, generation) VALUES (?,?,?,?, 'live', ?, 1)`);
const upd = d.prepare(`UPDATE ml_agent_strategies SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL WHERE id = ?`);

if (exists) {
  upd.run(strategy.recipe.rationale, JSON.stringify(strategy.recipe), strategy.id);
  deployStrategy(strategy.id, strategy.recipe);
  console.log('updated ' + strategy.id);
} else {
  ins.run(strategy.id, strategy.recipe.name, strategy.recipe.rationale, JSON.stringify(strategy.recipe), Date.now());
  deployStrategy(strategy.id, strategy.recipe);
  console.log('deployed ' + strategy.id);
}

// Also: bring strategy_state SL config in line (no FAST_FAIL, no FAKE_PUMP, -60% SL)
d.prepare(`UPDATE strategy_state SET sl_pct = -0.60, fast_fail_sec = 0, fakepump_sec = 0, updated_at = ?
  WHERE name = ?`).run(Date.now(), strategy.id);
console.log('strategy_state synced');
