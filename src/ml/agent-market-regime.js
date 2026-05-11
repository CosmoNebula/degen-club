// Market regime check — twice a day (noon + midnight ET) Claude reviews
// pump.fun-wide stats and outputs a posture: aggressive / normal / cautious.
// Stored in ml_agent_log under category='market-regime' so the latest entry
// is the active regime. Agent reads it in buildContext to inform sizing and
// proposal style ("market is in cautious mode, propose a defensive recipe").

import { db } from '../db/index.js';
import { freeformThought } from './agent-llm.js';
import { canConsult, recordConsult } from './agent-rate-limit.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;   // every 30min, check if it's time
const TARGET_HOURS = [12, 0];               // noon + midnight ET

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    // Mint creation pace
    mintsByWindow: d.prepare(`
      SELECT
        SUM(CASE WHEN created_at > strftime('%s','now')*1000 - 3600000 THEN 1 ELSE 0 END) AS h1,
        SUM(CASE WHEN created_at > strftime('%s','now')*1000 - 6*3600000 THEN 1 ELSE 0 END) AS h6,
        SUM(CASE WHEN created_at > strftime('%s','now')*1000 - 24*3600000 THEN 1 ELSE 0 END) AS h24,
        SUM(CASE WHEN created_at > strftime('%s','now')*1000 - 24*3600000 AND migrated = 1 THEN 1 ELSE 0 END) AS mig_h24,
        SUM(CASE WHEN created_at > strftime('%s','now')*1000 - 24*3600000 AND peak_market_cap_sol >= 100 THEN 1 ELSE 0 END) AS p100_h24,
        SUM(CASE WHEN created_at > strftime('%s','now')*1000 - 24*3600000 AND peak_market_cap_sol >= 300 THEN 1 ELSE 0 END) AS p300_h24,
        AVG(CASE WHEN created_at > strftime('%s','now')*1000 - 24*3600000 THEN peak_market_cap_sol END) AS avg_peak_h24
      FROM mints`),
    // Agent strategy aggregate performance
    agentPerf: d.prepare(`
      SELECT
        COUNT(*) n,
        ROUND(SUM(realized_pnl_sol),3) pnl_sol,
        ROUND(AVG(realized_pnl_pct)*100,1) avg_pct,
        ROUND(100.0*SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END)/COUNT(*),1) win_pct
      FROM paper_positions
      WHERE status = 'closed' AND strategy LIKE 'agent_%' AND exited_at > strftime('%s','now')*1000 - 24*3600000`),
    lastRegime: d.prepare(`SELECT MAX(timestamp) AS ts FROM ml_agent_log
       WHERE category = 'market-regime' AND level = 'thought'`),
    log: d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
       VALUES (?, 'thought', 'market-regime', NULL, ?, ?)`),
  };
  return stmts;
}

const SYSTEM_PROMPT = `You assess pump.fun market regime. Given mint creation
pace, migration rate, peak distribution, and the bot's recent agent-strategy
performance, output a JSON object: {regime: "aggressive"|"normal"|"cautious",
rationale: "<1-2 sentence reason>", suggested_size_mult: <0.5-2.0>}.

- "aggressive" = lots of pumps, easy market, ride bigger
- "normal" = ordinary day, run baseline sizing
- "cautious" = chop / rug-heavy, defensive sizing or pause

Respond with ONLY the JSON object, no prose around it.`;

function shouldFireNow(lastTs) {
  const now = new Date();
  const hour = now.getHours();
  if (!TARGET_HOURS.includes(hour)) return false;
  // Don't double-fire in the same hour window — last entry must be >12h old
  if (lastTs && Date.now() - lastTs < 11 * 3600000) return false;
  return true;
}

function buildPrompt(mints, perf) {
  const m1Rate = (mints?.h1 || 0);
  const m6Rate = ((mints?.h6 || 0) / 6).toFixed(1);
  const m24Rate = ((mints?.h24 || 0) / 24).toFixed(1);
  const migPct = mints?.h24 > 0 ? (((mints?.mig_h24 || 0) / mints.h24) * 100).toFixed(1) : '0';
  const p100Pct = mints?.h24 > 0 ? (((mints?.p100_h24 || 0) / mints.h24) * 100).toFixed(1) : '0';
  const p300Pct = mints?.h24 > 0 ? (((mints?.p300_h24 || 0) / mints.h24) * 100).toFixed(1) : '0';
  const lines = [];
  lines.push('=== PUMP.FUN MARKET (last 24h) ===');
  lines.push(`Mints created: ${mints?.h24 || 0} (last 1h: ${m1Rate}/hr, 6h avg: ${m6Rate}/hr, 24h avg: ${m24Rate}/hr)`);
  lines.push(`Migrated: ${mints?.mig_h24 || 0} (${migPct}% of creations)`);
  lines.push(`Peaked ≥100 SOL mcap: ${mints?.p100_h24 || 0} (${p100Pct}%)`);
  lines.push(`Peaked ≥300 SOL mcap: ${mints?.p300_h24 || 0} (${p300Pct}%)`);
  lines.push(`Avg peak mcap: ${mints?.avg_peak_h24 ? mints.avg_peak_h24.toFixed(1) : '?'} SOL`);
  lines.push('');
  lines.push('=== BOT PERFORMANCE (last 24h) ===');
  if (perf?.n > 0) {
    lines.push(`Closed trades: ${perf.n}, PnL ${perf.pnl_sol} SOL, avg ${perf.avg_pct}%, win rate ${perf.win_pct}%`);
  } else {
    lines.push('No closed agent trades yet');
  }
  lines.push('');
  lines.push('Output the regime assessment as a single JSON object.');
  return lines.join('\n');
}

async function tick() {
  const lastTs = S().lastRegime.get()?.ts || 0;
  if (!shouldFireNow(lastTs)) return;
  if (!canConsult('market-regime')) return;
  const mints = S().mintsByWindow.get();
  const perf = S().agentPerf.get();
  const prompt = buildPrompt(mints, perf);
  let raw;
  try {
    recordConsult('market-regime');
    raw = await freeformThought(SYSTEM_PROMPT, prompt, 60000);
  } catch (err) {
    console.error('[market-regime] consult failed:', err.message);
    return;
  }
  // Parse JSON from response — Claude may wrap in fences
  let parsed = null;
  try {
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) s = fence[1].trim();
    if (!s.startsWith('{')) {
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a >= 0 && b > a) s = s.slice(a, b + 1);
    }
    parsed = JSON.parse(s);
  } catch (err) {
    console.warn('[market-regime] could not parse JSON, storing raw:', err.message);
  }
  const regime = parsed?.regime || 'unknown';
  const rationale = parsed?.rationale || raw.slice(0, 200);
  const msg = `regime: ${regime} — ${rationale}`;
  S().log.run(Date.now(), msg, JSON.stringify({ parsed, raw, mints, perf }));
  console.log(`[market-regime] ${msg}`);
}

export function startMarketRegime() {
  setTimeout(() => tick().catch(err => console.error('[market-regime] err:', err)), 10 * 60 * 1000);
  setInterval(() => tick().catch(err => console.error('[market-regime] err:', err)), CHECK_INTERVAL_MS);
  console.log('[market-regime] scheduled · checks every 30min, fires at noon + midnight ET');
}
