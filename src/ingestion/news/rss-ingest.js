// RSS news ingestor. Polls 30+ feeds every 30 min, applies a relevance keyword
// filter (must mention crypto/politics/tech/celebrity terms), stores survivors
// to news_items.
//
// Pattern borrowed from BTC Oracle's rss-feeds.js but trimmed (no embeddings,
// no vector DB) and retargeted for memecoin-relevance.

import Parser from 'rss-parser';
import { db } from '../../db/index.js';
import { RSS_SOURCES, scoreArticle } from './sources.js';

const FETCH_TIMEOUT_MS = 12 * 1000;
const TICK_INTERVAL_MS = 30 * 60 * 1000;       // every 30 min
const FIRST_RUN_DELAY_MS = 60 * 1000;          // 1 min after boot
const MIN_RELEVANCE = 1;                        // need at least 1 keyword match

const parser = new Parser({ timeout: FETCH_TIMEOUT_MS, headers: { 'User-Agent': 'degen-club-news/0.1' } });

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    insert: d.prepare(`INSERT OR IGNORE INTO news_items
       (source, title, url, summary, ts, relevance_score, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),
    countSince: d.prepare(`SELECT COUNT(*) AS n FROM news_items WHERE ts > ?`),
  };
  return stmts;
}

async function pollOne(source) {
  try {
    const feed = await parser.parseURL(source.url);
    let stored = 0;
    for (const item of (feed.items || [])) {
      const title = item.title || '';
      const summary = (item.contentSnippet || item.content || item.summary || '').slice(0, 500);
      const url = item.link;
      if (!url) continue;
      const ts = item.isoDate ? new Date(item.isoDate).getTime() : Date.now();
      // Skip articles older than 7 days
      if (Date.now() - ts > 7 * 86400000) continue;
      const { score, matched } = scoreArticle(title, summary);
      if (score < MIN_RELEVANCE) continue;
      try {
        S().insert.run(`rss:${source.name}`, title.slice(0, 500), url,
          summary, ts, score, JSON.stringify(matched));
        stored++;
      } catch {}
    }
    return { source: source.name, stored };
  } catch (err) {
    return { source: source.name, error: err.message?.slice(0, 80) };
  }
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    const results = await Promise.allSettled(RSS_SOURCES.map(pollOne));
    const totalStored = results.reduce((a, r) => a + (r.value?.stored || 0), 0);
    const failed = results.filter(r => r.value?.error).length;
    console.log(`[news-rss] ${totalStored} relevant articles stored across ${RSS_SOURCES.length} feeds (${failed} failed)`);
  } finally { _running = false; }
}

export function startRssIngest() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log(`[news-rss] scheduled · ${RSS_SOURCES.length} feeds · poll every 30min · keyword-filtered`);
}
