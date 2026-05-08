import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { db } from '../db/index.js';

export class PumpPortalClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.mintSubs = new Set();
    this.reconnectMs = config.pumpPortal.reconnectMinMs;
    this.running = false;
    this.connectedAt = null;
    this.lastEventAt = null;
    this.eventCount = 0;
  }

  start() {
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.ws) this.ws.close();
  }

  status() {
    return {
      connected: this.ws && this.ws.readyState === WebSocket.OPEN,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventAt,
      eventCount: this.eventCount,
      subscriptions: this.mintSubs.size,
    };
  }

  connect() {
    const ws = new WebSocket(config.pumpPortal.url);
    this.ws = ws;

    ws.on('open', () => {
      this.connectedAt = Date.now();
      this.reconnectMs = config.pumpPortal.reconnectMinMs;
      console.log('[pumpportal] connected');
      // subscribeTokenTrade / subscribeAccountTrade became paid on 2026-05-01.
      // Trade firehose now comes from on-chain log parsing (onchain-pump-trades.js).
      // PumpPortal still gives us new-token + migration events for free.
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      this.emit('connected');
    });

    ws.on('message', (raw) => {
      this.lastEventAt = Date.now();
      this.eventCount++;
      try {
        const msg = JSON.parse(raw.toString());
        this.route(msg);
      } catch (err) {
        console.error('[pumpportal] parse error', err.message);
      }
    });

    ws.on('close', () => {
      console.log('[pumpportal] disconnected');
      this.connectedAt = null;
      this.emit('disconnected');
      if (this.running) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error('[pumpportal] error', err.message);
    });
  }

  route(msg) {
    if (msg.message && !msg.txType && !msg.mint) return;
    const t = msg.txType || msg.type;
    if (t === 'create') {
      this.emit('create', msg);
    } else if (t === 'buy' || t === 'sell') {
      // Should not arrive anymore — trade firehose moved on-chain. Drop silently.
    } else if (t === 'migrate' || t === 'migration') {
      this.emit('migrate', msg);
    }
  }

  subscribeTradeFor(mint) {
    if (!mint || this.mintSubs.has(mint)) return;
    this.mintSubs.add(mint);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }
  }

  scheduleReconnect() {
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, config.pumpPortal.reconnectMaxMs);
    console.log(`[pumpportal] reconnecting in ${delay}ms`);
    setTimeout(() => { if (this.running) this.connect(); }, delay);
  }
}
