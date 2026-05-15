// A2 (Phase D, 2026-05-13): ML-conviction watch list.
//
// Every 30s, scans recent ml_predictions for mints whose key targets crossed
// entry-worthy thresholds. processor.js imports the resulting Set and fires
// evaluateMintNow on any trade event for a watched mint. The existing 8s
// eval-debounce in agent-executor handles rate-limiting on hot mints.
//
// Complements A1 (snapshot-sweeper firing eval at every snapshot age):
//   - A1 catches the "snapshot age moment" (60s/120s/300s/etc)
//   - A2 catches "trade event on ML-interesting coin between snapshots"
//
// Together they remove the "smart-wallet-activated" universe restriction and
// let the bot see every mint the ML thinks is worth a look.

import { db } from '../db/index.js';

const CHECK_INTERVAL_MS = 30 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const PREDICTION_FRESHNESS_MS = 5 * 60 * 1000;  // only consider predictions <5min old

const _convictionMints = new Set();

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    // Pull distinct mints with any recent high-conviction prediction. Thresholds
    // chosen to surface mints worth a look without over-firing:
    //   - migrated >= 0.50: ML confident it'll graduate
    //   - hits_5x_within_24h >= 0.25: meaningful chance of a 5x runner
    //   - peaked_300 >= 0.20: likely 3x at some point
    //   - hits_10x_within_24h >= 0.10: rare but very high-EV
    // 2026-05-15: rewrote OR-shape as UNION. The OR pattern made the planner
    // pick idx_ml_pred_mint (scan-distinct-mint) which is cold-cache slow
    // (1.6-2.4s on the main thread, every 30s). UNION lets each branch use
    // idx_ml_predictions_target (target=?, timestamp>?) directly.
    convictionPreds: d.prepare(`
      SELECT mint_address FROM ml_predictions
      WHERE target = 'migrated' AND timestamp > ? AND prob >= 0.50
      UNION
      SELECT mint_address FROM ml_predictions
      WHERE target = 'hits_5x_within_24h' AND timestamp > ? AND prob >= 0.25
      UNION
      SELECT mint_address FROM ml_predictions
      WHERE target = 'peaked_300' AND timestamp > ? AND prob >= 0.20
      UNION
      SELECT mint_address FROM ml_predictions
      WHERE target = 'hits_10x_within_24h' AND timestamp > ? AND prob >= 0.10
    `),
  };
  return stmts;
}

function refresh() {
  try {
    const cutoff = Date.now() - PREDICTION_FRESHNESS_MS;
    const rows = S().convictionPreds.all(cutoff, cutoff, cutoff, cutoff);
    const next = new Set(rows.map(r => r.mint_address));
    // In-place swap so callers always see a coherent set
    _convictionMints.clear();
    for (const m of next) _convictionMints.add(m);
  } catch (err) {
    console.error('[ml-conviction] refresh err:', err.message);
  }
}

export function isMlConvictionMint(mintAddress) {
  return _convictionMints.has(mintAddress);
}

export function getMlConvictionSize() {
  return _convictionMints.size;
}

export function startMlConvictionWatcher() {
  setTimeout(() => {
    refresh();
    setInterval(refresh, CHECK_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log(`[ml-conviction] watcher scheduled · first=+${FIRST_RUN_DELAY_MS / 1000}s · refresh every ${CHECK_INTERVAL_MS / 1000}s · freshness ${PREDICTION_FRESHNESS_MS / 60000}min`);
}
