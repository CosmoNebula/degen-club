import { db } from '../db/index.js';
import { config } from '../config.js';
import { onVolumeSurge } from '../trading/strategies.js';

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    candidateMints: d.prepare(`
      SELECT mint_address, created_at, last_trade_at, last_price_sol,
             current_market_cap_sol, v_sol_in_curve, migrated, rugged, flags
      FROM mints
      WHERE migrated = 0 AND rugged = 0
        AND last_trade_at > ?
        AND created_at > ?
      ORDER BY last_trade_at DESC LIMIT 500
    `),
    currentWindowStats: d.prepare(`
      SELECT
        COUNT(*) AS buys,
        COUNT(DISTINCT wallet) AS unique_buyers,
        COALESCE(SUM(sol_amount), 0) AS sol_in,
        MIN(price_sol) AS first_price,
        MAX(timestamp) AS last_ts,
        MIN(timestamp) AS first_ts
      FROM trades
      WHERE mint_address = ? AND is_buy = 1 AND timestamp > ?
    `),
    baselineBuys: d.prepare(`
      SELECT COUNT(*) AS n
      FROM trades
      WHERE mint_address = ? AND is_buy = 1
        AND timestamp BETWEEN ? AND ?
    `),
    priceAtTime: d.prepare(`
      SELECT price_sol FROM trades
      WHERE mint_address = ? AND price_sol IS NOT NULL AND timestamp <= ?
      ORDER BY timestamp DESC LIMIT 1
    `),
    recentVolumeSignal: d.prepare(`
      SELECT id FROM volume_signals
      WHERE mint_address = ? AND fired_at > ?
      ORDER BY fired_at DESC LIMIT 1
    `),
    insertVolumeSignal: d.prepare(`
      INSERT INTO volume_signals
      (mint_address, fired_at, velocity_ratio, current_buys_per_min, baseline_buys_per_min,
       unique_buyers, sol_inflow, price_change_pct, score, has_tracked_overlap,
       suggested_entry_sol, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    trackedRecentBuyOnMint: d.prepare(`
      SELECT 1 FROM trades t
      JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp > ?
        AND w.tracked = 1
      LIMIT 1
    `),
  };
  return stmts;
}

function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }

function computeScore({ velocityRatio, uniqueBuyers, priceChange, hasTrackedOverlap }) {
  const cfg = config.volumeSurge.sizing;
  let score = clamp(velocityRatio / cfg.maxVelocityRatioForScore, 0, 1);
  const buyerComponent = 0.5 + clamp(uniqueBuyers / cfg.maxBuyerCountForScore, 0, 1) * 0.5;
  score *= buyerComponent;
  if (priceChange > cfg.priceMomentumThreshold) score *= cfg.priceMomentumBonus;
  if (hasTrackedOverlap) score *= cfg.confluenceBonus;
  return clamp(score, 0, 1);
}

function suggestedEntry(score) {
  const cfg = config.volumeSurge.sizing;
  const raw = cfg.baseEntrySol * (0.5 + score * 1.5);
  return clamp(raw, cfg.minEntrySol, cfg.maxEntrySol);
}

export function detectSurges() {
  const cfg = config.volumeSurge;
  const s = S();
  const now = Date.now();
  const currentCutoff = now - cfg.currentWindowSec * 1000;
  const baselineStart = now - (cfg.currentWindowSec + cfg.baselineWindowSec) * 1000;
  const baselineEnd = currentCutoff;
  const dedupeSince = now - cfg.cooldownMinutes * 60000;
  const trackedLookback = now - cfg.confluenceLookbackSec * 1000;
  const lastTradeCutoff = now - cfg.currentWindowSec * 1000;
  const minMintAgeCutoff = now - cfg.maxMintAgeMinutes * 60000;

  const mints = s.candidateMints.all(lastTradeCutoff, minMintAgeCutoff);
  let fired = 0;

  for (const m of mints) {
    try {
      let mflags = [];
      try { mflags = JSON.parse(m.flags || '[]'); } catch {}
      if (cfg.skipFlags.some(f => mflags.includes(f))) continue;

      const curveProgress = (m.v_sol_in_curve || 0) / 85;
      if (curveProgress >= cfg.maxCurveProgress) continue;

      const cur = s.currentWindowStats.get(m.mint_address, currentCutoff);
      if (!cur || !cur.buys) continue;

      const currentBuysPerMin = cur.buys * 60 / cfg.currentWindowSec;
      if (currentBuysPerMin < cfg.minBuysPerMin) continue;
      if ((cur.unique_buyers || 0) < cfg.minUniqueBuyers) continue;

      const baseline = s.baselineBuys.get(m.mint_address, baselineStart, baselineEnd);
      const baselineBuysPerMin = (baseline?.n || 0) * 60 / cfg.baselineWindowSec;
      const denom = Math.max(baselineBuysPerMin, cfg.minBaselineBuysPerMin);
      const velocityRatio = currentBuysPerMin / denom;
      if (velocityRatio < cfg.minVelocityRatio) continue;

      const priceBefore = s.priceAtTime.get(m.mint_address, currentCutoff);
      const priceNow = m.last_price_sol || 0;
      const priceChange = (priceBefore && priceBefore.price_sol > 0)
        ? (priceNow - priceBefore.price_sol) / priceBefore.price_sol
        : 0;
      if (priceChange <= cfg.minPriceChange) continue;
      if (priceChange > cfg.maxPriceChangeAtFire) continue;

      const recent = s.recentVolumeSignal.get(m.mint_address, dedupeSince);
      if (recent) continue;

      const hasTrackedOverlap = !!s.trackedRecentBuyOnMint.get(m.mint_address, trackedLookback);

      const score = computeScore({ velocityRatio, uniqueBuyers: cur.unique_buyers, priceChange, hasTrackedOverlap });
      const suggested = suggestedEntry(score);

      s.insertVolumeSignal.run(
        m.mint_address, now,
        +velocityRatio.toFixed(2),
        +currentBuysPerMin.toFixed(2),
        +baselineBuysPerMin.toFixed(2),
        cur.unique_buyers || 0,
        +(cur.sol_in || 0).toFixed(4),
        +priceChange.toFixed(4),
        +score.toFixed(3),
        hasTrackedOverlap ? 1 : 0,
        +suggested.toFixed(4),
        JSON.stringify({
          curveProgress: +curveProgress.toFixed(2),
          windowSec: cfg.currentWindowSec,
        })
      );
      console.log(`[volume-surge] ${m.mint_address.slice(0, 8)}… ratio=${velocityRatio.toFixed(1)}× buys=${currentBuysPerMin.toFixed(0)}/min uniq=${cur.unique_buyers} priceΔ=${(priceChange*100).toFixed(1)}% score=${score.toFixed(2)} entry=${suggested.toFixed(3)}`);

      try {
        onVolumeSurge(m.mint_address, {
          velocity_ratio: velocityRatio,
          unique_buyers: cur.unique_buyers,
          price_change_pct: priceChange,
          score,
          has_tracked_overlap: hasTrackedOverlap,
          suggested_entry_sol: suggested,
        });
      } catch (err) {
        console.error('[volume-surge] strategy hook', err.message);
      }
      fired++;
    } catch (err) {
      console.error('[volume-surge]', err.message);
    }
  }
  return { mintsScanned: mints.length, fired };
}

export function startVolumeSurgeSweep() {
  setInterval(() => {
    try { detectSurges(); }
    catch (err) { console.error('[volume-surge] sweep', err.message); }
  }, config.volumeSurge.sweepIntervalMs);
}
