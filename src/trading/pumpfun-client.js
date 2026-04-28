import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { getKeypair, getConnection } from './wallet.js';
import { config } from '../config.js';

let _sdk = null;
function sdk() {
  if (_sdk) return _sdk;
  const conn = getConnection();
  const wallet = new Wallet(getKeypair());
  const provider = new AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  _sdk = new PumpFunSDK(provider);
  return _sdk;
}

const PRIORITY_MICRO_LAMPORTS = config.photon?.priorityFeeMicroLamports || 200000;

export async function buy({ mint, solAmount, slippageBps = 1500 }) {
  const start = Date.now();
  const kp = getKeypair();
  const mintPk = new PublicKey(mint);
  const lamports = BigInt(Math.floor(solAmount * 1e9));
  try {
    const result = await sdk().buy(
      kp,
      mintPk,
      lamports,
      BigInt(slippageBps),
      { unitLimit: 250000, unitPrice: PRIORITY_MICRO_LAMPORTS },
    );
    const elapsed = Date.now() - start;
    if (!result.success) {
      return { success: false, error: result.error?.message || 'unknown', elapsedMs: elapsed };
    }
    const txSig = result.signature;
    const post = await getConnection().getParsedTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    const fill = parseTradeResult(post, mintPk, kp.publicKey, true);
    return { success: true, txSig, elapsedMs: elapsed, ...fill };
  } catch (err) {
    return { success: false, error: err.message, elapsedMs: Date.now() - start };
  }
}

export async function sell({ mint, tokenAmount, slippageBps = 1500 }) {
  const start = Date.now();
  const kp = getKeypair();
  const mintPk = new PublicKey(mint);
  const amount = BigInt(Math.floor(tokenAmount));
  try {
    const result = await sdk().sell(
      kp,
      mintPk,
      amount,
      BigInt(slippageBps),
      { unitLimit: 250000, unitPrice: PRIORITY_MICRO_LAMPORTS },
    );
    const elapsed = Date.now() - start;
    if (!result.success) {
      return { success: false, error: result.error?.message || 'unknown', elapsedMs: elapsed };
    }
    const txSig = result.signature;
    const post = await getConnection().getParsedTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    const fill = parseTradeResult(post, mintPk, kp.publicKey, false);
    return { success: true, txSig, elapsedMs: elapsed, ...fill };
  } catch (err) {
    return { success: false, error: err.message, elapsedMs: Date.now() - start };
  }
}

function parseTradeResult(parsedTx, mintPk, owner, isBuy) {
  if (!parsedTx?.meta) return { tokensReceived: 0, solSpent: 0, solReceived: 0 };
  const preBalance = parsedTx.meta.preBalances?.[0] || 0;
  const postBalance = parsedTx.meta.postBalances?.[0] || 0;
  const solDelta = (preBalance - postBalance) / 1e9;

  const preTok = parsedTx.meta.preTokenBalances || [];
  const postTok = parsedTx.meta.postTokenBalances || [];
  let tokenDelta = 0;
  for (const p of postTok) {
    if (p.mint !== mintPk.toBase58() || p.owner !== owner.toBase58()) continue;
    const before = preTok.find(b => b.accountIndex === p.accountIndex);
    const beforeAmt = before ? Number(before.uiTokenAmount?.amount || 0) : 0;
    const afterAmt = Number(p.uiTokenAmount?.amount || 0);
    tokenDelta = afterAmt - beforeAmt;
    break;
  }

  if (isBuy) {
    return { tokensReceived: tokenDelta, solSpent: solDelta };
  } else {
    return { tokensSold: -tokenDelta, solReceived: -solDelta };
  }
}
