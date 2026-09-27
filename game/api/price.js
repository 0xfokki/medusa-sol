// Public proxy for Alchemy Prices API — keeps ALCHEMY_API_KEY off the client.
// Supports a single ?address= lookup or a batched ?addresses=a,b,c lookup (max 25).
import { fetchPricesByAddress, NETWORK } from './_lib/prices.js';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawList = (req.query.addresses || req.query.address || '').toString();
  const addresses = [...new Set(rawList.split(',').map((a) => a.trim()).filter(Boolean))];
  if (!addresses.length || addresses.some((a) => !ADDR_RE.test(a)) || addresses.length > 25) {
    res.status(400).json({ error: 'Invalid or too many addresses (max 25)' });
    return;
  }

  try {
    const prices = await fetchPricesByAddress(addresses);
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');

    if (req.query.address && !req.query.addresses) {
      const price = prices[addresses[0]];
      if (price === undefined) {
        res.status(404).json({ error: 'Price not found' });
        return;
      }
      res.status(200).json({ address: addresses[0], network: NETWORK, price });
      return;
    }

    const result = {};
    for (const addr of addresses) if (prices[addr] !== undefined) result[addr] = { network: NETWORK, price: prices[addr] };
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Upstream request failed' });
  }
}
