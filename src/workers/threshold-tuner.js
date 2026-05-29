// workers/threshold-tuner.js — Continuously tunes config.policy.entryScoreThreshold
// from rolling post-mortem data.
//
// Strategy:
//   1. If bot has been idle (no new entries) for N+ hours, loosen the threshold
//      proportionally. Paper-trading is about LEARNING — locking the bot out of
//      the market because of a bad window is the opposite of useful.
//   2. Otherwise, bucket recent closes by entry_score, compute EV/trade per
//      bucket, and pick the lowest +EV threshold.
//   3. If NO bucket is +EV (bad market window), step up gradually — not a
//      panic-jump to ceiling. Slow climb so we keep gathering data.
//
// Reads:  ml_postmortem (closes with entry_score + realized_pnl_pct)
//         paper_positions (last open time, for idle detection)
// Writes: bot_runtime_settings.entry_score_threshold

import { db } from '../db.js';

const TICK_MS = 5 * 60 * 1000;          // recompute every 5 min
const MIN_CLOSES_FOR_TUNE = 25;          // need at least this many closes for EV tuning
const LOOKBACK_DAYS = 7;                 // rolling window for EV computation
const MIN_BUCKET_SAMPLES = 5;            // require this many samples per score bucket
const FLOOR_THRESHOLD = 0.05;            // never go below this
const CEILING_THRESHOLD = 0.40;          // never go above this
const BUCKET_STEP = 0.025;               // tuner adjustment granularity
// Prevent runaway tightening: require this many NEW closes between threshold
// moves. Without this, the tuner climbs every 5min on the same losing data.
const MIN_NEW_CLOSES_BETWEEN_MOVES = 5;

// Idle-loosen: if bot opens nothing for IDLE_LOOSEN_HRS, drop threshold by
// BUCKET_STEP per multiple of that interval. Stops the lock-out failure mode
// where high threshold → no entries → no closes → no new EV data → stuck.
const IDLE_LOOSEN_HRS = 1;
const IDLE_LOOSEN_MS = IDLE_LOOSEN_HRS * 60 * 60 * 1000;

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    recentCloses: d.prepare(`SELECT entry_score, realized_pnl_pct
      FROM ml_postmortem
      WHERE closed_at > ?
        AND entry_score IS NOT NULL
        AND realized_pnl_pct IS NOT NULL
      ORDER BY closed_at DESC LIMIT 500`),
    lastOpen: d.prepare(`SELECT MAX(entered_at) AS t FROM paper_positions`),
    currentThreshold: d.prepare(`SELECT value FROM bot_runtime_settings WHERE key = 'entry_score_threshold'`),
    updateThreshold: d.prepare(`UPDATE bot_runtime_settings
      SET value = ?, reason = ?, updated_at = ?
      WHERE key = 'entry_score_threshold'`),
  };
  return _stmts;
}

// Tracks closes_count at the time of the last move so we can enforce
// MIN_NEW_CLOSES_BETWEEN_MOVES on subsequent tightening steps.
let _lastMoveClosesTotal = 0;
// Tracks when we last fired an idle-loosen — prevents the loosen from running
// every tick within the same idle window.
let _lastIdleLoosenAt = 0;

function applyChange(newThresh, cur, reason) {
  if (Math.abs(newThresh - cur) < 0.005) return false;
  const direction = newThresh > cur ? 'tightened' : 'loosened';
  const fullReason = `${reason} · ${direction} ${cur.toFixed(3)} → ${newThresh.toFixed(3)}`;
  S().updateThreshold.run(newThresh, fullReason, Date.now());
  console.log(`[tuner] threshold ${cur.toFixed(3)} → ${newThresh.toFixed(3)}  ·  ${fullReason}`);
  return true;
}

function tune() {
  const cur = S().currentThreshold.get()?.value ?? FLOOR_THRESHOLD;

  // ---- 1. IDLE-LOOSEN guard ----
  // If the bot hasn't opened a position in IDLE_LOOSEN_HRS+, drop the threshold.
  // Two-cadence design:
  //  - First-time fire: drop proportionally to ALL accumulated idle time (handles
  //    the 20hr-stuck scenario — unsticks immediately).
  //  - Subsequent fires: only loosen if it's been ≥IDLE_LOOSEN_MS since the LAST
  //    loosen (prevents double-loosen on the every-5min tick).
  // Reset _lastIdleLoosenAt to 0 whenever a new position opens (cheap diff via
  // comparing lastOpen to a tracked previous value).
  const lastOpen = S().lastOpen.get()?.t || 0;
  const idleMs = Date.now() - lastOpen;
  if (idleMs > IDLE_LOOSEN_MS && cur > FLOOR_THRESHOLD) {
    const now = Date.now();
    const timeSinceLastLoosen = _lastIdleLoosenAt ? (now - _lastIdleLoosenAt) : Infinity;
    if (timeSinceLastLoosen >= IDLE_LOOSEN_MS) {
      const hoursIdle = idleMs / (60 * 60 * 1000);
      // First loosen of this idle window: proportional. Subsequent: 1 step.
      const stepsToTake = _lastIdleLoosenAt ? 1 : Math.floor(idleMs / IDLE_LOOSEN_MS);
      const proposed = Math.max(FLOOR_THRESHOLD, cur - stepsToTake * BUCKET_STEP);
      const reason = `idle ${hoursIdle.toFixed(1)}h · no entries · loosening ${stepsToTake} step${stepsToTake === 1 ? '' : 's'} to resume trading`;
      if (applyChange(proposed, cur, reason)) {
        _lastIdleLoosenAt = now;
        return;
      }
    } else {
      // Throttled — still idle but cooldown hasn't elapsed.
      if (Math.random() < 0.1) {
        const minsToNext = ((IDLE_LOOSEN_MS - timeSinceLastLoosen) / 60_000).toFixed(0);
        console.log(`[tuner] idle ${(idleMs/3600000).toFixed(1)}h but loosened ${(timeSinceLastLoosen/60000).toFixed(0)}min ago · next loosen in ${minsToNext}min`);
      }
    }
  } else if (idleMs < IDLE_LOOSEN_MS) {
    // Bot is actively trading again — reset the idle-loosen tracker.
    _lastIdleLoosenAt = 0;
  }

  // ---- 2. EV-based tuning ----
  const since = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const closes = S().recentCloses.all(since);
  if (closes.length < MIN_CLOSES_FOR_TUNE) {
    if (Math.random() < 0.1) {
      console.log(`[tuner] only ${closes.length} closes (need ${MIN_CLOSES_FOR_TUNE}) — keeping ${cur.toFixed(3)}`);
    }
    return;
  }

  // Bucket by score in BUCKET_STEP-wide bins from FLOOR to CEILING
  const buckets = [];
  for (let b = FLOOR_THRESHOLD; b < CEILING_THRESHOLD; b += BUCKET_STEP) {
    buckets.push({ floor: b, sum: 0, n: 0 });
  }
  for (const c of closes) {
    for (const b of buckets) {
      if (c.entry_score >= b.floor) { b.sum += c.realized_pnl_pct; b.n++; }
    }
  }

  // Lowest +EV bucket with healthy sample size
  let bestThreshold = null;
  let bestEV = -Infinity;
  for (const b of buckets) {
    if (b.n < MIN_BUCKET_SAMPLES) continue;
    const ev = b.sum / b.n;
    if (ev > 0 && bestThreshold === null) { bestThreshold = b.floor; bestEV = ev; }
    if (ev > bestEV) bestEV = ev;
  }

  // ---- 3. Soft-tighten when nothing is +EV ----
  // Old behavior: snap to ceiling on first sign of bad EV. That created the
  // lockout. New behavior: step up by ONE bucket per N new closes — so the
  // tuner waits for fresh evidence rather than climbing every 5min on stale
  // data. Combined with the idle-loosen above this stays self-correcting.
  if (bestThreshold === null) {
    const newCloses = closes.length - _lastMoveClosesTotal;
    if (newCloses < MIN_NEW_CLOSES_BETWEEN_MOVES) {
      if (Math.random() < 0.1) {
        console.log(`[tuner] no +EV bucket but only ${newCloses} new closes since last move (need ${MIN_NEW_CLOSES_BETWEEN_MOVES}) — holding ${cur.toFixed(3)}`);
      }
      return;
    }
    bestThreshold = Math.min(CEILING_THRESHOLD, cur + BUCKET_STEP);
    const reason = `${closes.length} closes (${newCloses} new) · no +EV bucket · soft-step up ${BUCKET_STEP}`;
    if (applyChange(bestThreshold, cur, reason)) _lastMoveClosesTotal = closes.length;
    return;
  }

  bestThreshold = Math.max(FLOOR_THRESHOLD, Math.min(CEILING_THRESHOLD, bestThreshold));
  const reason = `${closes.length} closes · bestEV=${bestEV.toFixed(2)}%/trade`;
  if (applyChange(bestThreshold, cur, reason)) _lastMoveClosesTotal = closes.length;
}

export function startThresholdTuner() {
  console.log(`[tuner] worker armed · recompute every ${TICK_MS/60000}min · idle-loosen at ${IDLE_LOOSEN_HRS}h+ idle · floor=${FLOOR_THRESHOLD} ceil=${CEILING_THRESHOLD}`);
  // Seed _lastMoveClosesTotal from current count so a fresh restart doesn't
  // count all existing closes as "new" and bypass the cooldown.
  try {
    const since = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const seedCount = S().recentCloses.all(since).length;
    _lastMoveClosesTotal = seedCount;
  } catch {}
  setInterval(() => {
    try { tune(); }
    catch (e) { console.error('[tuner] err:', e.message); }
  }, TICK_MS);
  setTimeout(tune, 30000);  // first run 30s after boot
}
