// Reddit ingestor — pulls top posts from key memecoin/crypto subreddits.
// Free, no auth, just /r/X/.json. Stores both as news_items (links/posts)
// AND extracts ticker mentions (cashtags + words like SOL, BONK) into
// trend_signals so the agent can see what's getting talked about.

import { db } from '../../db/index.js';

const SUBREDDITS = [
  'CryptoMoonShots',     // memecoin pumps
  'SatoshiStreetBets',   // wallstreetbets-of-crypto
  'solana',              // solana ecosystem
  'CryptoCurrency',      // mainstream crypto
  'Bitcoin',
  'wallstreetbets',      // memes leak from here
];

const TICK_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90 * 1000;
const FETCH_TIMEOUT_MS = 12000;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    insertItem: d.prepare(`INSERT OR IGNORE INTO news_items
       (source, title, url, summary, ts, relevance_score, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertSignal: d.prepare(`INSERT INTO trend_signals
       (source, keyword, score, metadata_json, ts) VALUES (?, ?, ?, ?, ?)`),
  };
  return stmts;
}

// Common English / crypto-talk words that shouldn't be classified as tickers
const TICKER_BLACKLIST = new Set([
  // English
  'THE','AND','FOR','ARE','BUT','NOT','YOU','ALL','HIM','HER','HAS','HAD','WAS','WHO','WHY','HOW','OUR','OUT','ITS','GET','PUT','CAN','WILL','JUST','THIS','THAT','THEY','THEM','SOME','LIKE','MAKE','WANT','WHAT','WHEN','WHERE','THERE','HERE',
  // Internet slang
  'LMAO','LMFAO','OMG','WTF','LOL','IMO','TBH','IDK','FYI','LMK','TLDR','TLDW','IIRC','AFAIK','SMH','RIP','HODL','YOLO','FOMO','FUD','REKT','NGMI','WAGMI','GM','GN','LFG','GMI','POV',
  // Geographic / org abbreviations
  'USA','EU','UK','UN','EU','UAE','USSR','NASA','FBI','CIA','NSA','SEC','IRS','FED','DOJ','DOD','DHS',
  // Tech / crypto-talk that looks like a ticker but isn't
  'CEO','CTO','CFO','COO','DAO','DEX','DEFI','NFT','API','RSS','HTML','URL','HTTP','HTTPS','GMT','UTC','PST','EST','CET','JSON','XML','SQL','HTTP','SSL','TLS','VPN','RPC','SDK','CLI','SaaS','FOSS',
  // Pump-speak (these are descriptors, not tickers)
  'PUMP','DUMP','MOON','RUG','SCAM','SHILL','BAGS','BAG','HODL','APE','APED','LONG','SHORT','BULL','BEAR','BUY','SELL','HOLD','FOMO','FUD','GAINS','LOSS','GAIN','LOSE','PROFIT','RICH','POOR','BROKE','CASH','CALL','CALLS','PUTS','SIZE','SOLD','LOST','CHART','TA','REKT','EXIT','ENTRY',
  // Common nouns
  'NEW','OLD','GOOD','BAD','BIG','TOP','HOT','LOW','HIGH','LAST','NEXT','PAST','SAME','DIFF','TRUE','FALSE','OPEN','CLOSE','MAIN','REAL','FREE','PAID','LIVE','DEAD',
  // Numbers as words / common acronyms
  'AM','PM','NO','OK','YES','NIL','NULL','VOID',
]);

// Ticker extraction — $XYZ cashtags get full credit, ALL-CAPS words must
// pass blacklist + look like tickers (3-6 chars, no vowel-only, etc).
function extractTickers(text) {
  const tickers = new Set();
  if (!text) return tickers;
  // $TICKER or $tICKER — high confidence
  for (const m of text.matchAll(/\$([A-Za-z]{2,8})\b/g)) {
    const t = m[1].toUpperCase();
    if (!TICKER_BLACKLIST.has(t)) tickers.add(t);
  }
  // Standalone 3-6 letter ALL-CAPS — moderate confidence, blacklist heavily
  for (const m of text.matchAll(/\b([A-Z]{3,6})\b/g)) {
    const t = m[1];
    if (TICKER_BLACKLIST.has(t)) continue;
    // Skip if all-vowels or all-consonants (likely not a real ticker)
    if (!/[AEIOU]/.test(t)) continue;
    if (!/[BCDFGHJKLMNPQRSTVWXYZ]/.test(t)) continue;
    tickers.add(t);
  }
  return tickers;
}

async function pollSubreddit(sub) {
  const url = `https://www.reddit.com/r/${sub}/hot.json?limit=25`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(url, { headers: { 'User-Agent': 'degen-club-news/0.1' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { sub, error: `HTTP ${r.status}` };
    const j = await r.json();
    const posts = j?.data?.children || [];
    let storedItems = 0;
    const tickerCounts = new Map();
    const now = Date.now();
    for (const p of posts) {
      const d = p.data;
      if (!d || d.over_18) continue;
      const title = d.title || '';
      const summary = (d.selftext || '').slice(0, 500);
      const url = `https://reddit.com${d.permalink}`;
      const ts = (d.created_utc || 0) * 1000 || now;
      if (now - ts > 7 * 86400000) continue;
      const score = (d.score || 0) + (d.num_comments || 0);
      try {
        S().insertItem.run(`reddit:r/${sub}`, title.slice(0, 500), url,
          summary, ts, Math.min(score / 100, 100), JSON.stringify([]));
        storedItems++;
      } catch {}
      // Extract tickers
      const tickers = extractTickers(title + ' ' + summary);
      for (const tk of tickers) {
        tickerCounts.set(tk, (tickerCounts.get(tk) || 0) + Math.max(1, d.score || 1));
      }
    }
    // Persist top tickers as trend signals
    const sortedTickers = [...tickerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [tk, count] of sortedTickers) {
      try {
        S().insertSignal.run(`reddit:r/${sub}`, tk, count, null, now);
      } catch {}
    }
    return { sub, posts: storedItems, tickers: sortedTickers.length };
  } catch (err) {
    return { sub, error: err.message?.slice(0, 80) };
  }
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    const results = await Promise.allSettled(SUBREDDITS.map(pollSubreddit));
    const totalPosts = results.reduce((a, r) => a + (r.value?.posts || 0), 0);
    const totalTickers = results.reduce((a, r) => a + (r.value?.tickers || 0), 0);
    const failed = results.filter(r => r.value?.error).length;
    console.log(`[news-reddit] ${totalPosts} posts + ${totalTickers} ticker signals across ${SUBREDDITS.length} subs (${failed} failed)`);
  } finally { _running = false; }
}

export function startRedditIngest() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log(`[news-reddit] scheduled · ${SUBREDDITS.length} subs · poll every 30min`);
}
