// Curated news sources. Each is a free RSS feed. Tuned for memecoin-relevance:
// crypto news + macro/political (Trump, election, sanctions = meme fuel) + tech
// (AI narratives spawn AI-themed memes) + pop culture (celebrities, viral events).
//
// Borrowed structure from the BTC Oracle project but trimmed/retargeted for
// the meme-economy lens — what's TRENDING, what's CULTURALLY ALIVE.

export const RSS_SOURCES = [
  // ── Crypto news ─────────────────────────────────────────
  { name: 'CoinDesk',     url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', cat: 'crypto' },
  { name: 'The Block',    url: 'https://www.theblock.co/rss.xml',                  cat: 'crypto' },
  { name: 'Decrypt',      url: 'https://decrypt.co/feed',                          cat: 'crypto' },
  { name: 'CryptoSlate',  url: 'https://cryptoslate.com/feed/',                    cat: 'crypto' },
  { name: 'CoinTelegraph',url: 'https://cointelegraph.com/rss',                    cat: 'crypto' },
  { name: 'Blockworks',   url: 'https://blockworks.co/feed/',                      cat: 'crypto' },
  { name: 'CryptoPanic Hot', url: 'https://cryptopanic.com/news/rss/?filter=hot',  cat: 'crypto' },

  // ── Macro / political (drives broader market + meme cycles) ────
  // Reuters retired their public RSS feeds. AP requires auth. Replaced with
  // working alternatives.
  { name: 'BBC Business',         url: 'https://feeds.bbci.co.uk/news/business/rss.xml',         cat: 'macro' },
  { name: 'NY Times Business',    url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', cat: 'macro' },
  { name: 'NPR Business',         url: 'https://feeds.npr.org/1006/rss.xml',                     cat: 'macro' },
  { name: 'WSJ Markets',          url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',          cat: 'macro' },
  { name: 'Bloomberg Markets',    url: 'https://feeds.bloomberg.com/markets/news.rss',            cat: 'macro' },
  { name: 'Yahoo Finance',        url: 'https://finance.yahoo.com/news/rssindex',                 cat: 'macro' },
  { name: 'MarketWatch',          url: 'https://feeds.marketwatch.com/marketwatch/topstories',    cat: 'macro' },
  { name: 'Investing.com',        url: 'https://www.investing.com/rss/news.rss',                  cat: 'macro' },
  { name: 'CNBC Top',             url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',   cat: 'macro' },

  // ── Politics (Trump moves crypto, government policy = memes) ───
  { name: 'NPR Politics',     url: 'https://feeds.npr.org/1014/rss.xml',                cat: 'politics' },
  { name: 'BBC US-Politics',  url: 'https://feeds.bbci.co.uk/news/politics/rss.xml',    cat: 'politics' },
  { name: 'NYT Politics',     url: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml', cat: 'politics' },

  // ── Tech / AI (AI memes are huge on pump.fun) ───────────────
  { name: 'TechCrunch',           url: 'https://techcrunch.com/feed/',                      cat: 'tech' },
  { name: 'The Verge',            url: 'https://www.theverge.com/rss/index.xml',            cat: 'tech' },
  { name: 'Ars Technica',         url: 'https://feeds.arstechnica.com/arstechnica/index',   cat: 'tech' },
  { name: 'Hacker News Front',    url: 'https://hnrss.org/frontpage',                       cat: 'tech' },
  { name: 'MIT Tech Review',      url: 'https://www.technologyreview.com/feed/',            cat: 'tech' },

  // ── Pop culture / viral / Internet ─────────────────────────
  { name: 'Mashable',        url: 'https://mashable.com/feeds/rss/all',                   cat: 'culture' },

  // ── World events ───────────────────────────────────────────
  { name: 'BBC World',        url: 'https://feeds.bbci.co.uk/news/world/rss.xml',          cat: 'world' },
  { name: 'NYT World',        url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', cat: 'world' },
  { name: 'Al Jazeera',       url: 'https://www.aljazeera.com/xml/rss/all.xml',            cat: 'world' },
  { name: 'Guardian World',   url: 'https://www.theguardian.com/world/rss',                cat: 'world' },
];

// Article must mention at least one of these to be stored. Tuned for what
// SPAWNS pump.fun memes — political figures (Trump first), crypto, AI,
// celebrities, viral concepts, geopolitics.
export const RELEVANCE_KEYWORDS = [
  // Crypto-specific
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'memecoin', 'memecoins',
  'pump.fun', 'crypto', 'cryptocurrency', 'altcoin', 'altcoins', 'token',
  'binance', 'coinbase', 'kraken', 'pumpfun',
  'etf', 'ico', 'airdrop', 'rugpull', 'defi', 'nft',
  // Political figures (HUGE meme fuel)
  'trump', 'biden', 'kamala', 'harris', 'desantis', 'vance', 'pelosi',
  'putin', 'xi jinping', 'kim jong', 'zelensky', 'netanyahu',
  'maga', 'gop', 'republican', 'democrat', 'election',
  // Tech / AI (AI-themed memes)
  'openai', 'sam altman', 'gpt', 'llm', 'agi', 'anthropic', 'claude',
  'gemini', 'meta ai', 'grok', 'elon musk', 'musk',
  'x.com', 'twitter', 'tesla', 'spacex', 'neuralink', 'doge',
  // Celebrities / viral cultures
  'taylor swift', 'kanye', 'ye', 'drake', 'kendrick', 'kim kardashian',
  'mr beast', 'mrbeast', 'pewdiepie', 'tiktok',
  // Macro
  'fed', 'powell', 'rate cut', 'rate hike', 'inflation', 'recession',
  'unemployment', 'cpi', 'gdp',
  // Geopolitical
  'war', 'sanctions', 'tariff', 'china', 'russia', 'ukraine', 'iran',
  'israel', 'gaza', 'taiwan',
  // Sports / pop events that get tokenized
  'super bowl', 'world cup', 'olympics', 'oscars', 'grammys',
  // Generic meme-spawning words
  'viral', 'meme', 'tiktok', 'youtube', 'streamer', 'twitch',
];

// Compute relevance score: count of keyword matches in title+summary, weighted.
// Returns { score, matched: [keyword, ...] } or { score: 0, matched: [] }.
export function scoreArticle(title, summary) {
  const text = `${title || ''} ${summary || ''}`.toLowerCase();
  const matched = [];
  for (const kw of RELEVANCE_KEYWORDS) {
    if (text.includes(kw)) matched.push(kw);
  }
  // Score: simple count, but multi-word phrases worth more
  let score = 0;
  for (const m of matched) score += m.includes(' ') ? 2 : 1;
  return { score, matched };
}
