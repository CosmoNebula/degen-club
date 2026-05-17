// 2026-05-15 (PM-8): two corrections to v2 trio.
//  1. Add max_entry_slippage_pct (Phase 2 follow-up):
//     - tracker-elite-v2 / momentum-confirmed-v2: 0.35 (accept fast moves)
//     - organic-runner-v2: 0.25 (don't chase FOMO entries)
//  2. Roll back tracker-elite sniper_seconds_window 5 → 3:
//     7oDWeRS3 was 33/33=100% snipers at 3s; v2 (5s window) saw it as cleaner
//     and entered → FAST_FAIL -33% / -0.09 SOL on the 0.27 confidence-sized position.
//     Data is clear: don't loosen sniper detection.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const updates = [
  {
    id: 'agent_2026-05-15_tracker-elite-v2',
    apply: (r) => {
      r.entry.max_entry_slippage_pct = 0.35;
      r.entry.sniper_seconds_window = 3;  // rollback from 5
      return r;
    },
  },
  {
    id: 'agent_2026-05-15_organic-runner-v2',
    apply: (r) => { r.entry.max_entry_slippage_pct = 0.25; return r; },
  },
  {
    id: 'agent_2026-05-15_momentum-confirmed-v2',
    apply: (r) => { r.entry.max_entry_slippage_pct = 0.35; return r; },
  },
];

const d = db();
for (const u of updates) {
  const row = d.prepare(`SELECT recipe_json FROM ml_agent_strategies WHERE id = ?`).get(u.id);
  if (!row) { console.log(`[tune] ✗ not found: ${u.id}`); continue; }
  const recipe = u.apply(JSON.parse(row.recipe_json));
  d.prepare(`UPDATE ml_agent_strategies SET recipe_json = ? WHERE id = ?`).run(JSON.stringify(recipe), u.id);
  deployStrategy(u.id, recipe);
  console.log(`[tune] ↻ ${u.id}`);
}
console.log('[tune] done');
