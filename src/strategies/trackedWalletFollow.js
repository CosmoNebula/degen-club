// Early Mover — broad tracked-wallet follower
// 4-tier ladder: T1 25% at +50%, T2 25% at +150%, T3 25% at +300% with 40% trail.
// Breakeven SL after T1, post-T1 trailing, fast-fail / fakepump / flat-exit / stagnant.
// Off by default — enable for wider net than Quick Flip.

export default {
  name: 'trackedWalletFollow',
  config: {
    label: 'B · Early Mover',
    description: 'Backloaded 4-tier ladder · let signal-rich entries breathe · tight 25% post-T1 trail · time-kill on flatliners',
    trigger: 'smart_trade',
    cashbackTriggerBoost: 1.5,
    defaults: {
      enabled: 1, entry_sol: 0.13, sl_pct: -0.35, max_hold_min: 60,
      tier1_trigger_pct: 0.50, tier1_sell_pct: 0.25,
      tier2_trigger_pct: 1.50, tier2_sell_pct: 0.25,
      tier3_trigger_pct: 3.00, tier3_sell_pct: 0.25, tier3_trail_pct: 0.40,
      breakeven_after_tier1: 1,
      breakeven_arm_pct: 0.50,
      breakeven_floor_pct: -0.10,
      tp_trail_pct: 0.30,
      tp_trail_arm_pct: 0.50,
      fast_fail_min_peak_pct: 0.05,
      flat_exit_min: 12, flat_exit_max_peak_pct: 0.20, flat_exit_band_pct: 0.10,
      stagnant_exit_min: 5, stagnant_loss_pct: -0.15,
      peak_floor_arm_pct: 0.10, peak_floor_exit_pct: 0.10,
      peak_floor_arm2_pct: 0.20, peak_floor_exit2_pct: 0.20,
      peak_floor_arm3_pct: 0.30, peak_floor_exit3_pct: 0.30,
    },
  },
};
