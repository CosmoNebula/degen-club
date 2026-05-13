// Known non-human Solana addresses — used to filter out infrastructure
// addresses from sidewallet detection (Tier 2 #3) and any other "find
// suspicious wallets" logic that would otherwise misclassify routing
// programs, exchange hot wallets, or volume-bot infrastructure as
// fresh-wallet sidewallets.
//
// Categories:
//   - native:    Solana protocol-level programs (System, Token, etc.)
//   - dex:       AMM/aggregator programs (Raydium, Orca, Jupiter, etc.)
//   - pumpfun:   Pump.fun-specific programs/accounts
//   - cex:       Centralized exchange hot wallets (rotates — best-effort)
//   - bridge:    Cross-chain bridge contracts
//   - infra:     Other infrastructure (oracle feeds, vanity-named protocols)
//
// Format: each entry is { address, name, category, confidence }
// confidence values: 'high' (verifiable on-chain), 'medium' (well-known but may rotate),
// 'low' (heuristic — we saw it acting like infra across many unrelated creators).
//
// Add to this list over time via SQL on `known_addresses`. The startup
// seeder UPSERTs these entries but never deletes runtime-added ones.

export const KNOWN_ADDRESSES = [
  // --- native Solana programs (high confidence, verified on-chain) ---
  { address: '11111111111111111111111111111111', name: 'System Program', category: 'native', confidence: 'high' },
  { address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', name: 'SPL Token Program', category: 'native', confidence: 'high' },
  { address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', name: 'Associated Token Account Program', category: 'native', confidence: 'high' },
  { address: 'ComputeBudget111111111111111111111111111111', name: 'Compute Budget Program', category: 'native', confidence: 'high' },
  { address: 'MemoSq4gqABAxKb96qnH8TysNcWxMyWCqXgDLGmfcHr', name: 'Memo Program v2', category: 'native', confidence: 'high' },
  { address: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', name: 'Memo Program v1', category: 'native', confidence: 'high' },
  { address: 'Stake11111111111111111111111111111111111111', name: 'Stake Program', category: 'native', confidence: 'high' },
  { address: 'Vote111111111111111111111111111111111111111', name: 'Vote Program', category: 'native', confidence: 'high' },
  { address: 'BPFLoader2111111111111111111111111111111111', name: 'BPF Loader v2', category: 'native', confidence: 'high' },
  { address: 'BPFLoaderUpgradeab1e11111111111111111111111', name: 'BPF Loader Upgradeable', category: 'native', confidence: 'high' },
  { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', category: 'native', confidence: 'high' },

  // --- Pump.fun ecosystem (high confidence) ---
  { address: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', name: 'Pump.fun Bonding Curve Program', category: 'pumpfun', confidence: 'high' },
  { address: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', name: 'PumpSwap (Pump.fun AMM)', category: 'pumpfun', confidence: 'high' },

  // --- Major DEX programs (high confidence) ---
  { address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', name: 'Raydium AMM v4', category: 'dex', confidence: 'high' },
  { address: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', name: 'Raydium CLMM', category: 'dex', confidence: 'high' },
  { address: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', name: 'Raydium CPMM', category: 'dex', confidence: 'high' },
  { address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', name: 'Orca Whirlpool', category: 'dex', confidence: 'high' },
  { address: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', name: 'Orca Token Swap v1', category: 'dex', confidence: 'high' },
  { address: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', name: 'Meteora DLMM', category: 'dex', confidence: 'high' },
  { address: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', name: 'Meteora Dynamic AMM', category: 'dex', confidence: 'high' },
  { address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', name: 'Jupiter Aggregator v6', category: 'dex', confidence: 'high' },
  { address: 'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu', name: 'Jupiter Limit Order', category: 'dex', confidence: 'medium' },
  { address: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', name: 'Phoenix v1', category: 'dex', confidence: 'high' },
  { address: 'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S', name: 'Lifinity v1', category: 'dex', confidence: 'medium' },

  // --- Aggregators / routers (medium confidence — vanity-named programs) ---
  // We OBSERVED rapidXMVL across many unrelated creators with high SOL flow, so
  // it's almost certainly a router. Confirmed manually as: "Rapid Trader Bot",
  // an MEV/aggregator infrastructure. The dev wallet beneath (a literal "dev"
  // vanity prefix) appears similarly across creators — likely an infra fee wallet.
  { address: 'rapidXMVLw5uBieKHDGvF9k4xSSDXyD2FC5wLTAajaJ', name: 'Rapid Trader / Aggregator (observed)', category: 'infra', confidence: 'low' },
  { address: 'devAAvkxwyogNgy4z7R3n1ADUvJkmzy4qszDF6UiAcM', name: 'Vanity "dev" infra (observed)', category: 'infra', confidence: 'low' },
  { address: 'nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc', name: 'NextBlock MEV / submission service', category: 'infra', confidence: 'medium' },

  // --- CEX hot wallets (best-effort — these rotate; verify periodically) ---
  // Binance — primary hot wallets used for Solana withdrawals/deposits.
  { address: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', name: 'Binance Hot Wallet 1', category: 'cex', confidence: 'medium' },
  { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', name: 'Binance Hot Wallet 2', category: 'cex', confidence: 'medium' },
  { address: '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S', name: 'Binance Hot Wallet 3', category: 'cex', confidence: 'medium' },
  // Coinbase
  { address: 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', name: 'Coinbase Hot Wallet 1', category: 'cex', confidence: 'medium' },
  { address: 'FpwQQhQQoEaVu3WU2qZMfF1hx48YyfwsLoRgXG83E99T', name: 'Coinbase Hot Wallet 2', category: 'cex', confidence: 'medium' },
  { address: 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', name: 'Coinbase Hot Wallet 3', category: 'cex', confidence: 'medium' },
  // Kraken / OKX / Kucoin / Bitget / Bybit
  { address: 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', name: 'Kraken Hot Wallet', category: 'cex', confidence: 'medium' },
  { address: '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD', name: 'OKX Hot Wallet', category: 'cex', confidence: 'medium' },
  { address: 'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6', name: 'KuCoin Hot Wallet', category: 'cex', confidence: 'medium' },
  { address: 'A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR', name: 'Bitget Hot Wallet', category: 'cex', confidence: 'medium' },
  { address: 'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', name: 'Bybit Hot Wallet', category: 'cex', confidence: 'medium' },
  { address: 'u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w', name: 'Gate.io Hot Wallet', category: 'cex', confidence: 'medium' },
  { address: 'D89hHJT5Aqyx1trP6EnGY9jJUB3whgnq3aUvvCTW1LjI', name: 'Crypto.com Hot Wallet', category: 'cex', confidence: 'medium' },

  // --- Bridges (medium confidence) ---
  { address: 'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb', name: 'Wormhole Core Bridge', category: 'bridge', confidence: 'medium' },
  { address: 'BrEAK7zGZ6dM71zUDACDbJnBn1XBQXi5JmtKPVZMVfXf', name: 'deBridge Gate', category: 'bridge', confidence: 'medium' },
  { address: 'bb1XfNoLAYBgBHnGiPaEhgJHFqj9MmoCwM5sLArn4dT', name: 'Allbridge', category: 'bridge', confidence: 'low' },
];

// Build a fast lookup set
let _addressSet = null;
export function getKnownAddressSet() {
  if (_addressSet) return _addressSet;
  _addressSet = new Set(KNOWN_ADDRESSES.map(a => a.address));
  return _addressSet;
}

export function isKnownNonHumanAddress(addr) {
  return getKnownAddressSet().has(addr);
}

// Seed the runtime DB table on startup. Idempotent. Caller-supplied db handle.
export function seedKnownAddressesTable(d) {
  const ins = d.prepare(`INSERT OR REPLACE INTO known_addresses
    (address, name, category, confidence, source) VALUES (?,?,?,?,?)`);
  const tx = d.transaction((rows) => {
    for (const r of rows) ins.run(r.address, r.name, r.category, r.confidence, 'seed');
  });
  tx(KNOWN_ADDRESSES);
}
