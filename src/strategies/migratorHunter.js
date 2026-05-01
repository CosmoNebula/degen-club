// Migrator Hunter — copy the wallets that historically caught migraters.
// Fires when N+ wallets with high migrator_score buy the same mid-curve mint
// inside a sliding window. Tuned from 63-trade postmortem:
//   - 100% of -30% SL hits recovered (avg peaked 168 mcap from 85 entry) → SL widened to -50%
//   - 0-2m bucket avg 2.55x recovery → kept minAgeSec at 120s, let wider SL do the work
//   - WIN cohort avg unique buyers 197 vs SL 162 → minUniqueBuyers gate
//   - Bundle flag NOT predictive (winners had it more often) → no bundle filter
//   - PEAK_FLOOR was leaving avg +126% on table · BREAKEVEN_SL banking +3% on +59% peaks
//     → arms pushed back, exits widened
//
// Helper: src/scoring/migrator-hunter.js (in-memory window tracker, score cache).
// No global category gating — strategy intentionally accepts BUNDLE/BOT/SCALPER signals,
// because that's where the migrator-finding skill actually lives.

export default {
  name: 'migratorHunter',
  config: {
    label: 'M · Migrator Hunter',
    description: 'N+ historic-migrator wallets buying mature mid-curve mint · wide SL · ride pullbacks · tuned from 63-trade postmortem',
    trigger: 'migrator_hunter',

    // Hunter qualification
    minScore: 0.55,
    minSample: 5,
    windowSec: 300,
    minHunters: 3,

    // Mint shape — filter freshest chop only. SL recovery analysis showed 100% of
    // -30% SLs recovered regardless of age (0-2m bucket avg 2.55x recovery), so
    // wider SL does the heavy lifting; aggressive age gating just throws away the
    // 0-2m bucket where mints averaged 2.17x peak.
    minAgeSec: 120,
    maxAgeSec: 7200,
    minMcapSol: 30,
    maxMcapSol: 250,
    minUniqueBuyers: 150,
    cooldownMinutes: 30,

    sizing: {
      baseEntrySol: 0.10,
      minEntrySol: 0.05,
      maxEntrySol: 0.30,
      scoreScaleStart: 0.55,
      scoreScaleMax: 0.85,
      maxMult: 3.0,
    },

    defaults: {
      enabled: 1,
      entry_sol: 0.10,
      sl_pct: -0.50,
      max_hold_min: 240,
      tier1_trigger_pct: 0.50, tier1_sell_pct: 0.30,
      tier2_trigger_pct: 1.50, tier2_sell_pct: 0.30,
      tier3_trigger_pct: 4.00, tier3_sell_pct: 0.20, tier3_trail_pct: 0.40,
      breakeven_after_tier1: 1,
      breakeven_arm_pct: 0.75,
      breakeven_floor_pct: -0.20,
      tp_trail_pct: 0.30,
      tp_trail_arm_pct: 2.00,
      fast_fail_sec: 0,
      fast_fail_min_peak_pct: 0,
      fast_fail_sl_pct: 0,
      fakepump_sec: 0,
      fakepump_min_peak_pct: 0,
      fakepump_sl_pct: 0,
      stagnant_exit_min: 45,
      stagnant_loss_pct: -0.30,
      flat_exit_min: 0,
      flat_exit_max_peak_pct: 0,
      flat_exit_band_pct: 0,
      peak_floor_arm_pct: 1.00, peak_floor_exit_pct: 0.50,
      peak_floor_arm2_pct: 3.00, peak_floor_exit2_pct: 0.55,
      peak_floor_arm3_pct: 7.00, peak_floor_exit3_pct: 0.60,
    },
  },
};
