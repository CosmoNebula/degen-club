// 2026-05-16: patch strategies still using deprecated label names.
// Old → new mapping:
//   migrated         → will_migrate (same concept, 24h-windowed canonical)
//   will_die_fast    → will_rug (canonical rug definition)
//   migrates_within_15min → will_migrate
//   rug_within_5min  → will_rug (handled by earlier migrate script)
//   peaked_300       → hits_5x_within_24h (peaked_300 = +300% = ~5x, conceptually identical)
//   peaked_100       → hits_2x_within_1h (peaked_100 = +100% = ~2x, but 1h horizon)
//   peak_pct_max     → peak_pct_within_24h (bounded version)
//   rest of dropped labels → no auto-mapping, log warning

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const LABEL_MAP = {
  'migrated': 'will_migrate',
  'will_die_fast': 'will_rug',
  'migrates_within_15min': 'will_migrate',
  'rug_within_5min': 'will_rug',
  'peaked_300': 'hits_5x_within_24h',
  'peaked_100': 'hits_2x_within_1h',
  'peak_pct_max': 'peak_pct_within_24h',
};

const d = db();
const live = d.prepare("SELECT id, recipe_json FROM ml_agent_strategies WHERE status='live'").all();

let totalChanged = 0;
for (const row of live) {
  const recipe = JSON.parse(row.recipe_json);
  let changed = false;
  for (const c of (recipe.entry?.conditions || [])) {
    if (c.kind === 'ml_prediction' && LABEL_MAP[c.name]) {
      const oldName = c.name;
      c.name = LABEL_MAP[oldName];
      console.log(`[migrate-legacy] ${row.id} :: ${oldName} → ${c.name}`);
      changed = true;
    }
  }
  if (changed) {
    d.prepare('UPDATE ml_agent_strategies SET recipe_json = ? WHERE id = ?')
      .run(JSON.stringify(recipe), row.id);
    deployStrategy(row.id, recipe);
    totalChanged++;
  }
}
console.log(`[migrate-legacy] updated ${totalChanged}/${live.length} strategies`);
