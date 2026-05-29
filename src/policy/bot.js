// policy/bot.js v3 — adaptive per-position tier exits.
//
// At entry, the bot predicts the peak return using ML regressions + the
// pump-probability ladder, then sets THAT position's tier targets adaptively:
//   - Tier 1 sell 40% at min(100%, predPeak * 0.30)
//   - Tier 2 sell 30% at min(250%, predPeak * 0.60)
//   - Tier 3 sell 30% at min(500%, predPeak * 1.00)
//   - Trailing stop on remaining 12% bag, arms at trail_arm, exits at peak−20%
//   - HARD_STOP at -40% stays as safety net
//
// Each position's tiers are persisted in paper_positions so we have a record
// of model-predicted vs actually-realized peaks → fuel for learning what
// works.
//
// Strong regressions:
//   drawdown_from_peak_pct      R²=0.71  — primary exit-timing signal
//   pump_durability_5min        R²=0.65
//   post_mig_peak_pct_4h        R²=0.65
//   post_mig_peak_pct_24h       R²=0.43
//   post_mig_ev_with_ladder_sol R²=0.46

import { db } from '../db.js';
import { config } from '../config.js';
import { predictMint } from '../ml/client.js';
import {
  openPaperPosition, closePaperPosition, partialSellAtTier, computeAdaptiveTiers,
  getOpenPositions, getWalletCash, getOpenExposure,
} from '../trading/paper.js';
import { watchMint, unwatchMint } from '../ingest/watchlist.js';

const STRATEGY_ID = 'ml-policy-v2';
const PRED_FRESHNESS_MS = 60000;

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    hasFreshPred: d.prepare("SELECT 1 FROM ml_predictions WHERE mint_address = ? AND timestamp > strftime('%s','now')*1000 - 60000 LIMIT 1"),
    latestPred: d.prepare("SELECT prob FROM ml_predictions WHERE mint_address = ? AND target = ? AND prob IS NOT NULL AND timestamp > strftime('%s','now')*1000 - ? ORDER BY timestamp DESC LIMIT 1"),
    candidates: d.prepare(`SELECT m.mint_address, m.bonding_curve_key, m.last_price_sol, m.current_market_cap_sol, m.migrated, m.name, m.symbol
      FROM mints m
      LEFT JOIN paper_positions pp ON pp.mint_address = m.mint_address AND pp.status='open'
      LEFT JOIN paper_positions recent ON recent.mint_address = m.mint_address AND recent.status='closed' AND recent.exited_at > strftime('%s','now')*1000 - ?
      WHERE m.created_at > strftime('%s','now')*1000 - 1800000
        AND m.created_at < strftime('%s','now')*1000 - 180000
        AND m.rugged = 0
        AND m.migrated = 0
        AND m.last_price_sol > 0
        AND m.last_price_sol < 1e-5
        AND m.current_market_cap_sol >= 15
        AND m.name IS NOT NULL
        AND pp.id IS NULL AND recent.id IS NULL
        AND EXISTS (SELECT 1 FROM ml_mint_snapshots s WHERE s.mint_address = m.mint_address)
      ORDER BY m.created_at DESC LIMIT 16`),
    openMl: d.prepare("SELECT * FROM paper_positions WHERE status='open' AND strategy=?"),
    mintByAddr: d.prepare('SELECT * FROM mints WHERE mint_address = ?'),
  };
  return _stmts;
}

function pred(mint, target) {
  return S().latestPred.get(mint, target, PRED_FRESHNESS_MS)?.prob;
}

// Latest wallet-skill signals from the freshest ml_mint_snapshots row for this
// mint. Returns object with default-0 fields so callers don't have to null-check.
// Cached 30s per mint to avoid hot-path DB hits. Bounded LRU at 500 entries
// — even though the bot wouldn't actually leak much (~50 bytes/entry), a cap
// keeps memory predictable. Prepared statement reused.
const _walletSigCache = new Map();
const WALLET_SIG_CACHE_MS = 30_000;
const WALLET_SIG_CACHE_MAX = 500;
let _walletSigStmt = null;
function walletSig(mint) {
  const cached = _walletSigCache.get(mint);
  if (cached && Date.now() - cached.at < WALLET_SIG_CACHE_MS) return cached.sig;
  let sig = { smart_buyer_count: 0, whale_buyer_count: 0, top_buyer_skill_p90: 0,
              smart_seller_count: 0, top_seller_skill_p90: 0, avg_buyer_hold_sec: 0 };
  try {
    if (!_walletSigStmt) {
      _walletSigStmt = db().prepare(`SELECT
        smart_buyer_count, whale_buyer_count, top_buyer_skill_p90,
        smart_seller_count, top_seller_skill_p90, avg_buyer_hold_sec
      FROM ml_mint_snapshots
      WHERE mint_address = ?
      ORDER BY snapshot_ts DESC LIMIT 1`);
    }
    const row = _walletSigStmt.get(mint);
    if (row) sig = row;
  } catch {}
  if (_walletSigCache.size >= WALLET_SIG_CACHE_MAX) {
    const oldest = _walletSigCache.keys().next().value;
    _walletSigCache.delete(oldest);
  }
  _walletSigCache.delete(mint);
  _walletSigCache.set(mint, { sig, at: Date.now() });
  return sig;
}

// Cached runtime threshold (updated by workers/threshold-tuner.js). Falls back
// to config default. Cache for 30s to avoid per-tick DB hits.
let _runtimeThreshold = null;
let _runtimeThresholdAt = 0;
function getRuntimeThreshold() {
  if (Date.now() - _runtimeThresholdAt < 30000) return _runtimeThreshold;
  try {
    const row = db().prepare("SELECT value FROM bot_runtime_settings WHERE key = 'entry_score_threshold'").get();
    if (row?.value != null) _runtimeThreshold = row.value;
  } catch {}
  _runtimeThresholdAt = Date.now();
  return _runtimeThreshold ?? config.policy.entryScoreThreshold;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Predict the peak return % from ML signals at entry time.
//   Post-mig: use post_mig_peak_pct_4h regression (R²=0.65, strong)
//   Pre-mig:  use the discrete pump-probability ladder (peaked_30/100/300)
//             since peak_pct_max regression is too noisy (R²=0.03)
function predictPeakPct(mint, isMigrated) {
  if (isMigrated) {
    const p4h = pred(mint, 'post_mig_peak_pct_4h');
    const p24h = pred(mint, 'post_mig_peak_pct_24h');
    // post_mig_peak_pct_4h is a fraction (0.50 = +50%). Floor lowered +50%->+20%
    // to match the pre-mig recalibration; no migrated closes in the last 3d to
    // fit against, so this stays conservative until data accrues.
    if (p4h != null) return Math.max(20, Math.min(500, Math.max(p4h, p24h ?? 0) * 100));
    return 60;
  }
  // Pre-mig expected peak — CALIBRATED 2026-05-28 to 3 days of realized peaks.
  // The prior probability-ladder used midpoints (65/200/500) ~3x too high and a
  // +50% floor, so it predicted ~53% while actual peaks averaged 17.7% with no
  // spread across outcomes. Of the model outputs only peaked_100 carries real
  // signal (p100>=0.20 cohort peaked ~34%; below that flat ~17%); peaked_300 is
  // near-noise so it only adds a small runner premium.
  const p100 = pred(mint, 'peaked_100') ?? 0;
  const p300 = pred(mint, 'peaked_300') ?? 0;
  const e = 10 + 85 * clamp01(p100) + 35 * clamp01(p300);
  return Math.max(10, Math.min(200, e));
}

function scoreEntryPreMig(mint) {
  const willRug = pred(mint, 'will_rug') ?? 0;
  const rugSoon = pred(mint, 'rug_within_5min') ?? 0;
  const peakSoon = pred(mint, 'peak_within_5min') ?? 0;
  // 2026-05-26: dropped will_die_fast veto. Data showed it killed 77% of
  // scored candidates but 47% of them 2x'd anyway. The model correctly
  // predicts "will die eventually" but that's true of basically every
  // pump.fun mint — and the brief pump before death is what tier exits catch.
  // Replaced with peaked_100 >= 0.05 hurdle: positive selection for mints
  // with a credible chance of doubling. Calibration: prob 0.05-0.10 → 53%
  // actual 2x rate; prob 0.10-0.20 → 66% actual; prob 0.20+ → 75%.
  const peaked100 = pred(mint, 'peaked_100') ?? 0;
  if (willRug > 0.12) return 0;
  if (rugSoon > 0.30) return 0;
  if (peakSoon > 0.55) return 0;
  if (peaked100 < 0.05) return 0;

  const p30 = pred(mint, 'peaked_30') ?? 0;
  const p100 = pred(mint, 'peaked_100') ?? 0;
  const p300 = pred(mint, 'peaked_300') ?? 0;
  const h2x = pred(mint, 'hits_2x_within_1h') ?? 0;

  const alive1h = pred(mint, 'alive_at_1h') ?? 0;
  const alive4h = pred(mint, 'alive_at_4h') ?? 0;
  const buyPress = pred(mint, 'buy_pressure_continues_60s') ?? 0;
  const pumpDur = pred(mint, 'pump_durability_5min') ?? 0;
  const willMigrate = pred(mint, 'will_migrate') ?? 0;
  const migSoon = pred(mint, 'migrates_within_15min') ?? 0;
  const buyersNext = pred(mint, 'unique_buyers_next_60s') ?? 0;
  const sellersNext = pred(mint, 'unique_sellers_next_60s') ?? 0;

  const pumpScore = 0.25 * p30 + 0.30 * p100 + 0.15 * p300 + 0.30 * h2x;
  const flowScore = 0.30 * buyPress + 0.20 * clamp01(pumpDur / 2) + 0.20 * alive1h + 0.15 * alive4h
                  + 0.15 * clamp01((buyersNext - sellersNext) / 8);
  const migBonus = 0.50 * migSoon + 0.30 * willMigrate;

  // 2026-05-28: REMOVED smart-money entry boost — it was anti-predictive.
  // 3d data: entries with 3+ smart buyers lost -0.65 SOL (142 trades) vs
  // +0.04 SOL for 0 smart buyers. "Smart" wallets here are snipers/flippers
  // that dump first, so boosting on them steered entries into the worst cohort
  // (and pickSize then sized them up). ML retrain can learn the true sign from
  // the snapshot features directly.
  const raw = 0.55 * pumpScore + 0.30 * flowScore + 0.15 * migBonus;
  return raw * (1 - willRug);
}

function scoreEntryPostMig(mint) {
  const rugs1h = pred(mint, 'post_mig_rugs_1h') ?? 0;
  if (rugs1h > 0.10) return 0;
  const ev = pred(mint, 'post_mig_ev_with_ladder_sol') ?? 0;
  const h2x = pred(mint, 'post_mig_hits_2x') ?? 0;
  const h50_30m = pred(mint, 'post_mig_hits_50pct_30m') ?? 0;
  const h100_1h = pred(mint, 'post_mig_hits_100pct_1h') ?? 0;
  const h130_4h = pred(mint, 'post_mig_hits_130pct_4h') ?? 0;
  const h186_4h = pred(mint, 'post_mig_hits_186pct_4h') ?? 0;
  const h30x_24h = pred(mint, 'post_mig_hits_30x_24h') ?? 0;
  const peak4h = pred(mint, 'post_mig_peak_pct_4h') ?? 0;
  const peak24h = pred(mint, 'post_mig_peak_pct_24h') ?? 0;
  const peakPlain = pred(mint, 'post_mig_peak_pct') ?? 0;
  const alive4h = pred(mint, 'post_mig_alive_4h') ?? 0;

  const pumpScore = 0.15 * h50_30m + 0.20 * h2x + 0.20 * h100_1h
                  + 0.15 * h130_4h + 0.10 * h186_4h + 0.10 * h30x_24h + 0.10 * alive4h;
  const peakScore = 0.40 * clamp01(peak4h / 2) + 0.30 * clamp01(peak24h / 3) + 0.30 * clamp01(peakPlain / 2);
  const evScore = clamp01(ev * 4);
  return (0.40 * evScore + 0.35 * pumpScore + 0.25 * peakScore) * (1 - rugs1h);
}

function scoreHold(mint, isMigrated) {
  if (isMigrated) {
    const peak4h = pred(mint, 'post_mig_peak_pct_4h') ?? 0;
    const peak24h = pred(mint, 'post_mig_peak_pct_24h') ?? 0;
    const h100_1h = pred(mint, 'post_mig_hits_100pct_1h') ?? 0;
    const h50_30m = pred(mint, 'post_mig_hits_50pct_30m') ?? 0;
    const alive4h = pred(mint, 'post_mig_alive_4h') ?? 0;
    const buyersNext = pred(mint, 'unique_buyers_next_60s') ?? 0;
    const dd30 = pred(mint, 'post_mig_drawdown_30_5min') ?? 0;
    const dd50 = pred(mint, 'post_mig_drawdown_50_5min') ?? 0;
    const rugs1h = pred(mint, 'post_mig_rugs_1h') ?? 0;
    const localTop = pred(mint, 'local_top_60s') ?? 0;
    const ddFromPeak = pred(mint, 'drawdown_from_peak_pct') ?? 0;
    const sellersNext = pred(mint, 'unique_sellers_next_60s') ?? 0;
    const bull = 0.30 * clamp01(peak4h / 2) + 0.20 * h100_1h + 0.15 * h50_30m + 0.15 * alive4h
               + 0.10 * clamp01(peak24h / 3) + 0.10 * clamp01(buyersNext / 20);
    const bear = 0.25 * clamp01(ddFromPeak / 30) + 0.15 * dd30 + 0.15 * dd50
               + 0.15 * rugs1h + 0.15 * localTop + 0.15 * clamp01(sellersNext / 20);
    return bull - bear;
  }
  const willMig = pred(mint, 'will_migrate') ?? 0;
  const migSoon = pred(mint, 'migrates_within_15min') ?? 0;
  const p100 = pred(mint, 'peaked_100') ?? 0;
  const buyPress = pred(mint, 'buy_pressure_continues_60s') ?? 0;
  const priceUp60 = pred(mint, 'price_up_60s') ?? 0;
  const priceUp300 = pred(mint, 'price_up_300s') ?? 0;
  const buyersNext = pred(mint, 'unique_buyers_next_60s') ?? 0;
  const alive1h = pred(mint, 'alive_at_1h') ?? 0;
  const localTop = pred(mint, 'local_top_60s') ?? 0;
  const dd20 = pred(mint, 'drawdown_20pct_300s') ?? 0;
  const willDie = pred(mint, 'will_die_fast') ?? 0;
  const peakSoon = pred(mint, 'peak_within_5min') ?? 0;
  const ddFromPeak = pred(mint, 'drawdown_from_peak_pct') ?? 0;

  // 2026-05-28: SMART-MONEY HOLD/SELL signals from wallet_stats snapshot join.
  // - smart sellers actively exiting = bearish (they know something)
  // - smart buyers still entering = bullish (smart money still believes)
  // 2026-05-28: kept smartSellWarn (smart money dumping = real death signal)
  // but dropped smartBuyKeep — smart *buying* is anti-predictive here (flippers),
  // so treating it as bullish was making the bot hold losers longer.
  const sig = walletSig(mint);
  const smartSellWarn = clamp01(sig.smart_seller_count / 4);

  const migBonus = 0.50 * migSoon + 0.30 * willMig;
  const bull = 0.25 * priceUp60 + 0.15 * priceUp300 + 0.20 * buyPress + 0.15 * p100
             + 0.15 * alive1h + 0.10 * clamp01(buyersNext / 15);
  const bear = 0.20 * clamp01(ddFromPeak / 30) + 0.25 * localTop + 0.20 * dd20
             + 0.20 * willDie + 0.15 * peakSoon
             + 0.15 * smartSellWarn;
  // 2026-05-26: gate migBonus by ddFromPeak. Stops "migration hope" from
  // keeping deeply-drawn-down mints alive past where they should exit.
  const migBonusGate = ddFromPeak < 12 ? 1.0 : 0.0;
  return bull - bear + 0.6 * migBonus * migBonusGate;
}

function pickSize(score, cash) {
  const sz = config.paper.entrySizeBase + (config.paper.entrySizeMax - config.paper.entrySizeBase) *
    Math.min(1, (score - getRuntimeThreshold()) / (1 - getRuntimeThreshold()));
  return Math.max(0.01, Math.min(sz, cash * 0.30));
}

// =========================================================================
// TIER + TRAIL EXECUTION
// For each open position: check tier triggers (partial sells), trailing stop,
// hard stop, then ML hold-score as the catch-all.
// =========================================================================
async function evaluateExit(p, m) {
  if (!m) return false;
  if (m.rugged) {
    await closePaperPosition(p, m.last_price_sol || p.entry_price, m.current_market_cap_sol || 0, 'RUGGED');
    unwatchMint(p.mint_address);
    return true;
  }
  // 2026-05-26: post-migration safety. We don't yet have AMM ingest, so once
  // a held mint migrates, its bonding-curve price stops updating. If the last
  // trade is >5min old AND the mint is migrated, force-close — we can't make
  // informed decisions on stale data.
  if (m.migrated && m.last_trade_at && Date.now() - m.last_trade_at > 30 * 60 * 1000) {
    console.log(`[policy] MIGRATED_NO_TRACKING ${p.mint_address.slice(0,8)}… last_trade ${Math.floor((Date.now() - m.last_trade_at)/60000)}min ago`);
    await closePaperPosition(p, m.last_price_sol || p.entry_price, m.current_market_cap_sol || 0, 'MIGRATED_NO_TRACKING');
    unwatchMint(p.mint_address);
    return true;
  }
  const curPct = m.last_price_sol > 0 ? (m.last_price_sol / p.entry_price - 1) * 100 : 0;
  const ageMin = (Date.now() - p.entered_at) / 60000;
  const peakPct = p.highest_pct || 0;
  const tradeStaleMin = m.last_trade_at ? (Date.now() - m.last_trade_at) / 60000 : null;

  // HARD STOP — safety net regardless of tier state
  if (curPct < -0.40 * 100) {
    console.log(`[policy] HARD_STOP ${p.mint_address.slice(0,8)}… pct=${curPct.toFixed(1)}%`);
    await closePaperPosition(p, m.last_price_sol || p.entry_price, m.current_market_cap_sol || 0, 'HARD_STOP_-40');
    unwatchMint(p.mint_address);
    return true;
  }

  // STALE_DATA — bonding-curve trades stopped (often the "bought at migration
  // moment" trap where pumpportal never fires its migration event for this mint
  // and trades stop on the BC). Trade-count-aware threshold:
  //   - low-interest coins (<50 trades): 10min quiet = dead (these never had real bids)
  //   - active coins  (≥50 trades): 15min quiet = dead (natural quiet stretches are common)
  // 2026-05-27: bumped from 5min flat after observing false positives where
  // pump.fun mints went quiet 5-7min then resumed trading.
  if (!m.migrated && tradeStaleMin != null && peakPct < 10 && ageMin > 10) {
    const tradeCount = m.trade_count || 0;
    const staleThreshMin = tradeCount < 50 ? 10 : 15;
    if (tradeStaleMin > staleThreshMin) {
      console.log(`[policy] STALE_DATA ${p.mint_address.slice(0,8)}… no trades ${tradeStaleMin.toFixed(1)}min (thresh=${staleThreshMin}, trades=${tradeCount}) · peak=${peakPct.toFixed(1)}%`);
      await closePaperPosition(p, m.last_price_sol || p.entry_price, m.current_market_cap_sol || 0, 'STALE_DATA');
      unwatchMint(p.mint_address);
      return true;
    }
  }

  // STALE_FLAT — sitting flat for an hour with no real pump. The ML hold-score
  // can keep "maybe it'll migrate" hope alive forever on these; this is a
  // hard cutoff so we recycle capital instead of bagholding.
  if (!m.migrated && ageMin > 60 && peakPct < 5 && Math.abs(curPct) < 15) {
    console.log(`[policy] STALE_FLAT ${p.mint_address.slice(0,8)}… age=${ageMin.toFixed(0)}min · peak=${peakPct.toFixed(1)}% · cur=${curPct.toFixed(1)}%`);
    await closePaperPosition(p, m.last_price_sol || p.entry_price, m.current_market_cap_sol || 0, 'STALE_FLAT');
    unwatchMint(p.mint_address);
    return true;
  }

  // NO_PUMP_TIMEOUT — even with mild drift, 90+min and no real pump = dead.
  if (!m.migrated && ageMin > 90 && peakPct < 10) {
    console.log(`[policy] NO_PUMP_TIMEOUT ${p.mint_address.slice(0,8)}… age=${ageMin.toFixed(0)}min · peak=${peakPct.toFixed(1)}% · cur=${curPct.toFixed(1)}%`);
    await closePaperPosition(p, m.last_price_sol || p.entry_price, m.current_market_cap_sol || 0, 'NO_PUMP_TIMEOUT');
    unwatchMint(p.mint_address);
    return true;
  }

  // STALLED_PUMP — peaked modestly (10-30%) then died. T1 never fired (set at
  // +50% by default), so the trailing stop never armed. Without this rule,
  // these positions just drift until they hit HARD_STOP at -40%, costing more.
  // Trigger when: age>90, peak in [10,30], cur < -10. Recycle capital.
  if (!m.migrated && ageMin > 90 && peakPct >= 10 && peakPct < 30 && curPct < -10) {
    console.log(`[policy] STALLED_PUMP ${p.mint_address.slice(0,8)}… age=${ageMin.toFixed(0)}min · peak=${peakPct.toFixed(1)}% · cur=${curPct.toFixed(1)}%`);
    await closePaperPosition(p, m.last_price_sol || p.entry_price, m.current_market_cap_sol || 0, 'STALLED_PUMP');
    unwatchMint(p.mint_address);
    return true;
  }

  // Parse tiers_hit so we don't fire same tier twice
  let tiersHit;
  try { tiersHit = JSON.parse(p.tiers_hit || '[]'); }
  catch { tiersHit = []; }

  // Position has adaptive tiers configured?
  const hasTiers = p.tier1_trigger_pct != null && p.tier1_sell_pct != null;

  if (hasTiers) {
    // Tier 1
    if (!tiersHit.includes('T1') && curPct >= p.tier1_trigger_pct) {
      await partialSellAtTier(p, 'T1', p.tier1_sell_pct, m.last_price_sol, m.current_market_cap_sol);
      return false; // not fully closed — keep watching
    }
    // Tier 2
    if (p.tier2_trigger_pct != null && !tiersHit.includes('T2') && curPct >= p.tier2_trigger_pct) {
      await partialSellAtTier(p, 'T2', p.tier2_sell_pct, m.last_price_sol, m.current_market_cap_sol);
      return false;
    }
    // Tier 3 — final tier sells the rest
    if (p.tier3_trigger_pct != null && !tiersHit.includes('T3') && curPct >= p.tier3_trigger_pct) {
      await partialSellAtTier(p, 'T3', p.tier3_sell_pct, m.last_price_sol, m.current_market_cap_sol);
      // After T3 there's only the trailing-bag remainder
      return false;
    }
    // Trailing stop — active after T1 hit
    const trailArmed = (p.trail_armed === 1) || tiersHit.length >= 1;
    if (trailArmed && p.trail_pct != null && curPct < (p.highest_pct || curPct) - p.trail_pct) {
      console.log(`[policy] TRAIL_STOP ${p.mint_address.slice(0,8)}… peak=${(p.highest_pct||0).toFixed(1)}% now=${curPct.toFixed(1)}%`);
      await closePaperPosition(p, m.last_price_sol || p.entry_price, m.current_market_cap_sol || 0, 'TRAIL_STOP');
      unwatchMint(p.mint_address);
      return true;
    }
  }

  // ML hold-score (works for both tier and non-tier positions as a catch-all)
  if (!S().hasFreshPred.get(p.mint_address)) {
    try { await predictMint(p.mint_address); } catch {}
  }
  const hold = scoreHold(p.mint_address, m.migrated === 1);
  if (hold < config.policy.holdScoreFloor) {
    console.log(`[policy] SELL ${p.mint_address.slice(0,8)}… phase=${m.migrated?'POST':'PRE'} hold=${hold.toFixed(2)} pct=${curPct.toFixed(1)}%`);
    await closePaperPosition(p, m.last_price_sol || p.entry_price, m.current_market_cap_sol || 0, 'ML_SELL');
    unwatchMint(p.mint_address);
    return true;
  }
  return false;
}

let _tickBusy = false;
async function tick() {
  if (_tickBusy) return;
  _tickBusy = true;
  try {
    const s = S();
    const open = getOpenPositions(STRATEGY_ID);
    const exposure = getOpenExposure();
    const cash = getWalletCash();

    // EXIT EVALUATION
    for (const p of open) {
      const m = s.mintByAddr.get(p.mint_address);
      await evaluateExit(p, m);
    }

    // ENTRY EVALUATION
    if (exposure.n >= config.paper.maxOpenPositions) return;
    if (exposure.exposureSol >= config.paper.maxOpenExposureSol) return;
    if (cash < 0.05) return;

    const candidates = s.candidates.all(config.paper.reentryCooldownMs);
    let opened = 0;
    for (const c of candidates) {
      if (opened >= 3) break;
      if (!s.hasFreshPred.get(c.mint_address)) {
        try { await predictMint(c.mint_address); } catch {}
      }
      const isMig = c.migrated === 1;
      const score = isMig ? scoreEntryPostMig(c.mint_address) : scoreEntryPreMig(c.mint_address);
      if (score < getRuntimeThreshold()) continue;
      const size = pickSize(score, cash);
      if (size < 0.05) continue;

      // Compute this position's adaptive tiers from ML peak prediction
      const predPeak = predictPeakPct(c.mint_address, isMig);
      const tiers = { ...computeAdaptiveTiers(predPeak, isMig), predictedPeak: predPeak };

      const positionId = await openPaperPosition({
        strategy: STRATEGY_ID,
        mintAddress: c.mint_address,
        entryPrice: c.last_price_sol,
        entrySol: size,
        entryMcap: c.current_market_cap_sol || 0,
        entryScore: score,
        phase: isMig ? 'post-mig' : 'pre-mig',
        tiers,
      });
      if (positionId) {
        console.log(`[policy] OPEN ${c.mint_address.slice(0,8)}… (${c.symbol||'?'}) phase=${isMig?'POST':'PRE'} score=${score.toFixed(3)} size=${size.toFixed(3)} predPeak=${predPeak.toFixed(0)}% T1=${tiers.t1_trig.toFixed(0)}/${(tiers.t1_sell*100).toFixed(0)}% T2=${tiers.t2_trig.toFixed(0)}/${(tiers.t2_sell*100).toFixed(0)}% T3=${tiers.t3_trig.toFixed(0)}/${(tiers.t3_sell*100).toFixed(0)}%`);
        if (c.bonding_curve_key) await watchMint(c.mint_address);
        opened++;
      }
    }
  } catch (err) {
    console.error('[policy] tick err:', err.message);
  } finally {
    _tickBusy = false;
  }
}

let _interval = null;
export function startPolicyBot() {
  if (_interval) return;
  setTimeout(tick, 5000);
  _interval = setInterval(tick, config.policy.tickMs);
  console.log(`[policy] started · cadence=${config.policy.tickMs}ms · threshold=${getRuntimeThreshold().toFixed(3)} (runtime) · holdFloor=${config.policy.holdScoreFloor} · adaptive tiers ENABLED`);
}
