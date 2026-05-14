// Top-50 dynamic trader leaderboard. Hourly recompute. Wallets compete for 50
// fixed slots; if a new wallet outscores a member, it takes the slot. The
// leaderboard owns `wallets.tracked` and `wallets.is_kol` — both are derived
// here, not from the old threshold logic in traders.js.
//
// Tiers (by rank):
//   1-10   KOL      — top elite, also ML-feature 'top10_buyers'
//   11-25  HIGH     — strong, also ML-feature 'top50_buyers'
//   26-50  TRACKED  — in the pool, contributes to 'top50_buyers'
//
// Hard disqualifiers (applied before scoring):
//   closed_30d < 20          (insufficient sample)
//   sniper_ratio > 0.8       (likely bot)
//   avg_hold_seconds < 2     (likely bot)
//   trade_count_30d > 6000   (>200/day, likely bot)
//   bundle_cluster_id set    (bundle member)
//
// Score:
//   min(realized_pnl_30d, 500)        // raw SOL profit, capped
// + win_rate_30d × 40                 // 0-40
// + migrator_pre_mig_buys × 8         // count
// + min(avg_multiple_30d, 10) × 10    // capped
// + early_entry_rate × 15             // 0-15 (entered <30 SOL mcap rate)
// - rug_rate_30d × 30                 // penalty for buying rugs
//
// KOL floor (must also clear to occupy slots 1-10):
//   realized_pnl_30d >= 30 SOL AND migrator_pre_mig_buys >= 3 AND closed_30d >= 20

import { db } from '../db/index.js';

const SLOTS = 50;
const KOL_SLOTS = 10;
const HIGH_END = 25;
const RECOMPUTE_INTERVAL_MS = 15 * 60 * 1000;  // 2026-05-13 PM: 30min → 15min after 4-CPU resize. Faster reaction to hot streaks and degradation; recompute is ~3s on ~3k candidates, no impact.
// Auto-untrack: wallets that fall off top-50 for AUTO_UNTRACK_DROPS consecutive
// recomputes get tracked=0. At 30-min cadence, 3 drops = ~1.5h sticky window.
// Prevents single bad hour from kicking out a long-standing high-quality wallet,
// while still pruning trackers that have genuinely gone cold.
const AUTO_UNTRACK_DROPS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const PNL_CAP = 500;
const MULTIPLE_CAP = 10;

// Floor for KOL tier (rank 1-10). All must hold — a wallet can be the
// highest-scoring candidate and still NOT be tagged KOL if it fails any
// floor. The pre-2026-05-11 version tagged tier purely by rank position,
// which let losing wallets get "KOL" tags when too few qualifying wallets
// existed. Fixed now.
const KOL_MIN_REALIZED_SOL = 30;
const KOL_MIN_MIG_BUYS = 3;
const KOL_MIN_CLOSED = 20;
const KOL_MIN_WIN_RATE = 0.30;

// Floor for HIGH tier (rank 11-25). Looser than KOL but still a real
// quality floor — a wallet must show net-positive PnL OR meaningful
// migrator activity. Prevents wallets with sub-20% WR from dressing up
// as "high-quality" by virtue of rank alone.
const HIGH_MIN_REALIZED_SOL = 5;
const HIGH_MIN_CLOSED = 10;
const HIGH_MIN_WIN_RATE = 0.20;

function tierForRank(rank) {
  if (rank <= KOL_SLOTS) return 'KOL';
  if (rank <= HIGH_END) return 'HIGH';
  return 'TRACKED';
}

// Returns the set of addresses currently flagged tracked=1 (non-manual only).
// We use this snapshot to figure out who's about to "drop off" the new top-50.
function loadCurrentlyTracked(d) {
  const rows = d.prepare(`SELECT address, COALESCE(dropped_count, 0) AS dropped_count
    FROM wallets WHERE tracked = 1 AND manually_tracked = 0`).all();
  const m = new Map();
  for (const r of rows) m.set(r.address, r.dropped_count);
  return m;
}

// 2026-05-14: this query was 4.2-4.6s every recompute (every ~15min),
// blocking the loop long enough to drop WSS each time. Cache result for
// 10min — fresher than that doesn't change tier assignments meaningfully.
const CANDIDATES_CACHE_TTL_MS = 10 * 60 * 1000;
let _candidatesCache = null;
let _candidatesCacheAt = 0;
function loadCandidatesWithExtraStats() {
  const now = Date.now();
  if (_candidatesCache && (now - _candidatesCacheAt) < CANDIDATES_CACHE_TTL_MS) {
    return _candidatesCache;
  }
  const d = db();
  const cutoff30d = Date.now() - 30 * DAY_MS;
  const cutoff7d = Date.now() - 7 * DAY_MS;

  // Gather candidates that pass disqualifiers, then compute the three derived
  // metrics (avg_multiple_30d, early_entry_rate, rug_rate_30d) in one SQL pass.
  const sql = `
    WITH candidates AS (
      SELECT address FROM wallets
      WHERE COALESCE(closed_30d, 0) >= 20
        -- 2026-05-13 (D2): tightened from sniper_ratio<=0.8 to <=0.30.
        -- Humans rarely sniper >30% of their buys; >30% is bot territory.
        -- The point of trackers is to FOLLOW good hunters, not get front-run by them.
        AND COALESCE(sniper_ratio, 0) <= 0.30
        -- First-block buy ratio: humans cannot physically be first-block.
        -- >20% first-block = bot. (Some legit MEV traders fit this profile
        -- but we don't want to follow them either — they front-run, we lose.)
        AND COALESCE(first_block_ratio, 0) <= 0.20
        -- Hold time: humans hold at least a minute. <60s = scalper/sniper.
        AND COALESCE(avg_hold_seconds, 0) >= 60
        -- Trade volume cap: 1500/30d = 50/day average. Humans rarely pick
        -- more than 50 distinct mints/day. Was 4500 (150/day) — too permissive.
        AND COALESCE(trade_count_30d, 0) <= 1500
        -- Explicit category filter: the bot's own classification flags
        -- SCALPER/BOT/BUNDLE based on multi-feature heuristics. Trust it.
        AND COALESCE(category, 'NOT_SURE') NOT IN ('SCALPER', 'BOT', 'BUNDLE')
        -- Trades-per-position: bots churn the same mint many times.
        -- Humans buy once, sell once or in stages. Lowered cap 5 → 3.
        AND COALESCE(trades_per_position, 0) <= 3
        AND COALESCE(bundle_cluster_id, '') = ''
    ),
    first_buy AS (
      SELECT t.wallet, t.mint_address, MIN(t.market_cap_sol) AS first_mcap
      FROM trades t
      WHERE t.is_buy = 1
        AND t.wallet IN (SELECT address FROM candidates)
      GROUP BY t.wallet, t.mint_address
    )
    SELECT
      w.address,
      COALESCE(w.realized_pnl_30d, 0) AS realized_pnl_30d,
      COALESCE(w.win_rate_30d, 0) AS win_rate_30d,
      COALESCE(w.closed_30d, 0) AS closed_30d,
      COALESCE(w.realized_pnl_7d, 0) AS realized_pnl_7d,
      COALESCE(w.win_rate_7d, 0) AS win_rate_7d,
      COALESCE(w.closed_7d, 0) AS closed_7d,
      COALESCE(w.migrator_pre_mig_buys, 0) AS migrator_pre_mig_buys,
      COALESCE(w.sniper_ratio, 0) AS sniper_ratio,
      COALESCE(w.avg_hold_seconds, 0) AS avg_hold_seconds,
      -- avg_multiple_30d: per-position (sol_realized + remaining_value) / sol_invested
      (
        SELECT AVG(
          CASE WHEN wh.sol_invested > 0 THEN
            (wh.sol_realized
             + MAX(0, wh.tokens_bought - wh.tokens_sold) * COALESCE(m.last_price_sol, 0)
            ) / wh.sol_invested
          ELSE NULL END
        )
        FROM wallet_holdings wh
        LEFT JOIN mints m ON m.mint_address = wh.mint_address
        WHERE wh.wallet = w.address
          AND wh.last_activity_at >= ?
      ) AS avg_multiple_30d,
      -- avg_multiple_7d: same as 30d but windowed to last 7 days. Drives
      -- the hot-streak overlay in momentum_score_7d.
      (
        SELECT AVG(
          CASE WHEN wh.sol_invested > 0 THEN
            (wh.sol_realized
             + MAX(0, wh.tokens_bought - wh.tokens_sold) * COALESCE(m.last_price_sol, 0)
            ) / wh.sol_invested
          ELSE NULL END
        )
        FROM wallet_holdings wh
        LEFT JOIN mints m ON m.mint_address = wh.mint_address
        WHERE wh.wallet = w.address
          AND wh.last_activity_at >= ?
      ) AS avg_multiple_7d,
      -- early_entry_rate: fraction of touched mints whose first buy was at <30 SOL mcap
      (
        SELECT AVG(CASE WHEN fb.first_mcap > 0 AND fb.first_mcap < 30 THEN 1.0 ELSE 0.0 END)
        FROM first_buy fb
        WHERE fb.wallet = w.address
      ) AS early_entry_rate,
      -- rug_rate_30d: fraction of mints they touched in 30d that rugged
      (
        SELECT AVG(CASE WHEN m.rugged = 1 THEN 1.0 ELSE 0.0 END)
        FROM wallet_holdings wh
        JOIN mints m ON m.mint_address = wh.mint_address
        WHERE wh.wallet = w.address
          AND wh.last_activity_at >= ?
      ) AS rug_rate_30d
    FROM wallets w
    WHERE w.address IN (SELECT address FROM candidates)
  `;
  const rows = d.prepare(sql).all(cutoff30d, cutoff7d, cutoff30d);
  _candidatesCache = rows;
  _candidatesCacheAt = now;
  return rows;
}

// Score v2.1 (2026-05-11) — base 30d quality + 7d momentum overlay.
//
// Base (30d) weights (unchanged from v2):
//   PnL:        × 5  (capped at PNL_CAP=500 SOL → max +2500 pts)
//   Win rate:   × 100 (0.0-1.0 → 0-100 pts)
//   Sample log: log10(closed+1) × 20 (rewards real samples, soft cap)
//   Multiple:   × 10 (capped at 10× → max +100 pts)
//   Migrator:   × 2  (50 mig buys = +100 pts — tiebreaker, not driver)
//   Early:      × 15 (early-entry rate)
//   Rug penalty: × 60 (30% rug rate = -18 pts)
//
// Momentum (7d) overlay — additive, only applied when closed_7d >= 3:
//   PnL_7d:        × 8  (recent SOL matters more than older SOL)
//   Win rate_7d:   × 60 (smaller weight than 30d WR because smaller sample)
//   Sample log_7d: × 15
//   Multiple_7d:   × 8
//
// Wallets with no recent activity (closed_7d < 3) keep their 30d-only
// score. Hot wallets get bumped. Cold-but-historically-good wallets aren't
// punished — they just don't get the bonus.
const MOMENTUM_MIN_CLOSED_7D = 3;

function computeMomentum7d(c) {
  const closed7d = c.closed_7d || 0;
  if (closed7d < MOMENTUM_MIN_CLOSED_7D) {
    return { score: 0, components: null };
  }
  const pnl7 = Math.min(c.realized_pnl_7d || 0, PNL_CAP) * 8;
  const wr7 = (c.win_rate_7d || 0) * 60;
  const sample7 = Math.log10(closed7d + 1) * 15;
  const mult7 = Math.min(c.avg_multiple_7d || 0, MULTIPLE_CAP) * 8;
  const score = pnl7 + wr7 + sample7 + mult7;
  return {
    score: Number(score.toFixed(3)),
    components: {
      pnl_7d: Number(pnl7.toFixed(3)),
      win_rate_7d: Number(wr7.toFixed(2)),
      sample_log_7d: Number(sample7.toFixed(2)),
      multiple_7d: Number(mult7.toFixed(2)),
    },
  };
}

function scoreCandidate(c) {
  const pnl = Math.min(c.realized_pnl_30d || 0, PNL_CAP) * 5;
  const wr = (c.win_rate_30d || 0) * 100;
  const sampleLog = Math.log10((c.closed_30d || 0) + 1) * 20;
  const mult = Math.min(c.avg_multiple_30d || 0, MULTIPLE_CAP) * 10;
  const mig = (c.migrator_pre_mig_buys || 0) * 2;
  const early = (c.early_entry_rate || 0) * 15;
  const rugPenalty = (c.rug_rate_30d || 0) * 60;
  const base = pnl + wr + sampleLog + mult + mig + early - rugPenalty;
  const momentum = computeMomentum7d(c);
  const score = base + momentum.score;
  return {
    score: Number(score.toFixed(3)),
    components: {
      pnl: Number(pnl.toFixed(3)),
      win_rate: Number(wr.toFixed(2)),
      sample_log: Number(sampleLog.toFixed(2)),
      multiple: Number(mult.toFixed(2)),
      migrator: mig,
      early_entry: Number(early.toFixed(2)),
      rug_penalty: Number(rugPenalty.toFixed(2)),
      base_30d: Number(base.toFixed(3)),
      momentum_7d: momentum.score,
      momentum_components: momentum.components,
    },
  };
}

function passesKolFloor(c) {
  return (c.realized_pnl_30d || 0) >= KOL_MIN_REALIZED_SOL
    && (c.migrator_pre_mig_buys || 0) >= KOL_MIN_MIG_BUYS
    && (c.closed_30d || 0) >= KOL_MIN_CLOSED
    && (c.win_rate_30d || 0) >= KOL_MIN_WIN_RATE;
}

function passesHighFloor(c) {
  return (c.realized_pnl_30d || 0) >= HIGH_MIN_REALIZED_SOL
    && (c.closed_30d || 0) >= HIGH_MIN_CLOSED
    && (c.win_rate_30d || 0) >= HIGH_MIN_WIN_RATE;
}

export function recomputeLeaderboard({ verbose = false } = {}) {
  const d = db();
  const t0 = Date.now();
  const candidates = loadCandidatesWithExtraStats();
  if (!candidates.length) {
    if (verbose) console.log('[leaderboard] no candidates yet — skipping');
    return { scanned: 0, top: 0, ms: Date.now() - t0 };
  }

  // Score every candidate.
  const scored = candidates.map(c => ({ ...c, ...scoreCandidate(c) }))
    .sort((a, b) => b.score - a.score);

  // Tier assignment v2 — floors enforced per-tier, ranks purely by score.
  // Pre-2026-05-11 the leaderboard was sorted by tier-then-score, which
  // produced weird orderings where rank 1 had a lower score than rank 4
  // just because rank-1 happened to clear the KOL floor and rank-4 didn't.
  // Now: rank by score (highest first), tag tier by floor membership.
  // Top 50 by score = the leaderboard. Each wallet's TIER is just a
  // quality label, not a ranking driver.
  const final = scored.slice(0, SLOTS);
  const tierByAddress = new Map();
  for (const c of final) {
    if (passesKolFloor(c)) tierByAddress.set(c.address, 'KOL');
    else if (passesHighFloor(c)) tierByAddress.set(c.address, 'HIGH');
    else tierByAddress.set(c.address, 'TRACKED');
  }

  const insert = d.prepare(`INSERT INTO wallet_leaderboard
    (address, rank, tier, score, realized_pnl_30d, win_rate_30d, closed_30d,
     migrator_pre_mig_buys, avg_multiple_30d, early_entry_rate, rug_rate_30d,
     sniper_ratio, avg_hold_seconds, components_json, label, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fetchLabel = d.prepare('SELECT label FROM wallets WHERE address = ?');
  const setTrackedKol = d.prepare(`UPDATE wallets SET tracked = ?, is_kol = ?,
    tracked_since = COALESCE(tracked_since, ?), kol_since = COALESCE(kol_since, ?)
    WHERE address = ?`);

  const now = Date.now();
  const finalAddrs = new Set(final.map(c => c.address));
  const incrementDropped = d.prepare(`UPDATE wallets SET dropped_count = COALESCE(dropped_count,0) + 1 WHERE address = ?`);
  const setUntracked = d.prepare(`UPDATE wallets SET tracked = 0, is_kol = 0 WHERE address = ? AND manually_tracked = 0`);
  const resetDropped = d.prepare(`UPDATE wallets SET dropped_count = 0 WHERE address = ?`);

  const tx = d.transaction(() => {
    d.exec('DELETE FROM wallet_leaderboard');
    // STICKY auto-untrack (2026-05-13 / D2): wallets falling off top-50 don't
    // immediately lose tracked=1. They increment dropped_count. After
    // AUTO_UNTRACK_DROPS consecutive drops (~1.5h at 30min cadence) they're
    // demoted. Wallets back on the board reset to dropped_count=0.
    const prevTracked = loadCurrentlyTracked(d);
    for (const [addr, droppedCount] of prevTracked) {
      if (!finalAddrs.has(addr)) {
        const nextDrop = droppedCount + 1;
        incrementDropped.run(addr);
        if (nextDrop >= AUTO_UNTRACK_DROPS) {
          setUntracked.run(addr);
        }
        // else: still tracked=1 (probationary), score not in top-50 this round
      }
    }
    final.forEach((c, i) => {
      const rank = i + 1;
      const tier = tierByAddress.get(c.address) || tierForRank(rank);
      const isKol = tier === 'KOL' ? 1 : 0;
      const label = fetchLabel.get(c.address)?.label || null;
      insert.run(
        c.address, rank, tier, c.score,
        c.realized_pnl_30d, c.win_rate_30d, c.closed_30d,
        c.migrator_pre_mig_buys, c.avg_multiple_30d || 0, c.early_entry_rate || 0,
        c.rug_rate_30d || 0, c.sniper_ratio, c.avg_hold_seconds,
        JSON.stringify(c.components), label, now,
      );
      setTrackedKol.run(1, isKol, now, isKol ? now : null, c.address);
      resetDropped.run(c.address);
    });
  });
  tx();

  const took = Date.now() - t0;
  if (verbose) {
    const top3 = final.slice(0, 3).map(c => `${c.address.slice(0, 6)}=${c.score.toFixed(1)}`).join(', ');
    console.log(`[leaderboard] scanned ${candidates.length} · top 50 selected · top3=${top3} · ${took}ms`);
  }
  return { scanned: candidates.length, top: final.length, ms: took };
}

export function topLeaderboard(limit = SLOTS) {
  return db().prepare(`
    SELECT wl.*, w.label, w.category
    FROM wallet_leaderboard wl
    LEFT JOIN wallets w ON w.address = wl.address
    ORDER BY wl.rank ASC LIMIT ?
  `).all(limit);
}

export function leaderboardAddresses(maxRank = SLOTS) {
  return db().prepare(`SELECT address FROM wallet_leaderboard WHERE rank <= ? ORDER BY rank`)
    .all(maxRank).map(r => r.address);
}

// Phase 1: dual scoped leaderboards. Same disqualifier gate as the combined
// board, but stats are sourced from premig_* / postmig_* columns instead of
// the totals. Recomputed alongside the main leaderboard.
//
// Scoring formula (per scope) — same shape as combined, just lower weights
// for fields we don't track scoped (migrator_pre_mig_buys, early_entry_rate,
// rug_rate_30d). Score weighted on:
//   PnL (capped 500) × 5
//   Win rate × 100
//   Sample log × 20
//   Multiple (capped 10) × 10
const SCOPED_PNL_CAP = 500;
const SCOPED_MULTIPLE_CAP = 10;

function scoreScoped(c) {
  const pnl = Math.min(c.realized_pnl_30d || 0, SCOPED_PNL_CAP) * 5;
  const wr = (c.win_rate_30d || 0) * 100;
  const sampleLog = Math.log10((c.closed_30d || 0) + 1) * 20;
  const mult = Math.min(c.avg_multiple_30d || 0, SCOPED_MULTIPLE_CAP) * 10;
  const score = pnl + wr + sampleLog + mult;
  return {
    score: Number(score.toFixed(3)),
    components: {
      pnl: Number(pnl.toFixed(3)),
      win_rate: Number(wr.toFixed(2)),
      sample_log: Number(sampleLog.toFixed(2)),
      multiple: Number(mult.toFixed(2)),
    },
  };
}

function recomputeScopedLeaderboard(scope, { verbose = false } = {}) {
  const d = db();
  const prefix = scope === 'premig' ? 'premig' : 'postmig';
  const table = `wallet_leaderboard_${scope}`;
  // Sample requirement is lower for scoped boards — scoped windows have less
  // data than total. Postmig especially is sparse early after deploy.
  const minClosed = scope === 'premig' ? 10 : 5;
  const candidates = d.prepare(`
    SELECT
      w.address,
      COALESCE(w.${prefix}_realized_pnl_30d, 0) AS realized_pnl_30d,
      COALESCE(w.${prefix}_closed_30d, 0) AS closed_30d,
      CASE WHEN COALESCE(w.${prefix}_closed_30d, 0) > 0
        THEN CAST(COALESCE(w.${prefix}_wins_30d, 0) AS REAL) / w.${prefix}_closed_30d
        ELSE 0 END AS win_rate_30d,
      CASE WHEN COALESCE(w.${prefix}_multiple_count_30d, 0) > 0
        THEN COALESCE(w.${prefix}_multiple_sum_30d, 0) / w.${prefix}_multiple_count_30d
        ELSE 0 END AS avg_multiple_30d,
      COALESCE(w.sniper_ratio, 0) AS sniper_ratio,
      COALESCE(w.avg_hold_seconds, 0) AS avg_hold_seconds
    FROM wallets w
    WHERE COALESCE(w.${prefix}_closed_30d, 0) >= ?
      AND COALESCE(w.sniper_ratio, 0) <= 0.30
      AND COALESCE(w.first_block_ratio, 0) <= 0.20
      AND COALESCE(w.avg_hold_seconds, 0) >= 60
      AND COALESCE(w.trade_count_30d, 0) <= 1500
      AND COALESCE(w.category, 'NOT_SURE') NOT IN ('SCALPER', 'BOT', 'BUNDLE')
      AND COALESCE(w.bundle_cluster_id, '') = ''
  `).all(minClosed);

  if (!candidates.length) {
    if (verbose) console.log(`[leaderboard-${scope}] no candidates yet — skipping`);
    return { scanned: 0, top: 0 };
  }

  const scored = candidates.map(c => ({ ...c, ...scoreScoped(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SLOTS);

  const insert = d.prepare(`INSERT INTO ${table}
    (address, rank, tier, score, realized_pnl_30d, win_rate_30d, closed_30d,
     avg_multiple_30d, sniper_ratio, avg_hold_seconds, components_json, label, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fetchLabel = d.prepare('SELECT label FROM wallets WHERE address = ?');
  const now = Date.now();

  const tx = d.transaction(() => {
    d.exec(`DELETE FROM ${table}`);
    scored.forEach((c, i) => {
      const rank = i + 1;
      // Tier label is purely positional on scoped boards (no separate floors).
      const tier = rank <= KOL_SLOTS ? 'KOL' : rank <= HIGH_END ? 'HIGH' : 'TRACKED';
      const label = fetchLabel.get(c.address)?.label || null;
      insert.run(
        c.address, rank, tier, c.score,
        c.realized_pnl_30d, c.win_rate_30d, c.closed_30d,
        c.avg_multiple_30d, c.sniper_ratio, c.avg_hold_seconds,
        JSON.stringify(c.components), label, now,
      );
    });
  });
  tx();

  if (verbose) {
    const top3 = scored.slice(0, 3).map(c => `${c.address.slice(0, 6)}=${c.score.toFixed(1)}`).join(', ');
    console.log(`[leaderboard-${scope}] scanned ${candidates.length} · top ${scored.length} · top3=${top3}`);
  }
  return { scanned: candidates.length, top: scored.length };
}

export function recomputeAllLeaderboards({ verbose = false } = {}) {
  const combined = recomputeLeaderboard({ verbose });
  const premig = recomputeScopedLeaderboard('premig', { verbose });
  const postmig = recomputeScopedLeaderboard('postmig', { verbose });
  return { combined, premig, postmig };
}

export function scopedLeaderboardAddresses(scope, maxRank = SLOTS) {
  const table = `wallet_leaderboard_${scope}`;
  return db().prepare(`SELECT address FROM ${table} WHERE rank <= ? ORDER BY rank`)
    .all(maxRank).map(r => r.address);
}

// Wallets present on BOTH scoped boards — elite generalists.
export function leaderboardIntersection(maxRank = SLOTS) {
  return db().prepare(`
    SELECT p.address, p.rank AS premig_rank, q.rank AS postmig_rank,
           p.score AS premig_score, q.score AS postmig_score
    FROM wallet_leaderboard_premig p
    JOIN wallet_leaderboard_postmig q ON q.address = p.address
    WHERE p.rank <= ? AND q.rank <= ?
    ORDER BY (p.rank + q.rank) ASC
  `).all(maxRank, maxRank);
}

export function tierFor(address) {
  const r = db().prepare('SELECT tier FROM wallet_leaderboard WHERE address = ?').get(address);
  return r ? r.tier : null;
}

export function startWalletLeaderboard() {
  // Auto-recompute re-enabled 2026-05-10 after bot-filter cut candidate pool
  // from ~7,800 → ~3,000 wallets. Recompute time dropped from 13-77s to ~3s
  // synchronously — well within tolerable blocking. Run every 2h so the
  // leaderboard stays fresh without hammering DB.
  //
  // Previously the auto-tick was disabled because correlated subqueries
  // across 6,000+ candidates blocked the event loop for tens of seconds,
  // causing WebSocket heartbeat misses. The filter for HFT scalpers (which
  // were the dominant noise) solves both that problem AND the Helius credit
  // burn from per-event webhook delivery on scalper wallets.
  // 2026-05-13 PM: AUTO_INTERVAL was 2h while the module constant said 30min —
  // log was lying. Unified on RECOMPUTE_INTERVAL_MS (now 15min) so the actual
  // recompute matches what we say. Each pass is ~3s on ~3k candidates.
  // 2026-05-14: bumped from 60s to 5min — the 13-16s initial recompute
  // was dropping WSS shortly after boot. Stagger past the early boot
  // storm so connections stabilize first.
  setTimeout(() => {
    try { recomputeAllLeaderboards({ verbose: true }); }
    catch (err) { console.error('[leaderboard] initial', err.message); }
  }, 5 * 60 * 1000);
  setInterval(() => {
    try { recomputeAllLeaderboards({ verbose: true }); }
    catch (err) { console.error('[leaderboard] tick', err.message); }
  }, RECOMPUTE_INTERVAL_MS);
  console.log(`[leaderboard] started · combined + premig + postmig recompute every ${RECOMPUTE_INTERVAL_MS / 60000}min`);
}
