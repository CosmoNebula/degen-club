// 2026-05-16: bring back the 5 historic ML-first strategies that worked,
// retire the broken fresh-survivor-v1 (mcap gate rejected 83% of normal coins).
// Keep momentum-confirmed-v2 (only recent strategy with actual wins).
//
// Historic strategies are pulled straight from ml_agent_strategies (status=retired)
// and flipped to live. Their recipes are untouched — they worked.

import { db } from '../src/db/index.js';
import { deployStrategy, retireStrategy } from '../src/ml/agent-executor.js';

const NOW = Date.now();

const RESTORE_IDS = [
  'agent_2026-05-11_alive-migrator-v1',
  'agent_2026-05-11_runner-mode-v1',
  'agent_2026-05-13_apex-hunter-v1',
  'agent_2026-05-13_slipstream-v1',
  'agent_2026-05-13_trendweaver-v1',
];

const RETIRE_IDS = [
  'agent_2026-05-16_fresh-survivor-v1',
];

const d = db();

for (const id of RETIRE_IDS) {
  const row = d.prepare('SELECT id, n_trades, realized_pnl_sol FROM ml_agent_strategies WHERE id = ?').get(id);
  if (row?.id) {
    retireStrategy(id, '2026-05-16 — broken mcap gate (2-15 SOL rejected 83% of normal pump coins).');
    console.log(`[restore] ✗ retired ${id} (${row.n_trades || 0} trades, ${(row.realized_pnl_sol || 0).toFixed(3)} SOL)`);
  }
}

for (const id of RESTORE_IDS) {
  const row = d.prepare('SELECT recipe_json, n_trades, realized_pnl_sol FROM ml_agent_strategies WHERE id = ?').get(id);
  if (!row) { console.log(`[restore] ? not found: ${id}`); continue; }
  d.prepare(`UPDATE ml_agent_strategies SET status = 'live', retired_at = NULL, retired_reason = NULL WHERE id = ?`).run(id);
  const recipe = JSON.parse(row.recipe_json);
  deployStrategy(id, recipe);
  console.log(`[restore] ✓ live ${id} (lifetime: ${row.n_trades || 0} trades, ${(row.realized_pnl_sol || 0).toFixed(3)} SOL)`);
}

console.log('[restore] done — restart degen-club');
