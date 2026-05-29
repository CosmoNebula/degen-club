// logs-sub.js — Free trade event firehose for pump.fun via Solana RPC logsSubscribe.
//
// How: WebSocket to mainnet-beta, subscribe to logs mentioning pump.fun program.
// Each notification carries the full log array — we scan for "Program data: <b64>"
// lines, decode the Anchor TradeEvent, write to trades table.
//
// No paid services. Public RPC notification stream is free; we just parse the
// program data ourselves. This is option B from the architectural decision.

import WebSocket from 'ws';
import { db } from '../db.js';
import { config } from '../config.js';
import { decodeTradeEvent } from './decoders/pumpfun-events.js';

let _ws = null;
let _reconnectMs = 1000;
let _heartbeat = null;
const _stats = { trades: 0, inserts: 0, dupes: 0, msgs: 0, lastReport: Date.now() };

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    insertTrade: d.prepare(`INSERT OR IGNORE INTO trades
      (signature, mint_address, wallet, is_buy, sol_amount, token_amount,
       price_sol, market_cap_sol, seconds_from_creation, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    mintInfo: d.prepare(`SELECT created_at FROM mints WHERE mint_address = ?`),
    bumpMintTrade: d.prepare(`UPDATE mints
      SET last_trade_at = ?, last_price_sol = ?, current_market_cap_sol = ?,
          peak_market_cap_sol = MAX(peak_market_cap_sol, ?),
          v_sol_in_curve = ?, v_tokens_in_curve = ?, trade_count = trade_count + 1
      WHERE mint_address = ?`),
  };
  return _stmts;
}

// Per-process cache so we don't hit DB for every trade to learn created_at.
// LRU-ish: just cap at 50k entries (the candidates window is much smaller).
const _createdAtCache = new Map();
function getCreatedAt(mint) {
  if (_createdAtCache.has(mint)) return _createdAtCache.get(mint);
  if (_createdAtCache.size > 50000) _createdAtCache.clear();
  const row = S().mintInfo.get(mint);
  const t = row?.created_at ?? null;
  _createdAtCache.set(mint, t);
  return t;
}

// Pump token total supply is 1B with 6 decimals: 1e9 tokens.
const PUMP_TOTAL_SUPPLY = 1_000_000_000;

function mcapSolFromVReserves(vSol, vToken) {
  if (!vSol || !vToken) return 0;
  // price = vSol/vToken; mcap = totalSupply * price
  return PUMP_TOTAL_SUPPLY * (vSol / vToken);
}

function handleNotification(value) {
  const { logs, signature, err } = value;
  if (err) return; // skip failed tx
  if (!Array.isArray(logs)) return;
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    // Anchor emits "Program data: <base64>" for events.
    if (!line.startsWith('Program data: ')) continue;
    const b64 = line.slice(14);
    const ev = decodeTradeEvent(b64);
    if (!ev) continue;
    _stats.trades++;

    // Sanity check — reject pathological values that indicate the discriminator
    // matched a non-TradeEvent log (or program data corruption). Pump.fun trades
    // are at most a few SOL each and timestamps are unix seconds.
    const nowSec = Math.floor(Date.now() / 1000);
    if (ev.solAmount > 1000 || ev.solAmount < 0
        || ev.timestamp < nowSec - 86400 || ev.timestamp > nowSec + 60
        || ev.tokenAmount < 0 || ev.tokenAmount > 1e15) {
      continue;
    }

    const createdAt = getCreatedAt(ev.mint);
    // ev.timestamp is unix seconds (program clock); convert to ms.
    const tsMs = ev.timestamp * 1000;
    const secsFromCreate = createdAt ? Math.max(0, Math.floor((tsMs - createdAt) / 1000)) : null;
    const priceSol = ev.tokenAmount > 0 ? ev.solAmount / ev.tokenAmount : 0;
    // 2026-05-26: switch mcap source from vReserves to trade-implied (price*supply).
    // vReserves in TradeEvent occasionally returned wrong values (suspect rapid
    // trades / out-of-order delivery), causing entries at impossibly low mcaps
    // ($776 entries on a coin that's actually $25K mcap). Trade-implied mcap
    // = solAmount/tokenAmount * 1B-supply is reliable per-trade.
    const mcapSol = priceSol * PUMP_TOTAL_SUPPLY;

    try {
      const r = S().insertTrade.run(
        signature, ev.mint, ev.user, ev.isBuy ? 1 : 0,
        ev.solAmount, ev.tokenAmount, priceSol, mcapSol,
        secsFromCreate, tsMs,
      );
      if (r.changes > 0) {
        _stats.inserts++;
        // Bump the parent mint with fresh state. Cheap update — index covers it.
        if (createdAt != null) {
          S().bumpMintTrade.run(tsMs, priceSol, mcapSol, mcapSol,
            ev.vSolReserves, ev.vTokenReserves, ev.mint);
        }
      } else {
        _stats.dupes++;
      }
    } catch (e) {
      // foreign-key / schema errors get logged once
      if (Math.random() < 0.01) console.error('[logs-sub] insert err:', e.message);
    }
  }
}

function maybeReport() {
  const now = Date.now();
  if (now - _stats.lastReport < 60_000) return;
  const dt = (now - _stats.lastReport) / 1000;
  console.log(`[logs-sub] ${_stats.trades} trades parsed · ${_stats.inserts} new · ${_stats.dupes} dupes · ${_stats.msgs} ws-msgs · ${(_stats.trades / dt).toFixed(1)}/sec`);
  _stats.trades = 0; _stats.inserts = 0; _stats.dupes = 0; _stats.msgs = 0;
  _stats.lastReport = now;
}

function connect() {
  if (_ws) { try { _ws.terminate(); } catch {} _ws = null; }
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
  _ws = new WebSocket(config.solanaRpcWs);

  _ws.on('open', () => {
    _reconnectMs = 1000;
    console.log(`[logs-sub] connected → ${config.solanaRpcWs}, subscribing to ${config.pumpProgram}`);
    _ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [config.pumpProgram] },
        { commitment: 'confirmed' },
      ],
    }));
    // ws-level heartbeat: ping every 25s, force reconnect if no pong in 60s
    let lastPong = Date.now();
    _ws.on('pong', () => { lastPong = Date.now(); });
    _heartbeat = setInterval(() => {
      try {
        if (Date.now() - lastPong > 60000) {
          console.log('[logs-sub] no pong in 60s, forcing reconnect');
          try { _ws.terminate(); } catch {}
          return;
        }
        _ws.ping();
      } catch {}
    }, 25000);
  });

  _ws.on('message', (raw) => {
    _stats.msgs++;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.method === 'logsNotification' && msg.params?.result?.value) {
      handleNotification(msg.params.result.value);
    }
    maybeReport();
  });

  _ws.on('close', (code) => {
    if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
    console.log(`[logs-sub] disconnected (code=${code}), reconnecting in ${_reconnectMs}ms`);
    setTimeout(connect, _reconnectMs);
    _reconnectMs = Math.min(_reconnectMs * 2, 30_000);
  });

  _ws.on('error', (err) => {
    // Most errors fire 'close' too. Just log once.
    console.error('[logs-sub] ws err:', err.message);
  });
}

export function startLogsSub() {
  connect();
}

export function getLogsSubStats() {
  return { ..._stats };
}
