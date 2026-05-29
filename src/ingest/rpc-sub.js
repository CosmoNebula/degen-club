// rpc-sub.js — Solana RPC WebSocket connection for accountSubscribe.
// Uses public Solana RPC (free) by default. accountSubscribe notifications
// are free on standard Solana RPC nodes. We only pay for the initial subscribe
// call on metered providers (1 credit), but on public RPC even that is free.
//
// Subscribed accounts: bonding curve PDAs for held positions.
// On state change: decode → emit trade-like event → update mints.last_price_sol.

import WebSocket from 'ws';
import { config } from '../config.js';
import { decodeBondingCurve } from './decoders/pumpfun.js';
import { db } from '../db.js';

let _ws = null;
let _reconnectTimer = null;
let _ready = false;
let _nextId = 1;
const _pending = new Map();       // jsonrpc id → { account, kind, resolve, reject }
const _activeSubs = new Map();    // subscription_id → { account, mint, kind }
const _byAccount = new Map();     // account → subscription_id
const _stats = { connected: false, subs: 0, notifications: 0, decodeFails: 0, errors: 0, reconnects: 0 };

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    updatePrice: d.prepare(`UPDATE mints SET
      last_price_sol = ?, v_sol_in_curve = ?, v_tokens_in_curve = ?,
      current_market_cap_sol = ?,
      peak_market_cap_sol = MAX(peak_market_cap_sol, ?),
      last_trade_at = ?, last_curve_write_at = ?, last_price_source = 'rpc-sub'
      WHERE bonding_curve_key = ?`),
  };
  return _stmts;
}

function connect() {
  // Prefer Helius WS for accountSubscribe — standard WS methods are free,
  // and public mainnet-beta is unreliable (we saw 10 subs / 0 notifications).
  const wsUrl = config.heliusWs || config.solanaRpcWs;
  console.log(`[rpc-sub] connecting to ${wsUrl.replace(/api-key=[^&]+/, 'api-key=***')}`);
  _ws = new WebSocket(wsUrl);
  _ws.on('open', () => {
    _ready = true;
    _stats.connected = true;
    console.log('[rpc-sub] WS open · resubscribing to', _byAccount.size, 'accounts');
    // Resubscribe everything on reconnect. CRITICAL: capture the
    // account→info mapping BEFORE clearing, so we don't lose mint metadata.
    const oldMapping = new Map();
    for (const [subId, info] of _activeSubs.entries()) {
      oldMapping.set(info.account, info);
    }
    _byAccount.clear();
    _activeSubs.clear();
    for (const [account, info] of oldMapping.entries()) {
      subscribeAccount(account, info?.mint, info?.kind || 'pumpfun-bc');
    }
  });

  _ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // Subscription response: { jsonrpc, result: <sub_id>, id }
    if (msg.id && _pending.has(msg.id)) {
      const p = _pending.get(msg.id);
      _pending.delete(msg.id);
      if (msg.result !== undefined && msg.result !== null) {
        _activeSubs.set(msg.result, { account: p.account, mint: p.mint, kind: p.kind });
        _byAccount.set(p.account, msg.result);
        _stats.subs = _activeSubs.size;
        p.resolve?.(msg.result);
      } else if (msg.error) {
        _stats.errors++;
        console.error('[rpc-sub] subscribe error for', p.account, msg.error);
        p.reject?.(new Error(msg.error.message));
      }
      return;
    }
    // Notification: { method: 'accountNotification', params: { subscription, result: { value: { data: [base64, 'base64'], lamports, owner, ... }, context: { slot } } } }
    if (msg.method === 'accountNotification') {
      _stats.notifications++;
      const subId = msg.params?.subscription;
      const info = _activeSubs.get(subId);
      if (!info) return;
      const value = msg.params?.result?.value;
      if (!value?.data) return;
      const [encoded, encoding] = Array.isArray(value.data) ? value.data : [value.data, 'base64'];
      if (encoding !== 'base64') return;
      handleAccountUpdate(info, encoded);
    }
  });

  _ws.on('error', (err) => {
    console.error('[rpc-sub] WS error:', err.message);
    _stats.errors++;
  });

  _ws.on('close', (code) => {
    _ready = false;
    _stats.connected = false;
    _stats.reconnects++;
    console.warn(`[rpc-sub] WS closed code=${code} — reconnecting in 5s`);
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(connect, 5000);
  });
}

function handleAccountUpdate(info, base64) {
  if (info.kind === 'pumpfun-bc') {
    const decoded = decodeBondingCurve(base64);
    if (!decoded) { _stats.decodeFails++; return; }
    try {
      S().updatePrice.run(
        decoded.priceSol,
        decoded.vSol,
        decoded.vTokens,
        decoded.mcapSol,
        decoded.mcapSol,
        Date.now(),
        Date.now(),
        info.account,
      );
    } catch (err) {
      console.error('[rpc-sub] db update err:', err.message);
      _stats.errors++;
    }
  }
}

// Public API
export async function subscribeAccount(account, mint, kind = 'pumpfun-bc') {
  if (!_ready) {
    // Queue: when WS opens, _byAccount will be replayed
    _byAccount.set(account, null);
    return null;
  }
  if (_byAccount.has(account)) return _byAccount.get(account);
  const id = _nextId++;
  return new Promise((resolve, reject) => {
    _pending.set(id, { account, mint, kind, resolve, reject });
    _ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'accountSubscribe',
      params: [account, { encoding: 'base64', commitment: 'confirmed' }],
    }));
  });
}

export function unsubscribeAccount(account) {
  const subId = _byAccount.get(account);
  if (!subId || !_ready) return;
  const id = _nextId++;
  _ws.send(JSON.stringify({
    jsonrpc: '2.0', id, method: 'accountUnsubscribe', params: [subId],
  }));
  _byAccount.delete(account);
  _activeSubs.delete(subId);
  _stats.subs = _activeSubs.size;
}

export function startRpcSub() {
  connect();
  setInterval(() => {
    console.log(`[rpc-sub] heartbeat · subs=${_stats.subs} notifs=${_stats.notifications} decodeFails=${_stats.decodeFails} err=${_stats.errors} reconnects=${_stats.reconnects}`);
  }, 30000);
}

export function getRpcSubStats() { return { ..._stats }; }
