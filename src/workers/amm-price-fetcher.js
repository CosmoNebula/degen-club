// workers/amm-price-fetcher.js — Pulls post-migration prices for held mints
// from DexScreener. Pump.fun migrations land on PumpAMM (and sometimes
// Raydium/Orca downstream); DexScreener indexes all of them with a simple
// REST endpoint. Free, no auth, ~300 req/min rate limit (well within our
// volume — we only poll held migrated positions, typically < 10 at a time).
//
// Endpoint: https://api.dexscreener.com/latest/dex/tokens/<mint>
// Returns: { pairs: [{ priceNative, priceUsd, liquidity, volume, txns, ... }] }
//
// We pick the pair with highest liquidity (usually the PumpAMM SOL pair).

import { db } from '../db.js';

const TICK_MS = 60_000;          // poll every 60s
const BATCH_PARALLEL = 3;        // gentle on DexScreener (300 req/min limit)
const STALE_BUMP_THRESHOLD = 60; // if pair shows trade in last 60s, bump our last_trade_at

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    migratedHolds: d.prepare(`SELECT DISTINCT m.mint_address
      FROM paper_positions pp
      JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status='open' AND m.migrated = 1`),
    updateAmmPrice: d.prepare(`UPDATE mints SET
      last_price_sol = ?, current_market_cap_sol = ?,
      peak_market_cap_sol = MAX(peak_market_cap_sol, ?),
      last_trade_at = COALESCE(?, last_trade_at),
      last_price_source = 'dexscreener',
      last_curve_write_at = ?
      WHERE mint_address = ?`),
  };
  return _stmts;
}

const _stats = { polls: 0, updates: 0, errors: 0, no_pair: 0, lastReport: Date.now() };

async function fetchPrice(mint) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
    signal: AbortSignal.timeout(6000),
    headers: { 'User-Agent': 'degen-club-v2' },
  });
  if (!r.ok) throw new Error(`http ${r.status}`);
  const j = await r.json();
  const pairs = j?.pairs || [];
  if (pairs.length === 0) return null;
  // Pick the pair with highest USD liquidity. Usually the PumpAMM-SOL pair.
  let best = null;
  for (const p of pairs) {
    const liq = p.liquidity?.usd || 0;
    if (!best || liq > (best.liquidity?.usd || 0)) best = p;
  }
  return best;
}

async function updateOne(mint) {
  _stats.polls++;
  let pair;
  try { pair = await fetchPrice(mint); }
  catch (e) { _stats.errors++; if (Math.random() < 0.5) console.error("[amm-price] fetch err for", mint.slice(0,10), "-", e.message); return; }
  if (!pair) { _stats.no_pair++; return; }

  // priceNative is the SOL price per token (when chainId='solana' and quote=SOL).
  const priceSol = parseFloat(pair.priceNative) || 0;
  if (priceSol <= 0) return;

  // pump.fun supply is 1B tokens; mcap = price × supply
  const mcapSol = priceSol * 1_000_000_000;

  // Determine if there's been recent activity. txns.m5 = {buys, sells}.
  const m5 = (pair.txns?.m5?.buys || 0) + (pair.txns?.m5?.sells || 0);
  const hasRecentTrade = m5 > 0;
  const now = Date.now();

  S().updateAmmPrice.run(
    priceSol,
    mcapSol,
    mcapSol,
    hasRecentTrade ? now : null,  // 2026-05-27: only bump if real AMM trades — else MIGRATED_NO_TRACKING can never fire
    now,
    mint,
  );
  _stats.updates++;
}

async function runOnce() {
  const mints = S().migratedHolds.all().map((r) => r.mint_address);
  if (mints.length === 0) return;
  // Parallel batches of BATCH_PARALLEL
  for (let i = 0; i < mints.length; i += BATCH_PARALLEL) {
    const batch = mints.slice(i, i + BATCH_PARALLEL);
    await Promise.all(batch.map(updateOne));
  }
}

function maybeReport() {
  const now = Date.now();
  if (now - _stats.lastReport < 5 * 60_000) return;
  if (_stats.polls === 0) { _stats.lastReport = now; return; }
  console.log(`[amm-price] ${_stats.updates} updates · ${_stats.no_pair} no-pair · ${_stats.errors} errors · over ${_stats.polls} polls`);
  _stats.polls = 0; _stats.updates = 0; _stats.errors = 0; _stats.no_pair = 0;
  _stats.lastReport = now;
}

export function startAmmPriceFetcher() {
  console.log(`[amm-price] worker armed · DexScreener poll every ${TICK_MS/1000}s for migrated holds`);
  setInterval(async () => {
    try { await runOnce(); maybeReport(); }
    catch (e) { console.error('[amm-price] err:', e.message); }
  }, TICK_MS);
}
