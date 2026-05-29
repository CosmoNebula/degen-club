// Standalone debug logger — captures pump.fun TradeEvents and dumps every u64 field.
// Used to identify the correct offsets for virtual_sol_reserves / virtual_token_reserves.

import WebSocket from 'ws';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TRADE_DISC = Buffer.from('bddb7fd34ee661ee', 'hex');

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n = (n << 8n) + BigInt(bytes[i]);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (let i = 0; i < zeros; i++) out = '1' + out;
  return out;
}

let captured = 0;
const MAX_CAPTURE = 5;

const ws = new WebSocket('wss://api.mainnet-beta.solana.com');
ws.on('open', () => {
  console.log('[debug] WS open, subscribing');
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
    params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }],
  }));
});

ws.on('message', (raw) => {
  if (captured >= MAX_CAPTURE) return;
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.method !== 'logsNotification') return;
  const { logs, signature, err } = msg.params?.result?.value || {};
  if (err || !logs) return;
  for (const line of logs) {
    if (typeof line !== 'string' || !line.startsWith('Program data: ')) continue;
    const b64 = line.slice(14);
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { continue; }
    if (buf.length < 113) continue;
    if (!buf.subarray(0, 8).equals(TRADE_DISC)) continue;
    captured++;

    console.log(`\n========== TradeEvent ${captured} ==========`);
    console.log(`sig: ${signature?.slice(0, 12)}...`);
    console.log(`buf length: ${buf.length} bytes`);

    const u64At = (off) => off + 8 > buf.length ? null : Number(buf.readBigUInt64LE(off));

    // Decode known fields
    const solAmount = Number(buf.readBigUInt64LE(40)) / 1e9;
    const tokenAmount = Number(buf.readBigUInt64LE(48)) / 1e6;
    const isBuy = buf.readUInt8(56) !== 0;

    const tradeMcap = (solAmount / tokenAmount * 1e9);
    console.log(`solAmount=${solAmount} tokenAmount=${tokenAmount} isBuy=${isBuy}`);
    console.log(`TRADE-implied mcap: ${tradeMcap.toFixed(2)} SOL`);

    console.log(`\nALL U64 reads (looking for vSol ~30, vToken ~1e9 for initial; growing for active):`);
    for (const off of [97, 105, 113, 121, 129]) {
      const raw = u64At(off);
      if (raw == null) break;
      console.log(`  off=${off}: raw=${raw} /1e9=${(raw/1e9).toFixed(4)} /1e6=${(raw/1e6).toFixed(0)}`);
    }

    // Try all 4 pair combinations
    console.log(`\nMCAP candidates (assuming totalSupply=1e9):`);
    for (const offS of [97, 113]) {
      for (const offT of [105, 121]) {
        const vS = u64At(offS) / 1e9;
        const vT = u64At(offT) / 1e6;
        if (vT > 0) {
          const mcap = 1e9 * vS / vT;
          const match = Math.abs(mcap - tradeMcap) / tradeMcap < 0.05 ? '<-- MATCHES TRADE' : '';
          console.log(`  vSol@${offS}=${vS.toFixed(2)} / vToken@${offT}=${vT.toFixed(0)} -> mcap=${mcap.toFixed(2)} ${match}`);
        }
      }
    }

    if (captured >= MAX_CAPTURE) {
      ws.close();
      setTimeout(() => process.exit(0), 500);
    }
  }
});

ws.on('error', (e) => console.error('[err]', e.message));
ws.on('close', () => console.log('[debug] WS closed'));
setTimeout(() => { console.log('[timeout] exiting'); process.exit(0); }, 90000);
