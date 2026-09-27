// Admin: turn pasted mints into pool rows. For each mint it asks DexScreener for
// the token's symbol and name (and whether it has a price, since a round can't
// start on a token without one), so the admin only reviews and saves.
import { checkAuth } from '../_lib/auth.js';
import { fetchTokenMeta } from '../_lib/prices.js';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handler(req, res) {
  if (!checkAuth(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const input = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
  const addresses = [...new Set(input.map((a) => (a ?? '').toString().trim()).filter(Boolean))].slice(0, 50);
  const valid = addresses.filter((a) => ADDR_RE.test(a));
  let meta = {};
  try { meta = valid.length ? await fetchTokenMeta(valid) : {}; }
  catch { res.status(502).json({ error: 'DexScreener не ответил' }); return; }

  const results = addresses.map((address) => {
    if (!ADDR_RE.test(address)) return { ok: false, address, error: 'не адрес mint' };
    const m = meta[address];
    const symbol = (m?.symbol || '').trim();
    if (!symbol) return { ok: false, address, error: 'не токен в Solana (DexScreener не знает пула)' };
    if (!m.priced) return { ok: false, address, error: 'нет цены, раунд не запустится' };
    return { ok: true, address, symbol, name: (m.name || symbol).trim(), coin_glyph: symbol.slice(0, 1).toUpperCase() };
  });
  res.status(200).json(results);
}
