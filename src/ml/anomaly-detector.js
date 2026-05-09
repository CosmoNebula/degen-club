// Anomaly + predictive shift detection.
//
// Most of our context is HINDSIGHT (here's what happened). This module surfaces
// EARLY signals — moments where the meta is shifting before it's obvious from
// outcomes. The agent reads recent anomalies in its context and can react.
//
// Detectors implemented:
//   1. mint_volume_spike     — mint creation rate >2x trailing baseline
//   2. tracked_cohort        — 3+ tracked wallets buy SAME mint within 60s
//   3. dormant_creator       — wallet inactive 7+ days suddenly launches
//   4. theme_cluster         — multiple new mints sharing keyword in 1h
//   5. bundle_reactivation   — bundle cluster fires after >24h dormancy
//   6. kol_cluster           — 5+ KOLs active in last 5min (vs ~1-2 baseline)
//   7. tracked_wallet_dump   — tracked wallet that bought is now selling

import { db } from '../db/index.js';

const TICK_INTERVAL_MS = 60 * 1000;            // every 1 min — anomalies move fast
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
const ANOMALY_TTL_MS = 4 * 60 * 60 * 1000;     // anomaly "active" for 4h

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    insertAnomaly: d.prepare(`INSERT INTO anomalies
       (ts, kind, severity, subject, description, data_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),
    // Dedupe — don't fire same anomaly subject within the TTL window
    recentSame: d.prepare(`SELECT 1 FROM anomalies
       WHERE kind = ? AND subject = ? AND ts > ? LIMIT 1`),
    activeAnomalies: d.prepare(`SELECT * FROM anomalies WHERE expires_at > ? ORDER BY ts DESC`),
  };
  return stmts;
}

function maybeFire(kind, subject, severity, description, data, dedupeMs = ANOMALY_TTL_MS) {
  const now = Date.now();
  const dup = S().recentSame.get(kind, subject || '', now - dedupeMs);
  if (dup) return false;
  S().insertAnomaly.run(now, kind, severity, subject || null, description,
    data ? JSON.stringify(data) : null, now + ANOMALY_TTL_MS);
  console.log(`[anomaly] ${severity.toUpperCase()} ${kind}: ${description}`);
  return true;
}

// 1. Mint volume spike — last 15 min vs trailing 4h baseline
function detectMintVolumeSpike() {
  const d = db();
  const now = Date.now();
  const recent = d.prepare(`SELECT COUNT(*) AS n FROM mints WHERE created_at > ?`).get(now - 15 * 60000).n;
  const baseline = d.prepare(`SELECT COUNT(*) AS n FROM mints WHERE created_at BETWEEN ? AND ?`)
    .get(now - 4 * 3600000, now - 15 * 60000).n;
  // baseline is ~16 fifteen-minute periods. recent is just one. Compare rates.
  const baselineRate = baseline / 15;          // per minute over baseline
  const recentRate = recent / 15;
  if (baselineRate < 5) return;                // skip if quiet (just startup)
  const ratio = recentRate / baselineRate;
  if (ratio >= 2.0) {
    maybeFire('mint_volume_spike',
      `${Math.round(baselineRate)}_to_${Math.round(recentRate)}`,
      ratio >= 3 ? 'high' : 'watch',
      `Mint creation rate ${ratio.toFixed(1)}x baseline (recent ${recent}/15min vs baseline ${Math.round(baselineRate * 15)}/15min)`,
      { recent, baseline, ratio });
  }
}

// 2. Tracked cohort — 3+ tracked wallets buying SAME mint in last 60s
function detectTrackedCohort() {
  const d = db();
  const now = Date.now();
  const rows = d.prepare(`
    SELECT t.mint_address, COUNT(DISTINCT t.wallet) AS n_tracked,
           MAX(t.timestamp) AS latest
    FROM trades t JOIN wallets w ON w.address = t.wallet
    WHERE t.is_buy = 1 AND w.tracked = 1 AND t.timestamp > ?
    GROUP BY t.mint_address HAVING n_tracked >= 3
  `).all(now - 60000);
  for (const r of rows) {
    maybeFire('tracked_cohort', r.mint_address,
      r.n_tracked >= 5 ? 'high' : 'watch',
      `${r.n_tracked} tracked wallets bought ${r.mint_address.slice(0, 10)}… within 60s`,
      { mint: r.mint_address, n_tracked: r.n_tracked });
  }
}

// 3. Dormant creator wakes up — wallet inactive 7+ days launches a new mint
function detectDormantCreator() {
  const d = db();
  const now = Date.now();
  const rows = d.prepare(`
    WITH new_mints AS (
      SELECT creator_wallet, mint_address, created_at FROM mints
      WHERE created_at > ?
    )
    SELECT nm.creator_wallet, nm.mint_address,
           (SELECT MAX(created_at) FROM mints WHERE creator_wallet = nm.creator_wallet AND created_at < nm.created_at) AS prev_mint_at,
           (SELECT COUNT(*) FROM mints WHERE creator_wallet = nm.creator_wallet AND migrated = 1) AS prior_migs
    FROM new_mints nm
    WHERE prev_mint_at IS NOT NULL AND nm.created_at - prev_mint_at > 7 * 86400000
      AND prior_migs >= 1
  `).all(now - 60 * 60000);
  for (const r of rows) {
    const dormantDays = ((r.mint_address && r.prev_mint_at) ? (now - r.prev_mint_at) / 86400000 : 0).toFixed(0);
    maybeFire('dormant_creator', r.creator_wallet,
      r.prior_migs >= 3 ? 'high' : 'watch',
      `Creator with ${r.prior_migs} prior migrators woke up after ${dormantDays}d dormancy: ${r.mint_address.slice(0, 10)}…`,
      { creator: r.creator_wallet, mint: r.mint_address, prior_migs: r.prior_migs, dormant_days: dormantDays });
  }
}

// 4. Theme cluster — multiple new mints sharing a keyword in their name in last hour
function detectThemeCluster() {
  const d = db();
  const now = Date.now();
  const newMints = d.prepare(`SELECT name, symbol, mint_address FROM mints
     WHERE created_at > ? AND name IS NOT NULL`).all(now - 60 * 60000);
  if (newMints.length < 30) return;
  // Tokenize names, count keyword occurrences
  const wordCounts = new Map();
  const COMMON_WORDS = new Set(['THE','AND','FOR','WITH','OF','IN','ON','TO','A','AN','IS','MEME','COIN','TOKEN','PUMP','MOON','BONK']);
  for (const m of newMints) {
    const text = `${m.name} ${m.symbol || ''}`.toUpperCase();
    for (const word of text.split(/[^A-Z0-9]+/).filter(Boolean)) {
      if (word.length < 3 || word.length > 12) continue;
      if (COMMON_WORDS.has(word)) continue;
      if (/^\d+$/.test(word)) continue;
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }
  // Find words appearing in ≥4 mints in last hour — that's a theme
  for (const [word, count] of wordCounts) {
    if (count >= 4) {
      maybeFire('theme_cluster', `theme:${word}`,
        count >= 8 ? 'high' : 'watch',
        `Theme "${word}" appearing in ${count} new mints in last hour`,
        { word, count });
    }
  }
}

// 5. KOL cluster — 5+ KOLs (vs ~1-2 baseline) active in last 5min
function detectKolCluster() {
  const d = db();
  const now = Date.now();
  const recent = d.prepare(`
    SELECT COUNT(DISTINCT t.wallet) AS n
    FROM trades t JOIN wallets w ON w.address = t.wallet
    WHERE w.is_kol = 1 AND t.timestamp > ?
  `).get(now - 5 * 60000).n;
  if (recent >= 5) {
    maybeFire('kol_cluster', `cluster_${Math.floor(now / 60000)}`,
      recent >= 8 ? 'high' : 'watch',
      `${recent} unique KOLs active in last 5 min — unusual concentration`,
      { recent });
  }
}

// 6. Tracked dump — tracked wallet selling a mint they bought (early exit signal)
function detectTrackedDump() {
  const d = db();
  const now = Date.now();
  const rows = d.prepare(`
    SELECT t.mint_address, t.wallet, t.sol_amount, t.timestamp
    FROM trades t JOIN wallets w ON w.address = t.wallet
    WHERE t.is_buy = 0 AND w.tracked = 1 AND t.timestamp > ?
    ORDER BY t.sol_amount DESC LIMIT 5
  `).all(now - 5 * 60000);
  for (const r of rows) {
    if ((r.sol_amount || 0) < 0.5) continue;
    maybeFire('tracked_dump', `${r.mint_address}_${r.wallet}`,
      'watch',
      `Tracked wallet ${r.wallet.slice(0, 6)}… dumped ${r.sol_amount.toFixed(2)} SOL on ${r.mint_address.slice(0, 10)}…`,
      { mint: r.mint_address, wallet: r.wallet, sol: r.sol_amount });
  }
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    detectMintVolumeSpike();
    detectTrackedCohort();
    detectDormantCreator();
    detectThemeCluster();
    detectKolCluster();
    detectTrackedDump();
  } catch (err) { console.error('[anomaly] tick err:', err.message); }
  finally { _running = false; }
}

export function startAnomalyDetector() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log('[anomaly] detector started · every 60s · 6 signal types');
}

// Public for agent context
export function getActiveAnomalies() {
  return S().activeAnomalies.all(Date.now());
}
