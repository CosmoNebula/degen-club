import { PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getKeypair, getConnection, getSolBalance, isLiveMode } from './wallet.js';
import { config } from '../config.js';
import { db } from '../db/index.js';

let _lastSkimAt = 0;
let _running = false;
let _destPk = null;

function destPubkey() {
  if (_destPk) return _destPk;
  const addr = config.skim?.destination;
  if (!addr) return null;
  try { _destPk = new PublicKey(addr); return _destPk; }
  catch (err) { console.error('[skim] invalid destination pubkey:', addr, err.message); return null; }
}

function ensureTable() {
  const d = db();
  d.exec(`CREATE TABLE IF NOT EXISTS skim_history (
    id INTEGER PRIMARY KEY,
    skimmed_at INTEGER NOT NULL,
    amount_sol REAL NOT NULL,
    balance_before REAL,
    balance_after REAL,
    destination TEXT NOT NULL,
    tx_sig TEXT,
    success INTEGER NOT NULL,
    error TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_skim_history_at ON skim_history(skimmed_at DESC)`);
}

export async function checkAndSkim(triggerSource = 'manual') {
  const cfg = config.skim || {};
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (!isLiveMode()) return { skipped: 'paper-mode' };
  if (_running) return { skipped: 'already-running' };
  const dest = destPubkey();
  if (!dest) return { skipped: 'no-destination' };
  const now = Date.now();
  if (now - _lastSkimAt < (cfg.cooldownMs || 0)) {
    return { skipped: 'cooldown', nextEligibleIn: cfg.cooldownMs - (now - _lastSkimAt) };
  }

  _running = true;
  ensureTable();
  try {
    const balance = await getSolBalance();
    if (balance < cfg.thresholdSol) {
      return { skipped: 'below-threshold', balance };
    }
    const sweep = balance - cfg.keepSol;
    if (sweep < (cfg.minSweepSol || 0.1)) {
      return { skipped: 'sweep-too-small', balance, sweep };
    }

    const conn = getConnection();
    const kp = getKeypair();
    const lamports = BigInt(Math.floor(sweep * LAMPORTS_PER_SOL));
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));
    tx.add(SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: dest,
      lamports: Number(lamports),
    }));

    const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
    _lastSkimAt = now;
    let after = null;
    try { after = await getSolBalance(); } catch {}
    db().prepare(`INSERT INTO skim_history
      (skimmed_at, amount_sol, balance_before, balance_after, destination, tx_sig, success)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(now, sweep, balance, after, dest.toBase58(), sig);
    console.log(`[skim] ✅ swept ${sweep.toFixed(4)} SOL → ${dest.toBase58().slice(0,8)}… (trigger: ${triggerSource}, tx ${sig.slice(0,8)}…)`);
    return { success: true, sweepSol: sweep, balanceBefore: balance, balanceAfter: after, txSig: sig };
  } catch (err) {
    db().prepare(`INSERT INTO skim_history
      (skimmed_at, amount_sol, balance_before, balance_after, destination, tx_sig, success, error)
      VALUES (?, 0, NULL, NULL, ?, NULL, 0, ?)`).run(now, dest.toBase58(), err.message);
    console.error('[skim] ❌ failed:', err.message);
    return { success: false, error: err.message };
  } finally {
    _running = false;
  }
}

export function getSkimStatus() {
  const cfg = config.skim || {};
  let recent = [];
  try {
    ensureTable();
    recent = db().prepare(`SELECT skimmed_at, amount_sol, balance_before, balance_after, tx_sig, success, error FROM skim_history ORDER BY skimmed_at DESC LIMIT 10`).all();
  } catch {}
  return {
    enabled: !!cfg.enabled,
    thresholdSol: cfg.thresholdSol,
    keepSol: cfg.keepSol,
    destination: cfg.destination,
    cooldownMs: cfg.cooldownMs,
    lastSkimAt: _lastSkimAt || null,
    recent,
  };
}
