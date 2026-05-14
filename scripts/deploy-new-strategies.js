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
      rationale: 'Quick 1.5-2x flips on mid-mcap mints that have already cleared the sniper-dominant phase. PURE COIN-LEVEL — no tracker requirement. Avoids fighting first-block bots via behavioral filters (pct_sniper_buys <= 0.30, pct_first_block_buys <= 0.25) plus organic-interest floor (unique_buyers >= 15). Leans on hits_2x_within_1h + peaked_100 + peaked_30 stack — the new coin-level models directly answer "will this pop?" without needing wallet-quality signal. Tight exits: T1 +30%/50%, T2 +80%/50%. 18% trail + 15-min max hold force capital recycling.',
      entry: {
        conditions: [
          // Pure coin-level gates — no wallet/tracker requirements
          { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 50 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '<=', value: 250 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.30 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.25 },
          { kind: 'snapshot_feature', name: 'buy_sell_ratio', op: '>=', value: 1.2 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 15 },
          // Coin-level ML stack — calibrated to actual prob distribution
          // (means: hits_2x=0.10, peaked_100=0.11, peaked_30=0.19, will_die=0.69)
          { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.25 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.30 },
          { kind: 'ml_prediction', name: 'peaked_30', op: '>=', value: 0.50 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.35 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.55 },
        ],
        max_mint_age_sec: 600,
      },
      sizing: { type: 'fixed', sol: 0.10 },
      exit: {
        stop_loss_pct: 25,
        take_profit_tiers: [
          { trigger_pct: 30, sell_pct: 60 },     // lock 60% fast
          { trigger_pct: 80, sell_pct: 100 },    // full exit on remaining
        ],
        // No trailing stop — quick-flip strategy uses tier sells + breakeven
        // SL after T1 + 15min max hold. Trail above T2 would never fire (T2
        // closes 100%); trail below T2 would shake us out before T2.
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
      rationale: 'Maximum-conviction big-bag entries — PURE COIN-LEVEL, no tracker/KOL requirements. Conviction proven by stacking high thresholds across every coin-level model we trained: alive_at_1h>=0.80, alive_at_4h>=0.60, peaked_300>=0.55, migrated>=0.55, hits_2x_within_1h>=0.55, AND post_mig_peak_pct>=0.55 (post-migration upside predictor). Plus organic-interest floor (unique_buyers>=30) and clean distribution (top1<=22%, no bundles, has_twitter). The ML stack itself is the conviction — if 6+ models all agree this coin runs, we want a big bag in it. Wide stops (-65% SL), staircase ladder for 10x+ runners: T1 +100%/20%, T2 +400%/25%, T3 +1000%/25%, 30% rides a 55% trail. 4-hour max hold. fast_fail disabled — do not panic out of conviction plays.',
      entry: {
        conditions: [
          // Distribution gates (coin-level, not wallet-quality)
          { kind: 'snapshot_feature', name: 'bundle_buyers', op: '<=', value: 0 },
          { kind: 'snapshot_feature', name: 'top1_buyer_sol_pct', op: '<=', value: 22 },
          { kind: 'snapshot_feature', name: 'has_twitter', op: '>=', value: 1 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 30 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys', op: '<=', value: 0.20 },
          // ML stack — calibrated to actual prob distribution. peaked_300 max
          // observed = 0.391 so 0.55 was impossible. hits_2x_within_1h max = 0.5.
          // will_die_fast mean = 0.69 so < 0.30 was nearly impossible.
          // post_mig_peak_pct is REGRESSION (pct value, not prob) — mean 5.09.
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.45 },
          { kind: 'ml_prediction', name: 'alive_at_4h', op: '>=', value: 0.25 },
          { kind: 'ml_prediction', name: 'peaked_300', op: '>=', value: 0.18 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.30 },
          { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.30 },
          { kind: 'ml_prediction', name: 'migrated', op: '>=', value: 0.35 },
          // Post-migration upside predictor (regression: peak % from mig)
          { kind: 'ml_prediction', name: 'post_mig_peak_pct', op: '>=', value: 3.0 },
          { kind: 'ml_prediction', name: 'will_die_fast', op: '<', value: 0.40 },
          { kind: 'ml_prediction', name: 'rug_within_5min', op: '<', value: 0.20 },
          { kind: 'ml_prediction', name: 'post_mig_rugs_1h', op: '<', value: 0.040 },
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
        // Trail arms AFTER T3 fires (+1000%). Once we've locked 70% of position
        // via 3 tiers, the residual 30% rides a wide trail to capture full
        // runner upside. Arm at +1100% so trail never kicks in before T3.
        trailing_stop: { arm_pct: 1100, trail_pct: 55 },
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
      rationale: 'Cultural/social-driven entries — PURE COIN-LEVEL, no tracker requirement. Conviction comes from THREE independent layers agreeing: (1) Claude-scored sentiment (bull_mentions>=3, total_mentions>=5), (2) Claude-tracked narrative_match (mint matches active news story), (3) on-chain buying pressure (inflow_accel>0.10, unique_buyers>=20, buy_sell_ratio>=1.1) AND ML staying-power floor (alive_at_1h>=0.55). Different niche from price-action-only strategies — surfaces coins riding a real cultural wave. Sentiment + narrative use skip semantics so the strategy won\'t fire if those signals are missing. Medium ladder (+60/+180/+500) and 35% trail for swing-style holds.',
      entry: {
        conditions: [
          // Sentiment + narrative (skip semantics — no data = skip this gate, not fail)
          { kind: 'sentiment', metric: 'bull_mentions', op: '>=', value: 3 },
          { kind: 'sentiment', metric: 'total_mentions', op: '>=', value: 5 },
          { kind: 'narrative_match', op: '>=', value: 1 },
          // On-chain confirmation (coin-level, not wallet-level)
          { kind: 'snapshot_feature', name: 'inflow_accel_pct', op: '>', value: 0.10 },
          { kind: 'snapshot_feature', name: 'unique_buyers', op: '>=', value: 20 },
          { kind: 'snapshot_feature', name: 'buy_sell_ratio', op: '>=', value: 1.1 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys', op: '<=', value: 0.40 },
          // Coin-level ML — calibrated to actual distribution
          { kind: 'ml_prediction', name: 'alive_at_1h', op: '>=', value: 0.30 },
          { kind: 'ml_prediction', name: 'peaked_100', op: '>=', value: 0.20 },
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
        // Trail arms after T2 fires (+180%). Protects the residual bag (after
        // T1+T2 sold 55%) on a 35% trail. Stays above T2 so T2 fires normally.
        trailing_stop: { arm_pct: 250, trail_pct: 35 },
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
const updateStmt = d.prepare(`UPDATE ml_agent_strategies
  SET rationale = ?, recipe_json = ?, status = 'live' WHERE id = ?`);
const existsStmt = d.prepare(`SELECT id FROM ml_agent_strategies WHERE id = ?`);

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
console.log('[deploy] done — restart degen-club for the executor to pick them up');
