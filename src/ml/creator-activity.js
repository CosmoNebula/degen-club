// Creator post-launch activity analyzer (Tier 2 #3).
//
// For each newly observed mint, fetches the creator wallet's parsed Helius
// history covering the launch window and extracts two signals invisible to
// our firehose:
//
//   1. sol_to_sidewallets: SOL the creator sent to fresh wallets in the
//      ±15min window around launch. Captures sidewallet-funding setups.
//   2. sidewallet_buyer_count: how many of those funded wallets THEN bought
//      this mint. The smoking gun for creator-bait launches — these are
//      virtually always rugs.
//
// Cost discipline: ONE parse-history fetch per mint, cached in
// creator_activity_cache. Multi-age snapshots of the same mint (60/300/900/3600)
// all read from the same cache row.

import { db } from '../db/index.js';
import { fetchParsedHistory, parseHistoryAvailable } from './helius-parse.js';

// Pulled lazily so additions made at runtime (via SQL on known_addresses)
// are picked up without a restart. Set rebuilt every BLOCKLIST_TTL_MS.
let _blocklist = null;
let _blocklistFetchedAt = 0;
const BLOCKLIST_TTL_MS = 60 * 1000;
function getBlocklist() {
  const now = Date.now();
  if (_blocklist && (now - _blocklistFetchedAt) < BLOCKLIST_TTL_MS) return _blocklist;
  const rows = db().prepare(`SELECT address FROM known_addresses`).all();
  _blocklist = new Set(rows.map(r => r.address));
  _blocklistFetchedAt = now;
  return _blocklist;
}

// Widened from ±15min → ±60min because empirically the ±15min window caught
// almost no sidewallet→buyer matches. Devs commonly fund sidewallets well
// before launch (sometimes during cycle-prep an hour earlier) and the
// recipients then sit dormant until the mint is live.
const LAUNCH_WINDOW_MS = 60 * 60 * 1000; // ±60 minutes around mint creation
const CACHE_TTL_MS = 60 * 60 * 1000;     // refresh after 60 min if a snapshot still cares
const MAX_CONCURRENT = 2;
// Hard ceiling on parse-history calls in any 24h rolling window. Each call
// costs ~100 Helius credits; 800 = 80K credits = ~24% of monthly budget for
// this feature alone. Combined with the snapshot-sweeper gate (tracked>=2)
// this should keep us well under cap on normal days and refuse the bleed
// during runaway mint volume.
const DAILY_FETCH_CAP = 800;
const COUNT_REFRESH_MS = 60 * 1000;
let inflight = 0;
const queue = [];
let _recent24hCount = 0;
let _lastCountRefresh = 0;
let _capHitLoggedAt = 0;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    getCache: d.prepare(`SELECT * FROM creator_activity_cache WHERE mint_address = ?`),
    upsertCache: d.prepare(`INSERT OR REPLACE INTO creator_activity_cache
      (mint_address, creator_wallet, fetched_at, sol_to_sidewallets,
       sidewallet_buyer_count, fetch_status, raw_summary)
      VALUES (?,?,?,?,?,?,?)`),
    getMintTrades: d.prepare(`
      SELECT DISTINCT wallet FROM trades
      WHERE mint_address = ? AND is_buy = 1
    `),
    getMintCreator: d.prepare(`SELECT mint_address, creator_wallet, created_at FROM mints WHERE mint_address = ?`),
  };
  return stmts;
}

// Returns the cached activity row OR null if missing/stale.
export function getCreatorActivity(mintAddress) {
  const row = S().getCache.get(mintAddress);
  if (!row) return null;
  if (Date.now() - row.fetched_at > CACHE_TTL_MS) return null;
  return row;
}

// Counts successful fetches in the rolling 24h window. Refreshes from DB once
// per minute so the cap survives bot restarts (in-memory counter alone would
// reset on each respawn and let us blow past the budget).
function getRecent24hFetchCount() {
  const now = Date.now();
  if (now - _lastCountRefresh < COUNT_REFRESH_MS) return _recent24hCount;
  const cutoff = now - 24 * 60 * 60 * 1000;
  const row = db().prepare(
    `SELECT COUNT(*) AS n FROM creator_activity_cache WHERE fetched_at >= ? AND fetch_status = 'ok'`
  ).get(cutoff);
  _recent24hCount = row?.n || 0;
  _lastCountRefresh = now;
  return _recent24hCount;
}

// Fire-and-forget enqueue. Idempotent: skip if a fresh row exists.
export function maybeFetchCreatorActivity(mintAddress) {
  if (!parseHistoryAvailable()) return;
  const cached = S().getCache.get(mintAddress);
  if (cached && (Date.now() - cached.fetched_at) < CACHE_TTL_MS) return;
  // Budget guard: refuse to enqueue if we've already burned the daily cap.
  // One-time log per saturation cycle so the user knows the gate fired.
  const count = getRecent24hFetchCount() + queue.length + inflight;
  if (count >= DAILY_FETCH_CAP) {
    const now = Date.now();
    if (now - _capHitLoggedAt > 60 * 60 * 1000) {
      _capHitLoggedAt = now;
      console.warn(`[creator-activity] CAP HIT — ${count} fetches in last 24h ≥ cap=${DAILY_FETCH_CAP}. Rejecting until window rolls. Adjust DAILY_FETCH_CAP in creator-activity.js if intentional.`);
    }
    return;
  }
  queue.push(mintAddress);
  drain();
}

async function drain() {
  while (inflight < MAX_CONCURRENT && queue.length > 0) {
    const mint = queue.shift();
    inflight++;
    analyze(mint).finally(() => { inflight--; drain(); });
  }
}

async function analyze(mintAddress) {
  const s = S();
  const mint = s.getMintCreator.get(mintAddress);
  if (!mint || !mint.creator_wallet) return;
  const launchTs = mint.created_at;
  const windowStart = launchTs - LAUNCH_WINDOW_MS;
  const windowEnd = launchTs + LAUNCH_WINDOW_MS;

  // Pull parsed history. Helius returns most-recent-first; we filter to the
  // ±15min window around the mint's launch timestamp.
  let txs;
  try {
    txs = await fetchParsedHistory(mint.creator_wallet, { limit: 100 });
  } catch (err) {
    s.upsertCache.run(mintAddress, mint.creator_wallet, Date.now(),
      null, null, 'error:' + err.message.slice(0, 40), null);
    return;
  }
  if (!Array.isArray(txs)) {
    s.upsertCache.run(mintAddress, mint.creator_wallet, Date.now(),
      null, null, 'no-data', null);
    return;
  }

  // Sum SOL the creator sent OUT to other wallets in the window. Track the
  // recipient wallets — those are candidate sidewallets. Skip protocol/exchange
  // addresses via the known_addresses blocklist (these are routing
  // infrastructure, not sidewallets).
  const blocklist = getBlocklist();
  const sidewalletCandidates = new Map(); // address → sol_received
  let filtered_count = 0;
  let filtered_sol = 0;
  for (const tx of txs) {
    const tsMs = (tx.timestamp || 0) * 1000;
    if (tsMs < windowStart || tsMs > windowEnd) continue;
    if (tx.transactionError) continue;
    const transfers = tx.nativeTransfers || [];
    for (const nt of transfers) {
      if (nt.fromUserAccount !== mint.creator_wallet) continue;
      if (nt.toUserAccount === mint.creator_wallet) continue;
      if (!nt.toUserAccount) continue;
      const sol = (nt.amount || 0) / 1e9;
      if (sol < 0.01) continue; // ignore dust / tx fees
      if (blocklist.has(nt.toUserAccount)) {
        filtered_count++;
        filtered_sol += sol;
        continue;
      }
      sidewalletCandidates.set(nt.toUserAccount,
        (sidewalletCandidates.get(nt.toUserAccount) || 0) + sol);
    }
  }

  const solToSidewallets = [...sidewalletCandidates.values()]
    .reduce((acc, v) => acc + v, 0);

  // Cross-reference candidates against actual buyers of THIS mint. Even one
  // funded sidewallet then buying = strong rug-bait signal.
  let sidewalletBuyerCount = 0;
  if (sidewalletCandidates.size > 0) {
    const buyers = new Set(s.getMintTrades.all(mintAddress).map(r => r.wallet));
    for (const candidate of sidewalletCandidates.keys()) {
      if (buyers.has(candidate)) sidewalletBuyerCount++;
    }
  }

  const summary = JSON.stringify({
    txs_seen: txs.length,
    candidates: sidewalletCandidates.size,
    candidate_addresses: [...sidewalletCandidates.keys()].slice(0, 10),
    filtered_count,
    filtered_sol: Math.round(filtered_sol * 1000) / 1000,
  });

  s.upsertCache.run(
    mintAddress, mint.creator_wallet, Date.now(),
    solToSidewallets, sidewalletBuyerCount, 'ok', summary
  );

  if (sidewalletBuyerCount > 0) {
    console.log(`[creator-activity] ${mintAddress.slice(0, 8)}… creator=${mint.creator_wallet.slice(0, 6)}` +
      ` sol_to_sidewallets=${solToSidewallets.toFixed(2)} sidewallet_buyers=${sidewalletBuyerCount}`);
  }
}
