// Continuous mint scoring — calls the ML inference service on the most-active
// recent mints every 60s, logs predictions to ml_predictions for the audit
// trail, and powers the "Top Picks" dashboard widget.
//
// Conservative cost: 30 mints/sweep × 60s = 1800/hr ≈ 43K/day predictions.
// Each prediction takes ~100ms → 3-6 seconds of work per sweep, well within
// the 60s interval. ml_predictions table grows ~10MB/day at this rate.

import { db } from '../db/index.js';
import { getAllPredictions, isHealthy } from './ml-client.js';

const SWEEP_INTERVAL_MS = 60 * 1000;
const MINTS_PER_SWEEP = 30;
const MIN_MINT_AGE_SEC = 60;       // give the snapshot sweeper time to capture features first
const MAX_MINT_AGE_SEC = 30 * 60;  // skip mints older than 30min — they're past decision-making

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    candidates: d.prepare(`
      SELECT mint_address, last_trade_at FROM mints
      WHERE migrated = 0 AND rugged = 0
        AND created_at BETWEEN ? AND ?
        AND last_trade_at > ?
      ORDER BY last_trade_at DESC LIMIT ?
    `),
  };
  return stmts;
}

let _running = false;

async function sweep() {
  if (_running) return;            // skip if previous sweep still in flight
  if (!isHealthy()) return;        // service down — no point trying
  _running = true;
  try {
    const now = Date.now();
    const minCreated = now - MAX_MINT_AGE_SEC * 1000;
    const maxCreated = now - MIN_MINT_AGE_SEC * 1000;
    const recentTradeCutoff = now - 5 * 60 * 1000;
    const candidates = S().candidates.all(minCreated, maxCreated, recentTradeCutoff, MINTS_PER_SWEEP);
    if (candidates.length === 0) return;
    let scored = 0;
    for (const m of candidates) {
      try {
        const preds = await getAllPredictions(m.mint_address, 'continuous_sweep');
        if (preds && Object.keys(preds).length > 0) scored++;
      } catch {}
    }
    if (scored > 0) console.log(`[ml-scoring] sweep · ${scored}/${candidates.length} scored across all targets`);
  } finally { _running = false; }
}

export function startScoringSweeper() {
  setTimeout(sweep, 15 * 1000); // initial sweep after 15s warmup
  setInterval(sweep, SWEEP_INTERVAL_MS);
  console.log(`[ml-scoring] sweeper started · interval=60s · batch=${MINTS_PER_SWEEP} mints`);
}
