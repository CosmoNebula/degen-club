import { db } from '../db/index.js';

const STOP_REASONS = new Set(['SL_HIT', 'BREAKEVEN_SL', 'STAGNATED', 'TIME_EXIT', 'MOONBAG_SL', 'MOONBAG_TRAIL', 'MOONBAG_TIME']);
const PROFIT_REASONS = new Set(['TIERED_FULL', 'TP_TRAIL', 'TP_HIT', 'MIGRATED', 'MOONBAG_TARGET']);

export function sweepPostExits() {
  const d = db();
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = d.prepare(`
    SELECT pp.id, pp.exit_price, pp.exited_at, pp.exit_reason,
           pp.post_exit_peak_price,
           m.last_price_sol, m.rugged, m.last_trade_at
    FROM paper_positions pp
    JOIN mints m ON m.mint_address = pp.mint_address
    WHERE pp.status = 'closed' AND pp.exited_at > ?
  `).all(since);

  if (!rows.length) return 0;

  const update = d.prepare(`UPDATE paper_positions SET
    post_exit_peak_price = ?, post_exit_peak_pct = ?,
    post_exit_recheck_at = ?, post_exit_outcome = ?
    WHERE id = ?`);

  const now = Date.now();
  let updated = 0;
  for (const p of rows) {
    if (!p.exit_price || p.exit_price <= 0) continue;
    const observedPeak = Math.max(p.post_exit_peak_price || p.exit_price, p.last_price_sol || 0);
    const peakPct = (observedPeak - p.exit_price) / p.exit_price;
    const minutesSinceExit = (now - p.exited_at) / 60000;

    let outcome;
    if (minutesSinceExit < 30) outcome = 'PENDING';
    else if (p.rugged) outcome = 'CORRECT_EXIT';
    else if (peakPct >= 0.5 && STOP_REASONS.has(p.exit_reason)) outcome = 'EARLY_EXIT';
    else if (peakPct >= 0.3 && PROFIT_REASONS.has(p.exit_reason)) outcome = 'LEFT_MONEY';
    else if (peakPct < 0.1) outcome = 'CORRECT_EXIT';
    else outcome = 'NEUTRAL';

    update.run(observedPeak, peakPct, now, outcome, p.id);
    updated++;
  }
  return updated;
}

export function startPostExitSweep() {
  setTimeout(() => {
    try { sweepPostExits(); } catch (err) { console.error('[post-exit] startup', err.message); }
  }, 30 * 1000);
  setInterval(() => {
    try { sweepPostExits(); } catch (err) { console.error('[post-exit] sweep', err.message); }
  }, 5 * 60 * 1000);
}
