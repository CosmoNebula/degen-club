import { db } from '../db/index.js';
import { config } from '../config.js';
import { isLiveMode, getSolBalance } from './wallet.js';

let _liveBalCache = null;
let _liveBalAt = 0;
let _liveBalRefreshing = false;
const LIVE_BAL_TTL_MS = 20 * 1000;

function refreshLiveBalanceIfStale() {
  if (_liveBalRefreshing) return;
  if (Date.now() - _liveBalAt < LIVE_BAL_TTL_MS && _liveBalCache != null) return;
  _liveBalRefreshing = true;
  getSolBalance()
    .then(bal => { _liveBalCache = bal; _liveBalAt = Date.now(); })
    .catch(() => {})
    .finally(() => { _liveBalRefreshing = false; });
}

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    wallet: d.prepare('SELECT * FROM paper_wallet WHERE id = 1'),
    closedPnl: d.prepare(`
      SELECT COALESCE(SUM(realized_pnl_sol), 0) AS pnl
      FROM paper_positions WHERE status='closed' AND entered_at >= ?
    `),
    openPositions: d.prepare(`
      SELECT COALESCE(SUM(pp.entry_sol - pp.sol_realized_so_far), 0) AS locked,
             COALESCE(SUM(pp.tokens_remaining * COALESCE(m.last_price_sol, pp.entry_price)), 0) AS mtm
      FROM paper_positions pp
      LEFT JOIN mints m ON m.mint_address = pp.mint_address
      WHERE pp.status='open' AND pp.entered_at >= ?
    `),
  };
  return stmts;
}

export function getWalletValue() {
  try {
    if (isLiveMode()) {
      refreshLiveBalanceIfStale();
      if (_liveBalCache != null) {
        return Math.max(0.05, _liveBalCache);
      }
      // Fallback while cache warms — use conservative startingBalance (no boost)
      return config.dynamicSizing?.startingBalance || 1.0;
    }
    const s = S();
    const w = s.wallet.get();
    if (!w) return 1.0;
    const closed = s.closedPnl.get(w.started_at).pnl || 0;
    const open = s.openPositions.get(w.started_at);
    const cash = (w.starting_balance_sol || 1.0) + closed - (open.locked || 0);
    return Math.max(0.05, cash + (open.mtm || 0));
  } catch (err) {
    return 1.0;
  }
}

export function getDynamicFactor(walletValue) {
  const cfg = config.dynamicSizing || {};
  if (!cfg.enabled) return 1.0;
  const start = cfg.startingBalance || 1.0;
  const ratio = walletValue / start;
  let raw;
  if (cfg.curve === 'linear') raw = ratio;
  else raw = Math.sqrt(Math.max(0.01, ratio));
  return Math.max(cfg.minFactor || 0.5, Math.min(cfg.maxFactor || 3.0, raw));
}

export function applyDynamicSizing(baseEntry, scoreMultiplier = 1.0) {
  const cfg = config.dynamicSizing || {};
  if (!cfg.enabled) {
    return Math.max(cfg.minEntrySol || 0.02, baseEntry * scoreMultiplier);
  }
  const wv = getWalletValue();
  const wf = getDynamicFactor(wv);
  const raw = baseEntry * wf * scoreMultiplier;
  const minE = cfg.minEntrySol || 0.02;
  const maxE = cfg.maxEntrySol || 1.5;
  return {
    sol: Math.max(minE, Math.min(maxE, raw)),
    walletValue: wv,
    walletFactor: wf,
    raw,
    scoreMultiplier,
  };
}
