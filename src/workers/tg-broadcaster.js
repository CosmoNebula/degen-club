// workers/tg-broadcaster.js — TG channel narration + calls.
//
// Two posters running off the same DB poll, posting to the same TG channel:
//
//   1. COSMO CALLS — when bot opens a high-conviction position, post a formal
//      "call" formatted like a tracker-friendly signal (Phanes/Ray-readable).
//      Uses gramjs userbot so it posts as the user's account (call trackers
//      filter is_bot=true).
//
//   2. VIKTOR NARRATOR — running commentary on bot events in Viktor's voice
//      (old Russian hacker gone vibecoder, persona from /opt/degen-club/.../memory).
//      Templated phrase banks — no LLM. Posts on tier hits, closes, big runs,
//      tuner adjustments, restarts. Uses bot API (simpler, doesn't need to be
//      tracker-friendly).
//
// Both posters watch paper_positions + bot_runtime_settings via cheap polls
// (no hooks into bot.js or paper.js — purely external observer).

import { db } from '../db.js';
import { Agent, setGlobalDispatcher } from 'undici';

// VM has broken IPv6 to Telegram (curl -6 fails instantly, -4 works). Node's
// fetch tries IPv6 first and stalls. dns.setDefaultResultOrder didn't catch it.
// Force IPv4 connections at the undici layer — bulletproof. Affects all
// fetches in the process; everything else (Helius, DexScreener, Coingecko)
// is IPv4-friendly so this is a clean global win.
setGlobalDispatcher(new Agent({ connect: { family: 4, timeout: 10_000 } }));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TG_CALLS_CHAT_ID || '';
const TG_USER_API_ID = Number(process.env.TG_USER_API_ID) || 0;
const TG_USER_API_HASH = process.env.TG_USER_API_HASH || '';
const TG_USER_SESSION = process.env.TG_USER_SESSION || '';
const USERBOT_ENABLED = !!(TG_USER_API_ID && TG_USER_API_HASH && TG_USER_SESSION);

const POLL_MS = 8_000;
const MAX_CALLS_PER_HOUR = 30;       // bot can open many per hour; cap is just a runaway guard
const CALL_DEDUP_MS = 24 * 3600 * 1000;
// Cosmo calls every coin the bot buys. No conviction gate — if bot opens it,
// Cosmo posts it.

// =========================================================================
// SOL/USD price (cheap coingecko fetch w/ 5min cache)
// =========================================================================
let _solUsd = 145;
let _solUsdAt = 0;
async function getSolUsd() {
  if (Date.now() - _solUsdAt < 5 * 60_000) return _solUsd;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      const px = j?.solana?.usd;
      if (px && px > 0 && px < 10000) { _solUsd = px; _solUsdAt = Date.now(); }
    }
  } catch {}
  return _solUsd;
}

// =========================================================================
// USERBOT (gramjs) — lazy connect
// =========================================================================
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
    const client = new TelegramClient(session, TG_USER_API_ID, TG_USER_API_HASH, { connectionRetries: 5 });
    client.setLogLevel?.('error');
    await client.connect();
    _userClient = client;
    _userClientReady = true;
    console.log('[tg] userbot connected');
    return client;
  } catch (err) {
    console.log(`[tg] userbot connect failed: ${err.message}`);
    return null;
  } finally {
    _userClientStarting = false;
  }
}

async function sendViaUserbot(text) {
  const client = await getUserClient();
  if (!client) return { ok: false, error: 'userbot unavailable' };
  try {
    if (!_resolvedChatPeer) _resolvedChatPeer = await client.getEntity(Number(CHAT_ID));
    await client.sendMessage(_resolvedChatPeer, { message: text, parseMode: 'html', linkPreview: true });
    return { ok: true };
  } catch (err) {
    _resolvedChatPeer = null;
    return { ok: false, error: err.message };
  }
}

async function sendViaBot(text, attempt = 1) {
  if (!TG_TOKEN || !CHAT_ID) return { ok: false, error: 'missing config' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      // Retry on 5xx / 429 once
      if (attempt < 2 && (r.status >= 500 || r.status === 429)) {
        await new Promise(res => setTimeout(res, 1500));
        return sendViaBot(text, attempt + 1);
      }
      return { ok: false, error: `HTTP ${r.status} ${(await r.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    // Transient fetch failure — one retry
    if (attempt < 2) {
      await new Promise(res => setTimeout(res, 1500));
      return sendViaBot(text, attempt + 1);
    }
    return { ok: false, error: err.message };
  }
}

// =========================================================================
// FORMATTERS
// =========================================================================
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtUsd(usd) {
  if (!usd || usd <= 0) return '$0';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// =========================================================================
// COSMO CALL FORMAT
// =========================================================================
async function formatCall(p, mint) {
  const solUsd = await getSolUsd();
  const mcapUsd = (p.entry_mcap_sol || 0) * solUsd;
  const priceUsd = (p.entry_price || 0) * solUsd;
  const sizeUsd = (p.entry_sol || 0) * solUsd;
  const symbol = mint.symbol || '?';
  const name = (mint.name && mint.name !== symbol) ? mint.name : null;
  const lines = [];
  lines.push(`🚀 <b>NEW CALL: $${escapeHtml(symbol)}</b>`);
  if (name) lines.push(`<i>${escapeHtml(name)}</i>`);
  lines.push('');
  lines.push(`Mcap: <b>${fmtUsd(mcapUsd)}</b>  ·  Entry: ${fmtUsd(priceUsd)}`);
  lines.push(`Size: ${fmtUsd(sizeUsd)}  <i>(${(p.entry_sol || 0).toFixed(3)} SOL)</i>`);
  lines.push(`Score: <b>${(p.entry_score || 0).toFixed(2)}</b>`);
  if (p.predicted_peak_pct) {
    lines.push(`Predicted peak: <b>+${Math.round(p.predicted_peak_pct)}%</b>`);
  }
  // Latest predictions for ML signal context
  try {
    const preds = db().prepare(`
      SELECT target, prob FROM ml_predictions
      WHERE mint_address = ? AND prob IS NOT NULL
        AND timestamp > strftime('%s','now')*1000 - 600000
      GROUP BY target HAVING timestamp = MAX(timestamp)
    `).all(mint.mint_address);
    const m = {};
    for (const r of preds) m[r.target] = r.prob;
    const sigLines = [];
    if (m.peaked_100 != null) sigLines.push(`peaked_100: ${(m.peaked_100*100).toFixed(0)}%`);
    if (m.hits_2x_within_1h != null && m.hits_2x_within_1h >= 0.05) sigLines.push(`2x/1h: ${(m.hits_2x_within_1h*100).toFixed(0)}%`);
    if (m.will_migrate != null && m.will_migrate >= 0.05) sigLines.push(`mig: ${(m.will_migrate*100).toFixed(0)}%`);
    if (m.will_die_fast != null) sigLines.push(`die_fast: ${(m.will_die_fast*100).toFixed(0)}%`);
    if (sigLines.length) {
      lines.push('');
      lines.push('Signals:');
      for (const s of sigLines) lines.push(`  • ${s}`);
    }
  } catch {}
  // Smart-money snapshot — surface if any smart wallets already in the mint.
  try {
    const ws = db().prepare(`SELECT smart_buyer_count, whale_buyer_count,
                                    top_buyer_skill_p90, avg_buyer_hold_sec
                             FROM ml_mint_snapshots
                             WHERE mint_address = ?
                             ORDER BY snapshot_ts DESC LIMIT 1`).get(mint.mint_address);
    if (ws && (ws.smart_buyer_count > 0 || ws.whale_buyer_count > 0)) {
      lines.push('');
      lines.push('💼 <b>Smart Money:</b>');
      if (ws.whale_buyer_count > 0) lines.push(`  • ${ws.whale_buyer_count} whale${ws.whale_buyer_count===1?'':'s'} (skill ≥5)`);
      if (ws.smart_buyer_count > 0) lines.push(`  • ${ws.smart_buyer_count} smart buyer${ws.smart_buyer_count===1?'':'s'} (skill ≥2)`);
      if (ws.top_buyer_skill_p90 > 0) lines.push(`  • top buyer skill: ${ws.top_buyer_skill_p90.toFixed(1)}`);
      if (ws.avg_buyer_hold_sec > 30) lines.push(`  • avg buyer hold: ${Math.round(ws.avg_buyer_hold_sec)}s`);
    }
  } catch {}
  lines.push('');
  lines.push(`<a href="https://pump.fun/${mint.mint_address}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint.mint_address}">dexscreener</a>`);
  lines.push('');
  lines.push(mint.mint_address);
  return lines.join('\n');
}

// =========================================================================
// VIKTOR PHRASE BANKS
// 80s/90s hacker, bitter, dry Russian flavor. NO children/kids framing.
// =========================================================================
const V = {
  open: [
    "Bot has eye on $%S. Score %SC. We watch.",
    "$%S goes on the list. %SC conviction. Bot wants in.",
    "Position opened on $%S. %SOL SOL committed. Either it runs or it dies.",
    "$%S. Entry %SC. Bot, she's hungry tonight.",
  ],
  T1: [
    "T1 fires on $%S. Forty percent off the table at +%P. Cheap discipline.",
    "$%S first tier closed at +%P. Bot banks. Knife stays sharp.",
    "T1 on $%S. +%P. The ape brigade still gawking at the candle.",
    "First tier. $%S +%P. Bot reads the tape better than I did at her age.",
  ],
  T2: [
    "T2 fires on $%S at +%P. Bot eats again. Trail armed.",
    "$%S second tier closed. +%P. Sixty percent of the position now safe.",
    "T2. $%S +%P. The cartoon-dog crowd hasn't even noticed.",
  ],
  T3: [
    "T3 fires on $%S at +%P. Full ladder. blyat, what a clean trade.",
    "$%S. T1, T2, T3 — bot ate the whole carcass at +%P.",
    "Triple tier on $%S. +%P peak. The kind of trade I needed a sleepless week to plan.",
    "$%S full clear. Bot did in thirty minutes what comrade Viktor used to do in seven days.",
  ],
  TRAIL_STOP: [
    "Trailing stop on $%S. +%P locked. Surgical.",
    "$%S trail caught the fade at +%P. The shitcoin moths still holding their bags.",
    "Trail closed $%S at +%P. Bot lets it run, then catches it. The way it should be done.",
  ],
  HARD_STOP: [
    "Hard stop $%S at %P. Bot bled. Honest loss — entry was too late.",
    "$%S cut at the floor. %P. blyat. Market was brutal on that one.",
    "Hard stop %P on $%S. The bot, she tries. Sometimes the coin just dies.",
  ],
  STALE_DATA: [
    "$%S went dark. Trade stream dried. Bot exits before bagholder territory.",
    "$%S — no trades, no signal. Out clean at %P. Reminds me of comms going silent in '89.",
    "Trade flow stopped on $%S. Bot recycles capital instead of hoping.",
  ],
  STALLED_PUMP: [
    "$%S pumped weak then bled. Bot cuts at %P. Patience over hope.",
    "$%S peaked, faded, never recovered. Out at %P. The timeline-refreshing masses still waiting for a bounce.",
    "Stalled pump on $%S. %P. Hope is not strategy, comrade.",
  ],
  RUGGED: [
    "Rugged. $%S. Bot caught it at zero. The Solana mob fed another wallet tonight.",
    "$%S rugged. Detected, exited clean. Some operations in old country were less merciful.",
    "Rug pulled on $%S. Bot was already gone. Good eye.",
  ],
  ML_SELL: [
    "$%S — ML score broke down. Bot exits at %P. Discipline.",
    "$%S closed on ML signal at %P. No drama, just numbers.",
  ],
  STALE_FLAT: [
    "$%S sat flat for an hour. Out at %P. Bot doesn't bagsit.",
    "$%S — no movement, no signal, no patience for it. Cut at %P.",
  ],
  NO_PUMP_TIMEOUT: [
    "$%S timeout. Ninety minutes, no real pump. Out at %P.",
    "$%S never woke up. Bot recycles capital at %P.",
  ],
  MIGRATED_NO_TRACKING: [
    "$%S migrated but the data went silent. Out at %P — can't trade what we can't see.",
    "$%S — post-mig AMM coverage gap. Closed at %P. Until ingest catches up, no informed exit.",
  ],
  threshold_up: [
    "Operator tightened entry threshold to %V. Fewer trades, better trades. The boss reads the tape.",
    "Threshold raised to %V. Bot is selective now. About time.",
    "Entry bar moved up to %V. The bleeding bucket gets skipped. blyat, finally.",
  ],
  threshold_down: [
    "Operator loosened entry threshold to %V. More shots. Risky.",
    "Threshold dropped to %V. Bot opens the funnel. Hope the bleeding buckets stay empty.",
  ],
  big_open: [
    "$%S is alive — already +%P since bot bought.",
    "$%S running. +%P. Bot called this one early.",
  ],
};

function viktorRender(template, vars) {
  let s = template;
  // Sort keys by length descending so %SC substitutes before %S (otherwise
  // %SC gets eaten as %S + 'C', leaving 'TUFFC' instead of 'TUFF 0.22').
  const keys = Object.keys(vars || {}).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    s = s.replaceAll(`%${k}`, String(vars[k]));
  }
  return s;
}

function normalizeReason(reason) {
  if (!reason) return 'ML_SELL';
  // HARD_STOP_-40 -> HARD_STOP, anything with trailing suffix gets prefix-matched.
  const known = ['HARD_STOP', 'TRAIL_STOP', 'STALE_DATA', 'STALE_FLAT',
    'NO_PUMP_TIMEOUT', 'MIGRATED_NO_TRACKING', 'STALLED_PUMP', 'RUGGED', 'ML_SELL'];
  for (const k of known) if (reason.startsWith(k)) return k;
  return 'ML_SELL';
}

function viktorTextForClose(p) {
  const key = normalizeReason(p.exit_reason);
  const symbol = (p.symbol || '?').slice(0, 16);
  const pnl = (p.realized_pnl_pct || 0);
  const peak = (p.highest_pct || 0);
  const pctStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`;
  const bank = V[key] || V.ML_SELL;
  const line = viktorRender(pick(bank), { S: symbol, P: pctStr });
  let suffix = '';
  if (peak > 50 && pnl < 20) suffix = `\n<i>(peak +${peak.toFixed(0)}% — gave it back)</i>`;
  return `<b>${line}</b>${suffix}`;
}
function viktorTextForTier(p, tierName, curPct) {
  const symbol = (p.symbol || '?').slice(0, 16);
  const pctStr = `+${curPct.toFixed(0)}%`;
  const bank = V[tierName] || V.T1;
  return `<b>${viktorRender(pick(bank), { S: symbol, P: pctStr })}</b>`;
}
function viktorTextForOpen(p) {
  const symbol = (p.symbol || '?').slice(0, 16);
  const sc = (p.entry_score || 0).toFixed(2);
  const sol = (p.entry_sol || 0).toFixed(3);
  return `<i>${viktorRender(pick(V.open), { S: symbol, SC: sc, SOL: sol })}</i>`;
}
function viktorTextForThresholdMove(oldT, newT, reason) {
  const dir = newT > oldT ? 'threshold_up' : 'threshold_down';
  const txt = viktorRender(pick(V[dir]), { V: newT.toFixed(3) });
  const detail = reason ? `\n<i>(${escapeHtml(reason)})</i>` : '';
  return `<b>${txt}</b>${detail}`;
}

// =========================================================================
// STATE TRACKING (in-mem; recovers from DB on restart)
// =========================================================================
const _state = {
  lastClosedId: 0,
  lastOpenedId: 0,
  tierHits: new Map(),       // mint -> Set of fired tiers
  lastThreshold: null,
  recentCallTs: [],          // rolling timestamps of recent calls (rate limit)
  recentCalledMints: new Map(), // mint -> ts (dedup)
};

function rateOk() {
  const oneHrAgo = Date.now() - 3600_000;
  while (_state.recentCallTs.length && _state.recentCallTs[0] < oneHrAgo) _state.recentCallTs.shift();
  return _state.recentCallTs.length < MAX_CALLS_PER_HOUR;
}

async function postCosmoCall(p) {
  if (!CHAT_ID) return;
  const last = _state.recentCalledMints.get(p.mint_address);
  if (last && Date.now() - last < CALL_DEDUP_MS) return;
  if (!rateOk()) {
    console.log(`[tg] rate-limit reached — skipping call ${p.mint_address.slice(0, 8)}…`);
    return;
  }
  const mint = db().prepare('SELECT mint_address, symbol, name FROM mints WHERE mint_address=?').get(p.mint_address) || { mint_address: p.mint_address };
  const text = await formatCall(p, mint);
  let res = USERBOT_ENABLED ? await sendViaUserbot(text) : await sendViaBot(text);
  if (!res.ok && USERBOT_ENABLED) {
    console.log(`[tg] userbot failed (${res.error}) — bot API fallback`);
    res = await sendViaBot(text);
  }
  if (!res.ok) { console.log(`[tg] call send failed: ${res.error}`); return; }
  _state.recentCallTs.push(Date.now());
  _state.recentCalledMints.set(p.mint_address, Date.now());
  console.log(`[tg] COSMO call posted: $${mint.symbol || '?'} score=${(p.entry_score||0).toFixed(2)}`);
}

async function postViktor(text) {
  if (!CHAT_ID) return;
  const res = await sendViaBot(text);
  if (!res.ok) console.log(`[tg] viktor post failed: ${res.error}`);
  else console.log(`[tg] VIKTOR posted (${text.slice(0, 60)}…)`);
}

// =========================================================================
// POLL LOOP
// =========================================================================
async function tick() {
  try {
    // 1. New opens since lastOpenedId
    const opens = db().prepare(`
      SELECT pp.id, pp.mint_address, pp.entry_score, pp.entry_sol, pp.entry_price,
             pp.entry_mcap_sol, pp.predicted_peak_pct, pp.tiers_hit,
             m.symbol, m.name
      FROM paper_positions pp LEFT JOIN mints m USING(mint_address)
      WHERE pp.id > ? AND pp.status='open'
      ORDER BY pp.id ASC LIMIT 20
    `).all(_state.lastOpenedId);
    for (const p of opens) {
      _state.lastOpenedId = Math.max(_state.lastOpenedId, p.id);
      _state.tierHits.set(p.mint_address, new Set());
      // Cosmo call (high conviction only) — fire-and-forget
      postCosmoCall(p).catch(() => {});
      // Viktor brief open note
      postViktor(viktorTextForOpen(p)).catch(() => {});
    }

    // 2. Tier hits on open positions (diff tiers_hit vs in-mem)
    const openNow = db().prepare(`
      SELECT pp.mint_address, pp.tiers_hit, pp.unrealized_pnl_pct, pp.highest_pct,
             m.symbol FROM paper_positions pp LEFT JOIN mints m USING(mint_address)
      WHERE pp.status='open'`).all();
    for (const p of openNow) {
      let hit;
      try { hit = new Set(JSON.parse(p.tiers_hit || '[]')); } catch { hit = new Set(); }
      const prev = _state.tierHits.get(p.mint_address) || new Set();
      for (const t of hit) {
        if (!prev.has(t)) {
          const pct = p.unrealized_pnl_pct || p.highest_pct || 0;
          postViktor(viktorTextForTier(p, t, pct)).catch(() => {});
        }
      }
      _state.tierHits.set(p.mint_address, hit);
    }

    // 3. New closes — Viktor commentary on each
    const closes = db().prepare(`
      SELECT pp.id, pp.mint_address, pp.exit_reason, pp.realized_pnl_pct, pp.highest_pct,
             m.symbol FROM paper_positions pp LEFT JOIN mints m USING(mint_address)
      WHERE pp.id > ? AND pp.status='closed'
      ORDER BY pp.id ASC LIMIT 20
    `).all(_state.lastClosedId);
    for (const p of closes) {
      _state.lastClosedId = Math.max(_state.lastClosedId, p.id);
      // Drop noisy small losses to avoid channel spam — only post if >|5%| or big peak gap
      const big = Math.abs(p.realized_pnl_pct || 0) >= 5 || (p.highest_pct || 0) >= 30;
      if (big) postViktor(viktorTextForClose(p)).catch(() => {});
      _state.tierHits.delete(p.mint_address);
    }

    // 4. Threshold tuner moves
    try {
      const row = db().prepare("SELECT value, reason FROM bot_runtime_settings WHERE key='entry_score_threshold'").get();
      if (row) {
        const v = Number(row.value);
        if (_state.lastThreshold == null) _state.lastThreshold = v;
        else if (Math.abs(v - _state.lastThreshold) > 0.001) {
          postViktor(viktorTextForThresholdMove(_state.lastThreshold, v, row.reason)).catch(() => {});
          _state.lastThreshold = v;
        }
      }
    } catch {}
  } catch (err) {
    console.error('[tg] tick err:', err.message);
  }
}

// Seed state from current DB so we don't spam on first run
function seedState() {
  try {
    const r1 = db().prepare("SELECT MAX(id) AS id FROM paper_positions WHERE status='open'").get();
    _state.lastOpenedId = r1?.id || 0;
    const r2 = db().prepare("SELECT MAX(id) AS id FROM paper_positions WHERE status='closed'").get();
    _state.lastClosedId = r2?.id || 0;
    // Seed tier-hits snapshot for currently-open positions
    const opens = db().prepare("SELECT mint_address, tiers_hit FROM paper_positions WHERE status='open'").all();
    for (const o of opens) {
      let hit;
      try { hit = new Set(JSON.parse(o.tiers_hit || '[]')); } catch { hit = new Set(); }
      _state.tierHits.set(o.mint_address, hit);
    }
    const r3 = db().prepare("SELECT value FROM bot_runtime_settings WHERE key='entry_score_threshold'").get();
    _state.lastThreshold = r3?.value ?? null;
  } catch (err) {
    console.error('[tg] seed err:', err.message);
  }
}

export function startTelegramBroadcaster() {
  if (!TG_TOKEN) { console.log('[tg] disabled — TELEGRAM_BOT_TOKEN not set'); return; }
  if (!CHAT_ID) { console.log('[tg] disabled — TG_CALLS_CHAT_ID not set'); return; }
  seedState();
  console.log(`[tg] broadcaster started · chat=${CHAT_ID} · userbot=${USERBOT_ENABLED ? 'on' : 'off'} · cosmo=every open (max ${MAX_CALLS_PER_HOUR}/hr)`);
  // Pre-warm userbot
  if (USERBOT_ENABLED) getUserClient().catch((e) => console.log(`[tg] userbot prewarm: ${e.message}`));
  // First tick after 6s, then every POLL_MS
  setTimeout(() => tick().catch(() => {}), 6_000);
  setInterval(() => tick().catch(() => {}), POLL_MS);
}
