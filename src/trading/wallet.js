import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config.js';
import { db } from '../db/index.js';

const decodeBase58 = bs58.decode || bs58.default?.decode;

let _keypair = null;
let _connection = null;
let _mode = (process.env.MODE || 'paper').toLowerCase();
let _liveStartedAt = null;
let _liveStartingSol = null;
let _livePeakBalance = null;
let _livePeakAt = null;

export function getMode() { return _mode; }
export function getLiveSession() {
  return {
    mode: _mode,
    startedAt: _liveStartedAt,
    startingSol: _liveStartingSol,
    peakBalance: _livePeakBalance,
    peakAt: _livePeakAt,
  };
}
export function recordLiveBalance(bal) {
  if (bal == null || _mode !== 'live') return;
  if (_livePeakBalance == null || bal > _livePeakBalance) {
    _livePeakBalance = bal;
    _livePeakAt = Date.now();
  }
}
export async function setMode(newMode) {
  const m = String(newMode || '').toLowerCase();
  if (m !== 'live' && m !== 'paper') throw new Error(`invalid mode: ${newMode}`);
  if (m === _mode) return { mode: _mode, changed: false };
  if (m === 'live') {
    let bal = null;
    try { bal = await getSolBalance(); } catch {}
    _liveStartingSol = bal;
    _liveStartedAt = Date.now();
    _livePeakBalance = bal;
    _livePeakAt = bal != null ? Date.now() : null;
  } else {
    _liveStartedAt = null;
    _liveStartingSol = null;
    _livePeakBalance = null;
    _livePeakAt = null;
  }
  _mode = m;
  console.log(`[LIVE-TRADING] ${_mode === 'live' ? 'ENABLED' : 'DISABLED'}${_liveStartingSol != null ? ` · wallet balance ${_liveStartingSol.toFixed(4)} SOL` : ''}`);
  return { mode: _mode, changed: true, startedAt: _liveStartedAt, startingSol: _liveStartingSol, closedPaper: 0 };
}

function closeAllOpenPaperPositions(reason) {
  const d = db();
  const open = d.prepare("SELECT id, strategy, unrealized_pnl_sol, unrealized_pnl_pct FROM paper_positions WHERE status = 'open' AND (position_mode IS NULL OR position_mode = 'paper')").all();
  if (!open.length) return 0;
  const now = Date.now();
  const close = d.prepare(`UPDATE paper_positions SET status = 'closed', exit_reason = ?, exited_at = ?, updated_at = ?, realized_pnl_sol = ?, realized_pnl_pct = ? WHERE id = ?`);
  const bumpWin = d.prepare('UPDATE strategy_state SET wins = wins + 1, total_pnl_sol = total_pnl_sol + ? WHERE name = ?');
  const bumpLoss = d.prepare('UPDATE strategy_state SET losses = losses + 1, total_pnl_sol = total_pnl_sol + ? WHERE name = ?');
  const bumpFlat = d.prepare('UPDATE strategy_state SET total_pnl_sol = total_pnl_sol + ? WHERE name = ?');
  let n = 0;
  for (const p of open) {
    const pnl = p.unrealized_pnl_sol || 0;
    const pct = p.unrealized_pnl_pct || 0;
    close.run(reason, now, now, pnl, pct, p.id);
    if (pnl > 0) bumpWin.run(pnl, p.strategy);
    else if (pnl < 0) bumpLoss.run(pnl, p.strategy);
    else bumpFlat.run(pnl, p.strategy);
    n++;
  }
  console.log(`[paper] CLOSE-ALL ${reason}: ${n} positions flushed at last mark`);
  return n;
}

export function getKeypair() {
  if (_keypair) return _keypair;
  const sk = process.env.DEGEN_PRIVATE_KEY;
  if (!sk) throw new Error('DEGEN_PRIVATE_KEY not set in environment');
  try {
    _keypair = Keypair.fromSecretKey(decodeBase58(sk));
  } catch (err) {
    throw new Error(`Failed to decode private key: ${err.message}`);
  }
  return _keypair;
}

export function getPublicKey() {
  return getKeypair().publicKey;
}

export function getConnection() {
  if (_connection) return _connection;
  const rpcUrl = config.heliusApiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`
    : 'https://api.mainnet-beta.solana.com';
  _connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  return _connection;
}

let _publicConnection = null;
function getPublicConnection() {
  if (_publicConnection) return _publicConnection;
  const url = process.env.PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';
  _publicConnection = new Connection(url, { commitment: 'confirmed' });
  return _publicConnection;
}

export async function getSolBalance() {
  const pk = getPublicKey();
  try {
    const lamports = await getPublicConnection().getBalance(pk, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  } catch (errPublic) {
    try {
      const lamports = await getConnection().getBalance(pk, 'confirmed');
      return lamports / LAMPORTS_PER_SOL;
    } catch (errHelius) {
      console.error('[wallet] getSolBalance failed on public + helius:', errPublic.message, '/', errHelius.message);
      throw errHelius;
    }
  }
}

export async function getTokenBalance(mintAddress) {
  const conn = getConnection();
  const pk = getPublicKey();
  try {
    const accounts = await conn.getParsedTokenAccountsByOwner(pk, {
      mint: new PublicKey(mintAddress),
    });
    if (!accounts.value.length) return 0;
    return Number(accounts.value[0].account.data.parsed.info.tokenAmount.amount);
  } catch (err) {
    console.error('[wallet] getTokenBalance', err.message);
    return 0;
  }
}

export function isLiveMode() {
  return _mode === 'live';
}
