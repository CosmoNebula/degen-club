// Exit-reason concentration check — every 6h scans the last 24h of closed
// paper positions. If any single exit_reason dominates (≥25% of trades AND
// n≥30), Claude diagnoses why and proposes a config tweak. Catches systemic
// failures the user used to spot manually ("STALE_QUOTE_PAPER is killing us
// — why?").
//
// Output stored in ml_agent_log under category='concentration-check', fed
// into next strategy-proposal cycle so the lesson compounds.

import { db } from '../db/index.js';
import { freeformThought } from './agent-llm.js';
import { canConsult, recordConsult } from './agent-rate-limit.js';

const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // every 6h
const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;     // 15min after boot
const WINDOW_MS = 24 * 60 * 60 * 1000;         // look at last 24h
const MIN_TRADES = 30;                          // need enough volume to be signal
const CONCENTRATION_THRESHOLD = 0.25;           // 25% of trades

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    distribution: d.prepare(`
      SELECT exit_reason, COUNT(*) n, ROUND(AVG(realized_pnl_pct)*100,1) avg_pct,
             ROUND(SUM(realized_pnl_sol),3) pnl_sol
      FROM paper_positions
      WHERE status = 'closed'
        AND strategy LIKE 'agent_%'
        AND COALESCE(exited_at, updated_at) > ?
      GROUP BY exit_reason
      ORDER BY n DESC`),
    totalClosed: d.prepare(`SELECT COUNT(*) n FROM paper_positions
       WHERE status = 'closed' AND strategy LIKE 'agent_%' AND COALESCE(exited_at, updated_at) > ?`),
    sampleTrades: d.prepare(`
      SELECT p.id, p.strategy, p.mint_address, p.entry_price, p.entry_mcap_sol,
             p.exit_price, p.exit_mcap_sol, p.realized_pnl_pct, p.highest_pct,
             p.entry_signal, p.tiers_hit, ROUND(((p.exited_at - p.entered_at)/60000.0),1) held_min
      FROM paper_positions p
      WHERE status = 'closed' AND p.exit_reason = ?
        AND p.strategy LIKE 'agent_%'
        AND COALESCE(p.exited_at, p.updated_at) > ?
      ORDER BY p.exited_at DESC LIMIT 8`),
    log: d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
       VALUES (?, 'info', 'concentration-check', ?, ?, ?)`),
    logThought: d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
       VALUES (?, 'thought', 'concentration-check', ?, ?, ?)`),
  };
  return stmts;
}

const SYSTEM_PROMPT = `You are an algo-trading post-mortem analyst. The agent's
deployed strategy is bleeding through one specific failure mode. Your job: in
3-6 short sentences, diagnose what's structurally wrong and recommend ONE
specific recipe change the agent should consider. Be direct and concrete.
No platitudes, no "consider more data." Reference the exit_reason mechanics:

- STALE_QUOTE_PAPER:Xx% — buy fired but fill drifted >maxEntrySlippagePct. Fix is either lower latency, higher slippage tolerance, or stricter entry-price freshness check.
- SL_HIT — stop-loss tripped. Fix is wider SL, tighter entry filter, or different exit ladder.
- POST_T1_TRAIL / MOONBAG_TRAIL — trailing stop fired. Fix is wider trail or arming threshold.
- FAKE_PUMP / FAST_FAIL — early-exit modes for pumps that died fast. Fix is filter criteria or disable these modes.
- TIME_EXIT — held to max_hold_min. Fix is target threshold, trail, or longer hold.
- PEAK_FLOOR / TIER_1 (early) — exited very fast. Fix is later trigger.
- TIER_1, TIER_2, TIER_3 — staged take-profits firing as designed.

Format your response as plain prose, no lists, no headers.`;

function buildPrompt(dominantReason, share, n, distribution, samples) {
  const lines = [];
  lines.push(`Last 24h trade exit distribution (n=${n} total):`);
  for (const r of distribution.slice(0, 8)) {
    const pct = ((r.n / n) * 100).toFixed(0);
    lines.push(`  - ${r.exit_reason || '(null)'}: ${r.n} trades (${pct}%), avg ${r.avg_pct}%, PnL ${r.pnl_sol} SOL`);
  }
  lines.push('');
  lines.push(`DOMINATING: ${dominantReason} = ${(share*100).toFixed(0)}% of last 24h. Sample trades:`);
  for (const s of samples) {
    let preds = '';
    try {
      const sig = JSON.parse(s.entry_signal || '{}');
      const p = sig.predictions || {};
      preds = ` preds: p100=${(p.peaked_100||0).toFixed(2)} mig=${(p.migrated||0).toFixed(2)} peakMax=${(p.peak_pct_max||0).toFixed(2)}`;
    } catch {}
    const tiers = (() => { try { return JSON.parse(s.tiers_hit || '[]').join('|') || 'none'; } catch { return 'none'; } })();
    lines.push(`  · ${s.strategy} ${s.mint_address.slice(0,8)} held ${s.held_min}m, peak ${(s.highest_pct||0).toFixed(0)}%, pnl ${(s.realized_pnl_pct*100).toFixed(0)}%, tiers ${tiers}${preds}`);
  }
  lines.push('');
  lines.push(`What is structurally wrong and what's ONE concrete change to try?`);
  return lines.join('\n');
}

async function tick() {
  if (!canConsult('concentration-check')) return;
  const cutoff = Date.now() - WINDOW_MS;
  const total = S().totalClosed.get(cutoff);
  const n = total?.n || 0;
  if (n < MIN_TRADES) return;
  const distribution = S().distribution.all(cutoff);
  if (!distribution.length) return;
  const top = distribution[0];
  const share = top.n / n;
  if (share < CONCENTRATION_THRESHOLD) {
    // Healthy mix — no dominant failure mode. Log a brief note so the user
    // can see the check ran without paying for a Claude call.
    S().log.run(Date.now(), null,
      `concentration check: top exit_reason ${top.exit_reason} = ${(share*100).toFixed(0)}% of ${n} trades (below ${(CONCENTRATION_THRESHOLD*100).toFixed(0)}% trigger) — no consult`,
      JSON.stringify({ n, top: top.exit_reason, share, distribution }));
    return;
  }
  const samples = S().sampleTrades.all(top.exit_reason, cutoff);
  const prompt = buildPrompt(top.exit_reason, share, n, distribution, samples);
  let diagnosis;
  try {
    recordConsult('concentration-check');
    diagnosis = await freeformThought(SYSTEM_PROMPT, prompt, 60000);
  } catch (err) {
    console.error('[concentration-check] consult failed:', err.message);
    S().log.run(Date.now(), null, `consult failed: ${err.message}`, null);
    return;
  }
  S().logThought.run(Date.now(), null,
    `${top.exit_reason} dominates (${(share*100).toFixed(0)}% of ${n}): ${diagnosis.slice(0,140).replace(/\n/g,' ')}…`,
    JSON.stringify({ exit_reason: top.exit_reason, share, n, distribution, diagnosis }));
  console.log(`[concentration-check] ${top.exit_reason} = ${(share*100).toFixed(0)}% of ${n} → ${diagnosis.slice(0,120).replace(/\n/g,' ')}`);
}

export function startConcentrationCheck() {
  setTimeout(() => tick().catch(err => console.error('[concentration-check] err:', err)), FIRST_RUN_DELAY_MS);
  setInterval(() => tick().catch(err => console.error('[concentration-check] err:', err)), TICK_INTERVAL_MS);
  console.log(`[concentration-check] scheduled · every 6h · fires if any exit_reason ≥${CONCENTRATION_THRESHOLD*100}% of last 24h trades (n≥${MIN_TRADES})`);
}
