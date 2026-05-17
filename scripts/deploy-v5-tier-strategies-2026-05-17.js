// V5: Add mega_elite + ultra_elite tier flags + 2 new strategies.
//
// Tier hierarchy (subsetting):
//   elite       ≥100 buys, ≥25% hit_rate            (~1,720 wallets)
//   super_elite + ≥100 coins_5x, ≥35% hit_rate     (~229 wallets)
//   mega_elite  + ≥30 coins_50x, ≥45% hit_rate     (target ~50-100)
//   ultra_elite + ≥50 coins_50x, ≥55% hit_rate     (target ~20-40)
//
// Looser-gates philosophy: stronger wallet signal = we trust them at
// later mcap, longer windows, older mints. Bigger size too.

import { db } from '/opt/degen-club/src/db/index.js';
import { deployStrategy } from '/opt/degen-club/src/ml/agent-executor.js';

const d = db();
const NOW = Date.now();

// 1. Add columns if missing (worker's ensureTable would do this on its next
//    boot too, but we want them NOW for the backfill).
try { d.exec(`ALTER TABLE wallet_5x_score ADD COLUMN is_mega_elite INTEGER DEFAULT 0`); } catch {}
try { d.exec(`ALTER TABLE wallet_5x_score ADD COLUMN is_ultra_elite INTEGER DEFAULT 0`); } catch {}

// 2. Backfill tier flags using already-computed coins_50x + hit_rate.
const updated = d.prepare(`UPDATE wallet_5x_score SET
  is_mega_elite  = CASE WHEN is_super_elite = 1 AND coins_50x >= 30 AND hit_rate >= 0.45 THEN 1 ELSE 0 END,
  is_ultra_elite = CASE WHEN is_super_elite = 1 AND coins_50x >= 50 AND hit_rate >= 0.55 THEN 1 ELSE 0 END
`).run().changes;

const counts = d.prepare(`SELECT
  SUM(is_elite)        AS elite,
  SUM(is_super_elite)  AS super_elite,
  SUM(is_mega_elite)   AS mega_elite,
  SUM(is_ultra_elite)  AS ultra_elite
  FROM wallet_5x_score`).get();
console.log(`Backfilled ${updated} rows. Tier counts:`);
console.log(`  elite       = ${counts.elite}`);
console.log(`  super_elite = ${counts.super_elite}`);
console.log(`  mega_elite  = ${counts.mega_elite}`);
console.log(`  ultra_elite = ${counts.ultra_elite}`);

// 3. mega-aped-v1 — looser gates, bigger size
const MEGA = {
  name: 'mega-aped-v1',
  rationale: '🦍🦍 V5 mega-aped. Fires when a MEGA_ELITE wallet (≥30 50x catches, ≥45% hit rate — top ~50-100 wallets) buys. Looser gates than super-aped because the wallet signal is stronger: mcap range 28-120 (was 28-80), window 60s (was 30s), max_age 360s (was 240). Sizing 0.22 SOL (was 0.18). 25% manual moonbag (was 20%) — these wallets catch 50x runners regularly, want bigger bag for the unicorn.',
  entry: {
    max_mint_age_sec: 360,
    conditions: [
      { kind: 'wallet_pool', pool: 'mega_elite_5x', op: '>=', value: 1, window_sec: 60 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 28 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '<=', value: 120 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.22 },
  exit: {
    stop_loss_pct: 60,
    breakeven_after_tier1: 0,
    moonbag_pct_reserve: 0.25,
    take_profit_tiers: [
      { trigger_pct: 50,  sell_pct: 25 },
      { trigger_pct: 200, sell_pct: 25 },
      { trigger_pct: 500, sell_pct: 25 },
    ],
    trailing_stop: { arm_pct: 500, trail_pct: 20 },
    max_hold_min: 90,
  },
};

// 4. ultra-aped-v1 — loosest gates, biggest size
const ULTRA = {
  name: 'ultra-aped-v1',
  rationale: '🦍🦍🦍 V5 ultra-aped. Fires when an ULTRA_ELITE wallet (≥50 50x catches, ≥55% hit rate — the top ~20-40 wallets, the unicorn hunters) buys. Loosest gates: mcap 28-200 (accept significant pre-buy pump), window 120s (was 30), max_age 600s. Sizing 0.30 SOL — biggest conviction. 30% manual moonbag — these wallets are literally the people catching 1000x+ runners, leaving 30% to ride for the moonshot.',
  entry: {
    max_mint_age_sec: 600,
    conditions: [
      { kind: 'wallet_pool', pool: 'ultra_elite_5x', op: '>=', value: 1, window_sec: 120 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '>=', value: 28 },
      { kind: 'snapshot_feature', name: 'last_mcap_sol', op: '<=', value: 200 },
    ],
  },
  sizing: { type: 'fixed', sol: 0.30 },
  exit: {
    stop_loss_pct: 60,
    breakeven_after_tier1: 0,
    moonbag_pct_reserve: 0.30,
    take_profit_tiers: [
      { trigger_pct: 50,  sell_pct: 20 },
      { trigger_pct: 200, sell_pct: 25 },
      { trigger_pct: 500, sell_pct: 25 },
    ],
    trailing_stop: { arm_pct: 500, trail_pct: 20 },
    max_hold_min: 120,
  },
};

function deploy(id, recipe) {
  const exists = d.prepare(`SELECT id FROM ml_agent_strategies WHERE id = ?`).get(id);
  if (exists) {
    d.prepare(`UPDATE ml_agent_strategies SET recipe_json = ?, rationale = ?, status='live' WHERE id = ?`)
      .run(JSON.stringify(recipe), recipe.rationale, id);
  } else {
    d.prepare(`INSERT INTO ml_agent_strategies
      (id, name, rationale, recipe_json, status, created_at, generation)
      VALUES (?, ?, ?, ?, 'live', ?, 1)`)
      .run(id, recipe.name, recipe.rationale, JSON.stringify(recipe), NOW);
  }
  deployStrategy(id, recipe);
}

deploy('agent_2026-05-17_mega-aped-v1', MEGA);
deploy('agent_2026-05-17_ultra-aped-v1', ULTRA);
console.log('\nDeployed mega-aped-v1 + ultra-aped-v1');

// 5. Show live strategies + gate summary
console.log('\n=== live strategies ===');
const live = d.prepare(`SELECT id FROM ml_agent_strategies WHERE status='live' ORDER BY id`).all();
for (const r of live) console.log(`  ${r.id}`);

console.log('\n=== gate summary ===');
console.log('strategy              pool             win_sec  max_age  mcap_max  size   moonbag');
console.log('elite-aped-v1         super_elite_5x    30s     240s     80        0.18   20%');
console.log('mega-aped-v1          mega_elite_5x     60s     360s     120       0.22   25%');
console.log('ultra-aped-v1         ultra_elite_5x   120s     600s     200       0.30   30%');

process.exit(0);
