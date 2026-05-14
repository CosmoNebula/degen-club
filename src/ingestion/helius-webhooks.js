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
import { leaderboardAddresses, scopedLeaderboardAddresses } from '../scoring/wallet-leaderboard.js';

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
  // Phase 1: union of combined + premig + postmig top-50s. Many wallets
  // overlap so the actual count stays low. Watching all three lets us
  // capture trades from any scoped-leader so their stats stay fresh.
  const top50 = leaderboardAddresses(50);
  const premig50 = scopedLeaderboardAddresses('premig', 50);
  const postmig50 = scopedLeaderboardAddresses('postmig', 50);
  const manual = db().prepare(`SELECT address FROM wallets WHERE manually_tracked = 1`).all().map(r => r.address);
  return [...new Set([...top50, ...premig50, ...postmig50, ...manual])];
}

// Mint addresses we currently hold open positions on. Subscribing the mint
// to the webhook makes Helius push EVERY trade on it (not just trades by
// our tracked wallets). Closes the data gap during fast-moving migrated
// coin holds where DexScreener hasn't indexed pump-amm yet.
function heldMintAddresses() {
  return db().prepare(`
    SELECT DISTINCT m.mint_address
    FROM paper_positions p
    JOIN mints m ON m.mint_address = p.mint_address
    WHERE p.status = 'open' AND m.rugged = 0
  `).all().map(r => r.mint_address);
}

// Phase 2 AMM ingestion (2026-05-13): subscribe to every recently-migrated
// mint so we see post-migration retail trades — not just trades involving
// our top-50 tracked wallets. This lets us discover post-mig hunters who
// don't pre-buy on the bonding curve. Window: 6h since migration (most
// trading action is in the first few hours). Cap: 1500 most recent so we
// stay well under Helius's 100k address-per-webhook limit and don't flood
// our SQLite writer during burst periods.
const POSTMIG_INGESTION_WINDOW_HOURS = 6;
const POSTMIG_INGESTION_CAP = 1500;
function recentlyMigratedMintAddresses() {
  const cutoff = Date.now() - POSTMIG_INGESTION_WINDOW_HOURS * 60 * 60 * 1000;
  return db().prepare(`
    SELECT mint_address FROM mints
    WHERE migrated = 1
      AND rugged = 0
      AND migrated_at IS NOT NULL
      AND migrated_at > ?
    ORDER BY migrated_at DESC
    LIMIT ?
  `).all(cutoff, POSTMIG_INGESTION_CAP).map(r => r.mint_address);
}

function subscriptionAddresses() {
  const wallets = topWallets();
  const heldMints = heldMintAddresses();
  const recentMigratedMints = recentlyMigratedMintAddresses();
  return {
    combined: [...new Set([...wallets, ...heldMints, ...recentMigratedMints])],
    wallets, heldMints, recentMigratedMints,
  };
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

async function deleteWebhook(webhookID) {
  await fetchWithRetry(
    `https://api.helius.xyz/v0/webhooks/${webhookID}?api-key=${HELIUS_API_KEY}`,
    { method: 'DELETE' },
    'delete webhook'
  );
}

export async function syncHunterWebhook() {
  if (!HELIUS_API_KEY) { console.warn('[helius-wh] HELIUS_API_KEY missing — skipping'); return; }
  if (!WEBHOOK_URL) { console.warn('[helius-wh] HELIUS_WEBHOOK_URL missing — skipping'); return; }

  const { combined: addresses, wallets, heldMints, recentMigratedMints } = subscriptionAddresses();
  if (!addresses.length) { console.log('[helius-wh] no addresses to subscribe — skipping'); return; }

  if (!_webhookId) {
    const existing = await listExistingWebhooks().catch(() => []);
    const ours = existing.find(w => w.webhookURL === WEBHOOK_URL);
    if (ours) _webhookId = ours.webhookID;
    // Orphan cleanup — any webhook on this Helius project whose URL doesn't
    // match our current WEBHOOK_URL is left over from a previous Quick Tunnel
    // session that Cloudflare recycled. Helius keeps trying to POST events to
    // those dead URLs and burns credits on every failure. Delete them.
    // Safe because: the API key is project-scoped, so listExistingWebhooks
    // only returns webhooks WE registered — there's nothing else to clobber.
    const orphans = existing.filter(w => w.webhookURL !== WEBHOOK_URL);
    for (const orphan of orphans) {
      try {
        await deleteWebhook(orphan.webhookID);
        console.log(`[helius-wh] deleted orphan webhook ${orphan.webhookID} (was: ${orphan.webhookURL})`);
      } catch (err) {
        console.warn(`[helius-wh] could not delete orphan ${orphan.webhookID}: ${err.message}`);
      }
    }
  }

  const summary = `${addresses.length} addrs (${wallets.length} wallets + ${heldMints.length} held + ${recentMigratedMints.length} recent-mig)`;
  if (_webhookId) {
    if (!addressesChanged(_lastSyncedAddresses, addresses)) {
      console.log(`[helius-wh] skip — address list unchanged · ${summary}`);
      return;
    }
    await updateWebhook(_webhookId, addresses);
    _lastSyncedAddresses = addresses;
    console.log(`[helius-wh] updated webhook ${_webhookId} · ${summary}`);
  } else {
    const created = await createWebhook(addresses);
    _webhookId = created.webhookID;
    _lastSyncedAddresses = addresses;
    console.log(`[helius-wh] created webhook ${_webhookId} · ${summary}`);
  }
}

// Debounced re-sync triggered when positions open/close. Multiple position
// changes within a short window batch into one Helius API call. The webhook
// PUT itself costs 100 credits — debouncing prevents burst opens from
// hammering the API.
let _debounceTimer = null;
export function triggerWebhookResync() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    syncHunterWebhook().catch(err => console.error('[helius-wh] resync', err.message));
  }, 3000);
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
