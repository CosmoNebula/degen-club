// Held mint cache — fast in-memory Set of mint addresses we currently hold
// open paper positions on. Used by non-Helius price writers to skip updates
// for held mints (so mints.last_price_sol stays driven by Helius sources only
// while we have a position open).
//
// Rationale: when we hold a coin, Helius provides the cleanest data path —
//   - onchain-curve: real-time BC decode via Helius WSS (pre-migration)
//   - helius-tx: webhook event for every trade on the mint (post-migration,
//     since we subscribe held mints to the webhook in helius-webhooks.js)
// Letting pumpportal or dexscreener also write the price introduces source-
// switching noise; each writer can briefly disagree with the others and the
// position monitor sees a flickering "current price". Locking writes to
// Helius-only sources keeps the price feed coherent for trail/SL decisions.
//
// Cache is seeded from DB on first call and refreshed on position open/close.

import { db } from '../db/index.js';

let _held = null;  // Set<mint_address> — null = not seeded yet

function loadFromDb() {
  const rows = db().prepare(
    `SELECT DISTINCT mint_address FROM paper_positions WHERE status = 'open'`
  ).all();
  _held = new Set(rows.map(r => r.mint_address));
}

export function isMintHeld(mintAddress) {
  if (_held == null) loadFromDb();
  return _held.has(mintAddress);
}

export function addHeldMint(mintAddress) {
  if (_held == null) loadFromDb();
  _held.add(mintAddress);
}

export function removeHeldMint(mintAddress) {
  if (_held == null) loadFromDb();
  _held.delete(mintAddress);
}

// Full reload — call after bulk position changes or to recover from drift.
export function refreshHeldMints() {
  loadFromDb();
}

export function heldMintCount() {
  if (_held == null) loadFromDb();
  return _held.size;
}
