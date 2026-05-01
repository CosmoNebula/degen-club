#!/usr/bin/env node
// Backfill per-wallet migrator stats from full trade history,
// then print the current top migrator-hunters leaderboard.
import { backfillMigratorStats, topMigratorHunters } from '../src/scoring/migrator-stats.js';

const args = new Set(process.argv.slice(2));
const limit = Number(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || 30);

const res = backfillMigratorStats({ verbose: true });
console.log(JSON.stringify(res));

if (!args.has('--no-leaderboard')) {
  const rows = topMigratorHunters({ limit });
  console.log(`\nTop ${rows.length} migrator hunters (min 3 pre-mig buys, realized >= 0):`);
  for (const r of rows) {
    const flag = r.is_kol ? ' [KOL]' : (r.auto_blocked ? ' [BLOCKED]' : '');
    console.log(
      `  ${r.address.slice(0, 6)}…${r.address.slice(-4)}${flag}  ` +
      `score=${r.score.toFixed(3)}  pre_mig=${r.migrator_pre_mig_buys}  ` +
      `entry%=${(r.avg_entry_pct * 100).toFixed(1)}%  realized=${r.realized_sol.toFixed(2)}SOL  ` +
      `cat=${r.category}${r.label ? ` (${r.label})` : ''}`
    );
  }
}

process.exit(0);
