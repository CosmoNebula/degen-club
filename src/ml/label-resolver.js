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

// rug_within_5min: positive if min_price within 5 min after snapshot drops to
// ≤ 30% of snapshot_price (i.e., -70% or worse). Catches flash rugs that
// will_die_fast (30-min window, 15% threshold) misses.
const RUG_WINDOW_MS = 5 * 60 * 1000;
const RUG_PRICE_RATIO = 0.30;

// migrates_within_15min: positive if mint.migrated_at - snapshot_ts ≤ 15min.
const MIGRATE_SOON_WINDOW_MS = 15 * 60 * 1000;

// drawdown_from_peak_pct: regression — (peak_price - min_price_after_peak) /
// peak_price. Capped at 0.99 so the model isn't dominated by total-rug cases.
const DRAWDOWN_CAP = 0.99;

// hits_2x_within_1h: positive if max_price within 60 min after snapshot ≥ 2×
// snapshot_price. Catches medium runners that don't migrate but still 2-5x.
const HITS_2X_WINDOW_MS = 60 * 60 * 1000;
const HITS_2X_PRICE_RATIO = 2.0;

// time_to_peak_5x_sec: regression — seconds from "mint first crossed +50% of
// snapshot price" to "peak after that crossing". NULL if never hit +50%.
// 50% is a deliberate choice: peaked_30 lift is statistically weak (lots of
// false-positive small bounces); +50% is where the bot's tier1 fires so this
// is the model's "if we're at tier1, when do we tighten?" signal.
const TIME_TO_PEAK_TRIGGER_RATIO = 1.5;  // +50% from snapshot price
const TIME_TO_PEAK_CAP_SEC = 6 * 60 * 60; // 6h ceiling — matches resolution window

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
       WHERE labels_resolved_at IS NOT NULL
         AND (will_die_fast IS NULL OR rug_within_5min IS NULL
              OR migrates_within_15min IS NULL OR drawdown_from_peak_pct IS NULL
              OR hits_2x_within_1h IS NULL OR time_to_peak_5x_sec IS NULL)
       ORDER BY snapshot_ts ASC LIMIT ?`),
    mintInfo: d.prepare(`SELECT migrated, migrated_at FROM mints WHERE mint_address = ?`),
    // Returns peak price + the timestamp at which peak occurred (regression targets)
    peakRow: d.prepare(`SELECT price_sol AS max_price, timestamp AS peak_ts
       FROM trades WHERE mint_address = ? AND timestamp > ? AND price_sol > 0
       ORDER BY price_sol DESC LIMIT 1`),
    maxPriceWithin: d.prepare(`SELECT MAX(price_sol) AS max_price, MAX(timestamp) AS last_ts
       FROM trades WHERE mint_address = ? AND timestamp > ? AND timestamp <= ? AND price_sol > 0`),
    // Min price within a window — used for rug_within_5min label.
    minPriceWithin: d.prepare(`SELECT MIN(price_sol) AS min_price
       FROM trades WHERE mint_address = ? AND timestamp > ? AND timestamp <= ? AND price_sol > 0`),
    // Min price AFTER the peak — for drawdown_from_peak_pct.
    minPriceAfter: d.prepare(`SELECT MIN(price_sol) AS min_price
       FROM trades WHERE mint_address = ? AND timestamp >= ? AND price_sol > 0`),
    // hits_2x_within_1h: just need max_price in the 60min window after snapshot.
    // Already covered by maxPriceWithin — passed window=60min.
    // time_to_peak_5x: find first trade where price crossed the +50% threshold,
    // then peak price+ts AFTER that threshold. Two queries combined.
    firstCrossing: d.prepare(`SELECT timestamp FROM trades
       WHERE mint_address = ? AND timestamp > ? AND price_sol >= ?
       ORDER BY timestamp ASC LIMIT 1`),
    peakAfter: d.prepare(`SELECT MAX(price_sol) AS max_price, timestamp AS peak_ts
       FROM trades WHERE mint_address = ? AND timestamp >= ? AND price_sol > 0
       ORDER BY price_sol DESC LIMIT 1`),
    update: d.prepare(`UPDATE ml_mint_snapshots SET
       migrated = ?, peaked_30 = ?, peaked_100 = ?, peaked_300 = ?, peaked_500 = ?,
       peak_pct_max = ?, time_to_peak_sec = ?, will_die_fast = ?,
       rug_within_5min = ?, migrates_within_15min = ?, drawdown_from_peak_pct = ?,
       hits_2x_within_1h = ?, time_to_peak_5x_sec = ?,
       labels_resolved_at = ?
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

// rug_within_5min: 1 if min price within 5 min after snapshot dropped to ≤30%
// of snapshot_price (i.e., -70%+ from entry). NULL if snapshot price is junk.
function computeRugWithin5min(mintAddress, snapshotTs, snapshotPrice) {
  if (!snapshotPrice || snapshotPrice <= MIN_SNAPSHOT_PRICE) return null;
  const row = S().minPriceWithin.get(
    mintAddress, snapshotTs, snapshotTs + RUG_WINDOW_MS
  );
  const minPrice = row?.min_price;
  if (minPrice == null || minPrice <= 0) return 0;
  return (minPrice / snapshotPrice) <= RUG_PRICE_RATIO ? 1 : 0;
}

// migrates_within_15min: 1 if mint.migrated_at exists and falls within 15 min
// after snapshot_ts. NULL means mint hasn't migrated at all (yet).
function computeMigratesWithin15min(migratedAt, snapshotTs) {
  if (!migratedAt) return 0;  // never migrated = negative class, not NULL
  const delta = migratedAt - snapshotTs;
  if (delta < 0) return 0;  // migrated BEFORE the snapshot — degenerate, treat as no
  return delta <= MIGRATE_SOON_WINDOW_MS ? 1 : 0;
}

// drawdown_from_peak_pct: (peak_price - min_price_after_peak) / peak_price.
// Capped at DRAWDOWN_CAP. NULL if no peak or junk price.
function computeDrawdownFromPeak(mintAddress, snapshotTs, snapshotPrice, peakPrice, peakTs) {
  if (!snapshotPrice || snapshotPrice <= MIN_SNAPSHOT_PRICE) return null;
  if (!peakPrice || peakPrice <= 0 || !peakTs) return null;
  const row = S().minPriceAfter.get(mintAddress, peakTs);
  const minPrice = row?.min_price;
  if (minPrice == null || minPrice <= 0) return 0;
  const dd = (peakPrice - minPrice) / peakPrice;
  if (dd < 0) return 0;  // shouldn't happen but defensive
  return Math.min(dd, DRAWDOWN_CAP);
}

// hits_2x_within_1h: 1 if any trade within 60 min of snapshot had price ≥ 2×
// snapshot_price. NULL if snapshot price is junk.
function computeHits2xWithin1h(mintAddress, snapshotTs, snapshotPrice) {
  if (!snapshotPrice || snapshotPrice <= MIN_SNAPSHOT_PRICE) return null;
  const row = S().maxPriceWithin.get(
    mintAddress, snapshotTs, snapshotTs + HITS_2X_WINDOW_MS
  );
  const maxPrice = row?.max_price;
  if (maxPrice == null || maxPrice <= 0) return 0;
  return maxPrice >= snapshotPrice * HITS_2X_PRICE_RATIO ? 1 : 0;
}

// time_to_peak_5x_sec: how many seconds from "first trade ≥ +50% of snapshot
// price" to "peak after that trigger." NULL if the +50% threshold was never
// crossed within the resolution window. Capped at TIME_TO_PEAK_CAP_SEC.
// Despite the name "5x" (legacy from audit), the trigger is +50% (matches our
// typical tier1 trigger), and the model predicts time-to-peak from that point.
function computeTimeToPeak5xSec(mintAddress, snapshotTs, snapshotPrice) {
  if (!snapshotPrice || snapshotPrice <= MIN_SNAPSHOT_PRICE) return null;
  const triggerPrice = snapshotPrice * TIME_TO_PEAK_TRIGGER_RATIO;
  const triggerRow = S().firstCrossing.get(mintAddress, snapshotTs, triggerPrice);
  if (!triggerRow?.timestamp) return null;
  const triggerTs = triggerRow.timestamp;
  const peakRow = S().peakAfter.get(mintAddress, triggerTs);
  if (!peakRow?.peak_ts) return null;
  const deltaSec = Math.max(0, Math.round((peakRow.peak_ts - triggerTs) / 1000));
  return Math.min(deltaSec, TIME_TO_PEAK_CAP_SEC);
}

function resolveBatch(rows, label = 'resolve') {
  const s = S();
  const now = Date.now();
  let resolved = 0;
  let junkPrice = 0;
  for (const r of rows) {
    try {
      if (!r.last_price_sol || r.last_price_sol <= MIN_SNAPSHOT_PRICE) junkPrice++;
      const mint = s.mintInfo.get(r.mint_address);
      const migrated = mint?.migrated || 0;
      let peakPct = 0;
      let peakPrice = 0;
      let peakTs = null;
      let timeToPeakSec = null;
      if (r.last_price_sol > MIN_SNAPSHOT_PRICE) {
        const peakRow = s.peakRow.get(r.mint_address, r.snapshot_ts);
        peakPrice = peakRow?.max_price || 0;
        peakTs = peakRow?.peak_ts || null;
        peakPct = peakPrice > 0 ? (peakPrice - r.last_price_sol) / r.last_price_sol : 0;
        if (peakPct > PEAK_PCT_MAX_CAP) peakPct = PEAK_PCT_MAX_CAP;
        if (peakTs && peakPct > 0) {
          timeToPeakSec = Math.max(0, Math.round((peakTs - r.snapshot_ts) / 1000));
        }
      }
      const dieFast = computeDieFast(r.mint_address, r.snapshot_ts, r.last_price_sol);
      const rug5 = computeRugWithin5min(r.mint_address, r.snapshot_ts, r.last_price_sol);
      const migSoon = computeMigratesWithin15min(mint?.migrated_at, r.snapshot_ts);
      const drawdown = computeDrawdownFromPeak(r.mint_address, r.snapshot_ts, r.last_price_sol, peakPrice, peakTs);
      const hits2x = computeHits2xWithin1h(r.mint_address, r.snapshot_ts, r.last_price_sol);
      const ttp5x = computeTimeToPeak5xSec(r.mint_address, r.snapshot_ts, r.last_price_sol);
      s.update.run(
        migrated,
        peakPct >= 0.30 ? 1 : 0,
        peakPct >= 1.00 ? 1 : 0,
        peakPct >= 3.00 ? 1 : 0,
        peakPct >= 5.00 ? 1 : 0,
        peakPct,
        timeToPeakSec,
        dieFast,
        rug5,
        migSoon,
        drawdown,
        hits2x,
        ttp5x,
        now,
        r.mint_address,
        r.snapshot_age_sec,
      );
      resolved++;
    } catch (err) { console.error('[ml-label] err:', err.message); }
  }
  if (resolved > 0) {
    const junkNote = junkPrice > 0 ? ` · junk-price=${junkPrice} (rug5/drawdown NULL)` : '';
    console.log(`[ml-label] ${label}: ${resolved}/${rows.length}${junkNote}`);
  }
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
