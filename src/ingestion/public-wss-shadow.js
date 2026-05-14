// public-wss-shadow — free Solana mainnet WSS running PARALLEL to Helius WSS
// for held positions. Helius accountSubscribe is reliable but not infallible;
// stalls have cost us money (UNDER-RECORDED peaks on running coins, exits at
// stale prices). The public Solana RPC endpoint is rate-limited and flaky for
// general queries but accountSubscribe is push-based and free.
//
// Strategy: mirror every subscribe the primary onchain-price (BC) and
// onchain-amm (pump-amm pool vaults) clients make. Both streams write to the
// same mints row — MAX() handles peak dedup, last_price_sol = latest-write
// is fine because both sources are reserve-derived (same truth). Whichever
// stream is faster on a given account wins that update; over time both
// catch most updates and a stall on one is hidden by the other.
//
// Cost: $0. Risk: noisier DB writes, but writes are cheap and idempotent.

import WebSocket from 'ws';
import { BondingCurveAccount } from 'pumpdotfun-sdk/dist/esm/bondingCurveAccount.js';
import { db } from '../db/index.js';

const PUBLIC_WS_URL = process.env.PUBLIC_WS_URL || 'wss://api.mainnet-beta.solana.com';
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

const BASE_DECIMALS = 6;
const QUOTE_DECIMALS = 9;
const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000;
const SPL_AMOUNT_OFFSET = 64;
const PRICE_FLOOR_SOL = 1e-9;

let _ws = null;
let _running = false;
let _reconnectMs = RECONNECT_MIN_MS;
let _nextReqId = 700000;

// BC: mint -> { bondingCurveKey, subId }
const _bcSubs = new Map();
// AMM: mint -> { baseVault, quoteVault, baseSubId, quoteSubId, baseAmount, quoteAmount }
const _ammSubs = new Map();
// pending subscribe requests waiting for confirmation
const _pending = new Map();   // reqId -> { kind, mint, role?, pubkey }
// subId -> { kind, mint, role? }
const _subIdToSlot = new Map();

function send(obj) {
  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(obj));
}

function sendAccountSubscribe(kind, mint, pubkey, role) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  const id = ++_nextReqId;
  _pending.set(id, { kind, mint, pubkey, role });
  _ws.send(JSON.stringify({
    jsonrpc: '2.0', id, method: 'accountSubscribe',
    params: [pubkey, { encoding: 'base64', commitment: 'processed' }],
  }));
}

function sendAccountUnsubscribe(subId) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN || subId == null) return;
  _ws.send(JSON.stringify({
    jsonrpc: '2.0', id: ++_nextReqId, method: 'accountUnsubscribe', params: [subId],
  }));
}

function decodeBcAndWrite(mint, b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const curve = BondingCurveAccount.fromBuffer(buf);
    if (curve.complete) return; // migrated — let AMM shadow handle
    const mcapSol = Number(curve.getMarketCapSOL()) / 1e9;
    const supplyTokens = Number(curve.tokenTotalSupply) / 1e6;
    const priceSol = supplyTokens > 0 ? mcapSol / supplyTokens : 0;
    if (priceSol < PRICE_FLOOR_SOL) return;
    const now = Date.now();
    db().prepare(`UPDATE mints SET
      current_market_cap_sol = ?,
      last_price_sol = ?,
      peak_market_cap_sol = MAX(peak_market_cap_sol, ?),
      last_trade_at = ?,
      last_price_source = 'shadow-curve',
      last_price_source_at = ?,
      last_curve_write_at = ?
      WHERE mint_address = ?`).run(mcapSol, priceSol, mcapSol, now, now, now, mint);
  } catch { /* malformed buffer, ignore */ }
}

function decodeSplAmount(buf) {
  if (!buf || buf.length < SPL_AMOUNT_OFFSET + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[SPL_AMOUNT_OFFSET + i]);
  return v;
}

function maybeWriteAmm(mint) {
  const s = _ammSubs.get(mint);
  if (!s || s.baseAmount == null || s.quoteAmount == null) return;
  const baseTokens = Number(s.baseAmount) / 10 ** BASE_DECIMALS;
  const quoteSol = Number(s.quoteAmount) / 10 ** QUOTE_DECIMALS;
  if (baseTokens <= 0) return;
  const priceSol = quoteSol / baseTokens;
  if (!isFinite(priceSol) || priceSol < PRICE_FLOOR_SOL) return;
  const mcapSol = priceSol * PUMP_FUN_TOTAL_SUPPLY;
  const now = Date.now();
  db().prepare(`UPDATE mints SET
    current_market_cap_sol = ?,
    last_price_sol = ?,
    peak_market_cap_sol = MAX(peak_market_cap_sol, ?),
    last_trade_at = ?,
    last_price_source = 'shadow-amm',
    last_price_source_at = ?,
    last_curve_write_at = ?
    WHERE mint_address = ?`).run(mcapSol, priceSol, mcapSol, now, now, now, mint);
}

function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  // Subscribe confirmation
  if (msg.id && _pending.has(msg.id)) {
    const p = _pending.get(msg.id);
    _pending.delete(msg.id);
    if (typeof msg.result === 'number') {
      _subIdToSlot.set(msg.result, { kind: p.kind, mint: p.mint, role: p.role });
      if (p.kind === 'bc') {
        const sub = _bcSubs.get(p.mint);
        if (sub) sub.subId = msg.result;
      } else if (p.kind === 'amm') {
        const sub = _ammSubs.get(p.mint);
        if (sub) {
          if (p.role === 'base') sub.baseSubId = msg.result;
          else sub.quoteSubId = msg.result;
        }
      }
    }
    return;
  }
  if (msg.method !== 'accountNotification') return;
  const subId = msg.params?.subscription;
  const slot = _subIdToSlot.get(subId);
  if (!slot) return;
  const b64 = msg.params?.result?.value?.data?.[0];
  if (!b64) return;
  if (slot.kind === 'bc') {
    decodeBcAndWrite(slot.mint, b64);
  } else if (slot.kind === 'amm') {
    const buf = Buffer.from(b64, 'base64');
    const amount = decodeSplAmount(buf);
    if (amount == null) return;
    const s = _ammSubs.get(slot.mint);
    if (!s) return;
    if (slot.role === 'base') s.baseAmount = amount;
    else s.quoteAmount = amount;
    maybeWriteAmm(slot.mint);
  }
}

function connect() {
  if (!_running) return;
  _ws = new WebSocket(PUBLIC_WS_URL);
  _ws.on('open', () => {
    console.log('[shadow-wss] connected to public Solana RPC');
    _reconnectMs = RECONNECT_MIN_MS;
    // Re-subscribe all tracked accounts
    for (const [mint, s] of _bcSubs) {
      if (s.bondingCurveKey) sendAccountSubscribe('bc', mint, s.bondingCurveKey);
    }
    for (const [mint, s] of _ammSubs) {
      if (s.baseVault) sendAccountSubscribe('amm', mint, s.baseVault, 'base');
      if (s.quoteVault) sendAccountSubscribe('amm', mint, s.quoteVault, 'quote');
    }
  });
  _ws.on('message', onMessage);
  _ws.on('error', err => console.error('[shadow-wss] error:', err.message));
  _ws.on('close', () => {
    _subIdToSlot.clear();
    _pending.clear();
    if (!_running) return;
    console.log(`[shadow-wss] disconnected, reconnect in ${_reconnectMs}ms`);
    setTimeout(connect, _reconnectMs);
    _reconnectMs = Math.min(_reconnectMs * 2, RECONNECT_MAX_MS);
  });
}

export function startShadowWss() {
  if (_running) return;
  _running = true;
  connect();
  console.log('[shadow-wss] started · free public Solana WSS, shadow for held BC+AMM');
}

export function stopShadowWss() {
  _running = false;
  if (_ws) try { _ws.close(); } catch {}
  _ws = null;
}

// ---- BC (bonding curve) shadow subs ----
export function shadowSubscribeBc(mintAddress, bondingCurveKey) {
  if (!mintAddress || !bondingCurveKey) return;
  if (_bcSubs.has(mintAddress)) return;
  _bcSubs.set(mintAddress, { bondingCurveKey, subId: null });
  sendAccountSubscribe('bc', mintAddress, bondingCurveKey);
}

export function shadowUnsubscribeBc(mintAddress) {
  const s = _bcSubs.get(mintAddress);
  if (!s) return;
  if (s.subId != null) {
    sendAccountUnsubscribe(s.subId);
    _subIdToSlot.delete(s.subId);
  }
  _bcSubs.delete(mintAddress);
}

// ---- AMM (pump-amm pool vaults) shadow subs ----
export function shadowSubscribeAmm(mintAddress, baseVault, quoteVault) {
  if (!mintAddress || !baseVault || !quoteVault) return;
  if (_ammSubs.has(mintAddress)) return;
  _ammSubs.set(mintAddress, {
    baseVault, quoteVault,
    baseSubId: null, quoteSubId: null,
    baseAmount: null, quoteAmount: null,
  });
  sendAccountSubscribe('amm', mintAddress, baseVault, 'base');
  sendAccountSubscribe('amm', mintAddress, quoteVault, 'quote');
}

export function shadowUnsubscribeAmm(mintAddress) {
  const s = _ammSubs.get(mintAddress);
  if (!s) return;
  if (s.baseSubId != null) { sendAccountUnsubscribe(s.baseSubId); _subIdToSlot.delete(s.baseSubId); }
  if (s.quoteSubId != null) { sendAccountUnsubscribe(s.quoteSubId); _subIdToSlot.delete(s.quoteSubId); }
  _ammSubs.delete(mintAddress);
}

export function shadowStats() {
  return { bc: _bcSubs.size, amm: _ammSubs.size, connected: _ws?.readyState === WebSocket.OPEN };
}
