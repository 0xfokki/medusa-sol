// Shared price helper (Solana) used by both the public price proxy and the
// server-authoritative round roller. DexScreener's keyless token endpoint: the
// price of the deepest pool per mint. (The Robinhood build asked Alchemy; Solana
// needs no key for this.)
const NETWORK = 'solana';

// A price is only ever fetched twice per round (birth + death) — but a single
// attempt occasionally fails transiently, so retry a few times in-request
// before giving up; the round-rollover's own 15s reclaim window means the NEXT
// poll naturally retries again if this pass still fails.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const depth = (p) => (p.liquidity?.usd || 0) || (p.marketCap || 0) / 1e6;   // a bonding curve has no liquidity figure

// { [mint]: priceUsd } for every mint DexScreener knows a pool for (30 per call)
export async function fetchPricesByAddress(addresses) {
  const result = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const r = await fetch(`https://api.dexscreener.com/tokens/v1/${NETWORK}/${batch.join(',')}`, { headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error('DexScreener ' + r.status);
        const pairs = await r.json();
        const best = {};
        for (const p of Array.isArray(pairs) ? pairs : []) {
          const a = p.baseToken?.address;
          if (!a || !p.priceUsd || p.chainId !== NETWORK) continue;
          if (!best[a] || depth(p) > depth(best[a])) best[a] = p;
        }
        for (const [a, p] of Object.entries(best)) result[a] = parseFloat(p.priceUsd);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }
    if (lastErr) throw lastErr;
  }
  return result;
}

// symbol and name for a mint, from the same endpoint (used by the admin resolver)
export async function fetchTokenMeta(addresses) {
  const meta = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/${NETWORK}/${batch.join(',')}`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('DexScreener ' + r.status);
    for (const p of (await r.json()) || []) {
      const a = p.baseToken?.address;
      if (!a || p.chainId !== NETWORK) continue;
      if (!meta[a] || depth(p) > meta[a].depth) meta[a] = { symbol: p.baseToken.symbol, name: p.baseToken.name, priced: !!p.priceUsd, depth: depth(p) };
    }
  }
  return meta;
}

export { NETWORK };
