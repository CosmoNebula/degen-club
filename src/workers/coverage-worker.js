// workers/coverage-worker.js — Scores every snapshot-having mint that doesn't
// have a fresh prediction. Fires predict-mint calls in PARALLEL batches of 4
// against the multi-worker ML service. Goal: 100% scoring coverage for any
// mint with a snapshot, instead of the policy bot's narrow candidate-loop
// sample.
//
// Rate: scans every 10s. Skips mints that already have a prediction <5min old.
// Skips low-activity mints (< 20 trades) per the operator's coverage filter.

import { db } from '../db.js';
import { predictMint } from '../ml/client.js';

const SCAN_MS = 30_000;          // scan every 10s
const FRESHNESS_MS = 5 * 60_000; // skip if predicted in last 5 min
const BATCH_SIZE = 3;            // parallel calls per batch (matches uvicorn workers)
const MAX_PER_SCAN = 24;         // cap per scan so we don't queue 1000s
const MIN_TRADE_COUNT = 20;      // operator-set: skip thinly-traded mints

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    needsScoring: d.prepare(`SELECT DISTINCT s.mint_address
      FROM ml_mint_snapshots s
      JOIN mints m ON m.mint_address = s.mint_address
      WHERE m.created_at > strftime('%s','now')*1000 - 1800000
        AND m.rugged = 0
        AND m.trade_count >= ?
        AND NOT EXISTS (
          SELECT 1 FROM ml_predictions p
          WHERE p.mint_address = s.mint_address
            AND p.timestamp > strftime('%s','now')*1000 - ?
        )
      ORDER BY s.snapshot_ts DESC
      LIMIT ?`),
  };
  return _stmts;
}

const _stats = { scans: 0, scored: 0, batches: 0, lastReport: Date.now() };

async function scoreBatch(mints) {
  // Fire all in parallel — ML service has 4 uvicorn workers so they execute
  // concurrently. Each call writes its predictions via client.js persistPredictions.
  await Promise.all(mints.map(async (mint) => {
    try {
      await predictMint(mint);
      _stats.scored++;
    } catch {}
  }));
  _stats.batches++;
}

async function runOnce() {
  try {
    const mints = S().needsScoring.all(MIN_TRADE_COUNT, FRESHNESS_MS, MAX_PER_SCAN).map((r) => r.mint_address);
    if (mints.length === 0) return;
    // Process in BATCH_SIZE-parallel chunks
    for (let i = 0; i < mints.length; i += BATCH_SIZE) {
      const batch = mints.slice(i, i + BATCH_SIZE);
      await scoreBatch(batch);
    }
    _stats.scans++;
  } catch (e) {
    console.error('[coverage] err:', e.message);
  }
}

function maybeReport() {
  const now = Date.now();
  if (now - _stats.lastReport < 60_000) return;
  const dt = (now - _stats.lastReport) / 1000;
  console.log(`[coverage] ${_stats.scored} mints scored · ${_stats.batches} batches · ${_stats.scans} scans · ${(_stats.scored / dt).toFixed(1)}/sec`);
  _stats.scored = 0; _stats.batches = 0; _stats.scans = 0; _stats.lastReport = now;
}

export function startCoverageWorker() {
  console.log(`[coverage] worker armed · scan every ${SCAN_MS/1000}s · ${BATCH_SIZE}-parallel · min_trades=${MIN_TRADE_COUNT}`);
  setInterval(async () => {
    await runOnce();
    maybeReport();
  }, SCAN_MS);
}
