// index.js — Degen Club v2 entry point.
// Wires up: DB → ingest (Pumpportal + RPC sub + pump.fun logs) → snapshot worker
// → ML client → policy bot → server.

import { db } from './db.js';
import { startPumpPortal } from './ingest/pumpportal.js';
import { startRpcSub } from './ingest/rpc-sub.js';
import { startLogsSub } from './ingest/logs-sub.js';
import { restoreWatchlist } from './ingest/watchlist.js';
import { startSnapshotWorker } from './snapshot/worker.js';
import { startPositionMonitor } from './workers/position-monitor.js';
import { startCoverageWorker } from './workers/coverage-worker.js';
import { startPriceVerifier } from './workers/price-verifier.js';
import { startAmmPriceFetcher } from './workers/amm-price-fetcher.js';
import { startThresholdTuner } from './workers/threshold-tuner.js';
import { startTelegramBroadcaster } from './workers/tg-broadcaster.js';
import { startWalletSkillTracker } from './workers/wallet-skill-tracker.js';
import { startMlClient } from './ml/client.js';
import { startPolicyBot } from './policy/bot.js';
import { startServer } from './server/api.js';

console.log('[boot] Degen Club v2 starting…');
db();

(async () => {
  startServer();
  startMlClient();
  startPumpPortal();
  startRpcSub();
  startLogsSub();                                // pump.fun trades firehose
  startSnapshotWorker();
  startPositionMonitor();
  startCoverageWorker();
  startPriceVerifier();
  startAmmPriceFetcher();
  startThresholdTuner();                          // computes ML features
  startTelegramBroadcaster();                     // Cosmo Calls + Viktor narration
  // startWalletSkillTracker disabled: too heavy in-process. Runs via standalone
  // Python script + cron instead. See scripts/wallet-skill-compute.py
  setTimeout(() => restoreWatchlist().catch(e => console.error('[boot] restore err:', e.message)), 6000);
  setTimeout(() => startPolicyBot(), 15000);     // wait for first snapshots
})();

process.on('SIGTERM', () => { console.log('[boot] SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { console.log('[boot] SIGINT'); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('[boot] uncaught:', err.stack); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('[boot] unhandled:', reason); process.exit(1); });
