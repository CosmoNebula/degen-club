// Truth Social ingestor — pulls @realDonaldTrump posts via trumpstruth.org's
// public RSS aggregator. The official Truth Social API returns 403 (TLS
// fingerprinting block), but trumpstruth.org has been reliably mirroring his
// posts for years. They re-publish as RSS, free, no auth.
//
// Trump's posts about crypto, the economy, or politics IMMEDIATELY pump
// pump.fun coins — this is high-priority signal.

import Parser from 'rss-parser';
import { db } from '../../db/index.js';

const TRUTH_RSS = 'https://trumpstruth.org/feed';
const TICK_INTERVAL_MS = 30 * 60 * 1000;       // 30 min (trumpstruth.org rate-limits aggressive polls)
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;       // 5 min (let other ingestion settle first)
const FETCH_TIMEOUT_MS = 30000;                 // 30s — trumpstruth.org can be slow under load

// Use a realistic browser User-Agent — trumpstruth.org is more friendly to it
const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  },
});

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    insertItem: d.prepare(`INSERT OR IGNORE INTO news_items
       (source, title, url, summary, ts, relevance_score, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),
  };
  return stmts;
}

async function tick() {
  try {
    const feed = await parser.parseURL(TRUTH_RSS);
    const now = Date.now();
    let stored = 0;
    for (const item of (feed.items || []).slice(0, 30)) {
      const text = (item.contentSnippet || item.content || item.title || '').slice(0, 500);
      if (!text || text === '[No Title] - Post from ' + new Date().toDateString()) continue;
      // Skip empty re-truths (no original content)
      if (text.length < 5) continue;
      const url = item.link || item.guid;
      if (!url) continue;
      const ts = item.isoDate ? new Date(item.isoDate).getTime() : now;
      if (now - ts > 7 * 86400000) continue;
      try {
        S().insertItem.run('truth-social:trump', text, url, text, ts, 8,
          JSON.stringify(['trump', 'truth-social']));
        stored++;
      } catch {}
    }
    if (stored > 0) console.log(`[news-truth] ${stored} new Trump posts ingested via trumpstruth.org`);
  } catch (err) {
    console.log(`[news-truth] fetch failed: ${err.message?.slice(0, 100)}`);
  }
}

export function startTruthSocialIngest() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log('[news-truth] scheduled · @realDonaldTrump via trumpstruth.org · every 15min');
}
