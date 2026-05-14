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

// 2026-05-14: the 4 COUNT(*) calls below were hitting every 5s and blocking
// the event loop for 700-1200ms each — pure dashboard data, not load-bearing.
// Cache for 60s. open_positions and last_trade_at refresh every tick since
// they're cheap (open count is small; MAX(timestamp) hits the index tail).
const COUNTS_CACHE_TTL_MS = 60 * 1000;
const HOT_CACHE_TTL_MS = 10 * 1000;
let _cachedCounts = null;
let _cachedAt = 0;
let _cachedHot = null;
let _cachedHotAt = 0;
function getCounts() {
  const now = Date.now();
  const d = db();
  // MAX(timestamp) on trades has no index → 4.45M-row tablescan, ~470ms.
  // The dashboard "last trade Xs ago" widget can tolerate 10s display lag,
  // so cache the hot path too.
  if (!_cachedHot || (now - _cachedHotAt) > HOT_CACHE_TTL_MS) {
    try {
      _cachedHot = d.prepare(`
        SELECT
          (SELECT COUNT(*) FROM paper_positions WHERE status='open') AS open_positions,
          (SELECT MAX(timestamp) FROM trades) AS last_trade_at
      `).get() || {};
      _cachedHotAt = now;
    } catch { _cachedHot = _cachedHot || {}; }
  }
  // Cold path: the 3 full-table COUNT(*) on trades/mints/wallets, every 60s.
  if (!_cachedCounts || (now - _cachedAt) > COUNTS_CACHE_TTL_MS) {
    try {
      _cachedCounts = d.prepare(`
        SELECT
          (SELECT COUNT(*) FROM trades) AS trades,
          (SELECT COUNT(*) FROM mints) AS mints,
          (SELECT COUNT(*) FROM wallets) AS wallets
      `).get() || {};
      _cachedAt = now;
    } catch { _cachedCounts = _cachedCounts || {}; }
  }
  return { ..._cachedCounts, ..._cachedHot };
}

export function startHealthHeartbeat({ pp, onchainTrades }) {
  const startedAt = Date.now();
  const tick = () => {
    try {
      const now = Date.now();
      const ppStatus = pp?.status?.() || {};
      const ot = onchainTrades || {};

      const counts = getCounts();

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
