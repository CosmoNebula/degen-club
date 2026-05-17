// V4: single strategy "elite-aped-v1" — follow alpha within 30s, not after.
//
// Audit findings driving the design (5 days cliff-notes + V3 paper trades):
// - 3,892 5x+ runners across 5 days; we caught ~4. Volume is there.
// - 65% of 5x runners peak in <5 minutes (33% in <1 min).
// - Our elite pool DOES contain real alpha (omegoMAe 50% hit rate,
//   DbEh3Yah 48%, SQHK48 40%, etc.).
// - V2/V3 strategies entered 5-10 minutes AFTER elite buys → late chase
//   into post-pump dumps. mcap 80-150 was the death zone.
// - Winners (avg entry mcap 150 SOL) outperformed losers (avg 122)
//   because they were rarer cases of "elite bought + price kept running."
//
// V4 design: instead of following elites with a 600s window (current V3),
// fire entries within 30s of an elite buy, REQUIRE the mcap to still be
// in the early-stage range (<80 SOL), and require fresh mint (<60s old).
// This puts us at roughly the same entry point as the alpha, not after.
//
// Big moonbag (20%) because 50x+ runners exist and a held bag carries
// the strategy. The other 5 V3 strats are retired (status='retired').
import { db } from '/opt/degen-club/src/db/index.js';
import { deployStrategy, retireStrategy } from '/opt/degen-club/src/ml/agent-executor.js';

const d = db();
const NOW = Date.now();

// 1. Retire all 5 V3 strategies (they're already paused — formalize the retirement)
const v3 = d.prepare(`SELECT id FROM ml_agent_strategies WHERE id LIKE 'agent_2026-05-17%' AND status IN ('live','paused')`).all();
for (const r of v3) {
  retireStrategy(r.id, 'V4 architectural reset — late-chase pattern, replaced by single elite-aped-v1');
  console.log(`retired ${r.id}`);
}

// 2. Deploy V4 strategy
const ID = 'agent_2026-05-17_elite-aped-v1';
const RECIPE = {
  name: 'elite-aped-v1',
  rationale: '🦍 V4 ape-with-elites. Fires within 30 seconds of an elite-5x wallet buying a fresh mint (≤60s old) at low mcap (28-80 SOL — pre-pump zone). Audit showed V2/V3 strategies bled because the 600s window meant we entered 5-10 min after the elite, at mcap 100-150, after the pump. V4 enters at the SAME PRICE as the alpha. Loose rug filter (will_rug < 0.15) because predictions at <60s mint age are noisy. 20% manual moonbag — 5x+ runners peak in <5 min on average; even a small held bag through one 50x makes the strategy.',
  entry: {
    max_mint_age_sec: 60,
    conditions: [
      { kind: 'wallet_pool', pool: 'elite_5x', op: '>=', value: 1, window_sec: 30 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 28 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '<=', value: 80 },
      { kind: 'ml_prediction', name: 'will_rug', op: '<', value: 0.15 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.18 },
  exit: {
    stop_loss_pct: 60,           // wide enough for pump.fun wicks
    breakeven_after_tier1: 0,    // NO breakeven trap — runners need room
    moonbag_pct_reserve: 0.20,   // bigger manual bag for unicorns
    take_profit_tiers: [
      { trigger_pct: 50,  sell_pct: 25 },   // small de-risk early
      { trigger_pct: 200, sell_pct: 30 },   // chunky lock at 3x
      { trigger_pct: 500, sell_pct: 25 },   // catch the 5x runner; 20% rides
    ],
    trailing_stop: { arm_pct: 500, trail_pct: 20 },
    max_hold_min: 60,            // short hold — runners peak fast or die
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

// 3. Verify state
console.log('\n=== live strategies ===');
const live = d.prepare(`SELECT id FROM ml_agent_strategies WHERE status='live' ORDER BY id`).all();
for (const r of live) console.log(`  ${r.id}`);
console.log('\n=== entry gates on V4 ===');
const conds = JSON.parse(d.prepare(`SELECT json_extract(recipe_json,'$.entry.conditions') AS c FROM ml_agent_strategies WHERE id=?`).get(ID).c);
for (const c of conds) {
  const tgt = c.name || c.pool || c.kind;
  const extra = c.window_sec ? ` (window ${c.window_sec}s)` : '';
  console.log(`  ${c.kind.padEnd(18)} ${tgt.padEnd(20)} ${c.op} ${c.value}${extra}`);
}
process.exit(0);
