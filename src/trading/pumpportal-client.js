import { VersionedTransaction } from '@solana/web3.js';
import { getKeypair, getConnection } from './wallet.js';
import { config } from '../config.js';

const PUMPPORTAL_URL = 'https://pumpportal.fun/api/trade-local';
const PRIORITY_FEE_SOL = config.friction?.priorityFeeSol || 0.0008;
const POOL = 'auto';

async function buildAndSend({ action, mint, amount, denominatedInSol, slippagePct }) {
  const start = Date.now();
  const kp = getKeypair();
  const conn = getConnection();

  let res;
  try {
    res = await fetch(PUMPPORTAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: kp.publicKey.toBase58(),
        action,
        mint,
        amount,
        denominatedInSol: denominatedInSol ? 'true' : 'false',
        slippage: slippagePct,
        priorityFee: PRIORITY_FEE_SOL,
        pool: POOL,
      }),
    });
  } catch (err) {
    return { success: false, error: `pumpportal fetch: ${err.message}`, elapsedMs: Date.now() - start };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, error: `pumpportal ${res.status}: ${text.slice(0, 240)}`, elapsedMs: Date.now() - start };
  }

  const buf = await res.arrayBuffer();
  if (!buf.byteLength) {
    return { success: false, error: 'pumpportal empty body', elapsedMs: Date.now() - start };
  }

  let tx;
  try {
    tx = VersionedTransaction.deserialize(new Uint8Array(buf));
  } catch (err) {
    return { success: false, error: `tx decode: ${err.message}`, elapsedMs: Date.now() - start };
  }
  tx.sign([kp]);

  let sig;
  try {
    sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  } catch (err) {
    const logsStr = Array.isArray(err.logs) && err.logs.length ? ` | logs: ${err.logs.slice(-6).join(' || ')}` : '';
    return { success: false, error: `send: ${err.message}${logsStr}`, elapsedMs: Date.now() - start };
  }

  const confirmTimeoutMs = 12000;
  const pollIntervalMs = 500;
  const deadline = Date.now() + confirmTimeoutMs;
  let confirmed = false;
  let txErr = null;
  while (Date.now() < deadline) {
    try {
      const statuses = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
      const st = statuses?.value?.[0];
      if (st) {
        if (st.err) { txErr = st.err; break; }
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') { confirmed = true; break; }
      }
    } catch {}
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  if (txErr) return { success: false, error: `tx err: ${JSON.stringify(txErr)}`, txSig: sig, elapsedMs: Date.now() - start };
  if (!confirmed) return { success: false, error: `confirm timeout ${confirmTimeoutMs}ms`, txSig: sig, elapsedMs: Date.now() - start };

  const fill = await parseFill(sig, mint, action === 'buy');
  return { success: true, txSig: sig, elapsedMs: Date.now() - start, ...fill };
}

async function parseFill(sig, mint, isBuy) {
  const conn = getConnection();
  const kp = getKeypair();
  try {
    const post = await conn.getParsedTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!post?.meta) return isBuy ? { tokensReceived: 0, solSpent: 0 } : { tokensSold: 0, solReceived: 0 };

    const preBalance = post.meta.preBalances?.[0] || 0;
    const postBalance = post.meta.postBalances?.[0] || 0;
    const solDelta = (preBalance - postBalance) / 1e9;

    const preTok = post.meta.preTokenBalances || [];
    const postTok = post.meta.postTokenBalances || [];
    let tokenDelta = 0;
    const owner = kp.publicKey.toBase58();
    for (const p of postTok) {
      if (p.mint !== mint || p.owner !== owner) continue;
      const before = preTok.find(b => b.accountIndex === p.accountIndex);
      const decimals = p.uiTokenAmount?.decimals ?? before?.uiTokenAmount?.decimals ?? 6;
      const scale = Math.pow(10, decimals);
      const beforeAmt = before ? Number(before.uiTokenAmount?.amount || 0) / scale : 0;
      const afterAmt = Number(p.uiTokenAmount?.amount || 0) / scale;
      tokenDelta = afterAmt - beforeAmt;
      break;
    }
    if (isBuy) return { tokensReceived: tokenDelta, solSpent: solDelta };
    return { tokensSold: -tokenDelta, solReceived: -solDelta };
  } catch (err) {
    console.error('[pumpportal] parseFill', err.message);
    return isBuy ? { tokensReceived: 0, solSpent: 0 } : { tokensSold: 0, solReceived: 0 };
  }
}

export async function buy({ mint, solAmount, slippageBps = 1500 }) {
  return buildAndSend({
    action: 'buy',
    mint,
    amount: solAmount,
    denominatedInSol: true,
    slippagePct: slippageBps / 100,
  });
}

export async function sell({ mint, pct, slippageBps = 1500 }) {
  const clamped = Math.min(100, Math.max(0, (pct || 0) * 100));
  const amount = clamped >= 100 ? '100%' : `${clamped.toFixed(2)}%`;
  return buildAndSend({
    action: 'sell',
    mint,
    amount,
    denominatedInSol: false,
    slippagePct: slippageBps / 100,
  });
}
