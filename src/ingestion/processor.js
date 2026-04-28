import { db } from '../db/index.js';
import { fetchMetadata } from './metadata.js';
import { labelTrade, checkFlags } from '../scoring/flags.js';
import { checkCopySignal } from '../scoring/traders.js';
import { onSmartTrade } from '../trading/strategies.js';
import { checkPositionsForMint } from '../trading/paper.js';
import { config } from '../config.js';
import { checkCashbackFlag } from './helius.js';
import { onTrade as kingOnTrade } from '../trading/king-tracker.js';

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
       seconds_from_creation, is_sniper, is_first_block, buyer_rank, wallet_label, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateMintOnTrade: d.prepare(`UPDATE mints SET
        current_market_cap_sol = ?,
        last_price_sol = ?,
        v_sol_in_curve = ?,
        v_tokens_in_curve = ?,
        trade_count = trade_count + 1,
        last_trade_at = ?,
        peak_market_cap_sol = MAX(peak_market_cap_sol, ?)
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

function onCreate(e) {
  try {
    const s = S();
    const now = Date.now();
    const creator = e.traderPublicKey || e.creator || '';
    s.insertMint.run(
      e.mint, creator, e.signature || null, e.name || null, e.symbol || null, e.uri || null,
      e.solAmount || 0, e.vSolInBondingCurve || 0, e.vTokensInBondingCurve || 0,
      e.marketCapSol || 0, e.marketCapSol || 0, e.bondingCurveKey || null, now
    );
    if (creator) s.upsertCreator.run(creator, now, now);

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

    s.insertTrade.run(
      e.signature || null, e.mint, wallet, isBuy, solAmount, tokenAmount, priceSol,
      e.marketCapSol || 0, secondsFromCreation, isSniper, isFirstBlock, buyerRank, label, now
    );

    s.updateMintOnTrade.run(
      e.marketCapSol || 0, priceSol || 0, e.vSolInBondingCurve || 0, e.vTokensInBondingCurve || 0,
      now, e.marketCapSol || 0, e.mint
    );

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

    try { kingOnTrade({ wallet, mint: e.mint, is_buy: isBuy ? 1 : 0, sol_amount: solAmount, timestamp: now }); } catch (err) { console.error('[king-tracker]', err.message); }

    if (isBuy && label === 'SMART') {
      try { checkCopySignal(e.mint); } catch (err) { console.error('[copy-signal]', err.message); }
      try { onSmartTrade({ wallet, is_buy: 1 }, mint); } catch (err) { console.error('[strategy]', err.message); }
    }

    try { checkPositionsForMint(e.mint); } catch (err) { console.error('[paper] trade-trigger', err.message); }
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
