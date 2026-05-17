// 2026-05-16: deploy fresh-survivor-v1.
//
// Architectural pivot: instead of waiting for a coin to accumulate 8-30
// buyers and high tpm before entering (which happens at 4-10min mark when
// the run is already over), enter on the FIRST organic buy after the sniper
// war winds down. Trigger 'fresh-survivor-XXs' fires in processor.js when:
//   - non-sniper buy lands on a 20-120s old coin
//   - mcap is 2-15 SOL (sub-graduation, full upside intact)
//
// Per-strategy gates are deliberately LOW on accumulation features because
// the WHOLE POINT is to be early. Heavy reliance on rug-risk ML model for
// safety instead of buyer-count thresholds.
//
// Retiring tracker-elite-v2 (5% WR / -0.81 SOL overnight) and organic-runner-v2
// (n=1, insufficient sample). Keeping momentum-confirmed-v2 (42% WR, working).

import { db } from '../src/db/index.js';
import { deployStrategy, retireStrategy } from '../src/ml/agent-executor.js';

const TODAY = '2026-05-16';
const NOW = Date.now();
const RETIRE_REASON = '2026-05-16 — pivoting to fresh-survivor architecture. tracker-elite (5% WR / -0.81 SOL) was bag-holder, organic-runner n=1.';

const RETIRE_IDS = [
  'agent_2026-05-15_tracker-elite-v2',
  'agent_2026-05-15_organic-runner-v2',
];

const strategy = {
  id: `agent_${TODAY}_fresh-survivor-v1`,
  recipe: {
    name: 'fresh-survivor-v1',
    rationale: 'Fires on the new fresh-survivor trigger (non-sniper buy on 20-120s old, 2-15 SOL mcap coin). The thesis: by t=20s the pure bot bundle war is winding down; the first non-sniper buy in this window is a human discovering the coin while it still has full upside. Light gates (unique_buyers >= 3, loose sniper tolerance) because we WANT to be early. Confidence-weighted sizing on hits_2x_within_1h.',
    entry: {
      conditions: [
        { kind: 'snapshot_feature', name: 'last_mcap_sol',    op: '>=', value: 2 },
        { kind: 'snapshot_feature', name: 'last_mcap_sol',    op: '<=', value: 15 },
        { kind: 'snapshot_feature', name: 'unique_buyers',    op: '>=', value: 3 },
        { kind: 'snapshot_feature', name: 'pct_sniper_buys',  op: '<=', value: 0.55 },
        { kind: 'ml_prediction',    name: 'rug_within_5min',  op: '<',  value: 0.15 },
      ],
      max_mint_age_sec: 120,
      max_entry_slippage_pct: 0.30, // young coins move fast — accept some chase
    },
    sizing: {
      type: 'confidence_weighted',
      sol: 0.18,
      confidence_scale_by: 'hits_2x_within_1h',
      scale_direction: 'positive',
      min_mult: 0.7,
      max_mult: 1.5,
    },
    cooldowns: {
      after_exit_ms: 0,                  // re-entry on same mint allowed
      after_fast_fail_ms: 5 * 60 * 1000, // short — don't blacklist 1h on a fast coin
    },
    exit: {
      stop_loss_pct: 30,
      take_profit_tiers: [
        { trigger_pct: 50,  sell_pct: 50 },  // 1.5x → half off
        { trigger_pct: 150, sell_pct: 30 },  // 2.5x → 30% more
        { trigger_pct: 500, sell_pct: 20 },  // 6x → moonbag
      ],
      trailing_stop: { arm_pct: 200, trail_pct: 30 },
      peak_floor_tiers: [
        { arm_pct: 30,  exit_pct: 10  }, // lock +10% on any +30% peak
        { arm_pct: 100, exit_pct: 50  }, // lock +50% on +100% peak
        { arm_pct: 300, exit_pct: 150 }, // lock +150% on +300% peak
      ],
      max_hold_min: 5,                    // these pop or die fast
      breakeven_after_tier1: 1,
    },
  },
};

const d = db();
for (const id of RETIRE_IDS) {
  const row = d.prepare('SELECT id, n_trades, realized_pnl_sol FROM ml_agent_strategies WHERE id = ?').get(id);
  if (row && row.id) {
    retireStrategy(id, RETIRE_REASON);
    console.log(`[deploy] ✗ retired ${id} (${row.n_trades || 0} trades, ${(row.realized_pnl_sol || 0).toFixed(3)} SOL)`);
  }
}

const existsStmt = d.prepare('SELECT id FROM ml_agent_strategies WHERE id = ?');
const insertStmt = d.prepare(`INSERT INTO ml_agent_strategies (id, name, rationale, recipe_json, status, created_at, generation) VALUES (?,?,?,?, 'live', ?, 1)`);
const updateStmt = d.prepare(`UPDATE ml_agent_strategies SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL WHERE id = ?`);

if (existsStmt.get(strategy.id)) {
  updateStmt.run(strategy.recipe.rationale, JSON.stringify(strategy.recipe), strategy.id);
  deployStrategy(strategy.id, strategy.recipe);
  console.log(`[deploy] ↻ updated ${strategy.id}`);
} else {
  insertStmt.run(strategy.id, strategy.recipe.name, strategy.recipe.rationale, JSON.stringify(strategy.recipe), NOW);
  deployStrategy(strategy.id, strategy.recipe);
  console.log(`[deploy] ✓ ${strategy.id}`);
}
console.log('[deploy] done — restart degen-club');
