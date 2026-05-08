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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : null;
const PUBLIC_RPC_URL = process.env.PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Polling intervals tuned to keep TLS connections warm (Node fetch keepalive
// drops idle connections after ~60s, so polling at 45s avoids the 2-3s
// first-fetch handshake overhead on every ping).
const LATENCY_INTERVAL_MS = 45 * 1000;
const PRIORITY_FEE_INTERVAL_MS = 60 * 1000;
const SLOT_PERF_INTERVAL_MS = 240 * 1000;
const STATUS_EVAL_INTERVAL_MS = 30 * 1000;
const TS_LOG_INTERVAL_MS = 60 * 1000;
const SUMMARY_LOG_INTERVAL_MS = 5 * 60 * 1000;

const ROLLING_WINDOW_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

const DEGRADED_LATENCY_MS = 1000;
const DOWN_LATENCY_MS = 3000;
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

async function rpcCall(url, method, params = []) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LATENCY_HARD_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'rpc-error');
    return j.result;
  } finally { clearTimeout(t); }
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
  logStmt = d.prepare(
    `INSERT OR REPLACE INTO live_conditions
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      state.networkStatus
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
  console.log(
    `[conditions] ${state.networkStatus} · helius p50/p90/p99 ${fmt(h.p50)}/${fmt(h.p90)}/${fmt(h.p99)}ms · ` +
      `public p50/p90 ${fmt(p.p50)}/${fmt(p.p90)}ms · ` +
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

// p90 latency for the chosen provider (defaults helius — what we'd use live).
export function getLatencyEstimate(provider = 'helius') {
  const r = state.rpc[provider];
  return r && r.p90 != null ? r.p90 : FALLBACK_LATENCY_MS;
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

  // Stagger initial pings so we don't fire 4 parallel TLS handshakes at boot
  // (was overwhelming connection pool and timing out)
  setTimeout(() => pingLatency('helius', HELIUS_RPC_URL), 2000);
  setTimeout(() => pingLatency('public', PUBLIC_RPC_URL), 4000);
  setTimeout(pollPriorityFees, 6000);
  setTimeout(pollSlotPerformance, 8000);

  // Periodic pollers (also offset start times to keep load smooth)
  setInterval(() => pingLatency('helius', HELIUS_RPC_URL), LATENCY_INTERVAL_MS);
  setInterval(() => pingLatency('public', PUBLIC_RPC_URL), LATENCY_INTERVAL_MS);
  setInterval(pollPriorityFees, PRIORITY_FEE_INTERVAL_MS);
  setInterval(pollSlotPerformance, SLOT_PERF_INTERVAL_MS);

  // Status reflection + persistence
  setInterval(evaluateNetworkStatus, STATUS_EVAL_INTERVAL_MS);
  setInterval(logTimeSeries, TS_LOG_INTERVAL_MS);
  setInterval(logSummary, SUMMARY_LOG_INTERVAL_MS);

  console.log('[conditions] live-conditions monitor started · helius=' + (HELIUS_RPC_URL ? 'enabled' : 'disabled') + ' · public=enabled');
}
