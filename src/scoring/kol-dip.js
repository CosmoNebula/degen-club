// KOL Dip — A/B partner to kolCoattailsFlip. Watches mints enrolled when a
// KOL fires (kol_watch table populated by onSmartTrade) and fires the
// 'kol_dip' trigger on the first significant retrace from peak.
//
// Goal: directly compare "enter on KOL signal" (kolCoattailsFlip) vs "wait
// for first dip then enter" (kolCoattailsDip) — same trigger universe, same
// exit philosophy, only entry timing differs.
//
// Conditions to fire:
//   - mint age since signal >= 30s (let the post-KOL pump play out)
//   - peak >= signal_price * 1.08 (mint actually pumped at least 8%)
//   - current <= peak * 0.85 (15% retrace from peak)
//   - current >= signal_price * 0.70 (don't catch falling knives — must be
//     within 30% of original signal price)
//   - watch not expired (10 min cap)
//   - not yet fired

import { db } from '../db/index.js';
import { onKolDip } from '../trading/strategies.js';

const SWEEP_INTERVAL_MS = 4000;
const MIN_AGE_SEC = 30;
const MIN_PEAK_PCT_FROM_SIGNAL = 0.08;
const DIP_RETRACE_PCT = 0.15;
const MIN_PRICE_RATIO_TO_SIGNAL = 0.70;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    activeWatches: d.prepare(`SELECT * FROM kol_watch WHERE fired = 0 AND expires_at > ?`),
    updatePeak: d.prepare(`UPDATE kol_watch SET peak_price = ?, peak_at = ? WHERE mint_address = ?`),
    markFired: d.prepare(`UPDATE kol_watch SET fired = 1, fired_at = ? WHERE mint_address = ?`),
    sweepExpired: d.prepare(`DELETE FROM kol_watch WHERE expires_at < ? OR (fired = 1 AND fired_at < ?)`),
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

    const ageSec = (now - w.signal_at) / 1000;
    if (ageSec < MIN_AGE_SEC) continue;

    const cur = mint.last_price_sol || 0;
    if (cur <= 0) continue;

    let peak = w.peak_price || w.signal_price;
    if (cur > peak) {
      peak = cur;
      s.updatePeak.run(peak, now, w.mint_address);
    }

    const peakPctFromSignal = (peak - w.signal_price) / w.signal_price;
    if (peakPctFromSignal < MIN_PEAK_PCT_FROM_SIGNAL) continue;

    const dipFromPeak = (peak - cur) / peak;
    if (dipFromPeak < DIP_RETRACE_PCT) continue;

    const priceRatio = cur / w.signal_price;
    if (priceRatio < MIN_PRICE_RATIO_TO_SIGNAL) continue; // falling knife

    s.markFired.run(now, w.mint_address);
    console.log(`[kol-dip] 📉 ${w.mint_address.slice(0,8)}… kol=${w.kol_wallet.slice(0,6)}… peak +${(peakPctFromSignal*100).toFixed(0)}% · dipped -${(dipFromPeak*100).toFixed(0)}% · age ${ageSec.toFixed(0)}s — firing`);
    try {
      onKolDip(w.mint_address, {
        kol_wallet: w.kol_wallet,
        signal_price: w.signal_price,
        peak_price: peak,
        peak_pct_from_signal: peakPctFromSignal,
        dip_pct_from_peak: dipFromPeak,
        price_ratio_to_signal: priceRatio,
        age_sec: ageSec,
      });
    } catch (err) { console.error('[kol-dip] fire failed:', err.message); }
    fired++;
  }

  s.sweepExpired.run(now, now - 60 * 60 * 1000);
  if (fired > 0) console.log(`[kol-dip] swept ${active.length} watches · fired ${fired}`);
}

export function startKolDipSweep() {
  setInterval(() => {
    try { sweep(); } catch (err) { console.error('[kol-dip] sweep', err.message); }
  }, SWEEP_INTERVAL_MS);
  console.log('[kol-dip] sweep started (every 4s)');
}
