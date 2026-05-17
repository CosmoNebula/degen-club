// 2026-05-16: simple-mode reset. Retire all 6 currents, deploy 2 dead-simple
// strategies that just follow proven buyers. 2-3 gates each, no OR-groups,
// no confidence sizing tricks, no smart-trader veto opt-outs.

import { db } from '../src/db/index.js';
import { deployStrategy, retireStrategy } from '../src/ml/agent-executor.js';

const TODAY = '2026-05-16';
const NOW = Date.now();
const RETIRE_REASON = '2026-05-16 — simple-mode reset. Too many gates were choking entries. Going back to "follow the smart wallets" with rug-safety only.';

const d = db();
const live = d.prepare(`SELECT id FROM ml_agent_strategies WHERE status='live'`).all();
for (const row of live) {
  retireStrategy(row.id, RETIRE_REASON);
  console.log(`[deploy] ✗ retired ${row.id}`);
}

// -------------------- STRATEGY 1: tracker-copy-v1 --------------------
// If a tracked wallet bought it, follow them in. The only safety: don't
// buy obvious rugs. ML does the rug filtering, the tracker does the picking.
const trackerCopy = {
  id: `agent_${TODAY}_tracker-copy-v1`,
  recipe: {
    name: 'tracker-copy-v1',
    rationale: 'Dead simple: tracked wallet bought it → we buy it. Only filter is rug_within_5min. No buyer count, no momentum, no mcap gates — the tracked wallet is the entire conviction signal.',
    entry: {
      conditions: [
        { kind: 'snapshot_feature', name: 'tracked_buyers',   op: '>=', value: 1 },
        { kind: 'ml_prediction',    name: 'rug_within_5min',  op: '<',  value: 0.25 },
      ],
      max_mint_age_sec: 1200,
    },
    sizing: { type: 'fixed', sol: 0.15 },
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

// -------------------- STRATEGY 2: kol-follow-v1 --------------------
// Same shape but for KOL wallets (a separate proven-buyer category).
const kolFollow = {
  id: `agent_${TODAY}_kol-follow-v1`,
  recipe: {
    name: 'kol-follow-v1',
    rationale: 'Dead simple: KOL wallet bought it → we buy it. Rug filter only.',
    entry: {
      conditions: [
        { kind: 'snapshot_feature', name: 'kol_buyers',       op: '>=', value: 1 },
        { kind: 'ml_prediction',    name: 'rug_within_5min',  op: '<',  value: 0.25 },
      ],
      max_mint_age_sec: 1200,
    },
    sizing: { type: 'fixed', sol: 0.15 },
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

const existsStmt = d.prepare('SELECT id FROM ml_agent_strategies WHERE id = ?');
const insertStmt = d.prepare(`INSERT INTO ml_agent_strategies (id, name, rationale, recipe_json, status, created_at, generation) VALUES (?,?,?,?, 'live', ?, 1)`);
const updateStmt = d.prepare(`UPDATE ml_agent_strategies SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL WHERE id = ?`);

for (const s of [trackerCopy, kolFollow]) {
  if (existsStmt.get(s.id)) {
    updateStmt.run(s.recipe.rationale, JSON.stringify(s.recipe), s.id);
    deployStrategy(s.id, s.recipe);
    console.log(`[deploy] ↻ ${s.id}`);
  } else {
    insertStmt.run(s.id, s.recipe.name, s.recipe.rationale, JSON.stringify(s.recipe), NOW);
    deployStrategy(s.id, s.recipe);
    console.log(`[deploy] ✓ ${s.id}`);
  }
}
console.log('[deploy] done');
