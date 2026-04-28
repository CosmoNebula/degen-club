let solUsd = 0;
let lastUpdate = 0;

async function tryFetch(url, extract) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();
  const price = parseFloat(extract(data));
  if (!(price > 0)) throw new Error('bad price');
  return price;
}

async function fetchSolUsd() {
  const sources = [
    ['coinbase', 'https://api.coinbase.com/v2/prices/SOL-USD/spot', (d) => d?.data?.amount],
    ['coingecko', 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', (d) => d?.solana?.usd],
  ];
  for (const [name, url, extract] of sources) {
    try {
      const price = await tryFetch(url, extract);
      solUsd = price;
      lastUpdate = Date.now();
      return;
    } catch (err) {
      console.error(`[price] ${name} failed:`, err.message);
    }
  }
}

export function getSolUsd() { return solUsd; }
export function getPriceLastUpdate() { return lastUpdate; }

export function startPriceService() {
  fetchSolUsd();
  setInterval(fetchSolUsd, 30000);
}
