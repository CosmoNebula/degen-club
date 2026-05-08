// Model drift monitor — every successful retrain takes a snapshot of each
// target's metrics into ml/data/metrics_history.jsonl. The dashboard reads
// that history to compare current vs previous and surface alerts when a
// model regresses (regime change, bad data, broken training).
//
// Append-only JSONL keeps the historical trail small and grep-able. Each
// line is one target's metrics from one retrain.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_ROOT = path.resolve(__dirname, '..', '..', 'ml');
const MODELS_DIR = path.join(ML_ROOT, 'models');
const HISTORY_FILE = path.join(ML_ROOT, 'data', 'metrics_history.jsonl');

// Alert thresholds. Tuned for "early data, expect noise" — easy to loosen later.
const T = {
  AUC_ROC_DROP_YELLOW: 0.05,
  AUC_ROC_DROP_RED: 0.10,
  AUC_PR_REL_DROP_YELLOW: 0.30,
  AUC_PR_REL_DROP_RED: 0.50,
  R2_DROP_YELLOW: 0.10,
  R2_DROP_RED: 0.20,
  STALE_HOURS_YELLOW: 3,
  STALE_HOURS_RED: 6,
};

function listModelJsons() {
  if (!fs.existsSync(MODELS_DIR)) return [];
  return fs.readdirSync(MODELS_DIR)
    .filter(f => f.endsWith('.json') && !f.includes('smoke'))
    .map(f => path.join(MODELS_DIR, f));
}

// Snapshot current model metrics → append to history. Called after every
// successful retrain (from auto-retrain.js exit handler).
export function recordMetricsSnapshot() {
  try {
    const now = Date.now();
    const lines = [];
    for (const file of listModelJsons()) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!j?.target || !j?.metrics) continue;
        // Only snapshot if model file is fresher than 5 min — otherwise we'd
        // re-record stale metrics on every cron pass that didn't actually train.
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > 5 * 60 * 1000) continue;
        lines.push(JSON.stringify({
          recorded_at_ms: now,
          model_mtime_ms: stat.mtimeMs,
          target: j.target,
          n_train: j.n_train,
          n_val: j.n_val,
          metrics: j.metrics,
        }));
      } catch {}
    }
    if (lines.length > 0) {
      fs.appendFileSync(HISTORY_FILE, lines.join('\n') + '\n');
      console.log(`[drift] snapshot: recorded ${lines.length} models to history`);
    }
  } catch (err) { console.error('[drift] snapshot failed:', err.message); }
}

function readHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// Group history entries by target, return latest 2 per target so we can diff.
function latestPair(history) {
  const byTarget = {};
  for (const row of history) {
    if (!byTarget[row.target]) byTarget[row.target] = [];
    byTarget[row.target].push(row);
  }
  for (const t of Object.keys(byTarget)) {
    byTarget[t].sort((a, b) => b.recorded_at_ms - a.recorded_at_ms);
    byTarget[t] = byTarget[t].slice(0, 2);  // [current, previous]
  }
  return byTarget;
}

function classifyAlert(target, current, previous) {
  const alerts = [];
  if (!current?.metrics) return alerts;
  const cm = current.metrics;
  const pm = previous?.metrics;
  const isReg = cm.mode === 'regression';

  if (!isReg && pm && pm.auc_roc != null && cm.auc_roc != null) {
    const drop = pm.auc_roc - cm.auc_roc;
    if (drop >= T.AUC_ROC_DROP_RED) alerts.push({ level: 'red', msg: `AUC-ROC dropped ${pm.auc_roc.toFixed(3)} → ${cm.auc_roc.toFixed(3)} (Δ −${drop.toFixed(3)})` });
    else if (drop >= T.AUC_ROC_DROP_YELLOW) alerts.push({ level: 'yellow', msg: `AUC-ROC dropped ${pm.auc_roc.toFixed(3)} → ${cm.auc_roc.toFixed(3)} (Δ −${drop.toFixed(3)})` });
  }
  if (!isReg && pm && pm.auc_pr != null && cm.auc_pr != null && pm.auc_pr > 0) {
    const relDrop = (pm.auc_pr - cm.auc_pr) / pm.auc_pr;
    if (relDrop >= T.AUC_PR_REL_DROP_RED) alerts.push({ level: 'red', msg: `AUC-PR dropped ${(relDrop*100).toFixed(0)}% relative (${pm.auc_pr.toFixed(3)} → ${cm.auc_pr.toFixed(3)})` });
    else if (relDrop >= T.AUC_PR_REL_DROP_YELLOW) alerts.push({ level: 'yellow', msg: `AUC-PR dropped ${(relDrop*100).toFixed(0)}% relative (${pm.auc_pr.toFixed(3)} → ${cm.auc_pr.toFixed(3)})` });
  }
  if (isReg && pm && pm.r2 != null && cm.r2 != null) {
    const drop = pm.r2 - cm.r2;
    if (drop >= T.R2_DROP_RED) alerts.push({ level: 'red', msg: `R² dropped ${pm.r2.toFixed(3)} → ${cm.r2.toFixed(3)} (Δ −${drop.toFixed(3)})` });
    else if (drop >= T.R2_DROP_YELLOW) alerts.push({ level: 'yellow', msg: `R² dropped ${pm.r2.toFixed(3)} → ${cm.r2.toFixed(3)} (Δ −${drop.toFixed(3)})` });
  }
  return alerts;
}

// Returns full health state — per-target current/previous metrics, alerts,
// and freshness. Called by /api/ml/model-health.
export function getModelHealth() {
  const history = readHistory();
  const pairs = latestPair(history);
  const targets = Object.keys(pairs).sort();
  const now = Date.now();

  // Freshness — based on most recent record across ALL targets
  let lastRecordedAt = 0;
  for (const t of targets) {
    if (pairs[t][0]?.recorded_at_ms > lastRecordedAt) lastRecordedAt = pairs[t][0].recorded_at_ms;
  }
  const ageHours = lastRecordedAt > 0 ? (now - lastRecordedAt) / 3600000 : null;
  let freshnessLevel = 'green';
  let freshnessMsg = ageHours == null ? 'no retrains recorded yet' : `last retrain ${ageHours.toFixed(1)}h ago`;
  if (ageHours != null) {
    if (ageHours >= T.STALE_HOURS_RED) freshnessLevel = 'red';
    else if (ageHours >= T.STALE_HOURS_YELLOW) freshnessLevel = 'yellow';
  }

  // Per-target rows
  const rows = targets.map(t => {
    const [current, previous] = pairs[t];
    const cm = current?.metrics || {};
    const pm = previous?.metrics || null;
    const alerts = classifyAlert(t, current, previous);
    let level = 'green';
    if (alerts.some(a => a.level === 'red')) level = 'red';
    else if (alerts.some(a => a.level === 'yellow')) level = 'yellow';
    return {
      target: t,
      mode: cm.mode || (cm.r2 != null ? 'regression' : 'classification'),
      level,
      n_train: current?.n_train,
      previous_n_train: previous?.n_train,
      current: cm,
      previous: pm,
      alerts,
      recorded_at_ms: current?.recorded_at_ms,
    };
  });

  // Overall health = worst single component
  let overall = freshnessLevel;
  for (const r of rows) {
    if (r.level === 'red' || overall === 'red') overall = 'red';
    else if (r.level === 'yellow' || overall === 'yellow') overall = 'yellow';
  }

  return {
    overall,
    freshness: { level: freshnessLevel, message: freshnessMsg, last_retrain_age_hours: ageHours },
    targets: rows,
    history_total: history.length,
    thresholds: T,
  };
}

// One-time backfill: if metrics_history.jsonl is empty, seed it with the
// current model JSONs so the user has a baseline to compare against.
export function ensureBaseline() {
  if (fs.existsSync(HISTORY_FILE) && fs.statSync(HISTORY_FILE).size > 0) return;
  console.log('[drift] no history found — seeding baseline from current models');
  const lines = [];
  for (const file of listModelJsons()) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j?.target || !j?.metrics) continue;
      const stat = fs.statSync(file);
      lines.push(JSON.stringify({
        recorded_at_ms: stat.mtimeMs,  // pretend we recorded at file mtime
        model_mtime_ms: stat.mtimeMs,
        target: j.target,
        n_train: j.n_train,
        n_val: j.n_val,
        metrics: j.metrics,
        seeded: true,
      }));
    } catch {}
  }
  if (lines.length > 0) {
    fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');
    console.log(`[drift] seeded ${lines.length} baselines`);
  }
}
