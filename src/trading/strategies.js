import { db } from '../db/index.js';
import { config } from '../config.js';
import { openPaperPosition } from './paper.js';
import { isLiveMode } from './wallet.js';
import { passesHolderDiversity } from '../scoring/holders.js';
import { applyDynamicSizing } from './sizing.js';
import { strategyNames } from '../strategies/index.js';

const KEYS = strategyNames;
const SETTABLE = [
  'entry_sol', 'sl_pct', 'max_hold_min',
  'tier1_trigger_pct', 'tier1_sell_pct',
  'tier2_trigger_pct', 'tier2_sell_pct',
  'tier3_trigger_pct', 'tier3_sell_pct', 'tier3_trail_pct',
  'breakeven_after_tier1', 'breakeven_arm_pct', 'breakeven_floor_pct',
  'tp_trail_pct', 'tp_trail_arm_pct',
  'fast_fail_sec', 'fast_fail_min_peak_pct', 'fast_fail_sl_pct',
  'fakepump_sec', 'fakepump_min_peak_pct', 'fakepump_sl_pct',
  'flat_exit_min', 'flat_exit_max_peak_pct', 'flat_exit_band_pct',
  'cashback_trigger_boost',
  'stagnant_exit_min', 'stagnant_loss_pct',
  'peak_floor_arm_pct', 'peak_floor_exit_pct',
  'peak_floor_arm2_pct', 'peak_floor_exit2_pct',
  'peak_floor_arm3_pct', 'peak_floor_exit3_pct',
  'dead_bag_age_min', 'dead_bag_max_peak_pct', 'dead_bag_loss_pct',
  'fade_exit_peak_min', 'fade_exit_peak_max', 'fade_exit_loss_pct',
  'mid_fade_peak_min', 'mid_fade_peak_max', 'mid_fade_loss_pct',
  'lazy_exit_age_min', 'lazy_exit_max_peak_pct', 'lazy_exit_band_pct',
];

export function initStrategies() {
  const d = db();
  const upsert = d.prepare(`INSERT OR IGNORE INTO strategy_state
    (name, label, description, enabled, entry_sol, sl_pct, max_hold_min,
     tier1_trigger_pct, tier1_sell_pct, tier2_trigger_pct, tier2_sell_pct,
     tier3_trigger_pct, tier3_sell_pct, tier3_trail_pct, breakeven_after_tier1,
     stagnant_exit_min, stagnant_loss_pct, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateLabel = d.prepare(`UPDATE strategy_state SET label = ?, description = ? WHERE name = ?`);
  const backfill = d.prepare(`UPDATE strategy_state SET
    tier1_trigger_pct = COALESCE(tier1_trigger_pct, ?),
    tier1_sell_pct = COALESCE(tier1_sell_pct, ?),
    tier2_trigger_pct = COALESCE(tier2_trigger_pct, ?),
    tier2_sell_pct = COALESCE(tier2_sell_pct, ?),
    tier3_trigger_pct = COALESCE(tier3_trigger_pct, ?),
    tier3_sell_pct = COALESCE(tier3_sell_pct, ?),
    tier3_trail_pct = COALESCE(tier3_trail_pct, ?),
    breakeven_after_tier1 = COALESCE(breakeven_after_tier1, ?)
    WHERE name = ?`);
  const now = Date.now();
  for (const key of KEYS) {
    const cfg = config.strategies[key];
    if (!cfg) continue;
    const d_ = cfg.defaults;
    upsert.run(
      key, cfg.label, cfg.description, d_.enabled,
      d_.entry_sol, d_.sl_pct, d_.max_hold_min,
      d_.tier1_trigger_pct, d_.tier1_sell_pct,
      d_.tier2_trigger_pct, d_.tier2_sell_pct,
      d_.tier3_trigger_pct, d_.tier3_sell_pct, d_.tier3_trail_pct,
      d_.breakeven_after_tier1,
      d_.stagnant_exit_min, d_.stagnant_loss_pct, now
    );
    updateLabel.run(cfg.label, cfg.description, key);
    backfill.run(
      d_.tier1_trigger_pct, d_.tier1_sell_pct,
      d_.tier2_trigger_pct, d_.tier2_sell_pct,
      d_.tier3_trigger_pct, d_.tier3_sell_pct, d_.tier3_trail_pct,
      d_.breakeven_after_tier1, key
    );
    const cur = d.prepare('SELECT peak_floor_arm_pct, peak_floor_arm2_pct, peak_floor_arm3_pct FROM strategy_state WHERE name = ?').get(key);
    if (cur && cur.peak_floor_arm_pct === 0 && cur.peak_floor_arm2_pct === 0 && cur.peak_floor_arm3_pct === 0) {
      d.prepare(`UPDATE strategy_state SET
        peak_floor_arm_pct = ?, peak_floor_exit_pct = ?,
        peak_floor_arm2_pct = ?, peak_floor_exit2_pct = ?,
        peak_floor_arm3_pct = ?, peak_floor_exit3_pct = ?
        WHERE name = ?`).run(
          d_.peak_floor_arm_pct || 0, d_.peak_floor_exit_pct || 0,
          d_.peak_floor_arm2_pct || 0, d_.peak_floor_exit2_pct || 0,
          d_.peak_floor_arm3_pct || 0, d_.peak_floor_exit3_pct || 0,
          key);
    }
    const dbg = d.prepare('SELECT dead_bag_age_min, dead_bag_max_peak_pct, dead_bag_loss_pct FROM strategy_state WHERE name = ?').get(key);
    if (dbg && dbg.dead_bag_age_min === 0 && dbg.dead_bag_max_peak_pct === 0 && dbg.dead_bag_loss_pct === 0) {
      d.prepare(`UPDATE strategy_state SET
        dead_bag_age_min = ?, dead_bag_max_peak_pct = ?, dead_bag_loss_pct = ?
        WHERE name = ?`).run(
          d_.dead_bag_age_min || 0,
          d_.dead_bag_max_peak_pct || 0,
          d_.dead_bag_loss_pct || 0,
          key);
    }
    const fade = d.prepare('SELECT fade_exit_peak_min, mid_fade_peak_min FROM strategy_state WHERE name = ?').get(key);
    if (fade && fade.fade_exit_peak_min === 0 && fade.mid_fade_peak_min === 0) {
      d.prepare(`UPDATE strategy_state SET
        fade_exit_peak_min = ?, fade_exit_peak_max = ?, fade_exit_loss_pct = ?,
        mid_fade_peak_min = ?, mid_fade_peak_max = ?, mid_fade_loss_pct = ?
        WHERE name = ?`).run(
          d_.fade_exit_peak_min || 0, d_.fade_exit_peak_max || 0, d_.fade_exit_loss_pct || 0,
          d_.mid_fade_peak_min || 0, d_.mid_fade_peak_max || 0, d_.mid_fade_loss_pct || 0,
          key);
    }
    const lazy = d.prepare('SELECT lazy_exit_age_min FROM strategy_state WHERE name = ?').get(key);
    if (lazy && lazy.lazy_exit_age_min === 0) {
      d.prepare(`UPDATE strategy_state SET
        lazy_exit_age_min = ?, lazy_exit_max_peak_pct = ?, lazy_exit_band_pct = ?
        WHERE name = ?`).run(
          d_.lazy_exit_age_min || 0,
          d_.lazy_exit_max_peak_pct || 0,
          d_.lazy_exit_band_pct || 0,
          key);
    }
  }
}

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    getStrategy: d.prepare('SELECT * FROM strategy_state WHERE name = ?'),
    // Hide retired agent strategies from the main dashboard (data preserved in
     // ml_agent_strategies for future training and post-mortem context).
     // Non-agent rows are unaffected.
    listStrategies: d.prepare(`
      SELECT s.* FROM strategy_state s
      LEFT JOIN ml_agent_strategies a ON a.id = s.name
      WHERE s.name NOT LIKE 'agent_%' OR a.status IS NULL OR a.status != 'retired'
      ORDER BY s.name
    `),
    toggleStrategy: d.prepare('UPDATE strategy_state SET enabled = 1 - enabled, updated_at = ? WHERE name = ?'),
    countOpen: d.prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE status = 'open'"),
    // Anti-snipe gate: distinct buyers + distinct sniper-tagged buyers for a
    // mint. Uses idx_trades_sniper for an efficient scan.
    sniperRatio: d.prepare(`SELECT
        COUNT(DISTINCT wallet) AS unique_buyers,
        COUNT(DISTINCT CASE WHEN is_sniper = 1 THEN wallet END) AS sniper_buyers
      FROM trades WHERE mint_address = ? AND is_buy = 1`),
    // Exposure = at-risk capital only. Once a position has realized enough
    // through tier sells to cover its cost basis, it's house money and no
    // longer counts toward maxSolExposure — the remaining bag is pure
    // upside, no downside risk to original capital.
    sumOpenSol: d.prepare(`SELECT COALESCE(SUM(MAX(0, entry_sol - COALESCE(sol_realized_so_far, 0))), 0) AS s
                           FROM paper_positions WHERE status = 'open'`),
    holdingMint: d.prepare("SELECT strategy FROM paper_positions WHERE mint_address = ? AND strategy = ? AND status = 'open' AND COALESCE(position_mode,'paper') = ? LIMIT 1"),
    recentClose: d.prepare(`SELECT strategy, exited_at, realized_pnl_sol FROM paper_positions
      WHERE mint_address = ? AND status = 'closed' AND exited_at > ?
      ORDER BY exited_at DESC LIMIT 1`),
    walletInfo: d.prepare('SELECT address, category, copy_friendly, tracked, is_kol, bundle_cluster_id, realized_pnl_30d, win_rate_30d, closed_30d, auto_blocked, auto_boost_mult FROM wallets WHERE address = ?'),
    getMint: d.prepare('SELECT * FROM mints WHERE mint_address = ?'),
    otherTrackedBuyers: d.prepare(`SELECT COUNT(DISTINCT t.wallet) AS n
      FROM trades t JOIN wallets w ON w.address = t.wallet
      WHERE t.mint_address = ? AND t.is_buy = 1 AND w.tracked = 1
        AND t.timestamp >= ? AND t.wallet != ?`),
  };
  return stmts;
}

function applySourceGate(name, w, trade, mint) {
  const sCfg = config.strategies[name] || {};
  const mc = mint.current_market_cap_sol || 0;
  const short = mint.mint_address.slice(0, 8);
  if (typeof sCfg.mcCeiling === 'number' && mc >= sCfg.mcCeiling) {
    return { pass: false, log: `[gate] ${name} ceiling ${short}… mc ${mc.toFixed(1)} ≥ ${sCfg.mcCeiling}` };
  }
  if (typeof sCfg.mcFloor === 'number' && mc < sCfg.mcFloor) {
    return { pass: false, log: `[gate] ${name} floor ${short}… mc ${mc.toFixed(1)} < ${sCfg.mcFloor}` };
  }
  const sf = sCfg.sourceFilter;
  if (sf) {
    const whitelist = sf.walletWhitelist || [];
    if (whitelist.length > 0) {
      if (!whitelist.includes(trade.wallet)) return { pass: false };
      const fixedDetails = { type: 'WHITELIST', wallet: trade.wallet };
      console.log(`[${name}] 👑 ${trade.wallet.slice(0,6)}… buying ${short}… mc ${mc.toFixed(1)} — firing`);
      return { pass: true, fixedDetails, sizeOverride: sCfg.defaults?.entry_sol };
    }
    const isKol = !!w.is_kol;
    const cats = (sf.walletCategories || []).map(c => c.toUpperCase());
    if (sf.requireKol && !isKol) {
      return { pass: false, log: `[gate] ${name}-source ${short}… ${trade.wallet.slice(0,6)}… not KOL` };
    }
    if (cats.length > 0) {
      const wcat = (w.category || '').toUpperCase();
      const matchesCat = cats.includes(wcat) || (cats.includes('KOL') && isKol);
      let matchesUnderMc = false;
      if (sf.categoriesUnderMc) {
        for (const [cat, mcMax] of Object.entries(sf.categoriesUnderMc)) {
          if (wcat === cat.toUpperCase() && mc < mcMax) { matchesUnderMc = true; break; }
        }
      }
      if (!matchesCat && !matchesUnderMc) {
        return { pass: false, log: `[gate] ${name}-source ${short}… ${trade.wallet.slice(0,6)}… cat=${wcat||'?'} kol=${isKol?1:0} mc=${mc.toFixed(1)} — needs ${cats.join('|')}` };
      }
    }
  }
  return { pass: true };
}

function strategiesForTrigger(trigger) {
  return KEYS.filter(k => config.strategies[k]?.trigger === trigger);
}

// Plain-English labels for the technical entry-condition fields. The dashboard
// shows these so a human can read what a strategy looks for without parsing
// the agent's raw rationale. Only used for agent_* strategies; built-in ones
// keep their hand-written descriptions.
const COND_LABELS = {
  migrated: 'ML thinks it\'ll graduate',
  migrates_within_15min: 'ML thinks it\'ll graduate in <15min',
  will_die_fast: 'ML thinks it WON\'T die fast',
  rug_within_5min: 'ML thinks low rug risk',
  peaked_30: 'ML thinks ≥30% peak coming',
  peaked_100: 'ML thinks ≥100% peak coming',
  peaked_300: 'ML thinks ≥300% peak coming',
  hits_2x_within_1h: 'ML thinks 2x within 1hr',
  peak_pct_max: 'ML predicts peak gain',
  drawdown_from_peak_pct: 'Not already past peak',
  time_to_peak_sec: 'ML predicts time-to-peak',
  post_mig_hits_2x: 'ML thinks 2x post-mig',
  post_mig_peak_pct: 'ML predicts post-mig peak',
  post_mig_rugs_1h: 'ML thinks low post-mig rug risk',
  tracked_buyers: 'tracked wallets in',
  kol_buyers: 'KOL wallets in',
  top50_buyers: 'top-50 wallets in',
  creator_sells_post_launch: 'creator hasn\'t dumped',
  last_mcap_sol: 'mcap',
  buy_count: 'buys',
};
function fmtThreshold(name, op, value) {
  const isPct = op === '<' || op === '<=' || op === '>' || op === '>=' ;
  if (name === 'migrated' || name === 'will_die_fast' || name === 'rug_within_5min' ||
      name === 'peaked_30' || name === 'peaked_100' || name === 'peaked_300' ||
      name === 'hits_2x_within_1h' || name === 'migrates_within_15min' ||
      name === 'post_mig_hits_2x' || name === 'post_mig_rugs_1h' || name === 'drawdown_from_peak_pct') {
    return `${(value * 100).toFixed(0)}%`;
  }
  return String(value);
}
function humanizeRecipe(recipe) {
  const conds = recipe?.entry?.conditions || [];
  const lines = [];
  for (const c of conds) {
    const lbl = COND_LABELS[c.name] || c.name;
    const dir = (c.op === '<' || c.op === '<=') ? 'below' : (c.op === '>' || c.op === '>=' ? 'above' : 'at');
    const val = fmtThreshold(c.name, c.op, c.value);
    // Pretty form: "ML thinks it'll graduate (≥30%)", "creator hasn't dumped (=0)"
    const opSym = c.op;
    lines.push(`• ${lbl} (${opSym}${val})`);
  }
  const minAge = recipe?.entry?.min_mint_age_sec || 0;
  const maxAge = recipe?.entry?.max_mint_age_sec;
  if (maxAge) {
    const minLbl = minAge < 60 ? `${minAge}s` : `${Math.round(minAge / 60)}m`;
    const maxLbl = maxAge < 60 ? `${maxAge}s` : `${Math.round(maxAge / 60)}m`;
    lines.push(`• Mint age: ${minLbl} – ${maxLbl}`);
  }
  return lines.join('\n');
}

export function listStrategies() {
  const rows = S().listStrategies.all();
  // Enrich agent_* strategies with a human-readable entry summary parsed from
  // their recipe JSON. Built-in strategies keep their existing description.
  for (const r of rows) {
    if (typeof r.name === 'string' && r.name.startsWith('agent_')) {
      try {
        const ag = db().prepare('SELECT recipe_json FROM ml_agent_strategies WHERE id = ?').get(r.name);
        if (ag?.recipe_json) {
          const recipe = JSON.parse(ag.recipe_json);
          r.entry_summary = humanizeRecipe(recipe);
        }
      } catch { /* ignore */ }
    }
  }
  return rows;
}
export function getStrategy(name) { return S().getStrategy.get(name); }

export function toggleStrategy(name) {
  S().toggleStrategy.run(Date.now(), name);
  // Agent-created strategies have a parallel state machine in ml_agent_strategies
  // — keep them in sync so the executor sees status='live' when user re-enables.
  if (typeof name === 'string' && name.startsWith('agent_')) {
    const cur = db().prepare('SELECT enabled FROM strategy_state WHERE name = ?').get(name);
    const targetStatus = cur?.enabled ? 'live' : 'paused';
    db().prepare(`UPDATE ml_agent_strategies SET status = ?,
       retired_at = CASE WHEN ? = 'live' THEN NULL ELSE retired_at END,
       retired_reason = CASE WHEN ? = 'live' THEN NULL ELSE retired_reason END
       WHERE id = ?`).run(targetStatus, targetStatus, targetStatus, name);
  }
  return getStrategy(name);
}

export function updateStrategySettings(name, fields) {
  const updates = [];
  const values = [];
  for (const k of SETTABLE) {
    if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '') {
      updates.push(`${k} = ?`);
      values.push(Number(fields[k]));
    }
  }
  if (!updates.length) return getStrategy(name);
  updates.push('updated_at = ?');
  values.push(Date.now());
  values.push(name);
  db().prepare(`UPDATE strategy_state SET ${updates.join(', ')} WHERE name = ?`).run(...values);
  return getStrategy(name);
}

// Sniper-dominance threshold for the anti-snipe gate. If 60%+ of distinct
// buyers were tagged is_sniper, the cohort is dominated by sniper bots that
// historically dump on retail entry. Tunable — start strict, relax if we see
// the gate rejecting too many real opportunities.
const ANTI_SNIPE_RATIO = 0.6;
// Don't apply the anti-snipe gate until at least N distinct buyers exist —
// before that the ratio is noisy (1/1 = 100% sniper triggers on a single buy).
const ANTI_SNIPE_MIN_BUYERS = 5;

function evaluateGuards(mint, opts = {}) {
  const g = config.strategies.global;
  const ageSec = (Date.now() - mint.created_at) / 1000;
  if (ageSec < g.minMintAgeSec) return { pass: false, reason: 'TOO_FRESH', detail: `${ageSec.toFixed(0)}s<${g.minMintAgeSec}s` };
  if (ageSec > g.maxMintAgeMinutes * 60) return { pass: false, reason: 'TOO_OLD', detail: `${(ageSec/60).toFixed(1)}m>${g.maxMintAgeMinutes}m` };
  if (mint.migrated) return { pass: false, reason: 'MIGRATED' };
  if (mint.rugged) return { pass: false, reason: 'RUGGED' };
  let flags = [];
  try { flags = JSON.parse(mint.flags || '[]'); } catch {}
  for (const skip of g.skipFlags) if (flags.includes(skip)) return { pass: false, reason: `FLAG_${skip}` };
  if (S().countOpen.get().n >= g.maxOpenPositions) return { pass: false, reason: 'MAX_POSITIONS', detail: `${g.maxOpenPositions}` };
  if (S().sumOpenSol.get().s >= g.maxSolExposure) return { pass: false, reason: 'MAX_EXPOSURE', detail: `${g.maxSolExposure}` };
  if (!opts.skipHolderGate) {
    const holder = passesHolderDiversity(mint.mint_address, opts);
    if (!holder.pass) return { pass: false, reason: 'HOLDER_GATE', detail: holder.reason };
  }
  // Anti-snipe filter: reject if sniper-tagged wallets dominate the buyer
  // cohort. Per-entry query (cheap, entries are <10/min vs position
  // monitor's 800/sec ticks). Skip if cohort is too small to be meaningful.
  if (!opts.skipAntiSnipe) {
    const row = S().sniperRatio.get(mint.mint_address);
    const uniq = row?.unique_buyers || 0;
    const snipers = row?.sniper_buyers || 0;
    if (uniq >= ANTI_SNIPE_MIN_BUYERS) {
      const ratio = snipers / uniq;
      if (ratio >= ANTI_SNIPE_RATIO) {
        return { pass: false, reason: 'ANTI_SNIPE', detail: `${snipers}/${uniq}=${(ratio*100).toFixed(0)}%` };
      }
    }
  }
  return { pass: true };
}

let rejectionStmts = null;
function RS() {
  if (rejectionStmts) return rejectionStmts;
  const d = db();
  rejectionStmts = {
    upsert: d.prepare(`INSERT INTO gate_rejections
      (mint_address, first_rejected_at, last_rejected_at, reject_count, reason, reason_detail, signal_type, mcap_at_reject, price_at_reject)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(mint_address) DO UPDATE SET
        last_rejected_at = excluded.last_rejected_at,
        reject_count = reject_count + 1`),
  };
  return rejectionStmts;
}

function passesGlobalGuards(mint, signalType, opts = {}) {
  const r = evaluateGuards(mint, opts);
  if (!r.pass) {
    const short = mint.mint_address.slice(0, 8);
    const detail = r.detail ? `(${r.detail})` : '';
    console.log(`[gate] ${short}… rejected: ${r.reason}${detail}`);
    try {
      const now = Date.now();
      RS().upsert.run(
        mint.mint_address, now, now,
        r.reason, r.detail || null, signalType || 'unknown',
        mint.current_market_cap_sol || 0,
        mint.last_price_sol || 0
      );
    } catch (err) { console.error('[rejection-log]', err.message); }
    return false;
  }
  return true;
}

function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }

function scoreTrackedSignal(walletInfo, mint) {
  const pnl30 = walletInfo.realized_pnl_30d || 0;
  const wr30 = walletInfo.win_rate_30d || 0;
  const closed30 = walletInfo.closed_30d || 1;
  const pnlComp = clamp(pnl30 / 30, 0, 1);
  const wrComp = clamp(wr30, 0, 1);
  const expComp = clamp(Math.log10(closed30 + 1) / 2, 0, 1);
  const walletScore = pnlComp * 0.4 + wrComp * 0.3 + expComp * 0.3;

  const lookbackMs = 60 * 1000;
  const others = S().otherTrackedBuyers.get(mint.mint_address, Date.now() - lookbackMs, walletInfo._wallet_addr || '').n;
  const confluenceBoost = Math.min(0.5, others * 0.2);

  const ageMin = (Date.now() - mint.created_at) / 60000;
  const freshness = ageMin < 5 ? 1.0 : ageMin < 30 ? 0.9 : ageMin < 120 ? 0.75 : 0.6;

  const curveProgress = (mint.v_sol_in_curve || 0) / 85;
  const curveFactor = curveProgress < 0.3 ? 1.0 : curveProgress < 0.6 ? 0.9 : curveProgress < 0.85 ? 0.75 : 0.6;

  const kolBoost = walletInfo.is_kol ? config.traders.kol.sizingBoost : 1.0;
  const autoBoost = walletInfo.auto_boost_mult || 1.0;

  const raw = (walletScore + confluenceBoost) * freshness * curveFactor * kolBoost * autoBoost;
  const multiplier = clamp(raw * 2, 0.5, 5.0);
  return { multiplier, walletScore: +walletScore.toFixed(2), others, freshness, curveFactor, isKol: !!walletInfo.is_kol, autoBoost };
}

function inCooldown(mintAddress) {
  const lossMin = config.strategies.global.lossCooldownMinutes || 0;
  const winMin = config.strategies.global.winCooldownMinutes || 0;
  const allMin = config.strategies.global.mintCooldownMinutes || 0;
  if (allMin <= 0 && lossMin <= 0 && winMin <= 0) return null;
  const window = Math.max(allMin, lossMin, winMin) * 60000;
  const cd = S().recentClose.get(mintAddress, Date.now() - window);
  if (!cd) return null;
  if (allMin > 0 && (Date.now() - cd.exited_at) < allMin * 60000) return cd;
  if (lossMin > 0 && (cd.realized_pnl_sol || 0) < 0 && (Date.now() - cd.exited_at) < lossMin * 60000) return cd;
  if (winMin > 0 && (cd.realized_pnl_sol || 0) >= 0 && (Date.now() - cd.exited_at) < winMin * 60000) return cd;
  return null;
}

function passesStrategyShape(strategyName, mint) {
  const sCfg = config.strategies?.[strategyName];
  if (!sCfg) return { pass: true };
  const mc = mint.current_market_cap_sol || 0;
  const buyers = mint.unique_buyer_count || 0;
  const score = mint.runner_score == null ? -1 : mint.runner_score;
  const ageSec = mint.created_at ? Math.round((Date.now() - mint.created_at) / 1000) : 0;
  if (typeof sCfg.mcFloor === 'number' && mc < sCfg.mcFloor) return { pass: false, reason: 'STRAT_MC_FLOOR', detail: `${mc.toFixed(0)}<${sCfg.mcFloor}` };
  if (typeof sCfg.mcCeiling === 'number' && mc >= sCfg.mcCeiling) return { pass: false, reason: 'STRAT_MC_CEIL', detail: `${mc.toFixed(0)}>=${sCfg.mcCeiling}` };
  if (typeof sCfg.minBuyers === 'number' && buyers < sCfg.minBuyers) return { pass: false, reason: 'STRAT_MIN_BUYERS', detail: `${buyers}<${sCfg.minBuyers}` };
  if (typeof sCfg.maxBuyers === 'number' && buyers >= sCfg.maxBuyers) return { pass: false, reason: 'STRAT_MAX_BUYERS', detail: `${buyers}>=${sCfg.maxBuyers}` };
  if (typeof sCfg.minRunnerScore === 'number' && score < sCfg.minRunnerScore) return { pass: false, reason: 'STRAT_MIN_SCORE', detail: `${score}<${sCfg.minRunnerScore}` };
  if (typeof sCfg.minAgeSec === 'number' && ageSec < sCfg.minAgeSec) return { pass: false, reason: 'STRAT_MIN_AGE', detail: `${ageSec}s<${sCfg.minAgeSec}s` };
  if (typeof sCfg.maxAgeSec === 'number' && ageSec >= sCfg.maxAgeSec) return { pass: false, reason: 'STRAT_MAX_AGE', detail: `${ageSec}s>=${sCfg.maxAgeSec}s` };
  return { pass: true };
}

function tryFire(strategyName, mint, signalDetails, sizeOverride, scoreInfo) {
  const strat = getStrategy(strategyName);
  if (!strat || !strat.enabled) return;
  const shape = passesStrategyShape(strategyName, mint);
  if (!shape.pass) {
    console.log(`[strat-shape] ${strategyName} skip ${mint.mint_address.slice(0,8)}… ${shape.reason}(${shape.detail})`);
    return;
  }
  const paperHolding = S().holdingMint.get(mint.mint_address, strategyName, 'paper');
  const liveHolding = S().holdingMint.get(mint.mint_address, strategyName, 'live');
  if (paperHolding && (!isLiveMode() || liveHolding)) {
    console.log(`[strategy] ${strategyName} skip ${mint.mint_address.slice(0,8)}… already held`);
    return;
  }
  // SL bounce re-entry: check watchlist BEFORE cooldown. If this mint+strategy
  // recently SL'd AND current mcap implies price ≥80% of original entry, allow
  // re-entry at half size and consume the watchlist row.
  let isReentry = false;
  let reentryMult = 1.0;
  try {
    const w = db().prepare(`SELECT * FROM sl_watchlist WHERE mint_address = ? AND original_strategy = ? AND consumed = 0 AND expires_at > ?`).get(mint.mint_address, strategyName, Date.now());
    if (w) {
      const curPrice = mint.last_price_sol || 0;
      const recoveredRatio = w.original_entry_price > 0 ? curPrice / w.original_entry_price : 0;
      if (curPrice > 0 && recoveredRatio >= 0.80) {
        isReentry = true;
        reentryMult = 0.5;
        db().prepare(`UPDATE sl_watchlist SET consumed = 1 WHERE mint_address = ? AND original_strategy = ?`).run(mint.mint_address, strategyName);
        console.log(`[reentry] ${strategyName} bounce on ${mint.mint_address.slice(0,8)}… recovered ${(recoveredRatio*100).toFixed(0)}% of orig entry → re-enter at ${(reentryMult*100).toFixed(0)}% size`);
      }
    }
  } catch (err) { console.error('[reentry] watchlist check failed:', err.message); }

  if (!isReentry) {
    const cd = inCooldown(mint.mint_address);
    if (cd) {
      const minsAgo = ((Date.now() - cd.exited_at) / 60000).toFixed(1);
      console.log(`[strategy] ${strategyName} skip ${mint.mint_address.slice(0,8)}… cooldown (closed ${minsAgo}m ago, ${cd.realized_pnl_sol >= 0 ? '+' : ''}${cd.realized_pnl_sol.toFixed(4)} SOL)`);
      return;
    }
  }
  const baseSize = (sizeOverride && sizeOverride > 0 ? sizeOverride : strat.entry_sol) * reentryMult;
  const sized = applyDynamicSizing(baseSize, 1.0);
  const entrySol = typeof sized === 'object' ? sized.sol : sized;
  if (scoreInfo) {
    const short = mint.mint_address.slice(0, 8);
    const kolTag = scoreInfo.isKol ? ' 👑KOL' : '';
    const scoreMult = (sizeOverride/strat.entry_sol).toFixed(2);
    const wf = typeof sized === 'object' ? sized.walletFactor.toFixed(2) : '1.00';
    const wv = typeof sized === 'object' ? sized.walletValue.toFixed(3) : '?';
    console.log(`[score] ${strategyName} ${short}…${kolTag} score=${scoreMult}x wallet=${wv}SOL(${wf}x) → ${entrySol.toFixed(4)} SOL`);
  }
  const baseArgs = {
    strategy: strategyName,
    mintAddress: mint.mint_address,
    entryPrice: mint.last_price_sol || 0,
    entrySol,
    entryMcap: mint.current_market_cap_sol || 0,
    signalDetails: isReentry ? { ...signalDetails, _reentry: true } : signalDetails,
    entryScore: scoreInfo ? scoreInfo.multiplier : 1.0,
  };
  if (isLiveMode()) {
    if (!liveHolding) openPaperPosition({ ...baseArgs, positionMode: 'live' });
  } else if (!paperHolding) {
    openPaperPosition({ ...baseArgs, positionMode: 'paper' });
  }
}

export function onCopySignal(mintAddress, walletCount) {
  try {
    const mint = S().getMint.get(mintAddress);
    if (!mint || !passesGlobalGuards(mint, 'copy_signal')) return;
    const details = { type: 'COPY_SIGNAL', walletCount };
    for (const name of strategiesForTrigger('copy_signal')) tryFire(name, mint, details);
  } catch (err) { console.error('[strategy] onCopySignal', err.message); }
}

export function onSmartTrade(trade, mint) {
  try {
    if (!trade.is_buy) return;
    const w = S().walletInfo.get(trade.wallet);
    if (!w || !w.tracked) return;
    const trustedWhitelist = new Set(config.strategies?.trustedWallets?.addresses || []);
    const isWhitelistedTrusted = trustedWhitelist.has(trade.wallet);
    if (w.auto_blocked && !isWhitelistedTrusted) {
      console.log(`[blocked] auto-blocked wallet ${trade.wallet.slice(0,6)}… (follow WR=${(w.follow_wr*100).toFixed(0)}%, net=${(w.follow_net_sol||0).toFixed(3)} SOL)`);
      return;
    }
    const mcapFloor = config.strategies.global.smartTradeMinMcapSol || 0;
    const bypassBoost = config.strategies.global.smartTradeMcapFloorBypassBoost;
    const isBoosted = (w.auto_boost_mult || 1.0) > 1.0;
    if (mcapFloor > 0 && (mint.current_market_cap_sol || 0) < mcapFloor && !(bypassBoost && isBoosted)) {
      console.log(`[gate] mcap-floor ${mint.mint_address.slice(0,8)}… mcap ${(mint.current_market_cap_sol||0).toFixed(1)} < ${mcapFloor} (wallet not boosted)`);
      return;
    }
    if (mint.cashback_enabled === null && mint.bonding_curve_key) {
      import('../ingestion/processor.js').then(p => p.ensureCashback(mint.mint_address, mint.bonding_curve_key, null)).catch(() => {});
    }
    if (!passesGlobalGuards(mint, 'smart_trade')) return;
    w._wallet_addr = trade.wallet;
    if (w.is_kol) {
      console.log(`[kol] 👑 ${trade.wallet.slice(0, 8)}… buying ${mint.mint_address.slice(0, 8)}…`);
      // Enroll for KOL-dip A/B watcher (kolCoattailsDip fires later when first
      // dip lands). Idempotent — first KOL signal per mint wins.
      try {
        const sigPrice = mint.last_price_sol || 0;
        if (sigPrice > 0) {
          db().prepare(`INSERT OR IGNORE INTO kol_watch (mint_address, kol_wallet, signal_price, signal_at, peak_price, peak_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(mint.mint_address, trade.wallet, sigPrice, Date.now(), sigPrice, Date.now(), Date.now() + 10 * 60 * 1000);
        }
      } catch {}
    }

    const clusterCount = S().otherTrackedBuyers.get(
      mint.mint_address, Date.now() - config.cluster.windowSeconds * 1000, trade.wallet
    ).n + 1;
    if (clusterCount >= config.cluster.minWallets) {
      const details = { type: 'CLUSTER', wallet: trade.wallet, clusterCount };
      console.log(`[signal] cluster ${mint.mint_address.slice(0, 8)}… ${clusterCount} tracked wallets in ${config.cluster.windowSeconds}s`);
      for (const name of strategiesForTrigger('cluster')) tryFire(name, mint, details);
      return;
    }

    const score = scoreTrackedSignal(w, mint);
    const details = { type: 'SMART_BUY', wallet: trade.wallet, score: score.multiplier };
    for (const name of strategiesForTrigger('smart_trade')) {
      const strat = getStrategy(name);
      if (!strat) continue;
      const sg = applySourceGate(name, w, trade, mint);
      if (!sg.pass) {
        if (sg.log) console.log(sg.log);
        continue;
      }
      if (sg.fixedDetails || sg.sizeOverride) {
        tryFire(name, mint, sg.fixedDetails || details, sg.sizeOverride || strat.entry_sol, { multiplier: 1.0 });
        continue;
      }
      const dynamicSize = strat.entry_sol * score.multiplier;
      tryFire(name, mint, details, dynamicSize, score);
    }
  } catch (err) { console.error('[strategy] onSmartTrade', err.message); }
}

export function onMigratorHunter(mintAddress, hunterDetails) {
  try {
    const mint = S().getMint.get(mintAddress);
    if (!mint || !passesGlobalGuards(mint, 'migrator_hunter')) return;
    const details = { type: 'MIGRATOR_HUNTER', ...hunterDetails };
    console.log(
      `[migrator] 🎯 ${mintAddress.slice(0, 8)}… ${hunterDetails.hunterCount} hunters ` +
      `(avg score ${hunterDetails.avgScore}) · age ${hunterDetails.ageSec}s · mc ${hunterDetails.mcap} — firing`
    );
    for (const name of strategiesForTrigger('migrator_hunter')) {
      const strat = getStrategy(name);
      if (!strat || !strat.enabled) continue;
      const sCfg = config.strategies[name] || {};
      const sz = sCfg.sizing || {};
      const start = sz.scoreScaleStart ?? 0.55;
      const max = sz.scoreScaleMax ?? 0.85;
      const span = Math.max(0.0001, max - start);
      const ramp = Math.min(1, Math.max(0, (hunterDetails.avgScore - start) / span));
      const mult = 1 + ramp * ((sz.maxMult ?? 3.0) - 1);
      const base = sz.baseEntrySol ?? strat.entry_sol;
      let entrySol = base * mult;
      if (sz.minEntrySol) entrySol = Math.max(sz.minEntrySol, entrySol);
      if (sz.maxEntrySol) entrySol = Math.min(sz.maxEntrySol, entrySol);
      tryFire(name, mint, details, entrySol, { multiplier: +mult.toFixed(2), walletScore: hunterDetails.avgScore, isKol: false });
    }
  } catch (err) { console.error('[strategy] onMigratorHunter', err.message); }
}

export function onCoinVelocity(mintAddress, metrics) {
  try {
    const mint = S().getMint.get(mintAddress);
    if (!mint || !passesGlobalGuards(mint, 'coin_velocity', { skipHolderGate: true })) return;
    const details = {
      type: 'PRE_KING',
      mc: metrics.mc,
      buyersWindow: metrics.buyersFullWindow,
      buyersHalf: metrics.buyersRecentHalf,
      velocity: metrics.velocityRatio,
      ageSec: metrics.ageSec,
    };
    console.log(`[velocityRunner] ⚡ ${mintAddress.slice(0,8)}… age ${metrics.ageSec.toFixed(1)}s · mc ${metrics.mc.toFixed(1)} · ${metrics.buyersFullWindow} buyers (${metrics.buyersRecentHalf} recent · vel ${metrics.velocityRatio.toFixed(2)}) — firing`);
    for (const name of strategiesForTrigger('coin_velocity')) tryFire(name, mint, details);
  } catch (err) { console.error('[strategy] onCoinVelocity', err.message); }
}

export function onRunnerScore(mintAddress, scoreInfo) {
  try {
    const mint = S().getMint.get(mintAddress);
    if (!mint || !passesGlobalGuards(mint, 'runner_score')) return;
    const details = { type: 'RUNNER_SCORE', score: scoreInfo.score, ...scoreInfo.breakdown };
    for (const name of strategiesForTrigger('runner_score')) tryFire(name, mint, details);
  } catch (err) { console.error('[strategy] onRunnerScore', err.message); }
}

export function onVolumeSurge(mintAddress, surgeDetails) {
  try {
    const mint = S().getMint.get(mintAddress);
    if (!mint || !passesGlobalGuards(mint, 'volume_surge')) return;
    const details = { type: 'VOLUME_SURGE', ...surgeDetails };
    const holding = S().holdingMint.get(mintAddress, 'volumeSurgeRunner', 'paper');
    if (holding) {
      console.log(`[strategy] volumeSurgeRunner skip ${mintAddress.slice(0,8)}… already held`);
      return;
    }
    const cd = inCooldown(mintAddress);
    if (cd) {
      const minsAgo = ((Date.now() - cd.exited_at) / 60000).toFixed(1);
      console.log(`[strategy] volumeSurgeRunner skip ${mintAddress.slice(0,8)}… cooldown (closed ${minsAgo}m ago)`);
      return;
    }
    for (const name of strategiesForTrigger('volume_surge')) {
      const strat = getStrategy(name);
      if (!strat || !strat.enabled) continue;
      const dynamicEntry = surgeDetails.suggested_entry_sol > 0
        ? surgeDetails.suggested_entry_sol
        : strat.entry_sol;
      const args = {
        strategy: name,
        mintAddress,
        entryPrice: mint.last_price_sol || 0,
        entrySol: dynamicEntry,
        entryMcap: mint.current_market_cap_sol || 0,
        signalDetails: details,
      };
      const paperHeld = S().holdingMint.get(mintAddress, name, 'paper');
      const liveHeld = S().holdingMint.get(mintAddress, name, 'live');
      if (isLiveMode()) {
        if (!liveHeld) openPaperPosition({ ...args, positionMode: 'live' });
      } else if (!paperHeld) {
        openPaperPosition({ ...args, positionMode: 'paper' });
      }
    }
  } catch (err) { console.error('[strategy] onVolumeSurge', err.message); }
}

export function onWhaleSpawn(mintAddress, details) {
  try {
    const mint = S().getMint.get(mintAddress);
    if (!mint || !passesGlobalGuards(mint, 'whale_spawn')) return;
    const sigDetails = { type: 'WHALE_SPAWN', ...details };
    for (const name of strategiesForTrigger('whale_spawn')) {
      const strat = getStrategy(name);
      if (!strat || !strat.enabled) continue;
      // Size scaling by initial_buy_sol — higher conviction at bigger dev-buy
      const sCfg = config.strategies[name] || {};
      const sz = sCfg.sizing || {};
      const ib = details.initial_buy_sol || 0;
      let mult = 1.0;
      if (ib >= 25) mult = 2.0;
      else if (ib >= 15) mult = 1.5;
      const base = sz.baseEntrySol ?? strat.entry_sol;
      let entrySol = base * mult;
      if (sz.minEntrySol) entrySol = Math.max(sz.minEntrySol, entrySol);
      if (sz.maxEntrySol) entrySol = Math.min(sz.maxEntrySol, entrySol);
      tryFire(name, mint, sigDetails, entrySol, { multiplier: +mult.toFixed(2), walletScore: 0, isKol: false });
    }
  } catch (err) { console.error('[strategy] onWhaleSpawn', err.message); }
}


export function onKolDip(mintAddress, details) {
  try {
    const mint = S().getMint.get(mintAddress);
    if (!mint || !passesGlobalGuards(mint, 'kol_dip')) return;
    const sigDetails = { type: 'KOL_DIP', ...details };
    for (const name of strategiesForTrigger('kol_dip')) tryFire(name, mint, sigDetails);
  } catch (err) { console.error('[strategy] onKolDip', err.message); }
}
