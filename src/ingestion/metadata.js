import { config } from '../config.js';

function candidates(uri) {
  if (!uri) return [];
  if (uri.startsWith('ipfs://')) {
    const hash = uri.slice(7);
    return config.ipfs.gateways.map(g => g + hash);
  }
  const ipfsIdx = uri.indexOf('/ipfs/');
  if (ipfsIdx >= 0) {
    const hash = uri.slice(ipfsIdx + 6);
    return [uri, ...config.ipfs.gateways.map(g => g + hash)];
  }
  return [uri];
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'degen-club/0.1' } });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchMetadata(uri) {
  const urls = candidates(uri);
  if (!urls.length) return null;
  for (const url of urls) {
    try {
      const data = await fetchWithTimeout(url, config.ipfs.timeoutMs);
      return {
        description: data.description || null,
        image_uri: data.image || data.image_url || null,
        twitter: data.twitter || null,
        telegram: data.telegram || null,
        website: data.website || null,
      };
    } catch { /* try next */ }
  }
  return null;
}
