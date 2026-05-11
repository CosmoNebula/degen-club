// Helius Enhanced API client — pre-parsed transaction data.
//
// Why this exists: the pump.fun firehose only sees swaps on the bonding curve
// program. A creator's sidewallet shenanigans (SOL transfers, swaps on other
// DEXs, NFT moves) are invisible to us through the firehose. Parse Transaction
// History returns enriched, decoded transaction data including native + token
// transfers + DEX swap events, so we can spot creator → fresh-wallet funding
// patterns that precede sidewallet pump-bait launches.
//
// Cost: ~1 credit per call. Per-mint caching in creator_activity_cache keeps
// volume manageable (only fetched at the age=60s snapshot, reused for older ages).

const HISTORY_URL_TEMPLATE = process.env.HELIUS_PARSE_HISTORY_URL_TEMPLATE || null;
const HARD_TIMEOUT_MS = 8000;

// Build the parse-history URL for a given address. Returns null if the template
// env var isn't configured (caller should noop in that case).
function buildHistoryUrl(address, opts = {}) {
  if (!HISTORY_URL_TEMPLATE) return null;
  let url = HISTORY_URL_TEMPLATE.replace('{address}', address);
  const params = [];
  if (opts.limit) params.push(`limit=${opts.limit}`);
  if (opts.type) params.push(`type=${opts.type}`);
  if (opts.before) params.push(`before=${opts.before}`);
  if (opts.until) params.push(`until=${opts.until}`);
  if (params.length > 0) url += '&' + params.join('&');
  return url;
}

// Fetch parsed transaction history for a wallet address. Returns the raw array
// from Helius (each item = { signature, type, nativeTransfers, tokenTransfers,
// events, ... }) or null on error/missing config.
export async function fetchParsedHistory(address, opts = {}) {
  const url = buildHistoryUrl(address, { limit: 100, ...opts });
  if (!url) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HARD_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      console.log(`[parse-history] ${address.slice(0, 8)}… HTTP ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.log(`[parse-history] ${address.slice(0, 8)}… fetch err: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function parseHistoryAvailable() {
  return HISTORY_URL_TEMPLATE != null;
}
