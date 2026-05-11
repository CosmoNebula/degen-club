// Live Conditions Monitor (Phase 1A) — measures real-time network conditions
// in parallel with paper trading so we can model what live execution would
// cost RIGHT NOW. Foundation for the dynamic friction model in Phase 1C.
//
// Measures:
//   - RPC round-trip latency (Helius + public RPC, in parallel)
//   - Priority fee benchmarks (Helius getRecentPrioritizationFees)
//   - Slot time / network throughput (getRecentPerformanceSamples)
//   - Network status flag (healthy / degraded / down)
//
// Storage:
//   - Hot: in-memory state object, O(1) read for paper friction calc
//   - Cold: live_conditions table, 1-min snapshots, 7-day rolling window
//
// Quota footprint: ~60K Helius credits/month (6% of free tier).

import { db } from '../db/index.js';
import https from 'https';
import http from 'http';
import { URL as NodeURL } from 'url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : null;
// Helius Gatekeeper (beta) — low-latency RPC router. Probed in parallel with
// the standard Helius endpoint; if its p90 consistently beats helius, we can
// promote it (or use it for tx submission once live trading turns on).
const HELIUS_GATEKEEPER_RPC_URL = process.env.HELIUS_GATEKEEPER_RPC_URL || null;
const PUBLIC_RPC_URL = process.env.PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Polling intervals tuned to keep TLS connections warm (Node fetch keepalive
// drops idle connections after ~60s, so 60s polling keeps the pool from
// going stale — without that, the keepalive sockets die between probes and
// the next fetch hangs until the 10s timeout, exactly the bug we observed).
// On Developer tier (10M credits/month) probing every 60s × 3 providers
// = ~4,320 calls/day, <0.05% of budget. Worth it for not seeing 10.0s/10.0s.
const LATENCY_INTERVAL_MS = 60 * 1000;
const PRIORITY_FEE_INTERVAL_MS = 2 * 60 * 1000;
const SLOT_PERF_INTERVAL_MS = 5 * 60 * 1000;
const STATUS_EVAL_INTERVAL_MS = 30 * 1000;
const TS_LOG_INTERVAL_MS = 60 * 1000;
const SUMMARY_LOG_INTERVAL_MS = 5 * 60 * 1000;

// 2-min rolling window (was 5 min). With 60s probe interval that's ~2 samples
// in scope — fast enough to recover from a single slow outlier without
// poisoning the metric for 5 minutes. Trade-off: less statistical smoothing.
// Worth it because the keepalive fix already eliminated the chronic-stale case.
const ROLLING_WINDOW_MS = 2 * 60 * 1000;
// Probes run every 60s — sample is stale if no probe landed in 5min.
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// Thresholds calibrated for PAPER mode. Trade firehose runs on WebSocket
// independent of these RPC probes — RPC latency only affects live trading
// (where we'd submit txns). For paper, loose thresholds so NETWORK badge
// reflects "system actually broken" not "Helius probe slow at the moment."
const DEGRADED_LATENCY_MS = 3000;
const DOWN_LATENCY_MS = 8000;
const DEGRADED_SLOT_MS = 800;
const DOWN_SLOT_MS = 1500;
const PRUNE_RETAIN_DAYS = 7;

// Defaults used when stats not yet populated — conservative fallback so
// downstream consumers (friction model) don't crash on null reads.
const FALLBACK_LATENCY_MS = 1000;
const FALLBACK_PRIORITY_FEE_MICROLAMPORTS = 5000;
const FALLBACK_SLOT_TIME_MS = 410;

// ---------------------------------------------------------------------------
// In-memory state (the hot path — read on every friction calc)
// ---------------------------------------------------------------------------
const state = {
  rpc: {
    helius: { samples: [], p50: null, p90: null, p99: null, lastSampleAt: 0 },
    public: { samples: [], p50: null, p90: null, p99: null, lastSampleAt: 0 },
    gatekeeper: { samples: [], p50: null, p90: null, p99: null, lastSampleAt: 0 },
  },
  priorityFee: { p50: null, p90: null, p99: null, asOf: 0 },
  slotTime: { mean: null, max: null, samples: [], asOf: 0 },
  networkStatus: 'unknown', // unknown | healthy | degraded | down
  asOf: 0,
};

// ---------------------------------------------------------------------------
// Direct RPC calls (bypass @solana/web3.js — its Connection pool can hang
// after long uptime; raw fetch is reliable and gives us hard timeout control)
// ---------------------------------------------------------------------------

function rpcCall(urlStr, method, params = []) {
  // Use Node's raw https module — bypasses undici entirely. Verified
  // 2026-05-11: `fetch()` inside the bot was timing out (10s) while curl
  // and a fresh-Node-process fetch both returned in ~200ms. Some long-
  // running module state (likely web3.js's pooled connections) was
  // poisoning undici's global Agent. Raw https with `agent: false` gets
  // a fresh socket per request and is immune.
  return new Promise((resolve, reject) => {
    let u;
    try { u = new NodeURL(urlStr); } catch (e) { return reject(e); }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search || ''}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'close',
      },
      agent: false,
      timeout: LATENCY_HARD_TIMEOUT_MS,
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (j.error) return reject(new Error(j.error.message || 'rpc-error'));
          resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('AbortError')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

function pruneOldSamples(samples, now) {
  const cutoff = now - ROLLING_WINDOW_MS;
  return samples.filter((s) => s.t >= cutoff);
}

function recomputeLatencyStats(provider) {
  const now = Date.now();
  state.rpc[provider].samples = pruneOldSamples(state.rpc[provider].samples, now);
  const sorted = state.rpc[provider].samples.map((s) => s.ms).sort((a, b) => a - b);
  state.rpc[provider].p50 = percentile(sorted, 0.5);
  state.rpc[provider].p90 = percentile(sorted, 0.9);
  state.rpc[provider].p99 = percentile(sorted, 0.99);
  state.rpc[provider].lastSampleAt = now;
}

// ---------------------------------------------------------------------------
// Pollers
// ---------------------------------------------------------------------------
const LATENCY_HARD_TIMEOUT_MS = 10000;

async function pingLatency(provider, url) {
  if (!url) return;
  const start = Date.now();
  let elapsed;
  try {
    await rpcCall(url, 'getLatestBlockhash');
    elapsed = Date.now() - start;
  } catch (err) {
    elapsed = LATENCY_HARD_TIMEOUT_MS;
    if (err.name !== 'AbortError') {
      console.log(`[conditions] ${provider} ping failed: ${err.message}`);
    }
  }
  state.rpc[provider].samples.push({ t: Date.now(), ms: elapsed });
  recomputeLatencyStats(provider);
}

// Scope the fee query to the Pump.fun bonding curve program — without an
// account, Solana returns *global* fees which collapse to 0 in low-contention
// slots. Scoping to the program we actually compete with gives us the real
// fee distribution we'd be paying to win our buys/sells.
const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

async function pollPriorityFees() {
  if (!HELIUS_RPC_URL) return;
  try {
    const fees = await rpcCall(HELIUS_RPC_URL, 'getRecentPrioritizationFees', [[PUMP_FUN_PROGRAM_ID]]);
    if (!Array.isArray(fees) || fees.length === 0) return;
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    state.priorityFee.p50 = percentile(sorted, 0.5);
    state.priorityFee.p90 = percentile(sorted, 0.9);
    state.priorityFee.p99 = percentile(sorted, 0.99);
    state.priorityFee.asOf = Date.now();
  } catch (err) {
    console.log(`[conditions] priority fees fetch failed: ${err.message}`);
  }
}

async function pollSlotPerformance() {
  if (!HELIUS_RPC_URL) return;
  try {
    const samples = await rpcCall(HELIUS_RPC_URL, 'getRecentPerformanceSamples', [20]);
    if (!Array.isArray(samples) || samples.length === 0) return;
    const slotTimes = samples
      .filter((s) => s.numSlots > 0)
      .map((s) => (s.samplePeriodSecs * 1000) / s.numSlots);
    if (slotTimes.length === 0) return;
    state.slotTime.mean = slotTimes.reduce((a, b) => a + b, 0) / slotTimes.length;
    state.slotTime.max = Math.max(...slotTimes);
    state.slotTime.samples = slotTimes;
    state.slotTime.asOf = Date.now();
  } catch (err) {
    console.log(`[conditions] slot perf fetch failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Network status evaluator
// ---------------------------------------------------------------------------
function evaluateNetworkStatus() {
  const now = Date.now();
  const heliusFresh = state.rpc.helius.lastSampleAt > 0 && now - state.rpc.helius.lastSampleAt < STALE_THRESHOLD_MS;
  const heliusP90 = state.rpc.helius.p90;
  const slotMax = state.slotTime.max;

  let next = 'unknown';
  if (state.rpc.helius.lastSampleAt === 0) {
    next = 'unknown';
  } else if (!heliusFresh) {
    next = 'down';
  } else if (heliusP90 != null && heliusP90 > DOWN_LATENCY_MS) {
    next = 'down';
  } else if (slotMax != null && slotMax > DOWN_SLOT_MS) {
    next = 'down';
  } else if (heliusP90 != null && heliusP90 > DEGRADED_LATENCY_MS) {
    next = 'degraded';
  } else if (slotMax != null && slotMax > DEGRADED_SLOT_MS) {
    next = 'degraded';
  } else if (heliusP90 != null) {
    next = 'healthy';
  }

  if (state.networkStatus !== next && next !== 'unknown' && state.networkStatus !== 'unknown') {
    console.log(`[conditions] status change: ${state.networkStatus} → ${next}`);
  }
  state.networkStatus = next;
  state.asOf = now;
}

// ---------------------------------------------------------------------------
// Time-series log (cold path — for ML training + analysis)
// ---------------------------------------------------------------------------
let logStmt = null;
let pruneStmt = null;
function ensureLogStmts() {
  if (logStmt) return;
  const d = db();
  d.prepare(
    `CREATE TABLE IF NOT EXISTS live_conditions (
      timestamp INTEGER PRIMARY KEY,
      rpc_helius_p50 REAL, rpc_helius_p90 REAL, rpc_helius_p99 REAL,
      rpc_public_p50 REAL, rpc_public_p90 REAL, rpc_public_p99 REAL,
      priority_fee_p50 INTEGER, priority_fee_p90 INTEGER, priority_fee_p99 INTEGER,
      slot_time_mean REAL, slot_time_max REAL,
      network_status TEXT
    )`
  ).run();
  // Gatekeeper-beta probe columns (added 2026-05-10 for A/B vs standard Helius RPC)
  for (const col of ['rpc_gatekeeper_p50', 'rpc_gatekeeper_p90', 'rpc_gatekeeper_p99']) {
    const cols = d.prepare(`PRAGMA table_info(live_conditions)`).all().map(c => c.name);
    if (!cols.includes(col)) d.exec(`ALTER TABLE live_conditions ADD COLUMN ${col} REAL`);
  }
  logStmt = d.prepare(
    `INSERT OR REPLACE INTO live_conditions (
       timestamp,
       rpc_helius_p50, rpc_helius_p90, rpc_helius_p99,
       rpc_public_p50, rpc_public_p90, rpc_public_p99,
       priority_fee_p50, priority_fee_p90, priority_fee_p99,
       slot_time_mean, slot_time_max,
       network_status,
       rpc_gatekeeper_p50, rpc_gatekeeper_p90, rpc_gatekeeper_p99
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  pruneStmt = d.prepare(`DELETE FROM live_conditions WHERE timestamp < ?`);
}

function logTimeSeries() {
  try {
    ensureLogStmts();
    logStmt.run(
      Date.now(),
      state.rpc.helius.p50, state.rpc.helius.p90, state.rpc.helius.p99,
      state.rpc.public.p50, state.rpc.public.p90, state.rpc.public.p99,
      state.priorityFee.p50, state.priorityFee.p90, state.priorityFee.p99,
      state.slotTime.mean, state.slotTime.max,
      state.networkStatus,
      state.rpc.gatekeeper.p50, state.rpc.gatekeeper.p90, state.rpc.gatekeeper.p99,
    );
    pruneStmt.run(Date.now() - PRUNE_RETAIN_DAYS * 24 * 60 * 60 * 1000);
  } catch (err) {
    console.error('[conditions] log failed:', err.message);
  }
}

function logSummary() {
  const h = state.rpc.helius;
  const p = state.rpc.public;
  const fee = state.priorityFee;
  const slot = state.slotTime;
  const fmt = (v, suffix = '') => (v == null ? '?' : `${typeof v === 'number' ? v.toFixed(0) : v}${suffix}`);
  const g = state.rpc.gatekeeper;
  const gkPart = HELIUS_GATEKEEPER_RPC_URL
    ? ` · gk p50/p90/p99 ${fmt(g.p50)}/${fmt(g.p90)}/${fmt(g.p99)}ms`
    : '';
  console.log(
    `[conditions] ${state.networkStatus} · helius p50/p90/p99 ${fmt(h.p50)}/${fmt(h.p90)}/${fmt(h.p99)}ms · ` +
      `public p50/p90 ${fmt(p.p50)}/${fmt(p.p90)}ms${gkPart} · ` +
      `pri-fee p50/p90 ${fmt(fee.p50)}/${fmt(fee.p90)}µL · ` +
      `slot mean/max ${fmt(slot.mean)}/${fmt(slot.max)}ms`
  );
}

// ---------------------------------------------------------------------------
// Public API — what the rest of the bot consumes
// ---------------------------------------------------------------------------
export function getCurrentConditions() {
  return state;
}

// p90 latency for the chosen provider — used for STATUS color (degraded/down)
// and the dashboard's "worst case" display. NOT for paper fill simulation —
// p90 is the worst-case, but a real trade fills at typical latency.
export function getLatencyEstimate(provider = 'helius') {
  const r = state.rpc[provider];
  return r && r.p90 != null ? r.p90 : FALLBACK_LATENCY_MS;
}

// Median latency — what a TYPICAL fill would experience. Use this for paper
// trade simulation; using p90 over-simulates worst-case fills and inflates
// drift on the position monitor. The dashboard still shows p50/p90 side by
// side so the user can see both typical AND tail behavior.
export function getMedianLatency(provider = 'helius') {
  const r = state.rpc[provider];
  return r && r.p50 != null ? r.p50 : FALLBACK_LATENCY_MS;
}

// Recommended priority fee in SOL (p90 of recent fees, in microlamports → SOL).
export function getPriorityFeeSol() {
  const fee = state.priorityFee.p90 != null ? state.priorityFee.p90 : FALLBACK_PRIORITY_FEE_MICROLAMPORTS;
  return fee / 1e9;
}

export function getSlotTimeMs() {
  return state.slotTime.mean != null ? state.slotTime.mean : FALLBACK_SLOT_TIME_MS;
}

export function isNetworkHealthy() { return state.networkStatus === 'healthy'; }
export function isNetworkDegraded() { return state.networkStatus === 'degraded' || state.networkStatus === 'down'; }
export function getNetworkStatus() { return state.networkStatus; }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
export function startLiveConditionsMonitor() {
  if (!HELIUS_API_KEY) {
    console.warn('[conditions] HELIUS_API_KEY not set — Helius latency unavailable; using public RPC only');
  }

  // Stagger initial pings so we don't fire parallel TLS handshakes at boot
  // (was overwhelming connection pool and timing out)
  setTimeout(() => pingLatency('helius', HELIUS_RPC_URL), 2000);
  setTimeout(() => pingLatency('public', PUBLIC_RPC_URL), 4000);
  if (HELIUS_GATEKEEPER_RPC_URL) {
    setTimeout(() => pingLatency('gatekeeper', HELIUS_GATEKEEPER_RPC_URL), 5000);
  }
  setTimeout(pollPriorityFees, 6000);
  setTimeout(pollSlotPerformance, 8000);

  // Periodic pollers (also offset start times to keep load smooth)
  setInterval(() => pingLatency('helius', HELIUS_RPC_URL), LATENCY_INTERVAL_MS);
  setInterval(() => pingLatency('public', PUBLIC_RPC_URL), LATENCY_INTERVAL_MS);
  if (HELIUS_GATEKEEPER_RPC_URL) {
    setInterval(() => pingLatency('gatekeeper', HELIUS_GATEKEEPER_RPC_URL), LATENCY_INTERVAL_MS);
  }
  setInterval(pollPriorityFees, PRIORITY_FEE_INTERVAL_MS);
  setInterval(pollSlotPerformance, SLOT_PERF_INTERVAL_MS);

  // Status reflection + persistence
  setInterval(evaluateNetworkStatus, STATUS_EVAL_INTERVAL_MS);
  setInterval(logTimeSeries, TS_LOG_INTERVAL_MS);
  setInterval(logSummary, SUMMARY_LOG_INTERVAL_MS);

  console.log('[conditions] live-conditions monitor started · helius=' + (HELIUS_RPC_URL ? 'enabled' : 'disabled') + ' · public=enabled · gatekeeper=' + (HELIUS_GATEKEEPER_RPC_URL ? 'enabled' : 'disabled'));
}
