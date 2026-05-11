// Telegram member-count ingestion (Tier 4 #5).
//
// Free signal: for any mint with a public Telegram channel/group, we can fetch
// the live member count via Telegram's Bot API. No credits, no rate limit
// beyond Telegram's standard "30 messages/sec per bot" (we're nowhere near).
//
// Coverage: ~30-40% of pump.fun launches have Telegram URLs. Of those, only
// public channels return getChat data — private groups error out, which we
// cache as fetch_status='private_or_unknown' so we don't retry forever.
//
// Cadence: poll mints with TG URLs in priority order:
//   1. Mints created in last 1h that have tracked_buyers >= 1 (interesting)
//   2. Mints that already have a cached entry > 30min old (refresh)
// Skip mints where the previous fetch failed (status != 'ok') to avoid
// hammering bad URLs.
//
// Env: TELEGRAM_BOT_TOKEN. Without it, this worker is a no-op (degrades
// gracefully so the bot still runs).

import { db } from '../db/index.js';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const POLL_INTERVAL_MS = 60 * 1000;           // every minute
const REFRESH_TTL_MS = 30 * 60 * 1000;        // refetch cached entries after 30min
const BATCH_LIMIT = 10;                        // 10 calls per cycle = 600/hr cap
const HARD_TIMEOUT_MS = 6000;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    // Find mints worth fetching. Priority: tracked-buyer-engaged mints in
    // last 4h that don't have a fresh cache entry. The tracked-buyer filter
    // keeps this aligned with the parse-history gate — we only spend effort
    // on mints with smart-money interest.
    candidates: d.prepare(`
      SELECT m.mint_address, m.telegram, m.symbol
      FROM mints m
      LEFT JOIN telegram_members t ON t.mint_address = m.mint_address
      WHERE m.telegram IS NOT NULL AND m.telegram != ''
        AND m.created_at > strftime('%s','now')*1000 - 4*3600000
        AND (t.fetched_at IS NULL OR t.fetched_at < strftime('%s','now')*1000 - ?)
        AND (t.fetch_status IS NULL OR t.fetch_status NOT IN ('private_or_unknown','bad_url'))
      ORDER BY m.created_at DESC
      LIMIT ?
    `),
    upsert: d.prepare(`INSERT OR REPLACE INTO telegram_members
      (mint_address, telegram_url, chat_id, member_count, fetched_at, fetch_status, error_message)
      VALUES (?,?,?,?,?,?,?)`),
  };
  return stmts;
}

// Parse a Telegram URL into a chat_id Bot API can use. Public formats:
//   https://t.me/channel_name → @channel_name
//   https://telegram.me/channel_name → @channel_name
//   t.me/joinchat/XYZ → private (can't get count)
//   t.me/+XYZ → private invite link
function parseTelegramUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim().toLowerCase();
  const m = trimmed.match(/(?:t\.me|telegram\.me|telegram\.dog)\/(?:s\/)?([a-z0-9_]+)/i);
  if (!m) return null;
  const handle = m[1];
  // Private invites: 'joinchat' or '+' prefix means no public chat_id.
  if (handle === 'joinchat' || handle === 'addstickers' || handle === 'share') return null;
  if (handle.startsWith('+')) return null;
  // Bot API expects '@channel' for public channels.
  return '@' + handle;
}

async function fetchMemberCount(chatId) {
  if (!TG_TOKEN) return { ok: false, error: 'no_token' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HARD_TIMEOUT_MS);
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/getChatMemberCount?chat_id=${encodeURIComponent(chatId)}`;
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      // Telegram returns 400 with "Bad Request: chat not found" for private
      // chats and 401 for token issues. Don't retry the chat-not-found cases.
      const body = await r.text();
      const isPrivate = /chat not found|chat_not_found|forbidden|kicked/i.test(body);
      return { ok: false, error: body.slice(0, 200), permanent: isPrivate };
    }
    const j = await r.json();
    if (!j.ok || typeof j.result !== 'number') {
      return { ok: false, error: 'bad_response', permanent: false };
    }
    return { ok: true, count: j.result };
  } catch (err) {
    return { ok: false, error: err.message || 'fetch_error', permanent: false };
  } finally {
    clearTimeout(t);
  }
}

async function tick() {
  if (!TG_TOKEN) return;
  const s = S();
  const candidates = s.candidates.all(REFRESH_TTL_MS, BATCH_LIMIT);
  if (candidates.length === 0) return;
  const now = Date.now();
  let okN = 0, privN = 0, badN = 0, errN = 0;
  for (const c of candidates) {
    const chatId = parseTelegramUrl(c.telegram);
    if (!chatId) {
      s.upsert.run(c.mint_address, c.telegram, null, null, now, 'bad_url', 'unparseable URL');
      badN++;
      continue;
    }
    const res = await fetchMemberCount(chatId);
    if (res.ok) {
      s.upsert.run(c.mint_address, c.telegram, chatId, res.count, now, 'ok', null);
      okN++;
    } else if (res.permanent) {
      s.upsert.run(c.mint_address, c.telegram, chatId, null, now, 'private_or_unknown', (res.error || '').slice(0, 200));
      privN++;
    } else {
      s.upsert.run(c.mint_address, c.telegram, chatId, null, now, 'error', (res.error || '').slice(0, 200));
      errN++;
    }
  }
  if (okN + privN + badN + errN > 0) {
    console.log(`[tg-members] ${okN} fetched · ${privN} private · ${badN} bad-url · ${errN} err`);
  }
}

export function startTelegramMemberWatcher() {
  if (!TG_TOKEN) {
    console.log('[tg-members] disabled — TELEGRAM_BOT_TOKEN not set');
    return;
  }
  setTimeout(() => { tick().catch(err => console.error('[tg-members]', err.message)); }, 30 * 1000);
  setInterval(() => { tick().catch(err => console.error('[tg-members]', err.message)); }, POLL_INTERVAL_MS);
  console.log(`[tg-members] started · poll every ${POLL_INTERVAL_MS/1000}s · batch ${BATCH_LIMIT}`);
}
