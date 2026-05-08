// Disk Monitor — checks free space periodically. When usage crosses 95%,
// sets a global pause flag. Bot subsystems can read this and stop ingesting
// new mints/trades to avoid a corrupted-DB scenario when disk fills.
//
// Currently surfaced via getIngestionPaused() for processor.js to check.

import { execSync } from 'node:child_process';

const CHECK_INTERVAL_MS = 60 * 1000; // every minute
const PAUSE_THRESHOLD_PCT = 95;
const RESUME_THRESHOLD_PCT = 90; // hysteresis — only resume when comfortably below

let _ingestionPaused = false;
let _diskUsedPct = null;
let _lastCheckAt = 0;

function checkDisk() {
  try {
    // Use df on the home directory volume
    const out = execSync('df -P "$HOME" | tail -1', { encoding: 'utf8' });
    const parts = out.trim().split(/\s+/);
    // Output cols: filesystem 1024-blocks Used Available Capacity Mounted-on
    const capacity = parts[4]; // e.g., "94%"
    const pct = parseInt(capacity, 10);
    if (!isFinite(pct)) return;
    _diskUsedPct = pct;
    _lastCheckAt = Date.now();
    if (!_ingestionPaused && pct >= PAUSE_THRESHOLD_PCT) {
      _ingestionPaused = true;
      console.log(`[disk] 🚨 disk ${pct}% — INGESTION PAUSED to prevent corruption`);
    } else if (_ingestionPaused && pct < RESUME_THRESHOLD_PCT) {
      _ingestionPaused = false;
      console.log(`[disk] ✅ disk ${pct}% — ingestion resumed`);
    } else if (pct >= 90 && pct < PAUSE_THRESHOLD_PCT) {
      // Warn but don't pause yet
      console.log(`[disk] ⚠️ disk ${pct}% — approaching pause threshold (${PAUSE_THRESHOLD_PCT}%)`);
    }
  } catch (err) {
    console.error('[disk] check failed:', err.message);
  }
}

export function getIngestionPaused() { return _ingestionPaused; }
export function getDiskUsedPct() { return _diskUsedPct; }
export function getLastCheckAt() { return _lastCheckAt; }

export function startDiskMonitor() {
  checkDisk(); // immediate
  setInterval(checkDisk, CHECK_INTERVAL_MS);
  console.log('[disk] monitor started · checks=60s · pause_threshold=' + PAUSE_THRESHOLD_PCT + '%');
}
