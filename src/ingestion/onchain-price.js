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

// 2026-05-13: Prefer Helius for the held-position price watcher. This is the
// highest-stakes feed in the system — every position-monitor decision (trail,
// SL, tier exit) reads mints.last_price_sol which is updated here. Helius
// has a paid SLA, lower latency, and won't throttle like the public Solana
// RPC node does under load. Public RPC kept as fallback if no key configured.
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_WS = HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;
const RPC_WS = process.env.SOLANA_RPC_WS || HELIUS_WS || 'wss://api.mainnet-beta.solana.com';
const RPC_HTTP = process.env.SOLANA_RPC_HTTP
  || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com');
const PRICE_FLOOR_SOL = 1e-9;  // pump.fun bonding curve floor ~2.8e-8 — anything below this is migration-moment garbage
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REFRESH_INTERVAL_MS = 30 * 1000;       // re-evaluate which mints to sub every 30s
const POST_EXIT_WATCH_MS = 6 * 60 * 60 * 1000; // keep subscribed 6h after exit

let _ws = null;
let _running = false;
let _reconnectMs = RECONNECT_MIN_MS;
let _lastMsgAt = 0;       // for stale-WS watchdog
let _nextReqId = 1;
const _subs = new Map();        // mint_address -> { bondingCurveKey, subId, reqId }
const _pendingByReqId = new Map(); // reqId -> { mint, kind: 'sub'|'unsub' }

function lamportsToSol(n) { return Number(n) / 1e9; }

// One-shot getAccountInfo via Helius RPC. Used by warmUpPriceForMint() on
// position open AND by the per-sub staleness polling loop (Audit fixes
// 2026-05-14 — A: polling backup, D: warm-up).
// Returns the same shape as accountSubscribe notifications: ['<b64>', 'base64'].
async function fetchAccountInfoOnce(pubkey) {
  try {
    const res = await fetch(RPC_HTTP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'price-poll', method: 'getAccountInfo',
        params: [pubkey, { encoding: 'base64', commitment: 'processed' }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const data = j?.result?.value?.data;
    if (!Array.isArray(data) || !data.length) return null;
    return data;
  } catch { return null; }
}

// Audit fix D — when a position opens, paper.js calls this to seed a fresh
// onchain-curve price immediately, without waiting for the next reconcile +
// WSS subscribe (up to 30s + sub latency). Cheap: 1 Helius credit per call.
export async function warmUpPriceForMint(mintAddress, bondingCurveKey) {
  if (!mintAddress || !bondingCurveKey) return false;
  const data = await fetchAccountInfoOnce(bondingCurveKey);
  if (!data) return false;
  decodeAndUpdate(mintAddress, data);
  return true;
}

function decodeAndUpdate(mintAddress, accountInfoData) {
  try {
    const buf = Buffer.from(accountInfoData[0], accountInfoData[1] || 'base64');
    const curve = BondingCurveAccount.fromBuffer(buf);
    // Once the bonding curve completes, its PDA state becomes stale relative
    // to the new pump-amm pool — the AMM trades at a different price and the
    // bond-curve account stops getting trade updates. A migration-moment tick
    // (2026-05-11 Goblinjak: AMM at 5.45e-7, bond-curve final at 3.20e-7)
    // produced a 68pp drawdown vs the AMM peak and fired the moonbag trail
    // immediately. Mark migrated, then bail — leave price updates to the AMM
    // pollers (dexscreener / migrated-tracker / pump-amm trade feed).
    if (curve.complete) {
      db().prepare(`UPDATE mints SET migrated = 1, migrated_at = COALESCE(migrated_at, ?) WHERE mint_address = ? AND migrated = 0`)
        .run(Date.now(), mintAddress);
      return;
    }
    const mcapSol = lamportsToSol(curve.getMarketCapSOL());
    const supplyTokens = Number(curve.tokenTotalSupply) / 1e6;
    const priceSol = supplyTokens > 0 ? mcapSol / supplyTokens : 0;
    if (priceSol < PRICE_FLOOR_SOL) return;
    const _now = Date.now();
    // 2026-05-13 PM: now also updates peak_market_cap_sol. For held pre-mig
    // positions, onchain-curve is the SOLE writer (processor.js blocked) so
    // peak tracking must live here. Curve-derived prices are immune to dust
    // manipulation, sandwich routing, and trade-interpretation quirks, so
    // peak_market_cap_sol stays anchored to real curve state.
    db().prepare(`UPDATE mints SET
      current_market_cap_sol = ?,
      last_price_sol = ?,
      peak_market_cap_sol = MAX(peak_market_cap_sol, ?),
      last_trade_at = ?,
      last_price_source = ?,
      last_price_source_at = ?,
      last_curve_write_at = ?
      WHERE mint_address = ?`).run(mcapSol, priceSol, mcapSol, _now, 'onchain-curve', _now, _now, mintAddress);
  } catch (err) {
    // Self-healing: per-mint failure counter. After N decode failures, blacklist
    // the mint to stop log spam and avoid wasted work. Some pump.fun bonding
    // curves have malformed buffers and will never decode; subscribing to them
    // is pure noise.
    const fails = (_decodeFailures.get(mintAddress) || 0) + 1;
    _decodeFailures.set(mintAddress, fails);
    if (fails === 1 || fails === 5) {
      console.error('[onchain-price] decode', mintAddress.slice(0, 8), err.message, `(failure #${fails})`);
    }
    if (fails >= DECODE_FAILURE_BLACKLIST_THRESHOLD) {
      console.log(`[onchain-price] blacklisting ${mintAddress.slice(0, 8)}… after ${fails} decode failures — unsubscribing`);
      _decodeBlacklist.add(mintAddress);
      try { unsubscribe(mintAddress); } catch {}
    }
  }
}

// Decoder self-healing state — lives in module scope, persists across reconnects.
const _decodeFailures = new Map();    // mint -> failure count
const _decodeBlacklist = new Set();   // mints we've given up on
const DECODE_FAILURE_BLACKLIST_THRESHOLD = 10;

function send(obj) {
  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(obj));
}

function subscribe(mintAddress, bondingCurveKey) {
  if (_subs.has(mintAddress)) return;
  if (_decodeBlacklist.has(mintAddress)) return;  // self-healed: never re-subscribe to broken mints
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

let _pingInterval = null;
function connect() {
  if (!_running) return;
  console.log(`[onchain-price] connecting to ${RPC_WS}`);
  _ws = new WebSocket(RPC_WS);

  _ws.on('open', () => {
    console.log('[onchain-price] connected');
    _reconnectMs = RECONNECT_MIN_MS;
    _lastMsgAt = Date.now();  // reset stale clock
    // Re-issue all subs from scratch (subId mappings are connection-scoped)
    const prev = [..._subs.entries()];
    _subs.clear();
    for (const [mint, s] of prev) subscribe(mint, s.bondingCurveKey);
    reconcile();
    // Audit fix C — WSS heartbeat. Send ping every 20s, the 'pong' handler
    // updates _lastMsgAt so the stale watchdog doesn't false-positive when
    // there are simply no curve trades happening. Also detects silent
    // half-closed connections that don't fire 'close' — if no pong comes
    // back, the next stale check forces reconnect.
    if (_pingInterval) clearInterval(_pingInterval);
    _pingInterval = setInterval(() => {
      try { if (_ws?.readyState === WebSocket.OPEN) _ws.ping(); } catch {}
    }, 20 * 1000);
  });

  _ws.on('pong', () => { _lastMsgAt = Date.now(); });

  _ws.on('message', (raw) => {
    _lastMsgAt = Date.now();
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
    if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
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
  // Stale-WS watchdog — 30s silence threshold, checked every 5s. Pump.fun
  // coins move 50%+ in 30s so this is the longest reasonable blind window.
  // Max total stale = 30s threshold + 5s check interval + ~5s reconnect.
  setInterval(() => {
    if (!_running) return;
    const sinceMsg = Date.now() - _lastMsgAt;
    if (_subs.size > 0 && sinceMsg > 30 * 1000 && _ws) {
      console.warn(`[onchain-price] STALE — no messages in ${Math.floor(sinceMsg/1000)}s with ${_subs.size} subs, forcing reconnect`);
      try { _ws.terminate(); } catch {}
    }
  }, 5 * 1000);
  // Audit fix A — per-sub polling backup. Every 5s, iterate active subs and
  // check last_curve_write_at on each mint's row. If >10s stale, poll
  // getAccountInfo and decode. Keeps held-position price feed alive even
  // during WSS disconnects or per-sub silent failures (which can happen
  // independently of the global WSS connection). Cost: ~1 Helius credit per
  // stale poll. With ~5 held mints all stale = 5 credits/5s = 3.6k/hr —
  // negligible vs the 10M monthly budget.
  setInterval(() => {
    if (!_running || _subs.size === 0) return;
    const d = db();
    const stmt = d.prepare('SELECT last_curve_write_at FROM mints WHERE mint_address = ?');
    const now = Date.now();
    for (const [mint, s] of _subs) {
      const row = stmt.get(mint);
      const lastCurve = row?.last_curve_write_at || 0;
      if (now - lastCurve > 10 * 1000 && s.bondingCurveKey) {
        // stale — poll directly
        fetchAccountInfoOnce(s.bondingCurveKey).then(data => {
          if (data) decodeAndUpdate(mint, data);
        }).catch(() => {});
      }
    }
  }, 5 * 1000);
  console.log(`[onchain-price] started · ${RPC_WS} · reconcile every ${REFRESH_INTERVAL_MS / 1000}s · stale-WS watchdog 30s/5s · per-sub poll backup 10s/5s`);
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
