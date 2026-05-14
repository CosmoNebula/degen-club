// 2026-05-14 — overnight bleed of -2.5 SOL across 112 trades, 32% WR.
// Both alive-migrator and runner-mode have just 3 ML conditions and 40min
// age window — way too loose, that's why they fired 72 of the 112 trades
// and 60+ of the losses. STAGNATED was the biggest exit-reason bleeder
// (19 trades, -1.4 SOL avg -61%).
//
// This script:
//   1. Tightens entry conditions on all 5 active strategies — stricter ML
//      thresholds, behavioral filters, organic-interest floors, shorter
//      age windows. Goal: fewer trades, higher WR.
//   2. Bumps sizing modestly across strategies (capital scales 1.3 → 10 SOL).
//   3. Resets paper wallet to 10 SOL for unattended all-day trading.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const NOW = Date.now();
const TODAY = '2026-05-14';

const updates = [
  // ============ alive-migrator-v1 — biggest bleeder, tighten heavily ============
  {
    id: 'agent_2026-05-11_alive-migrator-v1',
    recipe: {
      name: 'alive-migrator-v1',
      rationale: 'TIGHTENED 2026-05-14 after -1.07 SOL overnight bleed on 46 trades (26% WR). Previous: 3 ML conditions, 40min window — way too loose, firing on basically any non-rugger. Now: higher ML conviction bar (migrated≥0.45, will_die_fast<0.25), staying-power floor (alive_at_1h≥0.55), organic-interest floor (unique_buyers≥12, sniper<30%, first-block<20%), and 15-min age cap. Expected ~50% volume reduction with sharper signal.',
      entry: {
        conditions: [
          { kind: 'ml_prediction', name: 'migrated', op: '>=', value: 0.45 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.30 },
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.55 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.25 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.25 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.30 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.20 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 12 },
        ],
        max_mint_age_sec: 900,  // 15min (was 40min)
      },
      sizing: { type: 'fixed', sol: 0.20 },  // 0.12 → 0.20 (10 SOL wallet)
      exit: {
        stop_loss_pct: 65,  // 75 → 65 — tighter SL with better entries
        take_profit_tiers: [
          { trigger_pct: 40, sell_pct: 20 },
          { trigger_pct: 120, sell_pct: 25 },
          { trigger_pct: 300, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 400, trail_pct: 30 },  // arm AFTER T3 fires
        max_hold_min: 60,  // 90 → 60
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.92 },
        breakeven_after_tier1: 1,
      },
    },
  },

  // ============ runner-mode-v1 — chase big runners, even tighter ============
  {
    id: 'agent_2026-05-11_runner-mode-v1',
    recipe: {
      name: 'runner-mode-v1',
      rationale: 'TIGHTENED 2026-05-14 after -0.61 SOL overnight (27% WR, 26 trades). Specialized for peaked_300+ runners: require peaked_300≥0.18 (top decile per yesterday distribution check). Plus staying-power, anti-sniper, organic floor. Shorter age window (10min) — we want fresh momentum, not 30-min-old coins.',
      entry: {
        conditions: [
          { kind: 'ml_prediction', name: 'migrated', op: '>=', value: 0.45 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.35 },
          { kind: 'ml_prediction', name: 'peaked_300', op: '>=', value: 0.18 },
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.55 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.25 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.20 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.30 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.20 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 15 },
        ],
        max_mint_age_sec: 600,
      },
      sizing: { type: 'fixed', sol: 0.25 },
      exit: {
        stop_loss_pct: 60,
        take_profit_tiers: [
          { trigger_pct: 75, sell_pct: 25 },
          { trigger_pct: 200, sell_pct: 35 },
          { trigger_pct: 500, sell_pct: 30 },
        ],
        trailing_stop: { arm_pct: 600, trail_pct: 40 },  // arm above T3
        max_hold_min: 90,
        prediction_exit: { target: 'rug_within_5min', op: '>', value: 0.7 },
        breakeven_after_tier1: 1,
      },
    },
  },

  // ============ slipstream-v1 — already tight, slight bump ============
  {
    id: 'agent_2026-05-13_slipstream-v1',
    recipe: {
      name: 'slipstream-v1',
      rationale: 'TIGHTENED 2026-05-14 from yesterday. Bumped buy_sell_ratio (1.2→1.5), unique_buyers (15→20), ML floors (hits_2x 0.25→0.35, peaked_100 0.30→0.35, peaked_30 0.50→0.65). Goal: only fire on clear momentum convergence post-sniper-window.',
      entry: {
        conditions: [
          { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 50 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '<=', value: 250 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.25 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.20 },
          { kind: 'snapshot_feature', name: 'buy_sell_ratio', op: '>=', value: 1.5 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 20 },
          { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.35 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.35 },
          { kind: 'ml_prediction', name: 'peaked_30', op: '>=', value: 0.65 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.25 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.45 },
        ],
        max_mint_age_sec: 600,
      },
      sizing: { type: 'fixed', sol: 0.15 },
      exit: {
        stop_loss_pct: 25,
        take_profit_tiers: [
          { trigger_pct: 30, sell_pct: 60 },
          { trigger_pct: 80, sell_pct: 100 },
        ],
        max_hold_min: 15,
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.85 },
        breakeven_after_tier1: 1,
        fast_fail: { sec: 90, min_peak_pct: 10, sl_pct: -15 },
      },
    },
  },

  // ============ apex-hunter-v1 — kept tight, just bump sizing ============
  {
    id: 'agent_2026-05-13_apex-hunter-v1',
    recipe: {
      name: 'apex-hunter-v1',
      rationale: 'Max-conviction big-bag. 6-model ML agreement required + clean distribution. Hasn\'t fired yet (entries genuinely rare) — that\'s the design. When it fires, it bets big on confirmed runners. Sizing 0.30 → 0.40 with 10 SOL wallet.',
      entry: {
        conditions: [
          { kind: 'snapshot_feature', name: 'bundle_buyers', op: '<=', value: 0 },
          { kind: 'snapshot_feature', name: 'top1_buyer_sol_pct', op: '<=', value: 22 },
          { kind: 'snapshot_feature', name: 'has_twitter', op: '>=', value: 1 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 30 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.20 },
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.45 },
          { kind: 'ml_prediction', name: 'alive_at_4h', op: '>=', value: 0.25 },
          { kind: 'ml_prediction', name: 'peaked_300', op: '>=', value: 0.18 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.30 },
          { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.30 },
          { kind: 'ml_prediction', name: 'migrated', op: '>=', value: 0.35 },
          { kind: 'ml_prediction', name: 'post_mig_peak_pct', op: '>=', value: 3.0 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.40 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.20 },
          { kind: 'ml_prediction', name: 'post_mig_rugs_1h', op: '<', value: 0.040 },
        ],
        max_mint_age_sec: 300,
      },
      sizing: { type: 'fixed', sol: 0.40 },
      exit: {
        stop_loss_pct: 65,
        take_profit_tiers: [
          { trigger_pct: 100, sell_pct: 20 },
          { trigger_pct: 400, sell_pct: 25 },
          { trigger_pct: 1000, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 1100, trail_pct: 55 },
        max_hold_min: 240,
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.95 },
        breakeven_after_tier1: 0,
      },
    },
  },

  // ============ trendweaver-v1 — slight ML tightening ============
  {
    id: 'agent_2026-05-13_trendweaver-v1',
    recipe: {
      name: 'trendweaver-v1',
      rationale: 'Sentiment-driven swing. Tightened ML floors after -0.36 SOL overnight: alive_at_1h 0.30→0.45, peaked_100 0.20→0.25. Sentiment + narrative gates use skip semantics (won\'t fire without data). Sizing 0.18 → 0.25.',
      entry: {
        conditions: [
          { kind: 'sentiment', metric: 'bull_mentions', op: '>=', value: 3 },
          { kind: 'sentiment', metric: 'total_mentions', op: '>=', value: 5 },
          { kind: 'narrative_match', op: '>=', value: 1 },
          { kind: 'snapshot_feature', name: 'inflow_accel_pct', op: '>', value: 0.10 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 20 },
          { kind: 'snapshot_feature', name: 'buy_sell_ratio', op: '>=', value: 1.1 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.30 },
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.45 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.25 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.35 },
        ],
        max_mint_age_sec: 1800,
      },
      sizing: { type: 'fixed', sol: 0.25 },
      exit: {
        stop_loss_pct: 45,
        take_profit_tiers: [
          { trigger_pct: 60, sell_pct: 25 },
          { trigger_pct: 180, sell_pct: 30 },
          { trigger_pct: 500, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 600, trail_pct: 35 },
        max_hold_min: 90,
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.90 },
      },
    },
  },
];

const d = db();
const updateStmt = d.prepare(`UPDATE ml_agent_strategies
  SET rationale = ?, recipe_json = ?, status = 'live' WHERE id = ?`);

for (const u of updates) {
  const r = updateStmt.run(u.recipe.rationale, JSON.stringify(u.recipe), u.id);
  if (r.changes === 0) {
    console.log(`[deploy] ⚠ ${u.id} not found in ml_agent_strategies`);
    continue;
  }
  deployStrategy(u.id, u.recipe);
  console.log(`[deploy] ↻ updated ${u.id}`);
}

// ============ wallet reset to 10 SOL ============
console.log('[wallet] resetting paper_wallet to 10 SOL...');
const cur = d.prepare('SELECT * FROM paper_wallet WHERE id=1').get();
console.log(`[wallet]   was: starting=${cur?.starting_balance_sol} reset_count=${cur?.reset_count} peak=${cur?.peak_total_value?.toFixed(3)}`);
d.prepare(`UPDATE paper_wallet SET
  starting_balance_sol = 10.0,
  started_at = ?,
  reset_count = COALESCE(reset_count, 0) + 1,
  peak_total_value = 10.0,
  peak_at = ?
WHERE id = 1`).run(NOW, NOW);
const after = d.prepare('SELECT * FROM paper_wallet WHERE id=1').get();
console.log(`[wallet]   now: starting=${after.starting_balance_sol} reset_count=${after.reset_count}`);

// ============ clean strategy_state counters so historical bleed doesn't pollute ============
console.log('[strategy-state] clearing positions_opened / wins / losses / total_pnl_sol counters...');
d.prepare(`UPDATE strategy_state SET
  positions_opened = 0, wins = 0, losses = 0, total_pnl_sol = 0, updated_at = ?
WHERE name LIKE 'agent_%' AND enabled = 1`).run(NOW);

console.log('[deploy] done — restart degen-club to pick up changes');
