// V7 deploy — single strategy, single trail.
//
// Findings from 306-entry exit backtest (synthesized from 12h of super_elite
// buys at 28-80 SOL mcap):
//
//   PERFECT (knowing peak)           +63.0 SOL  / +21.1% avg / 92.6% win  (benchmark)
//   adaptive_tight_v3                 +1.4 SOL  /  +0.5% avg / 59.5% win  (BEST — requires new code)
//   BASE_smart_trail_20arm            +0.8 SOL  /  +0.3% avg / 51.7% win  (USING THIS — works in existing code)
//   V6_elite (current)                -1.1 SOL  /  -0.4% avg / 15.0% win
//   V6_mega                           -5.5 SOL  /  -1.8% avg /  8.3% win
//   V6_ultra                          -7.0 SOL  /  -2.3% avg /  6.3% win
//
// V6 tier ladders (T1 +100%/+200%) are too high — median mint peaks at +22%.
// Single-trail at +20% arm / 15% retrace captures the modest pumpers + cuts
// losers fast. Tested 51.7% win rate vs current 15%.
//
// Switching to ONE strategy (not three) because they'd all use the same exit
// and the wallet pool tiers nest (ultra ⊂ mega ⊂ super_elite). Three
// identical-exit strategies just triple exposure per ultra-wallet signal
// with no behavioral diversity. Sizing 0.22 SOL = middle ground between
// V6 elite (0.18) and mega (0.22).

import { db } from '/opt/degen-club/src/db/index.js';
import { deployStrategy, retireStrategy } from '/opt/degen-club/src/ml/agent-executor.js';

const d = db();
const NOW = Date.now();

// 1. Retire the 3 V6 strategies (they're already paused)
const v6 = ['agent_2026-05-17_elite-aped-v1','agent_2026-05-17_mega-aped-v1','agent_2026-05-17_ultra-aped-v1'];
for (const id of v6) {
  retireStrategy(id, 'V7 consolidation — replaced by single aped-v7 with backtest-tuned single-trail exit');
  console.log(`retired ${id}`);
}

// 2. Deploy V7
const ID = 'agent_2026-05-17_aped-v7';
const RECIPE = {
  name: 'aped-v7',
  rationale: '🦍 V7 single strategy. Triggers on any super_elite_5x wallet buy at 28-100 SOL mcap. Backtest-tuned exit: single trail armed at +20% peak, 15% retrace, -40% hard SL, 45min max_hold. NO tiers (median mint peaks +22%, tier ladders waste opportunity). NO moonbag. ONE strategy = one entry per mint (V6 had 3 strategies stacking on ultra-wallet signals). Backtest: +0.77 SOL on 306 sim trades, 52% win rate (vs V6 elite -1.1 / 15%, V6 ultra -7.0 / 6%).',
  entry: {
    max_mint_age_sec: 21600,
    conditions: [
      { kind: 'wallet_pool', pool: 'super_elite_5x', op: '>=', value: 1, window_sec: 60 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 28 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '<=', value: 100 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.22 },
  exit: {
    stop_loss_pct: 40,
    breakeven_after_tier1: 0,
    moonbag_pct_reserve: 0,
    // T1/T2 explicitly disabled with unreachable triggers. T3 = the single
    // trail armer at +20%. trailing_stop carries the trail params.
    take_profit_tiers: [
      { trigger_pct: 99999, sell_pct: 0 },
      { trigger_pct: 99999, sell_pct: 0 },
      { trigger_pct: 20, sell_pct: 100 },
    ],
    trailing_stop: { arm_pct: 20, trail_pct: 15 },
    max_hold_min: 45,
  },
};

const exists = d.prepare(`SELECT id FROM ml_agent_strategies WHERE id = ?`).get(ID);
if (exists) {
  d.prepare(`UPDATE ml_agent_strategies SET recipe_json = ?, rationale = ?, status='live' WHERE id = ?`)
    .run(JSON.stringify(RECIPE), RECIPE.rationale, ID);
} else {
  d.prepare(`INSERT INTO ml_agent_strategies
    (id, name, rationale, recipe_json, status, created_at, generation)
    VALUES (?, ?, ?, ?, 'live', ?, 1)`)
    .run(ID, RECIPE.name, RECIPE.rationale, JSON.stringify(RECIPE), NOW);
}
deployStrategy(ID, RECIPE);
console.log(`\nDeployed ${ID}`);

// 3. Wipe paper state for clean V7 test
const posDel = d.prepare('DELETE FROM paper_positions').run().changes;
const rejDel = d.prepare('DELETE FROM strategy_entry_rejections').run().changes;
d.prepare(`UPDATE paper_wallet SET starting_balance_sol = 10.0, started_at = ?,
  reset_count = reset_count + 1, peak_total_value = 0, peak_at = NULL WHERE id = 1`).run(NOW);
d.prepare(`UPDATE ml_agent_strategies SET n_trades = 0, n_wins = 0, n_losses = 0,
  realized_pnl_sol = 0, best_trade_pct = 0, worst_trade_pct = 0 WHERE status = 'live'`).run();

console.log(`\nwipe: ${posDel} positions, ${rejDel} rejections, wallet reset to 10 SOL`);

console.log('\n=== live strategies ===');
const live = d.prepare(`SELECT id FROM ml_agent_strategies WHERE status='live' ORDER BY id`).all();
for (const r of live) console.log(`  ${r.id}`);

console.log('\n=== V7 entry gates + exits ===');
const v = d.prepare(`SELECT json_extract(recipe_json,'$.entry.conditions') AS c FROM ml_agent_strategies WHERE id=?`).get(ID);
const conds = JSON.parse(v.c);
console.log('ENTRY:');
for (const c of conds) {
  const tgt = c.name || c.pool || c.kind;
  const extra = c.window_sec ? ` (window ${c.window_sec}s)` : '';
  console.log(`  ${c.kind.padEnd(18)} ${tgt.padEnd(20)} ${c.op} ${c.value}${extra}`);
}
const ss = d.prepare(`SELECT sl_pct, tier1_trigger_pct, tier1_sell_pct, tier2_trigger_pct, tier2_sell_pct, tier3_trigger_pct, tier3_sell_pct, tier3_trail_pct, max_hold_min, dca_enabled, moonbag_pct_reserve FROM strategy_state WHERE name=?`).get(ID);
console.log('EXIT (strategy_state):');
console.log(`  SL:           ${(ss.sl_pct*100).toFixed(0)}%`);
console.log(`  T1:           ${ss.tier1_trigger_pct*100}% (DISABLED — unreachable)`);
console.log(`  T2:           ${ss.tier2_trigger_pct*100}% (DISABLED — unreachable)`);
console.log(`  T3 (trail):   arm at ${ss.tier3_trigger_pct*100}%, retrace ${ss.tier3_trail_pct*100}%, sell ${ss.tier3_sell_pct*100}%`);
console.log(`  max_hold:     ${ss.max_hold_min} min`);
console.log(`  moonbag:      ${ss.moonbag_pct_reserve*100}%`);
console.log(`  DCA:          ${ss.dca_enabled ? 'ON' : 'OFF'}`);
process.exit(0);
