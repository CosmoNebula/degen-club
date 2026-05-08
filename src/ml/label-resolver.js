// ML Label Resolver — fills in labels for snapshots once the mint's future
// has played out enough to know the outcome.
//
// Targets computed:
//   - migrated (binary, anytime)
//   - peaked_15 / peaked_30 / peaked_100 / peaked_300 / peaked_500 (binary — did price reach +N% AFTER snapshot?)
//   - peak_pct_max (regression — actual max % reached)
//   - will_die_fast (binary — peak <+15% within 30 min after snapshot AND no recent trades)
//
// 6h is the resolution window. After that we consider the mint's trajectory
// known. Mints that dump fast are usually clear within minutes; runners
// usually peak within 1-2 hours.

import { db } from '../db/index.js';

const RESOLVE_INTERVAL_MS = 5 * 60 * 1000;       // every 5 min
const MIN_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;  // labels resolve after 6h
const BATCH_LIMIT = 1000;

const DIE_FAST_WINDOW_MS = 30 * 60 * 1000;
const DIE_FAST_PEAK_THRESHOLD = 0.15;
const DIE_FAST_QUIET_MS = 10 * 60 * 1000;

// peak_pct_max is computed as (peakPrice − snapshotPrice) / snapshotPrice. If
// snapshot captured a near-zero price (dust trade), the ratio explodes (we've
// seen 19B%). Cap at 1000 (100,000%) which preserves all real pump.fun runners
// — biggest legitimate peak we've ever seen is ~138x — while killing outliers.
const PEAK_PCT_MAX_CAP = 1000;
// Don't compute peak_pct on snapshots whose price is < this — the ratio would
// be junk. Pump.fun launches at ~3e-8 SOL/token; below 1e-9 is almost certainly
// a stale or zero-amount trade.
const MIN_SNAPSHOT_PRICE = 1e-9;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    findUnresolved: d.prepare(`SELECT mint_address, snapshot_age_sec, snapshot_ts, last_price_sol
       FROM ml_mint_snapshots
       WHERE labels_resolved_at IS NULL AND snapshot_ts < ?
       ORDER BY snapshot_ts ASC LIMIT ?`),
    findStaleResolved: d.prepare(`SELECT mint_address, snapshot_age_sec, snapshot_ts, last_price_sol
       FROM ml_mint_snapshots
       WHERE labels_resolved_at IS NOT NULL AND will_die_fast IS NULL
       ORDER BY snapshot_ts ASC LIMIT ?`),
    mintInfo: d.prepare(`SELECT migrated FROM mints WHERE mint_address = ?`),
    // Returns peak price + the timestamp at which peak occurred (regression targets)
    peakRow: d.prepare(`SELECT price_sol AS max_price, timestamp AS peak_ts
       FROM trades WHERE mint_address = ? AND timestamp > ? AND price_sol > 0
       ORDER BY price_sol DESC LIMIT 1`),
    maxPriceWithin: d.prepare(`SELECT MAX(price_sol) AS max_price, MAX(timestamp) AS last_ts
       FROM trades WHERE mint_address = ? AND timestamp > ? AND timestamp <= ? AND price_sol > 0`),
    update: d.prepare(`UPDATE ml_mint_snapshots SET
       migrated = ?, peaked_30 = ?, peaked_100 = ?, peaked_300 = ?, peaked_500 = ?,
       peak_pct_max = ?, time_to_peak_sec = ?, will_die_fast = ?, labels_resolved_at = ?
       WHERE mint_address = ? AND snapshot_age_sec = ?`),
    updateDieFastOnly: d.prepare(`UPDATE ml_mint_snapshots SET will_die_fast = ?
       WHERE mint_address = ? AND snapshot_age_sec = ?`),
  };
  return stmts;
}

function computeDieFast(mintAddress, snapshotTs, snapshotPrice) {
  if (!snapshotPrice || snapshotPrice <= 0) return 0;
  const window = S().maxPriceWithin.get(
    mintAddress, snapshotTs, snapshotTs + DIE_FAST_WINDOW_MS
  );
  const maxPrice = window?.max_price || 0;
  const lastTs = window?.last_ts || 0;
  const peakPctIn30 = maxPrice > 0 ? (maxPrice - snapshotPrice) / snapshotPrice : 0;
  const quietForN = (snapshotTs + DIE_FAST_WINDOW_MS) - lastTs;
  // Died if it didn't pump 15% AND went quiet
  return (peakPctIn30 < DIE_FAST_PEAK_THRESHOLD && quietForN >= DIE_FAST_QUIET_MS) ? 1 : 0;
}

function resolveBatch(rows, label = 'resolve') {
  const s = S();
  const now = Date.now();
  let resolved = 0;
  for (const r of rows) {
    try {
      const mint = s.mintInfo.get(r.mint_address);
      const migrated = mint?.migrated || 0;
      let peakPct = 0;
      let timeToPeakSec = null;
      if (r.last_price_sol > MIN_SNAPSHOT_PRICE) {
        const peakRow = s.peakRow.get(r.mint_address, r.snapshot_ts);
        const maxPrice = peakRow?.max_price || 0;
        peakPct = maxPrice > 0 ? (maxPrice - r.last_price_sol) / r.last_price_sol : 0;
        if (peakPct > PEAK_PCT_MAX_CAP) peakPct = PEAK_PCT_MAX_CAP;
        if (peakRow?.peak_ts && peakPct > 0) {
          timeToPeakSec = Math.max(0, Math.round((peakRow.peak_ts - r.snapshot_ts) / 1000));
        }
      }
      const dieFast = computeDieFast(r.mint_address, r.snapshot_ts, r.last_price_sol);
      s.update.run(
        migrated,
        peakPct >= 0.30 ? 1 : 0,
        peakPct >= 1.00 ? 1 : 0,
        peakPct >= 3.00 ? 1 : 0,
        peakPct >= 5.00 ? 1 : 0,
        peakPct,
        timeToPeakSec,
        dieFast,
        now,
        r.mint_address,
        r.snapshot_age_sec,
      );
      resolved++;
    } catch (err) { console.error('[ml-label] err:', err.message); }
  }
  if (resolved > 0) console.log(`[ml-label] ${label}: ${resolved}/${rows.length}`);
  return resolved;
}

function resolve() {
  const s = S();
  const now = Date.now();
  const cutoff = now - MIN_SNAPSHOT_AGE_MS;
  // First pass: resolve fresh snapshots
  const fresh = s.findUnresolved.all(cutoff, BATCH_LIMIT);
  if (fresh.length > 0) resolveBatch(fresh, 'fresh');
  // Second pass: backfill new label columns on previously-resolved rows
  const stale = s.findStaleResolved.all(BATCH_LIMIT);
  if (stale.length > 0) resolveBatch(stale, 'backfill');
}

export function startLabelResolver() {
  // Run immediately on boot to catch any pending labels from prior runs
  setTimeout(resolve, 60 * 1000);
  setInterval(() => {
    try { resolve(); } catch (err) { console.error('[ml-label] resolve err:', err.message); }
  }, RESOLVE_INTERVAL_MS);
  console.log('[ml-label] label resolver started · interval=5min · resolve_age=6hr · backfills NULL labels');
}
