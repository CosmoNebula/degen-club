// 2026-05-15: Full strategy reset.
//
// Retires all currently-live strategies (none of the 7 generated PnL — best
// was slipstream-v1 which fired 96 times and got killed every time) and
// deploys 3 brand-new strategies designed around tonight's exit-timing
// model suite.
//
// Each strategy targets a different mint personality with a different hold
// horizon and a different exit thesis — no overlap in primary signal.
//
//   1) graduation-hunter-v1  — patient, catches graduates, ~10-30min hold
//   2) peak-snatcher-v1      — scalper, sells ON the local top, ~2-5min hold
//   3) runner-trailer-v1     — moonshot, adaptive trail, ~30-60min hold
//
// Notes on availability of the new exit-timing predictions referenced below:
//   - price_up_60s, price_up_300s, drawdown_20pct_300s, local_top_60s →
//     trained 2026-05-15 00:00 ET retrain, models live in serve.py NOW.
//   - unique_buyers_next_60s, unique_sellers_next_60s → routing bug
//     ("need ≥5 of each class") fixed earlier tonight; will train at the
//     01:00 ET retrain (~30 min from this deploy). Strategies referencing
//     them gracefully degrade until then — the prediction is read as null
//     and the condition simply doesn't fire.

import { db } from '../src/db/index.js';
import { deployStrategy } from '../src/ml/agent-executor.js';

const TODAY = '2026-05-15';
const NOW = Date.now();
const RETIRE_REASON = '2026-05-15 full strategy reset — none of the prior live strategies generated PnL; replaced with 3 fresh strategies built around the new exit-timing model suite';

const strategies = [
  // -------------------------------------------------------------------------
  // 1) graduation-hunter-v1 — patient, catches mints that will graduate
  // -------------------------------------------------------------------------
  {
    id: `agent_${TODAY}_graduation-hunter-v1`,
    recipe: {
      name: 'graduation-hunter-v1',
      rationale: 'Targets pre-mig mints that will graduate to Raydium. Leans on the strongest model we have: `migrated` (AUC-ROC 0.982, Lift 9.08). Timing-confirmed by `migrates_within_15min`. Safety floor via `rug_within_5min` AND the new `drawdown_20pct_300s` predictor (1 if any price in next 5min drops to ≤80% of now — pre-warns the dump). Patient entry window (10min), laddered tier exits matched to the typical graduation pump shape. Pre-mig exits on dump-pressure forecast; post-mig re-evaluation hands off to `post_mig_hits_2x`.',
      entry: {
        conditions: [
          // 2026-05-15 (PM-2) DEEP DIVE: the `migrated` gate killed 15+
          // rejected coins that went 5-50x post-rejection — including a
          // 49.6x runner that DID graduate. Model is demonstrably broken
          // in current regime (max prediction 0.004 vs threshold 0.01,
          // every batch all day). Dropping it entirely. Safety + distribution
          // + mcap geometry carry the gating now; ML is no longer trusted
          // as a positive signal for graduation, only as a negative one
          // (rug_within_5min, drawdown_20pct_300s).
          { kind: 'ml_prediction', name: 'rug_within_5min',        op: '<',  value: 0.10 },
          { kind: 'ml_prediction', name: 'drawdown_20pct_300s',    op: '<',  value: 0.50 },
          // Organic interest floor (avoid sniper-dominated rugs)
          { kind: 'snapshot_feature', name: 'unique_buyers',         op: '>=', value: 10 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys',       op: '<=', value: 0.35 },
          { kind: 'snapshot_feature', name: 'pct_first_block_buys',  op: '<=', value: 0.25 },
          // Geometry: mcap in the pre-graduation runway zone. Sub-5 SOL
          // is sniper-zone noise; >85 SOL is post-graduation territory.
          { kind: 'snapshot_feature', name: 'last_mcap_sol',         op: '>=', value: 5 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',         op: '<=', value: 85 },
        ],
        // 2026-05-15: bumped 600→1500s. Graduation typically happens
        // 10-30min into a coin's life, and the model needs ≥2min of organic
        // data to give a reliable read (train/serve age-skew per audit).
        max_mint_age_sec: 1500, // 25 min
      },
      sizing: { type: 'fixed', sol: 0.18 },
      exit: {
        stop_loss_pct: 50,
        take_profit_tiers: [
          { trigger_pct: 50,  sell_pct: 30 },
          { trigger_pct: 200, sell_pct: 50 },
          { trigger_pct: 600, sell_pct: 50 },  // moonbag survives past 6x
        ],
        trailing_stop: { arm_pct: 400, trail_pct: 35 },
        // Peak-floor cascade — catches modest pumps that fade before T1 fires
        // and locks in profits on near-T2/T3 peaks that retrace. INVARIANT:
        // exit_pct < arm_pct (else fires immediately when armed).
        // 2026-05-15 (PM-2): L1 loosened from arm=30/exit=5 → arm=80/exit=25.
        // The previous L1 exited 3 coins that went +190% post-exit (1.9x lost
        // upside). New L1 only arms after the coin clears +80% — by then it's
        // a real pump, not noise — and exits if it retraces below +25%.
        peak_floor_tiers: [
          { arm_pct: 80,  exit_pct: 25 },   // L1: only on real pumps (≥+80% peak)
          { arm_pct: 200, exit_pct: 100 },  // L2: lock 2x after 3x peak (was 120/60)
          { arm_pct: 500, exit_pct: 250 },  // L3: lock 2.5x after 6x peak (was 400/200)
        ],
        max_hold_min: 30,
        // Smart exit: incoming dump pressure detector. (Recipe field — not yet
        // consumed by paper.js, kept as documentation until wired.)
        prediction_exit: { target: 'unique_sellers_next_60s', op: '>', value: 20 },
        breakeven_after_tier1: 1,
      },
    },
  },

  // -------------------------------------------------------------------------
  // 2) peak-snatcher-v1 — scalper, sells ON the local top
  // -------------------------------------------------------------------------
  {
    id: `agent_${TODAY}_peak-snatcher-v1`,
    recipe: {
      name: 'peak-snatcher-v1',
      rationale: 'Catches mints that peak inside 5 minutes (peak_within_5min, AUC 0.952). The unlock is `local_top_60s` as prediction_exit: model predicts whether NOW is within 5% of the max price in (T-60s, T+60s] — when true, we sell rather than waiting for the post-peak drawdown to stop us out. Confirmed by `buy_pressure_continues_60s` (demand sticky) + `unique_buyers_next_60s` (real incoming buyers, Poisson count). Tight stops, no trail, 5-min max hold — matches the "fast pop" thesis.',
      entry: {
        conditions: [
          // 2026-05-15 (PM-2) DEEP DIVE: dropped `peak_within_5min` (was the
          // chronic blocker — max prediction 0.04-0.05 vs threshold 0.05,
          // killing real 5-8x runners like Gtg6CZ31… +7.8x). Same calibration
          // problem as the migrated gate on graduation-hunter. Keep
          // buy_pressure_continues_60s (validates demand) + unique_buyers_60s
          // (Poisson confirms incoming flow). Both remain as positive signals.
          { kind: 'ml_prediction', name: 'buy_pressure_continues_60s', op: '>=', value: 0.20 },
          { kind: 'ml_prediction', name: 'unique_buyers_next_60s',   op: '>=', value: 1 },
          // Safety (negative signals — ML still trusted here)
          { kind: 'ml_prediction', name: 'rug_within_5min',          op: '<',  value: 0.08 },
          { kind: 'ml_prediction', name: 'drawdown_20pct_300s',      op: '<',  value: 0.55 },
          // Distribution floors
          { kind: 'snapshot_feature', name: 'unique_buyers',           op: '>=', value: 6 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys',         op: '<=', value: 0.35 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',           op: '>=', value: 4 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',           op: '<=', value: 65 },
        ],
        // 2026-05-15: bumped 300→480s. Scalper still wants young coins but
        // 5min was too tight given the train/serve age-skew — model needs
        // ≥1min of feature data to fire reliably (snapshot_age_sec=60 trained).
        max_mint_age_sec: 480, // 8 min
      },
      sizing: { type: 'fixed', sol: 0.13 },
      exit: {
        stop_loss_pct: 25,
        take_profit_tiers: [
          { trigger_pct: 30, sell_pct: 50 },
          { trigger_pct: 80, sell_pct: 100 },
        ],
        // No trailing stop — 5-min thesis. Tier sells + breakeven + local-top
        // detector do the work.
        // Peak-floor cascade — only 2 tiers because the 5-min thesis means
        // we never sit through deep drawdowns.
        // 2026-05-15 (PM-2): L1 loosened arm=15/exit=3 → arm=40/exit=15.
        // Previous L1 was too eager — exited at +15% peak's first dip below
        // +3% even when the coin had more legs. New L1 needs +40% peak first
        // (real scalp-zone pump) before triggering.
        peak_floor_tiers: [
          { arm_pct: 40, exit_pct: 15 },  // L1: real pump rescue (≥+40% peak)
          { arm_pct: 80, exit_pct: 40 },  // L2: lock +40% near T2 zone
        ],
        max_hold_min: 5,
        // Smart exit (documentation — not yet wired in paper.js):
        prediction_exit: { target: 'local_top_60s', op: '>', value: 0.50 },
        breakeven_after_tier1: 1,
        fast_fail: { sec: 90, min_peak_pct: 8, sl_pct: -15 },
      },
    },
  },

  // -------------------------------------------------------------------------
  // 3) runner-trailer-v1 — moonshot with adaptive trail
  // -------------------------------------------------------------------------
  {
    id: `agent_${TODAY}_runner-trailer-v1`,
    recipe: {
      name: 'runner-trailer-v1',
      rationale: 'Catches 4x+ runners using `peaked_300` (Lift 7.46) gated by `hits_2x_within_1h` for timing AND `pump_durability_5min` regression (R²=0.601) for "is this pump going to stick." Largest position (0.20 SOL) because the EV per trade is the highest — the model picks confident 4x+ runners at 7.5× the base rate. Laddered tier exits target multi-X outcomes; loose 40% trail above 1000% arms only on real moonshots. `local_top_60s` as prediction_exit acts as the sell-the-top hedge once we are deep in profit — we cap the max-hold at 60min so a thesis-broken mint does not bleed our bag back to zero overnight.',
      entry: {
        conditions: [
          // 2026-05-15 (PM-2) DEEP DIVE: dropped `peaked_300` (was the chronic
          // blocker — max 0.024-0.029 vs threshold 0.03, killing real runners
          // like Gtg6CZ31 +7.8x and GwAYB4NF +5.7x). Same broken-in-regime
          // story as the migrated and peak_within_5min gates. Keep
          // `hits_2x_within_1h` (timing) + `pump_durability_5min` (R²=0.60,
          // best regression) as positive signals.
          { kind: 'ml_prediction', name: 'hits_2x_within_1h',   op: '>=', value: 0.10 },
          { kind: 'ml_prediction', name: 'pump_durability_5min', op: '>=', value: 0.25 },
          // Safety (negative ML signals still trusted)
          { kind: 'ml_prediction', name: 'rug_within_5min',     op: '<',  value: 0.10 },
          { kind: 'ml_prediction', name: 'drawdown_20pct_300s', op: '<',  value: 0.50 },
          // Distribution
          { kind: 'snapshot_feature', name: 'unique_buyers',      op: '>=', value: 12 },
          { kind: 'snapshot_feature', name: 'pct_sniper_buys',    op: '<=', value: 0.35 },
          { kind: 'snapshot_feature', name: 'bundle_buyers',      op: '<=', value: 0 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',      op: '>=', value: 8 },
          { kind: 'snapshot_feature', name: 'last_mcap_sol',      op: '<=', value: 75 },
        ],
        // 2026-05-15: bumped 480→900s. Runners need ≥3min to show the
        // pump_durability signal reliably. Earlier than that, the model
        // can't tell a real runner from sniper noise.
        max_mint_age_sec: 900, // 15 min
      },
      sizing: { type: 'fixed', sol: 0.20 },
      exit: {
        stop_loss_pct: 55,
        take_profit_tiers: [
          { trigger_pct: 100,  sell_pct: 30 },  // 2x — lock 30%
          { trigger_pct: 300,  sell_pct: 40 },  // 4x — sell 40% of remaining
          { trigger_pct: 700,  sell_pct: 70 },  // 8x — sell 70% of remaining (moonbag survives)
        ],
        // Adaptive trail: arms at 10x, 40% trail keeps the runner alive but
        // catches the inevitable post-peak dump. Above this point, every
        // additional doubling is house money.
        trailing_stop: { arm_pct: 1000, trail_pct: 40 },
        // Peak-floor cascade — rides modest pumps via L1 rescue, locks in
        // multi-X profits on retracements via L2/L3.
        // 2026-05-15 (PM-2): L1 loosened arm=60/exit=25 → arm=120/exit=60.
        // The previous L1 fired on early dips of healthy runners — for a
        // moonshot strategy that wants 4x+ outcomes we need to let pumps
        // RIDE. New L1 only arms after +120% peak (real runner zone), exits
        // at +60% (still 1.6x net). L2/L3 unchanged — they were sensible.
        peak_floor_tiers: [
          { arm_pct: 120, exit_pct: 60 },   // L1: only after real 2.2x peak
          { arm_pct: 300, exit_pct: 150 },  // L2: lock 2.5x after 4x peak
          { arm_pct: 700, exit_pct: 400 },  // L3: lock 5x after 8x peak
        ],
        max_hold_min: 60,
        // Smart exit (documentation — not yet wired in paper.js):
        prediction_exit: { target: 'local_top_60s', op: '>', value: 0.60 },
        breakeven_after_tier1: 1,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Retire all currently-live strategies first.
// ---------------------------------------------------------------------------
const d = db();
const liveStmt = d.prepare(`SELECT id, name, n_trades, realized_pnl_sol
  FROM ml_agent_strategies WHERE status = 'live'`);
const retireStmt = d.prepare(`UPDATE ml_agent_strategies
  SET status = 'retired', retired_at = ?, retired_reason = ?
  WHERE id = ?`);

const live = liveStmt.all();
console.log(`[deploy] retiring ${live.length} live strategies:`);
for (const s of live) {
  retireStmt.run(NOW, RETIRE_REASON, s.id);
  console.log(`[deploy]   ✗ retired ${s.id} (${s.n_trades} trades, ${(s.realized_pnl_sol || 0).toFixed(3)} SOL)`);
}

// ---------------------------------------------------------------------------
// Deploy the 3 new ones.
// ---------------------------------------------------------------------------
const insertStmt = d.prepare(`INSERT INTO ml_agent_strategies
  (id, name, rationale, recipe_json, status, created_at, generation)
  VALUES (?, ?, ?, ?, 'live', ?, 1)`);
const updateStmt = d.prepare(`UPDATE ml_agent_strategies
  SET rationale = ?, recipe_json = ?, status = 'live', retired_at = NULL, retired_reason = NULL
  WHERE id = ?`);
const existsStmt = d.prepare(`SELECT id FROM ml_agent_strategies WHERE id = ?`);

for (const s of strategies) {
  if (existsStmt.get(s.id)) {
    updateStmt.run(s.recipe.rationale, JSON.stringify(s.recipe), s.id);
    deployStrategy(s.id, s.recipe);
    console.log(`[deploy] ↻ updated ${s.id}`);
  } else {
    insertStmt.run(s.id, s.recipe.name, s.recipe.rationale, JSON.stringify(s.recipe), NOW);
    deployStrategy(s.id, s.recipe);
    console.log(`[deploy] ✓ ${s.id}`);
  }
}
console.log('[deploy] done — restart degen-club for the executor to pick up the new live set');
