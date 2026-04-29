import { config } from '../config.js';
import { db } from '../db/index.js';

const _kingActivity = new Map();

function kingWalletSet() {
  const list = config.strategies.kingFollow?.kingWallets || [];
  return new Set(list);
}

export function isKingWallet(address) {
  return kingWalletSet().has(address);
}

export function onTrade(trade) {
  if (!trade?.wallet || !trade?.mint) return;
  if (!isKingWallet(trade.wallet)) return;
  const key = `${trade.wallet}:${trade.mint}`;
  let entry = _kingActivity.get(key);
  if (!entry) {
    entry = { firstBuyAt: null, totalBoughtSol: 0, totalSoldSol: 0, sellCount: 0, lastUpdate: 0 };
    _kingActivity.set(key, entry);
  }
  if (trade.is_buy) {
    if (!entry.firstBuyAt) entry.firstBuyAt = trade.timestamp;
    entry.totalBoughtSol += trade.sol_amount || 0;
  } else {
    entry.totalSoldSol += trade.sol_amount || 0;
    entry.sellCount += 1;
  }
  entry.lastUpdate = trade.timestamp;
}

export function kingHasBoughtSince(mintAddress, ourEntryTimestamp) {
  for (const wallet of kingWalletSet()) {
    const entry = _kingActivity.get(`${wallet}:${mintAddress}`);
    if (!entry || !entry.firstBuyAt) continue;
    if (entry.firstBuyAt > ourEntryTimestamp) {
      return { wallet, kingBuyAt: entry.firstBuyAt, boughtSol: entry.totalBoughtSol };
    }
  }
  return null;
}

export function shouldForceExit(mintAddress, ourEntryTimestamp) {
  const threshold = config.strategies.kingFollow?.kingSellExitThreshold ?? 0.5;
  for (const wallet of kingWalletSet()) {
    const entry = _kingActivity.get(`${wallet}:${mintAddress}`);
    if (!entry || !entry.firstBuyAt) continue;
    if (entry.firstBuyAt > ourEntryTimestamp) continue;
    if (entry.totalBoughtSol <= 0) continue;
    const sellRatio = entry.totalSoldSol / entry.totalBoughtSol;
    if (sellRatio >= threshold) {
      return {
        wallet,
        sellRatio,
        sellCount: entry.sellCount,
        soldSol: entry.totalSoldSol,
        boughtSol: entry.totalBoughtSol,
      };
    }
  }
  return null;
}

export function getKingState(mintAddress) {
  const out = [];
  for (const wallet of kingWalletSet()) {
    const entry = _kingActivity.get(`${wallet}:${mintAddress}`);
    if (entry) out.push({ wallet, ...entry });
  }
  return out;
}

export function pruneOlderThan(cutoffMs) {
  for (const [key, entry] of _kingActivity.entries()) {
    if (entry.lastUpdate < cutoffMs) _kingActivity.delete(key);
  }
}
