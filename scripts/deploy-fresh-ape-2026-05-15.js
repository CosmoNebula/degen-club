// 2026-05-15: Add fresh-ape-v1.
//
// Today's autopsy revealed the structural problem with the current 3
// strategies: we enter at ~60 SOL mcap, ~7 min into a coin's life, and
// for FAST_FAIL closes the coin's lifetime peak is only 1.12x our entry.
// We're buying TOPS, not bottoms.
//
// fresh-ape-v1 attacks the opposite zone: enter <2 min old, 2-15 SOL mcap,
// where there's still room for a 5-10x. No ML positive-signal gates — those
// have been mis-calibrated all day. Safety gates (rug/drawdown) remain.
// Tight stop and short hold because small mcap = fast moves both ways.
//
// Runs ALONGSIDE the existing 3 — does not retire anything.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const TODAY = '2026-05-15';
const NOW = Date.now();

const strategy = {
  id: `agent_${TODAY}_fresh-ape-v1`,
  recipe: {
    name: 'fresh-ape-v1',
    rationale: 'Early-entry ape: 2-15 SOL mcap, <2min age. Thesis: today\'s FAST_FAIL cohort showed avg coin-lifetime-peak of only 1.12x avg entry mcap — by 60 SOL the run is over. Enter sub-15 SOL while there\'s still 5-10x of room. No ML positive gates (mis-calibrated all day). Safety gates only (rug_within_5min, drawdown_20pct_300s) + distribution floors (unique_buyers, sniper%). Tight 35% stop, 10min max hold, 4-tier exit ladder tuned for fast small-mcap moves.',
    entry: {
      conditions: [
        // Safety (ML negative signals — trusted)
        { kind: 'ml_prediction',    name: 'rug_within_5min',         op: '<',  value: 0.12 },
        { kind: 'ml_prediction',    name: 'drawdown_20pct_300s',     op: '<',  value: 0.55 },
        // EARLY-zone geometry — the whole thesis
        { kind: 'snapshot_feature', name: 'last_mcap_sol',           op: '>=', value: 2 },
        { kind: 'snapshot_feature', name: 'last_mcap_sol',           op: '<=', value: 15 },
        // Real human interest, looser on sniper% since fresh coins skew higher
        { kind: 'snapshot_feature', name: 'unique_buyers',           op: '>=', value: 4 },
        { kind: 'snapshot_feature', name: 'pct_sniper_buys',         op: '<=', value: 0.50 },
        { kind: 'snapshot_feature', name: 'pct_first_block_buys',   op: '<=', value: 0.40 },
      ],
      max_mint_age_sec: 120, // 2 min — the whole point is to be early
    },
    sizing: { type: 'fixed', sol: 0.15 },
    exit: {
      stop_loss_pct: 35,
      take_profit_tiers: [
        { trigger_pct: 100, sell_pct: 40 },  // 2x → 40% out
        { trigger_pct: 300, sell_pct: 40 },  // 4x → 40% out
        { trigger_pct: 800, sell_pct: 20 },  // 9x → moonbag
      ],
      trailing_stop: { arm_pct: 300, trail_pct: 30 },
      // Peak-floor cascade tuned for small-mcap fast moves
      peak_floor_tiers: [
        { arm_pct: 50,  exit_pct: 15  }, // any pop ≥1.5x: lock +15%
        { arm_pct: 150, exit_pct: 75  }, // 2.5x peak: lock +75%
        { arm_pct: 400, exit_pct: 200 }, // 5x peak: lock 3x
      ],
      max_hold_min: 10,
      breakeven_after_tier1: 1,
    },
  },
};

const d = db();
const existsStmt = d.prepare(`SELECT id FROM ml_agent_strategies WHERE id = ?`);
const insertStmt = d.prepare(`INSERT INTO ml_agent_strategies
  (id, name, rationale, recipe_json, status, created_at, generation)
  VALUES (?, ?, ?, ?, 'live', ?, 1)`);
const updateStmt = d.prepare(`UPDATE ml_agent_strategies
  SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL
  WHERE id = ?`);

if (existsStmt.get(strategy.id)) {
  updateStmt.run(strategy.recipe.rationale, JSON.stringify(strategy.recipe), strategy.id);
  deployStrategy(strategy.id, strategy.recipe);
  console.log(`[deploy] ↻ updated ${strategy.id}`);
} else {
  insertStmt.run(strategy.id, strategy.recipe.name, strategy.recipe.rationale, JSON.stringify(strategy.recipe), NOW);
  deployStrategy(strategy.id, strategy.recipe);
  console.log(`[deploy] ✓ ${strategy.id}`);
}
console.log('[deploy] done — restart degen-club for the executor to pick up the new strategy');
