import { db } from '../db/index.js';
import { config } from '../config.js';
import { getTokenHolders } from '../ingestion/helius.js';

const cache = new Map();
const heliusCache = new Map();
const HELIUS_TTL_MS = 30000;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    holders: d.prepare(`
      SELECT
        wh.wallet,
        (wh.tokens_bought - wh.tokens_sold) AS net_tokens,
        wh.sol_invested,
        wh.is_sniper,
        wh.is_first_block,
        wh.buyer_rank,
        CASE WHEN w.bundle_cluster_id IS NOT NULL THEN 1 ELSE 0 END AS is_bundle,
        CASE WHEN wh.wallet = ? THEN 1 ELSE 0 END AS is_creator
      FROM wallet_holdings wh
      LEFT JOIN wallets w ON w.address = wh.wallet
      WHERE wh.mint_address = ?
        AND (wh.tokens_bought - wh.tokens_sold) > 0
      ORDER BY net_tokens DESC
    `),
    creator: d.prepare('SELECT creator_wallet FROM mints WHERE mint_address = ?'),
    migrated: d.prepare('SELECT migrated FROM mints WHERE mint_address = ?'),
  };
  return stmts;
}

export async function refreshHeliusHolders(mintAddress) {
  const now = Date.now();
  const cached = heliusCache.get(mintAddress);
  if (cached && cached.expiresAt > now) return cached.holders;
  const holders = await getTokenHolders(mintAddress, 1000);
  if (holders && holders.length) {
    heliusCache.set(mintAddress, { holders, expiresAt: now + HELIUS_TTL_MS });
    return holders;
  }
  return null;
}

export function getHolderStats(mintAddress) {
  const cached = cache.get(mintAddress);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.stats;

  const s = S();
  const m = s.creator.get(mintAddress);
  if (!m) return null;

  const heliusEntry = heliusCache.get(mintAddress);
  if (heliusEntry && heliusEntry.expiresAt > now && heliusEntry.holders.length > 0) {
    const stats = computeStatsFromHelius(heliusEntry.holders, m.creator_wallet || '', mintAddress);
    cache.set(mintAddress, { stats, expiresAt: now + config.strategies.holderGate.cacheTtlMs });
    return stats;
  }

  if (!heliusEntry || heliusEntry.expiresAt <= now) {
    const mig = S().migrated.get(mintAddress);
    if (mig && mig.migrated === 1) {
      refreshHeliusHolders(mintAddress).then(h => {
        if (h && h.length) cache.delete(mintAddress);
      }).catch(() => {});
    }
  }

  const rows = s.holders.all(m.creator_wallet || '', mintAddress);

  if (!rows.length) {
    const empty = {
      holderCount: 0, totalNetTokens: 0,
      top10Pct: 0, top10NonBundlePct: 0,
      bundlePct: 0, creatorPct: 0,
      topHolders: [],
    };
    cache.set(mintAddress, { stats: empty, expiresAt: now + config.strategies.holderGate.cacheTtlMs });
    return empty;
  }

  const total = rows.reduce((sum, r) => sum + (r.net_tokens || 0), 0);
  if (total <= 0) {
    const empty = {
      holderCount: rows.length, totalNetTokens: 0,
      top10Pct: 0, top10NonBundlePct: 0,
      bundlePct: 0, creatorPct: 0,
      topHolders: [],
    };
    cache.set(mintAddress, { stats: empty, expiresAt: now + config.strategies.holderGate.cacheTtlMs });
    return empty;
  }

  const top10 = rows.slice(0, 10);
  const top10Sum = top10.reduce((sum, r) => sum + r.net_tokens, 0);
  const top10NonBundleSum = top10.filter(r => !r.is_bundle).reduce((sum, r) => sum + r.net_tokens, 0);
  const bundleSum = rows.filter(r => r.is_bundle).reduce((sum, r) => sum + r.net_tokens, 0);
  const creatorSum = rows.filter(r => r.is_creator).reduce((sum, r) => sum + r.net_tokens, 0);
  const whaleRow = rows.find(r => !r.is_bundle && !r.is_creator);
  const whaleSum = whaleRow ? whaleRow.net_tokens : 0;
  const whaleWallet = whaleRow ? whaleRow.wallet : null;

  const stats = {
    holderCount: rows.length,
    totalNetTokens: total,
    top10Pct: top10Sum / total,
    top10NonBundlePct: top10NonBundleSum / total,
    bundlePct: bundleSum / total,
    creatorPct: creatorSum / total,
    whalePct: whaleSum / total,
    whaleWallet,
    topHolders: top10.map(r => ({
      wallet: r.wallet,
      net_tokens: r.net_tokens,
      sol_invested: r.sol_invested,
      pct: r.net_tokens / total,
      is_bundle: !!r.is_bundle,
      is_creator: !!r.is_creator,
      is_sniper: !!r.is_sniper,
      is_first_block: !!r.is_first_block,
      buyer_rank: r.buyer_rank,
    })),
  };

  cache.set(mintAddress, { stats, expiresAt: now + config.strategies.holderGate.cacheTtlMs });
  return stats;
}

function computeStatsFromHelius(holders, creatorWallet, mintAddress) {
  const d = db();
  const bundleSet = new Set(
    d.prepare('SELECT address FROM wallets WHERE bundle_cluster_id IS NOT NULL').all().map(r => r.address)
  );
  const total = holders.reduce((s, h) => s + h.amount, 0);
  if (!total) {
    return {
      holderCount: holders.length, totalNetTokens: 0,
      top10Pct: 0, top10NonBundlePct: 0,
      bundlePct: 0, creatorPct: 0,
      whalePct: 0, whaleWallet: null, topHolders: [],
      source: 'helius',
    };
  }
  const top10 = holders.slice(0, 10);
  const top10Sum = top10.reduce((s, h) => s + h.amount, 0);
  const top10NonBundleSum = top10.filter(h => !bundleSet.has(h.owner)).reduce((s, h) => s + h.amount, 0);
  const bundleSum = holders.filter(h => bundleSet.has(h.owner)).reduce((s, h) => s + h.amount, 0);
  const creatorSum = holders.filter(h => h.owner === creatorWallet).reduce((s, h) => s + h.amount, 0);
  const whaleHolder = holders.find(h => !bundleSet.has(h.owner) && h.owner !== creatorWallet);
  const whaleSum = whaleHolder ? whaleHolder.amount : 0;

  return {
    holderCount: holders.length,
    totalNetTokens: total,
    top10Pct: top10Sum / total,
    top10NonBundlePct: top10NonBundleSum / total,
    bundlePct: bundleSum / total,
    creatorPct: creatorSum / total,
    whalePct: whaleSum / total,
    whaleWallet: whaleHolder?.owner || null,
    topHolders: top10.map(h => ({
      wallet: h.owner,
      net_tokens: h.amount,
      sol_invested: 0,
      pct: h.amount / total,
      is_bundle: bundleSet.has(h.owner),
      is_creator: h.owner === creatorWallet,
      is_sniper: false,
      is_first_block: false,
      buyer_rank: null,
    })),
    source: 'helius',
  };
}

export function passesHolderDiversity(mintAddress, opts = {}) {
  const cfg = config.strategies.holderGate;
  if (!cfg.enabled) return { pass: true };

  const stats = getHolderStats(mintAddress);
  if (!stats) return { pass: true };

  if (stats.holderCount < cfg.minHolderCount) {
    return { pass: false, reason: `THIN_HOLDERS(${stats.holderCount}<${cfg.minHolderCount})` };
  }
  if (!opts.skipWhale && stats.whalePct > cfg.maxWhalePct) {
    return { pass: false, reason: `WHALE_TOO_BIG(${(stats.whalePct*100).toFixed(0)}%>${(cfg.maxWhalePct*100).toFixed(0)}%)` };
  }
  if (stats.bundlePct > cfg.maxBundlePct) {
    return { pass: false, reason: `BUNDLE_TOO_HIGH(${(stats.bundlePct*100).toFixed(0)}%>${(cfg.maxBundlePct*100).toFixed(0)}%)` };
  }
  if (stats.creatorPct > cfg.maxCreatorPct) {
    return { pass: false, reason: `DEV_TOO_HIGH(${(stats.creatorPct*100).toFixed(0)}%>${(cfg.maxCreatorPct*100).toFixed(0)}%)` };
  }
  return { pass: true };
}
