import { db } from '../db/index.js';
import { config } from '../config.js';
import { getSolUsd } from '../price.js';
import { heliusWS } from './helius.js';

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    moonbagMints: d.prepare(`SELECT DISTINCT mint_address FROM paper_positions
      WHERE status = 'open' AND is_moonbag = 1`),
    openLiveMints: d.prepare(`SELECT DISTINCT mint_address FROM paper_positions
      WHERE status = 'open' AND (is_moonbag = 0 OR is_moonbag IS NULL)`),
    updateMint: d.prepare(`UPDATE mints SET
      last_price_sol = ?, current_market_cap_sol = ?,
      peak_market_cap_sol = MAX(peak_market_cap_sol, ?),
      last_trade_at = ?
      WHERE mint_address = ?`),
    setPoolAddress: d.prepare('UPDATE paper_positions SET pool_address = ? WHERE id = ?'),
    findByPool: d.prepare('SELECT mint_address FROM paper_positions WHERE pool_address = ? AND status = \'open\' AND is_moonbag = 1 LIMIT 1'),
    needsPool: d.prepare('SELECT id, mint_address FROM paper_positions WHERE status = \'open\' AND is_moonbag = 1 AND (pool_address IS NULL OR pool_address = \'\')'),
  };
  return stmts;
}

export async function fetchDexscreenerPrice(mintAddress) {
  const url = `${config.dexscreener.apiBase}/tokens/v1/solana/${mintAddress}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(config.dexscreener.timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const pool = data.reduce((best, p) =>
      (p.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? p : best, data[0]);
    return {
      priceUsd: parseFloat(pool.priceUsd) || 0,
      priceNative: parseFloat(pool.priceNative) || 0,
      fdvUsd: pool.fdv || 0,
      liquidityUsd: pool.liquidity?.usd || 0,
      volume24hUsd: pool.volume?.h24 || 0,
      poolAddress: pool.pairAddress || null,
      dex: pool.dexId || null,
    };
  } catch (err) {
    return null;
  }
}

async function refreshMintPrice(mintAddress) {
  const data = await fetchDexscreenerPrice(mintAddress);
  if (!data || !data.priceNative || data.priceNative <= 0) return null;
  const solUsd = getSolUsd() || 1;
  const mcapSol = solUsd > 0 ? (data.fdvUsd / solUsd) : 0;
  try {
    S().updateMint.run(data.priceNative, mcapSol, mcapSol, Date.now(), mintAddress);
    if (data.poolAddress) {
      const positions = db().prepare("SELECT id, pool_address FROM paper_positions WHERE mint_address = ? AND is_moonbag = 1 AND status = 'open'").all(mintAddress);
      for (const p of positions) {
        if (!p.pool_address || p.pool_address !== data.poolAddress) {
          S().setPoolAddress.run(data.poolAddress, p.id);
          heliusWS.subscribePool(data.poolAddress);
        }
      }
    }
  } catch (err) {
    console.error('[dexscreener] update', err.message);
  }
  return data;
}

export function startMoonbagPriceFeed() {
  const interval = config.moonbag.pricePollIntervalMs || 10000;

  heliusWS.on('swap', async (poolAddr) => {
    try {
      const row = S().findByPool.get(poolAddr);
      if (row) await refreshMintPrice(row.mint_address);
    } catch (err) { console.error('[dexscreener] swap-trigger', err.message); }
  });

  setInterval(async () => {
    try {
      const mints = S().moonbagMints.all();
      if (!mints.length) return;
      for (const m of mints) {
        await refreshMintPrice(m.mint_address);
      }
      const needsPool = S().needsPool.all();
      for (const p of needsPool) {
        const data = await fetchDexscreenerPrice(p.mint_address);
        if (data?.poolAddress) {
          S().setPoolAddress.run(data.poolAddress, p.id);
          heliusWS.subscribePool(data.poolAddress);
        }
      }
    } catch (err) {
      console.error('[dexscreener] poll', err.message);
    }
  }, interval);
}

export function startOpenPositionPriceFeed() {
  const interval = config.dexscreener?.openPosPollMs || 3000;
  setInterval(async () => {
    try {
      const mints = S().openLiveMints.all();
      if (!mints.length) return;
      await Promise.all(mints.map(m => refreshMintPrice(m.mint_address).catch(() => null)));
    } catch (err) {
      console.error('[dexscreener] open-pos poll', err.message);
    }
  }, interval);
}
