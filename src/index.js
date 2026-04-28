import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from './db/index.js';
import { startServer } from './server/index.js';

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
import { startRunnerScoreSweep } from './scoring/runner-score.js';
import { startSessionLogger } from './scoring/session-logger.js';
import { startBundleSweep } from './scoring/bundle.js';
import { startDevSweep } from './scoring/devs.js';
import { startVolumeSurgeSweep } from './scoring/volume.js';
import { startMaintenance } from './maintenance.js';
import { startPostExitSweep } from './scoring/post-exit.js';
import { initStrategies } from './trading/strategies.js';
import { startPositionMonitor } from './trading/paper.js';
import { startMoonbagPriceFeed, startOpenPositionPriceFeed } from './ingestion/dexscreener.js';
import { heliusWS } from './ingestion/helius.js';
import { startPriceService } from './price.js';

init();
initStrategies();
startPriceService();
startPositionMonitor();
heliusWS.start();
startMoonbagPriceFeed();
startOpenPositionPriceFeed();
startPostExitSweep();

const pp = new PumpPortalClient();
startProcessor(pp);
startSweeper();
startTraderSweep();
startWalletGrader();
startRunnerScoreSweep();
startSessionLogger();
startBundleSweep();
startDevSweep();
startVolumeSurgeSweep();
startMaintenance();
pp.start();

startServer(() => pp.status());
