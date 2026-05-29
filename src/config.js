// config.js — constants + env loading
import 'dotenv/config';

export const config = {
  // Pumpportal free WS endpoint (new-token + migration only — no api-key needed)
  pumpportalWs: 'wss://pumpportal.fun/api/data',
  // Public Solana RPC WS endpoint (free, accountSubscribe notifications are free)
  solanaRpcWs: process.env.SOLANA_RPC_WS || 'wss://api.mainnet-beta.solana.com',
  // Helius WS for accountSubscribe on held positions. Standard WS methods
  // (accountSubscribe/logsSubscribe) are FREE on Helius — only enhanced
  // transactionSubscribe costs credits. Way more reliable than public
  // mainnet-beta which gave us 10 subs with ZERO notifications.
  heliusWs: process.env.HELIUS_WS_URL || '',
  // ML service (local Python FastAPI)
  mlServiceUrl: process.env.ML_SERVICE_URL || 'http://127.0.0.1:5050',
  // Pump.fun program ID (for PDA derivation, account decoding)
  pumpProgram: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  // Helius reserved for FUTURE live trading via Sender — NOT used in paper
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  // Position sizing + safety limits
  paper: {
    minTradeSol: 0.001,
    maxOpenPositions: 25,
    maxOpenExposureSol: 2.0,
    entrySizeBase: 0.10,
    entrySizeMax: 0.20,
    reentryCooldownMs: 10 * 60 * 1000,
  },
  // Policy decision loop
  policy: {
    tickMs: 5000,
    entryScoreThreshold: 0.10,
    holdScoreFloor: -0.15,
  },
  // Stables/established tokens we ignore
  skipMints: new Set([
    'EPjFWdd5AufqSSqeM2qNT1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'So11111111111111111111111111111111111111112',  // wSOL
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  ]),
  dashboardPort: process.env.DASHBOARD_PORT ? parseInt(process.env.DASHBOARD_PORT) : 3000,
};
