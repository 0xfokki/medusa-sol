// GET /api/read-og?n=1046&q=...&emo=HOPIUM&v=against&head=...&tape=...&t=12:04+UTC
// -> the MEDUSA read as a 1200x630 PNG. Stateless (everything is in the query), so
// it caches hard at the edge. CORS is open because medusa.cash fetches it for
// Download / Copy image.
import { parseRead, renderReadPng } from './_lib/read-render.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const png = await renderReadPng(parseRead(req.query));
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800, max-age=3600');
    res.status(200).end(png);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Render failed' });
  }
}
