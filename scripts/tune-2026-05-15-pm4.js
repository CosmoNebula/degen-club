// 2026-05-15 (PM-4): Loosen organic-runner + momentum-confirmed.
//
// First 10-min batch on the new strategies showed:
//   - organic-runner: unique_buyers ceiling 16 vs threshold 25 (drop 25→18)
//                     trades_per_min ceiling 56 vs 60 (drop 60→45)
//   - momentum-confirmed: price_up_60s peaks at 0.49 vs threshold 0.5
//                         (drop 0.5→0.35 — same calibration issue as old peak_within_5min)
//
// tracker-elite untouched — feed audit shows trackers appear in 4.5% of
// snapshots (3,102 of 69k in last 6h). Strategy is selective by design,
// the 3.7x lift only matters when we catch tracker coins.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const d = db();
const updates = [
  {
    id: 'agent_2026-05-15_organic-runner-v1',
    changes: (recipe) => {
      recipe.entry.conditions = recipe.entry.conditions.map(c => {
        if (c.name === 'unique_buyers' && c.op === '>=') return { ...c, value: 18 };
        if (c.name === 'trades_per_min' && c.op === '>=') return { ...c, value: 45 };
        return c;
      });
      return recipe;
    },
  },
  {
    id: 'agent_2026-05-15_momentum-confirmed-v1',
    changes: (recipe) => {
      recipe.entry.conditions = recipe.entry.conditions.map(c => {
        if (c.name === 'price_up_60s') return { ...c, value: 0.35 };
        return c;
      });
      return recipe;
    },
  },
];

for (const u of updates) {
  const row = d.prepare(`SELECT recipe_json FROM ml_agent_strategies WHERE id = ?`).get(u.id);
  if (!row) { console.log(`[tune] ✗ not found: ${u.id}`); continue; }
  const recipe = u.changes(JSON.parse(row.recipe_json));
  d.prepare(`UPDATE ml_agent_strategies SET recipe_json = ? WHERE id = ?`).run(JSON.stringify(recipe), u.id);
  deployStrategy(u.id, recipe);
  console.log(`[tune] ↻ ${u.id}`);
}
console.log('[tune] done — restart degen-club to flush executor cache');
