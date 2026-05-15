// Wallet ring detection: groups of wallets that buy the same mints together.
//
// Approach:
//   1. Universe = wallets with ≥ MIN_ACTIVITY distinct mint buys (cuts 92k → ~5k)
//   2. Find pairs of wallets sharing ≥ MIN_OVERLAP mints (strong co-trade signal)
//   3. Union-find over pairs → connected components are "rings"
//   4. Persist rings + tag wallet rows with ring_id
//   5. Compute aggregate paper W/L per ring (joins to our paper_positions)
//
// Threshold tuning (current defaults match the v3-run finding where 3 wallets
// hit 9 of 10 winners — ≥8 shared mints out of a ≥10-mint universe is a strong
// "same operator / copy ring" signal without flagging coincidental overlap).

import { db } from '../db/index.js';
import crypto from 'node:crypto';

const MIN_ACTIVITY = 10;       // wallet must have bought this many distinct mints
const MIN_OVERLAP = 8;         // pair must share this many mints to be "linked"
const MIN_JACCARD = 0.50;      // pair must share ≥50% of their combined mint set (filters supernode)
const MIN_RING_SIZE = 2;       // 2-wallet ring is the minimum
// 2026-05-15: skip "hot" mints in the pair-build step. A mint bought by >100
// active wallets generates >5K pairs by itself and contributes nothing toward
// ring detection (the ring members AND ~100 unrelated traders bought it, so
// it's not ring-discriminating). Capping here cuts the Cartesian by ~91%
// (243s → ~10-20s on the current dataset) without losing any real ring.
const MAX_MINT_HEAT = 100;

// Stable ring ID from the sorted member set (so the same group keeps the same id
// across redetections, and the ring's W/L history sticks).
function ringIdFor(members) {
  const h = crypto.createHash('sha1');
  h.update(members.slice().sort().join('\n'));
  return 'r_' + h.digest('hex').slice(0, 12);
}

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) { this.parent.set(x, x); return x; }
    let cur = x;
    while (this.parent.get(cur) !== cur) cur = this.parent.get(cur);
    // Path compression
    let walk = x;
    while (this.parent.get(walk) !== cur) {
      const next = this.parent.get(walk);
      this.parent.set(walk, cur);
      walk = next;
    }
    return cur;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  groups() {
    const out = new Map();
    for (const k of this.parent.keys()) {
      const r = this.find(k);
      if (!out.has(r)) out.set(r, []);
      out.get(r).push(k);
    }
    return [...out.values()];
  }
}

export function detectRings({
  minActivity = MIN_ACTIVITY,
  minOverlap = MIN_OVERLAP,
  minJaccard = MIN_JACCARD,
  verbose = false,
} = {}) {
  const d = db();
  const t0 = Date.now();

  // Find pairs of wallets that share ≥ minOverlap distinct mints AND have a
  // Jaccard similarity (|A∩B|/|A∪B|) above minJaccard. The Jaccard floor is
  // critical — without it, busy traders collapse into one giant supernode
  // because they all share many of the same hot mints just by volume.
  const pairs = d.prepare(`
    WITH active AS (
      SELECT wallet, COUNT(DISTINCT mint_address) total
      FROM trades WHERE is_buy = 1
      GROUP BY wallet HAVING total >= ?
    ),
    wm AS (
      SELECT DISTINCT t.wallet, t.mint_address
      FROM trades t JOIN active a ON a.wallet = t.wallet
      WHERE t.is_buy = 1
    ),
    -- 2026-05-15: drop "hot" mints (>MAX_MINT_HEAT active buyers) before the
    -- Cartesian join. These were ~91% of the pair-generation cost yet
    -- contribute zero ring signal (they're noise everyone bought).
    mint_heat AS (
      SELECT mint_address FROM wm GROUP BY mint_address HAVING COUNT(*) <= ?
    ),
    wm_filtered AS (
      SELECT wm.wallet, wm.mint_address
      FROM wm JOIN mint_heat USING (mint_address)
    ),
    raw_pairs AS (
      SELECT a.wallet w1, b.wallet w2, COUNT(*) shared
      FROM wm_filtered a JOIN wm_filtered b
        ON a.mint_address = b.mint_address AND a.wallet < b.wallet
      GROUP BY a.wallet, b.wallet HAVING shared >= ?
    )
    SELECT p.w1, p.w2, p.shared,
           1.0 * p.shared / (ac1.total + ac2.total - p.shared) jaccard
    FROM raw_pairs p
    JOIN active ac1 ON ac1.wallet = p.w1
    JOIN active ac2 ON ac2.wallet = p.w2
    WHERE 1.0 * p.shared / (ac1.total + ac2.total - p.shared) >= ?
  `).all(minActivity, MAX_MINT_HEAT, minOverlap, minJaccard);

  if (verbose) console.log(`[wallet-rings] ${pairs.length} linked pairs found in ${Date.now() - t0}ms`);

  // Union-find: each linked pair joins their components.
  const uf = new UnionFind();
  for (const p of pairs) uf.union(p.w1, p.w2);

  const components = uf.groups().filter(g => g.length >= MIN_RING_SIZE);
  if (verbose) console.log(`[wallet-rings] ${components.length} rings (${components.reduce((s, g) => s + g.length, 0)} wallets total)`);

  // For each ring, compute shared-mint count (how many distinct mints any 2+ members co-bought)
  // and paper W/L stats.
  const upsertRing = d.prepare(`INSERT INTO wallet_rings
    (id, size, shared_mint_count, detected_at, updated_at, paper_wins, paper_losses, paper_net_sol, distinct_mints_bought)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      size = excluded.size,
      shared_mint_count = excluded.shared_mint_count,
      updated_at = excluded.updated_at,
      paper_wins = excluded.paper_wins,
      paper_losses = excluded.paper_losses,
      paper_net_sol = excluded.paper_net_sol,
      distinct_mints_bought = excluded.distinct_mints_bought`);
  const tagWallet = d.prepare(`UPDATE wallets SET ring_id = ? WHERE address = ?`);
  const clearRings = d.prepare(`UPDATE wallets SET ring_id = NULL WHERE ring_id IS NOT NULL`);
  const wipeRings = d.prepare(`DELETE FROM wallet_rings`);

  // Stats queries (precompiled, run per ring with placeholders)
  const distinctMintsForRing = (members) => {
    const ph = members.map(() => '?').join(',');
    return d.prepare(`SELECT COUNT(DISTINCT mint_address) AS n FROM trades WHERE is_buy = 1 AND wallet IN (${ph})`).get(...members).n;
  };
  const paperStatsForRing = (members) => {
    const ph = members.map(() => '?').join(',');
    return d.prepare(`
      SELECT
        SUM(CASE WHEN p.realized_pnl_sol > 0 THEN 1 ELSE 0 END) wins,
        SUM(CASE WHEN p.realized_pnl_sol <= 0 THEN 1 ELSE 0 END) losses,
        COALESCE(SUM(p.realized_pnl_sol), 0) net_sol
      FROM paper_positions p
      WHERE p.status = 'closed'
        AND p.mint_address IN (
          SELECT DISTINCT mint_address FROM trades
          WHERE is_buy = 1 AND wallet IN (${ph})
        )
    `).get(...members);
  };
  const sharedMintCountForRing = (members) => {
    const ph = members.map(() => '?').join(',');
    return d.prepare(`
      SELECT COUNT(*) n FROM (
        SELECT mint_address FROM trades
        WHERE is_buy = 1 AND wallet IN (${ph})
        GROUP BY mint_address HAVING COUNT(DISTINCT wallet) >= 2
      )
    `).get(...members).n;
  };

  // Wipe + per-ring upsert in SEPARATE transactions. A single big tx held the
  // write lock for ~70s while computing stats per ring, blocking every other
  // writer (trade inserts especially) and triggering "database is locked"
  // storms. Per-ring tx releases the lock between rings.
  d.transaction(() => { clearRings.run(); wipeRings.run(); })();
  const now = Date.now();
  for (const members of components) {
    try {
      const id = ringIdFor(members);
      const distinctMints = distinctMintsForRing(members);
      const sharedMints = sharedMintCountForRing(members);
      const paper = paperStatsForRing(members);
      d.transaction(() => {
        upsertRing.run(
          id, members.length, sharedMints, now, now,
          paper?.wins || 0, paper?.losses || 0, paper?.net_sol || 0,
          distinctMints,
        );
        for (const w of members) tagWallet.run(id, w);
      })();
    } catch (err) {
      console.error('[wallet-rings] ring upsert', err.message);
    }
  }

  const took = Date.now() - t0;
  if (verbose) console.log(`[wallet-rings] persisted ${components.length} rings in ${took}ms`);
  return { rings: components.length, wallets: components.reduce((s, g) => s + g.length, 0), pairs: pairs.length, ms: took };
}

export function listRings({ limit = 50, minSize = 2, sortBy = 'paper_net_sol' } = {}) {
  const d = db();
  const allowedSort = new Set(['paper_net_sol', 'paper_wins', 'paper_losses', 'size', 'shared_mint_count', 'distinct_mints_bought', 'detected_at']);
  const order = allowedSort.has(sortBy) ? sortBy : 'paper_net_sol';
  return d.prepare(`
    SELECT id, size, shared_mint_count, distinct_mints_bought,
           paper_wins, paper_losses, ROUND(paper_net_sol, 4) paper_net_sol,
           CASE WHEN paper_wins + paper_losses > 0
             THEN ROUND(100.0 * paper_wins / (paper_wins + paper_losses), 1)
             ELSE NULL END paper_wr,
           label, detected_at, updated_at
    FROM wallet_rings
    WHERE size >= ?
    ORDER BY ${order} DESC, size DESC
    LIMIT ?
  `).all(minSize, limit);
}

export function getRingMembers(ringId) {
  const d = db();
  return d.prepare(`
    SELECT address, ROUND(realized_pnl_30d, 3) pnl_30d, win_rate_30d wr_30d,
           closed_30d, category, is_kol, tracked,
           ROUND(migrator_score, 3) migrator_score, migrator_pre_mig_buys,
           last_activity_at
    FROM wallets WHERE ring_id = ?
    ORDER BY realized_pnl_30d DESC
  `).all(ringId);
}
