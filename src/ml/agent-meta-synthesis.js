// Cultural-pulse synthesizer. Every 4 hours, gather all the recent news,
// trending signals, social posts, and manual flags — feed them to Claude,
// get back a "current meta" summary that the agent reads on every cycle.
//
// This is the layer that turns raw news ingestion into actionable trading
// context: "AI agent narrative cooling, $TRUMP on Truth Social activity,
// memecoin regime is mid — favor quick flips on tracked-wallet signals."

import { db } from '../db/index.js';
import { freeformThought } from './agent-llm.js';
import { canConsult, recordConsult } from './agent-rate-limit.js';

const TICK_INTERVAL_MS = 30 * 60 * 1000;       // check every 30min
const SYNTHESIS_WINDOW_MS = 4 * 60 * 60 * 1000; // fire every ~4h
const FIRST_RUN_DELAY_MS = 8 * 60 * 1000;       // 8 min after boot
const STATE_KEY = 'agent_meta_last_synth_at';

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    lastSynth: d.prepare(`SELECT MAX(ts) AS ts FROM agent_meta_synthesis`),
    insertSynth: d.prepare(`INSERT INTO agent_meta_synthesis (ts, summary, raw_context, cost_estimate_usd) VALUES (?, ?, ?, ?)`),
    // Pull recent items by category for the synthesis prompt
    recentTopNews: d.prepare(`SELECT source, title, summary, relevance_score, keywords, ts
       FROM news_items WHERE ts > ? ORDER BY relevance_score DESC, ts DESC LIMIT 40`),
    recentTrendSignals: d.prepare(`SELECT source, keyword, score, metadata_json, ts
       FROM trend_signals WHERE ts > ? ORDER BY score DESC, ts DESC LIMIT 40`),
    recentTrumpPosts: d.prepare(`SELECT title, summary, ts FROM news_items
       WHERE source='truth-social:trump' AND ts > ? ORDER BY ts DESC LIMIT 10`),
    recentTwitter: d.prepare(`SELECT source, title, ts FROM news_items
       WHERE source LIKE 'twitter:%' AND ts > ? ORDER BY ts DESC LIMIT 20`),
    activeFlags: d.prepare(`SELECT flag, note, created_at FROM manual_flags
       WHERE active=1 AND (expires_at IS NULL OR expires_at > strftime('%s','now')*1000)
       ORDER BY created_at DESC LIMIT 20`),
  };
  return stmts;
}

function buildSynthesisInput() {
  const since = Date.now() - SYNTHESIS_WINDOW_MS;
  const news = S().recentTopNews.all(since);
  const trends = S().recentTrendSignals.all(since);
  const trumpPosts = S().recentTrumpPosts.all(since);
  const twitter = S().recentTwitter.all(since);
  const flags = S().activeFlags.all();

  const lines = [];
  lines.push(`=== INPUT WINDOW: last ${SYNTHESIS_WINDOW_MS / 3600000}h ===`);

  if (flags.length > 0) {
    lines.push('\n=== USER MANUAL FLAGS (priority — these are direct human observations) ===');
    for (const f of flags) lines.push(`  • ${f.flag}${f.note ? ' — ' + f.note : ''}`);
  }

  if (trumpPosts.length > 0) {
    lines.push('\n=== RECENT TRUMP TRUTH SOCIAL POSTS (high-impact for memecoin pumps) ===');
    for (const p of trumpPosts) {
      lines.push(`  • ${p.title?.slice(0, 200)}`);
    }
  }

  if (twitter.length > 0) {
    lines.push('\n=== RECENT INFLUENCER TWEETS ===');
    for (const t of twitter.slice(0, 12)) lines.push(`  • ${t.source}: ${t.title?.slice(0, 200)}`);
  }

  if (trends.length > 0) {
    lines.push('\n=== TRENDING SIGNALS (tickers/keywords aggregating across sources) ===');
    // Aggregate by keyword
    const byKw = new Map();
    for (const t of trends) {
      const cur = byKw.get(t.keyword) || { sources: new Set(), totalScore: 0 };
      cur.sources.add(t.source);
      cur.totalScore += (t.score || 0);
      byKw.set(t.keyword, cur);
    }
    const sorted = [...byKw.entries()].sort((a, b) => (b[1].sources.size * 10 + b[1].totalScore) - (a[1].sources.size * 10 + a[1].totalScore)).slice(0, 20);
    for (const [kw, info] of sorted) {
      lines.push(`  • ${kw} — score ${info.totalScore.toFixed(1)} across ${info.sources.size} source(s): ${[...info.sources].slice(0, 4).join(', ')}`);
    }
  }

  if (news.length > 0) {
    lines.push('\n=== TOP RELEVANT NEWS (sorted by relevance score) ===');
    for (const n of news.slice(0, 25)) {
      const kws = (() => { try { return JSON.parse(n.keywords || '[]').slice(0, 5).join(','); } catch { return ''; } })();
      lines.push(`  • [${n.source}] ${n.title?.slice(0, 150)} (kw: ${kws})`);
    }
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `You synthesize the current "cultural pulse" of crypto/memecoin twitter, news, and political events into one tight summary for an autonomous Solana memecoin trading bot.

Pump.fun memecoins ride cultural moments — Trump posts, current narratives (AI agents, doge, BTC ATH, election cycles), celebrity drama, viral memes. Your job: read the input below and produce a 5-8 sentence synthesis covering:

1. What memes/narratives/themes are CURRENTLY HOT (with specific keywords/tickers if visible).
2. What's COOLING / past peak.
3. Any specific big-impact events (Trump post, BTC move, sanction, CEO drama, AI launch) that just happened.
4. Implication for pump.fun: what *kinds* of mints would catch on right now? What kinds would die?
5. End with a one-line "tactic" — should the agent be aggressive (run hot meta), selective (boring market, only A+ setups), or watchful (regime shift in progress)?

Be specific. Cite actual keywords/tickers/people from the input when they appear. Do NOT make up signals that aren't in the data. If input is sparse, say so.`;

async function maybeSynthesize() {
  const last = S().lastSynth.get();
  const lastTs = last?.ts || 0;
  if (Date.now() - lastTs < SYNTHESIS_WINDOW_MS) return;
  if (!canConsult('news-synthesis')) {
    console.log('[news-synth] daily Claude cap hit — skipping');
    return;
  }
  const ctx = buildSynthesisInput();
  if (ctx.length < 200) {
    console.log('[news-synth] not enough input data — deferring');
    return;
  }
  let summary;
  try {
    recordConsult('news-synthesis');
    summary = await freeformThought(SYSTEM_PROMPT, ctx, 90000);
  } catch (err) {
    console.error('[news-synth] consult failed:', err.message);
    return;
  }
  try {
    S().insertSynth.run(Date.now(), summary, ctx.slice(0, 8000), 0.20);
    console.log(`[news-synth] meta synthesized — ${summary.slice(0, 200).replace(/\n/g, ' ')}`);
  } catch (err) { console.error('[news-synth] insert err:', err.message); }
}

export function startMetaSynthesis() {
  setTimeout(maybeSynthesize, FIRST_RUN_DELAY_MS);
  setInterval(maybeSynthesize, TICK_INTERVAL_MS);
  console.log('[news-synth] scheduled · checks every 30min, fires every 4h');
}
