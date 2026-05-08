// Shared Claude consult rate limiter. Every subsystem calls canConsult()
// before firing a Claude call and recordConsult() after a successful one.
// Daily caps are hard ceilings — if we hit them, the subsystem skips with
// a log entry. No money risk (subscription) but prevents runaway loops or
// sudden bursts (e.g. 100 paper positions closing → 100 post-mortems).

import { db } from '../db/index.js';

// Hard daily caps per subsystem. Tune here if needed.
export const DAILY_CAPS = {
  'agent':         12,   // strategy proposals + retirements (combined)
  'post-mortem':    4,   // 6h batch — 1 analysis covers all trades in the window
  'daily-report':   1,   // 1 per day
  'calib-review':   1,   // 1 per day
  'mint-intel':    24,   // 1 per hour batch
};

// Burst caps — max consults per single tick, prevents fan-out within one cycle
export const BURST_CAPS = {
  'agent':         3,
  'post-mortem':   1,    // batch design — one call analyzes all recent trades
  'daily-report':  1,
  'calib-review':  1,
  'mint-intel':    1,
};

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    get: d.prepare(`SELECT count FROM ml_agent_rate_limit WHERE date_key = ? AND subsystem = ?`),
    upsert: d.prepare(`INSERT INTO ml_agent_rate_limit (date_key, subsystem, count) VALUES (?, ?, 1)
       ON CONFLICT(date_key, subsystem) DO UPDATE SET count = count + 1`),
    pruneOld: d.prepare(`DELETE FROM ml_agent_rate_limit WHERE date_key < ?`),
  };
  return stmts;
}

function dayKey() { return new Date().toISOString().slice(0, 10); }

export function canConsult(subsystem) {
  const cap = DAILY_CAPS[subsystem];
  if (cap == null) return true;  // unknown subsystem — don't block
  const row = S().get.get(dayKey(), subsystem);
  return (row?.count || 0) < cap;
}

export function recordConsult(subsystem) {
  S().upsert.run(dayKey(), subsystem);
  // Opportunistic prune: keep only last 7 days
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  S().pruneOld.run(cutoff);
}

export function getRateLimitState() {
  const today = dayKey();
  const out = {};
  for (const [sub, cap] of Object.entries(DAILY_CAPS)) {
    const row = S().get.get(today, sub);
    out[sub] = { used: row?.count || 0, cap, burst_cap: BURST_CAPS[sub] };
  }
  return out;
}
