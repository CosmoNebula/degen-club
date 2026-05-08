// Batch trade post-mortem — every 6 hours, Claude analyzes ALL closed agent
// positions in that window as a single block. Finds cross-trade patterns
// ("my losers all had X in common", "winners shared Y") instead of one-off
// per-trade analysis. Strategic insights > tactical observations.
//
// Output is one log entry per batch, surfaced to the agent's next strategy
// proposal cycle as feedback.

import { db } from '../db/index.js';
import { freeformThought } from './agent-llm.js';
import { canConsult, recordConsult } from './agent-rate-limit.js';

const TICK_INTERVAL_MS = 60 * 60 * 1000;        // check hourly
const BATCH_WINDOW_MS = 6 * 60 * 60 * 1000;     // 6h batch window
const MIN_TRADES_FOR_BATCH = 3;                 // skip if too few trades to find patterns
const FIRST_RUN_DELAY_MS = 30 * 60 * 1000;      // 30min after boot
const STATE_KEY = 'agent_postmortem_last_batch_at';

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    getCursor: d.prepare(`SELECT data_json FROM ml_agent_log
       WHERE level = 'cursor' AND category = ? LIMIT 1`),
    setCursor: d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, message, data_json)
       VALUES (?, 'cursor', ?, ?, ?)`),
    deleteCursor: d.prepare(`DELETE FROM ml_agent_log WHERE level = 'cursor' AND category = ?`),
    closedSince: d.prepare(`SELECT * FROM paper_positions
       WHERE status = 'closed'
         AND strategy LIKE 'agent_%'
         AND COALESCE(exited_at, updated_at) > ?
       ORDER BY id ASC`),
    log: d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?)`),
    strategyById: d.prepare(`SELECT * FROM ml_agent_strategies WHERE id = ?`),
  };
  return stmts;
}

function readCursor() {
  const row = S().getCursor.get(STATE_KEY);
  if (!row?.data_json) return 0;
  try { return JSON.parse(row.data_json).last_batch_at || 0; } catch { return 0; }
}
function writeCursor(ts) {
  S().deleteCursor.run(STATE_KEY);
  S().setCursor.run(Date.now(), STATE_KEY, `last_batch_at=${ts}`, JSON.stringify({ last_batch_at: ts }));
}

// Compact one-line representation of a closed trade so we can fit many
// in a single Claude prompt without blowing the budget.
function fmtTradeRow(p, idx) {
  const heldMin = ((p.exited_at || p.updated_at || p.entered_at) - p.entered_at) / 60000;
  const realizedPct = p.realized_pnl_pct != null ? p.realized_pnl_pct.toFixed(1) : '?';
  const peakPct = p.highest_pct != null ? p.highest_pct.toFixed(1) : '?';
  let signal = {};
  try { signal = JSON.parse(p.entry_signal || '{}'); } catch {}
  const preds = signal.predictions || {};
  const predStr = Object.entries(preds).map(([k, v]) => {
    if (typeof v !== 'number') return `${k}=${v}`;
    if (k === 'time_to_peak_sec') return `${k}=${Math.round(v)}s`;
    return `${k}=${v.toFixed(2)}`;
  }).join(' ');
  return `${idx}. ${p.strategy} · ${p.mint_address.slice(0, 8)}…
    entry: ${p.entry_sol?.toFixed(3)} SOL @ mcap=${p.entry_mcap_sol?.toFixed(1)}
    exit: ${p.exit_reason} after ${heldMin.toFixed(1)}min
    result: pnl=${realizedPct}% (peak ${peakPct}%)
    preds@entry: ${predStr}`;
}

// Group trades by strategy for the prompt — easier for Claude to spot
// patterns "within strategy X" vs "across strategies"
function fmtBatch(trades) {
  const byStrat = {};
  for (const t of trades) {
    if (!byStrat[t.strategy]) byStrat[t.strategy] = [];
    byStrat[t.strategy].push(t);
  }
  const lines = [];
  let idx = 1;
  for (const [stratId, list] of Object.entries(byStrat)) {
    const strat = S().strategyById.get(stratId);
    let recipe = null;
    try { recipe = strat ? JSON.parse(strat.recipe_json) : null; } catch {}
    const wins = list.filter(t => (t.realized_pnl_sol || 0) > 0).length;
    const totalPnl = list.reduce((a, t) => a + (t.realized_pnl_sol || 0), 0);
    lines.push(`\n=== ${stratId} (${list.length} trades, ${wins} wins, ${totalPnl.toFixed(4)} SOL) ===`);
    if (recipe) {
      lines.push(`recipe rationale: ${recipe.rationale || '—'}`);
      lines.push(`entry conditions: ${JSON.stringify(recipe.entry?.conditions || [])}`);
      lines.push(`exit logic: ${JSON.stringify(recipe.exit || {})}`);
    }
    lines.push('trades:');
    for (const t of list) {
      lines.push(fmtTradeRow(t, idx++));
    }
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are reviewing your last 6 hours of paper trading as the agent who created these strategies.

Look at all the closed trades grouped by strategy. Find PATTERNS, not one-off observations. Specifically:
- What did your winners have in common? (predictions at entry, exit reasons, mint characteristics)
- What did your losers share?
- Is your exit logic working — are you getting chopped, stopped out too early, holding too long?
- Are some strategies clearly outperforming others?
- Is there a specific entry condition that turned out to be misleading?
- Concrete next move: tighten/loosen what threshold? Retire what strategy? Try what variant next?

Be DIRECT. Use specific numbers from the data. 6-10 sentences total. End with one ACTIONABLE LESSON for your next strategy proposal cycle. The output goes back into your own context — write it for future-you.`;

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    const cursorTs = readCursor();
    // Only run if at least BATCH_WINDOW_MS has passed since last batch
    if (cursorTs > 0 && Date.now() - cursorTs < BATCH_WINDOW_MS) return;

    const sinceTs = cursorTs > 0 ? cursorTs : Date.now() - BATCH_WINDOW_MS;
    const trades = S().closedSince.all(sinceTs);
    if (trades.length < MIN_TRADES_FOR_BATCH) {
      // Not enough trades to find patterns — defer until we have more
      // (don't advance cursor, so they stay in the next batch's window)
      return;
    }

    if (!canConsult('post-mortem')) {
      console.log('[post-mortem] daily Claude cap hit — skipping batch');
      return;
    }

    const ctx = fmtBatch(trades);
    const wins = trades.filter(t => (t.realized_pnl_sol || 0) > 0).length;
    const totalPnl = trades.reduce((a, t) => a + (t.realized_pnl_sol || 0), 0);

    let analysis;
    try {
      recordConsult('post-mortem');
      analysis = await freeformThought(SYSTEM_PROMPT, ctx, 90000);
    } catch (err) {
      console.error('[post-mortem] consult failed:', err.message);
      S().log.run(Date.now(), 'error', 'post-mortem', null,
        `batch post-mortem failed: ${err.message}`, null);
      return;
    }

    const summary = `batch · ${trades.length} trades, ${wins}W/${trades.length - wins}L, ${totalPnl.toFixed(4)} SOL`;
    S().log.run(Date.now(), 'thought', 'post-mortem', null, summary,
      JSON.stringify({
        n_trades: trades.length, wins, total_pnl_sol: totalPnl,
        analysis, window_start_ts: sinceTs,
      }));
    console.log(`[post-mortem] batch · ${summary}`);
    console.log(`[post-mortem]   ${analysis.slice(0, 250).replace(/\n/g, ' ')}`);
    writeCursor(Date.now());
  } finally { _running = false; }
}

export function startPostMortem() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log('[post-mortem] batch watcher started · checks hourly, batches every ~6h');
}
