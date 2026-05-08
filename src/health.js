// System health heartbeat. Bot process writes a small JSON snapshot of every
// major subsystem to data/health.json every 5s. Dashboard process reads the
// file (it can't reach into the bot's in-memory state directly) and renders
// status boxes from it. File freshness = bot alive: > 15s stale = LAGGING,
// > 60s stale = DOWN.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEALTH_PATH = path.resolve(__dirname, '..', 'data', 'health.json');

export function startHealthHeartbeat({ pp, onchainTrades }) {
  const startedAt = Date.now();
  const tick = () => {
    try {
      const now = Date.now();
      const ppStatus = pp?.status?.() || {};
      const ot = onchainTrades || {};

      const counts = (() => {
        try {
          const d = db();
          const r = d.prepare(`
            SELECT
              (SELECT COUNT(*) FROM trades) AS trades,
              (SELECT COUNT(*) FROM mints) AS mints,
              (SELECT COUNT(*) FROM wallets) AS wallets,
              (SELECT COUNT(*) FROM paper_positions WHERE status='open') AS open_positions,
              (SELECT MAX(timestamp) FROM trades) AS last_trade_at
          `).get();
          return r || {};
        } catch { return {}; }
      })();

      const dbFile = (() => {
        try {
          const stat = fs.statSync(path.resolve(__dirname, '..', 'data', 'degen.db'));
          return { size: stat.size };
        } catch { return {}; }
      })();

      const payload = {
        ts: now,
        bot: {
          pid: process.pid,
          uptime_sec: Math.floor((now - startedAt) / 1000),
        },
        feeds: {
          onchainTrades: {
            connected: !!ot.connectedAt,
            connected_for_sec: ot.connectedAt ? Math.floor((now - ot.connectedAt) / 1000) : 0,
            last_event_ago_sec: ot.lastEventAt ? Math.floor((now - ot.lastEventAt) / 1000) : null,
            trades_total: ot.tradeCount || 0,
          },
          pumpportal: {
            connected: !!ppStatus.connected,
            connected_for_sec: ppStatus.connectedAt ? Math.floor((now - ppStatus.connectedAt) / 1000) : 0,
            last_event_ago_sec: ppStatus.lastEventAt ? Math.floor((now - ppStatus.lastEventAt) / 1000) : null,
            event_count: ppStatus.eventCount || 0,
          },
        },
        db: {
          size_mb: dbFile.size ? +(dbFile.size / 1024 / 1024).toFixed(1) : null,
          trades: counts.trades || 0,
          mints: counts.mints || 0,
          wallets: counts.wallets || 0,
          open_positions: counts.open_positions || 0,
          last_trade_ago_sec: counts.last_trade_at ? Math.floor((now - counts.last_trade_at) / 1000) : null,
        },
      };

      fs.writeFileSync(HEALTH_PATH, JSON.stringify(payload), 'utf8');
    } catch (err) {
      console.error('[health]', err.message);
    }
  };
  tick();
  setInterval(tick, 5000);
}

// Helper for dashboard process — reads + returns the heartbeat with a
// derived status field based on file age.
export function readHealth() {
  try {
    const raw = fs.readFileSync(HEALTH_PATH, 'utf8');
    const data = JSON.parse(raw);
    const ageSec = Math.floor((Date.now() - data.ts) / 1000);
    let status = 'ALIVE';
    if (ageSec > 60) status = 'DOWN';
    else if (ageSec > 15) status = 'LAGGING';
    return { ...data, age_sec: ageSec, status };
  } catch {
    return { status: 'DOWN', age_sec: null };
  }
}
