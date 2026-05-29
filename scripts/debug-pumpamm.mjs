// Capture several BuyEvent/SellEvent samples from PumpAMM and dump u64
// offsets so we can identify the price-relevant fields.
import WebSocket from 'ws';
const PUMPAMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const BUY_DISC = '67f4521f2cf57777';
const SELL_DISC = '3e2f370aa503dc2a';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n = (n << 8n) + BigInt(bytes[i]);
  let out = ''; while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (let i = 0; i < zeros; i++) out = '1' + out;
  return out;
}

let count = 0;
const ws = new WebSocket(process.env.HELIUS_WS_URL || 'wss://api.mainnet-beta.solana.com');
ws.on('open', () => {
  console.log('WS open, subscribing to', PUMPAMM);
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
    params: [{ mentions: [PUMPAMM] }, { commitment: 'confirmed' }],
  }));
});

ws.on('message', (raw) => {
  if (count >= 4) return;
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.method !== 'logsNotification') return;
  const { logs, signature, err } = msg.params?.result?.value || {};
  if (err || !logs) return;
  for (const line of logs) {
    if (!line || !line.startsWith('Program data: ')) continue;
    const b64 = line.slice(14);
    let buf; try { buf = Buffer.from(b64, 'base64'); } catch { continue; }
    if (buf.length < 16) continue;
    const disc = buf.subarray(0, 8).toString('hex');
    const kind = disc === BUY_DISC ? 'BUY' : (disc === SELL_DISC ? 'SELL' : null);
    if (!kind) continue;
    count++;
    console.log(`\n===== ${kind} #${count} · disc=${disc} · len=${buf.length} · sig=${signature?.slice(0,12)} =====`);
    // Dump all u64 (offset, value/1e9, value/1e6) — only meaningful ones
    console.log('u64 reads (small + medium values; pubkey bytes look like huge numbers):');
    for (let off = 8; off + 8 <= Math.min(buf.length, 250); off += 8) {
      const v = Number(buf.readBigUInt64LE(off));
      if (v === 0) { console.log(`  @${off}: 0`); continue; }
      // pubkeys produce huge nonsense numbers when read as u64; filter to plausible amounts
      if (v < 1e18) {
        const sol = v / 1e9, tok = v / 1e6;
        let interp = `raw=${v}`;
        if (v > 1000 && v < 1e15) interp = `raw=${v} sol≈${sol.toFixed(4)} tok≈${tok.toFixed(0)}`;
        if (v < 100) interp = `raw=${v}`;
        console.log(`  @${off}: ${interp}`);
      }
    }
    // Pubkeys: try every 32-byte offset
    console.log('pubkeys at likely offsets:');
    for (const off of [8, 40, 72, 104, 136, 168, 200, 232]) {
      if (off + 32 > buf.length) break;
      const pk = b58encode(buf.subarray(off, off + 32));
      // skip if all zeros
      if (pk.length > 0) console.log(`  pk@${off}: ${pk}`);
    }
    if (count >= 4) { ws.close(); setTimeout(() => process.exit(0), 500); return; }
  }
});
ws.on('close', () => console.log('WS closed'));
setTimeout(() => { console.log('timeout'); process.exit(0); }, 90000);
