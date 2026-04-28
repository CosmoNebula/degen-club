import { db } from '../db/index.js';
import { config } from '../config.js';

const BLOCK_MIN_TRADES = 5;
const BLOCK_MAX_WR = 0.45;
const BLOCK_MAX_NET = -0.20;
const BOOST_MIN_TRADES = 5;
const BOOST_MIN_WR = 0.80;
const BOOST_MULT = 1.25;
const BOOST_MIN_NET = 0.20;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function smartTradeStrategies() {
  const out = [];
  for (const [name, cfg] of Object.entries(config.strategies || {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.trigger === 'smart_trade') out.push(name);
  }
  return out;
}

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  const strats = smartTradeStrategies();
  const inList = strats.length ? strats.map(s => `'${s.replace(/'/g, "''")}'`).join(',') : "'__none__'";
  stmts = {
    walletStats: d.prepare(`
      SELECT
        json_extract(entry_signal, '$.wallet') AS wallet,
        COUNT(*) AS n,
        SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(realized_pnl_sol) AS net_sol
      FROM paper_positions
      WHERE strategy IN (${inList}) AND status = 'closed'
      GROUP BY wallet HAVING wallet IS NOT NULL AND n >= ?
    `),
    setGrade: d.prepare(`UPDATE wallets SET
      auto_blocked = ?, auto_boost_mult = ?,
      follow_trades = ?, follow_wr = ?, follow_net_sol = ?
      WHERE address = ?`),
    clearGrades: d.prepare(`UPDATE wallets SET auto_blocked = 0, auto_boost_mult = 1.0,
      follow_trades = 0, follow_wr = 0, follow_net_sol = 0`),
  };
  return stmts;
}

export function gradeWallets() {
  const s = S();
  let blocked = 0, boosted = 0;
  s.clearGrades.run();
  const rows = s.walletStats.all(Math.min(BLOCK_MIN_TRADES, BOOST_MIN_TRADES));
  for (const r of rows) {
    const wr = r.n > 0 ? r.wins / r.n : 0;
    const netSol = r.net_sol || 0;
    let auto_blocked = 0;
    let auto_boost_mult = 1.0;

    if (r.n >= BLOCK_MIN_TRADES && wr < BLOCK_MAX_WR && netSol < BLOCK_MAX_NET) {
      auto_blocked = 1;
      blocked++;
    } else if (r.n >= BOOST_MIN_TRADES && wr >= BOOST_MIN_WR && netSol >= BOOST_MIN_NET) {
      auto_boost_mult = BOOST_MULT;
      boosted++;
    }

    s.setGrade.run(auto_blocked, auto_boost_mult, r.n, +wr.toFixed(3), +netSol.toFixed(4), r.wallet);
  }
  console.log(`[grader] swept ${rows.length} wallets · ${blocked} blocked · ${boosted} boosted`);
  return { graded: rows.length, blocked, boosted };
}

export function startWalletGrader() {
  setTimeout(() => {
    try { gradeWallets(); } catch (err) { console.error('[grader] initial', err.message); }
  }, 30 * 1000);
  setInterval(() => {
    try { gradeWallets(); } catch (err) { console.error('[grader]', err.message); }
  }, SWEEP_INTERVAL_MS);
}
