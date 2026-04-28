import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';

const HELIUS_RPC = () => `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
const PUBLIC_RPC = () => process.env.PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUBLIC_WS = () => process.env.PUBLIC_WS_URL || 'wss://api.mainnet-beta.solana.com';

export async function checkCashbackFlag(bondingCurveKey) {
  if (!bondingCurveKey) return null;
  try {
    const res = await fetch(PUBLIC_RPC(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'cashback',
        method: 'getAccountInfo',
        params: [bondingCurveKey, { encoding: 'base64', commitment: 'processed' }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const b64 = data?.result?.value?.data?.[0];
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 83) return 0;
    return buf[82] !== 0 ? 1 : 0;
  } catch (err) {
    console.error('[helius] cashback', err.message);
    return null;
  }
}

export async function getTokenHolders(mintAddress, limit = 1000) {
  if (!config.heliusApiKey) return null;
  try {
    const res = await fetch(HELIUS_RPC(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'holders',
        method: 'getTokenAccounts',
        params: { mint: mintAddress, limit, options: { showZeroBalance: false } },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const accounts = data?.result?.token_accounts;
    if (!Array.isArray(accounts) || !accounts.length) return null;

    const byOwner = new Map();
    for (const acc of accounts) {
      if (!acc.owner) continue;
      const amt = Number(acc.amount || 0);
      if (amt <= 0) continue;
      byOwner.set(acc.owner, (byOwner.get(acc.owner) || 0) + amt);
    }
    return [...byOwner.entries()]
      .map(([owner, amount]) => ({ owner, amount }))
      .sort((a, b) => b.amount - a.amount);
  } catch (err) {
    console.error('[helius] getTokenHolders', err.message);
    return null;
  }
}

class HeliusWSClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.poolToSubId = new Map();
    this.subIdToPool = new Map();
    this.pendingSubs = new Map();
    this.idCounter = 1;
    this.running = false;
    this.lastSwapAt = new Map();
  }

  start() {
    this.running = true;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(PUBLIC_WS());
    this.ws = ws;
    ws.on('open', () => {
      console.log('[pool-ws] connected (public RPC)');
      for (const poolAddr of this.poolToSubId.keys()) {
        this.sendSubscribe(poolAddr);
      }
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id && this.pendingSubs.has(msg.id)) {
          const { resolve, poolAddr } = this.pendingSubs.get(msg.id);
          this.pendingSubs.delete(msg.id);
          if (typeof msg.result === 'number') {
            this.poolToSubId.set(poolAddr, msg.result);
            this.subIdToPool.set(msg.result, poolAddr);
            resolve(msg.result);
          }
          return;
        }
        if (msg.method === 'logsNotification') {
          const subId = msg.params?.subscription;
          const poolAddr = this.subIdToPool.get(subId);
          if (poolAddr) {
            const last = this.lastSwapAt.get(poolAddr) || 0;
            if (Date.now() - last > 1000) {
              this.lastSwapAt.set(poolAddr, Date.now());
              this.emit('swap', poolAddr);
            }
          }
        }
      } catch (err) {
        console.error('[pool-ws] parse', err.message);
      }
    });
    ws.on('close', () => {
      console.log('[pool-ws] disconnected, reconnecting...');
      this.poolToSubId.clear();
      this.subIdToPool.clear();
      if (this.running) setTimeout(() => this.connect(), 3000);
    });
    ws.on('error', (err) => console.error('[pool-ws]', err.message));
  }

  sendSubscribe(poolAddr) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = this.idCounter++;
    return new Promise((resolve) => {
      this.pendingSubs.set(id, { resolve, poolAddr });
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0', id,
        method: 'logsSubscribe',
        params: [{ mentions: [poolAddr] }, { commitment: 'processed' }],
      }));
    });
  }

  subscribePool(poolAddr) {
    if (!poolAddr || this.poolToSubId.has(poolAddr)) return;
    this.poolToSubId.set(poolAddr, null);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(poolAddr);
    }
  }
}

export const heliusWS = new HeliusWSClient();
