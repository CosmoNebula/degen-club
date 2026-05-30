// workers/exit-tuner.js — closes the learning loop on the EXIT side.
//
// The entry side already self-tunes (threshold-tuner). The exit side did not:
// adaptive tier triggers are derived from predictPeakPct, and that prediction
// drifts — the ML model retrains hourly and peak magnitudes shift with the
// market regime. A stale peak estimate mis-sets every tier: too high and tier 1
// never fires (winners round-trip back down), too low and we clip runners.
//
// This worker keeps PREDICTED peaks aligned with REALIZED peaks by maintaining
// a bounded multiplier. predictPeakPct() multiplies its output by it, so the
// whole adaptive-tier ladder self-corrects.
//
// Signal:  ml_postmortem.actual_peak_pct vs predicted_peak_pct (trailing window)
// Writes:  bot_runtime_settings.peak_calibration_mult
// Read by: src/policy/bot.js predictPeakPct()

import { db } from '../db.js';

const TICK_MS = 15 * 60 * 1000;        // recompute every 15 min
const FIRST_RUN_MS = 60 * 1000;        // first run 1 min after boot
const LOOKBACK_DAYS = 3;               // rolling window
const MIN_TRADES = 40;                 // need a stable sample before moving
const MULT_MIN = 0.4, MULT_MAX = 1.6;  // hard bounds so tiers can never run away
const EMA_ALPHA = 0.3;                 // smoothing per update — slow, not jumpy
const MIN_MOVE = 0.01;                 // ignore sub-1% nudges
const KEY = 'peak_calibration_mult';
// predictPeakPct was recalibrated in commit dfc7a9f (2026-05-29 01:14 UTC).
// Closes before this used the old over-predicting formula; sampling them would
// mis-fit the multiplier. Ignore anything older than the recalibration.
const CALIBRATION_EPOCH = Date.parse('2026-05-29T01:14:00Z');

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    ensureKey: d.prepare(`INSERT OR IGNORE INTO bot_runtime_settings (key, value, reason, updated_at)
      VALUES (?, 1.0, 'init', ?)`),
    get: d.prepare(`SELECT value FROM bot_runtime_settings WHERE key = ?`),
    set: d.prepare(`UPDATE bot_runtime_settings SET value = ?, reason = ?, updated_at = ? WHERE key = ?`),
    sample: d.prepare(`SELECT predicted_peak_pct AS pred, actual_peak_pct AS act
      FROM ml_postmortem
      WHERE closed_at > ?
        AND predicted_peak_pct IS NOT NULL AND predicted_peak_pct > 0
        AND actual_peak_pct IS NOT NULL
      ORDER BY closed_at DESC LIMIT 1000`),
  };
  return _stmts;
}

function tune() {
  const since = Math.max(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000, CALIBRATION_EPOCH);
  const rows = S().sample.all(since);
  if (rows.length < MIN_TRADES) {
    if (Math.random() < 0.1) {
      console.log(`[exit-tuner] only ${rows.length} closes (need ${MIN_TRADES}) — holding mult`);
    }
    return;
  }

  // sumAct / sumPred is the factor by which CURRENT predictions miss reality.
  // Since stored predicted_peak_pct already includes the current multiplier,
  // the ideal new multiplier is cur * (sumAct / sumPred). Sum-ratio (vs a
  // per-trade mean) is dominated by the movers that actually reach the tiers,
  // which is exactly the cohort we care about sizing correctly.
  let sumPred = 0, sumAct = 0;
  for (const r of rows) { sumPred += r.pred; sumAct += Math.max(0, r.act); }
  if (sumPred <= 0) return;

  const cur = S().get.get(KEY)?.value ?? 1.0;
  const ratio = sumAct / sumPred;
  const target = clamp(cur * ratio, MULT_MIN, MULT_MAX);
  const next = clamp(cur + EMA_ALPHA * (target - cur), MULT_MIN, MULT_MAX);

  if (Math.abs(next - cur) < MIN_MOVE) return;

  const reason = `n=${rows.length} · act/pred=${ratio.toFixed(2)} · mult ${cur.toFixed(2)} → ${next.toFixed(2)}`;
  S().set.run(next, reason, Date.now(), KEY);
  console.log(`[exit-tuner] peak mult ${cur.toFixed(2)} → ${next.toFixed(2)}  ·  ${reason}`);
}

export function startExitTuner() {
  try { S().ensureKey.run(KEY, Date.now()); } catch (e) { console.error('[exit-tuner] seed:', e.message); }
  console.log(`[exit-tuner] worker armed · recompute every ${TICK_MS / 60000}min · mult bounds [${MULT_MIN}, ${MULT_MAX}]`);
  setInterval(() => {
    try { tune(); } catch (e) { console.error('[exit-tuner] err:', e.message); }
  }, TICK_MS);
  setTimeout(tune, FIRST_RUN_MS);
}
