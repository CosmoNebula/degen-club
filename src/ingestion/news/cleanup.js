// Retention cleanup for news + trends tables. Runs nightly. Drops anything
// older than the retention window so DB doesn't grow forever.

import { db } from '../../db/index.js';

const NEWS_RETENTION_DAYS = 14;
const TRENDS_RETENTION_DAYS = 7;        // trends are time-sensitive, shorter window
const SYNTHESIS_RETENTION_DAYS = 30;    // keep synthesis for backtest comparison

const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // every 6 hours
const FIRST_RUN_DELAY_MS = 30 * 60 * 1000;     // 30 min after boot

async function tick() {
  try {
    const d = db();
    const now = Date.now();
    const newsCutoff = now - NEWS_RETENTION_DAYS * 86400000;
    const trendsCutoff = now - TRENDS_RETENTION_DAYS * 86400000;
    const synthCutoff = now - SYNTHESIS_RETENTION_DAYS * 86400000;
    const newsDel = d.prepare(`DELETE FROM news_items WHERE ts < ?`).run(newsCutoff).changes;
    const trendsDel = d.prepare(`DELETE FROM trend_signals WHERE ts < ?`).run(trendsCutoff).changes;
    const synthDel = d.prepare(`DELETE FROM agent_meta_synthesis WHERE ts < ?`).run(synthCutoff).changes;
    // Auto-deactivate expired manual flags
    const flagsDeact = d.prepare(`UPDATE manual_flags SET active=0 WHERE active=1 AND expires_at IS NOT NULL AND expires_at < ?`).run(now).changes;
    if (newsDel + trendsDel + synthDel + flagsDeact > 0) {
      console.log(`[news-cleanup] dropped news=${newsDel}, trends=${trendsDel}, synth=${synthDel}, deactivated_flags=${flagsDeact}`);
    }
  } catch (err) { console.error('[news-cleanup] err:', err.message); }
}

export function startNewsCleanup() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log('[news-cleanup] scheduled · every 6h · news 14d / trends 7d / synth 30d');
}
