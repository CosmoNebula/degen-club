// 2026-05-16: migrate all 4 live strategy recipes from old rug_within_5min
// gate to new canonical `will_rug` gate. The new label is keyed off
// mint.rugged_at (real rugs only, not wicks) — so the threshold also
// resets to a tighter value since the model is calibrated correctly now.
//
// Old: rug_within_5min < 0.70 (deliberately loose to compensate for over-prediction)
// New: will_rug < 0.30 (model now predicts rugs accurately, so tight is correct)

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const d = db();
const live = d.prepare("SELECT id, recipe_json FROM ml_agent_strategies WHERE status='live'").all();

let updated = 0;
for (const row of live) {
  const recipe = JSON.parse(row.recipe_json);
  let changed = false;

  for (const c of (recipe.entry?.conditions || [])) {
    if (c.kind === 'ml_prediction' && c.name === 'rug_within_5min') {
      const oldVal = c.value;
      c.name = 'will_rug';
      c.value = 0.30; // calibrated label, tight threshold restored
      changed = true;
      console.log(`[migrate] ${row.id} :: rug_within_5min < ${oldVal} → will_rug < 0.30`);
    }
  }

  if (changed) {
    d.prepare('UPDATE ml_agent_strategies SET recipe_json = ? WHERE id = ?')
      .run(JSON.stringify(recipe), row.id);
    deployStrategy(row.id, recipe);
    updated++;
  }
}
console.log(`[migrate] updated ${updated}/${live.length} strategies`);
