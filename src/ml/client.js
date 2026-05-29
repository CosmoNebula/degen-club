// ml/client.js — Talks to the local Python FastAPI ML inference service.
// All calls are LOCAL (127.0.0.1) — zero external/Helius cost.
//
// Important: predictMint also writes each target's probability into
// ml_predictions so policy/bot.js can read latest predictions per (mint, target).
// The serve.py /predict-mint endpoint only returns JSON — it doesn't persist
// anything itself, so the writer lives here.

import { config } from '../config.js';
import { db } from '../db.js';

async function fetchJson(url, opts = {}, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

let _healthy = false;
let _lastCheck = 0;

export async function checkHealth() {
  try {
    const r = await fetchJson(`${config.mlServiceUrl}/health`, {}, 2000);
    _healthy = r?.status === 'ok' || r?.ok === true;
    _lastCheck = Date.now();
    return _healthy;
  } catch {
    _healthy = false;
    return false;
  }
}

export function isHealthy() { return _healthy; }

let _insertPred = null;
function insertPred() {
  if (_insertPred) return _insertPred;
  _insertPred = db().prepare(`INSERT INTO ml_predictions
    (timestamp, mint_address, prob, target, source, latency_ms, model_loaded)
    VALUES (?, ?, ?, ?, 'predict-mint', ?, 1)`);
  return _insertPred;
}

function persistPredictions(mint, predictions, latencyMs) {
  if (!predictions || typeof predictions !== 'object') return;
  const stmt = insertPred();
  const now = Date.now();
  for (const [target, prob] of Object.entries(predictions)) {
    if (prob == null || Number.isNaN(prob)) continue;
    try { stmt.run(now, mint, prob, target, latencyMs); } catch {}
  }
}

// Predict all targets for a mint (uses snapshot in DB if available) and
// persist to ml_predictions so the policy bot can read them later via SQL.
export async function predictMint(mintAddress) {
  const t0 = Date.now();
  try {
    const res = await fetchJson(`${config.mlServiceUrl}/predict-mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mint: mintAddress }),
    }, 15000);
    if (res?.predictions) persistPredictions(mintAddress, res.predictions, Date.now() - t0);
    return res;
  } catch (err) {
    return { error: err.message };
  }
}

// Predict all targets from a raw features dict
export async function predictAll(features) {
  try {
    return await fetchJson(`${config.mlServiceUrl}/predict-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features }),
    }, 15000);
  } catch (err) {
    return { error: err.message };
  }
}

export function startMlClient() {
  // Initial health check + recurring every 30s
  checkHealth().then(ok => console.log(`[ml] service health: ${ok ? 'OK' : 'DOWN'} (${config.mlServiceUrl})`));
  setInterval(checkHealth, 30000);
}
