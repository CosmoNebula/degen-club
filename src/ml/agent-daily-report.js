// Daily report card — once per day, Claude reviews everything that happened
// and writes a 1-paragraph recap. Stored in ml_agent_log + surfaced on the
// dashboard. The user reads it; the agent ALSO reads it on its next cycle as
// part of context. So it's both a UX feature AND an agent-learning input.

import { db } from '../db/index.js';
import { freeformThought } from './agent-llm.js';
import { getModelHealth } from './drift-monitor.js';
import { canConsult, recordConsult } from './agent-rate-limit.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;  // every 30 min, check if it's time

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    lastReport: d.prepare(`SELECT MAX(timestamp) AS ts FROM ml_agent_log
       WHERE level = 'info' AND category = 'daily-report'`),
    log: d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, message, data_json)
       VALUES (?, 'info', 'daily-report', ?, ?)`),
    overallStats: d.prepare(`SELECT
       (SELECT COUNT(*) FROM ml_mint_snapshots WHERE snapshot_ts > strftime('%s','now')*1000 - 86400000) AS snaps_24h,
       (SELECT COUNT(*) FROM ml_predictions WHERE timestamp > strftime('%s','now')*1000 - 86400000) AS preds_24h,
       (SELECT COUNT(*) FROM ml_mint_snapshots WHERE labels_resolved_at > strftime('%s','now')*1000 - 86400000) AS labeled_24h
    `),
    paperSummary: d.prepare(`SELECT
       (SELECT COUNT(*) FROM paper_positions WHERE strategy LIKE 'agent_%' AND entered_at > strftime('%s','now')*1000 - 86400000) AS opened,
       (SELECT COUNT(*) FROM paper_positions WHERE strategy LIKE 'agent_%' AND status='closed' AND exited_at > strftime('%s','now')*1000 - 86400000) AS closed,
       (SELECT ROUND(SUM(realized_pnl_sol),4) FROM paper_positions WHERE strategy LIKE 'agent_%' AND status='closed' AND exited_at > strftime('%s','now')*1000 - 86400000) AS pnl_sol,
       (SELECT COUNT(*) FROM paper_positions WHERE strategy LIKE 'agent_%' AND status='closed' AND exited_at > strftime('%s','now')*1000 - 86400000 AND realized_pnl_sol > 0) AS wins
    `),
    strategiesCreated: d.prepare(`SELECT id, name, status FROM ml_agent_strategies
       WHERE created_at > strftime('%s','now')*1000 - 86400000`),
    strategiesRetired: d.prepare(`SELECT id, name, retired_reason FROM ml_agent_strategies
       WHERE retired_at > strftime('%s','now')*1000 - 86400000 AND status = 'retired'`),
    consultsCount: d.prepare(`SELECT COUNT(*) AS n FROM ml_agent_log
       WHERE category = 'consult' AND timestamp > strftime('%s','now')*1000 - 86400000`),
  };
  return stmts;
}

function buildContext() {
  const s = S();
  const stats = s.overallStats.get();
  const paper = s.paperSummary.get();
  const created = s.strategiesCreated.all();
  const retired = s.strategiesRetired.all();
  const consults = s.consultsCount.get();
  const drift = (() => { try { return getModelHealth(); } catch { return null; } })();

  const lines = [];
  lines.push('=== LAST 24 HOURS ===');
  lines.push(`Snapshots collected: ${stats.snaps_24h}`);
  lines.push(`Labels resolved: ${stats.labeled_24h}`);
  lines.push(`Predictions made: ${stats.preds_24h}`);
  lines.push('');
  lines.push('=== AGENT TRADING ===');
  lines.push(`Positions opened: ${paper.opened}`);
  lines.push(`Positions closed: ${paper.closed}`);
  lines.push(`Wins: ${paper.wins}/${paper.closed}`);
  lines.push(`Realized PnL: ${paper.pnl_sol || 0} SOL`);
  lines.push('');
  lines.push('=== STRATEGY ACTIVITY ===');
  if (created.length === 0 && retired.length === 0) {
    lines.push('No strategies created or retired in the last 24h.');
  } else {
    for (const c of created) lines.push(`Created: ${c.id} (${c.name}) [status=${c.status}]`);
    for (const r of retired) lines.push(`Retired: ${r.id} (${r.name}) — reason: ${r.retired_reason}`);
  }
  lines.push(`Claude consults: ${consults.n}`);
  lines.push('');
  lines.push('=== MODEL HEALTH ===');
  if (drift) {
    lines.push(`Overall: ${drift.overall} · ${drift.freshness?.message || ''}`);
    for (const t of (drift.targets || []).slice(0, 5)) {
      const cm = t.current || {};
      const pm = t.previous || {};
      const headline = t.mode === 'regression'
        ? `R²=${(cm.r2 || 0).toFixed(3)} (was ${(pm.r2 || 0).toFixed(3)})`
        : `AUC-ROC=${(cm.auc_roc || 0).toFixed(3)} (was ${(pm.auc_roc || 0).toFixed(3)})`;
      lines.push(`  ${t.target}: ${headline} [${t.level}]`);
    }
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are writing a daily recap for the user (and your future self) about the autonomous trading agent's activity.

Write 1 short paragraph (4-7 sentences). Style: concise, direct, no buzzwords. Cover:
- What happened today (data growth, trades, wins/losses)
- What the models are doing (any drift, anything notable)
- What the agent learned or decided
- What you'd be watching tomorrow

End with one sentence that's an action-able-thought for the user (or yourself) — not a generic "keep collecting data" platitude.`;

async function maybeReport() {
  const s = S();
  const last = s.lastReport.get();
  const lastTs = last?.ts || 0;
  // Only fire if it's been ≥22 hours since the last report (give or take to align with day boundaries)
  if (Date.now() - lastTs < 22 * 60 * 60 * 1000) return;
  if (!canConsult('daily-report')) return;
  const ctx = buildContext();
  let recap;
  try {
    recordConsult('daily-report');
    recap = await freeformThought(SYSTEM_PROMPT, ctx, 60000);
  } catch (err) {
    console.error('[daily-report] consult failed:', err.message);
    s.log.run(Date.now(), `daily report failed: ${err.message}`, null);
    return;
  }
  s.log.run(Date.now(), `daily report: ${recap.slice(0, 100).replace(/\n/g, ' ')}…`,
    JSON.stringify({ recap, context: ctx }));
  console.log(`[daily-report] ${recap.replace(/\n/g, ' ')}`);
}

export function startDailyReport() {
  setTimeout(maybeReport, 10 * 60 * 1000);  // first check 10min after boot
  setInterval(maybeReport, CHECK_INTERVAL_MS);
  console.log('[daily-report] scheduled · checks every 30min, fires every ~24h');
}
