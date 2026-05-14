// onchain-amm — post-migration analog of onchain-curve.
//
// For held migrated positions, we want true marginal prices computed from the
// pump-amm pool's actual reserves (free of trade-interpretation pollution
// like dust manipulation, sandwich routing, slippage skew on big trades).
//
// Mechanism:
//   1. When a position opens on a migrated mint (or a held position migrates
//      mid-hold), look up the pump-amm pool address. Pool address comes from
//      mints.amm_pool_address (set by dexscreener-mig polling). If not yet
//      known, retry on subsequent calls — DexScreener can lag a few minutes
//      after migration.
//   2. Fetch the pool account via Helius RPC. Extract the two vault addresses
//      at known offsets (139 = base_token_vault, 171 = quote_token_vault).
//   3. Open two Solana accountSubscribe WSS subscriptions, one per vault.
//      WSS subscriptions and notifications are FREE on Helius (no per-event
//      credit cost). Each notification includes the full account data, so we
//      decode the SPL token amount directly (offset 64, 8 bytes uint64 LE)
//      without an extra RPC.
//   4. On every notification, recompute price = quote_amount / base_amount
//      using proper decimals (base typically 6, quote SOL = 9), then write
//      mints.last_price_sol with source 'onchain-amm'. Also bump
//      peak_market_cap_sol since this becomes the sole writer for held
//      post-mig coins.
//   5. On position close (or position rugged), unsubscribe both vaults.
//
// processor.js's held-mint lock should ALSO block helius-tx when an
// onchain-amm subscription is active, so the position monitor only sees
// reserve-derived prices.

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { shadowSubscribeAmm, shadowUnsubscribeAmm } from './public-wss-shadow.js';

const HELIUS_API_KEY = () => config.heliusApiKey || process.env.HELIUS_API_KEY || '';
const HELIUS_RPC = () => `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY()}`;
const HELIUS_WS = () => HELIUS_API_KEY()
  ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY()}`
  : (process.env.PUBLIC_WS_URL || 'wss://api.mainnet-beta.solana.com');

// Pump-amm account layout offsets (Anchor discriminator prefix is 8 bytes):
//   8   pool_bump (u8)
//   9   index (u16)
//   11  creator (32 bytes)
//   43  base_mint (32 bytes)
//   75  quote_mint (32 bytes)
//   107 lp_mint (32 bytes)
//   139 pool_base_token_account (32 bytes)  <-- base vault address
//   171 pool_quote_token_account (32 bytes) <-- quote vault address (SOL)
const POOL_BASE_VAULT_OFFSET = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;

// SPL token account layout: amount at offset 64, 8 bytes uint64 little-endian.
const SPL_AMOUNT_OFFSET = 64;

// Pump.fun coins are minted with 6 decimals; quote is wrapped SOL (9 decimals).
const BASE_DECIMALS = 6;
const QUOTE_DECIMALS = 9;
const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000;  // for mcap derivation

function decodePubkey(buf, offset) {
  const slice = buf.slice(offset, offset + 32);
  // Convert to base58 — Solana addresses are base58-encoded 32-byte pubkeys.
  // We use a minimal base58 encoder here to avoid pulling in a new dep.
  return bs58encode(slice);
}

const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58encode(bytes) {
  // Standard base58 encoding (no checksum). Pulled from common JS impl.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = BigInt(0);
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = BS58_ALPHABET[rem] + out;
  }
  for (let i = 0; i < zeros; i++) out = '1' + out;
  return out;
}

function decodeSplAmount(buf) {
  if (!buf || buf.length < SPL_AMOUNT_OFFSET + 8) return null;
  // Little-endian uint64
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[SPL_AMOUNT_OFFSET + i]);
  return v;
}

async function fetchPoolVaults(poolAddress) {
  const res = await fetch(HELIUS_RPC(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'pool-fetch',
      method: 'getAccountInfo',
      params: [poolAddress, { encoding: 'base64', commitment: 'processed' }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const b64 = data?.result?.value?.data?.[0];
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < POOL_QUOTE_VAULT_OFFSET + 32) return null;
  return {
    baseVault: decodePubkey(buf, POOL_BASE_VAULT_OFFSET),
    quoteVault: decodePubkey(buf, POOL_QUOTE_VAULT_OFFSET),
  };
}

class OnchainAmmClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.running = false;
    this.idCounter = 100000;  // separate range from heliusWS to avoid collision
    this.pendingSubs = new Map();    // requestId -> { resolve, role, mint, vault }
    this.subIdToSlot = new Map();    // subId -> { mint, role: 'base'|'quote', vault }
    this.state = new Map();          // mint -> { poolAddress, baseVault, quoteVault, baseAmount, quoteAmount, baseSubId, quoteSubId }
  }

  isAmmSubscribed(mint) {
    const s = this.state.get(mint);
    return !!(s && (s.baseAmount != null || s.quoteAmount != null));
  }

  start() {
    this.running = true;
    this._connect();
  }

  _connect() {
    const ws = new WebSocket(HELIUS_WS());
    this.ws = ws;
    ws.on('open', () => {
      console.log('[onchain-amm] WSS connected');
      // Re-subscribe everything we had tracked
      for (const [mint, s] of this.state) {
        if (s.baseVault) this._sendAccountSubscribe(mint, 'base', s.baseVault);
        if (s.quoteVault) this._sendAccountSubscribe(mint, 'quote', s.quoteVault);
      }
    });
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('close', () => {
      console.log('[onchain-amm] WSS disconnected, reconnecting in 3s...');
      this.subIdToSlot.clear();
      if (this.running) setTimeout(() => this._connect(), 3000);
    });
    ws.on('error', (err) => console.error('[onchain-amm] WSS error:', err.message));
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // Subscribe confirmation: { id, result: subId }
    if (msg.id && this.pendingSubs.has(msg.id)) {
      const pending = this.pendingSubs.get(msg.id);
      this.pendingSubs.delete(msg.id);
      if (typeof msg.result === 'number') {
        const subId = msg.result;
        this.subIdToSlot.set(subId, { mint: pending.mint, role: pending.role, vault: pending.vault });
        const s = this.state.get(pending.mint);
        if (s) {
          if (pending.role === 'base') s.baseSubId = subId;
          else s.quoteSubId = subId;
        }
      }
      return;
    }
    // Account notification: { method: 'accountNotification', params: { subscription, result: { value: { data: ['b64', 'base64'] } } } }
    if (msg.method === 'accountNotification') {
      const subId = msg.params?.subscription;
      const slot = this.subIdToSlot.get(subId);
      if (!slot) return;
      const b64 = msg.params?.result?.value?.data?.[0];
      if (!b64) return;
      const buf = Buffer.from(b64, 'base64');
      const amount = decodeSplAmount(buf);
      if (amount == null) return;
      const s = this.state.get(slot.mint);
      if (!s) return;
      if (slot.role === 'base') s.baseAmount = amount;
      else s.quoteAmount = amount;
      // Recompute price if we have both
      this._writePrice(slot.mint);
    }
  }

  _sendAccountSubscribe(mint, role, vaultAddress) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = ++this.idCounter;
    this.pendingSubs.set(id, { mint, role, vault: vaultAddress });
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'accountSubscribe',
      params: [vaultAddress, { encoding: 'base64', commitment: 'processed' }],
    }));
  }

  _sendAccountUnsubscribe(subId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: ++this.idCounter,
      method: 'accountUnsubscribe',
      params: [subId],
    }));
    this.subIdToSlot.delete(subId);
  }

  _writePrice(mint) {
    const s = this.state.get(mint);
    if (!s || s.baseAmount == null || s.quoteAmount == null) return;
    const baseRaw = Number(s.baseAmount);
    const quoteRaw = Number(s.quoteAmount);
    if (baseRaw <= 0) return;
    const baseTokens = baseRaw / 10 ** BASE_DECIMALS;
    const quoteSol = quoteRaw / 10 ** QUOTE_DECIMALS;
    const priceSol = quoteSol / baseTokens;
    if (!isFinite(priceSol) || priceSol <= 0) return;
    const mcapSol = priceSol * PUMP_FUN_TOTAL_SUPPLY;
    const now = Date.now();
    try {
      db().prepare(`UPDATE mints SET
        current_market_cap_sol = ?,
        last_price_sol = ?,
        peak_market_cap_sol = MAX(peak_market_cap_sol, ?),
        last_trade_at = ?,
        last_price_source = 'onchain-amm',
        last_price_source_at = ?,
        last_curve_write_at = ?
        WHERE mint_address = ?`).run(mcapSol, priceSol, mcapSol, now, now, now, mint);
    } catch (err) { console.error('[onchain-amm] write', err.message); }
  }

  async subscribe(mintAddress) {
    if (this.state.has(mintAddress)) return; // already tracked
    const row = db().prepare('SELECT amm_pool_address FROM mints WHERE mint_address = ?').get(mintAddress);
    const poolAddress = row?.amm_pool_address;
    if (!poolAddress) {
      // Pool not yet known (DexScreener hasn't indexed). Caller can retry later.
      return;
    }
    let vaults;
    try {
      vaults = await fetchPoolVaults(poolAddress);
    } catch (err) {
      console.error(`[onchain-amm] fetchPoolVaults ${mintAddress.slice(0,8)}…:`, err.message);
      return;
    }
    if (!vaults) {
      console.warn(`[onchain-amm] no vaults decoded for ${poolAddress.slice(0,8)}… (pool layout mismatch?)`);
      return;
    }
    this.state.set(mintAddress, {
      poolAddress,
      baseVault: vaults.baseVault,
      quoteVault: vaults.quoteVault,
      baseAmount: null,
      quoteAmount: null,
      baseSubId: null,
      quoteSubId: null,
    });
    this._sendAccountSubscribe(mintAddress, 'base', vaults.baseVault);
    this._sendAccountSubscribe(mintAddress, 'quote', vaults.quoteVault);
    try { shadowSubscribeAmm(mintAddress, vaults.baseVault, vaults.quoteVault); } catch {}
    console.log(`[onchain-amm] subscribed ${mintAddress.slice(0,8)}… pool=${poolAddress.slice(0,8)}…`);
  }

  unsubscribe(mintAddress) {
    const s = this.state.get(mintAddress);
    if (!s) return;
    if (s.baseSubId != null) this._sendAccountUnsubscribe(s.baseSubId);
    if (s.quoteSubId != null) this._sendAccountUnsubscribe(s.quoteSubId);
    this.state.delete(mintAddress);
    try { shadowUnsubscribeAmm(mintAddress); } catch {}
    console.log(`[onchain-amm] unsubscribed ${mintAddress.slice(0,8)}…`);
  }
}

export const onchainAmm = new OnchainAmmClient();

// Convenience exports — used by processor.js held-mint lock and by paper.js
// lifecycle hooks.
export function isAmmSubscribed(mint) {
  return onchainAmm.isAmmSubscribed(mint);
}

export function subscribePumpAmm(mintAddress) {
  // fire-and-forget — pool fetch is async but caller doesn't need to wait
  onchainAmm.subscribe(mintAddress).catch(err =>
    console.error(`[onchain-amm] subscribe ${mintAddress.slice(0,8)}…:`, err.message));
}

export function unsubscribePumpAmm(mintAddress) {
  onchainAmm.unsubscribe(mintAddress);
}

// Startup: subscribe to all currently-held migrated positions. Also retry any
// held migrated positions whose pool address became known later (DexScreener
// indexing lag) — we poll every 60s and subscribe any newly-discovered pools.
export function startOnchainAmm() {
  onchainAmm.start();
  const trySeedAll = () => {
    try {
      const rows = db().prepare(`
        SELECT DISTINCT p.mint_address
        FROM paper_positions p
        JOIN mints m ON m.mint_address = p.mint_address
        WHERE p.status = 'open' AND m.migrated = 1 AND m.rugged = 0
          AND m.amm_pool_address IS NOT NULL AND m.amm_pool_address != ''
      `).all();
      for (const r of rows) subscribePumpAmm(r.mint_address);
    } catch (err) { console.error('[onchain-amm] seed', err.message); }
  };
  // First sweep 30s after start (let main bot finish boot), then every 60s.
  setTimeout(trySeedAll, 30 * 1000);
  setInterval(trySeedAll, 60 * 1000);
  console.log('[onchain-amm] scheduled · seed sweep every 60s for held migrated mints');
}
