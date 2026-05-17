// Daily intelligence condensate + smart pruning.
//
// Pump.fun ingests ~3M trades/day. At raw retention we'd hit disk in days.
// But the agent's "intelligence" (what we learned) doesn't need every trade
// after a mint is fully labeled — by 7h post-creation, the trades have been
// digested into ml_mint_snapshots features and labels. After that, raw trades
// are bulk we can drop.
//
// This module:
//   1. NIGHTLY: rolls up yesterday's data into daily_intelligence (one row/day)
//      capturing the meaningful aggregates as the agent's long-term memory.
//   2. EVERY 6h: prunes raw trades > 48h, predictions > 14d, etc.
//
// What we NEVER drop:
//   - ml_mint_snapshots (the training set itself)
//   - ml_agent_log, ml_agent_strategies (reasoning history)
//   - paper_positions (trade outcomes — small)
//   - daily_intelligence (the condensate itself)
//   - Trained model files (live in ml/models, not in DB)

import { db } from '../db/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '..', '..', 'ml', 'models');

const CONDENSATE_INTERVAL_MS = 6 * 60 * 60 * 1000;    // check every 6h
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90 * 1000;

// Retention windows
const TRADES_RETENTION_HOURS = 14 * 24;     // 2026-05-17: 48h → 14d. Caught a silent bug — wallet_5x_score worker queries trades over 8 days (`LOOKBACK_MS = 8 * 24 * 3600 * 1000`) to compute elite wallets' hit rate on 5x runners. 48h retention starved this consumer; the elite pool would have silently degraded as 6-day-old context disappeared. 14d (336h) covers 5x scorer + 2-day safety margin. Older trades are archived to MEGA Parquet by cold-archive.js before pruning, so we never lose source data.
const PREDICTIONS_RETENTION_DAYS = 7;        // 2026-05-12 (VM): 2d→7d. Calibration uses LIMIT 50k per target so longer retention is cheap; drift monitor benefits from wider outcome-history window.
const LIVE_CONDITIONS_RETENTION_DAYS = 3;
const FRICTION_LOG_RETENTION_DAYS = 7;
const SIGNALS_RETENTION_DAYS = 14;
const WEBHOOK_DL_RETENTION_DAYS = 7;         // keep dead-letter long enough to diagnose drift
const COLD_MICROSTRUCTURE_HOURS = 24;        // mints not traded in 24h

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    hasCondensateForDay: d.prepare(`SELECT 1 FROM daily_intelligence WHERE date_key = ? LIMIT 1`),
    insertCondensate: d.prepare(`INSERT OR REPLACE INTO daily_intelligence
      (date_key, ts, mints_created, mints_migrated, trades_total, unique_traders,
       pop_peaked_30_rate, pop_peaked_100_rate, pop_peaked_300_rate, pop_migration_rate, pop_avg_peak_pct,
       tracked_wallet_buys, kol_buys, per_strategy_pnl_json, top_winners_json,
       top_themes_json, model_metrics_json, cultural_summary, trump_post_count, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  };
  return stmts;
}

function dayKey(d = new Date()) { return d.toISOString().slice(0, 10); }

function dayBoundsMs(dateStr) {
  const d = new Date(dateStr + 'T00:00:00.000Z');
  const start = d.getTime();
  const end = start + 86400000;
  return { start, end };
}

// Build a single day's condensate. Idempotent — safe to re-run.
function buildCondensate(dateStr) {
  const d = db();
  const { start, end } = dayBoundsMs(dateStr);

  // Mint flow
  const mintRow = d.prepare(`SELECT
      COUNT(*) AS created,
      SUM(CASE WHEN migrated = 1 AND migrated_at >= ? AND migrated_at < ? THEN 1 ELSE 0 END) AS migrated
    FROM mints WHERE created_at >= ? AND created_at < ?`).get(start, end, start, end);

  // Trade flow
  const tradeRow = d.prepare(`SELECT
      COUNT(*) AS n_trades,
      COUNT(DISTINCT wallet) AS unique_traders,
      SUM(CASE WHEN is_buy = 1 THEN 1 ELSE 0 END) AS buys
    FROM trades WHERE timestamp >= ? AND timestamp < ?`).get(start, end);

  // Tracked-wallet activity
  const trackedRow = d.prepare(`SELECT
      SUM(CASE WHEN w.tracked = 1 AND t.is_buy = 1 THEN 1 ELSE 0 END) AS tracked_buys,
      SUM(CASE WHEN w.is_kol = 1 AND t.is_buy = 1 THEN 1 ELSE 0 END) AS kol_buys
    FROM trades t JOIN wallets w ON w.address = t.wallet
    WHERE t.timestamp >= ? AND t.timestamp < ?`).get(start, end);

  // Population outcome rates from labeled snapshots that resolved on this day
  const popRow = d.prepare(`SELECT
      AVG(peaked_30) AS p30, AVG(peaked_100) AS p100, AVG(peaked_300) AS p300,
      AVG(migrated) AS mig, AVG(peak_pct_max) AS peak
    FROM ml_mint_snapshots WHERE labels_resolved_at >= ? AND labels_resolved_at < ?
    AND snapshot_age_sec = 60`).get(start, end);

  // Per-strategy daily PnL
  const stratRows = d.prepare(`SELECT strategy, ROUND(SUM(realized_pnl_sol), 4) AS pnl
    FROM paper_positions
    WHERE status = 'closed' AND exited_at >= ? AND exited_at < ?
    GROUP BY strategy`).all(start, end);
  const stratPnl = {};
  for (const r of stratRows) stratPnl[r.strategy] = r.pnl;

  // Top winners by peak pct from labeled snapshots
  const winnerRows = d.prepare(`SELECT DISTINCT m.mint_address, m.name, m.symbol,
      MAX(s.peak_pct_max) AS peak_pct, MAX(s.migrated) AS migrated
    FROM ml_mint_snapshots s
    JOIN mints m ON m.mint_address = s.mint_address
    WHERE s.labels_resolved_at >= ? AND s.labels_resolved_at < ?
    AND s.peak_pct_max >= 1.0
    GROUP BY m.mint_address ORDER BY MAX(s.peak_pct_max) DESC LIMIT 10`).all(start, end);
  const topWinners = winnerRows.map(w => ({
    mint: w.mint_address.slice(0, 16),
    name: (w.name || '').slice(0, 40),
    symbol: w.symbol,
    peak_pct: Math.round((w.peak_pct || 0) * 100),
    migrated: !!w.migrated,
  }));

  // Top themes from news + trends that day
  const themeRows = d.prepare(`SELECT keyword, SUM(score) AS total_score, COUNT(DISTINCT source) AS source_count
    FROM trend_signals WHERE ts >= ? AND ts < ?
    GROUP BY keyword ORDER BY total_score DESC LIMIT 15`).all(start, end);
  const topThemes = themeRows.map(t => ({ keyword: t.keyword, score: t.total_score, sources: t.source_count }));

  // Model metrics — snapshot of current models at day-end
  let modelMetrics = null;
  try {
    if (fs.existsSync(MODELS_DIR)) {
      modelMetrics = {};
      for (const f of fs.readdirSync(MODELS_DIR)) {
        if (!f.endsWith('_v1.json') || f.includes('smoke')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, f), 'utf8'));
          modelMetrics[j.target] = j.metrics;
        } catch {}
      }
    }
  } catch {}

  // Cultural summary — latest synthesis from that day (if any)
  const synth = d.prepare(`SELECT summary FROM agent_meta_synthesis
     WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1`).get(start, end);

  // Trump activity
  const trumpCount = d.prepare(`SELECT COUNT(*) AS n FROM news_items
     WHERE source='truth-social:trump' AND ts >= ? AND ts < ?`).get(start, end).n;

  S().insertCondensate.run(
    dateStr, Date.now(),
    mintRow.created || 0, mintRow.migrated || 0,
    tradeRow.n_trades || 0, tradeRow.unique_traders || 0,
    popRow?.p30 || 0, popRow?.p100 || 0, popRow?.p300 || 0, popRow?.mig || 0, popRow?.peak || 0,
    trackedRow?.tracked_buys || 0, trackedRow?.kol_buys || 0,
    JSON.stringify(stratPnl),
    JSON.stringify(topWinners),
    JSON.stringify(topThemes),
    modelMetrics ? JSON.stringify(modelMetrics) : null,
    synth?.summary || null,
    trumpCount,
    null,
  );
  return { dateStr, mintsCreated: mintRow.created, trades: tradeRow.n_trades, winners: topWinners.length };
}

function condenseTick() {
  try {
    // Build yesterday's condensate (and any prior days that don't have one yet)
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let daysBack = 1; daysBack <= 14; daysBack++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - daysBack);
      const dk = dayKey(d);
      if (S().hasCondensateForDay.get(dk)) continue;
      const r = buildCondensate(dk);
      console.log(`[condensate] built ${dk}: ${r.mintsCreated} mints, ${r.trades} trades, ${r.winners} winners captured`);
    }
  } catch (err) { console.error('[condensate] err:', err.message); }
}

async function pruneTick() {
  try {
    const d = db();
    const now = Date.now();
    const tradesCutoff = now - TRADES_RETENTION_HOURS * 3600000;
    const predictionsCutoff = now - PREDICTIONS_RETENTION_DAYS * 86400000;
    const liveConditionsCutoff = now - LIVE_CONDITIONS_RETENTION_DAYS * 86400000;
    const frictionCutoff = now - FRICTION_LOG_RETENTION_DAYS * 86400000;
    const signalsCutoff = now - SIGNALS_RETENTION_DAYS * 86400000;
    const webhookDlCutoff = now - WEBHOOK_DL_RETENTION_DAYS * 86400000;
    const microstructureCutoff = now - COLD_MICROSTRUCTURE_HOURS * 3600000;

    // SAFETY GUARD: refuse to prune if we don't have a fresh condensate for
    // yesterday. Otherwise we'd drop trades without ever capturing them.
    const yesterday = new Date(now - 86400000);
    yesterday.setUTCHours(0, 0, 0, 0);
    const yesterdayKey = dayKey(yesterday);
    if (!S().hasCondensateForDay.get(yesterdayKey)) {
      console.log(`[prune] SKIPPED — no condensate for ${yesterdayKey} yet (will run after condensate completes)`);
      return;
    }

    // ARCHIVE GUARD: dump unarchived days to MEGA Parquet before pruning. If
    // any day-batch fails to upload, refuse to prune trades older than that
    // day — we never delete unarchived raw data (lesson from 2026-05-09).
    try {
      const { archiveOldTrades, canPruneBefore } = await import('./cold-archive.js');
      await archiveOldTrades({ verbose: true });
      const guard = canPruneBefore(tradesCutoff);
      if (!guard.ok) {
        console.warn(`[prune] SKIPPED trades — unarchived days remain: ${guard.unarchivedDays.join(', ')}`);
        // Continue with non-trade prune (preds/conditions/etc are not archived; they're OK to drop)
        const predDel = d.prepare(`DELETE FROM ml_predictions WHERE timestamp < ?`).run(predictionsCutoff).changes;
        const condDel = d.prepare(`DELETE FROM live_conditions WHERE timestamp < ?`).run(liveConditionsCutoff).changes;
        if (predDel + condDel > 0) console.log(`[prune] partial: preds=${predDel} conditions=${condDel}`);
        return;
      }
    } catch (err) {
      console.error(`[prune] archive failed; SKIPPING trades prune: ${err.message}`);
      return;
    }

    const tradesDel = d.prepare(`DELETE FROM trades WHERE timestamp < ?`).run(tradesCutoff).changes;
    const predDel = d.prepare(`DELETE FROM ml_predictions WHERE timestamp < ?`).run(predictionsCutoff).changes;
    const condDel = d.prepare(`DELETE FROM live_conditions WHERE timestamp < ?`).run(liveConditionsCutoff).changes;
    let fricDel = 0; try { fricDel = d.prepare(`DELETE FROM friction_log WHERE timestamp < ?`).run(frictionCutoff).changes; } catch {}
    let sigDel = 0; try { sigDel = d.prepare(`DELETE FROM signals WHERE fired_at < ?`).run(signalsCutoff).changes; } catch {}
    let dlDel = 0; try { dlDel = d.prepare(`DELETE FROM webhook_dead_letter WHERE received_at < ?`).run(webhookDlCutoff).changes; } catch {}
    const microDel = d.prepare(`DELETE FROM mint_microstructure WHERE active_at < ?`).run(microstructureCutoff).changes;

    if (tradesDel + predDel > 0) {
      console.log(`[prune] dropped: trades=${tradesDel} preds=${predDel} conditions=${condDel} friction=${fricDel} signals=${sigDel} webhook-dl=${dlDel} microstructure=${microDel}`);
    }

    // Periodic VACUUM to actually reclaim disk space (SQLite doesn't shrink on its own)
    // Run weekly — VACUUM is heavy
    try {
      const lastVac = d.prepare(`SELECT data_json FROM ml_agent_log WHERE level='info' AND category='maintenance' AND message='vacuum-done' ORDER BY timestamp DESC LIMIT 1`).get();
      const lastVacTs = lastVac ? (JSON.parse(lastVac.data_json || '{}').ts || 0) : 0;
      if (now - lastVacTs > 7 * 86400000) {
        console.log('[prune] VACUUM (weekly cleanup) — may take 30-60s...');
        d.exec('VACUUM');
        d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, message, data_json) VALUES (?, 'info', 'maintenance', 'vacuum-done', ?)`).run(now, JSON.stringify({ ts: now }));
        console.log('[prune] VACUUM complete');
      }
    } catch (err) { console.error('[prune] vacuum err:', err.message); }
  } catch (err) { console.error('[prune] err:', err.message); }
}

export function startIntelligenceCondensate() {
  // First condensate quickly so pruning can run safely on startup
  setTimeout(() => { condenseTick(); pruneTick(); }, FIRST_RUN_DELAY_MS);
  setInterval(condenseTick, CONDENSATE_INTERVAL_MS);
  setInterval(pruneTick, PRUNE_INTERVAL_MS);
  console.log(`[condensate] scheduled · daily condensate every 6h, prune every 6h, retention: trades=${TRADES_RETENTION_HOURS}h preds=${PREDICTIONS_RETENTION_DAYS}d`);
}
