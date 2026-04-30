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
  }
}

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    getStrategy: d.prepare('SELECT * FROM strategy_state WHERE name = ?'),
    listStrategies: d.prepare('SELECT * FROM strategy_state ORDER BY name'),
    toggleStrategy: d.prepare('UPDATE strategy_state SET enabled = 1 - enabled, updated_at = ? WHERE name = ?'),
    countOpen: d.prepare("SELECT COUNT(*) AS n FROM paper_positions WHERE status = 'open'"),
    sumOpenSol: d.prepare("SELECT COALESCE(SUM(entry_sol), 0) AS s FROM paper_positions WHERE status = 'open'"),
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

function strategiesForTrigger(trigger) {
  return KEYS.filter(k => config.strategies[k]?.trigger === trigger);
}

export function listStrategies() { return S().listStrategies.all(); }
export function getStrategy(name) { return S().getStrategy.get(name); }

export function toggleStrategy(name) {
  S().toggleStrategy.run(Date.now(), name);
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

function tryFire(strategyName, mint, signalDetails, sizeOverride, scoreInfo) {
  const strat = getStrategy(strategyName);
  if (!strat || !strat.enabled) return;
  const paperHolding = S().holdingMint.get(mint.mint_address, strategyName, 'paper');
  const liveHolding = S().holdingMint.get(mint.mint_address, strategyName, 'live');
  if (paperHolding && (!isLiveMode() || liveHolding)) {
    console.log(`[strategy] ${strategyName} skip ${mint.mint_address.slice(0,8)}… already held`);
    return;
  }
  const cd = inCooldown(mint.mint_address);
  if (cd) {
    const minsAgo = ((Date.now() - cd.exited_at) / 60000).toFixed(1);
    console.log(`[strategy] ${strategyName} skip ${mint.mint_address.slice(0,8)}… cooldown (closed ${minsAgo}m ago, ${cd.realized_pnl_sol >= 0 ? '+' : ''}${cd.realized_pnl_sol.toFixed(4)} SOL)`);
    return;
  }
  const baseSize = sizeOverride && sizeOverride > 0 ? sizeOverride : strat.entry_sol;
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
    signalDetails,
    entryScore: scoreInfo ? scoreInfo.multiplier : 1.0,
  };
  if (!paperHolding) openPaperPosition({ ...baseArgs, positionMode: 'paper' });
  if (isLiveMode() && !liveHolding) openPaperPosition({ ...baseArgs, positionMode: 'live' });
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
    const walletBoosted = (w.auto_boost_mult || 1.0) > 1.0;
    const kingWhitelist = new Set(config.strategies?.kingFollow?.kingWallets || []);
    const isWhitelistedKing = kingWhitelist.has(trade.wallet);
    if ((w.bundle_cluster_id || w.category === 'BUNDLE') && !walletBoosted && !isWhitelistedKing) return;
    if (!w.copy_friendly && !walletBoosted && !isWhitelistedKing) return;
    if (w.auto_blocked && !isWhitelistedKing) {
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
    if (w.is_kol) console.log(`[kol] 👑 ${trade.wallet.slice(0, 8)}… buying ${mint.mint_address.slice(0, 8)}…`);

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
      if (name === 'kingFollow') {
        const cfg = config.strategies.kingFollow || {};
        const kings = new Set(cfg.kingWallets || []);
        if (!kings.has(trade.wallet)) continue;
        const mc = mint.current_market_cap_sol || 0;
        const ceiling = cfg.kingMaxMcapSol || 150;
        if (mc >= ceiling) {
          console.log(`[gate] king-ceiling ${mint.mint_address.slice(0,8)}… mc ${mc.toFixed(1)} ≥ ${ceiling}`);
          continue;
        }
        console.log(`[king] 👑 ${trade.wallet.slice(0,6)}… buying ${mint.mint_address.slice(0,8)}… mc ${mc.toFixed(1)} — firing kingFollow`);
        const fixedDetails = { ...details, type: 'KING_FOLLOW' };
        tryFire(name, mint, fixedDetails, strat.entry_sol, { multiplier: 1.0 });
        continue;
      }
      if (name === 'quickFlip15') {
        const mc = mint.current_market_cap_sol || 0;
        const isKol = !!w.is_kol;
        const isBot = w.category === 'BOT';
        const QF_MC_CEILING = 100;
        const QF_BOT_MC_MAX = 70;
        if (mc >= QF_MC_CEILING) {
          console.log(`[gate] qf-ceiling ${mint.mint_address.slice(0,8)}… mc ${mc.toFixed(1)} ≥ ${QF_MC_CEILING}`);
          continue;
        }
        if (!isKol && !(isBot && mc < QF_BOT_MC_MAX)) {
          console.log(`[gate] qf-source ${mint.mint_address.slice(0,8)}… ${trade.wallet.slice(0,6)}… cat=${w.category||'?'} kol=${isKol?1:0} mc=${mc.toFixed(1)} — needs KOL or BOT<${QF_BOT_MC_MAX}`);
          continue;
        }
      }
      const dynamicSize = strat.entry_sol * score.multiplier;
      tryFire(name, mint, details, dynamicSize, score);
    }
  } catch (err) { console.error('[strategy] onSmartTrade', err.message); }
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
    console.log(`[preKing] ⚡ ${mintAddress.slice(0,8)}… age ${metrics.ageSec.toFixed(1)}s · mc ${metrics.mc.toFixed(1)} · ${metrics.buyersFullWindow} buyers (${metrics.buyersRecentHalf} recent · vel ${metrics.velocityRatio.toFixed(2)}) — firing`);
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
      if (!paperHeld) openPaperPosition({ ...args, positionMode: 'paper' });
      if (isLiveMode() && !liveHeld) openPaperPosition({ ...args, positionMode: 'live' });
    }
  } catch (err) { console.error('[strategy] onVolumeSurge', err.message); }
}
