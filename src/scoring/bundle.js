import { db } from '../db/index.js';
import { config } from '../config.js';

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) { this.parent.set(x, x); return x; }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  groups() {
    const out = new Map();
    for (const x of this.parent.keys()) {
      const r = this.find(x);
      if (!out.has(r)) out.set(r, new Set());
      out.get(r).add(x);
    }
    return [...out.values()];
  }
}

export function detectBundles() {
  const d = db();
  const since = Date.now() - config.bundle.maxAgeMs;
  const cohorts = d.prepare(`
    SELECT mint_address, GROUP_CONCAT(DISTINCT wallet) AS wallets
    FROM trades
    WHERE is_buy = 1
      AND seconds_from_creation <= ?
      AND timestamp > ?
    GROUP BY mint_address
    HAVING COUNT(DISTINCT wallet) BETWEEN ? AND ?
    ORDER BY mint_address DESC
    LIMIT ?
  `).all(
    config.bundle.cohortMaxSeconds,
    since,
    config.bundle.cohortMinSize,
    config.bundle.cohortMaxSize,
    config.bundle.maxMintsPerSweep
  );

  if (!cohorts.length) return { clusters: 0, mintsScanned: 0 };

  const pairCounts = new Map();
  for (const c of cohorts) {
    if (!c.wallets) continue;
    const ws = c.wallets.split(',').filter(Boolean);
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        const a = ws[i], b = ws[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  const uf = new UnionFind();
  for (const [key, count] of pairCounts) {
    if (count >= config.bundle.minCoincidences) {
      const [a, b] = key.split('|');
      uf.union(a, b);
    }
  }

  const groups = uf.groups().filter(g => g.size >= config.bundle.minClusterSize);

  d.prepare('UPDATE wallets SET bundle_cluster_id = NULL').run();
  d.prepare('DELETE FROM bundle_clusters').run();

  const upsertCluster = d.prepare(`INSERT INTO bundle_clusters
    (cluster_id, member_count, mint_count, total_realized_pnl, members, detected_at, last_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tagMember = d.prepare('UPDATE wallets SET bundle_cluster_id = ?, category = ? WHERE address = ?');
  const mintTouched = d.prepare(`
    SELECT COUNT(DISTINCT mint_address) AS n
    FROM wallet_holdings WHERE wallet IN (SELECT value FROM json_each(?))
  `);
  const totalPnl = d.prepare(`
    SELECT COALESCE(SUM(realized_pnl), 0) AS s
    FROM wallets WHERE address IN (SELECT value FROM json_each(?))
  `);

  const now = Date.now();
  let clusterIdx = 1;
  let totalClusters = 0;

  for (const g of groups) {
    const members = [...g];
    const id = `cluster_${clusterIdx++}_${members.length}w`;
    const json = JSON.stringify(members);
    let mintCount = 0;
    let pnl = 0;
    try { mintCount = mintTouched.get(json).n; } catch {}
    try { pnl = totalPnl.get(json).s; } catch {}
    upsertCluster.run(id, members.length, mintCount, pnl, json, now, now);
    for (const m of members) tagMember.run(id, 'BUNDLE', m);
    totalClusters++;
  }

  return { clusters: totalClusters, mintsScanned: cohorts.length };
}

export function startBundleSweep() {
  setTimeout(() => {
    try {
      const r = detectBundles();
      console.log(`[bundle] initial sweep: ${r.clusters} clusters from ${r.mintsScanned} mints`);
    } catch (err) {
      console.error('[bundle] initial', err.message);
    }
  }, 15000);

  setInterval(() => {
    try {
      const r = detectBundles();
      if (r.clusters > 0) console.log(`[bundle] sweep: ${r.clusters} clusters from ${r.mintsScanned} mints`);
    } catch (err) {
      console.error('[bundle] sweep', err.message);
    }
  }, config.bundle.intervalMs);
}
