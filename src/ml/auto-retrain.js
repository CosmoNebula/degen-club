// Auto-retrain cron — runs the Python retrain_all.py script every N hours
// to keep the model current as data accumulates. retrain_all.py is idempotent
// (skips early if no new data) so running it often is safe.
//
// First run is offset 30 minutes after boot so initial collection has time
// to land. Subsequent runs every 6 hours.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { recordMetricsSnapshot, ensureBaseline } from './drift-monitor.js';
import { db } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_ROOT = path.resolve(__dirname, '..', '..', 'ml');
const PYTHON = path.join(ML_ROOT, '.venv', 'bin', 'python');
const SCRIPT = path.join(ML_ROOT, 'scripts', 'retrain_all.py');
const LAST_TRAIN_META = path.join(ML_ROOT, 'data', '.last_train_meta.json');

const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;   // 15 min after boot
// 2026-05-18: bumped 1h → 3h after OOM kill at 06:27 UTC. CPU isn't the
// bottleneck — MEMORY is. retrain_all.py holds 3.2 GB parent while spawning
// train.py children at 2.8 GB each, peaking ~6 GB. On an 8 GB box that
// leaves <2 GB for the bot, OOMing under any feature-collector spike.
// 3h still captures regime shifts within a half-trading-day. Long-term fix
// is chunked feature loading in retrain_all.py.
const REPEAT_INTERVAL_MS = 3 * 60 * 60 * 1000;

// Adaptive trigger (added 2026-05-11): check every 5min for either
// (a) NEW_LABELS > N since last retrain AND last retrain ≥ 30min ago, or
// (b) realized PnL drawdown ≥ DD_THRESHOLD over last 24h.
// Either condition fires an immediate retrain (no waiting for the next hour).
const ADAPTIVE_CHECK_MS = 5 * 60 * 1000;
const MIN_NEW_LABELS = 50;
const MIN_MINUTES_SINCE_LAST = 30;
// 2026-05-18: -2.0 → -5.0 to stop adaptive retrains firing during normal
// strategy-tuning sessions (V7.x bleed is hitting -2 routinely without rugs).
const DD_THRESHOLD_SOL = -5.0; // closed PnL ≤ -5.0 SOL in last 24h triggers
const DD_THRESHOLD_PCT = -0.15; // OR ≥15% drawdown vs starting balance

let _running = false;

// Live progress for the dashboard. Stages: idle | extract | train | reload | done | failed.
const _progress = {
  running: false,
  stage: 'idle',
  currentTarget: null,
  completedTargets: [],
  startedAt: null,
  finishedAt: null,
  durationSec: null,
  exitCode: null,
};

function resetProgress() {
  _progress.running = false;
  _progress.stage = 'idle';
  _progress.currentTarget = null;
  _progress.completedTargets = [];
  _progress.startedAt = null;
  _progress.finishedAt = null;
  _progress.durationSec = null;
  _progress.exitCode = null;
}

// Parse retrain_all.py stdout to update progress. We watch for the
// `=== EXTRACT ===`, `=== TRAIN <target> ===`, and `[retrain] done` markers.
function updateProgressFromLine(line) {
  // EXTRACT phase
  if (line.includes('=== EXTRACT ===')) {
    _progress.stage = 'extract';
    _progress.currentTarget = null;
    return;
  }
  // TRAIN phase — line looks like: [retrain] === TRAIN peaked_30 (...) ===
  const trainMatch = line.match(/===\s*TRAIN\s+(\S+)/);
  if (trainMatch) {
    if (_progress.currentTarget && !_progress.completedTargets.includes(_progress.currentTarget)) {
      _progress.completedTargets.push(_progress.currentTarget);
    }
    _progress.stage = 'train';
    _progress.currentTarget = trainMatch[1];
    return;
  }
  // RELOAD phase
  if (line.includes('serve.py reload:')) {
    if (_progress.currentTarget && !_progress.completedTargets.includes(_progress.currentTarget)) {
      _progress.completedTargets.push(_progress.currentTarget);
    }
    _progress.stage = 'reload';
    _progress.currentTarget = null;
    return;
  }
  // skip case — `[retrain] only N new rows since last train — skipping`
  if (line.includes('skipping')) {
    _progress.stage = 'skipped';
  }
}

async function runRetrain() {
  if (_running) {
    console.log('[auto-retrain] previous run still in progress — skipping');
    return;
  }
  // Kill switch — touch data/.retrain-paused to disable retrains globally.
  try {
    if (fs.existsSync(path.resolve(ML_ROOT, '..', 'data', '.retrain-paused'))) {
      console.log('[auto-retrain] paused via data/.retrain-paused — skipping');
      return;
    }
  } catch {}
  // 2026-05-18: memory guard. retrain_all.py + train.py peak at 6 GB combined.
  // On 8 GB box, free < 4 GB during retrain = OOM kill the bot. Skip the run
  // if not enough headroom; will fire again on next aligned slot.
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    const availMb = availMatch ? Math.floor(parseInt(availMatch[1]) / 1024) : 0;
    if (availMb > 0 && availMb < 4000) {
      console.warn(`[auto-retrain] memory pressure (${availMb} MB free) — deferring retrain`);
      return;
    }
  } catch {}
  _running = true;
  const start = Date.now();
  resetProgress();
  _progress.running = true;
  _progress.stage = 'extract';
  _progress.startedAt = start;
  // 2026-05-12 v2: switched from snapshot-then-train → read-only WAL access.
  // Python scripts now open the live DB with file:...?mode=ro&uri=True. In WAL
  // mode, read-only connections get a consistent point-in-time snapshot at
  // transaction start AND don't block the bot's writers. Zero copy, zero disk
  // churn, retrain starts ~60s faster. The 1.8GB-backup-every-hour was an
  // overcautious response to a freeze that turned out to be caused by the
  // bot's own calibration query (since fixed with LIMIT 50K), not by Python.
  const livePath = path.resolve(ML_ROOT, '..', 'data', 'degen.db');
  console.log('[auto-retrain] kicking off retrain pipeline (read-only WAL, zero-copy)...');
  // Cap Python/sklearn thread parallelism to 2 cores. Without this, sklearn
  // + permutation_importance default to ALL cores → load avg spikes to 60+
  // on Intel Mac and the Node event loop starves, pushing RPC probes from
  // 200ms into 4s+ (verified 2026-05-11). 2 threads keeps training fast
  // enough (~15 min full retrain) while leaving the bot responsive.
  //
  // 2026-05-13: prefixed launch with `nice -n 10` + `ionice -c 3` (idle I/O class)
  // so the retrain is preempted whenever the bot needs CPU or disk. Previously
  // we did `renice` AFTER spawning — there was a brief race window where the
  // first ~100ms of Python work ran at default priority and could spike load.
  // Idle ionice means retrain only does disk I/O when nothing else competes;
  // SQLite contention drops materially.
  const proc = spawn('nice', ['-n', '10', 'ionice', '-c', '3', PYTHON, SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OMP_NUM_THREADS: '2',
      OPENBLAS_NUM_THREADS: '2',
      MKL_NUM_THREADS: '2',
      NUMEXPR_NUM_THREADS: '2',
      DEGEN_DB_PATH: livePath,
    },
  });
  let stdoutBuf = '';
  proc.stdout.on('data', d => {
    const s = d.toString();
    process.stdout.write('[retrain] ' + s);
    stdoutBuf += s;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      try { updateProgressFromLine(line); } catch {}
    }
  });
  proc.stderr.on('data', d => process.stderr.write('[retrain] ' + d.toString()));
  proc.on('exit', (code) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (code === 0) console.log(`[auto-retrain] complete in ${elapsed}s`);
    else console.error(`[auto-retrain] FAILED (exit ${code}) in ${elapsed}s`);
    if (_progress.currentTarget && !_progress.completedTargets.includes(_progress.currentTarget)) {
      _progress.completedTargets.push(_progress.currentTarget);
    }
    _progress.running = false;
    _progress.stage = code === 0 ? (_progress.stage === 'skipped' ? 'skipped' : 'done') : 'failed';
    _progress.currentTarget = null;
    _progress.finishedAt = Date.now();
    _progress.durationSec = parseFloat(elapsed);
    _progress.exitCode = code;
    _running = false;
    // Record metrics snapshot for drift monitor (only if real retrain, not a skip)
    if (code === 0 && _progress.stage === 'done') {
      try { recordMetricsSnapshot(); } catch (err) { console.error('[drift] snapshot err:', err.message); }
    }
  });
}

export function getRetrainProgress() {
  return { ..._progress };
}

// Read last retrain timestamp from the meta JSON. Returns 0 if missing.
function getLastRetrainTs() {
  try {
    const j = JSON.parse(fs.readFileSync(LAST_TRAIN_META, 'utf8'));
    return j.trained_at_ms || 0;
  } catch { return 0; }
}

// Count labels resolved (or backfilled with new targets) since the last
// retrain. Uses labels_resolved_at as the "new label" timestamp — this is
// the moment a snapshot became trainable.
function countNewLabelsSince(tsMs) {
  if (!tsMs) return 0;
  try {
    const row = db().prepare(
      `SELECT COUNT(*) AS n FROM ml_mint_snapshots WHERE labels_resolved_at > ?`
    ).get(tsMs);
    return row?.n || 0;
  } catch { return 0; }
}

// Compute realized-PnL drawdown signal over last 24h. Returns the closed
// PnL sum AND the % drawdown vs paper-wallet starting balance.
function recentDrawdown() {
  try {
    const w = db().prepare(`SELECT starting_balance_sol FROM paper_wallet WHERE id=1`).get();
    const startSol = w?.starting_balance_sol || 1.0;
    const r = db().prepare(`
      SELECT COALESCE(SUM(realized_pnl_sol), 0) AS pnl
      FROM paper_positions
      WHERE status='closed' AND exited_at > strftime('%s','now')*1000 - 86400000
    `).get();
    const pnl = r?.pnl || 0;
    const pct = startSol > 0 ? pnl / startSol : 0;
    return { pnl, pct, startSol };
  } catch { return { pnl: 0, pct: 0, startSol: 0 }; }
}

// Decide whether the adaptive trigger should fire NOW. Logs the reason on
// any positive decision so the user can see why a retrain happened.
function adaptiveShouldRetrain() {
  if (_running) return false;
  const lastTs = getLastRetrainTs();
  const minutesSinceLast = lastTs > 0 ? (Date.now() - lastTs) / 60000 : Infinity;
  if (minutesSinceLast < MIN_MINUTES_SINCE_LAST) return false;
  const newLabels = countNewLabelsSince(lastTs);
  if (newLabels >= MIN_NEW_LABELS) {
    console.log(`[auto-retrain] ADAPTIVE: ${newLabels} new labels since last retrain ${minutesSinceLast.toFixed(0)}min ago — firing.`);
    return true;
  }
  const dd = recentDrawdown();
  if (dd.pnl <= DD_THRESHOLD_SOL || dd.pct <= DD_THRESHOLD_PCT) {
    console.log(`[auto-retrain] ADAPTIVE: 24h drawdown ${dd.pnl.toFixed(2)} SOL (${(dd.pct*100).toFixed(1)}%) — firing.`);
    return true;
  }
  return false;
}

function adaptiveTick() {
  try {
    if (adaptiveShouldRetrain()) runRetrain();
  } catch (err) {
    console.error('[auto-retrain] adaptive check err:', err.message);
  }
}

// 2026-05-13 PM: every-hour wall-clock-aligned schedule (was even hours / 2h
// cadence on the 2-CPU box). 4-CPU resize means retrain doesn't preempt the
// trading loop, so we retrain every hour at HH:00 ET. Bot restarts no longer
// trigger retrains; we just wait for the next aligned hour.
// TZ is set via systemd Environment=TZ=America/New_York so "wall clock" = ET.
function nextAlignedRetrainAt(fromMs = Date.now()) {
  const d = new Date(fromMs);
  const target = new Date(d);
  // 2026-05-18: was every top-of-hour. Bumped to every 3 hours to reduce
  // OOM risk on the 8 GB box. Fires at 00, 03, 06, 09, 12, 15, 18, 21 ET.
  // 3h still captures regime shifts within half a trading day.
  const next3hHour = Math.floor(d.getHours() / 3) * 3 + 3;
  if (next3hHour >= 24) {
    target.setDate(d.getDate() + 1);
    target.setHours(next3hHour - 24, 0, 0, 0);
  } else {
    target.setHours(next3hHour, 0, 0, 0);
  }
  return target;
}

function scheduleNextRetrain() {
  const target = nextAlignedRetrainAt();
  const delayMs = target.getTime() - Date.now();
  const localStr = target.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  console.log(`[auto-retrain] next retrain at ${localStr} ET (in ${(delayMs / 60000).toFixed(1)} min)`);
  setTimeout(() => {
    runRetrain();
    scheduleNextRetrain();  // chain to the next aligned slot regardless of how long this run takes
  }, delayMs);
}

export function startAutoRetrain() {
  ensureBaseline();  // seed metrics history from current models if empty
  scheduleNextRetrain();
  // Adaptive trigger DISABLED per user request — was firing too frequently
  // (30-60 min cadence) and redundant with the fixed schedule.
  // setInterval(adaptiveTick, ADAPTIVE_CHECK_MS);
  console.log(`[auto-retrain] scheduled · wall-clock 1h slots (every HH:00 ET) · NO retrain-on-restart · adaptive disabled`);
}

// Manual trigger via API (useful for "retrain now" button)
export function triggerRetrainNow() {
  if (_running) return { ok: false, reason: 'already_running' };
  runRetrain();
  return { ok: true };
}
