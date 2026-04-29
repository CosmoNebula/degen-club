// Healthy Momentum — patient grind-to-migration play
// Fires on healthy_momentum trigger (organic accelerating coins, 30+ buyers, no whale dominance).
// Single tier at +75% with 25% sell, trailing stop, breakeven after T1.
// Designed for coins riding all the way to bonding-curve migration.

export default {
  name: 'healthyMomentum',
  config: {
    label: 'Healthy Momentum · Grind-to-Migration',
    description: 'Organic accelerating coins · 30+ buyers · no whale dominance · patient ride to migration',
    trigger: 'healthy_momentum',
    defaults: {
      enabled: 1, entry_sol: 0.10, sl_pct: -0.35, max_hold_min: 90,
      tier1_trigger_pct: 0.75, tier1_sell_pct: 0.25,
      tier2_trigger_pct: 99.0, tier2_sell_pct: 0,
      tier3_trigger_pct: 99.0, tier3_sell_pct: 0, tier3_trail_pct: 0,
      breakeven_after_tier1: 1,
      breakeven_arm_pct: 0.75,
      tp_trail_pct: 0.70,
      tp_trail_arm_pct: 1.00,
      fast_fail_min_peak_pct: 0.05,
      stagnant_exit_min: 8, stagnant_loss_pct: -0.15,
    },
  },
};
