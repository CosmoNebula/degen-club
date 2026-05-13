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

// Long-horizon "hold-to-maturity" label constants (added 2026-05-12).
const HOLD_1H_MS = 1 * 60 * 60 * 1000;
const HOLD_4H_MS = 4 * 60 * 60 * 1000;
const HOLD_24H_MS = 24 * 60 * 60 * 1000;
// "Alive at horizon X" = at least one trade in the 5-minute window ending at
// snapshot+X. 5min is wide enough to forgive sparse-trading mints but tight
// enough that mints that genuinely died register as 0.
const ALIVE_PROBE_WINDOW_MS = 5 * 60 * 1000;
const HITS_5X_RATIO = 5.0;
const HITS_10X_RATIO = 10.0;
// hold_Xh_pct ratios use the same cap as peak_pct_max — dust-price snapshots
// can produce absurd ratios. 1000 = 100,000% preserves real runners.
const HOLD_RETURN_CAP = 1000;
const DRAWDOWN_24H_CAP = 0.99;
// Stale-backfill cutoff. Rows must be at least past the shortest long-label
// horizon (hold_1h) to be worth scanning. The "already tried" guard below in
// the SQL filter handles the upper bound dynamically: if a row was last
// resolved AFTER its 24h window passed, retrying won't help (trades for that
// window have likely been pruned), so we skip it. This means we don't have
// to hard-code a "max age" tied to trade retention.
const STALE_BACKFILL_MIN_AGE_MS = 70 * 60 * 1000;       // past hold_1h horizon
// 25h × 3600 × 1000 = 90000000 — used as a literal in the SQL filter below.
const POST_WINDOW_MS = 25 * 60 * 60 * 1000;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    findUnresolved: d.prepare(`SELECT mint_address, snapshot_age_sec, snapshot_ts, last_price_sol
       FROM ml_mint_snapshots
       WHERE labels_resolved_at IS NULL AND snapshot_ts < ?
       ORDER BY snapshot_ts ASC LIMIT ?`),
    // Stale-backfill query — finds previously-resolved rows missing any label.
    // Two filters protect against the "infinite loop on hopeless rows" bug:
    //   1. snapshot_ts < ?: row must be past the hold_1h horizon (otherwise
    //      compute always returns NULL and we waste cycles).
    //   2. labels_resolved_at < snapshot_ts + 25h: row was last resolved
    //      BEFORE its 24h window finished playing out. If we've already
    //      resolved it AFTER the 24h mark and the labels are STILL NULL,
    //      that means trade data was pruned — retrying won't fix it.
    //      Once we touch the row and set labels_resolved_at = now (where
    //      now > snapshot_ts + 25h), this filter excludes it next time.
    findStaleResolved: d.prepare(`SELECT mint_address, snapshot_age_sec, snapshot_ts, last_price_sol
       FROM ml_mint_snapshots
       WHERE labels_resolved_at IS NOT NULL
         AND snapshot_ts < ?
         AND labels_resolved_at < snapshot_ts + 90000000  /* 25h in ms */
         AND (will_die_fast IS NULL OR rug_within_5min IS NULL
              OR migrates_within_15min IS NULL OR drawdown_from_peak_pct IS NULL
              OR hits_2x_within_1h IS NULL OR time_to_peak_5x_sec IS NULL
              OR alive_at_1h IS NULL OR alive_at_4h IS NULL OR alive_at_24h IS NULL
              OR hits_5x_within_24h IS NULL OR hits_10x_within_24h IS NULL
              OR hold_1h_pct IS NULL OR hold_4h_pct IS NULL OR hold_24h_pct IS NULL
              OR peak_pct_within_24h IS NULL OR max_drawdown_within_24h_pct IS NULL)
       ORDER BY snapshot_ts DESC LIMIT ?`),
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
    // Long-horizon hold queries (added 2026-05-12).
    // priceAtOrBefore: returns the most recent valid trade price ≤ target_ts.
    // Used for hold_Xh_pct — we want "what was the price at exactly X hours
    // after snapshot" and trades aren't sampled at exact moments.
    priceAtOrBefore: d.prepare(`SELECT price_sol FROM trades
       WHERE mint_address = ? AND timestamp <= ? AND price_sol > 0
       ORDER BY timestamp DESC LIMIT 1`),
    // tradeInWindow: just check if ANY trade exists in [start_ts, end_ts].
    // Used for alive_at_Xh — mint is alive if it traded in the 5-min window
    // ending at horizon. LIMIT 1 + index makes this cheap.
    tradeInWindow: d.prepare(`SELECT 1 FROM trades
       WHERE mint_address = ? AND timestamp BETWEEN ? AND ? LIMIT 1`),
    // maxPriceInWindow: max price AND its timestamp, bounded above. Used
    // for hits_Nx_within_24h, peak_pct_within_24h, and max_drawdown_within_24h_pct.
    maxPriceInWindow: d.prepare(`SELECT price_sol AS max_price, timestamp AS peak_ts
       FROM trades WHERE mint_address = ? AND timestamp > ? AND timestamp <= ? AND price_sol > 0
       ORDER BY price_sol DESC LIMIT 1`),
    // minPriceInWindowRange: min price in [start_ts, end_ts]. Used after we
    // know the peak ts in the 24h window — we look for the min AFTER the peak,
    // still bounded by the 24h horizon.
    minPriceInWindowRange: d.prepare(`SELECT MIN(price_sol) AS min_price
       FROM trades WHERE mint_address = ? AND timestamp >= ? AND timestamp <= ? AND price_sol > 0`),
    update: d.prepare(`UPDATE ml_mint_snapshots SET
       migrated = ?, peaked_30 = ?, peaked_100 = ?, peaked_300 = ?, peaked_500 = ?,
       peak_pct_max = ?, time_to_peak_sec = ?, will_die_fast = ?,
       rug_within_5min = ?, migrates_within_15min = ?, drawdown_from_peak_pct = ?,
       hits_2x_within_1h = ?, time_to_peak_5x_sec = ?,
       alive_at_1h = COALESCE(?, alive_at_1h),
       alive_at_4h = COALESCE(?, alive_at_4h),
       alive_at_24h = COALESCE(?, alive_at_24h),
       hits_5x_within_24h = COALESCE(?, hits_5x_within_24h),
       hits_10x_within_24h = COALESCE(?, hits_10x_within_24h),
       hold_1h_pct = COALESCE(?, hold_1h_pct),
       hold_4h_pct = COALESCE(?, hold_4h_pct),
       hold_24h_pct = COALESCE(?, hold_24h_pct),
       peak_pct_within_24h = COALESCE(?, peak_pct_within_24h),
       max_drawdown_within_24h_pct = COALESCE(?, max_drawdown_within_24h_pct),
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

// alive_at_Xh: 1 if ANY trade occurred in the 5-min window ending at
// snapshot_ts + ageMs. Returns null if the window hasn't passed yet OR if the
// horizon hasn't arrived in wall-clock time. The stale-backfill pass will
// fill these in later as snapshots age past each horizon.
function computeAliveAt(mintAddress, snapshotTs, ageMs) {
  const target = snapshotTs + ageMs;
  if (Date.now() < target) return null;
  const row = S().tradeInWindow.get(
    mintAddress, target - ALIVE_PROBE_WINDOW_MS, target
  );
  return row ? 1 : 0;
}

// hold_Xh_pct: return achieved if you held from snapshot to snapshot+ageMs.
// (price_at_horizon - snapshot_price) / snapshot_price. NULL when horizon
// hasn't arrived yet, or when no trade exists at-or-before the horizon (mint
// died before that point), or when snapshot price is junk.
function computeHoldPct(mintAddress, snapshotTs, snapshotPrice, ageMs) {
  if (!snapshotPrice || snapshotPrice <= MIN_SNAPSHOT_PRICE) return null;
  const target = snapshotTs + ageMs;
  if (Date.now() < target) return null;
  // Require the candidate trade to be AFTER the snapshot so we don't read the
  // snapshot's own price back as the "hold" value when the mint dies right after.
  const row = S().priceAtOrBefore.get(mintAddress, target);
  if (!row?.price_sol || row.price_sol <= 0) return null;
  let pct = (row.price_sol - snapshotPrice) / snapshotPrice;
  return Math.min(pct, HOLD_RETURN_CAP);
}

// hits_Nx_within_24h: 1 if max price in (snapshot, snapshot+24h] reached
// ratio × snapshot_price. NULL until horizon passes or snapshot price is junk.
function computeHitsRatioWithin24h(mintAddress, snapshotTs, snapshotPrice, ratio) {
  if (!snapshotPrice || snapshotPrice <= MIN_SNAPSHOT_PRICE) return null;
  const target = snapshotTs + HOLD_24H_MS;
  if (Date.now() < target) return null;
  const row = S().maxPriceInWindow.get(mintAddress, snapshotTs, target);
  const maxPrice = row?.max_price;
  if (maxPrice == null || maxPrice <= 0) return 0;
  return maxPrice >= snapshotPrice * ratio ? 1 : 0;
}

// peak_pct_within_24h: max return achievable if exited at the peak inside the
// 24h window. Bounded version of peak_pct_max (which scans forever) — keeps
// the model from rewarding mints whose peak is, e.g., 3 days post-snapshot.
function computePeakPctWithin24h(mintAddress, snapshotTs, snapshotPrice) {
  if (!snapshotPrice || snapshotPrice <= MIN_SNAPSHOT_PRICE) return null;
  const target = snapshotTs + HOLD_24H_MS;
  if (Date.now() < target) return null;
  const row = S().maxPriceInWindow.get(mintAddress, snapshotTs, target);
  const maxPrice = row?.max_price;
  if (maxPrice == null || maxPrice <= 0) return 0;
  let pct = (maxPrice - snapshotPrice) / snapshotPrice;
  return Math.min(pct, HOLD_RETURN_CAP);
}

// max_drawdown_within_24h_pct: worst drawdown experienced inside the 24h
// window, computed from the in-window peak to the min AFTER that peak (still
// inside the window). Different from drawdown_from_peak_pct which is unbounded.
// Drives risk-modeling: a mint that 5x'd then bled to 0 has very different
// hold-PnL than one that 5x'd and held steady — both same peak_pct_within_24h
// but very different max_drawdown.
function computeMaxDrawdownWithin24h(mintAddress, snapshotTs, snapshotPrice) {
  if (!snapshotPrice || snapshotPrice <= MIN_SNAPSHOT_PRICE) return null;
  const target = snapshotTs + HOLD_24H_MS;
  if (Date.now() < target) return null;
  const peakRow = S().maxPriceInWindow.get(mintAddress, snapshotTs, target);
  if (!peakRow?.max_price || peakRow.max_price <= 0 || !peakRow.peak_ts) return 0;
  const minRow = S().minPriceInWindowRange.get(
    mintAddress, peakRow.peak_ts, target
  );
  const minPrice = minRow?.min_price;
  if (minPrice == null || minPrice <= 0) return 0;
  const dd = (peakRow.max_price - minPrice) / peakRow.max_price;
  if (dd < 0) return 0;  // shouldn't happen but defensive
  return Math.min(dd, DRAWDOWN_24H_CAP);
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
      // Long-horizon hold-to-maturity labels. Each returns NULL if the
      // horizon hasn't arrived yet — UPDATE uses COALESCE so prior values
      // are preserved on partial backfill.
      const alive1h = computeAliveAt(r.mint_address, r.snapshot_ts, HOLD_1H_MS);
      const alive4h = computeAliveAt(r.mint_address, r.snapshot_ts, HOLD_4H_MS);
      const alive24h = computeAliveAt(r.mint_address, r.snapshot_ts, HOLD_24H_MS);
      const hits5x24h = computeHitsRatioWithin24h(r.mint_address, r.snapshot_ts, r.last_price_sol, HITS_5X_RATIO);
      const hits10x24h = computeHitsRatioWithin24h(r.mint_address, r.snapshot_ts, r.last_price_sol, HITS_10X_RATIO);
      const hold1h = computeHoldPct(r.mint_address, r.snapshot_ts, r.last_price_sol, HOLD_1H_MS);
      const hold4h = computeHoldPct(r.mint_address, r.snapshot_ts, r.last_price_sol, HOLD_4H_MS);
      const hold24h = computeHoldPct(r.mint_address, r.snapshot_ts, r.last_price_sol, HOLD_24H_MS);
      const peakPct24h = computePeakPctWithin24h(r.mint_address, r.snapshot_ts, r.last_price_sol);
      const maxDd24h = computeMaxDrawdownWithin24h(r.mint_address, r.snapshot_ts, r.last_price_sol);
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
        alive1h, alive4h, alive24h,
        hits5x24h, hits10x24h,
        hold1h, hold4h, hold24h,
        peakPct24h, maxDd24h,
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
  // Second pass: backfill new label columns on previously-resolved rows.
  // Filter is past hold_1h horizon. The labels_resolved_at < snapshot_ts+25h
  // guard inside the SQL prevents infinite re-scan of rows where trades
  // for the resolution window have been pruned (after one update they no
  // longer match the filter). Processed newest-first so the most-useful
  // rows fill in first; stale-but-doomed older rows get touched once and
  // dropped out of subsequent queries.
  const staleCeil = now - STALE_BACKFILL_MIN_AGE_MS;
  const stale = s.findStaleResolved.all(staleCeil, BATCH_LIMIT);
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
