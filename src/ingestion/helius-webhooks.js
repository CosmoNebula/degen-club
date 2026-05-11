// Helius webhook manager: maintains ONE webhook listing the top-50 leaderboard
// wallets (see src/scoring/wallet-leaderboard.js). Helius pushes their on-chain
// activity to our /api/webhook/helius-hunters endpoint, where we parse it as
// trade events and feed the same pipeline PumpPortal trades used to drive.
//
// Free Helius tier supports up to 10 webhooks; we use 1. By limiting webhooks
// to the top 50 instead of the old 200-hunter list, we cut Helius credit usage
// roughly 4x while concentrating signal on our highest-scoring wallets.
//
// Refresh cadence: hourly, in lockstep with leaderboard recompute. Manually
// tracked wallets (manually_tracked = 1) are always included regardless of rank.

import { db } from '../db/index.js';
import { leaderboardAddresses } from '../scoring/wallet-leaderboard.js';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const WEBHOOK_URL = process.env.HELIUS_WEBHOOK_URL || '';
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

let _webhookId = null;
// Track the address list we last pushed so we don't burn 100 credits per
// hour PUT-ing the exact same list back to Helius. Most hours the top-50
// doesn't change at all — the rare leaderboard shuffle is the only time we
// actually need to update Helius.
let _lastSyncedAddresses = null;

function addressesChanged(prev, next) {
  if (!prev) return true;
  if (prev.length !== next.length) return true;
  const a = [...prev].sort();
  const b = [...next].sort();
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

function topWallets() {
  const top50 = leaderboardAddresses(50);
  // Always include manually-tracked wallets even if not on the leaderboard.
  const manual = db().prepare(`SELECT address FROM wallets WHERE manually_tracked = 1`).all().map(r => r.address);
  return [...new Set([...top50, ...manual])];
}

// Retry wrapper for Helius API calls. Network blips + transient 5xx errors
// are common; without retry we'd wait 60 min for the next sync. We retry up
// to 3 times on 5xx + network errors only — 4xx (auth, bad request) won't
// improve on retry and are surfaced immediately.
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchWithRetry(url, opts = {}, label = 'helius') {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500) {
        // 4xx is permanent — don't retry. Surface the body for debugging.
        throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
      }
      lastErr = new Error(`${label}: HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < MAX_ATTEMPTS) {
      const delay = 500 * Math.pow(3, attempt - 1); // 500ms, 1500ms, 4500ms
      console.warn(`[helius-wh] ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastErr.message}) — retrying in ${delay}ms`);
      await _sleep(delay);
    }
  }
  throw lastErr;
}

async function listExistingWebhooks() {
  const res = await fetchWithRetry(
    `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
    {},
    'list webhooks'
  );
  return res.json();
}

async function createWebhook(addresses) {
  const res = await fetchWithRetry(
    `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookURL: WEBHOOK_URL,
        transactionTypes: ['Any'],
        accountAddresses: addresses,
        webhookType: 'enhanced',
      }),
    },
    'create webhook'
  );
  return res.json();
}

async function updateWebhook(webhookID, addresses) {
  const res = await fetchWithRetry(
    `https://api.helius.xyz/v0/webhooks/${webhookID}?api-key=${HELIUS_API_KEY}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhookURL: WEBHOOK_URL,
        transactionTypes: ['Any'],
        accountAddresses: addresses,
        webhookType: 'enhanced',
      }),
    },
    'update webhook'
  );
  return res.json();
}

export async function syncHunterWebhook() {
  if (!HELIUS_API_KEY) { console.warn('[helius-wh] HELIUS_API_KEY missing — skipping'); return; }
  if (!WEBHOOK_URL) { console.warn('[helius-wh] HELIUS_WEBHOOK_URL missing — skipping'); return; }

  const addresses = topWallets();
  if (!addresses.length) { console.log('[helius-wh] no leaderboard wallets yet — skipping'); return; }

  if (!_webhookId) {
    const existing = await listExistingWebhooks().catch(() => []);
    const ours = existing.find(w => w.webhookURL === WEBHOOK_URL);
    if (ours) _webhookId = ours.webhookID;
  }

  if (_webhookId) {
    if (!addressesChanged(_lastSyncedAddresses, addresses)) {
      console.log(`[helius-wh] skip — address list unchanged (${addresses.length} wallets)`);
      return;
    }
    await updateWebhook(_webhookId, addresses);
    _lastSyncedAddresses = addresses;
    console.log(`[helius-wh] updated webhook ${_webhookId} · ${addresses.length} top-50+manual`);
  } else {
    const created = await createWebhook(addresses);
    _webhookId = created.webhookID;
    _lastSyncedAddresses = addresses;
    console.log(`[helius-wh] created webhook ${_webhookId} · ${addresses.length} top-50+manual`);
  }
}

export function startHeliusWebhookSync() {
  // Wait 90s on startup so the leaderboard's first compute (60s after start)
  // has populated. Otherwise we'd push an empty webhook on a fresh boot.
  setTimeout(() => {
    syncHunterWebhook().catch(err => console.error('[helius-wh] initial sync', err.message));
  }, 90 * 1000);
  setInterval(() => {
    syncHunterWebhook().catch(err => console.error('[helius-wh] sync', err.message));
  }, REFRESH_INTERVAL_MS);
}

// Dead-letter for events that fail to parse. Captures raw payload + error
// so we can diagnose schema drift or unexpected event types. Statement is
// lazily prepared so this module can be imported in contexts where the DB
// isn't fully migrated yet (test harness, etc).
let _dlStmt = null;
function _writeDeadLetter(ev, errMsg) {
  try {
    if (!_dlStmt) {
      _dlStmt = db().prepare(`INSERT INTO webhook_dead_letter
        (received_at, source, event_signature, error_message, raw_event_json)
        VALUES (?, 'helius', ?, ?, ?)`);
    }
    _dlStmt.run(
      Date.now(),
      ev?.signature || null,
      String(errMsg).slice(0, 500),
      JSON.stringify(ev).slice(0, 8000)  // cap to avoid huge rows
    );
  } catch (e) {
    // Never throw from the parser. If even the dead-letter write fails, at
    // least we have the console log.
    console.error('[helius-wh] dead-letter write failed:', e.message);
  }
}

// Parse an incoming Helius enhanced webhook payload into our normalized trade
// shape (matches what processor expects from PumpPortal events).
// Returns array of { mint, wallet, is_buy, sol_amount, token_amount } or [] if no relevant trades.
export function parseHeliusWebhook(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const ev of events) {
    try {
      // Helius enhanced format: events[].events.swap or .nft, with .nativeTransfers / .tokenTransfers
      const wallet = ev.feePayer || ev.accountData?.[0]?.account;
      if (!wallet) continue;

      const tokenTransfers = ev.tokenTransfers || [];
      const nativeTransfers = ev.nativeTransfers || [];

      // For each token movement involving the wallet, check if SOL also moved (= a buy/sell)
      for (const tt of tokenTransfers) {
        if (tt.fromUserAccount !== wallet && tt.toUserAccount !== wallet) continue;
        const isReceiving = tt.toUserAccount === wallet;
        // Match a SOL transfer in opposite direction to detect buy/sell
        const solDelta = nativeTransfers
          .filter(nt => isReceiving ? nt.fromUserAccount === wallet : nt.toUserAccount === wallet)
          .reduce((s, nt) => s + (nt.amount || 0), 0);
        if (solDelta <= 0) continue;
        out.push({
          mint: tt.mint,
          wallet,
          is_buy: isReceiving ? 1 : 0,
          sol_amount: solDelta / 1e9,
          token_amount: Number(tt.tokenAmount) || 0,
          signature: ev.signature,
          timestamp: (ev.timestamp || Math.floor(Date.now() / 1000)) * 1000,
        });
      }
    } catch (err) {
      // Don't just log — write the raw event to dead-letter so we can
      // diagnose what schema shape blew up the parser. Cheap insert.
      console.error('[helius-wh] parse', err.message);
      _writeDeadLetter(ev, err.message);
    }
  }
  return out;
}
