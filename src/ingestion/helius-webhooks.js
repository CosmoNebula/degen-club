// Helius webhook manager: maintains ONE webhook listing the top migrator-hunter
// wallets. Helius pushes their on-chain activity to our /api/webhook/helius-hunters
// endpoint, where we parse it as trade events and feed into the same pipeline
// PumpPortal trades used to drive.
//
// Free Helius tier supports up to 10 webhooks; we use 1.
//
// Refresh cadence: every hour. We pull top N migrator-scored wallets + a manual
// override list, recompute the webhook's account list, and PUT it via Helius API.

import { db } from '../db/index.js';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const WEBHOOK_URL = process.env.HELIUS_WEBHOOK_URL || ''; // public URL we expose
const HUNTER_LIMIT = 200;
const HUNTER_MIN_SCORE = 0.55;
const HUNTER_MIN_SAMPLE = 5;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

let _webhookId = null;

function topHunters() {
  return db().prepare(`
    SELECT address FROM wallets
    WHERE migrator_score >= ?
      AND migrator_pre_mig_buys >= ?
      AND COALESCE(auto_blocked, 0) = 0
    ORDER BY migrator_score DESC LIMIT ?
  `).all(HUNTER_MIN_SCORE, HUNTER_MIN_SAMPLE, HUNTER_LIMIT).map(r => r.address);
}

async function listExistingWebhooks() {
  const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`);
  if (!res.ok) throw new Error(`list webhooks: HTTP ${res.status}`);
  return res.json();
}

async function createWebhook(addresses) {
  const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      webhookURL: WEBHOOK_URL,
      transactionTypes: ['Any'],
      accountAddresses: addresses,
      webhookType: 'enhanced',
    }),
  });
  if (!res.ok) throw new Error(`create webhook: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateWebhook(webhookID, addresses) {
  const res = await fetch(`https://api.helius.xyz/v0/webhooks/${webhookID}?api-key=${HELIUS_API_KEY}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      webhookURL: WEBHOOK_URL,
      transactionTypes: ['Any'],
      accountAddresses: addresses,
      webhookType: 'enhanced',
    }),
  });
  if (!res.ok) throw new Error(`update webhook: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

export async function syncHunterWebhook() {
  if (!HELIUS_API_KEY) { console.warn('[helius-wh] HELIUS_API_KEY missing — skipping'); return; }
  if (!WEBHOOK_URL) { console.warn('[helius-wh] HELIUS_WEBHOOK_URL missing — skipping'); return; }

  const addresses = topHunters();
  if (!addresses.length) { console.log('[helius-wh] no qualifying hunters yet — skipping'); return; }

  if (!_webhookId) {
    const existing = await listExistingWebhooks().catch(() => []);
    const ours = existing.find(w => w.webhookURL === WEBHOOK_URL);
    if (ours) _webhookId = ours.webhookID;
  }

  if (_webhookId) {
    await updateWebhook(_webhookId, addresses);
    console.log(`[helius-wh] updated webhook ${_webhookId} · ${addresses.length} hunters`);
  } else {
    const created = await createWebhook(addresses);
    _webhookId = created.webhookID;
    console.log(`[helius-wh] created webhook ${_webhookId} · ${addresses.length} hunters`);
  }
}

export function startHeliusWebhookSync() {
  syncHunterWebhook().catch(err => console.error('[helius-wh] initial sync', err.message));
  setInterval(() => {
    syncHunterWebhook().catch(err => console.error('[helius-wh] sync', err.message));
  }, REFRESH_INTERVAL_MS);
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
      console.error('[helius-wh] parse', err.message);
    }
  }
  return out;
}
