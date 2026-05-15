// Calibration deep-review — once a day (after sufficient calibration data has
// accumulated), Claude analyzes per-decile calibration accuracy across each
// classification model and tells the agent which probability regions are
// honest vs not. Output is stored and read by the agent on its next
// strategy-proposal cycle, so its threshold choices are informed by where
// the models are actually accurate.

import { db } from '../db/index.js';
import { freeformThought } from './agent-llm.js';
import { canConsult, recordConsult } from './agent-rate-limit.js';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;  // hourly check
// Binary classifiers to compute calibration deciles for. Regression targets
// (peak_pct_max, time_to_peak_sec, drawdown_from_peak_pct, time_to_peak_5x_sec,
// post_mig_peak_pct) are excluded because the decile rollup is a binary-
// outcome rate by design. Add new binary classifiers here when they ship.
// Only targets that have a label column on ml_mint_snapshots (the table this
// query JOINs against). migrates_within_15min / post_mig_* live on different
// tables and need their own calibration query — excluded here to prevent
// "no such column" errors that crashed the bot overnight (2026-05-12).
// 2026-05-15: dropped peaked_100 (redundant with hits_2x_within_1h),
// will_die_fast (majority-class predictor + inverse of alive_at_1h),
// alive_at_4h (0.997 correlation with alive_at_1h). See retrain_all.py
// comments for the full rationale.
const TARGETS = [
  'peaked_30', 'peaked_300', 'migrated',
  'rug_within_5min', 'hits_2x_within_1h',
  // Long-horizon "hold-to-maturity" binary targets (added 2026-05-12).
  // All live on ml_mint_snapshots so they fit the same calibration-query shape.
  'alive_at_1h', 'alive_at_24h',
  'hits_5x_within_24h', 'hits_10x_within_24h',
];

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    lastReview: d.prepare(`SELECT MAX(timestamp) AS ts FROM ml_agent_log
       WHERE level = 'info' AND category = 'calibration-review'`),
    log: d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, message, data_json)
       VALUES (?, 'info', 'calibration-review', ?, ?)`),
  };
  return stmts;
}

// Compute per-target calibration table (10 deciles): predicted vs actual rate.
// LIMIT 50,000 most-recent predictions per target. With 4.88M total
// predictions, the unbounded query was scanning the full prediction × snapshot
// cross product and blocking the event loop for 10+ minutes, freezing the
// bot and tripping the loop watchdog (2026-05-12). 50K samples per decile
// bucket is plenty for stable calibration estimates.
// 2026-05-15: pinned join to snapshot_age_sec=60 so the PK index hits an exact
// row instead of fanning out across 9 ages per mint (was 80s/target × 13 =
// 17min freeze daily). Labels are per-mint, identical across ages once
// resolved; age=60 covers 97.7% of resolved mints.
function calibrationFor(target) {
  const rows = db().prepare(`
    SELECT p.prob, s.${target} AS actual
    FROM (
      SELECT id, mint_address, prob FROM ml_predictions
      WHERE prob IS NOT NULL AND target = ?
      ORDER BY timestamp DESC LIMIT 50000
    ) p
    JOIN ml_mint_snapshots s
      ON s.mint_address = p.mint_address AND s.snapshot_age_sec = 60
    WHERE s.labels_resolved_at IS NOT NULL AND s.${target} IS NOT NULL
  `).all(target);
  if (rows.length < 50) return { target, n: rows.length, deciles: [], usable: false };
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    low: i * 0.1, high: (i + 1) * 0.1, n: 0, n_pos: 0, sum_prob: 0,
  }));
  for (const r of rows) {
    const idx = Math.min(9, Math.floor((r.prob || 0) * 10));
    buckets[idx].n++;
    buckets[idx].sum_prob += r.prob;
    if (r.actual === 1) buckets[idx].n_pos++;
  }
  return {
    target,
    n: rows.length,
    deciles: buckets.map(b => ({
      bucket: `${(b.low * 100).toFixed(0)}-${(b.high * 100).toFixed(0)}%`,
      n: b.n,
      predicted: b.n > 0 ? +(b.sum_prob / b.n).toFixed(3) : null,
      actual: b.n > 0 ? +(b.n_pos / b.n).toFixed(3) : null,
    })),
    usable: true,
  };
}

function buildContext() {
  const summaries = TARGETS.map(t => calibrationFor(t));
  const usable = summaries.filter(s => s.usable);
  if (usable.length === 0) return null;
  const lines = [];
  lines.push('=== CALIBRATION DATA (per target, deciles of predicted probability vs actual rate) ===');
  lines.push('Diagonal = perfect: 30% predicted should mean 30% actual.');
  lines.push('Above diagonal (actual > predicted) = under-confident.');
  lines.push('Below diagonal (actual < predicted) = over-confident.');
  lines.push('');
  for (const s of usable) {
    lines.push(`--- ${s.target} (n=${s.n}) ---`);
    for (const d of s.deciles) {
      if (d.n === 0) continue;
      const gap = d.actual != null && d.predicted != null ? (d.actual - d.predicted).toFixed(3) : '?';
      lines.push(`  bucket=${d.bucket}  n=${d.n}  predicted=${d.predicted}  actual=${d.actual}  Δ=${gap}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are reviewing the per-decile calibration of your own ML models. For each target, identify:

1. Which probability bands are HONEST (predictions match actual rates within 5 percentage points)
2. Which bands are OVER-CONFIDENT (predicted >> actual — would lose money if you trusted them)
3. Which bands are UNDER-CONFIDENT (actual >> predicted — buried opportunity, raise the threshold to find it)

For each target, write 2-3 sentences max. End with a recommended USABLE THRESHOLD — the lowest probability where you'd actually trust the model. Be honest: if a model is broken, say it's broken.

Format your output as plain text per-target, not JSON. The user reads this AND your future-self reads it on the next strategy proposal cycle.`;

async function maybeReview() {
  const s = S();
  const last = s.lastReview.get();
  const lastTs = last?.ts || 0;
  if (Date.now() - lastTs < 22 * 60 * 60 * 1000) return;  // ~daily
  const ctx = buildContext();
  if (!ctx) {
    // No usable calibration data yet — log a passive note (no consult, no cost)
    s.log.run(Date.now(),
      'calibration review skipped — not enough overlap yet',
      JSON.stringify({ reason: 'insufficient_data' }));
    return;
  }
  if (!canConsult('calib-review')) return;
  let analysis;
  try {
    recordConsult('calib-review');
    analysis = await freeformThought(SYSTEM_PROMPT, ctx, 90000);
  } catch (err) {
    console.error('[calib-review] consult failed:', err.message);
    s.log.run(Date.now(), `calibration review failed: ${err.message}`, null);
    return;
  }
  s.log.run(Date.now(),
    `calibration review: ${analysis.slice(0, 100).replace(/\n/g, ' ')}…`,
    JSON.stringify({ analysis, context: ctx }));
  console.log(`[calib-review] complete · stored to agent log`);
}

export function startCalibrationReview() {
  setTimeout(maybeReview, 15 * 60 * 1000);  // first check 15min after boot
  setInterval(maybeReview, CHECK_INTERVAL_MS);
  console.log('[calib-review] scheduled · checks hourly, fires when ~24h passed');
}
