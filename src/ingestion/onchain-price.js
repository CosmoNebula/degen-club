// On-chain price feed via free Solana RPC accountSubscribe.
// For each held mint we sub to its bonding curve PDA; whenever a trade lands,
// the RPC pushes the new state and we decode it for live price + mcap, no
// PumpPortal trade-feed needed.
//
// Free public RPCs handle ~10-30 simultaneous subscriptions per connection.
// Auto-reconnect on disconnect. Subscription set is the union of:
//   - mints with open paper positions
//   - mints we exited within the last POST_EXIT_WATCH_MS (post-exit tracking)

import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { BondingCurveAccount } from 'pumpdotfun-sdk/dist/esm/bondingCurveAccount.js';
import { db } from '../db/index.js';
import { config } from '../config.js';

const RPC_WS = process.env.SOLANA_RPC_WS || 'wss://api.mainnet-beta.solana.com';
const RPC_HTTP = process.env.SOLANA_RPC_HTTP || 'https://api.mainnet-beta.solana.com';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REFRESH_INTERVAL_MS = 30 * 1000;       // re-evaluate which mints to sub every 30s
const POST_EXIT_WATCH_MS = 6 * 60 * 60 * 1000; // keep subscribed 6h after exit

let _ws = null;
let _running = false;
let _reconnectMs = RECONNECT_MIN_MS;
let _nextReqId = 1;
const _subs = new Map();        // mint_address -> { bondingCurveKey, subId, reqId }
const _pendingByReqId = new Map(); // reqId -> { mint, kind: 'sub'|'unsub' }

function lamportsToSol(n) { return Number(n) / 1e9; }

function decodeAndUpdate(mintAddress, accountInfoData) {
  try {
    const buf = Buffer.from(accountInfoData[0], accountInfoData[1] || 'base64');
    const curve = BondingCurveAccount.fromBuffer(buf);
    const mcapSol = lamportsToSol(curve.getMarketCapSOL());
    // priceSol per token: mcap / supply (supply is in microunits — pump.fun tokens have 6 decimals).
    const supplyTokens = Number(curve.tokenTotalSupply) / 1e6;
    const priceSol = supplyTokens > 0 ? mcapSol / supplyTokens : 0;
    db().prepare(`UPDATE mints SET
      current_market_cap_sol = ?,
      last_price_sol = ?,
      last_trade_at = ?
      WHERE mint_address = ?`).run(mcapSol, priceSol, Date.now(), mintAddress);
    // Migrated flag flips when complete=true on curve
    if (curve.complete) {
      db().prepare(`UPDATE mints SET migrated = 1, migrated_at = COALESCE(migrated_at, ?) WHERE mint_address = ? AND migrated = 0`)
        .run(Date.now(), mintAddress);
    }
  } catch (err) {
    console.error('[onchain-price] decode', mintAddress.slice(0, 8), err.message);
  }
}

function send(obj) {
  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(obj));
}

function subscribe(mintAddress, bondingCurveKey) {
  if (_subs.has(mintAddress)) return;
  const reqId = _nextReqId++;
  _subs.set(mintAddress, { bondingCurveKey, subId: null, reqId });
  _pendingByReqId.set(reqId, { mint: mintAddress, kind: 'sub' });
  send({
    jsonrpc: '2.0', id: reqId, method: 'accountSubscribe',
    params: [bondingCurveKey, { encoding: 'base64', commitment: 'processed' }],
  });
}

function unsubscribe(mintAddress) {
  const s = _subs.get(mintAddress);
  if (!s) return;
  if (s.subId != null) {
    const reqId = _nextReqId++;
    _pendingByReqId.set(reqId, { mint: mintAddress, kind: 'unsub' });
    send({ jsonrpc: '2.0', id: reqId, method: 'accountUnsubscribe', params: [s.subId] });
  }
  _subs.delete(mintAddress);
}

// Mints that need a live price feed right now.
function targetMints() {
  const d = db();
  const cutoff = Date.now() - POST_EXIT_WATCH_MS;
  const rows = d.prepare(`
    SELECT DISTINCT m.mint_address, m.bonding_curve_key
    FROM mints m
    WHERE m.bonding_curve_key IS NOT NULL AND m.migrated = 0
      AND (
        m.mint_address IN (SELECT mint_address FROM paper_positions WHERE status = 'open')
        OR m.mint_address IN (
          SELECT mint_address FROM paper_positions
          WHERE status = 'closed' AND exited_at >= ?
        )
      )
  `).all(cutoff);
  return rows;
}

function reconcile() {
  const target = new Map();
  for (const r of targetMints()) target.set(r.mint_address, r.bonding_curve_key);
  // Add new
  for (const [mint, key] of target) {
    if (!_subs.has(mint)) subscribe(mint, key);
  }
  // Drop stale
  for (const mint of [..._subs.keys()]) {
    if (!target.has(mint)) unsubscribe(mint);
  }
}

function connect() {
  if (!_running) return;
  console.log(`[onchain-price] connecting to ${RPC_WS}`);
  _ws = new WebSocket(RPC_WS);

  _ws.on('open', () => {
    console.log('[onchain-price] connected');
    _reconnectMs = RECONNECT_MIN_MS;
    // Re-issue all subs from scratch (subId mappings are connection-scoped)
    const prev = [..._subs.entries()];
    _subs.clear();
    for (const [mint, s] of prev) subscribe(mint, s.bondingCurveKey);
    reconcile();
  });

  _ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // Subscription confirmation: { id, result: <subId> }
    if (msg.id != null && _pendingByReqId.has(msg.id)) {
      const p = _pendingByReqId.get(msg.id);
      _pendingByReqId.delete(msg.id);
      if (p.kind === 'sub' && typeof msg.result === 'number') {
        const s = _subs.get(p.mint);
        if (s) s.subId = msg.result;
      }
      return;
    }
    // Notification: { method:'accountNotification', params:{ subscription, result:{ value:{ data, ... }}}}
    if (msg.method === 'accountNotification') {
      const subId = msg.params?.subscription;
      const data = msg.params?.result?.value?.data;
      if (subId == null || !data) return;
      const mint = [..._subs.entries()].find(([, s]) => s.subId === subId)?.[0];
      if (!mint) return;
      decodeAndUpdate(mint, data);
    }
  });

  _ws.on('close', () => {
    console.log('[onchain-price] disconnected');
    if (_running) setTimeout(connect, _reconnectMs);
    _reconnectMs = Math.min(_reconnectMs * 2, RECONNECT_MAX_MS);
  });

  _ws.on('error', (err) => console.error('[onchain-price] error', err.message));
}

export function startOnchainPriceFeed() {
  if (_running) return;
  _running = true;
  connect();
  setInterval(reconcile, REFRESH_INTERVAL_MS);
  console.log(`[onchain-price] started · ${RPC_WS} · reconcile every ${REFRESH_INTERVAL_MS / 1000}s`);
}

export function stopOnchainPriceFeed() {
  _running = false;
  if (_ws) _ws.close();
  _ws = null;
  _subs.clear();
}

export function _debugState() {
  return { running: _running, subs: _subs.size, ws: _ws?.readyState };
}
