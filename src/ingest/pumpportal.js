// pumpportal.js — Free WS firehose from PumpPortal.
// subscribeNewToken: every new pump.fun launch (FREE)
// subscribeMigration: every bonding-curve → AMM migration (FREE)
//
// What we capture per new token:
//   mint_address, creator_wallet, signature, name, symbol, uri,
//   bonding_curve_key, vSolInBondingCurve, vTokensInBondingCurve, marketCapSol,
//   initial_buy_sol (creator's deploy buy), created_at

import WebSocket from 'ws';
import { db } from '../db.js';
import { config } from '../config.js';
import { pumpfunBondingCurvePda } from './decoders/pda.js';

let _ws = null;
let _reconnectTimer = null;
const _stats = { newToken: 0, migration: 0, errors: 0, lastEventAt: 0 };

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    upsertMint: d.prepare(`INSERT OR IGNORE INTO mints
      (mint_address, creator_wallet, signature, name, symbol, uri,
       initial_buy_sol, v_sol_in_curve, v_tokens_in_curve,
       current_market_cap_sol, peak_market_cap_sol, last_price_sol,
       last_trade_at, created_at, bonding_curve_key, pool)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pump')`),
    markMigrated: d.prepare(`UPDATE mints SET migrated = 1, migrated_at = ?, pool = 'pumpamm' WHERE mint_address = ?`),
  };
  return _stmts;
}

function bumpStat(field) {
  _stats[field] = (_stats[field] || 0) + 1;
  _stats.lastEventAt = Date.now();
}

function handleNewToken(msg) {
  if (!msg.mint || !msg.traderPublicKey) return;
  try {
    const now = Date.now();
    const vSol = msg.vSolInBondingCurve || 0;
    const vTokens = msg.vTokensInBondingCurve || 0;
    const priceSol = (vSol > 0 && vTokens > 0) ? vSol / vTokens : 0;
    const mcapSol = msg.marketCapSol || 0;
    S().upsertMint.run(
      msg.mint,
      msg.traderPublicKey,
      msg.signature || null,
      msg.name || null,
      msg.symbol || null,
      msg.uri || null,
      msg.solAmount || msg.initialBuy || 0,
      vSol,
      vTokens,
      mcapSol,
      mcapSol,
      priceSol,
      now,
      now,
      (function() {
        try {
          return pumpfunBondingCurvePda(msg.mint, config.pumpProgram).address;
        } catch {
          return msg.bondingCurveKey || null;
        }
      })(),
    );
    bumpStat('newToken');
  } catch (err) {
    console.error('[pp] newToken err:', err.message);
    bumpStat('errors');
  }
}

function handleMigration(msg) {
  if (!msg.mint) return;
  try {
    S().markMigrated.run(Date.now(), msg.mint);
    bumpStat('migration');
  } catch (err) {
    console.error('[pp] migration err:', err.message);
    bumpStat('errors');
  }
}

function connect() {
  console.log('[pp] connecting to PumpPortal…');
  _ws = new WebSocket(config.pumpportalWs);

  _ws.on('open', () => {
    console.log('[pp] WS open · subscribing to free streams');
    _ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    _ws.send(JSON.stringify({ method: 'subscribeMigration' }));
  });

  _ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.txType === 'create' || (msg.mint && msg.bondingCurveKey && (msg.name || msg.symbol))) {
      handleNewToken(msg);
    } else if (msg.txType === 'migrate' || msg.txType === 'migration') {
      handleMigration(msg);
    } else if (msg.message) {
      console.log('[pp] info:', msg.message);
    }
  });

  _ws.on('error', (err) => {
    console.error('[pp] WS error:', err.message);
    bumpStat('errors');
  });

  _ws.on('close', (code) => {
    console.warn(`[pp] WS closed code=${code} — reconnecting in 5s`);
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(connect, 5000);
  });
}

function startHeartbeat() {
  setInterval(() => {
    const age = _stats.lastEventAt ? Math.round((Date.now() - _stats.lastEventAt) / 1000) : '∞';
    console.log(`[pp] heartbeat · newToken=${_stats.newToken} migration=${_stats.migration} err=${_stats.errors} last=${age}s`);
  }, 30000);
}

export function startPumpPortal() {
  connect();
  startHeartbeat();
  console.log('[pp] started · FREE streams (newToken + migration)');
}

export function getPumpPortalStats() { return { ..._stats }; }
