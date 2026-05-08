// Whale Spawn — watch mints enrolled at launch (initial_buy_sol >= 8 SOL),
// track their peak, and fire 'whale_spawn' trigger on the first significant
// dip from peak after the launch sniper phase has settled.
//
// Why a dip-buy and not a launch-buy:
//   - Big initial-buy mints typically pump 30-100% in the first 30-90s as
//     snipers pile in, then dump 20-50% as those snipers exit
//   - Buying that first dip avoids the sniper feeding-frenzy and catches the
//     real second-leg pump if the mint has legs
//   - If no dip materializes (mint just keeps climbing), watch expires; we
//     miss it but avoid chasing
//
// Conditions to fire:
//   - mint age >= 60s (sniper phase mostly complete)
//   - mint has peaked at least +15% from seed (proves it had life)
//   - current price <= peak * 0.80 (20% retrace from peak)
//   - watch not yet expired (10 min cap from launch)
//   - not yet fired

import { db } from '../db/index.js';
import { onWhaleSpawn } from '../trading/strategies.js';

const SWEEP_INTERVAL_MS = 5000;
const MIN_AGE_SEC = 60;
const MIN_PEAK_PCT_FROM_SEED = 0.15;  // peak must be at least +15% above seed
const DIP_RETRACE_PCT = 0.20;         // current must be 20%+ below peak

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    activeWatches: d.prepare(`SELECT * FROM whale_watch WHERE fired = 0 AND expires_at > ?`),
    updatePeak: d.prepare(`UPDATE whale_watch SET peak_price = ?, peak_at = ? WHERE mint_address = ?`),
    markFired: d.prepare(`UPDATE whale_watch SET fired = 1, fired_at = ? WHERE mint_address = ?`),
    sweepExpired: d.prepare(`DELETE FROM whale_watch WHERE expires_at < ? OR (fired = 1 AND fired_at < ?)`),
    getMint: d.prepare('SELECT * FROM mints WHERE mint_address = ?'),
  };
  return stmts;
}

function sweep() {
  const s = S();
  const now = Date.now();
  const active = s.activeWatches.all(now);
  if (active.length === 0) return;

  let fired = 0;
  for (const w of active) {
    const mint = s.getMint.get(w.mint_address);
    if (!mint) continue;
    if (mint.migrated || mint.rugged) continue;

    const ageSec = (now - w.created_at) / 1000;
    if (ageSec < MIN_AGE_SEC) continue;

    const cur = mint.last_price_sol || 0;
    if (cur <= 0) continue;

    // Update peak if current is higher
    let peak = w.peak_price || w.seed_price || cur;
    if (cur > peak) {
      peak = cur;
      s.updatePeak.run(peak, now, w.mint_address);
    }

    // Did the mint actually pump from seed?
    const pumpFromSeed = w.seed_price > 0 ? (peak - w.seed_price) / w.seed_price : 0;
    if (pumpFromSeed < MIN_PEAK_PCT_FROM_SEED) continue;

    // Is current dipped enough from peak?
    const dipFromPeak = (peak - cur) / peak;
    if (dipFromPeak < DIP_RETRACE_PCT) continue;

    // Fire — first dip detected
    s.markFired.run(now, w.mint_address);
    console.log(`[whale-spawn] 🐋 ${w.mint_address.slice(0,8)}… init=${w.initial_buy_sol.toFixed(1)}SOL · peak +${(pumpFromSeed*100).toFixed(0)}% · dipped -${(dipFromPeak*100).toFixed(0)}% · age ${ageSec.toFixed(0)}s — firing`);
    try {
      onWhaleSpawn(w.mint_address, {
        initial_buy_sol: w.initial_buy_sol,
        seed_price: w.seed_price,
        peak_price: peak,
        peak_pct_from_seed: pumpFromSeed,
        dip_pct_from_peak: dipFromPeak,
        age_sec: ageSec,
      });
    } catch (err) { console.error('[whale-spawn] fire failed:', err.message); }
    fired++;
  }

  // Cleanup expired/fired-old rows
  const cleanupCutoff = now - 60 * 60 * 1000; // 1hr
  s.sweepExpired.run(now, cleanupCutoff);
  if (fired > 0) console.log(`[whale-spawn] swept ${active.length} watches · fired ${fired}`);
}

export function startWhaleSpawnSweep() {
  setInterval(() => {
    try { sweep(); } catch (err) { console.error('[whale-spawn] sweep', err.message); }
  }, SWEEP_INTERVAL_MS);
  console.log('[whale-spawn] sweep started (every 5s)');
}
