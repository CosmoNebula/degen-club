// Session report — read the recorded network log + DB activity since the
// session-start marker and emit a deep-dive summary.
//
// Usage: node bin/session-report.js
//   Reads /opt/degen-club/logs/sessions/current-session.txt for start time.

import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db/index.js';

const SESSION_DIR = '/opt/degen-club/logs/sessions';
const MARKER = path.join(SESSION_DIR, 'current-session.txt');

function readSessionStart() {
  const raw = fs.readFileSync(MARKER, 'utf8').trim();
  return new Date(raw).getTime();
}

function fmtSol(n) { return Number(n || 0).toFixed(4) + ' SOL'; }
function fmtPct(n) { return ((n || 0) * 100).toFixed(1) + '%'; }
function fmtMs(n) { return n < 1000 ? `${n}ms` : `${(n/1000).toFixed(1)}s`; }
function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function analyzeNetworkLog(startTs) {
  // Find the most recent network-*.log in SESSION_DIR.
  const files = fs.readdirSync(SESSION_DIR).filter(f => f.startsWith('network-')).sort();
  if (files.length === 0) return null;
  const latest = path.join(SESSION_DIR, files[files.length - 1]);
  const content = fs.readFileSync(latest, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  const stats = {
    file: latest,
    total_lines: lines.length,
    wss_drops: { shadow: 0, pool: 0, pumpportal: 0, onchain_amm: 0, onchain_price: 0, onchain_trades: 0 },
    slow_sql: [],          // {ms, sql, ts}
    loop_watchdog: [],     // {lag_ms, ts}
    abort_errors: 0,
    cashback_timeouts: 0,
  };

  for (const line of lines) {
    if (/shadow-wss\] disc/.test(line)) stats.wss_drops.shadow++;
    if (/pool-ws\] disc/.test(line)) stats.wss_drops.pool++;
    if (/pumpportal\] disc/.test(line)) stats.wss_drops.pumpportal++;
    if (/onchain-amm\] WSS disc/.test(line)) stats.wss_drops.onchain_amm++;
    if (/onchain-price\] disc/.test(line)) stats.wss_drops.onchain_price++;
    if (/onchain-trades\] disc/.test(line)) stats.wss_drops.onchain_trades++;
    if (/AbortError/.test(line)) stats.abort_errors++;
    if (/cashback The op/.test(line)) stats.cashback_timeouts++;

    const sqlMatch = line.match(/\[slow-sql\] (\d+)ms .* :: (.{0,80})/);
    if (sqlMatch) {
      stats.slow_sql.push({ ms: +sqlMatch[1], sql: sqlMatch[2].trim() });
    }
    const watchdogMatch = line.match(/loop-watchdog\] recovered — lag back to (\d+)ms/);
    if (watchdogMatch) {
      stats.loop_watchdog.push({ lag_ms: +watchdogMatch[1] });
    }
  }

  // Slow SQL summary
  stats.slow_sql.sort((a, b) => b.ms - a.ms);
  stats.slow_sql_total_ms = stats.slow_sql.reduce((sum, r) => sum + r.ms, 0);
  stats.slow_sql_count_1s = stats.slow_sql.filter(r => r.ms >= 1000).length;
  stats.slow_sql_count_5s = stats.slow_sql.filter(r => r.ms >= 5000).length;
  stats.slow_sql_top10 = stats.slow_sql.slice(0, 10);

  // Loop watchdog summary
  stats.loop_watchdog.sort((a, b) => b.lag_ms - a.lag_ms);
  stats.watchdog_count = stats.loop_watchdog.length;
  stats.watchdog_max_lag = stats.loop_watchdog[0]?.lag_ms || 0;

  return stats;
}

function analyzeTrading(startTs) {
  const d = db();

  const positions = d.prepare(`
    SELECT id, mint_address, strategy, status, entered_at, exited_at,
           entry_price, entry_mcap_sol, exit_price, exit_mcap_sol,
           realized_pnl_sol, realized_pnl_pct, exit_reason, highest_pct, entry_sol
    FROM paper_positions
    WHERE entered_at >= ?
    ORDER BY entered_at ASC
  `).all(startTs);

  const closed = positions.filter(p => p.status === 'closed');
  const open = positions.filter(p => p.status === 'open');
  const wins = closed.filter(p => (p.realized_pnl_sol || 0) > 0);
  const losses = closed.filter(p => (p.realized_pnl_sol || 0) < 0);

  // Aggregate by strategy
  const byStrategy = {};
  for (const p of closed) {
    const k = p.strategy || 'unknown';
    if (!byStrategy[k]) byStrategy[k] = { closed: 0, wins: 0, pnl_sol: 0, total_invested: 0 };
    byStrategy[k].closed++;
    if ((p.realized_pnl_sol || 0) > 0) byStrategy[k].wins++;
    byStrategy[k].pnl_sol += p.realized_pnl_sol || 0;
    byStrategy[k].total_invested += p.entry_sol || 0;
  }

  // Exit reason breakdown
  const exitReasons = {};
  for (const p of closed) {
    const r = p.exit_reason || 'unknown';
    if (!exitReasons[r]) exitReasons[r] = { count: 0, pnl_sol: 0 };
    exitReasons[r].count++;
    exitReasons[r].pnl_sol += p.realized_pnl_sol || 0;
  }

  return {
    opened: positions.length,
    closed: closed.length,
    open: open.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: closed.length > 0 ? wins.length / closed.length : 0,
    pnl_sol: closed.reduce((s, p) => s + (p.realized_pnl_sol || 0), 0),
    avg_pct: closed.length > 0
      ? closed.reduce((s, p) => s + (p.highest_pct || 0), 0) / closed.length
      : 0,
    by_strategy: byStrategy,
    exit_reasons: exitReasons,
    best_trade: [...closed].sort((a, b) => (b.realized_pnl_sol || 0) - (a.realized_pnl_sol || 0))[0],
    worst_trade: [...closed].sort((a, b) => (a.realized_pnl_sol || 0) - (b.realized_pnl_sol || 0))[0],
  };
}

function analyzePriceAccuracy(startTs) {
  const d = db();
  // For each closed position in the session, compare recorded peak to the
  // actual max trade price during the holding window. >20% inflation flags
  // the position as suspect (we're recording a phantom peak).
  const rows = d.prepare(`
    SELECT id, mint_address, strategy, entered_at, exited_at,
           entry_price, exit_price, highest_pct, realized_pnl_sol
    FROM paper_positions
    WHERE status = 'closed' AND entered_at >= ?
  `).all(startTs);

  const realPeakStmt = d.prepare(`
    SELECT MAX(price_sol) AS real_peak, MIN(price_sol) AS real_low, COUNT(*) AS n
    FROM trades
    WHERE mint_address = ?
      AND timestamp BETWEEN ? AND ?
      AND price_sol > 0
      AND COALESCE(is_junk, 0) = 0
  `);

  const flagged = [];
  let checked = 0;
  for (const p of rows) {
    if (!p.entered_at || !p.exited_at) continue;
    const real = realPeakStmt.get(p.mint_address, p.entered_at, p.exited_at);
    if (!real || !real.real_peak || !p.entry_price) continue;
    checked++;
    const realPeakPct = ((real.real_peak / p.entry_price) - 1) * 100;
    const recordedPeakPct = p.highest_pct || 0;
    const diff = recordedPeakPct - realPeakPct;
    if (Math.abs(diff) > 20) {
      flagged.push({
        id: p.id,
        mint: p.mint_address.slice(0, 8) + '…',
        strategy: p.strategy,
        recorded_peak_pct: recordedPeakPct.toFixed(1),
        real_peak_pct: realPeakPct.toFixed(1),
        delta: diff.toFixed(1),
        flag: diff > 0 ? 'INFLATED' : 'UNDER-RECORDED',
        n_trades: real.n,
      });
    }
  }

  return { checked, flagged };
}

function main() {
  const startTs = readSessionStart();
  const now = Date.now();
  const ageMs = now - startTs;

  console.log(`\n=== SESSION REPORT ===`);
  console.log(`Session start: ${new Date(startTs).toISOString()}`);
  console.log(`Duration:      ${fmtAge(ageMs)}`);

  console.log(`\n--- NETWORK / CONNECTION HEALTH ---`);
  const net = analyzeNetworkLog(startTs);
  if (!net) {
    console.log('No session log file found.');
  } else {
    console.log(`Log file:        ${net.file}`);
    console.log(`Total events:    ${net.total_lines}`);
    console.log(`WSS drops:`);
    for (const [k, v] of Object.entries(net.wss_drops)) {
      console.log(`  ${k.padEnd(20)} ${v}`);
    }
    console.log(`Cashback timeouts: ${net.cashback_timeouts}`);
    console.log(`Abort errors:      ${net.abort_errors}`);
    console.log(`Loop watchdog events: ${net.watchdog_count} (max lag: ${fmtMs(net.watchdog_max_lag)})`);
    console.log(`\nSlow SQL summary:`);
    console.log(`  Total events:    ${net.slow_sql.length}`);
    console.log(`  ≥1s:             ${net.slow_sql_count_1s}`);
    console.log(`  ≥5s:             ${net.slow_sql_count_5s}`);
    console.log(`  Cumulative time: ${fmtMs(net.slow_sql_total_ms)}`);
    if (net.slow_sql_top10.length > 0) {
      console.log(`\n  Top 10 slowest queries:`);
      for (const r of net.slow_sql_top10) {
        console.log(`    ${fmtMs(r.ms).padStart(8)} :: ${r.sql.slice(0, 100)}`);
      }
    }
  }

  console.log(`\n--- TRADING ACTIVITY ---`);
  const trade = analyzeTrading(startTs);
  console.log(`Opened: ${trade.opened} · Closed: ${trade.closed} · Still open: ${trade.open}`);
  console.log(`Wins:   ${trade.wins}/${trade.closed} (${fmtPct(trade.win_rate)})`);
  console.log(`Realized PnL: ${fmtSol(trade.pnl_sol)}`);
  console.log(`Avg highest_pct across closes: ${trade.avg_pct.toFixed(1)}%`);

  if (Object.keys(trade.by_strategy).length > 0) {
    console.log(`\nBy strategy:`);
    for (const [k, v] of Object.entries(trade.by_strategy)) {
      const wr = v.closed > 0 ? v.wins / v.closed : 0;
      console.log(`  ${k.padEnd(50)} ${String(v.closed).padStart(4)} closed · ${fmtPct(wr).padStart(6)} WR · ${fmtSol(v.pnl_sol).padStart(14)}`);
    }
  }

  if (Object.keys(trade.exit_reasons).length > 0) {
    console.log(`\nExit reasons:`);
    const sorted = Object.entries(trade.exit_reasons).sort((a, b) => b[1].count - a[1].count);
    for (const [k, v] of sorted) {
      console.log(`  ${k.padEnd(25)} ${String(v.count).padStart(4)}x · ${fmtSol(v.pnl_sol).padStart(14)}`);
    }
  }

  if (trade.best_trade) {
    const bt = trade.best_trade;
    console.log(`\nBest trade:  ${bt.mint_address.slice(0,8)}… · ${bt.strategy} · ${fmtSol(bt.realized_pnl_sol)} · peak +${(bt.highest_pct || 0).toFixed(1)}% · ${bt.exit_reason}`);
  }
  if (trade.worst_trade) {
    const wt = trade.worst_trade;
    console.log(`Worst trade: ${wt.mint_address.slice(0,8)}… · ${wt.strategy} · ${fmtSol(wt.realized_pnl_sol)} · peak +${(wt.highest_pct || 0).toFixed(1)}% · ${wt.exit_reason}`);
  }

  console.log(`\n--- PRICE ACCURACY SPOT-CHECK ---`);
  const price = analyzePriceAccuracy(startTs);
  console.log(`Closed positions checked: ${price.checked}`);
  console.log(`Flagged (>20% delta vs real trade peak): ${price.flagged.length}`);
  if (price.flagged.length > 0) {
    console.log(`\n  Flagged positions:`);
    for (const f of price.flagged.slice(0, 20)) {
      console.log(`    #${f.id} ${f.mint} ${f.strategy.padEnd(40)} ${f.flag} · recorded=${f.recorded_peak_pct}% real=${f.real_peak_pct}% (Δ${f.delta}%)`);
    }
    if (price.flagged.length > 20) console.log(`    ...${price.flagged.length - 20} more`);
  } else {
    console.log(`  All recorded peaks within 20% of real trade-window max. ✓`);
  }

  console.log();
}

main();
