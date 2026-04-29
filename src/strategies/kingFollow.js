// King Follow — solo-follow a whitelisted "king" wallet
// Fires on smart_trade only when triggering wallet is in kingWallets list.
// Smart exit: when king dumps ≥ kingSellExitThreshold of their bag, force-close.
// Helper module: src/trading/king-tracker.js (per-king-wallet bag tracking).

export default {
  name: 'kingFollow',
  config: {
    label: 'K · King Follow',
    description: 'Solo-follow whitelisted wallet · 0.5 SOL entry · +15% TP · −12% SL · exits when king dumps ≥50% of bag',
    trigger: 'smart_trade',
    kingWallets: ['57stAMFvwctAjkBS76RXGoK4QKyS1QoxbGMbzFFe4DyZ'],
    kingMaxMcapSol: 150,
    kingSellExitThreshold: 0.5,
    defaults: {
      enabled: 0, entry_sol: 0.5, sl_pct: -0.12, max_hold_min: 1,
      tier1_trigger_pct: 0.15, tier1_sell_pct: 1.0,
      peak_floor_arm_pct: 0.08, peak_floor_exit_pct: 0.05,
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
