import { db } from '../db/index.js';
import { config } from '../config.js';
import { onCopySignal } from '../trading/strategies.js';

let cached = null;
function S() {
  if (cached) return cached;
  const d = db();
  cached = {
    activeWallets: d.prepare(`
      SELECT DISTINCT wallet FROM wallet_holdings
      WHERE last_activity_at > ?
    `),
    allWallets: d.prepare('SELECT address FROM wallets'),
    walletInfo: d.prepare('SELECT trade_count, buy_count, sniper_count, first_block_count, bundle_cluster_id, manually_tracked FROM wallets WHERE address = ?'),
    snipeStats: d.prepare(`SELECT
      COUNT(*) AS buy_count,
      SUM(CASE WHEN seconds_from_creation <= ? THEN 1 ELSE 0 END) AS sniper_count,
      SUM(CASE WHEN seconds_from_creation <= ? OR (buyer_rank IS NOT NULL AND buyer_rank <= ?) THEN 1 ELSE 0 END) AS first_block_count
      FROM trades WHERE wallet = ? AND is_buy = 1`),
    holdings: d.prepare(`
      SELECT wh.*, m.last_price_sol, m.current_market_cap_sol, m.created_at AS mint_created_at, m.migrated
      FROM wallet_holdings wh
      LEFT JOIN mints m ON m.mint_address = wh.mint_address
      WHERE wh.wallet = ?
    `),
    updateWallet: d.prepare(`UPDATE wallets SET
      realized_pnl = ?, unrealized_pnl = ?, realized_pnl_30d = ?,
      position_count = ?, closed_position_count = ?, closed_30d = ?,
      win_count = ?, loss_count = ?, win_rate = ?,
      win_count_30d = ?, win_rate_30d = ?,
      best_coin_pnl = ?, worst_coin_pnl = ?,
      avg_hold_seconds = ?, sniper_ratio = ?, first_block_ratio = ?,
      trades_per_position = ?, graduated_touched = ?,
      sell_100pct_count = ?, sell_100pct_ratio = ?,
      category = ?, bot_flags = ?, copy_friendly = ?,
      tracked = ?, is_kol = ?,
      last_activity_at = ?
      WHERE address = ?`),
    setTrackedSince: d.prepare(`UPDATE wallets SET tracked_since = ? WHERE address = ? AND tracked_since IS NULL`),
    setKolSince: d.prepare(`UPDATE wallets SET kol_since = ? WHERE address = ? AND kol_since IS NULL`),
    trackedBuyersOnMint: d.prepare(`
      SELECT DISTINCT t.wallet, MIN(t.timestamp) AS first_buy_at, MIN(t.buyer_rank) AS first_rank
      FROM trades t
      JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? AND t.is_buy = 1 AND w.tracked = 1
      GROUP BY t.wallet
    `),
    recentCopySignal: d.prepare(`
      SELECT id FROM copy_signals
      WHERE mint_address = ? AND fired_at > ?
      ORDER BY fired_at DESC LIMIT 1
    `),
    insertCopySignal: d.prepare(`
      INSERT INTO copy_signals (mint_address, fired_at, wallet_count, time_span_seconds, tracked_wallets, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    mintAge: d.prepare('SELECT created_at FROM mints WHERE mint_address = ?'),
  };
  return cached;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function recomputeWallet(address) {
  const s = S();
  const rows = s.holdings.all(address);
  if (!rows.length) return;

  const now = Date.now();
  const cutoff30d = now - config.traders.rollingDays * DAY_MS;

  let realized = 0, unrealized = 0;
  let realized30d = 0;
  let closed = 0, closed30d = 0;
  let wins = 0, losses = 0, wins30d = 0;
  let best = 0, worst = 0;
  let holdSeconds = 0, holdSamples = 0;
  let lastActivity = 0;
  let graduatedTouched = 0;
  let sell100pctCount = 0;

  for (const h of rows) {
    const bought = h.tokens_bought || 0;
    const sold = h.tokens_sold || 0;
    const invested = h.sol_invested || 0;
    const out = h.sol_realized || 0;
    if (bought <= 0) continue;

    const soldFrac = Math.min(sold / bought, 1);
    const allocatedCost = invested * soldFrac;
    const realizedThis = out - allocatedCost;
    realized += realizedThis;

    const remainingTokens = Math.max(0, bought - sold);
    const remainingCost = invested * (1 - soldFrac);
    const price = h.last_price_sol || 0;
    const markValue = remainingTokens * price;
    const unrealizedThis = markValue - remainingCost;
    unrealized += unrealizedThis;

    if (realizedThis > best) best = realizedThis;
    if (realizedThis < worst) worst = realizedThis;

    const isClosed = soldFrac >= config.traders.fullExitPctThreshold;
    if (isClosed) {
      closed++;
      if (realizedThis > 0) wins++;
      else if (realizedThis < 0) losses++;
      const holdMs = (h.first_buy_at && h.last_activity_at) ? Math.max(0, h.last_activity_at - h.first_buy_at) : 0;
      if (holdMs > 0) {
        holdSeconds += holdMs / 1000;
        holdSamples++;
      }
      if (holdMs <= config.bot.sell100PctMaxSec * 1000) sell100pctCount++;

      if (h.last_activity_at && h.last_activity_at >= cutoff30d) {
        closed30d++;
        realized30d += realizedThis;
        if (realizedThis > 0) wins30d++;
      }
    }
    if (h.last_activity_at && h.last_activity_at > lastActivity) lastActivity = h.last_activity_at;
    if (h.migrated) graduatedTouched++;
  }

  const winRate = closed ? wins / closed : 0;
  const winRate30d = closed30d ? wins30d / closed30d : 0;
  const avgHold = holdSamples ? Math.round(holdSeconds / holdSamples) : 0;
  const sell100pctRatio = closed ? sell100pctCount / closed : 0;

  const info = s.walletInfo.get(address) || { trade_count: 0, buy_count: 0, sniper_count: 0, first_block_count: 0, bundle_cluster_id: null, manually_tracked: 0 };
  const tradeCount = info.trade_count || 0;
  const live = s.snipeStats.get(config.sniper.secondsWindow, config.sniper.firstBlockMaxSeconds, config.sniper.firstBlockMaxRank, address) || { buy_count: 0, sniper_count: 0, first_block_count: 0 };
  const buyCount = live.buy_count || info.buy_count || 0;
  const sniperRatio = buyCount > 0 ? (live.sniper_count || 0) / buyCount : 0;
  const firstBlockRatio = buyCount > 0 ? (live.first_block_count || 0) / buyCount : 0;
  const positionCount = rows.length;
  const tradesPerPosition = positionCount > 0 ? tradeCount / positionCount : 0;

  const ctx = {
    closed, winRate, avgHold, sniperRatio, firstBlockRatio,
    tradesPerPosition, buyCount, tradeCount,
    bundleClusterId: info.bundle_cluster_id,
    sell100pctRatio,
  };
  const { category, flags, copyFriendly } = classify(ctx);

  const t = config.traders;
  const qualifies =
    closed30d >= t.minClosedPositions &&
    realized30d >= t.minRealizedPnlSol &&
    winRate30d >= t.minWinRate &&
    sniperRatio <= t.maxSniperRatio &&
    graduatedTouched >= t.minGraduatedTouched;

  const tracked = info.manually_tracked ? 1 : (qualifies ? 1 : 0);

  const k = t.kol;
  const isKolQualifies =
    qualifies &&
    closed30d >= k.minClosed30d &&
    realized30d >= k.minRealizedPnl30d &&
    winRate30d >= k.minWinRate30d &&
    graduatedTouched >= k.minGraduatedTouched &&
    sniperRatio <= k.maxSniperRatio;
  const isKol = isKolQualifies ? 1 : 0;

  s.updateWallet.run(
    realized, unrealized, realized30d,
    positionCount, closed, closed30d,
    wins, losses, winRate,
    wins30d, winRate30d,
    best, worst,
    avgHold, sniperRatio, firstBlockRatio,
    tradesPerPosition, graduatedTouched,
    sell100pctCount, sell100pctRatio,
    category, JSON.stringify(flags), copyFriendly ? 1 : 0,
    tracked, isKol,
    lastActivity || now,
    address
  );

  if (tracked) s.setTrackedSince.run(now, address);
  if (isKol) s.setKolSince.run(now, address);
}

function classify(ctx) {
  const b = config.bot;
  const flags = [];

  if (ctx.bundleClusterId) {
    return { category: 'BUNDLE', flags: ['BUNDLE_MEMBER'], copyFriendly: false };
  }

  if (ctx.tradesPerPosition >= b.scalperTradesPerPosition && ctx.tradeCount >= b.scalperMinTrades) flags.push('SCALPER');
  if (ctx.sniperRatio >= b.snipeHeavyMinRatio && ctx.buyCount >= b.snipeHeavyMinBuys) flags.push('SNIPE_HEAVY');
  if (ctx.avgHold > 0 && ctx.avgHold < b.fastHandsMaxHoldSec && ctx.closed >= b.fastHandsMinClosed) flags.push('FAST_HANDS');
  if (ctx.winRate >= b.perfectWrThreshold && ctx.closed >= b.perfectWrMinClosed) flags.push('PERFECT_WR');
  if (ctx.firstBlockRatio >= 0.5 && ctx.buyCount >= 5) flags.push('FIRST_BLOCK_HEAVY');
  if (ctx.sell100pctRatio >= 0.7 && ctx.closed >= 5) flags.push('SERIAL_DUMPER');

  let category;
  if (flags.includes('SCALPER')) category = 'SCALPER';
  else if (flags.length) category = 'BOT';
  else if (
    ctx.closed >= b.humanMinClosed &&
    ctx.avgHold >= b.humanMinAvgHoldSec &&
    ctx.tradesPerPosition <= b.humanMaxTradesPerPosition &&
    ctx.sniperRatio < b.humanMaxSniperRatio &&
    ctx.winRate <= b.humanMaxWinRate &&
    ctx.winRate >= b.humanMinWinRate
  ) category = 'HUMAN';
  else category = 'NOT_SURE';

  const copyFriendly = ctx.avgHold >= b.copyFriendlyMinHoldSec;
  return { category, flags, copyFriendly };
}

export function recomputeAllWallets() {
  const s = S();
  const since = Date.now() - config.traders.recomputeIntervalMs * 5;
  const rows = s.activeWallets.all(since);
  for (const r of rows) {
    try { recomputeWallet(r.wallet); } catch (err) { console.error('[traders]', err.message); }
  }
  return rows.length;
}

export function recomputeEveryWallet() {
  const s = S();
  const all = s.allWallets.all();
  for (const r of all) {
    try { recomputeWallet(r.address); } catch {}
  }
  return all.length;
}

export function startTraderSweep() {
  setTimeout(() => {
    try {
      const n = recomputeEveryWallet();
      console.log(`[traders] initial classification: ${n} wallets`);
    } catch (err) {
      console.error('[traders] initial sweep', err.message);
    }
  }, 5000);

  setInterval(() => {
    try {
      const n = recomputeAllWallets();
      if (n > 0) console.log(`[traders] recomputed ${n} active wallets`);
    } catch (err) {
      console.error('[traders] sweep', err.message);
    }
  }, config.traders.recomputeIntervalMs);
}

export function checkCopySignal(mintAddress) {
  const s = S();
  const mint = s.mintAge.get(mintAddress);
  if (!mint) return;

  const ageMin = (Date.now() - mint.created_at) / 60000;
  if (ageMin > config.copySignal.maxMintAgeMinutes) return;

  const buyers = s.trackedBuyersOnMint.all(mintAddress);
  if (buyers.length < config.copySignal.minTrackedWallets) return;

  const eligible = buyers.filter(b => (b.first_rank || 0) >= config.copySignal.minBuyerRank);
  if (eligible.length < config.copySignal.minTrackedWallets) return;

  const times = eligible.map(b => b.first_buy_at).sort((a, b) => a - b);
  const span = (times[times.length - 1] - times[0]) / 1000;
  if (span > config.copySignal.windowSeconds) return;

  const dedupeSince = Date.now() - config.copySignal.dedupeMinutes * 60000;
  const recent = s.recentCopySignal.get(mintAddress, dedupeSince);
  if (recent) return;

  const wallets = eligible.map(b => b.wallet);
  s.insertCopySignal.run(
    mintAddress,
    Date.now(),
    wallets.length,
    span,
    JSON.stringify(wallets),
    JSON.stringify({ windowSec: config.copySignal.windowSeconds, ageMin: +ageMin.toFixed(1), minBuyerRank: config.copySignal.minBuyerRank })
  );
  console.log(`[copy-signal] ${mintAddress.slice(0, 8)}… ${wallets.length} tracked wallets in ${span.toFixed(1)}s`);
  onCopySignal(mintAddress, wallets.length);
}
