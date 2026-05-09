// Twitter ingestor via Nitter mirrors. Free, fragile, but valuable when working.
// Tries multiple mirrors in order until one succeeds. Each mirror exposes
// /<handle>/rss feeds we can parse like RSS.
//
// Curated handles: crypto-twitter pump callers + macro voices that move
// memecoins. If a mirror dies, we'll see it in the failure rate and rotate.

import Parser from 'rss-parser';
import { db } from '../../db/index.js';

const NITTER_MIRRORS = [
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.net',
  'https://nitter.cz',
  'https://nitter.tiekoetter.com',
];

// Curated handles. Tuned for memecoin signal:
//  - elonmusk: moves DOGE/PEPE memes with single tweets
//  - realDonaldTrump: any post about crypto = memecoin pump
//  - VitalikButerin: ETH/L2 narrative
//  - aeyakovenko: Solana founder
//  - mert_helius: Helius CEO, often reposts SOL trends
//  - Top crypto influencers
const HANDLES = [
  'elonmusk',
  'realDonaldTrump',
  'VitalikButerin',
  'aeyakovenko',
  'mert_helius',
  'cobie',
  'CryptoCobain',
  'CryptoBro',
  'Pentosh1',
  'gainzy222',
];

const TICK_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 180 * 1000;
const FETCH_TIMEOUT_MS = 10000;

const parser = new Parser({ timeout: FETCH_TIMEOUT_MS, headers: { 'User-Agent': 'degen-club-news/0.1' } });

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

async function tryMirror(mirror, handle) {
  const url = `${mirror}/${handle}/rss`;
  try {
    const feed = await parser.parseURL(url);
    return { mirror, handle, items: feed.items || [] };
  } catch (err) {
    return null;
  }
}

async function pollHandle(handle) {
  // Try mirrors in order, take first success
  for (const mirror of NITTER_MIRRORS) {
    const result = await tryMirror(mirror, handle);
    if (result) {
      const now = Date.now();
      let stored = 0;
      for (const item of result.items.slice(0, 20)) {
        const title = (item.title || '').slice(0, 500);
        const url = item.link;
        if (!url) continue;
        const ts = item.isoDate ? new Date(item.isoDate).getTime() : now;
        if (now - ts > 7 * 86400000) continue;
        try {
          S().insertItem.run(`twitter:@${handle}`, title, url,
            (item.contentSnippet || '').slice(0, 500),
            ts, 5, JSON.stringify(['twitter', handle]));
          stored++;
        } catch {}
      }
      return { handle, mirror: mirror.replace('https://', ''), stored };
    }
  }
  return { handle, stored: 0, error: 'all mirrors failed' };
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    const results = await Promise.allSettled(HANDLES.map(pollHandle));
    const totalStored = results.reduce((a, r) => a + (r.value?.stored || 0), 0);
    const failed = results.filter(r => r.value?.error).length;
    console.log(`[news-twitter] ${totalStored} tweets stored across ${HANDLES.length} handles (${failed} all-mirror-fail)`);
  } finally { _running = false; }
}

export function startTwitterIngest() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log(`[news-twitter] scheduled · ${HANDLES.length} handles via ${NITTER_MIRRORS.length} nitter mirrors · every 30min`);
}
