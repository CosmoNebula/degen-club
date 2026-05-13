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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';
import { proposeStrategy, evaluateStrategy } from './agent-llm.js';
import { deployStrategy, retireStrategy, startAgentExecutor } from './agent-executor.js';
import { startPostMortem } from './agent-post-mortem.js';
import { startDailyReport } from './agent-daily-report.js';
import { startCalibrationReview } from './agent-calibration-review.js';
import { startMintIntel } from './agent-mint-intel.js';
import { startConcentrationCheck } from './agent-concentration-check.js';
import { startMarketRegime } from './agent-market-regime.js';
import { canConsult, recordConsult, getRateLimitState, BURST_CAPS } from './agent-rate-limit.js';
import { getModelHealth } from './drift-monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '..', '..', 'ml', 'models');

const CYCLE_INTERVAL_MS = 30 * 60 * 1000;   // 30 min
const FIRST_CYCLE_DELAY_MS = 10 * 60 * 1000; // 10 min after boot — long enough that dev kicks don't burn consults, short enough that the cycle actually fires between bot restarts
const STRATEGY_SOAK_HOURS = 4;              // shorter soak — bad strategies bleed, want to iterate fast
const MAX_CONSULTS_PER_DAY = 55;            // soft rate limit on LLM calls
// Bleeding-strategy thresholds. When a live strategy has clearly bled
// (>=BLEED_MIN_TRADES closed AND realized PnL fraction <= BLEED_PNL_FRACTION
// of starting wallet), the agent is allowed to propose VARIANTS even with
// live strategies running, AND the re-consult cooldown shortens. Philosophy:
// "being wrong should make the agent strive harder to find a fix, not slow
// down." Paper money is paper, so we don't auto-retire — we iterate.
const BLEED_PNL_FRACTION = -0.03;           // -3% of starting wallet → "actively bleeding"
const BLEED_MIN_TRADES = 50;                // need enough samples for the signal to be real
const BLEED_RECONSULT_HOURS = 2;            // normal cooldown is 12h; if bleeding, re-eval every 2h
const STRATEGY_CAP = 8;                     // max live strategies; evolutionary retire-worst makes room
const STRATEGY_FRESH_FLOOR = 1;             // 2026-05-12: dropped 4→1 — human wants to focus on the winning strategy (alive-migrator-v1), no auto-propose churn
const ORPHAN_AGE_HOURS = 1;                 // strategies w/ 0 entries past this age get auto-retired — 1h is enough to know filters are too strict
const RETIRE_WORST_MIN_TRADES = 10;         // need at least N closed trades before considering for evolutionary retire
// Emergency retire DISABLED for user-tuned strategies — agent's modify path
// can still adjust them based on evidence.
const EMERGENCY_PNL_FRACTION = -999;        // disabled
const EMERGENCY_MIN_TRADES = 999999;        // disabled

let stmts = null;
// Set by maybeProposeStrategy when one or more live strategies are bleeding,
// read by buildContext to inject a "fix this" prompt section for Claude.
let _bleedersForNextProposal = [];
// Tracks recent orphan retirements so the next propose-strategy prompt can
// tell Claude "these filter stacks got ZERO entries — they were too strict."
// Cleared after each propose call. Caps at 8 entries to keep prompt tight.
let _recentOrphans = [];
const RECENT_ORPHANS_MAX = 8;
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
    // DCA performance per strategy. Compares the realized PnL of positions
    // that DCA'd (dca_count > 0) against positions on the same strategy that
    // did NOT DCA. Agent uses this to decide whether to keep dca_enabled on
    // or to tune dca_trigger_pct / dca_size_pct. Only shows strategies that
    // have actually fired DCA at least once — quiet on non-DCA strategies.
    // Data quality summary — closed positions flagged as junk_exit_tick
    // (exit recorded against a price below the bonding-curve floor).
    // Their realized_pnl_sol is fake-negative; per-strategy PnL/lift should
    // be read with that caveat.
    dataQualitySummary: d.prepare(`
      SELECT
        strategy,
        COUNT(*) AS total,
        SUM(CASE WHEN data_quality_flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged,
        ROUND(100.0 * SUM(CASE WHEN data_quality_flag IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_flagged
      FROM paper_positions
      WHERE status='closed' AND entered_at > strftime('%s','now')*1000 - 7*86400000
      GROUP BY strategy
      HAVING flagged > 0
      ORDER BY pct_flagged DESC
    `),
    // Rejected vs accepted comparison (Tier A #2, added 2026-05-11).
    // Per-reject-reason: count, then JOIN to ml_mint_snapshots labels to compute
    // "what we passed on" outcomes (peaked_30/100 rates, avg peak%). Lets the
    // agent see if it's rejecting real winners. Bucketed by reject reason so
    // we know which gate is filtering well vs filtering blindly.
    rejectionLearnings: d.prepare(`
      SELECT
        g.reason,
        COUNT(*) AS n_rejected,
        AVG(CASE WHEN s.peaked_30 IS NOT NULL THEN s.peaked_30 END) AS p30_rate,
        AVG(CASE WHEN s.peaked_100 IS NOT NULL THEN s.peaked_100 END) AS p100_rate,
        AVG(CASE WHEN s.peak_pct_max IS NOT NULL THEN s.peak_pct_max END) AS avg_peak_pct,
        SUM(CASE WHEN s.peak_pct_max >= 1.0 THEN 1 ELSE 0 END) AS n_2x_missed,
        SUM(CASE WHEN s.peak_pct_max >= 3.0 THEN 1 ELSE 0 END) AS n_4x_missed,
        SUM(CASE WHEN s.migrated = 1 THEN 1 ELSE 0 END) AS n_migrated_missed,
        SUM(CASE WHEN s.labels_resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS n_labeled
      FROM gate_rejections g
      LEFT JOIN ml_mint_snapshots s ON s.mint_address = g.mint_address
        AND s.snapshot_age_sec = 60
      WHERE g.first_rejected_at > strftime('%s','now')*1000 - 7*86400000
      GROUP BY g.reason
      ORDER BY n_rejected DESC
      LIMIT 12
    `),
    // Baseline accepted-entry outcomes for comparison.
    acceptedBaseline: d.prepare(`
      SELECT
        COUNT(*) AS n,
        AVG(realized_pnl_pct) AS avg_pnl_pct,
        AVG(highest_pct) AS avg_peak_pct,
        SUM(CASE WHEN highest_pct >= 1.0 THEN 1 ELSE 0 END) AS n_2x,
        SUM(CASE WHEN highest_pct >= 3.0 THEN 1 ELSE 0 END) AS n_4x
      FROM paper_positions
      WHERE status='closed' AND entered_at > strftime('%s','now')*1000 - 7*86400000
    `),
    // Anomaly detector summary for the agent's strategy-proposal context.
    // 6 kinds (volume_spike, tracked_cohort, dormant_creator, theme_cluster,
    // kol_cluster, tracked_dump) — the agent never saw these. Now it does.
    recentAnomalySummary: d.prepare(`
      SELECT kind, severity, COUNT(*) AS n FROM anomalies
      WHERE ts > strftime('%s','now')*1000 - 4*3600000
      GROUP BY kind, severity ORDER BY n DESC
    `),
    recentAnomalyExamples: d.prepare(`
      SELECT kind, subject, description, datetime(ts/1000,'unixepoch','localtime') AS at
      FROM anomalies
      WHERE ts > strftime('%s','now')*1000 - 4*3600000 AND severity = 'high'
      ORDER BY ts DESC LIMIT 6
    `),
    dcaPerformance: d.prepare(`
      SELECT
        strategy,
        COUNT(*) AS n_total,
        SUM(CASE WHEN dca_count > 0 THEN 1 ELSE 0 END) AS n_dca,
        SUM(CASE WHEN dca_count > 0 AND realized_pnl_pct > 0 THEN 1 ELSE 0 END) AS n_dca_wins,
        SUM(CASE WHEN dca_count = 0 AND realized_pnl_pct > 0 THEN 1 ELSE 0 END) AS n_nodca_wins,
        ROUND(AVG(CASE WHEN dca_count > 0 THEN realized_pnl_pct END) * 100, 1) AS avg_pnl_pct_dca,
        ROUND(AVG(CASE WHEN dca_count = 0 THEN realized_pnl_pct END) * 100, 1) AS avg_pnl_pct_no_dca,
        ROUND(AVG(CASE WHEN dca_count > 0 THEN dca_total_sol_added END), 4) AS avg_sol_added,
        ROUND(AVG(CASE WHEN dca_count > 0 THEN highest_pct END) * 100, 1) AS avg_post_dca_peak_pct
      FROM paper_positions
      WHERE status = 'closed'
        AND entered_at > strftime('%s','now')*1000 - 7*86400000
      GROUP BY strategy
      HAVING n_dca > 0
      ORDER BY n_total DESC
    `),
    insertStrategy: d.prepare(`INSERT INTO ml_agent_strategies
       (id, name, rationale, recipe_json, status, created_at, parent_strategy_id, generation)
       VALUES (?, ?, ?, ?, 'live', ?, ?, ?)`),
    // Lineage helpers
    mostRecentRetiredStrategy: d.prepare(`SELECT id, generation FROM ml_agent_strategies
       WHERE status='retired' ORDER BY retired_at DESC LIMIT 1`),
    strategyLineage: d.prepare(`
      WITH RECURSIVE family(id, name, generation, status, parent_strategy_id, depth) AS (
        SELECT id, name, generation, status, parent_strategy_id, 0
        FROM ml_agent_strategies WHERE id = ?
        UNION ALL
        SELECT s.id, s.name, s.generation, s.status, s.parent_strategy_id, family.depth + 1
        FROM ml_agent_strategies s JOIN family ON family.parent_strategy_id = s.id
      )
      SELECT * FROM family
    `),
    recentLineageOverview: d.prepare(`
      SELECT s.id, s.name, s.status, s.generation, s.parent_strategy_id,
             ROUND(s.realized_pnl_sol, 3) AS pnl, s.n_trades,
             datetime(s.created_at/1000, 'unixepoch', 'localtime') AS created
      FROM ml_agent_strategies s
      ORDER BY s.created_at DESC LIMIT 12
    `),
    strategyMods: d.prepare(`SELECT ts, field_path, old_value, new_value, reason
       FROM ml_agent_strategy_modifications
       WHERE strategy_id = ? ORDER BY ts DESC LIMIT 8`),
    insertModification: d.prepare(`INSERT INTO ml_agent_strategy_modifications
       (strategy_id, ts, field_path, old_value, new_value, reason, source)
       VALUES (?, ?, ?, ?, ?, ?, 'agent')`),
    updateRecipe: d.prepare(`UPDATE ml_agent_strategies SET recipe_json = ? WHERE id = ?`),
    // Calibration data — GROUP BY p.id so each prediction counts once, not
    // once per matching snapshot age. Without this we get JOIN-explosion
    // dilution (each prediction × 4 snapshots = artificially better Brier).
    calibrationStats: d.prepare(`
      WITH per_pred AS (
        SELECT p.id, p.prob, MAX(s.peaked_30) AS actual
        FROM ml_predictions p
        JOIN ml_mint_snapshots s ON s.mint_address = p.mint_address
        WHERE p.target = 'peaked_30'
          AND p.prob IS NOT NULL
          AND s.labels_resolved_at IS NOT NULL
          AND s.peaked_30 IS NOT NULL
        GROUP BY p.id
      )
      SELECT COUNT(*) AS n,
             AVG((prob - actual) * (prob - actual)) AS brier
      FROM per_pred
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
      WITH per_pred AS (
        SELECT p.id, p.target, p.prob,
               MAX(s.peaked_30) AS p30, MAX(s.peaked_100) AS p100,
               MAX(s.migrated) AS mig, MAX(s.peak_pct_max) AS peak_pct
        FROM ml_predictions p
        JOIN ml_mint_snapshots s ON s.mint_address = p.mint_address
        WHERE p.prob IS NOT NULL AND p.prob > 0.30
          AND s.labels_resolved_at IS NOT NULL
          AND p.timestamp > strftime('%s','now')*1000 - 7*86400000
        GROUP BY p.id
      )
      SELECT target, COUNT(*) AS n,
             AVG(p30) AS p30_rate, AVG(p100) AS p100_rate,
             AVG(mig) AS mig_rate, AVG(peak_pct) AS avg_peak_pct
      FROM per_pred GROUP BY target
    `),
    // Edge check — top-30%-prob peaked_30 picks vs population baseline.
    // This is what actually matters: do the model's confident picks pump?
    edgeCheck: d.prepare(`
      WITH per_pred AS (
        SELECT p.id, p.prob, MAX(s.peaked_30) AS actual
        FROM ml_predictions p
        JOIN ml_mint_snapshots s ON s.mint_address = p.mint_address
        WHERE p.target = 'peaked_30' AND p.prob IS NOT NULL
          AND s.labels_resolved_at IS NOT NULL AND s.peaked_30 IS NOT NULL
        GROUP BY p.id
      )
      SELECT
        (SELECT AVG(actual) FROM per_pred WHERE prob > 0.30) AS top_rate,
        (SELECT COUNT(*) FROM per_pred WHERE prob > 0.30) AS top_n,
        (SELECT AVG(actual) FROM per_pred) AS baseline_rate,
        (SELECT COUNT(*) FROM per_pred) AS total_n
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
    // === CULTURAL PULSE — news + flags + meta synthesis ===
    latestSynthesis: d.prepare(`SELECT ts, summary FROM agent_meta_synthesis ORDER BY ts DESC LIMIT 1`),
    // Phase C — top mints + narratives by current-4h-window sentiment volume.
    // Fed into context so the agent can reason about which mints have social
    // attention right now ("$X is being shilled, fade it" vs "$Y is organic
    // bullish, favor entry").
    topSentimentMints: d.prepare(`SELECT s.mint_address, m.symbol, m.name,
       s.bull_mentions, s.bear_mentions, s.shill_mentions, s.total_mentions,
       (s.sum_confidence / NULLIF(s.total_mentions, 0)) AS avg_conf
       FROM mint_sentiment s LEFT JOIN mints m ON m.mint_address = s.mint_address
       WHERE s.window_start = ?
       ORDER BY s.total_mentions DESC LIMIT 10`),
    topSentimentNarratives: d.prepare(`SELECT theme,
       bull_mentions, bear_mentions, shill_mentions, total_mentions,
       (sum_confidence / NULLIF(total_mentions, 0)) AS avg_conf
       FROM narrative_sentiment
       WHERE window_start = ?
       ORDER BY total_mentions DESC LIMIT 10`),
    activeFlags: d.prepare(`SELECT flag, note, created_at FROM manual_flags
       WHERE active=1 AND (expires_at IS NULL OR expires_at > strftime('%s','now')*1000)
       ORDER BY created_at DESC LIMIT 10`),
    topRecentNews: d.prepare(`SELECT source, title, ts FROM news_items
       WHERE ts > strftime('%s','now')*1000 - 14400000
       ORDER BY relevance_score DESC, ts DESC LIMIT 12`),
    topRecentTrends: d.prepare(`SELECT source, keyword, score FROM trend_signals
       WHERE ts > strftime('%s','now')*1000 - 14400000
       ORDER BY score DESC LIMIT 15`),
    recentTrumpCount: d.prepare(`SELECT COUNT(*) AS n FROM news_items
       WHERE source='truth-social:trump' AND ts > strftime('%s','now')*1000 - 14400000`),
    // Long-term memory: daily intelligence condensates (last 7 days)
    // Post-migration candidates — fresh migrators with active AMM
    topMigratedCandidates: d.prepare(`
      SELECT m.mint_address, m.name, m.symbol,
             ROUND((strftime('%s','now')*1000 - m.migrated_at) / 60000.0, 0) AS age_min,
             ROUND(m.amm_liquidity_usd, 0) AS liq_usd,
             ROUND(m.amm_volume_h24_usd, 0) AS vol_h24_usd,
             ROUND(m.amm_price_change_h1, 1) AS chg_h1,
             ROUND(m.amm_price_change_h24, 1) AS chg_h24,
             m.amm_buys_h24, m.amm_sells_h24, m.amm_dex
      FROM mints m
      WHERE m.migrated = 1 AND m.rugged = 0
        AND m.migrated_at > strftime('%s','now')*1000 - 72 * 3600000
        AND m.amm_liquidity_usd > 1000
      ORDER BY m.amm_volume_h24_usd DESC LIMIT 12
    `),
    // Post-mig outcome stats (training target distributions)
    migOutcomeStats: d.prepare(`
      SELECT
        COUNT(*) AS n_resolved,
        AVG(post_mig_hits_2x) AS rate_2x,
        AVG(post_mig_hits_5x) AS rate_5x,
        AVG(post_mig_hits_10x) AS rate_10x,
        AVG(post_mig_hits_1m_usd) AS rate_1m,
        AVG(post_mig_rugs_1h) AS rate_rug,
        AVG(post_mig_alive_24h) AS rate_alive_24h,
        AVG(post_mig_peak_pct) AS avg_peak_pct
      FROM ml_migration_snapshots
      WHERE labels_resolved_at IS NOT NULL AND snapshot_age_min = 0
    `),
    activeAnomalies: d.prepare(`SELECT kind, severity, subject, description, ts
       FROM anomalies WHERE expires_at > strftime('%s','now')*1000
       ORDER BY ts DESC LIMIT 15`),
    recentDailyIntel: d.prepare(`SELECT date_key, mints_created, mints_migrated,
       pop_peaked_30_rate, pop_avg_peak_pct, tracked_wallet_buys,
       per_strategy_pnl_json, top_winners_json, top_themes_json, trump_post_count
       FROM daily_intelligence ORDER BY date_key DESC LIMIT 7`),
    // Cultural/meta context — pump.fun is a meme economy. Surface raw mint
    // metadata so the agent can spot naming themes, narrative patterns,
    // creator reputations. Numbers don't capture vibes.
    recentWinnerVerdicts: d.prepare(`
      SELECT m.mint_address, m.name, m.symbol, m.description,
             m.twitter, m.telegram, m.website,
             mi.confidence, mi.signals_json, mi.rationale, mi.analyzed_at,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet) AS creator_launches,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet AND migrated = 1) AS creator_migs
      FROM ml_mint_intel mi
      JOIN mints m ON m.mint_address = mi.mint_address
      WHERE mi.verdict = 'winner'
        AND mi.analyzed_at > strftime('%s','now')*1000 - 86400000
      ORDER BY mi.analyzed_at DESC LIMIT 12
    `),
    recentRuggyVerdicts: d.prepare(`
      SELECT m.mint_address, m.name, m.symbol, m.description,
             m.twitter, m.telegram, m.website,
             mi.confidence, mi.signals_json, mi.rationale,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet) AS creator_launches
      FROM ml_mint_intel mi
      JOIN mints m ON m.mint_address = mi.mint_address
      WHERE mi.verdict = 'ruggy'
        AND mi.analyzed_at > strftime('%s','now')*1000 - 86400000
      ORDER BY mi.analyzed_at DESC LIMIT 8
    `),
    // Real outcomes — what actually pumped, regardless of mint-intel verdict.
    // This is ground truth, more valuable than verdicts. Pulled from labeled
    // snapshots in the last 7 days so themes are current.
    recentBigPumpers: d.prepare(`
      SELECT DISTINCT m.mint_address, m.name, m.symbol, m.description,
             m.twitter, m.telegram, m.website,
             ROUND(MAX(s.peak_pct_max) * 100, 0) AS peak_pct,
             MAX(s.migrated) AS migrated,
             MIN(s.time_to_peak_sec) AS time_to_peak,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet) AS creator_launches,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet AND migrated = 1) AS creator_migs
      FROM ml_mint_snapshots s
      JOIN mints m ON m.mint_address = s.mint_address
      WHERE s.peak_pct_max >= 1.0
        AND s.snapshot_ts > strftime('%s','now')*1000 - 7*86400000
        AND s.labels_resolved_at IS NOT NULL
      GROUP BY m.mint_address
      ORDER BY MAX(s.peak_pct_max) DESC LIMIT 15
    `),
    recentMigrators: d.prepare(`
      SELECT m.mint_address, m.name, m.symbol, m.description,
             m.twitter, m.telegram, m.website,
             ROUND(m.peak_market_cap_sol, 0) AS peak_mcap,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet) AS creator_launches,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet AND migrated = 1) AS creator_migs
      FROM mints m
      WHERE m.migrated = 1
        AND m.migrated_at > strftime('%s','now')*1000 - 3*86400000
      ORDER BY m.migrated_at DESC LIMIT 10
    `),
    recentDeadFast: d.prepare(`
      SELECT m.mint_address, m.name, m.symbol, m.description,
             m.twitter, m.telegram, m.website,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet) AS creator_launches
      FROM ml_mint_snapshots s
      JOIN mints m ON m.mint_address = s.mint_address
      WHERE s.will_die_fast = 1
        AND s.snapshot_ts > strftime('%s','now')*1000 - 86400000
      GROUP BY m.mint_address ORDER BY s.snapshot_ts DESC LIMIT 8
    `),
    // What's currently scoring high by the model — agent can see what it's
    // about to bet on, in plain text, including names/themes
    // === KOL / TRACKED-WALLET INTEL ===
    // Single biggest discriminator we have. Cohort lift answers
    // "what does it mean when N tracked wallets bought this mint?"
    trackedCohortLift: d.prepare(`
      SELECT
        CASE WHEN tracked_buyers = 0 THEN '0_tracked'
             WHEN tracked_buyers = 1 THEN '1_tracked'
             WHEN tracked_buyers = 2 THEN '2_tracked'
             ELSE '3plus_tracked' END AS cohort,
        COUNT(*) AS n,
        AVG(peaked_30) AS p30,
        AVG(peaked_100) AS p100,
        AVG(peaked_300) AS p300,
        AVG(migrated) AS mig,
        AVG(peak_pct_max) AS avg_peak
      FROM ml_mint_snapshots
      WHERE labels_resolved_at IS NOT NULL
      GROUP BY cohort ORDER BY cohort
    `),
    bundleCohortLift: d.prepare(`
      SELECT
        CASE WHEN bundle_buyers = 0 THEN '0_bundle'
             WHEN bundle_buyers BETWEEN 1 AND 2 THEN '1to2_bundle'
             WHEN bundle_buyers BETWEEN 3 AND 5 THEN '3to5_bundle'
             ELSE '6plus_bundle' END AS cohort,
        COUNT(*) AS n,
        AVG(peaked_30) AS p30,
        AVG(peaked_100) AS p100,
        AVG(migrated) AS mig,
        AVG(peak_pct_max) AS avg_peak
      FROM ml_mint_snapshots
      WHERE labels_resolved_at IS NOT NULL
      GROUP BY cohort ORDER BY n DESC
    `),
    // KOL roster summary — how many KOLs we track, recent activity
    kolRosterStats: d.prepare(`
      SELECT
        SUM(CASE WHEN tracked = 1 THEN 1 ELSE 0 END) AS tracked,
        SUM(CASE WHEN is_kol = 1 THEN 1 ELSE 0 END) AS kol,
        SUM(CASE WHEN is_kol = 1 AND last_activity_at > strftime('%s','now')*1000 - 86400000 THEN 1 ELSE 0 END) AS kol_active_24h,
        SUM(CASE WHEN tracked = 1 AND last_activity_at > strftime('%s','now')*1000 - 86400000 THEN 1 ELSE 0 END) AS tracked_active_24h,
        AVG(CASE WHEN tracked = 1 THEN migrator_score ELSE NULL END) AS avg_mig_score
      FROM wallets
    `),
    // What tracked wallets caught lately. Aggregate counts only — addresses
    // anonymized, agent just needs to know the signal is real.
    kolRecentHits: d.prepare(`
      SELECT
        COUNT(DISTINCT t.wallet) AS n_kols_active,
        COUNT(DISTINCT t.mint_address) AS distinct_mints_bought,
        SUM(CASE WHEN m.migrated = 1 THEN 1 ELSE 0 END) AS bought_a_migrator,
        SUM(CASE WHEN m.peak_market_cap_sol > 100 THEN 1 ELSE 0 END) AS bought_big_pumper
      FROM trades t
      JOIN wallets w ON w.address = t.wallet
      JOIN mints m ON m.mint_address = t.mint_address
      WHERE w.tracked = 1 AND t.is_buy = 1
        AND t.timestamp > strftime('%s','now')*1000 - 7*86400000
    `),
    // === PER-STRATEGY LIFT PROFILE ===
    // For each LIVE strategy: did its entry conditions actually select mints
    // that pumped? Separates entry quality from exit quality. Compares against
    // the snapshot population so we know if the strategy is picking better
    // than random.
    perStrategyLift: d.prepare(`
      WITH strategy_mints AS (
        SELECT pp.strategy, pp.mint_address, pp.realized_pnl_sol, pp.realized_pnl_pct,
               pp.exit_reason, pp.highest_pct,
               (SELECT MAX(peak_pct_max) FROM ml_mint_snapshots s
                  WHERE s.mint_address = pp.mint_address AND s.labels_resolved_at IS NOT NULL) AS true_peak_pct,
               (SELECT MAX(migrated) FROM ml_mint_snapshots s
                  WHERE s.mint_address = pp.mint_address AND s.labels_resolved_at IS NOT NULL) AS true_mig,
               (SELECT MAX(peaked_30) FROM ml_mint_snapshots s
                  WHERE s.mint_address = pp.mint_address AND s.labels_resolved_at IS NOT NULL) AS true_p30,
               (SELECT MAX(peaked_100) FROM ml_mint_snapshots s
                  WHERE s.mint_address = pp.mint_address AND s.labels_resolved_at IS NOT NULL) AS true_p100,
               (SELECT MAX(peaked_300) FROM ml_mint_snapshots s
                  WHERE s.mint_address = pp.mint_address AND s.labels_resolved_at IS NOT NULL) AS true_p300
        FROM paper_positions pp
        WHERE pp.strategy LIKE 'agent_%' AND pp.status = 'closed'
      )
      SELECT
        strategy,
        COUNT(*) AS n_trades,
        COUNT(true_peak_pct) AS n_labeled,
        AVG(true_p30) AS true_p30_rate,
        AVG(true_p100) AS true_p100_rate,
        AVG(true_p300) AS true_p300_rate,
        AVG(true_mig) AS true_mig_rate,
        AVG(true_peak_pct) AS avg_true_peak,
        AVG(highest_pct) AS avg_realized_peak,
        AVG(realized_pnl_pct) AS avg_pnl_pct,
        SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
        ROUND(SUM(realized_pnl_sol), 4) AS pnl_sol
      FROM strategy_mints GROUP BY strategy
    `),
    // === CROSS-TARGET CORRELATIONS ===
    // Per-mint pivot of all 5 classifier predictions joined with actual
    // outcomes. JS code then runs combinations to find conditional lifts:
    // "when peaked_30 high AND will_die_fast high, what's the real rate?"
    // === MARKET REGIME ===
    // Daily rollup. Compare today vs 7d trailing — is the pump.fun ecosystem
    // hot, normal, or cold right now?
    dailyRegime: d.prepare(`
      SELECT
        CAST((strftime('%s','now')*1000 - snapshot_ts) / 86400000 AS INTEGER) AS days_ago,
        COUNT(*) AS n,
        AVG(peaked_30) AS p30,
        AVG(peaked_100) AS p100,
        AVG(migrated) AS mig,
        AVG(peak_pct_max) AS avg_peak,
        SUM(peak_pct_max >= 1.0) AS n_2x,
        SUM(migrated = 1) AS n_mig
      FROM ml_mint_snapshots
      WHERE labels_resolved_at IS NOT NULL
        AND snapshot_age_sec = 60
        AND snapshot_ts > strftime('%s','now')*1000 - 8*86400000
      GROUP BY days_ago ORDER BY days_ago ASC
    `),
    mintsCreatedToday: d.prepare(`
      SELECT COUNT(*) AS n FROM mints
      WHERE created_at > strftime('%s','now')*1000 - 86400000
    `),
    mintsCreated7dAvg: d.prepare(`
      SELECT COUNT(*) / 7.0 AS avg_per_day FROM mints
      WHERE created_at > strftime('%s','now')*1000 - 7*86400000
    `),
    migrationsToday: d.prepare(`
      SELECT COUNT(*) AS n FROM mints
      WHERE migrated = 1 AND migrated_at > strftime('%s','now')*1000 - 86400000
    `),
    migrations7dAvg: d.prepare(`
      SELECT COUNT(*) / 7.0 AS avg_per_day FROM mints
      WHERE migrated = 1 AND migrated_at > strftime('%s','now')*1000 - 7*86400000
    `),

    perMintPredsAndOutcomes: d.prepare(`
      WITH per_mint_preds AS (
        SELECT mint_address,
          MAX(CASE WHEN target='peaked_30' THEN prob END) AS p30,
          MAX(CASE WHEN target='peaked_100' THEN prob END) AS p100,
          MAX(CASE WHEN target='peaked_300' THEN prob END) AS p300,
          MAX(CASE WHEN target='migrated' THEN prob END) AS mig,
          MAX(CASE WHEN target='will_die_fast' THEN prob END) AS die,
          MAX(CASE WHEN target='rug_within_5min' THEN prob END) AS rug5,
          MAX(CASE WHEN target='migrates_within_15min' THEN prob END) AS mig15,
          MAX(CASE WHEN target='hits_2x_within_1h' THEN prob END) AS h2x1h
        FROM ml_predictions
        WHERE prob IS NOT NULL
          AND timestamp > strftime('%s','now')*1000 - 7*86400000
        GROUP BY mint_address
      ),
      per_mint_labels AS (
        SELECT mint_address,
          MAX(peaked_30) AS y_p30,
          MAX(peaked_100) AS y_p100,
          MAX(peaked_300) AS y_p300,
          MAX(migrated) AS y_mig,
          MAX(peak_pct_max) AS y_peak,
          MAX(hits_2x_within_1h) AS y_h2x1h,
          MAX(tracked_buyers) AS tracked_n
        FROM ml_mint_snapshots
        WHERE labels_resolved_at IS NOT NULL
        GROUP BY mint_address
      )
      SELECT p.*, l.y_p30, l.y_p100, l.y_p300, l.y_mig, l.y_peak, l.y_h2x1h, l.tracked_n
      FROM per_mint_preds p
      JOIN per_mint_labels l ON l.mint_address = p.mint_address
      WHERE p.p30 IS NOT NULL OR p.mig IS NOT NULL
    `),

    // === TIME-OF-DAY PATTERNS ===
    // Solana has rhythms. Pump rates vary by hour-of-day and DOW.
    // Use snapshot_age_sec=60 for cleanest signal (one row per fresh mint).
    hourlyPumpRates: d.prepare(`
      SELECT
        created_hour_utc AS hr,
        COUNT(*) AS n,
        AVG(peaked_30) AS p30,
        AVG(peaked_100) AS p100,
        AVG(migrated) AS mig,
        AVG(peak_pct_max) AS avg_peak
      FROM ml_mint_snapshots
      WHERE labels_resolved_at IS NOT NULL AND snapshot_age_sec = 60
      GROUP BY hr ORDER BY hr
    `),
    dowPumpRates: d.prepare(`
      SELECT
        created_dow AS dow,
        COUNT(*) AS n,
        AVG(peaked_30) AS p30,
        AVG(peaked_100) AS p100,
        AVG(migrated) AS mig,
        AVG(peak_pct_max) AS avg_peak
      FROM ml_mint_snapshots
      WHERE labels_resolved_at IS NOT NULL AND snapshot_age_sec = 60
      GROUP BY dow ORDER BY dow
    `),
    // === PER-MINT TRADE HISTORY ===
    // Last N closed agent positions with full surrounding context. Lets
    // the agent see actual price paths, what tracked wallets did during
    // the hold, and decode-level detail beyond what aggregates show.
    recentClosedAgentTrades: d.prepare(`
      SELECT pp.id, pp.strategy, pp.mint_address, pp.entry_signal,
             pp.entry_price, pp.entry_sol, pp.entry_mcap_sol,
             pp.exit_price, pp.exit_reason, pp.realized_pnl_sol,
             ROUND(pp.realized_pnl_pct * 100, 1) AS realized_pnl_pct,
             ROUND(pp.highest_pct * 100, 1) AS highest_pct,
             pp.entered_at, pp.exited_at,
             m.name, m.symbol, m.description,
             m.twitter, m.telegram, m.website
      FROM paper_positions pp
      LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.strategy LIKE 'agent_%' AND pp.status = 'closed'
      ORDER BY pp.exited_at DESC LIMIT 5
    `),
    // Price path during a hold window (sample of trades)
    pricePathInWindow: d.prepare(`
      SELECT timestamp, price_sol, market_cap_sol, sol_amount, is_buy
      FROM trades WHERE mint_address = ?
        AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `),
    // Tracked-wallet activity during a hold window
    trackedActivityInWindow: d.prepare(`
      SELECT
        SUM(CASE WHEN t.is_buy = 1 THEN 1 ELSE 0 END) AS tracked_buys,
        SUM(CASE WHEN t.is_buy = 0 THEN 1 ELSE 0 END) AS tracked_sells,
        SUM(CASE WHEN w.is_kol = 1 AND t.is_buy = 1 THEN 1 ELSE 0 END) AS kol_buys,
        SUM(CASE WHEN w.is_kol = 1 AND t.is_buy = 0 THEN 1 ELSE 0 END) AS kol_sells
      FROM trades t JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? AND t.timestamp BETWEEN ? AND ?
        AND w.tracked = 1
    `),
    // Did the mint pump AFTER we exited? Captures missed upside specifically.
    postExitMaxPrice: d.prepare(`
      SELECT MAX(price_sol) AS max_price, MAX(market_cap_sol) AS max_mcap
      FROM trades WHERE mint_address = ? AND timestamp > ?
        AND timestamp <= ? + 7200000
    `),
    // === CROSS-STRATEGY OVERLAP ===
    // For mints both strategies could have seen (entered or skipped), who fired
    // and what was the outcome? Reveals strategies that "missed" winners or
    // "caught" losers their counterpart didn't.
    overlapPairs: d.prepare(`
      WITH all_strategies AS (
        SELECT DISTINCT strategy FROM paper_positions WHERE strategy LIKE 'agent_%'
      ),
      per_mint AS (
        SELECT pp.mint_address, pp.strategy, pp.realized_pnl_sol, pp.realized_pnl_pct,
               (SELECT MAX(peak_pct_max) FROM ml_mint_snapshots s
                  WHERE s.mint_address = pp.mint_address AND s.labels_resolved_at IS NOT NULL) AS true_peak,
               (SELECT MAX(migrated) FROM ml_mint_snapshots s
                  WHERE s.mint_address = pp.mint_address AND s.labels_resolved_at IS NOT NULL) AS migrated
        FROM paper_positions pp
        WHERE pp.strategy LIKE 'agent_%' AND pp.status = 'closed'
      )
      SELECT
        a.strategy AS strat_a, b.strategy AS strat_b,
        COUNT(DISTINCT a.mint_address) AS overlap_n,
        AVG(a.realized_pnl_pct) AS a_avg_pct,
        AVG(b.realized_pnl_pct) AS b_avg_pct,
        SUM(CASE WHEN a.realized_pnl_sol > b.realized_pnl_sol THEN 1 ELSE 0 END) AS a_won
      FROM per_mint a
      JOIN per_mint b ON a.mint_address = b.mint_address AND a.strategy < b.strategy
      GROUP BY a.strategy, b.strategy
      HAVING overlap_n >= 3
    `),
    // For each pair of strategies, find mints A entered but B did NOT (and vice versa)
    aOnlyMints: d.prepare(`
      WITH a_picks AS (SELECT DISTINCT mint_address FROM paper_positions WHERE strategy = ? AND status='closed'),
           b_picks AS (SELECT DISTINCT mint_address FROM paper_positions WHERE strategy = ? AND status='closed')
      SELECT a.mint_address,
             (SELECT MAX(peak_pct_max) FROM ml_mint_snapshots s WHERE s.mint_address = a.mint_address AND s.labels_resolved_at IS NOT NULL) AS true_peak
      FROM a_picks a WHERE a.mint_address NOT IN (SELECT mint_address FROM b_picks) LIMIT 100
    `),
    perStrategyExitReasons: d.prepare(`
      SELECT strategy, exit_reason, COUNT(*) AS n,
             ROUND(AVG(realized_pnl_pct) * 100, 1) AS avg_pnl_pct
      FROM paper_positions
      WHERE strategy LIKE 'agent_%' AND status = 'closed'
      GROUP BY strategy, exit_reason ORDER BY strategy, n DESC
    `),
    currentTopPicks: d.prepare(`
      SELECT m.mint_address, m.name, m.symbol, m.description,
             m.twitter, m.telegram, m.website,
             ROUND(p.prob, 3) AS top_prob,
             p.target,
             ROUND((strftime('%s','now')*1000 - m.created_at)/60000.0, 1) AS age_min
      FROM ml_predictions p
      JOIN mints m ON m.mint_address = p.mint_address
      WHERE p.target = 'peaked_300'
        AND p.prob > 0.10
        AND p.timestamp > strftime('%s','now')*1000 - 600000
        AND m.migrated = 0 AND m.rugged = 0
      GROUP BY m.mint_address ORDER BY p.prob DESC LIMIT 10
    `),
  };
  return stmts;
}

function dayKey() { return new Date().toISOString().slice(0, 10); }

// Compute outcome rates over a filtered subset of per-mint prediction+label rows
function computeOutcome(rows, predicate) {
  const matched = rows.filter(predicate);
  const n = matched.length;
  if (n === 0) return null;
  const sum = (k) => matched.reduce((a, r) => a + (r[k] || 0), 0);
  return {
    n,
    p30: sum('y_p30') / n,
    p100: sum('y_p100') / n,
    p300: sum('y_p300') / n,
    mig: sum('y_mig') / n,
    peak: sum('y_peak') / n,
  };
}

function fmtOut(label, base, sub) {
  if (!sub) return `  ${label}: no samples`;
  const liftMig = base?.mig > 0 ? (sub.mig / base.mig).toFixed(1) + 'x' : '?';
  const liftP100 = base?.p100 > 0 ? (sub.p100 / base.p100).toFixed(1) + 'x' : '?';
  return `  ${label}: n=${sub.n} · p30=${(sub.p30*100).toFixed(0)}% · p100=${(sub.p100*100).toFixed(0)}% (lift ${liftP100}) · mig=${(sub.mig*100).toFixed(0)}% (lift ${liftMig}) · avg_peak=${(sub.peak*100).toFixed(0)}%`;
}

// Dotted-path getter/setter for recipe modifications. Supports:
//   "exit.stop_loss_pct"
//   "exit.take_profit_tiers[0].trigger_pct"
//   "entry.conditions[2].value"
function pathParts(path) {
  return path.split('.').flatMap(seg => {
    const m = seg.match(/^(\w+)\[(\d+)\]$/);
    return m ? [m[1], parseInt(m[2], 10)] : [seg];
  });
}
function getByPath(obj, path) {
  let cur = obj;
  for (const p of pathParts(path)) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
function setByPath(obj, path, value) {
  const parts = pathParts(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) {
      cur[parts[i]] = typeof parts[i + 1] === 'number' ? [] : {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// Read top-N features per target from saved model JSONs. These are
// permutation importances computed by train.py at fit time — tells us which
// input features the model leans on hardest for each target.
function loadFeatureImportances(topN = 6) {
  const out = {};
  try {
    if (!fs.existsSync(MODELS_DIR)) return out;
    for (const f of fs.readdirSync(MODELS_DIR)) {
      if (!f.endsWith('_v1.json') || f.includes('smoke')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, f), 'utf8'));
        const target = j.target;
        const fi = j.feature_importances;
        if (!target || !fi) continue;
        const top = Object.entries(fi).sort((a, b) => b[1] - a[1]).slice(0, topN);
        out[target] = top;
      } catch {}
    }
  } catch {}
  return out;
}

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
  // === CULTURAL PULSE — read this FIRST. Memes drive memecoins. ===
  const flags = s.activeFlags.all();
  if (flags.length > 0) {
    lines.push('');
    lines.push('=== USER MANUAL FLAGS (high priority — direct human observations) ===');
    for (const f of flags) lines.push(`  • ${f.flag}${f.note ? ' — ' + f.note : ''}`);
  }

  const synth = s.latestSynthesis.get();
  if (synth?.summary) {
    const ageHr = synth.ts ? ((Date.now() - synth.ts) / 3600000).toFixed(1) : '?';
    lines.push('');
    lines.push(`=== CURRENT CULTURAL META (synthesized ${ageHr}h ago by your news layer — read carefully) ===`);
    lines.push(synth.summary);
  }

  // Phase C — live sentiment scores from the per-post worker (15-min cycles).
  // Higher resolution than the 4h cultural-meta synthesis: shows WHICH MINTS
  // and WHICH NARRATIVES are getting talked about RIGHT NOW with bull/bear/shill
  // breakdown. The agent should weigh shill_mentions skeptically and
  // bull_mentions positively, especially with high confidence.
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const sentWindow = Math.floor(Date.now() / FOUR_HOURS) * FOUR_HOURS;
  const topSentMints = s.topSentimentMints.all(sentWindow);
  const topSentNarr = s.topSentimentNarratives.all(sentWindow);
  if (topSentMints.length > 0 || topSentNarr.length > 0) {
    lines.push('');
    lines.push('=== LIVE SENTIMENT (current 4h window, per-post Claude scoring) ===');
    if (topSentMints.length > 0) {
      lines.push('Top mints by mention count:');
      for (const m of topSentMints) {
        const sym = m.symbol || '?';
        const conf = m.avg_conf != null ? (m.avg_conf * 100).toFixed(0) + '%' : '—';
        lines.push(`  • $${sym} (${(m.name || '').slice(0, 30)}) · ${m.total_mentions} mentions · ▲${m.bull_mentions || 0} ▼${m.bear_mentions || 0} ⚠shill${m.shill_mentions || 0} · conf ${conf}`);
      }
    }
    if (topSentNarr.length > 0) {
      lines.push('Top narratives:');
      for (const n of topSentNarr) {
        const conf = n.avg_conf != null ? (n.avg_conf * 100).toFixed(0) + '%' : '—';
        lines.push(`  • [${n.theme}] · ${n.total_mentions} mentions · ▲${n.bull_mentions || 0} ▼${n.bear_mentions || 0} ⚠shill${n.shill_mentions || 0} · conf ${conf}`);
      }
    }
  }

  // === ANOMALIES (predictive — what's happening RIGHT NOW that's unusual) ===
  const anomalies = s.activeAnomalies.all();
  if (anomalies.length > 0) {
    lines.push('');
    lines.push('=== ACTIVE ANOMALIES (predictive shift signals — meta is moving) ===');
    lines.push('These fire when something unusual happens BEFORE it shows up in outcomes. React faster than baseline lets you.');
    for (const a of anomalies) {
      const ageMin = Math.round((Date.now() - a.ts) / 60000);
      const sev = a.severity === 'high' ? '🔴' : a.severity === 'watch' ? '🟡' : 'ℹ️';
      lines.push(`  ${sev} [${a.kind}] ${a.description} (${ageMin}m ago)`);
    }
  }

  const trumpN = s.recentTrumpCount.get()?.n || 0;
  if (trumpN > 0) {
    lines.push('');
    lines.push(`=== TRUMP ACTIVITY: ${trumpN} Truth Social posts in last 4h. Trump posts move pump.fun memecoins immediately — check the meta synthesis for specifics. ===`);
  }

  const news = s.topRecentNews.all();
  if (news.length > 0) {
    lines.push('');
    lines.push('=== TOP RECENT NEWS (last 4h, sorted by relevance) ===');
    for (const n of news) lines.push(`  • [${n.source}] ${n.title?.slice(0, 140)}`);
  }

  const trendSigs = s.topRecentTrends.all();
  if (trendSigs.length > 0) {
    lines.push('');
    lines.push('=== TRENDING SIGNALS (tickers/keywords aggregated from Reddit + CoinGecko + DexScreener + GeckoTerminal) ===');
    for (const t of trendSigs) lines.push(`  • ${t.keyword} (${t.source}, score ${(t.score || 0).toFixed(1)})`);
  }

  lines.push('');
  lines.push('=== BASELINE OUTCOMES (whole population) ===');
  lines.push(`peaked_30 rate: ${(baseline.p30 * 100).toFixed(2)}%`);
  lines.push(`peaked_100 rate: ${(baseline.p100 * 100).toFixed(2)}%`);
  lines.push(`migrated rate: ${(baseline.mig * 100).toFixed(2)}%`);
  lines.push(`avg peak %: ${(baseline.peak_avg * 100).toFixed(2)}%`);
  // === TIME-OF-DAY PATTERNS ===
  const hourly = s.hourlyPumpRates.all();
  if (hourly.length > 0) {
    const nowHour = new Date().getUTCHours();
    const nowDow = new Date().getUTCDay();
    const popRate = baseline.p30 || 0;
    // Sort to find best/worst hours
    const sortedByP30 = [...hourly].sort((a, b) => (b.p30 || 0) - (a.p30 || 0));
    const bestHrs = sortedByP30.slice(0, 3).map(h => h.hr);
    const worstHrs = sortedByP30.slice(-3).map(h => h.hr);
    const cur = hourly.find(h => h.hr === nowHour);
    lines.push('');
    lines.push('=== HOURLY PUMP RATES (UTC, snapshot_age=60s rows) ===');
    lines.push(`Current hour: ${nowHour} UTC. Best hours for peaked_30: ${bestHrs.join(',')} UTC. Worst: ${worstHrs.join(',')} UTC.`);
    if (cur) {
      const lift = popRate > 0 ? (cur.p30 / popRate).toFixed(2) : '?';
      lines.push(`Right now (hour ${nowHour}): peaked_30 ${(cur.p30 * 100).toFixed(1)}% vs population ${(popRate * 100).toFixed(1)}% = ${lift}x lift. n=${cur.n} historical samples.`);
    }
    lines.push('hr  n     p30%  p100% mig%  avg_peak%');
    for (const r of hourly) {
      const marker = r.hr === nowHour ? '◀ NOW' : '';
      lines.push(`  ${String(r.hr).padStart(2)} ${String(r.n).padEnd(6)}${(r.p30*100).toFixed(1).padEnd(7)}${(r.p100*100).toFixed(1).padEnd(7)}${(r.mig*100).toFixed(1).padEnd(7)}${(r.avg_peak*100).toFixed(0)}  ${marker}`);
    }
    lines.push('Tactical: agent can gate entries to hours with above-population p30 (e.g. min_mint_age + max_mint_age narrows the window, but stronger is to skip cycles entirely during dead hours).');
  }

  const dows = s.dowPumpRates.all();
  if (dows.length > 0) {
    const dowName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const nowDow = new Date().getUTCDay();
    lines.push('');
    lines.push('=== DAY-OF-WEEK PUMP RATES ===');
    lines.push(`Current day: ${dowName[nowDow]} (UTC).`);
    for (const r of dows) {
      const marker = r.dow === nowDow ? '◀ TODAY' : '';
      lines.push(`  ${dowName[r.dow]}  n=${r.n}  p30=${(r.p30*100).toFixed(1)}%  p100=${(r.p100*100).toFixed(1)}%  mig=${(r.mig*100).toFixed(1)}%  avg_peak=${(r.avg_peak*100).toFixed(0)}%  ${marker}`);
    }
  }

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
  // Feature importances — what each model actually leans on
  const fis = loadFeatureImportances(6);
  if (Object.keys(fis).length > 0) {
    lines.push('');
    lines.push('=== FEATURE IMPORTANCES (which inputs each model relies on) ===');
    lines.push('Top features per target by permutation importance. If a feature is high here, the model is heavily using it. Use this to design entry conditions in the model\'s language — and to spot when intuition disagrees with what the model actually weighs.');
    for (const [target, top] of Object.entries(fis)) {
      const formatted = top.map(([f, v]) => `${f}=${v.toFixed(3)}`).join(', ');
      lines.push(`  ${target}: ${formatted}`);
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
  // Surface recent human manual-overrides on live strategies. The human has
  // looked at the data and adjusted something — Claude should see what they
  // changed and the reasoning, both as inspiration and to compare its
  // proposals against the human's intuition.
  try {
    const overrides = db().prepare(`
      SELECT timestamp, strategy_id, message FROM ml_agent_log
      WHERE category='manual-override'
        AND timestamp > strftime('%s','now')*1000 - 7*24*3600000
      ORDER BY timestamp DESC LIMIT 8
    `).all();
    if (overrides.length > 0) {
      lines.push('=== HUMAN MANUAL OVERRIDES (recent, last 7 days) ===');
      lines.push('A human operator looked at strategy performance and made the following manual changes. Their reasoning is included. Treat these as a strong signal — the human has context the bot does not. Compare your future proposals against this thinking; do not undo their changes without a specific data-backed reason.');
      for (const o of overrides) {
        const ageH = ((Date.now() - o.timestamp) / 3600000).toFixed(1);
        lines.push(`  [${ageH}h ago] ${o.strategy_id}: ${o.message}`);
      }
      lines.push('');
    }
  } catch { /* ignore */ }
  if (_bleedersForNextProposal && _bleedersForNextProposal.length > 0) {
    lines.push('=== BLEEDING STRATEGIES — PROPOSE A VARIANT THAT FIXES THE FAILURE MODE ===');
    for (const b of _bleedersForNextProposal) {
      lines.push(`  ${b.id}: ${b.closed} closed trades, ${b.pnl_sol.toFixed(3)} SOL realized (${b.pnl_pct_of_wallet.toFixed(1)}% of wallet). Read its exit_reason distribution and recent trade ml_features in the data above and propose a recipe that targets a DIFFERENT failure mode — different entry filter, different exit policy, different size scaling, different time-of-day, etc. Do NOT just tweak parameters; propose a meaningfully different recipe with a clear hypothesis for why it should outperform.`);
    }
    lines.push('');
  }
  // Pull recent orphan retirements from DB (survives restart) plus any
  // captured in-memory this cycle. Limit to last 7 days, dedup by id.
  const recentOrphans = (() => {
    try {
      const rows = db().prepare(`
        SELECT ml_agent_log.strategy_id AS id, ml_agent_log.timestamp AS retired_at,
               ml_agent_log.message AS msg, ml_agent_strategies.recipe_json
        FROM ml_agent_log
        LEFT JOIN ml_agent_strategies ON ml_agent_strategies.id = ml_agent_log.strategy_id
        WHERE ml_agent_log.category = 'introspect'
          AND ml_agent_log.level = 'retire'
          AND ml_agent_log.message LIKE 'orphan-retired%'
          AND ml_agent_log.timestamp > strftime('%s','now')*1000 - 7*24*3600000
        ORDER BY ml_agent_log.timestamp DESC LIMIT 12
      `).all();
      return rows.map(r => {
        let conditions = [];
        let ageWindow = '?';
        let name = r.id;
        try {
          const recipe = JSON.parse(r.recipe_json || '{}');
          name = recipe.name || r.id;
          conditions = (recipe.entry?.conditions || []).map(c =>
            `${c.kind === 'feature' ? 'feature.' : ''}${c.name} ${c.op} ${c.value}`);
          ageWindow = `mint_age ${recipe.entry?.min_mint_age_sec || 0}–${recipe.entry?.max_mint_age_sec || '∞'}s`;
        } catch {}
        const ageMatch = r.msg.match(/no entries in (\d+\.\d+)h/);
        return {
          id: r.id, name, conditions, age_window: ageWindow,
          age_hours: ageMatch ? Number(ageMatch[1]) : 0,
        };
      });
    } catch { return []; }
  })();
  if (recentOrphans.length > 0) {
    lines.push('=== ORPHANED STRATEGIES (recent recipes that NEVER fired an entry) ===');
    lines.push(`These ${recentOrphans.length} recipes got 0 entries in ≥1h. Their filter stacks were too strict to match real mints. DO NOT propose another recipe with this much overlap — LOOSEN one or more conditions, or reach for a different signal entirely. Common failure modes: too many stacked conditions, drawdown_from_peak_pct filter too tight (try ≥0.45 or drop it entirely), mint-age window too narrow.`);
    for (const o of recentOrphans) {
      lines.push(`  ${o.name} (retired after ${o.age_hours}h, 0 entries):`);
      lines.push(`    filters: ${o.conditions.join(' AND ') || '(unparseable)'}`);
      lines.push(`    window: ${o.age_window}`);
    }
    lines.push('');
    lines.push('When you propose your next recipe: drop AT LEAST one filter condition vs. these orphans, OR significantly widen the mint-age window, OR loosen a probability threshold. Zero entries means zero learning. Bias toward FEWER, LOOSER conditions until you actually catch trades to learn from.');
    lines.push('');
  }
  lines.push('=== FRICTION ===');
  lines.push('Realistic exit costs: ~3-8% slippage on entry, ~5-10% on exit, plus priority fee (~0.005 SOL contested).');
  lines.push('A predicted +30% peak is barely break-even after friction. Need clear edge above that.');

  // Critical context — the model is severely under-confident across all deciles
  lines.push('');
  lines.push('=== CRITICAL: MODEL CALIBRATION REALITY ===');
  lines.push('The classifier is SYSTEMATICALLY UNDER-CONFIDENT. Observed gaps from calibration data:');
  lines.push('  predicted 2.8%  → actual 17.1%  (×6.1)');
  lines.push('  predicted 14.8% → actual 45.2%  (×3.0)');
  lines.push('  predicted 25.2% → actual 62.3%  (×2.5)');
  lines.push('  predicted 35.2% → actual 79.9%  (×2.3)');
  lines.push('  predicted 44.7% → actual 89.4%  (×2.0)');
  lines.push('TAKEAWAY: do NOT trust face-value probabilities as calibrated. The model is great at RANKING (lift is huge — 3-6x baseline at modest thresholds) but bad at honest probabilities. Set your entry thresholds based on the OBSERVED RATE in the lift table above, not on the predicted prob. e.g. if you want >80% real pump rate, threshold is peaked_30 ≥ 0.35 (not 0.80).');

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

  // Per-strategy lift profile — entry quality independent of exits
  const perStratLift = s.perStrategyLift.all();
  if (perStratLift.length > 0) {
    lines.push('');
    lines.push('=== PER-STRATEGY LIFT (did your ENTRIES catch pumps? — separates entry quality from exit logic) ===');
    lines.push('Population baseline (any mint scored): peaked_30 ≈ 4%, peaked_100 ≈ 1.7%, mig ≈ 1%, avg_peak ≈ 14%');
    for (const r of perStratLift) {
      const labeled = r.n_labeled || 0;
      if (labeled < 3) {
        lines.push(`  ${r.strategy}: ${r.n_trades} trades, ${labeled} labeled (too fresh to assess)`);
        continue;
      }
      const p30 = ((r.true_p30_rate || 0) * 100).toFixed(0);
      const p100 = ((r.true_p100_rate || 0) * 100).toFixed(0);
      const p300 = ((r.true_p300_rate || 0) * 100).toFixed(0);
      const mig = ((r.true_mig_rate || 0) * 100).toFixed(0);
      const truePeak = ((r.avg_true_peak || 0) * 100).toFixed(0);
      const realizedPeak = (r.avg_realized_peak || 0).toFixed(0);
      const pnlPct = ((r.avg_pnl_pct || 0) * 100).toFixed(1);
      lines.push(`  ${r.strategy}:`);
      lines.push(`    n=${r.n_trades} (${labeled} labeled) · ${r.wins}W · realized PnL ${r.pnl_sol} SOL · avg_pnl_pct=${pnlPct}%`);
      lines.push(`    ENTRIES caught: ${p30}% peaked_30 · ${p100}% peaked_100 · ${p300}% peaked_300 · ${mig}% migrated · avg true peak ${truePeak}%`);
      lines.push(`    EXITS captured: avg realized peak only ${realizedPeak}% during hold (vs true peak ${truePeak}% — gap = exit logic leaving money on table)`);
    }
  }

  // DATA QUALITY NOTICE — fired only when there are flagged historical
  // positions. Two known flag values:
  //   junk_exit_tick — pre-2026-05-11 sub-curve-floor exit ticks
  //   dup_tier_fire — May 9-11 2026 duplicate-bot-tree caused tiers to
  //                   fire 2-3× on the same position, inflating realized PnL
  const dqRows = s.dataQualitySummary.all();
  if (dqRows.length > 0) {
    lines.push('');
    lines.push('=== DATA QUALITY NOTICE — historical PnL inflation/distortion ===');
    lines.push('Some closed positions have unreliable realized_pnl_sol. Two known causes:');
    lines.push('  • junk_exit_tick: pre-2026-05-11 the bot accepted sub-bonding-curve-floor price ticks at exit, recording fake -99% losses on positions that exited fine. Forward guard now in place.');
    lines.push('  • dup_tier_fire: May 9-11 a duplicate-bot-tree bug caused tier sells to fire 2-3× on the same position, INFLATING realized PnL by selling phantom tokens. Fixed 2026-05-11 via launchd-only supervision.');
    lines.push('Per-strategy flagged counts:');
    for (const r of dqRows) {
      lines.push(`  ${r.strategy}: ${r.flagged}/${r.total} closes flagged (${r.pct_flagged}% of last 7d)`);
    }
    lines.push('When deciding whether a strategy is broken, MENTALLY EXCLUDE flagged rows. New closes post-2026-05-11 are clean.');
  }

  // REJECTED VS ACCEPTED — close the open learning loop. gate_rejections
  // table has every mint we passed on; join to ml_mint_snapshots gives the
  // ACTUAL outcome of mints we rejected. Lets the agent see which gates are
  // filtering correctly vs filtering blindly.
  const rejectionLearnings = s.rejectionLearnings.all();
  if (rejectionLearnings.length > 0) {
    const baseline = s.acceptedBaseline.get();
    lines.push('');
    lines.push('=== REJECTED VS ACCEPTED (last 7d) — are gates filtering winners or losers? ===');
    if (baseline?.n > 0) {
      lines.push(`ACCEPTED ENTRIES baseline (n=${baseline.n}): avg PnL ${(baseline.avg_pnl_pct * 100).toFixed(1)}% · avg realized peak ${(baseline.avg_peak_pct * 100).toFixed(0)}% · ${baseline.n_2x} hit 2x · ${baseline.n_4x} hit 4x`);
      lines.push('');
    }
    lines.push('REJECTED mints (TRUE outcomes — what gates filtered out):');
    for (const r of rejectionLearnings) {
      const labeled = r.n_labeled || 0;
      if (labeled < 5) {
        lines.push(`  ${r.reason}: ${r.n_rejected} rejected · ${labeled} labeled (too fresh to assess)`);
        continue;
      }
      const p30 = ((r.p30_rate || 0) * 100).toFixed(1);
      const p100 = ((r.p100_rate || 0) * 100).toFixed(1);
      const peakPct = ((r.avg_peak_pct || 0) * 100).toFixed(0);
      lines.push(`  ${r.reason}: ${r.n_rejected} rejected · of ${labeled} labeled: p30=${p30}% p100=${p100}% avg_peak=${peakPct}% · ${r.n_2x_missed} hit 2x · ${r.n_4x_missed} hit 4x · ${r.n_migrated_missed} migrated`);
    }
    lines.push('');
    lines.push('Interpret: if a reject reason\'s p100 rate is HIGHER than the accepted baseline\'s peak rate, the gate is rejecting winners — re-examine that gate or use a different filter. If p100 is LOW, the gate is doing its job.');
  }

  // DCA performance — only renders if any strategy fired DCA in the last 7d.
  // Tells the agent whether scale-in helped or hurt per strategy. Agent can
  // tune dca_trigger_pct / dca_size_pct / dca_enabled based on these numbers.
  const dcaPerf = s.dcaPerformance.all();
  if (dcaPerf.length > 0) {
    lines.push('');
    lines.push('=== DCA PERFORMANCE (last 7d) — did scale-in help on the strategies that opted in? ===');
    lines.push('Compares DCA\'d positions vs non-DCA\'d positions WITHIN the same strategy.');
    lines.push('If avg_pnl_dca >> avg_pnl_no_dca → DCA is working; consider widening conditions (lower trigger_pct = catch deeper dips, higher size_pct = bigger adds).');
    lines.push('If avg_pnl_dca << avg_pnl_no_dca → DCA is throwing good money after bad; tighten trigger_pct (e.g. -40% instead of -25%) or disable.');
    for (const r of dcaPerf) {
      lines.push(`  ${r.strategy}:`);
      lines.push(`    DCA'd ${r.n_dca}/${r.n_total} positions (${r.n_dca_wins}W on DCA vs ${r.n_nodca_wins}W on non-DCA)`);
      lines.push(`    avg PnL: DCA=${r.avg_pnl_pct_dca ?? '?'}% · non-DCA=${r.avg_pnl_pct_no_dca ?? '?'}% · avg ${r.avg_sol_added ?? 0} SOL added per DCA · post-DCA peak ${r.avg_post_dca_peak_pct ?? '?'}%`);
    }
  }

  // Per-mint trade narratives — last 5 closed agent positions in detail
  const recentTrades = s.recentClosedAgentTrades.all();
  if (recentTrades.length > 0) {
    lines.push('');
    lines.push('=== LAST 5 CLOSED AGENT TRADES (full narrative — predictions at entry, price path, tracked-wallet activity during hold, post-exit fate) ===');
    for (const t of recentTrades) {
      let signal = {};
      try { signal = JSON.parse(t.entry_signal || '{}'); } catch {}
      const preds = signal.predictions || {};
      const predsStr = Object.entries(preds).map(([k, v]) => {
        if (typeof v !== 'number') return `${k}=${v}`;
        if (k === 'time_to_peak_sec') return `${k}=${Math.round(v)}s`;
        return `${k}=${v.toFixed(2)}`;
      }).join(' ');
      const heldMs = (t.exited_at || 0) - t.entered_at;
      const heldMin = (heldMs / 60000).toFixed(1);
      // Tracked-wallet activity during hold
      const activity = s.trackedActivityInWindow.get(t.mint_address, t.entered_at, t.exited_at || Date.now()) || {};
      // Price path: sample 6 evenly-spaced points
      const path = s.pricePathInWindow.all(t.mint_address, t.entered_at, t.exited_at || Date.now());
      const pathStr = (() => {
        if (path.length === 0) return '(no trades during hold)';
        const stride = Math.max(1, Math.floor(path.length / 6));
        const sampled = [];
        for (let i = 0; i < path.length; i += stride) sampled.push(path[i]);
        return sampled.map(p => `${(((p.price_sol / t.entry_price) - 1) * 100).toFixed(0)}%`).join('→');
      })();
      // Post-exit: did the mint keep running?
      const postExit = s.postExitMaxPrice.get(t.mint_address, t.exited_at || Date.now(), t.exited_at || Date.now()) || {};
      const postExitGain = postExit.max_price && t.entry_price
        ? (((postExit.max_price / t.entry_price) - 1) * 100).toFixed(0) + '%'
        : '?';
      const sym = t.symbol || '?';
      const name = (t.name || '?').slice(0, 30);
      const desc = (t.description || '').slice(0, 80).replace(/\n/g, ' ');
      const socials = [t.twitter && 'tw', t.telegram && 'tg', t.website && 'web'].filter(Boolean).join('/') || 'no-socials';
      lines.push('');
      lines.push(`  • $${sym} "${name}" — ${desc} [${socials}]`);
      lines.push(`    strategy: ${t.strategy.slice(0, 50)}…`);
      lines.push(`    PREDICTIONS at entry: ${predsStr}`);
      lines.push(`    SIZE: ${t.entry_sol} SOL · ENTRY mcap: ${(t.entry_mcap_sol || 0).toFixed(1)} SOL`);
      lines.push(`    PRICE PATH during hold: ${pathStr} (entry=0%)`);
      lines.push(`    TRACKED ACTIVITY during hold: ${activity.tracked_buys || 0} buys / ${activity.tracked_sells || 0} sells (KOLs: ${activity.kol_buys || 0}b/${activity.kol_sells || 0}s)`);
      lines.push(`    EXIT: ${t.exit_reason} after ${heldMin}min · realized=${t.realized_pnl_pct}% · best peak during hold=${t.highest_pct}%`);
      lines.push(`    POST-EXIT (next 2hr): mint ${postExitGain === '?' ? 'no further trades' : `peaked ${postExitGain} from your entry`}`);
    }
    lines.push('');
    lines.push('Read these like case studies. Look for: did entry conditions actually catch winners? Did tracked wallets keep buying or dump? Did mint keep pumping after you exited (= exit too early) or stay flat (= exit was correct)?');
  }

  // Cross-strategy overlap — head-to-head where strategies overlapped
  const overlap = s.overlapPairs.all();
  if (overlap.length > 0) {
    lines.push('');
    lines.push('=== CROSS-STRATEGY HEAD-TO-HEAD (mints both strategies entered) ===');
    for (const r of overlap) {
      const aPct = ((r.a_avg_pct || 0) * 100).toFixed(1);
      const bPct = ((r.b_avg_pct || 0) * 100).toFixed(1);
      const winner = r.a_won >= r.overlap_n / 2 ? r.strat_a : r.strat_b;
      const ratio = `${r.a_won}/${r.overlap_n}`;
      lines.push(`  ${r.strat_a.slice(-30)} vs ${r.strat_b.slice(-30)}: ${r.overlap_n} overlap mints · A avg ${aPct}% · B avg ${bPct}% · A_won=${ratio}`);
      lines.push(`    → ${winner.slice(-30)} performed better on shared picks. Compare their exit logic — that's likely what differs.`);
    }
    lines.push('When two strategies catch the same mints but get different outcomes, the difference is in EXIT logic (sizing/SL/TP/trailing). Use this to learn which exit pattern works on which entry pattern.');
  }

  const exitReasons = s.perStrategyExitReasons.all();
  if (exitReasons.length > 0) {
    lines.push('');
    lines.push('=== EXIT REASON BREAKDOWN (where your trades closed — and at what PnL) ===');
    let lastStrat = '';
    for (const r of exitReasons) {
      if (r.strategy !== lastStrat) { lines.push(`  ${r.strategy}:`); lastStrat = r.strategy; }
      lines.push(`    ${r.exit_reason}: ${r.n} trades · avg_pnl=${r.avg_pnl_pct}%`);
    }
    lines.push('Lots of SL_HIT means stops are too tight or entries are mistimed. Lots of TIME_EXIT means holds are too short OR pumps stalled. Lots of TIER_x means TPs are working — banking profit.');
  }

  // Strategy lineage / family tree — what evolved from what
  const lineage = s.recentLineageOverview.all();
  if (lineage.length > 0) {
    lines.push('');
    lines.push('=== STRATEGY LINEAGE (your evolutionary tree — what worked, what got replaced, what taught what) ===');
    for (const st of lineage) {
      const statusIcon = st.status === 'live' ? '🟢' : st.status === 'retired' ? '🪦' : '⏸️';
      const parent = st.parent_strategy_id ? ` ← from ${st.parent_strategy_id.slice(-30)}` : ' [first generation]';
      lines.push(`  ${statusIcon} gen-${st.generation} · ${st.id} · ${st.n_trades} trades · ${st.pnl} SOL${parent}`);
    }
    // For each LIVE strategy, list any modifications
    const liveStrats = lineage.filter(st => st.status === 'live');
    for (const st of liveStrats) {
      const mods = s.strategyMods.all(st.id);
      if (mods.length > 0) {
        lines.push(`  modifications to ${st.id.slice(-30)}:`);
        for (const m of mods) lines.push(`    • ${m.field_path}: ${m.old_value} → ${m.new_value} (${m.reason || 'no reason'})`);
      }
    }
    lines.push('Use lineage to learn from your evolution. If gen-1 had problem X and gen-2 fixed it but introduced Y, gen-3 should keep the X-fix and try addressing Y.');
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
    lines.push('=== MINT INTEL TALLY (last 24h verdicts on metadata) ===');
    for (const r of intelTally) lines.push(`  ${r.verdict}: ${r.n}`);
    lines.push('You can require ml_mint_intel.verdict in entry conditions to filter for "winner" mints or exclude "ruggy" ones — but note most mints fall in "clean" bucket.');
  }

  // === MARKET REGIME ===
  const regime = s.dailyRegime.all();
  if (regime.length >= 3) {
    const today = regime[0];
    const trailing = regime.filter(r => r.days_ago > 0 && r.days_ago <= 7);
    const trailMed = (key) => {
      const vals = trailing.map(r => r[key]).filter(v => v != null).sort((a, b) => a - b);
      return vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    };
    const baseP30 = trailMed('p30') || 0.0001;
    const baseMig = trailMed('mig') || 0.0001;
    const basePeak = trailMed('avg_peak') || 0.0001;
    const baseN = trailMed('n') || 1;
    const p30Lift = (today.p30 || 0) / baseP30;
    const migLift = (today.mig || 0) / baseMig;
    const peakLift = (today.avg_peak || 0) / basePeak;
    const composite = (p30Lift + migLift + peakLift) / 3;
    let regimeLabel = 'NORMAL';
    if (composite >= 1.5) regimeLabel = '🔥 HOT';
    else if (composite >= 1.2) regimeLabel = '☀️ WARM';
    else if (composite <= 0.6) regimeLabel = '🥶 COLD';
    else if (composite <= 0.85) regimeLabel = '🧊 COOL';

    const mintsToday = s.mintsCreatedToday.get()?.n || 0;
    const mintsAvg = s.mintsCreated7dAvg.get()?.avg_per_day || 0;
    const migsToday = s.migrationsToday.get()?.n || 0;
    const migsAvg = s.migrations7dAvg.get()?.avg_per_day || 0;

    lines.push('');
    lines.push(`=== MARKET REGIME — ${regimeLabel} ===`);
    lines.push(`Today vs trailing 7d (median):`);
    lines.push(`  peaked_30 rate: ${(today.p30*100).toFixed(1)}% vs ${(baseP30*100).toFixed(1)}% baseline (${p30Lift.toFixed(2)}x)`);
    lines.push(`  migration rate: ${(today.mig*100).toFixed(1)}% vs ${(baseMig*100).toFixed(1)}% baseline (${migLift.toFixed(2)}x)`);
    lines.push(`  avg peak %: ${(today.avg_peak*100).toFixed(0)}% vs ${(basePeak*100).toFixed(0)}% baseline (${peakLift.toFixed(2)}x)`);
    lines.push(`  mints created (last 24h): ${mintsToday} vs ${mintsAvg.toFixed(0)}/day baseline (${(mintsToday / Math.max(mintsAvg, 1)).toFixed(2)}x)`);
    lines.push(`  migrations (last 24h): ${migsToday} vs ${migsAvg.toFixed(1)}/day baseline (${(migsToday / Math.max(migsAvg, 0.1)).toFixed(2)}x)`);
    lines.push('');
    lines.push(`Last 8 days breakdown:`);
    for (const r of regime) {
      lines.push(`  ${r.days_ago === 0 ? 'TODAY' : r.days_ago + 'd ago'}: n=${r.n} · p30=${(r.p30*100).toFixed(1)}% · mig=${(r.mig*100).toFixed(1)}% · peak=${(r.avg_peak*100).toFixed(0)}% · 2xs=${r.n_2x} · migs=${r.n_mig}`);
    }
    lines.push('');
    if (regimeLabel.includes('HOT')) lines.push('Tactic: regime is hot — be MORE aggressive. Loosen entry thresholds slightly, consider larger size, hunt for the runners.');
    else if (regimeLabel.includes('WARM')) lines.push('Tactic: regime is decent — normal aggression, normal thresholds.');
    else if (regimeLabel.includes('COLD') || regimeLabel.includes('COOL')) lines.push('Tactic: regime is weak — be MORE selective. Tighten thresholds, smaller size, may be a day to skip mediocre setups entirely.');
  }

  // === ANOMALY DETECTOR (LAST 4H) ===
  // 6 anomaly kinds: volume_spike, tracked_cohort, dormant_creator,
  // theme_cluster, kol_cluster, tracked_dump. Was logged to the DB but never
  // surfaced to the agent before 2026-05-11. Counts + high-severity examples
  // help the agent see what's HAPPENING right now beyond just rate stats.
  const anomalySummary = s.recentAnomalySummary.all();
  if (anomalySummary.length > 0) {
    lines.push('');
    lines.push('=== ANOMALY DETECTOR — last 4h ===');
    lines.push('Real-time market events. Use these to time strategy proposals — e.g., a kol_cluster surge means smart money is moving, so a kol-buy strategy is timely.');
    for (const a of anomalySummary) {
      lines.push(`  ${a.kind} (${a.severity}): ${a.n}`);
    }
    const highEx = s.recentAnomalyExamples.all();
    if (highEx.length > 0) {
      lines.push('');
      lines.push('Recent HIGH-severity anomalies (sample):');
      for (const e of highEx) {
        lines.push(`  [${e.at}] ${e.kind}: ${e.description}`);
      }
    }
  }

  // === CROSS-TARGET CORRELATIONS ===
  const crossRows = s.perMintPredsAndOutcomes.all();
  if (crossRows.length >= 100) {
    lines.push('');
    lines.push('=== CROSS-TARGET CORRELATIONS (predicting with multiple models stacked) ===');
    lines.push(`Sample: n=${crossRows.length} mints with predictions + resolved labels (last 7d).`);
    const baseline = computeOutcome(crossRows, () => true);
    lines.push(fmtOut('BASELINE (any predicted mint)', baseline, baseline));
    lines.push('');
    lines.push('SINGLE-TARGET BUCKETS:');
    lines.push(fmtOut('peaked_30 ≥ 0.30 alone',          baseline, computeOutcome(crossRows, r => (r.p30 || 0) >= 0.30)));
    lines.push(fmtOut('peaked_100 ≥ 0.20 alone',         baseline, computeOutcome(crossRows, r => (r.p100 || 0) >= 0.20)));
    lines.push(fmtOut('peaked_300 ≥ 0.15 alone',         baseline, computeOutcome(crossRows, r => (r.p300 || 0) >= 0.15)));
    lines.push(fmtOut('migrated ≥ 0.30 alone',           baseline, computeOutcome(crossRows, r => (r.mig || 0) >= 0.30)));
    lines.push(fmtOut('hits_2x_within_1h ≥ 0.10 alone',  baseline, computeOutcome(crossRows, r => (r.h2x1h || 0) >= 0.10)));
    lines.push(fmtOut('migrates_within_15min ≥ 0.10 alone', baseline, computeOutcome(crossRows, r => (r.mig15 || 0) >= 0.10)));
    lines.push(fmtOut('rug_within_5min ≥ 0.30 alone',    baseline, computeOutcome(crossRows, r => (r.rug5 || 0) >= 0.30)));
    lines.push('');
    lines.push('STACKED COMBOS (where the agent finds the real edge):');
    lines.push(fmtOut('CLEAN PUMP: peaked_30 ≥ 0.30 AND will_die_fast < 0.40',     baseline, computeOutcome(crossRows, r => (r.p30 || 0) >= 0.30 && (r.die || 0) < 0.40)));
    lines.push(fmtOut('CONFLICTED: peaked_30 ≥ 0.30 AND will_die_fast ≥ 0.50',     baseline, computeOutcome(crossRows, r => (r.p30 || 0) >= 0.30 && (r.die || 0) >= 0.50)));
    lines.push(fmtOut('PUMP-AND-DUMP: peaked_30 ≥ 0.40 AND migrated < 0.05',       baseline, computeOutcome(crossRows, r => (r.p30 || 0) >= 0.40 && (r.mig || 0) < 0.05)));
    lines.push(fmtOut('ELITE STACK: migrated ≥ 0.30 AND peaked_300 ≥ 0.15',         baseline, computeOutcome(crossRows, r => (r.mig || 0) >= 0.30 && (r.p300 || 0) >= 0.15)));
    lines.push(fmtOut('ELITE+ALIVE: migrated ≥ 0.30 AND will_die_fast < 0.30',      baseline, computeOutcome(crossRows, r => (r.mig || 0) >= 0.30 && (r.die || 0) < 0.30)));
    lines.push(fmtOut('TRACKED+ML: peaked_300 ≥ 0.15 AND tracked_buyers ≥ 2',       baseline, computeOutcome(crossRows, r => (r.p300 || 0) >= 0.15 && (r.tracked_n || 0) >= 2)));
    lines.push(fmtOut('TRIPLE: mig ≥ 0.20 AND p300 ≥ 0.15 AND will_die_fast < 0.40', baseline, computeOutcome(crossRows, r => (r.mig || 0) >= 0.20 && (r.p300 || 0) >= 0.15 && (r.die || 0) < 0.40)));
    // New stacks featuring the new short-horizon + flash-rug signals.
    lines.push(fmtOut('FAST RUNNER: h2x1h ≥ 0.10 AND rug_within_5min < 0.20',       baseline, computeOutcome(crossRows, r => (r.h2x1h || 0) >= 0.10 && (r.rug5 || 0) < 0.20)));
    lines.push(fmtOut('IMMINENT MIG: migrates_within_15min ≥ 0.15 AND will_die_fast < 0.40', baseline, computeOutcome(crossRows, r => (r.mig15 || 0) >= 0.15 && (r.die || 0) < 0.40)));
    lines.push(fmtOut('SAFE FAST: h2x1h ≥ 0.10 AND will_die_fast < 0.30 AND rug5 < 0.20', baseline, computeOutcome(crossRows, r => (r.h2x1h || 0) >= 0.10 && (r.die || 0) < 0.30 && (r.rug5 || 0) < 0.20)));
    lines.push('');
    lines.push('Read the lift columns. Combos with 2-3x higher migration lift than their single-target version are real stacking edge. Combos where adding a filter DROPS the rate (e.g. CONFLICTED) reveal models contradicting each other — fade those signals.');
  }

  // === KOL / TRACKED-WALLET INTEL ===
  // Tracked-wallet activity is the strongest non-ML signal we have. The
  // agent should treat tracked_buyers ≥ 2 (or even ≥ 3) as a near-killer
  // entry condition stackable with model probabilities.
  const cohortLift = s.trackedCohortLift.all();
  if (cohortLift.length > 0) {
    lines.push('');
    lines.push('=== TRACKED-WALLET COHORT LIFT (104 tracked, 43 KOLs) ===');
    lines.push('Discrimination signal — what does it mean when N tracked/KOL wallets buy a mint?');
    lines.push('cohort      n           p30%   p100%  p300%  mig%   avg_peak%');
    for (const r of cohortLift) {
      lines.push(`  ${r.cohort.padEnd(12)}${String(r.n).padEnd(11)}${(r.p30*100).toFixed(1).padEnd(7)}${(r.p100*100).toFixed(1).padEnd(7)}${(r.p300*100).toFixed(1).padEnd(7)}${(r.mig*100).toFixed(1).padEnd(7)}${(r.avg_peak*100).toFixed(0)}`);
    }
    // Compute lift multiplier vs 0_tracked
    const baseline = cohortLift.find(r => r.cohort === '0_tracked');
    const top = cohortLift.find(r => r.cohort === '3plus_tracked');
    if (baseline && top) {
      const migLift = top.mig / Math.max(baseline.mig, 0.0001);
      const p30Lift = top.p30 / Math.max(baseline.p30, 0.0001);
      lines.push(`KEY FINDING: 3+ tracked buyers gives ${migLift.toFixed(0)}x the migration rate and ${p30Lift.toFixed(0)}x the peaked_30 rate vs zero tracked. This is your single strongest discriminator. Stack 'tracked_buyers >= 2' with ML probs and you have brutal edge.`);
    }
  }

  const bundleLift = s.bundleCohortLift.all();
  if (bundleLift.length > 0) {
    lines.push('');
    lines.push('=== BUNDLE-CLUSTER ACTIVITY LIFT ===');
    lines.push('Bundle = coordinated wallets (often same operator). Counter-intuitive: HEAVY bundle activity (6+) often means paid promo / coordinated launch and pumps harder than baseline. Sparse bundle (1-2) is usually noise.');
    lines.push('cohort       n           p30%   p100%  mig%   avg_peak%');
    for (const r of bundleLift) {
      lines.push(`  ${r.cohort.padEnd(13)}${String(r.n).padEnd(11)}${(r.p30*100).toFixed(1).padEnd(7)}${(r.p100*100).toFixed(1).padEnd(7)}${(r.mig*100).toFixed(1).padEnd(7)}${(r.avg_peak*100).toFixed(0)}`);
    }
  }

  const roster = s.kolRosterStats.get();
  const hits = s.kolRecentHits.get();
  if (roster && hits) {
    lines.push('');
    lines.push('=== KOL ROSTER + RECENT 7d ACTIVITY ===');
    lines.push(`  Total tracked: ${roster.tracked} · KOLs: ${roster.kol} · KOLs active in last 24h: ${roster.kol_active_24h} · tracked active 24h: ${roster.tracked_active_24h}`);
    lines.push(`  Last 7 days: ${hits.n_kols_active} unique tracked wallets bought ${hits.distinct_mints_bought} distinct mints, including ${hits.bought_a_migrator} migrators and ${hits.bought_big_pumper} mints that hit ≥100 SOL peak mcap.`);
    lines.push("  Tracked-wallet feature is 'tracked_buyers' in entry conditions. KOL-only is 'kol_buyers'. Bundles is 'bundle_buyers'.");
  }

  // === CULTURAL / META CONTEXT ===
  // pump.fun is a meme economy. Names, themes, descriptions, and creator
  // patterns are SIGNAL. Numbers can't capture vibes — surface raw metadata
  // so the agent can spot what's currently mooning vs dying.
  const fmtMint = (m, extra = '') => {
    const sym = (m.symbol || '?').slice(0, 12);
    const name = (m.name || '?').slice(0, 30);
    const desc = (m.description || '').slice(0, 110).replace(/\n/g, ' ');
    const socials = [m.twitter && 'tw', m.telegram && 'tg', m.website && 'web'].filter(Boolean).join('/') || 'no-socials';
    const creator = `creator: ${m.creator_launches || 0} launches${m.creator_migs ? `, ${m.creator_migs} migs` : ''}`;
    return `  • $${sym} "${name}" — ${desc}${desc ? ' · ' : ''}[${socials}] · ${creator}${extra ? ' · ' + extra : ''}`;
  };

  const bigPumpers = s.recentBigPumpers.all();
  if (bigPumpers.length > 0) {
    lines.push('');
    lines.push('=== ACTUAL WINNERS (mints that pumped ≥+100% in last 7d, ground truth) ===');
    lines.push('Look for naming themes, narrative patterns, social profiles. What do these have in common?');
    for (const m of bigPumpers) {
      const ttp = m.time_to_peak ? `peak in ${Math.round(m.time_to_peak / 60)}m` : '';
      const migMark = m.migrated ? '🚀 MIGRATED' : '';
      lines.push(fmtMint(m, `peaked +${m.peak_pct}% ${ttp} ${migMark}`));
    }
  }

  const migrators = s.recentMigrators.all();
  if (migrators.length > 0) {
    lines.push('');
    lines.push('=== ACTUAL MIGRATORS (last 3 days, graduated to Raydium/PumpSwap) ===');
    lines.push('These are the elite — pumped hard enough to escape the bonding curve. Naming/narrative patterns?');
    for (const m of migrators) {
      lines.push(fmtMint(m, `peak mcap ${m.peak_mcap} SOL`));
    }
  }

  const winners = s.recentWinnerVerdicts.all();
  if (winners.length > 0) {
    lines.push('');
    lines.push('=== MINTS YOUR HOURLY INTEL FLAGGED AS "WINNER" (metadata pattern matches) ===');
    lines.push('You marked these high-conviction based on metadata alone. They may not have pumped yet — verdicts are predictive, not confirmed.');
    for (const m of winners) {
      const sigs = (() => { try { return JSON.parse(m.signals_json || '[]').slice(0, 3).join(','); } catch { return ''; } })();
      lines.push(fmtMint(m, `signals: [${sigs}]`));
    }
  }

  const ruggy = s.recentRuggyVerdicts.all();
  if (ruggy.length > 0) {
    lines.push('');
    lines.push('=== RUGGY EXAMPLES (your intel module flagged as scam-coded) ===');
    lines.push('Patterns to AVOID — what do bad mints look like? Use these to inform what to filter out.');
    for (const m of ruggy) {
      const sigs = (() => { try { return JSON.parse(m.signals_json || '[]').slice(0, 3).join(','); } catch { return ''; } })();
      lines.push(fmtMint(m, `signals: [${sigs}]`));
    }
  }

  const deadFast = s.recentDeadFast.all();
  if (deadFast.length > 0) {
    lines.push('');
    lines.push('=== DEAD-FAST (peaked <+15% then went quiet, last 24h) ===');
    for (const m of deadFast) {
      lines.push(fmtMint(m));
    }
  }

  // === POST-MIGRATION CANDIDATES + OUTCOMES ===
  const migCands = s.topMigratedCandidates.all();
  const migOutcome = s.migOutcomeStats.get();
  if (migCands.length > 0 || (migOutcome && migOutcome.n_resolved > 0)) {
    lines.push('');
    lines.push('=== POST-MIGRATION (your other market) ===');
    if (migOutcome && migOutcome.n_resolved > 0) {
      lines.push(`Historical post-mig outcomes (n=${migOutcome.n_resolved}):`);
      lines.push(`  hit 2x: ${(migOutcome.rate_2x * 100).toFixed(1)}% · 5x: ${(migOutcome.rate_5x * 100).toFixed(1)}% · 10x: ${(migOutcome.rate_10x * 100).toFixed(1)}% · hit $1M: ${(migOutcome.rate_1m * 100).toFixed(1)}%`);
      lines.push(`  rugs in 1h: ${(migOutcome.rate_rug * 100).toFixed(1)}% · alive 24h: ${(migOutcome.rate_alive_24h * 100).toFixed(1)}% · avg post-mig peak: ${(migOutcome.avg_peak_pct * 100).toFixed(0)}%`);
    } else {
      lines.push('Migration snapshot system collecting data — labels resolve 24h+ post-migration. Distributions appear here once we have enough resolved.');
    }
    if (migCands.length > 0) {
      lines.push('');
      lines.push('Top migrated mints right now (active 72h window, sorted by 24h volume):');
      for (const c of migCands) {
        const sym = c.symbol || '?';
        const name = (c.name || '').slice(0, 24);
        lines.push(`  • $${sym} "${name}" age=${c.age_min}m · liq=$${c.liq_usd} · vol24h=$${c.vol_h24_usd} · ${c.amm_dex} · chg_1h=${c.chg_h1}% chg_24h=${c.chg_h24}% (${c.amm_buys_h24}b/${c.amm_sells_h24}s)`);
      }
    }
    lines.push('To target post-migration mints, set `targets_migrated: true` in your strategy recipe. Different game than pre-mig — bonding curve features mostly stale, AMM liquidity/volume/momentum dominate.');
  }

  const topPicks = s.currentTopPicks.all();
  if (topPicks.length > 0) {
    lines.push('');
    lines.push('=== CURRENTLY HIGH-PROB (last 10 min, peaked_300 prob > 0.10, not migrated/rugged) ===');
    lines.push('What the model thinks is hot RIGHT NOW. Cross-check against winner/loser themes above.');
    for (const m of topPicks) {
      lines.push(fmtMint(m, `peaked_300=${m.top_prob} · age=${m.age_min}m`));
    }
  }

  // Long-term memory — last 7 days of daily intelligence condensates
  const dailyIntel = s.recentDailyIntel.all();
  if (dailyIntel.length > 0) {
    lines.push('');
    lines.push('=== DAILY INTELLIGENCE (last 7 days condensed — your long-term memory) ===');
    lines.push('Use this to spot trends across days. Compare today to a week ago. Where did the meta drift?');
    for (const d of dailyIntel) {
      let stratPnl = '';
      try {
        const ps = JSON.parse(d.per_strategy_pnl_json || '{}');
        stratPnl = Object.entries(ps).map(([k, v]) => `${k.slice(-30)}=${v}`).join(', ');
      } catch {}
      let winners = '';
      try {
        const ws = JSON.parse(d.top_winners_json || '[]').slice(0, 3);
        winners = ws.map(w => `${w.symbol || w.name?.slice(0, 10)}(+${w.peak_pct}%)`).join(', ');
      } catch {}
      let themes = '';
      try {
        const ts = JSON.parse(d.top_themes_json || '[]').slice(0, 5);
        themes = ts.map(t => t.keyword).join(',');
      } catch {}
      const p30 = ((d.pop_peaked_30_rate || 0) * 100).toFixed(1);
      const peak = ((d.pop_avg_peak_pct || 0) * 100).toFixed(0);
      lines.push(`  ${d.date_key}: mints=${d.mints_created} migs=${d.mints_migrated} p30=${p30}% avg_peak=${peak}% trump_posts=${d.trump_post_count || 0}`);
      if (winners) lines.push(`    top winners: ${winners}`);
      if (themes) lines.push(`    top themes: ${themes}`);
      if (stratPnl) lines.push(`    strategies: ${stratPnl}`);
    }
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
  const edge = s.edgeCheck.get();
  const drift = (() => { try { return getModelHealth(); } catch { return null; } })();
  const live = s.liveStrategies.all();

  const criteria = {};
  // Enough calibration overlap for edge measurement to be meaningful
  criteria.calibration_data = {
    passed: (calib?.n || 0) >= 500,
    detail: `${calib?.n || 0} predictions matched against labels (need ≥500)`,
  };
  // Edge check — top-30%-prob picks should pump at clearly above-baseline rate.
  // We gate on BOTH lift AND absolute rate so the model passes when it ranks
  // well, even when the scoring sweep's selection bias inflates the baseline.
  // Threshold: ≥1.5x lift AND ≥50% absolute pump rate. With ~10% friction,
  // 50% absolute means EV-positive trades are achievable.
  const lift = edge?.baseline_rate > 0 && edge?.top_rate != null
    ? edge.top_rate / edge.baseline_rate : 0;
  // 1.3x lift threshold (was 1.5x). Rationale: baseline is already high
  // (~55%) because upstream candidate filters do a lot of work, which
  // compresses the lift ratio. Absolute pump rate floor (≥50%) is the
  // strong signal — lift just confirms the model isn't a flat function.
  const liftOk = lift >= 1.3;
  const absRateOk = (edge?.top_rate || 0) >= 0.50;
  const sampleOk = (edge?.top_n || 0) >= 50;
  criteria.has_measurable_edge = {
    passed: liftOk && absRateOk && sampleOk,
    detail: edge?.top_rate != null
      ? `top-30%-prob picks pump ${(edge.top_rate * 100).toFixed(1)}% vs baseline ${(edge.baseline_rate * 100).toFixed(1)}% = ${lift.toFixed(1)}x lift (n=${edge.top_n}; need ≥1.3x AND ≥50% rate AND n≥50)`
      : 'no edge data yet',
  };
  // Models exist and have decent metrics
  criteria.models_trained = {
    passed: overall.snapshots_labeled >= 5000,
    detail: `${overall.snapshots_labeled} labeled snapshots (need ≥5000)`,
  };
  // Drift OK — only block on CORE models the agent actually uses in recipes.
  // Weak/sparse models (peaked_300, time_to_peak_5x_sec, migrates_within_15min,
  // post_mig_rugs_1h) often alert from class imbalance, not real drift, and
  // shouldn't freeze strategy iteration. Agent's recipes reference: migrated,
  // will_die_fast, drawdown_from_peak_pct, rug_within_5min, peaked_30, peaked_100,
  // peak_pct_max, post_mig_hits_2x. If any of THOSE go red, gate. Otherwise pass.
  const CORE_MODELS = new Set([
    'migrated', 'will_die_fast', 'drawdown_from_peak_pct', 'rug_within_5min',
    'peaked_30', 'peaked_100', 'peak_pct_max', 'post_mig_hits_2x',
  ]);
  const coreRed = drift?.targets?.filter(t => CORE_MODELS.has(t.target) && t.level === 'red') || [];
  const coreYellow = drift?.targets?.filter(t => CORE_MODELS.has(t.target) && t.level === 'yellow') || [];
  criteria.no_drift = {
    passed: !drift || coreRed.length === 0,
    detail: !drift
      ? 'no drift status'
      : coreRed.length > 0
        ? `${coreRed.length} CORE model(s) red: ${coreRed.map(t => t.target).join(', ')}`
        : `core models healthy (${coreYellow.length} yellow, weak-model alerts ignored)`,
  };
  // Cap: don't run more than STRATEGY_CAP concurrent strategies.
  // When at cap AND bleeders exist, the cycle's pre-pass will retire the
  // worst-performing one (or the oldest 0-entry orphan) to make room.
  criteria.under_strategy_cap = {
    passed: live.length < STRATEGY_CAP,
    detail: `${live.length} active strategies (cap at ${STRATEGY_CAP})`,
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
  // Already have live strategies? Default behavior: be patient. Override:
  // if ANY live strategy is actively bleeding (n≥BLEED_MIN_TRADES AND PnL
  // fraction ≤ BLEED_PNL_FRACTION of starting wallet), allow proposing a
  // variant in parallel. Goal: agent should strive to find fixes when its
  // current strategies are losing, not sit on losses politely.
  const live = S().liveStrategies.all();
  const w = db().prepare('SELECT starting_balance_sol FROM paper_wallet WHERE id=1').get();
  const startBal = w?.starting_balance_sol || 1.0;
  const bleedThresholdSol = startBal * BLEED_PNL_FRACTION;
  const bleeders = [];
  for (const st of live) {
    const perf = S().strategyPerf.get(st.id, st.id, st.id, st.id, st.id);
    const closed = perf?.closed || 0;
    const pnl = perf?.pnl_sol || 0;
    if (closed >= BLEED_MIN_TRADES && pnl <= bleedThresholdSol) {
      bleeders.push({ id: st.id, closed, pnl_sol: pnl, pnl_pct_of_wallet: (pnl / startBal) * 100 });
    }
  }
  // Propose if: (a) no live strategies, (b) any bleeders to fix, OR
  // (c) roster has dropped below the freshness floor (likely due to orphan
  // retirement of overly-strict variants). Goal: keep agent iterating even
  // in quiet windows.
  const belowFreshFloor = live.length > 0 && live.length < STRATEGY_FRESH_FLOOR;
  if (live.length > 0 && bleeders.length === 0 && !belowFreshFloor) {
    logThought('thought', 'introspect', null,
      `${live.length} live strategy(ies) running, none bleeding, above freshness floor (${STRATEGY_FRESH_FLOOR}) — letting them accumulate before proposing variants`, null);
    return;
  }
  if (belowFreshFloor) {
    logThought('thought', 'introspect', null,
      `${live.length} live strategy(ies), below freshness floor (${STRATEGY_FRESH_FLOOR}) — proposing a new one to maintain roster diversity`, null);
  }
  if (bleeders.length > 0) {
    logThought('thought', 'introspect', null,
      `${bleeders.length} live strategy(ies) bleeding (PnL ≤ ${bleedThresholdSol.toFixed(3)} SOL on ≥${BLEED_MIN_TRADES} trades) — allowing variant proposal to strive for a fix`,
      { bleeders });
  }
  // Stash bleeders so buildContext can include them in the prompt for Claude.
  // Module-scope so buildContext can read without threading a parameter through.
  _bleedersForNextProposal = bleeders;
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
  // Lineage: if a strategy was recently retired, this new one is its child.
  // Otherwise it's a fresh first-generation start.
  const recentRetired = S().mostRecentRetiredStrategy.get();
  const parentId = recentRetired?.id || null;
  const generation = recentRetired ? (recentRetired.generation + 1) : 1;
  S().insertStrategy.run(id, recipe.name, recipe.rationale || '', JSON.stringify(recipe),
    Date.now(), parentId, generation);
  if (parentId) {
    logThought('info', 'introspect', id,
      `lineage: gen ${generation}, derived from ${parentId}`, { parentId, generation });
  }
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
  // Re-consult cooldown: 12h normally, BLEED_RECONSULT_HOURS for bleeders.
  // When a strategy is actively losing capital, we want fresher evaluations
  // so the modify path gets a chance to react before too much damage.
  const NORMAL_COOLDOWN_MS = 12 * 60 * 60 * 1000;
  const BLEEDING_COOLDOWN_MS = BLEED_RECONSULT_HOURS * 60 * 60 * 1000;
  const wForBleed = db().prepare('SELECT starting_balance_sol FROM paper_wallet WHERE id=1').get();
  const startBalForBleed = wForBleed?.starting_balance_sol || 1.0;
  const bleedThresholdSolForReeval = startBalForBleed * BLEED_PNL_FRACTION;

  // Pre-pass: emergency retire any strategy that's clearly destroying capital.
  // Code-only — no Claude consult, no rate limit, no soak time. Strategy must
  // have at least EMERGENCY_MIN_TRADES closed trades AND have realized loss
  // ≥ EMERGENCY_PNL_FRACTION of the paper wallet.
  const w = db().prepare('SELECT starting_balance_sol FROM paper_wallet WHERE id=1').get();
  const startBal = w?.starting_balance_sol || 1.0;
  const emergencyThreshold = startBal * EMERGENCY_PNL_FRACTION;
  for (const st of live) {
    const perf = S().strategyPerf.get(st.id, st.id, st.id, st.id, st.id);
    if ((perf?.closed || 0) < EMERGENCY_MIN_TRADES) continue;
    if ((perf?.pnl_sol || 0) > emergencyThreshold) continue;
    retireStrategy(st.id, `emergency: ${perf.closed} trades, ${(perf.pnl_sol || 0).toFixed(3)} SOL realized (${((perf.pnl_sol/startBal)*100).toFixed(1)}% of wallet)`);
    logThought('retire', 'introspect', st.id,
      `emergency-retired ${st.id}: ${perf.closed} trades, ${(perf.pnl_sol || 0).toFixed(3)} SOL loss`,
      { perf, threshold_sol: emergencyThreshold });
    console.log(`[agent] 🚨 EMERGENCY RETIRE: ${st.id} — ${perf.closed} trades, ${(perf.pnl_sol).toFixed(3)} SOL loss`);
  }

  // Reload live list after potential emergency retires
  const stillLive = S().liveStrategies.all();
  for (const st of stillLive) {
    if (consultedThisCycle >= burstCap) break;
    const ageHours = (Date.now() - st.created_at) / 3600000;
    if (ageHours < STRATEGY_SOAK_HOURS) continue;  // let it soak
    const perf = S().strategyPerf.get(st.id, st.id, st.id, st.id, st.id);
    if ((perf?.closed || 0) < 5) continue;  // need at least 5 closed trades
    if (!rateLimitOk()) continue;
    // Cooldown — skip if we evaluated this strategy recently. Bleeders get
    // a shorter cooldown so the modify path can react to fresh losses.
    const isBleeding = (perf?.closed || 0) >= BLEED_MIN_TRADES && (perf?.pnl_sol || 0) <= bleedThresholdSolForReeval;
    const cooldownMs = isBleeding ? BLEEDING_COOLDOWN_MS : NORMAL_COOLDOWN_MS;
    const lastEval = db().prepare(`SELECT MAX(timestamp) AS ts FROM ml_agent_log
       WHERE category = 'consult' AND strategy_id = ? AND level = 'info'`).get(st.id);
    if (lastEval?.ts && (Date.now() - lastEval.ts < cooldownMs)) continue;
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
      } else if (decision.decision === 'modify' && Array.isArray(decision.modifications) && decision.modifications.length > 0) {
        // Apply each modification to the recipe via dotted-path setter, log audit trail
        let modifiedRecipe = JSON.parse(JSON.stringify(recipe));
        const appliedMods = [];
        for (const mod of decision.modifications) {
          try {
            const oldVal = getByPath(modifiedRecipe, mod.field_path);
            setByPath(modifiedRecipe, mod.field_path, mod.new_value);
            S().insertModification.run(st.id, Date.now(), mod.field_path,
              JSON.stringify(oldVal), JSON.stringify(mod.new_value), mod.reason || decision.reason);
            appliedMods.push(`${mod.field_path}: ${JSON.stringify(oldVal)} → ${JSON.stringify(mod.new_value)}`);
          } catch (modErr) {
            logThought('error', 'consult', st.id, `modification failed for ${mod.field_path}: ${modErr.message}`, null);
          }
        }
        if (appliedMods.length > 0) {
          S().updateRecipe.run(JSON.stringify(modifiedRecipe), st.id);
          // Re-sync strategy_state with new exit values
          deployStrategy(st.id, modifiedRecipe);
          logThought('thought', 'consult', st.id,
            `modified ${st.id}: ${appliedMods.length} change(s) — ${decision.reason}`,
            { decision, applied: appliedMods });
          console.log(`[agent] ✏️ MODIFIED: ${st.id}`);
          for (const m of appliedMods) console.log(`[agent]    · ${m}`);
        }
      } else {
        logThought('thought', 'consult', st.id,
          `keeping ${st.id}: ${decision.reason}`, { decision });
      }
    } catch (err) {
      logThought('error', 'consult', st.id, `evaluation failed: ${err.message}`, null);
    }
  }
}

// Orphan retire — fires EVERY cycle regardless of cap. A strategy with zero
// entries past ORPHAN_AGE_HOURS has filters that don't match real-world mints;
// retiring frees the slot AND gives the agent unambiguous "filters too strict"
// signal for its next proposal. Returns # of strategies retired this pass.
function retireOrphans() {
  const live = S().liveStrategies.all();
  const now = Date.now();
  const orphans = live
    .map(s => ({ ...s, perf: S().strategyPerf.get(s.id, s.id, s.id, s.id, s.id) }))
    .filter(r =>
      (r.perf?.closed || 0) === 0 &&
      (now - r.created_at) >= ORPHAN_AGE_HOURS * 3600000
    );
  let retired = 0;
  for (const target of orphans) {
    const ageHours = ((now - target.created_at) / 3600000).toFixed(1);
    retireStrategy(target.id, `orphan retire: 0 entries in ${ageHours}h — filters too strict`);
    logThought('retire', 'introspect', target.id,
      `orphan-retired ${target.id}: no entries in ${ageHours}h`, { reason: 'orphan' });
    console.log(`[agent] 🗑️ ORPHAN RETIRE: ${target.id} — 0 entries in ${ageHours}h`);
    retired++;
    // Capture filter stack so next proposal prompt can tell Claude exactly
    // which condition combos produced zero entries.
    try {
      const recipe = JSON.parse(target.recipe_json || '{}');
      const conditions = (recipe.entry?.conditions || []).map(c =>
        `${c.kind === 'feature' ? 'feature.' : ''}${c.name} ${c.op} ${c.value}`
      );
      const ageWindow = `mint_age ${recipe.entry?.min_mint_age_sec || 0}–${recipe.entry?.max_mint_age_sec || '∞'}s`;
      _recentOrphans.unshift({
        id: target.id,
        name: recipe.name || target.id,
        age_hours: Number(ageHours),
        conditions,
        age_window: ageWindow,
        retired_at: now,
      });
      if (_recentOrphans.length > RECENT_ORPHANS_MAX) _recentOrphans.length = RECENT_ORPHANS_MAX;
    } catch { /* ignore parse error */ }
  }
  return retired;
}

// Evolutionary retire — only fires when at strategy cap AND a bleeder exists.
// Picks the worst-PnL strategy (≥RETIRE_WORST_MIN_TRADES closed) and retires
// it to make room for a variant. Survival of the most profitable.
function maybeMakeRoomForVariant() {
  const live = S().liveStrategies.all();
  if (live.length < STRATEGY_CAP) return false;
  const now = Date.now();
  const soakedLive = live.filter(s => (now - s.created_at) >= STRATEGY_SOAK_HOURS * 3600000);
  if (soakedLive.length === 0) {
    logThought('thought', 'introspect', null,
      `at cap (${live.length}/${STRATEGY_CAP}) but all strategies still in ${STRATEGY_SOAK_HOURS}h soak — no room to make`, null);
    return false;
  }
  const ranked = soakedLive.map(s => ({ ...s, perf: S().strategyPerf.get(s.id, s.id, s.id, s.id, s.id) }));
  const measurable = ranked.filter(r => (r.perf?.closed || 0) >= RETIRE_WORST_MIN_TRADES);
  if (measurable.length === 0) {
    logThought('thought', 'introspect', null,
      `at cap (${live.length}/${STRATEGY_CAP}) but no soaked strategy has ≥${RETIRE_WORST_MIN_TRADES} trades yet to evaluate — waiting`, null);
    return false;
  }
  measurable.sort((a, b) => (a.perf?.pnl_sol || 0) - (b.perf?.pnl_sol || 0));
  const worst = measurable[0];
  retireStrategy(worst.id, `evolutionary retire: worst PnL ${(worst.perf.pnl_sol || 0).toFixed(3)} SOL on ${worst.perf.closed} trades — making room`);
  logThought('retire', 'introspect', worst.id,
    `evolutionary-retired ${worst.id}: ${(worst.perf.pnl_sol || 0).toFixed(3)} SOL on ${worst.perf.closed} trades`,
    { reason: 'evolutionary', perf: worst.perf });
  console.log(`[agent] 🗑️ EVOLUTIONARY RETIRE: ${worst.id} — ${(worst.perf.pnl_sol || 0).toFixed(3)} SOL on ${worst.perf.closed} trades`);
  return true;
}

async function cycle() {
  const now = Date.now();
  // Pre-pass 1: always retire orphans (0 entries past ORPHAN_AGE_HOURS).
  // Independent of cap/bleeders — a strategy that never fires is just
  // wasting a slot and feeding zero signal to the agent.
  retireOrphans();
  // Pre-pass 2: at cap AND any bleeders → evolutionary retire to free a slot.
  const _liveBefore = S().liveStrategies.all();
  if (_liveBefore.length >= STRATEGY_CAP) {
    const w = db().prepare('SELECT starting_balance_sol FROM paper_wallet WHERE id=1').get();
    const startBal = w?.starting_balance_sol || 1.0;
    const bleedThreshold = startBal * BLEED_PNL_FRACTION;
    const anyBleeder = _liveBefore.some(s => {
      const perf = S().strategyPerf.get(s.id, s.id, s.id, s.id, s.id);
      return (perf?.closed || 0) >= BLEED_MIN_TRADES && (perf?.pnl_sol || 0) <= bleedThreshold;
    });
    if (anyBleeder) maybeMakeRoomForVariant();
  }
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
  startConcentrationCheck(); // every 6h: flag dominant exit_reason + diagnose
  startMarketRegime();       // noon + midnight: aggressive/normal/cautious posture
  // First introspection 5 min after boot
  setTimeout(() => cycle().catch(err => console.error('[agent] cycle err:', err)), FIRST_CYCLE_DELAY_MS);
  setInterval(() => cycle().catch(err => console.error('[agent] cycle err:', err)), CYCLE_INTERVAL_MS);
  console.log(`[agent] started · cycle=30min · first_run=+${FIRST_CYCLE_DELAY_MS/60000}min · max_consults_per_day=${MAX_CONSULTS_PER_DAY}`);
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
