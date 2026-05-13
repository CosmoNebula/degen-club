// Section D1 (Phase D, 2026-05-13): tracker concentration cap.
//
// Maintains a rolling 4-hour counter of "entries credited to wallet X." When a
// tracker's contribution to recent entries crosses CONCENTRATION_CAP_FRAC, the
// wallet is MUTED — its tracked-wallet-buy trigger no longer fires evaluation
// until concentration drops below the threshold.
//
// This is the anti-adverse-selection layer. Even if a tracker is in top-50,
// we don't want our entries dominated by one wallet. Forces diversification
// across the tracker pool and limits damage if one tracker starts spraying.
//
// Bot-side enforcement: processor.js consults isMuted(wallet) when the
// "tracked-wallet-buy" trigger is about to fire. agent-executor.js attributes
// entries back to wallets that were active in the 60s pre-entry.

import { db } from '../db/index.js';

const WINDOW_MS = 4 * 60 * 60 * 1000;            // 4-hour rolling window
const CONCENTRATION_CAP_FRAC = 0.25;             // any single tracker can drive ≤25% of recent entries
const MIN_ENTRIES_FOR_CAP = 8;                   // need at least this many entries before cap kicks in
const REFRESH_INTERVAL_MS = 60 * 1000;           // recompute the muted set every 60s

const _mutedWallets = new Set();
const _trackerCounts = new Map();  // wallet → count in current window

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    recentEntriesWithTrackers: d.prepare(`
      SELECT tracker_wallets_json FROM paper_positions
      WHERE entered_at > ? AND tracker_wallets_json IS NOT NULL
    `),
  };
  return stmts;
}

function refresh() {
  try {
    const since = Date.now() - WINDOW_MS;
    const rows = S().recentEntriesWithTrackers.all(since);
    const counts = new Map();
    let total = 0;
    for (const r of rows) {
      let arr; try { arr = JSON.parse(r.tracker_wallets_json); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      total++;
      // Each entry credits up to N trackers. Use a Set to dedupe within one entry.
      const uniq = new Set(arr);
      for (const w of uniq) counts.set(w, (counts.get(w) || 0) + 1);
    }
    _trackerCounts.clear();
    for (const [w, n] of counts) _trackerCounts.set(w, n);

    const newMuted = new Set();
    if (total >= MIN_ENTRIES_FOR_CAP) {
      const cap = Math.ceil(total * CONCENTRATION_CAP_FRAC);
      for (const [w, n] of counts) {
        if (n >= cap) newMuted.add(w);
      }
    }
    _mutedWallets.clear();
    for (const w of newMuted) _mutedWallets.add(w);
  } catch (err) {
    console.error('[tracker-conc] refresh err:', err.message);
  }
}

export function isMuted(walletAddress) {
  return _mutedWallets.has(walletAddress);
}

export function getMutedCount() {
  return _mutedWallets.size;
}

export function getTrackerCount(walletAddress) {
  return _trackerCounts.get(walletAddress) || 0;
}

export function startTrackerConcentration() {
  setTimeout(refresh, 30 * 1000);
  setInterval(refresh, REFRESH_INTERVAL_MS);
  console.log(`[tracker-conc] started · window=${WINDOW_MS / 3600000}h · cap=${(CONCENTRATION_CAP_FRAC * 100).toFixed(0)}% · refresh every ${REFRESH_INTERVAL_MS / 1000}s`);
}
