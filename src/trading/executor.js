import { isLiveMode, getSolBalance, getTokenBalance } from './wallet.js';
import { buy as pfBuy, sell as pfSell } from './pumpportal-client.js';
import { checkPreTrade, isHalted } from './safety.js';
import { config } from '../config.js';
import { db } from '../db/index.js';

const SLIPPAGE_BPS = config.photon?.slippageBps || 1500;

export async function executeBuy({ mint, solAmount, strategy, triggerPrice = null, force = false }) {
  if (!force && !isLiveMode()) return { mode: 'paper', success: true };
  if (isHalted()) return { mode: 'live', success: false, error: 'halted' };

  const safety = checkPreTrade(strategy, solAmount);
  if (!safety.ok) {
    console.log(`[live] safety reject: ${safety.reason}`);
    return { mode: 'live', success: false, error: safety.reason };
  }

  const maxEntryDriftPct = config.safety?.maxEntrySlippagePct ?? 0.17;
  if (triggerPrice && triggerPrice > 0 && maxEntryDriftPct > 0) {
    const row = db().prepare('SELECT last_price_sol FROM mints WHERE mint_address = ?').get(mint);
    const curPrice = row?.last_price_sol || 0;
    if (curPrice > 0) {
      const drift = (curPrice - triggerPrice) / triggerPrice;
      if (drift > maxEntryDriftPct) {
        const msg = `STALE_QUOTE: price drifted ${(drift*100).toFixed(1)}% > ${(maxEntryDriftPct*100).toFixed(1)}% (trigger ${triggerPrice.toExponential(2)} → cur ${curPrice.toExponential(2)})`;
        console.log(`[live] BUY ABORT ${strategy} on ${mint.slice(0,8)}… ${msg}`);
        return { mode: 'live', success: false, error: msg };
      }
    }
  }

  const balance = await getSolBalance().catch(() => null);
  const minFloor = config.safety?.minWalletSolFloor || 0.05;
  if (balance !== null && balance < solAmount + minFloor) {
    return { mode: 'live', success: false, error: `wallet too low: ${balance.toFixed(4)} SOL` };
  }

  console.log(`[live] BUY ${strategy} mint=${mint.slice(0,8)}… ${solAmount} SOL`);
  const result = await pfBuy({ mint, solAmount, slippageBps: SLIPPAGE_BPS });

  if (!result.success) {
    console.log(`[live] BUY FAIL ${mint.slice(0,8)}… ${result.error} (${result.elapsedMs}ms)`);
    return { mode: 'live', success: false, error: result.error, elapsedMs: result.elapsedMs };
  }
  const fillPrice = (result.solSpent || solAmount) / Math.max(1, result.tokensReceived || 1);
  console.log(`[live] BUY OK ${mint.slice(0,8)}… ${result.tokensReceived} tokens @ ${fillPrice.toExponential(3)} (tx ${result.txSig?.slice(0,8)}…, ${result.elapsedMs}ms)`);
  return {
    mode: 'live', success: true,
    txSig: result.txSig,
    tokensReceived: result.tokensReceived,
    solSpent: result.solSpent,
    fillPrice,
    elapsedMs: result.elapsedMs,
  };
}

export async function executeSell({ mint, pct, reason, force = false }) {
  if (!force && !isLiveMode()) return { mode: 'paper', success: true };
  if (isHalted()) return { mode: 'live', success: false, error: 'halted' };

  const pctStr = `${(Math.min(100, Math.max(0, (pct || 0) * 100))).toFixed(2)}%`;
  console.log(`[live] SELL ${reason} mint=${mint.slice(0,8)}… ${pctStr} of bag`);
  const result = await pfSell({ mint, pct, slippageBps: SLIPPAGE_BPS });

  if (!result.success) {
    console.log(`[live] SELL FAIL ${mint.slice(0,8)}… ${result.error} (${result.elapsedMs}ms)`);
    return { mode: 'live', success: false, error: result.error, elapsedMs: result.elapsedMs };
  }
  console.log(`[live] SELL OK ${mint.slice(0,8)}… +${result.solReceived?.toFixed(4)} SOL (tx ${result.txSig?.slice(0,8)}…, ${result.elapsedMs}ms)`);
  import('./skim.js').then(skim => skim.checkAndSkim('post-sell')).catch(err => console.error('[skim] check failed:', err.message));
  return {
    mode: 'live', success: true,
    txSig: result.txSig,
    tokensSold: result.tokensSold,
    solReceived: result.solReceived,
    elapsedMs: result.elapsedMs,
  };
}

export async function preview() {
  const live = isLiveMode();
  const balance = live ? await getSolBalance().catch(() => null) : null;
  return { mode: live ? 'live' : 'paper', halted: isHalted(), walletSol: balance };
}
