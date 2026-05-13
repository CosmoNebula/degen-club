import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { exec as childExec } from 'node:child_process';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { getSolUsd, getPriceLastUpdate } from '../price.js';
import { dbStats, pruneTrades, vacuumDb } from '../maintenance.js';
import { listStrategies, toggleStrategy, updateStrategySettings } from '../trading/strategies.js';
import { listRings, getRingMembers, detectRings } from '../scoring/wallet-rings.js';
import { parseHeliusWebhook, syncHunterWebhook } from '../ingestion/helius-webhooks.js';
import { ingestExternalTrade } from '../ingestion/processor.js';
import { getHolderStats } from '../scoring/holders.js';
import { backtestAll } from '../trading/backtest.js';
import { readHealth } from '../health.js';
import { applyRuntimeLimits } from '../runtime-limits.js';

const isLocalOrigin = (s) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(s || '');

// Slow COUNT(*) cache. SELECT COUNT(*) on a 3M-row table full-scans (~4s) and
// blocks the dashboard's sync better-sqlite3 event loop. Stats endpoints poll
// every few seconds — we cache these counters for 60s to avoid the wedge.
const _countCache = new Map();
const COUNT_CACHE_TTL_MS = 60 * 1000;
function getCachedCount(d, key, sql) {
  const c = _countCache.get(key);
  if (c && (Date.now() - c.t) < COUNT_CACHE_TTL_MS) return c.n;
  const n = d.prepare(sql).get().n;
  _countCache.set(key, { n, t: Date.now() });
  return n;
}

// Whole-response cache for heavy endpoints. The frontend polls /api/stats
// every 3s and runs ~17 SQL queries per call; on a 2.6GB DB at 91% disk
// pressure each call takes 4-7s, so polls pile up faster than they finish
// and the event loop drowns. We cache the full JSON for 5s — the dashboard
// never actually needs sub-5s stats freshness.
const _responseCache = new Map();
function cacheResponse(key, ttlMs, computeSync) {
  const c = _responseCache.get(key);
  if (c && (Date.now() - c.t) < ttlMs) return c.v;
  const v = computeSync();
  _responseCache.set(key, { v, t: Date.now() });
  return v;
}

function requireLocalOriginForMutations(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (process.env.ALLOW_REMOTE_WRITES === '1') return next();
  // Helius pushes server-to-server with no Origin/Referer — allow webhook ingest paths.
  if (req.path.startsWith('/api/webhook/')) return next();
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  if (isLocalOrigin(origin) || isLocalOrigin(referer)) return next();
  console.log(`[security] blocked ${req.method} ${req.path} from origin="${origin}" referer="${referer}" ip=${req.ip}`);
  return res.status(403).json({ error: 'mutations only allowed from localhost — view-only via tunnel' });
}

export function startServer(getIngestionStatus) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requireLocalOriginForMutations);
  app.use(express.static(config.publicDir));

  // Clean URL for ML Lab (so /ml works without .html)
  app.get('/ml', (req, res) => {
    res.sendFile(path.join(config.publicDir, 'ml.html'));
  });

  // Load persisted runtime limits on startup. (Dashboard process applies them
  // for its own config copy. Bot polls separately via pollRuntimeLimits in
  // src/index.js so dashboard edits propagate live.)
  applyRuntimeLimits();

  app.get('/api/ticker', (req, res) => {
    const d = db();
    try {
      const open = d.prepare(`SELECT id, mint_address, strategy, position_mode, entry_sol, entry_price, entered_at,
          (SELECT last_price_sol FROM mints WHERE mint_address = pp.mint_address) AS cur_price
        FROM paper_positions pp
        WHERE status = 'open' ORDER BY entered_at DESC LIMIT 30`).all();
      const closed = d.prepare(`SELECT id, mint_address, strategy, position_mode, entry_sol, realized_pnl_sol, realized_pnl_pct, exit_reason, exited_at
        FROM paper_positions WHERE status = 'closed' ORDER BY exited_at DESC LIMIT 30`).all();
      const paperWallet = d.prepare('SELECT * FROM paper_wallet WHERE id = 1').get() || {};
      const totals = d.prepare(`SELECT
          COALESCE(SUM(CASE WHEN position_mode='paper' THEN realized_pnl_sol ELSE 0 END),0) AS paperPnl,
          COALESCE(SUM(CASE WHEN position_mode='live'  THEN realized_pnl_sol ELSE 0 END),0) AS livePnl,
          SUM(CASE WHEN position_mode='paper' THEN 1 ELSE 0 END) AS paperN,
          SUM(CASE WHEN position_mode='live'  THEN 1 ELSE 0 END) AS liveN
        FROM paper_positions WHERE status='closed' AND entered_at >= ?`).get(paperWallet.started_at || 0);
      res.json({ open, closed, totals, t: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/stats', async (req, res) => {
    // Front-end polls every 3s; computing this response involves ~17 SQL
    // queries on a 2.6GB DB. Cache full response for 5s so dashboard polls
    // never stack up faster than they finish.
    const cached = _responseCache.get('stats');
    if (cached && (Date.now() - cached.t) < 5000) return res.json(cached.v);

    const d = db();
    const wallet = await import('../trading/wallet.js');
    const isLive = wallet.isLiveMode();
    const liveSession = wallet.getLiveSession();
    const liveStartedAt = liveSession.startedAt || 0;
    const sessionStartedAt = isLive
      ? liveStartedAt
      : (d.prepare('SELECT started_at FROM paper_wallet WHERE id = 1').get()?.started_at || 0);
    const posWhere = isLive
      ? `position_mode = 'live' AND entered_at >= ${liveStartedAt}`
      : `entered_at >= ${sessionStartedAt}`;
    const openPositions = d.prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE status = 'open' AND ${posWhere}`).get().n;
    const closedPositions = d.prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE status = 'closed' AND ${posWhere}`).get().n;
    const wins = d.prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE status = 'closed' AND realized_pnl_sol > 0 AND ${posWhere}`).get().n;
    const pnl = d.prepare(`SELECT COALESCE(SUM(realized_pnl_sol), 0) AS s FROM paper_positions WHERE status = 'closed' AND ${posWhere}`).get().s;
    const totalMints = d.prepare("SELECT COUNT(*) AS n FROM mints").get().n;
    const uniqueMintsTraded = d.prepare(`SELECT COUNT(DISTINCT mint_address) AS n FROM paper_positions WHERE ${posWhere}`).get().n;
    const incinerateSol = uniqueMintsTraded * 0.00203928;

    const PUMP_SUPPLY = 1_000_000_000;
    const CASHBACK_RATE = 0.005;
    const cashbackRow = d.prepare(`
      SELECT
        COALESCE(SUM(
          (pp.token_amount * 1.0 / ?) * ? * COALESCE((
            SELECT SUM(t.sol_amount)
            FROM trades t
            WHERE t.mint_address = pp.mint_address
              AND t.timestamp >= pp.entered_at
              AND (pp.exited_at IS NULL OR t.timestamp <= pp.exited_at)
          ), 0)
        ), 0) AS estimated_sol,
        COUNT(*) AS positions
      FROM paper_positions pp
      JOIN mints m ON m.mint_address = pp.mint_address
      WHERE m.cashback_enabled = 1 AND ${posWhere.replace(/entered_at/g, 'pp.entered_at').replace(/position_mode/g, 'pp.position_mode')}
    `).get(PUMP_SUPPLY, CASHBACK_RATE);
    const cashbackEstimatedSol = cashbackRow.estimated_sol || 0;
    const cashbackPositions = cashbackRow.positions || 0;
    // SELECT COUNT(*) on trades full-scans 3M+ rows (~4s). Cache for 60s —
    // these counters are display-only, no need for live precision.
    const totalTrades = getCachedCount(d, 'trades_total', `SELECT COUNT(*) AS n FROM trades`);
    const totalWallets = getCachedCount(d, 'wallets_total', `SELECT COUNT(*) AS n FROM wallets`);
    const trackedWallets = d.prepare("SELECT COUNT(*) AS n FROM wallets WHERE tracked = 1").get().n;
    const kolWallets = d.prepare("SELECT COUNT(*) AS n FROM wallets WHERE is_kol = 1").get().n;
    // Hunter wallets — qualifying for the migrator-hunter signal pool. Same
    // criteria as scoring/migrator-hunter.js's topHunters() (must match the
    // strategy gates: minScore + minSample + not auto_blocked).
    const hunterWallets = d.prepare(`
      SELECT COUNT(*) AS n FROM wallets
      WHERE migrator_score >= 0.55
        AND migrator_pre_mig_buys >= 5
        AND COALESCE(auto_blocked, 0) = 0
    `).get().n;
    const volumeSignals = d.prepare("SELECT COUNT(*) AS n FROM volume_signals").get().n;
    const bundleClusters = d.prepare("SELECT COUNT(*) AS n FROM bundle_clusters").get().n;
    const ingestion = getIngestionStatus ? getIngestionStatus() : null;

    const paperWallet = d.prepare('SELECT * FROM paper_wallet WHERE id = 1').get() || { starting_balance_sol: 1.0, started_at: Date.now(), reset_count: 0 };
    const closedSinceStart = d.prepare(`
      SELECT COALESCE(SUM(realized_pnl_sol), 0) AS pnl, COUNT(*) AS n,
             SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins
      FROM paper_positions
      WHERE status = 'closed' AND entered_at >= ?
    `).get(paperWallet.started_at);
    const openSinceStart = d.prepare(`
      SELECT
        COALESCE(SUM(pp.entry_sol - COALESCE(pp.sol_realized_so_far, 0)), 0) AS locked,
        COALESCE(SUM(pp.tokens_remaining * COALESCE(m.last_price_sol, pp.entry_price)), 0) AS mtm,
        -- At-risk capital = max(0, cost basis - already realized). Once a position
        -- has tiered out enough to cover its entry, it's house money and contributes
        -- 0 to exposure — same logic the strategy gate uses.
        COALESCE(SUM(MAX(0, pp.entry_sol - COALESCE(pp.sol_realized_so_far, 0))), 0) AS at_risk,
        SUM(CASE WHEN COALESCE(pp.sol_realized_so_far, 0) >= pp.entry_sol THEN 1 ELSE 0 END) AS house_money,
        COUNT(*) AS n
      FROM paper_positions pp
      LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status = 'open' AND pp.entered_at >= ?
    `).get(paperWallet.started_at);
    const cashBalance = paperWallet.starting_balance_sol + (closedSinceStart.pnl || 0) - (openSinceStart.locked || 0);
    const totalValue = cashBalance + (openSinceStart.mtm || 0);
    const pctChange = paperWallet.starting_balance_sol > 0 ? (totalValue - paperWallet.starting_balance_sol) / paperWallet.starting_balance_sol : 0;
    if (totalValue > (paperWallet.peak_total_value || 0)) {
      d.prepare('UPDATE paper_wallet SET peak_total_value = ?, peak_at = ? WHERE id = 1').run(totalValue, Date.now());
      paperWallet.peak_total_value = totalValue;
      paperWallet.peak_at = Date.now();
    }
    const drawdown = paperWallet.peak_total_value > 0 ? (totalValue - paperWallet.peak_total_value) / paperWallet.peak_total_value : 0;

    const sim = {
      startingBalanceSol: paperWallet.starting_balance_sol,
      startedAt: paperWallet.started_at,
      resetCount: paperWallet.reset_count || 0,
      cashBalance,
      totalValue,
      pctChange,
      lockedInOpen: openSinceStart.locked || 0,
      openMtm: openSinceStart.mtm || 0,
      atRiskExposure: openSinceStart.at_risk || 0,
      houseMoneyCount: openSinceStart.house_money || 0,
      unrealizedMtm: (openSinceStart.mtm || 0) - (openSinceStart.locked || 0),
      realizedSinceStart: closedSinceStart.pnl || 0,
      tradesSinceStart: closedSinceStart.n || 0,
      winsSinceStart: closedSinceStart.wins || 0,
      openSinceStart: openSinceStart.n || 0,
      peakTotalValue: paperWallet.peak_total_value || paperWallet.starting_balance_sol,
      drawdown,
    };

    let live = null;
    if (isLive) {
      let solBalance = null;
      try { solBalance = await wallet.getSolBalance(); } catch {}
      if (solBalance != null) wallet.recordLiveBalance(solBalance);
      const session = wallet.getLiveSession();
      const startingBalanceSol = session.startingSol != null ? session.startingSol : (solBalance || 0);
      const liveClosed = d.prepare(`
        SELECT COALESCE(SUM(realized_pnl_sol), 0) AS pnl, COUNT(*) AS n,
               SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins
        FROM paper_positions
        WHERE status = 'closed' AND position_mode = 'live' AND entered_at >= ?
      `).get(liveStartedAt);
      const liveOpen = d.prepare(`
        SELECT COALESCE(SUM(pp.entry_sol - pp.sol_realized_so_far), 0) AS locked,
               COALESCE(SUM(pp.tokens_remaining * COALESCE(m.last_price_sol, pp.entry_price)), 0) AS mtm,
               COUNT(*) AS n
        FROM paper_positions pp
        LEFT JOIN mints m ON m.mint_address = pp.mint_address
        WHERE pp.status = 'open' AND pp.position_mode = 'live' AND pp.entered_at >= ?
      `).get(liveStartedAt);
      const totalValue = solBalance != null ? solBalance + (liveOpen.mtm || 0) : null;
      const pctChange = (startingBalanceSol > 0 && totalValue != null)
        ? (totalValue - startingBalanceSol) / startingBalanceSol : 0;
      const peakBalance = session.peakBalance != null ? session.peakBalance : startingBalanceSol;
      const drawdown = peakBalance > 0 && solBalance != null
        ? (solBalance - peakBalance) / peakBalance : 0;
      live = {
        startingBalanceSol,
        startedAt: session.startedAt,
        cashBalance: solBalance,
        totalValue,
        pctChange,
        lockedInOpen: liveOpen.locked || 0,
        unrealizedMtm: (liveOpen.mtm || 0) - (liveOpen.locked || 0),
        realizedSinceStart: liveClosed.pnl || 0,
        tradesSinceStart: liveClosed.n || 0,
        winsSinceStart: liveClosed.wins || 0,
        openSinceStart: liveOpen.n || 0,
        peakTotalValue: peakBalance,
        peakAt: session.peakAt,
        drawdown,
      };
    }

    const out = {
      mode: isLive ? 'live' : 'paper',
      openPositions, closedPositions, wins,
      winRate: closedPositions ? wins / closedPositions : 0,
      realizedPnlSol: pnl,
      totalMints, totalTrades, totalWallets, trackedWallets, kolWallets, hunterWallets, volumeSignals, bundleClusters,
      uniqueMintsTraded, incinerateSol,
      cashbackEstimatedSol, cashbackPositions,
      ingestion,
      solUsd: getSolUsd(),
      priceUpdatedAt: getPriceLastUpdate(),
      sim,
      live,
    };
    _responseCache.set('stats', { v: out, t: Date.now() });
    res.json(out);
  });

  app.post('/api/wallet/sim/reset', (req, res) => {
    const d = db();
    const startBalance = parseFloat(req.body?.balance) || 1.0;
    const now = Date.now();
    d.prepare(`UPDATE paper_wallet SET
      starting_balance_sol = ?,
      started_at = ?,
      reset_count = COALESCE(reset_count, 0) + 1,
      peak_total_value = ?,
      peak_at = ?
      WHERE id = 1`).run(startBalance, now, startBalance, now);
    res.json({ ok: true, starting_balance_sol: startBalance, started_at: now });
  });

  app.get('/api/mints', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
    const category = req.query.category || 'all';
    const now = Date.now();
    const wheres = [];
    const params = [];
    let order = 'created_at DESC';
    switch (category) {
      case 'fresh':
        wheres.push('migrated = 0', 'rugged = 0', 'created_at > ?');
        params.push(now - 10 * 60 * 1000);
        break;
      case 'runners':
        wheres.push('migrated = 0', 'rugged = 0', 'peak_market_cap_sol >= 30', 'last_trade_at > ?');
        params.push(now - 5 * 60 * 1000);
        order = 'current_market_cap_sol DESC';
        break;
      case 'near_grad':
        wheres.push('migrated = 0', 'rugged = 0', 'v_sol_in_curve >= 60');
        order = 'v_sol_in_curve DESC';
        break;
      case 'migrated':
        wheres.push('migrated = 1');
        order = 'migrated_at DESC';
        break;
      case 'rugged':
        wheres.push('rugged = 1');
        order = 'rugged_at DESC';
        break;
    }
    const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const q = `SELECT * FROM mints ${whereClause} ORDER BY ${order} LIMIT ?`;
    params.push(limit);
    const rows = db().prepare(q).all(...params);
    for (const r of rows) r.flags = JSON.parse(r.flags || '[]');
    res.json(rows);
  });

  app.get('/api/mints/counts', (req, res) => {
    const d = db();
    const now = Date.now();
    const fresh = d.prepare('SELECT COUNT(*) AS n FROM mints WHERE migrated = 0 AND rugged = 0 AND created_at > ?').get(now - 10 * 60 * 1000).n;
    const runners = d.prepare('SELECT COUNT(*) AS n FROM mints WHERE migrated = 0 AND rugged = 0 AND peak_market_cap_sol >= 30 AND last_trade_at > ?').get(now - 5 * 60 * 1000).n;
    const nearGrad = d.prepare('SELECT COUNT(*) AS n FROM mints WHERE migrated = 0 AND rugged = 0 AND v_sol_in_curve >= 60').get().n;
    const migrated = d.prepare('SELECT COUNT(*) AS n FROM mints WHERE migrated = 1').get().n;
    const rugged = d.prepare('SELECT COUNT(*) AS n FROM mints WHERE rugged = 1').get().n;
    const all = d.prepare('SELECT COUNT(*) AS n FROM mints').get().n;
    res.json({ all, fresh, runners, near_grad: nearGrad, migrated, rugged });
  });

  app.get('/api/mint/:address', (req, res) => {
    const addr = req.params.address;
    const d = db();
    const mint = d.prepare('SELECT * FROM mints WHERE mint_address = ?').get(addr);
    if (!mint) return res.status(404).json({ error: 'not found' });
    mint.flags = JSON.parse(mint.flags || '[]');

    const trades = d.prepare('SELECT * FROM trades WHERE mint_address = ? ORDER BY timestamp DESC LIMIT 500').all(addr);

    const snipers = d.prepare(`
      SELECT wh.*,
        CASE WHEN wh.tokens_bought > 0 THEN wh.tokens_sold * 1.0 / wh.tokens_bought ELSE 0 END AS sold_pct,
        (wh.sol_realized - wh.sol_invested) AS net_sol,
        w.category, w.bundle_cluster_id
      FROM wallet_holdings wh
      LEFT JOIN wallets w ON w.address = wh.wallet
      WHERE wh.mint_address = ? AND wh.is_sniper = 1
      ORDER BY wh.first_buy_at
    `).all(addr);

    const creatorHistory = d.prepare(`
      SELECT mint_address, symbol, name, peak_market_cap_sol, current_market_cap_sol,
             migrated, rugged, created_at, flags
      FROM mints WHERE creator_wallet = ? AND mint_address != ?
      ORDER BY created_at DESC LIMIT 50
    `).all(mint.creator_wallet, addr);
    for (const c of creatorHistory) c.flags = JSON.parse(c.flags || '[]');

    const flagLog = d.prepare('SELECT * FROM rug_flags WHERE mint_address = ? ORDER BY fired_at DESC').all(addr);
    for (const f of flagLog) {
      try { f.details = JSON.parse(f.details || '{}'); } catch { f.details = {}; }
    }

    const holders = getHolderStats(addr);

    res.json({ mint, trades, snipers, creatorHistory, flagLog, holders });
  });

  app.get('/api/creators/top', (req, res) => {
    const category = req.query.category;
    const wheres = ['launch_count >= 1'];
    const params = [];
    if (category && category !== 'all') {
      wheres.push('category = ?');
      params.push(category);
    }
    const q = `SELECT * FROM creators WHERE ${wheres.join(' AND ')} ORDER BY reputation_score DESC, launch_count DESC LIMIT 100`;
    const rows = db().prepare(q).all(...params);
    for (const r of rows) {
      try { r.dev_flags = JSON.parse(r.dev_flags || '[]'); } catch { r.dev_flags = []; }
    }
    res.json(rows);
  });

  app.get('/api/creators/counts', (req, res) => {
    const d = db();
    const rows = d.prepare(`
      SELECT COALESCE(category, 'NEW') AS category, COUNT(*) AS n
      FROM creators WHERE launch_count >= 1
      GROUP BY category
    `).all();
    const out = { all: 0, LEGIT: 0, WHALE: 0, RUGGER: 0, SERIAL: 0, NEW: 0, NOT_SURE: 0 };
    for (const r of rows) { out[r.category] = r.n; out.all += r.n; }
    res.json(out);
  });

  app.get('/api/dev/:wallet', (req, res) => {
    const wallet = req.params.wallet;
    const d = db();
    const creator = d.prepare('SELECT * FROM creators WHERE wallet = ?').get(wallet);
    if (!creator) return res.status(404).json({ error: 'not found' });
    try { creator.dev_flags = JSON.parse(creator.dev_flags || '[]'); } catch { creator.dev_flags = []; }

    const launches = d.prepare(`
      SELECT * FROM mints WHERE creator_wallet = ? ORDER BY created_at DESC LIMIT 200
    `).all(wallet);
    for (const l of launches) {
      try { l.flags = JSON.parse(l.flags || '[]'); } catch { l.flags = []; }
    }

    const walletStats = d.prepare('SELECT * FROM wallets WHERE address = ?').get(wallet);
    if (walletStats) {
      try { walletStats.bot_flags = JSON.parse(walletStats.bot_flags || '[]'); } catch { walletStats.bot_flags = []; }
    }

    const summary = d.prepare(`
      SELECT
        SUM(CASE WHEN migrated = 1 THEN 1 ELSE 0 END) AS migrated,
        SUM(CASE WHEN rugged = 1 THEN 1 ELSE 0 END) AS rugged,
        AVG(peak_market_cap_sol) AS avg_peak,
        MAX(peak_market_cap_sol) AS best_peak,
        SUM(trade_count) AS total_trades,
        SUM(unique_buyer_count) AS total_buyers
      FROM mints WHERE creator_wallet = ?
    `).get(wallet);

    res.json({ creator, launches, walletStats, summary });
  });

  app.get('/api/traders/top', (req, res) => {
    const onlyTracked = req.query.tracked === '1';
    const category = req.query.category;
    const wheres = ['closed_position_count >= 1'];
    const params = [];
    if (onlyTracked) wheres.push('tracked = 1');
    if (category && category !== 'all') {
      wheres.push('category = ?');
      params.push(category);
    }
    const q = `SELECT * FROM wallets WHERE ${wheres.join(' AND ')} ORDER BY realized_pnl_30d DESC, realized_pnl DESC LIMIT 100`;
    const rows = db().prepare(q).all(...params);
    for (const r of rows) {
      try { r.bot_flags = JSON.parse(r.bot_flags || '[]'); } catch { r.bot_flags = []; }
    }
    res.json(rows);
  });

  app.get('/api/traders/counts', (req, res) => {
    const d = db();
    const rows = d.prepare(`
      SELECT COALESCE(category, 'NOT_SURE') AS category, COUNT(*) AS n
      FROM wallets WHERE closed_position_count >= 1
      GROUP BY category
    `).all();
    const out = { all: 0, HUMAN: 0, BOT: 0, SCALPER: 0, BUNDLE: 0, NOT_SURE: 0 };
    for (const r of rows) { out[r.category] = r.n; out.all += r.n; }
    res.json(out);
  });

  app.get('/api/leaderboard', (req, res) => {
    const limit = Math.min(50, Number(req.query.limit) || 50);
    const rows = db().prepare(`
      SELECT wl.rank, wl.tier, wl.address, wl.score, wl.realized_pnl_30d,
             wl.win_rate_30d, wl.closed_30d, wl.migrator_pre_mig_buys,
             wl.avg_multiple_30d, wl.early_entry_rate, wl.rug_rate_30d,
             wl.sniper_ratio, wl.avg_hold_seconds, wl.components_json,
             wl.computed_at, w.label, w.category, w.last_activity_at
      FROM wallet_leaderboard wl
      LEFT JOIN wallets w ON w.address = wl.address
      ORDER BY wl.rank ASC LIMIT ?
    `).all(limit);
    for (const r of rows) {
      try { r.components = JSON.parse(r.components_json || '{}'); } catch { r.components = {}; }
      delete r.components_json;
    }
    const meta = db().prepare(`SELECT MAX(computed_at) AS computed_at, COUNT(*) AS n FROM wallet_leaderboard`).get();
    res.json({ rows, meta });
  });

  app.post('/api/leaderboard/recompute', async (req, res) => {
    try {
      const m = await import('../scoring/wallet-leaderboard.js');
      const out = m.recomputeLeaderboard({ verbose: true });
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/wallet-rings', (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 100);
    const minSize = Math.max(2, Number(req.query.min_size) || 2);
    const sortBy = req.query.sort || 'paper_net_sol';
    res.json({ rings: listRings({ limit, minSize, sortBy }) });
  });

  app.get('/api/wallet-rings/:id', (req, res) => {
    const d = db();
    const ring = d.prepare('SELECT * FROM wallet_rings WHERE id = ?').get(req.params.id);
    if (!ring) return res.status(404).json({ error: 'not found' });
    const members = getRingMembers(req.params.id);
    res.json({ ring, members });
  });

  app.post('/api/webhook/helius-hunters', (req, res) => {
    try {
      const events = req.body;
      const trades = parseHeliusWebhook(events);
      for (const t of trades) ingestExternalTrade(t);
      res.json({ ok: true, trades: trades.length });
    } catch (err) {
      console.error('[helius-wh] ingest', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/webhook/helius-hunters/sync', async (req, res) => {
    try { await syncHunterWebhook(); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/wallet-rings/refresh', (req, res) => {
    try {
      const r = detectRings({ verbose: false });
      res.json({ ok: true, ...r });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/wallet/:address', (req, res) => {
    const addr = req.params.address;
    const d = db();
    const wallet = d.prepare('SELECT * FROM wallets WHERE address = ?').get(addr);
    if (!wallet) return res.status(404).json({ error: 'not found' });
    try { wallet.bot_flags = JSON.parse(wallet.bot_flags || '[]'); } catch { wallet.bot_flags = []; }

    const positions = d.prepare(`
      SELECT wh.*, m.symbol, m.name, m.image_uri, m.created_at AS mint_created_at,
             m.last_price_sol, m.current_market_cap_sol, m.peak_market_cap_sol,
             m.migrated, m.rugged, m.flags,
             CASE WHEN wh.tokens_bought > 0 THEN wh.tokens_sold * 1.0 / wh.tokens_bought ELSE 0 END AS sold_pct,
             (wh.sol_realized - wh.sol_invested) AS net_sol
      FROM wallet_holdings wh
      LEFT JOIN mints m ON m.mint_address = wh.mint_address
      WHERE wh.wallet = ?
      ORDER BY wh.last_activity_at DESC
    `).all(addr);
    for (const p of positions) p.flags = JSON.parse(p.flags || '[]');

    const trades = d.prepare(`
      SELECT t.*, m.symbol, m.name
      FROM trades t
      LEFT JOIN mints m ON m.mint_address = t.mint_address
      WHERE t.wallet = ?
      ORDER BY t.timestamp DESC LIMIT 500
    `).all(addr);

    const coTraders = d.prepare(`
      SELECT wh2.wallet, COUNT(*) AS overlap_count, w.tracked, w.realized_pnl_30d, w.category
      FROM wallet_holdings wh1
      JOIN wallet_holdings wh2 ON wh1.mint_address = wh2.mint_address AND wh2.wallet != wh1.wallet
      LEFT JOIN wallets w ON w.address = wh2.wallet
      WHERE wh1.wallet = ?
        AND ABS(COALESCE(wh1.first_buy_at, 0) - COALESCE(wh2.first_buy_at, 0)) < 30000
      GROUP BY wh2.wallet
      ORDER BY overlap_count DESC
      LIMIT 25
    `).all(addr);

    let bundleCluster = null;
    if (wallet.bundle_cluster_id) {
      bundleCluster = d.prepare('SELECT * FROM bundle_clusters WHERE cluster_id = ?').get(wallet.bundle_cluster_id);
      if (bundleCluster) {
        try { bundleCluster.members = JSON.parse(bundleCluster.members || '[]'); } catch { bundleCluster.members = []; }
      }
    }

    res.json({ wallet, positions, trades, coTraders, bundleCluster });
  });

  app.get('/api/signals/volume', (req, res) => {
    const rows = db().prepare(`
      SELECT vs.*, m.symbol, m.name, m.image_uri, m.current_market_cap_sol,
             m.migrated, m.rugged, m.flags
      FROM volume_signals vs
      LEFT JOIN mints m ON m.mint_address = vs.mint_address
      ORDER BY vs.fired_at DESC
      LIMIT 50
    `).all();
    for (const r of rows) {
      try { r.details = JSON.parse(r.details || '{}'); } catch { r.details = {}; }
      try { r.flags = JSON.parse(r.flags || '[]'); } catch { r.flags = []; }
    }
    res.json(rows);
  });

  app.get('/api/signals/copy', (req, res) => {
    const rows = db().prepare(`
      SELECT cs.*, m.symbol, m.name, m.image_uri, m.current_market_cap_sol,
             m.migrated, m.rugged, m.flags
      FROM copy_signals cs
      LEFT JOIN mints m ON m.mint_address = cs.mint_address
      ORDER BY cs.fired_at DESC
      LIMIT 50
    `).all();
    for (const r of rows) {
      try { r.tracked_wallets = JSON.parse(r.tracked_wallets || '[]'); } catch { r.tracked_wallets = []; }
      try { r.details = JSON.parse(r.details || '{}'); } catch { r.details = {}; }
      try { r.flags = JSON.parse(r.flags || '[]'); } catch { r.flags = []; }
    }
    res.json(rows);
  });

  app.get('/api/bundles', (req, res) => {
    const rows = db().prepare(`
      SELECT * FROM bundle_clusters
      ORDER BY member_count DESC, mint_count DESC
      LIMIT 50
    `).all();
    for (const r of rows) {
      try { r.members = JSON.parse(r.members || '[]'); } catch { r.members = []; }
    }
    res.json(rows);
  });

  app.get('/api/positions', (req, res) => {
    const d = db();
    const open = d.prepare(`
      SELECT pp.*, m.symbol, m.name, m.image_uri, m.current_market_cap_sol, m.last_price_sol, m.migrated, m.rugged
      FROM paper_positions pp
      LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status = 'open'
      ORDER BY pp.entered_at DESC
    `).all();
    const recent = d.prepare(`
      SELECT pp.*, m.symbol, m.name
      FROM paper_positions pp
      LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status = 'closed'
      ORDER BY pp.exited_at DESC LIMIT 100
    `).all();
    res.json({ open, recent });
  });

  app.get('/api/strategies', (req, res) => {
    res.json(listStrategies());
  });

  app.post('/api/strategies/:name/toggle', (req, res) => {
    const r = toggleStrategy(req.params.name);
    res.json(r);
  });

  // Always-warm cache for slow analytics endpoints. Dashboard polls every 3s
  // and the underlying data only changes meaningfully every several seconds —
  // recomputing every tick was contending DB writes from the trade firehose
  // and causing 1-3s dashboard freezes. A background prewarm keeps the cache
  // fresh so user requests always hit it (no cold-start spikes from DB
  // lock contention).
  const _ttlCache = new Map();
  function cached(key, fallbackValue) {
    const hit = _ttlCache.get(key);
    return hit ? hit.value : fallbackValue;
  }
  function prewarm(key, intervalMs, compute) {
    const refresh = () => {
      try { _ttlCache.set(key, { value: compute(), at: Date.now() }); }
      catch (err) { console.error(`[prewarm] ${key}:`, err.message); }
    };
    refresh();
    setInterval(refresh, intervalMs);
  }
  // Refresh every 10s — the analytics queries can block the event loop for
  // ~0.5-1.5s when the DB is under heavy write load from the trade firehose,
  // so refreshing less often = fewer blocking events. 10s staleness is fine
  // for missed-ops + exit analysis (which change slowly).
  prewarm('exits/analysis', 10000, () => computeExitsAnalysis());
  prewarm('rejections/missed', 10000, () => computeMissedRejections());

  app.get('/api/exits/analysis', (req, res) => {
    res.json(cached('exits/analysis', { summary: [], rows: [] }));
  });
  function computeExitsAnalysis() {
    const d = db();
    const sessionStart = d.prepare('SELECT started_at FROM paper_wallet WHERE id = 1').get()?.started_at || 0;
    const summary = d.prepare(`
      SELECT exit_reason,
             COUNT(*) AS total,
             SUM(CASE WHEN post_exit_outcome = 'EARLY_EXIT' THEN 1 ELSE 0 END) AS early_exits,
             SUM(CASE WHEN post_exit_outcome = 'LEFT_MONEY' THEN 1 ELSE 0 END) AS left_money,
             SUM(CASE WHEN post_exit_outcome = 'CORRECT_EXIT' THEN 1 ELSE 0 END) AS correct_exits,
             SUM(CASE WHEN post_exit_outcome = 'NEUTRAL' THEN 1 ELSE 0 END) AS neutral,
             SUM(CASE WHEN post_exit_outcome = 'PENDING' THEN 1 ELSE 0 END) AS pending,
             AVG(post_exit_peak_pct) AS avg_peak_pct,
             MAX(post_exit_peak_pct) AS max_peak_pct
      FROM paper_positions
      WHERE status = 'closed' AND post_exit_outcome IS NOT NULL AND entered_at >= ?
      GROUP BY exit_reason
      ORDER BY total DESC
    `).all(sessionStart);
    const rows = d.prepare(`
      SELECT pp.id, pp.mint_address, pp.strategy, pp.exit_reason,
             pp.exited_at, pp.entry_sol, pp.realized_pnl_sol, pp.realized_pnl_pct,
             pp.exit_price, pp.post_exit_peak_price, pp.post_exit_peak_pct, pp.post_exit_outcome,
             m.symbol, m.name
      FROM paper_positions pp
      LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status = 'closed' AND pp.post_exit_outcome IS NOT NULL AND pp.entered_at >= ?
      ORDER BY pp.post_exit_peak_pct DESC
      LIMIT 100
    `).all(sessionStart);
    return { summary, rows };
  }

  app.get('/api/rejections/missed', (req, res) => {
    res.json(cached('rejections/missed', { rejections: [], summary: [], sessionStart: 0 }));
  });
  function computeMissedRejections() {
    const d = db();
    // Scope to this session: only rejections since the current paper_wallet
    // reset, and only count what the mint did AFTER the reject (not its
    // all-time peak — a 5x pump last week isn't a missed opportunity today).
    const wallet = d.prepare('SELECT started_at FROM paper_wallet WHERE id = 1').get();
    const sessionStart = wallet?.started_at || 0;
    const rows = d.prepare(`
      WITH session_rejects AS (
        SELECT * FROM gate_rejections WHERE first_rejected_at >= ?
      ),
      peaks AS (
        SELECT sr.mint_address, COALESCE(MAX(t.market_cap_sol), 0) AS peak_after
        FROM session_rejects sr
        LEFT JOIN trades t ON t.mint_address = sr.mint_address
                          AND t.timestamp >= sr.first_rejected_at
        GROUP BY sr.mint_address
      )
      SELECT
        gr.mint_address, gr.first_rejected_at, gr.last_rejected_at, gr.reject_count,
        gr.reason, gr.reason_detail, gr.signal_type, gr.mcap_at_reject,
        m.symbol, m.name, m.current_market_cap_sol,
        m.migrated, m.rugged, m.flags,
        p.peak_after AS peak_market_cap_sol_after,
        CASE WHEN gr.mcap_at_reject > 0
          THEN (p.peak_after - gr.mcap_at_reject) / gr.mcap_at_reject
          ELSE 0 END AS peak_pct_after,
        CASE WHEN gr.mcap_at_reject > 0
          THEN (m.current_market_cap_sol - gr.mcap_at_reject) / gr.mcap_at_reject
          ELSE 0 END AS current_pct_after,
        CASE
          WHEN gr.mcap_at_reject <= 0 THEN 'PENDING'
          WHEN p.peak_after >= gr.mcap_at_reject * 2 THEN 'BIG_WIN'
          WHEN p.peak_after >= gr.mcap_at_reject * 1.3 THEN 'WIN'
          ELSE 'LOSS'
        END AS outcome
      FROM session_rejects gr
      LEFT JOIN mints m ON m.mint_address = gr.mint_address
      LEFT JOIN peaks p ON p.mint_address = gr.mint_address
      ORDER BY peak_pct_after DESC
      LIMIT 200
    `).all(sessionStart);
    for (const r of rows) {
      try { r.flags = JSON.parse(r.flags || '[]'); } catch { r.flags = []; }
      // Backwards-compat alias for the field the UI reads.
      r.peak_market_cap_sol = r.peak_market_cap_sol_after;
    }
    const summary = d.prepare(`
      SELECT reason, COUNT(*) AS n FROM gate_rejections WHERE first_rejected_at >= ? GROUP BY reason ORDER BY n DESC
    `).all(sessionStart);
    return { rejections: rows, summary, sessionStart };
  }

  app.post('/api/backtest/run', (req, res) => {
    try {
      const t0 = Date.now();
      const enabledOnly = req.body?.includeDisabled ? false : true;
      const results = backtestAll({ enabledOnly });
      const elapsedMs = Date.now() - t0;
      res.json({ elapsedMs, results });
    } catch (err) {
      console.error('[backtest]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/strategies/:name/settings', (req, res) => {
    try {
      const r = updateStrategySettings(req.params.name, req.body);
      res.json(r);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/db/stats', (req, res) => {
    res.json(dbStats());
  });

  app.get('/api/system/health', (req, res) => {
    res.json(readHealth());
  });

  app.get('/api/runner-leaderboard', (req, res) => {
    try {
      const d = db();
      const limit = parseInt(req.query.limit || '30', 10);
      const rows = d.prepare(`
        SELECT mint_address, symbol, name, created_at, current_market_cap_sol, peak_market_cap_sol,
          v_sol_in_curve, unique_buyer_count, runner_score, runner_breakdown, runner_scored_at, runner_fired,
          migrated, rugged, cashback_enabled
        FROM mints
        WHERE runner_score IS NOT NULL AND migrated = 0 AND rugged = 0
        ORDER BY runner_score DESC, runner_scored_at DESC
        LIMIT ?
      `).all(limit);
      res.json({ rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/coins/lifecycle', (req, res) => {
    try {
      const d = db();
      const win = parseFloat(req.query.window || '6');
      const cutoff = Date.now() - win * 60 * 60 * 1000;
      const filter = req.query.filter || 'all';

      let where = `m.created_at >= ${cutoff}`;
      if (filter === 'migrated') where += ` AND m.migrated = 1`;
      if (filter === 'rugged') where += ` AND m.rugged = 1`;
      if (filter === 'live') where += ` AND m.migrated = 0 AND m.rugged = 0`;

      const rows = d.prepare(`
        SELECT
          m.mint_address, m.symbol, m.name, m.created_at, m.migrated, m.migrated_at, m.rugged,
          m.current_market_cap_sol, m.peak_market_cap_sol, m.v_sol_in_curve,
          m.unique_buyer_count, m.flags, m.cashback_enabled,
          m.last_price_sol, m.last_trade_at,
          (
            SELECT COUNT(DISTINCT t.wallet) FROM trades t
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND t.timestamp <= m.created_at + 60*1000
          ) AS buyers_1min,
          (
            SELECT COUNT(DISTINCT t.wallet) FROM trades t
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND t.timestamp <= m.created_at + 5*60*1000
          ) AS buyers_5min,
          (
            SELECT COUNT(DISTINCT t.wallet) FROM trades t
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND t.timestamp <= m.created_at + 15*60*1000
          ) AS buyers_15min,
          (
            SELECT COUNT(DISTINCT t.wallet) FROM trades t
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND t.timestamp <= m.created_at + 60*60*1000
          ) AS buyers_60min,
          (
            SELECT ROUND(SUM(t.sol_amount), 3) FROM trades t
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND t.timestamp <= m.created_at + 60*1000
          ) AS sol_in_1min,
          (
            SELECT ROUND(SUM(t.sol_amount), 3) FROM trades t
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND t.timestamp <= m.created_at + 5*60*1000
          ) AS sol_in_5min,
          (
            SELECT ROUND(SUM(t.sol_amount), 3) FROM trades t
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND t.timestamp <= m.created_at + 15*60*1000
          ) AS sol_in_15min,
          (
            SELECT COUNT(*) FROM trades t WHERE t.mint_address = m.mint_address AND t.is_sniper = 1
          ) AS sniper_count,
          (
            SELECT COUNT(DISTINCT t.wallet) FROM trades t
            JOIN wallets w ON w.address = t.wallet
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND w.tracked = 1
          ) AS tracked_buyers,
          (
            SELECT COUNT(DISTINCT t.wallet) FROM trades t
            JOIN wallets w ON w.address = t.wallet
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND w.is_kol = 1
          ) AS kol_buyers,
          (
            SELECT COUNT(DISTINCT t.wallet) FROM trades t
            JOIN wallets w ON w.address = t.wallet
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND w.auto_boost_mult > 1.0
          ) AS boosted_buyers,
          (
            SELECT MIN(CAST((t.timestamp - m.created_at)/1000 AS INTEGER)) FROM trades t
            JOIN wallets w ON w.address = t.wallet
            WHERE t.mint_address = m.mint_address AND t.is_buy = 1 AND w.tracked = 1
          ) AS tracked_first_buy_age_sec,
          (
            SELECT pp.strategy FROM paper_positions pp WHERE pp.mint_address = m.mint_address ORDER BY pp.entered_at LIMIT 1
          ) AS we_strategy,
          (
            SELECT ROUND(SUM(pp.realized_pnl_sol), 4) FROM paper_positions pp
            WHERE pp.mint_address = m.mint_address AND pp.status='closed'
          ) AS we_pnl_sol
        FROM mints m
        WHERE ${where}
        ORDER BY m.created_at DESC
        LIMIT 500
      `).all();

      const summary = d.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN migrated = 1 THEN 1 ELSE 0 END) AS migrated,
          SUM(CASE WHEN rugged = 1 THEN 1 ELSE 0 END) AS rugged,
          SUM(CASE WHEN migrated = 0 AND rugged = 0 THEN 1 ELSE 0 END) AS live,
          ROUND(AVG(CASE WHEN migrated = 1 THEN (migrated_at - created_at)/60000.0 END), 1) AS avg_min_to_mig,
          ROUND(AVG(peak_market_cap_sol), 1) AS avg_peak_mcap
        FROM mints
        WHERE created_at >= ${cutoff}
      `).get();

      res.json({ window: win, summary, rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/grader/status', (req, res) => {
    try {
      const d = db();
      const boosted = d.prepare(`
        SELECT address, category, follow_trades, follow_wr, follow_net_sol, auto_boost_mult, is_kol
        FROM wallets WHERE auto_boost_mult > 1.0
        ORDER BY follow_net_sol DESC
      `).all();
      const blocked = d.prepare(`
        SELECT address, category, follow_trades, follow_wr, follow_net_sol
        FROM wallets WHERE auto_blocked = 1
        ORDER BY follow_net_sol ASC
      `).all();
      const trackedCount = d.prepare("SELECT COUNT(*) AS n FROM wallets WHERE tracked = 1").get().n;
      const kolCount = d.prepare("SELECT COUNT(*) AS n FROM wallets WHERE is_kol = 1").get().n;
      const candidateCount = d.prepare("SELECT COUNT(*) AS n FROM wallets WHERE follow_trades >= 3 AND auto_blocked = 0 AND auto_boost_mult <= 1.0").get().n;
      res.json({
        boosted, blocked,
        summary: {
          boostedCount: boosted.length,
          blockedCount: blocked.length,
          trackedCount,
          kolCount,
          candidateCount,
        },
        criteria: {
          boost: 'follow_trades ≥ 5 AND wr ≥ 80% AND net ≥ +0.20 SOL → 1.25x sizing',
          block: 'follow_trades ≥ 5 AND wr < 45% AND net < −0.20 SOL → no fire',
        },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/live-sim', (req, res) => {
    try {
      const d = db();
      const lat = Math.max(0, Math.min(5000, parseInt(req.query.latencyMs || '750', 10)));
      const f = config.friction || {};
      const slip = f.slippagePct || 0.025;
      const priority = f.priorityFeeSol || 0.0008;
      const fee = f.feePct || 0;
      const windowHours = req.query.windowHours ? Math.max(1, Math.min(168, parseInt(req.query.windowHours, 10))) : null;
      const sessionStart = windowHours
        ? Date.now() - windowHours * 3600 * 1000
        : (d.prepare('SELECT started_at FROM paper_wallet WHERE id = 1').get()?.started_at || 0);
      const positions = d.prepare(`
        SELECT id, mint_address, strategy, entry_signal, entry_price, exit_price,
               entry_sol, token_amount, realized_pnl_sol, realized_pnl_pct,
               entered_at, exited_at, exit_reason
        FROM paper_positions
        WHERE status = 'closed' AND entered_at >= ?
          AND entry_price > 0 AND exit_price > 0
        ORDER BY entered_at ASC
      `).all(sessionStart);

      const findPriceAtOrAfter = d.prepare(`
        SELECT price_sol, timestamp FROM trades
        WHERE mint_address = ? AND timestamp >= ? AND price_sol > 0
        ORDER BY timestamp ASC LIMIT 1
      `);
      const findSignalWalletExit = d.prepare(`
        SELECT MAX(price_sol) AS best_sell_price, MAX(timestamp) AS last_sell_at,
               COUNT(*) AS sell_count, SUM(sol_amount) AS total_sold
        FROM trades
        WHERE mint_address = ? AND wallet = ? AND is_buy = 0 AND timestamp >= ?
      `);

      const trades = positions.map(p => {
        const entryRow = findPriceAtOrAfter.get(p.mint_address, p.entered_at + lat);
        const exitRow = findPriceAtOrAfter.get(p.mint_address, p.exited_at + lat);
        const liveEntryPrice = entryRow?.price_sol || p.entry_price;
        const liveExitPrice = exitRow?.price_sol || p.exit_price;
        const effectiveEntrySol = Math.max(0, p.entry_sol - priority);
        const liveTokens = (effectiveEntrySol * (1 - fee)) / (liveEntryPrice * (1 + slip));
        const liveProceeds = Math.max(0, liveTokens * liveExitPrice * (1 - slip) * (1 - fee) - priority);
        const liveSimPnl = liveProceeds - p.entry_sol;
        const liveSimPct = p.entry_sol > 0 ? liveSimPnl / p.entry_sol : 0;
        const slippageVsPaperPnl = liveSimPnl - p.realized_pnl_sol;

        let trackedWallet = null;
        try { trackedWallet = JSON.parse(p.entry_signal || '{}').wallet || null; } catch {}
        let signalWalletComparison = null;
        if (trackedWallet) {
          const k = findSignalWalletExit.get(p.mint_address, trackedWallet, p.entered_at);
          if (k && k.sell_count > 0) {
            const signalWalletExitProceeds = Math.max(0, liveTokens * (k.best_sell_price || 0) * (1 - slip) * (1 - fee) - priority);
            signalWalletComparison = {
              wallet: trackedWallet,
              their_best_sell_price: k.best_sell_price,
              their_last_sell_at: k.last_sell_at,
              their_sell_count: k.sell_count,
              their_total_sold_sol: k.total_sold,
              if_we_matched_their_top_pnl: signalWalletExitProceeds - p.entry_sol,
              we_exited_first_by_ms: k.last_sell_at ? k.last_sell_at - p.exited_at : null,
            };
          }
        }
        const buyDriftPct = p.entry_price > 0 ? (liveEntryPrice - p.entry_price) / p.entry_price : 0;
        const sellDriftPct = p.exit_price > 0 ? (liveExitPrice - p.exit_price) / p.exit_price : 0;
        return {
          id: p.id,
          mint: p.mint_address,
          strategy: p.strategy,
          exit_reason: p.exit_reason,
          paper_pnl: p.realized_pnl_sol,
          paper_pct: p.realized_pnl_pct,
          live_sim_pnl: liveSimPnl,
          live_sim_pct: liveSimPct,
          slippage_cost_sol: slippageVsPaperPnl,
          paper_buy_at: p.entered_at,
          paper_sell_at: p.exited_at,
          live_buy_filled_at: entryRow?.timestamp || null,
          live_sell_filled_at: exitRow?.timestamp || null,
          buy_lag_ms: entryRow ? entryRow.timestamp - p.entered_at : null,
          sell_lag_ms: exitRow ? exitRow.timestamp - p.exited_at : null,
          live_entry_price: liveEntryPrice,
          live_exit_price: liveExitPrice,
          paper_entry_price: p.entry_price,
          paper_exit_price: p.exit_price,
          buy_price_drift_pct: buyDriftPct,
          sell_price_drift_pct: sellDriftPct,
          signal_wallet_comparison: signalWalletComparison,
        };
      });

      const byStrat = {};
      for (const t of trades) {
        const s = byStrat[t.strategy] || (byStrat[t.strategy] = {
          n: 0, paper_net: 0, live_net: 0,
          paper_wins: 0, live_wins: 0,
          we_beat_signal: 0, signal_beat_us: 0, signal_pairs: 0,
          signal_first_pnl_total: 0,
        });
        s.n++;
        s.paper_net += t.paper_pnl;
        s.live_net += t.live_sim_pnl;
        if (t.paper_pnl > 0) s.paper_wins++;
        if (t.live_sim_pnl > 0) s.live_wins++;
        if (t.signal_wallet_comparison) {
          s.signal_pairs++;
          s.signal_first_pnl_total += t.signal_wallet_comparison.if_we_matched_their_top_pnl;
          if (t.live_sim_pnl > t.signal_wallet_comparison.if_we_matched_their_top_pnl) s.we_beat_signal++;
          else s.signal_beat_us++;
        }
      }
      const summary = Object.entries(byStrat).map(([strategy, s]) => ({
        strategy,
        n: s.n,
        paper_wr: s.paper_wins / s.n,
        live_wr: s.live_wins / s.n,
        paper_net_sol: s.paper_net,
        live_net_sol: s.live_net,
        slippage_cost_sol: s.live_net - s.paper_net,
        avg_slippage_per_trade_sol: (s.live_net - s.paper_net) / s.n,
        signal_pairs: s.signal_pairs,
        we_beat_their_top_n: s.we_beat_signal,
        their_top_beat_us_n: s.signal_beat_us,
        avg_potential_per_trade_if_perfect_signal_top: s.signal_pairs > 0 ? s.signal_first_pnl_total / s.signal_pairs : null,
      }));

      res.json({
        latencyMs: lat,
        slippagePct: slip,
        priorityFeeSol: priority,
        sessionStart,
        n: trades.length,
        summary,
        trades: trades.slice(0, 200),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/friction-audit', (req, res) => {
    try {
      const d = db();
      const f = config.friction || {};
      const priority = f.priorityFeeSol || 0;
      const fee = f.feePct || 0;
      const slip = f.slippagePct || 0;
      const rows = d.prepare(`
        SELECT id, mint_address, strategy, entry_price, exit_price, entry_sol,
               token_amount, realized_pnl_sol, realized_pnl_pct,
               entered_at, exited_at, exit_reason
        FROM paper_positions
        WHERE position_mode = 'live' AND status = 'closed'
          AND entry_price > 0 AND exit_price > 0 AND token_amount > 0
        ORDER BY exited_at DESC
      `).all();

      const trades = rows.map(r => {
        const modelEffectiveSol = Math.max(0, r.entry_sol - priority);
        const modelTokens = (modelEffectiveSol * (1 - fee)) / (r.entry_price * (1 + slip));
        const modelProceeds = Math.max(0, modelTokens * r.exit_price * (1 - slip) * (1 - fee) - priority);
        const modeledPnl = modelProceeds - r.entry_sol;
        const actualProceeds = r.entry_sol + r.realized_pnl_sol;
        const deltaSol = r.realized_pnl_sol - modeledPnl;
        const impliedBuySlipPct = r.token_amount > 0
          ? ((r.entry_sol - priority) / r.token_amount / r.entry_price - 1) : null;
        const impliedSellSlipPct = modelTokens > 0
          ? 1 - ((actualProceeds + priority) / (r.token_amount * r.exit_price)) : null;
        const actualRoundTripPct = r.entry_sol > 0 ? -r.realized_pnl_sol / r.entry_sol + ((r.exit_price / r.entry_price) - 1) : null;
        const modeledRoundTripPct = r.entry_sol > 0 ? -modeledPnl / r.entry_sol + ((r.exit_price / r.entry_price) - 1) : null;
        return {
          id: r.id, mint: r.mint_address, strategy: r.strategy, exit_reason: r.exit_reason,
          entered_at: r.entered_at, exited_at: r.exited_at,
          entry_sol: r.entry_sol, entry_price: r.entry_price, exit_price: r.exit_price,
          tokens_actual: r.token_amount, tokens_modeled: modelTokens,
          actual_pnl_sol: r.realized_pnl_sol, modeled_pnl_sol: modeledPnl,
          delta_sol: deltaSol,
          implied_buy_slip_pct: impliedBuySlipPct,
          implied_sell_slip_pct: impliedSellSlipPct,
          actual_round_trip_friction_pct: actualRoundTripPct,
          modeled_round_trip_friction_pct: modeledRoundTripPct,
        };
      });

      const n = trades.length;
      let summary = null;
      if (n > 0) {
        const avg = (k) => trades.reduce((a, t) => a + (t[k] || 0), 0) / n;
        const totalDelta = trades.reduce((a, t) => a + (t.delta_sol || 0), 0);
        const totalEntrySol = trades.reduce((a, t) => a + (t.entry_sol || 0), 0);
        const validBuy = trades.filter(t => t.implied_buy_slip_pct != null);
        const validSell = trades.filter(t => t.implied_sell_slip_pct != null);
        const avgBuySlip = validBuy.length ? validBuy.reduce((a, t) => a + t.implied_buy_slip_pct, 0) / validBuy.length : null;
        const avgSellSlip = validSell.length ? validSell.reduce((a, t) => a + t.implied_sell_slip_pct, 0) / validSell.length : null;
        const avgImpliedSlip = (avgBuySlip != null && avgSellSlip != null) ? (avgBuySlip + avgSellSlip) / 2 : (avgBuySlip ?? avgSellSlip);
        const recommendedSlip = avgImpliedSlip != null ? Math.max(0, Math.round(avgImpliedSlip * 1000) / 1000) : null;
        summary = {
          n,
          configured: { slippagePct: slip, priorityFeeSol: priority, feePct: fee },
          avg_actual_pnl_sol: avg('actual_pnl_sol'),
          avg_modeled_pnl_sol: avg('modeled_pnl_sol'),
          avg_delta_sol: totalDelta / n,
          total_delta_sol: totalDelta,
          delta_per_sol_traded: totalEntrySol > 0 ? totalDelta / totalEntrySol : null,
          avg_implied_buy_slip_pct: avgBuySlip,
          avg_implied_sell_slip_pct: avgSellSlip,
          avg_implied_slip_pct: avgImpliedSlip,
          recommended_slippage_pct: recommendedSlip,
          note: avgImpliedSlip != null && Math.abs(avgImpliedSlip - slip) > 0.005
            ? `Implied slip ${(avgImpliedSlip*100).toFixed(2)}% differs from configured ${(slip*100).toFixed(2)}% by >0.5pp — consider updating config.friction.slippagePct`
            : 'Configured friction matches live within 0.5pp.',
        };
      }
      res.json({ summary, trades });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/strategies/builder/list', (req, res) => {
    try {
      const out = [];
      for (const [name, cfg] of Object.entries(config.strategies)) {
        if (['monitorIntervalMs', 'global', 'holderGate'].includes(name)) continue;
        if (typeof cfg !== 'object' || !cfg.defaults) continue;
        const file = path.join(config.publicDir, '..', 'src', 'strategies', `${name}.js`);
        out.push({ name, config: cfg, sourceFile: fs.existsSync(file) ? `src/strategies/${name}.js` : null });
      }
      res.json({ strategies: out });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/strategies/builder/create', (req, res) => {
    try {
      const { name, label, description, trigger, sourceFilter, mcCeiling, mcFloor, defaults, trustedWallets, signalSellExitThreshold } = req.body || {};
      if (!name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        return res.status(400).json({ error: 'name must be camelCase identifier' });
      }
      const file = path.join(config.publicDir, '..', 'src', 'strategies', `${name}.js`);
      if (fs.existsSync(file)) return res.status(409).json({ error: `${name} already exists — use PUT to update` });
      const cfg = { label: label || name, description: description || '', trigger: trigger || 'smart_trade' };
      if (sourceFilter) cfg.sourceFilter = sourceFilter;
      if (typeof mcCeiling === 'number') cfg.mcCeiling = mcCeiling;
      if (typeof mcFloor === 'number') cfg.mcFloor = mcFloor;
      if (Array.isArray(trustedWallets) && trustedWallets.length) cfg.trustedWallets = trustedWallets;
      if (typeof signalSellExitThreshold === 'number') cfg.signalSellExitThreshold = signalSellExitThreshold;
      cfg.defaults = defaults || {};
      const body = `// User-built strategy — generated via Strategy Builder UI\nexport default ${JSON.stringify({ name, config: cfg }, null, 2)};\n`;
      fs.writeFileSync(file, body);
      res.json({ ok: true, name, sourceFile: `src/strategies/${name}.js`, restart_required: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/strategies/builder/:name', (req, res) => {
    try {
      const name = req.params.name;
      const file = path.join(config.publicDir, '..', 'src', 'strategies', `${name}.js`);
      if (!fs.existsSync(file)) return res.status(404).json({ error: `${name} not found` });
      const { label, description, trigger, sourceFilter, mcCeiling, mcFloor, defaults, trustedWallets, signalSellExitThreshold } = req.body || {};
      const cfg = { label: label || name, description: description || '', trigger: trigger || 'smart_trade' };
      if (sourceFilter) cfg.sourceFilter = sourceFilter;
      if (typeof mcCeiling === 'number') cfg.mcCeiling = mcCeiling;
      if (typeof mcFloor === 'number') cfg.mcFloor = mcFloor;
      if (Array.isArray(trustedWallets) && trustedWallets.length) cfg.trustedWallets = trustedWallets;
      if (typeof signalSellExitThreshold === 'number') cfg.signalSellExitThreshold = signalSellExitThreshold;
      cfg.defaults = defaults || {};
      const body = `// User-built strategy — generated via Strategy Builder UI\nexport default ${JSON.stringify({ name, config: cfg }, null, 2)};\n`;
      fs.writeFileSync(file, body);
      res.json({ ok: true, name, restart_required: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/strategies/builder/:name', (req, res) => {
    try {
      const name = req.params.name;
      const file = path.join(config.publicDir, '..', 'src', 'strategies', `${name}.js`);
      if (!fs.existsSync(file)) return res.status(404).json({ error: `${name} not found` });
      fs.unlinkSync(file);
      try { db().prepare('DELETE FROM strategy_state WHERE name = ?').run(name); } catch {}
      res.json({ ok: true, name, restart_required: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/strategies/builder/restart', (req, res) => {
    try {
      const uid = process.getuid();
      childExec(`launchctl kickstart -k gui/${uid}/com.degen-club`, (err) => {
        if (err) console.error('[builder] restart failed:', err.message);
      });
      res.json({ ok: true, message: 'restart triggered — page may briefly disconnect' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/velocity-runner/stats', async (req, res) => {
    try {
      const cv = await import('../scoring/coin-velocity.js');
      const stats = cv.getProfileStats();
      const passRate = stats.evaluated > 0 ? stats.passed / stats.evaluated : 0;
      const sortedRej = Object.entries(stats.rejections).sort((a, b) => b[1] - a[1]);
      res.json({
        sinceMs: stats.sinceMs,
        sinceMin: +(stats.sinceMs / 60000).toFixed(1),
        evaluated: stats.evaluated,
        passed: stats.passed,
        passRate: +(passRate * 100).toFixed(2),
        rejections: Object.fromEntries(sortedRej),
        topReason: sortedRej[0]?.[0] || null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/velocity-runner/stats/reset', async (req, res) => {
    try {
      const cv = await import('../scoring/coin-velocity.js');
      cv.resetProfileStats();
      res.json({ ok: true, resetAt: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/friction/summary', async (req, res) => {
    try {
      const since = Date.now() - 60 * 60 * 1000; // last hour
      const overall = db().prepare(`SELECT
          COUNT(*) AS n,
          AVG(total_slippage_pct) AS avg_total,
          AVG(curve_slip_pct) AS avg_curve,
          AVG(vol_drift_pct) AS avg_vol,
          AVG(sandwich_pct) AS avg_sandwich,
          AVG(priority_fee_sol) AS avg_priority,
          AVG(latency_ms) AS avg_latency,
          MAX(total_slippage_pct) AS max_total
        FROM friction_log WHERE timestamp >= ?`).get(since);
      const perStrat = db().prepare(`SELECT strategy, side,
          COUNT(*) AS n,
          AVG(total_slippage_pct) AS avg_total,
          AVG(curve_slip_pct) AS avg_curve,
          AVG(vol_drift_pct) AS avg_vol,
          AVG(sandwich_pct) AS avg_sandwich
        FROM friction_log WHERE timestamp >= ? AND strategy IS NOT NULL
        GROUP BY strategy, side ORDER BY strategy, side`).all(since);
      // Realism gap: how much higher (or lower) is dynamic friction vs static 2.5%?
      const gap = db().prepare(`SELECT
          AVG(total_slippage_pct - 0.025) AS avg_gap_vs_static,
          SUM(CASE WHEN total_slippage_pct > 0.025 THEN 1 ELSE 0 END) AS more_friction,
          SUM(CASE WHEN total_slippage_pct <= 0.025 THEN 1 ELSE 0 END) AS less_or_equal_friction
        FROM friction_log WHERE timestamp >= ? AND was_dynamic = 1`).get(since);
      res.json({ windowHours: 1, overall, perStrategy: perStrat, vsStatic: gap, asOf: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/microstructure/summary', async (req, res) => {
    try {
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      const row = db().prepare(`
        SELECT COUNT(*) AS n,
               AVG(v_sol_in_curve) AS avg_v_sol,
               AVG(volatility_pct) AS avg_vol,
               AVG(sandwich_risk) AS avg_sandwich,
               AVG(reaction_speed_ms) AS avg_reaction,
               AVG(trades_per_min) AS avg_tpm,
               AVG(unique_buyers_5min) AS avg_buyers,
               SUM(CASE WHEN sandwich_risk >= 0.5 THEN 1 ELSE 0 END) AS contested,
               SUM(CASE WHEN sandwich_risk < 0.2 THEN 1 ELSE 0 END) AS clean,
               SUM(CASE WHEN volatility_pct > 0.10 THEN 1 ELSE 0 END) AS chop_heavy,
               SUM(CASE WHEN reaction_speed_ms IS NOT NULL AND reaction_speed_ms < 100 THEN 1 ELSE 0 END) AS sniper_war
        FROM mint_microstructure WHERE active_at >= ?`).get(fiveMinAgo);
      // Median sandwich + reaction (proper median, not avg)
      const sandwichMedRow = db().prepare(`SELECT sandwich_risk FROM mint_microstructure WHERE active_at >= ? ORDER BY sandwich_risk LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM mint_microstructure WHERE active_at >= ?)`).get(fiveMinAgo, fiveMinAgo);
      const reactionMedRow = db().prepare(`SELECT reaction_speed_ms FROM mint_microstructure WHERE active_at >= ? AND reaction_speed_ms IS NOT NULL ORDER BY reaction_speed_ms LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM mint_microstructure WHERE active_at >= ? AND reaction_speed_ms IS NOT NULL)`).get(fiveMinAgo, fiveMinAgo);
      const volMedRow = db().prepare(`SELECT volatility_pct FROM mint_microstructure WHERE active_at >= ? ORDER BY volatility_pct LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM mint_microstructure WHERE active_at >= ?)`).get(fiveMinAgo, fiveMinAgo);

      const result = {
        hotMintCount: row?.n || 0,
        avgVSolInCurve: row?.avg_v_sol || 0,
        avgVolatilityPct: row?.avg_vol || 0,
        avgSandwichRisk: row?.avg_sandwich || 0,
        avgReactionSpeedMs: row?.avg_reaction != null ? Math.round(row.avg_reaction) : null,
        avgTradesPerMin: row?.avg_tpm || 0,
        avgBuyers5min: row?.avg_buyers || 0,
        medianSandwichRisk: sandwichMedRow?.sandwich_risk ?? null,
        medianReactionSpeedMs: reactionMedRow?.reaction_speed_ms ?? null,
        medianVolatilityPct: volMedRow?.volatility_pct ?? null,
        contestedCount: row?.contested || 0,
        cleanCount: row?.clean || 0,
        chopHeavyCount: row?.chop_heavy || 0,
        sniperWarCount: row?.sniper_war || 0,
        asOf: Date.now(),
      };
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ML inference test endpoint — manually probe the model with any mint address.
  // Useful for debugging "what does the model say about this mint?"
  app.get('/api/ml/predict', async (req, res) => {
    try {
      const mint = req.query.mint;
      if (!mint) return res.status(400).json({ error: 'missing ?mint=' });
      const { getMigrationProb, getServiceStatus } = await import('../ml/ml-client.js');
      const status = getServiceStatus();
      if (!status.serviceReachable) {
        return res.status(503).json({ error: 'inference service unreachable', status });
      }
      if (!status.modelLoaded) {
        return res.status(503).json({ error: 'model not loaded yet (Phase 2 pending real data)', status });
      }
      const prob = await getMigrationProb(mint, 'manual_probe');
      const { collectFeatures } = await import('../ml/feature-collector.js');
      const features = collectFeatures(mint);
      res.json({ mint, prob, features, status });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Last-train marker (from retrain_all.py)
  app.get('/api/ml/last-train', async (req, res) => {
    try {
      const mlRoot = path.resolve(config.publicDir, '..', 'ml');
      const markerPath = path.join(mlRoot, 'data', '.last_train_meta.json');
      if (!fs.existsSync(markerPath)) return res.json({});
      res.json(JSON.parse(fs.readFileSync(markerPath, 'utf8')));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Manual retrain trigger — fires the auto-retrain pipeline now.
  app.post('/api/ml/retrain', async (req, res) => {
    try {
      const { triggerRetrainNow } = await import('../ml/auto-retrain.js');
      res.json(triggerRetrainNow());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Lift profile — for each classification target, show how predicted-prob
  // deciles map to actual outcome rates. Reveals model's discrimination
  // (does it rank winners higher than losers) separately from calibration
  // (are the absolute probabilities honest).
  app.get('/api/ml/lift-profile', async (req, res) => {
    try {
      const TARGETS = [
        'peaked_30', 'peaked_100', 'peaked_300', 'migrated', 'will_die_fast',
        // Long-horizon hold-to-maturity binary targets (2026-05-12)
        'alive_at_4h', 'alive_at_24h', 'hits_5x_within_24h', 'hits_10x_within_24h',
      ];
      const out = {};
      for (const target of TARGETS) {
        const rows = db().prepare(`
          SELECT p.prob, MAX(s.${target}) AS actual
          FROM ml_predictions p
          JOIN ml_mint_snapshots s ON s.mint_address = p.mint_address
          WHERE p.prob IS NOT NULL AND p.target = ?
            AND s.labels_resolved_at IS NOT NULL AND s.${target} IS NOT NULL
          GROUP BY p.id
        `).all(target);
        if (rows.length === 0) { out[target] = { n: 0, deciles: [], baseline: null, lift_at_30: null }; continue; }
        const baseline = rows.reduce((a, r) => a + (r.actual || 0), 0) / rows.length;
        // decile buckets
        const buckets = Array.from({ length: 10 }, (_, i) => ({
          low: i * 0.1, high: (i + 1) * 0.1, n: 0, n_pos: 0, sum_prob: 0,
        }));
        for (const r of rows) {
          const idx = Math.min(9, Math.floor((r.prob || 0) * 10));
          buckets[idx].n++;
          buckets[idx].sum_prob += r.prob;
          if (r.actual === 1) buckets[idx].n_pos++;
        }
        const deciles = buckets.map(b => ({
          low: b.low, high: b.high, n: b.n,
          predicted: b.n > 0 ? b.sum_prob / b.n : null,
          actual: b.n > 0 ? b.n_pos / b.n : null,
          lift: b.n > 0 && baseline > 0 ? (b.n_pos / b.n) / baseline : null,
        }));
        // Also surface the headline number: top-30%-prob actual rate vs baseline
        const top = rows.filter(r => r.prob > 0.30);
        const topRate = top.length > 0 ? top.reduce((a, r) => a + (r.actual || 0), 0) / top.length : null;
        out[target] = {
          n: rows.length,
          baseline,
          top30_n: top.length,
          top30_rate: topRate,
          top30_lift: topRate != null && baseline > 0 ? topRate / baseline : null,
          deciles,
        };
      }
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Live progress for the dashboard's retrain bar.
  app.get('/api/ml/retrain-status', async (req, res) => {
    try {
      const { getRetrainProgress } = await import('../ml/auto-retrain.js');
      res.json(getRetrainProgress());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // === Manual flags (cultural pulse override) ===
  app.get('/api/flags', (req, res) => {
    try {
      const rows = db().prepare(`SELECT id, flag, note, active, created_at, expires_at
         FROM manual_flags ORDER BY created_at DESC LIMIT 50`).all();
      res.json({ flags: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/flags', (req, res) => {
    try {
      const { flag, note, expires_in_hours } = req.body || {};
      if (!flag || flag.length < 2) return res.status(400).json({ error: 'flag required' });
      const expiresAt = expires_in_hours ? Date.now() + (expires_in_hours * 3600000) : null;
      db().prepare(`INSERT INTO manual_flags (flag, note, active, created_at, expires_at) VALUES (?, ?, 1, ?, ?)`)
         .run(flag.slice(0, 200), note?.slice(0, 500) || null, Date.now(), expiresAt);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/flags/:id/deactivate', (req, res) => {
    try {
      db().prepare(`UPDATE manual_flags SET active=0 WHERE id=?`).run(req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // News + meta synthesis read endpoints (for dashboard panel)
  app.get('/api/news/recent', (req, res) => {
    try {
      const rows = db().prepare(`SELECT source, title, url, ts, relevance_score
         FROM news_items WHERE ts > strftime('%s','now')*1000 - 86400000
         ORDER BY relevance_score DESC, ts DESC LIMIT 50`).all();
      res.json({ items: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/news/synthesis', (req, res) => {
    try {
      const row = db().prepare(`SELECT ts, summary FROM agent_meta_synthesis ORDER BY ts DESC LIMIT 1`).get();
      res.json(row || { ts: null, summary: null });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // === ML Agent endpoints ===
  // Retired strategy archive — for the dashboard's "graveyard" view. Decluttered
  // from the main strategies grid, kept here for post-mortem and agent learning.
  app.get('/api/ml/agent/archive', async (req, res) => {
    try {
      const rows = db().prepare(`
        SELECT id, name, rationale, status, retired_at, retired_reason,
               n_trades, ROUND(realized_pnl_sol, 4) AS pnl, created_at
        FROM ml_agent_strategies
        WHERE status = 'retired'
        ORDER BY retired_at DESC LIMIT 50
      `).all();
      res.json({ archived: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/ml/agent/state', async (req, res) => {
    try {
      const { getAgentSummary } = await import('../ml/agent.js');
      res.json(getAgentSummary());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/ml/agent/rate-limits', async (req, res) => {
    try {
      const { getRateLimitState } = await import('../ml/agent-rate-limit.js');
      res.json({ today: getRateLimitState() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/ml/agent/log', async (req, res) => {
    try {
      const { getAgentLog } = await import('../ml/agent.js');
      const n = Math.min(200, parseInt(req.query.n) || 50);
      res.json({ entries: getAgentLog(n) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Model health — drift detection across retrains.
  app.get('/api/ml/model-health', async (req, res) => {
    try {
      const { getModelHealth, ensureBaseline } = await import('../ml/drift-monitor.js');
      ensureBaseline();
      res.json(getModelHealth());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Calibration plot — does the model's 50% predictions actually hit 50% of the time?
  // For each prediction, find the mint's labeled snapshot (any age) and use its
  // outcome as ground truth. Bucket predictions by decile, compute actual rate.
  app.get('/api/ml/calibration', async (req, res) => {
    try {
      // Pull predictions joined with whatever label resolved for that mint.
      // We pivot the truth column dynamically so the calibration is per-target.
      const target = String(req.query.target || 'peaked_30');
      const ALLOWED = ['migrated', 'peaked_30', 'peaked_100', 'peaked_300', 'will_die_fast'];
      if (!ALLOWED.includes(target)) {
        return res.status(400).json({ error: `target must be one of ${ALLOWED.join(', ')}` });
      }
      const rows = db().prepare(`
        SELECT p.prob, MAX(s.${target}) AS actual
        FROM ml_predictions p
        JOIN ml_mint_snapshots s ON s.mint_address = p.mint_address
        WHERE p.prob IS NOT NULL
          AND p.target = ?
          AND s.labels_resolved_at IS NOT NULL
          AND s.${target} IS NOT NULL
        GROUP BY p.id
      `).all(target);
      const buckets = Array.from({ length: 10 }, (_, i) => ({
        low: i * 0.1, high: (i + 1) * 0.1, n: 0, n_pos: 0, sum_prob: 0,
      }));
      for (const r of rows) {
        const idx = Math.min(9, Math.floor((r.prob || 0) * 10));
        buckets[idx].n++;
        buckets[idx].sum_prob += r.prob;
        if (r.actual === 1) buckets[idx].n_pos++;
      }
      const data = buckets.map(b => ({
        bucket_low: b.low,
        bucket_high: b.high,
        n: b.n,
        predicted_avg: b.n > 0 ? b.sum_prob / b.n : null,
        actual_rate: b.n > 0 ? b.n_pos / b.n : null,
      }));
      // Brier score: mean squared error between predicted and actual
      let brier = null;
      if (rows.length > 0) {
        let sum = 0;
        for (const r of rows) sum += (r.prob - (r.actual || 0)) ** 2;
        brier = sum / rows.length;
      }
      // Calibration error: weighted absolute gap between predicted and actual per bucket
      let ce = 0, totalN = 0;
      for (const b of data) {
        if (b.n > 0 && b.predicted_avg != null && b.actual_rate != null) {
          ce += b.n * Math.abs(b.predicted_avg - b.actual_rate);
          totalN += b.n;
        }
      }
      ce = totalN > 0 ? ce / totalN : null;
      res.json({
        target,
        n_total: rows.length,
        buckets: data,
        brier_score: brier,
        calibration_error: ce,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Top picks — multi-target view. Pivots ml_predictions wide so each mint
  // gets one row with ALL its target predictions. Sorted by `sortBy` query
  // param (default: peaked_30).
  app.get('/api/ml/top-picks', async (req, res) => {
    try {
      const since = Date.now() - 30 * 60 * 1000;
      const sortBy = String(req.query.sortBy || 'peaked_30');
      // Latest prediction per (mint, target) within window
      const rows = db().prepare(`
        SELECT p.mint_address, p.target, p.prob, p.timestamp,
               m.symbol, m.current_market_cap_sol AS mcap, m.unique_buyer_count AS buyers
        FROM ml_predictions p LEFT JOIN mints m ON m.mint_address = p.mint_address
        WHERE p.timestamp >= ? AND p.prob IS NOT NULL AND p.target IS NOT NULL
          AND COALESCE(m.migrated, 0) = 0 AND COALESCE(m.rugged, 0) = 0
      `).all(since);
      // Pivot: mint → { target1: prob, target2: prob, ... }
      const byMint = new Map();
      for (const r of rows) {
        if (!byMint.has(r.mint_address)) {
          byMint.set(r.mint_address, {
            mint_address: r.mint_address, symbol: r.symbol, mcap: r.mcap, buyers: r.buyers,
            scored_at: r.timestamp, predictions: {},
          });
        }
        const entry = byMint.get(r.mint_address);
        const existing = entry.predictions[r.target];
        if (existing == null || r.timestamp > existing.timestamp) {
          entry.predictions[r.target] = { prob: r.prob, timestamp: r.timestamp };
        }
        if (r.timestamp > entry.scored_at) entry.scored_at = r.timestamp;
      }
      // Sort by chosen target's prob (mints missing that target rank last)
      const picks = [...byMint.values()].sort((a, b) => {
        const ap = a.predictions[sortBy]?.prob ?? -1;
        const bp = b.predictions[sortBy]?.prob ?? -1;
        return bp - ap;
      }).slice(0, 25).map(p => ({
        ...p,
        // Flatten predictions to plain {target: prob} for easier frontend consumption
        predictions: Object.fromEntries(Object.entries(p.predictions).map(([k, v]) => [k, v.prob])),
      }));
      res.json({ asOf: Date.now(), sortBy, picks });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Stats + recent predictions for dashboard
  app.get('/api/ml/predictions', async (req, res) => {
    try {
      const { getRecentPredictions, getStats } = await import('../ml/ml-client.js');
      const n = Math.min(100, parseInt(req.query.n) || 25);
      res.json({
        stats: getStats(),
        recent: getRecentPredictions(n),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/ml/quality', async (req, res) => {
    try {
      const d = db();
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const hourMs = 60 * 60 * 1000;

      // Volume
      const total = d.prepare(`SELECT COUNT(*) AS n FROM ml_mint_snapshots`).get().n;
      const resolved = d.prepare(`SELECT COUNT(*) AS n FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL`).get().n;
      const buckets = d.prepare(`SELECT snapshot_age_sec, COUNT(*) AS n FROM ml_mint_snapshots GROUP BY snapshot_age_sec`).all();
      const bucketMap = { '60': 0, '300': 0, '900': 0, '3600': 0 };
      for (const b of buckets) bucketMap[String(b.snapshot_age_sec)] = b.n;
      const oldest = d.prepare(`SELECT MIN(snapshot_ts) AS t FROM ml_mint_snapshots`).get();
      const oldestMs = oldest?.t || null;
      const collectionDays = oldestMs ? (now - oldestMs) / dayMs : 0;

      // Hourly volume — last 24 hours
      const hourlyRows = d.prepare(`
        SELECT CAST((snapshot_ts - ?) / ${hourMs} AS INTEGER) AS hour_offset, COUNT(*) AS n
        FROM ml_mint_snapshots WHERE snapshot_ts >= ? GROUP BY hour_offset ORDER BY hour_offset
      `).all(now - 24 * hourMs, now - 24 * hourMs);
      const hourly = Array(24).fill(0);
      for (const r of hourlyRows) {
        if (r.hour_offset >= 0 && r.hour_offset < 24) hourly[r.hour_offset] = r.n;
      }
      const lastHourCount = hourly[hourly.length - 1] || 0;
      const avgHourly = total > 0 && collectionDays > 0 ? Math.round(total / (collectionDays * 24)) : 0;

      // Daily volume — last 7 days
      const dailyRows = d.prepare(`
        SELECT CAST((snapshot_ts - ?) / ${dayMs} AS INTEGER) AS day_offset, COUNT(*) AS n
        FROM ml_mint_snapshots WHERE snapshot_ts >= ? GROUP BY day_offset ORDER BY day_offset
      `).all(now - 7 * dayMs, now - 7 * dayMs);
      const daily = Array(7).fill(0);
      for (const r of dailyRows) {
        if (r.day_offset >= 0 && r.day_offset < 7) daily[r.day_offset] = r.n;
      }

      // Resolution health
      const resolution = d.prepare(`
        SELECT
          COUNT(*) AS overdue,
          AVG(CAST((labels_resolved_at - snapshot_ts) AS REAL) / 3600000.0) AS avg_lag_hr
        FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL
      `).get();
      const overdueUnresolved = d.prepare(`
        SELECT COUNT(*) AS n FROM ml_mint_snapshots
        WHERE labels_resolved_at IS NULL AND snapshot_ts < ?
      `).get(now - 12 * hourMs).n;
      const resolutionsLastHour = d.prepare(`
        SELECT COUNT(*) AS n FROM ml_mint_snapshots WHERE labels_resolved_at >= ?
      `).get(now - hourMs).n;

      // Labels
      const labelStats = d.prepare(`
        SELECT
          AVG(migrated) AS mig_rate,
          AVG(peaked_30) AS p30_rate,
          AVG(peaked_100) AS p100_rate,
          AVG(peaked_500) AS p500_rate
        FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL
      `).get();
      // peak_pct_max distribution is heavy-tailed — mean is dominated by a
      // handful of runners. Compute median + p95 in JS for robust headline stats.
      const peakRows = d.prepare(`
        SELECT peak_pct_max FROM ml_mint_snapshots
        WHERE labels_resolved_at IS NOT NULL AND peak_pct_max IS NOT NULL
        ORDER BY peak_pct_max ASC
      `).all();
      let peakMedian = 0, peakP95 = 0;
      if (peakRows.length > 0) {
        const arr = peakRows.map(r => r.peak_pct_max);
        peakMedian = arr[Math.floor(arr.length * 0.5)];
        peakP95 = arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
      }
      const migByDay = d.prepare(`
        SELECT CAST((snapshot_ts - ?) / ${dayMs} AS INTEGER) AS day, AVG(migrated) AS rate, COUNT(*) AS n
        FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL AND snapshot_ts >= ?
        GROUP BY day ORDER BY day
      `).all(now - 7 * dayMs, now - 7 * dayMs);
      const migDayArr = Array(7).fill(null);
      for (const r of migByDay) if (r.day >= 0 && r.day < 7) migDayArr[r.day] = { rate: r.rate, n: r.n };
      // Class balance stability (CV of migration rate across days with data)
      const migRates = migDayArr.filter(x => x != null).map(x => x.rate);
      let cvMigRate = null;
      if (migRates.length >= 2) {
        const mean = migRates.reduce((a, b) => a + b, 0) / migRates.length;
        const variance = migRates.reduce((a, b) => a + (b - mean) ** 2, 0) / migRates.length;
        cvMigRate = mean > 0 ? Math.sqrt(variance) / mean : 0;
      }

      // Feature health — null counts + basic stats per feature
      const featureCols = [
        'initial_buy_sol', 'creator_launch_count', 'creator_migrated_count',
        'has_twitter', 'has_telegram', 'has_website',
        'name_length', 'symbol_length', 'created_hour_utc', 'created_dow',
        'last_price_sol', 'last_mcap_sol', 'peak_mcap_sol_so_far',
        'v_sol_in_curve', 'sol_inflow', 'sol_outflow',
        'buy_count', 'sell_count', 'buy_sell_ratio',
        'unique_buyers', 'tracked_buyers', 'kol_buyers', 'bundle_buyers',
        'trade_count', 'trades_per_min',
        'volatility_pct', 'sandwich_risk', 'reaction_speed_ms',
        'rpc_latency_p90_ms', 'priority_fee_p90'
      ];
      // Some features are structurally sparse and that's expected — flagging
      // them noises up the alerts list. reaction_speed_ms requires ≥3 tracked-
      // wallet buys per mint and we only have ~51 tracked wallets, so 70-85%
      // null is the natural rate. Train pipeline handles NaN correctly.
      const EXPECTED_SPARSE = new Set(['reaction_speed_ms']);
      const features = [];
      for (const col of featureCols) {
        const stats = d.prepare(`SELECT
          COUNT(*) - COUNT(${col}) AS null_count,
          COUNT(DISTINCT ${col}) AS unique_count,
          AVG(${col}) AS mean,
          MIN(${col}) AS min, MAX(${col}) AS max
          FROM ml_mint_snapshots`).get();
        const nullPct = total > 0 ? (stats.null_count / total) * 100 : 0;
        const isSparse = EXPECTED_SPARSE.has(col);
        let health = 'good';
        if (!isSparse && nullPct > 50) health = 'bad';
        else if (!isSparse && nullPct > 20) health = 'warn';
        else if (isSparse && nullPct > 90) health = 'warn';  // only alert if even sparser than expected
        if (stats.unique_count <= 1) health = 'warn'; // stuck at single value
        features.push({
          name: col,
          null_count: stats.null_count,
          null_pct: nullPct,
          unique_count: stats.unique_count,
          mean: stats.mean,
          min: stats.min,
          max: stats.max,
          health,
        });
      }

      // Coverage
      const coverage = d.prepare(`
        SELECT
          COUNT(DISTINCT mint_address) AS unique_mints,
          (SELECT COUNT(DISTINCT m.creator_wallet) FROM ml_mint_snapshots s JOIN mints m ON m.mint_address = s.mint_address) AS unique_creators
        FROM ml_mint_snapshots
      `).get();
      const todByHour = d.prepare(`
        SELECT created_hour_utc AS hour, COUNT(*) AS n FROM ml_mint_snapshots GROUP BY created_hour_utc ORDER BY created_hour_utc
      `).all();
      const todArr = Array(24).fill(0);
      for (const r of todByHour) if (r.hour != null && r.hour >= 0 && r.hour < 24) todArr[r.hour] = r.n;
      const dowByDay = d.prepare(`
        SELECT created_dow AS dow, COUNT(*) AS n FROM ml_mint_snapshots GROUP BY created_dow ORDER BY created_dow
      `).all();
      const dowArr = Array(7).fill(0);
      for (const r of dowByDay) if (r.dow != null && r.dow >= 0 && r.dow < 7) dowArr[r.dow] = r.n;
      const initialBuyDist = d.prepare(`
        SELECT
          SUM(CASE WHEN initial_buy_sol < 0.5 THEN 1 ELSE 0 END) AS b1,
          SUM(CASE WHEN initial_buy_sol >= 0.5 AND initial_buy_sol < 2 THEN 1 ELSE 0 END) AS b2,
          SUM(CASE WHEN initial_buy_sol >= 2 AND initial_buy_sol < 5 THEN 1 ELSE 0 END) AS b3,
          SUM(CASE WHEN initial_buy_sol >= 5 AND initial_buy_sol < 10 THEN 1 ELSE 0 END) AS b4,
          SUM(CASE WHEN initial_buy_sol >= 10 THEN 1 ELSE 0 END) AS b5
        FROM ml_mint_snapshots
      `).get();

      // Recent activity
      const recentSnapshots = d.prepare(`
        SELECT mint_address, snapshot_age_sec, snapshot_ts, last_mcap_sol, unique_buyers
        FROM ml_mint_snapshots ORDER BY snapshot_ts DESC LIMIT 10
      `).all();
      const recentResolutions = d.prepare(`
        SELECT mint_address, snapshot_age_sec, labels_resolved_at, migrated, peaked_30, peaked_100, peak_pct_max
        FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL
        ORDER BY labels_resolved_at DESC LIMIT 10
      `).all();
      const lastSnapshotTs = recentSnapshots[0]?.snapshot_ts || null;
      const snapshotsLast5min = d.prepare(`SELECT COUNT(*) AS n FROM ml_mint_snapshots WHERE snapshot_ts >= ?`).get(now - 5 * 60 * 1000).n;

      // Alerts
      const alerts = [];
      if (total === 0) alerts.push({ sev: 'high', msg: 'No snapshots yet — collection just starting or sweeper not running' });
      if (snapshotsLast5min === 0 && total > 100) alerts.push({ sev: 'high', msg: 'No snapshots in last 5 min — sweeper may have stopped' });
      const overduePct = total > 0 ? (overdueUnresolved / total) * 100 : 0;
      if (overduePct > 20) alerts.push({ sev: 'med', msg: `${overdueUnresolved} snapshots overdue for label resolution (>12hr unresolved)` });
      for (const f of features) {
        if (f.health === 'bad') alerts.push({ sev: 'med', msg: `Feature "${f.name}" has ${f.null_pct.toFixed(0)}% nulls` });
        else if (f.health === 'warn' && f.unique_count <= 1) alerts.push({ sev: 'low', msg: `Feature "${f.name}" stuck at ${f.unique_count} unique value(s)` });
      }
      if (cvMigRate != null && cvMigRate > 0.6) alerts.push({ sev: 'med', msg: `Migration rate unstable (CV ${(cvMigRate*100).toFixed(0)}%)` });
      if (resolved > 100 && labelStats?.mig_rate > 0.20) alerts.push({ sev: 'med', msg: `Migration rate ${(labelStats.mig_rate*100).toFixed(1)}% suspicious — survivor bias?` });

      // Drift alerts — pull from drift monitor and fold into the same list
      try {
        const { getModelHealth } = await import('../ml/drift-monitor.js');
        const mh = getModelHealth();
        if (mh.freshness?.level === 'red') alerts.push({ sev: 'high', msg: `Retrain stale: ${mh.freshness.message}` });
        else if (mh.freshness?.level === 'yellow') alerts.push({ sev: 'med', msg: `Retrain stale: ${mh.freshness.message}` });
        for (const t of (mh.targets || [])) {
          for (const a of (t.alerts || [])) {
            const sev = a.level === 'red' ? 'high' : 'med';
            alerts.push({ sev, msg: `[drift] ${t.target}: ${a.msg}` });
          }
        }
      } catch (err) { /* drift monitor optional — never let it break /quality */ }

      // Overall grade
      let grade = 'GREEN';
      const highAlerts = alerts.filter(a => a.sev === 'high').length;
      const medAlerts = alerts.filter(a => a.sev === 'med').length;
      if (highAlerts > 0) grade = 'RED';
      else if (medAlerts >= 3) grade = 'RED';
      else if (medAlerts > 0) grade = 'YELLOW';

      res.json({
        asOf: now,
        grade,
        alerts,
        snapshots: {
          total, resolved, unresolved: total - resolved,
          by_age: bucketMap,
          collection_days: +collectionDays.toFixed(2),
          oldest_snapshot_ts: oldestMs,
          rate_per_hr_now: lastHourCount,
          rate_per_hr_avg: avgHourly,
          hourly_volume: hourly,
          daily_volume: daily,
        },
        resolution: {
          resolved_count: resolved,
          avg_lag_hr: resolution?.avg_lag_hr,
          overdue_count: overdueUnresolved,
          resolutions_last_hour: resolutionsLastHour,
        },
        labels: {
          mig_rate_overall: labelStats?.mig_rate || 0,
          peaked_30_rate: labelStats?.p30_rate || 0,
          peaked_100_rate: labelStats?.p100_rate || 0,
          peaked_500_rate: labelStats?.p500_rate || 0,
          peak_pct_max_median: peakMedian,
          peak_pct_max_p95: peakP95,
          mig_rate_by_day: migDayArr,
          cv_mig_rate: cvMigRate,
        },
        features,
        coverage: {
          unique_mints: coverage?.unique_mints || 0,
          unique_creators: coverage?.unique_creators || 0,
          time_of_day_distribution: todArr,
          day_of_week_distribution: dowArr,
          initial_buy_distribution: initialBuyDist,
        },
        recent: {
          last_snapshot_ts: lastSnapshotTs,
          snapshots_last_5min: snapshotsLast5min,
          recent_snapshots: recentSnapshots,
          recent_resolutions: recentResolutions,
        },
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/ml/status', async (req, res) => {
    try {
      const d = db();
      const total = d.prepare(`SELECT COUNT(*) AS n FROM ml_mint_snapshots`).get().n;
      const resolved = d.prepare(`SELECT COUNT(*) AS n FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL`).get().n;
      const buckets = d.prepare(`SELECT snapshot_age_sec, COUNT(*) AS n FROM ml_mint_snapshots GROUP BY snapshot_age_sec`).all();
      const bucketMap = { '60': 0, '300': 0, '900': 0, '3600': 0 };
      for (const b of buckets) bucketMap[String(b.snapshot_age_sec)] = b.n;
      const oldest = d.prepare(`SELECT MIN(snapshot_ts) AS t FROM ml_mint_snapshots`).get();
      const oldestMs = oldest?.t || null;
      const collectionDays = oldestMs ? (Date.now() - oldestMs) / 86400000 : 0;
      // sanity: migration rate in resolved data (should be ~1-3%)
      const migRow = d.prepare(`SELECT AVG(migrated) AS rate FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL`).get();
      const migRate = migRow?.rate || 0;
      const peakedRow = d.prepare(`SELECT AVG(peaked_30) AS p30, AVG(peaked_100) AS p100, AVG(peaked_500) AS p500 FROM ml_mint_snapshots WHERE labels_resolved_at IS NOT NULL`).get();
      // Target for first train: 10K resolved snapshots
      const targetForFirstTrain = 10000;
      const pctToTrain = Math.min(100, (resolved / targetForFirstTrain) * 100);
      const etaDays = collectionDays > 0 && resolved > 0 ? Math.max(0, (targetForFirstTrain - resolved) / (resolved / collectionDays)) : null;
      res.json({
        state: total === 0 ? 'WAITING' : 'COLLECTING',
        totalSnapshots: total,
        resolvedSnapshots: resolved,
        resolvedPct: total > 0 ? resolved / total : 0,
        buckets: bucketMap,
        collectionDays: +collectionDays.toFixed(2),
        oldestSnapshotAt: oldestMs,
        migrationRate: migRate,
        peakedRates: {
          p30: peakedRow?.p30 || 0,
          p100: peakedRow?.p100 || 0,
          p500: peakedRow?.p500 || 0,
        },
        targetForFirstTrain,
        pctToTrain,
        etaDaysToTrain: etaDays != null ? +etaDays.toFixed(1) : null,
        asOf: Date.now(),
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/conditions', async (req, res) => {
    try {
      // Dashboard process is separate from the bot; live-conditions monitor only
      // runs in the bot process. So we read the LATEST snapshot from the DB
      // (written every 60s by the monitor), giving us cross-process access.
      const latest = db().prepare(`SELECT * FROM live_conditions ORDER BY timestamp DESC LIMIT 1`).get();
      const since = Date.now() - 30 * 60 * 1000;
      const history = db().prepare(`SELECT timestamp, rpc_helius_p90, priority_fee_p90, slot_time_mean, network_status FROM live_conditions WHERE timestamp >= ? ORDER BY timestamp ASC`).all(since);

      const overrideMs = config.paper?.latencyMs;
      const liveLatencyMs = latest && latest.rpc_helius_p90 != null ? Math.round(latest.rpc_helius_p90) : null;
      // Realistic paper lag cap: real Solana confirmation is 1-2 slots
      // (400-800ms typical, ~3s worst case in congestion). When the RPC probe
      // returns 5-15s+, that's a PROBE failure (AbortSignal didn't fire fast
      // enough, DNS hang, TLS slow), not real execution latency. A live trader
      // doesn't actually wait 15s for a trade — they get a timeout error or
      // use a different RPC. We cap at 3000ms so paper-trade simulation stays
      // grounded in realistic execution conditions.
      const MAX_REALISTIC_PAPER_LAG_MS = 3000;
      const slotMs = latest?.slot_time_mean || 400;
      // If probe returned anything > 5s, fall back to slot-based estimate
      // (real confirmation = ~2 slots + small client buffer).
      const slotBasedLag = Math.min(Math.round(slotMs * 2 + 300), MAX_REALISTIC_PAPER_LAG_MS);
      const probeReliable = liveLatencyMs != null && liveLatencyMs < 5000;
      const rawLag = (overrideMs != null && overrideMs > 0)
        ? overrideMs
        : (probeReliable ? liveLatencyMs : slotBasedLag);
      const effectivePaperLagMs = Math.min(rawLag, MAX_REALISTIC_PAPER_LAG_MS);
      const effectivePriorityFeeSol = latest && latest.priority_fee_p90 != null ? latest.priority_fee_p90 / 1e9 : 0.0008;
      const ageMs = latest ? Date.now() - latest.timestamp : null;
      // Probes run every 5min now; allow up to 15min stale before declaring down.
      const fresh = ageMs != null && ageMs < 15 * 60 * 1000;

      // Override: if firehose ingestion is healthy (last event <60s ago), the
      // bot is functionally working regardless of RPC probe latency. RPC
      // slowness only matters for live trading. Paper-mode reality check.
      let rawStatus = fresh ? (latest.network_status || 'unknown') : 'down';
      try {
        const h = readHealth();
        const trades = h?.feeds?.onchainTrades;
        if (trades?.connected && (trades.last_event_ago_sec ?? 999) < 60) {
          if (rawStatus === 'down') rawStatus = 'degraded';  // slow RPC + healthy ingest = degraded, not down
          if (rawStatus === 'unknown') rawStatus = 'healthy';
        }
      } catch {}

      res.json({
        status: rawStatus,
        asOf: latest ? latest.timestamp : 0,
        ageMs,
        rpc: {
          helius: { p50: latest?.rpc_helius_p50, p90: latest?.rpc_helius_p90, p99: latest?.rpc_helius_p99, lastSampleAt: latest?.timestamp || 0 },
          public: { p50: latest?.rpc_public_p50, p90: latest?.rpc_public_p90, p99: latest?.rpc_public_p99, lastSampleAt: latest?.timestamp || 0 },
        },
        priorityFee: { p50: latest?.priority_fee_p50, p90: latest?.priority_fee_p90, p99: latest?.priority_fee_p99, asOf: latest?.timestamp || 0 },
        slotTime: { mean: latest?.slot_time_mean, max: latest?.slot_time_max, asOf: latest?.timestamp || 0 },
        effective: {
          paperLagMs: effectivePaperLagMs,
          paperLagSource: (overrideMs != null && overrideMs > 0) ? 'override' : 'live',
          priorityFeeSol: effectivePriorityFeeSol,
        },
        history,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/limits', async (req, res) => {
    const lc = await import('../scoring/live-conditions.js');
    const overrideMs = config.paper?.latencyMs;
    const liveMsRaw = Math.round(lc.getLatencyEstimate('helius'));
    // Cap at realistic Solana fill time (see paper.js MAX_REALISTIC_PAPER_LAG_MS).
    const MAX_REALISTIC = 3000;
    const liveMs = Math.min(liveMsRaw, MAX_REALISTIC);
    const paperLag = overrideMs != null && overrideMs > 0
      ? Math.min(overrideMs, MAX_REALISTIC)
      : liveMs;
    res.json({
      maxPerTradeSol: config.safety?.maxPerTradeSol || 0,
      maxSolExposure: config.strategies?.global?.maxSolExposure || 0,
      maxEntrySlippagePct: config.safety?.maxEntrySlippagePct ?? 0.17,
      paperLatencyMs: paperLag,
      paperLatencyMsSource: overrideMs != null && overrideMs > 0 ? 'override' : 'live',
      liveLatencyMs: liveMs,
      liveLatencyMsRaw: liveMsRaw,  // expose raw too for debugging
      networkStatus: lc.getNetworkStatus(),
    });
  });

  app.post('/api/limits', async (req, res) => {
    try {
      const { maxPerTradeSol, maxSolExposure, maxEntrySlippagePct, paperLatencyMs } = req.body || {};
      const updates = {};
      if (paperLatencyMs != null) {
        const v = Number(paperLatencyMs);
        if (!isFinite(v) || v < 0 || v > 5000) return res.status(400).json({ error: 'paperLatencyMs must be 0 ≤ x ≤ 5000' });
        config.paper = config.paper || {};
        config.paper.latencyMs = v;
        updates.paperLatencyMs = v;
      }
      if (maxPerTradeSol != null) {
        const v = Number(maxPerTradeSol);
        if (!isFinite(v) || v <= 0 || v > 50) return res.status(400).json({ error: 'maxPerTradeSol must be 0 < x ≤ 50' });
        config.safety = config.safety || {};
        config.safety.maxPerTradeSol = v;
        updates.maxPerTradeSol = v;
      }
      if (maxSolExposure != null) {
        const v = Number(maxSolExposure);
        if (!isFinite(v) || v <= 0 || v > 1000) return res.status(400).json({ error: 'maxSolExposure must be 0 < x ≤ 1000' });
        config.strategies.global.maxSolExposure = v;
        updates.maxSolExposure = v;
      }
      if (maxEntrySlippagePct != null) {
        const v = Number(maxEntrySlippagePct);
        if (!isFinite(v) || v < 0 || v > 1) return res.status(400).json({ error: 'maxEntrySlippagePct must be 0 ≤ x ≤ 1 (e.g. 0.17 = 17%)' });
        config.safety = config.safety || {};
        config.safety.maxEntrySlippagePct = v;
        updates.maxEntrySlippagePct = v;
      }
      try {
        const file = path.join(config.publicDir, '..', 'data', 'runtime-limits.json');
        const current = {
          maxPerTradeSol: config.safety.maxPerTradeSol,
          maxSolExposure: config.strategies.global.maxSolExposure,
          maxEntrySlippagePct: config.safety.maxEntrySlippagePct,
          paperLatencyMs: config.paper?.latencyMs ?? 0,
        };
        fs.writeFileSync(file, JSON.stringify(current, null, 2));
      } catch (e) { console.error('[limits] persist failed:', e.message); }
      console.log(`[limits] updated ${JSON.stringify(updates)}`);
      res.json({ ok: true, ...updates });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/safety/status', async (req, res) => {
    try {
      const safety = await import('../trading/safety.js');
      const wallet = await import('../trading/wallet.js');
      let solBalance = null;
      try { if (wallet.isLiveMode()) solBalance = await wallet.getSolBalance(); } catch {}
      const session = wallet.getLiveSession();
      const livePnlSol = (wallet.isLiveMode() && solBalance != null && session.startingSol != null)
        ? solBalance - session.startingSol : null;
      res.json({
        ...safety.getStatus(),
        mode: wallet.getMode(),
        botPubkey: process.env.BOT_PUBKEY || null,
        walletSolBalance: solBalance,
        liveStartedAt: session.startedAt,
        liveStartingSol: session.startingSol,
        livePnlSol,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/mode', async (req, res) => {
    try {
      const wallet = await import('../trading/wallet.js');
      const { mode, confirm } = req.body || {};
      const target = String(mode || '').toLowerCase();
      if (target !== 'live' && target !== 'paper') {
        return res.status(400).json({ error: 'mode must be "live" or "paper"' });
      }
      if (target === 'live' && confirm !== 'LIVE') {
        return res.status(400).json({ error: 'paper→live requires confirm: "LIVE"' });
      }
      if (target === 'live' && !process.env.DEGEN_PRIVATE_KEY) {
        return res.status(400).json({ error: 'DEGEN_PRIVATE_KEY not set — cannot enter live mode' });
      }
      const result = await wallet.setMode(target);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/safety/halt', async (req, res) => {
    try {
      const safety = await import('../trading/safety.js');
      const reason = (req.body && req.body.reason) || 'manual halt';
      safety.halt(reason);
      res.json(safety.getStatus());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/safety/toggle', async (req, res) => {
    try {
      const safety = await import('../trading/safety.js');
      if (safety.isHalted()) safety.resume();
      else safety.halt((req.body && req.body.reason) || 'manual UI toggle');
      res.json(safety.getStatus());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/live/test-buy', async (req, res) => {
    try {
      const { mint, solAmount } = req.body || {};
      if (!mint || !solAmount) return res.status(400).json({ error: 'need {mint, solAmount}' });
      if (solAmount > 0.05) return res.status(400).json({ error: 'test cap: 0.05 SOL max' });
      const exec = await import('../trading/executor.js');
      const r = await exec.executeBuy({ mint, solAmount, strategy: 'manualTest', force: true });
      res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/live/test-sell', async (req, res) => {
    try {
      const { mint, pct } = req.body || {};
      if (!mint || !pct) return res.status(400).json({ error: 'need {mint, pct} where pct is 0-1' });
      const exec = await import('../trading/executor.js');
      const r = await exec.executeSell({ mint, pct, reason: 'manualTest', force: true });
      res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/live/manual-entry', async (req, res) => {
    try {
      const { mint, strategy, solAmount } = req.body || {};
      if (!mint || !strategy || !solAmount) return res.status(400).json({ error: 'need {mint, strategy, solAmount}' });
      const wallet = await import('../trading/wallet.js');
      if (!wallet.isLiveMode()) return res.status(400).json({ error: 'live mode required — flip mode first' });
      const d = db();
      const m = d.prepare('SELECT * FROM mints WHERE mint_address = ?').get(mint);
      if (!m) return res.status(404).json({ error: 'mint not found in DB' });
      if (!m.last_price_sol || m.last_price_sol <= 0) return res.status(400).json({ error: 'no current price for mint' });
      const strat = d.prepare('SELECT * FROM strategy_state WHERE name = ?').get(strategy);
      if (!strat) return res.status(404).json({ error: 'strategy not found' });
      if (!strat.enabled) return res.status(400).json({ error: 'strategy is disabled' });
      const cap = (await import('../config.js')).config.safety?.maxPerTradeSol || 0.5;
      if (solAmount > cap) return res.status(400).json({ error: `solAmount ${solAmount} > maxPerTradeSol ${cap}` });
      const paper = await import('../trading/paper.js');
      const positionId = paper.openPaperPosition({
        strategy,
        mintAddress: mint,
        entryPrice: m.last_price_sol,
        entrySol: solAmount,
        entryMcap: m.current_market_cap_sol || 0,
        signalDetails: { type: 'MANUAL_ENTRY', triggeredBy: 'api' },
        entryScore: 1.0,
      });
      res.json({
        success: true,
        positionId,
        mint,
        strategy,
        solAmount,
        entryPrice: m.last_price_sol,
        note: 'placeholder row inserted; live buy tx fires async — check positions tab',
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/safety/resume', async (req, res) => {
    try {
      const safety = await import('../trading/safety.js');
      safety.resume();
      res.json(safety.getStatus());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/skim/status', async (req, res) => {
    try {
      const skim = await import('../trading/skim.js');
      res.json(skim.getSkimStatus());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/skim/trigger', async (req, res) => {
    try {
      const skim = await import('../trading/skim.js');
      const r = await skim.checkAndSkim('manual-api');
      res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Phase C sentiment dashboard endpoints — read-only views over data the
  // sentiment-scorer worker writes every 15 min. /api/sentiment/overview is
  // the single round-trip the dashboard uses; the others are convenience.
  app.get('/api/sentiment/overview', (req, res) => {
    try {
      const d = db();
      const now = Date.now();
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const FOUR_HOURS = 4 * 60 * 60 * 1000;
      const currentWindow = Math.floor(now / FOUR_HOURS) * FOUR_HOURS;
      // Run history: last 24h
      const runs = d.prepare(`
        SELECT run_id, started_at, finished_at, items_in, items_scored,
               claude_calls, input_chars, output_chars, duration_ms, status, error
        FROM sentiment_runs
        WHERE started_at > ?
        ORDER BY started_at DESC LIMIT 50
      `).all(dayAgo);
      // Usage totals
      const totals = d.prepare(`
        SELECT
          COALESCE(SUM(claude_calls), 0) AS calls_24h,
          COALESCE(SUM(items_scored), 0) AS items_scored_24h,
          COALESCE(SUM(input_chars), 0) AS in_chars_24h,
          COALESCE(SUM(output_chars), 0) AS out_chars_24h
        FROM sentiment_runs
        WHERE started_at > ?
      `).get(dayAgo);
      // Top mints in current 4h window (with mint metadata)
      const mints = d.prepare(`
        SELECT s.mint_address, m.symbol, m.name,
               s.bull_mentions, s.bear_mentions, s.shill_mentions,
               s.fud_mentions, s.neutral_mentions, s.total_mentions,
               s.sum_confidence, s.last_updated_at,
               m.current_market_cap_sol, m.peak_market_cap_sol
        FROM mint_sentiment s
        LEFT JOIN mints m ON m.mint_address = s.mint_address
        WHERE s.window_start = ?
        ORDER BY s.total_mentions DESC LIMIT 50
      `).all(currentWindow);
      // Top narratives in current 4h window
      const narratives = d.prepare(`
        SELECT theme,
               bull_mentions, bear_mentions, shill_mentions,
               fud_mentions, neutral_mentions, total_mentions,
               sum_confidence, last_updated_at
        FROM narrative_sentiment
        WHERE window_start = ?
        ORDER BY total_mentions DESC LIMIT 30
      `).all(currentWindow);
      // Recent per-post Claude scores — most-recent first. Lets you spot-check
      // whether the worker is producing sane sentiment + ticker extraction.
      const items = d.prepare(`
        SELECT scored_at, source, post_text, tickers_json, sentiment,
               confidence, themes_json
        FROM sentiment_items
        WHERE scored_at > ?
        ORDER BY scored_at DESC LIMIT 50
      `).all(dayAgo);
      // System-wide Claude usage. Each row is a logical Claude caller
      // (subsystem or category) with its last-24h call count and most-recent
      // timestamp. The sentiment-scorer logs to its own sentiment_runs table;
      // every other agent module logs into ml_agent_log under a category.
      const agentLogStats = d.prepare(`
        SELECT category, COUNT(*) AS n, MAX(timestamp) AS most_recent
        FROM ml_agent_log
        WHERE timestamp > ?
          AND category IN ('consult','mint-intel','post-mortem','market-regime',
                           'daily-report','calibration-review','news-synth',
                           'concentration-check')
        GROUP BY category
      `).all(dayAgo);
      const agentMap = Object.fromEntries(agentLogStats.map(r => [r.category, r]));
      const sentTotals = totals;
      const claudeCallers = [
        { module: 'sentiment-scorer', label: 'Sentiment scoring',
          cadence: 'every 15min · cap 300/day',
          calls_24h: sentTotals.calls_24h || 0,
          last_at: (runs[0]?.started_at) || null },
        { module: 'agent.consult', label: 'Strategy consult (propose/retire/keep)',
          cadence: 'every 30min · cap 55/day',
          calls_24h: agentMap['consult']?.n || 0,
          last_at: agentMap['consult']?.most_recent || null },
        { module: 'agent.mint-intel', label: 'Mint intel — deep dive per coin',
          cadence: 'hourly batch',
          calls_24h: agentMap['mint-intel']?.n || 0,
          last_at: agentMap['mint-intel']?.most_recent || null },
        { module: 'agent.post-mortem', label: 'Post-mortem — analyze losing trades',
          cadence: 'every 30min if positions ready',
          calls_24h: agentMap['post-mortem']?.n || 0,
          last_at: agentMap['post-mortem']?.most_recent || null },
        { module: 'agent.market-regime', label: 'Market regime detection',
          cadence: 'noon + midnight ET',
          calls_24h: agentMap['market-regime']?.n || 0,
          last_at: agentMap['market-regime']?.most_recent || null },
        { module: 'agent.news-synth', label: 'News meta-synthesis',
          cadence: 'every ~4h',
          calls_24h: agentMap['news-synth']?.n || 0,
          last_at: agentMap['news-synth']?.most_recent || null },
        { module: 'agent.concentration-check', label: 'Concentration / exit-risk audit',
          cadence: 'every 6h if threshold met',
          calls_24h: agentMap['concentration-check']?.n || 0,
          last_at: agentMap['concentration-check']?.most_recent || null },
        { module: 'agent.daily-report', label: 'Daily report',
          cadence: 'once per 24h',
          calls_24h: agentMap['daily-report']?.n || 0,
          last_at: agentMap['daily-report']?.most_recent || null },
        { module: 'agent.calibration-review', label: 'Model calibration review',
          cadence: 'once per 24h',
          calls_24h: agentMap['calibration-review']?.n || 0,
          last_at: agentMap['calibration-review']?.most_recent || null },
      ];
      const claudeTotal24h = claudeCallers.reduce((s, c) => s + (c.calls_24h || 0), 0);
      res.json({
        now, current_window: currentWindow,
        totals, runs, mints, narratives, items,
        claude_callers: claudeCallers,
        claude_total_24h: claudeTotal24h,
      });
    } catch (err) {
      console.error('[api] /api/sentiment/overview err:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/system', (req, res) => {
    try {
      const d = db();
      const win = String(req.query.window || '6');
      const cutoff = win === 'all' ? 0 : Date.now() - parseFloat(win) * 60 * 60 * 1000;
      const closedWhere = `status='closed' AND exited_at >= ${cutoff}`;

      const kpiRow = d.prepare(`
        SELECT
          COUNT(*) AS trades,
          COALESCE(SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END), 0) AS wins,
          COALESCE(SUM(CASE WHEN realized_pnl_sol <= 0 THEN 1 ELSE 0 END), 0) AS losses,
          COALESCE(AVG(realized_pnl_pct), 0) AS avg_pnl_pct,
          COALESCE(AVG((exited_at-entered_at)/60000.0), 0) AS avg_hold_min,
          COALESCE(SUM(realized_pnl_sol), 0) AS net_sol,
          COALESCE(MAX(realized_pnl_pct), 0) AS best_pct,
          COALESCE(MIN(realized_pnl_pct), 0) AS worst_pct
        FROM paper_positions WHERE ${closedWhere}
      `).get();

      let drawdown = 0;
      const series = d.prepare(`SELECT realized_pnl_sol FROM paper_positions WHERE ${closedWhere} ORDER BY exited_at ASC`).all();
      let running = 0, peak = 0;
      for (const r of series) {
        running += (r.realized_pnl_sol || 0);
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > drawdown) drawdown = dd;
      }

      const exits = d.prepare(`
        SELECT exit_reason, COUNT(*) AS n,
          ROUND(AVG(realized_pnl_pct)*100, 1) AS avg_pnl,
          ROUND(AVG(highest_pct)*100, 1) AS avg_peak,
          ROUND(AVG((exited_at-entered_at)/60000.0), 1) AS avg_hold_min,
          ROUND(SUM(realized_pnl_sol), 4) AS net_sol
        FROM paper_positions WHERE ${closedWhere}
        GROUP BY exit_reason ORDER BY ABS(SUM(realized_pnl_sol)) DESC
      `).all();

      const strategies = d.prepare(`
        SELECT strategy, COUNT(*) AS trades,
          SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN realized_pnl_sol <= 0 THEN 1 ELSE 0 END) AS losses,
          ROUND(100.0 * SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr,
          ROUND(SUM(realized_pnl_sol), 4) AS net_sol,
          ROUND(AVG(realized_pnl_pct)*100, 1) AS avg_pnl
        FROM paper_positions WHERE ${closedWhere}
        GROUP BY strategy ORDER BY net_sol DESC
      `).all();

      const wallets = d.prepare(`
        SELECT
          json_extract(pp.entry_signal, '$.wallet') AS wallet,
          COUNT(*) AS copied,
          SUM(CASE WHEN pp.realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN pp.realized_pnl_sol <= 0 THEN 1 ELSE 0 END) AS losses,
          ROUND(100.0 * SUM(CASE WHEN pp.realized_pnl_sol > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr,
          ROUND(AVG(pp.realized_pnl_pct)*100, 1) AS avg_pnl,
          ROUND(SUM(pp.realized_pnl_sol), 4) AS net_sol,
          MAX(w.is_kol) AS is_kol,
          MAX(w.category) AS category
        FROM paper_positions pp
        LEFT JOIN wallets w ON w.address = json_extract(pp.entry_signal, '$.wallet')
        WHERE pp.strategy = 'trackedWalletFollow' AND pp.status='closed' AND pp.exited_at >= ${cutoff}
        GROUP BY wallet HAVING wallet IS NOT NULL
        ORDER BY net_sol DESC
      `).all();

      const mcap = d.prepare(`
        SELECT
          CASE
            WHEN entry_mcap_sol < 30 THEN 'A: <30 SOL'
            WHEN entry_mcap_sol < 60 THEN 'B: 30-60'
            WHEN entry_mcap_sol < 120 THEN 'C: 60-120'
            WHEN entry_mcap_sol < 200 THEN 'D: 120-200'
            ELSE 'E: 200+ SOL'
          END AS bucket,
          COUNT(*) AS trades,
          SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
          ROUND(100.0 * SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr,
          ROUND(AVG(realized_pnl_pct)*100, 1) AS avg_pnl,
          ROUND(SUM(realized_pnl_sol), 4) AS net_sol
        FROM paper_positions WHERE ${closedWhere}
        GROUP BY bucket ORDER BY bucket
      `).all();

      const hours = d.prepare(`
        SELECT
          CAST(strftime('%H', entered_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
          COUNT(*) AS trades,
          SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
          ROUND(100.0 * SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr,
          ROUND(SUM(realized_pnl_sol), 4) AS net_sol
        FROM paper_positions WHERE ${closedWhere}
        GROUP BY hour ORDER BY hour
      `).all();

      res.json({
        window: win,
        kpis: { ...kpiRow, drawdown, wr: kpiRow.trades ? +(100 * kpiRow.wins / kpiRow.trades).toFixed(1) : 0 },
        exits, strategies, wallets, mcap, hours,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/db/prune', (req, res) => {
    try {
      const r = pruneTrades();
      const v = vacuumDb();
      res.json({ ...r, vacuumFreed: v.freed, sizeBefore: v.before, sizeAfter: v.after });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(config.port, '127.0.0.1', () => {
    console.log(`[degen-club] dashboard live on http://localhost:${config.port} (loopback-bound; cloudflared OK; LAN locked)`);
  });
}
