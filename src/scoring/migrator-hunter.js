// Migrator-Hunter signal: fires when N+ wallets with high migrator_score
// buy a non-migrated mint inside a sliding window. Runs on every buy event.
//
// "Migrator hunter" = a wallet our backfill scored as good at catching mints that
// graduate, and getting in early relative to peak (see scoring/migrator-stats.js).
// Their categories often look like BUNDLE/BOT — we don't care; that's exactly the
// kind of activity we want to copy on the migrator path.

import { db } from '../db/index.js';
import { config } from '../config.js';

const buys = new Map();      // mint_address -> [{ wallet, score, ts }]
const fired = new Map();     // mint_address -> last_fire_ts
const scoreCache = new Map(); // wallet -> { score, expires }
const SCORE_TTL_MS = 60_000;

function getStmts() {
  const d = db();
  return {
    walletScore: d.prepare(`SELECT migrator_score, migrator_pre_mig_buys FROM wallets WHERE address = ?`),
    mint: d.prepare(`SELECT mint_address, current_market_cap_sol, created_at, migrated, rugged, unique_buyer_count FROM mints WHERE mint_address = ?`),
  };
}
let stmts = null;
function S() { return stmts ||= getStmts(); }

function getScore(wallet) {
  const cached = scoreCache.get(wallet);
  const now = Date.now();
  if (cached && cached.expires > now) return cached;
  const row = S().walletScore.get(wallet);
  const v = {
    score: row?.migrator_score || 0,
    sample: row?.migrator_pre_mig_buys || 0,
    expires: now + SCORE_TTL_MS,
  };
  scoreCache.set(wallet, v);
  if (scoreCache.size > 5000) scoreCache.delete(scoreCache.keys().next().value);
  return v;
}

// Called from processor on every buy. Cheap: one cached lookup + array push.
// Returns the signal payload when it fires, otherwise null. Caller dispatches.
export function trackHunterBuy(mintAddress, wallet, now = Date.now()) {
  const cfg = config.strategies?.migratorHunter;
  if (!cfg || cfg.defaults?.enabled === undefined) return null;
  const minScore = cfg.minScore ?? 0.55;
  const minSample = cfg.minSample ?? 5;
  const windowMs = (cfg.windowSec ?? 300) * 1000;
  const minHunters = cfg.minHunters ?? 3;
  const cooldownMs = (cfg.cooldownMinutes ?? 30) * 60_000;

  const sc = getScore(wallet);
  if (sc.score < minScore || sc.sample < minSample) return null;

  let arr = buys.get(mintAddress);
  if (!arr) { arr = []; buys.set(mintAddress, arr); }
  // Prune + dedupe same wallet inside window (only count distinct)
  const cutoff = now - windowMs;
  arr = arr.filter(b => b.ts >= cutoff && b.wallet !== wallet);
  arr.push({ wallet, score: sc.score, ts: now });
  buys.set(mintAddress, arr);

  if (arr.length < minHunters) return null;

  const lastFire = fired.get(mintAddress) || 0;
  if (now - lastFire < cooldownMs) return null;

  const m = S().mint.get(mintAddress);
  if (!m || m.migrated || m.rugged) return null;
  const ageSec = (now - (m.created_at || now)) / 1000;
  if (ageSec < (cfg.minAgeSec ?? 60)) return null;
  if (ageSec > (cfg.maxAgeSec ?? 7200)) return null;
  const mc = m.current_market_cap_sol || 0;
  if (mc < (cfg.minMcapSol ?? 30)) return null;
  if (mc > (cfg.maxMcapSol ?? 250)) return null;
  const uniq = m.unique_buyer_count || 0;
  if (uniq < (cfg.minUniqueBuyers ?? 0)) return null;

  fired.set(mintAddress, now);
  const avgScore = arr.reduce((s, b) => s + b.score, 0) / arr.length;
  return {
    type: 'MIGRATOR_HUNTER',
    hunterCount: arr.length,
    avgScore: +avgScore.toFixed(3),
    wallets: arr.map(b => b.wallet),
    ageSec: +ageSec.toFixed(1),
    mcap: +mc.toFixed(1),
  };
}

// Light maintenance: prune stale per-mint state. Called on a timer.
export function sweepHunterState({ now = Date.now(), maxAgeMs = 30 * 60_000 } = {}) {
  const cutoff = now - maxAgeMs;
  for (const [mint, arr] of buys.entries()) {
    const kept = arr.filter(b => b.ts >= cutoff);
    if (kept.length === 0) buys.delete(mint);
    else if (kept.length < arr.length) buys.set(mint, kept);
  }
  for (const [mint, ts] of fired.entries()) {
    if (ts < cutoff) fired.delete(mint);
  }
  return { mintsTracked: buys.size, mintsOnCooldown: fired.size };
}

export function _debugState() {
  return { mints: buys.size, cooldowns: fired.size, cacheSize: scoreCache.size };
}
