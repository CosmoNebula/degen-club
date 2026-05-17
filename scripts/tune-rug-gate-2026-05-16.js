// 2026-05-16: loosen rug_within_5min gate 0.25 → 0.70 on all 4 live strategies.
// Data analysis showed model is wildly miscalibrated:
//   predicted 30-40% rug → actual 0% rugged, 8.8% hit 5x
//   predicted 40-50% rug → actual 2% rugged, 9.8% hit 5x
//   predicted 50-70% rug → actual 2% rugged, 5.9% hit 5x
//   predicted 70+ rug → actual 0% rugged, 0% hit 5x (this IS predictive)
// In last 24h: rejected 766 coins, only 5 actually rugged but 55 migrated,
// 53 hit 5x, 48 hit 10x. We were rejecting MORE winners than rugs.
//
// Also: update elite-5x-follow rationale to clearly mention elite-wallet trigger.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const d = db();
const live = d.prepare("SELECT id, recipe_json FROM ml_agent_strategies WHERE status='live'").all();

for (const row of live) {
  const recipe = JSON.parse(row.recipe_json);
  let changed = false;

  for (const c of (recipe.entry?.conditions || [])) {
    if (c.kind === 'ml_prediction' && c.name === 'rug_within_5min') {
      const old = c.value;
      c.value = 0.70;
      changed = true;
      console.log(`[tune] ${row.id} :: rug_within_5min ${old} → 0.70`);
    }
  }

  // Update elite-5x-follow rationale specifically to surface elite-wallet origin
  if (row.id === 'agent_2026-05-16_elite-5x-follow-v1') {
    recipe.rationale =
      '🎯 Fires when an ELITE 5x-CATCHER WALLET buys (pool: ~1,484 wallets with ≥100 buys and ≥25% hit rate on coins that peaked ≥140 SOL in last 8d). Only 8% overlap with our existing tracker/KOL/hunter pools — the rest are untagged elite. The wallet IS the conviction; rug filter loosened to 0.70 (model over-predicts).';
    changed = true;
    console.log(`[tune] ${row.id} :: rationale updated to mention elite-wallet origin`);
  }

  if (changed) {
    d.prepare("UPDATE ml_agent_strategies SET recipe_json = ?, rationale = ? WHERE id = ?")
      .run(JSON.stringify(recipe), recipe.rationale, row.id);
    deployStrategy(row.id, recipe);
  }
}
console.log('[tune] done');
