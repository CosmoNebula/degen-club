// Pre-King — predict king picks via velocity profile
// Fires on coin_velocity events (every new buy runs profile check).
// Profile: age 5-20s, MC 35-110, ≥12 unique buyers in last 30s, accelerating.
// Smart exit: when king actually buys our held coin, dump into the pump (KING_BOUGHT).
// Helper module: src/scoring/coin-velocity.js (rolling buyer windows).

export default {
  name: 'preKing',
  config: {
    label: 'P · Pre-King',
    description: 'Predict king picks via velocity signal · fires on profile match before he buys · 0.13 SOL · TP+25% / SL-10% / 90s time-out / KING_BOUGHT exit',
    trigger: 'coin_velocity',
    ageMinSec: 5,
    ageMaxSec: 30,
    mcMinSol: 35,
    mcMaxSol: 110,
    minBuyersInWindow: 8,
    windowSec: 30,
    minVelocityRatio: 0.5,
    maxBundleBuyers: 0,
    maxFirstBlockSnipers: 5,
    mintCooldownSec: 300,
    defaults: {
      enabled: 0, entry_sol: 0.13, sl_pct: -0.10, max_hold_min: 1.5,
      tier1_trigger_pct: 0.25, tier1_sell_pct: 1.0,
      peak_floor_arm_pct: 0.10, peak_floor_exit_pct: 0.04,
      peak_floor_arm2_pct: 0.0, peak_floor_exit2_pct: 0.0,
      peak_floor_arm3_pct: 0.0, peak_floor_exit3_pct: 0.0,
      tier2_trigger_pct: 99.0, tier2_sell_pct: 0,
      tier3_trigger_pct: 99.0, tier3_sell_pct: 0, tier3_trail_pct: 0,
      breakeven_after_tier1: 0,
      breakeven_arm_pct: 0, breakeven_floor_pct: 0,
      tp_trail_pct: 0, tp_trail_arm_pct: 0,
      fast_fail_min_peak_pct: 0,
      stagnant_exit_min: 0, stagnant_loss_pct: 0,
    },
  },
};
