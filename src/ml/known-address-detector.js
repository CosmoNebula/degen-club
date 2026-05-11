// Auto-detector for routing / infrastructure addresses.
//
// Scans creator_activity_cache.raw_summary across many launches. An address
// that receives SOL from N+ unrelated creator wallets, totalling M+ SOL, is
// statistically almost certain to be routing/aggregator/MEV infrastructure
// rather than a per-launch sidewallet. Promotes such addresses to the
// known_addresses blocklist with source='auto' so the sidewallet detector
// stops flagging them on future fetches.
//
// Runs once at bot startup (after a brief delay so the DB is warm) and then
// hourly. Idempotent — INSERT OR IGNORE means we don't overwrite manually-
// curated entries.

import { db } from '../db/index.js';

// Conservative thresholds to avoid promoting real sidewallets:
//   - Must appear across ≥3 DISTINCT creator wallets (rules out
//     same-creator-multiple-launches false positive; raise if false-pos appear)
//   - Combined SOL flow ≥5 SOL (rules out incidental small transfers)
const MIN_DISTINCT_CREATORS = 3;
const MIN_TOTAL_SOL = 5.0;
const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000; // 5min after boot

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    allCacheRows: d.prepare(`
      SELECT creator_wallet, sol_to_sidewallets, raw_summary
      FROM creator_activity_cache
      WHERE fetch_status = 'ok' AND raw_summary IS NOT NULL
    `),
    insertKnown: d.prepare(`INSERT OR IGNORE INTO known_addresses
      (address, name, category, confidence, source) VALUES (?,?,?,?,?)`),
    countKnown: d.prepare(`SELECT COUNT(*) AS n FROM known_addresses WHERE address = ?`),
  };
  return stmts;
}

export function detectAndPromote() {
  const s = S();
  const rows = s.allCacheRows.all();
  if (rows.length === 0) return { scanned: 0, promoted: 0 };

  // address → { creators: Set, total_sol: number, total_appearances: number }
  const addrStats = new Map();

  for (const row of rows) {
    let summary;
    try { summary = JSON.parse(row.raw_summary); }
    catch { continue; }
    const candidates = summary.candidate_addresses || [];
    if (candidates.length === 0) continue;
    // Distribute the row's total sol_to_sidewallets evenly across listed
    // candidates — proxy for per-address flow. Imperfect (we only store
    // the top-10 candidates) but good enough for detection.
    const perCandidateSol = (row.sol_to_sidewallets || 0) / Math.max(1, candidates.length);
    for (const addr of candidates) {
      let stat = addrStats.get(addr);
      if (!stat) {
        stat = { creators: new Set(), total_sol: 0, appearances: 0 };
        addrStats.set(addr, stat);
      }
      stat.creators.add(row.creator_wallet);
      stat.total_sol += perCandidateSol;
      stat.appearances++;
    }
  }

  let promoted = 0;
  const promotedAddresses = [];
  for (const [addr, stat] of addrStats.entries()) {
    if (stat.creators.size < MIN_DISTINCT_CREATORS) continue;
    if (stat.total_sol < MIN_TOTAL_SOL) continue;
    // Skip if already known (manual or earlier auto-promotion)
    const existing = s.countKnown.get(addr);
    if (existing.n > 0) continue;
    const name = `auto-detected infra (${stat.creators.size} creators, ${stat.total_sol.toFixed(1)} SOL)`;
    s.insertKnown.run(addr, name, 'infra', 'auto', 'auto-detector');
    promoted++;
    promotedAddresses.push(`${addr.slice(0, 10)}…(${stat.creators.size}/${stat.total_sol.toFixed(0)}sol)`);
  }

  if (promoted > 0) {
    console.log(`[addr-detector] scanned ${rows.length} cache rows · promoted ${promoted} to blocklist: ${promotedAddresses.slice(0, 8).join(', ')}`);
  } else {
    console.log(`[addr-detector] scanned ${rows.length} cache rows · 0 new promotions (thresholds: ≥${MIN_DISTINCT_CREATORS} creators, ≥${MIN_TOTAL_SOL} SOL)`);
  }
  return { scanned: rows.length, promoted };
}

export function startKnownAddressDetector() {
  setTimeout(() => {
    try { detectAndPromote(); } catch (err) { console.error('[addr-detector] err:', err.message); }
  }, FIRST_RUN_DELAY_MS);
  setInterval(() => {
    try { detectAndPromote(); } catch (err) { console.error('[addr-detector] err:', err.message); }
  }, RUN_INTERVAL_MS);
  console.log(`[addr-detector] started · first run in ${FIRST_RUN_DELAY_MS / 60000}min, then every ${RUN_INTERVAL_MS / 60000}min`);
}
