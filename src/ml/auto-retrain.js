// Auto-retrain cron — runs the Python retrain_all.py script every N hours
// to keep the model current as data accumulates. retrain_all.py is idempotent
// (skips early if no new data) so running it often is safe.
//
// First run is offset 30 minutes after boot so initial collection has time
// to land. Subsequent runs every 6 hours.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordMetricsSnapshot, ensureBaseline } from './drift-monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_ROOT = path.resolve(__dirname, '..', '..', 'ml');
const PYTHON = path.join(ML_ROOT, '.venv', 'bin', 'python');
const SCRIPT = path.join(ML_ROOT, 'scripts', 'retrain_all.py');

const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;   // 15 min after boot
const REPEAT_INTERVAL_MS = 60 * 60 * 1000;   // every hour

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

function runRetrain() {
  if (_running) {
    console.log('[auto-retrain] previous run still in progress — skipping');
    return;
  }
  _running = true;
  const start = Date.now();
  resetProgress();
  _progress.running = true;
  _progress.stage = 'extract';
  _progress.startedAt = start;
  console.log('[auto-retrain] kicking off retrain pipeline...');
  const proc = spawn(PYTHON, [SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
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

export function startAutoRetrain() {
  ensureBaseline();  // seed metrics history from current models if empty
  setTimeout(runRetrain, FIRST_RUN_DELAY_MS);
  setInterval(runRetrain, REPEAT_INTERVAL_MS);
  console.log(`[auto-retrain] scheduled · first=+15min · interval=1h`);
}

// Manual trigger via API (useful for "retrain now" button)
export function triggerRetrainNow() {
  if (_running) return { ok: false, reason: 'already_running' };
  runRetrain();
  return { ok: true };
}
