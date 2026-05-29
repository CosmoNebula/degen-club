// pumpfun.js — Decode pump.fun bonding curve account state.
//
// Account layout (49 bytes):
//   bytes 0-7:   8-byte discriminator (Anchor)
//   bytes 8-15:  u64 virtual_token_reserves (LE)
//   bytes 16-23: u64 virtual_sol_reserves (LE)
//   bytes 24-31: u64 real_token_reserves (LE)
//   bytes 32-39: u64 real_sol_reserves (LE)
//   bytes 40-47: u64 token_total_supply (LE)
//   byte 48:     u8 complete (bool 0/1)
//
// Pump.fun tokens have 6 decimals. SOL has 9 decimals (lamports).
// price (SOL per token) = (vSol/1e9) / (vTokens/1e6) = vSol*1e-3 / vTokens

const SOL_DECIMALS = 9;
const TOKEN_DECIMALS = 6;

export function decodeBondingCurve(base64Data) {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < 49) return null;
    // Skip 8-byte discriminator
    const vTokenRaw = buf.readBigUInt64LE(8);
    const vSolRaw = buf.readBigUInt64LE(16);
    const rTokenRaw = buf.readBigUInt64LE(24);
    const rSolRaw = buf.readBigUInt64LE(32);
    const totalSupplyRaw = buf.readBigUInt64LE(40);
    const complete = buf.readUInt8(48) !== 0;

    const vSol = Number(vSolRaw) / 10 ** SOL_DECIMALS;
    const vTokens = Number(vTokenRaw) / 10 ** TOKEN_DECIMALS;
    const rSol = Number(rSolRaw) / 10 ** SOL_DECIMALS;
    const rTokens = Number(rTokenRaw) / 10 ** TOKEN_DECIMALS;
    const totalSupply = Number(totalSupplyRaw) / 10 ** TOKEN_DECIMALS;

    const priceSol = (vSol > 0 && vTokens > 0) ? vSol / vTokens : 0;
    // Marketcap (in SOL) = total supply × price
    const mcapSol = totalSupply * priceSol;

    return { vSol, vTokens, rSol, rTokens, totalSupply, priceSol, mcapSol, complete };
  } catch (err) {
    return null;
  }
}
