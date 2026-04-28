import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const config = {
  root: ROOT,
  port: parseInt(process.env.PORT || '4200', 10),
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  dbPath: path.join(ROOT, 'data', 'degen.db'),
  publicDir: path.join(ROOT, 'public'),

  pumpPortal: {
    url: 'wss://pumpportal.fun/api/data',
    reconnectMinMs: 1000,
    reconnectMaxMs: 30000,
  },

  ipfs: {
    gateways: [
      'https://pump.mypinata.cloud/ipfs/',
      'https://ipfs.io/ipfs/',
      'https://cloudflare-ipfs.com/ipfs/',
      'https://gateway.pinata.cloud/ipfs/',
      'https://cf-ipfs.com/ipfs/',
    ],
    timeoutMs: 3500,
  },

  sniper: {
    secondsWindow: 3,
    firstNBuyers: 10,
    firstBlockMaxSeconds: 1,
    firstBlockMaxRank: 2,
  },

  flags: {
    abandonedMinutes: 30,
    deadDropPct: 0.85,
    deadQuietMinutes: 10,
    bundleMinSnipersSold: 5,
    snipersCohortSize: 10,
    snipersSoldPctThreshold: 0.5,
    devHoldingMinMinutes: 5,
  },

  sweeper: {
    intervalMs: 30000,
    maxAgeMs: 4 * 60 * 60 * 1000,
    maxMints: 500,
  },

  traders: {
    recomputeIntervalMs: 120000,
    minClosedPositions: 20,
    minRealizedPnlSol: 5,
    minWinRate: 0.60,
    maxSniperRatio: 0.4,
    minGraduatedTouched: 1,
    fullExitPctThreshold: 0.99,
    rollingDays: 30,
    kol: {
      minClosed30d: 30,
      minRealizedPnl30d: 10,
      minWinRate30d: 0.60,
      minGraduatedTouched: 0,
      maxSniperRatio: 0.30,
      sizingBoost: 1.5,
    },
  },

  bot: {
    scalperTradesPerPosition: 6,
    scalperMinTrades: 20,
    snipeHeavyMinRatio: 0.6,
    snipeHeavyMinBuys: 10,
    fastHandsMaxHoldSec: 20,
    fastHandsMinClosed: 5,
    perfectWrMinClosed: 8,
    perfectWrThreshold: 0.95,
    humanMinClosed: 5,
    humanMinAvgHoldSec: 90,
    humanMaxTradesPerPosition: 4,
    humanMaxSniperRatio: 0.3,
    humanMaxWinRate: 0.85,
    humanMinWinRate: 0.2,
    copyFriendlyMinHoldSec: 60,
    sell100PctMaxSec: 120,
  },

  bundle: {
    intervalMs: 5 * 60 * 1000,
    cohortMaxSeconds: 2,
    cohortMinSize: 2,
    cohortMaxSize: 30,
    minCoincidences: 3,
    minClusterSize: 3,
    maxAgeMs: 24 * 60 * 60 * 1000,
    maxMintsPerSweep: 2000,
  },

  copySignal: {
    windowSeconds: 60,
    minTrackedWallets: 2,
    dedupeMinutes: 5,
    maxMintAgeMinutes: 5,
    minBuyerRank: 3,
  },

  cluster: {
    windowSeconds: 10,
    minWallets: 3,
  },

  healthyMomentum: {
    sweepIntervalMs: 20000,
    minMintAgeMin: 2,
    maxMintAgeMin: 12,
    minCurveProgress: 0.18,
    maxCurveProgress: 0.50,
    minUniqueBuyers: 15,
    minBuyersLast60s: 6,
    minBuyersLast120s: 12,
    sustainRatio: 1.0,
    maxBundlePct: 0.50,
    maxWhalePct: 0.45,
    maxSniperFrac: 0.30,
    maxFiresPerSweep: 3,
    cooldownMinutes: 30,
  },

volumeSurge: {
    sweepIntervalMs: 15000,
    currentWindowSec: 60,
    baselineWindowSec: 300,
    minVelocityRatio: 5,
    minBuysPerMin: 12,
    minUniqueBuyers: 8,
    minPriceChange: 0,
    maxPriceChangeAtFire: 0.15,
    maxCurveProgress: 0.7,
    cooldownMinutes: 10,
    skipFlags: ['BUNDLE', 'ABANDONED', 'DEAD'],
    minBaselineBuysPerMin: 0.5,
    confluenceLookbackSec: 60,
    maxMintAgeMinutes: 30,
    sizing: {
      baseEntrySol: 0.05,
      minEntrySol: 0.025,
      maxEntrySol: 0.125,
      maxVelocityRatioForScore: 20,
      maxBuyerCountForScore: 10,
      priceMomentumBonus: 1.2,
      priceMomentumThreshold: 0.10,
      confluenceBonus: 1.5,
    },
  },

  maintenance: {
    intervalMs: 30 * 60 * 1000,
    ruggedRetentionHours: 12,
    quietRetentionMinutes: 60,
    startupDelayMs: 60 * 1000,
  },

  moonbag: {
    enabled: true,
    sellPctAtMigration: 0.75,
    hardTargetPct: 5.0,
    trailPct: 0.50,
    hardSlPct: -0.60,
    maxHoldHours: 48,
    pricePollIntervalMs: 10000,
    armTrailAtPct: 0.20,
  },

  dexscreener: {
    apiBase: 'https://api.dexscreener.com',
    timeoutMs: 8000,
    pollIntervalMs: 10000,
  },

  friction: {
    feePct: 0.01,
    slippagePct: 0.025,
    priorityFeeSol: 0.0008,
  },

  dynamicSizing: {
    enabled: true,
    startingBalance: 2.0,
    curve: 'sqrt',
    minFactor: 0.5,
    maxFactor: 3.0,
    minEntrySol: 0.09,
    maxEntrySol: 1.5,
  },

  safety: {
    maxPerTradeSol: 0.25,
    dailyMaxLossSol: 0.5,
    minWalletSolFloor: 0.05,
    maxEntrySlippagePct: 0.17,
  },

  paper: {
    latencyMs: 0,
  },

  skim: {
    enabled: true,
    thresholdSol: 5.0,
    keepSol: 2.0,
    minSweepSol: 0.5,
    cooldownMs: 30 * 60 * 1000,
    destination: process.env.MAIN_WALLET_PUBKEY || 'BG7kSq4XJUCv2NffuPqz94NC1pERTiHAdVGd9RNNVwgG',
  },

  photon: {
    apiBase: 'https://photon-sol.tinyastro.io/api',
    apiKey: process.env.PHOTON_API_KEY || '',
    apiSecret: process.env.PHOTON_API_SECRET || '',
    slippageBps: 1500,
    priorityFeeMicroLamports: 200000,
  },

  strategies: {
    monitorIntervalMs: 250,
    trackedWalletFollow: {
      label: 'B · Early Mover',
      description: 'Backloaded 4-tier ladder · let signal-rich entries breathe · tight 25% post-T1 trail · time-kill on flatliners',
      trigger: 'smart_trade',
      cashbackTriggerBoost: 1.5,
      defaults: {
        enabled: 1, entry_sol: 0.13, sl_pct: -0.35, max_hold_min: 60,
        tier1_trigger_pct: 0.50, tier1_sell_pct: 0.25,
        tier2_trigger_pct: 1.50, tier2_sell_pct: 0.25,
        tier3_trigger_pct: 3.00, tier3_sell_pct: 0.25, tier3_trail_pct: 0.40,
        breakeven_after_tier1: 1,
        breakeven_arm_pct: 0.50,
        breakeven_floor_pct: -0.10,
        tp_trail_pct: 0.30,
        tp_trail_arm_pct: 0.50,
        fast_fail_min_peak_pct: 0.05,
        flat_exit_min: 12, flat_exit_max_peak_pct: 0.20, flat_exit_band_pct: 0.10,
        stagnant_exit_min: 5, stagnant_loss_pct: -0.15,
        peak_floor_arm_pct: 0.10, peak_floor_exit_pct: 0.10,
        peak_floor_arm2_pct: 0.20, peak_floor_exit2_pct: 0.20,
        peak_floor_arm3_pct: 0.30, peak_floor_exit3_pct: 0.30,
      },
    },
    healthyMomentum: {
      label: 'Healthy Momentum · Grind-to-Migration',
      description: 'Organic accelerating coins · 30+ buyers · no whale dominance · patient ride to migration',
      trigger: 'healthy_momentum',
      defaults: {
        enabled: 1, entry_sol: 0.10, sl_pct: -0.35, max_hold_min: 90,
        tier1_trigger_pct: 0.75, tier1_sell_pct: 0.25,
        tier2_trigger_pct: 99.0, tier2_sell_pct: 0,
        tier3_trigger_pct: 99.0, tier3_sell_pct: 0, tier3_trail_pct: 0,
        breakeven_after_tier1: 1,
        breakeven_arm_pct: 0.75,
        tp_trail_pct: 0.70,
        tp_trail_arm_pct: 1.00,
        fast_fail_min_peak_pct: 0.05,
        stagnant_exit_min: 8, stagnant_loss_pct: -0.15,
      },
    },
    quickFlip15: {
      label: 'Q · Quick Flip +20%',
      description: 'KOL or BOT<70mc smart_trade entries · MC<100 ceiling · sells 100% at +20% · no tiers, no trailing, no breakeven',
      trigger: 'smart_trade',
      defaults: {
        enabled: 1, entry_sol: 0.13, sl_pct: -0.10, max_hold_min: 30,
        tier1_trigger_pct: 0.20, tier1_sell_pct: 1.0,
        peak_floor_arm_pct: 0.10, peak_floor_exit_pct: 0.10,
        peak_floor_arm2_pct: 0.20, peak_floor_exit2_pct: 0.20,
        peak_floor_arm3_pct: 0.30, peak_floor_exit3_pct: 0.30,
        tier2_trigger_pct: 99.0, tier2_sell_pct: 0,
        tier3_trigger_pct: 99.0, tier3_sell_pct: 0, tier3_trail_pct: 0,
        breakeven_after_tier1: 0,
        breakeven_arm_pct: 0, breakeven_floor_pct: 0,
        tp_trail_pct: 0, tp_trail_arm_pct: 0,
        fast_fail_min_peak_pct: 0,
        stagnant_exit_min: 0, stagnant_loss_pct: 0,
      },
    },
    kingFollow: {
      label: 'K · King Follow',
      description: 'Solo-follow whitelisted wallet · 0.5 SOL entry · +15% TP · −12% SL · exits when king dumps ≥50% of bag',
      trigger: 'smart_trade',
      kingWallets: ['57stAMFvwctAjkBS76RXGoK4QKyS1QoxbGMbzFFe4DyZ'],
      kingMaxMcapSol: 150,
      kingSellExitThreshold: 0.5,
      defaults: {
        enabled: 0, entry_sol: 0.5, sl_pct: -0.12, max_hold_min: 1,
        tier1_trigger_pct: 0.15, tier1_sell_pct: 1.0,
        peak_floor_arm_pct: 0.08, peak_floor_exit_pct: 0.05,
        peak_floor_arm2_pct: 0.0, peak_floor_exit2_pct: 0.0,
        peak_floor_arm3_pct: 0.0, peak_floor_exit3_pct: 0.0,
        tier2_trigger_pct: 99.0, tier2_sell_pct: 0,
        tier3_trigger_pct: 99.0, tier3_sell_pct: 0, tier3_trail_pct: 0,
        breakeven_after_tier1: 0,
        breakeven_arm_pct: 0, breakeven_floor_pct: 0,
        tp_trail_pct: 0, tp_trail_arm_pct: 0,
        fast_fail_min_peak_pct: 0,
        stagnant_exit_min: 0, stagnant_loss_pct: 0,
      },
    },
    global: {
      maxOpenPositions: 20,
      maxSolExposure: 0.75,
      minMintAgeSec: 0,
      maxMintAgeMinutes: 999999,
      skipFlags: ['ABANDONED', 'DEAD'],
      mintCooldownMinutes: 0,
      lossCooldownMinutes: 10,
      winCooldownMinutes: 8,
      smartTradeMinMcapSol: 42,
      smartTradeMcapFloorBypassBoost: true,
    },
    holderGate: {
      enabled: true,
      maxWhalePct: 0.80,
      maxBundlePct: 0.70,
      maxCreatorPct: 0.25,
      minHolderCount: 0,
      cacheTtlMs: 5000,
    },
  },
};
