// Node ↔ Python ML inference bridge.
//
// Calls the FastAPI service at http://127.0.0.1:5050/predict, caches results
// per mint for 30s, hard 200ms timeout so a stuck Python service never blocks
// the trade pipeline. Logs every prediction to ml_predictions table.
//
// API:
//   getMigrationProb(mintAddress, source) — returns prob 0-1 or null
//   isHealthy() — quick boolean of Python service status
//   getStats() — recent prediction stats for the dashboard

import { db } from '../db/index.js';
import { collectFeatures } from './feature-collector.js';

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:5050';
// Timeouts intentionally generous — Node fetch's connection pool in a busy
// process (dashboard does many other fetches) can take seconds for first call.
// In production we'd use undici Pool explicitly; for v1, generous timeouts.
const HEALTH_TIMEOUT_MS = 3000;
const PREDICT_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 30 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 30 * 1000;  // 30s — keeps connection warm

const _cache = new Map(); // mint -> { prob, asOf }
let _healthy = null;
let _lastHealthCheck = 0;
let _modelLoaded = false;

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  _stmts = {
    insert: d.prepare(`INSERT INTO ml_predictions
      (timestamp, mint_address, prob, target, source, cache_hit, features_json, latency_ms, model_loaded, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    recentN: d.prepare(`SELECT timestamp, mint_address, prob, target, source, cache_hit, latency_ms
      FROM ml_predictions ORDER BY timestamp DESC LIMIT ?`),
    statsLastHour: d.prepare(`SELECT
        COUNT(*) AS n, SUM(cache_hit) AS hits, AVG(latency_ms) AS avg_latency,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
      FROM ml_predictions WHERE timestamp >= ?`),
    // Average classification probabilities only — averaging across regression
    // targets (peak_pct_max is a fraction, time_to_peak_sec is in seconds) is
    // meaningless. Use peaked_30 since it's the most-fired target.
    avgProbLastHour: d.prepare(`SELECT AVG(prob) AS avg_prob
      FROM ml_predictions WHERE timestamp >= ? AND target = 'peaked_30'`),
  };
  return _stmts;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = PREDICT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

async function checkHealth() {
  try {
    // Node fetch can hit ~800ms cold-start even for localhost
    const r = await fetchWithTimeout(`${ML_SERVICE_URL}/health`, {}, HEALTH_TIMEOUT_MS);
    if (!r.ok) { _healthy = false; _modelLoaded = false; return; }
    const j = await r.json();
    _healthy = !!j.ok;
    _modelLoaded = !!j.model_loaded;
  } catch (err) {
    _healthy = false; _modelLoaded = false;
  }
  _lastHealthCheck = Date.now();
}

function logPrediction(row) {
  try { S().insert.run(
    row.timestamp, row.mint_address, row.prob, row.target, row.source,
    row.cache_hit ? 1 : 0, row.features_json || null, row.latency_ms || 0,
    row.model_loaded ? 1 : 0, row.error || null);
  } catch (err) { console.error('[ml-client] log failed:', err.message); }
}

export function isHealthy() {
  if (Date.now() - _lastHealthCheck > HEALTH_CHECK_INTERVAL_MS) checkHealth();
  return _healthy === true && _modelLoaded === true;
}

export function getServiceStatus() {
  return {
    serviceReachable: _healthy === true,
    modelLoaded: _modelLoaded === true,
    lastHealthCheck: _lastHealthCheck,
    cacheSize: _cache.size,
  };
}

// Fetches predictions for ALL targets in one round-trip (efficient).
// Returns { peaked_30: 0.12, peaked_100: 0.05, migrated: 0.01, ... } or null.
export async function getAllPredictions(mintAddress, source = 'unknown') {
  const start = Date.now();
  if (!isHealthy()) return null;
  const features = collectFeatures(mintAddress);
  if (!features) return null;
  try {
    const r = await fetchWithTimeout(`${ML_SERVICE_URL}/predict-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features }),
    });
    const elapsed = Date.now() - start;
    if (!r.ok) return null;
    const j = await r.json();
    const preds = j.predictions || {};
    // Log each target as a separate audit row
    for (const [target, prob] of Object.entries(preds)) {
      if (prob == null) continue;
      logPrediction({
        timestamp: Date.now(), mint_address: mintAddress, prob, target,
        source, cache_hit: false, latency_ms: elapsed, model_loaded: _modelLoaded,
      });
    }
    return preds;
  } catch { return null; }
}

export async function getMigrationProb(mintAddress, source = 'unknown') {
  const start = Date.now();
  // Cache check
  const cached = _cache.get(mintAddress);
  if (cached && Date.now() - cached.asOf < CACHE_TTL_MS) {
    logPrediction({
      timestamp: Date.now(), mint_address: mintAddress, prob: cached.prob,
      target: cached.target, source, cache_hit: true,
      latency_ms: 0, model_loaded: _modelLoaded,
    });
    return cached.prob;
  }
  // Need to fetch features + call service
  if (!isHealthy()) {
    logPrediction({
      timestamp: Date.now(), mint_address: mintAddress, prob: null,
      source, cache_hit: false, latency_ms: 0, model_loaded: false,
      error: 'service_unhealthy',
    });
    return null;
  }
  const features = collectFeatures(mintAddress);
  if (!features) {
    logPrediction({
      timestamp: Date.now(), mint_address: mintAddress, prob: null,
      source, cache_hit: false, latency_ms: 0, model_loaded: _modelLoaded,
      error: 'mint_not_found',
    });
    return null;
  }
  try {
    const r = await fetchWithTimeout(`${ML_SERVICE_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features }),
    });
    const elapsed = Date.now() - start;
    if (!r.ok) {
      logPrediction({
        timestamp: Date.now(), mint_address: mintAddress, prob: null,
        source, cache_hit: false, latency_ms: elapsed, model_loaded: _modelLoaded,
        error: `http_${r.status}`,
      });
      return null;
    }
    const j = await r.json();
    const prob = typeof j.prob === 'number' ? j.prob : null;
    if (prob != null) {
      _cache.set(mintAddress, { prob, target: j.target, asOf: Date.now() });
    }
    logPrediction({
      timestamp: Date.now(), mint_address: mintAddress, prob, target: j.target,
      source, cache_hit: false, features_json: JSON.stringify(features),
      latency_ms: elapsed, model_loaded: _modelLoaded,
    });
    return prob;
  } catch (err) {
    const elapsed = Date.now() - start;
    logPrediction({
      timestamp: Date.now(), mint_address: mintAddress, prob: null,
      source, cache_hit: false, latency_ms: elapsed, model_loaded: _modelLoaded,
      error: err.message || 'fetch_error',
    });
    return null;
  }
}

export function getRecentPredictions(n = 25) {
  return S().recentN.all(n);
}

export function getStats() {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const row = S().statsLastHour.get(hourAgo);
  const avgRow = S().avgProbLastHour.get(hourAgo);
  return {
    last_hour: {
      total: row?.n || 0,
      cache_hits: row?.hits || 0,
      hit_rate: row?.n > 0 ? row.hits / row.n : 0,
      avg_latency_ms: row?.avg_latency || 0,
      avg_prob: avgRow?.avg_prob || 0,  // peaked_30 only — see prepared stmt
      avg_prob_target: 'peaked_30',
      errors: row?.errors || 0,
    },
    cache_size: _cache.size,
    service: getServiceStatus(),
  };
}

export function startMlClient() {
  checkHealth();
  setInterval(checkHealth, HEALTH_CHECK_INTERVAL_MS);
  console.log(`[ml-client] started · service=${ML_SERVICE_URL} · health_timeout=${HEALTH_TIMEOUT_MS}ms · predict_timeout=${PREDICT_TIMEOUT_MS}ms · cache_ttl=${CACHE_TTL_MS}ms`);
}
