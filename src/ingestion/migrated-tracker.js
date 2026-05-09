// Post-migration mint tracker via DexScreener.
//
// Pump.fun's PumpSwap data feed went paid 2026-05. Subscribing to the program
// for free TradeEvents stopped working. DexScreener still indexes all PumpSwap
// + Raydium pools with full price/liquidity/volume data for free, just on a
// poll cadence (not real-time).
//
// This module polls all migrated mints in their first 72h post-migration. That
// 72h window is where most post-migration action happens — runs, dumps, second
// pumps. After 72h, mints are usually settled (long-tail trends become slow).
//
// What we capture per mint per poll:
//   - current_market_cap_sol (real, not stale bonding-curve value)
//   - last_price_sol (real)
//   - peak_market_cap_sol (MAX, captures post-mig pumps)
//   - amm_liquidity_usd (key for friction model — Raydium has different slippage)
//   - amm_volume_h1_usd / h24 (activity signal)
//   - amm_buys_h24 / sells_h24 (buy pressure)
//   - amm_price_change_h1 / h24 (momentum)
//   - amm_pool_address (for downstream tools)

import { db } from '../db/index.js';
import { getSolUsd } from '../price.js';

const TICK_INTERVAL_MS = 60 * 1000;             // every 60s — poll a fresh batch
const FIRST_RUN_DELAY_MS = 90 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MIGRATED_WINDOW_HOURS = 72;
const BATCH_SIZE = 30;                           // poll N mints per tick
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;       // re-poll same mint every 5min

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    candidates: d.prepare(`
      SELECT mint_address FROM mints
      WHERE migrated = 1
        AND migrated_at > strftime('%s','now')*1000 - ? * 3600000
        AND (last_amm_refresh_at IS NULL OR last_amm_refresh_at < strftime('%s','now')*1000 - ?)
      ORDER BY COALESCE(last_amm_refresh_at, 0) ASC
      LIMIT ?
    `),
    update: d.prepare(`UPDATE mints SET
      current_market_cap_sol = ?,
      last_price_sol = ?,
      peak_market_cap_sol = MAX(peak_market_cap_sol, ?),
      amm_pool_address = COALESCE(?, amm_pool_address),
      amm_dex = COALESCE(?, amm_dex),
      amm_liquidity_usd = ?,
      amm_volume_h1_usd = ?,
      amm_volume_h24_usd = ?,
      amm_buys_h24 = ?,
      amm_sells_h24 = ?,
      amm_price_change_h1 = ?,
      amm_price_change_h24 = ?,
      last_amm_refresh_at = ?
      WHERE mint_address = ?`),
    markRefreshed: d.prepare(`UPDATE mints SET last_amm_refresh_at = ? WHERE mint_address = ?`),
  };
  return stmts;
}

async function fetchPool(mintAddress) {
  const url = `https://api.dexscreener.com/tokens/v1/solana/${mintAddress}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'degen-club-mig/0.1' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;
    // Pick the highest-liquidity pool
    return data.reduce((best, p) =>
      (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? p : best, data[0]);
  } catch { return null; }
}

async function pollOne(mintAddress) {
  const pool = await fetchPool(mintAddress);
  if (!pool) {
    // Mark refreshed even on miss so we don't hammer DexScreener
    S().markRefreshed.run(Date.now(), mintAddress);
    return false;
  }
  const priceNative = parseFloat(pool.priceNative) || 0;
  const fdvUsd = pool.fdv || 0;
  const solUsd = getSolUsd() || 1;
  const mcapSol = solUsd > 0 ? fdvUsd / solUsd : 0;
  // Sanity: don't accept obviously broken values
  if (priceNative <= 0 || mcapSol <= 0) {
    S().markRefreshed.run(Date.now(), mintAddress);
    return false;
  }
  S().update.run(
    mcapSol, priceNative, mcapSol,
    pool.pairAddress || null,
    pool.dexId || null,
    pool.liquidity?.usd || 0,
    pool.volume?.h1 || 0,
    pool.volume?.h24 || 0,
    pool.txns?.h24?.buys || 0,
    pool.txns?.h24?.sells || 0,
    pool.priceChange?.h1 || 0,
    pool.priceChange?.h24 || 0,
    Date.now(),
    mintAddress,
  );
  return true;
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    const cands = S().candidates.all(MIGRATED_WINDOW_HOURS, REFRESH_INTERVAL_MS, BATCH_SIZE);
    if (cands.length === 0) return;
    let updated = 0;
    let dexId = '';
    for (const c of cands) {
      try {
        const ok = await pollOne(c.mint_address);
        if (ok) updated++;
      } catch (err) { /* swallow */ }
    }
    if (updated > 0) {
      console.log(`[mig-tracker] refreshed ${updated}/${cands.length} migrated mints in 72h window`);
    }
  } finally { _running = false; }
}

export function startMigratedTracker() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log(`[mig-tracker] scheduled · DexScreener poll · batch=${BATCH_SIZE} every 60s · refresh interval=${REFRESH_INTERVAL_MS / 1000}s · window=${MIGRATED_WINDOW_HOURS}h`);
}
