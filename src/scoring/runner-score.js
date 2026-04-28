import { db } from '../db/index.js';
import { config } from '../config.js';
import { getHolderStats } from './holders.js';
import { onRunnerScore } from '../trading/strategies.js';

const SWEEP_INTERVAL_MS = 8000;
const FIRE_THRESHOLD = 85;
const FIRE_MIN_TAU = 0.75;
const FIRE_MAX_TRADES_TO_5 = 25;
const SCORE_TTL_MS = 25000;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    candidates: d.prepare(`
      SELECT mint_address, created_at, current_market_cap_sol, peak_market_cap_sol,
             v_sol_in_curve, unique_buyer_count, runner_score, runner_scored_at, runner_fired
      FROM mints
      WHERE migrated = 0 AND rugged = 0
        AND created_at BETWEEN ? AND ?
      LIMIT 200
    `),
    tradesAgg: d.prepare(`
      SELECT
        COUNT(*) AS total_trades,
        SUM(CASE WHEN is_buy = 1 THEN 1 ELSE 0 END) AS buy_count,
        SUM(CASE WHEN is_buy = 1 THEN sol_amount ELSE 0 END) AS sol_in,
        SUM(CASE WHEN is_buy = 0 THEN sol_amount ELSE 0 END) AS sol_out,
        COUNT(DISTINCT CASE WHEN is_buy = 1 THEN wallet END) AS unique_buyers,
        SUM(CASE WHEN is_buy = 1 AND timestamp <= ? THEN 1 ELSE 0 END) AS buy_count_60s,
        SUM(CASE WHEN is_buy = 1 AND timestamp <= ? THEN sol_amount ELSE 0 END) AS sol_in_60s,
        COUNT(DISTINCT CASE WHEN is_buy = 1 AND timestamp <= ? THEN wallet END) AS unique_buyers_60s
      FROM trades
      WHERE mint_address = ?
    `),
    tradesTo5SOL: d.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT timestamp, SUM(sol_amount) OVER (ORDER BY timestamp) AS cum_sol
        FROM trades WHERE mint_address = ? AND is_buy = 1
      ) WHERE cum_sol < 5
    `),
    nonBotFraction: d.prepare(`
      SELECT
        COUNT(*) AS total_buys,
        SUM(CASE WHEN COALESCE(w.category, 'NOT_SURE') IN ('HUMAN','SCALPER','NOT_SURE') THEN 1 ELSE 0 END) AS non_bot_buys
      FROM trades t LEFT JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? AND t.is_buy = 1
    `),
    trackedTouched: d.prepare(`
      SELECT 1 FROM trades t JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? AND t.is_buy = 1 AND w.tracked = 1 LIMIT 1
    `),
    updateScore: d.prepare(`
      UPDATE mints SET runner_score = ?, runner_breakdown = ?, runner_scored_at = ?
      WHERE mint_address = ?
    `),
    markFired: d.prepare(`UPDATE mints SET runner_fired = 1 WHERE mint_address = ?`),
  };
  return stmts;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function computeScore(m, now) {
  const s = S();
  const sixtySecMark = m.created_at + 60000;
  const agg = s.tradesAgg.get(sixtySecMark, sixtySecMark, sixtySecMark, m.mint_address);
  if (!agg || (agg.total_trades || 0) < 3) return null;

  const tradesTo5 = s.tradesTo5SOL.get(m.mint_address).n;
  const nb = s.nonBotFraction.get(m.mint_address);
  const tau = nb.total_buys > 0 ? nb.non_bot_buys / nb.total_buys : 0;

  const buys = agg.buy_count || 0;
  const sells = agg.total_trades - buys;
  const solIn = agg.sol_in || 0;
  const solOut = agg.sol_out || 0;
  const bsRatio = solOut > 0 ? (solIn / solOut) : (solIn > 0 ? 99 : 0);
  const buyers60 = agg.unique_buyers_60s || 0;
  const solIn60 = agg.sol_in_60s || 0;

  const stats = getHolderStats(m.mint_address);

  let score = 0;
  const b = {};

  // 40 pts — trade velocity (peer-reviewed primary signal)
  if (tradesTo5 > 0 && tradesTo5 <= 50) {
    b.velocity = Math.round(40 * (50 - tradesTo5) / 50);
  } else {
    b.velocity = 0;
  }
  score += b.velocity;

  // 20 pts — non-bot fraction tau
  if (tau >= 0.85) b.tau = 20;
  else if (tau >= 0.65) b.tau = Math.round(10 + 10 * (tau - 0.65) / 0.20);
  else b.tau = Math.round(10 * tau / 0.65);
  b.tau = clamp(b.tau, 0, 20);
  score += b.tau;

  // 15 pts — buyer count at 60s
  b.buyers = clamp(Math.round(15 * buyers60 / 25), 0, 15);
  score += b.buyers;

  // 10 pts — SOL inflow at 60s
  b.inflow = clamp(Math.round(10 * solIn60 / 5), 0, 10);
  score += b.inflow;

  // 10 pts — holder distribution
  if (stats) {
    let h = 0;
    if (stats.bundlePct < 0.25) h += 4;
    else if (stats.bundlePct < 0.50) h += 2;
    if (stats.creatorPct < 0.08) h += 3;
    else if (stats.creatorPct < 0.15) h += 1;
    if (stats.whalePct < 0.20) h += 3;
    else if (stats.whalePct < 0.40) h += 1;
    b.distribution = h;
    score += h;
  } else {
    b.distribution = 0;
  }

  // 5 pts — buy/sell ratio
  b.bsRatio = clamp(Math.round(5 * Math.min(bsRatio, 5) / 3), 0, 5);
  score += b.bsRatio;

  const safeFix = (v, d = 2) => (v == null || isNaN(v)) ? null : +Number(v).toFixed(d);
  b.tradesTo5 = tradesTo5;
  b.tau = safeFix(tau);
  b.buyers60 = buyers60;
  b.solIn60 = safeFix(solIn60);
  b.bsRatio = safeFix(bsRatio);
  b.bundlePct = stats ? safeFix(stats.bundlePct) : null;
  b.whalePct = stats ? safeFix(stats.whalePct) : null;

  return { score: Math.min(100, score), breakdown: b };
}

function sweep() {
  const s = S();
  const now = Date.now();
  const ageMin = now - 10 * 60 * 1000;
  const ageMax = now - 60 * 1000;
  const candidates = s.candidates.all(ageMin, ageMax);

  let scored = 0, fired = 0;
  for (const m of candidates) {
    if (m.runner_scored_at && (now - m.runner_scored_at) < SCORE_TTL_MS) continue;
    const result = computeScore(m, now);
    if (!result) continue;

    s.updateScore.run(result.score, JSON.stringify(result.breakdown), now, m.mint_address);
    scored++;

    if (result.score >= FIRE_THRESHOLD && !m.runner_fired) {
      if ((result.breakdown.tau || 0) < FIRE_MIN_TAU) continue;
      if ((result.breakdown.tradesTo5 || 999) > FIRE_MAX_TRADES_TO_5) continue;
      const tracked = s.trackedTouched.get(m.mint_address);
      if (tracked) continue;

      s.markFired.run(m.mint_address);
      console.log(`[runner] 🚀 ${m.mint_address.slice(0,8)}… score=${result.score} (vel=${result.breakdown.velocity} τ=${result.breakdown.tau} buyers=${result.breakdown.buyers}) trades_to_5=${result.breakdown.tradesTo5}`);
      onRunnerScore(m.mint_address, result);
      fired++;
    }
  }
  if (scored > 0) console.log(`[runner] sweep: scored ${scored}, fired ${fired}`);
}

export function startRunnerScoreSweep() {
  setInterval(() => {
    try { sweep(); } catch (err) { console.error('[runner] sweep', err.message); }
  }, SWEEP_INTERVAL_MS);
}
