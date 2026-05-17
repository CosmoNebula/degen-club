// V6: unicorn-mode exits on mega-aped + ultra-aped.
// Existing V5 tier exits sold ~70% of the bag by T3 (+500%), capturing
// ~18x on a 50x runner. For wallets at 70-95% hit rate (ultra) the wimp
// protection isn't needed — we should let it ride to capture the full
// unicorn. Elite stays conservative since super_elite avg hit rate is ~50%.
import { db } from '/opt/degen-club/src/db/index.js';
import { deployStrategy } from '/opt/degen-club/src/ml/agent-executor.js';

const d = db();

function update(id, fn) {
  const row = d.prepare(`SELECT recipe_json FROM ml_agent_strategies WHERE id = ?`).get(id);
  const r = JSON.parse(row.recipe_json);
  fn(r);
  d.prepare(`UPDATE ml_agent_strategies SET recipe_json = ?, rationale = ? WHERE id = ?`)
    .run(JSON.stringify(r), r.rationale, id);
  deployStrategy(id, r);
  console.log(`Updated ${id}`);
}

// mega-aped-v1: looser exits, bigger moonbag
update('agent_2026-05-17_mega-aped-v1', r => {
  r.rationale = '🦍🦍 V6 mega-aped (unicorn mode). T1 +100%/20%, T2 +400%/25%, T3 +1000%/20%. Moonbag 35%. max_hold 180min. mega_elite wallets catch 50x runners regularly — let them prove themselves before locking. Same entry gates as V5: window 60s, mcap 28-120, age ≤6h.';
  r.exit.moonbag_pct_reserve = 0.35;
  r.exit.take_profit_tiers = [
    { trigger_pct: 100,  sell_pct: 20 },
    { trigger_pct: 400,  sell_pct: 25 },
    { trigger_pct: 1000, sell_pct: 20 },
  ];
  r.exit.trailing_stop = { arm_pct: 1000, trail_pct: 25 };
  r.exit.max_hold_min = 180;
});

// ultra-aped-v1: maximum unicorn mode — half the bag rides forever
update('agent_2026-05-17_ultra-aped-v1', r => {
  r.rationale = '🦍🦍🦍 V6 ultra-aped (FULL unicorn mode). T1 +200%/15%, T2 +1000%/20%, T3 +5000%/15%. Moonbag 50% — half the bag rides untouched. Loose 30% trail after T3 arm. max_hold 6h. Ultra wallets at 70-94% hit rate; wimp protection unnecessary. On a 50x runner: ~30-40x capture (vs 18x in V5). On a 100x: 50x+ capture. Same entry: window 120s, mcap 28-200, age ≤6h.';
  r.exit.moonbag_pct_reserve = 0.50;
  r.exit.take_profit_tiers = [
    { trigger_pct: 200,  sell_pct: 15 },
    { trigger_pct: 1000, sell_pct: 20 },
    { trigger_pct: 5000, sell_pct: 15 },
  ];
  r.exit.trailing_stop = { arm_pct: 5000, trail_pct: 30 };
  r.exit.max_hold_min = 360;
});

// Verify
console.log('\n=== V6 exit ladders ===');
for (const id of ['agent_2026-05-17_elite-aped-v1','agent_2026-05-17_mega-aped-v1','agent_2026-05-17_ultra-aped-v1']) {
  const r = JSON.parse(d.prepare('SELECT recipe_json FROM ml_agent_strategies WHERE id=?').get(id).recipe_json);
  const t = r.exit.take_profit_tiers;
  console.log(`\n${id}:`);
  console.log(`  T1: +${t[0].trigger_pct}% sell ${t[0].sell_pct}%`);
  console.log(`  T2: +${t[1].trigger_pct}% sell ${t[1].sell_pct}%`);
  console.log(`  T3: +${t[2].trigger_pct}% sell ${t[2].sell_pct}%`);
  console.log(`  Trail: arm +${r.exit.trailing_stop.arm_pct}%, ${r.exit.trailing_stop.trail_pct}% retrace`);
  console.log(`  Moonbag: ${Math.round((r.exit.moonbag_pct_reserve||0)*100)}%`);
  console.log(`  max_hold: ${r.exit.max_hold_min}min`);
}
process.exit(0);
