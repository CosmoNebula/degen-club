// 2026-05-16: build the 5x_elite wallet pool.
//
// Defines: elite = wallet bought >=100 distinct coins in last 8d, hit rate
// (>= 5x peak / total buys) >= 25%. Currently ~1,481 wallets — only 8% of
// them overlap with our current tracker/KOL/hunter pools.
//
// Runs as: node scripts/populate-5x-elite.js
// Schedule: every hour via cron.

import { db } from '../src/db/index.js';

const d = db();

d.exec(`
  CREATE TABLE IF NOT EXISTS wallet_5x_score (
    address TEXT PRIMARY KEY,
    coins_bought INTEGER NOT NULL,
    coins_5x INTEGER NOT NULL,
    hit_rate REAL NOT NULL,
    is_elite INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_5x_elite ON wallet_5x_score(is_elite) WHERE is_elite = 1;
`);

console.log('[5x-pool] computing wallet scores from last 8d trades...');
const t0 = Date.now();
const lookbackMs = 8 * 24 * 3600 * 1000;
const cutoff = Date.now() - lookbackMs;

const rows = d.prepare(`
  WITH five_x AS (
    SELECT mint_address FROM mints
    WHERE peak_market_cap_sol >= 140 AND created_at > ?
  )
  SELECT
    t.wallet AS address,
    COUNT(DISTINCT t.mint_address) AS coins_bought,
    COUNT(DISTINCT CASE WHEN f.mint_address IS NOT NULL THEN t.mint_address END) AS coins_5x
  FROM trades t
  LEFT JOIN five_x f ON f.mint_address = t.mint_address
  WHERE t.is_buy = 1 AND t.timestamp > ?
  GROUP BY t.wallet
  HAVING coins_bought >= 30
`).all(cutoff, cutoff);

console.log(`[5x-pool] computed ${rows.length} wallet scores in ${Date.now() - t0}ms`);

d.prepare('DELETE FROM wallet_5x_score').run();

const ELITE_HIT_RATE = 0.25;
const ELITE_MIN_BUYS = 100;
const ins = d.prepare(`INSERT INTO wallet_5x_score (address, coins_bought, coins_5x, hit_rate, is_elite, updated_at)
  VALUES (?,?,?,?,?,?)`);

const now = Date.now();
let nElite = 0;
const tx = d.transaction((rs) => {
  for (const r of rs) {
    const hitRate = r.coins_bought > 0 ? r.coins_5x / r.coins_bought : 0;
    const isElite = (r.coins_bought >= ELITE_MIN_BUYS && hitRate >= ELITE_HIT_RATE) ? 1 : 0;
    if (isElite) nElite++;
    ins.run(r.address, r.coins_bought, r.coins_5x, hitRate, isElite, now);
  }
});
tx(rows);

console.log(`[5x-pool] wrote ${rows.length} rows · ${nElite} flagged elite`);

const overlap = d.prepare(`
  SELECT
    SUM(CASE WHEN w.tracked=1 THEN 1 ELSE 0 END) AS tracked,
    SUM(CASE WHEN w.is_kol=1 THEN 1 ELSE 0 END) AS kol,
    SUM(CASE WHEN w.migrator_score>=0.55 AND w.migrator_pre_mig_buys>=5 THEN 1 ELSE 0 END) AS hunter,
    SUM(CASE WHEN COALESCE(w.tracked,0)=0 AND COALESCE(w.is_kol,0)=0
              AND NOT (w.migrator_score>=0.55 AND w.migrator_pre_mig_buys>=5) THEN 1 ELSE 0 END) AS untagged
  FROM wallet_5x_score s LEFT JOIN wallets w ON w.address=s.address
  WHERE s.is_elite=1
`).get();
console.log(`[5x-pool] elite overlap: tracked=${overlap.tracked} kol=${overlap.kol} hunter=${overlap.hunter} untagged=${overlap.untagged}`);
