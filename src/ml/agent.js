// Autonomous ML trading agent.
//
// Every 30 minutes the agent runs an introspection cycle:
//   1. Update its readiness assessment (calibration validated? edge measurable?)
//   2. If ready and no live strategy exists yet → consult Claude, propose one
//   3. Evaluate each live strategy's PnL — consult Claude on whether to retire
//   4. Log every thought to ml_agent_log so the user can read its reasoning
//
// The only thing the agent CANNOT do is flip live trading on. Everything else
// — strategy creation, sizing, exits, retirement — is the agent's call.

import { db } from '../db/index.js';
import { proposeStrategy, evaluateStrategy } from './agent-llm.js';
import { deployStrategy, retireStrategy, startAgentExecutor } from './agent-executor.js';
import { startPostMortem } from './agent-post-mortem.js';
import { startDailyReport } from './agent-daily-report.js';
import { startCalibrationReview } from './agent-calibration-review.js';
import { startMintIntel } from './agent-mint-intel.js';
import { canConsult, recordConsult, getRateLimitState, BURST_CAPS } from './agent-rate-limit.js';
import { getModelHealth } from './drift-monitor.js';

const CYCLE_INTERVAL_MS = 30 * 60 * 1000;   // 30 min
const FIRST_CYCLE_DELAY_MS = 5 * 60 * 1000; // 5 min after boot — let things stabilize
const STRATEGY_SOAK_HOURS = 24;             // don't evaluate retirement until strategy has run 24h
const MAX_CONSULTS_PER_DAY = 12;            // soft rate limit on LLM calls

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    state: d.prepare(`SELECT * FROM ml_agent_state WHERE id = 1`),
    updateState: d.prepare(`UPDATE ml_agent_state SET
       status = ?, readiness_json = ?, last_cycle_at = ?, current_thought = ?, updated_at = ? WHERE id = 1`),
    bumpConsult: d.prepare(`UPDATE ml_agent_state SET
       last_consult_at = ?, consults_today = consults_today + 1, consult_day_key = ? WHERE id = 1`),
    resetConsults: d.prepare(`UPDATE ml_agent_state SET consults_today = 0, consult_day_key = ? WHERE id = 1`),
    log: d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?)`),
    liveStrategies: d.prepare(`SELECT * FROM ml_agent_strategies WHERE status = 'live'`),
    insertStrategy: d.prepare(`INSERT INTO ml_agent_strategies
       (id, name, rationale, recipe_json, status, created_at)
       VALUES (?, ?, ?, ?, 'live', ?)`),
    // Calibration data
    calibrationStats: d.prepare(`
      SELECT COUNT(*) AS n,
             AVG((p.prob - COALESCE(s.peaked_30, 0)) * (p.prob - COALESCE(s.peaked_30, 0))) AS brier
      FROM ml_predictions p
      JOIN ml_mint_snapshots s ON s.mint_address = p.mint_address
      WHERE p.target = 'peaked_30'
        AND p.prob IS NOT NULL
        AND s.labels_resolved_at IS NOT NULL
        AND s.peaked_30 IS NOT NULL
    `),
    // Recent strategy performance
    strategyPerf: d.prepare(`SELECT
       (SELECT COUNT(*) FROM paper_positions WHERE strategy = ? AND status = 'closed') AS closed,
       (SELECT COUNT(*) FROM paper_positions WHERE strategy = ? AND status = 'open') AS open,
       (SELECT ROUND(SUM(realized_pnl_sol), 4) FROM paper_positions WHERE strategy = ? AND status = 'closed') AS pnl_sol,
       (SELECT ROUND(AVG(realized_pnl_pct), 2) FROM paper_positions WHERE strategy = ? AND status = 'closed') AS avg_pct,
       (SELECT COUNT(*) FROM paper_positions WHERE strategy = ? AND status = 'closed' AND realized_pnl_sol > 0) AS wins
    `),
    // Top-level data the agent reasons about
    overallStats: d.prepare(`SELECT
       (SELECT COUNT(*) FROM ml_mint_snapshots) AS snapshots_total,
       (SELECT COUNT(*) FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL) AS snapshots_labeled,
       (SELECT COUNT(*) FROM ml_predictions) AS predictions_total
    `),
    bestEdgeQuery: d.prepare(`
      SELECT p.target,
             COUNT(*) AS n,
             AVG(s.peaked_30) AS p30_rate,
             AVG(s.peaked_100) AS p100_rate,
             AVG(s.migrated) AS mig_rate,
             AVG(s.peak_pct_max) AS avg_peak_pct
      FROM ml_predictions p
      JOIN ml_mint_snapshots s ON s.mint_address = p.mint_address
      WHERE p.prob IS NOT NULL
        AND p.prob > 0.30
        AND s.labels_resolved_at IS NOT NULL
        AND p.timestamp > strftime('%s','now')*1000 - 7*86400000
      GROUP BY p.target
    `),
    baselineRates: d.prepare(`SELECT
       AVG(peaked_30) AS p30, AVG(peaked_100) AS p100, AVG(migrated) AS mig,
       AVG(peak_pct_max) AS peak_avg
       FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL`),
    // Feedback loop inputs — read on every introspection
    recentPostMortems: d.prepare(`SELECT timestamp, message, data_json
       FROM ml_agent_log WHERE category = 'post-mortem' AND level = 'thought'
       ORDER BY timestamp DESC LIMIT 4`),
    latestCalibReview: d.prepare(`SELECT timestamp, data_json
       FROM ml_agent_log WHERE category = 'calibration-review' AND level = 'info'
         AND data_json IS NOT NULL
       ORDER BY timestamp DESC LIMIT 1`),
    latestDailyReport: d.prepare(`SELECT timestamp, data_json
       FROM ml_agent_log WHERE category = 'daily-report' AND level = 'info'
         AND data_json IS NOT NULL
       ORDER BY timestamp DESC LIMIT 1`),
    mintIntelTally: d.prepare(`SELECT verdict, COUNT(*) AS n FROM ml_mint_intel
       WHERE analyzed_at > strftime('%s','now')*1000 - 86400000 GROUP BY verdict`),
  };
  return stmts;
}

function dayKey() { return new Date().toISOString().slice(0, 10); }

function logThought(level, category, strategyId, message, data) {
  try {
    S().log.run(Date.now(), level, category, strategyId, message,
      data ? JSON.stringify(data) : null);
  } catch (err) { console.error('[agent] log err:', err.message); }
}

// Build the data context the agent reasons about. This is what we paste into
// the Claude consult prompt. Keep it dense — the agent should be able to make
// real numerical comparisons, not vague hand-wavey reasoning.
function buildContext() {
  const s = S();
  const overall = s.overallStats.get();
  const baseline = s.baselineRates.get();
  const calib = s.calibrationStats.get();
  const edge = s.bestEdgeQuery.all();
  const drift = (() => { try { return getModelHealth(); } catch { return null; } })();
  const liveStrategies = s.liveStrategies.all();

  const lines = [];
  lines.push('=== DATA SO FAR ===');
  lines.push(`Total snapshots collected: ${overall.snapshots_total}`);
  lines.push(`Snapshots with resolved labels: ${overall.snapshots_labeled}`);
  lines.push(`Predictions logged: ${overall.predictions_total}`);
  lines.push('');
  lines.push('=== BASELINE OUTCOMES (whole population) ===');
  lines.push(`peaked_30 rate: ${(baseline.p30 * 100).toFixed(2)}%`);
  lines.push(`peaked_100 rate: ${(baseline.p100 * 100).toFixed(2)}%`);
  lines.push(`migrated rate: ${(baseline.mig * 100).toFixed(2)}%`);
  lines.push(`avg peak %: ${(baseline.peak_avg * 100).toFixed(2)}%`);
  lines.push('');
  lines.push('=== MODEL HEALTH ===');
  if (drift) {
    lines.push(`Overall model health: ${drift.overall} · ${drift.freshness?.message || ''}`);
    for (const t of (drift.targets || [])) {
      const cm = t.current || {};
      if (t.mode === 'regression') {
        lines.push(`  ${t.target}: REG R²=${(cm.r2 || 0).toFixed(3)} · n_train=${t.n_train}`);
      } else {
        lines.push(`  ${t.target}: AUC-ROC=${(cm.auc_roc || 0).toFixed(3)} AUC-PR=${(cm.auc_pr || 0).toFixed(3)} lift=${(cm.lift || 0).toFixed(1)}x · n_train=${t.n_train}`);
      }
    }
  }
  lines.push('');
  lines.push('=== CALIBRATION ===');
  if (calib && calib.n > 0) {
    lines.push(`Predictions matched against labels: ${calib.n}`);
    lines.push(`Brier score (peaked_30): ${calib.brier?.toFixed(4) || '—'}  (lower=better, 0=perfect)`);
  } else {
    lines.push('No calibration overlap yet — predictions are too fresh to have aged into the 6h label window.');
  }
  lines.push('');
  lines.push('=== EDGE (top-30%-prob mints, last 7d) ===');
  for (const e of edge) {
    lines.push(`  ${e.target} > 0.30 (n=${e.n}): peaked_30=${(e.p30_rate * 100).toFixed(1)}%, peaked_100=${(e.p100_rate * 100).toFixed(1)}%, mig=${(e.mig_rate * 100).toFixed(1)}%, avg_peak=${(e.avg_peak_pct * 100).toFixed(1)}%`);
  }
  lines.push('');
  lines.push('=== ACTIVE STRATEGIES ===');
  if (liveStrategies.length === 0) {
    lines.push('You have no active strategies yet.');
  } else {
    for (const st of liveStrategies) {
      const perf = s.strategyPerf.get(st.id, st.id, st.id, st.id, st.id);
      lines.push(`  ${st.id}: ${perf.closed} closed trades, ${perf.open} open, ${perf.pnl_sol || 0} SOL realized, avg trade ${perf.avg_pct || 0}%`);
    }
  }
  lines.push('');
  lines.push('=== FRICTION ===');
  lines.push('Realistic exit costs: ~3-8% slippage on entry, ~5-10% on exit, plus priority fee (~0.005 SOL contested).');
  lines.push('A predicted +30% peak is barely break-even after friction. Need clear edge above that.');

  // Feedback loop — surface what we've LEARNED from past trades and reviews
  const calibReview = s.latestCalibReview.get();
  if (calibReview?.data_json) {
    try {
      const c = JSON.parse(calibReview.data_json);
      if (c.analysis) {
        lines.push('');
        lines.push('=== CALIBRATION REVIEW (from your last deep-look at model honesty) ===');
        lines.push(c.analysis.slice(0, 2000));
      }
    } catch {}
  }

  const pms = s.recentPostMortems.all();
  if (pms.length > 0) {
    lines.push('');
    lines.push('=== RECENT POST-MORTEM BATCHES (your own pattern analysis of closed trades) ===');
    for (const p of pms) {
      try {
        const d = JSON.parse(p.data_json || '{}');
        if (d.analysis) {
          const summary = `${d.n_trades || '?'} trades · ${d.wins || 0}W · ${(d.total_pnl_sol || 0).toFixed(3)} SOL`;
          lines.push(`[${summary}] ${String(d.analysis).slice(0, 800).replace(/\n/g, ' ')}`);
        }
      } catch {}
    }
  }

  const intelTally = s.mintIntelTally.all();
  if (intelTally.length > 0) {
    lines.push('');
    lines.push('=== MINT INTEL (last 24h verdicts on metadata) ===');
    for (const r of intelTally) lines.push(`  ${r.verdict}: ${r.n}`);
    lines.push('You can require ml_mint_intel.verdict in entry conditions to filter for "winner" mints or exclude "ruggy" ones — but note most mints fall in "clean" bucket.');
  }

  const daily = s.latestDailyReport.get();
  if (daily?.data_json) {
    try {
      const d = JSON.parse(daily.data_json);
      if (d.recap) {
        lines.push('');
        lines.push('=== LAST DAILY REPORT ===');
        lines.push(d.recap.slice(0, 600));
      }
    } catch {}
  }

  return lines.join('\n');
}

// Assess whether the agent is "ready" to propose a strategy. Returns
// { ready: boolean, criteria: { name -> { passed, reason } } }
function assessReadiness() {
  const s = S();
  const overall = s.overallStats.get();
  const calib = s.calibrationStats.get();
  const drift = (() => { try { return getModelHealth(); } catch { return null; } })();
  const live = s.liveStrategies.all();

  const criteria = {};
  // Calibration data exists
  criteria.calibration_data = {
    passed: (calib?.n || 0) >= 100,
    detail: `${calib?.n || 0} predictions matched against labels (need ≥100)`,
  };
  // Calibration is honest (Brier score reasonable for the rare-event class)
  criteria.calibration_honest = {
    passed: calib?.brier != null && calib.brier < 0.10,
    detail: calib?.brier != null
      ? `Brier ${calib.brier.toFixed(4)} (need <0.10)`
      : 'no Brier yet',
  };
  // Models exist and have decent metrics
  criteria.models_trained = {
    passed: overall.snapshots_labeled >= 5000,
    detail: `${overall.snapshots_labeled} labeled snapshots (need ≥5000)`,
  };
  // Drift OK
  criteria.no_drift = {
    passed: drift && drift.overall !== 'red',
    detail: drift ? `model health ${drift.overall}` : 'no drift status',
  };
  // Cap: don't run more than 5 concurrent strategies for sanity
  criteria.under_strategy_cap = {
    passed: live.length < 5,
    detail: `${live.length} active strategies (cap at 5)`,
  };
  const ready = Object.values(criteria).every(c => c.passed);
  return { ready, criteria };
}

// Legacy state-based counter is now mirrored by the shared rate limiter.
// Keep both updated for the dashboard widget that already reads consults_today.
function rateLimitOk() {
  return canConsult('agent');
}

function bumpConsult() {
  recordConsult('agent');
  S().bumpConsult.run(Date.now(), dayKey());  // also bump legacy counter
}

async function maybeProposeStrategy(readiness) {
  if (!readiness.ready) {
    const blockers = Object.entries(readiness.criteria)
      .filter(([_, c]) => !c.passed)
      .map(([name, c]) => `${name}: ${c.detail}`);
    logThought('thought', 'introspect', null,
      `not ready to propose · blocked on: ${blockers.join('; ')}`,
      { criteria: readiness.criteria });
    return;
  }
  // Already have at least one live strategy? Be patient — let it accumulate
  // performance data before proposing variants. We'll consider variants once
  // existing ones have soaked.
  const live = S().liveStrategies.all();
  if (live.length > 0) {
    logThought('thought', 'introspect', null,
      `${live.length} live strategy(ies) running — letting them accumulate trade data before proposing more`, null);
    return;
  }
  if (!rateLimitOk()) {
    logThought('thought', 'introspect', null,
      `rate-limited at ${MAX_CONSULTS_PER_DAY} consults/day — sleeping`, null);
    return;
  }
  const ctx = buildContext();
  logThought('info', 'consult', null, 'consulting Claude to propose a strategy', null);
  bumpConsult();
  let consultResult;
  try {
    consultResult = await proposeStrategy(ctx);
  } catch (err) {
    logThought('error', 'consult', null, `consult failed: ${err.message}`, null);
    return;
  }
  const recipe = consultResult.result;
  if (!recipe || !recipe.name || !recipe.entry || !recipe.sizing || !recipe.exit) {
    logThought('error', 'consult', null, 'consult returned malformed recipe', recipe);
    return;
  }
  const id = `agent_${dayKey()}_${recipe.name.toLowerCase().replace(/[^a-z0-9-]/g, '_')}`.slice(0, 60);
  // Avoid clobbering an existing strategy with the same id
  const existing = db().prepare('SELECT id FROM ml_agent_strategies WHERE id = ?').get(id);
  if (existing) {
    logThought('error', 'consult', null, `strategy id collision: ${id} already exists`, null);
    return;
  }
  S().insertStrategy.run(id, recipe.name, recipe.rationale || '', JSON.stringify(recipe), Date.now());
  deployStrategy(id, recipe);
  logThought('propose', 'consult', id,
    `proposed strategy ${id}: ${recipe.name}`,
    { recipe, rationale: recipe.rationale });
  console.log(`[agent] 🚀 NEW STRATEGY: ${id} — ${recipe.name}`);
  console.log(`[agent]    rationale: ${(recipe.rationale || '').slice(0, 200)}`);
}

async function maybeRetireStrategies() {
  const live = S().liveStrategies.all();
  // Burst cap — at most N retirement consults per cycle (prevents 5 strategies
  // all consulting in the same 30-min cycle).
  const burstCap = BURST_CAPS['agent'] || 3;
  let consultedThisCycle = 0;
  // Don't re-consult on the same strategy more than once per 12h
  const RECONSULT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
  for (const st of live) {
    if (consultedThisCycle >= burstCap) break;
    const ageHours = (Date.now() - st.created_at) / 3600000;
    if (ageHours < STRATEGY_SOAK_HOURS) continue;  // let it soak
    const perf = S().strategyPerf.get(st.id, st.id, st.id, st.id, st.id);
    if ((perf?.closed || 0) < 5) continue;  // need at least 5 closed trades
    if (!rateLimitOk()) continue;
    // Cooldown — skip if we evaluated this strategy recently
    const lastEval = db().prepare(`SELECT MAX(timestamp) AS ts FROM ml_agent_log
       WHERE category = 'consult' AND strategy_id = ? AND level = 'info'`).get(st.id);
    if (lastEval?.ts && (Date.now() - lastEval.ts < RECONSULT_COOLDOWN_MS)) continue;
    consultedThisCycle++;
    const perfStr = `Closed: ${perf.closed} · Open: ${perf.open} · Realized PnL: ${perf.pnl_sol || 0} SOL · Avg trade: ${perf.avg_pct || 0}% · Wins: ${perf.wins}`;
    logThought('info', 'consult', st.id, 'consulting Claude to evaluate strategy', { perf });
    bumpConsult();
    try {
      const recipe = JSON.parse(st.recipe_json);
      const result = await evaluateStrategy(recipe, perfStr);
      const decision = result.result;
      if (decision.decision === 'retire') {
        retireStrategy(st.id, decision.reason);
        logThought('retire', 'consult', st.id,
          `retired ${st.id}: ${decision.reason}`, { decision });
        console.log(`[agent] 🗑️ RETIRED: ${st.id} — ${decision.reason}`);
      } else {
        logThought('thought', 'consult', st.id,
          `keeping ${st.id}: ${decision.reason}`, { decision });
      }
    } catch (err) {
      logThought('error', 'consult', st.id, `evaluation failed: ${err.message}`, null);
    }
  }
}

async function cycle() {
  const now = Date.now();
  const readiness = assessReadiness();
  const status = readiness.ready ? 'ready' : 'observing';
  let thought;
  if (readiness.ready) {
    const live = S().liveStrategies.all();
    thought = live.length > 0
      ? `monitoring ${live.length} live strategy(ies)`
      : 'all readiness checks passed — preparing to propose';
  } else {
    const failed = Object.entries(readiness.criteria).filter(([_, c]) => !c.passed);
    thought = `observing · blocked on: ${failed.map(([n]) => n).join(', ')}`;
  }
  S().updateState.run(status, JSON.stringify(readiness.criteria), now, thought, now);
  logThought('thought', 'introspect', null,
    `cycle · status=${status} · ${thought}`,
    { readiness: readiness.criteria });

  await maybeRetireStrategies();
  await maybeProposeStrategy(readiness);
}

export function startAgent() {
  // Reset consult counter if day changed
  try {
    const today = dayKey();
    const cur = S().state.get();
    if (cur.consult_day_key !== today) S().resetConsults.run(today);
  } catch {}
  // Kick off subsystems — executor evaluates strategies, satellites collect feedback
  startAgentExecutor();
  startPostMortem();         // analyzes each closed agent paper position
  startDailyReport();        // daily recap, runs ~once/day
  startCalibrationReview();  // daily deep-review of model honesty (when data lands)
  startMintIntel();          // hourly batch: heuristic + Claude scam/winner classifier
  // First introspection 5 min after boot
  setTimeout(() => cycle().catch(err => console.error('[agent] cycle err:', err)), FIRST_CYCLE_DELAY_MS);
  setInterval(() => cycle().catch(err => console.error('[agent] cycle err:', err)), CYCLE_INTERVAL_MS);
  console.log(`[agent] started · cycle=30min · first_run=+5min · max_consults_per_day=${MAX_CONSULTS_PER_DAY}`);
  logThought('info', 'introspect', null, 'agent started · in observing mode until calibration validates', null);
}

// Public for dashboard endpoints
export function getAgentSummary() {
  const s = S();
  const state = s.state.get();
  const live = s.liveStrategies.all();
  const readiness = state?.readiness_json ? JSON.parse(state.readiness_json) : null;
  return {
    state: state ? {
      status: state.status,
      current_thought: state.current_thought,
      last_cycle_at: state.last_cycle_at,
      last_consult_at: state.last_consult_at,
      consults_today: state.consults_today,
      consults_max: MAX_CONSULTS_PER_DAY,
      readiness,
    } : null,
    live_strategies: live.map(st => {
      const perf = s.strategyPerf.get(st.id, st.id, st.id, st.id, st.id);
      let recipe = null;
      try { recipe = JSON.parse(st.recipe_json); } catch {}
      return {
        id: st.id,
        name: st.name,
        rationale: st.rationale,
        recipe,
        created_at: st.created_at,
        n_trades: perf?.closed || 0,
        n_open: perf?.open || 0,
        realized_pnl_sol: perf?.pnl_sol || 0,
        avg_trade_pct: perf?.avg_pct || 0,
        wins: perf?.wins || 0,
      };
    }),
  };
}

export function getAgentLog(n = 50) {
  return db().prepare(`SELECT * FROM ml_agent_log ORDER BY timestamp DESC LIMIT ?`).all(n);
}
