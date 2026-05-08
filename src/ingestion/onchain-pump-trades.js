// On-chain Pump.fun trade firehose. Replaces the (now-paid) PumpPortal
// `subscribeTokenTrade` stream. We open ONE websocket to a Solana RPC,
// `logsSubscribe` for the Pump.fun bonding-curve program, and decode every
// TradeEvent (Anchor `emit!`) directly from the program-data log lines. No
// per-transaction fetch, no per-message fee — just the raw firehose.
//
// Output shape matches the PumpPortal `trade` event so processor.js can
// attach to this emitter unchanged.

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import bs58 from 'bs58';
import { config } from '../config.js';

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Anchor event discriminators = sha256("event:<EventName>")[0..8].
// TradeEvent is the only one we strictly need — pumpportal still gives us
// create + migrate for free. If pumpportal also gets paywalled later, add
// the CreateEvent/CompleteEvent discriminators here.
const TRADE_EVENT_DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);

const encodeBase58 = bs58.encode || bs58.default?.encode;

class OnchainPumpTrades extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.running = false;
    this.subId = null;
    this.reconnectMs = 1000;
    this.lastEventAt = 0;
    this.tradeCount = 0;
    this.connectedAt = null;
    this._statsTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
    this._statsTimer = setInterval(() => this.logStats(), 5 * 60 * 1000);
  }

  stop() {
    this.running = false;
    clearInterval(this._statsTimer);
    this._statsTimer = null;
    try { this.ws?.close(); } catch {}
  }

  url() {
    if (config.heliusApiKey) return `wss://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
    return process.env.PUBLIC_WS_URL || 'wss://api.mainnet-beta.solana.com';
  }

  logStats() {
    const upMs = this.connectedAt ? Date.now() - this.connectedAt : 0;
    const lastAgo = this.lastEventAt ? Math.floor((Date.now() - this.lastEventAt) / 1000) : null;
    console.log(`[onchain-trades] stats · trades=${this.tradeCount} · up=${Math.floor(upMs/1000)}s · lastEvent=${lastAgo}s ago`);
  }

  connect() {
    const url = this.url();
    const provider = url.includes('helius') ? 'Helius' : 'public RPC';
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      console.log(`[onchain-trades] connected (${provider})`);
      this.connectedAt = Date.now();
      this.reconnectMs = 1000;
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [PUMP_FUN_PROGRAM] }, { commitment: 'processed' }],
      }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.id === 1 && typeof msg.result === 'number') {
        this.subId = msg.result;
        console.log(`[onchain-trades] subscribed · subId=${this.subId}`);
        return;
      }

      if (msg.method !== 'logsNotification') return;

      const value = msg.params?.result?.value;
      if (!value || value.err) return;
      const logs = value.logs;
      const sig = value.signature;
      if (!Array.isArray(logs)) return;

      this.parseLogs(logs, sig);
    });

    ws.on('close', () => {
      console.log('[onchain-trades] disconnected, reconnecting...');
      this.subId = null;
      this.connectedAt = null;
      if (this.running) {
        const wait = this.reconnectMs;
        this.reconnectMs = Math.min(this.reconnectMs * 2, 30000);
        setTimeout(() => this.connect(), wait);
      }
    });

    ws.on('error', (err) => console.error('[onchain-trades] error', err.message));
  }

  parseLogs(logs, signature) {
    for (const line of logs) {
      // Anchor `emit!` writes events as `Program data: <base64>`.
      if (typeof line !== 'string') continue;
      const idx = line.indexOf('Program data: ');
      if (idx !== 0) continue;
      const b64 = line.slice('Program data: '.length).trim();
      if (!b64) continue;
      let buf;
      try { buf = Buffer.from(b64, 'base64'); } catch { continue; }
      if (buf.length < 8) continue;
      if (!buf.subarray(0, 8).equals(TRADE_EVENT_DISC)) continue;
      this.parseTradeEvent(buf.subarray(8), signature);
    }
  }

  parseTradeEvent(buf, signature) {
    // TradeEvent layout (Borsh, fixed 121 bytes after the 8-byte discriminator):
    //   mint:                    32  Pubkey
    //   sol_amount:               8  u64 (lamports)
    //   token_amount:             8  u64 (token base units, 6 decimals)
    //   is_buy:                   1  bool
    //   user:                    32  Pubkey
    //   timestamp:                8  i64 (unix seconds)
    //   virtual_sol_reserves:     8  u64 (lamports)
    //   virtual_token_reserves:   8  u64 (token base units)
    //   real_sol_reserves:        8  u64
    //   real_token_reserves:      8  u64
    if (buf.length < 121) return;
    try {
      let o = 0;
      const mint = encodeBase58(buf.subarray(o, o + 32)); o += 32;
      const solLamports = buf.readBigUInt64LE(o); o += 8;
      const tokenBase = buf.readBigUInt64LE(o); o += 8;
      const isBuy = buf[o] !== 0; o += 1;
      const user = encodeBase58(buf.subarray(o, o + 32)); o += 32;
      o += 8; // timestamp — not used (we use Date.now())
      const vSolLamports = buf.readBigUInt64LE(o); o += 8;
      const vTokenBase = buf.readBigUInt64LE(o); o += 8;
      // real_* not needed downstream

      const solAmount = Number(solLamports) / 1e9;
      const tokenAmount = Number(tokenBase) / 1e6;
      const vSol = Number(vSolLamports) / 1e9;
      const vTokens = Number(vTokenBase) / 1e6;
      // Pump.fun bonding curve: total supply = 1e9 tokens (whole), so market cap
      // in SOL = price * supply = (vSol / vTokens) * 1e9.
      const marketCapSol = vTokens > 0 ? (vSol / vTokens) * 1e9 : 0;

      this.tradeCount++;
      this.lastEventAt = Date.now();

      this.emit('trade', {
        mint,
        txType: isBuy ? 'buy' : 'sell',
        solAmount,
        tokenAmount,
        traderPublicKey: user,
        signature: signature || null,
        marketCapSol,
        vSolInBondingCurve: vSol,
        vTokensInBondingCurve: vTokens,
      });
    } catch (err) {
      console.error('[onchain-trades] decode', err.message);
    }
  }
}

export const onchainPumpTrades = new OnchainPumpTrades();
