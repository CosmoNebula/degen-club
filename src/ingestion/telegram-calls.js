// Telegram calls broadcaster.
//
// When the bot enters a paper position that meets a high-conviction bar, post
// a formatted "call" to a configured Telegram group. The bot already has
// TELEGRAM_BOT_TOKEN from the member-count watcher; this module reuses it.
//
// Setup:
//   1. Add the bot (@DegenClubCallsBot) to your Telegram group as an admin
//      (admin required only for some group types; for most groups any bot
//      with a chat_id can send messages).
//   2. Find the group's chat_id — easiest method: temporarily set
//      TG_CALLS_CHAT_ID_AUTODETECT=1 in .env, send any message in the group,
//      and the bot's first poll will log the chat_id to the console. Then
//      set TG_CALLS_CHAT_ID to that value and remove the autodetect flag.
//   3. Restart the bot. Calls start flowing.
//
// Quality gates (any-of triggers a post; all-of would be too strict):
//   - peaked_100 ≥ 0.15  (top-quartile-ish given calibration)
//   - migrated ≥ 0.15
//   - tracked_buyers ≥ 2  (smart money already in)
// AND rate limit: max 6 posts per rolling 60min.
// AND dedup: same mint not posted within 24h.

import { db } from '../db/index.js';
import { getSolUsd } from '../price.js';

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
function toSubscript(n) {
  return String(n).split('').map((d) => SUBSCRIPT_DIGITS[d] || d).join('');
}

function fmtUsd(usd) {
  if (!usd || usd <= 0) return '$0';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd >= 0.0001) {
    // 4–5 significant digits, trim trailing zeros
    return `$${usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  }
  // Sub-$0.0001 — use DexScreener-style subscript-zero notation.
  // $0.00000629 → $0.0₅629 (5 leading zeros, then 3 sig digits)
  const fixed = usd.toFixed(20);
  const m = fixed.match(/^0\.(0+)(\d{1,3})/);
  if (!m) return `$${usd.toExponential(2)}`;
  const zeros = m[1].length;
  const sig = m[2];
  return `$0.0${toSubscript(zeros)}${sig}`;
}

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TG_CALLS_CHAT_ID || '';
const AUTODETECT = process.env.TG_CALLS_CHAT_ID_AUTODETECT === '1';

// Userbot config — when set, posts via the user's TG account instead of
// the bot. Required for Phanes and other call-trackers that filter
// is_bot=true messages.
const TG_USER_API_ID = Number(process.env.TG_USER_API_ID) || 0;
const TG_USER_API_HASH = process.env.TG_USER_API_HASH || '';
const TG_USER_SESSION = process.env.TG_USER_SESSION || '';
const USERBOT_ENABLED = !!(TG_USER_API_ID && TG_USER_API_HASH && TG_USER_SESSION);

let _userClient = null;
let _userClientReady = false;
let _userClientStarting = false;
let _resolvedChatPeer = null;

async function getUserClient() {
  if (_userClient && _userClientReady) return _userClient;
  if (_userClientStarting) return null;
  if (!USERBOT_ENABLED) return null;
  _userClientStarting = true;
  try {
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');
    const session = new StringSession(TG_USER_SESSION);
    const client = new TelegramClient(session, TG_USER_API_ID, TG_USER_API_HASH, {
      connectionRetries: 5,
    });
    client.setLogLevel?.('error');
    await client.connect();
    _userClient = client;
    _userClientReady = true;
    console.log('[tg-calls] userbot connected — posting via user account');
    return client;
  } catch (err) {
    console.log(`[tg-calls] userbot connect failed: ${err.message} — falling back to bot API`);
    return null;
  } finally {
    _userClientStarting = false;
  }
}

async function sendViaUserbot(text, chatId) {
  const client = await getUserClient();
  if (!client) return { ok: false, error: 'userbot unavailable' };
  try {
    if (!_resolvedChatPeer) {
      // Supergroup IDs come in as -100xxxxxxxxxx; gramjs accepts numeric.
      _resolvedChatPeer = await client.getEntity(Number(chatId));
    }
    await client.sendMessage(_resolvedChatPeer, {
      message: text,
      parseMode: 'html',
      linkPreview: true,
    });
    return { ok: true };
  } catch (err) {
    // Reset peer cache on failure (entity may have changed)
    _resolvedChatPeer = null;
    return { ok: false, error: err.message };
  }
}

const MAX_PER_HOUR = 6;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_PEAKED_100 = 0.15;
const MIN_MIGRATED = 0.15;
const MIN_TRACKED_BUYERS = 2;

// In-memory state — rate limit + dedup. Resets on restart (acceptable; we
// don't want stale dedups blocking after a long outage).
const _recentPosts = []; // timestamps
const _postedMints = new Map(); // mint_address → ts

let _autoDetectInflight = false;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Pretty display name for a strategy.
//
// Raw IDs look like 'agent_2026-05-08_peaked30-elite-quickflip-v1'. We:
//   1) Try ml_agent_strategies.name (agent's chosen name — usually cleaner)
//   2) Strip the 'agent_YYYY-MM-DD_' prefix from raw ID as fallback
//   3) Strip trailing '-v\d+' version suffix
//   4) Convert kebab-case → Title Case (with versioning preserved separately)
//
// Examples:
//   agent_2026-05-08_peaked30-elite-quickflip-v1
//     → "Peaked30 Elite Quickflip" (v1)
//   agent_2026-05-11_kol-snipe-v2
//     → "Kol Snipe" (v2)
function prettifyStrategyName(rawStrategy) {
  if (!rawStrategy || typeof rawStrategy !== 'string') return String(rawStrategy || 'unknown');
  let s = '';
  try {
    const row = db().prepare('SELECT name FROM ml_agent_strategies WHERE id = ?').get(rawStrategy);
    if (row?.name && row.name.trim()) s = row.name.trim();
  } catch { /* fall through */ }
  if (!s) s = rawStrategy;
  // Strip "agent_YYYY-MM-DD_" prefix (in case the DB name has it too).
  s = s.replace(/^agent_\d{4}-\d{2}-\d{2}_/, '');
  // Strip "-v\d+" version suffix.
  s = s.replace(/-v\d+$/, '');
  // Optional: kebab-case → Title Case. Each '-' becomes a space, first
  // char of each segment capitalized. Numbers stay attached to their word.
  s = s.split('-')
    .map(part => part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
  return s.trim() || rawStrategy;
}

function isHighConviction(predictions, features) {
  if (!predictions && !features) return false;
  const p100 = predictions?.peaked_100 || 0;
  const mig = predictions?.migrated || 0;
  const tracked = features?.tracked_buyers || 0;
  return p100 >= MIN_PEAKED_100 || mig >= MIN_MIGRATED || tracked >= MIN_TRACKED_BUYERS;
}

function formatCall({ mint, strategy, entryPrice, entrySol, entryMcap, predictions, features }) {
  const symbol = mint.symbol || '?';
  const name = (mint.name && mint.name !== symbol) ? mint.name : null;
  const solUsd = getSolUsd() || 0;
  const mcapUsd = entryMcap * solUsd;
  const priceUsd = entryPrice * solUsd;
  const sizeUsd = entrySol * solUsd;
  const lines = [];
  lines.push(`🚀 <b>NEW CALL: $${escapeHtml(symbol)}</b>`);
  if (name) lines.push(`<i>${escapeHtml(name)}</i>`);
  lines.push('');
  lines.push(`Strategy: <b>${escapeHtml(prettifyStrategyName(strategy))}</b>`);
  lines.push(`Mcap: <b>${fmtUsd(mcapUsd)}</b>  ·  Entry: ${fmtUsd(priceUsd)}`);
  lines.push(`Size: ${fmtUsd(sizeUsd)}  <i>(${entrySol.toFixed(3)} SOL)</i>`);
  // Predicted peak — the regression model's forecast for max % gain from
  // snapshot to peak. Phanes (or any call-tracker) can compare this against
  // the realized peak to score the model's accuracy publicly.
  const predPeak = predictions?.peak_pct_max;
  if (predPeak != null && predPeak > 0.05) {
    const pctStr = `+${(predPeak * 100).toFixed(0)}%`;
    const targetMcapUsd = mcapUsd * (1 + predPeak);
    lines.push(`Predicted peak: <b>${pctStr}</b>  →  ${fmtUsd(targetMcapUsd)} mcap`);
  }
  // Predicted time-to-peak — when the model thinks the peak hits. Helps set
  // hold-time expectations for anyone following.
  const ttpSec = predictions?.time_to_peak_sec;
  if (ttpSec != null && ttpSec > 0) {
    const ttpStr = ttpSec < 60
      ? `${Math.round(ttpSec)}s`
      : ttpSec < 3600
        ? `${(ttpSec / 60).toFixed(1)}m`
        : `${(ttpSec / 3600).toFixed(1)}h`;
    lines.push(`Predicted time-to-peak: ${ttpStr}`);
  }
  lines.push('');
  const signalLines = [];
  if (predictions?.peaked_100 != null) signalLines.push(`peaked_100: ${(predictions.peaked_100 * 100).toFixed(0)}%`);
  if (predictions?.peaked_300 != null && predictions.peaked_300 >= 0.05) signalLines.push(`peaked_300: ${(predictions.peaked_300 * 100).toFixed(0)}%`);
  if (predictions?.migrated != null) signalLines.push(`migrated: ${(predictions.migrated * 100).toFixed(0)}%`);
  if (predictions?.hits_2x_within_1h != null && predictions.hits_2x_within_1h >= 0.05) signalLines.push(`2x/1h: ${(predictions.hits_2x_within_1h * 100).toFixed(0)}%`);
  if (predictions?.will_die_fast != null) signalLines.push(`die_fast: ${(predictions.will_die_fast * 100).toFixed(0)}%`);
  if ((features?.tracked_buyers || 0) > 0) signalLines.push(`tracked: ${features.tracked_buyers}`);
  if ((features?.kol_buyers || 0) > 0) signalLines.push(`KOLs: ${features.kol_buyers}`);
  if ((features?.narrative_match_count || 0) > 0) signalLines.push(`narrative: ${features.narrative_match_count}`);
  if ((features?.telegram_member_count || 0) > 0) signalLines.push(`tg: ${features.telegram_member_count} members`);
  if (signalLines.length > 0) {
    lines.push('Signals:');
    for (const line of signalLines) lines.push(`  • ${line}`);
    lines.push('');
  }
  lines.push(`<a href="https://pump.fun/${mint.mint_address}">View on pump.fun</a>`);
  lines.push('');
  // Plain-text CA on its own line — call trackers (Phanes, etc.) scan for
  // raw Solana addresses outside HTML entities. Wrapping in <code> hid the
  // address from Phanes during the 2026-05-11 test send.
  lines.push(mint.mint_address);
  return lines.join('\n');
}

async function sendTelegram(text, chatId) {
  if (!TG_TOKEN || !chatId) return { ok: false, error: 'missing config' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { ok: false, error: `HTTP ${res.status} ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

// Lazy-fetch latest ml_predictions for a mint if predictions aren't provided.
function fetchLatestPredictions(mintAddress) {
  try {
    const rows = db().prepare(`
      SELECT target, prob FROM ml_predictions
      WHERE mint_address = ?
        AND prob IS NOT NULL
        AND timestamp > strftime('%s','now')*1000 - 3600000
      GROUP BY target
      HAVING timestamp = MAX(timestamp)
    `).all(mintAddress);
    const preds = {};
    for (const r of rows) preds[r.target] = r.prob;
    return preds;
  } catch { return {}; }
}

// Main entry — called from paper.js after a position is fully filled.
// Fire-and-forget; never throws back to the trade pipeline.
export async function postCall({ mint, strategy, entryPrice, entrySol, entryMcap, predictions, features }) {
  try {
    if (!TG_TOKEN || !CHAT_ID) return;
    if (!mint?.mint_address) return;
    // Dedup
    const last = _postedMints.get(mint.mint_address);
    if (last && Date.now() - last < DEDUP_WINDOW_MS) return;
    // Rate limit
    const oneHrAgo = Date.now() - 3600 * 1000;
    while (_recentPosts.length > 0 && _recentPosts[0] < oneHrAgo) _recentPosts.shift();
    if (_recentPosts.length >= MAX_PER_HOUR) {
      console.log(`[tg-calls] rate-limit ${_recentPosts.length}/${MAX_PER_HOUR}/hr — skipping ${mint.mint_address.slice(0, 8)}…`);
      return;
    }
    // Lazy-fetch predictions if caller didn't provide.
    const preds = predictions || fetchLatestPredictions(mint.mint_address);
    // 2026-05-15 (PM): agent-managed strategies (prefix `agent_*`) own their
    // own gating — their entry conditions are bespoke ML stacks that have
    // already vetted the mint. Bypass the redundant peaked_100/migrated/
    // tracked floor for them (these mints often don't even gate on those
    // features). Legacy strategies still hit the conviction filter.
    const isAgentStrat = typeof strategy === 'string' && strategy.startsWith('agent_');
    if (!isAgentStrat && !isHighConviction(preds, features)) return;
    const text = formatCall({ mint, strategy, entryPrice, entrySol, entryMcap, predictions: preds, features });
    // Prefer userbot (Phanes & similar trackers filter bot messages).
    // Fall back to bot API if userbot isn't configured or connect fails.
    let res, via;
    if (USERBOT_ENABLED) {
      res = await sendViaUserbot(text, CHAT_ID);
      via = res.ok ? 'userbot' : null;
      if (!res.ok) {
        console.log(`[tg-calls] userbot send failed (${res.error}) — trying bot API`);
        res = await sendTelegram(text, CHAT_ID);
        via = res.ok ? 'bot' : null;
      }
    } else {
      res = await sendTelegram(text, CHAT_ID);
      via = res.ok ? 'bot' : null;
    }
    if (!res.ok) {
      console.log(`[tg-calls] send failed for ${mint.mint_address.slice(0, 8)}…: ${res.error}`);
      return;
    }
    _recentPosts.push(Date.now());
    _postedMints.set(mint.mint_address, Date.now());
    console.log(`[tg-calls] posted $${mint.symbol || '?'} (${mint.mint_address.slice(0, 8)}…) via ${via}`);
  } catch (err) {
    console.error('[tg-calls] err:', err.message);
  }
}

// Auto-detect chat_id helper. When TG_CALLS_CHAT_ID_AUTODETECT=1, poll
// getUpdates once per minute, find any new group the bot received a message
// from, and log the chat_id. The user then sets TG_CALLS_CHAT_ID in .env.
// One-time setup convenience — not a long-running listener.
async function autoDetectChatId() {
  if (!AUTODETECT || !TG_TOKEN || _autoDetectInflight) return;
  if (CHAT_ID) return; // already configured
  _autoDetectInflight = true;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=0&limit=20`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const j = await r.json();
    if (!j.ok || !Array.isArray(j.result)) return;
    const seen = new Set();
    for (const update of j.result) {
      const chat = update.message?.chat || update.my_chat_member?.chat;
      if (!chat) continue;
      const tag = `${chat.type}:${chat.id}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      const title = chat.title || chat.username || chat.first_name || '(unnamed)';
      console.log(`[tg-calls] DISCOVERED chat: id=${chat.id} type=${chat.type} title="${title}" — set TG_CALLS_CHAT_ID=${chat.id} to route calls here.`);
    }
  } catch (err) {
    console.log(`[tg-calls] autodetect: ${err.message}`);
  } finally {
    _autoDetectInflight = false;
  }
}

export function startTelegramCallsBroadcaster() {
  if (!TG_TOKEN) {
    console.log('[tg-calls] disabled — TELEGRAM_BOT_TOKEN not set');
    return;
  }
  if (AUTODETECT) {
    console.log('[tg-calls] autodetect mode ON — send a message in any group the bot is in to discover its chat_id');
    setInterval(autoDetectChatId, 60 * 1000);
    setTimeout(autoDetectChatId, 5 * 1000);
  }
  if (!CHAT_ID) {
    console.log('[tg-calls] no TG_CALLS_CHAT_ID set — calls disabled. Set TG_CALLS_CHAT_ID_AUTODETECT=1 to discover via Telegram updates.');
    return;
  }
  console.log(`[tg-calls] started · posting calls to chat_id=${CHAT_ID} · max ${MAX_PER_HOUR}/hr · conviction floor: p100≥${MIN_PEAKED_100} OR mig≥${MIN_MIGRATED} OR tracked≥${MIN_TRACKED_BUYERS}`);
  if (USERBOT_ENABLED) {
    console.log('[tg-calls] userbot mode — pre-warming connection');
    getUserClient().catch((err) => console.log(`[tg-calls] userbot prewarm err: ${err.message}`));
  } else {
    console.log('[tg-calls] bot-API mode (no userbot session) — Phanes/trackers may filter these');
  }
}
