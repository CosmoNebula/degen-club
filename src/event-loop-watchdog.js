// Event-loop watchdog. Every 2s, schedules a setTimeout(0) and measures how
// long it actually took to fire vs requested. If the bot is healthy, the gap
// is <50ms. If something is monopolizing the loop (stuck SQL query, heavy
// compute, GC pause, etc.), the gap balloons.
//
// 2026-05-11 incident: dashboard hung at 16% CPU; bot's RPC probes recorded
// 44.7s wall-clock latencies because Node couldn't fire their abort timers.
// This watchdog would have caught that condition and force-restarted launchd
// to recover.
//
// Sustained-lag policy: 3 consecutive checks with lag > 5s triggers a
// process.exit(1). launchd respawns automatically (ThrottleInterval=30s
// gives a clean restart window).

const CHECK_INTERVAL_MS = 2000;
// Bumped from 5s → 30s thresh, 3 → 8 consecutive. Bot was getting killed
// during legitimate heavy startup work (snapshot sweeps, agent context
// builds) which then triggered a death loop. Better to log lag but keep
// running unless truly catastrophic.
const LAG_THRESHOLD_MS = 30000;
const CONSECUTIVE_BAD = 8;
const HISTORY_SIZE = 60;  // ~2 min rolling history for diagnostics

const _lagHistory = [];
let _consecutiveBad = 0;
let _lastCheckAt = 0;

function check() {
  const scheduled = Date.now();
  setTimeout(() => {
    const actual = Date.now();
    const lag = actual - scheduled;
    _lagHistory.push({ t: actual, lag });
    if (_lagHistory.length > HISTORY_SIZE) _lagHistory.shift();
    if (lag > LAG_THRESHOLD_MS) {
      _consecutiveBad++;
      console.warn(`[loop-watchdog] event loop lag ${lag}ms (#${_consecutiveBad} in a row, threshold ${LAG_THRESHOLD_MS}ms)`);
      if (_consecutiveBad >= CONSECUTIVE_BAD) {
        console.error(`[loop-watchdog] FATAL — event loop starved ${CONSECUTIVE_BAD} consecutive checks. Forcing process exit so launchd respawns.`);
        // Flush stderr by giving Node 100ms then bailing.
        setTimeout(() => process.exit(1), 100);
        return;
      }
    } else {
      if (_consecutiveBad > 0) {
        console.log(`[loop-watchdog] recovered — lag back to ${lag}ms after ${_consecutiveBad} bad check(s)`);
      }
      _consecutiveBad = 0;
    }
    _lastCheckAt = actual;
  }, 0);
}

export function startEventLoopWatchdog() {
  setInterval(check, CHECK_INTERVAL_MS);
  console.log(`[loop-watchdog] started · checks every ${CHECK_INTERVAL_MS/1000}s · threshold ${LAG_THRESHOLD_MS/1000}s · restart after ${CONSECUTIVE_BAD} consecutive bad`);
}

// Optional getter for the dashboard.
export function getLoopLagState() {
  const recent = _lagHistory.slice(-15);
  const p50 = recent.length > 0 ? recent.map(r => r.lag).sort((a,b)=>a-b)[Math.floor(recent.length/2)] : 0;
  const max = recent.length > 0 ? Math.max(...recent.map(r => r.lag)) : 0;
  return {
    last_check_at: _lastCheckAt,
    consecutive_bad: _consecutiveBad,
    p50_ms_last_15: p50,
    max_ms_last_15: max,
    threshold_ms: LAG_THRESHOLD_MS,
  };
}
