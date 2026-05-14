import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { init } from './db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const logPath = path.join(LOG_DIR, `server-${today}.log`);
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
const _origLog = console.log;
const _origErr = console.error;
function ts() { return new Date().toISOString(); }
console.log = (...args) => {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  _origLog.apply(console, args);
  logStream.write(`[${ts()}] ${line}\n`);
};
console.error = (...args) => {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  _origErr.apply(console, args);
  logStream.write(`[${ts()}] ERROR: ${line}\n`);
};
console.log(`[startup] log file: ${logPath}`);
import { PumpPortalClient } from './ingestion/pumpportal.js';
import { startProcessor, startSweeper } from './ingestion/processor.js';
import { startTraderSweep } from './scoring/traders.js';
import { startWalletGrader } from './scoring/wallet-grader.js';
import { startWalletLeaderboard } from './scoring/wallet-leaderboard.js';
import { startRunnerScoreSweep } from './scoring/runner-score.js';
import { startWhaleSpawnSweep } from './scoring/whale-spawn.js';
import { startKolDipSweep } from './scoring/kol-dip.js';
import { startLiveConditionsMonitor } from './scoring/live-conditions.js';
import { startMicrostructureSweep } from './scoring/mint-microstructure.js';
import { startSnapshotSweeper } from './ml/snapshot-sweeper.js';
import { startKnownAddressDetector } from './ml/known-address-detector.js';
import { startLabelResolver } from './ml/label-resolver.js';
import { startDiskMonitor } from './ml/disk-monitor.js';
import { startMlClient } from './ml/ml-client.js';
import { startScoringSweeper } from './ml/scoring-sweeper.js';
import { startAutoRetrain } from './ml/auto-retrain.js';
import { startSentimentScorer } from './ml/sentiment-scorer.js';
import { startMlConvictionWatcher } from './ml/ml-conviction-watcher.js';
import { startTrackerConcentration } from './scoring/tracker-concentration.js';
import { startAgent } from './ml/agent.js';
import { startEventLoopWatchdog } from './event-loop-watchdog.js';
import { startTelegramBroadcast } from './ingestion/telegram-broadcast.js';
import { startServeWatchdog } from './ml/serve-watchdog.js';
import { startRssIngest } from './ingestion/news/rss-ingest.js';
import { startRedditIngest } from './ingestion/news/reddit.js';
import { startTrendingApis } from './ingestion/news/trending-apis.js';
import { startTwitterIngest } from './ingestion/news/twitter-nitter.js';
import { startTruthSocialIngest } from './ingestion/news/truth-social.js';
import { startNewsCleanup } from './ingestion/news/cleanup.js';
import { startIntelligenceCondensate } from './ml/intelligence-condensate.js';
import { startAnomalyDetector } from './ml/anomaly-detector.js';
import { startMigratedTracker } from './ingestion/migrated-tracker.js';
import { startMigrationSnapshot } from './ml/migration-snapshot.js';
import { getSolUsd } from './price.js';
import { startMetaSynthesis } from './ml/agent-meta-synthesis.js';
import { startSessionLogger } from './scoring/session-logger.js';
import { startBundleSweep } from './scoring/bundle.js';
import { startDevSweep } from './scoring/devs.js';
import { startVolumeSurgeSweep } from './scoring/volume.js';
import { startMaintenance } from './maintenance.js';
import { startPostExitSweep } from './scoring/post-exit.js';
import { initStrategies } from './trading/strategies.js';
import { startPositionMonitor, recoverLivePositions, recoverPaperPositions } from './trading/paper.js';
import { startMoonbagPriceFeed, startOpenPositionPriceFeed } from './ingestion/dexscreener.js';
import { startOnchainPriceFeed } from './ingestion/onchain-price.js';
import { startOnchainAmm } from './ingestion/onchain-amm-price.js';
import { startHeliusWebhookSync } from './ingestion/helius-webhooks.js';
import { startTelegramMemberWatcher } from './ingestion/telegram-members.js';
import { startTelegramCallsBroadcaster } from './ingestion/telegram-calls.js';
import { heliusWS } from './ingestion/helius.js';
import { onchainPumpTrades } from './ingestion/onchain-pump-trades.js';
import { startPriceService } from './price.js';
import { startHealthHeartbeat } from './health.js';
import { pollRuntimeLimits } from './runtime-limits.js';

init();
pollRuntimeLimits(3000); // pick up dashboard-edited limits within 3s
initStrategies();
startPriceService();
try { recoverPaperPositions(); }
catch (err) { console.error('[recover-paper] startup failed:', err.message); }
recoverLivePositions()
  .catch(err => console.error('[recover] startup failed:', err.message))
  .finally(() => startPositionMonitor());
heliusWS.start();
startMoonbagPriceFeed();
startOpenPositionPriceFeed();
startOnchainPriceFeed();
startOnchainAmm();
startHeliusWebhookSync();
startTelegramMemberWatcher();
startTelegramCallsBroadcaster();
startPostExitSweep();

const pp = new PumpPortalClient();
startProcessor(pp);
// Per-mint trade firehose moved off PumpPortal (paid as of 2026-05-01).
// We now decode TradeEvents directly from Pump.fun program logs.
startProcessor(onchainPumpTrades);
onchainPumpTrades.start();
startSweeper();
startTraderSweep();
startWalletGrader();
startWalletLeaderboard();
startRunnerScoreSweep();
startWhaleSpawnSweep();
startKolDipSweep();
startLiveConditionsMonitor();
startMicrostructureSweep();
startDiskMonitor();
startSnapshotSweeper();
startKnownAddressDetector();
startLabelResolver();
startMlClient();
startScoringSweeper();
startAutoRetrain();
startSentimentScorer();
startMlConvictionWatcher();
startTrackerConcentration();
startAgent();
startServeWatchdog();
startEventLoopWatchdog();
startTelegramBroadcast();
// Cultural pulse — news/trends/social ingestion + Claude synthesis every 4h
startRssIngest();
startRedditIngest();
startTrendingApis();
startTwitterIngest();
startTruthSocialIngest();
startMetaSynthesis();
startNewsCleanup();
startIntelligenceCondensate();
startAnomalyDetector();
startMigratedTracker();
startMigrationSnapshot(getSolUsd);
startSessionLogger();
startBundleSweep();
startDevSweep();
startVolumeSurgeSweep();
startMaintenance();
pp.start();
startHealthHeartbeat({ pp, onchainTrades: onchainPumpTrades });

// Dashboard runs in a separate Node process so its SQL load can't block the
// trade pipeline (Helius firehose → signal eval → trade fire all run on this
// thread). Communication is via the shared SQLite DB. Auto-restart on crash.
let _dashboardProc = null;
function spawnDashboard() {
  const dashboardPath = path.resolve(__dirname, 'dashboard.js');
  console.log(`[bot] spawning dashboard: ${dashboardPath}`);
  _dashboardProc = spawn(process.execPath, [dashboardPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  _dashboardProc.on('exit', (code, sig) => {
    console.error(`[dashboard-proc] exited code=${code} sig=${sig} — restarting in 2s`);
    _dashboardProc = null;
    setTimeout(spawnDashboard, 2000);
  });
}
spawnDashboard();
// Make sure the dashboard child dies with the bot — otherwise restarts leak processes.
const killChild = () => { try { _dashboardProc?.kill('SIGTERM'); } catch {} };
process.on('exit', killChild);
process.on('SIGTERM', () => { killChild(); process.exit(0); });
process.on('SIGINT', () => { killChild(); process.exit(0); });
