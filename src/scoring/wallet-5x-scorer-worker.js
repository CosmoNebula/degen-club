// 2026-05-16: Wallet 5x-elite scorer worker.
//
// Periodically recomputes the wallet_5x_score table — wallets ranked by their
// hit rate on 5x runners (peak_market_cap_sol >= 140) in last 8 days. Elite
// wallets feed the `elite-5x-buy-XXXXXX` trigger in processor.js.
//
// The scoring query touches all trades + mints from the lookback window
// (~80s wall time on a 2-3 GB DB), so it runs in a worker thread to avoid
// blocking trade ingestion. Single-flight: a new tick is skipped if the
// previous run is still in flight.

import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db } from '../db/index.js';

const LOOKBACK_MS = 8 * 24 * 3600 * 1000;
const FIVE_X_THRESHOLD_SOL = 140;
const TEN_X_THRESHOLD_SOL = 280;     // 10x from ~28 SOL initial mcap
const FIFTY_X_THRESHOLD_SOL = 1400;  // 50x — moonshot territory
const ELITE_MIN_BUYS = 100;
const ELITE_MIN_HIT_RATE = 0.25;
// 2026-05-17 PM: super_elite tier. The base elite pool (≥100 buys, ≥25%
// hit rate) has a long tail of barely-elite wallets close to random.
// V4 paper trades showed deep losers were triggered by 25-29% hit rate
// wallets while winners had 31-35%+ wallets buying within seconds.
// Super tier requires precision (35%+ hit rate) AND volume (100+ 5x
// catches across 8d) — separates real alpha from spray-and-pray.
const SUPER_ELITE_MIN_5X = 100;
const SUPER_ELITE_MIN_HIT_RATE = 0.35;
// mega_elite: 50x specialists. Must catch 30+ 50x runners (avg super_elite
// only catches 18) AND hit 45%+ on their picks.
const MEGA_ELITE_MIN_50X = 30;
const MEGA_ELITE_MIN_HIT_RATE = 0.45;
// ultra_elite: the unicorn hunters. 50+ 50x catches AND 55%+ hit rate.
// Pool will be tiny (~20-40 wallets), but these are the wallets where
// every signal is worth aping.
const ULTRA_ELITE_MIN_50X = 50;
const ULTRA_ELITE_MIN_HIT_RATE = 0.55;

// 2026-05-16 (PM): bumped 1h → 6h cadence after Node hit 7.2GB peak + OOM
// during a concurrent retrain. The 80s aggregation query loads tons of trades
// into Node's heap; running it during the retrain's extract phase doubled
// memory pressure. Elite list barely changes hour-to-hour (wallets earn
// the badge over many days of trades), so 6h is plenty fresh.
const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;
// First run 15 min after boot — let onchain-price, snapshot-sweeper, traders,
// AND any in-flight retrain settle their startup pass before we hold a big read.
const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;

function ensureTable(d) {
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
  // is_super_elite column added 2026-05-17 PM. ensureCol-style — won't fail
  // if already present.
  try { d.exec(`ALTER TABLE wallet_5x_score ADD COLUMN is_super_elite INTEGER DEFAULT 0`); } catch {}
  try { d.exec(`CREATE INDEX IF NOT EXISTS idx_5x_super_elite ON wallet_5x_score(is_super_elite) WHERE is_super_elite = 1`); } catch {}
  // 2026-05-17 PM: 10x and 50x catch counts. Wallets with 100 5x hits but
  // zero 10x hits are different beasts from wallets who consistently catch
  // the bigger runners. Lets us define an ultra-precise tier later.
  try { d.exec(`ALTER TABLE wallet_5x_score ADD COLUMN coins_10x INTEGER DEFAULT 0`); } catch {}
  try { d.exec(`ALTER TABLE wallet_5x_score ADD COLUMN coins_50x INTEGER DEFAULT 0`); } catch {}
  try { d.exec(`ALTER TABLE wallet_5x_score ADD COLUMN is_mega_elite INTEGER DEFAULT 0`); } catch {}
  try { d.exec(`ALTER TABLE wallet_5x_score ADD COLUMN is_ultra_elite INTEGER DEFAULT 0`); } catch {}
  try { d.exec(`CREATE INDEX IF NOT EXISTS idx_5x_mega_elite ON wallet_5x_score(is_mega_elite) WHERE is_mega_elite = 1`); } catch {}
  try { d.exec(`CREATE INDEX IF NOT EXISTS idx_5x_ultra_elite ON wallet_5x_score(is_ultra_elite) WHERE is_ultra_elite = 1`); } catch {}
}

function recomputeOnce(d) {
  const t0 = Date.now();
  const cutoff = Date.now() - LOOKBACK_MS;

  const rows = d.prepare(`
    WITH peaks AS (
      SELECT mint_address, peak_market_cap_sol FROM mints
      WHERE peak_market_cap_sol >= ? AND created_at > ?
    )
    SELECT
      t.wallet AS address,
      COUNT(DISTINCT t.mint_address) AS coins_bought,
      COUNT(DISTINCT CASE WHEN p.peak_market_cap_sol >= ? THEN t.mint_address END) AS coins_5x,
      COUNT(DISTINCT CASE WHEN p.peak_market_cap_sol >= ? THEN t.mint_address END) AS coins_10x,
      COUNT(DISTINCT CASE WHEN p.peak_market_cap_sol >= ? THEN t.mint_address END) AS coins_50x
    FROM trades t
    LEFT JOIN peaks p ON p.mint_address = t.mint_address
    WHERE t.is_buy = 1 AND t.timestamp > ?
    GROUP BY t.wallet
    HAVING coins_bought >= 30
  `).all(FIVE_X_THRESHOLD_SOL, cutoff, FIVE_X_THRESHOLD_SOL, TEN_X_THRESHOLD_SOL, FIFTY_X_THRESHOLD_SOL, cutoff);

  const queryMs = Date.now() - t0;

  const tx = d.transaction(() => {
    d.prepare('DELETE FROM wallet_5x_score').run();
    const ins = d.prepare(`INSERT INTO wallet_5x_score
      (address, coins_bought, coins_5x, coins_10x, coins_50x, hit_rate,
       is_elite, is_super_elite, is_mega_elite, is_ultra_elite, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const now = Date.now();
    let nElite = 0;
    let nSuperElite = 0;
    let nMega = 0;
    let nUltra = 0;
    for (const r of rows) {
      const hitRate = r.coins_bought > 0 ? r.coins_5x / r.coins_bought : 0;
      const isElite = (r.coins_bought >= ELITE_MIN_BUYS && hitRate >= ELITE_MIN_HIT_RATE) ? 1 : 0;
      const isSuperElite = (isElite && r.coins_5x >= SUPER_ELITE_MIN_5X && hitRate >= SUPER_ELITE_MIN_HIT_RATE) ? 1 : 0;
      const isMega = (isSuperElite && r.coins_50x >= MEGA_ELITE_MIN_50X && hitRate >= MEGA_ELITE_MIN_HIT_RATE) ? 1 : 0;
      const isUltra = (isMega && r.coins_50x >= ULTRA_ELITE_MIN_50X && hitRate >= ULTRA_ELITE_MIN_HIT_RATE) ? 1 : 0;
      if (isElite) nElite++;
      if (isSuperElite) nSuperElite++;
      if (isMega) nMega++;
      if (isUltra) nUltra++;
      ins.run(r.address, r.coins_bought, r.coins_5x, r.coins_10x, r.coins_50x, hitRate,
              isElite, isSuperElite, isMega, isUltra, now);
    }
    return { total: rows.length, elite: nElite, superElite: nSuperElite, mega: nMega, ultra: nUltra };
  });
  const r = tx();
  const totalMs = Date.now() - t0;
  console.log(`[5x-scorer] scored ${r.total} wallets · ${r.elite} elite · ${r.superElite} super · ${r.mega} mega · ${r.ultra} ultra · query ${queryMs}ms total ${totalMs}ms`);
}

// ---------- Worker side ----------
if (!isMainThread) {
  const d = db();
  ensureTable(d);

  let running = false;
  function safeRun() {
    if (running) {
      console.log('[5x-scorer] previous run still in flight, skipping tick');
      return;
    }
    running = true;
    try { recomputeOnce(d); }
    catch (err) { console.error('[5x-scorer]', err.message); }
    finally { running = false; }
  }

  setTimeout(safeRun, FIRST_RUN_DELAY_MS);
  setInterval(safeRun, RUN_INTERVAL_MS);
  console.log(`[5x-scorer] worker started · first run in ${FIRST_RUN_DELAY_MS/1000}s · cadence ${RUN_INTERVAL_MS/60000}min`);
}

// ---------- Main-thread side (spawner) ----------
let _worker = null;

export function startWallet5xScorer() {
  if (!isMainThread) return;
  if (_worker) return _worker;
  const workerPath = fileURLToPath(import.meta.url);
  _worker = new Worker(workerPath);
  _worker.on('error', (err) => console.error('[5x-scorer] worker error:', err.message));
  _worker.on('exit', (code) => {
    if (code !== 0) console.error(`[5x-scorer] worker exited code ${code}`);
    _worker = null;
  });
  console.log('[5x-scorer] worker spawned');
  return _worker;
}
