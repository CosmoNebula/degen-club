// workers/price-verifier.js — Sanity checks that our stored prices for held
// positions match the actual on-chain bonding curve state. Catches any
// decoder drift, stale ingest, or out-of-order trade processing that would
// cause us to trade on phantom prices.
//
// Strategy: every 60s, for each open position, fetch the bonding curve
// account state directly from chain (one-shot getAccountInfo via Helius RPC),
// decode, compare to mints.last_price_sol. Any mint where stored price drifts
// >10% from on-chain reality gets logged + corrected.

import { db } from '../db.js';
import { config } from '../config.js';
import { decodeBondingCurve } from '../ingest/decoders/pumpfun.js';

const TICK_MS = 20_000;
const DRIFT_THRESHOLD_PCT = 10;  // log if our price differs >10% from on-chain
const STALE_THRESHOLD_MS = 180_000;  // also flag mints whose last_trade_at is >3min old

// Derive HTTP URL from the WS URL we already configured.
function rpcHttpUrl() {
  if (config.heliusWs) {
    // wss://mainnet.helius-rpc.com/?api-key=X → https://mainnet.helius-rpc.com/?api-key=X
    return config.heliusWs.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  }
  return 'https://api.mainnet-beta.solana.com';
}

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    openWithCurve: d.prepare(`SELECT pp.id, pp.mint_address, pp.entry_price,
      m.bonding_curve_key, m.last_price_sol AS stored_price,
      m.current_market_cap_sol AS stored_mcap, m.migrated,
      m.last_trade_at
      FROM paper_positions pp
      JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status='open' AND m.bonding_curve_key IS NOT NULL`),
    updatePrice: d.prepare(`UPDATE mints SET
      last_price_sol = ?, current_market_cap_sol = ?,
      v_sol_in_curve = ?, v_tokens_in_curve = ?,
      last_curve_write_at = ?, last_price_source = 'price-verifier'
      WHERE mint_address = ?`),
  };
  return _stmts;
}

const _stats = { checks: 0, drifts: 0, stales: 0, corrections: 0, errors: 0 };

async function fetchAccountInfo(account) {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
    params: [account, { encoding: 'base64', commitment: 'confirmed' }],
  };
  const r = await fetch(rpcHttpUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  const value = j.result?.value;
  if (!value?.data) return null;
  const [encoded, encoding] = Array.isArray(value.data) ? value.data : [value.data, 'base64'];
  if (encoding !== 'base64') return null;
  return encoded;
}

async function verifyOne(p) {
  _stats.checks++;
  // Migrated mints don't have bonding curve state — their prices come from AMM
  // (not our current ingest path). Flag them separately.
  if (p.migrated) {
    const ageMs = Date.now() - (p.last_trade_at || 0);
    if (ageMs > STALE_THRESHOLD_MS) {
      _stats.stales++;
      console.log(`[verify] STALE ${p.mint_address.slice(0,8)}… migrated · stored age ${Math.floor(ageMs/1000)}s · no on-chain check available (AMM)`);
    }
    return;
  }

  let b64;
  try { b64 = await fetchAccountInfo(p.bonding_curve_key); }
  catch (e) { _stats.errors++; return; }
  if (!b64) return;

  const onChain = decodeBondingCurve(b64);
  if (!onChain) { _stats.errors++; return; }

  // 2026-05-27: rSol-based migration detector removed.
  // It was producing false positives — pump.fun mints can have rSol drained
  // (creator rug, MEV, or weird mechanic) without actually migrating to
  // PumpAMM. Real migration happens at a much higher mcap (~$160K).
  // Trust ONLY pumpportal.subscribeMigration events. Drained mints get caught
  // by amm-price-fetcher's dead-AMM detector (liq=$0 + 0 trades → rugged).

  const stored = p.stored_price || 0;
  if (stored <= 0 || onChain.priceSol <= 0) return;

  const driftPct = Math.abs(onChain.priceSol - stored) / onChain.priceSol * 100;
  if (driftPct > DRIFT_THRESHOLD_PCT) {
    _stats.drifts++;
    const ageS = Math.floor((Date.now() - (p.last_trade_at || Date.now())) / 1000);
    console.log(`[verify] DRIFT ${p.mint_address.slice(0,8)}… stored=${(stored*1e9).toFixed(3)}n on-chain=${(onChain.priceSol*1e9).toFixed(3)}n diff=${driftPct.toFixed(1)}% lastTradeAge=${ageS}s · CORRECTING`);
    // Auto-correct: write on-chain values to mints. This both fixes the
    // immediate drift and stops the next iteration from re-flagging.
    try {
      S().updatePrice.run(
        onChain.priceSol,
        onChain.mcapSol,
        onChain.vSol,
        onChain.vTokens,
        Date.now(),
        p.mint_address,
      );
      _stats.corrections++;
    } catch (e) {
      _stats.errors++;
    }
  }
}

let _stmtsReady = false;
async function runOnce() {
  if (!_stmtsReady) { S(); _stmtsReady = true; }
  const opens = S().openWithCurve.all();
  if (opens.length === 0) return;
  // Serial to keep RPC traffic gentle; we have at most ~25 opens.
  for (const p of opens) {
    await verifyOne(p);
  }
}

function maybeReport() {
  const total = _stats.checks;
  if (total === 0) return;
  console.log(`[verify] ${total} checks · ${_stats.drifts} drifts · ${_stats.corrections} corrected · ${_stats.stales} stale-migrated · ${_stats.errors} errors`);
  _stats.checks = 0; _stats.drifts = 0; _stats.corrections = 0; _stats.stales = 0; _stats.errors = 0;
}

export function startPriceVerifier() {
  console.log(`[verify] worker armed · check every ${TICK_MS/1000}s · drift threshold ${DRIFT_THRESHOLD_PCT}% · rpc=${rpcHttpUrl().replace(/api-key=[^&]+/, 'api-key=***')}`);
  let cycleCount = 0;
  setInterval(async () => {
    try {
      await runOnce();
      cycleCount++;
      if (cycleCount % 5 === 0) maybeReport(); // report every ~5 cycles (5 min)
    } catch (e) {
      console.error('[verify] runOnce err:', e.message);
    }
  }, TICK_MS);
}
