// Runtime limits — persisted in data/runtime-limits.json so the dashboard
// can adjust them live without a restart, and so they survive process reloads.
//
// In the split-process arch the dashboard process WRITES the file (via
// /api/limits/update) and the bot process READS it. Both call
// applyRuntimeLimits() at startup; the bot also polls every few seconds via
// pollRuntimeLimits() so dashboard edits propagate to the trade engine
// without a bot restart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIMITS_PATH = path.resolve(__dirname, '..', 'data', 'runtime-limits.json');

let _lastMtimeMs = 0;

export function applyRuntimeLimits({ silent = false } = {}) {
  try {
    if (!fs.existsSync(LIMITS_PATH)) return false;
    const stat = fs.statSync(LIMITS_PATH);
    if (stat.mtimeMs === _lastMtimeMs) return false; // unchanged
    _lastMtimeMs = stat.mtimeMs;
    const saved = JSON.parse(fs.readFileSync(LIMITS_PATH, 'utf8'));
    if (typeof saved.maxPerTradeSol === 'number' && saved.maxPerTradeSol > 0) {
      config.safety = config.safety || {};
      config.safety.maxPerTradeSol = saved.maxPerTradeSol;
    }
    if (typeof saved.maxSolExposure === 'number' && saved.maxSolExposure > 0) {
      config.strategies.global.maxSolExposure = saved.maxSolExposure;
    }
    if (typeof saved.maxEntrySlippagePct === 'number' && saved.maxEntrySlippagePct >= 0 && saved.maxEntrySlippagePct <= 1) {
      config.safety = config.safety || {};
      config.safety.maxEntrySlippagePct = saved.maxEntrySlippagePct;
    }
    // paperLatencyMs is NO LONGER auto-loaded from saved limits — paper.js now
    // reads live-measured latency from the live-conditions monitor by default.
    // Saved override only honored if explicitly > 0 (manual force via dashboard).
    if (typeof saved.paperLatencyMs === 'number' && saved.paperLatencyMs > 0 && saved.paperLatencyMs <= 5000) {
      config.paper = config.paper || {};
      config.paper.latencyMs = saved.paperLatencyMs;
    } else {
      // Clear any prior override so live measurement is used.
      if (config.paper) config.paper.latencyMs = 0;
    }
    if (!silent) {
      const latencySource = (config.paper?.latencyMs > 0) ? `${config.paper.latencyMs}ms (override)` : 'live-measured';
      console.log(`[limits] applied: maxPerTradeSol=${config.safety?.maxPerTradeSol} maxSolExposure=${config.strategies.global.maxSolExposure} maxEntrySlippagePct=${config.safety?.maxEntrySlippagePct} paperLatency=${latencySource}`);
    }
    return true;
  } catch (e) {
    if (!silent) console.error('[limits] load failed:', e.message);
    return false;
  }
}

export function pollRuntimeLimits(intervalMs = 3000) {
  applyRuntimeLimits();
  setInterval(() => applyRuntimeLimits(), intervalMs);
}
