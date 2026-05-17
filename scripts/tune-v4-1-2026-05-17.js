// V4.1: drop will_rug gate. Predictions at <60s mint age are noisy and
// hard-failing on missing predictions blocked V4 from firing on the
// fastest entries (the ones we most want — sniper-tier <15s peaks).
// Wallet pool (elite_5x ≥ 1 in 30s) is the real conviction signal;
// hard SL at -60% remains the safety net.
import { db } from '/opt/degen-club/src/db/index.js';
import { deployStrategy } from '/opt/degen-club/src/ml/agent-executor.js';

const d = db();
const ID = 'agent_2026-05-17_elite-aped-v1';

const RECIPE = {
  name: 'elite-aped-v1',
  rationale: '🦍 V4.1 ape-with-elites — will_rug gate dropped. Fires within 30 sec of an elite-5x wallet buying a fresh mint (≤60s old) at low mcap (28-80 SOL). will_rug predictions at <60s mint age were noisy AND hard-failed on missing data, blocking the fastest entries. Wallet pool is the real signal; elites have 25%+ hit rate and avoid rugs reflexively. Hard -60% SL is the safety net. 20% manual moonbag for the unicorn.',
  entry: {
    max_mint_age_sec: 60,
    conditions: [
      { kind: 'wallet_pool', pool: 'elite_5x', op: '>=', value: 1, window_sec: 30 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 28 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '<=', value: 80 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.18 },
  exit: {
    stop_loss_pct: 60,
    breakeven_after_tier1: 0,
    moonbag_pct_reserve: 0.20,
    take_profit_tiers: [
      { trigger_pct: 50,  sell_pct: 25 },
      { trigger_pct: 200, sell_pct: 30 },
      { trigger_pct: 500, sell_pct: 25 },
    ],
    trailing_stop: { arm_pct: 500, trail_pct: 20 },
    max_hold_min: 60,
  },
};

d.prepare(`UPDATE ml_agent_strategies SET recipe_json = ?, rationale = ? WHERE id = ?`)
  .run(JSON.stringify(RECIPE), RECIPE.rationale, ID);
deployStrategy(ID, RECIPE);

console.log(`Updated ${ID}`);
console.log('\n=== entry gates (V4.1) ===');
for (const c of RECIPE.entry.conditions) {
  const tgt = c.name || c.pool || c.kind;
  const extra = c.window_sec ? ` (window ${c.window_sec}s)` : '';
  console.log(`  ${c.kind.padEnd(18)} ${tgt.padEnd(20)} ${c.op} ${c.value}${extra}`);
}
console.log(`  max_mint_age_sec: ${RECIPE.entry.max_mint_age_sec}`);
process.exit(0);
