// One-shot: deploy 3 new strategies alongside the existing alive-migrator-v1.
//
// 1) Slipstream     — quick 1.5-2x flips, mid-mcap past sniper window
// 2) Apex Hunter    — max-conviction big-bag entries, ride to massive Xs
// 3) Trendweaver    — sentiment + on-chain confirmation
//
// Each has a distinctly different entry niche so the four strategies are
// non-overlapping. Idempotent: skips strategies already in ml_agent_strategies.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const TODAY = '2026-05-13';
const NOW = Date.now();

const strategies = [
  {
    id: `agent_${TODAY}_slipstream-v1`,
    recipe: {
      name: 'slipstream-v1',
      rationale: 'Quick 1.5-2x flips on mid-mcap mints that have already cleared the sniper-dominant phase. Avoids fighting first-block bots by entering at >50 SOL mcap with humans-driven buy pressure (buy_sell_ratio >= 1.2, low sniper ratio). Leans on the new hits_2x_within_1h coin-level model — predicts quick doubles directly — plus peaked_100 as a confirming signal. Tight exits — T1 at +30% locks half, T2 at +80% locks the rest. 18% trail and 15-min max hold force capital recycling.',
      entry: {
        conditions: [
          { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 50 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '<=', value: 250 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.30 },
          { kind: 'snapshot_feature', name: 'buy_sell_ratio', op: '>=', value: 1.2 },
          { kind: 'snapshot_feature', name: 'tracked_buyers', op: '>=', value: 1 },
          // New coin-level "quick double" model — most direct fit for this strategy's goal
          { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.35 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.40 },
          { kind: 'ml_prediction', name: 'peaked_30', op: '>=', value: 0.60 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.35 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.55 },
        ],
        max_mint_age_sec: 600,
      },
      sizing: { type: 'fixed', sol: 0.10 },
      exit: {
        stop_loss_pct: 25,
        take_profit_tiers: [
          { trigger_pct: 30, sell_pct: 50 },
          { trigger_pct: 80, sell_pct: 50 },
        ],
        trailing_stop: { arm_pct: 25, trail_pct: 18 },
        max_hold_min: 15,
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.85 },
        breakeven_after_tier1: 1,
        fast_fail: { sec: 90, min_peak_pct: 10, sl_pct: -15 },
      },
    },
  },
  {
    id: `agent_${TODAY}_apex-hunter-v1`,
    recipe: {
      name: 'apex-hunter-v1',
      rationale: 'Maximum-conviction entries on coins with 3+ trackers AND a KOL AND clean holder distribution (top1 < 22%, no bundles) AND social presence. Stacks every new coin-level "long horizon" model we trained: alive_at_4h (staying power), peaked_300 (4x+ probability), migrated (graduation path), AND post_mig_peak_pct (predicts post-migration upside specifically) — the post-mig model is the one that should differentiate true runners from one-pop wonders. Bigger bag (0.30 SOL = ~2.5x normal), wide stops (-65% SL), staircase ladder built for 10x+ runners: T1 +100%/20%, T2 +400%/25%, T3 +1000%/25%, leaving 30% riding a 55% trail. 4-hour max hold. fast_fail disabled — do not panic out of conviction plays.',
      entry: {
        conditions: [
          // Holder-quality gates
          { kind: 'snapshot_feature', name: 'tracked_buyers', op: '>=', value: 3 },
          { kind: 'snapshot_feature', name: 'kol_buyers', op: '>=', value: 1 },
          { kind: 'snapshot_feature', name: 'bundle_buyers', op: '<=', value: 0 },
          { kind: 'snapshot_feature', name: 'top1_buyer_sol_pct', op: '<=', value: 22 },
          { kind: 'snapshot_feature', name: 'has_twitter', op: '>=', value: 1 },
          // Long-horizon coin-level ML signal (the new hold-to-maturity models)
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.70 },
          { kind: 'ml_prediction', name: 'alive_at_4h', op: '>=', value: 0.50 },
          { kind: 'ml_prediction', name: 'peaked_300', op: '>=', value: 0.40 },
          { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.45 },
          { kind: 'ml_prediction', name: 'migrated', op: '>=', value: 0.45 },
          // Post-migration upside predictor — the new model trained on post-mig coin outcomes
          { kind: 'ml_prediction', name: 'post_mig_peak_pct', op: '>=', value: 0.40 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.30 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.25 },
          { kind: 'ml_prediction', name: 'post_mig_rugs_1h', op: '<', value: 0.30 },
        ],
        max_mint_age_sec: 300,
      },
      sizing: { type: 'fixed', sol: 0.30 },
      exit: {
        stop_loss_pct: 65,
        take_profit_tiers: [
          { trigger_pct: 100, sell_pct: 20 },
          { trigger_pct: 400, sell_pct: 25 },
          { trigger_pct: 1000, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 150, trail_pct: 55 },
        max_hold_min: 240,
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.95 },
        breakeven_after_tier1: 0,
      },
    },
  },
  {
    id: `agent_${TODAY}_trendweaver-v1`,
    recipe: {
      name: 'trendweaver-v1',
      rationale: 'Cultural/social-driven entries where Claude-scored sentiment confirms via bull mentions AND on-chain buying pressure aligns (inflow_accel_pct > 0.10). Different niche from price-action-only strategies — surfaces coins riding a real narrative wave. Sentiment conditions use skip semantics (no data = no opinion, not a fail) so the strategy doesn\'t fire when sentiment hasn\'t loaded. Medium ladder (+60/+180/+500) and 35% trail for swing-style holds.',
      entry: {
        conditions: [
          // Sentiment gates use skip semantics — if no sentiment data exists,
          // they return 'skip' (not fail). The strategy still requires the
          // on-chain confirmation conditions to pass; sentiment is the
          // differentiator from purely-on-chain strategies.
          { kind: 'sentiment', metric: 'bull_mentions', op: '>=', value: 3 },
          { kind: 'sentiment', metric: 'total_mentions', op: '>=', value: 5 },
          // Narrative match — does this mint match a story Claude is already tracking?
          { kind: 'narrative_match', op: '>=', value: 1 },
          // On-chain confirmation
          { kind: 'snapshot_feature', name: 'inflow_accel_pct', op: '>', value: 0.10 },
          { kind: 'snapshot_feature', name: 'tracked_buyers', op: '>=', value: 1 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.40 },
          // Coin-level ML — staying-power confirmation for a swing hold
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.55 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.30 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.40 },
        ],
        max_mint_age_sec: 1800,
      },
      sizing: { type: 'fixed', sol: 0.18 },
      exit: {
        stop_loss_pct: 45,
        take_profit_tiers: [
          { trigger_pct: 60, sell_pct: 25 },
          { trigger_pct: 180, sell_pct: 30 },
          { trigger_pct: 500, sell_pct: 25 },
        ],
        trailing_stop: { arm_pct: 50, trail_pct: 35 },
        max_hold_min: 90,
        prediction_exit: { target: 'will_die_fast', op: '>', value: 0.90 },
      },
    },
  },
];

const d = db();
const insertStmt = d.prepare(`INSERT INTO ml_agent_strategies
  (id, name, rationale, recipe_json, status, created_at, generation)
  VALUES (?, ?, ?, ?, 'live', ?, 1)`);
const existsStmt = d.prepare(`SELECT id FROM ml_agent_strategies WHERE id = ?`);

for (const s of strategies) {
  if (existsStmt.get(s.id)) {
    console.log(`[deploy] SKIP ${s.id} — already exists`);
    continue;
  }
  insertStmt.run(s.id, s.recipe.name, s.recipe.rationale, JSON.stringify(s.recipe), NOW);
  deployStrategy(s.id, s.recipe);
  console.log(`[deploy] ✓ ${s.id}`);
}
console.log('[deploy] done — restart degen-club for the executor to pick them up');
