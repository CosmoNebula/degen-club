import { db } from '../db/index.js';
import { config } from '../config.js';

let _halted = false;
let _haltReason = null;
let _haltedAt = null;

export function isHalted() { return _halted; }
export function haltReason() { return _haltReason; }
export function haltedAt() { return _haltedAt; }

export function halt(reason) {
  if (_halted) return;
  _halted = true;
  _haltReason = reason;
  _haltedAt = Date.now();
  console.log(`[SAFETY] 🛑 HALTED: ${reason}`);
}

export function resume() {
  console.log(`[SAFETY] ✅ resumed (was halted: ${_haltReason})`);
  _halted = false;
  _haltReason = null;
  _haltedAt = null;
}

export function checkPreTrade(strategyName, entrySol) {
  if (_halted) return { ok: false, reason: `system halted: ${_haltReason}` };

  const limits = config.safety || {};
  const maxPerTrade = limits.maxPerTradeSol || 0.5;
  if (entrySol > maxPerTrade) {
    return { ok: false, reason: `entry ${entrySol} > max-per-trade ${maxPerTrade}` };
  }

  return { ok: true };
}

export function getStatus() {
  return {
    halted: _halted,
    reason: _haltReason,
    haltedAt: _haltedAt,
    limits: {
      maxPerTradeSol: config.safety?.maxPerTradeSol || 0.5,
      dailyMaxLossSol: config.safety?.dailyMaxLossSol || 0.5,
    },
  };
}
