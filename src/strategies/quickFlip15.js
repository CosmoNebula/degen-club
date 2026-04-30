// Quick Flip +20% — KOL-gated scalp
// Fires on smart_trade signals from KOL wallets OR BOT wallets when MC < 70.
// Hard MC ceiling at 100 SOL. Sells 100% at +20%, peak-floor armed at 10/20/30%, -10% SL.
// ~80%+ paper WR over 100+ trades. Bread and butter.

export default {
  name: 'quickFlip15',
  config: {
    label: 'Q · Quick Flip +20%',
    description: 'KOL or BOT<70mc smart_trade entries · MC<100 ceiling · sells 100% at +20% · no tiers, no trailing, no breakeven',
    trigger: 'smart_trade',
    mcCeiling: 100,
    sourceFilter: {
      walletCategories: ['KOL'],
      categoriesUnderMc: { BOT: 70 },
    },
    defaults: {
      enabled: 1, entry_sol: 0.13, sl_pct: -0.10, max_hold_min: 30,
      tier1_trigger_pct: 0.20, tier1_sell_pct: 1.0,
      peak_floor_arm_pct: 0.10, peak_floor_exit_pct: 0.10,
      peak_floor_arm2_pct: 0.20, peak_floor_exit2_pct: 0.20,
      peak_floor_arm3_pct: 0.30, peak_floor_exit3_pct: 0.30,
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
