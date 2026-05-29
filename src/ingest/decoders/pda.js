// ingest/decoders/pda.js — Solana ProgramDerivedAddress (PDA) derivation
// without depending on @solana/web3.js. Implements just enough of the algorithm
// to find the canonical bonding-curve PDA for pump.fun mints.
//
// Algorithm (per Solana docs):
//   For bump in [255..0]:
//     hash = sha256(seed1 || seed2 || ... || [bump] || program_id || "ProgramDerivedAddress")
//     if hash is NOT a valid ed25519 curve point: return [hash, bump]
//
// Off-curve check: a 32-byte value is "off curve" if it cannot be decoded as a
// valid ed25519 point. We use the simplified check that Solana SDKs use: the
// curve-decompress operation succeeds or fails. We approximate with the
// well-known fact that NaCl's PointDecompress rejects values where the high
// bit of byte 31 is set above a certain threshold AND the y-coordinate isn't
// on the curve. Rather than reimplement ed25519, we use a Node-native trick:
// most random 32-byte sha256 outputs (~50%) ARE off-curve, and we can test
// via a deterministic check using sha512 + curve math. But to keep this dep-
// free, we use the documented Solana technique: just sha256 with bump prefix,
// then check if the resulting point is on the curve via a known formula.
//
// SIMPLIFIED: in practice for pump.fun BC PDA, the canonical bump is one of
// the first few we try. We'll iterate and return on first off-curve hit.
//
// For the off-curve test, we use Solana's actual approach: tweetnacl's
// scalarbase + GE_FromBytes_Vartime check. Since we don't have nacl, we
// implement just the curve-validity check inline.

import crypto from 'node:crypto';

const PDA_MARKER = Buffer.from('ProgramDerivedAddress', 'utf8');

// ed25519 prime: 2^255 - 19
const P = (1n << 255n) - 19n;
// ed25519 curve parameter d = -121665/121666 mod p
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function isOnCurve(pointBytes) {
  // Decompress y-coordinate from 32 bytes. Bit 255 = x sign.
  if (pointBytes.length !== 32) return false;
  // Copy + clear sign bit
  const ybytes = Buffer.from(pointBytes);
  const signBit = (ybytes[31] >> 7) & 1;
  ybytes[31] &= 0x7f;
  // y as little-endian bigint
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(ybytes[i]);
  if (y >= P) return false;
  // Solve x^2 = (y^2 - 1) / (d*y^2 + 1) mod p
  const y2 = (y * y) % P;
  const num = (y2 - 1n + P) % P;
  const den = (D * y2 + 1n) % P;
  // x^2 = num * den^-1
  const denInv = modPow(den, P - 2n, P);
  const x2 = (num * denInv) % P;
  // Check if x2 is a quadratic residue: x = x2 ^ ((p+3)/8) candidate
  const x = modPow(x2, (P + 3n) / 8n, P);
  const xSquared = (x * x) % P;
  if (xSquared === x2) return true;
  // Try i*x where i = 2^((p-1)/4)
  const I = modPow(2n, (P - 1n) / 4n, P);
  const xi = (x * I) % P;
  const xiSquared = (xi * xi) % P;
  return xiSquared === x2;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let n = 0n;
  for (let i = 0; i < buf.length; i++) n = (n << 8n) + BigInt(buf[i]);
  let out = '';
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (let i = 0; i < zeros; i++) out = '1' + out;
  return out;
}
function b58decode(s) {
  let n = 0n;
  for (let i = 0; i < s.length; i++) {
    const idx = BASE58.indexOf(s[i]);
    if (idx < 0) throw new Error('bad base58 char');
    n = n * 58n + BigInt(idx);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  // Leading '1's = leading zero bytes
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.unshift(0);
  return Buffer.from(bytes);
}

/**
 * Find the program-derived address for given seeds + program.
 * Iterates bump 255 → 0, returns the first off-curve hash.
 *   seeds: Buffer[]
 *   programIdBase58: string
 * Returns: { address: base58 string, bump: number }
 */
export function findProgramAddress(seeds, programIdBase58) {
  const programId = b58decode(programIdBase58);
  if (programId.length !== 32) throw new Error('program id must be 32 bytes');
  for (let bump = 255; bump >= 0; bump--) {
    const hash = crypto.createHash('sha256');
    for (const seed of seeds) hash.update(seed);
    hash.update(Buffer.from([bump]));
    hash.update(programId);
    hash.update(PDA_MARKER);
    const digest = hash.digest();
    if (!isOnCurve(digest)) {
      return { address: b58encode(digest), bump };
    }
  }
  throw new Error('PDA not found');
}

/**
 * pump.fun bonding-curve PDA for a given mint.
 * Seed: ["bonding-curve", mint_pubkey_bytes]
 */
export function pumpfunBondingCurvePda(mintBase58, pumpProgramBase58) {
  const seed1 = Buffer.from('bonding-curve', 'utf8');
  const mintBytes = b58decode(mintBase58);
  if (mintBytes.length !== 32) throw new Error('mint must be 32 bytes');
  return findProgramAddress([seed1, mintBytes], pumpProgramBase58);
}
