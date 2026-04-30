import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { exec as childExec } from 'node:child_process';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { getSolUsd, getPriceLastUpdate } from '../price.js';
import { dbStats, pruneTrades, vacuumDb } from '../maintenance.js';
import { listStrategies, toggleStrategy, updateStrategySettings } from '../trading/strategies.js';
import { getHolderStats } from '../scoring/holders.js';
import { backtestAll } from '../trading/backtest.js';

const isLocalOrigin = (s) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(s || '');

function requireLocalOriginForMutations(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (process.env.ALLOW_REMOTE_WRITES === '1') return next();
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

  try {
    const file = path.join(config.publicDir, '..', 'data', 'runtime-limits.json');
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof saved.maxPerTradeSol === 'number' && saved.maxPerTradeSol > 0) {
        config.safety = config.safety || {};
        config.safety.maxPerTradeSol = saved.maxPerTradeSol;
      }
      if (typeof saved.maxSolExposure === 'number' && saved.maxSolExposure > 0) {
        config.strategies.global.maxSolExposure = saved.maxSolExposure;
      }
      if (typeof saved.maxEntrySlippagePct === 'number' && saved.maxEntrySlippagePct >= 0 && saved.maxEntrySlippagePct <= 1) {
        config.safety = config.safety || {};
        config.safety.maxEntrySlippagePct = saved.maxEntrySlippagePct;
      }
      if (typeof saved.paperLatencyMs === 'number' && saved.paperLatencyMs >= 0 && saved.paperLatencyMs <= 5000) {
        config.paper = config.paper || {};
        config.paper.latencyMs = saved.paperLatencyMs;
      }
      console.log(`[limits] loaded persisted: maxPerTradeSol=${config.safety.maxPerTradeSol} maxSolExposure=${config.strategies.global.maxSolExposure} maxEntrySlippagePct=${config.safety.maxEntrySlippagePct} paperLatencyMs=${config.paper?.latencyMs ?? 0}`);
    }
  } catch (e) { console.error('[limits] load failed:', e.message); }

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
    const totalTrades = d.prepare("SELECT COUNT(*) AS n FROM trades").get().n;
    const totalWallets = d.prepare("SELECT COUNT(*) AS n FROM wallets").get().n;
    const trackedWallets = d.prepare("SELECT COUNT(*) AS n FROM wallets WHERE tracked = 1").get().n;
    const kolWallets = d.prepare("SELECT COUNT(*) AS n FROM wallets WHERE is_kol = 1").get().n;
    const copySignals = d.prepare("SELECT COUNT(*) AS n FROM copy_signals").get().n;
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
      SELECT COALESCE(SUM(pp.entry_sol - pp.sol_realized_so_far), 0) AS locked,
             COALESCE(SUM(pp.tokens_remaining * COALESCE(m.last_price_sol, pp.entry_price)), 0) AS mtm,
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

    res.json({
      mode: isLive ? 'live' : 'paper',
      openPositions, closedPositions, wins,
      winRate: closedPositions ? wins / closedPositions : 0,
      realizedPnlSol: pnl,
      totalMints, totalTrades, totalWallets, trackedWallets, kolWallets, copySignals, volumeSignals, bundleClusters,
      uniqueMintsTraded, incinerateSol,
      cashbackEstimatedSol, cashbackPositions,
      ingestion,
      solUsd: getSolUsd(),
      priceUpdatedAt: getPriceLastUpdate(),
      sim,
      live,
    });
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

  app.get('/api/exits/analysis', (req, res) => {
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
    res.json({ summary, rows });
  });

  app.get('/api/rejections/missed', (req, res) => {
    const d = db();
    const rows = d.prepare(`
      SELECT
        gr.mint_address, gr.first_rejected_at, gr.last_rejected_at, gr.reject_count,
        gr.reason, gr.reason_detail, gr.signal_type, gr.mcap_at_reject,
        m.symbol, m.name, m.peak_market_cap_sol, m.current_market_cap_sol,
        m.migrated, m.rugged, m.flags,
        CASE WHEN gr.mcap_at_reject > 0
          THEN (m.peak_market_cap_sol - gr.mcap_at_reject) / gr.mcap_at_reject
          ELSE 0 END AS peak_pct_after,
        CASE WHEN gr.mcap_at_reject > 0
          THEN (m.current_market_cap_sol - gr.mcap_at_reject) / gr.mcap_at_reject
          ELSE 0 END AS current_pct_after,
        CASE
          WHEN gr.mcap_at_reject <= 0 THEN 'PENDING'
          WHEN m.peak_market_cap_sol >= gr.mcap_at_reject * 2 THEN 'BIG_WIN'
          WHEN m.peak_market_cap_sol >= gr.mcap_at_reject * 1.3 THEN 'WIN'
          ELSE 'LOSS'
        END AS outcome
      FROM gate_rejections gr
      LEFT JOIN mints m ON m.mint_address = gr.mint_address
      ORDER BY peak_pct_after DESC
      LIMIT 200
    `).all();
    for (const r of rows) {
      try { r.flags = JSON.parse(r.flags || '[]'); } catch { r.flags = []; }
    }
    const summary = d.prepare(`
      SELECT reason, COUNT(*) AS n FROM gate_rejections GROUP BY reason ORDER BY n DESC
    `).all();
    res.json({ rejections: rows, summary });
  });

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
      const findKingExit = d.prepare(`
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
        let kingComparison = null;
        if (trackedWallet) {
          const k = findKingExit.get(p.mint_address, trackedWallet, p.entered_at);
          if (k && k.sell_count > 0) {
            const kingExitProceeds = Math.max(0, liveTokens * (k.best_sell_price || 0) * (1 - slip) * (1 - fee) - priority);
            kingComparison = {
              wallet: trackedWallet,
              their_best_sell_price: k.best_sell_price,
              their_last_sell_at: k.last_sell_at,
              their_sell_count: k.sell_count,
              their_total_sold_sol: k.total_sold,
              if_we_matched_their_top_pnl: kingExitProceeds - p.entry_sol,
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
          king_comparison: kingComparison,
        };
      });

      const byStrat = {};
      for (const t of trades) {
        const s = byStrat[t.strategy] || (byStrat[t.strategy] = {
          n: 0, paper_net: 0, live_net: 0,
          paper_wins: 0, live_wins: 0,
          we_beat_king: 0, king_beat_us: 0, king_pairs: 0,
          king_first_pnl_total: 0,
        });
        s.n++;
        s.paper_net += t.paper_pnl;
        s.live_net += t.live_sim_pnl;
        if (t.paper_pnl > 0) s.paper_wins++;
        if (t.live_sim_pnl > 0) s.live_wins++;
        if (t.king_comparison) {
          s.king_pairs++;
          s.king_first_pnl_total += t.king_comparison.if_we_matched_their_top_pnl;
          if (t.live_sim_pnl > t.king_comparison.if_we_matched_their_top_pnl) s.we_beat_king++;
          else s.king_beat_us++;
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
        king_pairs: s.king_pairs,
        we_beat_their_top_n: s.we_beat_king,
        their_top_beat_us_n: s.king_beat_us,
        avg_potential_per_trade_if_perfect_king_top: s.king_pairs > 0 ? s.king_first_pnl_total / s.king_pairs : null,
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
      const { name, label, description, trigger, sourceFilter, mcCeiling, mcFloor, defaults, kingWallets, kingSellExitThreshold } = req.body || {};
      if (!name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        return res.status(400).json({ error: 'name must be camelCase identifier' });
      }
      const file = path.join(config.publicDir, '..', 'src', 'strategies', `${name}.js`);
      if (fs.existsSync(file)) return res.status(409).json({ error: `${name} already exists — use PUT to update` });
      const cfg = { label: label || name, description: description || '', trigger: trigger || 'smart_trade' };
      if (sourceFilter) cfg.sourceFilter = sourceFilter;
      if (typeof mcCeiling === 'number') cfg.mcCeiling = mcCeiling;
      if (typeof mcFloor === 'number') cfg.mcFloor = mcFloor;
      if (Array.isArray(kingWallets) && kingWallets.length) cfg.kingWallets = kingWallets;
      if (typeof kingSellExitThreshold === 'number') cfg.kingSellExitThreshold = kingSellExitThreshold;
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
      const { label, description, trigger, sourceFilter, mcCeiling, mcFloor, defaults, kingWallets, kingSellExitThreshold } = req.body || {};
      const cfg = { label: label || name, description: description || '', trigger: trigger || 'smart_trade' };
      if (sourceFilter) cfg.sourceFilter = sourceFilter;
      if (typeof mcCeiling === 'number') cfg.mcCeiling = mcCeiling;
      if (typeof mcFloor === 'number') cfg.mcFloor = mcFloor;
      if (Array.isArray(kingWallets) && kingWallets.length) cfg.kingWallets = kingWallets;
      if (typeof kingSellExitThreshold === 'number') cfg.kingSellExitThreshold = kingSellExitThreshold;
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

  app.get('/api/preking/stats', async (req, res) => {
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

  app.post('/api/preking/stats/reset', async (req, res) => {
    try {
      const cv = await import('../scoring/coin-velocity.js');
      cv.resetProfileStats();
      res.json({ ok: true, resetAt: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/limits', (req, res) => {
    res.json({
      maxPerTradeSol: config.safety?.maxPerTradeSol || 0,
      maxSolExposure: config.strategies?.global?.maxSolExposure || 0,
      maxEntrySlippagePct: config.safety?.maxEntrySlippagePct ?? 0.17,
      paperLatencyMs: config.paper?.latencyMs ?? 0,
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
