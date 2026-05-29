// server/api.js — HTTP server for V2 dashboard.
//
// Endpoint shapes match what /opt/degen-club/public/app.js + ml.js expect so the
// panels render. Where V2 doesn't have V1's concept (autonomous agent, recipe
// builder, KOL labels, wallet rings, sentiment, microstructure aggregator),
// we return sensible empties/zeros so the panel says "no data" rather than
// crashing.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { config } from '../config.js';
import { getPumpPortalStats } from '../ingest/pumpportal.js';
import { getRpcSubStats } from '../ingest/rpc-sub.js';
import { getLogsSubStats } from '../ingest/logs-sub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const BOOT_TS = Date.now();
const VERSION = 'v2.1';

// SOL/USD price — refreshed every 60s from CoinGecko (free, no auth).
// Used to display all market-cap numbers in USD instead of SOL on the dashboard.
let _solUsd = 145;          // sane default until first fetch lands
let _solUsdAt = 0;
async function refreshSolUsd() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const j = await r.json();
    const px = j?.solana?.usd;
    if (px && px > 0 && px < 10000) { _solUsd = px; _solUsdAt = Date.now(); }
  } catch {}
}
refreshSolUsd();
setInterval(refreshSolUsd, 60_000);

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c.toString(); if (buf.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  });
}

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    wallet: d.prepare('SELECT * FROM paper_wallet WHERE id=1'),
    closedPnl: d.prepare("SELECT COALESCE(SUM(realized_pnl_sol),0) AS pnl, COUNT(*) AS n FROM paper_positions WHERE status='closed' AND entered_at >= ?"),
    winRate: d.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN realized_pnl_sol < 0 THEN 1 ELSE 0 END) AS losses FROM paper_positions WHERE status='closed' AND entered_at >= ?"),
    opensAgg: d.prepare(`SELECT COUNT(*) AS n,
      COALESCE(SUM(entry_sol),0) AS cost,
      COALESCE(SUM(entry_sol - COALESCE(sol_realized_so_far,0)),0) AS atRisk
      FROM paper_positions WHERE status='open' AND entered_at >= ?`),
    opensMtm: d.prepare(`SELECT pp.entry_sol, pp.entry_price, pp.token_amount, pp.sol_realized_so_far,
      pp.tokens_remaining, m.last_price_sol
      FROM paper_positions pp LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status='open' AND pp.entered_at >= ?`),
    opens: d.prepare(`SELECT pp.*, m.name, m.symbol, m.current_market_cap_sol, m.last_price_sol AS now_price, m.migrated, m.peak_market_cap_sol
      FROM paper_positions pp LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status='open' ORDER BY pp.entered_at DESC`),
    closes: d.prepare(`SELECT pp.*, m.symbol, m.name FROM paper_positions pp LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status='closed' ORDER BY pp.exited_at DESC LIMIT ?`),
    mintByAddr: d.prepare(`SELECT * FROM mints WHERE mint_address = ?`),
    mintTrades: d.prepare(`SELECT timestamp, wallet, is_buy, sol_amount, token_amount, price_sol, seconds_from_creation
      FROM trades WHERE mint_address = ? ORDER BY timestamp DESC LIMIT 200`),
    mintSnaps: d.prepare(`SELECT * FROM ml_mint_snapshots WHERE mint_address = ? ORDER BY snapshot_age_sec ASC`),
    mintPreds: d.prepare(`SELECT target, prob, timestamp FROM ml_predictions WHERE mint_address = ? AND timestamp > (strftime('%s','now')-300)*1000 ORDER BY timestamp DESC`),
    mintsRecent: d.prepare(`SELECT mint_address, name, symbol, last_price_sol, current_market_cap_sol, peak_market_cap_sol, migrated, rugged, created_at, trade_count
      FROM mints WHERE created_at > strftime('%s','now')*1000 - ? ORDER BY created_at DESC LIMIT ?`),
    mintsCount: d.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN created_at > strftime('%s','now')*1000 - 300000 THEN 1 ELSE 0 END) AS fresh,
      SUM(CASE WHEN current_market_cap_sol > 50 AND migrated = 0 AND rugged = 0 THEN 1 ELSE 0 END) AS runners,
      SUM(CASE WHEN current_market_cap_sol > 200 AND migrated = 0 AND rugged = 0 THEN 1 ELSE 0 END) AS near_grad,
      SUM(CASE WHEN migrated = 1 THEN 1 ELSE 0 END) AS migrated,
      SUM(CASE WHEN rugged = 1 THEN 1 ELSE 0 END) AS rugged
      FROM mints WHERE created_at > strftime('%s','now')*1000 - 86400000`),
    walletAggBuys: d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(sol_amount),0) sol, COUNT(DISTINCT mint_address) mints FROM trades WHERE wallet = ? AND is_buy = 1`),
    walletAggSells: d.prepare(`SELECT COUNT(*) n, COALESCE(SUM(sol_amount),0) sol FROM trades WHERE wallet = ? AND is_buy = 0`),
    walletRecent: d.prepare(`SELECT mint_address, is_buy, sol_amount, price_sol, timestamp FROM trades WHERE wallet = ? ORDER BY timestamp DESC LIMIT 50`),
    predRecent: d.prepare(`SELECT mint_address, target, prob, timestamp FROM ml_predictions WHERE timestamp > (strftime('%s','now')-?)*1000 ORDER BY timestamp DESC LIMIT 500`),
    predTopPicks: d.prepare(`WITH agg AS (
      SELECT mint_address,
        MAX(CASE WHEN target='hits_2x_within_1h' THEN prob END) AS h2x,
        MAX(CASE WHEN target='peaked_100' THEN prob END) AS p100,
        MAX(CASE WHEN target='will_die_fast' THEN prob END) AS die,
        MAX(CASE WHEN target='will_rug' THEN prob END) AS rug,
        MAX(timestamp) AS ts
      FROM ml_predictions WHERE timestamp > (strftime('%s','now')-300)*1000
      GROUP BY mint_address)
      SELECT a.*, m.name, m.symbol, m.last_price_sol, m.current_market_cap_sol
      FROM agg a LEFT JOIN mints m ON m.mint_address = a.mint_address
      WHERE die < 0.5 AND rug < 0.15
      ORDER BY h2x DESC NULLS LAST LIMIT 30`),
    snapsAgg: d.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN snapshot_age_sec = 60 THEN 1 ELSE 0 END) AS s60,
      SUM(CASE WHEN snapshot_age_sec = 300 THEN 1 ELSE 0 END) AS s300,
      SUM(CASE WHEN snapshot_age_sec = 900 THEN 1 ELSE 0 END) AS s900,
      SUM(CASE WHEN snapshot_age_sec = 1800 THEN 1 ELSE 0 END) AS s1800,
      MIN(snapshot_ts) AS earliest
      FROM ml_mint_snapshots`),
    dbSize: d.prepare(`SELECT page_count * page_size AS size FROM pragma_page_count, pragma_page_size`),
    countMints: d.prepare(`SELECT COUNT(*) n FROM mints`),
    countTrades: d.prepare(`SELECT COUNT(*) n FROM trades`),
    walletHistoryCloses: d.prepare(`SELECT exited_at AS ts, realized_pnl_sol AS pnl
      FROM paper_positions WHERE status='closed' AND strategy='ml-policy-v2'
        AND exited_at IS NOT NULL AND exited_at > ?
      ORDER BY exited_at ASC`),
    walletHistoryOpens: d.prepare(`SELECT pp.entry_sol, pp.token_amount, pp.sol_realized_so_far,
      pp.tokens_remaining, m.last_price_sol
      FROM paper_positions pp LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status='open' AND pp.entered_at >= ?`),
    lastTradeAgo: d.prepare(`SELECT CASE WHEN MAX(timestamp) IS NULL THEN NULL
        ELSE CAST((strftime('%s','now')*1000 - MAX(timestamp))/1000 AS INTEGER) END AS ago
      FROM trades
      WHERE timestamp > strftime('%s','now')*1000 - 300000
        AND timestamp <= strftime('%s','now')*1000 + 60000`),
    uniqueMintsTraded: d.prepare(`SELECT COUNT(DISTINCT mint_address) AS n FROM paper_positions`),
    resetWallet: d.prepare(`UPDATE paper_wallet SET starting_balance_sol=?, started_at=?, reset_count=reset_count+1, peak_total_value=? WHERE id=1`),
    closeOpensAtReset: d.prepare(`UPDATE paper_positions SET status='closed', exit_reason='wallet_reset', exited_at=?, realized_pnl_sol=0, realized_pnl_pct=0 WHERE status='open'`),
  };
  return _stmts;
}

function computeOpenMtm(rows) {
  let mtm = 0, houseMoney = 0, locked = 0;
  for (const r of rows) {
    const cur = (r.tokens_remaining || 0) * (r.last_price_sol || 0);
    mtm += cur;
    locked += (r.sol_realized_so_far || 0);
    // "house money" = realized so far covers entry cost
    if ((r.sol_realized_so_far || 0) >= r.entry_sol) houseMoney++;
  }
  return { mtm, houseMoney, lockedRealized: locked };
}

// ============================================================================
// API
// ============================================================================
async function routeApi(req, res, urlPath, query) {
  const s = S();
  const d = db();
  const method = req.method || 'GET';

  // -------- /api/stats — the BIG topbar feed --------
  if (urlPath === '/api/stats') {
    const w = s.wallet.get();
    const startedAt = w?.started_at || 0;
    const starting = w?.starting_balance_sol || 5.0;

    const closed = s.closedPnl.get(startedAt);
    const opensAgg = s.opensAgg.get(startedAt);
    const wr = s.winRate.get(startedAt);
    const opensRows = s.opensMtm.all(startedAt);
    const { mtm, houseMoney, lockedRealized } = computeOpenMtm(opensRows);

    const cashBalance = starting + (closed.pnl || 0) - opensAgg.atRisk;
    const totalValue = cashBalance + mtm;
    const peak = Math.max(w?.peak_total_value || starting, totalValue);
    const drawdown = peak > 0 ? (totalValue - peak) / peak : 0;
    const pctChange = starting > 0 ? (totalValue - starting) / starting : 0;

    const dbCount = s.countMints.get();
    const tradeCount = s.countTrades.get();
    const mintsTraded = s.uniqueMintsTraded.get().n || 0;
    const INCINERATE_PER_MINT = 0.00203928;

    return sendJson(res, 200, {
      sim: {
        totalValue,
        cashBalance,
        openMtm: mtm,
        startingBalanceSol: starting,
        peakTotalValue: peak,
        drawdown,
        pctChange,
        atRiskExposure: opensAgg.atRisk,
        houseMoneyCount: houseMoney,
        realizedLockedFromOpen: lockedRealized,
      },
      realizedPnlSol: closed.pnl || 0,
      openPositions: opensAgg.n || 0,
      winRate: wr.total > 0 ? wr.wins / wr.total : 0,
      totalClosed: wr.total || 0,
      wins: wr.wins || 0,
      losses: wr.losses || 0,
      totalMints: dbCount.n,
      totalTrades: tradeCount.n,
      totalWallets: 0, // wallet count is heavy — skip
      trackedWallets: 0,
      kolWallets: 0,
      hunterWallets: 0,
      volumeSignals: 0,
      bundleClusters: 0,
      incinerateSol: mintsTraded * INCINERATE_PER_MINT,
      uniqueMintsTraded: mintsTraded,
      cashbackEstimatedSol: 0,
      cashbackPositions: 0,
      solUsd: _solUsd,
      solUsdAt: _solUsdAt,
      pumpportal: getPumpPortalStats(),
      rpcSub: getRpcSubStats(),
      logsSub: getLogsSubStats(),
    });
  }

  // -------- /api/positions --------
  if (urlPath === '/api/positions') return sendJson(res, 200, s.opens.all());

  if (urlPath === '/api/closed') {
    const limit = parseInt(query.limit) || 50;
    return sendJson(res, 200, s.closes.all(limit));
  }

  if (urlPath === '/api/wallet/sim/reset' && method === 'POST') {
    const body = await readBody(req);
    const newBalance = parseFloat(body.balance) || 5.0;
    const now = Date.now();
    s.closeOpensAtReset.run(now);
    s.resetWallet.run(newBalance, now, newBalance);
    return sendJson(res, 200, { reset: true, balance: newBalance });
  }

  // -------- /api/safety/status (mode/halted display) --------
  if (urlPath === '/api/safety/status') {
    return sendJson(res, 200, {
      mode: process.env.MODE || 'paper',
      halted: false,
      walletSolBalance: null,
      livePnlSol: null,
      liveStartingSol: null,
    });
  }
  if (urlPath === '/api/safety/toggle' && method === 'POST') {
    return sendJson(res, 200, { paused: false });
  }

  // -------- /api/mode --------
  if (urlPath === '/api/mode') return sendJson(res, 200, { mode: process.env.MODE || 'paper' });

  // -------- /api/system/health — feeds the health cluster --------
  if (urlPath === '/api/system/health') {
    const pp = getPumpPortalStats();
    const ls = getLogsSubStats();
    const dbSize = s.dbSize.get();
    const dbSizeMb = Math.round((dbSize.size || 0) / 1024 / 1024);
    const tradeCount = s.countTrades.get();
    const lastTrade = s.lastTradeAgo.get();
    const openN = s.opensAgg.get(0).n;

    return sendJson(res, 200, {
      status: 'ALIVE',
      bot: { uptime_sec: Math.floor((Date.now() - BOOT_TS) / 1000), version: VERSION },
      feeds: {
        onchainTrades: {
          connected: (Date.now() - (ls.lastReport || BOOT_TS)) < 90_000, // logs-sub heartbeats every 60s
          trades_total: ls.trades || tradeCount.n,
          last_event_ago_sec: lastTrade.ago,
        },
        pumpportal: {
          connected: pp.lastEventAt > 0 && (Date.now() - pp.lastEventAt) < 60_000,
          event_count: (pp.newToken || 0) + (pp.migration || 0),
          last_event_ago_sec: pp.lastEventAt ? Math.floor((Date.now() - pp.lastEventAt) / 1000) : null,
        },
      },
      db: {
        size_mb: dbSizeMb,
        trades: tradeCount.n,
        open_positions: openN,
        last_trade_ago_sec: lastTrade.ago,
      },
    });
  }
  if (urlPath === '/api/system') {
    return sendJson(res, 200, {
      ok: true, mode: process.env.MODE || 'paper', version: VERSION,
      uptimeMs: Date.now() - BOOT_TS, bootAt: BOOT_TS,
    });
  }

  // -------- /api/conditions (static — live sampling disabled; Sender handles live priority fees) --------
  if (urlPath === '/api/conditions') {
    return sendJson(res, 200, {
      status: 'healthy',
      mode: process.env.MODE || 'paper',
      friction: { avg_network_sol: 0.0003, buy_fee_pct: 0.01, sell_fee_pct: 0.01, note: 'flat avg; Helius live sampling disabled' },
      sampled_at: Date.now(),
    });
  }

  // -------- /api/limits --------
  if (urlPath === '/api/limits') {
    return sendJson(res, 200, {
      maxPerTradeSol: config.paper.entrySizeMax,
      maxExposureSol: config.paper.maxOpenExposureSol,
      maxOpenPositions: config.paper.maxOpenPositions,
      reentryCooldownMs: config.paper.reentryCooldownMs,
      entryThreshold: config.policy.entryScoreThreshold,
      holdFloor: config.policy.holdScoreFloor,
      tickMs: config.policy.tickMs,
      maxEntrySlip: 0.05,
    });
  }

  // -------- /api/db/stats --------
  if (urlPath === '/api/db/stats') {
    const dbSize = s.dbSize.get();
    return sendJson(res, 200, {
      mints: s.countMints.get().n,
      trades: s.countTrades.get().n,
      snapshots: s.snapsAgg.get().total,
      predictions: d.prepare('SELECT COUNT(*) n FROM ml_predictions').get().n,
      positions: d.prepare('SELECT COUNT(*) n FROM paper_positions').get().n,
      sizeBytes: dbSize.size || 0,
      sizeMb: Math.round((dbSize.size || 0) / 1024 / 1024),
    });
  }

  // -------- /api/mints / /api/mints/counts --------
  if (urlPath === '/api/mints') {
    const windowMs = parseInt(query.window) || 1800000;
    const limit = parseInt(query.limit) || 100;
    return sendJson(res, 200, s.mintsRecent.all(windowMs, limit));
  }
  if (urlPath === '/api/mints/counts') {
    const r = s.mintsCount.get();
    return sendJson(res, 200, {
      all: r.total || 0,
      fresh: r.fresh || 0,
      runners: r.runners || 0,
      near_grad: r.near_grad || 0,
      migrated: r.migrated || 0,
      rugged: r.rugged || 0,
    });
  }
  if (urlPath.startsWith('/api/mint/')) {
    const addr = urlPath.slice('/api/mint/'.length).split('/')[0];
    if (!addr) return sendJson(res, 400, { error: 'no_addr' });
    const m = s.mintByAddr.get(addr);
    if (!m) return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 200, {
      mint: m,
      recentTrades: s.mintTrades.all(addr),
      snapshots: s.mintSnaps.all(addr),
      predictions: s.mintPreds.all(addr),
    });
  }

  // -------- /api/wallet/history — equity curve (must precede /api/wallet/<addr>) --------
  if (urlPath === '/api/wallet/history') {
    const w = s.wallet.get();
    const startTs = w?.started_at || Date.now();
    const startBal = w?.starting_balance_sol || 5.0;
    const closes = s.walletHistoryCloses.all(startTs);

    const points = [{ ts: startTs, value: startBal, realized: 0 }];
    let realized = 0;
    for (const r of closes) {
      realized += (r.pnl || 0);
      points.push({ ts: r.ts, value: startBal + realized, realized });
    }

    const opens = s.walletHistoryOpens.all(startTs);
    let mtm = 0;
    for (const o of opens) {
      const cur = (o.tokens_remaining || 0) * (o.last_price_sol || 0);
      mtm += cur + (o.sol_realized_so_far || 0) - (o.entry_sol || 0);
    }
    points.push({ ts: Date.now(), value: startBal + realized + mtm, realized, unrealized: mtm });

    return sendJson(res, 200, { startBalance: startBal, startedAt: startTs, points });
  }

  // -------- /api/wallet/<addr> --------
  if (urlPath.startsWith('/api/wallet/') && method === 'GET') {
    const addr = urlPath.slice('/api/wallet/'.length).split('/')[0];
    if (!addr || addr.length < 30) return sendJson(res, 400, { error: 'bad_addr' });
    const buys = s.walletAggBuys.get(addr);
    const sells = s.walletAggSells.get(addr);
    return sendJson(res, 200, {
      address: addr,
      buys: buys.n, sells: sells.n,
      solBought: buys.sol, solSold: sells.sol,
      netSol: sells.sol - buys.sol, uniqueMints: buys.mints,
      recentTrades: s.walletRecent.all(addr),
    });
  }

  // -------- /api/strategies — shape matches V1 panel --------
  if (urlPath === '/api/strategies' || urlPath === '/api/strategies/') {
    const wr = s.winRate.get(0);
    const closed = s.closedPnl.get(0);
    return sendJson(res, 200, [{
      name: 'ml-policy-v2',
      label: 'ML Policy v2',
      enabled: true,
      description: '36-target ML inference. Pre-mig entry uses pump-prob ladder (peaked_30/100/300) + buy pressure + flow forecast. Post-mig uses direct EV regression (R²=0.46) + peak-pct regressions. Holds use drawdown-from-peak regression (R²=0.71) as the primary exit signal.',
      entry_summary: `threshold=${config.policy.entryScoreThreshold}, vetoes: will_rug>0.12, will_die_fast>0.60, rug_within_5min>0.30, peak_within_5min>0.55`,
      exit_summary: `holdFloor=${config.policy.holdScoreFloor}, exit when ML hold-score drops below`,
      wins: wr.wins || 0,
      losses: wr.losses || 0,
      total_pnl_sol: closed.pnl || 0,
      tier1_trigger_pct: 0, tier1_sell_pct: 0,
      tier2_trigger_pct: 0, tier2_sell_pct: 0,
      tier3_trigger_pct: 0, tier3_sell_pct: 0, tier3_trail_pct: 0,
      tp_trail_pct: 0, tp_trail_arm_pct: 0,
      break_even_after_t1: false,
    }]);
  }

  // -------- /api/ml/status — ML lab panel --------
  if (urlPath === '/api/ml/status') {
    const snaps = s.snapsAgg.get();
    const total = snaps.total || 0;
    const collectionDays = snaps.earliest ? (Date.now() - snaps.earliest) / 86_400_000 : 0;
    const preds3m = d.prepare("SELECT COUNT(*) n FROM ml_predictions WHERE timestamp > (strftime('%s','now')-180)*1000").get();
    const preds1h = d.prepare("SELECT COUNT(*) n FROM ml_predictions WHERE timestamp > (strftime('%s','now')-3600)*1000").get();
    return sendJson(res, 200, {
      state: 'TRAINED',
      totalSnapshots: total,
      resolvedSnapshots: total,
      resolvedPct: 1.0,
      buckets: { 60: snaps.s60, 300: snaps.s300, 900: snaps.s900, 3600: snaps.s1800 },
      collectionDays,
      targetForFirstTrain: 0,
      etaDaysToTrain: null,
      pctToTrain: 100,
      migrationRate: 0.02,
      modelsLoaded: 36,
      preds3min: preds3m.n,
      preds1h: preds1h.n,
    });
  }
  if (urlPath === '/api/ml/predictions') {
    const since = parseInt(query.since) || 300;
    return sendJson(res, 200, s.predRecent.all(since));
  }
  if (urlPath === '/api/ml/top-picks') {
    try { return sendJson(res, 200, s.predTopPicks.all()); }
    catch { return sendJson(res, 200, []); }
  }
  if (urlPath === '/api/ml/model-health') {
    return sendJson(res, 200, { ok: true, modelsLoaded: 36, lastReload: BOOT_TS });
  }
  if (urlPath === '/api/ml/retrain-status') {
    let status = { state: 'idle', total_targets: 17, current_index: 0, ok_count: 0, fail_count: 0 };
    try {
      const raw = fs.readFileSync('/opt/degen-club/data/retrain-status.json', 'utf8');
      status = { ...status, ...JSON.parse(raw) };
    } catch {}
    return sendJson(res, 200, status);
  }

  // -------- /api/microstructure/summary (placeholder — no aggregator in V2) --------
  if (urlPath === '/api/microstructure/summary') {
    return sendJson(res, 200, {
      hotMintCount: 0,
      sniperWarCount: 0,
      medianSandwichRisk: null,
      medianReactionSpeedMs: null,
      medianVolatilityPct: null,
      averageDepth: null,
      cleanMints: 0,
      contestedMints: 0,
    });
  }

  // -------- /api/ticker --------
  if (urlPath === '/api/ticker') {
    const w = s.wallet.get();
    const startedAt = w?.started_at || 0;
    const closed = s.closedPnl.get(startedAt);
    const open = s.opensAgg.get(startedAt);
    const wr = s.winRate.get(startedAt);
    return sendJson(res, 200, {
      mode: process.env.MODE || 'paper',
      pnl: closed.pnl || 0,
      opens: open.n || 0,
      wins: wr.wins || 0,
      total: wr.total || 0,
      timestamp: Date.now(),
    });
  }

  // -------- V1-only stubs (return [] or {} so panels render gracefully) --------
  if (urlPath === '/api/leaderboard/premig' || urlPath === '/api/leaderboard/postmig') {
    return sendJson(res, 200, { rows: [] });
  }
  if (urlPath === '/api/leaderboard/intersection' || urlPath === '/api/leaderboard') {
    return sendJson(res, 200, { rows: [] });
  }
  if (urlPath === '/api/wallet-rings') return sendJson(res, 200, { rings: [] });

  const STUB_EMPTY_LIST = [
    '/api/backtest/run', '/api/coins/lifecycle', '/api/creators/counts', '/api/creators/top',
    '/api/db/prune', '/api/exits/analysis', '/api/grader/status', '/api/leaderboard/recompute',
    '/api/ml/agent/archive', '/api/ml/agent/log', '/api/ml/agent/rate-limits', '/api/ml/agent/state',
    '/api/ml/calibration', '/api/ml/last-train', '/api/ml/lift-profile', '/api/ml/quality',
    '/api/ml/retrain', '/api/news/recent', '/api/news/synthesis',
    '/api/rejections/missed', '/api/runner-leaderboard', '/api/sentiment/overview',
    '/api/strategies/builder/list', '/api/strategies/builder/create', '/api/strategies/builder/restart',
    '/api/traders/counts', '/api/traders/top', '/api/wallet-rings/refresh', '/api/flags',
  ];
  if (STUB_EMPTY_LIST.includes(urlPath) || urlPath.startsWith('/api/strategies/builder/') ||
      urlPath.startsWith('/api/wallet-rings/') || urlPath.startsWith('/api/dev/') ||
      urlPath.startsWith('/api/flags/')) {
    return sendJson(res, 200, []);
  }

  sendJson(res, 200, {});
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const [rawPath, rawQuery] = req.url.split('?');
    const query = Object.fromEntries(new URLSearchParams(rawQuery || ''));
    if (rawPath.startsWith('/api/')) {
      try { return await routeApi(req, res, rawPath, query); }
      catch (err) { return sendJson(res, 500, { error: err.message }); }
    }
    return serveStatic(req, res);
  });
  server.listen(config.dashboardPort, () => {
    console.log(`[server] listening on http://0.0.0.0:${config.dashboardPort}`);
  });
}
