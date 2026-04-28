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
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));

      try {
        const cutoff = Date.now() - 2 * 60 * 60 * 1000;
        const activeMints = db().prepare(`
          SELECT mint_address FROM mints
          WHERE migrated = 0 AND rugged = 0
            AND COALESCE(last_trade_at, created_at) > ?
          ORDER BY last_trade_at DESC LIMIT 1500
        `).all(cutoff);
        for (const m of activeMints) this.mintSubs.add(m.mint_address);
        if (activeMints.length) {
          console.log(`[pumpportal] re-subscribing to ${activeMints.length} active mints from DB`);
        }
      } catch (err) {
        console.error('[pumpportal] hydrate subs', err.message);
      }

      if (this.mintSubs.size) {
        const keys = [...this.mintSubs];
        const chunkSize = 200;
        for (let i = 0; i < keys.length; i += chunkSize) {
          ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: keys.slice(i, i + chunkSize) }));
        }
      }
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
      this.subscribeTradeFor(msg.mint);
    } else if (t === 'buy' || t === 'sell') {
      this.emit('trade', msg);
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
