// GET /api/og?w=0x... -> the wallet's 1200x630 card as PNG. This is what the
// /w/:wallet share page points og:image at, so X, Telegram and Discord unfurl
// a personal card. Cached at the edge for 10 minutes; the numbers behind it
// only change when the player reconnects anyway.
import { ADDR_RE, getCardData } from './_lib/card-data.js';
import { renderCardPng } from './_lib/card-render.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const address = (req.query.w || '').toString().trim();
  if (!ADDR_RE.test(address)) {
    res.status(400).json({ error: 'Invalid address' });
    return;
  }
  try {
    const data = await getCardData(address);
    const png = await renderCardPng(data);
    res.setHeader('Content-Type', 'image/png');
    // a card drawn without GMGN (source 'none') is cached for a minute only, so the real one replaces it
    res.setHeader('Cache-Control', data.source === 'none' ? 'public, s-maxage=60' : 'public, s-maxage=600, stale-while-revalidate=86400');
    res.status(200).end(png);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Card render failed' });
  }
}
