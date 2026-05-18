// Agent executor — evaluates the agent's live strategy recipes against fresh
// mints and fires paper trades when entry conditions match.
//
// Recipe entry/sizing are evaluated here. Recipe exits are translated to
// strategy_state rows so the existing position monitor handles them with the
// battle-tested SL/TP/trailing logic. The agent doesn't need to reinvent exits.

import { db } from '../db/index.js';
import { collectFeatures } from './feature-collector.js';
import { getAllPredictions, isHealthy } from './ml-client.js';
import { openPaperPosition } from '../trading/paper.js';

// Paper wallet starts with 1 SOL by default. We compute available cash live
// to avoid oversubscribing — agent could otherwise fire 20 trades at 0.10 SOL
// each on a 1 SOL wallet and confuse its own PnL math.
const MIN_RESERVE_SOL = 0.05;  // never spend below this — keeps room for friction

const TICK_INTERVAL_MS = 60 * 1000;       // evaluate strategies once a minute
// 2026-05-15 (PM-5): cooldowns moved from hardcoded constants → per-recipe.
// A recipe may declare:
//   cooldowns: { after_exit_ms: <ms>, after_fast_fail_ms: <ms> }
//   skip_smell_test: <bool>   // bypass the universal counter-evidence veto
// If a recipe omits these, the defaults below apply (preserves prior behavior).
// Set after_exit_ms / after_fast_fail_ms to 0 to disable that cooldown entirely.
const DEFAULT_ENTRY_COOLDOWN_MS  = 10 * 60 * 1000;
const DEFAULT_FAILED_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_CANDIDATES = 30;                // mint candidates per tick

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    liveStrategies: d.prepare(`SELECT * FROM ml_agent_strategies WHERE status = 'live' ORDER BY created_at`),
    // Pre-migration candidates (the original pool — fresh bonding-curve mints)
    candidates: d.prepare(`SELECT mint_address, last_trade_at, created_at FROM mints
       WHERE migrated = 0 AND rugged = 0 AND last_trade_at > ?
       ORDER BY last_trade_at DESC LIMIT ?`),
    // Post-migration candidates — fresh migrators with active AMM volume.
    // Strategies opt-in via the recipe's 'targets_migrated' flag (default false).
    migratedCandidates: d.prepare(`SELECT mint_address, migrated_at, amm_liquidity_usd, amm_volume_h24_usd, current_market_cap_sol
       FROM mints WHERE migrated = 1 AND rugged = 0
         AND migrated_at > strftime('%s','now')*1000 - 72 * 3600000
         AND amm_liquidity_usd > 1000
       ORDER BY amm_volume_h24_usd DESC LIMIT ?`),
    recentEntry: d.prepare(`SELECT id FROM paper_positions
       WHERE strategy = ? AND mint_address = ? AND entered_at > ?
       LIMIT 1`),
    // 2026-05-15: extended-cooldown lookup for coins that already failed
    // our entry premise via FAST_FAIL / FAKE_PUMP.
    recentFailedExit: d.prepare(`SELECT id FROM paper_positions
       WHERE strategy = ? AND mint_address = ? AND exited_at > ?
         AND exit_reason IN ('FAST_FAIL', 'FAKE_PUMP', 'SL_HIT')
       LIMIT 1`),
    // Hard dedup: never enter a mint on a strategy while we already hold an
    // open position on it. 2026-05-12 bug: 10-min cooldown allowed re-entry
    // on the SAME mint that was still being held (GOATSE/OPAQUE doubled-up).
    openOnMint: d.prepare(`SELECT id FROM paper_positions
       WHERE strategy = ? AND mint_address = ? AND status = 'open'
       LIMIT 1`),
    bumpEvaluated: d.prepare(`UPDATE ml_agent_strategies SET last_evaluated_at = ? WHERE id = ?`),
    bumpTrade: d.prepare(`UPDATE ml_agent_strategies SET n_trades = n_trades + 1 WHERE id = ?`),
    // Section B gates (Phase D, 2026-05-13) — sentiment / narrative / creator lookups.
    // Each is lazy-fetched only when a recipe condition actually references the kind.
    mintSentiment: d.prepare(`SELECT bull_mentions, bear_mentions, shill_mentions,
       fud_mentions, neutral_mentions, total_mentions, sum_confidence, last_updated_at
       FROM mint_sentiment WHERE mint_address = ? AND window_start = ?`),
    hotNarrativeThemes: d.prepare(`SELECT theme FROM narrative_sentiment
       WHERE window_start = ? ORDER BY total_mentions DESC LIMIT 20`),
    creatorMintMeta: d.prepare(`SELECT name, symbol, creator_wallet, description
       FROM mints WHERE mint_address = ?`),
    creatorMigratedCount: d.prepare(`SELECT COUNT(*) AS n FROM mints
       WHERE creator_wallet = ? AND migrated = 1`),
    creatorRecentSiblings: d.prepare(`SELECT COUNT(*) AS n FROM mints
       WHERE creator_wallet = ? AND mint_address != ? AND created_at > ?`),
    creatorPrevDeath: d.prepare(`SELECT last_trade_at FROM mints
       WHERE creator_wallet = ? AND mint_address != ? AND last_trade_at IS NOT NULL
       AND last_trade_at < ?
       ORDER BY last_trade_at DESC LIMIT 1`),
    paperWallet: d.prepare(`SELECT * FROM paper_wallet WHERE id = 1`),
    paperClosedPnl: d.prepare(`SELECT COALESCE(SUM(realized_pnl_sol), 0) AS pnl
       FROM paper_positions WHERE status = 'closed' AND entered_at >= ?`),
    paperOpenLocked: d.prepare(`SELECT COALESCE(SUM(entry_sol - sol_realized_so_far), 0) AS locked
       FROM paper_positions WHERE status = 'open' AND is_moonbag = 0 AND entered_at >= ?`),
    upsertStrategyState: d.prepare(`INSERT OR REPLACE INTO strategy_state
       (name, label, description, enabled, entry_sol, sl_pct, max_hold_min,
        tier1_trigger_pct, tier1_sell_pct,
        tier2_trigger_pct, tier2_sell_pct,
        tier3_trigger_pct, tier3_sell_pct, tier3_trail_pct,
        breakeven_after_tier1,
        peak_floor_arm_pct, peak_floor_exit_pct,
        peak_floor_arm2_pct, peak_floor_exit2_pct,
        peak_floor_arm3_pct, peak_floor_exit3_pct,
        pred_exit_target, pred_exit_op, pred_exit_value,
        dca_enabled, dca_trigger_pct, dca_size_pct,
        dca_min_age_sec, dca_max_age_min, dca_max_dca,
        fast_fail_sec, fast_fail_min_peak_pct, fast_fail_sl_pct,
        fakepump_sec, fakepump_min_peak_pct, fakepump_sl_pct,
        stagnant_exit_min, stagnant_loss_pct,
        moonbag_pct_reserve,
        updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  };
  return stmts;
}

// Compute free cash available for a new paper trade. Same math as sizing.js's
// getWalletValue() cash component — starting balance + closed PnL − open locked.
function getAvailableCash() {
  try {
    const w = S().paperWallet.get();
    if (!w) return 0;
    const closed = S().paperClosedPnl.get(w.started_at).pnl || 0;
    const open = S().paperOpenLocked.get(w.started_at).locked || 0;
    const cash = (w.starting_balance_sol || 1.0) + closed - open;
    return Math.max(0, cash);
  } catch (err) { return 0; }
}

// Section E (Phase D, 2026-05-13): composite score.
// Weighted sum of normalized 0-1 signals, output clamped to 0-1. A strategy
// uses {kind: 'composite_score', op: '>=', value: 0.65} as a single hard gate
// that captures "any combination of ML/tracker/sentiment/narrative/microstructure
// that adds up." Complements the strict AND-style ml_prediction/feature gates.
//
// Per-strategy override: recipe.entry.composite_weights = {migrated: 0.30, ...}
// merges over the defaults below. Missing signals (e.g., no sentiment row yet)
// contribute 0 — gate is still computable, not skipped.
const DEFAULT_COMPOSITE_WEIGHTS = {
  // Positive ML signals
  migrated:                 0.20,
  hits_5x_within_24h:       0.15,
  peaked_300:               0.15,
  peak_pct_max:             0.10,   // capped at 5x = 1.0
  // Non-ML positive signals
  tracker_quality:          0.10,   // weighted_buyer_quality normalized
  narrative_match:          0.05,
  sentiment_net:            0.05,   // (bull - shill) / 10 capped
  volume_velocity:          0.05,   // inflow_accel_pct capped (positive only)
  // Penalties (negative weights)
  will_die_fast_penalty:   -0.15,
  rug_within_5min_penalty: -0.10,
};

function computeComposite(features, preds, sentimentCtx, narrativeCtx, weights) {
  const w = { ...DEFAULT_COMPOSITE_WEIGHTS, ...(weights || {}) };
  const cap1 = (x) => Math.max(0, Math.min(1, x));
  let s = 0;
  // Positive ML signals
  s += w.migrated           * cap1(preds.migrated || 0);
  s += w.hits_5x_within_24h * cap1(preds.hits_5x_within_24h || 0);
  s += w.peaked_300         * cap1(preds.peaked_300 || 0);
  s += w.peak_pct_max       * cap1((preds.peak_pct_max || 0) / 5);
  // Tracker quality — weighted_buyer_quality is a sum of (51 - rank) across
  // distinct top-50 buyers, so a single rank-1 buyer = 50, max practical ~150.
  // Normalize by 100 to get a sensible 0-1ish range.
  s += w.tracker_quality * cap1((features.weighted_buyer_quality || 0) / 100);
  // Narrative match — fraction of 5 matches captures most cases
  s += w.narrative_match * cap1((narrativeCtx?.match_count || 0) / 5);
  // Sentiment net (bull − shill, normalized by 10 mentions)
  const bull = sentimentCtx?.bull_mentions_4h || 0;
  const shill = sentimentCtx?.shill_mentions_4h || 0;
  s += w.sentiment_net * cap1((bull - shill) / 10);
  // Volume velocity — only positive accel contributes (decel doesn't hurt the score)
  s += w.volume_velocity * cap1(Math.max(0, features.inflow_accel_pct || 0));
  // Penalties (weights are negative)
  s += w.will_die_fast_penalty   * cap1(preds.will_die_fast || 0);
  s += w.rug_within_5min_penalty * cap1(preds.rug_within_5min || 0);
  return Math.max(0, Math.min(1, s));
}

// Section D3 (2026-05-13): counter-evidence smell test. After a strategy's
// gates pass, this runs a SECOND check for adverse signals. Hard veto if any
// fire. Applies to ALL strategies — these are universal red flags.
const SMELL_VETO_SHILL_MENTIONS = 5;
const SMELL_VETO_BUNDLE_FRAC = 0.30;
const SMELL_VETO_TOP1_BUYER_FRAC = 0.50;
const SMELL_VETO_CREATOR_SELLS = 3;

function smellTestVeto(features, sentimentCtx) {
  if (sentimentCtx && (sentimentCtx.shill_mentions_4h || 0) >= SMELL_VETO_SHILL_MENTIONS) {
    return `shill=${sentimentCtx.shill_mentions_4h}`;
  }
  const bundleBuyers = features.bundle_buyers || 0;
  const uniqueBuyers = features.unique_buyers || 0;
  if (uniqueBuyers >= 5 && (bundleBuyers / uniqueBuyers) >= SMELL_VETO_BUNDLE_FRAC) {
    return `bundle=${((bundleBuyers / uniqueBuyers) * 100).toFixed(0)}%`;
  }
  if ((features.top1_buyer_sol_pct || 0) >= SMELL_VETO_TOP1_BUYER_FRAC) {
    return `top1=${((features.top1_buyer_sol_pct) * 100).toFixed(0)}%`;
  }
  if ((features.creator_sells_post_launch || 0) >= SMELL_VETO_CREATOR_SELLS) {
    return `creator_sells=${features.creator_sells_post_launch}`;
  }
  return null;
}

// Section D1 (2026-05-13): identify tracker wallets that bought this mint in
// the 60s window before our entry. Both for entry attribution writeback AND
// for the tracker-concentration cap that mutes over-represented wallets.
let _attribStmt = null;
function attributeTrackers(mintAddress) {
  try {
    if (!_attribStmt) {
      _attribStmt = db().prepare(`
        SELECT DISTINCT t.wallet FROM trades t
        JOIN wallets w ON w.address = t.wallet
        WHERE t.mint_address = ? AND t.is_buy = 1
          AND t.timestamp >= ? AND w.tracked = 1
      `);
    }
    const since = Date.now() - 60 * 1000;
    return _attribStmt.all(mintAddress, since).map(r => r.wallet);
  } catch { return []; }
}

// Section B context fetchers — lazy, called only when a recipe condition
// references the kind. Each returns null when no data is available; downstream
// evalCondition then SKIPS that gate (treated as no-opinion, not a fail).
function fetchSentimentCtx(mintAddress) {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const windowStart = Math.floor(Date.now() / FOUR_HOURS) * FOUR_HOURS;
  const row = S().mintSentiment.get(mintAddress, windowStart);
  if (!row || !row.total_mentions) return null;
  return {
    bull_mentions_4h: row.bull_mentions || 0,
    bear_mentions_4h: row.bear_mentions || 0,
    shill_mentions_4h: row.shill_mentions || 0,
    fud_mentions_4h: row.fud_mentions || 0,
    neutral_mentions_4h: row.neutral_mentions || 0,
    total_mentions_4h: row.total_mentions || 0,
    avg_confidence: row.total_mentions > 0 ? (row.sum_confidence / row.total_mentions) : 0,
  };
}

function fetchNarrativeCtx(mintAddress) {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const windowStart = Math.floor(Date.now() / FOUR_HOURS) * FOUR_HOURS;
  const hot = S().hotNarrativeThemes.all(windowStart);
  if (!hot.length) return null;
  const meta = S().creatorMintMeta.get(mintAddress);
  if (!meta) return null;
  const haystack = (`${meta.name || ''} ${meta.symbol || ''} ${meta.description || ''}`).toLowerCase();
  if (!haystack.trim()) return { match_count: 0 };
  let matchCount = 0;
  for (const r of hot) {
    const theme = (r.theme || '').toLowerCase().trim();
    if (theme.length >= 2 && haystack.includes(theme)) matchCount++;
  }
  return { match_count: matchCount };
}

function fetchCreatorCtx(mintAddress) {
  const meta = S().creatorMintMeta.get(mintAddress);
  if (!meta?.creator_wallet) return null;
  const created = meta.created_at || Date.now();
  const migratedRow = S().creatorMigratedCount.get(meta.creator_wallet);
  const siblingsRow = S().creatorRecentSiblings.get(meta.creator_wallet, mintAddress, Date.now() - 3600 * 1000);
  const prevDeathRow = S().creatorPrevDeath.get(meta.creator_wallet, mintAddress, Date.now());
  const secondsSincePrevDeath = prevDeathRow?.last_trade_at
    ? Math.max(0, Math.round((Date.now() - prevDeathRow.last_trade_at) / 1000))
    : null;
  return {
    migrated_count: migratedRow?.n || 0,
    recent_launch_siblings: siblingsRow?.n || 0,
    seconds_since_prev_death: secondsSincePrevDeath,  // null if no prior mint died
  };
}

const _CMP_OPS = {
  '>':  (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<':  (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
};

// Returns: true (gate passes), false (HARD reject — strategy fails entry),
// or 'skip' (no data, gate has no opinion). Caller treats skip as "pass with
// caveat" — at least one non-skip gate must evaluate per strategy.
function evalCondition(c, ctx) {
  let lhs;
  switch (c.kind) {
    case 'ml_prediction':
      lhs = ctx.preds[c.name];
      if (lhs == null) return false;  // core gate — missing prediction = HARD reject
      break;
    case 'feature':
    case 'snapshot_feature':  // explicit name, same lookup
      lhs = ctx.features[c.name];
      if (lhs == null) return false;  // core gate — missing feature = HARD reject
      break;
    case 'sentiment':
      if (!ctx.sentiment) return 'skip';
      lhs = ctx.sentiment[c.metric];
      if (lhs == null) return 'skip';
      break;
    case 'narrative_match':
      if (!ctx.narrative) return 'skip';
      lhs = ctx.narrative.match_count;
      break;
    case 'creator_stat':
      if (!ctx.creator) return 'skip';
      lhs = ctx.creator[c.name];
      if (lhs == null) return 'skip';
      break;
    case 'composite_score':
      // Section E (2026-05-13): always computable — missing sub-signals just
      // contribute 0 to the weighted sum. Treated as HARD gate (not skip)
      // since composite by definition aggregates whatever signal is present.
      lhs = computeComposite(ctx.features, ctx.preds, ctx.sentiment, ctx.narrative, ctx.compositeWeights);
      break;
    case 'mint_state': {
      // 2026-05-17: gate on a column from the mints table for this mintAddress.
      // Examples: { kind: 'mint_state', name: 'migrated', op: '=', value: 1 }
      //           { kind: 'mint_state', name: 'rugged', op: '=', value: 0 }
      // Cached on ctx so multiple mint_state conditions share one query.
      if (!ctx.mintAddress) return false;
      if (!ctx._mintState) {
        ctx._mintState = db().prepare(
          `SELECT migrated, rugged, migrated_at, rugged_at, peak_market_cap_sol
           FROM mints WHERE mint_address = ?`
        ).get(ctx.mintAddress) || {};
      }
      lhs = ctx._mintState[c.name];
      if (lhs == null) return false;
      break;
    }
    case 'wallet_pool': {
      // 2026-05-17: count distinct wallets from a named pool who bought this
      // mint within window_sec. Pools resolve dynamically via SQL — recipe
      // stays small and stays fresh as pool membership changes.
      if (!ctx.mintAddress) return false;
      const windowSec = c.window_sec || 600;
      const since = Date.now() - windowSec * 1000;
      let sql;
      if (c.pool === 'elite_5x') {
        sql = `SELECT COUNT(DISTINCT t.wallet) AS n FROM trades t
               JOIN wallet_5x_score w ON w.address = t.wallet AND w.is_elite = 1
               WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp >= ?`;
      } else if (c.pool === 'super_elite_5x') {
        // 2026-05-17 PM: strict subset — ≥35% hit rate AND ≥100 coins_5x.
        // Filters out the long-tail 25-30% wallets that triggered V4's
        // deep losers.
        sql = `SELECT COUNT(DISTINCT t.wallet) AS n FROM trades t
               JOIN wallet_5x_score w ON w.address = t.wallet AND w.is_super_elite = 1
               WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp >= ?`;
      } else if (c.pool === 'mega_elite_5x') {
        // 50x specialists: ≥30 coins_50x AND ≥45% hit rate. ~50-100 wallets.
        sql = `SELECT COUNT(DISTINCT t.wallet) AS n FROM trades t
               JOIN wallet_5x_score w ON w.address = t.wallet AND w.is_mega_elite = 1
               WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp >= ?`;
      } else if (c.pool === 'ultra_elite_5x') {
        // Unicorn hunters: ≥50 coins_50x AND ≥55% hit rate. Tiny pool (~20-40).
        sql = `SELECT COUNT(DISTINCT t.wallet) AS n FROM trades t
               JOIN wallet_5x_score w ON w.address = t.wallet AND w.is_ultra_elite = 1
               WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp >= ?`;
      } else if (c.pool === 'tracked') {
        sql = `SELECT COUNT(DISTINCT t.wallet) AS n FROM trades t
               JOIN wallets w ON w.address = t.wallet AND w.tracked = 1
               WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp >= ?`;
      } else if (c.pool === 'kol') {
        sql = `SELECT COUNT(DISTINCT t.wallet) AS n FROM trades t
               JOIN wallets w ON w.address = t.wallet AND w.is_kol = 1
               WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp >= ?`;
      } else {
        return false;  // unknown pool name
      }
      const row = db().prepare(sql).get(ctx.mintAddress, since);
      lhs = row?.n || 0;
      break;
    }
    default:
      return false;  // unknown kind — fail closed
  }
  const op = _CMP_OPS[c.op];
  if (!op) return false;
  return op(lhs, c.value);
}

// Live sniper-ratio compute for recipes that override the global 3s window.
// Used when recipe.entry.sniper_seconds_window is set (e.g. 5 = "sniper means
// any buy within 5s"). Overrides ctx.features.pct_sniper_buys before
// conditions evaluate. Cheap query (per-entry, indexed by mint).
function computeLivePctSniper(mintAddress, secondsWindow) {
  try {
    const row = db().prepare(
      `SELECT COUNT(*) AS n_buys,
              SUM(CASE WHEN seconds_from_creation <= ? THEN 1 ELSE 0 END) AS n_snipers
       FROM trades WHERE mint_address = ? AND is_buy = 1`
    ).get(secondsWindow, mintAddress);
    if (!row || !row.n_buys) return null;
    return (row.n_snipers || 0) / row.n_buys;
  } catch { return null; }
}

function logEntryRejection(recipe, mintAddress, c, ctx, features) {
  try {
    const recipeName = (recipe && recipe.name) || 'unknown';
    const actualVal = c.kind === 'ml_prediction' ? (ctx.preds?.[c.name])
                    : c.kind === 'snapshot_feature' ? (ctx.features?.[c.name])
                    : null;
    const actualNum = (typeof actualVal === 'number') ? actualVal : null;
    const mcapAtRej = features?.last_mcap_sol ?? null;
    const ageSecAtRej = features?.snapshot_age_sec ?? null;
    db().prepare(`INSERT INTO strategy_entry_rejections
      (strategy_id, mint_address, gate_kind, gate_name, gate_op, threshold, actual,
       rejected_at, reject_count, mcap_at_reject, age_sec_at_reject)
      VALUES (?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(strategy_id, mint_address, gate_name) DO UPDATE SET
        reject_count = reject_count + 1,
        actual = excluded.actual,
        mcap_at_reject = excluded.mcap_at_reject,
        age_sec_at_reject = excluded.age_sec_at_reject`).run(
      recipeName, mintAddress, c.kind, c.name, c.op || null,
      (typeof c.value === 'number') ? c.value : null,
      actualNum, Date.now(), mcapAtRej, ageSecAtRej);
  } catch {}
}

function evalEntry(recipe, mintAddress, features, preds) {
  const entry = recipe.entry || {};
  const ageSec = features.snapshot_age_sec || 0;
  if (entry.min_mint_age_sec && ageSec < entry.min_mint_age_sec) return false;
  if (entry.max_mint_age_sec && ageSec > entry.max_mint_age_sec) return false;
  // Copy-trade gate: if the recipe lists target wallets, one of them must
  // have bought the mint within the lookback window.
  if (Array.isArray(entry.copy_trade_wallets) && entry.copy_trade_wallets.length > 0 && mintAddress) {
    const windowSec = entry.copy_trade_window_sec || 60;
    const since = Date.now() - windowSec * 1000;
    const placeholders = entry.copy_trade_wallets.map(() => '?').join(',');
    const hit = db().prepare(
      `SELECT 1 FROM trades WHERE mint_address = ? AND is_buy = 1
         AND wallet IN (${placeholders}) AND timestamp >= ? LIMIT 1`
    ).get(mintAddress, ...entry.copy_trade_wallets, since);
    if (!hit) return false;
  }

  // 2026-05-15 (PM-6): per-recipe sniper window. Default snapshot value uses
  // global 3s sniper definition. If recipe specifies a different window,
  // recompute pct_sniper_buys live and override the feature value before
  // conditions evaluate.
  let effFeatures = features;
  if (entry.sniper_seconds_window && entry.sniper_seconds_window !== 3) {
    const livePct = computeLivePctSniper(mintAddress, entry.sniper_seconds_window);
    if (livePct != null) effFeatures = { ...features, pct_sniper_buys: livePct };
  }

  const conds = entry.conditions || [];
  const groups = Array.isArray(entry.condition_groups) ? entry.condition_groups : [];
  // 2026-05-15 (PM-6): support OR-of-AND-groups via condition_groups.
  // Backwards compat: a recipe with flat `conditions` still works (pure AND).
  // A recipe can use ONLY condition_groups (no flat conds) — at least one
  // group must have all its sub-conditions pass.
  if (conds.length === 0 && groups.length === 0) return false;

  // Build ctx — fetch sentiment/narrative/creator if ANY condition (flat or
  // grouped) references them, so OR-group conditions see the same context.
  const allConds = [...conds, ...groups.flat().filter(Boolean)];
  const usesComposite = allConds.some(c => c?.kind === 'composite_score');
  const ctx = { features: effFeatures, preds, mintAddress };
  if (usesComposite || allConds.some(c => c?.kind === 'sentiment')) {
    ctx.sentiment = fetchSentimentCtx(mintAddress);
  }
  if (usesComposite || allConds.some(c => c?.kind === 'narrative_match')) {
    ctx.narrative = fetchNarrativeCtx(mintAddress);
  }
  if (allConds.some(c => c?.kind === 'creator_stat')) ctx.creator = fetchCreatorCtx(mintAddress);
  if (entry.composite_weights && typeof entry.composite_weights === 'object') {
    ctx.compositeWeights = entry.composite_weights;
  }

  // Step 1: flat conditions (AND). Every flat condition must pass.
  let evaluated = 0;
  let passed = 0;
  for (const c of conds) {
    const r = evalCondition(c, ctx);
    if (r === false) {
      logEntryRejection(recipe, mintAddress, c, ctx, features);
      return false;
    }
    if (r === 'skip') { evaluated++; continue; }
    if (r === true) { evaluated++; passed++; }
  }

  // Step 2: OR-groups. At least one group must have all sub-conditions pass.
  if (groups.length > 0) {
    let anyGroupPassed = false;
    let firstFailedConditionInBestGroup = null;
    let bestGroupReached = 0; // how many sub-conditions a group cleared before failing
    for (const group of groups) {
      if (!Array.isArray(group) || group.length === 0) continue;
      let groupPassed = true;
      let cleared = 0;
      let failedAt = null;
      for (const c of group) {
        const r = evalCondition(c, ctx);
        if (r === false) { groupPassed = false; failedAt = c; break; }
        if (r === true || r === 'skip') cleared++;
      }
      if (groupPassed) {
        anyGroupPassed = true;
        // Count this group's passing conditions toward the safety check below
        passed += cleared;
        evaluated += group.length;
        break;
      }
      if (cleared > bestGroupReached) {
        bestGroupReached = cleared;
        firstFailedConditionInBestGroup = failedAt;
      }
    }
    if (!anyGroupPassed) {
      // Log the deepest-reaching group's failing condition as the rejection
      // (best signal of what's blocking entry).
      if (firstFailedConditionInBestGroup) {
        logEntryRejection(recipe, mintAddress, firstFailedConditionInBestGroup, ctx, features);
      }
      return false;
    }
  }

  // Safety: at least one core gate must have actually evaluated (not all skipped).
  if (passed === 0) return false;
  return true;
}

// Cached union of every active recipe's copy_trade_wallets list. Refreshed
// when strategies change (cheap: liveStrategies query is short).
let _copyTradeTargets = new Set();
let _copyTradeRefreshedAt = 0;
const COPY_TRADE_CACHE_MS = 60 * 1000;

function refreshCopyTradeTargets() {
  const out = new Set();
  const live = S().liveStrategies.all();
  for (const s of live) {
    try {
      const r = JSON.parse(s.recipe_json);
      const list = r?.entry?.copy_trade_wallets;
      if (Array.isArray(list)) for (const w of list) if (typeof w === 'string') out.add(w);
    } catch {}
  }
  _copyTradeTargets = out;
  _copyTradeRefreshedAt = Date.now();
}

export function isCopyTradeTarget(wallet) {
  if (!wallet) return false;
  if (Date.now() - _copyTradeRefreshedAt > COPY_TRADE_CACHE_MS) refreshCopyTradeTargets();
  return _copyTradeTargets.has(wallet);
}

function computeEntrySol(recipe, preds, mintAddress) {
  const sizing = recipe.sizing || {};
  let sol = sizing.sol || 0.13;
  // 2026-05-18: wallet_tier_scaled sizing. Lets a single strategy scale entry
  // size based on the quality of the wallet that triggered it — bigger size
  // when a mega_elite or ultra_elite wallet is in the trigger window, smaller
  // when only super_elite. Avoids needing 3 separate strategies (which would
  // triple-enter on ultra signals).
  //   sizing: {
  //     type: 'wallet_tier_scaled',
  //     sol: 0.18,           // base (super_elite alone)
  //     mega_mult: 1.3,      // if any mega_elite buyer in window
  //     ultra_mult: 1.7,     // if any ultra_elite buyer in window (takes precedence)
  //     window_sec: 60,
  //   }
  if (sizing.type === 'wallet_tier_scaled' && mintAddress) {
    const since = Date.now() - (sizing.window_sec || 60) * 1000;
    let mult = 1.0;
    try {
      const ultraN = db().prepare(`SELECT COUNT(DISTINCT t.wallet) AS n FROM trades t
        JOIN wallet_5x_score w ON w.address = t.wallet AND w.is_ultra_elite = 1
        WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp >= ?`).get(mintAddress, since)?.n || 0;
      if (ultraN > 0) {
        mult = sizing.ultra_mult || 1.7;
      } else {
        const megaN = db().prepare(`SELECT COUNT(DISTINCT t.wallet) AS n FROM trades t
          JOIN wallet_5x_score w ON w.address = t.wallet AND w.is_mega_elite = 1
          WHERE t.mint_address = ? AND t.is_buy = 1 AND t.timestamp >= ?`).get(mintAddress, since)?.n || 0;
        if (megaN > 0) mult = sizing.mega_mult || 1.3;
      }
    } catch { /* table missing or other error — fall through with 1.0 mult */ }
    sol = sol * mult;
    if (sizing.max_sol) sol = Math.min(sol, sizing.max_sol);
  }
  if (sizing.type === 'scaled_by_peak_pct' && preds.peak_pct_max != null) {
    // Legacy path — kept for backwards compat. peak_pct_max is a fraction
    // (1.0 = 100% peak); scale base SOL by (1 + pred), floor 0.5x.
    const mult = Math.max(0.5, 1 + preds.peak_pct_max);
    sol = sol * mult;
    if (sizing.max_sol) sol = Math.min(sol, sizing.max_sol);
  }
  // 2026-05-15 (PM-6): generic confidence-weighted sizing.
  //   sizing: {
  //     type: 'confidence_weighted',
  //     sol: 0.18,                        // base
  //     confidence_scale_by: 'hits_2x_within_1h',  // any ML target name
  //     scale_direction: 'positive' | 'inverse',   // default 'positive'
  //     min_mult: 0.5,
  //     max_mult: 2.0,
  //   }
  // 'positive': higher prediction → larger size (e.g. hits_2x: 0.5 prob → 1x, 1.0 → 1.5x)
  // 'inverse':  higher prediction → smaller size (e.g. rug_within_5min: 0 → 1.5x, 1 → 0.5x)
  if (sizing.type === 'confidence_weighted' && sizing.confidence_scale_by) {
    const predVal = preds[sizing.confidence_scale_by];
    if (typeof predVal === 'number') {
      const inverse = sizing.scale_direction === 'inverse';
      let mult = inverse ? (1.5 - predVal) : (0.5 + predVal);
      const minM = sizing.min_mult ?? 0.5;
      const maxM = sizing.max_mult ?? 2.0;
      mult = Math.max(minM, Math.min(maxM, mult));
      sol = sol * mult;
      if (sizing.max_sol) sol = Math.min(sol, sizing.max_sol);
    }
  }
  // Floor only. No ceiling beyond per-recipe max_sol — cash-availability
  // check downstream is the only real constraint.
  return Math.max(0.01, sol);
}

// Translate the recipe's exit block to a strategy_state row so the existing
// position monitor can apply familiar SL/TP/trailing logic.
//
// CRITICAL UNIT CONVENTION: the position monitor compares trigger/SL fields
// against `peakPctRaw` which is a FRACTION (0.30 = +30%). The agent's recipe
// uses PERCENTAGES (30 means +30%). We divide by 100 here so the monitor
// reads fractions like the rest of the code expects.
function syncStrategyStateRow(strategyId, recipe) {
  const exit = recipe.exit || {};
  const sizing = recipe.sizing || {};
  const tiers = (exit.take_profit_tiers || []).slice(0, 3);
  const t1 = tiers[0] || {};
  const t2 = tiers[1] || {};
  const t3 = tiers[2] || {};
  const trail = exit.trailing_stop || {};
  // sl_pct in the monitor is checked as `peakPctRaw <= strat.sl_pct`. Since
  // peakPctRaw is negative on losses, sl_pct must be NEGATIVE fraction.
  // Recipe says `stop_loss_pct: 25` meaning -25% loss → store as -0.25.
  const slFraction = -Math.abs(exit.stop_loss_pct || 25) / 100;
  // tier_trigger_pct: positive fraction (recipe 30 → 0.30)
  const t1Trig = (t1.trigger_pct ?? 30) / 100;
  const t1Sell = (t1.sell_pct ?? 30) / 100;
  const t2Trig = (t2.trigger_pct ?? 100) / 100;
  const t2Sell = (t2.sell_pct ?? 50) / 100;
  const t3Trig = (t3.trigger_pct ?? (trail.arm_pct ?? 200)) / 100;
  const t3Sell = (t3.sell_pct ?? 100) / 100;
  const tier3Trail = (trail.trail_pct || 0) / 100;
  // 2026-05-15: peak-floor cascade. Each tier is { arm_pct, exit_pct } —
  // when peak ever reaches arm%, exit the remaining bag if current drops
  // below exit%. Complements the tier sells (which scale out at fixed
  // thresholds) by guarding the residual bag against post-peak retracement.
  // INVARIANT: exit_pct MUST be < arm_pct (recipe convention, not enforced
  // in DB) — otherwise the cascade fires immediately when armed. Recipe
  // values are percentages (30 = +30%); we divide by 100 for the DB fraction.
  const pf = (exit.peak_floor_tiers || []).slice(0, 3);
  const pf1 = pf[0] || {}; const pf2 = pf[1] || {}; const pf3 = pf[2] || {};
  const pf1Arm = (pf1.arm_pct || 0) / 100;
  const pf1Exit = (pf1.exit_pct || 0) / 100;
  const pf2Arm = (pf2.arm_pct || 0) / 100;
  const pf2Exit = (pf2.exit_pct || 0) / 100;
  const pf3Arm = (pf3.arm_pct || 0) / 100;
  const pf3Exit = (pf3.exit_pct || 0) / 100;
  // 2026-05-15: ML-prediction-driven exit. When the model's latest prob
  // satisfies the operator, exit immediately (handled in paper.js).
  // Recipe shape: { target: 'local_top_60s', op: '>', value: 0.5 }.
  const predExit = exit.prediction_exit || {};
  const predExitTarget = predExit.target || null;
  const predExitOp = (predExit.op === '<' || predExit.op === '<=' || predExit.op === '>=' || predExit.op === '==') ? predExit.op : '>';
  const predExitValue = (predExit.target && predExit.value != null) ? predExit.value : null;
  // DCA section. Default disabled — agent must opt in explicitly. Recipe
  // values use the same percent-not-fraction convention as exit.stop_loss_pct.
  const dca = recipe.dca || {};
  const dcaEnabled = dca.enabled ? 1 : 0;
  // dca_trigger_pct in DB is a NEGATIVE fraction (e.g., -0.25 = -25% drawdown).
  // Recipe convention: trigger_pct: -25 (negative percentage). Normalize.
  const dcaTriggerFraction = dca.trigger_pct != null
    ? -Math.abs(dca.trigger_pct) / 100
    : -0.25;
  const dcaSizeFraction = dca.size_pct != null
    ? Math.max(0, Math.min(2.0, dca.size_pct))  // already a fraction in recipe (0.5 = 50%)
    : 0.5;

  S().upsertStrategyState.run(
    strategyId,
    `🤖 ${recipe.name || strategyId}`,
    (recipe.rationale || '').slice(0, 240),
    1,                                 // enabled — lives in strategy_state but we evaluate entries ourselves
    sizing.sol || 0.13,
    slFraction,
    exit.max_hold_min || 60,
    t1Trig, t1Sell,
    t2Trig, t2Sell,
    t3Trig, t3Sell,
    tier3Trail,
    exit.breakeven_after_tier1 ? 1 : 0,
    pf1Arm, pf1Exit, pf2Arm, pf2Exit, pf3Arm, pf3Exit,
    predExitTarget, predExitOp, predExitValue,
    dcaEnabled, dcaTriggerFraction, dcaSizeFraction,
    dca.min_age_sec || 60,
    dca.max_age_min || 30,
    dca.max_dca || 1,
    // 2026-05-17: explicit zeros for legacy auto-exit modes (fast_fail / fakepump
    // / stagnant). Schema column defaults are non-zero (60s / 120s / 3min) and
    // were silently riding along on V2 recipes that don't specify them. Recipe
    // is the sole source of truth for exit logic — recipe's stop_loss_pct,
    // tiers, trailing_stop, and max_hold_min own the position.
    0, 0, 0,    // fast_fail_sec, fast_fail_min_peak_pct, fast_fail_sl_pct
    0, 0, 0,    // fakepump_sec, fakepump_min_peak_pct, fakepump_sl_pct
    0, 0,       // stagnant_exit_min, stagnant_loss_pct
    // 2026-05-17: per-strategy moonbag reserve (0..1 fraction of original bag
    // that the bot stops touching once remaining hits this floor).
    Math.max(0, Math.min(0.5, exit.moonbag_pct_reserve || 0)),
    Date.now(),
  );
}

// Score a single mint against a strategy. If conditions match AND we haven't
// already entered this mint on this strategy recently, fire a paper trade.
async function evaluateOneMint(strategy, mintAddress) {
  const recipe = strategy.recipe;
  const features = collectFeatures(mintAddress);
  if (!features) return false;
  // Pull all ML predictions in one round-trip
  const preds = await getAllPredictions(mintAddress, `agent_eval:${strategy.id}`);
  if (!preds) return false;
  if (!evalEntry(recipe, mintAddress, features, preds)) return false;
  // D3 smell test (2026-05-13): after the strategy's own gates pass, apply
  // a universal counter-evidence veto. Catches adverse signals (shill, bundle,
  // whale capture, dev dumping) that strategies might miss because they don't
  // explicitly gate on them.
  // 2026-05-15 (PM-5): recipes can opt out via `skip_smell_test: true` — e.g.
  // a momentum strategy that explicitly accepts higher whale concentration
  // because the agent has learned that's not predictive in its regime.
  if (!recipe.skip_smell_test) {
    const sentForVeto = fetchSentimentCtx(mintAddress);
    const vetoReason = smellTestVeto(features, sentForVeto);
    if (vetoReason) {
      db().prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
         VALUES (?, 'thought', 'execute', ?, ?, ?)`).run(
        Date.now(), strategy.id,
        `smell-test veto · ${vetoReason}`,
        JSON.stringify({ mint: mintAddress, veto: vetoReason }));
      return false;
    }
  }
  // Hard dedup: never double up on a mint we already hold on this strategy.
  const alreadyHeld = S().openOnMint.get(strategy.id, mintAddress);
  if (alreadyHeld) return false;
  // 2026-05-15 (PM-5): cooldowns now per-recipe. recipe.cooldowns.after_exit_ms
  // and after_fast_fail_ms override the defaults. Set to 0 to disable.
  const cd = recipe.cooldowns || {};
  const entryCooldownMs = cd.after_exit_ms != null ? cd.after_exit_ms : DEFAULT_ENTRY_COOLDOWN_MS;
  const failedCooldownMs = cd.after_fast_fail_ms != null ? cd.after_fast_fail_ms : DEFAULT_FAILED_COOLDOWN_MS;
  // Post-exit cooldown — don't re-enter immediately after we just closed it.
  if (entryCooldownMs > 0) {
    const cutoff = Date.now() - entryCooldownMs;
    const recent = S().recentEntry.get(strategy.id, mintAddress, cutoff);
    if (recent) return false;
  }
  // Extended-cooldown for already-failed coins (FAST_FAIL/FAKE_PUMP/SL_HIT).
  // These exit reasons indicate the entry premise failed; re-entering soon
  // after typically just doubles the loss.
  const failedCutoff = Date.now() - failedCooldownMs;
  const recentFail = failedCooldownMs > 0
    ? S().recentFailedExit.get(strategy.id, mintAddress, failedCutoff)
    : null;
  if (recentFail) return false;
  const sol = computeEntrySol(recipe, preds, mintAddress);
  // Use last_price_sol from features as entry price
  const entryPrice = features.last_price_sol;
  if (!entryPrice || entryPrice <= 0) return false;
  // Paper wallet exhaustion check — don't oversubscribe the simulated 1-SOL
  // pool. If we don't have cash for this trade (with reserve), skip and let
  // open positions resolve before firing more.
  const cash = getAvailableCash();
  if (cash < sol + MIN_RESERVE_SOL) {
    db().prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
       VALUES (?, 'thought', 'execute', ?, ?, ?)`).run(
      Date.now(), strategy.id,
      `skipped entry · insufficient paper cash (${cash.toFixed(3)} SOL free, needed ${sol.toFixed(3)})`,
      JSON.stringify({ cash, needed: sol, mint: mintAddress }));
    return false;
  }
  const positionId = openPaperPosition({
    strategy: strategy.id,
    mintAddress,
    entryPrice,
    entrySol: sol,
    entryMcap: features.last_mcap_sol || 0,
    // 2026-05-15 (PM-8): max_entry_slippage_pct per-recipe — paper.js reads
    // this to override config.safety.maxEntrySlippagePct (default 0.17 = 17%).
    // Recipe declares e.g. `entry.max_entry_slippage_pct: 0.35` to accept
    // larger drift between trigger and fill (fast-moving pump.fun coins).
    maxEntrySlippagePct: recipe.entry?.max_entry_slippage_pct,
    signalDetails: { agent_strategy: strategy.id, agent_recipe_name: recipe.name, predictions: preds },
  });
  if (positionId) {
    S().bumpTrade.run(strategy.id);
    // D1 attribution (2026-05-13): write which tracker wallets were active in
    // the 60s window before this entry. tracker-concentration uses this to
    // compute rolling per-wallet contribution and mute over-represented ones.
    try {
      const trackerWallets = attributeTrackers(mintAddress);
      if (trackerWallets.length > 0) {
        db().prepare('UPDATE paper_positions SET tracker_wallets_json = ? WHERE id = ?')
          .run(JSON.stringify(trackerWallets), positionId);
      }
    } catch (err) { /* swallow — attribution is nice-to-have */ }
    logTrade(strategy.id, mintAddress, sol, preds);
    return true;
  }
  return false;
}

function logTrade(strategyId, mintAddress, sol, preds) {
  try {
    db().prepare(`INSERT INTO ml_agent_log (timestamp, level, category, strategy_id, message, data_json)
       VALUES (?, 'trade', 'execute', ?, ?, ?)`).run(
      Date.now(), strategyId,
      `entered ${mintAddress.slice(0, 8)}… for ${sol.toFixed(3)} SOL`,
      JSON.stringify({ mint: mintAddress, sol, predictions: preds }),
    );
  } catch (err) { console.error('[agent-exec] log trade failed:', err.message); }
}

let _running = false;
async function tick() {
  if (_running) return;
  if (!isHealthy()) return;
  _running = true;
  try {
    const strategies = S().liveStrategies.all().map(r => ({
      ...r,
      recipe: (() => { try { return JSON.parse(r.recipe_json); } catch { return null; } })(),
    })).filter(s => s.recipe);
    if (strategies.length === 0) return;
    const recentTradeCutoff = Date.now() - 10 * 60 * 1000;
    const preMigCands = S().candidates.all(recentTradeCutoff, MAX_CANDIDATES);
    let entered = 0;
    for (const strat of strategies) {
      // Choose candidate pool based on the recipe's targets_migrated flag.
      // Default = pre-migration only (existing behavior). Set true to target
      // migrated mints in their 72h post-migration window.
      const targetsMig = strat.recipe?.targets_migrated === true;
      const cands = targetsMig
        ? S().migratedCandidates.all(MAX_CANDIDATES).map(c => ({ mint_address: c.mint_address }))
        : preMigCands;
      for (const m of cands) {
        try {
          const fired = await evaluateOneMint(strat, m.mint_address);
          if (fired) entered++;
        } catch (err) { console.error('[agent-exec] eval err:', err.message); }
      }
      S().bumpEvaluated.run(Date.now(), strat.id);
    }
    if (entered > 0) console.log(`[agent-exec] tick · entered ${entered} positions across ${strategies.length} strategies`);
  } finally { _running = false; }
}

// Per-mint debounce — don't re-evaluate the same mint more than once per N seconds
// from event triggers. Prevents fanning out across 50 trade events on a hot mint.
const _evalDebounce = new Map();
const EVAL_DEBOUNCE_MS = 8 * 1000;

// Public: event-driven evaluator. Runs all live strategies against a mint
// IMMEDIATELY when an interesting event happens (tracked buy, whale buy,
// migration-eligible threshold, etc.). Bypasses the 60s polling sweep.
//
// Returns a promise but caller can fire-and-forget. Internally throttled
// per-mint so a flood of trade events doesn't trigger 50 evals.
export async function evaluateMintNow(mintAddress, reason) {
  if (!mintAddress) return;
  if (_running) return;  // skip if main sweep is in flight
  if (!isHealthy()) return;
  const last = _evalDebounce.get(mintAddress) || 0;
  const now = Date.now();
  if (now - last < EVAL_DEBOUNCE_MS) return;
  _evalDebounce.set(mintAddress, now);
  // Periodic GC
  if (_evalDebounce.size > 1000) {
    for (const [k, v] of _evalDebounce) if (now - v > 10 * 60 * 1000) _evalDebounce.delete(k);
  }
  try {
    const strategies = S().liveStrategies.all().map(r => ({
      ...r,
      recipe: (() => { try { return JSON.parse(r.recipe_json); } catch { return null; } })(),
    })).filter(x => x.recipe);
    if (strategies.length === 0) return;
    for (const strat of strategies) {
      try {
        const fired = await evaluateOneMint(strat, mintAddress);
        if (fired) {
          console.log(`[agent-exec] event-driven entry · ${reason} · ${mintAddress.slice(0, 8)}… · ${strat.id.slice(0, 60)}`);
        }
      } catch (err) { /* swallow per-strategy errors */ }
    }
  } catch (err) { console.error('[agent-exec] eval-now err:', err.message); }
}

// Public: install/refresh the strategy_state row when a new strategy is born
// or a recipe is updated. Called by agent.js after proposing.
export function deployStrategy(strategyId, recipe) {
  syncStrategyStateRow(strategyId, recipe);
}

// Public: when retiring, set strategy_state row's enabled=0 so the monitor
// doesn't treat it as a candidate, and update agent strategies table.
export function retireStrategy(strategyId, reason) {
  const d = db();
  d.prepare(`UPDATE strategy_state SET enabled = 0, updated_at = ? WHERE name = ?`).run(Date.now(), strategyId);
  d.prepare(`UPDATE ml_agent_strategies SET status = 'retired', retired_at = ?, retired_reason = ? WHERE id = ?`)
    .run(Date.now(), reason || '', strategyId);
}

export function startAgentExecutor() {
  setTimeout(tick, 30 * 1000);  // first run after 30s warmup
  setInterval(tick, TICK_INTERVAL_MS);
  console.log(`[agent-exec] executor started · interval=60s · max_candidates=${MAX_CANDIDATES}`);
}
