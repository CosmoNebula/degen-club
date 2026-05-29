// watchlist.js — Manages the set of mints we actively track via accountSubscribe.
// Currently tracked: held positions (for price updates → hold/sell decisions).
//
// Lifecycle:
//   onPositionOpen(mint, bondingCurveKey)  → subscribe
//   onPositionClose(mint, bondingCurveKey) → unsubscribe

import { subscribeAccount, unsubscribeAccount } from './rpc-sub.js';
import { db } from '../db.js';

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    openPositionsWithCurve: d.prepare(`SELECT pp.mint_address, m.bonding_curve_key
      FROM paper_positions pp
      JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status = 'open' AND m.bonding_curve_key IS NOT NULL`),
    mintByAddress: d.prepare('SELECT bonding_curve_key FROM mints WHERE mint_address = ?'),
  };
  return _stmts;
}

export async function watchMint(mintAddress) {
  const r = S().mintByAddress.get(mintAddress);
  if (!r?.bonding_curve_key) return false;
  await subscribeAccount(r.bonding_curve_key, mintAddress, 'pumpfun-bc');
  return true;
}

export function unwatchMint(mintAddress) {
  const r = S().mintByAddress.get(mintAddress);
  if (!r?.bonding_curve_key) return;
  unsubscribeAccount(r.bonding_curve_key);
}

// On startup, restore watchlist for any positions that are still open
export async function restoreWatchlist() {
  const opens = S().openPositionsWithCurve.all();
  console.log(`[watchlist] restoring ${opens.length} open positions`);
  for (const p of opens) {
    await subscribeAccount(p.bonding_curve_key, p.mint_address, 'pumpfun-bc');
  }
}
