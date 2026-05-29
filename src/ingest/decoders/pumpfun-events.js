// pumpfun-events.js — Decode pump.fun Anchor events from `Program data: <base64>` log lines.
//
// Anchor event encoding: 8-byte sha256("event:<Name>") discriminator + struct fields.
//
// Discriminators (sha256("event:Name")[0:8]):
//   TradeEvent:    bddb7fd34ee661ee
//   CreateEvent:   1b72a94ddeeb6376
//   CompleteEvent: 5f72619cd42e9808
//
// TradeEvent layout (113 bytes total):
//   [0..8)    discriminator
//   [8..40)   mint: pubkey (32)
//   [40..48)  sol_amount: u64 lamports
//   [48..56)  token_amount: u64 (raw, 6 decimals)
//   [56..57)  is_buy: bool
//   [57..89)  user: pubkey (32)
//   [89..97)  timestamp: i64 (unix seconds)
//   [97..105) virtual_sol_reserves: u64 lamports
//   [105..113) virtual_token_reserves: u64 (raw, 6 decimals)

const TRADE_EVENT_DISC = Buffer.from('bddb7fd34ee661ee', 'hex');
const CREATE_EVENT_DISC = Buffer.from('1b72a94ddeeb6376', 'hex');
const COMPLETE_EVENT_DISC = Buffer.from('5f72619cd42e9808', 'hex');

const SOL_DECIMALS = 1e9;
const TOKEN_DECIMALS = 1e6;

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

export function decodeTradeEvent(b64) {
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return null; }
  if (buf.length < 113) return null;
  if (!buf.subarray(0, 8).equals(TRADE_EVENT_DISC)) return null;
  try {
    return {
      mint: b58encode(buf.subarray(8, 40)),
      solAmount: Number(buf.readBigUInt64LE(40)) / SOL_DECIMALS,
      tokenAmount: Number(buf.readBigUInt64LE(48)) / TOKEN_DECIMALS,
      isBuy: buf.readUInt8(56) !== 0,
      user: b58encode(buf.subarray(57, 89)),
      timestamp: Number(buf.readBigInt64LE(89)),
      vSolReserves: Number(buf.readBigUInt64LE(97)) / SOL_DECIMALS,
      vTokenReserves: Number(buf.readBigUInt64LE(105)) / TOKEN_DECIMALS,
    };
  } catch { return null; }
}

export function decodeCompleteEvent(b64) {
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return null; }
  if (buf.length < 40) return null;
  if (!buf.subarray(0, 8).equals(COMPLETE_EVENT_DISC)) return null;
  try {
    return {
      user: b58encode(buf.subarray(8, 40)),
      mint: buf.length >= 72 ? b58encode(buf.subarray(40, 72)) : null,
    };
  } catch { return null; }
}

export function isTradeData(b64) {
  if (!b64 || b64.length < 12) return false;
  let buf;
  try { buf = Buffer.from(b64.slice(0, 12), 'base64'); } catch { return false; }
  return buf.length >= 8 && buf.subarray(0, 8).equals(TRADE_EVENT_DISC);
}
