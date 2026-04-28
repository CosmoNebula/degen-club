import { db } from '../db/index.js';
import { config } from '../config.js';

export function labelTrade({ wallet, creator, isSniper }) {
  if (!wallet) return 'NORMAL';
  if (wallet === creator) return 'DEV';
  const w = db().prepare('SELECT tracked FROM wallets WHERE address = ?').get(wallet);
  if (w && w.tracked) return 'SMART';
  if (isSniper) return 'SNIPER';
  if (!w) return 'NEW';
  return 'NORMAL';
}

function addFlag(mintAddress, type, details) {
  db().prepare('INSERT INTO rug_flags (mint_address, flag_type, fired_at, details) VALUES (?, ?, ?, ?)').run(
    mintAddress, type, Date.now(), JSON.stringify(details || {})
  );
}

export function checkFlags(mintAddress) {
  const d = db();
  const mint = d.prepare('SELECT * FROM mints WHERE mint_address = ?').get(mintAddress);
  if (!mint) return;
  if (mint.migrated) return;

  const now = Date.now();
  const currentFlags = new Set(JSON.parse(mint.flags || '[]'));
  const before = [...currentFlags].sort().join(',');

  const ageMin = (now - mint.created_at) / 60000;

  const snipers = d.prepare(
    'SELECT DISTINCT wallet FROM trades WHERE mint_address = ? AND is_sniper = 1 AND is_buy = 1 ORDER BY timestamp LIMIT ?'
  ).all(mintAddress, config.flags.snipersCohortSize);

  if (snipers.length >= config.flags.bundleMinSnipersSold) {
    const sold = snipers.filter(s => {
      const h = d.prepare('SELECT tokens_bought, tokens_sold FROM wallet_holdings WHERE wallet = ? AND mint_address = ?').get(s.wallet, mintAddress);
      return h && h.tokens_bought > 0 && (h.tokens_sold / h.tokens_bought) > config.flags.snipersSoldPctThreshold;
    }).length;
    if (sold >= config.flags.bundleMinSnipersSold && !currentFlags.has('BUNDLE')) {
      addFlag(mintAddress, 'BUNDLE', { snipersSold: sold, cohort: snipers.length });
      currentFlags.add('BUNDLE');
    }
  }

  if (ageMin >= config.flags.abandonedMinutes && !currentFlags.has('ABANDONED')) {
    const lastBuy = d.prepare('SELECT timestamp FROM trades WHERE mint_address = ? AND is_buy = 1 ORDER BY timestamp DESC LIMIT 1').get(mintAddress);
    const lastBuyMin = lastBuy ? (now - lastBuy.timestamp) / 60000 : ageMin;
    if (lastBuyMin >= config.flags.abandonedMinutes) {
      addFlag(mintAddress, 'ABANDONED', { minutesSinceLastBuy: Math.round(lastBuyMin) });
      currentFlags.add('ABANDONED');
    }
  }

  if (ageMin > config.flags.devHoldingMinMinutes && !currentFlags.has('DEV_HOLDING') && mint.creator_wallet) {
    const dev = d.prepare('SELECT tokens_bought, tokens_sold FROM wallet_holdings WHERE wallet = ? AND mint_address = ?').get(mint.creator_wallet, mintAddress);
    if (dev && dev.tokens_bought > 0 && dev.tokens_sold === 0) {
      addFlag(mintAddress, 'DEV_HOLDING', { tokensHeld: dev.tokens_bought });
      currentFlags.add('DEV_HOLDING');
    }
  }

  if (!mint.rugged) {
    const peak = mint.peak_market_cap_sol || 0;
    const curr = mint.current_market_cap_sol || 0;
    const dropPct = peak > 0 ? 1 - (curr / peak) : 0;
    const lastTradeMin = mint.last_trade_at ? (now - mint.last_trade_at) / 60000 : ageMin;
    if (dropPct >= config.flags.deadDropPct && lastTradeMin >= config.flags.deadQuietMinutes && peak > 0) {
      d.prepare('UPDATE mints SET rugged = 1, rugged_at = ? WHERE mint_address = ?').run(now, mintAddress);
      if (!currentFlags.has('DEAD')) {
        addFlag(mintAddress, 'DEAD', { dropPct: +dropPct.toFixed(3), quietMin: Math.round(lastTradeMin) });
        currentFlags.add('DEAD');
      }
      const creatorWallet = mint.creator_wallet;
      if (creatorWallet) d.prepare('UPDATE creators SET rugged_count = rugged_count + 1 WHERE wallet = ?').run(creatorWallet);
    }
  }

  const after = [...currentFlags].sort().join(',');
  if (after !== before) {
    d.prepare('UPDATE mints SET flags = ? WHERE mint_address = ?').run(JSON.stringify([...currentFlags]), mintAddress);
  }
}
