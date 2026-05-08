// Backtest: simulate Option 1 (Bounce re-entry) and Option 2 (Phoenix strict)
// against the trades table for the last 24h of tracked-wallet buys.
//
// Baseline: kolCoattailsFlip-style strategy (sell 100% at +30%, SL at -45%).
// For each mint with at least one tracked-wallet buy, we treat the FIRST such
// buy as our entry event and simulate forward using the trades stream.
//
// Output: aggregate PnL for baseline vs baseline+Option1 vs baseline+Option2.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'degen.db'), { readonly: true });

const NOW = Date.now();
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const ENTRY_SOL = 0.10;

// Strategy params (matches kolCoattailsFlip)
const TARGET_PCT = 0.30;
const SL_PCT = -0.45;

// Re-entry params
const OPT1_WINDOW_MIN = 30;       // bounce-back time window
const OPT1_RECOVERY_RATIO = 0.80; // price must reach 80% of original entry
const OPT2_WINDOW_MIN = 10;       // tighter window
const OPT2_BOUNCE_RATIO = 1.5;    // price must recover 50% off SL bottom
const OPT2_BURST_TRADES = 3;      // 3+ buys in 30s
const OPT2_BURST_WINDOW_MS = 30 * 1000;
const OPT2_TIGHTER_SL = -0.30;    // tighter SL for Phoenix re-entry
const REENTRY_SIZE_RATIO = 0.50;  // re-enter at half size

// Friction model (paper friction config)
const FEE = 0.01;
const SLIP = 0.025;

function applyBuyFriction(solIn, price) {
  return (solIn * (1 - FEE)) / (price * (1 + SLIP));
}
function applySellFriction(tokens, price) {
  return tokens * price * (1 - SLIP) * (1 - FEE);
}

// Simulate a position from entry forward through trades.
// Returns { exit_reason, exit_price, exit_idx, peak_price, pnl_sol }
function simulatePosition(entryPrice, entrySol, trades, startIdx, slPct) {
  const tokens = applyBuyFriction(entrySol, entryPrice);
  let peak = entryPrice;
  for (let i = startIdx; i < trades.length; i++) {
    const t = trades[i];
    const p = t.price_sol || 0;
    if (p <= 0) continue;
    if (p > peak) peak = p;
    const pctFromEntry = (p - entryPrice) / entryPrice;
    if (pctFromEntry >= TARGET_PCT) {
      const sol = applySellFriction(tokens, p);
      return { exit_reason: 'TARGET_HIT', exit_price: p, exit_idx: i, peak_price: peak, pnl_sol: sol - entrySol };
    }
    if (pctFromEntry <= slPct) {
      const sol = applySellFriction(tokens, p);
      return { exit_reason: 'SL_HIT', exit_price: p, exit_idx: i, peak_price: peak, pnl_sol: sol - entrySol };
    }
  }
  // ran out of data — close at last price as 'OPEN_END'
  const lastP = trades[trades.length - 1]?.price_sol || entryPrice;
  const sol = applySellFriction(tokens, lastP);
  return { exit_reason: 'OPEN_END', exit_price: lastP, exit_idx: trades.length - 1, peak_price: peak, pnl_sol: sol - entrySol };
}

// Find Option 1 re-entry index after SL
function findOption1ReEntry(trades, slIdx, slTime, originalEntryPrice) {
  const cutoff = slTime + OPT1_WINDOW_MIN * 60 * 1000;
  for (let i = slIdx + 1; i < trades.length; i++) {
    const t = trades[i];
    if (t.timestamp > cutoff) return null;
    if (!t.is_buy) continue;
    if (!t.is_tracked) continue;
    if ((t.price_sol || 0) >= originalEntryPrice * OPT1_RECOVERY_RATIO) {
      return i;
    }
  }
  return null;
}

// Find Option 2 re-entry index after SL (volume burst + price recovery)
function findOption2ReEntry(trades, slIdx, slTime, slPrice) {
  const cutoff = slTime + OPT2_WINDOW_MIN * 60 * 1000;
  let bottom = slPrice;
  for (let i = slIdx + 1; i < trades.length; i++) {
    const t = trades[i];
    if (t.timestamp > cutoff) return null;
    const p = t.price_sol || 0;
    if (p > 0 && p < bottom) bottom = p;
    if (p < bottom * OPT2_BOUNCE_RATIO) continue;
    // Check volume burst: 3+ buys in last 30s ending at this trade
    let buys = 0;
    for (let j = i; j >= 0; j--) {
      if (t.timestamp - trades[j].timestamp > OPT2_BURST_WINDOW_MS) break;
      if (trades[j].is_buy) buys++;
      if (buys >= OPT2_BURST_TRADES) {
        return i;
      }
    }
  }
  return null;
}

// Main backtest
console.log(`[backtest] window=24h, friction fee=${FEE} slip=${SLIP}`);

const candidateMints = db.prepare(`
  SELECT DISTINCT t.mint_address
  FROM trades t JOIN wallets w ON w.address = t.wallet
  WHERE t.is_buy = 1 AND (w.is_kol = 1 OR w.tracked = 1)
    AND t.timestamp > ?
  LIMIT 2000
`).all(NOW - WINDOW_MS);

console.log(`[backtest] candidate mints: ${candidateMints.length}`);

const trackedSet = new Set(db.prepare(`SELECT address FROM wallets WHERE is_kol=1 OR tracked=1`).all().map(r => r.address));

let baseline = { entries: 0, target: 0, sl: 0, open: 0, pnl: 0 };
let opt1 = { ...baseline, reentries: 0, reentry_target: 0, reentry_sl: 0, reentry_pnl: 0 };
let opt2 = { ...baseline, reentries: 0, reentry_target: 0, reentry_sl: 0, reentry_pnl: 0 };

const tradeStmt = db.prepare(`
  SELECT timestamp, wallet, is_buy, price_sol, sol_amount
  FROM trades WHERE mint_address = ? ORDER BY timestamp ASC
`);

for (const m of candidateMints) {
  const trades = tradeStmt.all(m.mint_address).map(t => ({ ...t, is_tracked: trackedSet.has(t.wallet) }));
  if (trades.length < 5) continue;

  // Find first tracked-wallet buy as entry
  const entryIdx = trades.findIndex(t => t.is_buy && t.is_tracked);
  if (entryIdx < 0) continue;
  const entry = trades[entryIdx];
  if (!entry.price_sol || entry.price_sol <= 0) continue;

  const entryPrice = entry.price_sol;
  const entrySol = ENTRY_SOL;

  // Baseline simulation
  const sim = simulatePosition(entryPrice, entrySol, trades, entryIdx + 1, SL_PCT);
  baseline.entries++;
  baseline.pnl += sim.pnl_sol;
  if (sim.exit_reason === 'TARGET_HIT') baseline.target++;
  else if (sim.exit_reason === 'SL_HIT') baseline.sl++;
  else baseline.open++;

  // Option 1 + Option 2 are baseline + re-entry on SL
  // Copy baseline result then layer re-entry
  for (const opt of [opt1, opt2]) {
    opt.entries++;
    opt.pnl += sim.pnl_sol;
    if (sim.exit_reason === 'TARGET_HIT') opt.target++;
    else if (sim.exit_reason === 'SL_HIT') opt.sl++;
    else opt.open++;
  }

  if (sim.exit_reason !== 'SL_HIT') continue;

  const slTime = trades[sim.exit_idx].timestamp;

  // Option 1 re-entry
  const opt1Idx = findOption1ReEntry(trades, sim.exit_idx, slTime, entryPrice);
  if (opt1Idx !== null) {
    const reEntryPrice = trades[opt1Idx].price_sol;
    const reEntrySol = entrySol * REENTRY_SIZE_RATIO;
    const reSim = simulatePosition(reEntryPrice, reEntrySol, trades, opt1Idx + 1, SL_PCT);
    opt1.reentries++;
    opt1.pnl += reSim.pnl_sol;
    if (reSim.exit_reason === 'TARGET_HIT') opt1.reentry_target++;
    else if (reSim.exit_reason === 'SL_HIT') opt1.reentry_sl++;
    opt1.reentry_pnl += reSim.pnl_sol;
  }

  // Option 2 re-entry
  const opt2Idx = findOption2ReEntry(trades, sim.exit_idx, slTime, sim.exit_price);
  if (opt2Idx !== null) {
    const reEntryPrice = trades[opt2Idx].price_sol;
    const reEntrySol = entrySol * REENTRY_SIZE_RATIO;
    const reSim = simulatePosition(reEntryPrice, reEntrySol, trades, opt2Idx + 1, OPT2_TIGHTER_SL);
    opt2.reentries++;
    opt2.pnl += reSim.pnl_sol;
    if (reSim.exit_reason === 'TARGET_HIT') opt2.reentry_target++;
    else if (reSim.exit_reason === 'SL_HIT') opt2.reentry_sl++;
    opt2.reentry_pnl += reSim.pnl_sol;
  }
}

function fmt(n) { return n >= 0 ? `+${n.toFixed(3)}` : n.toFixed(3); }

console.log(`\n=== RESULTS ===`);
console.log(`\nBaseline (Flip, no re-entry):`);
console.log(`  entries=${baseline.entries} target_hits=${baseline.target} sl_hits=${baseline.sl} open=${baseline.open}`);
console.log(`  net PnL: ${fmt(baseline.pnl)} SOL · WR: ${(100*baseline.target/baseline.entries).toFixed(0)}%`);

console.log(`\nOption 1 (Bounce re-entry, half-size, std SL):`);
console.log(`  entries=${opt1.entries} re-entries=${opt1.reentries} (${(100*opt1.reentries/opt1.sl).toFixed(0)}% of SL'd)`);
console.log(`  re-entry: target=${opt1.reentry_target} sl=${opt1.reentry_sl} pnl=${fmt(opt1.reentry_pnl)} SOL`);
console.log(`  net PnL: ${fmt(opt1.pnl)} SOL · delta vs baseline: ${fmt(opt1.pnl - baseline.pnl)}`);

console.log(`\nOption 2 (Phoenix strict, half-size, tight SL):`);
console.log(`  entries=${opt2.entries} re-entries=${opt2.reentries} (${(100*opt2.reentries/opt2.sl).toFixed(0)}% of SL'd)`);
console.log(`  re-entry: target=${opt2.reentry_target} sl=${opt2.reentry_sl} pnl=${fmt(opt2.reentry_pnl)} SOL`);
console.log(`  net PnL: ${fmt(opt2.pnl)} SOL · delta vs baseline: ${fmt(opt2.pnl - baseline.pnl)}`);

db.close();
