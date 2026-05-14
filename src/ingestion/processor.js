import { db } from '../db/index.js';
import { fetchMetadata } from './metadata.js';
import { labelTrade, checkFlags } from '../scoring/flags.js';
import { checkCopySignal } from '../scoring/traders.js';
import { onSmartTrade, onCoinVelocity, onMigratorHunter } from '../trading/strategies.js';
import { trackHunterBuy } from '../scoring/migrator-hunter.js';
import { notifyTradeForMint } from '../trading/paper.js';
import { evaluateMintNow, isCopyTradeTarget } from '../ml/agent-executor.js';
import { isMlConvictionMint } from '../ml/ml-conviction-watcher.js';
import { isMuted as isTrackerMuted } from '../scoring/tracker-concentration.js';
import { config } from '../config.js';
import { checkCashbackFlag } from './helius.js';
import { trackBuyer, checkVelocityRunnerProfile, markFired } from '../scoring/coin-velocity.js';
import { getIngestionPaused } from '../ml/disk-monitor.js';
import { updateMigratorStatsForMint } from '../scoring/migrator-stats.js';
import { triggerWebhookResync } from './helius-webhooks.js';
import { isMintHeld } from '../trading/held-mints.js';
import { isAmmSubscribed } from './onchain-amm-price.js';

const cashbackInflight = new Set();
export function ensureCashback(mintAddress, bondingCurveKey, currentValue) {
  if (currentValue !== null && currentValue !== undefined) return;
  if (!bondingCurveKey) return;
  if (cashbackInflight.has(mintAddress)) return;
  cashbackInflight.add(mintAddress);
  checkCashbackFlag(bondingCurveKey).then((flag) => {
    if (flag === null) return;
    try {
      S().setCashback.run(flag, Date.now(), mintAddress);
      if (flag === 1) console.log(`[cashback] 💸 ${mintAddress.slice(0,8)}… is a cashback coin`);
    } catch {}
  }).finally(() => cashbackInflight.delete(mintAddress));
}

let stmts = null;

// Aggregate junk-price drops — at peak ~500 drops/min were being logged
// individually, blocking the event loop with synchronous console.warn and
// slowing RPC probes from 200ms into 6s+. Now count silently and log a
// rollup once per minute.
let _junkDropCount = 0;
let _junkDropLastLog = Date.now();
const JUNK_DROP_LOG_INTERVAL_MS = 60 * 1000;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    insertMint: d.prepare(`INSERT OR IGNORE INTO mints
      (mint_address, creator_wallet, signature, name, symbol, uri,
       initial_buy_sol, v_sol_in_curve, v_tokens_in_curve,
       current_market_cap_sol, peak_market_cap_sol, bonding_curve_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setCashback: d.prepare(`UPDATE mints SET cashback_enabled = ?, cashback_checked_at = ? WHERE mint_address = ?`),
    upsertCreator: d.prepare(`INSERT INTO creators (wallet, first_launch, last_launch, launch_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(wallet) DO UPDATE SET
        launch_count = launch_count + 1,
        last_launch = excluded.last_launch`),
    setMetadata: d.prepare(`UPDATE mints
      SET description = ?, image_uri = ?, twitter = ?, telegram = ?, website = ?, metadata_fetched_at = ?
      WHERE mint_address = ?`),
    getMint: d.prepare('SELECT * FROM mints WHERE mint_address = ?'),
    countDistinctBuyers: d.prepare('SELECT COUNT(DISTINCT wallet) AS n FROM trades WHERE mint_address = ? AND is_buy = 1'),
    walletAlreadyBought: d.prepare('SELECT 1 FROM trades WHERE mint_address = ? AND wallet = ? AND is_buy = 1 LIMIT 1'),
    insertTrade: d.prepare(`INSERT OR IGNORE INTO trades
      (signature, mint_address, wallet, is_buy, sol_amount, token_amount, price_sol, market_cap_sol,
       seconds_from_creation, is_sniper, is_first_block, buyer_rank, wallet_label, timestamp, is_junk)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    // 2026-05-14: peak_market_cap_sol DROPPED from the trade-driven update.
    // Trade-implied prices (pumpportal AND helius-tx) can be polluted by MEV
    // sandwich victims, off-pool quotes, and AMM router quirks that the
    // dust/spike/stale/reserve-mismatch filters can't catch when reserve
    // data is older than RESERVE_FRESH_MS (HUMANITAS: peak hit 1208 SOL from
    // a 0.022-SOL trade ~3min after the last BC write, real chart peak ~470).
    // Peak is now a reserve-only quantity — written exclusively by:
    //   - src/ingestion/onchain-price.js (BC reserve decoder, pre-mig)
    //   - src/ingestion/onchain-amm-price.js (pump-amm reserve decoder, post-mig held)
    //   - src/ingestion/dexscreener.js (reserve-derived aggregator polling)
    //   - src/ingestion/migrated-tracker.js (post-mig AMM polling)
    // Tradeoff: peak lags by up to one reserve-poll interval, but never
    // records phantom moves. Accuracy beats freshness for peak tracking.
    updateMintOnTrade: d.prepare(`UPDATE mints SET
        current_market_cap_sol = ?,
        last_price_sol = ?,
        v_sol_in_curve = ?,
        v_tokens_in_curve = ?,
        trade_count = trade_count + 1,
        last_trade_at = ?,
        last_price_source = ?,
        last_price_source_at = ?
      WHERE mint_address = ?`),
    bumpUniqueBuyers: d.prepare('UPDATE mints SET unique_buyer_count = ? WHERE mint_address = ?'),
    holdingBuy: d.prepare(`INSERT INTO wallet_holdings
        (wallet, mint_address, tokens_bought, sol_invested, first_buy_at, last_activity_at, is_sniper, is_first_block, buyer_rank)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(wallet, mint_address) DO UPDATE SET
          tokens_bought = tokens_bought + excluded.tokens_bought,
          sol_invested = sol_invested + excluded.sol_invested,
          last_activity_at = excluded.last_activity_at,
          is_sniper = CASE WHEN is_sniper = 1 OR excluded.is_sniper = 1 THEN 1 ELSE 0 END,
          is_first_block = CASE WHEN is_first_block = 1 OR excluded.is_first_block = 1 THEN 1 ELSE 0 END`),
    holdingSell: d.prepare(`INSERT INTO wallet_holdings
        (wallet, mint_address, tokens_sold, sol_realized, last_activity_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(wallet, mint_address) DO UPDATE SET
          tokens_sold = tokens_sold + excluded.tokens_sold,
          sol_realized = sol_realized + excluded.sol_realized,
          last_activity_at = excluded.last_activity_at`),
    upsertWallet: d.prepare(`INSERT INTO wallets
        (address, first_seen, last_activity_at, total_sol_in, total_sol_out, trade_count, buy_count, sell_count, sniper_count, first_block_count)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(address) DO UPDATE SET
          total_sol_in = total_sol_in + excluded.total_sol_in,
          total_sol_out = total_sol_out + excluded.total_sol_out,
          last_activity_at = excluded.last_activity_at,
          trade_count = trade_count + 1,
          buy_count = buy_count + excluded.buy_count,
          sell_count = sell_count + excluded.sell_count,
          sniper_count = sniper_count + excluded.sniper_count,
          first_block_count = first_block_count + excluded.first_block_count`),
    migrate: d.prepare(`UPDATE mints SET migrated = 1, migrated_at = ?, pool = ?, migrated_to = ? WHERE mint_address = ?`),
    bumpMigrated: d.prepare('UPDATE creators SET migrated_count = migrated_count + 1 WHERE wallet = ?'),
    recentLive: d.prepare(`SELECT mint_address FROM mints
      WHERE migrated = 0 AND rugged = 0 AND created_at > ?
      ORDER BY created_at DESC LIMIT ?`),
  };
  return stmts;
}

export function startProcessor(pumpportal) {
  pumpportal.on('create', onCreate);
  pumpportal.on('trade', onTrade);
  pumpportal.on('migrate', onMigrate);
}

// Inject an externally-sourced trade (e.g. parsed from a Helius webhook) into the
// same pipeline PumpPortal trades flow through. Caller supplies our normalized
// shape: { mint, wallet, is_buy, sol_amount, token_amount, signature, timestamp }.
// We translate to the PumpPortal-event shape onTrade expects.
export function ingestExternalTrade(p) {
  if (!p || !p.mint || !p.wallet) return;
  // We may not know the live curve state from a webhook payload — onTrade reads
  // current_market_cap_sol from the mints row (kept fresh by onchain-price.js)
  // and falls back to 0 if missing. solAmount/tokenAmount come from the parsed
  // tokenTransfers + nativeTransfers.
  onTrade({
    mint: p.mint,
    txType: p.is_buy ? 'buy' : 'sell',
    solAmount: p.sol_amount || 0,
    tokenAmount: p.token_amount || 0,
    traderPublicKey: p.wallet,
    signature: p.signature || null,
    marketCapSol: 0, // unknown from webhook — leave 0, on-chain feed has the truth
    vSolInBondingCurve: 0,
    vTokensInBondingCurve: 0,
    timestamp: p.timestamp || null,  // on-chain block timestamp; used by stale-event guard in onTrade
    source: 'helius-tx',
  });
}

function onCreate(e) {
  try {
    // Disk-pressure pause — skip ingestion when free space is critically low.
    if (getIngestionPaused()) return;
    const s = S();
    const now = Date.now();
    const creator = e.traderPublicKey || e.creator || '';
    s.insertMint.run(
      e.mint, creator, e.signature || null, e.name || null, e.symbol || null, e.uri || null,
      e.solAmount || 0, e.vSolInBondingCurve || 0, e.vTokensInBondingCurve || 0,
      e.marketCapSol || 0, e.marketCapSol || 0, e.bondingCurveKey || null, now
    );
    if (creator) s.upsertCreator.run(creator, now, now);

    // Whale-spawn enrollment retained as data signal (not used by strategies
    // in pure-collection mode but the data is useful for ML feature analysis).
    const initBuy = Number(e.solAmount || 0);
    if (initBuy >= 8 && initBuy < 50) {
      try {
        const seedPrice = (e.vSolInBondingCurve && e.vTokensInBondingCurve)
          ? e.vSolInBondingCurve / e.vTokensInBondingCurve : 0;
        db().prepare(`INSERT OR IGNORE INTO whale_watch (mint_address, initial_buy_sol, seed_price, peak_price, peak_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(e.mint, initBuy, seedPrice, seedPrice, now, now, now + 10 * 60 * 1000);
        console.log(`[whale-watch] enrolled ${e.mint.slice(0,8)}… init_buy=${initBuy.toFixed(1)}SOL seed=${seedPrice.toExponential(2)}`);
      } catch (err) {
        // INSERT OR IGNORE swallows UNIQUE violations natively, so the only
        // real errors reaching here are schema/connection issues — log them.
        console.error('[whale-watch] enroll failed:', err.message);
      }
    }

    if (e.uri) {
      fetchMetadata(e.uri).then((meta) => {
        if (!meta) return;
        S().setMetadata.run(
          meta.description, meta.image_uri, meta.twitter, meta.telegram, meta.website, Date.now(), e.mint
        );
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[processor] create', err.message);
  }
}

function onTrade(e) {
  try {
    if (getIngestionPaused()) return;
    const s = S();
    const now = Date.now();
    const mint = s.getMint.get(e.mint);
    if (!mint) return;

    const secondsFromCreation = Math.max(0, Math.floor((now - mint.created_at) / 1000));
    const isBuy = e.txType === 'buy' ? 1 : 0;
    const solAmount = Number(e.solAmount || 0);
    const tokenAmount = Number(e.tokenAmount || 0);
    const priceSol = tokenAmount > 0 ? solAmount / tokenAmount : null;
    const wallet = e.traderPublicKey || '';

    const uniqueBuyersSoFar = s.countDistinctBuyers.get(e.mint).n;
    const isNewBuyer = isBuy && wallet && !s.walletAlreadyBought.get(e.mint, wallet);
    const buyerRank = isNewBuyer ? uniqueBuyersSoFar + 1 : null;

    const isSniper = isBuy && secondsFromCreation <= config.sniper.secondsWindow ? 1 : 0;

    const isFirstBlock = isBuy && (
      secondsFromCreation <= config.sniper.firstBlockMaxSeconds ||
      (buyerRank !== null && buyerRank <= config.sniper.firstBlockMaxRank)
    ) ? 1 : 0;

    const label = labelTrade({ wallet, creator: mint.creator_wallet, isSniper });

    // Pump.fun tokens have fixed 1B supply. Post-migration the trade event
    // stops carrying marketCapSol (bonding curve closed). Compute from price ×
    // supply when missing — otherwise migrated mints show mcap=0 even though
    // they're still trading on the AMM.
    const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000;
    let mcapSol = e.marketCapSol || 0;
    if (mcapSol <= 0 && priceSol > 0) {
      mcapSol = priceSol * PUMP_FUN_TOTAL_SUPPLY;
    }

    // 2026-05-13: junk-detection moved BEFORE the trade insert so we can stamp
    // is_junk=1 on the row itself. Downstream consumers (label-resolver,
    // snapshot-sweeper, analytics) can then filter `WHERE is_junk = 0` to
    // exclude phantom ticks from their computations. Trade row still inserted
    // for audit (on-chain provenance), just flagged.
    // SANITY: pump.fun bonding-curve math says min price ≈ 2.8e-8 SOL/token.
    // Trades arriving with priceSol below 1e-8 on a non-migrated mint are
    // junk. Migrated mints get a relaxed floor (1e-9) — they CAN crater on
    // AMM but a 100x drop in seconds is migration-moment garbage (2026-05-11
    // Goblinjak: 4.3e-7 → 3.5e-9 in one tick, corrupted last_price_sol).
    const PRICE_FLOOR = 1e-8;
    const MIGRATED_PRICE_FLOOR = 1e-9;
    const px = priceSol || 0;
    // SANITY: dust trades on post-migration pools sometimes report a wildly
    // inflated implied price (off-pool quote, partial fill, AMM/router quirk).
    // 2026-05-11 SLEEP: 0.003-SOL "sells" reported 1e-6 to 2e-6 prices vs the
    // real ~5e-7 market — corrupted peak_market_cap_sol to 2085 SOL and made
    // the dashboard display 2x reality. Reject mint-state updates from
    // sub-0.01-SOL trades on migrated mints; the trade row is still stored.
    // 2026-05-13 PM: dust filter was migrated-only at 0.01 SOL. OLIVIA (peak
    // recorded 866 SOL on a single 0.0029 SOL buy) and SIGEON (peak 754 SOL
    // via a sequence of 0.0107 SOL bot ratchets) both happened pre-migration —
    // neither got filtered. Two fixes: (1) extend to pre-mig once the mint has
    // real interest (mcap > 30 SOL) so brand-new launches with legit tiny
    // first-buys still accept; (2) bump threshold 0.01 → 0.02 because bots
    // size their dust trades to JUST above 0.01 to evade the old gate.
    const DUST_TRADE_SOL = 0.02;
    const DUST_BC_MIN_MCAP_SOL = 30;
    const isDustOnAmm = mint.migrated && (solAmount || 0) < DUST_TRADE_SOL;
    const isDustOnMatureBc = !mint.migrated &&
                            (solAmount || 0) < DUST_TRADE_SOL &&
                            (mint.current_market_cap_sol || 0) > DUST_BC_MIN_MCAP_SOL;
    const isDust = isDustOnAmm || isDustOnMatureBc;
    // Spike-out guard: if this trade's implied price is >5x the prior price
    // AND the prior price was set in the last 5 min AND we're already past
    // the bonding-curve floor, treat as an off-pool quote artifact.
    // 2026-05-11 NICHEBABY: 6.5-SOL sell reported 6105 SOL mcap, 15x the
    // prior trade 2 min before. Real price was ~$160k, displayed showed
    // $589k peak. Same class of corruption as dust ticks, but bigger trade.
    // 2026-05-12 audit: the original guard was migrated-only, so 2083 non-mig
    // mints had polluted peaks (avg 240x inflation, worst 241kx). Extended to
    // ALL mints, with a 60s carve-out for brand-new mints where bonding-curve
    // math legitimately moves fast at launch.
    // Also added a hard sanity check: never accept a tick whose mcap is more
    // than 20x the existing peak (legitimate moves don't make THAT jump in
    // a single trade).
    const SPIKE_MAX_RATIO = 5;
    const SPIKE_WINDOW_MS = 5 * 60 * 1000;
    const PEAK_RATIO_CAP = 20;
    const PEAK_GUARD_MIN_SOL = 10;
    const FRESH_MINT_GRACE_MS = 60 * 1000;
    // 2026-05-13: stale-timestamp guard. Helius webhooks can deliver events
    // out of order — a tracked wallet's trade from 2-3 min ago shows up well
    // after newer trades have already moved last_price_sol downward. The
    // existing 5x spike ratio doesn't catch the typical ~2x mismatch, so the
    // stale price overwrites fresh state. Position monitor reads
    // mints.last_price_sol → records the stale price as peak → trail floor
    // is set on a fake peak → real price can't hold it → exit at a loss.
    // EXPLOSM hit exactly this: position peaked at +109% (= 167e-9) without
    // a single live trade matching that price; the 167 came from a webhook
    // event for a trade that happened 2 min before entry.
    // Fix: if e.timestamp exists AND is >30s older than mint.last_trade_at,
    // flag as junk (trade row still inserts for history, mint state untouched).
    const STALE_TRADE_MS = 30 * 1000;
    const priorPx = mint.last_price_sol || 0;
    const priorTradeAt = mint.last_trade_at || 0;
    const mintAge = now - (mint.created_at || now);
    const isMatureEnough = mint.migrated || mintAge > FRESH_MINT_GRACE_MS;
    const isSpikeUp = isMatureEnough &&
                     priorPx > 0 &&
                     px > priorPx * SPIKE_MAX_RATIO &&
                     (now - priorTradeAt) < SPIKE_WINDOW_MS;
    // 2026-05-13: spike-DOWN guard. Mirror of spike-up — rejects phantom down
    // ticks (>5× drop within 5min) on mature non-rugged mints. The migration
    // handoff is a known fragile zone: bonding-curve PDA can emit one final
    // stale state after the AMM has already taken over, fresh AMM pools can
    // quote weird before liquidity stabilizes, and Raydium/PumpAMM routers
    // sometimes return off-pool values. Without this guard those phantom
    // values poison mints.last_price_sol and every position monitor reading
    // it fires bad exits (FAKE_PUMP, SL_HIT, MOONBAG_SL).
    // Caught NUBBIX/CUPPY/BALLSACKDORKL exits at phantom 4.108e-07 across
    // multiple unrelated positions/times.
    const isSpikeDown = isMatureEnough &&
                       priorPx > 0 &&
                       px < priorPx / SPIKE_MAX_RATIO &&
                       (now - priorTradeAt) < SPIKE_WINDOW_MS;
    const priorPeak = mint.peak_market_cap_sol || 0;
    const isAbsurdPeakJump = priorPeak > PEAK_GUARD_MIN_SOL &&
                             mcapSol > priorPeak * PEAK_RATIO_CAP;
    // Out-of-order webhook event: trade timestamp is meaningfully older than
    // the mint's most recent trade. Only checks when e.timestamp exists
    // (helius-tx events) and only matters when the mint has prior activity.
    const isStaleEvent = !!(e.timestamp && mint.last_trade_at &&
                           e.timestamp < mint.last_trade_at - STALE_TRADE_MS);
    // Audit fix B (2026-05-14) — reserve-price gatekeeping. When we have a
    // recent reserve-decoded price (onchain-curve / onchain-amm wrote within
    // RESERVE_FRESH_MS), trade-implied prices that diverge from it by more
    // than RESERVE_DEVIATION are MEV/router manipulation (Jupiter routing,
    // sandwich attacks, off-curve execution). The actual BC marginal price
    // doesn't move that much in one trade; only trade implied prices do.
    // Killing them on every write path closes the main remaining leak after
    // dust/spike filters.
    const RESERVE_DEVIATION = 0.35;     // 35% — wider than spike-up to avoid false positives on big real moves
    const RESERVE_FRESH_MS = 30 * 1000; // reserve write must be recent for gate to apply
    const curveAge = now - (mint.last_curve_write_at || 0);
    const curveFresh = mint.last_curve_write_at && curveAge < RESERVE_FRESH_MS;
    const reserveRefPrice = curveFresh ? (mint.last_price_sol || 0) : 0;
    const isReserveMismatch = reserveRefPrice > 0 && px > 0 &&
                             Math.abs(px - reserveRefPrice) / reserveRefPrice > RESERVE_DEVIATION;
    const isJunkPrice = !mint.rugged && (
      isDust ||
      isSpikeUp ||
      isSpikeDown ||
      isAbsurdPeakJump ||
      isStaleEvent ||
      isReserveMismatch ||
      (!mint.migrated && px < PRICE_FLOOR) ||
      (mint.migrated && px < MIGRATED_PRICE_FLOOR)
    );
    // Insert with the is_junk flag stamped on the row itself.
    s.insertTrade.run(
      e.signature || null, e.mint, wallet, isBuy, solAmount, tokenAmount, priceSol,
      mcapSol, secondsFromCreation, isSniper, isFirstBlock, buyerRank, label, now,
      isJunkPrice ? 1 : 0
    );
    if (isJunkPrice) {
      _junkDropCount++;
      const sinceLog = now - _junkDropLastLog;
      if (sinceLog >= JUNK_DROP_LOG_INTERVAL_MS) {
        console.log(`[processor] FLAGGED ${_junkDropCount} junk trade rows in last ${Math.round(sinceLog/1000)}s — is_junk=1, mints.last_price_sol preserved`);
        _junkDropCount = 0;
        _junkDropLastLog = now;
      }
    } else {
      // Held-mint write lock — tightened 2026-05-13 PM after observing that
      // helius-tx trade-implied prices still polluted held-position peak
      // tracking (e.g., #5107 DigitalID recorded peak +161% while real trades
      // only reached +31%). For HELD PRE-MIG mints, onchain-curve (Helius WSS
      // reserve decoder in src/ingestion/onchain-price.js) is the sole writer:
      // it reads the bonding curve's actual reserves, immune to trade
      // interpretation, sandwich routing, out-of-order events. processor.js
      // writes (pumpportal AND helius-tx) are blocked for pre-mig held.
      // For HELD POST-MIG mints: onchain-curve doesn't fire (BC pool closed),
      // so helius-tx remains the canonical source. pumpportal still blocked.
      // For NOT-HELD mints: all sources write normally.
      const source = e.source || 'pumpportal';
      const isHeld = isMintHeld(e.mint);
      // 2026-05-14: smart fallback. The strict onchain-curve / onchain-amm
      // lock creates a single point of failure — if the primary source's WSS
      // stalls, position monitor freezes for the full reconnect window.
      // pump.fun coins can move 50%+ in 30s, so even brief stalls cost real
      // money. Fallback: if the primary source has been silent on this mint
      // for >FALLBACK_THRESHOLD_MS, allow helius-tx to write (webhook is
      // independent of WSS reliability). pumpportal always blocked for held.
      // STRICT held-mint lock — no helius-tx fallback for pre-mig held.
      // Trade-derived prices kept letting off-curve MEV manipulation
      // through (e.g., 0.046 SOL buys with implied prices 2-3x real BC
      // state). These slip past both dust (>=0.02 SOL) and spike-up
      // (<5x ratio) filters. Result: phantom peaks recorded into
      // highest_pct. Brief WSS staleness (up to ~35s on reconnect) is
      // preferable to permanently corrupted peak tracking.
      //
      // Pre-mig held: onchain-curve sole writer. Block everything else.
      // Post-mig held: onchain-amm if subscribed; else helius-tx fallback
      //   (no reserve decoder available, must accept trade-derived).
      let heldLock = false;
      if (isHeld) {
        if (!mint.migrated) {
          heldLock = true; // pre-mig: STRICT, onchain-curve only
        } else if (isAmmSubscribed(e.mint)) {
          heldLock = true; // post-mig with onchain-amm: STRICT
        } else {
          // post-mig before AMM subscribes: helius-tx canonical, block pumpportal
          heldLock = source !== 'helius-tx';
        }
      }
      if (!heldLock) {
        s.updateMintOnTrade.run(
          mcapSol, priceSol || 0, e.vSolInBondingCurve || 0, e.vTokensInBondingCurve || 0,
          now, source, now, e.mint
        );
      }
    }

    if (isBuy) {
      s.holdingBuy.run(wallet, e.mint, tokenAmount, solAmount, now, now, isSniper, isFirstBlock, buyerRank);
      const updated = s.countDistinctBuyers.get(e.mint).n;
      s.bumpUniqueBuyers.run(updated, e.mint);
      if (updated === 5 && mint.cashback_enabled === null) {
        ensureCashback(e.mint, mint.bonding_curve_key, mint.cashback_enabled);
      }
    } else {
      s.holdingSell.run(wallet, e.mint, tokenAmount, solAmount, now);
    }

    s.upsertWallet.run(
      wallet, now, now,
      isBuy ? solAmount : 0, isBuy ? 0 : solAmount,
      isBuy, isBuy ? 0 : 1, isSniper, isFirstBlock
    );

    if (isBuy) {
      try { trackBuyer(e.mint, wallet, now); } catch (err) { console.error('[velocity]', err.message); }
      try {
        const sig = trackHunterBuy(e.mint, wallet, now);
        if (sig) {
          onMigratorHunter(e.mint, sig);
          // EVENT: migrator-hunter fired (multi-hunter convergence)
          evaluateMintNow(e.mint, 'migrator-hunter-signal').catch(() => {});
        }
      } catch (err) { console.error('[migrator-hunter]', err.message); }
      if (config.strategies?.velocityRunner?.defaults?.enabled !== undefined) {
        try {
          const profile = checkVelocityRunnerProfile(e.mint, now);
          if (profile?.pass) {
            markFired(e.mint, now);
            onCoinVelocity(e.mint, profile.metrics);
            // EVENT: velocity-runner detected on an AGED mint (>30min old).
            // Velocity on fresh pump.fun mints is meaningless — every pump
            // mint has velocity in its first minute. But sustained velocity
            // 30+ min in is real signal that something's actually catching.
            const ageSec = (now - mint.created_at) / 1000;
            if (ageSec >= 1800) {
              evaluateMintNow(e.mint, `velocity-runner-aged-${Math.round(ageSec/60)}min`).catch(() => {});
            }
          }
        } catch (err) { console.error('[velocityRunner]', err.message); }
      }
    }

    if (isBuy && label === 'SMART') {
      try { checkCopySignal(e.mint); } catch (err) { console.error('[copy-signal]', err.message); }
      try { onSmartTrade({ wallet, is_buy: 1 }, mint); } catch (err) { console.error('[strategy]', err.message); }
      // D1 (2026-05-13): tracker concentration cap. If this wallet has driven
      // ≥25% of recent entries in the last 4h, mute its trigger contribution.
      // The wallet keeps trading, we just don't evaluate JUST because they
      // bought — other triggers (A1 snapshot eval, A2 ML conviction, whale)
      // still apply if the mint is interesting on its own.
      if (!isTrackerMuted(wallet)) {
        evaluateMintNow(e.mint, 'tracked-wallet-buy').catch(() => {});
      }
    }

    // EVENT: agent copy-trade target wallet bought. Fires for ANY wallet the
    // agent has opted into via a recipe's `entry.copy_trade_wallets` field —
    // even wallets outside the top-50 leaderboard.
    if (isBuy && isCopyTradeTarget(wallet)) {
      evaluateMintNow(e.mint, `copy-trade-${wallet.slice(0, 6)}`).catch(() => {});
    }

    // EVENT: whale buy (≥3 SOL in single trade) — real conviction. Retail
    // routinely fires 0.5-1 SOL on pump.fun; 3+ SOL is whale territory.
    if (isBuy && solAmount >= 3.0) {
      evaluateMintNow(e.mint, `whale-buy-${solAmount.toFixed(2)}sol`).catch(() => {});
    }

    // A2 (Phase D, 2026-05-13): ML-conviction trade reactivity.
    // If this mint has a recent high-confidence ML prediction (refreshed every
    // 30s by ml-conviction-watcher), every trade event re-fires evaluation —
    // catches the "trade just landed AND the ML conditions are aligned" moment
    // that would otherwise be missed between 60-3600s snapshot ticks.
    // The 8s eval-debounce in evaluateMintNow keeps this from flooding on hot
    // coins.
    if (isBuy && isMlConvictionMint(e.mint)) {
      evaluateMintNow(e.mint, 'ml-conviction-trade').catch(() => {});
    }

    // EVENT: mcap crossing migration-approach zone (40-70 SOL window) — about
    // to graduate. Fire eval to catch pre-migration runners.
    const mcap = e.marketCapSol || 0;
    if (isBuy && mcap >= 40 && mcap <= 70 && (mint.peak_market_cap_sol || 0) < mcap) {
      evaluateMintNow(e.mint, `pre-migration-${mcap.toFixed(0)}sol`).catch(() => {});
    }

    try { notifyTradeForMint(e.mint); } catch (err) { console.error('[paper] trade-trigger', err.message); }
  } catch (err) {
    console.error('[processor] trade', err.message);
  }
}

function onMigrate(e) {
  try {
    const s = S();
    const now = Date.now();
    const target = e.pool || 'pumpswap';
    s.migrate.run(now, target, target, e.mint);
    const mint = s.getMint.get(e.mint);
    if (mint && mint.creator_wallet) s.bumpMigrated.run(mint.creator_wallet);
    try {
      const r = updateMigratorStatsForMint(e.mint);
      if (r.updated > 0) console.log(`[migrator-stats] ${e.mint.slice(0,8)}… migrated → updated ${r.updated}/${r.wallets} wallets`);
    } catch (err) {
      console.error('[migrator-stats] update', err.message);
    }
  } catch (err) {
    console.error('[processor] migrate', err.message);
  }
}

export function startSweeper() {
  setInterval(() => {
    try {
      const s = S();
      const rows = s.recentLive.all(Date.now() - config.sweeper.maxAgeMs, config.sweeper.maxMints);
      for (const r of rows) checkFlags(r.mint_address);
    } catch (err) {
      console.error('[sweeper]', err.message);
    }
  }, config.sweeper.intervalMs);
}
