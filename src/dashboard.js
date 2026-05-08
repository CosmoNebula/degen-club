// Dashboard process — Express UI server, runs in its own Node process so that
// dashboard SQL queries can't block the bot's trade pipeline. Communicates
// with the bot purely through the shared SQLite DB (WAL mode allows
// concurrent reads + 1 writer; dashboard rarely writes — only config edits +
// resets — and those propagate to the bot on its next signal-eval read).
//
// Spawned automatically by src/index.js (the bot). Crashes are auto-restarted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from './db/index.js';
import { startServer } from './server/index.js';
import { startPriceService } from './price.js';
import { startMlClient } from './ml/ml-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const logPath = path.join(LOG_DIR, `dashboard-${today}.log`);
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
console.log(`[dashboard-startup] log file: ${logPath}`);

init();
// SOL/USD price service runs in the dashboard too — `getSolUsd()` is called
// by /api/stats to format USD prices. The bot has its own copy for its own
// purposes; both fetching every 30s is negligible cost.
startPriceService();
startMlClient();
// getIngestionStatus is null — the bot owns the live websocket state and the
// dashboard process can't see it directly. Live activity is in the health
// endpoint and the trade tables.
startServer(() => null);
