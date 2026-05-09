// Trending API ingestor — pulls "what's hot right now" from multiple free
// sources. CoinGecko trending list, DexScreener boosts, GeckoTerminal trending
// pools. All free, all returning ranked lists of currently-trending tokens.

import { db } from '../../db/index.js';

const TICK_INTERVAL_MS = 15 * 60 * 1000;       // 15 min
const FIRST_RUN_DELAY_MS = 120 * 1000;
const FETCH_TIMEOUT_MS = 8000;

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    insertSignal: d.prepare(`INSERT INTO trend_signals
       (source, keyword, score, metadata_json, ts) VALUES (?, ?, ?, ?, ?)`),
  };
  return stmts;
}

function withTimeout(p, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return [ctrl.signal, () => clearTimeout(t)];
}

async function fetchJson(url) {
  const [signal, cleanup] = withTimeout(null, FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'degen-club-news/0.1' }, signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { cleanup(); }
}

async function ingestCoinGeckoTrending() {
  const j = await fetchJson('https://api.coingecko.com/api/v3/search/trending');
  if (!j?.coins) return 0;
  const now = Date.now();
  let stored = 0;
  for (let i = 0; i < j.coins.length; i++) {
    const c = j.coins[i].item;
    if (!c) continue;
    try {
      S().insertSignal.run(
        'coingecko-trending',
        c.symbol?.toUpperCase() || c.name || `rank-${i+1}`,
        Math.max(0, 7 - (c.score || i)),  // score by rank (0-6)
        JSON.stringify({ id: c.id, name: c.name, market_cap_rank: c.market_cap_rank }),
        now);
      stored++;
    } catch {}
  }
  return stored;
}

async function ingestDexScreenerBoosts() {
  const j = await fetchJson('https://api.dexscreener.com/token-boosts/latest/v1');
  if (!Array.isArray(j)) return 0;
  const now = Date.now();
  let stored = 0;
  for (const t of j.slice(0, 20)) {
    if (t.chainId !== 'solana') continue;  // memecoin focus
    try {
      S().insertSignal.run(
        'dexscreener-boosts',
        t.tokenAddress?.slice(0, 16) || '?',
        t.totalAmount || 0,
        JSON.stringify({ chainId: t.chainId, icon: t.icon, description: (t.description || '').slice(0, 200) }),
        now);
      stored++;
    } catch {}
  }
  return stored;
}

async function ingestGeckoTerminalTrending() {
  const j = await fetchJson('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h');
  if (!j?.data) return 0;
  const now = Date.now();
  let stored = 0;
  for (let i = 0; i < Math.min(20, j.data.length); i++) {
    const p = j.data[i];
    const name = p?.attributes?.name || `rank-${i+1}`;
    try {
      S().insertSignal.run(
        'geckoterminal-trending',
        name.slice(0, 40),
        20 - i,
        JSON.stringify({ vol_24h: p?.attributes?.volume_usd?.h24, change_24h: p?.attributes?.price_change_percentage?.h24 }),
        now);
      stored++;
    } catch {}
  }
  return stored;
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    const [cg, dex, gt] = await Promise.all([
      ingestCoinGeckoTrending().catch(() => 0),
      ingestDexScreenerBoosts().catch(() => 0),
      ingestGeckoTerminalTrending().catch(() => 0),
    ]);
    console.log(`[news-trending] coingecko=${cg} dexscreener=${dex} geckoterminal=${gt} signals stored`);
  } finally { _running = false; }
}

export function startTrendingApis() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log('[news-trending] scheduled · CoinGecko + DexScreener + GeckoTerminal · every 15min');
}
