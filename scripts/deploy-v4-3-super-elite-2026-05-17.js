// V4.3: switch wallet trigger from elite_5x → super_elite_5x.
// Also: backfill is_super_elite NOW (worker only re-scores every 6h);
// update V4 recipe; wipe paper state.
import { db } from '/opt/degen-club/src/db/index.js';
import { deployStrategy } from '/opt/degen-club/src/ml/agent-executor.js';

const d = db();
const NOW = Date.now();

// 1. Backfill is_super_elite on existing rows (worker will overwrite at next 6h tick)
const updated = d.prepare(`UPDATE wallet_5x_score
  SET is_super_elite = CASE
    WHEN is_elite = 1 AND coins_5x >= 100 AND hit_rate >= 0.35 THEN 1
    ELSE 0
  END`).run().changes;
const counts = d.prepare(`SELECT
  SUM(is_elite) AS elite,
  SUM(is_super_elite) AS super_elite
  FROM wallet_5x_score`).get();
console.log(`is_super_elite backfilled: ${updated} rows · elite=${counts.elite} · super_elite=${counts.super_elite}`);

// 2. Update V4 recipe
const ID = 'agent_2026-05-17_elite-aped-v1';
const row = d.prepare('SELECT recipe_json FROM ml_agent_strategies WHERE id = ?').get(ID);
const recipe = JSON.parse(row.recipe_json);
recipe.entry.conditions = recipe.entry.conditions.map(c => {
  if (c.kind === 'wallet_pool' && c.pool === 'elite_5x') {
    return { ...c, pool: 'super_elite_5x' };
  }
  return c;
});
recipe.rationale = '🦍 V4.3 ape-with-SUPER-elites. Switched from elite_5x (1,720 wallets, includes 25-30% hit rate long tail) to super_elite_5x (~229 wallets, ≥35% hit rate AND ≥100 coins_5x). V4.2 data showed deep losers were triggered by 25-29% wallets while winners had 31-35%+ wallets buying within seconds. Same other gates: max_age 240s, mcap 28-80 SOL, window 30s.';
d.prepare('UPDATE ml_agent_strategies SET recipe_json = ?, rationale = ? WHERE id = ?')
  .run(JSON.stringify(recipe), recipe.rationale, ID);
deployStrategy(ID, recipe);
console.log(`Recipe updated to use super_elite_5x`);

// 3. Wipe paper state
const posDel = d.prepare('DELETE FROM paper_positions').run().changes;
const rejDel = d.prepare('DELETE FROM strategy_entry_rejections').run().changes;
d.prepare(`UPDATE paper_wallet SET starting_balance_sol = 10.0, started_at = ?,
  reset_count = reset_count + 1, peak_total_value = 0, peak_at = NULL WHERE id = 1`).run(NOW);
d.prepare(`UPDATE ml_agent_strategies SET n_trades = 0, n_wins = 0, n_losses = 0,
  realized_pnl_sol = 0, best_trade_pct = 0, worst_trade_pct = 0 WHERE status = 'live'`).run();

console.log(JSON.stringify({
  paper_positions_deleted: posDel,
  rejections_deleted: rejDel,
  wallet_reset_to_sol: 10.0,
}, null, 2));

console.log('\n=== verify ===');
const v = d.prepare(`SELECT json_extract(recipe_json,'$.entry.conditions') AS c FROM ml_agent_strategies WHERE id=?`).get(ID);
const conds = JSON.parse(v.c);
console.log('V4.3 entry gates:');
for (const c of conds) {
  const tgt = c.name || c.pool || c.kind;
  const extra = c.window_sec ? ` (window ${c.window_sec}s)` : '';
  console.log(`  ${c.kind.padEnd(18)} ${tgt.padEnd(20)} ${c.op} ${c.value}${extra}`);
}
process.exit(0);
