import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const hunterCluster = {
  id: 'agent_2026-05-16_hunter-cluster-v1',
  recipe: {
    name: 'hunter-cluster-v1',
    rationale: 'Follow migrator-score hunters: 2+ wallets with migrator_score >= 0.55 bought this mint. Hunters are a distinct 219-wallet pool from the 50-wallet leaderboard. Rug filter only.',
    entry: {
      conditions: [
        { kind: 'snapshot_feature', name: 'hunter_buyers',    op: '>=', value: 2 },
        { kind: 'ml_prediction',    name: 'rug_within_5min',  op: '<',  value: 0.25 },
      ],
      max_mint_age_sec: 7200,
    },
    sizing: { type: 'fixed', sol: 0.20 },
    exit: {
      stop_loss_pct: 35,
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
const exists = d.prepare('SELECT id FROM ml_agent_strategies WHERE id = ?').get(hunterCluster.id);
const ins = d.prepare(`INSERT INTO ml_agent_strategies (id, name, rationale, recipe_json, status, created_at, generation) VALUES (?,?,?,?, 'live', ?, 1)`);
const upd = d.prepare(`UPDATE ml_agent_strategies SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL WHERE id = ?`);
if (exists) { upd.run(hunterCluster.recipe.rationale, JSON.stringify(hunterCluster.recipe), hunterCluster.id); deployStrategy(hunterCluster.id, hunterCluster.recipe); console.log('updated'); }
else { ins.run(hunterCluster.id, hunterCluster.recipe.name, hunterCluster.recipe.rationale, JSON.stringify(hunterCluster.recipe), Date.now()); deployStrategy(hunterCluster.id, hunterCluster.recipe); console.log('deployed'); }
