// Watchdog for the Python serve.py inference service. If it dies (process
// gone or HTTP unreachable for >2min), spawn a fresh one. The Python service
// is the one critical-path component that has no auto-restart — bot is under
// launchd's KeepAlive, dashboard is auto-respawned by the bot, but serve.py
// is started manually.

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML_ROOT = path.resolve(__dirname, '..', '..', 'ml');
const PYTHON = path.join(ML_ROOT, '.venv', 'bin', 'python');
const SCRIPT = path.join(ML_ROOT, 'scripts', 'serve.py');
const LOG_PATH = '/tmp/serve.log';
const SERVE_URL = 'http://127.0.0.1:5050/health';

const CHECK_INTERVAL_MS = 30 * 1000;          // probe every 30s
const UNHEALTHY_RESTART_AFTER_MS = 2 * 60 * 1000;  // restart after 2min of failures
const RESTART_COOLDOWN_MS = 60 * 1000;        // don't try to restart more than 1/min

let _firstFailureAt = 0;
let _lastRestartAt = 0;

function isServeRunning() {
  try {
    const out = execSync(`pgrep -f "scripts/serve.py" 2>/dev/null || true`, { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch { return false; }
}

async function probeHealth() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(SERVE_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const j = await r.json();
    return j?.ok === true;
  } catch { return false; }
}

function spawnServe() {
  const fd = fs.openSync(LOG_PATH, 'a');
  const proc = spawn(PYTHON, [SCRIPT], {
    cwd: ML_ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  proc.unref();
  console.log(`[serve-watchdog] spawned new serve.py · pid=${proc.pid}`);
}

async function tick() {
  const running = isServeRunning();
  const healthy = running ? await probeHealth() : false;
  const now = Date.now();

  if (healthy) {
    if (_firstFailureAt > 0) {
      console.log('[serve-watchdog] recovered — health restored');
      _firstFailureAt = 0;
    }
    return;
  }

  // Unhealthy. Track first time it failed.
  if (_firstFailureAt === 0) {
    _firstFailureAt = now;
    console.log(`[serve-watchdog] serve unhealthy · running=${running}`);
    return;
  }

  // Has it been unhealthy long enough to restart?
  if (now - _firstFailureAt < UNHEALTHY_RESTART_AFTER_MS) return;
  // Cooldown — don't churn
  if (now - _lastRestartAt < RESTART_COOLDOWN_MS) return;

  _lastRestartAt = now;
  console.log(`[serve-watchdog] unhealthy for ${Math.round((now - _firstFailureAt) / 1000)}s — restarting`);
  // Kill any lingering process first
  try { execSync(`pkill -f "scripts/serve.py" 2>/dev/null || true`); } catch {}
  // Wait a moment for the port to release
  await new Promise(r => setTimeout(r, 2000));
  spawnServe();
  _firstFailureAt = 0;
}

export function startServeWatchdog() {
  setTimeout(tick, 60 * 1000);  // first check 60s after boot
  setInterval(() => tick().catch(err => console.error('[serve-watchdog] tick err:', err.message)), CHECK_INTERVAL_MS);
  console.log(`[serve-watchdog] started · probes every 30s · auto-restart after 2min unhealthy`);
}
