import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { config } from '../config.js';

const LOG_DIR = path.resolve(config.root, 'logs');
const SUMMARY_INTERVAL_MS = 15 * 60 * 1000;

let _sessionStart = null;
let _stmts = null;

function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    wallet: d.prepare('SELECT * FROM paper_wallet WHERE id = 1'),
    closedSince: d.prepare(`
      SELECT COUNT(*) AS n,
        SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN realized_pnl_sol <= 0 THEN 1 ELSE 0 END) AS losses,
        ROUND(SUM(realized_pnl_sol), 4) AS net,
        ROUND(AVG(realized_pnl_pct) * 100, 1) AS avg_pnl_pct
      FROM paper_positions WHERE status='closed' AND exited_at >= ?
    `),
    closedSinceByStrat: d.prepare(`
      SELECT strategy, COUNT(*) AS n,
        SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
        ROUND(SUM(realized_pnl_sol), 4) AS net
      FROM paper_positions WHERE status='closed' AND exited_at >= ?
      GROUP BY strategy ORDER BY net DESC
    `),
    closedSinceByExit: d.prepare(`
      SELECT exit_reason, COUNT(*) AS n,
        ROUND(AVG(realized_pnl_pct) * 100, 1) AS avg_pnl,
        ROUND(SUM(realized_pnl_sol), 4) AS net
      FROM paper_positions WHERE status='closed' AND exited_at >= ?
      GROUP BY exit_reason ORDER BY ABS(SUM(realized_pnl_sol)) DESC
    `),
    openCount: d.prepare(`
      SELECT COUNT(*) AS n,
        ROUND(SUM(entry_sol - sol_realized_so_far), 4) AS locked,
        ROUND(SUM(unrealized_pnl_sol), 4) AS unrealized
      FROM paper_positions WHERE status = 'open'
    `),
    walletCounts: d.prepare(`
      SELECT
        SUM(CASE WHEN tracked = 1 THEN 1 ELSE 0 END) AS tracked,
        SUM(CASE WHEN is_kol = 1 THEN 1 ELSE 0 END) AS kols,
        SUM(CASE WHEN auto_boost_mult > 1.0 THEN 1 ELSE 0 END) AS boosted,
        SUM(CASE WHEN auto_blocked = 1 THEN 1 ELSE 0 END) AS blocked
      FROM wallets
    `),
    runnerLeader: d.prepare(`
      SELECT symbol, runner_score FROM mints
      WHERE runner_score IS NOT NULL AND migrated = 0 AND rugged = 0
      ORDER BY runner_score DESC LIMIT 5
    `),
    rejections: d.prepare(`
      SELECT reason, COUNT(*) AS n FROM gate_rejections
      WHERE first_rejected_at >= ? GROUP BY reason ORDER BY n DESC LIMIT 5
    `),
    bestWorst: d.prepare(`
      SELECT mint_address, strategy, realized_pnl_pct, realized_pnl_sol, exit_reason
      FROM paper_positions WHERE status='closed' AND exited_at >= ?
      ORDER BY realized_pnl_sol DESC LIMIT 3
    `),
    worstTrades: d.prepare(`
      SELECT mint_address, strategy, realized_pnl_pct, realized_pnl_sol, exit_reason
      FROM paper_positions WHERE status='closed' AND exited_at >= ?
      ORDER BY realized_pnl_sol ASC LIMIT 3
    `),
  };
  return _stmts;
}

function appendLog(line) {
  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `session-summary-${today}.log`), line + '\n');
}

function writeSummary() {
  try {
    const s = S();
    const now = Date.now();
    const wallet = s.wallet.get();
    if (!_sessionStart) _sessionStart = wallet.started_at || now;

    const since = now - SUMMARY_INTERVAL_MS;
    const totalSince = s.closedSince.get(_sessionStart);
    const interval = s.closedSince.get(since);
    const byStrat = s.closedSinceByStrat.all(since);
    const byExit = s.closedSinceByExit.all(since);
    const openInfo = s.openCount.get();
    const wc = s.walletCounts.get();
    const runnerTop = s.runnerLeader.all();
    const rej = s.rejections.all(since);
    const best = s.bestWorst.all(since);
    const worst = s.worstTrades.all(since);

    const ts = new Date(now).toISOString();
    const lines = [];
    lines.push('');
    lines.push('═'.repeat(80));
    lines.push(`📊 SESSION SUMMARY · ${ts}`);
    lines.push('─'.repeat(80));

    const sessionMin = ((now - _sessionStart) / 60000).toFixed(1);
    lines.push(`SESSION: ${sessionMin}m running · started ${new Date(_sessionStart).toISOString()}`);
    lines.push('');

    lines.push(`💼 WALLET`);
    lines.push(`  Start: ${wallet.starting_balance_sol} SOL`);
    lines.push(`  Realized this session: ${(totalSince.net || 0) >= 0 ? '+' : ''}${totalSince.net || 0} SOL (${totalSince.n} trades, ${totalSince.wins} wins)`);
    lines.push(`  Open positions: ${openInfo.n} · locked ${openInfo.locked} SOL · unrealized ${openInfo.unrealized || 0}`);
    lines.push('');

    lines.push(`📈 LAST 15 MIN — ${interval.n} closes · ${interval.wins}W/${interval.losses}L · ${(interval.net || 0) >= 0 ? '+' : ''}${interval.net || 0} SOL`);
    if (byStrat.length) {
      lines.push(`  By strategy:`);
      byStrat.forEach(r => lines.push(`    ${r.strategy.padEnd(22)} ${String(r.n).padStart(3)} trades · ${r.wins}W · ${(r.net || 0) >= 0 ? '+' : ''}${r.net} SOL`));
    }
    if (byExit.length) {
      lines.push(`  By exit reason:`);
      byExit.forEach(r => lines.push(`    ${r.exit_reason.padEnd(15)} ${String(r.n).padStart(3)}× · avg ${r.avg_pnl >= 0 ? '+' : ''}${r.avg_pnl}% · net ${(r.net || 0) >= 0 ? '+' : ''}${r.net}`));
    }
    lines.push('');

    if (best.length) {
      lines.push(`🏆 TOP 3 WINS (last 15m):`);
      best.forEach(t => lines.push(`    ${t.mint_address.slice(0,8)}… ${t.strategy.slice(0,16).padEnd(16)} ${(t.realized_pnl_pct * 100).toFixed(1).padStart(7)}% · ${t.realized_pnl_sol.toFixed(4).padStart(8)} SOL · ${t.exit_reason}`));
    }
    if (worst.length) {
      lines.push(`💀 WORST 3 LOSSES (last 15m):`);
      worst.forEach(t => lines.push(`    ${t.mint_address.slice(0,8)}… ${t.strategy.slice(0,16).padEnd(16)} ${(t.realized_pnl_pct * 100).toFixed(1).padStart(7)}% · ${t.realized_pnl_sol.toFixed(4).padStart(8)} SOL · ${t.exit_reason}`));
    }
    lines.push('');

    lines.push(`🎯 WALLETS: ${wc.tracked} tracked · ${wc.kols} KOLs · ${wc.boosted} boosted · ${wc.blocked} blocked`);
    if (runnerTop.length) {
      lines.push(`🚀 RUNNER LEADERBOARD: ${runnerTop.map(r => `${r.symbol || '?'}:${r.runner_score}`).join(' · ')}`);
    }
    if (rej.length) {
      lines.push(`🚪 REJECTIONS: ${rej.map(r => `${r.reason}×${r.n}`).join(' · ')}`);
    }
    lines.push('═'.repeat(80));

    const text = lines.join('\n');
    appendLog(text);
    console.log(text);
  } catch (err) {
    console.error('[session-summary]', err.message);
  }
}

export function startSessionLogger() {
  setTimeout(() => {
    try { writeSummary(); } catch {}
  }, 60 * 1000);
  setInterval(writeSummary, SUMMARY_INTERVAL_MS);
}
