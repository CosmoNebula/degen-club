// DexScreener pool selection. A migrated pump.fun mint usually has 1-3 pools:
// pump-amm (canonical post-migration home), sometimes a Raydium fork, occasionally
// a stale clone with deep liquidity but zero activity. Picking "highest liquidity"
// blindly causes us to track dead pools and miss the real price action.
//
// Selection order:
//   1. Pinned pool — if caller passed preferredPoolAddress and it's still in the
//      list, keep it UNLESS another pool has recent activity and the pinned one
//      doesn't. Pool-pinning stability matters: flipping pools mid-position
//      causes the spike-up/down guards to fire on the price gap between pools.
//   2. Active pump-amm — pump.fun's own AMM is the canonical post-migration
//      venue. If a pump pool has h1 volume, prefer it.
//   3. Active any-dex, highest liquidity.
//   4. Fallback: highest liquidity even if quiet (better than nothing).

// pumpfun = pump.fun bonding curve (PRE-migration). Once a coin migrates,
// the BC pool drains and DexScreener may still list it with stale/$0 data.
// Picking it post-migration gives us frozen migration-moment price. Excluding
// it forces us to wait for the real AMM pool to be indexed (pumpswap,
// pumpfun-amm, raydium, etc.) or fall back to helius-tx.
const DEAD_BC_DEX = new Set(['pumpfun']);
const isAmmDex = (p) => p.dexId && !DEAD_BC_DEX.has(p.dexId.toLowerCase());
const isPumpAmmDex = (p) => {
  const id = (p.dexId || '').toLowerCase();
  return id !== 'pumpfun' && id.startsWith('pump');
};

function hasRecentActivity(p) {
  const h1Vol = p.volume?.h1 || 0;
  const h24Vol = p.volume?.h24 || 0;
  const h24Buys = p.txns?.h24?.buys || 0;
  return h1Vol > 0 || (h24Vol > 0 && h24Buys > 0);
}

function pickBestByLiquidity(pools) {
  return pools.reduce((best, p) =>
    (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? p : best, pools[0]);
}

export function pickPool(pools, preferredPoolAddress = null, opts = {}) {
  const { isMigrated = false } = opts;
  if (!Array.isArray(pools) || !pools.length) return null;
  let valid = pools.filter(p => {
    const liq = p.liquidity?.usd || 0;
    const price = parseFloat(p.priceNative);
    return liq > 0 && Number.isFinite(price) && price > 0;
  });
  // For migrated coins, the dead BC pool is poison — its prices are
  // frozen at the migration moment. Hard-exclude it from selection.
  if (isMigrated) valid = valid.filter(isAmmDex);
  if (!valid.length) return null;

  if (preferredPoolAddress) {
    const pinned = valid.find(p => p.pairAddress === preferredPoolAddress);
    if (pinned) {
      const anyOtherActive = valid.some(p =>
        p.pairAddress !== preferredPoolAddress && hasRecentActivity(p));
      if (hasRecentActivity(pinned) || !anyOtherActive) return pinned;
    }
  }

  const pumpActive = valid.filter(p => isPumpAmmDex(p) && hasRecentActivity(p));
  if (pumpActive.length) return pickBestByLiquidity(pumpActive);

  const active = valid.filter(hasRecentActivity);
  if (active.length) return pickBestByLiquidity(active);

  return pickBestByLiquidity(valid);
}
