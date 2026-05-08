// Backtest each strategy's exit logic against the same entry universe
// (first tracked-wallet buy per mint, last 24h). Apples-to-apples comparison
// of EXIT philosophies — not a perfect simulation of trigger differences,
// but reveals which exit approach extracts the most value from a given entry.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'degen.db'), { readonly: true });

const NOW = Date.now();
const WINDOW_MS = 24 * 60 * 60 * 1000;
const FEE = 0.01;
const SLIP = 0.025;

const STRATEGIES = {
  kolCoattailsFlip: {
    entry_sol: 0.09,
    sl_pct: -0.45,
    tiers: [{ trig: 0.30, sell: 1.00 }],
    breakeven_after_tier1: false,
  },
  kolCoattails: {
    entry_sol: 0.10,
    sl_pct: -0.55,
    tiers: [
      { trig: 0.15, sell: 0.35 },
      { trig: 0.50, sell: 0.30 },
      { trig: 2.00, sell: 0.15 },
    ],
    breakeven_after_tier1: true,
    breakeven_floor: -0.25,
  },
  migratorHunter: {
    entry_sol: 0.10,
    sl_pct: -0.50,
    tiers: [
      { trig: 0.30, sell: 0.50 },
      { trig: 0.80, sell: 0.30 },
      { trig: 2.50, sell: 0.15 },
    ],
    breakeven_after_tier1: true,
    breakeven_floor: -0.50,
  },
  migratorHunterFlip: {
    entry_sol: 0.09,
    sl_pct: -0.45,
    tiers: [{ trig: 0.30, sell: 1.00 }],
    breakeven_after_tier1: false,
  },
  graduator: {
    entry_sol: 0.08,
    sl_pct: -0.55,
    tiers: [
      { trig: 0.25, sell: 0.30 },
      { trig: 0.75, sell: 0.30 },
      { trig: 2.00, sell: 0.25 },
    ],
    breakeven_after_tier1: false,
  },
};

function buyTokens(solIn, price) {
  return (solIn * (1 - FEE)) / (price * (1 + SLIP));
}
function sellSol(tokens, price) {
  return tokens * price * (1 - SLIP) * (1 - FEE);
}

function simulateStrategy(strat, entryPrice, trades, startIdx) {
  const entrySol = strat.entry_sol;
  const totalTokens = buyTokens(entrySol, entryPrice);
  let tokensRemaining = totalTokens;
  let solRealized = 0;
  let tiersHit = 0;
  let beArmed = false;
  let peak = entryPrice;
  const tiers = strat.tiers;

  for (let i = startIdx; i < trades.length; i++) {
    const p = trades[i].price_sol || 0;
    if (p <= 0) continue;
    if (p > peak) peak = p;
    const pctFromEntry = (p - entryPrice) / entryPrice;

    // SL check (only if BE not armed)
    if (!beArmed && pctFromEntry <= strat.sl_pct) {
      solRealized += sellSol(tokensRemaining, p);
      tokensRemaining = 0;
      return { exit_reason: 'SL_HIT', exit_price: p, peak_price: peak, tiers_hit: tiersHit, pnl_sol: solRealized - entrySol };
    }
    // BE check (after armed)
    if (beArmed && pctFromEntry <= (strat.breakeven_floor || 0)) {
      solRealized += sellSol(tokensRemaining, p);
      tokensRemaining = 0;
      return { exit_reason: 'BREAKEVEN_SL', exit_price: p, peak_price: peak, tiers_hit: tiersHit, pnl_sol: solRealized - entrySol };
    }
    // Tier triggers (in order)
    for (let t = tiersHit; t < tiers.length; t++) {
      const tier = tiers[t];
      if (pctFromEntry >= tier.trig) {
        const sellTokens = Math.min(totalTokens * tier.sell, tokensRemaining);
        if (sellTokens > 0) {
          solRealized += sellSol(sellTokens, p);
          tokensRemaining -= sellTokens;
          tiersHit = t + 1;
          if (t === 0 && strat.breakeven_after_tier1) beArmed = true;
        }
        if (tokensRemaining <= 0.0001) {
          return { exit_reason: tiers.length === 1 ? 'TARGET_HIT' : 'TIERED_FULL', exit_price: p, peak_price: peak, tiers_hit: tiersHit, pnl_sol: solRealized - entrySol };
        }
      } else break;
    }
  }
  // ran out of trades — close at last
  const lastP = trades[trades.length - 1]?.price_sol || entryPrice;
  if (tokensRemaining > 0) {
    solRealized += sellSol(tokensRemaining, lastP);
  }
  return { exit_reason: 'OPEN_END', exit_price: lastP, peak_price: peak, tiers_hit: tiersHit, pnl_sol: solRealized - entrySol };
}

const candidateMints = db.prepare(`
  SELECT DISTINCT t.mint_address
  FROM trades t JOIN wallets w ON w.address = t.wallet
  WHERE t.is_buy = 1 AND (w.is_kol = 1 OR w.tracked = 1)
    AND t.timestamp > ?
  LIMIT 5000
`).all(NOW - WINDOW_MS);

const tradeStmt = db.prepare(`
  SELECT timestamp, wallet, is_buy, price_sol FROM trades
  WHERE mint_address = ? ORDER BY timestamp ASC
`);

const trackedSet = new Set(db.prepare(`SELECT address FROM wallets WHERE is_kol=1 OR tracked=1`).all().map(r => r.address));

const results = {};
for (const name of Object.keys(STRATEGIES)) {
  results[name] = { entries: 0, target: 0, tiered: 0, sl: 0, be_sl: 0, open: 0, pnl: 0, total_realized_pct: 0 };
}

// Bot reaction lag — enter at the first trade that lands ~1.1s after the KOL signal
// AND apply max-drift abort (skip entry if price has already moved >13% from trigger).
const LAG_MS = 1100;
const MAX_DRIFT = 0.13;

let mintsProcessed = 0;
let mintsAborted = 0;
for (const m of candidateMints) {
  const trades = tradeStmt.all(m.mint_address);
  if (trades.length < 5) continue;
  const triggerIdx = trades.findIndex(t => t.is_buy && trackedSet.has(t.wallet));
  if (triggerIdx < 0) continue;
  const triggerPrice = trades[triggerIdx].price_sol;
  if (!triggerPrice || triggerPrice <= 0) continue;
  const triggerTime = trades[triggerIdx].timestamp;
  // find first trade ≥ triggerTime + LAG_MS — that's where we'd actually buy
  let entryIdx = triggerIdx + 1;
  while (entryIdx < trades.length && trades[entryIdx].timestamp < triggerTime + LAG_MS) entryIdx++;
  if (entryIdx >= trades.length) continue;
  const entryPrice = trades[entryIdx].price_sol;
  if (!entryPrice || entryPrice <= 0) continue;
  // abort if price has drifted too far (matches paper STALE_QUOTE behavior)
  if (Math.abs(entryPrice - triggerPrice) / triggerPrice > MAX_DRIFT) {
    mintsAborted++;
    continue;
  }
  mintsProcessed++;

  for (const [name, strat] of Object.entries(STRATEGIES)) {
    const r = simulateStrategy(strat, entryPrice, trades, entryIdx + 1);
    const res = results[name];
    res.entries++;
    res.pnl += r.pnl_sol;
    res.total_realized_pct += (r.pnl_sol / strat.entry_sol);
    if (r.exit_reason === 'TARGET_HIT' || r.exit_reason === 'TIERED_FULL') res.target++;
    else if (r.exit_reason === 'SL_HIT') res.sl++;
    else if (r.exit_reason === 'BREAKEVEN_SL') res.be_sl++;
    else res.open++;
  }
}

console.log(`[backtest] mints=${mintsProcessed} aborted_drift=${mintsAborted} (lag=${LAG_MS}ms, max_drift=${MAX_DRIFT*100}%, fee=${FEE} slip=${SLIP})\n`);

const cols = ['strategy', 'entries', 'target', 'tiered', 'sl', 'be_sl', 'open', 'wr', 'avg_pct', 'sum_sol'];
console.log(cols.join('|'));
for (const [name, r] of Object.entries(results)) {
  const wr = (100 * (r.target + r.be_sl) / r.entries).toFixed(0) + '%';
  const avgPct = ((r.total_realized_pct / r.entries) * 100).toFixed(1) + '%';
  console.log([name, r.entries, r.target, '', r.sl, r.be_sl, r.open, wr, avgPct, r.pnl.toFixed(3)].join('|'));
}

console.log(`\n=== sorted by net PnL ===`);
const sorted = Object.entries(results).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [name, r] of sorted) {
  const winRate = (100 * (r.target + r.be_sl) / r.entries).toFixed(0);
  console.log(`${name.padEnd(22)} pnl=${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(3)} SOL · WR=${winRate}% · target=${r.target} sl=${r.sl} be_sl=${r.be_sl}`);
}

db.close();
