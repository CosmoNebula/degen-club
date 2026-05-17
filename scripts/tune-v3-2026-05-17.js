// V3 tune — based on 11-hour V2 audit findings:
//
// 1. Add last_mcap_sol >= 80 floor to all strategies → kills the <80 SOL
//    "dead-zone" entries that systematically dump (13 of 16 open stack-v2
//    losers are in that bucket).
// 2. Loosen will_rug 0.05 → 0.10 → would have caught the 66x missed runner
//    (4J3PB871SaH2 had will_rug=0.0545, barely over old threshold).
// 3. Disable DCA on stack-v2 → 1-DCA closed avg -55% vs 0-DCA -17%. DCA is
//    amplifying losses on dying coins, not saving them.
// 4. Loosen ml-momentum + post-mig so they actually fire entries.
import { db } from '/opt/degen-club/src/db/index.js';
import { deployStrategy } from '/opt/degen-club/src/ml/agent-executor.js';

const d = db();
const NOW = Date.now();

const ELITE_STACK = {
  name: 'elite-stack-v2',
  rationale: '🐋 V3 (2026-05-17 audit): elite-wallet alpha + ML safety + mcap floor. Adds last_mcap_sol >= 80 to skip the dead-zone (<80 SOL entries averaged -38% PnL with peak 21% — never moved). Loosens will_rug 0.05 → 0.10 (calibrated at 3.4% base rate, 0.10 = 3× elevated — would have caught the 66x missed runner). DCA disabled (1-DCA closes averaged -55% vs 0-DCA -17%, amplifying losses on dying coins). Rest unchanged: T1 30%@+40%, T2 40%@+200%, T3 25%@+500% trail, 5% manual moonbag, no breakeven-after-T1, max_hold 4h.',
  entry: {
    max_mint_age_sec: 600,
    conditions: [
      { kind: 'wallet_pool', pool: 'elite_5x', op: '>=', value: 1, window_sec: 600 },
      { kind: 'ml_prediction', name: 'will_rug',     op: '<',  value: 0.10 },
      { kind: 'ml_prediction', name: 'will_migrate', op: '>=', value: 0.05 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 80 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.18 },
  dca: { enabled: false },
  exit: {
    stop_loss_pct: 60,
    breakeven_after_tier1: 0,
    moonbag_pct_reserve: 0.05,
    take_profit_tiers: [
      { trigger_pct: 40,  sell_pct: 30 },
      { trigger_pct: 200, sell_pct: 40 },
      { trigger_pct: 500, sell_pct: 25 },
    ],
    trailing_stop: { arm_pct: 500, trail_pct: 25 },
    max_hold_min: 240,
  },
};

const ELITE_QUICK_35 = {
  name: 'elite-quick-35-v1',
  rationale: '🧪 V3 quick scalper — best-performing strat by win rate (50%). Same entry gates as elite-stack-v2 plus 80-SOL mcap floor. Loosens will_rug to 0.10 (caught winning regime). +35% sell-100% with no tiers/trail/moonbag. Locked 0.25 SOL entry.',
  entry: {
    max_mint_age_sec: 600,
    conditions: [
      { kind: 'wallet_pool', pool: 'elite_5x', op: '>=', value: 1, window_sec: 600 },
      { kind: 'ml_prediction', name: 'will_rug',     op: '<',  value: 0.10 },
      { kind: 'ml_prediction', name: 'will_migrate', op: '>=', value: 0.05 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 80 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.25 },
  exit: {
    stop_loss_pct: 60,
    breakeven_after_tier1: 0,
    moonbag_pct_reserve: 0,
    take_profit_tiers: [
      { trigger_pct: 35, sell_pct: 100 },
    ],
    max_hold_min: 60,
  },
};

const PRE_MIG = {
  name: 'pre-mig-conviction-v1',
  rationale: '🎯 V3 pure-ML pre-migration — 4 model stack. Adds 80-SOL mcap floor. Loosens will_rug 0.03 → 0.08 (was too tight). Stack: will_migrate ≥ 0.08, will_rug < 0.08, buy_pressure ≥ 0.5, hits_2x ≥ 0.20.',
  entry: {
    min_mint_age_sec: 30,
    max_mint_age_sec: 180,
    conditions: [
      { kind: 'ml_prediction', name: 'will_migrate', op: '>=', value: 0.08 },
      { kind: 'ml_prediction', name: 'will_rug', op: '<', value: 0.08 },
      { kind: 'ml_prediction', name: 'buy_pressure_continues_60s', op: '>=', value: 0.5 },
      { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.20 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 80 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.30 },
  exit: {
    stop_loss_pct: 55,
    breakeven_after_tier1: 0,
    moonbag_pct_reserve: 0.05,
    take_profit_tiers: [
      { trigger_pct: 50, sell_pct: 30 },
      { trigger_pct: 150, sell_pct: 30 },
      { trigger_pct: 400, sell_pct: 35 },
    ],
    trailing_stop: { arm_pct: 400, trail_pct: 20 },
    max_hold_min: 60,
  },
};

const ML_MOMENTUM = {
  name: 'ml-momentum-v1',
  rationale: '⚡ V3 quick 2x momentum scalper — loosened to actually fire. Catches mints with 2x momentum signal (hits_2x ≥ 0.20, was 0.30) NOT graduating (will_migrate < 0.08, was 0.05). Adds 80-SOL mcap floor. Tight exits, no moonbag.',
  entry: {
    max_mint_age_sec: 300,
    conditions: [
      { kind: 'ml_prediction', name: 'will_rug', op: '<', value: 0.10 },
      { kind: 'ml_prediction', name: 'hits_2x_within_1h', op: '>=', value: 0.20 },
      { kind: 'ml_prediction', name: 'buy_pressure_continues_60s', op: '>=', value: 0.5 },
      { kind: 'ml_prediction', name: 'will_migrate', op: '<', value: 0.08 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 80 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.20 },
  exit: {
    stop_loss_pct: 45,
    breakeven_after_tier1: 0,
    moonbag_pct_reserve: 0,
    take_profit_tiers: [
      { trigger_pct: 50, sell_pct: 50 },
      { trigger_pct: 150, sell_pct: 50 },
    ],
    trailing_stop: { arm_pct: 30, trail_pct: 15 },
    max_hold_min: 25,
  },
};

const POST_MIG = {
  name: 'post-mig-runner-v1',
  rationale: '🚀 V3 post-migration AMM runner — loosened to actually fire. Loosens post_mig_hits_2x 0.25 → 0.15 (data shows 14-66x post-mig runners had post_mig_hits_2x in 0.15-0.25 range). Requires mint_state.migrated=1, not rugged, and 100 SOL mcap floor (post-mig mints typically already past this).',
  entry: {
    conditions: [
      { kind: 'mint_state', name: 'migrated', op: '=', value: 1 },
      { kind: 'mint_state', name: 'rugged', op: '=', value: 0 },
      { kind: 'ml_prediction', name: 'post_mig_hits_2x', op: '>=', value: 0.15 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 100 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.25 },
  exit: {
    stop_loss_pct: 50,
    breakeven_after_tier1: 0,
    moonbag_pct_reserve: 0.05,
    take_profit_tiers: [
      { trigger_pct: 100, sell_pct: 60 },
      { trigger_pct: 200, sell_pct: 35 },
    ],
    trailing_stop: { arm_pct: 80, trail_pct: 20 },
    max_hold_min: 240,
  },
};

const RECIPES = [
  ['agent_2026-05-17_elite-stack-v2', ELITE_STACK],
  ['agent_2026-05-17_elite-quick-35-v1', ELITE_QUICK_35],
  ['agent_2026-05-17_pre-mig-conviction-v1', PRE_MIG],
  ['agent_2026-05-17_ml-momentum-v1', ML_MOMENTUM],
  ['agent_2026-05-17_post-mig-runner-v1', POST_MIG],
];

for (const [id, recipe] of RECIPES) {
  d.prepare(`UPDATE ml_agent_strategies SET recipe_json = ?, rationale = ? WHERE id = ?`)
    .run(JSON.stringify(recipe), recipe.rationale, id);
  deployStrategy(id, recipe);
  console.log(`Deployed ${id}`);
}

console.log('\n=== verify gates ===');
const live = d.prepare(`SELECT id, json_extract(recipe_json, '$.entry.conditions') AS conds FROM ml_agent_strategies WHERE status='live' ORDER BY id`).all();
for (const r of live) {
  console.log(`\n${r.id}:`);
  const conds = JSON.parse(r.conds);
  for (const c of conds) {
    const target = c.name || c.pool || c.kind;
    console.log(`  ${c.kind.padEnd(18)} ${target.padEnd(28)} ${c.op} ${c.value}`);
  }
}
process.exit(0);
