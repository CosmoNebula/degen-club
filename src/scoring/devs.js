import { db } from '../db/index.js';

let cached = null;
function S() {
  if (cached) return cached;
  const d = db();
  cached = {
    allCreators: d.prepare('SELECT wallet FROM creators'),
    // 2026-05-14: only recompute creators who LAUNCHED a mint or had one
    // migrate/rug in the recent window. last_active_at was too broad —
    // 99.7% of creators "active" because old mints still trade. What
    // matters for classification is new launches + mint outcomes.
    activeCreators: d.prepare(`
      SELECT DISTINCT creator_wallet AS wallet
      FROM mints
      WHERE creator_wallet IS NOT NULL
        AND (
          created_at > ?
          OR (migrated = 1 AND migrated_at > ?)
          OR (rugged = 1 AND rugged_at > ?)
        )
    `),
    creatorMints: d.prepare(`
      SELECT mint_address, peak_market_cap_sol, current_market_cap_sol,
             migrated, rugged, flags, created_at, last_trade_at, migrated_at, rugged_at
      FROM mints WHERE creator_wallet = ?
      ORDER BY created_at
    `),
    bundleOverlap: d.prepare(`
      SELECT COUNT(DISTINCT t.mint_address) AS n
      FROM trades t
      JOIN mints m ON m.mint_address = t.mint_address
      JOIN wallets w ON w.address = t.wallet
      WHERE m.creator_wallet = ?
        AND t.is_buy = 1
        AND t.seconds_from_creation <= 5
        AND w.bundle_cluster_id IS NOT NULL
    `),
    update: d.prepare(`UPDATE creators SET
      launch_count = ?,
      migrated_count = ?,
      rugged_count = ?,
      abandoned_count = ?,
      avg_peak_mcap = ?,
      best_peak_mcap = ?,
      avg_cycle_time_seconds = ?,
      avg_launch_lifetime_seconds = ?,
      last_active_at = ?,
      days_active = ?,
      bundle_overlap_count = ?,
      reputation_score = ?,
      category = ?,
      dev_flags = ?
      WHERE wallet = ?`),
  };
  return cached;
}

export function recomputeCreator(wallet) {
  const s = S();
  const mints = s.creatorMints.all(wallet);
  if (!mints.length) return;

  const launchCount = mints.length;
  let migratedCount = 0, ruggedCount = 0, abandonedCount = 0;
  let totalPeakMcap = 0, bestPeakMcap = 0;
  let totalLifetime = 0, lifetimeSamples = 0;

  for (const m of mints) {
    if (m.migrated) migratedCount++;
    if (m.rugged) ruggedCount++;

    let mintFlags = [];
    try { mintFlags = JSON.parse(m.flags || '[]'); } catch {}
    if (mintFlags.includes('ABANDONED')) abandonedCount++;

    totalPeakMcap += m.peak_market_cap_sol || 0;
    if ((m.peak_market_cap_sol || 0) > bestPeakMcap) bestPeakMcap = m.peak_market_cap_sol || 0;

    if (m.migrated || m.rugged) {
      const finalAt = m.migrated_at || m.rugged_at || m.last_trade_at || m.created_at;
      const lifetime = (finalAt - m.created_at) / 1000;
      if (lifetime > 0) {
        totalLifetime += lifetime;
        lifetimeSamples++;
      }
    }
  }

  const avgPeakMcap = launchCount ? totalPeakMcap / launchCount : 0;
  const avgLifetime = lifetimeSamples ? totalLifetime / lifetimeSamples : 0;

  let cycleTimeSeconds = 0;
  if (mints.length >= 2) {
    let totalDelta = 0;
    for (let i = 1; i < mints.length; i++) {
      totalDelta += (mints[i].created_at - mints[i - 1].created_at) / 1000;
    }
    cycleTimeSeconds = totalDelta / (mints.length - 1);
  }

  const firstLaunch = mints[0].created_at;
  const lastLaunch = mints[mints.length - 1].created_at;
  const daysActive = Math.max(0, (lastLaunch - firstLaunch) / (1000 * 60 * 60 * 24));

  let bundleOverlap = 0;
  try { bundleOverlap = s.bundleOverlap.get(wallet).n; } catch {}

  const stats = {
    launch_count: launchCount,
    migrated_count: migratedCount,
    rugged_count: ruggedCount,
    abandoned_count: abandonedCount,
    avg_peak_mcap: avgPeakMcap,
    best_peak_mcap: bestPeakMcap,
    avg_cycle_time_seconds: cycleTimeSeconds,
    avg_launch_lifetime_seconds: avgLifetime,
    bundle_overlap_count: bundleOverlap,
  };

  const repScore = computeRepScore(stats);
  const { category, flags } = classifyCreator(stats);

  s.update.run(
    launchCount, migratedCount, ruggedCount, abandonedCount,
    avgPeakMcap, bestPeakMcap,
    cycleTimeSeconds, avgLifetime,
    lastLaunch, daysActive,
    bundleOverlap,
    repScore, category, JSON.stringify(flags),
    wallet
  );
}

function computeRepScore(c) {
  const rugRate = c.launch_count ? c.rugged_count / c.launch_count : 0;
  let score = 0;
  score += Math.log(c.migrated_count + 1) * 30;
  score += Math.log(c.launch_count + 1) * 5;
  score += Math.min(50, (c.avg_peak_mcap / 100) * 10);
  score -= rugRate * 100;
  if (c.avg_cycle_time_seconds > 0 && c.avg_cycle_time_seconds < 3600) {
    score -= Math.min(60, (3600 - c.avg_cycle_time_seconds) / 60);
  }
  if (c.bundle_overlap_count > 0) {
    score -= Math.min(50, c.bundle_overlap_count * 5);
  }
  return Math.max(-200, Math.min(200, +score.toFixed(1)));
}

function classifyCreator(c) {
  const rugRate = c.launch_count ? c.rugged_count / c.launch_count : 0;
  const abandonRate = c.launch_count ? c.abandoned_count / c.launch_count : 0;
  const flags = [];

  if (c.migrated_count >= 1) flags.push('GRADUATED');
  if (c.migrated_count >= 3) flags.push('CONSISTENT_GRADS');
  if (rugRate >= 0.5 && c.launch_count >= 3) flags.push('HIGH_RUG_RATE');
  if (c.launch_count >= 10 && c.avg_cycle_time_seconds > 0 && c.avg_cycle_time_seconds < 600) flags.push('SERIAL_OPERATOR');
  if (c.best_peak_mcap >= 200) flags.push('BIG_HIT');
  if (c.bundle_overlap_count >= 3) flags.push('BUNDLE_OPERATOR');
  if (abandonRate >= 0.5 && c.launch_count >= 3) flags.push('ABANDONS');
  if (c.avg_launch_lifetime_seconds > 0 && c.avg_launch_lifetime_seconds < 300 && c.launch_count >= 3) flags.push('FAST_DEATHS');

  let category;
  if (c.launch_count < 3) category = 'NEW';
  else if (flags.includes('SERIAL_OPERATOR') || (rugRate >= 0.5 && c.launch_count >= 5)) category = 'SERIAL';
  else if (rugRate >= 0.5) category = 'RUGGER';
  else if (c.migrated_count >= 1 && c.best_peak_mcap >= 200) category = 'WHALE';
  else if (c.migrated_count >= 1 && rugRate < 0.3) category = 'LEGIT';
  else if (rugRate < 0.3 && c.launch_count >= 5 && abandonRate < 0.5) category = 'LEGIT';
  else category = 'NOT_SURE';

  return { category, flags };
}

// 2026-05-14: was a tight for-loop over ~34k creators with a JOIN-heavy
// SQL query (800ms each) per iteration. Even with batched yielding, 50
// creators × 800ms = 40s of solid blocking per batch. Now yields after
// EACH creator with 30ms gap → max single block ~830ms. Total wall time
// stretches to several hours, fine since dev classification rarely
// changes. The interval is now 4h (was 10min) — way too often before.
const DEVS_PER_CREATOR_YIELD_MS = 30;
// 6h overlaps the 4h sweep interval generously — any creator with a mint
// state change in the last 6h gets reclassified by the next sweep. Tighter
// than 7d (33k) but loose enough that nothing slips between sweep windows.
const DEVS_ACTIVE_WINDOW_HOURS = 6;
export async function recomputeAllCreatorsAsync() {
  const s = S();
  const cutoff = Date.now() - DEVS_ACTIVE_WINDOW_HOURS * 60 * 60 * 1000;
  const active = s.activeCreators.all(cutoff, cutoff, cutoff);
  for (let i = 0; i < active.length; i++) {
    try { recomputeCreator(active[i].wallet); } catch (err) { console.error('[devs]', err.message); }
    // Per-creator yield keeps WSS / heartbeat / live processing breathing.
    await new Promise(resolve => setTimeout(resolve, DEVS_PER_CREATOR_YIELD_MS));
  }
  return active.length;
}

// Sync version retained for the manual CLI path in case anything still
// imports it. Bot scheduler uses the async version.
export function recomputeAllCreators() {
  const s = S();
  const all = s.allCreators.all();
  for (const r of all) {
    try { recomputeCreator(r.wallet); } catch (err) { console.error('[devs]', err.message); }
  }
  return all.length;
}

export function startDevSweep() {
  // 2026-05-14: scheduler moved off main thread to devs-worker.js.
  // recomputeAllCreatorsAsync stays exported for the worker. Manual CLI
  // path uses recomputeAllCreators (sync). No-op here so index.js
  // doesn't need a wiring change; worker is started separately.
  console.log('[devs] in-process scheduler disabled — recompute owned by devs-worker thread');
}
