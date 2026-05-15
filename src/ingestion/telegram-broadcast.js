// Telegram BOT broadcasts — informational/market intel posted from the bot
// account (not the userbot). Phanes-tracked calls go via the userbot;
// everything else (daily wrap, big movers, strategy events, hot metas,
// market regime) goes here.
//
// Five channels, each with its own state + throttle:
//   1. Daily wrap (~9pm ET)
//   2. Big-mover alerts (mints crossing +500% / +1000% peak)
//   3. Strategy lifecycle events (NEW / RETIRE / MODIFIED)
//   4. Hot meta detection (keyword clusters in recently-launched mints)
//   5. Market regime updates (when the agent's posture changes)

import { db } from '../db/index.js';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TG_CALLS_CHAT_ID || '';

const POLL_INTERVAL_MS = 5 * 60 * 1000;        // every 5 min
const FIRST_RUN_DELAY_MS = 60 * 1000;          // 1 min after boot — fast verification on restart

// Thresholds
const BIG_MOVER_PEAK_PCT = 5.0;                // +500% triggers alert
const HOT_META_MIN_MINTS = 3;                  // 3+ mints sharing keyword
const HOT_META_WINDOW_MIN = 60;                // launched in last 60 min
const HOT_META_MIN_KEYWORD_LEN = 4;            // skip short generic words

// Daily wrap fires at 21:00 ET, give or take. We check on each tick and
// fire if it's been ≥22h since the last wrap AND current hour is ≥21.
const DAILY_WRAP_TARGET_HOUR = 21;
const DAILY_WRAP_MIN_GAP_MS = 22 * 60 * 60 * 1000;

// In-memory dedup. Wiped on restart (acceptable; we don't want stale dedup
// blocking a legitimate alert after an outage).
const _bigMoverAlerted = new Map();   // mint -> highestPctAlerted
const _hotMetaPosted = new Map();      // keyword -> timestamp
const _lifecycleSeen = new Set();      // log row id
const _regimeSeen = new Set();         // log row id

let _running = false;
let _lastDailyWrapAt = 0;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtUsd(usd) {
  if (!usd || usd <= 0) return '$0';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}
function fmtSol(sol) { return `${sol >= 0 ? '+' : ''}${sol.toFixed(3)} SOL`; }
function fmtPct(pct) { return `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(1)}%`; }

async function sendTg(text) {
  if (!TG_TOKEN || !CHAT_ID) return { ok: false, error: 'missing config' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);  // 15s — TG can be slow under load
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID, text, parse_mode: 'HTML',
        disable_web_page_preview: true,
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
  } finally { clearTimeout(t); }
}

// ============================================================================
// 1) DAILY WRAP
// ============================================================================
async function maybeDailyWrap() {
  const now = new Date();
  if (now.getHours() < DAILY_WRAP_TARGET_HOUR) return;
  // Persist last-fired via DB so restarts don't re-fire. In-memory _lastDailyWrapAt
  // was resetting on every bot kick and re-spamming the channel after 21:00 ET.
  const lastFromDb = (() => {
    try {
      const r = db().prepare(`SELECT MAX(timestamp) ts FROM ml_agent_log
        WHERE category='tg-broadcast' AND message='daily-wrap-fired'`).get();
      return r?.ts || 0;
    } catch { return 0; }
  })();
  const lastAt = Math.max(_lastDailyWrapAt, lastFromDb);
  if (Date.now() - lastAt < DAILY_WRAP_MIN_GAP_MS) return;
  const d = db();
  const todayStart = (() => {
    const t = new Date(); t.setHours(0, 0, 0, 0); return t.getTime();
  })();
  const perf = d.prepare(`
    SELECT COUNT(*) closed, SUM(realized_pnl_sol) pnl_sol,
           SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN realized_pnl_sol < 0 THEN 1 ELSE 0 END) losses
    FROM paper_positions
    WHERE status = 'closed' AND exited_at >= ?
  `).get(todayStart);
  if ((perf?.closed || 0) === 0) return;  // nothing to report
  const topWins = d.prepare(`
    SELECT p.mint_address, m.symbol, ROUND(p.realized_pnl_sol,4) pnl, ROUND(p.realized_pnl_pct*100,1) pct
    FROM paper_positions p LEFT JOIN mints m ON m.mint_address = p.mint_address
    WHERE p.status = 'closed' AND p.exited_at >= ? AND p.realized_pnl_sol > 0
    ORDER BY p.realized_pnl_sol DESC LIMIT 3
  `).all(todayStart);
  const topLosses = d.prepare(`
    SELECT p.mint_address, m.symbol, ROUND(p.realized_pnl_sol,4) pnl, ROUND(p.realized_pnl_pct*100,1) pct
    FROM paper_positions p LEFT JOIN mints m ON m.mint_address = p.mint_address
    WHERE p.status = 'closed' AND p.exited_at >= ? AND p.realized_pnl_sol < 0
    ORDER BY p.realized_pnl_sol ASC LIMIT 3
  `).all(todayStart);
  const liveCount = d.prepare(`SELECT COUNT(*) n FROM ml_agent_strategies WHERE status='live'`).get().n;
  const proposedToday = d.prepare(`
    SELECT COUNT(*) n FROM ml_agent_strategies WHERE created_at >= ?
  `).get(todayStart).n;
  const retiredToday = d.prepare(`
    SELECT COUNT(*) n FROM ml_agent_log WHERE category='introspect' AND level='retire' AND timestamp >= ?
  `).get(todayStart).n;
  const winRate = (perf.wins || 0) / Math.max(perf.closed, 1);
  const lines = [];
  lines.push(`📊 <b>DAILY WRAP</b> · ${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`);
  lines.push('');
  lines.push(`Trades closed: <b>${perf.closed}</b>  ·  Wins ${perf.wins} / Losses ${perf.losses}  ·  Win rate <b>${(winRate*100).toFixed(0)}%</b>`);
  lines.push(`Paper PnL today: <b>${fmtSol(perf.pnl_sol || 0)}</b>`);
  lines.push('');
  if (topWins.length) {
    lines.push(`<b>Top winners:</b>`);
    for (const w of topWins) lines.push(`  • $${escapeHtml(w.symbol || '?')}  ${fmtSol(w.pnl)}  (${fmtPct(w.pct/100)})`);
  }
  if (topLosses.length) {
    lines.push(`<b>Top losers:</b>`);
    for (const l of topLosses) lines.push(`  • $${escapeHtml(l.symbol || '?')}  ${fmtSol(l.pnl)}  (${fmtPct(l.pct/100)})`);
  }
  lines.push('');
  lines.push(`Agent activity: <b>${proposedToday}</b> strategies proposed · <b>${retiredToday}</b> retired · <b>${liveCount}</b> live now`);
  const res = await sendTg(lines.join('\n'));
  if (res.ok) {
    _lastDailyWrapAt = Date.now();
    try {
      db().prepare(`INSERT INTO ml_agent_log (timestamp, level, category, message, data_json)
        VALUES (?, 'info', 'tg-broadcast', 'daily-wrap-fired', '{}')`).run(Date.now());
    } catch (err) { console.log(`[tg-broadcast] daily-wrap persist failed: ${err.message}`); }
    console.log('[tg-broadcast] daily wrap posted');
  } else {
    console.log(`[tg-broadcast] daily wrap send failed: ${res.error}`);
  }
}

// ============================================================================
// 2) BIG MOVER ALERTS
// ============================================================================
async function checkBigMovers() {
  const d = db();
  const dayStart = Date.now() - 24 * 60 * 60 * 1000;
  // Find mints we have snapshots for that have crossed +500% peak today.
  // Compare peak_market_cap_sol vs the earliest snapshot's mcap_sol.
  const rows = d.prepare(`
    SELECT mint_address, symbol, name, peak_mc, entry_mc, migrated, was_in
    FROM (
      SELECT m.mint_address, m.symbol, m.name, m.peak_market_cap_sol peak_mc,
             (SELECT MIN(last_mcap_sol) FROM ml_mint_snapshots s WHERE s.mint_address = m.mint_address AND last_mcap_sol > 0) entry_mc,
             m.migrated,
             (SELECT COUNT(*) FROM paper_positions p WHERE p.mint_address = m.mint_address) was_in
      FROM mints m
      WHERE m.created_at > ?
        AND m.peak_market_cap_sol >= 50
    )
    WHERE entry_mc > 0 AND (peak_mc / entry_mc - 1) >= ?
    ORDER BY (peak_mc / entry_mc) DESC LIMIT 20
  `).all(dayStart, BIG_MOVER_PEAK_PCT);
  let solUsd = 0;
  try { solUsd = (await import('../price.js')).getSolUsd() || 0; } catch {}
  for (const r of rows) {
    const peakPct = r.peak_mc / r.entry_mc - 1;
    const lastAlerted = _bigMoverAlerted.get(r.mint_address) || 0;
    // Only re-alert if the peak crossed a new 5x level (5x, 10x, 20x, 50x, 100x)
    const tiers = [5, 10, 20, 50, 100];
    const crossedTier = tiers.find(t => peakPct + 1 >= t && lastAlerted + 1 < t);
    if (!crossedTier) continue;
    _bigMoverAlerted.set(r.mint_address, peakPct);
    const lines = [];
    const tag = crossedTier >= 100 ? '🚀🚀 100x' : crossedTier >= 50 ? '🚀 50x' : crossedTier >= 20 ? '⚡ 20x' : crossedTier >= 10 ? '🔥 10x' : '📈 5x';
    lines.push(`${tag} <b>$${escapeHtml(r.symbol || '?')}</b>${r.name && r.name !== r.symbol ? `  <i>${escapeHtml(r.name)}</i>` : ''}`);
    lines.push(`Peak: <b>${fmtPct(peakPct)}</b>  ·  Entry mcap ${fmtUsd(r.entry_mc * solUsd)} → Peak ${fmtUsd(r.peak_mc * solUsd)}`);
    lines.push(`Was in our paper book: <b>${r.was_in > 0 ? 'YES ✓' : 'NO'}</b>${r.migrated ? '  ·  migrated 🎓' : ''}`);
    lines.push('');
    lines.push(`<code>${r.mint_address}</code>`);
    const res = await sendTg(lines.join('\n'));
    if (res.ok) console.log(`[tg-broadcast] big-mover ${tag.trim()} $${r.symbol}`);
  }
}

// ============================================================================
// 3) STRATEGY LIFECYCLE EVENTS
// ============================================================================
async function checkLifecycleEvents() {
  const d = db();
  // Look back 30 min, dedup by row id
  const rows = d.prepare(`
    SELECT id, timestamp, level, message, strategy_id
    FROM ml_agent_log
    WHERE category IN ('consult','introspect')
      AND level IN ('propose','retire','thought')
      AND (message LIKE 'proposed strategy%' OR message LIKE 'modified%' OR message LIKE 'orphan-retired%' OR message LIKE 'evolutionary-retired%' OR message LIKE 'emergency-retired%')
      AND timestamp > strftime('%s','now')*1000 - 30*60*1000
    ORDER BY id ASC LIMIT 40
  `).all();
  for (const r of rows) {
    if (_lifecycleSeen.has(r.id)) continue;
    _lifecycleSeen.add(r.id);
    let header, body;
    if (r.message.startsWith('proposed strategy')) {
      header = '🚀 <b>NEW STRATEGY</b>';
      // Pull recipe for entry summary
      const recipeRow = d.prepare('SELECT recipe_json FROM ml_agent_strategies WHERE id = ?').get(r.strategy_id);
      let entryLines = [];
      let rationale = '';
      try {
        const recipe = JSON.parse(recipeRow?.recipe_json || '{}');
        rationale = recipe.rationale || '';
        const conds = recipe.entry?.conditions || [];
        for (const c of conds) {
          entryLines.push(`  • ${c.name} ${c.op} ${c.value}`);
        }
        if (recipe.entry?.max_mint_age_sec) {
          entryLines.push(`  • mint age: ${recipe.entry.min_mint_age_sec || 0}s – ${recipe.entry.max_mint_age_sec}s`);
        }
      } catch {}
      body = `${header}  <code>${escapeHtml(r.strategy_id)}</code>\n\n${entryLines.length ? '<b>Entry:</b>\n' + entryLines.join('\n') + '\n\n' : ''}${rationale ? '<i>' + escapeHtml(rationale.slice(0, 400)) + (rationale.length > 400 ? '…' : '') + '</i>' : ''}`;
    } else if (r.message.startsWith('modified')) {
      header = '✏️ <b>STRATEGY MODIFIED</b>';
      body = `${header}  <code>${escapeHtml(r.strategy_id)}</code>\n\n<i>${escapeHtml(r.message.slice(0, 400))}</i>`;
    } else if (r.message.startsWith('orphan-retired')) {
      header = '🗑️ <b>ORPHAN RETIRED</b> <i>(filters too strict, 0 entries)</i>';
      body = `${header}\n<code>${escapeHtml(r.strategy_id)}</code>`;
    } else if (r.message.startsWith('evolutionary-retired')) {
      header = '🗑️ <b>EVOLUTIONARY RETIRE</b> <i>(worst PnL, made room)</i>';
      body = `${header}\n${escapeHtml(r.message.slice(0, 200))}`;
    } else if (r.message.startsWith('emergency-retired')) {
      header = '🚨 <b>EMERGENCY RETIRE</b>';
      body = `${header}\n${escapeHtml(r.message.slice(0, 300))}`;
    } else continue;
    const res = await sendTg(body);
    if (res.ok) console.log(`[tg-broadcast] lifecycle: ${r.message.slice(0,40)}`);
  }
}

// ============================================================================
// 4) HOT META DETECTION
// ============================================================================
const META_STOPWORDS = new Set([
  'coin','token','pump','meme','the','and','for','with','this','that','your','from',
  'will','have','what','when','where','official','community','project','launch',
  'launched','presale','app','social','viral','solana','pumpfun','sol','crypto',
]);
function tokenize(s) {
  if (!s) return [];
  return String(s).toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= HOT_META_MIN_KEYWORD_LEN && !META_STOPWORDS.has(t));
}
async function checkHotMeta() {
  const d = db();
  const cutoff = Date.now() - HOT_META_WINDOW_MIN * 60 * 1000;
  const rows = d.prepare(`
    SELECT mint_address, symbol, name, peak_market_cap_sol
    FROM mints
    WHERE created_at > ? AND (symbol IS NOT NULL OR name IS NOT NULL)
  `).all(cutoff);
  if (rows.length < HOT_META_MIN_MINTS) return;
  // Count keyword occurrences (combined name + symbol corpus)
  const counts = new Map();
  const examples = new Map();
  for (const r of rows) {
    const toks = new Set([...tokenize(r.symbol), ...tokenize(r.name)]);
    for (const t of toks) {
      counts.set(t, (counts.get(t) || 0) + 1);
      if (!examples.has(t)) examples.set(t, []);
      if (examples.get(t).length < 5) examples.get(t).push(r.symbol || r.name);
    }
  }
  const now = Date.now();
  for (const [kw, n] of counts.entries()) {
    if (n < HOT_META_MIN_MINTS) continue;
    const lastPostedAt = _hotMetaPosted.get(kw) || 0;
    if (now - lastPostedAt < 60 * 60 * 1000) continue;  // 1h cooldown per keyword
    _hotMetaPosted.set(kw, now);
    const ex = examples.get(kw).map(s => `$${escapeHtml(s || '?')}`).join('  ');
    const body = `🔥 <b>HOT META: "${escapeHtml(kw)}"</b>\n\n<b>${n}</b> new mints in last ${HOT_META_WINDOW_MIN}m with this keyword\n\n${ex}`;
    const res = await sendTg(body);
    if (res.ok) console.log(`[tg-broadcast] hot-meta: ${kw} (${n} mints)`);
  }
}

// ============================================================================
// 5) MARKET REGIME UPDATES
// ============================================================================
async function checkMarketRegime() {
  const d = db();
  const rows = d.prepare(`
    SELECT id, timestamp, message, data_json
    FROM ml_agent_log
    WHERE category='market-regime' AND level='thought'
      AND timestamp > strftime('%s','now')*1000 - 6*60*60*1000
    ORDER BY id DESC LIMIT 5
  `).all();
  for (const r of rows) {
    if (_regimeSeen.has(r.id)) continue;
    _regimeSeen.add(r.id);
    let regime = 'unknown', rationale = r.message;
    try {
      const j = JSON.parse(r.data_json || '{}');
      regime = j.parsed?.regime || regime;
      rationale = j.parsed?.rationale || rationale;
    } catch {}
    const emoji = regime === 'aggressive' ? '🟢' : regime === 'cautious' ? '🟡' : regime === 'normal' ? '🔵' : '⚪';
    const body = `${emoji} <b>MARKET REGIME: ${escapeHtml(regime.toUpperCase())}</b>\n\n<i>${escapeHtml(rationale.slice(0, 400))}</i>`;
    const res = await sendTg(body);
    if (res.ok) console.log(`[tg-broadcast] regime: ${regime}`);
  }
}

// ============================================================================
// MAIN LOOP
// ============================================================================
async function tick() {
  if (_running) return;
  _running = true;
  try {
    await maybeDailyWrap();
    // checkBigMovers() — DISABLED 2026-05-12, 5x alerts often from dust-corrupted peaks that look noisy/wrong
    await checkLifecycleEvents();
    // checkHotMeta() — DISABLED 2026-05-12, too spammy with low-signal keyword matches
    await checkMarketRegime();
  } catch (err) {
    console.error('[tg-broadcast] tick err:', err.message);
  } finally { _running = false; }
}

// 2026-05-15 (PM): the `_*Seen` sets are in-memory only. Without a startup
// backfill, every bot restart re-posts the last N rows from each lookback
// window (saw 5+ duplicate MARKET REGIME: CAUTIOUS messages within 22 min
// during a restart-heavy debug session). Pre-fill the seen-sets with the
// IDs already in the lookback window so we only broadcast NEW additions.
function prewarmSeenSets() {
  try {
    const d = db();
    const regimeRows = d.prepare(`SELECT id FROM ml_agent_log
       WHERE category='market-regime' AND level='thought'
         AND timestamp > strftime('%s','now')*1000 - 6*60*60*1000`).all();
    for (const r of regimeRows) _regimeSeen.add(r.id);
    const lifecycleRows = d.prepare(`SELECT id FROM ml_agent_log
       WHERE category='lifecycle' AND level='info'
         AND timestamp > strftime('%s','now')*1000 - 24*60*60*1000`).all();
    for (const r of lifecycleRows) _lifecycleSeen.add(r.id);
    console.log(`[tg-broadcast] prewarmed seen-sets · regime=${regimeRows.length} · lifecycle=${lifecycleRows.length}`);
  } catch (err) {
    console.error('[tg-broadcast] prewarm err:', err.message);
  }
}

export function startTelegramBroadcast() {
  if (!TG_TOKEN || !CHAT_ID) {
    console.log('[tg-broadcast] disabled — TELEGRAM_BOT_TOKEN or TG_CALLS_CHAT_ID not set');
    return;
  }
  prewarmSeenSets();
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[tg-broadcast] started · check every ${POLL_INTERVAL_MS/60000}min · channels: daily-wrap, big-movers (≥500%), lifecycle, hot-meta (≥${HOT_META_MIN_MINTS} mints/${HOT_META_WINDOW_MIN}m), market-regime`);
}
