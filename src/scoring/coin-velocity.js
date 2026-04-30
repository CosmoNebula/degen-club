import { db } from '../db/index.js';
import { config } from '../config.js';

const _recentFires = new Map();
const _mintBuyerWindow = new Map();
const _rejectionCounts = new Map();
let _passCount = 0;
let _evalCount = 0;
let _statsResetAt = Date.now();

function bumpReject(reason) {
  const tag = String(reason || 'UNKNOWN').split(':')[0];
  _rejectionCounts.set(tag, (_rejectionCounts.get(tag) || 0) + 1);
}

export function getProfileStats() {
  const out = { evaluated: _evalCount, passed: _passCount, sinceMs: Date.now() - _statsResetAt, rejections: {} };
  for (const [k, v] of _rejectionCounts) out.rejections[k] = v;
  return out;
}

export function resetProfileStats() {
  _rejectionCounts.clear();
  _passCount = 0;
  _evalCount = 0;
  _statsResetAt = Date.now();
}

export function trackBuyer(mintAddress, wallet, ts) {
  let window = _mintBuyerWindow.get(mintAddress);
  if (!window) {
    window = [];
    _mintBuyerWindow.set(mintAddress, window);
  }
  window.push({ wallet, ts });
  const cutoff = ts - 60000;
  while (window.length && window[0].ts < cutoff) window.shift();
}

export function clearOnExit(mintAddress) {
  _mintBuyerWindow.delete(mintAddress);
}

function uniqueBuyersInWindow(mintAddress, sinceTs, untilTs) {
  const row = db().prepare(`
    SELECT COUNT(DISTINCT wallet) AS n FROM trades
    WHERE mint_address = ? AND is_buy = 1 AND timestamp >= ? AND timestamp <= ?
  `).get(mintAddress, sinceTs, untilTs);
  return row?.n || 0;
}

export function getMintMetrics(mintAddress) {
  const m = db().prepare(`
    SELECT mint_address, created_at, current_market_cap_sol, last_price_sol,
           bundle_buyer_count, migrated, rugged, last_trade_at
    FROM mints WHERE mint_address = ?
  `).get(mintAddress);
  return m;
}

export function checkPreKingProfile(mintAddress, now) {
  const cfg = config.strategies?.preKing;
  if (!cfg) return null;
  _evalCount++;

  const m = getMintMetrics(mintAddress);
  if (!m) { bumpReject('NO_MINT'); return { pass: false, reason: 'NO_MINT' }; }
  if (m.migrated || m.rugged) { bumpReject('MIGRATED_OR_RUGGED'); return { pass: false, reason: 'MIGRATED_OR_RUGGED' }; }

  const ageSec = (now - (m.created_at || now)) / 1000;
  if (ageSec < cfg.ageMinSec) { bumpReject('AGE_TOO_NEW'); return { pass: false, reason: `AGE_TOO_NEW:${ageSec.toFixed(1)}s` }; }
  if (ageSec > cfg.ageMaxSec) { bumpReject('AGE_TOO_OLD'); return { pass: false, reason: `AGE_TOO_OLD:${ageSec.toFixed(1)}s` }; }

  const mc = m.current_market_cap_sol || 0;
  if (mc < cfg.mcMinSol) { bumpReject('MC_TOO_LOW'); return { pass: false, reason: `MC_TOO_LOW:${mc.toFixed(1)}` }; }
  if (mc > cfg.mcMaxSol) { bumpReject('MC_TOO_HIGH'); return { pass: false, reason: `MC_TOO_HIGH:${mc.toFixed(1)}` }; }

  if ((m.bundle_buyer_count || 0) > cfg.maxBundleBuyers) {
    bumpReject('BUNDLED');
    return { pass: false, reason: `BUNDLED:${m.bundle_buyer_count}` };
  }

  const sniperCount = db().prepare(`
    SELECT COUNT(DISTINCT wallet) AS n FROM trades
    WHERE mint_address = ? AND is_buy = 1 AND is_first_block = 1
  `).get(mintAddress).n;
  if (sniperCount > cfg.maxFirstBlockSnipers) {
    bumpReject('SNIPER_HEAVY');
    return { pass: false, reason: `SNIPER_HEAVY:${sniperCount}` };
  }

  const windowMs = cfg.windowSec * 1000;
  const halfMs = windowMs / 2;
  const buyersFullWindow = uniqueBuyersInWindow(mintAddress, now - windowMs, now);
  if (buyersFullWindow < cfg.minBuyersInWindow) {
    bumpReject('LOW_VELOCITY');
    return { pass: false, reason: `LOW_VELOCITY:${buyersFullWindow}<${cfg.minBuyersInWindow}` };
  }
  const buyersRecentHalf = uniqueBuyersInWindow(mintAddress, now - halfMs, now);
  const velocityRatio = buyersFullWindow > 0 ? buyersRecentHalf / buyersFullWindow : 0;
  if (velocityRatio < cfg.minVelocityRatio) {
    bumpReject('DECELERATING');
    return { pass: false, reason: `DECELERATING:${velocityRatio.toFixed(2)}` };
  }

  const lastFire = _recentFires.get(mintAddress) || 0;
  if (now - lastFire < cfg.mintCooldownSec * 1000) {
    bumpReject('RECENT_FIRE');
    return { pass: false, reason: 'RECENT_FIRE' };
  }

  if (cfg.requireTrackedWalletConfirmation) {
    const lookbackMs = (cfg.confirmationWindowSec || 30) * 1000;
    const row = db().prepare(`
      SELECT COUNT(DISTINCT t.wallet) AS n
      FROM trades t JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? AND t.is_buy = 1
        AND t.timestamp >= ?
        AND (w.tracked = 1 OR w.is_kol = 1 OR w.category IN ('BOT','SCALPER','KOL'))
    `).get(mintAddress, now - lookbackMs);
    if ((row?.n || 0) < (cfg.minConfirmingWallets || 1)) {
      bumpReject('NO_CONFIRM');
      return { pass: false, reason: `NO_CONFIRM:${row?.n || 0}<${cfg.minConfirmingWallets || 1}` };
    }
  }

  _passCount++;
  return {
    pass: true,
    metrics: {
      ageSec, mc, buyersFullWindow, buyersRecentHalf, velocityRatio,
      bundleBuyers: m.bundle_buyer_count || 0,
      sniperCount,
    },
  };
}

export function markFired(mintAddress, ts) {
  _recentFires.set(mintAddress, ts);
  if (_recentFires.size > 5000) {
    const cutoff = ts - 30 * 60 * 1000;
    for (const [k, v] of _recentFires) if (v < cutoff) _recentFires.delete(k);
  }
}

export function pruneStale(now) {
  const cutoff = now - 5 * 60 * 1000;
  for (const [mint, window] of _mintBuyerWindow) {
    if (!window.length || window[window.length - 1].ts < cutoff) {
      _mintBuyerWindow.delete(mint);
    }
  }
}
