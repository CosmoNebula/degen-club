// 2026-05-15 (PM-3): Full strategy wipe + 3 data-driven replacements.
//
// Today's autopsy:
//   - 47 paper trades, ZERO hit even 30% peak. Picks are pure duds.
//   - The current 3 strategies (graduation-hunter, peak-snatcher, runner-trailer)
//     enter on gates that don't actually discriminate winners from losers in
//     the current regime — they accept "not yet rugged" but not "actually
//     pumping with real demand."
//
// New design derived from 7d historical stencil (snap_age=60s):
//   Winners (hit 2x in 1h, n=5,750)    vs Losers (n=104,840)
//     unique_buyers         29 vs 10         (3x)
//     trades_per_min        77 vs 27         (3x)
//     pct_sniper_buys       0.21 vs 0.55     (half)
//     pressure_60_net       +0.2 vs 0.0      (positive)
//     longest_up_run_pct    8.0 vs 3.6       (2x)
//
//   THE BIGGEST EDGE — tracked_buyers ≥ 1:
//     baseline (no tracker):   4.9% p_2x,  0.5% p_migrate
//     tracker ≥ 1:             15.7% p_2x, 5.4% p_migrate  (3.7x / 10x lift)
//     kol + tracker:           18.0% p_2x, 3.0% p_migrate
//
//   Counterintuitive: creator_migrated_count INVERTS for p_2x:
//     0 grads: 5.4%  → 5+ grads: 3.0%  (veterans farm us)
//
// Three strategies cover different "this looks like a winner" patterns:
//   1) tracker-elite-v1      — bets the 3.7x tracker lift, broadest mcap zone
//   2) organic-runner-v1     — no tracker required, full distribution match
//   3) momentum-confirmed-v1 — ML positive signal + price actually moving up

import { db } from '../src/db/index.js';
import { deployStrategy, retireStrategy } from '../src/ml/agent-executor.js';

const TODAY = '2026-05-15';
const NOW = Date.now();
const RETIRE_REASON = '2026-05-15 PM-3 wipe — 47 trades / 0 hit even 30% peak, picks not discriminating winners. Replaced with 3 strategies built from 7d winner-stencil data.';

const strategies = [
  // -------------------------------------------------------------------------
  // 1) tracker-elite-v1 — the 3.7x lift play
  // -------------------------------------------------------------------------
  {
    id: `agent_${TODAY}_tracker-elite-v1`,
    recipe: {
      name: 'tracker-elite-v1',
      rationale: 'Bets the 3.7x p_2x lift from tracked_buyers≥1 (15.7% vs 4.9% baseline, n=2,855). Combines tracker presence with the winner-stencil distribution profile (unique_buyers≥15, trades_per_min≥30, low sniper%). Safety ML gates kept. Peak-floor cascade arms at +50% to fix today\'s give-back problem (+67% peak → +8% kept).',
      entry: {
        conditions: [
          { kind: 'snapshot_feature', name: 'tracked_buyers',         op: '>=', value: 1 },
          { kind: 'snapshot_feature', name: 'unique_buyers',          op: '>=', value: 15 },
          { kind: 'snapshot_feature', name: 'trades_per_min',         op: '>=', value: 30 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys',        op: '<=', value: 0.30 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys',  op: '<=', value: 0.25 },
          { kind: 'ml_prediction',    name: 'rug_within_5min',        op: '<',  value: 0.10 },
          { kind: 'ml_prediction',    name: 'drawdown_20pct_300s',    op: '<',  value: 0.50 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',          op: '>=', value: 8 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',          op: '<=', value: 120 },
        ],
        max_mint_age_sec: 300,
      },
      sizing: { type: 'fixed', sol: 0.18 },
      exit: {
        stop_loss_pct: 40,
        take_profit_tiers: [
          { trigger_pct: 75,  sell_pct: 35 },
          { trigger_pct: 200, sell_pct: 40 },
          { trigger_pct: 600, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 250, trail_pct: 30 },
        peak_floor_tiers: [
          { arm_pct: 50,  exit_pct: 20 },   // fixes give-back: +50% peak locks +20%
          { arm_pct: 150, exit_pct: 80 },
          { arm_pct: 400, exit_pct: 200 },
        ],
        max_hold_min: 15,
        breakeven_after_tier1: 1,
      },
    },
  },

  // -------------------------------------------------------------------------
  // 2) organic-runner-v1 — full winner stencil, no tracker required
  // -------------------------------------------------------------------------
  {
    id: `agent_${TODAY}_organic-runner-v1`,
    recipe: {
      name: 'organic-runner-v1',
      rationale: 'No-tracker variant matching the FULL winner stencil. Requires unique_buyers≥25, trades_per_min≥60, pressure_60_net>0, longest_up_run≥5%, creator_migrated_count<2 (5+ grads farm us per data: 3.0% p_2x vs 5.4% for 0 grads). Tight 3-min entry window.',
      entry: {
        conditions: [
          { kind: 'snapshot_feature', name: 'unique_buyers',          op: '>=', value: 25 },
          { kind: 'snapshot_feature', name: 'trades_per_min',         op: '>=', value: 60 },
          { kind: 'snapshot_feature', name: 'pressure_60_net',        op: '>',  value: 0 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys',        op: '<=', value: 0.25 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys',  op: '<=', value: 0.20 },
          { kind: 'snapshot_feature', name: 'creator_migrated_count', op: '<',  value: 2 },
          { kind: 'snapshot_feature', name: 'longest_up_run_pct',     op: '>=', value: 5 },
          { kind: 'ml_prediction',    name: 'rug_within_5min',        op: '<',  value: 0.10 },
          { kind: 'ml_prediction',    name: 'drawdown_20pct_300s',    op: '<',  value: 0.50 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',          op: '>=', value: 6 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',          op: '<=', value: 100 },
        ],
        max_mint_age_sec: 180,
      },
      sizing: { type: 'fixed', sol: 0.18 },
      exit: {
        stop_loss_pct: 40,
        take_profit_tiers: [
          { trigger_pct: 80,  sell_pct: 35 },
          { trigger_pct: 250, sell_pct: 40 },
          { trigger_pct: 700, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 250, trail_pct: 30 },
        peak_floor_tiers: [
          { arm_pct: 50,  exit_pct: 20 },
          { arm_pct: 150, exit_pct: 80 },
          { arm_pct: 400, exit_pct: 200 },
        ],
        max_hold_min: 12,
        breakeven_after_tier1: 1,
      },
    },
  },

  // -------------------------------------------------------------------------
  // 3) momentum-confirmed-v1 — ML + price-actually-moving-up
  // -------------------------------------------------------------------------
  {
    id: `agent_${TODAY}_momentum-confirmed-v1`,
    recipe: {
      name: 'momentum-confirmed-v1',
      rationale: 'Wait for ML to confirm price is moving up (price_up_60s≥0.5) AND demand is sticky (buy_pressure_continues_60s≥0.40). Maximum-confirmation entry — wider age window (60-600s) to catch mid-pumps. Tighter 35% SL since less room left after confirmation.',
      entry: {
        conditions: [
          { kind: 'ml_prediction',    name: 'price_up_60s',               op: '>=', value: 0.5 },
          { kind: 'ml_prediction',    name: 'buy_pressure_continues_60s', op: '>=', value: 0.40 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys',            op: '<=', value: 0.30 },
          { kind: 'snapshot_feature', name: 'unique_buyers',              op: '>=', value: 20 },
          { kind: 'ml_prediction',    name: 'rug_within_5min',            op: '<',  value: 0.08 },
          { kind: 'ml_prediction',    name: 'drawdown_20pct_300s',        op: '<',  value: 0.45 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',              op: '>=', value: 10 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',              op: '<=', value: 150 },
        ],
        max_mint_age_sec: 600,
      },
      sizing: { type: 'fixed', sol: 0.18 },
      exit: {
        stop_loss_pct: 35,
        take_profit_tiers: [
          { trigger_pct: 60,  sell_pct: 40 },
          { trigger_pct: 180, sell_pct: 40 },
          { trigger_pct: 500, sell_pct: 20 },
        ],
        trailing_stop: { arm_pct: 200, trail_pct: 30 },
        peak_floor_tiers: [
          { arm_pct: 40,  exit_pct: 15 },
          { arm_pct: 120, exit_pct: 60 },
          { arm_pct: 350, exit_pct: 180 },
        ],
        max_hold_min: 10,
        breakeven_after_tier1: 1,
      },
    },
  },
];

const d = db();
const liveStmt = d.prepare(`SELECT id, n_trades, realized_pnl_sol FROM ml_agent_strategies WHERE status='live'`);
const live = liveStmt.all();
console.log(`[deploy] retiring ${live.length} live strategies:`);
for (const s of live) {
  retireStrategy(s.id, RETIRE_REASON);
  console.log(`[deploy]   ✗ retired ${s.id} (${s.n_trades} trades, ${(s.realized_pnl_sol || 0).toFixed(3)} SOL)`);
}

const existsStmt = d.prepare(`SELECT id FROM ml_agent_strategies WHERE id = ?`);
const insertStmt = d.prepare(`INSERT INTO ml_agent_strategies
  (id, name, rationale, recipe_json, status, created_at, generation)
  VALUES (?, ?, ?, ?, 'live', ?, 1)`);
const updateStmt = d.prepare(`UPDATE ml_agent_strategies
  SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL
  WHERE id = ?`);

for (const s of strategies) {
  if (existsStmt.get(s.id)) {
    updateStmt.run(s.recipe.rationale, JSON.stringify(s.recipe), s.id);
    deployStrategy(s.id, s.recipe);
    console.log(`[deploy] ↻ updated ${s.id}`);
  } else {
    insertStmt.run(s.id, s.recipe.name, s.recipe.rationale, JSON.stringify(s.recipe), NOW);
    deployStrategy(s.id, s.recipe);
    console.log(`[deploy] ✓ ${s.id}`);
  }
}
console.log('[deploy] done — restart degen-club for the executor to pick up the new live set');
