// workers/position-monitor.js — Keeps paper_positions.unrealized_pnl_sol/pct
// fresh for open positions. V2 originally had this responsibility implicit in
// the policy tick, but the columns were never written; dashboards reading the
// stored fields saw stale 0.0 values even as prices moved. This worker writes
// them every 15s so any consumer (dashboard, exports, analytics) sees the
// truth without having to recompute from `mints.last_price_sol` on the fly.

import { db } from '../db.js';

const TICK_MS = 15_000;

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    openWithPx: d.prepare(`SELECT pp.id, pp.entry_price, pp.entry_sol, pp.tokens_remaining,
      pp.sol_realized_so_far, pp.highest_pct, m.last_price_sol
      FROM paper_positions pp LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status='open' AND m.last_price_sol > 0`),
    upd: d.prepare(`UPDATE paper_positions
      SET unrealized_pnl_sol = ?, unrealized_pnl_pct = ?, highest_pct = ?
      WHERE id = ?`),
  };
  return _stmts;
}

function tick() {
  try {
    const opens = S().openWithPx.all();
    let updated = 0;
    for (const p of opens) {
      const pricePct = (p.last_price_sol / p.entry_price - 1) * 100;
      const tokensValueSol = (p.tokens_remaining || 0) * p.last_price_sol;
      const pnlSol = (p.sol_realized_so_far || 0) + tokensValueSol - p.entry_sol;
      const highest = Math.max(p.highest_pct || 0, pricePct);
      S().upd.run(pnlSol, pricePct, highest, p.id);
      updated++;
    }
    if (updated > 0 && Math.random() < 0.10) {
      // Light periodic confirmation; not every tick to keep logs clean.
      console.log(`[posmon] refreshed ${updated} open positions`);
    }
  } catch (e) {
    console.error('[posmon] tick err:', e.message);
  }
}

export function startPositionMonitor() {
  setInterval(tick, TICK_MS);
  console.log(`[posmon] worker armed · refresh interval ${TICK_MS}ms`);
}
